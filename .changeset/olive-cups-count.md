---
"scenescout": minor
---

What a run shows about itself.

A four-session validation pass exposed several things the engine knew but never said. All of them are fixed here.

**Recording covers the breadth pass.** A crawl now keeps a frame per route it visits, and a snapshot keeps one too. The run that prompted this kept 9 frames out of 67 actions, none of them from the 30 routes a crawl had just swept — the evidence artifact was missing exactly where the coverage happened.

**A session says what it is doing from the moment it appears.** `scout_attach` takes a `task`, and puts up a placeholder when none is given, so a fresh card no longer reads "Nothing stated yet" while the session works. The placeholder is display only: it does not satisfy the requirement that an agent state its task before a tool acts.

**Several engines on one project no longer erase each other.** Each writes `status.<pid>.json` and its own token file, and `scenescout watch` lists every live engine with its address instead of finding only whichever attached last. The shared `status.json` is still written for older readers.

**The report says how the run was paced** — actions, span, median gap, longest gap, idle share and frames per session — and warns about a session that has held a browser with nothing to do for over five minutes. Idle share is labelled as time the browser waited for the agent, because it is not a measure of the engine.

**Memory stops growing without limit.** A route keeps its most recent states, capped, so a history that had reached 6,075 states and 36 MB — parsed and re-serialised on every save — is trimmed on open. States a finding points at are never dropped, and coverage is unchanged because it is asked per route.

**`scout_scan` says which saved logins have expired**, rather than leaving it to be discovered by attaching and landing on a login page.
