---
"scenescout": patch
---

`scenescout check` and the first look no longer report a feed, a plain-text file, XML, JSON, a PDF or an image as a dead end. A route's response content type now decides whether it is a page: one served as anything but `text/html` or `application/xhtml+xml` is listed under "Not pages" in the report and as `resources` in `check.json`, is not checked against the page rules, and does not count towards the routes checked or `--max-routes`. One that answers 4xx or 5xx is still reported as the route's error.
