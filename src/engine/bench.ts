/**
 * Scoring a run against an answer key.
 *
 * Every change to this engine and to its skill has been made on judgement:
 * something looked wrong in a run, it was fixed, and the next run looked
 * better — or looked different, which is not the same thing. There was no
 * number that could go up or down, so there was no way to tell a fix from a
 * coincidence, or to notice a change that made things worse.
 *
 * An app with KNOWN defects makes a number possible. Given what the app
 * actually contains and what a run reported, this computes recall (what it
 * found of what was there), precision (how much of what it reported was
 * real), how often it judged a defect and then never filed it, whether the
 * severities it chose agree with the key, and whether the confidence its lanes
 * stated was worth what they said — measured against the key, which is the
 * one ground truth a run cannot talk itself into.
 *
 * The key is data, not code: everything specific to one app lives in its key
 * file, so this module stays as generic as the rest of the engine.
 *
 * Pure, so every rule is table-tested.
 */
import { BUCKET_EDGES, bucketLabel, bucketOf, type RecordedDecision } from "./calibration.js";
import type { Finding } from "./memory.js";

export const LEVELS = ["minimal", "medium", "extensive"] as const;
export type Level = (typeof LEVELS)[number];

/** One entry of an answer key. `match` holds case-insensitive regular expressions tried against a finding's evidence and title. */
export interface KeyEntry {
  id: string;
  route: string;
  title: string;
  /** The category a finding for it should carry. Reported, not enforced: two categories can both be defensible. */
  category: string;
  /** The severity the key's author would give it. A judgement, and labelled as one wherever it is reported. */
  severity: "high" | "medium" | "low";
  /** The lowest level whose contract is expected to find it. A defect only a fuzzing pass can reach is not a miss at `medium`. */
  level: Level;
  match: string[];
}

/** Something a run is known to report that is NOT a defect. Matching one is a false positive, counted as such. */
export interface KeyNonDefect {
  id: string;
  title: string;
  /** Why it is not a defect, for the reader of a scorecard. */
  why: string;
  match: string[];
}

export interface AnswerKey {
  app: string;
  /** The defects the app was built to contain. Recall is measured against these. */
  defects: KeyEntry[];
  /**
   * Real problems a run found that nobody planted. They count as correct for
   * precision but not toward recall, so the number the key was designed around
   * stays comparable from one run to the next.
   */
  alsoReal: KeyEntry[];
  nonDefects: KeyNonDefect[];
}

const RANK: Record<Level, number> = { minimal: 0, medium: 1, extensive: 2 };
const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

type Matched = { kind: "defect" | "alsoReal"; entry: KeyEntry } | { kind: "nonDefect"; entry: KeyNonDefect };

function compile(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "i"));
}

/**
 * What a piece of reported text is, according to the key.
 *
 * Known non-defects are tried FIRST. They are written narrowly on purpose,
 * because a false positive usually mentions the same endpoint as a real defect
 * — "the filter is stuck after the Archived 500" names the archived failure —
 * and trying the defects first would credit the false claim with the real bug.
 */
export function classify(text: string, key: AnswerKey): Matched | null {
  for (const entry of key.nonDefects) if (compile(entry.match).some((r) => r.test(text))) return { kind: "nonDefect", entry };
  for (const entry of key.defects) if (compile(entry.match).some((r) => r.test(text))) return { kind: "defect", entry };
  for (const entry of key.alsoReal) if (compile(entry.match).some((r) => r.test(text))) return { kind: "alsoReal", entry };
  return null;
}

/** The text a finding is classified on. Evidence leads, because it is the machine signature; the title backs it up. */
export function findingText(f: Pick<Finding, "evidence" | "title">): string {
  return `${f.evidence ?? ""}\n${f.title}`;
}

/** The text a lane decision is classified on. */
export function decisionText(d: Pick<RecordedDecision, "evidence" | "observation">): string {
  return `${d.evidence ?? ""}\n${d.observation}`;
}

