/**
 * Whether a lane's confidence means anything.
 *
 * `lane.ts` tells every lane its confidence must be calibrated — "0.5 means a
 * coin flip, 0.95 means you would bet on it" — and then the number was
 * averaged into one line and thrown away. Nothing was stored, so nothing could
 * ever be checked, and a confidence nobody checks is decoration. Decision-only
 * models report an expected calibration error for exactly this reason; asking
 * for calibration without measuring it is the half of the idea that costs
 * nothing and buys nothing.
 *
 * WHAT THIS MEASURES, precisely, because the number is easy to over-read: a
 * lane says "defect" about an observation and attaches a machine signature.
 * The run either went on to file a finding carrying that signature or it did
 * not. That is agreement between the lane and the bar the run actually
 * applied — NOT ground truth about the app. A lane can be perfectly calibrated
 * against a planner that files the wrong things. Where a finding has since
 * been re-tested through `scout_verify`, the verdict is reported beside it,
 * and that IS evidence about the app.
 *
 * Pure, so every rule here is table-tested.
 */
import { failingSignatures, type Finding } from "./memory.js";

/** A lane decision as recorded, with when and by whom. The shape `lane.ts` parses, plus provenance. */
export interface RecordedDecision {
  lane: string;
  observation: string;
  verdict: "defect" | "not_a_defect" | "unsure";
  severity: string | null;
  category: string | null;
  confidence: number;
  evidence: string | null;
  at: string;
}

/**
 * Upper edge of each confidence bucket. Five is enough to see a shape and few
 * enough that each holds a usable count on a run of a few dozen decisions;
 * twenty buckets of one decision each measure nothing.
 */
export const BUCKET_EDGES = [0.2, 0.4, 0.6, 0.8, 1.0] as const;

/**
 * Which bucket a confidence falls in. The top bucket is closed so 1.0 has
 * somewhere to go.
 *
 * A value that is not a number lands in the LOWEST bucket, not the highest.
 * The schema refuses those, but stored history is read back without one, and
 * falling through the comparisons put a NaN in the 0.8–1.0 bucket — a
 * confidence nobody stated, reported as near-certainty.
 */
export function bucketOf(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  const c = Math.min(1, Math.max(0, confidence));
  for (let i = 0; i < BUCKET_EDGES.length; i += 1) {
    if (c <= BUCKET_EDGES[i]) return i;
  }
  return BUCKET_EDGES.length - 1;
}

export function bucketLabel(i: number): string {
  const low = i === 0 ? 0 : BUCKET_EDGES[i - 1];
  return `${low.toFixed(1)}–${BUCKET_EDGES[i].toFixed(1)}`;
}

/**
 * The keys a piece of evidence can be joined on, or nothing when it cannot be
 * joined at all.
 *
 * Findings MERGE: the store treats `GET /api/things/3 500` and
 * `GET /api/things/7 500` as one bug, because the path normalises to
 * `/api/things/:id`. Joining on the literal string reported five lane
 * decisions about one endpoint as one filed and four dropped — the lanes
 * understated fivefold, and the number read as a finding about them rather
 * than a bug in this join. So the join uses the store's own rule.
 *
 * Evidence carrying no failure signature returns NOTHING rather than falling
 * back to its literal text. That fallback looked harmless and was the single
 * worst thing here: `500 on GET /api/r0` — ordinary English, and whichever
 * agent wrote the finding chose the word order — produced a key that matched
 * nothing, and a lane that was right about a bug that WAS filed published an
 * expected calibration error of 0.90. An unjoinable decision is now counted
 * and disclosed as unjoinable, not scored as a lane being wrong.
 */
export function joinKeys(evidence: string): Set<string> {
  return failingSignatures(evidence);
}

export interface Bucket {
  label: string;
  decisions: number;
  /** Mean confidence the lanes stated in this bucket. */
  stated: number;
  /** Share of them the run went on to file, 0–1. */
  filed: number;
}

