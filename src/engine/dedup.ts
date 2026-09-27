/**
 * Measuring the finding-dedup decision against the answer keys, and an
 * optional model-backed judge to measure beside it.
 *
 * The store's dedup rule (memory.ts, isDuplicateFinding) decides whether a
 * newly filed finding is one it already records. Its mistakes are costly both
 * ways: a wrong merge loses a finding, a missed merge shows one bug twice. This
 * file turns the archived benchmark runs into labelled pairs — two findings on
 * one page, "same" when the key classifies both to one entry and "different"
 * when it classifies them to two — and scores any decider on them with
 * accuracy, Brier and ECE.
 *
 * The model judge asks for a verdict (same / different / unsure) and a
 * probability through one tool call, so its answer is structured, not parsed
 * from prose. It is measured here and not used by the store: the rule stays
 * the only thing that dedups until the judge's Brier beats it on these pairs.
 * Everything here is pure; the network is the caller's, through `ask`.
 */
import { createHash } from "node:crypto";
import { archiveApp, classify, findingText, type AnswerKey, type KeyContextual, type KeyEntry, type RunArchive } from "./bench.js";
import { MIN_FOR_A_VERDICT } from "./calibration.js";
import type { ToolSpec } from "./ci.js";
import { findingId, isDuplicateFinding } from "./memory.js";
import type { ModelTurn } from "./provider.js";

// ── the labelled pairs ──────────────────────────────────────────────────────

export interface PairFinding {
  title: string;
  category: string;
  evidence?: string;
  /** The key entry it was classified to. */
  keyId: string;
  /** The archived run it came from. */
  run: string;
}

export interface LabelledPair {
  app: string;
  /** A page both findings' key entries name: the route the pair is judged on. */
  route: string;
  a: PairFinding;
  b: PairFinding;
  /** True when the key classifies both findings to one entry. */
  same: boolean;
}

export interface PairSet {
  pairs: LabelledPair[];
  /** Distinct findings the key placed on a page, across every app; the counts after it are what was left out and why. */
  findings: number;
  /** The same category, title and evidence as a finding already taken: one text, not two findings to pair. */
  identicalText: number;
  /** The key names nothing in it. */
  unmatched: number;
  /** More than one key entry claims it. */
  ambiguous: number;
  /** A known non-defect: the key gives it no page, so it cannot be paired by page. */
  nonDefect: number;
  /** Archives whose app has no key here. */
  archivesWithoutKey: number;
}

const pagesOf = (e: Pick<KeyEntry | KeyContextual, "route" | "alsoOn">): string[] => [e.route, ...(e.alsoOn ?? [])];
const norm = (s: string | undefined): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Every pair of findings, within one app across all its archived runs, whose
 * key entries share a page, labelled by the key. Across runs because that is
 * where the store dedups: a finding filed by one run against one an earlier
 * run left. Findings with identical category, title and evidence are collapsed
 * first, so a phrasing repeated in many runs is one finding, not a crowd of
 * trivially-same pairs.
 *
 * The labels come from the key's patterns, so they are only as good as the
 * key: a finding the key misclassifies gives a wrong label.
 */
export function buildPairs(archives: readonly RunArchive[], keys: Readonly<Record<string, AnswerKey>>): PairSet {
  const out: PairSet = { pairs: [], findings: 0, identicalText: 0, unmatched: 0, ambiguous: 0, nonDefect: 0, archivesWithoutKey: 0 };
  const byApp = new Map<string, Array<{ f: PairFinding; pages: string[] }>>();
  const seen = new Set<string>();
  for (const archive of archives) {
    const app = archiveApp(archive);
    const key = keys[app];
    if (!key) {
      out.archivesWithoutKey += 1;
      continue;
    }
    const list = byApp.get(app) ?? [];
    byApp.set(app, list);
    for (const f of archive.findings) {
      const text = `${app}|${norm(f.category)}|${norm(f.title)}|${norm(f.evidence)}`;
      if (seen.has(text)) {
        out.identicalText += 1;
        continue;
      }
      seen.add(text);
      const c = classify(findingText(f), key);
      if (c === null) out.unmatched += 1;
      else if (c.kind === "ambiguous") out.ambiguous += 1;
      else if (c.kind === "nonDefect") out.nonDefect += 1;
      else {
        out.findings += 1;
        list.push({ f: { title: f.title, category: f.category ?? "", evidence: f.evidence, keyId: c.entry.id, run: archive.run }, pages: pagesOf(c.entry) });
      }
    }
  }
  for (const [app, list] of byApp) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const route = list[i].pages.find((p) => list[j].pages.includes(p));
        if (route === undefined) continue;
        out.pairs.push({ app, route, a: list[i].f, b: list[j].f, same: list[i].f.keyId === list[j].f.keyId });
      }
    }
  }
  return out;
}

/**
 * At most `cap` pairs, chosen by a hash of their texts: the same pairs every
 * time for the same archives, whatever order they were built in, and no
 * preference for the runs that happen to be listed first.
 */
