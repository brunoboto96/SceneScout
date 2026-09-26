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
nothing until it ends. A document of the app's own loading into a frame is
asked first, one hop at a time: a redirect, to anywhere, gets the same
stand-in, because the later hops of a redirect are never routed and a chain
through the app and then out would go unseen; a document that does not redirect
loads as it would have, at the price of a second GET.

Limits of the sandbox, and what covers them. WebKit drops it when a frame loads
a `data:` URL in its own place, and in Chromium a frame can register a service
worker that later serves its document unseen. Both can end in a popup or in the
whole page moving to the third party's site, and the write rules still apply:
a write from a page the session did not open is refused, and so is a write to
another site from the session's own page once an embed has moved it off the
app, unless it is a sign-in request. Who moved the page is decided on the
navigation's first request, from the other sites the page embeds at that
moment — the frames still attached that hold, or once held, another site's
document, so a frame that has moved itself to a `data:` URL still counts and a
route change, a 204 or a download changes nothing. A move carrying the app as
its Referer, or from a page with no embeds, is the tester's: a hosted sign-in
page, even one the app also embeds for silent sign-in, keeps the ordinary
rules. With another site's Referer it is an embed's; with none at all it is an
embed's only when it goes to one of the embedded sites, so on an app that sends
no Referer the tester's own move to a site the page embeds is refused. A write
out with `Origin: null` from a page that embeds another site is refused.

WebKit drops the sandbox for a frame that loads a `data:` URL in its own place,
and such a frame could move the whole page to a site the page does not embed,
with no Referer to say where the move came from. A top-window navigation out of
the app with no Referer, while a frame that held another site sits on a
`data:` or `blob:` URL, is therefore refused outright, and reported like any
refusal. A frame the app set back to `about:blank` does not count. It is judged on the page as it is
when the request arrives, so it does not depend on knowing what the tester is
doing; an app rarely has such a frame, so it seldom refuses a move of the
tester's. A redirect's stand-in page is built
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

