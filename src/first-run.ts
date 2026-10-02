/**
 * `scenescout <url>`: a first look, with no setup.
 *
 * It is `scenescout check`'s engine (check-run.ts) run in observe mode unless
 * told otherwise, with a cap on pages and one on time, and presented as a
 * first look rather than a gate:
 * once it has looked it exits 0 whatever it found, and its summary and report
 * open with the three issues to look at first.
 *
 * It installs nothing but the one browser build a headless check launches, and
 * only when that is missing: no skill, no MCP registration, no command on
 * PATH. It reads nothing from the folder it runs in and writes only its report
 * folder there, and only into a folder that is new, empty or an earlier first
 * look's.
 *
 * The rules live here so they can be table-tested: install-test covers the
 * command line, the browser download and where the report is written,
 * check-test what the summary and the report say. cli.ts drives the browser,
 * and scripts/smoke/first-run.ts runs the built CLI against the demo app with
 * a throwaway home directory.
 */
import { DEFAULT_BASELINE_THRESHOLD } from "./engine/baseline.js";
import fs from "node:fs";
import path from "node:path";
import { APPROX_DISK_MB, launchTarget, type BrowserPresence, type InstallTarget } from "./browsers.js";
import { hasScheme, hostOf } from "./commands.js";
import {
  CHECK_OPTION_NAMES,
  CHECK_RULES,
  countBySeverity,
  issueLine,
  issueSections,
  MAX_CHECK_ROUTES,
  MAX_DISCOVERY_ROUNDS,
  resolveArgPath,
  routesTable,
  SEVERITY_RANK,
  SHARED_CHROME_ROUTE,
  unauditedRoutes,
  unvisitedLine,
  worthALookSection,
  type CheckIssue,
  type CheckOptions,
  type CheckResult,
  type RouteHealth,
} from "./engine/check.js";
import { httpStatusOf } from "./engine/oracles.js";

/** Every `--option` a first look accepts. Anything more is `scenescout check`'s. */
export const FIRST_RUN_OPTION_NAMES = ["max-routes", "max-minutes", "mode", "out"] as const;
/**
 * The write modes a first look runs in. Observe by default: a first look is
 * often pointed at a live app nobody has said may be written to, and observe
 * lets nothing but reads leave the page, where read-only lets plain POSTs through.
 */
const FIRST_RUN_MODES = ["observe", "read-only"] as const;
export type FirstRunMode = (typeof FIRST_RUN_MODES)[number];
/** Small enough to finish in a few minutes on most apps, large enough to reach past the start page's own links. */
export const FIRST_RUN_DEFAULTS = { maxRoutes: 20, maxMinutes: 3, mode: "observe" } as const satisfies {
  maxRoutes: number;
  maxMinutes: number;
  mode: FirstRunMode;
};
export const MAX_FIRST_RUN_MINUTES = 30;
/** The folder the report goes to, in the directory the command runs in. */
export const FIRST_RUN_DIRNAME = "scenescout-report";
export const GUIDE_URL = "https://github.com/brunoboto96/SceneScout/wiki/Start-here";
const SAFETY_URL = "https://github.com/brunoboto96/SceneScout/wiki/Safety-model";
/** Exit codes: a first look is not a gate, so findings never change them. */
export const EXIT_FIRST_RUN = { ran: 0, couldNotRun: 2 } as const;
/** The browser a first look drives, whatever SCENESCOUT_BROWSER says: it is the one it downloads when missing. */
const FIRST_RUN_ENGINE = "chromium" as const;

export interface FirstRunOptions {
  url: string;
  maxRoutes: number;
  maxMinutes: number;
  mode: FirstRunMode;
  /** Where the report goes. Absent: ./scenescout-report, or a temporary folder when that cannot be written. */
  outDir?: string;
}

