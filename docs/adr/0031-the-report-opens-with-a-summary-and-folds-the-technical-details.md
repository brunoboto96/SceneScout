# 31. The report opens with a Summary and folds the technical details

Status: accepted

## Context

`report.md` and `report.html` are read by two kinds of people. Most of the
people a report is handed to do not read request signatures, route
fingerprints or oracle names: they want to know what was checked, what was
found, how bad it is, and what to look at. The developer who fixes a problem
wants the opposite: every request, id, route and a test skeleton.

The report used to open with a section called "In plain words" and carry the
technical report straight after it, unfolded, with each problem's picture
inside its plain entry. A reader had to scroll past each problem's full entry
to find the next one, the pictures were spread through the text, and the
technical report was as prominent as the summary.

## Decision

The report is laid out in this order, and each part is named for what it is:

1. **Summary**, in plain words: one opening paragraph saying which site was
   checked, when, for how long and with which care level, and what was found;
   the problems as one table (impact, problem, where, what you would see, what
   was expected), worst first; the ticket answers; then each problem folded
   under its number and title, holding its steps, what was expected and what
   happened. A problem's id, category, severity, evidence signature and route sit in a further fold
   inside it, named "Details for developers", so a Summary reader never reads
   them unasked.
2. **Evidence**, only when a problem has a picture or recorded frames: each
   problem's picture beside its number and title, with the frames recorded
   before it was filed. A run with no pictures and no recording has no Evidence
   section at all.
3. **Technical details**, folded: the technical report as it was (run metrics,
   page scores, the gap ledger, each finding in full, what was left
   unexplored). Inside that fold a repro trace is a plain list rather than one
   more fold.
4. **Steps**, folded, in `report.html` only: every action each session took.

`scout_report {report}` picks the audience:

- `both` (the default) writes all of the above.
- `qa` writes the Summary and the Evidence only: no technical details, and
  where `both` would point at the gap ledger, the unchecked parts are listed in
  the Summary instead.
- `dev` writes the technical report alone and unfolded, as it was before the
  plain part existed.

The live view always shows `both`. Nothing the report held before is left out:
a part is folded or moved, never dropped.

## Consequences

- The Summary is the part a person reads first, so its words are held to the
  plain wording of the cards (`plainCard`) and the golden file
  `scripts/golden/plain-section.md`. A technical term that reaches the Summary
  outside a "Details for developers" fold is a defect.
- Problem titles are app-controlled text written inside a raw `<summary>`
  element, where Markdown escapes do not apply. They are written with `&lt;`,
  `&gt;` and `&amp;`, and every reader of the Markdown (`report.html`, the live
  view's report panel) decodes them once before escaping them again, so a title
  reads the same everywhere and never becomes markup.
- A Markdown viewer that does not fold `<details>` shows everything unfolded,
  which is the old layout in a new order; nothing becomes unreachable.
- Tools that parse `report.md` by heading must use the new names: "Summary"
  for the plain part and "Run metrics" for the metrics table that used to be
  called "Summary".
