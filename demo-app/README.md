# Harbor — the SceneScout demo app

A small, invented order desk you can point SceneScout at without touching
anything real. No dependencies, in-memory data, loopback only.

It has three roles, picked on `/signin.html`: a **clerk** takes orders and asks
for approval on large ones, a **manager** approves or rejects them, and an
**auditor** reads everything, including the audit log, and changes nothing. A
visitor who has not picked one is a clerk. That gives a multi-role run a real
handoff to test, and its separate areas (orders, approvals, inventory,
customers, audit log, reports) give parallel agents something to split between
them. See [watching parallel agents](../README.md#-watching-a-run-live).

```bash
npm run demo:serve        # http://127.0.0.1:4173
```

Then, from Claude Code:

```
/scenescout --url http://127.0.0.1:4173
```

`npm run demo` does a scripted run instead and regenerates
[examples/report.md](../examples/report.md) and the screenshots beside it.
The app ships its own font (Inter, SIL Open Font License, in
`public/fonts/`), so the numbers in the report that come from layout are the
same on every platform. CI regenerates the report on Linux and fails if it
differs from the committed one. The screenshots are rendered by each
platform's own text rasteriser and can differ by a few pixels.

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
| Order | A fixed bar at the bottom covers the sticky Save notes row | Geometry oracle, by hit-testing the button's centre (visible in `examples/screenshots/order-detail.png`) |
| Approvals | The page hides Approve from anyone but a manager, but the approve endpoint accepts a clerk. Reject is checked properly | Calling the endpoint directly, as the agent does for any refusal shown only by a hidden button |
| Inventory | Sorting by quantity compares the numbers as text, so 10 comes before 9 | The agent's observation of the sorted column |
| Orders | The customer name is rendered as HTML, so an order whose customer is `<img src=x onerror=…>` runs script for everyone who opens the list (stored XSS) | The extensive level's fuzzing pass types markup into the New order form; it fires on the orders list, not in the form's own feedback, so the list is where to look |
| Order, Settings | Delete order and Delete workspace report success without reading the response: a clerk sees "Workspace deleted" after the server's 403 | Calling the endpoint as the clerk and comparing the page's message with the server's answer |
| Order, Settings (read-only mode) | The policy refusing the two Delete controls | Not a defect: it shows the read-only policy at work on destructive controls |
