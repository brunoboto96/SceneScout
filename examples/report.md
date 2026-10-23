# SceneScout Report

Generated: (by `npm run demo`)

## Summary

SceneScout checked http://127.0.0.1:4173. This run found 12 problems: 5 block users, 4 are annoying and 3 are cosmetic. It went to 12 of the 12 pages it knew about.

| # | Impact | Problem | Where | What you'd see | What was expected |
|---:|---|---|---|---|---|
| 1 | Blocks users | Filtering orders by Archived fails, and the page shows an empty table instead of an error | /orders.html | The server refused or failed a request | The action completes, or the page says clearly why it could not. |
| 2 | Blocks users | Export CSV throws and nothing is downloaded | /reports.html | Something on the page broke while it was being used | The page keeps working while it is used. |
| 3 | Blocks users | A double-click on Create order creates two orders | /orders-new.html | The information shown does not add up | The same information agrees everywhere it is shown. |
| 4 | Blocks users | The Save notes button is covered by the bar at the bottom of the order page | /order.html?id=1042 | Something looks wrong on screen | Everything is visible, readable and in its place. |
| 5 | Blocks users | A clerk can approve an order by calling the endpoint the page hides from them | /approvals.html | Someone can see or do something they should not | Each person sees and does only what their role allows. |
| 6 | Annoying | The "New: bulk import" badge sits on top of the All orders button | / | Something looks wrong on screen | Everything is visible, readable and in its place. |
| 7 | Annoying | Scheduled reports is a dead end: no navigation and no way back | /reports-scheduled.html | A path led nowhere | Every link and button leads somewhere useful, with a way back. |
| 8 | Annoying | Submitting the new-order form without a customer does nothing and says nothing | /orders-new.html | Something is confusing to use | It is clear what to do and what happened. |
| 9 | Annoying | Sorting inventory by quantity puts 10 before 9 | /inventory.html | The information shown does not add up | The same information agrees everywhere it is shown. |
| 10 | Cosmetic | The dashboard chart image is missing | / | A request to the server did not get through | The page loads what it needs, or says what is missing. |
| 11 | Cosmetic | Helper text under Customer is too faint to read | /orders-new.html | Something looks wrong on screen | Everything is visible, readable and in its place. |
| 12 | Cosmetic | The confirmation email field has no label, only a placeholder | /orders-new.html | Something feels unfinished | The page looks finished and consistent. |

While it worked, the automatic checks noticed:

- The server refused or failed a request (4 times)
- The page reported an error behind the scenes (4 times)
- The server refused a request and the page showed nothing instead of an error (once)
- Something on the page broke while it was being used (once)
- The page said something worked when the server had refused it (once)

The run left 3 things unchecked. The technical details list which.

### The tickets

This run was given 1 ticket with 5 acceptance criteria: 1 passed, 3 failed and 1 was not tested.

#### HAR-12: Find, export and approve orders

| | Acceptance criterion | Result |
|---|---|---|
| AC1 | Given I am on the orders page, when I choose Archived in the status filter, then the archived orders are listed | Failed: "Filtering orders by Archived fails, and the page shows an empty table instead of an error" (problem 1 below) |
| AC2 | Export CSV on the reports page downloads the report as a file | Failed: "Export CSV throws and nothing is downloaded" (problem 2 below) |
| AC3 | A clerk cannot approve an order | Failed: "A clerk can approve an order by calling the endpoint the page hides from them" (problem 5 below) |
| AC4 | A manager can approve an order from the approvals queue | Not tested: the account the run used could not reach this part of the site |
| AC5 | The order page shows each order's notes | Passed |

### Each problem

Open a problem for the steps to see it, what was expected and what happened.

<details><summary>1. Filtering orders by Archived fails, and the page shows an empty table instead of an error</summary>

**Blocks users** · The server refused or failed a request · on http://127.0.0.1:4173/orders.html

**What was done:**

1. Go to http://127.0.0.1:4173/orders.html
2. Choose "archived" in the "Status" list

**What was expected:** The action completes, or the page says clearly why it could not.

**What happened:** Choosing Status → Archived makes the orders request fail with a 500. The table is then drawn empty with no message, so the user reads "there are no archived orders" when the truth is "the request failed". The other filter values work.

