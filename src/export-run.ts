/**
 * Runs `scenescout export`: reads the project's findings (or a check.json or
 * ci.json given with --from), asks the tracker which of them it already
 * holds, and files the rest. The rules (which
 * findings, what an issue says, the marker, the plan) live in
 * engine/export.ts; this file only reads the project's files and talks HTTP.
 * The one file it writes is the record of the issues it filed, beside the
 * memory, and the credentials it sends are never printed: every line goes out
 * through a redactor that knows them.
 */
import fs from "node:fs";
import path from "node:path";
import { redactKeys } from "./engine/ci.js";
import {
  credentialSecrets,
  EXIT_EXPORT,
  failedCriteriaByFinding,
  findingIdsInGithubBody,
  findingIdsInJiraDescription,
  findingLine,
  findingPicture,
  frameIsOriginal,
  framesFor,
  githubIssue,
  jiraEditFields,
  jiraIssueFields,
  MARKER_LABEL,
  MAX_RATE_WAIT_MS,
  oneLine,
  parseExportRecord,
  planExport,
  planJiraUpdate,
  rateLimit,
  recordKey,
  recordWith,
  rememberFiled,
  selectFindings,
  findingsFromResult,
  type ResultSource,
  ticketsToLink,
  trackerCredentials,
  trackerMessage,
  TRACKER_LABEL,
  uncertainHolds,
  uploadName,
  EXPORT_RECORD_FILE,
  UNCERTAIN_HOLD_MS,
  type ExportOptions,
  type ExportRecord,
  type FailedCriterion,
  type FiledIssue,
  type GithubTarget,
  type JiraTarget,
  type JiraUpdatePlan,
  type IssueContext,
  type PlanEntry,
} from "./engine/export.js";
import { MEMORY_DIRNAME, type ActionLogEntry, type Finding } from "./engine/memory.js";
import { backoffMs } from "./engine/provider.js";
import { resolveFrame } from "./engine/replay.js";

/**
 * A failure that ends the export. `uncertain`: the tracker may have acted on
 * the request before it failed (a create that timed out or got a 5xx), so
 * whether the issue exists has to be asked again rather than assumed.
 */
export class ExportError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

export interface ExportDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Progress and the plan. */
  log: (line: string) => void;
  /** What went wrong. Defaults to `log`. */
  error?: (line: string) => void;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  /** The pause between two creates. GitHub asks for a second between requests that create content. */
  pauseMs?: number;
  /** How long one request may take. */
  timeoutMs?: number;
  /** How many times a request is sent again after a failure that allows it. */
  retries?: number;
  now?: () => number;
  random?: () => number;
}

export interface ExportOutcome {
  exitCode: number;
  plan: PlanEntry[];
  /** The issues this export created, in order. */
  filed: Array<{ id: string; issue: FiledIssue }>;
  /** The issues filed earlier that this export changed: a rewritten description, a file attached or a ticket linked. */
  updated: Array<{ id: string; issue: FiledIssue }>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
/** Pages of 100 issues read to find what is already filed. More than this and an export refuses rather than file blind. */
const MAX_PAGES = 50;
/** A frame larger than this is not uploaded: a recorded frame is a JPEG of a page, far smaller. */
const MAX_FRAME_BYTES = 10_000_000;

// ── HTTP ────────────────────────────────────────────────────────────────────

interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  /** Joined to the base address; starts with `/`. */
  path: string;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /**
   * Whether sending it again after a failure the tracker may have acted on is
   * harmless: a read, or an upload whose repeat only repeats a picture. A
   * create is not; its failures are settled by asking for the marker again.
   */
  idempotent: boolean;
  /** Answer null, rather than fail, when the thing is not there: a 404, a 410, or a redirect to where it moved. */
  missingOk?: boolean;
}
type Send = (r: HttpRequest) => Promise<unknown>;

interface Http {
  fetchImpl: typeof fetch;
  wait: (ms: number) => Promise<void>;
  timeoutMs: number;
  retries: number;
  now: () => number;
  random: () => number;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: an HTML error page from a proxy, say. The text is still what the message quotes.
    return { message: text.slice(0, 300) };
  }
}

const REFUSAL_HINT: Record<number, string> = {
  400: " (a field was refused: in Jira, check --jira-issue-type and the --severity-map priorities)",
  401: " (the credentials were not accepted)",
  403: " (the credentials lack a permission this needs)",
  404: " (no such repository or project, or the credentials cannot see it)",
  410: " (issues are turned off for this repository)",
};

/** Why a request got no usable answer, as one line: Node's fetch says only "fetch failed" and keeps the reason in `cause`. */
function failureOf(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === "TimeoutError") return `no answer within ${timeoutMs / 1000} s`;
  if (!(err instanceof Error)) return oneLine(err, 200);
  const cause = err.cause instanceof Error ? err.cause : null;
  const code = cause && typeof (cause as NodeJS.ErrnoException).code === "string" ? `${(cause as NodeJS.ErrnoException).code} ` : "";
  return oneLine(cause ? `${err.message}: ${code}${cause.message}` : err.message, 300);
}

/**
 * One tracker's requests: its base address, its credentials, a timeout on
 * every request (reading the answer included), no redirect followed (the
 * credentials would go with it), a rate limit waited out when it asks for a
 * minute or less, and a 5xx, a dropped connection or an answer cut off
 * retried with backoff when the request is safe to send twice. When it is
 * not, the failure is marked uncertain: the tracker may have acted on it.
 */
