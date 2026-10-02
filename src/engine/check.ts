/**
 * `scenescout check`: the deterministic sweep, as data.
 *
 * The engine visits every route it knows and hands back what it measured on
 * each one (RouteHealth). Everything here turns those measurements into
 * issues, decides whether they fail the gate, and writes them out as a report,
 * SARIF and a JSON summary. No model is involved at any step, so the same app
 * gives the same result, which is what a pull-request gate needs.
 *
 * It lives apart from browser.ts so every rule is table-tested
 * (scripts/check-test.ts) without launching a browser.
 */
import { createHash } from "node:crypto";
import { BROWSER_ENGINES, type BrowserEngineName } from "../browsers.js";
import {
  BASELINE_MODES,
  baselineEvidence,
  baselineFingerprint,
  countStatuses,
  describeChange,
  parseThreshold,
  VISUAL_RULE,
  type BaselineMode,
  type BaselineResult,
  type BaselineRun,
} from "./baseline.js";
import type { DesignDefect } from "./design.js";
import { flowStepEvidence, type FlowRun, type SkippedFlowFile } from "./flow.js";
import { parseLimitFlag } from "./limits.js";
import { redactRoute, redactSecrets } from "./memory.js";
import { httpErrorDetail, httpStatusOf, type OracleViolation } from "./oracles.js";
import type { CheckRetest } from "./verify.js";

export const CHECK_SEVERITIES = ["high", "medium", "low"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];
export const FAIL_ON = [...CHECK_SEVERITIES, "never"] as const;
export type FailOn = (typeof FAIL_ON)[number];

/** What the engine measured on one route. */
export interface RouteHealth {
  /** The path the check asked for. */
  path: string;
  /** Where the browser ended up. */
  url: string;
  /** The document's HTTP status; null when the page never loaded. */
  status: number | null;
  loadError?: string;
  /** Sent to a sign-in page: auth missing or expired. */
  loginRedirect: boolean;
  /** Interactable controls on the page. */
  elements: number;
  /** Controls with no accessible name, described by role and test id. */
  unnamed: string[];
  /** Fields whose only label is their placeholder, described like `unnamed` plus the placeholder text. */
  placeholderOnly: string[];
  violations: Array<Pick<OracleViolation, "kind" | "severity" | "detail" | "url" | "embed">>;
  /** GEOMETRY lines from the snapshot's layout checks, overlay probe included. */
  geometry: string[];
  brokenImages: string[];
  design: DesignDefect[];
  /** Why the design audit could not measure this page, when it could not. */
  auditError?: string;
}

export const CHECK_RULES = {
  "route-load-failed": { severity: "high", title: "Page did not load", help: "Navigating to the route failed or timed out." },
  "route-server-error": { severity: "high", title: "Page answered with a server error", help: "The document itself returned HTTP 5xx." },
  "route-client-error": { severity: "medium", title: "Page answered with a client error", help: "The document itself returned HTTP 4xx." },
  "page-error": { severity: "high", title: "Uncaught exception", help: "The page raised an error nothing caught." },
  "server-error": { severity: "high", title: "Request failed with a server error", help: "A request the page made returned HTTP 5xx." },
  "client-error": { severity: "medium", title: "Request failed with a client error", help: "A request the page made returned HTTP 4xx." },
  "request-failed": { severity: "medium", title: "Request did not complete", help: "A request the page made failed at the network level." },
  "console-error": {
    severity: "medium",
    title: "Console error",
    help: "The page logged an error. Its cause usually shows as its own request or page error, which is why this one does not fail the default gate.",
  },
  "refused-empty": {
    severity: "high",
    title: "Failed request shown as an empty result",
    help: "A request was refused and the page drew an empty state instead of an error.",
  },
  "false-success": { severity: "high", title: "Success shown for a failed request", help: "The page reported success while the server refused the request." },
  "dom-injection": { severity: "high", title: "Markup rendered as an element", help: "Text the engine typed came back as live markup." },
  "postmessage-token": {
    severity: "high",
    title: "Credential posted to any origin",
    help: 'The page called postMessage with targetOrigin "*" and a token-shaped value in the message, so whatever origin the receiving window holds can read it. The value is never reported: its path in the message, its shape and its first four characters are.',
  },
  "auth-redirect": { severity: "medium", title: "Sent to sign-in", help: "The route redirected to a sign-in page; the session is missing or expired." },
  "dead-end": { severity: "medium", title: "Dead end", help: "The page has no controls at all: no navigation and no way back." },
  "blocking-overlay": {
    severity: "high",
    title: "Page blocked by an overlay",
    help: "A backdrop with no dialog, an empty dialog or a leaked scroll lock leaves the user unable to use the page.",
  },
  "dialog-layout": {
    severity: "medium",
    title: "Dialog badly placed",
    help: "An open dialog is far off-centre or runs below the viewport with no scroll of its own; its lower controls may be out of reach.",
  },
  "layout-issue": {
    severity: "low",
    title: "Layout issue",
    help: "A layout check reported something this version of the check has no specific rule for. It is listed rather than dropped.",
  },
  "covered-control": {
    severity: "medium",
    title: "Control covered by pinned chrome",
    help: "A fixed or sticky element sits on top of the control, so clicks land on it instead.",
  },
  "clipped-control": { severity: "medium", title: "Control unreachable", help: "The control is clipped inside a container that cannot scroll." },
  "offpage-control": { severity: "medium", title: "Control outside the page", help: "The control is laid out where no scrolling can reach it." },
  "overlapping-controls": { severity: "low", title: "Controls overlap", help: "Two controls in the same layer cover most of each other." },
  "broken-image": { severity: "medium", title: "Broken image", help: "The browser could not render the image." },
  "unnamed-control": { severity: "medium", title: "Control with no accessible name", help: "Assistive technology announces the control without a name." },
  "placeholder-only-label": {
    severity: "medium",
    title: "Field labelled only by its placeholder",
    help: "The field has no label, aria-label, aria-labelledby or title. Its placeholder is not a label: it disappears as soon as the user types, and some assistive technology does not announce it.",
  },
  contrast: { severity: "low", title: "Text contrast below WCAG", help: "Text needs 4.5:1 (3:1 when large) against its background." },
  "focus-indicator": { severity: "low", title: "No visible focus indicator", help: "Tabbing to the control changes nothing on screen." },
  "horizontal-scroll": { severity: "medium", title: "Page scrolls sideways", help: "Content is wider than the viewport." },
  "tiny-target": { severity: "low", title: "Small click target", help: "Below the 24px WCAG 2.2 target-size minimum." },
  "clipped-text": { severity: "low", title: "Text clipped", help: "Text is wider than its box and cut off without an ellipsis." },
  "image-aspect": { severity: "low", title: "Image distorted", help: "The rendered box does not match the image's proportions." },
  "flow-step-failed": {
    severity: "high",
    title: "Saved flow broke",
    help: "A step of a flow saved in .scenescout/flows could not be done, or what it expected was not there. The evidence names the flow, the step and what happened instead.",
  },
  [VISUAL_RULE]: {
    severity: "high",
    title: "Differs from its visual baseline",
    help: "A page or element listed in the baselines' targets.json no longer looks like its baseline (--baseline compare): more of its pixels changed than --baseline-threshold allows, or its size changed. It is also filed when the page or element could not be captured at all, or its baseline cannot be used (half there, unreadable, or taken with other settings). An intended change is approved by running the check with --baseline update (and committing the new baseline, where the project keeps baselines in a folder it commits).",
  },
} as const satisfies Record<string, { severity: CheckSeverity; title: string; help: string }>;

