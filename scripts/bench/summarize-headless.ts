/**
 * Summarise a directory of headless lane runs made by run-headless.sh: one
 * `<shape>-<effort>-<n>.json` per run, in Claude Code's `--output-format json`.
 *
 * Two tables. The first is cost: seconds, tokens, whether the planner could
 * fold the reply by machine. The second is agreement: each run's verdicts,
 * severities and categories against the majority answer across every run in
 * the directory, so a cheaper condition can be seen to pay (or not) in what
 * it decides. Typed replies are read by the lane parser; prose ones by the
 * two layouts lanes have been seen to choose, which is itself the finding,
 * and a prose run the extractor reads only partly is marked as such rather
 * than scored as if it disagreed.
 *
 * A run whose `claude` call failed (is_error, or a subtype other than
 * success) is listed and excluded: an error message is not a model reply.
 *
 *   npx tsx scripts/bench/summarize-headless.ts <runs-dir>
 */
import fs from "node:fs";
import path from "node:path";
import { type LaneDecision, parseLaneReport, summarizeLaneReport } from "../../src/engine/lane.ts";
import { benchDir, mean, printTable } from "./table.ts";

const dir = benchDir("usage: summarize-headless.ts <runs-dir>");

/** One observation's judgement, reduced to what the planner compares. */
interface Judgement {
  verdict: LaneDecision["verdict"];
  severity: string;
  category: string;
}

/** What a reply yielded: the judgements found, and how many observations the reply mentioned at all. */
interface Reading {
  judgements: Record<string, Judgement>;
  seen: number;
}

interface Run {
  name: string;
  shape: string;
  effort: string;
  seconds: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd: number;
  chars: number;
  /** null for prose: no machine fold is attempted. */
  folded: boolean | null;
  fold: string;
  reading: Reading | null;
}

interface ResultFile {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
}

function readingFromTyped(text: string): Reading | null {
  const r = parseLaneReport(text);
  if (!r.ok) return null;
  const judgements: Record<string, Judgement> = {};
  for (const d of r.report.decisions) judgements[d.observation] = { verdict: d.verdict, severity: d.severity ?? "-", category: d.category ?? "-" };
  return { judgements, seen: r.report.decisions.length };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[—–-]+$/, "")
    .trim();

/**
 * "Defect", "Likely defect" and "Possible defect" are defects; anything
 * starting "not" is not; "unsure" is unsure. A cell that is none of these is
 * not a verdict at all: a title, a route, a sentence. Two of the 18 prose
 * replies put those in the second column, so the reply is unreadable rather
 * than wrong.
 */
function verdictOf(word: string): Judgement["verdict"] | null {
  if (word.startsWith("not")) return "not_a_defect";
  if (word.includes("defect")) return "defect";
  if (word.includes("unsure")) return "unsure";
  return null;
}

/** A markdown table row, or the bold one-liner some lanes write instead. */
function readingFromProse(text: string): Reading | null {
  const judgements: Record<string, Judgement> = {};
  let rows = 0;
  for (const line of text.split("\n")) {
    const row = line.match(/^\|\s*(o\d\d)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    const bold = line.match(/^\*\*(o\d\d)\s*[—–-]+\s*([^,*]+)(?:,\s*([^,*]+),\s*([^,*]+))?/);
    const m = row ?? bold;
    if (!m) continue;
    rows++;
    const verdict = verdictOf(norm(m[2]));
    if (verdict === null) continue;
    const severity = verdict === "defect" ? norm(m[3] ?? "") || "-" : "-";
    const category = verdict === "defect" ? norm(m[4] ?? "") || "-" : "-";
    judgements[m[1]] = { verdict, severity, category };
  }
  const seen = Object.keys(judgements).length;
  // Rows found but no verdict column: a layout the extractor does not know.
  if (!seen || seen < rows / 2) return null;
  return { judgements, seen };
}

const runs: Run[] = [];
const failed: string[] = [];
for (const file of fs.readdirSync(dir).sort()) {
  if (!file.endsWith(".json")) continue;
  const m = file.match(/^([a-z][\w-]*?)-([a-z]+)-(\d+)\.json$/);
  if (!m) {
    console.error(`${file}: not named <shape>-<effort>-<n>.json, skipped`);
    continue;
  }
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  let raw: ResultFile;
  try {
    raw = JSON.parse(source) as ResultFile;
  } catch (e) {
    console.error(`${file}: not JSON (${(e as Error).message}); first bytes: ${JSON.stringify(source.slice(0, 80))}`);
    continue;
  }
  if (raw.is_error || raw.subtype !== "success" || typeof raw.duration_ms !== "number") {
    failed.push(`${file}: ${raw.subtype ?? "no subtype"}: ${(raw.result ?? "").slice(0, 120)}`);
    continue;
  }
  const text = raw.result ?? "";
  const typed = m[1] !== "prose";
  let folded: boolean | null = null;
  let fold = "needs a model pass";
  if (typed) {
    const r = parseLaneReport(text);
    folded = r.ok;
    fold = r.ok ? summarizeLaneReport(r.report) : `REFUSED: ${r.reason}`;
  }
  runs.push({
    name: `${m[1]}-${m[2]}-${m[3]}`,
    shape: m[1],
    effort: m[2],
    seconds: raw.duration_ms / 1000,
    outputTokens: raw.usage?.output_tokens ?? 0,
    thinkingTokens: raw.usage?.output_tokens_details?.thinking_tokens ?? 0,
    costUsd: raw.total_cost_usd ?? 0,
    chars: text.length,
    folded,
    fold,
    reading: typed ? readingFromTyped(text) : readingFromProse(text),
  });
}

const mode = (xs: string[]) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
};

