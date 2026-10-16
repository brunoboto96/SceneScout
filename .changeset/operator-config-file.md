---
"scenescout": minor
---

A committed `.scenescout/config.json` caps what an agent may choose. `maxMode` refuses an attach, `check --mode`, `ci --mode` or a first look's `--mode` above it; `requireGuidedPlan` holds the guided gate from the server's start; `readPosts` and `trustedEmbeds` become the most an attach may name; `dedup: "rule"` keeps the model judge off; `evidence` caps what a finding's picture may do. `{"preset": "strict"}` sets all of them in one line. The server reads the file from the directory it starts in, or from `SCENESCOUT_CONFIG`; a project's own file may only tighten it. A file that is not valid stops the server as it starts. With no file, nothing changes.
