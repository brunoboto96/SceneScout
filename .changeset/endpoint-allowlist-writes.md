---
"scenescout": minor
---

The operator can name the writes that may leave the page. The config key `allowedWrites` (a list of `METHOD /path` entries, narrowed by `SCENESCOUT_ALLOWED_WRITES`) makes every other write refused in `observe`, `read-only` and `safe-write`, and lets a listed one out whatever its path or body looks like, so the guarantee rests on the list rather than on pattern matching. A method override is judged as the method it names, a project's own file and a guided check can only narrow the list, and `scenescout policy explain` and `scenescout config explain` show the list and where it came from.
