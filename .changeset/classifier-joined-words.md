---
"scenescout": minor
---

The standard write classifier reads a request's path as words: it splits each segment on camelCase, PascalCase, underscores, dashes, dots and where letters meet digits before looking for a destructive verb. `read-only` (and `observe`'s check of a named read POST or sign-in) now refuses more: `POST /api/items/deleteAll`, `/bulkDelete`, `/removeAll`, `/purgeCache`, `/UserService.DeleteUser` and `/delete2` are destructive, as `/delete-all` already was. Matching stays whole-word, so read endpoints named with another form of the verb (`/deletedAtFilter`, `/removedItems`, `/bulkDeletionStatus`, `/archives`) still go out. A verb followed by `requests` or `reasons` in the same segment (`/delete-requests`, `/deleteReasons`) is now read as a noun phrase, as the strict classifier reads it, and goes out where it was refused before. The strict classifier also splits where letters meet digits. `scenescout policy explain` gives the same verdicts.
