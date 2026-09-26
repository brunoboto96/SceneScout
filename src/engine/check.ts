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
import type { DesignDefect } from "./design.js";
import { redactSecrets } from "./memory.js";
import { httpErrorDetail, httpStatusOf, type OracleViolation } from "./oracles.js";

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
} as const satisfies Record<string, { severity: CheckSeverity; title: string; help: string }>;

export type CheckRule = keyof typeof CHECK_RULES;
export const CHECK_RULE_IDS = Object.keys(CHECK_RULES) as CheckRule[];

export interface CheckIssue {
  rule: CheckRule;
  severity: CheckSeverity;
  /** The fact, stable across runs: no snapshot refs, no ports. What dedup and fingerprints key on. */
  evidence: string;
  /** Every route it was seen on, first first. */
  routes: string[];
  /** Another site's frame, when the failure was that embed's. */
  embed?: string;
  fingerprint: string;
}

const SEVERITY_RANK: Record<CheckSeverity, number> = { high: 0, medium: 1, low: 2 };

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
 */
export function issuesFromRoutes(routes: readonly RouteHealth[], origin: string, ignore: readonly CheckRule[] = []): CheckIssue[] {
  const byKey = new Map<string, CheckIssue>();
  const add = (rule: CheckRule, evidence: string, route: string, opts: { severity?: CheckSeverity; embed?: string } = {}): void => {
    if (ignore.includes(rule)) return;
    const clean = redactSecrets(withoutOrigin(evidence, origin)).slice(0, 300);
    const key = `${rule}\u0000${clean}`;
    const found = byKey.get(key);
    if (found) {
      if (!found.routes.includes(route)) found.routes.push(route);
      return;
    }
    byKey.set(key, {
      rule,
      severity: opts.embed ? "medium" : (opts.severity ?? CHECK_RULES[rule].severity),
      evidence: clean,
      routes: [route],
      ...(opts.embed ? { embed: opts.embed } : {}),
      fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 32),
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
    for (const d of r.design) add(d.rule, d.detail, d.chrome ? "(shared chrome)" : route);
  }
  return [...byKey.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rule.localeCompare(b.rule));
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

/**
 * Routes are links the app printed, and a link can carry a token
 * (`?reset=…`, `?api_key=…`). Evidence is redacted where issues are built;
 * this does the same for every route string before anything is written.
 */
export function redactRoute(route: string): string {
  // The trailing "[n secrets redacted]" note belongs to prose; in a route it would read as part of the path.
  return redactSecrets(route).replace(/ \[\d+ secrets? redacted\]$/, "");
}

export function redactRoutes(routes: readonly RouteHealth[]): RouteHealth[] {
  const clean = redactRoute;
  return routes.map((r) => ({
    ...r,
    path: clean(r.path),
    url: clean(r.url),
    violations: r.violations.map((v) => ({ ...v, url: clean(v.url) })),
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

export interface CheckOptions {
  url: string;
  projectDir: string;
  outDir?: string;
  failOn: FailOn;
  mode: "observe" | "read-only";
  storageStatePath?: string;
  browser?: BrowserEngineName;
  maxRoutes: number;
  paths?: string[];
  ignore: CheckRule[];
}

/**
 * Every `--option` `scenescout check` accepts. The GitHub Action at the
 * repository root mirrors this list input for input, and check-test fails when
 * the two drift apart.
 */
export const CHECK_OPTION_NAMES = ["project", "out", "fail-on", "mode", "storage-state", "browser", "max-routes", "paths", "ignore"] as const;

export const MAX_CHECK_ROUTES = 150;
export const DEFAULT_CHECK_ROUTES = 50;

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
    return { ok: false, error: "--mode must be observe or read-only: a check only visits pages, so nothing it does needs a write" };
  }
  const browser = flags.get("browser");
  if (browser !== undefined && !(BROWSER_ENGINES as readonly string[]).includes(browser)) {
    return { ok: false, error: `--browser must be one of ${BROWSER_ENGINES.join(", ")}` };
  }
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
  const unknownRules = ignore.filter((r) => !(r in CHECK_RULES));
  if (unknownRules.length > 0) return { ok: false, error: `unknown rule(s) in --ignore: ${unknownRules.join(", ")}. Rules: ${CHECK_RULE_IDS.join(", ")}` };

  const resolve = (p: string): string => (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : `${cwd.replace(/[\\/]$/, "")}/${p}`);
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
      maxRoutes,
      ...(paths ? { paths } : {}),
      ignore: ignore as CheckRule[],
    },
  };
}

export interface CheckResult {
  url: string;
  generatedAt: string;
  mode: CheckOptions["mode"];
  failOn: FailOn;
  routes: RouteHealth[];
  issues: CheckIssue[];
  /** Routes the engine knew of but did not reach within --max-routes. */
  unvisited: string[];
  ignored: CheckRule[];
}

export function summarise(result: CheckResult): {
  passed: boolean;
  counts: Record<CheckSeverity, number>;
  failing: number;
} {
  const failing = gateFailures(result.issues, result.failOn).length;
  return { passed: failing === 0, counts: countBySeverity(result.issues), failing };
}

const SARIF_LEVEL: Record<CheckSeverity, "error" | "warning" | "note"> = { high: "error", medium: "warning", low: "note" };

/**
 * SARIF 2.1.0, for code-scanning dashboards. A UI check has no source file to
 * point at, so each result's location is the route, relative to the checked
 * app (the APP base id). Fingerprints come from the evidence, not the
 * location, so a preview deployment on a new URL does not reopen every alert.
 */
export function toSarif(result: CheckResult, toolVersion: string): object {
  const used = [...new Set(result.issues.map((i) => i.rule))];
  const base = new URL(result.url);
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
            rules: used.map((id) => ({
              id,
              name: CHECK_RULES[id].title,
              shortDescription: { text: CHECK_RULES[id].title },
              help: { text: CHECK_RULES[id].help },
              defaultConfiguration: { level: SARIF_LEVEL[CHECK_RULES[id].severity] },
            })),
          },
        },
        originalUriBaseIds: { APP: { uri: `${base.origin}/` } },
        results: result.issues.map((i) => ({
          ruleId: i.rule,
          level: SARIF_LEVEL[i.severity],
          message: {
            text: `${CHECK_RULES[i.rule].title}: ${i.evidence}${i.routes.length > 1 ? ` (on ${i.routes.length} routes)` : ""}${i.embed ? ` (in an embed of ${i.embed})` : ""}`,
          },
          locations: i.routes.slice(0, 10).map((r) =>
            r === "(shared chrome)"
              ? {
                  physicalLocation: { artifactLocation: { uri: "", uriBaseId: "APP" } },
                  message: { text: "the app's shared shell, on every page that renders it" },
                }
              : { physicalLocation: { artifactLocation: { uri: r.replace(/^\//, ""), uriBaseId: "APP" } } },
          ),
          partialFingerprints: { "scenescoutCheck/v1": i.fingerprint },
        })),
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
    .replace(/\s*\n\s*/g, " ");
}

/** A code span that the text cannot close: its fence is one backtick longer than any run of backticks inside it. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function routeList(routes: readonly string[]): string {
  const shown = routes.slice(0, 3).map(code);
  return shown.join(", ") + (routes.length > 3 ? ` and ${routes.length - 3} more` : "");
}

/** The human report: the verdict first, then what failed it, then everything else. */
export function formatCheck(result: CheckResult): string {
  const { passed, counts, failing } = summarise(result);
  const lines: string[] = [];
  lines.push(`# SceneScout check`);
  lines.push("");
  lines.push(
    `${result.url} · ${result.routes.length} route(s) · mode ${result.mode} · gate: ${result.failOn === "never" ? "report only" : `fail on ${result.failOn}${result.failOn === "low" ? "" : " or worse"}`}`,
  );
  lines.push("");
  const unaudited = unauditedRoutes(result.routes).length;
  lines.push(
    (passed
      ? `**PASSED** — ${counts.high} high · ${counts.medium} medium · ${counts.low} low`
      : `**FAILED** — ${failing} issue(s) at the gate's severity · ${counts.high} high · ${counts.medium} medium · ${counts.low} low`) +
      (unaudited > 0 ? ` · design not measured on ${unaudited} route(s)` : ""),
  );
  for (const sev of CHECK_SEVERITIES) {
    const of = result.issues.filter((i) => i.severity === sev);
    if (of.length === 0) continue;
    lines.push("", `## ${sev[0].toUpperCase()}${sev.slice(1)} (${of.length})`, "");
    for (const i of of) {
      lines.push(
        `- **${CHECK_RULES[i.rule].title}** \`${i.rule}\`: ${cell(i.evidence)}${i.embed ? ` _(in an embed of ${i.embed}: its behaviour, not the app's)_` : ""} — ${routeList(i.routes)}`,
      );
    }
  }
  lines.push("", "## Routes", "", "| Route | Status | Controls | Issues |", "|---|---|---|---|");
  for (const r of result.routes) {
    const n = result.issues.filter((i) => i.routes.includes(r.path)).length;
    const status =
      (r.loadError !== undefined ? "did not load" : r.loginRedirect ? `${r.status ?? "?"} → sign-in` : String(r.status ?? "?")) +
      (r.auditError ? ` (design not measured: ${cell(r.auditError.slice(0, 80))})` : "");
    // Plain text, not a code span: inside a table cell a code span keeps the backslashes cell() adds.
    lines.push(`| ${cell(r.path)} | ${status} | ${r.elements} | ${n} |`);
  }
  if (result.unvisited.length > 0) {
    lines.push("", `Not visited (over --max-routes): ${result.unvisited.slice(0, 20).map(code).join(", ")}${result.unvisited.length > 20 ? " …" : ""}`);
  }
  if (result.ignored.length > 0) lines.push("", `Rules ignored by --ignore: ${result.ignored.join(", ")}`);
  lines.push("", "_A check visits pages and measures what loads. It does not fill forms, click through flows or compare roles; an exploratory run does that._");
  return lines.join("\n") + "\n";
}

/** The machine summary: stable keys for scripts and follow-up jobs. */
export function toSummaryJson(result: CheckResult, toolVersion: string): object {
  const { passed, counts, failing } = summarise(result);
  return {
    tool: "scenescout-check",
    version: toolVersion,
    url: result.url,
    generatedAt: result.generatedAt,
    mode: result.mode,
    gate: { failOn: result.failOn, passed, failing },
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
    ignored: result.ignored,
    issues: result.issues,
  };
}
