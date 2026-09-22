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
import { brokenImageIssues, displayName, geometryIssues, missingName } from "../src/engine/collector.ts";
import { POLICY_BLOCK_WINDOW_MS, isPolicyInduced, redactViolation } from "../src/engine/oracles.ts";
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