<details><summary>Details for developers</summary>

- **Finding id:** `3a2ff88caa` · **Category:** http-error · **Severity:** high
- **Evidence:** `GET /api/orders?status=archived → HTTP 500`
- **Route:** `/orders.html#27836947`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>2. Export CSV throws and nothing is downloaded</summary>

**Blocks users** · Something on the page broke while it was being used · on http://127.0.0.1:4173/reports.html

**What was done:**

1. Go to http://127.0.0.1:4173/reports.html
2. Click the "Export CSV" button

**What was expected:** The page keeps working while it is used.

**What happened:** Clicking Export CSV raises an uncaught exception. No file is produced and the page gives no feedback, so the button appears to do nothing.

<details><summary>Details for developers</summary>

- **Finding id:** `b7d6ac97d5` · **Category:** page-error · **Severity:** high
- **Evidence:** `Cannot read properties of undefined (reading 'rows')`
- **Route:** `/reports.html#f54fce55`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>3. A double-click on Create order creates two orders</summary>

**Blocks users** · The information shown does not add up · on http://127.0.0.1:4173/orders-new.html

**What was done:**

1. Go to http://127.0.0.1:4173/
2. Click the "New order" link
3. Click the "Create order" button
4. Type "Alder &amp; Pine Outfitters" into the "Customer" field
5. Double-click the "Create order" button

**What was expected:** The same information agrees everywhere it is shown.

**What happened:** The submit button stays enabled while the request is in flight, and the endpoint accepts the repeat. One impatient double-click produced two identical POSTs and two orders. Disable the button during submit, and make the create idempotent.

<details><summary>Details for developers</summary>

- **Finding id:** `d6c0292dc5` · **Category:** data-inconsistency · **Severity:** high
- **Evidence:** `2× click fired the same state-changing request 2× (POST /api/orders)`
- **Route:** `/orders-new.html#18f9a265`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>4. The Save notes button is covered by the bar at the bottom of the order page</summary>

**Blocks users** · Something looks wrong on screen · on http://127.0.0.1:4173/order.html?id=1042

**What was done:**

1. Go to http://127.0.0.1:4173/order.html?id=1042

**What was expected:** Everything is visible, readable and in its place.

**What happened:** The save row is sticky at the bottom of the viewport, and a fixed bar added later sits on top of it. The button is present, labelled and enabled, but it cannot be seen, and a click aimed at it lands on the bar. It only becomes reachable after scrolling to the very end of the page. Found by hit-testing the button's centre, since box overlap cannot tell which of two pinned elements is on top.

<details><summary>Details for developers</summary>

- **Finding id:** `4b4653ff43` · **Category:** visual · **Severity:** high
- **Evidence:** `"Save notes" is COVERED by pinned chrome [order-stickybar]`
- **Route:** `/order.html#a849e7f9`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>5. A clerk can approve an order by calling the endpoint the page hides from them</summary>

**Blocks users** · Someone can see or do something they should not · on http://127.0.0.1:4173/approvals.html

**What was done:**

1. Go to http://127.0.0.1:4173/approvals.html

**What was expected:** Each person sees and does only what their role allows.

**What happened:** The Approvals page shows Approve and Reject only to a manager. Reject is also refused by the server for anyone else, but Approve is not: a clerk who posts to it directly gets the order approved, and the audit log records a clerk approving. Hiding the button was the only control. The two sibling endpoints disagree, which is also the fix: give approve the check reject already has.

<details><summary>Details for developers</summary>

- **Finding id:** `77d8b89e0d` · **Category:** permission-leak · **Severity:** high
- **Evidence:** `POST /api/orders/1037/approve 200 as clerk; POST /api/orders/1038/reject 403 as clerk`
- **Route:** `/approvals.html#d873a260`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>6. The "New: bulk import" badge sits on top of the All orders button</summary>

**Annoying** · Something looks wrong on screen · on http://127.0.0.1:4173/

**What was done:**

1. Go to http://127.0.0.1:4173/

**What was expected:** Everything is visible, readable and in its place.

