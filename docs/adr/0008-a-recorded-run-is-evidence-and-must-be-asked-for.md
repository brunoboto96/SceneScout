# 8. A recorded run is evidence, and it has to be asked for

Status: accepted

Amends [ADR 7](0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md),
which says no frame touches the disk. That rule still holds for the live view.
This record carves out the one exception and fences it.

## Context

The live view answered "what is it doing right now". It could not answer
"what did it do", and neither could the report on its own.

Two things went with the process that produced them. The report was rendered
from memory and served from the board, so refreshing the page after the run
ended lost it, and the board itself went blank once the last browser closed.
And the report says what happened in prose — a finding's repro trace lists the
actions, and the reader has to take the engine's word for what the page looked
like when they ran.

For the work this tool is used for, that second gap is the expensive one.
Someone doing QA has to show what they checked, not assert it. A finding with
the screen behind it is evidence; the same finding without one is a claim.

ADR 7 refused a directory of screenshots for good reasons, all of which still
apply: frames outlive the run, get committed by accident, and hold exactly the
data that redaction cannot reach, because redaction cannot read a picture.

## Decision

A run can be recorded, and a recorded run is written as one page.

- **Off unless asked for.** `scout_attach` takes `record: true`. Nothing is
  written otherwise, and the report reads exactly as it did before. The person
  who turns it on is the person who decided their project folder may hold
  pictures of the app they are testing.
- **Frames land in the project's own memory directory**, under
  `.scenescout/recordings/<session>/`, which already holds the action log and
  already ignores itself: the engine writes a `.gitignore` of `*` inside that
  directory on first attach, so a `git add -A` in the tested project cannot
  pick the frames up. The path is
  built by `framePath` in `replay.ts`, never from an agent-supplied string:
  a session named `../../etc` names a file, not a directory to escape into.
- **Bounded.** At most `RECORD_MAX_FRAMES` per session, one frame per action,
  each capture under its own timeout. A capture that fails or times out loses
  that frame and never fails the action.
- **The run gets an address.** `run` serves the whole thing as a single
  self-contained page: the report, every session's steps in the blocks its
  tasks made, and the frames under both. `scout_report` writes the same
  document to `report.html`, beside `report.md`, so it survives the process
  that made it and opens from the file system with nothing running.
- **A finding's frames are its own session's.** Several browsers run at once
  and their steps interleave in one log, so a finding records which session
  filed it and its evidence is drawn from that session's trail alone.
- **Same escaping, one page, no assets.** Every piece of text in that document
  comes from the app under test or the agent, so all of it is escaped on the
  way in. The page loads nothing from anywhere, and the live view serves it
  under the same Content-Security-Policy as the board.

The live view's own frames are unchanged: thumbnails and stream frames are
still held in memory and never written.

## Consequences

Turning recording on means a folder of screenshots of somebody's application
sitting in their repository, and no redaction can inspect it. That is the cost,
it is why it is off by default, and it is why the flag is named for what it
does rather than for a quality setting.

A recorded run is heavier than an unrecorded one: a capture per action, on a
browser that may be mid-navigation. The timeout is what keeps that from
reaching the run — a slow capture is skipped, not waited on.

The report's markdown stays the source of truth. The page is a rendering of it
plus the trail, so anything that reads reports keeps working, and a run with no
recording still produces the page, minus the pictures, saying so.

## Failure direction

When a frame is missing — never captured, cap reached, or the file has since
been deleted — the step and the finding are still shown, without the picture.
The opposite error, hiding a finding because its evidence could not be
produced, would lose the finding. A report that shows less is recoverable; one
that shows nothing is not.
