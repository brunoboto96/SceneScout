/**
 * The lane report: what an agent exploring one area in parallel hands back to
 * the agent that split the work, as typed decisions rather than prose.
 *
 * A parallel run has one planning agent and several lanes, each driving its
 * own browser. A lane used to come back with a page of markdown, which the
 * planner then had to read, re-judge and re-type into findings: a model pass
 * over every lane's output, with nothing stopping a lane from inventing a
 * category or writing "Low-Medium" as a severity.
 *
 * This module is the alternative, borrowed from decision-only models: every
 * answer is a value from a closed set, carries a calibrated confidence, and
 * is checked by a schema on arrival. The planner folds a report with a
 * function call, not a reading.
 *
 * Both halves are reached through the scout_lane_report tool: with no reply
 * it returns the instruction the planner puts in a lane's prompt, with one it
 * parses it. The instruction is generated from the same constants the parser
 * checks, and a table test asserts every value and every cap the parser
 * enforces is in the text, because a limit the lane is not told refuses good
 * replies: three of the first ten real replies were lost that way.
 *
 * Pure logic, no browser, so every rule here is table-tested.
 */
import { z } from "zod";
import { isIdSegment } from "./fingerprint.js";
import { FINDING_CATEGORIES } from "./memory.js";

/** Upper bound on the decisions and routes arrays, so a report is always small enough to hold whole. */
export const LANE_MAX_ITEMS = 255;
/** A signature such as "GET /api/things 500", not a sentence. */
export const LANE_EVIDENCE_MAX = 160;
/** A lane names its own observations, and a name that says what was seen needs more than forty characters. */
export const LANE_OBSERVATION_MAX = 64;
/** One line saying what blocked the lane; the detail belongs in a finding. */
export const LANE_BLOCKED_BY_MAX = 200;
/** The planner chooses the lane name, so this cap is on the planner's side; it is stated all the same. */
export const LANE_NAME_MAX = 40;
/** A route as the lane saw it, query string included. */
export const LANE_ROUTE_MAX = 200;

export const LANE_SEVERITIES = ["high", "medium", "low"] as const;
/** The same set scout_finding accepts, so a lane can report every finding it filed. */
export const LANE_CATEGORIES = FINDING_CATEGORIES;
export const LANE_VERDICTS = ["defect", "not_a_defect", "unsure"] as const;
export const LANE_STATUSES = ["complete", "partial", "blocked"] as const;

const Confidence = z.number().min(0).max(1);

/**
 * One observation judged: is it a defect, how bad, of what kind, and how sure
 * the lane is. A non-defect may still carry a category and a signature: an
 * "unsure" with a tentative category tells the planner where to look.
 */
export const LaneDecision = z
  .object({
    /** A short id the lane assigns, unique within the report, so a decision can be traced back to what the lane saw. */
    observation: z.string().min(1).max(LANE_OBSERVATION_MAX),
    verdict: z.enum(LANE_VERDICTS),
    severity: z.enum(LANE_SEVERITIES).nullable(),
    category: z.enum(LANE_CATEGORIES).nullable(),
    confidence: Confidence,
    /** The same machine signature scout_finding takes as its cross-run dedup key. */
    evidence: z.string().min(1).max(LANE_EVIDENCE_MAX).nullable(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.verdict === "defect" && (d.severity === null || d.category === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a defect needs a severity and a category" });
    }
  });

export const LaneReport = z
  .object({
    lane: z.string().min(1).max(LANE_NAME_MAX),
    status: z.enum(LANE_STATUSES),
    decisions: z.array(LaneDecision).max(LANE_MAX_ITEMS),
    /** The routes the lane covered, as it saw them; the planner normalises when it compares them with the split. */
    routes: z.array(z.string().min(1).max(LANE_ROUTE_MAX)).max(LANE_MAX_ITEMS),
    /** Required when the status is "blocked"; a "partial" lane may use it to say what cut it short; a "complete" one has nothing to put there. */
    blocked_by: z.string().min(1).max(LANE_BLOCKED_BY_MAX).nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.status === "blocked" && r.blocked_by === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a blocked lane must say what blocked it", path: ["blocked_by"] });
    }
    if (r.status === "complete" && r.blocked_by !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a complete lane cannot also have been blocked", path: ["blocked_by"] });
    }
    const seen = new Set<string>();
    r.decisions.forEach((d, i) => {
      if (seen.has(d.observation)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `observation "${d.observation}" is judged twice`, path: ["decisions", i, "observation"] });
      }
      seen.add(d.observation);
    });
  });

