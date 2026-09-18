# Releasing

Releases are cut by the maintainer. Contributors add changesets; they never
edit the version or `CHANGELOG.md` (see [.changeset/README.md](../.changeset/README.md)).

## The normal flow

1. Pull requests with user-visible changes carry a changeset.
2. On each push to `main`, the `release` workflow collects pending changesets
   into a pull request titled **Version Packages**: version bump,
   `CHANGELOG.md`, and the matching version in `.claude-plugin/plugin.json`.
3. Approve and merge that pull request. It is opened with the Actions token,
   and GitHub does not run `pull_request` workflows for pull requests opened
   that way, so the release workflow starts the `test` workflow on the version
   branch itself. The checks appear on the pull request once that run starts. Its author is the Actions bot, so the maintainer's
   approval counts as the code-owner review. Its diff is generated and limited
   to the version, the changelog, `plugin.json` and the deleted changeset files.
4. The workflow runs again on that merge, finds no pending changesets, and
   publishes to npm, pushes the `vX.Y.Z` tag and creates the GitHub Release.

Nothing is published while the repository variable `NPM_PUBLISH` is anything
other than `enabled`. The version pull request is still opened and kept up to
date, so merged changesets stay visible; only the publish step is skipped.

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
- The tag ruleset protects `v*` tags from being **moved or deleted** by anyone
  but the maintainer, and allows creating them. GitHub does not accept the
  Actions app as a bypass actor on a repository owned by a user account, so a
  ruleset that also restricted creation would stop the workflow from tagging a
  release after it had already published to npm.

## If a publish fails half-way

`changeset publish` skips versions that are already on npm, so re-running the
workflow is safe. If npm has the version but the tag or GitHub Release is
missing, create them by hand from the release commit:

```bash
git tag vX.Y.Z <commit> && git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```
