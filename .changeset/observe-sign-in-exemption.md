---
"scenescout": patch
---

`observe` no longer lets out writes that only look like signing in. `refresh`, `token`, `session`, `callback` and `authorize` count as sign-in only on an auth path (`/api/auth/refresh`, `/oauth/token`), so `POST /api/reports/refresh`, `/api/devices/4/refresh`, `/api/users/7/token`, `/api/carts/9/session`, `/api/payments/callback` and `/api/integrations/slack/authorize` are refused. An auth path that belongs to a record (`/api/devices/7/auth/refresh`) or links an integration (`/api/stripe-connect/callback`) is refused too. Sign-in steps spelled `/users/sign_in`, `/api/v1/authn` and `/u/login/password` now go out in `observe`. New and off by default: `SCENESCOUT_AUTH_POSTS` lists the only POSTs that count as signing in, replacing the path rule.
