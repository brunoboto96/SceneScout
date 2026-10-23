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
 * - `\uXXXX` is `\x{XXXX}`, and `[\s\S]` is any character;
 * - the text is read a UTF-16 code unit at a time, so a surrogate pair counts as
 *   two characters toward `{8,80}` (linear-regex.ts's `codeUnits`).
 *
 * What RE2 cannot do is refused, so a pattern that needs it is written for
 * LinearRegex by hand: a lookahead or a lookbehind, a back reference, a named
 * group, `\b` or `\B` inside a class, `\S` inside a class beside other items.
 * So is what RE2 would read otherwise than JavaScript: an escaped letter
 * JavaScript reads as the letter itself (`\a`, `\z`, `\A`, `\Q`; RE2 reads a
 * bell, an end, a start, a quote), `\p{…}` (without the `u` flag JavaScript
 * reads the letter p), with `i` a class range the flag folds past its ends, and
 * a surrogate or a private-use character U+E000 to U+E7FF, which `codeUnits`
 * reads as one.
 *
 * Every pattern built here is kept (`jsPatterns`) with the source and flags
 * it was read from, so memory-test can hold each to a JavaScript RegExp of the
 * same source on the suites' own strings and on generated ones.
 */
import { LINE_END, LinearRegex, type LinearOptions, SPACE, SURROGATE_STAND_IN } from "./linear-regex.js";

/** Every pattern built by `fromJs`, with the JavaScript pattern it stands for. */
export const jsPatterns: Array<{ source: string; flags: string; pattern: LinearRegex }> = [];

const isAsciiLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isHex = (c: string) => "0123456789abcdefABCDEF".includes(c);

/**
 * What JavaScript's `i` flag (no `u`) compares a code unit by: its upper case
 * when that is one code unit, and not a letter of ASCII for a character outside
 * it (the long s is not an `s`).
 */
function canonical(c: string): string {
  const upper = c.toUpperCase();
  if (upper.length !== 1) return c;
  if (c.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) return c;
  return upper;
}

/** Every code unit, grouped by `canonical`; built once, on the first pattern with `i`. */
let foldGroups: Map<string, string[]> | null = null;

/** The characters JavaScript's `i` flag (no `u`) treats as the same as `c`: those of the same canonical form (µ, μ and Μ). */
function caseVariants(c: string): string[] {
  if (c.length !== 1) return [c];
  if (!foldGroups) {
    foldGroups = new Map();
    for (let code = 0; code <= 0xffff; code++) {
      const ch = String.fromCharCode(code);
      const key = canonical(ch);
      const group = foldGroups.get(key);
      if (group) group.push(ch);
      else foldGroups.set(key, [ch]);
    }
  }
  // The character itself first, then the others.
  return [c, ...(foldGroups.get(canonical(c)) ?? []).filter((v) => v !== c)];
}

/**
 * Whether the characters `lo` to `hi` hold some but not all of the surrogates and their stand-ins (linear-regex.ts's
 * `codeUnits`): the pattern would then tell a surrogate from a private-use character JavaScript tells apart, or the
 * other way round, so it is refused.
 */
function splitsStandIns(lo: number, hi: number): boolean {
  const first = 0xd800;
  const last = 0xdfff + SURROGATE_STAND_IN;
  return hi >= first && lo <= last && !(lo <= first && hi >= last);
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
  /** The character the last escape stands for, when it stands for one character (`\x41`, `\u00e9`, `\.`, `\n`), so `i` can fold it and a range can be checked. */
  let escaped: string | undefined;
  /** The escape at `i` (a backslash and what follows); `inClass` says where it stands. Moves `i` past it. */
  const escape = (inClass: boolean): string => {
    escaped = undefined;
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
      escaped = String.fromCharCode(parseInt(hex, 16));
      i += 6;
      return `\\x{${hex}}`;
    }
    if (n === "x") {
      const hex = source.slice(i + 2, i + 4);
      if (hex.length !== 2 || ![...hex].every(isHex)) return fail("\\x without two digits");
      escaped = String.fromCharCode(parseInt(hex, 16));
      i += 4;
      return `\\x${hex}`;
    }
    // Without the u flag JavaScript reads \p{L} as the letter p and "{L}"; RE2 reads a Unicode property.
    if (n === "p" || n === "P") return fail(`\\${n} without the u flag`);
    if ((n >= "1" && n <= "9") || n === "k") return fail("a back reference");
    if (inClass && (n === "b" || n === "B")) return fail("\\b in a class");
    if (n === "c" || n === "0") return fail(`\\${n}`);
    const isAlnum = isAsciiLetter(n) || (n >= "0" && n <= "9");
    // A letter JavaScript reads as itself that RE2 reads as something else (\a a bell, \z an end, \Q a quote).
    if (isAlnum && !"dDwWbBnrtfv".includes(n)) return fail(`\\${n}, the letter itself to JavaScript`);
    const control: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" };
    escaped = isAlnum ? control[n] : n;
    i += 2;
    return `\\${n}`;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      const text = escape(false);
      if (escaped !== undefined && splitsStandIns(escaped.charCodeAt(0), escaped.charCodeAt(0))) return fail("a surrogate or a private-use character");
      const variants = fold && escaped !== undefined ? caseVariants(escaped) : [];
      out += variants.length > 1 ? `[${variants.map(literal).join("")}]` : text;
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
          const text = escape(true);
          return { text, single, plain: escaped };
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
          if (b.single && a.plain !== undefined && b.plain !== undefined && splitsStandIns(a.plain.charCodeAt(0), b.plain.charCodeAt(0)))
            return fail("a range over some of the surrogates or private-use characters");
          if (b.single) {
            body += `${a.text}-${b.text}`;
            if (fold && a.plain !== undefined && b.plain !== undefined && isAsciiLetter(a.plain) && isAsciiLetter(b.plain))
              body += foldedRange(a.plain, b.plain);
            else if (fold && a.plain !== undefined && b.plain !== undefined) {
              // Any other range is kept only when the i flag folds nothing in it to a character outside it.
              const lo = a.plain.charCodeAt(0);
              const hi = b.plain.charCodeAt(0);
              for (let code = lo; code <= hi; code++)
                if (caseVariants(String.fromCharCode(code)).some((v) => v.charCodeAt(0) < lo || v.charCodeAt(0) > hi))
                  return fail("a range the i flag folds past its ends");
            }
          } else {
            // A range to a set is not a range: the hyphen stands for itself.
            body += `${a.text}\\-${b.text}`;
          }
          continue;
        }
        if (a.plain !== undefined && splitsStandIns(a.plain.charCodeAt(0), a.plain.charCodeAt(0))) return fail("a surrogate or a private-use character");
        const variants = fold && a.plain !== undefined ? caseVariants(a.plain) : [];
        body += variants.length > 1 ? variants.map(literal).join("") : a.text;
      }
      out += `[${negated ? "^" : ""}${body}]`;
    } else if (c === ".") {
      out += `[^${LINE_END}]`;
      i += 1;
    } else {
      if (splitsStandIns(c.charCodeAt(0), c.charCodeAt(0))) return fail("a surrogate or a private-use character");
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
  return registerJsPattern(original, flags, new LinearRegex(jsToRe2(source, flags), { ...options, codeUnits: true }));
}
