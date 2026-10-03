# scenescout

## 3.18.0

### Minor Changes

- 1a6ce12: Ask the start-of-run questions as one form where the client can show one. A new `scout_intake` tool checks whether the client declared MCP elicitation in form mode and, if it did, asks the address, whether and how to sign in, what to check and whether the site holds real data in a single form, then returns the `scout_login` and `scout_attach` calls the answers choose. With no form support, or when the person declines or closes the form, it returns the questions for the agent to ask in chat, as before. The form never asks for a password or a code: signing in stays in the window `scout_login` opens. The skill and the `explore` prompt call `scout_intake` before setup.

### Patch Changes

- 96bee5c: `scenescout check` and the first look no longer report a feed, a plain-text file, XML, JSON, a PDF or an image as a dead end. A route's response content type now decides whether it is a page: one served as anything but `text/html` or `application/xhtml+xml` is listed under "Not pages" in the report and as `resources` in `check.json`, is not checked against the page rules, and does not count towards the routes checked or `--max-routes`. One that answers 4xx or 5xx is still reported as the route's error.
- 952fbf3: A check or first look with no signed-in session no longer reports each route that redirects to sign-in as an `auth-redirect` issue. It lists them once as a coverage gap ("N routes need sign-in; give a role to cover them"), under "Needs sign-in" in the report and as `needsSignIn` in `check.json`. With `--storage-state`, a redirect to sign-in is still reported as a lost session.
- 6073a0d: A link or button with no text is now named by a descendant's `aria-label` (an icon element inside the link) and by an image's `title` when its alt text is empty, as the browser names it, so `unnamed-control` no longer reports those controls. Coverage recorded for them under their earlier keys carries over.
- cd0639b: Text drawn over a positioned `<img>`, `<picture>`, `<video>` or `<canvas>` is no longer reported as a contrast failure measured against the page background (often as 1.00:1). Like text over a CSS background image, it has no single background colour, so the design audit and `scenescout check` leave it unmeasured.
- 680e4f5: The focus-indicator rule no longer reports an iframe as a control with no visible focus indicator. A Tab onto a frame moves focus into the frame's document, so the design audit and `scenescout check` now follow focus into a same-origin frame and measure the control focused there, reported by its own name. A press that leaves focus inside another site's frame is skipped.
- fe16d4c: A page that locks scrolling behind a modal opened inside a full-viewport frame is no longer reported as a leaked scroll lock. The overlay probe now counts a visible iframe that covers the viewport, is pinned itself or through a fixed ancestor, and is neither faded out nor click-through as an open overlay, provided that, when the frame is same-origin, a dialog or a dimming backdrop is showing inside it. A frame left mounted after its modal closed does not justify the lock, so that page is still reported at high severity.
- 96b74aa: The design audit's `image-aspect` rule no longer reports an image that keeps its proportions through `object-fit: cover`, `contain`, `scale-down` or `none`, whether set inline or by a class. Only an image stretched to its box under `fill`, the default, is reported as distorted.
- 7fc6013: The gap ledger's list of pages whose POST observe refused now names the page that sent the POST. A page whose script posted as it loaded could be listed as the page the session came from, because the browser had not yet reported the new page; the request's Referer now decides, with the session's page as the fallback.

## 3.17.0

### Minor Changes

- b0709f0: `scenescout check` accepts `--ignore-path`: a path drops every rule filed on that route, and `rule:/path` drops that one rule there. A page meant to answer HTTP 500 can stay off the gate while the same status on another path still fails `--fail-on high`. The GitHub Action takes the same input.
- 547d006: Add the `live` and `login` MCP prompts. `live` returns the current session's loopback live-view URL. `login` takes a role and tells the agent to call `scout_login`, with no password argument.
- 7ba8712: Add `scout_status`, a run-status pane built as an MCP App (`io.modelcontextprotocol/ui`, specification 2026-01-26). In a client that renders MCP Apps it shows each session's objective and task, open findings by severity, coverage and a button for the live view, and refreshes itself every 2.5 seconds through the app-only `scout_status_poll` tool. Every other client gets the same as text, starting with the live view's loopback address. The pane's page loads nothing from outside and shows only what the live view already shows.

### Patch Changes

- 745a38e: On Windows, `scenescout install --client` starts an npm-installed client (a `.cmd` or `.bat` shim) through `cmd.exe`, so registration runs the client's own command instead of stopping and printing it to run by hand.

## 3.16.0

### Minor Changes

