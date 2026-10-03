# Validation on public open-source web apps

SceneScout is developed against its own [demo app](../demo-app/) and a
[held-out app](../holdout-app/), and both have answer keys. Those apps were
built to be tested, so they cannot show how the engine behaves on an app nobody
designed for it. This page records runs against well-known open-source web apps,
gives a scorecard for each, and judges every issue raised as real or a false
positive.

The apps are named here because the scorecard is only useful if someone can
repeat it. The engine was not tuned to any of them. The engine problems they
exposed are filed as generic issues, and the defects found in the apps
themselves are written up for their own maintainers, not kept in this repository.

## Method

- **Version:** SceneScout 3.17.0, run from a build of this repository.
- **Where the apps ran:** each app ran in a Docker container started for the
  run, on a loopback-only port, with no real data. The containers, their volumes
  and their images were removed afterwards. No public demo instance was used, so
  no third party's servers or terms of use were involved.
- **Commands:** for each app, the first look (`scenescout <url>`: observe mode,
  20 pages, 3 minutes) and then the deterministic check (`scenescout check <url>
  --mode read-only --max-routes 60`), both signed out. Each ran with a temporary
  home directory and project folder, so no earlier run's memory or saved flow was
  read. The first look's issues are a subset of the check's (same rules, fewer
  pages), so the judgement below is made on the check.
- **Judging:** every issue except contrast was re-checked by hand in Chromium:
  the element's accessible name from Playwright's `ariaSnapshot`, its markup,
  and its computed style before and after focus. Contrast issues were judged by
  whether the background the engine measured is the one on screen. The colour
  values themselves are exact measurements and were not disputed.
- **Not counted:** the "worth a look" observations (spacing off a 4px grid,
  links styled like body text). They are defects only under a project's own
  convention ([ADR 13](adr/0013-a-convention-is-the-projects-to-decide.md)).
- **Times** are wall-clock, on a laptop, with the three apps checked in parallel.

## Summary

| App | Kind | Pages checked | Check time | Issues (high · medium · low) | Real | False positive | Unclear | Precision |
|---|---|---|---|---|---|---|---|---|
| Gitea 1.27.3 | Self-hosted Git forge, server-rendered | 60 (18 more found) | 75 s | 84 (0 · 44 · 40) | 67 | 16 | 1 | 81% |
| Ghost 5.130.6 | Publishing platform, default theme | 8 | 9 s | 15 (1 · 3 · 11) | 10 | 4 | 1 | 71% |
| Excalidraw (image of 2026-05-06) | Single-page drawing app | 1 | 3 s | 24 (0 · 1 · 23) | 23 | 0 | 1 | 100% |
| **All** | | **69** | | **123** | **100** | **20** | **3** | **83%** |

Precision is real ÷ (real + false positive), leaving the unclear issues out.
These are three apps on one day. Treat the percentages as a first reading, not
a rate.

What the numbers say:

- **Most real issues are accessibility defects.** They are icon-only controls
  with no name, fields labelled only by a placeholder, missing focus styles, and
  text below WCAG AA contrast. These are the defects a deterministic check is
  built to catch, and in all three apps they held up when re-checked by hand.
- **The false positives come from five rules, and every one has a filed
  issue.** The only high issue across the three apps was a false positive. In
  two of the three apps, a false positive reached the first look's "look at
  these first" list.
- **A first look covers little of an app with deep links.** On the forge, the
  first look stopped at its 20-page cap with 27 more pages found. The check at
  60 pages still left 18 unvisited.
- **A single-page app is one route.** The drawing app has no links, so both
  commands measured its start screen only. Anything behind a click needs an
  exploratory run.

## Gitea 1.27.3

`gitea/gitea:1` image, SQLite, install wizard skipped. Before the run, one user,
one public repository (README and licence), one issue and one organisation were
created through the API. Both runs were signed out.

| Run | Pages | Time | Issues (high · medium · low) |
|---|---|---|---|
| First look (observe) | 20, stopped at the cap with 27 more found | 24 s | 37 (0 · 14 · 23) |
| Check (read-only, 60 pages) | 60, 18 more not visited | 75 s | 84 (0 · 44 · 40) |

Issues from the check, by rule:

