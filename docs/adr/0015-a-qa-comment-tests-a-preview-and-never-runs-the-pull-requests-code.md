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

## Addendum: allowing by role and by team

Projects asked to open the command beyond a list of logins. Two more lists
now combine with it as a union: author associations (`OWNER`, `MEMBER`,
`COLLABORATOR`, read from the event, so no API call) and teams of the
repository's organization (read with the team membership API). The default
with all three unset is unchanged, and setting any of them replaces it.

- **A list the gate cannot read fails the gate.** An association outside the
  three, or a team that is not `org/team-slug`, stops the `gate` job with an
  error rather than being skipped, so a typo can neither quietly narrow nor
  widen who may run.
- **Team membership needs its own token, and only the gate gets it.** The
  workflow's token cannot read an organization's teams, so a project passes a
  GitHub App token or a personal access token with `read:org` as a separate
  secret. That makes the `gate` job hold a secret, but not the model's key:
  the token can read the organization's membership, not run a model, and the
  `gate` job still checks out and runs nothing from the pull request. `qa-test`
  holds the template to it: the token only as the gate step's `team-token`
  input, never in the `qa` or `report` job.
- **Every unconfirmed answer refuses.** No token, a 401, 403 or 404, a pending
  invitation, a failed call, or a team of another organization (never looked
  up, so the token is only used about the repository's own organization)
  leaves the commenter not allowed by team, with an annotation saying why.
- **Lookups happen only when they can change the answer**: for a comment that
  is the command, from someone the logins and roles have not already allowed.
  A commenter allowed by none of the lists still gets only a reaction, and
  their pull request is not read.

## Addendum: show and compare, with pictures in the reply

`/scenescout qa show <element>` and `/scenescout qa compare <element>` reply
with pictures of one element: on the preview, and for `compare` on a base URL
as well, with a diff. Pictures needed two things the three jobs above did not
have: a way to take them that a model cannot fake, and somewhere a comment can
link them from, since the comment API cannot attach files.

- **The engine takes the picture; the model only points.** The key job runs
  `scenescout ci --show "<words>"`, in which the model is given the tools to
  find an element and `scout_capture`, which it may call with a ref and
  nothing else. SceneScout screenshots the element's bounds plus a margin in
  the browser. For `compare`, SceneScout itself, not the model, opens the same
  page on the base URL in a second session, finds the element by its identity
  and captures it, and computes the diff with no image package.
- **The base URL is held to the preview's rules.** It comes from the
  repository variable `SCENESCOUT_QA_BASE_URL` or the base branch's newest
  successful deployment, never from the comment, and must be https without
  credentials. The gate checks it before anything reaches the key.
- **A fourth job writes the pictures, and holds no key.** `shots` has
  `contents: write` and nothing else, runs only after the key job succeeded,
  downloads the artifact, and pushes at most three PNGs by fixed names to the
  `scenescout-shots` branch, under the run's id, through the Git Data API. The
  branch starts with no history, so it never carries code, and its name is
  fixed in the action rather than an input. The stage refuses to run where a
  model's key is set. The key job keeps `contents: read`; `qa-test` holds the
  template to `shots` being the only job that writes contents.
- **Only the workflow's own image URLs are rendered.** The report builds each
  image URL from the server, the repository, the run's id and one of the three
  fixed names, and only for files the `shots` job reported pushing. Everything
  from `ci.json`, the element's description included, stays inert as before.

Consequences: a repository that uses `show` or `compare` gets a
`scenescout-shots` branch that grows by a few small files a run; deleting it
removes the pictures and leaves the older replies with broken images. Only an
element a snapshot lists, on a page reachable by URL, can be captured: nothing
is clicked, because a comparison has to reach the same state on the base
deployment without the model, and a click there would be the model acting on a
second deployment.
