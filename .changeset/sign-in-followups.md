---
"scenescout": patch
---

Sign-in pages are recognised in any case (`/Account/Login`, `/#/Login`, `/SignIn`), still by whole segment, so `/Account/LoginHistory` is not one. A crawled route that goes to a single sign-on provider's sign-in on another origin is marked `AUTH-REDIRECT` and not covered, and a page on another site is no longer kept as a page of the app. The action log, the memory and the report keep another site's address by its origin and path only, so a provider's sign-in state never lands in them.
