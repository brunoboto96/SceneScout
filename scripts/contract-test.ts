/**
 * Unit tests for the COMPLETION CONTRACT — route identity and the gap ledger.
 *
 * This is the mechanism the whole product rests on: `scout_report` refusing to
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
import { isNonPageRoute, normalizePath } from "../src/engine/fingerprint.ts";
import { crawledRoute, crawlLine, mainStateFlag } from "../src/engine/crawl.ts";
import { MemoryStore, reachedRoutes } from "../src/engine/memory.ts";
import { formatNeverSubmittedEmpty } from "../src/engine/forms.ts";
import {
  classifyFilledStates,
  computeGaps,
  escapeTableCell,
  embedSection,
  formatRouteCoverage,
  formatUnchosenOptions,
  describeAge,
  generateReport,
  observeRefusedPostsGap,
  replayDocument,
  reportEvidence,
  withAudience,
} from "../src/engine/report.ts";
import { IMPACT, isSafeRelativePath, PLAIN_WORDING, pictureOf, plainStep, plainSteps, plainWording } from "../src/engine/plain.ts";
import { FINDING_CATEGORIES } from "../src/engine/memory.ts";
import { ORACLE_KINDS } from "../src/engine/oracles.ts";
import { buildReplayHtml, escapeHtml, evidenceFor, framePath, RECORD_MAX_FRAMES, renderMarkdown, resolveFrame, taskBlocks } from "../src/engine/replay.ts";
import type { ActivityLine } from "../src/engine/live.ts";

let dirs: string[] = [];
/**
 * Stores opened by the running test. Each holds a debounced write timer; a
 * temp dir deleted while one is pending makes that write fail half a second
 * later, and a green run then prints a wall of "memory write failed" lines —
 * which is exactly what a newcomer's first `npm test` looked like.
 */
let stores: MemoryStore[] = [];

function freshStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-contract-"));
  dirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}

afterEach(() => {
  // flush() cancels the pending timer; a store whose dir a test deleted on
  // purpose has nothing left to write, which is fine.
  for (const store of stores) {
    try {
      store.flush();
    } catch {
      /* the test removed this store's directory deliberately */
    }
  }
  stores = [];
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

test("ledger: a tab variant reached by URL is part of its base route, where the tab click was recorded", () => {
  // /x and /x?tab=a, with a click on /x: the click on the tab lands on the base
  // route's state, and the variant reached by URL is the same page.
  const store = freshStore();
  store.visitState("/x#a", "http://x/x", "/x", ["tid:tab-a", "button:save"]);
  store.visitState("/x?tab=a#b", "http://x/x?tab=a", "/x?tab=a", ["tid:tab-a", "button:save"]);
  store.markExercised("/x#a", "tid:tab-a", "click");
  store.markRouteFact("/x", { audited: true });
  const known = ["/x", "/x?tab=a"];
  const gaps = computeGaps(store, { routesVisited: 2, routesTotal: 2, designAudits: 1, knownRoutes: known, unvisitedRoutes: [] });
  assert.ok(!gaps.some((g) => g.includes("NOTHING exercised")), `got ${JSON.stringify(gaps)}`);
  assert.ok(!gaps.some((g) => g.includes("design-audited")), "an audit of the base route covers its tabs");
  // The contrast: with nothing touched on either, both contract routes are listed.
  const idle = freshStore();
  idle.visitState("/x#a", "http://x/x", "/x", ["tid:tab-a", "button:save"]);
  idle.visitState("/x?tab=a#b", "http://x/x?tab=a", "/x?tab=a", ["tid:tab-a", "button:save"]);
  const line = computeGaps(idle, { routesVisited: 2, routesTotal: 2, designAudits: 0, knownRoutes: known, unvisitedRoutes: [] }).find((g) =>
    g.includes("NOTHING exercised"),
  );
  assert.match(line ?? "", /^2 of 2 known route\(s\) visited this run but NOTHING exercised/);
});

test("ledger: routes an earlier run visited are not in this run's ledger, and the project view says it is the project's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-contract-"));
  dirs.push(dir);
  const earlier = new MemoryStore(dir);
  stores.push(earlier);
  earlier.visitState("/old#a", "http://x/old", "/old", ["button:go"]);
  earlier.flush();
  // A new process: this run has reached /new only.
  const store = new MemoryStore(dir);
  stores.push(store);
  const known = ["/old", "/new"];
  const extras = { routesVisited: 2, routesTotal: 2, designAudits: 0, knownRoutes: known, unvisitedRoutes: [] };
  assert.ok(
    computeGaps(store, extras).some((g) => g.includes("in any run") && g.includes("/old")),
    "before this run reaches anything, the report reads the project and labels it so",
  );
  store.visitState("/new#a", "http://x/new", "/new", ["button:go"]);
  const run = computeGaps(store, extras);
  const untouched = run.find((g) => g.includes("NOTHING exercised")) ?? "";
  assert.match(untouched, /^1 of 2 known route\(s\) visited this run but NOTHING exercised[^\n]*\/new$/);
  assert.ok(!run.some((g) => g.includes("/old")), `the earlier run's route is not this run's gap: ${JSON.stringify(run)}`);
  const project = computeGaps(store, { ...extras, ledgerScope: "project" });
  assert.match(project.find((g) => g.includes("NOTHING exercised")) ?? "", /^2 of 2 known route\(s\) visited in any run but NOTHING exercised/);
});

test("never visited and the ledger agree on what was reached: a tab reaches its page, and a state stored under an older route identity counts", () => {
  const reached = reachedRoutes(["/x?tab=a", "/widgets/WID-2025-001"]);
  assert.equal(reached("/x"), true, "a tab of /x reached /x");
  assert.equal(reached("/x?tab=a"), true);
  assert.equal(reached("/x?tab=b"), false, "another tab was not reached");
  assert.equal(reached("/widgets/:id"), true, "an older state's route reads as today's identity");
  assert.equal(reached("/y"), false);
  // The ledger with the same contract: /x is reached and not listed as never visited.
  const store = freshStore();
  store.visitState("/x?tab=a#1", "http://x/x?tab=a", "/x?tab=a", ["button:go"]);
  const gaps = computeGaps(store, { routesVisited: 1, routesTotal: 1, designAudits: 0, knownRoutes: ["/x"], unvisitedRoutes: [] });
  assert.match(gaps.find((g) => g.includes("NOTHING exercised")) ?? "", /^1 of 1 known route\(s\)[^\n]*: \/x$/);
});

test("ledger: every route line counts over the route contract, and a visited path outside it is not a route", () => {
  const store = freshStore();
  store.visitState("/a#1", "http://x/a", "/a", ["button:go"]);
  store.visitState("/typo#1", "http://x/typo", "/typo", ["button:go"]); // a path that does not exist in the app
  const gaps = computeGaps(store, { routesVisited: 1, routesTotal: 3, designAudits: 0, knownRoutes: ["/a", "/b", "/c"], unvisitedRoutes: ["/b", "/c"] });
  assert.deepEqual(
    gaps.filter((g) => /never visited|NOTHING|design-audited/.test(g)).map((g) => g.split(":")[0]),
    [
      "2 of 3 known route(s) never visited in any run",
      "1 of 3 known route(s) visited this run but NOTHING exercised (looked at, never touched)",
      "1 of 3 known route(s) visited this run and never design-audited",
    ],
  );
  assert.ok(!gaps.some((g) => g.includes("/typo")), "a path outside the contract is not listed");
});

