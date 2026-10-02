/**
 * Runs `scenescout export`: reads the project's findings, asks the tracker
 * which of them it already holds, and files the rest. The rules (which
 * findings, what an issue says, the marker, the plan) live in
 * engine/export.ts; this file only reads the project's files and talks HTTP.
 * It writes nothing to the project, and the credentials it sends are never
 * printed: every line goes out through a redactor that knows them.
 */
import fs from "node:fs";
import path from "node:path";
import { redactKeys } from "./engine/ci.js";
import {
  credentialSecrets,
  EXIT_EXPORT,
  findingIdsInGithubBody,
  findingIdsInJiraDescription,
  findingLine,
  frameIsOriginal,
  framesFor,
  githubIssue,
  jiraIssueFields,
  MARKER_LABEL,
  MAX_RATE_WAIT_MS,
  oneLine,
  planExport,
  rateLimit,
  rememberFiled,
  selectFindings,
  trackerCredentials,
  trackerMessage,
  TRACKER_LABEL,
  type ExportOptions,
  type FiledIssue,
  type GithubTarget,
  type JiraTarget,
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
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
/** Pages of 100 issues read to find what is already filed. More than this and an export refuses rather than file blind. */
const MAX_PAGES = 50;
/** A frame larger than this is not uploaded: a recorded frame is a JPEG of a page, far smaller. */
const MAX_FRAME_BYTES = 10_000_000;

// ── HTTP ────────────────────────────────────────────────────────────────────

interface HttpRequest {
  method: "GET" | "POST";
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
  /** Relative to `.scenescout/`, as the session log names it. */
  rel: string;
  file: string;
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

interface TrackerApi {
  /** "GitHub owner/name", "Jira KEY". */
  label: string;
  /**
   * Whether an issue shows in `existing` as soon as it is created. GitHub's
   * issue list does; Jira's search can take minutes, so a create that may
   * have been carried out is never re-sent to Jira.
   */
  consistentListing: boolean;
  existing(includeClosed: boolean): Promise<Listing>;
  create(f: Finding, ctx: IssueContext, frames: readonly Frame[]): Promise<Created>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function githubApi({ repo }: GithubTarget, send: Send): TrackerApi {
  const root = `/repos/${repo
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/")}/issues`;
  return {
    label: `GitHub ${repo}`,
    consistentListing: true,
    // Listed by label rather than found through the search API: search is
    // indexed with a delay, so an export run right after another would not
    // see the issues it had just filed and would file them again.
    async existing(includeClosed) {
      const map = new Map<string, FiledIssue>();
      let issues = 0;
      let unmarked = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await send({
          method: "GET",
          path: `${root}?labels=${encodeURIComponent(MARKER_LABEL)}&state=${includeClosed ? "all" : "open"}&per_page=100&page=${page}`,
          idempotent: true,
        });
        if (!Array.isArray(body)) throw new ExportError("GitHub's list of issues was not a list");
        for (const issue of body) {
          // The issues API lists pull requests too.
          if (isRecord(issue) && issue.pull_request) continue;
          const number = isRecord(issue) ? Number(issue.number) : NaN;
          // An entry that cannot be read, or one without its body, could be a filed finding: guessing "not filed" files it twice.
          if (!isRecord(issue) || !Number.isInteger(number) || !("body" in issue))
            throw new ExportError("GitHub listed an issue without its number or its body, so which findings are filed cannot be told");
          issues++;
          const ids = findingIdsInGithubBody(issue.body);
          if (ids.length === 0) unmarked++;
          for (const id of ids) rememberFiled(map, id, { ref: `#${number}`, number, url: oneLine(issue.html_url, 300), open: issue.state !== "closed" });
        }
        if (body.length < 100) return { map, issues, unmarked };
      }
      throw new ExportError(`${MAX_PAGES * 100} or more issues carry the ${MARKER_LABEL} label, too many to check them all for this export's findings`);
    },
    async create(f, ctx) {
      const body = await send({ method: "POST", path: root, json: githubIssue(f, ctx), idempotent: false });
      const number = isRecord(body) ? Number(body.number) : NaN;
      if (!isRecord(body) || !Number.isInteger(number)) throw new ExportError("GitHub answered the create without an issue number", true);
      const issue: FiledIssue = { ref: `#${number}`, number, url: oneLine(body.html_url, 300), open: true };
      const labels: unknown[] = Array.isArray(body.labels) ? body.labels : [];
      const names = labels.map((l) => (typeof l === "string" ? l : isRecord(l) ? String(l.name ?? "") : "").toLowerCase());
      // GitHub drops the labels of an issue created by an account that cannot set them, and says nothing.
      if (!names.includes(MARKER_LABEL))
        return {
          issue,
          problems: [],
          stop: `GitHub filed ${issue.ref} without its ${MARKER_LABEL} label, so a later export could not find it. Stopping before filing more: GitHub drops the labels of an issue created by an account that may not set them, so give the token's account write access to the repository (and create the ${MARKER_LABEL} label if it has none), then add the label to ${issue.ref} by hand`,
        };
      return { issue, problems: [] };
    },
  };
}

function jiraApi({ baseUrl, projectKey, issueType }: JiraTarget, send: Send): TrackerApi {
  const keyNumber = (key: string): number | null => {
    const m = /^[A-Z][A-Z0-9_]*-(\d+)$/.exec(key);
    return m ? Number(m[1]) : null;
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
          json: { jql, fields: ["description", "status"], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
          idempotent: true,
        });
        if (!isRecord(body) || !Array.isArray(body.issues)) throw new ExportError("Jira's search answered without a list of issues");
        for (const issue of body.issues) {
          const key = isRecord(issue) ? String(issue.key ?? "") : "";
          const number = keyNumber(key);
          const fields = isRecord(issue) && isRecord(issue.fields) ? issue.fields : null;
          // A field configuration can hide the description; without it, every finding would read as unfiled and be filed again.
          if (number === null || !fields || !("description" in fields))
            throw new ExportError(`Jira listed an issue without its key or its description, so which findings are filed cannot be told`);
          issues++;
          const status = isRecord(fields.status) && isRecord(fields.status.statusCategory) ? fields.status.statusCategory.key : undefined;
          const ids = findingIdsInJiraDescription(fields.description);
          if (ids.length === 0) unmarked++;
          for (const id of ids) rememberFiled(map, id, { ref: key, number, url: `${baseUrl}/browse/${key}`, open: status !== "done" });
        }
        nextPageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
        if (!nextPageToken || body.isLast === true) return { map, issues, unmarked };
      }
      throw new ExportError(
        `more than ${MAX_PAGES} pages of issues in ${projectKey} carry the ${MARKER_LABEL} label, too many to check them all for this export's findings`,
      );
    },
    async create(f, ctx, frames) {
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
      const problems: string[] = [];
      for (const frame of frames) {
        const name = path.basename(frame.file);
        try {
          const form = new FormData();
          form.append("file", new Blob([fs.readFileSync(frame.file)], { type: "image/jpeg" }), name);
          await send({
            method: "POST",
            path: `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`,
            form,
            // Jira refuses an upload without it, as protection against cross-site requests.
            headers: { "x-atlassian-token": "no-check" },
            idempotent: true,
          });
        } catch (err) {
          problems.push(
            `${name} was not attached (${err instanceof Error ? err.message : String(err)}). It is at ${frame.file}; attach it by hand, since a later export does not add files to an issue it already filed`,
          );
        }
      }
      return { issue, problems };
    },
  };
}

