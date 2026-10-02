# 16. A first look sets nothing up and never gates

Status: accepted

## Context

Every way into SceneScout needed setup before it showed anything. An agent
run needs an MCP client, the server registered with it and, in Claude Code,
the skill; `install` does all three, puts a command on the PATH and downloads
about 550 MB of browser. `scenescout check` needs no model, but it is
documented as a gate for CI, and someone trying the tool for the first time
has no CI to put it in. The quickest answer to "what would it say about my
app?" was several steps and a change to the person's agent setup.

## Decision

- **An address in place of a command is a first look.** `scenescout <url>`
  runs the deterministic check's crawl and measurements (ADR 11), with no
  model and no key. Subcommands are matched first, so no existing command line
  changes meaning.
- **It installs only the browser it launches, and only when it is missing.**
  That is the headless Chromium build: about 200 MB, where `install` fetches
  the full browser as well. It does not install the skill, register the MCP
  server or put anything on the PATH. A first look must not change someone's
  agent setup before they have decided they want SceneScout, and a run that
  edits a coding agent's configuration as a side effect would have to be
  explained, and undone, by whoever finds it. It always drives Chromium,
  whatever `SCENESCOUT_BROWSER` says, because that is the browser it can
  download.
- **It reads nothing from the folder it runs in and writes only its report
  there.** The check runs against an empty project directory of its own, so no
  saved flows, project memory or source routes from wherever the command
  happens to be typed (a home directory, an unrelated repository) are used.
  The report goes to `scenescout-report/`, which ignores itself for git, or to
  a temporary folder when the current one cannot be written.
- **It writes only into a folder that is its own.** Every folder a first look
  writes holds a `.scenescout-first-look` marker, and `scenescout-report/` is
  written into only when it is new, empty or holds that marker. Any other
  folder or file of that name is someone's: nothing in it is replaced, the
  run exits 2 before it starts, and the message points at `--out`. It is
  never swapped for a temporary folder either, because the person should
  decide where the report goes. A folder named with `--out` may hold other
  files, but not a `report.md` or `check.json` a first look did not write, and
  it is created only once the address has answered, so a look that cannot run
  leaves nothing behind.
- **Observe by default, capped, and never a gate.** It runs in `observe`
  mode: nothing but `GET`, `HEAD` and `OPTIONS` leaves the page, signing in,
  signing out and refreshing a token apart (ADR 2). A first look needs no
  setup, so it is pointed at addresses nobody has vetted, often a live app
  holding someone's data, and `read-only`, the check's default, lets a plain
  `POST` that a page sends as it loads reach that app. `--mode read-only`
  asks for that, and no mode that writes is accepted. It looks at up to 20
  pages and starts none after 3 minutes, both overridable; the page in
  progress finishes, and the start page is always measured. It exits 0 once
  it has looked, whatever it found, and 2 when it could not run or could not
  write its report. A first look is read by a person: a failing exit code for
  a finding would read as the tool failing.
- **It leads with three things to look at.** The summary and the report open
  with three issues, chosen by severity and then by how many pages show each
  one. One failure seen several ways (a missing image is a failed request, a
  broken image and the browser's console line about it) takes one of the
  three places, so the three are three different things. The counts and the
  report list every issue.

## Consequences

- The ranking involves no model and no timing: the same issues always give
  the same three. A change to the check's rules can change which three lead;
  the smoke suite pins the demo app's.
- A first look never sees signed-in pages, flows or a project's own
  conventions. It says so when the start page sends the browser to a sign-in
  page, and the report's closing section points at the agent run, the check
  in CI and `scenescout login`.
- In `observe`, a page that sends a write as it loads (recording a visit,
  saving a preference) has it refused and answered with a 403 in the server's
  place (ADR 9), so the page's handling of a refused write runs where the
  real server would have accepted it. Its own requests do not count as the
  app's errors. A page whose content depends on such a write may look
  different from a visitor's view; `--mode read-only` sends it. The summary
  and the report name the mode and say what it lets out of the page.
- A second first look in the same folder replaces the first one's
  `report.md` and `check.json` and leaves anything else in the folder alone.
  A `scenescout-report/` that holds files a first look did not write stops
  the run until the person names another folder. A `report.md` or
  `check.json` is replaced only when its first line shows a first look wrote
  it, so a file someone puts there later, under any case of the name, or a
  link in its place, is never overwritten.

## Failure direction

When a first look could either change something on the machine to save the
person a later step or leave that step to them, it leaves the step. When a
request could either reach an app that nobody said may be written to or be
refused, it is refused. When a folder could be someone else's, it is left
alone. When it could either report a finding as a failure or as something to
read, it is something to read.
