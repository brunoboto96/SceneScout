---
"scenescout": patch
---

Typed passwords and other secret fields are now masked in logs, reports and exported issues. A value typed into a password field, a field whose `autocomplete` marks a credential, a one-time code or a card, or a field whose name or label says so, is shown as `•••• (masked: password field)` in the tool's result, the action log, memory, the report, the live view's feed and a finding's steps, and so is what the field held before. Text the run keeps is also cleared of email addresses and card numbers, of a value typed after a label that names a secret, whatever its length, and of the value of a parameter named for a secret (`?password=…`, `?pin=…`).
