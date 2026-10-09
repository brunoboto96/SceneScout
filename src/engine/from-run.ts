/**
 * Starting a run from an earlier run's record: `continue` picks up where it
 * left off, `replay` follows its route and step order again.
 *
 * Every run that writes its report leaves a record (RunRecord) in the
 * project's memory, and `scenescout ci` copies it into ci.json: the routes it
 * knew, the routes it worked on and in what order, each session's steps, and
 * what it left on each route it worked on (controls never exercised, forms
 * never submitted, a form filled and never submitted, dropdown options never
 * chosen), with its gap ledger.
 *
 * - `continue` orders the next run's routes in three tiers: routes the record
 *   never worked on; then routes it worked on, most work left first, with
 *   exactly which controls, forms and options to take first; then the routes
 *   it covered, last.
 * - `replay` hands back each session's routes and steps in the order they were
 *   taken, to reproduce a run or check a fix.
 *
 * Opt-in: without a record nothing here is used and a run behaves as it always
 * has. Pure, so the precedence of the settings, the record's shape, the order
 * and the replay are table-tested (scripts/brief-test.ts) without a browser;
 * reading a record from disk is memory.ts's loadRunRecord.
 */
import { normalizePath } from "./fingerprint.js";

/** The earlier run to start from, for every run that does not name one itself: a ci.json, or a project directory. */
export const FROM_RUN_ENV = "SCENESCOUT_FROM_RUN";
/** How to use it: `continue` (the default) or `replay`. */
export const FROM_RUN_MODE_ENV = "SCENESCOUT_FROM_RUN_MODE";

/**
 * `continue`: start where the earlier run left off. `replay`: follow its route
 * and step order again.
 */
export const FROM_RUN_MODES = ["continue", "replay"] as const;
export type FromRunMode = (typeof FROM_RUN_MODES)[number];
export const DEFAULT_FROM_RUN_MODE: FromRunMode = "continue";

/** An earlier run to start from, as a run was asked for it. */
export interface FromRun {
  /** A ci.json, or a project directory whose memory holds the record. */
  path: string;
  mode: FromRunMode;
  /** The path as it was given, when `path` was resolved from it: what reports name, so they carry no local directory. */
  given?: string;
}

/**
 * The earlier run a run starts from: the path option, else the environment
 * variable, else none; the mode option, else its variable, else `continue`.
 * An empty variable is unset. The mode is read only when there is a path, so a
 * stray SCENESCOUT_FROM_RUN_MODE never stops a run that starts fresh; a mode
 * given as an option without a path is refused, since it would do nothing.
 */
export function resolveFromRun(
  option: { path?: string; mode?: string },
  env: Record<string, string | undefined>,
  names: { path: string; mode: string } = { path: "--from-run", mode: "--from-run-mode" },
): { ok: true; fromRun?: FromRun } | { ok: false; error: string } {
  if (option.path !== undefined && option.path.trim() === "") return { ok: false, error: `${names.path} needs a ci.json or a project directory` };
  const fromEnv = (env[FROM_RUN_ENV] ?? "").trim();
  const runPath = option.path?.trim() ?? (fromEnv || undefined);
  if (runPath === undefined) {
    if (option.mode !== undefined) return { ok: false, error: `${names.mode} applies to a run started from an earlier one: give ${names.path} as well` };
    return { ok: true };
  }
  const modeEnv = (env[FROM_RUN_MODE_ENV] ?? "").trim();
  const [raw, source] = option.mode !== undefined ? [option.mode.trim(), names.mode] : modeEnv ? [modeEnv, FROM_RUN_MODE_ENV] : [DEFAULT_FROM_RUN_MODE, ""];
  if (!(FROM_RUN_MODES as readonly string[]).includes(raw))
    return { ok: false, error: `${source} must be one of ${FROM_RUN_MODES.join(", ")} (got ${JSON.stringify(raw)})` };
  return { ok: true, fromRun: { path: runPath, mode: raw as FromRunMode } };
}

// ── the record ───────────────────────────────────────────────────────────────

/** One step a session took, as a record keeps it: where it ended up, what it did and to what. */
export interface RunStep {
  session: string;
  /** The route the page was on once the step was done. */
  route: string;
  /** The action as the action log names it: navigate, click, type, select, press, hover, upload, back, snapshot. */
  action: string;
  /** What it acted on, as the action log names it ("button \"Save\""). */
  target?: string;
}

