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
  masksForeignName,
  missingName,
  placeholderOnly,
  placeholderEvidence,
  describeControl,
  labelFlag,
  capForeignName,
  stripForeignHref,
  frameToPageRect,
} from "../src/engine/collector.ts";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  EmbedRequestLog,
  OracleMonitor,
  POLICY_BLOCK_WINDOW_MS,
  failedLoadEchoOf,
  formatViolations,
  isPolicyInduced,
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
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
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
