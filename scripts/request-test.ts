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
  BODY_MAX,
  buildRequestScript,
  formatReplay,
  replaySignature,
  REPORTED_HEADERS,
  requestHeaders,
  resolveMethod,
  resolveRequestUrl,
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
