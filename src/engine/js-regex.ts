/**
 * A pattern written as JavaScript wrote it, run on the linear-time engine
 * (linear-regex.ts, ADR 28 and ADR 29).
 *
 * `fromJs(source, flags)` reads a JavaScript regular expression's source and
 * gives back what it matches, through RE2 rather than a backtracking engine.
 * It rewrites the few places the two differ, so a pattern is written once, as
 * the code reads it, and a test can hold it to JavaScript's own result:
 *
 * - `\s` and `\S` are JavaScript's set of white space (RE2's is ASCII only),
 *   and `.` is anything but a line end;
 * - the `i` flag folds the ASCII letters and the other letters whose case JavaScript
 *   folds without the `u` flag, and nothing more (RE2 would also fold the long s
 *   and the Kelvin sign onto `s` and `k`);
 * - `\uXXXX` is `\x{XXXX}`, and `[\s\S]` is any character.
 *
 * What RE2 cannot do is refused, so a pattern that needs it is written for
 * LinearRegex by hand: a lookahead or a lookbehind, a back reference, a named
 * group, `\b` or `\B` inside a class, `\S` inside a class beside other items.
 *
 * Every pattern built here is kept (`jsPatterns`) with the source and flags
 * it was read from, so memory-test can hold each to a JavaScript RegExp of the
 * same source on the suites' own strings and on generated ones.
 */
import { LINE_END, LinearRegex, type LinearOptions, SPACE } from "./linear-regex.js";

/** Every pattern built by `fromJs`, with the JavaScript pattern it stands for. */
export const jsPatterns: Array<{ source: string; flags: string; pattern: LinearRegex }> = [];

const isAsciiLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isHex = (c: string) => "0123456789abcdefABCDEF".includes(c);

/**
 * The characters JavaScript's `i` flag (no `u`) treats as the same as `c`:
 * its upper and lower case, when each is one code unit, and not a letter of
 * ASCII for a character outside it (the long s is not an `s`).
 */
function caseVariants(c: string): string[] {
  const out = new Set([c]);
  for (const v of [c.toUpperCase(), c.toLowerCase()]) {
    if (v.length !== c.length || [...v].length !== 1) continue;
    if (c.charCodeAt(0) >= 128 && v.charCodeAt(0) < 128) continue;
    out.add(v);
  }
  return [...out];
}

/** A literal character as RE2 reads it, escaped when it is punctuation. */
function literal(c: string): string {
  return "\\.+*?()|[]{}^$/-".includes(c) ? `\\${c}` : c;
}

/** The ranges of ASCII letters the range `lo-hi` also holds in the other case. */
function foldedRange(lo: string, hi: string): string {
  let out = "";
  const add = (from: string, to: string, shift: number) => {
    const a = Math.max(lo.charCodeAt(0), from.charCodeAt(0));
    const b = Math.min(hi.charCodeAt(0), to.charCodeAt(0));
    if (a <= b) out += `${String.fromCharCode(a + shift)}-${String.fromCharCode(b + shift)}`;
  };
  add("a", "z", -32);
  add("A", "Z", 32);
  return out;
}