// ── the project's files ─────────────────────────────────────────────────────

/** The project's memory, refused unless it is one this version reads: a file it cannot read exported nothing and said so with exit 0. */
function readMemory(memoryPath: string): unknown {
  if (!fs.existsSync(memoryPath))
    throw new ExportError(`no findings to export: ${memoryPath} does not exist. Run SceneScout on this project first, or pass --project`);
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
    frames.push({ rel: frame, file: found.file });
  }
  return { frames, dropped };
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
  let plan: PlanEntry[] = [];
  // Kept outside the try, so an export that stops part-way still says what went wrong before it stopped.
  const problems: string[] = [];
  let droppedFrames = 0;
  const reportFrames = (): void => {
    if (droppedFrames > 0) say(`Left out ${droppedFrames} frame(s) that are missing, too large, or were rewritten by a later run.`);
  };
  try {
    const memoryDir = path.join(o.projectDir, MEMORY_DIRNAME);
    const memoryPath = path.join(memoryDir, "memory.json");
    const selection = selectFindings(readMemory(memoryPath), o);
    if (selection.unknownOnly.length > 0) throw new ExportError(`--only names no finding of this project: ${selection.unknownOnly.join(", ")}`);
    say(o.dryRun ? `SceneScout export to ${where}: a dry run, so nothing is filed. Pass --yes to file.` : `SceneScout export to ${where}.`);
    const c = selection.counts;
    const left = [
      c.belowSeverity ? `${c.belowSeverity} below --min-severity ${o.minSeverity}` : "",
      c.worthALook ? `${c.worthALook} worth a look (--include-worth-a-look exports them)` : "",
    ].filter(Boolean);
    say(
      `Findings in ${memoryPath}: ${c.open} open, ${c.resolved} resolved${selection.unreadable.length ? `, ${selection.unreadable.length} unreadable` : ""}. ` +
        `${selection.candidates.length} to export${left.length ? `; left out: ${left.join(", ")}` : ""}.`,
    );
    if (selection.unreadable.length > 0)
      say(`  Not exported, as this version cannot read them: ${selection.unreadable.slice(0, 20).join(", ")}${selection.unreadable.length > 20 ? " …" : ""}`);
    for (const { id, reason } of selection.leftOut) say(`  not exported  ${id}: ${reason}`);
    if (selection.candidates.length === 0) {
      say("Nothing to export.");
      return { exitCode: EXIT_EXPORT.done, plan, filed };
    }

    if (!credentials.ok && !o.dryRun) throw new ExportError(credentials.error);
    const tracker = !credentials.ok
      ? null
      : o.to === "github"
        ? githubApi(o.github, client(o.github.apiUrl, { ...credentials.headers, ...GITHUB_HEADERS }, http))
        : jiraApi(o.jira, client(o.jira.baseUrl, credentials.headers, http));
    let existing: Map<string, FiledIssue> | null = null;
    if (tracker) {
      const found = await tracker.existing(o.includeClosed);
      existing = found.map;
      say(
        `Compared with ${tracker.label}: ${found.issues} ${o.includeClosed ? "" : "open "}issue(s) carry the ${MARKER_LABEL} label` +
          `${found.unmarked ? `, ${found.unmarked} of them with no marker` : ""}${o.includeClosed ? "" : " (--include-closed counts closed ones too)"}.`,
      );
    } else if (!credentials.ok) {
      say(`Not compared with ${TRACKER_LABEL[o.to]}: ${credentials.error}. A finding filed earlier is listed below as one to file.`);
    }

    plan = planExport(selection.candidates, existing, o.maxIssues);
    const steps = o.screenshots ? framedSteps(memoryDir) : { steps: [], unreadable: 0 };
    if (steps.unreadable > 0) say(`Skipped ${steps.unreadable} session-log line(s) or file(s) that could not be read while looking for screenshots.`);
    const contextOf = (f: Finding): { ctx: IssueContext; frames: Frame[] } => {
      const found = o.screenshots ? framesOf(f, steps.steps, memoryDir) : { frames: [], dropped: 0 };
      droppedFrames += found.dropped;
      return {
        ctx: {
          severityName: o.severityMap[f.severity],
          labels: o.labels,
          screenshots: o.screenshots ? found.frames.map((x) => x.rel) : "off",
          framesLeftOut: found.dropped,
        },
        frames: found.frames,
      };
    };

    let created = 0;
    for (const entry of plan) {
      const f = entry.finding;
      if (entry.outcome === "already-filed") {
        say(`  ${OUTCOME_WORDS[entry.outcome].padEnd(13)}  ${findingLine(f)}  as ${entry.issue.ref}${entry.issue.open ? "" : " (closed)"}`);
        continue;
      }
      // Listed, not filed: over the cap, or a dry run (the only way to be here with no tracker, as --yes needs credentials).
      if (entry.outcome === "over-cap" || o.dryRun || !tracker) {
        const shots = entry.outcome === "file" && o.screenshots ? contextOf(f).frames.length : 0;
        say(`  ${OUTCOME_WORDS[entry.outcome].padEnd(13)}  ${findingLine(f)}${shots ? `  with ${shots} screenshot(s)` : ""}`);
        continue;
      }
      if (created > 0 && pauseMs > 0) await http.wait(pauseMs);
      const { ctx, frames } = contextOf(f);
      const done = await fileOne(tracker, f, ctx, o.to === "jira" ? frames : [], o.includeClosed, http);
      created++;
      filed.push({ id: f.id, issue: done.issue });
      say(
        `  ${`filed ${done.issue.ref}`.padEnd(13)}  ${findingLine(f)}  ${done.issue.url}${done.confirmed ? " (found by its marker after the tracker's error)" : ""}`,
      );
      for (const p of done.problems) problems.push(`${done.issue.ref}: ${p}`);
      if (done.stop) throw new ExportError(done.stop);
    }
    reportFrames();

    const count = (outcome: PlanEntry["outcome"]): number => plan.filter((e) => e.outcome === outcome).length;
    const over = count("over-cap");
    const overText = over ? `; ${over} over the cap of ${o.maxIssues} (--max-issues): export again to file them` : "";
    say(
      o.dryRun
        ? `Would file ${count("file")}; ${count("already-filed")} already filed${overText}.`
        : `Filed ${filed.length}; ${count("already-filed")} already filed${overText}.`,
    );
    if (problems.length > 0) {
      for (const p of problems) complain(`scenescout export: ${p}`);
      return { exitCode: EXIT_EXPORT.couldNotExport, plan, filed };
    }
    return { exitCode: EXIT_EXPORT.done, plan, filed };
  } catch (err) {
    reportFrames();
    complain(`scenescout export: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof ExportError && err.uncertain)
      complain(
        o.to === "jira"
          ? "Jira may have made that issue before the error, and its search can take minutes to show a new one, so it was not sent again. Export again later: the issue is found by its marker if it exists, and filed if it does not."
          : "The tracker may have made that issue before the error. The next export finds it by its marker and does not file it again.",
      );
    for (const p of problems) complain(`scenescout export: ${p}`);
    if (filed.length > 0) complain(`Filed before it stopped: ${filed.map((x) => x.issue.ref).join(", ")}.`);
    return { exitCode: EXIT_EXPORT.couldNotExport, plan, filed };
  }
}

const GITHUB_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

/**
 * Create one issue. A create that failed in a way the tracker may have acted
 * on (a timeout, a 5xx, an answer cut off) is not simply sent again: the
 * issues are listed again first, and if one already carries this finding's
 * marker, that is the issue. Only when none does is the create repeated, and
 * only where the listing shows a new issue at once (GitHub); in Jira, whose
 * search lags, the export stops instead.
 */
async function fileOne(
  tracker: TrackerApi,
  f: Finding,
  ctx: IssueContext,
  frames: readonly Frame[],
  includeClosed: boolean,
  http: Http,
): Promise<Created & { confirmed?: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tracker.create(f, ctx, frames);
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
