---
"scenescout": minor
---

Tell network failures from the app's, and run behind a proxy or a firewall's allowlist.

- `scenescout check` no longer files a request or page load that failed on the network (a name that did not resolve, a refused or dropped connection, a network timeout, a failed TLS handshake) as an issue. Each is listed once under "Network failures" in the report and `network` in `check.json`. One reaching the app's site (its host, or a sibling subdomain such as its API's) at the gate's severity (high for a page that did not load, medium for a request, as the issues they replace) leaves a passing gate incomplete, and the check exits 3; one reaching another host (an unreachable CDN) is listed only, and its console echo is no longer a second finding.
- `SCENESCOUT_RETRY_NETWORK=on` tries a page load that failed on the network once more, and lists each retry in the report.
- The first page of a run names a DNS, TLS or timeout failure instead of asking whether the app is running, and `scenescout ci` names the cause of a failed model call.
- `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, or `SCENESCOUT_PROXY`, now apply to the browser and to SceneScout's own requests (the preflight, the model's API, GitHub, Jira).
- `SCENESCOUT_APP_HEADER="Name: value"` sends a header to the app's own origin only, for a firewall that lets CI traffic through by one. Its value is never printed. Chromium and Firefox only.
