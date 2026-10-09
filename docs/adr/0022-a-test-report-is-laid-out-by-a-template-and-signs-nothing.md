# 22. A test report is laid out by a template and signs nothing

Status: accepted

## Context

A recorded check (`--record`) leaves `check.json` and `replay.html`: enough for
a developer, not in the shape a reviewer in a regulated team files. That
reader wants each test with its identifier, the requirements it covers, its
steps with the expected and actual results, a pass or fail, the evidence, the
deviations and blank signature blocks, laid out the way their own procedure
says. Every team's procedure says something different, and each uses its own
words for the same kind of test.

## Decision

`scenescout check --record --template <file.json>` renders the recorded run
into a report whose layout comes from the template: the title block, a
document ID pattern, the order of the sections, the columns of the test table,
the sign-off roles, free text, and every word the page writes. The data comes
from the run alone. SceneScout ships no vocabulary of its own for any kind of
test or industry; the template carries it.

- A step's result comes from its own assertions, never from a model, and the
  same run, template and evidence render the same bytes (held by a golden file).
- A step that failed or was refused is a deviation, with its step, expected and
  actual result.
- Traceability is optional metadata on the flow (`id`, `requirements`, a step's
  `expected`) and never changes how it runs. A flow without it still renders,
  with `—` in its place.
- The manifest records the SHA-256 of `check.json`, `replay.html` and every
  frame and video the report links, the SceneScout version, the target and the
  run's times.
- The signature blocks are blank. SceneScout does not sign, approve or upload
  anything.

## Consequences

A template is one more file a project keeps, and a mistake in it stops the
check before it starts rather than after the run. The report is HTML, like the
replay page, and links the frames and videos beside it rather than embedding
them, so the output folder travels as a whole; a PDF is printed from the page.

## Failure direction

A report that claims more than the run proved is worse than one that says
less. A value the run did not supply shows `—` rather than a guess, a file the
manifest cannot read is listed as not found rather than left out, and nothing
in the report is worded by a model.
