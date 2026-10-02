# Safety model

An agent that clicks around an app will, sooner or later, click Delete. SceneScout does not rely on the agent's judgement to prevent that: every request the page sends is checked on the network against the session's write mode, and a request the mode refuses never reaches the server. Why it is enforced there and not in the prompt: [ADR 2](../adr/0002-enforce-the-write-policy-at-the-network-layer.md).

Only test apps you own or are authorised to test.

## The four modes

| Mode | How to ask for it | What leaves the page |
|---|---|---|
| `observe` | `--observe`, `scout_attach {mode: "observe"}` | `GET` requests only, plus what a session needs to exist: signing in, signing out and refreshing a token. Signing up, changing or resetting a password and creating users are refused like any other write |
| `read-only` (default) | nothing | Ordinary form submissions (a plain `POST`) go through. `PUT`, `PATCH`, `DELETE`, destructive-looking `POST`s and clicks on destructive-labelled controls (delete, revoke, archive and the like) are refused |
| `safe-write` | `--safe-write` | Anything that creates. Changes and deletes only on records this run created, never on data that was there before |
| `destructive` | `--allow-destructive` | Everything |

`read-only` means nothing existing is changed or removed; it does not mean nothing is ever created. A contact form, a comment or a sign-up submitted in `read-only` reaches the server and can create a record. That is why the method picks `observe` for a remote URL with no source in front of it, where the data is more likely to be real, and moves to `read-only` only when you say form submissions are acceptable there.

`destructive` is for a disposable, seeded environment. The agent never chooses it on its own; it needs you to say so. `scenescout ci` needs two options together (`--mode destructive --allow-destructive`) so that a mode value copied from another workflow cannot turn it on.

`scenescout check` accepts only `observe` and `read-only`, and replays saved flows under observe's rule unless `--flow-writes allow` is given. A first look (`scenescout <url>`) is often pointed at a live app, so it runs in `observe` unless `--mode read-only` is given, and accepts no other mode.

## What a refusal looks like

A refused request is logged as `🛡 WRITE-POLICY blocked` in the tool result. That is the safety net working, not a defect in the app, and it is not filed as one: the errors it causes are counted separately in the report's summary.

The server never sees a refused request, but the page's own `fetch` or XHR is answered with a `403` in the server's place rather than dropped. The page's handling of a refusal then really runs, which is useful: a page that shows an error is behaving correctly, and a page that claims "Saved" is lying to its user. That second case is reported as `false_success`, a high finding ([ADR 9](../adr/0009-a-refused-write-is-answered-not-dropped.md)).

`scout_request`, which calls the app's API directly as the session, meets the same policy. A refused call returns `REFUSED by the write policy` instead of a status, because the server was never asked and the result proves nothing either way. Whatever a `scout_request` call meets, its answer is in that tool's result and nowhere else: a probe the server refuses is not reported as an `http_error` or `console_error` of the page the session visits next.

## How `safe-write` knows what the run created

The engine records the identifiers of records created in this server process, from the responses to create requests. A later `PUT`, `PATCH` or `DELETE` is allowed only when its path names one of them. When it is unsure whether an identifier is the run's, the answer is no and the write is refused, and records in user or account collections are never claimed. Every session on the project shares that record, so a record the clerk's session created can be approved or deleted by the manager's session. The record lasts until the server process exits.

## Things the policy does not see

- **WebSocket messages.** Only HTTP is inspected. The engine says so when the app opens a socket.
- **Service workers outside Chromium.** The policy intercepts requests, and only Chromium lets a request a service worker sends be intercepted, so Firefox and WebKit are not allowed to register service workers.
- **Shared workers.** A request a shared worker sends cannot be intercepted in any browser, so pages get no shared workers unless the mode is `destructive`, and the app does that work on the page instead.

## Embedded third-party frames

An app often embeds someone else's system: a payment form, a chat widget, a map, a video. SceneScout lists controls inside frames with the page's own, each marked `⟨in … frame⟩`, and treats them by origin:

- **A frame of the app's own origin is the app** and is tested fully.
- **A frame of another origin is not yours to test.** The agent may click and type there as a user would, to see the embed render and respond, but the engine refuses hostile input there: markup, values over 200 characters, control characters, repeated-click probes and uploads. Writes the frame sends outside the app are refused in every mode but `destructive`. Its text is masked, its controls are counted apart and never enter coverage or the gap ledger, and a failing request it sent is reported as the embed's (`in an embed of …`) at medium, not as the app's.

When you want the embed exercised, for example a payment provider in test mode, name its origin: `scout_attach {trustedEmbeds: ["https://checkout.example-pay.test"]}`. In `safe-write` only, that origin's writes then go out. The agent must not add an origin you did not name.

Frames that were not read are listed on a `FRAMES` line, and the summary should say their contents were not explored.

## What is written to disk

- Everything a run keeps is in `.scenescout/` in the project: memory, findings, notes, reports, saved logins. That folder writes its own `.gitignore`, so `git add -A` does not commit it. The one exception is `flows/*.json`, which are meant to be committed.
- Saved logins are owner-only files, and their values are never printed.
- The live view writes nothing to disk ([ADR 7](../adr/0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md)). A recorded run does, which is why recording must be asked for ([ADR 8](../adr/0008-a-recorded-run-is-evidence-and-must-be-asked-for.md)).
- `scout_upload` generates its file in memory. A `filePath` you give it is fenced to the project under test by its real path.

## Keys and forks in CI

- **`scenescout check` needs no key and no secret.** It can run on every pull request, forks included.
- **`scenescout ci` reads the model key from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and nowhere else.** There is no option or action input for it. The browser and the MCP server run in a child process started without the key, and every line the run prints or writes is passed through a redaction of the key values and of anything shaped like a provider key.
- **A fork's pull request gets no secrets under `pull_request`**, so `scenescout ci` exits 2 there for want of a key. Do not work around that with `pull_request_target` or `workflow_run` while checking out and starting the fork's app: the fork's code would run beside the key, and its pages would be the text the model reads.
- **`/scenescout qa` keeps the key away from pull-request code by construction.** The job that holds the key checks out nothing, builds nothing and runs SceneScout from an exact release tag against an already-deployed preview. The team-membership token reaches only the gate job. Forks are refused unless `SCENESCOUT_QA_ALLOW_FORKS` is `true`, and the run stays `read-only` ([ADR 15](../adr/0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md)).
- **Scripted sign-in credentials** follow the rules in [Signing in](Signing-in.md#the-rules-for-ci-credentials).

Found a way past the write policy? Report it privately, as [SECURITY.md](../../SECURITY.md) describes.
