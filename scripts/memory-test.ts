/**
 * Unit tests for the memory layer: finding dedup (the tiered sameFinding via
 * addFinding), retroMerge, regression reopening, and coverage aggregation.
 * Drives the MemoryStore from src/ against a temp directory, so this suite
 * tests your edit with no build step.
 *
 * Runs on node:test (built into Node ≥20, no dependency) so each case is
 * isolated, failures print a real diff, and one case can be run alone:
 *   npx tsx --test --test-name-pattern "resurrect" scripts/memory-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  chooseProjectFolder,
  documentsDir,
  enclosingRepo,
  type Home,
  projectsRoot,
  PROJECTS_DIR_ENV,
  siteFolderName,
  workspaceFromRoots,
} from "../src/engine/project-folder.ts";
import {
  LEGACY_MEMORY_DIRNAME,
  MEMORY_DIRNAME,
  MemoryStore,
  adoptLegacyMemoryDir,
  mergeMemory,
  redactSecrets,
  MAX_STATES_PER_ROUTE,
  pruneStates,
  type StateRecord,
  MAX_LANE_DECISIONS,
  MAX_LANE_ROUTES,
  FINDING_CATEGORIES,
  sameFamily,
  mergeableCategories,
  MAX_SELECT_OPTIONS,
  requestsDisagree,
  isEmbedKey,
  isWorthALook,
  renormalizeRoutes,
  mergeTier,
  describeMerge,
  MAX_JUDGED_MERGES,
  judgedMergesOf,
  MAX_SEEN_ON,
  type DuplicateJudge,
  type Finding,
  type FindingInput,
  type JudgeVerdict,
  NAME_RULE,
} from "../src/engine/memory.ts";
import { keyAliases } from "../src/engine/fingerprint.ts";
import { analyzeDesign, type StyleRecord } from "../src/engine/design.ts";
import {
  FORMS_READ_FAILED,
  FORMS_SUBMIT_UNMATCHED,
  TEXT_ENTRY_TYPES,
  allTextEmpty,
  formIdentity,
  formStatus,
  isEmptySubmit,
  APP_FILLED_TYPES,
  FORM_PROBE_BODY,
  isFormBookkeeping,
  isNavigationTeardown,
  isSubmitLike,
  isTextEntry,
  sameControl,
  submits,
  tracksForm,
  type FieldFacts,
  type FormProbe,
} from "../src/engine/forms.ts";
import { coverageView, generateReport } from "../src/engine/report.ts";

/** One styled element for a design audit; override only what a case is about. */
function designRecord(over: Partial<StyleRecord>): StyleRecord {
  return {
    tag: "div",
    testid: null,
    text: "text",
    textLen: 4,
    interactive: false,
    rect: { x: 300, y: 20, w: 200, h: 40 },
    fontSize: 16,
    fontWeight: 400,
    fontFamily: "Inter",
    lineHeight: 24,
    textTransform: "none",
    textAlign: "left",
    underline: false,
    color: "rgb(0, 0, 0)",
    bg: "rgb(255, 255, 255)",
    padding: [8, 8, 8, 8],
    marginV: [0, 0],
    radius: 4,
    shadow: "",
    clipped: false,
    fixed: false,
    required: false,
    submitish: false,
    inputType: "",
    role: "",
    filled: false,
    inForm: false,
    inRow: false,
    inSearch: false,
    inBreadcrumb: false,
    shell: false,
    sideStripe: false,
    gradientText: false,
    glass: false,
    glow: false,
    aiGradient: false,
    ...over,
    textLen: (over.text ?? "text").length,
  };
}

/** Temp dirs created by the running test, cleaned up even when it fails. */
let dirs: string[] = [];

/**
 * Stores opened by the running test. Each holds a debounced write timer; a
 * temp dir deleted while one is pending makes that write fail half a second
 * later, and a green run then prints a wall of "memory write failed" lines —
 * which is exactly what a newcomer's first `npm test` looked like.
 */
let stores: MemoryStore[] = [];

function freshStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}

/** Open a store on an existing directory, tracked so its pending write is settled before cleanup. */
function openStore(dir: string): MemoryStore {
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

const base = { severity: "medium" as const, category: "http-error", url: "http://x/a", state: "/a#f1" };

/** Poll until `cond` holds, failing after a generous bound: waiting on the condition, not a guess at how long it takes. */
async function until(label: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

test("dedup tier 1: the same normalized evidence merges across rephrased titles", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, title: "Dashboard calls /api/reports as User and gets 403", detail: "x", evidence: "GET /api/reports 403" });
  const [, new2] = store.addFinding({ ...base, title: "Reports endpoint denies User role on every load", detail: "y", evidence: "get /api/reports  403" });
  assert.equal(new1, true, "first finding should be new");
  assert.equal(new2, false, "same evidence signature should merge");
});

test("worth a look: a defect wins a merge either way, and an unknown tier on disk reads as a defect", () => {
  const look = { tier: "worth_a_look" as const, convention: "a 4px spacing scale" };
  assert.deepEqual(mergeTier(look, {}), {}, "filed again as a defect: promoted, convention dropped");
  assert.deepEqual(mergeTier({}, look), {}, "a defect stays a defect when someone later calls it worth a look");
  assert.deepEqual(mergeTier(look, { tier: "worth_a_look", convention: "another" }), look, "the first convention is kept");
  assert.deepEqual(mergeTier({ tier: "worth_a_look" }, look), look, "a missing convention is filled in");
  assert.equal(isWorthALook({ tier: "worth_a_look" }), true);
  assert.equal(isWorthALook({}), false);
  assert.equal(isWorthALook({ tier: "something-newer" as never }), false, "never out of the defect count on a value this version does not know");

  const store = freshStore();
  const evidence = "padding 13px off a 4px grid";
  const [first] = store.addFinding({ ...base, category: "visual", title: "Off-grid padding", detail: "x", evidence, ...look });
  assert.equal(first.tier, "worth_a_look");
  assert.equal(first.severity, "medium");
  const [again, isNew, promoted] = store.addFinding({ ...base, severity: "high", category: "visual", title: "Off-grid padding", detail: "x", evidence });
  assert.equal(isNew, false);
  assert.equal(promoted, true, "the merge reply can say it was promoted");
  assert.equal(again.id, first.id);
  assert.equal(again.tier, undefined, "promoted to a defect");
  assert.equal(again.convention, undefined);
  assert.equal(again.severity, "high", "at the severity the defect was filed at");
  const [, , twice] = store.addFinding({ ...base, severity: "low", category: "visual", title: "Off-grid padding", detail: "x", evidence });
  assert.equal(twice, false, "a defect filed again is not a promotion");
  assert.equal(store.findings.find((f) => f.id === first.id)?.severity, "high", "and a plain re-find keeps its severity as before");
});

test("worth a look: two stores writing one memory at once never demote a defect back to worth a look", () => {
  const a = freshStore();
  const look = {
    ...base,
    severity: "low" as const,
    category: "visual",
    title: "Off-grid padding",
    detail: "x",
    evidence: "paddings off a 4px grid: 7px, 13px",
  };
  const [first] = a.addFinding({ ...look, tier: "worth_a_look", convention: "a 4px spacing scale" });
  a.flush();
  // A second process opens the same memory and files the same thing as a defect.
  const b = openStore(path.dirname(a.dir));
  const [promoted] = b.addFinding({ ...look, severity: "high" });
  assert.equal(promoted.tier, undefined);
  b.flush();
  // The first process, still holding its worth-a-look, re-finds it later and writes: the newer copy is its own.
  a.findings.find((f) => f.id === first.id)!.foundAt = new Date(Date.now() + 60_000).toISOString();
  a.addFinding({ ...look, tier: "worth_a_look", convention: "a 4px spacing scale" });
  a.flush();
  const onDisk = (
    JSON.parse(fs.readFileSync(path.join(a.dir, "memory.json"), "utf8")) as { findings: Array<{ id: string; tier?: string; severity: string }> }
  ).findings.find((f) => f.id === first.id);
  assert.equal(onDisk?.tier, undefined, "the defect another store recorded survives the merge");
  assert.equal(onDisk?.severity, "high", "at the defect's severity, not the worth-a-look's");
});

test("dedup: differing evidence never fuzzy-merges", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, title: "Widget list endpoint returns 403 for User", detail: "x", evidence: "GET /api/widgets 403" });
  const [, new2] = store.addFinding({ ...base, title: "Widget list endpoint returns 500 for User", detail: "y", evidence: "GET /api/widgets 500" });
  assert.ok(new1 && new2, "near-identical titles with distinct evidence must stay distinct");
});

test("dedup: the same endpoint failure found from TWO DIFFERENT pages is one bug", () => {
  // Seen in a real run: two agents found one broken endpoint from the two
  // pages that call it and wrote different evidence prose, so the report
  // carried the same 404 twice. Route-scoped rules cannot see this — the
  // findings are on different routes by construction — but `evidence` is
  // supposed to be a MACHINE signature, and both named the same endpoint and
  // status.
  const store = freshStore();
  const [, new1] = store.addFinding({
    ...base,
    state: "/ai-assistant#f1",
    url: "http://x/ai-assistant",
    title: "Assistant page fires a guaranteed 404 on every message",
    detail: "x",
    evidence: "OpenAPI has /api/v1/ai/query/ (slash) only; POST /api/v1/ai/query 404 with redirect_slashes=False",
  });
  const [, new2] = store.addFinding({
    ...base,
    state: "/analytics#f2",
    url: "http://x/analytics",
    title: "Natural-language analytics bar is dead",
    detail: "y",
    evidence: "POST /api/v1/ai/query → 404 Not Found",
  });
  assert.equal(new1, true, "first finding is new");
  assert.equal(new2, false, "same METHOD+path+status is the same bug, whichever page it was filed from");
});

test("a finding merged from another route records that route; a re-filing on a known route adds nothing", () => {
  // One root cause in a shared component, filed from each page that shows it:
  // the merge kept the first page only, so the report understated where the
  // defect happens.
  const store = freshStore();
  const first = {
    ...base,
    state: "/things/:id#f1",
    url: "http://x/things/7",
    title: "Things page shows a 403 for the user list",
    detail: "x",
    evidence: "GET /api/users 403",
  };
  const [finding] = store.addFinding(first);
  assert.equal(finding.seenOn, undefined, "one route: no field");
  const [, , , onOthers] = store.addFinding({
    ...first,
    state: "/others/:id#f2",
    url: "http://x/others/3",
    title: "Others page cannot list users",
    evidence: "GET /api/users 403 on load",
  });
  assert.deepEqual(finding.seenOn, ["/others/:id"]);
  assert.equal(onOthers.seenOn, "/others/:id", "the merge note names the newly recorded route");
  assert.match(describeMerge(onOthers, undefined), /\/others\/:id, is recorded as another route/);
  for (const state of ["/others/:id#f9", "/things/:id#f3"]) {
    const [, , , again] = store.addFinding({ ...first, state, title: "Users list refused again", evidence: "GET /api/users 403" });
    assert.equal(again.seenOn, undefined, `${state}: a route already recorded says nothing`);
  }
  assert.deepEqual(finding.seenOn, ["/others/:id"], "neither the known route nor the finding's own is added");
  assert.equal(store.findings.length, 1);

  // At most MAX_SEEN_ON, the oldest dropped.
  for (let i = 0; i < MAX_SEEN_ON + 3; i++) store.addFinding({ ...first, state: `/page-${i}#f`, title: `Page ${i} refused`, evidence: "GET /api/users 403" });
  assert.equal(finding.seenOn?.length, MAX_SEEN_ON);
  assert.equal(finding.seenOn?.at(-1), `/page-${MAX_SEEN_ON + 2}`);

  // The report names every route.
  const report = generateReport(store, [], undefined, { write: false }).markdown;
  assert.match(report, /- \*\*Where:\*\* `\/things\/:id#f1` \(http:\/\/x\/things\/7\); also seen on `\/page-3`, /);
});

test("merging two processes' copies of a finding keeps the routes either saw it on, and is idempotent", () => {
  const finding = {
    id: "x",
    severity: "low" as const,
    category: "c",
    title: "t",
    detail: "d",
    url: "u",
    state: "/a#1",
    repro: [],
    foundAt: "2026-01-02",
    runs: 1,
  };
  const a: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [{ ...finding, seenOn: ["/b"] }] };
  const b: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [{ ...finding, foundAt: "2026-01-01", seenOn: ["/c", "/b"] }] };
  const once = mergeMemory(a, b);
  assert.deepEqual(once.findings[0].seenOn?.slice().sort(), ["/b", "/c"]);
  assert.deepEqual(mergeMemory(once, b).findings[0].seenOn?.slice().sort(), ["/b", "/c"]);
  const neither = mergeMemory({ ...a, findings: [finding] }, { ...b, findings: [{ ...finding }] });
  assert.equal("seenOn" in neither.findings[0], false, "no routes on either side: no field");
});

test("a finding's picture is kept, and survives a merge with another process's copy that has none", () => {
  // `picture` is a plain path relative to .scenescout/, the form every reader of a finding takes; what it shows is apart.
  const picture = "recordings/default/finding-x.png";
  const pictureShot = { width: 320, height: 180, frame: "viewport" as const, at: "2026-01-02T00:00:00Z" };
  const finding = {
    id: "x",
    severity: "low" as const,
    category: "c",
    title: "t",
    detail: "d",
    url: "u",
    state: "/a#1",
    repro: [],
    foundAt: "2026-01-01",
    runs: 1,
  };
  // The other process re-found it later (so its copy is newer) without a picture: the picture is not lost.
  const mine: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [{ ...finding, picture, pictureShot }] };
  const theirs: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [{ ...finding, foundAt: "2026-01-02" }] };
  for (const merged of [mergeMemory(mine, theirs), mergeMemory(theirs, mine)]) {
    assert.equal(merged.findings[0].picture, picture);
    assert.deepEqual(merged.findings[0].pictureShot, pictureShot, "the shot travels with its picture");
  }
  const neither = mergeMemory({ ...mine, findings: [finding] }, theirs).findings[0];
  assert.ok(!("picture" in neither) && !("pictureShot" in neither), "neither has one: no field");
  const store = freshStore();
  const [filed] = store.addFinding({ ...base, title: "A picture is kept", detail: "d" });
  const kept = store.setPicture(filed.id, picture, pictureShot);
  assert.equal(kept?.picture, picture);
  assert.equal(typeof kept?.picture, "string");
  assert.deepEqual(kept?.pictureShot, pictureShot);
  assert.equal(store.setPicture("no-such-id", picture, pictureShot), null);
});

test("dedup: two bugs on one endpoint that answered 2xx stay two findings", () => {
  // Seen in two real runs, in both directions: a double submit and an
  // accepted negative quantity both had evidence naming `POST /api/orders`
  // with no failure status, and the second one filed was silently absorbed
  // into the first. Without a 4xx/5xx the endpoint is not the bug.
  const store = freshStore();
  const create = { ...base, category: "data-inconsistency", state: "/orders/new#1" };
  const [, new1] = store.addFinding({
    ...create,
    title: "Double-click on Create order creates two orders",
    detail: "x",
    evidence: "Double-click on testid=new-order-submit fired POST /api/orders twice",
  });
  const [, new2] = store.addFinding({
    ...create,
    title: "New order accepts a negative item count",
    detail: "y",
    evidence: "POST /api/orders with items=-5 → 201, order stored with -5 items",
  });
  assert.ok(new1 && new2, "a 2xx endpoint is where both were seen, not what is wrong with either");
  assert.equal(store.findings.length, 2);
});

test("dedup: an endpoint signature match needs the SAME status, not just the same path", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, state: "/a#1", title: "Create fails", detail: "x", evidence: "POST /api/things 500" });
  const [, new2] = store.addFinding({ ...base, state: "/b#2", title: "Create is forbidden for this role", detail: "y", evidence: "POST /api/things 403" });
  assert.ok(new1 && new2, "a 500 and a 403 on one endpoint are different bugs");
});

test("dedup: endpoint signatures collapse record ids so one bug is not filed per record", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({
    ...base,
    state: "/orders/:id#1",
    title: "Effectiveness 404 on order 176",
    detail: "x",
    evidence: "GET /api/orders/176/effectiveness 404",
  });
  const [, new2] = store.addFinding({
    ...base,
    state: "/orders/:id#2",
    title: "Effectiveness 404 on order 181",
    detail: "y",
    evidence: "GET /api/orders/181/effectiveness 404",
  });
  assert.equal(new2, false, "the same endpoint failing on two records is one finding");
  assert.ok(new1, "the first is new");
});

test("dedup: evidence naming TWO endpoints does not fabricate a signature for the healthy one", () => {
  // The bug this pins: statuses were harvested from the whole string and
  // applied to every endpoint in it, so "the list loads but the create fails"
  // minted a triple for the WORKING endpoint. An unrelated finding that really
  // was about that endpoint then merged into it and its title/detail/severity
  // were discarded — silent data loss, from evidence written as ordinary prose.
  const store = freshStore();
  store.addFinding({
    ...base,
    state: "/widgets#1",
    title: "Creating a widget fails",
    detail: "x",
    evidence: "list loads (GET /api/widgets 200) but POST /api/widgets returns 500",
  });
  const [, isNew] = store.addFinding({
    ...base,
    state: "/dashboard#2",
    title: "Widget list itself errors on the dashboard",
    detail: "y",
    evidence: "GET /api/widgets 500",
  });
  assert.equal(isNew, true, "a real GET-500 bug must not vanish into a finding that said GET was fine");
});