export type LaneDecision = z.infer<typeof LaneDecision>;
export type LaneReport = z.infer<typeof LaneReport>;

/**
 * `aroundIgnored`: the object came from the reply's one fenced block, and the text around it was dropped unread.
 * `entitiesDecoded`: how many HTML character references in its string values were decoded.
 */
export type LaneParse = { ok: true; report: LaneReport; aroundIgnored: boolean; entitiesDecoded: number } | { ok: false; reason: string };

const FENCE_OPEN = /^```[a-z]*\s*\r?\n/i;
const FENCE_CLOSE = /\r?\n?```\s*$/;
/** Every fenced block in a reply, with its contents. */
const FENCED_BLOCK = /```[a-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

/**
 * The reply is one JSON object and nothing else. A fenced block around it is
 * tolerated, because every model has been trained to add one.
 *
 * Prose around ONE fenced JSON block is tolerated too, and dropped unread. The
 * rule used to refuse it, and in a measured run six of eight lanes did it
 * anyway: each refusal cost the planner a round trip or a hand-unwrap, to
 * recover an object that was already unambiguous. The point — nobody has to
 * READ the reply — survives, because the prose is never looked at. Unfenced
 * prose is still refused, because where the object starts and ends is then a
 * guess, and so is more than one fenced object.
 * The reason names what was wrong, since the planner relays it to the lane.
 *
 * With `expectedLane`, a report that names another lane is refused: the
 * planner joins reports to the split by name, and a reply that carries the
 * wrong one would be folded into the wrong lane.
 */
export function parseLaneReport(text: string, expectedLane?: string): LaneParse {
  let body = text.trim();
  let aroundIgnored = false;
  if (FENCE_OPEN.test(body) && FENCE_CLOSE.test(body) && [...body.matchAll(FENCED_BLOCK)].length === 1) {
    body = body.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
  } else if (!body.startsWith("{")) {
    const objects = [...body.matchAll(FENCED_BLOCK)].map((m) => m[1].trim()).filter((b) => b.startsWith("{"));
    if (objects.length > 1) return { ok: false, reason: `the reply holds ${objects.length} fenced JSON blocks; hand back exactly one object` };
    if (objects.length === 0) return { ok: false, reason: "the reply must be one JSON object, with no text before it" };
    body = objects[0];
    aroundIgnored = true;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    const message = (e as Error).message;
    const trailing = /after JSON|Unexpected non-whitespace/i.test(message);
    return { ok: false, reason: trailing ? "the reply must be one JSON object, with no text after it" : `not valid JSON: ${message}` };
  }
  // Decoded before the schema, so every cap measures the text the lane wrote.
  // Only a reply that looks relay-escaped is decoded: one holding a literal
  // `<` or `>` was not escaped on the way, and its `&amp;` is what the lane
  // meant (a page that double-escapes its text is a defect a lane can report).
  const decoded = /[<>]/.test(text) ? { value: raw, count: 0 } : decodeStringValues(raw);
  const result = LaneReport.safeParse(decoded.value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue.path.length ? ` at ${issue.path.join(".")}` : "";
    return { ok: false, reason: `${issue.message}${at}` };
  }
  if (expectedLane !== undefined && result.data.lane !== expectedLane) {
    return { ok: false, reason: `the report names lane "${result.data.lane}", but this reply was asked of lane "${expectedLane}"` };
  }
  return { ok: true, report: result.data, aroundIgnored, entitiesDecoded: decoded.count };
}

/**
 * The HTML character references a relay adds when it escapes text: the five
 * named ones an escaper emits, and decimal or hex numeric ones. Anything else
 * that looks like a reference (`&nbsp;`, `&#0;`, a bare `&`) is left as it is.
 */
const CHAR_REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;
const NAMED_REFERENCES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/**
 * One pass over the text, so each reference is decoded exactly once:
 * `&amp;lt;` becomes `&lt;`, not `<`, because the `&` a match produces is
 * never scanned again.
 */
function decodeReferences(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(CHAR_REFERENCE, (whole, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) {
      count += 1;
      return NAMED_REFERENCES[name];
    }
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    // NUL, surrogates and anything past the last code point are not characters a relay escaped.
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    count += 1;
    return String.fromCodePoint(code);
  });
  return { text: out, count };
}

