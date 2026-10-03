---
"scenescout": patch
---

On Windows, `scenescout install --client` starts an npm-installed client (a `.cmd` or `.bat` shim) through `cmd.exe`, so registration runs the client's own command instead of stopping and printing it to run by hand.
