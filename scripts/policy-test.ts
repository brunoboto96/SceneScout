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
import { AUTH_FLOW_RE, destructiveRefusal, isDestructive, isDestructiveWire, withoutBlocked } from "../src/engine/policy.ts";
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

test("a request the policy blocked is not also reported as a possible mutation", () => {
  // The two recorders truncate the URL to different lengths, so the match is
  // by prefix — in either direction.
  const long = "http://x/api/items/" + "9".repeat(130);
  const mutations = [{ sig: "DELETE http://x/api/items/999" }, { sig: "POST http://x/api/items" }, { sig: `PUT ${long}`.slice(0, 124) }];
  const blocked = [{ sig: "DELETE http://x/api/items/999" }, { sig: `PUT ${long}`.slice(0, 144) }];
  assert.deepEqual(withoutBlocked(mutations, blocked), [{ sig: "POST http://x/api/items" }], "only the request that went through is a possible mutation");
  assert.equal(withoutBlocked(mutations, []).length, 3, "nothing blocked, nothing dropped");
  // A different method on the same URL did go through and must still be reported.
  assert.deepEqual(withoutBlocked([{ sig: "POST http://x/api/items/999" }], blocked), [{ sig: "POST http://x/api/items/999" }]);
});