function client(base: string, headers: Record<string, string>, h: Http): Send {
  return async (r) => {
    const what = `${r.method} ${r.path.split("?")[0]}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let body: unknown;
      try {
        res = await h.fetchImpl(`${base}${r.path}`, {
          method: r.method,
          headers: { accept: "application/json", ...headers, ...(r.json !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
          body: r.json !== undefined ? JSON.stringify(r.json) : r.form,
          redirect: "manual",
          signal: AbortSignal.timeout(h.timeoutMs),
        });
        body = await readBody(res);
      } catch (err) {
        if (r.idempotent && attempt < h.retries) {
          await h.wait(backoffMs(attempt + 1, h.random));
          continue;
        }
        throw new ExportError(`${what} failed: ${failureOf(err, h.timeoutMs)}`, !r.idempotent);
      }
      if (r.missingOk && (res.status === 404 || res.status === 410 || (res.status >= 300 && res.status < 400))) return null;
      if (res.status >= 300 && res.status < 400)
        throw new ExportError(
          `${what} was answered with a redirect (HTTP ${res.status}), which is refused: credentials are never sent on to another address. A repository or site that moved needs its new address`,
        );
      const said = trackerMessage(body);
      const limit = rateLimit(res.status, (name) => res.headers.get(name), h.now(), said);
      if (limit.limited) {
        const waitMs = limit.waitMs ?? backoffMs(attempt + 1, h.random);
        if (waitMs > MAX_RATE_WAIT_MS)
          throw new ExportError(`${what} hit the tracker's rate limit, which asks to wait ${Math.ceil(waitMs / 1000)} s; export again after that`);
        if (attempt >= h.retries) throw new ExportError(`${what} hit the tracker's rate limit ${attempt + 1} times; export again later`);
        await h.wait(waitMs);
        continue;
      }
      if (res.status >= 500) {
        if (r.idempotent && attempt < h.retries) {
          await h.wait(backoffMs(attempt + 1, h.random));
          continue;
        }
        throw new ExportError(`${what} failed: HTTP ${res.status}${said ? `: ${said}` : ""}`, !r.idempotent);
      }
      if (!res.ok) throw new ExportError(`${what} was refused: HTTP ${res.status}${REFUSAL_HINT[res.status] ?? ""}${said ? `: ${said}` : ""}`);
      return body;
    }
  };
}

// ── the trackers ────────────────────────────────────────────────────────────

interface Frame {
  /** Relative to `.scenescout/`, as the session log or the finding names it. */
  rel: string;
  file: string;
  /** When it was taken: the step's time, or the picture's. */
  at?: string;
  /** The name Jira gets it under (uploadName). */
  upload: string;
}

/** What an update did, and what it could not do. */
interface Updated {
  rewrote: boolean;
  attached: string[];
  linked: string[];
  problems: string[];
}

/** What goes onto a Jira issue beside its fields: the finding's picture first, then the frames, and the tickets to link it to. */
interface Extras {
  files: readonly Frame[];
  tickets: readonly string[];
}

interface Created {
  issue: FiledIssue;
  /** Screenshots that could not be attached. */
  problems: string[];
  /** Why no further issue may be filed, though this one was. */
  stop?: string;
}

interface Listing {
  /** Every finding id an issue carries a marker for, with that issue. */
  map: Map<string, FiledIssue>;
  /** How many issues with the label were read. */
  issues: number;
  /** Of those, how many carry no marker at all: labelled by hand, or edited since. */
  unmarked: number;
}

/** An issue read back by its number, and the findings its marker names. */
interface ReadBack {
  issue: FiledIssue;
  ids: string[];
}

