# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**
([direct link](https://github.com/brunoboto96/SceneScout/security/advisories/new)).
You will get a reply there, and the fix and the advisory are coordinated in the
same place.

Useful things to include: the version (`package.json`), what you did, what
happened, and what you expected — a minimal reproduction if you have one.

## Supported versions

Fixes land on the latest release only. There are no maintained older branches.

## What counts

SceneScout drives a real browser against applications that may hold real data,
so its safety net is part of its security surface. These are in scope and
taken seriously:

- **A write-policy bypass** — a request that `observe`, `read-only` or `safe-write` mode
  should have blocked (see [`src/engine/policy.ts`](src/engine/policy.ts)) and
  did not.
- **Ownership confusion in `safe-write`** — the engine editing or deleting a
  record it did not create in that run.
- **Path escape** — `scout_upload` reading a file outside the project under test,
  or a tool writing outside the attached project directory (the installer's own
  entries under `~/.claude/` excepted).
- **Secret leakage** — credentials, tokens or cookies written unredacted into
  findings, memory, session logs or the report.
- **Installer damage** — `scenescout install` deleting or overwriting something
  it did not create.

Not a vulnerability: `read-only` mode allowing an ordinary, non-destructive
form `POST`. That is documented behaviour — see the safety model in the README.
`observe` mode is the one that blocks those too; a non-GET request leaving the
page in `observe` mode (other than a login or token refresh) is a bypass.

## Using it safely

Only test applications you own or are authorized to test, and prefer a
disposable environment for anything beyond `read-only`.
