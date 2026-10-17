/**
 * Refresh scripts/smoke/timings.json, the measured times the browser suite's shards are balanced on, from CI logs:
 *
 *   gh run view --job <id> --log > shard1.log   (one per shard of the ubuntu-latest, Node 24 suite job)
 *   npx tsx scripts/smoke/timings.ts shard1.log shard2.log shard3.log
 *
 * Each suite's time is the gap between its header line and the next (suiteSecondsFromLog in shards.ts). A suite in
 * more than one log gets the mean. Every suite in the logs replaces its old time; a suite the logs do not name keeps
 * the time it had, and `jobExtra` (time the shard jobs spend outside the browser suite) is kept as it is.
 */
import fs from "node:fs";
import path from "node:path";
import { suiteSecondsFromLog } from "./shards.ts";

export interface Timings {
  /** Where and when the times were measured, for a reader deciding whether they are stale. */
  measured: string;
  /** Seconds a shard's CI job spends on work other than its suites, by shard (the unit suites run on shard 2). */
  jobExtra: number[];
  /** Seconds each suite took, by title. */
  suites: Record<string, number>;
}

export const TIMINGS_FILE = path.join(import.meta.dirname, "timings.json");

export function readTimings(file = TIMINGS_FILE): Timings {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Timings;
}

function main(argv: string[]): void {
  const at = argv.indexOf("--measured");
  const measured = at === -1 ? undefined : argv[at + 1];
  const logs = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  if (logs.length === 0) throw new Error("usage: tsx scripts/smoke/timings.ts [--measured <where and when>] <job log>...");
  const seen: Record<string, number[]> = {};
  for (const log of logs) for (const [title, s] of Object.entries(suiteSecondsFromLog(fs.readFileSync(log, "utf8")))) (seen[title] ??= []).push(s);
  if (Object.keys(seen).length === 0) throw new Error("no suite header with a timestamp in those logs: pass logs from `gh run view --job <id> --log`");
  const old = readTimings();
  const suites = { ...old.suites };
  for (const [title, times] of Object.entries(seen)) suites[title] = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const next: Timings = { measured: measured ?? old.measured, jobExtra: old.jobExtra, suites };
  fs.writeFileSync(TIMINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${Object.keys(seen).length} suite times written to ${path.relative(process.cwd(), TIMINGS_FILE)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main(process.argv.slice(2));
