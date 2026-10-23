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

## The second round (#618)

Every regular expression in `src/` was listed and checked for super-linear
matching with a static checker, and each one it flagged was timed on JavaScript's
engine at 10 KB, 100 KB and 1 MB. The ones that read text the app controls or a
lane writes were converted:

- whole files, now held by the guard in memory-test: the crawl's download and
  interruption rules (`crawl.ts`), the JWTs a saved profile holds (`expiry.ts`),
  a lane's landing route and name (`brief.ts`), the planning crawl a split run
  reads (`ci-lanes.ts`), the lane report and the requests its evidence states
  (`lane.ts`), finding dedup (`finding-dedup.ts`), the tokens a page posts
  (`postmessage.ts`) and the strict write classifier (`strict-writes.ts`);
- single patterns in files that also hold patterns on SceneScout's own input:
  a page URL's fragment and a markdown cell (`check.ts`), a request path's
  trailing slashes (`flow.ts`), a route pattern (`from-run.ts`) and the words
  on a button that leads away from a scripted sign-in (`scripted-login.ts`).

Three ways of writing a pattern were added to those above:

- JavaScript's `^` with the `m` flag is `notAfter: NOT_LINE_END` (RE2's `(?m)`
  counts only `\n` as a line end); the pattern is registered with its `m` flag.
- A lookahead inside one alternative of a pattern that is only tested ("continue
  with" not before an email, a phone or a code) is its own search, checked in code
  at each match, beside the pattern without that alternative. Refused by `accept`
  inside the one pattern, each candidate would search on from the next character
  and read again to the line's end for an earlier alternative's `.*`, which is
  quadratic again. A test holds the function to the old pattern.
- Where RE2's captures make a pattern slow on a long match (`statedRequests`
  took 6 s on a 1 MB path), RE2 reads the head and the greedy runs after it are
  read in code. A test then holds the function to the old JavaScript one,
  written out in memory-test, on the same inputs as the patterns.

Two corrections came with the second round:

- JavaScript without the `u` flag reads UTF-16 code units and RE2 reads code
  points, so a count such as `[^"]{8,80}` took four emoji as four characters
  where JavaScript took them as eight. A pattern built by `fromJs` is now read a
  code unit at a time (`codeUnits`): each surrogate is handed to RE2 as a
  private-use character U+E000 to U+E7FF, one code unit as well, so every index
  stays as it is. `fromJs` refuses a pattern that names a surrogate or one of
  those characters, or a range over some of them, as it would read them apart.
- Finding dedup compares every stored finding with every other when the store
  loads, and on RE2 a pair took about four times as long (300 findings: 2.5 s on
  JavaScript's engine, 10 s on RE2). Each title and piece of evidence is now read
  once and kept (the last 4,096 of each), and the same 300 take about 0.4 s.

Patterns stay JavaScript where they read only SceneScout's own input (command-line
arguments, the configuration file, environment variables, `ps` output, the source
tree a scan reads, Playwright's error messages), where their input is capped short
of harm, or where they run inside the page under test (the page could stall itself
anyway, and RE2JS is not there).

## Not converted yet

Files another change was editing at the time hold flagged patterns that read app
text: `browser.ts` (a URL's fragment), `design.ts` (pixel and colour values from
computed styles), `plain.ts` (step text of the plain report) and `report.ts` (the
report's own folds). The other readers of app text (the request replay, the
oracles, the claims checks, the export of findings, the signed-in check, the form
and injection readers) hold patterns the checker found linear; they are converted
the same way when they change.
