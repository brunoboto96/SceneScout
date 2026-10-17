---
"scenescout": minor
---

Problems can be filed as GitHub or Jira tickets from the chat and the guided panel. `scout_ticket_preview` lists what would be filed, what the tracker already holds and what waits for the next filing, and sends nothing; `scout_ticket_file` files exactly that preview, only after the person says yes in the server's own form (Claude can ask for it, never answer it), within 10 minutes and while those problems are unchanged. The issues are the ones `scenescout export` files, with the same marker. The *File problems as tickets* prompt now uses them, the guided panel's results gain **File as tickets**, and the desktop extension has optional settings for the GitHub token and the Jira site, email and API token, kept as secrets and never asked for in the chat.
