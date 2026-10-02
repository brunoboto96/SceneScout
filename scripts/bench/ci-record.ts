/**
 * The command behind the weekly benchmark workflow (.github/workflows/bench-weekly.yml).
 *
 *   npm run bench:ci -- decide --latest <version> --provider <openai|anthropic> --open-prs <n> --release-has-ci <true|false> [--force]
 *   npm run bench:ci -- record --app <demo|holdout> --project <dir> --card <scorecard.json> --source <manual|scheduled|dispatched> --commit <sha> --archive <name> [--date YYYY-MM-DD]
 *   npm run bench:ci -- render
 *
 * `decide` says whether a release has come out since the newest version this
 * provider was benchmarked on, as `run=true|false` in $GITHUB_OUTPUT and a line
 * in $GITHUB_STEP_SUMMARY. `record` appends one row, built from the run's
 * ci.json and the scorecard `npm run bench -- <dir> --app <app> --json` wrote,
 * to bench/ci-results.json, and regenerates the table in docs/benchmark.md.
 * `render` regenerates only the table. The logic is in ci-results.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appendRows, decideRun, parseResults, parseRunSummary, renderTable, replaceTable, resultRow, type CiResults } from "./ci-results.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS = path.join(root, "bench", "ci-results.json");
const DOC = path.join(root, "docs", "benchmark.md");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const readResults = (): CiResults => (fs.existsSync(RESULTS) ? parseResults(readJson(RESULTS)) : { rows: [] });

function writeTable(results: CiResults): void {
  fs.writeFileSync(DOC, replaceTable(fs.readFileSync(DOC, "utf8"), renderTable(results.rows)));
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  strict: true,
  options: {
    latest: { type: "string" },
    provider: { type: "string" },
    force: { type: "boolean", default: false },
    "open-prs": { type: "string" },
    "release-has-ci": { type: "string" },
    app: { type: "string" },
    project: { type: "string" },
    card: { type: "string" },
    source: { type: "string" },
    commit: { type: "string" },
    archive: { type: "string" },
    date: { type: "string" },
  },
});

try {
  if (command === "decide") {
    const openPrs = values["open-prs"];
    const hasCi = values["release-has-ci"];
    if (!values.latest || !values.provider || openPrs === undefined || !/^\d+$/.test(openPrs) || (hasCi !== "true" && hasCi !== "false"))
      fail("decide needs --latest, --provider, --open-prs <whole number> and --release-has-ci true|false.");
    const d = decideRun({
      latest: values.latest,
      provider: values.provider,
      force: values.force === true,
      openResultsPrs: Number(openPrs),
      releaseHasCi: hasCi === "true",
      rows: readResults().rows,
    });
    console.log(`run=${d.run}\n${d.reason}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${d.run}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Weekly benchmark\n\n${d.reason}\n`);
  } else if (command === "record") {
    const { app, project, card, source, commit, archive } = values;
    if (!app || !project || !card || !source || !commit || !archive) fail("record needs --app, --project, --card, --source, --commit and --archive.");
    const row = resultRow({
      app,
      source,
      commit,
      archive,
      date: values.date ?? new Date().toISOString().slice(0, 10),
      run: parseRunSummary(readJson(path.join(project, ".scenescout", "ci", "ci.json"))),
      card: readJson(card) as never,
    });
    const results = appendRows(readResults(), [row]);
    fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
    writeTable(results);
    console.log(`Recorded ${row.app} v${row.version} (${row.provider} ${row.model} ${row.effort}, dedup ${row.dedup}) as ${row.archive}.`);
  } else if (command === "render") {
    writeTable(readResults());
  } else {
    fail("Usage: npm run bench:ci -- decide|record|render … (see scripts/bench/ci-record.ts)");
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
