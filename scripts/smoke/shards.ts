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
