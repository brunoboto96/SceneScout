# How SceneScout works, stage by stage

This is the map of what happens during a run and where each decision is made.
It is written for someone changing the engine, not for someone using it — the
user-facing method lives in the skill, and the reasons behind the rules that
cost something live in [the ADRs](adr/).

Two things are worth holding in mind while reading:

- **The engine decides nothing about the app.** It reports render state,
  network facts and rule violations. Whether something is a defect, and how
  bad, is the agent's judgement. Every diagram below has that boundary in it.
- **The engine is not the slow part.** On a measured eight-lane run the median
  gap between one action and the next was 4 seconds, of which about 3 was the
  agent deciding what to do. The engine's own work per action is tens of
  milliseconds plus however long the page takes.

---

## 1. The run, end to end

```mermaid
flowchart TD
    A[scout_scan] -->|routes, framework, auth states| B[scout_attach]
    B -->|browser + write policy + memory| C[scout_note read]
    C --> D[scout_crawl]
    D -->|per-route health| E{crawl flagged<br/>anything?}
    E -->|yes| F[investigate:<br/>navigate, snapshot, reproduce]
    E -->|no| G[exercise + measure]
    F --> G
    G --> H[scout_design_audit<br/>per representative page]
    G --> I[scout_journey<br/>per primary task]
    G --> J[scout_run_plan<br/>mechanical sequences]
    H --> K[scout_finding]
    I --> K
    J --> K
    K --> L[scout_report]
    L --> M{gap ledger<br/>satisfies the level?}
    M -->|no| N[refused, names what is missing]
    N --> G
    M -->|yes| O[report.md + report.html]
    O --> P[scout_close]
```

The loop back from `N` is the point of the whole design: the report refuses
rather than papering over what was not done. See
[ADR 1](adr/0001-completion-is-a-contract-not-a-vibe.md).

---

## 2. Inside one action

Every acting tool — click, type, navigate, select, press, upload — runs the
same pipeline. This is where most of the engine's cleverness lives, and where
the subtle bugs have been.

```mermaid
flowchart TD
    A[tool called with a task] --> B{task stated?}
    B -->|no| C[REFUSED:<br/>a watcher would see<br/>clicking with no reason]
    B -->|yes| D[resolve ref to element]
    D --> E{write policy<br/>allows it?}
    E -->|no| F[blocked, reported as the<br/>tool's own safety net]
    E -->|yes| G[perform the action]
    G --> H[settle]
    H --> I[record a frame<br/>if recording]
    I --> J[scan for injections]
    J --> K[scan for contradictions]
    K --> L[drain oracle buffer]
    L --> M[format result:<br/>URL, mutations, violations]
```

### Settling: when is the page ready to read?

`waitForLoadState("networkidle")` latches once reached and then resolves
instantly forever, so it cannot be used to wait out the request an action just
fired. A flat sleep was used instead, and cost 54% of a snapshot's wall time.

```mermaid
flowchart TD
    A[action done] --> B{elapsed < paceMs?}
    B -->|yes| W[wait a tick]
    B -->|no| C{elapsed >= 2s cap?}
    C -->|yes| R[read the page]
    C -->|no| D{requests in flight?}
    D -->|yes| W
    D -->|no| E{quiet for 120ms<br/>since the last request<br/>AND since the action?}
    E -->|no| W
    E -->|yes| R
    W --> B
```

The quiet window runs from **the action as well as the last request**. A click
that posts to a service worker, which then fetches, makes no request of its
own — reading the page between the two blamed the next action for the worker's
request.

Separately, where a **bounce verdict** is about to be made — attach judging a
storage state, navigate judging coverage — the URL is watched until it holds
still. A client-side auth guard on a timer issues nothing until it fires, so
there is no request to wait on, and the gated route would be recorded as
reached.

---

## 3. The write policy

Enforced on the wire, not in the prompt, because a prompt is advice and a
route handler is a rule ([ADR 2](adr/0002-enforce-the-write-policy-at-the-network-layer.md)).

