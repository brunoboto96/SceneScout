# 27. Redaction and the credential check run on a linear-time regular-expression engine

## Context

Redaction (`src/engine/redact.ts`, `src/engine/sensitive.ts`) and the guided
assistant's credential check (`src/engine/credential.ts`) run regular
expressions over text the app under test controls, or a person pasted: page
text, console lines, request bodies, field labels, query-string names, finding
evidence, a journey. JavaScript's engine backtracks, so a pattern can take time
quadratic or worse in the length of a crafted string. Review timed each new
pattern by hand, and still let some through: measured on a 1 MB text, six
redaction patterns and four parts of the credential check did not finish in a
minute (a secret's name followed by spaces, a value of full stops, a long
parameter name or field label, a field name of capitals or of digits; one long
word, which #578 found growing quadratically in the check). A guarantee that
depends on every future pattern being reviewed is not one.

## Decision

Every pattern in those three files runs on RE2JS, a JavaScript port of RE2
(Go's `regexp`), through `src/engine/linear-regex.ts`. RE2 matches in time
linear in the text whatever the pattern. memory-test fails if one of those
files, or `linear-regex.ts`, holds a JavaScript regular expression, and
memory-test and guided-test each run every pattern on a crafted 1 MB text in a
child process stopped at a bound.

RE2 has no lookahead and no lookbehind, and its `\s`, `.` and `\b` are not
JavaScript's. Each pattern was rewritten to give back what JavaScript gave. A
differential check of the old and new functions, on every string literal in the
test suites and on several hundred thousand generated strings, found no
difference; the one difference known is case folding (below). The rewrite:

- `\s` is written as JavaScript's set (`SPACE`), `.` as JavaScript's (`LINE_END`).
- A lookbehind of one character class reads that character as part of the
  match (`notAfter`), and the match starts after it.
- A lookahead at the end is a last group RE2 reads and the match leaves out
  (`lookahead`), written as its complement, so RE2 chooses among alternatives
  as backtracking did.
- Any other lookaround is a check of a candidate (`accept`); a refused one is
  searched again from the next character, as JavaScript did. What a refused
  candidate reads is kept short: an open-ended run is matched to its least
  length and extended in code (`extend`).

### The engine chosen, against the others

| | `re2` (native binding) | `re2-wasm`, `@adguard/re2-wasm` | Rust `regex` as WebAssembly | `re2js` (chosen) |
|---|---|---|---|---|
| What ships | a `.node` binary per platform and Node ABI | one 1.1 MB `.wasm` | one `.wasm` | JavaScript, 868 KB, no dependencies |
| Node 20 | not supported: 1.27 declares `^22.22.2 \|\| ^24.15.0 \|\| >=26` and publishes binaries for ABIs 127, 137 and 147 only | yes | — | yes (declares `>=18`) |
| Installs with no compiler | only when its install script can download a prebuilt binary from GitHub; otherwise `node-gyp` builds it | yes | yes | yes |
| `npm ci --ignore-scripts` (the `.mcpb` build, ADR 23's actions) | leaves no binary: `require("re2")` fails | works | works | works |
| The desktop extension | built once on Linux, so it would carry a Linux binary to macOS and Windows | works | works | works |
| Linear in practice | yes | no: every match passes the whole string into WebAssembly, so a replace over 20, 40, 80 and 160 KB with a match every 20 characters took 0.4, 1.3, 5.3 and 19 s | — | yes; its optional lookbehinds are not (2,000, 4,000 and 8,000 matches took 1.2, 5.0 and 20 s), so they are not used |
| Maintained | yes | `re2-wasm` last published 2021; the AdGuard fork in 2026 | no published package found; building one adds a Rust toolchain to the repository | yes (2.8.6, 2026) |

## Consequences

- RE2JS is slower than JavaScript's engine per character. Every pattern names
  text every match holds (`needs`), and a text holding none of it is not read
  by RE2 at all, so most text costs a lowercase copy and a few `includes`.
  Measured: redacting every string in the archived benchmark runs (11,377
  strings, 319 KB) went from 52 ms to 93 ms; the suites' own strings from 34 ms
  to 32 ms (`redactSecrets`) and 94 ms to 179 ms (the credential check, whose
  input is a few hundred characters). The patterns are compiled when the module
  loads, about 25 ms, so a bad pattern stops the server at start.
- RE2 folds case by Unicode's simple folding whatever the flags. The patterns
  JavaScript ran with `i` and no `u` flag now fold only their words
  (`(?i:password)`), so their character classes are the ASCII ones they were;
  in those words the long s (ſ) and the Kelvin sign (K) read as `s` and `k`,
  so `paſsword: hunter22` is now redacted. That is the only difference found.
  Folding all of such a pattern was tried first and found by review to leave
  one crafted token in clear that the old pattern redacted, which is why only
  the words fold.
- A new pattern in these files is written for RE2 and its lookarounds as above;
  the timing tests take about ten seconds in each of the two suites.
- One runtime dependency is added. It has no install script and no
  dependencies of its own.

## Failure direction

Where RE2 and JavaScript differ (a keyword spelled with ſ or K), the
redaction errs towards hiding: text wrongly redacted costs a reader a word; a secret left in clear is
published in the report and every issue exported from it.
