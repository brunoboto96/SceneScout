import fs from "node:fs";
import path from "node:path";
import type { RecordedDecision } from "./calibration.js";
import { normalizePath, shortHash } from "./fingerprint.js";
import { isFormBookkeeping } from "./forms.js";
import type { InjectionProbe } from "./injection.js";

export interface StateRecord {
  url: string;
  route: string;
  firstSeen: string;
  /** When it was last reached. Absent on records written before pruning existed; they fall back to firstSeen. */
  lastSeen?: string;
  visits: number;
  /** elementKey → exercised? absentStreak counts consecutive visits where the element was gone (pruned at 3). */
  elements: Record<string, { exercised: boolean; lastAction?: string; absentStreak?: number }>;
}

/**
 * The kinds a finding can be. One list: scout_finding's input schema, the lane
 * report a parallel agent hands back, and the skill text all read it from
 * here, so a category cannot exist in one and be refused by another.
 */
export const FINDING_CATEGORIES = [
  "console-error",
  "page-error",
  "http-error",
  "network",
  "dead-end",
  "ux-confusing",
  "ux-polish",
  "visual",
  "a11y",
  "permission-leak",
  "data-inconsistency",
  "stale-state",
  "data-loss",
  "performance",
  "security",
  "missing-testid",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface Finding {
  id: string;
  severity: "high" | "medium" | "low";
  /** One of FINDING_CATEGORIES; kept as a string because findings read back from disk predate the list. */
  category: string;
  title: string;
  detail: string;
  /** Canonical machine signature (e.g. "GET /api/x 403") — primary cross-run dedup key. */
  evidence?: string;
  url: string;
  state: string;
  repro: string[];
  foundAt: string;
  runs: number;
  status?: "open" | "resolved";
  /** Set when a previously resolved finding was re-found — a regression. */
  regressedAt?: string;
  /**
   * The session that filed it. Several browsers run at once, so the frames
   * that were on screen while it was found are that session's, not whichever
   * lane happened to act in the same second.
   */
  session?: string;
  /** What the last re-test of this finding found. Absent means nobody has re-tested it. */
  verdict?: "gone" | "present" | "changed";
  /** When that re-test happened, so the report can date a confirmation rather than calling it unverified. */
  verifiedAt?: string;
  /** What the re-tester saw, in their words. */
  verifyNote?: string;
}

/**
 * Most states a route may keep. A route accumulates one state per distinct
 * element set, so a register with filters, tabs and paging produces dozens;
 * one project reached 6,075 states across 48 routes, a 36 MB history parsed
 * and re-serialised on every save. Coverage is asked per ROUTE, so keeping the
 * most recent states of each route preserves every answer the gap ledger
 * needs while dropping the long tail nothing will ask about again.
 */
export const MAX_STATES_PER_ROUTE = 40;

/**
 * The states to keep. Never drops one a finding points at — a finding's repro
 * trace and its route identity are read back from it — and never drops the
 * newest of a route, so a route that was visited stays visited.
 *
 * Returns the pruned map rather than mutating, so the rule can be table-tested.
 */
export function pruneStates(
  states: Readonly<Record<string, StateRecord>>,
  findings: ReadonlyArray<{ state: string }>,
  perRoute = MAX_STATES_PER_ROUTE,
): { kept: Record<string, StateRecord>; dropped: number } {
  const pinned = new Set(findings.map((f) => f.state));
  const byRoute = new Map<string, Array<[string, StateRecord]>>();
  for (const entry of Object.entries(states)) {
    const route = entry[1].route;
    const list = byRoute.get(route);
    if (list) list.push(entry);
    else byRoute.set(route, [entry]);
  }
  const kept: Record<string, StateRecord> = {};
  let dropped = 0;
  for (const list of byRoute.values()) {
    // Newest first, so the survivors are the ones a next run will meet again.
    list.sort((a, b) => (b[1].lastSeen ?? b[1].firstSeen).localeCompare(a[1].lastSeen ?? a[1].firstSeen));
    list.forEach(([fp, rec], index) => {
      if (index < perRoute || pinned.has(fp)) kept[fp] = rec;
      else dropped += 1;
    });
  }
  return { kept, dropped };
}

/** An element class must appear on this many routes at minimum before it can count as shared chrome. */
const CHROME_MIN_ROUTES = 4;
/** …and on at least this share of all visited routes (a majority — "it's on every page"). */
const CHROME_ROUTE_SHARE = 0.6;
/**
 * …OR on this many routes outright. A section shell (an admin sub-nav across 35
 * of 99 routes) is below the majority share but is still one component repeated,
 * not 35 separate surfaces.
 */
const CHROME_ABSOLUTE_ROUTES = 10;
/** Pseudo-route the deduplicated shell surface is reported under. */
export const SHARED_CHROME_ROUTE = "(shared layout chrome)";

/**
 * Outcome prefix for "this navigation was bounced to a login page".
 *
 * Distinct from a permission redirect on purpose. A permission redirect is a
 * true fact about the app that should satisfy the completion contract for that
 * role; an auth-loss bounce is a fact about OUR credentials expiring, and
 * counting it as coverage let one dead token certify every route a run had not
 * reached yet.
 */
export const AUTH_LOSS_PREFIX = "authloss:";

/**
 * Paths that look like a login screen.
 *
 * Duplicated deliberately rather than imported: memory.ts is the storage layer
 * and must not depend on the engine layer. The duplication is not left on
 * trust — policy-test.ts compares the two patterns' sources directly and fails
 * if they drift, which the previous "kept in sync by the migration test"
 * comment claimed but no test actually did.
 */
export const LOGIN_ROUTE_RE_STORAGE = /\/(login|signin|sign-in|auth)(\/|$)/;
const LOGIN_ROUTE_RE = LOGIN_ROUTE_RE_STORAGE;

/**
 * Key an attempted route by the role that attempted it.
 *
 * No separator character: the role comes from the auth fixture's BASENAME, so
 * it can never contain "/", and every route starts with one. Splitting at the
 * first "/" is therefore unambiguous. A space looked like the obvious
 * separator and was wrong — `qa admin.json` yields the role "qa admin", whose
 * key would split into a role "qa" that does not exist, quietly crediting that
 * route's coverage to the wrong identity.
 */
function roleRouteKey(role: string, route: string): string {
  return `${role}${route.startsWith("/") ? "" : "/"}${route}`;
}

/**
 * Secrets an app leaks into its own error UI must not be re-published by the
 * tool that found them. Findings quote app output verbatim, and that output has
 * in practice included partial provider API keys; `.scenescout/` is gitignored
 * but still gets zipped and attached to tickets. Keep a short prefix so the
 * finding stays actionable, drop the rest.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Needs the environment marker (sk_live_…) or a digit in the tail, or it
  // eats ordinary identifiers: "pk_customer_identifier" became "pk_[redacted]".
  [/\b(sk|pk|rk)[-_](?:(?:live|test|proj)[-_][A-Za-z0-9]{8,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,})/g, "$1_[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh?_[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "AKIA[redacted]"],
  // Keep the scheme that actually matched: rewriting a Basic-auth finding to
  // say "Bearer" silently changes what the finding claims.
  // Same entropy requirement as the keyword rule: "Basic authentication-required"
  // is prose, and redacting it rewrote a sentence into nonsense.
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9._-]{20,}/g, "eyJ[redacted-jwt]"],
  // Keyword-led values need an entropy signal — a digit AND a letter, no
  // internal word breaks. Without it this matched ordinary English: "Password
  // requirements are not enforced" became "Password [redacted] are not
  // enforced", and a mangled finding just reads as the agent writing nonsense.
  [/\b(api[-_]?key|secret|password|token)(["'\s:=]+)(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=]{12,}/gi, "$1$2[redacted]"],
];

/**
 * Strip anything that looks like a credential from text we are about to persist.
 *
 * Silent edits are their own hazard, so a redaction announces itself: a reader
 * who sees mangled-looking text needs to know the tool did it deliberately.
 */
export function redactSecrets(text: string): string {
  let out = text;
  let hits = 0;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      hits += 1;
      return replacement.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)] ?? ""));
    });
  }
  return hits > 0 ? `${out} [${hits} secret${hits === 1 ? "" : "s"} redacted]` : out;
}

