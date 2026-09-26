/**
 * Saved flows: the steps `scenescout check` replays, as data.
 *
 * A flow is a short script a person or an agent wrote down once because it
 * matters that it keeps working: open a page, click a control, see a result.
 * The check replays every flow in `.scenescout/flows/*.json` after its crawl,
 * with no model, so a flow that passed yesterday and breaks today fails the
 * gate naming the flow and the step (ADR 12).
 *
 * The steps are `scout_run_plan`'s steps, so a plan that worked in an
 * exploratory run can be saved as it is, plus three assertions a plan has no
 * need for: text is visible, the URL matches, a request answered with a status.
 *
 * Everything here is pure: the schema and its error messages, the target
 * grammar, and the rules that decide whether a URL or a request matched. The
 * browser half is BrowserEngine.replayFlow, which only acts and reports.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import { beaconResourceType, BROWSER_ENGINES } from "../browsers.js";
import type { RouteHealth } from "./check.js";
import { MEMORY_DIRNAME, SELF_IGNORE_KEEP } from "./memory.js";

/** Most steps one flow may hold. A longer flow is several flows, and each would fail more usefully on its own. */
export const MAX_FLOW_STEPS = 50;
/** Most flows one check replays. */
export const MAX_FLOWS = 50;
/** How long a step waits for its target, text, URL or request before it counts as broken. */
export const FLOW_STEP_TIMEOUT_MS = 5000;
/**
 * How long a flow waits after its last step for a write that step set off
 * late (a save on a timer, a debounced autosave), before it counts as passed.
 */
export const FLOW_AFTER_LAST_STEP_MS = 750;
/** Where a project keeps its flows, relative to the project directory. */
export const FLOWS_SUBDIR = path.join(MEMORY_DIRNAME, SELF_IGNORE_KEEP);

/** How a step names the control it acts on. The same grammar as scout_run_plan's targets, plus role. */
export type FlowTarget =
  { by: "testid"; value: string } | { by: "text"; value: string } | { by: "label"; value: string } | { by: "role"; role: string; name?: string };

export const TARGET_HELP = 'testid=…, text=…, label=… or role=<role>[name="…"]';

/**
 * The ARIA roles a `role=` target may name (WAI-ARIA 1.2, as Playwright's
 * getByRole accepts them). A misspelt role matches nothing, so a flow using
 * one would only ever fail at replay; it is refused when the file is read.
 */
export const ARIA_ROLE_LIST = [
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
] as const;
export const ARIA_ROLES: ReadonlySet<string> = new Set(ARIA_ROLE_LIST);

/*
 * Held equal to Playwright's own role type at compile time, both ways: a role
 * listed here that getByRole does not accept, or one it accepts that is
 * missing here, fails the build (tsc), not a user's flow.
 */
type PlaywrightRole = Parameters<Page["getByRole"]>[0];
type Unlisted = Exclude<PlaywrightRole, (typeof ARIA_ROLE_LIST)[number]>;
export const ARIA_ROLES_MATCH_PLAYWRIGHT: [Unlisted] extends [never] ? readonly PlaywrightRole[] : Unlisted = ARIA_ROLE_LIST;

/** Parse a target string, or null when it is not one. */
export function parseTarget(target: string): FlowTarget | null {
  for (const by of ["testid", "text", "label"] as const) {
    if (target.startsWith(`${by}=`)) {
      const value = target.slice(by.length + 1);
      return value ? { by, value } : null;
    }
  }
  const role = /^role=([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]"']*))\])?$/i.exec(target);
  if (!role) return null;
  const name = role[2] ?? role[3] ?? role[4];
  return name === undefined ? { by: "role", role: role[1].toLowerCase() } : { by: "role", role: role[1].toLowerCase(), name };
}

const REQUEST_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD) (\/\S*)$/;

function isRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const target = z
  .string()
  .refine((t) => parseTarget(t) !== null, { message: `must be ${TARGET_HELP}` })
  .superRefine((t, ctx) => {
    const parsed = parseTarget(t);
    if (parsed?.by === "role" && !ARIA_ROLES.has(parsed.role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `names the role "${parsed.role}", which is not an ARIA role (e.g. button, link, textbox, checkbox, tab)`,
      });
    }
  });

const STEP_SCHEMAS = [
  z.object({ action: z.literal("navigate"), target: z.string().regex(/^\//, "must be a path on the app, starting with /") }).strict(),
  z.object({ action: z.literal("click"), target }).strict(),
  z.object({ action: z.literal("type"), target, value: z.string(), pressEnter: z.boolean().optional(), replace: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("select"), target, value: z.string() }).strict(),
  z.object({ action: z.literal("press"), value: z.string().min(1, "names the key to press, e.g. Enter") }).strict(),
  z.object({ action: z.literal("expect-text"), text: z.string().min(1, "is the text that must be visible") }).strict(),
  z.object({ action: z.literal("expect-url"), pattern: z.string().min(1).refine(isRegex, { message: "is not a valid regular expression" }) }).strict(),
  z
    .object({
      action: z.literal("expect-request"),
      request: z.string().regex(REQUEST_RE, 'must be a method and a path, e.g. "GET /api/things"'),
      status: z.union([z.number().int().min(100).max(599), z.string().regex(/^[1-5]xx$/, 'must be a status such as 200, or a class such as "2xx"')]),
    })
    .strict(),
] as const;

const stepSchema = z.discriminatedUnion("action", [...STEP_SCHEMAS]);

export type FlowStep = z.infer<typeof stepSchema>;
export const FLOW_ACTIONS = STEP_SCHEMAS.map((s) => s.shape.action.value);

const flowSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    steps: z.array(stepSchema).min(1, "needs at least one step").max(MAX_FLOW_STEPS, `holds at most ${MAX_FLOW_STEPS} steps`),
  })
  .strict()
  .superRefine((flow, ctx) => {
    // A flow starts from a page it names, never from wherever the crawl left the browser.
    if (flow.steps[0] && flow.steps[0].action !== "navigate") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", 0, "action"], message: 'must be "navigate": a flow starts from a page it names' });
    }
  });

export interface Flow {
  name: string;
  /** The file it was read from, relative to the flows directory. */
  file: string;
  steps: FlowStep[];
}

/** `steps[2].target`, the way a person would look for it in the file. */
function fieldPath(p: ReadonlyArray<string | number>): string {
  if (p.length === 0) return "(the whole file)";
  return p.map((part, i) => (typeof part === "number" ? `[${part}]` : i === 0 ? part : `.${part}`)).join("");
}

function issueMessage(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys") return `unknown field(s) ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
  if (issue.code === "invalid_union_discriminator") return `must be one of ${FLOW_ACTIONS.join(", ")}`;
  if (issue.code === "invalid_type" && issue.received === "undefined") return "is required";
  return issue.message;
}

