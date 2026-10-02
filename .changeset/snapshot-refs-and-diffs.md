---
"scenescout": minor
---

Snapshot refs last longer and re-snapshots cost less. Refs from the last snapshot keep working after a search or filter that rewrites only the query string, and a control a re-render replaced is found again by its unique test id (the action says it was re-bound); a route change still refuses them, and the next diff now says when refs were dropped instead of calling them stable. A route you come back to is shown as a diff against its own last snapshot, and another tab of the same screen as a diff against that screen's last tab. Repeated rows are matched by their text or link, so a filtered list reads as the rows that went rather than as the first row relabeled. A truncated snapshot says what it cut, by role and test-id family, and keeps pager and "Load more" controls in the list. An element listed without a control role that a click or Tab still reaches is marked `[clickable]` or `[focusable]`.
