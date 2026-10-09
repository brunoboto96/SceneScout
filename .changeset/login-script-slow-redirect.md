---
"scenescout": patch
---

`scenescout login --script` no longer reports a correct password or one-time code as refused when the app is slow to leave the page. A submitted field counts as refused only once the page has answered (emptied the field, drawn it again or moved on); while the very field it was typed into still holds it, disabled or not, the run keeps waiting, and at the timeout says the sign-in did not finish in time instead of calling it refused.
