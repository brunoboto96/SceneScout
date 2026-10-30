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
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import "../src/engine/brief.ts";
import "../src/engine/calibration.ts";
import "../src/engine/check.ts";
import "../src/engine/ci-lanes.ts";
import "../src/engine/crawl.ts";
import { shadowColour, shadowLengths } from "../src/engine/design.ts";
import "../src/engine/expiry.ts";
import { endpointSignatures, isDuplicateFinding, sameFinding } from "../src/engine/finding-dedup.ts";
import "../src/engine/fingerprint.ts";
import "../src/engine/flow.ts";
import "../src/engine/from-run.ts";
import { statedRequests } from "../src/engine/lane.ts";
import { withoutFragment } from "../src/engine/oracles.ts";
import "../src/engine/plain.ts";
import "../src/engine/policy.ts";
import { tokenShapeOf } from "../src/engine/postmessage.ts";
import { leadsAway } from "../src/engine/scripted-login.ts";
import "../src/engine/strict-writes.ts";
import "../src/engine/tickets.ts";
import { fromJs, jsPatterns, jsToRe2 } from "../src/engine/js-regex.ts";
import { LinearRegex, SPACE } from "../src/engine/linear-regex.ts";
import { CASE_BOUND_MS, runLinearTimeCases } from "./linear-time-child.ts";
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
  loadRunRecord,
  noteFromRunOnDisk,
  readRunRecordsOnDisk,
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
  MAX_FEEDBACK_REASON,
  type DuplicateJudge,
  type Finding,
  type FindingInput,
  type JudgeVerdict,
  NAME_RULE,
} from "../src/engine/memory.ts";
import { keyAliases, keyAliasSteps } from "../src/engine/fingerprint.ts";
import { appendOwnerOnlySync, writeDocument, writeDocumentSync, writeOwnerOnly, writeOwnerOnlySync } from "../src/engine/owner-file.ts";
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
import { coverageView, generateReport, runRecordOf } from "../src/engine/report.ts";
import { maskedValue, maskFillCalls, maskSecretFieldValues, redactPersonal, secretFieldKind, type SecretFieldFacts } from "../src/engine/sensitive.ts";
import {
  PUBLISHED_CASES,
  PUBLISHED_SEED,
  RATES_BEGIN as SENSITIVE_RATES_BEGIN,
  RATES_END as SENSITIVE_RATES_END,
  ratesMarkdown as sensitiveRatesMarkdown,
  sensitiveCases,
  sensitiveRates,
} from "./sensitive-fuzz.ts";
import { maskingHandler, maskPageText, maskToolResult } from "../src/engine/redact.ts";
import { MASK_COLOR, MAX_FIELD_MASKS, masksToPaint, SECRET_BY_ATTRIBUTE } from "../src/engine/secret-pixels.ts";
import { REDACTION_VERSION } from "../src/engine/memory-scrub.ts";
import type { FromRunNote, RunRecord } from "../src/engine/from-run.ts";

/** The action log a store writes this run: the one session-*.jsonl file in its folder. */
function sessionLogOf(store: MemoryStore): string {
  const logs = fs.readdirSync(store.dir).filter((f) => /^session-.*\.jsonl$/.test(f));
  assert.equal(logs.length, 1, `one session log in ${store.dir}: ${logs.join(", ")}`);
  return path.join(store.dir, logs[0]);
}

/** One styled element for a design audit; override only what a case is about. */
function designRecord(over: Partial<StyleRecord>): StyleRecord {
  return {
    tag: "div",
    testid: null,
    text: "text",
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
  // Read through a call: addFinding changes `finding` in place, which an assertion on the field itself would hide from the type checker.
  const seenOn = (): Finding["seenOn"] => finding.seenOn;
  assert.equal(seenOn(), undefined, "one route: no field");
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
  assert.equal(seenOn()?.length, MAX_SEEN_ON);
  assert.equal(seenOn()?.at(-1), `/page-${MAX_SEEN_ON + 2}`);

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

test("a finding the person labels not a bug is kept, keeps its id and status, and a later filing of it still merges into it", async () => {
  const store = freshStore();
  const input = { ...base, title: "Saving a thing answers 500", detail: "d", evidence: "POST /api/things 500" };
  const [filed] = store.addFinding(input);
  const labelled = store.setFeedback(
    filed.id,
    "not-a-bug",
    "  The 500 is the staging copy's mail server, card 4111 1111 1111 1111, token=abc123def456ghi789  ",
  );
  assert.equal(labelled?.feedback?.verdict, "not-a-bug");
  // The reason is kept short and redacted, like any text stored on a finding.
  assert.ok(labelled?.feedback?.reason && !labelled.feedback.reason.includes("abc123def456ghi789"), labelled?.feedback?.reason);
  assert.ok(!labelled.feedback.reason.includes("4111 1111 1111 1111"), labelled.feedback.reason);
  assert.equal(store.findings.length, 1, "nothing is deleted");
  assert.equal(store.findings[0].status, undefined, "nor resolved");
  // The same problem filed again, by the rule and through the judge's path, is the labelled finding, not a new one.
  const [again, isNew] = store.addFinding({ ...input, title: "Saving a thing fails with a server error" });
  assert.equal(isNew, false);
  assert.equal(again.id, filed.id);
  const viaFile = await store.fileFinding({ ...input, detail: "seen again" });
  assert.equal(viaFile.isNew, false);
  assert.equal(viaFile.finding.id, filed.id);
  assert.equal(store.findings.length, 1);
  assert.equal(store.findings[0].feedback?.verdict, "not-a-bug", "the label survives the merge");
  // Read back from disk, the label is there.
  store.flush();
  assert.equal(openStore(path.dirname(store.dir)).findings[0].feedback?.verdict, "not-a-bug");
  // A newer label replaces it; an unknown id is null; an empty reason is left out.
  assert.deepEqual(Object.keys(store.setFeedback(filed.id, "confirmed", "   ")!.feedback!).sort(), ["at", "verdict"]);
  assert.equal(store.setFeedback("no-such-id", "not-a-bug"), null);
  assert.ok(store.setFeedback(filed.id, "not-a-bug", "x".repeat(1000))!.feedback!.reason!.length <= MAX_FEEDBACK_REASON);
});

test("merging two processes' copies of a finding keeps the newer label and the first area, whichever side was filed last", () => {
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
  const label = { verdict: "not-a-bug" as const, at: "2026-01-03T00:00:00Z" };
  // The other process re-found it later (its copy is newer) with no label: the label is not lost.
  const mine: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [{ ...finding, feedback: label, area: "forms" }] };
  const theirs: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [{ ...finding, foundAt: "2026-01-02" }] };
  for (const merged of [mergeMemory(mine, theirs), mergeMemory(theirs, mine)]) {
    assert.deepEqual(merged.findings[0].feedback, label);
    assert.equal(merged.findings[0].area, "forms");
  }
  // Two labels: the one given last wins.
  const later = { verdict: "confirmed" as const, at: "2026-01-04T00:00:00Z" };
  const both = mergeMemory(mine, { ...theirs, findings: [{ ...finding, feedback: later }] }).findings[0];
  assert.deepEqual(both.feedback, later);
  const neither = mergeMemory({ ...mine, findings: [finding] }, theirs).findings[0];
  assert.ok(!("feedback" in neither) && !("area" in neither), "neither has one: no field");
  // setArea records the first area only.
  const store = freshStore();
  const [filed] = store.addFinding({ ...base, title: "An area is kept", detail: "d" });
  assert.equal(store.setArea(filed.id, "forms")?.area, "forms");
  assert.equal(store.setArea(filed.id, "phone")?.area, "forms");
  assert.equal(store.setArea("no-such-id", "forms"), null);
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

test("a store written by an older engine has the secrets it kept in clear cleaned the first time it is opened, once, owner-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  const memDir = path.join(dir, MEMORY_DIRNAME);
  fs.mkdirSync(memDir, { recursive: true });
  // As an engine before the typed-value masking wrote them: the password and a card number in clear.
  const typed = 'type textbox "Password" ← "hunter2"';
  const card = "4111 1111 1111 1111";
  const old = {
    version: 1,
    states: {},
    findings: [
      {
        id: "f1",
        severity: "high",
        category: "http-error",
        title: `Checkout refused card ${card}`,
        detail: `Typed ${card}, then ${typed}; mailed ${["ada.lovelace", "mail.org"].join("@")}`,
        evidence: "POST /api/things 500",
        url: "http://localhost:3000/login?password=hunter2",
        state: "/login#1234567890123456",
        repro: [typed, 'type textbox "Name" ← "Ada"'],
        foundAt: "2025-01-01T00:00:00.000Z",
        runs: 1,
        verifyNote: `still shows ${card}`,
        judgedMerges: [{ title: `Refused ${card}`, category: "http-error", severity: "high", pSame: 0.9, at: "2025-01-01T00:00:00.000Z" }],
      },
    ],
    tickets: [
      {
        id: "T-1",
        title: `Pay with ${card}`,
        criteria: [{ id: "c1", text: `Given card ${card}` }],
        source: "pasted text",
        loadedAt: "2025-01-01T00:00:00.000Z",
      },
    ],
    criterionVerdicts: [{ ticket: "T-1", criterion: "c1", verdict: "fail", findings: ["f1"], confidence: 0.9, reason: `the receipt shows ${card}` }],
    // A lane's stated decisions, which a model wrote while reading the app.
    laneDecisions: [
      {
        lane: "checkout",
        observation: `The receipt prints ${card}`,
        verdict: "defect",
        severity: "high",
        category: "privacy",
        confidence: 0.9,
        evidence: `mailed to ${["ada.lovelace", "mail.org"].join("@")}`,
        at: "2025-01-01T00:00:00.000Z",
      },
    ],
  };
  fs.writeFileSync(path.join(memDir, "memory.json"), JSON.stringify(old), { mode: 0o644 });
  const oldLog = path.join(memDir, "session-2025-01-01T00-00-00-000Z.jsonl");
  const lines = [
    { at: "2025-01-01T00:00:01.000Z", action: "type", target: 'textbox "Password"', result: typed, url: "http://localhost:3000/login" },
    {
      at: "2025-01-01T00:00:02.000Z",
      action: "type",
      target: 'textbox "Name"',
      result: 'type textbox "Name" ← "Ada"',
      url: "http://localhost:3000/pay?card=1",
    },
  ];
  fs.writeFileSync(oldLog, lines.map((l) => JSON.stringify(l)).join("\n") + "\n{not json\n", { mode: 0o644 });

  const store = openStore(dir);
  store.flush();
  const onDisk = fs.readFileSync(path.join(memDir, "memory.json"), "utf8");
  const log = fs.readFileSync(oldLog, "utf8");
  for (const text of [onDisk, log]) {
    assert.ok(!text.includes("hunter2"), text);
    assert.ok(!text.includes(card), text);
    assert.ok(!text.includes("ada.lovelace"), text);
  }
  // What is not a secret stays, and so does what identifies a finding.
  const f = (JSON.parse(onDisk) as { findings: Finding[] }).findings[0];
  assert.equal(f.state, "/login#1234567890123456");
  assert.equal(f.evidence, "POST /api/things 500");
  assert.ok(f.repro[1].includes('"Ada"'), f.repro[1]);
  assert.ok(log.includes('\\"Ada\\"') && log.includes("{not json"), log);
  if (process.platform !== "win32") assert.equal(fs.statSync(oldLog).mode & 0o777, 0o600);

  // Once cleaned, the store says so, and the next open leaves the logs alone.
  assert.equal((JSON.parse(onDisk) as { redactedWith?: number }).redactedWith, REDACTION_VERSION);
  const before = fs.statSync(oldLog).mtimeMs;
  fs.writeFileSync(oldLog, fs.readFileSync(oldLog, "utf8") + JSON.stringify({ ...lines[0], at: "2025-01-02T00:00:00.000Z" }) + "\n");
  openStore(dir).flush();
  assert.ok(fs.readFileSync(oldLog, "utf8").includes("hunter2"), "a store already cleaned does not read its logs again");
  assert.ok(fs.statSync(oldLog).mtimeMs >= before);
});

test("a store cleaned by an earlier redaction is cleaned again with the redaction that now hides more, once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  const memDir = path.join(dir, MEMORY_DIRNAME);
  fs.mkdirSync(memDir, { recursive: true });
  // Kept by an engine whose redaction let a short password and a PIN through (#550), and marked as cleaned by it.
  const finding = {
    id: "f1",
    severity: "high",
    category: "privacy",
    title: "Error toast echoes the PIN 4821",
    detail: "login failed for password: hunter2",
    evidence: "POST /api/things 500",
    url: "http://localhost:3000/login",
    state: "/login#1",
    repro: ['click button "Sign in"'],
    foundAt: "2025-01-01T00:00:00.000Z",
    runs: 1,
  };
  fs.writeFileSync(path.join(memDir, "memory.json"), JSON.stringify({ version: 1, states: {}, findings: [finding], redactedWith: 1 }));
  const oldLog = path.join(memDir, "session-2025-01-01T00-00-00-000Z.jsonl");
  const line = { at: "2025-01-01T00:00:01.000Z", action: "note", target: "", result: "the toast said PIN 4821", url: "http://localhost:3000/login" };
  fs.writeFileSync(oldLog, JSON.stringify(line) + "\n");

  openStore(dir).flush();
  const onDisk = fs.readFileSync(path.join(memDir, "memory.json"), "utf8");
  for (const text of [onDisk, fs.readFileSync(oldLog, "utf8")]) {
    assert.ok(!text.includes("hunter2"), text);
    assert.ok(!text.includes("4821"), text);
  }
  assert.equal((JSON.parse(onDisk) as { redactedWith?: number }).redactedWith, REDACTION_VERSION);
  assert.ok(REDACTION_VERSION > 1, "the redaction learned to hide more, so its version is raised");
});

test("a store cleaned before a secret set after a refused one was masked is cleaned again; one cleaned since is left alone (#619)", () => {
  const leaks = ["password\t:secret ＝Abc123def456xyz", "Basic ============4111 1111 1111 1111"];
  const write = (redactedWith: number) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
    dirs.push(dir);
    const memDir = path.join(dir, MEMORY_DIRNAME);
    fs.mkdirSync(memDir, { recursive: true });
    const finding = {
      id: "f1",
      severity: "high",
      category: "privacy",
      title: "Error page echoes the request",
      detail: `the page printed ${leaks[0]}`,
      evidence: `Authorization: ${leaks[1]}`,
      url: "http://localhost:3000/login",
      state: "/login#1",
      repro: ['click button "Sign in"'],
      foundAt: "2025-01-01T00:00:00.000Z",
      runs: 1,
    };
    fs.writeFileSync(path.join(memDir, "memory.json"), JSON.stringify({ version: 1, states: {}, findings: [finding], redactedWith }));
    const log = path.join(memDir, "session-2025-01-01T00-00-00-000Z.jsonl");
    const line = { at: "2025-01-01T00:00:01.000Z", action: "note", target: "", result: leaks.join(" and "), url: "http://localhost:3000/login" };
    fs.writeFileSync(log, JSON.stringify(line) + "\n");
    openStore(dir).flush();
    return [fs.readFileSync(path.join(memDir, "memory.json"), "utf8"), fs.readFileSync(log, "utf8")];
  };
  // Marked as cleaned by redaction 2, which let both through.
  const [memory, log] = write(2);
  for (const text of [memory, log]) {
    assert.ok(!text.includes("Abc123def456xyz"), text);
    assert.ok(!text.includes("1111 1111 1111"), text);
  }
  assert.equal((JSON.parse(memory) as { redactedWith?: number }).redactedWith, REDACTION_VERSION);
  assert.ok(REDACTION_VERSION >= 3, "the redaction learned to hide more in #619, so its version is raised");
  // Marked as cleaned by this redaction: nothing is read again, so what it holds stays as written.
  const [kept] = write(REDACTION_VERSION).slice(1);
  assert.ok(kept.includes("Abc123def456xyz") && kept.includes("1111 1111 1111"), "a store this redaction already cleaned is not cleaned again");
});

