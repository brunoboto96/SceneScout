/**
 * The re-test campaign: which findings it hands back, in what order, and what
 * recording a verdict says.
 *
 * The ordering is the whole value of the tool. A worklist that sends a run to
 * four routes to check four findings costs four times what one that groups
 * them by route does, and a worklist that re-checks the same finding twice
 * while another has never been looked at is worse than no worklist at all.
 *
 *   npx tsx --test scripts/verify-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../src/engine/memory.ts";
import { describeVerdict, formatWorklist, MAX_WORKLIST, resolvesFinding, sayVerification, unknownIds, verifyWorklist } from "../src/engine/verify.ts";

let n = 0;
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: `f${(n += 1)}`,
  severity: "medium",
  category: "data-inconsistency",
  title: `finding ${n}`,
  detail: "detail",
  url: "http://app.test/things",
  state: "things#1",
  repro: ["click Save", "read the row"],
  foundAt: "2026-08-01T10:00:00.000Z",
  runs: 1,
  ...over,
});

test("only open findings are handed back", () => {
  const list = [finding({ id: "open1" }), finding({ id: "done1", status: "resolved" }), finding({ id: "open2", status: "open" })];
  assert.deepEqual(
    verifyWorklist(list).map((i) => i.id),
    ["open1", "open2"],
  );
});

test("the worst route comes first, and its other findings come with it", () => {
  // A route carrying a high is walked before one carrying three mediums, and
  // the mediums that share the high's route are checked while it is open.
  const list = [
    finding({ id: "m1", url: "http://app.test/quiet", severity: "medium" }),
    finding({ id: "m2", url: "http://app.test/quiet", severity: "medium" }),
    finding({ id: "h1", url: "http://app.test/loud", severity: "high" }),
    finding({ id: "l1", url: "http://app.test/loud", severity: "low" }),
  ];
  assert.deepEqual(
    verifyWorklist(list).map((i) => i.id),
    ["h1", "l1", "m1", "m2"],
  );
});

test("within a route, one nobody has re-tested comes before one somebody has", () => {
  const list = [
    finding({ id: "seen", verdict: "present", verifiedAt: "2026-09-01T00:00:00.000Z" }),
    finding({ id: "never" }),
    finding({ id: "older", verdict: "changed", verifiedAt: "2026-08-15T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    verifyWorklist(list).map((i) => i.id),
    ["never", "older", "seen"],
    "never-checked first, then longest since it was last looked at",
  );
});

test("ids narrow the worklist, and ones that match nothing open are named", () => {
  const list = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c", status: "resolved" })];
  assert.deepEqual(
    verifyWorklist(list, ["a", "c", "zzz"]).map((i) => i.id),
    ["a"],
  );
  // A silently short worklist hides the fact that two of the three asked for
  // are not open — which a caller would read as "they are fine".
  assert.deepEqual(unknownIds(list, ["a", "c", "zzz"]), ["c", "zzz"]);
});

test("a campaign is capped at a length somebody will actually work down", () => {
  const many = Array.from({ length: MAX_WORKLIST + 10 }, (_, i) => finding({ id: `x${i}` }));
  assert.equal(verifyWorklist(many).length, MAX_WORKLIST);
});

test("the brief carries what re-testing one needs", () => {
  const out = formatWorklist(verifyWorklist([finding({ id: "abc", evidence: "GET /api/things 403", severity: "high" })]));
  assert.match(out, /VERIFY CAMPAIGN/);
  assert.match(out, /── \/things ──/);
  assert.match(out, /\[high\] abc/);
  assert.match(out, /evidence: GET \/api\/things 403/);
  assert.match(out, /repro: click Save → read the row/);
  assert.match(out, /never re-tested/);
  assert.match(out, /scout_verify \{ id, verdict/, "it says how to record the answer");
});

test("an empty campaign says why it is empty", () => {
  assert.match(formatWorklist([]), /no open findings/);
  assert.match(formatWorklist([], ["gone1"]), /No OPEN finding matches: gone1/);
});

test("only 'gone' resolves the finding", () => {
  assert.equal(resolvesFinding("gone"), true);
  assert.equal(resolvesFinding("present"), false);
  assert.equal(resolvesFinding("changed"), false);
});

test("each verdict reads back as what it means for the finding", () => {
  const f = { id: "abc", severity: "high", title: "the list is empty for an admin" };
  assert.match(describeVerdict(f, "gone"), /Resolved by re-test/);
  assert.match(describeVerdict(f, "present"), /Confirmed still present/);
  assert.match(describeVerdict(f, "present"), /instead of calling it unverified/);
  assert.match(describeVerdict(f, "changed"), /changed/);
  assert.match(describeVerdict(f, "gone", "the 403 is now a 200"), /the 403 is now a 200/);
});

test("the report says nothing about verification until somebody has verified", () => {
  // A finding nobody has looked at again must not gain a reassuring line.
  assert.equal(sayVerification({}), "");
  assert.equal(sayVerification({ verdict: "present" }), "", "a verdict with no date is not a confirmation");
  assert.match(sayVerification({ verdict: "present", verifiedAt: "2026-09-21T08:00:00.000Z" }), /confirmed still present on 2026-09-21/);
  assert.match(sayVerification({ verdict: "changed", verifiedAt: "2026-09-21T08:00:00.000Z" }), /behaviour has changed/);
});
