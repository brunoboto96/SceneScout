/**
 * Score a run against an answer key.
 *
 *   npm run bench -- <projectDir | run.json> [--app demo|holdout | --key <key.json>] [--level medium] [--json <out.json>]
 *   npm run bench -- --archive <projectDir> [--app demo|holdout] --run <name> [--date <YYYY-MM-DD>] --note "<what changed>"
 *   npm run bench -- --all [--app demo|holdout] [--level medium]
 *
 * A project directory is the one a run attached with; its `.scenescout/`
 * holds the run's memory. Use a FRESH one per run: a project's memory
 * accumulates findings across runs, and scoring an accumulated one credits a
 * run with what an earlier run found. For the demo app, restart
 * `npm run demo:serve` between runs too, so records one run created are not
 * there for the next (the same goes for `npm run holdout:serve`).
 *
 * There are two benchmark apps: the demo, which the engine and skill are tuned
 * against, and the held-out app, which nothing is ever tuned against. `--app`
 * names the one a run was made against, so it is scored with that app's key;
 * it defaults to the demo. An archive records its app, and is scored with that
 * app's key; `--key` may name a draft key, but not another benchmark app's.
 * `--all` scores each archive against its own app's key, one table per app.
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
import {
  archiveApp,
  checkKeyForArchive,
  chooseApp,
  formatScorecard,
  groupByApp,
  LEVELS,
  parseKey,
  precisionBounds,
  runDate,
  score,
  toArchive,
  type AnswerKey,
  type Level,
  type RunArchive,
} from "../src/engine/bench.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = path.join(root, "bench", "runs");

/** The benchmark apps this repository ships, by the name `--app` takes, and where each one's key lives. */
const APP_KEYS: Record<string, string> = {
  demo: path.join(root, "demo-app", "answer-key.json"),
  holdout: path.join(root, "holdout-app", "answer-key.json"),
};
const APPS = Object.keys(APP_KEYS);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE =
  "Usage:\n" +
  `  npm run bench -- <projectDir | run.json> [--app ${APPS.join("|")} | --key <key.json>] [--level minimal|medium|extensive] [--json <out.json>]\n` +
  `  npm run bench -- --archive <projectDir> [--app ${APPS.join("|")}] --run <name> [--date <YYYY-MM-DD>] --note "<what changed>"\n` +
  `  npm run bench -- --all [--app ${APPS.join("|")}] [--level medium]`;

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
      app: { type: "string" },
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

const requestedApp = values.app as string | undefined;
const keyFile = values.key as string | undefined;
if (requestedApp !== undefined && !APPS.includes(requestedApp))
  fail(`--app must be one of ${APPS.join(", ")}, not ${JSON.stringify(requestedApp)}.\n\n${USAGE}`);
if (requestedApp !== undefined && keyFile !== undefined) fail(`Choose --app or --key, not both: --app already names its key.\n\n${USAGE}`);

