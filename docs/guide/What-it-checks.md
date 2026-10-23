# What it checks

> **Who this is for:** anyone who wants to know what a run can and cannot find.
>
> **What you will be able to do:** read a finding's category, ask the agent for the right tool, and know what is checked without being asked.

What SceneScout looks for on every page, and the tools an agent uses to look. The agent picks the tools; you rarely call them by hand.

## Checks that run after every action

Every tool that acts on the page returns, with its result, whatever went wrong while it ran. Nothing has to be asked for:

- **Errors.** Console errors, uncaught exceptions, failed requests and HTTP 4xx and 5xx responses.
- **Layout, from boxes rather than pixels.** Controls that overlap, sit off-screen, are covered by pinned chrome, or are clipped inside a container that cannot scroll (`UNREACHABLE`). A scroll lock a closed modal left behind is reported as `SCROLL LOCKED`.
- **Broken images**, read from the page, including an image whose address answered 200 with something that is not an image.
- **A page that contradicts the server.** `refused_empty`: a list request was refused and the page shows its empty state with no error. `false_success`: a save was refused and the page says it worked.
- **Injected markup.** `dom_injection`: a markup-shaped value the agent typed later renders as an element, on any page any session opens (stored or reflected injection).
- **A token sent to any window.** `postmessage_token`: the page calls `postMessage` with targetOrigin `"*"` on a message that carries a token (a JWT, a `Bearer` value, or an opaque value under a key such as `access_token`). The report names where in the message it was, its shape and its first four characters, never the token.
- **Signed out mid-run.** Repeated bounces to the sign-in page raise `SESSION AUTH LOST`, and a route reached while signed out is not counted as covered.

