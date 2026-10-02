/**
 * `scenescout export`: the rules for turning a project's findings into issues
 * where a team works, in GitHub or Jira. Which findings go, what each issue
 * says, the marker a later export recognises it by, what is already filed and
 * how many one export may file. Nothing here touches the network or the disk:
 * src/export-run.ts reads the files and sends the requests, so every rule in
 * this file is table-tested in export-test without a tracker.
 *
 * Issue text is written by a model and quotes the app under test, and a
 * tracker renders it: GitHub turns `@name` into a notification, `#12` into a
 * cross-reference and an address into a link. Every piece of that text is
 * made inert before it goes into an issue.
 */
import { readFindings } from "./ci.js";
import { isWorthALook, redactSecrets, type ActionLogEntry, type Finding } from "./memory.js";
import { retryAfterMs } from "./provider.js";

const TRACKERS = ["github", "jira"] as const;
export type Tracker = (typeof TRACKERS)[number];
export const TRACKER_LABEL: Record<Tracker, string> = { github: "GitHub", jira: "Jira" };

export type Severity = Finding["severity"];
export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Every option `scenescout export` accepts. guide-test holds the configuration reference equal to it. */
export const EXPORT_OPTION_NAMES = [
  "to",
  "repo",
  "jira-url",
  "jira-project",
  "jira-issue-type",
  "project",
  "min-severity",
  "only",
  "max-issues",
  "severity-map",
  "labels",
  "screenshots",
  "include-closed",
  "include-worth-a-look",
  "dry-run",
  "yes",
] as const;
const SWITCHES = new Set(["include-closed", "include-worth-a-look", "dry-run", "yes"]);
/** Options someone might reach for to pass a credential. Each is refused with where the credential comes from instead. */
const CREDENTIAL_FLAGS = new Set(["token", "github-token", "gh-token", "jira-token", "api-token", "jira-api-token", "jira-email", "email", "password"]);

/** The label every exported issue carries. A later export lists the issues with it and reads their markers. */
export const MARKER_LABEL = "scenescout";
const DEFAULT_MAX_ISSUES = 20;
const MAX_ISSUES_BOUNDS = [1, 100] as const;
const DEFAULT_JIRA_ISSUE_TYPE = "Bug";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
/** What a severity becomes: a label on GitHub, a priority in Jira. `--severity-map` replaces any of them. */
export const DEFAULT_SEVERITY_MAP: Record<Tracker, Record<Severity, string>> = {
  github: { high: "severity: high", medium: "severity: medium", low: "severity: low" },
  jira: { high: "High", medium: "Medium", low: "Low" },
};
/**
 * Exit 0: the export did what it set out to, filing up to the cap (anything
 * over it waits for the next export) or, on a dry run, listing. Exit 2: it
 * could not finish, or a screenshot could not be attached to an issue it filed.
 */
export const EXIT_EXPORT = { done: 0, couldNotExport: 2 } as const;

/** A finding id that can sit in a marker and be read back out of one. Ids are short hashes; anything else is not exported. */
const FINDING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ONLY = 200;
const MAX_LABELS = 10;
/** GitHub's own limit on a label's name, used for Jira labels and priorities too. */
const MAX_LABEL_LENGTH = 50;

/** Where a GitHub export files: the repository, and the API it is reached through. */
export interface GithubTarget {
  repo: string;
  apiUrl: string;
}
/** Where a Jira export files. */
export interface JiraTarget {
  baseUrl: string;
  projectKey: string;
  issueType: string;
}
/** The tracker an export files into, with exactly that tracker's settings. */
export type ExportTarget = { to: "github"; github: GithubTarget } | { to: "jira"; jira: JiraTarget };

export type ExportOptions = ExportTarget & {
  projectDir: string;
  minSeverity: Severity;
  /** Only these finding ids; absent means every finding the other filters let through. */
  only?: string[];
  maxIssues: number;
  /** A severity's label (GitHub) or priority (Jira); null sets none. */
  severityMap: Record<Severity, string | null>;
  /** Labels added to every issue, beside the marker label. */
  labels: string[];
  screenshots: boolean;
  includeClosed: boolean;
  includeWorthALook: boolean;
  /** True unless `--yes` was given: a dry run lists what would be filed and files nothing. */
  dryRun: boolean;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type ParsedExport = { ok: true; options: ExportOptions } | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * An address a credential may be sent to: https, or plain http only to this
 * machine; no user or password in it, since the credential comes from the
 * environment; and no query or fragment, since paths are joined onto it.
 */
export function checkTrackerUrl(raw: string, name: string): Parsed<string> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: `${name} is not a URL: ${oneLine(raw, 120)}` };
  }
  if (u.username || u.password) return { ok: false, error: `${name} must carry no credentials: they are read from the environment` };
  if (u.search || u.hash) return { ok: false, error: `${name} must have no query or fragment` };
  const secure = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
  if (!secure) return { ok: false, error: `${name} must be https (plain http only to 127.0.0.1 or localhost): a credential is sent to it` };
  return { ok: true, value: u.toString().replace(/\/+$/, "") };
}