test("dedup: a number in prose is not read as the endpoint's status", () => {
  const store = freshStore();
  store.addFinding({ ...base, state: "/a#1", title: "Slow list", detail: "x", evidence: "list shows 500 items; GET /api/items 200" });
  const [, isNew] = store.addFinding({ ...base, state: "/b#2", title: "List endpoint crashes", detail: "y", evidence: "GET /api/items 500" });
  assert.equal(isNew, true, "'500 items' must not become a 500 status");
});

test("dedup: a RESOLVED finding never swallows a new bug on the same endpoint", () => {
  // Without the guard the new finding is absorbed into the fixed one, not
  // reopened (evidence differs, so it is not a regression either) — and simply
  // never appears in the report.
  const store = freshStore();
  const [first] = store.addFinding({ ...base, state: "/a#1", title: "Create 500s on empty payload", detail: "x", evidence: "POST /api/orders 500" });
  store.resolveFinding(first.id);
  const [, isNew] = store.addFinding({
    ...base,
    state: "/b#2",
    title: "Create 500s when the customer is archived",
    detail: "y",
    evidence: "POST /api/orders 500 archived customer",
  });
  assert.equal(isNew, true, "a fixed bug must not absorb a different new one on the same endpoint");
});

test("dedup: the endpoint rule needs the same CATEGORY", () => {
  // One endpoint+status can carry two genuinely different bugs.
  const store = freshStore();
  store.addFinding({ ...base, category: "security", state: "/a#1", title: "Role boundary leaks", detail: "x", evidence: "GET /api/admin 403" });
  const [, isNew] = store.addFinding({
    ...base,
    category: "ux-confusing",
    state: "/b#2",
    title: "403 shows a blank page with no explanation",
    detail: "y",
    evidence: "GET /api/admin 403",
  });
  assert.equal(isNew, true, "a security finding and a UX finding on one endpoint are two bugs");
});

test("dedup: a finding with no METHOD+path evidence is untouched by the endpoint rule", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, state: "/a#1", title: "Contrast fails on the banner", detail: "x", evidence: "banner contrast 3.1:1" });
  const [, new2] = store.addFinding({ ...base, state: "/b#2", title: "Tap target too small on the footer", detail: "y", evidence: "footer target 16x16" });
  assert.ok(new1 && new2, "non-endpoint evidence must not collide");
});

test("dedup tier 2: a literal quoted in a TITLE bridges to the other finding's detail only when one side has no evidence", () => {
  const first = { ...base, title: 'Save shows "Document not found anymore"', detail: "x", evidence: "PUT /api/docs/1 404" };
  const second = { ...base, title: "Editing fails with an error toast", detail: 'Toast says "Document not found anymore" after save.' };
  for (const [evidence, merges, why] of [
    [undefined, true, "one states the string in its title, the other in its detail and has no evidence: same bug"],
    ['toast "Document not found anymore"', true, "the literal is in the other finding's evidence: same bug"],
    ["toast document-not-found", false, "both carry differing evidence and the literal is only in the detail: kept apart"],
  ] as const) {
    const store = freshStore();
    const [, new1] = store.addFinding(first);
    const [, new2] = store.addFinding({ ...second, evidence });
    assert.equal(new1, true);
    assert.equal(new2, !merges, why);
  }
});

test("dedup: a control label quoted in one title and the other's detail does not merge two evidenced defects", () => {
  // A filter option's label names the control two defects were found
  // through. One finding quotes it in its title, the other mentions it in its
  // detail; their evidence shares nothing. Merged, the second was lost from
  // the report. The pair differs in one fact: where the second quotes it.
  const widgets = {
    ...base,
    category: "data-inconsistency",
    title: "Four summary widgets ignore the selected time window",
    detail: 'With "Last 7 days" selected, the open, overdue, closed and pending counts stay at their all-time values.',
    evidence: "widget-open=42 widget-overdue=9 widget-closed=118 widget-pending=7 unchanged by window=7d",
  };
  const undated = {
    ...base,
    category: "data-inconsistency",
    title: '"Last 7 days" window lists undated rows under the later group',
    detail: "Rows with no due date are counted as later than the window.",
    evidence: "window=7d group-later count=8 rows without due date",
  };
  const store = freshStore();
  store.addFinding(widgets);
  const [kept, isNew] = store.addFinding(undated);
  assert.equal(isNew, true, "the label is in one title and the other's detail only: two defects");
  assert.equal(kept.title, undated.title);
  assert.equal(store.findings.length, 2);

  // The contrast: the same bug filed twice, with the literal in both titles.
  const again = freshStore();
  again.addFinding(undated);
  const [, twice] = again.addFinding({
    ...undated,
    title: 'Undated rows counted as later in the "Last 7 days" window',
    evidence: "group-later shows 8 undated rows for window=7d",
  });
  assert.equal(twice, false, "the literal in both titles: one defect filed twice");
  assert.equal(again.findings.length, 1);
});

test("dedup: a quoted control name shared by two findings of different kinds does not merge them", () => {
  // Seen on every run of a benchmark: a layout finding naming the button it
  // covers, and a data finding describing what that button does. The title's
  // quoted label ("Save notes") appears in the other finding's detail, on the
  // same route, and the layout defect was folded into the data one — filed,
  // then lost from the report.
  const store = freshStore();
  const [, saved] = store.addFinding({
    ...base,
    category: "data-inconsistency",
    title: 'Notes save shows "Saved." even when the PUT is rejected',
    detail: 'Typing a note and clicking "Save notes" shows "Saved." though PUT /api/orders/1042 was refused.',
    evidence: "PUT /api/orders/1042 403 -> UI shows Saved.",
  });
  const [covered, isNew] = store.addFinding({
    ...base,
    category: "visual",
    title: 'Sticky bar covers the "Save notes" button at load',
    detail: "The fixed footer overlaps the button until the page is scrolled.",
    evidence: "testid=order-save covered by testid=order-stickybar",
  });
  assert.equal(saved, true);
  assert.equal(isNew, true, "a layout defect and a data defect that name the same button are two bugs");
  assert.equal(store.findings.length, 2);
  assert.equal(covered.category, "visual");

  // The contrast, differing only in kind: a second LAYOUT finding that quotes
  // the same control in its detail is the same layout bug, and still merges.
  // Filed in a later run, so the run count shows which finding it joined.
  store.endRun();
  const [, again] = store.addFinding({
    ...base,
    category: "visual",
    title: "The fixed footer hides a form control",
    detail: 'At load the footer sits over "Save notes" until the page is scrolled.',
    evidence: 'footer overlaps "Save notes" at scrollY=0',
  });
  assert.equal(again, false, "same kind, same quoted literal, same route: merged as before");
  assert.equal(store.findings.length, 2);

  // A label quoted in BOTH titles is still a place on the page, not a bug: a
  // data finding titled with the same control as the layout one, naming the
  // refused request, joins the data finding about it and never the layout one.
  const [into, bothTitles] = store.addFinding({
    ...base,
    category: "data-inconsistency",
    title: 'Clicking "Save notes" shows Saved. on a 403',
    detail: "No status check.",
    evidence: "PUT /api/orders/1042 403 claimed saved",
  });
  assert.equal(bothTitles, false);
  assert.equal(into.category, "data-inconsistency", "merged into the data finding about the same button");
  assert.equal(covered.runs, 2, "the layout finding took only its own layout twin");
});

test("dedup: incidental literals quoted only in DETAIL prose do not merge unrelated bugs", () => {
  // Two genuinely different bugs on one screen (a data-integrity defect and a
  // layout defect) both quoted the UI strings on that screen. Pre-fix the
  // shared quoting collapsed them and the layout bug was silently lost.
  const store = freshStore();
  const [, new1] = store.addFinding({
    ...base,
    title: "Bypassing the approval gate erases the evidence a gate existed",
    detail: 'After bypass the tab reads "Approval Gate: Disabled" and "No Approval Required".',
    evidence: "POST /api/orders/239/bypass-approval sets threshold=0",
  });
  const [, new2] = store.addFinding({
    ...base,
    title: "Assign Reviewer sits below the fold behind duplicated status blocks",
    detail: 'The first screenful restates "Approval Gate: Disabled" then "No Approval Required" again.',
    evidence: "document-section-approval layout: assign button below 900px fold",
  });
  assert.ok(new1 && new2, "neither title quotes the shared literal — these are different bugs");
});

test("dedup: a fuzzy match must never resurrect a RESOLVED finding", () => {
  // A false regression is worse than a duplicate: it is the one signal that
  // says whether a fix held.
  const store = freshStore();
  const [first] = store.addFinding({
    ...base,
    title: "Signup step 3 standards checkboxes have no accessible name",
    detail: 'All 15 report accessible name "checkbox".',
    evidence: 'signup step 3: 15 checkboxes report accessible name "checkbox"',
  });
  store.resolveFinding(first.id);
  const [, isNew] = store.addFinding({
    ...base,
    title: "Signup step 6 terms checkbox still has no accessible name",
    detail: 'The terms checkbox reports as generic "checkbox".',
    evidence: 'signup step 6: terms-accept-checkbox reports accessible name "checkbox"',
  });
  const reloaded = store.findings.find((x) => x.id === first.id);
  assert.equal(isNew, true, "the narrower finding is its own finding");
  assert.equal(reloaded?.status, "resolved", "the fixed finding must stay resolved");
  assert.equal(reloaded?.regressedAt, undefined, "no regression timestamp may be stamped");
});

test("dedup: a TRUE regression still reopens loudly", () => {
  const store = freshStore();
  const [first] = store.addFinding({ ...base, title: "Save button 500s", detail: "x", evidence: "PUT /api/save 500" });
  store.resolveFinding(first.id);
  const [again] = store.addFinding({ ...base, title: "Save button 500s", detail: "x", evidence: "PUT /api/save 500" });
  assert.equal(again.status, "open");
  assert.ok(again.regressedAt, "reopening must be flagged with regressedAt");
});

test("dedup: the literal tier is route-scoped", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, title: 'Save shows "Document not found anymore"', detail: "x" });
  const [, new2] = store.addFinding({ ...base, state: "/b#f2", title: 'Delete shows "Document not found anymore"', detail: "y" });
  assert.ok(new1 && new2, "the same literal on a DIFFERENT route is a separate finding");
});

test("dedup tier 3: paraphrased titles merge when neither carries evidence", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, title: "Dashboard widget count displays zero items", detail: "x" });
  const [, new2] = store.addFinding({ ...base, title: "Dashboard widget count display shows zero item", detail: "y" });
  assert.equal(new1, true);
  assert.equal(new2, false);
});

test("retroMerge: duplicates stored by an older build collapse on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  const memDir = path.join(dir, ".scenescout");
  fs.mkdirSync(memDir, { recursive: true });
  const dup = (id: string, title: string, runs: number, status?: string) => ({
    id,
    severity: "medium",
    category: "http-error",
    title,
    detail: "d",
    evidence: "GET /api/reports 403",
    url: "http://x/a",
    state: "/a#f1",
    repro: [],
    foundAt: "2026-01-01T00:00:00Z",
    runs,
    ...(status ? { status } : {}),
  });
  fs.writeFileSync(
    path.join(memDir, "memory.json"),
    JSON.stringify({
      version: 1,
      states: {},
      findings: [dup("aaa", "Reports endpoint 403 for User", 2), { ...dup("bbb", "User role denied by reports endpoint", 3, "resolved"), state: "/b#f2" }],
    }),
  );
  const store = openStore(dir);
  assert.equal(store.findings.length, 1, "duplicates should merge to one entry");
  assert.equal(store.findings[0]?.runs, 5, "run counts should sum");
  assert.equal(store.findings[0]?.status, "resolved", "resolved status should survive the merge");
  assert.deepEqual(store.findings[0]?.seenOn, ["/b"], "the folded copy's route is kept");
});

test("regression reopen: re-finding a resolved bug by evidence reopens it flagged", () => {
  const store = freshStore();
  const [f] = store.addFinding({ ...base, title: "Reports endpoint 403 for User", detail: "x", evidence: "GET /api/reports 403" });
  store.resolveFinding(f.id);
  const [reFound, isNew] = store.addFinding({ ...base, title: "Reports endpoint denies User again", detail: "y", evidence: "GET /api/reports 403" });
  assert.equal(isNew, false, "identical evidence is the same finding");
  assert.equal(reFound.status, "open");
  assert.ok(reFound.regressedAt);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("coverage: a route's elements are counted once across its state fingerprints", () => {
  const store = freshStore();
  store.visitState("/a#f1", "http://x/a", "/a", ["button:save", "button:open"]);
  store.visitState("/a#f2", "http://x/a?m=1", "/a", ["button:save", "button:open"]);
  store.markExercised("/a#f1", "button:save", "click");
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2, "two distinct controls, not four");
  assert.equal(cov.elementsExercised, 1, "exercised in ANY state of the route counts");
  assert.deepEqual(cov.unexercised, [{ state: "/a", keys: ["button:open"], total: 2 }]);
});

// ---------------------------------------------------------------------------
// Keys carried across the name rule (an image's alt text or an svg's title names a control)
// ---------------------------------------------------------------------------

/** A state as a memory written before image content named a control holds it: no nameRule. */
function legacyState(store: MemoryStore, fp: string, route: string, elements: StateRecord["elements"]): void {
  store.states[fp] = { url: `http://x${route}`, route, firstSeen: "2026-01-01T00:00:00.000Z", visits: 1, elements };
}

test("keyAliases: a control that gained a name maps to its earlier key, ordinals worked out under each rule", () => {
  // One image button: `button:` before, `button:search` now.
  assert.deepEqual(keyAliases([{ base: "button:search", prior: "button:", tracked: true }]), { "button:search": "button:" });
  // Two unnamed image buttons shared `button:` and `button:~1`; the first gains a name, so the second moves to the bare key.
  assert.deepEqual(
    keyAliases([
      { base: "button:search", prior: "button:", tracked: true },
      { base: "button:", prior: "button:", tracked: true },
    ]),
    { "button:search": "button:", "button:": "button:~1" },
  );
  // Nothing renamed, nothing listed; an element coverage does not count is never listed.
  assert.deepEqual(keyAliases([{ base: "link:home", prior: "link:home", tracked: true }]), {});
  assert.deepEqual(keyAliases([{ base: "live:status", prior: "live:", tracked: false }]), {});
});

test("coverage recorded under a control's earlier empty-name key carries over to its new name, and the earlier key is not left behind", () => {
  const store = freshStore();
  legacyState(store, "/a#old", "/a", { "button:": { exercised: true, lastAction: "click" }, "button:save": { exercised: false } });
  store.visitState("/a#new", "http://x/a", "/a", ["button:search", "button:save"], [], undefined, { "button:search": "button:" });
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2, "the search button once, not once per key");
  assert.equal(cov.elementsExercised, 1, "and still exercised");
  assert.deepEqual(cov.unexercised, [{ state: "/a", keys: ["button:save"], total: 2 }]);

  // The contrast: the same memory with no alias reads the renamed control as new and keeps the old key as a gap.
  const plain = freshStore();
  legacyState(plain, "/a#old", "/a", { "button:": { exercised: true, lastAction: "click" }, "button:save": { exercised: false } });
  plain.visitState("/a#new", "http://x/a", "/a", ["button:search", "button:save"]);
  assert.equal(plain.coverage().elementsTotal, 3);
  assert.deepEqual(plain.coverage().unexercised[0]?.keys.sort(), ["button:save", "button:search"]);
});

test("two unnamed image buttons that shared one key split, each keeping what was recorded for it", () => {
  const store = freshStore();
  legacyState(store, "/a#old", "/a", { "button:": { exercised: true }, "button:~1": { exercised: false } });
  store.visitState("/a#new", "http://x/a", "/a", ["button:search", "button:"], [], undefined, { "button:search": "button:", "button:": "button:~1" });
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2);
  assert.deepEqual(cov.unexercised, [{ state: "/a", keys: ["button:"], total: 2 }], "the still-unnamed button was never exercised");
});

test("a state recorded under the current rule is never re-read through an alias", () => {
  // `button:` here is a button that is still unnamed now; an alias learned for the old key must not rename it.
  const store = freshStore();
  legacyState(store, "/a#old", "/a", { "button:": { exercised: true } });
  store.visitState("/a#new", "http://x/a", "/a", ["button:search"], [], undefined, { "button:search": "button:" });
  store.visitState("/a#other", "http://x/a?x=1", "/a", ["button:"]);
  assert.equal(store.states["/a#other"].nameRule, NAME_RULE);
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2);
  assert.deepEqual(cov.unexercised, [{ state: "/a", keys: ["button:"], total: 2 }]);
  // An earlier state reached again lists current keys, so it is marked current and read as it is.
  store.visitState("/a#old", "http://x/a", "/a", ["button:"]);
  assert.equal(store.states["/a#old"].nameRule, NAME_RULE);
  assert.equal(store.coverage().elementsExercised, 1, "its own button: is the one exercised now");
});

