/**
 * Measuring the finding-dedup decision against the answer keys, and the
 * model-backed judge the store can ask beside its rule.
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
 * from prose. Measured on these pairs it beat the rule on both apps
 * (docs/benchmark.md), and every pair it won was a merge the rule missed, so
 * the store asks it only about filings the rule keeps apart (DedupJudge,
 * below): a `scenescout ci` run by default, the MCP server when told to.
 * Nothing here touches the network; the caller's `ask` does.
 */
import { createHash } from "node:crypto";
import { archiveApp, classify, findingText, type AnswerKey, type KeyContextual, type KeyEntry, type RunArchive } from "./bench.js";
import { MIN_FOR_A_VERDICT } from "./calibration.js";
import { addUsage, dedupModeFromEnv, judgeKeyConfig, NO_USAGE, type DedupMode, type ResolvedProvider, type ToolSpec, type Usage } from "./ci.js";
import { withWatchdog } from "./dispatch.js";
import { findingId, isDuplicateFinding, titleSimilarity, type DuplicateJudge, type Finding, type FindingInput, type JudgeVerdict } from "./memory.js";
import { obj, type ModelTurn, type ToolCall } from "./provider.js";

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
const pairHash = (p: LabelledPair): string =>
  createHash("sha256")
    .update([p.app, p.route, p.a.run, p.a.title, p.a.evidence ?? "", p.b.run, p.b.title, p.b.evidence ?? ""].join("\n"))
    .digest("hex");

/** A pair's stable id: the same pair gets the same id in every run, and the id carries none of the findings' text. */
export const pairId = (p: LabelledPair): string => pairHash(p).slice(0, 12);

export function samplePairs(pairs: readonly LabelledPair[], cap: number): LabelledPair[] {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`The pair cap must be a positive whole number, not ${cap}.`);
  return pairs
    .map((p) => ({ p, k: pairHash(p) }))
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

/** What a pair's judge and rule read of a finding: what a tester filed. */
export type JudgedFinding = Pick<PairFinding, "title" | "category" | "evidence">;

/** Two findings on one page, the earlier (stored) as `a`. */
export interface JudgedPair {
  route: string;
  a: JudgedFinding;
  b: JudgedFinding;
}

const asStored = (f: JudgedFinding, route: string) => ({ title: f.title, category: f.category, evidence: f.evidence, detail: "", state: route });

/**
 * The store's own rule on a pair, as a judgement: the earlier finding is the
 * stored one, the later the one being filed. It states no probability, so its
 * probability is its verdict, 1 or 0.
 */
export function ruleJudgement(p: JudgedPair): Judgement {
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
      confidence: {
        type: "number",
        minimum: 0.5,
        maximum: 1,
        description: "Probability that your verdict is right, from 0.5 (a coin flip) to 1 (certain). Ignored when the verdict is unsure.",
      },
    },
    required: ["verdict", "confidence"],
    additionalProperties: false,
  },
};

export const JUDGE_SYSTEM =
  "You decide whether two findings filed by exploratory testers of one web app describe the SAME defect or DIFFERENT defects. " +
  "Same: one root cause a single fix would close, however differently it is worded, categorised or evidenced. " +
  "Different: two things a developer would fix separately, even on one page, one control or one endpoint. " +
  "Answer only by calling judge_pair once, with no prose. verdict is same, different or unsure. confidence is your calibrated probability that your verdict is right, " +
  "never below 0.5: near 0.5 when the text can barely tell, near 1 only when it plainly can. " +
  "Example: verdict different with confidence 0.9 means a 10% chance they are one defect. Use unsure only when the findings give too little to go on.";

/** What the judge is shown: the fields a tester filed, nothing from the key. */
export function judgeKickoff(
  route: string,
  a: Pick<PairFinding, "title" | "category" | "evidence">,
  b: Pick<PairFinding, "title" | "category" | "evidence">,
): string {
  const show = (f: typeof a) => ({ title: f.title, category: f.category, evidence: f.evidence ?? "" });
  return `Both findings were filed on the page ${route}.\n\nFinding A: ${JSON.stringify(show(a))}\nFinding B: ${JSON.stringify(show(b))}`;
}

/** Why a judge's answer was not used: it contradicted itself, or it was not a usable answer at all. */
export type JudgeFailure = "contradiction" | "error";