/** The text of a name or label: one line, no control characters, within a length. */
function plainName(raw: string, what: string, max: number): Parsed<string> {
  const value = raw.trim();
  if (!value) return { ok: false, error: `${what} is empty` };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return { ok: false, error: `${what} has a control character` };
  if (value.length > max) return { ok: false, error: `${what} is longer than ${max} characters` };
  return { ok: true, value };
}

/**
 * `--severity-map high=P1,medium=P2,low=P3`. A severity left out keeps its
 * default; one given an empty name (`low=`) gets no label or priority; `none`
 * maps no severity at all.
 */
function parseSeverityMap(raw: string | undefined, to: Tracker): Parsed<Record<Severity, string | null>> {
  const map: Record<Severity, string | null> = { ...DEFAULT_SEVERITY_MAP[to] };
  if (raw === undefined) return { ok: true, value: map };
  if (raw.trim() === "none") return { ok: true, value: { high: null, medium: null, low: null } };
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return { ok: false, error: "--severity-map takes severity=name pairs, e.g. high=P1,medium=P2,low=P3, or none" };
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!(SEVERITIES as readonly string[]).includes(key)) return { ok: false, error: `--severity-map: ${oneLine(key, 40)} is not high, medium or low` };
    if (seen.has(key)) return { ok: false, error: `--severity-map names ${key} twice` };
    seen.add(key);
    const name = part.slice(eq + 1);
    if (name.trim() === "") {
      map[key as Severity] = null;
      continue;
    }
    const checked = plainName(name, `--severity-map's name for ${key}`, MAX_LABEL_LENGTH);
    if (!checked.ok) return checked;
    map[key as Severity] = checked.value;
  }
  return { ok: true, value: map };
}

/** `--labels a,b`: at most ten, each a valid label for the tracker. Jira labels cannot hold a space. */
function parseLabels(raw: string | undefined, to: Tracker): Parsed<string[]> {
  if (raw === undefined) return { ok: true, value: [] };
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const checked = plainName(part, "a --labels label", MAX_LABEL_LENGTH);
    if (!checked.ok) return checked;
    if (to === "jira" && /\s/.test(checked.value)) return { ok: false, error: `Jira labels cannot contain spaces: ${oneLine(checked.value, 60)}` };
    if (checked.value.toLowerCase() === MARKER_LABEL || out.some((l) => l.toLowerCase() === checked.value.toLowerCase())) continue;
    out.push(checked.value);
  }
  if (out.length > MAX_LABELS) return { ok: false, error: `--labels takes at most ${MAX_LABELS} labels` };
  return { ok: true, value: out };
}

