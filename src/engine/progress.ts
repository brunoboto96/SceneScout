/**
 * The progress a person watches while a guided check runs: which phase it is
 * in, one sentence for what is happening now with the few before it, each
 * chosen area's state, pages and time against the plan's limits, problems so
 * far by impact, the newest finding cards, the clicking it saved (always with
 * its basis), and the buttons to offer now.
 *
 * The server builds it on each status poll from what the engine already
 * knows: the plan, the status board's entries for the plan's sessions, the
 * area each session is working on, coverage and the findings. The only state
 * it keeps of its own is a GuidedRun per plan (when the check started, the
 * story so far, the areas started, whether the report was written), held here
 * so its rules are tested too.
 *
 * Every sentence comes from guided-words.ts; nothing here is written by a
 * model. The clicking-saved figure is for the person watching and is never put
 * in a report or a ticket. Nothing here imports Playwright or the MCP SDK, so
 * every rule is table-tested in guided-test (ADR 5), including which file an
 * inline picture may be read from.
 *
 * Design: docs/design/non-technical-assistant.md, sections 2.3, 3.2 and 3.7.
 */
import fs from "node:fs";
import path from "node:path";
import { type CheckArea, type GuidedPlan, MAX_PLANS, PHONE_SESSION } from "./guided.js";
import {
  ACTION_LABEL,
  ACTION_PROMPT,
  AREA_NOT_REACHED,
  CARD_SAYS,
  checkingTitle,
  NEEDS_YOU_SENTENCE,
  NOW_OTHER,
  NOW_SENTENCE,
  PANE_WORDS,
  PHASE_NOW,
  savedBasis,
  savedSentence,
} from "./guided-words.js";
import { isNotABug, isWorthALook, knownFeedback, type Finding } from "./memory.js";
import { decodePng, fitPicture, isPng } from "./png.js";
import { IMPACT, plainCard, type CardImpact, type PlainCard } from "./plain.js";
import { redactSecrets } from "./redact.js";
import { redactPersonal } from "./sensitive.js";

/** A check's phase. `downloading-browser` is in the design's list; the board cannot tell a first attach's download apart yet, so it is not produced. */
export type Phase =
  "starting" | "downloading-browser" | "signing-in" | "exploring" | "checking-phone" | "re-checking" | "writing-report" | "done" | "needs-you" | "stopped";

/** A button either surface can offer. `direct` calls the server; `prompt` starts a turn for the agent with these words. */
export type GuidedAction = { kind: "direct"; label: string; tool: string; args: Record<string, unknown> } | { kind: "prompt"; label: string; text: string };

export interface NeedsYou {
  kind: "sign-in" | "sign-in-expired" | "confirm" | "browser-download-failed" | "server-error" | "address-unreachable" | "stuck";
  sentence: string;
  actions: GuidedAction[];
}

export type AreaState = "waiting" | "in-progress" | "done" | "skipped";

/** A card as the progress shows it: the plain card, and the buttons on it. */
export type GuidedCard = PlainCard & { actions: GuidedAction[] };

/** What the panel and the status pane show while a guided check is going. */
export interface GuidedProgress {
  planId: string;
  /** "Checking staging.example.com". */
  title: string;
  phase: Phase;
  /** One sentence, the narrator's line. */
  now: string;
  /** The last few "now" sentences, oldest first, at most STORY_MAX; the last is `now` while the check runs. */
  story: string[];
  areas: Array<{ area: CheckArea; label: string; state: AreaState; note?: string }>;
  pages: { checked: number; found: number };
  time: { usedMs: number; budgetMs: number };
  problems: { blocksUsers: number; annoying: number; cosmetic: number; worthALook: number };
  /** Newest first, at most LATEST_MAX. */
  latest: GuidedCard[];
  /** Clicking saved, with its basis and the line that says both; null until a page has been checked. */
  saved: null | { minutes: number; basis: string; sentence: string };
  needsYou?: NeedsYou;
  /** The buttons to offer now. */
  next: GuidedAction[];
}

/** How many sentences the story keeps. */
export const STORY_MAX = 5;
/** How many cards the progress carries. */
export const LATEST_MAX = 5;

/** The seconds a person would take to check one page and one control by hand. A rough default: no measurement backs it (design question 12). */
export const CLICKING_RATES = { perPageSeconds: 30, perControlSeconds: 15 } as const;
export type ClickingRates = { perPageSeconds: number; perControlSeconds: number };

