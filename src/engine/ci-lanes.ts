/**
 * Lanes for `scenescout ci` (--lanes): the app split between several model
 * loops that explore at once, each in its own browser session and its own
 * part of the app, drawing on the run's one budget, with their findings folded
 * into the one report. This file holds the rules, none of which needs a
 * browser or a network: which routes the planning crawl found, how they are
 * split (brief.ts, the split scout_lane_brief makes), what each lane is told,
 * and how the lanes' endings become the run's. The loop that runs them is
 * src/ci-run.ts; the shared budget is engine/ci.ts's. Why: ADR 20.
 */
import { LANE_RULES, planLanes, type LaneBrief } from "./brief.js";
import type { ScheduleInput } from "./schedule.js";
import { CI_TOOLS, type Caps, type CiLevel, type CiMode, type StopReason } from "./ci.js";

/** The session the run attaches first. It plans, holds no lane, and writes the report once every lane is done. */
export const PLANNER_SESSION = "default";

/** Crawls the planning step makes at most: each visits the routes the pages of the one before linked to. */
export const PLAN_CRAWL_ROUNDS = 3;

/** The most routes a lane's first message lists, and the most crawl lines it is handed. */
const LIST_MAX = 40;

/**
 * A lane's tools: an exploring run's, less scout_report. The run writes one
 * report for every lane once all are done; a lane that wrote its own would
 * report the others' work as unfinished.
 */
export const LANE_TOOLS: readonly string[] = CI_TOOLS.filter((t) => t !== "scout_report");

// ── what the planning crawl found ───────────────────────────────────────────

/**
 * A route line of a scout_crawl result: `<path> — <status> · <n> el …`, or
 * `<path> — LOAD FAILED`. The path is what the crawl visited, as the browser
 * opened it.
 */
const CRAWL_LINE = /^(\/\S*) — (.+)$/;

/** The heading of the crawl's problem list, whose entries name a route and say what is wrong on it. */
const PROBLEMS_HEADING = /^PROBLEM ROUTES \(\d+\):$/;

/** A problem entry's first line: the route, then ` → …`, `: <why it did not load>`, or nothing (its detail lines follow, indented). */
const PROBLEM_LINE = /^(\/\S*?)(?: →.*|: .*)?$/;

/**
 * What a scout_crawl result says about each route it visited: the route's own
 * line, then whatever its problem list says about it. Routes it skipped as
 * off-origin are not the app's, and are left out.
 */
export function crawlNotes(text: string): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  const add = (route: string, line: string): void => {
    const list = notes.get(route);
    if (list) list.push(line);
    else notes.set(route, [line]);
  };
  let inProblems = false;
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (PROBLEMS_HEADING.test(line)) {
      inProblems = true;
      continue;
    }
    if (!inProblems) {
      const m = CRAWL_LINE.exec(line);
      if (m && !/^SKIPPED/.test(m[2])) add(m[1], line);
      continue;
    }
    if (line === "") {
      // A blank line ends the entry it follows, not the list.
      current = null;
      continue;
    }
    if (!/^(\/|\s)/.test(line)) {
      // A line that is neither a route nor a detail (the coverage line) ends the list.
      inProblems = false;
      current = null;
      continue;
    }
    if (/^\s/.test(line)) {
      if (current) add(current, line);
      continue;
    }
    const p = PROBLEM_LINE.exec(line);
    current = p && notes.has(p[1]) ? p[1] : null;
    if (current) add(current, line);
  }
  return notes;
}

/** Whether a crawl had nothing left to visit, so another round would find nothing either. */
export function crawlFoundNothing(text: string): boolean {
  return /^(?:\[session [^\]]*\]\s*)?(Nothing to crawl|Nothing new to crawl|No routes to crawl yet)/m.test(text);
}

// ── the split ───────────────────────────────────────────────────────────────

export interface CiLane extends LaneBrief {
  /** The session it attaches and acts in: unique, and never the planner's. */
  session: string;
  /** Its landing route as a full URL on the target's origin: where the run sends it once it has attached on the target. */
  url: string;
  /** What the planning crawl said about its routes, bounded. */
  crawl: string[];
}

export interface LanePlan {
  lanes: CiLane[];
  /** Set when there is nothing to split, so the run explores in one loop: why. */
  oneLoop?: string;
}

