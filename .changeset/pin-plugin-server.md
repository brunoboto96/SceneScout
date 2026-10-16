---
"scenescout": minor
---

The Claude Code plugin and `scenescout install` now start the server at the version they were released with (`npx -y scenescout@<version> serve`) instead of whatever npm calls latest on each launch. The release step keeps the plugin's launch line in step with the package version. `scenescout doctor` still recognises registrations made before the pin.
