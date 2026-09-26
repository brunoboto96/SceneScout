# Running `scenescout check` in CI

`scenescout check` visits every page of a running app and measures it, with no model involved, so the same app always gets the same verdict. That makes it a pull-request gate. Why its defaults are what they are: [ADR 11](adr/0011-a-gate-is-deterministic-and-fails-only-on-what-it-can-prove.md).

Whatever the CI system, the job has the same three parts: start the app, wait until it answers, run the check. The check never starts the app itself.

| Exit code | Meaning | What the job should do |
|---|---|---|
| 0 | Passed the gate | Pass |
| 1 | Failed it: something at the `--fail-on` severity or worse | Fail: the app has a defect |
| 2 | Could not run: a bad argument, an app that never answered, a saved session that no longer signs in, only the sign-in page reached | Fail, and read it as a broken setup, not a broken app |

## GitHub Actions

The repository is also a GitHub Action. It installs Node if the runner has none, installs SceneScout and the browser (cached between runs), runs the check, puts the report on the job's summary page and keeps `report.md`, `check.json` and `check.sarif` as an artifact.

```yaml
name: ui-check

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run build

      # Start the app in the background and wait until it answers.
      - name: Start the app
        run: |
          npm start > "$RUNNER_TEMP/app.log" 2>&1 &
          for _ in $(seq 1 60); do
            if curl -sf -o /dev/null http://127.0.0.1:3000/; then exit 0; fi
            sleep 1
          done
          echo "The app did not start:"; cat "$RUNNER_TEMP/app.log"; exit 1

      - name: SceneScout check
        id: scenescout
        uses: brunoboto96/SceneScout@v3.10.0
        with:
          url: http://127.0.0.1:3000
          fail-on: high
```

`npm start` and port 3000 are placeholders for however your app starts. A `services:` container or a preview deployment's URL works the same way: the action only needs an address that answers.

### Which ref to use

- **Use an exact release tag, such as `@v3.10.0`, for now.** It never moves, and it is what the rest of this page assumes.
- `@v3` is meant to follow the latest 3.x release. Until the repository's tag settings let a release move it, it may stay on the first 3.x release that had the action, so it can lag behind.
- A full commit SHA also works, but only the SHA of a release commit (the one a `vX.Y.Z` tag points at). Pin a tag or a release SHA if your policy is to review every change to a third-party action.

The action runs the scenescout npm package of the same version as its ref, so `@v3.10.0` runs `scenescout@3.10.0`. At a commit between releases (a branch, or a SHA that no tag points at), the action installs the last published version instead, which can be older than the action; if that version has no `check` command, or does not accept one of the inputs, the step stops with an annotation that says so. The `version` input overrides the version in every case.

### Inputs

Every option of `scenescout check` is an input with the same name. `scenescout check --help` describes them.

| Input | Default | |
|---|---|---|
| `url` | (required) | The address of the running app |
| `fail-on` | `high` | `high`, `medium`, `low` or `never` |
| `mode` | `read-only` | `observe` or `read-only` |
| `max-routes` | 50 | 1 to 150 |
| `paths` | every route found | Comma-separated, each starting with `/` |
| `ignore` | none | Rules to drop, comma-separated |
| `storage-state` | none | A Playwright storage-state file, to check while signed in |
| `browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `project` | `working-directory` | The project directory |
| `out` | `<project>/.scenescout/check` | Where the three files go |

And the action's own:

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | Where the check runs; relative paths above are resolved from here |
| `version` | the ref's release | The scenescout npm version to run |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo`. Set `false` on a runner or container that has them |
| `upload-artifact` | `true` | Keep the three files as an artifact |
| `artifact-name` | `scenescout-check-<job id>` | A second use in the same job gets `-2`, a third `-3`. Jobs of a matrix share a job id, so give each cell its own name, e.g. `scenescout-check-${{ matrix.browser }}` |
| `upload-sarif` | `false` | Upload `check.sarif` to code scanning (below) |

### Outputs

`passed` (`true` or `false`, empty when the check could not run), `exit-code`, `failing` (issues at the gate's severity or worse), `high`, `medium`, `low`, the paths `report`, `json` and `sarif`, and `artifact-name`.

A later step can read them, for example to comment on the pull request. To keep the job going after a failed gate, give the step `continue-on-error: true` and look at `steps.scenescout.outputs.exit-code`.

### Code scanning

With `upload-sarif: true` the issues appear under the repository's Security tab and on the pull request. The upload needs a permission the default token does not have:

```yaml
permissions:
  contents: read
  security-events: write # upload-sarif
  actions: read # upload-sarif, in a private repository
```

A pull request from a fork gets a read-only token, so the upload fails there; leave it off for those runs, or upload only on pushes to your main branch.

### Checking while signed in

Save a Playwright storage state in an earlier step (for example your own Playwright setup project) and pass its path:

```yaml
      - uses: brunoboto96/SceneScout@v3.10.0
        with:
          url: http://127.0.0.1:3000/dashboard
          storage-state: playwright/.auth/user.json
```

If the session no longer signs in, the check exits 2 rather than checking the sign-in page and calling it the app.

## Other CI systems

Anywhere Node 20 or newer runs, the check is one command. Install the browser first; on Linux add its system libraries unless the image already has them (the official Playwright images do).

### Plain shell

```bash
npx --yes scenescout@3 install --browser-only --browsers chromium-headless-shell
npx --yes playwright install-deps chromium   # Linux, as root, if the image lacks the libraries

npm start &                                          # your app
npx --yes wait-on http://127.0.0.1:3000 --timeout 60000

npx --yes scenescout@3 check http://127.0.0.1:3000 --fail-on high --out scenescout-check
# exit 0: passed · 1: the gate failed · 2: could not run
```

`scenescout-check/report.md` is the report, `check.json` the machine-readable verdict and `check.sarif` the SARIF 2.1.0 file that most code-quality dashboards import.

### GitLab CI

```yaml
ui-check:
  image: mcr.microsoft.com/playwright:v1.63.0-noble
  script:
    - npm ci && npm run build
    - npm start &
    - npx --yes wait-on http://127.0.0.1:3000 --timeout 60000
    - npx --yes scenescout@3 check http://127.0.0.1:3000 --out scenescout-check
  artifacts:
    when: always
    paths: [scenescout-check/]
```

The Playwright image already has the browsers' system libraries. If its Playwright version is not the one scenescout uses, the check says which browser build is missing; add `npx --yes scenescout@3 install --browser-only --browsers chromium-headless-shell` before it.

### CircleCI

```yaml
jobs:
  ui-check:
    docker:
      - image: mcr.microsoft.com/playwright:v1.63.0-noble
    steps:
      - checkout
      - run: npm ci && npm run build
      - run:
          command: npm start
          background: true
      - run: npx --yes wait-on http://127.0.0.1:3000 --timeout 60000
      - run: npx --yes scenescout@3 check http://127.0.0.1:3000 --out scenescout-check
      - store_artifacts:
          path: scenescout-check
```

In any system, treat exit code 2 differently from 1 if you can: 2 means the job never measured the app.
