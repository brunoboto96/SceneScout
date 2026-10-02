# Recipes by project type

Each recipe describes an invented app of a common shape, the setup it needs, the commands, what a run usually turns up and the pitfalls. Names, routes and hosts are placeholders; replace them with yours.

- [A server-rendered app](#a-server-rendered-app)
- [A single-page app with its token in storage](#a-single-page-app-with-its-token-in-storage)
- [An app behind SSO](#an-app-behind-sso)
- [An app with embedded third-party widgets](#an-app-with-embedded-third-party-widgets)
- [An API-heavy dashboard](#an-api-heavy-dashboard)
- [A static marketing site](#a-static-marketing-site)
- [A monorepo with preview deployments](#a-monorepo-with-preview-deployments)

## A server-rendered app

*A bookings app rendered on the server (templates, a session cookie, forms that post and redirect), running locally on port 8000.*

**Setup.** Start the app with seeded development data. Save a login for each role that sees a different app:

```bash
scenescout login http://127.0.0.1:8000/login --role staff
scenescout login http://127.0.0.1:8000/login --role customer
```

**Run.**

```text
/scenescout --level medium --url http://127.0.0.1:8000 --role staff
```

For a two-role pass: "Test as staff and customer; the customer books a slot and staff confirms it."

**What to expect.** `scout_scan` finds no client-side router, so routes come from links; the first crawl, and a second one after the main pages are snapshotted, build the route list. Forms post and redirect, so `read-only` lets the agent submit them valid and invalid and judge the validation messages. Typical findings: a form that loses what was typed after a validation error, a 500 on an unusual filter value, a page that is reachable only by typing its URL, a delete link that is a plain `GET`.

**Pitfalls.**

- A destructive action implemented as a `GET` link (`/bookings/12/delete`) is refused as a click when its label looks destructive, but every `GET` passes the network rule, so opening that URL directly is not refused. Run such apps against disposable data, and report the `GET` as a finding.
- A CSRF token that expires with the page makes a form submitted after a long pause fail. That can be a real finding, or the run being slow; check the timing before filing.
- Pages reached only through a form post are invisible to the crawl. Ask the agent to walk those flows as journeys.

## A single-page app with its token in storage

*A notes app built with a client-side router, calling `/api/…` with a bearer token that its sign-in library keeps in `localStorage` or `sessionStorage`.*

**Setup.** Run the agent from the app's repository so the scan reads the router configuration. Save the login with SceneScout 3.14 or later, which keeps `sessionStorage` and IndexedDB as well as cookies and `localStorage`:

```bash
npm run dev                                   # the app, on port 5173
scenescout login http://localhost:5173/signin --role member
```

**Run.**

```text
/scenescout --level medium --url http://localhost:5173 --role member
```

**What to expect.** Routes come from the source (React Router, Vue Router, Angular or file-based routing), so coverage is measured against the app's real pages, and a route no link reaches is still visited. After each action the engine waits on the requests that action fired, not a fixed sleep. Typical findings: an empty state shown after a refused list request (`refused_empty`), a success toast after a refused save (`false_success`), a double-click that creates two notes, a control hidden from a role whose endpoint still answers 200, markup typed into a field that renders as an element on another page (`dom_injection`), a token posted with `postMessage` to any origin (`postmessage_token`).

**Pitfalls.**

- A login saved by an older version has no `sessionStorage`; if sessions come back signed out, record it again.
- An app that rotates refresh tokens and revokes on reuse needs sessions attached by `role`, not by `storageStatePath`: only role sessions go through the [refresh broker](Signing-in.md#sessions-that-share-a-refresh-token).
- Routes built at runtime (from an API response) are not in the source; they are found by following links.

## An app behind SSO

*An internal admin console that signs in through an identity provider with a second factor.*

**Setup.** Sign in yourself, once per role. The window is a real browser, so the provider's pages, redirects and second factor work as usual:

```bash
scenescout login https://admin.staging.example.com --role operator
```

The command prints how long the saved login will last. Record it again when it runs out.

**Run.**

```text
/scenescout --url https://admin.staging.example.com --role operator
```

**In CI.** Use a test user on a test tenant whose second factor is an authenticator-app secret, and `scenescout login … --script` with `SCENESCOUT_LOGIN_TOTP_SECRET` ([Signing in from CI](Signing-in.md#signing-in-from-ci)). For an app that emails or texts a code, passwordless or as a second factor, set the fixed code its test environment accepts as `SCENESCOUT_LOGIN_OTP_CODE` ([A passwordless sign-in](Signing-in.md#a-passwordless-sign-in)). If the provider uses push factors, a code that cannot be fixed, or a CAPTCHA, use a test-only sign-in endpoint or a saved session as a secret instead.

**What to expect.** A session that expires mid-run raises `SESSION AUTH LOST`, and a role session re-attaches once from the role's latest saved profile, so running `scenescout login` again lets it carry on. Routes that bounced to the sign-in page are recorded as not covered.

**Pitfalls.**

- Cookies set on the identity provider's host are part of the profile. The lane-brief expiry check treats credentials for another host as a reason not to refuse, since it cannot be sure which one matters.
- Signing out in one session can end the server-side session every session of that role was restored from. Test sign-out in a session of its own, and expect to record the login again after it.
- A staging environment behind SSO often holds real colleagues' data. Consider `observe` mode until you know it is disposable.

## An app with embedded third-party widgets

*A shop whose checkout page embeds a payment provider's card form in an iframe, and whose pages carry a support-chat widget.*

**Setup.** Nothing special for a first run. To exercise the payment form against the provider's test mode, name its origin and use `safe-write`:

```text
Use SceneScout to test http://localhost:3000 in safe-write mode. The payment frame at https://pay.example-provider.test is a trusted embed in test mode.
```

That becomes `scout_attach {mode: "safe-write", trustedEmbeds: ["https://pay.example-provider.test"]}`.

**What to expect.** Controls inside frames are listed with the page's, marked `⟨in … frame⟩`. Frames of other origins are exercised as a user would (to see them render and respond) but never sent hostile input, and their failures are reported as the embed's, at medium, naming its origin. The chat widget's console noise stays attributed to the page, because console errors cannot be told apart by frame. Typical findings: an embed that covers a control on small viewports, a checkout that shows success before the provider answered, a widget that traps keyboard focus.

**Pitfalls.**

- Without `trustedEmbeds`, writes the frame sends outside the app are refused in every mode but `destructive`, so a payment cannot complete. That is intended.
- Name only an origin you control or have a test account with. The agent must not add one you did not name.
- `scenescout check` reports an embed's failing requests with the embed named, so a flaky third-party widget does not read as your page's server error. Use `--ignore` for a rule only if the noise is persistent and understood.

## An API-heavy dashboard

*An analytics dashboard: one page, a dozen widgets, each calling its own endpoint, with filters in the URL.*

**Setup.** Run next to the code so the agent can read which endpoint each widget calls. Save a login for each role with different data access:

```bash
scenescout login http://localhost:3000/login --role analyst
scenescout login http://localhost:3000/login --role viewer
```

**Run.**

```text
/scenescout --level medium --url http://localhost:3000 --role analyst
Then compare with the viewer role: which widgets and endpoints does each see?
```

**What to expect.** Every tool result lists the failed requests, so a widget whose endpoint answers 500 on one filter shows up without anyone reading the network tab. The method checks a list's request status before calling it empty, so an empty widget after a 403 is filed as `refused_empty`. `scout_request` calls endpoints directly as each role, turning "the viewer does not see the revenue widget" into "`GET /api/metrics/revenue` answers 200 as viewer". Typical findings: a filter combination that fails, stale numbers after changing the date range, a widget whose error state is an empty chart, a role reading data the UI hides from it.

**In CI.** Save the flows that matter with `expect-request` steps, so the gate fails when an endpoint's status changes:

```json
{
  "name": "revenue widget loads",
  "steps": [
    { "action": "navigate", "target": "/dashboard?range=30d" },
    { "action": "expect-request", "request": "GET /api/metrics/*", "status": "2xx" },
    { "action": "expect-text", "text": "Revenue" }
  ]
}
```

**Pitfalls.**

- A dashboard that polls on a timer keeps sending requests. Under `--flow-writes never`, a telemetry `POST` or heartbeat that lands during a flow step is charged to that step and marks the flow "could not run". Point such telemetry elsewhere in the test environment, or use `--flow-writes allow`.
- Charts drawn on a canvas have no elements to read. The agent screenshots them only for pixel-level problems.
- A slow widget on a loaded CI runner can exceed the 20 s page-load limit. Raise `--nav-timeout-ms` for the machine, never to hide a page that is really that slow.

## A static marketing site

*A marketing site of a few dozen pages, built by a static-site generator and deployed to `https://www.example.com`, with a newsletter form.*

**Setup.** No login, no source needed. Run from an empty folder, which becomes the home of `.scenescout/`:

```bash
mkdir site-qa && cd site-qa
```

**Run.**

```text
Use SceneScout to test https://www.example.com at minimal level, observe mode
```

For a gate on every deploy, `scenescout check` is usually the better fit, and needs no model:

```bash
npx -y scenescout check https://www.example.com --mode observe --max-routes 150
```

**What to expect.** Routes come from links. `observe` mode lets nothing but `GET` requests out, so the newsletter form is filled but never submitted, and the gap ledger says so. Typical findings: broken images, contrast failures, headings out of order, unnamed icon links, a page that scrolls sideways on a phone viewport, dead ends with no navigation. Under "Worth a look" the check may list links styled like body text or spacing off a 4px grid; those count only if your site uses that convention.

**Pitfalls.**

- Pages that nothing links to, and pages on another subdomain, stay unknown. Pass them with `--paths`, or ask the agent to navigate to them.
- `--max-routes` defaults to 50 and stops at 150. A larger site needs several checks with `--paths`.
- Submitting the newsletter form in `read-only` would add a real subscriber. Keep `observe` unless the form points at a test list.

## A monorepo with preview deployments

*A repository with `apps/web` (the product), `apps/admin` and `packages/ui`, where every pull request is deployed to `https://pr-<number>.preview.example.com`.*

**Setup.** `scout_scan` looks for frontend workspaces up to two levels deep and picks the one with the most routes, naming the others. To test another one, run the agent in that workspace, or ask it to scan that path. Keep `.scenescout/` (and the saved flows in it) in the app's own folder by running from there.

**Run, locally.**

```text
/scenescout --url http://localhost:3000        # from apps/web
```

**In CI, as a gate on the preview.** Once the preview is deployed, check it. `working-directory` points the action at the app whose flows and memory to use:

```yaml
      - uses: brunoboto96/SceneScout@v3
        with:
          url: https://pr-${{ github.event.pull_request.number }}.preview.example.com
          working-directory: apps/web
          mode: observe
```

**On demand, with a model.** Add the [`/scenescout qa` workflow](Ways-to-use-it.md#scenescout-qa-on-a-pull-request) and set the repository variable `SCENESCOUT_QA_PREVIEW_URL` to `https://pr-{pr}.preview.example.com`. Reviewers then comment `/scenescout qa checkout` for a focused run, or `/scenescout qa compare the order summary` for a before-and-after picture against production (`SCENESCOUT_QA_BASE_URL`).

**What to expect.** The preview is tested as a black box: the `qa` job checks out nothing, so findings name symptoms and repro steps, not files. The check on the preview reports the same rules as locally, and re-tests open findings when the project's memory is available in the job.

**Pitfalls.**

- The preview must be reachable over https with no credentials in the URL. A preview behind an access gate needs a storage state for `scenescout check`; `/scenescout qa` explores signed out.
- The check's job must wait for the deployment, not just for the build. Trigger it from the deployment status, or poll the preview URL before the check step.
- Two apps with one `.scenescout/` at the repository root share memory, and one app's findings then appear in the other's re-tests. Give each app its own.