/** What a self-contradicting judge said, kept so a run can show the misreading rather than only count it. */
export interface StatedAnswer {
  verdict: "same" | "different";
  confidence: number;
}

/**
 * Read the judge's one tool call. The judge states its confidence in its own
 * verdict, and the probability that the pair is one defect is derived from the
 * two: same at confidence c is c, different at confidence c is 1 − c. A first
 * run asked for that probability directly, and over half the answers were
 * "different" with a probability of "same" near 1: the field was read as
 * confidence in the verdict. Anything else — no call, another tool, a verdict
 * outside the three, a confidence that is not a number from 0 to 1 — is an
 * error, and a confidence below 0.5 contradicts the verdict it states; neither
 * is a guess at what was meant.
 */
export function parseJudgement(
  turn: Pick<ModelTurn, "calls" | "note">,
): { ok: true; judgement: Judgement } | { ok: false; error: string; failure: JudgeFailure; stated?: StatedAnswer } {
  const call = turn.calls.find((c) => c.name === JUDGE_TOOL.name);
  const error = (e: string) => ({ ok: false as const, error: e, failure: "error" as const });
  if (!call) return error(turn.note ?? `the model did not call ${JUDGE_TOOL.name}`);
  if (call.argsError) return error(call.argsError);
  const input = call.input as { verdict?: unknown; confidence?: unknown } | undefined;
  const verdict = input?.verdict;
  const c = input?.confidence;
  if (verdict !== "same" && verdict !== "different" && verdict !== "unsure")
    return error(`the verdict ${JSON.stringify(verdict)} is not same, different or unsure`);
  if (verdict === "unsure") return { ok: true, judgement: { verdict, pSame: 0.5 } };
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return error(`the confidence ${JSON.stringify(c)} is not a probability`);
  if (c < 0.5)
    return {
      ok: false,
      error: `the verdict ${verdict} contradicts its confidence ${c}, below 0.5`,
      failure: "contradiction",
      stated: { verdict, confidence: c },
    };
  return { ok: true, judgement: { verdict, pSame: verdict === "same" ? c : 1 - c } };
}

/**
 * One model call: a system prompt, tools and a first message in, one turn out.
 * The caller owns the network and the key. `limitMs`, when given, is the
 * longest the call may take, retries included: less than the ask's own limit
 * when the caller has less time left.
 */
export type Ask = (system: string, tools: readonly ToolSpec[], kickoff: string, limitMs?: number) => Promise<ModelTurn>;

export interface Decision {
  duplicate: boolean;
  by: "rule" | "model";
  /** The model's judgement, when it gave a usable one. */
  judgement?: Judgement;
  /** Why the rule decided when a judge was asked: the judge failed, or was unsure. */
  note?: string;
  /** Set when the judge's answer could not be used. */
  failure?: JudgeFailure;
  /** The verdict and confidence of an answer that contradicted itself. */
  stated?: StatedAnswer;
}

/**
 * Decide one pair. With no judge the rule decides, as the store does. With a
 * judge, the model decides when it answers same or different; when it fails
 * for any reason, or is unsure, the rule decides and the note says why, so a
 * run never silently becomes a run of the rule. `ruleVerdict` is the rule's
 * verdict when the caller already has it: the store asks only about pairs its
 * rule keeps apart, and its rule reads more of a finding than a pair carries.
 */
export async function decideDuplicate(p: JudgedPair, ask?: Ask, ruleVerdict?: () => boolean): Promise<Decision> {
  const rule = ruleVerdict ?? ((): boolean => ruleJudgement(p).verdict === "same");
  if (!ask) return { duplicate: rule(), by: "rule" };
  let parsed: ReturnType<typeof parseJudgement>;
  try {
    parsed = parseJudgement(await ask(JUDGE_SYSTEM, [JUDGE_TOOL], judgeKickoff(p.route, p.a, p.b)));
  } catch (err) {
    parsed = { ok: false, error: err instanceof Error ? err.message : String(err), failure: "error" };
  }
  if (!parsed.ok)
    return {
      duplicate: rule(),
      by: "rule",
      failure: parsed.failure,
      ...(parsed.stated ? { stated: parsed.stated } : {}),
      note: `the model judge failed (${parsed.error}); the current rule decided`,
    };
  if (parsed.judgement.verdict === "unsure")
    return { duplicate: rule(), by: "rule", judgement: parsed.judgement, note: "the model judge was unsure; the current rule decided" };
  return { duplicate: parsed.judgement.verdict === "same", by: "model", judgement: parsed.judgement };
}

