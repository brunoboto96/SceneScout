# Releasing

Releases are cut by the maintainer. Contributors add changesets; they never
edit the version or `CHANGELOG.md` (see [.changeset/README.md](../.changeset/README.md)).

## The normal flow

1. Pull requests with user-visible changes carry a changeset.
2. On each push to `main`, the `release` workflow collects pending changesets
   into a pull request titled **Version Packages**: version bump,
   `CHANGELOG.md`, and the matching version in `.claude-plugin/plugin.json`.
3. Merge that pull request. It is opened by the Actions token, and GitHub does
   not run other workflows for pull requests opened that way, so the required
   `test` check never reports on it. Merge it with the admin bypass:
   `gh pr merge <number> --squash --admin`. Its diff is generated and limited
   to the version, the changelog and the deleted changeset files.
4. The workflow runs again on that merge, finds no pending changesets, and
   publishes to npm, pushes the `vX.Y.Z` tag and creates the GitHub Release.

Nothing is published while the repository variable `NPM_PUBLISH` is unset.
With it unset the workflow does not run at all, so changesets accumulate and no
version pull request appears.

## One-time setup

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm verifies that a publish request comes from this repository's `release.yml`,
so no npm token is stored in GitHub. npm only lets a trusted publisher be
configured on a package that already exists, so the first version is published
by hand.

1. **First publish**, from a clean checkout of `main`, logged in to npm:
   ```bash
   npm ci && npm run build
   npm publish --access public --provenance=false
   ```
   `--provenance=false` is needed because `package.json` asks for provenance,
   which can only be generated inside a supported CI system.
2. **Trusted publisher.** On npmjs.com open the package, then Settings →
   Trusted Publisher → GitHub Actions, and enter organization or user
   `brunoboto96`, repository `SceneScout`, workflow filename `release.yml`.
   Leave the environment empty.
3. **Repository settings on GitHub:**
   - Settings → Actions → General → Workflow permissions: allow GitHub Actions
     to create pull requests.
   - Settings → Rules → the tag ruleset: add the GitHub Actions app as a bypass
     actor, so the workflow can push `vX.Y.Z` tags.
   - Settings → Secrets and variables → Actions → Variables: `NPM_PUBLISH` =
     `enabled`.

## If a publish fails half-way

`changeset publish` skips versions that are already on npm, so re-running the
workflow is safe. If npm has the version but the tag or GitHub Release is
missing, create them by hand from the release commit:

```bash
git tag vX.Y.Z <commit> && git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```
