/**
 * Score a local classifier, GLiNER2.5-Decide, as the duplicate-finding judge,
 * on the same labelled pairs `npm run dedup-bench` scores the rule and the
 * model judge on. Opt-in and dev-only: it needs @huggingface/transformers,
 * which is not a dependency of this package, and downloads the model.
 *
 *   npm install --no-save @huggingface/transformers
 *   npm run dedup-bench:gliner -- --cache <dir> [--app demo|holdout|both] [--phrasing all|yes-no|described|duplicate]
 *       [--dtype q4f16|q4|fp16|fp32] [--against <pairs.jsonl> --archives-at <commit>] [--cap 200] [--threads 4] [--pairs <file>]
 *
 * Each pair is one classification: the text holds both findings' title,
 * category and evidence (scripts/bench/gliner.ts), and p_same is the softmax
 * probability of the label meaning "same defect", so Brier and ECE apply.
 * Phrasings are chosen between on the demo pairs only: `--phrasing all` is
 * refused with the held-out app, which takes one phrasing named up front.
 *
 * `--against` scores exactly the pairs in a dedup-bench per-pair file (the
 * model judge's, bench/dedup/judge-run-2-effort-none.jsonl) and compares the
 * classifier with that judge and the rule pair by pair. `--archives-at` builds
 * the pairs from the archives as they stood at that judge's run (2118755 for
 * that file), since an archive added later changes the pairs. Without it the sample
 * is dedup-bench's own (`--cap`, split between the apps).
 *
 * Before scoring, the layout is checked against the model's published
 * reference (the Python gliner2 library's token ids and probabilities for six
 * texts): the token ids must match exactly, and the probabilities are reported.
 *
 * The model is pinned to one revision and downloaded into `--cache`, never
 * the shared Hugging Face cache. ONNX runs on the CPU with `--threads`
 * intra-op threads (default 4). Ids only in `--pairs`: no finding text.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseKey, type AnswerKey, type RunArchive } from "../src/engine/bench.ts";
import {
  buildPairs,
  formatPairScore,
  pairId,
  ruleJudgement,
  sampleByApp,
  scorePairs,
  type Judgement,
  type LabelledPair,
  type PairScore,
} from "../src/engine/dedup.ts";
import {
  bootstrap,
  encodeLayout,
  judgementOf,
  layoutPieces,
  pairCluster,
  pairWords,
  percentile,
  PHRASINGS,
  phrasingNamed,
  softmax,
  textWords,
  type Phrasing,
  type Question,
} from "./bench/gliner.ts";

const MODEL = "onnx-community/GLiNER2.5-Decide-ONNX";
/** The revision measured; a newer export is a different model to measure. */
const REVISION = "2a9b872b5c70ae1105107975a0952a57e0fbba25";
/** The encoder's trained context, in tokens. */
const MAX_TOKENS = 512;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS: Record<string, string> = {
  demo: path.join(root, "demo-app", "answer-key.json"),
  holdout: path.join(root, "holdout-app", "answer-key.json"),
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  strict: true,
  options: {
    app: { type: "string", default: "demo" },
    phrasing: { type: "string", default: "all" },
    dtype: { type: "string", default: "q4f16" },
    against: { type: "string" },
    cap: { type: "string", default: "200" },
    cache: { type: "string" },
    threads: { type: "string", default: "4" },
    resamples: { type: "string", default: "2000" },
    pairs: { type: "string" },
    "archives-at": { type: "string" },
  },
});

const apps = values.app === "both" ? ["demo", "holdout"] : [values.app];
if (!apps.every((a) => a in KEYS)) fail(`--app must be demo, holdout or both, not ${values.app}.`);
const phrasings: Phrasing[] =
  values.phrasing === "all"
    ? [...PHRASINGS]
    : [phrasingNamed(values.phrasing) ?? fail(`--phrasing must be all or one of ${PHRASINGS.map((p) => p.name).join(", ")}.`)];
