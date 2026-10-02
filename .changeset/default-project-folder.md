---
"scenescout": minor
---

`scout_attach` and `scout_login` no longer need a `projectPath`; left out, both choose the same folder for a site, so a sign-in saved by `scout_login` is found by the attach after it. Given, it still always wins. Left out, a client that offers a workspace folder gets that folder, and otherwise each tested site gets its own folder, `Documents/SceneScout/<host>/` by default (`localhost-3000` for `http://localhost:3000`), created on first use and named in the attach's result so the person knows where the report is. `SCENESCOUT_PROJECTS_DIR` moves that folder, or `off` makes `projectPath` required again. The default is refused when it would sit inside a git repository below the home folder; a home folder that is itself a repository, as with dotfiles, does not count.
