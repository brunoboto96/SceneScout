# 16. A visual baseline is the project's choice, is kept per browser, and changes only when asked

Status: accepted

## Context

`/scenescout qa compare` (ADR 15) shows one element before and after, between
two deployments. A team also wants the other half of visual regression: an
approved picture of a page or element that every later check is compared
with, so a change nobody approved stops the pull request. The capture and the
pixel diff already existed (`capture.ts`, `png.ts`); what was missing is where
the approved pictures live, what is pictured, how a picture is kept
repeatable, and what an unmet one does to the gate.

## Decision

- **Nothing is pictured unless the project lists it.** `targets.json` in the
  baselines folder names each target as a path and an element: `page` (the
  window, from the top) or a target written the way a saved flow writes one
  (`testid=…`, `text=…`, `label=…`, `role=…`; ADR 12), so there is one grammar
  for naming an element. It is validated before a browser starts; a missing or
  invalid file stops the check with exit 2 rather than comparing nothing. A
  check without `--baseline` takes no picture at all.
- **Ignored by default, committed by choice.** The default folder is
  `.scenescout/baselines/`, which the self-ignoring `.scenescout/.gitignore`
  keeps out of commits, like everything else a check writes there. A team that
  shares baselines names a folder its repository commits with `--baselines`.
  Committing pictures into a project is that project's decision, so it is never
  the default (the least-harm rule of ADR 12).
- **Per browser, with the settings recorded.** Baselines sit under
  `<browser>/<route>/`, and each PNG has a JSON beside it with the path, the
  element, the browser, the operating system, the window, the scale, the margin
  and the motion, animation and caret settings it was taken with. A baseline
  taken with other settings, or one whose files are half there, unreadable or
  another target's, is `unusable`: never compared, and filed as an issue with
  the reason, since a comparison that compared nothing must not pass.
  One taken on another operating system is compared, with a note, because text
  is drawn differently there.
- **Every target is pictured, whatever `--paths` says**, since each names its
  own page; `--paths` scopes the crawl.
- **Repeatable by construction.** A fresh page load per target, from a blank
  page, so a target that differs from the last only by its `#fragment` is still
  a new load; a 1280×900 window and a device scale of 1 named when the check
  attaches rather than left to defaults; one picture pixel per CSS pixel;
  reduced motion requested before the load; fonts loaded before the picture;
  CSS animations and transitions stopped before an element is measured (a
  target that itself moves would otherwise be cropped mid-movement) and the
  caret hidden for the screenshot. An element larger than the window is
  pictured where it is inside it, and the result says so. The baseline phase
  runs after the crawl and before saved flows, so a picture is of the page as a
  visit finds it, and the motion setting is put back before the flows run.
- **An unmet baseline is high, like a broken flow.** A change past
  `--baseline-threshold` (default 0%), any change of size, a baseline that
  cannot be used, and a target that could not be pictured are each one
  `visual-change` issue, high. ADR 11 keeps
  the default gate for what proves a page broken; a baseline, like a saved flow,
  is an expectation the project wrote down and asked the check to hold, so a
  change it did not approve fails the default gate. `--fail-on never` reports
  without failing; `--ignore visual-change` drops them. No baseline yet is
  listed and never fails. The fingerprint is the target and the browser, not
  the evidence, so the same element changing by another amount is one alert.
- **Only `--baseline update` writes a baseline**, and it rewrites only what
  compare would not accept: a baseline within `--baseline-threshold` (at the
  default 0%, one where no pixel changed beyond the diff's allowance of 8 in 255
  per colour channel) is left alone, so an update that changes nothing changes
  no file and noise under the threshold does not churn the folder. This is the
  behaviour of Playwright's `--update-snapshots=changed`. `compare` never writes
  a baseline; it writes the baseline, the picture now and the diff of a changed
  target beside the report, after removing the pictures an earlier run left
  there (only files named as a check names them, so nothing else in a project's
  output folder is touched).

## Consequences

- Baselines taken on one machine rarely hold on another operating system. The
  documented answer is to take them where the check runs (a hand-started
  workflow that keeps the folder as an artifact), not to raise the threshold
  until noise passes.
- A target removed from `targets.json` leaves its files behind; an update does
  not delete what it was not asked about.
- Content that changes on its own (dates, random images, animation driven by
  script) cannot be held by a pixel baseline. The answer is a steadier target or
  a threshold, chosen by the project.

## Failure direction

When a picture cannot be taken or compared, the check says so and fails: a
target that could not be pictured, and a baseline it cannot use, are each an
issue. Only a target with no baseline yet passes uncompared, and the verdict
line counts it. A visual gate that passes because it compared nothing would be
worse than no visual gate, since it would be trusted.
