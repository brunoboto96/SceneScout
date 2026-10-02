/**
 * `scenescout <url>` end to end: the built CLI on a machine that looks new.
 *
 * HOME, the Claude Code config directory, npm's global prefix and the temp
 * directory are empty folders of this suite's own, and on POSIX the `claude`
 * and `npm` first on PATH are stand-ins that record any call. The first run
 * must look at the demo app, write its report in the folder it ran in, lead
 * with the three issues to look at first, and change nothing else: no skill,
 * no MCP registration, nothing installed globally, nothing of its own left in
 * the temp directory. It runs in observe mode unless asked for read-only, and
 * a report folder it did not write is never written into.
 *
 * The browser is the one already on this machine (PLAYWRIGHT_BROWSERS_PATH
 * points at it), so the suite never downloads; which build a clean machine
 * downloads is table-tested in install-test, and the download itself is timed
 * by hand from a packed tarball (see the pull request that added this).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs, no types; it exports createDemoServer().
import { createDemoServer } from "../../demo-app/server.mjs";
import { browsersPath } from "../../action/check-action.mjs";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { MemoryStore } from "../../dist/engine/memory.js";
import { runCheck } from "../../dist/check-run.js";
import { FIRST_LOOK_MARKER, firstRunCheckOptions, GUIDE_URL } from "../../dist/first-run.js";
import { BROWSER, check, type SmokeContext } from "./harness.ts";

export const title = "first run (scenescout <url>)";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");
const posix = process.platform !== "win32";

/** Every file and folder under `dir`, relative to it. */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

/** A machine with nothing set up: empty home, config, prefix and temp folders, and recording stand-ins for claude and npm. */
function cleanMachine(root: string): { env: NodeJS.ProcessEnv; dirs: Record<"home" | "claude" | "prefix" | "tmp" | "bin", string>; calls: string } {
  const dirs = {
    home: path.join(root, "home"),
    claude: path.join(root, "claude-config"),
    prefix: path.join(root, "npm-prefix"),
    tmp: path.join(root, "tmp"),
    bin: path.join(root, "bin"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const calls = path.join(root, "calls.log");
  if (posix) {
    for (const name of ["claude", "npm"]) {
      const stub = path.join(dirs.bin, name);
      fs.writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit 1\n`);
      fs.chmodSync(stub, 0o755);
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.claude,
    npm_config_prefix: dirs.prefix,
    NPM_CONFIG_PREFIX: dirs.prefix,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    // The browsers already on this machine, found the way the real home directory finds them.
    PLAYWRIGHT_BROWSERS_PATH: browsersPath(process.env, process.platform, os.homedir()),
    PATH: `${dirs.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    GITHUB_STEP_SUMMARY: "",
  };
  return { env, dirs, calls };
}

/** Asynchronous on purpose: the demo app is served from this process, and a synchronous spawn would stop it answering. */
function runFirst(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 300_000 }, (err, stdout, stderr) =>
      resolve({ status: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout, stderr }),
    );
  });
}

