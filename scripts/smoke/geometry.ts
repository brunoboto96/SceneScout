/**
 * The geometry oracles and the tiny-target rule against intended layering:
 * skip links, a list that scrolls inside a clipping card, a paged viewer, a
 * clear button inside a search field, a click-through overlay, and native
 * inputs operated by their label or drop zone.
 *
 * Every fixture here is half of a pair. Beside each intended layout sits the
 * same layout with the one fact that makes it a defect (no focus rule, no
 * scroller, no pager, no reserved padding, an overlay that takes clicks, a
 * label out of reach), and that one must still be reported.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { focusAdvanceKey } from "../../dist/browsers.js";
import { BROWSER, check, type SmokeContext } from "./harness.ts";

export const title = "geometry: intended layering";

/** The snapshot's GEOMETRY block, or "" when there is none. */
const geometryOf = (snap: string): string => snap.match(/GEOMETRY[\s\S]*?(?=\n\n|$)/)?.[0] ?? "";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-geometry-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "geometry";
  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });
    await engine.navigate("/skip-links.html");

    console.log("geometry: a skip link parked above the page, before and after it takes focus");
    const before = await engine.snapshot(true);
    const geoBefore = geometryOf(before) || before.slice(0, 600);
    check(
      "a skip link parked above the page is not reported off-page",
      /"Skip to content"/.test(before) && !/"Skip to content" is rendered outside/.test(before),
      geoBefore,
    );
    check(
      "a link parked off the page with nothing to bring it back still is",
      /"Old reports" is rendered outside the reachable page area/.test(before),
      geoBefore,
    );
    check(
      "a button a :focus rule brings back is not reported off-page",
      /"Jump to filters"/.test(before) && !/"Jump to filters" is rendered outside/.test(before),
      geoBefore,
    );
    check("the same button with no such rule still is", /"Export filters" is rendered outside the reachable page area/.test(before), geoBefore);
    check("a header link under a fixed ribbon is still reported covered", /"Account" is COVERED by pinned chrome \[promo-ribbon\]/.test(before), geoBefore);
    await engine.press(focusAdvanceKey(BROWSER, process.platform));
    const focused = await engine.snapshot(true);
    const geoFocused = geometryOf(focused) || focused.slice(0, 600);
    check("the focused skip link over the home link is not reported as covering it", !/"Home" is COVERED/.test(focused), geoFocused);
    check("...and is not off-page either", !/"Skip to content" is rendered outside/.test(focused), geoFocused);
    check("...while the ribbon over Account still is", /"Account" is COVERED by pinned chrome \[promo-ribbon\]/.test(focused), geoFocused);

    console.log("geometry: a list that scrolls inside an overflow-hidden card");
    await engine.navigate("/clipped-lists.html");
    const lists = await engine.snapshot(true);
    const geoLists = geometryOf(lists) || lists.slice(0, 600);
    check(
      "options of a list that scrolls inside a clipping card are not UNREACHABLE",
      /"Palette option 30"/.test(lists) && !/"Palette option \d+" is UNREACHABLE/.test(lists),
      geoLists,
    );
    check("the same list that cannot scroll still has UNREACHABLE options", /"Locked option [45]" is UNREACHABLE/.test(lists), geoLists);

    console.log("geometry: a paged viewer");
    await engine.navigate("/pager.html");
    const pager = await engine.snapshot(true);
    const geoPager = geometryOf(pager) || pager.slice(0, 600);
    check(
      "slides a Next page control reveals are not UNREACHABLE",
      /"Named action 2"/.test(pager) && !/"Named action \d" is UNREACHABLE/.test(pager),
      geoPager,
    );
    check(
      "slides a control naming the viewer in aria-controls reveals are not UNREACHABLE",
      /"Controlled action 2"/.test(pager) && !/"Controlled action \d" is UNREACHABLE/.test(pager),
      geoPager,
    );
    check("the same viewer with no control still has an UNREACHABLE slide", /"Stuck action 2" is UNREACHABLE/.test(pager), geoPager);
    check("a column a card clips is still UNREACHABLE beside a Next page that pages rows", /"Archive row" is UNREACHABLE/.test(pager), geoPager);

    console.log("geometry: an adornment in a text field, and a click-through overlay");
    await engine.navigate("/layering.html");
    const layering = await engine.snapshot(true);
    const overlaps = layering.match(/[^\n]*overlaps[^\n]*/g)?.join("\n") ?? "no overlaps";
    check(
      "a clear button in the padding its field reserves is not an overlap",
      /"Clear search"/.test(layering) && !/Search orders|Clear search/.test(overlaps),
      overlaps,
    );
    check(
      "the same button over a field with no padding reserved still is",
      /Search customers[^\n]*overlaps[^\n]*Clear customers|Clear customers[^\n]*overlaps[^\n]*Search customers/.test(overlaps),
      overlaps,
    );
    check("a pointer-events:none overlay over a link is not an overlap", /"Open document"/.test(layering) && !/Open document|DRAFT/.test(overlaps), overlaps);
    check("the same overlay taking clicks still is", /Open archive|COPY/.test(overlaps), overlaps);

    console.log("design: targets measured as the user hits them");
    await engine.navigate("/targets.html");
    const audit = await engine.designAudit();
    const tiny = audit.match(/TINY targets[\s\S]*?(?=\n\n|$)/)?.[0] ?? "";
    const shown = tiny || audit.slice(0, 600);
    check("a checkbox wrapped in its label is not tiny", tiny !== "" && !/target-wrapped-check/.test(tiny), shown);
    check("the same checkbox with its label out of reach is", /\[target-far-check\] — 13×13px/.test(tiny), shown);
    check("a hidden file input operated by its drop zone is not tiny", !/target-drop-input/.test(tiny), shown);
    check("a hidden file input nothing operates, beside a button, is", /\[target-bare-input\]/.test(tiny), shown);
    check("two 16px icon buttons 4px apart are tiny", /\[target-icon-a\]/.test(tiny) && /\[target-icon-b\]/.test(tiny), shown);
    // Counted as well as named: the section lists only the six smallest, so a missing name alone proves nothing.
    check("one 16px button alone in its row is not (WCAG 2.5.8 spacing)", /^TINY targets \(4,/.test(tiny) && !/target-alone/.test(tiny), shown);
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
