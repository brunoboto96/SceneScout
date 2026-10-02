/**
 * MCP wire-up check: spawns the built server over stdio, lists tools, calls
 * scout_scan to prove the protocol layer works end to end, and asserts the SKILL
 * documents every tool the server exposes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";
import { introQuestions } from "../dist/intake.js";
import { shellQuote, writeProfile } from "../dist/engine/profiles.js";
import { siteFolderName } from "../dist/engine/project-folder.js";
import { revokeFixtureTokens, settle, SIGN_IN_COOKIE, startFixtureServer, TOKEN_COOKIE, WAIT_MS } from "./smoke/harness.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "mcp-server.js");
const packageRoot = path.join(here, "..");

const EXPECTED_TOOLS = [
  "scout_playbook",
  "scout_lane_report",
  "scout_scan",
  "scout_attach",
  "scout_login",
  "scout_session",
  "scout_journey",
  "scout_note",
  "scout_snapshot",
  "scout_click",
  "scout_type",
  "scout_upload",
  "scout_hover",
  "scout_select",
  "scout_navigate",
  "scout_network",
  "scout_back",
  "scout_press",
  "scout_scroll",
  "scout_screenshot",
  "scout_capture",
  "scout_finding",
  "scout_crawl",
  "scout_run_plan",
  "scout_design_audit",
  "scout_resolve",
  "scout_coverage",
  "scout_report",
  "scout_close",
];

type ToolText = { content: Array<{ type: string; text?: string }> };
const textOf = (result: unknown): string => (result as ToolText).content.map((c) => c.text ?? "").join("");
const LIVE_LINE = /Live view: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{16,}\/)/;

function fail(message: string): never {
  console.error(`MCP CHECK FAILED — ${message}`);
  process.exit(1);
}

/** A cleanup close that is refused leaves browsers running; fail rather than leak them. */
function assertClosedAll(reply: string): void {
  if (!reply.includes("All sessions closed")) fail(`scout_close { all: true } did not close every session:\n${reply}`);
}

/**
 * The person running the agent gets the live view's address from the agent:
 * attach has to carry it, and it has to work. Checked over the wire because
 * the hand-off lives in the server, not in the engine the smoke suite drives.
 */
/** Resolves to the project directory, whose token file main() checks is gone once the client has closed the connection. */
async function liveViewCheck(client: Client): Promise<string> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-live-"));
  try {
    const attached = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, session: "watched" } }));
    const url = LIVE_LINE.exec(attached)?.[1];
    if (!url) fail(`scout_attach did not hand over a live view address:\n${attached}`);

    const status = (await (await fetch(`${url}api/status`)).json()) as { sessions: Array<{ session: string }> };
    if (!status.sessions.some((s) => s.session === "watched"))
      fail(`the address from scout_attach does not show the attached session: ${JSON.stringify(status)}`);

    const report = (await (await fetch(`${url}api/report`)).json()) as { markdown?: string };
    if (!report.markdown?.startsWith("# SceneScout Report")) fail(`the live view does not render the run's report: ${JSON.stringify(report).slice(0, 200)}`);
    if (fs.existsSync(path.join(projectDir, ".scenescout", "report.md"))) fail("reading the report from the live view wrote it to disk");

    // A tool that acts is refused until the session has said what it is doing,
    // because the live view can only show what the agent states.
    const refused = textOf(await client.callTool({ name: "scout_navigate", arguments: { target: "/page2.html", session: "watched" } }));
    if (!/needs a task/.test(refused)) fail(`scout_navigate acted with no task standing:\n${refused}`);
    const stated = textOf(
      await client.callTool({ name: "scout_navigate", arguments: { target: "/page2.html", session: "watched", task: "Walk the two static pages" } }),
    );
    if (/needs a task/.test(stated)) fail(`scout_navigate refused a task it was given:\n${stated}`);
    const kept = textOf(await client.callTool({ name: "scout_navigate", arguments: { target: "/", session: "watched" } }));
    if (/needs a task/.test(kept)) fail("the task did not stay set for the rest of the batch");
    const showing = (await (await fetch(`${url}api/status`)).json()) as { sessions: Array<{ task?: string }> };
    if (showing.sessions[0]?.task !== "Walk the two static pages") fail(`the live view does not show the task: ${JSON.stringify(showing.sessions[0])}`);
    // Reading the page needs none: orienting is what comes before saying.
    const snapped = textOf(await client.callTool({ name: "scout_snapshot", arguments: { session: "watched" } }));
    if (/needs a task/.test(snapped)) fail("scout_snapshot should not need a task");
    console.log("✓ a tool that acts needs a task, and it reaches the live view");

    const facts = (await (await fetch(`${url}api/status`)).json()) as { report?: { path: string; written: boolean } };
    if (facts.report?.path !== path.join(projectDir, ".scenescout", "report.md"))
      fail(`the live view does not name the report's file: ${JSON.stringify(facts.report)}`);
    if (facts.report.written) fail("the report is reported as written although scout_report was never called");

    const listed = textOf(await client.callTool({ name: "scout_session", arguments: {} }));
    if (LIVE_LINE.exec(listed)?.[1] !== url) fail(`scout_session does not repeat the same address:\n${listed}`);

    const tokenFile = path.join(projectDir, ".scenescout", "live-token");
    const mode = fs.statSync(tokenFile).mode & 0o777;
    if (process.platform !== "win32" && mode !== 0o600) fail(`the token file is readable beyond its owner (mode ${mode.toString(8)})`);
    if (!url.includes(fs.readFileSync(tokenFile, "utf8").trim())) fail("the token file and the address disagree");

    // What `scenescout watch` builds its address from: the port in status.json plus the token file.
    const written = await readStatusWhenWhole<{ live?: { port?: number } }>(projectDir);
    if (written.live?.port !== Number(new URL(url).port)) fail(`status.json does not carry the live view's port: ${JSON.stringify(written.live)}`);
    const cli = path.join(packageRoot, "dist", "cli.js");
    const watched = spawnSync(process.execPath, [cli, "watch", "--no-open", projectDir], { encoding: "utf8" });
    if (!watched.stdout.includes(url)) fail(`scenescout watch does not print the address scout_attach handed over:\n${watched.stdout}${watched.stderr}`);
    const printed = spawnSync(process.execPath, [cli, "status", projectDir], { encoding: "utf8" }).stdout;
    if (!/^\s+watched \(/m.test(printed) || !printed.includes("Live view: scenescout watch"))
      fail(`scenescout status does not describe the session and point at watch:\n${printed}`);

    // The run's end is when somebody wants the report, and the engines are
    // gone by then: the view has to keep serving what the run found.
    assertClosedAll(textOf(await client.callTool({ name: "scout_close", arguments: { all: true } })));
    const afterClose = (await (await fetch(`${url}api/report`)).json()) as { markdown?: string };
    if (!afterClose.markdown?.startsWith("# SceneScout Report"))
      fail(`the report is gone once the run's sessions closed: ${JSON.stringify(afterClose).slice(0, 200)}`);
    const emptied = (await (await fetch(`${url}api/status`)).json()) as { sessions: unknown[]; report?: { path: string } };
    if (emptied.sessions.length !== 0) fail("a closed session is still on the board");
    if (!emptied.report?.path) fail("the report's file is no longer named once the run has finished");

    console.log("✓ scout_attach hands over a working live view address, and status/watch read it back");
    console.log("✓ the report outlives the run's sessions, with the path it belongs at");
  } finally {
    await fixture.close();
  }
  return projectDir;
}