| Rule | Severity | Count | Real | False positive | Unclear | Reason |
|---|---|---|---|---|---|---|
| `placeholder-only-label` | medium | 17 | 17 | 0 | 0 | The search fields' only name is their placeholder: no label, `aria-label` or `aria-labelledby`. |
| `unnamed-control` | medium | 17 | 10 | 6 | 1 | Real: icon-only buttons in the diff view, a copy button, heading permalink anchors, empty links on the activity bar, an avatar link with no `alt`, a combobox with no name. False positive: the browser names 1 link from a descendant's `aria-label` and 5 avatar links from the image's `title` ([#375](https://github.com/brunoboto96/SceneScout/issues/375)). Unclear: 1 element on the activity page could not be found again by hand. |
| `dead-end` | medium | 8 | 0 | 8 | 0 | Each is an RSS feed or a plain-text file, not an HTML page ([#373](https://github.com/brunoboto96/SceneScout/issues/373)). |
| `auth-redirect` | medium | 2 | 0 | 2 | 0 | The "new issue" and "edit file" routes require sign-in. For a signed-out run that is expected ([#374](https://github.com/brunoboto96/SceneScout/issues/374)). |
| `contrast` | low | 38 | 38 | 0 | 0 | The default theme's primary blue is 3.99:1 on white, its green status colour 2.57:1 and its yellow 1.70:1. Every one was measured against the background actually behind the text. |
| `focus-indicator` | low | 2 | 2 | 0 | 0 | Focusing the footer's theme and language dropdowns leaves their outline, shadow, border and background unchanged. |

Engine problems seen: [#373](https://github.com/brunoboto96/SceneScout/issues/373),
[#374](https://github.com/brunoboto96/SceneScout/issues/374),
[#375](https://github.com/brunoboto96/SceneScout/issues/375). Feeds and raw files
also count against `--max-routes`, so they push real pages out of a capped run.

## Ghost 5.130.6

`ghost:5-alpine` image in development mode, SQLite, default theme (Source
1.5.0), with only the content a fresh install creates. Both runs were signed out.

| Run | Pages | Time | Issues (high · medium · low) |
|---|---|---|---|
| First look (observe) | 8 | 10 s | 15 (1 · 3 · 11) |
| Check (read-only) | 8 | 9 s | 15 (1 · 3 · 11) |

| Rule | Severity | Count | Real | False positive | Unclear | Reason |
|---|---|---|---|---|---|---|
| `blocking-overlay` | high | 1 | 0 | 1 | 0 | The sign-in modal is open and drawn inside a full-viewport iframe, and the scroll lock behind it is deliberate ([#370](https://github.com/brunoboto96/SceneScout/issues/370)). |
| `placeholder-only-label` | medium | 2 | 2 | 0 | 0 | The two subscribe email fields have no label, and their placeholder is an example address. |
| `unnamed-control` | medium | 1 | 1 | 0 | 0 | The author avatar link holds only an svg with no title when the author has no picture. |
| `contrast` | low | 6 | 5 | 1 | 0 | Real: the default accent colour is 3.71:1 against white in both directions. False positive: white heading text over the hero image was measured against the white page background, giving 1.00:1 ([#371](https://github.com/brunoboto96/SceneScout/issues/371)). |
| `focus-indicator` | low | 3 | 1 | 1 | 1 | Real: the subscribe field has no focus style (re-checked). False positive: one sample was the iframe element itself ([#376](https://github.com/brunoboto96/SceneScout/issues/376)). Unclear: the search button was not re-checked by hand. |
| `image-aspect` | low | 1 | 0 | 1 | 0 | The hero image uses `object-fit: cover`, so it is cropped, not distorted ([#372](https://github.com/brunoboto96/SceneScout/issues/372)). |
| `overlapping-controls` | low | 1 | 1 | 0 | 0 | The inline Subscribe button covers the end of the email field: the field's right padding is 26 px and the button is about 147 px wide, so a long address is drawn under the button. |

Engine problems seen: [#370](https://github.com/brunoboto96/SceneScout/issues/370),
[#371](https://github.com/brunoboto96/SceneScout/issues/371),
[#372](https://github.com/brunoboto96/SceneScout/issues/372),
[#376](https://github.com/brunoboto96/SceneScout/issues/376). One unfiled detail:
the routes table shows a status of `?` for one hash route (`/#/portal/signup`)
and 200 for its siblings, because reaching a hash route loads no new document.

## Excalidraw

`excalidraw/excalidraw:latest` image, built 2026-05-06 (digest
`sha256:f7ee194a…`). It shows an empty canvas and stores nothing on a server.

| Run | Pages | Time | Issues (high · medium · low) |
|---|---|---|---|
| First look (observe) | 1 | 4 s | 24 (0 · 1 · 23) |
| Check (read-only) | 1 | 3 s | 24 (0 · 1 · 23) |

| Rule | Severity | Count | Real | False positive | Unclear | Reason |
|---|---|---|---|---|---|---|
| `unnamed-control` | medium | 1 | 1 | 0 | 0 | The main menu button holds only an `aria-hidden` svg and has no `aria-label` or `title`. |
| `contrast` | low | 22 | 22 | 0 | 0 | The welcome screen's hint text is 1.98:1 on white and its menu items 2.85:1. They are faint by design, but they carry real instructions. |
| `focus-indicator` | low | 1 | 0 | 0 | 1 | The app's root container takes focus so it can receive keyboard shortcuts. An outline around the whole viewport is not clearly expected. |

No engine problems were seen beyond the one-route limit described in the summary.

## What came of it

- **Engine issues filed:** [#370](https://github.com/brunoboto96/SceneScout/issues/370)
  (overlay inside an iframe),
  [#371](https://github.com/brunoboto96/SceneScout/issues/371) (contrast over a
  positioned image), [#372](https://github.com/brunoboto96/SceneScout/issues/372)
  (`object-fit`), [#373](https://github.com/brunoboto96/SceneScout/issues/373)
  (feeds and text files as dead ends),
  [#374](https://github.com/brunoboto96/SceneScout/issues/374) (sign-in
  redirects with no session), [#375](https://github.com/brunoboto96/SceneScout/issues/375)
  (names from a descendant's `aria-label` and an image's `title`),
  [#376](https://github.com/brunoboto96/SceneScout/issues/376) (an iframe as a
  tab stop). Fixing them would have removed all 20 false positives above.
- **Defects in the apps:** drafted as bug reports for their maintainers, one per
  defect, and filed upstream only after review. When an upstream issue exists,
  it will be linked here.

## Repeating it

```bash
npm run build
# start the app in a container on a loopback port, e.g. -p 127.0.0.1:18301:3000
node dist/cli.js http://localhost:18301/ --out first-look
node dist/cli.js check http://localhost:18301/ --mode read-only --max-routes 60 \
  --project "$(mktemp -d)" --out check
```

Use a fresh `--project` folder each time, so the check reads no memory or saved
flows from an earlier run. Remove the container and its volumes afterwards.