/**
 * A planner relaying a lane's reply often HTML-escapes it, so `->` arrives as
 * `-&gt;` and no longer matches the finding filed with the same evidence.
 * Decoded in string VALUES only, after JSON.parse: JSON's own syntax contains
 * no `<`, `>` or `&`, so an escaper can only have touched it by turning its
 * quotes into `&quot;`, and that reply does not parse at all; it is refused
 * as invalid JSON rather than repaired. Keys are a fixed set of plain words
 * and are left alone.
 */
function decodeStringValues(value: unknown): { value: unknown; count: number } {
  if (typeof value === "string") {
    const d = decodeReferences(value);
    return { value: d.text, count: d.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => {
      const d = decodeStringValues(v);
      count += d.count;
      return d.value;
    });
    return { value: out, count };
  }
  if (value !== null && typeof value === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const d = decodeStringValues(v);
      count += d.count;
      out[k] = d.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/** The line the fold adds when the parse decoded references, so a reader knows the tool changed the text; empty when it did not. */
export function decodedEntitiesNote(count: number): string {
  if (count === 0) return "";
  const what = count === 1 ? "1 HTML character reference" : `${count} HTML character references`;
  return `\n(${what} in the report ${count === 1 ? "was" : "were"} decoded once, as a relay that escapes text would have added ${count === 1 ? "it" : "them"}.)`;
}

/**
 * The paragraph the planner puts in every lane's prompt. It is generated from
 * the same constants the parser checks, so it can never list a value the
 * parser would refuse, and it states every cap the parser enforces.
 */
export function laneReportInstruction(lane: string): string {
  return [
    ...LANE_RUBRIC,
    // The ONLY lane-specific sentence, and it comes last on purpose. Every
    // lane in a wave is given the same rubric, so keeping it byte-identical up
    // to here makes it one shared prompt prefix: the cache hits from the
    // second lane onward instead of diverging at the first sentence, which is
    // what putting the name in the shape line used to do.
    `Your lane name is ${JSON.stringify(lane)}; put exactly that in "lane".`,
  ].join(" ");
}

/**
 * Everything every lane is told, identical for all of them. Built once from
 * the same constants the parser enforces, because a limit a lane is not told
 * refuses good replies.
 */
const LANE_RUBRIC: readonly string[] = [
  "Reply with ONE JSON object and nothing else — no prose before or after it, no explanation, no headings. A fenced ```json block is fine; anything outside it is discarded unread, so put nothing there you want kept.",
  `Shape: {"lane":<your lane name>,"status":<${quoteAll(LANE_STATUSES)}>,"decisions":[…],"routes":[…],"blocked_by":<string or null>}.`,
  `Each decision: {"observation":<a short id for what was observed, unique in the report, at most ${LANE_OBSERVATION_MAX} characters>,"verdict":<${quoteAll(LANE_VERDICTS)}>,"severity":<${quoteAll(LANE_SEVERITIES)} or null>,"category":<${quoteAll(LANE_CATEGORIES)} or null>,"confidence":<0..1>,"evidence":<machine signature such as "GET /api/things 500", or null>}.`,
  `A "defect" must carry a severity and a category. "evidence" is a signature, not a sentence: at most ${LANE_EVIDENCE_MAX} characters. "confidence" is how sure you are of the verdict, calibrated: 0.5 means a coin flip, 0.95 means you would bet on it.`,
  `"routes" lists the routes you covered, each at most ${LANE_ROUTE_MAX} characters. "blocked_by" is one line of at most ${LANE_BLOCKED_BY_MAX} characters saying what stopped you: required when the status is "blocked", allowed with "partial", null with "complete"; the detail belongs in a finding. The lane name is at most ${LANE_NAME_MAX} characters. At most ${LANE_MAX_ITEMS} decisions and ${LANE_MAX_ITEMS} routes. Unknown keys are refused.`,
  "The object IS your final report: whatever hands it back must hand back the object verbatim, not a summary of it.",
];

function quoteAll(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join("|");
}

/** The planner's fold: one line per lane, with the numbers it decides on. */
export function summarizeLaneReport(r: LaneReport): string {
  const defects = r.decisions.filter((d) => d.verdict === "defect");
  const high = defects.filter((d) => d.severity === "high").length;
  const unsure = r.decisions.filter((d) => d.verdict === "unsure").length;
  const mean = r.decisions.length ? r.decisions.reduce((s, d) => s + d.confidence, 0) / r.decisions.length : 0;
  const parts = [
    r.status,
    `${r.decisions.length} judged`,
    `${defects.length} defects (${high} high)`,
    `${unsure} unsure`,
    `mean confidence ${mean.toFixed(2)}`,
    `${r.routes.length} routes`,
  ];
  if (r.blocked_by) parts.push(`blocked by ${r.blocked_by}`);
  return `${r.lane}: ${parts.join(", ")}`;
}

/**
 * A request named in evidence: its method, its path split into segments, and
 * the status written directly after it, as in `POST /api/things/7/archive 200`.
 * `start` and `end` locate the path as written, so a caller can put another
 * text's path in its place.
 */
export interface StatedRequest {
  method: string;
  segments: string[];
  status: string | null;
  start: number;
  end: number;
}

/**
 * Method, optional origin, path (template characters included), optional query
 * and fragment, then a status only when it comes next: after an arrow or a
 * colon, or after spaces, and nothing else. A status further along
 * ("... (expected 403)") is a different claim about the request and is not
 * read as its status.
 *
 * The separator is two alternatives rather than `\s*(?:->|:)?\s*`: with the
 * arrow optional, two adjacent `\s*` can split a run of spaces every way
 * there is, and evidence ending in a long run of whitespace took quadratic
 * time to reject.
 */
const STATED_REQUEST_RE =
  /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/[A-Za-z0-9/_.:{}$*~%-]*)(?:\?[^\s#]*)?(?:#\S*)?(?:(?:\s*(?:->|→|=>|:)\s*|\s+)([1-5]\d{2})\b)?/gi;

/** The requests a piece of evidence names, in order. */
export function statedRequests(text: string): StatedRequest[] {
  const out: StatedRequest[] = [];
  for (const m of text.matchAll(STATED_REQUEST_RE)) {
    const raw = m[2].replace(/[.:,]+$/, "");
    const start = (m.index ?? 0) + m[0].indexOf(m[2]);
    out.push({ method: m[1].toUpperCase(), segments: pathSegments(raw), status: m[3] ?? null, start, end: start + raw.length });
  }
  return out;
}

function pathSegments(path: string): string[] {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return [];
  return trimmed
    .slice(1)
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg).toLowerCase();
      } catch {
        return seg.toLowerCase();
      }
    });
}

