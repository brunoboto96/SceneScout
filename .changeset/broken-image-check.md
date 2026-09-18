---
"scenescout": minor
---

Snapshots now list images that failed to load, under `BROKEN IMAGES`, read from the DOM. This catches an image whose URL answers 200 with something that is not an image, which the HTTP oracle cannot see because no request failed. An `<img>` is now named by its alt text and listed with the role `image`; it previously appeared as `generic "(unnamed)"`.
