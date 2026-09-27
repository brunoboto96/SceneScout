# 15. A QA comment tests a preview and never runs the pull request's code

Status: accepted

## Context

`scenescout ci` (ADR 14) runs the exploratory side unattended, on pushes or a
schedule. Teams also asked for it on demand, per pull request: a member
comments `/scenescout qa` and gets a report on that pull request.

A comment trigger changes who controls what the job runs. `issue_comment`
workflows run from the default branch with the repository's secrets, for every
pull request, forks included, as `pull_request_target` does. A job that holds a
model's API key and also checks out and starts the pull request's app hands
that code the key: an install script, a build step or the app's server can
read the job's environment and send it anywhere. Keeping the key out of the
child process, as `scenescout ci` does, does not help when the pull request's
code runs in the same job before it.

Two shapes were considered:

- **(a) Test a deployed preview.** The project already deploys each pull
  request (a preview environment, a review app). The key job gets only the
  preview's URL, checks out nothing, and runs SceneScout from a pinned
  release. The pull request's code runs on the preview's host, never on the
  runner that holds the key.
- **(b) Build in one job, test from another.** A keyless job builds and starts
  the pull request's app; a separate key job reaches it. On GitHub-hosted
  runners each job gets its own machine, and one job's localhost is not
  reachable from another. Making it reachable means exposing the app from the
  keyless job to the internet (a tunnel) for the key job's browser, which adds
  a service and a public endpoint to every run, or running both on the same
  runner, which puts the pull request's code beside the key again. Services
  containers and artifacts do not help: a service runs an image, not the pull
  request's build, and an artifact would have to be started in the key job.

## Decision

- **Shape (a): a comment tests the pull request's deployed preview.** The key
  job never checks out, builds or runs the pull request's code. A project
  without previews does not get this workflow; it can run `scenescout ci` on
  pushes or a schedule.
- **Three jobs, the key in one.** `gate` (no key; `pull-requests: write` to
  react and reply, `deployments: read` to find the preview) decides; `qa`
  (the key; `contents: read` only) runs only when the gate's `run` output is
  `true`; `report` (no key; `pull-requests: write`, `actions: read`) posts the
  reply. The workflow's default permissions are empty.
- **The gate checks before anything reaches the key.** The command must be the
  comment's first line; the commenter must be in an allowlist (a repository
  variable; unset, the repository's owners: the owner's login where a user
  owns it, and commenters GitHub marks with the author association `OWNER`,
  which where an organization owns it are that organization's owners, since
  the organization's own login never comments); the pull request must be
  open and, unless the repository allows forks, from the same repository; the
  preview URL must be https without credentials. A commenter outside the
  allowlist gets a reaction and no reply, so the command cannot be used to
  make the workflow write on a pull request.
- **Forks are refused by default.** Shape (a) keeps a fork's code off the key
  job's runner, but the preview's pages are still text the fork's author wrote,
  and the model reads them with the repository paying for it. Allowing forks is
  a repository variable, and the allowed commenter still decides each run.
- **SceneScout in the key job comes from an exact release tag.** Both actions
  are pinned to one release tag or its commit SHA, never a moving major tag or
  a branch, and the key job has no script step of its own. The ci action at a
  release tag runs the npm package of that version. That fixes SceneScout's own
  code, not its dependencies: the package ships no lockfile, so npm resolves
  them at install time within the ranges the release declares. `qa-test` holds
  the template's pin to the release that ships `qa/`.
- **The preview's URL: the comment, then a template, then a deployment.** An
  allowed commenter may name it; a repository may set a template with `{pr}`
  and `{sha}`; otherwise the newest successful deployment status of the head
  commit, optionally of one environment. A fork cannot create deployments, so
  that source is written by the repository's own automation.
- **The reply is inert.** Finding titles and paths are written by a model that
  read the preview, so the reply escapes them: no mention, link, image, HTML or
  table break reaches the comment. The reply links the run's artifact, which
  holds the full report.
- **One run per pull request.** The key job is in a concurrency group keyed on
  the pull request, cancelling the run in progress; the cancelled run posts no
  reply. The caps are `scenescout ci`'s, set explicitly in the workflow, in
  `read-only` mode.
- **Shipped as a template, not run here.** The workflow is
  `examples/workflows/scenescout-qa.yml`, and the keyless logic is a composite
  action in `qa/` whose rules live in `action/qa-action.mjs`. SceneScout has no
  preview deployment, so this repository does not run the workflow; `qa-test`
  holds the template to the rules above, including against mutated copies that
  break each one, and runs both stages against a stand-in GitHub API.

## Consequences

- Only projects with per-pull-request previews can use the comment. That is
  the cost of never running the pull request's code beside the key.
- The run tests what was deployed, which can lag the head commit. The gate
  records the head commit it saw, and the reply names it as the head when the
  run was asked for, not as what the preview runs.
- The preview is explored signed out: the key job has no checkout, so no saved
  session.
- A comment from anyone still starts the `gate` job for a few seconds. It
  reads nothing beyond the event and never reaches the key.
- A run cancelled by a newer command on the same pull request stays silent,
  because that run replies; one cancelled by hand or by its timeout says so.
  The report job tells them apart through the runs API: a later run titled
  with the same pull request (the workflow's `run-name`) whose `qa` job was
  not skipped.
- The report job reads `ci.json` from the artifact as data only. The model's
  words reach the pull request only through the escaping above.

## Failure direction

When a run could either start on something the gate cannot confirm (a fork,
an unknown commenter, a pull request whose repositories cannot be read, a URL
that is not https) or not start, it does not start. When a design could either
let the pull request's code share a runner with the key or give up a feature,
it gives up the feature.
