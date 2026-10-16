# 23. The actions install the release's locked dependency tree

Status: accepted

## Context

The check action and the ci action install the published CLI into the job
that runs them. The ci action's job holds a model's API key. Both installed
`scenescout@<version>` with `npm install --no-package-lock --ignore-scripts`,
so each run resolved SceneScout's production dependencies (about a hundred
packages) to the newest versions their ranges allowed. A dependency published
an hour before the run ran beside the key, untested by any release.

A shrinkwrap shipped inside the package would pin every install, including
`npx scenescout` and the plugin, and a committed `npm-shrinkwrap.json` would
also pin SceneScout's development tools into every user's install. The
decision (option C on the security issue) is narrower: pin only where the
model key is held.

## Decision

When the action's `version` input is empty, the action installs the release
its ref names with `npm ci --ignore-scripts`, from a lockfile it builds out of
the repository's own `package-lock.json` at that ref:

- The root package depends on exactly `scenescout@<version>`; every production
  entry of the repository's lockfile is carried over unchanged, integrity
  hashes included; development entries are left out.
- SceneScout's own entry carries the registry's integrity hash for that exact
  version (`npm view scenescout@<version> dist.integrity`), so `npm ci` checks
  the release's tarball as `npm install` would. Without a sha512 hash the step
  fails rather than install it unchecked.
- At a release tag that lockfile is the one the release was built and tested
  with. Dependabot keeps it current on main, and the release's version bump
  rewrites it (`npm install --package-lock-only`), so no lockfile has to be
  committed after publishing and nothing new needs regenerating.
- After the install, the published package's declared dependencies are
  compared with the lockfile's root. When they differ, the ref is not the
  release it names (a branch whose dependencies moved on since), and the
  action installs as npm would, with a warning annotation. The comparison
  covers only the package's own declared dependencies. A ref whose lockfile
  changed only in transitive entries therefore still installs pinned, from
  that ref's lockfile, with no warning: it is the tree that ref was tested
  with, which is the property this record promises.
- A `version` input naming the ref's own release takes the pinned path, as an
  empty one does. One naming another version, a range or a tag is not what the
  lockfile describes. The action installs it as npm would, with a warning
  annotation, rather than refusing: refusing would break workflows that set
  the input today.

npm, `npx` and plugin installs are unchanged.

## Consequences

The ci and check actions both take the pinned path, though only the ci action
holds a key: one install function, one behaviour. A security fix in a
dependency reaches action users with the next release rather than on the next
run, so a release follows a security update that matters. A workflow that sets
`version` keeps today's floating install and now sees a warning saying so;
ci-test fails if a key-holding workflow in this repository or its examples
sets it, or installs anything other than with `npm ci --ignore-scripts`.

## Failure direction

When the pinned tree cannot be used, the action falls back to the floating
install and warns, rather than failing the job: the floating install is the
behaviour every earlier release had. A missing integrity hash, or a failed `npm ci` itself (a network
error, a tampered tarball whose integrity does not match) fails the step.