function loadKey(file: string): AnswerKey {
  try {
    return parseKey(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    fail(`Could not use the answer key at ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
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

// Each mode takes only its own inputs. An argument a mode ignores is one the
// caller thinks did something.
const archiveOnly = (["run", "date", "note"] as const).filter((o) => values[o] !== undefined);
if (!values.archive && archiveOnly.length) fail(`--${archiveOnly[0]} only applies to --archive.\n\n${USAGE}`);
if ((values.archive || values.all) && positionals.length)
  fail(`${values.archive ? "--archive" : "--all"} takes no other path: ${positionals.join(" ")}\n\n${USAGE}`);
if ((values.archive || values.all) && values.json) fail(`--json applies only to scoring one run.\n\n${USAGE}`);
if (values.archive && values.all) fail(`Choose --archive or --all, not both.\n\n${USAGE}`);
// An archive is scored by its app's key, and --all scores archives of more
// than one app: one key file for all of them would score some against the
// wrong answers.
if ((values.archive || values.all) && keyFile) fail(`--key applies only to scoring one run; use --app to choose the app.\n\n${USAGE}`);

if (values.archive) {
  const name = values.run as string | undefined;
  const note = values.note as string | undefined;
  if (!name || !/^[a-z0-9-]+$/.test(name)) fail(`--run needs a short name of lower-case letters, digits and hyphens.\n\n${USAGE}`);
  if (!note) fail(`--note needs to say what changed in this run: the results log is useless without it.\n\n${USAGE}`);
  const { findings, decisions } = readMemory(values.archive as string);
  let date: string;
  try {
    date = runDate(decisions, values.date as string | undefined);
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  const app = chooseApp({ requested: requestedApp, known: APPS });
  const out = path.join(runsDir, `${name}.json`);
  if (fs.existsSync(out)) fail(`${path.relative(root, out)} already exists. Archives are evidence; pick a new name rather than overwrite one.`);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(toArchive(name, date, note, findings, decisions, app), null, 2) + "\n");
  console.log(`Archived ${findings.length} finding(s) and ${decisions.length} decision(s) of a ${app} run to ${path.relative(root, out)}.`);
  process.exit(0);
}

if (values.all) {
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")) : [];
  const archives = files.map((f) => readArchive(path.join(runsDir, f)));
  for (const a of archives) {
    try {
      chooseApp({ archived: archiveApp(a), known: APPS });
    } catch (err) {
      fail(`${a.run}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const groups = [...groupByApp(archives)].filter(([app]) => requestedApp === undefined || app === requestedApp);
  if (groups.length === 0) fail(`No archived ${requestedApp ? `${requestedApp} ` : ""}runs in ${path.relative(root, runsDir)}.`);
  groups.forEach(([app, runs], i) => {
    const key = loadKey(APP_KEYS[app]);
    const rows = runs.map((a) => ({ a, c: score(key, a.findings, a.decisions, level) }));
    if (i > 0) console.log("");
    console.log(`Every archived ${app} run, re-scored against key ${rows[0].c.key} (${key.app}) at ${level}:\n`);
    console.log(`| Run | Date | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Calibration |`);
    console.log(`|---|---|---:|---:|---:|---:|---:|---:|---|`);
    for (const { a, c } of rows) {
      const p = precisionBounds(c);
      const k = c.calibration;
      const cal = !k || k.judged === 0 ? "—" : `${k.correct}/${k.judged}, ECE ${k.ece.toFixed(2)}, Brier ${k.brier.toFixed(3)}`;
      console.log(
        `| ${a.run} | ${a.date} | ${c.found.length}/${c.expected} | ${p.labelled} | ${c.findings} | ${c.unknown.length + c.ambiguous.length} | ${c.falsePositives.length} | ${c.judgedNotFiled.length} | ${cal} |`,
      );
    }
  });
  process.exit(0);
}

const target = positionals[0];
if (!target || positionals.length > 1) fail(USAGE);
const archived = target.endsWith(".json") ? readArchive(target) : undefined;
const source = archived ?? { ...readMemory(target), run: path.basename(target), date: "", note: "" };
let key: AnswerKey;
if (keyFile) {
  key = loadKey(keyFile);
  if (archived) {
    try {
      checkKeyForArchive(key, archived, Object.fromEntries(APPS.map((app) => [app, loadKey(APP_KEYS[app])])));
    } catch (err) {
      fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    }
  }
} else {
  let app: string;
  try {
    // A project directory does not say which app it ran against; an archive does.
    app = chooseApp({ requested: requestedApp, archived: archived && archiveApp(archived), known: APPS });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  key = loadKey(APP_KEYS[app]);
}
const card = score(key, source.findings, source.decisions, level);
console.log(formatScorecard(card));
if (values.json) {
  fs.writeFileSync(values.json as string, JSON.stringify(card, null, 2) + "\n");
  console.log(`\nWrote ${values.json}`);
}
