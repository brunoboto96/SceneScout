---
"scenescout": minor
---

`SCENESCOUT_DEDUP_BASE_URL` sends the MCP server's dedup judge to a private endpoint that speaks the OpenAI or Anthropic API, instead of the provider's own. It is held to the rules of `scenescout ci --base-url`: https (plain http only to `127.0.0.1` or `localhost`), no credentials in the URL, redirects never followed. A value that breaks a rule stops the judge's setup with a message that names the variable and does not repeat the value. The dedup summary line names the endpoint's host.