- 8dacac8: `scout_select` matches the value against the dropdown's options before picking: an exact value or label, either ignoring case, then a label it starts with ("Low" picks "Low — minor impact"). A value that matches no option, or several, is refused at once with the options listed, instead of waiting out the action limit. Typing into a date or time field puts an obvious near miss in the field's format (a plain date into a date-and-time field is entered at T00:00) and refuses anything else naming the format the field takes, instead of failing with "Malformed value". A click forced past something on top of its target names that element, and says when it came after a write-policy block. `scout_run_plan` takes `onViolation: "continue"` for a sweep of independent steps: a new error status is listed on its step's line and the plan goes on, while a failed step, a policy refusal or any other violation still stops it.
- 11fa895: A run can answer the tickets it was given. `scout_tickets` reads acceptance criteria from pasted text or a ticket file (`.md`, `.txt`, `.feature`): Given/When/Then scenarios, checklists, numbered or `AC1:` criteria, and lists under an "Acceptance criteria" heading; a ticket with none of these is reported as having no recognisable criteria rather than guessed at. `scout_criterion` records each criterion as passed, failed (linked to the findings that show it) or not tested (`no-access`, `observe-blocked` or `out-of-scope`), with the agent's confidence. The report answers each ticket at the top of the plain section, with a failing criterion's pictures, and lists every verdict with its confidence in a new "Acceptance criteria" section of the technical report. A parallel run's lane briefs list the criteria, and the plain questions' "what to check" reads tickets this way.
- 9ebbce6: Add visual regression baselines to `scenescout check`. List pages and elements in a `targets.json` in the baselines folder (`page`, or an element named the way a saved flow names its target), take their pictures with `--baseline update`, and `--baseline compare` takes them again and compares pixel by pixel: a picture where more pixels changed than `--baseline-threshold` allows (default 0.1%, so anti-aliasing noise between machines and browser builds does not fail the gate; `0` counts every changed pixel), whose size changed, or that could not be taken is a high `visual-change` issue that fails the default gate, with the share of pixels changed and the baseline, the picture now and a diff with the changed pixels in red written under `visual/` beside the report. A baseline that cannot be used (half there, unreadable, or taken with other settings) is filed the same way; a target with no baseline yet is listed, counted beside the verdict, and never fails. Pictures are taken in a fixed 1280×900 window at one pixel per CSS pixel, after a fresh load, with reduced motion requested, fonts loaded, animations stopped and the caret hidden; baselines are kept per browser with a JSON of the settings they were taken with. They live in `.scenescout/baselines/`, which git ignores, unless `--baselines <dir>` names a folder the project commits, and only `--baseline update` writes one, rewriting those compare would not accept and any taken on another operating system. The GitHub Action takes the same three inputs (`baseline`, `baselines`, `baseline-threshold`) and keeps the pictures in its artifact.
- 819fa87: `scenescout ci --lanes <n>` (and the ci action's `lanes` input) splits an unattended run between up to 8 model loops that explore at once, each in its own browser session and its own modules of the app. A crawl plans the split with no model call, the lanes share the run's turn, token and time caps rather than getting them each, and their findings fold into one report; the summary and `ci.json` list each lane. The default stays one loop: at the default caps, four lanes found no more than one loop on the benchmark's demo app, so raise `--max-turns` and `--max-tokens` with `--lanes`; `--lanes 4 --max-turns 160 --max-tokens 6000000` found the most, at about 2.3 times one loop's cost.
- 5a83d6e: New tool `scout_network` lists the fetch and XHR requests the current page made since it loaded, with method, path, status and time. Each request shows the route it was sent from, so requests after a client-side route change can be placed. A request that failed, one still pending and one that never ran can be told apart. The tool is read-only, query-string credentials are redacted, the list is bounded, and `scout_request`'s own calls are marked.
  
  `scout_request` takes `select` (one value of a JSON body by dotted path, such as `stats.open` or `items.0.name`) and `offset`/`limit` (a window of characters), so a field past the 2000-character cut can be read. Without them the output is the same as before, except that the truncation line now names the options.
  
  `scout_coverage` shows a session its own work when other sessions share the project: the routes it reached this run and the forms it saw. `scope: "project"` shows every session's coverage and tags each route and form with the sessions that saw it.
  
  Smaller fixes:
  
  - A form whose date or time field the app pre-fills, for example with the current time, counts as submitted empty when that value is left as the app set it and every other field is blank. A pre-filled text field still counts as filled, so saving an edit form unchanged is not taken for the empty submit.
  - "Seen in N runs" counts runs, not filings. When the same session files a finding again in the same run, its newer convention and detail replace the earlier ones, and the result says which fields changed or which were kept.
  - A path crawled by name that answers as a page joins the route list. A crawled path that ends on another route is marked `REDIRECTED → <route>`.
  - A journey's time is active time. Gaps over 30 seconds between steps are left out, and the result says how many were left out.
- 86e9537: Finding dedup no longer merges two findings that both carry evidence on a quoted literal that one names in its title and the other only mentions in its detail: a control's label quoted in passing names where two defects were found, not one defect. The literal must be in the other finding's title or evidence; with no evidence on one side the detail still counts. A finding merged from another page now records that page (`seenOn`, at most 20), and the report prints it as "also seen on" beside the finding's route; the merge note returned to the lane says so. A lane report's decision can name the finding it was filed as (`finding`, the id `scout_finding` returned), and the fold's check for judged defects nobody filed counts it as filed when the project holds that defect. The check's text match also reads underscores inside kebab-case ids and treats ids in paths (`/things/5,/1`) as the route's (`/things/:id`).
- 8f1cb0f: `scout_attach` and `scout_login` no longer need a `projectPath`; left out, both choose the same folder for a site, so a sign-in saved by `scout_login` is found by the attach after it. Given, it still always wins. Left out, a client that offers a workspace folder gets that folder, and otherwise each tested site gets its own folder, `Documents/SceneScout/<host>/` by default (`localhost-3000` for `http://localhost:3000`), created on first use and named in the attach's result so the person knows where the report is. `SCENESCOUT_PROJECTS_DIR` moves that folder, or `off` makes `projectPath` required again. The default is refused when it would sit inside a git repository below the home folder; a home folder that is itself a repository, as with dotfiles, does not count.
- 561bc4e: SceneScout installs in Claude Desktop as a desktop extension. Each release now carries `scenescout-X.Y.Z.mcpb`, a bundle in the MCPB manifest format (manifest version 0.3) holding the engine and its dependencies; opening it installs SceneScout with no new chat or restart needed for the install itself. `scenescout doctor` recognises the extension: it checks that the extension's server is in place, checks the Chromium build the extension launches when that differs from its own, with the command that downloads it, and it no longer asks a Claude Desktop-only user to set up the Claude Code skill and registration. After a plugin install, `scenescout install --browser-only` now ends with "Start a new chat to use SceneScout."
- fd610f0: The first `scout_attach` on a machine without the browser build it needs downloads that build itself, once, saying "Getting the test browser ready" while it does, then carries on with the attach. A Claude Desktop extension or a plugin install needs no terminal step before the first test. CI keeps its explicit install step: there the attach names the command instead, unless `SCENESCOUT_BROWSER_DOWNLOAD=on`. `SCENESCOUT_BROWSER_DOWNLOAD=off` turns the download off for a machine where nothing may be fetched. A failed download names the command to run by hand. `scenescout doctor` no longer fails a desktop extension whose browser is not downloaded yet when the extension is at least as new as `doctor`, since it downloads on first use; it still names the command to have it ready beforehand.
- d7af6e7: Add `scenescout export --to github|jira`, which files the project's open findings as GitHub or Jira issues, each once: every issue carries the `scenescout` label and a marker with the finding's id, and an export skips every finding that already has an issue, open or closed (`--refile-closed` files one again when its issue is closed), so a second export of the same run files only what the first left over the cap. It is a dry run that lists what it would file unless `--yes` is given, and files at most `--max-issues` (default 20) per export. Issue text is rendered inert (no mention, link, cross-reference or markup from a finding does anything); severity becomes a label on GitHub and a priority in Jira (`--severity-map`); a recorded run's frames are attached in Jira and named in a GitHub issue. Credentials come from `GH_TOKEN` or `GITHUB_TOKEN`, or `JIRA_EMAIL` and `JIRA_API_TOKEN`, only, and are never printed; requests time out, wait out short rate limits, retry failed reads with backoff, never re-send a create the tracker may have carried out without first looking for its marker, and refuse redirects.
- 362e52d: Every finding is filed with a picture of what it is about: the element `scout_finding {ref}` names, with a margin, or the page as it was. The picture is kept in `.scenescout/recordings/`, shown under the finding in `report.html` and in the live view's report, named in `report.md`, and returned in the `scout_finding` result as image content so a chat client shows it as the finding is filed. Pictures are bounded by `SCENESCOUT_EVIDENCE_MAX_PX` (default 800 pixels on the longer side) and `SCENESCOUT_EVIDENCE_MAX_KB` (default 200), and a session returns at most `SCENESCOUT_EVIDENCE_INLINE` (default 10) in its results. `scout_attach {evidence}` or `SCENESCOUT_EVIDENCE` chooses `inline`, `file` or `off`; a CI job, and `scenescout ci`, default to `file`. `SCENESCOUT_RECORD=on` makes every session record a frame after each action without each attach asking.
- ffb9a38: `scenescout export --to jira` keeps a filed issue up to date and links it to the ticket it fails. A later export rewrites an open issue's summary and description when the finding has changed, unless someone has edited them in Jira since, and adds the picture, frames and ticket links it lacks, rather than leaving it as first filed (`--jira-update off` only lists it). The finding's picture is attached first, and a finding that fails a ticket's acceptance criterion is linked to that ticket (`--jira-link-type`, default `Relates`, or `JIRA_LINK_TYPE`; `none` links nothing). GitHub issues name the picture and list the failed criteria.
- 267e24a: `scenescout login` no longer needs Enter in a terminal: the window saves the role's profile and closes by itself once the person is signed in, meaning back on the app, with no password or code field on the page, past any return from a single sign-on provider, and holding a session cookie or storage entry it did not hold when the window opened. A round trip through an identity provider on another site, a sign-in popup still open on one, and the app's own page before it has exchanged the provider's code are never taken for the end. Enter still saves at once; `--save enter` makes it the only way, as before, and `--success-url` names the signed-in address instead. The new `scout_login { url, role, projectPath }` tool opens the same window from a conversation and returns once the sign-in is saved, or after `waitSeconds` (default 120) with the window still open, so the agent can call it again; a window nobody finishes closes after 15 minutes, saving nothing. A role with no saved login now names `scout_login` beside the command when an attach is refused.
- df40cfe: The engine can open the live view in the default browser when a session attaches, and report.html when `scout_report` writes it. The new `open` setting (`scout_attach {open}` or `SCENESCOUT_OPEN`: `live`, `report`, `both` or `none`) defaults to both on a local desktop session, headed or headless, and to none in CI, over SSH, or on Linux with no display. `scenescout ci` opens nothing unless `SCENESCOUT_OPEN` is set. The live view keeps its loopback-and-token rules.
- 180d502: The report now opens in plain words: a short summary, then each problem with its impact (blocks users, annoying or cosmetic), numbered steps, what was expected, what happened and its picture, with the technical detail folded beneath each one. `report.md` puts this section before the technical report, and `report.html` opens on it. `scout_report {report}` chooses the parts: `both` (default), `qa` for the plain section alone, or `dev` for the technical report alone.
- 8046682: Start a run with plain questions instead of settings. `/scenescout` with no flags, or the `explore` prompt with no arguments, now asks for the address, whether and how to sign in, what to check (tickets or a description) and whether the site holds real data, and chooses the URL, the sign-in, the objective and the write mode from the answers: real data, or an unsure answer, means observe. Any flag skips the questions. The skill gains `--focus <text>` and `--read-only`.
- 4d4443d: Observe mode can be told which POST endpoints only read, and the label check no longer refuses controls for the record text they show.
  
  - `scout_attach` takes `readPosts` (`["POST /api/search"]`), and `SCENESCOUT_READ_POSTS` sets the same for `check`, `ci` and a first look. Observe then lets those POSTs out, so a search or query page that loads its data through POST can be tested. Nothing is named by default. A named endpoint is still refused when its path or body looks destructive or its body is a GraphQL mutation, and each one let out is logged. The gap ledger names the pages where observe refused a script's POST, with the endpoint.
  - A row, card, heading or panel is judged by its test id and the control at its centre, not by the record text it shows. Its own text counts only for a clickable element whose text is a short command, and a heading's never does.
  - Removing a filter chip ("Remove Status: Open filter") is allowed; "Remove member" is still refused.
  - "Sign off" is refused only as a command, at the start of a label or joined to another verb ("Save and sign off"). "Manager sign-off", "Final sign-off recorded" and "Confirm sign off" are allowed.
- 1a98cb4: Snapshot refs last longer and re-snapshots cost less. Refs from the last snapshot keep working after a search or filter that rewrites only the query string, and a control a re-render replaced is found again by its unique test id (the action says it was re-bound); a route change still refuses them, and the next diff now says when refs were dropped instead of calling them stable. A route you come back to is shown as a diff against its own last snapshot, and another tab of the same screen as a diff against that screen's last tab. Repeated rows are matched by their text or link, so a filtered list reads as the rows that went rather than as the first row relabeled. A truncated snapshot says what it cut, by role and test-id family, and keeps pager and "Load more" controls in the list. An element listed without a control role that a click or Tab still reaches is marked `[clickable]` or `[focusable]`.

### Patch Changes

- c6a75e2: `scout_request` replays the Authorization header the page last sent to the app's own origin on any request, reads included. It used to replay the header of the page's last write, which went stale once the app rotated its access token and then only read, so a replay got 401 while the page's own calls got 200. A header sent to another origin is never replayed, nor is one a `scout_request` call chose for itself. When a replay still gets 401 while the page's latest authorised call succeeded, the result says the replayed credential may be stale.
  
  The refresh broker's write-back keeps the profile's IndexedDB. It used to save the page's storage state without it, so an app keeping part of its sign-in in IndexedDB lost it from the role's profile at the first brokered refresh.
  
  An action's result now says when the refresh broker acted during it: the token refreshed and stored, another session's rotated token loaded and sent, an endpoint learned, or a refresh that could not be brokered. Counts only, no token values.
- fe6ca3c: `false_success` no longer pairs a write sent as a clicked link loads the next page (the old page's save as it is left, the new page's beacon as it loads) with that page's static text, and it now reports, at medium, a refused write whose control or counter shows the change as kept with no error. Errors an HTTP client raises over the write policy's stand-in 403 ("Request failed with status code 403", "403 Forbidden") are attributed to the policy, an alert that appeared after a block is marked `(after a write-policy block)` in the snapshot, and the silent-submit note no longer fires when the click opened a dialog or client-side validation answered. Error-monitor tunnel and client-error endpoints count as infrastructure writes.
- 4cb1441: The gap ledger's three route lines now count over the known routes and name that set (`3 of 54 known route(s) …`), treat a tab or section of a page as part of that page, and judge "nothing exercised" and "never design-audited" over the routes this run reached rather than every earlier run's. `scout_coverage` in a session's scope lists only the controls on the pages that session saw, not another role's on the same route, and labels the route figure as the project's. A wrapper flagged as not a control in any state of a route no longer counts in coverage because an older state left it unflagged. Record ids shaped like codes (`WID-2025-001`, `A1B2C3`) collapse to `:id` like numeric ones, and a dropdown's option already selected when the page loaded is no longer listed as never chosen.
- 313dfab: Make the design audit agree with the page it measures:
  
  - A filter panel is no longer judged as a form. With no `<form>` on the page, the form-burden lines ("NONE marked required", "no obvious submit") count only the fields a user types into, and fields in a panel that names itself a filter or facet (its test id, id, label or legend) are left out wherever they are. Six text fields with no `<form>` and no submit are still flagged.
  - The shadow census counts the layers a box-shadow draws. Empty ring layers (no offset, blur or spread) and transparent layers are dropped, so utility-CSS rings are no longer counted as elevations, and each example shows the layer that sets it apart instead of a truncated value.
  - Tinted grays (a slate, a warm stone) are counted as grays: any colour with no hue family is one. Grays within a few units of each other count as one step of the scale.
  - Elements are named in audit lines by their accessible name, computed as the snapshot computes it, so an icon button with `aria-label="Dismiss"` reads as "Dismiss" rather than "(no text)". The focus-indicator line names tab stops the same way.
  - A new NAMES section lists controls with no accessible name and fields labelled only by their placeholder, and both now lower the a11y subscore (a link or button whose only content is an image with alt text, or an svg with a title or aria-label, is named by it and not listed), which before measured contrast, focus visibility and target size only. Page scores on pages with such controls go down.
- c6a75e2: A click that submits a native form to a refresh endpoint the refresh broker handles returns once the navigation commits, with the broker's line in its own result. In Chromium it used to wait out the action limit, because loading another session's rotated profile opened a page that Chromium did not finish while the form's navigation was held. While it holds a navigation, the broker now loads only the profile's cookies; the rest of the profile is loaded at the next refresh a script sends, and the form's write-back saves the page's cookies while keeping the profile's storage.
- 664c24d: A request still loading when its page is left, its frame is removed or its frame navigates away is no longer counted as in flight, so the next wait for the page to go quiet no longer runs to its 2 s cap.
- c6dc360: Stop the layout checks reporting intended layering as defects, while the defective form of each layout is still reported:
  
  - A skip link parked off the page until it takes focus (a link to a place in the page, or any control a `:focus` rule moves) is no longer "outside the reachable page area", and once focused it is not reported as covering the header under it. A link parked off the page with nothing to bring it back, or a hash-route link, still is.
  - A control inside a list that scrolls within an overflow-hidden card is no longer UNREACHABLE, nor is a slide of a viewer that a control naming it in `aria-controls`, or a next, previous or numbered control beside a row of slides, reveals. The same content with no scroller and no pager still is, and so is a column a card clips beside a "Next page" that pages rows.
  - The overlap check skips a decorative overlay with `pointer-events: none` and a clear button or icon lying in the padding a text field reserves for it. A button over the field's text, an overlay that takes clicks, or a disabled control drawn over another still overlaps.
  - The small-target rule measures a native input together with the label that wraps or touches it, and a visually hidden input as the label or drop zone that operates it, and applies the WCAG 2.5.8 spacing exception: a small target with nothing else inside its 24px circle passes.
- 327e0c6: A path given to `scout_navigate`, `scout_crawl`, a plan or a replayed flow now resolves against the attached origin, as `scout_request` already did, so a session attached on a page below the root (`/things`) goes to `/widgets` for `/widgets` instead of `/things/widgets`, and a crawl given a full same-origin URL visits it as given. A crawled route whose main area holds only an alert or a loading placeholder is flagged `ERROR-VIEW` or `STILL-LOADING`, listed under problem routes, and no longer joins the route contract.
- 28f9b79: The write policy's notices and label check are easier to work with, and refuse as much as before.
  
  - A blocked endpoint is named and explained once per session; later blocks of it are counted on one line, so a page that beacons on every load no longer buries each tool result.
  - A control is judged by its own label. A dropdown is judged by the option picked, so a filter that offers "Delete" can be set to "Create". A row or panel is judged by its own text, not by the buttons inside it, plus any control covering its centre. A pick whose label cannot be read is refused.
  - "Discard changes" and similar labels, which drop only unsent input, are no longer refused. "Discard draft" or "Discard record" still is, and `discard` in a request path is now treated as destructive on the network.
  - When a page asks to confirm leaving unsent input, the result says so by name instead of failing with `ERR_ABORTED`. `scout_navigate`, `scout_click` and `scout_back` take `leave`: observe and read-only stay unless it is `true`, and other modes leave unless it is `false`. Every native dialog the page opens is reported in the action's result.
- f0c8bf3: `check.sarif` and `ci.sarif` results now point at a repository file, so GitHub code scanning keeps them instead of dropping every one. An issue a saved flow raised points at that flow's file; every other result points at the anchor: the new `--sarif-file-anchor` option (and `sarif-file-anchor` action input) when given, else the running workflow's file from `GITHUB_WORKFLOW_REF`, else `package.json`, else `README.md`, whichever exists first; a missing option or workflow file is named in a warning, and when none exists the SARIF is still written with a warning that code scanning will drop its results. The page each result was seen on moves to the message, a logical location and `properties`; fingerprints are unchanged, so existing alerts keep their identity. In `check.json`, an issue a saved flow raised names that flow's file in `flow`.
- e698580: The snapshot names a link or button whose only content is an image by that image: an `<img>`'s alt text, or an `<svg>`'s or `role="img"` element's aria-label or `<title>`, skipping anything under `aria-hidden="true"`. `<a href="/"><img alt="Home"></a>` is now listed as `link "Home"` rather than `link ""`, so the crawl, `scenescout check` and the a11y counts no longer report it as unnamed, and the read-only policy now judges an image button by the name it is announced with. Text still comes first: a control with both text and an image is named by its text, as before. The design audit reads this same name, so the audit and the snapshot use one rule.
  
  The name is half of a control's coverage key, so such a control gets a new key (`button "Search"` instead of `button ""`), and two unnamed image buttons that shared one key now have one each. Memory written before this change carries over: each snapshot records the key a control had under the earlier rule, and coverage reads older states through it, so what was exercised stays exercised and the earlier key is not left as a gap. On a route this run does not reach, the earlier keys stay as they are until a snapshot there lists the controls under their new names.

## 3.15.0

### Minor Changes

- 3c488f3: Finding dedup can ask a model. When the dedup rule keeps a newly filed finding apart from everything recorded, a model judge is asked whether it is the same defect as one of the open findings on the same page (the three most alike, at most), and a "same" merges it; the merged filing's title, category, severity and evidence are kept under the finding and shown in the report with the judge's probability. Any failure, unsure answer or slow call leaves the rule's decision and is logged once per kind; three failed calls in a row switch the judge off for the run.
  
  `scenescout ci` judges by default with the run's model at the lowest effort its API takes, sending each asked pair's titles, categories and evidence, and the page's path; the calls count in the run's usage, and `--dedup rule` (or the action's `dedup` input) turns it off. The MCP server judges only when `SCENESCOUT_DEDUP=judge` or `scout_attach {dedup: "judge"}` asks for it, with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in its environment (`SCENESCOUT_DEDUP_PROVIDER` picks one when both are set).
- 47d5293: Add `scenescout <url>`, a first look at any app with nothing set up: `npx -y scenescout http://localhost:3000`. It runs the deterministic check's crawl and measurements in observe mode, where nothing but reads leaves the page (`--mode read-only` lets a plain POST through), visiting up to 20 pages and starting none after 3 minutes (`--max-routes`, `--max-minutes`), with no model and no API key. When the headless Chromium build is missing it downloads that and nothing else: no skill, no MCP registration, nothing on the PATH. It writes `report.md` and `check.json` to `scenescout-report/` in the current folder (a temporary folder when that cannot be written, or `--out`), and only into a folder that is new, empty or an earlier first look's: any other `scenescout-report/` is left as it is and the run exits 2, pointing at `--out`, and a `report.md` or `check.json` a first look did not write is never replaced; and the summary and the report open with the three issues to look at first: the highest severity, then the most pages affected, with one failure seen several ways (a missing image is a failed request, a broken image and a console line) taking one of the three places. It exits 0 once it has looked, whatever it found, and 2 when it could not run, such as when the address cannot be reached, or could not write the report. The guide's Start here page and the README's quickstart now lead with it.
- 400add2: `scenescout login --script` signs in to passwordless apps and takes a fixed one-time code. `SCENESCOUT_LOGIN_OTP_CODE` is a code the test environment accepts, typed where the form asks for one, as an alternative to `SCENESCOUT_LOGIN_TOTP_SECRET` (setting both is refused at startup); it is redacted from all output like the other credentials. `SCENESCOUT_LOGIN_PASSWORD` may be left unset when a code is given: the run fills the username, presses the button that sends the code ("Send code", "Continue"), waits through the moment with no field on screen, and types the code; a password field that appears anyway stops the run naming the variable.
  
  Finding and submitting the code: a code split into one box per character is typed one character per box; a numeric field sized for a code is the code field once the username has gone; an email field whose label mentions a code stays the username. After typing, the run reads the page until it is clear how to go on, so a button enabled only once the form is complete is waited for, a page that takes the code itself is not submitted again, and a field the typing revealed is filled first. A button that signs in or verifies is pressed rather than one that sends a code where a page has both, and buttons that resend a code or change the address are never pressed. With no success URL or selector, a page with no sign-in field now counts as signed in only once a password or a code has gone, so the pause while a code is sent is not taken for a sign-in.
- 3471e73: Snapshots say more about the page. Alert and status regions are listed by their text whether or not they carry a test id, and the diff reports a region that says something new. Controls show their state (`pressed`, `selected`, `checked`, `expanded`, `current`) and the diff reports it moving; the per-control `done` marker is now `exercised`. A `main:` line summarises the main area's heading and static text, or says `main: EMPTY`, and crawl lines carry the same count. Accessible names follow the accessible-name computation's order: wrapping labels and `title` name a control, a button-like input is named by its value, and a select is never named by its options. Elements listed only for a test id (wrappers, headings, decorative badges) are no longer counted as unnamed controls or in the coverage denominator, and nothing inside an `aria-hidden` subtree is counted as unnamed. Controls held outside the visible width of a horizontally scrolling container are reported once per container, under the new worth-a-look check rule `scrolled-out-controls`.

### Patch Changes

- f6997dc: The design audit's task-efficiency lines count only what they describe. Competing actions are buttons and links painted as buttons; text fields and breadcrumb links no longer count. Form burden counts the fields of a form; row-selection checkboxes, selects that edit a table row in place and search boxes no longer count, and when the page has a `<form>`, fields outside it no longer count either. The app shell's landmarks (navigation, banner, sidebar and footer regions outside the main content) are kept out of a page's score from the first audit, so the first pages of a run are no longer scored with the shell in them while later ones are scored without it. A shell built without landmarks is still recognised only once the shared-chrome census has seen it on several routes.
- c9edcac: Fewer false oracle violations. A `scout_request` probe the server refuses is no longer reported as an `http_error` or `console_error` of the page visited next. `false_success` now pairs a refused write only with a success message the action put on screen: a status badge or heading already there, a column header and a write the page sent in the background or to its own telemetry no longer count; a success message beside an action whose other writes went through is reported as a partial `false_success` at medium ("partial: N of M writes from this action were refused"); and an announced "was refused", "rejected" or "could not" counts as the page admitting the refusal. The silent-submit note matches its words ("sign", "post", "save") as whole words and waits for a client-side route change before calling a click silent. A page error raised by a link click that left the URL unchanged and opened a confirmation, or whose message says a route change was cancelled, is reported at medium with a note instead of high.
- a5f9c33: The refresh broker no longer holds back an app's requests when its refresh token is a cookie scoped to "/". A cookie alone no longer makes a request a refresh: only a POST, PUT or PATCH to a path named for a refresh, or an endpoint the broker has seen rotate the cookie (learned for every session of the role), goes through the lock. Scripts, stylesheets, images and fonts are never brokered, and when the broker cannot take the lock or read the profile the request goes out as the page sent it instead of being dropped. A refresh-named storage value that is an address is no longer taken for a token. On Windows, a lock file still being deleted as it changes hands (EPERM, EBUSY or EACCES) is waited for like a held lock instead of failing.

## 3.14.1

### Patch Changes

- 5358a81: `--help` and `-h` now print the usage and exit 0 on every subcommand before it does anything; `scenescout install --help` used to run a real install. `install`, `doctor`, `scan`, `status` and `watch` now refuse a flag or argument they do not know instead of ignoring it.

## 3.14.0

### Minor Changes

- f4c1acf: The time an action on the page and a page load may take are now settings. An action (click, typing, hover, pick, upload, and a saved flow step's wait) keeps its 5 s default and a page load its 20 s (15 s for a crawled page or a flow's navigate step, 10 s for going back). Raise them with `actionTimeoutMs` and `navTimeoutMs` on `scout_attach`, with `SCENESCOUT_ACTION_TIMEOUT_MS` and `SCENESCOUT_NAV_TIMEOUT_MS` in the environment, or with `--action-timeout-ms` and `--nav-timeout-ms` on `scenescout check` and `scenescout ci` (and the matching inputs on both GitHub Actions). An option wins over the variable, and the variable over the default; a value out of bounds refuses the attach with a sentence naming it. A timeout now says which limit ran out, how long it was, and how to raise it, so a slow machine is not mistaken for a slow app.
- 52ebb78: Add `scenescout login <url> --role <name>`: sign in once in a visible browser (SSO, MFA, anything the app asks), press Enter, and the session is saved as that role's profile in `.scenescout/auth/<name>.json`, readable by your account only and kept out of git. `scout_attach` takes a new `role` argument that builds the session's own browser from that profile, so any number of sessions can run as the same role from one login. A role with no saved login is refused with the command to run, and `role` with `storageStatePath` is refused as ambiguous. Lane briefs tell each lane to attach by role when the planner signed in that way.
- 6b8746c: A new oracle, `postmessage_token`, reports a page that calls `postMessage` with targetOrigin `"*"` on a message carrying a token: a JWT, a `Bearer` value, or an opaque value under a key such as `access_token`, including inside a JSON string. Any origin the receiving window holds can read such a message. The finding names the path inside the message, the shape and the token's first four characters and length, never the token. It is filed at high severity, and `scenescout check` reports it under the new `postmessage-token` rule, which fails the default gate.
- 3a39d7f: `scenescout login` now says how long the saved sign-in will last, read from its cookies' expiry dates and the `exp` of any JWT in a cookie or in localStorage (decoded for that claim only, never verified or printed). `scout_lane_brief` checks the planner's saved role before splitting the app: it takes `runMinutes` (default 60) and `expiryMarginMinutes` (default 10), refuses when every credential in the profile is dated, none was set for another host, and the last ends before the run does, and names the `scenescout login` command to run again. A profile whose first credential expires inside the run, or that has no expiry in it at all, is a warning at the top of the brief rather than a refusal.
- 77501be: Sign-in profiles saved by `scenescout login` now keep sessionStorage and IndexedDB as well as cookies and localStorage, so an app whose sign-in library keeps its token in either still comes back signed in when a session attaches by `role`. sessionStorage is restored before the app's own code runs, only on the origin it was saved from and once per tab, so a session that signs out stays signed out. The line printed after saving counts origins with session storage and IndexedDB databases. Logins saved by an earlier version load as before; record them again to pick up the new storage.
- 36665f5: `/scenescout qa` can now be opened to more than a list of usernames: `SCENESCOUT_QA_ALLOWED_ROLES` allows commenters by their association with the repository (`OWNER`, `MEMBER`, `COLLABORATOR`), and `SCENESCOUT_QA_ALLOWED_TEAMS` allows active members of the organization's teams (`org/team-slug`), read with a separate `SCENESCOUT_QA_TEAM_TOKEN` secret that only the gate job receives. The lists combine with `SCENESCOUT_QA_ALLOWED`; unset, the default stays the repository's owners. An unknown role fails the gate, and a team lookup with no token, a refused token or a team of another organization refuses the commenter and says why in the job's log.
- 2089e9e: Add `/scenescout qa show <element>` and `/scenescout qa compare <element>`: the QA comment captures one element of the pull request's preview with a real browser screenshot (its bounds plus a margin), and `compare` captures the same element on a base URL (`SCENESCOUT_QA_BASE_URL`, else the base branch's newest successful deployment) and adds a diff picture with the share of pixels changed. The reply shows the pictures inline: a new keyless `shots` job pushes them to the `scenescout-shots` branch, one folder per run, and the reply links only images whose URLs the workflow builds itself. Underneath, `scenescout ci` takes `--show "<words>"` and `--compare-url <url>` (and the ci action `show` and `compare-url`), and a new `scout_capture` tool saves a PNG of one element by its ref. The QA template now pins v3.14.0.
- e665fcc: A session attached by role now answers its first `SESSION AUTH LOST` by re-attaching once from that role's latest saved profile, read from disk at that moment, and going back to the page it asked for. The tool result says `SESSION RE-ATTACHED` and lists the routes the loss bounced; a crawl visits them again itself. A second loss in the same session, or a profile that no longer signs in, is reported as before. A lane that re-attached is named when its report is folded. Sessions attached with a storage-state file or none behave as before.
- fdbd77c: Add `scenescout login <url> --role <name> --script`, a sign-in for CI with no one at the keyboard. It runs headless, fills the sign-in form from `SCENESCOUT_LOGIN_USERNAME` and `SCENESCOUT_LOGIN_PASSWORD`, types an RFC 6238 code from `SCENESCOUT_LOGIN_TOTP_SECRET` when the form asks for one, follows forms that ask for the password after "Next", and saves the session as the role's profile, as the manual login does. Fields are found by autocomplete, type and label, with CSS selectors as a fallback, and success by leaving the sign-in fields behind or by a configured URL or selector. Missing configuration is reported before a browser starts, a refused sign-in exits 1, and no credential value appears in anything it prints, even when the page echoes it. The CI docs gain a section on signing in: the options (a test tenant's user, a test-only endpoint, a saved session as a secret) and the rules for the credentials.
- feb605c: Sessions attached by the same role no longer present the same refresh token. When a session's page is about to send a refresh token from the role's saved profile, it takes a lock beside the profile; holding it, it loads the profile again and, if another session has already rotated the token, sends the current one in place of the spent one. Once the page has stored the rotation it is written back over the profile. An app that revokes a whole token family on reuse keeps every session of the role signed in. Sessions in separate processes share the lock through the file. Token values are never printed or logged. `SCENESCOUT_REFRESH_BROKER=off` turns it off.