/**
 * A path-template segment: `{name}`, `:name` or `*`. Whole segments only —
 * `order-{id}` is a literal, and so is `**`, which some routers read as "any
 * number of segments": a template here stands for exactly one.
 */
export function isTemplateSegment(seg: string): boolean {
  return seg === "*" || /^\{[^/{}]+\}$/.test(seg) || /^:[a-z_][a-z0-9_-]*$/i.test(seg);
}

/**
 * Whether two paths name the same route. A template segment on either side
 * stands for ONE segment that is an id by route identity's own rule
 * (`isIdSegment`: a number after the first segment, a UUID, a long hex
 * string), or for another template. Never for a word: `/users/{id}` is not
 * `/users/me`, `/things/:id` is not `/things/export`, and a path of three stars does
 * not stand for every three-segment path. Same number of segments, every literal
 * equal (case-insensitive), so a template never absorbs a slash or an empty
 * segment.
 */
export function templatedPathsMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  // +1: segments start at the first real one; isIdSegment counts as split("/") does.
  const standsFor = (seg: string, i: number) => isTemplateSegment(seg) || isIdSegment(seg, i + 1);
  return a.every((x, i) => {
    const y = b[i];
    if (isTemplateSegment(x)) return standsFor(y, i);
    if (isTemplateSegment(y)) return standsFor(x, i);
    return x === y;
  });
}

/**
 * Whether two stated requests are the same call: same method, same route with
 * a template read as an id (see templatedPathsMatch), and the same status — both stated and equal, or
 * both unstated. A different status is a different outcome of the call, and
 * pairing a 200 with a 403 would file one claim under its opposite.
 */
export function requestsPair(a: StatedRequest, b: StatedRequest): boolean {
  return a.method === b.method && a.status === b.status && templatedPathsMatch(a.segments, b.segments);
}

