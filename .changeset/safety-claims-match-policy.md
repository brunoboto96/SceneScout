---
"scenescout": patch
---

The README, the website, the guide, the skill and the desktop extension's description now say what each write mode lets out as the policy enforces it: `observe` also lets out `HEAD`, `OPTIONS` and the `POST`s named as reads, a plain `POST` in `read-only` can change a record that was there, a link that acts when opened is followed unless destructive page loads are refused, and messages over a WebSocket are not inspected. A new "What it reaches" table in the guide lists the network destinations, port, processes and files of the plugin, the desktop extension and the mod, and the plugin's and extension's manifests link to it.