/** Validate one flow file's text. Every mistake names the file and the field. */
export function parseFlow(text: string, file: string): { ok: true; flow: Flow } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = flowSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${fieldPath(i.path)} ${issueMessage(i)}`);
    const more = parsed.error.issues.length > 5 ? ` (and ${parsed.error.issues.length - 5} more)` : "";
    return { ok: false, error: `${file}: ${issues.join("; ")}${more}` };
  }
  return { ok: true, flow: { name: parsed.data.name ?? file.replace(/\.json$/i, ""), file, steps: parsed.data.steps } };
}

/** An entry of the flows directory that was not replayed, and why. */
export interface SkippedFlowFile {
  file: string;
  reason: string;
}

/**
 * Read every `*.json` in a flows directory, in name order. Throws on the first
 * file that is not a valid flow: a flow that cannot be read would otherwise
 * pass by never running. Everything else in the directory is returned as
 * skipped with its reason, so nothing there is left out without saying so. A
 * symbolic link is followed when it resolves to a file inside the directory,
 * and skipped when it resolves anywhere else.
 */
export function loadFlows(dir: string): { flows: Flow[]; skipped: SkippedFlowFile[] } {
  const realDir = fs.realpathSync(dir);
  const files: string[] = [];
  const skipped: SkippedFlowFile[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    if (e.isDirectory()) {
      skipped.push({ file: e.name, reason: "a directory: flows are not read from subdirectories" });
      continue;
    }
    if (!e.name.toLowerCase().endsWith(".json")) {
      skipped.push({ file: e.name, reason: "not a .json file" });
      continue;
    }
    if (e.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(path.join(dir, e.name));
      } catch {
        skipped.push({ file: e.name, reason: "a symbolic link to nothing" });
        continue;
      }
      if (!target.startsWith(realDir + path.sep)) {
        skipped.push({ file: e.name, reason: "a symbolic link to a file outside the flows directory" });
        continue;
      }
      if (!fs.statSync(target).isFile()) {
        skipped.push({ file: e.name, reason: "a symbolic link to something that is not a file" });
        continue;
      }
    } else if (!e.isFile()) {
      skipped.push({ file: e.name, reason: "not a regular file" });
      continue;
    }
    files.push(e.name);
  }
  if (files.length > MAX_FLOWS) throw new Error(`${dir} holds ${files.length} flows; a check replays at most ${MAX_FLOWS}`);
  const flows = files.map((file) => {
    const parsed = parseFlow(fs.readFileSync(path.join(dir, file), "utf8"), file);
    if (!parsed.ok) throw new Error(`flow ${parsed.error}`);
    return parsed.flow;
  });
  return { flows, skipped };
}

/**
 * Which flows directory a check uses: the one named, none for "off", and
 * otherwise the project's own when it exists. A directory that was named and
 * is missing is an error, never a quiet check with no flows.
 */
export function resolveFlowsDir(flag: string | undefined, projectDir: string, exists: (p: string) => boolean): { dir: string | null } | { error: string } {
  if (flag === "off") return { dir: null };
  if (flag !== undefined) return exists(flag) ? { dir: flag } : { error: `--flows: no directory at ${flag}` };
  const own = path.join(projectDir, FLOWS_SUBDIR);
  return { dir: exists(own) ? own : null };
}

/** A step as the report names it. */
export function describeStep(step: FlowStep): string {
  switch (step.action) {
    case "navigate":
    case "click":
    case "select":
      return `${step.action} ${step.target}`;
    case "type":
      return `type into ${step.target}${step.pressEnter ? " and press Enter" : ""}`;
    case "press":
      return `press ${step.value}`;
    case "expect-text":
      return `expect text ${JSON.stringify(step.text)}`;
    case "expect-url":
      return `expect the URL to match /${step.pattern}/`;
    case "expect-request":
      return `expect ${step.request} → ${step.status}`;
  }
}

/** Whether a step acts on the page (and so opens a new window for expect-request) rather than reading it. */
export function isAction(step: FlowStep): boolean {
  return !step.action.startsWith("expect-");
}

/** Path, query and hash: what an expect-url pattern is tested against, so the same flow passes on a laptop and a preview deployment. */
export function urlMatches(pattern: string, url: string): boolean {
  let tail: string;
  try {
    const u = new URL(url);
    tail = `${u.pathname}${u.search}${u.hash}`;
  } catch {
    tail = url;
  }
  return new RegExp(pattern).test(tail);
}

/** A path pattern against a request's path: equal segment for segment, where `*` stands for any one segment. A trailing slash is ignored. */
export function requestPathMatches(pattern: string, pathname: string): boolean {
  const split = (p: string) => p.replace(/\/+$/, "").split("/");
  const want = split(pattern);
  const got = split(pathname);
  return want.length === got.length && want.every((seg, i) => seg === "*" || seg === got[i]);
}

export function statusMatches(expected: number | string, status: number): boolean {
  return typeof expected === "number" ? status === expected : String(status)[0] === expected[0];
}

/** A response the page received while a flow ran. */
export interface SeenRequest {
  method: string;
  url: string;
  status: number;
}

/**
 * Whether the requests seen since the last action include the one a step
 * expects. The reason says what was seen instead, which is what a person
 * fixing it needs: the right request with the wrong status, or none at all.
 */
export function matchRequest(expect: { request: string; status: number | string }, seen: readonly SeenRequest[]): { ok: true } | { ok: false; reason: string } {
  const [, method, pattern] = REQUEST_RE.exec(expect.request) ?? [];
  const same = seen.filter((r) => {
    if (r.method.toUpperCase() !== method) return false;
    try {
      return requestPathMatches(pattern, new URL(r.url).pathname);
    } catch {
      return false;
    }
  });
  if (same.some((r) => statusMatches(expect.status, r.status))) return { ok: true };
  if (same.length > 0) {
    const statuses = [...new Set(same.map((r) => r.status))].join(", ");
    return { ok: false, reason: `${expect.request} answered ${statuses}, expected ${expect.status}` };
  }
  return { ok: false, reason: `no ${expect.request} request was sent since the last action` };
}

/** How a replay ended. Steps are numbered from 1, as the report names them. */
export type FlowOutcome =
  | { status: "passed" }
  /** A step could not be done, or what it expected was not there: the app's behaviour changed. */
  | { status: "failed"; step: number; did: string; reason: string; path: string }
  /** The check's write policy refused what a step did: the flow asks for something a check will not do. */
  | { status: "refused"; step: number; did: string; reason: string; path: string };

/** What the engine hands back for one flow. */
export interface FlowReplay {
  outcome: FlowOutcome;
  /** Oracle violations while the flow ran, with the page each was seen on. */
  violations: Array<{ path: string; violation: RouteHealth["violations"][number] }>;
  /**
   * Background requests the flow's rule refused while it ran: those a page
   * sends with navigator.sendBeacon or an <a ping>, to any origin. Refused
   * like any other, and listed, but not charged to a step: a page sends them
   * on its own schedule, and charging them made a flow's result depend on
   * when a timer fired.
   */
  refusedBackground: string[];
  /** WebSocket connections the flow's page opened. The write rule covers HTTP only; frames on a socket are not inspected. */
  websockets: string[];
}

/**
 * The request kinds a refused write may be excused from a step for: what
 * navigator.sendBeacon and <a ping> send, under every engine's name for it
 * (browsers.ts `beaconResourceType`). They are fire-and-forget by design, a
 * page sends them on its own schedule, and no step waits for one.
 */
export const BACKGROUND_REQUEST_TYPES: ReadonlySet<string> = new Set(["ping", ...BROWSER_ENGINES.map(beaconResourceType)]);

/**
 * Split what the write policy refused during a step into what the step is
 * charged with and background requests, which are only listed. The rule is
 * the request's kind, never its origin: an app's API is often on another port
 * or subdomain, and deciding by origin either hid a step's own write or
 * blamed one on the app. So a fetch, an XHR or a form post is charged to the
 * step wherever it goes, telemetry sent with fetch included; only a beacon or
 * a ping is excused. A refusal with no kind recorded is charged. The app's
 * origin is dropped from what is charged, for a shorter reason.
 */
export function splitRefusals(refusals: ReadonlyArray<{ sig: string; type?: string }>, appOrigin: string): { charged: string[]; background: string[] } {
  const charged: string[] = [];
  const background: string[] = [];
  for (const { sig, type } of refusals) {
    if (type !== undefined && BACKGROUND_REQUEST_TYPES.has(type)) background.push(sig);
    else charged.push(sig.split(appOrigin).join(""));
  }
  return { charged, background };
}

export interface FlowRun extends FlowReplay {
  name: string;
  file: string;
  steps: number;
}

/** The step a run stopped at, as the evidence of its issue or the reason the check could not run. */
export function flowStepEvidence(run: FlowRun): string {
  if (run.outcome.status === "passed") return "";
  return `flow "${run.name}" (${run.file}) step ${run.outcome.step} of ${run.steps}, ${run.outcome.did}: ${run.outcome.reason}`;
}
