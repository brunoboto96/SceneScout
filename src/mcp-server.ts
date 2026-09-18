#!/usr/bin/env node
/**
 * SceneScout MCP server (stdio).
 *
 * Exposes deterministic browser-exploration tools — Playwright actions, state
 * memory, oracles, findings, report — to any MCP client. No LLM calls happen
 * here: the client (e.g. Claude Code on a subscription) is the brain.
 *
 * The server process is a per-conversation daemon and behaves like one:
 * - Multi-session, genuinely concurrent: named sessions each own a live
 *   browser (scout_attach {session}); every per-session tool takes an optional
 *   `session` override so a controller can dispatch commands to MULTIPLE
 *   sessions in parallel — the two calls actually run concurrently, not
 *   one at a time — while calls targeting the SAME session still serialize
 *   (a single browser's ref table/fingerprint is shared mutable state and
 *   cannot process overlapping actions). scout_session sets a convenience
 *   default so single-session workflows never need to pass `session`.
 * - Watchdog: every tool call has a hard time budget — a wedged browser
 *   returns a diagnosable error instead of hanging the conversation, and
 *   that session's queue keeps moving (other sessions are unaffected).
 * - Self-healing: orphaned browser processes from crashed runs are reaped at
 *   startup and on launch failure; attach retries once after reaping.
 * - Observable: .scenescout/status.json in the tested project always shows
 *   what each session is doing right now (`scenescout status <project>`).
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserEngine } from "./engine/browser.js";
import { reapOrphanBrowsers } from "./engine/reaper.js";
import { MemoryStore, redactSecrets } from "./engine/memory.js";
import { SessionQueue, withWatchdog } from "./engine/dispatch.js";
import { FIXTURE_KINDS, type FixtureKind } from "./engine/fixtures.js";
import { computeGaps, formatRouteCoverage, generateReport } from "./engine/report.js";
import { formatScan, scanProject } from "./scan.js";

/** Live sessions: each name owns an independent BrowserEngine (browser + auth). */
const engines = new Map<string, BrowserEngine>();
/**
 * One MemoryStore per project, shared by every session attached to it:
 * findings and coverage from all roles merge, and concurrent engines never
 * race each other's memory.json writes (MemoryStore's own writes are
 * synchronous, so Node's single-threaded execution already serializes them).
 */
const memories = new Map<string, MemoryStore>();
/** Convenience default: which session a tool call targets when it omits `session`. */
let activeName = "default";
/**
 * Whether the operator CHOSE the current default (via scout_session) rather than
 * it drifting there because that session attached last. Only the drifting case
 * is worth warning about; nagging after a deliberate choice trains the reader
 * to ignore the warning, and scout_session's own description recommends exactly
 * that workflow for sequential single-role stretches.
 */
let activeNameIsExplicit = false;

function engineFor(session: string): BrowserEngine {
  let e = engines.get(session);
  if (!e) {
    e = new BrowserEngine();
    e.sessionKey = session;
    engines.set(session, e);
  }
  return e;
}

