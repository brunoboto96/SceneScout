/**
 * Score a run against an answer key.
 *
 *   npm run bench -- <projectDir> [--level medium] [--key demo-app/answer-key.json] [--json scorecard.json]
 *
 * <projectDir> is the directory the run attached with, whose `.scenescout/`
 * holds its memory. Use a FRESH one per run: a project's memory accumulates
 * findings across runs, and scoring an accumulated one credits a run with what
 * an earlier run found. For the demo app, restart `npm run demo:serve` between
 * runs too, so orders created by one run are not there for the next.
 */
import fs from "node:fs";
import path from "node:path";
import { formatScorecard, LEVELS, score, type AnswerKey, type Level } from "../src/engine/bench.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const projectDir = positional[0];
if (!projectDir) fail("Usage: npm run bench -- <projectDir> [--level minimal|medium|extensive] [--key <answer-key.json>] [--json <out.json>]");

const level = (arg("level") ?? "medium") as Level;
if (!LEVELS.includes(level)) fail(`--level must be one of ${LEVELS.join(", ")}, not ${JSON.stringify(level)}.`);

const keyPath = arg("key") ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "demo-app", "answer-key.json");
const memoryPath = path.join(projectDir, ".scenescout", "memory.json");
if (!fs.existsSync(memoryPath)) fail(`No memory at ${memoryPath} — point this at the directory the run attached with.`);

let key: AnswerKey;
let memory: { findings?: unknown[]; laneDecisions?: unknown[] };
try {
  key = JSON.parse(fs.readFileSync(keyPath, "utf8")) as AnswerKey;
} catch (err) {
  fail(`Could not read the answer key at ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
}
try {
  memory = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
} catch (err) {
  fail(`Could not read ${memoryPath}: ${err instanceof Error ? err.message : String(err)}`);
}

const card = score(key, (memory.findings ?? []) as Parameters<typeof score>[1], (memory.laneDecisions ?? []) as Parameters<typeof score>[2], level);
console.log(formatScorecard(card));

const out = arg("json");
if (out) {
  fs.writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  console.log(`\nWrote ${out}`);
}
