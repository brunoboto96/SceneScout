---
"scenescout": minor
---

Add `scenescout preflight <url>`, which checks in seconds and with no browser whether a machine can reach what a run needs. It reports the app's DNS, connection, timeout, TLS, HTTP status and bot-challenge failures, an expired saved sign-in (`--role`, `--storage-state`) and, with `--model-api`, the model's API, each with its own exit code. The check action runs it before installing the browser when `preflight: "true"`. A new guide page, Network requirements, lists every host each command needs, how caches and mirrors remove downloads, and how to run on a self-hosted runner inside a private network.
