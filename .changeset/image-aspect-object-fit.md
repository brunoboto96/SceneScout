---
"scenescout": patch
---

The design audit's `image-aspect` rule no longer reports an image that keeps its proportions through `object-fit: cover`, `contain`, `scale-down` or `none`, whether set inline or by a class. Only an image stretched to its box under `fill`, the default, is reported as distorted.
