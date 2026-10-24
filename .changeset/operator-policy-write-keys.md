---
"scenescout": minor
---

The config file takes three more keys: `writeClassifier` (`"strict"` turns the strict write classifier on whatever `SCENESCOUT_STRICT_WRITES` says), `refuseDestructiveGets` (`true` refuses page loads whose address is a destructive command in `observe` and `read-only`) and `authPosts` (the only POSTs that count as signing in; `SCENESCOUT_AUTH_POSTS` may only narrow it). The `strict` preset now also sets `refuseDestructiveGets`. The attach, `check`, a first look and `scenescout policy explain` all apply them, and each names where a setting came from. While a guided plan is open, a sign-in list now narrows the path rule instead of being ignored. `scenescout ci` under `requireGuidedPlan` runs in `observe` and refuses a `--mode` above it before it starts. `evidence` capped at `file` or `off` refuses `scout_screenshot` and `scout_cards`' inline pictures. A command refused by `maxMode` now says which `--mode` to pass.