export async function run(ctx: SmokeContext): Promise<void> {
  if (BROWSER !== "chromium") {
    // The jobs that run this suite under another browser do not install Chromium, and a first run drives nothing else.
    console.log(`  (skipped under ${BROWSER}: a first run always drives Chromium; its rules are table-tested in install-test)`);
    return;
  }
  const server = createDemoServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scout-first-run-")));
  try {
    await firstLookAtTheDemo(base, root);
    await timeBudget(base, root);
    await outNotWritable(base, root);
    await someoneElsesFolder(base, root);
    await observeByDefault(ctx, root);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  try {
    await unreachable(base, root);
    await goneAfterFirstPage(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function firstLookAtTheDemo(base: string, root: string): Promise<void> {
  const machine = cleanMachine(path.join(root, "clean"));
  const work = path.join(root, "clean", "work");
  fs.mkdirSync(work);
  const out = await runFirst([`${base}/`], work, machine.env);
  const said = `${out.stdout}\n${out.stderr}`;
  check("a first run of the demo app exits 0 with findings in it: it is a look, not a gate", out.status === 0, said.slice(-2000));

  const lines = out.stdout.split("\n");
  const at = lines.indexOf("Look at these first:");
  check("the summary opens with the issues to look at first", at > 0, said.slice(-2000));
  const top = lines.slice(at + 1, at + 4);
  check(
    "...the three of them, worst and widest first, the chart's 404 once rather than as a request and a broken image",
    /^ {2}1\. \[medium\] Request failed with a client error: GET \/img\/weekly-chart\.png → HTTP 404 \(on \/\)$/.test(top[0] ?? "") &&
      /^ {2}2\. \[medium\] Dead end: \/reports-scheduled\.html: 0 controls/.test(top[1] ?? "") &&
      /^ {2}3\. \[medium\] Control covered by pinned chrome: button "Save notes"/.test(top[2] ?? "") &&
      !lines.slice(at + 1, at + 5).some((l) => /Broken image|Console error/.test(l)),
    top.join("\n"),
  );
  check(
    "...then the counts, where the report is, and one line on what to try next with the guide's address",
    // A loaded runner can pass the minute, which the summary writes as "1 min 5 s".
    lines.some((l) => /^12 pages looked at in (?:\d+ min )?\d+ s in observe mode: 0 high · 6 medium · 2 low/.test(l)) &&
      lines.includes(`Report: ${path.join("scenescout-report", "report.md")}`) &&
      lines.some((l) => l.startsWith("Next: ") && l.endsWith(GUIDE_URL)),
    out.stdout.slice(-1500),
  );

  const reportDir = path.join(work, "scenescout-report");
  const report = fs.existsSync(path.join(reportDir, "report.md")) ? fs.readFileSync(path.join(reportDir, "report.md"), "utf8") : "";
  check(
    "the report is written in the folder it ran in, and opens with the same three",
    report.startsWith("# SceneScout first look\n") &&
      /## Look at these first\n\n1\. \[medium\] \*\*Request failed with a client error\*\*.*\n2\. \[medium\] \*\*Dead end\*\*.*\n3\. \[medium\] \*\*Control covered by pinned chrome\*\*/.test(
        report,
      ),
    report.slice(0, 1200),
  );
  check(
    "...beside its JSON summary, a .gitignore that keeps the folder out of commits and the marker that makes it a first look's",
    JSON.stringify(tree(reportDir)) === JSON.stringify([".gitignore", FIRST_LOOK_MARKER, "check.json", "report.md"]) &&
      fs.readFileSync(path.join(reportDir, ".gitignore"), "utf8").split("\n").includes("*"),
    JSON.stringify(tree(reportDir)),
  );
  const json = fs.existsSync(path.join(reportDir, "check.json"))
    ? (JSON.parse(fs.readFileSync(path.join(reportDir, "check.json"), "utf8")) as { timeBudget?: unknown })
    : {};
  check(
    "...and the JSON records the time budget and that it did not run out",
    JSON.stringify(json.timeBudget) === JSON.stringify({ ms: 180_000, reached: false }),
    JSON.stringify(json.timeBudget),
  );
  check(
    "nothing else is written in the folder it ran in",
    JSON.stringify(fs.readdirSync(work)) === JSON.stringify(["scenescout-report"]),
    JSON.stringify(fs.readdirSync(work)),
  );

  // What `install` would have changed, and a first run must not.
  const { dirs } = machine;
  check("no skill: the Claude Code config directory is untouched", tree(dirs.claude).length === 0, JSON.stringify(tree(dirs.claude)));
  check("nothing installed globally: npm's prefix is untouched", tree(dirs.prefix).length === 0, JSON.stringify(tree(dirs.prefix)));
  const homeHits = tree(dirs.home).filter((p) => /claude|scenescout|npm/i.test(p));
  check("no MCP registration or skill under the home directory either", homeHits.length === 0, JSON.stringify(tree(dirs.home)));
  if (posix) {
    const calls = fs.existsSync(machine.calls) ? fs.readFileSync(machine.calls, "utf8") : "";
    check("neither claude nor npm was ever run", calls === "", calls);
  }
  const ownLeftovers = tree(dirs.tmp).filter((p) => /^scenescout-/.test(p));
  check("its scratch folders are gone from the temp directory", ownLeftovers.length === 0, JSON.stringify(ownLeftovers));
}

/**
 * The time limit: the crawl starts no route once its deadline has passed, and
 * a check given a time budget measures the page it was given and says the
 * budget ran out. Each with its contrast: the same calls with time to spare,
 * and a page cap reached before the time ran out.
 */
async function timeBudget(base: string, root: string): Promise<void> {
  const project = path.join(root, "budget");
  fs.mkdirSync(project);
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: base, projectDir: project, memoryStore: new MemoryStore(path.join(project, "memory")), mode: "read-only", browser: "chromium" });
    await engine.crawl(["/", "/orders.html"], { deadline: Date.now() - 1 });
    const none = engine.lastCrawlHealth.length;
    await engine.crawl(["/", "/orders.html"], { deadline: Date.now() + 120_000 });
    const both = engine.lastCrawlHealth.length;
    check("a crawl past its deadline starts no route; with time left it visits them all", none === 0 && both === 2, `${none} then ${both}`);
  } finally {
    await engine.close();
  }
  const options = (budgetMs: number, maxRoutes = 20) => ({
    ...firstRunCheckOptions({ url: `${base}/`, maxRoutes, maxMinutes: 3, mode: "observe" }, project),
    timeBudgetMs: budgetMs,
  });
  const spent = await runCheck(options(1));
  check(
    "a run whose budget is spent still measures the start page, lists the rest as not visited and says the time ran out",
    spent.routes.length === 1 && spent.routes[0].path === "/" && spent.unvisited.length > 0 && spent.timeBudget?.reached === true,
    JSON.stringify({ routes: spent.routes.map((r) => r.path), unvisited: spent.unvisited, timeBudget: spent.timeBudget }),
  );
  const capped = await runCheck(options(1, 1));
  check(
    "...but when the page cap was reached first, the time is not what stopped it",
    capped.routes.length === 1 && capped.unvisited.length > 0 && capped.timeBudget?.reached === false,
    JSON.stringify({ routes: capped.routes.length, unvisited: capped.unvisited.length, timeBudget: capped.timeBudget }),
  );
  const ample = await runCheck(options(180_000));
  check(
    "...and with time to spare it reaches every page, and the time did not run out",
    ample.routes.length === 12 && ample.unvisited.length === 0 && ample.timeBudget?.reached === false,
    JSON.stringify({ routes: ample.routes.length, unvisited: ample.unvisited, timeBudget: ample.timeBudget }),
  );
}

