# 35. An operator list names the hosts the browser may reach

Status: accepted

## Context

The `hosts` key caps only the address a browser starts on. A listed start
address that redirects to another host still got there, and a page's own
requests to third parties (a CDN, an analytics script, a sign-in provider)
went out as they would from any browser. The owner's decision for issue #546
was that the `strict` preset limits the browser to the app plus a named list.

## Decision

- **A separate key, `browserHosts`, rather than a mode of `hosts`.** `hosts`
  answers "where may a run start"; `browserHosts` answers "what else may the
  page reach". They are often different (a CDN is reached but never attached
  to), and folding them into one list would make a host attachable because a
  page loads a script from it.
- **The list names hosts besides the app's own.** The app's host is the attach
  address's host on its port, and the same name on https's port when the app is
  on plain http's (a common move). `[]` is the app alone; unset is any host, as
  before. Entries are written as `hosts` entries are (`hosts.ts`).
- **It holds in every write mode, `destructive` included.** It is about what
  leaves the machine, not about writes, so its route handler is installed
  whenever a list is set, runs before the write policy's, and its refusals are
  reported in their own notice rather than as write-policy blocks.
- **Precedence as the other operator keys:** file over environment
  (`SCENESCOUT_BROWSER_HOSTS` may narrow the file's list or set one with no
  file), and a project's own file may only narrow it. There is no attach
  argument or command flag. The `strict` preset sets `[]`.
- **Redirect hops are judged where the engine can see them.** No engine routes
  a redirect's later hop. Chromium's browser-level interception sees every hop
  and refuses one off the list. In Firefox and WebKit, a top-level page load is
  sent by SceneScout itself with no redirect followed (one send, as the
  browser's would be); a redirect off the list is refused, and one on it is
  answered with a page that loads the next address as a new, routed page load.
- **A refused page load leaves the page where it was** and says so:
  `scout_navigate` answers `NOT NAVIGATED`, and an attach whose start address
  leads off the list is not attached and names the host.
- **What no route handler sees is taken from the page while a list is set**,
  in every mode: shared workers (their requests cannot be intercepted), WebRTC
  peer connections (UDP to STUN and TURN servers and peers) and WebTransport
  (HTTP/3). A page that needs one sees the feature as missing.

## Consequences

- Turning on `strict` refuses a page's third-party requests until the operator
  lists the hosts it needs; a page may look broken where a script did not load,
  and the notice tells the tester that is the setting, not the app.
- Firefox and WebKit route no redirect's later hop, so there SceneScout sends
  page and frame loads and a dedicated worker's script itself to judge their
  redirects, and gives each document and worker a Content-Security-Policy
  naming the list (joined to the app's own, so it only narrows). The browser
  then refuses any other request's redirect off the list, and Firefox's
  `<object>` load, which is not routed at all. A page sees those refusals as
  CSP violations, and an IPv6 host on the list, which CSP cannot name, is
  refused there. Those refusals reach the notice through the page, which could
  therefore add made-up entries; one inside a worker is refused unreported.
- A sign-in window (`scout_login`, `scenescout login`) is not held by the list,
  since signing in often passes through another host.
- `scenescout policy explain` and `scenescout config explain` show the list,
  and the route handler and the explanation are held equal by test.

## Failure direction

An entry that cannot be read refuses the file or the environment value, so a
misspelt entry never widens the list. An address that does not parse, and any
scheme but http, https, ws and wss (other than data:, blob: and about:, which
load nothing), is refused. A page load SceneScout could not send itself is
aborted with the network's error rather than handed to the browser, which would
follow a redirect unjudged.