/** The pattern's source for RE2: see the module's comment. */
export function jsToRe2(source: string, flags = ""): string {
  const fold = flags.includes("i");
  let out = "";
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`a pattern RE2 cannot run is written by hand, not read by fromJs (${what}): ${source}`);
  };
  /** The escape at `i` (a backslash and what follows); `inClass` says where it stands. Moves `i` past it. */
  const escape = (inClass: boolean): string => {
    const n = source[i + 1];
    if (n === undefined) return fail("a trailing backslash");
    if (n === "s") {
      i += 2;
      return inClass ? SPACE : `[${SPACE}]`;
    }
    if (n === "S") {
      if (inClass) return fail("\\S in a class");
      i += 2;
      return `[^${SPACE}]`;
    }
    if (n === "u") {
      const hex = source.slice(i + 2, i + 6);
      if (hex.length !== 4 || ![...hex].every(isHex)) return fail("\\u without four digits");
      i += 6;
      return `\\x{${hex}}`;
    }
    if (n === "x") {
      const hex = source.slice(i + 2, i + 4);
      if (hex.length !== 2 || ![...hex].every(isHex)) return fail("\\x without two digits");
      i += 4;
      return `\\x${hex}`;
    }
    if (n === "p" || n === "P") {
      const close = source.indexOf("}", i);
      if (source[i + 2] !== "{" || close < 0) return fail("\\p without braces");
      const text = source.slice(i, close + 1);
      i = close + 1;
      return text;
    }
    if ((n >= "1" && n <= "9") || n === "k") return fail("a back reference");
    if (inClass && (n === "b" || n === "B")) return fail("\\b in a class");
    if (n === "c" || n === "0") return fail(`\\${n}`);
    i += 2;
    return `\\${n}`;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      out += escape(false);
    } else if (c === "(") {
      if (source[i + 1] === "?") {
        const kind = source.slice(i + 2, i + 4);
        if (source[i + 2] !== ":") return fail(`a group beginning (?${kind}`);
        out += "(?:";
        i += 3;
      } else {
        out += "(";
        i += 1;
      }
    } else if (c === "[") {
      i += 1;
      let negated = false;
      if (source[i] === "^") {
        negated = true;
        i += 1;
      }
      if (source[i] === "]") return fail("an empty class");
      // The pair JavaScript writes for "any character".
      if (source.startsWith("\\s\\S]", i) && !negated) {
        out += "[\\x{0}-\\x{10ffff}]";
        i += 5;
        continue;
      }
      let body = "";
      /** One member of the class: a character (which may start or end a range) or a set (`\\d`). */
      const atom = (): { text: string; single: boolean; plain?: string } => {
        const m = source[i];
        if (m === "\\") {
          const single = !"sSdDwWpP".includes(source[i + 1] ?? "");
          return { text: escape(true), single };
        }
        i += 1;
        return { text: literal(m), single: true, plain: m };
      };
      for (;;) {
        if (i >= source.length) return fail("an unclosed class");
        if (source[i] === "]") {
          i += 1;
          break;
        }
        const a = atom();
        if (a.single && source[i] === "-" && i + 1 < source.length && source[i + 1] !== "]") {
          i += 1;
          const b = atom();
          if (b.single) {
            body += `${a.text}-${b.text}`;
            if (fold && a.plain !== undefined && b.plain !== undefined && isAsciiLetter(a.plain) && isAsciiLetter(b.plain))
              body += foldedRange(a.plain, b.plain);
          } else {
            // A range to a set is not a range: the hyphen stands for itself.
            body += `${a.text}\\-${b.text}`;
          }
          continue;
        }
        body += fold && a.plain !== undefined ? caseVariants(a.plain).map(literal).join("") : a.text;
      }
      out += `[${negated ? "^" : ""}${body}]`;
    } else if (c === ".") {
      out += `[^${LINE_END}]`;
      i += 1;
    } else {
      const variants = fold ? caseVariants(c) : [c];
      out += variants.length > 1 ? `[${variants.map(literal).join("")}]` : c;
      i += 1;
    }
  }
  return out;
}

/** Keeps `pattern` as the run of `source` and `flags` that a test holds it to; `fromJs` does this for the patterns it builds. */
export function registerJsPattern(source: string, flags: string, pattern: LinearRegex): LinearRegex {
  jsPatterns.push({ source, flags, pattern });
  return pattern;
}

/**
 * A JavaScript pattern, its `i` flag as JavaScript folds it, on the linear-time engine. `g`, `u` and `y` are not read.
 * A pattern JavaScript ran with a lookaround is rewritten for RE2 (linear-regex.ts says how) and passes the pattern it
 * stood for as `original`, which is what a test holds it to.
 */
export function fromJs(source: string, flags = "", options: LinearOptions = {}, original = source): LinearRegex {
  if (flags.replaceAll("i", "") !== "") throw new Error(`fromJs reads the i flag only, not "${flags}": ${source}`);
  return registerJsPattern(original, flags, new LinearRegex(jsToRe2(source, flags), options));
}
