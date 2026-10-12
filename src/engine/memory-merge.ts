/**
 * Folding another process's memory file into this one's (mergeMemory), and the
 * helpers it shares with the store: moving a state's element keys between name
 * rules, and the unions of judged merges, lane routes and lane decisions.
 * Split from memory.ts; memory.ts re-exports the public names, so importers are
 * unchanged. The values imported from memory.ts are used only when a merge
 * runs, never as this module loads, so the two modules may import each other.
 */
import type { RecordedDecision } from "./calibration.js";
import { laneRoutePaths } from "./fingerprint.js";
import { readFromRunNotes, readRunRecords, unionFromRunNotes, unionRecords } from "./from-run.js";
import {
  isWorthALook,
  judgedMergesOf,
  MAX_JUDGED_MERGES,
  MAX_LANE_DECISIONS,
  mergeTier,
  routeIdentity,
  seenOnOf,
  withoutTier,
  withSeenOn,
  type Finding,
  type JudgedMerge,
  type MemoryFile,
  type StateRecord,
} from "./memory.js";
import { mergeTicketData } from "./tickets.js";

/**
 * A state's elements under current keys: each key the route's aliases name
 * (earlier key → current key) is moved, all at once, so two keys that swap
 * places do not chain. Where two entries land on one key, exercised is kept
 * from either.
 */
export function rekeyed(elements: StateRecord["elements"], aliases: Readonly<Record<string, string>> | undefined): StateRecord["elements"] {
  if (!aliases) return elements;
  const out: StateRecord["elements"] = {};
  for (const [raw, entry] of Object.entries(elements)) {
    const key = Object.hasOwn(aliases, raw) ? aliases[raw] : raw;
    const prev = out[key];
    out[key] = prev ? { ...prev, ...entry, exercised: prev.exercised || entry.exercised } : entry;
  }
  return out;
}

/** A route's aliases for the step that leads to `rule`: key under rule - 1 → key under rule. */
function stepAliases(data: MemoryFile, rule: number, route: string): Readonly<Record<string, string>> | undefined {
  return rule === 2 ? data.keyAliases?.[route] : data.ruleKeyAliases?.[String(rule)]?.[route];
}

/**
 * A state's elements moved from the keys of name rule `from` to those of rule
 * `to`, one step at a time, each through the route's aliases for that step.
 */
export function keysUnderRule(elements: StateRecord["elements"], from: number, to: number, data: MemoryFile, route: string): StateRecord["elements"] {
  let out = elements;
  for (let rule = from + 1; rule <= to; rule++) out = rekeyed(out, stepAliases(data, rule, route));
  return out;
}

/**
 * Fold another process's memory into ours, losing nothing from either side.
 *
 * Two SceneScout processes on one project each hold a full snapshot and each
 * write the whole document, so whoever flushed last silently erased the
 * other's findings — a run could finish with a report that omits half of what
 * was found, with no error anywhere. Rather than lock (which would have to
 * survive crashes), re-read before writing and merge.
 *
 * Every rule is idempotent, because a flush may merge the same foreign state
 * repeatedly: counters take the MAX rather than summing, booleans OR, and sets
 * union. Summing would inflate run counts on every subsequent flush.
 */
