---
"scenescout": minor
---

The check and ci GitHub Actions now install the release their ref names with `npm ci --ignore-scripts` from that release's own lockfile, so its dependencies are the ones it was tested with rather than the newest each range allows. A `version` input naming another version installs as before and leaves a warning annotation that the dependencies are not pinned. npm, `npx` and plugin installs are unchanged.
