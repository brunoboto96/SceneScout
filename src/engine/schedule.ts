/**
 * A seeded exploration schedule: the order a run takes its routes (and, where
 * a project has them, its saved roles) in, decided by a seed rather than by
 * whatever comes first.
 *
 * Left to itself, every run starts with the same obvious routes, so repeated
 * runs keep finding the same things while other parts of the app stay
 * untouched. With a seed, the order is a deterministic shuffle keyed on it
 * (SHA-256 of the seed and the item), so the same seed gives the same order on
 * any machine and a run can be repeated exactly, while a new seed gives a new
 * order. Choices earlier seeded runs began with are recorded in the project's
 * memory and go to the back of the order, or are skipped, so successive runs
 * spread over the app instead of repeating.
 *
 * Opt-in: with no seed, nothing here is used and a run behaves as it always
 * has. Pure, so the order, the precedence of the settings and the exclusion
 * are table-tested (scripts/brief-test.ts) without a browser.
 */
import { createHash, randomBytes } from "node:crypto";
import { stripRouteQuery } from "./fingerprint.js";

/** Turns seeding on for every run that does not pass a seed itself: a seed, or `auto` for a fresh one each run. */
export const SEED_ENV = "SCENESCOUT_SEED";
/** What happens to choices earlier seeded runs began with: `back` (the default) or `skip`. */
export const SEED_EXCLUSION_ENV = "SCENESCOUT_SEED_EXCLUSION";

/** The seed value that asks for a generated one. */
export const SEED_AUTO = "auto";
/** A seed is printed, recorded and passed back on a command line: short, and nothing a shell or a report needs to escape. */
export const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * `back`: choices earlier seeded runs began with are ordered after every
 * choice they did not, the least-chosen first. `skip`: they are left out, as
 * long as anything not yet chosen as often remains; once every choice has been
 * made as often as any other, the cycle starts again.
 */
export const SEED_EXCLUSIONS = ["back", "skip"] as const;
export type SeedExclusion = (typeof SEED_EXCLUSIONS)[number];
export const DEFAULT_SEED_EXCLUSION: SeedExclusion = "back";

/** How many routes at the head of each order a run records as its choices: what the next seeded run moves to the back. */
export const RECORDED_STARTS = 3;

/** A seed as a run uses it: the value, and whether the run made it up (so it is printed for repeating). */
export interface Seed {
  value: string;
  generated: boolean;
}

/** Check a seed's text. `source` names where it came from, so the error says what to fix. */
export function checkSeed(raw: string, source: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (value === SEED_AUTO || SEED_PATTERN.test(value)) return { ok: true, value };
  return { ok: false, error: `${source} must be ${SEED_AUTO} or 1 to 64 letters, digits, dots, dashes or underscores (got ${JSON.stringify(raw)})` };
}

/** A fresh seed: eight hex digits, short enough to read off a log and type back. */
export function generateSeed(random: (n: number) => Buffer = randomBytes): string {
  return random(4).toString("hex");
}

/**
 * The seed a run uses: the option, else the environment variable, else none.
 * `auto` from either asks for a generated one. An empty variable is unset. A
 * value that is neither a seed nor `auto` is refused, naming where it came
 * from, rather than quietly running unseeded.
 */
export function resolveSeed(
  option: string | undefined,
  env: Record<string, string | undefined>,
  generate: () => string = generateSeed,
  optionName = "--seed",
): { ok: true; seed?: Seed } | { ok: false; error: string } {
  const fromEnv = (env[SEED_ENV] ?? "").trim();
  const [raw, source] = option !== undefined ? [option, optionName] : fromEnv ? [fromEnv, SEED_ENV] : [undefined, ""];
  if (raw === undefined) return { ok: true };
  const checked = checkSeed(raw, source);
  if (!checked.ok) return checked;
  return { ok: true, seed: checked.value === SEED_AUTO ? { value: generate(), generated: true } : { value: checked.value, generated: false } };
}

/** The exclusion a run uses: the option, else the environment variable, else `back`. */
export function resolveSeedExclusion(
  option: string | undefined,
  env: Record<string, string | undefined>,
  optionName = "--seed-exclusion",
): { ok: true; value: SeedExclusion } | { ok: false; error: string } {
  const fromEnv = (env[SEED_EXCLUSION_ENV] ?? "").trim();
  const [raw, source] = option !== undefined ? [option.trim(), optionName] : fromEnv ? [fromEnv, SEED_EXCLUSION_ENV] : [DEFAULT_SEED_EXCLUSION, ""];
  if ((SEED_EXCLUSIONS as readonly string[]).includes(raw)) return { ok: true, value: raw as SeedExclusion };
  return { ok: false, error: `${source} must be one of ${SEED_EXCLUSIONS.join(", ")} (got ${JSON.stringify(raw)})` };
}

/** An item's place under a seed: SHA-256 of the seed and the item, so it depends on nothing else. */
export function seededRank(seed: string, item: string): string {
  return createHash("sha256").update(seed).update("\u0000").update(item).digest("hex");
}