/** What a run left on a route it worked on. */
export interface RouteLeft {
  route: string;
  /** Controls listed on the route and never exercised (element keys). */
  unexercised: string[];
  /** Forms seen on the route this run and never submitted (form identities). */
  forms: string[];
  /** Set when a form on the route was filled in and nothing was submitted from it (the gap ledger's line). */
  filled?: true;
  /** Dropdowns with options no session chose this run. */
  unchosen: Array<{ key: string; options: string[] }>;
}

/** What one run left, as the project's memory and ci.json keep it. */
export interface RunRecord {
  version: 1;
  /** The run that made it (memory.ts runId). */
  runId: string;
  /** When its report was written, as an ISO time. */
  at: string;
  /** The routes it knew: its route contract. */
  knownRoutes: string[];
  /** The routes it worked on, in the order first reached; a record continued from another adds the other's after its own. */
  visited: string[];
  /** Each session's routes this run, in the order it reached them. */
  lanes: Array<{ session: string; routes: string[] }>;
  /** This run's steps, in the order they were taken, at most MAX_RECORD_STEPS. */
  steps: RunStep[];
  /** What it left on each route it worked on that has anything left. */
  left: RouteLeft[];
  /** Its gap ledger, line by line. */
  gaps: string[];
  /** Set when the run itself started from an earlier one: how, and which. */
  followed?: { mode: FromRunMode; runId: string };
  /**
   * A continued run's replays of the earlier run's path to a lane's first page
   * (prefixPlan), each with its outcome (PrefixNote) and why it was not
   * replayed.
   */
  prefixes?: PrefixNote[];
  /** Set when the run was asked to continue a record with no work left on any route, and explored as a fresh run instead. */
  continuedFresh?: true;
}

/** How a continued run reached one lane's first page. */
export interface PrefixNote {
  session: string;
  target: string;
  steps: number;
  /** replayed: the path ended on the page. navigated: it did not, and the page was opened by its address. unreached: neither worked (or the page is a pattern no address opens). */
  outcome: "replayed" | "navigated" | "unreached";
  why?: string;
}

/** The most steps a record keeps: a replay of more would not fit a model's first message anyway. */
export const MAX_RECORD_STEPS = 400;
/** The most routes a record lists in any one list. */
export const MAX_RECORD_ROUTES = 300;
/** The most controls, forms or options a record keeps per route. */
export const MAX_RECORD_KEYS = 40;
/** The most records a project's memory keeps; the oldest go first. */
export const MAX_RECORDS = 20;

/** A route's identity for matching: two spellings of one page are one route. */
const identity = (route: string): string => normalizePath(route);

/**
 * The log's actions that are a session working on a page, as opposed to
 * planning, signing in or bookkeeping. Whole names only: a refused click
 * (`click:refused`) did nothing, and a replay must not repeat it.
 */
const STEP_ACTION = /^(?:plan:)?(?:snapshot|navigate|click(?:×\d+)?|type|select|press|hover|upload|back)$/;

/** A typed value as the action log writes it (`← "…"`): never kept, since it may be a password the redaction cannot recognise. */
const TYPED_VALUE = /← "(?:[^"\\]|\\.)*"/g;

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** What a record is built from: the run's action log and what the report found it left. */
export interface RecordInput {
  runId: string;
  at: string;
  knownRoutes: readonly string[];
  /** The run's action log, in order. Entries are already redacted (memory.ts logAction). */
  steps: ReadonlyArray<{ session?: string; url: string; action: string; target?: string }>;
  unexercised: ReadonlyArray<{ route: string; keys: readonly string[] }>;
  forms: ReadonlyArray<{ route: string; key: string }>;
  /** Routes with a form filled in and never submitted. */
  filled: readonly string[];
  unchosen: ReadonlyArray<{ route: string; key: string; unchosen: readonly string[] }>;
  gaps: readonly string[];
  followed?: RunRecord["followed"];
}

/**
 * A run's record. Only the routes the run worked on (a step other than the
 * planning crawl landed there, by a session that did more than look) count as
 * visited, so a crawl that opened every page does not make every page read as
 * covered; what is left is kept for those routes alone.
 */