test("opening a store it cannot clean leaves it as it was: a memory.json of an unknown version, a folder it may not write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  const memDir = path.join(dir, MEMORY_DIRNAME);
  fs.mkdirSync(memDir, { recursive: true });
  const future = JSON.stringify({ version: 2, findings: [{ id: "keep-me", title: "card 4111 1111 1111 1111" }] });
  fs.writeFileSync(path.join(memDir, "memory.json"), future);
  openStore(dir);
  assert.equal(fs.readFileSync(path.join(memDir, "memory.json"), "utf8"), future, "a version this engine cannot read is not replaced on open");

  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(ro);
  const roMem = path.join(ro, MEMORY_DIRNAME);
  fs.mkdirSync(roMem, { recursive: true });
  const older = JSON.stringify({ version: 1, states: {}, findings: [] });
  fs.writeFileSync(path.join(roMem, "memory.json"), older);
  fs.writeFileSync(path.join(roMem, ".gitignore"), "*\n");
  fs.chmodSync(roMem, 0o555);
  try {
    const store = new MemoryStore(ro);
    assert.match(store.lastSaveError ?? "", /could not be rewritten/);
    assert.equal(fs.readFileSync(path.join(roMem, "memory.json"), "utf8"), older);
  } finally {
    fs.chmodSync(roMem, 0o755);
  }
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
  store.visitState("/a#new", "http://x/a", "/a", ["button:search", "button:save"], [], undefined, { 2: { "button:search": "button:" } });
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
  store.visitState("/a#new", "http://x/a", "/a", ["button:search", "button:"], [], undefined, { 2: { "button:search": "button:", "button:": "button:~1" } });
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2);
  assert.deepEqual(cov.unexercised, [{ state: "/a", keys: ["button:"], total: 2 }], "the still-unnamed button was never exercised");
});

test("a state recorded under the current rule is never re-read through an alias", () => {
  // `button:` here is a button that is still unnamed now; an alias learned for the old key must not rename it.
  const store = freshStore();
  legacyState(store, "/a#old", "/a", { "button:": { exercised: true } });
  store.visitState("/a#new", "http://x/a", "/a", ["button:search"], [], undefined, { 2: { "button:search": "button:" } });
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
    2: { "button:search~1": "button:", "button:": "button:~1" },
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
  store.visitState("/a#new", "http://x/a", "/a", ["button:search"], [], undefined, { 2: { "button:search": "button:" } });
  store.visitState("/a#modal", "http://x/a?m=1", "/a", ["button:close"], [], undefined, { 2: { "button:close": "button:" } });
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

// A descendant's aria-label and an image's title name a control under rule 3; rule 2 read neither.

test("keyAliasSteps: each step between name rules lists only the controls that step renamed", () => {
  // An image button named by its alt from rule 2 on, and an icon link named by a descendant's aria-label from rule 3 on.
  const bases = [
    { byRule: ["button:", "button:search", "button:search"], tracked: true },
    { byRule: ["link:", "link:", "link:feed"], tracked: true },
    { byRule: ["link:home", "link:home", "link:home"], tracked: true },
  ];
  assert.deepEqual(keyAliasSteps(bases), { 2: { "button:search": "button:" }, 3: { "link:feed": "link:" } });
  // Nothing renamed, no step listed.
  assert.deepEqual(keyAliasSteps([{ byRule: ["link:home", "link:home", "link:home"], tracked: true }]), {});
});

test("coverage recorded under rule 2 for a control rule 3 names carries over", () => {
  const rule2 = (store: MemoryStore) => {
    store.states["/a#old"] = {
      url: "http://x/a",
      route: "/a",
      firstSeen: "2026-01-01T00:00:00.000Z",
      visits: 1,
      elements: { "link:": { exercised: true, lastAction: "click" }, "link:home": { exercised: false } },
      nameRule: 2,
    };
  };
  const store = freshStore();
  rule2(store);
  store.visitState("/a#new", "http://x/a", "/a", ["link:feed", "link:home"], [], undefined, { 3: { "link:feed": "link:" } });
  assert.equal(store.coverage().elementsTotal, 2, "the icon link once, not once per key");
  assert.equal(store.coverage().elementsExercised, 1);
  assert.deepEqual(store.coverage().unexercised, [{ state: "/a", keys: ["link:home"], total: 2 }]);

  // The contrast: with no step-3 alias the renamed link reads as new and its rule-2 key stays as a gap.
  const plain = freshStore();
  rule2(plain);
  plain.visitState("/a#new", "http://x/a", "/a", ["link:feed", "link:home"]);
  assert.equal(plain.coverage().elementsTotal, 3);

  // Reached again under the same fingerprint, the rule-2 record is moved to rule-3 keys before it is marked current.
  const same = freshStore();
  rule2(same);
  same.visitState("/a#old", "http://x/a", "/a", ["link:feed", "link:home"], [], undefined, { 3: { "link:feed": "link:" } });
  assert.equal(same.states["/a#old"].nameRule, NAME_RULE);
  assert.equal(same.states["/a#old"].elements["link:feed"]?.exercised, true);
  assert.equal(same.states["/a#old"].elements["link:"], undefined);
});

test("a rule-1 state is moved through every step, one rule at a time", () => {
  // Under rule 1 an image button and an icon link were both unnamed: button: and button:~1 (both buttons here).
  // Rule 2 names the image button, so the icon one moves to button:; rule 3 names the icon one too.
  const store = freshStore();
  legacyState(store, "/a#old", "/a", { "button:": { exercised: false }, "button:~1": { exercised: true, lastAction: "click" } });
  store.visitState("/a#new", "http://x/a", "/a", ["button:search", "button:feed"], [], undefined, {
    2: { "button:search": "button:", "button:": "button:~1" },
    3: { "button:feed": "button:" },
  });
  const cov = store.coverage();
  assert.equal(cov.elementsTotal, 2);
  assert.deepEqual(cov.unexercised, [{ state: "/a", keys: ["button:search"], total: 2 }], "the icon button keeps its click, the image button does not get it");

  // A merge with another process moves a rule-2 side through step 3 the same way, and keeps both sides' step aliases.
  const theirs = {
    version: 1 as const,
    states: { "/a#same": { url: "u", route: "/a", firstSeen: "2026-01-01", visits: 1, elements: { "link:": { exercised: true } }, nameRule: 2 } },
    findings: [],
  };
  const mine = {
    version: 1 as const,
    states: { "/a#same": { url: "u", route: "/a", firstSeen: "2026-01-02", visits: 1, elements: { "link:feed": { exercised: false } }, nameRule: NAME_RULE } },
    findings: [],
    ruleKeyAliases: { "3": { "/a": { "link:": "link:feed" } } },
  };
  const merged = mergeMemory(mine, { ...theirs, ruleKeyAliases: { "3": { "/b": { "button:": "button:close" } } } });
  assert.equal(merged.states["/a#same"].elements["link:feed"].exercised, true);
  assert.equal(merged.states["/a#same"].elements["link:"], undefined);
  assert.deepEqual(merged.ruleKeyAliases, { "3": { "/a": { "link:": "link:feed" }, "/b": { "button:": "button:close" } } });
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
  // The inputs a team commits are let through: saved flows, and the config that sets what SceneScout may do.
  for (const keep of ["!flows/", "!flows/*.json", "!config.json"]) assert.ok(body.split("\n").includes(keep), `${keep} is not ignored`);
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

/** Every string literal in the suites that exercise the converted readers, the texts below and generated ones: the inputs the identity checks compare on. */
let corpus: Set<string> | null = null;
function identityCorpus(): Set<string> {
  if (corpus) return corpus;
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const strings = new Set<string>();
  for (const file of [
    "policy-test.ts",
    "tickets-test.ts",
    "calibration-test.ts",
    "contract-test.ts",
    "memory-test.ts",
    "lane-test.ts",
    "check-test.ts",
    "ci-test.ts",
    "brief-test.ts",
    "profiles-test.ts",
    "oracle-test.ts",
    "scripted-login-test.ts",
    "design-test.ts",
    "guided-test.ts",
  ]) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(scripts, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.length < 400) strings.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const pieces = [
    "delete",
    "Remove",
    " filter",
    "chips",
    "-",
    " ",
    "reset ",
    "Discard ",
    "changes",
    "\n",
    "\t",
    "a",
    "B",
    "/",
    "1",
    "42",
    ",",
    ":",
    "*",
    "{id}",
    ":id",
    "}",
    "_",
    ".",
    "?",
    "#",
    "=",
    "&",
    "token",
    "sign off",
    "Sign-off",
    "and ",
    "AC1",
    "Given x",
    "Scenario: s",
    "- [x] y",
    "**",
    "## H",
    "\u00a0",
    "ſ",
    "K",
    "😀",
    "ö",
    "löschen",
    "удалить",
    "删除",
    "mutation",
    "{",
    "(",
    ")",
    "[",
    "]",
    '"',
    "'",
    "`",
    "<",
    "https://h:80/a.html",
    "127.0.0.1:80/x",
    "testid=a-b-c",
    "3.1:1",
    "PROJ-12",
    "#7",
    "|",
    "→",
    "->",
    "\r\n",
    "\u2028",
    "\u0001",
    "POST /x",
    "_method=DELETE",
    "index.html",
    ".pdf",
    "format=csv",
    "```",
    "```json\n",
    "&amp;",
    "&#x41;",
    "&#65;",
    "GET /api/x 404",
    "POST https://h/a/ -> 500",
    "[session a] ",
    "Nothing to crawl",
    "PROBLEM ROUTES (2):",
    " — 200 · 3 el",
    "/a → x",
    "/b: why",
    "continue with",
    "Continue With",
    " your ",
    " work ",
    " e-mail",
    " phone",
    " sms-code",
    " code",
    "try again",
    "didn’t",
    "eyJabcdefghijk",
    "Bearer ",
    "access_token=",
    "abcdefghij0123456789",
    "data.auth",
    "[0]",
    "deleteUser",
    "HTTPServer",
    "AAa",
    "{",
    "action:",
    "a=1&",
    "es",
    "ies",
    "entries",
    "(quoted words here)",
    '"quoted words here"',
    "#frag",
    "0123456789ab",
    "Download is starting",
    "😀😀😀😀",
    " = ",
    " ← ",
    "px",
    "-2.5px",
    "rgb(",
    "rgba(0, 0, 0, 0)",
    "\r",
  ];
  // Whole texts for the lookarounds written in code, each beside its near misses: "continue with" and what may follow it
  // (#618), a plural after three letters of a word, an id segment of twelve characters with a digit.
  for (const text of [
    "Continue with phone",
    "continue with your email",
    "Continue with work e-mail",
    "continue with an sms-code",
    "continue with a code",
    "continue with my x-y code",
    "continue with x-y  code",
    "continue with -continue with code",
    "Continue with Google",
    "Continue with WORK EMAIL",
    "continue with wor\u212a email",
    "continue with  email",
    "continue with personal phonebook",
    "continue withemail",
    "continue with codes",
    "continue with",
    "a/es",
    "abces",
    "ab_s",
    "a1bes",
    "abcdefghijk1",
    "abcdefghij1",
    "abcdefghijkl",
    "12",
    "ab12",
    // A surrogate pair is two characters to JavaScript without the u flag: eight of a count, four emoji.
    '"🎉 Done!"',
    '"😀😀😀😀"',
    `"${"😀".repeat(41)}"`,
    `access_token=${"😀".repeat(8)}`,
  ])
    strings.add(text);
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < 6000; n++) {
    let text = "";
    for (let k = 1 + Math.floor(next() * 9); k > 0; k--) text += pieces[Math.floor(next() * pieces.length)];
    strings.add(text);
  }
  corpus = strings;
  return strings;
}

test("every pattern in the route, ticket, calibration and write-policy readers matches what JavaScript's engine did (#618)", () => {
  // Each of these patterns was a JavaScript regular expression and now runs on the linear-time engine. fromJs keeps the
  // JavaScript source it stands for (a lookaround is kept as written), so each is held to a RegExp of that source: the
  // same first match, index and groups, on every string in the suites that exercise them and on generated ones.
  const strings = identityCorpus();
  assert.ok(jsPatterns.length >= 170, `the patterns are registered: ${jsPatterns.length}`);
  for (const { source, flags, pattern } of jsPatterns) {
    const js = new RegExp(source, flags);
    for (const text of strings) {
      // With both i and u, JavaScript's \b reads the long s and the Kelvin sign as letters of a word; RE2's does not (ADR 28, 29).
      if (flags.includes("u") && /[\u017f\u212a]/.test(text)) continue;
      const a = js.exec(text);
      const b = pattern.exec(text);
      // A rewrite of a lookahead may hold groups of its own after the pattern's; the pattern's are compared.
      const mine = a === null ? null : [a.index, a[0], ...a.slice(1).map((g) => g ?? null)];
      const yours = b === null ? null : [b.index, b.text, ...b.groups.slice(1, a === null ? undefined : a.length).map((g) => g ?? null)];
      assert.deepEqual(yours, mine, `${source} ${flags} on ${JSON.stringify(text)}`);
    }
  }
});

test("statedRequests reads what its JavaScript pattern read: the head on the linear-time engine, the rest in code (#618)", () => {
  // The pattern statedRequests ran before #618, and the function around it, as they were: the reference this one is held to.
  const STATED_REQUEST_RE =
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/[A-Za-z0-9/_.:{}$*~%-]*)(?:\?[^\s#]*)?(?:#\S*)?(?:(?:\s*(?:->|→|=>|:)\s*|\s+)([1-5]\d{2})\b)?/gi;
  const reference = (text: string) =>
    [...text.matchAll(STATED_REQUEST_RE)].map((m) => {
      const raw = m[2].replace(/[.:,]+$/, "");
      const start = (m.index ?? 0) + m[0].indexOf(m[2]);
      return { method: m[1].toUpperCase(), segments: segmentsOf(raw), status: m[3] ?? null, start, end: start + raw.length };
    });
  const segmentsOf = (p: string): string[] => {
    const trimmed = p.replace(/\/+$/, "");
    if (trimmed === "") return [];
    return trimmed
      .slice(1)
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg).toLowerCase();
        } catch {
          return seg.toLowerCase();
        }
      });
  };
  const texts = [
    ...identityCorpus(),
    "GET /a 404",
    "GET /a:404",
    "GET /a : 404",
    "GET /a -> 4045",
    "GET /a ->  404x",
    "GET /a  404 POST /b→201",
    "GET http://h/ 500",
    "get https://h:80/x/y?q=1#f => 302",
    "GET /a?x#y 200",
    "GET /a?x y 200",
    "GET http://h",
    "DELETE  /a/{id}/b. then",
    "GET /a\u00a0404",
    "GET /a\u2028-> 404",
    "xGET /a 404",
    "GET /a/./,: 404",
  ];
  for (const text of texts) {
    assert.deepEqual(statedRequests(text), reference(text), JSON.stringify(text));
  }
});