/** A command-line argument as it can be pasted into a shell: quoted when it holds a character the shell would act on, such as `?` or `&`. */
export function shellArg(text: string): string {
  return /^[A-Za-z0-9_/.:=@%+,~-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/** Hosts a dev server answers on, where the scheme to suggest is plain http. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d+)?$/i;

/**
 * Parse a first look's command line, the address first, as the dispatcher
 * hands it over. Every mistake is a sentence, never a half-configured run.
 */
export function parseFirstRunArgs(args: readonly string[], cwd: string): { ok: true; options: FirstRunOptions } | { ok: false; error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const takes = `a first look takes only ${FIRST_RUN_OPTION_NAMES.map((n) => `--${n}`).join(", ")}`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    if (!a.startsWith("--")) return { ok: false, error: `unknown option ${a}: ${takes}` };
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (!(FIRST_RUN_OPTION_NAMES as readonly string[]).includes(name)) {
      return {
        ok: false,
        error: (CHECK_OPTION_NAMES as readonly string[]).includes(name)
          ? `--${name} is an option of scenescout check, not of a first look: scenescout check <url> --${name} …`
          : `unknown option --${name}: ${takes}`,
      };
    }
    const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
    if (value === undefined || value.trim() === "" || (eq < 0 && value.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
    if (eq < 0) i += 1;
    flags.set(name, value);
  }
  if (positional.length === 0) return { ok: false, error: "give the address to look at, e.g. scenescout http://localhost:3000" };
  if (positional.length > 1) return { ok: false, error: `give one address, not ${positional.length}: ${positional.join(" ")}` };
  const raw = positional[0];
  if (!hasScheme(raw)) {
    // Not guessed: http and https are different servers, and a wrong guess reads as "the app is down".
    return {
      ok: false,
      error: `write the address in full, with its scheme: scenescout ${shellArg(`${LOCAL_HOST.test(hostOf(raw)) ? "http" : "https"}://${raw}`)}`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `not a URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, error: `only http and https addresses can be looked at (got ${url.protocol})` };
  // It would be copied into the report and the summary.
  if (url.username || url.password) {
    return { ok: false, error: "put no credentials in the address: they would be written into the report. For pages behind a sign-in, see scenescout login" };
  }
  const whole = (name: string, lo: number, hi: number, fallback: number): number | string => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : `--${name} must be a whole number from ${lo} to ${hi}`;
  };
  const maxRoutes = whole("max-routes", 1, MAX_CHECK_ROUTES, FIRST_RUN_DEFAULTS.maxRoutes);
  if (typeof maxRoutes === "string") return { ok: false, error: maxRoutes };
  const maxMinutes = whole("max-minutes", 1, MAX_FIRST_RUN_MINUTES, FIRST_RUN_DEFAULTS.maxMinutes);
  if (typeof maxMinutes === "string") return { ok: false, error: maxMinutes };
  const mode = flags.get("mode") ?? FIRST_RUN_DEFAULTS.mode;
  if (!(FIRST_RUN_MODES as readonly string[]).includes(mode)) {
    return { ok: false, error: `--mode must be observe (the default) or read-only: a first look never writes on purpose, whatever the mode` };
  }
  const out = flags.get("out");
  return {
    ok: true,
    options: { url: url.toString(), maxRoutes, maxMinutes, mode: mode as FirstRunMode, ...(out !== undefined ? { outDir: resolveArgPath(cwd, out) } : {}) },
  };
}

/**
 * The check a first look is: in its mode, never gated, its caps, and nothing
 * read from a project. `projectDir` is an empty folder of its own, so no saved
 * flow, memory or source route of whatever folder it runs in is used.
 */
export function firstRunCheckOptions(o: FirstRunOptions, projectDir: string): CheckOptions {
  return {
    url: o.url,
    projectDir,
    failOn: "never",
    mode: o.mode,
    browser: FIRST_RUN_ENGINE,
    maxRoutes: o.maxRoutes,
    timeBudgetMs: o.maxMinutes * 60_000,
    ignore: [],
    flows: "off",
    retest: false,
    flowWrites: "never",
    onRefusedStep: "report",
    gateRetests: "never",
    // A first look pictures nothing: baselines are a project's own list.
    baseline: "off",
    baselineThreshold: DEFAULT_BASELINE_THRESHOLD,
  };
}

/** What a first look downloads: the one build a headless Chromium launch needs, when it is not on disk, and nothing else. */
export function firstRunDownloads(presence: BrowserPresence): InstallTarget[] {
  const target = launchTarget(FIRST_RUN_ENGINE, false);
  return presence[target].installed ? [] : [target];
}

/** The progress line before the download. */
export function downloadLine(targets: readonly InstallTarget[]): string {
  const mb = targets.reduce((sum, t) => sum + APPROX_DISK_MB[t], 0);
  return `· Chromium is not on this machine yet. Downloading it once (${targets.join(", ")}, about ${mb} MB on disk)…`;
}

/** Why the address could not be looked at, or null when a page loaded. Nothing loaded means there is nothing to report. */
export function unreachableReason(routes: readonly RouteHealth[]): string | null {
  if (routes.some((r) => r.loadError === undefined)) return null;
  return routes[0]?.loadError ?? "no page loaded";
}

/** What each mode lets out of the page, in one sentence: for the line before a look and for the report. */
export function modeSentence(mode: FirstRunMode): string {
  return mode === "observe"
    ? "In observe mode nothing but GET, HEAD and OPTIONS requests leaves the page, apart from signing in, signing out and refreshing a token: every other request a page sends is refused."
    : "In read-only mode a PUT, PATCH or DELETE a page sends, or a POST that looks destructive, is refused, while a plain POST the page's own scripts send goes through.";
}

const SELF_IGNORE = "# A SceneScout first-look report. It ignores itself, so a `git add -A` here never commits it.\n*\n";

/** The file that makes a folder a first look's: a folder is written into again only when it holds this, is empty or is new. */
export const FIRST_LOOK_MARKER = ".scenescout-first-look";
const MARKER_TEXT = "This folder holds a SceneScout first-look report. A later `scenescout <url>` replaces report.md and check.json here, and nothing else.\n";

/**
 * How each file a first look writes begins. A file is replaced only when it is
 * a regular file that begins this way: its name proves nothing on a file
 * system that ignores case, where someone's Report.md answers to report.md,
 * and a link would carry the write somewhere else.
 */
const OWN_FILE_START = {
  "report.md": "# SceneScout first look\n",
  "check.json": '{\n  "tool": "scenescout-check",',
} as const;
type FirstLookFile = keyof typeof OWN_FILE_START;
const FIRST_LOOK_FILES = Object.keys(OWN_FILE_START) as FirstLookFile[];

/** Whether `text`, the start of a file named `name`, is how a first look writes that file. */
export function writtenByFirstLook(name: FirstLookFile, text: string): boolean {
  return text.startsWith(OWN_FILE_START[name]);
}

/** Why a write failed, in a word where the system gives one. */
const writeFailure = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

/** What is at `p`, its last part not followed if it is a link: nothing, a regular file, a folder, or something else (a link, a device). */
function entryAt(p: string): "none" | "file" | "folder" | "other" {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(p, { throwIfNoEntry: false });
  } catch (err) {
    // A path under a file has no entry: the file above it is what is there, and the caller names it.
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return "none";
    throw err;
  }
  if (!stat) return "none";
  return stat.isFile() ? "file" : stat.isDirectory() ? "folder" : "other";
}

/** How a file begins: enough of it to tell whether a first look wrote it. */
function startOf(p: string): string {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(64);
    return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** The names a first look writes under which `dir` holds something it did not write: another kind of entry, or a file that begins otherwise. */
function entriesNotItsOwn(dir: string): string[] {
  const theirs: string[] = FIRST_LOOK_FILES.filter((name) => {
    const at = entryAt(path.join(dir, name));
    return at !== "none" && !(at === "file" && writtenByFirstLook(name, startOf(path.join(dir, name))));
  });
  const marker = entryAt(path.join(dir, FIRST_LOOK_MARKER));
  if (marker !== "none" && marker !== "file") theirs.push(FIRST_LOOK_MARKER);
  return theirs;
}

/**
 * Why a first look may not write its report to `dir`, or null when it may.
 * Nothing is created or changed here, so it can be asked before the look, and
 * it is asked again just before writing.
 *
 * - The default folder (`chosen` false) is written only when it is new, empty
 *   or holds the marker of an earlier first look: anything else there is
 *   someone's, and nothing in it is replaced. A default folder that cannot be
 *   written is not a reason: the report then goes to a temporary folder.
 * - A folder named with --out (`chosen` true) may hold other files.
 * - In either, a report.md or check.json is replaced only when a first look
 *   wrote it, and the folder must be a folder, not a link to one. An --out
 *   folder must be writable, or creatable under a folder that is; a
 *   permission this cannot see shows when the report is written.
 */
export function reportFolderProblem(dir: string, chosen: boolean): string | null {
  const elsewhere = chosen ? "Name another folder with --out" : "Pass --out <folder> to put the report somewhere else";
  const named = chosen ? `--out ${dir}` : dir;
  try {
    const at = entryAt(dir);
    if (at === "file" || at === "other") {
      return chosen
        ? `--out ${dir} is ${at === "file" ? "a file" : "a link or a special file"}, not a folder.`
        : `${dir} already exists and is not a folder, so it is left alone. ${elsewhere}.`;
    }
    if (at === "folder") {
      const marked = entryAt(path.join(dir, FIRST_LOOK_MARKER)) === "file";
      if (!chosen && !marked && fs.readdirSync(dir).length > 0) {
        return `${dir} already exists and holds files a first look did not write, so nothing in it is touched. ${elsewhere}.`;
      }
      const theirs = entriesNotItsOwn(dir);
      if (theirs.length > 0) return `${named} holds a ${theirs.join(" and ")} a first look did not write, so nothing there is replaced. ${elsewhere}.`;
    }
  } catch (err) {
    return `${named} cannot be read (${writeFailure(err)}), so nothing is written there. ${elsewhere}.`;
  }
  if (!chosen) return null;
  // The folder itself when it exists, else the nearest folder above it that does: the one the new folders go under.
  let existing = dir;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  try {
    if (!fs.statSync(existing).isDirectory()) return `--out ${dir} cannot be created: ${existing} is a file.`;
    fs.accessSync(existing, fs.constants.W_OK);
  } catch (err) {
    return `--out ${dir} cannot be written (${writeFailure(err)}).`;
  }
  return null;
}

/**
 * Write a first look's report files, each folder's marker first, so a write
 * that fails partway still leaves a folder a later look may write into.
 * Without `outDir` they go to `scenescout-report/` in `cwd`, whose `.gitignore`
 * comes next, so nothing there is left for git to pick up; when that folder
 * cannot be written they go to a new folder under `tmpdir`, and `note` says
 * why. A folder named with --out is used as given or not at all. Throws with
 * the reason when the folder is someone else's (`reportFolderProblem`), and
 * with every reason when nowhere could be written.
 */
export function writeFirstRunReport(
  files: Readonly<Record<FirstLookFile, string>>,
  where: { cwd: string; tmpdir: string; outDir?: string },
): { dir: string; note?: string } {
  const write = (dir: string, selfIgnore: boolean): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FIRST_LOOK_MARKER), MARKER_TEXT);
    const ignore = path.join(dir, ".gitignore");
    // Never over anything already there, a link included: a .gitignore someone wrote stays theirs.
    if (selfIgnore && entryAt(ignore) === "none") fs.writeFileSync(ignore, SELF_IGNORE);
    for (const name of FIRST_LOOK_FILES) fs.writeFileSync(path.join(dir, name), files[name]);
  };
  if (where.outDir !== undefined) {
    const problem = reportFolderProblem(where.outDir, true);
    if (problem) throw new Error(problem);
    try {
      write(where.outDir, false);
    } catch (err) {
      throw new Error(`${where.outDir} could not be written (${writeFailure(err)})`);
    }
    return { dir: where.outDir };
  }
  const here = path.join(where.cwd, FIRST_RUN_DIRNAME);
  // Someone else's folder is never written into, and never swapped for a temporary one: the person decides with --out.
  const problem = reportFolderProblem(here, false);
  if (problem) throw new Error(problem);
  let first: string;
  try {
    write(here, true);
    return { dir: here };
  } catch (err) {
    first = writeFailure(err);
  }
  try {
    const elsewhere = fs.mkdtempSync(path.join(where.tmpdir, `${FIRST_RUN_DIRNAME}-`));
    write(elsewhere, false);
    return { dir: elsewhere, note: `· ${here} could not be written (${first}), so the report is in a temporary folder.` };
  } catch (err) {
    throw new Error(`${here} could not be written (${first}), and neither could a temporary folder (${writeFailure(err)})`);
  }
}

/** Declaration order puts causes first: a failed request before the broken image it leaves. */
const RULE_ORDER = Object.keys(CHECK_RULES);

/** Pages an issue was seen on. The app's shared shell is on every page looked at. */
export function pagesAffected(issue: CheckIssue, pagesLookedAt: number): number {
  return issue.routes.includes(SHARED_CHROME_ROUTE) ? Math.max(pagesLookedAt, issue.routes.length) : issue.routes.length;
}

/** Evidence without the note redaction appends to it ("[1 secret redacted]"), which would otherwise end every line it touched. */
const withoutRedactionNote = (evidence: string): string => evidence.replace(/ \[\d+ secrets? redacted\]$/, "");

/**
 * The address an issue is about, when it is a request or an image. An image
 * that answers 404 is filed twice, as a failed request and as a broken image,
 * and it is one thing to look at.
 */
export function resourceOf(issue: CheckIssue): string | null {
  const evidence = withoutRedactionNote(issue.evidence);
  switch (issue.rule) {
    case "client-error":
    case "server-error":
    case "request-failed":
      return /^[A-Z]+ (\S+)/.exec(evidence)?.[1] ?? null;
    case "broken-image":
      return / FAILED TO LOAD — (\S+)$/.exec(evidence)?.[1] ?? null;
    default:
      return null;
  }
}

/** Below this, a shorter address that starts a longer one is a different address, not the same one cut short. */
const CUT_ADDRESS_MIN = 80;

/**
 * Whether two addresses name the same resource. An image's address is cut at
 * 160 characters and a request's at 200, so a long one is compared on the
 * part both kept.
 */
export function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= CUT_ADDRESS_MIN && long.startsWith(short);
}