/**
 * Lane briefs for a session attached by a saved role check that login lasts
 * the run first. The check and its two settings live in the server's
 * scout_lane_brief, so they are driven over the wire: a login that ends
 * inside the run is refused, the same login passes a shorter run or a smaller
 * margin, and one credential ending early beside a long-lived one is a warning
 * on top of the briefs.
 */
async function expiryBriefCheck(client: Client): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-expiry-"));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  const nowS = Math.floor(Date.now() / 1000);
  const cookie = (name: string, minutes: number) => ({
    name,
    value: "member",
    domain: "127.0.0.1",
    path: "/",
    expires: nowS + minutes * 60,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
  // One login that ends in 30 minutes; one whose first cookie ends in 20 but whose other lasts 30 days.
  writeProfile(projectDir, "short", { cookies: [cookie(SIGN_IN_COOKIE, 30)], origins: [] });
  writeProfile(projectDir, "mixed", { cookies: [cookie(SIGN_IN_COOKIE, 20), cookie("remember_me", 30 * 24 * 60)], origins: [] });
  const brief = (session: string, extra: Record<string, unknown> = {}): Promise<string> =>
    call("scout_lane_brief", { session, lanes: 2, routes: ["/orders/a", "/reports/b"], ...extra });
  const briefed = (reply: string): boolean => reply.includes("── orders ──") && reply.includes("── reports ──");
  try {
    for (const role of ["short", "mixed"]) {
      await call("scout_attach", {
        url: `${fixture.baseUrl}/cookie-account`,
        projectPath: projectDir,
        session: role,
        mode: "read-only",
        role,
        objective: `${role} planner`,
      });
    }
    const refused = await brief("short");
    if (!/will not last the run: it ends in \d+m\d\ds \(cookie "fixture_session"\)/.test(refused) || briefed(refused))
      fail(`a login ending inside the default run was not refused:\n${refused}`);
    if (!refused.includes("scenescout login")) fail(`the refusal did not name the command that records the login again:\n${refused}`);
    const shorter = await brief("short", { runMinutes: 15, expiryMarginMinutes: 5 });
    if (!briefed(shorter) || shorter.includes("⚠")) fail(`a run that fits inside the login was not briefed plainly:\n${shorter}`);
    const tightMargin = await brief("short", { runMinutes: 25, expiryMarginMinutes: 10 });
    if (!/will not last the run/.test(tightMargin)) fail(`the margin was not counted: 25 + 10 minutes outlasts a 30-minute login:\n${tightMargin}`);
    const noMargin = await brief("short", { runMinutes: 25, expiryMarginMinutes: 0 });
    if (!briefed(noMargin)) fail(`a zero margin was not honoured:\n${noMargin}`);
    console.log("✓ scout_lane_brief refuses a saved login that ends inside the run, counting runMinutes and expiryMarginMinutes");
    const warned = await brief("mixed", { runMinutes: 30, expiryMarginMinutes: 0 });
    if (
      !/^⚠ In the saved sign-in for role "mixed", cookie "fixture_session" expires in \d+m\d\ds/.test(warned.replace(/^\[session [^\]]*\]\n/, "")) ||
      !briefed(warned)
    )
      fail(`a credential ending inside the run beside a long-lived one was not a warning above the briefs:\n${warned}`);
    console.log("✓ ...and warns, still briefing, when only one of several credentials ends inside it");
    assertClosedAll(await call("scout_close", { all: true }));
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * Evidence by default: a filed finding carries a picture on disk, in the
 * scout_finding result as image content, and in report.html; one that names
 * an element frames it; the inline count stops further pictures coming back
 * while they are still kept; and a session with pictures off takes none.
 */
async function findingPictureCheck(client: Client): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-pictures-"));
  const callRaw = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
  const imagesOf = (r: Awaited<ReturnType<typeof callRaw>>) => r.content.filter((c) => c.type === "image");
  const file = (n: number) => ({
    session: "pictures",
    severity: "low",
    category: "ux-confusing",
    // Words and evidence no dedup rule joins: each filing is its own finding.
    title: ["The action button shows no focus ring", "A paragraph runs far wider than reads comfortably", "An uppercase label shouts"][n - 1],
    detail: `Filed to check pictures (${n}).`,
    evidence: `picture check ${n}`,
  });
  try {
    await callRaw("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "pictures", mode: "read-only", objective: "pictures" });
    const snap = textOf(await callRaw("scout_snapshot", { session: "pictures" }));
    const ref = /(e\d+) button "Focusless action"/.exec(snap)?.[1];
    if (!ref) fail(`the fixture's button was not in the snapshot:\n${snap.slice(0, 400)}`);
    // The element named: framed, on disk, and returned as a PNG the client shows.
    const named = await callRaw("scout_finding", { ...file(1), ref });
    const namedText = textOf(named);
    const images = imagesOf(named);
    if (images.length !== 1 || images[0].mimeType !== "image/png") fail(`a filed finding returned no picture:\n${namedText}`);
    const sent = Buffer.from(images[0].data ?? "", "base64");
    const kept = /📷 Picture \((\d+)×(\d+), "Focusless action" and around it\): (\S+\.png)/.exec(namedText);
    if (!kept) fail(`the result did not say what the picture frames and where it is:\n${namedText}`);
    if (!fs.existsSync(kept[3]) || !fs.readFileSync(kept[3]).equals(sent)) fail(`the picture on disk is not the one returned: ${kept[3]}`);
    if (
      !kept[3].startsWith(path.join(fs.realpathSync(projectDir), ".scenescout", "recordings")) &&
      !kept[3].startsWith(path.join(projectDir, ".scenescout", "recordings"))
    )
      fail(`the picture was not kept under the project's .scenescout/recordings: ${kept[3]}`);
    // An element plus its margin is smaller than the 1280-wide viewport.
    if (Number(kept[1]) >= 1000) fail(`a picture of one button is ${kept[1]} wide: it framed the page, not the element`);
    console.log("✓ scout_finding keeps a picture of the element it names and returns it as image content");
    // No element named: the viewport, bounded to the default longer side.
    const page = await callRaw("scout_finding", file(2));
    const pageShot = /📷 Picture \((\d+)×(\d+), the page as it was/.exec(textOf(page));
    if (!pageShot || imagesOf(page).length !== 1) fail(`a finding naming no element did not picture the page:\n${textOf(page)}`);
    if (Math.max(Number(pageShot[1]), Number(pageShot[2])) > 800) fail(`the page's picture is over the 800px default: ${pageShot[0]}`);
    const report = textOf(await callRaw("scout_report", { session: "pictures", level: "minimal", force: true }));
    const html = fs.readFileSync(path.join(projectDir, ".scenescout", "report.html"), "utf8");
    const md = fs.readFileSync(path.join(projectDir, ".scenescout", "report.md"), "utf8");
    if (!/<figure class="picture">/.test(html) || !/src="recordings\/pictures\/finding-[0-9a-f]+\.png"/.test(html))
      fail(`report.html does not show the findings' pictures:\n${report.slice(0, 300)}`);
    if (!/- \*\*Picture:\*\* `recordings\/pictures\/finding-[0-9a-f]+\.png`/.test(md)) fail("report.md does not name the findings' pictures");
    // memory.json keeps `picture` as a plain path relative to .scenescout/, which is how every reader of a finding takes it.
    const stored = JSON.parse(fs.readFileSync(path.join(projectDir, ".scenescout", "memory.json"), "utf8")) as { findings: Array<{ picture?: unknown }> };
    const paths = stored.findings.map((f) => f.picture).filter((p) => p !== undefined);
    if (
      paths.length < 2 ||
      !paths.every(
        (p) => typeof p === "string" && /^recordings\/pictures\/finding-[0-9a-f]+\.png$/.test(p) && fs.existsSync(path.join(projectDir, ".scenescout", p)),
      )
    )
      fail(`memory.json does not keep each picture as a path relative to .scenescout/: ${JSON.stringify(paths)}`);
    // Taking a picture is no step anyone took: the next finding's repro trace does not list it.
    if (/^\d+\. capture /m.test(md)) fail(`a finding's picture appears as a step in a repro trace:\n${md}`);
    console.log("✓ report.html shows each finding's picture, and report.md names it");
    // A session with pictures off takes none, and its result has no image.
    await callRaw("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "plain", mode: "read-only", objective: "plain", evidence: "off" });
    const off = await callRaw("scout_finding", { ...file(3), session: "plain" });
    if (imagesOf(off).length !== 0 || /📷/.test(textOf(off))) fail(`a session with pictures off took one:\n${textOf(off)}`);
    if (fs.readdirSync(path.join(projectDir, ".scenescout", "recordings")).includes("plain")) fail("a session with pictures off wrote a picture");
    console.log('✓ evidence: "off" takes no picture');
    // Pictures stay out of git: the folder ignores itself.
    if (
      !fs
        .readFileSync(path.join(projectDir, ".scenescout", ".gitignore"), "utf8")
        .split("\n")
        .includes("*")
    )
      fail(".scenescout/ does not ignore its pictures");
    assertClosedAll(await callRaw("scout_close", { all: true }).then(textOf));
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** The inline count: past it, a session's pictures are kept and named but no longer returned. */
async function findingPictureCapCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-picture-cap-"));
  const client = new Client({ name: "ft-check-picture-cap", version: "0.0.1" });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: { ...env, SCENESCOUT_LIVE: "off", SCENESCOUT_EVIDENCE: "inline", SCENESCOUT_EVIDENCE_INLINE: "1", SCENESCOUT_EVIDENCE_MAX_PX: "400" },
    }),
  );
  try {
    await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, mode: "read-only", objective: "cap" } });
    const filings = [];
    for (const n of [1, 2]) {
      filings.push(
        (await client.callTool({
          name: "scout_finding",
          arguments: {
            severity: "low",
            category: "ux-confusing",
            title: n === 1 ? "The save button is hard to find" : "Two headings say the same thing",
            detail: `Filed to check the cap (${n}).`,
            evidence: `cap check ${n}`,
          },
        })) as {
          content: Array<{ type: string; text?: string }>;
        },
      );
    }
    const [first, second] = filings;
    if (first.content.filter((c) => c.type === "image").length !== 1) fail(`the first picture under a count of 1 was not returned:\n${textOf(first)}`);
    if (second.content.some((c) => c.type === "image")) fail(`a picture past SCENESCOUT_EVIDENCE_INLINE=1 was returned:\n${textOf(second)}`);
    if (!/Not shown here: this session has returned its 1/.test(textOf(second))) fail(`a capped picture was not named as kept:\n${textOf(second)}`);
    const size = /📷 Picture \((\d+)×(\d+)/.exec(textOf(second));
    if (!size || Math.max(Number(size[1]), Number(size[2])) > 400) fail(`SCENESCOUT_EVIDENCE_MAX_PX=400 was not applied:\n${textOf(second)}`);
    console.log("✓ past SCENESCOUT_EVIDENCE_INLINE a picture is kept but not returned, and SCENESCOUT_EVIDENCE_MAX_PX bounds its size");
    await client.callTool({ name: "scout_close", arguments: { all: true } });
  } finally {
    await client.close();
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * A parallel run over the wire: the planner reports while a lane did the
 * auditing, and a lane's report is folded with what it judged and never filed.
 * Both live in the server (the gate and the fold), not in the engine the smoke
 * suite drives.
 */
async function laneCheck(client: Client): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-lanes-"));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  try {
    for (const session of ["planner", "orders"]) {
      await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session, mode: "read-only", objective: `${session} lane` });
    }
    const early = await call("scout_report", { session: "planner", level: "minimal" });
    if (!/No scout_design_audit was run in this run/.test(early))
      fail(`the gate let a run with no audit through:
${early.slice(0, 400)}`);
    await call("scout_design_audit", { session: "orders" });
    const late = await call("scout_report", { session: "planner", level: "minimal" });
    if (/No scout_design_audit/.test(late))
      fail(`a lane's audit did not count for the planner's report:
${late.slice(0, 400)}`);
    console.log("✓ the report gate counts a design audit from any session in the run");

    const report = (evidence: string): string =>
      JSON.stringify({
        lane: "orders",
        status: "complete",
        decisions: [{ observation: "email-no-label", verdict: "defect", severity: "low", category: "a11y", confidence: 0.8, evidence }],
        routes: ["/"],
        blocked_by: null,
      });
    // A lane whose only fold was refused keeps its session: closing it would
    // leave the corrected report nowhere to keep its decisions.
    const refusedFold = await call("scout_lane_report", { lane: "orders", reply: "{not json" });
    if (!/Lane report REFUSED/.test(refusedFold)) fail(`a malformed lane report was not refused:\n${refusedFold}`);
    const earlyClose = await call("scout_close", { session: "orders" });
    if (!/Not closed/.test(earlyClose) || !/force: true/.test(earlyClose)) fail(`a lane with only a refused fold was closed:\n${earlyClose}`);
    const earlyAll = await call("scout_close", { all: true });
    if (!/Not closed/.test(earlyAll) || !earlyAll.includes('· "orders"') || earlyAll.includes('· "planner"'))
      fail(`closing every session did not stop at exactly the unfolded lane:\n${earlyAll}`);
    if (!earlyAll.includes('scout_close { session: "planner" }')) fail(`closing every session did not offer the others by name:\n${earlyAll}`);
    console.log("✓ scout_close keeps a lane whose report has not been folded, and names it");
    const unfiled = await call("scout_lane_report", {
      lane: "orders",
      reply: "Here is my report:\n```json\n" + report("input[name=email] has no label") + "\n```\nDone.",
    });
    if (!/Lane report accepted/.test(unfiled) || !/discarded unread/.test(unfiled))
      fail(`prose around one fenced report was not accepted and disclosed:\n${unfiled}`);
    if (!/1 judged defect\(s\) have no finding/.test(unfiled) || !unfiled.includes("email-no-label"))
      fail(`an unfiled defect was not named at the fold:\n${unfiled}`);
    await call("scout_finding", {
      session: "orders",
      severity: "low",
      category: "a11y",
      title: "Email field has no label",
      detail: "The field is announced without a name.",
      evidence: "input[name=email] has no label",
    });
    // A filing merged into an existing finding names it — severity, title and
    // evidence — so a lane whose different bug was absorbed can see it and file again.
    const merged = await call("scout_finding", {
      session: "orders",
      severity: "medium",
      category: "a11y",
      title: "The email input is unnamed",
      detail: "Screen readers announce no name.",
      evidence: "input[name=email] has no label",
    });
    if (!/Not recorded as new: merged into existing finding \w+ — \[low\] Email field has no label \(evidence: input\[name=email\] has no label\)/.test(merged))
      fail(`a merged filing did not name the finding it joined:\n${merged}`);
    // And says which kinds would have been kept apart, so a lane whose second
    // defect on the same element was absorbed knows how to file it.
    if (!/filed as a11y, .*a finding filed as a11y merges only with one filed as a11y\)/.test(merged))
      fail(`a merged filing did not say which kinds merge:\n${merged}`);
    const filed = await call("scout_lane_report", { lane: "orders", reply: report("input[name=email] has no label") });
    if (/have no finding/.test(filed)) fail(`a filed defect was still reported as unfiled:\n${filed}`);
    // The fold is logged, so the pace section can tell reporting from waiting to be closed.
    const logs = fs.readdirSync(path.join(projectDir, ".scenescout")).filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"));
    const folds = logs
      .flatMap((f) => fs.readFileSync(path.join(projectDir, ".scenescout", f), "utf8").split("\n"))
      .filter((l) => l.includes('"action":"lane-report"') && l.includes('"session":"orders"'));
    if (folds.length === 0) fail("folding a lane report left no lane-report marker in the run's log");
    // It carries the lane's page, so the live feed and the replay show where the lane was when it was folded.
    if (!folds.some((l) => /"url":"http[^"]+"/.test(l))) fail(`the lane-report marker carries no page URL: ${folds[0]}`);
    console.log("✓ a lane report names what was judged and never filed, and accepts prose around one fenced object");
    // The routes it covered are kept in the project's memory, where the benchmark's archive reads them.
    const stored = JSON.parse(fs.readFileSync(path.join(projectDir, ".scenescout", "memory.json"), "utf8")) as { laneRoutes?: Record<string, string[]> };
    if (JSON.stringify(stored.laneRoutes?.orders) !== JSON.stringify(["/"]))
      fail(`a folded lane report's routes were not kept: ${JSON.stringify(stored.laneRoutes)}`);
    console.log("✓ a folded lane report keeps the routes the lane covered");
    assertClosedAll(await call("scout_close", { all: true }));

    // The server keeps one store per project for its whole life. A second run
    // in the same process must not pass the gate on the first run's audit.
    await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "second-run", mode: "read-only", objective: "second run" });
    const secondRun = await call("scout_report", { session: "second-run", level: "minimal" });
    if (!/No scout_design_audit was run in this run/.test(secondRun))
      fail(`a second run passed the audit gate on the first run's audit:\n${secondRun.slice(0, 400)}`);
    // Closing the last session BY NAME ends the run too.
    await call("scout_design_audit", { session: "second-run" });
    // A brief whose lanes are never run: one shares the live session's name
    // (so it is that session, not a lane), the other never attaches.
    const brief = await call("scout_lane_brief", { session: "second-run", lanes: 2, routes: ["/second-run/a", "/reports/b"] });
    if (!brief.includes("── second-run ──") || !brief.includes("── reports ──")) fail(`the brief did not name the expected lanes:\n${brief}`);
    const closedSecond = await call("scout_close", { session: "second-run" });
    if (!closedSecond.includes('Session "second-run" closed')) fail(`a brief lane named like the live session made it a lane:\n${closedSecond}`);
    // That close ended the run, and the brief's lanes with it: a later session
    // that happens to share a lane's name is not a lane.
    await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "reports", mode: "read-only", objective: "a later role" });
    const closedLater = await call("scout_close", { session: "reports" });
    if (!closedLater.includes('Session "reports" closed')) fail(`a lane name outlived its run:\n${closedLater}`);
    console.log("✓ a brief's lane names end with the run, and never cover a session already live");
    await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "third-run", mode: "read-only", objective: "third run" });
    const thirdRun = await call("scout_report", { session: "third-run", level: "minimal" });
    if (!/No scout_design_audit was run in this run/.test(thirdRun)) fail(`closing the last session by name did not end its run:\n${thirdRun.slice(0, 400)}`);
    assertClosedAll(await call("scout_close", { all: true }));
    console.log("✓ a run's shared state ends with its last session");
  } finally {
    await fixture.close();
    // The engine may still be flushing its last status or log write into the
    // directory as it closes; retry rather than fail the suite on the race.
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Every file under a directory with its size and modification time, as one string to compare. */
function treeState(dir: string): string {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .sort()
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return `${name}:${st.size}:${st.mtimeMs}`;
    })
    .join("\n");
}

