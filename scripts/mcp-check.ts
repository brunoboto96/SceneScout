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
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, ListRootsRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { INTAKE_FORM_MESSAGE, introQuestions } from "../dist/intake.js";
import { shellQuote, writeProfile } from "../dist/engine/profiles.js";
import { siteFolderName } from "../dist/engine/project-folder.js";
import { MCP_APP_MIME, STATUS_PANE_URI, STATUS_POLL_TOOL, STATUS_TOOL } from "../dist/engine/status-pane.js";
import { asLf } from "./checkout.ts";
import { revokeFixtureTokens, settle, SIGN_IN_COOKIE, startFixtureServer, TOKEN_COOKIE, WAIT_MS } from "./smoke/harness.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "mcp-server.js");
const packageRoot = path.join(here, "..");

const EXPECTED_TOOLS = [
  "scout_playbook",
  "scout_intake",
  "scout_guided_plan",
  "scout_guided_confirm",
  "scout_recheck_plan",
  "scout_saved_checks",
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
  "scout_tickets",
  "scout_criterion",
  "scout_status",
  "scout_status_poll",
  "scout_cards",
  "scout_feedback",
  "scout_team_report",
  "scout_ticket_preview",
  "scout_ticket_file",
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

    // The status pane's text and its poll carry the same address and the session's task.
    const statusText = textOf(await client.callTool({ name: STATUS_TOOL }));
    if (LIVE_LINE.exec(statusText)?.[1] !== url) fail(`${STATUS_TOOL}'s text does not carry the live view's address:\n${statusText}`);
    if (!statusText.includes("task: Walk the two static pages")) fail(`${STATUS_TOOL}'s text does not show the session's task:\n${statusText}`);
    const polled = (await client.callTool({ name: STATUS_POLL_TOOL, arguments: {} })) as {
      structuredContent?: {
        liveUrl?: string;
        sessions?: Array<{ session: string; task?: string }>;
        findings?: { open: number };
        coverage?: { states: number };
      };
    };
    const pane = polled.structuredContent;
    if (pane?.liveUrl !== url) fail(`the pane's poll does not carry the live view's address: ${JSON.stringify(pane?.liveUrl)}`);
    if (pane.sessions?.find((s) => s.session === "watched")?.task !== "Walk the two static pages" || !pane.findings || !pane.coverage)
      fail(`the pane's poll does not carry the session's task, the findings and the coverage: ${JSON.stringify(pane).slice(0, 400)}`);
    console.log(`✓ ${STATUS_TOOL} and the pane's poll carry the live view's address, the session's task, findings and coverage`);

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
/**
 * The run page's pictures belong to the project the page was written for. One
 * engine serving two runs in turn, each in its own project folder: a picture on
 * the first run's page must still load after a session attaches to the second,
 * since the page is already open in someone's browser and its images load later.
 */
async function runPagePicturesAcrossProjectsCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-pictures-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-pictures-b-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_OPEN: "none", SCENESCOUT_EVIDENCE: "file" }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const client = new Client({ name: "ft-check-run-pictures", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  try {
    const attached = await call("scout_attach", { url: fixture.baseUrl, projectPath: first, session: "first", mode: "read-only", objective: "pictures" });
    const live = attached.match(LIVE_LINE)?.[1];
    if (!live) fail(`no live view address on attach:\n${attached}`);
    await call("scout_finding", {
      session: "first",
      severity: "low",
      category: "ux-confusing",
      title: "A heading repeats the page title",
      detail: "Filed to give the run page a picture.",
      evidence: "run page picture check",
    });
    await call("scout_close", { session: "first" });
    const page = await (await fetch(`${live}run`)).text();
    const src = /<img[^>]*\ssrc="(record\/[^"]+)"/.exec(page)?.[1];
    if (!src) fail(`the run page has no picture:\n${page.slice(0, 400)}`);
    const before = await fetch(`${live}${src}`);
    if (before.status !== 200) fail(`the run page's picture did not load while its project was the last one attached: ${before.status} for ${src}`);
    await call("scout_attach", { url: fixture.baseUrl, projectPath: second, session: "second", mode: "read-only", objective: "another project" });
    const after = await fetch(`${live}${src}`);
    if (after.status !== 200) fail(`the first run's picture stopped loading once a session attached to another project: ${after.status} for ${src}`);
    console.log("✓ a run page's pictures keep loading after a session attaches to another project");
    await call("scout_close", { all: true });
  } finally {
    await client.close();
    await fixture.close();
    for (const dir of [first, second]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * The live board's report panel builds its picture addresses from `/api/report`,
 * the way the board's page does: the report's own prefix, or the bare `record/`
 * when it names none. A project folder can have several sessions, and two folders
 * can be attached at once. When the session that filed a finding has closed
 * while another session in its folder stays, the report still describes that
 * folder, and its picture must load rather than be looked up in the other one.
 */
async function boardPicturesAcrossProjectsCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-board-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-board-b-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_OPEN: "none", SCENESCOUT_EVIDENCE: "file" }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const client = new Client({ name: "ft-check-board-pictures", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  try {
    // The other project attaches first, so it is the one an unkeyed address falls back to.
    const attached = await call("scout_attach", {
      url: fixture.baseUrl,
      projectPath: second,
      session: "other",
      mode: "read-only",
      objective: "another project",
    });
    const live = attached.match(LIVE_LINE)?.[1];
    if (!live) fail(`no live view address on attach:\n${attached}`);
    await call("scout_attach", { url: fixture.baseUrl, projectPath: first, session: "filer", mode: "read-only", objective: "board pictures" });
    await call("scout_finding", {
      session: "filer",
      severity: "low",
      category: "ux-confusing",
      title: "A heading repeats the page title",
      detail: "Filed to give the board's report panel a picture.",
      evidence: "board picture check",
    });
    await call("scout_attach", { url: fixture.baseUrl, projectPath: first, session: "stayer", mode: "read-only", objective: "same project" });
    await call("scout_close", { session: "filer" });
    const report = (await (await fetch(`${live}api/report`)).json()) as { framePrefix?: string; evidence?: { picture?: { file: string } }[] };
    const file = report.evidence?.find((e) => e.picture)?.picture?.file;
    if (!file) fail(`the board's report carries no picture for the closed session's finding:\n${JSON.stringify(report.evidence)}`);
    const src = `${report.framePrefix ?? "record/"}${file}`;
    const res = await fetch(`${live}${src}`);
    if (res.status !== 200) fail(`the board's report picture did not load once its session closed beside another project: ${res.status} for ${src}`);
    console.log("✓ a board report's pictures load from the project the report describes");
    await call("scout_close", { all: true });
  } finally {
    await client.close();
    await fixture.close();
    for (const dir of [first, second]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function findingPictureCapCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-picture-cap-"));
  const client = new Client({ name: "ft-check-picture-cap", version: "0.0.1" });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...env,
        SCENESCOUT_LIVE: "off",
        SCENESCOUT_OPEN: "none",
        SCENESCOUT_EVIDENCE: "inline",
        SCENESCOUT_EVIDENCE_INLINE: "1",
        SCENESCOUT_EVIDENCE_MAX_PX: "400",
      },
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

/**
 * Tickets in, an answer per criterion out, over the wire: a ticket file read
 * by a path relative to the project, a fail refused until it names a finding,
 * and the report answering the ticket in the plain view and the technical one.
 */
async function ticketsCheck(client: Client): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-tickets-"));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  try {
    await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "tickets", mode: "read-only", objective: "Check the tickets" });
    fs.writeFileSync(
      path.join(projectDir, "WID-7.md"),
      "# WID-7: Export the widget list\n\n## Acceptance criteria\n- The export button downloads a file\n- The file has a header row\n",
    );
    const read = await call("scout_tickets", { session: "tickets", path: "WID-7.md" });
    if (!/Read 1 ticket with 2 acceptance criteria/.test(read) || !read.includes("AC2 [bullet] The file has a header row"))
      fail(`scout_tickets did not read the ticket file:\n${read}`);
    // A ticket file outside the project is not read: the server here names no SCENESCOUT_TICKET_DIRS.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-tickets-outside-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "WID-8.md"), "# WID-8: Elsewhere\n\n- [ ] Nothing here is read\n");
      const outside = await call("scout_tickets", { session: "tickets", path: path.join(outsideDir, "WID-8.md") });
      if (!/is outside the project folder/.test(outside) || !outside.includes("SCENESCOUT_TICKET_DIRS") || /Read \d+ ticket/.test(outside))
        fail(`scout_tickets read a ticket file outside the project:\n${outside}`);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
    const bare = await call("scout_criterion", {
      session: "tickets",
      ticket: "WID-7",
      criterion: "AC1",
      verdict: "fail",
      confidence: 0.9,
      reason: "nothing downloads",
    });
    if (!/Not recorded: a failing criterion links to the findings/.test(bare)) fail(`a fail with no finding was recorded:\n${bare}`);
    const observe = await call("scout_criterion", {
      session: "tickets",
      ticket: "WID-7",
      criterion: "AC2",
      verdict: "not-tested",
      untestedBecause: "observe-blocked",
      confidence: 1,
      reason: "needs a download",
    });
    if (!/Not recorded: this session runs in read-only mode/.test(observe)) fail(`"observe-blocked" was accepted from a read-only session:\n${observe}`);
    const filed = await call("scout_finding", {
      session: "tickets",
      severity: "high",
      category: "page-error",
      title: "Export throws",
      detail: "Nothing downloads.",
      evidence: "export-throws",
    });
    const id = /\b([0-9a-f]{10})\b/.exec(filed)?.[1];
    if (!id) fail(`scout_finding returned no id:\n${filed}`);
    const recorded = await call("scout_criterion", {
      session: "tickets",
      ticket: "WID-7",
      criterion: "1",
      verdict: "fail",
      findings: [id],
      confidence: 0.9,
      reason: "nothing downloads",
    });
    if (!recorded.startsWith("Recorded: WID-7 AC1 fails") || !recorded.includes(`(${id})`)) fail(`a fail with its finding was not recorded:\n${recorded}`);
    const summary = await call("scout_report", { session: "tickets", level: "minimal", force: true });
    if (!/TICKETS: 1 ticket, 2 criteria — 1 failed and 1 was not tested/.test(summary))
      fail(`the report summary does not answer the ticket:\n${summary.slice(0, 600)}`);
    const md = fs.readFileSync(path.join(projectDir, ".scenescout", "report.md"), "utf8");
    const plain = md.indexOf("### The tickets");
    const technical = md.indexOf("## Acceptance criteria");
    if (plain < 0 || technical < 0 || !(plain < md.indexOf("## Technical detail") && md.indexOf("## Technical detail") < technical))
      fail(`the report does not answer the ticket in the plain view first and the technical report after:\n${md.slice(0, 1500)}`);
    assertClosedAll(await call("scout_close", { all: true }));
    console.log(
      "✓ scout_tickets reads a ticket file in the project and refuses one outside it, scout_criterion records a verdict with its finding, and the report answers it",
    );
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** SCENESCOUT_LIVE=off is a promise that no port opens. A switch that only hides the address would break it quietly. */
async function liveViewOffCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-liveoff-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none" }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
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
      new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: { ...base, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none", SCENESCOUT_DEDUP: "judge", ...extra },
      }),
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
    const [argOnly] = await attaches({ OPENAI_API_KEY: KEY, SCENESCOUT_DEDUP: "rule" }, [{ dedup: "judge" }]);
    if (/a model judge|is sent to openai/.test(argOnly) || !/dedup: "judge" was not applied[\s\S]*SCENESCOUT_DEDUP=judge/.test(argOnly))
      fail(`scout_attach {dedup: "judge"} switched the judge on without SCENESCOUT_DEDUP=judge:\n${argOnly}`);
    console.log("✓ SCENESCOUT_DEDUP=judge asks for the judge, an attach's dedup wins over it, and the attach says what the judge sends or why it is off");
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * The open setting, over the wire: on a local desktop session, a client that
 * declares nothing gets the live view opened on attach and the report when it
 * is written, once each; under CI nothing opens. The platform opener is a stand-in script first on
 * PATH that writes down what it was handed, so no browser is launched.
 */
async function openCheck(): Promise<void> {
  if (process.platform === "win32") {
    console.log("- the open check needs a stand-in opener on PATH, which Windows' rundll32 cannot be; skipped on Windows");
    return;
  }
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-open-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-opener-"));
  const opened = path.join(bin, "opened.txt");
  const opener = path.join(bin, process.platform === "darwin" ? "open" : "xdg-open");
  fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`, { mode: 0o755 });
  // A local desktop session, built explicitly so the check means the same on a CI runner: no CI or
  // GITHUB_ACTIONS, no SSH, a display on Linux, and the stand-in opener first on PATH.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        typeof e[1] === "string" && !["CI", "GITHUB_ACTIONS", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "SCENESCOUT_OPEN"].includes(e[0]),
    ),
  );
  const env: Record<string, string> = { ...base, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  if (process.platform !== "darwin") env.DISPLAY = ":99";
  const read = (): string[] => (fs.existsSync(opened) ? fs.readFileSync(opened, "utf8").trim().split("\n") : []);
  const lines = async (expected: number): Promise<string[]> => {
    // The opener runs detached and is not waited for.
    for (let i = 0; i < 50 && read().length < expected; i++) await new Promise((r) => setTimeout(r, 100));
    return read();
  };
  try {
    // CI: nothing opens, and the attach says why and what changes it.
    const ci = new Client({ name: "ft-check-open-ci", version: "0.0.1" });
    await ci.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: { ...env, CI: "true" } }));
    try {
      const attached = textOf(await ci.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir } }));
      if (attached.includes("Opened") || !attached.includes("Not opened in a browser (a CI run); scout_attach {open} or SCENESCOUT_OPEN changes that."))
        fail(`a CI attach opened the live view, or did not say why not:\n${attached}`);
      const reported = textOf(await ci.callTool({ name: "scout_report", arguments: { force: true, level: "minimal" } }));
      if (reported.includes("Opened")) fail(`a CI run opened the report:\n${reported}`);
      assertClosedAll(textOf(await ci.callTool({ name: "scout_close", arguments: { all: true } })));
    } finally {
      await ci.close();
    }

    // A local desktop session, from a client that declares nothing: both open.
    const client = new Client({ name: "ft-check-open", version: "0.0.1" });
    await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env }));
    try {
      const attached = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, session: "first" } }));
      const url = attached.match(LIVE_LINE)?.[1];
      if (!url || !attached.includes('Opened the live view in the default browser (SCENESCOUT_OPEN=none, or scout_attach {open: "none"}, turns this off).'))
        fail(`a headless attach on a local session did not open the live view and name the setting:\n${attached}`);
      const second = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, session: "second" } }));
      if (second.includes("Opened the live view")) fail(`a second attach opened the live view again:\n${second}`);
      const reported = textOf(await client.callTool({ name: "scout_report", arguments: { force: true, level: "minimal", session: "first" } }));
      if (!reported.includes("Opened the report in the default browser.") || reported.includes("turns this off"))
        fail(`scout_report on a local session did not open the report, or named the setting a second time:\n${reported}`);
      const quiet = textOf(
        await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, session: "quiet", open: "none" } }),
      );
      const quietReport = textOf(await client.callTool({ name: "scout_report", arguments: { force: true, level: "minimal", session: "quiet" } }));
      if (quiet.includes("Opened") || quietReport.includes("Opened")) fail(`open: "none" still opened something:\n${quiet}\n${quietReport}`);
      const handed = await lines(2);
      const html = path.join(fs.realpathSync(projectDir), ".scenescout", "report.html");
      const htmlRaw = path.join(projectDir, ".scenescout", "report.html");
      // The opener runs detached, so the two launches may land in either order: compare as a set.
      const isLive = (line: string): boolean => line === url;
      const isReport = (line: string): boolean => line === html || line === htmlRaw;
      const bothHanded = handed.length === 2 && ((isLive(handed[0]) && isReport(handed[1])) || (isReport(handed[0]) && isLive(handed[1])));
      if (!bothHanded) fail(`the opener was not handed exactly the live view's address and report.html:\n${handed.join("\n")}`);
      assertClosedAll(textOf(await client.callTool({ name: "scout_close", arguments: { all: true } })));
    } finally {
      await client.close();
    }
    console.log("✓ on a local session the live view opens once and the report when written, whatever the client declares; CI and open: none open nothing");
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(bin, { recursive: true, force: true });
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
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none", SCENESCOUT_PROJECTS_DIR: projects }).filter(
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

/** A form a client was shown, and a handler that answers it. */
type FormParams = ElicitRequest["params"] & {
  message: string;
  requestedSchema?: { properties: Record<string, { default?: unknown; oneOf?: unknown[]; type?: string }> };
};
type FormAnswer = ElicitResult | ((form: FormParams) => ElicitResult);

/** The environment a checking client starts the server with: no live view, nothing opened. */
function quietEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none" }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/**
 * Run `body` with a client declaring `elicitation` (or none) whose form handler
 * answers with `answer` (a fixed result, or one built from the form). Uses the
 * SDK's own client-side elicitation handler, so the request shape is the one a
 * real client receives and validates. Returns what `body` returned and the
 * forms the client was shown.
 */
async function withFormClient<T>(
  elicitation: Record<string, object> | undefined,
  answer: FormAnswer | undefined,
  body: (client: Client) => Promise<T>,
): Promise<{ out: T; forms: FormParams[] }> {
  const client = new Client({ name: "ft-check-forms", version: "0.0.1" }, elicitation ? { capabilities: { elicitation } } : undefined);
  const forms: FormParams[] = [];
  if (elicitation)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const form = request.params as FormParams;
      forms.push(form);
      if (answer === undefined) return { action: "cancel" };
      return typeof answer === "function" ? answer(form) : answer;
    });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: quietEnv() }));
  try {
    return { out: await body(client), forms };
  } finally {
    await client.close();
  }
}

