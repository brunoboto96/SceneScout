/**
 * The testing method, served by the MCP server itself.
 *
 * The method lives in skills/scenescout/SKILL.md. Claude Code loads that file
 * as a skill; no other client does, so an agent there gets the tools and none
 * of the method: the setup order, the write modes, what counts as done. The
 * server hands the same text to any client through a tool, a prompt and a short
 * pointer in its instructions. One file, so the two can never disagree.
 */
import fs from "node:fs";
import path from "node:path";

export const PLAYBOOK_TOOL = "scout_playbook";
export const PLAYBOOK_PROMPT = "explore";

/** Where the method is kept, relative to the package root. It is in the package's `files`. */
export const PLAYBOOK_RELATIVE_PATH = path.join("skills", "scenescout", "SKILL.md");

/**
 * Sent to every client when it connects. Short on purpose: clients cut long
 * instructions, and one that is cut in the middle is worse than a pointer.
 */
export const SERVER_INSTRUCTIONS =
  `SceneScout explores a running web app in a real browser and reports bugs, UX problems and coverage. ` +
  `The scout_* tools are deterministic; the method for using them well is a separate text. ` +
  `If this client offers a SceneScout skill, load that. Otherwise call ${PLAYBOOK_TOOL} once, before the first scout_attach in a conversation, and follow what it returns. ` +
  `They are the same text, so never read both. ` +
  `Never choose mode="destructive" yourself: that needs the user's explicit opt-in.`;

export const LEVELS = ["minimal", "medium", "extensive"] as const;
export type Level = (typeof LEVELS)[number];

/** What the `explore` prompt accepts, as MCP lists it. Every argument is optional. */
export const EXPLORE_PROMPT_ARGUMENTS = [
  { name: "url", description: "URL of the running app, e.g. http://localhost:3000", required: false },
  { name: "level", description: `How far to go: ${LEVELS.join(", ")}`, required: false },
  { name: "focus", description: "An area or flow to concentrate on", required: false },
];

/** The skill file without its YAML front matter, which only a skill loader reads. */
export function stripFrontMatter(markdown: string): string {
  // An editor may save the file with a byte-order mark; it would hide the opening fence.
  const text = markdown.replace(/^\uFEFF/, "");
  // The fences may hold nothing between them, and the closing one may be the last line of the file.
  const m = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  // Leading blank LINES go; indentation on the first line of the body stays.
  return (m ? text.slice(m[0].length) : text).replace(/^(?:[ \t]*\r?\n)+/, "");
}

/**
 * The method text. Throws when the file is not where the package puts it: an
 * agent told "here is the method" and handed an empty string would proceed
 * without one and never say so.
 */
export function loadPlaybook(packageRoot: string): string {
  const file = path.join(packageRoot, PLAYBOOK_RELATIVE_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `The SceneScout playbook is missing from this install (${file}): ${err instanceof Error ? err.message : String(err)}. Reinstall the package.`,
    );
  }
  const body = stripFrontMatter(raw);
  if (body.trim().length === 0) throw new Error(`The SceneScout playbook at ${file} is empty. Reinstall the package.`);
  // Front matter that was not recognised would be served to the agent as if it were the method.
  if (/^---[ \t]*(\r?\n|$)/.test(body)) throw new Error(`The SceneScout playbook at ${file} has front matter that could not be read. Reinstall the package.`);
  return body;
}

/**
 * The opening message of the `explore` prompt: the method, then what the person
 * asked for. `args` is whatever the client sent, which may be nothing at all.
 * A level the method does not know is refused, not passed on for the agent to guess at.
 */
export function explorePrompt(playbook: string, args: Record<string, unknown> | undefined): string {
  const given = (name: string): string | undefined => {
    const v = args?.[name];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const level = given("level");
  if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
    throw new Error(`level "${level}" is not one the method knows. Use one of: ${LEVELS.join(", ")}.`);
  }
  const asks = [
    given("url") ? `Target: ${given("url")}` : "Target: ask me for the URL of the running app, or find it from the project.",
    level ? `Level: ${level}` : "",
    given("focus") ? `Focus: ${given("focus")}` : "",
  ].filter(Boolean);
  return `${playbook}\n\n---\n\nRun an exploratory test session following the method above.\n${asks.join("\n")}`;
}