/** What the server keeps about one guided check between polls. */
export interface GuidedRun {
  /** When the first session attached with the plan, in ms. */
  startedMs: number;
  /** The last time a session carrying the plan ran a tool, in ms: where the clock stops once no session carries it. */
  lastActiveMs: number;
  story: string[];
  /** The areas sessions said they started (scout_session {area}), in the order first started. */
  areasStarted: CheckArea[];
  /** Whether scout_report wrote the report with a session carrying the plan. */
  reported: boolean;
}

/** The story with a new sentence: added only when it differs from the last, and only the newest STORY_MAX kept. */
export function pushStory(story: readonly string[], sentence: string): string[] {
  if (!sentence || story[story.length - 1] === sentence) return [...story];
  return [...story, sentence].slice(-STORY_MAX);
}

/**
 * The guided checks this server has started, by plan id, and the plan a
 * person is shown: the one built or attached with last. Held in the server
 * process only, like the plans, and capped as they are.
 */
export class GuidedRuns {
  private readonly runs = new Map<string, GuidedRun>();
  private shown: string | null = null;

  /** The plan to show: called when a plan is built, and when a session attaches with one. */
  focus(planId: string): void {
    this.shown = planId;
  }

  get focused(): string | null {
    return this.shown;
  }

  /**
   * A session attached with the plan. `carried`: some session already carried
   * it, so this is the same check (a second session, or signing in again) and
   * its run goes on. Otherwise a new check starts now, with a fresh run: a
   * plan confirmed again after its sessions ended is a new check (ADR 24).
   */
  start(planId: string, nowMs: number, carried = false): void {
    this.focus(planId);
    if (carried && this.runs.has(planId)) return;
    this.runs.delete(planId);
    this.runs.set(planId, { startedMs: nowMs, lastActiveMs: nowMs, story: [], areasStarted: [], reported: false });
    while (this.runs.size > MAX_PLANS) this.runs.delete(this.runs.keys().next().value!);
  }

  /** A session carrying the plan ran a tool: its sentence joins the story. */
  step(planId: string, sentence: string, nowMs: number): void {
    const run = this.runs.get(planId);
    if (!run) return;
    run.story = pushStory(run.story, sentence);
    run.lastActiveMs = Math.max(run.lastActiveMs, nowMs);
  }

  /** A session said it is working on an area. */
  areaStarted(planId: string, area: CheckArea): void {
    const run = this.runs.get(planId);
    if (run && !run.areasStarted.includes(area)) run.areasStarted.push(area);
  }

  /** The report was written with a session carrying the plan. */
  reported(planId: string): void {
    const run = this.runs.get(planId);
    if (run) run.reported = true;
  }

  /** A copy of the run, or undefined when the plan never started. */
  get(planId: string): GuidedRun | undefined {
    const run = this.runs.get(planId);
    return run ? structuredClone(run) : undefined;
  }
}

/** A page's path for a sentence: "/orders", or "the site" when there is none to read. */
export function pageOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "the site";
    return u.pathname || "/";
  } catch {
    return "the site";
  }
}

/**
 * The narrator's line for a session: the task it stated when it has one, else
 * the fixed sentence for its tool on its page. Both can name a person (a task
 * quoting what was typed, a path like /users/<email>), so an email address,
 * phone number or card number in either is redacted, as a finding's text is.
 */
export function nowSentence(tool: string, url: string, task?: string): string {
  if (task?.trim()) return redactPersonal(redactSecrets(task.trim()));
  const line = Object.prototype.hasOwnProperty.call(NOW_SENTENCE, tool) ? NOW_SENTENCE[tool] : NOW_OTHER;
  return line(redactPersonal(pageOf(url)));
}

/** One of the plan's sessions as the progress reads it, from the status board. */
export interface ProgressSession {
  session: string;
  state: "running" | "idle" | "stuck";
  tool: string;
  url: string;
  /** When it entered that state, ISO. */
  since: string;
  task?: string;
  /** The area it said it is working on. */
  area?: CheckArea;
}

/**
 * The phase, from the sessions carrying the plan and the run so far:
 *
 * - not started: needs-you while the plan waits for the person's
 *   confirmation, else starting;
 * - started, and no session carries the plan any more: done when the report
 *   was written, else stopped;
 * - a session stuck past its watchdog: needs-you;
 * - else by what the most recent session is doing: signing in, re-checking,
 *   writing the report, the phone session, done once the report is written
 *   and nothing is running, or exploring.
 */
