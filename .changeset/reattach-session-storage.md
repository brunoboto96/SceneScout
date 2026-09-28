---
"scenescout": patch
---

A role session that re-attaches after losing its sign-in now also gets back the latest profile's sessionStorage, so an app that keeps its token there is signed in again rather than left signed out. Each tab is seeded once more, only for the origins the profile holds, and a sign-out after that stands.
