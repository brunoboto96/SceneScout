---
"scenescout": minor
---

A config file can mask personal data in what the tools return to the agent: `{"redactPageText": "pii"}` in `.scenescout/config.json` replaces email addresses, phone numbers written after a word for one, and card numbers with `[email redacted]`, `[phone redacted]` and `[card number redacted]` in snapshots, page titles, API response bodies, console and network lines and findings. It is off by default, only the file sets it, and a project's own file can turn it on but not off. The engine's oracles read the page before masking; pictures are not masked, and it can hide bugs that are about that content. The attach's config line, `check`, `ci` and `scenescout policy explain` say when it is on.
