---
"scenescout": minor
---

`scenescout ci --provider bedrock|vertex|azure` calls a model through Amazon Bedrock, Google Vertex AI or Azure OpenAI directly, with the credential and address read from the environment and no gateway. A cloud is chosen only by naming it, needs `--model`, and its credential is redacted like the other keys.
