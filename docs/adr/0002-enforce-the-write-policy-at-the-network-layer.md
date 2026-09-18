# 2. The write policy is enforced on the wire, not in the prompt

Status: accepted

## Context

The tool drives a real browser against a real app, and the database behind it
may hold real data. The tester is a language model, so "please don't delete
anything" is a request, not a control: one confident model, one ambiguous
button label, and a record is gone. Safety that lives in a prompt is not safety.

Label-based blocking alone is also insufficient in the other direction — the
button that deletes may be an icon, or say "Archive", or say nothing.

## Decision

Three modes, enforced by intercepting requests in the browser context:

- **read-only** (default) — destructive-labeled elements are refused in the UI,
  *and* every PUT/PATCH/DELETE plus destructive-looking POST is blocked on the
  wire. Plain POSTs pass (search and login are POSTs) but are reported.
- **safe-write** — creation is allowed; the engine tracks the ids this session
  created and permits mutations only on those. Label blocking is off, because
  deleting your own test record is the point.
- **destructive** — everything, only on an environment the human has explicitly
  confirmed is disposable. The skill instructs the agent never to choose this.

URL and body are judged by different rules: a destructive verb in a URL path is
structure and blocks; in a body it must be *structured* intent (a GraphQL
destructive mutation, or a command key like `"action":"delete"`). Bare keyword
matching on bodies blocked ordinary create/analyse POSTs whose payload merely
mentioned a destructive word — a document under analysis, a record description —
which is lost coverage for no safety gain.

## Consequences

A refusal is a tool result the agent must respect and cannot route around, and
the guarantee holds regardless of what the model believes it is doing. In
exchange the policy occasionally refuses something harmless, so refusals say why
and name the mode that would allow it.

## Failure direction

Chosen deliberately: **refuse a safe action over permitting a destructive one**
at the URL layer, and the reverse in bodies, where the false-positive rate was
high and the added safety near zero.