test('leadsAway reads what its JavaScript pattern read, "continue with" and its lookahead included (#618)', () => {
  const AWAY_WORDS =
    /\b(forgot|reset|sign[\s-]?up|register|create|continue with(?! (your |my |a |an |work |personal )?(e-?mail|phone|([\w-]+ )?code))|provider|google|microsoft|github|apple|facebook|sso|single sign|passkey|magic link|cancel|back|re-?send|remember|new code|another|(send|try)\b.*\bagain|different|change|edit|instead|didn['’]?t|did not|not you)\b/i;
  for (const text of identityCorpus()) assert.equal(leadsAway(text), AWAY_WORDS.test(text), JSON.stringify(text));
});

test("withoutFragment drops what its JavaScript pattern dropped: from the first # after the last line end (#618)", () => {
  for (const text of [
    ...identityCorpus(),
    "http://h/a#b",
    "http://h/a#b#c",
    "a#b\nc",
    "a#b\nc#d",
    "a#b\u2028c#d",
    "a#b\u2029c#d",
    "a\u2028#b\u2029",
    "a#\r",
    "#",
    "",
  ])
    assert.equal(withoutFragment(text), text.replace(/#.*$/, ""), JSON.stringify(text));
});

test("a shadow layer's lengths and colour are what their JavaScript patterns found (#618)", () => {
  const texts = [
    ...identityCorpus(),
    "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px",
    "rgb(229, 231, 235) 0px 0px 0px 1px inset",
    "-1.5px --2px -.px 1..2px 3 px 4pxpx",
    "rgbargb(1) rgba(2)",
    "rgba rgb(",
    "rgb(1 rgba(2) rgb(3)",
    "1.2.3",
    "-",
  ];
  for (const text of texts) {
    assert.deepEqual(shadowLengths(text), text.match(/-?[0-9.]+px/g) ?? [], JSON.stringify(text));
    assert.equal(shadowColour(text), text.match(/rgba?\([^)]*\)/)?.[0] ?? null, JSON.stringify(text));
  }
});

test("fromJs reads a JavaScript pattern the way JavaScript does, and refuses what RE2 cannot run (#618)", () => {
  // Ranges, escapes and sets inside a class; \s and . as JavaScript has them; the i flag as JavaScript folds it.
  const same = (source: string, flags: string, texts: string[]): void => {
    const js = new RegExp(source, flags);
    const re = fromJs(source, flags);
    for (const text of texts) assert.equal(re.test(text), js.test(text), `${source} ${flags} on ${JSON.stringify(text)}`);
  };
  same(String.raw`[\u0000-\u0008\u007f]`, "", ["a", "\u0001", "\u007f", "\u0009"]);
  same(String.raw`^[a-f]+[^\d]$`, "i", ["ABCx", "abc1", "ABCF", "g"]);
  same(String.raw`a.b`, "", ["a\nb", "a\u2028b", "a\u00a0b", "axb"]);
  same(String.raw`a\sb`, "", ["a\u00a0b", "a\u3000b", "a\ufeffb", "a_b"]);
  same(String.raw`[\s\S]+x`, "", ["\n\nx", "x"]);
  same(String.raw`[\w-]+@`, "", ["a-b@", "-@", "@"]);
  same(String.raw`s`, "i", ["S", "s", "ſ"]);
  same(String.raw`k`, "i", ["K", "k", "\u212a"]);
  same(String.raw`[k]`, "i", ["K", "\u212a"]);
  same(String.raw`ö`, "i", ["Ö", "ö", "o"]);
  same(String.raw`[\w.-]+`, "", ["", "-", "a.b"]);
  // A letter written as an escape folds as the letter does; an escaped mark stands for itself.
  same(String.raw`\x41\u00e9`, "i", ["aÉ", "Aé", "ae"]);
  same(String.raw`[\x41-\x43]+$`, "i", ["abc", "ABC", "abd"]);
  same(String.raw`[\u00e0]`, "i", ["À", "à", "a"]);
  same(String.raw`\.[.\]]`, "i", [".]", "..", "a]"]);
  same(String.raw`[à-þ]`, "", ["à", "À"]);
  same(String.raw`[0-z]`, "i", ["A", "a", "~"]);
  // Every character of the same canonical form, not only a letter's own two cases.
  same(String.raw`µ[σ]`, "i", ["μΣ", "Μς", "µσ", "mσ"]);
  // The folding of a letter RE2 would fold further is only what JavaScript folds.
  assert.equal(jsToRe2("s", "i"), "[sS]");
  for (const source of ["a(?=b)", "(?<=a)b", "(?!a)b", "(a)\\1", "[\\S\\d]", "[\\b]", "(?<n>a)", "\\k<n>", "[]", "[a"]) {
    assert.throws(() => fromJs(source), /written by hand/, source);
  }
  // What RE2 would read otherwise than JavaScript is refused too: an escaped letter JavaScript reads as itself (RE2: a
  // bell, an end, a start, a quote), \p without the u flag (JavaScript: the letter p), a range i folds past its ends.
  for (const source of ["\\a", "x\\z", "\\Ax", "\\Qa", "[\\a]", "\\p{L}", "[\\P{L}]"]) {
    assert.throws(() => fromJs(source), /written by hand/, source);
  }
  assert.throws(() => fromJs("[à-þ]", "i"), /folds past its ends/);
  assert.throws(() => fromJs("[\\n-Z]", "i"), /folds past its ends/);
  assert.throws(() => fromJs("a", "g"), /i flag only/);
});

test("a pattern read from JavaScript counts a surrogate pair as two characters, as JavaScript did (#618)", () => {
  // Without the u flag JavaScript reads UTF-16 code units, so `[^"]{8,80}` takes four emoji and refuses 41; RE2 reads
  // code points and, alone, would refuse the four and take the 41. Each pair differs in the one count that flips it.
  const quoted = fromJs(String.raw`"([^"]{8,80})"`);
  for (const text of [
    '"🎉 Done!"',
    '"😀😀😀😀"',
    '"😀😀😀"',
    `"${"😀".repeat(40)}"`,
    `"${"😀".repeat(41)}"`,
    '"\ud800\ud800\ud800\ud800"',
    '"ab\udc00cdefgh"',
  ]) {
    const js = /"([^"]{8,80})"/.exec(text);
    const mine = quoted.exec(text);
    assert.deepEqual(mine && [mine.index, mine.text, mine.groups[1]], js && [js.index, js[0], js[1]], JSON.stringify(text));
  }
  // A lone surrogate after a pair, and a group read back from the text as given.
  const run = fromJs(String.raw`(.{3})$`);
  assert.equal(run.exec("ab😀\udc00")?.groups[1], "😀\udc00".slice(-3));
  // What the readers make of it: a quoted literal of four emoji and a token of eight are what they were.
  const toast = { category: "ux-confusing", detail: "", state: "/a" };
  assert.ok(
    sameFinding({ ...toast, title: 'Toast "🎉 Done!" shows twice', evidence: "first" }, { ...toast, title: 'Banner keeps "🎉 Done!"', evidence: "second" }),
  );
  assert.deepEqual(tokenShapeOf("data.url", `?access_token=${"😀".repeat(8)}`), { shape: "url-param", secret: "😀".repeat(8) });
  assert.equal(tokenShapeOf("data.url", `?access_token=${"😀".repeat(7)}a`), null);
  // A pattern that names a surrogate, or the private-use characters standing in for them, is written by hand.
  for (const source of ["\\ud83d", "😀", "[\\ue000]", "[\\u0000-\\udbff]", "[^\\ue700-\\uf8ff]x"]) {
    assert.throws(() => fromJs(source), /written by hand/, source);
  }
  // A range over all of them, or none, reads them alike, as JavaScript reads the surrogates and private use alike.
  for (const source of ["[\\u0000-\\uffff]", "[^\\uf000-\\uffff]", "[\\u0000-\\ud7ff\\ue800-\\uffff]"]) assert.doesNotThrow(() => fromJs(source), source);
});

test("finding dedup reads each title and evidence once, not once a pair, and hands back its own copies (#618)", () => {
  // The store compares every finding with every other as it loads. On the linear-time engine a pair cost about four
  // times what it did on JavaScript's; read once a text, 300 findings compared pairwise take well under a second.
  const words = ["Save", "button", "does", "nothing", "when", "the", "form", "entries", "displays", "error", "after", "submit"];
  const findings = Array.from({ length: 300 }, (_, i) => ({
    id: `f${i}`,
    status: "open" as const,
    category: ["functional", "ux-confusing", "console-error"][i % 3],
    state: `/orders#${i % 7}`,
    title: Array.from({ length: 9 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ") + ` ${i}`,
    evidence: `POST /api/orders/${i % 13}/items ${i % 2 ? 404 : 500}: "${words[i % words.length]} failed here" then ${"the form shows an error ".repeat(6)}`,
  }));
  const started = performance.now();
  for (const a of findings) for (const b of findings) isDuplicateFinding(a, b);
  const ms = performance.now() - started;
  assert.ok(ms < 5000, `90,000 pairs in ${Math.round(ms)} ms`);
  // What a reader kept is not what a caller is given: a change to one result leaves the next as it was.
  const first = endpointSignatures(findings[0].evidence);
  first.clear();
  assert.deepEqual([...endpointSignatures(findings[0].evidence)], ["POST /api/orders/:id/items 500"]);
});

test("a rejected name=value match does not hide the next secret's name (#619)", () => {
  // "secret" after the colon is a word about the field, so the first match is refused; the scan resumes right
  // after the first name, finds "secret ＝…" and masks its value. Each pair differs in the one fact that flips it.
  const hidden = redactSecrets("password\t:secret ＝Abc123def456xyz");
  assert.ok(!hidden.includes("Abc123def456xyz"), `the second secret's value is masked: ${hidden}`);
  assert.ok(hidden.includes("password\t:secret ＝[redacted]"), `and both names are kept: ${hidden}`);
  assert.ok(!redactSecrets("password: token = Abc123def456xyz").includes("Abc123def456xyz"));
  assert.ok(!redactSecrets("token: password;token=Abc123def456xyz").includes("Abc123def456xyz"));
  // The same words with no value after the second name have nothing to hide and stay as written.
  assert.equal(redactSecrets("password\t:secret ＝required"), "password\t:secret ＝required");
  assert.equal(redactSecrets("Password: required. Token: missing after refresh"), "Password: required. Token: missing after refresh");
});

test("a Basic or Bearer token does not stop inside a card number (#619)", () => {
  // The token run "============4111" holds the card's first group; read to its end it would leave 12 digits in clear.
  for (const scheme of ["Basic", "Bearer"]) {
    const cut = redactSecrets(`${scheme} ============4111 1111 1111 1111`);
    assert.ok(!/1111/.test(cut), `no group of the card is left: ${cut}`);
    assert.ok(cut.includes(`${scheme} [redacted]`), `the token is masked: ${cut}`);
    const dashed = redactSecrets(`${scheme} ============5500-0000-0000-0004`);
    assert.ok(!/0000/.test(dashed), `${dashed}`);
  }
  // Not a card (the groups fail the Luhn check), so the token ends where its run does and the rest stays.
  assert.equal(redactSecrets("Basic ============4111 1111 1111 1112"), "Basic [redacted] 1111 1111 1112 [1 secret redacted]");
  // A token followed by a digit group that is not part of any card number is cut where its run ends.
  assert.equal(redactSecrets("Bearer abcdefgh12345678 42 items"), "Bearer [redacted] 42 items [1 secret redacted]");
});

test("every redaction pattern reads a crafted 1 MB text in linear time (#610)", async () => {
  // Each text is shaped to make one pattern backtrack. On JavaScript's engine six of them did not finish in a
  // minute: the name=value rule's spaces and its full stops, a long parameter name or field label, and a field
  // name of capitals or of digits. On the linear-time engine each takes about a second or less.
  const { done, stoppedIn } = await runLinearTimeCases("redaction");
  assert.equal(stoppedIn, null, `still running after ${CASE_BOUND_MS} ms: ${stoppedIn}`);
  assert.ok(done.length > 0);
  for (const { name, ms } of done) assert.ok(ms < CASE_BOUND_MS, `${name}: ${ms} ms`);
});

/**
 * Where these files build a JavaScript regular expression: a literal, `RegExp`, or a string's `match`, `matchAll` or
 * `search`, which turn a string argument into one: read with the type checker, by the method a call resolves to, as
 * the linear-time engine has a `matchAll` of its own and a receiver may be `string | undefined`.
 */
function javaScriptRegexUses(files: readonly string[]): string[] {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    // Node's types, for the files that read the file system or hash: without them an import is typed any and a call on it goes unseen.
    types: ["node"],
  });
  // An import the checker cannot resolve is typed any, and a call on it would go unseen.
  const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  if (errors.length > 0) throw new Error(`the type checker could not read these files: ${errors.join("; ")}`);
  const checker = program.getTypeChecker();
  const stringMethod = (call: ts.CallExpression): boolean => {
    const parent = checker.getResolvedSignature(call)?.declaration?.parent;
    return parent !== undefined && ts.isInterfaceDeclaration(parent) && parent.name.text === "String" && parent.getSourceFile().hasNoDefaultLib;
  };
  const found: string[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`the type checker did not read ${file}`);
    const visit = (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(`${path.basename(file)}: ${node.getText()}`);
      if (ts.isIdentifier(node) && node.text === "RegExp") found.push(`${path.basename(file)}: RegExp`);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["match", "matchAll", "search"].includes(node.expression.name.text) &&
        stringMethod(node)
      )
        found.push(`${path.basename(file)}: ${node.getText()}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test("redaction, the field checks, the credential check and the ticket, calibration, route and write-policy readers hold no JavaScript regular expression (#610, #618)", () => {
  // They read text the app controls; a pattern written for JavaScript's backtracking engine would bring back the
  // time a crafted text can cost. The linear-time engine is linear-regex.ts.
  const engine = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine");
  const files = [
    "redact.ts",
    "sensitive.ts",
    "credential.ts",
    "linear-regex.ts",
    "js-regex.ts",
    "fingerprint.ts",
    "calibration.ts",
    "tickets.ts",
    "policy.ts",
    "crawl.ts",
    "expiry.ts",
    "brief.ts",
    "ci-lanes.ts",
    "lane.ts",
    "finding-dedup.ts",
    "postmessage.ts",
    "strict-writes.ts",
  ].map((file) => path.join(engine, file));
  assert.deepEqual(javaScriptRegexUses(files), [], "these files use JavaScript's engine");
  // A string's match, matchAll and search turn a string argument into a JavaScript regular expression, with no
  // literal and no RegExp in sight; split and replace with a string do not. The pair differs only in that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-regex-guard-"));
  try {
    const implicit = path.join(dir, "implicit.ts");
    const literal = path.join(dir, "literal.ts");
    // matchAll takes a string at run time; the lib types it as RegExp only, hence the cast.
    fs.writeFileSync(
      implicit,
      'export const a = (t: string, u?: string, v?: "x" | "y") => [t.match("a+"), [...t.matchAll("b+" as never)], t.search("c+"), u?.match("d+"), v?.search("e+")];\n',
    );
    fs.writeFileSync(literal, 'export const a = (t: string) => [t.split("a+"), t.replace("b+", ""), t.replaceAll("c+", "")];\n');
    assert.equal(javaScriptRegexUses([implicit]).length, 5, "a string's match, matchAll and search are found, on an optional string too");
    assert.deepEqual(javaScriptRegexUses([literal]), [], "a string's split and replace with a string are not");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every ticket, route, calibration and write-policy pattern reads a crafted 1 MB text in linear time (#618)", async () => {
  // Each text is shaped to make one pattern's JavaScript form backtrack. Four of them (a heading of colons, a route of
  // slashes, a route of quotes and a route of hyphenated words) took 0.6 s at 20 KB and 2.6 s at 40 KB on JavaScript's engine,
  // which is minutes to hours at 1 MB; on the linear-time engine each takes under a second.
  const { done, stoppedIn } = await runLinearTimeCases("patterns");
  assert.equal(stoppedIn, null, `still running after ${CASE_BOUND_MS} ms: ${stoppedIn}`);
  assert.ok(done.length >= 30, `every case ran: ${done.length}`);
  for (const { name, ms } of done) assert.ok(ms < CASE_BOUND_MS, `${name}: ${ms} ms`);
});

test("the linear-time engine gives back what JavaScript's would: lookbehinds, lookaheads, \\s, surrogate pairs (#610)", () => {
  // A lookbehind of one class: the match starts after the character before, never inside the previous match.
  const word = new LinearRegex("ab", { notAfter: String.raw`\p{L}` });
  assert.deepEqual(
    [...word.matchAll("ab xab ab")].map((m) => m.index),
    [0, 7],
  );
  assert.deepEqual(
    [...word.matchAll("abab")].map((m) => m.index),
    [0],
    "the second ab is after a letter the first match holds",
  );
  assert.deepEqual(
    [...word.matchAll("𝐀ab ab")].map((m) => m.index),
    [5],
    "a letter outside the BMP is one character before",
  );
  // A lookahead as the last group: read, and left out of the match.
  const ahead = new LinearRegex("pw($|[^a-z])", { lookahead: true });
  assert.deepEqual(
    [...ahead.matchAll("pw pwd pw")].map((m) => [m.index, m.end]),
    [
      [0, 2],
      [7, 9],
    ],
  );
  // JavaScript's \s holds the no-break space and the line separator; RE2's \s does not.
  assert.equal(new LinearRegex(`a[${SPACE}]b`).test("a\u00a0b"), true);
  assert.equal(new LinearRegex(`a[${SPACE}]b`).test("a\u2028b"), true);
  assert.equal(new LinearRegex(`a[${SPACE}]b`).test("a_b"), false);
  // A refused candidate is tried again from the next character, as a backtracking engine would.
  const evenRun = new LinearRegex("[0-9]+", { accept: ({ text }) => text.length % 2 === 0 });
  assert.deepEqual(
    [...evenRun.matchAll("123")].map((m) => m.text),
    ["23"],
  );
  // split keeps the captured separators, as String.prototype.split does.
  assert.deepEqual(new LinearRegex("(-)").split("a-b"), "a-b".split(/(-)/));
  assert.deepEqual(new LinearRegex(`[${SPACE}]+`).split(""), "".split(/\s+/));
  // needs: text with none of them is not read; each must be lower case and fold as its lower case does.
  assert.equal(new LinearRegex("Bearer x", { ignoreCase: true, needs: ["bearer"] }).test("BEARER X"), true);
  assert.throws(() => new LinearRegex("x", { needs: ["Bearer"] }), /lower case/);
  assert.throws(() => new LinearRegex("x", { needs: ["пароль"] }), /lower case/);
});

test("typed text and URLs are redacted at the log, not just on findings", () => {
  // repro traces are built from the action log, so redacting only the finding
  // fields left the same secrets flowing by a parallel route.
  const store = freshStore();
  store.logAction({ action: "type", target: 'password "sk-live-AAAABBBBCCCCDDDD"', url: "http://x/cb?token=abcdef123456789012" });
  const line = fs.readFileSync(sessionLogOf(store), "utf8");
  assert.ok(!line.includes("AAAABBBBCCCCDDDD"), "the typed secret never reaches the log");
  assert.ok(!line.includes("abcdef123456789012"), "nor does a token in the URL");
});

// ---------------------------------------------------------------------------
// Secret fields and personal data (sensitive.ts)
// ---------------------------------------------------------------------------

test("a field is secret by its type, its autocomplete token, or a name, id, label or placeholder that says so", () => {
  const secret: Array<[SecretFieldFacts, string]> = [
    [{ type: "password" }, "password"],
    [{ type: "PASSWORD", label: "Anything" }, "password"],
    [{ autocomplete: "current-password" }, "password"],
    [{ autocomplete: "section-login new-password" }, "password"],
    [{ autocomplete: "one-time-code" }, "one-time code"],
    [{ autocomplete: "cc-number" }, "card"],
    [{ autocomplete: "billing cc-csc" }, "card"],
    [{ autocomplete: "cc-exp" }, "card"],
    [{ autocomplete: "cc-exp-month" }, "card"],
    [{ name: "user_password" }, "password"],
    [{ name: "newPassword" }, "password"],
    [{ name: "userpassword" }, "password"],
    [{ name: "password2" }, "password"],
    [{ id: "loginPwd" }, "password"],
    [{ label: "Passphrase" }, "password"],
    [{ label: "Passcode" }, "one-time code"],
    [{ label: "Enter your PIN" }, "one-time code"],
    [{ name: "otpCode" }, "one-time code"],
    [{ placeholder: "One-time code" }, "one-time code"],
    [{ label: "Verification code" }, "one-time code"],
    [{ label: "CVC" }, "card"],
    [{ name: "cvv2" }, "card"],
    [{ label: "Security code" }, "card"],
    [{ label: "Card number" }, "card"],
    [{ name: "cardNumber" }, "card"],
    [{ label: "Client secret" }, "secret"],
    [{ label: "API token" }, "secret"],
    [{ name: "api_key" }, "secret"],
    [{ name: "otpcode" }, "one-time code"],
    [{ name: "pass_code" }, "one-time code"],
    [{ name: "userpasscode" }, "one-time code"],
    [{ name: "cc-num" }, "card"],
    [{ label: "CCV" }, "card"],
    [{ label: "Card no." }, "card"],
    [{ label: "Credit card" }, "card"],
    [{ label: "2FA code" }, "one-time code"],
    [{ name: "mfaCode" }, "one-time code"],
    [{ label: "Authenticator code" }, "one-time code"],
    [{ label: "Two-factor code" }, "one-time code"],
    [{ label: "Recovery code" }, "secret"],
    [{ label: "Backup code" }, "secret"],
    [{ label: "Private key" }, "secret"],
    [{ label: "Seed phrase" }, "secret"],
    [{ label: "Security answer" }, "secret"],
    // A code split into one box per character: no box is named for what it holds.
    [{ type: "text", maxLength: 1, label: "Digit 1" }, "one-time code"],
    [{ type: "tel", maxLength: 1 }, "one-time code"],
    [{ maxLength: 1 }, "one-time code"],
  ];
  for (const [facts, kind] of secret) assert.equal(secretFieldKind(facts), kind, JSON.stringify(facts));
  const ordinary: SecretFieldFacts[] = [
    {},
    { type: "text", label: "Search" },
    { type: "email", autocomplete: "email", label: "Email" },
    { autocomplete: "cc-name", label: "Name on card" },
    { autocomplete: "off", label: "Comment" },
    { label: "Spinner speed" },
    { label: "Tokenizer docs" },
    { label: "Max tokens" },
    { label: "Pinned note" },
    { name: "shipping" },
    { label: "Secretary's name" },
    { label: "Passwordless sign-in email" },
    { label: "Options" },
    { label: "Order number" },
    { placeholder: "Card holder" },
    // Near misses of the words above.
    { name: "otpout" },
    { label: "Pass count" },
    { label: "Codepass level" },
    { name: "ccnumbers" },
    { label: "CCVs saved" },
    { label: "Card notes" },
    { label: "Card nominee" },
    { type: "text", maxLength: 2, label: "State" },
    { type: "email", maxLength: 1 },
    { type: "text", maxLength: 6, label: "Postal code" },
    { label: "Fan speed" },
  ];
  for (const facts of ordinary) assert.equal(secretFieldKind(facts), null, JSON.stringify(facts));
});

test("a field labelled for a secret in another language is secret too; near misses in the same languages are not", () => {
  // After a show-password toggle the field is type=text, so its label is all that says it holds a secret.
  const secret: Array<[string, string]> = [
    // German
    ["Passwort", "password"],
    ["Kennwort", "password"],
    ["Neues Passwort", "password"],
    ["Benutzerpasswort", "password"],
    ["Passwortbestätigung", "password"],
    ["PIN-Code", "one-time code"],
    ["Geheimzahl", "one-time code"],
    ["Bestätigungscode", "one-time code"],
    ["Einmalcode", "one-time code"],
    ["Kartennummer", "card"],
    ["Kreditkartennummer", "card"],
    ["Prüfnummer", "card"],
    // French
    ["Mot de passe", "password"],
    ["Confirmer le mot de passe", "password"],
    ["Code de vérification", "one-time code"],
    ["Code à usage unique", "one-time code"],
    ["Numéro de carte", "card"],
    ["Cryptogramme visuel", "card"],
    // Spanish
    ["Contraseña", "password"],
    ["Código de verificación", "one-time code"],
    ["Código de un solo uso", "one-time code"],
    ["Número de tarjeta", "card"],
    ["Código de seguridad", "card"],
    // Portuguese
    ["Senha", "password"],
    ["Palavra-passe", "password"],
    ["Código de verificação", "one-time code"],
    ["Número do cartão", "card"],
    ["Código de segurança", "card"],
    // Italian
    ["Codice di verifica", "one-time code"],
    ["Numero della carta", "card"],
    ["Codice di sicurezza", "card"],
    // Dutch
    ["Wachtwoord", "password"],
    ["Verificatiecode", "one-time code"],
    ["Kaartnummer", "card"],
    // Polish, Czech
    ["Hasło", "password"],
    ["Heslo", "password"],
    ["Kod weryfikacyjny", "one-time code"],
    ["Numer karty", "card"],
    // Swedish, Danish, Norwegian, Finnish
    ["Lösenord", "password"],
    ["Adgangskode", "password"],
    ["Passord", "password"],
    ["Salasana", "password"],
    ["Engångskod", "one-time code"],
    ["Kortnummer", "card"],
    // A card's security code, as each language names it.
    ["Sicherheitscode", "card"],
    ["Beveiligingscode", "card"],
    ["Säkerhetskod", "card"],
    ["Sikkerhetskode", "card"],
    ["Sikkerhedskode", "card"],
    // The same words typed without their accents, as a field's name or id usually is.
    ["haslo", "password"],
    ["contrasena", "password"],
    ["losenord", "password"],
    ["passwortBestaetigung", "password"],
    ["bestaetigungscode", "one-time code"],
    ["numero_de_tarjeta", "card"],
    // An accent written as a letter and a combining mark reads the same as one written as one letter.
    ["Contrasen\u0303a", "password"],
  ];
  for (const [label, kind] of secret) assert.equal(secretFieldKind({ type: "text", label }), kind, label);
  // Each near miss shares a word or a stem with a label above and names nothing secret.
  for (const label of [
    "Palavra-chave",
    "Passagier",
    "Passe-partout",
    "Mot clé",
    "Kennung",
    "Kennzeichen",
    "Kartenart",
    "Kartenzahlung",
    "Numéro de commande",
    "Número de pedido",
    "Número de teléfono",
    "Código postal",
    "Código de descuento",
    "Codice fiscale",
    "Gutscheincode",
    "Code promo",
    "Bestätigung",
    "Parola",
    "Senhorio",
    "Kortnummerets type",
  ])
    assert.equal(secretFieldKind({ type: "text", label }), null, label);
});

test("a picture paints over every field the typed-value rule calls secret, and over every field of a frame it could not read", () => {
  // One frame read field by field, in the order the page lists them; a second frame that could not be read.
  const fields: SecretFieldFacts[] = [
    { type: "password", label: "Account phrase" },
    // The same field after a show-password toggle: only its label says it is a password.
    { type: "text", label: ["Password"] },
    { type: "text", label: "Account phrase (shown)" },
    { type: "text", autocomplete: "cc-number", label: "Number" },
    { type: "text", name: "search", label: "Search" },
    { type: "text", maxLength: 1, label: "Digit 1" },
    { type: "email", autocomplete: "email", label: "Email" },
    // A contenteditable named only by its aria-label.
    { type: null, label: ["Client secret"] },
    { type: "text", label: "Passwort" },
  ];
  assert.deepEqual(masksToPaint([fields, null]), [[0, 1, 3, 5, 7, 8], "all"]);
  assert.deepEqual(masksToPaint([[{ type: "text", label: "Name" }], []]), [[], []], "a frame with no secret field gets no paint");
  assert.deepEqual(masksToPaint([]), []);
  // Each field painted by its place is found again on its own as the picture is taken, at a cost that grows with the
  // page: a grid of 625 one-character boxes took 14 s a picture in Firefox. Past the cap, every field of the frame is
  // painted by one selector instead, which errs towards hiding as an unreadable frame does.
  const digits = (n: number): SecretFieldFacts[] => Array.from({ length: n }, (_, i) => ({ type: "text", maxLength: 1, label: `Cell ${i}` }));
  const atCap = masksToPaint([digits(MAX_FIELD_MASKS)])[0];
  assert.ok(Array.isArray(atCap) && atCap.length === MAX_FIELD_MASKS, "up to the cap, each secret field is painted by its place");
  assert.deepEqual(
    masksToPaint([digits(MAX_FIELD_MASKS + 1), [{ type: "text", label: "Name" }]]),
    ["all", []],
    "past it, the whole frame's fields; other frames as before",
  );
  assert.ok(MAX_FIELD_MASKS >= 16 && MAX_FIELD_MASKS <= 64, `cap ${MAX_FIELD_MASKS}`);
  // One fixed colour, so two pictures of the same page compare (a baseline).
  assert.match(MASK_COLOR, /^#[0-9A-F]{6}$/);
  // The selector that paints fields secret by an attribute alone names only what the rule calls secret by that attribute.
  for (const token of [...SECRET_BY_ATTRIBUTE.matchAll(/autocomplete~="([^"]+)"/g)].map((m) => m[1])) {
    assert.notEqual(secretFieldKind({ type: "text", autocomplete: token }), null, token);
  }
  assert.match(SECRET_BY_ATTRIBUTE, /input\[type="password" i\]/);
});

test("a secret field's typed value is shown as a fixed mask that says why, never its length", () => {
  assert.equal(maskedValue("password"), "•••• (masked: password field)");
  assert.equal(maskedValue("card"), "•••• (masked: card field)");
});

test("redactSecrets masks what was typed into a field whose label names a secret, whatever its length or shape", () => {
  const masked: Array<[string, string]> = [
    ['textbox "Password" ← "Sup3rSecretPass"', "Sup3rSecretPass"],
    ['textbox "Password" ← "hunter2"', "hunter2"],
    ['textbox "Passphrase" ← "correct horse battery staple"', "correct horse battery staple"],
    ['textbox "One-time code" ← "123456" + Enter', "123456"],
    ['textbox "Card number" ← "4242 4242 4242 4242"', "4242"],
    ['textbox "Confirm password" ← "abc" (replaced existing content "old-pass-1")', "old-pass-1"],
    ['textbox "PIN" ← "1234" (APPENDED after existing content "98" — pass replace=true to overwrite instead)', '"98"'],
  ];
  for (const [text, secret] of masked) {
    const out = redactSecrets(text);
    assert.ok(!out.includes(secret), `${secret} must not survive: ${out}`);
    assert.match(out, /← •••• \(masked: [a-z -]+ field\)/, out);
    assert.match(out, /\[\d+ secrets? redacted\]$/, `the edit is disclosed: ${out}`);
  }
  // An ordinary field keeps what was typed: the repro needs it.
  for (const kept of [
    'textbox "Search" ← "hunter2"',
    'textbox "Max tokens" ← "500"',
    'textbox "Spinner speed" ← "3" (replaced existing content "2")',
    'textbox "Note" ← "my password is long"',
    "Password requirements are not enforced on signup",
  ]) {
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
  }
  // Already masked by the browser: left as it is, and not counted again.
  const already = 'textbox "Password" ← •••• (masked: password field)';
  assert.equal(redactSecrets(already), already);
});

test("redactSecrets redacts email addresses and card numbers; reserved example addresses, image names, ids and timestamps stay", () => {
  // Built at run time: a real-looking address written out in full would be flagged by the hygiene suite.
  const person = ["jo.sample", "contoso-mail.net"].join("@");
  const redacted: Array<[string, string]> = [
    [`Welcome back, ${person}`, "Welcome back, [email redacted]"],
    [`/account?email=${["jo.sample", "contoso-mail.net"].join("%40")}`, "/account?email=[email redacted]"],
    ["Paid with 4111 1111 1111 1111", "Paid with [card number redacted]"],
    ["card 4111-1111-1111-1111 declined", "card [card number redacted] declined"],
    ["paid 2026-10-11 4111 1111 1111 1111", "paid 2026-10-11 [card number redacted]"],
    ["Amex 3782 822463 10005 on file", "Amex [card number redacted] on file"],
    ["card 4111111111111111", "card [card number redacted]"],
    // Each network's prefixes and lengths (IIN ranges): what a card number starts with is what makes it one.
    ["Mastercard 5555 5555 5555 4444", "Mastercard [card number redacted]"],
    ["Mastercard 2223 0031 2200 3222", "Mastercard [card number redacted]"],
    ["Amex 3714 496353 98431", "Amex [card number redacted]"],
    ["Discover 6011 1111 1111 1117", "Discover [card number redacted]"],
    ["Discover 6445 6445 6445 6445", "Discover [card number redacted]"],
    ["JCB 3530 1113 3330 0000", "JCB [card number redacted]"],
    ["Diners 3056 930902 5904", "Diners [card number redacted]"],
    ["Diners 3622 720627 1667", "Diners [card number redacted]"],
    ["UnionPay 6200 0000 0000 0005", "UnionPay [card number redacted]"],
    ["Maestro 6759 6498 2643 8453", "Maestro [card number redacted]"],
    ["Mir 2200 0000 0000 0004", "Mir [card number redacted]"],
    // Networks with fewer cards in circulation, and lengths a network issues less often, are cards all the same.
    ["Maestro 6703 1111 1111 1110", "Maestro [card number redacted]"],
    ["Dankort 5019 1111 1111 1111", "Dankort [card number redacted]"],
    ["Hipercard 6062 1111 1111 1115", "Hipercard [card number redacted]"],
    ["RuPay 8171 1111 1111 1119", "RuPay [card number redacted]"],
    ["Diners 3095 1111 1111 1113", "Diners [card number redacted]"],
    ["Visa 4111 1111 1111 14", "Visa [card number redacted]"],
    ["Visa 4111 1111 1111 1111 18", "Visa [card number redacted]"],
    ["Mastercard 2223 1111 1111 1111 115", "Mastercard [card number redacted]"],
    // National networks outside the big ones' ranges: China T-Union (31, 19 digits), BORICA (2205), UzCard (8600), Humo (9860), Troy (9792), and JCB's older 3088 to 3094.
    ["T-Union 3100 1111 1111 1111 114", "T-Union [card number redacted]"],
    ["BORICA 2205 1111 1111 1112", "BORICA [card number redacted]"],
    ["UzCard 8600 1111 1111 1110", "UzCard [card number redacted]"],
    ["Humo 9860 1111 1111 1113", "Humo [card number redacted]"],
    ["Troy 9792 1111 1111 1116", "Troy [card number redacted]"],
    ["JCB 3088 1111 1111 1112", "JCB [card number redacted]"],
    ["Visa 4222 2222 2222 2", "Visa [card number redacted]"],
    // Grouped with dots, or with the non-breaking spaces a formatted number or a French locale uses.
    ["card 4111.1111.1111.1111 declined", "card [card number redacted] declined"],
    ["card 4111\u00a01111\u00a01111\u00a01111 declined", "card [card number redacted] declined"],
    ["card 4111\u202f1111\u202f1111\u202f1111 declined", "card [card number redacted] declined"],
    ["paid 11.10.2026 4111.1111.1111.1111", "paid 11.10.2026 [card number redacted]"],
    // Grouped with a thin space or a figure space, as typeset numbers are.
    ["card 4111\u20091111\u20091111\u20091111 declined", "card [card number redacted] declined"],
    ["card 4111\u20071111\u20071111\u20071111 declined", "card [card number redacted] declined"],
    // A dot after a word ends an abbreviation, not a number: the card after it is still one.
    ["Card no.4111 1111 1111 1111", "Card no.[card number redacted]"],
    ["Ref.4111111111111111 declined", "Ref.[card number redacted] declined"],
  ];
  for (const [text, want] of redacted) {
    assert.equal(redactPersonal(text), want, text);
    assert.equal(redactSecrets(text), want, `redactSecrets applies it too: ${text}`);
  }
  for (const kept of [
    "Contact qa@example.com about order 1234567890123",
    `/static/${["logo", "2x.png"].join("@")}`,
    "/feed?_=1696000000004",
    "npm i widget@18.3.1",
    "order 4111111111111112",
    // Contrastive with the cards above: Luhn-valid and card-shaped, but no network issues from these prefixes or at this length.
    "id 2111 1111 1111 1115",
    "id 3111 1111 1111 1113",
    "id 5911 1111 1111 1110",
    "id 8311 1111 1111 1110",
    "ref ORD-2111-1111-1111-1115",
    "ref 3111.1111.1111.1113",
    // An American Express prefix at a length it never issues (16 digits).
    "id 3711 1111 1111 1117",
    // Lists of years and of five-digit numbers whose digits, run together, pass the Luhn check.
    "years 2026 1993 1995 2012",
    "codes 54321 12345 12348 67890",
    // Lists of small numbers whose digits, run together, happen to pass the Luhn check.
    "widths 320 375 414 768 1024 1280 1440",
    "sizes 8 16 24 32 40 48 56 64",
    // The same digits as a card number but failing the Luhn check, dotted: as kept as when spaced.
    "build 4111.1111.1111.1112",
    // Dotted numbers that are not laid out as a card is: an address, a version, a date, an amount.
    "host 10.20.30.40 and 10.200.30.104",
    "version 3.23.4 and 2026.10.11",
    "total 4111.11 and 1\u00a0234\u00a0567,89",
    // A decimal's fraction is never a card number on its own, however long and whatever its digits.
    "took 747.4293391307649 ms",
    "at 1696000000.4111111111111111",
    "at 0.4111111111111111",
    // A decimal whose digits, dot left out, pass the card check: a card's groups are at most six digits.
    "total 4111111111.111111 and 411111111111.1111",
  ]) {
    assert.equal(redactPersonal(kept), kept, kept);
    assert.equal(redactSecrets(kept), kept, kept);
  }
});

test("a phone number right after a word for phone is redacted; numbers that only sit near one, or have no such word, stay", () => {
  const redacted: Array<[string, string]> = [
    ["Phone: +44 20 7946 0958", "Phone: [phone redacted]"],
    ["Phone: (555) 123-4567", "Phone: [phone redacted]"],
    ["Tel. 030 123 45 67", "Tel. [phone redacted]"],
    ["Tél. 01.23.45.67.89", "Tél. [phone redacted]"],
    ["Telefon 0301 2345678", "Telefon [phone redacted]"],
    ["mobile 07700-900123", "mobile [phone redacted]"],
    ["Mobile number: +49 151 2345 6789", "Mobile number: [phone redacted]"],
    ["Teléfono +34 612 345 678", "Teléfono [phone redacted]"],
    ["Telefone: +55 11 91234-5678", "Telefone: [phone redacted]"],
    ["cellulare 333 123 4567", "cellulare [phone redacted]"],
    ["Tel +4930123456789", "Tel [phone redacted]"],
    // As the action log writes a value typed into a field labelled for a phone.
    ['type textbox "Phone" ← "+44 20 7946 0958"', 'type textbox "Phone" ← "[phone redacted]"'],
    ['type textbox "Mobile number" ← "07700 900123"', 'type textbox "Mobile number" ← "[phone redacted]"'],
    // The word and "number" written as one, as German and English labels often are.
    ["Telefonnummer: 030 123 45 67", "Telefonnummer: [phone redacted]"],
    ["Mobilnummer 0151 2345678", "Mobilnummer [phone redacted]"],
    ['type textbox "phonenumber" ← "(555) 123-4567"', 'type textbox "phonenumber" ← "[phone redacted]"'],
    // A North American number with its country code, and a Spanish mobile in pairs.
    ["phone 1-800-555-0199", "phone [phone redacted]"],
    ["Teléfono: 612 34 56 78", "Teléfono: [phone redacted]"],
  ];
  for (const [text, want] of redacted) {
    assert.equal(redactPersonal(text), want, text);
    assert.equal(redactSecrets(text), want, `redactSecrets applies it too: ${text}`);
  }
  for (const kept of [
    // Contrastive with the numbers above: the same digits with no word for phone before them.
    "+44 20 7946 0958",
    "recall 030 123 45 67",
    // Signed amounts and counts, which a phone rule without the word would take.
    "+1 234 567 €",
    "+12.345.678",
    "+120-4500 items",
    "Mobile revenue +12 345 678",
    // After the word, but a date, a time range, a version, a model, a price or a list.
    "Phone: 2026-10-11",
    "Mobile app released 12.3.2026",
    "Tel. 9:00-17:00",
    "Mobile 12.34.567.8901",
    "Mobile build 4.12.345",
    "Phone 15 Pro, 256 GB",
    "Phone plan 12.99 per month",
    "Phones: 120 340 560",
    "Telephone 120 345,67 EUR",
    "tel lines: 4",
    // Words that contain a word for phone.
    "hotel 030 123 45 67",
    "Intel 2024 1234 5678",
    "telemetry 030 123 4567",
    // Lists of numbers after a word that is often a phone's and often not.
    "cell 12 34 56 78 in table",
    "GSM 900 1800 1900 bands",
    "Mobile 100 200 300 400 500",
    "Mobile 375 667",
    // Years after the word: no national number without a leading 0 starts with a group of four.
    "phone 2024 2025 2026",
    "Phone: 2024 2025",
    "Telefonnummer des Hotels: Zimmer 214",
  ]) {
    assert.equal(redactPersonal(kept), kept, kept);
  }
});

test("redactSecrets masks a parameter named for a secret, whatever its value looks like; other parameters stay", () => {
  const masked: Array<[string, string, string]> = [
    // A GET form puts what was typed into the address, and the address is logged with every action.
    ["http://x/login?user=bob&password=hunter2", "hunter2", "http://x/login?user=bob&password=[redacted]"],
    ["http://x/verify?pin=4821#otp=99", "4821", "http://x/verify?pin=[redacted]#otp=[redacted]"],
    ["http://x/cb#access_token=abc", "abc", "http://x/cb#access_token=[redacted]"],
    ["body user[password]=pw1&remember=1", "pw1", "body user[password]=[redacted]&remember=1"],
    ["/s?user%5Bpassword%5D=pw2", "pw2", "/s?user%5Bpassword%5D=[redacted]"],
    ["password=short&user=bob", "short", "password=[redacted]&user=bob"],
    // A parameter named in another language, written out or percent-encoded.
    ["http://x/login?usuario=bo&contraseña=clave1", "clave1", "http://x/login?usuario=bo&contraseña=[redacted]"],
    ["http://x/login?has%C5%82o=tajne1", "tajne1", "http://x/login?has%C5%82o=[redacted]"],
    ["http://x/entrar?senha=segredo1", "segredo1", "http://x/entrar?senha=[redacted]"],
    // A name in a script other than Latin, percent-encoded as a browser sends it (пароль).
    ["http://x/vhod?%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C=tajna1", "tajna1", "http://x/vhod?%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C=[redacted]"],
  ];
  for (const [text, secret, want] of masked) {
    const out = redactSecrets(text);
    assert.ok(!out.includes(secret), `${secret} must not survive: ${out}`);
    assert.equal(out.replace(/ \[\d+ secrets? redacted\]$/, ""), want, text);
    assert.match(out, /\[\d+ secrets? redacted\]$/, `the edit is disclosed: ${out}`);
  }
  for (const kept of [
    "/search?q=password+reset&page=2",
    'input type="password" name="login"',
    "/things?sort=pinned&max_tokens=500",
    "/buscar?categoría=libros&palavra=chave",
    "/x?bad=%E0%A4%A",
  ]) {
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
  }
  // Masked once, counted once.
  assert.equal(redactSecrets("note api_key=[redacted]"), "note api_key=[redacted]");
});

// ---------------------------------------------------------------------------
// Gaps a fuzz of the redaction found (#550). Each masked case has a near miss
// that differs in the one fact that makes it a secret, and is left alone.
// ---------------------------------------------------------------------------

/** Assert a secret is gone from redactSecrets' output and the edit is disclosed. */
function assertMasked(text: string, secret: string): void {
  const out = redactSecrets(text);
  assert.ok(!out.includes(secret), `${secret} must not survive: ${out}`);
  assert.match(out, /\[\d+ secrets? redacted\]$/, `the edit is disclosed: ${out}`);
}

test("redactSecrets masks a short or letters-only value set against a secret's name; the same name before a word about the field stays", () => {
  const masked: Array<[string, string]> = [
    ["login failed for password: hunter2", "hunter2"],
    ["Password: letmein", "letmein"],
    ["password = 'swordfish'", "swordfish"],
    ['{"password":"abc"}', '"abc"'],
    ["client_secret: shortone", "shortone"],
    ["clientSecret=abcdefgh", "abcdefgh"],
    ["api_key: abcdefgh", "abcdefgh"],
    ["token: abcdefghijkl", "abcdefghijkl"],
    ["access_token: Zm9vYmFy", "Zm9vYmFy"],
  ];
  for (const [text, secret] of masked) assertMasked(text, secret);
  for (const kept of [
    "Password: required",
    "Password: must be at least 8 characters",
    "Token: expired.",
    "token: missing after refresh",
    "Password: label is above the box",
    "token_count: 42",
    "password_hint_enabled: true",
    "Password requirements are not enforced on signup",
    "the password field: shown in clear after the toggle",
    // A strength meter's verdict and a state are words about the field.
    "Password: Weak",
    "The secret: revealed.",
    "Token: expires",
  ])
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
});

test("redactSecrets masks provider key shapes, private keys, letters-only bearer tokens and signed-link signatures; their near misses stay", () => {
  const masked: Array<[string, string]> = [
    ["Authorization: Bearer abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"],
    ["Authorization: Bearer AbCdEfGhIjKlMnOpQrSt", "AbCdEfGhIjKlMnOpQrSt"],
    [`slack ${"xoxb"}-${"1234567890"}-${"abcdefghijklmn"}`, "abcdefghijklmn"],
    [`slack ${"xoxp"}-abcdefghijklmnopqrstuv`, "abcdefghijklmnopqrstuv"],
    [`maps key ${"AIza"}${"SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv"}`, "SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv"],
    [`model key ${"sk-ant"}-api03-${"AbCdEfGhIjKlMnOp_qrst-uv"}`, "AbCdEfGhIjKlMnOp_qrst-uv"],
    [`gitlab ${"glpat"}-${"AbCdEfGhIjKlMnOpQrSt"}`, "AbCdEfGhIjKlMnOpQrSt"],
    [`registry ${"npm"}_${"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}`, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    [
      `key ${"-----BEGIN"} RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY----- in the response`,
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn",
    ],
    ["GET /bucket/file?X-Amz-Date=20261016T000000Z&X-Amz-Signature=abcdef0123456789", "abcdef0123456789"],
    ["GET /file?X-Goog-Signature=feedface", "feedface"],
    ["Cookie: sessionid=q1w2e3r4t5", "q1w2e3r4t5"],
    ["redirect /cb?code=4%2F0AX4XfWh&state=xyz", "4%2F0AX4XfWh"],
  ];
  for (const [text, secret] of masked) assertMasked(text, secret);
  for (const kept of [
    "Bearer authentication-required banner renders twice",
    "Bearer tokens are rejected after logout",
    "the xoxo-pattern divider overlaps the footer",
    "AIza prefix shown in the docs page",
    "sk-ant prefix shown in the docs page",
    "glpat- prefix shown in the docs page",
    "npm_config_cache is unset",
    `${"-----BEGIN"} CERTIFICATE----- is shown on the TLS page`,
    "GET /bucket/file?X-Amz-Date=20261016T000000Z&X-Amz-Expires=300",
    "sessionid cookie is not HttpOnly",
    "/search?q=code+review&page=2",
  ])
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
});

