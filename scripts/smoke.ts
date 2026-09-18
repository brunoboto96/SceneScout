/**
 * End-to-end smoke test for the engine (no LLM, no MCP wire): serves the
 * test app, drives BrowserEngine directly, and asserts oracles, read-only
 * policy, memory, findings, and report generation all work.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
// Import the compiled output, not src/: tsx's esbuild transform injects a
// `__name` helper into functions that page.evaluate serializes into the
// browser, where the helper doesn't exist. The tsc build has no such transform.
import { BrowserEngine } from "../dist/engine/browser.js";
import { generateReport } from "../dist/engine/report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "test-app");

let failures = 0;
function check(name: string, cond: boolean, context?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${context ? `\n    ${context}` : ""}`);
  }
}

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * These waits exist because a click fires a request whose RESPONSE registers
 * the created resource — a fixed 300ms sleep guessed at that round trip. It
 * passed locally and would fail on a loaded CI runner for no reason the output
 * explained. Polling turns "slow" into "still correct, just later", and only a
 * genuine hang reaches the timeout.
 */
async function until(label: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * A deliberate fixed pause, for the cases where the thing being asserted is
 * that something did NOT happen. There is no condition to poll for when the
 * expected outcome is absence, so name the wait honestly rather than dressing
 * it up as a poll.
 */
function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // Every multipart upload the server received, so the test can prove the
  // BYTES arrived (a real PDF header inside the body), not just that a
  // request was made.
  const uploadLog: Array<{ filename: string; bytes: number; sawPdf: boolean; sawPng: boolean }> = [];
  /** POSTs to /api/items — a click on "Create item" fires exactly one, so this counts clicks that actually happened. */
  let itemPosts = 0;
  // Tiny server for the test app: static pages + a minimal items API for
  // write-policy testing.
  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    if ((urlPath === "/api/upload" || urlPath === "/api/avatar") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const entry = {
          filename: /filename="([^"]*)"/.exec(body.toString("latin1"))?.[1] ?? "",
          bytes: body.length,
          sawPdf: body.includes("%PDF-"),
          sawPng: body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        };
        uploadLog.push(entry);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `u${uploadLog.length}`, ...entry }));
      });
      return;
    }
    if (urlPath === "/api/items" && req.method === "POST") {
      itemPosts += 1;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "42", name: "smoke item" }));
      return;
    }
    if (urlPath === "/api/items/upsert" && req.method === "POST") {
      // Upsert: echoes the id the client sent — must NOT become session-owned.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "7", name: "existing item" }));
      return;
    }
    if (urlPath.startsWith("/api/items/") && (req.method === "PUT" || req.method === "DELETE")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Regression fixture: a create response naming its own id after the
    // resource ("document_id") rather than a bare "id" — the exact shape
    // that let a real backend's creations slip past ownership tracking.
    if (urlPath === "/api/documents" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "99", title: "smoke doc" }));
      return;
    }
    // Regression fixture: a 201 create response that includes a
    // server-derived foreign key (owner_id) alongside the new resource's
    // own id. Unlike template_id in the fixture below, owner_id's value is
    // never echoed anywhere in the request — it's the CURRENT USER's id,
    // supplied entirely server-side — so the request-echo filter alone
    // can't catch it; only a same-resource-name check can.
    if (urlPath === "/api/documents/quick" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "250", owner_id: "3", title: "smoke quick doc" }));
      return;
    }
    // Regression fixture: a single UI action that fires POST-then-immediately
    // PUT with NO artificial delay (create, then save content under the id
    // it just got back) — the real-world pattern a "Save" button uses, and
    // a race the earlier fixtures above (separate clicks, test waits 300ms
    // between them) don't exercise.
    if (urlPath === "/api/documents/instant" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "301", title: "smoke instant doc" }));
      return;
    }
    // Regression fixture: an RPC-style creation endpoint (own path segment,
    // matching real backends like POST /api/things/from-template/:id)
    // whose 201 response ALSO echoes a client-supplied foreign key ending in
    // "_id" (template_id) alongside the new resource's own id. Exercises two
    // fixes at once: (1) the foreign id must not ride the 201/Location bypass
    // into ownership, and (2) a later plain CRUD path on the created
    // resource (/api/documents/:id) must still be recognized as owned even
    // though the creation URL doesn't share that prefix.
    if (urlPath === "/api/documents/from-template/5" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "199", template_id: "5", title: "smoke templated doc" }));
      return;
    }
    if (urlPath.startsWith("/api/documents/") && req.method === "PUT") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Extensionless /login, because the engine's auth heuristic matches a path
    // SEGMENT — "/login.html" is not a login route and would not exercise it.
    if (urlPath === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(appDir, "login.html")));
      return;
    }
    const file = path.join(appDir, urlPath === "/" ? "index.html" : urlPath);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-smoke-"));
  const engine = new BrowserEngine();

  try {
    console.log("attach + snapshot");
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });
    const snap1 = await engine.snapshot();
    check("snapshot lists interactables", /e\d+ button "Compute report"/.test(snap1), snap1);
    check("snapshot surfaces testids", snap1.includes("testid=widgets-crash-action"));
    check("snapshot marks destructive", /Delete all widgets.*DESTRUCTIVE/.test(snap1));
    check("snapshot reports NEW state", snap1.includes("(NEW state)"));
    check("snapshot counts missing testids", /missing data-testid/.test(snap1));

    const refOf = (label: string): string => {
      const m = snap1.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label} in:\n${snap1}`);
      return m[1];
    };

    console.log("geometry oracles");
    const overlapLines = snap1.match(/[^\n]*overlaps[^\n]*/g)?.join("\n") ?? "";
    check("real content overlap (same layer, not chrome) still flagged", /Save draft|Publish now/.test(overlapLines), overlapLines || "no overlaps");
    check("fixed-chrome overlap (Chrome A/B) suppressed as intended layering", !/Chrome A|Chrome B/.test(overlapLines), overlapLines || "no overlaps");
    check("off-screen element detected", /outside the reachable page area/.test(snap1), snap1);

    console.log("oracles: console/page error on click");
    const clickResult = await engine.click(refOf("Compute report"));
    check("console error captured", clickResult.includes("console_error"), clickResult);
    check("page error captured", clickResult.includes("page_error"), clickResult);

    console.log("diff snapshots + stable refs");
    const diff = await engine.snapshot();
    check("re-snapshot returns a diff, not a full list", diff.includes("No element changes") || diff.includes("DIFF vs"), diff);
    // Later actions keep using snap1's refs — only possible if refs survived the re-snapshot.

    console.log("read-only policy");
    const refusal = await engine.click(refOf("Delete all widgets"));
    check("destructive click refused", refusal.includes("REFUSED"), refusal);

    console.log("silent no-op detection");
    const noop = await engine.click(refOf("Save preferences"));
    check("zero-request submit click flagged", noop.includes("ZERO network requests"), noop);

    console.log("form interaction + http oracle");
    await engine.type(refOf("Email"), "qa@example.com");
    const submit = await engine.click(refOf("Send feedback"));
    check("404 API call captured", submit.includes("HTTP 404"), submit);

    console.log("native behaviours: append typing + hover reveal");
    const appendResult = await engine.type(refOf("Composer"), "tell me a joke");
    check("type appends to a prefilled field and reports prior content", appendResult.includes("APPENDED") && appendResult.includes("@skill/klingon"), appendResult);
    const replaceResult = await engine.type(refOf("Composer"), "fresh start", false, true);
    check(
      "replace=true overwrites and the appended value had actually landed",
      replaceResult.includes("replaced existing content") && replaceResult.includes("@skill/klingon tell me a joke"),
      replaceResult,
    );
    const clearResult = await engine.type(refOf("Composer"), "");
    check("empty textValue clears a prefilled field instead of appending a space", clearResult.includes('replaced existing content "fresh start"'), clearResult);
    const ceAppend = await engine.type(refOf("Notes editor"), "and more");
    check("contenteditable append preserves existing rich content", ceAppend.includes("APPENDED") && ceAppend.includes("Draft note"), ceAppend);
    const ceReplace = await engine.type(refOf("Notes editor"), "reset", false, true);
    check(
      "contenteditable caret landed at the end (append actually happened in the DOM)",
      ceReplace.includes('replaced existing content "Draft note and more"'),
      ceReplace,
    );
    const emailAppend = await engine.type(refOf("Draft email"), "com");
    check("selection-unsupported input appends without a separator and without throwing", emailAppend.includes("APPENDED") && emailAppend.includes("user@example."), emailAppend);
    const emailReplace = await engine.type(refOf("Draft email"), "z@y.io", false, true);
    check("email append concatenated cleanly", emailReplace.includes('replaced existing content "user@example.com"'), emailReplace);
    const hoverResult = await engine.hover(refOf("1 error"));
    check("hover reveals tooltip via overlay diff (no aria-describedby on this badge)", hoverResult.includes("Revealed on hover") && hoverResult.includes("agent node"), hoverResult);
    const hoverDescribed = await engine.hover(refOf("3 notices"));
    check("hover surfaces aria-describedby text", hoverDescribed.includes("Held for moderator approval"), hoverDescribed);
    const hoverFallback = await engine.hover(refOf("2 warnings"));
    check(
      "hover catches delay-gated tooltip with no tooltip markup (text-diff fallback)",
      hoverFallback.includes("Revealed on hover") && hoverFallback.includes("Missing connector"),
      hoverFallback,
    );
    const hoverNothing = await engine.hover(refOf("Untagged button"));
    check("hover on a plain element reports that nothing was revealed", hoverNothing.includes("reveals nothing on hover"), hoverNothing);

    console.log("read-only: form-submit and select bypass attempts");
    const enterAttempt = await engine.type(refOf("Type DELETE to confirm"), "DELETE", true);
    check(
      "type+Enter toward destructive submit refused",
      enterAttempt.includes("did NOT press Enter") && enterAttempt.includes("REFUSED"),
      enterAttempt,
    );
    const selAttempt = await engine.select(refOf("Bulk actions"), "delete-all");
    check("destructive select option refused", selAttempt.includes("REFUSED"), selAttempt);

    console.log("navigation oracle: broken page + stale refs");
    const preNavRef = refOf("Compute report");
    const nav = await engine.navigate("/broken.html");
    check("broken page HTTP 404 captured", nav.includes("HTTP 404"), nav);
    let staleErr = "";
    try {
      await engine.click(preNavRef);
    } catch (e) {
      staleErr = String(e);
    }
    check("stale ref rejected after navigation", /snapshot/i.test(staleErr), staleErr || "(no error thrown)");

    console.log("origin fence");
    const fence = await engine.navigate("https://example.com/");
    check("off-origin navigation refused", fence.includes("REFUSED") && fence.includes("fenced"), fence);

    console.log("memory persistence");
    const snap2 = await engine.snapshot();
    check("broken page is a NEW state with dead-end warning", snap2.includes("(NEW state)") && snap2.includes("DEAD END"), snap2);
    await engine.navigate("/");
    const snap3 = await engine.snapshot();
    check("home revisited (memory works)", snap3.includes("(revisited)"), snap3);
    check("exercised elements marked done", /Compute report.*done/.test(snap3), snap3);

    console.log("design audit (computed styles, no pixels)");
    await engine.navigate("/");
    const design = await engine.designAudit();
    check("contrast failure detected", design.includes("CONTRAST") && design.includes("design-low-contrast"), design);
    check("tiny target detected", design.includes("TINY") && design.includes("design-tiny-target"), design);
    check("clipped text detected", design.includes("CLIPPED") && design.includes("design-clipped"), design);

    console.log("task efficiency (journey cost + page-level ease heuristics)");
    check("form burden flagged when required fields aren't marked", design.includes("TASK EFFICIENCY") && /NONE marked required|only \d+ are required/.test(design), design);
    await engine.navigate("/");
    engine.startJourney("Submit feedback");
    const jSnap = await engine.snapshot(true);
    const jRef = (label: string): string => {
      const m = jSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engine.click(jRef("Untagged button"));
    await engine.navigate("/page2.html");
    await engine.navigate("/"); // deliberate backtrack — the friction signal under test
    const journey = engine.endJourney(true, "smoke");
    check("journey reports interaction cost", /Interaction cost: \d+ interactions/.test(journey), journey);
    check("journey reconstructs the path taken", journey.includes("Path:") && journey.includes("→"), journey);
    check("journey detects the deliberate backtrack as friction", /\d+ backtrack\(s\)/.test(journey), journey);
    check("journey flags direct-URL jumps as contaminating the measurement", journey.includes("direct-URL jump"), journey);
    const abandoned = engine.startJourney("Impossible task") && engine.endJourney(false);
    check("abandoned journey is called out as the strongest finding", abandoned.includes("TASK NOT COMPLETED"), abandoned);
    check("ending with no journey in progress is handled, not thrown", engine.endJourney(true).includes("No journey in progress"));

    console.log("design connoisseur tier (readability, palette, slop tells, affordances, layout)");
    check("over-long measure flagged with a char count", design.includes("READABILITY") && design.includes("craft-long-measure") && /characters per line/.test(design), design);
    check("cramped line-height flagged", /line-height 1\.1\d? is cramped/.test(design), design);
    check("justified text flagged", design.includes("craft-justified") && design.includes("rivers"), design);
    check("long ALL-CAPS flagged", design.includes("craft-uppercase"), design);
    check("pure #000 body text suggested against", design.includes("pure #000-on-#fff"), design);
    check("image aspect distortion detected", design.includes("craft-distorted-img") && /aspect off by \d+%/.test(design), design);
    check("side-stripe border tell detected", design.includes("AI-SLOP TELLS") && design.includes("side-stripe"), design);
    check("gradient text tell detected", design.includes("gradient text"), design);
    check("glassmorphism tell detected", design.includes("glassmorphism"), design);
    check("violet gradient tell detected", design.includes("violet/purple gradient"), design);
    check("neon glow tell detected", design.includes("neon glow"), design);
    check("elevation variety flagged", design.includes("distinct box-shadow styles"), design);
    check("missing keyboard focus indicator flagged on the seeded button", design.includes("craft-no-focus") && design.includes("NO visible focus indicator"), design);
    check("keyboard-focusing a default-styled control does NOT false-positive", !/NO visible focus indicator[^\n]*nav-home-link/.test(design), design);
    check("horizontal overflow reported as a responsive break", design.includes("scrolls horizontally"), design);
    check("screen-reader-only text is NOT reported as clipped", !/CLIPPED[\s\S]{0,400}sr-only-label/.test(design), design.match(/CLIPPED text[^\n]*(\n  [^\n]*)*/)?.[0] ?? "no clipped section");
    check("system summary always present", design.includes("SYSTEM SUMMARY:") && design.includes("spacing on 4px grid"), design);

    console.log("overlay/modal oracle (app modals, not native dialogs)");
    const ovSnap = await engine.snapshot(true);
    const ovRef = (label: string): string => {
      const m = ovSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engine.click(ovRef("Toggle broken modal"));
    const brokenSnap = await engine.snapshot(true);
    check("empty off-centre dialog over a grayed page is flagged", brokenSnap.includes("OVERLAY") && brokenSnap.includes("appears EMPTY"), brokenSnap.match(/OVERLAY[^\n]*/)?.[0] ?? brokenSnap.slice(0, 400));
    await engine.click(ovRef("Toggle broken modal"));
    await engine.click(ovRef("Toggle orphan backdrop"));
    const orphanSnap = await engine.snapshot(true);
    check("backdrop with NO dialog (user stuck on grayed page) is flagged", orphanSnap.includes("NO dialog content"), orphanSnap.match(/OVERLAY[^\n]*/)?.[0] ?? orphanSnap.slice(0, 400));
    await engine.click(ovRef("Toggle orphan backdrop"));
    const clearSnap = await engine.snapshot(true);
    check("overlay flags clear once the modal is closed", !clearSnap.includes("OVERLAY:"), clearSnap.match(/OVERLAY[^\n]*/)?.[0] ?? "clean");
    // A HEALTHY modal that carries its OWN dim backdrop (a full-viewport
    // [role=alertdialog] centring a real card) must NOT read as "backdrop with
    // no dialog" or "empty" — the classic confirm-dialog false positive.
    const wmSnap = await engine.snapshot(true);
    const wmRef = (label: string): string => {
      const m = wmSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engine.click(wmRef("Toggle wrapped modal"));
    const wrappedSnap = await engine.snapshot(true);
    check("a modal carrying its own backdrop is not misread as empty/contentless", !wrappedSnap.includes("NO dialog content") && !wrappedSnap.includes("appears EMPTY") && !wrappedSnap.includes("far off-centre"), wrappedSnap.match(/[^\n]*OVERLAY[^\n]*/g)?.join(" | ") ?? "clean");
    await engine.click(wmRef("Toggle wrapped modal")); // close so it can't leak into later snapshots

    console.log("page quality score");
    check("audit output carries a multi-indicator PAGE SCORE", /PAGE SCORE: \d+\/100 \([A-E]\) — a11y \d+ · craft \d+ · consistency \d+ · task-clarity \d+/.test(design), design.match(/PAGE SCORE[^\n]*/)?.[0] ?? design.slice(-300));
    const homeScore = engine.memory!.pageScores["/"];
    check("score persisted to memory per route", !!homeScore && homeScore.overall >= 0 && homeScore.overall <= 100, JSON.stringify(homeScore));

    console.log("scroll: user scrolling, lock oracle, clipped-ancestor unreachability");
    const preScrollSnap = await engine.snapshot(true);
    check("control clipped inside an overflow-hidden container flagged as UNREACHABLE", preScrollSnap.includes("UNREACHABLE") && preScrollSnap.includes("clip-unreachable"), preScrollSnap.match(/[^\n]*UNREACHABLE[^\n]*/)?.[0] ?? preScrollSnap.slice(0, 300));
    const scrollDown = await engine.scroll("bottom");
    check("scroll reports position and reaches the bottom", /Scroll position: \d+px of \d+px \(100%\) — at the bottom/.test(scrollDown), scrollDown);
    await engine.scroll("top");
    const sRef = (label: string): string => {
      const m = preScrollSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engine.click(sRef("Toggle scroll lock"));
    const lockedScroll = await engine.scroll("bottom");
    check("locked page flags SCROLL LOCKED with the unreachable content measured", lockedScroll.includes("SCROLL LOCKED"), lockedScroll);
    const lockedSnap = await engine.snapshot(true);
    check("snapshot passively detects the leaked scroll-lock as an OVERLAY issue", lockedSnap.includes("scrolling is DISABLED") && lockedSnap.includes("leaked modal scroll-lock"), lockedSnap.match(/[^\n]*DISABLED[^\n]*/)?.[0] ?? lockedSnap.slice(0, 300));
    await engine.click(sRef("Toggle scroll lock"));
    const unlockedScroll = await engine.scroll("bottom");
    check("unlocking restores scrolling", !unlockedScroll.includes("SCROLL LOCKED") && /at the bottom/.test(unlockedScroll), unlockedScroll);
    console.log("scroll: a named secondary region can be scrolled independently");
    const sideBefore = await engine.scroll("bottom", undefined, "testid=side-scroller");
    check("ft_scroll {target} scrolls that region, not the page's largest pane", /Scrolled .*side-scroller.*at its bottom/.test(sideBefore), sideBefore);
    const sideBack = await engine.scroll("top", undefined, "testid=side-scroller");
    check("the same region scrolls back to its top", /at its top/.test(sideBack), sideBack);
    const noScroll = await engine.scroll("bottom", undefined, "testid=nav-home-link");
    check("a target with no scrollable ancestor says so rather than lying", noScroll.includes("no scrollable ancestor"), noScroll);
    const missing = await engine.scroll("bottom", undefined, "testid=does-not-exist");
    check("a missing scroll target is refused, not silently ignored", missing.includes("Scroll target not found"), missing);

    check("out-of-flow escapes (fixed / absolute past a static wrapper) are NOT flagged UNREACHABLE", !/"(Fixed-escape action|Static-escape action)" is UNREACHABLE/.test(preScrollSnap), preScrollSnap.match(/[^\n]*UNREACHABLE[^\n]*/g)?.join(" | ") ?? "no UNREACHABLE lines");
    await engine.click(sRef("Toggle healthy modal"));
    const modalScroll = await engine.scroll("bottom");
    check("a role-less modal's scroll-lock is respected as healthy (no SCROLL LOCKED refusal)", !modalScroll.includes("SCROLL LOCKED"), modalScroll);
    const modalSnap = await engine.snapshot(true);
    check("no leaked-lock OVERLAY while the role-less modal is open", !modalSnap.includes("scrolling is DISABLED"), modalSnap.match(/[^\n]*OVERLAY[^\n]*/g)?.join(" | ") ?? "clean");
    const closeRef = modalSnap.match(/(e\d+) [a-z]+ "Close modal"/)?.[1];
    if (!closeRef) throw new Error("close ref not found");
    await engine.click(closeRef);
    await engine.scroll("top");
    const planScroll = await engine.runPlan([{ action: "scroll", value: "bottom" }, { action: "scroll", value: "top" }]);
    check("plans support scroll steps", planScroll.includes("2/2 steps ran"), planScroll);

    console.log("fixed-chrome share (synthetic — a fixture banner would intercept other tests' clicks)");
    const { analyzeDesign, DESIGN_COLLECT_SCRIPT } = await import("../dist/engine/design.js");
    const rawPayload = (await (engine as any).page.evaluate(DESIGN_COLLECT_SCRIPT)) as { records: Array<{ fixed: boolean }> };
    check("in-browser collector records position:sticky/fixed on real elements", rawPayload.records.some((r) => r.fixed), `fixed records: ${rawPayload.records.filter((r) => r.fixed).length}`);
    const mk = (over: Record<string, unknown>) => ({
      tag: "div", testid: null, text: "chrome", textLen: 6, interactive: false,
      rect: { x: 0, y: 0, w: 1280, h: 300 }, fontSize: 14, fontWeight: 400, fontFamily: "x",
      lineHeight: 20, textTransform: "", textAlign: "", underline: false,
      color: "rgba(20, 20, 20, 1)", bg: "rgb(255, 255, 255)", padding: [8, 8, 8, 8], marginV: [0, 0],
      radius: 0, shadow: "", clipped: false, fixed: false, required: false, submitish: false,
      sideStripe: false, gradientText: false, glass: false, glow: false, aiGradient: false, ...over,
    });
    const chromeResult = analyzeDesign(
      {
        records: [
          mk({ fixed: true, rect: { x: 0, y: 0, w: 1280, h: 180 } }),
          mk({ fixed: true, rect: { x: 0, y: 820, w: 1280, h: 80 } }),
          mk({ textLen: 200, text: "body", rect: { x: 0, y: 300, w: 600, h: 400 } }),
        ],
        page: { scrollW: 1280, clientW: 1280, headings: [{ level: 1, size: 24, text: "t" }], images: [], density: 1, focusSamples: [] },
      },
      { width: 1280, height: 900 },
    );
    check("fixed/sticky chrome eating >25% of the viewport is flagged", chromeResult.report.includes("fixed/sticky chrome occupies"), chromeResult.report.match(/[^\n]*chrome occupies[^\n]*/)?.[0] ?? chromeResult.report.slice(0, 400));

    console.log("finding dedup v2 (evidence + fuzzy title)");
    const [, fresh1] = engine.memory!.addFinding({
      severity: "medium", category: "http-error",
      title: "Dashboard calls /api/reports as User → 403",
      detail: "x", evidence: "GET /api/reports 403",
      url: engine.currentUrl, state: engine.currentState,
    });
    const [, fresh2] = engine.memory!.addFinding({
      severity: "medium", category: "console-error",
      title: "Reports dashboard endpoint returns 403 for User role on every load",
      detail: "y", evidence: "GET /api/reports 403",
      url: engine.currentUrl, state: engine.currentState,
    });
    check("evidence dedup catches rephrased finding", fresh1 && !fresh2);
    const [, fresh3] = engine.memory!.addFinding({
      severity: "medium", category: "http-error",
      title: "Dashboard calls /api/reports as a User and gets 403 errors",
      detail: "z",
      url: engine.currentUrl, state: engine.currentState,
    });
    check("fuzzy title dedup catches paraphrase without evidence", !fresh3);

    console.log("crawl (engine-side route sweep)");
    const crawlOut = await engine.crawl(["/page2.html", "/broken.html"]);
    check("crawl summarizes each route", crawlOut.includes("CRAWL of 2") && /page2\.html — 200/.test(crawlOut), crawlOut);
    check("crawl flags problem routes", crawlOut.includes("PROBLEM ROUTES") && crawlOut.includes("/broken.html"), crawlOut);

    console.log("run_plan (batched actions, semantic targets)");
    const plan1 = await engine.runPlan([
      { action: "navigate", target: "/" },
      { action: "click", target: "testid=widgets-crash-action" },
      { action: "click", target: "testid=plan-crash-action" },
      { action: "click", target: "testid=page2-noop-action" },
    ]);
    check("plan continues past REPEAT violations (crash already reported this session)", plan1.includes("2. click") && plan1.includes("3. click"), plan1);
    check("plan aborts on a FRESH oracle violation", plan1.includes("PLAN ABORTED") && plan1.includes("ForecastError"), plan1);
    check("plan did not run past the abort", !plan1.includes("4. click"), plan1);
    const plan2 = await engine.runPlan([{ action: "click", target: "testid=widgets-delete-action" }]);
    check("plan refuses destructive targets", plan2.includes("REFUSED"), plan2);
    const plan3 = await engine.runPlan([
      { action: "navigate", target: "/" },
      { action: "hover", target: "testid=native-error-badge" },
      { action: "type", target: "testid=native-editor", value: "plus" },
      { action: "type", target: "testid=native-editor", value: "done", replace: true },
    ]);
    check("plan hover uses the full reveal window and reports the tooltip", plan3.includes("hover revealed:") && plan3.includes("agent node"), plan3);
    check("plan type appends and threads replace through", plan3.includes("APPENDED") && plan3.includes('replaced existing content "Draft note plus"'), plan3);
    const plan4 = await engine.runPlan([
      { action: "click", target: "testid=danger-confirm-input" },
      { action: "press", value: "Tab" },
      { action: "press", value: "Enter" },
      { action: "navigate", target: "/page2.html" },
    ]);
    check("plan press vets the focused element (Enter on Delete account refused)", plan4.includes("REFUSED"), plan4);
    check("plan stopped at the refused press", !plan4.includes("4. navigate"), plan4);

    // Coverage must be recorded against the state the element LIVED IN. This
    // plan's click NAVIGATES, so the post-action page is a different state that
    // never listed the clicked link — marking there recorded nothing at all,
    // and the route stayed "visited but NOTHING exercised" however many plan
    // steps hit it.
    await engine.navigate("/index.html");
    const homeFp = (await engine.snapshot()).match(/State: (\S+)/)?.[1] ?? "";
    await engine.runPlan([
      { action: "navigate", target: "/index.html" },
      { action: "click", target: "testid=nav-broken-link" },
    ]);
    const homeState = engine.memory!.states[homeFp];
    const navExercised = homeState ? Object.entries(homeState.elements).some(([k, v]) => k.includes("nav-broken-link") && v.exercised) : false;
    check(
      "a plan click that navigates marks the link exercised on the page it was clicked FROM",
      navExercised,
      `state ${homeFp}: ${JSON.stringify(Object.entries(homeState?.elements ?? {}).filter(([k]) => k.includes("nav-")))}`,
    );

    console.log("snapshot diff: an attribute change is a change");
    await engine.navigate("/index.html");
    const gateSnap = await engine.snapshot(true);
    const gateToggleRef = gateSnap.match(/(e\d+) \w+ "[^"]*" \[testid=gate-toggle[,\]]/)?.[1] ?? "";
    check("the gated submit starts disabled", /e\d+ button "Confirm order" \[testid=gate-submit, disabled/.test(gateSnap), gateSnap.match(/[^\n]*gate-submit[^\n]*/)?.[0] ?? "");
    await engine.click(gateToggleRef);
    const afterGate = await engine.snapshot();
    // Nothing is added, removed or relabeled — only `disabled` flipped.
    check(
      "enabling a disabled control is reported, not swallowed as 'No element changes'",
      afterGate.includes("is now ENABLED") && !afterGate.includes("No element changes"),
      afterGate,
    );
    await engine.click(gateToggleRef);
    const afterUngate = await engine.snapshot();
    check("...and disabling it again is reported too", afterUngate.includes("is now DISABLED"), afterUngate);

    console.log("completion contract + link discovery");
    check("links harvested into route contract", engine.allKnownRoutes().includes("/broken.html"), JSON.stringify(engine.allKnownRoutes()));
    engine.knownRoutes = ["/zzz-never-visited"];
    check("unvisited tracks scanned + discovered union", engine.unvisitedKnownRoutes().includes("/zzz-never-visited"), JSON.stringify(engine.unvisitedKnownRoutes()));
    // A PERMISSION redirect satisfies the contract for the role that was
    // refused: a viewer who cannot see an admin page must not block the run.
    engine.memory!.markAttempted("/zzz-never-visited", "landed:/", engine.role);
    check("a permission redirect satisfies the contract", !engine.unvisitedKnownRoutes().includes("/zzz-never-visited"), JSON.stringify(engine.unvisitedKnownRoutes()));
    // ...but only for THAT role. Keyed by route alone, a low-privilege role
    // bouncing off an admin page erased it from the admin's ledger forever.
    const otherRole = engine.role;
    engine.role = "some-other-role";
    check("another role's redirect does not answer for this one", engine.unvisitedKnownRoutes().includes("/zzz-never-visited"), JSON.stringify(engine.unvisitedKnownRoutes()));
    engine.role = otherRole;
    // An AUTH-LOSS bounce must never satisfy it. A token expiring mid-run made
    // every later navigation land on /login; each was recorded as "attempted",
    // and the contract then certified the whole remaining route list as covered.
    engine.knownRoutes = ["/zzz-dead-session"];
    engine.memory!.markAttempted("/zzz-dead-session", "authloss:/login", engine.role);
    check(
      "an auth-loss bounce leaves the route outstanding",
      engine.unvisitedKnownRoutes().includes("/zzz-dead-session"),
      JSON.stringify(engine.unvisitedKnownRoutes()),
    );
    // /404 and /500 are static pages, not ids. Collapsing any numeric segment
    // made them the same route, so reaching one certified the other — on the
    // two routes a tester least wants silently skipped.
    engine.knownRoutes = ["/404", "/500"];
    check("static numeric routes are unvisited before they are reached", engine.unvisitedKnownRoutes().includes("/404"), JSON.stringify(engine.unvisitedKnownRoutes()));
    engine.memory!.visitState("/404#probe", `${baseUrl}/404`, "/404", []);
    check("visiting /404 covers /404", !engine.unvisitedKnownRoutes().includes("/404"), JSON.stringify(engine.unvisitedKnownRoutes()));
    check("...and does NOT also cover /500", engine.unvisitedKnownRoutes().includes("/500"), JSON.stringify(engine.unvisitedKnownRoutes()));
    engine.knownRoutes = [];
    check("design audits counted for the report gate", engine.designAuditCount >= 1, String(engine.designAuditCount));

    console.log("i18n destructive policy");
    const { isDestructive } = await import("../dist/engine/policy.js");
    check("multilingual destructive labels blocked", isDestructive("Löschen") && isDestructive("Excluir conta") && isDestructive("削除") && !isDestructive("Los geht's"));

    console.log("findings + report");
    const [finding, isNew] = engine.memory!.addFinding({
      severity: "high",
      category: "console-error",
      title: "Compute report crashes with TypeError",
      detail: "Clicking 'Compute report' throws an uncaught TypeError and shows no result.",
      url: engine.currentUrl,
      state: engine.currentState,
    });
    check("finding recorded", isNew && finding.repro.length > 0);
    const [, isNew2] = engine.memory!.addFinding({
      severity: "high",
      category: "console-error",
      title: "Compute report crashes with TypeError",
      detail: "dup",
      url: engine.currentUrl,
      state: engine.currentState,
    });
    check("finding dedup works", !isNew2);

    const { markdown, path: reportPath } = generateReport(engine.memory!, engine.oracleLog.all);
    check("report written", fs.existsSync(reportPath));
    check("report contains finding", markdown.includes("Compute report crashes"));
    check("report contains playwright skeleton", markdown.includes('test("regression:'));
    check("report lists unexplored surface", markdown.includes("Unexplored surface"));

    console.log("write policy: read-only blocks foreign mutations at the network layer");
    await engine.navigate("/");
    const roSnap = await engine.snapshot(true);
    const roRefOf = (label: string): string => {
      const m = roSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    const roBlocked = await engine.click(roRefOf("Sync foreign item"));
    check("read-only blocks DELETE despite harmless label", roBlocked.includes("WRITE-POLICY blocked") && roBlocked.includes("DELETE"), roBlocked);

    console.log("resilient click: forces past a real hit-test interception, not past a disabled control");
    // "Fake switch" is a <span> thumb painted over a visually-hidden <input>,
    // both under a <label for=...> — a real click on the thumb natively
    // forwards to the input, but Playwright's own actionability check sees
    // the span intercepting the input's hit-test point and times out. This
    // is the exact false-"unclickable" bug the resilientClick fallback
    // exists to fix — regression test for that fix.
    const switchRef = roRefOf("Fake switch");
    const switchClick = await engine.click(switchRef);
    check("forced click on the intercepted switch still reports success", switchClick.startsWith("OK: click"), switchClick);
    check("forced-click note explains the fallback was used", switchClick.includes("forced click was used instead"), switchClick);
    // White-box: reach into the private `page` field rather than growing the
    // public API just to verify this regression.
    const switchChecked = await (engine as unknown as { page: import("playwright").Page }).page
      .locator("#fake-switch")
      .isChecked();
    check("the forced click actually toggled the input (native label-forwarding)", switchChecked === true);

    // "Locked action" is a genuinely disabled <button> — force MUST NOT
    // paper over a real actionability failure, or a truly dead control
    // would be reported as successfully clicked.
    await engine.navigate("/");
    const roSnap2 = await engine.snapshot(true);
    const lockedRef = roSnap2.match(/(e\d+) button "Locked action"/)?.[1];
    if (!lockedRef) throw new Error(`ref not found for Locked action in:\n${roSnap2}`);
    const lockedResult = await engine.click(lockedRef).then(
      (r) => ({ threw: false, message: r }),
      (err: unknown) => ({ threw: true, message: err instanceof Error ? err.message : String(err) }),
    );
    check("click on a disabled control still fails (not forced through)", lockedResult.threw, lockedResult.message);
    check("failure names the real reason, not a generic timeout", /is not enabled/i.test(lockedResult.message), lockedResult.message);

    console.log("memory survives a new engine (cross-run persistence)");
    await engine.close();
    const engine2 = new BrowserEngine();
    await engine2.attach({ url: baseUrl, projectDir, mode: "read-only" });
    const snap4 = await engine2.snapshot();
    check("second run sees prior coverage", snap4.includes("(revisited)"), snap4);

    console.log("write policy: safe-write allows create + own-resource mutations only");
    await engine2.attach({ url: baseUrl, projectDir, mode: "safe-write" });
    const swSnap = await engine2.snapshot(true);
    const swRefOf = (label: string): string => {
      const m = swSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engine2.click(swRefOf("Create item"));
    await until("item creation to register", () => engine2.createdResources.some((r) => r.includes("/api/items") && r.includes("id=42")));
    check("creation tracked with id + collection", engine2.createdResources.some((r) => r.includes("/api/items") && r.includes("id=42")), JSON.stringify(engine2.createdResources));
    const ownResult = await engine2.click(swRefOf("Sync own item"));
    check("PUT on own resource allowed", !ownResult.includes("WRITE-POLICY blocked"), ownResult);
    await engine2.click(swRefOf("Create document"));
    await until("document creation to register", () => engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=99")));
    check(
      "creation tracked when the response names its id after the resource (document_id, not id)",
      engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=99")),
      JSON.stringify(engine2.createdResources),
    );
    const ownDocResult = await engine2.click(swRefOf("Sync own document"));
    check("PUT on own document (owned via document_id) allowed", !ownDocResult.includes("WRITE-POLICY blocked"), ownDocResult);
    await engine2.click(swRefOf("Create quick document"));
    await until("quick-document creation to register", () => engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=250")));
    check(
      "own id tracked (document_id) even when an unrelated server-derived foreign key (owner_id) rides along",
      engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=250")),
      JSON.stringify(engine2.createdResources),
    );
    check(
      "server-derived foreign key (owner_id=3, never echoed anywhere) is NOT claimed as owned",
      !engine2.createdResources.some((r) => r.includes("id=3")),
      JSON.stringify(engine2.createdResources),
    );
    await engine2.click(swRefOf("Create document from template"));
    await until("templated-document creation to register", () => engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=199")));
    check(
      "own id tracked even when a foreign key rides along in the same 201 response",
      engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=199")),
      JSON.stringify(engine2.createdResources),
    );
    check(
      "foreign key echoed in the request body (template_id=5) is NOT claimed as owned, despite the 201",
      !engine2.createdResources.some((r) => r.includes("id=5")),
      JSON.stringify(engine2.createdResources),
    );
    const ownTmplDocResult = await engine2.click(swRefOf("Sync templated document"));
    check(
      "PUT on the plain resource path (/api/documents/199) allowed even though creation went through an RPC-style action URL (/api/documents/from-template/5)",
      !ownTmplDocResult.includes("WRITE-POLICY blocked"),
      ownTmplDocResult,
    );
    await engine2.click(swRefOf("Create and save document"));
    // The create half of the chain registers id=301; waiting for that means the
    // PUT that follows it has had its ownership question answered.
    await until("the create+save chain to register its id", () => engine2.createdResources.some((r) => r.includes("id=301")));
    const raceSnap = await engine2.snapshot(true);
    check(
      "create-then-immediately-PUT chained in one click (no artificial delay) is not wrongly blocked by the ownership-registration race",
      raceSnap.includes("create+save 200"),
      raceSnap.match(/[^\n]*wp-result-label[^\n]*/)?.[0] ?? raceSnap,
    );
    console.log("impatient-user probe (double-submit)");
    const dblUnguarded = await engine2.click(swRefOf("Create item"), 2);
    check("unguarded submit fires duplicate requests on rapid double-click and is flagged", dblUnguarded.includes("DOUBLE-SUBMIT SIGNAL"), dblUnguarded);
    const dblGuarded = await engine2.click(swRefOf("Guarded create"), 2);
    check("self-disabling submit fires once and is reported as guarded", dblGuarded.includes("double-submit appears guarded"), dblGuarded);

    const foreignResult = await engine2.click(swRefOf("Sync foreign item"));
    check("DELETE on foreign resource blocked in safe-write", foreignResult.includes("WRITE-POLICY blocked"), foreignResult);
    const delOwn = await engine2.click(swRefOf("Delete all widgets"));
    check("safe-write does NOT label-block (network layer owns policy)", !delOwn.includes("REFUSED by read-only policy"), delOwn);
    await engine2.click(swRefOf("Sync existing item"));
    // Asserting a NEGATIVE (the upsert's echoed id must never be claimed), so
    // there is no positive condition to poll for — the id legitimately never
    // appears. A bounded settle is the honest tool here; `until` would just be
    // a fixed delay wearing a poll's clothes.
    await settle(300);
    check("upsert-echoed id is not claimed as owned", !engine2.createdResources.some((r) => r.includes("id=7")), JSON.stringify(engine2.createdResources));
    const foreignAfterUpsert = await engine2.click(swRefOf("Sync foreign item"));
    check("upsert-echoed id does not grant ownership (DELETE still blocked)", foreignAfterUpsert.includes("WRITE-POLICY blocked"), foreignAfterUpsert);

    console.log("uploads: file inputs get files, not text");
    const refByTestid = (snap: string, testid: string): string => {
      const m = snap.match(new RegExp(`(e\\d+) [a-z]+ "[^"]*" \\[testid=${testid}[,\\]]`));
      if (!m) throw new Error(`ref not found for testid ${testid}`);
      return m[1];
    };
    await engine2.navigate("/index.html");
    const upSnap = await engine2.snapshot(true);
    check(
      "a file input is listed with its own role, not as a textbox",
      /e\d+ file "Attachment" \[testid=upload-attachment-input/.test(upSnap),
      upSnap.match(/[^\n]*upload-attachment-input[^\n]*/)?.[0] ?? upSnap,
    );
    const attachmentRef = refByTestid(upSnap, "upload-attachment-input");
    const typedIntoFile = await engine2.type(attachmentRef, "not a file");
    check("typing into a file input is redirected to ft_upload instead of throwing", typedIntoFile.includes("ft_upload"), typedIntoFile);
    const direct = await engine2.upload({ ref: attachmentRef });
    check(
      "a visible file input takes a generated fixture, kind inferred from accept=.pdf",
      direct.includes("OK: upload") && direct.includes("scenescout-fixture.pdf") && direct.includes("inferred from accept"),
      direct,
    );
    check("selection without a request says the form still needs its submit", direct.includes("click it next"), direct);
    await engine2.click(refByTestid(upSnap, "upload-submit-action"));
    await until("the multipart upload to land", () => uploadLog.some((u) => u.filename === "scenescout-fixture.pdf"));
    check(
      "the uploaded bytes reached the server as a real PDF (multipart body carried %PDF-)",
      uploadLog.some((u) => u.filename === "scenescout-fixture.pdf" && u.sawPdf),
      JSON.stringify(uploadLog),
    );
    check(
      "an upload counts as filling the form (the gap ledger's rule sees it)",
      Object.values(engine2.memory!.states).some((st) => Object.values(st.elements).some((e) => e.lastAction === "upload")),
    );
    const mismatch = await engine2.upload({ ref: attachmentRef, fixture: "txt", name: "notes.txt" });
    check("a file that violates the input's accept attribute is called out", mismatch.includes("does NOT match"), mismatch);
    const escaped = await engine2.upload({ ref: attachmentRef, filePath: "../../../../etc/hosts" });
    check("filePath outside the attached project is refused (fenced like the origin)", escaped.startsWith("REFUSED"), escaped);
    // The other way out of the fence: a path INSIDE the project that is a
    // symlink to a file outside it. Only realpath catches this.
    fs.symlinkSync("/etc/hosts", path.join(projectDir, "escape-link"));
    const viaSymlink = await engine2.upload({ ref: attachmentRef, filePath: "escape-link" });
    check("a symlink inside the project pointing outside it is refused too", viaSymlink.startsWith("REFUSED"), viaSymlink);
    fs.writeFileSync(path.join(projectDir, "real-fixture.csv"), "a,b\n1,2\n");
    const fromDisk = await engine2.upload({ ref: attachmentRef, filePath: "real-fixture.csv" });
    check("a file inside the project uploads from disk", fromDisk.includes("OK: upload") && fromDisk.includes("from disk: real-fixture.csv"), fromDisk);
    const renamed = await engine2.upload({ ref: attachmentRef, filePath: "real-fixture.csv", name: "renamed.csv" });
    check("a disk file can be uploaded under another name", renamed.includes("as renamed.csv"), renamed);
    await engine2.click(refByTestid(upSnap, "upload-submit-action"));
    await until("the renamed upload to land", () => uploadLog.some((u) => u.filename === "renamed.csv"));
    check("…and the server receives the override name, not the disk name", uploadLog.some((u) => u.filename === "renamed.csv"), JSON.stringify(uploadLog));
    const both = await engine2.upload({ ref: attachmentRef, filePath: "real-fixture.csv", fixture: "pdf" });
    check("filePath and fixture together are refused rather than one silently winning", both.includes("not both"), both);
    // A refused disk path must be refused BEFORE the trigger is clicked: the
    // click is the app's own control (state-changing in safe-write) and would
    // leave an intercepted chooser hanging. "Create item" fires a POST on
    // click, so a request in the log would prove the click happened.
    const itemPostsBefore = itemPosts;
    const refusedBeforeClick = await engine2.upload({ ref: refByTestid(upSnap, "wp-create-item"), filePath: "no-such-file.pdf" });
    // Asserting an ABSENCE (no click, so no POST) — nothing to poll for.
    await settle(300);
    check(
      "a bad filePath is refused without clicking the trigger first",
      refusedBeforeClick.includes("not found") && itemPosts === itemPostsBefore,
      `${refusedBeforeClick}\nPOST /api/items count: ${itemPostsBefore} → ${itemPosts}`,
    );
    const ambiguous = await engine2.upload({ fixture: "pdf" });
    check(
      "with no ref on a page with several file inputs, the refusal names them instead of guessing",
      ambiguous.includes("file inputs on this page") && ambiguous.includes("upload-attachment-input") && ambiguous.includes("upload-logo-input"),
      ambiguous,
    );
    const noChooserAmbiguous = await engine2.upload({ ref: refByTestid(upSnap, "widgets-save-noop") });
    check(
      "a control that opens no chooser on a page with several file inputs is refused with the candidates listed",
      noChooserAmbiguous.includes("opened no file chooser") && noChooserAmbiguous.includes("upload-logo-input"),
      noChooserAmbiguous,
    );
    const locked = await engine2.upload({ ref: refByTestid(upSnap, "upload-locked-input") });
    check("a disabled file input is refused, not reported as uploaded", locked.includes("is disabled") && !locked.includes("OK: upload"), locked);

    await engine2.navigate("/page2.html");
    const hiddenSnap = await engine2.snapshot(true);
    check(
      "a hidden file input is disclosed on a FILE INPUTS line instead of vanishing",
      hiddenSnap.includes("FILE INPUTS") && hiddenSnap.includes("upload-avatar-input") && hiddenSnap.includes("accept=image/*"),
      hiddenSnap,
    );
    const viaChooser = await engine2.upload({ ref: refByTestid(hiddenSnap, "upload-avatar-trigger") });
    check("a styled trigger routes the file through the chooser it opens", viaChooser.includes("via the file chooser"), viaChooser);
    check("accept=image/* picked a PNG fixture", viaChooser.includes("scenescout-fixture.png"), viaChooser);
    await until("the upload-on-select request", () => uploadLog.some((u) => u.filename === "scenescout-fixture.png"));
    check("upload-on-select carried real PNG bytes", uploadLog.some((u) => u.filename === "scenescout-fixture.png" && u.sawPng), JSON.stringify(uploadLog));
    check("an app that uploads on selection is reported as such", viaChooser.includes("sent a request on selection"), viaChooser);
    const noRef = await engine2.upload({ fixture: "png", name: "avatar-2.png" });
    check("with no ref, the page's only (hidden) file input is targeted directly", noRef.includes("OK: upload") && noRef.includes("only file input"), noRef);
    await until("the ref-less upload to land", () => uploadLog.some((u) => u.filename === "avatar-2.png"));
    // A REPEAT upload to the same endpoint: the mutation report dedups per
    // endpoint, so reading the verdict out of that text said "no request
    // fired" the second time. The verdict must come from the request log.
    check("a repeat upload to an already-reported endpoint is still reported as sent on selection", noRef.includes("sent a request on selection"), noRef);
    const noChooserSingle = await engine2.upload({ ref: refByTestid(hiddenSnap, "page2-noop-action"), fixture: "png", name: "avatar-3.png" });
    check(
      "a control that opens no chooser falls back to the page's only file input, and says so",
      noChooserSingle.includes("opened no file chooser, so the file was set on the page's only file input"),
      noChooserSingle,
    );
    await until("the fallback upload to land", () => uploadLog.some((u) => u.filename === "avatar-3.png"));

    const uploadPlan = await engine2.runPlan([
      { action: "navigate", target: "/index.html" },
      { action: "upload", target: "testid=upload-attachment-input", value: "pdf" },
      { action: "click", target: "testid=upload-submit-action" },
    ]);
    check("plans support upload steps", /2\. upload testid=upload-attachment-input → OK/.test(uploadPlan), uploadPlan);
    await until("the plan's upload to land", () => uploadLog.filter((u) => u.filename === "scenescout-fixture.pdf").length >= 2);
    const typePlan = await engine2.runPlan([{ action: "type", target: "testid=upload-attachment-input", value: "x" }]);
    check("a plan type step on a file input points at the upload step", typePlan.includes("FAILED") && typePlan.includes('{action:"upload"}'), typePlan);
    await engine2.close();

    console.log("assumptions — cumulative written knowledge");
    const noted = engine2.memory!.addAssumption("roles", "qa-role reviews and approves quality records; cannot administer users", "smoke");
    check("assumption recorded", noted === true);
    check("duplicate assumption rejected", engine2.memory!.addAssumption("roles", "qa-role reviews and approves quality records; cannot administer users", "smoke") === false);
    check("assumptions read back as prose", engine2.memory!.readAssumptions().includes("qa-role reviews and approves"), engine2.memory!.readAssumptions().slice(0, 300));

    console.log("multi-session: two engines, two live browsers, ONE shared memory (multi-role collaboration)");
    const { MemoryStore } = await import("../dist/engine/memory.js");
    const sharedStore = new MemoryStore(projectDir);
    const engA = new BrowserEngine();
    const engB = new BrowserEngine();
    await engA.attach({ url: baseUrl, projectDir, mode: "read-only", memoryStore: sharedStore });
    await engB.attach({ url: baseUrl, projectDir, mode: "read-only", memoryStore: sharedStore });
    engA.role = "role-alpha";
    engB.role = "role-beta";
    await engA.navigate("/");
    await engA.snapshot();
    await engB.navigate("/page2.html");
    await engB.snapshot();
    check(
      "both sessions live at once on different pages",
      engA.attached && engB.attached && engA.currentUrl !== engB.currentUrl,
      `${engA.currentUrl} vs ${engB.currentUrl}`,
    );
    check("sessions share one memory instance (no write races, findings merge)", engA.memory === engB.memory);
    const [sharedFinding] = sharedStore.addFinding({
      severity: "low", category: "other", title: "multi-session shared-memory probe",
      detail: "d", url: engA.currentUrl, state: "/multi#probe",
    });
    check("finding recorded via one role is visible to the other", engB.memory!.findings.some((f) => f.id === sharedFinding.id));
    // Concurrency: two sessions' work must OVERLAP in time, not queue. Each
    // navigate is a real round-trip; if the server serialized every call
    // globally (the pre-0.9 behaviour) the elapsed time would be ~the sum of
    // both, and the interleave markers below would come out strictly ordered.
    const order: string[] = [];
    const startedAt = Date.now();
    const [msA, msB] = await Promise.all([
      (async () => {
        const t = Date.now();
        order.push("A:start");
        await engA.navigate("/page2.html");
        order.push("A:end");
        return Date.now() - t;
      })(),
      (async () => {
        const t = Date.now();
        order.push("B:start");
        await engB.navigate("/");
        order.push("B:end");
        return Date.now() - t;
      })(),
    ]);
    const wall = Date.now() - startedAt;
    check(
      "two sessions' navigations overlap in wall-clock (concurrent, not queued)",
      wall < msA + msB,
      `wall=${wall}ms vs sum=${msA + msB}ms (A=${msA}, B=${msB})`,
    );
    check(
      "both sessions started before either finished (true interleave)",
      order.indexOf("A:start") < order.indexOf("B:end") && order.indexOf("B:start") < order.indexOf("A:end"),
      order.join(" → "),
    );
    check("each session kept its own page after concurrent navigation", engA.currentUrl.includes("page2") && !engB.currentUrl.includes("page2"), `${engA.currentUrl} vs ${engB.currentUrl}`);

    // Journey isolation: the action log is SHARED across sessions, so a journey
    // measured in one role must not absorb a concurrent role's navigations —
    // that would inflate its path, screen count, and backtracks with another
    // person's clicks.
    engA.sessionKey = "alpha";
    engB.sessionKey = "beta";
    await engA.navigate("/");
    engA.startJourney("Alpha's task");
    await engB.navigate("/page2.html"); // concurrent OTHER session — must not count
    await engB.navigate("/");
    await engA.navigate("/broken.html"); // alpha's single real step
    const isoJourney = engA.endJourney(true, "iso");
    check("journey counts only its own session's navigations, not a concurrent role's", /· 1 navigations ·/.test(isoJourney), isoJourney);
    check("a concurrent session's screens don't leak into the journey path", !isoJourney.includes("page2"), isoJourney);

    // Cross-session ownership: role A creates, role B must be able to act on
    // it. Ownership lives on the shared MemoryStore precisely because
    // "submit → approve" handoffs are the point of multi-role testing; if it
    // were per-engine, every handoff would be blocked as "not yours".
    const shareStore = new MemoryStore(projectDir);
    const engC = new BrowserEngine();
    const engD = new BrowserEngine();
    await engC.attach({ url: baseUrl, projectDir, mode: "safe-write", memoryStore: shareStore });
    await engD.attach({ url: baseUrl, projectDir, mode: "safe-write", memoryStore: shareStore });
    const cSnap = await engC.snapshot(true);
    const refIn = (snap: string, label: string): string => {
      const m = snap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engC.click(refIn(cSnap, "Create item")); // role C creates /api/items/42
    await until("role C's creation to reach the shared ownership set", () => engD.createdResources.some((r) => r.includes("id=42")));
    check("creation by role C is visible in the shared run ownership", engD.createdResources.some((r) => r.includes("id=42")), JSON.stringify(engD.createdResources));
    const dSnap = await engD.snapshot(true);
    const dResult = await engD.click(refIn(dSnap, "Sync own item")); // role D mutates C's resource
    check(
      "role D may mutate a resource role C created (multi-role handoff not blocked)",
      !dResult.includes("WRITE-POLICY blocked"),
      dResult,
    );
    const dForeign = await engD.click(refIn(dSnap, "Sync foreign item"));
    check("foreign resources are still blocked for both roles", dForeign.includes("WRITE-POLICY blocked"), dForeign);
    await engC.close();
    await engD.close();

    console.log("role capability matrix + gap ledger + bounded report summary");
    check("role access recorded per role", Object.keys(sharedStore.roleAccess).includes("role-alpha") && Object.keys(sharedStore.roleAccess).includes("role-beta"), JSON.stringify(sharedStore.roleAccess));
    const multiReport = generateReport(sharedStore, [], { routesVisited: 2, routesTotal: 2, designAudits: 0 });
    check("report renders the role capability matrix when ≥2 roles ran", multiReport.markdown.includes("Role capability matrix"), multiReport.markdown.match(/Role capability matrix[^\n]*/)?.[0] ?? "missing");
    check("gap ledger enumerates what was NOT tested", multiReport.markdown.includes("Gap ledger") && multiReport.markdown.includes("never design-audited"), multiReport.markdown.match(/## Gap ledger[\s\S]{0,300}/)?.[0] ?? "missing");
    check("tool-facing summary is bounded (full reports blew client token limits)", multiReport.summary.length < 4000 && multiReport.summary.includes("Gap ledger"), `summary length ${multiReport.summary.length}`);

    console.log("report honesty: stale scores flagged, one-role routes kept out of the permission matrix");
    {
      const { MemoryStore: MS } = await import("../dist/engine/memory.js");
      const repDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-report-"));
      const rs = new MS(repDir);
      // A score written BEFORE this session (a previous run's measurement) must
      // not silently rank as if it were re-measured today.
      rs.setPageScore("/stale-page", { overall: 40, a11y: 40, craft: 40, consistency: 40, clarity: 40, at: "2020-01-01T00:00:00.000Z", url: "http://x/stale-page" });
      rs.setPageScore("/fresh-page", { overall: 90, a11y: 90, craft: 90, consistency: 90, clarity: 90, at: new Date().toISOString(), url: "http://x/fresh-page" });
      // alpha and beta both tried /shared and diverged — a real boundary.
      // Only alpha ever tried /alpha-only — that is coverage, not permission.
      rs.recordRoleAccess("alpha", "/shared", "reached");
      rs.recordRoleAccess("beta", "/shared", "landed:/login");
      rs.recordRoleAccess("alpha", "/alpha-only", "reached");
      const rep = generateReport(rs, [], { routesVisited: 2, routesTotal: 2, designAudits: 1 });
      check("a score carried over from an earlier run is marked stale", /\/stale-page[^\n]*stale/.test(rep.markdown), rep.markdown.match(/\|[^\n]*stale-page[^\n]*/)?.[0] ?? "no row");
      check("a score measured this session is NOT marked stale", !/\/fresh-page[^\n]*stale/.test(rep.markdown), rep.markdown.match(/\|[^\n]*fresh-page[^\n]*/)?.[0] ?? "no row");
      check("a genuinely divergent route stays in the permission matrix", /\|\s*`\/shared`/.test(rep.markdown), rep.markdown.match(/\|[^\n]*\/shared[^\n]*/)?.[0] ?? "missing");
      check("a route only ONE role visited is excluded (coverage gap, not a denial)", !/\|\s*`\/alpha-only`/.test(rep.markdown), rep.markdown.match(/\|[^\n]*alpha-only[^\n]*/)?.[0] ?? "correctly absent");
      check("the omission is disclosed rather than silent", rep.markdown.includes("visited by only ONE role"), rep.markdown.match(/[^\n]*only ONE role[^\n]*/)?.[0] ?? "not disclosed");
      fs.rmSync(repDir, { recursive: true, force: true });
    }

    await engA.close();
    check("closing one session leaves the other alive", engB.attached && !engA.attached);
    await engB.close();

    // ---- Auth loss, driven through a real browser -------------------------
    // Everything below was previously only reachable by hand-writing outcome
    // strings into the store, which cannot pin the DETECTION half: the login
    // heuristic, the settle-before-reading-URL ordering, the warning lines, or
    // the streak. /gated.html redirects client-side AFTER hydration, so a
    // revert of the settle reorder fails these rather than passing quietly.
    console.log("auth loss: detection, reporting, and non-coverage");
    const deadAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-deadauth-"));
    const deadState = path.join(deadAuthDir, "expired-fixture.json");
    fs.writeFileSync(deadState, JSON.stringify({ cookies: [], origins: [] }));
    const authProject = fs.mkdtempSync(path.join(os.tmpdir(), "ft-authproj-"));
    const engDead = new BrowserEngine();
    try {
      const attachOut = await engDead.attach({
        url: `${baseUrl}/gated.html`,
        projectDir: authProject,
        mode: "read-only",
        storageStatePath: deadState,
      });
      check("attach detects a storage state that did not sign in", attachOut.includes("AUTH FAILED"), attachOut);
      check("...and names the file to regenerate", attachOut.includes("expired-fixture.json"), attachOut);

      // Absolute URLs: this engine attached AT /gated.html, so its baseUrl
      // carries that path and a relative target would concatenate onto it.
      engDead.knownRoutes = ["/gated.html"];
      const nav1 = await engDead.navigate(`${baseUrl}/gated.html`);
      check("a post-hydration bounce is detected at all", nav1.includes("REDIRECTED"), nav1);
      check("...and is called out as a login page, not a plain redirect", nav1.includes("NOT counted as covered"), nav1);
      check(
        "a bounced route stays in the completion contract",
        engDead.unvisitedKnownRoutes().includes("/gated.html"),
        JSON.stringify(engDead.unvisitedKnownRoutes()),
      );

      const nav2 = await engDead.navigate(`${baseUrl}/gated.html`);
      check("two bounces is not yet a verdict", !nav2.includes("SESSION AUTH LOST"), nav2);
      const nav3 = await engDead.navigate(`${baseUrl}/gated.html`);
      check("three consecutive bounces raises SESSION AUTH LOST", nav3.includes("SESSION AUTH LOST"), nav3);

      // Asking for the login page ON PURPOSE is the anonymous auth-surface
      // pass, not a symptom — it must neither warn nor feed the streak.
      const navLogin = await engDead.navigate(`${baseUrl}/login`);
      check("navigating to /login deliberately is not a bounce", !navLogin.includes("REDIRECTED"), navLogin);
    } finally {
      await engDead.close().catch(() => {});
      fs.rmSync(deadAuthDir, { recursive: true, force: true });
      fs.rmSync(authProject, { recursive: true, force: true });
    }
  } finally {
    await engine.close().catch(() => {});
    server.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nSMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nSMOKE PASSED");
}

main().catch((err) => {
  console.error("SMOKE CRASHED:", err);
  process.exit(1);
});