// ── the judge the store asks ────────────────────────────────────────────────

/** Calls made about one filing at most: its most alike open findings on the page. */
export const JUDGE_MAX_CALLS = 3;
/** The longest one judge call may take. */
export const JUDGE_CALL_MS = 15_000;
/**
 * The longest the judge may spend on one filing, every call together. Under
 * scout_finding's 60-second watchdog, so a slow provider costs a filing its
 * judge and never the filing.
 */
export const JUDGE_FILING_MS = 40_000;
/** Failed calls in a row after which the judge is switched off for the rest of the run. */
export const JUDGE_MAX_FAILURES = 3;
/** The most output one judge call may produce: the answer is one short tool call (24 to 26 tokens when measured). */
export const JUDGE_MAX_OUTPUT_TOKENS = 2_000;
/**
 * The most of a title, and of evidence, the store's judge shows the model. A
 * filing with a pasted log for evidence still makes a question of bounded
 * size, which a client answering the judge accepts (MAX_JUDGE_KICKOFF_CHARS).
 */
export const JUDGE_TITLE_CHARS = 500;
export const JUDGE_EVIDENCE_CHARS = 2_000;

export interface JudgeTally {
  /** Calls made, answered or not. */
  calls: number;
  same: number;
  different: number;
  /** Calls whose answer was unsure or could not be used: the rule decided, and kept the pair apart. */
  fellBack: number;
  /** Filings with more open findings on their page than the judge is asked about. */
  capped: number;
  /** Tokens the calls reported. A judge asked through a CI run's client sees none: that run counts them in its usage. */
  usage: Usage;
  ms: number;
}

const routeOf = (state: string): string => state.split("#")[0];

/** A judge time limit as a log line says it: "15s", or "20ms" for a test's. */
export const durationText = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

/**
 * The model judge as the store asks it (memory.ts DuplicateJudge). It is
 * asked only about a filing the rule keeps apart from everything stored, and
 * only against the open findings on the filing's own page: the most alike
 * title first, at most `maxCalls` of them, within `filingMs`. "Same" merges;
 * anything else (different, unsure, a contradiction, a failed or slow call)
 * leaves the rule's decision, which is to keep the filing apart. So the judge
 * only ever adds merges the rule missed, which is where every pair it won in
 * the measurement was (docs/benchmark.md).
 *
 * Each kind of fall-back is logged once, the cap once per page, and
 * JUDGE_MAX_FAILURES failed calls in a row switch the judge off for the rest
 * of the run. `log` reaches the operator; the caller redacts keys from it.
 */
export class DedupJudge implements DuplicateJudge {
  private readonly counts: JudgeTally = { calls: 0, same: 0, different: 0, fellBack: 0, capped: 0, usage: { ...NO_USAGE }, ms: 0 };
  private failuresInARow = 0;
  private offReason: string | null = null;
  private readonly logged = new Set<string>();
  private readonly maxCalls: number;
  private readonly callMs: number;
  private readonly filingMs: number;
  private readonly now: () => number;
  private readonly redact: (text: string) => string;

  constructor(
    private readonly ask: Ask,
    private readonly o: {
      /** What the judge is, for the report: "openai gpt-6-luna, effort none". */
      label: string;
      log: (line: string) => void;
      /**
       * Applied to every line logged and to the reason the judge was switched
       * off, which the report prints: a provider's error can quote the key it
       * was sent. The server passes its key redaction; the default changes nothing.
       */
      redact?: (text: string) => string;
      maxCalls?: number;
      callMs?: number;
      filingMs?: number;
      now?: () => number;
    },
  ) {
    this.maxCalls = o.maxCalls ?? JUDGE_MAX_CALLS;
    this.callMs = o.callMs ?? JUDGE_CALL_MS;
    this.filingMs = o.filingMs ?? JUDGE_FILING_MS;
    this.now = o.now ?? Date.now;
    this.redact = o.redact ?? ((text) => text);
  }

  /** What the judge has done this run. */
  get tally(): Readonly<JudgeTally> {
    return this.counts;
  }

  /** Why the judge is no longer asked, or null while it is. */
  get off(): string | null {
    return this.offReason;
  }

