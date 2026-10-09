---
"scenescout": minor
---

`scenescout check --record --template <file.json>` (the action's `template` input) also writes the recorded run up as a test report laid out by the template: each saved flow a test and each step a row with its expected and actual result and its frame, failed steps as deviations, a SHA-256 manifest of the evidence and blank sign-off rows. Flows gain optional `id`, `requirements` and a step's `expected` for traceability; an example template is in `examples/report-template.json`.
