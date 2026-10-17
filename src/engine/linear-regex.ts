/**
 * Regular expressions on a linear-time engine, for the patterns that read text
 * the app under test controls (redaction, and the guided choices' credential
 * check). JavaScript's own engine backtracks: a crafted string can make a
 * pattern take time quadratic or worse in its length. RE2JS, a JavaScript port
 * of RE2, matches in time linear in the text whatever the pattern, so the bound
 * comes from the engine rather than from a review of each pattern. It is pure
 * JavaScript: nothing to compile, download or build per platform (ADR 28).
 *
 * RE2 has no lookahead and no lookbehind, and some of its classes differ from
 * JavaScript's. The patterns are written for RE2, and this module gives back
 * what JavaScript would have:
 *
 * - `\s` in RE2 is ASCII whitespace only. Write `[${SPACE}]` (or `[^${SPACE}]`
 *   for `\S`) for JavaScript's `\s`, and `[^${LINE_END}]` for its `.`.
 * - `\b` in RE2 reads only ASCII letters, digits and `_` as a word's, as
 *   JavaScript's does, except that JavaScript with both `i` and `u` also reads
 *   the long s and the Kelvin sign as one (ADR 28).
 * - A lookbehind of one character class at the start, `(?<![…])`, is
 *   `notAfter`: RE2 reads the character before as part of the match, and the
 *   match handed back starts after it.
 * - A lookahead at the end is the pattern's last group, with `lookahead: true`:
 *   RE2 reads it as part of the match, and the match handed back ends where
 *   that group starts. Write the lookahead's complement (`(?![\p{L}])` is
 *   `($|[^\p{L}])`), so RE2 makes the same choices among alternatives that
 *   JavaScript's backtracking would.
 * - Any other lookaround is `accept`, a check of a candidate against the
 *   whole text. A candidate it refuses is not a match, and the search goes on
 *   from the next character, as JavaScript's would. A refused candidate is read
 *   again from there, so keep what it reads short: write an open-ended run as
 *   its fixed least part (`x{8}`, not `x{8,}`) and give the rest to `extend`,
 *   which keeps the last run it read so a candidate inside it costs nothing.
 *
 * Case folding: RE2's case-insensitive matching is Unicode simple case folding
 * whatever the flags, so the long s (ſ) and the Kelvin sign match `s` and `k`
 * where JavaScript without the `u` flag does not fold them. A pattern that
 * JavaScript ran with `i` and no `u` folds only its words (`(?i:token)`), so
 * its character classes stay ASCII as they were.
 */
import { RE2JS } from "re2js";

/** JavaScript's `\s`, written for use inside an RE2 character class. */
export const SPACE = String.raw`\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`;

/** JavaScript's `\s`, one character at a time. */
const SPACES = new Set(["\t", "\n", "\v", "\f", "\r", " ", " ", " ", " ", " ", " ", " ", "　", "﻿"]);
for (let c = 0x2000; c <= 0x200a; c++) SPACES.add(String.fromCharCode(c));
export function isSpace(c: string): boolean {
  return SPACES.has(c);
}

/** The characters JavaScript's `.` does not match without the `s` flag, for use inside an RE2 character class. */
export const LINE_END = String.raw`\n\r\x{2028}\x{2029}`;

/** One match: its text, its groups (index 1 on; `undefined` for a group that took no part), where it starts and ends. */
export interface LinearMatch {
  readonly text: string;
  readonly groups: ReadonlyArray<string | undefined>;
  readonly index: number;
  readonly end: number;
}

export interface LinearOptions {
  ignoreCase?: boolean;
  /**
   * Text, in lower case, of which every match holds at least one: where the
   * text in lower case holds none, the engine is not run. RE2 is slower than
   * JavaScript's engine, and most text names no secret. Each must be text
   * every match holds whole, whatever its case, written in ASCII, Latin-1
   * letters or characters without case: their lower case is what RE2 folds
   * them to (the long s and the Kelvin sign are seen to below), which is not
   * so in every script.
   */
  needs?: readonly string[];
  /** `(?<![…])` before the pattern: the inside of a character class the character before the match may not be one of. */
  notAfter?: string;
  /** The pattern's last group stands for a lookahead: it is read, but the match ends where it starts. */
  lookahead?: boolean;
  /** Where a candidate ends, at or past where the pattern stopped reading it. Applied before `accept`. */
  extend?: (match: LinearMatch, text: string) => number;
  /** Whether a candidate is a match, for a lookaround RE2 cannot express. Refused, the search goes on from the next character. */
  accept?: (match: LinearMatch, text: string) => boolean;
}

/** Whether a character's lower case stands for every character RE2 folds it with: ASCII, Latin-1 letters (not µ), and characters without case. */
function foldsAsLowerCase(c: string): boolean {
  return (c >= " " && c <= "~") || (c >= "\u00c0" && c <= "\u00ff") || c.toLowerCase() === c.toUpperCase();
}

/** The last text put in lower case for `needs`, and what it came to. */
let lowered: { text: string; lower: string } = { text: "", lower: "" };

/**
 * The text in lower case, for `needs`. RE2 folds case by Unicode's simple
 * folding, where the long s (ſ) is an s; toLowerCase keeps it, so it is
 * written as one. The Kelvin sign's lower case is already a k.
 */
function lowerCase(text: string): string {
  if (lowered.text !== text) lowered = { text, lower: text.toLowerCase().replaceAll("ſ", "s") };
  return lowered.lower;
}

/** The length of the character at `index`: two for a surrogate pair, as JavaScript's `u` flag steps. */
function charLength(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return 2;
  }
  return 1;
}

