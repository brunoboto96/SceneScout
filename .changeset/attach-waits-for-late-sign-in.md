---
"scenescout": patch
---

`scout_attach` with a saved sign-in now waits longer before judging whether it landed on a sign-in page: the address must hold still for a second rather than 400 ms, and a navigation the page has started is waited for until it answers, for at most 3 seconds. An app that sends a signed-out visitor to sign-in from its scripts some time after load, or whose sign-in page answers slowly, could pass a stale profile as signed in; it is now reported as `⚠ AUTH FAILED`. An attach with a saved sign-in takes about half a second longer; one without is unchanged. A bounce verdict mid-run, and the check after a submit-style click that sent no request, also wait for a navigation on its way.
