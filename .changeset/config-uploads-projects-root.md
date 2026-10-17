---
"scenescout": minor
---

The config file takes two more keys. `uploads: "fixtures"` lets `scout_upload` send only the files it generates: a `filePath`, and a run plan's upload step naming a file, are refused, whatever `SCENESCOUT_UPLOAD_ALLOW` lists. `projectsRoot` names the folder every project folder must sit inside by its real path: an attach, `scout_login` or `scout_scan` naming a folder outside it is refused, and so is `check` or `ci` given such a `--project`, or a first look run in such a folder; only the operator's file may set it. The `strict` preset now sets `uploads: "fixtures"`, so a team using it uploads generated files only; `"uploads": "project"` beside the preset restores file uploads.
