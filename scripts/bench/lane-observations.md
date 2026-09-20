# Lane observation log (benchmark fixture)

One lane's raw notes from exploring the demo app, before any judgement. Every
observation has an id; the lane is asked to judge each one. The log is fixed so
that every agent in the benchmark judges the same thing and only the shape of
its reply differs.

| id | Where | What was observed |
|---|---|---|
| o01 | Dashboard `/` | The chart image requests `GET /chart.svg`, which returns 404. The console logs "Failed to load resource". |
| o02 | Dashboard `/` | A badge positioned with a negative top offset sits over the "All orders" button. Hit-testing the button's centre returns the badge, not the button. |
| o03 | Orders `/orders.html` | Choosing the "Archived" filter sends `GET /api/orders?status=archived`, which returns 500. The table renders empty with no message. |
| o04 | New order `/orders-new.html` | Submitting with the Customer field empty sends no request and shows no message. The form is unchanged. |
| o05 | New order `/orders-new.html` | A double-click on "Create order" sends `POST /api/orders` twice, both 201. Two orders appear in the list. |
| o06 | New order `/orders-new.html` | The hint text under the Items field measures 1.73:1 contrast against its background. |
| o07 | New order `/orders-new.html` | The Email input has the placeholder "you@example.com" but no label, aria-label or aria-labelledby. |
| o08 | Reports `/reports.html` | Clicking "Export CSV" logs `TypeError: rows.map is not a function` as a page error. Nothing downloads. |
| o09 | Scheduled reports `/reports-scheduled.html` | The page has no navigation and no link back to anywhere. Only the browser's back button leaves it. |
| o10 | Order detail `/order.html?id=1042` | A fixed bar at the bottom of the viewport covers the "Save notes" button. Hit-testing the button's centre returns the bar. |
| o11 | Approvals `/approvals.html` | As a clerk the Approve button is hidden, but `POST /api/orders/1038/approve` sent as the clerk returns 200 and the order's status becomes approved. `POST /api/orders/1037/reject` as the clerk returns 403. |
| o12 | Inventory `/inventory.html` | Sorted by quantity, the column reads 10, 120, 250, 3, 64, 9. |
| o13 | Orders `/orders.html` | An order created with the customer name `<b>probe</b>` renders that name in bold in the list; the DOM shows a `<b>` element inside the cell. |
| o14 | Settings `/settings.html` | As a clerk, "Delete workspace" shows the message "Workspace deleted" while `DELETE /api/workspace` returned 403. The orders are still there. |
| o15 | Order detail `/order.html?id=1042` | Clicking "Delete order" was refused by the engine's read-only write policy before any request left the browser. The app itself was not exercised. |
| o16 | Sign-in `/signin.html` | Choosing a role sends `POST /api/signin`, which returns 200 and sets a cookie. The browser lands on the dashboard. |
| o17 | Customers `/customers.html` | Six rows, matching `GET /api/customers`. No console output, no failed requests. |
| o18 | Audit log `/audit.html` | As a clerk, `GET /api/audit` returns 403 and the page shows "The audit log is for managers and auditors". As a manager it returns 200 with the log. |

Routes covered: `/`, `/orders.html`, `/orders-new.html`, `/reports.html`,
`/reports-scheduled.html`, `/order.html?id=:id`, `/approvals.html`,
`/inventory.html`, `/settings.html`, `/signin.html`, `/customers.html`,
`/audit.html`.
