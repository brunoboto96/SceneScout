---
"scenescout": minor
---

The operator's config file takes a `hosts` key (and `SCENESCOUT_HOSTS`, which may narrow it): the only hosts SceneScout may start the browser on. An attach, `scout_login`, `scenescout login`, `scenescout check`, a first look and `scenescout ci` (with its `--compare-url`) on another host are refused with the reason, and a `/scenescout qa` comment starts no run on a preview or base URL whose host the default branch's list does not name. `scenescout config explain` shows the list and where it came from.
