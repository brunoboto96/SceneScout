---
"scenescout": patch
---

Card numbers grouped with dots (`4111.1111.1111.1111`) or with non-breaking spaces are now redacted like those grouped with spaces or hyphens. This applies wherever personal data is redacted: memory, the report, a check's `report.md`, `check.json`, SARIF and replay page, and exported issues. An address, a version, a date or a decimal written with dots stays, and the digits after a dot never start a card number. The check's replay page now uses the same redaction as the rest of the run, so a list of small numbers whose digits happen to pass the card check (`320 375 414 768 …`) is no longer redacted there.
