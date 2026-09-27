/**
 * Score finding dedup against the answer keys, on pairs built from the
 * archived runs.
 *
 *   npm run dedup-bench                                   the store's rule only
 *   npm run dedup-bench -- --judge [--efforts none,low] [--cap 200] [--provider openai|anthropic] [--model <id>]
 *
 * Pairs are two findings on one page from the same app's archived runs,
 * labelled "same" when the key classifies both to one entry (engine/dedup.ts).
 * The rule is scored on every pair and on the capped sample; `--judge` also
 * asks a model about each sampled pair at each effort, which needs
 * ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment and spends tokens:
 * one call per pair per effort. The key is never printed. Demo and held-out
 * pairs are reported apart; nothing is tuned against the held-out ones.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { httpClient } from "../src/ci-run.ts";
import { parseKey, type AnswerKey, type RunArchive } from "../src/engine/bench.ts";
import { addUsage, detectProvider, KEY_ENV, NO_USAGE, redactKeys, secretValues, type ProviderName, type Usage } from "../src/engine/ci.ts";
import {
  buildPairs,
  decideDuplicate,
  formatPairScore,
  ruleJudgement,
  samplePairs,
  scorePairs,
  type Ask,
  type Judgement,
  type LabelledPair,
} from "../src/engine/dedup.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS: Record<string, string> = {
  demo: path.join(root, "demo-app", "answer-key.json"),
  holdout: path.join(root, "holdout-app", "answer-key.json"),
};

const { values } = parseArgs({
  strict: true,
  options: {
    judge: { type: "boolean", default: false },
    efforts: { type: "string", default: "none,low" },
    cap: { type: "string", default: "200" },
    provider: { type: "string" },
    model: { type: "string" },
  },
});
const cap = Number(values.cap);
if (!Number.isInteger(cap) || cap < 1 || cap > 200) {
  console.error("--cap must be a whole number from 1 to 200.");
  process.exit(1);
}

const keys: Record<string, AnswerKey> = Object.fromEntries(
  Object.entries(KEYS).map(([app, file]) => [app, parseKey(JSON.parse(fs.readFileSync(file, "utf8")))]),
);
const runsDir = path.join(root, "bench", "runs");
const archives: RunArchive[] = fs
  .readdirSync(runsDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8")) as RunArchive);

const set = buildPairs(archives, keys);
console.log(
  `Findings the key placed on a page: ${set.findings}; left out: ${set.identicalText} identical text, ${set.unmatched} unmatched, ${set.ambiguous} ambiguous, ${set.nonDefect} known non-defect` +
    (set.archivesWithoutKey ? `, ${set.archivesWithoutKey} archives with no key` : ""),
);

const balance = (ps: readonly LabelledPair[]): string =>
  `${ps.length} pairs, ${ps.filter((p) => p.same).length} same / ${ps.filter((p) => !p.same).length} different`;
const byApp = new Map<string, LabelledPair[]>();
for (const p of set.pairs) byApp.set(p.app, [...(byApp.get(p.app) ?? []), p]);

// The cap is split evenly between the apps, smallest first, and what a small
// app cannot use passes to the next: in proportion to pair counts, the demo's
// thousands of pairs left the held-out app a handful, too few to score.
const samples = new Map<string, LabelledPair[]>();
let left = cap;
const apps = [...byApp.entries()].sort((a, b) => a[1].length - b[1].length);
apps.forEach(([app, ps], i) => {
  const share = Math.max(1, Math.min(ps.length, Math.floor(left / (apps.length - i))));
  samples.set(app, samplePairs(ps, share));
  left -= share;
});

const ruleScore = (ps: readonly LabelledPair[]) =>
  scorePairs(
    ps.map((p) => p.same),
    ps.map((p) => ruleJudgement(p)),
  );
for (const [app, ps] of byApp) {
  console.log(`\n[${app}] all: ${balance(ps)}`);
  console.log(`  ${formatPairScore("rule", ruleScore(ps))}`);
  const sample = samples.get(app)!;
  console.log(`[${app}] sample: ${balance(sample)}`);
  console.log(`  ${formatPairScore("rule", ruleScore(sample))}`);
}

if (values.judge) {
  const env = process.env;
  const secrets = secretValues(env);
  for (const effort of values.efforts.split(",").map((e) => e.trim())) {
    const found = detectProvider(env, { provider: values.provider as ProviderName | undefined, model: values.model, effort });
    if (!found.ok) {
      console.log(`\nJudge at effort ${effort}: not run (${found.error}). Keys are read from ${Object.values(KEY_ENV).join(" or ")}.`);
      continue;
    }
    const { resolved } = found;
    const apiKey = env[KEY_ENV[resolved.provider]]!.trim();
    let usage: Usage = NO_USAGE;
    const ask: Ask = async (system, tools, kickoff) => {
      const turn = await httpClient(resolved, apiKey, system, tools, kickoff).next(120_000);
      usage = addUsage(usage, turn.usage);
      return turn;
    };
    for (const [app, sample] of samples) {
      const judgements: Array<Judgement | null> = [];
      const failures = new Map<string, number>();
      for (const p of sample) {
        const d = await decideDuplicate(p, ask);
        judgements.push(d.by === "model" || d.judgement?.verdict === "unsure" ? d.judgement! : null);
        if (d.note && d.by === "rule" && !d.judgement) failures.set(d.note, (failures.get(d.note) ?? 0) + 1);
      }
      const s = scorePairs(
        sample.map((p) => p.same),
        judgements,
      );
      console.log(`\n[${app}] ${formatPairScore(`judge ${resolved.provider} ${resolved.model} effort ${effort}`, s)}`);
      for (const [note, n] of failures) console.log(redactKeys(`  ${n}× ${note}`, secrets));
    }
    console.log(`Tokens at effort ${effort}: ${usage.input} in (${usage.cachedInput} cached), ${usage.output} out.`);
  }
}
