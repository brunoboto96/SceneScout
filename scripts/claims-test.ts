/**
 * The two contradiction oracles: a refused read rendered as an empty state,
 * and a refused write rendered as a success message.
 *
 * Most of these tests are about NOT firing. The rules sit on every action of
 * every run, so a false positive is not a nuisance — it is the reason a reader
 * stops believing the high-severity findings. The cases below pin the guards:
 * a page that admits the error, a refused image, the tool's own write-policy
 * block, and a refusal with nothing on screen to contradict it.
 *
 *   npx tsx --test scripts/claims-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_TEXT_MAX, classify, findContradictions, isRefused, type PageState, type WatchedRequest } from "../src/engine/claims.ts";

const req = (over: Partial<WatchedRequest> = {}): WatchedRequest => ({
  method: "GET",
  url: "http://app.test/api/things?page=1",
  status: 403,
  resourceType: "xhr",
  ...over,
});
const page = (over: Partial<PageState> = {}): PageState => ({ texts: [], emptyLists: 0, ...over });

// ── what one piece of text asserts ──────────────────────────────────────────

test("the stock empty-state sentences are recognised", () => {
  for (const text of ["No results", "No items found", "Nothing to show", "There are no orders", "You have no widgets yet", "0 results", "This list is empty"]) {
    assert.equal(classify(text), "empty", text);
  }
});

test("a sentence that merely contains 'no' is not an empty state", () => {
  // The assertion has to be about the absence of the things themselves.
  assert.equal(classify("No changes have been made since yesterday"), null);
  assert.equal(classify("Norwegian"), null);
});

test("an admission of failure outranks everything else on the line", () => {
  // A banner that says both is the app being honest, not contradicting itself.
  assert.equal(classify("Couldn't load orders — no results to show"), "error");
  assert.equal(classify("Failed to save"), "error");
  assert.equal(classify("Saved successfully"), "success");
});

test("text longer than a sentence is not a claim", () => {
  const long = "Saved ".repeat(CLAIM_TEXT_MAX);
  assert.equal(classify(long), null, "a paragraph containing the word is not an affirmation");
  assert.equal(classify("   "), null);
});

// ── which requests count ────────────────────────────────────────────────────

test("only data requests are correlated", () => {
  assert.equal(isRefused(req({ resourceType: "xhr" })), true);
  assert.equal(isRefused(req({ resourceType: "fetch" })), true);
  assert.equal(isRefused(req({ resourceType: "document" })), true);
  // A broken logo says nothing about whether the list on screen is real.
  assert.equal(isRefused(req({ resourceType: "image" })), false);
  assert.equal(isRefused(req({ resourceType: "font" })), false);
});

test("a request the tool's own write policy aborted is never an app defect", () => {
  assert.equal(isRefused(req({ method: "DELETE", status: null, blockedByPolicy: true })), false);
});

test("a request that never got a response is refused", () => {
  assert.equal(isRefused(req({ status: null })), true);
  assert.equal(isRefused(req({ status: 200 })), false);
  assert.equal(isRefused(req({ status: 399 })), false);
});

// ── the refused-read rule ───────────────────────────────────────────────────

test("a refused list request rendered as an empty state is reported", () => {
  const found = findContradictions([req({ status: 403 })], page({ texts: ["Orders", "No results"] }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "refused_empty");
  assert.match(found[0].detail, /403 was refused/);
  assert.match(found[0].detail, /nothing could be loaded/);
  assert.equal(found[0].evidence, "refused-empty GET /api/things?page=1 403");
});

test("...and so is one rendered as a list with a header and no rows", () => {
  // Most apps write no empty-state sentence at all. The structural signal is
  // what makes the rule work on them, and in any language.
  const found = findContradictions([req({ status: 500 })], page({ emptyLists: 1 }));
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /an empty list \(1\)/);
});

test("a page that admits the failure has behaved correctly", () => {
  // This is the guard that decides whether the rule is usable. An app that
  // refuses and says so is the CORRECT behaviour the rule exists to ask for.
  assert.deepEqual(findContradictions([req({ status: 403 })], page({ texts: ["Couldn't load orders", "No results"] })), []);
  assert.deepEqual(findContradictions([req({ status: 500 })], page({ texts: ["Something went wrong"], emptyLists: 2 })), []);
});

test("a refusal with nothing on screen contradicting it is not a contradiction", () => {
  // The HTTP oracle already reports the refusal itself. This rule only fires
  // on the page disagreeing with it.
  assert.deepEqual(findContradictions([req({ status: 403 })], page({ texts: ["Orders", "Acme Ltd", "Beta Corp"] })), []);
});

test("an empty state with every request succeeding is an ordinary empty list", () => {
  assert.deepEqual(findContradictions([req({ status: 200 })], page({ texts: ["No results"], emptyLists: 1 })), []);
  assert.deepEqual(findContradictions([], page({ texts: ["No results"], emptyLists: 1 })), []);
});

// ── the false-success rule ──────────────────────────────────────────────────

test("a refused save shown as a success message is reported", () => {
  const found = findContradictions([req({ method: "POST", url: "http://app.test/api/things", status: 422 })], page({ texts: ["Saved successfully"] }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "false_success");
  assert.match(found[0].detail, /"Saved successfully"/);
  assert.match(found[0].detail, /rejected it/);
  assert.equal(found[0].evidence, "false-success POST /api/things 422");
});

test("every writing method counts", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) {
    const found = findContradictions([req({ method, status: 500 })], page({ texts: ["Deleted"] }));
    assert.equal(found[0]?.kind, "false_success", method);
  }
});

test("a refused GET does not make a success message a lie", () => {
  // A background poll failing while a page says "Saved" is two unrelated
  // things; only the write's own refusal contradicts the message.
  const found = findContradictions([req({ method: "GET", status: 403 })], page({ texts: ["Saved"] }));
  assert.deepEqual(
    found.map((f) => f.kind),
    [],
  );
});

test("both rules can fire on one action", () => {
  const found = findContradictions(
    [req({ method: "POST", url: "http://app.test/api/things", status: 403 }), req({ method: "GET", status: 403 })],
    page({ texts: ["Saved", "No results"] }),
  );
  assert.deepEqual(found.map((f) => f.kind).sort(), ["false_success", "refused_empty"]);
});

test("the same contradiction on the same endpoint carries the same evidence across runs", () => {
  // Evidence is what dedups a finding when a title gets rephrased, so it must
  // not carry anything that changes between runs.
  const a = findContradictions([req({ status: 403, url: "http://app.test/api/things?page=1" })], page({ texts: ["No results"] }));
  const b = findContradictions([req({ status: 403, url: "http://other.test/api/things?page=1" })], page({ texts: ["Nothing to show"] }));
  assert.equal(a[0].evidence, b[0].evidence, "the host is not part of the signature");
});