/** A --out that cannot be the report's folder ends the run before any page is opened, not after the look. */
async function outNotWritable(base: string, root: string): Promise<void> {
  const machine = cleanMachine(path.join(root, "out"));
  const work = path.join(root, "out", "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "taken"), "a file where the folder would go");
  const out = await runFirst([`${base}/`, "--out", "taken"], work, machine.env);
  check(
    "a --out that is a file exits 2 before the look starts",
    out.status === 2 && /--out .*taken is a file, not a folder/.test(out.stderr) && !out.stdout.includes("Looking at"),
    `${out.status}\n${out.stdout.slice(-400)}\n${out.stderr.slice(-400)}`,
  );
}

/**
 * A scenescout-report/ already here that a first look did not write: exit 2
 * before the look, pointing at --out, with everything in it as it was.
 */
async function someoneElsesFolder(base: string, root: string): Promise<void> {
  const machine = cleanMachine(path.join(root, "theirs"));
  const work = path.join(root, "theirs", "work");
  const folder = path.join(work, "scenescout-report");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "report.md"), "my own report");
  const out = await runFirst([`${base}/`], work, machine.env);
  check(
    "a scenescout-report/ a first look did not write exits 2 before the look, suggests --out, and is left as it was",
    out.status === 2 &&
      /scenescout-report already exists and holds files a first look did not write, so nothing in it is touched\. Pass --out <folder>/.test(out.stderr) &&
      !out.stdout.includes("Looking at") &&
      JSON.stringify(tree(folder)) === JSON.stringify(["report.md"]) &&
      fs.readFileSync(path.join(folder, "report.md"), "utf8") === "my own report",
    `${out.status}\n${out.stdout.slice(-400)}\n${out.stderr.slice(-400)}\n${JSON.stringify(tree(folder))}`,
  );
}

/**
 * The write mode, against a page that records each visit with a plain POST as
 * it loads. Observe, the default, refuses it before it leaves the page;
 * --mode read-only lets it through. Same page, same command, the one option
 * apart, and the server's own count of what reached it is the evidence.
 */