export function buildRunRecord(input: RecordInput): RunRecord {
  const all: RunStep[] = [];
  for (const s of input.steps) {
    if (!STEP_ACTION.test(s.action) || !s.url || s.url === "about:blank") continue;
    const target = s.target?.replace(TYPED_VALUE, "← (a value)").slice(0, 200);
    all.push({ session: s.session || "default", route: identity(s.url), action: s.action, ...(target ? { target } : {}) });
  }
  // A session that only ever looked (a planner's snapshot before it split the run into lanes) worked on nothing.
  const acted = new Set(all.filter((s) => s.action !== "snapshot").map((s) => s.session));
  const steps = all.filter((s) => acted.has(s.session));
  const lanes: RunRecord["lanes"] = [];
  for (const s of steps) {
    let lane = lanes.find((l) => l.session === s.session);
    if (!lane) lanes.push((lane = { session: s.session, routes: [] }));
    if (!lane.routes.includes(s.route)) lane.routes.push(s.route);
  }
  const visited = uniqueBy(
    steps.map((s) => s.route),
    (r) => r,
  );
  const filled = new Set(input.filled.map(identity));
  const left: RouteLeft[] = [];
  for (const route of visited) {
    const on = (r: string): boolean => identity(r) === route;
    const entry: RouteLeft = {
      route,
      unexercised: [...new Set(input.unexercised.filter((u) => on(u.route)).flatMap((u) => u.keys))].slice(0, MAX_RECORD_KEYS),
      forms: [...new Set(input.forms.filter((f) => on(f.route)).map((f) => f.key))].slice(0, MAX_RECORD_KEYS),
      ...(filled.has(route) ? { filled: true as const } : {}),
      unchosen: input.unchosen
        .filter((d) => on(d.route) && d.unchosen.length > 0)
        .map((d) => ({ key: d.key, options: [...d.unchosen].slice(0, MAX_RECORD_KEYS) }))
        .slice(0, MAX_RECORD_KEYS),
    };
    if (workLeft(entry) > 0) left.push(entry);
  }
  return {
    version: 1,
    runId: input.runId,
    at: input.at,
    knownRoutes: uniqueBy(input.knownRoutes, identity).slice(0, MAX_RECORD_ROUTES),
    visited: visited.slice(0, MAX_RECORD_ROUTES),
    lanes: lanes.map((l) => ({ session: l.session, routes: l.routes.slice(0, MAX_RECORD_ROUTES) })),
    steps: steps.slice(0, MAX_RECORD_STEPS),
    left: left.slice(0, MAX_RECORD_ROUTES),
    gaps: input.gaps.slice(0, 40),
    ...(input.followed ? { followed: input.followed } : {}),
  };
}

/** How much a run left on a route: every control, form and option it did not get to, and a filled form never submitted. */
export function workLeft(l: RouteLeft): number {
  return l.unexercised.length + l.forms.length + (l.filled ? 1 : 0) + l.unchosen.reduce((n, d) => n + d.options.length, 0);
}

/**
 * A record that carries the one it continued: this run's routes and what it
 * left on them, then the earlier run's visited routes, and what that run left
 * on routes this run did not work on. So a chain of runs, each continuing the
 * last, accumulates what the chain has covered rather than forgetting it. The
 * steps, lanes and gap ledger stay this run's own.
 */
export function carryForward(earlier: RunRecord, current: RunRecord): RunRecord {
  const worked = new Set(current.lanes.flatMap((l) => l.routes).map(identity));
  return {
    ...current,
    knownRoutes: uniqueBy([...current.knownRoutes, ...earlier.knownRoutes], identity).slice(0, MAX_RECORD_ROUTES),
    visited: uniqueBy([...current.visited, ...earlier.visited], identity).slice(0, MAX_RECORD_ROUTES),
    left: uniqueBy([...current.left, ...earlier.left.filter((l) => !worked.has(identity(l.route)))], (l) => identity(l.route)).slice(0, MAX_RECORD_ROUTES),
  };
}

