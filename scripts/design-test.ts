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
import { analyzeDesign, contrastRatio, styleSignature } from "../src/engine/design.ts";
import { formatJourney, measureJourney } from "../src/engine/journey.ts";

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

// ---------------------------------------------------------------------------
// Task ease: what a journey cost, read from the action log.
// ---------------------------------------------------------------------------

const step = (action: string, url: string, result?: string) => ({ at: "2026-01-01T00:00:00.000Z", action, url: `http://x${url}`, result });

test("a direct path is reported as efficient", () => {
  const m = measureJourney([step("click", "/orders"), step("type", "/orders/new"), step("click", "/orders/new"), step("click", "/orders/41")], true);
  assert.equal(m.interactions, 4);
  assert.equal(m.distinctScreens, 3, "/orders/41 is the /orders/:id screen");
  assert.deepEqual(m.routeSeq, ["/orders", "/orders/new", "/orders/:id"], "consecutive actions on one screen are one step of the path");
  assert.equal(m.backtracks, 0);
  assert.deepEqual(m.verdict, ["✓ efficient — direct path, no backtracking, proportionate interaction count"]);
});

test("returning to a screen already left is a backtrack, and it is the headline", () => {
  // orders → settings → orders: the user went looking in the wrong place.
  const m = measureJourney([step("click", "/orders"), step("click", "/settings"), step("click", "/orders"), step("click", "/orders/new")], true);
  assert.equal(m.backtracks, 1);
  assert.match(m.verdict[0], /1 backtrack/);
});

test("typing a URL mid-journey contaminates the measurement and says so", () => {
  const m = measureJourney([step("click", "/"), step("navigate", "/reports/export"), step("click", "/reports/export")], true);
  assert.equal(m.shortcuts, 1);
  assert.ok(m.verdict.some((v) => /direct-URL jump/.test(v)));
  assert.equal(m.navigations, 1);
  assert.equal(m.interactions, 2, "a navigation is not an interaction");
});

test("an abandoned journey is never called efficient", () => {
  const m = measureJourney([step("click", "/orders")], false);
  assert.ok(m.verdict.some((v) => /TASK NOT COMPLETED/.test(v)));
  assert.ok(!m.verdict.some((v) => /efficient/.test(v)));
  assert.match(formatJourney({ goal: "export last month", completed: false, seconds: 9 }, m), /^JOURNEY ABANDONED — "export last month"/);
});

test("policy blocks are reported as tester safety, not held against the app", () => {
  const m = measureJourney([step("click", "/orders"), step("write-policy:blocked", "/orders"), step("click", "/orders", "REFUSED: destructive label")], true);
  assert.equal(m.policyBlocks, 1);
  assert.equal(m.refusals, 1);
  assert.equal(m.interactions, 2, "the block itself is not something the user did");
  assert.match(formatJourney({ goal: "g", completed: true, seconds: 1 }, m), /Policy: 1 write-policy blocks, 1 refusals \(tester safety, not app defects\)/);
});

test("the screen and interaction thresholds fire just past their limits, not at them", () => {
  const screens = (n: number) => Array.from({ length: n }, (_, i) => step("click", `/s${i}`));
  assert.ok(!measureJourney(screens(4), true).verdict.some((v) => /distinct screens/.test(v)));
  assert.ok(measureJourney(screens(5), true).verdict.some((v) => /5 distinct screens/.test(v)));
  const clicks = (n: number) => Array.from({ length: n }, () => step("click", "/form"));
  assert.ok(!measureJourney(clicks(15), true).verdict.some((v) => /interactions —/.test(v)));
  assert.ok(measureJourney(clicks(16), true).verdict.some((v) => /16 interactions/.test(v)));
});

// ---------------------------------------------------------------------------
// Measurable defects as data — what `scenescout check` reads instead of the prose
// ---------------------------------------------------------------------------

test("a faint label is a contrast defect; the same label at full contrast is none", () => {
  const faint = analyzeDesign(payload([rec({ text: "Hint", color: "rgb(184, 192, 202)", bg: "rgb(246, 248, 250)" })]), VIEWPORT);
  const clear = analyzeDesign(payload([rec({ text: "Hint", color: "rgb(30, 30, 30)", bg: "rgb(246, 248, 250)" })]), VIEWPORT);
  assert.deepEqual(
    faint.defects.map((d) => d.rule),
    ["contrast"],
  );
  assert.match(faint.defects[0].detail, /1\.\d\d:1 \(needs 4\.5:1\)/);
  assert.deepEqual(clear.defects, []);
});

test("every defect is also in the prose report, so check and scout_design_audit cannot disagree", () => {
  const p = payload([
    rec({ text: "Hint", color: "rgb(184, 192, 202)", bg: "rgb(246, 248, 250)" }),
    rec({ tag: "button", testid: "tiny", interactive: true, text: "x", rect: { x: 0, y: 100, w: 14, h: 14 } }),
    rec({ testid: "cut", text: "A long label", clipped: true, rect: { x: 0, y: 200, w: 40, h: 20 } }),
  ]);
  p.page.scrollW = 1600;
  p.page.focusSamples = [{ label: 'button "Go"', indicator: false }];
  const { report, defects } = analyzeDesign(p, VIEWPORT);
  assert.deepEqual([...new Set(defects.map((d) => d.rule))].sort(), ["clipped-text", "contrast", "focus-indicator", "horizontal-scroll", "tiny-target"]);
  const contrast = defects.find((d) => d.rule === "contrast")!;
  assert.ok(report.includes(contrast.detail), contrast.detail);
  assert.match(report, /TINY targets \(1[,)][\s\S]*\[tiny\] — 14×14px/);
  assert.match(report, /CLIPPED text \(1\)[\s\S]*\[cut\]/);
  assert.match(report, /1\/1 keyboard tab stops show NO visible focus indicator[^\n]*button "Go"/);
  assert.match(report, /page scrolls horizontally — content 1600px/);
});

test("a control is one fact whether or not the shell is known yet: same rule, same wording", () => {
  const small = rec({ tag: "button", testid: "nav-x", interactive: true, text: "x", rect: { x: 0, y: 0, w: 14.4, h: 14.4 } });
  const before = analyzeDesign(payload([small, rec({ text: "Body" })]), VIEWPORT).defects.find((d) => d.rule === "tiny-target")!;
  const after = analyzeDesign(payload([small, rec({ text: "Body" })]), VIEWPORT, new Set([styleSignature(small)])).defects.find(
    (d) => d.rule === "tiny-target",
  )!;
  assert.equal(before.chrome, undefined);
  assert.equal(after.chrome, true);
  assert.equal(before.detail, after.detail);
});

test("shell contrast failures are flagged as chrome defects once the shell is known", () => {
  const known = new Set([styleSignature(BAD_BADGE)]);
  const { defects } = analyzeDesign(payload([BAD_BADGE, rec({ text: "Body" })]), VIEWPORT, known);
  assert.ok(
    defects.some((d) => d.rule === "contrast" && d.chrome === true),
    JSON.stringify(defects),
  );
  assert.ok(!defects.some((d) => d.rule === "contrast" && !d.chrome), JSON.stringify(defects));
});
