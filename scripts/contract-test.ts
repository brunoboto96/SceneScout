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
import { fileURLToPath } from "node:url";
import { isNonPageRoute, normalizePath } from "../src/engine/fingerprint.ts";
import { crawledRoute, crawlLine, mainStateFlag } from "../src/engine/crawl.ts";
import { MemoryStore, reachedRoutes, type ActionLogEntry } from "../src/engine/memory.ts";
import { COLLECT_INTERACTABLES_SCRIPT, MASKED_NAME } from "../src/engine/collector.ts";
import { FORMS_INVENTORY_SCRIPT } from "../src/engine/forms.ts";
import { RECHECK_EMPTY_AGE_MS } from "../src/engine/settle.ts";
import { keyAtXpath, PAGE_AGE_SCRIPT, SnapshotCollector, SNAPSHOTS_KEPT, type SnapshotElement } from "../src/engine/snapshot-collect.ts";
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
import {
  formatPlainSection,
  IMPACT,
  isSafeRelativePath,
  PLAIN_WORDING,
  pictureOf,
  plainCheckedLine,
  plainDuration,
  plainFinding,
  plainStep,
  plainSteps,
  plainWording,
  type PlainInput,
} from "../src/engine/plain.ts";
import type { Finding } from "../src/engine/memory.ts";
import { FINDING_CATEGORIES } from "../src/engine/memory.ts";
import { ORACLE_KINDS } from "../src/engine/oracles.ts";
import {
  buildReplayHtml,
  escapeHtml,
  evidenceFor,
  frameOnDisk,
  framePath,
  ProjectDirs,
  projectKey,
  RECORD_MAX_FRAMES,
  renderMarkdown,
  tableCells,
  resolveFrame,
  splitProjectFrame,
  taskBlocks,
} from "../src/engine/replay.ts";
import { cspHash, cspMeta, savedPageCsp } from "../src/engine/csp.ts";
import { assertSavedPagePolicy, pagePolicy } from "./saved-page-csp.ts";
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
  assert.match(file, /<div class="filmstrip" data-testid="report-evidence-frames">/);
  assert.match(file, /src="recordings\/clerk\/0002\.jpg"/, "beside the file, the stored path is the path");
  const served = renderMarkdown(md, evidence, "record/");
  assert.match(served, /src="record\/recordings\/clerk\/0002\.jpg"/, "over HTTP, the live view's own route");
  // The accordion follows the finding's own list, not the next one's.
  assert.ok(served.indexOf("e3aad70ee8") < served.indexOf('<div class="filmstrip"'));
  // A finding with no frames reads exactly as it did before recording existed.
  assert.ok(!renderMarkdown(md, [{ id: "e3aad70ee8", frames: [] }]).includes('class="filmstrip"'));
  assert.ok(!renderMarkdown(md).includes('class="filmstrip"'));
});

test("replay: a finding's picture shows open under it, with or without recorded frames, and links to itself", () => {
  const picture = { file: "recordings/clerk/finding-e3aad70ee8.png", width: 320, height: 120, caption: '320×120, "Save" and around it' };
  const md = "### A finding\n\n- **Id:** `e3aad70ee8` · **Category:** http-error\n- **Where:** `/orders.html`\n";
  const alone = renderMarkdown(md, [{ id: "e3aad70ee8", frames: [], picture }]);
  assert.match(alone, /<figure class="picture">/);
  assert.match(alone, /data-testid="finding-picture-open" data-finding="e3aad70ee8"/);
  assert.match(alone, /<img loading="lazy" [^>]*src="recordings\/clerk\/finding-e3aad70ee8\.png" width="320" height="120"/);
  assert.match(alone, /320×120, &quot;Save&quot; and around it/, "the caption is escaped");
  assert.ok(!alone.includes('class="filmstrip"'), "no frames: no strip");
  assert.ok(alone.indexOf("e3aad70ee8") < alone.indexOf('<figure class="picture">'), "under the finding's own list");
  const served = renderMarkdown(md, [{ id: "e3aad70ee8", frames: [], picture }], "record/");
  assert.match(served, /src="record\/recordings\/clerk\/finding-e3aad70ee8\.png"/, "over HTTP, the live view's route");
  const both = renderMarkdown(md, [
    { id: "e3aad70ee8", frames: [{ at: "2026-09-20T14:00:01.000Z", action: "click", detail: "Save", frame: "recordings/clerk/0002.jpg" }], picture },
  ]);
  assert.ok(both.indexOf('<figure class="picture">') < both.indexOf('<div class="filmstrip"'), "the picture first, then the frames");
  // The contrast: the same finding with no picture shows none.
  assert.ok(!renderMarkdown(md, [{ id: "e3aad70ee8", frames: [] }]).includes("picture"));
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
  assert.match(bare, /written 2026-09-20 15:19 UTC<\/p>/);
  assert.ok(!bare.includes("· v<"));
});