/** The action-log lines that open and close a journey (scout_journey). The feed reads them to tell which goal an action served. */
export const JOURNEY_START = "journey:start";
export const JOURNEY_END = "journey:end";
/** Logged when a session states the task it is starting, so the feed can group the actions that follow under it. */
export const TASK_SET = "task";

export interface ActionLogEntry {
  at: string;
  action: string;
  target?: string;
  url: string;
  result?: string;
  /** Which named session wrote this — the shared log interleaves every role in a
   *  multi-role run, so per-session reads (e.g. journey paths) must filter by it. */
  session?: string;
  /** The frame kept for this step, relative to the memory directory. Present only on a recorded run. */
  frame?: string;
}

/** Latest quality score for one route, produced by the design audit. */
export interface PageScore {
  overall: number;
  a11y: number;
  craft: number;
  consistency: number;
  clarity: number;
  at: string;
  url: string;
}

/** Per-route testing facts — the raw material of the report's GAP LEDGER. */
export interface RouteFacts {
  /** Design audit ran on this route at least once. */
  audited?: boolean;
  /** At least one state-changing request originated from this route (forms/actions actually exercised, not just looked at). */
  mutated?: boolean;
  /** scout_journey measurements that STARTED on this route (completed or not). */
  journeys?: number;
  /**
   * ...of which the user actually finished. The gap ledger counts only these:
   * an abandoned journey proves a task is blocked, which is a high-severity
   * finding, not evidence that task ease was measured. Counting it as coverage
   * let "this is impossible" close the gap it was supposed to open.
   */
  journeysCompleted?: number;
}

interface MemoryFile {
  version: 1;
  states: Record<string, StateRecord>;
  findings: Finding[];
  /** Same-origin routes harvested from links: route class → a concrete navigable path. The generic route list for apps without filesystem routing (and for ?tab= screens). */
  discoveredRoutes?: Record<string, string>;
  /** Routes we tried to reach but landed elsewhere (auth-redirects): route → outcome. Attempts satisfy the coverage contract — a role that CAN'T see /admin shouldn't block the report forever. */
  attemptedRoutes?: Record<string, string>;
  /** Latest design-audit quality score per route — worst pages first in the report, trends across runs. */
  pageScores?: Record<string, PageScore>;
  /** Per-route testing facts backing the gap ledger. */
  routeFacts?: Record<string, RouteFacts>;
  /** Styled-element signatures per route — the design audit's own chrome census. */
  designElements?: Record<string, string[]>;
  /**
   * Which auth role reached (or was denied) which route: role → route → outcome.
   * ≥2 roles turns this into a capability matrix — the data behind "Sarah can
   * approve but Mike can't see the module at all; should he?" questions.
   */
  roleAccess?: Record<string, Record<string, string>>;
  /**
   * What each parallel lane decided, kept so the confidence it stated can be
   * checked against what the run went on to file. Without this the number was
   * averaged into one line and discarded, which is why nobody ever knew
   * whether a lane's 0.9 meant anything.
   */
  laneDecisions?: RecordedDecision[];
}

const EMPTY: MemoryFile = { version: 1, states: {}, findings: [] };

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

  out.states = { ...theirs.states };
  for (const [fp, ours] of Object.entries(mine.states)) {
    const other = theirs.states[fp];
    if (!other) {
      out.states[fp] = ours;
      continue;
    }
    const elements = { ...other.elements };
    for (const [key, el] of Object.entries(ours.elements)) {
      const prev = elements[key];
      elements[key] = {
        exercised: (prev?.exercised ?? false) || el.exercised,
        // Keep whichever action was actually recorded; ours wins a tie.
        ...((el.lastAction ?? prev?.lastAction) ? { lastAction: el.lastAction ?? prev?.lastAction } : {}),
        absentStreak: Math.min(prev?.absentStreak ?? 0, el.absentStreak ?? 0),
      };
    }
    out.states[fp] = {
      ...ours,
      firstSeen: ours.firstSeen < other.firstSeen ? ours.firstSeen : other.firstSeen,
      visits: Math.max(ours.visits, other.visits),
      elements,
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
    byId.set(f.id, {
      ...newer,
      runs: Math.max(f.runs, other.runs),
      evidence: newer.evidence ?? older.evidence,
      regressedAt: newer.regressedAt ?? older.regressedAt,
    });
  }
  out.findings = [...byId.values()];

  const unionRecord = <T>(a?: Record<string, T>, b?: Record<string, T>): Record<string, T> | undefined => (a || b ? { ...(b ?? {}), ...(a ?? {}) } : undefined);
  out.discoveredRoutes = unionRecord(mine.discoveredRoutes, theirs.discoveredRoutes);
  out.attemptedRoutes = unionRecord(mine.attemptedRoutes, theirs.attemptedRoutes);
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

  return out;
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
function decisionKey(d: RecordedDecision): string {
  return [d.lane, d.observation, d.verdict, d.severity ?? "", d.category ?? "", d.confidence, d.evidence ?? ""].join("|");
}

/**
 * Most lane decisions kept. Calibration wants a few dozen; a long-lived
 * project would otherwise accumulate every decision ever made and re-serialise
 * them on each save, which is what made an old history slow to open.
 */
/**
 * Whether a coverage key belongs to a control inside another site's frame:
 * those keys carry the frame's origin (collector.ts frameElementKey), where
 * the app's own frames carry a path. Not the app's to cover.
 */
export function isEmbedKey(key: string): boolean {
  return /^frame:https?:\/\//.test(key);
}

export const MAX_LANE_DECISIONS = 1000;

/**
 * Most options a dropdown may have and still be tracked for unchosen options.
 * A status or sort filter has a handful, each of which can change what the
 * page asks the server for; a country or time-zone picker has hundreds, and
 * nobody owes the page a choice of each. Larger dropdowns are not tracked.
 */
export const MAX_SELECT_OPTIONS = 20;

const MAX_DISCOVERED_ROUTES = 300;

/** Shared finding-similarity helpers (used by live dedup and retro-merge). */
function findingTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9/ ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
      // crude stemming so entries/entry, displays/display collide
      .map((t) => t.replace(/ies$/, "y").replace(/(?<=\w{3})e?s$/, "")),
  );
}

function findingJaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Distinctive literals — quoted or parenthesized fragments like
 * `"(role not recorded)"` or `"Document not found"`. Two findings on the same
 * route sharing one are the same bug however the prose around it is phrased.
 */
function findingLiterals(...texts: Array<string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(/"([^"]{8,80})"|'([^']{8,80})'|\(([^)]{8,80})\)|“([^”]{8,80})”/g)) {
      const literal = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").toLowerCase().trim();
      if (literal) out.add(literal);
    }
  }
  return out;
}

/**
 * Canonical `METHOD /path STATUS` triples named by a finding's evidence.
 *
 * `evidence` exists to be a MACHINE signature, so when two findings name the
 * same endpoint failing the same way they are the same bug — whichever page
 * the tester happened to be on when they wrote it up. Ids in the path collapse
 * (`/api/users/7` and `/api/users/9` are one endpoint) so a per-record repro
 * does not read as a per-record bug.
 */
/**
 * The signatures that identify a BUG: only those carrying a failure status.
 *
 * A bare `POST /api/orders` says which endpoint was involved, not what went
 * wrong — a double submit and an accepted negative quantity both name it, and
 * are two bugs. Exported so calibration applies the store's own rule instead
 * of a second copy of this regex, which is what it had.
 */
export function failingSignatures(evidence: string | undefined): Set<string> {
  return new Set([...endpointSignatures(evidence)].filter((sig) => /\s[45]\d{2}$/.test(sig)));
}

/**
 * The endpoint signatures a piece of evidence names: method + normalised path,
 * with the failure status when one follows.
 */
