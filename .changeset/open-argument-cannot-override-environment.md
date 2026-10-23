---
"scenescout": patch
---

A `scout_attach` `open` argument can no longer open a browser window where the operator or the environment says not to. `SCENESCOUT_OPEN=none` refuses it, as does a detected CI run, an SSH session or a machine with no display (unless `SCENESCOUT_OPEN` is set explicitly), and `SCENESCOUT_OPEN=report` is not widened to the live view by an argument. The attach result says in one line what was not opened and why, the report included. An argument still asks for opening where the environment allows it, and can still ask for less.
