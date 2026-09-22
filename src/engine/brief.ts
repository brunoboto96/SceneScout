/**
 * Splitting an app between parallel lanes.
 *
 * A parallel run has one planning agent and several lanes, each driving its
 * own browser. `lane.ts` is how a lane hands its answers BACK. This is the
 * other half: what the planner hands each lane in the first place.
 *
 * Done by hand it goes wrong in two ways, both seen in a real four-session
 * run. Lanes overlap, so two browsers audit the same register and the third
 * module is never opened at all — the run's coverage looks fine because every
 * route was visited, and the gap ledger only catches it at report time. And
 * lanes launch underspecified: the first two sessions in that run acted with
 * no task set, so the person watching the live view saw two browsers clicking
 * through their app with nothing to say why.
 *
 * So the split is computed, not improvised. Routes are grouped into modules by
 * their first path segment, because a lane that owns "everything under
 * /orders" can carry state between its own steps, while a lane handed nine
 * unrelated routes re-learns the app nine times. Modules are then dealt to
 * lanes worst-first by size, which keeps the lanes within a route or two of
 * each other without ever splitting a module across two browsers.
 *
 * Pure, so the split and the wording are table-tested.
 */
import { normalizePath } from "./fingerprint.js";

/** Most lanes worth running at once. Past this the planner spends longer reading reports than the lanes spend testing. */
export const MAX_LANES = 8;
/** A lane name is a session name: short, and it shows in the live view. */
export const LANE_NAME_MAX = 40;

export interface LaneBrief {
  /** The session name to attach with. */
  lane: string;
  /** The `objective` to pass to scout_attach — this lane's whole remit, shown live for the run's duration. */
  objective: string;
  /** The modules this lane owns, as path prefixes. */
  modules: string[];
  /** Every route it owns. */
  routes: string[];
  /**
   * Where the lane attaches: its own first route, not the app's home page.
   * Every lane attaching on `/` meant every lane met the landing page's
   * defects first, and several filed the same one.
   */
  landing: string;
}

/**
 * The module a route belongs to: its first path segment, or "/" for the root.
 *
 * The query string is dropped, unlike everywhere else in the engine, where a
 * `?tab=` screen is deliberately its own state. Two tabs of one register are
 * one module: handing them to different lanes would mean two browsers learning
 * the same screen, which is the opposite of what the split is for.
 */
export function moduleOf(route: string): string {
  const path = normalizePath(route).split("?")[0];
  const first = path.split("/").filter(Boolean)[0];
  return first ? `/${first}` : "/";
}

/**
 * Deal modules to lanes so each lane owns whole modules and the lanes come out
 * close to even.
 *
 * Largest module first into the lane with fewest routes so far: the standard
 * greedy split, which is within a fraction of optimal for this shape and, more
 * to the point, is stable — the same routes produce the same split every time,
 * so a re-run of a lane can be given the same brief.
 */
export function splitRoutes(routes: readonly string[], laneCount: number): Array<{ modules: string[]; routes: string[] }> {
  const lanes = Math.max(1, Math.min(Math.floor(laneCount) || 1, MAX_LANES));
  const byModule = new Map<string, string[]>();
  for (const route of routes) {
    const key = moduleOf(route);
    const list = byModule.get(key);
    if (list) list.push(route);
    else byModule.set(key, [route]);
  }
  // Biggest first, then by name, and each module's own routes sorted: nothing
  // about the split may depend on the order the routes were discovered in, or
  // a lane that has to be re-run cannot be handed the same brief.
  const modules = [...byModule.entries()]
    .map(([name, list]) => [name, [...list].sort((a, b) => a.localeCompare(b))] as [string, string[]])
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const out = Array.from({ length: lanes }, () => ({ modules: [] as string[], routes: [] as string[] }));
  for (const [name, list] of modules) {
    let smallest = 0;
    for (let i = 1; i < out.length; i += 1) if (out[i].routes.length < out[smallest].routes.length) smallest = i;
    out[smallest].modules.push(name);
    out[smallest].routes.push(...list);
  }
  // A lane with nothing to do is a browser held open for no reason.
  return out.filter((lane) => lane.routes.length > 0);
}

/** A lane's name, derived from what it owns so the live view reads as the app rather than as "lane-3". */
export function laneName(modules: readonly string[], index: number): string {
  const first = modules[0]?.replace(/^\//, "") ?? "";
  const base = first ? first.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "") : `lane-${index + 1}`;
  const name = modules.length > 1 ? `${base}+${modules.length - 1}` : base || `lane-${index + 1}`;
  return name.slice(0, LANE_NAME_MAX);
}

