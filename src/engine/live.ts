/**
 * The live view: what every session is doing right now, and what it is
 * looking at.
 *
 * status.json used to hold ONE line for the whole project, last write wins. With
 * several sessions attached that line describes whichever session happened to
 * finish a call most recently, which is the opposite of what someone watching a
 * multi-role run needs. The StatusBoard keeps one entry per session instead.
 *
 * The LiveServer puts that board, a thumbnail and an optional live stream of
 * each session's page behind a small HTTP server. It exists for a person
 * watching a run, and it holds to the rules in ADR 7:
 *
 *  - it binds 127.0.0.1 only and refuses a Host header that is not loopback,
 *    so neither the network nor a DNS-rebinding page can reach it;
 *  - every path starts with a random token, handed over in the scout_attach
 *    result and, for `scenescout watch`, through a file only the owner can read;
 *  - it answers GET and nothing else: a viewer can look, never act;
 *  - a frame is held in memory and sent to the viewer. None is written to disk,
 *    because the page may be showing somebody's real data.
 *
 * Nothing here imports Playwright. The engine is reached through LiveProvider,
 * so the whole module is tested over real HTTP with a fake provider.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { LIVE_PAGE } from "./live-page.js";
import { JOURNEY_END, JOURNEY_START, type ActionLogEntry } from "./memory.js";

/** Holds the live view's token, next to status.json. Written owner-only; removed when the engine shuts down. */
export const LIVE_TOKEN_FILE = "live-token";
/** `SCENESCOUT_LIVE=off` keeps the engine from opening the live view's port at all. */
export const LIVE_ENV = "SCENESCOUT_LIVE";

export type Phase = "running" | "idle";
export type SessionState = Phase | "stuck";

export interface SessionStatus {
  session: string;
  role: string;
  phase: Phase;
  /** The tool that is running, or the one that ran last when idle. */
  tool: string;
  url: string;
  /** When the current phase of the current tool began. "Stuck" is measured from here. */
  since: string;
  at: string;
  /** The running tool's watchdog budget. A call still running past it has outlived the watchdog that should have ended it. */
  budgetMs?: number;
  mode?: string;
  browser?: string;
  headed?: boolean;
  /** What the agent said this session is for, at attach. */
  task?: string;
  /** The goal of the journey the session is on right now, if any. */
  objective?: string;
  /** Present exactly when `objective` is. */
  objectiveSince?: string;
}

/** What the engine says about a session, spread onto its board entry. Text in it is the agent's own and is redacted by the caller. */
export type SessionDescription = Pick<SessionStatus, "mode" | "browser" | "headed" | "task" | "objective" | "objectiveSince">;

/** One line of a session's activity feed: what it did, and how that turned out. */
export interface ActivityLine {
  at: string;
  action: string;
  target?: string;
  url: string;
  result?: string;
  /** The goal of the journey this action was part of, when it was part of one. */
  objective?: string;
}

/** What the feed reads from an action-log entry. */
export type LoggedAction = Pick<ActionLogEntry, "at" | "action" | "target" | "url" | "result" | "session">;

/**
 * One session's most recent actions, oldest first, each tagged with the
 * journey it belonged to. The log is project-wide and interleaves every
 * session, and a journey is delimited in it by its own `journey:start` and
 * `journey:end` lines, so the walk goes back past the window until it finds
 * the marker that says whether the window's first lines were inside one.
 */
export function feedForSession(log: readonly LoggedAction[], session: string, limit: number, redact: (s: string) => string = (s) => s): ActivityLine[] {
  const mine: LoggedAction[] = [];
  let i = log.length - 1;
  for (; i >= 0 && mine.length < limit; i -= 1) {
    const e = log[i];
    if (e && (e.session ?? session) === session) mine.push(e);
  }
  let objective: string | undefined;
  for (; i >= 0; i -= 1) {
    const e = log[i];
    if (!e || (e.session ?? session) !== session) continue;
    if (e.action === JOURNEY_END) break;
    if (e.action === JOURNEY_START) {
      objective = e.target;
      break;
    }
  }
  const lines: ActivityLine[] = [];
  for (const e of mine.reverse()) {
    if (e.action === JOURNEY_START) objective = e.target;
    const line: ActivityLine = { at: e.at, action: e.action, url: redact(e.url) };
    if (e.target !== undefined) line.target = e.target;
    if (e.result !== undefined) line.result = e.result;
    if (objective !== undefined) line.objective = objective;
    lines.push(line);
    if (e.action === JOURNEY_END) objective = undefined;
  }
  return lines;
}

