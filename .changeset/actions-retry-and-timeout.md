---
"scenescout": patch
---

The `/scenescout qa` actions no longer repeat a write that may already have landed: each comment carries a hidden key of its own, and is sent again only after a pause and a lookup that finds no comment with that key (so an identical reply an earlier command posted never stands in for it), a new image branch is created again only when a lookup finds no branch, and a reaction, blob, tree, commit or update of an existing branch (which repeat harmlessly) is retried as before. A GET is still retried on a server error. The check and ci actions now stop an `npm` call that takes longer than ten minutes and fail with an error annotation naming the call and the limit, instead of waiting for the job's own limit.
