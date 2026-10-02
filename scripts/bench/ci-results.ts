/**
 * The record of unattended benchmark runs (`scenescout ci` against the demo and
 * held-out apps): whether the weekly workflow should run at all, one result row
 * per app built from what the run wrote and how it scored, appending it to
 * bench/ci-results.json, and the table docs/benchmark.md shows. All pure, so
 * ci-test table-tests it; scripts/bench/ci-record.ts is the command the
 * workflow calls.
 */
import { precisionBounds, type Scorecard } from "../../src/engine/bench.ts";
import { DEDUP_MODES, type DedupMode } from "../../src/engine/ci.ts";

export const CI_RESULT_APPS = ["demo", "holdout"] as const;
export type CiResultApp = (typeof CI_RESULT_APPS)[number];

/** How a run was started: by hand before the workflow existed, by the weekly schedule, or dispatched. */
export const CI_RESULT_SOURCES = ["manual", "scheduled", "dispatched"] as const;
export type CiResultSource = (typeof CI_RESULT_SOURCES)[number];

export interface CiResultRow {
  /** YYYY-MM-DD, UTC. */
  date: string;
  app: CiResultApp;
  /** The SceneScout version that ran, as the run itself reported it. */
  version: string;
  /** The commit that ran, abbreviated. */
  commit: string;
  source: CiResultSource;
  provider: string;
  model: string;
  effort: string;
  /**
   * Present when the run asked for two or more lanes (--lanes): how many it
   * asked for, how many the split made (fewer when the app had fewer modules),
   * how many attached and ran, and oneLoop when it had nothing to split and
   * explored in one loop.
   */
  lanes?: { asked: number; planned: number; ran: number; oneLoop?: true };
  /**
   * How the run deduplicated findings: by the rule alone, or with the model
   * judge as well (`scenescout ci --dedup`). Rows that differ in it are two
   * configurations, never one: the judge merges what the rule keeps apart, so
   * it moves the finding counts and with them recall and precision.
   */
  dedup: DedupMode;
  /** The answer key's hash: rows scored against different keys are not comparable. */
  key: string;
  recall: { found: number; expected: number };
  /** correct/labelled is the labelled precision; low and high are its bounds, as bench's precisionBounds prints them. */
  precision: { correct: number; labelled: number; low: string; high: string };
  /** Lane calibration's Brier score, null when the run judged no lane verdicts. */
  brier: number | null;
  /** What ended the run: done, turns, tokens, time, provider-error. */
  stop: string;
  turns: number;
  tokens: { input: number; cachedInput: number; output: number };
  seconds: number;
  /** Estimated US dollars, null when the model's price is not known. */
  costUsd: number | null;
  /** The bench/runs/ archive the run was kept as, so it can be re-scored when the key changes. Unique per row. */
  archive: string;
}

export interface CiResults {
  rows: CiResultRow[];
}

