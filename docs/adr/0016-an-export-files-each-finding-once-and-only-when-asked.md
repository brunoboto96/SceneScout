# 16. An export files each finding once, and only when asked

Status: accepted

## Context

A run's findings live in `.scenescout/memory.json` and its report. Teams track
work in GitHub Issues or Jira, so findings were being copied across by hand.
`scenescout export` files them for the team, which raises questions a report
never had: how a finding is recognised as already filed, what an export may
create without a person looking first, where an issue's text comes from and
what a tracker will do with it, and what happens when a request to the
tracker fails half-way.

The text of a finding is written by a model and quotes the app under test. A
tracker renders it, and GitHub acts on it: `@name` notifies an account, `#12`
cross-references an issue, an address becomes a link, HTML and Markdown
render.

## Decision

- **A dry run unless `--yes`.** Without it the export lists what it would file
  and sends the tracker reads only. One export files at most `--max-issues`
  (default 20); the next export files the rest, because by then the first ones
  are already filed.
- **A marker and a label decide what is already filed.** Every issue carries
  the `scenescout` label and a marker holding the finding's id (an HTML comment
  on GitHub; a last line in a Jira description, which cannot hide text). Before
  its first create, the export lists the open issues with the label (all of
  them with `--include-closed`) and reads their markers. On GitHub it lists
  rather than searching: the search API is indexed with a delay, so an export
  run right after another would not see the issues it had just filed. Jira
  offers no listing by label other than its search, which also lags; that
  limit is documented rather than hidden.
- **A create is never sent twice blind.** A create that timed out, got a 5xx
  or had its answer cut off may have been carried out. On GitHub the issues
  are listed again before it is re-sent, and one carrying the finding's marker
  is the issue. In Jira, whose search may not show it yet, the export stops
  and says so; the next export finds the issue or files it. A rate limit is
  waited out and the request sent again, since the tracker says it did
  nothing; reads are retried on a 5xx, a dropped connection or a timeout.
- **What cannot be read is refused, not guessed.** A listing that leaves out
  an issue's body or description, or a memory file this version does not read,
  ends the export: reading either as "nothing filed" would file everything
  again.
- **Issue text is inert.** Everything taken from a finding is redacted again,
  escaped, and given zero-width breaks where a tracker would act: after `@`,
  inside `://` and `www.`, between `#` or `GH-` and a number, and inside the
  marker's own word, so quoted text cannot pose as another finding's marker.
  The escaping is the `/scenescout qa` reply's, which a test holds it to, plus
  `$`.
- **GitHub gets no uploads.** GitHub's REST API cannot attach a file to an
  issue, and SceneScout hosts nothing, so a GitHub issue names the run's frames
  in its `.scenescout/` folder. Jira gets them as attachments: the frames of
  the session that filed the finding, from the steps just before it was last
  found, and only while the file is inside the recordings folder and still the
  picture written at that step.
- **Credentials from the environment only, never printed, never redirected.**
  Every printed line, refusals of the command line included, is redacted
  against every credential variable that is set and the encoded header. A
  redirect is refused, so the credentials are never sent to an address the
  user did not give.

## Consequences

- Removing the `scenescout` label or the marker from an issue, or closing it
  (without `--include-closed`), makes the next export file the finding again.
  GitHub drops the labels of an issue created by an account that may not set
  them, so the export stops after such an issue rather than file more it could
  not find again.
- Dedup across runs rests on the finding's id, which the project's memory
  keeps. A CI job that starts from an empty memory gives a defect a new id
  whenever a run words it differently, and so a new issue; such a workflow
  keeps `.scenescout/memory.json` between runs.
- Two exports of one project at the same moment are not guarded against each
  other, and an export to Jira straight after another may not yet see what the
  first filed.
- An export reads every labelled issue each time it runs, 100 at a time; at
  50 pages it refuses rather than file without knowing what is already there.
- Escaped text reads with backslashes in the raw Markdown and zero-width spaces
  inside addresses, so an address copied out of an issue may need retyping.
- Jira Cloud's REST API v3 is supported; Server and Data Center are not.

## Failure direction

An export errs towards filing nothing rather than filing twice: a dry run by
default, a cap, a listing before the first create, a re-check or a stop after
a create that may have been carried out, a refusal when a listing or the memory
cannot be read, and a stop when a filed issue could not be found again. A
finding left unfiled is listed and filed by the next export; a duplicate issue
costs someone on the team the time to find and close it.
