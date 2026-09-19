---
"scenescout": minor
---

Watch a run live. `scout_attach` now returns a `Live view:` address, which the agent passes on to you, and `scenescout watch <project>` opens the same page from a terminal. It shows one card per session: the tool it is running, how long it has been there, the page it is on, a thumbnail of that page, a rolling feed of what it just did (each action, its target and how it turned out, read from the same action log a finding's repro trace uses), and a live stream you can switch on per session or for all of them. Opening a card's close-up shows a longer stretch of that feed beside the session's brief: the task the agent gave it at `scout_attach {task}`, and the goal of the journey it is on right now. Actions of one journey share a tint in the feed, and pointing at a group shows the goal those actions served. The Report button shows the run's report as it stands, rendered from the current state without writing it, so it can be read while the run is still going. It works for headless runs, and a session whose call is still running past its own tool's watchdog budget is marked as stuck.

`status.json` now describes every session instead of the last one to write, and `scenescout status` prints a line for each.

The live view is served on `127.0.0.1` only, behind a per-process token, answers GET and nothing else, and writes no frame to disk ([ADR 7](docs/adr/0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md)). A stream runs only while someone is watching it. Set `SCENESCOUT_LIVE=off` to keep the engine from opening the port. The engine now also shuts down, closing its browsers and removing the token file, when its client closes the connection instead of sending a signal.
