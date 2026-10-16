/**
 * Which suites one CI job runs when the browser suite is split across jobs.
 *
 * `npm run smoke:run -- --shard 2/3` runs the second of three shards. The split
 * is computed from the suites' measured times (scripts/smoke/timings.json, read
 * from a CI run's log by scripts/smoke/timings.ts): `balanceShards` hands each
 * suite, longest first, to the shard with the least time so far, so a new suite
 * lands where there is room rather than where someone remembered to put it.
 * It depends only on the committed times and the suite list, so every job of a
 * run computes the same split. Suites that share state are placed as one unit
 * and keep their order. The count is written into the argument as well, so a
 * workflow that runs three shards cannot quietly skip a fourth added here.
 */

export interface ShardArg {
  /** 1-based. */
  index: number;
  count: number;
}

/** Read `--shard k/n` out of `argv`; undefined when it is absent. Throws on a malformed value. */
export function parseShard(argv: readonly string[]): ShardArg | undefined {
  const at = argv.indexOf("--shard");
  if (at === -1) return undefined;
  const value = argv[at + 1] ?? "";
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error(`--shard takes k/n, such as 2/3; got "${value}"`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`--shard ${value}: k must be between 1 and n`);
  return { index, count };
}

/** The arguments other than `--shard` and its value: what is left is the title filter. */
export function withoutShard(argv: readonly string[]): string[] {
  const at = argv.indexOf("--shard");
  return at === -1 ? [...argv] : [...argv.slice(0, at), ...argv.slice(at + 2)];
}

/** The suites shard `arg` runs, or every suite in order when no shard was asked for. */
export function pickShard<T>(shards: readonly (readonly T[])[], arg: ShardArg | undefined): T[] {
  if (!arg) return shards.flat();
  if (arg.count !== shards.length) {
    throw new Error(`--shard ${arg.index}/${arg.count}: the browser suite has ${shards.length} shards, so the workflow must run ${shards.length}`);
  }
  return [...shards[arg.index - 1]];
}

/**
 * What is wrong with a split, as sentences; empty when nothing is. `files` are the titles the suite files under
 * scripts/smoke/ declare, so a suite left out of every shard is named rather than never run. `together` are pairs that
 * share state: the first records what the second reads, so they must share a shard, in that order. The smoke runner
 * checks its real split with this before running anything; it is here, apart from the suites, so it can be
 * table-tested without loading them (they need the built engine).
 */
export function shardProblems(
  shards: readonly (readonly { title: string }[])[],
  files: readonly string[],
  together: readonly (readonly [string, string])[],
): string[] {
  const problems: string[] = [];
  const listed = shards.flat().map((s) => s.title);
  for (const title of new Set(listed)) if (listed.filter((t) => t === title).length > 1) problems.push(`"${title}" is in more than one shard, or twice in one`);
  for (const title of files) if (!listed.includes(title)) problems.push(`"${title}" is in no shard, so it would never run`);
  for (const title of listed) if (!files.includes(title)) problems.push(`"${title}" is in a shard but no suite file declares it`);
  const at = (title: string): [number, number] => {
    const shard = shards.findIndex((sh) => sh.some((s) => s.title === title));
    return [shard, shard === -1 ? -1 : shards[shard].findIndex((s) => s.title === title)];
  };
  for (const [first, second] of together) {
    const [a, i] = at(first);
    const [b, j] = at(second);
    if (a === -1 || b === -1) continue;
    if (a !== b) problems.push(`"${first}" and "${second}" share state, so they must be in one shard`);
    else if (i > j) problems.push(`"${first}" must run before "${second}", which reads what it recorded`);
  }
  return problems;
}

/** The title a suite file declares (`export const title = "…"`), or undefined for a helper module. */
export function declaredTitle(source: string): string | undefined {
  return /^export const title = "((?:[^"\\]|\\.)*)";/m.exec(source)?.[1];
}

/** Suites that share state: the first records what the second reads, so they run in one shard, in this order. */
export const TOGETHER: readonly (readonly [string, string])[] = [["read-only exploration", "cross-run memory, safe-write, uploads"]];