export function parseExportArgs(args: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>): ParsedExport {
  const known = new Set<string>(EXPORT_OPTION_NAMES);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) return { ok: false, error: `unexpected argument ${a}: export takes options only (the findings come from --project)` };
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (CREDENTIAL_FLAGS.has(name))
      return {
        ok: false,
        error: `there is no --${name}: credentials are read from the environment only (GH_TOKEN or GITHUB_TOKEN for GitHub; JIRA_EMAIL and JIRA_API_TOKEN for Jira)`,
      };
    if (!known.has(name)) return { ok: false, error: `unknown option --${name}` };
    if (flags.has(name)) return { ok: false, error: `--${name} is given twice` };
    if (SWITCHES.has(name)) {
      if (eq > 0) return { ok: false, error: `--${name} takes no value` };
      flags.set(name, "true");
      continue;
    }
    const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
    if (eq < 0) i += 1;
    flags.set(name, value);
  }

  const to = flags.get("to");
  if (to === undefined) return { ok: false, error: "say where the issues go: --to github or --to jira" };
  if (!(TRACKERS as readonly string[]).includes(to)) return { ok: false, error: `--to must be one of ${TRACKERS.join(", ")}` };
  const tracker = to as Tracker;
  const otherTrackers: Record<Tracker, string[]> = { github: ["jira-url", "jira-project", "jira-issue-type"], jira: ["repo"] };
  for (const name of otherTrackers[tracker]) if (flags.has(name)) return { ok: false, error: `--${name} is not an option of --to ${tracker}` };

  let target: ExportTarget;
  if (tracker === "github") {
    const repo = flags.get("repo");
    if (repo === undefined) return { ok: false, error: "--to github needs --repo owner/name" };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((part) => /^\.+$/.test(part)))
      return { ok: false, error: `--repo is not owner/name: ${oneLine(repo, 120)}` };
    const apiUrl = checkTrackerUrl(env.GITHUB_API_URL?.trim() || DEFAULT_GITHUB_API_URL, "GITHUB_API_URL");
    if (!apiUrl.ok) return apiUrl;
    target = { to: "github", github: { repo, apiUrl: apiUrl.value } };
  } else {
    const rawUrl = flags.get("jira-url") ?? env.JIRA_BASE_URL?.trim();
    if (!rawUrl) return { ok: false, error: "--to jira needs the site's address: --jira-url https://your-site.atlassian.net, or JIRA_BASE_URL" };
    const baseUrl = checkTrackerUrl(rawUrl, flags.has("jira-url") ? "--jira-url" : "JIRA_BASE_URL");
    if (!baseUrl.ok) return baseUrl;
    const projectKey = (flags.get("jira-project") ?? env.JIRA_PROJECT_KEY ?? "").trim();
    if (!projectKey) return { ok: false, error: "--to jira needs a project key: --jira-project KEY, or JIRA_PROJECT_KEY" };
    if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(projectKey))
      return {
        ok: false,
        error: `the Jira project key is not a key (capital letters, digits and underscores, starting with a letter): ${oneLine(projectKey, 60)}`,
      };
    const issueType = plainName(flags.get("jira-issue-type") ?? env.JIRA_ISSUE_TYPE ?? DEFAULT_JIRA_ISSUE_TYPE, "the Jira issue type", 60);
    if (!issueType.ok) return issueType;
    target = { to: "jira", jira: { baseUrl: baseUrl.value, projectKey, issueType: issueType.value } };
  }

  const minSeverity = flags.get("min-severity") ?? "low";
  if (!(SEVERITIES as readonly string[]).includes(minSeverity)) return { ok: false, error: `--min-severity must be one of ${SEVERITIES.join(", ")}` };
  let only: string[] | undefined;
  if (flags.has("only")) {
    only = [
      ...new Set(
        flags
          .get("only")!
          .split(/[\s,]+/)
          .filter(Boolean),
      ),
    ];
    if (only.length === 0) return { ok: false, error: "--only needs finding ids, comma-separated" };
    if (only.length > MAX_ONLY) return { ok: false, error: `--only takes at most ${MAX_ONLY} ids` };
    const bad = only.find((id) => !FINDING_ID_RE.test(id));
    if (bad !== undefined) return { ok: false, error: `--only: ${oneLine(bad, 70)} is not a finding id` };
  }
  let maxIssues = DEFAULT_MAX_ISSUES;
  if (flags.has("max-issues")) {
    const n = Number(flags.get("max-issues"));
    const [lo, hi] = MAX_ISSUES_BOUNDS;
    if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false, error: `--max-issues must be a whole number from ${lo} to ${hi}` };
    maxIssues = n;
  }
  const severityMap = parseSeverityMap(flags.get("severity-map"), tracker);
  if (!severityMap.ok) return severityMap;
  const labels = parseLabels(flags.get("labels"), tracker);
  if (!labels.ok) return labels;
  const screenshots = flags.get("screenshots") ?? "on";
  if (screenshots !== "on" && screenshots !== "off") return { ok: false, error: "--screenshots must be on or off" };
  if (flags.has("dry-run") && flags.has("yes")) return { ok: false, error: "--dry-run and --yes contradict each other: give one" };

  const resolve = (p: string): string => (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : `${cwd.replace(/[\\/]$/, "")}/${p}`);
  return {
    ok: true,
    options: {
      ...target,
      projectDir: resolve(flags.get("project") ?? cwd),
      minSeverity: minSeverity as Severity,
      ...(only ? { only } : {}),
      maxIssues,
      severityMap: severityMap.value,
      labels: labels.value,
      screenshots: screenshots === "on",
      includeClosed: flags.has("include-closed"),
      includeWorthALook: flags.has("include-worth-a-look"),
      dryRun: !flags.has("yes"),
    },
  };
}

// ── credentials ─────────────────────────────────────────────────────────────

export type Credentials = { ok: true; headers: Record<string, string>; source: string } | { ok: false; error: string };