```mermaid
flowchart TD
    A[request leaves the page] --> B{method}
    B -->|GET / HEAD| P[allow]
    B -->|other| C{mode}
    C -->|observe| D{login or<br/>token refresh?}
    D -->|yes| P
    D -->|no| X[abort]
    C -->|read-only| E{PUT / PATCH / DELETE<br/>or destructive POST?}
    E -->|yes| X
    E -->|no| P
    C -->|safe-write| F{mutation on a record<br/>this session created?}
    F -->|yes| P
    F -->|no| G{plain create?}
    G -->|yes| P
    G -->|no| X
    C -->|destructive| P
    X --> Y[logged as a policy block,<br/>errors it causes are<br/>attributed to the tester]
```

The last box matters: aborting a request makes the browser print a console
error, and without attribution the tool's own safety net is reported as defects
of the app under test.

---

## 4. How something becomes a finding

The engine raises *violations*. The agent decides *findings*. The split is
deliberate.

```mermaid
flowchart TD
    subgraph engine [engine — mechanical]
        A1[console / page error]
        A2[failed request]
        A3[HTTP 4xx / 5xx]
        A4[typed markup rendered<br/>as an element]
        A5[refused request +<br/>page shows empty state]
        A6[refused write +<br/>page claims success]
    end
    A1 --> V[oracle violation]
    A2 --> V
    A3 --> V
    A4 --> V
    A5 --> V
    A6 --> V
    V --> B{policy-induced?}
    B -->|yes| C[attributed to the tester,<br/>counted, not reported]
    B -->|no| D[delivered with the<br/>action's result]
    D --> E[agent judges it]
    E --> F{claims something<br/>is ABSENT?}
    F -->|yes| G[ground it in the source first]
    F -->|no| H[severity + category + evidence]
    G --> H
    H --> I[scout_finding]
    I --> J{matches an existing<br/>finding's signature?}
    J -->|yes| K[merged, runs incremented]
    J -->|no| L[new finding]
```

`refused_empty` and `A6`'s `false_success` are the two that pair a precise half
with a fuzzy one: the request half is exact — a status code either is an error
or is not — and the page half is never enough alone. A page that shows an error
raises neither, which is why the false-positive rate stays low enough to report
at high severity.

Dedup is on machine signatures rather than prose, because titles get rephrased
between runs ([ADR 4](adr/0004-dedup-on-machine-signals-not-prose.md)).

---

## 5. A run split across parallel lanes

```mermaid
sequenceDiagram
    participant P as planner
    participant E as engine
    participant L as lane agent
    participant M as project memory

    P->>E: scout_crawl
    E-->>P: route knowledge complete
    P->>E: scout_lane_brief {lanes, goal}
    E-->>P: whole modules per lane,<br/>balanced, none owned twice
    P->>L: brief + lane-report instruction
    L->>E: scout_attach {session: lane}
    loop the lane's own routes
        L->>E: snapshot / audit / exercise
        L->>M: scout_finding
    end
    L-->>P: ONE typed JSON object
    P->>E: scout_lane_report {lane, reply}
    E->>E: schema check
    alt refused
        E-->>P: the reason, to relay once
    else accepted
        E->>M: keep the decisions
        E-->>P: one-line fold
    end
    P->>E: scout_close {session: lane}
```

**Order matters, and it is easy to get wrong.** The decisions are kept against
the lane's own session, so the fold has to happen **before** that session
closes. A lane that closes itself and then reports hands back decisions with
nowhere to write, and the tool says so rather than silently accepting.

The typed object is what makes the fold cheap: the planner counts rather than
reads, a lane's reply is a few hundred tokens whatever it found, and a value
the schema refuses is caught at the boundary instead of becoming a severity
like "Low-Medium" in the report.

---

## 6. Whether a lane's confidence meant anything

