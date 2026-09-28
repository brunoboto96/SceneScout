---
"scenescout": minor
---

`/scenescout qa` can now be opened to more than a list of usernames: `SCENESCOUT_QA_ALLOWED_ROLES` allows commenters by their association with the repository (`OWNER`, `MEMBER`, `COLLABORATOR`), and `SCENESCOUT_QA_ALLOWED_TEAMS` allows active members of the organization's teams (`org/team-slug`), read with a separate `SCENESCOUT_QA_TEAM_TOKEN` secret that only the gate job receives. The lists combine with `SCENESCOUT_QA_ALLOWED`; unset, the default stays the repository's owners. An unknown role fails the gate, and a team lookup with no token, a refused token or a team of another organization refuses the commenter and says why in the job's log.