export function mergeMemory(mine: MemoryFile, theirs: MemoryFile): MemoryFile {
  const out: MemoryFile = { ...theirs, ...mine, version: 1 };

  out.keyAliases = { ...(theirs.keyAliases ?? {}) };
  for (const [route, aliases] of Object.entries(mine.keyAliases ?? {})) {
    // The first reading stands (MemoryStore learnAliases): what is already on disk wins.
    out.keyAliases[route] = { ...aliases, ...(out.keyAliases[route] ?? {}) };
  }
  if (Object.keys(out.keyAliases).length === 0) delete out.keyAliases;
  out.ruleKeyAliases = {};
  for (const rule of new Set([...Object.keys(theirs.ruleKeyAliases ?? {}), ...Object.keys(mine.ruleKeyAliases ?? {})])) {
    const step: Record<string, Record<string, string>> = { ...(theirs.ruleKeyAliases?.[rule] ?? {}) };
    for (const [route, aliases] of Object.entries(mine.ruleKeyAliases?.[rule] ?? {})) step[route] = { ...aliases, ...(step[route] ?? {}) };
    out.ruleKeyAliases[rule] = step;
  }
  if (Object.keys(out.ruleKeyAliases).length === 0) delete out.ruleKeyAliases;

  out.states = { ...theirs.states };
  for (const [fp, ours] of Object.entries(mine.states)) {
    const other = theirs.states[fp];
    if (!other) {
      out.states[fp] = ours;
      continue;
    }
    const nameRule = Math.max(ours.nameRule ?? 0, other.nameRule ?? 0);
    // When one side is under a later name rule than the other, the other's
    // keys are moved to that rule's before the union, as a revisit moves them
    // (MemoryStore visitState).
    const current = (side: StateRecord) => keysUnderRule(side.elements, side.nameRule ?? 1, Math.max(nameRule, 1), out, routeIdentity(side.route));
    const elements = { ...current(other) };
    for (const [key, el] of Object.entries(current(ours))) {
      const prev = elements[key];
      elements[key] = {
        exercised: (prev?.exercised ?? false) || el.exercised,
        // Keep whichever action was actually recorded; ours wins a tie.
        ...((el.lastAction ?? prev?.lastAction) ? { lastAction: el.lastAction ?? prev?.lastAction } : {}),
        absentStreak: Math.min(prev?.absentStreak ?? 0, el.absentStreak ?? 0),
        // Ours is the latest reading of whether a user can act on it.
        ...(el.inert ? { inert: true } : {}),
      };
    }
    out.states[fp] = {
      ...ours,
      firstSeen: ours.firstSeen < other.firstSeen ? ours.firstSeen : other.firstSeen,
      visits: Math.max(ours.visits, other.visits),
      elements,
      ...(nameRule ? { nameRule } : {}),
    };
  }

  const byId = new Map<string, Finding>();
  for (const f of theirs.findings) byId.set(f.id, f);
  for (const f of mine.findings) {
    const other = byId.get(f.id);
    if (!other) {
      byId.set(f.id, f);
      continue;
    }
    // Later knowledge wins on the mutable fields; a resolution is only kept if
    // the other side did not go on to re-find it as a regression.
    const newer = f.foundAt >= other.foundAt ? f : other;
    const older = newer === f ? other : f;
    const merged: Finding = {
      ...newer,
      runs: Math.max(f.runs, other.runs),
      evidence: newer.evidence ?? older.evidence,
      regressedAt: newer.regressedAt ?? older.regressedAt,
    };
    // A picture and its shot travel together, from whichever side has one, the newer first.
    const pictured = newer.picture ? newer : older.picture ? older : null;
    delete merged.picture;
    delete merged.pictureShot;
    if (pictured?.picture) {
      merged.picture = pictured.picture;
      if (pictured.pictureShot) merged.pictureShot = pictured.pictureShot;
    }
    // The tier is not "later knowledge wins": a defect on either side is a decision
    // about the convention, and a store still holding the worth-a-look must not undo it.
    const tier = mergeTier(older, newer);
    Object.assign(withoutTier(merged), tier);
    if (!isWorthALook(merged) && isWorthALook(newer)) merged.severity = older.severity;
    // Each side's judged merges are a record of filings, not later knowledge: kept from both.
    const trail = unionJudgedMerges(f, other);
    if (trail) merged.judgedMerges = trail;
    else delete merged.judgedMerges;
    // So are the routes each side saw it on.
    const seenOn = withSeenOn(older, seenOnOf(newer));
    if (seenOn) merged.seenOn = seenOn;
    else delete merged.seenOn;
    byId.set(f.id, merged);
  }
  out.findings = [...byId.values()];

  const unionRecord = <T>(a?: Record<string, T>, b?: Record<string, T>): Record<string, T> | undefined => (a || b ? { ...(b ?? {}), ...(a ?? {}) } : undefined);
  out.discoveredRoutes = unionRecord(mine.discoveredRoutes, theirs.discoveredRoutes);
  out.attemptedRoutes = unionRecord(mine.attemptedRoutes, theirs.attemptedRoutes);
  out.resourceRoutes = unionRecord(mine.resourceRoutes, theirs.resourceRoutes);
  out.designElements = unionRecord(mine.designElements, theirs.designElements);

  out.pageScores = { ...(theirs.pageScores ?? {}) };
  for (const [route, score] of Object.entries(mine.pageScores ?? {})) {
    const other = out.pageScores[route];
    if (!other || score.at >= other.at) out.pageScores[route] = score;
  }
  if (Object.keys(out.pageScores).length === 0) delete out.pageScores;

  out.routeFacts = { ...(theirs.routeFacts ?? {}) };
  for (const [route, facts] of Object.entries(mine.routeFacts ?? {})) {
    const other = out.routeFacts[route] ?? {};
    out.routeFacts[route] = {
      audited: facts.audited || other.audited || undefined,
      mutated: facts.mutated || other.mutated || undefined,
      journeys: Math.max(facts.journeys ?? 0, other.journeys ?? 0) || undefined,
      journeysCompleted: Math.max(facts.journeysCompleted ?? 0, other.journeysCompleted ?? 0) || undefined,
    };
  }
  if (Object.keys(out.routeFacts).length === 0) delete out.routeFacts;

  // Per endpoint, the later of the two: a clear in one process outlasts an older refusal in another.
  out.observeRefusedPosts = { ...(theirs.observeRefusedPosts ?? {}) };
  for (const [route, endpoints] of Object.entries(mine.observeRefusedPosts ?? {})) {
    const merged = { ...(out.observeRefusedPosts[route] ?? {}) };
    for (const [endpoint, rec] of Object.entries(endpoints)) if (!merged[endpoint] || rec.at >= merged[endpoint].at) merged[endpoint] = rec;
    out.observeRefusedPosts[route] = merged;
  }
  if (Object.keys(out.observeRefusedPosts).length === 0) delete out.observeRefusedPosts;

  out.roleAccess = { ...(theirs.roleAccess ?? {}) };
  for (const [role, routes] of Object.entries(mine.roleAccess ?? {})) {
    out.roleAccess[role] = { ...(out.roleAccess[role] ?? {}), ...routes };
  }
  if (Object.keys(out.roleAccess).length === 0) delete out.roleAccess;

  // Lanes commonly run in SEPARATE processes — that is the point of a lane —
  // so without this the spread at the top would keep one process's decisions
  // and drop every other lane's, which is the exact bug this merge exists to
  // prevent for findings. Keyed so merging the same foreign document twice is
  // idempotent.
  const byDecision = new Map<string, RecordedDecision>();
  for (const d of theirs.laneDecisions ?? []) byDecision.set(decisionKey(d), d);
  for (const d of mine.laneDecisions ?? []) byDecision.set(decisionKey(d), d);
  out.laneDecisions = [...byDecision.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_LANE_DECISIONS);
  if (out.laneDecisions.length === 0) delete out.laneDecisions;

  // The same reason as decisions: each lane folds in its own process. A set
  // union per lane, so merging the same document twice changes nothing.
  out.laneRoutes = { ...(theirs.laneRoutes ?? {}) };
  for (const [lane, routes] of Object.entries(mine.laneRoutes ?? {})) {
    out.laneRoutes[lane] = unionRoutes(out.laneRoutes[lane] ?? [], routes);
  }
  if (Object.keys(out.laneRoutes).length === 0) delete out.laneRoutes;

  // A ci run notes what it started from in its own process, beside the server's writes: a union, as for decisions.
  const records = unionRecords(readRunRecords(theirs), readRunRecords(mine));
  if (records.length > 0) out.runRecords = records;
  else delete out.runRecords;
  const notes = unionFromRunNotes(readFromRunNotes(theirs), readFromRunNotes(mine));
  if (notes.length > 0) out.fromRuns = notes;
  else delete out.fromRuns;

  // Lanes record criterion verdicts in their own processes too.
  const ticketData = mergeTicketData(mine, theirs);
  if (ticketData.tickets) out.tickets = ticketData.tickets;
  else delete out.tickets;
  if (ticketData.criterionVerdicts) out.criterionVerdicts = ticketData.criterionVerdicts;
  else delete out.criterionVerdicts;

  return out;
}

