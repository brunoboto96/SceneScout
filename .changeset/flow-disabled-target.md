---
"scenescout": patch
---

A saved flow step on a control that is shown but stays disabled (or, for `type`, read-only) until the action limit runs out now fails saying so first, `testid=save is visible but disabled after 5s`, followed by the limit hint. It used to report only an action timeout, which never said the control was there but disabled.
