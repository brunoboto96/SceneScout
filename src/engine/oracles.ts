import type { Page } from "playwright";

export interface OracleViolation {
  kind: "console_error" | "page_error" | "request_failed" | "http_error";
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

  private record(v: Omit<OracleViolation, "at" | "repeat">): void {
    const violation: OracleViolation = { ...v, at: new Date().toISOString() };
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
    for (const v of out) {
      // Same normalization as the report rollup, so "the same violation"
      // means the same thing in tool output and in the final report.
      const sig = `${v.kind}: ${v.detail.replace(/\b\d+\b/g, ":n").replace(/[0-9a-f]{8,}/gi, ":h").slice(0, 140)}`;
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
    .map((v) => `  ⚠ [${v.severity}] ${v.kind}: ${v.detail}`);
  const more = fresh.length > 10 ? `\n  … and ${fresh.length - 10} more` : "";
  return `\nORACLE VIOLATIONS since last action (${fresh.length} new):\n${lines.join("\n")}${more}${repeatLine}`;
}