test("ledger: touching one control clears the nothing-exercised gap for that route", () => {
  const store = freshStore();
  store.visitState("/form#a", "http://x/form", "/form", ["textbox:name", "button:save"]);
  store.visitState("/form#b", "http://x/form?open=1", "/form", ["textbox:name", "button:save", "button:cancel"]);
  store.markExercised("/form#a", "button:save", "click");
  assert.ok(!computeGaps(store).some((g) => g.includes("NOTHING exercised")));
});

test("ledger: a page whose POST observe refused is named, with the endpoint and how to name it as a read", () => {
  const store = freshStore();
  store.visitState("/search#a", "http://x/search", "/search", ["textbox:query"]);
  store.noteObserveRefusedPost("/search", "POST /api/search");
  store.noteObserveRefusedPost("/search", "POST /api/search");
  assert.deepEqual(store.observeRefusedPosts, [{ route: "/search", endpoints: ["POST /api/search"] }], "deduplicated");
  const line = computeGaps(store).find((g) => g.includes("observe refused"));
  assert.ok(line, `expected the refused POST in the ledger, got: ${JSON.stringify(computeGaps(store))}`);
  assert.ok(line.includes("/search (POST /api/search)") && line.includes("readPosts"), line);
  // Beside the route lines, not in place of them: both reach the ledger.
  const both = computeGaps(store, { routesVisited: 1, routesTotal: 2, designAudits: 0, knownRoutes: ["/search", "/orders"], unvisitedRoutes: ["/orders"] });
  assert.ok(both.some((g) => g.includes("never visited") && g.includes("/orders")) && both.some((g) => g.includes("observe refused")), JSON.stringify(both));
  // The contrast: once a POST to it went out (named as a read, or sent in a looser mode), no line.
  store.clearObserveRefusedPosts((e) => e === "POST /api/search");
  assert.ok(!computeGaps(store).some((g) => g.includes("observe refused")));
  assert.equal(observeRefusedPostsGap([{ route: "/search", endpoints: [] }]), null);
});

test("ledger: a closed lane's refused POSTs are kept in project memory for the planner's report", () => {
  // Lanes close their sessions before the planner writes the report, so the record lives in memory, on disk.
  const lane = freshStore();
  lane.noteObserveRefusedPost("/reports", "POST /api/reports/query", 1000);
  lane.flush();
  const planner = new MemoryStore(lane.dir.replace(/[\\/]\.scenescout$/, ""));
  stores.push(planner);
  assert.ok(
    computeGaps(planner).some((g) => g.includes("/reports (POST /api/reports/query)")),
    JSON.stringify(computeGaps(planner)),
  );
  // Two processes: the later of a refusal and a clear wins in the merge, whichever saves last.
  planner.clearObserveRefusedPosts((e) => e === "POST /api/reports/query", 2000);
  planner.flush();
  lane.noteObserveRefusedPost("/other", "POST /api/other", 1500);
  lane.flush();
  const after = new MemoryStore(lane.dir.replace(/[\\/]\.scenescout$/, ""));
  stores.push(after);
  assert.deepEqual(after.observeRefusedPosts, [{ route: "/other", endpoints: ["POST /api/other"] }], JSON.stringify(after.observeRefusedPosts));
});

test("ledger: an abandoned journey does not count as task ease being measured", () => {
  // An abandoned journey proves a task is BLOCKED — the strongest finding the
  // tool can produce. Counting it as coverage let "this is impossible" close
  // the gap that exists to ask "how hard is this?".
  const store = freshStore();
  store.visitState("/x#a", "http://x/x", "/x", ["button:go"]);
  store.markRouteFact("/x", { journeys: 1, journeysCompleted: 0 });
  assert.ok(
    computeGaps(store).some((g) => g.includes("COMPLETED scout_journey")),
    "an abandoned journey leaves the ease gap open",
  );
  store.markRouteFact("/x", { journeys: 1, journeysCompleted: 1 });
  assert.ok(!computeGaps(store).some((g) => g.includes("scout_journey")), "a completed one closes it");
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
  assert.ok(
    computeGaps(viaPlan).some((g) => g.includes("NEVER submitted")),
    "a plan's upload step counts the same way",
  );
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
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted")),
    "before submission the wizard is an open gap",
  );
  store.markRouteFact("/customers/new?step=3", { mutated: true });
  assert.ok(!computeGaps(store).some((g) => g.includes("NEVER submitted")), "the final step's POST answers for the whole wizard, not just its own URL");
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
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted")),
    "'research' is not 'search'",
  );
});