test("an earlier state reached again under the same fingerprint has its keys moved before it is marked current", () => {
  // A text button "Search", an image button with alt="Search" and an unnamed icon button. Under the earlier rule
  // they were search, "" and ""~1; now search, search~1 and "". The set of base keys, and so the fingerprint, is the same.
  const store = freshStore();
  legacyState(store, "/a#same", "/a", {
    "button:search": { exercised: false },
    "button:": { exercised: true, lastAction: "click" },
    "button:~1": { exercised: false },
  });
  store.visitState("/a#same", "http://x/a", "/a", ["button:search", "button:search~1", "button:"], [], undefined, {
    "button:search~1": "button:",
    "button:": "button:~1",
  });
  const els = store.states["/a#same"].elements;
  assert.equal(els["button:search~1"]?.exercised, true, "the image button keeps its click");
  assert.equal(els["button:"]?.exercised, false, "and the unnamed icon button is not credited with it");
  assert.equal(els["button:~1"], undefined, "no earlier key is left behind");
  assert.deepEqual(store.coverage().unexercised[0]?.keys.sort(), ["button:", "button:search"]);

  // The same record merged from another process that has not been reached again is read the same way.
  const legacy = { url: "u", route: "/a", firstSeen: "2026-01-01", visits: 1, elements: { "button:": { exercised: true }, "button:~1": { exercised: false } } };
  const merged = mergeMemory(
    {
      version: 1 as const,
      states: { "/a#same": { ...legacy, elements: { "button:search~1": { exercised: false }, "button:": { exercised: false } }, nameRule: NAME_RULE } },
      findings: [],
      keyAliases: { "/a": { "button:": "button:search~1", "button:~1": "button:" } },
    },
    { version: 1 as const, states: { "/a#same": legacy }, findings: [] },
  );
  assert.equal(merged.states["/a#same"].elements["button:search~1"].exercised, true);
  assert.equal(merged.states["/a#same"].elements["button:"].exercised, false);
  assert.equal(merged.states["/a#same"].elements["button:~1"], undefined);
});

test("the first alias a route learns stands, and aliases survive a reload and a merge", () => {
  const store = freshStore();
  legacyState(store, "/a#old", "/a", { "button:": { exercised: true } });
  store.visitState("/a#new", "http://x/a", "/a", ["button:search"], [], undefined, { "button:search": "button:" });
  store.visitState("/a#modal", "http://x/a?m=1", "/a", ["button:close"], [], undefined, { "button:close": "button:" });
  assert.equal(
    store
      .coverage()
      .unexercised.flatMap((u) => u.keys)
      .includes("button:search"),
    false,
    "the first reading stands",
  );
  store.flush();
  const again = openStore(path.dirname(store.dir));
  assert.equal(again.coverage().elementsExercised, 1, "read back from disk");

  const mine = { version: 1 as const, states: {}, findings: [], keyAliases: { "/a": { "button:": "button:search" } } };
  const theirs = {
    version: 1 as const,
    states: { "/b#1": { url: "u", route: "/b", firstSeen: "2026-01-01", visits: 1, elements: {}, nameRule: NAME_RULE } },
    findings: [],
    keyAliases: { "/b": { "link:": "link:home" } },
  };
  const merged = mergeMemory(mine, theirs);
  assert.deepEqual(merged.keyAliases, { "/a": { "button:": "button:search" }, "/b": { "link:": "link:home" } });
  const shared = mergeMemory({ ...theirs, states: { "/b#1": { ...theirs.states["/b#1"], nameRule: undefined } } }, theirs);
  assert.equal(shared.states["/b#1"].nameRule, NAME_RULE, "either side's current rule is kept");
});

test("coverage counts the controls on a page, not the wrappers and badges it lists for their test ids", () => {
  // Three buttons and ten tagged wrappers on one page: the same keys listed either way, and the one
  // fact that flips the count is whether the collector said a user can act on the element.
  const store = freshStore();
  const buttons = ["button:save", "button:open", "button:close"];
  const wrappers = Array.from({ length: 10 }, (_, i) => `tid:wrapper-${i}`);
  store.visitState("/page#f1", "http://x/page", "/page", [...buttons, ...wrappers], wrappers);
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 3, "three controls, not thirteen elements");
  assert.deepEqual(cov.unexercised, [{ state: "/page", keys: buttons, total: 3 }]);
  // The wrappers stay known, so a click aimed at one still registers, without counting as coverage.
  store.markExercised("/page#f1", "tid:wrapper-0", "click");
  assert.equal(store.wasExercised("/page#f1", "tid:wrapper-0"), true);
  assert.equal(store.coverage().elementsExercised, 0);
  // Listed without the inert set (as memory written before it), every key counts, as it always did.
  const legacy = freshStore();
  legacy.visitState("/page#f1", "http://x/page", "/page", [...buttons, ...wrappers]);
  assert.equal(legacy.coverage().elementsTotal, 13);
  // A merge with another process's memory keeps the mark.
  const file = (inert: boolean): Parameters<typeof mergeMemory>[0] => ({
    version: 1,
    states: {
      "/page#f1": {
        url: "http://x/page",
        route: "/page",
        firstSeen: "2026-01-01",
        visits: 1,
        elements: { "tid:wrapper-1": { exercised: false, ...(inert ? { inert: true } : {}) } },
      },
    },
    findings: [],
  });
  assert.equal(mergeMemory(file(true), file(false)).states["/page#f1"].elements["tid:wrapper-1"].inert, true, "ours says inert, and wins");
  assert.equal(mergeMemory(file(false), file(true)).states["/page#f1"].elements["tid:wrapper-1"].inert, undefined, "ours says a control, and wins");
  // A key that becomes a control on a later visit counts again.
  store.visitState("/page#f1", "http://x/page", "/page", [...buttons, ...wrappers], wrappers.slice(1));
  assert.equal(store.coverage().elementsTotal, 4);
});

test("coverage reports each route's own deduped total, so the gap ledger can compare like with like", () => {
  // The untouched-route check asks "were ALL of this route's elements missed?".
  // It used to answer by re-counting raw state elements, which double-counts an
  // element shared by two states of the same route — total came out larger than
  // the unexercised list could ever be, the equality never held, and a route
  // where nothing was touched silently fell out of the ledger.
  const store = freshStore();
  store.visitState("/multi#f1", "http://x/multi", "/multi", ["button:a", "button:b"]);
  store.visitState("/multi#f2", "http://x/multi?open=1", "/multi", ["button:a", "button:b", "button:c"]);
  const entry = store.coverage().unexercised.find((u) => u.state === "/multi");
  assert.ok(entry, "the route is listed");
  assert.equal(entry.total, 3, "three distinct controls across both states, not five");
  assert.equal(entry.keys.length, entry.total, "nothing was touched, so every key is outstanding");
});

test("coverage: shared layout chrome counts once, not once per route", () => {
  // 10 routes carrying the same 3 shell controls plus one unique control each.
  // Pre-fix this reported 40 elements, 30 of them the same three nav links.
  const store = freshStore();
  const chrome = ["tid:nav-home", "tid:nav-docs", "tid:sidebar-logout"];
  for (let i = 0; i < 10; i++) {
    store.visitState(`/r${i}#f`, `http://x/r${i}`, `/r${i}`, [...chrome, `tid:unique-${i}`]);
  }
  assert.equal(store.coverage().elementsTotal, 13, "3 shell + 10 unique, not 40");

  // Exercising a shell control ONCE means it is done everywhere — it is the
  // same component, so re-clicking it per route proves nothing.
  store.markExercised("/r0#f", "tid:nav-home", "click");
  const after = store.coverage();
  assert.equal(after.elementsExercised, 1, "chrome exercised anywhere counts globally");

  const chromeRow = after.unexercised.find((u) => u.state === "(shared layout chrome)");
  assert.deepEqual(chromeRow?.keys.sort(), ["tid:nav-docs", "tid:sidebar-logout"], "remaining shell listed once");
  const perRoute = after.unexercised.filter((u) => u.state.startsWith("/r"));
  assert.ok(
    perRoute.every((u) => u.keys.every((k) => k.startsWith("tid:unique-"))),
    "per-route rows must list only that route's OWN controls",
  );
});

test("coverage: a small app has no 'chrome' — nothing is folded away", () => {
  // Two routes sharing a control is not evidence of a shell; with too few
  // routes to tell "on every page" from "on both pages", keep it per-route.
  const store = freshStore();
  store.visitState("/a#f", "http://x/a", "/a", ["tid:shared", "tid:a-only"]);
  store.visitState("/b#f", "http://x/b", "/b", ["tid:shared", "tid:b-only"]);
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 4, "below the route threshold everything stays per-route");
  assert.ok(!cov.unexercised.some((u) => u.state === "(shared layout chrome)"), "no pseudo-route invented");
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

test("the artifact directory ignores itself so a tested project cannot commit it", () => {
  const store = freshStore();
  const ignorePath = path.join(store.dir, ".gitignore");
  assert.ok(fs.existsSync(ignorePath), "a .gitignore is written inside the artifact directory");
  const body = fs.readFileSync(ignorePath, "utf8");
  assert.ok(
    body.split("\n").some((l) => l.trim() === "*"),
    "an unqualified * is what makes every artifact here invisible to the parent repo",
  );
  assert.ok(store.gitIgnoreNote, "the action is reported, never done silently");
});

test("an existing artifact .gitignore is left exactly as the user left it", () => {
  const store = freshStore();
  const ignorePath = path.join(store.dir, ".gitignore");
  fs.writeFileSync(ignorePath, "# hand-edited\n!report.md\n");
  const second = openStore(path.dirname(store.dir));
  assert.equal(fs.readFileSync(ignorePath, "utf8"), "# hand-edited\n!report.md\n", "never rewrite a file we do not own");
  assert.equal(second.gitIgnoreNote, null, "and say nothing when nothing changed");
});

test("flush durability: debounced coverage writes land on flush", () => {
  const store = freshStore();
  store.visitState("/a#f1", "http://x/a", "/a", ["button:save"]);
  store.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(store.dir, "memory.json"), "utf8")) as { states: Record<string, unknown> };
  assert.ok("/a#f1" in onDisk.states);
});

test("a failed background write is recorded, not thrown, and clears on recovery", async () => {
  // Delete the memory dir out from under a pending debounced write —
  // reproduces the exact crash this guards: a background setTimeout callback
  // hitting ENOENT with nothing to catch it.
  const store = freshStore();
  fs.rmSync(store.dir, { recursive: true, force: true });
  // The failure is also logged to stderr — the only trace an operator sees.
  // Capture it: that asserts the log exists, and keeps a deliberate failure
  // from printing an alarming line into an otherwise green run.
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    store.visitState("/a#f1", "http://x/a", "/a", ["button:save"]); // schedules a debounced save() at 500ms
    await until("the debounced write to fail and say so", () => logged.length > 0);
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1, "exactly one log line per failed write");
  assert.match(logged[0], /background memory write failed: ENOENT/);
  assert.equal(typeof store.lastSaveError, "string", "failure recorded on lastSaveError instead of thrown");
  assert.ok((store.lastSaveError ?? "").length > 0);

  fs.mkdirSync(store.dir, { recursive: true }); // filesystem recovers
  store.flush();
  assert.equal(store.lastSaveError, null, "the error clears once a write succeeds");
});

// ---------------------------------------------------------------------------
// Auth loss must not be mistaken for coverage
// ---------------------------------------------------------------------------

test("a permission redirect covers the route for that role only", () => {
  // A role that genuinely cannot see a route must not block the contract
  // forever — but it also must not answer for a role that CAN see it. Keyed by
  // route alone, the operator bouncing off an admin page permanently erased
  // that page from the admin's gap ledger.
  const store = freshStore();
  store.markAttempted("/admin", "landed:/", "operator");
  assert.ok("/admin" in store.attemptedByRole("operator"), "covered for the role that was refused");
  assert.ok(!("/admin" in store.attemptedByRole("admin")), "still outstanding for a role that never tried it");
});

test("an auth-loss bounce never counts as coverage, for any role", () => {
  // The failure this pins: a token expiring mid-run made every subsequent
  // navigation land on /login, each one recorded as "attempted", and the
  // completion contract then certified the entire remaining route list.
  const store = freshStore();
  store.markAttempted("/documents", "authloss:/login", "admin");
  assert.ok(!("/documents" in store.attemptedByRole("admin")), "a dead session proves nothing about the route");
  assert.ok("/documents" in store.attemptedRoutes, "but it is still recorded for the report");
});

test("attempts recorded before role-scoping still count, for every role", () => {
  const store = freshStore();
  const projectDir = path.dirname(store.dir);
  // Shape written by an older version: keyed by route alone, no role prefix.
  const raw = path.join(store.dir, "memory.json");
  store.flush();
  const data = JSON.parse(fs.readFileSync(raw, "utf8"));
  data.attemptedRoutes = { "/legacy": "landed:/" };
  fs.writeFileSync(raw, JSON.stringify(data));
  const reloaded = openStore(projectDir);
  assert.ok("/legacy" in reloaded.attemptedByRole("anyone"), "never drop coverage a previous run earned");
});

// ---------------------------------------------------------------------------
// Secrets an app leaks must not be re-published by the tool that found them
// ---------------------------------------------------------------------------

test("credentials quoted from app output are redacted before they are persisted", () => {
  const store = freshStore();
  const [f] = store.addFinding({
    ...base,
    title: "Upstream error leaks a key",
    detail: "The UI rendered: Incorrect API key provided: sk-proj-AAAABBBBCCCCDDDDEEEE",
    evidence: "POST /api/ai 500 Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
  });
  assert.ok(!f.detail.includes("AAAABBBBCCCCDDDDEEEE"), "the key body never reaches disk");
  assert.ok(f.detail.includes("[redacted]"), "and the reader is told something was removed");
  assert.ok(!(f.evidence ?? "").includes("abcdefghijklmnopqrstuvwxyz012345"), "bearer tokens too");
  assert.ok(f.detail.includes("Incorrect API key provided"), "the actionable part of the message survives");
});

test("seen in N runs counts runs: filings within one run count once, filings in two runs count twice", () => {
  const store = freshStore();
  const file = () => store.addFinding({ ...base, title: "Export button does nothing", detail: "No request.", evidence: "click export: 0 requests" });
  file();
  const [again, isNew, , note] = file();
  assert.equal(isNew, false);
  assert.equal(again.runs, 1, "the same run filing it twice is one run");
  assert.equal(note.sameRun, true);
  store.endRun();
  const [later, , , laterNote] = file();
  assert.equal(later.runs, 2, "a second run counts");
  assert.equal(laterNote.sameRun, false);
  file();
  assert.equal(store.findings[0].runs, 2, "…once");

  // Another store over the same directory is another process, so another run.
  const other = openStore(path.dirname(store.dir));
  const [elsewhere] = other.addFinding({ ...base, title: "Export button does nothing", detail: "No request.", evidence: "click export: 0 requests" });
  assert.equal(elsewhere.runs, 3);
});