  async judge(incoming: FindingInput, stored: readonly Readonly<Finding>[]): Promise<JudgeVerdict> {
    try {
      return await this.decide(incoming, stored);
    } catch (err) {
      // decideDuplicate catches whatever a call throws, so this is a fault in this
      // class. It would recur on every filing, so the judge stops here, and says why;
      // the log gets the stack, the report only the message.
      const message = err instanceof Error ? err.message : String(err);
      this.switchOff(`a fault in the judge: ${message}`, err instanceof Error ? err.stack : undefined);
      return null;
    }
  }

  private async decide(incoming: FindingInput, stored: readonly Readonly<Finding>[]): Promise<JudgeVerdict> {
    if (this.offReason) return null;
    const route = routeOf(incoming.state);
    const candidates = stored
      .map((x, i) => ({ x, i, alike: titleSimilarity(x.title, incoming.title) }))
      .filter(({ x }) => x.status !== "resolved" && routeOf(x.state) === route)
      // The most alike first; of two equally alike, the newer.
      .sort((p, q) => q.alike - p.alike || q.i - p.i);
    if (candidates.length > this.maxCalls) {
      this.counts.capped += 1;
      this.once(
        `cap\u0000${route}`,
        `dedup judge: ${candidates.length} open findings on ${route} could be the one just filed there; the judge is asked about the ` +
          `${this.maxCalls} most alike, and the rule, which kept it apart from all of them, decides the rest ` +
          `(at most ${this.maxCalls} calls per filing; logged once per page)`,
      );
    }
    const started = this.now();
    for (const { x } of candidates.slice(0, this.maxCalls)) {
      if (this.offReason) break;
      const left = this.filingMs - (this.now() - started);
      if (left <= 0) {
        this.once("time", `dedup judge: the ${durationText(this.filingMs)} a filing may take ran out; the rule decided the pairs left (logged once)`);
        break;
      }
      const d = await decideDuplicate({ route, a: shown(x), b: shown(incoming) }, this.timed(Math.min(this.callMs, left)), () => false);
      this.count(d);
      if (d.by === "model" && d.duplicate && d.judgement) return { sameAs: x.id, pSame: d.judgement.pSame };
    }
    return null;
  }

  /** The ask, ended at `ms` and counted. */
  private timed(ms: number): Ask {
    return async (system, tools, kickoff) => {
      const started = this.now();
      this.counts.calls += 1;
      try {
        const turn = await withWatchdog<ModelTurn | null>("dedup judge", this.ask(system, tools, kickoff, ms), ms, () => null);
        if (!turn) throw new Error(`no answer within ${durationText(ms)}`);
        this.counts.usage = addUsage(this.counts.usage, turn.usage);
        return turn;
      } finally {
        this.counts.ms += this.now() - started;
      }
    };
  }

  private count(d: Decision): void {
    if (d.by === "model") {
      this.failuresInARow = 0;
      if (d.duplicate) this.counts.same += 1;
      else this.counts.different += 1;
      return;
    }
    this.counts.fellBack += 1;
    if (d.failure !== "error") {
      // Unsure, or an answer that contradicted itself: the provider answered, so neither counts towards switching off.
      this.failuresInARow = 0;
      this.once(d.failure ?? "unsure", `dedup judge: ${d.note ?? "no usable answer"} (later ones are counted, not logged)`);
      return;
    }
    this.failuresInARow += 1;
    this.once("error", `dedup judge: ${d.note ?? "a call failed"} (later failures are counted, not logged)`);
    if (this.failuresInARow >= JUDGE_MAX_FAILURES) this.switchOff(`${this.failuresInARow} failed calls in a row, the last: ${d.note ?? "no detail"}`);
  }

  private switchOff(reason: string, detail?: string): void {
    this.offReason = this.redact(reason);
    this.o.log(this.redact(`dedup judge: switched off after ${reason}; the rule decides every filing for the rest of this run${detail ? `\n${detail}` : ""}`));
  }

  private once(kind: string, line: string): void {
    if (this.logged.has(kind)) return;
    this.logged.add(kind);
    this.o.log(this.redact(line));
  }

