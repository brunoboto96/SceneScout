---
"scenescout": minor
---

A new oracle, `postmessage_token`, reports a page that calls `postMessage` with targetOrigin `"*"` on a message carrying a token: a JWT, a `Bearer` value, or an opaque value under a key such as `access_token`, including inside a JSON string. Any origin the receiving window holds can read such a message. The finding names the path inside the message, the shape and the token's first four characters and length, never the token. It is filed at high severity, and `scenescout check` reports it under the new `postmessage-token` rule, which fails the default gate.
