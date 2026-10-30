# 34. Current after a cooldown, on maintained LTS lines

Status: accepted

## Context

`engines` allowed Node 20 for six months after its end of life on 2026-04-30.
That range held undici at 7.x, because undici 8 requires Node 22.19, and it
admitted Node 20.0 to 20.18, which undici 7.30.1 itself does not support. An
`engines` range that still allows an unmaintained runtime holds security fixes
back several packages deep. A new release can also be broken or compromised in
its first days, and most such releases are found and pulled within a week.

## Decision

- **Take the latest stable release once it has had time to settle.** Dependabot
  version updates use `cooldown`: 7 days for npm minor and patch releases, 30
  days for an npm major, and 7 days for GitHub Actions, where Dependabot
  supports `default-days` only. Cooldown applies to version updates only
  (GitHub's Dependabot options reference): a security update opens as soon as
  its advisory is published. A dependency installed by hand follows the same
  rule, for example `npm install --before=<a date 7 days ago>`, unless the
  release is the security fix.
- **Support every maintained Node LTS line, and only those.** `engines` starts
  on the oldest line Node's release schedule still maintains, at the lowest
  minor the dependencies accept (today `>=22.19.0`, because undici 8 needs
  22.19). A line is dropped in the change after its end of life. `@types/node`
  stays on the floor's major so the compiler flags APIs the floor lacks.
- **The default moves to a new LTS line a few weeks after it becomes LTS.** CI's
  main cells and the actions' `node-version` default stay on Node 24 for now:
  Node 26 has been LTS since 2026-10-28. Move them to 26 once it has been LTS
  for a few weeks and the full matrix passes on it.
- **The full matrix proves compatibility.** A change to `engines`, a runtime or
  a dependency major passes every CI cell, including the oldest supported line
  (every pull request that changes code runs them all, ADR 33).
- **A hold is written down with its exit condition.** A dependency kept back
  gets an ignore rule in `.github/dependabot.yml` and a line under "Pinned
  dependencies" in `AGENTS.md` saying why and what ends it, and a test holds the
  two together where it can.

`install-test` holds the rules that do not depend on the date: `engines` starts
on an LTS line; the doctor, CI's oldest cell and `@types/node` agree with it; no
runtime dependency in the lockfile refuses a Node version `engines` admits; both
Dependabot ecosystems carry a cooldown; and each action compares the runner's
Node with the floor by minor. Whether that line is still maintained depends on
the date, so the weekly `node-lts` workflow checks it, from the table of
end-of-life dates in `scripts/node-lts.ts`: the floor must be the oldest LTS
line maintained that day, and every CI cell must be on a maintained line.
`install-test` holds that rule on fixed dates.

## Consequences

- From 2027-04-30, when Node 22 reaches end of life, the weekly `node-lts`
  workflow fails until the floor moves to 24. That failure is intended: it is
  the prompt to drop the line. A pull request's suite does not fail on that
  date, so unrelated work is not held up by it. A new LTS line is added to the
  table in `scripts/node-lts.ts` when it becomes LTS.
- Users on Node 20, or on 22 before 22.19, must upgrade Node before they
  upgrade SceneScout. The doctor and the actions say so.
- A fix released in the last 7 days that is not filed as a security advisory
  arrives up to a week later than it otherwise would.
- undici 8 forwards a plain-http request to a proxy in absolute form instead of
  through a CONNECT tunnel, so an address the proxy cannot reach would come
  back as the proxy's own 502. `proxy.ts` sets `proxyTunnel` so it fails as a
  network error, as it did with undici 7 (`policy-test`, against a real proxy).
- Node's own proxy support could replace undici, but its in-process switch
  (`http.setGlobalProxyFromEnv`) exists only from Node 24.14 and 25.4, and
  `NODE_USE_ENV_PROXY` is read only when the process starts. Revisit once the
  oldest supported line has the in-process switch.