export interface LiveSnapshot {
  pid: number;
  version: string;
  at: string;
  sessions: SessionStatus[];
}

/** One session as `api/status` sends it: its board entry, the state worked out on the server, and a short feed. */
export interface LiveSessionView extends SessionStatus {
  state: SessionState;
  feed: ActivityLine[];
}

export interface StatusResponse extends Omit<LiveSnapshot, "sessions"> {
  sessions: LiveSessionView[];
}

/** How many feed lines a status poll carries per session. Enough to read the last move at a glance; the close-up asks for more. */
export const FEED_LINES = 6;
/** The cap the close-up gets. A long run's log is thousands of lines and none of it needs to reach the page. */
export const FEED_LINES_MAX = 60;

export type StatusFields = Pick<SessionStatus, "role" | "phase" | "tool" | "url"> & Partial<Pick<SessionStatus, "budgetMs">> & Partial<SessionDescription>;

/**
 * How long a call may run before the session is judged wedged rather than
 * busy, when the entry does not carry the tool's own watchdog budget (an
 * engine from before budgets were recorded). Each tool's real budget is what
 * `classify` uses when it is there: a healthy crawl runs for minutes.
 */
export const STUCK_AFTER_MS = 120_000;

export class StatusBoard {
  private readonly entries = new Map<string, SessionStatus>();

  constructor(private readonly now: () => number = Date.now) {}

  update(session: string, fields: StatusFields): SessionStatus {
    const prev = this.entries.get(session);
    const at = new Date(this.now()).toISOString();
    // `since` survives repeated writes of the same phase of the same tool:
    // that is what lets a reader tell a long-running call from a fresh one.
    const since = prev && prev.phase === fields.phase && prev.tool === fields.tool ? prev.since : at;
    const next: SessionStatus = { session, ...fields, since, at };
    this.entries.set(session, next);
    return next;
  }

  remove(session: string): void {
    this.entries.delete(session);
  }

  clear(): void {
    this.entries.clear();
  }

  has(session: string): boolean {
    return this.entries.has(session);
  }

  /** Sorted by name, so a poller sees a stable order rather than insertion order. */
  list(): SessionStatus[] {
    return [...this.entries.values()].sort((a, b) => a.session.localeCompare(b.session));
  }
}

