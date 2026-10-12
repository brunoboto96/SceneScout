# 24. Care levels in plain words, and confirmations only the person gives

Status: accepted

## Context

The guided assistant ([design](../design/non-technical-assistant.md), issue
#511) is for people who never see a tool name: a QA tester, a product manager,
a founder checking their own site. They cannot be asked to choose between
`observe`, `read-only` and `safe-write`, and they are the people most likely
to point a check at a live site.

The plain questions that start a run today (`src/intake.ts`, `scout_intake`)
choose the write mode from "Does the site hold real data?". A plain no allows
`read-only`, and every other answer is `observe`. That module states the rule
this record changes: **plain answers never reach `safe-write` or
`destructive`**, which need the person to ask for them by name. The rule kept
anyone from reaching a mode that writes by answering a question that was not
about writing.

The cost is that a tester on a staging copy cannot check a sign-up or an order
journey from the guided start, and that is most of what they are asked to
check. The design's open question 2 asked whether a plain choice may reach
`safe-write`; the owner accepted the recommendation that it may, with an
always-on confirmation the person gives.

A confirmation is only worth something if the model running the check cannot
give it. Text on the page under test can steer a model, so a confirmation that
Claude could answer on the person's behalf would let a page talk a check into
a writing mode.

## Decision

- **Care levels are named choices in plain words**, each exactly one write
  mode (`CARE_MODE` in `src/engine/guided.ts`; the words in
  `src/engine/guided-words.ts`):

  | The person chooses | Mode | Confirmation |
  |---|---|---|
  | Look only (the default) | `observe` | None |
  | May submit forms | `read-only` | When the address is not on this computer |
  | May create test data | `safe-write` | Always, with a code the person types |
  | *(not offered)* | `destructive` | Not reachable from a guided surface |

- **The words say what a sent form or button can do.** `read-only` lets an
  ordinary `POST` through, and many apps save an edit to an existing record
  (a profile, a setting) with one. The policy judges the request, not what
  sent it, so a button's script is let through exactly as a form is. So "May
  submit forms" says that what it sends can create a record or change one
  that was there, and that deletes are blocked; "May create test data" says
  the same and that it deletes only what it created. No care level's words
  promise that what was there is untouched, or that only a form can change
  it. "Look only" says what `observe` lets out and no more: page loads, so a
  search form that only opens a page of results is sent, and a link that
  changes something just by being opened is followed like any other; anything
  that would save something is held back. The write policy itself is
  unchanged (ADR 2).
- **This is a rule change.** A plain choice may now reach `safe-write`. The
  old rule's intent is kept: `safe-write` is reached only by choosing it under
  its own name, whose description says it creates records and is for a test
  copy, and never as a side effect of answering another question.
  `scout_intake`'s form asks the guided choices. The four plain questions it
  hands to the chat where no form can be shown keep their own rule: a plain
  no to "real data" is `read-only`, and nothing higher.
- **"On this computer" means `localhost`, `127.0.0.1` or `::1`, and nothing
  else.** Any other address, including other loopback addresses, `0.0.0.0`,
  a private network address and a `*.localhost` name, is treated as a site
  that may be live and asks first. The address is read as the browser reads
  it, so the other ways of writing those two numbers that a browser turns
  into them (`127.1`, `2130706433`, `0x7f.0.0.1`, `[0:0:0:0:0:0:0:1]`) are the
  same address and count as local.
- **A confirmation counts only when the person gives it through the server's
  own form** (MCP elicitation, from the server straight to the person; design
  section 6.3). Claude, the panel or a mod may start the request; none of them
  can supply the answer. A plan is always built unaccepted, and only that form
  marks it accepted. Where the host cannot show the form, the writing care
  levels are refused and the check is offered in Look only.
- **The typed code is a pause, not a secret.** For May create test data the
  form shows a short code and asks for it back, so a stray click or a held key
  cannot accept it. The server checks it.
- **`destructive` is not offered** by any guided surface. A surface that
  offered it would need, at the least, the typed code, the address typed back
  by the person, and a record of its own.
- **The choices never hold a credential.** No field asks for one; a field
  named for one is refused by its name, and a password, code or token written
  into the address, the journey or a ticket is refused without being repeated.
  Signing in happens in a browser window, as with `scout_login`.

## Consequences

- A person can check create flows on a test copy without writing a prompt, and
  is asked every time, including on a re-run of a saved check.
- May submit forms on `http://localhost` starts without a question; the same
  choice on any other address asks once. A developer running a local server
  under another name is asked when they need not be. That is the cheaper
  mistake.
- The guarantee covers the guided tools only. A Claude Code session with shell
  access is still governed by the person's own permission settings, as for any
  other command; the chat has no shell, so there the guarantee is the whole
  story.
- The server holds the rule, not the prompt. `scout_guided_confirm` shows the
  form and marks a plan accepted only on the person's yes. Plans live in the
  server process only. Once any plan has been built there, `scout_attach`
  above `observe` is refused without an accepted plan's `planId`, above the
  plan's mode, or on another site than the plan's, so leaving the id out is
  not a way round the confirmation. `policy-test` holds that gate, and
  `guided-test` holds that a wrong or missing code, or a declined, closed or
  failed form, accepts nothing.
- A developer who builds a guided plan in a server and then wants a writing
  mode outside it must name a plan or start a new server. That is deliberate:
  the server cannot tell the developer's call from a model's.
- The plan states its time and page limits (`THOROUGHNESS_BUDGET`) so a guided
  run is never unbounded.

## Failure direction

When it is unclear whether an address is on this computer, it is treated as a
live site and the person is asked. When text in the choices could be a
credential, it is refused and the person rewrites it. When the host cannot
show the server's form, the check runs in Look only rather than trusting any
other answer.