export interface BriefOptions {
  /** What the whole run is for. Each lane's objective is written against it, so a lane knows what it is contributing to. */
  goal?: string;
  /** The write mode every lane attaches in, so one lane cannot be laxer than the run was authorized for. */
  mode?: string;
  /** The role each lane runs as, when the planner has decided one. */
  role?: string;
}

/** The lanes to run, each with the objective to attach with. */
export function planLanes(routes: readonly string[], laneCount: number, opts: BriefOptions = {}): LaneBrief[] {
  return splitRoutes(routes, laneCount).map((lane, i) => ({
    lane: laneName(lane.modules, i),
    objective: laneObjective(lane.modules, opts.goal),
    modules: lane.modules,
    routes: lane.routes,
    landing: landingOf(lane.routes),
  }));
}

/**
 * The first of a lane's routes a browser can open as it stands. A route the
 * engine normalised (`/orders/:id`) is a pattern, not an address; a lane with
 * nothing else lands on the app's root and navigates from there.
 */
export function landingOf(routes: readonly string[]): string {
  return routes.find((r) => !/(^|\/)[:*]|\[[^\]]+\]/.test(r)) ?? "/";
}

function laneObjective(modules: readonly string[], goal?: string): string {
  const owned = modules.length === 1 ? modules[0] : `${modules.slice(0, -1).join(", ")} and ${modules[modules.length - 1]}`;
  const what = `Own ${owned}`;
  return goal ? `${what} — ${goal}` : what;
}

/**
 * The briefing the planner gives the lanes.
 *
 * It states the two rules a hand-written brief keeps dropping: a lane touches
 * only its own routes, and a lane says what it is doing before it does it.
 * Both are cheap to write here and expensive to discover missing at report
 * time.
 */
export function formatBriefs(briefs: readonly LaneBrief[], opts: BriefOptions = {}): string {
  if (briefs.length === 0) return "Nothing to split — no routes are known yet. Crawl first, then ask again.";
  const mode = opts.mode ?? "read-only";
  const lines = [
    `LANE PLAN — ${briefs.length} lane(s) over ${briefs.reduce((n, b) => n + b.routes.length, 0)} route(s).`,
    ``,
    `Give each lane its own agent. Every lane attaches with its own session name, so the browsers run genuinely in parallel, and lands on its own first route rather than the home page:`,
    `  scout_attach { session: "<lane>", url: "<origin><landing>", projectPath, mode: "${mode}"${opts.role ? `, storageStatePath: "<${opts.role}>"` : ""}, objective: "<objective>" }`,
    ``,
    `Rules to pass on, which a hand-written brief tends to drop:`,
    `  · A lane works ITS routes only. Two lanes auditing the same register while a third module is never opened is the failure this plan exists to prevent — and route coverage will look complete either way. A defect on a page it does not own is that page's lane's to file.`,
    `  · Every acting tool takes a \`task\`. A lane that acts with none is refused, and the person watching the live view would otherwise see a browser clicking through their app with nothing to say why.`,
    `  · File each defect with scout_finding the moment it is judged, before writing the report. A defect only in the report is not in the run's report.`,
    `  · Before calling a list empty, stale or stuck, read the status of the request behind it: a correct empty result and a failed one can render identically.`,
    `  · On a create form, submit one markup-shaped value, then open where that record is listed. Any lane's session catches it rendering as markup, so the list may belong to another lane.`,
    `  · When a control is withheld from this role, call the endpoint behind it with scout_request: hiding a button is not enforcing a rule. When a sort or filter runs, check the result is what it claims.`,
    `  · Check scout_coverage before finishing.`,
    `  · A lane reports back with scout_lane_report, not prose, and does NOT close its session: the planner folds the report, which checks each judged defect was filed, then closes it. Call scout_lane_report with no reply to get the instruction to put in its prompt.`,
    ``,
  ];
  for (const b of briefs) {
    lines.push(`── ${b.lane} ──`);
    lines.push(`objective: ${b.objective}`);
    lines.push(`owns: ${b.modules.join(", ")} (${b.routes.length} route(s))`);
    lines.push(`landing: ${b.landing}`);
    lines.push(`routes: ${b.routes.slice(0, 20).join(", ")}${b.routes.length > 20 ? ` … and ${b.routes.length - 20} more` : ""}`);
    lines.push(``);
  }
  return lines.join("\n");
}