### Patch Changes

- 031c34c: Closing a session now always closes its browser. When closing took longer than the 8-second cap, the close returned and cleared its references before teardown had reached the browser, so the browser kept running under the process and could stop it from exiting. The browser is now closed past the cap as well, without waiting on a page or context that has not closed.
- cd73ece: In Firefox, a page the engine closes (a popup of another site, or every page when a session ends) now waits until the write policy has answered what the page sent as it was left. A write refused by the policy, such as a delete sent by beacon on `pagehide`, could previously reach the server when the page closed first.
- d0cdf80: The live view's close-up keeps its session's stream in step with the rest of the page: pressing "Stream all" while a close-up is open holds for that session after the close-up closes, and opening another session's close-up from the keyboard hands the first one back as it was; a card's own Stream toggle pressed behind the close-up is a choice that outlasts it. Its Stream button disappears with a session that closes under it, and a still that fails to capture once stays on screen instead of blanking the picture until the next refresh.
- 3b869fc: A role session that re-attaches after losing its sign-in now also gets back the latest profile's sessionStorage, so an app that keeps its token there is signed in again rather than left signed out. Each tab is seeded once more, only for the origins the profile holds, and a sign-out after that stands.
- 6b27dd9: Page-state fingerprints and finding ids are now derived with SHA-256 instead of SHA-1. They are identifiers, not a security control, but the ids change: on the first run after upgrading, findings stored by an earlier version may show as new once, and ones marked resolved may be reported again.

