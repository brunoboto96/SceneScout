---
"scenescout": minor
---

New command `scenescout config explain [--project dir]`: prints every key of the config file as a run would use it and where each value came from (a default, a preset, the operator's file, the project's own file, or an environment variable), and what the file lowered or left out. It reads the files as `check` does, starts no browser and sends nothing, shows no user name, password or token from an address, and exits 2 on a file that is not valid, a folder outside `projectsRoot` or a bad argument.
