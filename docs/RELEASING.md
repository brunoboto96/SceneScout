# Releasing

Releases are cut by the maintainer. Contributors add changesets; they never
edit the version or `CHANGELOG.md` (see [.changeset/README.md](../.changeset/README.md)).

## The normal flow

1. Pull requests with user-visible changes carry a changeset.
2. On each push to `main`, the `release` workflow collects pending changesets
   into a pull request titled **Version Packages**: version bump,
   `CHANGELOG.md`, and the matching version in `.claude-plugin/plugin.json`
   and `desktop-extension/manifest.json`, and in the copy-paste launch lines
   of the README, the guide and the skill.
3. Approve and merge that pull request. It is opened with the Actions token,
   and GitHub does not run `pull_request` workflows for pull requests opened
   that way, so the release workflow starts the `test` workflow on the version
   branch itself. The checks appear on the pull request once that run starts. Its author is the Actions bot, so the maintainer's
   approval counts as the code-owner review. Its diff is generated and limited
   to the version, the changelog, `plugin.json`, the extension manifest, the
   launch lines named above and the deleted changeset files.
4. The workflow runs again on that merge and finds no pending changesets. Its
   `build` job asks npm whether it has the version in `package.json`. When npm
   does not, it builds the package from a clean `dist` and packs the tarball
   once; the `publish` job, which checks nothing out and runs none of this
   repository's code, sends that tarball to npm with provenance, under
   `latest` (or the prerelease tag while `.changeset/pre.json` exists). Only
   then does the `release` job push the `vX.Y.Z` tag (`changeset git-tag`),
   create the GitHub Release from the version's `CHANGELOG.md` section and
   move the `v3` major tag. A version missing from npm is published by the
   next run on `main` that finds no pending changesets, whatever tags exist. [ADR 27](adr/0027-the-job-that-publishes-to-npm-runs-no-repository-code.md)
   records why.

   **The plugin pins the version, and its marketplace entry tracks `main`.**
   The marketplace entry's source is this repository (`./`), so a plugin
   update reads `main`. The Version Packages merge puts the new pin
   (`scenescout@X.Y.Z`) in `plugin.json` on `main` before `publish` has put
   that version on npm. Until it has, a plugin update starts a server that
   `npx` cannot fetch. The window is the run's length, and a run that fails
   (or a repository with `NPM_PUBLISH` off) extends it until the next run on
   `main` publishes. The tag and the GitHub Release come only after publish,
   so those never name a missing version; the marketplace is the one reader of
   `main`. `scenescout doctor` reports a registration whose pinned version npm
   does not have, with the fix. A marketplace source that names the `v3` tag
   would close the window, at the cost of tying the marketplace to the major
   version.
5. After the release, it builds the Claude Desktop extension bundle from that tag
   (`npm run build && npm run mcpb`, which writes `.mcpb-build/scenescout-X.Y.Z.mcpb`),
   checks its manifest against the MCPB schema, and attaches it to the release
   with a `SHA256SUMS` file. A build provenance attestation for the bundle is
   recorded too: check a download with `gh attestation verify <file> --repo brunoboto96/SceneScout`.
   The manifest follows the MCPB `manifest.json` format, manifest version 0.3.

```text
gate ─► version ─► build ─► publish ─► release ─┬─► publish-guide
           │       (pack)   (npm,      (tag,     └─► desktop-extension ─┬─► attach-desktop-extension
           │                id-token)  Release,                         └─► attest-desktop-extension
           └─► test-version-pr          v3)
```

Nothing is published while the repository variable `NPM_PUBLISH` is anything
other than `enabled`. The version pull request is still opened and kept up to
date, so merged changesets stay visible; only the publish step is skipped.

## The example workflows

The workflows in [examples/workflows/](../examples/workflows/) name SceneScout
at one exact release (`@vX.Y.Z`), because the job that holds a model's key
should run a reviewed version. Dependabot reads that folder (it is listed in
`.github/dependabot.yml`) and opens one grouped pull request that moves the
SceneScout release and the pinned third-party actions together. To move the
SceneScout release by hand instead, all at once:

```bash
sed -i.bak -E 's#(brunoboto96/SceneScout(/[A-Za-z0-9_-]+)?)@v[0-9]+\.[0-9]+\.[0-9]+#\1@vX.Y.Z#' examples/workflows/*.yml && rm examples/workflows/*.bak
```

