---
"scenescout": minor
---

Every finding is filed with a picture of what it is about: the element `scout_finding {ref}` names, with a margin, or the page as it was. The picture is kept in `.scenescout/recordings/`, shown under the finding in `report.html` and in the live view's report, named in `report.md`, and returned in the `scout_finding` result as image content so a chat client shows it as the finding is filed. Pictures are bounded by `SCENESCOUT_EVIDENCE_MAX_PX` (default 800 pixels on the longer side) and `SCENESCOUT_EVIDENCE_MAX_KB` (default 200), and a session returns at most `SCENESCOUT_EVIDENCE_INLINE` (default 10) in its results. `scout_attach {evidence}` or `SCENESCOUT_EVIDENCE` chooses `inline`, `file` or `off`; a CI job, and `scenescout ci`, default to `file`. `SCENESCOUT_RECORD=on` makes every session record a frame after each action without each attach asking.
