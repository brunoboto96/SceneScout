/**
 * Unit tests for the design audit. `analyzeDesign` is a pure function over
 * style records — the same shape as the geometry oracles, which were extracted
 * and table-tested for exactly this reason — but it shipped untested while
 * being the noisiest rule set in the product. Its worst failure class (scoring
 * the shared app shell once per page) is pinned here.
 *
 *   npx tsx --test --test-name-pattern "chrome" scripts/design-test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDesign, contrastRatio, styleSignature } from "../dist/engine/design.js";

const VIEWPORT = { width: 1280, height: 900 };

type Payload = Parameters<typeof analyzeDesign>[0];
type Rec = Payload["records"][number];

/** An ordinary, blameless element; override only what a case is about. */
function rec(over: Partial<Rec> = {}): Rec {
  return {
    tag: "div",
    testid: null,
    text: "text",
    textLen: 4,
    interactive: false,
    rect: { x: 0, y: 0, w: 200, h: 40 },
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
    sideStripe: false,
    gradientText: false,
    glass: false,
    glow: false,
    ...over,
  } as Rec;
}

function payload(records: Rec[]): Payload {
  return {
    records,
    page: { scrollW: 1280, clientW: 1280, headings: [{ level: 1, size: 30, text: "Page" }], images: [], density: 10, focusSamples: [] },
  };
}

// ---------------------------------------------------------------------------
// contrastRatio — pinned to the WCAG reference values
// ---------------------------------------------------------------------------

test("contrastRatio matches the WCAG reference extremes", () => {
  assert.equal(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")?.toFixed(2), "21.00");
  assert.equal(contrastRatio("rgb(255, 255, 255)", "rgb(255, 255, 255)")?.toFixed(2), "1.00");
});

test("contrastRatio is symmetric and handles alpha compositing", () => {
  const a = contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)");
  const b = contrastRatio("rgb(255, 255, 255)", "rgb(0, 0, 0)");
  assert.equal(a?.toFixed(4), b?.toFixed(4), "ordering must not change the ratio");
  const faded = contrastRatio("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)");
  assert.ok(faded !== null && faded < 21 && faded > 1, "a half-transparent black is greyer than black");
});

test("contrastRatio declines to guess at an unparseable colour", () => {
  assert.equal(contrastRatio("unknown", "rgb(255,255,255)"), null);
});

// ---------------------------------------------------------------------------
// Shared chrome is scored once, globally — not once per page
// ---------------------------------------------------------------------------

const BAD_BADGE = rec({ tag: "span", text: "18", color: "rgb(255,255,255)", bg: "rgb(239,67,67)" });
const BAD_SEPARATOR = rec({ tag: "span", text: "›", color: "rgb(208,213,221)", bg: "rgb(252,252,253)" });

test("a page carrying only shell contrast failures scores clean once they are known chrome", () => {
  // The exact arithmetic this pins, measured on a real run: a document page
  // scored a11y 80 on five contrast failures — one notification badge and four
  // breadcrumb separators, every one of them app shell. Its own content had no
  // a11y defect at all, and the shell's four points came off every page that
  // rendered a breadcrumb.
  const records = [rec({ text: "Real page content" }), BAD_BADGE, BAD_SEPARATOR, BAD_SEPARATOR, BAD_SEPARATOR, BAD_SEPARATOR];
  const naive = analyzeDesign(payload(records), VIEWPORT);
  assert.equal(naive.score?.a11y, 100 - 5 * 4, "unaware of chrome: five failures, twenty points");

  const chrome = new Set([styleSignature(BAD_BADGE), styleSignature(BAD_SEPARATOR)]);
  const aware = analyzeDesign(payload(records), VIEWPORT, chrome);
  assert.equal(aware.score?.a11y, 100, "the page's OWN accessibility is perfect and should read that way");
});

test("shell failures are still reported — once, and told to be filed once", () => {
  const chrome = new Set([styleSignature(BAD_BADGE)]);
  const { report } = analyzeDesign(payload([rec({ text: "content" }), BAD_BADGE, BAD_BADGE, BAD_BADGE]), VIEWPORT, chrome);
  assert.ok(report.includes("SHARED CHROME"), "not silently dropped — a shell defect is still a defect");
  assert.equal(report.match(/3\.78:1/g)?.length, 1, "three copies of one component report one failure");
  assert.ok(report.includes("File ONE finding for the shell"), "the reader is told why it is not per-page");
  assert.ok(!report.includes("CONTRAST failures"), "and it is kept out of the page's own contrast section");
});

test("a page's own contrast failure is never excused as chrome", () => {
  const own = rec({ tag: "span", text: "Medium", color: "rgb(245,159,10)", bg: "rgb(254,247,235)" });
  const chrome = new Set([styleSignature(BAD_BADGE)]);
  const { report, score } = analyzeDesign(payload([rec({ text: "content" }), own, BAD_BADGE]), VIEWPORT, chrome);
  assert.ok(report.includes("CONTRAST failures"), "page content is judged on its own merits");
  assert.ok((score?.a11y ?? 100) < 100, "and still costs the page points");
});

test("the sidebar does not make every page look like it has competing actions", () => {
  // ~24 filled nav links are on every authenticated page, so the ">3 prominent
  // actions" rule fired on 100% of them — a flat clarity penalty and one line
  // of identical noise per audit.
  const navLinks = Array.from({ length: 24 }, (_, i) =>
    rec({ testid: `nav-item-${i}`, text: `Nav ${i}`, interactive: true, bg: "rgb(20, 80, 200)", rect: { x: 0, y: i * 40, w: 200, h: 40 } }),
  );
  const pageCta = rec({ testid: "save-btn", text: "Save", interactive: true, bg: "rgb(20, 80, 200)", rect: { x: 400, y: 10, w: 120, h: 40 } });
  const chrome = new Set(navLinks.map(styleSignature));
  const { report } = analyzeDesign(payload([...navLinks, pageCta, rec({ text: "body" })]), VIEWPORT, chrome);
  assert.ok(!report.includes("equally-prominent actions compete"), "one page CTA is not a competing-actions problem");
});

test("signatures are returned so the census can learn what is shared", () => {
  const { signatures } = analyzeDesign(payload([rec({ testid: "a" }), rec({ tag: "span", text: "18" })]), VIEWPORT);
  assert.deepEqual(signatures, ["tid:a", "span:18"]);
});

test("an element with no testid is still identifiable across pages", () => {
  // Badges, separators and counts routinely ship without a testid; identifying
  // chrome by testid alone would have missed the worst offender found in practice.
  assert.equal(styleSignature(rec({ tag: "span", text: "18", testid: null })), "span:18");
  assert.equal(styleSignature(rec({ testid: "nav-home" })), "tid:nav-home");
  assert.equal(
    styleSignature(rec({ tag: "span", text: "  Two   Words  ", testid: null })),
    "span:two words",
    "whitespace and case must not fork one component into many",
  );
});