`qa-test` fails when the examples name more than one release, a moving ref,
or a release newer than `package.json`; `install-test` fails when an example
pins a third-party action to a different commit than this repository's own
workflows.

## Rehearsing a release

Before relying on a change to the release workflow, run it once without
publishing: Actions → **release** → **Run workflow** on `main`, with
**dry-run** ticked (the default). Or:

```bash
gh workflow run release.yml --ref main -f dry-run=true
```

Every job runs against the version already in `package.json`:

- `version` is skipped, so the Version Packages pull request is left alone.
- `build` builds and packs the tarball, whatever npm has.
- `publish` runs `npm publish <tarball> --provenance --dry-run --force`. A dry
  run sends nothing; `--force` only skips npm's refusal to publish over a
  version it already has. npm still exchanges the job's OIDC token, and the
  step fails if npm then reports it is not logged in, so a green rehearsal
  means the trusted publisher accepts this workflow.
- `release` runs `changeset git-tag` in the runner and pushes, creates and moves
  nothing.
- `desktop-extension` builds and validates the `.mcpb` from the commit;
  attaching, attesting and the wiki publish are skipped.

What a rehearsal cannot show: npm accepting the upload itself and recording
its provenance, the tag push, and the GitHub Release. Those run only on a real
release. A run by hand with **dry-run** unticked is a real release run, as on a
push to `main`; runs by hand on any other branch do nothing.

## Skipping a release run

A merged pull request labelled `skip-publish` makes the release workflow stand
down for that push: the version pull request is not opened or refreshed and
nothing is published. It is rarely needed. A change with no changeset, such as
a docs-only pull request, never causes a release in the first place. The label
is an explicit override for the cases where a change does carry a changeset and
the release should wait.

## One-time setup

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm verifies that a publish request comes from this repository's `release.yml`,
so no npm token is stored in GitHub. npm only lets a trusted publisher be
configured on a package that already exists, so the first version is published
by hand.

1. **First publish**, from a clean checkout of `main`, logged in to npm
   (`npm login`):
   ```bash
   npm ci && npm run build
   npm publish --access public --provenance=false
   ```
   `--provenance=false` is needed because `package.json` asks for provenance,
   which can only be generated inside a supported CI system. npm then asks for
   the account's second factor: with a passkey or security key it prints a
   link to approve in the browser; with an authenticator app, pass
   `--otp=<code>`. Version 1.0.0 was published this way.
2. **Trusted publisher.** On npmjs.com open the package, then Settings →
   Trusted Publisher → GitHub Actions, and enter organization or user
   `brunoboto96`, repository `SceneScout`, workflow filename `release.yml`.
   Leave the environment empty.
3. **Switch it on.** Settings → Secrets and variables → Actions → Variables:
   `NPM_PUBLISH` = `enabled`. Or: `gh variable set NPM_PUBLISH --body enabled`.
4. **Tag the first release**, since it was published by hand:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   gh release create v1.0.0 --title v1.0.0 --notes-file CHANGELOG.md
   ```

Two repository settings the workflow depends on are already in place:

- GitHub Actions is allowed to create pull requests (Settings → Actions →
  General → Workflow permissions), so it can open the version pull request.
- One tag ruleset protects exact release tags (`v*.*.*`) from being **moved or
  deleted** by anyone but the maintainer, and allows creating them. GitHub does
  not accept the Actions app as a bypass actor on a repository owned by a user
  account, so a ruleset that also restricted creation would stop the workflow
  from tagging a release after it had already published to npm.
- A second tag ruleset protects major tags (`v3`) from deletion only. The
  release workflow moves the major tag to each new release, which is how
  `uses: brunoboto96/SceneScout@v3` follows the latest 3.x.

## If a publish fails half-way

Whether to publish is decided by what npm has, so a run that failed before
`npm publish` reached npm is finished by the next run on `main` that finds no
pending changesets. If npm has the version but the tag or GitHub Release is
missing, use **Re-run failed jobs** on that run, not a new run (which finds
the version on npm and does nothing):

- a failed `release` job skips a tag and a release that already exist;
- a failed `publish` job whose request npm stored anyway passes on the
  re-run when npm holds that exact tarball (same sha512 integrity), and the
  release jobs follow it.

Once a later release has been made, do not re-run an older one: it would move
`v3` back. Create the tag and release by hand from the release commit:

```bash
git tag vX.Y.Z <commit> && git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```