test("re-filing a worth-a-look: the same session in the same run corrects it; anyone else's filing keeps the first wording and says so", () => {
  const store = freshStore();
  const look = (session: string, convention: string, detail: string) =>
    store.addFinding({
      ...base,
      session,
      title: "Nav links are not underlined",
      detail,
      evidence: "nav a text-decoration none",
      tier: "worth_a_look",
      convention,
    });
  look("lane-a", "links outside navigation must be underlined", "First wording.");
  const [fixed, , , note] = look("lane-a", "links in navigation must be underlined", "Corrected wording.");
  assert.equal(fixed.convention, "links in navigation must be underlined", "the correction is taken, not dropped");
  assert.equal(fixed.detail, "Corrected wording.");
  assert.deepEqual(note.updated, ["convention", "detail"]);
  assert.match(
    describeMerge(note, fixed.convention),
    /correction of your own filing: its convention is now "links in navigation must be underlined" and its detail is now yours/,
  );

  const [kept, , , otherNote] = look("lane-b", "every link must be underlined", "Lane b's wording.");
  assert.equal(kept.convention, "links in navigation must be underlined", "another session's filing does not rewrite it");
  assert.equal(kept.detail, "Corrected wording.");
  assert.deepEqual(otherNote.kept, ["convention", "detail"]);
  assert.match(describeMerge(otherNote, kept.convention), /first filing's convention \("links in navigation must be underlined"\) and detail were kept/);

  store.endRun();
  const [nextRun, , , nextNote] = look("lane-a", "something else", "Next run's wording.");
  assert.equal(nextRun.convention, "links in navigation must be underlined", "the same session in a later run is a new sighting, not a correction");
  assert.deepEqual(nextNote.kept, ["convention", "detail"]);

  const [, , , same] = look("lane-a", "links in navigation must be underlined", "Corrected wording.");
  // Another session filling in a convention the first filing left out is not a correction, and is not called one.
  const bare = freshStore();
  bare.addFinding({ ...base, session: "lane-a", title: "Footer links are grey", detail: "d", evidence: "footer a color", tier: "worth_a_look" });
  const [filled, , , fillNote] = bare.addFinding({
    ...base,
    session: "lane-b",
    title: "Footer links are grey",
    detail: "d",
    evidence: "footer a color",
    tier: "worth_a_look",
    convention: "a brand link colour",
  });
  assert.equal(filled.convention, "a brand link colour");
  assert.equal(describeMerge(fillNote, filled.convention), "");
  assert.equal(describeMerge(same, "links in navigation must be underlined"), "", "a filing that agrees changes nothing and says nothing");
});

test("redaction is stable, so the same leak re-found is one finding, not two", () => {
  const store = freshStore();
  const mk = (key: string) => store.addFinding({ ...base, title: "Upstream error leaks a key", detail: `key: sk-live-${key}`, evidence: "POST /api/ai 500" });
  const [, firstIsNew] = mk("AAAABBBBCCCCDDDD");
  store.endRun();
  const [second, secondIsNew] = mk("QQQQRRRRSSSSTTTT");
  assert.ok(firstIsNew, "first sighting is new");
  assert.ok(!secondIsNew, "a differing secret must not fork the finding");
  assert.equal(second.runs, 2);
});

// ---------------------------------------------------------------------------
// The design audit's chrome census
// ---------------------------------------------------------------------------

test("an element on most routes is shared chrome; one on a few pages is not", () => {
  const store = freshStore();
  for (let i = 0; i < 10; i++) {
    store.recordDesignElements(`/r${i}`, ["tid:sidebar-logo", "span:18", `tid:page-${i}-title`]);
  }
  const chrome = store.designChromeKeys();
  assert.ok(chrome.has("tid:sidebar-logo"), "on every route → shell");
  assert.ok(chrome.has("span:18"), "recognised without a testid, which is how badges render");
  assert.ok(!chrome.has("tid:page-0-title"), "on one route → that page's own content");
});

test("a page's design score does not depend on whether it was audited before the census warmed up", () => {
  // Audit route A first, then three others, then A again: the census knows the
  // shell only by the end, and A must score the same both times or the
  // worst-pages ranking depends on audit order.
  const store = freshStore();
  const sidebar = Array.from({ length: 30 }, (_, i) =>
    designRecord({ tag: "a", text: `Section ${i}`, interactive: true, filled: true, shell: true, bg: "rgb(30, 41, 59)", color: "rgb(100, 116, 139)" }),
  );
  const page = (name: string) => ({
    records: [
      designRecord({ tag: "h1", text: name }),
      designRecord({ tag: "button", text: `New ${name}`, interactive: true, filled: true, bg: "rgb(20, 80, 200)", color: "rgb(255, 255, 255)" }),
      ...sidebar,
    ],
    page: { scrollW: 1280, clientW: 1280, headings: [{ level: 1, size: 30, text: name }], images: [], density: 10, focusSamples: [] },
  });
  const audit = (route: string) => {
    const { score, signatures } = analyzeDesign(page(route), { width: 1280, height: 900 }, store.designChromeKeys());
    store.recordDesignElements(route, signatures);
    return score;
  };
  const firstA = audit("/a");
  assert.equal(store.designChromeKeys().size, 0, "one audited route: the census knows nothing yet");
  for (const r of ["/b", "/c", "/d"]) audit(r);
  assert.ok(store.designChromeKeys().size >= 30, "four audited routes: the census now knows the sidebar");
  assert.deepEqual(audit("/a"), firstA);
});

test("chrome is not inferred from too few routes", () => {
  const store = freshStore();
  store.recordDesignElements("/a", ["tid:thing"]);
  store.recordDesignElements("/b", ["tid:thing"]);
  assert.equal(store.designChromeKeys().size, 0, "two pages cannot tell 'on every page' from 'on both pages'");
});

test("a role whose name contains a space still owns its own attempts", () => {
  // The role is the auth fixture's basename, so "qa admin.json" is a real
  // possibility. A space-delimited key split it into a role "qa" that does not
  // exist, crediting that route's coverage to nobody.
  const store = freshStore();
  store.markAttempted("/admin", "landed:/", "qa admin");
  assert.ok("/admin" in store.attemptedByRole("qa admin"), "the role that was refused sees it");
  assert.ok(!("/admin" in store.attemptedByRole("qa")), "and a differently-named role does not");
});

test("legacy login bounces are re-filed as auth loss on load", () => {
  // Before auth loss was distinguished, every bounce was written as
  // `landed:/login` — and those entries satisfy the contract for every role.
  // Without this migration the upgrade silently keeps certifying routes a dead
  // token never reached.
  const store = freshStore();
  const projectDir = path.dirname(store.dir);
  store.flush();
  const raw = path.join(store.dir, "memory.json");
  const data = JSON.parse(fs.readFileSync(raw, "utf8"));
  data.attemptedRoutes = { "/documents": "landed:/login", "/admin": "landed:/" };
  fs.writeFileSync(raw, JSON.stringify(data));

  const reloaded = openStore(projectDir);
  assert.ok(!("/documents" in reloaded.attemptedByRole("admin")), "the login bounce no longer counts");
  assert.ok("/admin" in reloaded.attemptedByRole("admin"), "a genuine permission redirect still does");
});

test("markExercised refuses a key the state never listed", () => {
  // Creating the key on demand meant any caller deriving it slightly
  // differently from the collector minted a phantom exercised element — which
  // is never pruned, because pruning skips exercised entries.
  const store = freshStore();
  store.visitState("/a#f1", "http://x/a", "/a", ["button:save"]);
  store.markExercised("/a#f1", "textbox:invented", "press:Enter");
  assert.equal(store.coverage().elementsTotal, 1, "no phantom element is added");
  assert.equal(store.coverage().elementsExercised, 0, "and nothing is credited");
});

test("ordinary prose survives redaction intact", () => {
  // Over-redaction is its own defect: a finding mangled into nonsense reads as
  // the agent malfunctioning, and the reader cannot tell what was removed.
  for (const clean of [
    "Password requirements are not enforced on signup",
    "Basic authentication-required banner renders twice",
    "The reset-password confirmation email never arrives",
    "Column pk_customer_identifier is exposed in the response",
  ]) {
    assert.equal(redactSecrets(clean), clean, `must not touch: ${clean}`);
  }
});

test("a redaction announces itself and keeps the matched scheme", () => {
  const out = redactSecrets("Authorization: Basic QWxhZGRpbjpvcGVuc2VzYW1l1234");
  assert.ok(out.includes("Basic [redacted]"), `the scheme that matched is preserved: ${out}`);
  assert.ok(!out.includes("Bearer"), "and is not rewritten to a different one");
  assert.ok(/\[1 secret redacted\]/.test(out), `the edit is disclosed: ${out}`);
});

test("typed text and URLs are redacted at the log, not just on findings", () => {
  // repro traces are built from the action log, so redacting only the finding
  // fields left the same secrets flowing by a parallel route.
  const store = freshStore();
  store.logAction({ action: "type", target: 'password "sk-live-AAAABBBBCCCCDDDD"', url: "http://x/cb?token=abcdef123456789012" });
  const line = fs.readFileSync(store.sessionLogPath, "utf8");
  assert.ok(!line.includes("AAAABBBBCCCCDDDD"), "the typed secret never reaches the log");
  assert.ok(!line.includes("abcdef123456789012"), "nor does a token in the URL");
});

// ---------------------------------------------------------------------------
// Two processes, one memory.json
// ---------------------------------------------------------------------------

test("a second PROCESS writing the same project does not erase our findings", () => {
  // The real shape of the bug: each process holds a full snapshot and writes
  // the whole document, so the last flush used to win outright. Driven with an
  // actual child process rather than a second in-process store, because the
  // in-process case shares one MemoryStore and cannot reproduce it.
  const store = freshStore();
  const projectDir = path.dirname(store.dir);
  store.addFinding({ ...base, title: "Ours: save button 500s", detail: "x", evidence: "PUT /api/save 500" });
  store.flush();

  const child = `
    import { MemoryStore } from ${JSON.stringify(new URL("../src/engine/memory.ts", import.meta.url).href)};
    const s = new MemoryStore(${JSON.stringify(projectDir)});
    s.addFinding({ severity: "high", category: "http-error", title: "Theirs: delete button 403s",
      detail: "y", evidence: "DELETE /api/x 403", url: "http://x/b", state: "/b#f1" });
    s.flush();
  `;
  const childFile = path.join(projectDir, "child.mts");
  fs.writeFileSync(childFile, child);
  // Through tsx, like this suite itself, so the second process runs src/ too.
  // The loader is resolved from HERE: the child lives in a temp dir with no
  // node_modules of its own to find "tsx" in.
  const tsxLoader = createRequire(import.meta.url).resolve("tsx");
  execFileSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, childFile], { stdio: "pipe" });

  // Now we flush again, exactly as a live run would keep doing.
  store.addFinding({ ...base, title: "Ours: second finding", detail: "z", evidence: "GET /api/y 404" });
  store.flush();

  const onDisk = JSON.parse(fs.readFileSync(path.join(store.dir, "memory.json"), "utf8")) as { findings: Array<{ title: string }> };
  const titles = onDisk.findings.map((f) => f.title).sort();
  assert.deepEqual(
    titles,
    ["Ours: save button 500s", "Ours: second finding", "Theirs: delete button 403s"],
    "every process's findings survive, whoever wrote last",
  );
});

test("merging is idempotent — repeated flushes do not inflate counters", () => {
  // flush() may fold the same foreign document in more than once, so every
  // rule takes a max or a union. Summing would grow run counts on each flush.
  const a: Parameters<typeof mergeMemory>[0] = {
    version: 1,
    states: {},
    findings: [{ id: "x", severity: "low", category: "c", title: "t", detail: "d", url: "u", state: "/a#1", repro: [], foundAt: "2026-01-02", runs: 3 }],
    routeFacts: { "/a": { journeys: 2, journeysCompleted: 1, audited: true } },
  };
  const b: Parameters<typeof mergeMemory>[0] = {
    version: 1,
    states: {},
    findings: [{ id: "x", severity: "low", category: "c", title: "t", detail: "d", url: "u", state: "/a#1", repro: [], foundAt: "2026-01-01", runs: 5 }],
    routeFacts: { "/a": { journeys: 4, mutated: true } },
  };
  const once = mergeMemory(a, b);
  const twice = mergeMemory(once, b);
  assert.equal(once.findings[0].runs, 5, "the higher run count wins");
  assert.equal(twice.findings[0].runs, 5, "and does not grow on a second merge");
  assert.equal(once.routeFacts?.["/a"]?.journeys, 4);
  assert.equal(twice.routeFacts?.["/a"]?.journeys, 4, "counters take the max, never a sum");
  assert.equal(twice.routeFacts?.["/a"]?.audited, true, "and boolean facts from either side survive");
  assert.equal(twice.routeFacts?.["/a"]?.mutated, true);
});

test("merging keeps coverage from both sides of a shared state", () => {
  const mine = {
    version: 1 as const,
    states: {
      "/a#1": {
        url: "u",
        route: "/a",
        firstSeen: "2026-01-02",
        visits: 1,
        elements: { "button:save": { exercised: true }, "button:open": { exercised: false } },
      },
    },
    findings: [],
  };
  const theirs = {
    version: 1 as const,
    states: {
      "/a#1": {
        url: "u",
        route: "/a",
        firstSeen: "2026-01-01",
        visits: 4,
        elements: { "button:save": { exercised: false }, "button:cancel": { exercised: true } },
      },
    },
    findings: [],
  };
  const merged = mergeMemory(mine, theirs);
  const els = merged.states["/a#1"].elements;
  assert.equal(els["button:save"].exercised, true, "exercised anywhere counts as exercised");
  assert.equal(els["button:cancel"].exercised, true, "an element only the other side saw is kept");
  assert.equal(els["button:open"].exercised, false);
  assert.equal(merged.states["/a#1"].visits, 4, "visit counts take the max");
  assert.equal(merged.states["/a#1"].firstSeen, "2026-01-01", "and the earliest first-sighting wins");
});

test("a crashed flush does not leave temp files behind forever", () => {
  const store = freshStore();
  const stale = path.join(store.dir, "memory.json.99999.0.tmp");
  fs.writeFileSync(stale, "{}");
  const reopened = openStore(path.dirname(store.dir));
  assert.ok(!fs.existsSync(stale), "a leftover temp from a dead process is swept on load");
  assert.ok(reopened.dir.length > 0);
});

test("a project's memory survives the tool's rename", () => {
  // Cross-run memory is the product. Opening an empty new directory beside a
  // full pre-rename one would forget every earlier run and re-report every
  // known finding as new — silently.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ft-rename-"));
  dirs.push(project);
  const legacy = path.join(project, LEGACY_MEMORY_DIRNAME);
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "ASSUMPTIONS.md"), "earlier notes");
  const seeded = openStore(project); // first attach after the rename
  assert.match(seeded.legacyDirNote ?? "", /Moved this project's memory/);
  assert.equal(fs.existsSync(legacy), false, "the old directory is moved, not copied");
  assert.equal(fs.readFileSync(path.join(project, MEMORY_DIRNAME, "ASSUMPTIONS.md"), "utf8"), "earlier notes");

  // Once the new directory exists it is authoritative: a stray legacy
  // directory must never be moved over it.
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "ASSUMPTIONS.md"), "stale");
  assert.equal(adoptLegacyMemoryDir(project), null);
  assert.equal(fs.readFileSync(path.join(project, MEMORY_DIRNAME, "ASSUMPTIONS.md"), "utf8"), "earlier notes");
  const untouched = fs.mkdtempSync(path.join(os.tmpdir(), "ft-new-"));
  dirs.push(untouched);
  assert.equal(openStore(untouched).legacyDirNote, null, "a fresh project has nothing to adopt");
});

test("the legacy memory dir is NOT moved out from under a pre-rename engine that is still running", () => {
  // That process holds absolute paths into the old directory; moving it makes
  // every later write of its run fail, visible only as a stderr line.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ft-rename-live-"));
  dirs.push(project);
  const legacy = path.join(project, LEGACY_MEMORY_DIRNAME);
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "status.json"), JSON.stringify({ pid: 424242 }));

  const note = adoptLegacyMemoryDir(project, (pid) => pid === 424242);
  assert.match(note ?? "", /pid 424242\) is still using .*NOT moved/);
  assert.equal(fs.existsSync(path.join(legacy, "status.json")), true);
  assert.equal(fs.existsSync(path.join(project, MEMORY_DIRNAME)), false);

  // Once that engine has exited, the next attach adopts it as usual — and a
  // truncated status file (killed mid-write) names no live owner either.
  assert.match(adoptLegacyMemoryDir(project, () => false) ?? "", /Moved this project's memory/);
  assert.equal(fs.existsSync(path.join(project, MEMORY_DIRNAME, "status.json")), true);
});

test("a secret in the page URL or in a note is not persisted", () => {
  // Title/detail/evidence were already redacted; the URL was not, and it is
  // both stored and printed in the report. A finding filed on a reset or
  // magic-link page carried that page's token into memory.json and report.md.
  const store = freshStore();
  const [finding] = store.addFinding({
    severity: "medium",
    category: "other",
    title: "Reset form accepts a blank password",
    detail: "d",
    url: "http://x/reset?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    state: "/reset#a",
  });
  assert.doesNotMatch(finding.url, /eyJhbGci/);
  assert.match(finding.url, /^http:\/\/x\/reset\?token=/, "the page is still identifiable");

  store.addAssumption("risks", "Integration page shows api_key=sk9f8a7b6c5d4e3f2a1b in plain text", "qa");
  const notes = fs.readFileSync(path.join(store.dir, "ASSUMPTIONS.md"), "utf8");
  assert.doesNotMatch(notes, /sk9f8a7b6c5d4e3f2a1b/);
  assert.match(notes, /Integration page shows api_key=\[redacted\] in plain text/);
});

test("pruning keeps every route answerable while dropping the long tail of its states", () => {
  // One route with far more states than the cap, and one with a handful.
  const states: Record<string, StateRecord> = {};
  for (let i = 0; i < MAX_STATES_PER_ROUTE + 25; i += 1) {
    states[`/docs#${i}`] = {
      url: `http://app.test/docs?p=${i}`,
      route: "/docs",
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 60_000).toISOString(),
      visits: 1,
      elements: {},
    };
  }
  for (let i = 0; i < 3; i += 1) {
    states[`/admin#${i}`] = { url: "http://app.test/admin", route: "/admin", firstSeen: "2026-09-01T00:00:00.000Z", visits: 1, elements: {} };
  }

  const { kept, dropped } = pruneStates(states, []);
  assert.equal(dropped, 25);
  assert.equal(Object.keys(kept).filter((k) => kept[k].route === "/docs").length, MAX_STATES_PER_ROUTE);
  assert.equal(Object.keys(kept).filter((k) => kept[k].route === "/admin").length, 3, "a route under the cap loses nothing");
  // The survivors are the most recent, which are the ones a next run meets again.
  assert.ok(kept[`/docs#${MAX_STATES_PER_ROUTE + 24}`], "the newest is kept");
  assert.ok(!kept["/docs#0"], "the oldest is not");
});

test("pruning never drops a state a finding points at", () => {
  const states: Record<string, StateRecord> = {};
  for (let i = 0; i < 10; i += 1) {
    states[`/docs#${i}`] = {
      url: "http://app.test/docs",
      route: "/docs",
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 60_000).toISOString(),
      visits: 1,
      elements: {},
    };
  }
  // Cap of 2 would drop eight; the finding pins the oldest of them.
  const { kept, dropped } = pruneStates(states, [{ state: "/docs#0" }], 2);
  assert.ok(kept["/docs#0"], "a finding's own state survives whatever the cap says");
  assert.equal(dropped, 7);
  assert.ok(kept["/docs#9"], "and so does the newest");
});

test("pruning a history that is already small changes nothing", () => {
  const states: Record<string, StateRecord> = {
    "/a#1": { url: "http://app.test/a", route: "/a", firstSeen: "2026-09-01T00:00:00.000Z", visits: 1, elements: {} },
  };
  const { kept, dropped } = pruneStates(states, []);
  assert.equal(dropped, 0);
  assert.deepEqual(Object.keys(kept), ["/a#1"]);
  assert.deepEqual(pruneStates({}, []), { kept: {}, dropped: 0 });
});

test("a verdict is stamped on the finding and survives a reload", () => {
  // The verdict is what lets the report date a confirmation rather than call
  // the finding unverified, so it has to be on disk, not only in the process
  // that recorded it.
  const store = freshStore();
  const [f] = store.addFinding({ ...base, title: "The register shows nothing for a manager", detail: "x", evidence: "GET /api/records 403" });

  const confirmed = store.verifyFinding(f.id, "present", "still a 403, still an empty table");
  assert.equal(confirmed?.verdict, "present");
  assert.equal(confirmed?.status ?? "open", "open", "confirming a finding does not close it");
  assert.ok(confirmed?.verifiedAt, "a verdict without a date is not a confirmation");
  assert.equal(confirmed?.verifyNote, "still a 403, still an empty table");

  const reloaded = openStore(path.dirname(store.dir)).findings.find((x) => x.id === f.id);
  assert.equal(reloaded?.verdict, "present");
  assert.equal(reloaded?.verifyNote, "still a 403, still an empty table");

  // "gone" is the only verdict that closes it.
  assert.equal(store.verifyFinding(f.id, "gone")?.status, "resolved");
  assert.equal(store.verifyFinding("nosuchid", "gone"), null);
});