test("ledger: a state at the collector cap is never suppressed for want of a submit", () => {
  // The collector stops at 150 elements, so on a dense page "no submit found"
  // means "we did not look far enough" — suppressing there would hide a real
  // form behind a measurement limit.
  const store = freshStore();
  const keys = Array.from({ length: 150 }, (_, i) => `tid:field-${i}`);
  store.visitState("/dense#a", "http://x/dense", "/dense", keys);
  store.markExercised("/dense#a", "tid:field-0", "type");
  assert.ok(
    computeGaps(store).some((g) => g.includes("NEVER submitted") && g.includes("/dense")),
    "a truncated state must not self-exempt",
  );
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

test("app text cannot break out of a report table cell", () => {
  // Escaping the pipe alone is not enough: an input that already ends in a
  // backslash turns the escaped pipe back into a live column separator.
  assert.equal(escapeTableCell("a|b"), "a\\|b");
  assert.equal(escapeTableCell("a\\|b"), "a\\\\\\|b", "backslash is escaped first, so the pipe stays escaped");
  assert.equal(escapeTableCell("line one\nline two\r\nthree"), "line one line two three", "a newline would end the row");
  assert.equal(escapeTableCell("GET /api/orders → 500"), "GET /api/orders → 500", "ordinary text is untouched");
  // Every pipe in the output is preceded by an odd number of backslashes.
  for (const nasty of ["\\|", "\\\\|", "x\\\\\\|y", "||"]) {
    const out = escapeTableCell(nasty);
    for (const m of out.matchAll(/(\\*)\|/g)) assert.equal(m[1].length % 2, 1, `live pipe in ${JSON.stringify(out)}`);
  }
});

test("ledger: in observe mode an unsubmitted form is explained, not dropped", () => {
  // observe blocks every submission, so every filled form ends up here. It is
  // still untested surface and must stay in the ledger — but worded as the
  // mode's doing, with how to cover it, rather than as the run giving up.
  const store = freshStore();
  store.visitState("/widgets/new#a", "http://x/widgets/new", "/widgets/new", ["textbox:title", "tid:widget-submit-btn"]);
  store.markExercised("/widgets/new#a", "textbox:title", "type");
  const observed = computeGaps(store, { routesVisited: 1, routesTotal: 1, designAudits: 1, mode: "observe" }).find((g) => g.includes("NEVER submitted"));
  assert.ok(observed, "the gap is still listed");
  assert.match(observed, /expected in observe mode.*untested.*read-only mode/);
  const normal = computeGaps(store, { routesVisited: 1, routesTotal: 1, designAudits: 1, mode: "read-only" }).find((g) => g.includes("NEVER submitted"));
  assert.ok(normal && !/observe/.test(normal), "other modes get the plain wording");
});

// ---- the run as one page -------------------------------------------------
//
// The report dies with the process that rendered it: a viewer who refreshes
// the live board after the run ends has nothing. buildReplayHtml is the same
// run as one file — readable offline, with the trail that produced it.

const step = (over: Partial<ActivityLine> = {}): ActivityLine => ({
  at: "2026-09-20T14:44:23.740Z",
  action: "click",
  target: 'button "Create order"',
  result: "ok",
  url: "http://app.test/orders.html",
  ...over,
});

test("replay: a session's steps are grouped into the blocks its tasks made", () => {
  const blocks = taskBlocks([
    step({ task: "Filing an order" }),
    step({ task: "Filing an order", action: "type" }),
    step({ task: "Checking the register", action: "navigate" }),
    step({ task: "Filing an order", action: "click" }),
  ]);
  assert.deepEqual(
    blocks.map((b) => [b.task, b.steps.length]),
    [
      ["Filing an order", 2],
      ["Checking the register", 1],
      // A task that comes back after another starts a new block: the document
      // shows the order things happened in, not a per-task total.
      ["Filing an order", 1],
    ],
  );
  assert.deepEqual(
    taskBlocks([step({ task: undefined })]).map((b) => b.task),
    [null],
  );
  assert.deepEqual(taskBlocks([]), []);
});

test("replay: everything the app under test supplies is escaped", () => {
  const html = buildReplayHtml({
    markdown: "## <img src=x onerror=alert(1)>\n\n- **Id:** `<b>no</b>`\n",
    project: "/p/<SCRIPT>",
    at: "2026-09-20T14:44:23.740Z",
    version: "9.9.9",
    sessions: [{ session: "<svg onload=1>", role: "clerk", objective: "</style><b>", steps: [step({ target: '<IFRAME src="evil">' })] }],
  });
  // Case-insensitive on purpose: a browser reads <SCRIPT> as a script tag, so
  // an assertion that only looks for the lower-case spelling would pass on an
  // escaper that let the upper-case one through.
  assert.ok(!/<script/i.test(html), "no markup from the app under test survives into the document");
  assert.ok(!/<iframe/i.test(html));
  // The payload is still READ in full — a finding whose title is a payload has
  // to show it — but as text: the angle brackets never reach the parser.
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!/<img src=x/i.test(html));
  assert.match(html, /&lt;svg onload=1&gt;/);
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("replay: a finding's frames are the recorded steps that ran before it was filed", () => {
  const steps = [
    step({ at: "2026-09-20T14:00:00.000Z", frame: "recordings/clerk/0001-click.jpg" }),
    step({ at: "2026-09-20T14:00:01.000Z", frame: "recordings/clerk/0002-type.jpg" }),
    step({ at: "2026-09-20T14:00:02.000Z" }),
    step({ at: "2026-09-20T14:00:03.000Z", frame: "recordings/clerk/0003-click.jpg" }),
    // After the finding was filed: not evidence for it.
    step({ at: "2026-09-20T14:00:09.000Z", frame: "recordings/clerk/0004-click.jpg" }),
  ];
  const frames = evidenceFor(steps, "2026-09-20T14:00:05.000Z", 2);
  assert.deepEqual(
    frames.map((f) => f.frame),
    ["recordings/clerk/0002-type.jpg", "recordings/clerk/0003-click.jpg"],
    "the last two recorded steps before it, and a step with no frame is not one",
  );
  assert.deepEqual(
    evidenceFor(
      steps.map((s) => ({ ...s, frame: undefined })),
      "2026-09-20T14:00:05.000Z",
    ),
    [],
    "an unrecorded run has no evidence",
  );
});

test("replay: frames hang under the finding they belong to, at the prefix the reader will fetch them from", () => {
  const evidence = [
    { id: "e3aad70ee8", frames: [{ at: "2026-09-20T14:00:01.000Z", action: "click", detail: "Create order", frame: "recordings/clerk/0002.jpg" }] },
  ];
  const md = "### A finding\n\n- **Id:** `e3aad70ee8` · **Category:** http-error\n- **Where:** `/orders.html`\n";
  const file = renderMarkdown(md, evidence);
  assert.match(file, /<details class="evidence">/);
  assert.match(file, /src="recordings\/clerk\/0002\.jpg"/, "beside the file, the stored path is the path");
  const served = renderMarkdown(md, evidence, "record/");
  assert.match(served, /src="record\/recordings\/clerk\/0002\.jpg"/, "over HTTP, the live view's own route");
  // The accordion follows the finding's own list, not the next one's.
  assert.ok(served.indexOf("e3aad70ee8") < served.indexOf('<details class="evidence">'));
  // A finding with no frames reads exactly as it did before recording existed.
  assert.ok(!renderMarkdown(md, [{ id: "e3aad70ee8", frames: [] }]).includes('class="evidence"'));
  assert.ok(!renderMarkdown(md).includes('class="evidence"'));
});

test("replay: a run with no frames says so rather than showing empty boxes", () => {
  const dry = buildReplayHtml({
    markdown: "## Findings\n",
    project: "/p",
    at: "2026-09-20T14:44:23.740Z",
    version: "9.9.9",
    sessions: [{ session: "clerk", role: "clerk", steps: [step()] }],
  });
  assert.match(dry, /attach with record:true/);
  assert.ok(!dry.includes("<img"), "nothing to show, so nothing that could break");

  const wet = buildReplayHtml({
    markdown: "## Findings\n",
    project: "/p",
    at: "2026-09-20T14:44:23.740Z",
    version: "9.9.9",
    sessions: [{ session: "clerk", role: "clerk", steps: [step({ frame: "recordings/clerk/0001.jpg" })] }],
  });
  assert.match(wet, /click a frame to open it full size/);
  assert.match(wet, /1 steps · 1 task · 1 frames/);
  // One file: it has to open from a filesystem with nothing else around it.
  assert.ok(!/<link |<script src=/.test(wet), "no external asset");
});

test("replay: a frame's path is a plain file name, whoever named the session", () => {
  assert.equal(framePath("clerk", 7, "click"), "recordings/clerk/0007-click.jpg");
  // The live view fetches frames by this path, so it is a URL as much as a
  // file: always forward slashes, never a Windows separator.
  assert.ok(!framePath("clerk", 1, "click").includes("\\"));
  // The session name comes from the agent and the action from the tool.
  assert.equal(framePath("../../etc", 1, "click"), "recordings/etc/0001-click.jpg");
  assert.equal(framePath("a/b", 1, "run_plan step 2"), "recordings/a-b/0001-run_plan-step-2.jpg");
  assert.equal(framePath("...", 1, "..."), "recordings/session/0001-step.jpg");
  assert.equal(framePath("x".repeat(200), 12345, "click").split("/")[1].length, 60);
  assert.equal(RECORD_MAX_FRAMES, 600);
});

test("replay: the header says when, on a clock it names, and says nothing about a version it was not given", () => {
  const base = { markdown: "## Findings\n", project: "/p", sessions: [], at: "2026-09-20T15:19:34.041Z" };
  const named = buildReplayHtml({ ...base, version: "3.1.0" });
  assert.match(named, /written 2026-09-20 15:19 UTC · v3\.1\.0/);
  // The live view renders the same document without one; "· v" alone is noise.
  const bare = buildReplayHtml({ ...base, version: "" });
  assert.match(bare, /written 2026-09-20 15:19 UTC<\/span>/);
  assert.ok(!bare.includes("· v<"));
});

test("the report's summary names the one-page version only when it is really there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-report-"));
  const store = new MemoryStore(dir);
  store.addFinding({ severity: "low", category: "ux-polish", title: "A label reads oddly", detail: "…", url: "http://app.test/x", state: "/x#abc" });

  const ok = generateReport(store, [], { routesVisited: 1, routesTotal: 1, designAudits: 1 });
  assert.match(ok.summary, /The same run as one page/);
  assert.ok(fs.existsSync(path.join(store.dir, "report.html")), "…and it is on disk");

  // A directory where report.html cannot be written: the Markdown is the
  // record and still lands, and the summary says so instead of naming a file
  // the reader would go looking for.
  fs.rmSync(path.join(store.dir, "report.html"));
  fs.mkdirSync(path.join(store.dir, "report.html"));
  const blocked = generateReport(store, [], { routesVisited: 1, routesTotal: 1, designAudits: 1 });
  assert.ok(!/The same run as one page/.test(blocked.summary), blocked.summary.slice(0, 200));
  assert.match(blocked.summary, /could NOT be written/);
  assert.match(blocked.summary, /^Report written to /);
  assert.ok(fs.readFileSync(path.join(store.dir, "report.md"), "utf8").length > 0, "the report of record is unaffected");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replay: a finding's evidence comes from the session that filed it, not from whoever acted last", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-ev-"));
  const store = new MemoryStore(dir);
  // Two browsers working at once: their steps interleave in one log.
  const at = (n: number): string => new Date(Date.parse("2026-09-20T14:00:00.000Z") + n * 1000).toISOString();
  store.logAction({ at: at(1), session: "clerk", action: "click", target: "Save", url: "http://app.test/orders", frame: "recordings/clerk/0001-click.jpg" });
  store.logAction({ at: at(2), session: "admin", action: "click", target: "Approve", url: "http://app.test/admin", frame: "recordings/admin/0001-click.jpg" });
  store.logAction({ at: at(3), session: "clerk", action: "navigate", target: "", url: "http://app.test/orders", frame: "recordings/clerk/0002-navigate.jpg" });
  store.logAction({ at: at(4), session: "admin", action: "navigate", target: "", url: "http://app.test/admin", frame: "recordings/admin/0002-navigate.jpg" });
  const [finding] = store.addFinding({
    severity: "high",
    category: "http-error",
    title: "The archived filter answers 500",
    detail: "…",
    url: "http://app.test/orders",
    state: "/orders#abc",
    session: "clerk",
  });

  const mine = reportEvidence(store).find((e) => e.id === finding.id);
  assert.ok(mine, "the finding has evidence");
  assert.deepEqual(
    mine.frames.map((f) => f.frame),
    ["recordings/clerk/0001-click.jpg", "recordings/clerk/0002-navigate.jpg"],
    "the admin lane's frames are not this finding's evidence, however close in time",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replay: a finding from before sessions were recorded still gets the frames around it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-ev-old-"));
  const store = new MemoryStore(dir);
  store.logAction({
    at: "2026-09-20T14:00:01.000Z",
    session: "clerk",
    action: "click",
    target: "Save",
    url: "http://app.test/x",
    frame: "recordings/clerk/0001-click.jpg",
  });
  const [old] = store.addFinding({
    severity: "low",
    category: "ux-polish",
    title: "A label reads oddly",
    detail: "…",
    url: "http://app.test/x",
    state: "/x#abc",
  });
  assert.equal(old.session, undefined, "a finding filed before this change names no session");
  // Better a frame from the wrong lane than a finding that loses its evidence
  // when memory from an older run is read back.
  const frames = reportEvidence(store).find((e) => e.id === old.id)?.frames ?? [];
  assert.deepEqual(
    frames.map((f) => f.frame),
    ["recordings/clerk/0001-click.jpg"],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replay-redaction: a token in a step's URL never reaches the document that gets handed on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-redact-"));
  const store = new MemoryStore(dir);
  const secret = "http://app.test/reset?access_token=sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
  store.logAction({ at: "2026-09-20T14:00:01.000Z", session: "clerk", action: "navigate", target: "", url: secret });
  // The log is redacted as it is written, so the trail is clean before any
  // document is built from it. This pins that end to end: the page is the one
  // artifact that leaves the machine, and nothing downstream filters again.
  assert.ok(!JSON.stringify(store.actionLog).includes("sk-live-abcdefghijklmnopqrstuvwxyz0123456789"), "the log itself");
  const html = replayDocument(store, "## Findings\n");
  assert.ok(!html.includes("sk-live-abcdefghijklmnopqrstuvwxyz0123456789"), "and the document built from it");
  assert.match(html, /app\.test\/reset/, "…while still saying which page it was");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replay: a frame request can only name a file inside the run's own recordings", () => {
  const root = path.join(path.sep, "p", ".scenescout", "recordings");
  // Resolved on both sides: Windows adds the drive letter, so a literal join
  // is not what the function returns there.
  const want = path.resolve(root, "clerk", "0001-click.jpg");
  assert.equal(resolveFrame(root, "recordings/clerk/0001-click.jpg"), want);
  assert.equal(resolveFrame(root, "clerk/0001-click.jpg"), want);
  // A viewer types the address, so every one of these arrives eventually.
  for (const asked of ["../../etc/passwd", "recordings/../../../etc/passwd", path.join(path.sep, "etc", "passwd"), "", "..", "recordings/", "a\0b"]) {
    assert.equal(resolveFrame(root, asked), null, JSON.stringify(asked));
  }
  // A sibling directory whose name merely starts the same way is not inside it.
  assert.equal(resolveFrame(path.join(path.sep, "p", "rec"), "../recordings-evil/x.jpg"), null);
});

test("replay: only the served copy watches for the engine going away", () => {
  const base = { markdown: "## Findings\n", sessions: [], project: "demo-app", at: "2026-09-20T16:21:00.000Z", version: "3.1.0" };
  const served = buildReplayHtml({ ...base, framePrefix: "record/", savedAt: "/p/.scenescout" });
  const saved = buildReplayHtml(base);

  // Served from a port in a process: once that process is gone, reloading this
  // address gets the browser's own error page and the tab is lost for nothing.
  assert.match(served, /data-testid="run-engine-gone"/);
  assert.match(served, /\/p\/\.scenescout\/report\.html/, "it names the copy that survives");
  assert.match(served, /window\.addEventListener\('beforeunload'/, "leaving asks first, once the engine has gone");
  assert.match(served, /if \(!gone\) return;/, "…and never before that");

  // The copy on disk has no server to lose, so it carries none of it — and no
  // script at all, which is what lets it open from a file with nothing running.
  assert.ok(!saved.includes("run-engine-gone"));
  assert.ok(!saved.includes("<script>"), "the saved copy stays a document");
});

// ---- the report as a worklist -------------------------------------------

test("history is indexed by default, so the findings this run made are not buried", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-hist-"));
  const store = new MemoryStore(dir);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();

  // Many findings from earlier runs, and one from this one.
  for (let i = 0; i < 30; i += 1) {
    const [f] = store.addFinding({
      severity: "high",
      category: "http-error",
      title: `An older finding number ${i}`,
      detail: "A long explanation that costs real bytes when it is printed for every finding in the history. ".repeat(6),
      url: `http://app.test/x${i}`,
      state: `/x${i}#${i}`,
      evidence: `GET /api/x${i} 500`,
    });
    f.foundAt = old;
  }
  const [mine] = store.addFinding({
    severity: "medium",
    category: "ux-confusing",
    title: "The finding this run actually made",
    detail: "…",
    url: "http://app.test/y",
    state: "/y#now",
  });

  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 1 };
  const index = generateReport(store, [], extras, { write: false }).markdown;
  const full = generateReport(store, [], { ...extras, history: "full" }, { write: false }).markdown;

  assert.ok(index.length < full.length / 2, `index ${index.length} should be far shorter than full ${full.length}`);
  // Nothing is lost: every historical finding keeps a row that says what it is.
  assert.match(index, /\| Sev \| Id \| Age \| Runs \| Re-tested \| Title \|/);
  assert.match(index, /An older finding number 0/);
  assert.match(index, /40 days/, "age is what decides whether an unverified finding is worth re-testing");
  // Whether anyone has re-tested it decides the same thing, and says more:
  // a finding confirmed yesterday is not the same as one nobody has looked at.
  assert.match(index, /\| never \|/, "a finding nobody has re-tested says so");
  store.verifyFinding(store.findings[0].id, "present", "still a 500");
  const verified = generateReport(store, [], extras, { write: false }).markdown;
  assert.match(verified, /\| present \d{4}-\d{2}-\d{2} \|/, "and one somebody has carries the verdict and the date");
  assert.ok(!index.includes("costs real bytes"), "the detail is not printed in the index");
  assert.ok(full.includes("costs real bytes"), "…and is still there in full");
  // This run's own finding is printed in full either way.
  assert.match(index, new RegExp(`### .*The finding this run actually made`));
  assert.match(index, new RegExp(`\\*\\*Id:\\*\\* \`${mine.id}\``));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("worth a look: listed below the findings with what would confirm it, and in no defect total", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-look-"));
  const store = new MemoryStore(dir);
  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 1 };
  store.addFinding({
    severity: "high",
    category: "http-error",
    title: "Orders list answers 500",
    detail: "…",
    url: "http://app.test/orders",
    state: "/orders#1",
    evidence: "GET /api/orders 500",
  });
  const before = generateReport(store, [], extras, { write: false });
  const [look] = store.addFinding({
    severity: "low",
    category: "visual",
    title: "Paddings off a 4px grid",
    detail: "13px and 7px paddings on the card list.",
    url: "http://app.test/orders",
    state: "/orders#1",
    evidence: "paddings off a 4px grid: 7px, 13px",
    tier: "worth_a_look",
    convention: "a 4px spacing scale",
  });
  const after = generateReport(store, [], extras, { write: false });
  const md = after.markdown;
  // The totals are the same with it as without it.
  const totals = (m: string) => m.split("\n").find((l) => l.startsWith("| Open findings"));
  assert.equal(totals(md), totals(before.markdown));
  assert.match(totals(md) ?? "", /\| 1 \(1 high\)/);
  assert.equal(
    after.summary.split("\n").find((l) => l.startsWith("OPEN FINDINGS")),
    before.summary.split("\n").find((l) => l.startsWith("OPEN FINDINGS")),
  );
  assert.match(md, /\| Worth a look \(not counted as defects\) \| 1 \|/);
  assert.match(after.summary, /Worth a look .*: 1/);
  // Its own section, below the findings: what was seen and what would confirm it.
  const section = md.indexOf("## Worth a look (1)");
  assert.ok(section > md.indexOf("## Findings — seen this session (1)"), "below the confirmed findings");
  assert.match(md.slice(section), /A defect only if\*\* your project uses a 4px spacing scale/);
  assert.match(md.slice(section), /\*\*Seen:\*\* `paddings off a 4px grid: 7px, 13px`/);
  assert.match(md.slice(section), new RegExp(`\\*\\*Id:\\*\\* \`${look.id}\``), "the id bullet the live view hangs frames under");
  // Not also printed as a finding.
  assert.ok(!md.slice(0, section).includes("Paddings off a 4px grid"), "listed once, in its own section");
  // A report with none has no section at all.
  assert.ok(!before.markdown.includes("## Worth a look"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolved findings are indexed too: they are the least actionable thing in the report", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-res-"));
  const store = new MemoryStore(dir);
  for (let i = 0; i < 20; i += 1) {
    const [f] = store.addFinding({
      severity: "low",
      category: "ux-polish",
      title: `Something already fixed ${i}`,
      detail: "Detail nobody needs to re-read, because it is done. ".repeat(8),
      url: `http://app.test/z${i}`,
      state: `/z${i}#${i}`,
      evidence: `widget z${i} shows 0`,
    });
    store.resolveFinding(f.id);
  }
  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 1 };
  const index = generateReport(store, [], extras, { write: false }).markdown;
  assert.match(index, /## ✅ Resolved \(20\)/);
  assert.match(index, /\| Sev \| Id \| Fixed \| Title \|/);
  assert.match(index, /Something already fixed 0/);
  assert.ok(!index.includes("nobody needs to re-read"), "a fixed finding's detail is not the report's job");
});

test("age reads the way a person would say it", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const ago = (days: number): string => describeAge(new Date(now - days * 86_400_000).toISOString(), now);
  assert.equal(ago(0), "today");
  assert.equal(ago(1), "1 day");
  assert.equal(ago(15), "15 days");
  assert.equal(ago(59), "59 days");
  assert.equal(ago(120), "4 months");
  assert.equal(describeAge("not a date", now), "?");
});

