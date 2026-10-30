---
"scenescout": patch
---

A refused save followed by a success page that arrives after the settle wait is now reported as `false_success`. The refused writes are kept until the page they lead to has landed (within the page-load limit) and that page is judged, instead of being dropped when the action settled mid-navigation.
