import type { Page, Request } from "playwright";
import type { Contradiction } from "./claims.js";
import { redactSecrets } from "./memory.js";

export interface OracleViolation {
  kind: "console_error" | "page_error" | "request_failed" | "http_error" | "dom_injection" | "refused_empty" | "false_success" | "postmessage_token";
  severity: "high" | "medium";
  detail: string;
  url: string;
  at: string;
  /** True when this signature was already reported in full earlier this session — collapsed in tool output. */
  repeat?: boolean;
  /**
   * The origin of another site's frame a failing request came from, when it
   * went outside the app: that site's behaviour, not the app's. Kept at medium
   * severity at most and grouped apart in the report.
   */
  embed?: string;
}

/** How an HTTP error violation states its request. One formatter, so a reader of the detail (the check) cannot drift from its writer. */
export function httpErrorDetail(method: string, url: string, status: number): string {
  return `${method} ${url.slice(0, 200)} → HTTP ${status}`;
}

/** The status an http_error detail names, or null when the detail is not one. */
export function httpStatusOf(detail: string): number | null {
  const m = /→ HTTP (\d{3})$/.exec(detail.replace(/ \[\d+ secrets? redacted\]$/, ""));
  return m ? Number(m[1]) : null;
}

/** URLs whose failures are noise, not findings (favicons, source maps). */
const BENIGN_URL_RE = /favicon|\.map($|\?)/i;

/**
 * Violations quote request URLs verbatim — query string included — and end up
 * in tool output, memory and the report. A failed `GET /api/x?api_key=…` or a
 * 500 on a magic-link page must not re-publish the credential it carried.
 * Redacted at record time so no later consumer has to remember to.
 */
export function redactViolation<T extends { detail: string; url: string }>(v: T): T {
  return { ...v, detail: redactSecrets(v.detail), url: redactSecrets(v.url) };
}

/** How long after a write-policy block a generic "fetch failed" error is still attributed to it. */
export const POLICY_BLOCK_WINDOW_MS = 2000;

/**
 * Is this console or page error a consequence of the tester's OWN write-policy
 * block rather than something the app did?
 *
 * Aborting a request makes the browser print a console error, and — when the
 * app does not catch the rejection — raise a page error. Answering one with the
 * policy's stand-in 403 makes the browser print its "status of 403" line. Left in, a report
 * lists the tool's own safety net as defects of the app under test. (The
 * failed REQUEST itself is matched exactly, by request identity, in the
 * monitor; these two carry no request to match on, so they are attributed by
 * wording and by time.)
 *
 * Both rules need a block to have happened in the current action's window. A
 * bare "Failed to fetch" is otherwise a real defect — a wrong origin, a CORS
 * error, a refused connection — and must be reported.
 */
export function isPolicyInduced(v: { kind: string; detail: string }, msSincePolicyBlock: number | null): boolean {
  if (msSincePolicyBlock === null || msSincePolicyBlock > POLICY_BLOCK_WINDOW_MS) return false;
  if (v.kind !== "page_error" && v.kind !== "console_error") return false;
  return /ERR_BLOCKED_BY_CLIENT|Failed to fetch|NetworkError when attempting to fetch|Load failed|the server responded with a status of 403\b/i.test(v.detail);
}

/**
 * The request a console message is the browser's own echo of, or null when it
 * is not one.
 *
 * Chromium and WebKit print "Failed to load resource: …" for a subresource
 * that answered with an error status or got no answer, and give the
 * resource's address as the message's location (Firefox prints nothing; see
 * `echoesFailedLoads` in browsers.ts). The line carries no address in its
 * text, so without this it could only be charged to the page. Returned in the
 * form `requestKey` gives a request's URL, so the two can be matched.
 */
export function failedLoadEchoOf(text: string, locationUrl: string | undefined, pageUrl: string): string | null {
  if (!/^Failed to load resource: /.test(text) || !locationUrl) return null;
  try {
    return requestKey(new URL(locationUrl, pageUrl).href);
  } catch {
    return null;
  }
}