/**
 * Rules whose measurement is exact and whose meaning depends on a convention
 * of the project the check cannot see. SceneScout is used against any app, so
 * it does not decide those conventions: these are listed as "worth a look",
 * each naming the convention that would make it a defect, and never counted,
 * given a severity or gated on, at any --fail-on. SARIF reports them at level
 * "note". `convention` finishes the sentence "a defect only if your project
 * uses …". --ignore takes them like any other rule.
 */
export const WORTH_A_LOOK_RULES = {
  "off-grid-spacing": {
    title: "Spacing off a 4px grid",
    help: "More than a fifth of the page's paddings or vertical margins are not multiples of 4px. That matters where a project keeps a 4px spacing scale, and not where it uses another scale or none.",
    convention: "a 4px spacing scale",
  },
  "indistinct-link": {
    title: "Link styled like body text",
    help: "Links with no underline, in the same colour as the page's body text. In running text a reader cannot tell them from the text around them; in navigation this styling is common, and the check cannot tell the two apart.",
    convention: "a visible link style (an underline or a distinct colour) wherever links appear, navigation included",
  },
} as const satisfies Record<string, { title: string; help: string; convention: string }>;

export type DefectRule = keyof typeof CHECK_RULES;
export type WorthALookRule = keyof typeof WORTH_A_LOOK_RULES;
export type CheckRule = DefectRule | WorthALookRule;
export const CHECK_RULE_IDS = [...Object.keys(CHECK_RULES), ...Object.keys(WORTH_A_LOOK_RULES)] as CheckRule[];

export function isWorthALookRule(rule: string): rule is WorthALookRule {
  return Object.prototype.hasOwnProperty.call(WORTH_A_LOOK_RULES, rule);
}

/** An observation in the "worth a look" tier: no severity, never in the gate, and the convention that would decide it. */
export interface CheckObservation {
  rule: WorthALookRule;
  evidence: string;
  routes: string[];
  /** Finishes "a defect only if your project uses …". */
  convention: string;
  fingerprint: string;
}

export interface CheckIssue {
  rule: DefectRule;
  severity: CheckSeverity;
  /**
   * The fact, stable across runs: no snapshot refs, no ports. What dedup and
   * fingerprints key on, except for an unmet visual baseline, whose evidence
   * carries this run's share of changed pixels and whose fingerprint is the
   * target's (checkFindings).
   */
  evidence: string;
  /** Every route it was seen on, first first. */
  routes: string[];
  /** Another site's frame, when the failure was that embed's. */
  embed?: string;
  fingerprint: string;
}

export const SEVERITY_RANK: Record<CheckSeverity, number> = { high: 0, medium: 1, low: 2 };

/** The route a defect of the app's shared shell is charged to: one fix, however many pages show it. */
export const SHARED_CHROME_ROUTE = "(shared chrome)";

/** Snapshot refs (`e12`) are numbered per run; evidence carrying them would never match itself twice. */
function stripRefs(line: string): string {
  return line.replace(/\be\d+\s+/g, "").trim();
}

/** Origins differ between a laptop, a CI runner and a preview deployment; the path is the fact. */
function withoutOrigin(text: string, origin: string): string {
  return origin ? text.split(origin).join("") : text;
}

function violationRule(v: RouteHealth["violations"][number]): CheckRule {
  switch (v.kind) {
    case "page_error":
      return "page-error";
    case "console_error":
      return "console-error";
    case "request_failed":
      return "request-failed";
    case "dom_injection":
      return "dom-injection";
    case "refused_empty":
      return "refused-empty";
    case "false_success":
      return "false-success";
    case "postmessage_token":
      return "postmessage-token";
    case "http_error": {
      const status = httpStatusOf(v.detail);
      // An http_error whose status cannot be read is still an error the page hit: the worse reading, not the milder one.
      return status === null || status >= 500 ? "server-error" : "client-error";
    }
  }
}

/**
 * Which rule a GEOMETRY line belongs to; null only for the "…and N more"
 * tails, which repeat a count rather than state a fact. A line no rule knows
 * is kept as a low `layout-issue`, never dropped: check-test builds its inputs
 * from the real geometry and overlay code, so a reworded line shows up there first.
 */
export function geometryRule(line: string): CheckRule | null {
  if (/^…and \d+ more/.test(line)) return null;
  if (/^OVERLAY:/.test(line)) {
    // Only the certain cases block the page: a leaked scroll lock, a backdrop with no dialog,
    // an empty dialog ("open dialog …"). A badly placed dialog ("dialog …") may still be usable.
    return /^OVERLAY: (page scrolling is DISABLED|page is covered by a modal backdrop|open dialog )/.test(line) ? "blocking-overlay" : "dialog-layout";
  }
  if (/ is COVERED by pinned chrome /.test(line)) return "covered-control";
  if (/ is UNREACHABLE /.test(line)) return "clipped-control";
  if (/ is rendered outside the reachable page area/.test(line)) return "offpage-control";
  if (/ overlaps /.test(line)) return "overlapping-controls";
  return "layout-issue";
}

/**
 * Turn per-route measurements into issues, one per distinct fact. The same
 * failing request on ten pages is one issue seen on ten routes: the shared
 * shell's defects would otherwise bury the one page that is actually broken.
 *
 * Saved flows add two kinds: the step a flow broke at, and anything the
 * oracles caught while it ran. The second kind goes through the same rules as
 * a crawled page's, so a request that fails on load and again inside a flow is
 * one issue, not two.
 *
 * A fact under a worth-a-look rule goes to `worthALook` instead, deduplicated
 * the same way; the two lists never share an entry.
 *
 * Visual baselines add one issue per target that is not met (baseline.ts
 * decides which). Each target is its own fact already, so these skip the
 * dedup, and their fingerprint comes from the target, not the evidence: the
 * evidence carries this run's percentage, and the same target changing by a
 * different amount is still the same alert.
 */