export function classify(status: Pick<SessionStatus, "phase" | "since" | "budgetMs">, nowMs: number, stuckAfterMs = STUCK_AFTER_MS): SessionState {
  if (status.phase !== "running") return "idle";
  // Past its own budget the watchdog should have ended the call; a call still
  // running there has outlived the thing that was meant to stop it.
  return nowMs - new Date(status.since).getTime() > (status.budgetMs ?? stuckAfterMs) ? "stuck" : "running";
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A log timestamp on the reader's own clock, 24-hour. The log stores UTC, and
 * a time sliced straight out of it reads an hour or more off the person's
 * watch, which makes a live feed look stale.
 */
export function localClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** One line per session for the terminal (`scenescout status`). */
export function formatSessionLine(status: SessionStatus, nowMs: number): string {
  const state = classify(status, nowMs);
  const held = formatDuration(nowMs - new Date(status.since).getTime());
  const what = state === "idle" ? `· idle ${held} after ${status.tool}` : `${state === "stuck" ? "⚠ STUCK" : "⏳"} ${status.tool} for ${held}`;
  return `${status.session} (${status.role}) ${what}${status.url ? ` — ${status.url}` : ""}`;
}

const statusWrites = new Map<string, Promise<void>>();

/**
 * Write status.json so that a reader never sees a torn file. Writes to one
 * directory are queued behind each other, and each lands by rename, so two
 * calls in the same tick cannot leave a short document with the tail of a
 * longer one after it (which is what overlapping `writeFile`s produced).
 * Best-effort: a failed write is dropped and the next one lands.
 */
export function writeStatusFile(dir: string, body: string): Promise<void> {
  const file = path.join(dir, "status.json");
  const tmp = `${file}.${process.pid}.tmp`;
  const next = (statusWrites.get(dir) ?? Promise.resolve())
    .then(() => fs.promises.writeFile(tmp, body))
    .then(() => fs.promises.rename(tmp, file))
    .catch(() => fs.promises.rm(tmp, { force: true }).catch(() => {}));
  statusWrites.set(dir, next);
  return next;
}

/**
 * The lines `scenescout status` prints for a status file it could read: the
 * engine, what it is doing, and one line per session (or the single legacy
 * line an engine from before the live view wrote). The recent-actions tail
 * comes from the session log and is printed by the CLI.
 */
export function formatStatus(st: StatusFile, alive: boolean, nowMs: number): string[] {
  const lines: string[] = [];
  const age = st.at ? Math.round((nowMs - new Date(st.at).getTime()) / 1000) : null;
  lines.push(`Engine pid ${st.pid ?? "?"} — ${alive ? "ALIVE" : "not running (stale status)"}`);
  lines.push(`${st.phase === "running" ? "⏳ running" : "· idle after"}: ${st.tool ?? "?"}${age !== null ? ` (as of ${age}s ago)` : ""}`);
  // The file is written by another process and can be caught mid-write, so
  // only entries whole enough to describe are described.
  const sessions = wholeSessions(st.detail);
  if (sessions.length > 0) {
    lines.push(`Sessions (${sessions.length}):`);
    for (const entry of sessions) lines.push(`  ${formatSessionLine(entry, nowMs)}`);
    if (alive && st.live?.port) lines.push("Live view: scenescout watch");
    if (alive && st.live?.error) lines.push(`Live view unavailable: ${st.live.error}`);
  } else {
    lines.push(`Session: ${st.session ?? "?"} (${st.role ?? "?"})${st.sessions && st.sessions.length > 1 ? ` · all sessions: ${st.sessions.join(", ")}` : ""}`);
    if (st.url) lines.push(`URL: ${st.url}`);
  }
  return lines;
}

/** status.json as a reader finds it. Every field is optional: an older engine wrote fewer, and a killed one may have written none. */
export interface StatusFile {
  pid?: number;
  phase?: string;
  tool?: string;
  session?: string;
  role?: string;
  sessions?: string[];
  url?: string;
  at?: string;
  detail?: Array<Partial<SessionStatus>>;
  live?: { port?: number; error?: string };
}

/** The entries of a status file that are whole enough to describe. A truncated write or an older engine can leave others. */
export function wholeSessions(detail: Array<Partial<SessionStatus>> | undefined): SessionStatus[] {
  return (detail ?? []).filter(
    (e): e is SessionStatus =>
      typeof e.session === "string" &&
      typeof e.tool === "string" &&
      typeof e.role === "string" &&
      typeof e.url === "string" &&
      (e.phase === "running" || e.phase === "idle") &&
      typeof e.since === "string" &&
      Number.isFinite(Date.parse(e.since)),
  );
}

/**
 * Where `scenescout watch` should send the browser, or why it cannot.
 *
 * status.json and the token file sit inside the project under test, so a
 * repository can ship its own. Both values are therefore checked for shape
 * before they are put into a URL, and the host is never read from the file.
 */
export function watchTarget(input: { status: StatusFile | "unreadable" | null; alive: boolean; token: string | null }): { url: string } | { problem: string } {
  const { status, alive, token } = input;
  if (!status) return { problem: "No SceneScout engine has attached to this project yet. Start a run, then run this again." };
  if (status === "unreadable")
    return { problem: "The status file is unreadable or truncated: the engine was probably killed mid-write. Attach again to rewrite it." };
  if (!alive) return { problem: `The engine that last ran here (pid ${status.pid ?? "?"}) is not running. The live view exists only while a run is attached.` };
  if (status.live?.error) return { problem: `The engine could not open the live view: ${status.live.error}` };
  const port = status.live?.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      problem: `This engine is not serving a live view: it was started with ${LIVE_ENV}=off, or it is a version from before the live view existed. Restart the MCP server to pick it up.`,
    };
  }
  const clean = token?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(clean))
    return {
      problem: `The live view's token file (${LIVE_TOKEN_FILE}) is missing or unreadable. It is written when a session attaches; if a run is attached and it is still missing, the engine could not write into the project directory.`,
    };
  return { url: `http://127.0.0.1:${port}/${clean}/` };
}

