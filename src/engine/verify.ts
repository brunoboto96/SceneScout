/**
 * Re-testing findings a previous run left open.
 *
 * The report has always carried two kinds of finding and been honest that they
 * are not the same thing: what this run saw, and what some earlier run saw.
 * The second kind is labelled historical and unverified, which is accurate and
 * almost useless — a reader cannot tell a bug fixed three weeks ago from one
 * that is still costing users money today, and neither can the next run.
 *
 * Closing that gap by hand is possible and nobody does it. It means opening
 * the report, copying each finding's route and evidence, re-walking them one
 * at a time, and calling `scout_resolve` on the ones that are gone — per
 * finding, for as many as the history holds. One project's history held over
 * three hundred.
 *
 * So the campaign is a tool. Asked for a worklist, it hands back the open
 * findings in the order a run should re-test them: by severity, grouped so a
 * route is walked once rather than once per finding, each with the evidence
 * that identifies it and the steps that produced it. Asked to record a
 * verdict, it stamps what was seen and when, so the next report can say
 * "confirmed still present" with a date instead of "unverified".
 *
 * Pure, so the ordering and the wording can be table-tested.
 */
import { normalizePath } from "./fingerprint.js";
import type { Finding } from "./memory.js";

/** What a re-test found. */
export const VERDICTS = ["gone", "present", "changed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_MEANING: Record<Verdict, string> = {
  gone: "re-tested and the evidence no longer reproduces — resolved",
  present: "re-tested and still reproduces exactly as filed",
  changed: "re-tested and something is different — still broken, but not as described",
};

/** Most findings a single campaign hands over at once. A worklist longer than this is a plan nobody follows. */
export const MAX_WORKLIST = 25;

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** A finding to re-test, with everything needed to do it. */
export interface VerifyItem {
  id: string;
  severity: string;
  category: string;
  title: string;
  route: string;
  url: string;
  evidence: string;
  repro: readonly string[];
  foundAt: string;
  /** How many runs have seen it. A finding seen across several runs is not a fluke. */
  runs: number;
  lastVerdict?: Verdict;
  lastVerifiedAt?: string;
}

function item(f: Finding): VerifyItem {
  return {
    id: f.id,
    severity: f.severity,
    category: f.category,
    title: f.title,
    route: normalizePath(f.url),
    url: f.url,
    evidence: f.evidence ?? "",
    repro: f.repro ?? [],
    foundAt: f.foundAt,
    runs: f.runs ?? 1,
    ...(f.verdict ? { lastVerdict: f.verdict } : {}),
    ...(f.verifiedAt ? { lastVerifiedAt: f.verifiedAt } : {}),
  };
}

/**
 * The findings to re-test, in the order to do it.
 *
 * Severity decides what matters; route groups what is cheap, because walking
 * one route and checking four findings on it costs a fraction of walking four
 * routes. Within a route, a finding never verified comes before one verified
 * before — re-checking the same finding twice while another has never been
 * looked at is the failure mode this ordering exists to prevent.
 */
export function verifyWorklist(findings: readonly Finding[], ids?: readonly string[]): VerifyItem[] {
  const wanted = ids && ids.length > 0 ? new Set(ids) : null;
  const open = findings.filter((f) => (f.status ?? "open") !== "resolved").filter((f) => (wanted ? wanted.has(f.id) : true));

  // The severity of a route is its worst finding: a route carrying a high is
  // walked before one carrying three mediums.
  const worst = new Map<string, number>();
  for (const f of open) {
    const route = normalizePath(f.url);
    const rank = SEVERITY_ORDER[f.severity] ?? 3;
    worst.set(route, Math.min(worst.get(route) ?? 9, rank));
  }

  return open
    .map(item)
    .sort(
      (a, b) =>
        (worst.get(a.route) ?? 9) - (worst.get(b.route) ?? 9) ||
        a.route.localeCompare(b.route) ||
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
        Number(Boolean(a.lastVerifiedAt)) - Number(Boolean(b.lastVerifiedAt)) ||
        (a.lastVerifiedAt ?? "").localeCompare(b.lastVerifiedAt ?? "") ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_WORKLIST);
}

/** Ids the caller asked for that no open finding matches — a silently short worklist is worse than a named miss. */
export function unknownIds(findings: readonly Finding[], ids: readonly string[]): string[] {
  const open = new Set(findings.filter((f) => (f.status ?? "open") !== "resolved").map((f) => f.id));
  return ids.filter((id) => !open.has(id));
}

/** The campaign brief the agent works down. */
export function formatWorklist(items: readonly VerifyItem[], missing: readonly string[] = []): string {
  if (items.length === 0) {
    return missing.length > 0
      ? `Nothing to verify. No OPEN finding matches: ${missing.join(", ")}. They may already be resolved, or belong to another project's memory.`
      : "Nothing to verify — no open findings in this project's memory.";
  }
  const lines = [
    `VERIFY CAMPAIGN — ${items.length} open finding(s) to re-test, worst route first.`,
    `Re-test each one, then record what you saw: scout_verify { id, verdict: "gone" | "present" | "changed", note }.`,
    `"gone" resolves it. "present" stamps it confirmed, so the report stops calling it unverified. "changed" keeps it open and says what differs.`,
    ``,
  ];
  let route = "";
  for (const it of items) {
    if (it.route !== route) {
      route = it.route;
      lines.push(`── ${route} ──`);
    }
    const seen = it.lastVerifiedAt ? ` · last re-tested ${it.lastVerifiedAt.slice(0, 10)} (${it.lastVerdict})` : " · never re-tested";
    lines.push(`[${it.severity}] ${it.id} ${it.title}`);
    lines.push(`  ${it.category} · found ${it.foundAt.slice(0, 10)} · ${it.runs} run(s)${seen}`);
    if (it.evidence) lines.push(`  evidence: ${it.evidence}`);
    if (it.repro.length > 0) lines.push(`  repro: ${it.repro.slice(0, 6).join(" → ")}`);
    lines.push(`  at: ${it.url}`);
  }
  if (missing.length > 0) lines.push(``, `No OPEN finding matches: ${missing.join(", ")}.`);
  return lines.join("\n");
}

/** Whether a verdict resolves the finding it is recorded against. */
export function resolvesFinding(verdict: Verdict): boolean {
  return verdict === "gone";
}

/** What the agent reads back after recording one. */
export function describeVerdict(f: { id: string; severity: string; title: string }, verdict: Verdict, note?: string): string {
  const tail = note ? `\n  ${note}` : "";
  if (verdict === "gone") return `Resolved by re-test: [${f.severity}] ${f.title} (${f.id}).${tail}`;
  if (verdict === "present")
    return `Confirmed still present: [${f.severity}] ${f.title} (${f.id}). It stays open, and the report now dates the confirmation instead of calling it unverified.${tail}`;
  return `Still open and changed: [${f.severity}] ${f.title} (${f.id}). Re-file the difference as its own finding if the behaviour is now a different bug.${tail}`;
}

/** How a verified finding reads in the report, or nothing when it was never re-tested. */
export function sayVerification(f: { verdict?: Verdict; verifiedAt?: string }): string {
  if (!f.verdict || !f.verifiedAt) return "";
  const on = f.verifiedAt.slice(0, 10);
  if (f.verdict === "present") return ` · confirmed still present on ${on}`;
  if (f.verdict === "changed") return ` · re-tested ${on}, behaviour has changed since it was filed`;
  return ` · re-tested ${on}`;
}