/** A project's records as one, oldest carried into newest: what every run on it has covered and left. Null when there are none. */
export function foldRecords(records: readonly RunRecord[]): RunRecord | null {
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.reduce<RunRecord | null>((acc, r) => (acc ? carryForward(acc, r) : r), null);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A record read back from JSON, checked in full; null when anything about it is not a record this version wrote. */
export function readRunRecord(raw: unknown): RunRecord | null {
  if (!isObj(raw) || raw.version !== 1 || typeof raw.runId !== "string" || typeof raw.at !== "string") return null;
  if (!isStrings(raw.knownRoutes) || !isStrings(raw.visited) || !isStrings(raw.gaps)) return null;
  const lanes = raw.lanes;
  if (!Array.isArray(lanes) || !lanes.every((l) => isObj(l) && typeof l.session === "string" && isStrings(l.routes))) return null;
  const steps = raw.steps;
  if (
    !Array.isArray(steps) ||
    !steps.every(
      (s) =>
        isObj(s) &&
        typeof s.session === "string" &&
        typeof s.route === "string" &&
        typeof s.action === "string" &&
        (s.target === undefined || typeof s.target === "string"),
    )
  )
    return null;
  const left = raw.left;
  if (
    !Array.isArray(left) ||
    !left.every(
      (l) =>
        isObj(l) &&
        typeof l.route === "string" &&
        isStrings(l.unexercised) &&
        isStrings(l.forms) &&
        (l.filled === undefined || l.filled === true) &&
        Array.isArray(l.unchosen) &&
        l.unchosen.every((d) => isObj(d) && typeof d.key === "string" && isStrings(d.options)),
    )
  )
    return null;
  const prefixes = raw.prefixes;
  if (
    prefixes !== undefined &&
    !(
      Array.isArray(prefixes) &&
      prefixes.every(
        (n) =>
          isObj(n) &&
          typeof n.session === "string" &&
          typeof n.target === "string" &&
          typeof n.steps === "number" &&
          (n.outcome === "replayed" || n.outcome === "navigated" || n.outcome === "unreached") &&
          (n.why === undefined || typeof n.why === "string"),
      )
    )
  )
    return null;
  if (raw.continuedFresh !== undefined && raw.continuedFresh !== true) return null;
  const followed = raw.followed;
  if (
    followed !== undefined &&
    !(isObj(followed) && (FROM_RUN_MODES as readonly string[]).includes(followed.mode as string) && typeof followed.runId === "string")
  )
    return null;
  return raw as unknown as RunRecord;
}

/** Records from a parsed memory file. Anything malformed is left out. */
export function readRunRecords(raw: unknown): RunRecord[] {
  const list = isObj(raw) ? raw.runRecords : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(readRunRecord).filter((r): r is RunRecord => r !== null);
}

/** Two lists of records as one: each run once, oldest first, at most MAX_RECORDS. Idempotent. */
export function unionRecords(a: readonly RunRecord[], b: readonly RunRecord[]): RunRecord[] {
  const byRun = new Map<string, RunRecord>();
  for (const r of [...a, ...b]) {
    const had = byRun.get(r.runId);
    // A run that wrote its report twice keeps the later record.
    if (!had || had.at <= r.at) byRun.set(r.runId, r);
  }
  return [...byRun.values()].sort((x, y) => x.at.localeCompare(y.at) || x.runId.localeCompare(y.runId)).slice(-MAX_RECORDS);
}

/**
 * The record a parsed file holds: a ci.json's `record`, a memory file's
 * records folded into one, or a bare record. `what` names the file for the error.
 */
export function recordFromJson(raw: unknown, what: string): { ok: true; record: RunRecord } | { ok: false; error: string } {
  if (isObj(raw) && raw.command === "ci") {
    const record = readRunRecord(raw.record);
    return record
      ? { ok: true, record }
      : { ok: false, error: `${what} holds no run record: its run wrote no report, or was made by a version that kept none` };
  }
  if (isObj(raw) && raw.version === 1 && "states" in raw) {
    const record = foldRecords(readRunRecords(raw));
    return record
      ? { ok: true, record }
      : { ok: false, error: `${what} holds no run record: no run on this project has written its report since records were kept` };
  }
  const record = readRunRecord(raw);
  return record ? { ok: true, record } : { ok: false, error: `${what} is not a ci.json, a project's memory or a run record` };
}

// ── continue ─────────────────────────────────────────────────────────────────

/**
 * How much work a page may have left and still count as worked through: none.
 * A visited page is "covered" only when the record says every control on it
 * was exercised, every form submitted and every option chosen; visiting it is
 * not enough.
 */
export const EXHAUSTED_AT = 0;

/** Where a route goes in a continued run: 1 never worked on, 2 worked on with work left, 3 worked through (nothing recorded is left). */
export interface ContinueItem {
  route: string;
  tier: 1 | 2 | 3;
  /** For tier 2: what the earlier run left there. */
  work?: RouteLeft;
  /** For a page the earlier run reached by acting on another page: how it got there (pathLine), so the run can get there the same way. */
  path?: string;
}

/**
 * The order a continued run takes its routes in. `routesNow` are the routes
 * this run knows (its planning crawl), in the form it navigates by; the
 * record's known and visited routes join them, so a route the earlier run
 * found and this one has not yet is not lost.
 *
 * 1. Routes the record never worked on, by name.
 * 2. Routes it worked on with work left, the most left first, then by name.
 * 3. Routes it worked on and left nothing on, by name.
 *
 * Deterministic: the same record and routes give the same order, whatever
 * order they came in.
 */
export function continuePlan(record: RunRecord, routesNow: readonly string[]): ContinueItem[] {
  const candidates = uniqueBy([...routesNow, ...record.knownRoutes, ...record.visited], identity);
  const visited = new Set(record.visited.map(identity));
  const leftBy = new Map(record.left.map((l) => [identity(l.route), l]));
  const byName = (a: ContinueItem, b: ContinueItem): number => a.route.localeCompare(b.route);
  const items: ContinueItem[] = candidates.map((route) => {
    const id = identity(route);
    if (!visited.has(id)) return { route, tier: 1 };
    const work = leftBy.get(id);
    const plan = prefixPlan(record, route);
    const path = plan && "steps" in plan && !plan.direct ? { path: pathLine(plan.steps) } : {};
    return work && workLeft(work) > EXHAUSTED_AT ? { route, tier: 2, work, ...path } : { route, tier: 3, ...path };
  });
  return [
    ...items.filter((i) => i.tier === 1).sort(byName),
    ...items.filter((i) => i.tier === 2).sort((a, b) => workLeft(b.work!) - workLeft(a.work!) || byName(a, b)),
    ...items.filter((i) => i.tier === 3).sort(byName),
  ];
}

/** The most routes, and controls per route, a continued run's message spells out. */
const LINES_MAX = { routes: 30, keys: 8 };

const listOf = (xs: readonly string[], max: number): string => xs.slice(0, max).join(", ") + (xs.length > max ? ` … +${xs.length - max}` : "");

/** What to do first on one route an earlier run left work on, as one line. */
export function workLine(l: RouteLeft): string {
  const parts: string[] = [];
  if (l.forms.length > 0) parts.push(`submit the form(s) never submitted: ${listOf(l.forms, LINES_MAX.keys)}`);
  if (l.filled) parts.push(`a form was filled in and never submitted: fill it and submit it`);
  if (l.unchosen.length > 0)
    parts.push(
      `choose the options never chosen: ${l.unchosen
        .slice(0, LINES_MAX.keys)
        .map((d) => `${d.key} → ${d.options.map((o) => JSON.stringify(o)).join(", ")}`)
        .join("; ")}`,
    );
  if (l.unexercised.length > 0) parts.push(`controls never exercised: ${listOf(l.unexercised, LINES_MAX.keys)}`);
  return `${l.route}: ${parts.join("; ")}`;
}

/**
 * The lines a continued run's first message (or a lane's) carries: the three
 * tiers, and on each route with work left exactly what to take first. Given
 * `only`, the routes outside it are left out: a lane is told about its own.
 */
/**
 * Whether a continued run has nothing to continue: every route the plan holds
 * was worked through. The run then explores as a fresh one would, from the
 * landing page with nothing left out, rather than being told it is done.
 */
export function continueExhausted(items: readonly ContinueItem[]): boolean {
  return !items.some((i) => i.tier !== 3);
}

/** What a run (or a lane) is told when nothing it was given has recorded work left: explore as a fresh run, and never stop for it. */
function freshLines(from: string, lane: boolean): string[] {
  return [
    `This run continues an earlier one (${from}), which left no recorded work on ${lane ? "your routes" : "any route"}: every control it saw was exercised, every form submitted, every option chosen.`,
    `That is not a reason to stop. Explore ${lane ? "your routes" : "the app"} as a fresh run would, from ${lane ? "your first route" : "the landing page"}, with nothing left out, and spend the budget.`,
  ];
}

/**
 * The lines a continued run's first message (or a lane's) carries: the three
 * tiers, and on each route with work left exactly what to take first. Given
 * `only`, the routes outside it are left out: a lane is told about its own.
 * When none of its routes has work left, it is told to explore as a fresh run
 * (freshLines); it is never told there is nothing to do.
 */
export function continueLines(items: readonly ContinueItem[], o: { from: string; only?: readonly string[] }): string[] {
  const only = o.only ? new Set(o.only.map(identity)) : null;
  const mine = only ? items.filter((i) => only.has(identity(i.route))) : items;
  if (mine.length === 0) return [];
  if (continueExhausted(mine)) return freshLines(o.from, only !== null);
  const tier = (t: 1 | 2 | 3): ContinueItem[] => mine.filter((i) => i.tier === t);
  const [never, left, covered] = [tier(1), tier(2), tier(3)];
  return [
    `This run continues an earlier one (${o.from}): take the routes in this order, so the run starts where that one left off.`,
    never.length > 0
      ? `- First, the routes it never worked on: ${listOf(
          never.map((i) => i.route),
          LINES_MAX.routes,
        )}`
      : "",
    ...(left.length > 0
      ? [
          `- ${never.length > 0 ? "Then" : "First"}, the routes it left work on, the most first. On each, do this before anything else:`,
          ...left.slice(0, LINES_MAX.routes).flatMap((i) => [`   ${workLine(i.work!)}`, ...(i.path ? [`     (it reached this page by: ${i.path})`] : [])]),
          ...(left.length > LINES_MAX.routes ? [`   … and ${left.length - LINES_MAX.routes} more route(s)`] : []),
        ]
      : []),
    covered.length > 0
      ? `- Last, the routes it worked through (nothing it recorded is left there): ${listOf(
          covered.map((i) => i.route),
          LINES_MAX.routes,
        )}`
      : "",
    `This is where to start, not the whole job: when the listed work is done, keep exploring as a fresh run would until the budget is spent.`,
  ].filter(Boolean);
}

// ── the path to a page ───────────────────────────────────────────────────────

/** A step scout_run_plan takes: a semantic target, never a snapshot ref. */
export interface PlanStep {
  action: "navigate" | "click" | "type" | "select" | "press" | "hover";
  target?: string;
  value?: string;
  pressEnter?: boolean;
  replace?: boolean;
}

/** The most steps one scout_run_plan call runs, and so the longest path replayed. */
export const MAX_PREFIX_STEPS = 20;

/** A route that is a pattern (`/orders/:id`) names no page a browser can open. */
export const isPattern = (route: string): boolean => /(^|\/)[:*]|\[[^\]]+\]/.test(route);

