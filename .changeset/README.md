# Changesets

Every pull request that changes what users get — behaviour, a tool, the skill,
the CLI — carries a changeset: a small Markdown file in this folder saying
which kind of release it needs and, in one or two sentences, what changed for
the user. Add one with:

```bash
npx changeset
```

Pick `patch` for a fix, `minor` for a new capability, `major` for a breaking
change (a renamed tool, a changed default, a removed flag). Write the summary
for someone reading the changelog, not for a reviewer.

Docs-only, test-only and CI-only changes do not need one.

The maintainer releases. Merged changesets are collected into a "Version
Packages" pull request that bumps `package.json` and writes `CHANGELOG.md`;
merging that pull request publishes to npm. Contributors never edit the version
or the changelog by hand.
