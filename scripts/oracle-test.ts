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
import {
  brokenImageIssues,
  displayName,
  frameElementKey,
  frameLabel,
  frameLines,
  geometryIssues,
  hasVisibleFrame,
  isFieldAdornment,
  isPassThroughOverlay,
  COLLECT_INTERACTABLES_SCRIPT,
  FOCUS_MOVES_PROPS,
  IN_PAGE_ANCHOR,
  PAGER_NAME,
  isPagerName,
  revealedOnFocus,
  masksForeignName,
  missingName,
  placeholderOnly,
  placeholderEvidence,
  describeControl,
  labelFlag,
  capForeignName,
  stripForeignHref,
  frameToPageRect,
  pickName,
  type NameFacts,
  stateFlags,
  stateChange,
  trackedElements,
  inertKeys,
  mainRegionLine,
  mainRegionTag,
  describeCover,
} from "../src/engine/collector.ts";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import {
  MAX_ITEMS,
  POSTMESSAGE_BINDING,
  describeTokenPost,
  maskToken,
  postMessageCaptureScript,
  postsToAnyOrigin,
  tokenHits,
  tokenPostKey,
  tokenShapeOf,
} from "../src/engine/postmessage.ts";
import type { Page } from "playwright";
import {
  EmbedRequestLog,
  OracleMonitor,
  POLICY_BLOCK_WINDOW_MS,
  REPLAY_ECHO_WINDOW_MS,
  ReplayLog,
  failedLoadEchoOf,
  formatViolations,
  isPolicyInduced,
  isRouteCancellation,
  planStopsAt,
  redactViolation,
} from "../src/engine/oracles.ts";
import {
  describeInjection,
  injectionProbe,
  INJECTION_TEXT_MAX,
  matchesElement,
  MAX_PROBES,
  newInjections,
  probeScript,
  rememberProbe,
  type InjectionProbe,
} from "../src/engine/injection.ts";

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

test("a skip link parked off the page is not reported; any other control at the same spot still is", () => {
  const parked = { x: 8, y: -72, w: 138, h: 40 };
  const offPage = (over: Partial<El>) =>
    geometryIssues([el({ ref: "e1", xpath: "/html/body/a[1]", rect: parked, ...over })], VIEWPORT).filter((i) => i.includes("outside the reachable page area"));
  // The skip-link shape: a link into this same document, reachable by Tab.
  assert.deepEqual(offPage({ role: "link", href: "#main", focusable: true }), []);
  // Any focusable control a :focus rule moves comes back the same way.
  assert.deepEqual(offPage({ role: "button", href: null, focusable: true, focusMoves: true }), []);
  // The other half: nothing brings these back.
  assert.equal(offPage({ role: "button", href: null, focusable: true }).length, 1, "a button parked off the page");
  assert.equal(offPage({ role: "link", href: "/reports", focusable: true }).length, 1, "a link to another page");
  assert.equal(offPage({ role: "link", href: "#", focusable: true }).length, 1, "a bare # is not a place in the page");
  assert.equal(offPage({ role: "link", href: "#/reports", focusable: true }).length, 1, "a hash route is navigation, not a skip link");
  assert.equal(offPage({ role: "link", href: "#!/reports", focusable: true }).length, 1, "nor is a hashbang route");
  assert.equal(offPage({ role: "link", href: "#main", focusable: false }).length, 1, "out of the Tab order, so focus never reveals it");
  assert.equal(offPage({ role: "link", href: "#main" }).length, 1, "focusability unknown counts as not focusable");
  assert.equal(revealedOnFocus({ href: "#main", focusable: true }), true);
  assert.equal(revealedOnFocus({ href: null, focusable: true, focusMoves: false }), false);
});

test("a pass-through overlay over a control is not an overlap; the same overlay taking clicks is", () => {
  const pair = (passThrough: boolean) =>
    geometryIssues(
      [
        el({ ref: "e1", name: "Watermark", role: "generic", xpath: "/html/body/div[1]/div[1]", rect: { x: 0, y: 0, w: 600, h: 400 }, passThrough }),
        el({ ref: "e2", name: "Open page", role: "link", xpath: "/html/body/div[1]/a[1]", rect: { x: 40, y: 40, w: 120, h: 30 } }),
      ],
      VIEWPORT,
    ).filter((i) => i.includes("overlaps"));
  assert.deepEqual(pair(true), []);
  assert.equal(pair(false).length, 1);
  // pointer-events:none on a disabled button (a common design-system rule) does not make a collision intended.
  const buttons = geometryIssues(
    [
      el({ ref: "e1", name: "Submit", xpath: "/html/body/div[1]/button[1]", rect: { x: 20, y: 10, w: 120, h: 32 }, passThrough: true }),
      el({ ref: "e2", name: "Cancel", xpath: "/html/body/div[1]/button[2]", rect: { x: 30, y: 14, w: 120, h: 32 } }),
    ],
    VIEWPORT,
  ).filter((i) => i.includes("overlaps"));
  assert.equal(buttons.length, 1);
  // A small pass-through badge on a large control is not an overlay of it.
  assert.equal(
    isPassThroughOverlay({ role: "generic", passThrough: true, rect: { x: 0, y: 0, w: 10, h: 10 } }, { rect: { x: 0, y: 0, w: 100, h: 40 } }),
    false,
  );
});

test("a button in a text field's reserved padding is an adornment; one reaching into the text is a collision", () => {
  const field = { ref: "e1", name: "Search", role: "textbox", xpath: "/html/body/div[1]/input[1]", rect: { x: 100, y: 100, w: 300, h: 36 } };
  const clear = { ref: "e2", name: "Clear", role: "button", xpath: "/html/body/div[1]/button[1]", rect: { x: 368, y: 106, w: 24, h: 24 } };
  const overlaps = (f: Partial<El>, b: Partial<El>) =>
    geometryIssues([el({ ...field, ...f }), el({ ...clear, ...b })], VIEWPORT).filter((i) => i.includes("overlaps"));
  // padding-right 36px reserves x 364-400; the button sits at 368-392.
  assert.deepEqual(overlaps({ fieldPad: { l: 8, r: 36 } }, {}), []);
  assert.deepEqual(overlaps({ fieldPad: { l: 36, r: 8 } }, { rect: { x: 108, y: 106, w: 24, h: 24 } }), [], "a leading icon in the left padding");
  // The same button with no padding reserved for it lies over the text.
  assert.equal(overlaps({ fieldPad: { l: 8, r: 8 } }, {}).length, 1);
  // Half over the field and half outside it is not inside the field at all.
  assert.equal(overlaps({ fieldPad: { l: 8, r: 36 } }, { rect: { x: 100, y: 90, w: 300, h: 30 } }).length, 1);
  // Not a text field: no padding is reserved for anything.
  assert.equal(overlaps({ role: "button", fieldPad: null }, {}).length, 1);
  assert.equal(isFieldAdornment({ rect: field.rect, fieldPad: { l: 8, r: 36 } }, clear), true);
});

test("the collector's literal copies of the shared patterns match the exported ones", () => {
  // The page script carries them as text rather than splicing values into code; this keeps the copies equal.
  assert.ok(COLLECT_INTERACTABLES_SCRIPT.includes(`const PAGER = ${String(PAGER_NAME)};`), "PAGER_NAME");
  assert.ok(COLLECT_INTERACTABLES_SCRIPT.includes(`${String(IN_PAGE_ANCHOR)}.test(`), "IN_PAGE_ANCHOR");
  assert.ok(COLLECT_INTERACTABLES_SCRIPT.includes(`const FOCUS_MOVES = ${JSON.stringify(FOCUS_MOVES_PROPS).replace(/,/g, ", ")};`), "FOCUS_MOVES_PROPS");
});

