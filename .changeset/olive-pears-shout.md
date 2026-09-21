---
"scenescout": minor
---

`scout_request` — call the app's own API as the session, with the UI bypassed.

A refusal shown by hiding or disabling a button is not a refusal. Confirming that the server refuses the same action is the most valuable check a permission pass makes, and until now it could only be done outside the tool, in a shell with curl and a hand-extracted token. None of that evidence reached the report: a whole validation run's permission matrices lived in shell history and went with it.

The request is made by the page, not beside it, which matters twice. It goes through the same interception the write policy is enforced on, so a safe-write session cannot reach past the policy by calling an endpoint instead of clicking it — the browser suite proves a replayed `DELETE` on a record the session did not create is refused exactly as a click would be. And it carries the session's own credentials, because it is the same origin with the same cookies. Bearer schemes work by replaying whatever `Authorization` header the app itself last sent, so nothing in the engine knows what a token looks like or where an app keeps one.

The result leads with the signature a finding should quote (`GET /api/admin/users 403`), then the timing, then the headers that decide whether two responses are genuinely identical — content-type, location, www-authenticate, retry-after, cache-control — then the body. Every call is recorded in the run's trail.

Paths are fenced to the attached origin, as navigation is: a session talks to its own app, and another host needs another session.
