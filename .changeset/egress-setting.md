---
"scenescout": minor
---

A guide page, "What leaves the machine", lists every path by which data leaves the machine, what it carries, to whom, and how to turn it off. The config file takes a new key, `egress` (`none`, `model-only` or `all`, the default): `model-only` refuses `scenescout export`, the ticket tools and `/scenescout qa`; `none` refuses `scenescout ci` as well, turns the dedup judge off and keeps a finding's picture to a file. Under `none`, `scout_screenshot` and `scout_cards`' inline pictures are refused too. The `/scenescout qa` gate reads the setting from the default branch, so its job needs `contents: read`: a workflow whose gate job cannot read the repository's files now starts no run and says to add it.