// The majority answer per observation across every run that could be read.
type Readable = Run & { reading: Reading };
const readable = runs.filter((r): r is Readable => r.reading !== null);
const observations = [...new Set(readable.flatMap((r) => Object.keys(r.reading.judgements)))].sort();
const majority: Record<string, Judgement> = {};
for (const o of observations) {
  const js = readable.map((r) => r.reading.judgements[o]).filter(Boolean);
  majority[o] = {
    verdict: mode(js.map((j) => j.verdict)) as Judgement["verdict"],
    severity: mode(js.map((j) => j.severity)),
    category: mode(js.map((j) => j.category)),
  };
}
const majorityDefects = observations.filter((o) => majority[o].verdict === "defect").length;

interface Agreement {
  verdict: number;
  severity: number;
  category: number;
  highs: number;
  seen: number;
}

function agreement(r: Readable): Agreement {
  const a: Agreement = { verdict: 0, severity: 0, category: 0, highs: 0, seen: r.reading.seen };
  for (const o of observations) {
    const j = r.reading.judgements[o];
    if (!j) continue;
    const want = majority[o];
    if (j.verdict === want.verdict) a.verdict++;
    if (want.verdict === "defect") {
      if (j.severity === want.severity) a.severity++;
      if (j.category === want.category) a.category++;
    }
    if (j.severity === "high") a.highs++;
  }
  return a;
}

printTable(
  ["run", "seconds", "output tokens", "of which thinking", "reply chars", "cost", "planner fold"],
  runs.map((r) => [r.name, r.seconds.toFixed(1), String(r.outputTokens), String(r.thinkingTokens), String(r.chars), `$${r.costUsd.toFixed(3)}`, r.fold]),
);
if (failed.length) {
  console.log(`\nFailed runs, excluded from both tables:`);
  for (const f of failed) console.log(`  ${f}`);
}

const partial = readable.filter((r) => r.reading.seen < observations.length);
console.log(
  `\nAgreement is against the majority answer across the ${readable.length} readable runs (${observations.length} observations, ${majorityDefects} judged defects by majority). ` +
    `A verdict is one of three (defect, not a defect, unsure). ${partial.length ? `${partial.length} prose run(s) were read only partly and are marked with the count read: ${partial.map((r) => `${r.name} ${r.reading.seen}/${observations.length}`).join(", ")}.` : "Every readable run yielded every observation."}`,
);

const groups = new Map<string, Run[]>();
for (const r of runs) {
  const key = `${r.shape} @ ${r.effort}`;
  const list = groups.get(key);
  if (list) list.push(r);
  else groups.set(key, [r]);
}
printTable(
  [
    "condition",
    "runs",
    "readable",
    "mean seconds",
    "mean output tokens",
    "mean thinking",
    "verdict agrees",
    "severity agrees",
    "category agrees",
    "mean highs",
    "parsed first time",
  ],
  [...groups].map(([key, rs]) => {
    const scored = rs.filter((r): r is Readable => r.reading !== null).map(agreement);
    const parsed = rs[0].shape === "prose" ? "needs a model pass" : `${rs.filter((r) => r.folded).length}/${rs.length}`;
    return [
      key,
      String(rs.length),
      String(scored.length),
      mean(rs.map((r) => r.seconds)).toFixed(1),
      mean(rs.map((r) => r.outputTokens)).toFixed(0),
      mean(rs.map((r) => r.thinkingTokens)).toFixed(0),
      `${mean(scored.map((a) => a.verdict)).toFixed(1)}/${observations.length}`,
      `${mean(scored.map((a) => a.severity)).toFixed(1)}/${majorityDefects}`,
      `${mean(scored.map((a) => a.category)).toFixed(1)}/${majorityDefects}`,
      mean(scored.map((a) => a.highs)).toFixed(1),
      parsed,
    ];
  }),
);
