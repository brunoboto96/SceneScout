# What it checks

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
| Set up | `scout_playbook` `scout_intake` `scout_scan` `scout_attach` `scout_login` `scout_session` | Hand the testing method to an agent with no skill loaded; ask the start-of-run questions as one form where the client can show one; discover routes; save a sign-in for a role; open a browser in a write mode; list the live sessions, pick the default one and set its pace |
| Explore | `scout_crawl` `scout_coverage` | Visit every known route in one call; ask what is still untested |
| Look | `scout_snapshot` `scout_hover` `scout_screenshot` `scout_capture` | Read the page as a structured list (diffed on a second look); reveal tooltips and hover cards; take pixels only when they are needed; save one element as a PNG to show someone |
| Ask the server | `scout_request` `scout_network` | Call the app's own API as this session, with the UI bypassed, so a hidden button becomes a proven refusal; list the requests the page made since it loaded |
| Act | `scout_click` `scout_type` `scout_select` `scout_upload` `scout_press` `scout_scroll` `scout_navigate` `scout_back` `scout_run_plan` | Drive the page as a user does; `scout_run_plan` runs a whole mechanical sequence in one call |
| Assess | `scout_design_audit` `scout_journey` | Score a page for accessibility, craft and consistency; measure how hard a task is to complete |
| Record | `scout_note` `scout_finding` `scout_resolve` `scout_report` | Keep durable notes about the app; file deduplicated findings; mark fixes; write the report |
| Answer tickets | `scout_tickets` `scout_criterion` | Read the acceptance criteria in pasted or uploaded tickets; record each as passed, failed or not tested, with a confidence |
| Re-test | `scout_verify` | List the findings earlier runs left open, worst route first, and record whether each is gone, still there or changed |
| Split the work | `scout_lane_brief` `scout_lane_report` | Divide the app between parallel agents by whole module; fold what each hands back, and name any defect it judged but never filed |
| Watch | `scout_status` | Each session's objective, task and findings so far; in a client that renders MCP Apps, a pane that refreshes itself |
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
- **Design audit with page scores.** Measurable defects (contrast, small targets, clipped text, missing focus) apart from craft suggestions, and a 0 to 100 score per page kept from run to run. The shared shell is scored once, separately.
- **Scrolls like a user.** It finds the inner scroll pane on app-shell layouts, and scrolls one region when a page has several.
- **Memory across runs.** States are fingerprinted, so the next run skips what the last one covered; `scout_note` keeps what the agent learned about the app in `.scenescout/ASSUMPTIONS.md`.
- **A gap ledger it can be held to.** Each entry is something to do, not noise (a search box is not a form left unsubmitted), and API and download addresses never enter the route list.
- **Robust as a long-running server.** A time limit on every tool, a Chromium left behind by a crash cleaned up on the next start (Firefox and WebKit are not), and a bounded close.