export function endpointSignatures(evidence: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!evidence) return out;
  const endpoints = [...evidence.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/[A-Za-z0-9/_.:{}$-]*)/gi)];
  for (const [i, m] of endpoints.entries()) {
    const method = m[1].toUpperCase();
    const path = normalizePath(m[2].replace(/\/+$/, "") || "/").toLowerCase();
    // Each endpoint takes the status from its OWN window — the text between it
    // and the next endpoint mentioned. Pairing every endpoint with every status
    // in the string invented signatures that were never claimed: evidence
    // reading "list loads (GET /api/x 200) but POST /api/x returns 500" also
    // produced "GET /api/x 500", which then merged — and silently discarded —
    // a genuine, separate finding about the GET. Two-endpoint evidence is
    // ordinary prose ("this works, that doesn't"), not an edge case.
    // The status must FOLLOW its endpoint. Reading one from earlier in the
    // string turned a quantity into a status — "list shows 500 items; GET
    // /api/items 200" claimed a 500 on an endpoint the evidence said returned
    // 200. So `GET /api/x 404` written as "404 on GET /api/x" yields only
    // `GET /api/x` and will not merge with the same bug written the other way
    // round: a visible duplicate, which is the safe direction to fail, since
    // the alternative discards a finding.
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < endpoints.length ? (endpoints[i + 1].index ?? evidence.length) : evidence.length;
    const status = /\b([45]\d{2})\b/.exec(evidence.slice(from, to))?.[1];
    out.add(status ? `${method} ${path} ${status}` : `${method} ${path}`);
  }
  return out;
}

/**
 * Same endpoint, same failure — regardless of which route it was filed from.
 * The route-scoped rules below cannot see this: one agent filed the analytics
 * 404 from the page that calls it, another from a different page, so two
 * findings for one bug survived a run. Requires evidence on BOTH sides and an
 * exact triple match, so it stays a machine-signal match, never a fuzzy one.
 */
function sharesEndpointSignature(a: { evidence?: string }, b: { evidence?: string }): boolean {
  if (!a.evidence || !b.evidence) return false;
  // Only a triple with a failure status is a signature of a bug. A bare
  // `POST /api/orders` (the endpoint answered 2xx, or no status was named)
  // says which endpoint was involved, not what went wrong: a double submit
  // and an accepted negative quantity both name it, and are two bugs.
  const aSigs = failingSignatures(a.evidence);
  if (aSigs.size === 0) return false;
  for (const sig of failingSignatures(b.evidence)) if (aSigs.has(sig)) return true;
  return false;
}

/**
 * The cross-route merge rule, with the two guards a bare signature match needs.
 *
 * - NEVER absorb into a RESOLVED finding. Without evidence identical enough to
 *   count as a regression, a signature match would increment the old entry's
 *   run count and return it — so a genuinely new bug on an endpoint that once
 *   had a fixed bug would never appear in the report at all. A duplicate is
 *   visible and cheap; a swallowed finding is neither.
 * - Require the same CATEGORY. One endpoint+status can carry two different
 *   bugs (a `security` 403 and a `ux-confusing` 403; a 400 for a bad date and a
 *   400 for a zero quantity), and the loser's title, detail and severity are
 *   discarded on merge.
 */
function sameEndpointBug(existing: { status?: string; category: string; evidence?: string }, incoming: { category: string; evidence?: string }): boolean {
  if (existing.status === "resolved") return false;
  if (existing.category !== incoming.category) return false;
  return sharesEndpointSignature(existing, incoming);
}

/**
 * Whether two pieces of evidence each name a request and share none — compared
 * by method and normalised path, ignoring the status, so `GET /api/x` and
 * `GET /api/x/ 404` are one request. Evidence that names no request (a test id,
 * a toast's text) disagrees with nothing.
 */
export function requestsDisagree(a: string | undefined, b: string | undefined): boolean {
  const requests = (ev: string | undefined) => new Set([...endpointSignatures(ev)].map((sig) => sig.split(" ").slice(0, 2).join(" ")));
  const aReq = requests(a);
  const bReq = requests(b);
  if (aReq.size === 0 || bReq.size === 0) return false;
  for (const r of aReq) if (bReq.has(r)) return false;
  return true;
}

/**
 * Families of finding kinds that one bug is plausibly filed under by two
 * sessions: a crash is a page-error to one and a console-error to another, a
 * refused save is data-loss to one and data-inconsistency to another. Across
 * families — a layout defect and a data defect — a shared quoted string names
 * a place on the page, not a bug.
 */
const CATEGORY_FAMILY: Record<string, string> = {
  "data-inconsistency": "data",
  "data-loss": "data",
  "stale-state": "data",
  "http-error": "failure",
  network: "failure",
  "console-error": "failure",
  "page-error": "failure",
  visual: "presentation",
  "ux-polish": "presentation",
  a11y: "presentation",
  "missing-testid": "presentation",
  "ux-confusing": "flow",
  "dead-end": "flow",
  security: "security",
  "permission-leak": "security",
  performance: "performance",
};

/**
 * Whether two categories are one family. "other" — the category for nothing
 * that fits — is a family of its own: as a wildcard, one "other" finding
 * quoting a control absorbed both the layout and the data finding about it. A
 * missing or unknown category matches nothing, so a finding read from an older
 * file never merges on a guess.
 */
export function sameFamily(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === "other" || b === "other") return a === b;
  const fa = CATEGORY_FAMILY[a];
  return fa !== undefined && fa === CATEGORY_FAMILY[b];
}

function sameFinding(
  a: { title: string; detail?: string; evidence?: string; category?: string },
  b: { title: string; detail?: string; evidence?: string; category?: string },
): boolean {
  const aEv = a.evidence?.toLowerCase().replace(/\s+/g, " ").trim();
  const bEv = b.evidence?.toLowerCase().replace(/\s+/g, " ").trim();
  if (aEv && bEv && aEv === bEv) return true;
  // A shared distinctive literal (e.g. "Document not found anymore") marks the
  // same bug even when two sessions wrote DIFFERENT evidence strings. The
  // literal must be one the finding is ABOUT — i.e. quoted in at least one of
  // the two TITLES. Drawing it from detail prose as well merged unrelated bugs
  // that merely described the same screen: a data-integrity finding and a
  // layout finding on one page both quoted the UI strings they saw, shared
  // them, and collapsed into one. Matching a title literal against the other
  // finding's full text keeps the intended case (one states the string in its
  // title, the other mentions it in its detail).
  //
  // Only between findings of one FAMILY of kinds (see sameFamily). A quoted
  // string is as often the name of a control as a message the app showed, and
  // a layout defect naming the button it covers ("Save notes") shares that
  // literal with the data defect describing what the button does — in its
  // detail or its own title. Merged, the layout defect was filed and then lost
  // from the report on most runs of a benchmark. Within a family, one bug
  // filed twice under neighbouring categories still merges.
  //
  // And never when both findings' evidence names requests with no endpoint in
  // common. A quoted control name bridges two findings about that control
  // within one family too: "an unknown order id still offers its actions"
  // (GET /api/orders/9999 404) mentions the "Request manager approval" button
  // that "Request manager approval stays enabled on a pending order" (POST
  // …/request-approval 409) quotes in its title, and was merged into it.
  // Evidence that names a request is the finding's own statement of where it
  // happened; two findings naming different requests are two bugs. A request
  // that answered 2xx counts too — a false success names one — so the same bug
  // described once by its page load and once by its failing call stays as two
  // findings: a visible duplicate, the direction ADR 4 accepts.
  if (sameFamily(a.category, b.category) && !requestsDisagree(a.evidence, b.evidence)) {
    const aTitleLits = findingLiterals(a.title);
    const bTitleLits = findingLiterals(b.title);
    if (aTitleLits.size > 0 || bTitleLits.size > 0) {
      const aAll = findingLiterals(a.title, a.detail, a.evidence);
      const bAll = findingLiterals(b.title, b.detail, b.evidence);
      for (const lit of aTitleLits) if (bAll.has(lit)) return true;
      for (const lit of bTitleLits) if (aAll.has(lit)) return true;
    }
  }
  // Both carry evidence and neither matched above: distinct bugs, however
  // similar the titles — never fuzzy-merge across differing evidence.
  if (aEv && bEv) return false;
  return findingJaccard(findingTokens(a.title), findingTokens(b.title)) >= 0.5;
}

/** Per-project directory for memory, session logs, and reports. */
export const MEMORY_DIRNAME = ".scenescout";
/** The one directory under it that is committed rather than ignored: saved flows (flow.ts). */
export const SELF_IGNORE_KEEP = "flows";
/** What the directory was called before the tool was renamed. */
export const LEGACY_MEMORY_DIRNAME = ".scenecraft";