interface TrackerApi {
  /** "GitHub owner/name", "Jira KEY". */
  label: string;
  /**
   * Whether an issue shows in `existing` as soon as it is created. GitHub's
   * label filter lags, but its newest issues, listed with no filter, do not,
   * and `existing` reads those too. Jira's search can take minutes, so a
   * create that may have been carried out is never re-sent to Jira.
   */
  consistentListing: boolean;
  /** The labelled issues and the findings their markers name: closed issues too, unless `includeClosed` is false. */
  existing(includeClosed: boolean): Promise<Listing>;
  /** One issue, read by its number, which shows it at once; null when it is gone or has moved. */
  read(ref: string, number: number): Promise<ReadBack | null>;
  create(f: Finding, ctx: IssueContext, extras: Extras): Promise<Created>;
  /** Bring an issue filed earlier up to date, as `plan` says. Jira only. */
  update?(f: Finding, ctx: IssueContext, issue: FiledIssue, plan: JiraUpdatePlan, extras: Extras): Promise<Updated>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function githubApi({ repo }: GithubTarget, send: Send): TrackerApi {
  const root = `/repos/${repo
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/")}/issues`;
  /** An issue as the API gives it, read; null for a pull request, which the issues API lists too. */
  const readIssue = (issue: unknown): (ReadBack & { labelled: boolean }) | null => {
    if (isRecord(issue) && issue.pull_request) return null;
    const number = isRecord(issue) ? Number(issue.number) : NaN;
    // An entry that cannot be read, or one without its body, could be a filed finding: guessing "not filed" files it twice.
    if (!isRecord(issue) || !Number.isInteger(number) || !("body" in issue))
      throw new ExportError("GitHub listed an issue without its number or its body, so which findings are filed cannot be told");
    const labels: unknown[] = Array.isArray(issue.labels) ? issue.labels : [];
    return {
      issue: { ref: `#${number}`, number, url: oneLine(issue.html_url, 300), open: issue.state !== "closed" },
      ids: findingIdsInGithubBody(issue.body),
      // GitHub's label filter ignores case, so a repository's "SceneScout" label is this one.
      labelled: labels.some((l) => (typeof l === "string" ? l : isRecord(l) ? String(l.name ?? "") : "").toLowerCase() === MARKER_LABEL),
    };
  };
  return {
    label: `GitHub ${repo}`,
    consistentListing: true,
    // Listed by label rather than found through the search API, which is
    // indexed with a delay. The label filter lags behind a create too, so the
    // newest issues are also listed with no filter, which shows an issue as
    // soon as it is made: an export run right after another, or the check
    // after a create that may have been made, finds the issue just filed.
    async existing(includeClosed) {
      const map = new Map<string, FiledIssue>();
      const seen = new Set<number>();
      let issues = 0;
      let unmarked = 0;
      const take = (read: ReadBack): void => {
        if (seen.has(read.issue.number)) return;
        seen.add(read.issue.number);
        issues++;
        if (read.ids.length === 0) unmarked++;
        for (const id of read.ids) rememberFiled(map, id, read.issue);
      };
      const state = includeClosed ? "all" : "open";
      const newest = await send({ method: "GET", path: `${root}?state=${state}&sort=created&direction=desc&per_page=100`, idempotent: true });
      if (!Array.isArray(newest)) throw new ExportError("GitHub's list of issues was not a list");
      for (const entry of newest) {
        const read = readIssue(entry);
        if (read?.labelled) take(read);
      }
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await send({
          method: "GET",
          path: `${root}?labels=${encodeURIComponent(MARKER_LABEL)}&state=${state}&per_page=100&page=${page}`,
          idempotent: true,
        });
        if (!Array.isArray(body)) throw new ExportError("GitHub's list of issues was not a list");
        for (const entry of body) {
          const read = readIssue(entry);
          if (read) take(read);
        }
        if (body.length < 100) return { map, issues, unmarked };
      }
      throw new ExportError(`${MAX_PAGES * 100} or more issues carry the ${MARKER_LABEL} label, too many to check them all for this export's findings`);
    },
    async read(_ref, number) {
      const body = await send({ method: "GET", path: `${root}/${number}`, idempotent: true, missingOk: true });
      if (body === null) return null;
      const read = readIssue(body);
      return read && read.issue.number === number ? { issue: read.issue, ids: read.ids } : null;
    },
    async create(f, ctx) {
      const body = await send({ method: "POST", path: root, json: githubIssue(f, ctx), idempotent: false });
      const number = isRecord(body) ? Number(body.number) : NaN;
      if (!isRecord(body) || !Number.isInteger(number)) throw new ExportError("GitHub answered the create without an issue number", true);
      const issue: FiledIssue = { ref: `#${number}`, number, url: oneLine(body.html_url, 300), open: true };
      // GitHub drops the labels of an issue created by an account that cannot set them, and says nothing.
      if (!readIssue({ body: null, ...body })?.labelled)
        return {
          issue,
          problems: [],
          stop: `GitHub filed ${issue.ref} without its ${MARKER_LABEL} label, so a later export could not find it. Stopping before filing more: GitHub drops the labels of an issue created by an account that may not set them, so give the token's account write access to the repository (and create the ${MARKER_LABEL} label if it has none), then add the label to ${issue.ref} by hand`,
        };
      return { issue, problems: [] };
    },
  };
}

