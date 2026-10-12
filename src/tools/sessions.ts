/**
 * Starting, signing in and switching sessions: scout_scan, scout_attach, scout_login, scout_session, and scout_close.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readyBrowser, type LaunchNeed } from "../engine/launch.js";
import { defaultEngine } from "../browsers.js";
import { downloadBrowsers, presentBrowsers } from "../installer.js";
import { MemoryStore } from "../engine/memory.js";
import { DEDUP_ENV, DEDUP_MODES, type DedupMode } from "../engine/ci.js";
import { DedupJudge, planDedup, samplingAsk } from "../engine/dedup.js";
import { httpJudgeAsk } from "../ci-run.js";
import { laneCloseGuard } from "../engine/lane.js";
import { liveViewUrl } from "../engine/status-pane.js";
import { decideOpen, OPEN_CHOICES, OPEN_ENV, openChoiceFromEnv, type OpenChoice } from "../engine/open.js";
import { parseLoginArgs } from "../engine/profiles.js";
import type { BrowserEngineName } from "../browsers.js";
import { LOGIN_WINDOW_MAX_MS, savedLine, startLoginWindow } from "../login-run.js";
import { WAIT_SAYS } from "../engine/signed-in.js";
import {
  ACTION_TIMEOUT_ENV,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_CRAWL_NAV_TIMEOUT_MS,
  DEFAULT_NAV_TIMEOUT_MS,
  LIMIT_BOUNDS,
  NAV_TIMEOUT_ENV,
} from "../engine/limits.js";
import { MAX_READ_POSTS, READ_POSTS_ENV } from "../engine/policy.js";
import { chooseProjectFolder, PROJECTS_DIR_ENV, workspaceFromRoots } from "../engine/project-folder.js";
import { RECORD_MAX_FRAMES } from "../engine/replay.js";
import { describePace, normalizePace } from "../engine/settle.js";
import { formatScan, scanProject } from "../scan.js";
import { areaRefusal, CHECK_AREAS, guidedAttachVerdict, holdGuidedPlan, type CheckArea } from "../engine/guided.js";
import { AREA_LABEL } from "../engine/guided-words.js";
import { EVIDENCE_ENV, EVIDENCE_MODES, evidenceSettings, RECORD_ENV, recordChoice, type EvidenceMode } from "../engine/capture.js";

import {
  engines,
  memories,
  activeName,
  engineFor,
  server,
  text,
  errorText,
  board,
  lastWriter,
  live,
  liveAddress,
  keepReport,
  ensureLive,
  liveLine,
  openDecisions,
  liveOpened,
  openWhySaid,
  openForUser,
  settleProjectWrites,
  writeStatus,
  sessionQueue,
  guidedPlans,
  guidedSessions,
  callWork,
  CLOSE_WORK_WAIT_MS,
  flushAfterClose,
  stillRunningNote,
  type RequestExtra,
  requestExtra,
  serializedControl,
  laneLedger,
  withoutKeys,
  logLine,
  evidenceFor,
  pendingLogins,
  setActiveName,
  setActiveNameIsExplicit,
  setLastWriter,
  setLiveOpened,
  setOpenWhySaid,
} from "../server-context.js";

/**
 * readyBrowser with the real download, returning the line that opens the
 * attach's answer when it downloaded (empty when it did not). Each line goes
 * to stderr and, when the client asked for progress, as a progress
 * notification; the last one is repeated while the download runs, so a client
 * that extends its timeout on progress keeps waiting.
 */