  describe(): string | null {
    const t = this.counts;
    if (t.calls === 0 && !this.offReason) return null;
    const tokens = t.usage.input + t.usage.output;
    return (
      `the rule, then the model judge (${this.o.label}) for filings the rule kept apart: ${t.calls} call(s), ` +
      `${t.same} same, ${t.different} different, ${t.fellBack} left to the rule` +
      (t.capped ? `; ${t.capped} filing(s) had more open findings on their page than the ${this.maxCalls} it asks about` : "") +
      (tokens > 0 ? `; ${tokens.toLocaleString("en-US")} tokens` : "") +
      `; ${(t.ms / 1000).toFixed(1)}s` +
      (this.offReason ? `; switched off after ${this.offReason}` : "")
    );
  }
}

/** A finding as the store's judge shows it: what was filed, each field cut to a length the question can carry. */
function shown(f: Pick<Finding, "title" | "category" | "evidence">): JudgedFinding {
  const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);
  return { title: cut(f.title, JUDGE_TITLE_CHARS), category: f.category, ...(f.evidence ? { evidence: cut(f.evidence, JUDGE_EVIDENCE_CHARS) } : {}) };
}

// ── where the server's judge asks ───────────────────────────────────────────

/** What a client says it can do, as far as the judge is concerned (MCP ClientCapabilities). */
export interface JudgeClientCaps {
  sampling?: { tools?: object };
  experimental?: Record<string, object>;
}

/** Whether a client answers the judge's sampling requests: sampling with tools, and DEDUP_JUDGE_CAPABILITY. */
export function clientAnswersJudge(caps: JudgeClientCaps | undefined): boolean {
  return !!caps?.sampling?.tools && !!caps.experimental?.[DEDUP_JUDGE_CAPABILITY];
}

/** How the server dedups a project's filings for a run, and the line the attach reply carries ("" for none). */
export type DedupPlan =
  | { mode: "rule"; note: "" }
  | { mode: "judge"; via: "client"; label: string; note: string }
  | { mode: "judge"; via: "key"; resolved: ResolvedProvider; key: string; label: string; note: string }
  | { mode: "judge"; via: "off"; why: string; note: string };

/**
 * How the MCP server dedups for a run: what an attach of the run named, else
 * DEDUP_ENV. A judge asks through the client when the client answers the
 * judge (a `scenescout ci` run, which holds the key, so the server never
 * does), else with a key from the server's environment; with neither it is
 * off, and the note says why. A malformed DEDUP_ENV or DEDUP_PROVIDER_ENV is
 * refused, naming the variable.
 */
export function planDedup(choice: DedupMode | undefined, env: Record<string, string | undefined>, caps: JudgeClientCaps | undefined): DedupPlan {
  const mode = choice ?? dedupModeFromEnv(env);
  if (mode === "rule") return { mode, note: "" };
  if (clientAnswersJudge(caps)) {
    const label = "the CI run's model";
    return {
      mode,
      via: "client",
      label,
      note: `\nFinding dedup: the rule, then ${label}, asked about a filing the rule keeps apart from everything recorded, against the open findings on its page.`,
    };
  }
  const key = judgeKeyConfig(env);
  if (!key.ok) return { mode, via: "off", why: key.error, note: `\n⚠ DEDUP JUDGE OFF: ${key.error}. The rule decides duplicates.` };
  const { provider, model, effort } = key.resolved;
  const label = `${provider} ${model}, effort ${effort}`;
  return {
    mode,
    via: "key",
    resolved: key.resolved,
    key: key.key,
    label,
    note:
      `\nFinding dedup: the rule, then a model judge (${label}), asked about a filing the rule keeps apart from everything recorded, against the open findings on its page. ` +
      `Each pair it is asked about (titles, categories, evidence and the page's path) is sent to ${provider}.`,
  };
}

// ── the judge through an MCP client ─────────────────────────────────────────

/**
 * The client capability, under `experimental`, by which a client says it
 * answers the dedup judge's sampling requests. `scenescout ci` declares it:
 * the server's judge then asks the run's model through the run, and the key
 * never enters the server's process. No other client is sent a sampling
 * request.
 */
export const DEDUP_JUDGE_CAPABILITY = "scenescout/dedup-judge";

/**
 * The longest question a client answering the judge accepts. The store's judge
 * cuts titles and evidence (JUDGE_TITLE_CHARS, JUDGE_EVIDENCE_CHARS), so its
 * questions always fit; a longer one is refused, and counted as a failed call.
 */
export const MAX_JUDGE_KICKOFF_CHARS = 20_000;