/**
 * Carry a project's memory across the rename. Coverage, findings and notes are
 * the whole point of cross-run memory; starting an empty `.scenescout/` next to
 * a full legacy directory would silently throw every earlier run away and
 * re-report every known finding as new.
 *
 * Only when the new directory does not exist yet — once both are present the
 * new one is authoritative and the old one is left for the user to delete.
 * Returns a note for the attach output, or null when there was nothing to do.
 */
export function adoptLegacyMemoryDir(projectDir: string, isAlive: (pid: number) => boolean = pidAlive): string | null {
  const current = path.join(projectDir, MEMORY_DIRNAME);
  const legacy = path.join(projectDir, LEGACY_MEMORY_DIRNAME);
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return null;
  // A pre-rename engine that is still running holds absolute paths into the
  // legacy directory. Moving it away makes every later write of that run fail,
  // and the only trace is a stderr line nobody reads. Leave it until it exits.
  const owner = liveOwnerPid(legacy, isAlive);
  if (owner !== null) {
    return `A pre-rename engine (pid ${owner}) is still using ${LEGACY_MEMORY_DIRNAME}/, so its memory was NOT moved — this run starts empty. Close that session and re-attach to carry the earlier coverage and findings over.`;
  }
  try {
    fs.renameSync(legacy, current);
  } catch (err) {
    // Two engines attaching at once both pass the guard above; the loser's
    // rename fails because the winner already moved it. That is success.
    if (fs.existsSync(current)) return null;
    // A read-only checkout must not break attach; say what was lost instead.
    return `Could not move ${LEGACY_MEMORY_DIRNAME}/ to ${MEMORY_DIRNAME}/ (${(err as Error).message}) — this run starts without the earlier memory.`;
  }
  return `Moved this project's memory from ${LEGACY_MEMORY_DIRNAME}/ to ${MEMORY_DIRNAME}/ (the tool was renamed); earlier coverage and findings are kept.`;
}

/** Signal 0 probes existence. EPERM means the process exists but is another user's — still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** The pid named by a memory directory's status.json, when that process is still running and is not us. */
function liveOwnerPid(dir: string, isAlive: (pid: number) => boolean): number | null {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as { pid?: number };
    return st.pid && st.pid !== process.pid && isAlive(st.pid) ? st.pid : null;
  } catch {
    return null; // no status file, or a truncated one: nothing is provably using it
  }
}

/**
 * Keep our artifacts out of the tested project's commits.
 *
 * We write memory.json, rolling session logs, status.json and report.md into
 * the project under test, so `.scenescout/` turns up as untracked and a single
 * `git add -A` sweeps a test tool's scratch data into someone else's history.
 *
 * The ignore rule goes INSIDE our own directory rather than in the project's
 * root .gitignore: git reads nested .gitignore files, `*` makes every file
 * here invisible, and a directory holding only ignored files never appears in
 * `git status`. That gets the same result without editing a file we do not
 * own, and it disappears cleanly when someone deletes the directory.
 *
 * The one exception is `flows/`: saved flows are inputs a team commits so
 * CI replays them, not output. A file written before that exception existed
 * is still left alone; docs/ci.md says which two lines to add to it.
 *
 * Best-effort and idempotent — a read-only checkout must never break attach,
 * and an existing file is left exactly as the user left it.
 */
export function writeSelfIgnore(dir: string): string | null {
  try {
    const ignorePath = path.join(dir, ".gitignore");
    if (fs.existsSync(ignorePath)) return null;
    fs.writeFileSync(
      ignorePath,
      "# SceneScout exploratory-test artifacts: memory, session logs, status, report.\n" +
        "# Self-ignoring so a `git add -A` in the tested project can never commit them.\n" +
        "*\n" +
        "# Except the flows `scenescout check` replays: they are written to be committed.\n" +
        `!${SELF_IGNORE_KEEP}/\n` +
        `!${SELF_IGNORE_KEEP}/*.json\n`,
    );
    return `Wrote ${MEMORY_DIRNAME}/.gitignore so these test artifacts stay out of your commits.`;
  } catch {
    return null; // housekeeping must never break a run
  }
}

/**
 * Persistent exploration memory, stored in `.scenescout/` inside the
 * tested project. This is what makes run N+1 not repeat run N: visited state
 * fingerprints, per-element exercise status, and deduplicated findings.
 */
export class MemoryStore {
  readonly dir: string;
  private data: MemoryFile;
  private readonly memoryPath: string;
  private readonly sessionLogPath: string;
  /** Rolling in-session action log (also the repro-trace source). */
  readonly actionLog: ActionLogEntry[] = [];
  /** Set when the on-disk memory could not be loaded — surfaced to the driver instead of silently resetting. */
  loadWarning: string | null = null;
  /** Set when we added ourselves to the project's .gitignore — reported, never silent. */
  readonly gitIgnoreNote: string | null;
  /** Set when this attach moved a pre-rename memory directory into place. */
  readonly legacyDirNote: string | null;

  /** When this session started — findings re-seen after this are "current", older ones "historical". */
  readonly sessionStart = new Date().toISOString();

  /**
   * Resources created by THIS RUN (safe-write): id → collection paths.
   *
   * Deliberately lives on the shared MemoryStore rather than per-engine:
   * every named session attached to a project shares one store, and a
   * multi-role run is conceptually ONE test. Role A creating a record that
   * role B must then act on (submit → approve, raise → investigate) is the
   * entire point of multi-role testing, so ownership has to be shared or
   * every handoff gets blocked as "not yours". Not persisted to disk —
   * ownership must never outlive the process that did the creating.
   */
  readonly ownedIds = new Map<string, Set<string>>();
  /** Human-readable creation log for this run — becomes the report's cleanup list. */
  readonly createdResources: string[] = [];
  /**
   * Markup-shaped values any session of this run typed, and the injections
   * already reported. Shared for the same reason ownership is: a parallel run
   * splits the app by route, so the lane that types a payload into a create
   * form is rarely the lane that opens the list rendering it, and a probe kept
   * per session could only ever catch a reflected injection. Not persisted: a
   * payload typed in an earlier run is not this run's evidence.
   */
  probes: InjectionProbe[] = [];
  readonly injectionsReported = new Set<string>();
  /**
   * Design audits any session of this run performed. The report's gate asked
   * the session that happened to call scout_report, so a run whose lanes
   * audited every page was refused because the planner's own session had not.
   * Not persisted: an audit from an earlier run does not satisfy this one.
   */
  auditsThisRun = 0;

  /**
   * End the run: forget what only this run's sessions know. Called when the
   * last session on this project closes. The store itself outlives it — the
   * server keeps one per project for the life of the process — so without
   * this, a second run in the same process passed the audit gate on the first
   * run's audit and stayed silent about an injection the first run reported.
   */
  endRun(): void {
    this.probes = [];
    this.injectionsReported.clear();
    this.auditsThisRun = 0;
    this.selectChoices.clear();
    this.emptySubmits.clear();
  }

  /**
   * Each dropdown's options and the ones chosen in THIS run, by any session,
   * keyed by route and element. A select counts as exercised after one choice,
   * so a lane that tried four of a filter's seven options — and reported having
   * tried them all — left the one that failed untried with nothing to say so.
   * Per run, like the probes: whether an earlier run chose an option says
   * nothing about whether this one looked. Keyed without the role: when two
   * roles see different options in one dropdown, the list read last is the
   * one reported.
   */
  readonly selectChoices = new Map<string, { route: string; key: string; options: string[]; chosen: Set<string> }>();

  recordSelectChoice(fingerprint: string, key: string, options: readonly string[], chosen: string): void {
    const route = fingerprint.split("#")[0];
    const id = `${route}\u0000${key}`;
    const distinct = [...new Set(options)];
    if (distinct.length > MAX_SELECT_OPTIONS) {
      this.selectChoices.delete(id);
      return;
    }
    const entry = this.selectChoices.get(id) ?? { route, key, options: [], chosen: new Set<string>() };
    // The latest list wins: options a page added or removed since are not owed.
    if (distinct.length > 0) entry.options = distinct;
    if (chosen) entry.chosen.add(chosen);
    this.selectChoices.set(id, entry);
  }

