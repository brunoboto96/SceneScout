---
"scenescout": patch
---

A field named for a security answer ("Security question answer", "Memorable information", "Maiden name"), a recovery or master key, or a bank or state identifier ("Account number", "Routing number", "Sort code", "IBAN", "SSN") is now taken for a secret field, so what is typed into it is masked; its near misses ("Security question", "Account name", "Sort order") are not. The generated redaction corpus gains secret shapes that are not drawn from the detector's word lists, and the Safety model guide's published rates now show the field detector's remaining misses (a secret named only by the question it answers).
