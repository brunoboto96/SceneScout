---
"scenescout": patch
---

A field named as a passphrase in two words ("Pass phrase", `pass_phrase`, `passPhrase`) is now taken for a secret field, so what is typed into it is masked. A secret's two-word name followed by a word about it ("API key count", "Pass phrase hint") now reads as a setting, as `token_count` already did, so its value is no longer masked. The Safety model guide also publishes the measured miss and false-alarm rates of the redaction (secret fields, typed values, secret parameters, email addresses, phone numbers and card numbers), from a seeded generated corpus that a test holds equal to a fresh run.
