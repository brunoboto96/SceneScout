/**
 * The page-text fallback for hover: which text is new after the pointer moved.
 *
 * Pure, so the rule can be table-tested. The browser side only supplies the
 * two `innerText` readings.
 */

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Lines present after the hover whose text was not on the page before it.
 *
 * Comparing line by line is not enough. When something that was showing goes
 * away — the previous hover's tooltip closing as the pointer leaves it — the
 * text around it can re-flow onto a line of its own, and that line is "new"
 * only as a line: every word of it was already visible. How text re-flows
 * differs between browsers, so a line counts as revealed only when its text
 * appears nowhere in the earlier reading.
 */
export function revealedLines(bodyBefore: string, bodyAfter: string, limit = 5): string[] {
  const beforeLines = new Set(bodyBefore.split("\n").map(squash).filter(Boolean));
  const beforeText = squash(bodyBefore);
  return bodyAfter
    .split("\n")
    .map(squash)
    .filter((l) => l && !beforeLines.has(l) && !beforeText.includes(l))
    .slice(0, limit)
    .map((l) => l.slice(0, 300));
}
