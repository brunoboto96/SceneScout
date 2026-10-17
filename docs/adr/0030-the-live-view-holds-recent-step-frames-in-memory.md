# 30. The live view holds recent step frames in memory

Status: accepted — amends [ADR 7](0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md)

## Context

The live view's close-up has a timeline of a session's steps. On a run that did
not record ([ADR 8](0008-a-recorded-run-is-evidence-and-must-be-asked-for.md)),
no step had a frame, so every step on the timeline led to a message that the
page "may be closed, or not answering". The run was healthy, and recording is
not on by default, so most people who opened the timeline saw a feature that
looked broken.

ADR 7 says a frame taken for a viewer is not logged and an unwatched run pays
nothing. Both stopped the timeline from working on an ordinary run.

## Decision

While the live view is running, the engine takes a frame of the page after each
step of a run that does not record, the same masked picture the live view's
thumbnails use, and the live view holds it in memory:

- At most the last 100 steps of each session, and at most 12 MB of frames per
  session. The oldest frame goes first. A frame larger than that bound is not
  kept.
- Never written to disk. The action log stores only the frame's address in
  memory (`heldFrame`), not the picture. A report, `report.html` and an export
  never use a held frame.
- Dropped when the session closes.

A step whose frame has aged out says so and how to keep every frame (recording).
The "may be closed, or not answering" message is used only for a live page that
does not answer. A recorded run keeps writing its frames to disk as before.

## Consequences

Each step costs one more screenshot when the live view is running: about 40 ms
per call on the measured local runs (20 navigate and snapshot calls took 6.7 s
with held frames against 5.9 s without). `SCENESCOUT_LIVE=off` turns the live
view off, and the cost with it.

A running engine holds up to 12 MB of pictures per open session in memory.
Like the live view's thumbnails, these pictures have secret fields painted over
and are served only on loopback behind the token.

## Failure direction

A frame that cannot be taken in time is not kept, and the step says it has no
frame. The step itself never fails because of it.
