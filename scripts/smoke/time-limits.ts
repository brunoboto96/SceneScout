/**
 * The time limits against a real browser: a page slower than a lowered
 * page-load limit fails with a message naming that limit and how to raise it,
 * and the same page loads under a raised one; a control that stays disabled
 * longer than a lowered action limit fails the same way, and is clicked under
 * a raised one. The environment variable is honoured, and an option beats it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { generateReport } from "../../dist/engine/report.js";
import { check, SLOW_PAGE_MS, type SmokeContext } from "./harness.ts";

export const title = "time limits";

const NAV_ENV = "SCENESCOUT_NAV_TIMEOUT_MS";
const LOW_MS = 1000;
const HIGH_MS = 15000;

async function attachError(engine: BrowserEngine, opts: Parameters<BrowserEngine["attach"]>[0]): Promise<string> {
  try {
    await engine.attach(opts);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Make page loads of URLs ending in `suffix` fail with `error` the next `times` times, as the browser would. No
 * network error the route API can abort with is ERR_NO_BUFFER_SPACE, so the page's own goto stands in for it.
 * Returns how many loads of such a URL were asked for, and the undo.
 */
function failLoads(page: Page, suffix: string, error: string, times: number): { asked: () => number; restore: () => void } {
  const proto = Object.getPrototypeOf(page) as { goto: Page["goto"] };
  const real = proto.goto;
  let asked = 0;
  let left = times;
  proto.goto = async function (this: Page, url: string, options?: Parameters<Page["goto"]>[1]) {
    if (url.endsWith(suffix)) {
      asked += 1;
      if (left > 0) {
        left -= 1;
        throw new Error(`page.goto: net::${error} at ${url}\nCall log:\n  - navigating to "${url}", waiting until "domcontentloaded"`);
      }
    }
    return real.call(this, url, options);
  };
  return { asked: () => asked, restore: () => (proto.goto = real) };
}