test("redactSecrets masks a PIN or a sign-in code written after its word; an error, status or postal code stays", () => {
  const masked: Array<[string, string]> = [
    ["the PIN 4821 was echoed in the toast", "4821"],
    ["PIN: 4821", "4821"],
    ["enter code 482913 to continue", "482913"],
    ["the code is 48291355", "48291355"],
    ["verification code: 482913", "482913"],
  ];
  for (const [text, secret] of masked) assertMasked(text, secret);
  for (const kept of [
    "PIN on map is misplaced",
    "pin 3 items to the top",
    "error code 404 page has no link home",
    "status code 500 on save",
    "postal code 560001 rejected",
    "zip code 902101 rejected",
    "product code 1234567 not found",
    "code 42 in the log",
    // A date after the word is not a PIN.
    "pin 2023-01 release notes",
  ])
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
});

test("a sign-in code led by OTP, after PIN code, or written in two groups of three is masked; a coupon's, an invoice's or a gift card's code stays", () => {
  const masked: Array<[string, string]> = [
    ["Your OTP is 482913", "482913"],
    ["otp: 482913", "482913"],
    ["passcode 48291355", "48291355"],
    ["PIN code 4821 was echoed", "4821"],
    ["PIN number: 4821", "4821"],
    ["verification code: 482 913", "482 913"],
    ["sign-in code 482-913 shown in the toast", "482-913"],
  ];
  for (const [text, secret] of masked) assertMasked(text, secret);
  for (const kept of [
    // Contrastive with "code 482913": the word before names a kind of code that is not a sign-in one.
    "coupon code 123456 was not applied",
    "voucher code 123456 expired",
    "gift code 123456 expired",
    "Invoice code: 20240115 is missing",
    "referral code 123456 rejected",
    "OTP length 6 is not enforced",
    "PIN code required",
  ])
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
});

