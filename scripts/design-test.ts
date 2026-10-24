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
import {
  analyzeDesign,
  aspectDistortion,
  bgStack,
  contrastRatio,
  contrastVerdict,
  distinguishingLayer,
  elevationKey,
  focusedControl,
  grayCensus,
  formatDeduction,
  gradientColours,
  namesFilter,
  paintsEdge,
  formatSiteConsistency,
  scoreFrom,
  shadowLayers,
  siteAuditSection,
  siteConsistency,
  siteScore,
  type DesignSystemSample,
  styleSignature,
  touchingContainers,
  typeScale,
  type BoxGroup,
  type FocusDocument,
  type FocusElement,
  type PageImage,
} from "../src/engine/design.ts";
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
    inputType: "",
    role: "",
    filled: false,
    inForm: false,
    inRow: false,
    inSearch: false,
    inBreadcrumb: false,
    shell: false,
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
// The background text is read against: gradients, layers that may be under it, and the verdict
// ---------------------------------------------------------------------------

test("gradientColours reads every stop of every gradient layer, and refuses anything that is not one", () => {
  assert.deepEqual(gradientColours("linear-gradient(to right, oklch(0.2 0.03 260), rgb(17, 17, 17) 50%, rgba(0, 0, 0, 0.5))"), [
    "oklch(0.2 0.03 260)",
    "rgb(17, 17, 17)",
    "rgba(0, 0, 0, 0.5)",
  ]);
  assert.deepEqual(
    gradientColours(
      "radial-gradient(circle at 50% 50%, #0f172a 0%, transparent 70%), repeating-linear-gradient(45deg, lab(2 0 -5), color(display-p3 0.1 0.2 0.3))",
    ),
    ["#0f172a", "transparent", "lab(2 0 -5)", "color(display-p3 0.1 0.2 0.3)"],
  );
  assert.deepEqual(gradientColours("conic-gradient(from 90deg, color-mix(in srgb, red 50%, blue), rgb(0, 0, 0))"), [
    "color-mix(in srgb, red 50%, blue)",
    "rgb(0, 0, 0)",
  ]);
  // A picture in any layer is a picture: no colour stands for it.
  assert.equal(gradientColours('linear-gradient(rgb(0, 0, 0), rgb(17, 17, 17)), url("hero.png")'), null);
  assert.equal(gradientColours('url("hero.png")'), null);
  assert.equal(gradientColours('image-set("a.png" 1x)'), null);
  assert.equal(gradientColours("linear-gradient(to right)"), null);
});

const DARK: [number, number, number, number] = [15, 23, 42, 1];
const WHITE: [number, number, number, number] = [255, 255, 255, 1];

test("bgStack composites certain layers to one colour, over the white page when nothing opaque is found", () => {
  assert.deepEqual(bgStack([]), { bg: "rgb(255, 255, 255)" });
  assert.deepEqual(bgStack([{ cs: [DARK], maybe: false }]), { bg: "rgb(15, 23, 42)" });
  // A 12% tint over the dark panel stays dark; the same tint over the page stays nearly white.
  assert.deepEqual(
    bgStack([
      { cs: [[255, 255, 255, 0.12]], maybe: false },
      { cs: [DARK], maybe: false },
    ]),
    { bg: "rgb(44, 51, 68)" },
  );
  assert.deepEqual(bgStack([{ cs: [[0, 0, 0, 0.12]], maybe: false }]), { bg: "rgb(224, 224, 224)" });
});

test("bgStack keeps every colour a text may sit on: a gradient's stops, and what lies under a layer that may not be there", () => {
  assert.deepEqual(bgStack([{ cs: [DARK, [30, 41, 59, 1]], maybe: false }]), { bg: "varies", bgRange: ["rgb(15, 23, 42)", "rgb(30, 41, 59)"] });
  // A positioned panel that may be under the text: the page beneath it stays a possibility.
  assert.deepEqual(bgStack([{ cs: [DARK], maybe: true }]), { bg: "varies", bgRange: ["rgb(255, 255, 255)", "rgb(15, 23, 42)"] });
  // A gradient whose stops are the same colour is one colour.
  assert.deepEqual(bgStack([{ cs: [DARK, DARK], maybe: false }]), { bg: "rgb(15, 23, 42)" });
  // Past the cap the list is not worth reading: unknown.
  const many = Array.from({ length: 13 }, (_, i): [number, number, number, number] => [i * 10, 0, 0, 1]);
  assert.deepEqual(bgStack([{ cs: many, maybe: false }]), { bg: "unknown" });
});

const text = (over: Partial<Rec>): Rec => rec({ text: "Read me", color: "rgb(248, 250, 252)", ...over });

test("contrastVerdict: light text over a dark panel passes, and over the white page it fails", () => {
  assert.equal(contrastVerdict(text({ bg: "rgb(15, 23, 42)" })).kind, "pass");
  const v = contrastVerdict(text({ bg: "rgb(255, 255, 255)" }));
  assert.equal(v.kind, "fail");
  assert.equal(v.kind === "fail" && v.ratio.toFixed(2), "1.05");
});

test("contrastVerdict over a background that varies: fails only when every colour fails, passes only when every one passes", () => {
  const dark = contrastVerdict(text({ bg: "varies", bgRange: ["rgb(15, 23, 42)", "rgb(30, 41, 59)"] }));
  assert.equal(dark.kind, "pass");
  const pale = contrastVerdict(text({ color: "rgb(229, 231, 235)", bg: "varies", bgRange: ["rgb(255, 255, 255)", "rgb(243, 244, 246)"] }));
  assert.equal(pale.kind, "fail");
  // The most favourable colour is quoted, so the failure holds wherever the text sits.
  assert.equal(pale.kind === "fail" && pale.on, "rgb(255, 255, 255)");
  const mixed = contrastVerdict(text({ bg: "varies", bgRange: ["rgb(255, 255, 255)", "rgb(15, 23, 42)"] }));
  assert.equal(mixed.kind, "varies");
  assert.ok(mixed.kind === "varies" && mixed.low < 1.1 && mixed.high > 15);
});