// ── versions and the decision to run ────────────────────────────────────────

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Negative when a is older than b. Throws on anything that is not a plain X.Y.Z release version. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a.trim());
  const pb = VERSION.exec(b.trim());
  if (!pa) throw new Error(`Not a version: ${JSON.stringify(a)}`);
  if (!pb) throw new Error(`Not a version: ${JSON.stringify(b)}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The newest scheduled row for this provider, or null when there is none.
 * Only scheduled rows count: a dispatched run may have used another model or
 * effort, and a manual run may have been of a commit no release contains, so
 * neither says the scheduled default run of that release has been made.
 */
export function lastBenchmarked(rows: readonly CiResultRow[], provider: string): CiResultRow | null {
  let best: CiResultRow | null = null;
  for (const r of rows) if (r.source === "scheduled" && r.provider === provider && (best === null || compareVersions(r.version, best.version) > 0)) best = r;
  return best;
}

export interface RunDecision {
  run: boolean;
  /** One sentence for the job summary. */
  reason: string;
}

/**
 * Whether the weekly benchmark runs: only when a SceneScout version has been
 * released since the newest version the schedule benchmarked with this
 * provider, and no results pull request is still open. Forcing overrides both,
 * but nothing runs a release whose tag has no `scenescout ci` to run: that run
 * could only fail. Each provider keeps its own record.
 */
export function decideRun(opts: {
  latest: string;
  rows: readonly CiResultRow[];
  provider: string;
  force: boolean;
  /** Open pull requests labelled benchmark: results not merged yet, so main's record is behind. */
  openResultsPrs: number;
  /** Whether the release's tag holds the ci action (ci/action.yml). */
  releaseHasCi: boolean;
}): RunDecision {
  const latest = opts.latest.trim().replace(/^v/, "");
  compareVersions(latest, latest); // fail fast on a release that is not a version
  if (!Number.isInteger(opts.openResultsPrs) || opts.openResultsPrs < 0) throw new Error(`openResultsPrs must be a whole number, not ${opts.openResultsPrs}`);
  if (!opts.releaseHasCi) return { run: false, reason: `v${latest} predates scenescout ci: its tag has no ci action to run. Nothing to run.` };
  if (opts.force) return { run: true, reason: `Forced: benchmarking v${latest} with ${opts.provider} whatever was benchmarked before.` };
  if (opts.openResultsPrs > 0)
    return {
      run: false,
      reason: `${opts.openResultsPrs} results pull request(s) labelled benchmark are still open: merge or close them first, so the same release is not paid for twice. Nothing to run.`,
    };
  const last = lastBenchmarked(opts.rows, opts.provider);
  if (last === null) return { run: true, reason: `Nothing benchmarked on schedule with ${opts.provider} yet: benchmarking v${latest}.` };
  const d = compareVersions(latest, last.version);
  if (d > 0) return { run: true, reason: `v${latest} was released since v${last.version} was benchmarked with ${opts.provider} on ${last.date}.` };
  return {
    run: false,
    reason: `No SceneScout release since v${last.version}, benchmarked with ${opts.provider} on ${last.date} (latest release: v${latest}). Nothing to run.`,
  };
}

// ── building a row ──────────────────────────────────────────────────────────

/** The fields of the run's ci.json a row reads. */
export interface CiRunSummary {
  version: string;
  provider: string;
  model: string;
  effort: string;
  /** The lanes it asked for, planned and ran, when it asked for two or more. */
  lanes?: { asked: number; planned: number; ran: number; oneLoop?: true };
  dedup: DedupMode;
  stop: { reason: string };
  usage: { turns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; seconds: number; estimatedCostUsd?: number | null };
}

/**
 * The dedup mode a run's ci.json records. A ci.json with none was written by
 * a version from before the model judge, which deduplicated by the rule alone;
 * any value other than a known mode is refused rather than read as one.
 */
function dedupOf(v: Record<string, unknown>): DedupMode {
  if (v.dedup === undefined) return "rule";
  const by = isObj(v.dedup) ? v.dedup.by : undefined;
  if (typeof by !== "string" || !(DEDUP_MODES as readonly string[]).includes(by))
    throw new Error(`dedup.by must be one of ${DEDUP_MODES.join(", ")}, not ${JSON.stringify(by)}`);
  return by as DedupMode;
}

type CardFields = Pick<Scorecard, "key" | "expected" | "found" | "correct" | "falsePositives" | "unknown" | "ambiguous" | "findings" | "contextual"> &
  Partial<Pick<Scorecard, "worthALook">> & { calibration?: { brier: number; judged: number } | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${what} must be a whole number, not ${JSON.stringify(v)}`);
  return v;
};
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${what} must be a non-empty string, not ${JSON.stringify(v)}`);
  return v;
};

/** Reads the fields a row needs from a run's ci.json, and refuses one that lacks any of them. */
export function parseRunSummary(v: unknown): CiRunSummary {
  if (!isObj(v) || !isObj(v.usage) || !isObj(v.stop)) throw new Error("ci.json has no usage or stop: is it the ci.json a scenescout ci run wrote?");
  const u = v.usage;
  const cost = u.estimatedCostUsd;
  if (cost !== undefined && cost !== null && (typeof cost !== "number" || !(cost >= 0))) throw new Error(`usage.estimatedCostUsd is ${JSON.stringify(cost)}`);
  if (v.lanes !== undefined && !isObj(v.lanes)) throw new Error(`lanes is ${JSON.stringify(v.lanes)}, not an object`);
  const lanes = isObj(v.lanes)
    ? {
        asked: count(v.lanes.asked, "lanes.asked"),
        planned: count(v.lanes.planned, "lanes.planned"),
        ran: count(v.lanes.ran, "lanes.ran"),
        ...(typeof v.lanes.oneLoop === "string" ? { oneLoop: true as const } : {}),
      }
    : undefined;
  return {
    version: text(v.version, "version"),
    provider: text(v.provider, "provider"),
    model: text(v.model, "model"),
    effort: text(v.effort, "effort"),
    ...(lanes && lanes.asked > 1 ? { lanes } : {}),
    dedup: dedupOf(v),
    stop: { reason: text(v.stop.reason, "stop.reason") },
    usage: {
      turns: count(u.turns, "usage.turns"),
      inputTokens: count(u.inputTokens, "usage.inputTokens"),
      cachedInputTokens: count(u.cachedInputTokens, "usage.cachedInputTokens"),
      outputTokens: count(u.outputTokens, "usage.outputTokens"),
      seconds: count(u.seconds, "usage.seconds"),
      estimatedCostUsd: cost ?? null,
    },
  };
}

/** One result row: what the run reported about itself, and how the key scored it. */
export function resultRow(opts: {
  app: string;
  source: string;
  date: string;
  commit: string;
  archive: string;
  run: CiRunSummary;
  card: CardFields;
}): CiResultRow {
  const { run, card } = opts;
  if (!(CI_RESULT_APPS as readonly string[]).includes(opts.app))
    throw new Error(`app must be one of ${CI_RESULT_APPS.join(", ")}, not ${JSON.stringify(opts.app)}`);
  if (!(CI_RESULT_SOURCES as readonly string[]).includes(opts.source))
    throw new Error(`source must be one of ${CI_RESULT_SOURCES.join(", ")}, not ${JSON.stringify(opts.source)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error(`date must be YYYY-MM-DD, not ${JSON.stringify(opts.date)}`);
  if (!/^[0-9a-f]{7,40}$/.test(opts.commit)) throw new Error(`commit must be a commit hash, not ${JSON.stringify(opts.commit)}`);
  if (!/^[a-z0-9-]+$/.test(opts.archive))
    throw new Error(`archive must be a run name of lower-case letters, digits and hyphens, not ${JSON.stringify(opts.archive)}`);
  compareVersions(run.version, run.version);
  const labelled = card.correct + card.falsePositives.length;
  const { low, high } = precisionBounds(card);
  const k = card.calibration;
  return {
    date: opts.date,
    app: opts.app as CiResultApp,
    version: run.version,
    commit: opts.commit.slice(0, 7),
    source: opts.source as CiResultSource,
    provider: run.provider,
    model: run.model,
    effort: run.effort,
    ...(run.lanes ? { lanes: run.lanes } : {}),
    dedup: run.dedup,
    key: text(card.key, "the scorecard's key"),
    recall: { found: card.found.length, expected: count(card.expected, "expected") },
    precision: { correct: count(card.correct, "correct"), labelled, low, high },
    brier: k && k.judged > 0 ? k.brier : null,
    stop: run.stop.reason,
    turns: run.usage.turns,
    tokens: { input: run.usage.inputTokens, cachedInput: run.usage.cachedInputTokens, output: run.usage.outputTokens },
    seconds: run.usage.seconds,
    costUsd: run.usage.estimatedCostUsd ?? null,
    archive: opts.archive,
  };
}