export interface LiveProvider {
  /** Synchronous and cheap: called on every request, sometimes twice. */
  snapshot(): LiveSnapshot;
  /** The most recent actions of one session, oldest first. */
  activity(session: string, limit: number): ActivityLine[];
  /** The run's report as it stands now, rendered without being written, or null when no run is attached. */
  report(): { markdown: string; at: string } | null;
  /** A JPEG of the session's page, or null when there is no such session or no frame could be taken. */
  screenshot(session: string): Promise<Buffer | null>;
  /**
   * Start pushing JPEG frames. Resolves to the function that stops them, or
   * null when the session cannot stream. `onEnd` is called once if the page
   * goes away for good while the stream is running.
   */
  startStream(session: string, onFrame: (jpeg: Buffer) => void, onEnd: () => void): Promise<(() => Promise<void>) | null>;
}

/** One viewer of a session's stream: where its frames go, and how it is told the session is gone. */
interface Viewer {
  frame: (jpeg: Buffer) => void;
  /** An MJPEG response ends; a shared events connection is told which session it lost. */
  gone: () => void;
}

interface StreamEntry {
  /** Each open response watching this session. */
  viewers: Map<http.ServerResponse, Viewer>;
  /** The screencast: starting, or live with the function that stops it. A failed start deletes the entry instead. */
  screencast: { state: "starting"; ready: Promise<boolean> } | { state: "live"; stop: () => Promise<void> };
  lastFrame: Buffer | null;
}

const LIVE_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const BOUNDARY = "scenescoutframe";
/** A thumbnail younger than this is served again instead of taking a new one. */
export const SHOT_MAX_AGE_MS = 1500;
/** A viewer this far behind is skipped for a frame rather than buffered without bound. */
const MAX_VIEWER_BACKLOG_BYTES = 4_000_000;

