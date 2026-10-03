---
"scenescout": minor
---

`scenescout export --from <file>` exports a `check.json` from `scenescout check` or a `ci.json` from `scenescout ci`, so the unattended runs can file GitHub or Jira issues without an interactive session's memory. Their issues get the same body, label and marker as memory findings: a check issue is keyed on its fingerprint and a ci finding keeps its memory id, so a re-export files nothing twice. The project's memory stays the default source.
