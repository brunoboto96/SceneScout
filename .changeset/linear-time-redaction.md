---
"scenescout": patch
---

Redaction and the guided assistant's credential check run their patterns on a linear-time regular-expression engine, so text crafted to make a pattern backtrack (a long word, a field label or parameter name of one long word, a secret's name followed by many spaces) no longer stalls a run; several such 1 MB texts did not finish in a minute and now take a second or a few. Adds one dependency, `re2js`, written in JavaScript: nothing to compile or download per platform, so `npx scenescout` and the desktop extension install as before. Text written with a long s (ſ) or a Kelvin sign (K) in a secret's keyword is now redacted too.
