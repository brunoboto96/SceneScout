# 25. The operator's config caps what an agent may choose

Status: accepted

## Context

Over MCP, `scout_attach` takes the write mode, `readPosts`, `trustedEmbeds`,
`dedup` and `evidence` from the agent, and every environment variable loses to
an argument. The only restraint on choosing `destructive` was the tool's
description, and the guided gate (ADR 24) engaged only once a plan had been
built. `serve` takes no flags, and an installed client often passes no
environment. An organisation had nowhere to set a rule the agent could not
override (issue #546).

## Decision

- **A committed JSON file sets the limits:** `.scenescout/config.json`.
  SceneScout provides the mechanism; the team running it sets the rules. With
  no file, everything behaves as before.
- **The file wins over the environment, which wins over arguments, for
  anything that loosens.** Each later source may only tighten. An argument
  that asks for more than the file allows is refused, with the file and the
  reason named, and never quietly lowered: an agent told "no" can tell the
  person, where one quietly given less would report results for a mode it did
  not run in. A value from the environment, or a default, above a limit is
  lowered to it, with a note, since nobody chose it on this call.
- **A list the file sets is the most an argument may name** and what an attach
  gets when it names none; `[]` allows none.
- **The lock is read from where the operator controls it:** the file
  `SCENESCOUT_CONFIG` names, else the server's or command's launch directory,
  once, at start. The project folder an agent names may hold a config too, and
  it can only tighten (`tightenPolicy`), because a lock the agent can point at
  is not a lock.
- **A file that is not valid stops the server or the command as it starts.**
  An unknown key is refused rather than ignored, since a misspelt lock that did
  nothing would look like a lock.
- **`strict` is a preset** a team can adopt in one line: `observe` as the most,
  a guided plan required, no `readPosts` or `trustedEmbeds` from arguments, the
  dedup judge off and finding pictures kept to files. A key set beside a
  preset replaces the preset's value for that key, so a team that needs form
  submissions writes `"maxMode": "read-only"` beside it.
- The rules live in `src/engine/project-config.ts` and are table-tested in
  `policy-test`; `mcp-check` holds them over the wire.

## Consequences

- A team can cap an agent's mode without trusting the prompt, and the agent's
  refusal says who set the limit.
- `mode` on `scout_attach` no longer has a schema default: the code applies
  `read-only`, so the config can tell a default from a choice and lower the
  one while refusing the other.
- The file is on disk. An agent with shell access could edit it or start
  another server; the guarantee is against the MCP surface, as ADR 24's is.
  Editing it mid-run changes nothing until the server restarts.
- More keys will cap more mechanisms (method overrides, the sign-in
  exemption, uploads, hosts, egress) as those land. Until a key exists, the
  file refuses it as unknown rather than accepting a lock it cannot enforce.

## Failure direction

When the file cannot be read or understood, nothing runs: the server or the
command stops at start and names the problem. When an argument and the file
disagree, the file wins and the argument is refused.