**What happened:** On the dashboard the badge overlaps most of the All orders button, hiding its label and taking the clicks aimed at it. The geometry oracle measured the overlap from layout boxes; no screenshot was needed to find it.

<details><summary>Details for developers</summary>

- **Finding id:** `771dfd963f` · **Category:** visual · **Severity:** medium
- **Evidence:** `"All orders" overlaps "New: bulk import" (81%)`
- **Route:** `/#225cf81c`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>7. Scheduled reports is a dead end: no navigation and no way back</summary>

**Annoying** · A path led nowhere · on http://127.0.0.1:4173/reports-scheduled.html

**What was done:**

1. Go to http://127.0.0.1:4173/reports-scheduled.html

**What was expected:** Every link and button leads somewhere useful, with a way back.

**What happened:** The page reached from Reports → Scheduled reports has no header, no links and no controls. The only way out is the browser's back button. The crawl flagged it as a dead end with 0 interactable elements.

<details><summary>Details for developers</summary>

- **Finding id:** `feaaf4fc43` · **Category:** dead-end · **Severity:** medium
- **Evidence:** `/reports-scheduled.html — 200 · 0 el · DEAD-END`
- **Route:** `/reports-scheduled.html#e3b0c442`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>8. Submitting the new-order form without a customer does nothing and says nothing</summary>

**Annoying** · Something is confusing to use · on http://127.0.0.1:4173/orders-new.html

**What was done:**

1. Go to http://127.0.0.1:4173/
2. Click the "New order" link
3. Click the "Create order" button

**What was expected:** It is clear what to do and what happened.

**What happened:** With Customer empty, Create order sends no request, shows no validation message and does not move focus to the field. A first-time user cannot tell whether the click registered.

<details><summary>Details for developers</summary>

- **Finding id:** `8a1dba9d2c` · **Category:** ux-confusing · **Severity:** medium
- **Evidence:** `submit-style click fired ZERO network requests and no navigation`
- **Route:** `/orders-new.html#18f9a265`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>9. Sorting inventory by quantity puts 10 before 9</summary>

**Annoying** · The information shown does not add up · on http://127.0.0.1:4173/inventory.html

**What was done:**

1. Go to http://127.0.0.1:4173/inventory.html
2. Click the "Quantity" button

**What was expected:** The same information agrees everywhere it is shown.

**What happened:** Quantity is compared as text, so the column orders by first digit. Pallet wrap (3 on hand) and Shipping labels (9) land at the bottom of an ascending sort, which is exactly where someone scanning for low stock does not look.

<details><summary>Details for developers</summary>

- **Finding id:** `5bb7d90080` · **Category:** data-inconsistency · **Severity:** medium
- **Evidence:** `sorted by quantity: 10, 120, 250, 3, 64, 9`
- **Route:** `/inventory.html#dce38639`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>10. The dashboard chart image is missing</summary>

**Cosmetic** · A request to the server did not get through · on http://127.0.0.1:4173/

**What was done:**

1. Go to http://127.0.0.1:4173/

**What was expected:** The page loads what it needs, or says what is missing.

**What happened:** The "This week" chart never loads. The page still works, but the largest element above the fold is a broken image, and the 404 adds a console error to every dashboard visit.

<details><summary>Details for developers</summary>

- **Finding id:** `22bbb66b5a` · **Category:** network · **Severity:** low
- **Evidence:** `GET /img/weekly-chart.png → HTTP 404`
- **Route:** `/#225cf81c`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>11. Helper text under Customer is too faint to read</summary>

**Cosmetic** · Something looks wrong on screen · on http://127.0.0.1:4173/orders-new.html

**What was done:**

1. Go to http://127.0.0.1:4173/orders-new.html

**What was expected:** Everything is visible, readable and in its place.

**What happened:** The hint below the Customer field fails WCAG contrast by a wide margin. The same .hint style is likely used on other forms.

<details><summary>Details for developers</summary>

- **Finding id:** `648a490ad6` · **Category:** visual · **Severity:** low
- **Evidence:** `1.73:1 (needs 4.5:1) rgba(184, 192, 202, 1) on rgb(246, 248, 250)`
- **Route:** `/orders-new.html#18f9a265`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

<details><summary>12. The confirmation email field has no label, only a placeholder</summary>

