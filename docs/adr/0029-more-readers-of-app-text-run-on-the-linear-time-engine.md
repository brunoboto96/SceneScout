# 29. The route, ticket, calibration and write-policy readers run on the linear-time engine

## Context

[ADR 28](0028-patterns-on-app-text-run-on-a-linear-time-engine.md) moved
redaction and the guided credential check onto RE2JS. Other code reads text the
app under test or a ticket supplies with JavaScript regular expressions: the
routes a page links to and a lane reports (`fingerprint.ts`), the tickets a
person pastes (`tickets.ts`), the request paths a lane's evidence quotes
(`calibration.ts`) and the labels, URLs and bodies the write policy judges
(`policy.ts`). Measured on JavaScript's engine, four patterns took quadratic
time: a route of hyphenated words (the credential pair in `stripRouteQuery`),
a route ending in a long run of slashes, a word edged by long runs of quotes and
marks, and a ticket heading edged by a run of colons. Each took 0.6 s on 20 KB
and 2.6 s on 40 KB, which is minutes to hours on 1 MB.

## Decision

The patterns in those four files run on the engine of ADR 28. They are built with
`fromJs(source, flags)` in `src/engine/js-regex.ts`, which reads the pattern as
JavaScript wrote it and rewrites the places RE2 differs: `\s`, `\S` and `.` become
JavaScript's sets, the `i` flag folds the letters JavaScript folds without `u`
(and not the long s or the Kelvin sign), `\uXXXX` becomes `\x{XXXX}`, and `[\s\S]`
becomes any character. What RE2 cannot run (a lookaround, a back reference, a
named group, `\b` in a class) is refused, and such a pattern is written for
`LinearRegex` by hand. So is what RE2 would read otherwise than JavaScript: an
escaped letter JavaScript reads as the letter itself (`\a`, `\z`, `\A`, `\Q`),
`\p{…}` (the letter p to JavaScript without `u`), and with `i` a class range the
flag folds past its ends (`[à-þ]`).

Every pattern `fromJs` builds is kept with the JavaScript source it stands for
(a hand-rewritten lookaround passes the original as well). memory-test holds each
to a `RegExp` of that source on the string literals of the suites that exercise
them and on generated strings: the first match, its index and its groups must be
the same. That test is the identity check for any pattern added through `fromJs`
later. The same suite fails if any of the four files, or `js-regex.ts`, holds a
JavaScript regular expression, and runs a 1 MB adversarial text for each family of
pattern in the child process of ADR 28.

Rewritten lookarounds, in the order they appear:

- A negative lookahead at a pattern's end (`reset` not before a view word,
  `discard` not before `changes`, `remove` not before a filter at the end of the
  label) is an optional last group: it is there exactly when the lookahead's text
  is, and `accept` refuses the candidate when it is.
- The negative lookbehind of `remove` (a filter or chip, then one to three spaces
  or hyphens) is a check of the characters before the candidate, in constant time.
- The positive lookbehind of an id segment (`templateIds`) is the path's head
  matched as part of the match and handed back; a chain of template segments is
  one match whose segments are replaced one by one, because a `*` ends what the
  next segment's lookbehind can see.
- The lookahead after a fragment's `#` is the pattern's last group, and the
  fragment is read to its end in code.

Patterns that only read SceneScout's own input (command-line arguments, the
configuration file, its own file names) stay JavaScript. The path check for a
network path on Windows in `tickets.ts` became a prefix check rather than a
pattern.

## Consequences

- The old and new functions were compared on every string literal in the
  repository's sources and suites and on generated strings, over 29 exported
  functions of the four files, and gave the same result every time. The patterns
  themselves were compared the same way (122 patterns, 3.5 million comparisons).
- RE2JS is slower per call. `isDestructive` took about 0.3 microseconds per
  typical label and takes about 2.7; `normalizePath` went from 1.3 to 5 microseconds.
  Each destructive pattern names the text every match holds (`needs`), so a label
  without a verb is not read by RE2 at all.
- Where JavaScript read both `i` and `u` (the sign-off pattern), its `\b` counts the
  long s and the Kelvin sign as letters of a word and RE2's does not. A label such
  as `Sign-offſ` is therefore refused as destructive where it was not. That errs
  towards refusing, the direction the write policy takes when it cannot tell.

## Not converted yet

Regular expressions remain in other files that read text the app controls or a
person pasted, such as the request replay, the oracles, the claims checks, the
export of findings, the signed-in check, the form, injection and postMessage
readers, the scripted login, the plain report, and the lane report. They are
converted the same way, one family at a time, with `fromJs` and the identity and
timing checks above; the guard in memory-test lists the files already held.
