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

## Pull requests

- **One topic per pull request.** Unrelated fixes bundled together will be
  asked to split.
- **A bug fix needs a regression test** at the cheapest layer that can fail,
  and the test must fail without the fix. Which suite covers what is listed in
  [CLAUDE.md](CLAUDE.md).
- **`npm run build && npm test` must pass.** CI runs the same thing.
- **Stay project-agnostic.** No real application, company, or product names in
  code, tests, fixtures, comments or commit messages — use invented
  placeholders (`/orders`, `widget_id`). Grep before you push; this drift is
  invisible in review because the words are ordinary.
- **Say what problem it solves** and show evidence it works: test output, a
  before/after, a repro.
- **Do not bump the version or edit release notes.** The maintainer does that
  when releasing.
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
