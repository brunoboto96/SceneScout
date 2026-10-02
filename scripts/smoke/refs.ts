/**
 * How long a snapshot's refs last, and what a re-snapshot says, against real
 * pages: refs survive a query-only URL change and a re-render that replaces a
 * control, a revisited route and another tab of a screen are shown as diffs, a
 * filtered list reads as the rows it lost, a dense page says what it cut, and
 * a row listed only for its test id says it can be clicked and focused.
 *
 * Each has its contrast: a route change still refuses the old refs, a
 * replaced control that now says something else is not acted on, a page
 * never snapshotted before is listed in full, and a wrapper with only a test
 * id carries no flag.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "refs and snapshot diffs";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("refs and snapshot diffs: query changes, re-renders, revisits, tabs, rows, truncation");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-refs-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "refs";
  const refOf = (snap: string, re: RegExp): string => {
    const line = snap.split("\n").find((l) => re.test(l));
    const ref = line && /^(e\d+) /.exec(line)?.[1];
    if (!ref) throw new Error(`no line matching ${re} in:\n${snap.slice(0, 1200)}`);
    return ref;
  };
  const attempt = async (act: () => Promise<string>): Promise<string> => {
    try {
      return await act();
    } catch (err) {
      return `THREW: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });

    // ── a query-only URL change keeps the refs ─────────────────────────────
    await engine.navigate("/refs-query.html?q=x");
    const query = await engine.snapshot(true);
    const clear = refOf(query, /testid=things-clear/);
    const count = refOf(query, /testid=things-count/);
    const filterOpen = refOf(query, /testid=things-filter-open/);
    const other = refOf(query, /testid=things-other/);
    const cleared = await attempt(() => engine.click(clear));
    check(
      "clearing the search rewrites the query only, and says the refs still apply",
      /^OK: click/.test(cleared) && /refs still apply/.test(cleared),
      cleared,
    );
    const afterClear = await attempt(() => engine.click(count));
    check("a ref from before the query change still acts", /^OK: click/.test(afterClear), afterClear);
    const filtered = await attempt(() => engine.click(filterOpen));
    check("a filter link that rewrites only the query acts", /^OK: click/.test(filtered) && /status=open/.test(filtered), filtered);
    const afterFilter = await attempt(() => engine.click(count));
    check("...and the same pre-change ref acts again after it", /^OK: click/.test(afterFilter), afterFilter);
    const resnap = await engine.snapshot();
    check("the next snapshot is a diff whose refs really are stable", /refs (stable|unchanged)/.test(resnap), resnap);
    // The contrast: a route change refuses the old refs, and the next diff does not call them stable.
    const left = await attempt(() => engine.click(other));
    check("a link to another route says the page changed", /page changed — take a new snapshot/.test(left), left);
    const stale = await attempt(() => engine.click(count));
    check(
      "...and a ref from before the route change is refused, saying why",
      /^THREW: Unknown ref/.test(stale) && /dropped when the page moved/.test(stale),
      stale,
    );

    // The contrast within the screen: a filter that swaps the rows leaves other rows under the old paths and test id.
    await engine.navigate("/refs-query.html");
    await engine.snapshot();
    const rowA = refOf(query, /"Open thing A"/);
    await engine.click(refOf(query, /testid=things-filter-closed/));
    const swapped = await attempt(() => engine.click(rowA));
    check(
      "a row's ref is refused once the filter put another row with the same test id under its path",
      /^THREW: Element under e\d+ changed after the URL did \(expected "Open thing A", found "Closed thing C"\)/.test(swapped),
      swapped,
    );

    // ── a re-render that replaces the submit ───────────────────────────────
    await engine.navigate("/refs-rerender.html");
    const form = await engine.snapshot(true);
    const name = refOf(form, /testid=create-name/);
    const submit = refOf(form, /testid=create-submit/);
    await engine.type(name, "Widget");
    const created = await attempt(() => engine.click(submit));
    check(
      "a submit replaced by a re-render is found again by its unique test id, and the result says so",
      /^OK: click/.test(created) && /re-bound after a re-render/.test(created),
      created,
    );
    const createdSnap = await engine.snapshot();
    check("...and it was the submit that acted", /"Created"/.test(createdSnap), createdSnap);
    // The contrast: the same re-render replaced "Discard" with a control that says something else.
    await engine.navigate("/refs-rerender.html");
    const form2 = await engine.snapshot(true);
    await engine.type(refOf(form2, /testid=create-name/), "Widget");
    const discarded = await attempt(() => engine.click(refOf(form2, /testid=create-discard/)));
    check("a replaced control whose name changed is not acted on", /^THREW: Element e\d+ no longer exists/.test(discarded), discarded);

    // ── a revisited route and another tab of a screen diff ─────────────────
    await engine.navigate("/refs-tabs.html?tab=details");
    const details = await engine.snapshot();
    check("a screen never snapshotted is listed in full", /^Interactables \(/m.test(details), details);
    const edit = refOf(details, /testid=record-edit/);
    await engine.click(refOf(details, /testid=tab-history/));
    const history = await engine.snapshot();
    check(
      "another tab of the screen is a diff against the screen's last tab, saying the tab changed",
      /DIFF vs the last snapshot of \/refs-tabs\.html\?tab=details \(tab changed\)/.test(history) &&
        /\+ e\d+ button "Export history"/.test(history) &&
        /- e\d+ "Copy details"/.test(history) &&
        !/^Interactables \(/m.test(history),
      history,
    );
    await engine.navigate("/refs-other.html");
    const away = await engine.snapshot();
    check("a page of another route is listed in full", /^Interactables \(/m.test(away), away);
    await engine.navigate("/refs-tabs.html?tab=history");
    const back = await engine.snapshot();
    check(
      "a revisited route is a diff against its own last snapshot, not a full list",
      /(DIFF vs|No element changes since) this route's last snapshot/.test(back) && !/^Interactables \(/m.test(back),
      back,
    );
    const editAgain = await attempt(() => engine.click(edit));
    check("...and a ref it re-issued acts", /^OK: click/.test(editAgain), editAgain);

    // ── rows: what they afford, and how a filtered list reads ──────────────
    await engine.navigate("/refs-rows.html");
    const rows = await engine.snapshot(true);
    check(
      "a row listed for its test id with a tab stop and a click handler is marked clickable and focusable",
      /generic "Alpha record" \[testid=register-row, clickable, focusable\]/.test(rows),
      rows,
    );
    check(
      "...while the wrapper with only a test id is marked neither",
      /generic "[^"]*" \[testid=register-wrapper\]$/m.test(rows) && !/register-wrapper[^\n]*(clickable|focusable)/.test(rows),
      rows,
    );
    await engine.click(refOf(rows, /testid=register-only-gamma/));
    const gamma = await engine.snapshot();
    check(
      "filtering the rows reads as the rows that went, not as the first row relabeled",
      /- e\d+ "Alpha record"/.test(gamma) && /- e\d+ "Beta record"/.test(gamma) && !/relabeled → "Gamma record"/.test(gamma),
      gamma,
    );

    // ── a dense page says what it cut, and keeps its pager ─────────────────
    await engine.navigate("/refs-dense.html");
    const dense = await engine.snapshot(true);
    check("the pager and the load-more button past the cap are listed", /testid=pager-next/.test(dense) && /testid=list-load/.test(dense), dense.slice(0, 600));
    check(
      "...and the truncation names what was cut, by role and test-id family, the other control past the cap included",
      /TRUNCATED at 150, dense page — cut: \d+ link \[item-\*\], 1 button \[list-archive\]/.test(dense) && !/testid=list-archive/.test(dense),
      dense.split("\n").find((l) => /TRUNCATED/.test(l)) ?? dense.slice(0, 600),
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