export function guidedPhase(plan: Pick<GuidedPlan, "confirm">, run: GuidedRun | undefined, sessions: readonly ProgressSession[]): Phase {
  if (!run) return plan.confirm && !plan.confirm.accepted ? "needs-you" : "starting";
  if (sessions.length === 0) return run.reported ? "done" : "stopped";
  if (sessions.some((s) => s.state === "stuck")) return "needs-you";
  const lead = leadSession(sessions)!;
  if (lead.state === "running") {
    if (lead.tool === "scout_login") return "signing-in";
    if (lead.tool === "scout_verify") return "re-checking";
    if (lead.tool === "scout_report") return "writing-report";
  } else if (run.reported) return "done";
  if (lead.session === PHONE_SESSION || lead.area === "phone") return "checking-phone";
  return "exploring";
}

/** The session the narrator follows: a running one before an idle one, then the one whose state began last. */
function leadSession(sessions: readonly ProgressSession[]): ProgressSession | undefined {
  const rank = (s: ProgressSession) => (s.state === "idle" ? 0 : 1);
  return [...sessions].sort((a, b) => rank(b) - rank(a) || (a.since < b.since ? 1 : a.since > b.since ? -1 : 0))[0];
}

/**
 * Each of the plan's areas: in progress while a session says it is working on
 * it (and the report is not yet written), done once a session has moved on
 * from it or the report is written, skipped when the check ended without
 * reaching it, and waiting otherwise. An area the care level holds a step
 * back in carries that sentence as its note while it is in progress or done.
 */
export function areaStates(
  plan: Pick<GuidedPlan, "areas">,
  run: GuidedRun | undefined,
  sessions: readonly ProgressSession[],
  phase: Phase,
): GuidedProgress["areas"] {
  const current = new Set(sessions.map((s) => s.area).filter((a): a is CheckArea => !!a));
  const started = new Set(run?.areasStarted ?? []);
  const ended = phase === "done" || phase === "stopped";
  return plan.areas.map((a) => {
    let state: AreaState;
    if (current.has(a.area) && !ended && !run?.reported) state = "in-progress";
    else if (started.has(a.area)) state = "done";
    else state = ended ? "skipped" : "waiting";
    const note = state === "skipped" ? AREA_NOT_REACHED : state !== "waiting" ? a.heldBack : undefined;
    return { area: a.area, label: a.label, state, ...(note ? { note } : {}) };
  });
}

/** The clicking a check saved, with its basis; null until a page has been checked. */
export function clickingSaved(pages: number, controls: number, rates: ClickingRates = CLICKING_RATES): GuidedProgress["saved"] {
  if (pages <= 0) return null;
  const minutes = Math.round((pages * rates.perPageSeconds + Math.max(0, controls) * rates.perControlSeconds) / 60);
  const basis = savedBasis(pages, Math.max(0, controls), rates);
  return { minutes, basis, sentence: `${savedSentence(minutes)}: ${basis}` };
}

/** The buttons on a card: Not a bug, Explain more and Check again. */
export function cardActions(id: string): GuidedAction[] {
  return [
    { kind: "direct", label: ACTION_LABEL.notABug, tool: "scout_feedback", args: { id, verdict: "not-a-bug" } },
    { kind: "prompt", label: ACTION_LABEL.explain, text: ACTION_PROMPT.explain(id) },
    { kind: "prompt", label: ACTION_LABEL.again, text: ACTION_PROMPT.again(id) },
  ];
}

const SEE_ALL: GuidedAction = { kind: "direct", label: ACTION_LABEL.seeAll, tool: "scout_cards", args: {} };
const STOP: GuidedAction = { kind: "prompt", label: ACTION_LABEL.stop, text: ACTION_PROMPT.stop };

/** The buttons to offer, fixed by phase. */
export function nextActions(phase: Phase): GuidedAction[] {
  switch (phase) {
    case "done":
      return [
        SEE_ALL,
        { kind: "prompt", label: ACTION_LABEL.recheck, text: ACTION_PROMPT.recheck },
        { kind: "prompt", label: ACTION_LABEL.plainReport, text: ACTION_PROMPT.plainReport },
      ];
    case "stopped":
      return [SEE_ALL, { kind: "prompt", label: ACTION_LABEL.plainReport, text: ACTION_PROMPT.plainReport }];
    case "starting":
      return [];
    case "needs-you":
      return [];
    default:
      return [SEE_ALL, STOP];
  }
}