function jiraApi({ baseUrl, projectKey, issueType, linkType }: JiraTarget, send: Send): TrackerApi {
  const keyNumber = (key: string): number | null => {
    const m = /^[A-Z][A-Z0-9_]*-(\d+)$/.exec(key);
    return m ? Number(m[1]) : null;
  };
  const issuePath = (key: string): string => `/rest/api/3/issue/${encodeURIComponent(key)}`;
  /** Attach each file; what could not be attached is returned, not thrown, since the issue itself stands. */
  const attach = async (key: string, files: readonly Frame[], again: string): Promise<{ done: string[]; problems: string[] }> => {
    const done: string[] = [];
    const problems: string[] = [];
    for (const frame of files) {
      const name = frame.upload;
      try {
        const form = new FormData();
        form.append("file", new Blob([fs.readFileSync(frame.file)], { type: name.endsWith(".png") ? "image/png" : "image/jpeg" }), name);
        await send({
          method: "POST",
          path: `${issuePath(key)}/attachments`,
          form,
          // Jira refuses an upload without it, as protection against cross-site requests.
          headers: { "x-atlassian-token": "no-check" },
          idempotent: true,
        });
        done.push(name);
      } catch (err) {
        problems.push(`${name} was not attached (${err instanceof Error ? err.message : String(err)}). It is at ${frame.file}; ${again}`);
      }
    }
    return { done, problems };
  };
  /**
   * Link the issue to each ticket whose criterion it fails, so the issue reads
   * as the subject of the link type's outward words ("blocks", "relates to")
   * and the ticket as their object. Jira's API gives those words to the issue
   * sent as `inwardIssue`, the reverse of what the field names suggest. Jira
   * answers a link that already exists as made, so sending one twice is harmless.
   */
  const link = async (key: string, tickets: readonly string[]): Promise<{ done: string[]; problems: string[] }> => {
    const done: string[] = [];
    const problems: string[] = [];
    if (!linkType) return { done, problems };
    for (const ticket of tickets) {
      try {
        await send({
          method: "POST",
          path: "/rest/api/3/issueLink",
          json: { type: { name: linkType }, inwardIssue: { key }, outwardIssue: { key: ticket } },
          idempotent: true,
        });
        done.push(ticket);
      } catch (err) {
        problems.push(
          `not linked to ${ticket} (${err instanceof Error ? err.message : String(err)}); check that ${ticket} is an issue on this site and that "${linkType}" is a link type it has (--jira-link-type), and a later export links it`,
        );
      }
    }
    return { done, problems };
  };
  const keysOf = (links: unknown): string[] =>
    (Array.isArray(links) ? links : []).flatMap((l) =>
      isRecord(l) ? [l.inwardIssue, l.outwardIssue].flatMap((i) => (isRecord(i) && typeof i.key === "string" ? [i.key] : [])) : [],
    );
  const namesOf = (attachments: unknown): string[] =>
    (Array.isArray(attachments) ? attachments : []).flatMap((a) => (isRecord(a) && typeof a.filename === "string" ? [a.filename] : []));
  const FIELDS = ["summary", "description", "status", "attachment", "issuelinks"];
  /** An issue as the API gives it, read. */
  const readIssue = (issue: unknown, what: string): ReadBack => {
    const key = isRecord(issue) ? String(issue.key ?? "") : "";
    const number = keyNumber(key);
    const fields = isRecord(issue) && isRecord(issue.fields) ? issue.fields : null;
    // A field configuration can hide the description; without it, every finding would read as unfiled and be filed again.
    if (number === null || !fields || !("description" in fields))
      throw new ExportError(`Jira ${what} an issue without its key or its description, so which findings are filed cannot be told`);
    const status = isRecord(fields.status) && isRecord(fields.status.statusCategory) ? fields.status.statusCategory.key : undefined;
    const jira = { summary: fields.summary, description: fields.description, attachments: namesOf(fields.attachment), links: keysOf(fields.issuelinks) };
    return {
      issue: { ref: key, number, url: `${baseUrl}/browse/${key}`, open: status !== "done", jira },
      ids: findingIdsInJiraDescription(fields.description),
    };
  };
  return {
    label: `Jira ${projectKey}`,
    consistentListing: false,
    async existing(includeClosed) {
      // The key was checked to be capitals, digits and underscores; the label is ours. Nothing else goes into the query.
      const jql = `project = "${projectKey}" AND labels = "${MARKER_LABEL}"${includeClosed ? "" : " AND statusCategory != Done"} ORDER BY created ASC`;
      const map = new Map<string, FiledIssue>();
      let issues = 0;
      let unmarked = 0;
      let nextPageToken: string | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await send({
          method: "POST",
          path: "/rest/api/3/search/jql",
          json: { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
          idempotent: true,
        });
        if (!isRecord(body) || !Array.isArray(body.issues)) throw new ExportError("Jira's search answered without a list of issues");
        for (const entry of body.issues) {
          const { issue, ids } = readIssue(entry, "listed");
          issues++;
          if (ids.length === 0) unmarked++;
          for (const id of ids) rememberFiled(map, id, issue);
        }
        nextPageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
        if (!nextPageToken || body.isLast === true) return { map, issues, unmarked };
      }
      throw new ExportError(
        `more than ${MAX_PAGES} pages of issues in ${projectKey} carry the ${MARKER_LABEL} label, too many to check them all for this export's findings`,
      );
    },
    async read(ref) {
      // Read by key, which Jira answers from the issue itself rather than from its search, so a new issue shows at once.
      const body = await send({ method: "GET", path: `${issuePath(ref)}?fields=${FIELDS.join(",")}`, idempotent: true, missingOk: true });
      if (body === null) return null;
      const read = readIssue(body, "answered with");
      // An issue moved to another project answers under its new key: it is no longer this project's.
      return read.issue.ref === ref ? read : null;
    },
    async create(f, ctx, extras) {
      const body = await send({
        method: "POST",
        path: "/rest/api/3/issue",
        json: { fields: jiraIssueFields(f, { ...ctx, projectKey, issueType }) },
        idempotent: false,
      });
      const key = isRecord(body) ? String(body.key ?? "") : "";
      const number = keyNumber(key);
      if (number === null) throw new ExportError("Jira answered the create without an issue key", true);
      const issue: FiledIssue = { ref: key, number, url: `${baseUrl}/browse/${key}`, open: true };
      const attached = await attach(key, extras.files, "a later export attaches it while the issue is open, unless --jira-update is off");
      const linked = await link(key, extras.tickets);
      return { issue, problems: [...attached.problems, ...linked.problems] };
    },
    async update(f, ctx, issue, plan, extras) {
      const rewrote = plan.fields === "change";
      if (rewrote)
        // Summary and description only: an edit, so Jira notifies the issue's watchers as it does for any other.
        await send({ method: "PUT", path: issuePath(issue.ref), json: { fields: jiraEditFields(f, ctx) }, idempotent: true });
      const wanted = new Set(plan.attach);
      const attached = await attach(
        issue.ref,
        extras.files.filter((x) => wanted.has(x.upload)),
        "a later export tries again",
      );
      const linked = await link(issue.ref, plan.link);
      return { rewrote, attached: attached.done, linked: linked.done, problems: [...attached.problems, ...linked.problems] };
    },
  };
}

// ── the project's files ─────────────────────────────────────────────────────

