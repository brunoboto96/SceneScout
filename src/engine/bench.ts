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
 * Every future change is accepted or rejected by the number this produces, so
 * the failure that matters most here is a PLAUSIBLE WRONG number. Three rules
 * follow from that. A piece of text two key entries both claim is reported as
 * ambiguous and scored as neither. The key is validated when it is read, so a
 * mistyped level cannot silently drop a defect from recall. And the key is
 * hashed into every scorecard, so two runs scored against different keys are
 * never compared by accident.
 *
 * The key is data, not code: everything specific to one app lives in its key
 * file, so this module stays as generic as the rest of the engine.
 *
 * Pure, so every rule is table-tested.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { BUCKET_EDGES, bucketLabel, bucketOf, type RecordedDecision } from "./calibration.js";
import type { Finding } from "./memory.js";

export const LEVELS = ["minimal", "medium", "extensive"] as const;
export type Level = (typeof LEVELS)[number];
const SEVERITIES = ["high", "medium", "low"] as const;

const Pattern = z.string().refine(
  (p) => {
    try {
      new RegExp(p, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "is not a valid regular expression" },
);

const Entry = z
  .object({
    id: z.string().min(1),
    route: z.string().startsWith("/"),
    title: z.string().min(1),
    /** The category a finding for it should carry. Reported, not enforced: two categories can both be defensible. */
    category: z.string().min(1),
    /** The severity the key's author would give it. A judgement, and labelled as one wherever it is reported. */
    severity: z.enum(SEVERITIES),
    /** The lowest level whose contract is expected to find it. A defect only a fuzzing pass can reach is not a miss at `medium`. */
    level: z.enum(LEVELS),
    /** Case-insensitive regular expressions tried against a finding's evidence and title. */
    match: z.array(Pattern).min(1),
    /** Phrasings that MUST classify to this entry. The title is always one of them. */
    examples: z.array(z.string()).default([]),
    /** Near misses that must NOT classify to this entry — the other half of each contrastive pair. */
    counterExamples: z.array(z.string()).default([]),
  })
  .strict();

const NonDefect = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** Why it is not a defect, for the reader of a scorecard. */
    why: z.string().min(1),
    match: z.array(Pattern).min(1),
    /**
     * The defects this non-defect is a narrowing of: text that matches both is
     * the false claim, not the defect. Only these. A non-defect that happens to
     * overlap any other entry makes the text ambiguous, because a phrasing
     * nobody anticipated is likelier to be the real defect than the false claim.
     */
    overrides: z.array(z.string()).default([]),
    examples: z.array(z.string()).default([]),
    counterExamples: z.array(z.string()).default([]),
  })
  .strict();

const Key = z
  .object({
    app: z.string().min(1),
    _comment: z.string().optional(),
    /** The defects the app was built to contain. Recall is measured against these. */
    defects: z.array(Entry).min(1),
    /**
     * Real problems a run found that nobody planted. They count as correct for
     * precision but not toward recall, so the number the key was designed around
     * stays comparable from one run to the next.
     */
    alsoReal: z.array(Entry).default([]),
    nonDefects: z.array(NonDefect).default([]),
  })
  .strict();

export type KeyEntry = z.infer<typeof Entry>;
export type KeyNonDefect = z.infer<typeof NonDefect>;
export type AnswerKey = z.infer<typeof Key>;

/**
 * Read and validate a key. A key that fails here fails loudly: a mistyped
 * `"level": "Minimal"` used to drop the defect out of recall with no error,
 * and the run scored as if the app had one defect fewer.
 */
export function parseKey(raw: unknown): AnswerKey {
  const parsed = Key.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The answer key is not valid at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const ids = [...parsed.data.defects, ...parsed.data.alsoReal, ...parsed.data.nonDefects].map((e) => e.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`The answer key uses the id ${JSON.stringify(dup)} twice.`);
  const real = new Set([...parsed.data.defects, ...parsed.data.alsoReal].map((e) => e.id));
  for (const nd of parsed.data.nonDefects) {
    const unknown = nd.overrides.find((id) => !real.has(id));
    if (unknown) throw new Error(`The non-defect ${JSON.stringify(nd.id)} overrides ${JSON.stringify(unknown)}, which is not a defect in the key.`);
  }
  return parsed.data;
}

