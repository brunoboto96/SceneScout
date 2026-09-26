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
import { failingSignatures, type Finding } from "./memory.js";

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

// ---------------------------------------------------------------------------
// Re-testing by page load, for `scenescout check`.
//
// The campaign above hands findings to an agent, who re-walks them with
// judgement. A check has none, so it re-tests only the findings whose
// reproduction is mechanical: the evidence names a GET that failed with a
// status, and the finding's repro shows nothing done on its page but looking
// at it. Loading that page again and watching the same request is then the
// whole reproduction, and its answer is a fact rather than an opinion.
// ---------------------------------------------------------------------------

/**
 * Actions that only look at a page. A repro whose steps on the finding's page
 * are all of these was reproduced by loading the page; any other step (a
 * click, a typed value, a replayed request, anything this list does not know)
 * means loading it is not the reproduction.
 */
const LOOK_ONLY = new Set([
  "attach",
  "navigate",
  "plan:navigate",
  "crawl",
  "back",
  "snapshot",
  "screenshot",
  "design-audit",
  "task",
  "journey:start",
  "journey:end",
  "record:full",
]);

/** A finding a check can re-test by loading one page. */
export interface LoadRetest {
  item: VerifyItem;
  /** The page to load: the path and query it was filed on. */
  path: string;
  /** The failing GET signatures (`GET /api/x 500`, paths normalised) it names. */
  signatures: string[];
}

/** How the finding's page is reached again, or null when a check cannot re-test it deterministically. */
export function loadRetest(item: VerifyItem): LoadRetest | null {
  const signatures = [...failingSignatures(item.evidence)];
  // A POST that failed is not re-sent by loading a page, and a check would refuse to send it anyway.
  if (signatures.length === 0 || signatures.some((s) => !s.startsWith("GET "))) return null;
  // The first repro line is how the page was reached; every later one happened on it.
  if (item.repro.length === 0) return null;
  for (const line of item.repro.slice(1)) {
    if (!LOOK_ONLY.has(line.split(/\s/, 1)[0])) return null;
  }
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }
  // A secret was redacted out of the stored URL: loading what is left is a different page.
  if (/redacted/i.test(item.url)) return null;
  return { item, path: `${url.pathname}${url.search}`, signatures };
}

export const RETEST_VERDICTS = ["reproduces", "possibly-fixed", "not-reached"] as const;
export type RetestVerdict = (typeof RETEST_VERDICTS)[number];

export interface CheckRetest {
  id: string;
  severity: string;
  title: string;
  path: string;
  signatures: string[];
  verdict: RetestVerdict;
  /** Why it was not reached, when it was not. */
  note?: string;
}

/** What a page load measured, reduced to what a re-test compares. */
export interface MeasuredPage {
  path: string;
  status: number | null;
  loadError?: string;
  loginRedirect: boolean;
  /** Details of the http_error violations seen while it loaded. */
  httpErrors: string[];
}

/**
 * Each re-testable finding against the page load that re-tests it.
 *
 * `reproduces` when the load saw one of the finding's failing requests fail
 * with the same status; `possibly-fixed` when the page loaded and none did —
 * possibly, because the page may simply not have asked this time; and
 * `not-reached` when the page did not load or bounced to sign-in, which says
 * nothing about the finding either way.
 */
export function retestResults(candidates: readonly LoadRetest[], pages: readonly MeasuredPage[]): CheckRetest[] {
  return candidates.map(({ item, path, signatures }) => {
    const base = { id: item.id, severity: item.severity, title: item.title, path, signatures };
    const page = pages.find((p) => p.path === path);
    if (!page) return { ...base, verdict: "not-reached", note: "the page was not visited" };
    if (page.loadError !== undefined) return { ...base, verdict: "not-reached", note: "the page did not load" };
    if (page.loginRedirect) return { ...base, verdict: "not-reached", note: "the page sent the browser to sign-in" };
    const seen = new Set<string>();
    for (const detail of page.httpErrors) for (const s of failingSignatures(detail)) seen.add(s);
    // The document's own failure is left out of the violations (withoutOwnResponse), so it is added back here.
    if (page.status !== null && page.status >= 400) for (const s of failingSignatures(`GET ${page.path.split("?")[0]} ${page.status}`)) seen.add(s);
    return { ...base, verdict: signatures.some((s) => seen.has(s)) ? "reproduces" : "possibly-fixed" };
  });
}

/**
 * The findings a check re-tests: the open ones it can reproduce by loading a
 * page, in the campaign's order and within its cap, plus how many open
 * findings there are in all, so the report can say how many it left to a run.
 */
export function checkRetestPlan(findings: readonly Finding[]): { candidates: LoadRetest[]; open: number } {
  const open = findings.filter((f) => (f.status ?? "open") !== "resolved");
  const eligible = open.filter((f) => loadRetest(item(f)) !== null);
  const candidates = verifyWorklist(eligible)
    .map(loadRetest)
    .filter((c): c is LoadRetest => c !== null);
  return { candidates, open: open.length };
}

/**
 * The entries of a memory file's findings list a re-test can read. The file is
 * JSON someone may have edited; an entry missing the fields the rules read is
 * left out rather than failing the check, which only ever reports re-tests.
 */
export function wellFormedFindings(list: readonly unknown[]): Finding[] {
  return list.filter((f): f is Finding => {
    if (typeof f !== "object" || f === null) return false;
    const x = f as Record<string, unknown>;
    return (
      typeof x.id === "string" &&
      typeof x.url === "string" &&
      typeof x.title === "string" &&
      typeof x.severity === "string" &&
      (x.evidence === undefined || typeof x.evidence === "string") &&
      Array.isArray(x.repro) &&
      x.repro.every((r) => typeof r === "string")
    );
  });
}