/** The tracker's credentials, from the environment and nowhere else. An error names the variables to set, never a value. */
export function trackerCredentials(to: Tracker, env: Readonly<Record<string, string | undefined>>): Credentials {
  if (to === "github") {
    const fromGh = env.GH_TOKEN?.trim();
    const token = fromGh || env.GITHUB_TOKEN?.trim();
    if (!token) return { ok: false, error: "no GitHub token: set GH_TOKEN or GITHUB_TOKEN to a token that can create issues in the repository" };
    return { ok: true, headers: { authorization: `Bearer ${token}` }, source: fromGh ? "GH_TOKEN" : "GITHUB_TOKEN" };
  }
  const email = env.JIRA_EMAIL?.trim();
  const token = env.JIRA_API_TOKEN?.trim();
  const missing = [email ? null : "JIRA_EMAIL", token ? null : "JIRA_API_TOKEN"].filter((n): n is string => n !== null);
  if (!email || !token) return { ok: false, error: `no Jira credentials: set JIRA_EMAIL and JIRA_API_TOKEN (missing: ${missing.join(", ")})` };
  return { ok: true, headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` }, source: "JIRA_EMAIL and JIRA_API_TOKEN" };
}

/**
 * Every string that must never be printed: each credential variable that is
 * set, whichever tracker the export is for and whether or not the set is
 * complete, and the encoded header Jira's would make. A credential pasted
 * into an option by mistake is redacted from the refusal too.
 */
export function credentialSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = [env.GH_TOKEN, env.GITHUB_TOKEN, env.JIRA_API_TOKEN].map((v) => v?.trim() ?? "").filter((v) => v.length > 0);
  const email = env.JIRA_EMAIL?.trim();
  const jiraToken = env.JIRA_API_TOKEN?.trim();
  if (email && jiraToken) values.push(Buffer.from(`${email}:${jiraToken}`).toString("base64"));
  return values;
}

// ── which findings ──────────────────────────────────────────────────────────

export interface Selection {
  /** What is exported, worst first, then by when it was last found, earliest first. */
  candidates: Finding[];
  counts: { open: number; resolved: number; worthALook: number; belowSeverity: number };
  /** Entries that are not a finding this version can export: their id where they have one, else their place in the list. */
  unreadable: string[];
  /** `--only` ids that name no finding in the project. */
  unknownOnly: string[];
  /** `--only` ids that name a finding another filter left out, each with why. */
  leftOut: Array<{ id: string; reason: string }>;
}

/** The findings an export files, from memory.json as read: open defects at or above the minimum severity. */
export function selectFindings(memory: unknown, o: Pick<ExportOptions, "minSeverity" | "only" | "includeWorthALook">): Selection {
  const listed = memory && typeof memory === "object" ? (memory as { findings?: unknown }).findings : undefined;
  const all = readFindings(memory).filter((f) => FINDING_ID_RE.test(f.id));
  const readable = new Set<unknown>(all);
  const unreadable = (Array.isArray(listed) ? listed : []).flatMap((entry, i) =>
    readable.has(entry)
      ? []
      : [entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? oneLine((entry as { id: string }).id, 70) : `#${i + 1}`],
  );
  const counts = { open: 0, resolved: 0, worthALook: 0, belowSeverity: 0 };
  const only = o.only ? new Set(o.only) : null;
  const leftOut: Selection["leftOut"] = [];
  const candidates: Finding[] = [];
  for (const f of all) {
    const named = only?.has(f.id) ?? false;
    if (only && !named) continue;
    let reason: string | null = null;
    if (f.status === "resolved") {
      counts.resolved++;
      reason = "resolved";
    } else {
      counts.open++;
      if (isWorthALook(f) && !o.includeWorthALook) {
        counts.worthALook++;
        reason = "worth a look (add --include-worth-a-look)";
      } else if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[o.minSeverity]) {
        counts.belowSeverity++;
        reason = `below --min-severity ${o.minSeverity}`;
      }
    }
    if (reason === null) candidates.push(f);
    else if (named) leftOut.push({ id: f.id, reason });
  }
  candidates.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || timeOf(a.foundAt) - timeOf(b.foundAt) || a.id.localeCompare(b.id));
  const ids = new Set(all.map((f) => f.id));
  return { candidates, counts, unreadable, unknownOnly: (o.only ?? []).filter((id) => !ids.has(id)), leftOut };
}

