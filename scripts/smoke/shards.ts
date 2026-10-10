/**
 * Which suites one CI job runs when the browser suite is split across jobs.
 *
 * `npm run smoke:run -- --shard 2/3` runs the second of three shards. The
 * shards are fixed lists in scripts/smoke.ts, not a split computed at run time:
 * suites run in order and some depend on what an earlier one recorded, so a
 * shard is a run of the suites that belong together, balanced by hand from the
 * measured time of each. The count is written into the argument as well, so a
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
