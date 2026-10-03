---
"scenescout": patch
---

A check or first look with no signed-in session no longer reports each route that redirects to sign-in as an `auth-redirect` issue. It lists them once as a coverage gap ("N routes need sign-in; give a role to cover them"), under "Needs sign-in" in the report and as `needsSignIn` in `check.json`. With `--storage-state`, a redirect to sign-in is still reported as a lost session.
