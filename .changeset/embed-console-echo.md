---
"scenescout": patch
---

The console line Chromium and WebKit print for a failed load ("Failed to load resource: …") now goes where its request went: when another site's frame sent the request outside the app, the line is attributed to that embed at medium severity, instead of being filed as a high-severity console error of the app. The same line for a request the app sent stays the app's, other console and page errors are still not attributed by frame, and Firefox prints no such line.
