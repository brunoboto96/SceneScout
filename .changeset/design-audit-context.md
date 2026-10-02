---
"scenescout": patch
---

The design audit's task-efficiency lines count only what they describe. Competing actions are buttons and links painted as buttons; text fields and breadcrumb links no longer count. Form burden counts the fields of a form; row-selection checkboxes, selects that edit a table row in place and search boxes no longer count, and when the page has a `<form>`, fields outside it no longer count either. The app shell's landmarks (navigation, banner, sidebar and footer regions outside the main content) are kept out of a page's score from the first audit, so the first pages of a run are no longer scored with the shell in them while later ones are scored without it. A shell built without landmarks is still recognised only once the shared-chrome census has seen it on several routes.