/** The routes a run has to plan with: the page it attached on, then every route the planning crawl listed. */
export function plannedRoutes(target: string, notes: ReadonlyMap<string, readonly string[]>): string[] {
  return [...new Set([routeOf(target), ...notes.keys()])];
}

/** The path a target URL opens, as a route: the planning crawl never lists the page the run attached on. */
function routeOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

/**
 * Session names for the lanes: the lane's own name, unless another lane or the
 * planner already has it. A session name is at most 40 characters.
 */
export function laneSessions(names: readonly string[]): string[] {
  const taken = new Set<string>([PLANNER_SESSION]);
  return names.map((name, i) => {
    let session = name;
    for (let k = i + 1; taken.has(session); k += 1) session = `${name.slice(0, 40 - `-${k}`.length)}-${k}`;
    taken.add(session);
    return session;
  });
}

/**
 * Split what the planning crawl found between `count` lanes, by brief.ts: whole
 * modules (a route's first path segment) per lane, balanced by route count.
 * Fewer lanes come back when there are fewer modules. With fewer than two the
 * run has nothing to split, and explores in one loop, saying why.
 */
export function planCiLanes(o: {
  target: string;
  notes: ReadonlyMap<string, readonly string[]>;
  count: number;
  focus?: string;
  mode: CiMode;
  /** What failed while planning, if anything: with no route found, that is the reason given, not the app. */
  planningFailed?: string;
  /** A seeded run's schedule: the split and each lane's order follow the seed (brief.ts). */
  schedule?: ScheduleInput;
}): LanePlan {
  const routes = plannedRoutes(o.target, o.notes);
  if (o.count < 2) return { lanes: [], oneLoop: "one lane was asked for" };
  if (o.notes.size === 0 && o.planningFailed) return { lanes: [], oneLoop: `${o.planningFailed}, so there was nothing to split` };
  const briefs = planLanes(routes, o.count, { goal: o.focus, mode: o.mode, ...(o.schedule ? { schedule: o.schedule } : {}) });
  if (briefs.length < 2) {
    const where = briefs[0]?.modules[0];
    return {
      lanes: [],
      oneLoop: `the planning crawl found ${routes.length} route(s), all in ${where ? `one module (${where})` : "no module"}, so there was nothing to split`,
    };
  }
  const sessions = laneSessions(briefs.map((b) => b.lane));
  return {
    lanes: briefs.map((b, i) => ({
      ...b,
      session: sessions[i],
      // On the target's origin whatever the route says: a path written `//host/x` must not become another host.
      url: `${new URL(o.target).origin}${b.landing.startsWith("/") ? "" : "/"}${b.landing}`,
      crawl: b.routes.flatMap((r) => o.notes.get(r) ?? []).slice(0, LIST_MAX),
    })),
  };
}

// ── what a lane is told ─────────────────────────────────────────────────────

/**
 * The system prompt every lane is given: the method, then the rules of an
 * unattended run as one lane of several. The same for every lane of a run, so
 * the provider's prompt cache serves them all; what differs goes in the
 * lane's first message (ciLaneKickoff).
 */
export function ciLaneSystemPrompt(playbook: string, o: { mode: CiMode; level: CiLevel }): string {
  return (
    `${playbook}\n\n---\n\n` +
    `# Running in CI, as one lane of several\n\n` +
    `You are running unattended in a CI job, as one of several lanes exploring the same app at once, each in its own browser session and its own part of the app. There is no person to ask: never ask a question or wait for an answer; decide, and say in findings and notes what you assumed.\n\n` +
    `- Your browser is already attached to the target in ${o.mode} mode, as your lane's own session. scout_attach, scout_close, scout_session, scout_playbook and scout_report are not available: the mode, the target and the session are fixed for this run, and the method is the text above. Skip the Setup steps that choose them, and never pass \`session\`.\n` +
    `- The planner has crawled the routes it found, so route coverage may already read as complete. Your first message lists the routes your lane owns, from that crawl, and what it saw on them; the other lanes own the rest, at the same time. A route under your modules that the crawl did not list is yours too.\n` +
    LANE_RULES.map((rule) => `- ${rule}\n`).join("") +
    `- The level is ${o.level}. The run writes one report for every lane once all are done, and its contract counts what every lane did: do your share of it on your routes, the design audits included.\n` +
    `- Tool results are text only; screenshots are not available. Long results are cut: prefer calls that return less, and snapshots only where you act.\n` +
    `- When your routes are done, or your share of the budget is nearly spent, reply with a short summary and no tool call. That ends your lane; the others go on.\n`
  );
}