test("a private key block in PGP's armour is masked; a public key block stays", () => {
  assertMasked(`${"-----BEGIN"} PGP PRIVATE KEY BLOCK-----\nlQOYBGabcdefgh\n-----END PGP PRIVATE KEY BLOCK-----`, "lQOYBGabcdefgh");
  const pub = `${"-----BEGIN"} PGP PUBLIC KEY BLOCK-----\nmQINBGabcdefgh\n-----END PGP PUBLIC KEY BLOCK-----`;
  assert.equal(redactSecrets(pub), pub);
});

test("a secret's name set against a status word or the engine's own mask stays readable; the same name against a value is masked", () => {
  // Contrastive with "Password: letmein": each value is a word a validation message or a log uses about the secret.
  for (const kept of [
    "Password: incorrect",
    "Password: Incorrect.",
    "Password: mismatch",
    "password: reset",
    "Password: present",
    "Token: revoked",
    "Token: absent",
    "Token: refreshed",
    "secret: redacted",
    "Password: •••• (masked: password field)",
    "password: ********",
  ])
    assert.equal(redactSecrets(kept), kept, `must not touch: ${kept}`);
  assertMasked("Password: letmein", "letmein");
  assertMasked("password：hunter2", "hunter2");
});

test("a field named by a short or uncommon word for a secret is secret; a field about the secret is not", () => {
  const secret: Array<[SecretFieldFacts, string]> = [
    [{ name: "pass" }, "password"],
    [{ name: "pw" }, "password"],
    [{ id: "pword" }, "password"],
    [{ label: "Memorable word" }, "password"],
    [{ label: "Code" }, "one-time code"],
    [{ name: "smsCode" }, "one-time code"],
    [{ label: "Enter the 6-digit code" }, "one-time code"],
    [{ name: "access_key" }, "secret"],
    [{ name: "accessKeyId" }, "secret"],
    [{ label: "Bearer" }, "secret"],
    [{ name: "ssh_key" }, "secret"],
    [{ label: "Credential" }, "secret"],
    [{ label: "Credentials" }, "secret"],
    [{ label: "Signing key" }, "secret"],
    [{ label: "Session ID" }, "secret"],
    [{ name: "sessionid" }, "secret"],
    [{ label: "Seed" }, "secret"],
    [{ label: "License key" }, "secret"],
    [{ label: "Licence key" }, "secret"],
    [{ label: "Password (8 characters minimum)" }, "password"],
    // A password field after a show-password toggle, named by nothing else: what the reader saw before is kept.
    [{ type: "text", label: "Account phrase", wasPassword: true }, "password"],
  ];
  for (const [facts, kind] of secret) assert.equal(secretFieldKind(facts), kind, JSON.stringify(facts));
  const ordinary: SecretFieldFacts[] = [
    { name: "token_count" },
    { name: "password_hint_enabled" },
    { name: "pin_on_map" },
    { name: "otp_enabled" },
    { label: "Password strength" },
    { label: "Drop a pin on the map" },
    { label: "Promo code" },
    { label: "Zip code" },
    { label: "Country code" },
    { label: "Code review notes" },
    { label: "Passport number" },
    { label: "Access level" },
    { label: "Keyboard layout" },
    { label: "Session name" },
    { label: "Seedling count" },
    { label: "License type" },
    { label: "Boarding pass count" },
    // "pass", "seed" and "credentials" name a secret only on their own: with another word they name something else.
    { label: "Pass rate" },
    { label: "Boarding pass" },
    { label: "Random seed" },
    { label: "Credentials provider" },
    { type: "text", label: "Account phrase", wasPassword: false },
  ];
  for (const facts of ordinary) assert.equal(secretFieldKind(facts), null, JSON.stringify(facts));
  // The same words as a parameter's name.
  assertMasked("/login?user=bob&pass=letmein", "letmein");
  assertMasked("/verify?smsCode=123456", "123456");
  for (const kept of ["/stats?token_count=5", "/settings?otp_enabled=true", "/reports?pass_rate=0.9"]) assert.equal(redactSecrets(kept), kept, kept);
});

