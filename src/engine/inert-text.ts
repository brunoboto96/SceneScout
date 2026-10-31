/**
 * Text from the app under test made inert for wherever it is written: one
 * line, Markdown escaped, and a tracker's triggers (mentions, links,
 * cross-references) broken. Shared by every writer of Markdown that carries
 * app text: the export's issue body, the team report, the check's report and
 * the CI run's summary, and the run report.
 */

/**
 * C0 and C1 controls and every bidirectional control (Unicode's Bidi_Control
 * set: U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): each run becomes
 * a space, so nothing is invisible and nothing reorders the line. The same set
 * as the qa reply's (action/qa-action.mjs), which export-test holds it to.
 */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/** One line: control, bidirectional-override and line-break characters become spaces; runs of space collapse; at most `max`. */
export function oneLine(text: unknown, max: number): string {
  let s = String(text ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/**
 * Zero-width spaces where a tracker would otherwise act on text: after `@`
 * (a mention, an email autolink), inside `://` and `www.` (a link), between
 * `#`, `GH-` or `issues/`, `pull/`, `discussions/` and a number (a
 * cross-reference), and inside the marker's word (so quoted text cannot claim
 * to be another finding's issue).
 */
function breakTriggers(s: string): string {
  return s
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":\u200b//")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\u200b.`)
    .replace(/#(?=\d)/g, "#\u200b")
    .replace(/\bgh-(?=\d)/gi, (m) => `${m.slice(0, 2)}\u200b-`)
    .replace(/\/(issues|pulls?|discussions)\/(?=\d)/gi, "/$1/\u200b")
    .replace(/scenescout-finding/gi, (m) => `${m.slice(0, 10)}\u200b${m.slice(10)}`);
}

/** The punctuation escapeMarkdownText puts a backslash before. */
const MD_PUNCTUATION = /([\\`*_{}[\]()#+!|~])/g;

/**
 * Text written into Markdown so that it renders as the same text and nothing
 * else: `&`, `<` and `>` as entities, a backslash before every punctuation
 * mark Markdown acts on (so no link, image, heading, list, emphasis, table
 * cell or code span can start), and a zero-width space before each `$`,
 * since a backslash does not stop GitHub rendering `$…$` as maths. Line
 * breaks are left to the caller: they end a heading, a list item or a cell.
 * decodeMarkdownText reads it back.
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(MD_PUNCTUATION, "\\$1").replace(/\$/g, "\u200b$");
}

/** escapeMarkdownText's text back to the characters it came from (and the quote entities, and the `-`, `=` and `.` escapeFoldText escapes at a line's start), for a page that renders the Markdown itself. */
export function decodeMarkdownText(text: string): string {
  return text
    .replace(/\u200b\$/g, "$")
    .replace(/\\([\\`*_{}[\]()#+!|~=.-])/g, "$1")
    .replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e] as string);
}

/**
 * Text for a GitHub Markdown body: one line, escapeMarkdownText, and every
 * trigger broken. This is the escaping of the `/scenescout qa` reply
 * (action/qa-action.mjs `inert`) character for character, which export-test
 * holds it to, plus the marker break.
 */
export function inertMarkdown(text: unknown, max = 160): string {
  return breakTriggers(escapeMarkdownText(oneLine(text, max)));
}

/** Text a tracker shows as it is (an issue title, a Jira text node): one line, every trigger broken, nothing escaped. */
export function inertPlain(text: unknown, max = 160): string {
  return breakTriggers(oneLine(text, max));
}
