---
"scenescout": patch
---

Rebuilding SceneScout no longer leaves the `scenescout` command unrunnable. The build now marks the command file executable, so a checkout installed with `npm link` keeps working after `npm run build` instead of failing with "permission denied".
