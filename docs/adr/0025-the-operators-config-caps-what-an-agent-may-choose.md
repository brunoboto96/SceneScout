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

## Amendment: keys that limit a folder, and keys the engine reads itself

- **`projectsRoot` is read from the operator's file only.** It limits which
  project folder an attach may name, and the project's own file lives in that
  folder, so a project file setting it is refused rather than joined: the
  folder is checked against the operator's root before its file is read.
- **`uploads` is checked where the tool is called**, before the engine's own
  upload fence, so `fixtures` holds whatever `SCENESCOUT_UPLOAD_ALLOW` lists.
- **`writeClassifier`, `refuseDestructiveGets` and `authPosts` are keys** (see
  the amendment below). Their rule (`writeRulesSettings`): the stricter of the
  file and the environment wins, and while a guided plan is open a sign-in
  POST must be listed and also look like one to the path rule.

## Failure direction

When the file cannot be read or understood, nothing runs: the server or the
command stops at start and names the problem. When an argument and the file
disagree, the file wins and the argument is refused.

## Amendment: `egress`, what SceneScout itself may send off the machine (issue #537)

- **`egress` is `none`, `model-only` or `all`, and unset is `all`.** It gates
  the paths SceneScout itself sends data by: a model's API (`scenescout ci`
  and the dedup judge, plus a finding's picture returned into the
  conversation), an issue tracker (`scenescout export` and the ticket tools,
  dry runs and reads included) and a pull request (`/scenescout qa`). The
  rule is `egressAllows` in `project-config.ts`.
- **Only the file sets it.** No environment variable or argument names it, so
  nothing can loosen it, and a project's own file can only lower it.
- **No preset sets it.** `strict` already keeps the judge off and pictures in
  files; adding `egress` to it would stop exports that teams on `strict` run
  today.
- **`none` caps `dedup` at `rule` and `evidence` at `file`** for an attach, as
  those keys would, with the refusal naming `egress`, and refuses the other
  pictures of the app a tool would return (`scout_screenshot`, `scout_cards`
  with inline pictures).
- **The `/scenescout qa` gate reads it from the default branch** through the
  contents API, never from the pull request, which could loosen it. GitHub
  answers 404 also to a token that may not read a private repository, so a 404
  counts as no file only when the repository's top folder can be read; any
  other failure starts no run. The template's gate job asks for
  `contents: read`, and a workflow without it is refused with that advice.
- **It does not cover the coding agent's own model.** Over MCP the agent sends
  what the tools return to its model; SceneScout cannot see that call. The
  guide says so where it describes the setting.

## Amendment: the write-judgement keys, and what an unattended run may do

- **`writeClassifier`, `refuseDestructiveGets` and `authPosts` are read by
  whoever starts the session and handed to the browser engine with the
  attach** (`AttachOptions.writeRules`, and `CheckOptions.writeRules` for
  `check` and a first look), so the engine reads the environment only when no
  caller passes them. No tool argument names them; the environment can turn
  either flag on and narrow the list, never the reverse, and a project's own
  file can only tighten them. A sign-in list replaces the path rule, so a
  list only the project's own file sets is held as a narrowing of it: a POST
  must be listed and also look like a sign-in by its path, unless
  `SCENESCOUT_AUTH_POSTS`, the operator's, lists it too.
- **While a guided plan is open, a sign-in list only narrows the path rule.**
  The attach used to stop reading `SCENESCOUT_AUTH_POSTS` in a guided check;
  it now reads it, and the config's list, with `andSignInPath`, so an
  operator's stricter list stays strict without letting out a POST the path
  rule would refuse.
- **`strict` also sets `refuseDestructiveGets: true`.** It refuses only page
  loads whose address reads as a destructive command, in `observe` and
  `read-only`. No preset sets `writeClassifier` (the strict classifier refuses
  writes the standard one lets out) or `authPosts` (a list names one app's
  endpoints).
- **`ci` under `requireGuidedPlan` runs in `observe`.** No person is there to
  accept a plan, so a `--mode` above `observe` stops the command before it
  starts, and the default is lowered to `observe` with a note. `check` and a
  first look are run by a person and are not held by it.
- **`evidence` capped at `file` or `off` refuses the tools that return a
  picture into the conversation** (`scout_screenshot`, `scout_cards` with
  inline pictures), as `egress: "none"` does.