test("lane decisions survive a reload, and a second process's are not lost", () => {
  // Lanes commonly run in separate processes — that is the point of a lane —
  // and a new array field would be taken wholesale from whichever side wrote
  // last, dropping every other lane's decisions. That is the exact bug the
  // merge exists to prevent for findings.
  const store = freshStore();
  const at = "2026-09-22T10:00:00.000Z";
  const one = {
    lane: "orders",
    observation: "empty register",
    verdict: "defect" as const,
    severity: "high",
    category: "data-inconsistency",
    confidence: 0.9,
    evidence: "GET /api/orders 403",
    at,
  };
  assert.equal(store.addLaneDecisions("orders", [one]), 1);
  assert.equal(store.addLaneDecisions("orders", [one]), 0, "the same decision is not stored twice");

  const reloaded = openStore(path.dirname(store.dir));
  assert.equal(reloaded.laneDecisions.length, 1);
  assert.equal(reloaded.laneDecisions[0].evidence, "GET /api/orders 403");

  // A second lane writing through its own store must not erase the first.
  reloaded.addLaneDecisions("stock", [{ ...one, lane: "stock", observation: "stale count" }]);
  store.addLaneDecisions("orders", [{ ...one, observation: "second look" }]);
  const both = openStore(path.dirname(store.dir)).laneDecisions;
  assert.deepEqual(both.map((d) => d.lane + ":" + d.observation).sort(), ["orders:empty register", "orders:second look", "stock:stale count"]);
});

test("a lane's routes survive a reload, and a second process's lanes are not lost", () => {
  // The benchmark decides whether a lane's "not a defect" is about its own
  // page from these, and each lane folds its report in its own process.
  const store = freshStore();
  assert.deepEqual(store.laneRoutes, {});
  assert.equal(store.addLaneRoutes("orders", ["/orders.html", "/order.html?id=3 (from the list)"]), 2);
  assert.equal(store.addLaneRoutes("orders", ["/order.html (from the list)", "/orders.html", "  "]), 0, "a report folded twice adds nothing");

  const reloaded = openStore(path.dirname(store.dir));
  assert.deepEqual(reloaded.laneRoutes, { orders: ["/order.html (from the list)", "/orders.html"] });
  reloaded.addLaneRoutes("stock", ["/stock.html"]);
  store.addLaneRoutes("orders", ["/audit.html"]);
  assert.deepEqual(openStore(path.dirname(store.dir)).laneRoutes, {
    orders: ["/order.html (from the list)", "/orders.html", "/audit.html"],
    stock: ["/stock.html"],
  });

  // And a merge is a union per lane, so folding the same document twice changes nothing.
  const a: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [], laneRoutes: { orders: ["/a"] } };
  const b: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [], laneRoutes: { orders: ["/b"], stock: ["/s"] } };
  const once = mergeMemory(a, b);
  assert.deepEqual(once.laneRoutes, { orders: ["/b", "/a"], stock: ["/s"] });
  assert.deepEqual(mergeMemory(once, b).laneRoutes, once.laneRoutes);
  assert.equal("laneRoutes" in mergeMemory({ version: 1, states: {}, findings: [] }, { version: 1, states: {}, findings: [] }), false);
});

test("a lane's route is stored without its query string or fragment", () => {
  // A lane copies routes from the address bar, and an address can carry a token.
  const store = freshStore();
  const secret = "abc123def456ghi";
  store.addLaneRoutes("auth", [`/cb?access_token=${secret}`, `/cb#code=${secret}`, `/files/x.pdf?X-Amz-Signature=${secret}`, `/#/things?session_id=${secret}`]);
  const file = fs.readFileSync(path.join(store.dir, "memory.json"), "utf8");
  assert.ok(!file.includes(secret), file);
  assert.deepEqual(store.laneRoutes.auth, ["/cb", "/files/x.pdf", "/#/things"], "two spellings of /cb are one route");
});

test("past the cap, a lane keeps the routes it covered most recently", () => {
  const store = freshStore();
  const many = Array.from({ length: MAX_LANE_ROUTES + 5 }, (_, i) => `/p${i}.html`);
  store.addLaneRoutes("big", many);
  const kept = store.laneRoutes.big;
  assert.equal(kept.length, MAX_LANE_ROUTES);
  assert.equal(kept.at(-1), `/p${MAX_LANE_ROUTES + 4}.html`, "the newest is kept");
  assert.ok(!kept.includes("/p0.html"), "the oldest goes");
  // Covering an old page again makes it recent, so it survives the next cap.
  store.addLaneRoutes("big", ["/p5.html (again)", "/new.html"]);
  assert.ok(store.laneRoutes.big.includes("/p5.html (again)"));
  assert.ok(!store.laneRoutes.big.includes("/p5.html"), "one entry per page");
  assert.ok(!store.laneRoutes.big.includes("/p6.html"), "and what was oldest goes instead");
});

test("a lane's free text is redacted and capped before it is stored", () => {
  // An observation and a signature are written by a model reading the app
  // under test, and hygiene-test exists because a credential must never reach
  // disk. Storing them raw survived every test in this suite.
  const store = freshStore();
  const at = "2026-09-22T10:00:00.000Z";
  store.addLaneDecisions("orders", [
    {
      lane: "orders",
      observation: "login as ?token=sk-live-abcdef0123456789 fails",
      verdict: "defect",
      severity: "high",
      category: "security",
      confidence: 0.9,
      evidence: "GET /api/login?api_key=sk-live-abcdef0123456789 403",
      at,
    },
  ]);
  const stored = store.laneDecisions[0];
  assert.ok(!stored.observation.includes("sk-live-abcdef0123456789"), stored.observation);
  assert.ok(!(stored.evidence ?? "").includes("sk-live-abcdef0123456789"), String(stored.evidence));

  // …and neither field can grow without bound.
  store.addLaneDecisions("orders", [
    { lane: "orders", observation: "x".repeat(900), verdict: "unsure", severity: null, category: null, confidence: 0.5, evidence: "y".repeat(900), at },
  ]);
  const long = store.laneDecisions[1];
  assert.ok(long.observation.length <= 200, String(long.observation.length));
  assert.ok((long.evidence ?? "").length <= 200, String(long.evidence?.length));
});

test("re-folding one lane report does not double the lane's weight", () => {
  // `at` is stamped when the planner FOLDS the reply, not when the lane
  // judged, so a retry or a re-fold stored every decision again and counted
  // each prediction twice in the calibration.
  const store = freshStore();
  const one = {
    lane: "orders",
    observation: "empty register",
    verdict: "defect" as const,
    severity: "high",
    category: "http-error",
    confidence: 0.9,
    evidence: "GET /api/orders 403",
    at: "2026-09-22T10:00:00.000Z",
  };
  assert.equal(store.addLaneDecisions("orders", [one]), 1);
  assert.equal(store.addLaneDecisions("orders", [{ ...one, at: "2026-09-22T10:05:00.000Z" }]), 0, "folded again a minute later: the same judgement");
  assert.equal(store.laneDecisions.length, 1);
});

test("lane decisions are capped, and the count reported is what survived", () => {
  const store = freshStore();
  const at = "2026-09-22T10:00:00.000Z";
  const many = Array.from({ length: MAX_LANE_DECISIONS + 50 }, (_, i) => ({
    lane: "orders",
    observation: `obs-${i}`,
    verdict: "defect" as const,
    severity: "low",
    category: "http-error",
    confidence: 0.5,
    evidence: `GET /api/r${i} 500`,
    at,
  }));
  const kept = store.addLaneDecisions("orders", many);
  assert.equal(store.laneDecisions.length, MAX_LANE_DECISIONS);
  assert.equal(kept, MAX_LANE_DECISIONS, "reporting what was appended would claim more than the store holds");
});

test("every call reports what it kept, not just the first one", () => {
  // `list` aliases the stored array, so measuring "kept" as growth read the
  // length AFTER the appends: every call after the first returned 0 while
  // storing fine, and the tool then told the planner nothing had been kept.
  const store = freshStore();
  const at = "2026-09-22T10:00:00.000Z";
  const d = (o: string) => ({
    lane: "orders",
    observation: o,
    verdict: "defect" as const,
    severity: "low",
    category: "http-error",
    confidence: 0.5,
    evidence: `GET /api/${o} 500`,
    at,
  });
  assert.equal(store.addLaneDecisions("orders", [d("a"), d("b")]), 2);
  assert.equal(store.addLaneDecisions("orders", [d("c"), d("e")]), 2, "the second call keeps two as well");
  assert.equal(store.addLaneDecisions("orders", [d("f")]), 1);
  assert.equal(store.laneDecisions.length, 5);
});

test("a run's shared state ends with the run, and the project's memory does not", () => {
  const store = freshStore();
  store.auditsThisRun = 2;
  store.probes = [{ payload: "<b x>", tag: "b", attrs: [["x", ""]], text: null, selector: "b[x]", field: "f", typedOn: "/a", baseline: 0 }];
  store.injectionsReported.add("<b x>|/list");
  store.addFinding({ severity: "low", category: "other", title: "kept", detail: "d", evidence: "e", url: "http://x/", state: "s", repro: [] });
  store.endRun();
  assert.equal(store.auditsThisRun, 0);
  assert.deepEqual(store.probes, []);
  assert.equal(store.injectionsReported.size, 0);
  assert.equal(store.findings.length, 1, "findings are the project's, not the run's");
});

test("dedup: two different defects on one element stay two, and a rewording of one still merges", () => {
  // Seen in a benchmark run: a link clipped out of view by an overflow-hidden
  // panel (visual) and the same link "styled like body text" (ux-polish) were
  // filed on one route, naming one element. The styling finding was merged
  // into the clipping one — where was compared, what was wrong was not.
  // The pair differs in ONE fact, the category; the evidence shapes and the
  // quoted link text are the same in both directions.
  const clipped = {
    ...base,
    category: "visual",
    state: "/reports#1",
    title: '"Export as CSV" link is clipped out of view inside the report panel',
    detail: "The panel has a fixed height and hides its overflow; the link sits below it.",
    evidence: "testid=report-export clipped by overflow-hidden testid=report-panel",
  };
  const rows = [
    // [second filing, merges, why]
    [
      {
        category: "ux-polish",
        title: "Export link is styled like body text",
        detail: 'The "Export as CSV" link has no underline and the body text colour.',
        evidence: "testid=report-export no underline, color == body text",
      },
      false,
      "a different claim about the same element (quoted in the detail) is a second defect",
    ],
    [
      { category: "ux-polish", title: "Export link is styled like body text", detail: "No underline.", evidence: clipped.evidence },
      false,
      "identical evidence naming only the element says where, not what is wrong",
    ],
    [
      { category: "a11y", title: "The export link is clipped out of view inside the report panel", detail: "d", evidence: undefined },
      false,
      "a near-identical title under another kind, with nothing else to go on, is not a rewording",
    ],
    [
      {
        category: "visual",
        title: "The export link is cut off by the report panel",
        detail: 'The "Export as CSV" link sits below the panel\'s fixed height.',
        evidence: '"Export as CSV" unreachable: clipped by overflow-hidden ancestor of testid=report-panel',
      },
      true,
      "the same claim reworded, same kind: one finding",
    ],
    [
      { category: "visual", title: "Export link clipped (panel overflow)", detail: "d", evidence: clipped.evidence },
      true,
      "identical evidence, same kind: one finding",
    ],
    [
      { category: "visual", title: "Export as CSV link is clipped out of view in the report panel", detail: "d", evidence: undefined },
      true,
      "a paraphrased title of the same kind still merges when one side has no evidence",
    ],
  ] as const;
  for (const [second, merges, why] of rows) {
    const store = freshStore();
    store.addFinding(clipped);
    const [kept, isNew] = store.addFinding({ ...clipped, ...second });
    assert.equal(isNew, !merges, why);
    assert.equal(store.findings.length, merges ? 1 : 2, why);
    if (!merges) assert.equal(kept.category, second.category, `${why}: the second finding keeps its own kind`);
  }
});

test("dedup: identical evidence on one route is not one bug when the kinds differ", () => {
  // The endpoint rule already demanded one category across routes; on the
  // same route, identical evidence merged a security finding and a UX finding
  // about one refused request.
  const store = freshStore();
  store.addFinding({ ...base, category: "security", title: "Role boundary leaks", detail: "x", evidence: "GET /api/admin 403" });
  const [, isNew] = store.addFinding({ ...base, category: "ux-confusing", title: "403 shows a blank page", detail: "y", evidence: "GET /api/admin 403" });
  assert.equal(isNew, true, "a security finding and a UX finding with one signature are two bugs");
  // A crash seen as a page error by one lane and a console error by another,
  // with the same evidence, is still one crash.
  const [, crash] = store.addFinding({
    ...base,
    category: "page-error",
    title: "Save throws",
    detail: "a",
    evidence: "TypeError: x is undefined at save.js:12",
  });
  const [, twin] = store.addFinding({
    ...base,
    category: "console-error",
    title: "Console error on save",
    detail: "b",
    evidence: "TypeError: x is undefined at save.js:12",
  });
  assert.equal(crash, true);
  assert.equal(twin, false, "one family, identical evidence: one finding");
});

test("dedup: visual and ux-confusing with identical evidence are two findings", () => {
  // The label pair archived benchmark runs disagree on most often: a control
  // covered by an overlay filed as a layout defect by one lane and as a
  // confusing flow by another. Kept as a visible duplicate (ADR 4).
  const store = freshStore();
  const covered = { ...base, state: "/orders#1", detail: "d", evidence: "testid=order-save covered by testid=promo-badge" };
  store.addFinding({ ...covered, category: "visual", title: "Badge covers the Save button" });
  const [, isNew] = store.addFinding({ ...covered, category: "ux-confusing", title: "Save cannot be clicked where it is drawn" });
  assert.equal(isNew, true);
  assert.equal(store.findings.length, 2);
});

test("an entry merged under the old rule is left as it is on reload", () => {
  // A visual finding that absorbed a ux-polish filing before the kinds were
  // split holds one entry with two runs. Reloading must neither split it (the
  // absorbed title is gone) nor merge anything further into it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  const memDir = path.join(dir, ".scenescout");
  fs.mkdirSync(memDir, { recursive: true });
  const entry = (id: string, category: string, title: string, evidence: string, runs: number) => ({
    id,
    severity: "medium",
    category,
    title,
    detail: 'The "Export as CSV" link.',
    evidence,
    url: "http://x/reports",
    state: "/reports#1",
    repro: [],
    foundAt: "2026-01-01T00:00:00Z",
    runs,
  });
  fs.writeFileSync(
    path.join(memDir, "memory.json"),
    JSON.stringify({
      version: 1,
      states: {},
      findings: [
        entry("aaa", "visual", '"Export as CSV" link is clipped out of view', "testid=report-export clipped by testid=report-panel", 2),
        entry("bbb", "ux-polish", '"Export as CSV" link has no hover state', "testid=report-export no hover style", 1),
      ],
    }),
  );
  const store = openStore(dir);
  assert.equal(store.findings.length, 2, "the merged entry and a later ux-polish finding on the same link stay apart");
  assert.equal(store.findings.find((f) => f.id === "aaa")?.runs, 2, "the merged entry keeps its run count");
  assert.equal(store.findings.find((f) => f.id === "bbb")?.runs, 1);
});

test("mergeableCategories: what a finding of each kind may merge with", () => {
  assert.deepEqual(mergeableCategories("visual"), ["visual"]);
  assert.deepEqual(mergeableCategories("ux-polish"), ["ux-polish"]);
  assert.deepEqual(mergeableCategories("data-loss"), ["data-inconsistency", "stale-state", "data-loss"]);
  assert.deepEqual(mergeableCategories("made-up"), ["made-up"], "an unknown kind merges only with itself");
  for (const c of FINDING_CATEGORIES) assert.ok(mergeableCategories(c).includes(c), c);
});

test("dedup: one fact flips the literal merge — whether the two kinds are one family", () => {
  const layout = {
    ...base,
    title: 'The "Save notes" button sits under the sticky bar',
    detail: "Covered at load.",
    evidence: "order-save covered at load",
  };
  const twin = { ...layout, title: 'The "Save notes" button is hard to reach at load', evidence: "order-save unreachable at load" };
  for (const [first, second, merges] of [
    ["visual", "visual", true],
    // The presentation kinds are each their own family: one element carries a
    // layout defect, a styling one and an accessibility one independently.
    ["visual", "ux-polish", false],
    ["visual", "a11y", false],
    ["a11y", "missing-testid", false],
    ["visual", "data-inconsistency", false], // a layout finding and a data finding
    ["page-error", "console-error", true],
    ["data-loss", "data-inconsistency", true],
    ["security", "data-inconsistency", false],
    ["other", "data-inconsistency", false], // "nothing fits" is a family of its own
    ["other", "other", true],
  ] as const) {
    const store = freshStore();
    store.addFinding({ ...layout, category: first });
    const [, isNew] = store.addFinding({ ...twin, category: second });
    assert.equal(isNew, !merges, `${first} + ${second}`);
  }
});