/** The browser's own console line for a load that failed: it names the status or the network error, never the address. */
const LOAD_ECHO = /^Failed to load resource: (?:the server responded with a status of (\d{3})\b|(net::[A-Z_]+))/;

/**
 * Whether a console error is the browser's own line about a failed request the
 * check lists as an issue anyway: "Failed to load resource" with the same
 * status (or network error) as a failed request on one of the same pages. The
 * line has no address to compare, so the page and the status are what it is
 * matched on. One such line is filed once for every page it appeared on, so
 * it can outrank each request it echoes; the request is the thing to look at.
 */
export function echoesListedRequest(issue: CheckIssue, issues: readonly CheckIssue[]): boolean {
  if (issue.rule !== "console-error") return false;
  const m = LOAD_ECHO.exec(issue.evidence);
  if (!m) return false;
  return issues.some((c) => {
    if (!c.routes.some((r) => issue.routes.includes(r))) return false;
    if (m[1] !== undefined) return (c.rule === "client-error" || c.rule === "server-error") && httpStatusOf(c.evidence) === Number(m[1]);
    return c.rule === "request-failed" && withoutRedactionNote(c.evidence).endsWith(`→ ${m[2]}`);
  });
}

/**
 * The issues to look at first: the highest severity, then the most pages
 * affected. Within those, a console error comes last, since its cause usually
 * shows as its own issue, and then the order the rules are declared in. One
 * failure seen several ways takes one slot: an issue about an address already
 * chosen is skipped (a missing image is a failed request and a broken image),
 * and so is the browser's console line about a failed request that is listed.
 */
