# Architecture Decision Records

Why SceneScout is built the way it is — one record per decision that a future
change is likely to want to undo without knowing what it cost to learn.

These are not documentation of *what* the code does (read the code and its
comments for that). They record the **trade-off**: what was tried, what broke,
and which failure direction was chosen deliberately.

| ADR | Decision |
|---|---|
| [0001](0001-completion-is-a-contract-not-a-vibe.md) | Completion is an enforced contract, not a claim |
| [0002](0002-enforce-the-write-policy-at-the-network-layer.md) | The write policy is enforced on the wire, not in the prompt |
| [0003](0003-a-noisy-ledger-is-a-broken-ledger.md) | A gap-ledger entry must be actionable, and suppression must be visible |
| [0004](0004-dedup-on-machine-signals-not-prose.md) | Findings dedup on machine signals; a merge must never lose a finding |
| [0005](0005-keep-testable-logic-out-of-the-browser-module.md) | Logic that does not need Playwright lives outside `browser.ts` |
| [0006](0006-stay-project-agnostic.md) | Nothing in this repo names or is tuned for a tested app |
| [0007](0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md) | The live view is local, read-only, and leaves nothing behind |
| [0008](0008-a-recorded-run-is-evidence-and-must-be-asked-for.md) | Recording is opt-in, and a recorded run is one self-contained page |
| [0009](0009-a-refused-write-is-answered-not-dropped.md) | A write the policy refuses is answered with a 403, so the page's refusal handling runs |

## Writing a new one

Copy the shape of an existing record: **Context** (the situation and what went
wrong), **Decision** (what we do now), **Consequences** (what this costs us and
what we accept), and where relevant **Failure direction** — when a rule can err
in two directions, say which one is chosen and why. Number them sequentially and
add a row above. A superseded record stays; mark it and link its replacement.