/** The length of the character just before `index`: two for a surrogate pair, 0 at the start. */
function charLengthBefore(text: string, index: number): number {
  if (index <= 0) return 0;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return 2;
  }
  return 1;
}

export class LinearRegex {
  readonly source: string;
  private readonly options: LinearOptions;
  /** The pattern as compiled; with `notAfter`, the one used where the text starts (the character before may be none). */
  private readonly re: RE2JS;
  /** With `notAfter`, the one used anywhere else: it reads one character before the match. */
  private readonly inner: RE2JS | null;
  /** Groups RE2 has that the caller did not write before the caller's: the lookbehind's. */
  private readonly skip: number;
  /** The caller's last group, the lookahead's left out. */
  private readonly last: number;

  constructor(source: string, options: LinearOptions = {}) {
    this.source = source;
    this.options = options;
    for (const need of options.needs ?? [])
      if (need === "" || need !== need.toLowerCase() || [...need].some((c) => !foldsAsLowerCase(c)))
        throw new Error(`a pattern's needs are ASCII, Latin-1 or caseless text in lower case: ${JSON.stringify(need)}`);
    const flags = options.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0;
    if (options.notAfter !== undefined) {
      this.re = RE2JS.compile(`(^|[^${options.notAfter}])(?:${source})`, flags);
      this.inner = RE2JS.compile(`([^${options.notAfter}])(?:${source})`, flags);
      this.skip = 1;
    } else {
      this.re = RE2JS.compile(source, flags);
      this.inner = null;
      this.skip = 0;
    }
    const count = this.re.groupCount();
    this.last = options.lookahead ? count - 1 : count;
    if (options.lookahead && this.last < this.skip) throw new Error(`a lookahead pattern needs its lookahead as its last group: ${source}`);
  }

  /** Whether the text may hold a match, by `needs`. */
  private mayMatch(text: string): boolean {
    const needs = this.options.needs;
    if (!needs) return true;
    const lower = lowerCase(text);
    return needs.some((need) => lower.includes(need));
  }

  /** The first match at or after `from`, or null. */
  exec(text: string, from = 0): LinearMatch | null {
    return this.mayMatch(text) ? this.find(text, from) : null;
  }

  private find(text: string, from: number): LinearMatch | null {
    let at = from;
    while (at <= text.length) {
      // A lookbehind reads the character before `at`, so the search starts there, and the match after it.
      const re = this.inner && at > 0 ? this.inner : this.re;
      const matcher = re.matcher(text);
      if (!matcher.find(this.inner ? at - charLengthBefore(text, at) : at)) return null;
      const index = this.skip ? matcher.end(1) : matcher.start();
      const ahead = this.options.lookahead ? matcher.start(this.last + 1) : -1;
      let end = ahead >= 0 ? ahead : matcher.end();
      const groups: Array<string | undefined> = [undefined];
      for (let g = this.skip + 1; g <= this.last; g++) groups.push(matcher.group(g) ?? undefined);
      if (this.options.extend) end = Math.max(end, this.options.extend({ text: text.slice(index, end), groups, index, end }, text));
      const match: LinearMatch = { text: text.slice(index, end), groups, index, end };
      if (!this.options.accept || this.options.accept(match, text)) return match;
      if (index >= text.length) return null;
      at = index + charLength(text, index);
    }
    return null;
  }

  /** Every match, left to right and not overlapping, as String.prototype.matchAll gives them. */
  *matchAll(text: string): Generator<LinearMatch> {
    if (!this.mayMatch(text)) return;
    let at = 0;
    while (at <= text.length) {
      const match = this.find(text, at);
      if (!match) return;
      yield match;
      at = match.end > match.index ? match.end : match.end + charLength(text, match.end);
    }
  }

  test(text: string): boolean {
    return this.exec(text) !== null;
  }

  /** Every match replaced by what `replacer` returns for it, as a global String.prototype.replace. */
  replace(text: string, replacer: string | ((match: LinearMatch) => string)): string {
    let out = "";
    let last = 0;
    for (const match of this.matchAll(text)) {
      out += text.slice(last, match.index) + (typeof replacer === "string" ? replacer : replacer(match));
      last = match.end;
    }
    return out + text.slice(last);
  }

  /** The first match replaced by what `replacer` returns for it, as a String.prototype.replace with a pattern that has no `g` flag. */
  replaceFirst(text: string, replacer: string | ((match: LinearMatch) => string)): string {
    const match = this.exec(text);
    if (!match) return text;
    return text.slice(0, match.index) + (typeof replacer === "string" ? replacer : replacer(match)) + text.slice(match.end);
  }

  /** The text split at every match, as String.prototype.split with a pattern that has no group and never matches empty. */
  splitText(text: string): string[] {
    if (this.last > this.skip) throw new Error(`splitText by a pattern that has groups: ${this.source}`);
    return this.split(text).map((part) => part ?? "");
  }

  /** The text split at every match, each match's groups in between, as String.prototype.split with a pattern that never matches empty. */
  split(text: string): Array<string | undefined> {
    const out: Array<string | undefined> = [];
    let last = 0;
    for (const match of this.matchAll(text)) {
      if (match.end === match.index) throw new Error(`split by a pattern that matched empty text: ${this.source}`);
      out.push(text.slice(last, match.index), ...match.groups.slice(1));
      last = match.end;
    }
    out.push(text.slice(last));
    return out;
  }
}

/** The end of the run of characters `inRun` accepts that starts at `from`. */
export function runEnd(text: string, from: number, inRun: (c: string) => boolean): number {
  let end = from;
  while (end < text.length && inRun(text[end])) end += 1;
  return end;
}