export function samplePairs(pairs: readonly LabelledPair[], cap: number): LabelledPair[] {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`The pair cap must be a positive whole number, not ${cap}.`);
  const h = (p: LabelledPair): string =>
    createHash("sha256")
      .update([p.app, p.route, p.a.run, p.a.title, p.a.evidence ?? "", p.b.run, p.b.title, p.b.evidence ?? ""].join("\n"))
      .digest("hex");
  return pairs
    .map((p) => ({ p, k: h(p) }))
    .sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
    .slice(0, cap)
    .map((x) => x.p);
}

// ── deciders ────────────────────────────────────────────────────────────────

export type Verdict = "same" | "different" | "unsure";

export interface Judgement {
  verdict: Verdict;
  /** Probability the two findings are one defect. */
  pSame: number;
}

const asStored = (f: PairFinding, route: string) => ({ title: f.title, category: f.category, evidence: f.evidence, detail: "", state: route });

/**
 * The store's own rule on a pair, as a judgement: the earlier finding is the
 * stored one, the later the one being filed. It states no probability, so its
 * probability is its verdict, 1 or 0.
 */
export function ruleJudgement(p: Pick<LabelledPair, "a" | "b" | "route">): Judgement {
  const existing = { ...asStored(p.a, p.route), id: findingId(asStored(p.a, p.route)) };
  const same = isDuplicateFinding(existing, asStored(p.b, p.route));
  return { verdict: same ? "same" : "different", pSame: same ? 1 : 0 };
}

// ── the model judge ─────────────────────────────────────────────────────────

export const JUDGE_TOOL: ToolSpec = {
  name: "judge_pair",
  description: "Record whether the two findings describe one defect.",
  parameters: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["same", "different", "unsure"] },
      p_same: { type: "number", minimum: 0, maximum: 1, description: "Probability the two findings are one defect." },
    },
    required: ["verdict", "p_same"],
    additionalProperties: false,
  },
};

export const JUDGE_SYSTEM =
  "You decide whether two findings filed by exploratory testers of one web app describe the SAME defect or DIFFERENT defects. " +
  "Same: one root cause a single fix would close, however differently it is worded, categorised or evidenced. " +
  "Different: two things a developer would fix separately, even on one page, one control or one endpoint. " +
  "Answer only by calling judge_pair once, with no prose. verdict is same, different or unsure; p_same is your calibrated probability that they are one defect: " +
  "about 0.5 when the text cannot tell, and near 0 or 1 only when it plainly can. Use unsure only when the findings give too little to go on.";

/** What the judge is shown: the fields a tester filed, nothing from the key. */
export function judgeKickoff(
  route: string,
  a: Pick<PairFinding, "title" | "category" | "evidence">,
  b: Pick<PairFinding, "title" | "category" | "evidence">,
): string {
  const show = (f: typeof a) => ({ title: f.title, category: f.category, evidence: f.evidence ?? "" });
  return `Both findings were filed on the page ${route}.\n\nFinding A: ${JSON.stringify(show(a))}\nFinding B: ${JSON.stringify(show(b))}`;
}

/**
 * Read the judge's one tool call. Anything else — no call, another tool, a
 * verdict outside the three, a probability outside 0–1 or one that
 * contradicts its own verdict — is an error, never a guess at what was meant.
 */
export function parseJudgement(turn: Pick<ModelTurn, "calls" | "note">): { ok: true; judgement: Judgement } | { ok: false; error: string } {
  const call = turn.calls.find((c) => c.name === JUDGE_TOOL.name);
  if (!call) return { ok: false, error: turn.note ?? `the model did not call ${JUDGE_TOOL.name}` };
  if (call.argsError) return { ok: false, error: call.argsError };
  const input = call.input as { verdict?: unknown; p_same?: unknown } | undefined;
  const verdict = input?.verdict;
  const p = input?.p_same;
  if (verdict !== "same" && verdict !== "different" && verdict !== "unsure")
    return { ok: false, error: `the verdict ${JSON.stringify(verdict)} is not same, different or unsure` };
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return { ok: false, error: `p_same ${JSON.stringify(p)} is not a probability` };
  if ((verdict === "same" && p < 0.5) || (verdict === "different" && p > 0.5)) return { ok: false, error: `the verdict ${verdict} contradicts p_same ${p}` };
  return { ok: true, judgement: { verdict, pSame: p } };
}

/** One model call: a system prompt, tools and a first message in, one turn out. The caller owns the network and the key. */
export type Ask = (system: string, tools: readonly ToolSpec[], kickoff: string) => Promise<ModelTurn>;

export interface Decision {
  duplicate: boolean;
  by: "rule" | "model";
  /** The model's judgement, when it gave a usable one. */
  judgement?: Judgement;
  /** Why the rule decided when a judge was asked: the judge failed, or was unsure. */
  note?: string;
}

/**
 * Decide one pair. With no judge the rule decides, as the store does. With a
 * judge, the model decides when it answers same or different; when it fails
 * for any reason, or is unsure, the rule decides and the note says why, so a
 * run never silently becomes a run of the rule.
 */
