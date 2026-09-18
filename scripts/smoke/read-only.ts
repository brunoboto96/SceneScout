/**
 * Read-only exploration: snapshots, oracles, policy refusals, design audit, scroll, crawl, plans, the completion contract, findings and the report.
 */
import fs from "node:fs";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { generateReport } from "../../dist/engine/report.js";
import { check, settle, type SmokeContext } from "./harness.ts";

export const title = "read-only exploration";

export async function run({ baseUrl, projectDir, stats }: SmokeContext): Promise<void> {
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
    check(
      "type appends to a prefilled field and reports prior content",
      appendResult.includes("APPENDED") && appendResult.includes("@skill/klingon"),
      appendResult,
    );
    const replaceResult = await engine.type(refOf("Composer"), "fresh start", false, true);
    check(
      "replace=true overwrites and the appended value had actually landed",
      replaceResult.includes("replaced existing content") && replaceResult.includes("@skill/klingon tell me a joke"),
      replaceResult,
    );
    const clearResult = await engine.type(refOf("Composer"), "");
    check(
      "empty textValue clears a prefilled field instead of appending a space",
      clearResult.includes('replaced existing content "fresh start"'),
      clearResult,
    );
    const ceAppend = await engine.type(refOf("Notes editor"), "and more");
    check("contenteditable append preserves existing rich content", ceAppend.includes("APPENDED") && ceAppend.includes("Draft note"), ceAppend);
    const ceReplace = await engine.type(refOf("Notes editor"), "reset", false, true);
    check(
      "contenteditable caret landed at the end (append actually happened in the DOM)",
      ceReplace.includes('replaced existing content "Draft note and more"'),
      ceReplace,
    );
    const emailAppend = await engine.type(refOf("Draft email"), "com");
    check(
      "selection-unsupported input appends without a separator and without throwing",
      emailAppend.includes("APPENDED") && emailAppend.includes("user@example."),
      emailAppend,
    );
    const emailReplace = await engine.type(refOf("Draft email"), "z@y.test", false, true);
    check("email append concatenated cleanly", emailReplace.includes('replaced existing content "user@example.com"'), emailReplace);
    const hoverResult = await engine.hover(refOf("1 error"));
    check(
      "hover reveals tooltip via overlay diff (no aria-describedby on this badge)",
      hoverResult.includes("Revealed on hover") && hoverResult.includes("agent node"),
      hoverResult,
    );
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
    check("type+Enter toward destructive submit refused", enterAttempt.includes("did NOT press Enter") && enterAttempt.includes("REFUSED"), enterAttempt);
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
    check(
      "form burden flagged when required fields aren't marked",
      design.includes("TASK EFFICIENCY") && /NONE marked required|only \d+ are required/.test(design),
      design,
    );
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
    check(
      "over-long measure flagged with a char count",
      design.includes("READABILITY") && design.includes("craft-long-measure") && /characters per line/.test(design),
      design,
    );
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
    check(
      "missing keyboard focus indicator flagged on the seeded button",
      design.includes("craft-no-focus") && design.includes("NO visible focus indicator"),
      design,
    );
    check("keyboard-focusing a default-styled control does NOT false-positive", !/NO visible focus indicator[^\n]*nav-home-link/.test(design), design);
    check("horizontal overflow reported as a responsive break", design.includes("scrolls horizontally"), design);
    check(
      "screen-reader-only text is NOT reported as clipped",
      !/CLIPPED[\s\S]{0,400}sr-only-label/.test(design),
      design.match(/CLIPPED text[^\n]*(\n  [^\n]*)*/)?.[0] ?? "no clipped section",
    );
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
    check(
      "empty off-centre dialog over a grayed page is flagged",
      brokenSnap.includes("OVERLAY") && brokenSnap.includes("appears EMPTY"),
      brokenSnap.match(/OVERLAY[^\n]*/)?.[0] ?? brokenSnap.slice(0, 400),
    );
    await engine.click(ovRef("Toggle broken modal"));
    await engine.click(ovRef("Toggle orphan backdrop"));
    const orphanSnap = await engine.snapshot(true);
    check(
      "backdrop with NO dialog (user stuck on grayed page) is flagged",
      orphanSnap.includes("NO dialog content"),
      orphanSnap.match(/OVERLAY[^\n]*/)?.[0] ?? orphanSnap.slice(0, 400),
    );
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
    check(
      "a modal carrying its own backdrop is not misread as empty/contentless",
      !wrappedSnap.includes("NO dialog content") && !wrappedSnap.includes("appears EMPTY") && !wrappedSnap.includes("far off-centre"),
      wrappedSnap.match(/[^\n]*OVERLAY[^\n]*/g)?.join(" | ") ?? "clean",
    );
    await engine.click(wmRef("Toggle wrapped modal")); // close so it can't leak into later snapshots

    console.log("page quality score");
    check(
      "audit output carries a multi-indicator PAGE SCORE",
      /PAGE SCORE: \d+\/100 \([A-E]\) — a11y \d+ · craft \d+ · consistency \d+ · task-clarity \d+/.test(design),
      design.match(/PAGE SCORE[^\n]*/)?.[0] ?? design.slice(-300),
    );
    const homeScore = engine.memory!.pageScores["/"];
    check("score persisted to memory per route", !!homeScore && homeScore.overall >= 0 && homeScore.overall <= 100, JSON.stringify(homeScore));

    console.log("scroll: user scrolling, lock oracle, clipped-ancestor unreachability");
    const preScrollSnap = await engine.snapshot(true);
    check(
      "control clipped inside an overflow-hidden container flagged as UNREACHABLE",
      preScrollSnap.includes("UNREACHABLE") && preScrollSnap.includes("clip-unreachable"),
      preScrollSnap.match(/[^\n]*UNREACHABLE[^\n]*/)?.[0] ?? preScrollSnap.slice(0, 300),
    );
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
    check(
      "snapshot passively detects the leaked scroll-lock as an OVERLAY issue",
      lockedSnap.includes("scrolling is DISABLED") && lockedSnap.includes("leaked modal scroll-lock"),
      lockedSnap.match(/[^\n]*DISABLED[^\n]*/)?.[0] ?? lockedSnap.slice(0, 300),
    );
    await engine.click(sRef("Toggle scroll lock"));
    const unlockedScroll = await engine.scroll("bottom");
    check("unlocking restores scrolling", !unlockedScroll.includes("SCROLL LOCKED") && /at the bottom/.test(unlockedScroll), unlockedScroll);
    console.log("scroll: a named secondary region can be scrolled independently");
    const sideBefore = await engine.scroll("bottom", undefined, "testid=side-scroller");
    check("scout_scroll {target} scrolls that region, not the page's largest pane", /Scrolled .*side-scroller.*at its bottom/.test(sideBefore), sideBefore);
    const sideBack = await engine.scroll("top", undefined, "testid=side-scroller");
    check("the same region scrolls back to its top", /at its top/.test(sideBack), sideBack);
    const noScroll = await engine.scroll("bottom", undefined, "testid=nav-home-link");
    check("a target with no scrollable ancestor says so rather than lying", noScroll.includes("no scrollable ancestor"), noScroll);
    const missing = await engine.scroll("bottom", undefined, "testid=does-not-exist");
    check("a missing scroll target is refused, not silently ignored", missing.includes("Scroll target not found"), missing);

    check(
      "out-of-flow escapes (fixed / absolute past a static wrapper) are NOT flagged UNREACHABLE",
      !/"(Fixed-escape action|Static-escape action)" is UNREACHABLE/.test(preScrollSnap),
      preScrollSnap.match(/[^\n]*UNREACHABLE[^\n]*/g)?.join(" | ") ?? "no UNREACHABLE lines",
    );
    await engine.click(sRef("Toggle healthy modal"));
    const modalScroll = await engine.scroll("bottom");
    check("a role-less modal's scroll-lock is respected as healthy (no SCROLL LOCKED refusal)", !modalScroll.includes("SCROLL LOCKED"), modalScroll);
    const modalSnap = await engine.snapshot(true);
    check(
      "no leaked-lock OVERLAY while the role-less modal is open",
      !modalSnap.includes("scrolling is DISABLED"),
      modalSnap.match(/[^\n]*OVERLAY[^\n]*/g)?.join(" | ") ?? "clean",
    );
    const closeRef = modalSnap.match(/(e\d+) [a-z]+ "Close modal"/)?.[1];
    if (!closeRef) throw new Error("close ref not found");
    await engine.click(closeRef);
    await engine.scroll("top");
    const planScroll = await engine.runPlan([
      { action: "scroll", value: "bottom" },
      { action: "scroll", value: "top" },
    ]);
    check("plans support scroll steps", planScroll.includes("2/2 steps ran"), planScroll);

    console.log("fixed-chrome share (synthetic — a fixture banner would intercept other tests' clicks)");
    const { analyzeDesign, DESIGN_COLLECT_SCRIPT } = await import("../../dist/engine/design.js");
    const rawPayload = (await (engine as any).page.evaluate(DESIGN_COLLECT_SCRIPT)) as { records: Array<{ fixed: boolean }> };
    check(
      "in-browser collector records position:sticky/fixed on real elements",
      rawPayload.records.some((r) => r.fixed),
      `fixed records: ${rawPayload.records.filter((r) => r.fixed).length}`,
    );
    const mk = (over: Record<string, unknown>) => ({
      tag: "div",
      testid: null,
      text: "chrome",
      textLen: 6,
      interactive: false,
      rect: { x: 0, y: 0, w: 1280, h: 300 },
      fontSize: 14,
      fontWeight: 400,
      fontFamily: "x",
      lineHeight: 20,
      textTransform: "",
      textAlign: "",
      underline: false,
      color: "rgba(20, 20, 20, 1)",
      bg: "rgb(255, 255, 255)",
      padding: [8, 8, 8, 8],
      marginV: [0, 0],
      radius: 0,
      shadow: "",
      clipped: false,
      fixed: false,
      required: false,
      submitish: false,
      sideStripe: false,
      gradientText: false,
      glass: false,
      glow: false,
      aiGradient: false,
      ...over,
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
    check(
      "fixed/sticky chrome eating >25% of the viewport is flagged",
      chromeResult.report.includes("fixed/sticky chrome occupies"),
      chromeResult.report.match(/[^\n]*chrome occupies[^\n]*/)?.[0] ?? chromeResult.report.slice(0, 400),
    );

    console.log("finding dedup v2 (evidence + fuzzy title)");
    const [, fresh1] = engine.memory!.addFinding({
      severity: "medium",
      category: "http-error",
      title: "Dashboard calls /api/reports as User → 403",
      detail: "x",
      evidence: "GET /api/reports 403",
      url: engine.currentUrl,
      state: engine.currentState,
    });
    const [, fresh2] = engine.memory!.addFinding({
      severity: "medium",
      category: "console-error",
      title: "Reports dashboard endpoint returns 403 for User role on every load",
      detail: "y",
      evidence: "GET /api/reports 403",
      url: engine.currentUrl,
      state: engine.currentState,
    });
    check("evidence dedup catches rephrased finding", fresh1 && !fresh2);
    const [, fresh3] = engine.memory!.addFinding({
      severity: "medium",
      category: "http-error",
      title: "Dashboard calls /api/reports as a User and gets 403 errors",
      detail: "z",
      url: engine.currentUrl,
      state: engine.currentState,
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
    check(
      "the gated submit starts disabled",
      /e\d+ button "Confirm order" \[testid=gate-submit, disabled/.test(gateSnap),
      gateSnap.match(/[^\n]*gate-submit[^\n]*/)?.[0] ?? "",
    );
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
    check(
      "unvisited tracks scanned + discovered union",
      engine.unvisitedKnownRoutes().includes("/zzz-never-visited"),
      JSON.stringify(engine.unvisitedKnownRoutes()),
    );
    // A PERMISSION redirect satisfies the contract for the role that was
    // refused: a viewer who cannot see an admin page must not block the run.
    engine.memory!.markAttempted("/zzz-never-visited", "landed:/", engine.role);
    check(
      "a permission redirect satisfies the contract",
      !engine.unvisitedKnownRoutes().includes("/zzz-never-visited"),
      JSON.stringify(engine.unvisitedKnownRoutes()),
    );
    // ...but only for THAT role. Keyed by route alone, a low-privilege role
    // bouncing off an admin page erased it from the admin's ledger forever.
    const otherRole = engine.role;
    engine.role = "some-other-role";
    check(
      "another role's redirect does not answer for this one",
      engine.unvisitedKnownRoutes().includes("/zzz-never-visited"),
      JSON.stringify(engine.unvisitedKnownRoutes()),
    );
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
    check(
      "static numeric routes are unvisited before they are reached",
      engine.unvisitedKnownRoutes().includes("/404"),
      JSON.stringify(engine.unvisitedKnownRoutes()),
    );
    engine.memory!.visitState("/404#probe", `${baseUrl}/404`, "/404", []);
    check("visiting /404 covers /404", !engine.unvisitedKnownRoutes().includes("/404"), JSON.stringify(engine.unvisitedKnownRoutes()));
    check("...and does NOT also cover /500", engine.unvisitedKnownRoutes().includes("/500"), JSON.stringify(engine.unvisitedKnownRoutes()));
    engine.knownRoutes = [];
    check("design audits counted for the report gate", engine.designAuditCount >= 1, String(engine.designAuditCount));

    console.log("i18n destructive policy");
    const { isDestructive } = await import("../../dist/engine/policy.js");
    check(
      "multilingual destructive labels blocked",
      isDestructive("Löschen") && isDestructive("Excluir conta") && isDestructive("削除") && !isDestructive("Los geht's"),
    );

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
    console.log("write policy: a request issued by a service worker cannot slip past it");
    // A guard, not a bug fix: request interception covering worker-issued
    // requests is the browser driver's behaviour, not ours, and it has not
    // always been the default. An app with an offline-sync worker sends its
    // writes from the worker, so if a driver upgrade ever stopped routing those,
    // a DELETE would pass straight through read-only mode with nothing logged —
    // the one guarantee the safety model makes, silently void. The worker must
    // be ACTIVE for this to prove anything, so that is asserted too.
    await engine.navigate("/worker-sync.html");
    let workerSnap = await engine.snapshot(true);
    const workerDeadline = Date.now() + 5000;
    while (workerSnap.includes("worker: starting") && Date.now() < workerDeadline) {
      await settle(100);
      workerSnap = await engine.snapshot(true);
    }
    check("the fixture's service worker is active (otherwise this proves nothing)", workerSnap.includes("worker: active"), workerSnap.slice(0, 300));
    const syncRef = workerSnap.match(/(e\d+) button "Sync now"/)?.[1];
    if (!syncRef) throw new Error("Sync now button not found");
    const syncResult = await engine.click(syncRef);
    await settle(600);
    check(
      "read-only: the worker-issued DELETE is reported as blocked",
      syncResult.includes("WRITE-POLICY blocked") && syncResult.includes("/api/items/999"),
      syncResult,
    );
    check("read-only: the worker-issued DELETE never reaches the server", stats.workerDeletes === 0, `server received ${stats.workerDeletes} DELETE(s)`);

    console.log("images: one that failed to load is reported from the DOM, even when no request failed");
    // The HTTP oracle catches a 404. It cannot catch an image URL that answers
    // 200 with something that is not an image — an HTML error page, a wrong
    // content type — because no request failed. Only the DOM shows the browser
    // gave up on it.
    await engine.navigate("/images.html");
    const imgSnap = await engine.snapshot(true);
    const imgSection = imgSnap.match(/BROKEN IMAGES:[\s\S]{0,500}/)?.[0] ?? imgSnap.slice(0, 300);
    check(
      "a 404 image is reported with its alt text",
      /image "Weekly chart" \[testid=img-404\] FAILED TO LOAD — \/img\/never-deployed\.png/.test(imgSnap),
      imgSection,
    );
    check(
      "an image URL that returns 200 with a non-image body is reported too",
      /image "Team photo" \[testid=img-not-an-image\] FAILED TO LOAD — \/page2\.html/.test(imgSnap),
      imgSection,
    );
    check("a broken image with no alt text says so", /image \(no alt text\) FAILED TO LOAD — \/login\.html/.test(imgSnap), imgSection);
    check("an image that loaded is NOT reported", !/A pixel that loads" .*FAILED TO LOAD/.test(imgSnap), imgSection);
    check("a hidden broken image is NOT reported", !/"Hidden".*FAILED TO LOAD/.test(imgSnap), imgSection);
    check("an image is listed by its alt text, as an image", /image "A pixel that loads" \[testid=img-ok/.test(imgSnap), imgSnap.slice(0, 500));

    console.log("geometry: a pinned control under other pinned chrome is caught by hit test, intended layering is not");
    // Boxes cannot say which of two overlapping pinned elements is on top, so
    // the box oracle skips chrome/chrome pairs. A sticky action row under a
    // fixed bar added later is the case that skip misses: the button is there,
    // labelled, enabled — and every click lands on the bar.
    await engine.navigate("/covered.html");
    const coveredSnap = await engine.snapshot(true);
    const geo = coveredSnap.match(/GEOMETRY[\s\S]{0,600}/)?.[0] ?? coveredSnap.slice(0, 400);
    check(
      "a sticky Save button under a fixed bar is reported as covered, and the unlabelled bar is described by its text",
      /"Save changes" is COVERED by pinned chrome <div> "Try the new importer, dismiss"/.test(coveredSnap),
      geo,
    );
    check(
      "a first-column link slid under a sticky grid header is NOT reported (the grid scrolls it back out)",
      !/Row \d open" is COVERED/.test(coveredSnap),
      geo,
    );
    check("a control under a consent banner is NOT reported (an overlay the user dismisses, not broken layout)", !/"Help" is COVERED/.test(coveredSnap), geo);

    await engine.navigate("/");
    const roSnap = await engine.snapshot(true);
    const roRefOf = (label: string): string => {
      const m = roSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    const roBlocked = await engine.click(roRefOf("Sync foreign item"));
    check("read-only blocks DELETE despite harmless label", roBlocked.includes("WRITE-POLICY blocked") && roBlocked.includes("DELETE"), roBlocked);
    // The request event fires before the policy decides, so the same DELETE used
    // to be reported twice with opposite meanings. A blocked write did not
    // happen; saying it "may have mutated" invites a false finding.
    check("a blocked write is not ALSO reported as a possible mutation", !roBlocked.includes("may have mutated"), roBlocked);

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
    const switchChecked = await (engine as unknown as { page: import("playwright").Page }).page.locator("#fake-switch").isChecked();
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
  } finally {
    await engine.close().catch(() => {});
  }
}
