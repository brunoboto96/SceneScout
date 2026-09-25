# 2. The write policy is enforced on the wire, not in the prompt

Status: accepted

## Context

The tool drives a real browser against a real app, and the database behind it
may hold real data. The tester is a language model, so "please don't delete
anything" is a request, not a control: one confident model, one ambiguous
button label, and a record is gone. Safety that lives in a prompt is not safety.

Label-based blocking alone is also insufficient in the other direction — the
button that deletes may be an icon, or say "Archive", or say nothing.

## Decision

Three modes, enforced by intercepting requests in the browser context:

- **read-only** (default) — destructive-labeled elements are refused in the UI,
  *and* every PUT/PATCH/DELETE plus destructive-looking POST is blocked on the
  wire. Plain POSTs pass (search and login are POSTs) but are reported.
- **safe-write** — creation is allowed; the engine tracks the ids this session
  created and permits mutations only on those. Label blocking is off, because
  deleting your own test record is the point.
- **destructive** — everything, only on an environment the human has explicitly
  confirmed is disposable. The skill instructs the agent never to choose this.

URL and body are judged by different rules: a destructive verb in a URL path is
structure and blocks; in a body it must be *structured* intent (a GraphQL
destructive mutation, or a command key like `"action":"delete"`). Bare keyword
matching on bodies blocked ordinary create/analyse POSTs whose payload merely
mentioned a destructive word — a document under analysis, a record description —
which is lost coverage for no safety gain.

A write started by a frame of another origin than the app's — an embedded form,
chat or payment box — and headed outside the app is refused in every mode
except destructive, before any other rule. It goes to the third party that
serves the frame, not to the app under test, and no mode was agreed with that
third party. Such a write is recognised by the frame the browser reports; for a
form the frame aims at the top window or a new tab, by the request's Origin
header; for a popup the frame opens on its own site, by the popup being a page
the session never adopted; and for a frame that hides its origin
(`Origin: null`), by the page embedding another site at the time.

A foreign frame's write that lands in the app itself, such as a sign-in
provider posting its reply to the app's callback, is judged by the ordinary
rules, and so are requests the app's own pages send to other origins. On the
app's own sign-in pages the rule is lifted outside observe, because a captcha
is a cross-origin frame that posts to its own site and every login would
otherwise fail. A payment frame and a frame from one of the app's own
sub-domains count as foreign: refusing a harmless write costs a gap in the
report, and sending test traffic to a third party nobody asked cannot be
undone. A known limit: a frame that first navigates the whole window to its
own site with a GET is, from then on, indistinguishable from a sign-in page
loaded as the whole page.

## Consequences

A refusal is a tool result the agent must respect and cannot route around, and
the guarantee holds regardless of what the model believes it is doing. In
exchange the policy occasionally refuses something harmless, so refusals say why
and name the mode that would allow it.

## Failure direction

Chosen deliberately: **refuse a safe action over permitting a destructive one**
at the URL layer, and the reverse in bodies, where the false-positive rate was
high and the added safety near zero.