test("contrastVerdict: mid-grey text passing over black and over white is still unsure on a gradient between them", () => {
  // #767676 passes 4.5:1 against both ends, but a black-to-white gradient passes through its own lightness.
  const grey = contrastVerdict(text({ color: "rgb(118, 118, 118)", bg: "varies", bgRange: ["rgb(0, 0, 0)", "rgb(255, 255, 255)"] }));
  assert.equal(grey.kind, "varies");
  // It quotes the ratios it measured at the ends, and says the gradient goes lower between them.
  assert.ok(grey.kind === "varies" && grey.crosses && grey.low > 4.5);
  const report = analyzeDesign(
    payload([text({ testid: "grey", color: "rgb(118, 118, 118)", bg: "varies", bgRange: ["rgb(0, 0, 0)", "rgb(255, 255, 255)"] })]),
    VIEWPORT,
  ).report;
  assert.match(report, /\[grey\] — between 4\.\d\d:1 and 4\.\d\d:1 \(needs 4\.5:1\), and lower where a gradient passes through the text's own lightness/);
  // The contrast: the same grey over one end only passes.
  assert.equal(contrastVerdict(text({ color: "rgb(118, 118, 118)", bg: "rgb(255, 255, 255)" })).kind, "pass");
});

test("contrastVerdict measures nothing it cannot read: an image, an unknown background or colour, transparent text", () => {
  for (const over of [{ bg: "image" }, { bg: "unknown" }, { color: "unknown" }, { color: "rgba(0, 0, 0, 0)" }, { bg: "varies" }, { text: "" }]) {
    assert.equal(contrastVerdict(text(over)).kind, "unmeasured", JSON.stringify(over));
  }
});

test("text over a background that varies is listed as unsure and costs nothing; a pale twin over a pale gradient is a failure", () => {
  const unsure = analyzeDesign(payload([text({ testid: "over-mixed", bg: "varies", bgRange: ["rgb(255, 255, 255)", "rgb(15, 23, 42)"] })]), VIEWPORT);
  assert.match(unsure.report, /CONTRAST unsure \(1, not scored; check by eye\):\n {2}→ \[over-mixed\] — between 1\.05:1 and 17\.\d\d:1 \(needs 4\.5:1\)/);
  assert.deepEqual(unsure.defects, []);
  assert.ok(!unsure.score?.deductions.some((d) => d.label === "contrast failures"));
  const pale = analyzeDesign(
    payload([text({ testid: "over-pale", color: "rgb(229, 231, 235)", bg: "varies", bgRange: ["rgb(255, 255, 255)", "rgb(243, 244, 246)"] })]),
    VIEWPORT,
  );
  assert.deepEqual(
    pale.defects.map((d) => d.detail),
    ["[over-pale] — 1.24:1 (needs 4.5:1) rgb(229, 231, 235) on rgb(255, 255, 255) at best, over a background that varies"],
  );
  assert.ok(!pale.report.includes("CONTRAST unsure"));
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
  // Three points each off the overall, twice that off the a11y subscore (scoreFrom).
  assert.equal(naive.score?.a11y, 100 - 2 * 5 * 3, "unaware of chrome: five failures, fifteen points, thirty off a11y");

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

test("transparent text is not a contrast failure, and faint text still is", () => {
  // A PDF viewer's text layer: every span transparent over the page it sits on, laid over the rendered canvas.
  const layer = Array.from({ length: 30 }, (_, i) =>
    rec({ tag: "span", text: `Line ${i} of the document`, color: "rgba(0, 0, 0, 0)", bg: "rgb(255, 255, 255)" }),
  );
  const clean = analyzeDesign(payload([rec({ text: "content" }), ...layer]), VIEWPORT);
  assert.ok(!clean.report.includes("CONTRAST failures"), "an unpainted text layer is never reported");
  assert.equal(clean.score?.a11y, 100);
  // The same spans painted faintly are text a reader sees, and fail.
  const faint = analyzeDesign(
    payload([rec({ text: "content" }), rec({ tag: "span", text: "Watermark", color: "rgba(0, 0, 0, 0.1)", bg: "rgb(255, 255, 255)" })]),
    VIEWPORT,
  );
  assert.ok(faint.report.includes("CONTRAST failures"), "a translucent but painted colour is measured");
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
  assert.match(
    formatJourney({ goal: "export last month", completed: false, time: { activeMs: 9000, wallMs: 9000, idleGaps: 0 } }, m),
    /^JOURNEY ABANDONED — "export last month"/,
  );
});

test("policy blocks are reported as tester safety, not held against the app", () => {
  const m = measureJourney([step("click", "/orders"), step("write-policy:blocked", "/orders"), step("click", "/orders", "REFUSED: destructive label")], true);
  assert.equal(m.policyBlocks, 1);
  assert.equal(m.refusals, 1);
  assert.equal(m.interactions, 2, "the block itself is not something the user did");
  assert.match(
    formatJourney({ goal: "g", completed: true, time: { activeMs: 1000, wallMs: 1000, idleGaps: 0 } }, m),
    /Policy: 1 write-policy blocks, 1 refusals \(tester safety, not app defects\)/,
  );
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
    // Close enough that the small one does not get WCAG 2.5.8's spacing exception.
    rec({ tag: "button", interactive: true, text: "Go", rect: { x: 16, y: 100, w: 80, h: 32 } }),
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

test("off-grid spacing and body-coloured links are measured facts the check can list, from pages that differ in only that", () => {
  // Twelve cards and three links, identical but for the padding values and whether the links are underlined.
  const body = Array.from({ length: 3 }, (_, i) => rec({ text: `Paragraph ${i} with enough words`, textLen: 60, color: "rgb(17, 17, 17)" }));
  const page = (padding: [number, number, number, number], underline: boolean) =>
    payload([
      ...body,
      ...Array.from({ length: 12 }, () => rec({ padding })),
      ...["Home", "Orders", "Help"].map((text) => rec({ tag: "a", text, textLen: text.length, color: "rgb(17, 17, 17)", underline })),
    ]);
  const drifting = analyzeDesign(page([13, 7, 13, 7], false), VIEWPORT);
  const tidy = analyzeDesign(page([12, 8, 12, 8], true), VIEWPORT);
  const rules = (d: typeof drifting) => d.defects.map((x) => x.rule).filter((r) => r === "off-grid-spacing" || r === "indistinct-link");
  assert.deepEqual(rules(drifting), ["off-grid-spacing", "indistinct-link"]);
  assert.deepEqual(rules(tidy), []);
  const spacing = drifting.defects.find((d) => d.rule === "off-grid-spacing")!;
  // No counts or percentages: the same values on another page are the same fact, with the same fingerprint.
  assert.equal(spacing.detail, "paddings off a 4px grid: 7px, 13px");
  assert.match(drifting.report, /SPACING: \d+% of paddings are off a 4px grid/, "the audit's own line says the same");
  const link = drifting.defects.find((d) => d.rule === "indistinct-link")!;
  assert.equal(link.detail, "links with no underline in the body-text colour rgb(17, 17, 17)");
  assert.match(drifting.report, /3 link\(s\) with no underline AND the same color as body text/);
});

/** The tiny-target defects of a page of these records. */
const tinyOf = (records: Rec[]) =>
  analyzeDesign(payload(records), VIEWPORT)
    .defects.filter((d) => d.rule === "tiny-target")
    .map((d) => d.detail);

test("a native checkbox is measured with the label that wraps it; the same checkbox with its label elsewhere is not", () => {
  // A row: an "Edit" button, then 4px to its right a 13px checkbox. Only the label differs.
  const edit = rec({ tag: "button", interactive: true, text: "Edit", rect: { x: 0, y: 0, w: 60, h: 32 } });
  const checkbox = (target?: Rec["target"]) =>
    rec({ tag: "input", testid: "remember", interactive: true, text: "", textLen: 0, rect: { x: 64, y: 9, w: 13, h: 13 }, ...(target ? { target } : {}) });
  // Wrapped in a 200×32 <label>: that label is what the user clicks.
  assert.deepEqual(tinyOf([edit, checkbox({ x: 64, y: 0, w: 200, h: 32 })]), []);
  // A for= label 100px away operates it too, but the box beside the Edit button is 13px.
  assert.deepEqual(tinyOf([edit, checkbox()]), ["[remember] — 13×13px tap target"]);
});

test("a visually hidden file input is measured as the drop zone that operates it", () => {
  const neighbour = rec({ tag: "button", interactive: true, text: "Cancel", rect: { x: 0, y: 0, w: 80, h: 32 } });
  const input = (target?: Rec["target"]) =>
    rec({ tag: "input", testid: "upload-input", interactive: true, text: "", textLen: 0, rect: { x: 84, y: 10, w: 1, h: 1 }, ...(target ? { target } : {}) });
  assert.deepEqual(tinyOf([neighbour, input({ x: 84, y: 0, w: 320, h: 120 })]), []);
  assert.deepEqual(tinyOf([neighbour, input()]), ["[upload-input] — 1×1px tap target"]);
});

test("WCAG 2.5.8 spacing: a small target alone passes; two small targets side by side do not", () => {
  const icon = (testid: string, x: number, y: number) => rec({ tag: "button", testid, interactive: true, text: "", textLen: 0, rect: { x, y, w: 16, h: 16 } });
  // Two 16px icon buttons 4px apart: their 24px circles overlap.
  assert.deepEqual(tinyOf([icon("edit", 0, 16), icon("remove", 20, 16)]).sort(), ["[edit] — 16×16px tap target", "[remove] — 16×16px tap target"]);
  // One 16px button alone in a 48px row, the next row's 48px below.
  assert.deepEqual(tinyOf([icon("select-1", 0, 16), icon("select-2", 0, 64)]), []);
  // A full-size target within 12px of the small one's centre also fails it.
  assert.deepEqual(tinyOf([icon("select-1", 0, 16), rec({ tag: "a", interactive: true, text: "Order 1", rect: { x: 18, y: 12, w: 120, h: 24 } })]), [
    "[select-1] — 16×16px tap target",
  ]);
});

test("a control is one fact whether or not the shell is known yet: same rule, same wording", () => {
  const small = rec({ tag: "button", testid: "nav-x", interactive: true, text: "x", rect: { x: 0, y: 0, w: 14.4, h: 14.4 } });
  const beside = rec({ tag: "button", interactive: true, text: "Menu", rect: { x: 16, y: 0, w: 80, h: 32 } });
  const before = analyzeDesign(payload([small, beside, rec({ text: "Body" })]), VIEWPORT).defects.find((d) => d.rule === "tiny-target")!;
  const after = analyzeDesign(payload([small, beside, rec({ text: "Body" })]), VIEWPORT, new Set([styleSignature(small)])).defects.find(
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

// ---------------------------------------------------------------------------
// Task efficiency counts actions and form fields, not every control
// ---------------------------------------------------------------------------

const GREY = "rgb(209, 213, 219)";
const BLUE = "rgb(20, 80, 200)";
const BURDEN = /form fields and NONE marked required|fields of which only|input fields but no obvious submit/;
const COMPETING = /equally-prominent actions compete/;

const field = (over: Partial<Rec> = {}): Rec =>
  rec({ tag: "input", inputType: "text", interactive: true, text: "", textLen: 0, bg: "rgb(255, 255, 255)", rect: { x: 300, y: 100, w: 320, h: 36 }, ...over });
const button = (text: string, over: Partial<Rec> = {}): Rec =>
  rec({
    tag: "button",
    text,
    textLen: text.length,
    interactive: true,
    filled: true,
    bg: BLUE,
    color: "rgb(255, 255, 255)",
    rect: { x: 300, y: 400, w: 120, h: 40 },
    ...over,
  });

test("row-selection checkboxes and a search box are not a form; six bare fields in a <form> are", () => {
  const list = [
    rec({ text: "Things", bg: GREY }),
    field({ inputType: "search", bg: GREY }),
    ...Array.from({ length: 26 }, (_, i) => field({ inputType: "checkbox", inRow: true, rect: { x: 10, y: 120 + i * 40, w: 16, h: 16 } })),
  ];
  const listReport = analyzeDesign(payload(list), VIEWPORT).report;
  assert.ok(!BURDEN.test(listReport), `a list page asks the user to fill nothing in:\n${listReport}`);

  const form = [rec({ text: "New thing", bg: GREY }), ...Array.from({ length: 6 }, (_, i) => field({ inForm: true, testid: `f-${i}` }))];
  const formReport = analyzeDesign(payload(form), VIEWPORT).report;
  assert.ok(formReport.includes("6 form fields and NONE marked required"), "a real form with nothing marked required is still flagged");
  assert.ok(formReport.includes("6 input fields but no obvious submit"), "and so is one with no way to submit it");
});

test("a select per table row edits the row in place; the same selects in a form are fields", () => {
  const select = (inRow: boolean, i: number): Rec => field({ tag: "select", inputType: "", inRow, inForm: !inRow, testid: `role-${i}` });
  const table = analyzeDesign(payload([rec({ text: "Members" }), ...Array.from({ length: 18 }, (_, i) => select(true, i))]), VIEWPORT).report;
  assert.ok(!BURDEN.test(table), "inline-edit selects are not a form to fill in");
  const form = analyzeDesign(payload([rec({ text: "Members" }), ...Array.from({ length: 18 }, (_, i) => select(false, i))]), VIEWPORT).report;
  assert.ok(BURDEN.test(form), "the same controls in a form are a burden the rule should measure");
});

test("a page with no <form> is judged on its loose fields; the same fields in table rows are not", () => {
  // Many apps build a form without the element, so its absence cannot excuse the fields.
  const loose = (inRow: boolean): string =>
    analyzeDesign(payload([rec({ text: "New thing" }), ...Array.from({ length: 6 }, (_, i) => field({ inRow, testid: `f-${i}` }))]), VIEWPORT).report;
  assert.ok(loose(false).includes("6 form fields and NONE marked required"), "six bare fields with no <form> are still a form");
  assert.ok(!BURDEN.test(loose(true)), "six controls in table rows edit those rows");
});

test("a ghost button showing its card's background is not a competing action; the same button filled is", () => {
  const ghost = (filled: boolean): string =>
    analyzeDesign(
      payload([
        rec({ text: "Page", bg: GREY }),
        ...["One", "Two", "Three", "Four"].map((t, i) =>
          button(t, { filled, bg: "rgb(255, 255, 255)", color: "rgb(30, 30, 30)", rect: { x: 300 + i * 130, y: 60, w: 120, h: 40 } }),
        ),
      ]),
      VIEWPORT,
    ).report;
  assert.ok(COMPETING.test(ghost(true)), "four white-filled buttons on a grey page compete");
  assert.ok(!COMPETING.test(ghost(false)), "four ghost buttons over a white card do not");
});

test("fields outside the <form> do not count against it", () => {
  // Filters beside a form are not part of what it submits.
  const filters = Array.from({ length: 9 }, (_, i) => field({ tag: "select", inputType: "", testid: `filter-${i}` }));
  const form = [
    field({ inForm: true, required: true, testid: "name" }),
    field({ inForm: true, testid: "notes" }),
    button("Save", { inForm: true, submitish: true }),
  ];
  const { report } = analyzeDesign(payload([rec({ text: "Page" }), ...filters, ...form]), VIEWPORT);
  assert.ok(!BURDEN.test(report), report);
});

test("white fields on a grey page are not competing actions; five filled buttons are", () => {
  const formPage = [
    rec({ text: "New thing", bg: GREY }),
    rec({ tag: "a", text: "Things", interactive: true, inBreadcrumb: true, filled: true, bg: "rgb(255, 255, 255)", rect: { x: 0, y: 0, w: 80, h: 24 } }),
    ...Array.from({ length: 6 }, (_, i) => field({ inForm: true, testid: `f-${i}`, rect: { x: 300, y: 100 + i * 50, w: 320, h: 36 } })),
    button("Create", { inForm: true, submitish: true }),
    button("Cancel", { inForm: true, bg: "rgb(255, 255, 255)", color: "rgb(30, 30, 30)", rect: { x: 440, y: 400, w: 120, h: 40 } }),
  ];
  const calm = analyzeDesign(payload(formPage), VIEWPORT).report;
  assert.ok(!COMPETING.test(calm), `one primary and one secondary button do not compete:\n${calm}`);
  assert.ok(!calm.includes("no visually dominant action"), "and the primary button is still recognised as the next step");

  const busy = [
    rec({ text: "Toolbar", bg: GREY }),
    ...["Export", "Import", "Archive", "Share", "Delete"].map((t, i) => button(t, { rect: { x: 300 + i * 130, y: 60, w: 120, h: 40 } })),
  ];
  assert.ok(COMPETING.test(analyzeDesign(payload(busy), VIEWPORT).report), "five filled primary-coloured buttons still compete");
});

test("a link painted as a button competes; a plain or breadcrumb link does not", () => {
  const link = (i: number, over: Partial<Rec>): Rec =>
    rec({ tag: "a", text: `Go ${i}`, interactive: true, bg: BLUE, rect: { x: 300 + i * 130, y: 60, w: 120, h: 40 }, ...over });
  const page = (over: Partial<Rec>): string =>
    analyzeDesign(payload([rec({ text: "Page", bg: GREY }), ...[0, 1, 2, 3].map((i) => link(i, over))]), VIEWPORT).report;
  assert.ok(COMPETING.test(page({ filled: true })), "filled links read as buttons");
  assert.ok(!COMPETING.test(page({ filled: false })), "links on a coloured ancestor are text, not buttons");
  assert.ok(!COMPETING.test(page({ filled: true, inBreadcrumb: true })), "a breadcrumb is a way back, not an action");
});

// ---------------------------------------------------------------------------
// The shell is known from the first audit, not after the census warms up
// ---------------------------------------------------------------------------

const sidebar = (): Rec[] =>
  Array.from({ length: 30 }, (_, i) =>
    rec({
      tag: "a",
      text: `Section ${i}`,
      interactive: true,
      filled: true,
      shell: true,
      bg: "rgb(30, 41, 59)",
      color: "rgb(100, 116, 139)",
      rect: { x: 0, y: i * 30, w: 220, h: 28 },
    }),
  );

test("a sidebar in a shell landmark is chrome on the first audit; a page's own header is not", () => {
  const ownHeader = rec({ tag: "h1", text: "Things", color: "rgb(200, 200, 200)", bg: "rgb(255, 255, 255)", rect: { x: 300, y: 20, w: 400, h: 40 } });
  const records = [rec({ text: "Body copy" }), ownHeader, button("New thing", { rect: { x: 900, y: 20, w: 120, h: 40 } }), ...sidebar()];
  const first = analyzeDesign(payload(records), VIEWPORT);
  assert.ok(first.report.includes("30 shared-chrome elements excluded from the score"), first.report);
  assert.ok(!COMPETING.test(first.report), "the sidebar's links are not this page's actions");
  assert.ok(first.report.includes("SHARED CHROME"), "the sidebar's contrast failures are still reported, as the shell's");

  const known = analyzeDesign(payload(records), VIEWPORT, new Set(sidebar().map(styleSignature)));
  assert.deepEqual(first.score, known.score, "the page scores the same before and after the census knows the shell");

  assert.ok(first.report.includes("CONTRAST failures"), "the page's own header is judged as page content");
  assert.ok(
    first.defects.some((d) => d.rule === "contrast" && !d.chrome && d.detail.includes("Things")),
    "and its defect is the page's, not the shell's",
  );
});

test("body-coloured links in the shell are still measured, as the shell's; link-coloured ones are not flagged", () => {
  const body = "rgb(17, 17, 17)";
  const paragraph = rec({ tag: "p", text: "A paragraph of body copy long enough to set the body colour.", textLen: 60, color: body });
  const navLink = (color: string): Rec => rec({ tag: "a", text: "Reports", interactive: true, shell: true, color });
  const plain = analyzeDesign(payload([paragraph, paragraph, navLink(body)]), VIEWPORT);
  const flagged = plain.defects.find((d) => d.rule === "indistinct-link");
  assert.ok(flagged?.chrome, `the shell's navigation link is reported, and as the shell's: ${JSON.stringify(plain.defects)}`);
  assert.ok(plain.report.includes(`→ ${flagged.detail}`), "and the prose says it as a convention, the way the page's own section does");
  const blue = analyzeDesign(payload([paragraph, paragraph, navLink("rgb(20, 80, 200)")]), VIEWPORT);
  assert.ok(!blue.defects.some((d) => d.rule === "indistinct-link"), "a link that looks like a link is not flagged");
});

// ---------------------------------------------------------------------------
// Filter panels outside a form are not forms
// ---------------------------------------------------------------------------

test("twelve instant-apply checkboxes with no <form> ask for nothing; six text fields with no <form> still need a submit", () => {
  const boxes = (over: Partial<Rec>): string =>
    analyzeDesign(
      payload([
        rec({ text: "Things" }),
        ...Array.from({ length: 12 }, (_, i) => field({ inputType: "checkbox", testid: `opt-${i}`, rect: { x: 10, y: 100 + i * 30, w: 120, h: 24 }, ...over })),
      ]),
      VIEWPORT,
    ).report;
  assert.ok(!BURDEN.test(boxes({})), `checkboxes outside a form apply as they change:\n${boxes({})}`);
  assert.ok(!BURDEN.test(boxes({ inFilter: true })), "and in a panel that names itself a filter, plainly so");
  const texts = analyzeDesign(payload([rec({ text: "New thing" }), ...Array.from({ length: 6 }, (_, i) => field({ testid: `t-${i}` }))]), VIEWPORT).report;
  assert.ok(texts.includes("6 input fields but no obvious submit"), `six typed fields with no way to commit them are still flagged:\n${texts}`);
  assert.ok(texts.includes("6 form fields and NONE marked required"), "and so is their missing required marking");
});

test("a filter bar of selects and dates applied on change is not a form; the same typed fields outside a filter are", () => {
  const bar = (inFilter: boolean): string =>
    analyzeDesign(
      payload([
        rec({ text: "History" }),
        ...["action", "user", "order"].map((t) => field({ tag: "select", inputType: "", testid: t, inFilter })),
        ...["from", "to", "after", "before"].map((t) => field({ inputType: "date", testid: t, inFilter })),
      ]),
      VIEWPORT,
    ).report;
  assert.ok(!BURDEN.test(bar(true)), `a panel that names itself a filter asks for nothing:\n${bar(true)}`);
  assert.ok(bar(false).includes("4 input fields but no obvious submit"), `four loose date fields are judged, the selects are not:\n${bar(false)}`);
});

test("a filter is named by a whole word of a test id, id or label", () => {
  for (const said of ["filter-panel", "productFilters", "Filter by status", "search-facets", "FILTERS"]) assert.ok(namesFilter(said), said);
  for (const said of ["filterable-list", "unfiltered", "Profile", "Search", "", "backdrop"]) assert.ok(!namesFilter(said), said);
});

// ---------------------------------------------------------------------------
// The shadow census counts drawn layers; tinted grays are grays
// ---------------------------------------------------------------------------

const RINGS = "rgb(255, 255, 255) 0px 0px 0px 0px inset, rgba(0, 0, 0, 0) 0px 0px 0px 0px";

test("a box-shadow's empty ring layers draw nothing and are not an elevation", () => {
  assert.deepEqual(shadowLayers(`${RINGS}, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px`), [
    "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px",
    "rgba(0, 0, 0, 0.1) 0px 1px 2px -1px",
  ]);
  assert.equal(elevationKey(RINGS), "", "only empty rings: no shadow");
  assert.equal(elevationKey("transparent 0px 4px 8px 0px"), "", "a transparent layer draws nothing");
  assert.equal(elevationKey("rgb(59, 130, 246) 0px 0px 0px 2px"), "rgb(59, 130, 246) 0px 0px 0px 2px", "a focus ring has a spread and is drawn");

  const ringsOnly = analyzeDesign(
    payload(Array.from({ length: 6 }, (_, i) => rec({ text: `Card ${i}`, shadow: `${RINGS.replace("255, 255, 255", `25${i}, 255, 255`)}` }))),
    VIEWPORT,
  ).report;
  assert.ok(ringsOnly.includes("0 shadow styles"), `six spellings of an empty ring are no shadow:\n${ringsOnly}`);
});

test("shadows that differ only past the first forty characters are shown apart", () => {
  const real = ["0px 1px 2px 0px", "0px 1px 3px 0px", "0px 4px 6px -1px", "0px 10px 15px -3px", "0px 20px 25px -5px"];
  const records = real.map((r, i) => rec({ text: `Card ${i}`, shadow: `${RINGS}, rgba(0, 0, 0, 0.1) ${r}` }));
  const { report } = analyzeDesign(payload(records), VIEWPORT);
  const line = report.split("\n").find((l) => l.includes("distinct box-shadow styles")) ?? "";
  assert.ok(line.includes("5 distinct box-shadow styles"), report);
  const examples = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(examples.length, 3, line);
  assert.equal(new Set(examples).size, 3, `three different shadows print three different examples: ${line}`);
  assert.ok(
    examples.every((e) => !e.includes("inset")),
    `and none is the empty ring they all start with: ${line}`,
  );

  const twoLayer = (second: string): string => `rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) ${second}`;
  const keys = [elevationKey(twoLayer("0px 1px 2px -1px")), elevationKey(twoLayer("0px 2px 4px -2px"))];
  assert.equal(distinguishingLayer(keys[0], keys), "rgba(0, 0, 0, 0.1) 0px 1px 2px -1px", "the layer the other lacks, not the shared first one");
});

test("tinted grays are counted as grays, near-duplicates as one step, and a blue as a hue", () => {
  const steps = grayCensus([
    [100, 116, 139],
    [71, 85, 105],
    [101, 116, 140],
    [59, 130, 246],
  ]);
  assert.deepEqual(
    steps.map((g) => [g.rgb, g.n]),
    [
      [[100, 116, 139], 2],
      [[71, 85, 105], 1],
    ],
  );
  const page = analyzeDesign(
    payload([
      rec({ text: "Muted", color: "rgb(100, 116, 139)" }),
      rec({ text: "Muter", color: "rgb(71, 85, 105)" }),
      rec({ text: "Link", color: "rgb(59, 130, 246)" }),
    ]),
    VIEWPORT,
  ).report;
  assert.ok(page.includes("2 grays (4–6)"), page);
  assert.ok(page.includes("1 accent hue families"), page);
});

// ---------------------------------------------------------------------------
// Elements are named as the snapshot names them, and unnamed fields cost a11y
// ---------------------------------------------------------------------------

test("a field labelled only by its placeholder costs the a11y score; the same field with a <label> does not", () => {
  const email = (over: Partial<Rec>): Payload =>
    payload([rec({ text: "Sign up" }), field({ inForm: true, ...over }), button("Save", { inForm: true, submitish: true })]);
  const bare = analyzeDesign(email({ name: "you@example.test", nameFrom: "placeholder" }), VIEWPORT);
  assert.ok((bare.score?.a11y ?? 100) < 100, bare.report);
  assert.ok(bare.report.includes(`<input> "you@example.test" — labelled only by its placeholder`), bare.report);
  const labelled = analyzeDesign(email({ name: "Email", nameFrom: null }), VIEWPORT);
  assert.equal(labelled.score?.a11y, 100, labelled.report);
  assert.ok(!labelled.report.includes("NAMES"), labelled.report);

  const nameless = analyzeDesign(email({ name: "email", nameFrom: "fallback" }), VIEWPORT);
  assert.ok(nameless.report.includes("field with no accessible name"), `a field named only by its name attribute is unnamed:\n${nameless.report}`);
  assert.ok((nameless.score?.a11y ?? 100) < (bare.score?.a11y ?? 0), "and costs more than a placeholder, which is at least announced");
});

test("an icon button is named by its aria-label; the same button with no name is an unnamed control", () => {
  const icon = (name: string): ReturnType<typeof analyzeDesign> =>
    analyzeDesign(
      payload([
        rec({ text: "Notice" }),
        button("", { name, bg: "rgb(255, 255, 255)", color: "rgb(30, 30, 30)", rect: { x: 300, y: 100, w: 22, h: 22 } }),
        button("Undo", { bg: "rgb(255, 255, 255)", color: "rgb(30, 30, 30)", rect: { x: 322, y: 100, w: 22, h: 22 } }),
      ]),
      VIEWPORT,
    );
  const dismiss = icon("Dismiss");
  assert.ok(dismiss.report.includes(`<button> "Dismiss" — 22×22px`), dismiss.report);
  assert.ok(!dismiss.report.includes("(no text)"), dismiss.report);
  assert.ok(!dismiss.report.includes("NAMES"), dismiss.report);
  const unnamed = icon("");
  assert.ok(unnamed.report.includes(`<button> "(no text)" — control with no accessible name`), unnamed.report);
  assert.ok((unnamed.score?.a11y ?? 100) < (dismiss.score?.a11y ?? 0), "the unnamed one costs the page");
});

test("an unnamed control hidden from assistive technology needs no name; the same control exposed does", () => {
  const page = (ariaHidden: boolean) =>
    analyzeDesign(payload([rec({ text: "Notice" }), button("", { name: "", ariaHidden, bg: "rgb(255, 255, 255)", color: "rgb(30, 30, 30)" })]), VIEWPORT);
  assert.ok(!page(true).report.includes("NAMES"), page(true).report);
  assert.ok((page(false).score?.a11y ?? 100) < (page(true).score?.a11y ?? 0), page(false).report);
});

test("an icon button the snapshot names by its image's alt text is not listed; the same button with an empty alt is", () => {
  // The audit reads the snapshot's name (page-sources.ts PICK_NAME_SRC), which names a control by its image content.
  const page = (name: string) =>
    analyzeDesign(payload([rec({ text: "Notice" }), button("", { name, bg: "rgb(255, 255, 255)", color: "rgb(30, 30, 30)" })]), VIEWPORT);
  const search = page("Search");
  assert.ok(!search.report.includes("NAMES"), search.report);
  assert.equal(search.score?.a11y, 100, search.report);
  const blank = page("");
  assert.ok(blank.report.includes(`<button> "(no text)" — control with no accessible name`), blank.report);
  assert.ok((blank.score?.a11y ?? 100) < 100, blank.report);
});

// ---------------------------------------------------------------------------
// image-aspect — only object-fit: fill stretches a picture out of its proportions
// ---------------------------------------------------------------------------

test("a 2:1 image in a square box is distorted under fill and not under any object-fit that keeps its proportions", () => {
  const img = (fit: string): PageImage => ({ label: "[hero]", nw: 200, nh: 100, rw: 200, rh: 200, fit });
  const cases: Array<[string, boolean]> = [
    ["fill", true],
    ["cover", false],
    ["contain", false],
    ["scale-down", false],
    ["none", false],
  ];
  for (const [fit, distorted] of cases) assert.equal(aspectDistortion(img(fit)) !== null, distorted, fit);
  // The same fit with a box that matches the picture is not distortion either.
  assert.equal(aspectDistortion({ ...img("fill"), rh: 100 }), null);
});

test("analyzeDesign files image-aspect for a stretched fill image and not for the same image under cover", () => {
  const audit = (fit: string) => {
    const p = payload([rec({ text: "content" })]);
    p.page.images = [{ label: "[hero]", nw: 5000, nh: 3500, rw: 1280, rh: 475, fit }];
    return analyzeDesign(p, VIEWPORT);
  };
  const fill = audit("fill");
  assert.ok(
    fill.defects.some((d) => d.rule === "image-aspect" && d.detail.startsWith("[hero] — rendered 1280×475")),
    JSON.stringify(fill.defects),
  );
  assert.ok(fill.report.includes("IMAGES (1 distorted)"), fill.report);
  const cover = audit("cover");
  assert.ok(!cover.defects.some((d) => d.rule === "image-aspect"), JSON.stringify(cover.defects));
  assert.ok(!cover.report.includes("IMAGES ("), cover.report);
});

/** A document whose active element is `focused`, or its body when nothing is. */
function doc(focused: FocusElement | null): FocusDocument {
  const body = { tagName: "BODY" };
  return { activeElement: focused ?? body, body, documentElement: { tagName: "HTML" } };
}
const frame = (inner: FocusDocument | null, tagName = "IFRAME"): FocusElement => ({ tagName, contentDocument: inner });

test("the focus walk measures the control focused inside a same-origin frame, never the frame element", () => {
  const button = { tagName: "BUTTON" };
  const cases: Array<[string, FocusDocument, FocusElement | "frame" | null]> = [
    ["a button in the page", doc(button), button],
    ["nothing focused in the page ends the sampling", doc(null), null],
    ["a button inside a same-origin iframe", doc(frame(doc(button))), button],
    ["a button inside a frame of a frameset", doc(frame(doc(button), "FRAME")), button],
    ["a button two same-origin frames deep", doc(frame(doc(frame(doc(button))))), button],
    ["focus inside another site's frame is skipped", doc(frame(null)), "frame"],
    ["a same-origin frame with nothing focused inside is skipped", doc(frame(doc(null))), "frame"],
  ];
  for (const [name, d, want] of cases) assert.equal(focusedControl(d), want, name);
});

// ---------------------------------------------------------------------------
// Touching containers: separate cards drawn edge to edge
// ---------------------------------------------------------------------------

type Box = BoxGroup["boxes"][number];
const PAGE_BG = "rgb(255, 255, 255)";
const CARD_SHADOW = "rgba(0, 0, 0, 0.08) 0px 1px 3px 0px";

/** A bordered, rounded card 600×120 at (x, y); override what a case is about. */
function box(label: string, y: number, over: Partial<Box> = {}): Box {
  return {
    label,
    rect: { x: 40, y, w: 600, h: 120 },
    border: 1,
    bg: "rgba(255, 255, 255, 1)",
    parentBg: PAGE_BG,
    shadow: "",
    radii: [8, 8, 8, 8],
    ...over,
  };
}

/** Two cards stacked in one parent, `gap` px apart. */
const stack = (gap: number, over: Partial<Box> = {}): BoxGroup => ({
  parent: "<div.settings>",
  shell: false,
  boxes: [box('<section> "Profile"', 100, over), box('<section> "Password"', 220 + gap, over)],
});

test("two rounded bordered cards 0px apart touch; the same cards 8px apart do not", () => {
  const touching = touchingContainers([stack(0)]);
  assert.deepEqual(touching, [{ parent: "<div.settings>", pairs: [{ a: '<section> "Profile"', b: '<section> "Password"', axis: "vertical", gap: 0 }] }]);
  assert.equal(touchingContainers([stack(2)]).length, 1, "2px still reads as touching");
  assert.deepEqual(touchingContainers([stack(8)]), [], "an 8px gap is a gap");
  assert.deepEqual(touchingContainers([stack(3)]), [], "past 2px is outside the rule");
});

test("a group joined with square corners is an intended join, shadowed or not", () => {
  const square = { radii: [0, 0, 0, 0] as Box["radii"] };
  assert.deepEqual(touchingContainers([stack(0, square)]), [], "a list group squares the corners where its items meet");
  assert.deepEqual(touchingContainers([stack(0, { ...square, shadow: CARD_SHADOW })]), [], "an elevated accordion's items meet square too");
  assert.equal(touchingContainers([stack(0, { shadow: CARD_SHADOW })]).length, 1, "rounded shadowed cards meeting are two cards");
  // A tab sitting on a wider panel: the panel's far top-right corner is rounded, but nowhere near the tab.
  const tabs: BoxGroup = {
    parent: "<div.tabs>",
    shell: false,
    boxes: [
      box('<div> "Tab"', 100, { rect: { x: 40, y: 100, w: 300, h: 40 }, radii: [6, 6, 0, 0] }),
      box('<div> "Panel"', 140, { rect: { x: 40, y: 140, w: 600, h: 200 }, radii: [0, 6, 6, 6] }),
    ],
  };
  assert.deepEqual(touchingContainers([tabs]), [], "only corners inside the shared edge count");
  // Rounded only on the group's outer corners: the first item's top, the last item's bottom.
  const outer: BoxGroup = {
    parent: "<ul.list-group>",
    shell: false,
    boxes: [box('<li> "One"', 100, { radii: [8, 8, 0, 0] }), box('<li> "Two"', 220, { radii: [0, 0, 8, 8] })],
  };
  assert.deepEqual(touchingContainers([outer]), [], "a group rounded only at its outer corners is one shape");
});

test("boxes that tighten the corners where they meet are one group; cards rounded alike on every corner are two", () => {
  // Grouped chat bubbles: 2px apart, 18px outside, 4px where they meet. The contrastive twin is the same two boxes
  // with every corner 18px, which is two cards with a missing gap.
  const bubble = (label: string, y: number, radii: Box["radii"]): Box =>
    box(label, y, { rect: { x: 300, y, w: 300, h: 40 }, border: 0, bg: "rgba(30, 64, 175, 1)", radii });
  const bubbles = (first: Box["radii"], second: Box["radii"]): BoxGroup => ({
    parent: "<div.chat>",
    shell: false,
    boxes: [bubble('<div> "Is it ready?"', 100, first), bubble('<div> "It was due."', 142, second)],
  });
  assert.deepEqual(touchingContainers([bubbles([18, 18, 4, 18], [18, 4, 18, 18])]), [], "tightened where they meet");
  assert.equal(touchingContainers([bubbles([18, 18, 18, 18], [18, 18, 18, 18])]).length, 1, "rounded alike on every corner");
  // One side tightened is enough: the upper bubble alone squares its joining corner.
  assert.deepEqual(touchingContainers([bubbles([18, 18, 4, 18], [18, 18, 18, 18])]), []);
  // Side by side: the left box tightens its right-hand corners.
  const row = (left: Box["radii"]): BoxGroup => ({
    parent: "<div.row>",
    shell: false,
    boxes: [
      box("[left]", 100, { rect: { x: 40, y: 100, w: 200, h: 100 }, radii: left }),
      box("[right]", 100, { rect: { x: 240, y: 100, w: 200, h: 100 }, radii: [8, 8, 8, 8] }),
    ],
  });
  assert.deepEqual(touchingContainers([row([8, 2, 2, 8])]), []);
  assert.equal(touchingContainers([row([8, 8, 8, 8])]).length, 1);
});

test("a box shows an edge only by a border, a shadow or a fill unlike what it sits on", () => {
  const bare = { border: 0 };
  assert.equal(paintsEdge(box("a", 0, bare)), false, "a white box on a white page with no border is invisible");
  assert.deepEqual(touchingContainers([stack(0, bare)]), [], "so two of them touching is nothing anyone sees");
  assert.equal(paintsEdge(box("a", 0, { ...bare, bg: "rgba(243, 244, 246, 1)" })), true, "a gray fill on white is a visible box");
  assert.equal(touchingContainers([stack(0, { ...bare, bg: "rgba(243, 244, 246, 1)" })]).length, 1);
  assert.equal(paintsEdge(box("a", 0, { ...bare, bg: "rgba(0, 0, 0, 0.01)" })), false, "a near-transparent tint changes nothing visible");
  assert.equal(paintsEdge(box("a", 0, { ...bare, shadow: "rgba(0, 0, 0, 0) 0px 0px 0px 0px" })), false, "an empty shadow layer draws nothing");
});

test("cards side by side touch on the horizontal axis; shell groups are left to the shell", () => {
  const row: BoxGroup = {
    parent: "[stats-row]",
    shell: false,
    boxes: [box("[stat-a]", 100, { rect: { x: 40, y: 100, w: 200, h: 100 } }), box("[stat-b]", 100, { rect: { x: 241, y: 100, w: 200, h: 100 } })],
  };
  assert.deepEqual(touchingContainers([row])[0]?.pairs, [{ a: "[stat-a]", b: "[stat-b]", axis: "horizontal", gap: 1 }]);
  assert.deepEqual(touchingContainers([{ ...row, shell: true }]), []);
  const offset: BoxGroup = { ...row, boxes: [row.boxes[0], { ...row.boxes[1], rect: { x: 241, y: 180, w: 200, h: 100 } }] };
  assert.deepEqual(touchingContainers([offset]), [], "boxes that share under half their height are not stacked side by side");
});

test("touching containers are a defect naming the parent, and cost the page points", () => {
  const primary = rec({
    tag: "button",
    text: "Save",
    interactive: true,
    filled: true,
    rect: { x: 40, y: 400, w: 100, h: 36 },
    bg: "rgb(30, 64, 175)",
    color: "rgb(255, 255, 255)",
  });
  const page = (gap: number): ReturnType<typeof analyzeDesign> =>
    analyzeDesign({ ...payload([rec({ text: "Settings" }), primary]), page: { ...payload([]).page, boxGroups: [stack(gap)] } }, VIEWPORT);
  const touching = page(0);
  const spaced = page(8);
  assert.deepEqual(
    touching.defects.filter((d) => d.rule === "touching-containers").map((d) => d.detail),
    ['in <div.settings>: <section> "Profile" and <section> "Password" 0px apart'],
  );
  assert.ok(/TOUCHING CONTAINERS \(1 pair\):\n  ⚠ in <div\.settings>/.test(touching.report), touching.report);
  assert.ok(!spaced.defects.some((d) => d.rule === "touching-containers"), spaced.report);
  assert.equal(spaced.score?.overall, 100);
  assert.equal(touching.score?.overall, 92);
  assert.ok(touching.report.includes("  why: -8 touching containers"), touching.report);
});

// ---------------------------------------------------------------------------
// Score: deductions, their weight and the calibration set
// ---------------------------------------------------------------------------

test("the score is 100 less its deductions; a subscore falls twice as fast and the largest are listed first", () => {
  const s = scoreFrom([
    { dimension: "craft", label: "touching containers", count: 2, points: 16 },
    { dimension: "consistency", label: "6 button heights", count: 1, points: 12 },
    { dimension: "a11y", label: "contrast failures", count: 1, points: 3 },
  ]);
  assert.deepEqual(
    { overall: s.overall, a11y: s.a11y, craft: s.craft, consistency: s.consistency, clarity: s.clarity },
    { overall: 69, a11y: 94, craft: 68, consistency: 76, clarity: 100 },
  );
  assert.deepEqual(s.deductions.map(formatDeduction), ["-16 touching containers ×2", "-12 6 button heights", "-3 contrast failures"]);
  assert.equal(scoreFrom(Array.from({ length: 30 }, () => ({ dimension: "a11y" as const, label: "x", count: 1, points: 9 }))).overall, 0, "floors at 0");
});

/**
 * The calibration set: synthetic pages the design-scores smoke suite renders
 * as test-app/design-score.html, one `?with=` variant each. Each defect page
 * differs from the clean one in the one fact it is named for.
 */
function calibrationPage(kind: "clean" | "touching" | "spaced" | "heights" | "grays" | "defective"): Payload {
  const text = (t: string, color = "rgb(23, 23, 23)") => rec({ text: t, color });
  // One filled primary action and outlined secondary ones, so the page has a next step and nothing competes with it.
  const button = (h: number, i: number) =>
    rec({
      tag: "button",
      text: `Action ${i}`,
      interactive: true,
      filled: i === 0,
      rect: { x: 40 + i * 120, y: 400, w: 100, h },
      radius: 6,
      ...(i === 0 ? { bg: "rgb(30, 64, 175)", color: "rgb(255, 255, 255)" } : { color: "rgb(30, 64, 175)" }),
    });
  const heights = kind === "heights" || kind === "defective" ? [28, 32, 36, 40, 44, 48] : [36, 36, 36, 36, 36, 36];
  const grays =
    kind === "grays" || kind === "defective"
      ? Array.from({ length: 12 }, (_, i) => `rgb(${30 + i * 5}, ${30 + i * 5}, ${30 + i * 5})`)
      : ["rgb(64, 64, 64)", "rgb(115, 115, 115)"];
  const records = [rec({ tag: "h1", text: "Settings", fontSize: 30 }), ...grays.map((g, i) => text(`Note ${i}`, g)), ...heights.map(button)];
  const gap = kind === "touching" || kind === "defective" ? 0 : 8;
  const groups = [stack(gap), { ...stack(gap), parent: "<div.billing>" }];
  return { records, page: { ...payload([]).page, boxGroups: groups } };
}

test("calibration: the clean page stays high, each defect lands below it, and a page with all three lands below 80", () => {
  const scores = Object.fromEntries(
    (["clean", "spaced", "touching", "heights", "grays", "defective"] as const).map((k) => [k, analyzeDesign(calibrationPage(k), VIEWPORT).score!]),
  );
  const o = (k: keyof typeof scores) => scores[k].overall;
  assert.equal(o("clean"), 100, JSON.stringify(scores.clean.deductions));
  assert.equal(o("spaced"), o("clean"), "the 8px-gap twin of the touching page scores as the clean page");
  assert.ok(o("touching") < o("clean") && o("heights") < o("clean") && o("grays") < o("clean"), JSON.stringify(scores));
  // Two pairs of touching cards are the most visible of the three, so they cost the most.
  assert.ok(o("touching") < o("heights") && o("touching") < o("grays"), JSON.stringify(scores));
  assert.ok(o("defective") < 80, `the page with every defect scored ${o("defective")}`);
  assert.ok(o("defective") < o("touching"), "and below any single defect");
  // The subscore that holds the cause shows it: it is the lowest of the four and out of the 90s.
  const lowest = (s: (typeof scores)["clean"]) => Math.min(s.a11y, s.craft, s.consistency, s.clarity);
  assert.ok(scores.heights.consistency < 90 && scores.heights.consistency === lowest(scores.heights), JSON.stringify(scores.heights));
  assert.ok(scores.grays.craft < 90 && scores.grays.craft === lowest(scores.grays), JSON.stringify(scores.grays));
  assert.ok(scores.touching.craft <= 80, `two touching pairs left craft at ${scores.touching.craft}`);
});

test("the report lists the top deductions beside the score", () => {
  const { report } = analyzeDesign(calibrationPage("defective"), VIEWPORT);
  const why = report.match(/PAGE SCORE: [^\n]*\n  why: ([^\n]*)/)?.[1];
  assert.equal(why, "-16 touching containers ×2 · -6 12 grays · -6 6 button heights", report);
  assert.ok(/  why: no deductions/.test(analyzeDesign(calibrationPage("clean"), VIEWPORT).report));
});

test("button radii past two and shadow styles past three are flagged, as they now cost points", () => {
  const btn = (radius: number, i: number) => rec({ tag: "button", text: `B${i}`, interactive: true, radius, rect: { x: i * 100, y: 0, w: 80, h: 36 } });
  const primary = rec({ tag: "a", text: "Next", interactive: true, filled: true, bg: "rgb(30, 64, 175)", color: "rgb(255, 255, 255)" });
  const three = analyzeDesign(payload([rec({ text: "x" }), primary, ...[2, 4, 6].map(btn)]), VIEWPORT);
  const two = analyzeDesign(payload([rec({ text: "x" }), primary, ...[4, 6].map(btn)]), VIEWPORT);
  assert.ok(three.report.includes("3 different corner radii"), three.report);
  // A suggestion costs half its listed points (3 for one radius too many), rounded.
  assert.equal(three.score?.deductions.map(formatDeduction).join(), "-2 3 button radii");
  assert.ok(!two.report.includes("corner radii"), two.report);
  assert.equal(two.score?.overall, 100);
});

// ---------------------------------------------------------------------------
// Type scale: font sizes that are steps of one scale, and sizes that are not
// ---------------------------------------------------------------------------

/** Body text: the size most of the page's words are set in, which the scale is counted from. */
const bodyText = (fontSize: number, i = 0) => rec({ tag: "p", text: `Body paragraph ${i} of the page`, textLen: 120, fontSize });
const heading = (fontSize: number, level = 2) => rec({ tag: `h${level}`, text: `Heading at ${fontSize}`, textLen: 12, fontSize });
const control = (fontSize: number) => rec({ tag: "button", text: "Continue", textLen: 8, interactive: true, fontSize, rect: { x: 0, y: 0, w: 120, h: 36 } });
/** A page on a 1.25 scale from a 16px body: 12.8, 16, 20, 25, 31.25 and 39.06px, of which four are off the 2px grid. */
const onScale = (): Rec[] => [
  bodyText(16, 1),
  bodyText(16, 2),
  rec({ tag: "p", text: "A footnote under the table", textLen: 26, fontSize: 12.8 }),
  heading(20, 3),
  heading(25, 2),
  heading(31.25, 1),
  heading(39.06, 1),
  control(16),
];
const typeLine = (report: string): string => report.split("\n").find((l) => l.includes("off the type scale")) ?? "";
const typeDeduction = (r: ReturnType<typeof analyzeDesign>) => r.score?.deductions.find((d) => d.label.startsWith("type sizes off the scale"));

test("a page on a 1.25 scale is on its scale; the same page with three stray sizes is charged for them", () => {
  const scale = typeScale(onScale());
  assert.deepEqual({ base: scale.base, ratio: scale.ratio, off: scale.offScale }, { base: 16, ratio: 1.25, off: [] });
  const clean = analyzeDesign(payload(onScale()), VIEWPORT);
  assert.equal(typeDeduction(clean), undefined, clean.report);
  assert.equal(typeLine(clean.report), "", clean.report);

  // The one fact that differs: a 15px paragraph, a 17px button and a 19px heading, none of them a step of 1.25 from 16 or a 2px step.
  const strays = analyzeDesign(payload([...onScale(), bodyText(15, 3), control(17), heading(19, 3)]), VIEWPORT);
  assert.deepEqual(typeScale([...onScale(), bodyText(15, 3), control(17), heading(19, 3)]).offScale, [15, 17, 19]);
  assert.equal(formatDeduction(typeDeduction(strays)!), "-3 type sizes off the scale: 15, 17, 19px", strays.report);
  assert.equal(typeDeduction(strays)!.dimension, "consistency");
  assert.ok(
    typeLine(strays.report).includes(
      "3 sizes off the type scale in headings, body text or controls: 15, 17, 19px — neither steps of the 1.25× scale from the 16px body size",
    ),
    strays.report,
  );
  assert.ok(strays.score!.consistency < clean.score!.consistency, JSON.stringify([strays.score, clean.score]));
});

test("a ratio is inferred only from two sizes it explains: one fit is a coincidence", () => {
  assert.deepEqual(typeScale([bodyText(16), heading(25), heading(31.25)]).ratio, 1.25);
  const one = typeScale([bodyText(16), heading(25)]);
  assert.deepEqual({ ratio: one.ratio, off: one.offScale }, { ratio: null, off: [25] });
  // Sizes on the 2px step grid are on the scale with or without a ratio: a 12/14/16/18/24/30/36px system is never charged.
  assert.deepEqual(typeScale([12, 14, 16, 18, 24, 30, 36, 48].map((s, i) => (s === 16 ? bodyText(s) : heading(s, (i % 6) + 1)))).offScale, []);
});

test("a fourth stray size never excuses the first three, though two of them happen to fit a ratio", () => {
  // 19 and 23px lie within 2.5% of 1.2's steps from 16px (19.2 and 23.04): a ratio explaining no more than it leaves out is not the page's scale.
  const three = typeScale([bodyText(16), heading(15, 3), heading(17, 3), heading(19, 3)]);
  const four = typeScale([bodyText(16), heading(15, 3), heading(17, 3), heading(19, 3), heading(23, 3)]);
  assert.deepEqual(three.offScale, [15, 17, 19]);
  assert.deepEqual({ ratio: four.ratio, off: four.offScale }, { ratio: null, off: [15, 17, 19, 23] });
});

test("type sizes: italic body text is measured like any other", () => {
  const strays = [15, 17, 19].map((fontSize) => rec({ tag: "i", text: "An aside set in italics for emphasis", textLen: 36, fontSize }));
  assert.ok(typeDeduction(analyzeDesign(payload([...onScale(), ...strays]), VIEWPORT)));
});

test("type sizes: two off the scale are not charged and three are", () => {
  const two = analyzeDesign(payload([...onScale(), bodyText(15, 3), control(17)]), VIEWPORT);
  const three = analyzeDesign(payload([...onScale(), bodyText(15, 3), control(17), heading(19, 3)]), VIEWPORT);
  assert.equal(typeDeduction(two), undefined, two.report);
  assert.ok(typeDeduction(three), three.report);
  // Seven are charged as four would be: a cap, so the rule cannot sink a page alone. Seven strays outnumber the four
  // sizes the 1.25 scale explains, so no ratio is the page's scale: of those four only 25px is a whole pixel and listed.
  const seven = analyzeDesign(payload([...onScale(), ...[15, 17, 19, 21, 23, 27, 29].map((s) => heading(s, 3))]), VIEWPORT);
  assert.equal(formatDeduction(typeDeduction(seven)!), "-4 type sizes off the scale: 15, 17, 19, 21px +4", seven.report);
});

test("type sizes: the same three strays in code, an icon font, tiny text, a badge or a glyph are not charged", () => {
  const strays = (over: Partial<Rec>): Rec[] => [15, 17, 19].map((fontSize) => heading(fontSize, 3)).map((r) => ({ ...r, ...over }));
  const charged = (records: Rec[]) => typeDeduction(analyzeDesign(payload([...onScale(), ...records]), VIEWPORT));
  assert.ok(charged(strays({})), "the contrast: as headings they are charged");
  assert.equal(charged(strays({ fontFamily: "JetBrains Mono" })), undefined, "a monospace family");
  assert.equal(charged(strays({ tag: "code" })), undefined, "a code element");
  assert.equal(charged(strays({ fontFamily: "Material Icons" })), undefined, "an icon font");
  assert.equal(charged(strays({ text: "→ ✓ ×" })), undefined, "text without a letter");
  // A short label that is neither a heading nor a control (a badge, a tag) keeps its own size.
  assert.equal(charged(strays({ tag: "span", text: "New", textLen: 3 })), undefined, "a badge");
  assert.equal(charged([9, 11, 11.5].map((fontSize) => heading(fontSize, 3))), undefined, "text under 12px");
});

/** A page in one framework's sizes: the body text first, then the headings h1 down, then a lead paragraph, small print and a button. */
function framework(body: number, headings: number[], lead: number, small: number, button: number): Rec[] {
  const at = (n: number) => Math.round(n * 10) / 10;
  return [
    bodyText(at(body), 1),
    bodyText(at(body), 2),
    ...headings.map((s, i) => heading(at(s), Math.min(6, i + 1))),
    rec({ tag: "p", text: "A lead paragraph under the title", textLen: 32, fontSize: at(lead) }),
    rec({ tag: "p", text: "Small print below the form", textLen: 26, fontSize: at(small) }),
    control(at(button)),
  ];
}
/** A component framework's headings at a viewport `vw` px wide: under 1200px its responsive font sizes make h1 to h4 calc(rem + vw). */
const responsiveAt = (vw: number, root = 16): Rec[] => {
  const fluid = (rem: number, v: number, fixed: number) => (vw >= 1200 ? fixed * root : rem * root + (v * vw) / 100);
  const h = [fluid(1.375, 1.5, 2.5), fluid(1.325, 0.9, 2), fluid(1.3, 0.6, 1.75), fluid(1.275, 0.3, 1.5), 1.25 * root, root];
  return framework(root, h, 1.25 * root, 0.875 * root, root);
};

test("type sizes: the deliberate scales of common frameworks are not charged", () => {
  const charged = (records: Rec[]) => typeDeduction(analyzeDesign(payload(records), VIEWPORT));
  // A utility framework's common default steps: 18 and 30px are steps of its scale, not strays.
  assert.deepEqual(typeScale(framework(16, [48, 36, 30, 24, 20, 18], 18, 14, 14)).offScale, []);
  // A design system's display-to-body scale with a 34px step.
  assert.deepEqual(typeScale(framework(16, [96, 60, 48, 34, 24, 20], 16, 14, 14)).offScale, []);
  // The responsive framework at a desktop width, where its headings are whole rems.
  assert.deepEqual(typeScale(responsiveAt(1280)).offScale, []);
  // The same headings at a phone's, a tablet's and a small laptop's width: calc(rem + vw) computes to sizes such as
  // 21.6 and 27.9px, which no ratio from the body size explains. A formula computed them, so they are not charged.
  for (const vw of [390, 768, 1024])
    assert.equal(charged(responsiveAt(vw)), undefined, `responsive headings at ${vw}px: ${typeScale(responsiveAt(vw)).offScale}`);
  // A clamp() scale between a 1.2 scale from 16px and a 1.25 scale from 20px, at widths between its bounds.
  for (const t of [0.3, 0.6]) {
    const clamp = (k: number) => 16 * 1.2 ** k + (20 * 1.25 ** k - 16 * 1.2 ** k) * t;
    const page = framework(clamp(0), [4, 3, 2, 1].map(clamp), clamp(1), clamp(-1), clamp(0));
    assert.equal(charged(page), undefined, `clamp() at ${t}: ${typeScale(page).offScale}`);
  }
});

test("type sizes: a rem scale under a root other than 16px is not charged", () => {
  // The responsive framework's rem multipliers (2.5, 2, 1.75, 1.5, 1.25 and 0.875rem) under another root: at 18px, 45, 36, 31.5, 27, 22.5 and 15.75px.
  for (const root of [14, 15, 17, 18]) {
    const page = responsiveAt(1280, root);
    assert.equal(typeDeduction(analyzeDesign(payload(page), VIEWPORT)), undefined, `${root}px root: ${typeScale(page).offScale}`);
  }
  assert.deepEqual(typeScale(responsiveAt(1280, 18)).offScale, []);
  // The contrast: the same 18px-root page with three whole-pixel sizes picked one at a time is charged for those three alone.
  const strays = [...responsiveAt(1280, 18), heading(19, 3), bodyText(17, 3), control(23)];
  assert.deepEqual(typeScale(strays).offScale, [17, 19, 23]);
  assert.ok(typeDeduction(analyzeDesign(payload(strays), VIEWPORT)));
});

test("type sizes: three whole-pixel strays on a fluid page are still charged", () => {
  // The responsive framework's computed headings at a phone's width, plus 15, 17 and 19px picked one at a time.
  const page = [...responsiveAt(390), bodyText(15, 3), control(17), heading(19, 5)];
  const found = typeDeduction(analyzeDesign(payload(page), VIEWPORT));
  assert.equal(found && formatDeduction(found), "-3 type sizes off the scale: 15, 17, 19px");
});

/** The calibration page's ?with=type variant as records: 28, 20 and 16px, then its headings at 19, notes at 15 and buttons at 17px. */
function typeCalibration(strays: boolean): Payload {
  const h2 = strays ? 19 : 20;
  const note = strays ? 15 : 16;
  const btn = strays ? 17 : 16;
  return payload([
    rec({ tag: "h1", text: "Account settings", textLen: 16, fontSize: 28 }),
    ...["Profile", "Password", "Billing", "Notifications"].map((t) => rec({ tag: "h2", text: t, textLen: t.length, fontSize: h2 })),
    ...["Your name and photo.", "Change how you sign in.", "Your plan and invoices.", "What we tell you about.", "Files you asked for."].map((t) =>
      rec({ tag: "p", text: t, textLen: t.length, fontSize: 16 }),
    ),
    rec({ tag: "p", text: "Changes apply to every workspace you belong to.", textLen: 47, fontSize: note }),
    rec({ tag: "p", text: "Last saved a moment ago.", textLen: 24, fontSize: note }),
    ...["Save changes", "Preview", "Export"].map((t, i) =>
      rec({
        tag: "button",
        text: t,
        textLen: t.length,
        interactive: true,
        filled: i === 0,
        fontSize: btn,
        rect: { x: i * 120, y: 400, w: 100, h: 36 },
        radius: 6,
        ...(i === 0 ? { bg: "rgb(30, 64, 175)", color: "rgb(255, 255, 255)" } : { color: "rgb(30, 64, 175)" }),
      }),
    ),
  ]);
}

test("calibration: three sizes off the scale cost a suggestion's points, below the clean page and above every measured defect", () => {
  const clean = analyzeDesign(typeCalibration(false), VIEWPORT);
  const type = analyzeDesign(typeCalibration(true), VIEWPORT);
  assert.equal(clean.score?.overall, 100, clean.report);
  assert.equal(type.score?.overall, 97, type.report);
  assert.ok(type.report.includes("  why: -3 type sizes off the scale: 15, 17, 19px"), type.report);
  // A suggestion, so it costs less than the smallest single defect in the calibration set (six button heights, 94).
  assert.ok(type.score!.overall > analyzeDesign(calibrationPage("heights"), VIEWPORT).score!.overall);
});

// ---------------------------------------------------------------------------
// Consistency across pages: each page's values beside the other pages'
// ---------------------------------------------------------------------------

/** One page's design-system values: a quiet, consistent page; override what a case is about. */
function sample(over: Partial<DesignSystemSample> = {}): DesignSystemSample {
  return {
    buttonHeights: [36],
    buttonRadii: ["6px"],
    headers: ["28px 700"],
    tabs: [],
    grays: ["rgb(64, 64, 64)", "rgb(115, 115, 115)"],
    fontSizes: [14, 16, 28],
    spacing: [8, 16],
    ...over,
  };
}

/** Pages keyed by route, as memory keeps their scores: each with no deductions of its own. */
function site(samples: Record<string, DesignSystemSample>): Record<string, { system: DesignSystemSample; deductions: [] }> {
  return Object.fromEntries(Object.entries(samples).map(([route, system]) => [route, { system, deductions: [] }]));
}

const fourPages = (d: Partial<DesignSystemSample> = {}, all: Partial<DesignSystemSample> = {}) =>
  site({ "/a": sample(all), "/b": sample(all), "/c": sample(all), "/d": sample({ ...all, ...d }) });

test("three pages with 36px buttons and one with 44px: that page alone pays; every page at 44px pays nothing", () => {
  const outlier = siteConsistency(fourPages({ buttonHeights: [44] }))!;
  assert.deepEqual(Object.keys(outlier.deductions), ["/d"]);
  assert.deepEqual(outlier.deductions["/d"].map(formatDeduction), ["-2 button height only on this page: 44px"]);
  assert.equal(outlier.deductions["/d"][0].dimension, "consistency");
  assert.equal(siteScore({ deductions: [] }, outlier, "/d").overall, 98);
  assert.equal(siteScore({ deductions: [] }, outlier, "/a").overall, 100);
  // The contrastive twin: the same four pages, every one at 44px. One value, one convention, nothing to charge.
  const same = siteConsistency(fourPages({}, { buttonHeights: [44] }))!;
  assert.deepEqual(same.deductions, {});
  assert.deepEqual(same.properties.find((p) => p.key === "buttonHeights")?.dominant, "44");
});

test("the comparison waits for four pages, and a property with no dominant value charges nobody", () => {
  assert.equal(siteConsistency(site({ "/a": sample(), "/b": sample(), "/c": sample({ buttonHeights: [44] }) })), null);
  // A page with no sample (a score an older engine kept) is not counted.
  assert.equal(siteConsistency({ ...site({ "/a": sample(), "/b": sample(), "/c": sample() }), "/old": {} }), null);
  // Four pages, four heights: no value on 60% of them, so no page is an outlier.
  const spread = siteConsistency(
    site({
      "/a": sample({ buttonHeights: [28] }),
      "/b": sample({ buttonHeights: [32] }),
      "/c": sample({ buttonHeights: [36] }),
      "/d": sample({ buttonHeights: [40] }),
    }),
  )!;
  assert.deepEqual(spread.deductions, {});
  assert.equal(spread.properties.find((p) => p.key === "buttonHeights")?.dominant, null);
});

test("a lone value the page's own rule already charged for is not charged again", () => {
  // Every page uses 32, 36 and 40px; /d adds 44px, its fourth height, which its own rule charged as one past three.
  const paid = siteConsistency(fourPages({ buttonHeights: [32, 36, 40, 44] }, { buttonHeights: [32, 36, 40] }))!;
  assert.equal(paid.deductions["/d"], undefined, JSON.stringify(paid.deductions));
  // The same lone 44px on a page with two heights was not charged by the page, so the comparison charges it.
  const unpaid = siteConsistency(fourPages({ buttonHeights: [36, 44] }, { buttonHeights: [32, 36, 40] }))!;
  assert.deepEqual(unpaid.deductions["/d"].map(formatDeduction), ["-2 button height only on this page: 44px"]);
  // Six heights, five of them lone: three past the healthy three were charged on the page, so two are left to charge here.
  const six = siteConsistency(fourPages({ buttonHeights: [36, 40, 44, 48, 52, 56] }))!;
  assert.deepEqual(
    six.deductions["/d"].map((d) => [d.count, d.points]),
    [[2, 4]],
    "five lone, three already paid",
  );
});

test("grays a unit or two apart are one step across pages, as within one", () => {
  const near = siteConsistency(fourPages({ grays: ["rgb(66, 66, 66)", "rgb(115, 115, 115)"] }))!;
  assert.deepEqual(near.deductions, {});
  const far = siteConsistency(fourPages({ grays: ["rgb(64, 64, 64)", "rgb(115, 115, 115)", "rgb(180, 180, 180)"] }))!;
  assert.deepEqual(far.deductions["/d"].map(formatDeduction), ["-2 gray only on this page: rgb(180, 180, 180)"]);
});

test("two near grays joined can be the dominant step, though each alone is used on fewer pages than another gray", () => {
  // rgb(80…) on three of six pages; rgb(120…) and rgb(122…) on two each, one step on four of six: that step is dominant.
  const g = (v: number) => `rgb(${v}, ${v}, ${v})`;
  const joined = siteConsistency(
    site({
      "/a": sample({ grays: [g(80), g(120)] }),
      "/b": sample({ grays: [g(80), g(120)] }),
      "/c": sample({ grays: [g(80), g(122)] }),
      "/d": sample({ grays: [g(122), g(200)] }),
      "/e": sample({ grays: [g(150)] }),
      "/f": sample({ grays: [g(150)] }),
    }),
  )!;
  const grays = joined.properties.find((p) => p.key === "grays")!;
  assert.equal(grays.dominant, g(120));
  assert.equal(grays.values[0].routes.length, 4);
  assert.deepEqual(joined.deductions["/d"].map(formatDeduction), ["-2 gray only on this page: rgb(200, 200, 200)"]);
});

test("a pale tint one page alone uses (a status chip's green) is not compared; the same lightness untinted, or a darker slate, is", () => {
  const tint = siteConsistency(fourPages({ grays: ["rgb(64, 64, 64)", "rgb(115, 115, 115)", "rgb(231, 246, 236)"] }))!;
  assert.deepEqual(tint.deductions, {});
  assert.ok(!formatSiteConsistency(tint).some((l) => l.includes("231, 246, 236")), "and not listed");
  const neutral = siteConsistency(fourPages({ grays: ["rgb(64, 64, 64)", "rgb(115, 115, 115)", "rgb(238, 238, 238)"] }))!;
  assert.deepEqual(neutral.deductions["/d"].map(formatDeduction), ["-2 gray only on this page: rgb(238, 238, 238)"]);
  const slate = siteConsistency(fourPages({ grays: ["rgb(64, 64, 64)", "rgb(115, 115, 115)", "rgb(184, 192, 202)"] }))!;
  assert.deepEqual(slate.deductions["/d"].map(formatDeduction), ["-2 gray only on this page: rgb(184, 192, 202)"]);
});

test("a page header or tab style one page alone uses is charged; font sizes and spacing are listed but not charged", () => {
  const header = siteConsistency(fourPages({ headers: ["40px 800"] }))!;
  assert.deepEqual(header.deductions["/d"].map(formatDeduction), ["-2 page header (h1) only on this page: 40px 800"]);
  const tabs = siteConsistency(fourPages({ tabs: ["44px tall, pill radius"] }, { tabs: ["36px tall, 0px radius"] }))!;
  assert.deepEqual(tabs.deductions["/d"].map(formatDeduction), ["-2 tab style only on this page: 44px tall, pill radius"]);
  const listed = siteConsistency(fourPages({ fontSizes: [14, 16, 28, 48], spacing: [8, 16, 13] }))!;
  assert.deepEqual(listed.deductions, {});
  assert.deepEqual(listed.properties.find((p) => p.key === "fontSizes")?.outliers, { "/d": ["48"] });
});

test("the comparison costs a page at most ten points however many values it alone uses", () => {
  const odd = siteConsistency(
    fourPages(
      {
        buttonHeights: [44, 48],
        buttonRadii: ["pill", "12px"],
        headers: ["40px 800"],
        tabs: ["44px tall, pill radius"],
        grays: ["rgb(180, 180, 180)", "rgb(30, 30, 30)"],
      },
      { tabs: ["36px tall, 0px radius"] },
    ),
  )!;
  const total = odd.deductions["/d"].reduce((n, d) => n + d.points, 0);
  assert.equal(total, 10, JSON.stringify(odd.deductions["/d"]));
  assert.deepEqual(Object.keys(odd.deductions), ["/d"]);
});

test("the summary lists each value, how many pages use it, the dominant one and where the outliers are", () => {
  const s = siteConsistency(fourPages({ buttonHeights: [44] }))!;
  const lines = formatSiteConsistency(s);
  assert.equal(
    lines.find((l) => l.includes("button heights")),
    "→ button heights: 2 values (36, 44px) across 4 pages — dominant 36px; only one page uses: /d (44px)",
  );
  assert.ok(
    lines.some((l) => l.startsWith("· font sizes: 3 values (14, 16, 28px) across 4 pages — dominant 14px (listed, not scored)")),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => l.includes("tab styles")), "a property no page uses is left out");
  // Routes are written as the caller asks: the report puts them in code spans.
  assert.ok(formatSiteConsistency(s, (r) => `\`${r}\``).some((l) => l.includes("`/d` (44px)")));
});

test("the audit's site block shows the page against the site, and is empty under four pages", () => {
  const pages = fourPages({ buttonHeights: [44] });
  const block = siteAuditSection(pages, "/d");
  assert.ok(block.startsWith("SITE CONSISTENCY (4 audited pages;"), block);
  assert.ok(block.includes("this page (/d) against the site: 98/100 — -2 button height only on this page: 44px"), block);
  assert.ok(siteAuditSection(pages, "/a").includes("this page (/a): no value only it uses; its score stands at 100/100"));
  assert.equal(siteAuditSection(site({ "/a": sample(), "/b": sample() }), "/a"), "");
});

test("the audit keeps the page's design-system values with its score, the shell's landmarks left out and the census's chrome kept", () => {
  const records = [
    rec({ tag: "h1", text: "Orders", fontSize: 28, fontWeight: 700 }),
    rec({ tag: "button", text: "Save", interactive: true, rect: { x: 0, y: 0, w: 80, h: 36 }, radius: 6 }),
    rec({ tag: "button", text: "Open", interactive: true, rect: { x: 100, y: 0, w: 80, h: 37 }, radius: 20 }),
    rec({ tag: "button", text: "Tab one", interactive: true, role: "tab", rect: { x: 0, y: 60, w: 80, h: 40 }, radius: 0 }),
    rec({ text: "Muted", color: "rgb(115, 115, 115)" }),
    rec({ tag: "nav", text: "Shell link", shell: true, fontSize: 11, color: "rgb(200, 200, 200)" }),
  ];
  const system = analyzeDesign(payload(records), VIEWPORT).score?.system;
  // A button the census already counts as chrome is out of the score but still in the values: they do not depend on audit order.
  const census = analyzeDesign(payload(records), VIEWPORT, new Set(["button:save"])).score?.system;
  assert.deepEqual(census, system);
  assert.deepEqual(system, {
    buttonHeights: [36, 38, 40],
    buttonRadii: ["0px", "6px", "pill"],
    headers: ["28px 700"],
    tabs: ["40px tall, 0px radius"],
    grays: ["rgb(115, 115, 115)"],
    fontSizes: [16, 28],
    spacing: [8],
  });
});

test("a button drawn as a card (a sign-in page's role tiles) keeps its radius out of the page's values; the same radius on a control-sized button is kept", () => {
  const save = rec({ tag: "button", text: "Save", interactive: true, rect: { x: 0, y: 0, w: 80, h: 36 }, radius: 8 });
  const tile = (h: number) => rec({ tag: "button", text: "Clerk", interactive: true, rect: { x: 0, y: 60, w: 240, h }, radius: 10 });
  assert.deepEqual(analyzeDesign(payload([save, tile(104)]), VIEWPORT).score?.system?.buttonRadii, ["8px"]);
  assert.deepEqual(analyzeDesign(payload([save, tile(40)]), VIEWPORT).score?.system?.buttonRadii, ["8px", "10px"]);
});