## 3.13.1

### Patch Changes

- ab8b9f9: The `ci` GitHub Action takes a `cache` input (default `true`). `cache: false` skips restoring and saving the browser in the actions cache, for a job that checks out a ref chosen by an input and must not write to the cache.

## 3.13.0

### Minor Changes

- a6bc077: Add a QA review started from a pull-request comment. An account the repository allows (by default its owners) comments `/scenescout qa` on a pull request, optionally with a preview URL and a focus, and an unattended `scenescout ci` run explores that pull request's deployed preview and posts its results as a reply, with a link to the full report. The job that holds the model's key checks out nothing and runs SceneScout from an exact release tag, so the pull request's code never runs beside the key; pull requests from forks are refused unless the repository allows them. The workflow to copy is `examples/workflows/scenescout-qa.yml`, and the new `brunoboto96/SceneScout/qa` action runs its keyless steps.
- 7280e29: Add `scenescout ci <url>`, an exploratory run with no person present: a model reached through the Anthropic Messages API or the OpenAI Responses API drives the scout_* tools by the SceneScout method and the run ends in the ordinary report. It reports and never gates: it exits 0 when the run ran, whatever it found, and 2 when it could not run.
  
  - The key is read from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only and is redacted from everything the run prints or writes; with both set, `--provider` chooses. `--model`, `--effort` (default `low`) and `--base-url` override the defaults (`claude-sonnet-5`, `gpt-6-luna`).
  - The run stops at the first of 40 turns, 1,500,000 tokens or 20 minutes (`--max-turns`, `--max-tokens`, `--max-minutes`), still writes the report, and says which cap ended it.
  - It runs in `read-only` mode by default (`--mode observe|read-only|safe-write`, or `destructive` together with `--allow-destructive`) at level `medium` (`--level`).
  - It writes `report.md`, `report.html`, `summary.md` (also on the GitHub job summary), `ci.json` and `ci.sarif`, with a usage line of turns, tokens, time and an estimated cost. `--price-in`, `--price-cached-in` and `--price-out` set the prices the estimate uses, for any model.
  - A second GitHub Action, `brunoboto96/SceneScout/ci`, runs it; its inputs are the command's options.

### Patch Changes