test("a pager control's name is told from ordinary buttons", () => {
  for (const name of ["Next", "Next page", "Previous slide", "prev", "›", "→", "Go to slide 3", "Page 2", "Slide 4 of 9", "Scroll right"]) {
    assert.equal(isPagerName(name), true, name);
  }
  for (const name of ["Save", "Back to dashboard", "Pages", "Next.js docs are great", "Delete page", "Imagery", "Show more filters"]) {
    assert.equal(isPagerName(name), false, name);
  }
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
  // The console error and the uncaught rejection that follow an abort. (The
  // failed request itself is matched by request identity inside the monitor.)
  assert.equal(isPolicyInduced({ kind: "console_error", detail: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector" }, 30), true);
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Failed to fetch" }, 40), true);
  // The browser's own line for the stand-in 403 the policy answers a script's write with.
  assert.equal(isPolicyInduced({ kind: "console_error", detail: "Failed to load resource: the server responded with a status of 403 (Forbidden)" }, 30), true);
  assert.equal(
    isPolicyInduced({ kind: "console_error", detail: "Failed to load resource: the server responded with a status of 403 (Forbidden)" }, null),
    false,
    "a 403 with no block in the window is the server's own",
  );
  assert.equal(
    isPolicyInduced({ kind: "console_error", detail: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)" }, 30),
    false,
    "the policy only ever answers 403",
  );

  // Without a block in the window, the very same text is the app's own
  // failure — a wrong origin, a CORS error, a refused connection — and stays.
  for (const detail of ["Failed to fetch", "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT"]) {
    assert.equal(isPolicyInduced({ kind: "page_error", detail }, null), false, `${detail}: no block happened (e.g. destructive mode never blocks)`);
    assert.equal(isPolicyInduced({ kind: "page_error", detail }, POLICY_BLOCK_WINDOW_MS + 1), false, `${detail}: too long after the block`);
  }
  // An HTTP client's rejection of the stand-in 403, as a console line or as an
  // unhandled rejection: the policy's within the window, the server's outside it.
  for (const detail of [
    "AxiosError: Request failed with status code 403",
    "Uncaught (in promise) AxiosError: Request failed with status code 403",
    "Unhandled rejection: HTTPError: 403 Forbidden",
    "Error: Forbidden (403)",
    "Error: request was refused: status 403",
    'Error: {"error":"Forbidden","message":"PUT /api/things/7 was refused by the tester\'s observe write policy. The server never received it."}',
  ]) {
    assert.equal(isPolicyInduced({ kind: "page_error", detail }, 30), true, `${detail}: within the block window`);
    assert.equal(isPolicyInduced({ kind: "console_error", detail }, 30), true, `${detail}: as a console line`);
    assert.equal(isPolicyInduced({ kind: "page_error", detail }, null), false, `${detail}: no block, so the server's own 403`);
    assert.equal(isPolicyInduced({ kind: "page_error", detail }, POLICY_BLOCK_WINDOW_MS + 1), false, `${detail}: too long after the block`);
  }
  // A 403 with neither word, or another status, is not the policy's wording.
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Error 403 at line 12" }, 30), false);
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "AxiosError: Request failed with status code 500" }, 30), false);
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Forbidden character in input" }, 30), false);
  // A block excuses nothing that is not a fetch failure.
  assert.equal(isPolicyInduced({ kind: "page_error", detail: "Cannot read properties of undefined (reading 'rows')" }, 10), false);
  assert.equal(isPolicyInduced({ kind: "http_error", detail: "GET http://x/api/orders → HTTP 500" }, 10), false);
  assert.equal(
    isPolicyInduced({ kind: "request_failed", detail: "PUT http://x/api/orders/7 → net::ERR_BLOCKED_BY_CLIENT" }, 10),
    false,
    "failed requests are decided by identity, not wording",
  );
});

test("a pinned control covered by other pinned chrome is reported, ahead of box overlaps", () => {
  // The hit test runs in the page; this pins how its verdict is reported.
  const covered = geometryIssues(
    [
      el({
        ref: "e1",
        name: "Save changes",
        role: "button",
        xpath: "/html/body/main/div[2]/button[1]",
        rect: { x: 24, y: 850, w: 120, h: 32 },
        chrome: true,
        coveredBy: "[promo-bar]",
      }),
      el({
        ref: "e2",
        name: "Try the new importer",
        role: "generic",
        xpath: "/html/body/div[1]",
        rect: { x: 0, y: 844, w: 1280, h: 56 },
        chrome: true,
        layer: 7,
      }),
    ],
    VIEWPORT,
  );
  assert.equal(covered.length, 1);
  assert.match(covered[0], /^e1 button "Save changes" is COVERED by pinned chrome \[promo-bar\]/);

  // Without a hit-test verdict the chrome/chrome pair stays quiet, as before:
  // two pieces of pinned chrome overlapping is usually intended layering.
  const quiet = geometryIssues(
    [
      el({ ref: "e1", name: "Save changes", role: "button", xpath: "/html/body/main/div[2]/button[1]", rect: { x: 24, y: 850, w: 120, h: 32 }, chrome: true }),
      el({ ref: "e2", name: "Bar", role: "generic", xpath: "/html/body/div[1]", rect: { x: 0, y: 844, w: 1280, h: 56 }, chrome: true }),
    ],
    VIEWPORT,
  );
  assert.deepEqual(quiet, []);

  // A page full of them is summarised, not listed.
  const many = Array.from({ length: 6 }, (_, i) =>
    el({
      ref: `e${i}`,
      name: `Action ${i}`,
      role: "button",
      xpath: `/html/body/div[${i + 1}]/button[1]`,
      rect: { x: 10 + i * 200, y: 850, w: 100, h: 30 },
      chrome: true,
      coveredBy: "[bar]",
    }),
  );
  const summarised = geometryIssues(many, VIEWPORT);
  assert.equal(summarised.filter((l) => /is COVERED/.test(l)).length, 3);
  assert.ok(summarised.some((l) => /and 3 more pinned controls covered/.test(l)));
});

test("images that failed to load are named by their alt text and their source", () => {
  const lines = brokenImageIssues(
    {
      images: [
        { alt: "Weekly chart", src: "http://x/img/chart.png", testid: "dash-chart" },
        { alt: "", src: "https://cdn.example.com/a.jpg", testid: null },
      ],
      total: 2,
    },
    "http://x/dashboard",
  );
  assert.deepEqual(lines, [
    'image "Weekly chart" [testid=dash-chart] FAILED TO LOAD — /img/chart.png',
    "image (no alt text) FAILED TO LOAD — https://cdn.example.com/a.jpg",
  ]);
  assert.deepEqual(brokenImageIssues({ images: [], total: 0 }, "http://x/"), []);
});

test("the page's origin is stripped only on a real origin match", () => {
  const src = (s: string, page: string) => brokenImageIssues({ images: [{ alt: "a", src: s, testid: null }], total: 1 }, page)[0].split(" — ")[1];
  assert.equal(src("http://x/a.png", "http://x/p"), "/a.png");
  // "http://x" is a string prefix of both of these, and neither is the same origin.
  assert.equal(src("http://x.other.test/a.png", "http://x/p"), "http://x.other.test/a.png");
  assert.equal(src("http://localhost:30001/a.png", "http://localhost:3000/p"), "http://localhost:30001/a.png");
  assert.equal(src("http://x", "http://x/p"), "/", "never an empty source");
});

test("a page full of broken images reports the real total, not the sample size", () => {
  // The page script returns at most 20 images but counts them all.
  const sample = Array.from({ length: 20 }, (_, i) => ({ alt: `Photo ${i}`, src: `http://x/p${i}.png`, testid: null }));
  const lines = brokenImageIssues({ images: sample, total: 95 }, "http://x/");
  assert.equal(lines.length, 6);
  assert.match(lines[5], /and 90 more images that failed to load/);
});

// ---- the DOM-injection oracle's rules ---------------------------------------

test("a typed value is watched only when it holds an element with something to tell it apart by", () => {
  // The agent chooses what to type; the oracle only notices markup-shaped
  // values. Plain text, an email, a URL and a stray "<" are none of its
  // business, and neither is a bare <script> or <br>: they would match any page.
  for (const plain of ["hello", "a <b", "x < y > z", "user@example.com", "https://example.test/?q=1", "1 << 3", "", "<script>", "<br/>", "<b></b>"]) {
    assert.equal(injectionProbe(plain, "f", "http://app.test/"), null, JSON.stringify(plain));
  }
  const img = injectionProbe('<img src=x onerror="alert(1)">', 'textbox "Customer"', "http://app.test/new");
  assert.ok(img);
  assert.equal(img.tag, "img");
  assert.deepEqual(img.attrs, [
    ["src", "x"],
    ["onerror", "alert(1)"],
  ]);
  assert.equal(img.selector, 'img[src="x"][onerror="alert(1)"]');
  assert.equal(img.text, null);
  assert.equal(img.baseline, 0);
});

test("payload shapes a fuzzing pass really types are recognised", () => {
  // A slash between attributes is whitespace to a browser, and the usual way
  // a payload avoids a naive filter.
  assert.equal(injectionProbe("<svg/onload=alert(1)>", "f", "u")?.selector, 'svg[onload="alert(1)"]');
  assert.equal(injectionProbe("<img/src=x onerror=alert(1)>", "f", "u")?.selector, 'img[src="x"][onerror="alert(1)"]');
  assert.equal(injectionProbe('"><script>alert(1)</script>', "f", "u")?.text, "alert(1)");
  const bold = injectionProbe("note <b>loud</b> end", "f", "u");
  assert.equal(bold?.selector, "b");
  assert.equal(bold?.text, "loud");
  // An attribute name that cannot go into a selector is dropped, never interpolated.
  const odd = injectionProbe("<b a],*,[c=x>x</b>", "f", "u");
  assert.deepEqual(odd?.attrs, [], "a name holding selector syntax is not an attribute");
  assert.equal(odd?.selector, "b");
  assert.equal(injectionProbe('<a data-x:y="1" href="/z">go</a>', "f", "u")?.selector, 'a[href="/z"]');
  const quoted = injectionProbe("<a href='/x' title=\"a title\" data-x=plain>go</a>", "f", "u");
  assert.deepEqual(quoted?.attrs, [
    ["href", "/x"],
    ["title", "a title"],
    ["data-x", "plain"],
  ]);
  assert.equal(quoted?.text, "go", "text is kept alongside attributes: both have to match");
  const inner = injectionProbe("<a title='say \"hi\"'>x</a>", "f", "u");
  assert.equal(inner?.selector, 'a[title="say \\"hi\\""]', "a double quote inside a value is escaped for the selector");
  assert.equal(injectionProbe(`<i>${"x".repeat(500)}</i>`, "f", "u")?.text?.length, INJECTION_TEXT_MAX, "long text is compared on its first characters");
});

test("an element is the typed one only with exactly its attributes and its text", () => {
  const link = { selector: 'a[href="/"]', attrs: [["href", "/"]] as Array<[string, string]>, text: "home" };
  assert.equal(matchesElement(link, { attrs: { href: "/" }, text: " home " }), true);
  assert.equal(
    matchesElement(link, { attrs: { href: "/", "data-testid": "nav-home" }, text: "home" }),
    false,
    "the app's own link carries more attributes than were typed",
  );
  assert.equal(matchesElement(link, { attrs: { href: "/" }, text: "Home page" }), false);
  const script = { selector: "script", attrs: [] as Array<[string, string]>, text: "alert(1)" };
  assert.equal(matchesElement(script, { attrs: {}, text: "alert(1)" }), true);
  assert.equal(matchesElement(script, { attrs: {}, text: "window.app = {}" }), false, "the page's own scripts are not the typed one");
  assert.match(probeScript([link]), /attributes\.length !== q\.attrs\.length/, "the page applies the same rule before capping");
});

test("a hit is an injection only beyond the typing page's baseline, and is reported once per route", () => {
  const probe = injectionProbe('<a href="/">home</a>', "f", "http://app.test/new", 1);
  assert.ok(probe);
  const reported = new Set<string>();
  assert.deepEqual(
    newInjections([probe], [{ index: 0, outer: "<a>" }], "http://app.test/list", reported),
    [],
    "one such link is the shared chrome the typing page already had",
  );
  const found = newInjections(
    [probe],
    [
      { index: 0, outer: '<a href="/">home</a>' },
      { index: 0, outer: '<a href="/">home</a>' },
    ],
    "http://app.test/list?page=2",
    reported,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.key, '<a href="/">home</a>|/list');
  assert.deepEqual(
    newInjections(
      [probe],
      [
        { index: 0, outer: "" },
        { index: 0, outer: "" },
      ],
      "http://app.test/list",
      reported,
    ),
    [],
    "the same route is not reported again",
  );
});

test("a hostile value cannot make the parse backtrack, and an unclosed tag is not an element", () => {
  // The first version used one regex with a nested quantifier over the
  // attribute list, which CodeQL flagged: a value starting "<A\t!=" and
  // repeating could take exponential time. The tokenizer consumes at least
  // one character per step.
  const hostile = "<a\t!=" + "\t!=".repeat(20000) + "x";
  const started = Date.now();
  const shape = injectionProbe(hostile, "f", "u");
  // Wall-clock on purpose, since cost is what is under test: about a millisecond here, against time exponential in the
  // input's length for the regex described above. The bound sits far from both, so a loaded machine cannot trip it.
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  assert.equal(shape, null, "the tag never closes");
  assert.equal(injectionProbe("<a href='/x'", "f", "u"), null);
  assert.equal(injectionProbe("<a href='/x'>go", "f", "u")?.text, "go", "a closed tag with no closing tag still has its text");
});

test("the violation says where it was typed, where it fired, and what it became", () => {
  const probe = injectionProbe('<img src=x onerror="alert(1)">', 'textbox "Customer"', "http://app.test/orders/new?draft=1");
  assert.ok(probe);
  const detail = describeInjection(probe, "http://app.test/orders?status=open", '<img src="x" onerror="alert(1)">');
  assert.match(detail, /typed into textbox "Customer" on \/orders\/new/);
  assert.match(
    detail,
    /^<img src="x" onerror="alert\(1\)"> on \/orders is/,
    "the element leads, so two payloads on one page never share the log's signature prefix",
  );
  assert.match(detail, /XSS/);
});

test("the probe list keeps the first sighting of a payload and drops the oldest past the cap", () => {
  const make = (n: number) => injectionProbe(`<em data-k="${n}">x</em>`, "f", "u", n)!;
  let probes: InjectionProbe[] = [];
  for (let i = 0; i < MAX_PROBES + 5; i += 1) probes = rememberProbe(probes, make(i));
  assert.equal(probes.length, MAX_PROBES);
  assert.equal(probes[0]?.baseline, 5, "the five oldest went");
  assert.equal(probes.at(-1)?.baseline, MAX_PROBES + 4);
  const again = rememberProbe(probes, { ...make(7), baseline: 99 });
  assert.equal(again.length, MAX_PROBES);
  assert.equal(again.find((p) => p.payload.includes('"7"'))?.baseline, 7, "a payload typed again keeps its first baseline");
  assert.equal(injectionProbe('<b title="a\nb">x</b>', "f", "u")?.selector, 'b[title="a\\a b"]', "a newline in a value is escaped for the selector");
});

test("an empty live region is not an unnamed control; an empty button still is", () => {
  // The same missing name, and the one fact that flips it: whether the role takes input or announces.
  for (const role of ["status", "alert", "log", "timer", "marquee"]) {
    assert.equal(missingName({ role, name: "" }), false, role);
    assert.equal(displayName({ role, name: "" }), "(empty live region)", role);
  }
  for (const role of ["button", "link", "textbox", "generic", "combobox"]) {
    assert.equal(missingName({ role, name: "" }), true, role);
    assert.equal(displayName({ role, name: "" }), "(unnamed)", role);
  }
  assert.equal(missingName({ role: "status", name: "Saved." }), false);
  assert.equal(displayName({ role: "status", name: "Saved." }), "Saved.");
});

test("the accessible name follows the computation's order: aria-labelledby, aria-label, label, title, placeholder", () => {
  const facts = (over: Partial<NameFacts>): NameFacts => ({
    tag: "input",
    inputType: "text",
    labelledBy: "",
    ariaLabel: null,
    labels: [],
    title: "",
    placeholder: "",
    nameAttr: "",
    value: "",
    alt: "",
    live: false,
    text: "",
    ...over,
  });
  const cases: Array<[string, Partial<NameFacts>, { name: string; from: "placeholder" | "fallback" | null }]> = [
    // Each source wins over every one after it.
    ["aria-labelledby before aria-label", { labelledBy: "Caption", ariaLabel: "Aria", labels: ["Label"] }, { name: "Caption", from: null }],
    ["aria-label before a label", { ariaLabel: "Aria", labels: ["Label"], title: "Title" }, { name: "Aria", from: null }],
    ["a label before title", { labels: ["Label"], title: "Title", placeholder: "Hint" }, { name: "Label", from: null }],
    ["title before placeholder", { title: "Title", placeholder: "Hint", nameAttr: "q" }, { name: "Title", from: null }],
    ["placeholder before the name attribute", { placeholder: "Hint", nameAttr: "q" }, { name: "Hint", from: "placeholder" }],
    ["then the name attribute", { nameAttr: "q" }, { name: "q", from: "fallback" }],
    ["then the type", {}, { name: "text", from: "fallback" }],
    // A radio wrapped in a label (NAME_FACTS_SRC strips the control's own text from it) against one with only a name.
    ["a wrapped radio is named by its label", { inputType: "radio", nameAttr: "fmt", labels: ["  Alpha "] }, { name: "Alpha", from: null }],
    ["an unwrapped radio falls back to its name attribute", { inputType: "radio", nameAttr: "fmt" }, { name: "fmt", from: "fallback" }],
    // A select is named by its label, never by its options' text.
    ["a labelled select", { tag: "select", inputType: "", labels: ["Country "], text: "France Spain" }, { name: "Country", from: null }],
    ["an unlabelled select", { tag: "select", inputType: "", nameAttr: "country", text: "France Spain" }, { name: "country", from: "fallback" }],
    ["a select ignores a placeholder attribute", { tag: "select", inputType: "", placeholder: "Pick" }, { name: "select", from: "fallback" }],
    // A button-like input is named by its value, or the browser's own text.
    ["a submit input by its value", { inputType: "submit", value: "Send", nameAttr: "go" }, { name: "Send", from: null }],
    ["a submit input with no value", { inputType: "submit" }, { name: "Submit", from: null }],
    // An icon-only button: its title, or nothing.
    ["an icon button with a title", { tag: "button", inputType: "", title: "Download file" }, { name: "Download file", from: null }],
    ["an icon button with neither text nor title", { tag: "button", inputType: "" }, { name: "", from: null }],
    ["a button's text before its title", { tag: "button", inputType: "", text: "Save", title: "Save the draft" }, { name: "Save", from: null }],
    // A live region is named by what it announces.
    [
      "a live region by its text",
      { tag: "div", inputType: "", live: true, ariaLabel: null, labels: ["Result"], text: " Could not save " },
      { name: "Could not save", from: null },
    ],
    ["an image by its alt", { tag: "img", inputType: "", alt: "Logo", title: "Home" }, { name: "Logo", from: null }],
    // Kept as before: a whitespace-only aria-label ends the name, and the field reads as unnamed.
    ["a blank aria-label hides the placeholder", { ariaLabel: "  ", placeholder: "Hint" }, { name: "", from: "fallback" }],
    ["an empty aria-label is no aria-label", { ariaLabel: "", placeholder: "Hint" }, { name: "Hint", from: "placeholder" }],
  ];
  for (const [label, over, want] of cases) assert.deepEqual(pickName(facts(over)), want, label);
  assert.equal(pickName(facts({ labels: ["x".repeat(200)] })).name.length, 80, "a name is capped");
});

test("an element listed for its test id is not an unnamed control; an icon button with no name still is", () => {
  // The same empty name; only whether a user can act on it, or whether it is hidden from assistive technology, differs.
  assert.equal(missingName({ role: "generic", name: "", interactive: false }), false, "a decorative badge");
  assert.equal(missingName({ role: "generic", name: "", interactive: true, ariaHidden: true }), false, "an aria-hidden dot");
  assert.equal(missingName({ role: "button", name: "", interactive: true, ariaHidden: false }), true, "an icon-only button");
  assert.equal(missingName({ role: "textbox", name: "q", nameFrom: "fallback", interactive: true }), true, "a field named by its name attribute");
});

test("only the live regions listed for their text leave a state's identity, and only non-controls leave coverage", () => {
  const els = [
    { key: "button:save", interactive: true },
    { key: "tid:wrapper", interactive: false },
    { key: "live:alert", interactive: false, liveOnly: true },
    { key: "button:old" },
  ];
  assert.deepEqual(
    trackedElements(els).map((e) => e.key),
    ["button:save", "tid:wrapper", "button:old"],
  );
  assert.deepEqual(inertKeys(els), ["tid:wrapper"], "an element collected before the collector said is counted, as before");
});

test("state markers show what is on, and the diff says how it moved", () => {
  assert.deepEqual(stateFlags(undefined), []);
  assert.deepEqual(stateFlags({ pressed: "false", selected: "false", checked: "false", expanded: "false", current: "false" }), []);
  assert.deepEqual(stateFlags({ pressed: "true" }), ["pressed"]);
  assert.deepEqual(stateFlags({ selected: "true", expanded: "true" }), ["selected", "expanded"]);
  assert.deepEqual(stateFlags({ checked: "true" }), ["checked"]);
  assert.deepEqual(stateFlags({ checked: "mixed", pressed: "mixed" }), ["partly pressed", "partly checked"]);
  assert.deepEqual(stateFlags({ current: "page" }), ["current"]);
  assert.deepEqual(stateFlags({ pressed: null, current: null }), []);
  assert.equal(stateChange([], []), null);
  assert.equal(stateChange(["pressed"], ["pressed"]), null);
  assert.equal(stateChange([], ["pressed"]), "now [pressed]");
  assert.equal(stateChange(["pressed"], []), "no longer [pressed]");
  assert.equal(stateChange(["selected"], ["expanded"]), "now [expanded], no longer [selected]");
});

test("the main-region line tells a page of text from a main area that rendered nothing", () => {
  const withText = { landmark: true, heading: { level: 1, text: "Title" }, paragraphs: 1, chars: 21, controls: 0, media: 0 };
  const empty = { landmark: true, heading: null, paragraphs: 0, chars: 0, controls: 0, media: 0 };
  assert.equal(mainRegionLine(withText), 'main: h1 "Title" · 1 paragraph · 21 chars of static text');
  assert.equal(mainRegionLine(empty), "main: EMPTY");
  assert.equal(mainRegionTag(withText), "main 21 chars");
  assert.equal(mainRegionTag(empty), "main EMPTY");
  // A main area holding only controls, or only an image or embed, is not empty.
  assert.equal(mainRegionLine({ ...empty, controls: 3 }), "main: no static text");
  assert.equal(mainRegionLine({ ...empty, media: 1 }), "main: no static text");
  assert.equal(
    mainRegionLine({ ...withText, paragraphs: 2, landmark: false }),
    'content (no main landmark): h1 "Title" · 2 paragraphs · 21 chars of static text',
  );
  assert.equal(mainRegionTag({ ...empty, landmark: false }), "content EMPTY");
});

test("controls held outside a horizontally scrolling container's visible width are one worth-a-look line per container", () => {
  const row = (i: number, scrolledOutIn: string | null) => ({
    ref: `e${i}`,
    name: "Edit",
    role: "button",
    xpath: `/html/body/div[1]/table[1]/tbody[1]/tr[${i}]/td[6]/button[1]`,
    rect: { x: 900, y: 100 + i * 40, w: 60, h: 30 },
    scrolledOutIn,
  });
  // A 600px wrapper around a 1200px table: its last column is out of view.
  const wide = geometryIssues([row(1, "[table-wrap]"), row(2, "[table-wrap]"), row(3, "[table-wrap]")], { width: 1280, height: 900 });
  assert.deepEqual(wide, [
    "3 controls are scrolled out of view inside a horizontally scrolling container [table-wrap] — only a sideways scroll of it shows them; worth a look at this width, not necessarily a defect",
  ]);
  // The same table narrow enough to fit: the collector marks nothing, and nothing is said.
  assert.deepEqual(geometryIssues([row(1, null), row(2, null), row(3, null)], { width: 1280, height: 900 }), []);
  const one = geometryIssues([row(1, "<div#wrap>")], { width: 1280, height: 900 });
  assert.match(one[0], /^1 control is scrolled out of view inside a horizontally scrolling container <div#wrap> — only a sideways scroll of it shows it;/);
});

test("a field's shown name is not a label when it came from its placeholder, name attribute or type", () => {
  // The same shown name each time; only where it came from differs.
  const labelled = { role: "textbox", name: "Your email", nameFrom: null };
  const placeholder = { role: "textbox", name: "Your email", nameFrom: "placeholder" as const };
  const fallback = { role: "textbox", name: "email", nameFrom: "fallback" as const };
  assert.deepEqual([missingName(labelled), placeholderOnly(labelled), labelFlag(labelled)], [false, false, null]);
  assert.deepEqual([missingName(placeholder), placeholderOnly(placeholder), labelFlag(placeholder)], [false, true, "no label: placeholder only"]);
  assert.deepEqual([missingName(fallback), placeholderOnly(fallback), labelFlag(fallback)], [true, false, "no label"]);
  // The name is still shown, so the agent can tell the field apart and target it.
  assert.equal(displayName(placeholder), "Your email");
  assert.equal(displayName(fallback), "email");
  // An element the collector says nothing about is judged as before.
  assert.equal(missingName({ role: "button", name: "Save" }), false);
});

test("a blank aria-label leaves a placeholder field unnamed, and filed only as that", () => {
  // The same placeholder field; a whitespace aria-label ends the name before the placeholder is reached.
  const blank = { role: "textbox", name: "", nameFrom: "placeholder" as const };
  assert.deepEqual([missingName(blank), placeholderOnly(blank), labelFlag(blank)], [true, false, "no label"]);
  assert.equal(displayName(blank), "(unnamed)");
});

test("a placeholder-only field's evidence caps the placeholder, and names the control as the unnamed list does", () => {
  const el = { role: "textbox", testid: null, xpath: "/html/body/form[1]/input[3]", name: "Email" };
  assert.equal(describeControl(el), "textbox at /html/body/form[1]/input[3]");
  assert.equal(placeholderEvidence(el), 'textbox at /html/body/form[1]/input[3] "Email"');
  const long = placeholderEvidence({ ...el, testid: "hint-field", name: "x".repeat(300) });
  assert.equal(long, `textbox [testid=hint-field] "${"x".repeat(79)}…"`);
  assert.equal(placeholderEvidence({ ...el, name: "y".repeat(80) }), `textbox at /html/body/form[1]/input[3] "${"y".repeat(80)}"`, "80 exactly is kept whole");
});

test("frameLines: says what is embedded, where from, and that it was not explored", () => {
  const app = "http://app.test:3000/";
  assert.deepEqual(frameLines(app, []), [], "no frames, nothing to say");
  const frames = [
    { url: "http://app.test:3000/widget?x=1", title: "Widget", width: 400, height: 200, foreign: false },
    { url: "https://forms.example.com/embed", title: "", width: 600, height: 300, foreign: true },
    { url: "https://tracker.example.com/pixel", title: "", width: 0, height: 0, foreign: true },
  ];
  const lines = frameLines(app, frames, { nested: 2 });
  assert.match(lines[0], /FRAMES not explored/);
  assert.equal(lines[1], '  same-origin /widget?x=1 "Widget" 400×200');
  assert.equal(lines[2], "  cross-origin https://forms.example.com/embed 600×300 — writes it sends outside the app are refused");
  assert.equal(lines[3], "  (+1 hidden frame)");
  assert.equal(lines[4], "  (+2 more frames, nested inside those or past the first 30, not read)");
  assert.equal(lines.length, 5);
  // In destructive mode a foreign frame's writes do go out, and the line must not say otherwise.
  assert.match(frameLines(app, frames, { writesRefused: false })[2], /its writes go out \(destructive mode\)/);
  // The contrast: a page whose only frames are hidden has nothing a user sees inside one.
  assert.equal(hasVisibleFrame([{ url: "https://tracker.example.com/p", title: "", width: 1, height: 1, foreign: true }]), false);
  assert.equal(hasVisibleFrame([{ url: "https://forms.example.com/e", title: "", width: 600, height: 300, foreign: true }]), true);
});

test("frameElementKey: an embed's control is not the page's control of the same name", () => {
  const foreign = { url: "https://forms.example.com/embed?x=1", origin: "https://forms.example.com", title: "", foreign: true };
  const own = { url: "http://app.test/widget?id=3", origin: "http://app.test", title: "", foreign: false };
  assert.equal(frameElementKey("button:submit", undefined), "button:submit", "the page's own controls keep their key");
  assert.equal(frameElementKey("button:submit", foreign), "frame:https://forms.example.com|button:submit");
  assert.equal(frameElementKey("button:submit", own), "frame:/widget|button:submit", "the app's frame by its path, not its query");
  assert.equal(frameLabel(foreign), "cross-origin frame https://forms.example.com");
  assert.equal(frameLabel({ ...own, title: "Widget" }), 'same-origin frame /widget?id=3 "Widget"');
});

test("masksForeignName: the interface is kept, what a container holds is not", () => {
  for (const [tag, role] of [
    ["a", "link"],
    ["button", "button"],
    ["input", "textbox"],
    ["div", "button"],
    ["span", "tab"],
  ] as const) {
    assert.equal(masksForeignName(tag, role), false, `${tag} ${role}`);
  }
  for (const [tag, role] of [
    ["select", "combobox"],
    ["textarea", "textbox"],
    ["div", "generic"],
    ["li", "listitem"],
  ] as const) {
    assert.equal(masksForeignName(tag, role), true, `${tag} ${role}`);
  }
});

test("frameLines: with the frames read, says which were listed", () => {
  const app = "http://app.test:3000/";
  const frames = [
    { url: "http://app.test:3000/widget", title: "", width: 400, height: 200, foreign: false },
    { url: "https://forms.example.com/embed", title: "", width: 600, height: 300, foreign: true },
  ];
  const lines = frameLines(app, frames, { read: new Set(["http://app.test:3000/widget"]) });
  assert.match(lines[0], /^FRAMES — the controls of each frame read are listed above/);
  assert.match(lines[0], /content is masked/, "another site's frame is on the page");
  assert.equal(lines[1], "  same-origin /widget 400×200 — controls listed above");
  assert.equal(lines[2], "  cross-origin https://forms.example.com/embed 600×300 — not read — writes it sends outside the app are refused");
});

test("frame helpers: names capped, link queries dropped, rects placed on the page", () => {
  assert.equal(capForeignName("Send"), "Send");
  assert.equal(capForeignName("Reply to: Alice Smith, card 4242, 12 Park Road"), "Reply to: Alice Smith, card 4242, 12 Par…");
  assert.equal(stripForeignHref("https://chat.example.com/conv/1?token=SECRET&email=a@b.c#m2"), "https://chat.example.com/conv/1");
  assert.equal(stripForeignHref("/conv/1?token=SECRET"), "/conv/1", "a relative address, as the attribute gives it");
  // A control at (10, 20) inside a frame at (100, 300) on screen, the frame scrolled by 5 and the page by 40.
  assert.deepEqual(frameToPageRect({ x: 10, y: 20, width: 30, height: 10 }, { x: 100, y: 300 }, { x: 0, y: 5 }, { x: 0, y: 40 }), {
    x: 110,
    y: 355,
    width: 30,
    height: 10,
  });
  // Two srcdoc frames of the app are told apart by their titles.
  const srcdoc = (title: string) => ({ url: "about:srcdoc", origin: "", title, foreign: false });
  assert.notEqual(frameElementKey("button:send", srcdoc("Inner note")), frameElementKey("button:send", srcdoc("Other widget")));
});

test("formatViolations: an embed's violation says whose it is", () => {
  const at = new Date().toISOString();
  const out = formatViolations([
    {
      kind: "http_error",
      severity: "medium",
      detail: "GET https://chat.example.com/x → HTTP 404",
      url: "http://app.test/",
      at,
      embed: "https://chat.example.com",
    },
    { kind: "http_error", severity: "high", detail: "GET http://app.test/api → HTTP 500", url: "http://app.test/", at },
  ]);
  assert.match(out, /\[medium\] http_error \(in an embed of https:\/\/chat\.example\.com: its behaviour, not the app's\)/);
  assert.match(out, /\[high\] http_error: GET http:\/\/app\.test\/api/, "the app's own is unchanged");
});

test("failedLoadEchoOf: the browser's own line for a failed load names its request by location", () => {
  const page = "http://app.test/checkout";
  const cases: [string, string | undefined, string | null][] = [
    // Chromium and WebKit: an error status, and a load that got no answer.
    [
      "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
      "https://pay.example.com/api/x?y=1",
      "https://pay.example.com/api/x?y=1",
    ],
    ["Failed to load resource: net::ERR_CONNECTION_REFUSED", "https://pay.example.com/api/x", "https://pay.example.com/api/x"],
    // The fragment is never sent, so it is not part of the request.
    ["Failed to load resource: the server responded with a status of 404 (Not Found)", "https://pay.example.com/a.png#top", "https://pay.example.com/a.png"],
    // A relative location is resolved against the page.
    ["Failed to load resource: the server responded with a status of 404 (Not Found)", "/api/things", "http://app.test/api/things"],
    // Any other console error is not an echo, whatever its location says.
    ["Uncaught TypeError: x is undefined", "https://pay.example.com/sdk.js", null],
    ["Not allowed to use restricted network port 1: http://127.0.0.1:1/x", "https://pay.example.com/frame", null],
    ["Error: Failed to load resource: whatever", "https://pay.example.com/x", null],
    // An echo with no location cannot be matched to a request.
    ["Failed to load resource: the server responded with a status of 500 (Internal Server Error)", undefined, null],
    ["Failed to load resource: the server responded with a status of 500 (Internal Server Error)", "", null],
  ];
  for (const [text, location, want] of cases) assert.equal(failedLoadEchoOf(text, location, page), want, `${text} @ ${location}`);
});

test("EmbedRequestLog: an echo follows the latest request to its address", () => {
  const log = new EmbedRequestLog(3);
  const echo500 = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
  const page = "http://app.test/";
  log.note("https://pay.example.com/api/fail#frag", "https://pay.example.com");
  assert.equal(log.embedOfEcho(echo500, "https://pay.example.com/api/fail", page), "https://pay.example.com");
  assert.equal(log.embedOfEcho("Uncaught Error: boom", "https://pay.example.com/api/fail", page), null, "only the echo line follows the request");
  assert.equal(log.embedOfEcho(echo500, "https://pay.example.com/api/other", page), null, "an address no embed requested is the app's");
  // The app then requests the same address: its echo is the app's.
  log.note("https://pay.example.com/api/fail", null);
  assert.equal(log.embedOfEcho(echo500, "https://pay.example.com/api/fail", page), null);
  // Bounded: the oldest address is dropped past the cap.
  for (const n of [1, 2, 3, 4]) log.note(`https://pay.example.com/r${n}`, "https://pay.example.com");
  assert.equal(log.embedOfEcho(echo500, "https://pay.example.com/r1", page), null);
  assert.equal(log.embedOfEcho(echo500, "https://pay.example.com/r4", page), "https://pay.example.com");
});

test("OracleMonitor: an embed's failed load echoed to the console is the embed's; the app's echo stays the app's", () => {
  const page = Object.assign(new EventEmitter(), { url: () => "http://app.test/checkout" });
  const monitor = new OracleMonitor();
  type FakeRequest = { url: () => string; from: string | null };
  monitor.setEmbedAttribution((req) => (req as unknown as FakeRequest).from);
  monitor.attach(page as unknown as Page);
  const url = "https://pay.example.com/api/fail";
  const echo = () =>
    page.emit("console", {
      type: () => "error",
      text: () => "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
      location: () => ({ url, lineNumber: 0, columnNumber: 0 }),
    });
  // The same request, once from the embed's frame and once from the app's own page.
  page.emit("request", { url: () => url, from: "https://pay.example.com" });
  echo();
  page.emit("request", { url: () => url, from: null });
  echo();
  const [fromEmbed, fromApp] = monitor.drain();
  assert.equal(fromEmbed.kind, "console_error");
  assert.equal(fromEmbed.embed, "https://pay.example.com");
  assert.equal(fromEmbed.severity, "medium", "an embed's echo is capped like its request");
  assert.equal(fromApp.kind, "console_error");
  assert.equal(fromApp.embed, undefined);
  assert.equal(fromApp.severity, "high", "the app's own echo is unchanged");
});

// ---------------------------------------------------------------------------
// postMessage to "*" carrying a token (postmessage.ts). Invented tokens only.
// ---------------------------------------------------------------------------

const b64url = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const INVENTED_JWT = [b64url({ alg: "HS256", typ: "JWT" }), b64url({ sub: "someone", exp: 4102444800 }), "aW52ZW50ZWQtc2lnbmF0dXJl"].join(".");
const OPAQUE = "q7X9rT2mLp4VzK8wB3nD5fH1";

test("postMessage: token shapes are recognised, near misses are not", () => {
  const cases: Array<[string, string, string | null]> = [
    ["data.access_token", INVENTED_JWT, "jwt"],
    ["data.anything", INVENTED_JWT, "jwt"],
    ["data.anything", `  ${INVENTED_JWT}  `, "jwt"],
    ["data.headers.Authorization", `Bearer ${OPAQUE}`, "bearer"],
    ["data.access_token", OPAQUE, "credential-key"],
    ["data.accessToken", OPAQUE, "credential-key"],
    ["data.auth.ID-TOKEN", OPAQUE, "credential-key"],
    ["data.list[0].refresh_token", OPAQUE, "credential-key"],
    ["data.apiKey", OPAQUE, "credential-key"],
    ["data.url", `https://app.example/cb#access_token=${OPAQUE}&token_type=Bearer`, "url-param"],
    ["data", `?id_token=${OPAQUE}`, "url-param"],
    // Near misses: the key without a credential, a credential shape without its value, a value under an ordinary key.
    ["data.token_type", "Bearer", null],
    ["data.token", "pending-confirmation", null],
    ["data.token", "abcdefghijklmnopqrstuvwxyz", null],
    ["data.note", OPAQUE, null],
    ["data.note", "Bearer tokens are sent in the Authorization header", null],
    ["data.note", "eyJ is how they start, but this is prose.", null],
    ["data.note", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx", null],
    ["data.url", "https://app.example/cb?access_token=short", null],
    ["data.expires_at", "2026-09-27T10:00:00.000Z", null],
  ];
  for (const [path, value, shape] of cases) assert.equal(tokenShapeOf(path, value)?.shape ?? null, shape, `${path} = ${value}`);
});

test("postMessage: a hit carries the path, the shape and a four-character preview, never the value", () => {
  const hits = tokenHits([
    ["data.access_token", INVENTED_JWT],
    ["data.headers.Authorization", `Bearer ${OPAQUE}`],
    ["data.note", "a plain sentence well over sixteen characters"],
  ]);
  assert.deepEqual(hits, [
    { path: "data.access_token", shape: "jwt", preview: `"eyJh…" (${INVENTED_JWT.length} chars)` },
    { path: "data.headers.Authorization", shape: "bearer", preview: `"${OPAQUE.slice(0, 4)}…" (${OPAQUE.length} chars)` },
  ]);
  const detail = describeTokenPost(hits[0], "http://127.0.0.1:4173/signin/callback");
  assert.match(detail, /^jwt token at data\.access_token \("eyJh…" \(\d+ chars\)\) posted with targetOrigin "\*" to the window of \/signin\/callback/);
  const [, claims, signature] = INVENTED_JWT.split(".");
  for (const h of hits) {
    const text = `${JSON.stringify(h)} ${describeTokenPost(h, "http://x/")}`;
    for (const part of [INVENTED_JWT, claims, signature, OPAQUE.slice(4)]) assert.ok(!text.includes(part), `${h.shape} leaks ${part.slice(0, 8)}`);
  }
  assert.equal(maskToken("abcdefghijklmnop"), '"abcd…" (16 chars)');
});

test("postMessage: a string message that is JSON is walked like the object it encodes", () => {
  const hits = tokenHits([["data", JSON.stringify({ type: "signed-in", session: { refresh_token: OPAQUE } })]]);
  assert.deepEqual(
    hits.map((h) => [h.path, h.shape]),
    [["data(json).session.refresh_token", "credential-key"]],
  );
  assert.deepEqual(tokenHits([["data", "{ not json but long enough"]]), []);
});

test("postMessage: what the page hands back is untrusted, so malformed entries are skipped", () => {
  assert.deepEqual(tokenHits(null), []);
  assert.deepEqual(tokenHits("data.access_token"), []);
  assert.deepEqual(tokenHits([["data.access_token"], [1, OPAQUE], "x", ["data.access_token", 42]]), []);
  const long = `data.${"k".repeat(500)}.access_token`;
  assert.ok(tokenHits([[long, INVENTED_JWT]])[0].path.length <= 120, "a hostile path is cut");
});

test("postMessage: one report per route, receiving frame, path and shape", () => {
  const [hit] = tokenHits([["data.access_token", INVENTED_JWT]]);
  const a = tokenPostKey(hit, "http://127.0.0.1:4173/items/12", "http://127.0.0.1:4173/items/12");
  assert.equal(a, tokenPostKey(hit, "http://127.0.0.1:4173/items/34", "http://127.0.0.1:4173/items/34"), "the same route shape is one report");
  assert.notEqual(a, tokenPostKey(hit, "http://127.0.0.1:4173/items/12", "https://widget.example/frame"), "another receiving frame is another report");
  assert.ok(postsToAnyOrigin("*"));
  for (const o of ["/", "https://app.example", "", undefined, { targetOrigin: "*" }]) assert.ok(!postsToAnyOrigin(o), String(o));
});

/** Run the capture script against a stand-in window, so its targetOrigin rule and its walk are tested without a browser. */
function captureIn(): { win: Record<string, unknown>; reported: unknown[][]; delivered: unknown[][] } {
  const reported: unknown[][] = [];
  const delivered: unknown[][] = [];
  const win: Record<string, unknown> = {
    postMessage(...args: unknown[]) {
      delivered.push(args);
    },
    [POSTMESSAGE_BINDING]: (entries: unknown[]) => {
      // Arrays made in the script's realm; cloned so they compare as plain data.
      reported.push(JSON.parse(JSON.stringify(entries)));
      return Promise.resolve();
    },
  };
  vm.runInNewContext(postMessageCaptureScript(), { window: win });
  return { win, reported, delivered };
}

test('postMessage capture: only a "*" call is handed back, and every call still goes through unchanged', () => {
  const { win, reported, delivered } = captureIn();
  const post = win.postMessage as (...a: unknown[]) => void;
  const msg = { type: "signed-in", access_token: OPAQUE, n: 1, nested: { list: ["short", `Bearer ${OPAQUE}`] } };
  post(msg, "*");
  post(msg, { targetOrigin: "*" });
  post(msg, "https://app.example");
  post(msg, { targetOrigin: "https://app.example" });
  post(msg);
  post(msg, {});
  assert.equal(delivered.length, 6, "the app's calls all reach the real postMessage");
  assert.deepEqual(delivered[0], [msg, "*"]);
  assert.equal(reported.length, 2, 'only the two calls naming "*" are handed back');
  assert.deepEqual(reported[0], [
    ["data.access_token", OPAQUE],
    ["data.nested.list[1]", `Bearer ${OPAQUE}`],
  ]);
});

test("postMessage capture: a cyclic, deep or hostile message cannot break the app's call", () => {
  const { win, reported, delivered } = captureIn();
  const post = win.postMessage as (...a: unknown[]) => void;
  const cyclic: Record<string, unknown> = { access_token: OPAQUE };
  cyclic.self = cyclic;
  post(cyclic, "*");
  const hostile = Object.defineProperty({}, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter");
    },
  });
  post(hostile, "*");
  const broken = captureIn();
  broken.win[POSTMESSAGE_BINDING] = () => {
    throw new Error("binding gone");
  };
  (broken.win.postMessage as (...a: unknown[]) => void)({ access_token: OPAQUE }, "*");
  assert.equal(delivered.length, 2);
  assert.equal(broken.delivered.length, 1, "a failing report still lets the call through");
  assert.deepEqual(reported[0], [["data.access_token", OPAQUE]], "the cycle is walked once");
  assert.equal(reported.length, 1, "a message with nothing long enough is not handed back");
});

test("postMessage capture: binary buffers and huge arrays are not walked, and a long JSON string is sent whole", () => {
  const { win, reported, delivered } = captureIn();
  const post = win.postMessage as (...a: unknown[]) => void;
  // Counted rather than timed: how many of an array's items the walk reads, and whether it goes inside a binary
  // buffer at all. A time bound stood for the same two facts, and a loaded machine could trip it.
  let itemsRead = 0;
  const numbers = new Proxy(new Array(1_000_000).fill(7), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) itemsRead += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  let bytesWalked = false;
  // A named property on the buffer, which a walk that went inside it would read.
  const bytes = Object.defineProperty(new Uint8Array(16), "probe", { enumerable: true, get: () => ((bytesWalked = true), OPAQUE) });
  const message = { bytes, numbers, access_token: OPAQUE };
  post(message, "*");
  assert.ok(itemsRead <= MAX_ITEMS, `the walk reads at most ${MAX_ITEMS} of an array's items, not all of them (read ${itemsRead})`);
  assert.equal(bytesWalked, false, "a binary buffer is not walked");
  assert.equal(delivered.length, 1);
  assert.deepEqual(reported[0], [["data.access_token", OPAQUE]], "a token past a large array is still found");
  const big = JSON.stringify({ padding: "x".repeat(20_000), session: { access_token: OPAQUE } });
  post(big, "*");
  const [sent] = reported[reported.length - 1] as Array<[string, string]>;
  assert.equal(sent[1].length, big.length, "a JSON string past the plain-string cap is sent whole");
  assert.deepEqual(
    tokenHits([sent]).map((h) => h.path),
    ["data(json).session.access_token"],
  );
});

// ---------------------------------------------------------------------------
// The tester's own scout_request probes are not the page's violations.
// ---------------------------------------------------------------------------

/** A fake page and a monitor on it; requests carry a `replay` flag the engine's identity check reads. */
function monitored(): { page: EventEmitter & { url: () => string }; monitor: OracleMonitor } {
  const page = Object.assign(new EventEmitter(), { url: () => "http://app.test/things" });
  const monitor = new OracleMonitor();
  monitor.setReplayCheck((r) => (r as unknown as { replay: boolean }).replay);
  monitor.attach(page as unknown as Page);
  return { page, monitor };
}
const fakeResponse = (url: string, status: number, replay: boolean) => {
  const request = { url: () => url, method: () => "GET", replay };
  return { status: () => status, url: () => url, request: () => request };
};
const failedLoad = (url: string) => ({
  type: () => "error",
  text: () => "Failed to load resource: the server responded with a status of 403 (Forbidden)",
  location: () => ({ url, lineNumber: 0, columnNumber: 0 }),
});

test("OracleMonitor: a refused scout_request probe and its console echo are not the page's violations", () => {
  const { page, monitor } = monitored();
  const url = "http://app.test/api/things/9";
  monitor.replayStarted(url);
  page.emit("response", fakeResponse(url, 403, true));
  page.emit("console", failedLoad(url));
  monitor.replayEnded(url);
  assert.deepEqual(monitor.drain(), []);
  assert.equal(monitor.replayAttributed, 2, "counted, not silently dropped");
});

test("OracleMonitor: the same 403 fetched by the page itself is still reported", () => {
  const { page, monitor } = monitored();
  const url = "http://app.test/api/things/9";
  page.emit("response", fakeResponse(url, 403, false));
  page.emit("console", failedLoad(url));
  assert.deepEqual(
    monitor.drain().map((v) => `${v.severity} ${v.kind}`),
    ["medium http_error", "high console_error"],
  );
  assert.equal(monitor.replayAttributed, 0);
});

test("ReplayLog: a replay's echo is matched by address while in flight and for a short window after", () => {
  const log = new ReplayLog();
  const page = "http://app.test/things";
  const echo = "Failed to load resource: the server responded with a status of 404 (Not Found)";
  const url = "http://app.test/api/things/9";
  assert.equal(log.echoes(echo, url, page, 0), false, "nothing replayed yet");
  log.begin(url);
  assert.equal(log.echoes(echo, url, page, 10_000), true, "in flight, however long it takes");
  log.end(url, 1000);
  assert.equal(log.echoes(echo, `${url}#frag`, page, 1000 + REPLAY_ECHO_WINDOW_MS), true, "the fragment is never sent");
  assert.equal(log.echoes(echo, "http://app.test/api/things/10", page, 1001), false, "another address is the page's");
  assert.equal(log.echoes("Uncaught TypeError: x is undefined", url, page, 1001), false, "only the failed-load echo");
  assert.equal(log.echoes(echo, url, page, 1001 + REPLAY_ECHO_WINDOW_MS), false, "past the window the address is the page's again");
  // A redirect hop is begun and ended like the call itself, so it does not stay the replay's for the session.
  const hop = "http://app.test/login";
  log.begin(hop);
  log.end(hop, 5000);
  assert.equal(log.echoes(echo, hop, page, 5000 + REPLAY_ECHO_WINDOW_MS + 1), false);
});

// ---------------------------------------------------------------------------
// A router cancelling a route change on purpose (isRouteCancellation).
// ---------------------------------------------------------------------------

test("isRouteCancellation: a click that stayed put and opened a confirmation, or says it cancelled a route", () => {
  const click = { byClick: true, viaLink: true, urlChanged: false, dialogOpened: true };
  const plain = "Navigation cancelled: unsaved changes";
  const cases: Array<[string, typeof click, boolean, string]> = [
    [plain, click, true, "a link click that opened a confirmation instead of moving"],
    [plain, { ...click, dialogOpened: false }, false, "the same throw with no dialog"],
    [plain, { ...click, viaLink: false }, false, "a button with no route asked for"],
    [plain, { ...click, urlChanged: true }, false, "the URL moved: not a cancellation"],
    [plain, { ...click, byClick: false }, false, "not raised by a click"],
    ["Route change aborted", { ...click, viaLink: false, dialogOpened: false }, true, "the wording names a cancelled route"],
    ["Abort fetching component for route: /things", { ...click, viaLink: false, dialogOpened: false }, true, "either order"],
    ["Route change aborted", { ...click, urlChanged: true }, false, "but never when the URL moved"],
    ["Cannot read properties of undefined (reading 'route')", { ...click, viaLink: false, dialogOpened: false }, false, "a crash that mentions a route"],
    ["Request aborted", { ...click, viaLink: false, dialogOpened: false }, false, "an abort with no route"],
  ];
  for (const [message, c, want, why] of cases) assert.equal(isRouteCancellation(message, c), want, why);
});

test("OracleMonitor: a route-change cancellation is re-ranked medium with a note; a crash stays high", () => {
  const { page, monitor } = monitored();
  const since = Date.now();
  page.emit("pageerror", new Error("Navigation cancelled: unsaved changes"));
  monitor.downgradeRouteCancellations(since, { byClick: true, viaLink: true, urlChanged: false, dialogOpened: true });
  const [cancel] = monitor.drain();
  assert.equal(cancel.severity, "medium");
  assert.match(cancel.detail, /router cancelling the route change/);
  assert.match(cancel.detail, /opened a dialog/, "the note names the evidence it was read on");

  page.emit("pageerror", new Error("Route change aborted"));
  monitor.downgradeRouteCancellations(since, { byClick: true, viaLink: false, urlChanged: false, dialogOpened: false });
  const [worded] = monitor.drain();
  assert.equal(worded.severity, "medium");
  assert.match(worded.detail, /says the route change was cancelled/);
  assert.doesNotMatch(worded.detail, /dialog/, "no dialog is claimed when none was seen");
  assert.equal(monitor.all[0].severity, "medium", "the session log holds the same verdict");

  page.emit("pageerror", new Error("Navigation cancelled: unsaved changes"));
  monitor.downgradeRouteCancellations(since, { byClick: true, viaLink: true, urlChanged: false, dialogOpened: false });
  const [crash] = monitor.drain();
  assert.equal(crash.severity, "high");
  assert.doesNotMatch(crash.detail, /router/);
});

test("OracleMonitor: a contradiction keeps the severity its rule gave it", () => {
  const monitor = new OracleMonitor();
  monitor.noteContradiction({ kind: "false_success", detail: "partial: 1 of 2", evidence: "x", severity: "medium" }, "http://app.test/");
  monitor.noteContradiction({ kind: "false_success", detail: "all refused", evidence: "y" }, "http://app.test/");
  assert.deepEqual(
    monitor.drain().map((v) => v.severity),
    ["medium", "high"],
  );
});

test("a plan stops at a new violation by default; with continue, only at one that is not an error status or its echo", () => {
  const http = { kind: "http_error" as const };
  const consoleEcho = { kind: "console_error" as const };
  const crash = { kind: "page_error" as const };
  const contradiction = { kind: "refused_empty" as const };
  assert.equal(planStopsAt([], "stop"), false, "nothing new, nothing to stop for");
  assert.equal(planStopsAt([{ ...http, repeat: true }], "stop"), false, "a repeat never stops a plan");
  assert.equal(planStopsAt([http], "stop"), true);
  assert.equal(planStopsAt([http], "continue"), false, "a sweep goes on past an error status");
  assert.equal(planStopsAt([http, consoleEcho], "continue"), false, "...and past the console's echo of it");
  assert.equal(planStopsAt([http, crash], "continue"), true, "an uncaught exception stops it either way");
  assert.equal(planStopsAt([contradiction], "continue"), true, "a page contradicting the server stops it either way");
  assert.equal(planStopsAt([{ ...crash, repeat: true }, http], "continue"), false, "a repeated exception does not count against the rule");
  for (const kind of ["request_failed", "dom_injection", "false_success", "postmessage_token"] as const) {
    assert.equal(planStopsAt([{ kind }], "continue"), true, `${kind} stops a plan run with continue`);
  }
});

test("a forced click names what covers its target, and says when a write-policy block came first", () => {
  const toast = { role: "status", tag: "div", text: "Could not save\n  the record", testid: "toast-error" };
  assert.equal(describeCover(toast, false), 'covered by status "Could not save the record" [testid=toast-error]');
  assert.match(
    describeCover(toast, true),
    /^covered by status "Could not save the record" \[testid=toast-error\] \(after a write-policy block since the last snapshot/,
  );
  assert.equal(describeCover({ role: null, tag: "div", text: "", testid: null }, false), "covered by <div>", "an unnamed layer is named by its tag");
  const long = describeCover({ role: null, tag: "aside", text: "x".repeat(200), testid: null }, false);
  assert.ok(long.length < 90 && long.endsWith('…"'), long);
});
