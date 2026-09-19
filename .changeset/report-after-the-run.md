---
"scenescout": minor
---

The live view now hands over the report when the run ends. Closing the last session used to take the report with it — the view served it from the live engine, so the moment the browsers went the page said there was nothing to report. The last rendering is now kept, and when the board empties the page says the run has finished, opens the report by itself, and names the file it belongs in: `saved at <path>` once `scout_report` has written it, or plainly that it is not on disk and this page holds the only copy. A **Save a copy** button downloads that copy through the viewer's own browser (nothing is asked of the engine, which still answers `GET` and nothing else), and closing the tab on a finished run whose report was never written asks for confirmation first.
