---
"scenescout": minor
---

`scout_attach` no longer needs a `projectPath`. Given, it still always wins. Left out, a client that offers a workspace folder gets that folder, and otherwise each tested site gets its own folder, `Documents/SceneScout/<host>/` by default (`localhost-3000` for `http://localhost:3000`), created on first use and named in the attach's result so the person knows where the report is. `SCENESCOUT_PROJECTS_DIR` moves that folder, or `off` makes `projectPath` required again. The default is refused when it would sit inside a git repository.
