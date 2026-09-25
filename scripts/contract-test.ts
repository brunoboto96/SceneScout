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
import { MemoryStore } from "../src/engine/memory.ts";
import {
  classifyFilledStates,
  computeGaps,
  escapeTableCell,
  formatRouteCoverage,
  formatUnchosenOptions,
  describeAge,
  generateReport,
  replayDocument,
  reportEvidence,
} from "../src/engine/report.ts";
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

test("report: trusted embeds are named, and whether they counted", () => {
  const store = freshStore();
  const base = { routesVisited: 1, routesTotal: 1, designAudits: 1, trustedEmbeds: ["https://js.stripe.com"] };
  const applied = generateReport(store, [], { ...base, mode: "safe-write" }, { write: false }).markdown;
  assert.match(applied, /## Trusted embeds[\s\S]*were allowed, as the user asked[\s\S]*`https:\/\/js\.stripe\.com`/);
  const ignored = generateReport(store, [], { ...base, mode: "read-only" }, { write: false }).markdown;
  assert.match(ignored, /## Trusted embeds[\s\S]*not applied: trust only counts in safe-write mode, and this run was read-only/);
  const none = generateReport(store, [], { routesVisited: 1, routesTotal: 1, designAudits: 1, mode: "safe-write" }, { write: false }).markdown;
  assert.doesNotMatch(none, /Trusted embeds/);
});