/** A request's address as the echo lookup keys it: absolute, and without its fragment, which is never sent. */
export function requestKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Which recent requests an embed sent, by address, so the browser's echo of
 * one that failed is charged where the request was.
 *
 * Only addresses an embed requested are kept, and the latest request to an
 * address decides: when the app then requests the same address, its echo is
 * the app's again. Bounded, dropping the oldest, so a long run does not hold
 * every address it saw.
 */
export class EmbedRequestLog {
  private byKey = new Map<string, string>();
  constructor(private readonly cap = 500) {}

  note(url: string, embed: string | null): void {
    const key = requestKey(url);
    this.byKey.delete(key);
    if (!embed) return;
    this.byKey.set(key, embed);
    if (this.byKey.size > this.cap) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  /** The embed whose request a console message echoes, or null when it echoes none of theirs. */
  embedOfEcho(text: string, locationUrl: string | undefined, pageUrl: string): string | null {
    const key = failedLoadEchoOf(text, locationUrl, pageUrl);
    return key === null ? null : (this.byKey.get(key) ?? null);
  }
}

/** How long after a replay ends the browser's console echo of its failure is still taken for the replay's. */
export const REPLAY_ECHO_WINDOW_MS = 2000;

/**
 * Addresses the tester is calling with scout_request, so the browser's console
 * echo of a refused probe ("Failed to load resource: … 403") is known as the
 * tester's and not charged to the page. The request itself is matched by
 * identity in the monitor; the echo carries only an address, so it is matched
 * by address while the replay is in flight and for a short window after, which
 * is when the browser prints it. Bounded, dropping the oldest.
 */
export class ReplayLog {
  /** Address → until when an echo of it is the replay's (Infinity while in flight). */
  private until = new Map<string, number>();
  constructor(private readonly cap = 200) {}

  begin(url: string): void {
    const key = requestKey(url);
    this.until.delete(key);
    this.until.set(key, Infinity);
    if (this.until.size > this.cap) this.until.delete(this.until.keys().next().value as string);
  }

  end(url: string, now: number): void {
    const key = requestKey(url);
    if (this.until.has(key)) this.until.set(key, now + REPLAY_ECHO_WINDOW_MS);
  }

  /** Whether a console message is the browser's echo of a replay's failed load. */
  echoes(text: string, locationUrl: string | undefined, pageUrl: string, now: number): boolean {
    const key = failedLoadEchoOf(text, locationUrl, pageUrl);
    if (key === null) return false;
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (now > until) {
      this.until.delete(key);
      return false;
    }
    return true;
  }
}

/**
 * Wording of a router cancelling a route change on purpose. Some client-side
 * routers can only stop a navigation (to keep a dirty form, say) by throwing
 * from their route-change event, and the apps that use them filter this
 * sentinel out of their own error monitoring. Narrow on purpose: it must name
 * the route and the cancelling.
 */
const ROUTE_CANCEL_RE = /\brout(?:e|ing)\b.{0,40}\b(?:abort|cancel)|\b(?:abort|cancel)\w*\b.{0,40}\brout(?:e|ing)\b/i;

/** What the engine knows about the action a page error was raised in. */
export interface PageErrorContext {
  /** The error was raised during a click. */
  byClick: boolean;
  /** The click was on a link: a route change was asked for. */
  viaLink: boolean;
  /** The URL the action settled on differs from the one it started on. */
  urlChanged: boolean;
  /** A dialog (native, or role=dialog/alertdialog) opened during the action. */
  dialogOpened: boolean;
}

/**
 * Is this uncaught page error a router deliberately cancelling a route change,
 * rather than a crash? Only for a click that left the URL where it was, and
 * then only when the message says so, or when the click asked for a route
 * change and the page put up a confirmation instead. Still reported, at
 * medium with a note: the error is real and uncaught, but the user never sees
 * it, and ranking it with crashes made every such page argue it away.
 */
export function isRouteCancellation(message: string, c: PageErrorContext): boolean {
  if (!c.byClick || c.urlChanged) return false;
  return ROUTE_CANCEL_RE.test(message) || (c.viaLink && c.dialogOpened);
}

/** Appended to a page error read as a route-change cancellation, saying which evidence it was read on. */
export function routeCancelNote(message: string): string {
  const why = ROUTE_CANCEL_RE.test(message)
    ? "the click left the URL unchanged and the error says the route change was cancelled"
    : "the click on a link left the URL unchanged and the page opened a dialog instead";
  return ` (likely a router cancelling the route change on purpose: ${why}; reported at medium, check what the page showed before filing)`;
}

/**
 * Invariant oracles: passive listeners that record violations regardless of
 * what the agent is doing. The engine drains the buffer after every action and
 * appends violations to the tool result, so the agent is told when something
 * broke without having to remember to check.
 */
export class OracleMonitor {
  private buffer: OracleViolation[] = [];
  /** Full-session log, kept for the final report. */
  readonly all: OracleViolation[] = [];

