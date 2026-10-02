# Signing in

Most apps worth testing are behind a sign-in. SceneScout never types your password: you sign in once yourself, in a real browser, and every session reuses that login. In CI, where nobody can type, a scripted sign-in does the same with a test user.

## Save a login per role

```bash
scenescout login http://localhost:3000 --role admin
```

A visible browser opens at the URL. Sign in however the app asks (a password, SSO, a second factor), then come back to the terminal and press **Enter**. The session is saved as `.scenescout/auth/admin.json` in the project. Closing the window or pressing Ctrl+C saves nothing.

- `--project <dir>` saves into another project's `.scenescout/`.
- `--browser firefox` or `webkit` records in that browser.
- The file is readable by your account only, and `.scenescout/` keeps itself out of git.
- The command prints where it saved, how many cookies, origins and databases the profile holds, and how long it will last. It never prints the values.

Then ask the agent to test as that role (`/scenescout --role admin`, or `scout_attach {role: "admin"}`). A role with no saved login is refused with the command to run. Record one login per role you want to compare:

```bash
scenescout login http://localhost:3000/signin --role viewer
scenescout login http://localhost:3000/signin --role editor
```

### Or pass a Playwright storage state

If your project already produces Playwright storage states (for example an auth setup project writing `playwright/.auth/*.json`), `scout_scan` finds them and the agent can attach with `storageStatePath` instead of `role`. Pass one or the other, never both. SceneScout reads the file; regenerating it when it expires is your Playwright setup's job.

## What a profile holds

A profile saved by `scenescout login` keeps cookies, `localStorage`, IndexedDB and `sessionStorage`, so an app whose sign-in library keeps its token in `sessionStorage` or IndexedDB comes back signed in. `sessionStorage` is put back only on the origin it came from, once per tab, so a session that signs out stays signed out.

A login saved by a version before 3.14 has no `sessionStorage` or IndexedDB in it: record it again if your app keeps its token there.

## How long a login lasts

`scenescout login` reads each cookie's expiry and the `exp` claim of any JWT in a cookie or in `localStorage`, and prints the lifetime. The JWT is decoded for that one claim; it is never verified or printed.

When the agent attaches with an expired login, the attach reports `⚠ AUTH FAILED` and the agent stops rather than testing the sign-in page. Mid-run, repeated bounces to the sign-in page raise `⚠ SESSION AUTH LOST`, and routes reached that way are recorded as not covered, so a dead session cannot certify pages it never saw.

Before a parallel run, `scout_lane_brief` checks that the planner's saved login will outlast the run: `runMinutes` (default 60) plus `expiryMarginMinutes` (default 10). It refuses only when it is sure: every credential in the profile has a date, none belongs to another host, and the last of them ends before the run does. It then names the `scenescout login` command to run again. Cookies that are not the sign-in (analytics, preferences) often expire first, so the first expiry is a warning rather than a reason to refuse, and undated credentials make the lifetime a warning that it is unknown.

## Re-attach

A session attached by role that loses its sign-in first re-attaches once from the role's latest saved profile and carries on. So when a login expires mid-run, running `scenescout login … --role admin` again in another terminal is enough for the sessions of that role to pick it up.

## Sessions that share a refresh token

Every session of one role starts from one saved login, so they share its refresh token. An app that rotates refresh tokens and treats a second use of a spent one as theft would revoke the whole token family, and sign every session out, the moment two sessions refreshed with the same token.

The refresh broker prevents that for sessions attached by role. When a page is about to send a refresh token from the role's profile, the session takes a lock beside the profile (`.scenescout/auth/<role>.json.lock`, owner-only, taken over if its holder has not touched it in 30 seconds) and re-reads the profile. If another session already rotated the token, it loads that profile and sends the current token instead of the spent one. Once the page has stored the rotated token, the session writes its state back to the profile and releases the lock. Sessions in separate processes share the lock through the file.

A refresh token is recognised by name: a cookie, a storage key, or a field inside a JSON storage value whose name contains `refresh`. It is never printed or logged. An app that renews through the identity provider's own session cookie shares no refresh token and needs none of this. `SCENESCOUT_REFRESH_BROKER=off` in the server's environment turns the broker off.

## Signing in from CI

A CI runner has nobody to type a password. There are three ways to give a job a session:

| Way | How | Trade-off |
|---|---|---|
| A test user on a test tenant (recommended) | `scenescout login <url> --role <name> --script` fills the sign-in form from environment variables, including a one-time code | Tests the real sign-in on every run. Needs a code from an authenticator-app secret you can store, or a fixed code the test environment accepts in place of one it would email, and no CAPTCHA |
| A test-only sign-in endpoint | The app, in test environments only, exposes a route that signs in a named test user; a Playwright step visits it and saves a storage state | Fast and independent of the sign-in page, but it is code that signs anyone in, so every production build must leave it out or refuse it |
| A saved session as a secret | Record a login on your machine, store the file's contents as an encrypted secret, and write it to a file in the job | No credentials in CI, but the secret is a live session: it expires, and anyone who reads it is signed in until it does |