/** What the person is asked for, when the check needs them. */
function needsYouFor(phase: Phase, run: GuidedRun | undefined, planId: string, where: string): NeedsYou | undefined {
  if (phase !== "needs-you") return undefined;
  if (!run)
    return {
      kind: "confirm",
      sentence: NEEDS_YOU_SENTENCE.confirm(where),
      actions: [{ kind: "direct", label: ACTION_LABEL.confirm, tool: "scout_guided_confirm", args: { planId } }],
    };
  return { kind: "stuck", sentence: NEEDS_YOU_SENTENCE.stuck(where), actions: [STOP] };
}

const IMPACT_KEY: Record<CardImpact, keyof GuidedProgress["problems"]> = {
  [IMPACT.high]: "blocksUsers",
  [IMPACT.medium]: "annoying",
  [IMPACT.low]: "cosmetic",
  "Worth a look": "worthALook",
};

/** The findings a check counts as its problems: filed or re-found since it started, still open, and not labelled not a bug by the person. */
export function checkFindings(findings: readonly Finding[], startedMs: number | undefined): Finding[] {
  if (startedMs === undefined) return [];
  const since = new Date(startedMs).toISOString();
  return findings.filter((f) => f.foundAt >= since && f.status !== "resolved" && !isNotABug(f));
}

export interface ProgressInput {
  nowMs: number;
  plan: GuidedPlan;
  /** Undefined until a session attaches with the plan. */
  run: GuidedRun | undefined;
  /** The board's entries for the sessions carrying the plan now. */
  sessions: readonly ProgressSession[];
  /** Pages checked and found, and controls exercised; null before a project is open. */
  coverage: { routesVisited: number; routesTotal: number; elementsExercised: number } | null;
  /** The project's findings. */
  findings: readonly Finding[];
  rates?: ClickingRates;
}

/** The whole progress for one plan. Pure: the server gathers the input on each poll. */
export function guidedProgress(input: ProgressInput): GuidedProgress {
  const { plan, run, sessions } = input;
  let where: string;
  try {
    where = new URL(plan.choices.address).host;
  } catch {
    where = plan.choices.address;
  }
  const phase = guidedPhase(plan, run, sessions);
  const needsYou = needsYouFor(phase, run, plan.planId, where);
  const lead = leadSession(sessions);
  const now =
    needsYou?.sentence ??
    (phase === "starting" || phase === "done" || phase === "stopped"
      ? PHASE_NOW[phase]
      : lead
        ? nowSentence(lead.tool, lead.url, lead.task)
        : PHASE_NOW.starting);
  const story = run ? pushStory(run.story, phase === "done" || phase === "stopped" ? "" : now) : [];
  const counted = checkFindings(input.findings, run?.startedMs);
  const problems = { blocksUsers: 0, annoying: 0, cosmetic: 0, worthALook: 0 };
  for (const f of counted) problems[IMPACT_KEY[isWorthALook(f) ? "Worth a look" : IMPACT[f.severity]]] += 1;
  const latest = [...counted]
    .sort((a, b) => (a.foundAt < b.foundAt ? 1 : a.foundAt > b.foundAt ? -1 : 0))
    .slice(0, LATEST_MAX)
    .map((f): GuidedCard => ({ ...plainCard(f), actions: cardActions(f.id) }));
  const c = input.coverage;
  const progress: GuidedProgress = {
    planId: plan.planId,
    title: checkingTitle(where),
    phase,
    now,
    story,
    areas: areaStates(plan, run, sessions, phase),
    pages: { checked: c?.routesVisited ?? 0, found: c?.routesTotal ?? 0 },
    time: {
      usedMs: run ? Math.max(0, (sessions.length > 0 ? input.nowMs : run.lastActiveMs) - run.startedMs) : 0,
      budgetMs: plan.budget.minutes * 60_000,
    },
    problems,
    latest,
    saved: run && c ? clickingSaved(c.routesVisited, c.elementsExercised, input.rates) : null,
    next: needsYou ? needsYou.actions : nextActions(phase),
  };
  if (needsYou) progress.needsYou = needsYou;
  return progress;
}