/** The weight a suite with no measured time is given: about the median suite's time on CI. */
export const DEFAULT_SUITE_SECONDS = 20;

/**
 * Split `suites` into `count` shards so their measured times are as even as a greedy split makes them. Each unit (one
 * suite, or the suites `together` joins) goes, longest first, to the shard with the least time so far; `extra` is time
 * a shard's job spends on other work (the unit suites on one of them), counted as already there. Equal times go by
 * title and an equal load to the lower shard, so the split is the same on every run and whatever order the suites
 * were read in. Each shard keeps the suites' listed order.
 */
export function balanceShards<T extends { title: string }>(
  suites: readonly T[],
  count: number,
  seconds: Readonly<Record<string, number>>,
  options: { together?: readonly (readonly [string, string])[]; extra?: readonly number[]; defaultSeconds?: number } = {},
): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`a split needs at least one shard; got ${count}`);
  const weight = (title: string): number => {
    const s = seconds[title];
    return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s : (options.defaultSeconds ?? DEFAULT_SUITE_SECONDS);
  };
  // Each suite's unit: the suites that share state are joined into one.
  const unitOf = suites.map((_, i) => i);
  const find = (i: number): number => (unitOf[i] === i ? i : find(unitOf[i]));
  for (const [a, b] of options.together ?? []) {
    const i = suites.findIndex((s) => s.title === a);
    const j = suites.findIndex((s) => s.title === b);
    if (i !== -1 && j !== -1) unitOf[Math.max(find(i), find(j))] = Math.min(find(i), find(j));
  }
  const units = new Map<number, number[]>();
  suites.forEach((_, i) => units.set(find(i), [...(units.get(find(i)) ?? []), i]));
  const titleOf = (unit: { members: number[] }): string => suites[unit.members[0]].title;
  const ordered = [...units.values()]
    .map((members) => ({ members, seconds: members.reduce((sum, i) => sum + weight(suites[i].title), 0) }))
    // Ties go by title, not by position, so the split does not depend on the order the suites were read in.
    .sort((x, y) => y.seconds - x.seconds || (titleOf(x) < titleOf(y) ? -1 : titleOf(x) > titleOf(y) ? 1 : 0));
  const load = Array.from({ length: count }, (_, k) => options.extra?.[k] ?? 0);
  const placed: number[][] = Array.from({ length: count }, () => []);
  for (const unit of ordered) {
    const k = load.indexOf(Math.min(...load));
    load[k] += unit.seconds;
    placed[k].push(...unit.members);
  }
  return placed.map((members) => members.sort((a, b) => a - b).map((i) => suites[i]));
}

/** The measured seconds a shard's suites take, with the default for a suite never measured. */
export function shardSeconds(shard: readonly { title: string }[], seconds: Readonly<Record<string, number>>, defaultSeconds = DEFAULT_SUITE_SECONDS): number {
  return shard.reduce((sum, s) => sum + (typeof seconds[s.title] === "number" ? seconds[s.title] : defaultSeconds), 0);
}

/**
 * Each suite's time in a browser-suite log, from the timestamps on its header line (`━━ title ━━`) and the next one,
 * or the line that ends the run. A job log from `gh run view --job <id> --log` stamps every line; a line with no stamp
 * is skipped, and a suite the log never finished (a cancelled job) is left out rather than given a short time.
 */
export function suiteSecondsFromLog(log: string): Record<string, number> {
  const out: Record<string, number> = {};
  let open: { title: string; at: number } | undefined;
  for (const line of log.split(/\r?\n/)) {
    const m = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z (.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(`${m[1]}${(m[2] ?? "").slice(0, 4)}Z`);
    const header = /^━━ (.+) ━━$/.exec(m[3].trim());
    const end = /^SMOKE (PASSED|FAILED|CRASHED)/.test(m[3].trim());
    if (!header && !end) continue;
    if (open) out[open.title] = Math.round((at - open.at) / 1000);
    open = header ? { title: header[1], at } : undefined;
  }
  return out;
}