  /** Dropdowns with options no session chose this run, in the order they were first used. */
  unchosenOptions(): Array<{ route: string; key: string; unchosen: string[] }> {
    const out: Array<{ route: string; key: string; unchosen: string[] }> = [];
    for (const { route, key, options, chosen } of this.selectChoices.values()) {
      const unchosen = options.filter((o) => !chosen.has(o));
      if (unchosen.length > 0) out.push({ route, key, unchosen });
    }
    return out;
  }

  /**
   * Each form a session saw this run, by route and identity (forms.ts
   * formIdentity: its own attributes, else its first submit control's
   * coverage key), and whether any session has submitted it with every
   * text field blank (forms.ts has the definition). Per run and shared across
   * sessions, like the dropdown choices: an earlier run's empty submit says
   * nothing about this build, and in a parallel run any lane may try it.
   */
  readonly emptySubmits = new Map<string, { route: string; key: string; triedEmpty: boolean; guarded?: boolean }>();

  /**
   * A form seen on a visited state. Recording it again changes nothing, except
   * that `guarded` (every submit control disabled while its fields were blank)
   * takes it off the list for good: the page refuses the empty submit itself,
   * and no one could clear an entry whose submit cannot be pressed.
   */
  recordForm(fingerprint: string, key: string, guarded = false): void {
    const entry = this.formEntry(fingerprint, key);
    if (entry && guarded) entry.guarded = true;
  }

  /**
   * A submit of a form already seen; `empty` when every text field was blank
   * at the moment it went. It only marks: a submit never puts a form on the
   * list, since a key read at submit time is the one most likely to be stale.
   * Returns whether the form was on the list, so a miss can be logged.
   */
  recordFormSubmit(fingerprint: string, key: string, empty: boolean): boolean {
    const entry = this.formEntry(fingerprint, key, false);
    if (entry && empty) entry.triedEmpty = true;
    return entry !== null;
  }

  private formEntry(fingerprint: string, key: string, create = true): { route: string; key: string; triedEmpty: boolean; guarded?: boolean } | null {
    // Another site's frame is not the app's form to probe.
    if (isEmbedKey(key)) return null;
    const route = fingerprint.split("#")[0];
    const id = `${route}\u0000${key}`;
    let entry = this.emptySubmits.get(id) ?? null;
    if (!entry && create) {
      entry = { route, key, triedEmpty: false };
      this.emptySubmits.set(id, entry);
    }
    return entry;
  }