/** A control as the log names it (`button "Save"`) as a plan target: by role and name, quoted so the name survives. */
function roleTarget(role: string, name: string): string | null {
  if (!name.includes('"')) return `role=${role}[name="${name}"]`;
  if (!name.includes("'")) return `role=${role}[name='${name}']`;
  return null;
}

/**
 * A value to type where the earlier run's was not kept (typed values never
 * are): one a field of that name accepts, so a form that needs a value moves
 * on as it did.
 */
export function standInValue(fieldName: string): string {
  const n = fieldName.toLowerCase();
  if (/e-?mail/.test(n)) return "scout@example.com";
  if (/phone|tel/.test(n)) return "5550100";
  if (/qty|quantity|amount|number|count|price|age/.test(n)) return "1";
  if (/date/.test(n)) return "2026-01-01";
  if (/url|website|link/.test(n)) return "https://example.com";
  return "SceneScout test";
}

/**
 * One recorded step as a plan step, or a reason it cannot be one. `back`
 * becomes a navigation to the page it landed on, which the path visited.
 */
export function planStepOf(step: RunStep): PlanStep | { cannot: string } {
  const action = step.action.replace(/^plan:/, "").replace(/×\d+$/, "");
  const t = step.target ?? "";
  // A plan step's own target is already a semantic one.
  const semantic = /^(testid|text|label|role)=/.test(t);
  const control = /^([a-z]+) "(.*)$/.exec(t);
  const split = (sep: string): [string, string] | null => {
    if (!control) return null;
    const at = control[2].indexOf(sep);
    return at < 0 ? null : [control[2].slice(0, at), control[2].slice(at + sep.length)];
  };
  switch (action) {
    case "navigate": {
      if (!t) return { cannot: "a navigation with no address" };
      try {
        const u = new URL(t, "http://x");
        return { action: "navigate", target: `${u.pathname}${u.search}` };
      } catch {
        return { cannot: `an address that does not parse (${t.slice(0, 60)})` };
      }
    }
    case "back":
      return isPattern(step.route) ? { cannot: `going back to ${step.route}, a pattern` } : { action: "navigate", target: step.route };
    case "press":
      return t ? { action: "press", value: t } : { cannot: "a key press with no key" };
    case "click":
    case "hover": {
      if (semantic) return { action, target: t };
      const name = control && control[2].endsWith('"') ? control[2].slice(0, -1) : null;
      const target = control && name !== null ? roleTarget(control[1], name) : null;
      return target ? { action, target } : { cannot: `a control the log does not name (${t.slice(0, 60)})` };
    }
    case "type": {
      if (semantic) return { action: "type", target: t, value: standInValue(t), replace: true };
      const parts = split('" ← ');
      const target = control && parts ? roleTarget(control[1], parts[0]) : null;
      if (!target || !parts) return { cannot: `a field the log does not name (${t.slice(0, 60)})` };
      return { action: "type", target, value: standInValue(parts[0]), replace: true, ...(/ \+ Enter\b/.test(parts[1]) ? { pressEnter: true } : {}) };
    }
    case "select": {
      const parts = split('" = ');
      const target = control && parts ? roleTarget(control[1], parts[0]) : null;
      if (!target || !parts) return { cannot: `a dropdown the log does not name (${t.slice(0, 60)})` };
      return { action: "select", target, value: parts[1].replace(/ \(matched option .*$/, "") };
    }
    default:
      return { cannot: `a ${action} step, which a plan cannot repeat` };
  }
}

/**
 * The path the earlier run took to a page, as plan steps: in the session that
 * first reached it, from the last page it opened by address up to the step
 * that landed there, leaving out snapshots. `direct` when the page was itself
 * opened by address, so no step on another page is needed. Null when the
 * record never reached the page; `cannot` when a step of the path cannot be
 * repeated or the path is longer than one plan.
 */
export function prefixPlan(record: RunRecord, target: string): { steps: PlanStep[]; direct: boolean; session: string } | { cannot: string } | null {
  const id = identity(target);
  const first = record.steps.find((s) => s.route === id && s.action !== "snapshot");
  if (!first) return null;
  const mine = record.steps.filter((s) => s.session === first.session);
  const k = mine.indexOf(first);
  const isNav = (s: RunStep): boolean => /^(plan:)?navigate$/.test(s.action);
  let j = k;
  while (j >= 0 && !isNav(mine[j])) j -= 1;
  const path = mine.slice(Math.max(j, 0), k + 1).filter((s) => s.action !== "snapshot");
  // A session that never opened a page by address started where it attached: the first page it was on.
  // Only a snapshot says which page that was: any other step's route is where the step landed, not where it began.
  if (j < 0 && mine[0].action !== "snapshot") return { cannot: "the session opened no page by its address before reaching it" };
  if (j < 0 && isPattern(mine[0].route)) return { cannot: `the session started on ${mine[0].route}, a pattern` };
  const start: RunStep[] = j < 0 ? [{ session: first.session, route: mine[0].route, action: "navigate", target: mine[0].route }] : [];
  const all = [...start, ...path];
  if (all.length > MAX_PREFIX_STEPS) return { cannot: `the path is ${all.length} steps, more than one plan runs (${MAX_PREFIX_STEPS})` };
  const steps: PlanStep[] = [];
  for (const s of all) {
    const p = planStepOf(s);
    if ("cannot" in p) return { cannot: p.cannot };
    steps.push(p);
  }
  return { steps, direct: steps.every((s) => s.action === "navigate"), session: first.session };
}

/** A path as one line for a model to follow. */
export function pathLine(steps: readonly PlanStep[]): string {
  return steps.map((s) => `${s.action}${s.target ? ` ${s.target}` : ""}${s.value && s.action !== "type" ? ` ${JSON.stringify(s.value)}` : ""}`).join(" → ");
}

/**
 * Whether a scout_run_plan reply says the path was taken: every step ran and
 * ended OK, and the last one ended on the target page. A step can end OK and
 * leave the page where it was (a stand-in value the form refuses, a button
 * that now goes elsewhere), so where it ended is checked too.
 */
export function prefixOutcome(reply: string, steps: number, target: string): { ok: true } | { ok: false; why: string } {
  const ran = /^PLAN \((\d+)\/(\d+) steps ran\)/m.exec(reply);
  if (/^ERROR:/.test(reply))
    return {
      ok: false,
      why: reply
        .replace(/^ERROR:\s*/, "")
        .split("\n")[0]
        .slice(0, 200),
    };
  if (!ran) return { ok: false, why: "the plan's reply did not say how many steps ran" };
  // A step that ran and did not succeed still counts as run: its own line says how it ended, and only "OK" moved the path on.
  const notOk = reply.split("\n").find((l) => /^\d+\. .* → /.test(l) && !/ → OK\b/.test(l));
  if (/PLAN ABORTED at step/.test(reply) || Number(ran[1]) < steps || notOk)
    return { ok: false, why: `${ran[1]} of ${steps} step(s) ran${notOk ? `: ${notOk.trim().slice(0, 160)}` : ""}` };
  const ends = [...reply.matchAll(/^\d+\. .* → OK \(([^)\s]+)\)/gm)].at(-1)?.[1];
  if (!ends) return { ok: false, why: "the plan did not say which page it ended on" };
  if (identity(ends) !== identity(target)) return { ok: false, why: `every step ran, and it ended on ${identity(ends)}, not ${identity(target)}` };
  return { ok: true };
}

