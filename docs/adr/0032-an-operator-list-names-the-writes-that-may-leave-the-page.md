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
  that names `DELETE` meets a `DELETE` entry. A request that could be read as
  more than one write (overrides naming different methods, or a `PUT` carrying
  one) is listed only when every one of them is, since servers differ in which
  they honour. Reads are unchanged; a read `POST` named in `readPosts` also
  needs an entry when a list is set.
- **A sign-in is recognised by `observe`'s narrow rule in every mode** (or by
  `authPosts` when the operator sets it). The wider path rule `read-only` and
  `safe-write` otherwise use lets out any `POST` with `verify`, `session` or
  `password` in its path, which would be a write the list does not name.
- **Paths are read as `readPosts` reads them:** exact, `*` for one whole segment,
  no query, an origin for another site's API. A segment holding an encoded `/`
  or backslash, or a dot segment once decoded, matches no entry, since a server
  may read it as more than one segment.
- **A listed write is not held to the mode's other rules** unless the list only
  narrows: it goes out of `observe`, out of `read-only` whatever the destructive
  classifier says, and out of `safe-write` whether or not the run created the
  record. This is a deliberate trade: the operator's list replaces the
  classifier and the ownership rule, so an entry is a promise that every write
  it matches is safe to send.

## Consequences

- An operator who wants the guarantee to rest on a list can have it, at the cost
  of naming each endpoint the test must write to.
- A listed endpoint that carries many operations (one GraphQL path) lets all of
  them out, and `PUT /things/*` lets out a change to any record, not only one
  the run made; the list is as narrow as its entries.
- A sign-in only the wider path rule recognised is refused while a list is set,
  until `authPosts` names it.
- `scenescout policy explain` and `scenescout config explain` show the list and
  its source, and the route handler and the explanation are held equal by test.

## Failure direction

An entry that cannot be read is rejected and the file is refused, so a
misspelt entry never widens the list. An empty list allows no write.
