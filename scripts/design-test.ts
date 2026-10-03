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
  contrastRatio,
  distinguishingLayer,
  elevationKey,
  focusedControl,
  grayCensus,
  namesFilter,
  shadowLayers,
  styleSignature,
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
  // The audit reads the snapshot's name (collector.ts PICK_NAME_SRC), which names a control by its image content.
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
