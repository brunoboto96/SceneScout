---
"scenescout": minor
---

Sign-in profiles saved by `scenescout login` now keep sessionStorage and IndexedDB as well as cookies and localStorage, so an app whose sign-in library keeps its token in either still comes back signed in when a session attaches by `role`. sessionStorage is restored before the app's own code runs, only on the origin it was saved from and once per tab, so a session that signs out stays signed out. The line printed after saving counts origins with session storage and IndexedDB databases. Logins saved by an earlier version load as before; record them again to pick up the new storage.
