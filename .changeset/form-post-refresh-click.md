---
"scenescout": patch
---

A click that submits a native form to a refresh endpoint the refresh broker handles returns once the navigation commits, with the broker's line in its own result. In Chromium it used to wait out the action limit, because loading another session's rotated profile opened a page that Chromium did not finish while the form's navigation was held. While it holds a navigation, the broker now loads only the profile's cookies; the rest of the profile is loaded at the next refresh a script sends, and the form's write-back saves the page's cookies while keeping the profile's storage.
