/**
 * The page-text fallback for hover: which text is new after the pointer moved.
 *
 * Pure, so the rule can be table-tested. The browser side only supplies the
 * two `innerText` readings.
 */

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** How many times `needle` occurs in `haystack`, overlaps not counted. */
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * Lines present after the hover whose text was not on the page before it.
 *
 * Comparing line by line is not enough. When something that was showing goes
 * away — the previous hover's tooltip closing as the pointer leaves it — the
 * text around it can re-flow onto a line of its own, and that line is "new"
 * only as a line: every word of it was already visible. How text re-flows
 * differs between browsers. So a line counts as revealed when its text occurs
 * MORE often after the hover than before: text that only moved occurs as often
 * as it did, while a tooltip reading "Delete" on a page that already says
 * "Delete account" occurs once more and is still reported.
 */
export function revealedLines(bodyBefore: string, bodyAfter: string, limit = 5): string[] {
  const beforeText = squash(bodyBefore);
  const afterText = squash(bodyAfter);
  const seen = new Set<string>();
  return bodyAfter
    .split("\n")
    .map(squash)
    .filter((l) => {
      if (!l || seen.has(l)) return false;
      seen.add(l);
      return occurrences(afterText, l) > occurrences(beforeText, l);
    })
    .slice(0, limit)
    .map((l) => l.slice(0, 300));
}
