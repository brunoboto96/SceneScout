# 21. Update the docs in the same pull request

Status: accepted

## Context

A behaviour change can land in the engine while the README and `docs/` still
describe the previous one. The configuration reference is held equal to the
CLI by a test, so a new option fails that test until the reference names it.
The narrative pages are not: the README, the guide's explanations, `docs/ci.md`
and `docs/how-it-works.md` can stay wrong after the code is merged, and a
reader follows the page.

Leaving the docs for a later pull request is how that happens. The later
pull request is easy to drop, and the code review no longer has the page
beside the change.

## Decision

A pull request that changes what a user can do or see updates the README and
the pages under `docs/` that describe that behaviour, in the same pull
request. That includes a new or changed command, option, environment
variable, default, report section, or a step a person runs.

A change with no user-facing surface does not require a docs edit: a
refactor, a test, a comment, a dependency bump, or a fix whose observable
behaviour is already what the docs say. Say so in the pull request when it
is not obvious.

The configuration reference stays the list of every option and variable. A
narrative page does not have to repeat it. It has to stay true.

## Consequences

A pull request that changes behaviour is larger by the pages it touches.
Two pull requests that edit the same page can conflict; the page belongs to
the pull request whose behaviour it describes.

## Failure direction

Docs that mention a behaviour before the code has it are worse than docs
that are one pull request behind, because a reader follows them. The docs
change rides in the pull request that makes the behaviour true, not in an
earlier one.
