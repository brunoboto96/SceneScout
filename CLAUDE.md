# SceneScout — contributor notes

## Why it is built this way

Decisions with a cost behind them are recorded as ADRs in [docs/adr/](docs/adr/) —
read the relevant one before changing a rule it covers, and add a record when you
make a decision a future change would otherwise undo blindly.

## Stay project-agnostic

> Recorded as [ADR 6](docs/adr/0006-stay-project-agnostic.md). Grep before committing: this drift is invisible in review because the words are ordinary.

SceneScout is a **generic** exploratory-testing engine used against arbitrary web apps. Nothing in `src/`, `scripts/`, or `test-app/` may name, assume, or be tuned for a specific project under test.

- No project names, company names, or product names in code, comments, commit messages, or fixtures (not the app you tested, not its vendor, not its ticket ids — if a reader could tell which app inspired a line, rewrite the line).
- No project-specific route shapes, field names, or backend class names as anything other than genuinely illustrative examples — and even then, prefer made-up placeholders (`widget_id`, `/api/things/...`, `OrderService`) over a real tested app's actual naming, so the example reads as "REST APIs commonly do X" rather than "this one app does X".
- Regression fixtures in `test-app/` and `scripts/smoke/` should describe the *general shape* of a bug (e.g. "a create response naming its own id after the resource") rather than citing where it was found.
- If a real bug from testing some app inspires a fix, the fix and its test belong here in general form; the specifics of that app belong in that app's own bug tracker, not in this repo.

## Before committing

- `npm run format && npm test` must pass (`test` builds first). The pure-logic suites import `src/` directly, so `npm run <suite>` tests your edit with no build; `smoke` and `mcp-check` need the compiled engine and rebuild on their own. `test` chains twelve suites: scan-test, oracle-test, policy-test, fixture-test, dispatch-test, design-test, contract-test, memory-test, install-test, hygiene-test, smoke, mcp-check.
- Bug fixes need a regression test. Prefer the cheapest layer that can actually fail: pure logic goes in the matching `*-test.ts` (`policy-test` for the write policy, safe-write ownership and the auth-loss tracker, `fixture-test` for synthetic upload files, accept-attribute logic and the disk-upload fence, `dispatch-test` for the per-session queue, the watchdog and orphan-browser selection, `contract-test` for route identity and the gap ledger, `design-test` for the audit and journey measurement, `memory-test` for storage and finding dedup, `install-test` for the setup/doctor logic in `installer.ts`, `hygiene-test` for what may never be tracked: run output, saved logins, real email addresses, home-directory paths, credentials), and anything needing a real browser goes in the matching suite under `scripts/smoke/` backed by a fixture in `test-app/`. Each smoke suite must take its own fresh snapshot rather than reuse refs from another suite — they run independently, so a crash in one does not hide the rest.
- Keep logic that does not need Playwright OUT of `browser.ts` — it is the one file a test cannot reach without launching a browser. `fingerprint.ts` (route/element identity), `policy.ts`, `ownership.ts`, `uploads.ts`, `journey.ts`, `reaper.ts`, `dispatch.ts`, `fixtures.ts`, `authloss.ts` and `collector.ts` all exist because a rule living there can be table-tested; a rule living in `browser.ts` can only be smoke-tested.
- Write the test so it FAILS against the old behaviour — revert the fix, watch it go red, put the fix back. A test that passes either way documents nothing.
- Releases are driven by Changesets: a user-visible change carries a changeset (`npx changeset`), and nobody edits the version or `CHANGELOG.md` by hand — the release workflow generates both. The commit style `vX.Y.Z: <summary>` is retired; describe the change instead.

## Pinned dependencies

- **typescript stays on 5.x.** TypeScript 7 was tried and reverted: it breaks this project's module resolution (`Cannot find name 'node:fs'` and cascading implicit-any errors). The caret range `^5.9.3` prevents an accidental jump, but `npm install typescript@latest` would still do it — re-test the build before changing that line.
- **zod stays on 3.x.** `@modelcontextprotocol/sdk` builds its tool schemas against zod v3's API; v4 is a breaking change for that surface.
