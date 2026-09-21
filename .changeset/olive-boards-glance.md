---
"scenescout": minor
---

Make the live board answer, at a glance, which session is stuck and which is in trouble.

On a board of eleven cards the questions actually being asked are "which one has been on the same thing for ten minutes", "which one is having trouble", and "where is the one on the orders register". The board could answer none of them, and two of the three answers were already in the status payload on every poll and reached nobody: `taskSince` was rendered only inside the close-up, and a step whose result went wrong was only ever a red word in a six-line feed somebody had to read.

Each card now carries a line under its task: how long the session has been on it, and how many of its recent steps went wrong — counted with the same rule the feed colours red, so a card and the feed beneath it cannot disagree. The line is absent on a session that has stated no task and had no trouble.

The header gains a filter over everything a card shows — name, role, objective, task, page, tool. It hides cards and nothing else: a filtered-out session is still running, still streaming and still counted in the header, and a filter that matches nothing says so rather than showing a blank page that reads as every session having gone.

The close-up's timeline can be walked from the keyboard: arrows step, Home and End jump to the ends, and Space returns to what the session is showing now. Scrubbing a long run by clicking 16-pixel ticks was the thing a mouse was worst at, and the run worth examining is always the one with hundreds of steps.