- d392192: `scenescout check` no longer lets a write out under the crawl's rule when a saved flow's page sent it under the flow's: a beacon a page sent as the flow left it, heard of a moment after the hand-back, could reach the server under `--flow-writes never` about one run in five in Chromium, and a page a step had opened a tab from stayed open and sent its leaving beacon when the session closed. Every page in the context is now left before the crawl's rule comes back, and the flow's rule keeps judging for five seconds after.

## 3.12.0

### Minor Changes

- 967e98c: Add a "worth a look" tier for observations that are defects only under a convention of the project the run cannot see, such as a spacing scale, link styling in navigation, or test ids on every control. SceneScout reports each one with the convention that would decide it, and never counts it as a defect.
  
  - Lane reports accept the verdict `worth_a_look`, which must name its `convention`. A `convention` on any other verdict is ignored, and the fold says so. Lane calibration and the benchmark's key calibration leave it unscored and count it under its own reason.
  - `scout_finding` takes an optional `convention`, which files the finding in this tier. The report lists these findings under "Worth a look", below the findings, as "a defect only if your project uses …", and leaves them out of every defect total. Filing the same thing again as a defect promotes it, at the defect's severity, and the reply says so. The benchmark sets such findings aside from recall and precision, and the fold lists a lane's judged defect as unfiled when it was filed only as worth a look.
  - `scenescout check` reports two new rules, `off-grid-spacing` and `indistinct-link`, in this tier. They have no severity and never fail the gate at any `--fail-on`. SARIF reports them at level `note`. The report and the job summary list them in their own section, `check.json` puts them under `worthALook`, separate from `issues`, and the GitHub Action publishes their number as the `worth-a-look` output. Every existing rule is unchanged.

### Patch Changes

- c40892f: `scout_lane_report` keeps the routes each lane's accepted report lists in the project's memory (`laneRoutes` in `.scenescout/memory.json`), with query strings and fragments removed so no token in an address is stored, and `npm run bench -- --archive` carries them into the run archive. The benchmark then decides whether a lane's "not a defect" is a remark about another lane's page by where the matched defect is, not by how the verdict is worded: a defect none of whose pages the lane covered is set aside as another lane's and listed on the scorecard, and one on the lane's own page, or one every lane can reach, is scored. Answer-key entries can name further pages with `alsoOn` and mark a defect every lane can reach with `everyPage`. Archives made before routes were kept, and lanes with a route that names no page, are scored by wording, as before.

## 3.11.1

### Patch Changes

- 847c149: Two different defects on one element now stay two findings. Finding dedup compares what is wrong as well as where: identical evidence, a shared quoted label or a reworded title merges two findings only when they are one kind of defect (the same category, or neighbouring categories of one family such as `page-error` and `console-error`). `visual`, `ux-polish`, `a11y` and `missing-testid` are each their own kind, so a link clipped out of view and the same link styled like body text are no longer merged. When `scout_finding` merges a filing it now names the category of the finding it joined and which categories the filing could have merged with.
- aca7a28: When a lane report is folded, a judged defect on a failing request now counts as filed when a finding names that request with its path written as a template: `GET /api/things/{id} 500` (or `:id`, or `*`) covers a lane's `GET /api/things/7 500`. A template stands only for one id segment (a number, a UUID or a long hex id), never for a word such as `me` or `export`. A defect naming several failing requests counts as filed only when every one of them is. On a request that did not fail, the lane's evidence, once the paths are aligned, must be the finding's, a restatement of part of it, or the finding's evidence followed only by the status the call should have returned, as in `… 200 as role=viewer (expected 403)`.
- 2b8ac9a: The write policy now judges writes a page sends as it is being left. In Chromium, a `navigator.sendBeacon` or `fetch(..., { keepalive: true })` sent on `pagehide`, `visibilitychange` or `unload` was never intercepted and reached the server in every mode, observe included; the engine now catches it at the browser level and applies the same rules, so under observe (and under read-only, for a destructive write) it is refused and reported with the other refused writes, and a mode that allows it still sends it. Such a write is recognised by its headers, since the page that sent it is gone: one out of the app whose Origin is another site's, or `null`, is treated as an embed's and refused outside destructive, and the exception for a captcha on the app's sign-in page is decided on the Referer, the page it was sent from. Browsers send only the origin as the Referer of a request to another site by default, so that exception seldom applies and such a captcha write is refused; a sign-in the tester completes while the page is open is not affected. In Chromium, a write a 307 or 308 redirect carries on to a new address is now judged there as well. In every browser, the pages the engine closes (at the end of a session, on a re-attach, and a popup of another site) are left for `about:blank` first, so what they send on the way out meets the policy too: in Firefox and WebKit such a write had also gone out unseen.

## 3.11.0

### Minor Changes

- f61141e: `scenescout check` replays saved flows and re-tests open findings. Flows saved as `.scenescout/flows/*.json` use `scout_run_plan`'s steps (navigate, click, type, select, press) plus `expect-text`, `expect-url` and `expect-request`; each is replayed after the crawl with no model, and a flow whose step breaks fails the gate with a high `flow-step-failed` issue naming the flow and the step. A flow file that is not valid stops the check with exit 2, naming the file and the field. Open findings in the project's memory that a page load can reproduce (a failed GET, nothing done on the page but looking) are re-tested and reported as still reproducing or possibly fixed; the memory is never written. New options, also inputs of the GitHub Action: `--flows <dir|off>`, `--retest on|off`, and three settings for what a check may do, whose effective values are printed under the verdict and in `check.json`: `--flow-writes never|allow` (default `never`: flows replay under observe's rule whatever `--mode` says; `allow` replays them under `--mode`, so their form submissions are sent), `--on-refused-step report|stop` (default `report`: a flow whose step was refused is marked "could not run" in the report, JSON and SARIF, every other verdict is kept, and the check exits 2; `stop` exits 2 at once with no results) and `--gate-retests never|high|all` (default `high`: a re-tested finding filed high that still reproduces fails the gate). The defaults are what an unconfigured check does, for a first try or an agent running it unattended: its flows send no HTTP write and it never silently hides a result. A refused beacon or ping (`navigator.sendBeacon`, `<a ping>`) is listed in the flow's result as a background request and charged to no step, whatever its origin, while every other refused write (fetch, XHR, form post) is charged to its step wherever it goes; a write the last step sets off within 750 ms is still charged to it; the WebSocket connections a flow's page opened are listed; a `role=` target must name an ARIA role; anything else in the flows directory is listed as skipped with its reason. Pages loaded only to re-test a finding are measured and nothing else: they are not checked routes, do not count towards `--max-routes`, and add nothing to the route list. The GitHub Action also outputs `could-not-run` and `retests-failing`, and its annotation says when re-tested findings are among what failed the gate. `scout_run_plan` targets accept `role=<role>[name="…"]`, and the `.gitignore` SceneScout writes in `.scenescout/` no longer ignores `flows/*.json`, so flows can be committed.

### Patch Changes

- a1f8011: The benchmark has a second, held-out app (`npm run holdout:serve`), a library loans desk with its own planted defects and answer key, which nothing in the engine or the skill is tuned against. `npm run bench` takes `--app demo|holdout` to choose the key a run is scored with (the demo stays the default), records the app in every new archive, refuses to score an archive against another app's key, and `--all` scores each archive against its own app's key, one table per app.

## 3.10.0

### Minor Changes

- 8901a03: `scenescout check` is now a GitHub Action: `uses: brunoboto96/SceneScout@v3.10.0` (or the release you are on) with a `url` installs SceneScout and the browser (cached between runs), runs the check, puts the report on the job summary, keeps `report.md`, `check.json` and `check.sarif` as an artifact, and can upload the SARIF to code scanning (`upload-sarif: true`, which needs `security-events: write`). Its inputs are the CLI's options by name, its outputs are the verdict and the counts by severity, and the step fails with the CLI's exit code: 1 when the gate fails, 2 with a "could not run" annotation when there is no verdict. `docs/ci.md` has a complete workflow and the same check on GitLab CI, CircleCI and plain shell. Each release also points the major tag (`v3`) at itself where the repository settings allow it.
- 9b98a50: New `scenescout check <url>`: a deterministic sweep that needs no model, so it can gate a pull request. It visits the start page, the project's scanned routes and every same-origin link it finds, and measures each one: HTTP and page errors, layout geometry (covered, clipped and overlapping controls, blocking overlays), broken images, controls with no name, contrast, focus indicators and pages with no way out. It writes `report.md`, `check.sarif` and `check.json`, adds the report to the GitHub Actions job summary, and exits 0 on a pass, 1 when the gate fails (`--fail-on high` by default) and 2 when it could not run. It never writes to the app.
- ccf5802: `scout_coverage` lists the forms seen this run that no session has submitted empty: a `<form>` with a native submit control (a button linked by `form="id"` included) and at least one text field, until a click on that submit control, or Enter in one of its text inputs, goes while every text field is blank. A form is known by its `id`, else its `name`, else its `action` and method, and only when it has none of those by its submit control. Forms with no text field (only checkboxes, radios or selects), search boxes, forms whose submit is disabled while they are blank, and fields with no `<form>` around them are not listed. The gap ledger is unchanged: like the dropdown options, this is a coverage prompt, not a gate on `extensive`.

### Patch Changes

- 4f883c7: The console line Chromium and WebKit print for a failed load ("Failed to load resource: …") now goes where its request went: when another site's frame sent the request outside the app, the line is attributed to that embed at medium severity, instead of being filed as a high-severity console error of the app. The same line for a request the app sent stays the app's, other console and page errors are still not attributed by frame, and Firefox prints no such line.
- 8b18c82: `scout_close` no longer closes a lane of a parallel run whose report has not been accepted yet, since folding the report needs the lane's session attached. A session counts as a lane once `scout_lane_brief` or `scout_lane_report` has named it (a brief lane sharing the name of a session already live does not count), until the run's last session closes; a refused report does not count as folded. The refusal says to fold the lane with `scout_lane_report`, and `scout_close {all: true}` names every such lane, offers the other sessions to close by name, and closes nothing. Pass `force: true` to close anyway, which loses that lane's decisions. A session no lane tool has named closes as before.
- 42f6a55: `scout_lane_report` decodes the HTML character references a relay adds when it escapes a lane's reply (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;`, `&apos;` and numeric ones), once, in every string of the report, so evidence such as `-&gt;` matches the finding filed as `->` again. A reply that holds a literal `<` or `>` was not escaped on the way and is left as it is, so a lane reporting a page that double-escapes its text keeps its evidence. Length caps apply to the decoded text, so a route that only went over its cap by being escaped is no longer refused, and the fold says how many references it decoded.
- d487207: A text field whose only label is its placeholder is no longer treated as labelled. The snapshot still shows the placeholder as the field's name and now flags it `no label: placeholder only`, the crawl counts it as unnamed, and `scenescout check` files it under a new medium rule, `placeholder-only-label`. A field named by nothing but its `name` attribute or type is flagged `no label` and filed as `unnamed-control`. A `<label>` (by `for` or wrapping the field), `aria-label`, `aria-labelledby` or `title` counts as a label. Element keys in project memory are unchanged.

## 3.9.0

### Minor Changes

- e2cf5bb: Snapshots list the controls inside the page's frames, each marked with its frame, and every action works on them by ref. In a frame of another site, container text is masked and typed markup, fuzzing-length values, repeated-click probes and uploads are refused in every mode; ordinary clicks and typing are allowed, and the write policy still refuses the writes such a frame sends outside the app.
- 5a48f6c: What happens inside another site's frame is attributed to it: failing requests and error responses it sent outside the app are labelled with its origin, kept at medium severity at most and grouped in their own report section (a request it sent to the app stays the app's), and its controls are counted apart from the app's coverage and gap ledger.
- fa71eb8: `scout_attach` takes `trustedEmbeds`, a list of origins the user trusts (a provider in test mode, say): in safe-write mode only, the writes their frames send outside the app go out, provided every other site involved (each frame up to the page, and the Origin header) is trusted. Anything that is not a plain http(s) origin is refused at attach, trust is ignored in the other modes, and the report names the list.