/** The items in the seed's order. Equal items keep a stable order; nothing about the input order matters. */
export function seededOrder<T>(items: readonly T[], seed: string, key: (item: T) => string = String): T[] {
  return items
    .map((item) => ({ item, k: key(item), rank: seededRank(seed, key(item)) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.k.localeCompare(b.k)))
    .map((x) => x.item);
}

/** What a schedule needs: the seed, how often earlier seeded runs began with each choice, and what to do with those. */
export interface ScheduleInput {
  seed: string;
  /** Choice → how many earlier seeded runs began with it. Absent means never. */
  earlier?: ReadonlyMap<string, number>;
  exclusion?: SeedExclusion;
}

/**
 * The items in the order a seeded run takes them: the ones earlier seeded runs
 * began with least often first, each group in the seed's order. With `skip`,
 * only the least-chosen group is kept, which is every item once all have been
 * chosen equally often, so the order is never empty while there are items.
 */
export function scheduleOrder<T>(items: readonly T[], s: ScheduleInput, key: (item: T) => string = String): T[] {
  // A record holds a route as recordedForm leaves it (memory.ts), so it is looked up the same way.
  const times = (item: T): number => s.earlier?.get(recordedForm(key(item))) ?? 0;
  const ordered = seededOrder(items, s.seed, key);
  // A stable sort: within one count, the seed's order stands.
  const byCount = [...ordered].sort((a, b) => times(a) - times(b));
  if ((s.exclusion ?? DEFAULT_SEED_EXCLUSION) === "back" || byCount.length === 0) return byCount;
  const least = times(byCount[0]);
  return byCount.filter((item) => times(item) === least);
}

/** A choice as a record keeps it: a route without its query string or fragment, which can carry a token (fingerprint.ts). */
export function recordedForm(choice: string): string {
  return stripRouteQuery(choice);
}

/** What one seeded run began with, as the project's memory keeps it. */
export interface ScheduleRecord {
  seed: string;
  /** When the run made it, as an ISO time. */
  at: string;
  /** Which run made it: `ci`, or a planner's `scout_lane_brief`. */
  source: "ci" | "lane-brief";
  exclusion: SeedExclusion;
  /** The routes it began with: the head of each order it handed out. */
  routes: string[];
  /** The saved role it put first, when the project has more than one. */
  roles?: string[];
}

/** The most schedules a project's memory keeps; the oldest go first. Enough for hundreds of runs. */
export const MAX_SCHEDULES = 200;

/**
 * How often earlier seeded runs began with each route, or each role. Given the
 * seed being used, a run is "earlier" only if it came before the first run
 * with that seed: a seed used again sees the history its first run saw, so it
 * repeats that run's order rather than moving its own choices to the back.
 */
export function earlierChoices(records: readonly ScheduleRecord[], what: "routes" | "roles", seed?: string): Map<string, number> {
  const first =
    seed === undefined
      ? undefined
      : records.filter((r) => r.seed === seed).reduce<string | undefined>((m, r) => (m === undefined || r.at < m ? r.at : m), undefined);
  const counts = new Map<string, number>();
  for (const r of records) {
    if (first !== undefined && r.at >= first) continue;
    for (const choice of new Set(r[what] ?? [])) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  }
  return counts;
}

/** The choices a run records: the first RECORDED_STARTS of each order it handed out, each once. */
export function startsOf(orders: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(orders.flatMap((o) => o.slice(0, RECORDED_STARTS)))];
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Schedules from a parsed memory file, checked just enough to be used. Anything malformed is left out. */
export function readSchedules(raw: unknown): ScheduleRecord[] {
  const list = raw && typeof raw === "object" ? (raw as { schedules?: unknown }).schedules : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is ScheduleRecord =>
      !!r &&
      typeof r === "object" &&
      typeof (r as ScheduleRecord).seed === "string" &&
      typeof (r as ScheduleRecord).at === "string" &&
      ((r as ScheduleRecord).source === "ci" || (r as ScheduleRecord).source === "lane-brief") &&
      (SEED_EXCLUSIONS as readonly string[]).includes((r as ScheduleRecord).exclusion) &&
      isStrings((r as ScheduleRecord).routes) &&
      ((r as ScheduleRecord).roles === undefined || isStrings((r as ScheduleRecord).roles)),
  );
}

/** Two lists of schedules as one: each record once, oldest first, at most MAX_SCHEDULES. Idempotent, so merging the same document twice changes nothing. */
export function unionSchedules(a: readonly ScheduleRecord[], b: readonly ScheduleRecord[]): ScheduleRecord[] {
  const byKey = new Map<string, ScheduleRecord>();
  for (const r of [...a, ...b]) byKey.set(`${r.at}\u0000${r.source}\u0000${r.seed}`, r);
  return [...byKey.values()].sort((x, y) => x.at.localeCompare(y.at)).slice(-MAX_SCHEDULES);
}

/** One line on a run's seed, for a log, a brief or a report: what it was, and how to repeat it. */
export function seedLine(seed: Seed, exclusion: SeedExclusion, repeatWith: string): string {
  return (
    `Seed: ${seed.value}${seed.generated ? " (generated)" : ""}, earlier seeded runs' starting choices ${exclusion === "skip" ? "skipped" : "moved to the back"}. ` +
    `${repeatWith} ${seed.value} repeats this order on the same routes.`
  );
}
