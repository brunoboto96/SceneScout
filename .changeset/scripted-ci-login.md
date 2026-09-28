---
"scenescout": minor
---

Add `scenescout login <url> --role <name> --script`, a sign-in for CI with no one at the keyboard. It runs headless, fills the sign-in form from `SCENESCOUT_LOGIN_USERNAME` and `SCENESCOUT_LOGIN_PASSWORD`, types an RFC 6238 code from `SCENESCOUT_LOGIN_TOTP_SECRET` when the form asks for one, follows forms that ask for the password after "Next", and saves the session as the role's profile, as the manual login does. Fields are found by autocomplete, type and label, with CSS selectors as a fallback, and success by leaving the sign-in fields behind or by a configured URL or selector. Missing configuration is reported before a browser starts, a refused sign-in exits 1, and no credential value appears in anything it prints, even when the page echoes it. The CI docs gain a section on signing in: the options (a test tenant's user, a test-only endpoint, a saved session as a secret) and the rules for the credentials.