/** A card as text, for a client that draws nothing (design 3.3). `pictureFile` is where its picture is on disk, when it has one. */
export function cardText(card: PlainCard, pictureFile?: string): string {
  const where = `on ${card.page}${card.alsoOn.length > 0 ? `, ${CARD_SAYS.alsoOn} ${card.alsoOn.join(", ")}` : ""}`;
  const lines = [`${card.impact.toUpperCase()} - ${card.title}`, `${card.problem} - ${where}`];
  if (card.steps.length > 0) lines.push(`${CARD_SAYS.done} ${card.steps.map((s, i) => `${i + 1}. ${s}`).join("  ")}`);
  lines.push(`${CARD_SAYS.expected} ${card.expected}`, `${CARD_SAYS.happened} ${card.happened}`);
  if (pictureFile) lines.push(`${CARD_SAYS.picture} ${pictureFile}`);
  if (card.feedback)
    lines.push(`${card.feedback.verdict === "not-a-bug" ? CARD_SAYS.notABug : CARD_SAYS.confirmed}${card.feedback.reason ? `: ${card.feedback.reason}` : "."}`);
  lines.push(CARD_SAYS.say(card.id));
  return lines.join("\n");
}

/** The progress as text, for a client that draws no pane: a few lines under the status text. */
export function progressText(p: GuidedProgress): string[] {
  const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m`;
  const mark: Record<AreaState, string> = { waiting: "[ ]", "in-progress": "[..]", done: "[done]", skipped: "[skipped]" };
  const lines = [`${p.title} (${minutes(p.time.usedMs)} of ${minutes(p.time.budgetMs)}). Now: ${p.now}`];
  for (const a of p.areas) lines.push(`  ${mark[a.state]} ${a.label}${a.note ? ` - ${a.note}` : ""}`);
  const pr = p.problems;
  lines.push(
    `  Problems so far: ${pr.blocksUsers} block users, ${pr.annoying} annoying, ${pr.cosmetic} cosmetic${pr.worthALook ? `, ${pr.worthALook} worth a look` : ""}. Pages: ${p.pages.checked} of ${p.pages.found}.`,
  );
  for (const card of p.latest) lines.push(`  - ${card.impact}: ${card.title} (${card.page}, id ${card.id})`);
  if (p.saved) lines.push(`  ${p.saved.sentence}`);
  if (p.needsYou) lines.push(`  ${PANE_WORDS.needsYou} ${p.needsYou.sentence}`);
  return lines;
}

// ---- scout_cards: which findings a person is shown as cards ----

/** The most cards one scout_cards call returns, and how many when no limit is given. */
export const MAX_CARDS = 50;
export const DEFAULT_CARDS = 20;
/** The most pictures one scout_cards call puts in its result. */
export const MAX_INLINE_PICTURES = 10;
/** The longer side an inline picture is shrunk to, in pixels. */
export const INLINE_PICTURE_SIDE = 1024;

/** The most bytes a picture file is read for inline use; a larger one is left as its file. */
export const MAX_PICTURE_FILE_BYTES = 8 * 1024 * 1024;
/** The most bytes one inline picture may take once shrunk. */
export const MAX_INLINE_PICTURE_BYTES = 400 * 1024;

/**
 * A card's picture as an image block, for scout_cards {pictures: "inline"}:
 * read from inside `dir` (the project's .scenescout/) only. An absolute path,
 * a path that climbs out, and a link anywhere along the way that leads out of
 * the folder are all refused, since the folder and the path are compared once
 * every link is resolved. Only a PNG within the size caps is read, shrunk to
 * at most INLINE_PICTURE_SIDE on its longer side. Otherwise, why not.
 */
export function readInlinePicture(
  dir: string,
  file: string,
  caps: { maxFileBytes?: number; maxInlineBytes?: number } = {},
): { image: { type: "image"; data: string; mimeType: "image/png" } } | { why: string } {
  const outside = { why: "its picture is outside the project's folder" };
  try {
    if (path.isAbsolute(file)) return outside;
    const root = fs.realpathSync(dir);
    const full = path.resolve(root, file);
    if (!full.startsWith(root + path.sep)) return outside;
    const real = fs.realpathSync(full);
    if (!real.startsWith(root + path.sep)) return outside;
    if (fs.statSync(real).size > (caps.maxFileBytes ?? MAX_PICTURE_FILE_BYTES)) return { why: "its picture is too large to show here" };
    const bytes = fs.readFileSync(real);
    if (!isPng(bytes)) return { why: "its picture is not a PNG" };
    const fitted = fitPicture(decodePng(bytes), INLINE_PICTURE_SIDE, caps.maxInlineBytes ?? MAX_INLINE_PICTURE_BYTES);
    if (!fitted) return { why: "its picture does not shrink to a readable size" };
    return { image: { type: "image", data: fitted.png.toString("base64"), mimeType: "image/png" } };
  } catch (err) {
    return { why: `its picture could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}

