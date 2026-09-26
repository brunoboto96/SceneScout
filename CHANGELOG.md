# scenescout

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