export interface Scorecard {
  app: string;
  level: Level;
  /** Defects the key expects at this level or below. */
  expected: number;
  /** Of those, found AND filed. */
  found: string[];
  /** Expected at this level and not filed. */
  missed: string[];
  /** A lane's report called it a defect, and no finding for it was ever filed. */
  judgedNotFiled: string[];
  /** Found although the key only expects it at a higher level. */
  beyondLevel: string[];
  findings: number;
  /** Findings matching a planted or also-real defect. */
  correct: number;
  falsePositives: Array<{ id: string; title: string; why: string; severity: string }>;
  /** Findings the key knows nothing about. They need a human label before precision can be final. */
  unknown: Array<{ title: string; severity: string; evidence: string }>;
  /** Extra findings for a defect that already had one. */
  duplicates: number;
  /** For each defect found, the filed severity against the key's. */
  severity: { agree: number; higher: number; lower: number; detail: Array<{ id: string; filed: string; key: string }> };
  calibration: KeyCalibration | null;
}

export interface KeyCalibration {
  /** Decisions the key could judge: a verdict about something the key names. */
  judged: number;
  correct: number;
  /** Decisions about things the key does not name. Excluded, and disclosed. */
  unjudged: number;
  buckets: Array<{ label: string; decisions: number; stated: number; correct: number }>;
  ece: number;
}

/**
 * Whether a lane's verdict was right, according to the key.
 *
 * "defect" on a planted or also-real defect is right, and on a known
 * non-defect is wrong. "not_a_defect" is the reverse. An "unsure" is a request
 * to look closer, not a claim, and is never scored. A decision about something
 * the key does not name cannot be judged at all, and is disclosed as such
 * rather than scored — the same rule the in-product calibration follows, for
 * the same reason.
 */
export function judgeDecision(d: RecordedDecision, key: AnswerKey): boolean | null {
  if (d.verdict === "unsure") return null;
  const m = classify(decisionText(d), key);
  if (!m) return null;
  const isDefect = m.kind !== "nonDefect";
  return d.verdict === "defect" ? isDefect : !isDefect;
}

export function calibrateAgainstKey(decisions: readonly RecordedDecision[], key: AnswerKey): KeyCalibration | null {
  const buckets = BUCKET_EDGES.map(() => ({ n: 0, conf: 0, right: 0 }));
  let judged = 0;
  let correct = 0;
  let unjudged = 0;
  for (const d of decisions) {
    if (d.verdict === "unsure") continue;
    const c = d.confidence;
    const right = judgeDecision(d, key);
    if (right === null || typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      unjudged += 1;
      continue;
    }
    judged += 1;
    if (right) correct += 1;
    const b = buckets[bucketOf(c)];
    b.n += 1;
    b.conf += c;
    if (right) b.right += 1;
  }
  if (judged === 0) return unjudged > 0 ? { judged: 0, correct: 0, unjudged, buckets: [], ece: 0 } : null;
  let ece = 0;
  const out: KeyCalibration["buckets"] = [];
  buckets.forEach((b, i) => {
    if (b.n === 0) return;
    ece += (b.n / judged) * Math.abs(b.conf / b.n - b.right / b.n);
    out.push({ label: bucketLabel(i), decisions: b.n, stated: b.conf / b.n, correct: b.right / b.n });
  });
  return { judged, correct, unjudged, buckets: out, ece };
}

/**
 * Score one run.
 *
 * `findings` should be the run's own: a project memory accumulates findings
 * across runs, and scoring an accumulated one credits a run with what an
 * earlier run found. Point the scorer at a fresh project directory per run.
 */
