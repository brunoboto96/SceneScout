---
"scenescout": patch
---

Card numbers grouped with dots (`4111.1111.1111.1111`) or with non-breaking, thin or figure spaces, and card numbers written straight after an abbreviation's dot (`no.4111…`), are now redacted like those grouped with spaces or hyphens. This applies wherever personal data is redacted: memory, the report, a check's `report.md`, `check.json`, SARIF and replay page, and exported issues. An address, a version, a date or a decimal written with dots stays: the digits after a number's dot never start a card number, and across a dot no group of a card number is longer than six digits. The check's replay page now uses the same redaction as the rest of the run, so a list of small numbers whose digits happen to pass the card check (`320 375 414 768 …`) is no longer redacted there.