/** A short, stable fingerprint of a key, so a scorecard says which key produced it. */
export function keyHash(key: AnswerKey): string {
  const canonical = JSON.stringify({ defects: key.defects, alsoReal: key.alsoReal, nonDefects: key.nonDefects });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 10);
}

const RANK: Record<Level, number> = { minimal: 0, medium: 1, extensive: 2 };
const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export type Classified = { kind: "defect" | "alsoReal"; entry: KeyEntry } | { kind: "nonDefect"; entry: KeyNonDefect } | { kind: "ambiguous"; ids: string[] };

function matches(patterns: readonly string[], text: string): boolean {
  return patterns.some((p) => new RegExp(p, "i").test(text));
}

/**
 * What a piece of reported text is, according to the key.
 *
 * A known non-defect can be a deliberate narrowing of a real defect — "the
 * filter is stuck after the Archived 500" names the Archived failure but claims
 * something false about it — so a non-defect wins over the defects it lists in
 * `overrides`, and over nothing else. Anything else that more than one entry
 * claims is AMBIGUOUS, reported, and scored as neither: crediting the first
 * match would quietly count a finding about two defects as one, and letting a
 * non-defect win everywhere turned realistic rewordings of real defects into
 * false positives with a confident explanation beside them.
 */
export function classify(text: string, key: AnswerKey): Classified | null {
  const nd = key.nonDefects.filter((e) => matches(e.match, text));
  const real = [
    ...key.defects.filter((e) => matches(e.match, text)).map((entry) => ({ kind: "defect" as const, entry })),
    ...key.alsoReal.filter((e) => matches(e.match, text)).map((entry) => ({ kind: "alsoReal" as const, entry })),
  ];
  if (nd.length > 1) return { kind: "ambiguous", ids: [...nd, ...real.map((m) => m.entry)].map((e) => e.id) };
  if (nd.length === 1) {
    const rest = real.filter((m) => !nd[0].overrides.includes(m.entry.id));
    if (rest.length === 0) return { kind: "nonDefect", entry: nd[0] };
    return { kind: "ambiguous", ids: [nd[0].id, ...rest.map((m) => m.entry.id)] };
  }
  if (real.length === 1) return real[0];
  if (real.length > 1) return { kind: "ambiguous", ids: real.map((m) => m.entry.id) };
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

/**
 * A key that disagrees with its own examples is wrong before any run is
 * scored. Returns every title or example — non-defects' included — that
 * classifies anywhere but its own entry, and every counter-example that
 * classifies TO its entry.
 */
export function lintKey(key: AnswerKey): string[] {
  const problems: string[] = [];
  const describe = (got: Classified | null): string =>
    got === null ? "nothing" : got.kind === "ambiguous" ? `ambiguous (${got.ids.join(", ")})` : got.entry.id;
  const check = (id: string, kind: string, text: string, want: boolean): void => {
    const got = classify(text, key);
    const hit = got !== null && got.kind !== "ambiguous" && got.kind === kind && got.entry.id === id;
    if (want && !hit) problems.push(`${id}: ${JSON.stringify(text)} classified as ${describe(got)}`);
    if (!want && hit) problems.push(`${id}: counter-example ${JSON.stringify(text)} classified TO it`);
  };
  for (const [kind, list] of [
    ["defect", key.defects],
    ["alsoReal", key.alsoReal],
  ] as const) {
    for (const e of list) {
      for (const t of [e.title, ...e.examples]) check(e.id, kind, t, true);
      for (const t of e.counterExamples) check(e.id, kind, t, false);
    }
  }
  for (const e of key.nonDefects) {
    for (const t of [e.title, ...e.examples]) check(e.id, "nonDefect", t, true);
    for (const t of e.counterExamples) check(e.id, "nonDefect", t, false);
  }
  return problems;
}

export interface Scorecard {
  app: string;
  /** The key that produced this scorecard. Two scorecards with different hashes are not comparable. */
  key: string;
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
  /** Every finding the run filed, including ones it later resolved: it still reported them. */
  findings: number;
  /** Findings matching a planted or also-real defect. */
  correct: number;
  falsePositives: Array<{ id: string; title: string; why: string; severity: string }>;
  /** Findings the key knows nothing about. They need a human label before precision can be final. */
  unknown: Array<{ title: string; severity: string; evidence: string }>;
  /** Findings two key entries both claim. Scored as neither, so the key can be sharpened. */
  ambiguous: Array<{ title: string; ids: string[] }>;
  /**
   * Extra findings for a planted defect that already had one. Counted AFTER the
   * store's own merge, which already folds findings on one failing endpoint
   * together, so this is a floor, not a total.
   */
  duplicates: number;
  /** For each defect found, the filed severity against the key's. */
  severity: { agree: number; higher: number; lower: number; detail: Array<{ id: string; filed: string; key: string }> };
  calibration: KeyCalibration | null;
}

export interface KeyCalibration {
  /** Decisions the key could judge: a verdict about one thing the key names, with a usable confidence. */
  judged: number;
  correct: number;
  /** Not scored, and why. Each is a reason the denominator is smaller than the number of decisions. */
  notInKey: number;
  ambiguous: number;
  badConfidence: number;
  /** An unsure verdict is a request to look closer, not a claim that can be right or wrong. */
  unsure: number;
  /**
   * "Not a defect" said of something the lane dismissed as another lane's —
   * "belongs to the dashboard, out of lane scope". That is a verdict about who
   * owns it, not about whether it is broken, and scoring it as wrong moved the
   * error rate by as much as any change being measured.
   */
  outOfScope: number;
  buckets: Array<{ label: string; decisions: number; stated: number; correct: number }>;
  ece: number;
  /**
   * Mean squared gap between stated confidence and being right (0 is perfect,
   * 0.25 is a coin flip stated as 0.5). Unlike ECE it has no buckets and
   * rewards being right as well as being honest about it, so a run whose
   * lanes were right more often but said so too quietly is not scored as the
   * worse of two.
   */
  brier: number;
}

/**
 * Whether a lane's verdict was right, according to the key.
 *
 * "defect" on a planted or also-real defect is right, and on a known
 * non-defect is wrong. "not_a_defect" is the reverse. An "unsure" verdict, a
 * dismissal as another lane's, a decision the key does not name, and one it
 * names ambiguously are not scored — the same rule the in-product calibration
 * follows, for the same reason.
 */
export function judgeDecision(d: RecordedDecision, key: AnswerKey): boolean | null {
  if (d.verdict === "unsure") return null;
  if (isScopeDismissal(d)) return null;
  const m = classify(decisionText(d), key);
  if (!m || m.kind === "ambiguous") return null;
  const isDefect = m.kind !== "nonDefect";
  return d.verdict === "defect" ? isDefect : !isDefect;
}

/** How a lane says "not mine": the wording lanes actually used, none of it about a particular app. */
const SCOPE_DISMISSAL_RE =
  /out.of.lane.scope|out-of-scope|out of (my|this) (lane|scope)|belongs?.to.{0,20}\b(lane|route|page)\b|belongs-to-|(handled|owned) by (the |another )?[\w-]* ?lane|lane owns it|not (in |on |from |part of )?(my|this) (lane|assigned routes|routes?|pages?)\b|outside (my|this) (lane|routes?|pages?)|not part of my (assigned )?routes/i;

/** A not-a-defect verdict whose stated reason is that the thing is another lane's. */
export function isScopeDismissal(d: Pick<RecordedDecision, "verdict" | "evidence" | "observation">): boolean {
  return d.verdict === "not_a_defect" && SCOPE_DISMISSAL_RE.test(decisionText(d));
}

export function calibrateAgainstKey(decisions: readonly RecordedDecision[], key: AnswerKey): KeyCalibration | null {
  if (decisions.length === 0) return null;
  const buckets = BUCKET_EDGES.map(() => ({ n: 0, conf: 0, right: 0 }));
  const out: KeyCalibration = { judged: 0, correct: 0, notInKey: 0, ambiguous: 0, badConfidence: 0, unsure: 0, outOfScope: 0, buckets: [], ece: 0, brier: 0 };
  for (const d of decisions) {
    if (d.verdict === "unsure") {
      out.unsure += 1;
      continue;
    }
    if (isScopeDismissal(d)) {
      out.outOfScope += 1;
      continue;
    }
    const c = d.confidence;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      out.badConfidence += 1;
      continue;
    }
    const m = classify(decisionText(d), key);
    if (!m) {
      out.notInKey += 1;
      continue;
    }
    if (m.kind === "ambiguous") {
      out.ambiguous += 1;
      continue;
    }
    const right = d.verdict === "defect" ? m.kind !== "nonDefect" : m.kind === "nonDefect";
    out.judged += 1;
    if (right) out.correct += 1;
    out.brier += (c - (right ? 1 : 0)) ** 2;
    const b = buckets[bucketOf(c)];
    b.n += 1;
    b.conf += c;
    if (right) b.right += 1;
  }
  if (out.judged > 0) out.brier /= out.judged;
  buckets.forEach((b, i) => {
    if (b.n === 0) return;
    out.ece += (b.n / out.judged) * Math.abs(b.conf / b.n - b.right / b.n);
    out.buckets.push({ label: bucketLabel(i), decisions: b.n, stated: b.conf / b.n, correct: b.right / b.n });
  });
  return out;
}

