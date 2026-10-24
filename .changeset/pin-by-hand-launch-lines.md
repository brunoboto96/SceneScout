---
"scenescout": patch
---

The copy-paste server setups in the README, the guide and the skill now name the release they were published with (`npx -y scenescout@<version> serve`), as the Claude Code plugin does, instead of running whatever npm calls latest on every launch. The guide says how to follow the newest release instead, and the release process keeps every copy in step with the package version.

The Claude Code marketplace now reads both plugins from the release's major tag (`v3`) instead of the main branch. The tag moves only once npm has the release, so a plugin update can no longer start a version whose publish has not finished.
