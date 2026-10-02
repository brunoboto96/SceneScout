/**
 * A local classifier (GLiNER2.5-Decide) as the duplicate-finding judge, for
 * the opt-in benchmark in scripts/dedup-gliner-bench.ts. Nothing here ships:
 * the package's `files` holds only dist/, and nothing in src/ imports this.
 *
 * What lives here is what can be table-tested without the model: the GLiNER2
 * input layout, how a pair becomes the classifier's text, and the bootstrap
 * intervals the result is reported with (bench-test holds all three).
 */
import type { JudgedPair, Judgement } from "../../src/engine/dedup.ts";

// ── the GLiNER2 classification layout ──────────────────────────────────────

/**
 * The gliner2 (2.0.0) processor's word splitter, WhitespaceTokenSplitter:
 * URLs, emails and @handles whole, words joined by - or _, and every other
 * non-space character on its own; each word lowercased. Python's `\w` on str
 * is Unicode-aware, so it is spelled with Unicode classes here.
 */
const WORD = /(?:https?:\/\/[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S/giu;

/** The text as the processor sees it: a terminal full stop added when it has no . ! or ?, then split into lowercased words. */
export function textWords(text: string): string[] {
  const ended = text === "" ? "." : /[.!?]$/.test(text) ? text : `${text}.`;
  return [...ended.matchAll(WORD)].map((m) => m[0].toLowerCase());
}

export interface Question {
  /** The task text, kept whole and in its case. */
  task: string;
  labels: readonly string[];
  /** Appended to the task as ` [DESCRIPTION] label: description`, in label order. */
  descriptions?: Readonly<Record<string, string>>;
}

/**
 * The sequence of pieces the processor tokenizes one at a time, and which
 * pieces are label markers: `( [P] task ( [L] label … ) )` per question,
 * questions joined by [SEP_STRUCT], then [SEP_TEXT] and the text's words.
 * No [CLS] or [SEP].
 */
export function layoutPieces(questions: readonly Question[], words: readonly string[]): { pieces: string[]; markers: number[][] } {
  if (questions.length === 0) throw new Error("A layout needs at least one question.");
  const pieces: string[] = [];
  const markers: number[][] = [];
  questions.forEach((q, i) => {
    if (q.labels.length < 2) throw new Error(`Question "${q.task}" needs at least two labels.`);
    if (i > 0) pieces.push("[SEP_STRUCT]");
    const descs = q.labels.filter((l) => q.descriptions?.[l]).map((l) => ` [DESCRIPTION] ${l}: ${q.descriptions![l]}`);
    pieces.push("(", "[P]", q.task + descs.join(""), "(");
    const own: number[] = [];
    for (const label of q.labels) {
      own.push(pieces.length);
      pieces.push("[L]", label);
    }
    pieces.push(")", ")");
    markers.push(own);
  });
  pieces.push("[SEP_TEXT]", ...words);
  return { pieces, markers };
}

/**
 * Token ids and the position of each label marker, from a tokenizer that
 * turns one piece into its ids with no special tokens added. A marker piece
 * must be one token, or its position is not a label's.
 */
export function encodeLayout(
  layout: { pieces: readonly string[]; markers: readonly number[][] },
  tokenize: (piece: string) => readonly number[],
): { ids: number[]; markerPositions: number[][] } {
  const ids: number[] = [];
  const start: number[] = [];
  for (const piece of layout.pieces) {
    start.push(ids.length);
    ids.push(...tokenize(piece));
  }
  const end = (i: number) => (i + 1 < start.length ? start[i + 1] : ids.length);
  const markerPositions = layout.markers.map((group) =>
    group.map((pieceIndex) => {
      if (end(pieceIndex) - start[pieceIndex] !== 1) {
        throw new Error(`The marker ${layout.pieces[pieceIndex]} is not one token for this tokenizer.`);
      }
      return start[pieceIndex];
    }),
  );
  return { ids, markerPositions };
}

/** A softmax over one question's logits. */
export function softmax(logits: readonly number[]): number[] {
  const top = Math.max(...logits);
  const e = logits.map((x) => Math.exp(x - top));
  const sum = e.reduce((s, x) => s + x, 0);
  return e.map((x) => x / sum);
}

// ── a pair as the classifier's text ────────────────────────────────────────

/** One way of asking: a question whose labels include the one that means "same defect". */
export interface Phrasing {
  name: string;
  question: Question;
  /** The label whose probability is p_same. */
  sameLabel: string;
}

/**
 * The phrasings tried, at most three, chosen between on the demo pairs only.
 * The text is the same for all three; only the question differs.
 */
export const PHRASINGS: readonly Phrasing[] = [
  {
    name: "yes-no",
    question: { task: "Do finding A and finding B describe the same defect?", labels: ["yes", "no"] },
    sameLabel: "yes",
  },
  {
    name: "described",
    question: {
      task: "Are finding A and finding B the same defect or different defects?",
      labels: ["same defect", "different defects"],
      descriptions: {
        "same defect": "one root cause that a single fix would close, however differently it is worded, categorised or evidenced",
        "different defects": "two things a developer would fix separately, even on one page, one control or one endpoint",
      },
    },
    sameLabel: "same defect",
  },
  {
    name: "duplicate",
    question: { task: "Is finding B a duplicate of finding A?", labels: ["duplicate", "not a duplicate"] },
    sameLabel: "duplicate",
  },
];

export const phrasingNamed = (name: string): Phrasing | undefined => PHRASINGS.find((p) => p.name === name);

/** The words of one finding's part of the text; the evidence is last, so it is what a budget cuts. */
function findingWords(name: string, f: JudgedPair["a"]): { head: string[]; evidence: string[] } {
  const head = textWords(`Finding ${name}: ${f.title.replace(/[.!?]+$/, "")}. Category: ${f.category || "none"}.`);
  const evidence = f.evidence ? textWords(`Evidence: ${f.evidence}`) : [];
  return { head, evidence };
}

/**
 * The pair as the classifier's words, the earlier finding as A, cut to fit
 * `budget` tokens: each finding keeps its title and category, and the
 * evidence is cut from the end, the longer one first, so a long evidence
 * cannot push the other finding out. `cut` is how many words were dropped.
 */
export function pairWords(p: JudgedPair, wordTokens: (word: string) => number, budget: number): { words: string[]; cut: number } {
  const lead = textWords(`Two findings filed on the page ${p.route}.`);
  const a = findingWords("A", p.a);
  const b = findingWords("B", p.b);
  const cost = (ws: readonly string[]) => ws.reduce((s, w) => s + wordTokens(w), 0);
  const fixed = cost(lead) + cost(a.head) + cost(b.head);
  let ea = a.evidence;
  let eb = b.evidence;
  let cut = 0;
  while (fixed + cost(ea) + cost(eb) > budget && ea.length + eb.length > 0) {
    if (cost(ea) >= cost(eb)) ea = ea.slice(0, -1);
    else eb = eb.slice(0, -1);
    cut += 1;
  }
  if (fixed + cost(ea) + cost(eb) > budget) throw new Error(`A pair's titles alone need more than ${budget} tokens.`);
  return { words: [...lead, ...a.head, ...ea, ...b.head, ...eb], cut };
}

// ── intervals ──────────────────────────────────────────────────────────────

/** A small seeded generator (mulberry32), so an interval is the same on every run. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 95% percentile bootstrap interval for `stat` over items 0..n−1. With
 * `clusters`, whole clusters are drawn with replacement and every item in a
 * drawn cluster comes with it: pairs between the same two key entries are
 * not independent, so drawing them one by one would give intervals narrower
 * than the evidence. Pairs in different clusters that share one entry are
 * still drawn apart, so even these intervals are somewhat narrow. A resample
 * on which `stat` gives null is skipped and counted.
 */
export function bootstrap(
  n: number,
  stat: (indices: readonly number[]) => number | null,
  opts: { clusters?: readonly string[]; resamples?: number; seed?: number } = {},
): { lo: number; hi: number; skipped: number } | null {
  const resamples = opts.resamples ?? 2000;
  const rand = seeded(opts.seed ?? 353);
  const groups: number[][] = [];
  if (opts.clusters) {
    if (opts.clusters.length !== n) throw new Error(`${n} items but ${opts.clusters.length} cluster names.`);
    const byName = new Map<string, number[]>();
    opts.clusters.forEach((c, i) => byName.set(c, [...(byName.get(c) ?? []), i]));
    groups.push(...byName.values());
  } else for (let i = 0; i < n; i++) groups.push([i]);
  const values: number[] = [];
  let skipped = 0;
  for (let r = 0; r < resamples; r++) {
    const draw: number[] = [];
    for (let k = 0; k < groups.length; k++) draw.push(...groups[Math.floor(rand() * groups.length)]);
    const v = stat(draw);
    if (v === null) skipped += 1;
    else values.push(v);
  }
  if (values.length === 0) return null;
  values.sort((x, y) => x - y);
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))];
  return { lo: at(0.025), hi: at(0.975), skipped };
}

/** The cluster a labelled pair belongs to: its two key entries, in either order. */
export const pairCluster = (keyA: string, keyB: string): string => [keyA, keyB].sort().join("|");

/** The p-th percentile (0–100) of some timings, nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("No values to take a percentile of.");
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** A judgement from the classifier's probability of the label that means "same". */
export const judgementOf = (pSame: number): Judgement => ({ verdict: pSame >= 0.5 ? "same" : "different", pSame });