`scenescout check` measures the same things on each page with no model; [Configuration reference](Configuration-reference.md#check-rules) lists its rules.

## The tools

| Phase | Tools | What they do |
|---|---|---|
| Set up | `scout_playbook` `scout_intake` `scout_guided_plan` `scout_guided_confirm` `scout_scan` `scout_attach` `scout_login` `scout_session` | Hand the testing method to an agent with no skill loaded; ask the guided start as one form where the client can show one; turn a person's choices into a guided plan, and ask the person, in the server's own form, to confirm a care level that writes; discover routes; save a sign-in for a role; open a browser in a write mode; list the live sessions, pick the default one, set its pace and the area it is checking |
| Explore | `scout_crawl` `scout_coverage` | Visit every known route in one call; ask what is still untested |
| Look | `scout_snapshot` `scout_hover` `scout_screenshot` `scout_capture` | Read the page as a structured list (diffed on a second look); reveal tooltips and hover cards; take pixels only when they are needed; save one element as a PNG to show someone |
| Ask the server | `scout_request` `scout_network` | Call the app's own API as this session, with the UI bypassed, so a hidden button becomes a proven refusal; list the requests the page made since it loaded |
| Act | `scout_click` `scout_type` `scout_select` `scout_upload` `scout_press` `scout_scroll` `scout_navigate` `scout_back` `scout_run_plan` | Drive the page as a user does; `scout_run_plan` runs a whole mechanical sequence in one call |
| Assess | `scout_design_audit` `scout_journey` | Score a page for accessibility, craft and consistency; measure how hard a task is to complete |
| Record | `scout_note` `scout_finding` `scout_resolve` `scout_report` | Keep durable notes about the app; file deduplicated findings; mark fixes; write the report |
| Answer tickets | `scout_tickets` `scout_criterion` | Read the acceptance criteria in pasted or uploaded tickets; record each as passed, failed or not tested, with a confidence |
| Re-test | `scout_verify` `scout_recheck_plan` | List the findings earlier runs left open, worst route first, and record whether each is gone, still there or changed; for a guided surface, plan a re-check of them in the care level they were found in, never a looser one, confirmed again by the person where it writes |
| Split the work | `scout_lane_brief` `scout_lane_report` | Divide the app between parallel agents by whole module; fold what each hands back, and name any defect it judged but never filed |
| Watch | `scout_status` | Each session's objective, task and findings so far; in a client that renders MCP Apps, a pane that refreshes itself. In a guided check, the check's progress in plain words and its newest cards |
| Save a check | `scout_saved_checks` | List, save, run again or delete the person's saved guided checks (deleting one that is already gone succeeds and says so): the choices of a check under a name, never a credential, owner-only in `.scenescout/guided/`; running one again builds a new plan, confirmed again where it writes |
| Read the findings | `scout_cards` `scout_feedback` | Show findings as plain cards, worst first, with their pictures; record the person's own "not a bug" or "confirmed" on one, which keeps the finding, and list those labels for a maintainer |
| Share | `scout_team_report` `scout_recap` | Write the team report: a page with a cover, the check's problems as cards with pictures, what was not checked and blank sign-off lines, and an evidence folder with the pictures, the report as Markdown and a manifest of every file's SHA-256. Once a guided check has ended, `scout_recap` returns its end-of-check card as an SVG picture and as lines (the address, pages checked, problems by impact, problems a re-check confirmed fixed, the time it took), built from the check's figures only, and writes it to `.scenescout/recap.svg` when asked to save it; the team report's result carries the same picture |
| File tickets | `scout_ticket_preview` `scout_ticket_file` `scout_ticket_status` | Preview the problems the person chose as GitHub or Jira tickets, reading the tracker for what is already filed and sending nothing; then file exactly that preview, only once the person says yes in the server's own form, within 10 minutes and while those problems are unchanged. The issues are the ones `scenescout export` files, with its marker, so neither files a problem twice. `scout_ticket_status` lists the tickets the project filed and whether each is still open, and whether its problem is still open in the project, reading each tracker at most once every 5 minutes |
| Close | `scout_close` | Close one session or all of them |

A few do more than their name suggests:

- **`scout_crawl`** is the whole breadth pass in one call, with each route's status, element count and problems.
- **`scout_run_plan`** runs up to 20 steps (fill a form, submit, check) with targets such as `testid=…` and `text=…`, and stops at the first problem.
- **`scout_journey`** wraps one goal and reports the steps it took, the screens it passed through and where the user had to go back. An abandoned journey is a finding a passing end-to-end suite cannot produce.
- **`scout_upload`** attaches a valid file made in memory (a real PDF or PNG, its kind taken from the input's `accept`), so upload forms stop being a blind spot.
- **`scout_click {clicks: 2}`** is the impatient user: it says whether a double-click sent the same state-changing request twice.
- **`scout_request`** calls the app's API as the session, so "the button is hidden" becomes "the server refuses it", or does not.

## Everything else it does

- **Snapshots that diff.** A second snapshot of the same route returns only what changed, and refs stay valid (on a 130-element page, 10.7 kB became 0.7 kB).
- **Several roles at once.** Calls to different sessions run in parallel; `safe-write` ownership is shared, so one role can create what another approves. The report has a role capability matrix.
- **Design audit with page scores.** Measurable defects (contrast, small targets, clipped text, missing focus, cards touching with no gap between them) apart from craft suggestions, and a 0 to 100 score per page kept from run to run. The shared shell is scored once, separately. See [how a page is scored](#how-a-page-is-scored).
- **Scrolls like a user.** It finds the inner scroll pane on app-shell layouts, and scrolls one region when a page has several.
- **Memory across runs.** States are fingerprinted, so the next run skips what the last one covered; `scout_note` keeps what the agent learned about the app in `.scenescout/ASSUMPTIONS.md`.
- **A gap ledger it can be held to.** Each entry is something to do, not noise (a search box is not a form left unsubmitted), and API and download addresses never enter the route list.
- **Robust as a long-running server.** A time limit on every tool, a Chromium left behind by a crash cleaned up on the next start (Firefox and WebKit are not), and a bounded close.

## How a page is scored

A design audit ends with a page score and the reasons for it:

```
PAGE SCORE: 62/100 (D) — a11y 100 · craft 48 · consistency 76 · task-clarity 100
  why: -16 touching containers ×2 · -12 6 button heights · -10 11 grays
```

Each rule the audit measures costs points for each time it is seen, up to a cap, so one rule cannot sink a page on its own. The overall score is 100 less every deduction. Each of the four subscores is 100 less twice its own deductions, so the part of the page that holds the cause is the one that drops. The `why:` line lists the three largest deductions.

| Dimension | What costs points |
|---|---|
| a11y | contrast failures (3 each, up to 15), no visible focus (4 each, up to 12), small targets (2 each, up to 10), unnamed controls (5 each, up to 15), fields labelled only by a placeholder (3 each, up to 9) |
| craft | touching containers (8 a pair, up to 24), readability (2 each, up to 8), grays beyond 6 (2 each, up to 12), accent hues beyond 5 (2 each, up to 6), pure black body text (2), template tells (3 each, up to 9), clipped text (3 each, up to 9), distorted images (4 each, up to 8) |
| consistency | button heights beyond 3 (4 each, up to 12), button radii beyond 2 (3 each, up to 9), shadow styles beyond 3 (2 each, up to 8), paddings off a 4px grid (6), margins off it (4), near-miss alignments (2 each, up to 6), font sizes beyond 7 (2 each, up to 8), sizes under 1px apart (3) |
| task clarity | task-effort issues (6 each, up to 18), sideways scroll (12), heading structure (3 each, up to 9) |

**Touching containers** are sibling boxes drawn as separate cards (a border, a background unlike what they sit on, or a shadow) with 0 to 2px between them on the axis they are stacked on. They count when a corner where they meet is rounded as much as the box's other corners. A list group, an accordion, table rows, tabs over their panel, a segmented control or full-width bands meet with square corners on purpose, shadowed or not, and grouped chat bubbles tighten the corners where they meet; none of these is counted, and nor are the app's navigation, header or footer, or a carousel's slides that the carousel hides. Two cards with square corners meeting are not counted either, since nothing tells them apart from a joined group, and cards that each sit inside their own wrapper element (a grid cell, a component's root) are not compared with each other. The finding names the parent, since a missing gap on the shared wrapper is the usual cause.

The weights were set on a small set of pages that differ from a clean one in a single fact: two pairs of touching cards, six button heights, twelve grays, and all three together. The clean page scores 100 and the page with all three scores below 80. A test holds that order, so a later change to the weights cannot flatten the scale without failing it. Scores from before this scale are not comparable with scores after it: re-audit a page before comparing it with an older run.
