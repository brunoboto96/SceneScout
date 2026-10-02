/**
 * The rules behind scout_request: what may be called, where it may be sent,
 * what the page is asked to run, and what comes back. The one page.evaluate
 * lives in browser.ts and is covered by the browser suite.
 *
 *   npx tsx --test scripts/request-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authToRemember,
  BODY_FETCH_MAX,
  BODY_MAX,
  formatPageRequests,
  PageRequests,
  shownUrl,
  buildRequestScript,
  selectSteps,
  VIEW_MAX,
  viewBody,
  formatReplay,
  replaySignature,
  REPORTED_HEADERS,
  requestHeaders,
  resolveMethod,
  resolveRequestUrl,
  staleCredentialNote,
  toReplayResult,
} from "../src/engine/request.ts";

const BASE = "http://localhost:3000/";

test("a path resolves against the attached origin", () => {
  assert.deepEqual(resolveRequestUrl(BASE, "/api/things"), { url: "http://localhost:3000/api/things" });
  assert.deepEqual(resolveRequestUrl(BASE, "api/things"), { url: "http://localhost:3000/api/things" });
  assert.deepEqual(resolveRequestUrl(BASE, "/api/things?a=1&b=2"), { url: "http://localhost:3000/api/things?a=1&b=2" });
  assert.deepEqual(resolveRequestUrl(BASE, "http://localhost:3000/api/x"), { url: "http://localhost:3000/api/x" });
});

test("…and is fenced to it, like navigation is", () => {
  // A session talks to its own app. Otherwise a run attached to a local app
  // could be told to make that browser call anything on the network.
  for (const off of ["http://evil.test/steal", "https://localhost:3000/api/x", "http://localhost:3001/api/x", "//evil.test/x"]) {
    const out = resolveRequestUrl(BASE, off);
    assert.ok("problem" in out, `${off} must be refused`);
    assert.match(out.problem, /origin/i);
  }
  assert.match((resolveRequestUrl(BASE, "javascript:alert(1)") as { problem: string }).problem, /http and https|path or a URL/i);
  assert.match((resolveRequestUrl(BASE, "   ") as { problem: string }).problem, /No path given/);
});

test("only methods a browser can replay are accepted", () => {
  assert.deepEqual(resolveMethod("get"), { method: "GET" });
  assert.deepEqual(resolveMethod(undefined), { method: "GET" }, "GET is the default");
  assert.deepEqual(resolveMethod(" delete "), { method: "DELETE" });
  const bad = resolveMethod("TRACE");
  assert.ok("problem" in bad);
  assert.match(bad.problem, /TRACE is not a method/);
});

test("the app's own credential is replayed, and an explicit one wins", () => {
  // Nothing here knows what a token looks like: whatever the app sent is what
  // gets replayed, so any scheme works and none is special-cased.
  assert.deepEqual(requestHeaders({ auth: "Bearer abc.def" }), { authorization: "Bearer abc.def" });
  assert.deepEqual(requestHeaders({ auth: null }), {});
  assert.deepEqual(
    requestHeaders({ auth: "Bearer app", given: { Authorization: "Bearer mine" } }),
    { authorization: "Bearer mine" },
    "testing a different credential is the point",
  );
  assert.deepEqual(requestHeaders({ body: "{}" }), { "content-type": "application/json" });
  assert.deepEqual(requestHeaders({ body: "<x/>", given: { "Content-Type": "application/xml" } }), { "content-type": "application/xml" });
});

test("the script passes every value as data, never as code", () => {
  // A header value and a body come from the agent. A quote in either must not
  // be able to end the string it sits in.
  const script = buildRequestScript({
    url: "http://localhost:3000/api/x",
    method: "POST",
    body: '{"note":"\\" ; alert(1) //"}',
    headers: { "x-note": 'a " quote' },
  });
  assert.ok(!script.includes('; alert(1) //"}'), "the body is JSON-encoded, not interpolated");
  assert.match(script, /credentials":"include"/);
  assert.match(script, /"method":"POST"/);
  // It has to be a single evaluatable expression.
  assert.match(script.trim(), /^\(async \(\) => \{[\s\S]*\}\)\(\)$/);
});

test("a GET carries no body however one is passed", () => {
  const script = buildRequestScript({ url: "http://localhost:3000/api/x", method: "GET", body: "{}", headers: {} });
  assert.ok(!script.includes('"body"'), "a GET with a body is not a request a browser can make");
});

test("the response keeps the headers that decide whether two are identical", () => {
  const raw = {
    status: 403,
    statusText: "Forbidden",
    headers: { "content-type": "application/json", "www-authenticate": "Bearer", "set-cookie": "session=secret", "x-request-id": "abc" },
    body: '{"detail":"Insufficient permissions"}',
    full: 37,
    ms: 12,
    url: "http://localhost:3000/api/admin/users",
  };
  const result = toReplayResult(raw);
  assert.deepEqual(result.headers, { "content-type": "application/json", "www-authenticate": "Bearer", "x-request-id": "abc" });
  assert.ok(!("set-cookie" in result.headers), "a session cookie is not evidence and does not need reprinting");
  assert.equal(result.truncated, false);
  assert.ok(REPORTED_HEADERS.includes("location"), "a redirect's target is part of what makes two responses differ");
});

test("a long body is cut, and says it was", () => {
  const long = "x".repeat(BODY_MAX * 3);
  const result = toReplayResult({ status: 200, statusText: "OK", headers: {}, body: long, full: long.length, ms: 1, url: "http://localhost:3000/api/x" });
  assert.equal(result.body.length, BODY_MAX);
  assert.equal(result.truncated, true);
  assert.match(formatReplay("GET", result), /truncated at 2000 characters/);
});

test("a body past the cut: select returns one JSON value, offset returns the next slice, and no option leaves the output as it was", () => {
  const doc = { meta: { generated: "today" }, rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row ${i}` })), stats: { open: 7, closed: 3 } };
  const json = JSON.stringify(doc);
  assert.ok(json.length > VIEW_MAX, "a body well past the 2000-character cut");
  const raw = { status: 200, statusText: "OK", headers: {}, body: json, full: json.length, ms: 4, url: "http://localhost:3000/api/summary" };

  const plain = toReplayResult({ ...raw, body: json.slice(0, BODY_MAX * 2) });
  assert.equal(plain.body, json.slice(0, BODY_MAX), "no option: the first 2000 characters, as before");
  assert.equal(plain.truncated, true);
  assert.equal(plain.view, undefined);
  assert.equal(toReplayResult({ ...raw, body: json.slice(0, BODY_MAX * 2) }, {}).body, plain.body, "an empty view is no view");
  assert.match(formatReplay("GET", plain), /truncated at 2000 characters — pass offset:2000 for the next part, or select:"a\.b"/);

  const picked = toReplayResult(raw, { select: "stats.open" });
  assert.equal(picked.body, "7", "only that value");
  assert.equal(picked.truncated, false);
  assert.match(formatReplay("GET", picked), /^GET \/api\/summary 200 OK\ntook 4 ms\n\(select "stats\.open": all 1 characters\)\n\n7$/);
  assert.equal(toReplayResult(raw, { select: "stats" }).body, JSON.stringify(doc.stats, null, 2), "a subtree, pretty-printed");
  assert.equal(toReplayResult(raw, { select: "rows[150].name" }).body, '"row 150"', "a list index, either way it is spelled");
  assert.deepEqual(selectSteps("rows[150].name"), ["rows", "150", "name"]);

  const missing = toReplayResult(raw, { select: "stats.pending" });
  assert.equal(missing.body, "");
  assert.match(missing.view ?? "", /no key "pending" at stats\. Keys there: open, closed\./, "a path that is not there says what is");
  assert.match(toReplayResult(raw, { select: "rows.900" }).view ?? "", /no item "900" at rows, which is a list of 400/);
  assert.match(toReplayResult(raw, { select: "stats.open.x" }).view ?? "", /stats\.open is number/);

  const next = toReplayResult(raw, { offset: 2000 });
  assert.equal(next.body, json.slice(2000, 4000), "offset 2000 returns the next slice");
  assert.equal(next.view, `the body: characters 2000–4000 of ${json.length}; the next part is offset 4000`);
  const last = toReplayResult(raw, { offset: json.length - 10 });
  assert.equal(last.body, json.slice(-10));
  assert.doesNotMatch(last.view ?? "", /next part/, "the last slice names no next one");
  assert.match(toReplayResult(raw, { offset: json.length + 5 }).view ?? "", /past its end/);
  assert.equal(toReplayResult(raw, { offset: 0, limit: 99_999 }).body.length, VIEW_MAX, "a window is bounded");
  assert.equal(toReplayResult(raw, { select: "rows", offset: 10, limit: 20 }).body, JSON.stringify(doc.rows, null, 2).slice(10, 30), "a selection pages too");

  assert.match(viewBody("<html>", 6, { select: "a" }).note, /not JSON/);
  assert.match(viewBody(json.slice(0, 100), json.length, { select: "a" }).note, /past the 100 read/, "a body cut by the page cannot be parsed, and says so");
  assert.ok(
    buildRequestScript({ url: "http://localhost:3000/a", method: "GET", headers: {}, keep: BODY_FETCH_MAX }).includes(`text.slice(0, ${BODY_FETCH_MAX})`),
  );
  assert.ok(
    buildRequestScript({ url: "http://localhost:3000/a", method: "GET", headers: {} }).includes(`text.slice(0, ${BODY_MAX * 2})`),
    "without a view the page hands back what it did",
  );
});

test("the signature is the line a finding quotes", () => {
  assert.equal(replaySignature("GET", "http://localhost:3000/api/admin/users?page=2", 403), "GET /api/admin/users?page=2 403");
  assert.equal(replaySignature("DELETE", "not a url", 500), "DELETE not a url 500");

  const out = formatReplay("POST", {
    status: 402,
    statusText: "Payment Required",
    headers: { "content-type": "application/json" },
    body: '{"detail":"feature_not_in_plan"}',
    truncated: false,
    ms: 8,
    url: "http://localhost:3000/api/equipment",
  });
  assert.match(out.split("\n")[0], /^POST \/api\/equipment 402 Payment Required$/, "the signature leads, because that is what gets quoted");
  assert.match(out, /took 8 ms/);
  assert.match(out, /feature_not_in_plan/);
  assert.match(
    formatReplay("GET", { status: 204, statusText: "No Content", headers: {}, body: "", truncated: false, ms: 3, url: "http://localhost:3000/api/x" }),
    /\(empty body\)/,
  );
});

test("a refusal the write policy wrote is reported as the policy's, never as the server's status", () => {
  const raw = (headers: Record<string, string>) => ({
    status: 403,
    statusText: "Forbidden",
    headers: { "content-type": "application/json", ...headers },
    body: '{"error":"Forbidden"}',
    full: 21,
    ms: 2,
    url: "http://localhost:3000/api/things/1",
  });
  // The same 403, and the one fact that flips it: who wrote it.
  const policy = toReplayResult(raw({ "x-scenescout-policy": "refused; mode=read-only" }));
  assert.equal(policy.refusedByPolicy, "refused; mode=read-only");
  const said = formatReplay("DELETE", policy);
  assert.match(said, /^REFUSED by the write policy \(refused; mode=read-only\): DELETE \/api\/things\/1 never reached the server/);
  assert.doesNotMatch(said, /DELETE \/api\/things\/1 403/, "no signature a finding could quote as the server enforcing it");

  const server = toReplayResult(raw({}));
  assert.equal(server.refusedByPolicy, null);
  assert.match(formatReplay("DELETE", server), /^DELETE \/api\/things\/1 403 Forbidden/);
});

test("the page's requests since it loaded: what answered, what failed, what is pending, and a fetch that never ran is simply absent", () => {
  const log = new PageRequests();
  const t0 = 1_000_000;
  log.loaded("http://localhost:3000/things", t0);
  const list = {};
  const me = {};
  const save = {};
  const slow = {};
  log.started(me, { method: "GET", url: "http://localhost:3000/api/me?token=abc123def456ghi789", route: "/things", at: t0 + 300 });
  log.answered(me, 200, t0 + 340, false);
  log.started(list, { method: "GET", url: "http://localhost:3000/api/things?tab=archived", route: "/things/archived", at: t0 + 5_000 });
  log.failed(list, "net::ERR_ABORTED", t0 + 5_020, false);
  log.started(save, { method: "POST", url: "http://localhost:3000/api/things", route: "/things", at: t0 + 6_000 });
  log.answered(save, 403, t0 + 6_010, true);
  log.started(slow, { method: "GET", url: "https://cdn.example.com/feed.json", route: "/things", at: t0 + 7_000 });
  log.markReplay("POST", "http://localhost:3000/api/things");

  const out = formatPageRequests(log.snapshot, { now: t0 + 10_000 });
  assert.match(out, /^DATA REQUESTS \(fetch\/XHR\) since this page loaded — \/things, 10s ago: 4:/);
  assert.match(out, /\+0\.3s GET \/api\/me\?token[^ ]*\[redacted\][^\n]*→ 200 · 40 ms/, "a credential in the query is redacted");
  assert.doesNotMatch(out, /abc123def456ghi789/);
  assert.match(
    out,
    /\+5\.0s GET \/api\/things\?tab=archived → failed: net::ERR_ABORTED \(on \/things\/archived\)/,
    "the tab switch's request, failed, from the route it was sent on",
  );
  assert.match(out, /POST \/api\/things → 403 · 10 ms \(refused by the write policy, never reached the server; sent by scout_request\)/);
  assert.match(out, /GET https:\/\/cdn\.example\.com\/feed\.json → pending/, "another origin is shown whole");

  // The contrastive case: the same page where the tab switch fetched nothing.
  const quiet = new PageRequests();
  quiet.loaded("http://localhost:3000/things", t0);
  quiet.started(me, { method: "GET", url: "http://localhost:3000/api/me", route: "/things", at: t0 + 300 });
  quiet.answered(me, 200, t0 + 340, false);
  assert.doesNotMatch(formatPageRequests(quiet.snapshot, { now: t0 + 10_000 }), /api\/things/, "a fetch that never ran leaves no entry");
  assert.match(formatPageRequests(quiet.snapshot, { now: t0 + 10_000, contains: "/api/things" }), /: 0 matching "\/api\/things"\.\nNone matching/);

  // Filtered and bounded.
  const only = formatPageRequests(log.snapshot, { now: t0 + 10_000, contains: "/api/things" });
  assert.match(only, /: 2 matching "\/api\/things":/);
  assert.match(formatPageRequests(log.snapshot, { now: t0 + 10_000, limit: 1 }), /: 4, the newest 1 shown:\n[^\n]*cdn\.example\.com[^\n]*$/);

  // A new document starts a new list; the oldest go past the cap, and the listing says so.
  log.loaded("http://localhost:3000/other", t0 + 20_000);
  assert.match(formatPageRequests(log.snapshot, { now: t0 + 20_000 }), /: 0\.\nNone/);
  for (let i = 0; i < PageRequests.MAX + 5; i++)
    log.started({}, { method: "GET", url: `http://localhost:3000/api/poll/${i}`, route: "/other", at: t0 + 20_000 + i });
  assert.equal(log.snapshot.entries.length, PageRequests.MAX);
  assert.match(formatPageRequests(log.snapshot, { now: t0 + 30_000 }), /\(5 older ones no longer kept\)/);
  assert.equal(formatPageRequests(new PageRequests().snapshot, { now: 0 }), "No page has loaded in this session yet: navigate first.");
});

test("the listing redacts a query parameter named like a credential, whatever its value looks like, and leaves the rest", () => {
  const origin = "http://localhost:3000";
  const shown = shownUrl("http://localhost:3000/api/cb?access_token=opaqueVALUE&client_secret=s3&X-Amz-Signature=abcdef&code=1234&page=2&q=open+items", origin);
  assert.doesNotMatch(shown, /opaqueVALUE|=s3|abcdef|1234/);
  assert.match(shown, /^\/api\/cb\?access_token=\[redacted\]&client_secret=\[redacted\]&X-Amz-Signature=\[redacted\]&code=\[redacted\]&page=2&q=open\+items$/);
  assert.equal(shownUrl("http://localhost:3000/api/things?page=2&sort=name", origin), "/api/things?page=2&sort=name", "nothing to hide: unchanged");
  const long = shownUrl(`http://localhost:3000/api/x?filter=${"a".repeat(400)}&session=zzzzzzzz`, origin);
  assert.doesNotMatch(long, /zzzzzzzz/, "redacted before it is cut, so a value at the cut cannot slip through");
  assert.ok(long.length <= 301);
});

test("the credential replayed is the one the app last sent to its own origin, on a read as much as a write", () => {
  const remember = (url: string, headers: Record<string, string>, replay = false) => authToRemember({ url, baseUrl: BASE, headers, replay });
  // A read counts: an app that rotates its token and then only reads must not leave the replay on the old one.
  assert.equal(remember("http://localhost:3000/api/me", { authorization: "Bearer newest" }), "Bearer newest");
  assert.equal(remember("http://localhost:3000/api/me", { Authorization: "Token abc" }), "Token abc", "any scheme, any case of the name");
  // Nothing to take: the one remembered stays.
  assert.equal(remember("http://localhost:3000/api/me", {}), null);
  assert.equal(remember("http://localhost:3000/api/me", { authorization: "   " }), null);
  // Another origin's bearer token (an embedded widget, a third-party API) is never replayed to the app.
  for (const other of ["http://widget.test/api", "http://localhost:3001/api/me", "https://localhost:3000/api/me"]) {
    assert.equal(remember(other, { authorization: "Bearer widget-token" }), null, other);
  }
  // Sent to the app, but from a frame of another site: that site's credential, not the app's.
  const fromFrame = (frameUrl: string) =>
    authToRemember({ url: "http://localhost:3000/api/me", baseUrl: BASE, headers: { authorization: "Bearer framed" }, replay: false, frameUrl });
  assert.equal(fromFrame("http://widget.test/embed"), null);
  assert.equal(fromFrame("http://localhost:3000/settings"), "Bearer framed");
  assert.equal(fromFrame("about:blank"), "Bearer framed", "a blank frame runs as the page that made it");
  // A scout_request call's own request: a credential chosen for one call does not become the session's.
  assert.equal(remember("http://localhost:3000/api/me", { authorization: "Bearer forged" }, true), null);
  assert.equal(remember("not a url", { authorization: "Bearer x" }), null);
});

test("a replay refused 401 while the page's own authorised call succeeded says its credential may be stale", () => {
  assert.match(staleCredentialNote(401, true, { status: 200 }), /got 200, but this call got 401: the replayed credential may be stale/);
  // The contrast: each fact that makes the 401 the server's own answer leaves the result as it was.
  assert.equal(staleCredentialNote(401, true, { status: 401 }), "", "the page is refused too: the session is signed out");
  assert.equal(staleCredentialNote(401, true, null), "", "no page call to compare with");
  assert.equal(staleCredentialNote(401, false, { status: 200 }), "", "the caller chose the credential, or none was replayed");
  assert.equal(staleCredentialNote(403, true, { status: 200 }), "", "a 403 is a permission answer, not a stale credential");
  assert.equal(staleCredentialNote(200, true, { status: 200 }), "");
});
