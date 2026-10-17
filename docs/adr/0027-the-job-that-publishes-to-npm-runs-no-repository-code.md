# 27. The job that publishes to npm runs no repository code

Status: accepted

## Context

npm trusted publishing gives a job that holds `id-token: write` a short-lived
token that can publish `scenescout`. Until this record, that permission sat on
the job that also checked the repository out, ran `npm ci`, built the package
and ran `changeset publish`. Every dependency in the lockfile and every build
script ran in a job that could mint a publish token. `npm ci --ignore-scripts`
kept dependencies' install scripts out, but the build itself, Changesets and
everything they load still ran there.

A first attempt to split the job (reviewed and reverted before it merged)
showed what a split has to keep:

- It decided whether to publish by whether the git tag existed. A run that
  tagged and then failed to publish left a version npm never got, and no later
  run would publish it.
- It moved the tag, the GitHub Release and the `v3` major tag before npm had
  the version. The plugin installs the exact version a release names (#574),
  so a tag pointing at a version npm lacks is a broken install.
- `npm pack --pack-destination` into a folder that did not exist failed on every
  push to `main`, and publishing without `--tag` broke prerelease versions.

## Decision

The release workflow is a chain of jobs, each holding only what it needs:

| Job | Can | Runs repository code |
| --- | --- | --- |
| `version` | push the version branch, open the Version Packages pull request | yes (Changesets) |
| `build` | nothing (`contents: read`) | yes: decides, builds, packs |
| `publish` | mint the npm token (`id-token: write`) | **no**: no checkout, no install |
| `release` | push the tag, create the GitHub Release, move `v3` | yes (`changeset git-tag`) |
| `desktop-extension` | nothing | yes: builds the `.mcpb` |
| `attach-desktop-extension`, `attest-desktop-extension`, `publish-guide` | upload, attest, dispatch | no |

- **npm decides.** `build` runs `scripts/release-plan.mjs`, which publishes
  exactly when npm does not have `package.json`'s version. A version a failed
  run left unpublished is published by the next run on `main`; one npm has is
  never sent again. A git tag plays no part in the decision.
- **One tarball.** `build` packs it once (`npm pack --pack-destination` into a
  folder made first) and uploads it. `publish` downloads it and runs
  `npm publish ./package/scenescout-X.Y.Z.tgz --provenance --tag <dist-tag>`.
  Its only other steps are `actions/setup-node` and installing a pinned npm.
- **The dist-tag is Changesets' own.** `latest`, or while `.changeset/pre.json`
  exists, the prerelease tag it names, as `changeset publish` chose.
- **Tags follow the publish.** `release` needs `publish`, so the `vX.Y.Z` tag
  (made with `changeset git-tag`), the GitHub Release (its body the version's
  section of `CHANGELOG.md`), the `v3` move, the `.mcpb` and its checksum and
  attestation, and the wiki publish all happen only after npm has the version.
  changesets/action runs with `create-github-releases: false` and no publish
  script: it only versions.
- **A rehearsal.** Run by hand with `dry-run` (the default), every job runs
  against the current version: `npm publish --dry-run --force`, `changeset
  git-tag` in the runner, the `.mcpb` built and validated. Nothing is pushed,
  released, attached, attested or dispatched. A run by hand works only on
  `main`.

`install-test` holds the shape: only `publish` and the attestation job hold
`id-token`, neither checks out nor runs repository code, every job that names
the version needs `publish`, and only GitHub's own actions and
changesets/action are used.

## Consequences

- The tag `changeset git-tag` makes is annotated, where the action's API push
  made lightweight ones. Both resolve to the same commit for `uses:`, `git
  checkout` and `npm`.
- The Version Packages pull request's generated description no longer says the
  merge publishes automatically: changesets/action words it from whether it
  was given a publish script.
- If the publish succeeds and `release` fails, the next run finds the version on
  npm and does nothing; the tag and release are then made by hand, as before
  (docs/RELEASING.md). Re-running the failed job also works: each of its
  steps skips what already exists.
- The attestation job still holds `id-token`. It needs it to sign, and it
  downloads one file and runs one GitHub action.

## Failure direction

When npm cannot be asked (an error other than "not found"), `build` fails and
nothing is published or tagged, rather than guessing. A rehearsal whose
`npm publish --dry-run` reports that it is not logged in fails, because that
is what a real publish would meet if the trusted publisher were misconfigured.