## 3.8.0

### Minor Changes

- 09a1ff0: Snapshots list the page's frames (same- or cross-origin, title, size, hidden ones as a count) and say their contents were not explored, and a page whose content is all in frames is no longer called a dead end. A write that a cross-origin frame, such as an embedded third-party form, sends outside the app is refused in every mode except destructive, a cross-origin frame's document is sandboxed against popups and moving the whole page, and once an embed has moved the session's page to its own site, that page's writes to another site are refused unless they are a sign-in request. On the app's own sign-in pages (a last path segment such as `login` or `sign-in`) a captcha frame's writes still go out, outside observe.

## 3.7.0

### Minor Changes

- 1b4a688: The live view's close-up has its own Stream button, the same one as the session's card: switch streaming off or on without leaving the close-up. Opening a close-up still streams its session, and closing it without touching the button leaves the card as it was.
- a11c96e: `scout_coverage` lists the options of each dropdown used in the run that no session has chosen, since a filter counts as exercised after one choice. Disabled and hidden options, and an empty-value placeholder or "all" option, are never listed; dropdowns with more than 20 options are pickers and are not listed either.

### Patch Changes

- b726af1: Two findings that quote the same control no longer merge when their evidence names different requests, and a filing merged into an existing finding now names it, with its severity and title.
- 56382db: The lane-report fold no longer lists a judged defect as unfiled when its evidence appears word for word inside a filed finding's evidence.

## 3.6.1

### Patch Changes

- 90d1aec: Two findings that share only a quoted string are merged only when their kinds are one family (data, failures, presentation, flow, security, performance, and "other" on its own). A layout defect naming the button it covers ("Save notes") was being folded into the data defect about what that button does, and dropped from the report. The same bug filed twice under neighbouring categories — data-loss and data-inconsistency, page-error and console-error — still merges.
- 8abf639: The false-success check recognises a refusal the page announces in its own words — "Only an open order can be sent for approval", "You can't delete an approved order", "This order is already approved" — in a status region, alert or dialog, as the page admitting the refusal, instead of reporting the word "sent" or "approved" as a false claim of success. The same wording as ordinary help text elsewhere on the page ("This cannot be undone", "Password must be at least 8 characters") excuses nothing.
- ca52079: The lane-report fold's check for defects judged but never filed now recognises a filed finding when the lane reworded its evidence, matching on the identifiers that survive rewording — test ids and contrast ratios, two of them in common — or on near-identical wording. Replayed against three archived benchmark runs it raised 6 flags where it had raised 39, and still named every defect that was genuinely left unfiled. One shared test id is never enough, and API paths are not identifiers, so a missed defect on the same button or endpoint as a filed one is still named.

## 3.6.0

### Minor Changes

- 6fbd659: The pace section now separates a lane's working time from the time it holds its browser after finishing. "Idle while working" is the share of each lane's working time spent in gaps over 30 seconds; "after finishing" is time waiting to be collected and closed, split at the moment the lane's report was folded. The latter grows with the number of lanes and the slowest one, so it is reported as planner overhead rather than summed into the lanes' idle time. `scout_lane_report` now logs the fold so the split can be made.

## 3.5.0

### Minor Changes

- 4fe8889: Parallel lanes now share what a run knows, and the planner is told what a lane left undone.
  
  - A markup value typed in one session is watched for in every session on the same project, so a stored injection is caught when another lane opens the list that renders it.
  - The report gate counts design audits from every session in the run, so a planner whose lanes audited the pages is no longer refused.
  - Folding a lane report lists each judged defect that no finding matches yet, so it can be filed before the lane's session closes.
  - A lane report wrapped in prose around one fenced JSON block is accepted, with the prose discarded unread.
  - `scout_lane_brief` gives each lane a landing route of its own and the rules a measured run found worth stating.
  - The pace section shows how long each session held a browser idle before its first action and after its last, including sessions that attached and never acted.
  - An empty live region (`role="status"` and similar) is no longer shown or counted as an unnamed control.
- 6ec8fee: The write policy now answers a page's blocked `fetch` or XHR write with a `403` in the server's place instead of dropping it. The server is still never contacted, but the page's handling of a refusal really runs, so a page that reports a refused save or delete as a success is caught as a `false_success` (and says the refusal was the policy's stand-in). Blocked navigations are still dropped. The stand-in 403 is not reported as an HTTP error of the app.

## 3.4.0

### Minor Changes

- 04f0f22: Measure whether a lane's confidence means anything, and make one lane rubric serve a whole wave.
  
  Every lane has been told its confidence must be calibrated — "0.5 means a coin flip, 0.95 means you would bet on it" — and the number was then averaged into one line and discarded. Nothing was stored, so nothing could ever be checked, and a confidence nobody checks is decoration.
  
  Lane decisions are now kept, and the report carries a calibration section: how often a decision at a stated confidence matched a finding the project holds, bucketed, with an expected calibration error. It says plainly what the number is not — agreement between the lanes and the bar the project applies, over its whole history, not evidence that the app is broken — and names the two ways a lane is counted wrong through no fault of its own. A decision naming no failing endpoint cannot be looked up at all, so it is excluded and disclosed rather than scored as a miss. Below eight checkable decisions the figure is withheld, but the section says so rather than vanishing. Where findings have since been re-tested through `scout_verify`, those verdicts are reported beside it, because they *are* evidence about the app.
  
  Separately, the lane name used to sit in the second sentence of the instruction every lane receives, so two lanes' prompts diverged almost immediately and shared no prefix. The rubric is now identical for every lane in a wave and the name is the last thing said, which makes it one cacheable prefix instead of one per lane.

## 3.3.0

### Minor Changes

- 0778653: Report the page contradicting the server: a refused list shown as an empty state, and a refused save shown as a success.
  
  Two of the most expensive bugs a web app ships were invisible to every oracle that watches one side of the wire. A list request is refused with a 403 and the page renders its empty state, so the user is told they have nothing when the truth is that nothing could be loaded — which is how a permission regression reaches production without anyone noticing. A save is refused and the page says "Saved", so the user walks away believing their work is stored.
  
  Neither is a crash. The HTTP oracle already saw the refusal and reported it as a medium, indistinguishable from the dozens of expected 401s an auth probe produces; the defect is not the refusal but the page contradicting it. Both now raise a high-severity `refused_empty` or `false_success` violation on the action that caused them, naming the endpoint and quoting what the user was shown instead.
  
  The rules pair an exact half with a fuzzy one — a status code either is an error or is not, and the page half is never enough alone — so a page that is refused and says so raises nothing. Against the demo app, whose only 4xx is a missing image, they are silent.
- 22cd8ca: Add `scout_lane_brief`, and remember how a login state is regenerated.
  
  Dividing an app between parallel lanes by hand fails in two ways a finished run cannot tell apart from success. Lanes overlap, so two browsers audit the same register while a third module is never opened — and route coverage reads complete either way, because both lanes visiting a route makes it covered. And lanes launch underspecified: in one real four-session run the first two sessions acted with no task set, so the person watching the live view saw browsers clicking through their app with nothing to say why.
  
  `scout_lane_brief {lanes, goal}` computes the split instead. Routes are grouped into whole modules by their first path segment, so a lane that owns everything under one module carries state between its own steps rather than re-learning the app on every route, and modules are dealt out so the lanes come out within a route or two of each other. It returns each lane's session name, the `objective` to attach with, the routes it owns, and the two rules a hand-written brief keeps dropping. The same routes always produce the same split, so a lane that has to be re-run is handed the same brief.
  
  Separately, `scout_note` gains a `setup` section for how to get an app testable at all, and the `⚠ AUTH FAILED` message now quotes back whatever an earlier run recorded there. A storage state expires on a timer nobody remembers, and "regenerate it" is advice the reader already had; the command that worked last time is the part worth keeping.
- 8f06c37: The report is a worklist again.
  
  A project that has been tested for a while accumulates findings, and the report printed every one of them in full. On one real project that was 737 findings, 1.75 MB, of which 423 were open but unverified by that run and 314 were already fixed — and the eleven findings the run had actually just made were buried in the middle of it. A document nobody opens is not a report.
  
  Findings from this run still print in full. Findings from earlier runs, and resolved ones, are now an index: one row each with the id, severity, how long ago it was last seen, how many runs have seen it, and the title. The same project's report becomes 113 KB, 94% smaller, with nothing lost — every id is there, and `scout_report {history: "full"}` prints all of it exactly as before, which is what to use when handing the document to someone who cannot read the project's memory.
  
  Age is on every row because it is what decides whether an unverified finding is worth re-testing: one nobody has re-confirmed in four months is a different proposition from one seen last week.
- 93f9937: Add `scout_verify`: re-test what earlier runs left open, and record what each re-test found.
  
  The report has always carried two kinds of finding and been honest that they are not the same thing — what this run saw, and what some earlier run saw. The second kind was labelled historical and unverified, which is accurate and almost useless: a reader cannot tell a bug fixed three weeks ago from one still costing users money today, and neither can the next run. Closing that by hand meant copying each finding's route and evidence out of the report, re-walking them one at a time, and calling `scout_resolve` on the ones that were gone. One project's history held over three hundred.
  
  `scout_verify` called bare returns the open findings in the order to re-test them — worst route first, grouped so a route is walked once rather than once per finding — each with the evidence that identifies it and the steps that produced it. `scout_verify {ids}` narrows it, and names any that are not open rather than quietly shortening the list.
  
  After re-testing one, `scout_verify {id, verdict, note}` records it: `gone` resolves it, `present` stamps it confirmed so the report dates the confirmation instead of calling it unverified, and `changed` keeps it open and says the behaviour differs. The history index gains a "Re-tested" column, so a reader can see at a glance which of it is still believed.
