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
import type { Finding } from "./memory.js";

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

/** Which bucket a confidence falls in. The top bucket is closed so 1.0 has somewhere to go. */
export function bucketOf(confidence: number): number {
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
 * A signature as a join key. Evidence is a machine signature on both sides, so
 * the only drift worth absorbing is spacing — a lane writing
 * "GET  /api/things 500" means the same endpoint as the finding that records
 * "GET /api/things 500". Case is left alone: a path is case-sensitive.
 */
export function signatureKey(evidence: string): string {
  return evidence.trim().replace(/\s+/g, " ");
}

export interface Bucket {
  label: string;
  decisions: number;
  /** Mean confidence the lanes stated in this bucket. */
  stated: number;
  /** Share of them the run went on to file, 0–1. */
  filed: number;
}

export interface Calibration {
  /** Decisions with a checkable outcome: a "defect" verdict carrying a signature. */
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
  /** Of the filed ones, how many a later run re-tested, and what it found. */
  verified: { present: number; gone: number; changed: number };
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
    if (f.evidence) filedKeys.set(signatureKey(f.evidence), f);
  }

  const checkable = decisions.filter((d) => d.verdict === "defect" && d.evidence !== null);
  if (checkable.length === 0) return null;

  const buckets: Array<{ n: number; conf: number; hits: number }> = BUCKET_EDGES.map(() => ({ n: 0, conf: 0, hits: 0 }));
  const verified = { present: 0, gone: 0, changed: 0 };
  let filed = 0;
  let stated = 0;

  for (const d of checkable) {
    const match = filedKeys.get(signatureKey(d.evidence as string));
    const hit = match !== undefined;
    const b = buckets[bucketOf(d.confidence)];
    b.n += 1;
    b.conf += d.confidence;
    if (hit) b.hits += 1;
    if (hit) filed += 1;
    stated += d.confidence;
    if (match?.verdict && match.verifiedAt) verified[match.verdict] += 1;
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

  return { checkable: n, filed, stated: stated / n, buckets: out, ece, verified };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * The report section. It leads with what the number is not, because "ECE 0.24"
 * above a table of percentages reads as a verdict on the app rather than on
 * the lanes that judged it.
 */
export function formatCalibration(c: Calibration | null): string[] {
  if (!c || c.checkable < MIN_FOR_A_VERDICT) {
    // A handful of decisions produce a number that swings on one of them.
    // Saying nothing is more honest than printing a percentage nobody should
    // act on, and the section reappears once a run is big enough.
    return [];
  }
  const lines = [
    `## How well the lanes judged`,
    ``,
    `${c.checkable} lane decision(s) called a defect and attached a signature; ${c.filed} became a filed finding (${pct(c.filed / c.checkable)}), ` +
      `against a mean stated confidence of ${c.stated.toFixed(2)}. This measures agreement between the lanes and the bar this run applied — not whether the app is broken. ` +
      `A lane can be perfectly calibrated against a planner that files the wrong things.`,
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

  const seen = c.verified.present + c.verified.gone + c.verified.changed;
  if (seen > 0) {
    lines.push(
      ``,
      `${seen} of the filed findings have since been re-tested with \`scout_verify\`: ${c.verified.present} still present, ${c.verified.gone} gone, ${c.verified.changed} changed. ` +
        `Those verdicts are evidence about the app, unlike the table above.`,
    );
  }
  lines.push(``);
  return lines;
}

/** Below this, the number swings on a single decision and is worse than no number. */
export const MIN_FOR_A_VERDICT = 8;

function readEce(ece: number): string {
  if (ece <= 0.05) return "The numbers are usable as probabilities.";
  if (ece <= 0.15) return "Close enough to act on, loosely.";
  return "Too far apart to read as probabilities; treat a lane's confidence as an ordering, not a rate.";
}
