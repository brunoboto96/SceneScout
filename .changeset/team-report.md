---
"scenescout": minor
---

Add `scout_team_report`: the plain report made for sharing. It writes `.scenescout/team-report.html`, with a cover (the site, the date, what was checked, the care level and how thorough), a short summary, each problem as a card with its picture, the ones marked not a bug listed apart, what the check did not test and blank sign-off lines, and an evidence folder beside it (`.scenescout/team-report/`) with the pictures, the report as Markdown and a manifest of every file's SHA-256, the SceneScout version and the check's times. It writes nothing outside `.scenescout/`, and the page runs no script. The chat's *Make a team report* prompt now calls it, and the guided panel's results have a **Make a team report** button that writes it without a turn for Claude and then offers **Open the report** and **Show the folder**.