  /** Forms seen this run that no session has submitted empty, in the order they were first seen. */
  formsNeverSubmittedEmpty(): Array<{ route: string; key: string }> {
    return [...this.emptySubmits.values()].filter((f) => !f.triedEmpty && !f.guarded).map(({ route, key }) => ({ route, key }));
  }

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, MEMORY_DIRNAME);
    this.legacyDirNote = adoptLegacyMemoryDir(projectDir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.gitIgnoreNote = writeSelfIgnore(this.dir);
    this.memoryPath = path.join(this.dir, "memory.json");
    this.sessionLogPath = path.join(this.dir, `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    this.sweepStaleTemps();
    this.data = this.load();
    this.fileSig = this.currentSig();
    this.retroMerge();
    this.reclassifyLegacyAuthLoss();
  }

  /**
   * Re-file pre-v0.17 login bounces as auth-loss.
   *
   * Before this release every redirect was written as `landed:<route>`, so a
   * run whose token died mid-way recorded `landed:/login` for each route it
   * failed to reach — and those entries still satisfy the completion contract
   * for every role. Without this migration the upgrade quietly carries the
   * exact defect the release fixes: an old memory.json goes on certifying
   * routes nobody ever saw.
   */
  private reclassifyLegacyAuthLoss(): void {
    const map = this.data.attemptedRoutes;
    if (!map) return;
    let changed = false;
    for (const [key, outcome] of Object.entries(map)) {
      if (!outcome.startsWith("landed:")) continue;
      if (!LOGIN_ROUTE_RE.test(outcome.slice("landed:".length))) continue;
      map[key] = `${AUTH_LOSS_PREFIX}${outcome.slice("landed:".length)}`;
      changed = true;
    }
    if (changed) this.flush();
  }

  /**
   * Merge stored duplicate findings recorded before smarter dedup existed
   * (paraphrased titles across sessions). Applies the same three-tier match
   * used by addFinding; keeps the earliest entry, sums runs.
   */
  private retroMerge(): void {
    const findings = this.data.findings;
    if (findings.length < 2) return;
    const kept: Finding[] = [];
    let merged = 0;
    for (const f of findings) {
      const fRoute = f.state.split("#")[0];
      const dupOf = kept.find((k) => (k.state.split("#")[0] === fRoute && sameFinding(k, f)) || sameEndpointBug(k, f));
      if (dupOf) {
        dupOf.runs += f.runs;
        if (!dupOf.evidence && f.evidence) dupOf.evidence = f.evidence;
        if (f.status === "resolved") dupOf.status = "resolved";
        merged += 1;
      } else {
        kept.push(f);
      }
    }
    if (merged > 0) {
      this.data.findings = kept;
      this.flush();
    }
  }

  /** Record link-harvested routes (class → navigable example); returns how many were new. */
  addDiscoveredRoutes(entries: Array<{ route: string; example: string }>): number {
    const map = this.data.discoveredRoutes ?? {};
    let added = 0;
    for (const { route, example } of entries) {
      if (Object.keys(map).length >= MAX_DISCOVERED_ROUTES) break;
      if (!(route in map)) {
        map[route] = example;
        added += 1;
      }
    }
    if (added > 0) {
      this.data.discoveredRoutes = map;
      this.save();
    }
    return added;
  }

  get discoveredRoutes(): Record<string, string> {
    return this.data.discoveredRoutes ?? {};
  }

  /**
   * Record that a route was attempted but landed elsewhere (e.g. auth-redirect).
   *
   * Keyed by ROLE as well as route. A permission redirect is a fact about one
   * role — "the operator cannot reach /admin" must not also mean "nobody needs
   * to test /admin", which is what a role-blind key silently asserted: the
   * low-privilege role bouncing off an admin route erased that route from the
   * ADMIN's gap ledger permanently.
   */
  markAttempted(route: string, outcome: string, role = "default"): void {
    const map = this.data.attemptedRoutes ?? {};
    const key = roleRouteKey(role, route);
    if (map[key] !== outcome) {
      map[key] = outcome;
      this.data.attemptedRoutes = map;
      this.save();
    }
  }

  /**
   * Routes this role attempted, and how they resolved. `authloss:` outcomes are
   * excluded — a navigation the session's dead credentials bounced to a login
   * page is not evidence the route was covered, and treating it as such let an
   * expired token silently certify the whole remaining route list.
   */
  attemptedByRole(role = "default"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, outcome] of Object.entries(this.data.attemptedRoutes ?? {})) {
      if (outcome.startsWith(AUTH_LOSS_PREFIX)) continue;
      const sep = key.indexOf("/");
      // A key that STARTS with "/" carries no role prefix — that is the shape
      // written before attempts were role-scoped. Honour it for every role
      // rather than dropping coverage a previous run legitimately earned.
      if (sep === 0) out[key] = outcome;
      else if (sep > 0 && key.slice(0, sep) === role) out[key.slice(sep)] = outcome;
    }
    return out;
  }

  /** Every attempt, flattened to route → outcome, for reporting. */
  get attemptedRoutes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, outcome] of Object.entries(this.data.attemptedRoutes ?? {})) {
      const sep = key.indexOf("/");
      out[sep <= 0 ? key : key.slice(sep)] = outcome;
    }
    return out;
  }

  /** Record the latest design-audit score for a route. */
  setPageScore(route: string, score: PageScore): void {
    const map = this.data.pageScores ?? {};
    map[route] = score;
    this.data.pageScores = map;
    this.save();
  }

  get pageScores(): Record<string, PageScore> {
    return this.data.pageScores ?? {};
  }

  /** Merge testing facts for a route (audited / mutated / journey count). */
  markRouteFact(route: string, fact: Partial<RouteFacts>): void {
    const map = this.data.routeFacts ?? {};
    const rec = map[route] ?? {};
    if (fact.audited) rec.audited = true;
    if (fact.mutated) rec.mutated = true;
    if (fact.journeys) rec.journeys = (rec.journeys ?? 0) + fact.journeys;
    if (fact.journeysCompleted) rec.journeysCompleted = (rec.journeysCompleted ?? 0) + fact.journeysCompleted;
    map[route] = rec;
    this.data.routeFacts = map;
    this.save();
  }

  get routeFacts(): Record<string, RouteFacts> {
    return this.data.routeFacts ?? {};
  }

  /** Record that `role` reached (or was denied) `route`. Denials never overwrite a recorded "reached" — flaky redirects must not erase real access. */
  recordRoleAccess(role: string, route: string, outcome: string): void {
    const all = this.data.roleAccess ?? {};
    const forRole = all[role] ?? {};
    if (forRole[route] === "reached" && outcome !== "reached") return;
    if (forRole[route] === outcome) return;
    forRole[route] = outcome;
    all[role] = forRole;
    this.data.roleAccess = all;
    this.save();
  }

  get roleAccess(): Record<string, Record<string, string>> {
    return this.data.roleAccess ?? {};
  }

  // ---- ASSUMPTIONS.md — cumulative WRITTEN knowledge about the tested app. ----
  // memory.json stores coverage booleans; this stores understanding: what the
  // app is for, who each role is and what they do, conventions, constraints
  // ("an order can only ship once approved"). It compounds across
  // runs, so run N+1 starts smarter than run N — in prose a human can read
  // and correct.

  private get assumptionsPath(): string {
    return path.join(this.dir, "ASSUMPTIONS.md");
  }

  static readonly ASSUMPTION_SECTIONS = ["app-model", "roles", "conventions", "constraints", "risks", "glossary"] as const;

  private static sectionHeading(section: string): string {
    const titles: Record<string, string> = {
      "app-model": "App model — what this application is and does",
      roles: "Roles & personas — who uses it and what each role is FOR",
      conventions: "Conventions — patterns the app follows (naming, flows, UI idioms)",
      constraints: "Constraints — rules discovered the hard way (gates, preconditions, limits)",
      risks: "Risks & watchpoints — fragile areas worth re-testing every run",
      glossary: "Glossary — domain terms and what they mean here",
      setup: "Setup — how to get this app into a testable state (how a login state is regenerated, what has to be running)",
    };
    return `## ${titles[section] ?? section}`;
  }

  /**
   * What earlier runs recorded about getting this app testable, if anything.
   *
   * Read back by the auth-failure message. A storage state expires on a timer
   * nobody remembers, and "regenerate it" is advice the reader already had;
   * the command that worked last time is the part worth keeping, and it is
   * exactly the kind of thing a run pays to find out and then forgets.
   */
  setupRecipe(): string[] {
    if (!fs.existsSync(this.assumptionsPath)) return [];
    const text = fs.readFileSync(this.assumptionsPath, "utf8");
    const heading = MemoryStore.sectionHeading("setup");
    const start = text.indexOf(heading);
    if (start === -1) return [];
    const rest = text.slice(start + heading.length);
    const end = rest.indexOf("\n## ");
    return (end === -1 ? rest : rest.slice(0, end))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
  }

  readAssumptions(): string {
    if (!fs.existsSync(this.assumptionsPath)) return "(no ASSUMPTIONS.md yet — record what you learn with scout_note as you explore)";
    return fs.readFileSync(this.assumptionsPath, "utf8");
  }

  /** Append one dated, attributed bullet under a section; exact-duplicate notes are dropped. Returns whether it was new. */
  addAssumption(section: string, note: string, attribution: string): boolean {
    // Notes are free prose the agent often builds from app output; this file is
    // the one most likely to be pasted into a ticket.
    const clean = redactSecrets(note.trim().replace(/\s+/g, " "));
    if (!clean) return false;
    let content = fs.existsSync(this.assumptionsPath)
      ? fs.readFileSync(this.assumptionsPath, "utf8")
      : `# Assumptions — cumulative knowledge about this application\n\nWritten by SceneScout runs; corrections welcome — the tester reads this file at the start of every session.\n`;
    // Dedupe on the note text itself, ignoring the date/attribution prefix.
    if (content.includes(`— ${clean}`)) return false;
    const heading = MemoryStore.sectionHeading(section);
    const bullet = `- (${new Date().toISOString().slice(0, 10)}, ${attribution}) — ${clean}`;
    if (content.includes(heading)) {
      content = content.replace(heading, `${heading}\n${bullet}`);
    } else {
      content += `\n${heading}\n${bullet}\n`;
    }
    fs.writeFileSync(this.assumptionsPath, content);
    return true;
  }

  /** What the lanes decided, oldest first. Empty on a project that has never run one. */
  get laneDecisions(): RecordedDecision[] {
    return this.data.laneDecisions ?? [];
  }

  /**
   * Record what a lane decided. Called once per accepted lane report, so the
   * confidence it stated can be checked later against what the run filed.
   * Free text from the lane is redacted like every other stored string: an
   * observation is written by a model reading the app under test.
   */
  addLaneDecisions(lane: string, decisions: readonly RecordedDecision[]): number {
    if (decisions.length === 0) return 0;
    const list = this.data.laneDecisions ?? [];
    const seen = new Set(list.map(decisionKey));
    let added = 0;
    for (const d of decisions) {
      const record: RecordedDecision = {
        ...d,
        lane,
        observation: redactSecrets(d.observation).slice(0, 200),
        evidence: d.evidence === null ? null : redactSecrets(d.evidence).slice(0, 200),
      };
      if (seen.has(decisionKey(record))) continue;
      seen.add(decisionKey(record));
      list.push(record);
      added += 1;
    }
    this.data.laneDecisions = list.slice(-MAX_LANE_DECISIONS);
    if (added > 0) this.flush();
    // What survives the cap. Appends go to the tail and the cap keeps the
    // tail, so all of `added` survives unless the call itself exceeds the cap.
    // Measuring it as growth instead looked right and was not: `list` aliases
    // the stored array, so the "before" length was read after the appends and
    // every call after the first reported nothing kept — while storing fine.
    return Math.min(added, MAX_LANE_DECISIONS);
  }

  /** Mark a finding resolved; returns it or null. */
  resolveFinding(id: string): Finding | null {
    const f = this.data.findings.find((x) => x.id === id);
    if (!f) return null;
    f.status = "resolved";
    this.flush();
    return f;
  }

  /**
   * Record what a re-test of this finding found. "gone" resolves it; the other
   * two leave it open and stamp the confirmation, which is what lets the report
   * stop describing a finding somebody checked yesterday as unverified.
   */
  verifyFinding(id: string, verdict: "gone" | "present" | "changed", note?: string): Finding | null {
    const f = this.data.findings.find((x) => x.id === id);
    if (!f) return null;
    f.verdict = verdict;
    f.verifiedAt = new Date().toISOString();
    if (note) f.verifyNote = redactSecrets(note).slice(0, 500);
    else delete f.verifyNote;
    if (verdict === "gone") f.status = "resolved";
    this.flush();
    return f;
  }

  private load(): MemoryFile {
    if (!fs.existsSync(this.memoryPath)) return structuredClone(EMPTY);
    try {
      const raw = JSON.parse(fs.readFileSync(this.memoryPath, "utf8")) as MemoryFile;
      if (raw.version === 1) {
        // Prune once, on open: the long tail of per-route states is what makes
        // an old history slow to parse and re-serialise, and it answers no
        // question the gap ledger asks. Findings and the newest states of
        // every route are kept, so coverage does not regress.
        const { kept, dropped } = pruneStates(raw.states ?? {}, raw.findings ?? []);
        if (dropped > 0) {
          raw.states = kept;
          this.prunedStates = dropped;
        }
        return raw;
      }
      this.loadWarning = `memory.json has unknown version ${String((raw as { version?: unknown }).version)} — starting fresh.`;
    } catch (err) {
      // Never silently overwrite the (possibly recoverable) history — cross-run
      // memory is the product promise. Preserve the corrupt file and say so.
      const backup = `${this.memoryPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.memoryPath, backup);
        this.loadWarning = `memory.json was corrupt (${err instanceof Error ? err.message : err}); preserved as ${path.basename(backup)}, starting fresh.`;
      } catch {
        this.loadWarning = "memory.json is corrupt and could not be preserved — starting fresh.";
      }
    }
    return structuredClone(EMPTY);
  }

  private saveTimer: NodeJS.Timeout | null = null;

  /**
   * Debounced save: coverage bookkeeping calls this several times per action,
   * and serialising the whole history synchronously each time is the main
   * per-action latency cost. Coalesce writes; findings and shutdown call
   * flush() directly for durability. The JSONL action log remains the
   * per-event durable trail either way.
   */
  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.flush();
      } catch (err) {
        // A background debounced write has no caller to report to — a
        // failure here (deleted project dir, disk full, permissions) must
        // not crash the whole engine process over a transient filesystem
        // issue. But it also must not vanish: without this, every write
        // from here on silently stops persisting and nothing downstream
        // (scout_coverage, the final report) would know coverage tracking
        // broke. Log it (stderr — safe under stdio MCP transport, which
        // owns stdout) and store it for the next scout_coverage/scout_close to
        // surface. Explicit flush() callers (resolveFinding, scout_close, …)
        // still throw and are handled at the MCP tool boundary directly.
        const msg = err instanceof Error ? err.message : String(err);
        this.lastSaveError = msg;
        console.error(`[scenescout] background memory write failed: ${msg}`);
      }
    }, 500);
    // Deliberately NOT unref'd: a pending coverage write briefly holds the
    // process open so an exit without scout_close still lands the last save.
  }

  /** How many states the last open pruned. Reported once, so a shrinking history is never silent. */
  prunedStates = 0;

  /** Set when a debounced background write failed — cleared on the next successful write. Surfaced by scout_coverage/scout_close so a broken persistence path is never silently invisible. */
  lastSaveError: string | null = null;

  /**
   * Write memory.json now (atomic: a crash mid-write must not truncate the
   * history file).
   *
   * The temp file carries this process's pid and a counter. A fixed `.tmp`
   * path meant two SceneScout processes on one project interleaved their
   * writes into a single inode, and whichever rename landed second published
   * a half-and-half document that failed to parse on the next load — the
   * rename made the publish atomic but not the write that fed it. The cost is
   * that an interrupted flush leaks a temp file rather than self-overwriting,
   * so the constructor sweeps them.
   *
   * Not pretty-printed: nobody hand-reads a multi-megabyte history file, and
   * the indentation was ~40% of the bytes written on every single finding.
   *
   * MERGE BEFORE WRITE. Each process holds a full snapshot and writes the whole
   * document, so a straight write makes the last flush win outright and erases
   * whatever another process recorded meanwhile — silently, since the write
   * itself succeeds. If the file changed under us, fold it in first.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.changedUnderUs()) {
      const theirs = this.readForMerge();
      if (theirs) this.data = mergeMemory(this.data, theirs);
    }
    const tmp = `${this.memoryPath}.${process.pid}.${this.tmpCounter++}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.memoryPath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* the write already failed; a leftover temp file is the lesser problem */
      }
      throw err;
    }
    this.fileSig = this.currentSig();
    this.lastSaveError = null;
  }

  private tmpCounter = 0;
  /** mtime+size of the file as WE last left it; a mismatch means someone else wrote. */
  private fileSig = "";

  private currentSig(): string {
    try {
      const st = fs.statSync(this.memoryPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  }

  private changedUnderUs(): boolean {
    const sig = this.currentSig();
    return sig !== "" && sig !== this.fileSig;
  }

  /** Re-read the on-disk document for merging. Never destructive: a corrupt or
   *  half-written file just means there is nothing to merge this time. */
  private readForMerge(): MemoryFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.memoryPath, "utf8")) as MemoryFile;
      return raw.version === 1 ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove temp files a crashed process left behind. The pid-scoped name that
   * fixed interleaved writes also stopped them self-overwriting, so an
   * interrupted flush now leaks one file per crash instead of reusing one.
   */
  private sweepStaleTemps(): void {
    try {
      const prefix = `${path.basename(this.memoryPath)}.`;
      for (const name of fs.readdirSync(this.dir)) {
        if (name.startsWith(prefix) && name.endsWith(".tmp")) {
          fs.rmSync(path.join(this.dir, name), { force: true });
        }
      }
    } catch {
      /* housekeeping only — never block a run over a leftover file */
    }
  }

  /**
   * Append to the action log — the choke point where redaction belongs.
   *
   * Redacting only a finding's title/detail/evidence left the same secrets
   * flowing by a parallel route: `repro` is built from these entries, and a
   * `type` step logs the text that was typed (a password, during an auth-flow
   * pass) while every entry carries a full URL that may hold `?token=…`. Both
   * land in memory.json and are rendered into the report. One filter here
   * covers the log, the repro traces and the JSONL trail at once.
   */
  logAction(entry: Omit<ActionLogEntry, "at">): void {
    const full: ActionLogEntry = {
      at: new Date().toISOString(),
      ...entry,
      url: redactSecrets(entry.url),
      ...(entry.target === undefined ? {} : { target: redactSecrets(entry.target) }),
      ...(entry.result === undefined ? {} : { result: redactSecrets(entry.result) }),
    };
    this.actionLog.push(full);
    fs.appendFileSync(this.sessionLogPath, JSON.stringify(full) + "\n");
  }

  /** Record a visit to a state; returns whether it was new. */
  visitState(fingerprint: string, url: string, route: string, elementKeys: string[]): boolean {
    let rec = this.data.states[fingerprint];
    const isNew = !rec;
    if (!rec) {
      rec = { url, route, firstSeen: new Date().toISOString(), visits: 0, elements: {} };
      this.data.states[fingerprint] = rec;
    }
    rec.visits += 1;
    rec.lastSeen = new Date().toISOString();
    const present = new Set(elementKeys);
    for (const key of elementKeys) {
      if (!rec.elements[key]) rec.elements[key] = { exercised: false };
      rec.elements[key].absentStreak = 0;
    }
    // Prune ghosts: dynamic elements (list rows, ordinal-suffixed duplicates)
    // that vanish for 3 consecutive visits would otherwise make coverage
    // permanently unreachable and steer exploration at phantoms.
    for (const [key, entry] of Object.entries(rec.elements)) {
      if (present.has(key)) continue;
      entry.absentStreak = (entry.absentStreak ?? 0) + 1;
      if (entry.absentStreak >= 3 && !entry.exercised) delete rec.elements[key];
    }
    this.save();
    return isNew;
  }

  markExercised(fingerprint: string, key: string, action: string): void {
    const rec = this.data.states[fingerprint];
    if (!rec) return;
    // Refuse a key this state never listed. Creating one on demand turned any
    // caller that derived a key slightly differently from the collector into a
    // source of phantom coverage: the invented element counted as exercised
    // (and was never pruned, because pruning skips exercised entries) while the
    // real control stayed an open gap. A miss must record nothing.
    if (!rec.elements[key]) return;
    rec.elements[key].exercised = true;
    rec.elements[key].lastAction = action;
    this.save();
  }

  wasExercised(fingerprint: string, key: string): boolean {
    return this.data.states[fingerprint]?.elements[key]?.exercised ?? false;
  }

  /**
   * Add a finding; dedups against previous runs in three tiers:
   * 1. same route + same normalized `evidence` signature (strongest — survives title rephrasing),
   * 2. exact title hash,
   * 3. same route + high title-token overlap (an LLM re-describing the same bug
   *    across sessions rarely reuses the exact words — Jaccard catches it).
   * Returns [finding, isNew].
   */
  addFinding(input: Omit<Finding, "id" | "foundAt" | "runs" | "repro">): [Finding, boolean] {
    // Redact BEFORE the id is derived, so a re-found finding whose quoted
    // secret differs by a character still hashes to the same id.
    const f = {
      ...input,
      title: redactSecrets(input.title),
      detail: redactSecrets(input.detail),
      // The page URL is persisted AND printed in the report. A finding filed on
      // a reset/invite/magic-link page carries that page's `?token=…`.
      url: redactSecrets(input.url),
      evidence: input.evidence ? redactSecrets(input.evidence) : input.evidence,
    };
    const route = f.state.split("#")[0];
    const id = shortHash(`${f.category}|${f.title.toLowerCase().trim()}|${route}`);
    const existing = this.data.findings.find((x) => x.id === id || (x.state.split("#")[0] === route && sameFinding(x, f)) || sameEndpointBug(x, f));
    if (existing) {
      existing.runs += 1;
      existing.foundAt = new Date().toISOString();
      if (!existing.evidence && f.evidence) existing.evidence = f.evidence;
      // Re-finding a RESOLVED finding is a regression — reopen it loudly
      // rather than letting it hide in the report's completed section. But a
      // FUZZY match must never resurrect a fixed bug: telling someone a
      // regression landed when it did not is far more costly than carrying a
      // visible duplicate, and it corrupts the one signal that says whether a
      // fix held. Demand an exact identity match (same category+title+route) or
      // an identical evidence signature before reopening.
      const exactMatch =
        existing.id === id ||
        (!!existing.evidence &&
          !!f.evidence &&
          existing.evidence.toLowerCase().replace(/\s+/g, " ").trim() === f.evidence.toLowerCase().replace(/\s+/g, " ").trim());
      if (existing.status === "resolved" && exactMatch) {
        existing.status = "open";
        existing.regressedAt = existing.foundAt;
      }
      this.flush();
      return [existing, false];
    }

    // Repro trace scoped to the finding's route: everything since the action
    // that landed there, not 12 lines of unrelated cross-module noise.
    const routeOf = (url: string): string => {
      try {
        return url.split("?")[0].replace(/^https?:\/\/[^/]+/, "") || "/";
      } catch {
        return url;
      }
    };
    // The planner's fold marker is not a step anyone took on a page. Left in,
    // its empty URL read as a route change and cut the trace of a finding filed
    // right after a fold — which is when the fold asks lanes to file.
    // Nor is the forms bookkeeping (a read that failed, a submit it could not match).
    const log = this.actionLog.filter((a) => a.action !== "lane-report" && !isFormBookkeeping(a.action));
    let start = Math.max(0, log.length - 12);
    for (let i = log.length - 1; i >= 0 && i >= log.length - 12; i--) {
      if (routeOf(log[i].url) !== routeOf(f.url)) {
        start = i; // include the transition action itself
        break;
      }
      start = i;
    }
    const finding: Finding = {
      ...f,
      id,
      repro: log
        .slice(start)
        .slice(-12)
        .map((a) => `${a.action}${a.target ? ` ${a.target}` : ""} @ ${a.url}`),
      foundAt: new Date().toISOString(),
      runs: 1,
    };
    this.data.findings.push(finding);
    this.flush();
    return [finding, true];
  }

  get findings(): Finding[] {
    return this.data.findings;
  }

  get states(): Record<string, StateRecord> {
    return this.data.states;
  }

  /**
   * Coverage aggregated by ROUTE, not by state fingerprint: the same sidebar
   * rendered in 30 states of one route is one set of elements, not 30. An
   * element counts as exercised when it was exercised in ANY state of the
   * route. (`state` in the result therefore holds a route.)
   */
  coverage(): {
    states: number;
    elementsTotal: number;
    elementsExercised: number;
    unexercised: Array<{ state: string; keys: string[]; total: number }>;
    /** Controls inside other sites' frames: counted apart, never in the app's totals or its gap ledger. */
    embeds: { total: number; exercised: number };
  } {
    const byRoute = this.elementsByRoute();
    // Shared layout CHROME (sidebar nav, header, breadcrumbs) is one set of
    // components, not one set per route — clicking "nav-documents" on /admin is
    // the same click as on /. Counting it per route inflated the denominator by
    // thousands (a 99-route app reported 8329 elements, most of them the same
    // ~40 shell controls) and turned the unexplored list into a wall of the
    // identical eight nav links. Fold it into a single global surface,
    // exercised if it was exercised ANYWHERE.
    const isChrome = this.chromePredicate(byRoute);

    const chrome = new Map<string, boolean>();
    let elementsTotal = 0;
    let elementsExercised = 0;
    const unexercised: Array<{ state: string; keys: string[]; total: number }> = [];
    const embeds = { total: 0, exercised: 0 };
    for (const [route, elements] of byRoute) {
      const own: string[] = [];
      // The route's OWN element count — deduped across states and with shared
      // chrome removed, i.e. exactly the denominator `own` is a subset of.
      // computeGaps compares these two to decide "nothing was ever touched
      // here"; deriving the total any other way (e.g. re-counting raw state
      // elements) makes it larger than `own` can ever be, and a genuinely
      // untouched route silently drops out of the gap ledger.
      let ownTotal = 0;
      for (const [key, done] of elements) {
        if (isEmbedKey(key)) {
          embeds.total += 1;
          if (done) embeds.exercised += 1;
          continue;
        }
        if (isChrome(key)) {
          chrome.set(key, (chrome.get(key) ?? false) || done);
          continue;
        }
        elementsTotal += 1;
        ownTotal += 1;
        if (done) elementsExercised += 1;
        else own.push(key);
      }
      if (own.length > 0) unexercised.push({ state: route, keys: own, total: ownTotal });
    }
    // Chrome counted once, at the end, as its own pseudo-route.
    const chromeLeft: string[] = [];
    for (const [key, done] of chrome) {
      elementsTotal += 1;
      if (done) elementsExercised += 1;
      else chromeLeft.push(key);
    }
    if (chromeLeft.length > 0) {
      unexercised.push({ state: SHARED_CHROME_ROUTE, keys: chromeLeft, total: chrome.size });
    }
    return { states: Object.keys(this.data.states).length, elementsTotal, elementsExercised, unexercised, embeds };
  }

  /**
   * Remember which styled-element signatures the design audit saw on a route.
   *
   * Parallel to the coverage census and thresholded identically, but keyed the
   * way the audit sees elements (tag/testid + text) rather than by ARIA role —
   * the two cannot share a key space, and the audit needs its own to recognise
   * un-testid'd shell elements across routes.
   */
  recordDesignElements(route: string, signatures: string[]): void {
    const map = this.data.designElements ?? {};
    map[route] = [...new Set(signatures)];
    this.data.designElements = map;
    this.save();
  }

  /** Signatures seen on enough routes to be the shared shell rather than page content. */
  designChromeKeys(): Set<string> {
    const map = this.data.designElements ?? {};
    const routes = Object.keys(map);
    const perKey = new Map<string, number>();
    for (const sigs of Object.values(map)) {
      for (const sig of sigs) perKey.set(sig, (perKey.get(sig) ?? 0) + 1);
    }
    const minRoutes = Math.min(Math.max(CHROME_MIN_ROUTES, Math.ceil(routes.length * CHROME_ROUTE_SHARE)), CHROME_ABSOLUTE_ROUTES);
    const keys = new Set<string>();
    if (routes.length < CHROME_MIN_ROUTES) return keys;
    for (const [sig, n] of perKey) if (n >= minRoutes) keys.add(sig);
    return keys;
  }

  /** Element keys folded per route, exercised-in-any-state. */
  private elementsByRoute(): Map<string, Map<string, boolean>> {
    const byRoute = new Map<string, Map<string, boolean>>();
    for (const rec of Object.values(this.data.states)) {
      let route = byRoute.get(rec.route);
      if (!route) {
        route = new Map();
        byRoute.set(rec.route, route);
      }
      for (const [key, v] of Object.entries(rec.elements)) {
        route.set(key, (route.get(key) ?? false) || v.exercised);
      }
    }
    return byRoute;
  }

  /** "Does this element key belong to the shared shell?" — see coverage(). */
  private chromePredicate(byRoute: Map<string, Map<string, boolean>>): (key: string) => boolean {
    const routeCount = byRoute.size;
    const routesPerKey = new Map<string, number>();
    for (const elements of byRoute.values()) {
      for (const key of elements.keys()) routesPerKey.set(key, (routesPerKey.get(key) ?? 0) + 1);
    }
    // Only meaningful once there are enough routes to tell "on every page" from
    // "on the two pages that exist"; require a majority of them.
    const chromeMinRoutes = Math.min(Math.max(CHROME_MIN_ROUTES, Math.ceil(routeCount * CHROME_ROUTE_SHARE)), CHROME_ABSOLUTE_ROUTES);
    return (key: string): boolean => routeCount >= CHROME_MIN_ROUTES && (routesPerKey.get(key) ?? 0) >= chromeMinRoutes;
  }
}