export function score(key: AnswerKey, findings: readonly Finding[], decisions: readonly RecordedDecision[], level: Level = "medium"): Scorecard {
  // Every finding the run filed counts, including one it later resolved: it
  // was still reported, and a run that files and then retracts a false claim
  // has still made it.
  const open = findings;
  const hitsByDefect = new Map<string, Finding[]>();
  const falsePositives: Scorecard["falsePositives"] = [];
  const unknown: Scorecard["unknown"] = [];
  let correct = 0;

  for (const f of open) {
    const m = classify(findingText(f), key);
    if (!m) {
      unknown.push({ title: f.title, severity: f.severity, evidence: f.evidence ?? "" });
      continue;
    }
    if (m.kind === "nonDefect") {
      falsePositives.push({ id: m.entry.id, title: f.title, why: m.entry.why, severity: f.severity });
      continue;
    }
    correct += 1;
    if (m.kind === "defect") {
      const list = hitsByDefect.get(m.entry.id) ?? [];
      list.push(f);
      hitsByDefect.set(m.entry.id, list);
    }
  }

  const expectedDefects = key.defects.filter((d) => RANK[d.level] <= RANK[level]);
  const found = expectedDefects.filter((d) => hitsByDefect.has(d.id)).map((d) => d.id);
  const missed = expectedDefects.filter((d) => !hitsByDefect.has(d.id)).map((d) => d.id);
  const beyondLevel = key.defects.filter((d) => RANK[d.level] > RANK[level] && hitsByDefect.has(d.id)).map((d) => d.id);

  // A defect a lane called out in its report, which no finding covers.
  const judged = new Set<string>();
  for (const d of decisions) {
    if (d.verdict !== "defect") continue;
    const m = classify(decisionText(d), key);
    if (m?.kind === "defect" && !hitsByDefect.has(m.entry.id)) judged.add(m.entry.id);
  }

  const severity: Scorecard["severity"] = { agree: 0, higher: 0, lower: 0, detail: [] };
  let duplicates = 0;
  for (const d of key.defects) {
    const hits = hitsByDefect.get(d.id);
    if (!hits) continue;
    duplicates += hits.length - 1;
    // The most severe finding for it is the one a reader acts on.
    const filed = hits.map((h) => h.severity).sort((a, b) => (SEVERITY_RANK[b] ?? 0) - (SEVERITY_RANK[a] ?? 0))[0];
    const diff = (SEVERITY_RANK[filed] ?? 0) - SEVERITY_RANK[d.severity];
    if (diff === 0) severity.agree += 1;
    else if (diff > 0) severity.higher += 1;
    else severity.lower += 1;
    severity.detail.push({ id: d.id, filed, key: d.severity });
  }

  return {
    app: key.app,
    level,
    expected: expectedDefects.length,
    found,
    missed,
    judgedNotFiled: [...judged],
    beyondLevel,
    findings: open.length,
    correct,
    falsePositives,
    unknown,
    duplicates,
    severity,
    calibration: calibrateAgainstKey(decisions, key),
  };
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

/** The scorecard as a person reads it. Leads with the two numbers, then says what each is made of. */
export function formatScorecard(c: Scorecard): string {
  const labelled = c.correct + c.falsePositives.length;
  const lines = [
    `SCORECARD — ${c.app}, level ${c.level}`,
    ``,
    `Recall     ${c.found.length}/${c.expected} (${pct(c.found.length, c.expected)}) of the planted defects expected at this level`,
    `Precision  ${c.correct}/${labelled} (${pct(c.correct, labelled)}) of the findings the key can label` +
      (c.unknown.length ? ` — ${c.unknown.length} more are unlabelled` : ""),
    ``,
  ];
  if (c.missed.length) lines.push(`Missed: ${c.missed.join(", ")}`);
  if (c.judgedNotFiled.length) lines.push(`Judged a defect in a lane report, never filed: ${c.judgedNotFiled.join(", ")}`);
  if (c.beyondLevel.length) lines.push(`Found above this level's contract: ${c.beyondLevel.join(", ")}`);
  if (c.falsePositives.length) {
    lines.push(``, `False positives (${c.falsePositives.length}):`);
    for (const fp of c.falsePositives) lines.push(`  [${fp.severity}] ${fp.title} — ${fp.why}`);
  }
  if (c.unknown.length) {
    lines.push(``, `Unlabelled (${c.unknown.length}) — add to the key once a person has judged them:`);
    for (const u of c.unknown) lines.push(`  [${u.severity}] ${u.title}`);
  }
  const s = c.severity;
  lines.push(
    ``,
    `Severity vs the key's judgement: ${s.agree} agree, ${s.higher} filed higher, ${s.lower} filed lower` +
      (s.detail.some((d) => d.filed !== d.key)
        ? ` (${s.detail
            .filter((d) => d.filed !== d.key)
            .map((d) => `${d.id} ${d.filed}→${d.key}`)
            .join(", ")})`
        : ""),
  );
  if (c.duplicates) lines.push(`Duplicates: ${c.duplicates} extra finding(s) for a defect that already had one`);
  if (c.calibration) {
    const k = c.calibration;
    lines.push(
      ``,
      `Lane calibration against the key: ${k.correct}/${k.judged} verdicts right (${pct(k.correct, k.judged)}), expected calibration error ${k.ece.toFixed(2)}` +
        (k.unjudged ? ` — ${k.unjudged} decision(s) about things the key does not name were not scored` : ""),
    );
    for (const b of k.buckets)
      lines.push(`  stated ${b.label}: ${b.decisions} decision(s), said ${b.stated.toFixed(2)}, right ${Math.round(b.correct * 100)}%`);
  }
  return lines.join("\n");
}