**Cosmetic** · Something feels unfinished · on http://127.0.0.1:4173/orders-new.html

**What was done:**

1. Go to http://127.0.0.1:4173/orders-new.html

**What was expected:** The page looks finished and consistent.

**What happened:** The field is announced to assistive technology without a name, and the placeholder disappears as soon as the user types. The crawl counted it as the one unnamed control on this page.

<details><summary>Details for developers</summary>

- **Finding id:** `ddaf4b74cd` · **Category:** ux-polish · **Severity:** low
- **Evidence:** `/orders-new.html — 200 · 12 el · 1 unnamed`
- **Route:** `/orders-new.html#18f9a265`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

</details>

## Technical details

<details><summary>For developers: run metrics, page scores, the gap ledger, each finding with its requests, route, id and a test skeleton, and what was left unexplored.</summary>

## Run metrics

| Metric | Value |
|---|---|
| Open findings | 12 (5 high) — 12 seen this session, 0 historical |
| Route coverage | 12/12 |
| States explored | 12 |
| Design audits this run (all sessions) | 3 |
| Oracle violations this session | 11 |
| Errors caused by the tester's own write-policy blocks (not counted above) | 2 |
| Elements exercised (informational — denominator grows with every state) | 7/44 |

## Acceptance criteria

Each verdict is the agent's judgement, recorded with `scout_criterion` and its confidence; the link from a criterion to a finding is that judgement, not a match on words. A fail from any session decides a criterion, and a criterion no session judged is listed as not judged.

### HAR-12: Find, export and approve orders

Read from HAR-12.md.

| Id | Criterion | Verdict | Confidence | Findings | Why | Judged by |
|---|---|---|---:|---|---|---|
| AC1 | Given I am on the orders page, when I choose Archived in the status filter, then the archived orders are listed | fail | 0.95 | `3a2ff88caa` | Choosing Archived fails with a 500 and the table is drawn empty. | default |
| AC2 | Export CSV on the reports page downloads the report as a file | fail | 0.90 | `b7d6ac97d5` | Export CSV throws and no file is downloaded. | default |
| AC3 | A clerk cannot approve an order | fail | 0.90 | `77d8b89e0d` | The button is hidden, but the approve endpoint accepts a clerk. | default |
| AC4 | A manager can approve an order from the approvals queue | not tested (no-access) | 1.00 | — | The run was signed in as a clerk, and approving needs a manager. | default |
| AC5 | The order page shows each order's notes | pass | 0.80 | — | Order 1042 shows its notes; saving them is a separate finding. | default |

## Page quality scores (worst first)

| Route | Overall | A11y | Craft | Consistency | Task clarity | Audited |
|---|---|---|---|---|---|---|
| `/orders-new.html` | **91** | 88 | 100 | 94 | 100 | (run date) |
| `/` | **97** | 100 | 100 | 94 | 100 | (run date) |
| `/order.html` | **97** | 100 | 100 | 94 | 100 | (run date) |

## Gap ledger — what was NOT tested

- ⚠ 3 of 12 known route(s) visited this run but NOTHING exercised (looked at, never touched): /approvals.html, /settings.html, /signin.html
- ⚠ 9 of 12 known route(s) visited this run and never design-audited: /orders.html, /approvals.html, /inventory.html, /customers.html, /reports.html, /audit.html, /settings.html, /signin.html …
- ⚠ single-role run (anonymous) — permission boundaries and role capability gaps are untested

## Findings — seen this session (12)

### 🔴 [HIGH] Filtering orders by Archived fails, and the page shows an empty table instead of an error

