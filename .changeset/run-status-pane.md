---
"scenescout": minor
---

Add `scout_status`, a run-status pane built as an MCP App (`io.modelcontextprotocol/ui`, specification 2026-01-26). In a client that renders MCP Apps it shows each session's objective and task, open findings by severity, coverage and a button for the live view, and refreshes itself every 2.5 seconds through the app-only `scout_status_poll` tool. Every other client gets the same as text, starting with the live view's loopback address. The pane's page loads nothing from outside and shows only what the live view already shows.
