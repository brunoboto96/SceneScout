/**
 * The task: a few words saying what a session is DOING right now — the batch
 * of actions it is performing on the page in front of it.
 *
 * It sits under the session's objective, which is the whole remit the agent
 * was given at attach ("Admin lane: §2 registers, §7 plan gating"). The
 * objective barely changes; the task changes every time the session moves on
 * to something else, and it is what tells a person watching what is happening
 * now.
 *
 * The engine sees tool calls, never the reasoning behind them, so it can only
 * show a task the agent states. Left optional it was usually absent, so a tool
 * that acts on the app requires one: passed on the call, or already standing
 * from an earlier call or a journey. It stays set until it is replaced, so a
 * batch costs a few words, not one per click.
 *
 * Reading the page (snapshot, hover, scroll, coverage, the audits) needs none:
 * orienting is what an agent does before it can say what it is about to do.
 */

/** Longer than this is a paragraph, not a task; the live view shows one line. */
export const TASK_MAX = 120;

/**
 * The tools that act on the app under test. Each changes what the person
 * watching is looking at, so each has to be able to say why.
 */
export const NEEDS_TASK: ReadonlySet<string> = new Set([
  "scout_navigate",
  "scout_back",
  "scout_click",
  "scout_type",
  "scout_select",
  "scout_press",
  "scout_upload",
  "scout_run_plan",
]);

export function needsTask(tool: string): boolean {
  return NEEDS_TASK.has(tool);
}

/**
 * One line, whitespace collapsed, bounded. Empty input clears the task. A
 * longer one is cut at a word where it can be and ends in an ellipsis, so a
 * truncated task reads as truncated rather than as a sentence that stops
 * mid-word.
 */
export function normalizeTask(text: string | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= TASK_MAX) return line;
  const cut = line.slice(0, TASK_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > TASK_MAX - 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * What a session is told when it acts with no task standing. It names the
 * parameter, gives the shape of a good task and says the rule it satisfies —
 * an agent that reads this once should not need it again.
 */
export function taskRefusal(tool: string): string {
  return (
    `${tool} needs a task: this session has none, so the live view cannot say what it is doing.\n` +
    `Pass task:"…" on this call — a few words saying what you are DOING, not what you are checking. ` +
    `"Filtering the documents register by status", "Filling the deviation form with invalid dates", "Signing in as QA_Team". ` +
    `Not the acceptance criteria ("…narrows the set and is reflected in the URL"): that is the result you will judge, not the batch you are running. ` +
    `It stays set until you pass a different one, so a batch costs a few words, not one per call. ` +
    `scout_journey {action:"start", goal:"…"} sets it too, and is what to use when you are measuring a whole user task.`
  );
}
