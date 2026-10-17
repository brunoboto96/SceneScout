---
"scenescout": patch
---

The desktop extension bundle attached to a release now comes with a `SHA256SUMS` file and a build provenance attestation (`gh attestation verify`). `npm run build` empties `dist` first, so a file removed from the source is no longer left in the package. The `ci` action blanks the model key in every step except the one that runs the exploration, so the install and browser download steps no longer see it.
