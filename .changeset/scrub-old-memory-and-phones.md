---
"scenescout": patch
---

Old memory is cleaned on first load. A `.scenescout/` store written by an earlier version can hold a typed password, a card number or an email address in clear; the first time this version opens it, its findings, ticket verdicts and earlier sessions' action logs go through the current redaction once and are written back owner-only. Phone numbers written right after a word for one (`Phone:`, `Tel.`, `Mobile`, `Telefon`, `Teléfono`, …, or a field labelled so) are now redacted as `[phone redacted]`; a number with no such word before it is kept.
