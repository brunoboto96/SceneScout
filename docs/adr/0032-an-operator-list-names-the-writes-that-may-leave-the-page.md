# 32. An operator list names the writes that may leave the page

Status: accepted

## Context

Whether a write is destructive is decided by patterns on its path and body
(`isDestructiveRequest`). The patterns are tested and their miss and false-alarm
rates are published, but a pattern can be wrong in both directions, so the write
modes other than `observe` rest on a guess. Only the method rule is structural
(issues #538 and #546).

## Decision

- **A list of `METHOD path` entries is the whole of what may be written.** The
  config key `allowedWrites` (narrowed by `SCENESCOUT_ALLOWED_WRITES`) names the
  writes; with a list set, every other write is refused in `observe`,
  `read-only` and `safe-write`, whatever it looks like, and a listed write goes
  out whatever it looks like. `destructive` judges no write, so the list does
  not apply there; `maxMode` is how an operator keeps it out.
- **Only the operator names an entry.** There is no attach argument and no
  command flag: the list is the config's, the environment's, or both, where the
  environment may only narrow the file's list. A project's own file may only
  narrow the operator's, and a list only the project's file sets (or any list in
  a guided check) is held to the mode's own rules as well, so it cannot let out a
  write the mode would refuse.
- **The method is the one the policy judges**, so a `POST` carrying an override
  that names `DELETE` meets a `DELETE` entry. Reads and the sign-in exemption of
  `observe` are unchanged; a read `POST` named in `readPosts` also needs an
  entry when a list is set.
- **Paths are read as `readPosts` reads them:** exact, `*` for one whole segment,
  no query, an origin for another site's API.

## Consequences

- An operator who wants the guarantee to rest on a list can have it, at the cost
  of naming each endpoint the test must write to.
- A listed endpoint that carries many operations (one GraphQL path) lets all of
  them out; the list is as narrow as its entries.
- `scenescout policy explain` and `scenescout config explain` show the list and
  its source, and the route handler and the explanation are held equal by test.

## Failure direction

An entry that cannot be read is rejected and the file is refused, so a
misspelt entry never widens the list. An empty list allows no write.
