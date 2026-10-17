---
"scenescout": patch
---

The `ci` action uploads a fixed list of files (`report.md`, `report.html`, `summary.md`, `ci.json`, `ci.sarif` and the pictures in `shots/`) instead of its whole output folder, so an `out` of `.scenescout` no longer carries saved sign-ins or memory into the artifact. Both actions take an `artifact-retention-days` input (1 to 90; empty keeps the repository's setting). The docs say how to prune the `scenescout-shots` branch.