/** Two findings' judged merges as one list, each filing once, oldest first, at most MAX_JUDGED_MERGES. Idempotent. */
export function unionJudgedMerges(a: Pick<Finding, "judgedMerges">, b: Pick<Finding, "judgedMerges">): JudgedMerge[] | undefined {
  const all = [...judgedMergesOf(b), ...judgedMergesOf(a)];
  if (all.length === 0) return undefined;
  const byKey = new Map<string, JudgedMerge>();
  for (const m of all) byKey.set(`${m.at}\u0000${m.title}`, m);
  return [...byKey.values()].sort((x, y) => x.at.localeCompare(y.at)).slice(-MAX_JUDGED_MERGES);
}

/** Most routes kept per lane. A lane report carries at most a few hundred; this keeps a long-lived project's file small. */
export const MAX_LANE_ROUTES = 255;

/**
 * `b` added to `a`. Two routes naming the same page(s) are one — the later
 * wording wins — and past the cap the NEWEST are kept: a long-lived project
 * reuses lane names, and what a lane covers now is what a new verdict is
 * judged against.
 */
export function unionRoutes(a: readonly string[], b: readonly string[]): string[] {
  const byPage = new Map<string, string>();
  for (const r of [...a, ...b]) {
    const paths = laneRoutePaths(r);
    const id = paths.length ? paths.sort().join(" ") : `text:${r}`;
    byPage.delete(id);
    byPage.set(id, r);
  }
  return [...byPage.values()].slice(-MAX_LANE_ROUTES);
}
/**
 * What makes two stored decisions the same judgement.
 *
 * Deliberately NOT the timestamp. `at` is stamped when the planner folds the
 * reply, not when the lane judged, so relaying one reply twice — which the
 * protocol invites, since a refused report is asked for again — wrote every
 * decision a second time and doubled the lane's weight in the calibration.
 * Identity is what was decided, so re-folding the same reply is a no-op.
 */
export function decisionKey(d: RecordedDecision): string {
  return [d.lane, d.observation, d.verdict, d.severity ?? "", d.category ?? "", d.confidence, d.evidence ?? ""].join("|");
}
