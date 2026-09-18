# 1. Completion is an enforced contract, not a claim

Status: accepted

## Context

An exploratory tester driven by a language model will always be willing to say
it is finished. "Explored the app, found some issues" is the default output of
any agent given a budget and no definition of done, and it is unfalsifiable: the
reader cannot tell a thorough run from one that visited four routes and stopped.

Scripted e2e suites have the opposite problem — they answer "does this still
work?" precisely, and say nothing at all about what they never covered.

## Decision

The engine — not the prompt — decides whether a run is complete.

It scans the project's routes itself, tracks per-route facts (visited /
exercised / audited / mutated / journeyed) and per-role access, and
`scout_report {level}` **gate-checks** those facts before it will produce a report.
At `extensive` it refuses outright while the GAP LEDGER is non-empty; lower
levels generate but disclose their gaps in the document.

Six conditions, chosen because each one catches a distinct way a run can look
finished while being hollow: every known route visited, something actually
exercised on each, every visited route design-audited, every filled form
actually submitted, at least one *completed* journey, and ≥2 roles compared.

## Consequences

"Explored a bit and stopped" is structurally impossible to report as extensive.
The cost is that the ledger must stay honest and actionable in both directions —
see [ADR 3](0003-a-noisy-ledger-is-a-broken-ledger.md), which exists because an
unactionable entry makes this contract unsatisfiable and pushes users toward
`force=true`, which would hollow out the guarantee from the other side.

## Failure direction

Chosen deliberately: **refuse rather than overstate.** A refusal is annoying and
visible; a confident "complete" over a partial run is neither.
