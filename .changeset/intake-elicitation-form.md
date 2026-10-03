---
"scenescout": minor
---

Ask the start-of-run questions as one form where the client can show one. A new `scout_intake` tool checks whether the client declared MCP elicitation in form mode and, if it did, asks the address, whether and how to sign in, what to check and whether the site holds real data in a single form, then returns the `scout_login` and `scout_attach` calls the answers choose. With no form support, or when the person declines or closes the form, it returns the questions for the agent to ask in chat, as before. The form never asks for a password or a code: signing in stays in the window `scout_login` opens. The skill and the `explore` prompt call `scout_intake` before setup.