if (apps.includes("holdout") && phrasings.length > 1)
  fail("Phrasings are chosen on the demo pairs only: name the one chosen with --phrasing to score the held-out pairs.");
if (!["q4f16", "q4", "fp16", "fp32"].includes(values.dtype)) fail(`--dtype must be q4f16, q4, fp16 or fp32, not ${values.dtype}.`);
const cap = Number(values.cap);
if (!Number.isInteger(cap) || cap < 1 || cap > 200) fail("--cap must be a whole number from 1 to 200.");
const threads = Number(values.threads);
if (!Number.isInteger(threads) || threads < 1 || threads > 16) fail("--threads must be a whole number from 1 to 16.");
const resamples = Number(values.resamples);
if (!Number.isInteger(resamples) || resamples < 100 || resamples > 20000) fail("--resamples must be a whole number from 100 to 20000.");
if (!values.cache) fail("--cache <dir> is required: the model is downloaded there (0.5 to 1.7 GB), not into the shared Hugging Face cache.");
const cacheDir = path.resolve(values.cache);

// ── the pairs ───────────────────────────────────────────────────────────────

const keys: Record<string, AnswerKey> = Object.fromEntries(
  Object.entries(KEYS).map(([app, file]) => [app, parseKey(JSON.parse(fs.readFileSync(file, "utf8")))]),
);
// The archives as they stood at a commit, when given: an archive added since
// changes which run a repeated finding is first seen in, and so the pairs'
// ids, and a recorded judge's pairs can then no longer be found.
const runsDir = path.join(root, "bench", "runs");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
const archiveNames = values["archives-at"]
  ? git("ls-tree", "--name-only", values["archives-at"], "bench/runs/")
      .split("\n")
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.basename(f))
  : fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
const archives: RunArchive[] = archiveNames
  .sort()
  .map(
    (f) =>
      JSON.parse(
        values["archives-at"] ? git("show", `${values["archives-at"]}:bench/runs/${f}`) : fs.readFileSync(path.join(runsDir, f), "utf8"),
      ) as RunArchive,
  );
const set = buildPairs(archives, keys);

interface JudgeLine {
  app: string;
  pair: string;
  keyA: string;
  keyB: string;
  key: "same" | "different";
  judge: "same" | "different" | "unsure" | null;
  pSame: number | null;
}
const judgeLines = new Map<string, JudgeLine>();
let samples: Map<string, LabelledPair[]>;
if (values.against) {
  const lines = fs
    .readFileSync(values.against, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JudgeLine & { effort: string });
  const efforts = new Set(lines.map((l) => l.effort));
  if (efforts.size !== 1) fail(`${values.against} holds ${efforts.size} efforts; give it the lines of one.`);
  for (const l of lines) judgeLines.set(l.pair, l);
  samples = new Map();
  for (const p of set.pairs) {
    const l = judgeLines.get(pairId(p));
    if (!l) continue;
    if (l.app !== p.app || (l.key === "same") !== p.same)
      fail(`Pair ${pairId(p)} has another app or label here than in ${values.against}: the keys have changed since that run.`);
    samples.set(p.app, [...(samples.get(p.app) ?? []), p]);
  }
  const found = [...samples.values()].reduce((s, ps) => s + ps.length, 0);
  if (found !== judgeLines.size)
    fail(
      `${judgeLines.size - found} of the ${judgeLines.size} pairs in ${values.against} are not among the pairs these archives give: build them from the archives of that run with --archives-at <commit>.`,
    );
} else samples = sampleByApp(set.pairs, cap);

// ── the model ───────────────────────────────────────────────────────────────

type Transformers = typeof import("@huggingface/transformers");
let hf: Transformers;
try {
  hf = await import("@huggingface/transformers");
} catch (err) {
  const missing = (err as { code?: string }).code === "ERR_MODULE_NOT_FOUND";
  fail(
    missing
      ? "This benchmark needs @huggingface/transformers, which is not a dependency of SceneScout. Install it for this checkout only with: npm install --no-save @huggingface/transformers"
      : `@huggingface/transformers did not load: ${err instanceof Error ? err.message : String(err)}`,
  );
}
hf.env.cacheDir = cacheDir;
hf.env.allowLocalModels = false;

