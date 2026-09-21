---
"scenescout": minor
---

Wait for the requests an action fired, rather than a fixed sleep, and let a session ask to be slowed down.

Every action used to be followed by a flat 400 ms sleep. Measured against the demo app that was 54% of a snapshot's wall time, and a run of two hundred actions spent over a minute asleep — while any page slower than 400 ms was still read before it had finished changing. The engine already intercepts every request, so it now waits on what is actually in flight, with a quiet window after the last one starts and after the action itself, and the old constant survives as a ceiling instead of a floor. On the demo app a navigate costs 149 ms rather than 430, and a snapshot 446 rather than 740.

The same rule carries the opposite need. `scout_attach {paceMs}` and `scout_session {paceMs}` set a floor between actions so a person watching can follow along — useful when taking notes beside a run or demonstrating a flow. Unset, a session runs as fast as its page allows; `scout_session {paceMs}` with no `name` changes every attached session at once.
