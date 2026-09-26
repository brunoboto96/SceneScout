# 4. Findings dedup on machine signals, and a merge must never lose a finding

Status: accepted

## Context

The same bug gets described differently every time it is found — by a later run,
or by two agents exploring in parallel. Without dedup the report accumulates the
same defect under a dozen rephrasings and stops being readable.

Dedup is dangerous in a way the opposite failure is not. A duplicate is visible:
a reader sees two entries and merges them mentally. A wrong merge **destroys
data** — `addFinding` keeps the existing entry and discards the incoming title,
detail and severity — and the loss is invisible, because nothing records that a
finding was ever filed.

Two real losses drove this record:

1. Dedup was route-scoped, so one broken endpoint found from the two pages that
   call it survived as two findings. `evidence` exists precisely to be a machine
   signature, and a machine signature does not care which page you were on.
2. The first attempt at fixing that harvested every status code in an evidence
   string and paired it with every endpoint in it. Evidence written as ordinary
   prose — *"the list loads (GET /api/widgets 200) but POST /api/widgets returns
   500"* — minted a signature for the **healthy** endpoint, and a genuine,
   separate finding about that endpoint was then absorbed and thrown away.

## Decision

Findings merge on an exact `METHOD /path STATUS` triple extracted from
`evidence`, across routes, with guards that all exist to prevent losing a
finding:

- each endpoint takes the status from **its own window** — the text between it
  and the next endpoint mentioned — never from the string at large;
- a status must **follow** its endpoint, so a quantity ("500 items") cannot
  become a status;
- record ids collapse (`/api/orders/176` and `/api/orders/181` are one
  endpoint), so one bug is not filed once per record;
- the merge requires the same **category** — one endpoint+status can carry a
  `security` bug and a `ux-confusing` one;
- a **resolved** finding never absorbs a new one. Without evidence identical
  enough to count as a regression, absorbing would bump a fixed entry's run
  count and the new bug would never appear at all.

Every route-scoped rule — identical evidence, a quoted literal, title tokens —
first requires the two findings to be one **kind** of defect: the same
category, or two categories of one family (a crash filed as `page-error` and as
`console-error`; a refused save filed as `data-loss` and as
`data-inconsistency`). Evidence, a quoted control name and a title say where a
defect is as often as what it is, so on their own they merged two different
defects on one element: a link styled like body text (`ux-polish`) was absorbed
into the finding that the same link was clipped out of view (`visual`). The
presentation kinds — `visual`, `ux-polish`, `a11y`, `missing-testid` — are
each a family of their own, because one element is routinely wrong in several
of those ways at once and the findings name the same test id and label.

Fuzzy matching (title tokens, quoted literals) stays **route-scoped**: it is a
guess, and a guess applied across the whole report merges unrelated bugs. A
quoted literal also merges only within one family of categories, and never when
both findings' evidence names requests with none in common: the machine signal
outranks the guess, so two findings that quote the same button but name
different requests stay two findings.

## Consequences

One endpoint bug reads as one finding however many pages exposed it, and
per-record noise collapses. Two defects on one element stay two when they are
of different kinds. The price is a visible duplicate whenever one defect is
filed under two kinds from different families. The archived benchmark runs show
which labels disagree in practice: `visual` against `ux-confusing` recurs (a
badge covering a button in six runs, a sticky bar covering a button in one),
and `http-error` against `ux-confusing` against `page-error`, and `data-loss`
against `ux-confusing`, appear once each; a presentation defect filed once as
`visual` and once as `ux-polish` joins them. Those duplicates are accepted: a
silent merge can hide a second, real defect on the same element, while a
visible duplicate costs a reader a moment — the direction chosen below.
Two different claims of the SAME kind on one element (clipped, and overlapped,
both `visual`) can still merge on a shared quoted label: telling them apart
would mean comparing prose. Two different bugs on one endpoint+status in the
same category can still merge — accepted, because narrowing further would
require comparing prose, which is what this rule exists to avoid.

## Failure direction

Chosen deliberately: **a visible duplicate over a silent merge.** Where the
evidence is ambiguous, the rule declines to merge. Both known misses go that way
— a status written before its endpoint, and differing evidence on a resolved
finding — and both cost a duplicate rather than a disappearance.