/** The project's memory, refused unless it is one this version reads: a file it cannot read exported nothing and said so with exit 0. */
function readMemory(memoryPath: string): unknown {
  if (!fs.existsSync(memoryPath))
    throw new ExportError(
      `no findings to export: ${memoryPath} does not exist. Run SceneScout on this project first, pass --project, or export a check.json or ci.json with --from`,
    );
  let memory: unknown;
  try {
    memory = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
  } catch (err) {
    throw new ExportError(`could not read ${memoryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(memory) || memory.version !== 1)
    throw new ExportError(`${memoryPath} is not a memory file this version reads (version ${isRecord(memory) ? oneLine(memory.version, 20) : "unknown"})`);
  if (!Array.isArray(memory.findings)) throw new ExportError(`${memoryPath} holds no list of findings`);
  return memory;
}

/**
 * A check.json or a ci.json, its findings in the shape memory.json holds
 * them. A file it cannot read, or one some other command wrote, is refused
 * rather than exported as nothing.
 */
function readResult(file: string): ResultSource {
  let text: string;
  let writtenAt: string;
  try {
    text = fs.readFileSync(file, "utf8");
    writtenAt = fs.statSync(file).mtime.toISOString();
  } catch (err) {
    throw new ExportError(`could not read --from ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ExportError(`could not read --from ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = findingsFromResult(raw, writtenAt);
  if (!parsed.ok) throw new ExportError(`--from ${file}: ${parsed.error}`);
  return parsed.value;
}

/** Every step with a frame, from every session log in the memory directory. Logs and lines that cannot be read are counted, not fatal. */
function framedSteps(memoryDir: string): { steps: Array<Pick<ActionLogEntry, "at" | "session" | "frame">>; unreadable: number } {
  const steps: Array<Pick<ActionLogEntry, "at" | "session" | "frame">> = [];
  let unreadable = 0;
  if (!fs.existsSync(path.join(memoryDir, "recordings"))) return { steps, unreadable };
  for (const name of fs.readdirSync(memoryDir)) {
    if (!/^session-.*\.jsonl$/.test(name)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(memoryDir, name), "utf8");
    } catch {
      // A log that cannot be read costs only its screenshots; it is counted with the lines that do not parse.
      unreadable++;
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"frame"')) continue;
      try {
        const e = JSON.parse(line) as Partial<ActionLogEntry>;
        if (typeof e.at === "string" && typeof e.frame === "string") steps.push({ at: e.at, session: e.session, frame: e.frame });
      } catch {
        unreadable++;
      }
    }
  }
  return { steps, unreadable };
}

/** A frame's file, when it really is inside the recordings folder: links are followed first, so a link to elsewhere, or a linked folder, is not. */
function frameFile(root: string, rel: string): { file: string; stat: fs.Stats } | null {
  const named = resolveFrame(root, rel);
  if (!named) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const file = fs.realpathSync(named);
    if (!file.startsWith(realRoot + path.sep)) return null;
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, stat } : null;
  } catch {
    // Missing, or unreadable: this frame is left out and counted, like any other that cannot be attached.
    return null;
  }
}

/** The frames an issue names or attaches: inside the recordings folder, small enough, and still the picture of that step. */
function framesOf(f: Finding, steps: ReturnType<typeof framedSteps>["steps"], memoryDir: string): { frames: Frame[]; dropped: number } {
  const frames: Frame[] = [];
  let dropped = 0;
  for (const { frame, at } of framesFor(f, steps)) {
    const found = frameFile(path.join(memoryDir, "recordings"), frame);
    if (!found || found.stat.size > MAX_FRAME_BYTES || !frameIsOriginal(at, found.stat.mtimeMs)) {
      dropped++;
      continue;
    }
    frames.push({ rel: frame, file: found.file, at, upload: uploadName(frame, at) });
  }
  return { frames, dropped };
}

/** The finding's own picture, when its path is one the engine writes and the file is inside the recordings folder and small enough. */
function pictureOf(f: Finding, memoryDir: string): Frame | null {
  const picture = findingPicture(f);
  if (!picture) return null;
  const found = frameFile(path.join(memoryDir, "recordings"), picture.rel);
  return found && found.stat.size <= MAX_FRAME_BYTES ? { ...picture, file: found.file, upload: uploadName(picture.rel, picture.at) } : null;
}

/** The record of the issues earlier exports filed; none yet is an empty one, and one that cannot be read ends the export. */
function readRecord(recordPath: string): ExportRecord {
  let text: string | null;
  try {
    text = fs.readFileSync(recordPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ExportError(`could not read ${recordPath}: ${err instanceof Error ? err.message : String(err)}`);
    text = null;
  }
  const parsed = parseExportRecord(text);
  if (!parsed.ok)
    throw new ExportError(
      `could not read ${recordPath}: ${parsed.error}. It records the issues earlier exports filed, so an export straight after another does not file them again; move it aside to start a new record`,
    );
  return parsed.value;
}

/**
 * Set one finding's entry in the record, read afresh so the entries of an
 * export that finished meanwhile are kept, and written whole or not at all.
 * It takes no lock: two exports from one project at the same moment can each
 * drop the other's latest entry. Exports are meant to run one at a time per
 * project, and an entry lost that way costs only the read-back, since the
 * listing still finds the issue once it catches up.
 */
function writeRecord(recordPath: string, key: string, id: string, entry: Parameters<typeof recordWith>[3]): void {
  const text = recordWith(readRecord(recordPath), key, id, entry);
  // An export --from a check or ci result may be the first thing to write in a project's .scenescout folder.
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const temp = `${recordPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, recordPath);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

// ── the export ──────────────────────────────────────────────────────────────

const OUTCOME_WORDS: Record<PlanEntry["outcome"], string> = { file: "would file", "already-filed": "already filed", "over-cap": "over the cap" };

export async function runExport(o: ExportOptions, deps: ExportDeps): Promise<ExportOutcome> {
  const credentials = trackerCredentials(o.to, deps.env);
  // Every credential that is set, not only the tracker's: one echoed back from anywhere is never printed.
  const secrets = credentialSecrets(deps.env);
  const say = (line: string): void => deps.log(redactKeys(line, secrets));
  const complain = (line: string): void => (deps.error ?? deps.log)(redactKeys(line, secrets));
  const http: Http = {
    fetchImpl: deps.fetchImpl ?? fetch,
    wait: deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: deps.retries ?? DEFAULT_RETRIES,
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
  };
  const pauseMs = deps.pauseMs ?? (o.to === "github" ? 1000 : 250);
  const where = o.to === "github" ? `GitHub ${o.github.repo}` : `Jira ${o.jira.projectKey} at ${o.jira.baseUrl}`;
  const filed: ExportOutcome["filed"] = [];
  const updated: ExportOutcome["updated"] = [];
  let plan: PlanEntry[] = [];
  // Kept outside the try, so an export that stops part-way still says what went wrong before it stopped.
  const problems: string[] = [];
  let droppedFrames = 0;
  const reportFrames = (): void => {
    if (droppedFrames > 0) say(`Left out ${droppedFrames} frame(s) that are missing, too large, or were rewritten by a later run.`);
  };
  try {
    const memoryDir = path.join(o.projectDir, MEMORY_DIRNAME);
    // A check.json or a ci.json names no frames, picture or tickets: its issues carry none of them.
    const result = o.from ? readResult(o.from) : null;
    const sourcePath = o.from ?? path.join(memoryDir, "memory.json");
    const memory = result ? { findings: result.findings } : readMemory(sourcePath);
    const screenshots = o.screenshots && !result;
    const selection = selectFindings(memory, o);
    const criteria = failedCriteriaByFinding(memory);
    if (selection.unknownOnly.length > 0)
      throw new ExportError(`--only names no finding ${result ? `in ${sourcePath}` : "of this project"}: ${selection.unknownOnly.join(", ")}`);
    say(o.dryRun ? `SceneScout export to ${where}: a dry run, so nothing is filed. Pass --yes to file.` : `SceneScout export to ${where}.`);
    const c = selection.counts;
    const left = [
      c.belowSeverity ? `${c.belowSeverity} below --min-severity ${o.minSeverity}` : "",
      c.worthALook ? `${c.worthALook} worth a look (--include-worth-a-look exports them)` : "",
    ].filter(Boolean);
    say(
      `Findings in ${sourcePath}${result ? ` (scenescout ${result.kind})` : ""}: ${c.open} open, ${c.resolved} resolved${selection.unreadable.length ? `, ${selection.unreadable.length} unreadable` : ""}. ` +
        `${selection.candidates.length} to export${left.length ? `; left out: ${left.join(", ")}` : ""}.`,
    );
    if (result && o.screenshots) say(`  No screenshots: a ${result.kind} result names none.`);
    if (selection.unreadable.length > 0)
      say(`  Not exported, as this version cannot read them: ${selection.unreadable.slice(0, 20).join(", ")}${selection.unreadable.length > 20 ? " …" : ""}`);
    for (const { id, reason } of selection.leftOut) say(`  not exported  ${id}: ${reason}`);
    if (selection.candidates.length === 0) {
      say("Nothing to export.");
      return { exitCode: EXIT_EXPORT.done, plan, filed, updated };
    }

    if (!credentials.ok && !o.dryRun) throw new ExportError(credentials.error);
    const tracker = !credentials.ok
      ? null
      : o.to === "github"
        ? githubApi(o.github, client(o.github.apiUrl, { ...credentials.headers, ...GITHUB_HEADERS }, http))
        : jiraApi(o.jira, client(o.jira.baseUrl, credentials.headers, http));
    // A closed issue counts as filed unless --refile-closed.
    const includeClosed = !o.refileClosed;
    let existing: Map<string, FiledIssue> | null = null;
    const recordPath = path.join(memoryDir, EXPORT_RECORD_FILE);
    const key = recordKey(o);
    let candidates = selection.candidates;
    let heldBack = 0;
    if (tracker) {
      const recorded = readRecord(recordPath)[key] ?? {};
      const found = await tracker.existing(includeClosed);
      existing = found.map;
      say(
        `Compared with ${tracker.label}: ${found.issues} ${includeClosed ? "" : "open "}issue(s) carry the ${MARKER_LABEL} label` +
          `${includeClosed ? " (open or closed)" : ""}${found.unmarked ? `, ${found.unmarked} of them with no marker` : ""}` +
          `${includeClosed ? "" : "; a finding whose issue was closed is filed again (--refile-closed)"}.`,
      );
      // The listing can lag behind a create, so an issue an earlier export recorded is read back by its number before its finding counts as unfiled.
      let readBack = 0;
      for (const f of candidates) {
        const entry = recorded[f.id];
        if (!entry || "uncertain" in entry || existing.has(f.id)) continue;
        const read = await tracker.read(entry.ref, entry.number);
        // Gone, moved, or no longer carrying the marker: the finding is filed again, as the listing says.
        if (!read || !read.ids.includes(f.id) || (!includeClosed && !read.issue.open)) continue;
        rememberFiled(existing, f.id, read.issue);
        readBack++;
      }
      if (readBack > 0) say(`  ${readBack} more finding(s) found filed by the issue number recorded in ${recordPath}, as the listing does not show them yet.`);
      // A Jira create that may have been made, and that the search does not show yet, holds its finding back for a while rather than file it twice.
      if (!tracker.consistentListing) {
        const held = candidates.filter((f) => !existing!.has(f.id) && recorded[f.id] && uncertainHolds(recorded[f.id], http.now()));
        for (const f of held) {
          const until = new Date(Date.parse(recorded[f.id].at) + UNCERTAIN_HOLD_MS).toISOString();
          say(`  ${"held back".padEnd(13)}  ${findingLine(f)}`);
          // A dry run says so and files nothing anyway, so a hold is not a failure of it.
          if (!o.dryRun)
            problems.push(
              `finding ${f.id} was held back: an export at ${recorded[f.id].at} may have filed it before an error, and ${tracker.label}'s search does not show it yet. An export after ${until} files it if it is still not found`,
            );
        }
        candidates = candidates.filter((f) => !held.includes(f));
        heldBack = held.length;
      }
    } else if (!credentials.ok) {
      say(`Not compared with ${TRACKER_LABEL[o.to]}: ${credentials.error}. A finding filed earlier is listed below as one to file.`);
    }
    const record = (f: Finding, entry: Parameters<typeof recordWith>[3], ref: string): void => {
      try {
        writeRecord(recordPath, key, f.id, entry);
      } catch (err) {
        problems.push(
          `${ref}: not recorded in ${recordPath} (${err instanceof Error ? err.message : String(err)}), so an export straight after this one may not see it yet`,
        );
      }
    };

    plan = planExport(candidates, existing, o.maxIssues);
    const steps = screenshots ? framedSteps(memoryDir) : { steps: [], unreadable: 0 };
    if (steps.unreadable > 0) say(`Skipped ${steps.unreadable} session-log line(s) or file(s) that could not be read while looking for screenshots.`);
    const contextOf = (f: Finding): { ctx: IssueContext; extras: Extras } => {
      const found = screenshots ? framesOf(f, steps.steps, memoryDir) : { frames: [], dropped: 0 };
      droppedFrames += found.dropped;
      const picture = screenshots ? pictureOf(f, memoryDir) : null;
      const failed: FailedCriterion[] = criteria.get(f.id) ?? [];
      return {
        ctx: {
          severityName: o.severityMap[f.severity],
          labels: o.labels,
          screenshots: screenshots ? found.frames.map((x) => x.rel) : "off",
          framesLeftOut: found.dropped,
          picture: picture?.rel ?? null,
          ...(picture?.at ? { pictureAt: picture.at } : {}),
          screenshotTimes: found.frames.map((x) => x.at ?? ""),
          criteria: failed,
        },
        // GitHub takes no uploads and has no links between trackers: its body names both instead.
        extras:
          o.to === "jira"
            ? { files: [...(picture ? [picture] : []), ...found.frames], tickets: o.jira.linkType ? ticketsToLink(failed) : [] }
            : { files: [], tickets: [] },
      };
    };
    let writes = 0;

    for (const entry of plan) {
      const f = entry.finding;
      if (entry.outcome === "already-filed") {
        const issue = entry.issue;
        const already = `  ${OUTCOME_WORDS[entry.outcome].padEnd(13)}  ${findingLine(f)}  as ${issue.ref}${issue.open ? "" : " (closed)"}`;
        // Only an open Jira issue filed earlier is brought up to date; a closed one is the team's decision and left alone.
        // An export --from a result never updates: the file holds less than the memory that may have filed the issue.
        if (o.to !== "jira" || !o.jira.update || result || !issue.open || !issue.jira || !tracker?.update) {
          say(already);
          continue;
        }
        const { ctx, extras } = contextOf(f);
        const wanted = jiraEditFields(f, ctx);
        const upd = planJiraUpdate(f, issue.jira, {
          ...wanted,
          files: extras.files.map((x) => x.upload),
          tickets: extras.tickets,
        });
        const changesOf = (rewrite: boolean, attach: readonly string[], link: readonly string[], tense: "would" | "did"): string[] =>
          [
            rewrite ? (tense === "would" ? "rewrite its summary and description" : "rewrote its summary and description") : "",
            attach.length ? `${tense === "would" ? "attach" : "attached"} ${attach.join(", ")}` : "",
            link.length ? `${tense === "would" ? "link it to" : "linked it to"} ${link.join(", ")}` : "",
          ].filter(Boolean);
        const changes = changesOf(upd.fields === "change", upd.attach, upd.link, "would");
        const kept =
          upd.fields === "edited"
            ? "; its summary or description was edited in Jira, so it is left as written"
            : upd.fields === "no-revision"
              ? "; it was filed by an earlier version, so its summary and description are left as they are"
              : "";
        if (changes.length === 0 || o.dryRun) {
          const would = changes.length ? `; would ${changes.join(", ")}` : upd.fields === "same" ? ", up to date" : "";
          say(`${already}${would}${kept}`);
          continue;
        }
        if (writes > 0 && pauseMs > 0) await http.wait(pauseMs);
        writes++;
        const did = await tracker.update(f, ctx, issue, upd, extras);
        const done = changesOf(did.rewrote, did.attached, did.linked, "did");
        // Said only of what Jira took: an update whose every attachment and link failed changed nothing.
        if (done.length > 0) {
          updated.push({ id: f.id, issue });
          say(`  ${`updated ${issue.ref}`.padEnd(13)}  ${findingLine(f)}  ${issue.url}: ${done.join(", ")}${kept}`);
        } else say(`${already}; nothing could be updated${kept}`);
        for (const p of did.problems) problems.push(`${issue.ref}: ${p}`);
        continue;
      }
      // Listed, not filed: over the cap, or a dry run (the only way to be here with no tracker, as --yes needs credentials).
      if (entry.outcome === "over-cap" || o.dryRun || !tracker) {
        const shown = entry.outcome === "file" && screenshots ? contextOf(f).ctx : null;
        const shots = shown && shown.screenshots !== "off" ? shown.screenshots.length + (shown.picture ? 1 : 0) : 0;
        say(`  ${OUTCOME_WORDS[entry.outcome].padEnd(13)}  ${findingLine(f)}${shots ? `  with ${shots} screenshot(s)` : ""}`);
        continue;
      }
      if (writes > 0 && pauseMs > 0) await http.wait(pauseMs);
      const { ctx, extras } = contextOf(f);
      let done: Awaited<ReturnType<typeof fileOne>>;
      try {
        done = await fileOne(tracker, f, ctx, extras, includeClosed, http);
      } catch (err) {
        if (err instanceof ExportError && err.uncertain && !tracker.consistentListing)
          record(f, { uncertain: true, at: new Date(http.now()).toISOString() }, `finding ${f.id}`);
        throw err;
      }
      writes++;
      filed.push({ id: f.id, issue: done.issue });
      record(f, { ref: done.issue.ref, number: done.issue.number, url: done.issue.url, at: new Date(http.now()).toISOString() }, done.issue.ref);
      say(
        `  ${`filed ${done.issue.ref}`.padEnd(13)}  ${findingLine(f)}  ${done.issue.url}${done.confirmed ? " (found by its marker after the tracker's error)" : ""}`,
      );
      for (const p of done.problems) problems.push(`${done.issue.ref}: ${p}`);
      if (done.stop) throw new ExportError(done.stop);
    }
    reportFrames();

    const count = (outcome: PlanEntry["outcome"]): number => plan.filter((e) => e.outcome === outcome).length;
    const over = count("over-cap");
    const overText =
      (over ? `; ${over} over the cap of ${o.maxIssues} (--max-issues): export again to file them` : "") + (heldBack ? `; ${heldBack} held back` : "");
    say(
      o.dryRun
        ? `Would file ${count("file")}; ${count("already-filed")} already filed${overText}.`
        : `Filed ${filed.length}; ${count("already-filed")} already filed${updated.length ? `, ${updated.length} of them updated` : ""}${overText}.`,
    );
    if (problems.length > 0) {
      for (const p of problems) complain(`scenescout export: ${p}`);
      return { exitCode: EXIT_EXPORT.couldNotExport, plan, filed, updated };
    }
    return { exitCode: EXIT_EXPORT.done, plan, filed, updated };
  } catch (err) {
    reportFrames();
    complain(`scenescout export: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof ExportError && err.uncertain)
      complain(
        o.to === "jira"
          ? `Jira may have made that issue before the error, and its search can take minutes to show a new one, so it was not sent again. Export again later: the issue is found by its marker if it exists, and filed if it does not. An export within ${UNCERTAIN_HOLD_MS / 60_000} minutes holds that finding back unless it finds the issue.`
          : "The tracker may have made that issue before the error. The next export finds it by its marker and does not file it again.",
      );
    for (const p of problems) complain(`scenescout export: ${p}`);
    if (filed.length > 0) complain(`Filed before it stopped: ${filed.map((x) => x.issue.ref).join(", ")}.`);
    if (updated.length > 0) complain(`Updated before it stopped: ${updated.map((x) => x.issue.ref).join(", ")}.`);
    return { exitCode: EXIT_EXPORT.couldNotExport, plan, filed, updated };
  }
}

const GITHUB_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

/**
 * Create one issue. A create that failed in a way the tracker may have acted
 * on (a timeout, a 5xx, an answer cut off) is not simply sent again: the
 * issues are listed again first, and if one already carries this finding's
 * marker, that is the issue. Only when none does is the create repeated, and
 * only where the listing shows a new issue at once (GitHub, through its
 * newest issues read with no label filter); in Jira, whose search lags, the
 * export stops instead, and records the finding as held back for a while.
 */
async function fileOne(
  tracker: TrackerApi,
  f: Finding,
  ctx: IssueContext,
  extras: Extras,
  includeClosed: boolean,
  http: Http,
): Promise<Created & { confirmed?: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tracker.create(f, ctx, extras);
    } catch (err) {
      if (!(err instanceof ExportError) || !err.uncertain) throw err;
      const which = `the issue for finding ${f.id} (${oneLine(f.title, 80)})`;
      if (!tracker.consistentListing || attempt >= http.retries) throw new ExportError(`${err.message}, creating ${which}`, true);
      await http.wait(backoffMs(attempt + 1, http.random));
      let issue: FiledIssue | undefined;
      try {
        issue = (await tracker.existing(includeClosed)).map.get(f.id);
      } catch (listing) {
        throw new ExportError(
          `${err.message}, creating ${which}; listing the issues again to look for it failed too: ${listing instanceof Error ? listing.message : String(listing)}`,
          true,
        );
      }
      if (issue) return { issue, problems: [], confirmed: true };
    }
  }
}
