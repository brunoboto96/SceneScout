---
"scenescout": patch
---

Page-state fingerprints and finding ids are now derived with SHA-256 instead of SHA-1. They are identifiers, not a security control, but the ids change: on the first run after upgrading, findings stored by an earlier version may show as new once, and ones marked resolved may be reported again.
