---
"scenescout": minor
---

`scout_coverage` lists the forms seen this run that no session has submitted empty: a `<form>` with a native submit control (a button linked by `form="id"` included) and at least one text field, until a click on that submit control, or Enter in one of its text inputs, goes while every text field is blank. A form is known by its `id`, else its `name`, else its `action` and method, and only when it has none of those by its submit control. Forms with no text field (only checkboxes, radios or selects), search boxes, forms whose submit is disabled while they are blank, and fields with no `<form>` around them are not listed. The gap ledger is unchanged: like the dropdown options, this is a coverage prompt, not a gate on `extensive`.
