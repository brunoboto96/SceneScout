# SceneScout Report

Generated: (by `npm run demo`)

## Summary

| Metric | Value |
|---|---|
| Open findings | 12 (5 high) — 12 seen this session, 0 historical |
| Route coverage | 12/12 |
| States explored | 12 |
| Design audits this session | 3 |
| Oracle violations this session | 11 |
| Errors caused by the tester's own write-policy blocks (not counted above) | 2 |
| Elements exercised (informational — denominator grows with every state) | 7/74 |

## Page quality scores (worst first)

| Route | Overall | A11y | Craft | Consistency | Task clarity | Audited |
|---|---|---|---|---|---|---|
| `/orders-new.html` | **97** | 96 | 100 | 90 | 100 | (run date) |
| `/` | **98** | 100 | 100 | 90 | 100 | (run date) |
| `/order.html` | **98** | 100 | 100 | 90 | 100 | (run date) |

## Gap ledger — what was NOT tested

- ⚠ 5 route(s) visited but NOTHING exercised (looked at, never touched): /approvals.html, /customers.html, /audit.html, /settings.html, /signin.html
- ⚠ 9/12 visited route(s) never design-audited: /orders.html, /approvals.html, /inventory.html, /customers.html, /reports.html, /audit.html, /settings.html, /signin.html …
- ⚠ single-role run (anonymous) — permission boundaries and role capability gaps are untested

## Findings — seen this session (12)

### 🔴 [HIGH] Filtering orders by Archived fails, and the page shows an empty table instead of an error