/** A confidence as stored may be anything; the schema guards the wire, not the file. */
function usableConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export interface Calibration {
  /** Decisions that could be joined at all: a "defect" naming a failing endpoint, with a usable confidence. */
  checkable: number;
  /** How many of those became a filed finding. */
  filed: number;
  /** Mean stated confidence across them. */
  stated: number;
  buckets: Bucket[];
  /**
   * Expected calibration error: the gap between what the lanes said and what
   * happened, weighted by how many decisions sit in each bucket. 0 is perfect;
   * anything over about 0.1 means the numbers are not usable as probabilities.
   */
  ece: number;
  /** Of the filed ones, how many a later run re-tested, and what it found. Counted by FINDING. */
  verified: { present: number; gone: number; changed: number };
  /**
   * Decisions called a defect that no key could be built for — evidence naming
   * no failing endpoint, or a confidence the file should not have held. They
   * are NOT scored: a decision nothing can be looked up for says nothing about
   * the lane. Reported so the reader knows the denominator is not everything.
   */
  unjoinable: number;
}

/**
 * Join lane decisions to what the run filed.
 *
 * Only a "defect" carrying a signature has a checkable outcome. An "unsure" is
 * a request to look closer rather than a claim, and a decision with no
 * signature cannot be joined to anything — counting either would measure the
 * lane's willingness to attach evidence, not its judgement.
 */