test("a finding with its own picture and no recorded frames still gets a report, with no last frame", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-report-"));
  const store = new MemoryStore(dir);
  const [finding] = store.addFinding({
    severity: "medium",
    category: "ux-confusing",
    title: "Save shows no feedback",
    detail: "…",
    url: "http://app.test/x",
    state: "/x#abc",
  });
  // As a finding filed on a run that is not recording: a picture, and no frames.
  (finding as { picture?: string }).picture = `recordings/default/finding-${finding.id}.png`;
  const report = generateReport(store, [], { routesVisited: 1, routesTotal: 1, designAudits: 1 }, { write: false });
  assert.match(report.markdown, /Save shows no feedback/);
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

/** An action logged at a time the test names: the store dates an entry itself only when the entry carries no time. */
const logAt = (store: MemoryStore, entry: ActionLogEntry): void => store.logAction(entry);

test("replay: a finding's evidence comes from the session that filed it, not from whoever acted last", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-ev-"));
  const store = new MemoryStore(dir);
  // Two browsers working at once: their steps interleave in one log.
  const at = (n: number): string => new Date(Date.parse("2026-09-20T14:00:00.000Z") + n * 1000).toISOString();
  logAt(store, { at: at(1), session: "clerk", action: "click", target: "Save", url: "http://app.test/orders", frame: "recordings/clerk/0001-click.jpg" });
  logAt(store, { at: at(2), session: "admin", action: "click", target: "Approve", url: "http://app.test/admin", frame: "recordings/admin/0001-click.jpg" });
  logAt(store, { at: at(3), session: "clerk", action: "navigate", target: "", url: "http://app.test/orders", frame: "recordings/clerk/0002-navigate.jpg" });
  logAt(store, { at: at(4), session: "admin", action: "navigate", target: "", url: "http://app.test/admin", frame: "recordings/admin/0002-navigate.jpg" });
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
  logAt(store, {
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
  logAt(store, { at: "2026-09-20T14:00:01.000Z", session: "clerk", action: "navigate", target: "", url: secret });
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

test(
  "replay: a frame read from disk is a file really inside the recordings folder; a link out of it, or a linked folder, is not",
  { skip: process.platform === "win32" },
  () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ss-frame-links-"));
    try {
      const root = path.join(project, ".scenescout", "recordings");
      fs.mkdirSync(path.join(root, "clerk"), { recursive: true });
      fs.writeFileSync(path.join(root, "clerk", "0001-click.jpg"), "a frame");
      const outside = path.join(project, "elsewhere");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret.jpg"), "not a frame");
      fs.symlinkSync(path.join(outside, "secret.jpg"), path.join(root, "clerk", "0002-click.jpg"));
      fs.symlinkSync(outside, path.join(root, "linked"), "dir");
      // A link that stays inside the folder names a frame that is there, as the export reads it.
      fs.symlinkSync(path.join(root, "clerk", "0001-click.jpg"), path.join(root, "clerk", "0003-again.jpg"));
      assert.equal(frameOnDisk(root, "recordings/clerk/0001-click.jpg"), fs.realpathSync(path.join(root, "clerk", "0001-click.jpg")));
      assert.equal(frameOnDisk(root, "recordings/clerk/0003-again.jpg"), fs.realpathSync(path.join(root, "clerk", "0001-click.jpg")));
      assert.equal(frameOnDisk(root, "recordings/clerk/0002-click.jpg"), null, "a link to a file outside");
      assert.equal(frameOnDisk(root, "recordings/linked/secret.jpg"), null, "a file under a linked folder");
      assert.equal(frameOnDisk(root, "recordings/clerk/missing.jpg"), null, "a frame that is not there");
      assert.equal(frameOnDisk(root, "recordings/clerk"), null, "a folder is not a frame");
      assert.equal(frameOnDisk(root, "../elsewhere/secret.jpg"), null);
      // A project reached through a linked path (as /tmp is on macOS) still has its frames: both sides are followed.
      const viaLink = `${project}-via-link`;
      fs.symlinkSync(project, viaLink, "dir");
      try {
        const linkedRoot = path.join(viaLink, ".scenescout", "recordings");
        assert.equal(frameOnDisk(linkedRoot, "recordings/clerk/0001-click.jpg"), fs.realpathSync(path.join(root, "clerk", "0001-click.jpg")));
        assert.equal(frameOnDisk(linkedRoot, "recordings/clerk/0002-click.jpg"), null);
      } finally {
        fs.unlinkSync(viaLink);
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  },
);

test("replay: a run page's frame address names its project, and only a folder a page was rendered from can be named (#457)", () => {
  const a = projectKey("/work/project-a");
  assert.match(a, /^p-[0-9a-f]{12}$/);
  assert.equal(projectKey("/work/project-a/"), a, "the same folder, written another way, has the same key");
  assert.notEqual(projectKey("/work/project-b"), a);
  assert.ok(!a.includes("project"), "the key reveals nothing of the folder's name");
  assert.deepEqual(splitProjectFrame(`${a}/recordings/clerk/finding-1.png`), { key: a, rest: "recordings/clerk/finding-1.png" });
  // The live board's frames carry no project, and keep resolving as before.
  assert.deepEqual(splitProjectFrame("recordings/clerk/0001-click.jpg"), { rest: "recordings/clerk/0001-click.jpg" });
  assert.deepEqual(splitProjectFrame("p-xyz/recordings/a.jpg"), { rest: "p-xyz/recordings/a.jpg" }, "not a key: left as a path");
  const dirs = new ProjectDirs();
  assert.equal(dirs.dir(a), undefined, "a key no page was rendered with names nothing");
  assert.equal(dirs.remember("/work/project-a"), a);
  dirs.remember("/work/project-b");
  assert.equal(dirs.dir(a), "/work/project-a", "an earlier project stays reachable after a later one");
  assert.equal(dirs.dir(projectKey("/work/project-b")), "/work/project-b");
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

test("replay: the saved and the served page each carry a policy that lets only their own code run", () => {
  const base = {
    markdown: "## Findings\n\n![The broken button](recordings/clerk/0001-click.jpg)\n",
    sessions: [{ session: "agent-0", role: "clerk", objective: "", steps: [step({ frame: "recordings/clerk/0001-click.jpg" })] }],
    project: "demo-app",
    at: "2026-09-20T16:21:00.000Z",
    version: "3.1.0",
  };
  // Opened from disk, with no server to send a header: the page's own head is the only place a policy can be.
  const saved = buildReplayHtml(base);
  assertSavedPagePolicy(saved, "report.html");
  assert.match(saved, /onerror=/, "the saved page has the picture handler the policy has to allow");
  assert.equal(pagePolicy(saved).get("connect-src"), undefined, "the saved copy asks nothing of anyone");
  // The same page served by the live view watches for the engine: its one script, and the fetch it makes, are allowed too.
  const served = buildReplayHtml({ ...base, framePrefix: "record/", savedAt: "/p/.scenescout" });
  assertSavedPagePolicy(served, "the served run page");
  assert.deepEqual(pagePolicy(served).get("connect-src"), ["'self'"]);
  // A page with no pictures and no script runs nothing.
  assertSavedPagePolicy(buildReplayHtml({ ...base, markdown: "## Findings\n", sessions: [] }), "an empty report.html");
  assert.deepEqual(pagePolicy(buildReplayHtml({ ...base, markdown: "## Findings\n", sessions: [] })).get("script-src"), ["'none'"]);
});

test("csp: a hash is the base64 SHA-256 of the exact text, and a policy holds nothing that could end its attribute", () => {
  assert.equal(cspHash(""), "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
  assert.equal(savedPageCsp().includes("script-src 'none'"), true);
  assert.match(
    savedPageCsp({ scripts: ["a()"], handlers: ["b()", "b()"] }),
    /script-src 'unsafe-hashes' 'sha256-[^']+' 'sha256-[^']+';/,
    "a handler named twice is listed once",
  );
  assert.throws(() => cspMeta('default-src "x"'), /markup characters/);
});

test("replay: a folder name cannot end the served copy's script", () => {
  // The saved file's path is written into the script as a string. A folder
  // name holding "</script>" ended the element there, and what followed ran as
  // a script of its own on the live view's origin.
  const savedAt = "/work/a</script><script>window.hit=1</script><!--/.scenescout";
  const html = buildReplayHtml({ markdown: "## Findings\n", sessions: [], project: "demo-app", at: "2026-09-20T16:21:00.000Z", version: "3.1.0", savedAt });
  assert.equal(html.match(/<script>/g)?.length, 1, "one script element, the page's own");
  assert.ok(!html.includes("<script>window.hit"), "the folder name is not markup");
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const named = /var saved = ("(?:[^"\\]|\\.)*");/.exec(script)?.[1];
  assert.equal(JSON.parse(named ?? "null"), `${savedAt}/report.html`, "the path the copy button copies is still the folder's own");
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
    // A plan names its target by locator; none of that shows in the words.
    ["plan:select testid=orders-status-filter @ http://app.test/x", 'Choose an option in the "orders status filter" list'],
    ["plan:click testid=create_order @ http://app.test/x", 'Click the "create order" control'],
    ["plan:click text=Create order @ http://app.test/x", 'Click "Create order"'],
    ['plan:click role=button[name="Save"] @ http://app.test/x', 'Click the "Save" button'],
    ["plan:click role=link[name=Help] @ http://app.test/x", 'Click the "Help" link'],
    ["plan:type label=Email @ http://app.test/x", 'Type into the "Email" field'],
    ["plan:hover testid=help-icon @ http://app.test/x", 'Point at the "help icon" control'],
    ["plan:scroll testid=orders-list @ http://app.test/x", "Scroll the page down 600 pixels"],
    ["plan:scroll down @ http://app.test/x", "Scroll the page down 600 pixels"],
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
  for (const [line] of cases) assert.doesNotMatch(plainStep(line) ?? "", /testid=|text=|label=|role=/, line);
  // A target the plan's own parser refuses is quoted as it is, never half-read
  // into words; a role is read in any case, as the plan reads it.
  const raw: Array<[string, string]> = [
    ['plan:click role=button[name="Save"][exact] @ http://app.test/x', 'Click role=button[name="Save"][exact]'],
    ['plan:click role=button[name="Save"] >> nth=1 @ http://app.test/x', 'Click role=button[name="Save"] >> nth=1'],
    ["plan:click css=.toolbar > button @ http://app.test/x", "Click css=.toolbar > button"],
    ["plan:click testid= @ http://app.test/x", "Click testid="],
    ["plan:click role=BUTTON @ http://app.test/x", "Click the unnamed button"],
  ];
  for (const [line, want] of raw) assert.equal(plainStep(line), want, line);
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

test("the report setting: both puts the Summary first and folds the technical details, qa prints the plain part alone, dev the technical report alone", () => {
  const store = freshStore();
  store.logAction({ action: "click", target: 'button "Save"', url: "http://app.test/things/new" });
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

  const untimed = (md: string): string => md.replace(/Generated: .*/, "Generated: x").replace(/ on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, for [^,]+,/, "");
  assert.equal(untimed(unset), untimed(both), "both is the default");
  const order = [
    "# SceneScout Report",
    "## Summary",
    "| 1 | Blocks users | Saving a thing fails | /things/new |",
    "<details><summary>1. Saving a thing fails</summary>",
    "## Technical details",
    "<details><summary>For developers:",
    "## Run metrics",
    "## Findings — seen this session",
  ];
  const at = order.map((h) => both.indexOf(h));
  assert.ok(
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    `sections in order: ${order.map((h, k) => `${h}@${at[k]}`).join(", ")}`,
  );
  assert.match(both, /\n<\/details>\n*$/, "the technical details close at the end of the document");
  assert.ok(!both.includes("## Evidence"), "no picture and no recorded frame: no Evidence section");
  assert.match(
    both,
    /SceneScout checked http:\/\/app\.test on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, for under a minute\. This run found 2 problems: 1 blocks users and 1 is cosmetic\. It went to 2 of the 3 pages it knew about\./,
  );
  assert.match(both, /- The server refused or failed a request \(once\)/);
  assert.match(both, /\*\*Blocks users\*\* · The server refused or failed a request · on http:\/\/app\.test\/things\/new/);
  assert.match(both, /\*\*What was expected:\*\* The action completes/);
  assert.doesNotMatch(both, /also seen on/, "a finding seen on one page names only that page");
  const shared = { ...store.findings[0], seenOn: ["/other-things", "/more-things"] };
  assert.match(plainFinding(shared, 1, { audience: "both" }).join("\n"), /on http:\/\/app\.test\/things\/new, and also seen on \/other-things, \/more-things/);
  assert.match(both, /\*\*What happened:\*\* The save request fails/);
  assert.match(both, /\n- \*\*Finding id:\*\* `[0-9a-f]+` · \*\*Category:\*\* http-error · \*\*Severity:\*\* high/);
  // A Summary reader opens a problem for its steps; its id, category, severity and route are folded once more, under their own name.
  assert.match(
    both,
    /\*\*What happened:\*\* The save request fails[^\n]*\n\n<details><summary>Details for developers<\/summary>\n\n- \*\*Finding id:\*\*/,
    "a problem's technical lines are in a fold of their own inside it",
  );
  assert.match(both, /The run left \d+ things? unchecked\. The technical details list which\./, "no 'gap ledger' in the Summary");
  assert.doesNotMatch(both.slice(0, both.indexOf("## Technical details")), /gap ledger/i);
  assert.match(both, /- \*\*Evidence:\*\* `POST \/api\/things → HTTP 500`/);
  assert.equal(both.match(/^- \*\*Id:\*\* /gm)?.length, 2, "each finding's own Id line appears once, in the technical report: frames hang under it");
  // Inside the folded technical details the repro trace is a list; with nothing folded around it, it folds itself.
  assert.match(both, /\*\*Repro trace \(last actions before finding\):\*\*\n\n1\. click button "Save"/);
  assert.ok(!both.includes("<details><summary>Repro trace"));
  assert.match(dev, /<details><summary>Repro trace \(last actions before finding\)<\/summary>\n\n1\. click button "Save"/);

  assert.ok(qa.includes("## Summary") && qa.includes("<details><summary>2. A label is clipped</summary>"));
  for (const technical of ["## Run metrics", "## Gap ledger", "```ts", "## Technical details", "the technical details below", "For developers"]) {
    assert.ok(!qa.includes(technical), `qa leaves out ${technical}`);
  }
  assert.match(qa, /The run left \d+ things unchecked\.\n\n- /, "with no gap ledger to point at, qa lists what was not checked");

  assert.ok(!dev.includes("## Summary") && !dev.includes("## Technical details") && !dev.includes("For developers"));
  assert.match(dev, /^# SceneScout Report\n\nGenerated: .*\n\n## Run metrics\n/, "dev is the technical report, unfolded");
  assert.equal(
    dev,
    withAudience(dev.split("\n"), "dev", () => ["never built"]),
  );
});

test("the summary's first sentence: what was checked, when, for how long and how carefully, each part only when known", () => {
  assert.equal(plainCheckedLine(undefined), null);
  assert.equal(plainCheckedLine({}), null, "nothing known: no sentence");
  assert.equal(plainCheckedLine({ site: "https://shop.test" }), "SceneScout checked https://shop.test.");
  assert.equal(plainCheckedLine({ mode: "observe" }), 'SceneScout checked the app, with the care level "Look only".');
  assert.equal(
    plainCheckedLine({ site: "https://shop.test", mode: "safe-write", startedAt: "2026-10-17T12:04:45.742Z", endedAt: "2026-10-17T13:10:02.000Z" }),
    'SceneScout checked https://shop.test on 2026-10-17 12:04 UTC, for 1 hour 5 minutes, with the care level "May create test data".',
  );
  assert.equal(
    plainCheckedLine({ site: "https://shop.test", startedAt: "2026-10-17T12:04:45.742Z" }),
    "SceneScout checked https://shop.test on 2026-10-17 12:04 UTC.",
  );
  for (const [ms, words] of [
    [0, "under a minute"],
    [29_000, "under a minute"],
    [61_000, "1 minute"],
    [4 * 60_000 + 40_000, "5 minutes"],
    [60 * 60_000, "1 hour"],
    [125 * 60_000, "2 hours 5 minutes"],
  ] as const) {
    assert.equal(plainDuration(ms), words, String(ms));
  }
  assert.equal(plainDuration(-1), "", "a clock that went backwards says nothing");
});

test("the Evidence section: there with a picture or a recorded frame, absent with neither", () => {
  const withPictures = formatPlainSection(plainGoldenInput("both")).join("\n");
  assert.match(withPictures, /\n## Evidence\n/);
  assert.match(
    withPictures,
    /### 1\. Saving a thing says it worked when it did not\n\n\*\*Blocks users\*\* · on \/things\/new\n\n<!-- finding 0a1b2c3d4e -->\n\n!\[What the page showed\]\(recordings\/s1\/finding-0a1b2c3d4e\.png\)/,
  );
  assert.match(
    withPictures,
    /### 2\. The error hides behind the banner\n[\s\S]*!\[What the page showed\]\(recordings\/s1\/0004-click\.jpg\)/,
    "a recorded frame stands in",
  );
  assert.ok(!/### [34]\. /.test(withPictures.slice(withPictures.indexOf("## Evidence"))), "a problem with no safe picture is not listed under Evidence");
  assert.ok(withPictures.indexOf("## Summary") < withPictures.indexOf("## Evidence"));
  // The contrast: the same problems with no picture and no recorded frame.
  const bare = plainGoldenInput("both");
  const without = formatPlainSection({
    ...bare,
    current: bare.current.map((f) => ({ ...f, picture: undefined })),
    lastFrames: new Map(),
  }).join("\n");
  assert.ok(!without.includes("## Evidence") && !without.includes("**Picture:**"), "no pictures: no Evidence heading and no pointer to one");
  assert.ok(without.includes("## Summary") && without.includes("<details><summary>1. Saving a thing"));
});

test("a Markdown table row splits on its live pipes only", () => {
  assert.deepEqual(tableCells("| a | b |"), ["a", "b"]);
  assert.deepEqual(tableCells(`| ${escapeTableCell("x | y")} | z |`), ["x | y", "z"]);
  assert.deepEqual(tableCells(`| ${escapeTableCell("ends in \\")} | z |`), ["ends in \\", "z"], "an escaped backslash before a live pipe is a backslash");
  assert.deepEqual(tableCells(`| ${escapeTableCell("\\|")} |`), ["\\|"]);
});

test("report.html: a heading named like an object's own key gets no anchor, and a close with nothing open writes nothing", () => {
  assert.ok(!renderMarkdown("## constructor\n\n## __proto__").includes(" id="));
  assert.equal(renderMarkdown("</details>\n\ntext"), "<p>text</p>");
});

test("a problem's title in its fold is escaped once for Markdown and once for the page", () => {
  const f: Finding = {
    id: "0a1b2c3d4e",
    severity: "high",
    category: "visual",
    title: 'A <b>bold</b> </summary> & "quoted" | piped',
    detail: "d",
    url: "http://app.test/",
    state: "/#a",
    repro: [],
    foundAt: "2026-01-01T00:00:00.000Z",
    runs: 1,
  };
  const md = formatPlainSection({ current: [f], historical: 0, worthALook: 0, violations: [], gaps: [], audience: "both" }).join("\n");
  assert.ok(
    md.includes('<details><summary>1. A &lt;b&gt;bold&lt;/b&gt; &lt;/summary&gt; &amp; "quoted" | piped</summary>'),
    "the raw <summary> cannot be closed early",
  );
  assert.ok(md.includes('| A <b>bold</b> </summary> & "quoted" \\| piped |'), "the table cell's pipe is escaped");
  const table = renderMarkdown(md.slice(md.indexOf("| #")));
  assert.equal((table.match(/<tr><td /g) ?? []).length, 1);
  assert.equal(table.split("</tr>")[1].match(/<td /g)?.length, 6, "the escaped pipe stays inside the Problem cell: six cells, no forged column");
  assert.ok(table.includes('<td data-label="Problem">A &lt;b&gt;bold&lt;/b&gt; &lt;/summary&gt; &amp; &quot;quoted&quot; | piped</td>'));
  const html = renderMarkdown(`## Summary\n\n${md.slice(md.indexOf("<details>"))}`);
  assert.ok(
    html.includes('<summary data-testid="report-problem-toggle">1. A &lt;b&gt;bold&lt;/b&gt; &lt;/summary&gt; &amp; &quot;quoted&quot; | piped</summary>'),
  );
  assert.ok(!html.includes("&amp;lt;"), "not escaped twice");
  assert.ok(!/<b>bold/.test(html));
});

/** Findings that reach every branch of the plain section's wording, with fixed ids so the page is the same on every run. */
function plainGoldenInput(audience: PlainInput["audience"]): PlainInput {
  const base = { foundAt: "2026-01-01T00:00:00.000Z", runs: 1 };
  const current: Finding[] = [
    {
      ...base,
      id: "0a1b2c3d4e",
      severity: "high",
      category: "false_success" as never,
      title: "Saving a thing says it worked when it did not",
      detail: 'The page shows "Saved".\nThe server answered with an error.',
      evidence: "POST /api/things → HTTP 500",
      url: "http://app.test/things/new",
      state: "/things/new#abc",
      repro: [
        "navigate http://app.test/ @ http://app.test/",
        "snapshot @ http://app.test/",
        "navigate http://app.test/things/new @ http://app.test/things/new",
        'type textbox "Name" ← "A thing" + Enter @ http://app.test/things/new',
        'click button "Save" @ http://app.test/things/new',
      ],
      seenOn: ["/other-things", "/more-things"],
      picture: "recordings/s1/finding-0a1b2c3d4e.png",
      pictureShot: { width: 400, height: 120, frame: "element", label: "Save", at: "2026-01-01T00:00:00.000Z" },
    },
    {
      ...base,
      id: "1b2c3d4e5f",
      severity: "medium",
      category: "ux-confusing",
      title: "The error hides behind the banner",
      detail: "The error message is under the cookie banner.",
      url: "http://app.test/login",
      state: "/login#def",
      repro: ['click×2 button "Sign in" @ http://app.test/login', 'select combobox "Country" = Narnia @ http://app.test/login'],
    },
    {
      ...base,
      id: "2c3d4e5f60",
      severity: "low",
      category: "a-category-from-an-older-file",
      title: "A label is clipped",
      detail: "The label is cut off.",
      url: "http://app.test/",
      state: "/#ghi",
      repro: [],
    },
    {
      // A picture whose path leaves the folder is never linked; a re-test's verdict and one other page change no words.
      ...base,
      id: "3d4e5f6071",
      severity: "medium",
      category: "http-error",
      title: "The orders page fails to load its list",
      detail: "The list stays empty.\r\nThe server answered 502.",
      evidence: "GET /api/orders → HTTP 502",
      url: "http://app.test/orders?page=2#top",
      state: "/orders#jkl",
      repro: ["navigate http://app.test/orders?page=2 @ http://app.test/orders?page=2", "scroll down @ http://app.test/orders?page=2"],
      seenOn: ["/orders/archive"],
      picture: "../outside.png",
      verdict: "present",
      runs: 4,
    },
  ];
  return {
    current,
    historical: 2,
    worthALook: 1,
    violations: [{ kind: "http_error" }, { kind: "http_error" }, { kind: "console_error" }],
    routes: { visited: 3, total: 5 },
    gaps: ["The admin pages were not visited", "One form was never submitted"],
    lastFrames: new Map([["1b2c3d4e5f", "recordings/s1/0004-click.jpg"]]),
    audience,
    tickets: ["### Ticket THING-1: one criterion answered", ""],
    run: { site: "http://app.test", mode: "observe", startedAt: "2026-01-01T09:00:00.000Z", endedAt: "2026-01-01T09:12:30.000Z" },
  };
}

test("the plain part (Summary and Evidence) is the same page, word for word", () => {
  const golden = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "plain-section.md");
  const page = (["both", "qa"] as const).map((a) => [`<!-- audience: ${a} -->`, ...formatPlainSection(plainGoldenInput(a))].join("\n")).join("\n\n");
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(golden, `${page}\n`);
  assert.equal(
    `${page}\n`,
    fs.readFileSync(golden, "utf8").replace(/\r\n/g, "\n"),
    "the plain section matches scripts/golden/plain-section.md (UPDATE_GOLDEN=1 rewrites it after an intended change)",
  );
});

test("a finding's title with a closing fold tag is text in the folded technical details, and the HTML reads it back as the title", () => {
  const store = freshStore();
  const trap = "Save </details> closes early";
  store.addFinding({ severity: "high", category: "http-error", title: trap, detail: "d", url: "http://app.test/a", state: "/a#1" });
  store.addFinding({ severity: "low", category: "visual", title: "Save closes nothing early", detail: "d", url: "http://app.test/b", state: "/b#2" });
  // A "worth a look" entry has its own heading in the same fold.
  const look = "Spacing </details> off the grid";
  store.addFinding({
    severity: "low",
    category: "visual",
    title: look,
    detail: "d",
    url: "http://app.test/c",
    state: "/c#3",
    tier: "worth_a_look",
    convention: "a 4px scale",
  });
  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 0 };
  const both = generateReport(store, [], extras, { write: false }).markdown;
  const folded = both.slice(both.indexOf("## Technical details"));
  assert.ok(!folded.split("\n").some((l) => l.startsWith("#") && l.includes("</details>")), "no raw fold tag from a title in a heading inside the fold");
  assert.match(folded, /### .* Save &lt;\/details&gt; closes early\n/);
  assert.match(folded, /### Spacing &lt;\/details&gt; off the grid\n/);
  // The contrast: the other title, and the document's balance of folds.
  assert.match(folded, /### .* Save closes nothing early\n/);
  const opens = (both.match(/<details>/g) ?? []).length;
  const closes = (both.match(/^\s*<\/details>$/gm) ?? []).length;
  assert.equal(opens, closes, "every fold the document opens is closed once");
  const html = buildReplayHtml({ project: "p", at: "2026-01-01T00:00:00.000Z", version: "", sessions: [], markdown: both, evidence: [] });
  assert.ok(html.includes("<h4>🔴 [HIGH] Save &lt;/details&gt; closes early</h4>"), "report.html shows the title once-escaped");
  assert.ok(!html.includes("&amp;lt;"), "and never double-escaped");
  // Unfolded (dev), nothing is escaped: the document has no fold to close.
  const dev = generateReport(store, [], { ...extras, report: "dev" }, { write: false }).markdown;
  assert.ok(dev.includes(trap) && dev.includes(`### ${look}`));
});

/** Folds a document opens and closes, counting a raw fold tag anywhere in a line. */
const foldTags = (md: string): { opens: number; closes: number } => ({
  opens: (md.match(/<details>/g) ?? []).length,
  closes: (md.match(/<\/details>/g) ?? []).length,
});

test("app text inside the folds (details, merged titles, repro steps, plan steps, tickets) cannot close a fold, and report.html reads it once-decoded", () => {
  const hostile = "a </details> b <summary>c</summary> &lt;i&gt; `tick`";
  const store = freshStore();
  store.addFinding({
    severity: "high",
    category: "http-error",
    title: "Hostile",
    detail: `first ${hostile}\nsecond </details> line`,
    url: "http://app.test/a",
    state: "/a#1",
  });
  store.addFinding({
    severity: "low",
    category: "visual",
    title: "Plain",
    detail: "A plain detail with `code` & more",
    url: "http://app.test/b",
    state: "/b#2",
  });
  const [bad, plain] = store.findings;
  bad.repro = [`click button "Go </details>" @ http://app.test/a`, `plan:click text=Save </details> @ http://app.test/a`];
  bad.judgedMerges = [{ title: "Merged </details> title", category: "http-error", severity: "high", pSame: 0.9, at: "2026-01-01T00:00:00.000Z" }];
  plain.judgedMerges = [{ title: "Merged plain title", category: "visual", severity: "low", pSame: 0.9, at: "2026-01-01T00:00:00.000Z" }];
  store.addTickets([{ id: "T-1 </details>", title: "Ticket </details> title", criteria: [], source: "pasted </details> text", note: "Found </details> only" }]);
  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 0 };

  const both = generateReport(store, [], extras, { write: false }).markdown;
  // The document opens and closes the same number of folds: nothing app-supplied added or removed one.
  // Fold tags outside code fences, and outside the Summary's own tickets block (plain Markdown, not inside a fold).
  const prose = both.replace(/```[\s\S]*?```/g, "").replace(/### The tickets[\s\S]*?(?=\n<details>|\n## )/, "");
  const clean = foldTags(prose);
  assert.equal(clean.opens, clean.closes, "every fold opens and closes once");
  assert.ok(!/[^\n]<\/details>/.test(prose) && !/<\/details>[^\n]/.test(prose), "a closing fold tag only ever stands on a line of its own");
  assert.ok(
    both.includes("first a &lt;/details&gt; b &lt;summary&gt;c&lt;/summary&gt; &amp;lt;i&amp;gt; tick\nsecond &lt;/details&gt; line"),
    "a detail line is escaped wherever the tag sits",
  );
  assert.ok(both.includes("Merged &lt;/details&gt; title"), "a merged title is escaped");
  assert.ok(both.includes('1. click button "Go &lt;/details&gt;"'), "a repro step is escaped");
  assert.ok(both.includes("### T-1 &lt;/details&gt;: Ticket &lt;/details&gt; title"), "a ticket heading is escaped");
  assert.ok(both.includes("Read from pasted &lt;/details&gt; text.") && both.includes("Found &lt;/details&gt; only"));
  // The contrast: plain text is written as it came, backticks aside, and its merge line is the same shape.
  assert.ok(both.includes("A plain detail with code &amp; more"));
  assert.ok(both.includes("Merged plain title"));

  // report.html: shown once-decoded as text, never as markup, never double-escaped.
  const html = buildReplayHtml({ project: "p", at: "2026-01-01T00:00:00.000Z", version: "", sessions: [], markdown: both, evidence: [] });
  assert.ok(
    html.includes("first a &lt;/details&gt; b &lt;summary&gt;c&lt;/summary&gt; &amp;lt;i&amp;gt; tick second &lt;/details&gt; line"),
    "the detail reads as written, once",
  );
  assert.ok(html.includes("Merged &lt;/details&gt; title") && html.includes("Go &lt;/details&gt;"));
  assert.ok(!html.includes("&amp;lt;/details"), "never escaped twice");
  assert.ok(html.includes("A plain detail with code &amp; more"));
  assert.equal((html.match(/<details/g) ?? []).length, (html.match(/<\/details>/g) ?? []).length, "the page's folds balance");

  // Unfolded (dev): no fold surrounds the entry, so the text is as the app wrote it.
  const dev = generateReport(store, [], { ...extras, report: "dev" }, { write: false }).markdown;
  assert.ok(dev.includes("A plain detail with `code` & more"));
});

test("a Summary problem's fold escapes the page, the steps and what happened, and a plain one is written as it came", () => {
  const mk = (id: string, detail: string, repro: string[], url: string): Finding => ({
    id,
    severity: "high",
    category: "visual",
    title: "Title",
    detail,
    url,
    state: "/#a",
    repro,
    foundAt: "2026-01-01T00:00:00.000Z",
    runs: 1,
  });
  const hostile = mk("0a1b2c3d4e", "It says </details> & more", ['click button "Go </details>" @ http://app.test/a'], "http://app.test/a?q=</details>");
  const quiet = mk("1b2c3d4e5f", "It says nothing odd", ['click button "Go" @ http://app.test/a'], "http://app.test/b");
  const md = formatPlainSection({ current: [hostile, quiet], historical: 0, worthALook: 0, violations: [], gaps: [], audience: "both" }).join("\n");
  const prose = md.replace(/```[\s\S]*?```/g, "");
  const tags = foldTags(prose);
  assert.equal(tags.opens, tags.closes);
  assert.ok(!/[^\n]<\/details>/.test(prose), "no closing fold tag mid-line");
  assert.ok(md.includes('Click the "Go &lt;/details&gt;" button') && md.includes("It says &lt;/details&gt; &amp; more") && md.includes("?q=&lt;/details&gt;"));
  assert.ok(md.includes('Click the "Go" button') && md.includes("It says nothing odd"), "the plain problem is unchanged");
  const html = renderMarkdown(`## Summary\n\n${md.slice(md.indexOf("<details>"))}`);
  assert.ok(html.includes("Click the &quot;Go &lt;/details&gt;&quot; button") && html.includes("It says &lt;/details&gt; &amp; more"));
  assert.ok(!html.includes("&amp;lt;") && !html.includes("&amp;amp;"), "decoded once");
});

test("a plan's scroll step is worded as the page scrolling, not a control", () => {
  assert.equal(plainStep("plan:scroll testid=orders-list @ http://app.test/x"), "Scroll the page down 600 pixels");
  assert.equal(plainStep("plan:scroll 300 @ http://app.test/x"), "Scroll the page down 300 pixels");
  assert.equal(plainStep("plan:scroll bottom @ http://app.test/x"), "Scroll to the bottom of the page");
  assert.equal(plainStep("plan:scroll top @ http://app.test/x"), "Scroll to the top of the page");
  // The contrast: a scroll the person asked for by name keeps its target.
  assert.equal(plainStep("scroll down @ http://app.test/x"), "Scroll down");
});

test("the Evidence caption names no finding id, and the HTML still hangs the recorded frames under the item", () => {
  const withPictures = formatPlainSection(plainGoldenInput("both")).join("\n");
  const evidence = withPictures
    .slice(withPictures.indexOf("## Evidence"))
    .split("\n")
    .filter((l) => !l.startsWith("!["))
    .join("\n");
  assert.doesNotMatch(evidence.replace(/<!-- finding [0-9a-f]+ -->/g, ""), /finding|0a1b2c3d4e/, "the visible Evidence text carries no id");
  assert.match(evidence, /<!-- finding 0a1b2c3d4e -->/);
  const md = [
    "## Evidence",
    "",
    "### 1. A thing",
    "",
    "**Blocks users** · on /things",
    "",
    "<!-- finding abc0123456 -->",
    "",
    "![What the page showed](recordings/s/0001-click.jpg)",
    "",
  ].join("\n");
  const frame = { id: "abc0123456", frames: [{ at: "2026-01-01T00:00:01.000Z", action: "click", detail: "Save", frame: "recordings/s/0002-click.jpg" }] };
  const html = renderMarkdown(md, [frame], "");
  assert.ok(!html.includes("abc0123456") && !html.includes("&lt;!--"), "the comment is not shown");
  assert.match(html, /0002-click\.jpg/, "the frames recorded before the finding sit under the item");
  const bare = renderMarkdown(md.replace("<!-- finding abc0123456 -->", ""), [frame], "");
  assert.doesNotMatch(bare, /0002-click\.jpg/, "without the anchor there is nothing to hang them from");
});

test("report.html: Summary, Evidence, then Technical details and Steps folded, a picture shown, nothing from the app unescaped", () => {
  const md = [
    "# SceneScout Report",
    "",
    "Generated: 2026-01-01T00:00:00.000Z",
    "",
    "## Summary",
    "",
    "SceneScout checked the app.",
    "",
    "| # | Impact | Problem | Where | What you'd see | What was expected |",
    "|---:|---|---|---|---|---|",
    "| 1 | Blocks users | A <b>thing</b> fails | /things | x | y |",
    "",
    "<details><summary>1. A &lt;b&gt;thing&lt;/b&gt; fails</summary>",
    "",
    "**Blocks users** · on /things",
    "",
    "</details>",
    "",
    "## Evidence",
    "",
    "### 1. A <b>thing</b> fails",
    "",
    "**Blocks users** · on /things",
    "",
    "<!-- finding abc0123456 -->",
    "",
    "![What the page showed](recordings/s/0001-click.jpg)",
    "",
    "![x](../../secret.png)",
    "",
    "## Technical details",
    "",
    "<details><summary>For developers: the rest.</summary>",
    "",
    "## Run metrics",
    "",
    "- **Id:** `abc0123456` · **Category:** visual",
    "",
    "</details>",
  ].join("\n");
  const evidence = [{ id: "abc0123456", frames: [{ at: "2026-01-01T00:00:01.000Z", action: "click", detail: "Save", frame: "recordings/s/0001-click.jpg" }] }];
  const file = renderMarkdown(md, evidence);
  assert.match(file, /<h2 id="summary">Summary<\/h2>/);
  assert.match(file, /<h2 id="evidence">Evidence<\/h2>/);
  assert.match(
    file,
    /<details class="part" id="technical" data-testid="report-technical-section"><summary data-testid="report-technical-toggle"><h2>Technical details<\/h2><span class="hint">For developers: the rest\.<\/span><\/summary>/,
    "the technical details start folded, the heading in the summary",
  );
  assert.match(file, /<h3>Run metrics<\/h3>/, "a heading inside a folded part goes one level down");
  assert.match(file, /<table class="problems" data-testid="report-problems-table">/);
  assert.match(file, /<td data-label="Impact"><span class="impact high">Blocks users<\/span><\/td>/);
  assert.match(file, /<details class="problem"><summary data-testid="report-problem-toggle">1\. A &lt;b&gt;thing&lt;\/b&gt; fails<\/summary>/);
  assert.match(file, /<article class="ev" data-testid="report-evidence-item"><div class="ev-head">\n<h3>1\. A &lt;b&gt;thing&lt;\/b&gt; fails<\/h3>/);
  assert.match(
    file,
    /<figure class="picture"><a href="recordings\/s\/0001-click\.jpg"[^>]*data-testid="report-picture-open"><img [^>]*src="recordings\/s\/0001-click\.jpg" alt="What the page showed">/,
  );
  assert.equal(file.match(/class="filmstrip"/g)?.length, 1, "the frames show under the Evidence item, and not again under the technical Id");
  assert.ok(file.indexOf('class="filmstrip"') < file.indexOf('id="technical"'));
  assert.ok(!file.includes("secret.png"), "a picture path leaving the run's folder is dropped");
  assert.ok(!/<b>thing/.test(file), "the app's markup is text");
  assert.match(renderMarkdown(md, [], "record/"), /src="record\/recordings\/s\/0001-click\.jpg"/, "the served view reaches a recorded frame through its route");
  assert.match(renderMarkdown("![p](findings/a.png)", [], "record/"), /src="findings\/a\.png"/, "only recordings go through the frame route");

  const base = { project: "p", at: "2026-01-01T00:00:00.000Z", version: "" };
  const sessions = [{ session: "clerk", role: "", steps: [step({ frame: "recordings/s/0001-click.jpg" })] }];
  const html = buildReplayHtml({ ...base, sessions, markdown: md, evidence });
  assert.ok(!html.includes("SceneScout Report</h") && !html.includes("Generated:"), "the header says the title and the date once");
  const order = ['id="summary"', 'id="evidence"', 'id="technical"', 'id="steps"'].map((x) => html.indexOf(x));
  assert.ok(
    order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])),
    `Summary, Evidence, Technical details, Steps: ${order.join(", ")}`,
  );
  for (const part of html.match(/<details class="part"[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(part), `${part} starts folded`);
  assert.equal(html.match(/<details class="part"/g)?.length, 2, "two folded parts: the technical details and the steps");
  assert.match(html, /<summary data-testid="report-steps-toggle"><h2>Steps<\/h2><span class="hint">[^<]*1 session, 1 step\.<\/span>/);
  assert.match(
    html,
    /<nav aria-label="Report sections"><a href="#summary" data-testid="report-summary-link">Summary<\/a><a href="#evidence" data-testid="report-evidence-link">Evidence<\/a><a href="#technical" data-testid="report-technical-link">Technical details<\/a><a href="#steps" data-testid="report-steps-link">Steps<\/a><\/nav>/,
  );
  // The contrast: the same report with nothing to show has no Evidence, in the page or its header.
  const plain = md.slice(0, md.indexOf("## Evidence")) + md.slice(md.indexOf("## Technical details"));
  const none = buildReplayHtml({ ...base, sessions, markdown: plain });
  assert.ok(!none.includes('id="evidence"') && !none.includes("report-evidence-link") && !none.includes("report-evidence-item"));
  assert.match(
    buildReplayHtml({ ...base, sessions: [], markdown: "# SceneScout Report\n\n## Run metrics" }),
    /<nav aria-label="Report sections"><a href="#report" data-testid="report-top-link">Report<\/a><a href="#steps"/,
  );
  assert.ok(!/<link |<script src=|@import|https?:\/\/fonts/.test(html), "no external request: no font, stylesheet or script from anywhere else");
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /@media print/);
});

test("saved-page policy check: a script or handler it cannot see would pass a page that runs code its policy does not name", () => {
  const page = (body: string) =>
    `<!doctype html><html><head><meta charset="utf-8">\n${cspMeta(savedPageCsp())}\n<title>t</title><style></style></head><body>${body}</body></html>`;
  assertSavedPagePolicy(page("<p>nothing runs</p>"), "a page with no code");
  for (const body of ['<script type="module">a()</script>', "<SCRIPT>a()</SCRIPT>", "<script>a()</script >", '<img ONERROR="a()" src="x.png">']) {
    assert.throws(() => assertSavedPagePolicy(page(body), body), /a page with no scripts runs none|exactly the page's own inline code/, body);
  }
});

// ---- snapshot collection: refs, kept snapshots and the hydration retry (snapshot-collect.ts) ----

type RawStandIn = {
  tag: string;
  role: string;
  name: string;
  testid: string | null;
  xpath: string;
  disabled: boolean;
  href: string | null;
  rect: { x: number; y: number; width: number; height: number };
  cut?: boolean;
};

const raw = (name: string, over: Partial<RawStandIn> = {}): RawStandIn => ({
  tag: "button",
  role: "button",
  name,
  testid: null,
  xpath: `/html/body/button[${name}]`,
  disabled: false,
  href: null,
  rect: { x: 0, y: 0, width: 80, height: 24 },
  ...over,
});

/**
 * A page that answers the collector's element read with the next of `reads`
 * (repeating the last), its form read with `forms`, and has no frames.
 */
function collectorOn(
  reads: RawStandIn[][],
  opts: {
    url?: string;
    forms?: unknown[];
    busyReads?: number;
    ageMs?: number;
    navigateOnRead?: { at: number; to: string; reads: RawStandIn[][] };
    closed?: boolean;
    scriptError?: boolean;
  } = {},
) {
  const top = { name: "top" };
  // The page's age starts at `ageMs` (by default long since loaded) and grows by every wait the collector asks for.
  const state = {
    url: opts.url ?? "http://app.test/things",
    reads: [...reads],
    elementReads: 0,
    harvested: 0,
    ageMs: opts.ageMs ?? 60_000,
    pageReads: 0,
    loadWaits: 0,
  };
  const page = {
    evaluate: async (script: string) => {
      state.pageReads += 1;
      if (opts.closed) throw new Error("page.evaluate: Target page, context or browser has been closed");
      if (opts.scriptError) throw new Error("page.evaluate: TypeError: x.y is not a function");
      // The page's own scripts navigate while this read is in the page: Playwright rejects it, and the next read runs in
      // the document that replaced it, which has just arrived.
      const nav = opts.navigateOnRead;
      if (nav && state.pageReads === nav.at) {
        state.url = nav.to;
        state.reads = [...nav.reads];
        state.ageMs = 0;
        throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
      }
      if (script === COLLECT_INTERACTABLES_SCRIPT) {
        state.elementReads += 1;
        return state.reads.length > 1 ? state.reads.shift() : state.reads[0];
      }
      if (script === FORMS_INVENTORY_SCRIPT) return opts.forms ?? [];
      if (script === PAGE_AGE_SCRIPT) return state.ageMs;
      throw new Error("unexpected page read");
    },
    waitForTimeout: async (ms: number) => {
      state.ageMs += ms;
    },
    waitForLoadState: async () => {
      state.loadWaits += 1;
    },
    isClosed: () => opts.closed === true,
    url: () => state.url,
    mainFrame: () => top,
    frames: () => [top],
  };
  const collector = new SnapshotCollector({
    page: () => page as unknown as import("playwright").Page,
    formRead: (_what, work) => work,
    foreignOriginOf: () => null,
    harvestRoutes: () => {
      state.harvested += 1;
    },
    // A request stays out until the page has been read `busyReads` times: content on its way.
    requests: () => ({ inFlight: state.elementReads < (opts.busyReads ?? 0) ? 1 : 0, lastRequestStart: 0, changedAt: 0 }),
  });
  return { collector, state };
}

/** Keep a collect as its route's snapshot, the way scout_snapshot does. */
function keep(collector: SnapshotCollector, route: string, elements: SnapshotElement[]): void {
  collector.keepSnapshot({
    route,
    byKey: new Map(elements.map((el) => [el.key, { ref: el.ref, label: el.name, href: el.href, disabled: el.disabled, state: [] }])),
  });
}

test("a collect reads the page again until two reads agree, so a hydrating page is not listed half-drawn", async () => {
  const { collector, state } = collectorOn([[], [raw("Menu")], [raw("Menu"), raw("Save")], [raw("Menu"), raw("Save")]]);
  const { elements } = await collector.collect();
  assert.deepEqual(
    elements.map((el) => el.name),
    ["Menu", "Save"],
  );
  assert.equal(state.elementReads, 4);
  assert.equal(state.harvested, 1);
});

test("an empty page is read again rather than taken at its first answer, and twice is enough when nothing is coming", async () => {
  const { collector, state } = collectorOn([[]]);
  const { elements } = await collector.collect();
  assert.equal(elements.length, 0);
  // Quiet and empty twice: nothing is on its way (settle.ts recheckWait). The old rule read it nine times.
  assert.equal(state.elementReads, 2);
});

test("an empty page whose content is still on its way is read until it has drawn", async () => {
  // The same empty first reads, with a request out until the fourth: what it drew then is what is listed.
  const { collector, state } = collectorOn([[], [], [], [raw("Menu"), raw("Save")]], { busyReads: 4 });
  const { elements } = await collector.collect();
  assert.deepEqual(
    elements.map((el) => el.name),
    ["Menu", "Save"],
  );
  // The fourth read drew it while the request was still out; two more, both quiet, agree.
  assert.equal(state.elementReads, 6, "two equal reads, both taken once quiet");
});

test("an empty page that has only just loaded is read until it has been up long enough to call it a dead end", async () => {
  // The same page as above, empty and quiet throughout, but read 150 ms after it loaded: an empty shell that draws
  // from a timer looks exactly like this at first.
  const young = collectorOn([[]], { ageMs: 150 });
  await young.collector.collect();
  assert.ok(young.state.ageMs >= RECHECK_EMPTY_AGE_MS, `read until the page had been up ${RECHECK_EMPTY_AGE_MS} ms (got ${young.state.ageMs})`);
  assert.ok(young.state.elementReads > 2);
  // ...and when it draws in that time, what it drew is listed.
  const late = collectorOn([[], [], [], [], [raw("Menu"), raw("Save")]], { ageMs: 150 });
  const { elements } = await late.collector.collect();
  assert.deepEqual(
    elements.map((el) => el.name),
    ["Menu", "Save"],
  );
});

test("a drawn page that has only just loaded is read until it has been up long enough for a timer to draw the rest", async () => {
  // A shell with its navigation drawn and the route's controls added from a timer, with no request: the first two
  // reads agree on the shell. Read long after the load, two reads are enough.
  const young = collectorOn([[raw("Menu")], [raw("Menu")], [raw("Menu")], [raw("Menu"), raw("Save")]], { ageMs: 150 });
  const { elements } = await young.collector.collect();
  assert.deepEqual(
    elements.map((el) => el.name),
    ["Menu", "Save"],
  );
  const old = collectorOn([[raw("Menu")], [raw("Menu")], [raw("Menu")], [raw("Menu"), raw("Save")]]);
  assert.deepEqual(
    (await old.collector.collect()).elements.map((el) => el.name),
    ["Menu"],
    "a page up for a while is not slowed",
  );
  assert.equal(old.state.elementReads, 2);
});

test("a collect whose page navigates under a read lists the page it landed on rather than failing", async () => {
  // A route's scripts send the visitor to sign-in while its controls are read. Each read (the page's age and its
  // controls) is a place the navigation can land: whichever it interrupts, the collect reads the new page.
  for (let at = 1; at <= 4; at++) {
    const { collector, state } = collectorOn([[raw("Save")]], {
      url: "http://app.test/private",
      navigateOnRead: { at, to: "http://app.test/login?next=%2Fprivate", reads: [[raw("Email"), raw("Sign in")]] },
    });
    const { elements } = await collector.collect();
    assert.deepEqual(
      elements.map((el) => el.name),
      ["Email", "Sign in"],
      `navigated on page read ${at}`,
    );
    assert.ok(state.loadWaits >= 1, "it waited for the new document before reading it again");
  }
  // The contrast: a read that fails because the page has closed, or because the read itself throws, is not taken
  // again; it is the error it was.
  const closed = collectorOn([[raw("Save")]], { closed: true });
  await assert.rejects(closed.collector.collect(), /has been closed/);
  assert.equal(closed.state.loadWaits, 0);
  const throwing = collectorOn([[raw("Save")]], { scriptError: true });
  await assert.rejects(throwing.collector.collect(), /is not a function/);
  assert.equal(throwing.state.pageReads, 1, "read once");
  assert.equal(throwing.state.loadWaits, 0);
});

test("a re-snapshot of a kept route gives an unchanged element its old ref, and a new one a new ref", async () => {
  const { collector, state } = collectorOn([[raw("Save"), raw("Cancel")]]);
  const first = await collector.collect();
  assert.equal(first.prev, null);
  keep(collector, "/things", first.elements);
  state.reads = [[raw("Save"), raw("Cancel"), raw("Delete")]];
  const second = await collector.collect();
  assert.equal(second.prev?.how, "latest");
  const refOf = (els: SnapshotElement[], name: string) => els.find((el) => el.name === name)?.ref;
  assert.equal(refOf(second.elements, "Save"), refOf(first.elements, "Save"));
  assert.equal(refOf(second.elements, "Cancel"), refOf(first.elements, "Cancel"));
  assert.ok(!first.elements.some((el) => el.ref === refOf(second.elements, "Delete")));
  assert.deepEqual(second.matched, [first.elements[0].key, first.elements[1].key, null]);
  // Only the latest collect's refs resolve.
  assert.equal(collector.refs.size, 3);
});

test("a route never kept is listed with new refs", async () => {
  const { collector } = collectorOn([[raw("Save")]]);
  const first = await collector.collect();
  const second = await collector.collect();
  assert.equal(second.prev, null);
  assert.notEqual(second.elements[0].ref, first.elements[0].ref);
});

test("a kept snapshot is compared as the latest, a revisited route, or another tab of the same screen", async () => {
  const { collector, state } = collectorOn([[raw("Save")]], { url: "http://app.test/things?tab=one" });
  keep(collector, "/things?tab=one", (await collector.collect()).elements);
  assert.equal((await collector.collect()).prev?.how, "latest");
  state.url = "http://app.test/things?tab=two";
  const tab = await collector.collect();
  assert.equal(tab.prev?.how, "tab");
  assert.equal(tab.prev?.snap.route, "/things?tab=one");
  keep(collector, "/things?tab=two", tab.elements);
  state.url = "http://app.test/things?tab=one";
  assert.equal((await collector.collect()).prev?.how, "revisited");
});

test("only the last SNAPSHOTS_KEPT routes are kept; the least recent is dropped first", async () => {
  const { collector, state } = collectorOn([[raw("Save")]]);
  for (let i = 0; i <= SNAPSHOTS_KEPT; i++) keep(collector, `/r${i}`, []);
  state.url = "http://app.test/r0";
  assert.equal((await collector.collect()).prev, null);
  state.url = "http://app.test/r1";
  assert.equal((await collector.collect()).prev?.how, "revisited");
});

test("dropped refs remember the first reason until the next kept snapshot, and forgetting clears every kept one", async () => {
  const { collector } = collectorOn([[raw("Save")]]);
  const first = await collector.collect();
  keep(collector, "/things", first.elements);
  collector.dropRefs("the page navigated");
  collector.dropRefs("a dialog closed");
  assert.equal(collector.refs.size, 0);
  assert.equal(collector.refsDropped, "the page navigated");
  keep(collector, "/things", first.elements);
  assert.equal(collector.refsDropped, null);
  collector.dropRefs("the page navigated");
  collector.forgetSnapshots();
  assert.equal(collector.refsDropped, null);
  assert.equal((await collector.collect()).prev, null);
});

test("elements past the collector's cap are counted apart, never listed", async () => {
  const { collector } = collectorOn([[raw("Save"), { ...raw("row"), role: "link", testid: "row-1", cut: true }]]);
  const { elements, cut, truncated } = await collector.collect();
  assert.deepEqual(
    elements.map((el) => el.name),
    ["Save"],
  );
  assert.equal(cut.length, 1);
  assert.equal(truncated, true);
  assert.equal(collector.lastCollectTruncated, true);
  const { collector: plain } = collectorOn([[raw("Save")]]);
  assert.equal((await plain.collect()).truncated, false);
  assert.equal(plain.lastCollectTruncated, false);
});

test("a destructive label is marked as the snapshot lists it, and a ref of the page itself is looked up on the page", async () => {
  const { collector } = collectorOn([[raw("Delete account"), raw("Save")]]);
  const { elements } = await collector.collect();
  assert.deepEqual(
    elements.map((el) => el.destructive),
    [true, false],
  );
  assert.equal(collector.scopeOf(elements[0]) as unknown, (collector as unknown as { host: { page: () => unknown } }).host.page());
});

test("a form with no attributes is known by the key of the page's element at its submit xpath", async () => {
  const field = { tag: "input", type: "text", disabled: false, readOnly: false, visible: true, filled: false };
  const form = (submit: string, submitDisabled: boolean) => ({ attrs: { id: "", name: "", action: "", method: "" }, submit, fields: [field], submitDisabled });
  const { collector } = collectorOn([[raw("Send", { testid: "send" })]], { forms: [form("/html/body/button[Send]", true), form("/nowhere", false)] });
  const { elements, forms } = await collector.collect();
  assert.equal(keyAtXpath(elements, "/html/body/button[Send]"), elements[0].key);
  assert.deepEqual(forms, [{ key: elements[0].key, guarded: true }]);
});

test("a frame's controls are listed in the page's coordinates, masked when another site's, and their refs go stale with the frame", async () => {
  const top = { parentFrame: () => null };
  const frame = {
    href: "https://embed.example/widget",
    detached: false,
    url: () => frame.href,
    isDetached: () => frame.detached,
    parentFrame: () => top,
    frameElement: async () => ({
      boundingBox: async () => ({ x: 100, y: 200, width: 300, height: 150 }),
      getAttribute: async (name: string) => (name === "title" ? "Chat" : null),
    }),
    evaluate: async () => ({ els: [raw("Hi Alex, about the invoice", { tag: "div", role: "listitem" })], sx: 0, sy: 10 }),
  };
  const page = {
    evaluate: async (script: string) => {
      if (script === COLLECT_INTERACTABLES_SCRIPT) return [raw("Save")];
      if (script === FORMS_INVENTORY_SCRIPT) return [];
      return { x: 0, y: 0 };
    },
    waitForTimeout: async () => {},
    url: () => "http://app.test/things",
    mainFrame: () => top,
    frames: () => [top, frame],
  };
  const collector = new SnapshotCollector({
    page: () => page as unknown as import("playwright").Page,
    formRead: (_what, work) => work,
    foreignOriginOf: (f) => (f === (frame as unknown) ? "https://embed.example" : null),
    harvestRoutes: () => {},
    requests: () => ({ inFlight: 0, lastRequestStart: 0, changedAt: 0 }),
  });
  const { elements } = await collector.collect();
  const inFrame = elements.find((el) => el.frame);
  assert.ok(inFrame, JSON.stringify(elements));
  assert.deepEqual(inFrame.frame, { url: "https://embed.example/widget", origin: "https://embed.example", title: "Chat", foreign: true });
  // The frame's own scroll is taken off, the frame element's position added.
  assert.deepEqual([inFrame.rect.x, inFrame.rect.y], [100, 190]);
  assert.equal(inFrame.name, MASKED_NAME);
  assert.equal(collector.scopeOf(inFrame) as unknown, frame);
  assert.equal(collector.framesRead.size, 1);
  frame.href = "https://embed.example/other";
  assert.throws(() => collector.scopeOf(inFrame), /has navigated/);
  frame.detached = true;
  assert.throws(() => collector.scopeOf(inFrame), /has gone/);
});
