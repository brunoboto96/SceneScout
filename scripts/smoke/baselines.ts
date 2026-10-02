/**
 * Visual baselines end to end: the real CLI against one page served at one
 * path in two variants (test-app/baseline/before/ and after/) that differ only
 * in a card's colours and corners. With no baselines yet, compare lists every
 * target and passes; update writes them; the unchanged page compares at 0% and
 * passes; the restyled card fails the gate with its diff picture while the
 * untouched block beside it still matches; update takes the new look, and the
 * next compare passes again.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, DIFF_HIGHLIGHT } from "../../dist/engine/png.js";
import { BROWSER, check } from "./harness.ts";

export const title = "visual baselines (check --baseline)";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "..", "dist", "cli.js");
const appDir = path.join(here, "..", "..", "test-app");
const variantsDir = path.join(appDir, "baseline");

interface Result {
  path: string;
  element: string;
  status: string;
  detail?: string;
  partial?: string;
  baseline: string;
  diff?: { percent: number; changedPixels: number; sizeChanged: boolean };
  files?: { expected: string; actual: string; diff: string };
}
interface Run {
  status: number | null;
  out: string;
  dir: string;
  results: Result[];
  issues: Array<{ rule: string; severity: string; evidence: string }>;
}

/** Asynchronous on purpose: the page is served from this process, and a synchronous spawn would stop it answering. */
function runCli(args: string[]): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "check", ...args],
      { encoding: "utf8", timeout: 300_000, env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : null) : 0, out: `${stdout}\n${stderr}` }),
    );
  });
}

