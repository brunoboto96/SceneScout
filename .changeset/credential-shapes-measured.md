---
"scenescout": patch
---

Text a run keeps is now cleared of more credential shapes: the rest of an `sk-proj-…` key after an underscore or a hyphen (only its first part was removed), GitHub fine-grained tokens (`github_pat_…`), Slack app tokens (`xapp-…`), webhook signing secrets (`whsec_…`), SendGrid keys (`SG.….…`), Hugging Face tokens (`hf_…`), Basic credentials whose base64 holds no digit, a value after `api key` with a space, a value set against a name such as `aws_secret_access_key`, `signing_key`, `private_key` or `credentials`, OpenAI service-account and admin keys (`sk-svcacct-…`, `sk-admin-…`) and AWS temporary access key ids (`ASIA…`). Class names and ids joined after a key's marker (`sk-test-results-page`) and fetch's `credentials: 'include'` are left as they were. The guided choices' credential check now refuses "sign in as sam.lee with …": a dot inside a user name ended the phrase it reads. The measured miss and false-alarm rates of these shapes are published in the Safety model guide.

A project's kept findings and session logs are cleaned again with this redaction the first time a newer engine opens them.