- **Id:** `3a2ff88caa` · **Category:** http-error
- **Evidence:** `GET /api/orders?status=archived → HTTP 500`
- **Where:** `/orders.html#27836947` (http://127.0.0.1:4173/orders.html)
- **Seen in runs:** 1

Choosing Status → Archived makes the orders request fail with a 500. The table is then drawn empty with no message, so the user reads "there are no archived orders" when the truth is "the request failed". The other filter values work.

**Repro trace (last actions before finding):**

1. crawl /reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
2. navigate http://127.0.0.1:4173/orders.html @ http://127.0.0.1:4173/orders.html
3. snapshot @ http://127.0.0.1:4173/orders.html
4. select combobox "Status" = archived @ http://127.0.0.1:4173/orders.html
5. screenshot @ http://127.0.0.1:4173/orders.html

```ts
test("regression: Filtering orders by Archived fails, and the page shows an empty table instead of an error", async ({ page }) => {
  await page.goto("/orders.html");
  // crawl /reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
  // navigate http://127.0.0.1:4173/orders.html @ http://127.0.0.1:4173/orders.html
  // snapshot @ http://127.0.0.1:4173/orders.html
  // select combobox "Status" = archived @ http://127.0.0.1:4173/orders.html
  // screenshot @ http://127.0.0.1:4173/orders.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🔴 [HIGH] Export CSV throws and nothing is downloaded

- **Id:** `b7d6ac97d5` · **Category:** page-error
- **Evidence:** `Cannot read properties of undefined (reading 'rows')`
- **Where:** `/reports.html#f54fce55` (http://127.0.0.1:4173/reports.html)
- **Seen in runs:** 1

Clicking Export CSV raises an uncaught exception. No file is produced and the page gives no feedback, so the button appears to do nothing.

**Repro trace (last actions before finding):**

1. screenshot @ http://127.0.0.1:4173/orders.html
2. navigate http://127.0.0.1:4173/reports.html @ http://127.0.0.1:4173/reports.html
3. snapshot @ http://127.0.0.1:4173/reports.html
4. click button "Export CSV" @ http://127.0.0.1:4173/reports.html

```ts
test("regression: Export CSV throws and nothing is downloaded", async ({ page }) => {
  await page.goto("/reports.html");
  // screenshot @ http://127.0.0.1:4173/orders.html
  // navigate http://127.0.0.1:4173/reports.html @ http://127.0.0.1:4173/reports.html
  // snapshot @ http://127.0.0.1:4173/reports.html
  // click button "Export CSV" @ http://127.0.0.1:4173/reports.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🔴 [HIGH] A double-click on Create order creates two orders

- **Id:** `d6c0292dc5` · **Category:** data-inconsistency
- **Evidence:** `2× click fired the same state-changing request 2× (POST /api/orders)`
- **Where:** `/orders-new.html#18f9a265` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

The submit button stays enabled while the request is in flight, and the endpoint accepts the repeat. One impatient double-click produced two identical POSTs and two orders. Disable the button during submit, and make the create idempotent.

**Repro trace (last actions before finding):**

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html
5. snapshot @ http://127.0.0.1:4173/orders-new.html
6. type textbox "Customer" ← "Alder &amp; Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
7. snapshot @ http://127.0.0.1:4173/orders-new.html
8. click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
9. screenshot @ http://127.0.0.1:4173/orders-new.html

```ts
test("regression: A double-click on Create order creates two orders", async ({ page }) => {
  await page.goto("/orders-new.html");
  // journey:start create an order for a new customer @ http://127.0.0.1:4173/
  // click link "New order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // type textbox "Customer" ← "Alder & Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // screenshot @ http://127.0.0.1:4173/orders-new.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🔴 [HIGH] The Save notes button is covered by the bar at the bottom of the order page

- **Id:** `4b4653ff43` · **Category:** visual
- **Evidence:** `"Save notes" is COVERED by pinned chrome [order-stickybar]`
- **Where:** `/order.html#a849e7f9` (http://127.0.0.1:4173/order.html?id=1042)
- **Seen in runs:** 1

The save row is sticky at the bottom of the viewport, and a fixed bar added later sits on top of it. The button is present, labelled and enabled, but it cannot be seen, and a click aimed at it lands on the bar. It only becomes reachable after scrolling to the very end of the page. Found by hit-testing the button's centre, since box overlap cannot tell which of two pinned elements is on top.

**Repro trace (last actions before finding):**

1. design-audit @ http://127.0.0.1:4173/orders-new.html
2. navigate http://127.0.0.1:4173/order.html?id=1042 @ http://127.0.0.1:4173/order.html?id=1042
3. snapshot @ http://127.0.0.1:4173/order.html?id=1042
4. screenshot @ http://127.0.0.1:4173/order.html?id=1042

```ts
test("regression: The Save notes button is covered by the bar at the bottom of the order page", async ({ page }) => {
  await page.goto("/order.html?id=1042");
  // design-audit @ http://127.0.0.1:4173/orders-new.html
  // navigate http://127.0.0.1:4173/order.html?id=1042 @ http://127.0.0.1:4173/order.html?id=1042
  // snapshot @ http://127.0.0.1:4173/order.html?id=1042
  // screenshot @ http://127.0.0.1:4173/order.html?id=1042
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🔴 [HIGH] A clerk can approve an order by calling the endpoint the page hides from them

- **Id:** `77d8b89e0d` · **Category:** permission-leak
- **Evidence:** `POST /api/orders/1037/approve 200 as clerk; POST /api/orders/1038/reject 403 as clerk`
- **Where:** `/approvals.html#d873a260` (http://127.0.0.1:4173/approvals.html)
- **Seen in runs:** 1

The Approvals page shows Approve and Reject only to a manager. Reject is also refused by the server for anyone else, but Approve is not: a clerk who posts to it directly gets the order approved, and the audit log records a clerk approving. Hiding the button was the only control. The two sibling endpoints disagree, which is also the fix: give approve the check reject already has.

**Repro trace (last actions before finding):**

1. click:refused Delete workspace @ http://127.0.0.1:4173/settings.html
2. navigate http://127.0.0.1:4173/approvals.html @ http://127.0.0.1:4173/approvals.html
3. snapshot @ http://127.0.0.1:4173/approvals.html

```ts
test("regression: A clerk can approve an order by calling the endpoint the page hides from them", async ({ page }) => {
  await page.goto("/approvals.html");
  // click:refused Delete workspace @ http://127.0.0.1:4173/settings.html
  // navigate http://127.0.0.1:4173/approvals.html @ http://127.0.0.1:4173/approvals.html
  // snapshot @ http://127.0.0.1:4173/approvals.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟠 [MEDIUM] The "New: bulk import" badge sits on top of the All orders button

- **Id:** `771dfd963f` · **Category:** visual
- **Evidence:** `"All orders" overlaps "New: bulk import" (81%)`
- **Where:** `/#225cf81c` (http://127.0.0.1:4173/)
- **Seen in runs:** 1

On the dashboard the badge overlaps most of the All orders button, hiding its label and taking the clicks aimed at it. The geometry oracle measured the overlap from layout boxes; no screenshot was needed to find it.

**Repro trace (last actions before finding):**

1. attach @ http://127.0.0.1:4173/
2. snapshot @ http://127.0.0.1:4173/
3. screenshot @ http://127.0.0.1:4173/

```ts
test("regression: The \"New: bulk import\" badge sits on top of the All orders button", async ({ page }) => {
  await page.goto("/");
  // attach @ http://127.0.0.1:4173/
  // snapshot @ http://127.0.0.1:4173/
  // screenshot @ http://127.0.0.1:4173/
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟠 [MEDIUM] Scheduled reports is a dead end: no navigation and no way back

- **Id:** `feaaf4fc43` · **Category:** dead-end
- **Evidence:** `/reports-scheduled.html — 200 · 0 el · DEAD-END`
- **Where:** `/reports-scheduled.html#e3b0c442` (http://127.0.0.1:4173/reports-scheduled.html)
- **Seen in runs:** 1

The page reached from Reports → Scheduled reports has no header, no links and no controls. The only way out is the browser's back button. The crawl flagged it as a dead end with 0 interactable elements.

**Repro trace (last actions before finding):**

1. click button "Export CSV" @ http://127.0.0.1:4173/reports.html
2. navigate http://127.0.0.1:4173/reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
3. snapshot @ http://127.0.0.1:4173/reports-scheduled.html

```ts
test("regression: Scheduled reports is a dead end: no navigation and no way back", async ({ page }) => {
  await page.goto("/reports-scheduled.html");
  // click button "Export CSV" @ http://127.0.0.1:4173/reports.html
  // navigate http://127.0.0.1:4173/reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
  // snapshot @ http://127.0.0.1:4173/reports-scheduled.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟠 [MEDIUM] Submitting the new-order form without a customer does nothing and says nothing

- **Id:** `8a1dba9d2c` · **Category:** ux-confusing
- **Evidence:** `submit-style click fired ZERO network requests and no navigation`
- **Where:** `/orders-new.html#18f9a265` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

With Customer empty, Create order sends no request, shows no validation message and does not move focus to the field. A first-time user cannot tell whether the click registered.

**Repro trace (last actions before finding):**

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html

```ts
test("regression: Submitting the new-order form without a customer does nothing and says nothing", async ({ page }) => {
  await page.goto("/orders-new.html");
  // journey:start create an order for a new customer @ http://127.0.0.1:4173/
  // click link "New order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟠 [MEDIUM] Sorting inventory by quantity puts 10 before 9

- **Id:** `5bb7d90080` · **Category:** data-inconsistency
- **Evidence:** `sorted by quantity: 10, 120, 250, 3, 64, 9`
- **Where:** `/inventory.html#dce38639` (http://127.0.0.1:4173/inventory.html)
- **Seen in runs:** 1

Quantity is compared as text, so the column orders by first digit. Pallet wrap (3 on hand) and Shipping labels (9) land at the bottom of an ascending sort, which is exactly where someone scanning for low stock does not look.

**Repro trace (last actions before finding):**

1. snapshot @ http://127.0.0.1:4173/approvals.html
2. navigate http://127.0.0.1:4173/inventory.html @ http://127.0.0.1:4173/inventory.html
3. snapshot @ http://127.0.0.1:4173/inventory.html
4. click button "Quantity" @ http://127.0.0.1:4173/inventory.html

```ts
test("regression: Sorting inventory by quantity puts 10 before 9", async ({ page }) => {
  await page.goto("/inventory.html");
  // snapshot @ http://127.0.0.1:4173/approvals.html
  // navigate http://127.0.0.1:4173/inventory.html @ http://127.0.0.1:4173/inventory.html
  // snapshot @ http://127.0.0.1:4173/inventory.html
  // click button "Quantity" @ http://127.0.0.1:4173/inventory.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟡 [LOW] The dashboard chart image is missing

- **Id:** `22bbb66b5a` · **Category:** network
- **Evidence:** `GET /img/weekly-chart.png → HTTP 404`
- **Where:** `/#225cf81c` (http://127.0.0.1:4173/)
- **Seen in runs:** 1

The "This week" chart never loads. The page still works, but the largest element above the fold is a broken image, and the 404 adds a console error to every dashboard visit.

**Repro trace (last actions before finding):**

1. attach @ http://127.0.0.1:4173/
2. snapshot @ http://127.0.0.1:4173/
3. screenshot @ http://127.0.0.1:4173/

```ts
test("regression: The dashboard chart image is missing", async ({ page }) => {
  await page.goto("/");
  // attach @ http://127.0.0.1:4173/
  // snapshot @ http://127.0.0.1:4173/
  // screenshot @ http://127.0.0.1:4173/
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟡 [LOW] Helper text under Customer is too faint to read

- **Id:** `648a490ad6` · **Category:** visual
- **Evidence:** `1.73:1 (needs 4.5:1) rgba(184, 192, 202, 1) on rgb(246, 248, 250)`
- **Where:** `/orders-new.html#18f9a265` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

The hint below the Customer field fails WCAG contrast by a wide margin. The same .hint style is likely used on other forms.

**Repro trace (last actions before finding):**

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html
5. snapshot @ http://127.0.0.1:4173/orders-new.html
6. type textbox "Customer" ← "Alder &amp; Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
7. snapshot @ http://127.0.0.1:4173/orders-new.html
8. click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
9. screenshot @ http://127.0.0.1:4173/orders-new.html
10. journey:end create an order for a new customer @ http://127.0.0.1:4173/orders-new.html
11. navigate http://127.0.0.1:4173/orders-new.html @ http://127.0.0.1:4173/orders-new.html
12. design-audit @ http://127.0.0.1:4173/orders-new.html

```ts
test("regression: Helper text under Customer is too faint to read", async ({ page }) => {
  await page.goto("/orders-new.html");
  // journey:start create an order for a new customer @ http://127.0.0.1:4173/
  // click link "New order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // type textbox "Customer" ← "Alder & Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // screenshot @ http://127.0.0.1:4173/orders-new.html
  // journey:end create an order for a new customer @ http://127.0.0.1:4173/orders-new.html
  // navigate http://127.0.0.1:4173/orders-new.html @ http://127.0.0.1:4173/orders-new.html
  // design-audit @ http://127.0.0.1:4173/orders-new.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🟡 [LOW] The confirmation email field has no label, only a placeholder

- **Id:** `ddaf4b74cd` · **Category:** ux-polish
- **Evidence:** `/orders-new.html — 200 · 12 el · 1 unnamed`
- **Where:** `/orders-new.html#18f9a265` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

The field is announced to assistive technology without a name, and the placeholder disappears as soon as the user types. The crawl counted it as the one unnamed control on this page.

**Repro trace (last actions before finding):**

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html
5. snapshot @ http://127.0.0.1:4173/orders-new.html
6. type textbox "Customer" ← "Alder &amp; Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
7. snapshot @ http://127.0.0.1:4173/orders-new.html
8. click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
9. screenshot @ http://127.0.0.1:4173/orders-new.html
10. journey:end create an order for a new customer @ http://127.0.0.1:4173/orders-new.html
11. navigate http://127.0.0.1:4173/orders-new.html @ http://127.0.0.1:4173/orders-new.html
12. design-audit @ http://127.0.0.1:4173/orders-new.html

```ts
test("regression: The confirmation email field has no label, only a placeholder", async ({ page }) => {
  await page.goto("/orders-new.html");
  // journey:start create an order for a new customer @ http://127.0.0.1:4173/
  // click link "New order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // type textbox "Customer" ← "Alder & Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
  // snapshot @ http://127.0.0.1:4173/orders-new.html
  // click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
  // screenshot @ http://127.0.0.1:4173/orders-new.html
  // journey:end create an order for a new customer @ http://127.0.0.1:4173/orders-new.html
  // navigate http://127.0.0.1:4173/orders-new.html @ http://127.0.0.1:4173/orders-new.html
  // design-audit @ http://127.0.0.1:4173/orders-new.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

## Oracle violation rollup (11 events, 7 distinct signatures)

| Count | Signature |
|---|---|
| 3 | `http_error: GET http://:n.:n.:n.:n::n/img/weekly-chart.png → HTTP :n` |
| 3 | `console_error: Failed to load resource: the server responded with a status of :n (Not Found)` |
| 1 | `http_error: GET http://:n.:n.:n.:n::n/api/orders?status=archived → HTTP :n` |
| 1 | `console_error: Failed to load resource: the server responded with a status of :n (Internal Server Error)` |
| 1 | `refused_empty: GET /api/orders?status=archived :n was refused, and the page shows an empty list (:n) with no error. The user is told there is nothing to se` |
| 1 | `page_error: Cannot read properties of undefined (reading 'rows')` |
| 1 | `false_success: PUT /api/orders/:n :n was refused, and the page says "Saved.". The user is told their change was kept when the server rejected it. The refus` |

## Unexplored surface (for the next run)

- `/`: tid:dash-all-orders
- `/orders.html`: tid:orders-new-btn, tid:order-link-1042, tid:order-link-1041, tid:order-link-1040, tid:order-link-1039, tid:order-link-1038, tid:order-link-1037
- `/approvals.html`: tid:approvals-order-link-1038, tid:approvals-order-link-1037
- `/inventory.html`: tid:inventory-sort-name
- `/reports.html`: tid:reports-scheduled-link
- `/settings.html`: tid:settings-name, tid:settings-timezone, tid:settings-save, tid:settings-delete-workspace
- `/signin.html`: tid:signin-role-clerk, tid:signin-role-manager, tid:signin-role-auditor
- `/orders-new.html`: tid:new-order-items, tid:new-order-email, tid:new-order-cancel
- `/order.html`: tid:order-back, tid:order-request-approval, tid:order-notes, tid:order-delete, link:line items are edited from the list
- `(shared layout chrome)`: tid:nav-logo, tid:nav-dashboard, tid:nav-orders, tid:nav-approvals, tid:nav-inventory, tid:nav-customers, tid:nav-reports, tid:nav-audit … +2

</details>
