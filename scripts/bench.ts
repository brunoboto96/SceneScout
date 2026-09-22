/**
 * Score a run against an answer key.
 *
 *   npm run bench -- <projectDir | run.json> [--level medium] [--key <key.json>] [--json <out.json>]
 *   npm run bench -- --archive <projectDir> --run <name> --date <YYYY-MM-DD> --note "<what changed>"
 *   npm run bench -- --all [--level medium]
 *
 * A project directory is the one a run attached with; its `.scenescout/`
 * holds the run's memory. Use a FRESH one per run: a project's memory
 * accumulates findings across runs, and scoring an accumulated one credits a
 * run with what an earlier run found. For the demo app, restart
 * `npm run demo:serve` between runs too, so records one run created are not
 * there for the next.
 *
 * `--archive` keeps what scoring reads — findings and lane decisions, with
 * local paths removed — under bench/runs/, so the run can be re-scored when the
 * key changes. `--all` re-scores every archive against the current key, which
 * is what keeps a before-and-after pair comparable: two scorecards from
 * different keys are not.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatScorecard, LEVELS, parseKey, precisionBounds, score, toArchive, type AnswerKey, type Level, type RunArchive } from "../src/engine/bench.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = path.join(root, "bench", "runs");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE =
  "Usage:\n" +
  "  npm run bench -- <projectDir | run.json> [--level minimal|medium|extensive] [--key <key.json>] [--json <out.json>]\n" +
  '  npm run bench -- --archive <projectDir> --run <name> --date <YYYY-MM-DD> --note "<what changed>"\n' +
  "  npm run bench -- --all [--level medium]";

// Strict: an unknown or misspelt flag, a missing value or a `--level=x` a
// hand-rolled parser misread used to score silently at the default level —
// a plausible scorecard for the wrong question.
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      level: { type: "string", default: "medium" },
      key: { type: "string" },
      json: { type: "string" },
      archive: { type: "string" },
      run: { type: "string" },
      date: { type: "string" },
      note: { type: "string" },
      all: { type: "boolean", default: false },
    },
  });
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
}
const { values, positionals } = parsed;

const level = values.level as Level;
if (!LEVELS.includes(level)) fail(`--level must be one of ${LEVELS.join(", ")}, not ${JSON.stringify(level)}.`);

const keyPath = (values.key as string | undefined) ?? path.join(root, "demo-app", "answer-key.json");
let key: AnswerKey;
try {
  key = parseKey(JSON.parse(fs.readFileSync(keyPath, "utf8")));
} catch (err) {
  fail(`Could not use the answer key at ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
}

function readMemory(projectDir: string): { findings: Parameters<typeof toArchive>[3]; decisions: Parameters<typeof toArchive>[4] } {
  const memoryPath = path.join(projectDir, ".scenescout", "memory.json");
  if (!fs.existsSync(memoryPath)) fail(`No memory at ${memoryPath} — point this at the directory the run attached with.`);
  try {
    const memory = JSON.parse(fs.readFileSync(memoryPath, "utf8")) as { findings?: unknown[]; laneDecisions?: unknown[] };
    return { findings: (memory.findings ?? []) as never, decisions: (memory.laneDecisions ?? []) as never };
  } catch (err) {
    fail(`Could not read ${memoryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readArchive(file: string): RunArchive {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RunArchive;
  } catch (err) {
    fail(`Could not read the run archive ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (values.archive) {
  const name = values.run as string | undefined;
  const date = values.date as string | undefined;
  const note = values.note as string | undefined;
  if (!name || !/^[a-z0-9-]+$/.test(name)) fail(`--run needs a short name of lower-case letters, digits and hyphens.\n\n${USAGE}`);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date needs YYYY-MM-DD.\n\n${USAGE}`);
  if (!note) fail(`--note needs to say what changed in this run: the results log is useless without it.\n\n${USAGE}`);
  const { findings, decisions } = readMemory(values.archive as string);
  const out = path.join(runsDir, `${name}.json`);
  if (fs.existsSync(out)) fail(`${path.relative(root, out)} already exists. Archives are evidence; pick a new name rather than overwrite one.`);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(toArchive(name, date, note, findings, decisions), null, 2) + "\n");
  console.log(`Archived ${findings.length} finding(s) and ${decisions.length} decision(s) to ${path.relative(root, out)}.`);
  process.exit(0);
}

if (values.all) {
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")) : [];
  if (files.length === 0) fail(`No archived runs in ${path.relative(root, runsDir)}.`);
  const rows = files
    .map((f) => readArchive(path.join(runsDir, f)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.run.localeCompare(b.run))
    .map((a) => ({ a, c: score(key, a.findings, a.decisions, level) }));
  console.log(`Every archived run, re-scored against key ${rows[0].c.key} at ${level}:\n`);
  console.log(`| Run | Date | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Calibration |`);
  console.log(`|---|---|---:|---:|---:|---:|---:|---:|---|`);
  for (const { a, c } of rows) {
    const p = precisionBounds(c);
    const k = c.calibration;
    const cal = !k || k.judged === 0 ? "—" : `${k.correct}/${k.judged}, ECE ${k.ece.toFixed(2)}`;
    console.log(
      `| ${a.run} | ${a.date} | ${c.found.length}/${c.expected} | ${p.labelled} | ${c.findings} | ${c.unknown.length + c.ambiguous.length} | ${c.falsePositives.length} | ${c.judgedNotFiled.length} | ${cal} |`,
    );
  }
  process.exit(0);
}

const target = positionals[0];
if (!target || positionals.length > 1) fail(USAGE);
const source = target.endsWith(".json") ? readArchive(target) : { ...readMemory(target), run: path.basename(target), date: "", note: "" };
const card = score(key, source.findings, source.decisions, level);
console.log(formatScorecard(card));
if (values.json) {
  fs.writeFileSync(values.json as string, JSON.stringify(card, null, 2) + "\n");
  console.log(`\nWrote ${values.json}`);
}