// ── replay ───────────────────────────────────────────────────────────────────

/** One session of a replay: the routes it takes and its steps, in the order the recorded run took them. */
export interface ReplayLane {
  session: string;
  routes: string[];
  steps: RunStep[];
}

/** The recorded run's sessions with their routes and steps, in recorded order; a session that took no step is left out. */
export function replayPlan(record: RunRecord): ReplayLane[] {
  return record.lanes
    .map((l) => ({ session: l.session, routes: [...l.routes], steps: record.steps.filter((s) => s.session === l.session) }))
    .filter((l) => l.steps.length > 0);
}

/** The most steps a replay's message lists. */
const REPLAY_STEPS_MAX = 150;

/** A replayed session's steps, numbered, one per line. */
export function replayLines(lane: ReplayLane, o: { from: string }): string[] {
  const shown = lane.steps.slice(0, REPLAY_STEPS_MAX);
  return [
    `This run replays an earlier one (${o.from}): follow its route and step order exactly, one step at a time, and file what you find as usual. Where a step's control is gone or the page differs, say so in a note and take the next step.`,
    `Routes, in order: ${listOf(lane.routes, LINES_MAX.routes)}`,
    `Steps (${lane.steps.length}):`,
    ...shown.map((s, i) => `  ${i + 1}. ${s.action}${s.target ? ` ${s.target}` : ""} → ${s.route}`),
    ...(lane.steps.length > shown.length
      ? [`  … ${lane.steps.length - shown.length} more step(s) not listed: carry on in the same spirit until the budget ends.`]
      : []),
  ];
}