test("dedup: one fact flips the literal merge within a family — whether the two findings name the same request", () => {
  // Seen in a benchmark run: a finding about an unknown order id mentioned the
  // button another finding quotes in its title, both were flow findings, and
  // the first was merged into the second — a different bug, lost.
  const pending = {
    ...base,
    category: "ux-confusing",
    title: '"Request manager approval" stays enabled on an order already awaiting approval',
    detail: "Reloading a pending order shows the button enabled again.",
    evidence: "POST /api/orders/1042/request-approval 409 on reload of a pending order",
  };
  const unknownId = {
    ...base,
    category: "ux-confusing",
    title: "An unknown order id still offers its actions",
    detail: 'The page says Order not found, yet "Request manager approval" and Delete stay enabled.',
    evidence: "GET /api/orders/9999 404; order-request-approval enabled",
  };
  for (const [evidence, merges, why] of [
    [unknownId.evidence, false, "a different request: a different bug"],
    ["POST /api/orders/1037/request-approval 409 after a reload", true, "the same request on another order: the same bug"],
    ['"Request manager approval" enabled after reload', true, "evidence naming no request still merges on the quoted literal"],
  ] as const) {
    const store = freshStore();
    store.addFinding(pending);
    const [, isNew] = store.addFinding({ ...unknownId, evidence });
    assert.equal(isNew, !merges, why);
  }
});

test("requestsDisagree: only two sets of named requests with nothing in common", () => {
  for (const [a, b, disagree] of [
    ["GET /api/orders/9999 404", "POST /api/orders/1042/request-approval 409", true],
    ["GET /api/orders/9999 404", "GET /api/orders/1041 404", false], // one endpoint, two ids
    ["GET /api/x", "GET /api/x/ 500", false], // the status and a trailing slash do not matter
    ["GET /api/x 500", "POST /api/x 500", true], // the method does
    ["GET /api/a 500; POST /api/b 409", "POST /api/b 409", false], // one request in common
    ["GET /api/a 500", "toast says Not found", false], // one side names no request
    [undefined, "GET /api/a 500", false],
  ] as const) {
    assert.equal(requestsDisagree(a, b), disagree, `${a} | ${b}`);
  }
});

test("dedup: a bracketed phrase shared across families does not merge two bugs", () => {
  const store = freshStore();
  store.addFinding({
    ...base,
    category: "data-inconsistency",
    title: "Negative item count accepted (no server-side validation)",
    detail: "d",
    evidence: "items -5 stored",
  });
  const [, isNew] = store.addFinding({
    ...base,
    category: "security",
    title: "Empty customer accepted (no server-side validation)",
    detail: "d",
    evidence: "customer blank stored",
  });
  assert.equal(isNew, true);
  // Within one family the same generic tag still merges two different bugs:
  // a known limit of matching on quoted text, kept visible here.
  const [, sameFamilyTag] = store.addFinding({
    ...base,
    category: "data-loss",
    title: "Zero items accepted (no server-side validation)",
    detail: "d",
    evidence: "items 0 stored",
  });
  assert.equal(sameFamilyTag, false, "known limit: one family, one bracketed tag");
});

test("sameFamily: every category belongs to a family, and a missing one matches nothing", () => {
  for (const c of FINDING_CATEGORIES) assert.equal(sameFamily(c, c), true, c);
  assert.equal(sameFamily(undefined, "visual"), false);
  assert.equal(sameFamily("", "visual"), false);
  assert.equal(sameFamily("made-up", "made-up"), false, "an unknown category read from an old file fails safe");
});

test("a finding filed right after a lane report is folded keeps its repro trace", () => {
  const store = freshStore();
  store.logAction({ action: "navigate", target: "/orders", url: "http://x/orders", session: "lane" });
  store.logAction({ action: "click", target: "e3", url: "http://x/orders", session: "lane" });
  store.logAction({ action: "type", target: "e4", url: "http://x/orders", session: "lane" });
  // The planner folds the lane's report; the marker carries no page step.
  store.logAction({ action: "lane-report", url: "", session: "lane" });
  const [f] = store.addFinding({ ...base, url: "http://x/orders", state: "/orders#s1", title: "Filed after the fold", detail: "d", evidence: "e-after-fold" });
  assert.deepEqual(
    f.repro.map((r) => r.split(" ")[0]),
    ["navigate", "click", "type"],
    "the fold marker neither cuts the trace nor appears in it",
  );
});

test("select choices: options no session chose this run, per dropdown", () => {
  const store = freshStore();
  const filter = ["All", "Open", "Shipped", "Awaiting approval", "Approved", "Rejected", "Archived"];
  store.recordSelectChoice("/orders#a1", "orders-status-filter", filter, "Awaiting approval");
  store.recordSelectChoice("/orders#b2", "orders-status-filter", filter, "Rejected"); // another state of the same route
  store.recordSelectChoice("/orders#c3", "orders-status-filter", filter, "All");
  assert.deepEqual(store.unchosenOptions(), [{ route: "/orders", key: "orders-status-filter", unchosen: ["Open", "Shipped", "Approved", "Archived"] }]);
  // Every option chosen, by any session sharing the store: nothing left to name.
  for (const o of filter) store.recordSelectChoice("/orders#d4", "orders-status-filter", filter, o);
  assert.deepEqual(store.unchosenOptions(), []);
});

test("select choices: a picker larger than a filter is not tracked, and a run's choices end with the run", () => {
  const store = freshStore();
  const zones = Array.from({ length: MAX_SELECT_OPTIONS + 1 }, (_, i) => `Zone ${i}`);
  store.recordSelectChoice("/settings#s", "settings-timezone", zones, "Zone 3");
  assert.deepEqual(store.unchosenOptions(), [], "hundreds of time zones are not owed a choice each");
  const small = zones.slice(0, MAX_SELECT_OPTIONS);
  store.recordSelectChoice("/settings#s", "settings-region", small, "Zone 1");
  assert.equal(store.unchosenOptions()[0]?.unchosen.length, MAX_SELECT_OPTIONS - 1, "at the limit it is still a filter");
  store.endRun();
  assert.deepEqual(store.unchosenOptions(), [], "whether an earlier run chose an option says nothing about this one");
});

/** A field as the page reports it: a visible, enabled, writable, empty text input unless told otherwise. */
function field(over: Partial<FieldFacts> = {}): FieldFacts {
  return { tag: "input", type: "text", disabled: false, readOnly: false, visible: true, filled: false, ...over };
}

/** What the page reports about a form an action touched: a click on its enabled submit control unless told otherwise. */
function formProbe(over: Partial<FormProbe> = {}): FormProbe {
  return {
    attrs: { id: "", name: "", action: "", method: "" },
    submit: "/html[1]/body[1]/form[1]/button[1]",
    submitTestid: null,
    submitName: "Save",
    fields: [field()],
    self: field({ tag: "button", type: "" }),
    selfIsSubmit: true,
    defaultDisabled: false,
    ...over,
  };
}

test("empty submit: a submit counts as empty only when every text-entry field is blank", () => {
  const email = field({ type: "email" });
  const name = field();
  const submit = formProbe({ fields: [email, name] });
  assert.equal(isEmptySubmit("click", submit), true, "both blank: the empty submit");
  // The contrastive case: identical but for one filled field.
  assert.equal(isEmptySubmit("click", { ...submit, fields: [field({ type: "email", filled: true }), name] }), false, "one field filled is not an empty submit");
  // Fields that cannot be left blank by typing do not stop it being empty, and do not make it filled.
  const withChoices = [
    email,
    field({ type: "checkbox", filled: true }),
    field({ type: "radio", filled: true }),
    field({ tag: "select", type: "", filled: true }),
    field({ type: "hidden", filled: true }),
  ];
  assert.equal(isEmptySubmit("click", { ...submit, fields: withChoices }), true, "a ticked box or a chosen option is not typed text");
  // Nor do fields nobody can type into.
  const unreachable = [email, field({ disabled: true, filled: true }), field({ readOnly: true, filled: true }), field({ visible: false, filled: true })];
  assert.equal(isEmptySubmit("click", { ...submit, fields: unreachable }), true, "disabled, read-only and hidden fields are not the user's to empty");
  assert.equal(isEmptySubmit("click", null), false);
});

test("empty submit: a form with no text-entry field is never tracked or counted", () => {
  const choicesOnly = [field({ type: "checkbox" }), field({ tag: "select", type: "" }), field({ type: "search" }), field({ type: "file" })];
  assert.equal(tracksForm(choicesOnly), false);
  assert.equal(formStatus({ fields: choicesOnly, submitDisabled: false }), "untracked");
  assert.equal(allTextEmpty(choicesOnly), false, "nothing to leave blank is not 'all blank'");
  assert.equal(tracksForm([...choicesOnly, field({ tag: "textarea", type: "" })]), true, "a textarea is text entry");
  for (const type of TEXT_ENTRY_TYPES) assert.equal(isTextEntry(field({ type })), true, type);
});

test("empty submit: a form whose every submit control is disabled while it is blank is guarded, not owed a try", () => {
  assert.equal(formStatus({ fields: [field()], submitDisabled: false }), "open");
  assert.equal(formStatus({ fields: [field()], submitDisabled: true }), "guarded", "the page refuses the empty submit itself");
  // Contrastive: disabled for some other reason while filled says nothing about the empty submit.
  assert.equal(formStatus({ fields: [field({ filled: true })], submitDisabled: true }), "open");
});

test("empty submit: what counts as a submit — a click on a native submit control, Enter where the browser submits implicitly", () => {
  const typing = (over: Partial<FieldFacts>, extra: Partial<FormProbe> = {}): FormProbe => formProbe({ self: field(over), selfIsSubmit: false, ...extra });
  assert.equal(submits("click", formProbe()), true);
  assert.equal(submits("click", formProbe({ selfIsSubmit: false })), false, "a type=button click inside the form submits nothing");
  assert.equal(submits("click", typing({})), false, "clicking into a field submits nothing");
  assert.equal(submits("enter", typing({})), true, "Enter in a text input submits");
  assert.equal(submits("enter", typing({ type: "search" })), true, "…and in a search input");
  assert.equal(submits("enter", typing({ type: "checkbox" })), false, "Enter in a checkbox does not submit");
  assert.equal(submits("enter", typing({ type: "radio" })), false, "…nor in a radio");
  assert.equal(submits("enter", typing({ tag: "textarea", type: "" })), false, "Enter in a textarea is a newline");
  assert.equal(submits("enter", typing({}, { defaultDisabled: true })), false, "Enter does not submit while the default button is disabled");
  assert.equal(submits("enter", formProbe()), true, "Enter activates a focused submit control");
  assert.equal(submits("enter", formProbe({ selfIsSubmit: false })), false, "…but not some other button");
});

test("empty submit: only a page navigating away under a form read is expected; anything else is worth logging", () => {
  assert.equal(isNavigationTeardown("page.evaluate: Execution context was destroyed, most likely because of a navigation"), true);
  assert.equal(isNavigationTeardown("locator.evaluate: Target page, context or browser has been closed"), true);
  assert.equal(isNavigationTeardown("frame was detached"), true);
  assert.equal(isNavigationTeardown("ReferenceError: xpathOf is not defined"), false);
  assert.equal(isNavigationTeardown("Timeout 1000ms exceeded."), false);
});

test("empty submit: forms seen are listed until any session submits them empty, per route, per run", () => {
  const store = freshStore();
  store.recordForm("/things/new#a1", "tid:thing-save");
  store.recordForm("/things/new#b2", "tid:thing-save"); // another state of the same route: the same form
  store.recordForm("/things/new#a1", "button:add note");
  store.recordForm("/other#c3", "tid:thing-save"); // the same control on another route is another form
  assert.deepEqual(store.formsNeverSubmittedEmpty(), [
    { route: "/things/new", key: "tid:thing-save", seenBy: [] },
    { route: "/things/new", key: "button:add note", seenBy: [] },
    { route: "/other", key: "tid:thing-save", seenBy: [] },
  ]);
  store.recordFormSubmit("/things/new#b2", "tid:thing-save", false);
  assert.equal(store.formsNeverSubmittedEmpty().length, 3, "a filled submit leaves it listed");
  store.recordFormSubmit("/things/new#b2", "tid:thing-save", true);
  assert.deepEqual(
    store.formsNeverSubmittedEmpty().map((f) => `${f.route} ${f.key}`),
    ["/things/new button:add note", "/other tid:thing-save"],
    "an empty submit on any state of the route clears it, and only there",
  );
  store.recordForm("/other#c4", "tid:thing-save", true);
  assert.deepEqual(
    store.formsNeverSubmittedEmpty().map((f) => `${f.route} ${f.key}`),
    ["/things/new button:add note"],
    "seen guarded (submit disabled while blank), it leaves the list",
  );
  store.recordForm("/embed#e", "frame:https://widget.example|button:send");
  assert.equal(store.formsNeverSubmittedEmpty().length, 1, "another site's frame is not the app's form");
  store.endRun();
  assert.deepEqual(store.formsNeverSubmittedEmpty(), [], "an earlier run's forms are not this run's to-do list");
});

test("coverage in a parallel run: a session sees its own routes and forms by default, the project view sees both and says whose", () => {
  const store = freshStore();
  store.visitState("/a#1", "http://x/a", "/a", ["tid:a-save", "tid:a-filter"], [], "lane-a");
  store.recordForm("/a#1", "tid:a-save", false, "lane-a");
  store.visitState("/b#1", "http://x/b", "/b", ["tid:b-save", "tid:b-delete"], [], "lane-b");
  store.recordForm("/b#1", "tid:b-save", false, "lane-b");
  // Both lanes on one route: one form, seen by both.
  store.visitState("/c#1", "http://x/c", "/c", ["tid:c-send"], [], "lane-a");
  store.visitState("/c#2", "http://x/c", "/c", ["tid:c-send"], [], "lane-b");
  store.recordForm("/c#1", "tid:c-send", false, "lane-a");
  store.recordForm("/c#2", "tid:c-send", false, "lane-b");

  assert.deepEqual([...store.routesVisitedBy("lane-a")], ["/a", "/c"]);
  assert.deepEqual(
    store.formsNeverSubmittedEmpty("lane-a").map((f) => `${f.route} ${f.key}`),
    ["/a tid:a-save", "/c tid:c-send"],
    "only the forms lane-a saw",
  );
  assert.equal(store.formsNeverSubmittedEmpty().length, 3, "with no session, every form");

  const routeLine = "Routes visited: 3/3 ✓";
  const own = coverageView(store, "lane-a", "session", routeLine).join("\n");
  assert.match(own, /Scope: session lane-a — the 2 route\(s\)/);
  assert.match(own, /\/a: /);
  assert.match(own, /\/c: /);
  assert.doesNotMatch(own, /\/b[: ]/, "lane-b's route and form are not lane-a's gaps");
  assert.doesNotMatch(own, /seen by/, "a session's own list needs no tags");
  assert.match(own, /Elements exercised: 0\/3/, "the totals count the session's routes only");

  const all = coverageView(store, "lane-a", "project", routeLine).join("\n");
  assert.match(all, /\/b: [^\n]*\(this run: lane-b\)/, "the project view lists lane-b's route, tagged");
  assert.match(all, /\/c: [^\n]*\(this run: lane-a, lane-b\)/);
  assert.match(all, /\/b tid:b-save \(seen by lane-b\)/);
  assert.match(all, /\/c tid:c-send \(seen by lane-a, lane-b\)/);
  assert.match(all, /Elements exercised: 0\/5/);

  const fresh = coverageView(store, "lane-c", "session", routeLine).join("\n");
  assert.match(fresh, /has reached no route this run yet/);
  assert.doesNotMatch(fresh, /tid:/, "a session that reached nothing has no gaps of its own yet");

  store.endRun();
  assert.deepEqual([...store.routesVisitedBy("lane-a")], [], "per run: the next run starts with no session's routes");
});

test("empty submit: a submit only marks a form already listed, and says when it matched none", () => {
  const store = freshStore();
  store.recordForm("/things/new#a1", "tid:thing-save");
  assert.equal(store.recordFormSubmit("/things/new#a1", "button:cancel", false), false, "a key read at submit time names no listed form");
  assert.equal(store.recordFormSubmit("/things/new#a1", "button:cancel", true), false);
  assert.deepEqual(
    [...store.emptySubmits.values()].map((f) => f.key),
    ["tid:thing-save"],
    "a submit never adds an entry, filled or empty",
  );
  assert.equal(store.recordFormSubmit("/things/new#a1", "tid:thing-save", true), true);
  assert.deepEqual(store.formsNeverSubmittedEmpty(), []);
});

test("empty submit: a form is known by its id, then its name, then its action and method, and only then by its submit control", () => {
  const none = { id: "", name: "", action: "", method: "" };
  assert.equal(formIdentity({ ...none, id: "profile-form", name: "p", action: "/x" }), "form:#profile-form");
  assert.equal(formIdentity({ ...none, name: "pay", action: "/x" }), "form:name=pay");
  assert.equal(formIdentity({ ...none, action: "/things", method: "post" }), "form:POST /things");
  assert.equal(formIdentity({ ...none, action: "/things" }), "form:GET /things", "no method is a GET");
  // The page resolves the action to a full URL; a record id or a per-load token in it is not a new form.
  assert.equal(
    formIdentity({ ...none, action: "http://app.test/things/42/comments?token=a1b2", method: "post" }),
    formIdentity({ ...none, action: "http://app.test/things/7/comments?token=z9y8", method: "post" }),
  );
  assert.equal(formIdentity({ ...none, action: "http://app.test/things/42/comments?token=a1b2", method: "post" }), "form:POST /things/:id/comments");
  assert.equal(formIdentity({ ...none, id: "  " }), null, "a blank attribute is no identity");
  assert.equal(formIdentity(none), null, "nothing of its own: the engine falls back to the submit control's key");
});

test("empty submit: a snapshot element is the probed submit control only when its testid and name agree", () => {
  const probe = { submitTestid: "thing-send", submitName: "Send message" };
  assert.equal(sameControl({ testid: "thing-send", name: "Send message" }, probe), true);
  // Contrastive: the same path now naming the button that used to sit there.
  assert.equal(sameControl({ testid: "thing-cancel", name: "Cancel" }, probe), false);
  assert.equal(sameControl({ testid: null, name: "Send message" }, probe), false, "a testid on one side only is a different control");
  assert.equal(sameControl({ testid: null, name: "Cancel" }, { submitTestid: null, submitName: "Send" }), false, "untagged: the name decides");
  assert.equal(sameControl({ testid: null, name: "Send" }, { submitTestid: null, submitName: "Send" }), true);
});

