/**
 * What an action says when it cannot do what was asked, or did it another way.
 *
 * A select whose value names no option is refused at once, listing the
 * options, rather than waiting out the action limit; a value that starts one
 * option's label picks it. A plain date typed into a date-and-time field is put
 * in that field's format, and a value that is no date is refused naming the
 * format, not with the browser's bare "Malformed value". A click forced past
 * something on top of its target names that element, and says when a
 * write-policy block came first; a click forced on a moving button whose own
 * icon is the top hit names nothing. A plan run with onViolation "continue"
 * runs past a refused panel and still stops at an uncaught error; without it,
 * it stops at the refusal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "action results";

const ACTION_MS = 3000;

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("action results: select and date values checked before acting, forced clicks named, plans that sweep");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-actions-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "actions";
  try {
    await engine.attach({ url: `${baseUrl}/action-results.html`, projectDir, mode: "observe", actionTimeoutMs: ACTION_MS });
    // White-box: the page, to read back what a field and a dropdown hold.
    const page = (): Page => (engine as unknown as { page: Page }).page;
    const valueOf = (testid: string) => page().locator(`[data-testid="${testid}"]`).inputValue();
    const snap = await engine.snapshot(true);
    const refOf = (pattern: RegExp): string => {
      const m = snap.match(pattern);
      if (!m) throw new Error(`ref not found for ${pattern} in:\n${snap.slice(0, 1500)}`);
      return m[1];
    };
    const severity = refOf(/(e\d+) combobox "Severity/);
    const assignee = refOf(/(e\d+) combobox "Assignee/);

    // A select.
    const t0 = Date.now();
    const none = await engine.select(severity, "Critical");
    const noneMs = Date.now() - t0;
    check(
      "a select value naming no option is refused, listing the options",
      none.startsWith('NOT SELECTED: no option matches "Critical"; options:') && none.includes('low ("Low — minor impact")'),
      none,
    );
    check("...at once, not after the action limit", noneMs < ACTION_MS / 2, `took ${noneMs} ms (limit ${ACTION_MS})`);
    const ambiguous = await engine.select(assignee, "Pat");
    check(
      "a value two options start with is refused, naming both",
      /^NOT SELECTED: "Pat" matches more than one option: u1 \("Pat Lee"\), u2 \("Pat Long"\)/.test(ambiguous),
      ambiguous,
    );
    check("...and nothing was changed", (await valueOf("assignee")) === "u1");
    const low = await engine.select(severity, "Low");
    check("a value one option's label starts with picks that option", (await valueOf("severity")) === "low", low);
    check("...and the result says which option it matched", low.includes('matched option "low", labelled "Low — minor impact"'), low);
    await engine.select(severity, "medium");
    check("an exact value still picks as before", (await valueOf("severity")) === "medium");

    const planSelect = await engine.runPlan([{ action: "select", target: "testid=severity", value: "Critical" }]);
    check(
      "a plan's select step naming no option fails at once, listing the options",
      /1\. select testid=severity → FAILED: no option matches "Critical"; options: .*high \("High — blocks work"\)/.test(planSelect) &&
        !/Timeout|did not find some options/i.test(planSelect),
      planSelect,
    );

    // A date and time field.
    const snap2 = await engine.snapshot(true);
    const dueAt = /(e\d+) textbox "Due at"/.exec(snap2)?.[1] ?? /(e\d+) [a-z]+ "Due at"/.exec(snap2)?.[1];
    if (!dueAt) throw new Error(`ref not found for Due at in:\n${snap2.slice(0, 1500)}`);
    const typed = await engine.type(dueAt, "2026-09-20");
    check("a plain date typed into a date-and-time field is entered at midnight", (await valueOf("due-at")) === "2026-09-20T00:00", typed);
    check("...and the result says how it was entered", typed.includes("entered as 2026-09-20T00:00"), typed);
    const planDate = await engine.runPlan([
      { action: "type", target: "testid=due-on", value: "20/09/2026" },
      { action: "type", target: "testid=due-at", value: "2026-09-21T10:00" },
    ]);
    check(
      'a value that is no date fails the step naming the format the field takes, not "Malformed value"',
      /1\. type testid=due-on → FAILED: Not typed: a date field takes YYYY-MM-DD/.test(planDate) && !/Malformed value/.test(planDate),
      planDate,
    );

    // Forced clicks.
    const older = await engine.runPlan([{ action: "click", target: "testid=older-page" }]);
    check(
      "a click forced past an overlay names it",
      /\(forced — the strict click timed out because at its centre it is covered by status "Maintenance tonight" \[testid=banner-info\]; a forced click still landed\)/.test(
        older,
      ),
      older,
    );
    check("...and does not blame a write-policy block that did not come after the page was seen", !/write-policy block since/.test(older), older);
    const next = await engine.runPlan([
      { action: "click", target: "testid=save-draft" },
      { action: "click", target: "testid=next-page" },
    ]);
    check(
      "a click forced past the error toast a blocked save put up names the toast and the block",
      /2\. click testid=next-page → OK .*covered by status "Could not save the record" \[testid=toast-error\] \(after a write-policy block since the last snapshot/.test(
        next,
      ),
      next,
    );
    const snap3 = await engine.snapshot(true);
    const wobble = /(e\d+) button "Refresh/.exec(snap3)?.[1];
    if (!wobble) throw new Error(`ref not found for Refresh in:\n${snap3.slice(0, 1500)}`);
    const wobbled = await engine.click(wobble);
    check("a moving button is clicked with a forced click (the contrast's precondition)", wobbled.includes("forced click was used instead"), wobbled);
    check("...and its own icon on top is not named as covering it", !wobbled.includes("covered by"), wobbled);

    // A sweep of independent tabs, one of them refused.
    const stopped = await engine.runPlan([
      { action: "click", target: "testid=tab-a" },
      { action: "click", target: "testid=tab-b" },
      { action: "click", target: "testid=tab-c" },
    ]);
    check(
      "by default a plan stops at the tab whose panel is refused",
      stopped.startsWith("PLAN (2/3 steps ran)") && stopped.includes("PLAN ABORTED at step 2") && /HTTP 403/.test(stopped),
      stopped,
    );
    const swept = await engine.runPlan(
      [
        { action: "click", target: "testid=tab-a" },
        { action: "click", target: "testid=tab-d" },
        { action: "click", target: "testid=tab-c" },
      ],
      "continue",
    );
    check(
      'with onViolation "continue" it runs every step, listing the refusal on its step\'s line',
      swept.startsWith("PLAN (3/3 steps ran)") &&
        /2\. click testid=tab-d → OK .*oracle fired \(continuing: onViolation "continue"\):[\s\S]*HTTP 403/.test(swept) &&
        /3\. click testid=tab-c → OK/.test(swept) &&
        swept.includes('CONTINUED PAST new oracle violations at step 2 (onViolation "continue")'),
      swept,
    );
    const crashed = await engine.runPlan(
      [
        { action: "click", target: "testid=tab-e" },
        { action: "click", target: "testid=tab-a" },
      ],
      "continue",
    );
    check(
      "...and still stops at an uncaught error",
      crashed.startsWith("PLAN (1/2 steps ran)") && crashed.includes("PLAN ABORTED at step 1") && /page_error/.test(crashed),
      crashed,
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