- b706095: Make the live board answer, at a glance, which session is stuck and which is in trouble.
  
  On a board of eleven cards the questions actually being asked are "which one has been on the same thing for ten minutes", "which one is having trouble", and "where is the one on the orders register". The board could answer none of them, and two of the three answers were already in the status payload on every poll and reached nobody: `taskSince` was rendered only inside the close-up, and a step whose result went wrong was only ever a red word in a six-line feed somebody had to read.
  
  Each card now carries a line under its task: how long the session has been on it, and how many of its recent steps went wrong — counted with the same rule the feed colours red, so a card and the feed beneath it cannot disagree. The line is absent on a session that has stated no task and had no trouble.
  
  The header gains a filter over everything a card shows — name, role, objective, task, page, tool. It hides cards and nothing else: a filtered-out session is still running, still streaming and still counted in the header, and a filter that matches nothing says so rather than showing a blank page that reads as every session having gone.
  
  The close-up's timeline can be walked from the keyboard: arrows step, Home and End jump to the ends, and Space returns to what the session is showing now. Scrubbing a long run by clicking 16-pixel ticks was the thing a mouse was worst at, and the run worth examining is always the one with hundreds of steps.
- 2e5a808: What a run shows about itself.
  
  A four-session validation pass exposed several things the engine knew but never said. All of them are fixed here.
  
  **Recording covers the breadth pass.** A crawl now keeps a frame per route it visits, and a snapshot keeps one too. The run that prompted this kept 9 frames out of 67 actions, none of them from the 30 routes a crawl had just swept — the evidence artifact was missing exactly where the coverage happened.
  
  **A session says what it is doing from the moment it appears.** `scout_attach` takes a `task`, and puts up a placeholder when none is given, so a fresh card no longer reads "Nothing stated yet" while the session works. The placeholder is display only: it does not satisfy the requirement that an agent state its task before a tool acts.
  
  **Several engines on one project no longer erase each other.** Each writes `status.<pid>.json` and its own token file, and `scenescout watch` lists every live engine with its address instead of finding only whichever attached last. The shared `status.json` is still written for older readers.
  
  **The report says how the run was paced** — actions, span, median gap, longest gap, idle share and frames per session — and warns about a session that has held a browser with nothing to do for over five minutes. Idle share is labelled as time the browser waited for the agent, because it is not a measure of the engine.
  
  **Memory stops growing without limit.** A route keeps its most recent states, capped, so a history that had reached 6,075 states and 36 MB — parsed and re-serialised on every save — is trimmed on open. States a finding points at are never dropped, and coverage is unchanged because it is asked per route.
  
  **`scout_scan` says which saved logins have expired**, rather than leaving it to be discovered by attaching and landing on a login page.
- cfdc508: `scout_request` — call the app's own API as the session, with the UI bypassed.
  
  A refusal shown by hiding or disabling a button is not a refusal. Confirming that the server refuses the same action is the most valuable check a permission pass makes, and until now it could only be done outside the tool, in a shell with curl and a hand-extracted token. None of that evidence reached the report: a whole validation run's permission matrices lived in shell history and went with it.
  
  The request is made by the page, not beside it, which matters twice. It goes through the same interception the write policy is enforced on, so a safe-write session cannot reach past the policy by calling an endpoint instead of clicking it — the browser suite proves a replayed `DELETE` on a record the session did not create is refused exactly as a click would be. And it carries the session's own credentials, because it is the same origin with the same cookies. Bearer schemes work by replaying whatever `Authorization` header the app itself last sent, so nothing in the engine knows what a token looks like or where an app keeps one.
  
  The result leads with the signature a finding should quote (`GET /api/admin/users 403`), then the timing, then the headers that decide whether two responses are genuinely identical — content-type, location, www-authenticate, retry-after, cache-control — then the body. Every call is recorded in the run's trail.
  
  Paths are fenced to the attached origin, as navigation is: a session talks to its own app, and another host needs another session.
- b0f75ec: Wait for the requests an action fired, rather than a fixed sleep, and let a session ask to be slowed down.
  
  Every action used to be followed by a flat 400 ms sleep. Measured against the demo app that was 54% of a snapshot's wall time, and a run of two hundred actions spent over a minute asleep — while any page slower than 400 ms was still read before it had finished changing. The engine already intercepts every request, so it now waits on what is actually in flight, with a quiet window after the last one starts and after the action itself, and the old constant survives as a ceiling instead of a floor. On the demo app a navigate costs 149 ms rather than 430, and a snapshot 446 rather than 740.
  
  The same rule carries the opposite need. `scout_attach {paceMs}` and `scout_session {paceMs}` set a floor between actions so a person watching can follow along — useful when taking notes beside a run or demonstrating a flow. Unset, a session runs as fast as its page allows; `scout_session {paceMs}` with no `name` changes every attached session at once.

### Patch Changes

- aa77244: Catch a client-side auth guard that redirects after the page has gone quiet.
  
  Settling on the requests an action fired is faster than a fixed sleep and more patient with a slow page, but it cannot wait for something that has not been scheduled. A client-side auth guard issues no request until its timer fires, so the page goes quiet, the URL is read, and the gated route is recorded as reached — the bounce invisible, and a dead session along with it. The removed 400 ms sleep had been covering this by accident, and this project's own CI began failing intermittently on a 40 ms guard that a loaded runner delayed past the quiet window.
  
  Where a bounce verdict is made — attach judging a storage state, navigate judging coverage — the URL is now watched until it has held still rather than read once. It is a window rather than a guarantee: a guard slower than it still lands after the verdict, and is caught on the next action. Only a session that was given credentials pays for it on every navigation, so an anonymous crawl keeps its full speed: navigate 179 ms and 470 ms per route, unchanged.

## 3.2.0

### Minor Changes

- a3c7ed4: Parallel lanes hand their results back as one typed lane report, not prose. A new `scout_lane_report` tool serves both halves: without a reply it returns the paragraph to put in a lane's prompt (verdict, severity and category from closed sets, a calibrated confidence per decision, a bounded evidence signature, routes covered, what blocked the lane), and with one it parses what the lane handed back and returns the one-line fold or the reason the reply was refused. The instruction is generated from the same constants the parser checks and states every limit the parser enforces. The finding categories now live in one list shared by `scout_finding`, the lane report and the skill text. The skill's parallel-agents section tells the planner to use the tool and to run lanes at medium effort, the pick from a benchmark under `scripts/bench/` that measured both reply shapes at every effort level the CLI accepts.

### Patch Changes

- 0b99401: The read-only write policy no longer refuses a control because of a destructive word in its description. A card or tile that is a button carries prose in its accessible name, a title then a sentence about it, and a word in that sentence describes what the thing is for rather than what the click does. A label that is prose, longer than six words and containing a sentence, is now judged by its first six words, where the verb lives; every other label is still judged whole, so a long confirm button stays refused. The pattern still sees the whole label, so exemptions that look ahead ("reset filters") keep working. This is what refused the manager card on a sign-in page whose sentence mentioned orders that need sign-off. Separately, "sign off" is now read as the noun when the word before it says so ("Needs sign-off", "Awaiting sign-off", "Send for sign-off"), so those short labels are no longer refused either.

## 3.1.1

### Patch Changes

- 99562e7: The run's page now notices when the engine behind it has exited.
  
  That address is served by a process. Once the process is gone, reloading it
  gets the browser's own "site can't be reached" and the tab is lost, although
  everything on the page was still readable a moment earlier. The served copy
  now watches the engine, and when it goes says so in place: the page is still
  good, reloading will not reach anything, and the copy that survives — with its
  frames — is at the path it names, ready to copy. Leaving the page from then on
  asks first, so a reflexive refresh cannot throw it away.
  
  A browser will not follow a `file://` link from a served page, so the saved
  copy cannot be opened from there; the path is offered instead. The copy on
  disk carries none of this and stays a plain document with no script in it.

## 3.1.0

### Minor Changes

- 52d97d8: Record a run, and read the whole thing back afterwards.
  
  `scout_attach {record: true}` keeps a frame of the page after every action, and
  `scout_report` then writes `report.html` beside `report.md`: the report, the
  screenshots taken around each finding, and every session's trail in the blocks
  its tasks made — one self-contained page that opens from the file system with
  nothing running. Recording is off unless asked for, because the frames are
  pictures of the app under test and no redaction can read a picture
  ([ADR 8](docs/adr/0008-a-recorded-run-is-evidence-and-must-be-asked-for.md)).
  
  The live view serves the same document at its own address and goes there when
  the run ends, so the report survives a refresh instead of dying with the board.
  The close-up gains a timeline: a tick per action, coloured by task, that plays
  a recorded run back while it is still going. A finding's screenshots also hang
  under it in the live report panel, which no longer resets itself while it is
  being read.
  
  Fixes: a listener left on a control that had been replaced threw on load and
  left the board blank; a viewer arriving after the last browser closed saw the
  empty state instead of the finished run; a finding's evidence could be drawn
  from a different session than the one that filed it.

## 3.0.1

### Patch Changes

- f99062d: The close-up's feed shows one pastel tint per task again, so a change of task is a change of colour and the block of actions a task covers is legible at a glance; hovering a block names the task in the brief, under the session's objective. The tints are lifted on a light card so they read the same either way. A close-up with no frame now says "No frame available" like a card does, instead of showing a broken-image icon.

## 3.0.0

### Major Changes

- c7c4811: **A session now says two things, and the second is required.** Its **objective** is the whole remit it was given, set once at `scout_attach {objective}` — "Admin lane: §2 registers, §7 plan gating". Its **task** is what it is doing right now, and every tool that acts on the app — `scout_navigate`, `scout_back`, `scout_click`, `scout_type`, `scout_select`, `scout_press`, `scout_upload`, `scout_run_plan` — takes one: a few words for the batch in front of it ("Filtering the documents register by status"). It stays set until a different one is passed, `scout_journey` sets it while a journey runs, and reading the page needs none. A call that acts with no task standing is refused, with what to pass and why.
  
  This exists because both were optional and therefore usually absent: someone watching a run saw sessions working through their app with nothing to say why, which is the one thing the live view is for. Stating a task also marks the action log, so the close-up's feed groups and tints the actions that follow it, as it already did for a journey's.
  
  Breaking, in two ways. An agent that never states a task now gets a refusal instead of a click. And the two names swapped to match what they mean: `scout_attach {task}` is now `scout_attach {objective}`, and the per-call `objective` of 2.0 is now `task`. Both old names are still accepted, so a caller written against 2.0 keeps working.

