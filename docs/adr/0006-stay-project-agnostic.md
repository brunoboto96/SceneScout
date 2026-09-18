# 6. Nothing in this repo names or is tuned for a tested app

Status: accepted

## Context

SceneScout is a generic exploratory-testing engine, but it is developed by
pointing it at a real application and fixing what the run exposes. That workflow
leaks: the app under test supplies the vocabulary you happen to be holding when
you write an example, a fixture, or a comment.

It leaked here. Route examples, journey goals, evidence samples, persona
descriptions and regression-test fixtures had all drifted into one tested app's
domain — its record types, its module names, its workflow nouns — across source,
tests, the skill and the docs. None of it changed behaviour, and all of it was
wrong: it makes the tool read as built for one customer, teaches the driving
agent a vocabulary that does not exist in the next app, and quietly suggests
tuning the engine to one domain's shapes.

## Decision

No project, company or product name appears in code, comments, commit messages,
fixtures or docs. No tested app's route shapes, field names or backend class
names appear as anything but genuinely illustrative examples, and even then
invented placeholders are preferred — `widget_id`, `/api/things/…`,
`OrderService`, `/orders`, `/invoices` — so an example reads as "REST APIs
commonly look like this" rather than "this one app looks like this".

Regression fixtures describe the **general shape** of a bug ("a create response
naming its own id after the resource"), never where it was found. When a real
bug inspires a fix, the fix and its test belong here in general form; the
specifics belong in that app's own tracker.

## Consequences

Examples take slightly longer to write, and a reader loses the anecdote that
motivated a rule — which is what the ADRs and the comments are for: they record
the *shape* of the failure without borrowing someone's product.

Grep before committing. The drift is invisible in review precisely because the
words are ordinary.
