# Harbor — the SceneScout demo app

A small, invented order desk you can point SceneScout at without touching
anything real. No dependencies, in-memory data, loopback only.

```bash
npm run demo:serve        # http://127.0.0.1:4173
```

Then, from Claude Code:

```
/scenescout --url http://127.0.0.1:4173
```

`npm run demo` does a scripted run instead and regenerates
[examples/report.md](../examples/report.md) and the screenshots beside it.

## What is seeded (spoilers)

Stop here if you would rather see what a run finds on its own.

| Where | Defect | How SceneScout notices |
|---|---|---|
| Dashboard | Chart image returns 404 | HTTP and console oracles |
| Dashboard | A badge positioned with a negative offset covers the "All orders" button | Geometry oracle, from layout boxes |
| Orders | The Archived filter returns a 500, and the page shows an empty table | HTTP oracle; the empty table is the agent's observation |
| New order | Empty Customer: the submit does nothing and says nothing | Silent no-op detection on submit-style clicks |
| New order | Submit stays enabled: a double-click creates two orders | The double-click probe (`clicks: 2`) |
| New order | Hint text at 1.73:1 contrast | Design audit |
| New order | Email field has a placeholder but no label | Snapshot and crawl count it as unnamed |
| Reports | Export CSV throws | Page-error oracle |
| Reports → Scheduled | No navigation, no way back | Crawl flags a dead end |
| Order, Settings | Delete order / Delete workspace | Not defects: they show the read-only policy refusing destructive controls |

## What it deliberately does not catch

On the order page a fixed bar at the bottom of the viewport covers the sticky
"Save notes" row. It is visible in `examples/screenshots/order-detail.png`, and
the geometry oracle says nothing. That is by design: two pieces of fixed or
sticky chrome overlapping is almost always intentional layering, so the oracle
skips that pair to avoid flooding reports with false positives. This page is
the counter-example, kept here so the limit is documented rather than hidden.