async function readyBrowserFor(need: LaunchNeed, extra?: RequestExtra): Promise<string> {
  const token = extra?._meta?.progressToken;
  let progress = 0;
  let last = "";
  const notify = (message: string): void => {
    if (token === undefined || !extra) return;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } }).catch((err: unknown) => {
      logLine(`progress notification failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const say = (line: string): void => {
    last = line;
    logLine(line);
    notify(line);
  };
  const note = await readyBrowser(need, {
    env: process.env,
    present: presentBrowsers,
    say,
    download: async (targets) => {
      const heartbeat = setInterval(() => notify(last), 10_000);
      try {
        return await downloadBrowsers(targets, "stderr");
      } finally {
        clearInterval(heartbeat);
      }
    },
  });
  return note ? `${note}\n\n` : "";
}

/**
 * The folder an attach keeps its files in (engine/project-folder.ts): the
 * projectPath given, else the client's workspace folder, else a folder per
 * tested site. Only a client that offers roots is asked for them.
 */
async function projectFolderFor(url: string, given: string | undefined) {
  let workspace: string | null = null;
  if (given === undefined && server.server.getClientCapabilities()?.roots) {
    try {
      workspace = workspaceFromRoots((await server.server.listRoots(undefined, { timeout: 3000 })).roots);
    } catch (err) {
      logLine(`the client offers a workspace but did not list it (${(err as Error).message}); using the default folder`);
    }
  }
  const userDirsFile = path.join(os.homedir(), ".config", "user-dirs.dirs");
  const userDirs = process.platform === "linux" && fs.existsSync(userDirsFile) ? fs.readFileSync(userDirsFile, "utf8") : undefined;
  return chooseProjectFolder({
    given,
    workspace,
    url,
    home: { platform: process.platform, homedir: os.homedir(), env: process.env, userDirs },
    exists: fs.existsSync,
  });
}

/**
 * Set how a project's filings are deduplicated for this run (engine/dedup.ts
 * planDedup): what this attach names, else what an earlier attach of the run
 * named, else DEDUP_ENV. Returns the line the attach reports, or "".
 */
function configureDedup(store: MemoryStore, asked: DedupMode | undefined): string {
  if (asked) store.dedupChoice = asked;
  const plan = planDedup(store.dedupChoice, process.env, server.server.getClientCapabilities());
  if (plan.mode === "rule") {
    store.dedupJudge = null;
    store.dedupOff = undefined;
    return "";
  }
  // On already for this run: say so only when it has since been switched off.
  if (store.dedupJudge instanceof DedupJudge)
    return store.dedupJudge.off ? `\n⚠ DEDUP JUDGE OFF: switched off earlier in this run after ${store.dedupJudge.off}. The rule decides duplicates.` : "";
  if (plan.via === "off") {
    store.dedupOff = plan.why;
    logLine(`dedup judge off: ${plan.why}; the rule decides duplicates`);
    return plan.note;
  }
  const ask = plan.via === "client" ? samplingAsk((params, options) => server.server.createMessage(params, options)) : httpJudgeAsk(plan.resolved, plan.key);
  store.dedupJudge = new DedupJudge(ask, { label: plan.label, log: logLine, redact: withoutKeys });
  store.dedupOff = undefined;
  return plan.note;
}

function sessionLines(): string {
  const lines = ["Live sessions:"];
  for (const [name, eng] of engines) {
    lines.push(
      `  ${name === activeName ? "▶" : " "} ${name} — ${eng.role} · ${eng.mode}${eng.attached ? ` · ${eng.currentUrl || eng.baseUrl}` : " · (closed)"}`,
    );
  }
  return lines.join("\n");
}

/** How long one scout_login call waits for the person, by default and at most, in seconds. */
const LOGIN_WAIT_DEFAULT_S = 120;

const LOGIN_WAIT_MAX_S = 600;

/** How often a waiting call tells a client that asked for progress that it is still going, in ms. */
const LOGIN_PROGRESS_EVERY_MS = 10_000;

export function registerSessionTools(): void {
  server.registerTool(
    "scout_scan",
    {
      description:
        "Scan a project directory to discover the frontend workspace, framework, routes, dev command, Playwright auth storage states, and testid conventions. Run this first.",
      inputSchema: { projectPath: z.string().describe("Absolute path to the project root") },
    },
    serializedControl(async ({ projectPath }: { projectPath: string }) => {
      try {
        return text(formatScan(scanProject(projectPath)), activeName);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_attach",
    {
      description:
        "Launch a browser and attach to a running web app. First attach in this conversation and you have read neither the SceneScout skill nor scout_playbook? Call scout_playbook before this. Write policy is enforced at the NETWORK layer: mode='observe' blocks EVERY request that is not a GET (login and token refresh excepted, and POSTs the user named in readPosts) — choose it for a target that holds real data, where even an ordinary form submission would create a record; mode='read-only' (default) blocks destructive-labeled elements AND all PUT/PATCH/DELETE + destructive POSTs, but lets ordinary form POSTs through; mode='safe-write' allows creating data and permits updates/deletes ONLY on resources this session created (use when the user wants create/edit flows tested); mode='destructive' allows everything — ONLY when the user explicitly confirmed a disposable/seeded environment. Pass `role` to sign in with a login the user saved by `scenescout login <url> --role <name>`, or a Playwright storage-state JSON as storageStatePath. Pass `session` to keep MULTIPLE roles alive at once (one browser each, genuinely concurrent) for collaboration testing — target each directly with every tool's `session` param, or use scout_session to set which one is the default; coverage and findings merge into one project memory.",
      inputSchema: {
        url: z.string().describe("Base URL of the running app, e.g. http://localhost:3000"),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project (memory + report live in .scenescout/ here). Pass it whenever you have a project or working folder. " +
              `Omitted: the client's workspace folder, else a folder per tested site under the user's documents folder (Documents/SceneScout/<host>/, or ${PROJECTS_DIR_ENV}), which the result names — tell the user where it is.`,
          ),
        storageStatePath: z.string().optional().describe("Optional Playwright storage-state JSON path for authenticated exploration. Not with `role`."),
        role: z
          .string()
          .max(40)
          .optional()
          .describe(
            "Sign in as a role whose login was saved with `scenescout login <url> --role <name>` (kept in the project's .scenescout/auth/). " +
              "Every session given the same role gets its own browser built from that one login. Not with storageStatePath. " +
              "No saved login for the role: the attach is refused and names the command to run — ask the user to run it, since it opens a window for them to sign in.",
          ),
        mode: z
          .enum(["observe", "read-only", "safe-write", "destructive"])
          .default("read-only")
          .describe("Write policy (see tool description). Never choose 'destructive' yourself — user opt-in only."),
        headed: z.boolean().default(false).describe("Show the browser window"),
        browser: z
          .enum(["chromium", "firefox", "webkit"])
          .optional()
          .describe(
            "Browser to drive. Default: the SCENESCOUT_BROWSER environment variable, else chromium. A build that is not on disk is downloaded on this attach, once, except in CI or with SCENESCOUT_BROWSER_DOWNLOAD=off, where the attach names the command to run. Use firefox or webkit for a cross-browser pass; stay on chromium otherwise.",
          ),
        viewportWidth: z.number().int().min(320).max(3840).optional().describe("Viewport width (default 1280); use e.g. 390 for a mobile pass"),
        viewportHeight: z.number().int().min(480).max(2400).optional().describe("Viewport height (default 900)"),
        objective: z
          .string()
          .max(300)
          .optional()
          .describe(
            'This session\'s objective: the whole remit you were given, in one sentence ("Admin lane: §2 registers, §7 plan gating", ' +
              '"Approve and reject orders as a manager"). It sits above the task, which is what the session is doing at any moment. ' +
              "Shown to whoever is watching the run; worth setting whenever more than one session is live.",
          ),
        task: z
          .string()
          .max(300)
          .optional()
          .describe(
            "What this session is doing right now, shown under its objective from the moment it appears, e.g. Signing in and taking stock. Passed alone it is read as the 2.0 spelling of `objective`. Defaults to a placeholder so a fresh card never reads as idle.",
          ),
        paceMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe(
            "A floor between actions, in milliseconds, for when a person is watching and needs to keep up — following a flow, taking notes, demonstrating. Default 0: as fast as the page allows, which is what a run wants otherwise. Changeable mid-run with scout_session {paceMs}.",
          ),
        trustedEmbeds: z
          .array(z.string().max(200))
          .max(10)
          .optional()
          .describe(
            'Origins of embedded frames (e.g. "https://pay.example.com") whose writes out of the app may go out — ONLY when the user named them, typically a provider in test mode, and only in safe-write mode. ' +
              "Never add one yourself. Hostile input, repeated-click probes and uploads stay refused in them.",
          ),
        readPosts: z
          .array(z.string().max(300))
          .max(MAX_READ_POSTS)
          .optional()
          .describe(
            `POST endpoints that only read, e.g. ["POST /api/search", "POST https://api.example.com/reports/query"], which observe mode then lets out — ONLY when the user named them. Never add one yourself, even when the gap ledger lists a refused POST: ask the user. ` +
              `Exact paths; * stands for one path segment. Still refused when the path or body looks destructive or the body is a GraphQL mutation. Observe mode only. Default: the ${READ_POSTS_ENV} environment variable, else none.`,
          ),
        record: z
          .boolean()
          .optional()
          .describe(
            "Keep a frame of the page after every action, under .scenescout/recordings/, and show it beside that step in report.html. " +
              `Default: the ${RECORD_ENV} environment variable (on or off), else off: a recording is pictures of the app under test sitting in the project folder. Turn it on for QA work, where the run is evidence and not only a report.`,
          ),
        evidence: z
          .enum(EVIDENCE_MODES)
          .optional()
          .describe(
            "What happens to the picture each scout_finding takes of what it is about. 'inline': kept under .scenescout/recordings/, shown in report.html, and returned in the scout_finding result so the conversation shows it. 'file': kept and shown in the report only. 'off': none taken. " +
              `Default: the ${EVIDENCE_ENV} environment variable, else 'inline', or 'file' in a CI job. Pictures are bounded in size and in how many one session returns (see the configuration reference).`,
          ),
        actionTimeoutMs: z
          .number()
          .int()
          .min(LIMIT_BOUNDS.action.min)
          .max(LIMIT_BOUNDS.action.max)
          .optional()
          .describe(
            `How long one click, keystroke, hover or pick may take, in ms. Default: the ${ACTION_TIMEOUT_ENV} environment variable, else ${DEFAULT_ACTION_TIMEOUT_MS}. Raise it only when timeouts come from a loaded machine rather than the app.`,
          ),
        navTimeoutMs: z
          .number()
          .int()
          .min(LIMIT_BOUNDS.nav.min)
          .max(LIMIT_BOUNDS.nav.max)
          .optional()
          .describe(
            `How long a page may take to load, in ms. Default: the ${NAV_TIMEOUT_ENV} environment variable, else ${DEFAULT_NAV_TIMEOUT_MS} (crawled pages ${DEFAULT_CRAWL_NAV_TIMEOUT_MS}; a value set here applies to them too). Raise it only when timeouts come from a loaded machine rather than the app.`,
          ),
        session: z
          .string()
          .max(40)
          .optional()
          .describe(
            "Session name for multi-role runs (e.g. 'admin', 'qa'). Creates/replaces that session's browser and makes it the default. Default: 'default'.",
          ),
        dedup: z
          .enum(DEDUP_MODES)
          .optional()
          .describe(
            `How this run tells a filed finding from one already recorded. Default: the ${DEDUP_ENV} environment variable, else 'rule', the store's rule alone. ` +
              "'judge': the rule first, then, for a filing the rule keeps apart from everything recorded, a model is asked whether it is one of the open findings on its page, and merges it when it says so. " +
              "It needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the server's environment, and sends each pair's titles, categories and evidence, and the page's path, to that provider — ONLY when the user asked for it. " +
              "Applies to every session of the project until the run ends.",
          ),
        planId: z
          .string()
          .max(20)
          .optional()
          .describe(
            "The guided plan this attach carries out, as its scout_attach call lists it. Once any guided plan is built in this server, an attach above 'observe' without an accepted plan's id is refused, " +
              "and so is one above the plan's mode or on another site than the plan's, and any attach passing readPosts or trustedEmbeds. A plan's confirmation covers one check: once no session carries the plan, it must be confirmed again. Never leave it out to get round a plan's confirmation.",
          ),
        open: z
          .enum(OPEN_CHOICES)
          .optional()
          .describe(
            `Open the live view (on this attach) and/or report.html (when scout_report writes it) in the user's default browser: 'live', 'report', 'both' or 'none'. ` +
              `Default: the ${OPEN_ENV} environment variable, else 'both' on a local desktop session (headed or headless) and 'none' in CI, over SSH, or with no display. ` +
              "Pass it only when the user asked for something other than the default.",
          ),
      },
    },
    serializedControl(
      async ({
        url,
        projectPath,
        storageStatePath,
        role,
        mode,
        headed,
        browser,
        viewportWidth,
        viewportHeight,
        objective,
        task,
        record,
        evidence,
        trustedEmbeds,
        readPosts,
        paceMs,
        actionTimeoutMs,
        navTimeoutMs,
        session,
        dedup,
        open,
        planId,
      }: {
        url: string;
        projectPath?: string;
        storageStatePath?: string;
        role?: string;
        mode?: "observe" | "read-only" | "safe-write" | "destructive";
        headed?: boolean;
        browser?: "chromium" | "firefox" | "webkit";
        viewportWidth?: number;
        viewportHeight?: number;
        objective?: string;
        task?: string;
        record?: boolean;
        evidence?: EvidenceMode;
        trustedEmbeds?: string[];
        readPosts?: string[];
        paceMs?: number;
        actionTimeoutMs?: number;
        navTimeoutMs?: number;
        session?: string;
        dedup?: DedupMode;
        open?: OpenChoice;
        planId?: string;
      }) => {
        try {
          // Before anything else: while a guided plan is open, nothing above observe starts without the person's confirmation (ADR 24).
          const guided = guidedAttachVerdict(guidedPlans, { planId, mode: mode ?? "read-only", url, readPosts, trustedEmbeds });
          if (!guided.ok) return errorText(new Error(`scout_attach refused: ${guided.why}`));
          // Settled first: a refusal leaves the default session as it was.
          const folder = await projectFolderFor(url, projectPath);
          if ("refused" in folder) return errorText(new Error(folder.refused));
          projectPath = folder.dir;
          const target = session ?? activeName;
          if (session) {
            setActiveName(session);
            setActiveNameIsExplicit(false);
          }
          const eng = engineFor(target);
          // Key by the RESOLVED, symlink-free path. Keyed by the raw string,
          // "/p" and "/p/" — or a symlink, or a case-variant on a
          // case-insensitive filesystem — built two MemoryStore instances over
          // one file inside a single process. Each held its own snapshot and
          // flushed it wholesale, so the second one to write silently erased the
          // first one's findings, with no second process involved.
          // The directory must EXIST before realpath can resolve it, and on a
          // first attach it does not — MemoryStore's constructor is what creates
          // it. Resolving before that threw, fell back to the raw string, and the
          // next attach then resolved successfully to a different key: two stores
          // over one file, which is the exact bug this keying prevents. (On macOS
          // any path under /tmp hits this, since /tmp is a symlink to /private/tmp.)
          fs.mkdirSync(path.resolve(projectPath), { recursive: true });
          let storeKey: string;
          try {
            storeKey = fs.realpathSync(path.resolve(projectPath));
          } catch {
            storeKey = path.resolve(projectPath);
          }
          let store = memories.get(storeKey);
          if (!store) {
            store = new MemoryStore(projectPath);
            memories.set(storeKey, store);
          }
          // Cross-process conflict detection: another live SceneScout attached
          // to the same project shares .scenescout memory files with this one.
          let conflictNote = "";
          try {
            const statusPath = path.join(projectPath, ".scenescout", "status.json");
            if (fs.existsSync(statusPath)) {
              const st = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { pid?: number };
              if (st.pid && st.pid !== process.pid) {
                let alive = false;
                try {
                  process.kill(st.pid, 0);
                  alive = true;
                } catch {
                  /* stale */
                }
                if (alive)
                  conflictNote =
                    `\nNote: another SceneScout process (pid ${st.pid}) is also attached to this project. ` +
                    `Findings and coverage from both are merged on write, so neither loses work; ` +
                    `named sessions in ONE server (scout_attach {session: "…"}) are still preferred, since only they share safe-write ownership.`;
              }
            }
          } catch {
            /* conflict detection is best-effort */
          }
          // Moving this session to another project leaves its old one; if it was
          // the last session there, that run is over. Re-attaching to the SAME
          // project is the same run, and keeps what the run has learned.
          // Before anything changes: a SCENESCOUT_OPEN the server cannot use refuses the attach.
          const opening = decideOpen(open ?? openChoiceFromEnv(process.env), {
            env: process.env,
            platform: process.platform,
          });
          const previous = eng.memory;
          if (previous && previous !== store && ![...engines.values()].some((e) => e !== eng && e.memory === previous)) previous.endRun();
          // Before the browser starts: a value it cannot use refuses the attach rather than being replaced.
          const dedupNote = configureDedup(store, dedup);
          const recording = recordChoice(record, process.env);
          const pictures = evidenceSettings(evidence, process.env);
          const viewport = viewportWidth && viewportHeight ? { width: viewportWidth, height: viewportHeight } : undefined;
          // The first attach on a machine without the browser downloads it here, once, rather than failing with a command to run.
          const browserNote = await readyBrowserFor({ engine: browser ?? defaultEngine(process.env), headed: headed ?? false }, requestExtra.getStore());
          const out = await eng.attach({
            url,
            projectDir: projectPath,
            projectChosen: folder.source === "default",
            storageStatePath,
            role,
            mode,
            headed,
            browser,
            viewport,
            // `task` is what this was called in 2.0, where it named the session's
            // whole remit. Alone it still means that. Given BESIDE an objective it
            // means what it means everywhere else — what this session is doing
            // right now — so the card says something from the moment it appears.
            objective: objective ?? task,
            paceMs,
            task: objective ? task : undefined,
            record: recording,
            trustedEmbeds,
            readPosts,
            actionTimeoutMs,
            navTimeoutMs,
            memoryStore: store,
          });
          // Put the session on the board now, so the live view shows it before its
          // first tool call. liveLine() needs the port, so the server is awaited
          // here rather than started in the background by writeStatus.
          if (eng.memory?.dir) {
            await ensureLive(eng.memory.dir);
            writeStatus(target, "idle", "scout_attach");
          }
          // Which plan this session carries out, for scout_session {area}; a new attach starts with no area.
          // A plan no session carries any more is spent, so the next check with it asks the person again.
          holdGuidedPlan(guidedSessions, guidedPlans, target, guided.plan?.planId);
          // A new attach is a new count of pictures returned.
          evidenceFor.set(eng, { ...pictures, shown: 0 });
          openDecisions.set(target, opening);
          // The address holds the token, and goes only to this machine's opener: the live view's loopback and token rules are unchanged.
          let openNote = "";
          if (opening.live && liveAddress && !liveOpened) {
            setLiveOpened(true);
            openNote = openForUser("the live view", liveViewUrl(liveAddress.port, liveAddress.token));
          } else if (!opening.live && liveAddress && !openWhySaid) {
            // Once per server, so a person wondering why no window appeared is told how to change it.
            setOpenWhySaid(true);
            openNote = `\nNot opened in a browser (${opening.why}); scout_attach {open} or ${OPEN_ENV} changes that.`;
          }
          // Recording writes pictures of the app under test into the project, so
          // a run doing it says where they go rather than leaving the person to
          // find a folder of screenshots later.
          const recordNote =
            recording && eng.memory?.dir
              ? `\n\n📸 RECORDING: a frame of the page after each action, under ${path.join(eng.memory.dir, "recordings", target)}/ (at most ${RECORD_MAX_FRAMES}). scout_report writes them into report.html beside report.md.`
              : "";
          const picturesNote =
            pictures.mode !== "off" && eng.memory?.dir
              ? `\n📷 FINDING PICTURES: ${pictures.mode} (${pictures.source}): each scout_finding keeps a picture of what it names under ${path.join(eng.memory.dir, "recordings")}/ for report.html${pictures.mode === "inline" ? `, and returns the first ${pictures.inlineMax} in its result` : ""}.`
              : "";
          return text(
            browserNote +
              out +
              (folder.note ? `\n\n${folder.note}` : "") +
              conflictNote +
              recordNote +
              picturesNote +
              dedupNote +
              describePace(eng.pace) +
              (engines.size > 1 ? `\n${sessionLines()}` : "") +
              liveLine() +
              openNote,
            target,
          );
        } catch (err) {
          return errorText(err);
        }
      },
    ),
  );

  server.registerTool(
    "scout_login",
    {
      description:
        "Open a visible browser window for the USER to sign in to the app as a role, and save that sign-in for scout_attach { role }. " +
        "Use it when an attach is refused because no sign-in is saved for the role, or the saved one has expired. " +
        'Tell the user first, in plain words: "A browser window is opening. Sign in there as you normally would; it closes by itself once you are in." ' +
        "The window saves once the user is back on the app with a new session (a round trip through a single sign-on provider is followed, not taken for the end) and closes. " +
        "Never type credentials into it yourself. Returns once signed in and saved, or after waitSeconds with the window still open: then call scout_login again with the same role to keep waiting. " +
        "Closing the window saves nothing. Needs a desktop: on a machine with no display, ask the user to run `scenescout login <url> --role <name>` where they can see the window.",
      inputSchema: {
        url: z.string().describe("Where to sign in: the app's address or its sign-in page, e.g. http://localhost:3000/login"),
        role: z.string().max(40).describe("The name to save the sign-in under, e.g. admin; scout_attach { role } signs in with it"),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project (the sign-in is saved in .scenescout/auth/ here), as for scout_attach. Omitted: the same folder an attach with no projectPath uses for this site, which the result names.",
          ),
        browser: z
          .enum(["chromium", "firefox", "webkit"])
          .optional()
          .describe("Browser to open. Default: the SCENESCOUT_BROWSER environment variable, else chromium"),
        successUrl: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Only when the user says how to tell: signed in once the URL's path contains this, or the URL starts with it (an absolute URL), instead of when a new session appears",
          ),
        waitSeconds: z
          .number()
          .int()
          .min(1)
          .max(LOGIN_WAIT_MAX_S)
          .optional()
          .describe(`How long this call waits for the user before returning with the window still open (default ${LOGIN_WAIT_DEFAULT_S})`),
      },
    },
    async (args: { url: string; role: string; projectPath?: string; browser?: BrowserEngineName; successUrl?: string; waitSeconds?: number }, extra) => {
      try {
        // The folder an attach with no projectPath would use, so the attach after this finds the sign-in.
        const folder = await projectFolderFor(args.url, args.projectPath);
        if ("refused" in folder) return errorText(new Error(folder.refused));
        const projectDir = path.resolve(folder.dir);
        const where = folder.note ? `\n\n${folder.note}` : "";
        const parsed = parseLoginArgs(
          [args.url, "--role", args.role, ...(args.browser ? ["--browser", args.browser] : []), ...(args.successUrl ? ["--success-url", args.successUrl] : [])],
          projectDir,
        );
        if (!parsed.ok) return errorText(new Error(parsed.error));
        const options = { ...parsed.options, projectDir };
        const key = `${options.projectDir}\0${options.role}`;
        const { window: pending, resumed } = await pendingLogins.get(key, () => startLoginWindow(options));
        const waitMs = (args.waitSeconds ?? LOGIN_WAIT_DEFAULT_S) * 1000;
        const progressToken = extra._meta?.progressToken;
        let ticks = 0;
        const ticker =
          progressToken !== undefined
            ? setInterval(() => {
                ticks += 1;
                const p = pending.progress();
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: ticks,
                      message: `Waiting for the sign-in as "${options.role}": ${p.reason === "starting" ? "the window is opening" : WAIT_SAYS[p.reason]}`,
                    },
                  })
                  .catch((err: unknown) => console.error(`[scenescout] scout_login progress: ${err instanceof Error ? err.message : String(err)}`));
              }, LOGIN_PROGRESS_EVERY_MS)
            : undefined;
        let timer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        const outcome = await Promise.race([
          pending.done,
          new Promise<"waiting">((resolve) => {
            timer = setTimeout(() => resolve("waiting"), waitMs);
          }),
          new Promise<"cancelled">((resolve) => {
            onAbort = () => resolve("cancelled");
            extra.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]).finally(() => {
          clearTimeout(timer);
          if (ticker) clearInterval(ticker);
          if (onAbort) extra.signal.removeEventListener("abort", onAbort);
        });
        const differs =
          resumed && pending.url !== options.url
            ? ` (the window was opened at ${pending.url} by an earlier call; that one is still the one being watched)`
            : "";
        if (outcome === "waiting" || outcome === "cancelled") {
          const p = pending.progress();
          return text(
            `Still waiting for the user to sign in as "${options.role}"${differs}: ${p.reason === "starting" ? "the window is opening" : WAIT_SAYS[p.reason]}. ` +
              `The window stays open for up to ${LOGIN_WINDOW_MAX_MS / 60_000} minutes from when it opened. Call scout_login again with the same role to keep waiting, once the user says they are done or to check.` +
              where,
            activeName,
          );
        }
        // This call reports the outcome; the next call for the role opens a new window.
        pendingLogins.reported(key, pending);
        if (!outcome.ok) return errorText(new Error(`nothing was saved for role "${options.role}": ${outcome.error}`));
        return text(`${outcome.detected}\n${savedLine(options, outcome.saved)}${where}`, activeName);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "scout_session",
    {
      description:
        "List live sessions, or set which one is the DEFAULT (used by any tool call that omits `session`). Prefer passing `session` directly on each tool call for multi-role work — that's what lets concurrent dispatch happen; scout_session is for sequential convenience (skip repeating `session` on every call) and for checking what's live. Both browsers stay live and authenticated regardless of which is default — re-snapshot a session after a break to see what changed while it was away.",
      inputSchema: {
        name: z.string().max(40).optional().describe("Session to make the default; omit to list sessions"),
        // Every other session-aware tool spells this `session`. Accepting both
        // costs nothing and removes a guaranteed first-try rejection, since all
        // schemas are additionalProperties:false and reject the near-miss hard.
        session: z.string().max(40).optional().describe("Alias for `name`."),
        paceMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe(
            "Change how fast this session acts, mid-run: a floor between actions in milliseconds, for when a person is watching and needs to keep up. 0 restores full speed. With `name`, applies to that session; without, to every live session — which is what 'slow everything down so I can follow' means.",
          ),
        area: z
          .enum(CHECK_AREAS)
          .optional()
          .describe(
            "In a guided check: the area this session is working on now, one of its plan's areas, shown to the person following the check. With `name`, that session (the default session is left as it is); without, the default one. Set it as each area starts.",
          ),
      },
    },
    serializedControl(async ({ name, session, paceMs, area }: { name?: string; session?: string; paceMs?: number; area?: CheckArea }) => {
      try {
        name = name ?? session;
        let areaNote = "";
        if (area !== undefined) {
          const target = name ?? activeName;
          if (!engines.has(target))
            return text(`No session named "${target}" yet — create it with scout_attach { session: "${target}", … }.\n${sessionLines()}`, activeName);
          const held = guidedSessions.get(target) ?? {};
          const refused = areaRefusal(held.planId ? guidedPlans.get(held.planId) : undefined, area);
          if (refused) return errorText(new Error(`scout_session refused: ${refused}`));
          guidedSessions.set(target, { ...held, area });
          areaNote = `${target} is now working on: ${AREA_LABEL[area]}.\n`;
          // With an area, `name` says which session it is for; the default session stays as it was.
          if (paceMs === undefined) return text(areaNote.trimEnd(), activeName);
        }
        // A pace with no session named is meant for the whole run: somebody is
        // watching and wants to keep up with all of it, not one lane.
        if (paceMs !== undefined && !name) {
          const applied = [...engines.values()].map((e) => e.setPace(paceMs));
          const at = applied[0] ?? normalizePace(paceMs);
          return text(
            areaNote +
              (at > 0
                ? `Every live session now waits at least ${at} ms between actions, so a person can follow along.`
                : `Every live session is back to full speed: as fast as its page allows.`) +
              `\n${sessionLines()}`,
            activeName,
          );
        }
        if (paceMs !== undefined && name) {
          if (!engines.has(name))
            return text(`No session named "${name}" yet — create it with scout_attach { session: "${name}", … }.\n${sessionLines()}`, activeName);
          const at = engines.get(name)!.setPace(paceMs);
          return text(
            areaNote + (at > 0 ? `${name} now waits at least ${at} ms between actions.` : `${name} is back to full speed.`) + `\n${sessionLines()}`,
            activeName,
          );
        }
        if (!name) return text(sessionLines() + liveLine(), activeName);
        if (!engines.has(name)) {
          return text(`No session named "${name}" yet — create it with scout_attach { session: "${name}", … }.\n${sessionLines()}`, activeName);
        }
        setActiveName(name);
        setActiveNameIsExplicit(true);
        const eng = engines.get(name)!;
        return text(
          `Default session → ${name} (${eng.role}, ${eng.mode}) · ${eng.attached ? `currently at ${eng.currentUrl}` : "browser not attached"}.\nTake scout_snapshot to see where this role left off (the page may have changed while another role was working).`,
          name,
        );
      } catch (err) {
        return errorText(err);
      }
    }),
  );
}

