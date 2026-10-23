/**
 * The design score against its calibration set, in a real browser: one page
 * (test-app/design-score.html) and the same page with one defect switched on
 * by `?with=`: two stacks of cards with no gap between them, six button
 * heights, twelve grays, and all three at once.
 *
 * The contrastive pair is the touching variant against the clean page, which
 * keeps an 8px gap between the same cards; the joined list group present in
 * every variant is the intended join that must never be reported, as are the
 * grouped chat bubbles and the carousel's hidden slides. `?with=scrolled` is
 * a missing gap below a scroll pane's fold, which is reported. The checks
 * are on the ORDER of the scores and on the clean page staying high, so a
 * later change to the weights cannot flatten the scale without failing here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "design scores";

/** The overall score a design audit printed, or NaN when it printed none. */
const overallOf = (audit: string): number => Number(audit.match(/PAGE SCORE: (\d+)\/100/)?.[1] ?? NaN);
/** The audit's "why" line: the top deductions beside the score. */
const whyOf = (audit: string): string => audit.match(/PAGE SCORE: [^\n]*\n {2}why: ([^\n]*)/)?.[1] ?? "";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-design-scores-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "design-scores";
  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });
    const audit = async (variant: string): Promise<string> => {
      await engine.navigate(`/design-score.html${variant ? `?with=${variant}` : ""}`);
      return engine.designAudit();
    };
    const clean = await audit("");
    const touching = await audit("touching");
    const heights = await audit("heights");
    const grays = await audit("grays");
    const all = await audit("touching,heights,grays");
    const scores = { clean: overallOf(clean), touching: overallOf(touching), heights: overallOf(heights), grays: overallOf(grays), all: overallOf(all) };
    const shown = JSON.stringify(scores);

    console.log("design scores: touching containers, the contrastive pair");
    check("the clean page reports no touching containers", !clean.includes("TOUCHING CONTAINERS"), clean);
    check(
      "the same cards with no gap are reported, naming both parents",
      /TOUCHING CONTAINERS \(2 pairs\)/.test(touching) && touching.includes("in [score-profile-stack]") && touching.includes("in [score-billing-stack]"),
      touching,
    );
    check("the joined list group is never reported", !/score-list-group/.test(touching) && !/score-list-group/.test(all), touching);
    check(
      "grouped chat bubbles and a carousel's hidden slides are never reported",
      !/score-chat|score-carousel/.test(touching) && !/score-chat|score-carousel/.test(all),
      touching,
    );
    const scrolled = await audit("scrolled");
    check(
      "cards below a scroll pane's fold are still measured, whatever clips the pane",
      /TOUCHING CONTAINERS \(1 pair\)/.test(scrolled) && scrolled.includes("in [score-pane-stack]"),
      scrolled,
    );

    console.log("design scores: the calibration order");
    check("the clean page scores at least 95", scores.clean >= 95, `${shown}\n${clean}`);
    check(
      "each single defect scores below the clean page",
      scores.touching < scores.clean && scores.heights < scores.clean && scores.grays < scores.clean,
      shown,
    );
    check("two touching pairs cost more than six button heights or twelve grays", scores.touching < scores.heights && scores.touching < scores.grays, shown);
    check("the page with all three lands below 80, and below each alone", scores.all < 80 && scores.all < scores.touching, shown);

    console.log("design scores: why a score is what it is");
    check("the clean page says it lost nothing", whyOf(clean) === "no deductions", clean);
    check(
      "the defective page lists its top deductions beside the score",
      /^-16 touching containers ×2 · (-12 6 button heights · -\d+ \d+ grays|-\d+ \d+ grays · -12 6 button heights)$/.test(whyOf(all)),
      whyOf(all) || all,
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
