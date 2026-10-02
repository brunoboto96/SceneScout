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
| [0010](0010-a-confidence-is-checked-not-trusted.md) | A lane's confidence is checked, against what was filed and against a key, and disclosed where it cannot be |
| [0011](0011-a-gate-is-deterministic-and-fails-only-on-what-it-can-prove.md) | `scenescout check` involves no model, never writes, and fails by default only on what proves a page broken |
| [0012](0012-a-check-replays-saved-flows-and-reports-re-tests.md) | A check replays the flows saved in `.scenescout/flows` and fails on a broken step, and re-tests open findings a page load reproduces; what it may write, how a refused step ends and which re-tests gate are settings whose defaults never write and never hide a result |
| [0013](0013-a-convention-is-the-projects-to-decide.md) | What is a defect only under a project's convention is reported as "worth a look", naming the convention: never scored, counted as a defect or gated |
| [0014](0014-an-unattended-run-reports-and-never-gates.md) | `scenescout ci` drives the MCP server with a model's API and no person present; it reports and never gates, stops at the first cap reached and still writes the report, never prints a key, and runs `destructive` only with `--allow-destructive` as well |
| [0015](0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md) | A `/scenescout qa` comment tests the pull request's deployed preview: the job that holds the key checks out nothing and runs SceneScout from an exact release, reached only through a keyless gate that checks the commenter and refuses forks by default |
| [0016](0016-a-visual-baseline-changes-only-when-asked.md) | A visual baseline is a picture the project lists in `targets.json`, kept per browser with the settings it was taken with, in a git-ignored folder unless the project names one it commits; an unmet one is a high `visual-change` issue, and only `--baseline update` writes one |

## Writing a new one

Copy the shape of an existing record: **Context** (the situation and what went
wrong), **Decision** (what we do now), **Consequences** (what this costs us and
what we accept), and where relevant **Failure direction** — when a rule can err
in two directions, say which one is chosen and why. Number them sequentially and
add a row above. A superseded record stays; mark it and link its replacement.