async function observeByDefault({ baseUrl, stats }: SmokeContext, root: string): Promise<void> {
  const page = `${baseUrl}/first-look-post.html`;
  const visits = (): number => stats.writes["POST /api/visits"] ?? 0;
  const machine = cleanMachine(path.join(root, "modes"));
  const observeDir = path.join(root, "modes", "observe");
  fs.mkdirSync(observeDir);
  const before = visits();
  const observed = await runFirst([page], observeDir, machine.env);
  const afterObserve = visits();
  const observedJson = path.join(observeDir, "scenescout-report", "check.json");
  const observedIssues = fs.existsSync(observedJson)
    ? JSON.stringify((JSON.parse(fs.readFileSync(observedJson, "utf8")) as { issues?: unknown }).issues ?? null)
    : "";
  check(
    "observe, the default: the POST a page sends as it loads never reaches the server, and the summary and its first lines say observe",
    observed.status === 0 &&
      afterObserve === before &&
      /^1 page looked at in \d+ s in observe mode: /m.test(observed.stdout) &&
      /^In observe mode nothing but GET, HEAD and OPTIONS requests leaves the page/m.test(observed.stdout),
    `${observed.status} visits ${before} → ${afterObserve}\n${observed.stdout.slice(-600)}\n${observed.stderr.slice(-300)}`,
  );
  check(
    "...and the refusal is not reported as the app's: no issue names the refused request",
    observedIssues !== "" && !observedIssues.includes("/api/visits"),
    observedIssues,
  );
  // Read-only, with an --out folder that does not exist yet: it is created once the page has answered.
  const readOnlyDir = path.join(root, "modes", "read-only");
  fs.mkdirSync(readOnlyDir);
  const ro = await runFirst([page, "--mode", "read-only", "--out", "looks/ro"], readOnlyDir, machine.env);
  const afterReadOnly = visits();
  check(
    "...and with --mode read-only the same POST reaches it, and the summary says read-only",
    ro.status === 0 && afterReadOnly > afterObserve && /^1 page looked at in \d+ s in read-only mode: /m.test(ro.stdout),
    `${ro.status} visits ${afterObserve} → ${afterReadOnly}\n${ro.stdout.slice(-600)}\n${ro.stderr.slice(-300)}`,
  );
  check(
    "...its --out folder holding the report and the marker, and nothing else written beside it",
    JSON.stringify(tree(path.join(readOnlyDir, "looks", "ro"))) === JSON.stringify([FIRST_LOOK_MARKER, "check.json", "report.md"]) &&
      JSON.stringify(fs.readdirSync(readOnlyDir)) === JSON.stringify(["looks"]),
    JSON.stringify(tree(readOnlyDir)),
  );
}

/** An address nothing answers on: exit 2, a sentence saying so, no report, and the --out folder never created. */
async function unreachable(closedBase: string, root: string): Promise<void> {
  const machine = cleanMachine(path.join(root, "down"));
  const work = path.join(root, "down", "work");
  fs.mkdirSync(work);
  const out = await runFirst([`${closedBase}/`, "--out", "later/report"], work, machine.env);
  check(
    "an address that cannot be reached exits 2, says so, writes no report and creates no --out folder",
    // Attach loads the start page first, so the refusal usually comes from there; a crawl that loaded nothing says it after.
    out.status === 2 &&
      /could not reach http:\/\/127\.0\.0\.1:\d+\/|Could not load http:\/\/127\.0\.0\.1:\d+ — is the app running\?/.test(out.stderr) &&
      fs.readdirSync(work).length === 0,
    `${out.status}\n${out.stdout.slice(-600)}\n${out.stderr.slice(-600)}\n${JSON.stringify(fs.readdirSync(work))}`,
  );
}

/**
 * An address that answers its first request and is gone before the next:
 * attaching loads the page, and every page the crawl then asks for fails. The
 * look found nothing it could measure, so it exits 2 with its own sentence and
 * writes no report, where a closed port fails earlier, at attach.
 */
async function goneAfterFirstPage(root: string): Promise<void> {
  const sockets = new Set<Socket>();
  let served = 0;
  const server = http.createServer((req, res) => {
    if (served++ > 0) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end('<!doctype html><html lang="en"><title>Once</title><a href="/next">Next</a></html>');
    server.close();
    res.on("finish", () => {
      for (const s of sockets) s.destroy();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const machine = cleanMachine(path.join(root, "gone"));
    const work = path.join(root, "gone", "work");
    fs.mkdirSync(work);
    const out = await runFirst([`${base}/`], work, machine.env);
    check(
      "an address that stops answering after its first page exits 2, says it could not reach it, and writes no report",
      out.status === 2 &&
        new RegExp(`could not reach ${base.replace(/[.]/g, "\\.")}/: `).test(out.stderr) &&
        !out.stdout.includes("Look at these first") &&
        fs.readdirSync(work).length === 0,
      `${out.status}\n${out.stdout.slice(-600)}\n${out.stderr.slice(-600)}\n${JSON.stringify(fs.readdirSync(work))}`,
    );
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
}
