# Contributing to SceneScout

Thanks for looking. Read [VISION.md](VISION.md) first — it says what is in
scope, and it will save you from building something that cannot be merged.

## What to open

| You have | Do this |
|---|---|
| A bug, a crash, a false finding, noise in a report | Open an issue, or go straight to a pull request if the fix is small |
| A new feature, a new tool, a behaviour change | **Open an issue first** and wait for a yes. Most feature ideas are declined or reshaped; an issue costs you minutes, an unmergeable pull request costs you days |
| A security problem | **Not a public issue.** See [SECURITY.md](SECURITY.md) |
| A question about using it | Open an issue with the `question` label |

## Nothing from a real app, and nothing personal

SceneScout is built by pointing it at real applications, and this repository is
public. Before you commit, make sure none of this is in your change — in code,
tests, fixtures, docs, screenshots, commit messages or the pull request text:

- **The app you tested:** its name, its company, its URLs or hostnames, its
  route names, record ids, ticket numbers, or text copied from its pages.
- **People:** names, email addresses, usernames. Use `someone@example.com`.
- **Your machine:** paths into your home directory. Write `<project>` or a
  `/home/u/` placeholder.
- **Run output:** `.scenescout/` folders, `report.md` files from a real run,
  Playwright storage-state files (they hold live session cookies), `.env`
  files, tokens, keys.
- **Screenshots** of anything but the bundled demo app or the fixtures.

`npm run hygiene-test` (part of `npm test`) scans every tracked file for the
mechanical part of this list: forbidden paths, email addresses off the reserved
example domains, home-directory paths and credential shapes. It cannot know
that an ordinary word is somebody's product name — that part is on you and on
review ([ADR 6](docs/adr/0006-stay-project-agnostic.md)).

If you find you have already pushed something from this list, say so in the
pull request rather than quietly amending: a pushed secret is compromised and
has to be rotated, and the maintainer may need to purge it from the fork
network.

## Opening a pull request

1. For anything beyond a small fix, open an issue first and wait for a yes (see
   the table above).
2. Fork, and branch from `main`. One topic per branch.
3. Make the change, with its test. `npm run format`, then `npm test`.
4. Add a changeset if users will notice the change: `npx changeset`.
5. Open the pull request against `main` and fill in the template. Keep "Allow
   edits by maintainers" on.
6. CI runs on Linux, macOS and Windows. The first run from a new contributor
   waits for the maintainer to approve it; that is a GitHub safety setting, not
   a judgement on your change.
7. The maintainer reviews. Expect questions about scope before questions about
   code. Push follow-up commits rather than force-pushing, so the review can
   see what changed; the pull request is squashed on merge.

## Pull requests

- **One topic per pull request.** Unrelated fixes bundled together will be
  asked to split.
- **A bug fix needs a regression test** at the cheapest layer that can fail,
  and the test must fail without the fix. Which suite covers what is listed in
  [CLAUDE.md](CLAUDE.md).
- **`npm test` must pass.** CI runs it on Linux and macOS, and the unit suites
  on Windows. While iterating, run one suite: `npm run policy-test` tests your
  edit directly from `src/`, no build step. The two real-browser suites
  (`npm run smoke`, `npm run mcp-check`) rebuild first on their own.
- **`npm run format`** before you push. CI checks it, so style never has to be
  discussed in review.
- **Stay project-agnostic.** No real application, company, or product names in
  code, tests, fixtures, comments or commit messages — use invented
  placeholders (`/orders`, `widget_id`). Grep before you push; this drift is
  invisible in review because the words are ordinary.
- **Say what problem it solves** and show evidence it works: test output, a
  before/after, a repro.
- **Add a changeset** when the change affects what users get: `npx changeset`,
  pick `patch`, `minor` or `major`, and write one or two sentences for the
  changelog. Docs-only, test-only and CI-only changes do not need one. See
  [.changeset/README.md](.changeset/README.md).
- **Do not edit the version or `CHANGELOG.md` by hand.** They are generated
  from the changesets when the maintainer releases.
- Keep "Allow edits by maintainers" enabled so a nearly-there pull request can
  be finished rather than closed.

AI-assisted pull requests are welcome and held to the same bar. You are
expected to understand what the code does and to have run it.

## How merging works

`main` is protected. Every pull request needs passing CI and the maintainer's
approval, and only the maintainer can merge or publish a release. Review may
take a while; a pull request that is small, tested and in scope is reviewed
first.

## Local setup

```bash
git clone https://github.com/brunoboto96/SceneScout.git scenescout && cd scenescout
npm install
npx playwright install chromium
npm test
```

## License

By contributing you agree that your contribution is licensed under the
project's [MIT license](LICENSE).
