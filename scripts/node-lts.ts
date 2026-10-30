/**
 * Whether the Node floor and CI's cells are on maintained LTS lines on a given day (ADR 34). It depends on the
 * date, so it runs weekly in `node-lts.yml` rather than in a pull request's suite; install-test holds the rule on
 * fixed dates. Run it directly to check today: `npx tsx scripts/node-lts.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FULL_PLATFORMS } from "./test-plan.mjs";

// Node's release schedule (github.com/nodejs/Release, schedule.json): each LTS line's end of life.
// Add a line when it becomes LTS; ADR 34 says when the default moves to it.
export const NODE_LTS_END_OF_LIFE: Readonly<Record<number, string>> = { 20: "2026-04-30", 22: "2027-04-30", 24: "2028-04-30", 26: "2029-04-30" };

/** The LTS lines still maintained on `today` (YYYY-MM-DD), oldest first. */
export function maintainedLtsLines(today: string): number[] {
  return Object.entries(NODE_LTS_END_OF_LIFE)
    .filter(([, end]) => end > today)
    .map(([major]) => Number(major))
    .sort((a, b) => a - b);
}

/** What is out of date on `today`: an engines floor not on the oldest maintained line, or a CI cell on an ended one. */
export function ltsProblems(opts: { floorMajor: number; cellMajors: readonly number[]; today: string }): string[] {
  const maintained = maintainedLtsLines(opts.today);
  if (maintained.length === 0) return [`no Node LTS line in the table is maintained on ${opts.today}: add the current lines to scripts/node-lts.ts`];
  const problems: string[] = [];
  if (opts.floorMajor !== maintained[0])
    problems.push(
      `engines start on Node ${opts.floorMajor}; the oldest LTS line maintained on ${opts.today} is ${maintained[0]}: move the floor with its docs, test cell and @types/node (ADR 34)`,
    );
  for (const major of new Set(opts.cellMajors))
    if (!maintained.includes(major)) problems.push(`CI runs a cell on Node ${major}, which is not a maintained LTS line on ${opts.today}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { engines: { node: string } };
  const m = /^>=\s*(\d+)/.exec(pkg.engines.node.trim());
  if (!m) throw new Error(`engines.node is not a lower bound: ${pkg.engines.node}`);
  const today = new Date().toISOString().slice(0, 10);
  const problems = ltsProblems({ floorMajor: Number(m[1]), cellMajors: FULL_PLATFORMS.map((p) => p.node), today });
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length) process.exit(1);
  console.log(`Node ${m[1]} is the oldest LTS line maintained on ${today}, and every CI cell is on a maintained line.`);
}