- **Id:** `c50c538255` · **Category:** http-error
- **Evidence:** `GET /api/orders?status=archived → HTTP 500`
- **Where:** `/orders.html#0889e04e` (http://127.0.0.1:4173/orders.html)
- **Seen in runs:** 1

Choosing Status → Archived makes the orders request fail with a 500. The table is then drawn empty with no message, so the user reads "there are no archived orders" when the truth is "the request failed". The other filter values work.

<details><summary>Repro trace (last actions before finding)</summary>

1. crawl /reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
2. navigate http://127.0.0.1:4173/orders.html @ http://127.0.0.1:4173/orders.html
3. snapshot @ http://127.0.0.1:4173/orders.html
4. select combobox "All Open Shipped Awaiting approval Approved Rejected Archived" = archived @ http://127.0.0.1:4173/orders.html
5. screenshot @ http://127.0.0.1:4173/orders.html

</details>

```ts
test("regression: Filtering orders by Archived fails, and the page shows an empty table instead of an error", async ({ page }) => {
  await page.goto("/orders.html");
  // crawl /reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
  // navigate http://127.0.0.1:4173/orders.html @ http://127.0.0.1:4173/orders.html
  // snapshot @ http://127.0.0.1:4173/orders.html
  // select combobox "All Open Shipped Awaiting approval Approved Rejected Archived" = archived @ http://127.0.0.1:4173/orders.html
  // screenshot @ http://127.0.0.1:4173/orders.html
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});
```

### 🔴 [HIGH] Export CSV throws and nothing is downloaded

- **Id:** `ac9d3c1ba2` · **Category:** page-error
- **Evidence:** `Cannot read properties of undefined (reading 'rows')`
- **Where:** `/reports.html#fa7ea8fc` (http://127.0.0.1:4173/reports.html)
- **Seen in runs:** 1

Clicking Export CSV raises an uncaught exception. No file is produced and the page gives no feedback, so the button appears to do nothing.

<details><summary>Repro trace (last actions before finding)</summary>

1. screenshot @ http://127.0.0.1:4173/orders.html
2. navigate http://127.0.0.1:4173/reports.html @ http://127.0.0.1:4173/reports.html
3. snapshot @ http://127.0.0.1:4173/reports.html
4. click button "Export CSV" @ http://127.0.0.1:4173/reports.html

</details>

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

- **Id:** `a6fedc941a` · **Category:** data-inconsistency
- **Evidence:** `2× click fired the same state-changing request 2× (POST /api/orders)`
- **Where:** `/orders-new.html#86e55ecc` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

The submit button stays enabled while the request is in flight, and the endpoint accepts the repeat. One impatient double-click produced two identical POSTs and two orders. Disable the button during submit, and make the create idempotent.

<details><summary>Repro trace (last actions before finding)</summary>

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html
5. snapshot @ http://127.0.0.1:4173/orders-new.html
6. type textbox "Customer" ← "Alder & Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
7. snapshot @ http://127.0.0.1:4173/orders-new.html
8. click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
9. screenshot @ http://127.0.0.1:4173/orders-new.html

</details>

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

- **Id:** `367f382861` · **Category:** visual
- **Evidence:** `"Save notes" is COVERED by pinned chrome [order-stickybar]`
- **Where:** `/order.html#9fd83abf` (http://127.0.0.1:4173/order.html?id=1042)
- **Seen in runs:** 1

The save row is sticky at the bottom of the viewport, and a fixed bar added later sits on top of it. The button is present, labelled and enabled, but it cannot be seen, and a click aimed at it lands on the bar. It only becomes reachable after scrolling to the very end of the page. Found by hit-testing the button's centre, since box overlap cannot tell which of two pinned elements is on top.

<details><summary>Repro trace (last actions before finding)</summary>

1. design-audit @ http://127.0.0.1:4173/orders-new.html
2. navigate http://127.0.0.1:4173/order.html?id=1042 @ http://127.0.0.1:4173/order.html?id=1042
3. snapshot @ http://127.0.0.1:4173/order.html?id=1042
4. screenshot @ http://127.0.0.1:4173/order.html?id=1042

</details>

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

- **Id:** `176f4c472b` · **Category:** permission-leak
- **Evidence:** `POST /api/orders/1037/approve 200 as clerk; POST /api/orders/1038/reject 403 as clerk`
- **Where:** `/approvals.html#b0b57d70` (http://127.0.0.1:4173/approvals.html)
- **Seen in runs:** 1

The Approvals page shows Approve and Reject only to a manager. Reject is also refused by the server for anyone else, but Approve is not: a clerk who posts to it directly gets the order approved, and the audit log records a clerk approving. Hiding the button was the only control. The two sibling endpoints disagree, which is also the fix: give approve the check reject already has.

<details><summary>Repro trace (last actions before finding)</summary>

1. click:refused Delete workspace @ http://127.0.0.1:4173/settings.html
2. navigate http://127.0.0.1:4173/approvals.html @ http://127.0.0.1:4173/approvals.html
3. snapshot @ http://127.0.0.1:4173/approvals.html

</details>

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

- **Id:** `c6abf89bce` · **Category:** visual
- **Evidence:** `"All orders" overlaps "New: bulk import" (81%)`
- **Where:** `/#79b51ffd` (http://127.0.0.1:4173/)
- **Seen in runs:** 1

On the dashboard the badge overlaps most of the All orders button, hiding its label and taking the clicks aimed at it. The geometry oracle measured the overlap from layout boxes; no screenshot was needed to find it.

<details><summary>Repro trace (last actions before finding)</summary>

1. attach @ http://127.0.0.1:4173/
2. snapshot @ http://127.0.0.1:4173/
3. screenshot @ http://127.0.0.1:4173/

</details>

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

- **Id:** `6781d3cd32` · **Category:** dead-end
- **Evidence:** `/reports-scheduled.html — 200 · 0 el · DEAD-END`
- **Where:** `/reports-scheduled.html#da39a3ee` (http://127.0.0.1:4173/reports-scheduled.html)
- **Seen in runs:** 1

The page reached from Reports → Scheduled reports has no header, no links and no controls. The only way out is the browser's back button. The crawl flagged it as a dead end with 0 interactable elements.

<details><summary>Repro trace (last actions before finding)</summary>

1. click button "Export CSV" @ http://127.0.0.1:4173/reports.html
2. navigate http://127.0.0.1:4173/reports-scheduled.html @ http://127.0.0.1:4173/reports-scheduled.html
3. snapshot @ http://127.0.0.1:4173/reports-scheduled.html

</details>

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

- **Id:** `0fbc83205d` · **Category:** ux-confusing
- **Evidence:** `submit-style click fired ZERO network requests and no navigation`
- **Where:** `/orders-new.html#86e55ecc` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

With Customer empty, Create order sends no request, shows no validation message and does not move focus to the field. A first-time user cannot tell whether the click registered.

<details><summary>Repro trace (last actions before finding)</summary>

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html

</details>

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

- **Id:** `faf0de6cd1` · **Category:** data-inconsistency
- **Evidence:** `sorted by quantity: 10, 120, 250, 3, 64, 9`
- **Where:** `/inventory.html#ec47ebb1` (http://127.0.0.1:4173/inventory.html)
- **Seen in runs:** 1

Quantity is compared as text, so the column orders by first digit. Pallet wrap (3 on hand) and Shipping labels (9) land at the bottom of an ascending sort, which is exactly where someone scanning for low stock does not look.

<details><summary>Repro trace (last actions before finding)</summary>

1. snapshot @ http://127.0.0.1:4173/approvals.html
2. navigate http://127.0.0.1:4173/inventory.html @ http://127.0.0.1:4173/inventory.html
3. snapshot @ http://127.0.0.1:4173/inventory.html
4. click button "Quantity" @ http://127.0.0.1:4173/inventory.html

</details>

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

- **Id:** `aa8e56e60d` · **Category:** network
- **Evidence:** `GET /img/weekly-chart.png → HTTP 404`
- **Where:** `/#79b51ffd` (http://127.0.0.1:4173/)
- **Seen in runs:** 1

The "This week" chart never loads. The page still works, but the largest element above the fold is a broken image, and the 404 adds a console error to every dashboard visit.

<details><summary>Repro trace (last actions before finding)</summary>

1. attach @ http://127.0.0.1:4173/
2. snapshot @ http://127.0.0.1:4173/
3. screenshot @ http://127.0.0.1:4173/

</details>

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

- **Id:** `376788a5bf` · **Category:** visual
- **Evidence:** `1.73:1 (needs 4.5:1) rgba(184, 192, 202, 1) on rgb(246, 248, 250)`
- **Where:** `/orders-new.html#86e55ecc` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

The hint below the Customer field fails WCAG contrast by a wide margin. The same .hint style is likely used on other forms.

<details><summary>Repro trace (last actions before finding)</summary>

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html
5. snapshot @ http://127.0.0.1:4173/orders-new.html
6. type textbox "Customer" ← "Alder & Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
7. snapshot @ http://127.0.0.1:4173/orders-new.html
8. click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
9. screenshot @ http://127.0.0.1:4173/orders-new.html
10. journey:end create an order for a new customer @ http://127.0.0.1:4173/orders-new.html
11. navigate http://127.0.0.1:4173/orders-new.html @ http://127.0.0.1:4173/orders-new.html
12. design-audit @ http://127.0.0.1:4173/orders-new.html

</details>

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

- **Id:** `cc6bc0da51` · **Category:** ux-polish
- **Evidence:** `/orders-new.html — 200 · 12 el · 1 unnamed`
- **Where:** `/orders-new.html#86e55ecc` (http://127.0.0.1:4173/orders-new.html)
- **Seen in runs:** 1

The field is announced to assistive technology without a name, and the placeholder disappears as soon as the user types. The crawl counted it as the one unnamed control on this page.

<details><summary>Repro trace (last actions before finding)</summary>

1. journey:start create an order for a new customer @ http://127.0.0.1:4173/
2. click link "New order" @ http://127.0.0.1:4173/orders-new.html
3. snapshot @ http://127.0.0.1:4173/orders-new.html
4. click button "Create order" @ http://127.0.0.1:4173/orders-new.html
5. snapshot @ http://127.0.0.1:4173/orders-new.html
6. type textbox "Customer" ← "Alder & Pine Outfitters" @ http://127.0.0.1:4173/orders-new.html
7. snapshot @ http://127.0.0.1:4173/orders-new.html
8. click×2 button "Create order" @ http://127.0.0.1:4173/orders-new.html
9. screenshot @ http://127.0.0.1:4173/orders-new.html
10. journey:end create an order for a new customer @ http://127.0.0.1:4173/orders-new.html
11. navigate http://127.0.0.1:4173/orders-new.html @ http://127.0.0.1:4173/orders-new.html
12. design-audit @ http://127.0.0.1:4173/orders-new.html

</details>

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

- `/`: tid:stat-open, tid:stat-shipped, tid:stat-revenue, tid:stat-pending, tid:dash-all-orders, tid:dash-new-badge, tid:dash-chart
- `/orders.html`: tid:orders-new-btn, tid:orders-rows, tid:order-link-1042, tid:order-link-1041, tid:order-link-1040, tid:order-link-1039, tid:order-link-1038, tid:order-link-1037
- `/approvals.html`: tid:approvals-who, tid:approvals-rows, tid:approvals-row-1038, tid:approvals-order-link-1038, tid:approvals-row-1037, tid:approvals-order-link-1037
- `/inventory.html`: tid:inventory-sort-name, tid:inventory-rows, tid:inventory-row-HB-101, tid:inventory-row-HB-102, tid:inventory-row-HB-103, tid:inventory-row-HB-104, tid:inventory-row-HB-105, tid:inventory-row-HB-106
- `/customers.html`: tid:customers-rows, tid:customers-row-1, tid:customers-row-2, tid:customers-row-3, tid:customers-row-4, tid:customers-row-5, tid:customers-row-6
- `/reports.html`: tid:reports-scheduled-link
- `/audit.html`: tid:audit-denied
- `/settings.html`: tid:settings-name, tid:settings-timezone, tid:settings-save, tid:settings-delete-workspace
- `/signin.html`: tid:signin-role-clerk, tid:signin-role-manager, tid:signin-role-auditor, tid:signin-status
- `/orders-new.html`: tid:new-order-form, tid:new-order-items, tid:new-order-email, tid:new-order-cancel, tid:new-order-msg
- `/order.html`: tid:order-back, tid:order-request-approval, tid:order-notes, tid:order-delete, tid:order-stickybar, link:line items are edited from the list
- `(shared layout chrome)`: tid:nav-logo, tid:nav-dashboard, tid:nav-orders, tid:nav-approvals, tid:nav-inventory, tid:nav-customers, tid:nav-reports, tid:nav-audit … +2
