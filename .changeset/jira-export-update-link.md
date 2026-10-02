---
"scenescout": minor
---

`scenescout export --to jira` keeps a filed issue up to date and links it to the ticket it fails. A later export rewrites an open issue's summary and description when the finding has changed, unless someone has edited them in Jira since, and adds the picture, frames and ticket links it lacks, rather than leaving it as first filed (`--jira-update off` only lists it). The finding's picture is attached first, and a finding that fails a ticket's acceptance criterion is linked to that ticket (`--jira-link-type`, default `Relates`, or `JIRA_LINK_TYPE`; `none` links nothing). GitHub issues name the picture and list the failed criteria.
