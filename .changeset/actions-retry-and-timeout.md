---
"scenescout": patch
---

The `/scenescout qa` actions no longer repeat a write that may already have landed: a comment is sent again only after a lookup shows no comment with that text was made since the call began, and a reaction, blob, tree, commit or branch update (which repeat harmlessly) is retried as before. A GET is still retried on a server error. The check and ci actions now stop an `npm` call that takes longer than ten minutes and fail with an error annotation naming the call and the limit, instead of waiting for the job's own limit.