export function firstLook(issues: readonly CheckIssue[], pagesLookedAt: number, count = 3): CheckIssue[] {
  const ordered = [...issues].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      pagesAffected(b, pagesLookedAt) - pagesAffected(a, pagesLookedAt) ||
      Number(a.rule === "console-error") - Number(b.rule === "console-error") ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule),
  );
  const picked: CheckIssue[] = [];
  const addresses: string[] = [];
  for (const i of ordered) {
    if (picked.length === count) break;
    if (echoesListedRequest(i, issues)) continue;
    const address = resourceOf(i);
    if (address !== null) {
      if (addresses.some((a) => sameAddress(a, address))) continue;
      addresses.push(address);
    }
    picked.push(i);
  }
  return picked;
}

/** What the summary and the report say about one look. */
export interface FirstRunFacts {
  result: CheckResult;
  /** The page cap: the time budget is in the result. */
  options: Pick<FirstRunOptions, "maxRoutes">;
  elapsedMs: number;
}

/**
 * Why pages were found and not looked at: the time limit, the page limit, or
 * the link discovery rounds running out. Null when nothing found was left.
 */
export function stopReason(result: Pick<CheckResult, "routes" | "unvisited" | "timeBudget">, maxRoutes: number): "time" | "pages" | "rounds" | null {
  if (result.unvisited.length === 0) return null;
  if (result.timeBudget?.reached) return "time";
  if (result.routes.length >= maxRoutes) return "pages";
  return "rounds";
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** Whole seconds first, so 119.7 s reads "2 min 0 s" and never "1 min 60 s". */
const seconds = (ms: number): string => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/**
 * Evidence as one terminal line. It quotes the page (an exception's message, a
 * console line), so a line break would split the list, and a control character,
 * an escape sequence among them, would reach the terminal from the app.
 */
const oneLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

/** Where an issue was seen, in a few words. */
function seenOn(i: CheckIssue, pagesLookedAt: number): string {
  if (i.routes.includes(SHARED_CHROME_ROUTE)) return "on every page";
  if (i.routes.length === 1) return `on ${i.routes[0]}`;
  const shown = i.routes.slice(0, 2).join(", ");
  return `on ${pagesAffected(i, pagesLookedAt)} pages: ${shown}${i.routes.length > 2 ? ` and ${i.routes.length - 2} more` : ""}`;
}

function countsText(result: CheckResult): string {
  const c = countBySeverity(result.issues);
  const unaudited = unauditedRoutes(result.routes).length;
  return (
    `${c.high} high · ${c.medium} medium · ${c.low} low` +
    (result.worthALook.length > 0 ? ` · ${result.worthALook.length} worth a look, never counted` : "") +
    (unaudited > 0 ? ` · design not measured on ${plural(unaudited, "page")}` : "")
  );
}

/** The origin a page ended up on, when it is not the one asked for; null when it is, or cannot be read. */
function movedTo(asked: string, landed: string): string | null {
  try {
    const to = new URL(landed).origin;
    return to !== new URL(asked).origin ? to : null;
  } catch {
    // A route's address that does not parse is reported as it is elsewhere; it is no evidence of a move.
    return null;
  }
}

/** What limited the look, in sentences. `code` formats a command: plain in a terminal, a code span in markdown. */
function notes({ result, options }: FirstRunFacts, code: (s: string) => string): string[] {
  const out: string[] = [];
  const start = result.routes[0];
  if (start?.loginRedirect) {
    out.push(
      `The start page sent the browser to a sign-in page, so this is what a visitor who is not signed in sees. ${code(`npx -y scenescout login ${shellArg(result.url)} --role <name>`)} saves a sign-in, so an agent run can look at the rest.`,
    );
  } else if (start && start.loadError === undefined) {
    const to = movedTo(result.url, start.url);
    if (to) {
      out.push(
        `The start page moved to ${to}, so its links count as another site's and were not followed. To look further, run it there: ${code(`npx -y scenescout ${shellArg(`${to}/`)}`)}.`,
      );
    }
  }
  const left = result.unvisited.length;
  switch (stopReason(result, options.maxRoutes)) {
    case "time":
      out.push(
        `Stopped after ${plural(Math.round((result.timeBudget?.ms ?? 0) / 60_000), "minute")}, the first look's time limit, with ${plural(left, "more page")} found and not looked at. ${code("--max-minutes")} raises it.`,
      );
      break;
    case "pages":
      out.push(
        `Stopped at ${plural(options.maxRoutes, "page")}, the first look's limit, with ${plural(left, "more page")} found and not looked at. ${code("--max-routes")} raises it, up to ${MAX_CHECK_ROUTES}.`,
      );
      break;
    case "rounds":
      out.push(
        `${plural(left, "more page")} found and not looked at: links are followed ${MAX_DISCOVERY_ROUNDS} steps from the start page, since past that a site is usually paginating rather than showing new pages. ${code(`npx -y scenescout check ${shellArg(result.url)} --paths /a,/b`)} measures pages by name.`,
      );
      break;
  }
  return out;
}

/** Why the routes left were not visited, for the report's list of them. */
const UNVISITED_WHY: Record<NonNullable<ReturnType<typeof stopReason>>, string> = {
  time: "the time limit ran out",
  pages: "over --max-routes",
  rounds: "past the link steps followed",
};

const NEXT_LINE =
  "Next: let your coding agent explore it and file what it finds (npx -y scenescout install), gate pull requests with npx -y scenescout check in CI, " +
  `and sign in for the pages behind a login (npx -y scenescout login <url> --role <name>). Guide: ${GUIDE_URL}`;

/**
 * The terminal summary, after the look: the three issues to look at first, the
 * counts, what limited the look, where the report is, and what to try next.
 * `report` finishes the line "Report: …": the file's path, or why it was not written.
 */
export function firstRunSummary(facts: FirstRunFacts, report: string): string[] {
  const { result, elapsedMs } = facts;
  const pages = result.routes.length;
  const top = firstLook(result.issues, pages);
  const lines: string[] = [];
  if (top.length === 0) lines.push(`No issues found on the ${plural(pages, "page")} looked at.`);
  else {
    lines.push("Look at these first:");
    top.forEach((i, n) => lines.push(`  ${n + 1}. [${i.severity}] ${CHECK_RULES[i.rule].title}: ${clip(oneLine(i.evidence), 160)} (${seenOn(i, pages)})`));
  }
  lines.push("", `${plural(pages, "page")} looked at in ${seconds(elapsedMs)} in ${result.mode} mode: ${countsText(result)}.`);
  lines.push(...notes(facts, (s) => s));
  lines.push(`Report: ${report}`, "", NEXT_LINE);
  return lines;
}

/** The report a first look writes: the same measurements as a check's, opening with what to look at first and closing with what to try next. */
export function formatFirstRun(facts: FirstRunFacts): string {
  const { result, elapsedMs } = facts;
  const pages = result.routes.length;
  const top = firstLook(result.issues, pages);
  const code = (s: string): string => `\`${s}\``;
  const lines = [
    "# SceneScout first look",
    "",
    `${result.url} · ${plural(pages, "page")} looked at in ${seconds(elapsedMs)} · ${result.mode} mode · ${result.generatedAt}`,
  ];
  lines.push("", "## Look at these first", "");
  if (top.length === 0) lines.push(`No issues found on the ${plural(pages, "page")} looked at.`);
  else top.forEach((i, n) => lines.push(`${n + 1}. [${i.severity}] ${issueLine(i)}`));
  lines.push("", countsText(result));
  for (const note of notes(facts, code)) lines.push("", note);
  lines.push(...issueSections(result.issues));
  lines.push(...worthALookSection(result.worthALook, false));
  lines.push(...routesTable(result));
  const why = stopReason(result, facts.options.maxRoutes);
  lines.push(...unvisitedLine(result.unvisited, why ? UNVISITED_WHY[why] : "not reached"));
  lines.push(
    "",
    "## What to try next",
    "",
    `- **Explore it with your coding agent.** ${code("npx -y scenescout install")} sets up the skill and the MCP server; then ask your agent to use SceneScout to test ${result.url}. It clicks, fills forms and compares roles, files what it finds and reports what it did not test.`,
    `- **Gate pull requests.** ${code(`npx -y scenescout check ${shellArg(result.url)}`)} is this look as a pass or a fail, with SARIF for code scanning; it also runs as a GitHub Action.`,
    `- **Pages behind a sign-in.** ${code(`npx -y scenescout login ${shellArg(result.url)} --role <name>`)} saves a sign-in once, and an agent run then attaches as that role.`,
    "",
    `The guide: ${GUIDE_URL}`,
    "",
    `_A first look opens pages and measures what loads, and fills and submits no form. ${modeSentence(result.mode)} (${SAFETY_URL}) It does not click through flows or compare roles; an exploratory run does that._`,
  );
  return lines.join("\n") + "\n";
}