export function checkFindings(
  routes: readonly RouteHealth[],
  origin: string,
  ignore: readonly CheckRule[] = [],
  flows: readonly FlowRun[] = [],
  baselines: BaselineRun | null = null,
): { issues: CheckIssue[]; worthALook: CheckObservation[] } {
  const byKey = new Map<string, CheckIssue>();
  const looks = new Map<string, CheckObservation>();
  /** Evidence as it is written: no origin, no secret, and bounded. */
  const cleanEvidence = (evidence: string): string => redactSecrets(withoutOrigin(evidence, origin)).slice(0, 300);
  const add = (rule: CheckRule, evidence: string, route: string, opts: { severity?: CheckSeverity; embed?: string } = {}): void => {
    if (ignore.includes(rule)) return;
    const clean = cleanEvidence(evidence);
    const key = `${rule}\u0000${clean}`;
    const found = byKey.get(key) ?? looks.get(key);
    if (found) {
      if (!found.routes.includes(route)) found.routes.push(route);
      return;
    }
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 32);
    if (isWorthALookRule(rule)) {
      looks.set(key, { rule, evidence: clean, routes: [route], convention: WORTH_A_LOOK_RULES[rule].convention, fingerprint });
      return;
    }
    byKey.set(key, {
      rule,
      severity: opts.embed ? "medium" : (opts.severity ?? CHECK_RULES[rule].severity),
      evidence: clean,
      routes: [route],
      ...(opts.embed ? { embed: opts.embed } : {}),
      fingerprint,
    });
  };
  for (const r of routes) {
    const route = r.path;
    if (r.loadError !== undefined) {
      add("route-load-failed", `${route}: ${r.loadError}`, route);
      continue;
    }
    if (r.status !== null && r.status >= 500) add("route-server-error", `${route} → HTTP ${r.status}`, route);
    else if (r.status !== null && r.status >= 400) add("route-client-error", `${route} → HTTP ${r.status}`, route);
    if (r.loginRedirect) add("auth-redirect", `${route} → ${withoutOrigin(r.url, origin) || "/"}`, route);
    else if (r.elements === 0 && (r.status === null || r.status < 400)) add("dead-end", `${route}: 0 controls`, route);
    for (const v of r.violations) add(violationRule(v), v.detail, route, { embed: v.embed });
    for (const line of r.geometry) {
      const rule = geometryRule(line);
      if (rule) add(rule, stripRefs(line), route);
    }
    for (const line of r.brokenImages) if (!/^…and \d+ more/.test(line)) add("broken-image", stripRefs(line), route);
    for (const u of r.unnamed) add("unnamed-control", u, route);
    for (const p of r.placeholderOnly) add("placeholder-only-label", p, route);
    for (const d of r.design) add(d.rule, d.detail, d.chrome ? SHARED_CHROME_ROUTE : route);
  }
  for (const f of flows) {
    for (const { path, violation } of f.violations) add(violationRule(violation), violation.detail, path, { embed: violation.embed });
    // A refused step is not the app's defect: the check reports it as "could not run" (refusedFlowReason).
    if (f.outcome.status === "failed") add("flow-step-failed", flowStepEvidence(f), f.outcome.path);
  }
  const visual: CheckIssue[] = [];
  if (baselines && !ignore.includes(VISUAL_RULE)) {
    for (const r of baselines.results) {
      const evidence = baselineEvidence(r, baselines);
      if (evidence === null) continue;
      visual.push({
        rule: VISUAL_RULE,
        severity: CHECK_RULES[VISUAL_RULE].severity,
        evidence: cleanEvidence(evidence),
        routes: [r.path],
        fingerprint: baselineFingerprint(baselines.engine, r),
      });
    }
  }
  return {
    issues: [...byKey.values(), ...visual].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rule.localeCompare(b.rule)),
    worthALook: [...looks.values()].sort((a, b) => a.rule.localeCompare(b.rule)),
  };
}

/** The defect tier of `checkFindings`: what counts, and what the gate reads. */
export function issuesFromRoutes(
  routes: readonly RouteHealth[],
  origin: string,
  ignore: readonly CheckRule[] = [],
  flows: readonly FlowRun[] = [],
): CheckIssue[] {
  return checkFindings(routes, origin, ignore, flows).issues;
}

/**
 * Why a check has nothing to give a verdict on, or null when it measured the
 * app. Neither case is a pass: a gate that goes green on a login page or a
 * dead server would pass every pull request while the app was down.
 */
export function unmeasuredReason(routes: readonly RouteHealth[], startIsFirst: boolean): string | null {
  const loaded = routes.filter((r) => r.loadError === undefined);
  if (loaded.length === 0) return "no page loaded. Is the app running at that URL?";
  // Without --paths the first route is the start page. When it bounces, what follows is the sign-in
  // page's own links (sign-up, forgot password): pages that load, but not the app.
  // With --paths there is no start page, only a list, and one walled path among public ones is an auth-redirect issue.
  if ((startIsFirst && routes[0]?.loginRedirect) || loaded.every((r) => r.loginRedirect)) {
    return "the start page sent the browser to sign-in, so only sign-in pages were measured. Pass --storage-state with a signed-in session, or regenerate it if it has expired.";
  }
  return null;
}

/** Loaded routes whose design audit measured nothing: their contrast, focus and target rules are silent, not clean. */
export function unauditedRoutes(routes: readonly RouteHealth[]): RouteHealth[] {
  return routes.filter((r) => r.loadError === undefined && r.auditError !== undefined);
}

/**
 * The document's own error status is already the route's issue, so the
 * oracle's record of that same response is not a second one. Run on the raw
 * measurements, before redaction: the oracle truncated the raw URL, and
 * redacting first would make the two stop matching. The #fragment is dropped
 * because the page URL keeps it and a request never carries one.
 */