/** The four digits a confirmation form shows for its code. */
const codeIn = (form: FormParams): string => /type this code: (\d{4})\./.exec(form.message)?.[1] ?? "";

/**
 * scout_intake over the wire, from clients that differ only in what they
 * declare and answer: no elicitation, URL mode only, form mode (and the empty
 * object that means it) answering accept, decline and cancel, and a care level
 * that writes, confirmed in the second form the server shows.
 */
async function intakeCheck(): Promise<void> {
  /** Call scout_intake from a client declaring `elicitation` (or none) whose form handler answers `answer`; return the reply and the forms it was shown. */
  const intakeFrom = async (
    elicitation: Record<string, object> | undefined,
    answer?: FormAnswer,
    args: Record<string, unknown> = {},
  ): Promise<{ reply: string; forms: FormParams[] }> => {
    const got = await withFormClient(elicitation, answer, async (client) => textOf(await client.callTool({ name: "scout_intake", arguments: args })));
    return { reply: got.out, forms: got.forms };
  };
  const asksInChat = (label: string, got: { reply: string; forms: unknown[] }, why: RegExp, formsShown: number): void => {
    if (!got.reply.endsWith(introQuestions()) || !why.test(got.reply))
      fail(`scout_intake from ${label} did not hand the four questions back for the chat (${why}):\n${got.reply}`);
    if (got.forms.length !== formsShown) fail(`scout_intake from ${label} showed ${got.forms.length} forms, expected ${formsShown}`);
  };

  asksInChat("a client with no elicitation", await intakeFrom(undefined), /this client cannot show a form/, 0);
  // URL mode only: a form must never be sent to it, so the handler is never reached.
  asksInChat("a client with URL elicitation only", await intakeFrom({ url: {} }, { action: "accept", content: {} }), /this client cannot show a form/, 0);
  asksInChat("a client whose person declined", await intakeFrom({ form: {} }, { action: "decline" }), /declined the form/, 1);
  asksInChat("a client whose person closed the form", await intakeFrom({ form: {} }, { action: "cancel" }), /closed the form without answering/, 1);

  const choices = { checkSignIn: false, checkForms: true, checkBrokenPages: true, checkPhone: false, thoroughness: "normal" };
  const accepted = await intakeFrom(
    { form: {} },
    { action: "accept", content: { address: "http://localhost:3000", ...choices, signIn: "sso", care: "may-submit-forms" } },
    { url: "http://localhost:3000" },
  );
  const form = accepted.forms[0];
  if (!form || form.mode !== "form" || form.message !== INTAKE_FORM_MESSAGE)
    fail(`scout_intake did not send one form-mode request with its message: ${JSON.stringify(accepted.forms)}`);
  const fields = Object.keys(form.requestedSchema!.properties);
  if (fields.join() !== "address,checkSignIn,checkForms,checkBrokenPages,checkPhone,journey,tickets,signIn,care,thoroughness")
    fail(`the form's fields are ${fields.join()}`);
  if (form.requestedSchema!.properties.address.default !== "http://localhost:3000") fail("the address the agent passed did not start filled in");
  if (form.requestedSchema!.properties.care.default !== "look-only") fail("the form does not start at Look only");
  if (/password|secret|token/i.test(fields.join())) fail(`the form has a field for a credential: ${fields.join()}`);
  // May submit forms on this computer needs no confirmation: one form, and the plan's calls in order, each attach naming the plan.
  const order = ["Guided plan gp-", "scout_login {", "scout_attach {", '"mode":"read-only"', '"role":"user"', '"planId":"gp-'];
  if (
    accepted.forms.length !== 1 ||
    !order.every((part) => accepted.reply.includes(part)) ||
    accepted.reply.indexOf("scout_login") > accepted.reply.indexOf("scout_attach")
  )
    fail(`an accepted form did not return the guided plan's sign-in and attach in order, with no second form:\n${accepted.reply}`);
  // The empty object is form mode by the specification, and an answer the schema refuses still ends in the chat.
  const empty = await intakeFrom({}, { action: "accept", content: { address: "http://x.test", ...choices, signIn: "none", care: "look-only" } });
  if (empty.forms.length !== 1 || !empty.reply.includes('"mode":"observe"')) fail(`an empty elicitation capability was not offered the form:\n${empty.reply}`);
  asksInChat(
    "a client answering with a value the form never offered",
    await intakeFrom({ form: {} }, { action: "accept", content: { address: "http://x.test", ...choices, signIn: "fingerprint", care: "look-only" } }),
    /the form failed: .*(?:schema|must be equal)/,
    1,
  );
  // May create test data: the second form is the confirmation, and only the person's yes with its code accepts the plan.
  const createForm: ElicitResult = {
    action: "accept",
    content: { address: "https://staging.example.com", ...choices, signIn: "none", care: "may-create-test-data" },
  };
  const createAnswer = (f: FormParams): ElicitResult =>
    f.message === INTAKE_FORM_MESSAGE ? createForm : { action: "accept", content: { answer: "yes", code: codeIn(f) } };
  const created = await intakeFrom({ form: {} }, createAnswer);
  if (created.forms.length !== 2 || !/is accepted/.test(created.reply) || !created.reply.includes('"mode":"safe-write"'))
    fail(`May create test data was not confirmed in a second form and returned accepted:\n${created.reply}`);
  const goBack = (f: FormParams): ElicitResult => (f.message === INTAKE_FORM_MESSAGE ? createForm : { action: "accept", content: { answer: "back" } });
  const backed = await intakeFrom({ form: {} }, goBack);
  if (backed.forms.length !== 2 || !/is NOT accepted \(went-back\)/.test(backed.reply) || /scout_attach \{/.test(backed.reply))
    fail(`going back in the confirmation did not leave the plan unaccepted:\n${backed.reply}`);
  console.log(
    "✓ scout_intake shows the guided form to a client declaring form elicitation, maps an accept to a plan, confirms a writing care level in a second form, and hands the questions to the chat on no form, URL only, decline, cancel or a refused answer",
  );
}

/**
 * scout_guided_plan and scout_guided_confirm end to end: annotations and output
 * schemas as served, a plan built unaccepted, the attach gate refusing before
 * any browser starts, and the person's form deciding: going back, a wrong
 * code, a decline and a client with no forms each leave the plan unaccepted,
 * and only a yes with the code the form showed accepts it.
 */
async function guidedCheck(): Promise<void> {
  const REMOTE = "https://staging.example.com";
  type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  let answer: FormAnswer = { action: "cancel" };
  const got = await withFormClient(
    { form: {} },
    (f) => (typeof answer === "function" ? answer(f) : answer),
    async (client) => {
      const { tools } = await client.listTools();
      const tool = (name: string) => tools.find((t) => t.name === name);
      for (const [name, readOnly] of [
        ["scout_intake", false],
        ["scout_guided_plan", true],
        ["scout_guided_confirm", false],
      ] as const) {
        const a = tool(name)?.annotations;
        if (a?.readOnlyHint !== readOnly || a?.destructiveHint !== false)
          fail(`${name} is not annotated readOnlyHint ${readOnly}, destructiveHint false: ${JSON.stringify(a)}`);
      }
      for (const name of ["scout_guided_plan", "scout_guided_confirm"]) if (!tool(name)?.outputSchema) fail(`${name} has no outputSchema`);

      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => (await client.callTool({ name, arguments: args })) as Result;
      const built = await call("scout_guided_plan", { choices: { address: REMOTE, areas: ["forms"], care: "may-create-test-data" } });
      const plan = built.structuredContent as {
        planId: string;
        mode: string;
        confirm: { accepted: boolean } | null;
        calls: Array<{ tool: string; args: Record<string, unknown> }>;
      };
      if (
        built.isError ||
        plan.mode !== "safe-write" ||
        plan.confirm?.accepted !== false ||
        plan.calls.find((c) => c.tool === "scout_attach")?.args.planId !== plan.planId
      )
        fail(`scout_guided_plan did not build an unaccepted safe-write plan whose attach names it: ${JSON.stringify(built)}`);
      const refusal = async (args: Record<string, unknown>, why: RegExp, label: string): Promise<void> => {
        const r = await call("scout_attach", args);
        if (!r.isError || !why.test(textOf(r))) fail(`scout_attach ${label} was not refused (${why}): ${textOf(r)}`);
      };
      await refusal({ url: REMOTE, mode: "safe-write" }, /must name it/, "above observe without the plan's id");
      await refusal({ url: REMOTE }, /must name it/, "with the default mode and no plan id");
      await refusal({ url: REMOTE, mode: "read-only", planId: plan.planId }, /needs the person's confirmation/, "with an unaccepted plan");

      const confirm = async (with_: FormAnswer): Promise<{ accepted: unknown; outcome: unknown }> => {
        answer = with_;
        const r = await call("scout_guided_confirm", { planId: plan.planId });
        return r.structuredContent as { accepted: unknown; outcome: unknown };
      };
      const cases: Array<[FormAnswer, string]> = [
        [{ action: "accept", content: { answer: "back" } }, "went-back"],
        [{ action: "accept", content: { answer: "yes", code: "0000" } }, "wrong-code"],
        [{ action: "accept", content: { answer: "yes" } }, "wrong-code"],
        [{ action: "decline" }, "declined"],
        [{ action: "cancel" }, "cancelled"],
      ];
      for (const [with_, outcome] of cases) {
        // A wrong code is never "0000" by chance: the answer is made to differ from the code the form showed.
        const a: FormAnswer =
          typeof with_ === "object" && with_.content?.code === "0000"
            ? (f) => ({ action: "accept", content: { answer: "yes", code: codeIn(f) === "0000" ? "1111" : "0000" } })
            : with_;
        const r = await confirm(a);
        if (r.accepted !== false || r.outcome !== outcome)
          fail(`a confirmation answered ${JSON.stringify(with_)} gave ${JSON.stringify(r)}, expected ${outcome} and not accepted`);
      }
      const still = (await call("scout_guided_plan", { planId: plan.planId })).structuredContent as { confirm: { accepted: boolean } };
      if (still.confirm.accepted !== false) fail("a plan was accepted by an answer that was not the person's yes with the code");
      const yes = await confirm((f) => ({ action: "accept", content: { answer: "yes", code: codeIn(f) } }));
      if (yes.accepted !== true || yes.outcome !== "accepted") fail(`the person's yes with the code did not accept the plan: ${JSON.stringify(yes)}`);
      const now = (await call("scout_guided_plan", { planId: plan.planId })).structuredContent as { confirm: { accepted: boolean } };
      if (now.confirm.accepted !== true) fail("an accepted plan reads back unaccepted");
      await refusal({ url: REMOTE, mode: "destructive", planId: plan.planId }, /"safe-write" at most/, "above the plan's mode");
      await refusal({ url: "https://live.example.com", mode: "safe-write", planId: plan.planId }, /must be on that site/, "on another site");
      await refusal({ url: REMOTE, mode: "read-only" }, /must name it/, "without the id once a plan is accepted");
      // Observe needs no plan, but readPosts would let named POSTs out of it, and trustedEmbeds frames' writes out of safe-write.
      await refusal({ url: REMOTE, mode: "observe", readPosts: ["POST /api/things"] }, /readPosts/, "in observe with readPosts while a plan is open");
      await refusal(
        { url: REMOTE, mode: "safe-write", planId: plan.planId, trustedEmbeds: ["https://pay.example.com"] },
        /trustedEmbeds/,
        "with trustedEmbeds",
      );
      // Nothing a caller passes accepts a plan: choices that arrive accepted are not a field.
      const sneaky = await call("scout_guided_plan", { choices: { address: REMOTE, areas: ["forms"], care: "may-create-test-data", accepted: true } });
      if (!sneaky.isError || !/do not take/.test(textOf(sneaky))) fail(`a choices field the plan does not take was not refused: ${textOf(sneaky)}`);
    },
  );
  // Five refused answers, then the yes: six confirmation forms, each with a fresh code.
  const codes = got.forms.map(codeIn);
  if (got.forms.length !== 6 || codes.some((c) => !/^\d{4}$/.test(c))) fail(`the confirmation forms were ${got.forms.length}, codes ${codes.join(",")}`);

  // A client that cannot show forms: the plan stays unaccepted, and the tool says so plainly.
  const noForms = await withFormClient(undefined, undefined, async (client) => {
    const built = (await client.callTool({
      name: "scout_guided_plan",
      arguments: { choices: { address: REMOTE, areas: ["forms"], care: "may-submit-forms" } },
    })) as Result;
    const planId = (built.structuredContent as { planId: string }).planId;
    return (await client.callTool({ name: "scout_guided_confirm", arguments: { planId } })) as Result;
  });
  const unsupported = noForms.out.structuredContent as { accepted: unknown; outcome: unknown };
  if (unsupported.accepted !== false || unsupported.outcome !== "unsupported" || !/cannot show the confirmation form/.test(textOf(noForms.out)))
    fail(`a client with no forms did not leave the plan unaccepted with a plain sentence: ${JSON.stringify(noForms.out)}`);
  console.log(
    "✓ scout_guided_plan and scout_guided_confirm are annotated and schema'd, scout_attach above observe is refused without an accepted plan (and readPosts or trustedEmbeds while one is open), and only the person's yes with the code accepts one (going back, a wrong code, a decline, a close or no forms do not)",
  );
}

/**
 * scout_ticket_preview and scout_ticket_file as served: their annotations
 * (the preview reads a tracker and writes nothing; filing writes to one),
 * their input and output schemas, that neither takes a token, and that with
 * no project open both refuse before reading anything. Previewing and filing
 * against stand-in trackers is export-test's.
 */
async function ticketToolsCheck(): Promise<void> {
  type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const { out } = await withFormClient({ form: {} }, { action: "cancel" }, async (client) => {
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name);
    const expect: Array<[string, boolean, string[], string[]]> = [
      [
        "scout_ticket_preview",
        true,
        ["ids", "to", "target"],
        ["previewId", "to", "where", "createdAt", "expiresAt", "toFile", "alreadyFiled", "later", "cap", "leftOut"],
      ],
      ["scout_ticket_file", false, ["previewId"], ["filed", "outcome", "tellPerson", "tickets", "problems"]],
    ];
    for (const [name, readOnly, inputs, outputs] of expect) {
      const t = tool(name);
      const a = t?.annotations;
      if (a?.readOnlyHint !== readOnly || a?.destructiveHint !== false || a?.openWorldHint !== true)
        fail(`${name} is not annotated readOnlyHint ${readOnly}, destructiveHint false, openWorldHint true: ${JSON.stringify(a)}`);
      const props = Object.keys((t?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      if (JSON.stringify(props) !== JSON.stringify(inputs)) fail(`${name} takes ${JSON.stringify(props)}, expected ${JSON.stringify(inputs)}`);
      if (props.some((p) => /token|password|secret|credential/i.test(p))) fail(`${name} takes a credential`);
      const required = (t?.inputSchema as { required?: string[] }).required ?? [];
      if (JSON.stringify([...required].sort()) !== JSON.stringify([...inputs].sort())) fail(`${name} requires ${JSON.stringify(required)}`);
      const outProps = Object.keys((t?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
      if (JSON.stringify(outProps) !== JSON.stringify(outputs))
        fail(`${name}'s output schema is ${JSON.stringify(outProps)}, expected ${JSON.stringify(outputs)}`);
    }
    const call = async (name: string, args: Record<string, unknown>): Promise<Result> => (await client.callTool({ name, arguments: args })) as Result;
    const preview = await call("scout_ticket_preview", { ids: ["a1b2c3d4e5"], to: "github", target: "acme/shop" });
    const file = await call("scout_ticket_file", { previewId: "tp-AAAAAAAAAAAAAAAA" });
    return { preview, file };
  });
  for (const [name, r] of Object.entries(out))
    if (!r.isError || !/No project is open yet/.test(textOf(r))) fail(`${name} with no project open did not say to attach first: ${textOf(r)}`);
  console.log("✓ scout_ticket_preview and scout_ticket_file are annotated and schema'd, take no credential, and refuse with no project open");
}

/**
 * A guided check's progress and its cards over the wire: a Look only plan
 * attached with, an area set, a finding filed there; the pane's poll carries
 * the progress; scout_cards shows the card with its picture inline; a
 * not-a-bug label from scout_feedback keeps the finding, leaves it out of the
 * default cards and the progress, and is listed as a candidate by export.
 */
async function guidedCardsCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-cards-"));
  type Result = {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  try {
    await withFormClient(undefined, undefined, async (client) => {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => (await client.callTool({ name, arguments: args })) as Result;
      const { tools } = await client.listTools();
      for (const [name, readOnly] of [
        ["scout_cards", true],
        ["scout_feedback", false],
        ["scout_team_report", false],
      ] as const) {
        const t = tools.find((x) => x.name === name);
        if (t?.annotations?.readOnlyHint !== readOnly || t.annotations.destructiveHint !== false || !t.outputSchema)
          fail(`${name} is not annotated readOnlyHint ${readOnly}, destructiveHint false, with an outputSchema: ${JSON.stringify(t?.annotations)}`);
      }
      const before = await call("scout_cards", {});
      if (!before.isError || !/attach first/.test(textOf(before))) fail(`scout_cards before any attach did not say to attach first: ${textOf(before)}`);
      // scout_team_report takes no arguments, and says what it returns.
      const teamTool = tools.find((x) => x.name === "scout_team_report");
      const teamOut = Object.keys((teamTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}).sort();
      if (
        Object.keys((teamTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}).length !== 0 ||
        teamOut.join(",") !== "evidenceDir,file,folder,manifest,missingPictures,path,pictures,problems"
      )
        fail(`scout_team_report's schemas are not no input and the TeamReport output: ${JSON.stringify({ input: teamTool?.inputSchema, out: teamOut })}`);
      const savedBefore = await call("scout_saved_checks", { action: "list" });
      if (!savedBefore.isError || !/pass the site's address/.test(textOf(savedBefore)))
        fail(`scout_saved_checks before any attach did not ask for the site's address: ${textOf(savedBefore)}`);
      const teamBefore = await call("scout_team_report", {});
      if (!teamBefore.isError || !/attach first/.test(textOf(teamBefore)))
        fail(`scout_team_report before any attach did not say to attach first: ${textOf(teamBefore)}`);

      const built = await call("scout_guided_plan", { choices: { address: fixture.baseUrl, areas: ["forms", "broken-pages"] } });
      const plan = built.structuredContent as { planId: string; mode: string };
      if (built.isError || plan.mode !== "observe") fail(`a Look only plan was not built: ${textOf(built)}`);
      type Poll = {
        guided?: {
          planId: string;
          phase: string;
          now: string;
          areas: Array<{ area: string; state: string }>;
          latest: Array<{ id: string }>;
          problems: { blocksUsers: number };
          saved: { basis: string } | null;
        };
      };
      const poll = async (): Promise<NonNullable<Poll["guided"]>> => {
        const g = ((await call(STATUS_POLL_TOOL, {})).structuredContent as Poll | undefined)?.guided;
        if (!g) fail("the pane's poll carries no guided progress while a guided plan is open");
        return g;
      };
      if ((await poll()).phase !== "starting") fail("a plan built but not attached with is not shown as starting");

      const attached = await call("scout_attach", {
        url: fixture.baseUrl,
        projectPath: projectDir,
        session: "g",
        mode: "observe",
        planId: plan.planId,
        objective: "guided",
      });
      if (attached.isError) fail(`the attach with a Look only plan was refused: ${textOf(attached)}`);
      await call("scout_session", { name: "g", area: "forms" });
      const filed = await call("scout_finding", {
        session: "g",
        task: "Check the form",
        severity: "high",
        category: "ux-confusing",
        title: "The send button gives no sign it worked",
        detail: "Pressing it changes nothing on the page.",
        evidence: "guided cards check",
      });
      const id = /\(id ([0-9a-f]{10})\)/.exec(textOf(filed))?.[1];
      if (!id) fail(`scout_finding gave no id: ${textOf(filed)}`);
      const running = await poll();
      if (
        running.planId !== plan.planId ||
        running.areas.find((a) => a.area === "forms")?.state !== "in-progress" ||
        running.latest[0]?.id !== id ||
        running.problems.blocksUsers !== 1 ||
        !running.now
      )
        fail(`the pane's poll does not show the check's progress: ${JSON.stringify(running).slice(0, 600)}`);
      const statusText = textOf(await call(STATUS_TOOL, {}));
      if (!statusText.includes(`Checking ${new URL(fixture.baseUrl).host}`)) fail(`${STATUS_TOOL}'s text carries no guided progress:\n${statusText}`);

      const cards = await call("scout_cards", { filter: { area: ["forms"] }, pictures: "inline" });
      const got = cards.structuredContent as { cards: Array<{ id: string; area?: string; picture: unknown }>; total: number };
      if (cards.isError || got.total !== 1 || got.cards[0].id !== id || got.cards[0].area !== "forms")
        fail(`scout_cards did not show the card found in the forms area: ${JSON.stringify(cards).slice(0, 600)}`);
      if (!textOf(cards).includes(`BLOCKS USERS - The send button gives no sign it worked`)) fail(`scout_cards' text is not the card: ${textOf(cards)}`);
      if (got.cards[0].picture && !cards.content.some((c) => c.type === "image" && c.mimeType === "image/png"))
        fail("scout_cards with pictures inline returned no image for a card that has a picture");

      // The team report of the same check: the card with its picture, written inside .scenescout/, and a manifest that is the files on disk.
      const team = await call("scout_team_report", {});
      const made = team.structuredContent as
        { file: string; problems: number; pictures: number; manifest: Array<{ file: string; sha256: string }> } | undefined;
      if (team.isError || !made || made.file !== ".scenescout/team-report.html" || made.problems !== 1 || made.pictures !== 1)
        fail(`scout_team_report did not write the check's card and picture: ${JSON.stringify(team).slice(0, 600)}`);
      for (const m of made.manifest) {
        const onDisk = createHash("sha256")
          .update(fs.readFileSync(path.join(projectDir, ...m.file.split("/"))))
          .digest("hex");
        if (!m.file.startsWith(".scenescout/") || onDisk !== m.sha256) fail(`scout_team_report's manifest entry ${m.file} is not the file on disk`);
      }
      if (!fs.readFileSync(path.join(projectDir, ".scenescout", "team-report.html"), "utf8").includes("The send button gives no sign it worked"))
        fail("the team report page does not show the check's problem");
      // The finding was filed in observe: a re-check of it is a Look only plan of its own, attached with its id, then scout_verify.
      for (const [name, readOnly] of [
        ["scout_recheck_plan", true],
        ["scout_saved_checks", false],
      ] as const) {
        const t = tools.find((x) => x.name === name);
        if (t?.annotations?.readOnlyHint !== readOnly || t.annotations.destructiveHint !== false || !t.outputSchema)
          fail(`${name} is not annotated readOnlyHint ${readOnly}, destructiveHint false, with an outputSchema: ${JSON.stringify(t?.annotations)}`);
      }
      const re = await call("scout_recheck_plan", {});
      const rePlan = re.structuredContent as
        | { planId: string; mode: string; confirm: unknown; recheck?: { ids: string[] }; calls: Array<{ tool: string; args: Record<string, unknown> }> }
        | undefined;
      if (
        re.isError ||
        !rePlan ||
        rePlan.planId === plan.planId ||
        rePlan.mode !== "observe" ||
        rePlan.confirm !== null ||
        !rePlan.recheck?.ids.includes(id) ||
        rePlan.calls.find((c) => c.tool === "scout_attach")?.args.planId !== rePlan.planId ||
        !rePlan.calls.some((c) => c.tool === "scout_verify")
      )
        fail(`scout_recheck_plan did not build a Look only re-check of the observe finding: ${JSON.stringify(re).slice(0, 800)}`);
      // Saved checks: the plan's choices, owner-only, under .scenescout/guided/; run again, a new plan; and no credential field.
      const saved = await call("scout_saved_checks", { action: "save", name: "Forms and pages", planId: plan.planId });
      const savedFile = path.join(projectDir, ".scenescout", "guided", "forms-and-pages.json");
      if (saved.isError || !fs.existsSync(savedFile)) fail(`scout_saved_checks did not save the check: ${textOf(saved)}`);
      if (process.platform !== "win32" && (fs.statSync(savedFile).mode & 0o777) !== 0o600) fail("a saved check is not owner-only");
      if (Object.keys(JSON.parse(fs.readFileSync(savedFile, "utf8"))).join(",") !== "name,choices,savedAt")
        fail(`a saved check holds more than its choices: ${fs.readFileSync(savedFile, "utf8")}`);
      const reSave = await call("scout_saved_checks", { action: "save", name: "Re-check", planId: rePlan!.planId });
      if (!reSave.isError || !/re-check is not saved/.test(textOf(reSave))) fail(`a re-check was saved: ${textOf(reSave)}`);
      const listed = (await call("scout_saved_checks", { action: "list" })).structuredContent as { saved: Array<{ name: string }> };
      if (listed.saved.map((c) => c.name).join(",") !== "Forms and pages") fail(`scout_saved_checks list: ${JSON.stringify(listed)}`);
      const rerun = await call("scout_saved_checks", { action: "run", name: "forms and pages" });
      const rerunPlan = (rerun.structuredContent as { plan?: { planId: string; mode: string } } | undefined)?.plan;
      if (rerun.isError || !rerunPlan || rerunPlan.planId === plan.planId || rerunPlan.mode !== "observe")
        fail(`scout_saved_checks run did not build a new plan: ${JSON.stringify(rerun).slice(0, 600)}`);
      fs.writeFileSync(
        path.join(projectDir, ".scenescout", "guided", "tampered.json"),
        JSON.stringify({ name: "Tampered", choices: {}, savedAt: "x", cookies: [] }),
      );
      const tampered = await call("scout_saved_checks", { action: "run", name: "Tampered" });
      if (!tampered.isError || !/no field for a password, code, token or cookie/.test(textOf(tampered)))
        fail(`a saved check with a cookie field was run: ${textOf(tampered)}`);
      const deleted = await call("scout_saved_checks", { action: "delete", name: "Forms and pages" });
      if (deleted.isError || fs.existsSync(savedFile)) fail(`scout_saved_checks did not delete the check: ${textOf(deleted)}`);
      const labelled = await call("scout_feedback", { id, verdict: "not-a-bug", reason: "The page reloads on purpose" });
      if (labelled.isError || (labelled.structuredContent as { verdict?: string }).verdict !== "not-a-bug")
        fail(`scout_feedback did not label the finding: ${textOf(labelled)}`);
      const after = (await call("scout_cards", {})).structuredContent as { total: number; notABug: number };
      if (after.total !== 0 || after.notABug !== 1) fail(`a not-a-bug finding is not left out of the default cards and counted: ${JSON.stringify(after)}`);
      const kept = (await call("scout_cards", { ids: [id] })).structuredContent as { cards: Array<{ feedback?: { verdict: string } }> };
      if (kept.cards[0]?.feedback?.verdict !== "not-a-bug") fail("the labelled finding is not kept with its label");
      if ((await poll()).problems.blocksUsers !== 0) fail("the progress still counts a finding the person marked not a bug");
      const exported = await call("scout_feedback", { export: true });
      const candidates = (exported.structuredContent as { candidates: Array<{ findingId: string; suggests: string }> }).candidates;
      if (
        candidates.length !== 1 ||
        candidates[0].findingId !== id ||
        candidates[0].suggests !== "non-defect" ||
        !/candidates for a maintainer/.test(textOf(exported))
      )
        fail(`scout_feedback export did not list the label as a candidate: ${textOf(exported)}`);
      const unknown = await call("scout_feedback", { id: "ffffffffff", verdict: "confirmed" });
      if (!unknown.isError) fail("scout_feedback labelled a finding that does not exist");
      await call("scout_close", { all: true });
    });
  } finally {
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  console.log(
    "✓ a guided check's progress reaches the pane's poll and the status text, scout_cards shows its card with the area and picture, scout_team_report writes it with its picture and a manifest that matches the files, scout_recheck_plan re-checks it in the mode it was found in under a plan of its own, scout_saved_checks saves, lists, runs and deletes a check owner-only and refuses one with a cookie field, and a not-a-bug label keeps the finding, leaves it out of the cards and the count, and is exported as a candidate",
  );
}

/**
 * A call the watchdog gave up on keeps running in the background. Once
 * scout_close has answered it must not write into the project any more: the
 * folder may be removed, or another session attached to it. The watchdog is
 * cut to one second for this server, and the session paced at four, so a
 * navigation is still waiting out its pace when the watchdog answers and the
 * close begins. Closing the browser ends that wait, and the navigation then
 * unwinds and schedules a memory save; the close must wait for it and write
 * that save before it answers.
 */
async function abandonedCallCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-abandoned-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none", SCENESCOUT_WATCHDOG_MS: "1000" }).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  const client = new Client({ name: "ft-check-abandoned", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  try {
    await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "slow", mode: "read-only", paceMs: 4000 });
    const slow = await call("scout_navigate", { session: "slow", target: "/", task: "Opening the start page at a slow pace" });
    if (!/timed out|watchdog/i.test(slow)) fail(`a call held past the watchdog was not cut off:\n${slow}`);
    const closed = await call("scout_close", { session: "slow" });
    if (!closed.includes('Session "slow" closed')) fail(`the session did not close:\n${closed}`);
    const settled = treeState(projectDir);
    // Past the end of the pace the navigation was waiting out.
    await new Promise((r) => setTimeout(r, 4000));
    if (treeState(projectDir) !== settled) fail("a call the watchdog cut off still wrote into the project after scout_close answered");
    console.log("✓ a call the watchdog cut off writes nothing into the project once scout_close has answered");
  } finally {
    await client.close();
    await fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * A SCENESCOUT_TICKET_DIRS entry that is not an absolute path stops the server
 * as it starts, naming the entry, rather than being found the first time a
 * ticket outside the project is asked for. Stdin is closed at once, so a server
 * that does start ends too, and the check reads what it said and how it ended.
 */
function ticketDirsStartupCheck(): void {
  const base = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none" }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const start = (dirs: string) =>
    spawnSync(process.execPath, [serverPath], { input: "", encoding: "utf8", timeout: 30_000, env: { ...base, SCENESCOUT_TICKET_DIRS: dirs } });
  for (const entry of ["specs", "~/specs"]) {
    const run = start([os.tmpdir(), entry].join(path.delimiter));
    if (run.status === 0 || !run.stderr.includes(`SCENESCOUT_TICKET_DIRS names "${entry}"`))
      fail(`a server with SCENESCOUT_TICKET_DIRS naming "${entry}" did not stop at startup naming it (exit ${run.status}):\n${run.stderr}`);
  }
  const good = start([os.tmpdir(), ""].join(path.delimiter));
  if (good.status !== 0 || good.stderr.includes("SCENESCOUT_TICKET_DIRS"))
    fail(`a server with an absolute SCENESCOUT_TICKET_DIRS and an empty entry did not start cleanly (exit ${good.status}):\n${good.stderr}`);
  // A folder that is not there is warned about by name, and the server still starts: it may be on a drive not yet mounted.
  const absent = path.join(os.tmpdir(), "scenescout-no-such-ticket-folder");
  const warned = start(absent);
  if (warned.status !== 0 || !warned.stderr.includes(`SCENESCOUT_TICKET_DIRS names "${absent}", which is not there`))
    fail(`a server with SCENESCOUT_TICKET_DIRS naming a missing folder did not start with a warning naming it (exit ${warned.status}):\n${warned.stderr}`);
  console.log(
    "✓ a relative or ~ entry in SCENESCOUT_TICKET_DIRS stops the server at startup, naming it; an absolute one and an empty one do not; a missing one is warned about by name",
  );
}

/** A prompt's text, as the chat would show it. */
function promptTextOf(result: { messages: Array<{ content: { type: string; text?: string } }> }): string {
  return result.messages.map((m) => (m.content.type === "text" ? (m.content.text ?? "") : "")).join("\n");
}

/**
 * The operator's config (engine/project-config.ts, issue #546), over the wire:
 * a server started with a config refuses an attach that asks for more than it
 * allows, before any browser starts, and says why; an attach that asks for
 * nothing is lowered to it; a project's own file tightens a server that has
 * none; and a config that is not valid stops the server as it starts.
 */
async function configCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-config-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir);
  const configFile = (name: string, body: unknown): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  const base = Object.fromEntries(
    Object.entries({ ...process.env, SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none" }).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[0] !== "SCENESCOUT_CONFIG",
    ),
  );
  const withServer = async (
    env: Record<string, string>,
    use: (
      attach: (args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>,
      call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>,
      client: Client,
    ) => Promise<void>,
  ) => {
    const client = new Client({ name: "ft-check-config", version: "0.0.1" });
    await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: { ...base, ...env }, cwd: dir }));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as ToolText & { isError?: boolean };
        return { isError: r.isError === true, text: textOf(r) };
      };
      await use((args) => call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, ...args }), call, client);
      assertClosedAll(textOf(await client.callTool({ name: "scout_close", arguments: { all: true } })));
    } finally {
      await client.close();
    }
  };
  try {
    const observeOnly = configFile("observe.json", { maxMode: "observe" });
    await withServer({ SCENESCOUT_CONFIG: observeOnly }, async (attach) => {
      const refused = await attach({ mode: "read-only" });
      if (
        !refused.isError ||
        !refused.text.includes(`refused by the SceneScout config (${observeOnly}): mode "read-only" is above the config's maxMode "observe"`)
      )
        fail(`a server whose config sets maxMode observe did not refuse a read-only attach, naming the file:\n${refused.text}`);
      const lowered = await attach({});
      if (lowered.isError || !lowered.text.includes("🔒 CONFIG") || !/mode "observe": the default "read-only" is above the config's maxMode/.test(lowered.text))
        fail(`an attach naming no mode under maxMode observe did not start in observe, saying so:\n${lowered.text}`);
    });
    const strict = configFile("strict.json", { preset: "strict" });
    await withServer({ SCENESCOUT_CONFIG: strict }, async (attach) => {
      const posts = await attach({ mode: "observe", readPosts: ["POST /api/search"] });
      if (!posts.isError || !/the config allows no readPosts/.test(posts.text))
        fail(`the strict preset did not refuse readPosts from an attach:\n${posts.text}`);
      const above = await attach({ mode: "read-only" });
      if (!above.isError || !/maxMode "observe"/.test(above.text)) fail(`the strict preset did not refuse a read-only attach:\n${above.text}`);
    });
    // uploads "fixtures": a file from disk is refused before the engine is asked, in scout_upload and in a plan's upload step.
    await withServer({ SCENESCOUT_CONFIG: configFile("fixtures.json", { uploads: "fixtures" }) }, async (attach, call) => {
      const r = await attach({ mode: "observe" });
      if (r.isError) fail(`an observe attach under uploads "fixtures" was refused:\n${r.text}`);
      const disk = await call("scout_upload", { filePath: "sample.pdf", task: "Uploading a file" });
      if (!disk.isError || !/uploads "fixtures" allows only generated files/.test(disk.text))
        fail(`uploads "fixtures" did not refuse a file from disk in scout_upload:\n${disk.text}`);
      const step = await call("scout_run_plan", { steps: [{ action: "upload", target: "label=File", value: "sample.pdf" }], task: "Uploading a file" });
      if (!step.isError || !/step 1 refused by the SceneScout config/.test(step.text))
        fail(`uploads "fixtures" did not refuse a plan's upload step naming a file:\n${step.text}`);
      const fixture = await call("scout_upload", { fixture: "pdf", task: "Uploading a file" });
      if (/SceneScout config/.test(fixture.text)) fail(`uploads "fixtures" refused a generated fixture:\n${fixture.text}`);
    });
    // projectsRoot: a project folder outside it is refused at attach and at scan; one inside it is taken.
    const root = path.join(dir, "root");
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    await withServer({ SCENESCOUT_CONFIG: configFile("root.json", { projectsRoot: root }) }, async (attach, call) => {
      const outside = await attach({ mode: "observe", session: "outside" });
      if (!outside.isError || !/is outside the config's projectsRoot/.test(outside.text))
        fail(`an attach whose projectPath is outside projectsRoot was not refused:\n${outside.text}`);
      const scan = await call("scout_scan", { projectPath: projectDir });
      if (!scan.isError || !/is outside the config's projectsRoot/.test(scan.text)) fail(`scout_scan outside projectsRoot was not refused:\n${scan.text}`);
      const inside = await attach({ mode: "observe", session: "inside", projectPath: path.join(root, "app") });
      if (inside.isError) fail(`an attach whose projectPath is inside projectsRoot was refused:\n${inside.text}`);
    });
    // requireGuidedPlan alone: the gate holds from the start, before any plan is built.
    await withServer({ SCENESCOUT_CONFIG: configFile("guided.json", { requireGuidedPlan: true }) }, async (attach) => {
      const r = await attach({ mode: "read-only" });
      if (!r.isError || !/requires a guided plan \(requireGuidedPlan\)/.test(r.text))
        fail(`requireGuidedPlan did not hold the guided gate from the server's start:\n${r.text}`);
    });
    // No operator config, a project file that sets one: the project's file tightens; the same attach without it goes ahead.
    await withServer({}, async (attach, call) => {
      const free = await attach({ session: "free" });
      if (free.isError || free.text.includes("CONFIG") || !/read-only/.test(free.text))
        fail(`with no config, an attach naming no mode did not start in read-only as it always has:\n${free.text}`);
      // The contrast to uploads "fixtures": with no config, a file from disk goes on to the engine's own fence.
      const disk = await call("scout_upload", { filePath: "sample.pdf", session: "free", task: "Uploading a file" });
      if (/SceneScout config/.test(disk.text)) fail(`with no config, scout_upload was refused by a config:\n${disk.text}`);
      // A session's config follows the session it runs: an attach refused before the old one closes keeps the old project's,
      // and one that fails after the old one closed has started the new project's, whose own file holds uploads to fixtures.
      const loose = path.join(dir, "loose");
      const tight = path.join(dir, "tight");
      fs.mkdirSync(loose, { recursive: true });
      fs.mkdirSync(path.join(tight, ".scenescout"), { recursive: true });
      fs.writeFileSync(path.join(tight, ".scenescout", "config.json"), JSON.stringify({ uploads: "fixtures" }));
      const upload = (session: string) => call("scout_upload", { filePath: "sample.pdf", session, task: "Uploading a file" });
      for (const s of ["kept", "moved"]) {
        const first = await attach({ session: s, projectPath: loose });
        if (first.isError) fail(`an attach to a project with no config file was refused:\n${first.text}`);
      }
      const noRole = await attach({ session: "kept", projectPath: tight, role: "nobody-saved-this" });
      if (!noRole.isError) fail(`an attach naming a role with no saved profile was not refused:\n${noRole.text}`);
      const kept = await upload("kept");
      if (/SceneScout config/.test(kept.text)) fail(`an attach refused before the old session closed changed the old session's config:\n${kept.text}`);
      const gone = await attach({ session: "moved", projectPath: tight, url: "http://127.0.0.1:9/" });
      if (!gone.isError) fail(`an attach to an address nothing answers was not refused:\n${gone.text}`);
      const moved = await upload("moved");
      if (!moved.isError || !/uploads "fixtures" allows only generated files/.test(moved.text))
        fail(`an attach that failed after the old session closed left the old project's config on the session:\n${moved.text}`);
      fs.mkdirSync(path.join(projectDir, ".scenescout"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".scenescout", "config.json"), JSON.stringify({ maxMode: "observe" }));
      const tightened = await attach({ mode: "read-only", session: "tight" });
      if (!tightened.isError || !/maxMode "observe"/.test(tightened.text))
        fail(`a project's own config did not tighten a server with none:\n${tightened.text}`);
      // requireGuidedPlan in the project's own file holds the gate too.
      fs.writeFileSync(path.join(projectDir, ".scenescout", "config.json"), JSON.stringify({ requireGuidedPlan: true }));
      const gated = await attach({ mode: "read-only", session: "gated" });
      if (!gated.isError || !/requires a guided plan/.test(gated.text))
        fail(`requireGuidedPlan in a project's own config did not hold the guided gate:\n${gated.text}`);
    });
    // No SCENESCOUT_CONFIG: the file in the directory the server started in is the lock, and the folder the agent names
    // as projectPath cannot loosen it. The guided plan offers no care level above it either.
    fs.mkdirSync(path.join(dir, ".scenescout"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".scenescout", "config.json"), JSON.stringify({ maxMode: "observe" }));
    fs.writeFileSync(path.join(projectDir, ".scenescout", "config.json"), JSON.stringify({ maxMode: "destructive" }));
    await withServer({}, async (attach, call, client) => {
      const loosen = await attach({ mode: "read-only" });
      if (!loosen.isError || !/refused by the SceneScout config/.test(loosen.text) || !/maxMode "observe"/.test(loosen.text))
        fail(`a project's own config loosened the launch directory's, or the launch directory's was not read:\n${loosen.text}`);
      const plan = await call("scout_guided_plan", { choices: { address: fixture.baseUrl, areas: ["forms"], care: "may-submit-forms" } });
      if (!plan.isError || !/the SceneScout config/.test(plan.text)) fail(`scout_guided_plan built a plan above the config's maxMode:\n${plan.text}`);
      const look = await call("scout_guided_plan", { choices: { address: fixture.baseUrl, areas: ["forms"], care: "look-only" } });
      if (look.isError) fail(`scout_guided_plan refused Look only under maxMode observe:\n${look.text}`);
      // The chat's guided prompts offer no care level above it.
      const prompt = promptTextOf(await client.getPrompt({ name: "check-my-site" }));
      if (!prompt.includes('allows no care level above "Look only"') || prompt.includes('"May submit forms"'))
        fail(`the Check my site prompt offered a care level above the config's maxMode observe:\n${prompt}`);
    });
    fs.rmSync(path.join(dir, ".scenescout"), { recursive: true });
    fs.rmSync(path.join(projectDir, ".scenescout", "config.json"));
    // A config that is not valid stops the server as it starts, naming the key.
    const bad = spawnSync(process.execPath, [serverPath], {
      input: "",
      encoding: "utf8",
      timeout: 30_000,
      env: { ...base, SCENESCOUT_CONFIG: configFile("bad.json", { maxMode: "observe", egres: "none" }) },
    });
    if (bad.status === 0 || !bad.stderr.includes('unknown key "egres"'))
      fail(`a config with an unknown key did not stop the server at startup naming it (exit ${bad.status}):\n${bad.stderr}`);
    console.log(
      "✓ a server's config refuses an attach above maxMode and the strict preset's readPosts, naming the file; lowers an attach that names no mode; requireGuidedPlan holds the gate from the start; uploads \"fixtures\" refuses a file from disk in scout_upload and a plan step; projectsRoot refuses an attach and a scan outside it; a session's config is its new project's once the old session closed, and its old one's when the attach was refused before that; a project's file tightens and cannot loosen the launch directory's; a guided plan above maxMode is refused and the guided prompts offer no care level above it; a bad config stops the server",
    );
  } finally {
    await fixture.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  // On a desktop the server opens the live view and the report by default; a check opens nothing.
  const transport = new StdioClientTransport({ command: "node", args: [serverPath], env: { ...getDefaultEnvironment(), SCENESCOUT_OPEN: "none" } });
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

  // observe lets out HEAD and OPTIONS as well as GET; a description that says only GET misleads the agent choosing a mode.
  const attachDescription = tools.find((t) => t.name === "scout_attach")?.description ?? "";
  if (!/observe' lets out only GET, HEAD and OPTIONS/.test(attachDescription) || /not a GET|only a GET|only GET requests/.test(attachDescription))
    fail(`scout_attach's description does not state what observe lets out (GET, HEAD and OPTIONS):\n${attachDescription.slice(0, 600)}`);

  // The run-status pane, an MCP App (SEP-1865). The SDK this server is built on
  // has no notion of visibility, so the host is what keeps an app-only tool from
  // the model; what the server owes it is the _meta that says so.
  type UiMeta = { ui?: { resourceUri?: string; visibility?: string[] } };
  const statusTool = tools.find((t) => t.name === STATUS_TOOL);
  const pollTool = tools.find((t) => t.name === STATUS_POLL_TOOL);
  if ((statusTool?._meta as UiMeta | undefined)?.ui?.resourceUri !== STATUS_PANE_URI)
    fail(`${STATUS_TOOL} does not link the pane through _meta.ui.resourceUri: ${JSON.stringify(statusTool?._meta)}`);
  if (JSON.stringify((pollTool?._meta as UiMeta | undefined)?.ui?.visibility) !== JSON.stringify(["app"]))
    fail(`${STATUS_POLL_TOOL} is not marked app-only (_meta.ui.visibility ["app"]), so a host would list it to the model: ${JSON.stringify(pollTool?._meta)}`);
  const { resources } = await client.listResources();
  const paneResource = resources.find((r) => r.uri === STATUS_PANE_URI);
  if (paneResource?.mimeType !== MCP_APP_MIME) fail(`the pane's resource is not listed as ${MCP_APP_MIME}: ${JSON.stringify(resources)}`);
  const read = await client.readResource({ uri: STATUS_PANE_URI });
  const paneContent = read.contents[0] as { uri: string; mimeType?: string; text?: string; _meta?: { ui?: { csp?: Record<string, unknown> } } } | undefined;
  if (paneContent?.mimeType !== MCP_APP_MIME || !paneContent.text?.startsWith("<!doctype html>"))
    fail(`reading the pane's resource does not return an HTML document as ${MCP_APP_MIME}: ${JSON.stringify(paneContent).slice(0, 200)}`);
  if (Object.keys(paneContent._meta?.ui?.csp ?? { unset: true }).length !== 0)
    fail(`the pane's resource declares outside origins: ${JSON.stringify(paneContent._meta)}`);
  const unattached = textOf(await client.callTool({ name: STATUS_TOOL }));
  if (!/^Live view: not available\. The live view starts with the first scout_attach\.\nNo session is attached\.$/.test(unattached))
    fail(`${STATUS_TOOL} before any attach does not say where the live view comes from:\n${unattached}`);
  console.log(`✓ ${STATUS_TOOL} links a ${MCP_APP_MIME} resource, its poll tool is app-only, and its text stands alone`);

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
  const liveListed = prompts.find((p) => p.name === "live");
  const loginListed = prompts.find((p) => p.name === "login");
  const liveGot = await client.getPrompt({ name: "live" });
  const liveText = promptTextOf(liveGot);
  const loginGot = await client.getPrompt({ name: "login", arguments: { role: "admin", url: "http://localhost:3000" } });
  const loginText = promptTextOf(loginGot);
  const loginBare = await client.getPrompt({ name: "login" }).then(
    () => "",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  const loginSecret = await client.getPrompt({ name: "login", arguments: { role: "admin", password: "hunter2" } }).then(
    () => "accepted",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  const loginArgs = loginListed?.arguments ?? [];
  if (
    prompts
      .map((p) => p.name)
      .sort()
      .join(",") !== "check-my-site,explore,file-tickets,is-it-safe,live,login,recheck,team-report" ||
    (liveListed?.arguments ?? []).length !== 0 ||
    !liveText.includes("127.0.0.1") ||
    !/scout_session with no arguments/.test(liveText) ||
    /password\s*[:=]/i.test(liveText) ||
    loginArgs.map((a) => `${a.name}:${a.required === true}`).join(",") !== "role:true,url:false" ||
    loginArgs.some((a) => /password|secret|token|credential/i.test(a.name)) ||
    !loginText.includes('{"role":"admin","url":"http://localhost:3000"}') ||
    !/scout_login/.test(loginText) ||
    !/give a role name/.test(loginBare) ||
    loginSecret.includes("hunter2") ||
    !/does not take password/.test(loginSecret)
  ) {
    console.error(
      `MCP CHECK FAILED — live or login prompt is missing, takes a password, or does not say what to call.\n` +
        `live: ${JSON.stringify(liveText.slice(0, 200))}\nlogin: ${JSON.stringify(loginText.slice(0, 200))}\n` +
        `no role: ${JSON.stringify(loginBare)}\npassword arg: ${JSON.stringify(loginSecret)}`,
    );
    process.exit(1);
  }
  console.log("✓ the method reaches a client through instructions, scout_playbook and the explore prompt");
  console.log("✓ live and login prompts are listed, name no password, and tell the model what to return or call");
  // The guided prompts: listed with the panel's titles, one round trip with an address, and a refusal that repeats nothing.
  const checkListed = prompts.find((p) => p.name === "check-my-site");
  const checkGot = promptTextOf(await client.getPrompt({ name: "check-my-site", arguments: { url: "http://localhost:3000" } }));
  const checkBare = promptTextOf(await client.getPrompt({ name: "check-my-site" }));
  const checkSecret = await client.getPrompt({ name: "check-my-site", arguments: { url: "https://bob:hunter2pass@staging.example.com" } }).then(
    () => "accepted",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  const safeGot = promptTextOf(await client.getPrompt({ name: "is-it-safe" }));
  const ticketsTo = await client.getPrompt({ name: "file-tickets", arguments: { to: "ghp_A1b2C3d4E5f6G7h8" } }).then(
    () => "accepted",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  const titles = Object.fromEntries(prompts.map((p) => [p.name, p.title]));
  if (
    checkListed?.title !== "Check my site" ||
    titles["recheck"] !== "Re-check after a fix" ||
    titles["team-report"] !== "Make a team report" ||
    titles["file-tickets"] !== "File problems as tickets" ||
    titles["is-it-safe"] !== "Is it safe to run on my live site?" ||
    (checkListed.arguments ?? []).map((a) => `${a.name}:${a.required === true}`).join(",") !== "url:false" ||
    !checkGot.includes('Call scout_intake with {"url":"http://localhost:3000"}') ||
    !checkBare.includes("Call scout_intake with no arguments") ||
    !/scout_cards/.test(checkGot) ||
    checkSecret.includes("hunter2pass") ||
    !/no user name or password in the address/.test(checkSecret) ||
    !/word for word/.test(safeGot) ||
    !safeGot.includes("It never asks for your password.") ||
    ticketsTo.includes("ghp_") ||
    !/to must be github or jira/.test(ticketsTo)
  ) {
    console.error(
      `MCP CHECK FAILED — a guided prompt is missing, mistitled, or does not say what to call, or a refusal repeats what it refused.\n` +
        `titles: ${JSON.stringify(titles)}\ncheck-my-site: ${JSON.stringify(checkGot.slice(0, 300))}\n` +
        `credential url: ${JSON.stringify(checkSecret)}\nfile-tickets to: ${JSON.stringify(ticketsTo)}`,
    );
    process.exit(1);
  }
  console.log("✓ the guided prompts are listed with the panel's titles, check-my-site starts scout_intake with its address, and refusals repeat nothing");

  // The SKILL is the agent's entire methodology — a tool it never mentions is
  // effectively unshipped, however well the engine implements it. scout_scroll
  // shipped a whole version before the skill described it, and nothing caught
  // that but a human noticing.
  const skillPath = path.join(packageRoot, "skills", "scenescout", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  // An app-only tool is for the pane, not the agent, so the skill need not name it.
  const appOnly = (t: (typeof tools)[number]): boolean => {
    const visibility = (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility;
    return Array.isArray(visibility) && !visibility.includes("model");
  };
  const forTheModel = tools.filter((t) => !appOnly(t)).map((t) => t.name);
  const undocumented = forTheModel.filter((t) => !skill.includes(t));
  if (undocumented.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions: ${undocumented.join(", ")}\n` +
        `Every registered tool must appear in skills/scenescout/SKILL.md, or the agent will never use it.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents all ${forTheModel.length} tools the model sees`);

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
    const text = asLf(fs.readFileSync(path.join(guideDir, file), "utf8"));
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
  const reference = asLf(fs.readFileSync(path.join(guideDir, "Configuration-reference.md"), "utf8"));
  const attachSection = (reference.split("\n## `scout_attach` options\n")[1] ?? "").split("\n## ")[0];
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
  // Prompt names and arguments, held to prompts/list the same way tool options are held to their schemas.
  const promptSection = (reference.split("\n## MCP prompts\n")[1] ?? "").split("\n## ")[0];
  const promptRows = [...promptSection.matchAll(/^\| `([a-z][a-z-]*)` \| ([^|\n]+) \|/gm)];
  const listedPrompts = new Map<string, Array<{ name: string; required: boolean }>>();
  if (!promptSection) guideGaps.push("Configuration-reference.md has no MCP prompts section");
  for (const row of promptRows) {
    const cell = row[2].trim();
    const args =
      cell === "none"
        ? []
        : [...cell.matchAll(/`([A-Za-z][A-Za-z0-9]*)`\s*\((required|optional)\)/g)].map((m) => ({
            name: m[1],
            required: m[2] === "required",
          }));
    if (cell !== "none" && args.length === 0)
      guideGaps.push(`Configuration-reference.md prompt ${row[1]} has arguments that are not \`name\` (required|optional)`);
    listedPrompts.set(row[1], args);
  }
  const servedPrompts = new Map(prompts.map((p) => [p.name, p]));
  const listedNames = [...listedPrompts.keys()].sort().join(",");
  const servedNames = [...servedPrompts.keys()].sort().join(",");
  if (listedNames !== servedNames) guideGaps.push(`Configuration-reference.md lists prompts [${listedNames}], the server has [${servedNames}]`);
  for (const [name, args] of listedPrompts) {
    const served = (servedPrompts.get(name)?.arguments ?? []).map((a) => ({ name: a.name, required: a.required === true }));
    if (JSON.stringify(args) !== JSON.stringify(served))
      guideGaps.push(`Configuration-reference.md lists ${name} arguments ${JSON.stringify(args)}, the server has ${JSON.stringify(served)}`);
    if (args.some((a) => /password|secret|token|credential/i.test(a.name)))
      guideGaps.push(`Configuration-reference.md prompt ${name} takes a credential argument`);
  }
  if (guideGaps.length > 0) {
    console.error(`MCP CHECK FAILED — the guide disagrees with the server's tools:\n  ${guideGaps.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    "✓ the guide names only tools and parameters the server has, lists every scout_attach option, which scout_attach and scout_login options are required, and the same prompts the server lists",
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
  await ticketsCheck(client);
  const liveProject = await liveViewCheck(client);
  await client.close();
  await tokenGoneCheck(liveProject);
  await liveViewOffCheck();
  await dedupJudgeEnvCheck();
  await defaultFolderCheck();
  await findingPictureCapCheck();
  await runPagePicturesAcrossProjectsCheck();
  await boardPicturesAcrossProjectsCheck();
  await openCheck();
  await intakeCheck();
  await guidedCheck();
  await ticketToolsCheck();
  await configCheck();
  await guidedCardsCheck();
  await abandonedCallCheck();
  ticketDirsStartupCheck();
  console.log("\nMCP CHECK PASSED");
}

main().catch((err) => {
  console.error("MCP CHECK CRASHED:", err);
  process.exit(1);
});