test("empty submit: the forms bookkeeping stays out of a finding's repro trace", () => {
  const store = freshStore();
  store.logAction({ action: "navigate", target: "/things/new", url: "http://x/things/new", session: "s" });
  store.logAction({ action: "click", target: "e3", url: "http://x/things/new", session: "s" });
  store.logAction({ action: FORMS_SUBMIT_UNMATCHED, target: "click submit of a form", url: "http://x/things/new", session: "s" });
  store.logAction({ action: FORMS_READ_FAILED, target: "form probe took over 1000 ms", url: "http://x/things/new", session: "s" });
  const [f] = store.addFinding({ ...base, url: "http://x/things/new", state: "/things/new#s1", title: "Save does nothing", detail: "d", evidence: "e-forms" });
  assert.deepEqual(
    f.repro.map((r) => r.split(" ")[0]),
    ["navigate", "click"],
  );
  assert.equal(isFormBookkeeping(FORMS_SUBMIT_UNMATCHED) && isFormBookkeeping(FORMS_READ_FAILED) && !isFormBookkeeping("click"), true);
});

test("coverage: controls inside another site's frame are counted apart from the app's", () => {
  const store = freshStore();
  store.visitState("/checkout#a", "http://app.test/checkout", "/checkout", [
    "button:pay",
    "frame:/widget|button:save",
    "frame:https://chat.example.com|button:send",
    "frame:https://chat.example.com|textbox:message",
  ]);
  store.markExercised("/checkout#a", "frame:https://chat.example.com|button:send", "click");
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2, "the page's control and the app's own frame's");
  assert.deepEqual(cov.embeds, { total: 2, exercised: 1 });
  assert.ok(
    cov.unexercised.every((u) => u.keys.every((k) => !isEmbedKey(k))),
    "an embed's controls never reach the gap ledger",
  );
  assert.equal(isEmbedKey("frame:about:srcdoc#Inner|button:x"), false);
});

test("isSubmitLike: submit words count as whole words of the name or test id", () => {
  const cases: Array<[string, string, string | null, boolean]> = [
    ["button", "Sign in", null, true],
    ["button", "Continue", "sign-in", true],
    ["button", "Sign", null, true],
    ["button", "Go", "auth_signup_button", true],
    ["button", "Save", null, true],
    ["button", "Add", "rowAdd", true],
    // The words inside other words are not the word.
    ["button", "Verify", "assignee-verify", false],
    ["button", "Lookup", "postcode-lookup", false],
    ["button", "Design", null, false],
    ["button", "Address book", "address-book", false],
    // Only buttons.
    ["link", "Sign in", null, false],
  ];
  for (const [role, name, testid, want] of cases) assert.equal(isSubmitLike(role, name, testid), want, `${role} ${name} ${testid}`);
});

// ---------------------------------------------------------------------------
// The dedup judge, as the store asks it (fileFinding)
// ---------------------------------------------------------------------------

/** Two filings the rule keeps apart on one page: no evidence, no shared literal, titles too unalike. */
const quiet = { severity: "medium" as const, category: "ux-confusing", detail: "", url: "http://x/orders", state: "/orders#f1" };
const SAVE = { ...quiet, title: "The save button gives no feedback" };
const SILENT = { ...quiet, title: "Clicking save shows nothing", state: "/orders#f2" };

/** A judge that answers from a script and records what it was shown. */
function scriptedJudge(answer: (incoming: FindingInput, stored: readonly Readonly<Finding>[]) => JudgeVerdict | Promise<JudgeVerdict>) {
  const asked: Array<{ incoming: string; stored: string[] }> = [];
  const judge: DuplicateJudge = {
    judge: async (incoming, stored) => {
      asked.push({ incoming: incoming.title, stored: stored.map((f) => f.title) });
      return answer(incoming, stored);
    },
    describe: () => null,
  };
  return { judge, asked };
}

test("dedup judge: a filing the rule keeps apart is merged when the judge says it is the same, and what was filed is kept on the finding", async () => {
  const ruleOnly = freshStore();
  await ruleOnly.fileFinding(SAVE);
  const apart = await ruleOnly.fileFinding(SILENT);
  assert.equal(apart.isNew, true, "the rule keeps the two apart: this is the case the judge is for");

  const store = freshStore();
  const first = await store.fileFinding(SAVE);
  const { judge, asked } = scriptedJudge(() => ({ sameAs: first.finding.id, pSame: 0.93 }));
  store.dedupJudge = judge;
  const filed = await store.fileFinding({ ...SILENT, severity: "high", evidence: "no toast after POST /api/orders 200" });
  assert.equal(filed.isNew, false);
  assert.deepEqual(filed.judged, { pSame: 0.93 });
  assert.equal(store.findings.length, 1);
  assert.equal(filed.finding.runs, 1, "both filings in one run: one run; the merge is kept in judgedMerges");
  assert.deepEqual(asked, [{ incoming: SILENT.title, stored: [SAVE.title] }]);
  const [merge] = filed.finding.judgedMerges ?? [];
  assert.deepEqual(
    { ...merge, at: undefined },
    { title: SILENT.title, category: "ux-confusing", severity: "high", evidence: "no toast after POST /api/orders 200", pSame: 0.93, at: undefined },
  );
  // Kept on disk, so a later run and the report see it.
  const reread = openStore(path.dirname(store.dir));
  assert.equal(reread.findings[0].judgedMerges?.[0].title, SILENT.title);
});

test("dedup judge: the rule decides first, so a filing it merges never reaches the judge, and the judge's 'none' keeps a filing apart", async () => {
  const store = freshStore();
  const { judge, asked } = scriptedJudge(() => null);
  store.dedupJudge = judge;
  await store.fileFinding({ ...base, title: "Reports load fails", detail: "x", evidence: "GET /api/reports 500" });
  const byRule = await store.fileFinding({ ...base, title: "The reports page errors", detail: "y", evidence: "GET /api/reports 500" });
  assert.equal(byRule.isNew, false);
  assert.equal(byRule.judged, undefined);
  assert.equal(byRule.finding.judgedMerges, undefined, "a merge the rule makes records nothing, as before");
  assert.deepEqual(asked, [{ incoming: "Reports load fails", stored: [] }], "the second filing, which the rule merged, was never put to the judge");
  await store.fileFinding(SAVE);
  const kept = await store.fileFinding(SILENT);
  assert.equal(kept.isNew, true);
  assert.equal(asked.length, 3, "the judge was asked about each filing the rule kept apart");
  assert.equal(store.findings.length, 3);
});

test("dedup judge: a filing that lands while the judge is asked is compared by the rule, and a finding resolved meanwhile is never merged into", async () => {
  const store = freshStore();
  const first = await store.fileFinding(SAVE);
  // While the judge is out, another session files the same text: the rule merges the two, as it would have with no judge.
  store.dedupJudge = scriptedJudge(() => {
    store.addFinding({ ...SILENT, state: "/orders#f3" });
    return null;
  }).judge;
  const raced = await store.fileFinding(SILENT);
  assert.equal(raced.isNew, false);
  assert.equal(raced.finding.title, SILENT.title);
  assert.equal(store.findings.length, 2);

  // The judge chose a finding someone resolved before its answer came back: the filing stays apart.
  store.dedupJudge = scriptedJudge(() => {
    first.finding.status = "resolved";
    return { sameAs: first.finding.id, pSame: 0.9 };
  }).judge;
  const late = await store.fileFinding({ ...quiet, title: "Pressing save does nothing visible", state: "/orders#f4" });
  assert.equal(late.isNew, true);
  assert.equal(first.finding.runs, 1);
});

test("dedup judge: a judge that throws leaves the rule's decision and says why; with no judge fileFinding files as addFinding does", async () => {
  const store = freshStore();
  await store.fileFinding(SAVE);
  store.dedupJudge = {
    judge: async () => {
      throw new Error("judge fault");
    },
    describe: () => null,
  };
  const filed = await store.fileFinding(SILENT);
  assert.equal(filed.isNew, true);
  assert.equal(filed.judgeError, "judge fault");

  // The contrast: no judge, the same two filings as addFinding sees them.
  const a = freshStore();
  const b = freshStore();
  const viaFile = [await a.fileFinding(SAVE), await a.fileFinding(SILENT)].map((f) => f.isNew);
  const viaAdd = [b.addFinding(SAVE), b.addFinding(SILENT)].map(([, isNew]) => isNew);
  assert.deepEqual(viaFile, viaAdd);
  // The run's end turns the judge off: the next run asks for it again or goes without.
  store.dedupJudge = scriptedJudge(() => null).judge;
  store.dedupChoice = "judge";
  store.endRun();
  assert.equal(store.dedupJudge, null);
  assert.equal(store.dedupChoice, undefined);
});

test("dedup judge: two stores writing one memory keep every judged merge, once, at most the cap", () => {
  const finding = (judgedMerges: Finding["judgedMerges"], foundAt: string): Finding => ({
    id: "x",
    severity: "low",
    category: "c",
    title: "t",
    detail: "d",
    url: "u",
    state: "/a#1",
    repro: [],
    foundAt,
    runs: 2,
    ...(judgedMerges ? { judgedMerges } : {}),
  });
  const m = (title: string, at: string) => ({ title, category: "c", severity: "low" as const, pSame: 0.9, at });
  const mine = { version: 1 as const, states: {}, findings: [finding([m("one", "2026-01-01"), m("two", "2026-01-02")], "2026-01-03")] };
  const theirs = { version: 1 as const, states: {}, findings: [finding([m("one", "2026-01-01"), m("three", "2026-01-04")], "2026-01-01")] };
  const once = mergeMemory(mine, theirs);
  assert.deepEqual(
    once.findings[0].judgedMerges?.map((x) => x.title),
    ["one", "two", "three"],
  );
  assert.deepEqual(mergeMemory(once, theirs).findings[0].judgedMerges, once.findings[0].judgedMerges, "merging the same document again changes nothing");
  const many = Array.from({ length: MAX_JUDGED_MERGES + 3 }, (_, i) => m(`m${i}`, `2026-02-${String(i + 1).padStart(2, "0")}`));
  const capped = mergeMemory({ ...mine, findings: [finding(many, "2026-03-01")] }, theirs).findings[0].judgedMerges!;
  assert.equal(capped.length, MAX_JUDGED_MERGES);
  assert.equal(capped.at(-1)!.title, `m${MAX_JUDGED_MERGES + 2}`, "the newest are kept");
  assert.equal(
    mergeMemory({ ...mine, findings: [finding(undefined, "2026-01-03")] }, { ...theirs, findings: [finding(undefined, "2026-01-01")] }).findings[0]
      .judgedMerges,
    undefined,
  );
});

test("dedup judge: only what a judge may answer is merged: an open finding on the filing's page, called the same at better than even", async () => {
  const store = freshStore();
  const elsewhere = await store.fileFinding({ ...SAVE, state: "/settings#f1" });
  const here = await store.fileFinding(SAVE);
  const verdicts = [
    { sameAs: elsewhere.finding.id, pSame: 0.95 }, // another page
    { sameAs: here.finding.id, pSame: 0.3 }, // below even: a contradiction, not a merge
    { sameAs: "no-such-id", pSame: 0.95 },
  ];
  for (const [i, verdict] of verdicts.entries()) {
    store.dedupJudge = scriptedJudge(() => verdict).judge;
    // Each has its own title and names its own request, so the rule keeps them apart from each other too.
    const filed = await store.fileFinding({ ...SILENT, title: `${SILENT.title} (case ${i})`, evidence: `no toast after POST /api/orders/${i} 200` });
    assert.equal(filed.isNew, true, JSON.stringify(verdict));
  }
  // The contrast: the same answer naming the finding on this page, at 0.95, merges.
  store.dedupJudge = scriptedJudge(() => ({ sameAs: here.finding.id, pSame: 0.95 })).judge;
  assert.equal((await store.fileFinding({ ...SILENT, title: `${SILENT.title} (case 9)`, evidence: "no toast after POST /api/orders/9 200" })).isNew, false);
});

test("dedup judge: a merge made after another process rewrote memory.json lands on the finding as it now is, and stays on disk", async () => {
  const store = freshStore();
  const first = await store.fileFinding(SAVE);
  store.dedupJudge = scriptedJudge(() => {
    // Another process writes the file while the judge is out, and this store folds it in (as any save would), replacing its objects.
    const other = openStore(path.dirname(store.dir));
    other.addFinding({ ...quiet, title: "Another process's finding on the settings page", state: "/settings#f9" });
    store.flush();
    return { sameAs: first.finding.id, pSame: 0.9 };
  }).judge;
  const filed = await store.fileFinding(SILENT);
  assert.equal(filed.isNew, false);
  const kept = store.findings.find((f) => f.id === first.finding.id)!;
  assert.equal(kept.runs, 1, "one run, however many filings");
  assert.deepEqual(
    judgedMergesOf(kept).map((m) => m.title),
    [SILENT.title],
  );
  assert.ok(
    store.findings.some((f) => f.title === "Another process's finding on the settings page"),
    "and the other process's finding is kept",
  );
  const reread = openStore(path.dirname(store.dir));
  const onDisk = reread.findings.find((f) => f.id === first.finding.id)!;
  assert.equal(onDisk.runs, 1);
  assert.deepEqual(
    judgedMergesOf(onDisk).map((m) => m.title),
    [SILENT.title],
  );
});

test("dedup judge: when a load folds two copies of one finding together, both copies' judged merges are kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, MEMORY_DIRNAME), { recursive: true });
  const copy = (id: string, title: string, merged: string, at: string): Finding => ({
    id,
    severity: "medium",
    category: "http-error",
    title,
    detail: "",
    url: "http://x/a",
    state: "/a#f1",
    repro: [],
    foundAt: at,
    runs: 1,
    evidence: "POST /api/things 500",
    judgedMerges: [{ title: merged, category: "http-error", severity: "medium", pSame: 0.9, at }],
  });
  // One defect filed twice under different titles: the same failing request, so the load's rule folds them into one.
  const memory = {
    version: 1,
    states: {},
    findings: [
      copy("one", "Saving a thing fails", "Save errors out", "2026-01-01T00:00:00.000Z"),
      copy("two", "The thing will not save", "Save is broken", "2026-01-02T00:00:00.000Z"),
    ],
  };
  fs.writeFileSync(path.join(dir, MEMORY_DIRNAME, "memory.json"), JSON.stringify(memory));
  const store = openStore(dir);
  assert.equal(store.findings.length, 1);
  assert.deepEqual(
    judgedMergesOf(store.findings[0]).map((m) => m.title),
    ["Save errors out", "Save is broken"],
  );
});

test("dedup judge: a judged merge read back malformed is dropped, not printed or trusted", () => {
  const good = { title: "Save is broken", category: "http-error", severity: "medium" as const, pSame: 0.9, at: "2026-01-01" };
  const f = { judgedMerges: [good, { ...good, pSame: "0.9" }, { ...good, severity: "urgent" }, { title: "no rest" }, null, "text"] } as unknown as Pick<
    Finding,
    "judgedMerges"
  >;
  assert.deepEqual(judgedMergesOf(f), [good]);
  assert.deepEqual(judgedMergesOf({ judgedMerges: "not a list" } as unknown as Pick<Finding, "judgedMerges">), []);
  assert.deepEqual(judgedMergesOf({}), []);
});

test("the form probe's date and time types are the same list as APP_FILLED_TYPES", () => {
  const line = FORM_PROBE_BODY.split("\n").find((l) => l.includes("const pickerTypes ="));
  assert.ok(line, "the probe declares pickerTypes");
  const listed = JSON.parse(line.slice(line.indexOf("["), line.lastIndexOf("]") + 1)) as string[];
  assert.deepEqual([...listed].sort(), [...APP_FILLED_TYPES].sort());
});

test("session coverage lists the controls on the states this session saw, not another role's on the same route", () => {
  // Role A's state of /x shows five controls; role B's state of /x shows only
  // an access-denied alert. The one fact that differs is which session recorded which state.
  const store = freshStore();
  const adminControls = ["tid:users-table", "tid:invite-btn", "tid:tab-roles", "tid:tab-audit", "tid:save-btn"];
  store.visitState("/x#admin", "http://x/x", "/x", adminControls, [], "lane-admin");
  store.visitState("/x#viewer", "http://x/x", "/x", ["tid:access-denied-retry"], [], "lane-viewer");

  const own = store.coverage({ routes: store.routesVisitedBy("lane-viewer"), states: store.statesVisitedBy("lane-viewer") });
  assert.deepEqual(own.unexercised, [{ state: "/x", keys: ["tid:access-denied-retry"], total: 1 }], "only the viewer's own element");
  assert.equal(own.states, 1);
  const admin = store.coverage({ routes: store.routesVisitedBy("lane-admin"), states: store.statesVisitedBy("lane-admin") });
  assert.deepEqual(admin.unexercised[0]?.keys, adminControls, "the admin's own controls");
  const project = store.coverage();
  assert.equal(project.elementsTotal, 6, "the project scope lists both");

  // An element another session already exercised on another state of the route is not this session's gap.
  store.visitState("/x#viewer2", "http://x/x", "/x", ["tid:access-denied-retry", "tid:save-btn"], [], "lane-viewer");
  store.markExercised("/x#admin", "tid:save-btn", "click");
  const after = store.coverage({ routes: store.routesVisitedBy("lane-viewer"), states: store.statesVisitedBy("lane-viewer") });
  assert.deepEqual(after.unexercised[0]?.keys, ["tid:access-denied-retry"]);
  assert.equal(after.elementsExercised, 1);

  // The view: the session's own list, and the project's route figure labelled as the project's.
  const view = coverageView(store, "lane-viewer", "session", "Routes visited: 54/54 ✓").join("\n");
  assert.doesNotMatch(view, /tid:users-table|tid:invite-btn/, "another role's controls are not listed");
  assert.match(view, /Project route contract \(every session, every run\): Routes visited: 54\/54/);
  assert.match(view, /the 1 route\(s\) it reached this run/);
  const projectView = coverageView(store, "lane-viewer", "project", "Routes visited: 54/54 ✓").join("\n");
  assert.match(projectView, /^Routes visited: 54\/54 ✓$/m, "the project view prints the line as it is");
  assert.match(projectView, /tid:users-table/);

  store.endRun();
  assert.deepEqual([...store.statesVisitedBy("lane-viewer")], [], "per run");
  assert.equal(store.runStates.size, 0);
});

