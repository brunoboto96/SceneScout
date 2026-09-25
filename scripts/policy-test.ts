/**
 * Unit tests for the write-policy classifier and the auth-loss state machine.
 *
 * Both are small pure-ish units that shipped with zero direct coverage, and
 * both had real bugs found only by reading: `isDestructiveWire` was being
 * called with its two arguments swapped at one of its two call sites, and the
 * auth-loss notice was lost whenever the surrounding call threw. Neither is
 * expensive to pin once the logic is reachable without a browser.
 *
 *   npx tsx --test --test-name-pattern "swapped" scripts/policy-test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsWrite,
  answersWithRefusal,
  AUTH_FLOW_RE,
  destructiveRefusal,
  foreignFrameOrigin,
  foreignWrite,
  foreignFramePopupGuard,
  allowsForeignWriteOnSignIn,
  isAuthExempt,
  isDestructive,
  isDestructiveWire,
  LABEL_HEAD_WORDS,
  POLICY_REFUSAL_HEADER,
  policyRefusal,
  WRITE_MODES,
} from "../src/engine/policy.ts";
import {
  deriveCollection,
  extractCreatedIds,
  isOwnedResource,
  keyMatchesUrl,
  normalizeId,
  type CreationEvidence,
  type OwnedIds,
} from "../src/engine/ownership.ts";
import { AUTH_LOSS_STREAK, AuthLossTracker, LOGIN_ROUTE_RE } from "../src/engine/authloss.ts";
import { LOGIN_ROUTE_RE_STORAGE } from "../src/engine/memory.ts";

// ---------------------------------------------------------------------------
// isDestructiveWire — argument order is load-bearing
// ---------------------------------------------------------------------------

test("a destructive intent living only in the POST body is caught", () => {
  // The bug this pins: one call site passed (method, url) instead of
  // (pathname, body). For a POST to a generic endpoint the method never
  // matches, so the check fell through to testing the URL as if it were the
  // body — and the real payload was never inspected at all.
  const body = JSON.stringify({ query: 'mutation { deleteUser(id: "7") { ok } }' });
  assert.equal(isDestructiveWire("/graphql", body), true, "a delete mutation in the body is destructive");
  assert.equal(isDestructiveWire("/graphql", null), false, "the same endpoint with no such body is not");
});

test("swapping the arguments changes the answer — they are not interchangeable", () => {
  const pathname = "/api/widgets/7";
  const body = JSON.stringify({ query: "mutation { archiveWidget(id: 7) }" });
  assert.equal(isDestructiveWire(pathname, body), true, "correct order sees the body");
  // Method-as-url is what the buggy call site did. "POST" matches nothing, and
  // the url-as-body is a benign path, so a genuinely destructive request reads
  // as safe.
  assert.equal(isDestructiveWire("POST", pathname), false, "swapped order misses it entirely");
});

test("a DELETE path is destructive from the path alone", () => {
  assert.equal(isDestructiveWire("/api/users/3/delete", null), true);
  assert.equal(isDestructiveWire("/api/users/bulk-delete", null), true);
  assert.equal(isDestructiveWire("/api/users/3", null), false, "a plain resource path is not");
});

test("the body is only read up to a bound", () => {
  // Guards against a multi-megabyte upload body being regex-scanned in full.
  // Uses a command-key signal (not a bare keyword) since that is what the body
  // scan now looks for.
  const signal = '{"action":"delete"}';
  assert.equal(isDestructiveWire("/api/upload", `${"x".repeat(5000)}${signal}`), false, "past the 2000-char window it is not scanned");
  assert.equal(isDestructiveWire("/api/upload", `${signal}${"x".repeat(5000)}`), true, "within the window it is");
});

test("a destructive word in ordinary CONTENT does not block a create/submit POST", () => {
  // The regression this pins, seen live twice: a document being analysed contained
  // "Remove jewellery" and a description said the record was "Safe to delete";
  // the old body scan matched the bare keyword and refused POST /api/ai/analyze
  // and a plain create. A request body is frequently user content — a keyword
  // in prose is not destructive intent.
  assert.equal(
    isDestructiveWire("/api/ai/analyze", "1. Take off the wrapper. 2. Remove the old draft and archive it."),
    false,
    "prose mentioning remove/archive is not a destructive request",
  );
  assert.equal(
    isDestructiveWire(
      "/api/tickets",
      JSON.stringify({ title: "Old request", description: "The customer asked us to delete their data and purge the archive." }),
    ),
    false,
    "destructive words as ordinary field values are content, not commands",
  );
  assert.equal(
    isDestructiveWire("/api/documents", JSON.stringify({ title: "How to delete a user", action: "create" })),
    false,
    "a create action whose title merely mentions deletion is allowed",
  );
});

test("STRUCTURED destructive intent in a body is still caught", () => {
  // A command-like key with a destructive value is a genuine destructive POST.
  assert.equal(isDestructiveWire("/api/batch", JSON.stringify({ action: "delete", ids: [1, 2, 3] })), true, "action:delete");
  assert.equal(isDestructiveWire("/api/records", JSON.stringify({ operation: "archive", id: 5 })), true, "operation:archive");
  assert.equal(isDestructiveWire("/api/x", JSON.stringify({ _method: "DELETE" })), true, "_method:DELETE (case-insensitive)");
  assert.equal(isDestructiveWire("/api/form", "action=delete&id=3"), true, "form-encoded command field");
  // ...but a command key with a SAFE value, or destructive words under other
  // keys, are not.
  assert.equal(isDestructiveWire("/api/x", JSON.stringify({ action: "create" })), false, "action:create is not destructive");
  assert.equal(isDestructiveWire("/api/notes", JSON.stringify({ note: "delete", tag: "remove" })), false, "non-command keys are content");
  assert.equal(isDestructiveWire("/api/x", JSON.stringify({ prop: "delete" })), false, "'op' inside 'prop' is not a command key");
  // A command key must look STRUCTURAL. Sentence-shaped prose that happens to
  // contain "<word>: delete" is the very false-positive this fix exists to
  // kill, so it must not come back through the command branch.
  assert.equal(
    isDestructiveWire("/api/tickets", JSON.stringify({ description: "Our intent: delete duplicate accounts next quarter." })),
    false,
    "prose with a colon is not a command field",
  );
  assert.equal(
    isDestructiveWire("/api/notes", "The plan of action: delete the old records once approved."),
    false,
    "an unquoted prose phrase is not a command field",
  );
  // ...while the real structural forms still match, including JSON-Patch.
  assert.equal(isDestructiveWire("/api/patch", JSON.stringify([{ op: "remove", path: "/a" }])), true, "JSON-Patch op:remove");
  assert.equal(isDestructiveWire("/api/x?action=delete&id=3", null), true, "query-string command on the URL");
});

// ---------------------------------------------------------------------------
// isDestructive — UI-label matching
// ---------------------------------------------------------------------------

test("destructive labels are caught across the languages the list covers", () => {
  for (const label of ["Delete account", "Remove user", "Eliminar", "Supprimer", "削除", "удалить"]) {
    assert.equal(isDestructive(label), true, `expected destructive: ${label}`);
  }
});

test("ordinary labels are left alone", () => {
  for (const label of ["Save draft", "Publish now", "Add row", "Submit for approval", "Next"]) {
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  }
});

test("a non-destructive 'reset' is not refused", () => {
  // `\breset\b` used to match every one of these. Refusing them in read-only
  // mode cost real coverage — a filter reset destroys nothing, and the engine
  // skipping it means the page's own controls never get exercised.
  for (const label of ["Reset filters", "Reset zoom", "Reset search", "Reset password"]) {
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  }
  // ...while the genuinely destructive sense still is.
  assert.equal(isDestructive("Reset workspace"), true);
  assert.equal(isDestructive("Factory reset"), true);
  assert.equal(isDestructive("Reset all data"), true);
});

test("a description inside a control is not its command", () => {
  // A role card on a sign-in page is one button whose accessible name is the
  // role's name plus a sentence about it. "sign-off" in that sentence refused
  // the click in read-only mode, so the manager role was unreachable and a
  // whole lane came back partial. The verb the click sends is at the head of
  // a label; a paragraph after it is content.
  assert.equal(isDestructive("Manager Approves or rejects orders that need sign-off."), false);
  assert.equal(isDestructive("Operator Runs the nightly jobs and may archive old reports."), false, "a Latin verb deep in the sentence");
  assert.equal(isDestructive("Reviewer\nApproves or rejects\nrequests that can archive old ones."), false, "newlines between the card's spans");
  // ...while a long label that LEADS with the verb is still the command.
  assert.equal(isDestructive("Delete this project and everything in it, permanently"), true);
  assert.equal(isDestructive("Remove all 14 selected users from the workspace now"), true);
  // The boundary, built from the constant so the test moves with it. The
  // trailing sentence is what makes the label prose.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.equal(isDestructive(`${filler(LABEL_HEAD_WORDS - 1)} delete it. Then go home.`), true, "the verb as the head's last word");
  assert.equal(isDestructive(`${filler(LABEL_HEAD_WORDS)} delete it. Then go home.`), false, "the verb just past the head");
  // The pattern sees the whole label: an exemption that looks past the
  // boundary still applies, and a two-word pattern straddling it still matches.
  assert.equal(isDestructive("Use this control to quickly reset filters. Handy."), false, "'filters' is past the head, 'reset' is not");
  assert.equal(isDestructive("Yes I want to really cancel subscription. Now."), true, "'cancel' is in the head");
  // Only prose is judged by its head. A long label with no sentence in it is
  // a command however it is worded, so a confirm button stays refused.
  assert.equal(isDestructive("Yes, I am sure I want to delete this"), true);
  assert.equal(isDestructive("I understand this cannot be undone, delete everything"), true);
  assert.equal(isDestructive("Danger zone This cannot be undone. Permanently delete the repository."), false, "a heading plus a sentence is a description");
});

test("'sign off' is destructive as a verb, not as the noun approval apps use", () => {
  for (const label of [
    "Sign off",
    "Sign-off",
    "Sign off now",
    "(Sign off)",
    "\n  Sign off",
    "Confirm sign off",
    "Save and sign off now",
    "Approve and sign off",
  ]) {
    assert.equal(isDestructive(label), true, `expected destructive: ${label}`);
  }
  // The noun is told by the word before it, the way the reset rule is told by
  // the word after. A label that leads with the noun ("Sign-off required")
  // still matches, and a status chip worded that way pays for it.
  for (const label of ["Needs sign-off", "Awaiting sign off", "Send for sign-off", "2 orders pending sign-off", "Requires sign-off from a manager"]) {
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  }
});

test("isDestructive ignores empty and absent labels", () => {
  assert.equal(isDestructive(null, undefined, ""), false);
});

test("auth flows are recognised so they survive a strict write policy", () => {
  for (const p of ["/api/auth/login", "/api/session", "/oauth/token", "/api/auth/refresh"]) {
    assert.equal(AUTH_FLOW_RE.test(p), true, `expected auth flow: ${p}`);
  }
  assert.equal(AUTH_FLOW_RE.test("/api/widgets"), false);
});

test("the refusal message tells the caller how to proceed, not just no", () => {
  const msg = destructiveRefusal("Delete account");
  assert.ok(msg.includes("Delete account"), "names what was refused");
  assert.ok(msg.includes("destructive"), "names the mode that would allow it");
  assert.ok(msg.includes("do not attempt this element again"), "tells the agent not to retry");
});

// ---------------------------------------------------------------------------
// AuthLossTracker
// ---------------------------------------------------------------------------

const BASE = "http://app.test";

test("a bounce to a login page is detected; asking for login is not", () => {
  const t = new AuthLossTracker();
  assert.equal(t.isLoginRedirect("/documents", `${BASE}/login`, BASE), true);
  // The anonymous auth-surface pass walks /login deliberately.
  assert.equal(t.isLoginRedirect("/login", `${BASE}/login`, BASE), false);
  // crawl passes slash-less targets; normalizing inside means they behave the same.
  assert.equal(t.isLoginRedirect("login", `${BASE}/login`, BASE), false);
});

test("an ordinary redirect is not a login bounce", () => {
  const t = new AuthLossTracker();
  assert.equal(t.isLoginRedirect("/old", `${BASE}/new`, BASE), false);
});

test("the verdict needs a streak, and one good navigation clears it", () => {
  const t = new AuthLossTracker();
  const bounce = () => {
    t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
    return t.take();
  };
  for (let i = 1; i < AUTH_LOSS_STREAK; i++) {
    assert.ok(!bounce().includes("SESSION AUTH LOST"), `bounce ${i} is not yet a verdict`);
  }
  assert.ok(bounce().includes("SESSION AUTH LOST"), "the threshold bounce delivers the verdict");

  t.record({ requestedRoute: "/b", landedRoute: "/b", bounced: false, role: "admin" });
  t.take();
  assert.ok(!bounce().includes("SESSION AUTH LOST"), "a successful navigation resets the streak");
});

test("the notice is consumed exactly once", () => {
  // Left set, it prepended a stale "REDIRECTED: asked for X" onto the NEXT,
  // unrelated call — which is what happened whenever navigate() threw before
  // reaching its return.
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
  assert.ok(t.take().includes("REDIRECTED"), "first take gets it");
  assert.equal(t.take(), "", "a second take gets nothing");
});

test("clear() drops an undelivered notice so it cannot leak forward", () => {
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
  t.clear();
  assert.equal(t.take(), "", "the stale notice is gone");
});

test("a redirect that is not a bounce says the route still counts as covered", () => {
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/admin", landedRoute: "/", bounced: false, role: "viewer" });
  const notice = t.take();
  assert.ok(notice.includes("REDIRECTED"), "the divergence is still reported");
  assert.ok(notice.includes("counts as covered for role 'viewer'"), "and is attributed to the role");
  assert.ok(!notice.includes("SESSION AUTH LOST"), "a permission wall is not auth loss");
});

test("the batch verdict survives a sweep whose last route happened to succeed", () => {
  // A crawl records every route in turn, so only the final notice survives to
  // be taken. Token dies, forty routes bounce, the sweep then reaches a public
  // route — the streak resets and the crawl used to report nothing wrong.
  const t = new AuthLossTracker();
  for (let i = 0; i <= AUTH_LOSS_STREAK; i++) {
    t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
    t.clear();
  }
  t.record({ requestedRoute: "/public", landedRoute: "/public", bounced: false, role: "admin" });
  t.clear();
  assert.ok(t.batchVerdict().includes("SESSION AUTH LOST"), "the sweep still reports the session died");
});

test("a clean sweep produces no batch verdict", () => {
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/a", landedRoute: "/a", bounced: false, role: "admin" });
  t.clear();
  assert.equal(t.batchVerdict(), "", "nothing went wrong, so nothing is claimed");
});

test("the login pattern matches a segment, not a substring", () => {
  assert.equal(LOGIN_ROUTE_RE.test("/login"), true);
  assert.equal(LOGIN_ROUTE_RE.test("/auth/callback"), true);
  assert.equal(LOGIN_ROUTE_RE.test("/login.html"), false, "an extension is not a login route segment");
  assert.equal(LOGIN_ROUTE_RE.test("/logindetails"), false, "nor is a longer word starting with it");
});

test("the two copies of the login pattern have not drifted apart", () => {
  // memory.ts cannot import from the engine layer, so the pattern is duplicated
  // on purpose. A comment used to assert this was "kept in sync by the
  // migration test" — no test compared them, so editing one (adding `sso`, say)
  // would silently leave the storage layer classifying bounces differently from
  // the engine that detects them. This is that test.
  assert.equal(LOGIN_ROUTE_RE_STORAGE.source, LOGIN_ROUTE_RE.source, "storage-layer and engine-layer login patterns must stay identical");
  assert.equal(LOGIN_ROUTE_RE_STORAGE.flags, LOGIN_ROUTE_RE.flags);
});

// ---------------------------------------------------------------------------
// Ownership (safe-write): which records did this run create?
// A wrong "yes" here licenses a real DELETE on pre-existing data.
// ---------------------------------------------------------------------------

const created = (over: Partial<CreationEvidence>): CreationEvidence => ({ pathname: "/api/widgets", status: 201, requestBody: "", ...over });

test("ownership: a plain create claims the id the server minted", () => {
  assert.deepEqual(extractCreatedIds(created({ body: { id: 41, name: "w" } })), { collection: "/api/widgets", identityCollection: false, ids: ["41"] });
  assert.deepEqual(extractCreatedIds(created({ status: 200, body: { data: { uuid: "a1b2" } } })).ids, ["a1b2"], "ids nested under data/result/item are found");
  assert.deepEqual(extractCreatedIds(created({ location: "/api/widgets/77?x=1", body: undefined })).ids, ["77"], "a Location header alone is enough");
});

test("ownership: an id named after its resource is claimed, a foreign key beside it is not", () => {
  // {widget_id, owner_id}: owner_id is server-derived, so the request-echo
  // filter never sees it — only the key-names-this-URL rule keeps it out.
  const v = extractCreatedIds(created({ body: { widget_id: 9, owner_id: 3, createdById: 3 } }));
  assert.deepEqual(v.ids, ["9"]);
  assert.equal(keyMatchesUrl("widget_id", "/api/widgets"), true);
  assert.equal(keyMatchesUrl("owner_id", "/api/widgets"), false);
  assert.equal(keyMatchesUrl("orderItemId", "/api/order-items"), true, "camelCase key against a hyphenated segment");
  assert.equal(keyMatchesUrl("duplicate_id", "/api/widgets/duplicate"), false, "a key named after the RPC verb does not name the resource");
});

test("ownership: an id the client already sent is an echo, not a creation", () => {
  // Upsert: 200 with the id that was in the request body.
  assert.deepEqual(extractCreatedIds(created({ status: 200, body: { id: "555" }, requestBody: '{"id":"555","name":"x"}' })).ids, []);
  // ...but a 201 excuses a BARE id the client supplied (client-generated ids).
  assert.deepEqual(extractCreatedIds(created({ status: 201, body: { id: "555" }, requestBody: '{"id":"555"}' })).ids, ["555"]);
  // A PREFIXED key is never excused: it is exactly what an echoed foreign key looks like.
  const fromTemplate = extractCreatedIds(
    created({ pathname: "/api/widgets/from-template/5", status: 201, body: { widget_id: 88, template_id: 5 }, requestBody: '{"template_id":5}' }),
  );
  assert.deepEqual(fromTemplate.ids, ["88"], "the template that was copied FROM is not ours");
  // An id in the request PATH addresses an existing record, whatever comes back.
  assert.deepEqual(extractCreatedIds(created({ pathname: "/api/widgets/123/publish", body: { id: 123 } })).ids, []);
});

test("ownership: identity collections are listed for cleanup but never grant write access", () => {
  const v = extractCreatedIds(created({ pathname: "/api/users", body: { id: 12 } }));
  assert.equal(v.identityCollection, true);
  assert.deepEqual(v.ids, ["12"]);
  assert.equal(extractCreatedIds(created({ pathname: "/api/widgets", body: { id: 12 } })).identityCollection, false);
});

test("ownership: one response cannot mint a page of ownership", () => {
  const body = { data: { id: 1 }, result: { id: 2 }, item: { id: 3 }, uuid: "u4", _id: "x5", id: 6 };
  assert.equal(extractCreatedIds(created({ body })).ids.length, 5);
});

test("ownership: the creation collection is collapsed before any RPC verb", () => {
  assert.equal(deriveCollection("/api/widgets/from-template/5"), "/api/widgets");
  assert.equal(deriveCollection("/api/widgets/5/comments"), "/api/widgets/5/comments", "a nested create is not truncated at the numeric segment");
  assert.equal(deriveCollection("/clone"), "/clone", "never an empty collection");
});

const owns = (collection: string, id: string, pathname: string): boolean => isOwnedResource(new Map([[id, new Set([collection])]]) as OwnedIds, pathname);

test("ownership: the four path shapes a created record is reached by", () => {
  // 1. directly under the collection, and anything beneath the record
  assert.equal(owns("/api/widgets", "88", "/api/widgets/88"), true);
  assert.equal(owns("/api/widgets", "88", "/api/widgets/88/attachments/2"), true);
  assert.equal(owns("/widgets", "88", "/widgets/88"), true, "an API with no /api prefix");
  assert.equal(owns("/api/widgets/", "88", "/api/widgets/88"), true, "a stored trailing slash");
  // 2. a verb between the collection and the id
  assert.equal(owns("/api/widgets", "88", "/api/widgets/archive/88"), true);
  assert.equal(owns("/api/widgets", "88", "/api/widgets/bulk/delete/88"), true);
  // 3. a verb in the CREATION path, below the collection
  assert.equal(owns("/api/widgets/quick", "7", "/api/widgets/7"), true);
  // 4. created nested under a parent record, addressed at the top level afterwards
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/tasks/9"), true);
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/projects/3/tasks/9"), true);
});

test("ownership never steps across another record's id", () => {
  // Numeric ids collide across tables: "9 is ours under tasks" says nothing
  // about project 9, order 77, or widget 12's link 88 — all pre-existing data.
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/projects/9"), false, "a task's id is not a project's id");
  assert.equal(owns("/api/orders/5/items", "77", "/api/orders/77"), false);
  assert.equal(owns("/api/widgets", "88", "/api/widgets/12/links/88"), false, "88 under somebody else's widget 12");
  assert.equal(owns("/api/widgets", "88", "/api/widgets/89"), false, "a neighbour");
  assert.equal(owns("/api/widgets", "88", "/api/gadgets/88"), false, "the same id in another collection");
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/projects/4/tasks/9"), false, "same id under a different parent record");
  assert.equal(owns("/api/widgets", "88", "/api/widgets/0a1b2c3d4e5f/88"), false, "a hex token in between is an id too");
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/subtasks/9"), false, "shallow nesting needs the SAME collection name");
  assert.equal(owns("/api/tasks", "9", "/api/v2/tasks/9"), false, "a flat create does not license a differently-rooted path");
  // The word between a collection and an id is as often a SUB-COLLECTION as a
  // verb, so only allowlisted verbs are accepted in either position.
  assert.equal(owns("/api/widgets", "88", "/api/widgets/links/88"), false, "link 88 is not widget 88");
  assert.equal(owns("/api/widgets/links", "7", "/api/widgets/7"), false, "creating link 7 does not license a write on widget 7");
});

test("ownership: a generic creation endpoint owns its own path and nothing else", () => {
  // POST /api (or /rpc) stores a collection that prefixes the whole app.
  assert.equal(owns("/api", "7", "/api/7"), true);
  assert.equal(owns("/api", "7", "/api/gadgets/7"), false);
  assert.equal(owns("/api", "7", "/api/gadgets/7/children/1"), false);
});

test("ownership: ids match whatever case or encoding the URL uses", () => {
  const owned: OwnedIds = new Map([[normalizeId("7B2E9F10-AAAA-4BBB-8CCC-1234567890AB"), new Set(["/api/widgets"])]]);
  assert.equal(isOwnedResource(owned, "/api/widgets/7b2e9f10-aaaa-4bbb-8ccc-1234567890ab"), true);
  assert.equal(isOwnedResource(owned, "/api/widgets/7B2E9F10-AAAA-4BBB-8CCC-1234567890AB"), true);
  const spaced: OwnedIds = new Map([[normalizeId("Q3 plan"), new Set(["/api/docs"])]]);
  assert.equal(isOwnedResource(spaced, "/api/docs/Q3%20plan"), true);
  assert.equal(normalizeId("100%"), "100%", "a stray percent sign is compared as written, not thrown on");
});

test("the wire decision, mode by mode", () => {
  // columns: method, destructive-looking?, addresses a record this run created?
  const cases: Array<[string, boolean, boolean]> = [
    ["POST", false, false], // an ordinary form submission
    ["POST", true, false], // POST /items/7/archive
    ["POST", true, true], // ...on our own record
    ["PUT", false, false],
    ["PUT", false, true],
    ["DELETE", false, false],
    ["DELETE", false, true],
  ];
  const table = (mode: (typeof WRITE_MODES)[number]) => cases.map(([method, destructive, owned]) => allowsWrite(mode, method, destructive, owned));

  assert.deepEqual(
    table("observe"),
    [false, false, false, false, false, false, false],
    "observe lets nothing but GETs leave the page — not even an ordinary form POST, not even on a record the run owns",
  );
  assert.deepEqual(table("read-only"), [true, false, true, false, false, false, false], "read-only lets plain POSTs through and nothing that edits or deletes");
  assert.deepEqual(table("safe-write"), [true, false, true, false, true, false, true], "safe-write edits and deletes only what the run created");
  assert.deepEqual(table("destructive"), [true, true, true, true, true, true, true]);
  assert.deepEqual([...WRITE_MODES], ["observe", "read-only", "safe-write", "destructive"], "ordered from strictest to loosest");
});

test("the auth exemption never covers a destructive request, in any mode", () => {
  // The exemption used to be tested before the destructive check, so a path
  // that merely contained "session" or "auth" carried a delete through read-only.
  for (const mode of WRITE_MODES) {
    assert.equal(isAuthExempt(mode, "POST", "/api/session/123/delete", true), false, mode);
    assert.equal(isAuthExempt(mode, "POST", "/api/auth/users/5/delete", true), false, mode);
    assert.equal(isAuthExempt(mode, "PUT", "/api/auth/login", false), false, `${mode}: only POST is ever exempt`);
  }
  assert.equal(isAuthExempt("read-only", "POST", "/api/auth/login", false), true);
  assert.equal(isAuthExempt("read-only", "POST", "/signup", false), true, "outside observe, signing up is part of the auth surface a tester walks");
});

test("in observe mode only the requests a login itself needs are exempt", () => {
  const exempt = (p: string): boolean => isAuthExempt("observe", "POST", p, false);
  // A session has to be able to exist.
  for (const p of [
    "/login",
    "/api/auth/login",
    "/api/v1/auth/sign-in",
    "/auth/token/refresh",
    "/oauth/token",
    "/api/session",
    "/api/sessions",
    "/logout",
    "/sso/callback",
  ]) {
    assert.equal(exempt(p), true, `${p} should be let through`);
  }
  // Everything else changes data on the target, whatever word is in its path.
  for (const p of [
    "/signup",
    "/api/auth/signup",
    "/api/auth/register",
    "/api/auth/users", // invite or create a user
    "/account/password",
    "/api/user/password/change",
    "/password/reset/confirm",
    "/verify/documents/12/approve",
    "/users/login-history/clear", // "login" as part of a longer segment
    "/api/tokens", // mint an API token
    "/api/session/123/extend", // acts ON a session
    "/api/orders",
    "/",
  ]) {
    assert.equal(exempt(p), false, `${p} must be blocked in observe`);
  }
});

test("a blocked script request is answered with a refusal; a blocked navigation is dropped", () => {
  assert.equal(answersWithRefusal("fetch"), true);
  assert.equal(answersWithRefusal("xhr"), true);
  // Answering a form post would replace the page the user was on with the stand-in body.
  assert.equal(answersWithRefusal("document"), false);
  for (const other of ["ping", "beacon", "other", "image"]) assert.equal(answersWithRefusal(other), false, other);
});

test("the policy's refusal is a marked 403 the page can read", () => {
  const same = policyRefusal("read-only", "DELETE", "/api/things/9");
  // 403: a 5xx invites retries and a 401 reads as "signed out" to many apps.
  assert.equal(same.status, 403);
  assert.match(same.headers[POLICY_REFUSAL_HEADER], /mode=read-only/);
  assert.equal(same.headers["content-type"], "application/json");
  const body = JSON.parse(same.body) as { error: string; message: string };
  assert.equal(body.error, "Forbidden");
  assert.match(body.message, /DELETE \/api\/things\/9/);
  assert.match(body.message, /never received/);
  // No Origin header, no CORS headers: nothing to echo.
  assert.equal(same.headers["access-control-allow-origin"], undefined);

  // A cross-origin API call has to be allowed to read the refusal, or it fails as a network error and is dropped all over again.
  const cross = policyRefusal("observe", "POST", "/api/things", "http://app.test");
  assert.equal(cross.headers["access-control-allow-origin"], "http://app.test");
  assert.equal(cross.headers["access-control-allow-credentials"], "true");
});

test("foreignFrameOrigin: a write is foreign when a frame of another site sent it", () => {
  const app = "http://app.test:3000/orders";
  for (const [chain, expected, why] of [
    [[], null, "the top document"],
    [["http://app.test:3000/widget"], null, "a same-origin frame"],
    [["https://forms.example.com/embed"], "https://forms.example.com", "a third party's embedded form"],
    [["http://app.test:4000/embed"], "http://app.test:4000", "another port is another origin"],
    [["about:blank", "https://chat.example.com/w"], "https://chat.example.com", "a blank frame belongs to the frame that made it"],
    [["about:blank"], null, "a blank frame made by the app"],
    [["http://app.test:3000/inner", "https://pay.example.com/box"], "https://pay.example.com", "an app page nested inside a widget is still driven by it"],
    [["not a url"], null, "an address that cannot be read decides nothing"],
  ] as const) {
    assert.equal(foreignFrameOrigin(app, chain), expected, why);
  }
});

test("foreignWrite: a write started by another site and headed outside the app", () => {
  const app = "http://app.test:3000/checkout";
  const at = (over: Partial<Parameters<typeof foreignWrite>[1]>) =>
    foreignWrite(app, { url: "https://forms.example.com/submit", frameChain: [], frameUrl: app, ...over });
  // The frame the browser reports.
  assert.equal(at({ frameChain: ["https://forms.example.com/embed"], frameUrl: "https://forms.example.com/embed" }), "https://forms.example.com");
  assert.equal(
    at({ frameChain: ["http://app.test:3000/widget"], frameUrl: "http://app.test:3000/widget" }),
    null,
    "a same-origin frame's call out is the app's own",
  );
  // A foreign frame's form aimed at _top: reported against the top page, but its Origin header names the frame's site.
  assert.equal(at({ originHeader: "https://forms.example.com" }), "https://forms.example.com", "target=_top");
  assert.equal(at({ frameUrl: null, originHeader: "https://forms.example.com" }), "https://forms.example.com", "target=_blank or a popup: no frame at all");
  // The contrasts: the header says nothing new.
  assert.equal(at({ originHeader: "http://app.test:3000" }), null, "the app's own page calling a third party");
  assert.equal(at({ frameUrl: "https://idp.example.com/login", originHeader: "https://idp.example.com" }), null, "a sign-in page loaded as the whole page");
  assert.equal(at({ originHeader: "null" }), null, "an opaque origin says nothing");
  // A foreign frame writing into the app: a sign-in reply to the app's callback.
  assert.equal(
    at({ url: "http://app.test:3000/auth/callback", frameChain: ["https://idp.example.com/authorize"], frameUrl: "https://idp.example.com/authorize" }),
    null,
    "a write that lands in the app is the ordinary rules' business",
  );
  // A popup a foreign frame opened on its own site: header and page agree, but the session never adopted that page.
  assert.equal(
    at({ frameUrl: "https://forms.example.com/thanks", originHeader: "https://forms.example.com", unadoptedPageUrl: "https://forms.example.com/thanks" }),
    "https://forms.example.com",
  );
  assert.equal(at({ unadoptedPageUrl: null, originHeader: "http://app.test:3000" }), null, "the session's own page");
  // "Origin: null" (a no-referrer frame) out of the app, only when the page embeds another site.
  assert.equal(at({ originHeader: "null", pageHasForeignFrame: true }), "an embedded frame (Origin: null)");
  assert.equal(at({ originHeader: "null", pageHasForeignFrame: false }), null);
});

test("allowsForeignWriteOnSignIn: a captcha frame on the app's own sign-in page, outside observe", () => {
  const app = "http://app.test/";
  assert.equal(allowsForeignWriteOnSignIn("read-only", "http://app.test/login", app), true);
  assert.equal(allowsForeignWriteOnSignIn("safe-write", "http://app.test/auth/sign-in?next=/", app), true);
  assert.equal(allowsForeignWriteOnSignIn("read-only", "http://app.test/account/login.html", app), true, "a file extension is ignored");
  assert.equal(allowsForeignWriteOnSignIn("observe", "http://app.test/login", app), false, "observe sends the login request and nothing else");
  // The contrasts: where a payment provider's frame sits, and pages that only mention a sign-in word.
  for (const path of ["/checkout", "/checkout/verify", "/orders/verify-order", "/admin/token-list", "/session-report", "/password"]) {
    assert.equal(allowsForeignWriteOnSignIn("read-only", `http://app.test${path}`, app), false, path);
  }
  assert.equal(allowsForeignWriteOnSignIn("read-only", "https://idp.example.com/login", app), false, "a sign-in page of another site");
  assert.equal(allowsForeignWriteOnSignIn("read-only", "not a url", app), false);
});

test("foreignFramePopupGuard: carries the app's origin, and stays off without one", () => {
  const guard = foreignFramePopupGuard("http://app.test:3000/orders?x=1");
  assert.match(guard, /const APP = "http:\/\/app\.test:3000";/);
  assert.match(guard, /window\.open = function \(\) \{ return null; \}/);
  assert.match(foreignFramePopupGuard("not a url"), /const APP = "";/);
});
