---
"scenescout": minor
---

The end-of-check card. Once a guided check has ended, `scout_recap` returns a one-screen recap to share (the address, pages checked, problems by impact, problems a re-check confirmed fixed and the time it took) as an SVG picture and as lines, built by the engine from the check's figures with every figure and the address escaped, and writes it to `.scenescout/recap.svg` when asked; `scout_team_report` returns the same picture. The optional Claude Code mod shows the card when a check ends, as a picture in the desktop Code tab and as lines in the terminal, with **Save as picture**. A new mod setting, `game` (off by default), draws a bestiary of the open problems in the panel only; it changes no card, report or ticket text and is never in anything shared.