/**
 * Which sessions are lanes of a parallel run, and whether each one's report
 * has been folded, so a lane's session is not closed before its decisions
 * have somewhere to go.
 *
 * Folding a report writes its decisions to the lane's own session's project
 * memory. Closing that session first leaves nothing to write to: a planner
 * that closes a lane whose fold was just refused (a cap exceeded, say) and
 * then re-sends the corrected object loses every decision in it.
 *
 * A session counts as a lane only when something in this run named it as
 * one: scout_lane_brief listed it, scout_lane_report issued its instruction,
 * or a reply was folded (accepted or refused) under its name while that
 * session was attached. Nothing is inferred from other lanes' activity: the
 * planner's own session is not a lane, and a single-session run never names
 * one, so neither is ever refused a close by this. The ledger belongs to one
 * run: the server clears it when the last session closes, because lane names
 * are module names and a later run may well attach a role with one of them.
 */
export class LaneLedger {
  private readonly named = new Set<string>();
  private readonly refused = new Set<string>();
  private readonly folded = new Set<string>();

  /** An instruction named this session as a lane. */
  name(lane: string): void {
    this.named.add(lane);
  }

  /**
   * A brief's lanes. One whose name is a session already live is skipped:
   * that session was attached before the split existed, so it is the
   * planner's own (or another role's), not a lane waiting to report.
   */
  nameBriefed(lanes: readonly string[], isLive: (session: string) => boolean): void {
    for (const lane of lanes) if (!isLive(lane)) this.named.add(lane);
  }

  /**
   * A reply for this lane was refused: it is a lane, and nothing it decided is
   * kept yet. Only while its session is attached: a reply for a session that
   * is gone says nothing about a later session given the same name.
   */
  refuse(lane: string, attached: boolean): void {
    if (!attached) return;
    this.named.add(lane);
    if (!this.folded.has(lane)) this.refused.add(lane);
  }

  /** A reply for this lane was accepted. Only while its session is attached, for the same reason. */
  fold(lane: string, attached: boolean): void {
    if (!attached) return;
    this.named.add(lane);
    this.folded.add(lane);
    this.refused.delete(lane);
  }

  /** The session closed: a later session with the same name is a fresh lane. */
  forget(lane: string): void {
    this.named.delete(lane);
    this.refused.delete(lane);
    this.folded.delete(lane);
  }

  clear(): void {
    this.named.clear();
    this.refused.clear();
    this.folded.clear();
  }

  state(lane: string): "not-a-lane" | "folded" | "refused" | "unfolded" {
    if (!this.named.has(lane)) return "not-a-lane";
    if (this.folded.has(lane)) return "folded";
    return this.refused.has(lane) ? "refused" : "unfolded";
  }
}

export type CloseGuard = { ok: true } | { ok: false; unfolded: string[]; message: string };

/**
 * Whether scout_close may close these sessions. Refused only when one of them
 * is a lane whose report has not been accepted; `force` closes anyway. The
 * message names every such lane and the two ways on.
 */
export function laneCloseGuard(sessions: readonly string[], ledger: LaneLedger, force = false): CloseGuard {
  if (force) return { ok: true };
  const pending = sessions.filter((s) => ledger.state(s) === "refused" || ledger.state(s) === "unfolded");
  if (pending.length === 0) return { ok: true };
  const one = pending.length === 1;
  const lines = pending.map((s) =>
    ledger.state(s) === "refused"
      ? `  · ${JSON.stringify(s)}: its last report was REFUSED and no corrected one has been accepted`
      : `  · ${JSON.stringify(s)}: no report from it has been accepted yet`,
  );
  const others = sessions.filter((s) => !pending.includes(s));
  const message =
    `Not closed: ${one ? "this session is a lane" : `${pending.length} sessions are lanes`} of a parallel run whose report has not been folded.\n` +
    lines.join("\n") +
    `\nFolding keeps a lane's decisions in its own session's project memory and checks its defects were filed; closing the session first loses them. ` +
    `Fold with scout_lane_report { lane, reply } (for a refused report, the lane's corrected object), then close. ` +
    `To close anyway and lose ${one ? "that lane's" : "those lanes'"} decisions, pass force: true.` +
    (others.length > 0
      ? `\nThe other session(s) can be closed one by one by name meanwhile: ${others.map((s) => `scout_close { session: ${JSON.stringify(s)} }`).join(", ")}.`
      : "");
  return { ok: false, unfolded: pending, message };
}
