---
"scenescout": patch
---

Text from the app under test is written inertly into every Markdown file SceneScout makes: the team report, `report.md` (plain and technical parts), the check's report and the CI run's summary. A line break in a title no longer starts a heading, and link, image or HTML syntax shows as text instead of rendering (an image reference is no longer fetched) wherever the Markdown is pasted. `report.html` and the live view show the text as the app wrote it.
