---
"scenescout": minor
---

New `scenescout check <url>`: a deterministic sweep that needs no model, so it can gate a pull request. It visits the start page, the project's scanned routes and every same-origin link it finds, and measures each one: HTTP and page errors, layout geometry (covered, clipped and overlapping controls, blocking overlays), broken images, controls with no name, contrast, focus indicators and pages with no way out. It writes `report.md`, `check.sarif` and `check.json`, adds the report to the GitHub Actions job summary, and exits 0 on a pass, 1 when the gate fails (`--fail-on high` by default) and 2 when it could not run. It never writes to the app.
