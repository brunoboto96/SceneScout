---
"scenescout": minor
---

A guided re-check after a fix, and saved checks. `scout_recheck_plan` plans a re-check of the problems earlier checks left open in the care level they were found in, never a looser one: each finding now records the mode it was filed in, problems found in a looser care level are left for a re-check of their own, and a re-check is a new plan, so a care level that writes is confirmed again by the person whatever the original check was given. `scout_saved_checks` lists, saves, runs again and deletes a person's guided checks, kept owner-only in `.scenescout/guided/` with the choices only (a file with any other field, or a credential in it, is refused). The *Re-check after a fix* prompt now follows the re-check's plan, and the guided panel lists saved checks on its welcome with **Run again** and **Delete** (which asks first), saves a check from its results, and plans **Check them again** on the server.