/**
 * A lane that lost its sign-in says so where the planner folds its report,
 * not only in its own calls: the line is added by the server's scout_lane_report,
 * so it is checked over the wire. One lane re-attaches from a refreshed
 * profile, one finds its profile revoked too, and one never lost its sign-in
 * and gets no line.
 */
async function reattachLaneCheck(client: Client): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-reattach-"));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  // A saved login for a role, built from a fresh sign-in on the fixture's revocable
  // token route, as `scenescout login` would save it.
  const saveLogin = async (role: string): Promise<void> => {
    const res = await fetch(`${fixture.baseUrl}/token-signin`, { redirect: "manual" });
    const token = new RegExp(`${TOKEN_COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!token) fail("the fixture's revocable sign-in set no token cookie");
    const cookie = { name: TOKEN_COOKIE, value: token, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" };
    writeProfile(projectDir, role, { cookies: [cookie], origins: [] });
  };
  const report = (lane: string): string => JSON.stringify({ lane, status: "complete", decisions: [], routes: ["/token-orders"], blocked_by: null });
  const loseSignIn = async (session: string): Promise<string> => {
    let last = "";
    for (const route of ["/token-orders", "/token-settings", "/token-profile"])
      last = await call("scout_navigate", { session, target: route, task: "Walking the signed-in pages" });
    return last;
  };
  try {
    for (const role of ["member", "viewer"]) await saveLogin(role);
    for (const [session, role] of [
      ["orders", "member"],
      ["billing", "viewer"],
      ["steady", "member"],
    ]) {
      await call("scout_attach", {
        url: `${fixture.baseUrl}/token-home`,
        projectPath: projectDir,
        session,
        mode: "read-only",
        role,
        objective: `${session} lane`,
      });
      const home = await call("scout_snapshot", { session });
      if (!home.includes("Signed in as a member")) fail(`a session attached by role did not start signed in:\n${home.slice(0, 400)}`);
    }
    // The server ends every session; member's login is saved again, viewer's is not.
    revokeFixtureTokens();
    await saveLogin("member");
    const recovered = await loseSignIn("orders");
    if (!recovered.includes("SESSION RE-ATTACHED")) fail(`the role session did not re-attach:\n${recovered}`);
    // viewer's profile holds a token revoked with the rest: its re-attach lands on the login page too.
    const lost = await loseSignIn("billing");
    if (!lost.includes("SESSION AUTH LOST")) fail(`a re-attach from a revoked profile was not reported as lost:\n${lost}`);

    const folded = await call("scout_lane_report", { lane: "orders", reply: report("orders") });
    if (!folded.includes(`↻ Session "orders": its sign-in was lost and it re-attached once from role 'member''s saved profile`))
      fail(`a folded lane report did not name the lane that re-attached:\n${folded}`);
    const failed = await call("scout_lane_report", { lane: "billing", reply: report("billing") });
    if (!failed.includes(`↻ Session "billing": its sign-in was lost and re-attaching from role 'viewer''s saved profile did not recover it`))
      fail(`a folded lane report did not name the lane whose re-attach failed:\n${failed}`);
    const quiet = await call("scout_lane_report", { lane: "steady", reply: report("steady") });
    if (!/Lane report accepted/.test(quiet) || quiet.includes("↻")) fail(`a lane that never lost its sign-in was reported as re-attached:\n${quiet}`);
    console.log("✓ a folded lane report names a lane that re-attached, or whose re-attach failed, and no other");
    assertClosedAll(await call("scout_close", { all: true }));
    // Once a close has answered, nothing more is written into the project: a
    // caller may remove it straight away. A status write left in flight after
    // the answer lands in a directory being removed (ENOTEMPTY on Node 20).
    const settled = treeState(projectDir);
    // Absence has no event to wait for: give a write still in flight time to land.
    await settle(300);
    if (treeState(projectDir) !== settled) fail("the project directory was still being written after scout_close answered");
    fs.rmSync(projectDir, { recursive: true });
    console.log("✓ scout_close answers only once its last write has landed");
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * status.json is written asynchronously and can be caught mid-write, which is
 * what `scenescout status` reports as truncated. A check reads it the way a
 * patient reader does: until it parses.
 */
async function readStatusWhenWhole<T>(projectDir: string): Promise<T> {
  const file = path.join(projectDir, ".scenescout", "status.json");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** ADR 7: the token outlives nothing. Checked after the client has closed the connection, which is how most clients leave. */
async function tokenGoneCheck(projectDir: string): Promise<void> {
  const tokenFile = path.join(projectDir, ".scenescout", "live-token");
  try {
    const deadline = Date.now() + WAIT_MS;
    while (fs.existsSync(tokenFile)) {
      if (Date.now() > deadline) fail("the live view's token file is still there after the client closed the connection");
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log("✓ the token file is removed once the client has gone");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** SCENESCOUT_LIVE=off is a promise that no port opens. A switch that only hides the address would break it quietly. */
async function liveViewOffCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-liveoff-"));
  const env = Object.fromEntries(Object.entries({ ...process.env, SCENESCOUT_LIVE: "off" }).filter((e): e is [string, string] => typeof e[1] === "string"));
  const client = new Client({ name: "ft-check-off", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env }));
  try {
    const attached = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir } }));
    if (attached.includes("Live view")) fail(`SCENESCOUT_LIVE=off still handed over an address:\n${attached}`);
    const status = await readStatusWhenWhole<{ live?: unknown; detail?: unknown[] }>(projectDir);
    if (status.live) fail(`SCENESCOUT_LIVE=off still advertises a port: ${JSON.stringify(status.live)}`);
    if (fs.existsSync(path.join(projectDir, ".scenescout", "live-token"))) fail("SCENESCOUT_LIVE=off still wrote a token file");
    if (!Array.isArray(status.detail) || status.detail.length !== 1) fail("status.json lost its per-session entries when the live view is off");
    assertClosedAll(textOf(await client.callTool({ name: "scout_close", arguments: { all: true } })));
    console.log("✓ SCENESCOUT_LIVE=off opens no port and still writes per-session status");
  } finally {
    await client.close();
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * SCENESCOUT_DEDUP=judge turns the dedup judge on for an agent's run, with a
 * key from the server's environment, and an attach that names `dedup` wins
 * over it. The attach says when the judge comes on and what it sends, and
 * when it cannot (no key). No finding is filed, so no model is called.
 */
async function dedupJudgeEnvCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-dedup-"));
  /** One server with SCENESCOUT_DEDUP=judge and `extra` in its environment, and the replies to attaches made in order. */
  const attaches = async (extra: Record<string, string>, calls: Array<Record<string, unknown>>): Promise<string[]> => {
    const base = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string" && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(e[0])),
    );
    const client = new Client({ name: "ft-check-dedup", version: "0.0.1" });
    await client.connect(
      new StdioClientTransport({ command: "node", args: [serverPath], env: { ...base, SCENESCOUT_LIVE: "off", SCENESCOUT_DEDUP: "judge", ...extra } }),
    );
    try {
      const replies: string[] = [];
      for (const args of calls)
        replies.push(textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, ...args } })));
      assertClosedAll(textOf(await client.callTool({ name: "scout_close", arguments: { all: true } })));
      return replies;
    } finally {
      await client.close();
    }
  };
  try {
    const KEY = "fake-mcp-check-key-0123456789";
    const [ruled, judged] = await attaches({ OPENAI_API_KEY: KEY }, [
      { session: "a", dedup: "rule" },
      { session: "b", dedup: "judge" },
    ]);
    if (/Finding dedup|DEDUP JUDGE/.test(ruled)) fail(`scout_attach {dedup: "rule"} did not win over SCENESCOUT_DEDUP=judge:\n${ruled}`);
    if (!/Finding dedup: the rule, then a model judge \(openai gpt-6-luna, effort none\)[\s\S]*is sent to openai/.test(judged))
      fail(`scout_attach {dedup: "judge"} with a key did not say the judge is on and what it sends:\n${judged}`);
    if (judged.includes(KEY)) fail("the attach printed the key");
    const [keyless] = await attaches({}, [{}]);
    if (!/⚠ DEDUP JUDGE OFF: the judge needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the server's environment\. The rule decides duplicates\./.test(keyless))
      fail(`SCENESCOUT_DEDUP=judge with no key did not say the judge is off:\n${keyless}`);
    console.log("✓ SCENESCOUT_DEDUP=judge asks for the judge, an attach's dedup wins over it, and the attach says what the judge sends or why it is off");
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * An attach with no projectPath: a client that offers a workspace folder (MCP
 * roots) gets that folder, and one that offers none gets a folder for the
 * tested site under SCENESCOUT_PROJECTS_DIR, which the result names.
 */
async function defaultFolderCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-folder-")));
  const projects = path.join(scratch, "projects");
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_PROJECTS_DIR: projects }).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  /** Attach once with no projectPath, from a client offering `roots` (or none), and return the reply. */
  const attachWithout = async (roots?: string[], extraEnv: Record<string, string> = {}, extraArgs: Record<string, unknown> = {}): Promise<string> => {
    const client = new Client({ name: "ft-check-folder", version: "0.0.1" }, roots ? { capabilities: { roots: {} } } : undefined);
    if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
    await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: { ...env, ...extraEnv } }));
    try {
      const reply = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, ...extraArgs } }));
      assertClosedAll(textOf(await client.callTool({ name: "scout_close", arguments: { all: true } })));
      return reply;
    } finally {
      await client.close();
    }
  };
  try {
    const site = path.join(projects, siteFolderName(fixture.baseUrl));
    const plain = await attachWithout();
    if (!plain.includes(`kept in ${site}`) || !plain.includes(path.join(site, ".scenescout", "report.md")))
      fail(`an attach with no projectPath and no workspace did not name the site's folder ${site}:\n${plain}`);
    if (!fs.existsSync(path.join(site, ".scenescout"))) fail(`the default folder ${site} was not created on first use`);
    // scout_login with no projectPath saves into the same site folder (one resolver, keyed by host and port,
    // so its sign-in page and the app's address agree). A sign-in saved there is found by an attach that
    // names no folder; the contrast is a role saved nowhere, which is refused.
    writeProfile(site, "member", {
      cookies: [{ name: "member_session", value: "x", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [],
    });
    if (siteFolderName(`${fixture.baseUrl}/sso/signin?next=%2F`) !== siteFolderName(fixture.baseUrl))
      fail("a sign-in page and its app resolve to different folders");
    const withRole = await attachWithout(undefined, {}, { role: "member" });
    if (/no sign-in is saved/.test(withRole) || !withRole.includes(`kept in ${site}`))
      fail(`an attach with no projectPath did not find the sign-in saved in ${site}:\n${withRole}`);
    const noRole = await attachWithout(undefined, {}, { role: "nobody" });
    if (!/no sign-in is saved for role "nobody"/.test(noRole)) fail(`an attach for a role saved nowhere was not refused:\n${noRole}`);
    if (!noRole.includes(`--role nobody --project ${shellQuote(site)}\``))
      fail(`the refusal in a folder SceneScout chose does not name it with --project, so the command would save elsewhere:\n${noRole}`);
    const fromRoots = await attachWithout([workspace]);
    if (!fromRoots.includes(`workspace folder, under ${workspace}`))
      fail(`an attach with no projectPath did not use the client's workspace ${workspace}:\n${fromRoots}`);
    if (!fs.existsSync(path.join(workspace, ".scenescout"))) fail(`the workspace ${workspace} holds no .scenescout after the attach`);
    const off = await attachWithout(undefined, { SCENESCOUT_PROJECTS_DIR: "off" });
    if (!/SCENESCOUT_PROJECTS_DIR is "off"[\s\S]*Pass projectPath/.test(off))
      fail(`SCENESCOUT_PROJECTS_DIR=off with no projectPath did not refuse the attach:\n${off}`);
    console.log(
      "✓ scout_attach with no projectPath uses the client's workspace, else a folder for the site that the result names and where a saved sign-in is found, and none when the setting is off",
    );
  } finally {
    await fixture.close();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
  const client = new Client({ name: "ft-check", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    console.error(`MCP CHECK FAILED — missing tools: ${missing.join(", ")}\nGot: ${names.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ server exposes ${names.length} tools`);

  // A client with no skill loader gets the method from the server, three ways.
  // Each is checked over the wire, because each is a different client's only route to it.
  const skillBody = fs.readFileSync(path.join(packageRoot, "skills", "scenescout", "SKILL.md"), "utf8");
  const instructions = client.getInstructions() ?? "";
  if (!instructions.includes("scout_playbook")) {
    console.error(`MCP CHECK FAILED — the server instructions do not point at scout_playbook. Got: ${JSON.stringify(instructions.slice(0, 200))}`);
    process.exit(1);
  }
  // Called with no `arguments` field at all: "takes no input" invites exactly that call.
  const played = (await client.callTool({ name: "scout_playbook" })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const playbook = played.content.find((c) => c.type === "text")?.text ?? "";
  if (played.isError || !playbook.includes("## Setup (in order)") || !playbook.startsWith("# SceneScout")) {
    console.error(`MCP CHECK FAILED — scout_playbook did not return the method (without front matter). Got: ${JSON.stringify(playbook.slice(0, 200))}`);
    process.exit(1);
  }
  if (!skillBody.endsWith(playbook)) {
    console.error("MCP CHECK FAILED — scout_playbook returned text that is not the skill file's body; the two must be one text.");
    process.exit(1);
  }
  const { prompts } = await client.listPrompts();
  const prompt = await client.getPrompt({ name: "explore", arguments: { url: "http://localhost:3000", level: "minimal" } });
  const promptText = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  if (
    !prompts.some((p) => p.name === "explore") ||
    !promptText.startsWith("# SceneScout") ||
    !/Target: http:\/\/localhost:3000\nLevel: minimal$/.test(promptText)
  ) {
    console.error(`MCP CHECK FAILED — the explore prompt is missing, or lacks the method or what was asked. Got: ${JSON.stringify(promptText.slice(-200))}`);
    process.exit(1);
  }
  // A client sends no `arguments` object when the person typed none; every argument is optional.
  const bare = await client.getPrompt({ name: "explore" });
  const bareText = bare.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  if (!bareText.endsWith(introQuestions())) {
    console.error(`MCP CHECK FAILED — the explore prompt without arguments did not ask the plain questions. Got: ${JSON.stringify(bareText.slice(-200))}`);
    process.exit(1);
  }
  // A level the method does not know is refused, and the server survives refusing it.
  const refused = await client.getPrompt({ name: "explore", arguments: { level: "deep" } }).then(
    () => "",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (!/minimal, medium, extensive/.test(refused)) {
    console.error(`MCP CHECK FAILED — an unknown level was not refused with the choices. Got: ${JSON.stringify(refused)}`);
    process.exit(1);
  }
  console.log("✓ the method reaches a client through instructions, scout_playbook and the explore prompt");

  // The SKILL is the agent's entire methodology — a tool it never mentions is
  // effectively unshipped, however well the engine implements it. scout_scroll
  // shipped a whole version before the skill described it, and nothing caught
  // that but a human noticing.
  const skillPath = path.join(packageRoot, "skills", "scenescout", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  const undocumented = names.filter((t) => !skill.includes(t));
  if (undocumented.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions: ${undocumented.join(", ")}\n` +
        `Every registered tool must appear in skills/scenescout/SKILL.md, or the agent will never use it.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents all ${names.length} tools`);

  // The reverse direction: a tool name the skill mentions but the server does
  // not register. The skill's first step stops the run when its probe tool is
  // missing, so one stale name there halts every run at setup.
  const mentioned = new Set([...skill.matchAll(/\b(?:mcp__[a-z_]+__)?((?:scout|ft)_[a-z_]+)\b/g)].map((m) => m[1]).filter((n) => !n.endsWith("_")));
  const unknown = [...mentioned].filter((n) => !names.includes(n));
  if (unknown.length > 0) {
    console.error(`MCP CHECK FAILED — the skill refers to tools the server does not register: ${unknown.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ skill names no tool the server lacks`);

  // Tool-NAME coverage is the floor, not the ceiling. A parameter added to an
  // already-documented tool leaves the name present, so the check above stays
  // green while the agent has no idea the parameter exists — which is exactly
  // how scout_type's `value` alias shipped undocumented. Check the parameters too.
  //
  // Deliberately advisory-by-exception: `session` is on nearly every tool and
  // explaining it once is correct, and a handful of params are genuinely
  // internal detail. Everything else must be findable in the skill.
  const PARAM_EXEMPT = new Set(["session", "projectPath", "force", "full"]);
  const paramGaps: string[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
    for (const param of Object.keys(schema?.properties ?? {})) {
      if (PARAM_EXEMPT.has(param)) continue;
      if (!skill.includes(param)) paramGaps.push(`${tool.name}.${param}`);
    }
  }
  if (paramGaps.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions these parameters: ${paramGaps.join(", ")}\n` +
        `A parameter the skill doesn't name is a parameter the agent will never pass. Document it in\n` +
        `skills/scenescout/SKILL.md, or add it to PARAM_EXEMPT in this script if it is genuinely internal.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents every non-exempt tool parameter`);

  // The guide (docs/guide/) names tools and their parameters for people, and
  // its configuration reference lists scout_attach's options. Both are held
  // to the schemas the server actually serves; guide-test covers the rest.
  const guideDir = path.join(packageRoot, "docs", "guide");
  const guideGaps: string[] = [];
  const schemaOf = new Map(tools.map((t) => [t.name, Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})]));
  for (const file of fs.readdirSync(guideDir).filter((f) => f.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(guideDir, file), "utf8").replace(/\r\n?/g, "\n");
    for (const m of text.matchAll(/\b(scout_[a-z_]+)\b/g)) if (!m[1].endsWith("_") && !names.includes(m[1])) guideGaps.push(`${file}: no tool ${m[1]}`);
    // `scout_attach {role: "admin"}`, `scout_verify {id, verdict, note}`: each key must be a parameter.
    for (const m of text.matchAll(/\b(scout_[a-z_]+)\s*\{([^}]*)\}/g)) {
      const params = schemaOf.get(m[1]) ?? [];
      for (const item of m[2].split(",")) {
        const key = item.match(/^\s*([A-Za-z]+)\s*(?::|$)/)?.[1];
        if (key && !params.includes(key)) guideGaps.push(`${file}: ${m[1]} has no parameter ${key}`);
      }
    }
  }
  const reference = fs.readFileSync(path.join(guideDir, "Configuration-reference.md"), "utf8").replace(/\r\n?/g, "\n");
  const attachSection = reference.split("\n## `scout_attach` options\n")[1] ?? "";
  const listed = [...attachSection.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]).sort();
  const attachParams = [...(schemaOf.get("scout_attach") ?? [])].sort();
  if (JSON.stringify(listed) !== JSON.stringify(attachParams)) {
    guideGaps.push(`Configuration-reference.md lists scout_attach options [${listed.join(", ")}], the server has [${attachParams.join(", ")}]`);
  }
  // The Default column says "(required)" for exactly the options the schema requires, for each tool the reference tables.
  for (const tool of ["scout_attach", "scout_login"]) {
    const section = (reference.split(`\n## \`${tool}\` options\n`)[1] ?? "").split("\n## ")[0];
    const listedRequired = [...section.matchAll(/^\| `([A-Za-z]+)` \| \(required\) \|/gm)].map((m) => m[1]).sort();
    const required = [...((tools.find((t) => t.name === tool)?.inputSchema as { required?: string[] } | undefined)?.required ?? [])].sort();
    if (!section) guideGaps.push(`Configuration-reference.md has no ${tool} options table`);
    else if (JSON.stringify(listedRequired) !== JSON.stringify(required))
      guideGaps.push(`Configuration-reference.md marks ${tool} options [${listedRequired.join(", ")}] required, the server requires [${required.join(", ")}]`);
  }
  if (guideGaps.length > 0) {
    console.error(`MCP CHECK FAILED — the guide disagrees with the server's tools:\n  ${guideGaps.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    "✓ the guide names only tools and parameters the server has, and lists every scout_attach option, and which scout_attach and scout_login options are required",
  );

  const result = await client.callTool({ name: "scout_scan", arguments: { projectPath: packageRoot } });
  const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
  if (!text.includes("Project:")) {
    console.error(`MCP CHECK FAILED — scout_scan returned unexpected output:\n${text}`);
    process.exit(1);
  }
  console.log("✓ scout_scan round-trip works");

  await expiryBriefCheck(client);
  await findingPictureCheck(client);
  await laneCheck(client);
  await reattachLaneCheck(client);
  const liveProject = await liveViewCheck(client);
  await client.close();
  await tokenGoneCheck(liveProject);
  await liveViewOffCheck();
  await dedupJudgeEnvCheck();
  await defaultFolderCheck();
  await findingPictureCapCheck();
  console.log("\nMCP CHECK PASSED");
}

main().catch((err) => {
  console.error("MCP CHECK CRASHED:", err);
  process.exit(1);
});
