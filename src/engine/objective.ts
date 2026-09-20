/**
 * The objective: one short sentence saying what the batch of actions a session
 * is performing right now is FOR.
 *
 * The engine sees tool calls, never the reasoning behind them, so the live
 * view can only show an objective the agent states. Left optional it was
 * usually blank — a person watching saw a session click through an app with
 * nothing to say why. So a tool that acts on the app requires one: passed on
 * the call, or already standing from an earlier call or a journey. It stays
 * set until it is replaced, so a batch costs one sentence, not one per click.
 *
 * Reading the page (snapshot, hover, scroll, coverage, the audits) needs none:
 * orienting is what an agent does before it can say what it is about to do.
 */

/** Longer than this is a paragraph, not an objective; the live view shows one line. */
export const OBJECTIVE_MAX = 120;

/**
 * The tools that act on the app under test. Each changes what the person
 * watching is looking at, so each has to be able to say why.
 */
export const NEEDS_OBJECTIVE: ReadonlySet<string> = new Set([
  "scout_navigate",
  "scout_back",
  "scout_click",
  "scout_type",
  "scout_select",
  "scout_press",
  "scout_upload",
  "scout_run_plan",
]);

export function needsObjective(tool: string): boolean {
  return NEEDS_OBJECTIVE.has(tool);
}

/** One line, whitespace collapsed, bounded. Empty input clears the objective. */
export function normalizeObjective(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, OBJECTIVE_MAX);
}

/**
 * What a session is told when it acts with no objective standing. It names the
 * parameter, gives the shape of a good one, and says the rule it satisfies —
 * an agent that reads this once should not need it again.
 */
export function objectiveRefusal(tool: string): string {
  return (
    `${tool} needs an objective: this session has none, so the live view cannot say what it is doing.\n` +
    `Pass objective:"…" on this call — one short sentence about the batch of actions you are performing, ` +
    `in the words you would use to tell a colleague ("Sign in as QA_Team and check where it lands", "Fill the deviation form with invalid dates"). ` +
    `It stays set until you pass a different one, so a batch costs one sentence, not one per call. ` +
    `scout_journey {action:"start", goal:"…"} sets it too, and is what to use when you are measuring a whole user task.`
  );
}
