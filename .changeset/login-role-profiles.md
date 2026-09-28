---
"scenescout": minor
---

Add `scenescout login <url> --role <name>`: sign in once in a visible browser (SSO, MFA, anything the app asks), press Enter, and the session is saved as that role's profile in `.scenescout/auth/<name>.json`, readable by your account only and kept out of git. `scout_attach` takes a new `role` argument that builds the session's own browser from that profile, so any number of sessions can run as the same role from one login. A role with no saved login is refused with the command to run, and `role` with `storageStatePath` is refused as ambiguous. Lane briefs tell each lane to attach by role when the planner signed in that way.