export const CARD_STATUSES = ["open", "fixed", "still-there", "changed"] as const;
export const CARD_IMPACTS = [IMPACT.high, IMPACT.medium, IMPACT.low, "Worth a look"] as const satisfies readonly CardImpact[];
/** The person's label, or "none" for a card without one. */
export const CARD_FEEDBACK = ["not-a-bug", "confirmed", "none"] as const;

export interface CardFilter {
  impact?: readonly CardImpact[];
  area?: readonly CheckArea[];
  status?: readonly PlainCard["status"][];
  feedback?: readonly (typeof CARD_FEEDBACK)[number][];
}

export interface CardSelection {
  cards: PlainCard[];
  /** How many cards matched, before the limit. */
  total: number;
  /** Cards left out only because the person labelled them not a bug; `filter.feedback: ["not-a-bug"]` shows them. */
  notABug: number;
  /** Ids asked for that the project does not hold. */
  missing: string[];
}

const IMPACT_RANK: Record<CardImpact, number> = { [IMPACT.high]: 0, [IMPACT.medium]: 1, [IMPACT.low]: 2, "Worth a look": 3 };

/**
 * The cards to show, worst first and newest first within an impact. With no
 * ids and no filter of their own, fixed findings and the ones the person
 * labelled not a bug are left out (the second are counted, so the person can
 * ask for them: they are kept, never deleted). Naming ids shows exactly those,
 * whatever their status or label, unless a filter says otherwise.
 */
export function selectCards(findings: readonly Finding[], opts: { filter?: CardFilter; ids?: readonly string[]; limit?: number } = {}): CardSelection {
  const filter = opts.filter ?? {};
  const byIds = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;
  const missing = byIds ? [...byIds].filter((id) => !findings.some((f) => f.id === id)) : [];
  const status = filter.status ?? (byIds ? undefined : CARD_STATUSES.filter((s) => s !== "fixed"));
  const feedback = filter.feedback ?? (byIds ? undefined : (["confirmed", "none"] as const));
  let notABug = 0;
  const matched: PlainCard[] = [];
  for (const f of findings) {
    if (byIds && !byIds.has(f.id)) continue;
    const card = plainCard(f);
    if (filter.impact && !filter.impact.includes(card.impact)) continue;
    if (filter.area && !(card.area && filter.area.includes(card.area))) continue;
    if (status && !status.includes(card.status)) continue;
    const label = card.feedback?.verdict ?? "none";
    if (feedback && !feedback.includes(label)) {
      if (label === "not-a-bug" && !filter.feedback) notABug += 1;
      continue;
    }
    matched.push(card);
  }
  matched.sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0));
  const limit = Math.max(1, Math.min(MAX_CARDS, Math.floor(opts.limit ?? DEFAULT_CARDS)));
  return { cards: matched.slice(0, limit), total: matched.length, notABug, missing };
}

/** One label as a candidate for a maintainer: never an answer-key or dedup entry by itself (design question 9). */
export interface FeedbackCandidate {
  findingId: string;
  verdict: "not-a-bug" | "confirmed";
  reason?: string;
  at: string;
  /** What a maintainer would add it as, after review: a non-defect for "not a bug", a defect for "confirmed". */
  suggests: "non-defect" | "defect";
  title: string;
  category: string;
  severity: Finding["severity"];
  route: string;
  evidence?: string;
}

/** Every label in the project, newest first, as candidates for a maintainer to review. */
export function feedbackCandidates(findings: readonly Finding[]): FeedbackCandidate[] {
  return findings
    .map((f) => ({ f, feedback: knownFeedback(f) }))
    .filter((x): x is { f: Finding; feedback: NonNullable<Finding["feedback"]> } => !!x.feedback)
    .map(({ f, feedback }) => ({
      findingId: f.id,
      verdict: feedback.verdict,
      ...(feedback.reason ? { reason: feedback.reason } : {}),
      at: feedback.at,
      suggests: feedback.verdict === "not-a-bug" ? ("non-defect" as const) : ("defect" as const),
      title: f.title,
      category: f.category,
      severity: f.severity,
      route: f.state.split("#")[0],
      ...(f.evidence ? { evidence: f.evidence } : {}),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
