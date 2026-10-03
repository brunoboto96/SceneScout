---
"scenescout": minor
---

Saved flows can assert an element's state with a new step, `expect-element`: a target and a state of `visible`, `hidden`, `enabled`, `disabled`, `checked` or `unchecked`. `hidden` also holds when nothing matches, so a flow can say a dialog closed or a receipt was never shown, and a failure says what is true instead (`testid=receipt is visible, expected hidden`).
