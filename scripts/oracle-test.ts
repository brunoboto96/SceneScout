/**
 * Unit tests for the geometry oracles. These rules used to be reachable only
 * by launching Chromium and hand-building an HTML fixture, which is why their
 * false-positive classes (dialog-over-page, stacked chrome, carousels) kept
 * shipping. `geometryIssues` is a pure function over layout boxes — table-test
 * it directly and keep the browser suite for things that need a renderer.
 *
 *   npx tsx --test --test-name-pattern "dialog" scripts/oracle-test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { geometryIssues } from "../src/engine/collector.ts";
import { POLICY_BLOCK_WINDOW_MS, isPolicyInduced, redactViolation } from "../src/engine/oracles.ts";

const VIEWPORT = { width: 1280, height: 900 };

type El = Parameters<typeof geometryIssues>[0][number];

/** Minimal element; every field the oracle reads, defaulted to "ordinary". */
function el(over: Partial<El> & { ref: string; xpath: string }): El {
  return {
    name: over.ref,
    role: "button",
    rect: { x: 0, y: 0, w: 100, h: 40 },
    layer: 0,
    chrome: false,
    clipped: false,
    ...over,
  } as El;
}

test("two controls colliding in the same layer are reported", () => {
  const issues = geometryIssues(
    [
      el({ ref: "e1", xpath: "/html/body/div[1]/button[1]", rect: { x: 20, y: 10, w: 120, h: 32 } }),
      el({ ref: "e2", xpath: "/html/body/div[1]/button[2]", rect: { x: 30, y: 14, w: 120, h: 32 } }),
    ],
    VIEWPORT,
  );
  assert.equal(issues.filter((i) => i.includes("overlaps")).length, 1, "a genuine same-layer collision must still fire");
});

test("a dialog stacked over page content is NOT an overlap", () => {
  // The defect this pins: a modal parented to <body> inherited layer 0, so it
  // "overlapped" 100% of the content it was designed to cover, and every
  // confirm dialog produced a screenful of phantom geometry warnings.
  const issues = geometryIssues(
    [
      el({ ref: "e1", xpath: "/html/body/main[1]/div[1]", rect: { x: 0, y: 100, w: 1280, h: 600 }, layer: 0 }),
      el({ ref: "e2", xpath: "/html/body/div[9]", rect: { x: 400, y: 300, w: 400, h: 200 }, layer: 7 }),
    ],
    VIEWPORT,
  );
  assert.deepEqual(
    issues.filter((i) => i.includes("overlaps")),
    [],
    "different layers are stacked by design",
  );
});

test("two pieces of fixed chrome overlapping is intended layering, not a collision", () => {
  const issues = geometryIssues(
    [
      el({ ref: "e1", xpath: "/html/body/nav[1]/a[1]", rect: { x: 0, y: 800, w: 240, h: 40 }, chrome: true }),
      el({ ref: "e2", xpath: "/html/body/footer[1]/button[1]", rect: { x: 10, y: 805, w: 240, h: 40 }, chrome: true }),
    ],
    VIEWPORT,
  );
  assert.deepEqual(
    issues.filter((i) => i.includes("overlaps")),
    [],
  );
});

test("a nested control inside its own wrapper is not an overlap", () => {
  const issues = geometryIssues(
    [
      el({ ref: "e1", xpath: "/html/body/div[1]", rect: { x: 0, y: 0, w: 200, h: 60 } }),
      el({ ref: "e2", xpath: "/html/body/div[1]/button[1]", rect: { x: 5, y: 5, w: 190, h: 50 } }),
    ],
    VIEWPORT,
  );
  assert.deepEqual(
    issues.filter((i) => i.includes("overlaps")),
    [],
  );
});

test("an element rendered off the reachable page area is reported", () => {
  const issues = geometryIssues([el({ ref: "e1", xpath: "/html/body/button[1]", rect: { x: -5000, y: 100, w: 100, h: 30 } })], VIEWPORT);
  assert.equal(issues.filter((i) => i.includes("outside the reachable page area")).length, 1);
});

test("below-the-fold content is reachable and never flagged", () => {
  const issues = geometryIssues([el({ ref: "e1", xpath: "/html/body/button[1]", rect: { x: 20, y: 5000, w: 100, h: 30 } })], VIEWPORT);
  assert.deepEqual(issues, [], "scrolling reveals it — that is not a defect");
});

test("clipped-unreachable controls are reported and capped with a count", () => {
  // One transform-based carousel legitimately clips dozens of off-track slides;
  // an uncapped list floods GEOMETRY and starves the overlap oracle.
  const many = Array.from({ length: 9 }, (_, i) =>
    el({ ref: `e${i}`, xpath: `/html/body/div[1]/button[${i + 1}]`, clipped: true, rect: { x: 10, y: 10 + i, w: 80, h: 20 } }),
  );
  const issues = geometryIssues(many, VIEWPORT);
  const unreachable = issues.filter((i) => i.includes("UNREACHABLE"));
  assert.equal(unreachable.length, 3, "at most three are listed individually");
  assert.ok(
    issues.some((i) => i.includes("…and 6 more")),
    "the remainder is disclosed as a count, never silently dropped",
  );
});

test("a violation never re-publishes a credential carried in the request URL", () => {
  // Violations quote the failing request's full URL and are printed in tool
  // output, stored in memory and rendered into the report.
  const v = redactViolation({
    kind: "http_error",
    severity: "high",
    detail: "GET http://x/api/export?api_key=sk9f8a7b6c5d4e3f2a1b&page=2 → 500",
    url: "http://x/reset?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
  });
  assert.doesNotMatch(v.detail, /sk9f8a7b6c5d4e3f2a1b/);
  assert.match(v.detail, /GET http:\/\/x\/api\/export\?api_key=\[redacted\]&page=2 → 500/, "the rest of the evidence stays readable");
  assert.doesNotMatch(v.url, /eyJhbGci/);
  assert.equal(v.kind, "http_error");

  // An ordinary URL must come through untouched — over-redaction turns
  // evidence into noise.
  const plain = { kind: "http_error", severity: "medium", detail: "GET http://x/api/orders?page=2&sort=asc → 404", url: "http://x/orders?tab=history" };
  assert.deepEqual(redactViolation(plain), plain);
});

test("errors caused by the tester's own write-policy block are not held against the app", () => {
  // An aborted request surfaces three ways. None of them is the app's doing.
  assert.equal(isPolicyInduced({ kind: "request_failed", detail: "PUT http://x/api/orders/7 → net::ERR_BLOCKED_BY_CLIENT.Inspector" }, null), true);
  assert.equal(isPolicyInduced({ kind: "console_error", detail: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector" }, null), true);
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Failed to fetch" }, 40), true, "the uncaught rejection that follows the abort");

  // "Failed to fetch" on its own is a real finding: the app's request failed
  // and nothing caught it. Only the window after a block excuses it.
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Failed to fetch" }, null), false, "no block happened");
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Failed to fetch" }, POLICY_BLOCK_WINDOW_MS + 1), false, "too long after the block");
  // And a block excuses nothing else.
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Cannot read properties of undefined (reading 'rows')" }, 10), false);
  assert.equal(isPolicyInduced({ kind: "http_error", detail: "GET http://x/api/orders → HTTP 500" }, 10), false);
});