  attach(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Benign noise: failed favicon / source map fetches show up as console errors.
      if (/favicon|source map/i.test(text)) return;
      // The browser's echo of the tester's own scout_request: its answer was in that tool's result.
      if (this.replays.echoes(text, msg.location().url, page.url(), Date.now())) {
        this.replayAttributed += 1;
        return;
      }
      this.record({
        kind: "console_error",
        severity: "high",
        detail: text.slice(0, 500),
        url: page.url(),
        // The one console line that names its request: the browser's echo of an embed's failed load is the embed's too.
        embed: this.embedRequests.embedOfEcho(text, msg.location().url, page.url()) ?? undefined,
      });
    });

    // Noted as each request starts, which is always before the browser can echo its failure.
    page.on("request", (req) => this.embedRequests.note(req.url(), this.embedOfRequest(req)));

    page.on("pageerror", (err) => {
      this.record({
        kind: "page_error",
        severity: "high",
        detail: String(err.message ?? err).slice(0, 500),
        url: page.url(),
      });
    });

    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "unknown";
      // Aborted requests are routine during SPA navigation.
      if (failure.includes("ERR_ABORTED")) return;
      if (BENIGN_URL_RE.test(req.url())) return;
      if (this.isReplay(req)) {
        this.replayAttributed += 1;
        return;
      }
      if (this.refusedByPolicy(req)) {
        this.policyAttributed += 1;
        return;
      }
      this.record({
        kind: "request_failed",
        severity: "medium",
        detail: `${req.method()} ${req.url().slice(0, 200)} → ${failure}`,
        url: page.url(),
        embed: this.embedOfRequest(req) ?? undefined,
      });
    });

    page.on("response", (res) => {
      const status = res.status();
      if (status < 400) return;
      // Keep this filter consistent with the console oracle: a missing favicon
      // reported here on every page load teaches the driver to ignore http_error.
      if (BENIGN_URL_RE.test(res.url())) return;
      // The tester's own scout_request: a probe of a boundary is meant to be
      // refused, and its answer was in that tool's result, not the page's.
      if (this.isReplay(res.request())) {
        this.replayAttributed += 1;
        return;
      }
      // The write policy's own stand-in refusal, matched by request identity
      // like a dropped one: the server never said this.
      if (this.refusedByPolicy(res.request())) {
        this.policyAttributed += 1;
        return;
      }
      // 401/403 are often expected (auth probes); still report, but as medium.
      this.record({
        kind: "http_error",
        severity: status >= 500 ? "high" : "medium",
        detail: httpErrorDetail(res.request().method(), res.url(), status),
        url: page.url(),
        embed: this.embedOfRequest(res.request()) ?? undefined,
      });
    });
  }

  /** Signatures already shown in full — a known-failing endpoint repeating on every page must not flood every tool result. */
  private reportedSigs = new Set<string>();
  /**
   * Cap on remembered signatures. The set only ever grew, so a long run against
   * an app with many distinct failures held every one for the life of the
   * process. Dropping the oldest half on overflow costs at most a re-report of
   * a violation last seen thousands of actions ago — which is arguably the
   * right thing to surface again anyway.
   */
  private static readonly MAX_REPORTED_SIGS = 5000;

  private lastPolicyBlockAt: number | null = null;
  private refusedByPolicy: (req: Request) => boolean = () => false;

  /**
   * Errors attributed to the write policy's own blocks and therefore not
   * recorded as violations. Counted, so a report can say how many there were:
   * dropping them silently would make a clean run and a run that hid three
   * errors look the same.
   */
  policyAttributed = 0;

  private isReplay: (req: Request) => boolean = () => false;
  private readonly replays = new ReplayLog();
  /** Failures of the tester's own scout_request calls, kept out of the page's violations and counted. */
  replayAttributed = 0;

  /**
   * The engine knows which requests are its own scout_request replays, by
   * identity; their failures are the tester's probes, not the page's.
   */
  setReplayCheck(check: (req: Request) => boolean): void {
    this.isReplay = check;
  }

  /** A scout_request call to this address is starting: the browser's echo of its failure is the tester's. */
  replayStarted(url: string): void {
    this.replays.begin(url);
  }

  /** That call has returned; its echo is still expected for a short window. */
  replayEnded(url: string): void {
    this.replays.end(url, Date.now());
  }

  /** Whether a page error was recorded since `since` (ms) and not yet drained. */
  hasPageErrorSince(since: number): boolean {
    return this.buffer.some((v) => v.kind === "page_error" && Date.parse(v.at) >= since);
  }

  /**
   * Re-rank the page errors this click raised that read as a router
   * cancelling a route change (isRouteCancellation). Done before the drain, so
   * the action's result, the session log and the report all see one verdict.
   */
  downgradeRouteCancellations(since: number, c: PageErrorContext): void {
    for (const v of this.buffer) {
      if (v.kind !== "page_error" || v.severity !== "high" || Date.parse(v.at) < since) continue;
      if (!isRouteCancellation(v.detail, c)) continue;
      v.severity = "medium";
      v.detail += routeCancelNote(v.detail);
    }
  }

  private embedOfRequest: (req: Request) => string | null = () => null;
  private embedRequests = new EmbedRequestLog();

  /**
   * The engine knows which frame a request came from; a failing request is
   * attributed to an embed through this. Console and page errors are not
   * attributed: a console message says where its script was served from, not
   * which frame ran it, so an SDK the app's page loads from the embed's own
   * site would be taken for the embed. The exception is the browser's echo of
   * a failed load, which names its request and goes where the request went.
   */
  setEmbedAttribution(ofRequest: (req: Request) => string | null): void {
    this.embedOfRequest = ofRequest;
  }

  /** The engine knows exactly which requests its policy stopped; failed requests and stand-in refusals are matched against that, not against wording. */
  setPolicyRefusalCheck(check: (req: Request) => boolean): void {
    this.refusedByPolicy = check;
  }

  /** Called by the engine when the write policy stops a request (dropped or answered), so the errors that causes are not held against the app. */
  notePolicyBlock(): void {
    this.lastPolicyBlockAt = Date.now();
  }

  /**
   * A markup-shaped value the session typed has come back as an element on
   * this page: whoever opens it runs the input. Found by the engine's DOM scan
   * (injection.ts), not by a page event, so it is reported through here.
   */
  noteInjection(detail: string, url: string): void {
    this.record({ kind: "dom_injection", severity: "high", detail, url });
  }

  /**
   * The page contradicted a request that was refused during the same action:
   * a refused list rendered as an empty state, or a refused save reported as a
   * success. Found by the engine's DOM scan (claims.ts), like injections, so
   * it is reported through here rather than by a page event.
   */
  noteContradiction(c: Contradiction, url: string): void {
    this.record({ kind: c.kind, severity: "high", detail: c.detail, url });
  }

  /**
   * The page posted a token-shaped value with targetOrigin "*" (postmessage.ts).
   * Reported through the capture script's binding, not a page event. `embed`
   * is the receiving frame's site when that frame is another site's.
   */
  noteTokenPost(detail: string, url: string, embed: string | null): void {
    this.record({ kind: "postmessage_token", severity: "high", detail, url, embed: embed ?? undefined });
  }

  private record(v: Omit<OracleViolation, "at" | "repeat">): void {
    if (isPolicyInduced(v, this.lastPolicyBlockAt === null ? null : Date.now() - this.lastPolicyBlockAt)) {
      this.policyAttributed += 1;
      return;
    }
    // Another site's frame: its behaviour, reported, but never as the app's high-severity defect.
    const attributed = v.embed ? { ...v, severity: "medium" as const } : v;
    if (!attributed.embed) delete (attributed as { embed?: string }).embed;
    const violation: OracleViolation = { ...redactViolation(attributed), at: new Date().toISOString() };
    this.buffer.push(violation);
    this.all.push(violation);
  }

  /**
   * Return and clear violations accumulated since the last drain, flagging
   * repeats of already-reported signatures. Repeat bookkeeping happens HERE,
   * at delivery time, not at record time: a drain whose output is discarded
   * (crawl's pre-route attribution reset) must pass register=false so it
   * cannot mark a signature as reported that no one ever saw.
   */
  drain(register = true): OracleViolation[] {
    const out = this.buffer;
    this.buffer = [];
    // The attribution window belongs to the action that caused the block. A
    // delivered drain ends that action, so the window must not reach into the next one.
    if (register) this.lastPolicyBlockAt = null;
    for (const v of out) {
      // Same normalization as the report rollup, so "the same violation"
      // means the same thing in tool output and in the final report.
      // An embed's violation is not the app's: its signature says whose it is.
      const sig = `${v.embed ? `[${v.embed}] ` : ""}${v.kind}: ${v.detail
        .replace(/\b\d+\b/g, ":n")
        .replace(/[0-9a-f]{8,}/gi, ":h")
        .slice(0, 140)}`;
      v.repeat = this.reportedSigs.has(sig);
      if (register) {
        if (this.reportedSigs.size >= OracleMonitor.MAX_REPORTED_SIGS) {
          // Sets iterate in insertion order, so this drops the oldest half.
          const keep = [...this.reportedSigs].slice(OracleMonitor.MAX_REPORTED_SIGS / 2);
          this.reportedSigs = new Set(keep);
        }
        this.reportedSigs.add(sig);
      }
    }
    return out;
  }
}

export function formatViolations(violations: OracleViolation[]): string {
  if (violations.length === 0) return "";
  const fresh = violations.filter((v) => !v.repeat);
  const repeats = violations.length - fresh.length;
  const repeatLine = repeats > 0 ? `\n  ↻ plus ${repeats} repeat(s) of previously reported violations (still logged for the report)` : "";
  if (fresh.length === 0) {
    return `\nORACLE: ${repeats} repeat violation(s) of previously reported signatures — nothing new.`;
  }
  const lines = fresh
    .slice(0, 10)
    .map((v) => `  ⚠ [${v.severity}] ${v.kind}${v.embed ? ` (in an embed of ${v.embed}: its behaviour, not the app's)` : ""}: ${v.detail}`);
  const more = fresh.length > 10 ? `\n  … and ${fresh.length - 10} more` : "";
  return `\nORACLE VIOLATIONS since last action (${fresh.length} new):\n${lines.join("\n")}${more}${repeatLine}`;
}
