---
"scenescout": minor
---

`scout_attach` takes `trustedEmbeds`, a list of origins the user trusts (a provider in test mode, say): in safe-write mode only, the writes their frames send outside the app go out. Anything that is not a plain http(s) origin is refused at attach, trust is ignored in the other modes, and the report names the list.