### A scripted sign-in

```bash
SCENESCOUT_LOGIN_USERNAME=… SCENESCOUT_LOGIN_PASSWORD=… SCENESCOUT_LOGIN_TOTP_SECRET=… \
  npx -y scenescout login https://staging.example.com/signin --role member --script \
    --project "$RUNNER_TEMP/scenescout" --success-url /dashboard
```

It runs headless and signs in as a person would. It finds the username, password and one-time-code fields by their `autocomplete`, type and labels, fills what the page shows, and presses the button that moves the form on (Sign in, Next, Continue, Verify, Send code), never one that leads to another provider, a password reset, a new code or another address. A form that asks for the password after "Next", or for the code on a page of its own, is followed step by step. A code split into one box per character is typed one character per box. A button the page enables only once the form is complete is waited for, and a page that takes the code itself once it is complete is not submitted again. The profile is saved exactly as the manual login saves it.

### A passwordless sign-in

Many apps sign in with no password: the email, a button that sends a code, then the code. Leave `SCENESCOUT_LOGIN_PASSWORD` unset and give the code. The test environment of such an app commonly accepts one fixed code for test users, which is `SCENESCOUT_LOGIN_OTP_CODE`:

```bash
SCENESCOUT_LOGIN_USERNAME=… SCENESCOUT_LOGIN_OTP_CODE=… \
  npx -y scenescout login https://staging.example.com/signin --role member --script \
    --project "$RUNNER_TEMP/scenescout" --success-url /dashboard
```

The pause while the app sends the code is never taken for signed in. If the page asks for a password after all, the run stops and names `SCENESCOUT_LOGIN_PASSWORD`.

| Variable | |
|---|---|
| `SCENESCOUT_LOGIN_USERNAME` | Required |
| `SCENESCOUT_LOGIN_PASSWORD` | Required, except for a passwordless sign-in: leave it unset (set but empty is refused) and set one of the two below |
| `SCENESCOUT_LOGIN_TOTP_SECRET` | When the sign-in asks for a code: the base32 secret, or the whole `otpauth://totp/…` URI. Codes follow RFC 6238, so the runner's clock must be right |
| `SCENESCOUT_LOGIN_OTP_CODE` | When the sign-in asks for a code and the test environment accepts a fixed one: 4 to 12 letters or digits. Not with `SCENESCOUT_LOGIN_TOTP_SECRET` |
| `SCENESCOUT_LOGIN_SUCCESS_URL` or `--success-url` | What the URL's path contains once signed in, or an absolute URL it starts with. Recommended: without it, or the selector below, the sign-in counts as done when no credential field is left once the password or code has gone, which an error page also satisfies |
| `SCENESCOUT_LOGIN_SUCCESS_SELECTOR` or `--success-selector` | A CSS selector visible only when signed in |
| `SCENESCOUT_LOGIN_USERNAME_SELECTOR`, `_PASSWORD_SELECTOR`, `_OTP_SELECTOR`, `_SUBMIT_SELECTOR` (or `--username-selector` and so on) | A selector for a field or button the rules above do not find |

`--timeout <seconds>` bounds the whole sign-in (default 60, 5 to 600). Credentials have no flag, because a flag shows in the process list and the shell history. The command exits 0 once signed in and saved and 1 otherwise, and a refused sign-in quotes the page's error message with every credential value, the code included, replaced by `[redacted]`.

Not covered: a sign-in form inside an iframe, a code that is emailed or texted and different every time (the test environment has to accept a fixed one), a sign-in link sent by email, a CAPTCHA, and push second factors. Use a test-only endpoint or a saved session for those.

### The rules for CI credentials

- **A test user on a test tenant, never production and never a real person's account.** Give it the least access the tests need.
- **Credentials come from the CI system's secrets, through the environment.** Never in the workflow file, a flag, a committed `.env` file or a script. Set them on the sign-in step only, so no later step has them.
- **No code from a fork's pull request runs with these secrets.** Under `pull_request_target` or `workflow_run` a fork can receive secrets; never check out and run a fork's code in a job that sets them.
- **The profile stays in the runner's temporary directory and is never uploaded.** `--project "$RUNNER_TEMP/scenescout"` keeps it out of the workspace, so no artifact, cache or `git add` picks it up.

A complete GitHub Actions job is in [signing in from CI](../ci.md#signing-in-from-ci).