Asking for a calibrated number and never checking it is the half of the idea
that costs nothing and buys nothing. The check joins what a lane *said* to what
the project *filed*.

```mermaid
flowchart TD
    A[lane decision] --> B{verdict == defect?}
    B -->|no| Z[not a claim that can be<br/>right or wrong]
    B -->|yes| C{evidence names a<br/>FAILING endpoint?}
    C -->|no| U[unjoinable:<br/>counted and disclosed,<br/>NOT scored]
    C -->|yes| D{confidence usable<br/>0..1 and finite?}
    D -->|no| U
    D -->|yes| E[key on the store's own<br/>bug signature]
    E --> F{a finding carries<br/>the same key?}
    F -->|yes| G[filed]
    F -->|no| H[not filed]
    G --> I[bucket by stated confidence]
    H --> I
    I --> J[expected calibration error,<br/>weighted by bucket]
    J --> K{>= 8 checkable<br/>decisions?}
    K -->|no| L[say so; publish no figure]
    K -->|yes| M[publish the table]
```

The `unjoinable` branch is the one that took two review rounds to get right.
Falling back to matching the literal evidence text meant `500 on GET /api/r0` —
ordinary English, and whichever agent wrote the finding chose the word order —
produced a key that matched nothing, and a lane that was **right** about a bug
that **was** filed published an expected calibration error of 0.90.

What the figure is and is not:

- It measures agreement between the lanes and the bar the project applies, over
  its whole history. It is **not** evidence about the app.
- A lane can be perfectly calibrated against a planner that files the wrong
  things.
- A defect filed without a machine signature counts against the lane through no
  fault of its own, and so does one whose signature a merge discarded. Both are
  stated in the section.
- Verdicts from `scout_verify` are reported beside it and flagged as the half
  that **is** about the app.

---

## 7. What the gap ledger refuses

```mermaid
flowchart LR
    A[per-route facts] --> B[visited]
    A --> C[exercised]
    A --> D[audited]
    A --> E[mutated]
    A --> F[journeyed]
    G[per-role access] --> H[reached / denied<br/>per route]
    B & C & D & E & F & H --> I{level}
    I -->|minimal| J[every route visited<br/>+ 1 audit]
    I -->|medium| K[+ audits on several routes<br/>+ every interactable class<br/>+ forms valid AND invalid]
    I -->|extensive| L[+ fuzzing, keyboard pass,<br/>2 roles, auth surface,<br/>ledger EMPTY]
    J & K & L --> M{satisfied?}
    M -->|no| N[refuse, and name<br/>what is missing]
    M -->|yes| O[write the report]
```

A ledger entry has to be actionable, and a suppressed one has to be visible, or
the ledger stops being read at all
([ADR 3](adr/0003-a-noisy-ledger-is-a-broken-ledger.md)).

---

## Where each decision lives in the code

Logic that does not need Playwright is kept out of `browser.ts`, because that
is the one file a test cannot reach without launching a browser
([ADR 5](adr/0005-keep-testable-logic-out-of-the-browser-module.md)).

| Stage | Module | Tested by |
|---|---|---|
| Route and element identity | `fingerprint.ts` | `contract-test` |
| When to stop waiting | `settle.ts` | `settle-test` |
| What may leave the page | `policy.ts`, `ownership.ts` | `policy-test` |
| Page contradicts the server | `claims.ts` | `claims-test`, `smoke/contradiction` |
| Typed markup coming back as an element | `injection.ts` | `oracle-test`, `smoke/injection` |
| What a lane hands back | `lane.ts` | `lane-test` |
| Whether its confidence held up | `calibration.ts` | `calibration-test` |
| Splitting the app between lanes | `brief.ts` | `brief-test` |
| Re-testing what earlier runs left open | `verify.ts` | `verify-test` |
| How the run spent its time | `pace.ts` | `pace-test` |
| Calling the app's API as the session | `request.ts` | `request-test` |
| The live view's rules | `live.ts` | `live-test` |
