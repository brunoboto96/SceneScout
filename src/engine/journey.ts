/**
 * Task-ease measurement: what did it COST a user to get one thing done?
 *
 * A passing end-to-end test says a flow works; it says nothing about how many
 * screens, interactions and wrong turns the flow takes. These numbers are
 * derived purely from the action log, so the thresholds and the verdict wording
 * are table-tested here instead of being reachable only through a browser.
 */
import { normalizePath } from "./fingerprint.js";
import type { ActionLogEntry } from "./memory.js";

/** More distinct screens than this for one task is worth questioning. */
const MANY_SCREENS = 4;
/** More interactions than this for one task is worth questioning. */
const MANY_INTERACTIONS = 15;

export interface JourneyMeasure {
  interactions: number;
  navigations: number;
  /** Routes in visit order, consecutive repeats collapsed. */
  routeSeq: string[];
  distinctScreens: number;
  /** Returns to a route already left behind — the clearest sign the next step was not discoverable. */
  backtracks: number;
  /** Direct-URL jumps: a first-time user cannot type URLs, so these contaminate the measurement. */
  shortcuts: number;
  policyBlocks: number;
  refusals: number;
  verdict: string[];
}

function routeOf(url: string): string {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return url;
  }
}

/** Measure one journey from the slice of the action log that belongs to it. */
export function measureJourney(log: ActionLogEntry[], completed: boolean): JourneyMeasure {
  const interactions = log.filter((e) => /^(click|type|select|press|plan:(click|type|select|press))/.test(e.action)).length;
  const navigations = log.filter((e) => /^(navigate|back|plan:navigate|plan:back)/.test(e.action)).length;
  const routeSeq = log.map((e) => routeOf(e.url)).filter((r, i, a) => i === 0 || r !== a[i - 1]);
  const distinctScreens = new Set(routeSeq).size;
  // A backtrack = returning to a route already left behind. Real users do
  // this when the path wasn't obvious; it is the clearest signal that
  // information scent failed, and it is invisible to a pass/fail test.
  const seen = new Set<string>();
  let backtracks = 0;
  for (const r of routeSeq) {
    if (seen.has(r)) backtracks += 1;
    seen.add(r);
  }
  const policyBlocks = log.filter((e) => e.action === "write-policy:blocked").length;
  const refusals = log.filter((e) => /refused|REFUSED/.test(e.result ?? "")).length;
  const shortcuts = log.filter((e) => /^(navigate|plan:navigate)$/.test(e.action)).length;

  const verdict: string[] = [];
  if (backtracks > 0)
    verdict.push(
      `⚠ ${backtracks} backtrack(s) — the route was re-visited after leaving it, which usually means the next step wasn't discoverable from where the user was`,
    );
  if (distinctScreens > MANY_SCREENS)
    verdict.push(
      `⚠ ${distinctScreens} distinct screens for one task — each hand-off is a chance to lose the user; consider whether steps can be combined or done in place`,
    );
  if (interactions > MANY_INTERACTIONS)
    verdict.push(`⚠ ${interactions} interactions — high for a single task; check for over-asking (optional fields up-front) or repeated confirmation steps`);
  if (shortcuts > 0)
    verdict.push(
      `⚠ ${shortcuts} direct-URL jump(s) during the journey — a first-time user cannot type URLs, so the measurement is contaminated: either re-run clicking through the UI, or the destination is unreachable by UI navigation (which is itself a finding).`,
    );
  if (!completed) verdict.push(`⚠ TASK NOT COMPLETED — this is the strongest possible finding: the journey is blocked or undiscoverable. File it.`);
  if (verdict.length === 0) verdict.push(`✓ efficient — direct path, no backtracking, proportionate interaction count`);

  return { interactions, navigations, routeSeq, distinctScreens, backtracks, shortcuts, policyBlocks, refusals, verdict };
}

/** The tool result for a finished journey. */
export function formatJourney(j: { goal: string; completed: boolean; seconds: number; note?: string }, m: JourneyMeasure): string {
  return [
    `JOURNEY ${j.completed ? "COMPLETED" : "ABANDONED"} — "${j.goal}"`,
    ``,
    `Interaction cost: ${m.interactions} interactions · ${m.navigations} navigations · ${m.distinctScreens} distinct screens · ${j.seconds}s`,
    `Path: ${m.routeSeq.slice(0, 12).join(" → ")}${m.routeSeq.length > 12 ? " → …" : ""}`,
    ...(m.policyBlocks > 0 || m.refusals > 0 ? [`Policy: ${m.policyBlocks} write-policy blocks, ${m.refusals} refusals (tester safety, not app defects)`] : []),
    ...(j.note ? [`Note: ${j.note}`] : []),
    ``,
    `Efficiency read:`,
    ...m.verdict.map((v) => `  ${v}`),
    ``,
    `Judge with product context: a 3-screen approval flow with an e-signature step is legitimately longer than "add a comment". Compare against what the task NEEDS, then file genuine friction as ux-confusing (blocked/undiscoverable) or ux-polish (works but costs more than it should), quoting these numbers.`,
  ].join("\n");
}
