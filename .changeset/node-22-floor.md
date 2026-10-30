---
"scenescout": minor
---

Requires Node 22 or later (22.19 or newer); Node 20 reached end of life on 2026-04-30. Node 22, 24 and 26 are supported. `scenescout doctor` and the GitHub Actions check for 22.19 and install Node when the runner has an older one. Requests SceneScout makes through a proxy (`HTTPS_PROXY`, `HTTP_PROXY` or `SCENESCOUT_PROXY`) now go through undici 8 and still reach a plain-http address through a CONNECT tunnel, so an address the proxy cannot reach is still reported as a network failure.
