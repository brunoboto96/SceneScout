/**
 * Unit tests for the memory layer: finding dedup (the tiered sameFinding via
 * addFinding), retroMerge, regression reopening, and coverage aggregation.
 * Drives the compiled MemoryStore against a temp directory — see smoke.ts for
 * why dist/ is imported rather than src/.
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
import { LEGACY_MEMORY_DIRNAME, MEMORY_DIRNAME, MemoryStore, adoptLegacyMemoryDir, mergeMemory, redactSecrets } from "../dist/engine/memory.js";

/** Temp dirs created by the running test, cleaned up even when it fails. */
let dirs: string[] = [];

function freshStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-memtest-"));
  dirs.push(dir);
  return new MemoryStore(dir);
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const base = { severity: "medium" as const, category: "http-error", url: "http://x/a", state: "/a#f1" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("dedup: an endpoint signature match needs the SAME status, not just the same path", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, state: "/a#1", title: "Create fails", detail: "x", evidence: "POST /api/things 500" });
  const [, new2] = store.addFinding({ ...base, state: "/b#2", title: "Create is forbidden for this role", detail: "y", evidence: "POST /api/things 403" });
  assert.ok(new1 && new2, "a 500 and a 403 on one endpoint are different bugs");
});

test("dedup: endpoint signatures collapse record ids so one bug is not filed per record", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, state: "/orders/:id#1", title: "Effectiveness 404 on order 176", detail: "x", evidence: "GET /api/orders/176/effectiveness 404" });
  const [, new2] = store.addFinding({ ...base, state: "/orders/:id#2", title: "Effectiveness 404 on order 181", detail: "y", evidence: "GET /api/orders/181/effectiveness 404" });
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
  const [, isNew] = store.addFinding({ ...base, state: "/b#2", title: "Create 500s when the customer is archived", detail: "y", evidence: "POST /api/orders 500 archived customer" });
  assert.equal(isNew, true, "a fixed bug must not absorb a different new one on the same endpoint");
});

test("dedup: the endpoint rule needs the same CATEGORY", () => {
  // One endpoint+status can carry two genuinely different bugs.
  const store = freshStore();
  store.addFinding({ ...base, category: "security", state: "/a#1", title: "Role boundary leaks", detail: "x", evidence: "GET /api/admin 403" });
  const [, isNew] = store.addFinding({ ...base, category: "ux-confusing", state: "/b#2", title: "403 shows a blank page with no explanation", detail: "y", evidence: "GET /api/admin 403" });
  assert.equal(isNew, true, "a security finding and a UX finding on one endpoint are two bugs");
});

test("dedup: a finding with no METHOD+path evidence is untouched by the endpoint rule", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, state: "/a#1", title: "Contrast fails on the banner", detail: "x", evidence: "banner contrast 3.1:1" });
  const [, new2] = store.addFinding({ ...base, state: "/b#2", title: "Tap target too small on the footer", detail: "y", evidence: "footer target 16x16" });
  assert.ok(new1 && new2, "non-endpoint evidence must not collide");
});

test("dedup tier 2: a literal quoted in a TITLE bridges differing evidence", () => {
  const store = freshStore();
  const [, new1] = store.addFinding({ ...base, title: 'Save shows "Document not found anymore"', detail: "x", evidence: "PUT /api/docs/1 404" });
  const [, new2] = store.addFinding({ ...base, title: "Editing fails with an error toast", detail: 'Toast says "Document not found anymore" after save.', evidence: "toast document-not-found" });
  assert.equal(new1, true);
  assert.equal(new2, false, "one states the string in its title, the other in its detail — same bug");
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
    id, severity: "medium", category: "http-error", title, detail: "d",
    evidence: "GET /api/reports 403", url: "http://x/a", state: "/a#f1", repro: [], foundAt: "2026-01-01T00:00:00Z", runs, ...(status ? { status } : {}),
  });
  fs.writeFileSync(
    path.join(memDir, "memory.json"),
    JSON.stringify({ version: 1, states: {}, findings: [dup("aaa", "Reports endpoint 403 for User", 2), dup("bbb", "User role denied by reports endpoint", 3, "resolved")] }),
  );
  const store = new MemoryStore(dir);
  assert.equal(store.findings.length, 1, "duplicates should merge to one entry");
  assert.equal(store.findings[0]?.runs, 5, "run counts should sum");
  assert.equal(store.findings[0]?.status, "resolved", "resolved status should survive the merge");
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
  const second = new MemoryStore(path.dirname(store.dir));
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
  store.visitState("/a#f1", "http://x/a", "/a", ["button:save"]); // schedules a debounced save() at 500ms
  await sleep(700);
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
  const reloaded = new MemoryStore(projectDir);
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

test("redaction is stable, so the same leak re-found is one finding, not two", () => {
  const store = freshStore();
  const mk = (key: string) =>
    store.addFinding({ ...base, title: "Upstream error leaks a key", detail: `key: sk-live-${key}`, evidence: "POST /api/ai 500" });
  const [, firstIsNew] = mk("AAAABBBBCCCCDDDD");
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

  const reloaded = new MemoryStore(projectDir);
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
    import { MemoryStore } from ${JSON.stringify(new URL("../dist/engine/memory.js", import.meta.url).href)};
    const s = new MemoryStore(${JSON.stringify(projectDir)});
    s.addFinding({ severity: "high", category: "http-error", title: "Theirs: delete button 403s",
      detail: "y", evidence: "DELETE /api/x 403", url: "http://x/b", state: "/b#f1" });
    s.flush();
  `;
  const childFile = path.join(projectDir, "child.mjs");
  fs.writeFileSync(childFile, child);
  execFileSync(process.execPath, [childFile], { stdio: "pipe" });

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
  const mine = { version: 1 as const, states: { "/a#1": { url: "u", route: "/a", firstSeen: "2026-01-02", visits: 1, elements: { "button:save": { exercised: true }, "button:open": { exercised: false } } } }, findings: [] };
  const theirs = { version: 1 as const, states: { "/a#1": { url: "u", route: "/a", firstSeen: "2026-01-01", visits: 4, elements: { "button:save": { exercised: false }, "button:cancel": { exercised: true } } } }, findings: [] };
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
  const reopened = new MemoryStore(path.dirname(store.dir));
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
  const seeded = new MemoryStore(project); // first attach after the rename
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
  assert.equal(new MemoryStore(untouched).legacyDirNote, null, "a fresh project has nothing to adopt");
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

