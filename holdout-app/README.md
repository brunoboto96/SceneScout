# Fernbrook — the held-out benchmark app

A small, invented library loans desk. No dependencies, in-memory data,
loopback only. It is the benchmark's **held-out** app: SceneScout's engine,
skill and lane briefs are tuned against the [demo app](../demo-app/) and never
against this one, so a run here measures whether what was learned there
generalises. See [the held-out app](../docs/benchmark.md#the-held-out-app) in
docs/benchmark.md for the rules that keep it that way.

It has three roles, picked on `/signin.html`: a **member** borrows, renews and
places holds; a **librarian** checks books in and out and sees every member; a
**branch head** does everything a librarian does and can waive fines. A
visitor who has not picked one is a member.

```bash
npm run holdout:serve     # http://127.0.0.1:4180
```

Then run SceneScout against it with a fresh project directory, and score the
run against this app's key:

```bash
npm run bench -- /tmp/bench/holdout-1 --app holdout
npm run bench -- --archive /tmp/bench/holdout-1 --app holdout --run holdout-1 --note "what changed"
```

Restart the server between runs: loans, holds and reviews a run creates stay in
memory until it stops.

**If you are writing lane briefs for a run of this app, stop reading here.**
Do not open [answer-key.json](answer-key.json) or `server.mjs` either: a brief
written by someone who knows the answers measures the brief's author, not the
engine.

## What is planted (spoilers)

| Where | Defect | Level |
|---|---|---|
| Home | The notices request returns a 500 and the panel says "Loading notices…" forever | minimal |
| Account | "Download my data" sits below the bottom of a fixed-height panel that hides its overflow, so no one can reach it | minimal |
| Loans | The "overdue" tag is 1.84:1 against its background | minimal |
| Holds | The button that cancels a hold is an icon with no accessible name | minimal |
| Events | After joining an event, the confirmation page has no navigation and no way back | medium |
| Account | The member list refuses a member, but `/api/members/<id>` returns any member's record, contact details included. No page asks for another member's record, so this is found only by calling the endpoint directly with another id | medium |
| Catalogue | "Available now only" filters on copies owned, not copies on the shelf, so titles with every copy on loan stay | medium |
| Book | "Place hold" on a book with copies on the shelf does nothing and says nothing | medium |
| Loans | Renew stays enabled while it saves, so a double-click spends both renewals | medium |
| Check out | The page announces "Checked out" for any answer below 500, including the server's 409 for a member over the fine limit | medium |
| Book | Review text is rendered as HTML, so markup in a review runs for every reader (stored XSS) | extensive |
| Catalogue | The full list is cached in the tab's session storage on first load, so availability is stale after a checkout or a return | extensive |
| Catalogue | Search compiles the typed text as a regular expression, and `(` or `+` throws an uncaught error | extensive |
| Members, Fines | A member refused the member list, and a librarian refused a waiver | Not a defect: the server enforces both and the page says so |