export async function run(): Promise<void> {
  let variant: "before" | "after" = "before";
  const server = http.createServer((req, res) => {
    const at = (req.url ?? "/").split("?")[0];
    // A page behind a sign-in wall, as an expired session finds it.
    if (at === "/walled.html") {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (at === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(appDir, "login.html")));
      return;
    }
    // A server that hangs up: the load fails, and the browser commits an error page of its own after goto has thrown.
    if (at === "/hang-up.html") {
      req.socket.destroy();
      return;
    }
    if (at !== "/card.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(fs.readFileSync(path.join(variantsDir, variant, "card.html")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "scout-baselines-"));
  const baselines = path.join(work, "visual-baselines");
  fs.mkdirSync(baselines);
  fs.writeFileSync(
    path.join(baselines, "targets.json"),
    JSON.stringify({
      targets: [
        { path: "/card.html" },
        { path: "/card.html", element: "testid=plan" },
        { path: "/card.html", element: "testid=notes" },
        { path: "/card.html", element: "testid=saved" },
      ],
    }),
  );
  const checkWith = async (mode: "compare" | "update", out: string, dir = baselines, more: string[] = []): Promise<Run> => {
    const outDir = path.join(work, out);
    const r = await runCli([`${base}/card.html`, "--project", work, "--out", outDir, "--paths", "/card.html", "--baseline", mode, "--baselines", dir, ...more]);
    const json = fs.existsSync(path.join(outDir, "check.json"))
      ? (JSON.parse(fs.readFileSync(path.join(outDir, "check.json"), "utf8")) as { baselines?: { results: Result[] }; issues: Run["issues"] })
      : { issues: [] };
    return { ...r, dir: outDir, results: json.baselines?.results ?? [], issues: json.issues };
  };
  const of = (r: Run, element: string): Result | undefined => r.results.find((x) => x.element === element);
  const visual = (r: Run) => r.issues.filter((i) => i.rule === "visual-change");
  const stored = (element: string, ext: "png" | "json"): string => {
    const rel = of(taken, element)?.baseline ?? "";
    return path.join(baselines, ...rel.replace(/\.png$/, `.${ext}`).split("/"));
  };
  let taken: Run = { status: null, out: "", dir: "", results: [], issues: [] };
  try {
    const first = await checkWith("compare", "first");
    check(
      "with no baselines yet, compare lists each target as having none, files nothing and passes",
      first.status === 0 && first.results.length === 4 && first.results.every((r) => r.status === "no-baseline") && visual(first).length === 0,
      `${first.status} ${JSON.stringify(first.results)}\n${first.out.slice(-600)}`,
    );

    taken = await checkWith("update", "taken");
    check(
      `update writes a PNG and a JSON per target, in the ${BROWSER} folder`,
      taken.status === 0 &&
        taken.results.every((r) => r.status === "updated" && r.baseline.startsWith(`${BROWSER}/`)) &&
        ["page", "testid=plan", "testid=notes", "testid=saved"].every((e) => fs.existsSync(stored(e, "png")) && fs.existsSync(stored(e, "json"))),
      `${taken.status} ${JSON.stringify(taken.results)}\n${taken.out.slice(-600)}`,
    );
    const meta = JSON.parse(fs.readFileSync(stored("testid=plan", "json"), "utf8")) as {
      path: string;
      element: string;
      engine: string;
      capture: { viewport: { width: number; height: number }; deviceScaleFactor: number; reducedMotion: string; animations: string; caret: string };
      size: { width: number; height: number };
    };
    const planBytes = fs.readFileSync(stored("testid=plan", "png"));
    const png = decodePng(planBytes);
    check(
      "...and each JSON says what it is of and how it was taken: path, element, engine, viewport, scale, motion, animations, caret, size",
      meta.path === "/card.html" &&
        meta.element === "testid=plan" &&
        meta.engine === BROWSER &&
        meta.capture.viewport.width === 1280 &&
        meta.capture.viewport.height === 900 &&
        meta.capture.deviceScaleFactor === 1 &&
        meta.capture.reducedMotion === "reduce" &&
        meta.capture.animations === "disabled" &&
        meta.capture.caret === "hide" &&
        meta.size.width === png.width &&
        meta.size.height === png.height,
      JSON.stringify(meta),
    );
    check("...and the element's picture is the card with its margin, not the page", png.width < 1280 && png.width >= 320, `${png.width}×${png.height}`);
    const notesBytes = fs.readFileSync(stored("testid=notes", "png"));
    const notesWritten = fs.statSync(stored("testid=notes", "png")).mtimeMs;

    const same = await checkWith("compare", "same");
    check(
      "unchanged, every target matches at 0%, the block whose dot slides forever and the banner still sliding into place included, and the gate passes",
      same.status === 0 && same.results.length === 4 && same.results.every((r) => r.status === "matches" && r.diff?.percent === 0) && visual(same).length === 0,
      `${same.status} ${JSON.stringify(same.results)}`,
    );
    check("...and writes no pictures", !fs.existsSync(path.join(same.dir, "visual")));

    variant = "after";
    const restyled = await checkWith("compare", "restyled");
    const card = of(restyled, "testid=plan");
    check(
      "restyled, the card and the page are each past the default 0.1% and reported with the share of their pixels that changed, and the gate fails",
      restyled.status === 1 &&
        card?.status === "changed" &&
        (card.diff?.percent ?? 0) > 0.1 &&
        of(restyled, "page")?.status === "changed" &&
        (of(restyled, "page")?.diff?.percent ?? 0) > 0.1 &&
        visual(restyled).length === 2 &&
        visual(restyled).every((i) => i.severity === "high" && /% of its pixels changed \(\d+ of \d+; allowed: 0\.1%\) — diff: visual\//.test(i.evidence)),
      `${restyled.status} ${JSON.stringify(restyled.results)} ${JSON.stringify(restyled.issues)}`,
    );
    check(
      "...while the block beside the card, the same in both, still matches at 0%",
      of(restyled, "testid=notes")?.status === "matches" && of(restyled, "testid=notes")?.diff?.percent === 0,
      JSON.stringify(of(restyled, "testid=notes")),
    );
    const files = card?.files;
    const diffPicture = files ? decodePng(fs.readFileSync(path.join(restyled.dir, files.diff))) : null;
    const red = (img: NonNullable<typeof diffPicture>): number => {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4)
        if (img.data[i] === DIFF_HIGHLIGHT[0] && img.data[i + 1] === DIFF_HIGHLIGHT[1] && img.data[i + 2] === DIFF_HIGHLIGHT[2]) n++;
      return n;
    };
    check(
      "...with its pictures beside the report: the baseline, the picture now, and the diff with exactly the changed pixels in red",
      !!files &&
        fs.readFileSync(path.join(restyled.dir, files.expected)).equals(fs.readFileSync(stored("testid=plan", "png"))) &&
        fs.existsSync(path.join(restyled.dir, files.actual)) &&
        !!diffPicture &&
        red(diffPicture) === card?.diff?.changedPixels,
      JSON.stringify(files),
    );
    const sarif = fs.readFileSync(path.join(restyled.dir, "check.sarif"), "utf8");
    const report = fs.readFileSync(path.join(restyled.dir, "report.md"), "utf8");
    check(
      "...and the SARIF has it as an error result, and the report a section listing every target",
      /"ruleId": "visual-change"/.test(sarif) &&
        /"level": "error"/.test(sarif) &&
        /## Visual baselines \(4\)/.test(report) &&
        /✗ `testid=plan` on `\/card\.html`/.test(report),
      report.slice(0, 1500),
    );
    check("compare left the baselines as they were", fs.readFileSync(stored("testid=plan", "png")).equals(planBytes));
    // The same restyle with every pixel allowed to change: none of the targets changed size, so each one is within it.
    const allowed = await checkWith("compare", "restyled-allowed", baselines, ["--baseline-threshold", "100"]);
    check(
      "...and with --baseline-threshold 100 the same restyle is within the threshold everywhere, and the gate passes",
      allowed.status === 0 && allowed.results.every((r) => r.status === "matches") && (of(allowed, "testid=plan")?.diff?.percent ?? 0) > 0,
      `${allowed.status} ${JSON.stringify(allowed.results)}`,
    );

    const retaken = await checkWith("update", "retaken");
    check(
      "update takes the new look of the card and the page, and leaves the unchanged block's baseline untouched",
      retaken.status === 0 &&
        of(retaken, "testid=plan")?.status === "updated" &&
        of(retaken, "page")?.status === "updated" &&
        of(retaken, "testid=notes")?.status === "matches" &&
        fs.readFileSync(stored("testid=notes", "png")).equals(notesBytes) &&
        fs.statSync(stored("testid=notes", "png")).mtimeMs === notesWritten,
      `${retaken.status} ${JSON.stringify(retaken.results)}`,
    );

    const retakenPlan = fs.readFileSync(stored("testid=plan", "png"));
    // The same output folder as a run that left pictures, and a file of the project's own beside them.
    const afterDir = path.join(work, "after");
    fs.cpSync(path.join(restyled.dir, "visual"), path.join(afterDir, "visual"), { recursive: true });
    const keptFile = path.join(afterDir, path.dirname(files?.diff ?? "visual/x"), "notes.txt");
    fs.writeFileSync(keptFile, "kept");
    const after = await checkWith("compare", "after");
    check(
      "after the update, compare passes again with every target at 0%",
      after.status === 0 && after.results.every((r) => r.status === "matches" && r.diff?.percent === 0) && visual(after).length === 0,
      `${after.status} ${JSON.stringify(after.results)}`,
    );
    check(
      "...and the pictures an earlier run left in its output folder are gone, while a file it did not write is kept",
      !!files && !fs.existsSync(path.join(afterDir, files.diff)) && fs.existsSync(keptFile) && fs.readFileSync(keptFile, "utf8") === "kept",
      JSON.stringify(fs.readdirSync(path.dirname(keptFile))),
    );

    // A target the page does not have: the project expects to see it, so it fails the gate rather than passing unseen.
    const elsewhere = path.join(work, "missing-baselines");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(
      path.join(elsewhere, "targets.json"),
      JSON.stringify({ targets: [{ path: "/card.html", element: "testid=not-on-the-page" }, { path: "/walled.html" }, { path: "/gone.html" }] }),
    );
    const missing = await checkWith("compare", "missing", elsewhere);
    check(
      "a target the page does not show is not captured, filed high, and fails the gate",
      missing.status === 1 &&
        missing.results[0]?.status === "not-captured" &&
        /nothing visible matches it/.test(missing.results[0]?.detail ?? "") &&
        visual(missing).some((i) => /testid=not-on-the-page on \/card\.html could not be captured/.test(i.evidence)),
      `${missing.status} ${JSON.stringify(missing.results)}`,
    );
    check(
      "...and a page that answers 404 is not captured either, never pictured as the baseline of the error page",
      missing.results[2]?.status === "not-captured" && /the page answered HTTP 404/.test(missing.results[2]?.detail ?? ""),
      JSON.stringify(missing.results[2]),
    );
    // An update that meets a sign-in wall writes no baseline of the sign-in page: not for one target, and not at all when the crawl met it.
    const walled = await checkWith("update", "walled", elsewhere);
    check(
      "update: a target that sends the browser to sign-in is not captured, and no baseline of the sign-in page is written",
      walled.status === 1 &&
        walled.results[1]?.status === "not-captured" &&
        /sent the browser to sign-in \(\/login\)/.test(walled.results[1]?.detail ?? "") &&
        !fs.existsSync(path.join(elsewhere, BROWSER)),
      `${walled.status} ${JSON.stringify(walled.results)}`,
    );
    // The other look, so baselines taken in this run would differ from the stored ones and an update would rewrite them.
    variant = "before";
    const bounced = await runCli([
      `${base}/walled.html`,
      "--project",
      work,
      "--out",
      path.join(work, "bounced"),
      "--paths",
      "/walled.html",
      "--baseline",
      "update",
      "--baselines",
      baselines,
    ]);
    check(
      "update when the check itself only reached sign-in: exit 2, and the baselines are left as they were",
      bounced.status === 2 && /sent the browser to sign-in/.test(bounced.out) && fs.readFileSync(stored("testid=plan", "png")).equals(retakenPlan),
      bounced.out.slice(-600),
    );
    variant = "after";

    // A page whose server hangs up, then a healthy one: the failure is the first target's alone.
    const hangUp = path.join(work, "hang-up-baselines");
    fs.mkdirSync(hangUp);
    fs.writeFileSync(
      path.join(hangUp, "targets.json"),
      JSON.stringify({ targets: [{ path: "/hang-up.html" }, { path: "/card.html", element: "testid=notes" }, { path: "/card.html", element: "testid=tall" }] }),
    );
    const dropped = await checkWith("compare", "hang-up", hangUp);
    check(
      "a page that fails to load is not captured, and the target after it is still pictured",
      dropped.results[0]?.status === "not-captured" && dropped.results[1]?.status === "no-baseline" && dropped.results[1]?.detail === undefined,
      JSON.stringify(dropped.results),
    );
    check(
      "an element taller than the window is pictured where it is inside it, and the result says so",
      dropped.results[2]?.status === "no-baseline" &&
        /only the part inside the 1280×900 window is pictured: the element is 320×1400/.test(dropped.results[2]?.partial ?? "") &&
        !dropped.results[1]?.partial,
      JSON.stringify(dropped.results.slice(1)),
    );

    // Asked for baselines with no targets.json: stopped before a browser starts, never a check that compares nothing.
    const none = await runCli([`${base}/card.html`, "--project", work, "--out", path.join(work, "none"), "--baseline", "compare"]);
    check(
      "compare with no targets.json exits 2 and says what to write",
      none.status === 2 && /there is no .*\.scenescout[\\/]baselines[\\/]targets\.json: list the pages and elements/.test(none.out),
      none.out.slice(-600),
    );
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
