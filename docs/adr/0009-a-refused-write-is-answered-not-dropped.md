# 9. A refused write is answered, not dropped

Status: accepted

Amends [ADR 2](0002-enforce-the-write-policy-at-the-network-layer.md), which
decides *what* the write policy blocks. This record decides what the page is
told when it does.

## Context

The policy used to abort a blocked request. To the page, an abort is a network
failure: `fetch` rejects, and an XHR fires `error`. No real server ever answers
that way, so the page's own handling of a refusal — the branch that should say
"couldn't delete" — never ran under test.

That hid a whole class of defect. A delete handler that ignores the response
and reports success anyway never reached its success line: the aborted `fetch`
threw first, and the page looked broken in the tester's favour. On a benchmark
app with that defect planted, the safety net hid the very bug it should have
exposed, and the contradiction oracle that exists to catch it was switched off
for policy blocks, because an abort says nothing about the app.

## Decision

A blocked request made by the page's script (`fetch` or XHR) is **answered**
with a refusal in the server's place: `403`, a JSON body saying the tester's
policy refused it, and an `x-scenescout-policy` header. The server is not
contacted either way. A blocked navigation (a native form post) is still
dropped, because answering it would replace the page with the stand-in body.

The rest follows from treating the stand-in as the answer the page received:

- The HTTP oracle does not report it — matched by request identity, as aborts
  are — and the browser's "status of 403" console line is attributed to the
  policy the same way the abort's console line was.
- The contradiction rules judge it like any other refusal. A page that claims
  success after one is a `false_success`, and the violation says the refusal
  was the policy's stand-in, so nobody looks for it in the server's logs.
- The tool result still carries the `🛡 WRITE-POLICY blocked` notice, and says
  the page was answered: an error message afterwards is correct behaviour.

## Consequences

Every read-only and observe run now exercises refusal handling on every write
it attempts, at no extra cost and with no request reaching the server.

What we accept: a page now sees a 403 where it used to see a network error. An
app that treats any 403 as "signed out" may log itself out; the auth-loss
tracker reports that as it would any other lost session, and the notice on the
blocked action says what caused it. A cross-origin API call gets CORS headers
echoing its own origin, or the refusal would fail as a network error and be
dropped all over again.

## Failure direction

403 rather than 5xx or 401. A 5xx invites retries and reads as "the server is
broken", which is not what happened. A 401 is the status apps most often wire
to a sign-out. 403 says "not allowed", which is exactly what the policy decided.