test("the calibration section reaches the report, and stays away when there is nothing to say", () => {
  // Deleting the one line in report.ts that calls formatCalibration left every
  // suite green: the feature could be disconnected from the only place a user
  // sees it, silently.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-calib-"));
  const store = new MemoryStore(dir);
  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 1 };

  const quiet = generateReport(store, [], extras, { write: false }).markdown;
  assert.ok(!quiet.includes("How well the lanes judged"), "a project that never ran a lane gets no section");

  const at = "2026-09-22T10:00:00.000Z";
  const decisions = Array.from({ length: 10 }, (_, i) => ({
    lane: "orders",
    observation: `obs-${i}`,
    verdict: "defect" as const,
    severity: "medium",
    category: "http-error",
    confidence: 0.9,
    evidence: `GET /api/r${i} 500`,
    at,
  }));
  store.addLaneDecisions("orders", decisions);
  for (let i = 0; i < 8; i += 1) {
    store.addFinding({
      severity: "medium",
      category: "http-error",
      title: `t${i}`,
      detail: "d",
      url: `http://app.test/r${i}`,
      state: `/r${i}#1`,
      evidence: `GET /api/r${i} 500`,
    });
  }

  const loud = generateReport(store, [], extras, { write: false }).markdown;
  assert.match(loud, /## How well the lanes judged/);
  assert.match(loud, /10 lane decision\(s\) called a defect/);
  assert.match(loud, /Expected calibration error/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatUnchosenOptions: names each dropdown's untried options, and says nothing when there are none", () => {
  assert.deepEqual(formatUnchosenOptions([]), []);
  const lines = formatUnchosenOptions([{ route: "/orders", key: "orders-status-filter", unchosen: ["Approved", "Archived"] }]);
  assert.match(lines[0], /never chosen this run/);
  assert.equal(lines[1], '  /orders orders-status-filter: "Approved", "Archived"');
  const many = Array.from({ length: 17 }, (_, i) => ({ route: `/r${i}`, key: "f", unchosen: ["x"] }));
  assert.equal(formatUnchosenOptions(many).at(-1), "  … +2 more");
});

test("formatNeverSubmittedEmpty: names each untried form by route and submit control, capped, and says nothing when there are none", () => {
  assert.deepEqual(formatNeverSubmittedEmpty([]), []);
  const lines = formatNeverSubmittedEmpty([{ route: "/things/new", key: "tid:thing-save" }]);
  assert.match(lines[0], /never submitted empty this run/);
  assert.equal(lines[1], "  /things/new tid:thing-save");
  const many = Array.from({ length: 17 }, (_, i) => ({ route: `/r${i}`, key: "button:save" }));
  const capped = formatNeverSubmittedEmpty(many);
  assert.equal(capped.length, 1 + 15 + 1);
  assert.equal(capped.at(-1), "  … +2 more");
});

test("report: trusted embeds are named, and whether they counted", () => {
  const store = freshStore();
  const base = { routesVisited: 1, routesTotal: 1, designAudits: 1, trustedEmbeds: ["https://pay.example.com"] };
  const applied = generateReport(store, [], { ...base, mode: "safe-write" }, { write: false }).markdown;
  assert.match(applied, /## Trusted embeds[\s\S]*were allowed, as the user asked[\s\S]*`https:\/\/pay\.example\.com`/);
  const ignored = generateReport(store, [], { ...base, mode: "read-only" }, { write: false }).markdown;
  assert.match(ignored, /## Trusted embeds[\s\S]*not applied: trust only counts in safe-write mode, and this run was read-only/);
  const none = generateReport(store, [], { routesVisited: 1, routesTotal: 1, designAudits: 1, mode: "safe-write" }, { write: false }).markdown;
  assert.doesNotMatch(none, /Trusted embeds/);
});

test("embedSection: an embed's controls and violations, by origin, apart from the app's", () => {
  assert.deepEqual(embedSection([], { total: 0, exercised: 0 }), [], "nothing embedded, nothing said");
  const at = new Date().toISOString();
  const lines = embedSection(
    [
      { kind: "http_error", severity: "medium", detail: "GET https://chat.example.com/x/12 → HTTP 404", url: "u", at, embed: "https://chat.example.com" },
      { kind: "http_error", severity: "medium", detail: "GET https://chat.example.com/x/13 → HTTP 404", url: "u", at, embed: "https://chat.example.com" },
    ],
    { total: 4, exercised: 1 },
  ).join("\n");
  assert.match(lines, /## Embeds/);
  assert.match(lines, /1\/4 of their controls exercised; not counted in the app's coverage/);
  assert.match(lines, /\| `https:\/\/chat\.example\.com` \| 2 \|/, "one signature, ids folded");
});

test("classifyFilledStates: typing into another site's frame leaves no app form unsubmitted", () => {
  const embed = freshStore();
  embed.visitState("/support#a", "http://app.test/support", "/support", [
    "frame:https://chat.example.com|textbox:message",
    "frame:https://chat.example.com|button:send",
  ]);
  embed.markExercised("/support#a", "frame:https://chat.example.com|textbox:message", "type");
  assert.deepEqual(classifyFilledStates(embed, embed.routeFacts), { unsubmitted: [], noSubmitControl: [] });
  // The contrast: the same controls as the app's own form.
  const own = freshStore();
  own.visitState("/support#a", "http://app.test/support", "/support", ["textbox:message", "button:send"]);
  own.markExercised("/support#a", "textbox:message", "type");
  assert.deepEqual(classifyFilledStates(own, own.routeFacts).unsubmitted, ["/support"]);
});

test("crawl: an explicitly crawled path that answered as a page joins the route contract; a redirect, a failure or an API path does not", () => {
  const page = { path: "/reports/archive", status: 200, requestedRoute: "/reports/archive", landedRoute: "/reports/archive", loginRedirect: false };
  assert.equal(crawledRoute(page), "/reports/archive");
  assert.equal(crawledRoute({ ...page, landedRoute: "/reports" }), null, "redirected: the page it landed on is the route that exists");
  assert.equal(crawledRoute({ ...page, landedRoute: "/login", loginRedirect: true }), null);
  assert.equal(crawledRoute({ ...page, status: 404 }), null);
  assert.equal(crawledRoute({ ...page, deadEnd: true }), null, "the same 200 with nothing on the page: an app answering every path, not a route");
  assert.equal(crawledRoute({ ...page, status: "no-response" }), null);
  assert.equal(crawledRoute({ ...page, path: "/api/things", requestedRoute: "/api/things", landedRoute: "/api/things" }), null);
  // A client-rendered app answers 200 for a path it does not have and draws its not-found view; a page stuck loading is no better.
  assert.equal(crawledRoute({ ...page, mainState: "error" }), null, "the app's error view: a 200 that is not a route");
  assert.equal(crawledRoute({ ...page, mainState: "loading" }), null, "a placeholder that never resolved: nothing says the route exists");
  assert.equal(crawledRoute({ ...page, mainState: null }), "/reports/archive", "the same page with content of its own joins");
  assert.equal(mainStateFlag("error"), "ERROR-VIEW");
  assert.equal(mainStateFlag("loading"), "STILL-LOADING");
  assert.equal(mainStateFlag(null), null);
  // With route identity: a crawled record page joins as its route class, and the same page showing the error view does not join at all.
  const record = { path: "/things/WID-2025-001", status: 200, requestedRoute: normalizePath("https://app.example/things/WID-2025-001"), loginRedirect: false };
  const recordPage = { ...record, landedRoute: record.requestedRoute };
  assert.equal(crawledRoute(recordPage), "/things/:id");
  assert.equal(crawledRoute({ ...recordPage, mainState: "error" }), null);

  // Through the store: the known-route count rises by exactly one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-crawl-"));
  try {
    const store = new MemoryStore(dir);
    store.addDiscoveredRoutes([{ route: "/", example: "/" }]);
    const before = Object.keys(store.discoveredRoutes).length;
    const joined = crawledRoute(page);
    if (joined) store.addDiscoveredRoutes([{ route: joined, example: page.path }]);
    assert.equal(Object.keys(store.discoveredRoutes).length, before + 1);
    store.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crawl: a path that ended on another route says REDIRECTED in its line, and one that stayed does not", () => {
  const counts = { elements: 94, missingTestid: 0, unnamed: 0 };
  const stayed = { path: "/settings", status: 200, requestedRoute: "/settings", landedRoute: "/settings", loginRedirect: false };
  assert.equal(crawlLine(stayed, counts, []), "/settings — 200 · 94 el");
  assert.equal(crawlLine({ ...stayed, landedRoute: "/settings/profile" }, counts, []), "/settings — 200 · 94 el · REDIRECTED → /settings/profile");
  assert.equal(
    crawlLine({ ...stayed, landedRoute: "/login", loginRedirect: true }, counts, ["AUTH-REDIRECT"]),
    "/settings — 200 · 94 el · AUTH-REDIRECT",
    "the sign-in bounce keeps its own flag, not both",
  );
  assert.equal(crawlLine(stayed, { elements: 3, missingTestid: 2, unnamed: 1 }, ["1⚠"]), "/settings — 200 · 3 el · 2 no-testid · 1 unnamed · 1⚠");
  assert.equal(
    crawlLine({ ...stayed, landedRoute: "/settings/profile" }, { ...counts, main: "main EMPTY" }, []),
    "/settings — 200 · 94 el · main EMPTY · REDIRECTED → /settings/profile",
    "what the main area holds sits beside the element count",
  );
});

// ---- The plain-language report (#291) ----

test("plain wording: one entry for every finding category and every oracle kind, and nothing else", () => {
  const expected = [...FINDING_CATEGORIES, ...ORACLE_KINDS].sort();
  assert.deepEqual(Object.keys(PLAIN_WORDING).sort(), expected, "a new category or oracle needs its plain words in PLAIN_WORDING");
});

test("plain wording: each entry reads as plain language", () => {
  for (const [kind, words] of Object.entries(PLAIN_WORDING)) {
    assert.ok(words.problem.length > 0 && !words.problem.endsWith("."), `${kind}: the problem is a short phrase without a full stop`);
    assert.match(words.expected, /^[A-Z].*\.$/, `${kind}: what was expected is a sentence`);
    // The vocabulary this view exists to keep out: oracle names, status codes, request methods, route syntax.
    for (const text of [words.problem, words.expected]) {
      assert.doesNotMatch(text, /oracle|_|\bHTTP\b|\b[1-5]\d\d\b|:id|testid|\bDOM\b/i, `${kind}: "${text}" is not plain`);
      assert.doesNotMatch(text, /\b(GET|POST|PUT|PATCH|DELETE)\b/, `${kind}: "${text}" names a request method`);
    }
  }
  assert.deepEqual(plainWording("a-category-from-an-older-file"), PLAIN_WORDING.other);
  assert.deepEqual(plainWording("toString"), PLAIN_WORDING.other, "a prototype key is not a category");
  assert.deepEqual(IMPACT, { high: "Blocks users", medium: "Annoying", low: "Cosmetic" });
});

test("plain steps: each repro action as a person would do it, and the tester's own steps left out", () => {
  const cases: Array<[string, string | null]> = [
    ["navigate http://app.test/things @ http://app.test/things", "Go to http://app.test/things"],
    ["crawl /things/new @ http://app.test/things/new", "Go to http://app.test/things/new"],
    ['click button "Save" @ http://app.test/things', 'Click the "Save" button'],
    ['click link "New thing" @ http://app.test/things/new', 'Click the "New thing" link'],
    ['click×2 button "Create" @ http://app.test/x', 'Double-click the "Create" button'],
    ['click×3 button "Create" @ http://app.test/x', 'Click 3 times on the "Create" button'],
    ['click button "" @ http://app.test/x', "Click the unnamed button"],
    ['type textbox "Name" ← "Ada" @ http://app.test/x', 'Type "Ada" into the "Name" field'],
    ['type searchbox "Find" ← "a \\"quoted\\" word" + Enter @ http://app.test/x', 'Type "a \\"quoted\\" word" into the "Find" search box and press Enter'],
    ['select combobox "Status" = archived @ http://app.test/x', 'Choose "archived" in the "Status" list'],
    ['upload the "Attachment" input (accepts .pdf) ← report.pdf (1200 bytes, application/pdf; generated) @ http://app.test/x', 'Attach the file "report.pdf"'],
    ['hover button "Help" @ http://app.test/x', 'Point at the "Help" button'],
    ["press Escape @ http://app.test/x", "Press Escape"],
    ["scroll down @ http://app.test/x", "Scroll down"],
    ["back @ http://app.test/x", "Go back to the previous page"],
    ['plan:click button "Next" @ http://app.test/x', 'Click the "Next" button'],
    ['click widget "Odd" @ http://app.test/x', 'Click the "Odd" widget'],
    ["snapshot @ http://app.test/x", null],
    ["screenshot @ http://app.test/x", null],
    ["design-audit @ http://app.test/x", null],
    ["journey:start create a thing @ http://app.test/", null],
    ["write-policy:blocked POST /api/things @ http://app.test/x", null],
  ];
  for (const [line, want] of cases) assert.equal(plainStep(line), want, line);
});

test("plain steps: start at the last page the run went to, or at the page the trace began on", () => {
  assert.deepEqual(
    plainSteps([
      "crawl /elsewhere @ http://app.test/elsewhere",
      "navigate http://app.test/things @ http://app.test/things",
      "snapshot @ http://app.test/things",
      'click button "Export" @ http://app.test/things',
    ]),
    ["Go to http://app.test/things", 'Click the "Export" button'],
    "what came before the last navigation was on another page",
  );
  assert.deepEqual(
    plainSteps([
      "journey:start add a thing @ http://app.test/",
      'click link "New thing" @ http://app.test/things/new',
      'click button "Create" @ http://app.test/things/new',
    ]),
    ["Go to http://app.test/", 'Click the "New thing" link', 'Click the "Create" button'],
    "a trace with no navigation starts on the page its first step was on",
  );
  assert.deepEqual(plainSteps([]), []);
});

test("a finding's picture: its own first, a recorded frame next, and never a path that leaves the run's folder", () => {
  const f = { id: "a", severity: "high", category: "visual", title: "t", detail: "d", url: "u", state: "/s", repro: [], foundAt: "", runs: 1 } as const;
  assert.equal(pictureOf({ ...f, repro: [] }), undefined);
  assert.equal(pictureOf({ ...f, repro: [] }, "recordings/s/0001-click.jpg"), "recordings/s/0001-click.jpg");
  assert.equal(pictureOf({ ...f, repro: [], picture: "findings/a.png" } as never, "recordings/s/0001-click.jpg"), "findings/a.png");
  for (const bad of ["../outside.png", "/etc/x.png", "https://evil.test/x.png", "javascript:alert(1)", "a//b.png", "a b.png", 42]) {
    assert.equal(pictureOf({ ...f, repro: [], picture: bad } as never), undefined, String(bad));
    if (typeof bad === "string") assert.equal(isSafeRelativePath(bad), false, bad);
  }
});

test("the report setting: both puts the plain section first, qa prints it alone, dev prints the technical report alone", () => {
  const store = freshStore();
  store.addFinding({
    severity: "high",
    category: "http-error",
    title: "Saving a thing fails",
    detail: "The save request fails and the form stays open with no message.",
    evidence: "POST /api/things → HTTP 500",
    url: "http://app.test/things/new",
    state: "/things/new#abc",
  });
  store.addFinding({
    severity: "low",
    category: "visual",
    title: "A label is clipped",
    detail: "The label is cut off.",
    url: "http://app.test/",
    state: "/#def",
  });
  const extras = { routesVisited: 2, routesTotal: 3, designAudits: 1 };
  const both = generateReport(store, [{ kind: "http_error", severity: "high", detail: "POST /api/things 500", url: "", at: "" }], extras, {
    write: false,
  }).markdown;
  const qa = generateReport(store, [], { ...extras, report: "qa" }, { write: false }).markdown;
  const dev = generateReport(store, [], { ...extras, report: "dev" }, { write: false }).markdown;
  const unset = generateReport(store, [{ kind: "http_error", severity: "high", detail: "POST /api/things 500", url: "", at: "" }], extras, {
    write: false,
  }).markdown;

  assert.equal(unset, both.replace(/Generated: .*/, unset.match(/Generated: .*/)![0]), "both is the default");
  const order = [
    "# SceneScout Report",
    "## In plain words",
    "### 1. Saving a thing fails",
    "## Technical detail",
    "## Summary",
    "## Findings — seen this session",
  ];
  const at = order.map((h) => both.indexOf(h));
  assert.ok(
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    `sections in order: ${order.map((h, k) => `${h}@${at[k]}`).join(", ")}`,
  );
  assert.match(both, /This run found 2 problems: 1 blocks users and 1 is cosmetic\. It went to 2 of the 3 pages it knew about\./);
  assert.match(both, /- The server refused or failed a request \(once\)/);
  assert.match(both, /\*\*Blocks users\*\* · The server refused or failed a request · on http:\/\/app\.test\/things\/new/);
  assert.match(both, /\*\*What was expected:\*\* The action completes/);
  assert.match(both, /\*\*What happened:\*\* The save request fails/);
  assert.match(
    both,
    /<details><summary>Technical detail<\/summary>\n\n- \*\*Finding id:\*\* `[0-9a-f]+` · \*\*Category:\*\* http-error · \*\*Severity:\*\* high/,
  );
  assert.match(both, /- \*\*Evidence:\*\* `POST \/api\/things → HTTP 500`/);
  assert.equal(both.match(/^- \*\*Id:\*\* /gm)?.length, 2, "each finding's own Id line appears once, in the technical report: frames hang under it");

  assert.ok(qa.includes("## In plain words") && qa.includes("### 2. A label is clipped"));
  for (const technical of ["## Summary", "## Gap ledger", "```ts", "## Technical detail", "the technical detail below"]) {
    assert.ok(!qa.includes(technical), `qa leaves out ${technical}`);
  }
  assert.match(qa, /The run left \d+ things unchecked\.\n\n- /, "with no gap ledger to point at, qa lists what was not checked");

  assert.ok(!dev.includes("In plain words") && !dev.includes("## Technical detail"));
  assert.match(dev, /^# SceneScout Report\n\nGenerated: .*\n\n## Summary\n/, "dev is the technical report as it was");
  assert.equal(
    dev,
    withAudience(dev.split("\n"), "dev", () => ["never built"]),
  );
});

test("report.html: the plain view first, a picture shown, the technical detail one click away", () => {
  const md = [
    "# SceneScout Report",
    "",
    "## In plain words",
    "",
    "### 1. A <b>thing</b> fails",
    "",
    "![What the page showed](recordings/s/0001-click.jpg)",
    "",
    "![x](../../secret.png)",
    "",
    "<details><summary>Technical detail</summary>",
    "",
    "- **Finding id:** `abc`",
    "",
    "</details>",
    "",
    "## Technical detail",
    "",
    "## Summary",
  ].join("\n");
  const file = renderMarkdown(md);
  assert.match(file, /<h3 id="plain">In plain words<\/h3>/);
  assert.match(file, /<h3 id="technical">Technical detail<\/h3>/);
  assert.match(
    file,
    /<figure class="picture"><a href="recordings\/s\/0001-click\.jpg"[^>]*data-testid="report-picture-open"><img [^>]*src="recordings\/s\/0001-click\.jpg" alt="What the page showed">/,
  );
  assert.ok(!file.includes("secret.png"), "a picture path leaving the run's folder is dropped");
  assert.ok(file.includes("A &lt;b&gt;thing&lt;/b&gt; fails"));
  assert.match(file, /<details><summary data-testid="report-technical-toggle">Technical detail<\/summary>/);
  assert.match(renderMarkdown(md, [], "record/"), /src="record\/recordings\/s\/0001-click\.jpg"/, "the served view reaches a recorded frame through its route");
  assert.match(renderMarkdown("![p](findings/a.png)", [], "record/"), /src="findings\/a\.png"/, "only recordings go through the frame route");

  const base = { sessions: [], project: "p", at: "2026-01-01T00:00:00.000Z", version: "" };
  const html = buildReplayHtml({ ...base, markdown: md });
  assert.match(
    html,
    /<nav><a href="#plain" data-testid="report-plain-link">In plain words<\/a><a href="#technical" data-testid="report-technical-link">Technical detail<\/a><a href="#steps"/,
  );
  assert.match(
    buildReplayHtml({ ...base, markdown: "# SceneScout Report\n\n## Summary" }),
    /<nav><a href="#report" data-testid="report-top-link">Report<\/a><a href="#steps"/,
  );
});
