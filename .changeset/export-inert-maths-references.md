---
"scenescout": patch
---

`scenescout export` escapes issue text the way the `/scenescout qa` reply does. In a GitHub issue body, text from a finding can no longer render as maths: a zero-width space goes before each `$`, because a backslash does not stop GitHub's renderer. It also can no longer reference another repository's issue, pull request or discussion through `owner/repo/issues/N`. The Arabic letter mark (U+061C), a bidirectional control that could reorder a line, now becomes a space like the other controls, in GitHub and Jira text alike.
