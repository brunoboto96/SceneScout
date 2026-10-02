/**
 * What a snapshot tells the agent about a page, against real pages: the
 * message a page announces after an action, accessible names, which elements
 * count as controls, the state of toggles and tabs, what the main area holds,
 * and controls held out of view inside a sideways-scrolling container.
 *
 * Every behaviour has its contrast on the same or a twin page: an empty
 * announcement before the one that matters, an unnamed button beside a
 * decorative dot, a main area with text beside one with nothing, a wide table
 * beside one that fits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "snapshot contents";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("snapshot contents: announcements, names, states, main region, sideways scroll");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-snapshot-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "snapshot";
  const lineOf = (snap: string, re: RegExp): string => snap.split("\n").find((l) => re.test(l)) ?? "";

  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });

    // ── what the page announces ────────────────────────────────────────────
    await engine.navigate("/snapshot-alert.html");
    const before = await engine.snapshot(true);
    check(
      "before the save, the untagged alert is an empty live region, not a named alert",
      /alert "\(empty live region\)"/.test(before) && !/alert "Could not save"/.test(before),
      before,
    );
    check("...and the tagged alert is listed, as it always was", /alert "1 field needs attention" \[testid=alert-field-summary/.test(before), before);
    check("...and the polite status line is listed by what it says", /status "No changes yet"/.test(before), before);
    check(
      "a message is not counted as a control missing a test id",
      /Interactables \(5, 1 missing data-testid\)/.test(before),
      before.split("\n").find((l) => l.startsWith("Interactables")) ?? before,
    );
    const save = /(e\d+) button "Save record"/.exec(before)?.[1];
    if (!save) throw new Error(`fixture button not in snapshot: ${before.slice(0, 600)}`);
    await engine.click(save);
    const after = await engine.snapshot();
    check("after the save, the diff shows the banner that carries no test id, by its text", /alert "Could not save" \(was empty\)/.test(after), after);
    check("...and the status line saying something new, as the same region", /status "Draft kept on this device" \(was "No changes yet"\)/.test(after), after);
    check("...and neither is filed as destructive or as a new state's control", !/DESTRUCTIVE/.test(after) && /\(revisited\)/.test(after), after);

    // ── names, controls and states ─────────────────────────────────────────
    await engine.navigate("/snapshot-states.html");
    const states = await engine.snapshot(true);
    check(
      "radios wrapped in labels are named by their labels",
      /radio "Alpha"/.test(states) && /radio "Beta" \[checked/.test(states) && !/radio "Alpha" \[checked/.test(states),
      states,
    );
    check("...while a radio with only a name attribute still shows it, flagged as no label", /radio "fmt" \[no label\]/.test(states), states);
    check("an icon button is named by its title", /button "Download file" \[testid=states-download/.test(states), states);
    check("...and one with neither text nor title stays unnamed", /button "\(unnamed\)" \[testid=states-bare/.test(states), states);
    check(
      "a labelled select is named by its label, not its options",
      /combobox "Country" \[testid=states-country/.test(states) && !/France/.test(states),
      states,
    );
    check(
      "the pressed pill, the selected tab and nothing else carry a state marker",
      /button "Open" \[pressed, testid=filter-open/.test(states) &&
        /button "Closed" \[testid=filter-closed/.test(states) &&
        /tab "Summary" \[selected, testid=tab-summary/.test(states) &&
        /tab "History" \[testid=tab-history/.test(states) &&
        /button "More options" \[testid=states-more/.test(states),
      states,
    );
    const closed = /(e\d+) button "Closed"/.exec(states)?.[1];
    const more = /(e\d+) button "More options"/.exec(states)?.[1];
    if (!closed || !more) throw new Error(`fixture buttons not in snapshot: ${states.slice(0, 600)}`);
    await engine.click(closed);
    await engine.click(more);
    const moved = await engine.snapshot();
    check(
      "after clicking the other pill, the diff shows the pressed state moving, and the disclosure opening",
      /"Closed" now \[pressed\]/.test(moved) && /"Open" no longer \[pressed\]/.test(moved) && /"More options" now \[expanded\]/.test(moved),
      moved,
    );
    const exercisedSnap = await engine.snapshot(true);
    check(
      "after clicking, the snapshot marks the control exercised, not done",
      /button "Closed" \[pressed, testid=filter-closed, exercised\]/.test(exercisedSnap),
      exercisedSnap,
    );
    const crawled = await engine.crawl(["/snapshot-states.html"]);
    check(
      "the crawl counts the bare icon button and the name-only radio as unnamed, not the decorative dot or the wrapper",
      /snapshot-states\.html — 200 · \d+ el.* · 2 unnamed/.test(crawled),
      crawled,
    );

    // ── the main region ────────────────────────────────────────────────────
    await engine.navigate("/snapshot-main.html");
    const withText = await engine.snapshot(true);
    check("a main area with a heading and a sentence is summarised", /^main: h1 "Title" · 1 paragraph · \d+ chars of static text$/m.test(withText), withText);
    await engine.navigate("/snapshot-main-empty.html");
    const empty = await engine.snapshot(true);
    check("...and the same shell with an empty main says EMPTY", /^main: EMPTY$/m.test(empty), empty);
    const mains = await engine.crawl(["/snapshot-main.html", "/snapshot-main-empty.html"]);
    check(
      "the crawl line says how much the main area holds",
      /snapshot-main\.html — 200 · \d+ el · main \d+ chars/.test(mains) && /snapshot-main-empty\.html — 200 · \d+ el · main EMPTY/.test(mains),
      mains,
    );
    // The same shell three ways, each answering 200: real content, the app's error view, a placeholder that never resolves.
    const shown = await engine.crawl(["/snapshot-main.html", "/snapshot-main-error.html", "/snapshot-main-loading.html"]);
    const lineFor = (p: string): string => lineOf(shown, new RegExp(`^/${p.replace(".", "\\.")} — `));
    check("a main area holding only an alert is flagged ERROR-VIEW", /ERROR-VIEW/.test(lineFor("snapshot-main-error.html")), shown);
    check("...one holding only loading placeholders is flagged STILL-LOADING", /STILL-LOADING/.test(lineFor("snapshot-main-loading.html")), shown);
    check("...and the page with content is flagged as neither", !/ERROR-VIEW|STILL-LOADING/.test(lineFor("snapshot-main.html")), shown);
    check(
      "both are listed as problem routes, saying what the main area showed",
      /snapshot-main-error\.html → main area shows only an error view \("Not found/.test(shown) &&
        /snapshot-main-loading\.html → main area still shows only a loading placeholder/.test(shown) &&
        !/All crawled routes healthy/.test(shown),
      shown,
    );
    const known = Object.keys(engine.memory?.discoveredRoutes ?? {});
    check(
      "...and neither joins the route contract, while the page with content does",
      known.includes("/snapshot-main.html") && !known.includes("/snapshot-main-error.html") && !known.includes("/snapshot-main-loading.html"),
      known.join(", "),
    );

    // ── controls out of view inside a sideways-scrolling container ─────────
    await engine.navigate("/snapshot-sideways.html");
    const sideways = await engine.snapshot(true);
    check(
      "the wide table's row actions are reported as scrolled out of view, once, naming the container",
      /3 controls are scrolled out of view inside a horizontally scrolling container \[sideways-wide\]/.test(sideways),
      sideways,
    );
    check(
      "...and neither the table that fits nor the wide one whose hidden column holds only tagged cells is",
      sideways.split("\n").filter((l) => /scrolled out of view/.test(l)).length === 1 &&
        !/sideways-(narrow|tagged)\]/.test(lineOf(sideways, /scrolled out of view/)),
      sideways,
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
