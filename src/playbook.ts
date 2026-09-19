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
  `Before the first scout_attach in a conversation, call ${PLAYBOOK_TOOL} once and follow what it returns, ` +
  `unless a SceneScout skill is already loaded in this conversation (it is the same text). ` +
  `Never choose mode="destructive" yourself: that needs the user's explicit opt-in.`;

/** The skill file without its YAML front matter, which only a skill loader reads. */
export function stripFrontMatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  return (m ? markdown.slice(m[0].length) : markdown).replace(/^\s+/, "");
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
  return body;
}

/** The opening message of the `explore` prompt: the method, then what the person asked for. */
export function explorePrompt(playbook: string, args: { url?: string; depth?: string; focus?: string }): string {
  const asks = [
    args.url ? `Target: ${args.url}` : "Target: ask me for the URL of the running app, or find it from the project.",
    args.depth ? `Depth: ${args.depth}` : "",
    args.focus ? `Focus: ${args.focus}` : "",
  ].filter(Boolean);
  return `${playbook}\n\n---\n\nRun an exploratory test session following the method above.\n${asks.join("\n")}`;
}