const rssMb = () => process.memoryUsage().rss / 2 ** 20;
const rssBefore = rssMb();
const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL, { revision: REVISION });
const pieceIds = new Map<string, number[]>();
const tokenize = (piece: string): number[] => {
  let ids = pieceIds.get(piece);
  if (!ids) {
    ids = Array.from(tokenizer(piece, { add_special_tokens: false }).input_ids.data as BigInt64Array, Number);
    pieceIds.set(piece, ids);
  }
  return ids;
};

const loadStart = performance.now();
const model = await hf.AutoModel.from_pretrained(MODEL, {
  revision: REVISION,
  dtype: values.dtype as "q4f16",
  device: "cpu",
  session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
});
const loadMs = performance.now() - loadStart;

/** One forward pass: the probabilities of each question's labels. */
async function classify(questions: readonly Question[], words: readonly string[]): Promise<{ probs: number[][]; tokens: number }> {
  const { ids, markerPositions } = encodeLayout(layoutPieces(questions, words), tokenize);
  if (ids.length > MAX_TOKENS) throw new Error(`${ids.length} tokens, over the encoder's ${MAX_TOKENS}.`);
  const flat = markerPositions.flat();
  const tensor = (xs: readonly number[]) => new hf.Tensor("int64", BigInt64Array.from(xs, BigInt), [1, xs.length]);
  const out = (await model({ input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), marker_positions: tensor(flat) })) as {
    logits: { data: ArrayLike<number> };
  };
  const logits = Array.from(out.logits.data as Float32Array, Number);
  let at = 0;
  const probs = markerPositions.map((g) => softmax(logits.slice(at, (at += g.length))));
  return { probs, tokens: ids.length };
}

// ── parity with the Python library's published reference ───────────────────

interface ReferenceCase {
  text: string;
  questions: Array<[string, string[], Record<string, string> | null]>;
  input_ids: number[];
  marker_positions: number[];
  probabilities: number[][];
}
const refRes = await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/conversion/reference.json`, { signal: AbortSignal.timeout(30_000) });
if (!refRes.ok) fail(`Could not fetch the model's reference outputs: HTTP ${refRes.status}.`);
const reference = (await refRes.json()) as ReferenceCase[];
let worstDp = 0;
let argmaxAgree = 0;
let questionsChecked = 0;
for (const c of reference) {
  const qs: Question[] = c.questions.map(([task, labels, descriptions]) => ({ task, labels, descriptions: descriptions ?? undefined }));
  const words = textWords(c.text);
  const { ids, markerPositions } = encodeLayout(layoutPieces(qs, words), tokenize);
  if (ids.join(",") !== c.input_ids.join(",") || markerPositions.flat().join(",") !== c.marker_positions.join(",")) {
    fail(
      `The layout differs from the Python library's on "${c.text.slice(0, 40)}…": token ids or marker positions do not match, so no figure from this layout would be the model's.`,
    );
  }
  const { probs } = await classify(qs, words);
  probs.forEach((ps, i) => {
    const py = c.probabilities[i];
    worstDp = Math.max(worstDp, ...ps.map((p, k) => Math.abs(p - py[k])));
    argmaxAgree += ps.indexOf(Math.max(...ps)) === py.indexOf(Math.max(...py)) ? 1 : 0;
    questionsChecked += 1;
  });
}
console.log(
  `Model ${MODEL}@${REVISION.slice(0, 10)} ${values.dtype}, ${threads} threads, loaded in ${(loadMs / 1000).toFixed(1)}s.\n` +
    `Parity with the Python gliner2 reference: token ids identical on ${reference.length} texts; same top label on ${argmaxAgree}/${questionsChecked} questions, worst probability difference ${worstDp.toExponential(1)}.`,
);