// ── the results file ────────────────────────────────────────────────────────

/** Reads bench/ci-results.json. Throws on a file whose rows are not rows, rather than appending to it. */
export function parseResults(v: unknown): CiResults {
  if (!isObj(v) || !Array.isArray(v.rows)) throw new Error("the results file must be an object with a rows array");
  for (const [i, r] of v.rows.entries()) {
    if (!isObj(r) || typeof r.archive !== "string" || typeof r.version !== "string" || typeof r.provider !== "string" || typeof r.date !== "string")
      throw new Error(`row ${i} is not a result row`);
    // Every row says how it deduplicated: a row without it could be compared with one of the other mode.
    if (typeof r.dedup !== "string" || !(DEDUP_MODES as readonly string[]).includes(r.dedup))
      throw new Error(`row ${i} (${r.archive}) has dedup ${JSON.stringify(r.dedup)}, not one of ${DEDUP_MODES.join(", ")}`);
    compareVersions(r.version, r.version);
  }
  return v as unknown as CiResults;
}

/**
 * The file with these rows appended, in the order given. Existing rows are
 * kept as they are: a result is evidence, so a row naming an archive already
 * recorded is refused rather than replaced.
 */
export function appendRows(results: CiResults, rows: readonly CiResultRow[]): CiResults {
  const seen = new Set(results.rows.map((r) => r.archive));
  for (const r of rows) {
    if (seen.has(r.archive)) throw new Error(`${r.archive} is already recorded. Results are evidence; record a new run under a new name.`);
    seen.add(r.archive);
  }
  return { rows: [...results.rows, ...rows] };
}