export class LiveServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = "";
  private readonly streams = new Map<string, StreamEntry>();
  private readonly shots = new Map<string, { at: number; jpeg: Buffer }>();
  private readonly shotsInFlight = new Map<string, Promise<Buffer | null>>();

  constructor(
    private readonly provider: LiveProvider,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<{ port: number; token: string }> {
    if (this.server) return { port: this.port, token: this.token };
    this.token = crypto.randomBytes(24).toString("base64url");
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        console.error(`[scenescout] live view ${(req.url ?? "").split("/").slice(2).join("/")} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      // The listener stays: an 'error' with nobody listening (an accept that
      // fails under EMFILE, say) would throw and take the whole engine down.
      server.on("error", (err) => {
        if (this.server === server) console.error(`[scenescout] live view server error: ${err.message}`);
        else reject(err);
      });
      // Loopback, never 0.0.0.0: the page being shown may be signed in to a real account.
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return { port: this.port, token: this.token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    const stops: Array<Promise<void>> = [];
    for (const entry of this.streams.values()) {
      for (const viewer of entry.viewers.keys()) viewer.end();
      if (entry.screencast.state === "live") stops.push(entry.screencast.stop().catch(() => {}));
    }
    this.streams.clear();
    this.shots.clear();
    await Promise.all(stops);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  get address(): { host: string; port: number } | null {
    const addr = this.server?.address() as AddressInfo | null | undefined;
    return addr ? { host: addr.address, port: addr.port } : null;
  }

  private send(
    res: http.ServerResponse,
    code: number,
    body: string | Buffer = "",
    type = "text/plain; charset=utf-8",
    extra: Record<string, string | number> = {},
  ): void {
    res.writeHead(code, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    });
    res.end(body);
  }

  private tokenMatches(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A page on another origin can point a hostname at 127.0.0.1 (DNS
    // rebinding); it cannot make the browser send a loopback Host header.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.send(res, 403, "forbidden");
    if (req.method !== "GET") return this.send(res, 405, "the live view is read-only");

    const parts = (req.url ?? "/").split("?")[0]!.split("/").slice(1);
    // A wrong token gets the same answer as a wrong path.
    if (!this.tokenMatches(parts[0] ?? "")) return this.send(res, 404, "not found");
    const [, route, name] = parts;

    // The page's own requests are relative, so it has to be served from a
    // directory. The target is this server's own token, which the request has
    // just matched, never the request's text.
    if (parts.length === 1) {
      res.writeHead(302, { Location: `/${this.token}/`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end();
      return;
    }
    if (!route) return this.send(res, 200, LIVE_PAGE, "text/html; charset=utf-8", { "Content-Security-Policy": LIVE_CSP });
    if (route === "api" && name === "status") {
      const snap = this.provider.snapshot();
      const nowMs = this.now();
      const body: StatusResponse = {
        ...snap,
        sessions: snap.sessions.map((s) => ({ ...s, state: classify(s, nowMs), feed: this.provider.activity(s.session, FEED_LINES) })),
      };
      return this.send(res, 200, JSON.stringify(body), "application/json; charset=utf-8");
    }
    if (route === "api" && name === "activity") {
      const session = this.param(req, "session");
      if (session === null) return this.send(res, 404, "not found");
      if (!this.hasSession(session)) return this.send(res, 404, "no such session");
      return this.send(res, 200, JSON.stringify({ session, feed: this.provider.activity(session, FEED_LINES_MAX) }), "application/json; charset=utf-8");
    }
    if (route === "api" && name === "report") {
      const report = this.provider.report();
      if (!report) return this.send(res, 404, "no run attached");
      return this.send(res, 200, JSON.stringify(report), "application/json; charset=utf-8");
    }
    if (route === "events" && !name) {
      const wanted = this.param(req, "sessions");
      if (wanted === null) return this.send(res, 404, "not found");
      const sessions = [...new Set(wanted.split(","))].filter((s) => s.length > 0 && this.hasSession(s));
      if (sessions.length === 0) return this.send(res, 404, "no such session");
      return this.serveEvents(sessions, req, res);
    }
    if ((route === "shot" || route === "stream") && name) {
      const ext = route === "shot" ? ".jpg" : ".mjpg";
      if (!name.endsWith(ext)) return this.send(res, 404, "not found");
      let session: string;
      try {
        session = decodeURIComponent(name.slice(0, -ext.length));
      } catch {
        return this.send(res, 404, "not found");
      }
      if (!this.hasSession(session)) return this.send(res, 404, "no such session");
      return route === "shot" ? this.serveShot(session, res) : this.serveStream(session, req, res);
    }
    return this.send(res, 404, "not found");
  }

  /** The value of this server's single query parameter, or null when its escaping is malformed. */
  private param(req: http.IncomingMessage, key: string): string | null {
    const raw = (req.url ?? "").split("?")[1] ?? "";
    try {
      return decodeURIComponent(raw.startsWith(`${key}=`) ? raw.slice(key.length + 1) : raw);
    } catch {
      return null;
    }
  }

  /** A viewer may only address a session the board knows. */
  private hasSession(name: string): boolean {
    return this.provider.snapshot().sessions.some((s) => s.session === name);
  }

  /** One screenshot serves every poller for SHOT_MAX_AGE_MS, and concurrent requests share one capture. */
  private async takeShot(session: string): Promise<Buffer | null> {
    const cached = this.shots.get(session);
    if (cached && this.now() - cached.at < SHOT_MAX_AGE_MS) return cached.jpeg;
    const pending = this.shotsInFlight.get(session);
    if (pending) return pending;
    const capture = this.provider
      .screenshot(session)
      .catch(() => null)
      .then((jpeg) => {
        if (jpeg) this.shots.set(session, { at: this.now(), jpeg });
        return jpeg;
      })
      .finally(() => this.shotsInFlight.delete(session));
    this.shotsInFlight.set(session, capture);
    return capture;
  }

  private async serveShot(session: string, res: http.ServerResponse): Promise<void> {
    const jpeg = await this.takeShot(session);
    if (!jpeg) return this.send(res, 503, "no frame available");
    return this.send(res, 200, jpeg, "image/jpeg", { "Content-Length": jpeg.length });
  }

  private writeFrame(res: http.ServerResponse, jpeg: Buffer): void {
    if (res.destroyed || res.writableLength > MAX_VIEWER_BACKLOG_BYTES) return;
    // One write per part: a part split across writes can reach the viewer half-drawn.
    res.write(Buffer.concat([Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from("\r\n")]));
  }

  private writeEvent(res: http.ServerResponse, event: string, data: object): void {
    if (res.destroyed || res.writableLength > MAX_VIEWER_BACKLOG_BYTES) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * The session is gone (closed by the agent, or its page died): every viewer
   * is told, and the screencast is stopped. A stream nobody ends would show
   * the last frame under a LIVE badge for as long as the page stayed open.
   */
  dropSession(session: string): void {
    const stream = this.streams.get(session);
    this.shots.delete(session);
    if (!stream) return;
    this.streams.delete(session);
    for (const viewer of stream.viewers.values()) viewer.gone();
    stream.viewers.clear();
    if (stream.screencast.state === "live") void stream.screencast.stop().catch(() => {});
  }

  /**
   * Add a viewer to a session's screencast, starting it for the first viewer.
   * Resolves to the function that removes the viewer again, and to null when
   * the session cannot stream. The last viewer to leave stops the screencast,
   * so an unwatched session pays nothing.
   */
  private async join(session: string, res: http.ServerResponse, viewer: Viewer): Promise<(() => void) | null> {
    let stream = this.streams.get(session);
    if (!stream) {
      const entry: StreamEntry = { viewers: new Map(), lastFrame: null, screencast: { state: "starting", ready: Promise.resolve(false) } };
      entry.screencast = {
        state: "starting",
        ready: this.provider
          .startStream(
            session,
            (jpeg) => {
              entry.lastFrame = jpeg;
              for (const v of entry.viewers.values()) v.frame(jpeg);
            },
            () => this.dropSession(session),
          )
          .catch(() => null)
          .then((stop) => {
            if (!stop) return false;
            // Stopped or dropped while it was starting: nobody is left to watch, so end it now.
            if (this.streams.get(session) !== entry) {
              void stop().catch(() => {});
              return false;
            }
            entry.screencast = { state: "live", stop };
            return true;
          }),
      };
      this.streams.set(session, entry);
      stream = entry;
    }
    const started = stream.screencast.state === "live" ? true : await stream.screencast.ready;
    if (!started) {
      if (this.streams.get(session) === stream && stream.viewers.size === 0) this.streams.delete(session);
      return null;
    }
    const entry = stream;
    entry.viewers.set(res, viewer);
    return () => {
      entry.viewers.delete(res);
      if (entry.viewers.size > 0 || this.streams.get(session) !== entry) return;
      this.streams.delete(session);
      if (entry.screencast.state === "live") void entry.screencast.stop().catch(() => {});
    };
  }

  /**
   * MJPEG: an <img> renders it natively, so anything that shows an image can
   * show one session live. The page itself does not use this: see serveEvents.
   */
  private async serveStream(session: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const leave = await this.join(session, res, { frame: (jpeg) => this.writeFrame(res, jpeg), gone: () => res.end() });
    if (!leave) return this.send(res, 503, "this session cannot stream");
    if (res.destroyed || req.destroyed) return leave();

    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "close",
    });
    res.on("close", leave);
    // A screencast emits on repaint, so a page that is sitting still would
    // show a late viewer nothing at all. Give them the current picture first.
    const first = this.streams.get(session)?.lastFrame ?? (await this.takeShot(session));
    if (first) this.writeFrame(res, first);
  }

  /**
   * Every session the page is watching, over ONE connection, as server-sent
   * events: `frame` carries a session's name and a base64 JPEG, `unavailable`
   * names a session that cannot stream, or that has gone away since. A browser
   * allows about six open connections to one host; with a stream per <img>,
   * "Stream all" on six sessions used them all up and the status poll queued
   * behind them forever, so the page froze at the moment it had the most to show.
   */
  private async serveEvents(sessions: string[], req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (res.destroyed || req.destroyed) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.write("retry: 1000\n\n");
    const leaves: Array<() => void> = [];
    res.on("close", () => {
      for (const leave of leaves) leave();
    });
    for (const session of sessions) {
      const leave = await this.join(session, res, {
        frame: (jpeg) => this.writeEvent(res, "frame", { session, jpeg: jpeg.toString("base64") }),
        gone: () => this.writeEvent(res, "unavailable", { session }),
      });
      if (!leave) {
        this.writeEvent(res, "unavailable", { session });
        continue;
      }
      if (res.destroyed) return leave();
      leaves.push(leave);
      const first = this.streams.get(session)?.lastFrame ?? (await this.takeShot(session));
      if (first) this.writeEvent(res, "frame", { session, jpeg: first.toString("base64") });
    }
  }
}