// ── what a run says about it ─────────────────────────────────────────────────

/** A run's note that it started from an earlier one, as the project's memory keeps it for the report. */
export interface FromRunNote {
  /** When the run read the record. */
  at: string;
  mode: FromRunMode;
  /** Where the record came from, as the run was given it. */
  source: string;
  /** The record's run, and when it was made. */
  runId: string;
  recordAt: string;
}

/** Notes from a parsed memory file. Anything malformed is left out. */
export function readFromRunNotes(raw: unknown): FromRunNote[] {
  const list = isObj(raw) ? raw.fromRuns : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (n): n is FromRunNote =>
      isObj(n) &&
      typeof n.at === "string" &&
      (FROM_RUN_MODES as readonly string[]).includes(n.mode as string) &&
      typeof n.source === "string" &&
      typeof n.runId === "string" &&
      typeof n.recordAt === "string",
  );
}

/** Two lists of notes as one: each once, oldest first, at most MAX_RECORDS. Idempotent. */
export function unionFromRunNotes(a: readonly FromRunNote[], b: readonly FromRunNote[]): FromRunNote[] {
  const byKey = new Map<string, FromRunNote>();
  for (const n of [...a, ...b]) byKey.set(`${n.at}\u0000${n.mode}\u0000${n.runId}`, n);
  return [...byKey.values()].sort((x, y) => x.at.localeCompare(y.at)).slice(-MAX_RECORDS);
}

/** One line on what a run started from, for a log, a brief, a summary or a report. */
export function fromRunLine(n: Pick<FromRunNote, "mode" | "source" | "recordAt">): string {
  return `${n.mode === "continue" ? "continued from" : "replayed"} the run recorded in ${n.source} (its report of ${n.recordAt})`;
}