## 2.0.0

### Major Changes

- 74a45d6: **A tool that acts on the app now needs an objective.** `scout_navigate`, `scout_back`, `scout_click`, `scout_type`, `scout_select`, `scout_press`, `scout_upload` and `scout_run_plan` take an `objective`: one short sentence naming what the current batch of actions is for. It stays set until a different one is passed, so a batch costs one sentence rather than one per call, and `scout_journey` still sets it (and outranks it) while a journey runs. A call that acts with none standing is refused with what to pass and why.
  
  This is the breaking part: an agent that never states one now gets a refusal instead of a click. It exists because the objective was optional and therefore usually absent — someone watching a run saw sessions working through their app with nothing to say why, which is the one thing the live view is for. The objective now also appears on each card in the grid, not only in a session's close-up, and a session that has not said anything yet says so.

## 1.5.0

### Minor Changes

- 791b4d0: The live view now hands over the report when the run ends. Closing the last session used to take the report with it — the view served it from the live engine, so the moment the browsers went the page said there was nothing to report. The last rendering is now kept, and when the board empties the page says the run has finished, opens the report by itself, and names the file it belongs in: `saved at <path>` once `scout_report` has written it, or plainly that it is not on disk and this page holds the only copy. A **Save a copy** button downloads that copy through the viewer's own browser (nothing is asked of the engine, which still answers `GET` and nothing else), and closing the tab on a finished run whose report was never written asks for confirmation first.

## 1.4.0

### Minor Changes

- 01fe452: The engine now notices when a value it typed comes back as markup. Any markup-shaped value the agent types — `<script>…</script>`, `<img src=x onerror=…>`, a `<b>` — is remembered by shape, and every page seen afterwards is checked for an element of that shape. When one is found, a `dom_injection` violation (severity high) names the field it was typed into, the page it was typed on, the page it rendered on and the element it became: whoever opens that page runs the input, which is a stored or reflected XSS. The oracle never chooses what to type; the method asks for markup in the fuzzing pass, and the rest is the agent's judgment.

### Patch Changes

- 2deca2a: Two findings that name the same endpoint no longer merge unless both name a failure status for it. A double submit and an accepted bad value can both mention `POST /api/orders` and are two bugs; the second one filed used to be absorbed into the first without a trace.
- 4e10197: The live view's header keeps its two buttons together when it wraps on a narrow screen, numbers that tick every second (badges, feed times, the session counts) use tabular numerals so they no longer jitter, the feed's journey groups are marked by their tint with a hairline rather than a stripe, and the scrolling panels and text selection take the page's own palette.
- 978022a: Every record a session creates is now named in the result of the action that created it (`created: /api/things id=44`), including the second and later ones on an endpoint. The state-changing-request notice reports each endpoint once per session, which in safe-write mode hid every creation after the first, so the agent could not tell from the result that it had just made one.
- dd8927a: `scout_run_plan` now prints a type step's note about the field (such as "replaced existing content") on that step's own line. It used to appear under the previous step, so a reader concluded the wrong field was prefilled.

## 1.3.0

### Minor Changes

- a7c978a: `scenescout install` now puts the `scenescout` command on your PATH. Until now neither an `npx` run nor a source checkout left it there, so `scenescout status`, `scenescout doctor` and the other commands the tool itself tells you to run answered "command not found".
  
  Run through `npx`, install does `npm install -g` of the version you ran. From a checkout it does `npm link`, so the command always runs what you last built, and From a checkout it runs `npm link`, taking the name over from any other copy the way install already takes over the MCP registration. Run through `npx`, a command that is already there is left alone. On Windows the step prints the command to run by hand. If npm refuses, the step prints the command to run by hand and does not fail the setup. `--no-command` skips it.
- 195cb59: Watch a run live. `scout_attach` now returns a `Live view:` address, which the agent passes on to you, and `scenescout watch <project>` opens the same page from a terminal. It shows one card per session: the tool it is running, how long it has been there, the page it is on, a thumbnail of that page, a rolling feed of what it just did (each action, its target and how it turned out, read from the same action log a finding's repro trace uses), and a live stream you can switch on per session or for all of them. Opening a card's close-up shows a longer stretch of that feed beside the session's brief: the task the agent gave it at `scout_attach {task}`, and the goal of the journey it is on right now. Actions of one journey share a tint in the feed, and pointing at a group shows the goal those actions served. The Report button shows the run's report as it stands, rendered from the current state without writing it, so it can be read while the run is still going. It works for headless runs, and a session whose call is still running past its own tool's watchdog budget is marked as stuck.
  
  `status.json` now describes every session instead of the last one to write, and `scenescout status` prints a line for each.
  
  The live view is served on `127.0.0.1` only, behind a per-process token, answers GET and nothing else, and writes no frame to disk ([ADR 7](docs/adr/0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md)). A stream runs only while someone is watching it. Set `SCENESCOUT_LIVE=off` to keep the engine from opening the port. The engine now also shuts down, closing its browsers and removing the token file, when its client closes the connection instead of sending a signal.

## 1.2.0

### Minor Changes

- 2932164: `scenescout install --browsers <list>` chooses what to download: `chromium` (the default, unchanged), `chromium-headless-shell` for the smallest working setup, `firefox`, `webkit`, or `all`. `scout_attach` takes a `browser` option, and `SCENESCOUT_BROWSER` sets the default. In Firefox and WebKit the engine keeps service workers from registering, because a request issued by one cannot be intercepted there and would pass the write policy. The missing-browser message and `doctor` now name the build that is actually missing, and the sizes quoted are the sizes on disk.
  
  Pages are no longer given shared workers unless the mode is `destructive`. A request a shared worker sends cannot be intercepted in any browser, and a `DELETE` sent from one reached the server in read-only mode.
  
  Hover no longer reports text that was already on the page and only moved to a new line, and the keyboard focus audit uses Option+Tab in WebKit on macOS, where plain Tab skips buttons and links.
- ad0f31d: `scenescout install --client <list>` registers the server with clients other than Claude Code: `cursor`, `vscode`, `codex`, `gemini`, `copilot` and `windsurf`. Clients that have a command for adding a server are registered through it; Cursor and Windsurf get an entry added to their JSON server list, with every other entry kept and an unreadable file left untouched. For VS Code, a `code` command that belongs to another editor is not used. The skill is installed only when `claude-code` is among the clients.
- 5504c63: The testing method now reaches every MCP client, not only Claude Code. A new `scout_playbook` tool returns it, the server's instructions tell an agent to call that tool before its first attach, and an `explore` prompt loads the method together with the target URL for clients that list server prompts as commands. It is the same text Claude Code loads as a skill, read from the same file.

### Patch Changes

- d0aa6aa: The package description, keywords and README now present SceneScout as a tool for any MCP client, with Claude Code as one of them. `doctor --engine` ends with what to ask an agent instead of a Claude Code command.

## 1.1.0

### Minor Changes

- d3ebd73: Snapshots now list images that failed to load, under `BROKEN IMAGES`, read from the DOM. This catches an image whose URL answers 200 with something that is not an image, which the HTTP oracle cannot see because no request failed. Images that occupy no space (inside a closed panel, tracking pixels) are not reported.
  
  An `<img>` is now named by its alt text and listed with the role `image`; it previously appeared as `generic "(unnamed)"`. For the uncommon `<img>` that is collected without a `data-testid` (one with `onclick` or an explicit role), this changes its element key, so states containing it are seen as new once.
- 5706a55: `scout_scan` now reads routes from source for React Router, Vue Router and Angular projects, including nested children, `<Route>` elements and Angular `loadChildren` files. These projects previously started with an empty route list and relied on link discovery alone, so a page nothing linked to was outside the completion contract. The reader is static and skips anything it cannot resolve: computed paths, spreads, identifiers, and relative paths whose parent is unknown.
- 6b6b786: The geometry oracle now reports a pinned control that sits underneath other pinned chrome, for example a sticky Save row covered by a fixed bar. Box overlap cannot tell which of two pinned elements is on top, so that pair was skipped; the new check hit-tests the control's centre in the page. It stays quiet for controls inside a scrollable pane, for dialogs, and for overlays covering half the viewport.
- 0d320b1: New write mode `observe` (`--observe`): nothing but `GET`, `HEAD` and `OPTIONS` requests leaves the page, except logging in, logging out and refreshing a token. Signing up and password changes are blocked. WebSocket frames are not inspected, and the engine says so when the app opens one. `read-only` lets an ordinary form `POST` through, which on a target holding real data creates a record. The skill now attaches in `observe` for a remote URL with no source unless told that form submissions are acceptable. Forms that could not be submitted stay in the gap ledger, worded as the mode's doing.

### Patch Changes

- 0d320b1: The login exemption in the write policy no longer applies to destructive-looking requests in any mode. A path that merely contained a word such as `session` or `auth` previously carried a request like `POST /api/session/123/delete` through `read-only`. A form navigation blocked by the write policy is now reported as blocked; it was reported as an off-origin navigation, and the follow-up note blamed the app for discarding data.
- 4107696: `scenescout doctor` now suggests `npx -y scenescout install` when the tool was installed from npm. It previously suggested `npm run setup`, which exists only in a source checkout.

## 1.0.0

### Major Changes

- First release on npm.
  
  SceneScout is an MCP server that lets an AI agent explore a running web app like a curious user and write a coverage-checked report. The engine contains no model and needs no API key: the agent supplies judgment, the engine supplies a structured view of the page, always-on correctness oracles, a write policy enforced at the network layer, cross-run memory and a report that lists what it did not test.
  
  - **Install** as a Claude Code plugin, with `npx -y scenescout install`, or from source. Any MCP client can drive it with `npx -y scenescout serve`.
  - **24 tools**, all prefixed `scout_`. Earlier pre-release builds used `ft_`; there are no aliases.
  - **Works with or without the source code.** Next to a codebase, routes are read from Next.js, SvelteKit and Nuxt projects. Against a remote URL, routes are discovered from same-origin links.
  - **Read-only by default.** `PUT`, `PATCH`, `DELETE` and destructive-looking requests are blocked on the wire. `safe-write` lets a run edit and delete only the records it created.
  - **A demo app and a sample report** are in the repository: `npm run demo:serve`, and `examples/report.md`.