test("card numbers split by a slash or by a separator with spaces around it, and 12-digit Maestro cards, are redacted; dates and lists stay", () => {
  const redacted: Array<[string, string]> = [
    ["card 4111/1111/1111/1111 declined", "card [card number redacted] declined"],
    ["card 4111 - 1111 - 1111 - 1111 declined", "card [card number redacted] declined"],
    ["card 4111 / 1111 / 1111 / 1111 declined", "card [card number redacted] declined"],
    ["card 4111  1111  1111  1111 declined", "card [card number redacted] declined"],
    ["card 4111-1111 / 1111 1111 declined", "card [card number redacted] declined"],
    ["Maestro 5018 1234 5673", "Maestro [card number redacted]"],
    ["Maestro 675911111119", "Maestro [card number redacted]"],
  ];
  for (const [text, want] of redacted) {
    assert.equal(redactPersonal(text), want, text);
    assert.equal(redactSecrets(text), want, `redactSecrets applies it too: ${text}`);
  }
  for (const kept of [
    "due 2026/10/16 and 10/16/2026",
    "pages 4111/1111",
    "years 2024 - 2025 - 2026 - 2027",
    // Luhn-valid at 12 digits, but no network issues a 12-digit card from these prefixes.
    "id 411111111117",
    "id 5017 1234 5674",
    "ratio 1/2/3/4",
  ]) {
    assert.equal(redactPersonal(kept), kept, kept);
    assert.equal(redactSecrets(kept), kept, kept);
  }
});

test("email addresses written with (at) and (dot), with a quoted local part or an IP literal are redacted; an scp-style git remote stays", () => {
  const local = "jo.sample";
  const host = "contoso-mail";
  const redacted: Array<[string, string]> = [
    [`write to ${local} (at) ${host} (dot) net`, "write to [email redacted]"],
    [`write to ${local} [at] ${host} [dot] net today`, "write to [email redacted] today"],
    [`write to ${local} at ${host} dot net today`, "write to [email redacted] today"],
    [`write to ${local}(at)${host}.net`, "write to [email redacted]"],
    [`from "jo sample"@${host}.net`, "from [email redacted]"],
    [`from jo@[10.1.2.3] bounced`, "from [email redacted] bounced"],
  ];
  for (const [text, want] of redacted) {
    assert.equal(redactPersonal(text), want, text);
    assert.equal(redactSecrets(text), want, `redactSecrets applies it too: ${text}`);
  }
  for (const kept of [
    // Built at run time, as the addresses above are: the hygiene suite flags an address on a real-looking domain.
    `git clone ${["git", `git.${host}.net:team/widgets.git`].join("@")}`,
    `remote ${["deploy", `${host}.net:~/widgets.git`].join("@")} fails`,
    "look at the dot matrix printer",
    "meet at noon",
    `${local} (at) example (dot) com`,
    "server at 10.1.2.3 refused",
  ]) {
    assert.equal(redactPersonal(kept), kept, kept);
  }
});

test("a phone number after Call, WhatsApp, Contact, Ph or T is redacted; the same letters inside a word, or with no number shape, stay", () => {
  const redacted: Array<[string, string]> = [
    ["Call 030 123 45 67", "Call [phone redacted]"],
    ["WhatsApp: +44 7700 900123", "WhatsApp: [phone redacted]"],
    ["Contact +49 151 2345 6789", "Contact [phone redacted]"],
    ["Ph: (555) 123-4567", "Ph: [phone redacted]"],
    ["T: +44 20 7946 0958", "T: [phone redacted]"],
    ["T. 030 123 45 67", "T. [phone redacted]"],
  ];
  for (const [text, want] of redacted) {
    assert.equal(redactPersonal(text), want, text);
    assert.equal(redactSecrets(text), want, `redactSecrets applies it too: ${text}`);
  }
  for (const kept of [
    "recall 030 123 45 67",
    "API call took 120 340 ms",
    "Contact us 2024 2025",
    "Part: 030 123 45 67",
    "don't 0800 123 4567",
    "graph 030 123 45 67",
  ]) {
    assert.equal(redactPersonal(kept), kept, kept);
  }
});

test("a failed fill's error names the action but not the secret value Playwright's call log quotes", () => {
  const message = [
    "locator.fill: Error: Cannot type text into input[type=number]",
    "Call log:",
    "  - waiting for locator('#pin')",
    // Playwright does not escape a quote inside the value.
    '    - fill("Tr1cky "quoted" phrase")',
    "  - attempting fill action",
  ].join("\n");
  const out = maskFillCalls(message);
  assert.ok(!out.includes("Tr1cky") && !out.includes("quoted") && !out.includes("phrase"), out);
  assert.ok(out.includes("fill((masked))"), out);
  assert.ok(out.startsWith("locator.fill: Error: Cannot type text into input[type=number]"), "the first line, which says what went wrong, stays");
  // A value split over lines by a newline in it is removed wherever it appears.
  const split = maskFillCalls('Call log:\n    - fill("first\nsecond-half")', ["first\nsecond-half"]);
  assert.ok(!split.includes("second-half"), split);
});

test("a password typed into a labelled field never reaches the session log, even when it is short", () => {
  const store = freshStore();
  store.logAction({ action: "type", target: 'textbox "Password" ← "hunter2"', url: "http://x/login" });
  const line = fs.readFileSync(sessionLogOf(store), "utf8");
  assert.ok(!line.includes("hunter2"), line);
  assert.ok(line.includes("masked: password field"), line);
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
  store.addFinding({ severity: "low", category: "other", title: "kept", detail: "d", evidence: "e", url: "http://x/", state: "s" });
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

test("a route that answered with a feed or a file is remembered as such, across runs and merges", () => {
  const store = freshStore();
  store.markResource("/feed", "application/rss+xml");
  store.markResource("/feed", "application/rss+xml");
  store.flush();
  const again = openStore(path.dirname(store.dir));
  assert.deepEqual(again.resourceRoutes, { "/feed": "application/rss+xml" });
  // Answering as a page later puts it back.
  again.clearResource("/feed");
  again.clearResource("/never-marked");
  again.flush();
  assert.deepEqual(openStore(path.dirname(store.dir)).resourceRoutes, {});
  const a: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [], resourceRoutes: { "/feed": "application/rss+xml" } };
  const b: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [], resourceRoutes: { "/LICENSE": "text/plain" } };
  assert.deepEqual(mergeMemory(a, b).resourceRoutes, { "/LICENSE": "text/plain", "/feed": "application/rss+xml" });
});

