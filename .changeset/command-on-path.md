---
"scenescout": minor
---

`scenescout install` now puts the `scenescout` command on your PATH. Until now neither an `npx` run nor a source checkout left it there, so `scenescout status`, `scenescout doctor` and the other commands the tool itself tells you to run answered "command not found".

Run through `npx`, install does `npm install -g` of the version you ran. From a checkout it does `npm link`, so the command always runs what you last built, and From a checkout it runs `npm link`, taking the name over from any other copy the way install already takes over the MCP registration. Run through `npx`, a command that is already there is left alone. On Windows the step prints the command to run by hand. If npm refuses, the step prints the command to run by hand and does not fail the setup. `--no-command` skips it.
