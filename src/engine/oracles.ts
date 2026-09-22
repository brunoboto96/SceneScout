import type { Page, Request } from "playwright";
import type { Contradiction } from "./claims.js";
import { redactSecrets } from "./memory.js";

export interface OracleViolation {
  kind: "console_error" | "page_error" | "request_failed" | "http_error" | "dom_injection" | "refused_empty" | "false_success";
  severity: "high" | "medium";
  detail: string;
  url: string;
  at: string;
  /** True when this signature was already reported in full earlier this session — collapsed in tool output. */
  repeat?: boolean;
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
      this.record({
        kind: "console_error",
        severity: "high",
        detail: text.slice(0, 500),
        url: page.url(),
      });
    });

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
      if (this.refusedByPolicy(req)) {
        this.policyAttributed += 1;
        return;
      }
      this.record({
        kind: "request_failed",
        severity: "medium",
        detail: `${req.method()} ${req.url().slice(0, 200)} → ${failure}`,
        url: page.url(),
      });
    });

    page.on("response", (res) => {
      const status = res.status();
      if (status < 400) return;
      // Keep this filter consistent with the console oracle: a missing favicon
      // reported here on every page load teaches the driver to ignore http_error.
      if (BENIGN_URL_RE.test(res.url())) return;
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
        detail: `${res.request().method()} ${res.url().slice(0, 200)} → HTTP ${status}`,
        url: page.url(),
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

  private record(v: Omit<OracleViolation, "at" | "repeat">): void {
    if (isPolicyInduced(v, this.lastPolicyBlockAt === null ? null : Date.now() - this.lastPolicyBlockAt)) {
      this.policyAttributed += 1;
      return;
    }
    const violation: OracleViolation = { ...redactViolation(v), at: new Date().toISOString() };
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
      const sig = `${v.kind}: ${v.detail
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
  const lines = fresh.slice(0, 10).map((v) => `  ⚠ [${v.severity}] ${v.kind}: ${v.detail}`);
  const more = fresh.length > 10 ? `\n  … and ${fresh.length - 10} more` : "";
  return `\nORACLE VIOLATIONS since last action (${fresh.length} new):\n${lines.join("\n")}${more}${repeatLine}`;
}
