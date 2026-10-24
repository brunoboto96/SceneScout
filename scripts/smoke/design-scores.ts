/**
 * The design score against its calibration set, in a real browser: one page
 * (test-app/design-score.html) and the same page with one defect switched on
 * by `?with=`: two stacks of cards with no gap between them, six button
 * heights, twelve grays, and all three at once. `?with=type` sets three sizes
 * off the page's type scale, against the clean page whose sizes are all on it.
 *
 * The contrastive pair is the touching variant against the clean page, which
 * keeps an 8px gap between the same cards; the joined list group present in
 * every variant is the intended join that must never be reported, as are the
 * grouped chat bubbles and the carousel's hidden slides. `?with=scrolled` is
 * a missing gap below a scroll pane's fold, which is reported. The checks
 * are on the ORDER of the scores and on the clean page staying high, so a
 * later change to the weights cannot flatten the scale without failing here.
 *
 * test-app/design-contrast.html holds contrastive pairs for the contrast
 * read: light text over a dark panel drawn by a pseudo-element, a gradient, a
 * positioned sibling, a lab() background or a shadow root's slot, each beside
 * the same text with the panel gone or pale. The dark ones are not failures,
 * the pale ones are, and text whose background runs from dark to white is
 * listed as unsure rather than failed. Dark text under paint that does not
 * reach it (an underline drawn as a 2px gradient, a hover fill scaled to
 * nothing, a 5% tint, a pseudo-element beneath an opaque card) is never a
 * failure, while the same paint where it does reach the text is. A dark
 * panel with a negative z-index on a white sheet paints beneath the sheet's
 * background, so pale text there fails; on the same sheet isolated it is the
 * panel the text may sit on, and the text is not failed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { contrastVerdict, DESIGN_COLLECT_SCRIPT, siteAuditSection, siteConsistency, type DesignPayload } from "../../dist/engine/design.js";
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
      /^-16 touching containers ×2 · (-6 6 button heights · -\d+ \d+ grays|-\d+ \d+ grays · -6 6 button heights)$/.test(whyOf(all)),
      whyOf(all) || all,
    );

    console.log("design scores: type sizes off the scale, the contrastive pair");
    {
      // The clean page's type is 28, 20 and 16px, each on a 2px step; ?with=type moves the headings, notes and buttons to 19, 15 and 17px.
      const type = await audit("type");
      check("the clean page names no size off the type scale", !clean.includes("off the type scale"), clean);
      check(
        "three sizes off the scale in headings, body text and buttons are named and charged as a suggestion",
        type.includes("3 sizes off the type scale in headings, body text or controls: 15, 17, 19px") &&
          whyOf(type).startsWith("-3 type sizes off the scale: 15, 17, 19px") &&
          overallOf(type) < scores.clean &&
          overallOf(type) > scores.heights,
        `${overallOf(type)} ${whyOf(type)}\n${type}`,
      );
    }

    console.log("design scores: pages compared with each other, the contrastive pair");
    {
      // Four routes (?section= is part of a route): the same clean page four times, then the fourth with six button heights.
      const sections = ["1", "2", "3", "4"];
      for (const n of sections) await engine.navigate(`/design-score.html?section=${n}`).then(() => engine.designAudit());
      const sectionScores = () => Object.fromEntries(Object.entries(engine.memory!.pageScores).filter(([route]) => route.includes("section=")));
      const consistent = siteConsistency(sectionScores());
      const kept = sectionScores()["/design-score.html?section=1"]?.system;
      check(
        "an audit keeps the page's design-system values with its score",
        kept?.buttonHeights.join() === "36" && kept.headers.length === 1,
        JSON.stringify(kept),
      );
      check(
        "four pages alike: compared, and no page charged",
        consistent !== null && consistent.pages === 4 && Object.keys(consistent.deductions).length === 0,
        JSON.stringify(consistent?.deductions),
      );
      await engine.navigate("/design-score.html?section=4&with=heights");
      await engine.designAudit();
      const outlier = siteConsistency(sectionScores());
      const route = "/design-score.html?section=4";
      check(
        "the same four with six button heights on one: only that page is charged, for heights no other page uses",
        outlier !== null &&
          Object.keys(outlier.deductions).join() === route &&
          outlier.deductions[route].some((d) => d.label.startsWith("button heights only on this page")),
        JSON.stringify(outlier?.deductions),
      );
      const block = siteAuditSection(sectionScores(), route);
      check("the audit's site block names the page against the site", block.includes(`this page (${route}) against the site:`), block);
    }

    console.log("design scores: text over painted backgrounds, the contrastive pairs");
    await engine.navigate("/design-contrast.html");
    const layered = await engine.designAudit();
    const page = (engine as any).page as { evaluate(script: string): Promise<unknown> };
    const records = ((await page.evaluate(DESIGN_COLLECT_SCRIPT)) as DesignPayload).records;
    const verdictOf = (testid: string): string => {
      const r = records.find((x) => x.testid === testid);
      return r ? contrastVerdict(r).kind : "missing";
    };
    // The report lists the first eight failures; each verdict is read from the records, and the count from the why line.
    const failed = layered.match(/CONTRAST failures[^\n]*\n((?: {2}⚠[^\n]*\n?)*)/)?.[1] ?? "";
    const unsure = layered.match(/CONTRAST unsure[^\n]*\n((?: {2}→[^\n]*\n?)*)/)?.[1] ?? "";
    const seen = `${layered}\n${JSON.stringify(records.filter((r) => r.testid).map((r) => [r.testid, r.color, r.bg, r.bgRange]))}`;
    for (const [dark, pale, what] of [
      ["contrast-pseudo-dark", "contrast-pseudo-none", "light text over a dark panel drawn by a pseudo-element"],
      ["contrast-gradient-dark", "contrast-gradient-pale", "light text over a dark gradient"],
      ["contrast-lab-dark", "contrast-lab-pale", "light text over a dark background written in lab()"],
      ["contrast-slot-dark", "contrast-slot-pale", "light text slotted into a dark panel in a shadow root"],
      ["contrast-oklch-dark-text", "contrast-oklch-pale-text", "dark text coloured in oklch()"],
      ["contrast-tint-faint", "contrast-tint-full", "dark text under a 5% tint drawn by a pseudo-element"],
      ["contrast-card-under", "contrast-card-over", "dark text on a white card whose negative-z-index pseudo-element sits beneath it"],
    ] as const) {
      check(`${what} passes, and its contrastive twin fails`, verdictOf(dark) === "pass" && !failed.includes(dark) && verdictOf(pale) === "fail", seen);
    }
    for (const [maybe, shown, what] of [
      ["contrast-underline-strip", "contrast-underline-full", "an underline drawn as a 2px gradient"],
      ["contrast-fill-rest", "contrast-fill-shown", "a hover fill scaled to nothing at rest"],
    ] as const) {
      check(
        `dark text over ${what} is not failed, and the same paint at full size is`,
        verdictOf(maybe) === "varies" && !failed.includes(maybe) && verdictOf(shown) === "fail",
        seen,
      );
    }
    check(
      "text painted with a gradient clipped to its glyphs is not measured",
      verdictOf("contrast-gradient-text") === "unmeasured" && !failed.includes("contrast-gradient-text"),
      seen,
    );
    check(
      "light text over a positioned dark sibling is not failed; the same box with no sibling is",
      verdictOf("contrast-sibling-dark") === "varies" && !failed.includes("contrast-sibling-dark") && failed.includes("contrast-sibling-none"),
      seen,
    );
    check(
      "pale text on a white sheet whose negative-z-index panel paints beneath the sheet's background fails; the same sheet isolated, the panel over its background, is not failed",
      failed.includes("contrast-sheet-under") &&
        verdictOf("contrast-sheet-under") === "fail" &&
        verdictOf("contrast-sheet-over") === "varies" &&
        !failed.includes("contrast-sheet-over"),
      seen,
    );
    check(
      "text over a gradient from dark to white, or over a panel that may be under it, is listed as unsure and not scored",
      unsure.includes("contrast-gradient-mixed") && unsure.includes("contrast-sibling-dark") && !failed.includes("contrast-gradient-mixed"),
      seen,
    );
    check("the page loses points for the eleven failures only", /-15 contrast failures ×11/.test(whyOf(layered)), whyOf(layered) || layered);

    // The body's background is the page canvas when the root element sets none, so a negative-z-index panel there paints over it.
    await engine.navigate("/design-contrast-canvas.html");
    const canvasRecords = ((await page.evaluate(DESIGN_COLLECT_SCRIPT)) as DesignPayload).records;
    const onCanvas = canvasRecords.find((x) => x.testid === "contrast-canvas-panel");
    check(
      "pale text over a negative-z-index panel on the page canvas is not failed",
      onCanvas !== undefined && contrastVerdict(onCanvas).kind !== "fail",
      JSON.stringify(onCanvas),
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
