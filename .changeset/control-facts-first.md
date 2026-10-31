---
"scenescout": minor
---

In `observe` and `read-only`, a control is judged by what its markup says a click sends before its label: a submit button whose form posts to one or names `DELETE` in a `_method` field, or an element a script library is told to send a `DELETE` from (`hx-delete`), is refused whatever it says (a link or a `GET` form whose address is a command too, when destructive page loads are refused), while a link that only loads a page, a form that only `GET`s an address it names, and a reset button are allowed whatever they say. An Enter in a form's field is judged the same way, for `scout_type`, `scout_press`, plan steps and a check's replay. With destructive page loads refused, `scout_back` to a history entry at a command address is refused before anything loads.
