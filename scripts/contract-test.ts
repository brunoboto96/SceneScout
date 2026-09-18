/**
 * Unit tests for the COMPLETION CONTRACT — route identity and the gap ledger.
 *
 * This is the mechanism the whole product rests on: `ft_report` refusing to
 * certify a run while the ledger is non-empty. It shipped untested, and two of
 * its rules were quietly failing open — a route-identity collision that made
 * two static pages aliases of each other, and an arithmetic mismatch that
 * dropped genuinely untouched routes out of the ledger entirely.
 *
 *   npx tsx --test --test-name-pattern "ledger" scripts/contract-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { isNonPageRoute, normalizePath } from "../dist/engine/fingerprint.js";
import { MemoryStore } from "../dist/engine/memory.js";
import { classifyFilledStates, computeGaps, formatRouteCoverage } from "../dist/engine/report.js";

let dirs: string[] = [];
function freshStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-contract-"));
  dirs.push(dir);
  return new MemoryStore(dir);
}
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// ---------------------------------------------------------------------------
// Route identity
// ---------------------------------------------------------------------------

test("a download or API path is not a page, so it never enters the route contract", () => {
  // An ExportButton's href was harvested as a route; "visiting" it downloads a
  // file rather than rendering a page, so it could never be exercised or
  // audited and sat in the gap ledger permanently.
  assert.equal(isNonPageRoute("/api/documents/export"), true, "API paths are not pages");
  assert.equal(isNonPageRoute("/api"), true);
  assert.equal(isNonPageRoute("/reports/export?format=csv"), true, "a page-shaped export link is still a download");
  assert.equal(isNonPageRoute("/files/manual.pdf"), true);
  assert.equal(isNonPageRoute("/attachments/photo.PNG"), true, "case-insensitive");
  assert.equal(isNonPageRoute("/exports?download=1"), true);
  // ...and real pages are untouched, including ones whose names merely echo the
  // words above.
  assert.equal(isNonPageRoute("/documents"), false);
  assert.equal(isNonPageRoute("/api-keys"), false, "a page about API keys is a page");
  assert.equal(isNonPageRoute("/reports"), false);
  assert.equal(isNonPageRoute("/documents/:id?section=history"), false);
  assert.equal(isNonPageRoute("/"), false);
});

test("the two static error pages stay distinct from each other", () => {
  // Collapsing any numeric segment made /404 and /500 both `/:id`, so visiting
  // one marked the other covered — on the two routes a tester least wants to
  // skip. Every top-level numeric page aliased the same way.
  assert.equal(normalizePath("http://x/404"), "/404");
  assert.equal(normalizePath("http://x/500"), "/500");
  assert.notEqual(normalizePath("http://x/404"), normalizePath("http://x/500"));
});

test("a record id after a collection noun still collapses", () => {
  assert.equal(normalizePath("http://x/documents/239"), "/documents/:id");
  assert.equal(normalizePath("http://x/orders/5/lines/12"), "/orders/:id/lines/:id");
});

test("uuids and long hex collapse anywhere, including first", () => {
  // No static page is named a uuid, so position carries no information here.
  assert.equal(normalizePath("http://x/3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "/:id");
  assert.equal(normalizePath("http://x/507f1f77bcf86cd799439011"), "/:id");
});

test("UI-state params are part of the route, transient ones are not", () => {
  assert.equal(normalizePath("http://x/admin?tab=billing"), "/admin?tab=billing");
  assert.equal(normalizePath("http://x/docs?page=2"), "/docs");
  assert.equal(normalizePath("http://x/s/new?step=2"), "/s/new?step=2");
  assert.notEqual(normalizePath("http://x/s/new?step=2"), normalizePath("http://x/s/new?step=3"));
});

test("normalizePath is idempotent, so an already-normalized route matches itself", () => {
  for (const r of ["/404", "/documents/:id", "/admin?tab=billing", "/"]) {
    assert.equal(normalizePath(r), r, `${r} must survive a second pass unchanged`);
  }
});

// ---------------------------------------------------------------------------
// The gap ledger
// ---------------------------------------------------------------------------

test("ledger: a multi-state route where nothing was touched is still reported", () => {
  // The regression: `total` was recomputed by re-counting every state's
  // elements, so a route with two states counted its shared controls twice.
  // total > keys.length, the equality failed, and the route vanished from the
  // ledger — the one place it was supposed to appear.
  const store = freshStore();
  store.visitState("/form#a", "http://x/form", "/form", ["textbox:name", "button:save"]);
  store.visitState("/form#b", "http://x/form?open=1", "/form", ["textbox:name", "button:save", "button:cancel"]);
  const gaps = computeGaps(store);
  assert.ok(
    gaps.some((g) => g.includes("NOTHING exercised") && g.includes("/form")),
    `expected /form in the ledger, got: ${JSON.stringify(gaps)}`,
  );
});

test("ledger: touching one control clears the nothing-exercised gap for that route", () => {
  const store = freshStore();
  store.visitState("/form#a", "http://x/form", "/form", ["textbox:name", "button:save"]);
  store.visitState("/form#b", "http://x/form?open=1", "/form", ["textbox:name", "button:save", "button:cancel"]);
  store.markExercised("/form#a", "button:save", "click");
  assert.ok(!computeGaps(store).some((g) => g.includes("NOTHING exercised")));
});

test("ledger: an abandoned journey does not count as task ease being measured", () => {
  // An abandoned journey proves a task is BLOCKED — the strongest finding the
  // tool can produce. Counting it as coverage let "this is impossible" close
  // the gap that exists to ask "how hard is this?".
  const store = freshStore();
  store.visitState("/x#a", "http://x/x", "/x", ["button:go"]);
  store.markRouteFact("/x", { journeys: 1, journeysCompleted: 0 });
  assert.ok(
    computeGaps(store).some((g) => g.includes("COMPLETED ft_journey")),
    "an abandoned journey leaves the ease gap open",
  );
  store.markRouteFact("/x", { journeys: 1, journeysCompleted: 1 });
  assert.ok(!computeGaps(store).some((g) => g.includes("ft_journey")), "a completed one closes it");
});

test("ledger: a form filled but never submitted is a gap", () => {
  // `mutated` was collected on every state-changing request and then read by
  // nothing at all. This is what it was collected for.
  const store = freshStore();
  store.visitState("/new#a", "http://x/new", "/new", ["textbox:title", "button:save"]);
  store.markExercised("/new#a", "textbox:title", "type");
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("/new")),
    "typing into a form and walking away is not testing it",
  );
  store.markRouteFact("/new", { mutated: true });
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "a real submission closes it");
});

test("ledger: attaching a file is filling a form too", () => {
  // File inputs were invisible to this rule: `upload` was not an action it
  // recognised, so choosing a file and walking away never registered as a gap
  // — the one form field the engine could not even fill was also the one it
  // would never accuse of being untested.
  const store = freshStore();
  store.visitState("/attach#a", "http://x/attach", "/attach", ["file:attachment", "button:upload"]);
  store.markExercised("/attach#a", "file:attachment", "upload");
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("/attach")),
    "an attached-but-unsent file is an unsubmitted form",
  );
  store.markRouteFact("/attach", { mutated: true });
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "sending it closes the gap");

  const viaPlan = freshStore();
  viaPlan.visitState("/attach#b", "http://x/attach", "/attach", ["file:attachment", "tid:attach-submit-btn"]);
  viaPlan.markExercised("/attach#b", "file:attachment", "plan:upload");
  assert.ok(computeGaps(viaPlan).some((g) => g.includes("NEVER submitted")), "a plan's upload step counts the same way");
});

test("ledger: typing in a register's SEARCH box is not an unsubmitted form", () => {
  // The false positive this kills: every register (/orders, /tickets,
  // /invoices) has a filter input and no submit, so each one reported "form filled
  // but NEVER submitted" on every run, forever. Twelve such entries survived a
  // full audit — noise a reader learns to skip, which is worse than silence.
  const store = freshStore();
  store.visitState("/orders#a", "http://x/orders", "/orders", ["tid:orders-search-input", "link:row-1"]);
  store.markExercised("/orders#a", "tid:orders-search-input", "type");
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "a filter box is not a form");
});

test("ledger: a page whose only inputs are filters has nothing to submit", () => {
  const store = freshStore();
  // A read-only audit-trail view: date/action pickers, no submit control.
  store.visitState("/audit-log#a", "http://x/audit-log", "/audit-log", ["tid:filter-from-date", "tid:filter-action-select"]);
  store.markExercised("/audit-log#a", "tid:filter-action-select", "select");
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "no submit control means no unsubmitted form");
});

test("ledger: a real form with a submit control IS still reported", () => {
  // The guard must not swallow the true positive it exists to surface.
  const store = freshStore();
  store.visitState("/widgets/new#a", "http://x/widgets/new", "/widgets/new", ["textbox:title", "tid:widget-submit-btn"]);
  store.markExercised("/widgets/new#a", "textbox:title", "type");
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("/widgets/new")),
    "typing into a form that has a submit and walking away is still a gap",
  );
});

test("ledger: submitting a WIZARD clears its earlier steps", () => {
  // A wizard is ONE form spread over several URLs; the POST lands on the last
  // step, so every earlier ?step= route read as abandoned even after the
  // wizard completed.
  const store = freshStore();
  for (const step of ["step=1", "step=2", "step=3"]) {
    const route = `/customers/new?${step}`;
    store.visitState(`${route}#a`, `http://x/customers/new?${step}`, route, ["textbox:name", "button:next"]);
    store.markExercised(`${route}#a`, "textbox:name", "type");
  }
  assert.ok(computeGaps(store).some((g) => g.includes("NEVER submitted")), "before submission the wizard is an open gap");
  store.markRouteFact("/customers/new?step=3", { mutated: true });
  assert.ok(
    !computeGaps(store).some((g) => g.includes("NEVER submitted")),
    "the final step's POST answers for the whole wizard, not just its own URL",
  );
});

test("ledger: a TAB sibling does not clear another tab's abandoned form", () => {
  // `tab=`/`section=` are distinct SCREENS everywhere else in the engine, so
  // grouping them as one multi-URL form silenced real gaps on exactly the
  // routes the ledger exists for: saving on one tab marked another tab's
  // half-filled form as submitted.
  const store = freshStore();
  store.visitState("/settings?tab=security#a", "http://x/settings?tab=security", "/settings?tab=security", ["textbox:new password", "button:save"]);
  store.markExercised("/settings?tab=security#a", "textbox:new password", "type");
  store.markRouteFact("/settings?tab=profile", { mutated: true });
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("tab=security")),
    "a save on another tab must not answer for this one",
  );
});

test("ledger: a submit control is recognized in every testid casing", () => {
  // `\b` does not fire around an underscore, so `tid:widget_submit_btn` read as
  // "no submit control" and the whole form was dropped from the ledger.
  for (const submitKey of ["tid:widget_submit_btn", "tid:widgetSubmitBtn", "tid:widget-submit-btn", "button:Publish", "button:Update profile"]) {
    const store = freshStore();
    store.visitState("/f#a", "http://x/f", "/f", ["textbox:title", submitKey]);
    store.markExercised("/f#a", "textbox:title", "type");
    assert.ok(
      computeGaps(store).some((g) => g.includes("NEVER submitted")),
      `a form whose submit is "${submitKey}" must still be reported`,
    );
  }
});

test("ledger: 'search' inside a longer word is not a filter", () => {
  // Substring matching classed a genuine "Research title" field as a filter and
  // dropped its form.
  const store = freshStore();
  store.visitState("/r#a", "http://x/r", "/r", ["tid:research-title-input", "tid:research-save-btn"]);
  store.markExercised("/r#a", "tid:research-title-input", "type");
  assert.ok(computeGaps(store).some((g) => g.includes("NEVER submitted")), "'research' is not 'search'");
});

test("ledger: a state at the collector cap is never suppressed for want of a submit", () => {
  // The collector stops at 150 elements, so on a dense page "no submit found"
  // means "we did not look far enough" — suppressing there would hide a real
  // form behind a measurement limit.
  const store = freshStore();
  const keys = Array.from({ length: 150 }, (_, i) => `tid:field-${i}`);
  store.visitState("/dense#a", "http://x/dense", "/dense", keys);
  store.markExercised("/dense#a", "tid:field-0", "type");
  assert.ok(computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("/dense")), "a truncated state must not self-exempt");
});

test("ledger: a filled state with no submit is DISCLOSED, not silently dropped and not gating", () => {
  const store = freshStore();
  store.visitState("/panel#a", "http://x/panel", "/panel", ["tid:from-date", "tid:to-date"]);
  store.markExercised("/panel#a", "tid:from-date", "type");
  // Not a gap — it must not make `extensive` unsatisfiable...
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "no submit control means it is not counted as a gap");
  // ...but it must still be visible somewhere, or a real unlabeled form vanishes.
  const { unsubmitted, noSubmitControl } = classifyFilledStates(store, store.routeFacts);
  assert.deepEqual(unsubmitted, [], "nothing to submit");
  assert.deepEqual(noSubmitControl, ["/panel"], "the suppressed state is disclosed");
});

test("ledger: a bare path does not inherit a sibling's submission", () => {
  // The wizard rule keys on the query string. Two unrelated forms at the same
  // path with no steps must stay independent.
  const store = freshStore();
  store.visitState("/orders#a", "http://x/orders", "/orders", ["textbox:note", "button:save"]);
  store.markExercised("/orders#a", "textbox:note", "type");
  store.markRouteFact("/orders?tab=other", { mutated: true });
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("/orders")),
    "a bare route must not be cleared by a query-string sibling",
  );
});

test("ledger: a route that was only read is not accused of an unsubmitted form", () => {
  const store = freshStore();
  store.visitState("/list#a", "http://x/list", "/list", ["link:row-1"]);
  store.markExercised("/list#a", "link:row-1", "click");
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "clicking a link is not filling a form");
});

test("ledger: an empty ledger is reachable — the contract can actually be satisfied", () => {
  // A gate nothing can pass is not a guarantee, it is a wall. This pins that
  // every rule has an achievable exit.
  const store = freshStore();
  store.visitState("/x#a", "http://x/x", "/x", ["button:go"]);
  store.markExercised("/x#a", "button:go", "click");
  store.markRouteFact("/x", { audited: true, journeys: 1, journeysCompleted: 1 });
  store.recordRoleAccess("admin", "/x", "reached");
  store.recordRoleAccess("viewer", "/x", "reached");
  assert.deepEqual(computeGaps(store, { unvisitedRoutes: [] } as never), []);
});

test("coverage counts link-discovered routes, not only the ones found in source", () => {
  // A project with no scannable routes (a code-routed SPA, or a remote URL with
  // no source at all) used to be told there was no route list while discovered
  // routes sat unvisited — the one mode where the agent most needs the list.
  const discoveredOnly = formatRouteCoverage(["/", "/orders", "/settings"], ["/settings"]);
  assert.match(discoveredOnly, /Routes visited: 2\/3/);
  assert.match(discoveredOnly, /UNVISITED: \/settings/);
  assert.doesNotMatch(discoveredOnly, /No routes known/);

  // Visited is derived from the same set as the total, so it can never go
  // negative when discovered routes outnumber scanned ones.
  const many = Array.from({ length: 30 }, (_, i) => `/r${i}`);
  const line = formatRouteCoverage(many, many.slice(1));
  assert.match(line, /Routes visited: 1\/30/);
  assert.match(line, / …/, "a long unvisited list is truncated, and says so");

  assert.match(formatRouteCoverage(["/a"], []), /1\/1 ✓/);
  assert.match(formatRouteCoverage([], []), /No routes known yet.*Snapshot the landing page/, "an empty contract tells the agent how to fill it");
});