export async function decideDuplicate(p: Pick<LabelledPair, "a" | "b" | "route">, ask?: Ask): Promise<Decision> {
  const rule = (): boolean => ruleJudgement(p).verdict === "same";
  if (!ask) return { duplicate: rule(), by: "rule" };
  let parsed: ReturnType<typeof parseJudgement>;
  try {
    parsed = parseJudgement(await ask(JUDGE_SYSTEM, [JUDGE_TOOL], judgeKickoff(p.route, p.a, p.b)));
  } catch (err) {
    parsed = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed.ok) return { duplicate: rule(), by: "rule", note: `the model judge failed (${parsed.error}); the current rule decided` };
  if (parsed.judgement.verdict === "unsure")
    return { duplicate: rule(), by: "rule", judgement: parsed.judgement, note: "the model judge was unsure; the current rule decided" };
  return { duplicate: parsed.judgement.verdict === "same", by: "model", judgement: parsed.judgement };
}

// ── scoring ─────────────────────────────────────────────────────────────────

export interface PairScore {
  /** Pairs with a same/different verdict and a usable probability. */
  judged: number;
  correct: number;
  /** Excluded from every figure below: a request to look closer, not a claim. */
  unsure: number;
  /** Excluded: the decider gave no usable judgement (the judge failed). */
  failed: number;
  /** Of `judged`, how many the key calls the same defect. */
  sameInKey: number;
  /** Null below MIN_FOR_A_VERDICT judged pairs: too few to publish a number. */
  accuracy: number | null;
  /** Mean of (p_same − label)², label 1 for same. 0 is perfect; stating the base rate every time scores `brierRef`. */
  brier: number | null;
  /** Brier of always stating the base rate of these pairs, for the skill score 1 − brier / brierRef. */
  brierRef: number | null;
  /** Equal-count buckets over p_same; tied probabilities stay in one bucket, so a 0/1 decider has at most two. */
  buckets: Array<{ n: number; stated: number; actual: number }>;
  ece: number | null;
}

/**
 * Accuracy, Brier and ECE of a decider over labelled pairs. `judgements[i]`
 * answers `labels[i]`; null is a judge that gave no usable answer. The
 * probability is scored against the key's label directly (a proper score for
 * a yes/no question), not a confidence in the verdict: the two agree whenever
 * the verdict follows the probability, which parseJudgement enforces.
 */
export function scorePairs(labels: readonly boolean[], judgements: ReadonlyArray<Judgement | null>, bucketCount = 5): PairScore {
  if (labels.length !== judgements.length) throw new Error(`${labels.length} labels but ${judgements.length} judgements.`);
  const out: PairScore = { judged: 0, correct: 0, unsure: 0, failed: 0, sameInKey: 0, accuracy: null, brier: null, brierRef: null, buckets: [], ece: null };
  const scored: Array<{ p: number; y: number }> = [];
  labels.forEach((same, i) => {
    const j = judgements[i];
    if (j === null) return void (out.failed += 1);
    if (j.verdict === "unsure") return void (out.unsure += 1);
    out.judged += 1;
    if (same) out.sameInKey += 1;
    if ((j.verdict === "same") === same) out.correct += 1;
    scored.push({ p: j.pSame, y: same ? 1 : 0 });
  });
  if (out.judged < MIN_FOR_A_VERDICT) return out;
  const n = scored.length;
  out.accuracy = out.correct / n;
  out.brier = scored.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / n;
  const base = out.sameInKey / n;
  out.brierRef = base * (1 - base);
  // Equal-count buckets, cut only between different probabilities.
  const sorted = [...scored].sort((x, y) => x.p - y.p);
  const target = n / bucketCount;
  let cur: typeof sorted = [];
  const flush = () => {
    if (cur.length === 0) return;
    out.buckets.push({ n: cur.length, stated: cur.reduce((s, x) => s + x.p, 0) / cur.length, actual: cur.reduce((s, x) => s + x.y, 0) / cur.length });
    cur = [];
  };
  sorted.forEach((x, i) => {
    if (cur.length >= target && x.p !== sorted[i - 1].p) flush();
    cur.push(x);
  });
  flush();
  out.ece = out.buckets.reduce((s, b) => s + (b.n / n) * Math.abs(b.stated - b.actual), 0);
  return out;
}

/** One line per score, for the bench output and the results log. */
export function formatPairScore(name: string, s: PairScore): string {
  const head = `${name}: ${s.judged} judged (${s.sameInKey} same in the key), ${s.unsure} unsure, ${s.failed} failed`;
  if (s.accuracy === null) return `${head}; fewer than ${MIN_FOR_A_VERDICT} judged, no figures`;
  const skill = s.brierRef ? ` (skill ${(1 - s.brier! / s.brierRef).toFixed(2)} vs the base rate)` : "";
  const buckets = s.buckets.map((b) => `n=${b.n} stated ${b.stated.toFixed(2)} actual ${b.actual.toFixed(2)}`).join("; ");
  return `${head}; accuracy ${(s.accuracy * 100).toFixed(1)}%, Brier ${s.brier!.toFixed(3)}${skill}, ECE ${s.ece!.toFixed(3)} [${buckets}]`;
}