// ── scoring ─────────────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f3 = (x: number) => x.toFixed(3);
const interval = (r: { lo: number; hi: number } | null, show: (x: number) => string) => (r ? `${show(r.lo)}–${show(r.hi)}` : "n/a");

/** Accuracy, Brier and ECE with pair-level and cluster-level 95% bootstrap intervals. */
function withIntervals(labels: readonly boolean[], judgements: ReadonlyArray<Judgement | null>, clusters: readonly string[]): string {
  const at = (idx: readonly number[]): PairScore =>
    scorePairs(
      idx.map((i) => labels[i]),
      idx.map((i) => judgements[i]),
    );
  const parts: string[] = [];
  for (const [name, pick, show] of [
    ["accuracy", (s: PairScore) => s.accuracy, pct],
    ["Brier", (s: PairScore) => s.brier, f3],
    ["ECE", (s: PairScore) => s.ece, f3],
  ] as const) {
    const pairLevel = bootstrap(labels.length, (idx) => pick(at(idx)), { resamples });
    const clusterLevel = bootstrap(labels.length, (idx) => pick(at(idx)), { resamples, clusters });
    parts.push(`${name} pairs ${interval(pairLevel, show)}, clusters ${interval(clusterLevel, show)}`);
  }
  return `95% intervals (${new Set(clusters).size} clusters): ${parts.join("; ")}`;
}

/** The classifier's Brier minus another decider's, over the same resamples: below zero, the classifier is better. */
function brierGap(
  labels: readonly boolean[],
  mine: ReadonlyArray<Judgement | null>,
  theirs: ReadonlyArray<Judgement | null>,
  clusters: readonly string[],
): string {
  const brierOf = (js: ReadonlyArray<Judgement | null>, idx: readonly number[]) =>
    scorePairs(
      idx.map((i) => labels[i]),
      idx.map((i) => js[i]),
    ).brier;
  const gap = (idx: readonly number[]) => {
    const a = brierOf(mine, idx);
    const b = brierOf(theirs, idx);
    return a === null || b === null ? null : a - b;
  };
  const all = labels.map((_, i) => i);
  return `${f3(gap(all)!)} (clusters 95% ${interval(bootstrap(labels.length, gap, { resamples, clusters }), f3)})`;
}

const pairLines: string[] = [];
const latencies: number[] = [];
let overlong = 0;
let wordsCut = 0;
const schemaTokens = (q: Question) => encodeLayout(layoutPieces([q], []), tokenize).ids.length;
const wordTokens = (w: string) => tokenize(w).length;

// One untimed call first, so the timings are of a warm session.
await classify([PHRASINGS[0].question], textWords("Warm-up."));