The engine lists and acts on the controls inside frames as it does on the
page's. In a frame of another site it acts as a user would and no further:
typed markup, fuzzing lengths and control characters, repeated-click probes
and file uploads are refused there in every mode, destructive included,
because the tester is authorised to test the app and not the embeds of
others. The engine enforces this for markup, values over 200 characters and
control characters; other injection shapes are left to the agent's
instructions. A frame with no address of its own (`srcdoc`, `about:blank`)
inside another site's frame counts as that site's, and a ref into a frame
that has since navigated is stale. The text a container shows in such a frame
(a select's options, a tagged block) is masked in the snapshot, since it can
hold other people's data; the labels of links, buttons and fields are kept,
cut to 40 characters, and a link's query and fragment are dropped.

A user can name embeds they trust — plain http(s) origins, at most ten, given
at attach — such as a payment provider in test mode. In safe-write, and only
there, writes those frames send outside the app go to the ordinary rules
instead of being refused — provided every other site involved is trusted: each
frame from the sender up to the page, and the Origin header, so an untrusted
embed cannot borrow a trusted one it wraps; a frame in that chain with no web
address of its own (`blob:`, `data:`, as opposed to a blank or srcdoc frame,
which is its parent's) withholds trust. A popup is not a frame, and trust does
not reach it. A request that names no frame but carries a trusted site's
Origin header (a trusted embed's form aimed at the top window) is trusted. Read-only and observe keep their promise, and destructive
allows everything already. Hostile input, repeated-click probes,
uploads, masking and the sandbox apply to a trusted embed as to any other. The
report names the list and whether it counted.

What happens inside another site's frame is that site's behaviour. A failing
request or error response that such a frame sent outside the app is labelled
with the embed's origin, kept at medium severity at most, and grouped apart in
the report; one it sent to the app is the app's to answer, and keeps its
severity. Attribution is by origin, so an app that embeds its own service on
another subdomain sees that service's failures capped too. Console and page
errors stay the app's: a console message says where its script was served
from, not which frame ran it, and a page error names no frame. The one
exception is the "Failed to load resource" line Chromium and WebKit print for
a failed request (Firefox prints none): its location is the request's own URL,
so it follows that request's attribution, and an embed's failure no longer
reaches the app a second time through its console echo. The controls of
another site's frame are counted apart and never enter the app's coverage or
its unexplored-surface and unsubmitted-form lists; a trusted embed's write that
went out in safe-write still counts as the route's submission.

### Writes sent as a page is left

A page can send a write as it is being left: a `navigator.sendBeacon` or a
`fetch(..., { keepalive: true })` on `pagehide`, `visibilitychange` or
`unload`, which the browser keeps sending after the page has gone. Firefox and
WebKit hand it to the context's route handler like any other request. Chromium
never does: the request arrives with no network id, or after the page's own
DevTools session has gone, and the driver sends it on unseen. So in Chromium it
reached the server in every mode, observe included, on every navigation the
engine made.

Three ways to close it were weighed:

- **A script in every page** that, in the modes that refuse writes, wraps
  `sendBeacon` and keepalive `fetch`. The page's own code cannot know the
  policy's verdict (read-only lets a plain POST through and refuses a
  destructive one), so it would either refuse every such write, changing what
  a page does in a mode that allows it, or reroute it through a request the
  page no longer lives to send. And a script can be got around: a page can
  take the original functions from a fresh frame before the wrapper lands.
- **Leaving each page for `about:blank` while watching the page's own
  DevTools session.** The page session sees the request, but it is the same
  session the route handler already uses, and it covers only the navigations
  the engine starts, not a page that moves itself or a frame of another site.
- **Intercepting at the browser level (chosen).** A DevTools session on the
  browser target, with the Fetch domain enabled, pauses every request that
  reaches the network after the route handler, these included, for every page
  and frame of the browser. It adds no script to the page and changes nothing a
  page does when the policy allows the write.

So in Chromium, in every mode but destructive, the engine pauses requests at
the browser level too. A read (GET, HEAD, OPTIONS) goes on at once, and so
does a write the route handler already let through. That is recognised by a
short ledger keyed by the mode, the method, the URL and a SHA-256 digest of
the body, claimed once: a harmless save let through never excuses a different
body sent to the same URL, such as a delete command beaconed as the page is
left. Any other write is one the route handler never saw, and is judged by the
route handler's rules in the same order (`judgeUnseenWrite` in `unload.ts`).

What is known of its sender comes from its headers (`unseenWriteSource`),
since the frame that sent it may be gone:

- A write out of the app whose Origin header names another site is treated as
  that site's embed's and refused outside destructive. That includes a
  sign-in provider's page, reached as the whole page, sending a beacon to
  itself as it is left, which the route handler would let through while the
  page lived: the cautious direction.
- A write out of the app with `Origin: null` is treated as an embed's too, and
  refused, whether or not the page embeds another site; the page can no
  longer be asked.
- The sign-in exception (a captcha on the app's own sign-in page) is decided
  on the Referer, the page the request was sent from, never on the page the
  session has moved to by the time the request is seen. With no Referer the
  exception does not apply. Under the browsers' default referrer policy a
  request to another site carries only the app's origin as its Referer, with
  no path, so in practice the exception seldom applies: a captcha's write sent
  as the sign-in page is left is refused, unless the page sends full
  referrers. The direction is refusal; a sign-in the tester completes is not
  affected, since its requests are sent while the page lives and go through
  the route handler.
- Trusted embeds, in safe-write, are recognised by the Origin header alone.
- A page an embed moved off the app is named by the Referer, or, with none,
  by the page the session drives.

A refused write is dropped rather than answered, since the page that would
read the answer is gone, and is reported with the other refused writes in the
result of the action that left the page. One that goes out is reported as a
possible mutation, as a routed one is. Every paused request is answered
exactly once: an error while judging or reporting it is logged, the request is
refused, and the refusal is still reported.

The same layer sees each later hop of a redirect, which the route handler
never does. In Chromium a 307 or 308 that carries a write on to a new address
is judged there like any write (`writeRedirectHopsJudged` in `browsers.ts`), so
a harmless POST redirected to a destructive address is refused. Firefox and
WebKit still send such a hop on unjudged, a known limit.

A write's body crosses the DevTools connection twice, once to the route
handler and once to the browser-level interception, and both sides hash it
for the ledger, so a page that posts large bodies pays for them twice in
transfer and hashing. Pausing every request adds a round trip to each. Measured on the demo app, an
eight-page crawl in read-only, five runs each, medians: 1250 ms and 1256 ms
with the interception, 1284 ms without it (runs 1180 to 1314 ms). The
difference is inside the noise, so the pattern stays `*` rather than a list of
resource types.

A page the engine closes (at the end of a session, on a re-attach, a popup of
another site) is left for `about:blank` first, in every browser: a write sent
as a page is closed, rather than navigated, is not routed in Firefox or WebKit
either. What a page sends on its way out then meets the policy on every
engine; `unloadWriteInterception` in `browsers.ts` records where, and the
unload smoke suite asserts both directions on each. WebKit may cancel an
unload write the route handler lets through once the page has gone, so there a
mode that allows the write does not promise it arrives
(`allowedUnloadWritesMayBeLost`); nothing it refused is sent.

## Consequences

A refusal is a tool result the agent must respect and cannot route around, and
the guarantee holds regardless of what the model believes it is doing. In
exchange the policy occasionally refuses something harmless, so refusals say why
and name the mode that would allow it.

## Failure direction

Chosen deliberately: **refuse a safe action over permitting a destructive one**
at the URL layer, and the reverse in bodies, where the false-positive rate was
high and the added safety near zero.
