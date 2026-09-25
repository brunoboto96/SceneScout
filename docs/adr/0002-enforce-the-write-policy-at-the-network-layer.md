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
header; and for a frame that hides its origin (`Origin: null`), by the page
embedding another site at the time — which also refuses the app's own page
posting out with `Origin: null` while it embeds one, the cautious direction. A
write out from any page other than the session's current one is refused too.

Every document loading into a frame of another origin is served with the
sandbox `Content-Security-Policy: sandbox allow-scripts allow-forms
allow-same-origin`, which leaves out popups and top-window navigation. A popup
opened on the frame's own site could post before it was closed, and in Firefox
its first requests never reach the policy; a detached link's click, a
`<base target>` or a `window.open` borrowed from a blank child frame each opened
one past a script patch. The browser applies the sandbox to every realm the
document makes, nested and blank frames included. A redirect is answered with a
sandboxed page that navigates to its target, because a redirect answered as one
is followed by the browser without asking and its target loads unsandboxed. A
frame document that cannot be fetched to add the sandbox is not loaded, and a
document is held until it has fully arrived, so a frame that streams shows
nothing until it ends.

Limits of the sandbox, and what covers them. WebKit drops it when a frame loads
a `data:` URL in its own place, and in Chromium a frame can register a service
worker that later serves its document unseen. Both can end in a popup or in the
whole page moving to the third party's site, and the write rules still apply:
a write from a page the session did not open is refused, and so is a write to
another site from the session's own page once an embed has moved it off the
app, unless it is a sign-in request. Who moved the page is decided on the
navigation's first request: one that leaves the app from a page that embeds
another site, without the app as its Referer, was not the tester's. A page the
tester moved to another site — a hosted sign-in page, even one the app also
embeds for silent sign-in, or a second app — keeps the ordinary rules; on an
app page that sends no Referer and embeds another site, the tester's own move
counts as an embed's, and its writes out are refused. A frame that has moved
itself to a `data:` URL posts with `Origin: null`, and on a page that embedded
another site such a write out is refused. A redirect's stand-in page is built
with no headers of the redirect's but its cookies, and sends no referrer, so
an embed that checks which site embeds it by the Referer may refuse to load. In Chromium, a document re-served with the
sandbox counts as public, so its requests to a loopback address are refused by
the browser's own local-network rule: an app under test on localhost does not
receive a foreign frame's writes at all.

A foreign frame's write that lands in the app itself, such as a sign-in
provider posting its reply to the app's callback, is judged by the ordinary
rules, and so are requests the app's own pages send to other origins. On the
app's own sign-in pages — whose last path segment is a sign-in word such as
`login` or `sign-in`, not a verification step like `verify` or `auth` — the
rule and the sandbox are lifted outside observe: a captcha is a cross-origin
frame that posts to its own site, and a "sign in with" button is one that opens
a popup, and every login would otherwise fail. A payment frame and a frame from one of
the app's own sub-domains count as foreign: refusing a harmless write costs a
gap in the report, and sending test traffic to a third party nobody asked
cannot be undone.

## Consequences

A refusal is a tool result the agent must respect and cannot route around, and
the guarantee holds regardless of what the model believes it is doing. In
exchange the policy occasionally refuses something harmless, so refusals say why
and name the mode that would allow it.

## Failure direction

Chosen deliberately: **refuse a safe action over permitting a destructive one**
at the URL layer, and the reverse in bodies, where the false-positive rate was
high and the added safety near zero.
