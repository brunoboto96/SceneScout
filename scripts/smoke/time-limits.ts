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
import { BrowserEngine } from "../../dist/engine/browser.js";
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
    await engine.attach({ url: baseUrl, projectDir, navTimeoutMs: HIGH_MS, actionTimeoutMs: HIGH_MS });
    const passingFlow = await engine.replayFlow([...flowSteps], "observe");
    check("...while the same flow passes under raised limits", passingFlow.outcome.status === "passed", JSON.stringify(passingFlow.outcome).slice(0, 400));
  } finally {
    if (savedEnv === undefined) delete process.env[NAV_ENV];
    else process.env[NAV_ENV] = savedEnv;
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
