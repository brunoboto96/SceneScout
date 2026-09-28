---
"scenescout": patch
---

`--help` and `-h` now print the usage and exit 0 on every subcommand before it does anything; `scenescout install --help` used to run a real install. `install`, `doctor`, `scan`, `status` and `watch` now refuse a flag or argument they do not know instead of ignoring it.
