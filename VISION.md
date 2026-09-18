# SceneScout — direction

This explains what SceneScout is for and what it will not become, so you can
tell before writing code whether a change is likely to be accepted.
How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Why things are built the
way they are: [docs/adr/](docs/adr/).

## What it is

An exploratory UI tester. An AI agent supplies intent and judgment; SceneScout
supplies deterministic hands, eyes and memory: a structured view of a running
web app, always-on correctness oracles, a write policy enforced on the wire,
cross-run memory, and a report that is honest about what it did not cover.

## Priorities, in order

1. **The safety net.** A tool that drives a real browser against apps holding
   real data must never do damage it was told not to. Anything that weakens the
   write policy, ownership tracking, path fencing or secret redaction is a
   bug of the highest priority.
2. **Honest results.** A finding must be real, a coverage number must mean what
   it says, and a gap must be disclosed rather than hidden. Noise in the report
   is treated as a defect, not a cosmetic issue.
3. **Works on any app.** Setup reliability and generic behaviour across
   frameworks come before depth on any one of them.

## Principles that do not bend

These are recorded as ADRs. A pull request that contradicts one needs to
supersede the ADR with an argument, not work around it.

- **The engine contains no LLM and needs no API key.** Judgment belongs to the
  agent driving it. Features that call a model from inside the engine are out
  of scope.
- **Project-agnostic.** Nothing may name, assume, or be tuned for a particular
  application under test ([ADR 6](docs/adr/0006-stay-project-agnostic.md)).
- **Safety is enforced in code, not requested in a prompt**
  ([ADR 2](docs/adr/0002-enforce-the-write-policy-at-the-network-layer.md)).
- **Completion is a contract** the engine checks, not a claim the agent makes
  ([ADR 1](docs/adr/0001-completion-is-a-contract-not-a-vibe.md)).
- **Logic that can be tested without a browser lives outside `browser.ts`**
  ([ADR 5](docs/adr/0005-keep-testable-logic-out-of-the-browser-module.md)).

## Likely to be declined

- Support tuned to one app, one company's stack, or one vendor's backend.
- Anything that makes `read-only` less strict, or makes a write mode the default.
- Bundling a model, a hosted service, telemetry, or an account requirement.
- New tools that duplicate what an existing tool can do with a parameter — each
  tool costs every agent context on every run.
- Refactor-only changes with no behaviour or test improvement behind them.

## How decisions are made

SceneScout has one maintainer, who decides what is merged and what is
released. The code is MIT licensed: if the project's direction does not fit
your needs, you are free to fork it, and that is a legitimate outcome rather
than a failure.
