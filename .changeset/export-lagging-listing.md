---
"scenescout": patch
---

`scenescout export` no longer files a finding twice when an export runs straight after another, or after a create whose result was uncertain, while the tracker's issue listing has not caught up. Each filed issue is recorded in `.scenescout/exported.json` and read back by number on the next export; GitHub's newest issues are also read without the label filter; and in Jira a finding whose create may have been made is held back for 15 minutes unless its issue is found.