export function calibrate(decisions: readonly RecordedDecision[], findings: readonly Finding[]): Calibration | null {
  const filedKeys = new Map<string, Finding>();
  for (const f of findings) {
    if (!f.evidence) continue;
    // A finding verified as still present is the most informative match, so it
    // wins a key two findings share; otherwise first write wins and the result
    // does not depend on the order findings came back in.
    for (const key of joinKeys(f.evidence)) {
      const prev = filedKeys.get(key);
      if (!prev || (f.verdict && f.verifiedAt && !(prev.verdict && prev.verifiedAt))) filedKeys.set(key, f);
    }
  }

  const claims = decisions.filter((d) => d.verdict === "defect" && d.evidence !== null);
  const checkable = claims.filter((d) => usableConfidence(d.confidence) !== null && joinKeys(d.evidence as string).size > 0);
  const unjoinable = claims.length - checkable.length;
  if (checkable.length === 0)
    return unjoinable > 0 ? { checkable: 0, filed: 0, stated: 0, buckets: [], ece: 0, verified: { present: 0, gone: 0, changed: 0 }, unjoinable } : null;

  const buckets: Array<{ n: number; conf: number; hits: number }> = BUCKET_EDGES.map(() => ({ n: 0, conf: 0, hits: 0 }));
  const verified = { present: 0, gone: 0, changed: 0 };
  const matched = new Map<string, Finding>();
  let filed = 0;
  let stated = 0;

  for (const d of checkable) {
    let match: Finding | undefined;
    for (const key of joinKeys(d.evidence as string)) {
      match = filedKeys.get(key);
      if (match) break;
    }
    const hit = match !== undefined;
    const confidence = usableConfidence(d.confidence) as number;
    const b = buckets[bucketOf(confidence)];
    b.n += 1;
    b.conf += confidence;
    if (hit) b.hits += 1;
    if (hit) filed += 1;
    stated += confidence;
    // By finding, not by decision: several decisions can match one finding,
    // and this sentence counts findings.
    if (match) matched.set(match.id, match);
  }
  for (const f of matched.values()) {
    // A verdict read from disk is not guaranteed to be one of the three.
    if (f.verifiedAt && f.verdict && f.verdict in verified) verified[f.verdict] += 1;
  }

  const n = checkable.length;
  let ece = 0;
  const out: Bucket[] = [];
  buckets.forEach((b, i) => {
    if (b.n === 0) return;
    const meanConf = b.conf / b.n;
    const rate = b.hits / b.n;
    ece += (b.n / n) * Math.abs(meanConf - rate);
    out.push({ label: bucketLabel(i), decisions: b.n, stated: meanConf, filed: rate });
  });

  return { checkable: n, filed, stated: stated / n, buckets: out, ece, verified, unjoinable };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * The report section. It leads with what the number is not, because "ECE 0.24"
 * above a table of percentages reads as a verdict on the app rather than on
 * the lanes that judged it.
 */
export function formatCalibration(c: Calibration | null): string[] {
  if (!c) return [];
  if (c.checkable < MIN_FOR_A_VERDICT) {
    // Suppress the NUMBER, not the fact. A run that recorded seven decisions
    // and a run that recorded none look identical when the section simply
    // vanishes, and the reader concludes the feature is broken — which is this
    // project's own definition of a silent path.
    const had = c.checkable + c.unjoinable;
    if (had === 0) return [];
    return [
      `## How well the lanes judged`,
      ``,
      `Not enough to say yet: ${c.checkable} lane decision(s) could be checked${c.unjoinable > 0 ? ` (and ${c.unjoinable} could not be looked up at all)` : ""}, ` +
        `and ${MIN_FOR_A_VERDICT} are needed before a calibration figure survives one of them changing.`,
      ``,
    ];
  }
  const lines = [
    `## How well the lanes judged`,
    ``,
    `${c.checkable} lane decision(s) called a defect on an endpoint that failed; ${c.filed} of them match a finding this project holds (${pct(c.filed / c.checkable)}), ` +
      `against a mean stated confidence of ${c.stated.toFixed(2)}.`,
    ``,
    `**What this is not.** It covers the project's whole history, not this run, and it measures agreement between the lanes and the bar this project applies — not whether the app is broken. ` +
      `A lane can be perfectly calibrated against a planner that files the wrong things. Two things also count against a lane through no fault of its own: a defect filed with no machine signature, ` +
      `and a finding whose signature was dropped when the store merged it into another. Read the figure as an ordering, not a measurement.`,
    ``,
    `| Stated confidence | Decisions | Said | Filed |`,
    `|---|---:|---:|---:|`,
  ];
  for (const b of c.buckets) {
    lines.push(`| ${b.label} | ${b.decisions} | ${b.stated.toFixed(2)} | ${pct(b.filed)} |`);
  }
  lines.push(
    ``,
    `Expected calibration error **${c.ece.toFixed(2)}** — the gap between what the lanes said and what happened, weighted by bucket. ${readEce(c.ece)}`,
  );

  if (c.unjoinable > 0) {
    lines.push(
      ``,
      `${c.unjoinable} further decision(s) called a defect but named no failing endpoint, so nothing could be looked up for them. They are excluded above rather than counted as wrong.`,
    );
  }

  const seen = c.verified.present + c.verified.gone + c.verified.changed;
  if (seen > 0) {
    lines.push(
      ``,
      `${seen} of the findings those decisions matched ${seen === 1 ? "has" : "have"} since been re-tested with \`scout_verify\`: ${c.verified.present} still present, ${c.verified.gone} gone, ${c.verified.changed} changed. ` +
        `Those verdicts are evidence about the app, unlike the table above. Findings no lane decision matched are not counted here, so this will not agree with the re-tested column elsewhere in the report.`,
    );
  }
  lines.push(``);
  return lines;
}

/** Below this, the number swings on a single decision and is worse than no number. */
export const MIN_FOR_A_VERDICT = 8;

/**
 * What the figure suggests, hedged on purpose. The join loses decisions it
 * cannot key and findings whose signature a merge discarded, and both push the
 * error upward — so a confident "these numbers are wrong" can itself be wrong.
 */
function readEce(ece: number): string {
  if (ece <= 0.05) return "The lanes' numbers track what happened closely.";
  if (ece <= 0.15) return "Close enough to compare lanes by.";
  return "Far enough apart that a lane's confidence is worth reading as an ordering rather than a rate — after checking the exclusions above, which push this upward.";
}

/** Most unfiled defects named when a lane report is folded; the rest are counted. */
export const MAX_UNFILED_NAMED = 10;

/**
 * The defects a lane judged that no finding in the store covers yet.
 *
 * A lane's report is a verdict, not a filing: a defect it judged and never
 * passed to scout_finding never reaches the report. That happened in a
 * measured run — a covered Save button, judged a defect at 0.75 and filed by
 * nobody — and it is cheapest to catch at the moment the planner folds the
 * report, while the lane's session is still open.
 *
 * Matched on the store's failing-endpoint signature where the evidence has
 * one, and on the evidence text otherwise. The text match is what the
 * calibration join refuses, because there a miss is scored against the lane;
 * here a miss only asks someone to check, which costs a look and nothing more.
 */
export function unfiledDefects(decisions: readonly Pick<RecordedDecision, "verdict" | "observation" | "evidence">[], findings: readonly Finding[]): string[] {
  const keys = new Set<string>();
  const filed: Filed[] = [];
  for (const f of findings) {
    const text = `${f.evidence ?? ""} ${f.title}`;
    if (f.evidence) for (const key of joinKeys(f.evidence)) keys.add(key);
    filed.push({ ids: identifiers(text), words: words(text), evidenceWords: words(f.evidence ?? ""), evidence: squash(f.evidence ?? "") });
  }
  const out: string[] = [];
  for (const d of decisions) {
    if (d.verdict !== "defect") continue;
    if (d.evidence) {
      const joined = [...joinKeys(d.evidence)];
      if (joined.some((k) => keys.has(k))) continue;
      // A failing-endpoint signature is the store's own identity for a bug. When
      // the decision has one and no finding shares it, nothing else is a match.
      if (joined.length > 0) {
        out.push(`${d.observation} — ${d.evidence}`);
        continue;
      }
      const ids = identifiers(d.evidence);
      const w = words(d.evidence);
      const text = squash(d.evidence);
      if (filed.some((f) => (text !== "" && f.evidence === text) || covers(ids, w, f))) continue;
    }
    out.push(d.evidence ? `${d.observation} — ${d.evidence}` : d.observation);
  }
  return out;
}

/**
 * Whether a finding covers a decision. Lanes reword evidence between filing it
 * and reporting it — an arrow for a hyphen, quoted JSON for bare, "8 links"
 * for "8 link(s)" — but keep the identifiers: test ids, API paths, contrast
 * ratios. Two shared identifiers, or one plus a real overlap in wording, or a
 * near-identical wording, is the same observation. One shared test id alone is
 * not: two different defects on one button (double-submit, empty submit) share
 * it, and a real miss must not hide behind its neighbour.
 */
interface Filed {
  ids: Set<string>;
  words: Set<string>;
  evidenceWords: Set<string>;
  evidence: string;
}

function covers(ids: Set<string>, w: Set<string>, f: Filed): boolean {
  let shared = 0;
  for (const id of ids) if (f.ids.has(id)) shared += 1;
  // Against the evidence alone as well: a finding's title adds words the
  // lane's report never repeats, and diluted an otherwise identical signature.
  const overlap = Math.max(jaccard(w, f.words), jaccard(w, f.evidenceWords));
  return shared >= 2 || (shared >= 1 && overlap >= 0.3) || overlap >= 0.6;
}

/**
 * Test ids, kebab-case identifiers of three or more parts, and contrast ratios.
 * Not API paths: a path that answered 2xx names a resource, not a defect — two
 * different bugs on POST /api/orders share it — and a failing path already has
 * its own identity in joinKeys.
 */
function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (const m of t.matchAll(/testid=["']?([a-z0-9_-]+)/g)) out.add(m[1]);
  for (const m of t.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/g)) out.add(m[0]);
  for (const m of t.matchAll(/\b\d+(?:\.\d+)?:1\b/g)) out.add(m[0]);
  return out;
}

const STOP = new Set([
  "the",
  "and",
  "with",
  "for",
  "but",
  "not",
  "was",
  "are",
  "has",
  "this",
  "that",
  "from",
  "into",
  "when",
  "then",
  "than",
  "only",
  "also",
  "its",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
}

function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
