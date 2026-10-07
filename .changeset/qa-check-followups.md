---
"scenescout": patch
---

`/scenescout qa check` follow-ups. Behaviour change: a comment beginning `/scenescout qa check …` used to be a preview run with the focus "check …"; it now always means the project's own check, so give a preview run's focus in other words. The reply no longer calls a run "Passed" when a focus matched no journeys. It says why GitHub refused a dispatch: a deleted branch, a branch whose copy of the workflow lacks the trigger or the file, or undeclared inputs. A cancelled run gets its own reply. The dispatch names the branch as `refs/heads/<branch>`, so a tag of the same name is never run. The artifact is downloaded as its zip and never extracted. Only `check.json` is read from it, capped at 10 MB, and an artifact over 1 GB is not downloaded. The example check workflow runs one check per pull request.
