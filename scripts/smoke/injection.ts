/**
 * The DOM-injection oracle against real pages: a value the session typed
 * comes back as an element on another page (stored), or on the page it was
 * typed on (reflected), and the result of the action that revealed it says so.
 * A page that renders the same value as text stays quiet, and so does the
 * app's own markup that happens to resemble a payload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "injection oracle";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("injection oracle: a typed value that comes back as markup");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-inject-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "inject";
  const injections = (): Array<{ url: string; detail: string }> => engine.oracleLog.all.filter((v) => v.kind === "dom_injection");
  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });
    await engine.navigate("/echo.html");

    // A payload that looks like the app's own link. The app's link carries a
    // testid the payload does not, so it is not mistaken for the injection
    // where the note is rendered as text; where it is rendered as HTML, it is one.
    await engine.runPlan([
      { action: "type", target: "testid=echo-note", value: '<a href="/echo.html">Back</a>', replace: true },
      { action: "click", target: "testid=echo-save" },
    ]);
    const lookalike = await engine.navigate("/echo-safe.html");
    check("the app's own link is not reported as the typed one", !/dom_injection/.test(lookalike) && injections().length === 0, lookalike.slice(0, 300));
    const injectedLink = await engine.navigate("/echo-list.html");
    check("...while the same payload rendered as HTML is", /dom_injection/.test(injectedLink) && injections().length === 1, injectedLink.slice(0, 600));

    // The classic payload, typed through scout_type so the field is named as the agent saw it.
    await engine.navigate("/echo.html");
    const snap = await engine.snapshot();
    const noteRef = /(e\d+) textbox "Note"/.exec(snap)?.[1];
    const saveRef = /(e\d+) button "Save note"/.exec(snap)?.[1];
    check("the fixture's field and button are in the snapshot", !!noteRef && !!saveRef, snap.slice(0, 400));
    const payload = '<img src="x" onerror="document.title=\'pwned\'">';
    await engine.type(noteRef!, payload, false, true);
    await engine.click(saveRef!);
    const list = await engine.navigate("/echo-list.html");
    check("the page that renders the note as HTML is reported the moment it is reached", /dom_injection/.test(list), list.slice(0, 600));
    const stored = injections().at(-1);
    check(
      "...naming the element, the page it fired on, the field and the page it was typed on",
      /^<img src="x" onerror=.* on \/echo-list\.html is a value typed into textbox "Note" on \/echo\.html/.test(stored?.detail ?? ""),
      stored?.detail ?? "(no injection logged)",
    );
    const listSnap = await engine.snapshot();
    check("the payload really ran: the page's title is what the onerror set", /pwned/.test(listSnap), listSnap.slice(0, 200));
    check("the same page is not reported again on the next snapshot", !/dom_injection/.test(listSnap) && injections().length === 2, listSnap.slice(0, 300));

    const safe = await engine.navigate("/echo-safe.html");
    check("the page that renders the note as text stays quiet", !/dom_injection/.test(safe) && injections().length === 2, safe.slice(0, 300));

    // Reflected: the page renders what is typed as it is typed, so the type result itself says so.
    await engine.navigate("/echo-reflect.html");
    const reflectSnap = await engine.snapshot();
    const draftRef = /(e\d+) textbox "Draft"/.exec(reflectSnap)?.[1];
    const typed = await engine.type(draftRef!, '<b data-probe="r">loud</b>', false, true);
    check("a value reflected on the page it was typed on is reported in the type result", /dom_injection/.test(typed), typed.slice(0, 600));
    check(
      "...and it names the same route for both",
      /on \/echo-reflect\.html is a value typed into textbox "Draft" on \/echo-reflect\.html/.test(injections().at(-1)?.detail ?? ""),
      injections().at(-1)?.detail ?? "",
    );

    // Crawl drains too: a route reached by the sweep is checked like any other
    // (with a payload of its own, since a payload is reported once per route).
    await engine.navigate("/echo.html");
    await engine.runPlan([
      { action: "type", target: "testid=echo-note", value: '<i data-probe="c">crawled</i>', replace: true },
      { action: "click", target: "testid=echo-save" },
    ]);
    const crawl = await engine.crawl(["/echo-list.html"]);
    check("a crawled route reports an injection in its problem list", /dom_injection/.test(crawl), crawl.slice(0, 600));

    const urls = injections().map((v) => new URL(v.url).pathname);
    check(
      "the oracle log holds exactly the injections that happened, as high, on the pages they happened",
      injections().every((v) => (v as { severity?: string }).severity === "high") &&
        urls.filter((u) => u === "/echo-list.html").length === 3 &&
        urls.filter((u) => u === "/echo-reflect.html").length === 1 &&
        urls.filter((u) => u === "/echo-safe.html").length === 0,
      JSON.stringify(urls),
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