function timeOf(iso: unknown): number {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// ── the marker ──────────────────────────────────────────────────────────────

/** The first line of a GitHub issue's body: an HTML comment, so it is not shown. */
export function githubMarker(id: string): string {
  return `<!-- scenescout-finding: ${id} -->`;
}

/** The finding ids a GitHub issue's body carries markers for. Escaped text never matches: its `<` is `&lt;`. */
export function findingIdsInGithubBody(body: unknown): string[] {
  if (typeof body !== "string") return [];
  return [...body.matchAll(/<!-- scenescout-finding: ([A-Za-z0-9_-]{1,64}) -->/g)].map((m) => m[1]);
}

/** A Jira description cannot hide text, so the marker is a last, short line. */
function jiraMarkerText(id: string): string {
  return `scenescout-finding: ${id}`;
}

/**
 * The finding ids a Jira description (Atlassian Document Format, as the API
 * returns it) carries markers for. Model-written text has the marker's word
 * broken by a zero-width space, so only a marker this export wrote, or one a
 * person copied in on purpose, is read.
 */
export function findingIdsInJiraDescription(description: unknown): string[] {
  if (description === null || description === undefined) return [];
  const text = typeof description === "string" ? description : JSON.stringify(description);
  return [...text.matchAll(/scenescout-finding: ([A-Za-z0-9_-]{1,64})/g)].map((m) => m[1]);
}

// ── inert text ──────────────────────────────────────────────────────────────

/** One line: control, bidirectional-override and line-break characters become spaces; runs of space collapse; at most `max`. */
export function oneLine(text: unknown, max: number): string {
  let s = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/**
 * Zero-width spaces where a tracker would otherwise act on text: after `@`
 * (a mention, an email autolink), inside `://` and `www.` (a link), between
 * `#` or `GH-` and a number (a cross-reference), and inside the marker's word
 * (so quoted text cannot claim to be another finding's issue).
 */
function breakTriggers(s: string): string {
  return s
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":\u200b//")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\u200b.`)
    .replace(/#(?=\d)/g, "#\u200b")
    .replace(/\bgh-(?=\d)/gi, (m) => `${m.slice(0, 2)}\u200b-`)
    .replace(/scenescout-finding/gi, (m) => `${m.slice(0, 10)}\u200b${m.slice(10)}`);
}

/**
 * Text for a GitHub Markdown body: one line, HTML-escaped, every Markdown
 * punctuation mark backslash-escaped, and every trigger broken. The escaping
 * of the `/scenescout qa` reply (action/qa-action.mjs `inert`), which
 * export-test holds it to, plus `$` (GitHub renders `$…$` as maths), the
 * cross-reference and marker breaks, and no bidirectional or C1 control
 * characters.
 */
export function inertMarkdown(text: unknown, max = 160): string {
  return breakTriggers(
    oneLine(text, max)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/([\\`*_{}[\]()#+!|~$])/g, "\\$1"),
  );
}

/** Text a tracker shows as it is (an issue title, a Jira text node): one line, every trigger broken, nothing escaped. */
export function inertPlain(text: unknown, max = 160): string {
  return breakTriggers(oneLine(text, max));
}

// ── what an issue says ──────────────────────────────────────────────────────

const MAX_TITLE = 200;
const MAX_DETAIL = 4000;
const MAX_STEP = 300;
const MAX_STEPS = 20;
const MAX_EVIDENCE = 2000;

export interface IssueContext {
  /** The severity's label (GitHub) or priority (Jira), or null for none. */
  severityName: string | null;
  /** Labels beside the marker label. */
  labels: readonly string[];
  /** "off" leaves screenshots out; otherwise the frames kept for this finding, relative to `.scenescout/` (may be empty). */
  screenshots: "off" | readonly string[];
  /** Frames the run logged for this finding that were left out: missing, too large, or rewritten since. */
  framesLeftOut?: number;
}

