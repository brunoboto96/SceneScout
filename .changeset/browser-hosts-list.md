---
"scenescout": minor
---

Add `browserHosts` to the operator config (and `SCENESCOUT_BROWSER_HOSTS`): the only hosts the browser may reach besides the app's own. With a list set, every request to another host is refused before it leaves the machine, in every mode: page loads and the later hops of their redirects, scripts, styles, images, frames, fetch and XHR, and WebSockets. A refused page load leaves the page where it was, an attach whose start address redirects off the list is not attached and names the host, and each refusal is reported in a `BROWSER-HOSTS blocked` notice. The `strict` preset now sets `browserHosts: []`, the app's host alone. `scenescout policy explain` and `scenescout config explain` show the list.