/** The sampling request (MCP sampling/createMessage, with tools) that carries one judge call to the client. */
export function judgeSamplingParams(system: string, tools: readonly ToolSpec[], kickoff: string) {
  return {
    systemPrompt: system,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: kickoff } }],
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { ...t.parameters, type: "object" as const } })),
    toolChoice: { mode: "required" as const },
    maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
    includeContext: "none" as const,
  };
}

/** An Ask that puts the judge's question to the client. `createMessage` is the server's sampling request. */
export function samplingAsk(
  createMessage: (params: ReturnType<typeof judgeSamplingParams>, options: { timeout: number }) => Promise<unknown>,
  callMs = JUDGE_CALL_MS,
): Ask {
  return async (system, tools, kickoff, limitMs) =>
    turnFromSampling(await createMessage(judgeSamplingParams(system, tools, kickoff), { timeout: Math.min(callMs, limitMs ?? callMs) }));
}

/** The client's answer read back as a turn, for parseJudgement. Usage is the client's to count, so the turn carries none. */
export function turnFromSampling(result: unknown): ModelTurn {
  const r = obj(result);
  const content = r ? (Array.isArray(r.content) ? r.content : [r.content]) : [];
  const blocks = content.map(obj).filter((b): b is Record<string, unknown> => b !== null);
  const calls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b, i) => ({ id: typeof b.id === "string" ? b.id : `call_${i}`, name: typeof b.name === "string" ? b.name : "", input: b.input }));
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .trim();
  const note =
    calls.length > 0
      ? undefined
      : r?.stopReason === "maxTokens"
        ? "the model's reply was cut at its output limit"
        : text
          ? `the model answered without calling a tool: ${text.slice(0, 200)}`
          : undefined;
  return { text, calls, usage: { ...NO_USAGE }, ...(note ? { note } : {}) };
}

/**
 * The client's side: the text of a sampling request shaped as the judge's
 * question, checked for shape and size only. A client answering the judge
 * sends this text on as given, under its own JUDGE_SYSTEM, JUDGE_TOOL and
 * output cap, so the server cannot choose the system prompt, the tools or how
 * much the model may write.
 */
export function judgeKickoffOf(params: unknown): { ok: true; kickoff: string } | { ok: false; error: string } {
  const p = obj(params);
  if (!p) return { ok: false, error: "the request has no parameters" };
  const tools = Array.isArray(p.tools) ? p.tools.map(obj) : [];
  if (tools.length !== 1 || tools[0]?.name !== JUDGE_TOOL.name) return { ok: false, error: `the request does not offer exactly the ${JUDGE_TOOL.name} tool` };
  const messages = Array.isArray(p.messages) ? p.messages.map(obj) : [];
  if (messages.length !== 1 || messages[0]?.role !== "user") return { ok: false, error: "the request is not one user message" };
  const content = messages[0].content;
  const blocks = (Array.isArray(content) ? content : [content]).map(obj);
  const text = blocks.length === 1 && blocks[0]?.type === "text" && typeof blocks[0].text === "string" ? blocks[0].text : "";
  if (!text.trim()) return { ok: false, error: "the message is not one block of text" };
  if (text.length > MAX_JUDGE_KICKOFF_CHARS) return { ok: false, error: `the question is longer than ${MAX_JUDGE_KICKOFF_CHARS} characters` };
  return { ok: true, kickoff: text };
}

/** The client's answer: the judge's turn as a sampling result, its tool call as tool_use content. */
export function samplingResultOf(turn: Pick<ModelTurn, "text" | "calls" | "note">, model: string) {
  const content: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "text"; text: string }> = [];
  for (const c of turn.calls) {
    const input = obj(c.input);
    if (input && !c.argsError) content.push({ type: "tool_use", id: c.id, name: c.name, input });
    else content.push({ type: "text", text: `${c.name || "a tool"} was called with arguments that could not be read: ${c.argsError ?? "not an object"}` });
  }
  const said = [turn.text, turn.note].filter((s) => !!s && s.trim()).join("\n");
  if (said) content.push({ type: "text", text: said });
  if (content.length === 0) content.push({ type: "text", text: "(no answer)" });
  return { model, role: "assistant" as const, content, stopReason: content.some((b) => b.type === "tool_use") ? "toolUse" : "endTurn" };
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