export function withoutOwnResponse(r: RouteHealth): RouteHealth {
  if (r.status === null || r.status < 400) return r;
  const own = httpErrorDetail("GET", r.url.replace(/#.*$/, ""), r.status);
  return { ...r, violations: r.violations.filter((v) => !(v.kind === "http_error" && v.detail === own)) };
}

/** Lives beside redactSecrets so the baselines' file names (baseline.ts) use it too; exported here as before. */
export { redactRoute };

export function redactRoutes(routes: readonly RouteHealth[]): RouteHealth[] {
  const clean = redactRoute;
  return routes.map((r) => ({
    ...r,
    path: clean(r.path),
    url: clean(r.url),
    violations: r.violations.map((v) => ({ ...v, url: clean(v.url) })),
  }));
}

/**
 * The same redaction for visual baselines: a target's path, and the reason a
 * picture could not be taken, which can quote a URL the app redirected to.
 */
export function redactBaselineRun(run: BaselineRun): BaselineRun {
  return {
    ...run,
    results: run.results.map((r) => ({ ...r, path: redactRoute(r.path), ...(r.detail !== undefined ? { detail: redactSecrets(r.detail) } : {}) })),
  };
}

/** The same redaction for what flows measured: the page paths and the request URLs their violations quote. */
export function redactFlowRuns(runs: readonly FlowRun[]): FlowRun[] {
  return runs.map((f) => ({
    ...f,
    outcome:
      f.outcome.status === "passed"
        ? f.outcome
        : { ...f.outcome, path: redactRoute(f.outcome.path), did: redactRoute(f.outcome.did), reason: redactRoute(f.outcome.reason) },
    refusedBackground: f.refusedBackground.map(redactRoute),
    websockets: f.websockets.map(redactRoute),
    violations: f.violations.map(({ path, violation }) => ({ path: redactRoute(path), violation: { ...violation, url: redactRoute(violation.url) } })),
  }));
}

export function countBySeverity(issues: readonly CheckIssue[]): Record<CheckSeverity, number> {
  const counts: Record<CheckSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity] += 1;
  return counts;
}

/** The issues that fail the gate: those at `failOn` severity or worse. */
export function gateFailures(issues: readonly CheckIssue[], failOn: FailOn): CheckIssue[] {
  if (failOn === "never") return [];
  return issues.filter((i) => SEVERITY_RANK[i.severity] <= SEVERITY_RANK[failOn]);
}

/** Exit codes, stable for scripts: a gate failure is distinguishable from the check not running. */
export const EXIT = { pass: 0, gateFailed: 1, error: 2 } as const;

/**
 * The settings a project chooses for what a check may do beyond visiting
 * pages. Each default is the one that does the least harm on an unfamiliar
 * project: it never writes and never silently hides a result (ADR 12).
 */
export const FLOW_WRITES = ["never", "allow"] as const;
export type FlowWrites = (typeof FLOW_WRITES)[number];
export const ON_REFUSED_STEP = ["report", "stop"] as const;
export type OnRefusedStep = (typeof ON_REFUSED_STEP)[number];
export const GATE_RETESTS = ["never", "high", "all"] as const;
export type GateRetests = (typeof GATE_RETESTS)[number];

/** What a green check was allowed to do, written beside every verdict so a reviewer can see it. */
export interface CheckSettings {
  /** never: flows replay under observe's rule whatever --mode says. allow: under --mode. */
  flowWrites: FlowWrites;
  /** report: a refused flow is marked "could not run" and everything else keeps its verdict. stop: the check ends there. */
  onRefusedStep: OnRefusedStep;
  /** Which still-reproducing re-tested findings fail the gate. */
  gateRetests: GateRetests;
  retest: boolean;
}

export const DEFAULT_SETTINGS: CheckSettings = { flowWrites: "never", onRefusedStep: "report", gateRetests: "high", retest: true };

export interface CheckOptions extends CheckSettings {
  url: string;
  projectDir: string;
  outDir?: string;
  failOn: FailOn;
  mode: "observe" | "read-only";
  storageStatePath?: string;
  browser?: BrowserEngineName;
  /** How long one action may take; absent means the environment variable, else the default (limits.ts). */
  actionTimeoutMs?: number;
  /** How long a page may take to load; absent means the environment variable, else the default (limits.ts). */
  navTimeoutMs?: number;
  /**
   * Once this long has passed since the run began, route discovery starts no
   * new page; the page in progress finishes, and the start page is always
   * measured. Not with `paths`, which is a list the caller chose. Only the
   * first run (`scenescout <url>`) sets it; `scenescout check` visits every
   * route up to --max-routes however long that takes.
   */
  timeBudgetMs?: number;
  maxRoutes: number;
  paths?: string[];
  ignore: CheckRule[];
  /** The flows directory to replay; "off" for none; absent for the project's own when it has one. */
  flows?: string;
  /** off; compare the targets in the baselines folder with their baselines; or update those baselines. */
  baseline: BaselineMode;
  /** The baselines folder; absent for the project's own, inside .scenescout/ (baseline.ts). */
  baselinesDir?: string;
  /** The percentage of a picture's pixels that may change before its baseline is not met. */
  baselineThreshold: number;
}

/**
 * Every `--option` `scenescout check` accepts. The GitHub Action at the
 * repository root mirrors this list input for input, and check-test fails when
 * the two drift apart.
 */
export const CHECK_OPTION_NAMES = [
  "project",
  "out",
  "fail-on",
  "mode",
  "storage-state",
  "browser",
  "max-routes",
  "paths",
  "ignore",
  "flows",
  "retest",
  "flow-writes",
  "on-refused-step",
  "gate-retests",
  "action-timeout-ms",
  "nav-timeout-ms",
  "baseline",
  "baselines",
  "baseline-threshold",
] as const;

export const MAX_CHECK_ROUTES = 150;
/** Link discovery rounds: each crawl reveals the routes its pages link to. Past a few, a site is paginating rather than revealing. */
export const MAX_DISCOVERY_ROUNDS = 6;
export const DEFAULT_CHECK_ROUTES = 50;

/** A path given on the command line, resolved from the directory the command runs in; the same on every platform. */
export function resolveArgPath(cwd: string, p: string): string {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : `${cwd.replace(/[\\/]$/, "")}/${p}`;
}

/** Parse `scenescout check` arguments. Every mistake is a sentence, never a half-configured run. */
export function parseCheckArgs(args: readonly string[], cwd: string): { ok: true; options: CheckOptions } | { ok: false; error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
    if (eq < 0) i += 1;
    flags.set(name, value);
  }
  const known = new Set<string>(CHECK_OPTION_NAMES);
  for (const name of flags.keys()) if (!known.has(name)) return { ok: false, error: `unknown option --${name}` };
  if (positional.length !== 1) return { ok: false, error: "give exactly one URL to check, e.g. scenescout check http://127.0.0.1:3000" };
  let url: URL;
  try {
    url = new URL(positional[0]);
  } catch {
    return { ok: false, error: `not a URL: ${positional[0]}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: `only http and https URLs can be checked (got ${url.protocol})` };
  // It would be copied into the report, the JSON and the CI job's summary page.
  if (url.username || url.password)
    return { ok: false, error: "put no credentials in the URL: they would be written into the report. Sign in with --storage-state instead" };

  const failOn = (flags.get("fail-on") ?? "high") as FailOn;
  if (!FAIL_ON.includes(failOn)) return { ok: false, error: `--fail-on must be one of ${FAIL_ON.join(", ")}` };
  const mode = flags.get("mode") ?? "read-only";
  if (mode !== "observe" && mode !== "read-only") {
    return { ok: false, error: "--mode must be observe or read-only: the write policy for the crawl, and for saved flows under --flow-writes allow" };
  }
  const browser = flags.get("browser");
  if (browser !== undefined && !(BROWSER_ENGINES as readonly string[]).includes(browser)) {
    return { ok: false, error: `--browser must be one of ${BROWSER_ENGINES.join(", ")}` };
  }
  const actionTimeout = parseLimitFlag("action", flags.get("action-timeout-ms"));
  if (!actionTimeout.ok) return actionTimeout;
  const navTimeout = parseLimitFlag("nav", flags.get("nav-timeout-ms"));
  if (!navTimeout.ok) return navTimeout;
  const maxRaw = flags.get("max-routes");
  const maxRoutes = maxRaw === undefined ? DEFAULT_CHECK_ROUTES : Number(maxRaw);
  if (!Number.isInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > MAX_CHECK_ROUTES) {
    return { ok: false, error: `--max-routes must be a whole number from 1 to ${MAX_CHECK_ROUTES}` };
  }
  const list = (v: string | undefined): string[] | undefined =>
    v === undefined
      ? undefined
      : v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const paths = list(flags.get("paths"));
  if (paths && paths.length === 0) return { ok: false, error: "--paths is empty" };
  if (paths?.some((p) => !p.startsWith("/"))) return { ok: false, error: "--paths are paths on the app, each starting with /" };
  const ignore = list(flags.get("ignore")) ?? [];
  const unknownRules = ignore.filter((r) => !(CHECK_RULE_IDS as readonly string[]).includes(r));
  if (unknownRules.length > 0) return { ok: false, error: `unknown rule(s) in --ignore: ${unknownRules.join(", ")}. Rules: ${CHECK_RULE_IDS.join(", ")}` };
  const retest = flags.get("retest") ?? "on";
  if (retest !== "on" && retest !== "off") return { ok: false, error: "--retest must be on or off" };
  const flows = flags.get("flows");
  if (flows !== undefined && flows.trim() === "") return { ok: false, error: "--flows needs a directory, or off" };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T | null => {
    const v = flags.get(name) ?? fallback;
    return (allowed as readonly string[]).includes(v) ? (v as T) : null;
  };
  const flowWrites = oneOf("flow-writes", FLOW_WRITES, DEFAULT_SETTINGS.flowWrites);
  if (!flowWrites) return { ok: false, error: `--flow-writes must be one of ${FLOW_WRITES.join(", ")}` };
  const onRefusedStep = oneOf("on-refused-step", ON_REFUSED_STEP, DEFAULT_SETTINGS.onRefusedStep);
  if (!onRefusedStep) return { ok: false, error: `--on-refused-step must be one of ${ON_REFUSED_STEP.join(", ")}` };
  const gateRetests = oneOf("gate-retests", GATE_RETESTS, DEFAULT_SETTINGS.gateRetests);
  if (!gateRetests) return { ok: false, error: `--gate-retests must be one of ${GATE_RETESTS.join(", ")}` };
  const baseline = oneOf("baseline", BASELINE_MODES, "off");
  if (!baseline) return { ok: false, error: `--baseline must be one of ${BASELINE_MODES.join(", ")}` };
  const threshold = parseThreshold(flags.get("baseline-threshold"));
  if (!threshold.ok) return threshold;
  const baselinesDir = flags.get("baselines");
  if (baselinesDir !== undefined && baselinesDir.trim() === "") return { ok: false, error: "--baselines needs a directory" };
  // A setting that would do nothing is a mistake to point out, not to ignore: the check would run without the baselines asked for.
  if (baseline === "off" && (baselinesDir !== undefined || flags.has("baseline-threshold"))) {
    return { ok: false, error: "--baselines and --baseline-threshold apply only with --baseline compare or --baseline update" };
  }

  const resolve = (p: string): string => resolveArgPath(cwd, p);
  return {
    ok: true,
    options: {
      url: url.toString(),
      projectDir: resolve(flags.get("project") ?? cwd),
      ...(flags.has("out") ? { outDir: resolve(flags.get("out")!) } : {}),
      failOn,
      mode,
      ...(flags.has("storage-state") ? { storageStatePath: resolve(flags.get("storage-state")!) } : {}),
      ...(browser ? { browser: browser as BrowserEngineName } : {}),
      ...(actionTimeout.value !== undefined ? { actionTimeoutMs: actionTimeout.value } : {}),
      ...(navTimeout.value !== undefined ? { navTimeoutMs: navTimeout.value } : {}),
      maxRoutes,
      ...(paths ? { paths } : {}),
      ignore: ignore as CheckRule[],
      ...(flows !== undefined ? { flows: flows === "off" ? "off" : resolve(flows) } : {}),
      retest: retest === "on",
      flowWrites,
      onRefusedStep,
      gateRetests,
      baseline,
      ...(baselinesDir !== undefined ? { baselinesDir: resolve(baselinesDir) } : {}),
      baselineThreshold: threshold.value,
    },
  };
}

/** The settings part of the options, as the result records them. */
export function settingsOf(options: CheckSettings): CheckSettings {
  return { flowWrites: options.flowWrites, onRefusedStep: options.onRefusedStep, gateRetests: options.gateRetests, retest: options.retest };
}

export interface CheckResult {
  url: string;
  generatedAt: string;
  mode: CheckOptions["mode"];
  failOn: FailOn;
  routes: RouteHealth[];
  issues: CheckIssue[];
  /** Observations that are defects only under a convention of the project: listed apart, never counted or gated. */
  worthALook: CheckObservation[];
  /** Routes the engine knew of but did not reach within --max-routes (or, for a first run, its time budget). */
  unvisited: string[];
  /** Present only when the options gave a time budget: how long it was, and whether it ran out with routes still to visit. */
  timeBudget?: { ms: number; reached: boolean };
  ignored: CheckRule[];
  /** Every saved flow replayed, in file order. */
  flows: FlowRun[];
  /** Open findings from the project's memory, re-tested by loading their page. Null when --retest off or there is no memory. */
  retest: { open: number; results: CheckRetest[]; extraPages?: number } | null;
  settings: CheckSettings;
  /** Entries of the flows directory that were not replayed, each with its reason. */
  skippedFlows: SkippedFlowFile[];
  /** What --baseline compare or update did with each target; absent or null when it was off. */
  baselines?: BaselineRun | null;
}

/**
 * Why a check has no verdict because of a flow, or null. A step the write
 * policy refused asks for something a check will not do; the flow did not
 * run, so it neither passed nor broke, and the check exits "could not run"
 * rather than reporting a verdict on the rest as if the flow were fine.
 */
export function refusedFlowReason(result: Pick<CheckResult, "flows" | "mode" | "settings">): string | null {
  const refused = result.flows.filter((f) => f.outcome.status === "refused");
  if (refused.length === 0) return null;
  const why =
    result.settings.flowWrites === "never"
      ? "Flows replay with --flow-writes never, so no step may send a write whatever --mode says: remove the step, or pass --flow-writes allow to replay flows under --mode"
      : `Flows replay under --mode ${result.mode}, which refuses that write: remove the step, or leave the flow to an exploratory run`;
  return `${refused.map(flowStepEvidence).join("; ")}. ${why}.`;
}

/**
 * Re-tested findings that fail the gate: those still reproducing that
 * --gate-retests covers. "possibly fixed" and "not re-tested" never do, and
 * --fail-on never turns every gate off, this one included.
 */
export function retestGateFailures(result: Pick<CheckResult, "retest" | "failOn" | "settings">): CheckRetest[] {
  const { gateRetests } = result.settings;
  if (!result.retest || gateRetests === "never" || result.failOn === "never") return [];
  return result.retest.results.filter((r) => r.verdict === "reproduces" && (gateRetests === "all" || r.severity === "high"));
}

export function summarise(result: CheckResult): {
  passed: boolean;
  counts: Record<CheckSeverity, number>;
  failing: number;
  /** Of `failing`, how many are re-tested findings. */
  retestsFailing: number;
  /** Flows a refused step kept from running: the check has no verdict on them, so it exits 2 whatever the rest did. */
  couldNotRun: number;
} {
  const retestsFailing = retestGateFailures(result).length;
  const failing = gateFailures(result.issues, result.failOn).length + retestsFailing;
  const couldNotRun = result.flows.filter((f) => f.outcome.status === "refused").length;
  return { passed: failing === 0, counts: countBySeverity(result.issues), failing, retestsFailing, couldNotRun };
}

/** The exit code a finished check ends with. A flow that could not run outranks the gate: the verdict is incomplete. */
export function exitCodeOf(result: CheckResult): number {
  const { passed, couldNotRun } = summarise(result);
  if (couldNotRun > 0) return EXIT.error;
  return passed ? EXIT.pass : EXIT.gateFailed;
}

/** One line of the settings, for the report and the job summary. */
export function describeSettings(result: Pick<CheckResult, "settings" | "mode">): string {
  const s = result.settings;
  return `flow writes: ${s.flowWrites === "never" ? "never (flows replay under observe)" : `allow (flows replay under ${result.mode})`} · refused step: ${s.onRefusedStep} · re-tests: ${s.retest ? `on, gating ${s.gateRetests === "never" ? "nothing" : s.gateRetests === "all" ? "every one still reproducing" : "those filed high"}` : "off"}`;
}

const SARIF_LEVEL: Record<CheckSeverity, "error" | "warning" | "note"> = { high: "error", medium: "warning", low: "note" };

/**
 * SARIF 2.1.0, for code-scanning dashboards. A UI check has no source file to
 * point at, so each result's location is the route, relative to the checked
 * app (the APP base id). Fingerprints come from the evidence, not the
 * location, so a preview deployment on a new URL does not reopen every alert;
 * an unmet visual baseline's comes from its target and browser instead.
 */
const RETEST_SARIF_RULE = {
  id: "open-finding-reproduces",
  name: "Open finding still reproduces",
  shortDescription: { text: "Open finding still reproduces" },
  help: { text: "A finding an earlier run filed and left open failed the same way when its page loaded again. It gates according to --gate-retests." },
  defaultConfiguration: { level: "error" },
};

function sarifLocation(route: string): object {
  return route === SHARED_CHROME_ROUTE
    ? {
        physicalLocation: { artifactLocation: { uri: "", uriBaseId: "APP" } },
        message: { text: "the app's shared shell, on every page that renders it" },
      }
    : { physicalLocation: { artifactLocation: { uri: route.replace(/^\//, ""), uriBaseId: "APP" } } };
}

export function toSarif(result: CheckResult, toolVersion: string): object {
  const used = [...new Set(result.issues.map((i) => i.rule))];
  const lookRules = [...new Set(result.worthALook.map((o) => o.rule))];
  const base = new URL(result.url);
  const reproducing = retestGateFailures(result);
  const refused = result.flows.filter((f) => f.outcome.status === "refused");
  const issueResults: object[] = result.issues.map((i) => ({
    ruleId: i.rule,
    level: SARIF_LEVEL[i.severity],
    message: {
      text: `${CHECK_RULES[i.rule].title}: ${i.evidence}${i.routes.length > 1 ? ` (on ${i.routes.length} routes)` : ""}${i.embed ? ` (in an embed of ${i.embed})` : ""}`,
    },
    locations: i.routes.slice(0, 10).map(sarifLocation),
    partialFingerprints: { "scenescoutCheck/v1": i.fingerprint },
  }));
  // Always "note", whatever --fail-on says: a result a code-scanning dashboard shows, never one that reads as an error.
  const lookResults: object[] = result.worthALook.map((o) => ({
    ruleId: o.rule,
    level: "note",
    message: {
      text: `Worth a look — ${WORTH_A_LOOK_RULES[o.rule].title}: ${o.evidence}${o.routes.length > 1 ? ` (on ${o.routes.length} routes)` : ""}. A defect only if your project uses ${o.convention}.`,
    },
    locations: o.routes.slice(0, 10).map(sarifLocation),
    partialFingerprints: { "scenescoutCheck/v1": o.fingerprint },
    properties: { tier: "worth-a-look", convention: o.convention },
  }));
  // Only the re-tests that fail the gate are results: a reviewer reading code scanning sees what failed it.
  const retestResults: object[] = reproducing.map((r) => ({
    ruleId: RETEST_SARIF_RULE.id,
    // The severity the finding was filed at, as the page rules map theirs; an unknown one reads as the worst.
    level: SARIF_LEVEL[(CHECK_SEVERITIES as readonly string[]).includes(r.severity) ? (r.severity as CheckSeverity) : "high"],
    message: {
      text: `Open finding still reproduces: [${r.severity}] ${r.title} (${r.id}) — ${r.signatures.join(", ")} (gated by --gate-retests ${result.settings.gateRetests})`,
    },
    locations: [{ physicalLocation: { artifactLocation: { uri: r.path.replace(/^\//, ""), uriBaseId: "APP" } } }],
    partialFingerprints: { "scenescoutCheck/v1": createHash("sha256").update(`retest\u0000${r.id}`).digest("hex").slice(0, 32) },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "SceneScout",
            version: toolVersion,
            informationUri: "https://github.com/brunoboto96/SceneScout",
            rules: [
              ...used.map((id) => ({
                id,
                name: CHECK_RULES[id].title,
                shortDescription: { text: CHECK_RULES[id].title },
                help: { text: CHECK_RULES[id].help },
                defaultConfiguration: { level: SARIF_LEVEL[CHECK_RULES[id].severity] },
              })),
              ...lookRules.map((id) => ({
                id,
                name: WORTH_A_LOOK_RULES[id].title,
                shortDescription: { text: WORTH_A_LOOK_RULES[id].title },
                help: { text: `${WORTH_A_LOOK_RULES[id].help} Worth a look: a defect only if your project uses ${WORTH_A_LOOK_RULES[id].convention}.` },
                defaultConfiguration: { level: "note" },
                properties: { tags: ["worth-a-look"] },
              })),
              ...(reproducing.length > 0 ? [RETEST_SARIF_RULE] : []),
            ],
          },
        },
        // A flow that could not run is not a result about the app: it is the tool saying its run was incomplete.
        invocations: [
          {
            executionSuccessful: refused.length === 0,
            toolExecutionNotifications: refused.map((f) => ({
              level: "error",
              descriptor: { id: "flow-could-not-run" },
              message: { text: `Could not run: ${flowStepEvidence(f)}` },
            })),
          },
        ],
        originalUriBaseIds: { APP: { uri: `${base.origin}/` } },
        results: [...issueResults, ...lookResults, ...retestResults],
      },
    ],
  };
}

/**
 * Markdown cells: a pipe or a newline in evidence would break the table it
 * sits in. Backslashes are escaped first, or evidence ending in `\` would
 * turn the pipe's escape into a literal backslash and the pipe back into a column.
 */
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s*[\r\n]\s*/g, " ");
}
/** The same escaping, for other markdown tables: the CI run's summary. */
export const markdownCell = cell;

/** A code span that the text cannot close: its fence is one backtick longer than any run of backticks inside it. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
/** The first three routes as code spans, and how many more. */
function routeList(routes: readonly string[]): string {
  const shown = routes.slice(0, 3).map(code);
  return shown.join(", ") + (routes.length > 3 ? ` and ${routes.length - 3} more` : "");
}

const BASELINE_MARK: Record<BaselineResult["status"], string> = {
  matches: "✓",
  changed: "✗",
  "no-baseline": "○",
  unusable: "✗",
  "not-captured": "⊘",
  updated: "↻",
};

/** One target's line in the report. */
function baselineLine(r: BaselineResult, run: BaselineRun): string {
  const what = `${BASELINE_MARK[r.status]} ${code(r.element)} on ${code(r.path)}`;
  const notes = [r.platformNote, r.partial]
    .filter(Boolean)
    .map((n) => ` _(${cell(n!)})_`)
    .join("");
  switch (r.status) {
    case "matches":
      return `- ${what}: ${run.mode === "update" ? `within the threshold of its baseline (${r.diff?.percent ?? 0}% changed), which was left as it was` : `matches (${r.diff?.percent ?? 0}% changed)`}${notes}`;
    case "changed": {
      const files = r.files ? ` — expected ${code(r.files.expected)}, now ${code(r.files.actual)}, diff ${code(r.files.diff)}` : "";
      return `- ${what}: ${r.diff ? describeChange(r.diff, run.threshold) : "it no longer matches its baseline"}${files}${notes}`;
    }
    case "no-baseline":
      return `- ${what}: no baseline yet${notes}`;
    case "unusable":
      return `- ${what}: its baseline cannot be used: ${cell(r.detail ?? "no reason given")}`;
    case "not-captured":
      return `- ${what}: could not be captured: ${cell(r.detail ?? "no reason given")}${run.mode === "update" ? "; its baseline was not written" : ""}`;
    case "updated":
      return `- ${what}: baseline written to ${code(r.baseline)} (${cell(r.detail ?? "updated")})${notes}`;
  }
}

/** The report's section on visual baselines: every target and what became of it. */
function formatBaselines(run: BaselineRun): string[] {
  const c = countStatuses(run.results);
  const counts = (
    [
      ["changed", "changed"],
      ["unusable", "unusable"],
      ["not-captured", "not captured"],
      ["no-baseline", "no baseline yet"],
      ["updated", "updated"],
      ["matches", run.mode === "update" ? "left as they were" : "match"],
    ] as const
  )
    .filter(([k]) => c[k] > 0)
    .map(([k, label]) => `${c[k]} ${label}`)
    .join(" · ");
  const lines = [
    `## Visual baselines (${run.results.length})`,
    "",
    `${run.mode === "update" ? "Updated" : "Compared"} in ${run.engine}, baselines in ${code(run.dir)} · ${run.threshold}% of a picture's pixels may change · ${counts}`,
    "",
    ...run.results.map((r) => baselineLine(r, run)),
  ];
  if (c.changed > 0)
    lines.push(
      "",
      "The pictures are beside this report, under `visual/` (in the job's artifact on CI): the baseline, the picture now, and the changed pixels in red.",
    );
  if (c["no-baseline"] > 0 || c.unusable > 0) {
    lines.push(
      "",
      "A target with no baseline yet is listed and never fails; one whose baseline cannot be used fails until it is taken again. Run the check with `--baseline update` to take them.",
    );
  }
  if (run.results.some((r) => r.platformNote)) {
    lines.push(
      "",
      "_Some baselines were taken on another operating system. Each one draws text differently, so a change there may be the system's rather than the app's: take baselines where the check runs._",
    );
  }
  return lines;
}

/** One markdown list item for an issue: its title, rule, evidence and routes. */
export function issueLine(i: CheckIssue): string {
  return `**${CHECK_RULES[i.rule].title}** \`${i.rule}\`: ${cell(i.evidence)}${i.embed ? ` _(in an embed of ${i.embed}: its behaviour, not the app's)_` : ""} — ${routeList(i.routes)}`;
}

/** The issues, one section per severity, worst first. Shared by the check's report and the first run's. */
export function issueSections(issues: readonly CheckIssue[]): string[] {
  const lines: string[] = [];
  for (const sev of CHECK_SEVERITIES) {
    const of = issues.filter((i) => i.severity === sev);
    if (of.length === 0) continue;
    lines.push("", `## ${sev[0].toUpperCase()}${sev.slice(1)} (${of.length})`, "");
    for (const i of of) lines.push(`- ${issueLine(i)}`);
  }
  return lines;
}

const WORTH_A_LOOK_INTRO = "Measured exactly, and defects only under a convention of your project that the check cannot see.";

/** The worth-a-look section, or nothing when there is none. `gated`: the report is a gate's, so say these never fail it. */
export function worthALookSection(observations: readonly CheckObservation[], gated = true): string[] {
  if (observations.length === 0) return [];
  const lines = [
    "",
    `## Worth a look (${observations.length})`,
    "",
    `${WORTH_A_LOOK_INTRO} They are not counted above${gated ? " and never fail the gate, at any --fail-on" : ""}.`,
    "",
  ];
  for (const o of observations) {
    lines.push(
      `- **${WORTH_A_LOOK_RULES[o.rule].title}** \`${o.rule}\`: ${cell(o.evidence)} — a defect only if your project uses ${o.convention} — ${routeList(o.routes)}`,
    );
  }
  return lines;
}

/** The table of routes measured, with each one's status, controls and issue count. */
export function routesTable(result: Pick<CheckResult, "routes" | "issues">): string[] {
  const lines = ["", "## Routes", "", "| Route | Status | Controls | Issues |", "|---|---|---|---|"];
  for (const r of result.routes) {
    const n = result.issues.filter((i) => i.routes.includes(r.path)).length;
    const status =
      (r.loadError !== undefined ? "did not load" : r.loginRedirect ? `${r.status ?? "?"} → sign-in` : String(r.status ?? "?")) +
      (r.auditError ? ` (design not measured: ${cell(r.auditError.slice(0, 80))})` : "");
    // Plain text, not a code span: inside a table cell a code span keeps the backslashes cell() adds.
    lines.push(`| ${cell(r.path)} | ${status} | ${r.elements} | ${n} |`);
  }
  return lines;
}

/** The routes known and not visited, as one line; nothing when every known route was visited. */
export function unvisitedLine(unvisited: readonly string[], why: string): string[] {
  if (unvisited.length === 0) return [];
  return ["", `Not visited (${why}): ${unvisited.slice(0, 20).map(code).join(", ")}${unvisited.length > 20 ? " …" : ""}`];
}

/** The human report: the verdict first, then what failed it, then everything else. */
export function formatCheck(result: CheckResult): string {
  const { passed, counts, failing, retestsFailing, couldNotRun } = summarise(result);
  const lines: string[] = [];
  lines.push(`# SceneScout check`);
  lines.push("");
  lines.push(
    `${result.url} · ${result.routes.length} route(s) · mode ${result.mode} · gate: ${result.failOn === "never" ? "report only" : `fail on ${result.failOn}${result.failOn === "low" ? "" : " or worse"}`}`,
  );
  lines.push("");
  const unaudited = unauditedRoutes(result.routes).length;
  // Nothing compared is not a match: a target with no baseline yet is named beside the verdict, as an unmeasured design is.
  const uncompared = result.baselines?.mode === "compare" ? countStatuses(result.baselines.results)["no-baseline"] : 0;
  const failingText =
    retestsFailing > 0
      ? `${failing} failing the gate (${failing - retestsFailing} issue(s), ${retestsFailing} re-tested finding(s))`
      : `${failing} issue(s) at the gate's severity`;
  lines.push(
    (couldNotRun > 0 ? `**COULD NOT RUN** — ${couldNotRun} flow(s) had a step refused (see Flows); the rest ` : "") +
      (passed
        ? `${couldNotRun > 0 ? "passed" : "**PASSED**"} — ${counts.high} high · ${counts.medium} medium · ${counts.low} low`
        : `${couldNotRun > 0 ? "failed" : "**FAILED**"} — ${failingText} · ${counts.high} high · ${counts.medium} medium · ${counts.low} low`) +
      (unaudited > 0 ? ` · design not measured on ${unaudited} route(s)` : "") +
      (uncompared > 0 ? ` · ${uncompared} visual target(s) not compared: no baseline yet` : "") +
      (result.worthALook.length > 0 ? ` · ${result.worthALook.length} worth a look, never gated` : ""),
  );
  // Right under the verdict: what a green check was allowed to do is part of what it means.
  lines.push("", `Settings — ${describeSettings(result)}`);
  lines.push(...issueSections(result.issues));
  lines.push(...worthALookSection(result.worthALook));
  lines.push(...routesTable(result));
  lines.push(...unvisitedLine(result.unvisited, "over --max-routes"));
  if (result.flows.length > 0 || result.skippedFlows.length > 0) {
    lines.push("", `## Flows (${result.flows.length})`, "");
    for (const f of result.flows) {
      const o = f.outcome;
      lines.push(
        o.status === "passed"
          ? `- ✓ ${cell(f.name)} (${code(f.file)}): ${f.steps} step(s) passed`
          : o.status === "refused"
            ? `- ⊘ ${cell(f.name)} (${code(f.file)}): could not run — step ${o.step} of ${f.steps}, ${cell(o.did)}: ${cell(o.reason)} _(--flow-writes ${result.settings.flowWrites})_`
            : `- ✗ ${cell(f.name)} (${code(f.file)}): step ${o.step} of ${f.steps}, ${cell(o.did)}: ${cell(o.reason)}`,
      );
      if (f.refusedBackground.length > 0)
        lines.push(`  - refused background requests (beacons and pings, not charged to a step): ${f.refusedBackground.map(code).join(", ")}`);
      if (f.websockets.length > 0) lines.push(`  - WebSocket connections opened (not covered by the write rule): ${f.websockets.map(code).join(", ")}`);
    }
    for (const s of result.skippedFlows) lines.push(`- skipped ${code(s.file)}: ${cell(s.reason)}`);
  }
  if (result.baselines) lines.push("", ...formatBaselines(result.baselines));
  if (result.retest && result.retest.open > 0) {
    const { open, results } = result.retest;
    lines.push("", `## Open findings re-tested (${results.length} of ${open})`, "");
    const says: Record<CheckRetest["verdict"], string> = {
      reproduces: "still reproduces",
      "possibly-fixed": "possibly fixed: the page loaded and the request did not fail",
      "not-reached": "not re-tested",
    };
    const gating = new Set(retestGateFailures(result));
    for (const r of results) {
      lines.push(
        `- [${r.severity}] ${cell(r.title)} (${r.id}) on ${code(r.path)}: ${says[r.verdict]}${r.note ? ` (${r.note})` : ""}${gating.has(r) ? " — **fails the gate**" : ""} — ${r.signatures.map(code).join(", ")}`,
      );
    }
    if (result.retest.extraPages) {
      lines.push(
        "",
        `${result.retest.extraPages} page(s) were loaded only to re-test these findings; they are not in the routes above and no page rule was applied to them.`,
      );
    }
    if (open > results.length) {
      lines.push(
        "",
        `${open - results.length} open finding(s) need an interaction to reproduce, or name no failed GET, so a check cannot re-test them; \`scout_verify\` in an exploratory run can.`,
      );
    }
    lines.push(
      "",
      `_Re-tests gate by --gate-retests ${result.settings.gateRetests}: ${
        result.settings.gateRetests === "never"
          ? "none of them"
          : result.settings.gateRetests === "all"
            ? "every finding still reproducing"
            : "a finding filed high that still reproduces"
      } fails the gate; "possibly fixed" and "not re-tested" never do. A check never writes the project's memory, so nothing is resolved here._`,
    );
  }
  if (result.ignored.length > 0) lines.push("", `Rules ignored by --ignore: ${result.ignored.join(", ")}`);
  lines.push(
    "",
    result.flows.length > 0
      ? "_A check visits pages, measures what loads and replays the flows saved for it. It does not explore, fill forms of its own accord or compare roles; an exploratory run does that._"
      : "_A check visits pages and measures what loads. It does not fill forms, click through flows or compare roles; an exploratory run does that. Flows saved in .scenescout/flows are replayed._",
  );
  return lines.join("\n") + "\n";
}

/** The machine summary: stable keys for scripts and follow-up jobs. */
export function toSummaryJson(result: CheckResult, toolVersion: string): object {
  const { passed, counts, failing, retestsFailing, couldNotRun } = summarise(result);
  return {
    tool: "scenescout-check",
    version: toolVersion,
    url: result.url,
    generatedAt: result.generatedAt,
    mode: result.mode,
    gate: { failOn: result.failOn, passed, failing, retestsFailing, couldNotRun },
    settings: result.settings,
    counts,
    routes: result.routes.map((r) => ({
      path: r.path,
      status: r.status,
      loaded: r.loadError === undefined,
      loginRedirect: r.loginRedirect,
      controls: r.elements,
      ...(r.auditError !== undefined ? { designNotMeasured: r.auditError } : {}),
    })),
    unvisited: result.unvisited,
    ...(result.timeBudget ? { timeBudget: result.timeBudget } : {}),
    ignored: result.ignored,
    flows: result.flows.map((f) => ({
      name: f.name,
      file: f.file,
      steps: f.steps,
      status: f.outcome.status,
      ...(f.outcome.status === "passed" ? {} : { step: f.outcome.step, did: f.outcome.did, reason: f.outcome.reason, path: f.outcome.path }),
      refusedBackground: f.refusedBackground,
      websockets: f.websockets,
    })),
    skippedFlows: result.skippedFlows,
    retest: result.retest,
    baselines: result.baselines ?? null,
    issues: result.issues,
    // Apart from `issues` and `counts`, which the gate reads: none of these is counted or gated.
    worthALook: result.worthALook,
  };
}