async function navigateError(engine: BrowserEngine, target: string): Promise<{ result: string; error: string }> {
  try {
    return { result: await engine.navigate(target), error: "" };
  } catch (err) {
    return { result: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function retriedLoads(engine: BrowserEngine, baseUrl: string, projectDir: string): Promise<void> {
  const target = "/action-results.html";
  await engine.attach({ url: baseUrl, projectDir });
  const page = (engine as unknown as { page: Page }).page;

  let fault = failLoads(page, target, "ERR_NO_BUFFER_SPACE", 1);
  try {
    const once = await navigateError(engine, target);
    check(
      "a page load refused with ERR_NO_BUFFER_SPACE is tried once more, loads, and the result says it was retried",
      fault.asked() === 2 && /retried after ERR_NO_BUFFER_SPACE/.test(once.result) && page.url().endsWith(target),
      `loads asked: ${fault.asked()}; ${(once.result || once.error).slice(0, 400)}`,
    );
  } finally {
    fault.restore();
  }
  const report = generateReport(engine.memory!, [], undefined, { write: false }).markdown;
  check(
    "...and the report lists that load under the loads retried",
    /## Page loads retried[\s\S]*action-results\.html` \(session limits\): retried after ERR_NO_BUFFER_SPACE/.test(report),
    report.slice(report.indexOf("## Page loads retried"), report.indexOf("## Page loads retried") + 400) || "(no such section)",
  );

  fault = failLoads(page, target, "ERR_NO_BUFFER_SPACE", 2);
  try {
    const twice = await navigateError(engine, target);
    check(
      "a second refusal is not retried again: the load fails after two tries",
      fault.asked() === 2 && /net::ERR_NO_BUFFER_SPACE/.test(twice.error),
      `loads asked: ${fault.asked()}; ${(twice.result || twice.error).slice(0, 400)}`,
    );
  } finally {
    fault.restore();
  }

  fault = failLoads(page, target, "ERR_CONNECTION_REFUSED", 1);
  try {
    const other = await navigateError(engine, target);
    check(
      "any other load failure is not retried",
      fault.asked() === 1 && /net::ERR_CONNECTION_REFUSED/.test(other.error) && !/retried after/.test(other.error),
      `loads asked: ${fault.asked()}; ${(other.result || other.error).slice(0, 400)}`,
    );
  } finally {
    fault.restore();
  }

  // The attach's own first load: the page object is new, its class the same.
  fault = failLoads(page, target, "ERR_NO_BUFFER_SPACE", 1);
  try {
    const attached = await engine.attach({ url: `${baseUrl}${target}`, projectDir });
    check(
      "an attach whose first load is refused with ERR_NO_BUFFER_SPACE retries it and says so",
      fault.asked() === 2 && /retried after ERR_NO_BUFFER_SPACE/.test(attached),
      `loads asked: ${fault.asked()}; ${attached.slice(-400)}`,
    );
  } finally {
    fault.restore();
  }

  fault = failLoads(page, target, "ERR_NO_BUFFER_SPACE", 1);
  try {
    const crawled = await engine.crawl([target]);
    check(
      "a crawled route whose load was retried says so on its line",
      fault.asked() === 2 && new RegExp(`^${target.replace(".", "\\.")} — 200 .*retried after ERR_NO_BUFFER_SPACE`, "m").test(crawled),
      `loads asked: ${fault.asked()}; ${crawled.slice(0, 400)}`,
    );
  } finally {
    fault.restore();
  }
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log(`time limits: a page the server holds back ${SLOW_PAGE_MS} ms, and a button disabled for 6 s`);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-limits-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "limits";
  const savedEnv = process.env[NAV_ENV];
  try {
    const slowUrl = `${baseUrl}/slow-page`;

    // Page load, set on the attach.
    const lowered = await attachError(engine, { url: slowUrl, projectDir, navTimeoutMs: LOW_MS });
    check(
      "a page slower than a lowered page-load limit fails attach, naming the limit, its length and how to raise it",
      /page-load limit \(1000 ms\) ran out/.test(lowered) && lowered.includes("navTimeoutMs") && lowered.includes(NAV_ENV),
      lowered.slice(0, 400),
    );
    const raised = await attachError(engine, { url: slowUrl, projectDir, navTimeoutMs: HIGH_MS });
    check("...and the same page loads under a raised one", raised === "" && (await engine.snapshot()).includes("Slow page"), raised.slice(0, 300));

    // scout_navigate is held to the same limit.
    await engine.attach({ url: baseUrl, projectDir, navTimeoutMs: LOW_MS });
    let navError = "";
    try {
      await engine.navigate("/slow-page");
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
    }
    check("a navigation slower than the limit fails with the same explanation", /page-load limit \(1000 ms\) ran out/.test(navError), navError.slice(0, 300));

    // The environment variable, and an option over it.
    process.env[NAV_ENV] = String(LOW_MS);
    const fromEnv = await attachError(engine, { url: slowUrl, projectDir });
    check("the environment variable lowers the limit when no option is given", /page-load limit \(1000 ms\) ran out/.test(fromEnv), fromEnv.slice(0, 300));
    const overEnv = await attachError(engine, { url: slowUrl, projectDir, navTimeoutMs: HIGH_MS });
    check("...and an option beats it", overEnv === "", overEnv.slice(0, 300));
    process.env[NAV_ENV] = "0";
    const nonsense = await attachError(engine, { url: baseUrl, projectDir });
    check(
      "a limit out of bounds refuses the attach with a sentence naming the variable",
      /^SCENESCOUT_NAV_TIMEOUT_MS must be a whole number/.test(nonsense),
      nonsense,
    );
    if (savedEnv === undefined) delete process.env[NAV_ENV];
    else process.env[NAV_ENV] = savedEnv;

    // An action: "Go" stays disabled for 6 s after "Start".
    await engine.attach({ url: slowUrl, projectDir, navTimeoutMs: HIGH_MS, actionTimeoutMs: LOW_MS });
    await engine.runPlan([{ action: "click", target: "testid=slow-start" }]);
    const snap = await engine.snapshot(true);
    const goRef = /(e\d+) button "Go"/.exec(snap)?.[1];
    let clickError = "";
    try {
      await engine.click(goRef ?? "e0");
    } catch (err) {
      clickError = err instanceof Error ? err.message : String(err);
    }
    check(
      "a click held up longer than a lowered action limit fails, naming the limit and how to raise it",
      /action limit \(1000 ms\) ran out/.test(clickError) && clickError.includes("actionTimeoutMs") && clickError.includes("SCENESCOUT_ACTION_TIMEOUT_MS"),
      clickError.slice(0, 400) || snap.slice(0, 400),
    );

    await engine.attach({ url: slowUrl, projectDir, navTimeoutMs: HIGH_MS, actionTimeoutMs: HIGH_MS });
    const plan = await engine.runPlan([
      { action: "click", target: "testid=slow-start" },
      { action: "click", target: "testid=slow-go" },
    ]);
    check(
      "...and the same click lands under a raised one",
      /2\. .*→ OK/.test(plan) && (await engine.snapshot(true)).includes("Slow page: went"),
      plan.slice(0, 600),
    );

    // A saved flow, as `scenescout check` replays it, is held to the same limits. Attached at the
    // origin, as a check attaches: a flow's navigate joins its path onto the attached URL.
    const flowSteps = [
      { action: "navigate", target: "/slow-page" },
      { action: "click", target: "testid=slow-start" },
      { action: "click", target: "testid=slow-go" },
    ] as const;
    await engine.attach({ url: baseUrl, projectDir, navTimeoutMs: HIGH_MS, actionTimeoutMs: LOW_MS });
    const slowFlow = await engine.replayFlow([...flowSteps], "observe");
    check(
      "a saved flow's click on a control still disabled when the action limit runs out fails at that step, naming the state and the limit",
      slowFlow.outcome.status === "failed" &&
        slowFlow.outcome.step === 3 &&
        /^testid=slow-go is visible but disabled after 1s — the action limit \(1000 ms\) ran out/.test(slowFlow.outcome.reason),
      JSON.stringify(slowFlow.outcome).slice(0, 400),
    );
    await engine.attach({ url: baseUrl, projectDir, navTimeoutMs: LOW_MS });
    const slowNavFlow = await engine.replayFlow([{ action: "navigate", target: "/slow-page" }], "observe");
    check(
      "...and its page load slower than the page-load limit fails naming that one",
      slowNavFlow.outcome.status === "failed" && /page-load limit \(1000 ms\) ran out/.test(slowNavFlow.outcome.reason),
      JSON.stringify(slowNavFlow.outcome).slice(0, 400),
    );
    // A plan step's target that is there when it is looked for and gone for a moment while it would be named: its
    // name is read when it is found, so a read-only plan still refuses the destructive control rather than clicking
    // it unnamed once it is back.
    await engine.attach({ url: `${baseUrl}/vanishing-target.html`, projectDir, mode: "read-only" });
    const vanishingPage = (engine as unknown as { page: import("playwright").Page }).page;
    await vanishingPage.evaluate("window.__redrawOnRead = true");
    const vanishing = await engine.runPlan([{ action: "click", target: "testid=thing-remove" }]);
    check(
      "a read-only plan refuses a destructive control that vanishes for a moment while it is named, rather than clicking it unnamed",
      /1\. click testid=thing-remove → REFUSED/.test(vanishing) &&
        (await vanishingPage.locator("[data-testid=thing-status]").textContent()) === "Nothing removed",
      vanishing.slice(0, 600),
    );

    await engine.attach({ url: baseUrl, projectDir, navTimeoutMs: HIGH_MS, actionTimeoutMs: HIGH_MS });
    const passingFlow = await engine.replayFlow([...flowSteps], "observe");
    check("...while the same flow passes under raised limits", passingFlow.outcome.status === "passed", JSON.stringify(passingFlow.outcome).slice(0, 400));

    await retriedLoads(engine, baseUrl, projectDir);
  } finally {
    if (savedEnv === undefined) delete process.env[NAV_ENV];
    else process.env[NAV_ENV] = savedEnv;
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