test("a run started from an earlier one: noted from another process, kept through the server's own writes, and named in the report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "from-run-"));
  try {
    const store = new MemoryStore(dir);
    // The server's copy is open before the ci run notes anything, as in a real run.
    await new Promise((r) => setTimeout(r, 5));
    const note = (at: string, runId: string): FromRunNote => ({ at, mode: "continue", source: "prev/ci.json", runId, recordAt: "2026-10-07T09:00:00.000Z" });
    noteFromRunOnDisk(dir, note(new Date().toISOString(), "r1"));
    assert.deepEqual(store.fromRunsThisRun(), [], "the server has not read it yet");
    store.foldInFromRuns();
    assert.deepEqual(
      store.fromRunsThisRun().map((n) => n.runId),
      ["r1"],
    );
    const report = generateReport(store, [], undefined, { write: false }).markdown;
    assert.match(report, /\| Started from \| continued from the run recorded in prev\/ci\.json \(its report of 2026-10-07T09:00:00\.000Z\) \|/);
    // A server that never folded it in still keeps it when it writes: the merge unions the notes.
    const other = new MemoryStore(dir);
    noteFromRunOnDisk(dir, note(new Date().toISOString(), "r2"));
    other.addFinding({ severity: "low", category: "a11y", title: "A field has no label", detail: "d", url: "http://x/a", state: "/a#f" });
    other.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, MEMORY_DIRNAME, "memory.json"), "utf8"));
    assert.deepEqual(
      onDisk.fromRuns.map((n: FromRunNote) => n.runId),
      ["r1", "r2"],
    );
    // A run that started fresh has no such row.
    const plain = new MemoryStore(fs.mkdtempSync(path.join(os.tmpdir(), "from-run-none-")));
    assert.doesNotMatch(generateReport(plain, [], undefined, { write: false }).markdown, /Started from/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a run's record: what it worked on and left, from the store, kept in memory and read back from a project or a ci.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-record-"));
  try {
    const store = new MemoryStore(dir);
    const url = "http://app.test/orders";
    store.visitState("/orders#s1", url, "/orders", ["button:save", "button:export", "select:status", "textbox:note"], [], "lane-a");
    store.logAction({ action: "navigate", target: url, url, session: "lane-a" });
    store.markExercised("/orders#s1", "select:status", "select");
    store.logAction({ action: "select", target: 'combobox "Status" = Open', url, session: "lane-a" });
    store.recordSelectChoice("/orders#s1", "select:status", ["Open", "Closed", "Archived"], "Open");
    store.recordForm("/orders#s1", "form#new-order", false, "lane-a");
    store.recordForm("/orders#s1", "form#search", false, "lane-a");
    // The contrastive pair: one form submitted, one never.
    store.recordFormSubmit("/orders#s1", "form#search", false);
    // A route only crawled is not worked on.
    store.visitState("/stock#s1", "http://app.test/stock", "/stock", ["button:adjust"], [], "default");
    store.logAction({ action: "crawl", target: "/stock", url: "http://app.test/stock", session: "default" });
    assert.deepEqual(store.formsNeverSubmitted(), [{ route: "/orders", key: "form#new-order" }]);
    const record = runRecordOf(store, ["/orders", "/stock", "/reports"], ["a gap"]);
    assert.deepEqual(record.visited, ["/orders"]);
    assert.deepEqual(record.left, [
      {
        route: "/orders",
        unexercised: ["button:save", "button:export", "textbox:note"],
        forms: ["form#new-order"],
        // An option was chosen and nothing was submitted from the page: the gap ledger's filled-and-never-submitted line.
        filled: true,
        unchosen: [{ key: "select:status", options: ["Closed", "Archived"] }],
      },
    ]);
    assert.deepEqual(record.gaps, ["a gap"]);
    store.addRunRecord(record);
    store.flush();
    assert.deepEqual(readRunRecordsOnDisk(dir), [record]);
    // From the project directory, from a ci.json, and nothing at all.
    assert.deepEqual(loadRunRecord(dir), record);
    const ci = path.join(dir, "ci.json");
    fs.writeFileSync(ci, JSON.stringify({ tool: "scenescout", command: "ci", record }));
    assert.deepEqual(loadRunRecord(ci), record);
    assert.throws(() => loadRunRecord(path.join(dir, "nope.json")), /does not exist: give a ci.json or a project directory/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "run-record-empty-"));
    assert.throws(() => loadRunRecord(empty), /holds no \.scenescout\/memory\.json, ci\.json or memory\.json/);
    fs.rmSync(empty, { recursive: true, force: true });
    fs.writeFileSync(ci, "{not json");
    assert.throws(() => loadRunRecord(ci), /could not be read as JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("merging memory unions the run records and the notes, and doing it twice changes nothing", () => {
  const rec = (runId: string, at: string): RunRecord => ({ version: 1, runId, at, knownRoutes: [], visited: [], lanes: [], steps: [], left: [], gaps: [] });
  const a: Parameters<typeof mergeMemory>[0] = { version: 1, states: {}, findings: [], runRecords: [rec("r1", "1")] };
  const b: Parameters<typeof mergeMemory>[0] = {
    version: 1,
    states: {},
    findings: [],
    runRecords: [rec("r2", "2")],
    fromRuns: [{ at: "2", mode: "replay", source: "s", runId: "r1", recordAt: "1" }],
  };
  const once = mergeMemory(a, b);
  assert.deepEqual(
    once.runRecords?.map((x) => x.runId),
    ["r1", "r2"],
  );
  assert.equal(once.fromRuns?.length, 1);
  assert.deepEqual(mergeMemory(once, b), once);
  const none = mergeMemory({ version: 1, states: {}, findings: [] }, { version: 1, states: {}, findings: [] });
  assert.equal(none.runRecords, undefined);
  assert.equal(none.fromRuns, undefined);
});

// ---- writes into .scenescout/ never go through a link ------------------------

/** A project with a file outside .scenescout/ that a link left at each of `names` points at. */
function linkedProject(names: string[]): { projectDir: string; dir: string; victim: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-links-"));
  const dir = path.join(projectDir, ".scenescout");
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(projectDir, "elsewhere.txt");
  fs.writeFileSync(victim, "not the engine's");
  for (const name of names) fs.symlinkSync(victim, path.join(dir, name));
  return { projectDir, dir, victim };
}

function assertOwnFile(file: string, ownerOnly = true): void {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile(), `${path.basename(file)} is a file of its own, not a link`);
  if (ownerOnly) assert.equal(stat.mode & 0o777, 0o600, `${path.basename(file)} can be read by its owner only`);
}

test(
  "owner-only writes replace a link or a readable file at the name, never write through it, and leave no temporary file",
  { skip: process.platform === "win32" },
  async () => {
    const { projectDir, dir, victim } = linkedProject(["a.json", "b.json"]);
    try {
      fs.writeFileSync(path.join(dir, "c.json"), "old", { mode: 0o644 });
      fs.chmodSync(path.join(dir, "c.json"), 0o644);
      writeOwnerOnlySync(path.join(dir, "a.json"), "sync");
      await writeOwnerOnly(path.join(dir, "b.json"), "async");
      writeOwnerOnlySync(path.join(dir, "c.json"), "replaced");
      for (const [name, text] of [
        ["a.json", "sync"],
        ["b.json", "async"],
        ["c.json", "replaced"],
      ]) {
        assertOwnFile(path.join(dir, name));
        assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), text);
      }
      assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's", "the file the links pointed at is untouched");
      assert.deepEqual(fs.readdirSync(dir).sort(), ["a.json", "b.json", "c.json"], "no temporary file is left behind");
      // A write that fails (a folder at the name) leaves no temporary file either.
      fs.mkdirSync(path.join(dir, "d.json", "inside"), { recursive: true });
      assert.throws(() => writeOwnerOnlySync(path.join(dir, "d.json"), "x"));
      await assert.rejects(writeOwnerOnly(path.join(dir, "d.json"), "x"));
      assert.deepEqual(fs.readdirSync(dir).sort(), ["a.json", "b.json", "c.json", "d.json"]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },
);

test("an owner-only append creates the file owner-only, adds to it, and refuses a link at its name", { skip: process.platform === "win32" }, () => {
  const { projectDir, dir, victim } = linkedProject(["linked.jsonl"]);
  try {
    const log = path.join(dir, "own.jsonl");
    appendOwnerOnlySync(log, "one\n");
    appendOwnerOnlySync(log, "two\n");
    assertOwnFile(log);
    assert.equal(fs.readFileSync(log, "utf8"), "one\ntwo\n");
    assert.throws(() => appendOwnerOnlySync(path.join(dir, "linked.jsonl"), "three\n"), /is a symbolic link; SceneScout does not write through one/);
    assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test(
  "memory's files, its notes, its .gitignore and the report are never written through a link left at their names",
  { skip: process.platform === "win32" },
  () => {
    const names = ["memory.json", "ASSUMPTIONS.md", "report.md", "report.html"];
    const { projectDir, dir, victim } = linkedProject(names);
    // A .gitignore that is there is left as it is; a link to nothing is replaced by the store's own.
    fs.symlinkSync(path.join(projectDir, "nothing-here"), path.join(dir, ".gitignore"));
    names.push(".gitignore");
    try {
      const store = new MemoryStore(projectDir);
      store.addAssumption("app-model", "Orders belong to one customer.", "test");
      store.addFinding({ severity: "low", category: "ux-confusing", title: "A finding", detail: "d", url: "http://app.test/", state: "/#0", evidence: "e" });
      store.flush();
      generateReport(store, [], undefined, { write: true });
      // Only memory.json is owner-only; the documents keep the umask's mode (the test after the next).
      for (const name of names) assertOwnFile(path.join(dir, name), name === "memory.json");
      assert.equal(fs.existsSync(path.join(projectDir, "nothing-here")), false, "nothing was created where the dangling link pointed");
      assert.match(fs.readFileSync(path.join(dir, "ASSUMPTIONS.md"), "utf8"), /Orders belong to one customer/);
      assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's", "the file the links pointed at is untouched");

      // The session log is appended to line by line: a link at its name is refused, not followed.
      const log = (store as unknown as { sessionLogPath: string }).sessionLogPath;
      fs.symlinkSync(victim, log);
      assert.throws(() => store.logAction({ action: "click", url: "http://app.test/" }), /symbolic link/);
      assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's");
      fs.rmSync(log);
      store.logAction({ action: "click", url: "http://app.test/" });
      assertOwnFile(log);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },
);

test("a note from a run on disk replaces a link at memory.json rather than writing through it", { skip: process.platform === "win32" }, () => {
  const { projectDir, dir, victim } = linkedProject([]);
  try {
    fs.writeFileSync(victim, JSON.stringify({ version: 1, states: {}, findings: [] }));
    fs.symlinkSync(victim, path.join(dir, "memory.json"));
    noteFromRunOnDisk(projectDir, {
      at: "2026-10-11T00:00:00.000Z",
      mode: "continue",
      source: "prev/ci.json",
      runId: "r1",
      recordAt: "2026-10-07T09:00:00.000Z",
    });
    assertOwnFile(path.join(dir, "memory.json"));
    assert.equal(fs.readFileSync(victim, "utf8"), JSON.stringify({ version: 1, states: {}, findings: [] }), "the file the link pointed at is untouched");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

/** Run `fn` with the umask set to 022, the usual one, and put the old one back. */
async function withUmask022<T>(fn: () => T | Promise<T>): Promise<T> {
  const old = process.umask(0o022);
  try {
    return await fn();
  } finally {
    process.umask(old);
  }
}

test(
  "a document write replaces a link like an owner-only one, but takes the mode the user's umask gives a new file",
  { skip: process.platform === "win32" },
  () =>
    withUmask022(async () => {
      const { projectDir, dir, victim } = linkedProject(["a.md", "b.png"]);
      try {
        writeDocumentSync(path.join(dir, "a.md"), "sync");
        await writeDocument(path.join(dir, "b.png"), new Uint8Array([1, 2, 3]));
        for (const name of ["a.md", "b.png"]) {
          const stat = fs.lstatSync(path.join(dir, name));
          assert.ok(stat.isFile(), `${name} is a file of its own, not a link`);
          assert.equal(stat.mode & 0o777, 0o644, `${name} has the umask's mode`);
        }
        assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's");
        assert.deepEqual(fs.readdirSync(dir).sort(), ["a.md", "b.png"], "no temporary file is left behind");
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    }),
);

test(
  "which of memory's files are owner-only: what could open a session is, what a person reads or git reads keeps the umask's mode",
  { skip: process.platform === "win32" },
  () =>
    withUmask022(() => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-modes-"));
      try {
        const store = new MemoryStore(projectDir);
        store.addAssumption("app-model", "Orders belong to one customer.", "test");
        store.addFinding({ severity: "low", category: "ux-confusing", title: "A finding", detail: "d", url: "http://app.test/", state: "/#0", evidence: "e" });
        store.flush();
        store.logAction({ action: "click", url: "http://app.test/" });
        generateReport(store, [], undefined, { write: true });
        const log = path.basename((store as unknown as { sessionLogPath: string }).sessionLogPath);
        const expected: Array<[string, number]> = [
          ["memory.json", 0o600],
          [log, 0o600],
          ["report.md", 0o644],
          ["report.html", 0o644],
          ["ASSUMPTIONS.md", 0o644],
          [".gitignore", 0o644],
        ];
        for (const [name, mode] of expected) {
          assert.equal((fs.statSync(path.join(store.dir, name)).mode & 0o777).toString(8), mode.toString(8), `${name}'s mode`);
        }
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    }),
);

test("a finding filed with another site's full request address dedups with the same failure written without its query", () => {
  const filed = { id: "f1", status: "open" as const, category: "http-error", title: "Token exchange refused", detail: "", state: "/signin" };
  const old = { ...filed, evidence: "GET https://idp.example/oauth2/token?code=one-time-code&state=s3 → HTTP 500" };
  const trimmed = { ...filed, evidence: "GET https://idp.example/oauth2/token → HTTP 500" };
  assert.deepEqual([...endpointSignatures(old.evidence)], [...endpointSignatures(trimmed.evidence)], "one endpoint signature either way");
  assert.ok(isDuplicateFinding(old, trimmed), "the stored finding and the new one are one defect");
  assert.ok(isDuplicateFinding(trimmed, old));
  // The contrast: another path on that site is another request.
  assert.ok(!isDuplicateFinding(old, { ...filed, evidence: "GET https://idp.example/oauth2/userinfo → HTTP 500" }));
});

// ---------------------------------------------------------------------------
// redactPageText "pii": what the tools return to the agent (issue #537)
// ---------------------------------------------------------------------------

// Built at run time: a real-looking address written out in full would be flagged by the hygiene suite.
const PAGE_PERSON = ["jo.sample", "contoso-mail.net"].join("@");

test("maskPageText masks an email, a phone after its word and a card number with typed markers, and leaves their near misses", () => {
  const masked: Array<[string, string]> = [
    [`Signed in as ${PAGE_PERSON}`, "Signed in as [email redacted]"],
    ["Phone: +44 20 7946 0958", "Phone: [phone redacted]"],
    ["Card 4111 1111 1111 1111 on file", "Card [card number redacted] on file"],
    [`- row "${PAGE_PERSON} 4111-1111-1111-1111 Phone: (555) 123-4567"`, '- row "[email redacted] [card number redacted] Phone: [phone redacted]"'],
  ];
  for (const [input, want] of masked) assert.equal(maskPageText(input), want, input);
  // Each beside the one fact that keeps it: a reserved example domain, a number with no word for a phone before it, an
  // order id no card network issues, a date after the word for a phone.
  const kept = ["Write to help@example.com", "Ref +44 20 7946 0958", "Order 1234 5678 9012 3456", "Phone: 2026-10-11", 'button "Save" [ref=e12]'];
  for (const text of kept) assert.equal(maskPageText(text), text, text);
  // Unlike the stored form, nothing is counted: a credential is left to the tools' own masking of secret fields.
  assert.equal(maskPageText("token: abc123def456ghi789"), "token: abc123def456ghi789");
});

test("maskToolResult masks every text part and every string of structured content, and leaves pictures, keys and numbers", () => {
  const picture = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
  const said = { type: "text", text: `Contact ${PAGE_PERSON}` };
  const result = {
    content: [said, picture],
    structuredContent: { [PAGE_PERSON]: { phone: "Tel. 030 123 45 67", list: ["4111 1111 1111 1111", 4111111111111111, null, true] } },
    isError: false,
  };
  const out = maskToolResult(result);
  assert.deepEqual(out.content, [{ type: "text", text: "Contact [email redacted]" }, picture]);
  assert.deepEqual(out.structuredContent, {
    [PAGE_PERSON]: { phone: "Tel. [phone redacted]", list: ["[card number redacted]", 4111111111111111, null, true] },
  });
  assert.equal(out.isError, false);
  assert.equal(said.text, `Contact ${PAGE_PERSON}`, "the result the tool built is not changed in place");
  // An embedded resource's text is masked too; its other fields are kept.
  const embedded = maskToolResult({ content: [{ type: "resource", resource: { uri: "scenescout://x", text: `Owner ${PAGE_PERSON}` } }] });
  assert.deepEqual(embedded.content, [{ type: "resource", resource: { uri: "scenescout://x", text: "Owner [email redacted]" } }]);
  // The contrast: a result with nothing personal comes back equal.
  const plain = { content: [{ type: "text", text: '- heading "Orders" [ref=e1]' }] };
  assert.deepEqual(maskToolResult(plain), plain);
});

test("a title the agent copies from masked page text dedups with the finding an oracle stored from the page as it is", () => {
  // Oracles read the page before masking and the store redacts what it keeps with the same markers, so the two agree.
  const store = freshStore();
  const raw = `Profile shows ${PAGE_PERSON} as owner of every record`;
  const [stored, isNew] = store.addFinding({ ...base, category: "wrong-data", title: raw, detail: "x", evidence: raw });
  assert.equal(isNew, true);
  assert.equal(stored.title, maskPageText(raw), "the stored title is the masked one");
  const copied = maskPageText(raw);
  const [, againNew] = store.addFinding({ ...base, category: "wrong-data", title: copied, detail: "y", evidence: copied });
  assert.equal(againNew, false, "the agent's filing from masked text merged into the oracle's");
  // The contrast: another person's address is another finding.
  const other = ["kim.example", "fabrikam-mail.org"].join("@");
  const [, otherNew] = store.addFinding({
    ...base,
    category: "wrong-data",
    title: `Profile shows ${other} twice in the header`,
    detail: "z",
    evidence: `header ${other}`,
  });
  assert.equal(otherNew, true);
});

test("maskPageText keeps quoted JSON valid: an escape is never read into an address, and an encoded @ is still an address", () => {
  const [local, domain] = PAGE_PERSON.split("@") as [string, string];
  const body = {
    bio: `Line one\n${PAGE_PERSON}`,
    tab: `\t${PAGE_PERSON}`,
    phone: "\tTel. 030 123 45 67",
    label: "Phone:\n+44 20 7946 0958",
    path: `C:\\${PAGE_PERSON}`,
    quoted: `"${PAGE_PERSON}"`,
    card: "\n4111 1111 1111 1111",
    kept: "Write to help@example.com\nThanks",
  };
  for (const space of [0, 2]) {
    const quoted = JSON.stringify(body, null, space);
    const out = maskPageText(`HTTP 200 application/json\n${quoted}`);
    const parsed = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
    assert.deepEqual(parsed, {
      bio: "Line one\n[email redacted]",
      tab: "\t[email redacted]",
      phone: "\tTel. [phone redacted]",
      label: "Phone:\n[phone redacted]",
      path: "C:\\[email redacted]",
      quoted: '"[email redacted]"',
      card: "\n[card number redacted]",
      kept: "Write to help@example.com\nThanks",
    });
  }
  // An address whose @ (or dot) a serializer wrote as an escape is masked; the contrast, an escaped @ of a reserved
  // example address, is written back exactly as it came.
  assert.equal(maskPageText(`{"e":"${local}\\u0040${domain}"}`), '{"e":"[email redacted]"}');
  assert.equal(maskPageText(`{"e":"${local}@contoso-mail\\u002Enet"}`), '{"e":"[email redacted]"}');
  assert.equal(maskPageText('{"e":"help\\u0040example.com"}'), '{"e":"help\\u0040example.com"}');
  // A text that holds a character the mask reads an escaped newline as is masked between its escapes, still valid.
  const holding = JSON.stringify({ a: `\u2028\n${PAGE_PERSON}` });
  assert.deepEqual(JSON.parse(maskPageText(holding)), { a: "\u2028\n[email redacted]" });
  // An escaped backslash is one escape, so the letter after it is text: `\\nina@…` is the address `nina@…`.
  assert.equal(maskPageText(`\\\\n${PAGE_PERSON}`), "\\\\[email redacted]");
});

test("maskingHandler: whether a result is masked is asked before and after the call, and a thrown error is masked or thrown on", async () => {
  const said = `Contact ${PAGE_PERSON}`;
  const result = () => ({ content: [{ type: "text", text: said }], structuredContent: { who: said } });
  const masked = { content: [{ type: "text", text: "Contact [email redacted]" }], structuredContent: { who: "Contact [email redacted]" } };
  // [masked before the call, masked after it, masked result]: an attach opens a masking session, a close drops one.
  const rows: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ];
  for (const [before, after, want] of rows) {
    const answers = [before, after];
    const handler = maskingHandler(
      async (_args: { session?: string }) => result(),
      () => answers.shift() ?? after,
    );
    assert.deepEqual(await handler({ session: "a" }), want ? masked : result(), `before ${before}, after ${after}`);
  }
  // The arguments and the SDK's extra reach the handler as they were sent.
  const seen: unknown[] = [];
  const passing = maskingHandler(
    async (...args: unknown[]) => (seen.push(...args), result()),
    () => true,
  );
  await passing({ ref: "e1" }, { signal: "s" });
  assert.deepEqual(seen, [{ ref: "e1" }, { signal: "s" }]);
  // Something that is not a result passes as it is.
  assert.equal(
    await maskingHandler(
      async () => said,
      () => true,
    )(),
    said,
  );
  // A thrown error: masked, it becomes the isError result the SDK would make, and the error object is not changed.
  const err = new Error(`No row for ${PAGE_PERSON}`);
  const throwing = () =>
    maskingHandler(
      async () => Promise.reject(err),
      () => true,
    );
  assert.deepEqual(await throwing()(), { content: [{ type: "text", text: "No row for [email redacted]" }], isError: true });
  assert.equal(err.message, `No row for ${PAGE_PERSON}`);
  assert.deepEqual(
    await maskingHandler(
      async () => Promise.reject("plain " + PAGE_PERSON),
      () => true,
    )(),
    {
      content: [{ type: "text", text: "plain [email redacted]" }],
      isError: true,
    },
  );
  // The contrast: with masking off before and after, the same error is thrown on, unchanged.
  await assert.rejects(
    maskingHandler(
      async () => Promise.reject(err),
      () => false,
    )(),
    (e) => e === err,
  );
  // Off before the call and on after it (an attach that failed after opening its session) still masks the error.
  const flips = [false, true];
  assert.equal(
    (
      (await maskingHandler(
        async () => Promise.reject(err),
        () => flips.shift()!,
      )()) as { isError: boolean }
    ).isError,
    true,
  );
});

// ---------------------------------------------------------------------------
// A generated corpus for the detectors in sensitive.ts (#538)
// ---------------------------------------------------------------------------

test("a passphrase written as two words is a secret field, and a phrase that is not one stays ordinary (found by the sensitive corpus)", () => {
  for (const name of ["pass phrase", "pass_phrase", "passPhrase", "pass-phrase", "Pass Phrase", "PASS_PHRASE", "pass_phrase3"]) {
    assert.equal(secretFieldKind({ type: "text", name }), "password", name);
    assert.equal(secretFieldKind({ type: "text", label: name }), "password", name);
  }
  for (const name of ["catch phrase", "phrase", "pass rate", "phrase book"]) assert.equal(secretFieldKind({ type: "text", name }), null, name);
  assert.equal(maskSecretFieldValues('textbox "Pass phrase" ← "zzfake123"').text, `textbox "Pass phrase" ← ${maskedValue("password")}`);
});

test("a count or setting after a secret's two-word name is not the secret, as after its one-word name: api key count is ordinary, api key is not", () => {
  for (const name of ["apikey_count", "api key count", "api_key_count", "apiKeyCount", "API key expires", "pass phrase hint", "card number length"])
    assert.equal(secretFieldKind({ type: "text", name }), null, name);
  for (const name of ["api key", "api_key", "apiKey", "API key 2", "pass phrase", "card number"])
    assert.notEqual(secretFieldKind({ type: "text", name }), null, name);
  assert.equal(maskSecretFieldValues('textbox "API key count" ← "12"').hits, 0);
  assert.equal(maskSecretFieldValues('textbox "API key" ← "zzfake123"').text, `textbox "API key" ← ${maskedValue("secret")}`);
});

test("a name a person would call secret is a secret field though no word list names it, and the name one fact short of it is not (#718)", () => {
  const secret = [
    ...["security_question_answer", "securityQuestionAnswer", "Secret answer", "answer-to-security-question", "memorable_information"],
    ...["Memorable date", "memorable place", "mothers_maiden_name", "Maiden name", "recovery_key", "master-key", "encryptionKey"],
    ...["account_number", "Bank account number", "accountNumber2", "routing_number", "IBAN", "sort-code", "Sort code"],
    ...["social_security_number", "ssn", "SSN", "National insurance number"],
  ];
  const nearMiss = [
    ...["security_question", "memorable_moment", "maiden voyage", "recovery_email", "master_list", "encryption_method", "account_name"],
    ...["Account type", "order_number", "tracking number", "phone_number", "routing slip", "sort_order", "Sort by", "social_media"],
    ...["national_park", "insurance company", "account number length", "security question answer hint", "ssn_enabled"],
  ];
  for (const name of secret) {
    assert.notEqual(secretFieldKind({ type: "text", name }), null, `${name} in the name`);
    assert.notEqual(secretFieldKind({ type: "text", label: name }), null, `${name} in the label`);
    assert.notEqual(secretFieldKind({ type: "text", placeholder: `Enter your ${name}` }), null, `${name} in the placeholder`);
    assert.ok(maskSecretFieldValues(`textbox "${name}" ← "zzfake123"`).hits > 0, `${name} typed value`);
  }
  for (const name of nearMiss) {
    assert.equal(secretFieldKind({ type: "text", name }), null, `${name} in the name`);
    assert.equal(maskSecretFieldValues(`textbox "${name}" ← "zzfake123"`).hits, 0, `${name} typed value`);
  }
});

test("sensitive corpus: the generator is seeded and every shape has a pair on the other side of the verdict", () => {
  assert.deepEqual(sensitiveCases(300, 7), sensitiveCases(300, 7));
  assert.notDeepEqual(sensitiveCases(300, 7), sensitiveCases(300, 8));
  const cases = sensitiveCases(PUBLISHED_CASES, PUBLISHED_SEED);
  for (const detector of ["secret field", "typed value", "secret parameter", "email address", "phone number", "card number"] as const) {
    const mine = cases.filter((c) => c.detector === detector);
    assert.ok(mine.some((c) => c.secret) && mine.some((c) => !c.secret), `${detector} needs secret and near-miss shapes`);
  }
});

test("sensitive corpus: every secret case holds its secret in the input it is scored on", () => {
  for (const c of sensitiveCases(600, 538)) if (c.secret && c.text !== undefined) assert.ok(c.text.includes(c.hidden!), `${c.shape}: ${c.text}`);
});

test("sensitive corpus: the redaction rates in the Safety model guide are the corpus script's output", () => {
  const guide = fs.readFileSync(new URL("../docs/guide/Safety-model.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const a = guide.indexOf(SENSITIVE_RATES_BEGIN);
  const b = guide.indexOf(SENSITIVE_RATES_END);
  assert.ok(a >= 0 && b > a, "docs/guide/Safety-model.md lost its sensitive-rates markers");
  assert.equal(
    guide.slice(a, b + SENSITIVE_RATES_END.length),
    sensitiveRatesMarkdown(),
    "the published redaction rates differ from a fresh seeded run: a detector or the corpus changed. Regenerate them with `npm run sensitive-rates` and commit the guide.",
  );
});

test("sensitive corpus: the rates are bounded, so a detector that regresses fails here", () => {
  const cases = sensitiveCases(PUBLISHED_CASES, PUBLISHED_SEED);
  for (const detector of ["email address", "phone number", "card number", "secret parameter"] as const)
    assert.equal(sensitiveRates(cases, detector).missed, 0, `${detector} left a secret readable`);
  for (const detector of ["email address", "phone number"] as const)
    assert.equal(sensitiveRates(cases, detector).falseAlarms, 0, `${detector} altered text with no secret`);
  // A 19-digit number with a wrong check digit whose first 16 digits pass the check is read as a card: masking errs towards hiding.
  assert.ok(sensitiveRates(cases, "card number").falseAlarmRate < 0.01, "card number altered text with no secret");
  const all = sensitiveRates(cases);
  // The remaining misses are a secret named only by the question it answers; nothing else may be missed.
  assert.deepEqual(
    Object.keys(sensitiveRates(cases).wrongShapes).filter((k) => k.startsWith("secret ")),
    ["secret written as the question it answers"],
  );
  assert.ok(all.missRate < 0.02, `miss rate ${all.missRate}`);
  assert.ok(all.falseAlarmRate < 0.05, `false-alarm rate ${all.falseAlarmRate}`);
});
