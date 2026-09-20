# 7. The live view is local, read-only, and leaves nothing behind

Status: accepted — the disk rule is amended by [ADR 8](0008-a-recorded-run-is-evidence-and-must-be-asked-for.md)

## Context

`status.json` held one line for the whole project, and the last session to
finish a call wrote it. That is enough for one browser. A multi-role run keeps
several alive at once, and the line then describes whichever session happened to
write most recently: someone watching twenty sessions could see one of them, and
not the one they were wondering about. A headless run showed nothing at all, so
the only way to tell a slow session from a wedged one was to wait.

Showing each session's page fixes that, and it is also the most sensitive thing
this tool can expose. A session is usually signed in, often to an app holding
real data, and a frame of its page is that data as pixels. Secret redaction,
which protects everything else the engine writes down, cannot see into a
picture.

## Decision

The engine serves a live view of its own sessions: a board with one entry per
session, a thumbnail of each page, and a stream a viewer can switch on. It keeps
to four rules.

- **Loopback only.** The server binds `127.0.0.1` and refuses a request whose
  `Host` header is not loopback. The first keeps it off the network. The second
  stops a page on another origin that resolves its own hostname to `127.0.0.1`
  (DNS rebinding), which a bind address alone does not.
- **A token in every path.** It is random per process, compared in constant
  time, and handed over two ways: in the result of `scout_attach`, so the agent
  can give the address to the person running it, and to `scenescout watch`
  through a file only the owner can read.
  A wrong token gets the same 404 as a wrong path. `watch` builds the address
  itself and checks the port and token for shape first, because both files sit
  inside the project under test and a repository can ship its own.
- **GET and nothing else.** A viewer can look at a run and cannot act in it.
  There is no endpoint that clicks, navigates, or changes a mode, so the live
  view cannot become a way around the write policy ([ADR 2](0002-enforce-the-write-policy-at-the-network-layer.md)).
- **No frame touches the disk.** Thumbnails and stream frames are held in memory
  and sent. A directory of screenshots inside the tested project would outlive
  the run, get committed by accident, and hold exactly the data the redaction
  rules exist to keep out of files.

A frame taken for a viewer is not logged. The action log is the repro trace
attached to findings, and a person glancing at a dashboard is not a step anyone
should replay.

Frames and thumbnails go around the per-session queue. A viewer must never wait
behind the agent's calls, and a session that is stuck is the one most worth
looking at. Each capture is bounded by a timeout for the same reason.

A stream runs only while somebody is watching it. The first viewer starts the
screencast and the last one to leave stops it, so an unwatched run pays nothing.

The server starts with the first attach rather than at boot, and
`SCENESCOUT_LIVE=off` keeps it from starting at all.

## Consequences

The address, token included, appears in a tool result, so it lands in the
client's transcript and is sent to whatever model the client uses. That is
accepted because the token is not what keeps a stranger out: the loopback bind
and the `Host` check are. Someone who reads the address in a transcript still
has to be on this machine, as this user, while this engine is running, and the
token is gone when it exits. The alternative, making the person run a second
command to find a view of their own run, hid the feature from the people it
was built for.

The page shows text the agent chose (the task given at attach, a journey's
goal) and text the tested app produced (URLs, element names in the feed). Both
go through the same secret redaction as the action log before they are sent,
and the page places them with `textContent` only: nothing from either source
is ever parsed as markup.

Any process running as the same user can read the token file and watch a
session. That user can already read the saved logins the sessions were started
from, so the live view grants them nothing new; it is not a boundary against
them and does not claim to be.

A viewer on another machine is out of scope. Reaching the view remotely means an
SSH tunnel to the loopback port, which keeps the decision about exposure with the
person who owns the machine.

Only Chromium can push frames on repaint. In Firefox and WebKit a stream is a
screenshot on a timer, which is slower and costs the page a capture per frame
while it is watched. The rule lives in `src/browsers.ts` with the other
per-browser differences.

## Failure direction

When the view cannot be served (the port will not open, a capture times out, a
session has no page), the run continues and the viewer sees less. Observability
never fails a tool call. The opposite error, a run that stalls because somebody
opened a dashboard, would make watching a run a risk to the run.
