---
"scenescout": patch
---

The contrast rule no longer reports text whose own colour is fully transparent, such as the selectable text layer a PDF viewer lays over the rendered page. That text is not painted, so its 1.00:1 ratio is not what anyone sees, and how many of those spans were measured depended on whether the viewer had finished loading. Translucent text that is painted, a faint watermark say, is still measured.
