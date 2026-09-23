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
import { CLAIM_TEXT_MAX, classify, findContradictions, isRefused, isRefusalNotice, type PageState, type WatchedRequest } from "../src/engine/claims.ts";

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

test("a request the tool's own write policy dropped is never an app defect", () => {
  assert.equal(isRefused(req({ method: "DELETE", status: null, blockedByPolicy: true })), false);
});

test("a request the write policy answered with a refusal is judged like a real one", () => {
  // The page met a 403 exactly as it would from the server, so what it then
  // says is the page's own doing.
  assert.equal(isRefused(req({ method: "DELETE", status: 403, blockedByPolicy: true })), true);
});

test("a false success on a stand-in refusal says the server never saw the request", () => {
  const found = findContradictions([req({ method: "DELETE", url: "http://x/api/things/9", status: 403, blockedByPolicy: true })], {
    texts: ["Thing deleted."],
    emptyLists: 0,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "false_success");
  assert.match(found[0].detail, /stand-in/);
  // Same signature as a real refusal, so the finding dedups with one filed from a laxer run.
  assert.equal(found[0].evidence, "false-success DELETE /api/things/9 403");

  const real = findContradictions([req({ method: "DELETE", url: "http://x/api/things/9", status: 403 })], { texts: ["Thing deleted."], emptyLists: 0 });
  assert.doesNotMatch(real[0].detail, /stand-in/);
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

test("a refusal the page announces in its own words is not a false success", () => {
  // Seen on a benchmark run: a 409, then a correct message in the page's
  // status region that happens to contain an affirmation-shaped word ("sent").
  const refused = [req({ method: "POST", url: "http://app.test/api/orders/1042/request-approval", status: 409 })];
  for (const text of [
    "Only an open order can be sent for approval (this one is pending)",
    "This order cannot be saved while it is shipped",
    "You can't delete an order that has been approved",
    "You can’t delete an order that has been approved",
    "Only managers may approve orders",
    "You may only approve open orders",
    "Approvals can only be made by managers",
    "This order is already approved",
    "Nothing was sent: the order must be open",
  ]) {
    assert.deepEqual(findContradictions(refused, page({ texts: [text], announced: [text] })), [], text);
  }
  // The contrast: the same refusal, and an announced message claiming it went through.
  for (const text of ["Sent for approval", "Order sent to the manager", "Saved successfully"]) {
    assert.equal(findContradictions(refused, page({ texts: [text], announced: [text] }))[0]?.kind, "false_success", text);
  }
});

test("refusal-shaped help text elsewhere on the page excuses nothing", () => {
  // Page-wide, this wording silenced real lies: a refused delete reporting
  // "Workspace deleted." beside a Danger zone reading "This cannot be undone."
  const refusedDelete = [req({ method: "DELETE", url: "http://app.test/api/workspace", status: 403 })];
  const lie = "Workspace deleted.";
  for (const help of [
    "This cannot be undone.",
    "This action cannot be undone",
    "Password must be at least 8 characters",
    "Fields marked * must be filled in",
    "Only admins can invite members",
  ]) {
    const found = findContradictions(refusedDelete, page({ texts: [help, lie], announced: [lie] }));
    assert.equal(found[0]?.kind, "false_success", `help text "${help}" must not excuse the lie`);
  }
  // And an empty state is not an admission, however it is worded.
  const refusedRead = [req({ method: "GET", url: "http://app.test/api/bookmarks", status: 500 })];
  const empty = findContradictions(refusedRead, page({ texts: ["Nothing saved yet"], announced: ["Nothing saved yet"], emptyLists: 1 }));
  assert.equal(empty[0]?.kind, "refused_empty", '"Nothing saved yet" is an empty state, not a refusal');
  // Classic error words still clear the whole page, as before.
  assert.deepEqual(findContradictions(refusedDelete, page({ texts: ["Couldn’t delete the workspace", lie] })), []);
});

test("an announcement that merely mentions 'only' or a count is not a refusal", () => {
  const refused = [req({ method: "POST", url: "http://app.test/api/cart", status: 500 })];
  for (const noise of ["Only 3 left in stock", "Showing only open orders"]) {
    const found = findContradictions(refused, page({ texts: [noise, "Added to cart"], announced: [noise, "Added to cart"] }));
    assert.equal(found[0]?.kind, "false_success", noise);
  }
  // Accepted limit, recorded as one: a standing announcement that reads as a
  // permission ("Only you can see this note") excuses a lie elsewhere on the
  // page, because any announced refusal clears it. Missing a lie here is the
  // price of not reporting the refusals the page does explain.
  const standing = findContradictions(
    refused,
    page({ texts: ["Only you can see this note", "Added to cart"], announced: ["Only you can see this note", "Added to cart"] }),
  );
  assert.deepEqual(standing, [], "known miss: a standing permission note in a live region");
});

test("an announced admission that the change was not kept is not a false success", () => {
  const refused = [req({ method: "PUT", url: "http://app.test/api/profile", status: 409 })];
  for (const text of ["Your changes were not saved", "Your changes weren't saved", "The order wasn't sent", "Changes have not been saved"]) {
    assert.deepEqual(findContradictions(refused, page({ texts: [text], announced: [text] })), [], text);
  }
});

test("help text inside a modal form is not an announcement", () => {
  // The scan does not count a dialog as announcing: a modal is a container of
  // static text. Its help, beside a lie in the page's status region, excuses nothing.
  const refused = [req({ method: "POST", url: "http://app.test/api/profile", status: 422 })];
  const found = findContradictions(refused, page({ texts: ["Edit profile", "Password must be at least 8 characters", "Saved"], announced: ["Saved"] }));
  assert.equal(found[0]?.kind, "false_success");
});

test("isRefusalNotice reads refusal wording and nothing else", () => {
  for (const t of ["Only an open order can be sent for approval", "cannot be saved", "can not be saved", "is already approved", "Nothing was saved"]) {
    assert.equal(isRefusalNotice(t), true, t);
  }
  for (const t of ["Nothing saved yet", "Saved successfully", "Order sent", "No results", "Only 3 left in stock", "Showing only open orders", ""]) {
    assert.equal(isRefusalNotice(t), false, t);
  }
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