const PKG_VERSION = ((): string => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();
const server = new McpServer({ name: "scenescout", version: PKG_VERSION });

/** Wide enough for text AND image results, so no handler needs a cast. */
type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

function text(t: string, session: string): ToolResult {
  const eng = engines.get(session);
  const prefix = engines.size > 1 ? `[session ${session}${eng ? ` · ${eng.role}` : ""}]\n` : "";
  return { content: [{ type: "text", text: prefix + t }] };
}

function errorText(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/**
 * Live status for the tested project (`scenescout status <project>` or any
 * supervising layer reads this): which session/tool is running right now.
 * Best-effort — observability must never break the tool call itself.
 */
function writeStatus(session: string, phase: "running" | "idle", tool: string): void {
  const dir = engines.get(session)?.memory?.dir;
  if (!dir) return;
  // Fire-and-forget async write: status is best-effort observability and runs
  // on every tool call's hot path — it must never add blocking filesystem
  // latency. Two sessions writing concurrently is a benign last-write-wins on
  // this one project-level file; each session's OWN status still reaches disk.
  void fs.promises
    .writeFile(
      path.join(dir, "status.json"),
      JSON.stringify(
        {
          pid: process.pid,
          phase,
          tool,
          session,
          role: engines.get(session)?.role ?? "anonymous",
          sessions: [...engines.keys()],
          // status.json is a poll target that gets pasted into bug reports.
          url: redactSecrets(engines.get(session)?.currentUrl ?? ""),
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    .catch(() => {});
}

/** The watchdog's timeout answer — a diagnosable result, not a hang. */
function watchdogTimeout(label: string, ms: number): ToolResult {
  return errorText(
    new Error(
      `${label} timed out after ${Math.round(ms / 1000)}s — the browser may be wedged (stuck navigation, dialog, or hung renderer). ` +
        `The operation may still complete in the background; if subsequent calls misbehave, scout_attach again to reset the session (orphaned browser processes are reaped automatically).`,
    ),
  );
}

/**
 * Per-SESSION serialization: a single browser's ref table/fingerprint is
 * shared mutable state, so two calls against the SAME session must never
 * interleave. Two calls against DIFFERENT sessions have no shared state
 * (each BrowserEngine is independent) and run genuinely concurrently — this is
 * what makes `scout_click({session:"admin"})` and `scout_click({session:"qa"})`
 * issued in one turn actually execute in parallel instead of queueing behind
 * each other. The queue itself lives in engine/dispatch.ts, where it is tested.
 */
const sessionQueue = new SessionQueue();

function serializedPerSession<A>(
  label: string,
  fn: (args: A, session: string) => Promise<ToolResult>,
  timeoutMs = 60_000,
): (args: A & { session?: string }) => Promise<ToolResult> {
  return (args: A & { session?: string }) => {
    const session = args.session ?? activeName;
    const exec = async (): Promise<ToolResult> => {
      writeStatus(session, "running", label);
      try {
        const out = await withWatchdog(label, fn(args, session), timeoutMs, watchdogTimeout);
        // `activeName` is process-global and every scout_attach moves it. With
        // several sessions live — the multi-role runs this tool encourages —
        // an omitted `session` silently binds to whichever browser attached
        // most recently, which may belong to another agent entirely. Say so
        // rather than letting the call look deliberate.
        if (!args.session && engines.size > 1 && !activeNameIsExplicit) {
          out.content.push({
            type: "text" as const,
            text:
              `\n⚠ AMBIGUOUS SESSION — ${engines.size} sessions are live and this call named none, so it ran against '${session}' ` +
              `(whichever attached most recently). Pass session:"…" explicitly; the default is not stable while other sessions are attaching.`,
          });
        }
        return out;
      } finally {
        writeStatus(session, "idle", label);
      }
    };
    return sessionQueue.run(session, exec);
  };
}

/** Control-plane tools (scout_scan/scout_session/scout_close-all) don't target one browser — their own tiny chain keeps them off session queues without racing each other. */
let controlChain: Promise<unknown> = Promise.resolve();
function serializedControl<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>): (...args: A) => Promise<ToolResult> {
  return (...args: A) => {
    const run = controlChain.then(
      () => fn(...args),
      () => fn(...args),
    );
    controlChain = run.catch(() => {});
    return run;
  };
}

const sessionParam = z
  .string()
  .max(40)
  .optional()
  .describe(
    "Target this session directly instead of the active one — pass it explicitly when dispatching to MULTIPLE sessions in one turn (e.g. two scout_click calls with different `session`), which then run CONCURRENTLY rather than queueing. Omit for single-session sequential use.",
  );

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
      "Launch a browser and attach to a running web app. Write policy is enforced at the NETWORK layer: mode='observe' blocks EVERY request that is not a GET (login and token refresh excepted) — choose it for a target that holds real data, where even an ordinary form submission would create a record; mode='read-only' (default) blocks destructive-labeled elements AND all PUT/PATCH/DELETE + destructive POSTs, but lets ordinary form POSTs through; mode='safe-write' allows creating data and permits updates/deletes ONLY on resources this session created (use when the user wants create/edit flows tested); mode='destructive' allows everything — ONLY when the user explicitly confirmed a disposable/seeded environment. Pass a Playwright storage-state JSON to explore as an authenticated role. Pass `session` to keep MULTIPLE roles alive at once (one browser each, genuinely concurrent) for collaboration testing — target each directly with every tool's `session` param, or use scout_session to set which one is the default; coverage and findings merge into one project memory.",
    inputSchema: {
      url: z.string().describe("Base URL of the running app, e.g. http://localhost:3000"),
      projectPath: z.string().describe("Absolute path to the project (memory + report live in .scenescout/ here)"),
      storageStatePath: z.string().optional().describe("Optional Playwright storage-state JSON path for authenticated exploration"),
      mode: z
        .enum(["observe", "read-only", "safe-write", "destructive"])
        .default("read-only")
        .describe("Write policy (see tool description). Never choose 'destructive' yourself — user opt-in only."),
      headed: z.boolean().default(false).describe("Show the browser window"),
      viewportWidth: z.number().int().min(320).max(3840).optional().describe("Viewport width (default 1280); use e.g. 390 for a mobile pass"),
      viewportHeight: z.number().int().min(480).max(2400).optional().describe("Viewport height (default 900)"),
      session: z
        .string()
        .max(40)
        .optional()
        .describe(
          "Session name for multi-role runs (e.g. 'admin', 'qa'). Creates/replaces that session's browser and makes it the default. Default: 'default'.",
        ),
    },
  },
  serializedControl(
    async ({
      url,
      projectPath,
      storageStatePath,
      mode,
      headed,
      viewportWidth,
      viewportHeight,
      session,
    }: {
      url: string;
      projectPath: string;
      storageStatePath?: string;
      mode?: "observe" | "read-only" | "safe-write" | "destructive";
      headed?: boolean;
      viewportWidth?: number;
      viewportHeight?: number;
      session?: string;
    }) => {
      try {
        const target = session ?? activeName;
        if (session) {
          activeName = session;
          activeNameIsExplicit = false;
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
        const viewport = viewportWidth && viewportHeight ? { width: viewportWidth, height: viewportHeight } : undefined;
        const out = await eng.attach({ url, projectDir: projectPath, storageStatePath, mode, headed, viewport, memoryStore: store });
        eng.role = storageStatePath ? path.basename(storageStatePath).replace(/\.json$/i, "") : "anonymous";
        return text(out + conflictNote + (engines.size > 1 ? `\n${sessionLines()}` : ""), target);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

function sessionLines(): string {
  const lines = ["Live sessions:"];
  for (const [name, eng] of engines) {
    lines.push(
      `  ${name === activeName ? "▶" : " "} ${name} — ${eng.role} · ${eng.mode}${eng.attached ? ` · ${eng.currentUrl || eng.baseUrl}` : " · (closed)"}`,
    );
  }
  return lines.join("\n");
}

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
    },
  },
  serializedControl(async ({ name, session }: { name?: string; session?: string }) => {
    try {
      name = name ?? session;
      if (!name) return text(sessionLines(), activeName);
      if (!engines.has(name)) {
        return text(`No session named "${name}" yet — create it with scout_attach { session: "${name}", … }.\n${sessionLines()}`, activeName);
      }
      activeName = name;
      activeNameIsExplicit = true;
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

server.registerTool(
  "scout_snapshot",
  {
    description:
      "Capture the current page state: URL, state fingerprint, interactable elements with refs (e1, e2, …), geometry issues, coverage, and oracle violations since the last action. Re-snapshotting the same route returns a DIFF (refs stay stable). Cheap — prefer this over screenshots.",
    inputSchema: {
      full: z.boolean().default(false).describe("Force a full element list instead of a diff"),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_snapshot", async ({ full }: { full?: boolean }, session) => {
    try {
      return text(await engineFor(session).snapshot(full), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_crawl",
  {
    description:
      "Engine-side route sweep in ONE call: visits each path (default: all known routes not yet visited), records states into coverage memory, and returns a per-route health summary (HTTP status, element count, oracle violations, dead-ends, auth-redirects). Navigation-only — safe in read-only mode. Use this FIRST for broad coverage; explore interactively only where it flags problems or where journeys matter.",
    inputSchema: {
      paths: z.array(z.string()).max(150).optional().describe("Paths to visit, e.g. ['/orders','/settings']. Omit to crawl all unvisited known routes."),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_crawl",
    async ({ paths }: { paths?: string[] }, session) => {
      try {
        return text(await engineFor(session).crawl(paths), session);
      } catch (err) {
        return errorText(err);
      }
    },
    600_000,
  ),
);

server.registerTool(
  "scout_run_plan",
  {
    description:
      "Execute up to 20 actions in ONE call — use for mechanical sequences (fill a form, walk a wizard) so each step doesn't cost a round-trip. Targets resolve at execution time by semantic locator: 'testid=…', 'text=…', or 'label=…' (never snapshot refs). An `upload` step attaches a file as scout_upload does (target required — the file input or the control that opens its chooser; value = a fixture kind or a project-relative path). The plan ABORTS at the first NEW oracle violation, policy refusal, or failed step, returning a transcript of how far it got; repeats of already-reported violations do not abort (they stay logged for the report).",
    inputSchema: {
      steps: z
        .array(
          z.object({
            action: z.enum(["navigate", "click", "type", "select", "press", "hover", "scroll", "upload"]),
            target: z
              .string()
              .optional()
              .describe(
                "testid=…, text=…, label=… (or a path for navigate; 'top'/'bottom'/±px for scroll; for upload: the file input or the control that opens its chooser)",
              ),
            value: z
              .string()
              .optional()
              .describe(
                "Text to type / option to select / key to press / for upload: a fixture kind (pdf, png, txt, csv, json — blank infers from accept) or a project-relative file path",
              ),
            pressEnter: z.boolean().optional().describe("For type: press Enter after filling"),
            replace: z.boolean().optional().describe("For type: clear the field first instead of appending to existing content"),
          }),
        )
        .min(1)
        .max(20),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_run_plan",
    async ({ steps }: { steps: Parameters<BrowserEngine["runPlan"]>[0] }, session) => {
      try {
        return text(await engineFor(session).runPlan(steps), session);
      } catch (err) {
        return errorText(err);
      }
    },
    240_000,
  ),
);

server.registerTool(
  "scout_click",
  {
    description:
      "Click an element by its ref from the latest scout_snapshot. Returns the outcome plus any oracle violations triggered. clicks=2 (or 3) probes IMPATIENT-USER behaviour: a rapid multi-click that fires the same state-changing request twice means the control is not guarded against double submission (button stays enabled, endpoint not idempotent) — use it on every important submit/create button once; the result says explicitly whether duplicates fired.",
    inputSchema: {
      ref: z.string().describe("Element ref, e.g. e12"),
      clicks: z.number().int().min(1).max(3).default(1).describe("1 = normal; 2-3 = rapid repeated clicks (double-submit probe)"),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_click", async ({ ref, clicks }: { ref: string; clicks?: number }, session) => {
    try {
      return text(await engineFor(session).click(ref, clicks ?? 1), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_type",
  {
    description:
      "Type into a text input/textarea/composer by ref, the way a real user does: if the field already holds content (e.g. an @-mention chip a menu click inserted), the text is APPENDED at the end — preserving that content — and the result reports what was already there (a separating space is added only at a word-to-word boundary). Pass replace=true to clear the field first (correcting a previous entry); an empty textValue always clears. Appending fires input events but not keydown, so keydown-driven triggers (slash/mention menus) will not react to appended text. Use for both valid values and boundary/fuzz values (empty, very long, unicode, script tags).",
    inputSchema: {
      ref: z.string().describe("Element ref, e.g. e12"),
      textValue: z.string().optional().describe("Text to type"),
      // A `type` step inside scout_run_plan spells this `value`, as does scout_select.
      // One vocabulary for "the text going in", whichever tool takes it.
      value: z.string().optional().describe("Alias for `textValue`."),
      pressEnter: z.boolean().default(false).describe("Press Enter after typing"),
      replace: z.boolean().default(false).describe("Clear the field before typing instead of appending to existing content"),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_type",
    async (
      { ref, textValue, value, pressEnter, replace }: { ref: string; textValue?: string; value?: string; pressEnter?: boolean; replace?: boolean },
      session,
    ) => {
      try {
        // An explicitly empty string is meaningful here (it clears the field),
        // so fall back on `undefined` rather than on falsiness — and reject a
        // call that named neither. Defaulting to "" turned a malformed call
        // into a silent field-wipe reported as success.
        if (textValue === undefined && value === undefined) {
          return text(`Pass the text to type: scout_type { ref, textValue: "…" }. Pass "" explicitly to clear the field.`, session);
        }
        const toType = textValue ?? value ?? "";
        return text(await engineFor(session).type(ref, toType, pressEnter, replace), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_upload",
  {
    description:
      "Attach a file to an upload control the way a user does. `ref` is either a visible <input type=file> (snapshots list these with role `file`) or the button/label/dropzone that opens the file chooser — the chooser is intercepted and answered, which is how the hidden input behind a styled 'Choose file' control is reached. Omit `ref` to target the page's only file input, hidden or not (snapshots disclose hidden ones on a FILE INPUTS line). Nothing needs to exist on disk: a small VALID fixture (real PDF/PNG structure) is generated in memory, its kind inferred from the input's accept attribute or chosen with `fixture`; `filePath` uploads a real file but must live inside the attached project (fenced like navigation is fenced to the origin); `name` overrides the filename for boundary tests (wrong extension vs accept, very long, unicode). The result names the input, how the file reached it, flags a file that violates accept (a mismatch the app then accepts is a validation finding), warns if the app cleared the input after selection, and says whether a state-changing request fired on selection — if none did, click the form's submit, or check the next snapshot for a client-side rejection.",
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe("Element ref of the file input OR of the control that opens the file chooser; omit when the page has exactly one file input"),
      filePath: z
        .string()
        .optional()
        .describe("A real file to upload — absolute or relative to the project; must be inside the attached project. Exclusive with fixture."),
      fixture: z
        .enum(FIXTURE_KINDS)
        .optional()
        .describe("Generated fixture kind; default: inferred from the input's accept attribute (pdf when there is none, or none we can generate)"),
      name: z.string().min(1).max(512).optional().describe("Filename override (default scenescout-fixture.<kind>, or the disk file's own name)"),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_upload",
    async ({ ref, filePath, fixture, name }: { ref?: string; filePath?: string; fixture?: FixtureKind; name?: string }, session) => {
      try {
        return text(await engineFor(session).upload({ ref, filePath, fixture, name }), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_hover",
  {
    description:
      "Hover an element by ref like a user pausing the pointer on it, and report what it reveals: tooltips/popovers (diffed against pre-hover state), any other new page text that appeared (labelled as possibly unrelated on busy pages), the title attribute, and aria-describedby text — each item truncated to 300 chars. Hovering does not count as exercising the element. Use on badges, icons, truncated text, and error indicators BEFORE concluding an element 'does nothing' — hover-gated UI is invisible to snapshots and clicks.",
    inputSchema: { ref: z.string().describe("Element ref, e.g. e12"), session: sessionParam },
  },
  serializedPerSession("scout_hover", async ({ ref }: { ref: string }, session) => {
    try {
      return text(await engineFor(session).hover(ref), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_select",
  {
    description: "Select an option in a <select> by ref.",
    inputSchema: { ref: z.string(), value: z.string().describe("Option value or label"), session: sessionParam },
  },
  serializedPerSession("scout_select", async ({ ref, value }: { ref: string; value: string }, session) => {
    try {
      return text(await engineFor(session).select(ref, value), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_navigate",
  {
    description: "Navigate to a URL or a path relative to the attached base URL (e.g. '/orders'). Also supports 'back' via scout_back.",
    inputSchema: { target: z.string().describe("Absolute URL or path like /settings"), session: sessionParam },
  },
  serializedPerSession("scout_navigate", async ({ target }: { target: string }, session) => {
    try {
      return text(await engineFor(session).navigate(target), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_back",
  {
    description: "Go back in browser history (tests back-button resilience).",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_back", async (_args: { session?: string }, session) => {
    try {
      return text(await engineFor(session).goBack(), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_scroll",
  {
    description:
      "Scroll like a user — real apps hide their bugs below the fold. Reports the resulting position (px and %), and explicitly flags SCROLL LOCKED: scrollable content exists but the page will not move (the classic leaked modal scroll-lock that silently cuts users off from everything below the fold — snapshots also detect this passively as an OVERLAY line). Without `target` it scrolls the page, falling back to the largest scrollable pane on app-shell layouts. Pass `target` to scroll ONE region instead (a sidebar nav, a dialog body, a table pane): the page-level pick is the LARGEST scroll port, so a smaller region beside it never moves and its content looks truncated when it is only scrolled away — never call a nav item missing without scrolling its own container first. Use before judging a long page: the design audit measures at the current scroll position, so scroll + re-snapshot/re-audit deep sections; scroll also triggers lazy-loaded content whose failures then surface as oracle violations.",
    inputSchema: {
      to: z.enum(["top", "bottom"]).optional().describe("Jump to an edge"),
      by: z.number().int().min(-20000).max(20000).optional().describe("Scroll by px instead (positive = down). Default 600 when neither given."),
      target: z
        .string()
        .optional()
        .describe('Scroll ONE region instead of the page: "testid=…", "text=…" or "label=…". Scrolls that element\'s nearest scrollable ancestor.'),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_scroll", async ({ to, by, target }: { to?: "top" | "bottom"; by?: number; target?: string }, session) => {
    try {
      return text(await engineFor(session).scroll(to, by, target), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_press",
  {
    description: "Press a keyboard key (e.g. Escape, Tab, Enter) — useful for closing modals and testing keyboard navigation.",
    inputSchema: { key: z.string(), session: sessionParam },
  },
  serializedPerSession("scout_press", async ({ key }: { key: string }, session) => {
    try {
      return text(await engineFor(session).press(key), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_design_audit",
  {
    description:
      "Computed-style design audit of the current page — a design connoisseur's read WITHOUT screenshots. Measurable defects (⚠): WCAG contrast, tiny targets, clipped text, aspect-distorted images, horizontal overflow, missing keyboard-focus indicators (sampled with real Tab presses). Craft suggestions (→): line measure and line-height rhythm, spacing-scale adherence, typography entropy, palette discipline (gray census, accent hue families, pure-#000 body text), elevation/control consistency, heading structure, indistinguishable links, and AI-slop tells (gradient text, glassmorphism, side-stripe borders, neon glows, violet gradients, identical card grids). Ends with a SYSTEM SUMMARY of design-system coherence. Run once per representative page; the → tier is improvement feedback — file genuine opportunities as ux-polish findings with the concrete numbers, not just defects.",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_design_audit", async (_args: { session?: string }, session) => {
    try {
      return text(await engineFor(session).designAudit(), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_journey",
  {
    description:
      "Measure how EASY a real task is, not just whether it works — the question pass/fail e2e suites never answer. Wrap one user goal: scout_journey {action:'start', goal:'Create an order'}, perform it the way a first-time user would (navigate by CLICKING through the UI, not by jumping to a known deep URL — a shortcut invalidates the measurement), then scout_journey {action:'end', completed:true|false}. Returns interaction cost (clicks, navigations, distinct screens, elapsed), the actual path taken, and friction signals: BACKTRACKS (returning to a screen already left — the clearest sign the next step wasn't discoverable), screen count, and over-interaction. Run it on each module's primary journey; an abandoned journey is a high-severity finding.",
    inputSchema: {
      action: z.enum(["start", "end"]).describe("'start' before attempting the task, 'end' when done or blocked"),
      goal: z.string().optional().describe("For start: the user-facing task, e.g. 'Create an order and assign it'"),
      completed: z.boolean().default(true).describe("For end: did the user actually achieve the goal? false is a strong finding."),
      note: z.string().optional().describe("For end: what made it hard or easy, in one line"),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_journey",
    async ({ action, goal, completed, note }: { action: "start" | "end"; goal?: string; completed?: boolean; note?: string }, session) => {
      try {
        const eng = engineFor(session);
        if (action === "start") {
          if (!goal) throw new Error("scout_journey {action:'start'} needs a goal.");
          return text(eng.startJourney(goal), session);
        }
        return text(eng.endJourney(completed ?? true, note), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_note",
  {
    description:
      "Cumulative WRITTEN knowledge about the tested app — .scenescout/ASSUMPTIONS.md, in prose a human can read and correct. memory.json stores coverage; this stores UNDERSTANDING, so every run starts smarter than the last. READ it at the start of every session ({action:'read'}). ADD durable learnings as you go ({action:'add', section, note}): what the app is for (app-model), who each role is and what they're FOR — infer the persona from what the role can see and do, e.g. 'qa-role = reviewer: approves orders, cannot administer' (roles), UI patterns the app follows (conventions), rules discovered the hard way like 'an order can only ship once approved' (constraints), fragile areas worth re-testing every run (risks), domain terms (glossary). Notes are dated, attributed to the acting role, and deduplicated. Do NOT record session-specific facts (ids, counts) — only durable knowledge.",
    inputSchema: {
      action: z.enum(["read", "add"]).describe("'read' the accumulated knowledge, or 'add' one durable learning"),
      section: z
        .enum(["app-model", "roles", "conventions", "constraints", "risks", "glossary"])
        .optional()
        .describe("For add: which knowledge section this belongs to"),
      note: z.string().max(500).optional().describe("For add: the learning, one or two sentences, written for a future reader with no context"),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_note", async ({ action, section, note }: { action: "read" | "add"; section?: string; note?: string }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached — knowledge lives in the project's .scenescout/.");
      if (action === "read") return text(eng.memory.readAssumptions(), session);
      if (!section || !note) throw new Error("scout_note {action:'add'} needs section and note.");
      const added = eng.memory.addAssumption(section, note, eng.role);
      return text(
        added
          ? `Noted under "${section}". ASSUMPTIONS.md grows with every run — future sessions will start knowing this.`
          : `Already known (duplicate note) — not added.`,
        session,
      );
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_screenshot",
  {
    description:
      "Take a JPEG screenshot of the current viewport. LAST RESORT: geometry issues are in scout_snapshot and style/contrast/spacing issues are in scout_design_audit — images that failed to load are listed in scout_snapshot under BROKEN IMAGES — use a screenshot only for pixel-native content (a canvas, visual gestalt) that computed data cannot capture.",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_screenshot", async (_args: { session?: string }, session) => {
    try {
      const { base64, mimeType } = await engineFor(session).screenshot();
      return { content: [{ type: "image", data: base64, mimeType }] };
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_finding",
  {
    description:
      "Record a structured finding (bug, UX issue, or improvement). Deduplicates across runs; automatically captures the recent action trace as the repro. Use for anything worth reporting: crashes, oracle violations you confirmed, dead ends, confusing UX, permission leaks, missing testids — and design-audit improvement opportunities (ux-polish) with their concrete measurements.",
    inputSchema: {
      severity: z.enum(["high", "medium", "low"]),
      category: z
        .enum([
          "console-error",
          "page-error",
          "http-error",
          "network",
          "dead-end",
          "ux-confusing",
          "ux-polish",
          "visual",
          "a11y",
          "permission-leak",
          "data-inconsistency",
          "stale-state",
          "data-loss",
          "performance",
          "security",
          "missing-testid",
          "other",
        ])
        .describe("Pick the closest — use 'other' only when nothing fits"),
      title: z.string().describe("One-line summary of the defect"),
      detail: z.string().describe("What happened, what was expected, and the evidence"),
      evidence: z
        .string()
        .optional()
        .describe(
          "Canonical machine signature for dedup, e.g. 'GET /api/reports/dashboard 403' or 'widget dashboard-summary-widget shows 0'. Same bug re-found later should produce the same string.",
        ),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_finding",
    async (
      {
        severity,
        category,
        title,
        detail,
        evidence,
      }: {
        severity: "high" | "medium" | "low";
        category: string;
        title: string;
        detail: string;
        evidence?: string;
      },
      session,
    ) => {
      try {
        const eng = engineFor(session);
        if (!eng.memory) throw new Error("Not attached — findings need an active session.");
        const [finding, isNew] = eng.memory.addFinding({
          severity,
          category: category as Parameters<typeof eng.memory.addFinding>[0]["category"],
          title,
          detail,
          evidence,
          url: eng.currentUrl,
          state: eng.currentState || "(unknown)",
        });
        return text(
          isNew
            ? `Finding recorded: [${finding.severity}] ${finding.title} (id ${finding.id})`
            : finding.regressedAt
              ? `⟳ REOPENED as a REGRESSION: finding ${finding.id} was previously resolved but the evidence reproduces again (seen in ${finding.runs} runs). Worth calling out to the user.`
              : `Duplicate of existing finding ${finding.id} (seen in ${finding.runs} runs) — already known, keep exploring.`,
          session,
        );
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_coverage",
  {
    description:
      "Show exploration coverage: states visited across all runs and which elements remain unexercised. Use to decide where to explore next and when the level's budget is satisfied.",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_coverage", async (_args: { session?: string }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached.");
      const cov = eng.memory.coverage();
      const unvisited = eng.unvisitedKnownRoutes();
      const lines = [
        ...(eng.memory.lastSaveError
          ? [
              `⚠ MEMORY WRITE FAILING: ${eng.memory.lastSaveError} — coverage/findings since the last successful write are NOT persisted to disk. If this doesn't clear on its own, check the project directory still exists and is writable.`,
            ]
          : []),
        `States known: ${cov.states} · Elements exercised: ${cov.elementsExercised}/${cov.elementsTotal}`,
        formatRouteCoverage(eng.allKnownRoutes(), unvisited),
        `Unexercised elements by route:`,
        ...cov.unexercised.slice(0, 25).map((u) => `  ${u.state}: ${u.keys.slice(0, 6).join(", ")}${u.keys.length > 6 ? ` … +${u.keys.length - 6}` : ""}`),
      ];
      return text(lines.join("\n"), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_report",
  {
    description:
      "Generate the final markdown report — findings, page quality scores (worst first), role capability matrix, oracle rollup, and the GAP LEDGER (an explicit list of what was NOT tested). Writes the full document to .scenescout/report.md and returns a bounded SUMMARY (full reports exceed client token limits). Gates by level: 'minimal' needs all routes visited + ≥1 design audit; 'medium' additionally needs several routes audited; 'extensive' REFUSES while the gap ledger is non-empty — that refusal is the completeness guarantee: an extensive report only generates when nothing known is left untested. force=true overrides (only when the user capped the budget).",
    inputSchema: {
      force: z.boolean().default(false).describe("Generate even though gates are unmet (only when the user capped the budget)"),
      level: z
        .enum(["minimal", "medium", "extensive"])
        .default("medium")
        .describe("Which completion contract to enforce — match the level the run was asked for"),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_report", async ({ force, level }: { force?: boolean; level?: "minimal" | "medium" | "extensive" }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached.");
      const unvisited = eng.unvisitedKnownRoutes();
      const gates: string[] = [];
      if (unvisited.length > 0) {
        gates.push(
          `${unvisited.length} known route(s) never visited:\n` +
            unvisited
              .slice(0, 30)
              .map((r) => `  ${r}`)
              .join("\n") +
            (unvisited.length > 30 ? `\n  … +${unvisited.length - 30} more` : "") +
            `\n→ Run scout_crawl (no args) to cover them in one call.`,
        );
      }
      if (eng.designAuditCount === 0) {
        gates.push(`No scout_design_audit was run this session — run it on at least one representative page (visual/a11y coverage is part of every level).`);
      }
      const lvl = level ?? "medium";
      const auditedRoutes = Object.values(eng.memory.routeFacts).filter((f) => f.audited).length;
      const visitedCount = new Set(Object.values(eng.memory.states).map((st) => st.route)).size;
      if (lvl !== "minimal") {
        const needed = Math.min(3, Math.max(1, Math.ceil(visitedCount / 10)));
        if (auditedRoutes < needed) {
          gates.push(
            `Level '${lvl}' needs design audits on ≥${needed} distinct routes (have ${auditedRoutes}) — audit the representative pages (dashboard, a form, a detail view, a table).`,
          );
        }
      }
      const all = eng.allKnownRoutes();
      const gapList = computeGaps(eng.memory, {
        routesVisited: all.length - unvisited.length,
        routesTotal: all.length,
        designAudits: eng.designAuditCount,
        unvisitedRoutes: unvisited,
        mode: eng.mode,
      });
      if (lvl === "extensive" && gapList.length > 0) {
        gates.push(
          `Level 'extensive' claims completeness, so it refuses while the GAP LEDGER is non-empty:\n` +
            gapList.map((g) => `  ⚠ ${g}`).join("\n") +
            `\nClose the gaps (or report at level 'medium', which discloses them instead).`,
        );
      }
      if (gates.length > 0 && !force) {
        return text(
          `NOT GENERATED — the '${lvl}' completion contract is unmet:\n\n${gates.join("\n\n")}\n\n` +
            `Then call scout_report again. Pass force=true ONLY if the user explicitly capped the budget.`,
          session,
        );
      }
      const { path: p, summary } = generateReport(eng.memory, eng.oracleLog.all, {
        routesVisited: all.length - unvisited.length,
        routesTotal: all.length,
        designAudits: eng.designAuditCount,
        createdResources: eng.createdResources,
        unvisitedRoutes: unvisited,
        mode: eng.mode,
        policyAttributed: eng.oracleLog.policyAttributed,
      });
      void p;
      return text(summary, session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_resolve",
  {
    description:
      "Mark a finding as resolved (by its id, shown when recorded and in the report). Resolved findings move to the report's green ✅ Resolved section, and reopen automatically as flagged REGRESSIONS if re-found later. Use when the user says a bug is fixed, or when re-testing shows the evidence no longer reproduces.",
    inputSchema: {
      findingId: z.string().optional().describe("Finding id, e.g. a1b2c3d4e5"),
      // scout_finding prints "(id a1b2c3d4e5)" and the report renders "**Id:**",
      // so `id` is the name a caller reaches for first — and every schema here
      // is additionalProperties:false, so the near-miss was a hard rejection.
      id: z.string().optional().describe("Alias for `findingId`."),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_resolve", async ({ findingId, id }: { findingId?: string; id?: string }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached.");
      const wanted = findingId ?? id;
      if (!wanted) return text(`Pass the finding id: scout_resolve { id: "a1b2c3d4e5" }.`, session);
      const f = eng.memory.resolveFinding(wanted);
      return text(f ? `Resolved: [${f.severity}] ${f.title}` : `No finding with id ${wanted}.`, session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_close",
  {
    description:
      "Close a session's browser (memory persists on disk). Default: the DEFAULT session. Pass session to close a specific one, or all=true to close every live session at the end of a multi-role run.",
    inputSchema: {
      session: z.string().max(40).optional().describe("Session to close (default: the default session)"),
      all: z.boolean().default(false).describe("Close every live session"),
    },
  },
  serializedControl(async ({ session, all }: { session?: string; all?: boolean }) => {
    try {
      if (all) {
        const names = [...engines.keys()];
        // Closes are independent per-browser — run them in parallel so N wedged
        // sessions cost one 8s teardown cap total, not N of them.
        await Promise.allSettled([...engines.values()].map((e) => e.close()));
        engines.clear();
        sessionQueue.clear();
        return text(`All sessions closed (${names.join(", ") || "none were live"}). Memory and reports remain in .scenescout/.`, activeName);
      }
      const name = session ?? activeName;
      const eng = engines.get(name);
      if (!eng) return text(`No live session "${name}".`, name);
      await eng.close();
      const saveError = eng.memory?.lastSaveError;
      engines.delete(name);
      sessionQueue.forget(name);
      if (activeName === name) activeName = engines.keys().next().value ?? "default";
      return text(
        `Session "${name}" closed. Memory and report remain in .scenescout/.` +
          (engines.size > 0 ? ` Default session → ${activeName}.` : "") +
          (saveError ? `\n⚠ The final memory write failed (${saveError}) — some coverage/findings from this session may not have been persisted to disk.` : ""),
        activeName,
      );
    } catch (err) {
      return errorText(err);
    }
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Self-heal across restarts: browsers whose parent crashed/was killed can
  // linger and have been observed to wedge fresh launches. After connect —
  // the stdio handshake must not wait on a full process-table scan.
  setImmediate(() => reapOrphanBrowsers());
}

async function shutdown(): Promise<void> {
  await Promise.allSettled([...engines.values()].map((e) => e.close()));
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

main().catch((err) => {
  console.error("SceneScout MCP server failed:", err);
  process.exit(1);
});