/** A finding's fields as they are rendered: redacted again on the way out, and of the right type whatever the file held. */
function fieldsOf(f: Finding) {
  const text = (v: unknown): string => redactSecrets(typeof v === "string" ? v : "");
  const url = text(f.url);
  const route = redactSecrets(typeof f.state === "string" && f.state ? f.state.split("#")[0] : pathOf(url));
  return {
    title: text(f.title),
    detail: text(f.detail),
    evidence: text(f.evidence),
    url,
    route,
    category: typeof f.category === "string" && f.category ? redactSecrets(f.category) : "other",
    repro: (Array.isArray(f.repro) ? f.repro : []).filter((s): s is string => typeof s === "string").map((s) => redactSecrets(s)),
    runs: Number.isInteger(f.runs) && f.runs > 0 ? f.runs : 1,
    foundAt: dateOf(f.foundAt),
    regressedAt: f.regressedAt ? dateOf(f.regressedAt) : null,
    verdict: f.verdict && ["gone", "present", "changed"].includes(f.verdict) ? `${f.verdict}${f.verifiedAt ? ` (${dateOf(f.verifiedAt)})` : ""}` : null,
    convention: isWorthALook(f) ? text(f.convention) || "a convention of the project" : null,
  };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function dateOf(iso: unknown): string {
  const t = timeOf(iso);
  return t ? new Date(t).toISOString().slice(0, 10) : "unknown";
}

function frameName(rel: string): string {
  return rel.split("/").pop() || rel;
}

/** Why an issue has no screenshots: the run recorded none, or the ones it recorded are gone. */
function noFramesSentence(ctx: Pick<IssueContext, "framesLeftOut">): string {
  return ctx.framesLeftOut
    ? "None: the run's frames of these steps are missing, too large, or were rewritten by a later run."
    : "None: only a recorded run keeps a frame of each step (scout_attach with record: true).";
}

/** The issue's title, as both trackers take it. Both refuse one past 255 characters, which the breaks could otherwise reach. */
function issueTitle(f: Finding): string {
  const title = inertPlain(fieldsOf(f).title, MAX_TITLE);
  return (title.length > 250 ? `${title.slice(0, 249)}…` : title) || "SceneScout finding";
}

/** Every label an issue carries: the marker label first, then the severity's, then the extras, with no repeats. */
function issueLabels(ctx: Pick<IssueContext, "severityName" | "labels">): string[] {
  const out: string[] = [];
  for (const l of [MARKER_LABEL, ...(ctx.severityName ? [ctx.severityName] : []), ...ctx.labels])
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  return out;
}

/** A GitHub issue for a finding: its title, a Markdown body whose first line is the hidden marker, and its labels. */
export function githubIssue(f: Finding, ctx: IssueContext): { title: string; body: string; labels: string[] } {
  const x = fieldsOf(f);
  const rows: Array<[string, string]> = [
    ["Severity", f.severity],
    ["Category", inertMarkdown(x.category, 40)],
    ["Page", inertMarkdown(x.route, 200)],
    ["Address", inertMarkdown(x.url, 300)],
    ["Last found", x.foundAt],
    ["Runs that found it", String(x.runs)],
  ];
  if (x.regressedAt) rows.push(["Regressed", `${x.regressedAt}: it had been marked resolved`]);
  if (x.verdict) rows.push(["Last re-test", inertMarkdown(x.verdict, 60)]);
  if (x.convention !== null) rows.push(["Tier", `worth a look: a defect only if the project uses ${inertMarkdown(x.convention, 200)}`]);
  const steps = x.repro.slice(-MAX_STEPS);
  const lines = [
    githubMarker(f.id),
    "",
    `> ${inertMarkdown(x.detail || x.title, MAX_DETAIL)}`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "### Steps to reproduce",
    "",
    ...(steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${inertMarkdown(s, MAX_STEP)}`) : ["No steps were recorded with this finding."]),
    "",
    "### Evidence",
    "",
    x.evidence ? inertMarkdown(x.evidence, MAX_EVIDENCE) : "No machine evidence was recorded with this finding.",
    "",
  ];
  if (ctx.screenshots !== "off") {
    lines.push("### Screenshots", "");
    if (ctx.screenshots.length === 0) lines.push(noFramesSentence(ctx));
    else
      lines.push(
        "Not attached: GitHub's API cannot upload a file to an issue. The run kept these frames of the steps before it was last found, in its `.scenescout/` folder:",
        "",
        ...ctx.screenshots.map((s) => `- ${inertMarkdown(s, 200)}`),
      );
    lines.push("");
  }
  lines.push(
    "---",
    `Filed by SceneScout from finding \`${f.id}\`. A later \`scenescout export\` finds this issue by its \`${MARKER_LABEL}\` label and the hidden marker in this description, and does not file it again.`,
    "",
  );
  return { title: issueTitle(f), body: lines.join("\n"), labels: issueLabels(ctx) };
}

type AdfNode = Record<string, unknown>;
/** A text node; ADF refuses an empty one, so empty text becomes a dash. */
const text = (t: string, marks?: AdfNode[]): AdfNode => ({ type: "text", text: t || "-", ...(marks ? { marks } : {}) });
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const heading = (t: string): AdfNode => ({ type: "heading", attrs: { level: 3 }, content: [text(t)] });
const listItems = (items: string[]): AdfNode[] => items.map((t) => ({ type: "listItem", content: [paragraph(text(t))] }));

/** The description of a Jira issue for a finding, in Atlassian Document Format. Every text node holds plain text, so nothing in it is markup. */
export function jiraDescription(f: Finding, ctx: Pick<IssueContext, "screenshots" | "framesLeftOut">): AdfNode {
  const x = fieldsOf(f);
  const facts = [
    `Severity: ${f.severity}`,
    `Category: ${inertPlain(x.category, 40)}`,
    `Page: ${inertPlain(x.route, 200)}`,
    `Address: ${inertPlain(x.url, 300)}`,
    `Last found: ${x.foundAt}`,
    `Runs that found it: ${x.runs}`,
    ...(x.regressedAt ? [`Regressed: ${x.regressedAt}: it had been marked resolved`] : []),
    ...(x.verdict ? [`Last re-test: ${inertPlain(x.verdict, 60)}`] : []),
    ...(x.convention !== null ? [`Tier: worth a look: a defect only if the project uses ${inertPlain(x.convention, 200)}`] : []),
  ];
  const steps = x.repro.slice(-MAX_STEPS).map((s) => inertPlain(s, MAX_STEP));
  const content: AdfNode[] = [
    paragraph(text(inertPlain(x.detail || x.title, MAX_DETAIL))),
    { type: "bulletList", content: listItems(facts) },
    heading("Steps to reproduce"),
    steps.length > 0 ? { type: "orderedList", content: listItems(steps) } : paragraph(text("No steps were recorded with this finding.")),
    heading("Evidence"),
    x.evidence
      ? { type: "codeBlock", content: [text(inertPlain(x.evidence, MAX_EVIDENCE))] }
      : paragraph(text("No machine evidence was recorded with this finding.")),
  ];
  if (ctx.screenshots !== "off") {
    content.push(heading("Screenshots"));
    content.push(
      paragraph(
        text(
          ctx.screenshots.length === 0
            ? noFramesSentence(ctx)
            : `Attached: ${ctx.screenshots.map((s) => inertPlain(frameName(s), 100)).join(", ")}, the frames of the steps before it was last found.`,
        ),
      ),
    );
  }
  content.push(
    { type: "rule" },
    paragraph(text("Filed by SceneScout. A later export finds this issue by this line: "), text(jiraMarkerText(f.id), [{ type: "code" }])),
  );
  return { type: "doc", version: 1, content };
}

/** The fields of a Jira issue for a finding. */
export function jiraIssueFields(f: Finding, ctx: IssueContext & { projectKey: string; issueType: string }): Record<string, unknown> {
  return {
    project: { key: ctx.projectKey },
    issuetype: { name: ctx.issueType },
    summary: issueTitle(f),
    description: jiraDescription(f, ctx),
    labels: issueLabels({ severityName: null, labels: ctx.labels }),
    ...(ctx.severityName ? { priority: { name: ctx.severityName } } : {}),
  };
}

// ── screenshots ─────────────────────────────────────────────────────────────

/** Most frames one issue names or attaches: the steps right before the finding was last found. */
const MAX_SCREENSHOTS = 3;
/** Frames older than this before a finding's time belong to some earlier step of the run, not to the finding. */
const FRAME_WINDOW_MS = 10 * 60_000;
/** How far a frame file's modification time may be from its step's time and still be that step's picture. */
const FRAME_MTIME_SLACK_MS = 2 * 60_000;

/**
 * The frames kept for a finding: from the session that filed it, the last few
 * steps before it was last found (`foundAt` moves each time a run finds it
 * again), within a window. A finding with no session names none, since
 * another session's frame would be another page.
 */
export function framesFor(
  f: Pick<Finding, "session" | "foundAt">,
  log: ReadonlyArray<Pick<ActionLogEntry, "at" | "session" | "frame">>,
  most = MAX_SCREENSHOTS,
): Array<{ frame: string; at: string }> {
  const found = timeOf(f.foundAt);
  if (!f.session || !found) return [];
  return log
    .filter((e) => typeof e.frame === "string" && e.frame !== "" && e.session === f.session)
    .map((e) => ({ frame: e.frame as string, at: e.at, t: timeOf(e.at) }))
    .filter((e) => e.t > 0 && e.t <= found && found - e.t <= FRAME_WINDOW_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-most)
    .map(({ frame, at }) => ({ frame, at }));
}

/** Whether a frame file is still the picture written at its step: a later run reusing the session's name rewrites the same file names. */
export function frameIsOriginal(stepAt: string, mtimeMs: number): boolean {
  const t = timeOf(stepAt);
  return t > 0 && Math.abs(mtimeMs - t) <= FRAME_MTIME_SLACK_MS;
}

// ── the plan ────────────────────────────────────────────────────────────────

/** An issue a tracker already holds for a finding. */
export interface FiledIssue {
  /** `#12` on GitHub, `KEY-12` in Jira. */
  ref: string;
  /** The issue's number: 12 for both of those. Earlier issues have lower numbers. */
  number: number;
  url: string;
  open: boolean;
}

export type PlanEntry =
  { finding: Finding; outcome: "file" } | { finding: Finding; outcome: "already-filed"; issue: FiledIssue } | { finding: Finding; outcome: "over-cap" };

/**
 * What one export does with each candidate: skip what the tracker already
 * holds, file the rest up to the cap, and leave what is over the cap for the
 * next export, which files it because these are skipped by then. `existing`
 * null means the tracker was not asked (a dry run with no credentials).
 */
export function planExport(candidates: readonly Finding[], existing: ReadonlyMap<string, FiledIssue> | null, cap: number): PlanEntry[] {
  let toFile = 0;
  return candidates.map((finding): PlanEntry => {
    const issue = existing?.get(finding.id);
    if (issue) return { finding, outcome: "already-filed", issue };
    if (toFile >= cap) return { finding, outcome: "over-cap" };
    toFile++;
    return { finding, outcome: "file" };
  });
}

/**
 * Fold another issue into what is already filed for a finding. An open issue
 * wins over a closed one, then the earlier one, so a finding filed twice by
 * hand still reads as filed once.
 */
export function rememberFiled(map: Map<string, FiledIssue>, id: string, issue: FiledIssue): void {
  const held = map.get(id);
  if (!held || (issue.open && !held.open) || (issue.open === held.open && issue.number < held.number)) map.set(id, issue);
}

// ── talking to a tracker ────────────────────────────────────────────────────

/** The longest a rate limit may ask an export to wait before it gives up and says when to try again. */
export const MAX_RATE_WAIT_MS = 60_000;

/** How long GitHub asks a client to wait after a secondary rate limit that names no time. */
const SECONDARY_LIMIT_WAIT_MS = 60_000;

/**
 * Whether a response is a rate limit, and how long it asks to wait: 429
 * always is; a 403 only when it says so, by `retry-after`, by
 * `x-ratelimit-remaining: 0` (GitHub's primary limit) or by its message
 * (GitHub's secondary limit, which may send neither header and then asks for
 * a minute). Any other 403 is a permission the token lacks. `waitMs` null:
 * no wait was named.
 */
export function rateLimit(
  status: number,
  header: (name: string) => string | null,
  nowMs: number,
  message = "",
): { limited: false } | { limited: true; waitMs: number | null } {
  if (status !== 429 && status !== 403) return { limited: false };
  const named = retryAfterMs(header("retry-after")?.trim(), nowMs);
  if (named !== undefined) return { limited: true, waitMs: named };
  if (header("x-ratelimit-remaining")?.trim() === "0") {
    const reset = Number(header("x-ratelimit-reset"));
    return { limited: true, waitMs: Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - nowMs) : null };
  }
  if (status === 403 && /rate limit/i.test(message)) return { limited: true, waitMs: SECONDARY_LIMIT_WAIT_MS };
  return status === 429 ? { limited: true, waitMs: null } : { limited: false };
}

/** What a tracker said when it refused a request, as one short line: GitHub's `message` and `errors`, Jira's `errorMessages` and `errors`. */
export function trackerMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof b.message === "string") parts.push(b.message);
  if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages.filter((m): m is string => typeof m === "string"));
  if (Array.isArray(b.errors))
    for (const e of b.errors) {
      if (typeof e === "string") parts.push(e);
      else if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        const said = [o.field, o.message ?? o.code].filter((v) => typeof v === "string").join(": ");
        if (said) parts.push(said);
      }
    }
  else if (b.errors && typeof b.errors === "object")
    for (const [field, message] of Object.entries(b.errors as Record<string, unknown>)) if (typeof message === "string") parts.push(`${field}: ${message}`);
  return oneLine(parts.join("; "), 300);
}

/** A line about a finding for the terminal: its severity, its title (no control characters, so no terminal escapes) and its id. */
export function findingLine(f: Finding): string {
  return `${f.severity.padEnd(6)}  ${oneLine(redactSecrets(f.title), 100)}  [finding ${f.id}]`;
}