const n = (x: number): string => x.toLocaleString("en-US");

/** A lane's first message: which lane it is, what it owns, where its browser is, what the crawl saw there, and its share of the budget. */
export function ciLaneKickoff(o: {
  lane: CiLane;
  laneCount: number;
  url: string;
  projectDir: string;
  mode: CiMode;
  level: CiLevel;
  focus?: string;
  caps: Caps;
  /** True when the run is seeded: the lane's routes are listed in the order to take them. */
  seeded?: boolean;
}): string {
  const { lane } = o;
  const share = Math.max(1, Math.floor(o.caps.turns / o.laneCount));
  return [
    `Run an exploratory test session following the method, as lane "${lane.session}", one of ${o.laneCount} running at once.`,
    `Target: ${o.url}`,
    `Your lane: ${lane.objective}`,
    `Your routes (${lane.routes.length}): ${lane.routes.slice(0, LIST_MAX).join(", ")}${lane.routes.length > LIST_MAX ? ` … and ${lane.routes.length - LIST_MAX} more` : ""}`,
    o.seeded
      ? `Your routes are listed in this run's seeded order, the ones earlier seeded runs started with last: take them in that order, starting with the first.`
      : "",
    `Your browser is on ${routeOf(lane.url)}.`,
    lane.crawl.length > 0 ? `What the planning crawl saw on your routes:\n${lane.crawl.map((l) => `  ${l.trim()}`).join("\n")}` : "",
    `Project directory (for scout_scan): ${o.projectDir}`,
    `Level: ${o.level}`,
    `Write mode: ${o.mode}`,
    o.focus ? `Focus: ${o.focus}` : "",
    `Budget: the run's ${o.caps.turns} model turns, ${n(o.caps.tokens)} tokens and ${Math.round(o.caps.wallMs / 60_000)} minutes are shared by the ${o.laneCount} lanes: plan on about ${share} turns. Several tool calls in one turn cost one turn. Every lane stops at the first cap the run reaches, and the report is written as it stands.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── how the lanes' endings become the run's ─────────────────────────────────

/** Caps in the order capReached checks them, so a run ended by two names the one checked first. */
const CAP_ORDER: readonly StopReason[] = ["time", "tokens", "turns"];

/**
 * What ended a run whose exploration was split into lanes. A model API failure
 * in any lane is the run's, since it is what the workflow must fix, and so is
 * a lane that broke after attaching (could-not-start on an attached lane: the
 * run could not finish, exit 2). Otherwise the run ended at a cap if any lane
 * was stopped by one, a lane the time cap left no time to attach included, and
 * the model finished it only when every lane that ran finished by itself. A
 * lane whose browser could not attach does not change that, but is named in
 * the detail; when none could, the run could not start.
 */
export function mergeLaneStops(lanes: ReadonlyArray<{ session: string; attached: boolean; stop: StopReason; stopDetail?: string }>): {
  stop: StopReason;
  stopDetail?: string;
} {
  const failed = lanes.find((l) => l.attached && l.stop === "provider-error");
  if (failed) return { stop: "provider-error", stopDetail: `lane ${failed.session}${failed.stopDetail ? `: ${failed.stopDetail}` : ""}` };
  const broke = lanes.find((l) => l.attached && l.stop === "could-not-start");
  if (broke) return { stop: "could-not-start", stopDetail: `lane ${broke.session}: ${broke.stopDetail ?? "it stopped for no reason it gave"}` };
  const unattached = lanes.filter((l) => !l.attached && l.stop === "could-not-start").map((l) => l.session);
  if (unattached.length === lanes.length) {
    const first = lanes.find((l) => l.stopDetail);
    return { stop: "could-not-start", stopDetail: `no lane could attach${first ? ` (${first.session}: ${first.stopDetail})` : ""}` };
  }
  const note = unattached.length > 0 ? { stopDetail: `${unattached.length} of ${lanes.length} lanes could not attach: ${unattached.join(", ")}` } : {};
  for (const cap of CAP_ORDER) if (lanes.some((l) => l.stop === cap)) return { stop: cap, ...note };
  return { stop: "done", ...note };
}