for (const phrasing of phrasings) {
  const budget = MAX_TOKENS - schemaTokens(phrasing.question);
  const sameAt = phrasing.question.labels.indexOf(phrasing.sameLabel);
  for (const app of apps) {
    const sample = samples.get(app) ?? [];
    if (sample.length === 0) {
      console.log(`\n[${app}] no pairs.`);
      continue;
    }
    const mine: Judgement[] = [];
    for (const p of sample) {
      const { words, cut } = pairWords(p, wordTokens, budget);
      if (cut > 0) {
        overlong += 1;
        wordsCut += cut;
      }
      const t0 = performance.now();
      const { probs } = await classify([phrasing.question], words);
      latencies.push(performance.now() - t0);
      const pSame = probs[0][sameAt];
      mine.push(judgementOf(pSame));
      const judge = judgeLines.get(pairId(p));
      pairLines.push(
        JSON.stringify({
          app,
          phrasing: phrasing.name,
          dtype: values.dtype,
          pair: pairId(p),
          keyA: p.a.keyId,
          keyB: p.b.keyId,
          key: p.same ? "same" : "different",
          pSame: Number(pSame.toFixed(4)),
          rule: ruleJudgement(p).verdict,
          judge: judge?.judge ?? null,
        }),
      );
    }
    const labels = sample.map((p) => p.same);
    const clusters = sample.map((p) => pairCluster(p.a.keyId, p.b.keyId));
    const rule = sample.map((p) => ruleJudgement(p));
    console.log(`\n[${app}] ${sample.length} pairs, ${labels.filter(Boolean).length} same; phrasing "${phrasing.name}"`);
    console.log(`  ${formatPairScore("rule", scorePairs(labels, rule))}`);
    console.log(`  ${formatPairScore(`gliner ${values.dtype}`, scorePairs(labels, mine))}`);
    console.log(`    ${withIntervals(labels, mine, clusters)}`);
    console.log(`    Brier minus the rule's: ${brierGap(labels, mine, rule, clusters)}`);
    if (judgeLines.size) {
      const judge = sample.map((p): Judgement | null => {
        const l = judgeLines.get(pairId(p))!;
        return l.judge === null || l.pSame === null ? null : { verdict: l.judge, pSame: l.pSame };
      });
      // The gap and the pair-by-pair counts compare the two on the same pairs;
      // a recorded judge that left some unanswered would make them unequal.
      const unanswered = judge.filter((j) => j === null || j.verdict === "unsure").length;
      if (unanswered) fail(`The recorded judge left ${unanswered} of the ${app} pairs failed or unsure: no comparison on unequal sets of pairs.`);
      console.log(`  ${formatPairScore("model judge (recorded)", scorePairs(labels, judge))}`);
      console.log(`    ${withIntervals(labels, judge, clusters)}`);
      console.log(`    gliner's Brier minus the judge's: ${brierGap(labels, mine, judge, clusters)}`);
      let winsOverJudge = 0;
      let lossesToJudge = 0;
      sample.forEach((p, i) => {
        const j = judge[i];
        if (!j || j.verdict === "unsure") return;
        const meRight = (mine[i].verdict === "same") === p.same;
        const judgeRight = (j.verdict === "same") === p.same;
        if (meRight && !judgeRight) winsOverJudge += 1;
        if (!meRight && judgeRight) lossesToJudge += 1;
      });
      console.log(`    pair by pair: right where the judge is wrong ${winsOverJudge}, wrong where the judge is right ${lossesToJudge}`);
    }
    let winsOverRule = 0;
    let lossesToRule = 0;
    let wrongMerges = 0;
    let missedMerges = 0;
    sample.forEach((p, i) => {
      const meRight = (mine[i].verdict === "same") === p.same;
      const ruleRight = (rule[i].verdict === "same") === p.same;
      if (meRight && !ruleRight) winsOverRule += 1;
      if (!meRight && ruleRight) lossesToRule += 1;
      if (!meRight && p.same) missedMerges += 1;
      if (!meRight && !p.same) wrongMerges += 1;
    });
    console.log(
      `    pair by pair: right where the rule is wrong ${winsOverRule}, wrong where the rule is right ${lossesToRule}; wrong merges ${wrongMerges}, missed merges ${missedMerges}`,
    );
  }
}

const dirBytes = (dir: string): number =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .reduce((s, e) => s + (e.isDirectory() ? dirBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0)
    : 0;
console.log(
  `\nPer call (tokenize and one forward pass, ${latencies.length} calls): p50 ${percentile(latencies, 50).toFixed(0)}ms, p95 ${percentile(latencies, 95).toFixed(0)}ms.` +
    `\nPairs over ${MAX_TOKENS} tokens, evidence cut: ${overlong} (${wordsCut} words).` +
    `\nPeak resident memory ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB (${rssBefore.toFixed(0)} MB before the model); the cache holds ${(dirBytes(cacheDir) / 1e6).toFixed(0)} MB.`,
);
if (values.pairs) {
  fs.writeFileSync(values.pairs, pairLines.map((l) => `${l}\n`).join(""));
  console.log(`${pairLines.length} per-pair lines written.`);
}
await model.dispose();
