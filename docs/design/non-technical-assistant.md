# Design: a guided QA assistant for people who do not write prompts

Status: **proposed** — for the owner's approval before any building. Issue [#511](https://github.com/brunoboto96/SceneScout/issues/511).

This is a design, not a decision record. Once it is approved, the first build pull request adds an ADR for the decisions in [section 6](#6-safety-and-privacy) and [section 3.6](#36-care-levels-in-plain-words), because they change a rule an earlier change set: plain answers never reach `safe-write`.

Contents:
[1. Who it is for](#1-who-it-is-for) ·
[2. The flows](#2-the-flows) ·
[3. The shared plain-language layer](#3-the-shared-plain-language-layer) ·
[4. Each surface: what it can and cannot do](#4-each-surface-what-it-can-and-cannot-do) ·
[5. More UX worth having](#5-more-ux-worth-having) ·
[6. Safety and privacy](#6-safety-and-privacy) ·
[7. Build plan](#7-build-plan) ·
[8. Open questions](#8-open-questions)

---

## What already exists

Much of the plain-language layer is already in the engine. This design builds on it rather than beside it.

| Piece | Where it lives | What it gives the guided assistant |
|---|---|---|
| Four plain start questions and the settings they choose | `src/intake.ts`, `scout_intake` (a form through MCP elicitation, or questions in chat) | The pattern for a guided start: answers in plain words become `scout_login` and `scout_attach` calls |
| Plain wording for every finding category and oracle | `src/engine/plain.ts` (`PLAIN_WORDING`, `IMPACT`, `plainSteps`, `plainFinding`) | Severity as "Blocks users / Annoying / Cosmetic", the problem and the expected behaviour in a sentence, repro steps a person can follow |
| The `qa` report audience | `scout_report {report: "qa"}` | A whole report in plain words |
| The run-status pane | `scout_status` and `scout_status_poll`, an MCP App (`ui://scenescout/status.html`) | Sessions, open findings by severity, coverage, a link to the live view, refreshed every 2.5 s |
| The Claude Code mod | `mods/scenescout-mod/` (`register.js` wires events; `pane.js` holds every rule and is table-tested in `live-test`) | A pane in the Code tab that polls the same status data |
| Re-tests | `scout_verify` | "Gone / still there / changed" for each earlier finding |
| Filing issues | `scenescout export` (`src/engine/export.ts`, ADR 18) | Each finding filed once, a dry run unless told otherwise |
| A test report from a template | `scenescout check --record --template` (`src/engine/check-report.ts`, ADR 22) | A laid-out report with an evidence manifest, for a recorded check |
| Saved flows | `.scenescout/flows/*.json`, replayed by `scenescout check` | Repeatable steps with no model |

What is missing is the layer that ties these together for someone who never sees a tool name: a guided plan, a progress model in plain words, finding cards as data rather than Markdown, and one-click actions that are safe to put behind a button.

---

## 1. Who it is for

### Personas

| Who | What they want done | What stops them today |
|---|---|---|
| **Priya, manual QA tester** | Check a release candidate before it goes out, and hand developers problems they can reproduce | Has to know to type `/scenescout`, read tool output, and copy findings into tickets by hand |
| **Marco, product manager** | Know whether the new sign-up journey works on a phone before the demo, and send the team a list | Does not use a terminal; would not know what "observe" or "role" mean |
| **Sam, solo founder** | A quick health check of the live site after a deploy, without breaking anything | Worried an AI clicking around the live site will delete customer data |
| **Dana, agency consultant** | A tidy report for a client showing what was tested and what was found, with pictures | The report is written for developers; there is no client-ready version from an exploratory run |

### Jobs to be done

1. "Tell me what is broken on my site, in words I understand, without me having to explain how to test."
2. "Do not touch my real data unless I say so."
3. "Show me each problem so I can see it for myself, and tell me how to make it happen again."
4. "Give me something I can send to my developers or my client."
5. "When they say it is fixed, check again."

### What success looks like

- A person who has never used SceneScout goes from install to a first list of problems **without typing a prompt or a command**, other than signing in to their own app in a browser window.
- Every problem they see has a severity in plain words, a page, a picture (or a one-click way to see one) and steps to repeat it.
- They can produce a report and file tickets **without leaving the panel or the chat**, and nothing is filed or written outside the project folder without a click that says what will happen.
- Nothing is created, changed or deleted in their app unless they chose a care level that allows it, and the choice is explained before the run starts.
- The engine's existing tests stay green and every new rule has a table test (the cheapest layer that can fail).

---

## 2. The flows

Two surfaces, one engine layer:

- **The Code tab** (Claude Desktop's Code tab, and the Claude Code CLI): the mod draws a **guided panel** with buttons, fields and choices. A button either calls the SceneScout server directly (`$.mcp.call`) or starts a turn for Claude (`$.prompt.submit`).
- **The chat** (plain Claude Desktop chat, claude.ai and other MCP hosts): the desktop extension offers **guided prompts**, a **start form** (MCP elicitation) and the **run-status pane** (an MCP App, where the host renders one), plus results in plain words.

### 2.1 First run

| Step | Code tab (mod) | Chat (desktop extension) |
|---|---|---|
| Install | Install the `scenescout` plugin and the `scenescout-mod` plugin from the marketplace (two lines, or the plugin browser) | Install the SceneScout extension (`.mcpb`) by double-click or from the extensions directory |
| First open | `/scenescout-guided` opens the panel on the **welcome** state with a one-screen tour ([5, item 1](#5-more-ux-worth-having)) | The person picks the **Check my site** prompt from the prompt menu, or says "check my site" |
| The browser | The first check downloads the test browser once (about 200 MB). The panel says so, with progress | Same, as a line in the chat and in the status pane |
| Sign in to the app under test | When the app needs sign-in, the panel shows **Sign in to your app**; pressing it opens a real browser window where the person signs in as they normally would. Nothing is typed into the panel | The start form asks *how* they sign in (never with what). Claude calls `scout_login`, which opens the same window |
| First check | The guided start ([2.2](#22-guided-start)) | The start form ([2.2](#22-guided-start)) |

### 2.2 Guided start

The person enters the address, ticks what to check, chooses how careful to be, and presses **Start**.

| What to check (plain words) | What it becomes | Limits by care level |
|---|---|---|
| Sign-up and sign-in | The sign-in and sign-up pages, error messages, wrong-password handling, the signed-in landing page | **Look only:** sign-in only; sign-up is looked at but never submitted. **May submit forms:** sign-up is submitted with made-up details |
| Forms | Every form found: required fields, error messages, what happens on submit | **Look only:** forms are filled and checked but not sent |
| Broken pages and links | A crawl of every reachable page: errors, dead ends, failed requests, missing pages | None |
| How it looks on a phone | The same key pages at a phone-sized screen (390 × 844), with the design audit | None |
| A journey in a sentence | The sentence becomes the run's objective ("Buy the cheapest item and check the receipt") | The journey stops where its care level refuses a step, and the card says so |
| Tickets (optional) | Pasted tickets; each acceptance criterion is answered | As the journey |

Plus **How thorough**: *Quick look*, *Normal*, *Thorough* — mapped to the levels `minimal`, `medium`, `extensive`.

Pressing **Start**:

1. The panel (or the form) sends the choices to the engine, which returns a **guided plan**: what will happen in plain words, what the care level will refuse, and whether a confirmation is needed.
2. If the care level is *May create test data*, or *May submit forms* on an address that is not on this machine, the person sees a confirmation ([6](#6-safety-and-privacy)) and must press **Yes, I understand** before anything starts.
3. Claude is handed the plan by its id and carries it out, keeping the progress model up to date.

### 2.3 Watching progress

The panel and the status pane show:

- one sentence for what is happening now, as a narrator would say it ("Now: trying to sign up with an email that is already taken"), with the last few sentences kept as a short story of the run (the agent-narrator mod's pattern: one plain sentence per step in a pane);
- each chosen area with a tick, a spinner or "skipped, because …";
- pages checked out of pages found, and time used out of time allowed;
- problems so far by impact (Blocks users / Annoying / Cosmetic);
- the newest finding cards as they arrive;
- an estimate of the clicking it saved, stated with its basis ("about 25 minutes of clicking: 41 pages and 63 controls at the rates in Settings"), never as a bare number ([question 12](#8-open-questions));
- in the Code tab, what the check has used of the person's Claude plan so far, against the cap they set ([2.11](#211-cost-before-and-during-a-check));
- **Watch it live** (opens the local live view in the browser);
- **Queue another check** (the claude-queue pattern: saved or new checks wait in a list and start, one at a time, when the current one ends);
- **Stop** (asks Claude to finish up and write what it has).

While a check runs, a one-line band above the prompt (the `AbovePrompt` site) and the status line (`$.ui.status`) carry the same "now" sentence and the problem count, so the person can close the panel and keep the run in view.

### 2.4 Reading findings

A list of cards, worst first, filterable by impact and area. Each card opens to the full card ([3.3](#33-the-plain-finding-card)): what happened, what was expected, where, the picture, the steps, and a folded technical detail. Card actions: **See picture**, **Copy steps**, **Check again**, **Not a bug** (records the person's verdict and reason; never deletes the finding), **Explain more** (starts a turn in which Claude explains the card in more detail, from the finding and its evidence only), **Add to tickets**.

This is the review-pane mod's pattern (comment on an item and send it back to Claude as structured feedback). The verdict is kept on the finding as a label (`scout_feedback`, [3.4](#34-mcp-tools-new-and-changed)): the report lists "not a bug" findings apart, and the labels can be exported as **candidates** for the benchmark answer key and the dedup pairs, for a maintainer to review. They never change the key or dedup on their own ([question 9](#8-open-questions)).

### 2.5 Team report

**Make a report** writes, inside the project's `.scenescout/` folder:

- `team-report.html`: the plain report (the `qa` audience), with a cover (address, date, what was checked, care level, how thorough), a one-paragraph summary, the cards with pictures, what was not checked (from the gap ledger), and blank sign-off lines;
- an **evidence pack** folder beside it: the pictures, the plain report as Markdown, and a manifest of every file's SHA-256 with the SceneScout version and the run's times, as ADR 22 does for a recorded check.

A template the project keeps (`.scenescout/report-template.json`, the same schema family as `check --template`) can rename sections and words. Without one, a built-in plain layout is used. Then **Open the report** and **Show the folder**.

### 2.6 Tickets

1. The person ticks the cards to file (or *All that block users*).
2. **File as tickets** asks where (GitHub or Jira), once; the panel remembers the answer per project.
3. The engine returns a **preview**: each ticket's title, what is already filed (found by its marker, ADR 18), and how many will be created. Nothing is sent yet.
4. **File 3 tickets** sends them; each card then shows its ticket link.
5. Filed tickets are **watched** (the cc-pr-tracker and inbox-alerts pattern): in the Code tab, the band above the prompt lists open tickets SceneScout filed for this project, and a toast says when one is closed. A closed ticket offers **Check again**; a re-check that finds the problem gone toasts "Fixed and confirmed". The watch reads the tracker through the server (`scout_ticket_status`), with the same token, at most every 5 minutes and only while Claude Code is open.

The tracker token never passes through the panel, the chat or Claude ([6](#6-safety-and-privacy)).

### 2.7 Re-check after a fix

From the results, **Re-check** (all open problems, or the ticked ones). The engine builds a re-check plan from those findings; Claude visits each and records gone, still there or changed (`scout_verify`). Cards move into **Fixed**, **Still there** and **Changed**, and the report can be remade.

### 2.8 Saved checks

**Save this check** stores the choices (address, areas, journey sentence, care level, thoroughness; never a password or token) as `.scenescout/guided/<name>.json`. The welcome state lists saved checks with **Run again**. A saved check that is run again uses the same care level and shows its confirmation again where one applies.

### 2.9 The end-of-check card

When a check ends, the panel shows a one-screen recap the person can share with the team (the session-wrapped mod's `/wrapped` pattern): the address, pages checked, problems found by impact, fixed since the last run of the same saved check, and the time it took. **Save as picture** writes it as an SVG file (and a PNG where a rasteriser is available, see [question 13](#8-open-questions)) inside `.scenescout/`, built by the engine from the run's figures, never from free text a page supplied. On the desktop surface the panel draws the same SVG with the `Svg` element; in the chat, `scout_team_report` returns it as an image block.

### 2.10 An optional game layer

Off by default, one switch in the mod's settings (`game: on`). It borrows the boss-fight and code-pet mods' idea, kept gentle and tasteful, in the project website's visual style:

- each open finding is a creature in a **bestiary**, sized by impact (a large one for "Blocks users");
- a re-check that finds a problem gone **defeats** it, with a short animation drawn as `Svg`;
- the end-of-check card gains the bestiary's count ("3 defeated, 2 still about").

It changes no wording on the cards, the report or the tickets, and never appears in anything shared outside the panel. It is drawn by the mod only; the engine knows nothing about it.

### 2.11 Cost before and during a check

The budget-guard, burn-meter and context-lens mods show what a session is spending. In the Code tab the mod can do the same, because `$.session.usage()` returns the session's rate-limit windows and cost as the status line has them, and the `session.measure` event pushes each change:

- **Before Start**, the configuring state shows an estimate ("A Normal check usually uses about 8% of your 5-hour limit"), from the person's own earlier checks kept in `$.store`, or a stated default until there are some.
- The person sets a cap ("Stop at 25% of my limit"). The mod watches `session.measure` and, at 80% of the cap, toasts a warning; at the cap, it asks Claude to stop and write what it has.
- The chat has no such figures for a server to read, so there the engine's own time and page caps are the only budget, and the plan states them ("at most 20 minutes and 60 pages").

### 2.12 Panel wireframes (Code tab)

**Empty / welcome**

```text
+-- SceneScout ---------------------------------------------+
| Find what is broken on your site, in plain words.         |
|                                                           |
|  [ Check a site ]        [ How it keeps your data safe ]  |
|                                                           |
|  Saved checks                                             |
|   Shop: sign-up on a phone      last run 2 days ago       |
|     [ Run again ]  [ Edit ]                               |
|   Admin area                    never run                 |
|     [ Run again ]  [ Edit ]                               |
|                                                           |
|  New here? [ Take the 30-second tour ]                    |
+-----------------------------------------------------------+
```

**Configuring**

```text
+-- SceneScout: new check ----------------------------------+
| Address of the site                                       |
| [ https://staging.example.com                         ]   |
|                                                           |
| What should I check?                                      |
|  [x] Sign-up and sign-in                                  |
|  [x] Forms                                                |
|  [x] Broken pages and links                               |
|  [ ] How it looks on a phone                              |
|  [ ] A journey:  [ Buy the cheapest item and pay      ]   |
|                                                           |
| Do you need to sign in?   ( No  v )                       |
|                                                           |
| How careful should I be?                                  |
|  (o) Look only - nothing is sent but page loads           |
|  ( ) May submit forms - forms are sent, nothing deleted   |
|  ( ) May create test data - only on a test copy           |
|      [ What does this mean? ]                             |
|                                                           |
| How thorough?   ( Normal  v )                             |
|                                                           |
| Sign-up will be looked at but not submitted in Look only. |
|                                                           |
|            [ Cancel ]                     [ Start ]       |
+-----------------------------------------------------------+
```

The radio list is drawn as a `Select` or as three `Button`s with one marked; the mod API has no radio element.

**Confirmation (only for the two cases in section 6)**

```text
+-- Before I start ----------------------------------------+
| You chose "May create test data" for                     |
| https://staging.example.com                              |
|                                                          |
| What this check may do there:                            |
|   + create accounts, orders or other records it needs    |
|   ~ what it sends can also change a record that was    |
|     there                                                |
|   ~ delete only the records it created                   |
|   - never delete anything outside its own records        |
| Use this only on a test copy, never on a live site.      |
|                                                          |
| Next, a short form asks you to type a code to go on.     |
|                                                          |
|    [ Go back ]              [ Yes, it is a test copy ]   |
+----------------------------------------------------------+
```

The preview lists what the care level allows and refuses, in the blast-radius mod's style (show the effect, then Proceed or Cancel). Pressing **Yes** opens the server's confirmation form ([6.3](#63-confirmations)), which for **May create test data** also asks the person to type a four-digit code it shows (the launch-codes pattern), so a stray click or a key held down cannot accept it. **May submit forms** on a remote address needs the answer only. The code is not a secret; it is a deliberate pause, and the server checks it.

```text
```

**Running**

```text
+-- Checking staging.example.com ---------- 6m of 20m -----+
| Now: trying to sign up with an email that is already     |
|      taken, on /register                                 |
|  before: opened the sign-up page; filled in the form     |
|                                                          |
|  [done]  Broken pages and links   34 of 41 pages         |
|  [....]  Sign-up and sign-in                             |
|  [    ]  Forms                                           |
|                                                          |
| Problems so far:  2 block users  3 annoying  1 cosmetic  |
|                                                          |
|  ! Blocks users  Checkout button does nothing   /cart    |
|  ! Blocks users  Sign-up says "Saved" but fails /reg..   |
|  ~ Annoying      Error message hidden behind... /login   |
|                                     [ See all problems ] |
|                                                          |
| Saved you about 18 minutes of clicking (how?)            |
| Plan used: 6% of your 5-hour limit (cap 25%)             |
|                                                          |
|  [ Watch it live ]  [ Queue another check ]  [ Stop ]    |
+----------------------------------------------------------+
```

**Results**

```text
+-- Results: staging.example.com -- 6 problems ------------+
| Show: ( All v )   Area: ( All v )                        |
|                                                          |
| [x] ! Blocks users   Checkout button does nothing        |
|       on /cart · seen 1 time                             |
|       [ Open ]  [ See picture ]  [ Re-check ]            |
| [x] ! Blocks users   Sign-up says "Saved" but it failed  |
|       on /register                                       |
|       [ Open ]  [ See picture ]  [ Re-check ]            |
| [ ] ~ Annoying       Error message hidden behind banner  |
|       on /login                                          |
|  ...                                                     |
|                                                          |
| Not checked: 7 pages behind the admin sign-in. [ Why? ]  |
|                                                          |
| [ Make a report ]  [ File 2 as tickets ]  [ Re-check ]   |
| [ Save this check ]                       [ New check ]  |
+----------------------------------------------------------+
```

**One card open**

```text
+-- Checkout button does nothing --------------------------+
| ! Blocks users · The page said something worked when the |
|   server had refused it · on /cart                       |
|                                                          |
| [ See picture ]  (opens the image in your viewer)        |
|                                                          |
| What was done                                            |
|  1. Opened /cart                                         |
|  2. Pressed the "Checkout" button                        |
|                                                          |
| What was expected                                        |
|  The page reports only what really happened.             |
| What happened                                            |
|  The button shows "Order placed" but the server answered |
|  with an error.                                          |
|                                                          |
| > Technical detail                                       |
|                                                          |
| [ Copy steps ] [ Check again ] [ Not a bug ]            |
| [ Explain more ]                              [ Back ]   |
+----------------------------------------------------------+
```

**Report ready**

```text
+-- Report ready ------------------------------------------+
| team-report.html, with 6 problems and 9 pictures.        |
| Saved in your project's .scenescout folder.              |
|                                                          |
|  [ Open the report ]   [ Show the folder ]               |
|                                                          |
| Evidence pack: 11 files, each with a checksum.           |
+----------------------------------------------------------+
```

**Tickets preview**

```text
+-- File as GitHub issues in team/shop --------------------+
| 2 new issues will be created:                            |
|   - Checkout button does nothing                         |
|   - Sign-up says "Saved" but it failed                   |
| 1 is already filed and will be left alone:               |
|   - Error message hidden behind banner  -> #212          |
|                                                          |
|        [ Cancel ]                  [ File 2 issues ]     |
+----------------------------------------------------------+
```

**Error / sign-in needed**

```text
+-- I need you --------------------------------------------+
| Your sign-in to staging.example.com has run out.         |
| I paused the check after 18 of 41 pages.                 |
|                                                          |
|  [ Sign in again ]      [ Finish with what I have ]      |
+----------------------------------------------------------+

+-- Something went wrong ----------------------------------+
| I could not reach the SceneScout server.                 |
| Is the scenescout plugin installed and turned on?        |
|                                                          |
|  [ Try again ]   [ How to fix this ]                     |
+----------------------------------------------------------+
```

### 2.13 The chat, step by step

```text
Person picks the "Check my site" prompt.
  -> Claude calls scout_intake. The host shows one form:
       Address [            ]
       What to check  [x] Sign-up and sign-in  [x] Forms  ...
       Journey (optional) [            ]
       Sign-in  ( No sign-in v )
       How careful  ( Look only v )
       How thorough ( Normal v )
  -> The engine returns a guided plan. If it needs a confirmation, the
     server asks the person directly with a second short form
     ("Yes, it is a test copy" / "Go back"), not through Claude.
  -> Claude runs the plan and calls scout_status. Where the host renders
     MCP Apps, the status pane shows the progress and the newest cards;
     elsewhere Claude posts a short progress line every few steps.
  -> At the end Claude calls scout_cards and posts the cards: a picture
     (an image block) and the plain text of each, worst first.
  -> Follow-up prompts in the menu: "Make a team report", "File tickets",
     "Re-check after a fix", "Is it safe to run on my live site?".
```

---

## 3. The shared plain-language layer

Everything a person reads is decided in the engine, in pure modules with table tests, and returned by the MCP server as both text and `structuredContent`. Neither surface writes its own wording: the mod draws the structured data; the chat gets the text and, where it renders MCP Apps, the pane draws the structured data.

### 3.1 New pure modules

| Module | Holds | Tested in |
|---|---|---|
| `src/engine/guided.ts` | The choices, their validation, the plan built from them, the confirmation rule, saved checks' file format | new `guided-test` suite |
| `src/engine/plain.ts` (extended) | `plainCard()`, returning the card as data; `plainFinding()` renders from it so the report and the cards cannot drift | `contract-test` (where the plain wording is tested today) and `guided-test` |
| `src/engine/progress.ts` | The progress model: phase from the board, area state, the "now" sentence and its short story, the clicking-saved estimate and its basis | `guided-test`, and `live-test` for the pane's use of it |
| `src/engine/guided-words.ts` | Every fixed sentence: care levels, area labels, the safety explainer, error and sign-in messages | `guided-test`; `guide-test` holds the explainer equal to the Safety model page's summary |

None of them imports Playwright or the MCP SDK (ADR 5).

### 3.2 Types

```ts
/** How careful the run is, in the words the person chooses from. */
type Care = "look-only" | "may-submit-forms" | "may-create-test-data";

/** The write mode each care level is. `destructive` is never offered. */
const CARE_MODE: Record<Care, "observe" | "read-only" | "safe-write"> = {
  "look-only": "observe",
  "may-submit-forms": "read-only",
  "may-create-test-data": "safe-write",
};

type CheckArea = "sign-in" | "forms" | "broken-pages" | "phone" | "journey" | "tickets";
type Thoroughness = "quick" | "normal" | "thorough"; // minimal | medium | extensive
type SignIn = "none" | "sso" | "password" | "one-time-code"; // as intake.ts

/** What the person chose. Never holds a password, code or token. */
interface GuidedChoices {
  address: string;            // http(s), no userinfo; at most 2048 characters
  areas: CheckArea[];         // at least one
  journey?: string;           // required with "journey"; at most 500 characters
  tickets?: string[];         // required with "tickets"
  signIn: SignIn;
  care: Care;                 // default "look-only"
  thoroughness: Thoroughness; // default "normal"
}

/** What the engine says will happen. Built by guided.ts from GuidedChoices alone. */
interface GuidedPlan {
  planId: string;             // "gp-" + 10 random characters; held in the server process only
  choices: GuidedChoices;
  mode: "observe" | "read-only" | "safe-write";
  level: "minimal" | "medium" | "extensive";
  objective: string;
  /** Each area in plain words, and what the care level holds back there. */
  areas: Array<{ area: CheckArea; label: string; whatHappens: string; heldBack?: string }>;
  /** Null, or the sentence the person must accept before the run starts. */
  confirm: null | { reason: "creates-data" | "forms-on-remote-site"; sentence: string; accepted: boolean };
  /** Sentences to tell the person before starting, in order. */
  tellPerson: string[];
  /** The tool calls the agent makes, in order; the same shape intake.ts returns today. */
  calls: Array<{ tool: "scout_login" | "scout_attach" | "scout_tickets" | "scout_session"; args: Record<string, unknown> }>;
  /** Time and page caps, so progress can show "6m of 20m". */
  budget: { minutes: number; pages: number };
}

/** One finding as a person reads it. Built by plain.ts from a Finding. */
interface PlainCard {
  id: string;                 // the finding id, for re-check, tickets and feedback
  impact: "Blocks users" | "Annoying" | "Cosmetic" | "Worth a look";
  severity: "high" | "medium" | "low";
  title: string;
  problem: string;            // PLAIN_WORDING[category].problem
  expected: string;           // PLAIN_WORDING[category].expected
  happened: string;           // the finding's detail, one paragraph
  page: string;               // path on the app, e.g. "/cart"
  alsoOn: string[];           // other pages the same problem was seen on
  steps: string[];            // plainSteps(repro)
  area?: CheckArea;           // which chosen area found it, when known
  picture: null | { file: string; width: number; height: number; what: string }; // file relative to .scenescout/
  status: "open" | "fixed" | "still-there" | "changed";
  feedback?: { verdict: "not-a-bug" | "confirmed"; reason?: string; at: string }; // the person's label
  ticket?: { tracker: "github" | "jira"; ref: string; url: string };
  technical: { category: string; evidence?: string; route: string };
  firstSeen: string;          // ISO date
  timesSeen: number;          // runs
}

type Phase =
  | "starting" | "downloading-browser" | "signing-in" | "exploring" | "checking-phone"
  | "re-checking" | "writing-report" | "done" | "needs-you" | "stopped";

/** What the panel and the status pane show while a guided run is going. */
interface GuidedProgress {
  planId: string;
  title: string;              // "Checking staging.example.com"
  phase: Phase;
  now: string;                // one sentence, the narrator's line
  story: string[];            // the last few "now" sentences, oldest first, at most 5
  areas: Array<{ area: CheckArea; label: string; state: "waiting" | "in-progress" | "done" | "skipped"; note?: string }>;
  pages: { checked: number; found: number };
  time: { usedMs: number; budgetMs: number };
  problems: { blocksUsers: number; annoying: number; cosmetic: number; worthALook: number };
  latest: PlainCard[];        // newest first, at most 5
  /** Clicking saved, with its basis; null until a page has been checked. */
  saved: null | { minutes: number; basis: string; sentence: string }; // basis: "41 pages and 63 controls checked, at 30 s a page and 15 s a control. …"; sentence: the figure and its basis in one line
  needsYou?: NeedsYou;
  next: GuidedAction[];       // the buttons to offer now
}

interface NeedsYou {
  kind: "sign-in" | "sign-in-expired" | "confirm" | "browser-download-failed" | "server-error" | "address-unreachable" | "stuck"; // "stuck" added in PR 3: a step past its watchdog
  sentence: string;
  actions: GuidedAction[];
}

/** A button either surface can offer. `direct` calls the server; `prompt` starts a turn for Claude. */
type GuidedAction =
  | { kind: "direct"; label: string; tool: string; args: Record<string, unknown> }
  | { kind: "prompt"; label: string; text: string };

interface TicketPreview {
  previewId: string;          // valid for 10 minutes, for exactly these findings and this target
  tracker: "github" | "jira";
  target: string;             // "owner/repo" or the Jira project key
  create: Array<{ findingId: string; title: string }>;
  alreadyFiled: Array<{ findingId: string; ref: string; url: string }>;
  refused: Array<{ findingId: string; why: string }>; // e.g. a worth-a-look not ticked for filing
  credentialSource: string;   // "the GITHUB_TOKEN set for the extension", never the value
}

interface TeamReport {
  file: string;               // relative to the project: ".scenescout/team-report.html"
  evidenceDir: string;
  manifest: Array<{ file: string; sha256: string }>;
  problems: number;
  pictures: number;
}

interface SavedCheck {
  name: string;               // letters, digits, spaces, dashes; at most 60
  choices: GuidedChoices;
  savedAt: string;
  lastRunAt?: string;
}
```

### 3.3 The plain finding card

Every card has the same parts, in this order, on both surfaces. The words come from the existing `PLAIN_WORDING` and `IMPACT` tables, so a new finding category cannot ship without them (contract-test already holds that).

| Part | Example | Source |
|---|---|---|
| Impact | Blocks users | `IMPACT[severity]`; "Worth a look" for a `worth_a_look` tier |
| Title | Checkout button does nothing | the finding's title |
| What kind of problem | The page said something worked when the server had refused it | `PLAIN_WORDING[category].problem` |
| Where | on /cart, and also seen on /cart/quick | `url`, `seenOn` |
| Picture | the element, or the page | `picture`, `pictureShot` |
| What was done | numbered steps | `plainSteps(repro)` |
| What was expected | The page reports only what really happened. | `PLAIN_WORDING[category].expected` |
| What happened | one paragraph | `detail` |
| Technical detail (folded) | category, evidence, route, id | the finding |

As text (the chat, and the mod's fallback where nothing draws):

```text
BLOCKS USERS - Checkout button does nothing
The page said something worked when the server had refused it - on /cart
What was done: 1. Opened /cart  2. Pressed the "Checkout" button
Expected: The page reports only what really happened.
Happened: The button shows "Order placed" but the server answered with an error.
(id a1b2c3d4e5 - say "re-check a1b2c3d4e5" or "file a1b2c3d4e5 as a ticket")
```

### 3.4 MCP tools: new and changed

All new tools return text for every host, `structuredContent` matching the types above, an `outputSchema`, and tool annotations (`readOnlyHint`, `destructiveHint`; the SDK in use, 1.30.0, supports them and SceneScout does not set them yet).

| Tool | New or changed | Input | Output | Touches a browser? | Annotations |
|---|---|---|---|---|---|
| `scout_intake` | changed | `{ url?: string }` | The form gains *what to check* (a multi-select), *journey*, *how careful* and *how thorough*. Returns a `GuidedPlan` (text: the calls in order, as now) | no | read-only |
| `scout_guided_plan` | new | `{ choices: GuidedChoices }` or `{ planId: string }` or `{ saved: string }` | `GuidedPlan`. With `planId`, the plan already built (the mod's route: it builds the plan, then hands Claude only the id) | no | read-only |
| `scout_guided_confirm` | new | `{ planId: string }` | Asks the person directly through elicitation, server to person ("Yes, it is a test copy" / "Go back"; for *May create test data*, also a field where they type the code the form shows), and marks the plan accepted only on that answer. Either surface, or Claude, may call it: whoever calls, the answer comes from the person. Without elicitation the plan stays unaccepted and the run is offered in **Look only** | no | not read-only, not destructive |
| `scout_attach` | changed | gains `planId?: string` | Refuses a plan whose `confirm` is not accepted, and refuses a `mode` above the plan's. While a guided plan is open in the server process, any attach above `observe` without that plan's accepted `planId` is refused too, so leaving the id out is not a way round the confirmation. With no guided plan open, attach behaves as today | yes | as now |
| `scout_session` | changed | gains `area?: CheckArea` beside `task` | Sets which area the session is working on, for progress | no | as now |
| `scout_status` / `scout_status_poll` | changed | none | `PaneData` gains `guided?: GuidedProgress` | no | read-only |
| `scout_cards` | new | `{ filter?: { impact?: Impact[]; area?: CheckArea[]; status?: PlainCard["status"][] }; ids?: string[]; limit?: number /* ≤ 50 */; pictures?: "inline" \| "files" \| "none" }` | `{ cards: PlainCard[]; total: number }`. With `pictures: "inline"`, each card's picture as an MCP image block (PNG, scaled to at most 1024 px wide), at most 10 images per call | no | read-only |
| `scout_feedback` | new | `{ id: string; verdict: "not-a-bug" \| "confirmed"; reason?: string /* ≤ 300 */ }` | Records the person's verdict on the finding. The finding is kept; "not a bug" ones are shown under their own filter and listed apart in the report (ADR 4: nothing is lost). `{ export: true }` lists every label as candidate answer-key and dedup entries for a maintainer to review | no | not read-only, not destructive |
| `scout_recheck_plan` | new | `{ ids?: string[]; signIn?: SignIn; address?: string }` (default: every open finding but those marked not a bug) | A `GuidedPlan` with a `recheck` part, whose calls attach in the mode the findings were found in (never higher) and re-test with `scout_verify`. Built in PR 8: each finding records the strictest mode it was filed in (`foundInMode`; none recorded reads as observe), the plan runs in the strictest care level among the findings on one site, and findings found in a looser one are left for a re-check of their own rather than re-tested above it. `address` finds the project when no session is open | no | read-only |
| `scout_team_report` | new | `{ template?: string /* a file inside .scenescout */ }` | `TeamReport`. Writes only inside `.scenescout/` | no | not read-only, not destructive |
| `scout_ticket_preview` | new | `{ ids: string[]; to: "github" \| "jira"; target: string }` | `TicketPreview`. Reads the tracker to find already-filed issues; sends nothing | no (reads the tracker) | read-only, open-world |
| `scout_ticket_file` | new | `{ previewId: string }` | The tickets created, each with its link. Before sending, asks the person through elicitation to confirm the previewed list; sends only on that answer, only the previewed findings, and only while the preview is fresh. Refuses without elicitation ([6.3](#63-confirmations)) | no (writes to the tracker) | not read-only, open-world |
| `scout_ticket_status` | new | `{}` | The state of each ticket SceneScout filed for this project (open, closed, and when), read from the tracker; at most one tracker read per 5 minutes, cached between | no (reads the tracker) | read-only, open-world |
| `scout_saved_checks` | new | `{ action: "list" } \| { action: "save"; name: string; planId: string } \| { action: "run"; name: string } \| { action: "delete"; name: string }`, each with an optional `address` to find the project | `SavedCheck[]`, and with `run` the new, unaccepted `GuidedPlan` (built in PR 8 as an action here rather than `scout_guided_plan { saved }`). Writes only `.scenescout/guided/`, owner-only | no | not read-only |

Tickets reuse `export.ts` as it is: the selection, the marker, the inert issue body, the severity map, the cap and the stand-in-tracker tests. The tool is a thin second front door to it, as `scenescout export` is the first.

### 3.5 MCP prompts (the chat's entry points)

The desktop extension's server already lists `explore`, `live` and `login` through the protocol (`src/tools/guide.ts`). Added, in the same way:

| Prompt | Shown as | Arguments | What it asks Claude to do |
|---|---|---|---|
| `check-my-site` | Check my site | `url` (optional) | Call `scout_intake`; follow the plan; show progress with `scout_status`; end with `scout_cards` |
| `recheck` | Re-check after a fix | none | Call `scout_recheck_plan`; follow it; show the changed cards |
| `team-report` | Make a team report | none | Call `scout_team_report`; give the person the file's location |
| `file-tickets` | File problems as tickets | `to` (github or jira, optional) | Ask which cards; call `scout_ticket_preview`; show it; call `scout_ticket_file` only after the person's confirmation |
| `is-it-safe` | Is it safe to run on my live site? | none | Return the safety explainer from `guided-words.ts`, word for word |

None takes a password, token or code (the existing prompt rule in `src/prompts.ts` refuses such argument names).

### 3.6 Care levels in plain words

| The person sees | Under it, in small text | Mode | Default? | Confirmation |
|---|---|---|---|---|
| **Look only** | Only opens pages. Nothing is sent to your site except signing in. Safe on a live site. | `observe` | Yes, always | None |
| **May submit forms** | Fills in and sends forms, and presses buttons that send something, such as a contact form, a sign-up or a settings page. What it sends can create a record, and can change one that was there, as it would for anyone. Deletes are blocked. | `read-only` | No | When the address is not on this machine (not `localhost`, `127.0.0.1` or `::1`) |
| **May create test data** | Creates records it needs, such as an account or an order. What it sends can also change records that were there, but it deletes only what it created. Use only on a test copy. | `safe-write` | No | Always |
| *(not offered)* | Deleting data that was already there needs a developer to ask for it by name. | `destructive` | Never | Not reachable from either guided surface |

Below `safe-write`, an existing record can still change: `read-only` lets an ordinary `POST` through, because that is how validation bugs are found, and many apps save an edit (a profile, a setting, a "Like") with one. The write policy judges the request, not what sent it, so a `POST` a button's script sends passes exactly as a form's does, and the words do not promise that only a form can change anything. What they do promise is what the policy blocks: `PUT`, `PATCH`, `DELETE` and requests that look like a delete, in `read-only`; the same, except on records the run created, in `safe-write`. The write policy is unchanged. (Corrected while building PR 1: an earlier draft of this table said nothing existing is changed, and a later one that only a form could change it.)

This is a change from today's rule ("plain answers never reach `safe-write`"). The design keeps that rule's intent — nobody reaches a writing mode by answering an unrelated question — by making `safe-write` a separately named choice with a confirmation the person gives, not Claude. It needs an ADR ([8, question 2](#8-open-questions)).

### 3.7 The progress model

`progress.ts` builds `GuidedProgress` from what the engine already knows, on each status poll:

| Field | Comes from |
|---|---|
| `phase` | The board's current tool: `scout_login` is signing-in; the browser download is downloading-browser; an attach with the phone viewport is checking-phone; `scout_verify` is re-checking; `scout_report`, `scout_team_report` are writing-report; a session `STUCK`, an expired sign-in (`authloss.ts`) or a pending confirmation is needs-you |
| `now`, `story` | The session's `task` (already redacted when written), else a sentence for the current tool built from its arguments ("Opening /orders", "Typing an email address into the sign-up form"), by a fixed table in `guided-words.ts`, never by a model. The story keeps the last five |
| `saved` | Pages checked and controls exercised (coverage), times a per-page and per-control rate the person can change in the mod's settings; the basis is always returned beside the number |
| `areas` | The plan's areas; the session's `area` (set with `scout_session`) marks one in progress, and the next area or the report marks it done; an area the care level stops is skipped with its `heldBack` sentence |
| `pages` | Coverage (routes visited and known), as the pane already counts it |
| `time` | The plan's budget and the run's start (`pace.ts`) |
| `problems`, `latest` | The project's open findings this run, through `plainCard()` |
| `next` | Fixed by phase: done offers report, tickets, save, re-check; needs-you offers the matching recovery |

The model is updated by poll only (the MCP Apps specification sends no server notification to a view after it renders, which is why the status pane polls today).

### 3.8 How each surface calls it

| Action | Code tab (mod) | Chat |
|---|---|---|
| Build a plan | `$.mcp.call(server, "scout_guided_plan", { choices })` | `scout_intake` (form) or the prompt |
| Confirm a writing mode | After the panel's preview, the mod calls `scout_guided_confirm`, and the person answers the server's form ([6.3](#63-confirmations)) | Claude calls `scout_guided_confirm`; the person answers the same form |
| Start | `$.prompt.submit({ text: "Run the SceneScout guided plan gp-…: call scout_guided_plan { planId } and follow it." })` | Claude, already in the turn |
| Progress | Poll `scout_status_poll` every 2.5 s (as now) and draw `guided` | The MCP App status pane, or Claude's progress lines |
| Cards, report, tickets, saved checks | Direct `$.mcp.call`, no turn for Claude | Claude calls the tool from a prompt or a request |
| Re-check | `scout_recheck_plan` directly, then `$.prompt.submit` with its id | `recheck` prompt |
| Stop | `$.session.append` with "Stop the SceneScout run now and write what you have.", which the running turn reads at its next step ([4.1.1](#411-mod-mechanics-from-mods-that-already-do-this)) | The person says stop |

Only actions that need the browser go through Claude. Reading cards, making a report, previewing and filing tickets and saving checks are deterministic and run without a model turn, so they cost nothing and cannot be talked out of their rules.

---

## 4. Each surface: what it can and cannot do

Verified against the Claude Code mods type definitions (version 2.1.296) and the MCP SDK in this repository (1.30.0). "Confirmed" means read in a type or in this repository's code; "assumed" means not verifiable here and to be checked on a current Claude Desktop build before the PR that depends on it.

### 4.1 The Code tab (mod)

| Capability | Status | Where |
|---|---|---|
| A pane on the desktop surface with Box, Text, Button, Input, Select, Svg, Link, Code, Markdown, Client | confirmed | `Elements` table per `RenderSurface` (`'terminal' \| 'desktop' \| 'mobile' \| 'vscode'`) |
| Which elements each surface has | confirmed: Box, Text, Button, Link, Code and Markdown everywhere; Input and Select everywhere but mobile; Svg on desktop, VS Code and mobile; Client on terminal and desktop; Image and Raster on the terminal only. A tree naming an element its surface lacks fails whole | the `Elements` table per surface |
| Button presses, text input (`onInput`, `onSubmit`), select (`onSelect`) | confirmed | `ButtonProps.onPress`, `InputProps`, `SelectProps` |
| A button that starts a turn for Claude | confirmed, with a limit: it starts **only when the session is idle** and is never folded into a running turn | `$.prompt.submit(PromptSubmitArgs)` |
| Calling the SceneScout server directly, no permission prompt | confirmed | `$.mcp.call(server, tool, args)` returning `McpToolResult` (content blocks and `structuredContent`) |
| Timers for polling | confirmed | `$.clock.every` |
| Remembering per-person choices across sessions | confirmed, 4 MiB per plugin | `$.store` |
| A slash command | confirmed | `$.command.register` |
| A toast and a status line | confirmed | `$.ui.toast`, `$.ui.status` |
| A band above the prompt | confirmed | the `AbovePrompt` render component (`RenderComponent`), mounted with `$.ui.mount` |
| The session's plan usage and cost | confirmed; `rateLimits` is empty off a subscription and `cost` absent where it is not known | `$.session.usage()` returning `{ startedAt, context, rateLimits, cost }`; the `session.measure` event |
| Settings | confirmed | `userConfig` in `plugin.json`, a `string` field with `options` is a picker |
| Knowing which surface it draws on | confirmed | `e.surface` in a render hook; `$.session.surfaces()` |
| An interactive region with keys, pointer and its own state | confirmed | `Client` (`ClientSurface`); its elements exclude Svg, Raster and Image |
| **A raster picture in the desktop pane** | **not available**. `Image` and `Raster` are terminal-only; nothing documents Markdown image syntax; an `<image href="data:…">` inside an `Svg` source (at most 131,072 characters) is untested | `ImageProps`, `MarkdownProps`, `SvgProps` |
| A radio-button element | not available | — |

**Fallbacks.**

- **Pictures:** the card's **See picture** is a Markdown link with a `file:` address to the picture inside `.scenescout/` (Markdown draws `https:`, `http:` and `file:` links), which opens it in the system viewer. A second link, **See it in the live view**, opens the local live view (the pane's `Link` takes `http://localhost`) on that finding, where the picture is shown full size. On the terminal surface, `Image` draws it inline. A spike in the panel PR tries an `Svg` wrapping a scaled PNG as a data URI; if the desktop draws it, small thumbnails are added, and if not, the links stay the only route.
- **Radio buttons:** a `Select`, or three `Button`s with the chosen one marked.
- **A press during a running turn:** `$.prompt.submit` starts a turn only when Claude is idle, so a button pressed mid-turn uses `$.session.append` instead, which the running turn reads (the human-in-the-loop mod's `send()`). **Stop** therefore reaches Claude at its next step; the engine's caps end the run in any case.
- **Where nothing draws.** Panes, the band above the prompt, the status line and toasts draw in the terminal and the desktop Code tab. In the VS Code chat panel, `claude -p` and cloud sessions the mod's hooks run but nothing is drawn (`$.session.surfaces()` returns none). There:
  - `/scenescout-guided` answers with the text form of the current state (the `CommandOutput` row), as `/scenescout-pane` does today, and the next steps as plain sentences the person can type ("say: re-check a1b2c3d4e5");
  - toasts that would have fired (a ticket closed, the cap near) are kept and printed at the top of the next `/scenescout-guided` answer;
  - nothing that needs the person's confirmation can be accepted: writing care levels and ticket filing are refused with a sentence saying to use the terminal or the desktop Code tab, or `scenescout export` ([6.3](#63-confirmations)). A `claude -p` run starts only in **Look only**;
  - the game layer, the end-of-check picture and the cost meter are skipped.

#### 4.1.1 Mod mechanics, from mods that already do this

These follow patterns read in the source of published mods; the build PRs cite them in comments where the pattern is used.

| Mechanic | Pattern and source | How the guided panel uses it |
|---|---|---|
| A button that sends something to Claude | Idle: `$.prompt.submit`; mid-turn: `$.session.append`; to let the person edit first: `$.prompt.fill`. Fired with `void`, never awaited inside a hook the turn waits on, which would hang it. A refused submit puts the item back with a toast (human-in-the-loop) | **Start**, **Run again** and **Check again** submit; **Stop** appends; **A journey** and **Explain more** fill the prompt so the person can read and change the words before sending. `asUser` is left off, so the transcript shows the panel sent it rather than reading as the person's own words |
| Context added to the next prompt without showing it | A press arms a size-capped block that `prompt.submit` adds as `context` (the official diff mod's ask button) | **Explain more** arms the card's evidence and steps. Because that text came from the app under test, it is fenced in a randomly named tag it cannot close (lazy-panda-panel's safety test) and introduced as data, not instructions |
| Confirm before something risky | `$.ui.ask`, the engine's own dialog: it draws on desktop and mobile with no pane, the answer is compared with the exact label, and a dismissed dialog or a `-p` run rejects, which counts as Cancel (launch-codes, with a one-time code); or a pane that waits for Proceed or Cancel with Cancel focused (blast-radius) | The panel's preview of a care level uses `$.ui.ask` where the pane is not placed (narrow windows, mobile). As a second guard in the Code tab, a `tool.call` hook on `scout_attach` above `observe` and on `scout_ticket_file` asks the person the same way and denies the call on Cancel, with a refusal written for the model ("do not retry; ask the person"). The server's form ([6.3](#63-confirmations)) stays the gate that counts |
| A band above the prompt | Keep other mods' rows by drawing `await next(e)` inside the band's `Box`; give the band back while a survey shows; row buttons appear on hover only and have no hotkeys; where the band never draws, fall back to `$.ui.status` and transcript lines (cc-pr-tracker) | The running check and watched tickets ([5, items 9 and 12](#5-more-ux-worth-having)) |
| Surfaces | Branch on `e.surface` and test `'Input' in elements` before drawing a field (lazy-panda-panel; swarm draws `Svg` off the terminal) | Mobile gets a buttons-only panel: saved checks, **Run again**, results and cards; a new check's address goes through `$.prompt.fill` |
| State | `$.state` atoms with a `types` contract in `plugin.json`, redrawn when read in a render hook and kept across a hot reload; `$.store` is shared by every session on the machine, so key it per project and prune (cc-pr-tracker) | The wizard's step and choices are `$.state`; the tour flag, the ticket target and the cost history are `$.store`, keyed by project folder |
| Older builds | Wrap each newer API call so an older build degrades instead of failing (cc-pr-tracker's `attempt()`); the Desktop app bundles its own Claude Code build, which can lag the CLI | The mod states a minimum Claude Code version in its guide page and README, and hides a feature (the band, `$.ui.ask`, the cost meter) whose API the running build lacks, rather than failing the panel |
| Tests | `claude plugin test` mounting every surface in one test (agent-narrator) and pressing buttons (blast-radius); rules kept pure and table-tested (launch-codes); CI runs `claude plugin validate` and `claude plugin test` on the oldest supported build and on the latest (cc-pr-tracker) | The rules stay table-tested in `live-test` as today; the mounted-surface test is added if CI can run Claude Code ([question 16](#8-open-questions)) |
| Packaging and trust | `displayName`, `icon`, `privacyPolicyUrl`, `supportUrl` and plain-language `userConfig` in `plugin.json`; a per-mod "What it reaches" table (network, processes, files, model calls, data sent anywhere) | The mod's guide section gains that table: it reaches the SceneScout server only, runs no process, writes only `$.store`, calls no model, and sends nothing anywhere. The name keeps clear of the reserved prefixes (`claude-`, `anthropic-`, `cc-plugin-`) |

The narrator's sentences come from a fixed table in the engine, not from a model as agent-narrator's do: it costs nothing, it is the same in both surfaces, and no text from the page under test is sent to a model to be summarised.

Sources (public repositories): the official mods in [anthropics/claude-code `mods/`](https://github.com/anthropics/claude-code/tree/main/mods) (diff); [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) (blast-radius); [OneWave-AI/claude-code-mods](https://github.com/OneWave-AI/claude-code-mods) (launch-codes, session-wrapped, agent-narrator, swarm); [sezaakgun/cc-pr-tracker](https://github.com/sezaakgun/cc-pr-tracker); [tzafrir/human-in-the-loop](https://github.com/tzafrir/human-in-the-loop); [paragpandyareal/lazy-panda-panel](https://github.com/paragpandyareal/lazy-panda-panel). The budget-guard, claude-queue and review-pane ideas in [section 5](#5-more-ux-worth-having) are named as patterns only; their source was not found or not read.

**Pictures, again.** No published mod embeds a raster picture in an `Svg` on desktop; the source limit allows roughly 95 KB of PNG and the desktop's sanitiser may strip a `data:` address. PR 4 carries a probe that draws one and reports whether it showed. The fallback is fixed either way: a `file:` link to the picture, and **Open the report**. Any picture the panel needs (thumbnails, the end-of-check card) is made by the engine through the MCP server with its existing PNG writer, never by a second encoder in the mod.

### 4.2 The chat (desktop extension)

| Capability | Status | Where |
|---|---|---|
| Prompts listed by the server | confirmed in the SDK; already used (`explore`, `live`, `login`) | `ListPromptsRequestSchema`, `GetPromptRequestSchema` |
| How Claude Desktop presents prompts (a menu entry the person picks) | assumed | to check on a current build |
| A form shown by the host (elicitation, form mode) | confirmed in the SDK and already used by `scout_intake` | `ElicitRequestFormParamsSchema`, `Server.elicitInput` |
| Claude Desktop chat showing elicitation forms | assumed; today's `scout_intake` falls back to chat questions when the client does not declare the capability | `formElicitationSupported()` |
| A multi-select field in a form | assumed (the 2025-11-25 elicitation schema adds titled multi-select enums; to confirm against what the SDK validates and what the host draws). Fallback: one yes/no field per area | — |
| Images in a tool result | confirmed in the SDK | `ImageContentSchema` |
| Structured results and output schemas | confirmed in the SDK | `outputSchema`; `structuredContent` already used |
| Tool annotations (`readOnlyHint`, `destructiveHint`) | confirmed in the SDK, not yet set by SceneScout | `ToolAnnotationsSchema` |
| Progress notifications | confirmed and already sent during long calls | `ProgressNotificationSchema` |
| **An HTML panel in the chat (MCP Apps)** | confirmed that SceneScout ships one (`ui://scenescout/status.html`) and the guide lists Claude Desktop chat among hosts that render it; the SDK has no types for it, SceneScout implements the convention itself. Whether the current Desktop build renders it is assumed | `src/tools/status.ts`, `src/engine/status-pane.ts` |
| Settings and secrets for the extension (`user_config`, with `sensitive` values kept by the host) | declared in PR 7 for the trackers' sign-ins (two of them `sensitive`), mapped to `GH_TOKEN`, `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` in `mcp_config.env`, as the manifest specification describes; that the current Desktop build passes them so is still assumed. A setting left empty, or passed as its unfilled placeholder, counts as unset | `desktop-extension/manifest.json` |

**What this means.** The issue assumed "no custom panels in the chat". Where the host renders MCP Apps, the existing status pane can carry the guided progress and the newest cards, with buttons, because an MCP App can call the server's tools. The design uses that for progress and results, and keeps the **start** in the elicitation form, so a host that renders neither still works through prompts and plain text. [Question 1](#8-open-questions) asks whether to go further.

**Fallbacks.** No form: Claude asks the questions in one chat message (as `scout_intake` does today). No MCP App: Claude posts a progress line every few steps and the cards as text with image blocks. No elicitation for a confirmation: writing modes and ticket filing are refused in chat with a sentence saying how to do it (the panel, or `scenescout export` in a terminal); see [6.3](#63-confirmations).

---

## 5. More UX worth having

Beyond the four in the issue, in priority order. Effort is scope, not time: S touches a few files in one PR, M is one PR across the engine and a surface, L needs several PRs. Where an idea comes from an existing Claude Code mod, the pattern is named; nothing is copied from those mods, only the interaction.

| # | Feature | Pattern it borrows | Why | Surfaces | Effort |
|---|---|---|---|---|---|
| 1 | **Narrated progress**: one plain sentence per step, the last five kept as a story ([2.3](#23-watching-progress)) | agent-narrator | The person can follow the run without the live view, and trusts it more when they see what it is doing | both (the chat through the status pane or progress lines) | S |
| 2 | **Preview and confirm a care level that writes**, with a typed code for *May create test data* ([2.12](#212-panel-wireframes-code-tab), [6.3](#63-confirmations)) | blast-radius, launch-codes | The one moment a guided run can do harm is the choice of care level; a preview of its effect and a deliberate pause make it a real choice | both (the chat through elicitation) | S |
| 3 | **"Is it safe to run on my live site?" explainer**, one screen, the same words in the panel and the `is-it-safe` prompt | — | Sam's first question; answers it before it stops them | both | S |
| 4 | **Plain error screens** for the failures that actually happen: server not found, address unreachable, browser download failed, sign-in expired, run stopped by a cap | — | Replaces a stack trace with one sentence and one button | both | S |
| 5 | **First-run tour**: three panels (what it does, how it keeps data safe, what you get), skippable, remembered in `$.store` | — | The first minute decides whether anyone comes back | Code tab | S |
| 6 | **Sign-in health**: before starting, say whether the saved sign-in will last the run (`expiry.ts` already knows), and offer **Sign in again** | — | A run that dies half-way at a sign-in page is the most common disappointment | both | S |
| 7 | **Card feedback**: *Not a bug*, *Explain more*, *Check again* on every card, kept as labels and exportable as answer-key and dedup candidates ([2.4](#24-reading-findings)) | review-pane | Lets a tester disagree without losing the record (ADR 4), and turns their judgement into data a maintainer can use | both | M |
| 8 | **Cost before and during a check**, with a cap the person sets and a warning before it runs out ([2.11](#211-cost-before-and-during-a-check)) | budget-guard, burn-meter, context-lens | A person on a subscription worries about using up their limit on a test | Code tab only (the chat has no usage figures) | M |
| 9 | **The run above the prompt**: the "now" sentence and problem count in the band above the prompt and the status line | the band and status-line mods generally | Keeps the run in view with the panel closed | Code tab, terminal | S |
| 10 | **Clicking saved**, with its basis shown ([2.3](#23-watching-progress)) | agent-narrator's "human time saved" | Makes the value visible to a manager; honest only if the basis is shown | both | S |
| 11 | **End-of-check card** to share with the team ([2.9](#29-the-end-of-check-card)) | session-wrapped | A recap people actually forward, which brings the next person in | both (a picture file) | M |
| 12 | **Watched tickets**: filed tickets above the prompt, a toast when one is closed or a re-check confirms a fix ([2.6](#26-tickets)) | cc-pr-tracker, inbox-alerts | Closes the loop from "found" to "fixed and confirmed" without anyone remembering to look | Code tab | M |
| 13 | **Queue checks** while one runs ([2.3](#23-watching-progress)) | claude-queue | A tester with three areas to check sets them all up once | Code tab | S |
| 14 | **Copy steps** and **Copy as a bug report** (title, steps, expected, happened, the picture's file) | — | For trackers SceneScout does not file into | both | S |
| 15 | **Compare with last time**: new, fixed and still there since the previous run of the same saved check | — | The question a manager asks after every release | both | M |
| 16 | **Phone and desktop side by side** for the phone area: the same page's two pictures in the report | — | Shows a layout problem without explanation | both | M |
| 17 | **A journey from a sentence, saved as a flow**: after a journey passes, offer **Keep this as a repeatable check**, writing `.scenescout/flows/<name>.json` for `scenescout check` | — | Turns one guided run into a check a developer can put in CI | both | M |
| 18 | **Two people at once** ("Check as a customer and as an admin"), with two sign-ins | — | Permission problems are the high findings; today it needs prompt writing | both | M |
| 19 | **Lanes side by side**: when a developer-started run is split into lanes, one column per lane with its own "now" sentence and problems | agent-race | Makes a parallel run readable; the guided start itself stays one session ([question 10](#8-open-questions)) | Code tab | M |
| 20 | **Optional game layer**: a bestiary of findings, defeated by a confirming re-check, off by default ([2.10](#210-an-optional-game-layer)) | boss-fight, code-pet | Makes fixing and re-checking satisfying for the people who like it; invisible to those who do not | Code tab | M |
| 21 | **Scheduled re-run** of a saved check (while Claude Code is open), with a toast on new problems | — | Regular health checks without remembering to run them | Code tab | L |
| 22 | **Share a read-only results page**: the team report published as a private artifact | — | For a client who cannot open a local file | both | L, and needs the owner's decision on publishing |

**What to ship first from the mod patterns:** 1 (narrated progress) and 2 (preview and confirm), in the first release, because they serve the two things a non-technical person needs before anything else: knowing what it is doing, and knowing it will not do harm. 7 (card feedback) and 9 (the band) follow in the second. 8 (cost) and 12 (watched tickets) come after, once tickets exist. 20 (the game layer) is last and stays opt-in.

---

## 6. Safety and privacy

### 6.1 What a non-technical person can and cannot trigger

| Can | Cannot |
|---|---|
| Start a check in `observe`, `read-only` (with a confirmation on a remote address) or `safe-write` (always with a confirmation) | Choose `destructive` from either guided surface. It needs a developer to ask for it by name, as today |
| Sign in through a real browser window | Type a password, code or token into the panel, a form or a prompt (no field asks for one; prompt and form arguments named like credentials are refused, as `src/prompts.ts` does today) |
| Make a report inside the project's `.scenescout/` folder | Write a report anywhere else, or upload it anywhere |
| Preview tickets, then file the previewed ones after a confirmation | File without a preview, file more than the cap (`--max-issues`'s default), or file a finding that was not in the preview |
| Mark a card "not a bug" | Delete a finding, or change the answer key or dedup |
| Save, run and delete saved checks | Save a credential in one (the saved-check schema has no field for one, and loading a file with an unknown field is refused) |
| Name trusted embeds or read-only POST endpoints | — these stay developer settings and are not in the guided surfaces |

### 6.2 Defaults

- Care level: **Look only**. A saved check keeps the level it was saved with and confirms it again on each run where it needs one.
- Thoroughness: **Normal**, at most 20 minutes and 60 pages, so a guided run cannot run unbounded. **Quick look** is at most 10 minutes and 20 pages, and **Thorough** at most 30 minutes and 120 pages (`THOROUGHNESS_BUDGET` in `src/engine/guided.ts`). The first look (`scenescout <url>`) keeps its own, smaller caps of 3 minutes and 20 pages.
- Pictures: on, kept inside `.scenescout/`. A picture is not redacted (the guide already says so); the panel says once, on the first report, that pictures show what was on screen.
- Recording a video: off, as today (ADR 8).
- The live view: local only, as today (ADR 7).
- Ticket target: none until the person picks one.

### 6.3 Confirmations

A confirmation counts only when **the person** gives it, never Claude. The engine enforces this, not the prompt:

| What | In the panel | In the chat |
|---|---|---|
| Starting in `safe-write` | The preview of what the care level may do, then **Continue**, which calls `scout_guided_confirm`; the host then shows the server's confirmation form, with the code to type | Claude calls `scout_guided_confirm`; the host shows the same form |
| Starting in `read-only` on a remote address | The same, with no code | The same, with no code |
| Filing tickets | The preview screen, then **File**, which calls `scout_ticket_file`; the host shows the server's confirmation form listing the tickets | Claude calls `scout_ticket_file`; the host shows the same form |
| Any of these where the host cannot show a form | Refused, with a sentence saying so | Refused; the run is offered in **Look only**, and filing gives the `scenescout export` command to run |

**One route counts: elicitation, from the server straight to the person.** Claude may make the call, but it cannot give the answer, because the host shows the form to the person and returns their choice to the server. The panel's own preview and code are a pause before that form, not a substitute for it. Two other routes were considered and rejected: an app-only "accept" tool (hosts differ on whether a mod's `$.mcp.call` reaches one, and on whether they keep it from the model), and a secret the server hands the mod (the mod and Claude share one client connection, so nothing guarantees the mod receives it first).

**What this does and does not guard.** It guarantees that the guided tools never start a writing care level or file a ticket on a model's call alone, including a model steered by text on the page under test. It does not sandbox a Claude Code session that has shell access: there, the same person's permission settings decide what Claude may run, as for any other command (a developer can still run `scenescout export --yes` themselves). The chat has no shell, so there the guarantee is the whole story.

In the Code tab the mod adds a second guard in front of the model's own calls ([4.1.1](#411-mod-mechanics-from-mods-that-already-do-this)): a `tool.call` hook that asks the person with `$.ui.ask` before a writing attach or a ticket filing, and denies on Cancel or dismissal. It is a reminder at the mod's level; the server's form remains the rule.

`destructive` has no confirmation in either guided surface because it is not offered at all. A future surface that offered it would need, at the least, the typed code above, the address typed back by the person, and an ADR.

### 6.4 Credentials for trackers

- **Code tab:** the server reads `GITHUB_TOKEN` or the Jira variables from its environment, exactly as `scenescout export` does. The panel names the source, never the value.
- **Chat:** the desktop extension declares `user_config` fields marked sensitive (assumed: the host stores them and passes them to the server as environment variables). The person pastes the token once in the extension's settings, not in the chat.
- The token never appears in a tool result, a prompt, the panel, the progress model or `$.store`. `export-test`'s existing check that the token is never printed extends to the new tools.

### 6.5 Privacy

- Nothing leaves the machine except the browser's requests to the app under test, and ticket creation when confirmed.
- Card text is the finding's text, which is already redacted when kept (emails, card numbers, credential shapes).
- `$.store` holds only: tour seen, last ticket target per project (owner/repo or project key, no token), and panel preferences.
- Saved checks hold the address and choices. An address with a username or password in it is refused when saved.
- The plan id and preview id are random (`crypto.randomBytes`), held in the server process only, and expire with it (a preview after 10 minutes).

---

## 7. Build plan

Each PR is mergeable on its own, updates the README and `docs/guide/` where a person can see the change (ADR 21), carries a changeset when user-visible, and puts each rule's test in the home AGENTS.md names. A new `guided-test` suite is added to the `test` chain and to AGENTS.md's list in PR 1.

| # | PR | Scope | Files | Tests |
|---|---|---|---|---|
| 1 | **The plan and the card** | `guided.ts` (choices, validation, plan, confirmation rule), `plainCard()` with `plainFinding()` rebuilt on it, `guided-words.ts`. ADR 24 for care levels and person-only confirmation. No tool yet | `src/engine/guided.ts`, `src/engine/guided-words.ts`, `src/engine/plain.ts`, `docs/adr/0024-…`, `AGENTS.md`, `package.json` | `guided-test` (new): every choice to its plan, contrastive pairs for each confirmation rule (localhost vs remote, look-only vs may-submit), refusal of credentials in choices; `contract-test`: the plain report is unchanged byte for byte |
| 2 | **Guided tools in the server** | `scout_guided_plan`, `scout_guided_confirm`, `scout_intake`'s extended form, `scout_attach {planId}` enforcement, `scout_session {area}`, annotations on the new tools | `src/tools/guide.ts`, `src/tools/sessions.ts`, `src/intake.ts`, guide pages | `guided-test` for the rules, including that a wrong or missing code never accepts a plan and that a declined or failed form leaves it unaccepted; `policy-test` that an unaccepted plan, or an attach without the open plan's id, cannot go above `observe`; `mcp-check` for schemas; `guide-test` for the guide's tables |
| 3 | **Progress and cards** | `progress.ts` (with the narrator's sentence table and the clicking-saved basis), `PaneData.guided`, `scout_cards` (with inline images), `scout_feedback`; the MCP App status pane draws progress and the newest cards | `src/engine/progress.ts`, `src/engine/status-pane.ts`, `src/engine/status-pane-page.ts`, `src/tools/status.ts`, `src/tools/results.ts` | `guided-test` for phase and area rules; `live-test` for the pane data; `memory-test` that a finding labelled not a bug is kept and still dedups; `mcp-check` |
| 4 | **The guided panel (mod)** | `/scenescout-guided` panel: welcome, configuring, confirmation (preview of the care level's effect, typed code for *May create test data*), running, results, card, error. Polls as now; wizard state in `$.state`; builds plans directly; starts Claude with `$.prompt.submit` or `$.session.append`; the `tool.call` guard with `$.ui.ask`; a buttons-only mobile panel; the `Svg` picture probe; `displayName`, `icon` and support links in `plugin.json`, and the "What it reaches" table in the guide | `mods/scenescout-mod/hooks/guided.js` (rules, no mods API), `mods/scenescout-mod/hooks/register.js`, `plugin.json` | `live-test`: every panel state rendered from fixtures, the actions each button produces, the text fallback where nothing draws; `install-test` for the manifest's settings |
| 5 | **Chat prompts and the extension** | `check-my-site`, `recheck`, `team-report`, `file-tickets`, `is-it-safe`; manifest `prompts` and (with PR 7) `user_config` | `src/prompts.ts`, `src/tools/guide.ts`, `desktop-extension/manifest.json` | `guided-test` for prompt text and argument refusals; `mcp-check` for the prompt list; `install-test` for the manifest |
| 6 | **Team report** | `scout_team_report`: the plain HTML report with cover, cards, not-checked list, blank sign-off lines, evidence folder and manifest; optional template | `src/engine/team-report.ts`, `src/tools/results.ts` | `report-test`: golden file in `scripts/golden/`, escaping, manifest hashes, template errors, and that nothing is written outside `.scenescout/` |
| 7 | **Tickets** | `scout_ticket_preview`, `scout_ticket_file` over `export.ts`, elicitation confirmation, preview expiry | `src/tools/results.ts` (or a new `src/tools/tickets.ts`), `src/engine/export.ts` (no rule changes) | `export-test`: preview then file against the stand-in GitHub and Jira APIs, an expired or altered preview refused, filing without confirmation refused, the token never printed |
| 8 | **Re-check and saved checks** | `scout_recheck_plan`, `scout_saved_checks`, the panel's saved list and **Run again** | `src/engine/guided.ts`, `src/tools/guide.ts`, the mod | `guided-test` (saved-check schema, unknown fields refused, no credential fields); `verify-test` that a re-check never attaches above the original mode |
| 9 | **Small extras** | Items 3–6 of [section 5](#5-more-ux-worth-having) (explainer, error screens, tour, sign-in health), each its own small PR | as each needs | as each needs |
| 10 | **The run around the panel** | The band above the prompt and the status line; card feedback buttons in the panel; queued checks | the mod's rules module and `register.js` | `live-test` for the band's text, the queue's order and that a queued check keeps its own care level and confirmation |
| 11 | **Cost and watched tickets** | The cost meter and cap from `$.session.usage()` and `session.measure`; `scout_ticket_status` and its toasts | the mod; `src/tools/results.ts` | `live-test` for the cap and warning thresholds from fixture usage figures, including a person with no subscription windows; `export-test` for the ticket-status read against the stand-in trackers and its rate limit |
| 12 | **End-of-check card and game layer** | The recap SVG from the engine; the opt-in bestiary in the mod | `src/engine/recap.ts`, the mod | `report-test` for the SVG (golden file, escaping of every figure and the address); `live-test` that the game layer is off by default and changes no card text |

**First release:** PRs 1–5 and 9. That is a person going from install to a guided check with a previewed and confirmed care level, watching a narrated run, and reading cards in plain words, on both surfaces, with the safety explainer and the plain error screens. **Second release:** PRs 6–8 and 10 (report, tickets, re-check, saved checks, card feedback, the band, queued checks). **Third:** PRs 11 and 12. Each release is measured once against the demo app with `npm run bench`, guided start versus the existing `explore` prompt on the same choices, so a guided run is shown to find no less ([docs/benchmark.md](../benchmark.md)).

---

## 8. Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | The chat can show an HTML panel where the host renders MCP Apps (the status pane already does). Build the whole guided start as an MCP App too, or keep the start in an elicitation form? | **Keep the start in the form for the first release**, and put progress and cards in the existing status pane. A form works in more hosts and is already tested; revisit a full App once usage shows the form is the obstacle |
| 2 | Allow a plain choice to reach `safe-write` ("May create test data")? Today plain answers never do | **Yes, with an always-on confirmation the person gives and an ADR.** Without it, a tester on a staging copy cannot check a sign-up or an order journey, which is most of what they are asked to check |
| 3 | How should the engine know a confirmation came from the person and not from Claude? | **Elicitation only, on both surfaces** ([6.3](#63-confirmations)). To verify before PR 2: that Claude Code shows a form the server sends during a call the mod made with `$.mcp.call`, as it does during Claude's own calls. If it does not, the panel's confirmations wait for a turn in which Claude calls `scout_guided_confirm`, and the form still decides |
| 4 | Should **May submit forms** need a confirmation on a remote address? | **Yes.** `read-only` lets a contact form or sign-up create a real record on a live site; one sentence before the run is cheap |
| 5 | One mod or two, and which command? `/scenescout` is already the plugin's skill | **One mod, a new command `/scenescout-guided`** that opens the guided panel, whose running state contains everything the run pane shows. `/scenescout-pane` opens the same panel from then on, so nobody's habit breaks |
| 6 | Team report: always the built-in layout, or also the ADR 22 template schema? | **Built-in first, template in the same PR only if the existing schema fits** an exploratory run without new fields; otherwise a follow-up. Do not fork the schema |
| 7 | Where do tracker tokens come from in the chat? | **The extension's sensitive settings**, never the chat. PR 7 declares them and reads them from the server's environment; it was built without a Desktop build to confirm on, so the check that `user_config` reaches the server as environment variables is still open. If it does not, the preview says the sign-in is missing and nothing else changes |
| 8 | Pictures in the desktop panel: accept links only, or invest in the `Svg` data-URI route? | **Links first; one small spike in PR 4.** If it draws, add thumbnails; do not build a second picture pipeline for it |
| 9 | Should "Not a bug" and the other card feedback feed the benchmark answer key and the dedup labels? | **As candidates only.** The labels are kept on the finding and exportable for a maintainer to review and add to the key (with an example and a counter-example, as AGENTS.md asks). Written straight into the key, one person's click would move every benchmark row, and a label from a run of the held-out app would leak its key |
| 10 | Should the guided surfaces offer parallel lanes ("faster, uses more of your computer")? | **Not in the first release.** Lanes need subagents and more memory; a guided run stays one session until a measured run shows lanes help a guided check |
| 11 | Publishing a shareable results page (extra 22)? | **Not without a separate decision.** Everything today stays on the machine; publishing changes that and needs its own ADR |
| 12 | The "clicking saved" figure: show it, and on what basis? | **Show it, always with its basis and the rates in settings**, and never in the team report or tickets. No measurement backs a per-page rate yet; an unexplained number would be the one claim in the panel nobody can check. Measuring a tester doing the demo app by hand would give a defensible default |
| 13 | The end-of-check picture: SVG only, or PNG too? | **SVG first, made by the engine.** A PNG, when asked for, also comes from the engine's PNG writer (`png.ts`) through the server, which would need a small bitmap font for the text; the mod never carries its own encoder, as session-wrapped does |
| 14 | The game layer: build it at all, and in which style? | **Build it last and opt-in**, in the project website's look, drawn only by the mod and never in anything shared. If the owner prefers the product to stay plain, drop item 20 with no effect on the rest |
| 15 | The cost estimate before a check: from what? | **From the person's own earlier checks, kept in `$.store`**, with a stated default until there are three. A default taken from the maintainer's runs would be wrong for every other plan and app |
| 16 | Add `claude plugin test` and `claude plugin validate` to CI, on the oldest supported Claude Code build and the latest? | **Yes, as a job of its own that is not a required check at first.** The mod's rules stay table-tested in `live-test`, which needs no Claude Code; the mounted-surface test catches what a table cannot (an element missing on a surface fails the whole drawing) |
| 17 | Which Claude Code version is the minimum for the guided panel? | **The version that has `$.ui.ask`, the band and `$.session.append`**, stated in the README and the guide, with older builds getting the panel without those features rather than no panel |