test("coverage: a key recorded inert in any state of a route is not a control, even where an older state left it unflagged", () => {
  // Memory from before the inert flag holds unflagged copies of a wrapper; the
  // engine since records the same key on the same route as inert.
  const store = freshStore();
  store.visitState("/x#old", "http://x/x", "/x", ["tid:wrapper", "button:save"]);
  store.visitState("/x#new", "http://x/x", "/x", ["tid:wrapper", "button:save", "button:open"], ["tid:wrapper"]);
  const cov = store.coverage();
  assert.deepEqual(cov.unexercised, [{ state: "/x", keys: ["button:save", "button:open"], total: 2 }], "the wrapper is not counted");
  // The contrast: a key that no state flags is still a control.
  const plain = freshStore();
  plain.visitState("/x#old", "http://x/x", "/x", ["tid:wrapper", "button:save"]);
  plain.visitState("/x#new", "http://x/x", "/x", ["tid:wrapper", "button:save", "button:open"]);
  assert.deepEqual(plain.coverage().unexercised[0]?.keys, ["tid:wrapper", "button:save", "button:open"]);
  // Another route's states say nothing about this one's.
  store.visitState("/y#1", "http://x/y", "/y", ["tid:wrapper"]);
  assert.deepEqual(
    store.coverage().unexercised.find((u) => u.state === "/y"),
    { state: "/y", keys: ["tid:wrapper"], total: 1 },
  );
});

test("coverage folds states stored under an older route identity into today's, and discovered routes are re-keyed on load", () => {
  const store = freshStore();
  // Written before code-shaped ids collapsed: one route per record.
  store.visitState("/widgets/WID-2025-001#a", "http://x/widgets/WID-2025-001", "/widgets/WID-2025-001", ["button:edit"]);
  store.visitState("/widgets/:id#b", "http://x/widgets/WID-2025-004", "/widgets/:id", ["button:edit"]);
  const cov = store.coverage();
  assert.deepEqual(cov.unexercised, [{ state: "/widgets/:id", keys: ["button:edit"], total: 1 }]);
  assert.deepEqual(
    renormalizeRoutes({ "/widgets/WID-2025-001": "/widgets/WID-2025-001", "/widgets/WID-2025-002": "/widgets/WID-2025-002", "/about": "/about" }),
    { "/widgets/:id": "/widgets/WID-2025-001", "/about": "/about" },
    "one route, its first example kept",
  );
  // Read back from disk, the stored map is re-keyed.
  store.addDiscoveredRoutes([{ route: "/widgets/WID-2025-009", example: "/widgets/WID-2025-009" }]);
  store.flush();
  const again = openStore(path.dirname(store.dir));
  assert.deepEqual(Object.keys(again.discoveredRoutes), ["/widgets/:id"]);
});

test("select choices: the option a dropdown held before the choice counts as chosen", () => {
  // A period select loaded on "Monthly", then set to "Weekly": the page already asked for monthly.
  const store = freshStore();
  const periods = ["Daily", "Weekly", "Monthly"];
  store.recordSelectChoice("/trends#a", "trends-period", periods, "Weekly", ["Monthly"]);
  assert.deepEqual(store.unchosenOptions(), [{ route: "/trends", key: "trends-period", unchosen: ["Daily"] }], "the third option is still owed");
  // The contrast: with nothing selected before, Monthly is still unchosen.
  const fresh = freshStore();
  fresh.recordSelectChoice("/trends#a", "trends-period", periods, "Weekly");
  assert.deepEqual(fresh.unchosenOptions()[0]?.unchosen, ["Daily", "Monthly"]);
});

// ── The project folder a run uses when the attach names none (engine/project-folder.ts) ──

const macHome: Home = { platform: "darwin", homedir: "/Users/u", env: {} };
const noRepo = () => false;

test("the documents folder, per platform", () => {
  const cases: Array<[string, Home, string]> = [
    ["macOS", macHome, "/Users/u/Documents"],
    ["Windows, USERPROFILE", { platform: "win32", homedir: "C:\\Users\\v", env: { USERPROFILE: "C:\\Users\\u" } }, "C:\\Users\\u\\Documents"],
    ["Windows, no USERPROFILE", { platform: "win32", homedir: "C:\\Users\\u", env: {} }, "C:\\Users\\u\\Documents"],
    ["Linux, nothing set", { platform: "linux", homedir: "/home/u", env: {} }, "/home/u/Documents"],
    ["Linux, XDG_DOCUMENTS_DIR", { platform: "linux", homedir: "/home/u", env: { XDG_DOCUMENTS_DIR: "/data/docs" } }, "/data/docs"],
    [
      "Linux, user-dirs.dirs with $HOME",
      { platform: "linux", homedir: "/home/u", env: {}, userDirs: '# comment\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/Dokumente"\n' },
      "/home/u/Dokumente",
    ],
    [
      "Linux, the environment wins over user-dirs.dirs",
      { platform: "linux", homedir: "/home/u", env: { XDG_DOCUMENTS_DIR: "/data/docs" }, userDirs: 'XDG_DOCUMENTS_DIR="$HOME/Dokumente"' },
      "/data/docs",
    ],
    [
      "Linux, documents set to $HOME means none",
      { platform: "linux", homedir: "/home/u", env: {}, userDirs: 'XDG_DOCUMENTS_DIR="$HOME/"' },
      "/home/u/Documents",
    ],
    ["Linux, a relative value is ignored", { platform: "linux", homedir: "/home/u", env: { XDG_DOCUMENTS_DIR: "docs" } }, "/home/u/Documents"],
  ];
  for (const [name, home, want] of cases) assert.equal(documentsDir(home), want, name);
});

test("a tested site's folder name: host, port, IDN and IPv6", () => {
  const cases: Array<[string, string]> = [
    ["http://localhost:3000", "localhost-3000"],
    ["http://localhost:3000/orders/7?tab=2#x", "localhost-3000"],
    ["https://localhost:3000", "localhost-3000"],
    ["http://localhost:3001", "localhost-3001"],
    ["https://Staging.Example.com/", "staging.example.com"],
    ["https://staging.example.com:443/", "staging.example.com"],
    ["http://staging.example.com:80/", "staging.example.com"],
    ["https://staging.example.com:8443/", "staging.example.com-8443"],
    ["https://example.com./", "example.com"],
    ["https://xn--bcher-kva.example/", "bücher.example"],
    ["https://bücher.example:8080/", "bücher.example-8080"],
    ["https://xn--h2brj9c.example/", "भारत.example"],
    ["https://नमस्ते.example/", "नमस्ते.example"],
    ["http://127.0.0.1:5173", "127.0.0.1-5173"],
    ["http://[::1]:8080/", "ipv6-__1-8080"],
    ["http://con/", "site-con"],
    ["http://user:secret@example.com/", "example.com"],
  ];
  for (const [url, want] of cases) assert.equal(siteFolderName(url), want, url);
  for (const bad of ["localhost:3000/", "not a url", "file:///tmp/page.html"]) assert.throws(() => siteFolderName(bad), /Pass projectPath/, bad);
});

test("the folder that holds one folder per site: the setting, off, or Documents/SceneScout", () => {
  assert.equal(projectsRoot(macHome), "/Users/u/Documents/SceneScout");
  assert.equal(projectsRoot({ ...macHome, env: { [PROJECTS_DIR_ENV]: "/srv/scenescout/" } }), "/srv/scenescout/");
  assert.equal(projectsRoot({ ...macHome, env: { [PROJECTS_DIR_ENV]: " OFF " } }), null);
  assert.equal(projectsRoot({ ...macHome, env: { [PROJECTS_DIR_ENV]: "" } }), "/Users/u/Documents/SceneScout", "empty is unset");
  assert.throws(() => projectsRoot({ ...macHome, env: { [PROJECTS_DIR_ENV]: "runs" } }), new RegExp(PROJECTS_DIR_ENV));
  assert.equal(projectsRoot({ platform: "win32", homedir: "C:\\Users\\u", env: {} }), "C:\\Users\\u\\Documents\\SceneScout");
  assert.equal(projectsRoot({ platform: "win32", homedir: "C:\\Users\\u", env: { [PROJECTS_DIR_ENV]: "D:\\qa" } }), "D:\\qa");
});

test("what wins: projectPath, then the workspace, then the per-site default", () => {
  const base = { url: "http://localhost:3000", home: macHome, exists: noRepo };
  const cases: Array<[string, Parameters<typeof chooseProjectFolder>[0], string, string]> = [
    ["projectPath over everything", { ...base, given: "/work/app", workspace: "/work/other" }, "given", "/work/app"],
    ["an empty projectPath is still given (the server's own folder, as before)", { ...base, given: "", workspace: "/work/other" }, "given", ""],
    ["the workspace over the default", { ...base, workspace: "/work/other" }, "workspace", "/work/other"],
    ["the default when there is neither", base, "default", "/Users/u/Documents/SceneScout/localhost-3000"],
    ["the setting moves the default", { ...base, home: { ...macHome, env: { [PROJECTS_DIR_ENV]: "/srv/qa" } } }, "default", "/srv/qa/localhost-3000"],
    ["projectPath over a setting of off", { ...base, given: "/work/app", home: { ...macHome, env: { [PROJECTS_DIR_ENV]: "off" } } }, "given", "/work/app"],
  ];
  for (const [name, input, source, dir] of cases) {
    const got = chooseProjectFolder(input);
    assert.ok(!("refused" in got), `${name}: ${JSON.stringify(got)}`);
    assert.deepEqual([got.source, got.dir], [source, dir], name);
    if (source === "given") assert.equal(got.note, "", `${name}: a given folder needs no line`);
    else assert.ok(got.note.includes(dir), `${name}: the result names the folder`);
  }
  const plain = chooseProjectFolder(base);
  assert.ok(!("refused" in plain) && plain.note.includes("/Users/u/Documents/SceneScout/localhost-3000/.scenescout/report.md"), "it says where the report is");
  const off = chooseProjectFolder({ ...base, home: { ...macHome, env: { [PROJECTS_DIR_ENV]: "off" } } });
  assert.ok("refused" in off && off.refused.includes("Pass projectPath"), "off, with nothing given, asks for projectPath");
  const unnamed = chooseProjectFolder({ ...base, url: "about:blank" });
  assert.ok("refused" in unnamed && unnamed.refused.includes("Pass projectPath"));
});

test("a sign-in page and the app's address resolve to one folder, so scout_login and scout_attach agree", () => {
  const folderOf = (url: string) => {
    const got = chooseProjectFolder({ url, home: macHome, exists: noRepo });
    assert.ok(!("refused" in got), url);
    return got.dir;
  };
  assert.equal(folderOf("http://localhost:3000/login?next=%2Forders"), folderOf("http://localhost:3000"));
  assert.equal(folderOf("https://staging.example.com/auth/sso"), folderOf("http://staging.example.com/"));
  // The contrast: another port is another site.
  assert.notEqual(folderOf("http://localhost:3001/login"), folderOf("http://localhost:3000"));
});

test("the default folder is never placed inside a git repository; a given one may be", () => {
  const repoAt = (root: string) => (p: string) => p === path.posix.join(root, ".git");
  // Documents itself under version control: the default is refused, naming the repository and the setting.
  const inRepo = chooseProjectFolder({ url: "http://localhost:3000", home: macHome, exists: repoAt("/Users/u/Documents") });
  assert.ok("refused" in inRepo, JSON.stringify(inRepo));
  assert.ok(inRepo.refused.includes("/Users/u/Documents") && inRepo.refused.includes(PROJECTS_DIR_ENV));
  // Home itself a repository (a dotfiles setup): the default is still accepted.
  const dotfiles = chooseProjectFolder({ url: "http://localhost:3000", home: macHome, exists: repoAt("/Users/u") });
  assert.ok(!("refused" in dotfiles) && dotfiles.dir === "/Users/u/Documents/SceneScout/localhost-3000", JSON.stringify(dotfiles));
  // A setting outside home is walked to the root, so a repository above it still refuses.
  const outside = chooseProjectFolder({ url: "http://localhost:3000", home: { ...macHome, env: { [PROJECTS_DIR_ENV]: "/srv/qa" } }, exists: repoAt("/srv") });
  assert.ok("refused" in outside);
  // The same rules on Windows paths.
  const winHome: Home = { platform: "win32", homedir: "C:\\Users\\u", env: { USERPROFILE: "C:\\Users\\u" } };
  const winRepoAt = (root: string) => (p: string) => p.toLowerCase() === path.win32.join(root, ".git").toLowerCase();
  const winRefused = chooseProjectFolder({ url: "http://localhost:3000", home: winHome, exists: winRepoAt("C:\\Users\\u\\Documents") });
  assert.ok("refused" in winRefused && winRefused.refused.includes("C:\\Users\\u\\Documents"), JSON.stringify(winRefused));
  const winDotfiles = chooseProjectFolder({ url: "http://localhost:3000", home: winHome, exists: winRepoAt("C:\\Users\\u") });
  assert.ok(!("refused" in winDotfiles) && winDotfiles.dir === "C:\\Users\\u\\Documents\\SceneScout\\localhost-3000", JSON.stringify(winDotfiles));
  const winBeside = chooseProjectFolder({ url: "http://localhost:3000", home: winHome, exists: winRepoAt("C:\\Users\\u\\code") });
  assert.ok(!("refused" in winBeside));
  const winOtherDrive = chooseProjectFolder({
    url: "http://localhost:3000",
    home: { ...winHome, env: { ...winHome.env, [PROJECTS_DIR_ENV]: "D:\\qa" } },
    exists: winRepoAt("D:\\"),
  });
  assert.ok("refused" in winOtherDrive, "a setting on another drive is walked to that drive's root");
  // The contrast: the same repository somewhere the default does not reach.
  const beside = chooseProjectFolder({ url: "http://localhost:3000", home: macHome, exists: repoAt("/Users/u/code") });
  assert.ok(!("refused" in beside) && beside.source === "default");
  // A setting pointing into a repository is refused the same way.
  const setInRepo = chooseProjectFolder({
    url: "http://localhost:3000",
    home: { ...macHome, env: { [PROJECTS_DIR_ENV]: "/work/app/qa" } },
    exists: repoAt("/work/app"),
  });
  assert.ok("refused" in setInRepo);
  // A projectPath inside a repository is the user's choice.
  const given = chooseProjectFolder({ url: "http://localhost:3000", given: "/work/app", home: macHome, exists: repoAt("/work/app") });
  assert.ok(!("refused" in given) && given.dir === "/work/app");
  assert.equal(enclosingRepo("/a/b/c", repoAt("/a"), "darwin"), "/a");
  assert.equal(enclosingRepo("/a/b/c", repoAt("/a/b/c"), "darwin"), "/a/b/c", "the folder itself");
  assert.equal(enclosingRepo("/a/b/c", noRepo, "darwin"), null);
  assert.equal(enclosingRepo("/h/d/x", repoAt("/h"), "darwin", "/h"), null, "the walk ends below stopAt");
  assert.equal(enclosingRepo("/h/d/x", repoAt("/h/d"), "darwin", "/h/"), "/h/d", "a repository strictly below stopAt still counts");
  assert.equal(
    enclosingRepo("C:\\Users\\u\\Documents\\x", (p) => p === "C:\\Users\\u\\.git", "win32", "c:\\users\\U"),
    null,
    "Windows compares without case",
  );
  assert.equal(
    enclosingRepo("C:\\Users\\u\\Documents\\SceneScout\\x", (p) => p === "C:\\Users\\u\\.git", "win32"),
    "C:\\Users\\u",
  );
});

test("a workspace comes only from a file: root, read as the platform reads it", () => {
  const cases: Array<[string, NodeJS.Platform, Array<{ uri: string }> | undefined, string | null]> = [
    ["no roots", "darwin", undefined, null],
    ["an empty list", "win32", [], null],
    ["not a file: root", "linux", [{ uri: "https://example.com/repo" }], null],
    ["the first file: root", "darwin", [{ uri: "https://example.com/repo" }, { uri: "file:///work/app" }, { uri: "file:///work/b" }], "/work/app"],
    ["an escaped space", "linux", [{ uri: "file:///work/my%20app" }], "/work/my app"],
    ["Windows: a drive letter", "win32", [{ uri: "file:///C:/work/my%20app" }], "C:\\work\\my app"],
    ["Windows: a root with no drive is skipped for the next", "win32", [{ uri: "file:///work/app" }, { uri: "file:///D:/qa" }], "D:\\qa"],
    ["Windows: a share", "win32", [{ uri: "file://server/share/app" }], "\\\\server\\share\\app"],
    ["POSIX: a root naming another host is skipped", "linux", [{ uri: "file://server/share/app" }], null],
  ];
  for (const [name, platform, roots, want] of cases) assert.equal(workspaceFromRoots(roots, platform), want, name);
});