// ── the table in docs/benchmark.md ──────────────────────────────────────────

export const TABLE_START = "<!-- ci-results:start (generated from bench/ci-results.json by scripts/bench/ci-record.ts; do not edit by hand) -->";
export const TABLE_END = "<!-- ci-results:end -->";

const thousands = (n: number) => n.toLocaleString("en-US");
/** A run that asked for lanes says so beside its model, so its row is never read as a single loop's. */
const lanesNote = (l: CiResultRow["lanes"]): string =>
  !l
    ? ""
    : l.oneLoop
      ? ` · ${l.asked} lanes asked, one loop ran`
      : l.ran === 0
        ? ` · ${l.asked} lanes asked, none ran`
        : ` · ${l.ran} lanes` + (l.planned < l.asked ? ` of ${l.asked} asked` : "") + (l.ran < l.planned ? `, ${l.planned - l.ran} could not attach` : "");
const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

/** The table's columns, and which are figures, set right-aligned. */
const COLUMNS: ReadonlyArray<{ head: string; figure?: true }> = [
  { head: "Date" },
  { head: "App" },
  { head: "Version" },
  { head: "Source" },
  { head: "Provider · model · effort" },
  { head: "Dedup" },
  { head: "Key" },
  { head: "Recall", figure: true },
  { head: "Precision (bounds)", figure: true },
  { head: "Brier", figure: true },
  { head: "Ended" },
  { head: "Turns", figure: true },
  { head: "Tokens in (cached) / out", figure: true },
  { head: "Wall", figure: true },
  { head: "Cost", figure: true },
];

export function renderTable(rows: readonly CiResultRow[]): string {
  const lines = [`| ${COLUMNS.map((c) => c.head).join(" | ")} |`, `|${COLUMNS.map((c) => (c.figure ? "---:" : "---")).join("|")}|`];
  for (const r of rows) {
    const p = r.precision;
    const bounds = p.low === p.high ? p.low : `${p.low}–${p.high}`;
    lines.push(
      `| ${[
        r.date,
        r.app,
        r.version,
        r.source,
        `${r.provider} · ${r.model} · ${r.effort}${lanesNote(r.lanes)}`,
        r.dedup,
        r.key,
        `${r.recall.found}/${r.recall.expected}`,
        `${r.precision.correct}/${r.precision.labelled} (${bounds})`,
        r.brier === null ? "—" : r.brier.toFixed(3),
        r.stop,
        String(r.turns),
        `${thousands(r.tokens.input)} (${thousands(r.tokens.cachedInput)}) / ${thousands(r.tokens.output)}`,
        duration(r.seconds),
        r.costUsd === null ? "—" : `$${r.costUsd.toFixed(3)}`,
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

/**
 * The document with the generated table between its markers replaced, in the
 * document's own line endings: a checkout with CRLF endings (git on Windows)
 * compares equal to the same text with LF. Throws when the markers are missing
 * or out of order.
 */
export function replaceTable(original: string, table: string): string {
  const crlf = original.includes("\r\n");
  const doc = original.replace(/\r\n/g, "\n");
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < 0 || end < start || doc.indexOf(TABLE_START, start + 1) >= 0 || doc.indexOf(TABLE_END, end + 1) >= 0)
    throw new Error("docs/benchmark.md must hold the ci-results start and end markers exactly once each, in that order");
  const out = `${doc.slice(0, start + TABLE_START.length)}\n\n${table.replace(/\r\n/g, "\n")}\n\n${doc.slice(end)}`;
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}
