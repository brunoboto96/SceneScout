---
"scenescout": minor
---

Saved flows have an `upload` step: attach a small valid file generated on the spot (`pdf`, `png`, `txt`, `csv` or `json`, or the kind the input's `accept` asks for) to a file input, the control that opens its chooser, or the page's only file input. A journey that starts from an attached file can now be saved and replayed by `scenescout check`. Submitting the upload is a write, so it reaches the server only under `--flow-writes allow`.
