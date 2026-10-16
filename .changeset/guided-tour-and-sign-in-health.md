---
"scenescout": minor
---

Before a guided check with a sign-in starts, it now says whether the sign-in saved for it lasts the whole check, judged from the cookie and token dates against the check's time limit, and judged again when the plan is read back to start. Only a sign-in certain to last is used as it is, with no sign-in window; otherwise the window opens first and the sentence says why. `scout_guided_plan` returns the verdict as `signInHealth`. The optional Claude Code mod's guided panel shows it, with **Sign in again** and the `scenescout login` command where the saved sign-in lasts, and opens on a three-panel first-run tour (skippable, remembered in the mod's own store, and offered again from the welcome screen). A saved sign-in's lifetime now also counts JWTs in sessionStorage, and a storage value kept under a credential's name with no JWT in it counts as undated; `scenescout login` quotes an address with a query in the command it names.