/** What scoring needs of a finding. A run archive keeps only this much. */
export type ScoredFinding = Pick<Finding, "title" | "severity"> & { evidence?: string; category?: string };

/**
 * Score one run.
 *
 * `findings` should be the run's own: a project memory accumulates findings
 * across runs, and scoring an accumulated one credits a run with what an
 * earlier run found. Point the scorer at a fresh project directory per run.
 */
export function score(key: AnswerKey, findings: readonly ScoredFinding[], decisions: readonly RecordedDecision[], level: Level = "medium"): Scorecard {
  const hitsByDefect = new Map<string, ScoredFinding[]>();
  const falsePositives: Scorecard["falsePositives"] = [];
  const unknown: Scorecard["unknown"] = [];
  const ambiguous: Scorecard["ambiguous"] = [];
  let correct = 0;

  for (const f of findings) {
    const m = classify(findingText(f), key);
    if (!m) {
      unknown.push({ title: f.title, severity: f.severity, evidence: f.evidence ?? "" });
      continue;
    }
    if (m.kind === "ambiguous") {
      ambiguous.push({ title: f.title, ids: m.ids });
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
    key: keyHash(key),
    level,
    expected: expectedDefects.length,
    found,
    missed,
    judgedNotFiled: [...judged],
    beyondLevel,
    findings: findings.length,
    correct,
    falsePositives,
    unknown,
    ambiguous,
    duplicates,
    severity,
    calibration: calibrateAgainstKey(decisions, key),
  };
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

/**
 * Precision, with its bounds. The labelled ratio leaves unlabelled findings out
 * of the denominator, so on its own it cannot move when a change adds five new
 * false claims nobody has judged yet. The bounds can: the lower one counts
 * every open finding as wrong, the upper one as right.
 */
export function precisionBounds(c: Pick<Scorecard, "correct" | "falsePositives" | "unknown" | "ambiguous" | "findings">): {
  labelled: string;
  low: string;
  high: string;
} {
  const labelled = c.correct + c.falsePositives.length;
  const open = c.unknown.length + c.ambiguous.length;
  return { labelled: `${c.correct}/${labelled} (${pct(c.correct, labelled)})`, low: pct(c.correct, c.findings), high: pct(c.correct + open, c.findings) };
}

/** The scorecard as a person reads it. Leads with the two numbers, then says what each is made of. */
export function formatScorecard(c: Scorecard): string {
  const p = precisionBounds(c);
  const open = c.unknown.length + c.ambiguous.length;
  const lines = [
    `SCORECARD — ${c.app}, level ${c.level}, key ${c.key}`,
    ``,
    `Recall     ${c.found.length}/${c.expected} (${pct(c.found.length, c.expected)}) of the planted defects expected at this level`,
    `Precision  ${p.labelled} of the findings the key can label` +
      (open ? ` — ${open} of ${c.findings} unlabelled, so between ${p.low} and ${p.high} of all findings` : ""),
    ``,
  ];
  if (c.missed.length) lines.push(`Missed: ${c.missed.join(", ")}`);
  if (c.judgedNotFiled.length) lines.push(`Judged a defect in a lane report, never filed: ${c.judgedNotFiled.join(", ")}`);
  if (c.beyondLevel.length) lines.push(`Found above this level's contract: ${c.beyondLevel.join(", ")}`);
  if (c.falsePositives.length) {
    lines.push(``, `False positives (${c.falsePositives.length}):`);
    for (const fp of c.falsePositives) lines.push(`  [${fp.severity}] ${fp.title} — ${fp.why}`);
  }
  if (c.ambiguous.length) {
    lines.push(``, `Ambiguous (${c.ambiguous.length}) — the key claims each twice; sharpen it:`);
    for (const a of c.ambiguous) lines.push(`  ${a.title} (${a.ids.join(" / ")})`);
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
  if (c.duplicates) lines.push(`Duplicates: at least ${c.duplicates} extra finding(s) for a defect that already had one (after the store's own merge)`);
  const k = c.calibration;
  if (k) {
    const skipped = [
      k.notInKey && `${k.notInKey} about things the key does not name`,
      k.ambiguous && `${k.ambiguous} the key names ambiguously`,
      k.badConfidence && `${k.badConfidence} with an unusable confidence`,
      k.unsure && `${k.unsure} unsure`,
      k.outOfScope && `${k.outOfScope} dismissed as another lane's`,
    ].filter(Boolean);
    lines.push(
      ``,
      k.judged === 0
        ? `Lane calibration against the key: nothing the key could judge` + (skipped.length ? ` (${skipped.join(", ")})` : "")
        : `Lane calibration against the key: ${k.correct}/${k.judged} verdicts right (${pct(k.correct, k.judged)}), expected calibration error ${k.ece.toFixed(2)}, Brier ${k.brier.toFixed(3)}` +
            (skipped.length ? ` — not scored: ${skipped.join(", ")}` : ""),
    );
    for (const b of k.buckets)
      lines.push(`  stated ${b.label}: ${b.decisions} decision(s), said ${b.stated.toFixed(2)}, right ${Math.round(b.correct * 100)}%`);
  }
  return lines.join("\n");
}

// ── archiving a run ─────────────────────────────────────────────────────────

/** A run kept for re-scoring: only what scoring reads, so an archive is small and holds nothing a run should not keep. */
export interface RunArchive {
  run: string;
  date: string;
  note: string;
  findings: ScoredFinding[];
  decisions: RecordedDecision[];
}

/**
 * The date a run is archived under. A run's decisions carry the time each was
 * made, so the date defaults to the last of them, and a date given by hand
 * may not be later: `--all` sorts by it, and a run dated after it happened
 * reads as the newer of two in the results log. A run with no decisions has
 * nothing to check against and must be given one.
 */
export function runDate(decisions: readonly Pick<RecordedDecision, "at">[], given?: string): string {
  if (given !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new Error(`The date must be YYYY-MM-DD, not ${JSON.stringify(given)}.`);
  const last = decisions
    .map((d) => d.at)
    .filter((at) => typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at))
    .sort()
    .at(-1)
    ?.slice(0, 10);
  if (!last) {
    if (given === undefined) throw new Error("The run has no timestamped decisions to date it by; give it a date.");
    return given;
  }
  if (given !== undefined && given > last) throw new Error(`The run's last decision was made on ${last}; it cannot be dated ${given}.`);
  return given ?? last;
}

/**
 * Paths into a machine's own directories, which a finding's evidence can pick
 * up from a stack trace or an upload. An archive is committed, and a home
 * directory names a person.
 */
const LOCAL_PATH_RE = /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/private\/tmp|\/tmp|[A-Za-z]:\\Users\\[^\\\s"']+)[^\s"']*/g;

export function sanitize(text: string): string {
  return text.replace(LOCAL_PATH_RE, "<path>");
}

export function toArchive(run: string, date: string, note: string, findings: readonly ScoredFinding[], decisions: readonly RecordedDecision[]): RunArchive {
  return {
    run,
    date,
    note,
    findings: findings.map((f) => ({
      title: sanitize(f.title),
      severity: f.severity,
      ...(f.category ? { category: f.category } : {}),
      ...(f.evidence ? { evidence: sanitize(f.evidence) } : {}),
    })),
    decisions: decisions.map((d) => ({ ...d, observation: sanitize(d.observation), evidence: d.evidence === null ? null : sanitize(d.evidence) })),
  };
}
