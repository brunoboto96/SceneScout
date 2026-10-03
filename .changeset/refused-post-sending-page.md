---
"scenescout": patch
---

The gap ledger's list of pages whose POST observe refused now names the page that sent the POST. A page whose script posted as it loaded could be listed as the page the session came from, because the browser had not yet reported the new page; the request's Referer now decides, with the session's page as the fallback.