/** scout_close: registered last, where it has always been listed. */
export function registerCloseTool(): void {
  server.registerTool(
    "scout_close",
    {
      description:
        "Close a session's browser (memory persists on disk). Default: the DEFAULT session. Pass session to close a specific one, or all=true to close every live session at the end of a multi-role run. " +
        "A session that is a lane of a parallel run (named by scout_lane_brief or scout_lane_report) is not closed until its lane report has been accepted by scout_lane_report, since folding needs the session attached; the refusal names every such lane.",
      inputSchema: {
        session: z.string().max(40).optional().describe("Session to close (default: the default session)"),
        all: z.boolean().default(false).describe("Close every live session"),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Close even a lane whose report has not been folded yet. Its decisions are then lost: nothing is kept for calibration and nothing checks its defects were filed. Prefer folding it with scout_lane_report first.",
          ),
      },
    },
    serializedControl(async ({ session, all, force }: { session?: string; all?: boolean; force?: boolean }) => {
      try {
        if (all) {
          const names = [...engines.keys()];
          const guard = laneCloseGuard(names, laneLedger, force);
          if (!guard.ok) return text(`${guard.message}\nNo session was closed.`, activeName);
          // Closes are independent per-browser — run them in parallel so N wedged
          // sessions cost one 8s teardown cap total, not N of them.
          const dirs = new Set<string>();
          for (const e of engines.values()) if (e.memory?.dir) dirs.add(e.memory.dir);
          for (const e of engines.values()) keepReport(e);
          for (const name of engines.keys()) live?.dropSession(name);
          const stores = new Set([...engines.values()].map((e) => e.memory).filter((m) => m !== null && m !== undefined));
          const closing = [...engines.values()];
          await Promise.allSettled(closing.map((e) => e.close()));
          // Out of the live list before the wait, so a call queued behind abandoned work finds no session instead of
          // reaching a closed one. Then wait for work a watchdog let run on to unwind, and write what it left pending,
          // so nothing it writes lands after this answer.
          engines.clear();
          const stillRunning = await callWork.settleAll(CLOSE_WORK_WAIT_MS);
          for (const e of closing) flushAfterClose(e);
          for (const store of stores) store.endRun();
          sessionQueue.clear();
          for (const name of [...guidedSessions.keys()]) holdGuidedPlan(guidedSessions, guidedPlans, name, null);
          board.clear();
          laneLedger.clear();
          setLastWriter(null);
          await Promise.all([...dirs].map((dir) => settleProjectWrites(dir)));
          return text(
            `All sessions closed (${names.join(", ") || "none were live"}). Memory and reports remain in .scenescout/.` + stillRunningNote(stillRunning),
            activeName,
          );
        }
        const name = session ?? activeName;
        const eng = engines.get(name);
        if (!eng) return text(`No live session "${name}".`, name);
        const guard = laneCloseGuard([name], laneLedger, force);
        if (!guard.ok) return text(guard.message, name);
        keepReport(eng);
        live?.dropSession(name);
        await eng.close();
        // As above: out of the live list, then wait for work a watchdog let run on and write what it left pending.
        engines.delete(name);
        const stillRunning = await callWork.settle(name, CLOSE_WORK_WAIT_MS);
        flushAfterClose(eng);
        const saveError = eng.memory?.lastSaveError;
        openDecisions.delete(name);
        // The last session on this project ends its run.
        if (eng.memory && ![...engines.values()].some((e) => e.memory === eng.memory)) eng.memory.endRun();
        sessionQueue.forget(name);
        holdGuidedPlan(guidedSessions, guidedPlans, name, null);
        board.remove(name);
        laneLedger.forget(name);
        // The last session closing ends the run, and its lanes with it: a brief's
        // names that never attached must not make a later run's session a lane.
        if (engines.size === 0) laneLedger.clear();
        if (lastWriter?.session === name) setLastWriter(null);
        if (eng.memory?.dir) await settleProjectWrites(eng.memory.dir);
        if (activeName === name) setActiveName(engines.keys().next().value ?? "default");
        return text(
          `Session "${name}" closed. Memory and report remain in .scenescout/.` +
            (engines.size > 0 ? ` Default session → ${activeName}.` : "") +
            stillRunningNote(stillRunning) +
            (saveError
              ? `\n⚠ The final memory write failed (${saveError}) — some coverage/findings from this session may not have been persisted to disk.`
              : ""),
          activeName,
        );
      } catch (err) {
        return errorText(err);
      }
    }),
  );
}
