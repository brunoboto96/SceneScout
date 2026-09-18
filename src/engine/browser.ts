import { chromium, type Browser, type BrowserContext, type FileChooser, type Locator, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { elementKey, fingerprintState, isNonPageRoute, normalizePath, type InteractableInfo } from "./fingerprint.js";
import { AUTH_LOSS_PREFIX, MemoryStore, type ActionLogEntry } from "./memory.js";
import { AuthLossTracker } from "./authloss.js";
import { COLLECT_INTERACTABLES_SCRIPT, DIALOG_LIKE_SEL, VISIBLE_SRC, geometryIssues, type Rect } from "./collector.js";
import { OracleMonitor, formatViolations } from "./oracles.js";
import { extractCreatedIds, isOwnedResource } from "./ownership.js";
import { AUTH_FLOW_RE, destructiveRefusal, isDestructive, isDestructiveWire } from "./policy.js";
import { scanProject } from "../scan.js";
import { analyzeDesign, DESIGN_COLLECT_SCRIPT, type DesignPayload, type FocusSample } from "./design.js";
import { FIXTURE_KINDS, acceptMatches, generatedUpload, isFixtureKind, mimeForName, type FixtureFile, type FixtureKind } from "./fixtures.js";

/**
 * Write-policy tiers — the DB behind the app may be live, so the guarantee
 * lives at the network layer (HTTP verbs), not in button labels:
 * - "read-only":  UI destructive-label blocking + network block of
 *                 PUT/PATCH/DELETE and destructive-keyword POSTs. Plain POSTs
 *                 pass (search/login are POSTs) but are reported.
 * - "safe-write": create freely; the engine tracks what THIS SESSION creates
 *                 (ids from POST responses) and allows PUT/PATCH/DELETE only
 *                 on those resources. Label blocking off — deleting your own
 *                 record is the point.
 * - "destructive": everything allowed (explicit opt-in for disposable envs).
 */
export type WriteMode = "read-only" | "safe-write" | "destructive";

export interface AttachOptions {
  url: string;
  projectDir: string;
  storageStatePath?: string;
  mode?: WriteMode;
  headed?: boolean;
  viewport?: { width: number; height: number };
  /**
   * Share one MemoryStore across engines attached to the same project
   * (multi-session/multi-role runs): coverage and findings from every role
   * merge into one memory, and concurrent engines never race each other's
   * writes to memory.json because all writes go through one instance.
   */
  memoryStore?: MemoryStore;
}

export interface UploadOptions {
  /** A file input, or the control that opens its chooser. Omit to use the page's only file input. */
  ref?: string;
  /** A real file to upload — must live inside the attached project. */
  filePath?: string;
  /** Generated fixture kind; default inferred from the input's `accept` attribute. Exclusive with `filePath`. */
  fixture?: FixtureKind;
  /** Filename override — how upload names get fuzzed. */
  name?: string;
}

interface UploadOutcome {
  refused?: string;
  summary: string;
  notes: string;
  /** Request-log sizes just before the file was set — only later traffic is "uploaded on selection". */
  mutationsBefore: number;
  blockedBefore: number;
}

/** What a file input admits and how a user would name it. `probed:false` = the input could not be inspected. */
interface FileInputMeta {
  accept: string | null;
  multiple: boolean;
  label: string;
  disabled: boolean;
  probed: boolean;
}

/** One file input on the page, as the listing probe reports it. */
interface FileInputListing {
  testid: string | null;
  id: string | null;
  name: string | null;
  accept: string | null;
  multiple: boolean;
  /** By the collector's own rule — false means it is not in the snapshot's element list. */
  visible: boolean;
}

/** Launch flag stamped into our browsers' command lines so the reaper can recognise them. */
export const BROWSER_MARKER = "scenescout-session";
/** Markers earlier versions stamped. Launch uses only the current one; the reaper must still recognise a browser orphaned by a crash just before an upgrade. */
const REAPABLE_MARKERS = [BROWSER_MARKER, "scenecraft-session"];

/**
 * Kill orphaned Playwright browser processes left behind by a crashed or
 * SIGKILL'd previous run (a dead parent can't close its browser, and the
 * leftover has been observed to wedge subsequent launches). Conservative on
 * three axes: the command line must point into the ms-playwright cache, the
 * parent must be gone (re-parented to pid 1), AND the command line must carry
 * our marker (passed as a launch flag precisely so it shows up in `ps`).
 *
 * That last check is why this is narrow enough to run at startup. Matching on
 * "orphaned Playwright browser" alone reaches every Playwright process on the
 * machine — someone else's test suite, an unrelated automation job, a browser
 * whose wrapper died while its owner lived — and SIGKILLs it. Only reap what
 * this tool launched.
 *
 * Best-effort and POSIX-only; returns how many were reaped.
 */
export function reapOrphanBrowsers(): number {
  if (process.platform === "win32") return 0;
  let reaped = 0;
  try {
    const psOut = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
    for (const line of psOut.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pidStr, ppidStr, command] = m;
      if (!command.includes("ms-playwright") || !/chrom|firefox|webkit/i.test(command)) continue;
      if (!REAPABLE_MARKERS.some((marker) => command.includes(marker))) continue;
      if (Number(ppidStr) !== 1) continue;
      try {
        process.kill(Number(pidStr), "SIGKILL");
        reaped += 1;
      } catch {
        /* already gone or not ours to kill */
      }
    }
  } catch {
    /* ps unavailable or timed out — reaping is best-effort */
  }
  if (reaped > 0) console.error(`[scenescout] reaped ${reaped} orphaned browser process(es) from a previous run`);
  return reaped;
}

interface SnapshotElement extends InteractableInfo {
  ref: string;
  key: string;
  tag: string;
  xpath: string;
  disabled: boolean;
  href: string | null;
  destructive: boolean;
  clipped?: boolean;
  /** Nearest positioning/scroll-context id (0 = document flow) — overlap grouping. */
  layer?: number;
  /** Inside position:fixed/sticky chrome — overlaps between chrome are intended layering. */
  chrome?: boolean;
  rect: Rect;
}

const SETTLE_MS = 400;

/**
 * Request URL → pathname, falling back to the raw string for anything
 * unparseable (data: URLs, relative forms Playwright occasionally reports).
 *
 * Extracted because BOTH destructive-wire checks must see the same thing. When
 * the bookkeeping check inlined its own version it drifted into passing the
 * HTTP METHOD as the url and the url as the body — so a destructive GraphQL
 * mutation, whose only evidence lives in the POST body, was never inspected
 * there at all, and a request the policy went on to BLOCK still marked its
 * route "mutated". One helper, two callers, no room to diverge again.
 */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const ACTION_TIMEOUT_MS = 5000;
/** Budget for the forced retry of a click whose strict wait timed out — it skips that wait, so needs little. */
const FORCED_CLICK_TIMEOUT_MS = 1500;
/** How long after a trigger click resolves a file chooser may still open (apps fetch an upload URL first). */
const CHOOSER_GRACE_MS = 2000;
/** A renamed disk upload travels as an in-memory payload; keep that to what Playwright carries comfortably. */
const MAX_RENAMED_UPLOAD_BYTES = 50 * 1024 * 1024;
/** How long a hover waits for delay-gated tooltips (component libraries warm up for as long as ~1500ms). */
const HOVER_REVEAL_WINDOW_MS = 2500;

/** Non-GET traffic that is auth/telemetry plumbing, not tester-caused state mutation. */
const BENIGN_MUTATION_RE = /\/auth\/(refresh|token|session)|refresh[-_]?token|\/telemetry|\/analytics|\/heartbeat|\/sentry|\/collect\b|\/logs?\b|\/metrics\b/i;

/** In-page XPath lookup fragment for string-expression evaluates. */
function xpathLookup(xpath: string): string {
  return `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
}

/** Runs in the page against one file input (or the one a chooser belongs to). */
function describeFileInput(node: Element): FileInputMeta {
  const input = node as HTMLInputElement;
  const id = input.getAttribute("id");
  const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : input.closest("label");
  const label = (input.getAttribute("aria-label") || (labelEl && labelEl.textContent) || input.getAttribute("data-testid") || input.name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return { accept: input.getAttribute("accept"), multiple: input.multiple, label, disabled: input.disabled, probed: true };
}

/** Every file input on the page, with the collector's own visibility verdict. */
const LIST_FILE_INPUTS_SCRIPT = `(() => {
  const visible = ${VISIBLE_SRC};
  return Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({
    testid: i.getAttribute("data-testid"), id: i.id || null, name: i.name || null,
    accept: i.getAttribute("accept"), multiple: i.multiple, visible: visible(i),
  }));
})()`;

/** One name for a file input wherever it is mentioned — a refusal and a snapshot line must agree on who is who. */
function fileInputLabel(d: FileInputListing): string {
  const who = d.testid ? `testid=${d.testid}` : d.id ? `id=${d.id}` : d.name ? `name=${d.name}` : "unnamed";
  return `input[type=file] ${who}${d.accept ? ` accept=${d.accept}` : ""}${d.multiple ? " multiple" : ""}`;
}

/** What an upload will send, however it was chosen. */
interface ResolvedUpload {
  payload: string | FixtureFile;
  name: string;
  mime: string;
  bytes: number;
  source: string;
}

/** The generated-fixture case: kind inferred from the input's accept unless given. */
function generatedPayload(meta: FileInputMeta, opts: Omit<UploadOptions, "ref">): ResolvedUpload {
  const { file, source } = generatedUpload(meta.probed ? meta.accept : undefined, opts.fixture, opts.name);
  return { payload: file, name: file.name, mime: file.mimeType, bytes: file.buffer.length, source };
}

/** A plan's upload `value`: blank → fixture inferred from accept; a kind → that fixture; anything else → a project-relative path. */
function planUploadOptions(value: string | undefined): Omit<UploadOptions, "ref"> {
  const spec = (value ?? "").trim();
  if (spec === "") return {};
  const kind = spec.toLowerCase();
  if (isFixtureKind(kind)) return { fixture: kind };
  return { filePath: spec };
}

/**
 * Extract the specific actionability reason from a Playwright locator-action
 * timeout's multi-line error, if present — the useful diagnostic ("intercepts
 * pointer events") lives in the "Call log:" body, not line 1 ("Timeout 5000ms
 * exceeded"). Shared by the forced-click fallback (to decide WHETHER to
 * force) and plan-step failure reporting (to show the reader why).
 */
function actionabilityDiagnostic(message: string): string | null {
  return (
    message
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /intercepts pointer events|is not visible|is not stable|is not enabled|is outside of the viewport/i.test(l)) ?? null
  );
}

/**
 * The deterministic browser engine. Owns the Playwright lifecycle, executes
 * actions by ref, runs oracles after every action, and records everything in
 * the persistent memory store. Contains no LLM calls — the MCP client is the brain.
 */
export class BrowserEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private oracles = new OracleMonitor();
  private refs = new Map<string, SnapshotElement>();
  private refCounter = 0;
  private currentFingerprint = "";
  /** URL at the time of the last snapshot — refs are valid only while it matches. */
  private snapshotUrl = "";
  /** Last snapshot's identity map (per route) — enables stable refs + diff snapshots. */
  private lastSnap: { route: string; byKey: Map<string, { ref: string; label: string; disabled: boolean }> } | null = null;
  /** Non-parameterized routes discovered by the project scan — the objective completion contract. */
  knownRoutes: string[] = [];
  /** Real path of the attached project — the fence for ft_upload's filePath. */
  private projectDir = "";
  /** Set when the project's real path could not be resolved — named in fence refusals, which it may then cause. */
  private projectDirNote = "";
  memory: MemoryStore | null = null;
  mode: WriteMode = "read-only";
  /** Human label for the auth identity driving this session (the server sets it from the storage-state filename). */
  role = "anonymous";
  /** Named-session id (the server sets it; every engine shares one MemoryStore, so
   *  per-session reads of the interleaved action log must filter by this). */
  sessionKey = "default";

  /** Login-bounce streak, the SESSION AUTH LOST verdict, and the per-call notice. */
  private readonly authLoss = new AuthLossTracker();

  /** UI-label blocking applies only in read-only mode (safe-write enforces at the network layer instead). */
  get readOnly(): boolean {
    return this.mode === "read-only";
  }
  /** Append to the shared action log, stamped with THIS session so per-session
   *  reads (journey paths) can separate concurrent roles' interleaved actions. */
  private logAction(entry: Omit<ActionLogEntry, "at" | "session">): void {
    this.memory?.logAction({ ...entry, session: this.sessionKey });
  }
  /** Requests blocked by the write policy since the last action (timestamped for attribution). */
  private blockedRequests: Array<{ at: number; sig: string }> = [];
  /** When the current action began — requests recorded before this are late arrivals from a previous action. */
  private actionStartedAt = 0;
  /**
   * Resources created by this RUN (safe-write): id → collection paths.
   * Backed by the shared MemoryStore so every named session in a multi-role
   * run shares one ownership set — role A creating a record that role B must
   * act on is the point of multi-role testing. Falls back to a local map
   * before attach (no store yet).
   */
  private get ownedIds(): Map<string, Set<string>> {
    return this.memory?.ownedIds ?? this.localOwnedIds;
  }
  private readonly localOwnedIds = new Map<string, Set<string>>();
  /**
   * In-flight recordCreation() calls (safe-write). A single UI action often
   * fires POST-then-immediately-PUT (create, then save the content it just
   * got an id for) — the PUT's route handler runs synchronously, but
   * recordCreation awaits the POST response body, so without this the PUT
   * could be evaluated and wrongly blocked before its own creation had
   * finished registering.
   */
  private pendingCreations = new Set<Promise<unknown>>();

  /** Await `p` for at most `ms`, clearing the timer either way (never rejects, never leaks a timer). */
  private static async settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      p.catch(() => {}).finally(() => clearTimeout(timer)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  }
  /** Human-readable creation log for the run — shared across sessions, becomes the report's cleanup list. */
  get createdResources(): string[] {
    return this.memory?.createdResources ?? this.localCreatedResources;
  }
  private readonly localCreatedResources: string[] = [];
  /** Design audits run this session — the report gate requires at least one. */
  designAuditCount = 0;
  /** Active task-efficiency measurement (ft_journey), if any. */
  private journey: { goal: string; startedAt: number; fromLog: number; startUrl: string } | null = null;

  /**
   * Begin measuring a user JOURNEY — the interaction cost of completing one
   * real task ("create an order", "approve a document"). E2E suites assert
   * a task is *possible*; this measures whether it is *easy*, which is the
   * question no pass/fail assertion answers.
   */
  startJourney(goal: string): string {
    const page = this.requirePage();
    this.journey = {
      goal,
      startedAt: Date.now(),
      fromLog: this.memory?.actionLog.length ?? 0,
      startUrl: page.url(),
    };
    this.logAction({ action: "journey:start", target: goal, url: page.url() });
    return `JOURNEY STARTED — "${goal}"\nFrom: ${page.url()}\nNow perform the task the way a first-time user would (click through the UI; don't jump straight to a known deep URL, or the measurement is meaningless). Call ft_journey {action:"end"} when the task is complete or you conclude it can't be.`;
  }

  /** Close the journey and report its interaction cost + friction signals. */
  endJourney(completed: boolean, note?: string): string {
    const j = this.journey;
    if (!j) return `No journey in progress — start one with ft_journey {action:"start", goal:"…"}.`;
    const page = this.requirePage();
    this.journey = null;
    // Filter to THIS session's actions: the action log is shared across every
    // role in a multi-role run, so a concurrent session navigating during this
    // journey would otherwise contaminate its path, screen count, and backtracks.
    const log = (this.memory?.actionLog ?? []).slice(j.fromLog).filter((e) => (e.session ?? this.sessionKey) === this.sessionKey);
    const seconds = Math.round((Date.now() - j.startedAt) / 1000);

    const interactions = log.filter((e) => /^(click|type|select|press|plan:(click|type|select|press))/.test(e.action));
    const navigations = log.filter((e) => /^(navigate|back|plan:navigate|plan:back)/.test(e.action));
    const routeOf = (u: string): string => {
      try {
        return normalizePath(new URL(u).pathname);
      } catch {
        return u;
      }
    };
    const routeSeq = log.map((e) => routeOf(e.url)).filter((r, i, a) => i === 0 || r !== a[i - 1]);
    const distinct = new Set(routeSeq);
    // A backtrack = returning to a route already left behind. Real users do
    // this when the path wasn't obvious; it is the clearest signal that
    // information scent failed, and it is invisible to a pass/fail test.
    const seen = new Set<string>();
    let backtracks = 0;
    for (const r of routeSeq) {
      if (seen.has(r)) backtracks += 1;
      seen.add(r);
    }
    const blocked = log.filter((e) => e.action === "write-policy:blocked").length;
    const refusals = log.filter((e) => /refused|REFUSED/.test(e.result ?? "")).length;

    const verdict: string[] = [];
    if (backtracks > 0)
      verdict.push(
        `⚠ ${backtracks} backtrack(s) — the route was re-visited after leaving it, which usually means the next step wasn't discoverable from where the user was`,
      );
    if (distinct.size > 4)
      verdict.push(
        `⚠ ${distinct.size} distinct screens for one task — each hand-off is a chance to lose the user; consider whether steps can be combined or done in place`,
      );
    if (interactions.length > 15)
      verdict.push(
        `⚠ ${interactions.length} interactions — high for a single task; check for over-asking (optional fields up-front) or repeated confirmation steps`,
      );
    const shortcuts = log.filter((e) => /^(navigate|plan:navigate)$/.test(e.action)).length;
    if (shortcuts > 0)
      verdict.push(
        `⚠ ${shortcuts} direct-URL jump(s) during the journey — a first-time user cannot type URLs, so the measurement is contaminated: either re-run clicking through the UI, or the destination is unreachable by UI navigation (which is itself a finding).`,
      );
    if (!completed) verdict.push(`⚠ TASK NOT COMPLETED — this is the strongest possible finding: the journey is blocked or undiscoverable. File it.`);
    if (verdict.length === 0) verdict.push(`✓ efficient — direct path, no backtracking, proportionate interaction count`);

    try {
      // Only a COMPLETED journey is a measurement of task ease. An abandoned
      // one proves the task is blocked — a high-severity finding — and must
      // not also close the gap that says ease was never measured.
      this.memory?.markRouteFact(normalizePath(j.startUrl), { journeys: 1, journeysCompleted: completed ? 1 : 0 });
    } catch {
      /* fact recording is best-effort */
    }
    this.logAction({ action: "journey:end", target: j.goal, url: page.url(), result: completed ? "completed" : "abandoned" });
    return [
      `JOURNEY ${completed ? "COMPLETED" : "ABANDONED"} — "${j.goal}"`,
      ``,
      `Interaction cost: ${interactions.length} interactions · ${navigations.length} navigations · ${distinct.size} distinct screens · ${seconds}s`,
      `Path: ${routeSeq.slice(0, 12).join(" → ")}${routeSeq.length > 12 ? " → …" : ""}`,
      ...(blocked > 0 || refusals > 0 ? [`Policy: ${blocked} write-policy blocks, ${refusals} refusals (tester safety, not app defects)`] : []),
      ...(note ? [`Note: ${note}`] : []),
      ``,
      `Efficiency read:`,
      ...verdict.map((v) => `  ${v}`),
      ``,
      `Judge with product context: a 3-screen approval flow with an e-signature step is legitimately longer than "add a comment". Compare against what the task NEEDS, then file genuine friction as ux-confusing (blocked/undiscoverable) or ux-polish (works but costs more than it should), quoting these numbers.`,
    ].join("\n");
  }
  /** Whether the browser window is visible — headed hover results carry a physical-cursor caveat. */
  private headed = false;
  /** Non-GET requests fired since the last action — surfaces silent state mutation in read-only runs (timestamped for attribution). */
  private mutationRequests: Array<{ at: number; sig: string; req: import("playwright").Request }> = [];
  /**
   * Requests the write policy aborted, by identity. The request event fires for
   * every non-GET the page ATTEMPTS, before the route handler decides its fate,
   * so without this the same DELETE was reported twice with opposite meanings:
   * "server state may have mutated despite read-only mode" and "WRITE-POLICY
   * blocked". Identity rather than URL matching: two requests to one URL can
   * meet different fates, and a blocked /items/7/archive must not hide an
   * allowed POST /items that shares its prefix.
   */
  private readonly abortedByPolicy = new WeakSet<import("playwright").Request>();
  /** Raw mutation sigs of the most recent action (pre-dedup) — double-submit detection. */
  private lastActionMutationSigs: string[] = [];
  /** Write-policy blocks drained by the last action — counted, so an action can know a request fired even when the policy stopped it. */
  private lastActionBlocked = 0;
  baseUrl = "";

  get attached(): boolean {
    return this.page !== null;
  }

  async attach(opts: AttachOptions): Promise<string> {
    await this.close();
    if (opts.storageStatePath && !fs.existsSync(opts.storageStatePath)) {
      throw new Error(`storageStatePath does not exist: ${opts.storageStatePath}`);
    }
    this.mode = opts.mode ?? "read-only";
    this.headed = opts.headed ?? false;
    this.blockedRequests = [];
    this.pendingCreations = new Set();
    this.baseUrl = opts.url.replace(/\/$/, "");
    // Ownership (ownedIds/createdResources) deliberately NOT reset here: it
    // lives on the shared MemoryStore for the whole run, so re-attaching one
    // role must not discard what another role already created — otherwise
    // every multi-role handoff would be blocked as "not yours".
    this.memory = opts.memoryStore ?? new MemoryStore(opts.projectDir);
    // The REAL path, not merely the resolved one: on macOS the temp tree is a
    // symlink, and a fence comparing a real path against an unreal one would
    // refuse every upload from inside the project.
    try {
      this.projectDir = fs.realpathSync(path.resolve(opts.projectDir));
      this.projectDirNote = "";
    } catch (err) {
      // Keep the unreal path rather than fail attach — but a fence built on
      // it may refuse in-project uploads on a symlinked project, so every
      // such refusal names this as a possible cause instead of hiding it.
      this.projectDir = path.resolve(opts.projectDir);
      this.projectDirNote = ` (its real path could not be resolved: ${err instanceof Error ? err.message : String(err)} — a symlinked project path may be wrongly refused)`;
    }
    this.oracles = new OracleMonitor();
    this.lastSnap = null;
    this.designAuditCount = 0;

    // The engine learns the route list itself so completion is an objective,
    // enforceable contract (ft_report refuses while known routes are unvisited)
    // rather than a prompt suggestion the driver may ignore.
    try {
      this.knownRoutes = scanProject(opts.projectDir)
        .routes.filter((r) => !r.includes(":"))
        .slice(0, 200);
    } catch {
      this.knownRoutes = [];
    }

    try {
      this.browser = await this.launchWithRecovery(opts.headed ?? false);
      this.context = await this.browser.newContext({
        storageState: opts.storageStatePath,
        viewport: opts.viewport ?? { width: 1280, height: 900 },
      });
      this.page = await this.context.newPage();
    } catch (err) {
      await this.close();
      throw err;
    }
    this.oracles.attach(this.page);
    // Label-based read-only blocking can't catch every mutation (an innocuous
    // "Add to Cart" fires a POST). Track non-GET traffic so actions that
    // changed server state are at least REPORTED in read-only runs.
    this.context.on("request", (req) => {
      const type = req.resourceType();
      if (type === "xhr" || type === "fetch") this.xhrCount += 1;
      const method = req.method();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
      // Infrastructure POSTs (token refresh, telemetry) are not state the
      // tester mutated — reporting them trains the driver to ignore the notice.
      if (BENIGN_MUTATION_RE.test(req.url())) return;
      if (this.mutationRequests.length < 20) {
        this.mutationRequests.push({ at: Date.now(), sig: `${method} ${req.url().slice(0, 120)}`, req });
      }
      // Gap-ledger fact: this route's forms/actions were actually EXERCISED,
      // not just looked at — the difference between visited and tested.
      //
      // Only for requests the policy will actually let through. This event
      // fires BEFORE the route handler aborts a blocked one, so counting it
      // here let a REFUSED destructive POST mark the route as mutated — a form
      // that was never submitted reading as tested, in read-only mode where by
      // definition nothing is.
      if (this.readOnly && isDestructiveWire(pathnameOf(req.url()), req.postData())) return;
      const pageUrl = this.page?.url();
      if (pageUrl && this.memory) {
        try {
          this.memory.markRouteFact(normalizePath(pageUrl), { mutated: true });
        } catch {
          /* fact recording is best-effort */
        }
      }
    });

    // Write policy — enforced on the wire, where the truth lives.
    if (this.mode !== "destructive") {
      await this.context.route("**/*", async (route) => {
        const req = route.request();
        const method = req.method();
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue();
        const url = req.url();
        const pathname = pathnameOf(url);
        // Auth/session flows (login, refresh, logout) must work in every mode.
        if (AUTH_FLOW_RE.test(pathname) && method === "POST") return route.continue();

        const destructiveWire = isDestructiveWire(pathname, req.postData());
        let owned = this.isOwnedResource(pathname);
        // A single UI action commonly fires create-then-immediately-save
        // (POST gets an id, PUT saves content under it) faster than the
        // POST's recordCreation() can finish awaiting its response body.
        // The POST registered itself in pendingCreations SYNCHRONOUSLY in
        // this same handler (below) before its request even went out, so by
        // the time the follow-up PUT arrives here the pending entry is
        // guaranteed visible — give it a bounded moment to land before the
        // mutation is judged not-owned, otherwise the session's own,
        // just-created resource gets wrongly blocked by a timing accident.
        if (!owned && this.mode === "safe-write" && method !== "POST" && this.pendingCreations.size > 0) {
          await BrowserEngine.settleWithin(Promise.allSettled([...this.pendingCreations]), 1500);
          owned = this.isOwnedResource(pathname);
        }
        // POST: creation/RPC passes unless it smells destructive and isn't ours.
        // PUT/PATCH/DELETE: only in safe-write, only on our own resources.
        const allow = method === "POST" ? !destructiveWire || owned : this.mode === "safe-write" && owned;
        if (allow) {
          // Ownership tracking (safe-write): register the creation-tracking
          // task BEFORE the POST goes out. Registering from a context
          // "response" listener instead would race the follow-up PUT's route
          // handler — the response event fires asynchronously, so a PUT
          // chained directly off the POST's json() could be judged before
          // the listener ever ran. Here the registration is synchronous with
          // request dispatch, which closes that window completely.
          if (this.mode === "safe-write" && method === "POST" && !BENIGN_MUTATION_RE.test(url)) {
            const task: Promise<unknown> = req
              .response()
              .then((res) => (res && res.ok() ? this.recordCreation(res) : undefined))
              .catch(() => {})
              .finally(() => this.pendingCreations.delete(task));
            this.pendingCreations.add(task);
          }
          return route.continue();
        }
        if (this.blockedRequests.length < 20) this.blockedRequests.push({ at: Date.now(), sig: `${method} ${url.slice(0, 140)}` });
        this.logAction({ action: "write-policy:blocked", target: `${method} ${pathname}`, url: this.page?.url() ?? "" });
        this.abortedByPolicy.add(req);
        return route.abort("blockedbyclient");
      });
    }

    // Popups / target=_blank: adopt same-origin pages as the active page (with
    // oracles attached); close foreign-origin popups so exploration cannot
    // silently escape the app under test.
    this.context.on("page", (newPage) => {
      newPage
        .waitForLoadState("domcontentloaded", { timeout: 10000 })
        .then(() => {
          if (newPage === this.page || newPage.isClosed()) return;
          const sameOrigin = this.isSameOrigin(newPage.url());
          this.logAction({
            action: sameOrigin ? "popup:adopted" : "popup:closed-foreign",
            target: newPage.url().slice(0, 200),
            url: this.page?.url() ?? "",
          });
          if (sameOrigin) {
            this.oracles.attach(newPage);
            this.wireDialogHandler(newPage);
            this.page = newPage;
            this.refs.clear();
            this.snapshotUrl = "";
            this.lastSnap = null;
          } else {
            void newPage.close().catch(() => {});
          }
        })
        .catch(() => {});
    });

    this.wireDialogHandler(this.page);

    try {
      await this.page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (err) {
      // Don't leave a half-attached engine (leaked browser, snapshots of about:blank).
      await this.close();
      throw new Error(`Could not load ${opts.url} — is the app running? (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    }
    await this.settle();
    this.logAction({ action: "attach", url: this.page.url() });
    // Attaching WITH a storage state and landing on a login page means the
    // stored credentials are dead. Saying "Attached … auth=<file>" here — which
    // is all this used to do — reads as success and names the very file that
    // just failed, so a run would proceed for hundreds of calls against a
    // logged-out browser. The file existing was the only thing ever checked.
    const authFailed = Boolean(opts.storageStatePath) && this.authLoss.isLoginRedirect(normalizePath(opts.url), this.page.url(), this.baseUrl);
    const authWarning = authFailed
      ? `\n⚠ AUTH FAILED — the storage state at ${opts.storageStatePath} did not produce a signed-in session: ` +
        `attaching landed on ${this.page.url()}, a login page. Regenerate it (its token has most likely expired) and re-attach. ` +
        `Continuing now tests a logged-out app.`
      : "";
    return (
      `Attached to ${this.page.url()} (mode=${this.mode}` +
      `${opts.storageStatePath ? `, auth=${opts.storageStatePath}` : ""}). ` +
      `Memory: ${this.memory.dir}.${this.memory.loadWarning ? ` WARNING: ${this.memory.loadWarning}` : ""}` +
      `${this.memory.legacyDirNote ? ` ${this.memory.legacyDirNote}` : ""}` +
      `${this.memory.gitIgnoreNote ? ` ${this.memory.gitIgnoreNote}` : ""} Call ft_snapshot to see the current state.` +
      authWarning
    );
  }

  /** Dialogs (confirm/alert): dismiss in read-only mode, accept otherwise. Must be wired on every page we drive, including adopted popups. */
  private wireDialogHandler(page: Page): void {
    page.on("dialog", (dialog) => {
      const action = this.readOnly ? "dismiss" : "accept";
      this.logAction({
        action: `dialog:${action}`,
        target: dialog.message().slice(0, 120),
        url: this.page?.url() ?? "",
      });
      void (this.readOnly ? dialog.dismiss() : dialog.accept()).catch(() => {});
    });
  }

  private requirePage(): Page {
    if (!this.page || !this.memory) {
      throw new Error("Not attached. Call ft_attach first with the app URL and project path.");
    }
    return this.page;
  }

  private async settle(): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    // A fixed floor, deliberately: waitForLoadState("networkidle") is latched
    // once reached and resolves instantly forever after, so it cannot be used
    // to wait out in-flight requests here — and draining oracles before a
    // just-fired request lands would misattribute its violations.
    await page.waitForTimeout(SETTLE_MS);
  }

  /** Collect the current page's interactables into SnapshotElements with stable refs. */
  private async collect(): Promise<{ elements: SnapshotElement[]; truncated: boolean }> {
    const page = this.requirePage();
    type RawElement = {
      tag: string;
      role: string;
      name: string;
      testid: string | null;
      xpath: string;
      disabled: boolean;
      href: string | null;
      rect: Rect;
      clipped?: boolean;
      layer?: number;
      chrome?: boolean;
    };
    // SPAs (and dev servers mid-recompile) can present an empty shell for a
    // few seconds — and a shell that already renders its chrome (sidebar,
    // nav) passes a zero-check while the route content is still loading.
    // Retry until two consecutive probes agree on the element count, so we
    // snapshot the hydrated page, not the loading state.
    let rawElements: RawElement[] = (await page.evaluate(COLLECT_INTERACTABLES_SCRIPT)) as RawElement[];
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.waitForTimeout(rawElements.length === 0 ? 500 : 300);
      const probe = (await page.evaluate(COLLECT_INTERACTABLES_SCRIPT)) as RawElement[];
      const stable = probe.length === rawElements.length && probe.length > 0;
      rawElements = probe;
      if (stable) break;
    }

    // Element identity is the coverage key (testid or role+name, ordinal-
    // disambiguated). When a key persists across snapshots of the same route,
    // its ref is REUSED — diffs stay meaningful and the agent's mental model
    // (and previously issued refs) survive re-snapshots.
    const route = normalizePath(page.url());
    const prevByKey = this.lastSnap?.route === route ? this.lastSnap.byKey : null;
    this.refs.clear();
    const keyCounts = new Map<string, number>();
    const elements: SnapshotElement[] = rawElements.map((el) => {
      const baseKey = elementKey(el);
      const count = keyCounts.get(baseKey) ?? 0;
      keyCounts.set(baseKey, count + 1);
      const key = count === 0 ? baseKey : `${baseKey}~${count}`;
      const ref = prevByKey?.get(key)?.ref ?? `e${++this.refCounter}`;
      const full: SnapshotElement = {
        ...el,
        ref,
        key,
        destructive: isDestructive(el.name, el.testid),
      };
      this.refs.set(ref, full);
      return full;
    });
    this.harvestRoutes(elements);
    return { elements, truncated: rawElements.length >= 150 };
  }

  /**
   * Collect the current page and REGISTER it as a visited state, returning the
   * fingerprint and elements. Registration matters: markExercised refuses a key
   * the state never listed (that refusal is what stops invented keys becoming
   * phantom coverage), so a state has to exist before anything in it can be
   * marked. Used by plans to capture where an element lived before acting.
   */
  private async captureCoverageState(): Promise<{ fp: string; elements: SnapshotElement[]; url: string }> {
    const page = this.requirePage();
    const { elements } = await this.collect();
    const url = page.url();
    const fp = fingerprintState(url, elements);
    this.memory?.visitState(
      fp,
      url,
      normalizePath(url),
      elements.map((el) => el.key),
    );
    return { fp, elements, url };
  }

  /**
   * Link harvesting — the generic route discovery. Same-origin hrefs become
   * route classes (including ?tab= screens) that feed the completion contract,
   * so the contract works for any app, not just filesystem-routed Next.
   */
  private harvestRoutes(elements: SnapshotElement[]): void {
    if (!this.memory) return;
    const found: Array<{ route: string; example: string }> = [];
    for (const el of elements) {
      if (!el.href || /^(javascript|mailto|tel):/i.test(el.href)) continue;
      if (el.href.startsWith("#") && !el.href.startsWith("#/")) continue; // in-page anchor, not a hash route
      // Never queue session-ending links for crawling.
      if (/log-?out|sign-?out/i.test(el.href)) continue;
      let abs: URL;
      try {
        abs = new URL(el.href, this.page?.url() ?? this.baseUrl);
      } catch {
        continue;
      }
      if (!this.isSameOrigin(abs.toString())) continue;
      // API endpoints and file downloads are links, not UI routes — crawling
      // them GETs payloads/downloads instead of pages.
      if (/^\/api\//i.test(abs.pathname) || /\.(pdf|zip|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|ico|mp4|webm|json|xml)$/i.test(abs.pathname)) continue;
      found.push({ route: normalizePath(abs.toString()), example: abs.pathname + abs.search + abs.hash });
    }
    if (found.length > 0) this.memory.addDiscoveredRoutes(found);
  }

  /** Every file input on the page. A failed probe is logged, not passed off as "none". */
  private async listFileInputs(page: Page): Promise<FileInputListing[]> {
    try {
      return (await page.evaluate(LIST_FILE_INPUTS_SCRIPT)) as FileInputListing[];
    } catch (err) {
      console.error(`[scenescout] file-input probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * File inputs the collector skipped for being invisible. The dominant upload
   * pattern hides the `<input type=file>` behind a styled button or label, so
   * the affordance was absent from every snapshot and the driver could not
   * know an upload existed — let alone that the page's form would never leave
   * the gap ledger without one. The verdict uses the collector's own rule
   * (shared source, VISIBLE_SRC), so "hidden here" means "not in the element
   * list" — except past the collector's 150-element cap, where a visible input
   * can be unlisted too.
   */
  private async hiddenFileInputs(page: Page): Promise<string[]> {
    return (await this.listFileInputs(page))
      .filter((d) => !d.visible)
      .slice(0, 5)
      .map(fileInputLabel);
  }

  async snapshot(full = false): Promise<string> {
    const page = this.requirePage();
    const memory = this.memory!;
    await this.settle();

    const { elements, truncated } = await this.collect();
    const url = page.url();
    this.snapshotUrl = url;
    const route = normalizePath(url);
    const fp = fingerprintState(url, elements);
    this.currentFingerprint = fp;
    const isNew = memory.visitState(
      fp,
      url,
      route,
      elements.map((el) => el.key),
    );
    memory.recordRoleAccess(this.role, route, "reached");
    this.logAction({ action: "snapshot", url, result: fp });

    const line = (el: SnapshotElement): string => {
      const dup = el.key.match(/~(\d+)$/);
      const flags = [
        el.testid ? `testid=${el.testid}` : null,
        dup ? `copy#${Number(dup[1]) + 1}` : null,
        el.disabled ? "disabled" : null,
        el.destructive ? "DESTRUCTIVE" : null,
        memory.wasExercised(fp, el.key) ? "done" : null,
        el.href ? `href=${el.href.slice(0, 60)}` : null,
      ].filter(Boolean);
      return `${el.ref} ${el.role} "${el.name || "(unnamed)"}"${flags.length ? ` [${flags.join(", ")}]` : ""}`;
    };

    // Diff mode: when re-snapshotting the same route, report only what
    // changed — same idea as UI reconciliation, applied to agent context.
    const prev = this.lastSnap?.route === route ? this.lastSnap : null;
    this.lastSnap = { route, byKey: new Map(elements.map((el) => [el.key, { ref: el.ref, label: el.name, disabled: el.disabled }])) };

    let body: string;
    if (!full && prev) {
      const currentKeys = new Set(elements.map((el) => el.key));
      const added = elements.filter((el) => !prev.byKey.has(el.key));
      const removed = [...prev.byKey.entries()].filter(([key]) => !currentKeys.has(key));
      const relabeled = elements.filter((el) => {
        const old = prev.byKey.get(el.key);
        return old !== undefined && old.label !== el.name;
      });
      // An element can change WITHOUT being added, removed or relabeled: the
      // submit that was greyed out is now clickable. Reporting that as "No
      // element changes" is the diff lying about the single most informative
      // outcome of filling a form — so enable/disable transitions are their
      // own diff line.
      // Independent of the label: a control that goes from disabled "Saving…"
      // to enabled "Save" changed BOTH ways, and reporting only the relabel
      // swallows the enable — the exact fact this line exists to surface.
      const retoggled = elements.filter((el) => {
        const old = prev.byKey.get(el.key);
        return old !== undefined && old.disabled !== el.disabled;
      });
      const changedKeys = new Set([...relabeled, ...retoggled].map((el) => el.key));
      const unchanged = elements.length - added.length - changedKeys.size;
      if (added.length === 0 && removed.length === 0 && relabeled.length === 0 && retoggled.length === 0) {
        body = `No element changes since the last snapshot (${unchanged} interactables, refs unchanged).`;
      } else {
        body =
          `DIFF vs last snapshot (${unchanged} unchanged, refs stable):\n` +
          [
            ...added.map((el) => `+ ${line(el)}`),
            ...removed.map(([key, v]) => `- ${v.ref} "${v.label}" (gone: ${key})`),
            ...relabeled.map((el) => `~ ${el.ref} relabeled → "${el.name}"`),
            ...retoggled.map((el) => `~ ${el.ref} "${el.name}" is now ${el.disabled ? "DISABLED" : "ENABLED"}`),
          ].join("\n");
      }
    } else {
      const missingTestids = elements.filter((el) => !el.testid && !el.disabled).length;
      body =
        `Interactables (${elements.length}${truncated ? "+ — TRUNCATED at 150, dense page" : ""}${missingTestids ? `, ${missingTestids} missing data-testid` : ""}):\n` +
        elements.map(line).join("\n");
    }

    const geometry = geometryIssues(elements, page.viewportSize() ?? { width: 1280, height: 900 });
    geometry.push(...(await this.probeOverlays(page)));
    const hiddenFileInputs = await this.hiddenFileInputs(page);
    const cov = memory.coverage();
    const unvisited = this.unvisitedKnownRoutes();
    const title = await page.title();
    return (
      `URL: ${url}\nTitle: ${title}\nState: ${fp} ${isNew ? "(NEW state)" : "(revisited)"}\n` +
      `Coverage: ${cov.states} states known · ${cov.elementsExercised}/${cov.elementsTotal} elements exercised` +
      (this.allKnownRoutes().length > 0 ? ` · routes ${this.allKnownRoutes().length - unvisited.length}/${this.allKnownRoutes().length} visited` : "") +
      `\n` +
      body +
      (geometry.length > 0 ? `\nGEOMETRY issues:\n` + geometry.map((g) => `  ⚠ ${g}`).join("\n") : "") +
      (hiddenFileInputs.length > 0
        ? `\nFILE INPUTS not listed above (hidden behind a styled control — a user never sees the input itself): ${hiddenFileInputs.join("; ")}. ` +
          `ft_upload {ref} on the control that opens one, or ft_upload {} when it is the page's only file input.`
        : "") +
      formatViolations(this.oracles.drain()) +
      (elements.length === 0 ? "\n⚠ DEAD END: no interactable elements found on this page." : "")
    );
  }

  /**
   * Resolve a ref and re-verify the live element at action time. Refs are
   * trusted only while the page URL exactly matches the snapshot's, and even
   * then the located element's live identity is re-read so the destructive
   * policy applies to what is actually acted on — SPA re-renders can put a
   * different element under a previously-safe XPath.
   */
  private async resolveForAction(ref: string): Promise<{ el: SnapshotElement; liveLabel: string }> {
    this.actionStartedAt = Date.now();
    const page = this.requirePage();
    const el = this.refs.get(ref);
    if (!el) {
      throw new Error(`Unknown ref "${ref}". Refs are only valid from the latest ft_snapshot — take a new snapshot.`);
    }
    if (page.url() !== this.snapshotUrl) {
      this.refs.clear();
      throw new Error(`Page URL changed since the last snapshot (now ${page.url()}). Take a new ft_snapshot.`);
    }
    // String EXPRESSION via page.evaluate (locator.evaluate treats a string as
    // an expression, not a function — the element arg never binds).
    const live = (await page
      .evaluate(
        `(() => { const node = ${xpathLookup(el.xpath)}; if (!node) return null; ` +
          `return { testid: node.getAttribute('data-testid'), label: (node.getAttribute('aria-label') || node.innerText || node.textContent || node.getAttribute('placeholder') || '').trim().slice(0, 120) }; })()`,
      )
      .catch(() => null)) as { testid: string | null; label: string } | null;
    if (!live) {
      throw new Error(`Element ${ref} no longer exists in the DOM — take a new ft_snapshot.`);
    }
    if (el.testid && live.testid !== el.testid) {
      this.refs.clear();
      throw new Error(`Element under ${ref} changed (expected testid=${el.testid}, found ${live.testid ?? "none"}) — the DOM shifted; take a new ft_snapshot.`);
    }
    return { el, liveLabel: live.label };
  }

  private actionPolicyCheck(el: SnapshotElement, liveLabel: string): string | null {
    if (!this.readOnly) return null;
    // Same-origin navigation links are exempt: navigation is non-destructive
    // under the origin fence, and blocking "Reset filters"-style nav links
    // would make whole read-only sections unexplorable.
    if (el.role === "link" && el.href && !/^javascript:/i.test(el.href)) return null;
    // Typing into a text field is never itself destructive (labels like
    // "Type DELETE to confirm" would false-positive) — the destructive risk
    // is submission, which the pressEnter/submit path vets separately. The
    // same holds for choosing a file: selection is not the send.
    if (el.role === "textbox" || el.role === "file") return null;
    if (el.destructive || isDestructive(liveLabel)) {
      return destructiveRefusal(liveLabel || el.name || el.testid || el.ref);
    }
    return null;
  }

  private async afterAction(action: string, target: string): Promise<string> {
    const page = this.requirePage();
    await this.settle();
    let url = page.url();
    if (url !== "about:blank" && !this.isSameOrigin(url)) {
      // A click carried us off the app's origin — bounce back and say so.
      this.logAction({ action, target, url });
      this.logAction({ action: "origin-fence:bounced", target: url.slice(0, 200), url });
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      url = page.url();
      this.refs.clear();
      return (
        `OK: ${action} ${target}\nNavigated off-origin and was bounced back to ${url}. Exploration is fenced to ${this.baseUrl}.` +
        formatViolations(this.oracles.drain())
      );
    }
    this.logAction({ action, target, url });
    const violations = this.oracles.drain();
    const mutations = this.drainMutations() + this.drainBlocked();
    const navigated = this.snapshotUrl !== "" && url !== this.snapshotUrl;
    if (navigated) {
      // Refs point into the previous page's DOM; invalidate so a stale ref
      // errors ("take a new snapshot") instead of acting on the wrong element.
      this.refs.clear();
    }
    return `OK: ${action} ${target}\nURL now: ${url}` + (navigated ? " (page changed — take a new snapshot)" : "") + mutations + formatViolations(violations);
  }

  /** Does this request path address a record this run created? Rules live in ownership.ts. */
  private isOwnedResource(pathname: string): boolean {
    return isOwnedResource(this.ownedIds, pathname);
  }

  /**
   * Register what a successful POST created. The decision — which ids a
   * response genuinely minted — is the pure extractCreatedIds() in
   * ownership.ts; this method only gathers the evidence from the response and
   * records the verdict.
   */
  private async recordCreation(res: import("playwright").Response): Promise<void> {
    let body: unknown;
    if ((res.headers()["content-type"] ?? "").includes("json")) {
      try {
        body = await res.json();
      } catch {
        /* non-JSON or oversized body — the Location header may still cover it */
      }
    }
    const verdict = extractCreatedIds({
      pathname: new URL(res.url()).pathname,
      status: res.status(),
      location: res.headers()["location"],
      body,
      requestBody: res.request().postData() ?? "",
    });
    for (const id of verdict.ids) {
      // Identity/account collections still appear on the cleanup list (the
      // record was genuinely created), but never grant mutation rights.
      if (!verdict.identityCollection) {
        if (!this.ownedIds.has(id)) this.ownedIds.set(id, new Set());
        this.ownedIds.get(id)!.add(verdict.collection);
      }
      const desc = `${verdict.collection} id=${id}`;
      if (!this.createdResources.includes(desc)) {
        this.createdResources.push(desc);
        this.logAction({ action: "created-resource", target: desc, url: this.page?.url() ?? "" });
      }
    }
  }

  /** A late request started before the current action — attribute it honestly. */
  private lateMark(entry: { at: number; sig: string }): string {
    return entry.at < this.actionStartedAt ? `${entry.sig} (late — likely from a previous action)` : entry.sig;
  }

  /** Report (and clear) write-policy blocks since the last action. */
  private drainBlocked(): string {
    this.lastActionBlocked = this.blockedRequests.length;
    if (this.blockedRequests.length === 0) return "";
    const list = this.blockedRequests
      .slice(0, 5)
      .map((e) => this.lateMark(e))
      .join("; ");
    const extra = this.blockedRequests.length > 5 ? ` (+${this.blockedRequests.length - 5} more)` : "";
    this.blockedRequests = [];
    return (
      `\n🛡 WRITE-POLICY blocked (${this.mode}): ${list}${extra}. ` +
      `This is the tester's safety policy, NOT an app bug — do not file a finding for the resulting error UI. ` +
      (this.mode === "read-only"
        ? `Re-attach with mode="safe-write" to test create/edit flows, or "destructive" (user-approved disposable env only).`
        : `In safe-write, updates/deletes are only allowed on resources this session created (${this.createdResources.length} so far).`)
    );
  }

  /** xhr/fetch requests seen this session — lets clicks detect silent no-op submits. */
  private xhrCount = 0;

  private reportedMutationSigs = new Set<string>();

  /** Report (and clear) non-GET requests since the last action — loud in read-only mode, each endpoint once per session. */
  private drainMutations(): string {
    // Raw (pre-dedup) sigs from this action — double-submit detection needs
    // to see the DUPLICATES that the reporting dedup below intentionally hides.
    this.lastActionMutationSigs = this.mutationRequests.map((e) => e.sig);
    const fresh = this.mutationRequests
      .filter((entry) => !this.abortedByPolicy.has(entry.req))
      .filter((entry) => {
        const key = entry.sig.split("?")[0];
        if (this.reportedMutationSigs.has(key)) return false;
        this.reportedMutationSigs.add(key);
        return true;
      });
    this.mutationRequests = [];
    if (fresh.length === 0) return "";
    const list = fresh
      .slice(0, 5)
      .map((e) => this.lateMark(e))
      .join("; ");
    const extra = fresh.length > 5 ? ` (+${fresh.length - 5} more)` : "";
    return this.readOnly
      ? `\n⚠ READ-ONLY notice: this action fired state-changing requests — server state may have mutated despite read-only mode: ${list}${extra}. Consider whether this flow should be avoided or the environment confirmed disposable.`
      : `\n(state-changing requests: ${list}${extra})`;
  }

  /**
   * Click a locator the way a real user's click resolves, not the way
   * Playwright's strict actionability protocol insists on. `.click()` polls
   * until the exact target node is the topmost element receiving pointer
   * events, stable across frames — but a styled control (a `<label>`/`<span>`
   * wrapper forwarding to a visually-hidden `<input>`, an icon layered over a
   * button, a CSS transition that never settles) can make that check spin
   * forever even though a human's click at the same point lands correctly
   * (native hit-testing / label-forwarding resolves it, or the browser just
   * doesn't wait for two stable animation frames). On a timeout, retry once
   * with `force: true`, which skips the hit-test/stability wait but still
   * dispatches the click at the element's real coordinates — matching what a
   * physical click does. The caller is told a fallback was needed so it can
   * still weigh whether the underlying instability is itself worth reporting
   * (e.g. alongside a geometry overlap oracle hit), rather than the tool
   * hard-failing on a control a real user can click fine.
   *
   * The retry is gated on WHY the wait failed, not just that it timed out:
   * `force: true` also skips the "is visible" and "is enabled" checks, so
   * forcing unconditionally would report a genuinely disabled or hidden
   * control as a successful click — the opposite of what this tool exists to
   * catch. Only "intercepts pointer events" (something else is the hit-test
   * target) and "is not stable" (still animating) describe a control a real
   * click resolves fine; "is not visible"/"is not enabled"/"is outside of
   * the viewport" describe a control that is actually unreachable, and those
   * timeouts are left to fail as real failures.
   */
  private async resilientClick(locator: import("playwright").Locator, timeout: number, clicks = 1): Promise<{ forced: boolean }> {
    const clickCount = Math.max(1, Math.min(3, clicks));
    try {
      await locator.click({ timeout, clickCount });
      return { forced: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Timeout/i.test(msg)) throw err;
      const diagnostic = actionabilityDiagnostic(msg);
      if (!diagnostic || !/intercepts pointer events|is not stable/i.test(diagnostic)) throw err;
      // A shorter budget here: the forced click skips the wait that
      // consumed the first `timeout`, so it needs very little of its own.
      await locator.click({ timeout: Math.min(timeout, FORCED_CLICK_TIMEOUT_MS), force: true, clickCount });
      return { forced: true };
    }
  }

  async click(ref: string, clicks = 1): Promise<string> {
    const page = this.requirePage();
    const { el, liveLabel } = await this.resolveForAction(ref);
    const refusal = this.actionPolicyCheck(el, liveLabel);
    if (refusal) {
      this.logAction({ action: "click:refused", target: liveLabel || el.name, url: page.url() });
      return refusal;
    }
    // Submit-shaped clicks that fire zero network requests are a smell
    // (silent no-op forms): capture the count before to compare after.
    const xhrBefore = this.xhrCount;
    const submitLike = el.role === "button" && /submit|send|save|create|apply|subscribe|register|sign|post|add\b/i.test(el.name + " " + (el.testid ?? ""));
    const { forced } = await this.resilientClick(page.locator(`xpath=${el.xpath}`), ACTION_TIMEOUT_MS, clicks);
    this.memory!.markExercised(this.currentFingerprint, el.key, clicks > 1 ? `click×${clicks}` : "click");
    const result = await this.afterAction(clicks > 1 ? `click×${clicks}` : "click", `${el.role} "${el.name}"`);
    // Impatient-user probe: a rapid multi-click that fires the SAME
    // state-changing request more than once means the action is not guarded
    // against double submission (button not disabled during flight, endpoint
    // not idempotent) — a top real-world bug class invisible to polite tests.
    if (clicks > 1) {
      const counts = new Map<string, number>();
      for (const sig of this.lastActionMutationSigs) counts.set(sig, (counts.get(sig) ?? 0) + 1);
      const dup = [...counts.entries()].filter(([, n]) => n > 1);
      if (dup.length > 0) {
        return (
          result +
          `\n⚠ DOUBLE-SUBMIT SIGNAL: ${clicks}× click fired the same state-changing request ${dup[0][1]}× (${dup[0][0]}). ` +
          `The control is not guarded against rapid re-clicks — check for duplicate records, then file (category: data-inconsistency).`
        );
      }
      return result + `\nℹ ${clicks}× rapid click fired no duplicate state-changing requests — double-submit appears guarded on this control.`;
    }
    const forcedNote = forced
      ? `\nℹ NOTE: the strict click timed out waiting for this element to be the stable, unobstructed top hit at its coordinates, so a forced click was used instead (which still landed — this succeeded). Something is likely rendered on top of it (an icon, a decorative layer, an animating wrapper) or it delegates via a label; cross-check against any GEOMETRY overlap on this element before treating that as a real bug.`
      : "";
    if (submitLike && this.xhrCount === xhrBefore && page.url() === this.snapshotUrl) {
      return (
        result +
        `\nℹ NOTE: this submit-style click fired ZERO network requests and no navigation — if the UI showed success, the data may have been silently discarded (worth verifying; category: other/silent-failure).` +
        forcedNote
      );
    }
    return result + forcedNote;
  }

  /**
   * Fill a field the way a real user types: when the field already holds
   * content (a mention chip, a pre-inserted command, a draft), APPEND at the
   * caret end instead of clearing — fill() destroys rich content like
   * @-mention chips that composers insert on menu clicks. A separating space
   * is inserted only at a word-to-word boundary on free-text fields. Returns
   * a note describing what pre-existing content was found (empty string when
   * the field was empty). An empty `text` always clears the field (boundary
   * testing), and reading the existing content is load-bearing: if it fails,
   * the action aborts rather than risk a silent content-destroying replace.
   */
  private async fillOrAppend(locator: import("playwright").Locator, text: string, replace: boolean): Promise<string> {
    let state: { existing: string; caretAppendable: boolean };
    try {
      state = (await locator.evaluate(
        (node) => {
          const n = node as HTMLInputElement & HTMLElement;
          if (n.isContentEditable) return { existing: (n.innerText || n.textContent || "").trim(), caretAppendable: true };
          if (typeof n.value === "string") {
            // selectionStart is null on number/date/email-style inputs — caret
            // placement is unsupported there, so append must go via fill().
            return { existing: n.value, caretAppendable: typeof n.selectionStart === "number" };
          }
          return { existing: "", caretAppendable: false };
        },
        undefined,
        { timeout: ACTION_TIMEOUT_MS },
      )) as { existing: string; caretAppendable: boolean };
    } catch (err) {
      throw new Error(
        `Could not read the field's existing content before typing — aborting rather than risk overwriting it (${err instanceof Error ? err.message.split("\n")[0] : err}). Take a new ft_snapshot and retry.`,
      );
    }
    const { existing, caretAppendable } = state;
    if (replace || !existing || text === "") {
      await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });
      return existing && (replace || text === "") ? ` (replaced existing content ${JSON.stringify(existing.slice(0, 60))})` : "";
    }
    const appendNote = ` (APPENDED after existing content ${JSON.stringify(existing.slice(0, 60))} — pass replace=true to overwrite instead)`;
    if (!caretAppendable) {
      // Data-typed inputs (number, email, date): concatenate without a
      // separator — an injected space would invalidate the value.
      await locator.fill(existing + text, { timeout: ACTION_TIMEOUT_MS });
      return appendNote;
    }
    // Native append: focus, move the caret to the end, insert via the
    // keyboard — preserves rich composer content that fill() would clear.
    // Note: insertText fires input events but not keydown/keyup, so
    // keydown-driven triggers (slash commands, mention menus) will not react.
    await locator.evaluate(
      (node) => {
        const n = node as HTMLInputElement & HTMLElement;
        n.focus();
        if (typeof n.selectionStart === "number" && typeof n.value === "string") {
          n.setSelectionRange(n.value.length, n.value.length);
        } else if (n.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(n);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      },
      undefined,
      { timeout: ACTION_TIMEOUT_MS },
    );
    // Space only at a word-to-word boundary: "@mention " + "hi" needs none,
    // "user@" + "x" must not become "user@ x".
    const separator = /\w$/.test(existing) && /^\w/.test(text) ? " " : "";
    await this.requirePage().keyboard.insertText(separator + text);
    return appendNote;
  }

  async type(ref: string, text: string, pressEnter = false, replace = false): Promise<string> {
    const page = this.requirePage();
    const { el, liveLabel } = await this.resolveForAction(ref);
    if (el.role === "file") {
      // fill() refuses a file input — and it used to refuse with a stack
      // trace, leaving every upload form stranded. Point at the tool that can.
      return (
        `${ref} is a file input ("${el.name || el.testid || "unnamed"}") — text cannot be typed into it. ` +
        `Use ft_upload {ref:"${ref}"}: a small valid fixture is generated and matched to the input's accept attribute, or pass fixture / filePath.`
      );
    }
    const refusal = this.actionPolicyCheck(el, liveLabel);
    if (refusal) return refusal;
    const locator = page.locator(`xpath=${el.xpath}`);
    const fillNote = await this.fillOrAppend(locator, text, replace);
    if (pressEnter) {
      // Enter inside a form submits it — check the form's submit target, or
      // pressEnter becomes a read-only bypass for destructive submits.
      if (this.readOnly) {
        const submitLabel = (await page
          .evaluate(
            `(() => { const node = ${xpathLookup(el.xpath)}; if (!node) return ''; ` +
              `const f = node.form || node.closest('form'); if (!f) return ''; ` +
              `const s = f.querySelector('[type="submit"], button:not([type="button"]):not([type="reset"])'); ` +
              `return s ? (s.getAttribute('aria-label') || s.innerText || s.getAttribute('data-testid') || '').trim().slice(0, 120) : ''; })()`,
          )
          .catch(() => "")) as string;
        if (isDestructive(submitLabel)) {
          this.logAction({ action: "type:enter-refused", target: submitLabel, url: page.url() });
          return `Filled ${el.role} "${el.name}" but did NOT press Enter. ` + destructiveRefusal(submitLabel);
        }
      }
      await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
    }
    this.memory!.markExercised(this.currentFingerprint, el.key, "type");
    return this.afterAction("type", `${el.role} "${el.name}" ← ${JSON.stringify(text.slice(0, 60))}${pressEnter ? " + Enter" : ""}${fillNote}`);
  }

  /**
   * Attach a file to an upload control the way a user does. `ref` may be the
   * file input itself or the styled button/label/dropzone that opens the file
   * chooser — the chooser is intercepted and answered, which is how the hidden
   * input behind a "Choose file" control is reached. With no `ref`, the page's
   * only file input is used, hidden or not. The file is a generated in-memory
   * fixture unless `filePath` names one inside the attached project.
   */
  async upload(opts: UploadOptions): Promise<string> {
    this.actionStartedAt = Date.now();
    const page = this.requirePage();
    let el: SnapshotElement | null = null;
    let locator: Locator | null = null;
    if (opts.ref) {
      const resolved = await this.resolveForAction(opts.ref);
      el = resolved.el;
      const refusal = this.actionPolicyCheck(el, resolved.liveLabel);
      if (refusal) return refusal;
      locator = page.locator(`xpath=${el.xpath}`);
    }
    const outcome = await this.performUpload(locator, opts);
    if (outcome.refused) return outcome.refused;
    if (el) this.memory!.markExercised(this.currentFingerprint, el.key, "upload");
    const after = await this.afterAction("upload", outcome.summary);
    // Whether the app sends on selection or on submit decides the driver's
    // next move. Counted from the request log, not read back out of the text
    // above: drainMutations() reports each endpoint once per session, so a
    // repeat upload prints nothing there, and a write-policy block prints
    // something else entirely. Only requests recorded AFTER the file was set
    // count — the trigger click's own traffic is not the upload.
    const firedOnSelect = this.lastActionMutationSigs.length > outcome.mutationsBefore || this.lastActionBlocked > outcome.blockedBefore;
    return (
      after +
      outcome.notes +
      (firedOnSelect
        ? "\nThe app sent a request on selection — see the state-changing (or blocked) requests above."
        : "\nNo state-changing request fired on selection: either the form sends on submit (click it next) or the app rejected the file client-side — the next snapshot shows which.")
    );
  }

  /**
   * Shared by ft_upload and plan `upload` steps: pick where the file goes,
   * resolve what to send, set it, and describe what happened. Refusals come
   * back as text, not throws — a path outside the fence or an ambiguous page
   * is an answer the driver acts on, not an engine failure.
   */
  private async performUpload(locator: Locator | null, opts: Omit<UploadOptions, "ref">): Promise<UploadOutcome> {
    const refuse = (refused: string): UploadOutcome => ({ refused, summary: "", notes: "", mutationsBefore: 0, blockedBefore: 0 });
    if (opts.filePath && opts.fixture) return refuse("Pass filePath OR fixture, not both — one names a real file, the other generates one.");
    // A disk file is validated BEFORE the page is touched: a refusal must not
    // have already clicked the trigger (state-changing in safe-write) and left
    // an intercepted chooser unanswered. Only fixture inference needs the
    // input's accept attribute, so only that waits for the target.
    const disk = opts.filePath ? this.resolveDiskUpload(opts.filePath, opts.name) : null;
    if (disk && "refused" in disk) return refuse(disk.refused);

    const target = await this.pickUploadTarget(locator);
    if ("refused" in target) return refuse(target.refused);
    const { input, chooser, how } = target;

    const meta: FileInputMeta = await (
      input ? input.evaluate(describeFileInput, undefined, { timeout: ACTION_TIMEOUT_MS }) : chooser!.element().evaluate(describeFileInput)
    ).catch(() => ({ accept: null, multiple: false, label: "", disabled: false, probed: false }));
    // setInputFiles never checks `disabled` — it would report success on a
    // control no user can operate.
    if (meta.disabled) {
      return refuse(
        `The file input${meta.label ? ` "${meta.label}"` : ""} is disabled — a user cannot choose a file here. If it should be enabled in this state, that is a finding.`,
      );
    }

    const file = disk ?? generatedPayload(meta, opts);

    const mutationsBefore = this.mutationRequests.length;
    const blockedBefore = this.blockedRequests.length;
    if (chooser) await chooser.setFiles(file.payload, { timeout: ACTION_TIMEOUT_MS });
    else await input!.setInputFiles(file.payload, { timeout: ACTION_TIMEOUT_MS });
    // The set call succeeding means the browser took the payload — not that
    // the app kept it. Read the input back: an app that rejects client-side
    // clears it, and then nothing would ever be sent on submit.
    const kept = await (
      input
        ? input.evaluate((node) => (node as HTMLInputElement).files?.length ?? 0, undefined, { timeout: ACTION_TIMEOUT_MS })
        : chooser!.element().evaluate((node) => (node as HTMLInputElement).files?.length ?? 0)
    ).catch(() => -1);

    const inputDesc = [
      meta.label ? `"${meta.label}"` : null,
      meta.probed ? (meta.accept ? `accept=${meta.accept}` : null) : "accept unknown — the input could not be inspected",
      meta.multiple ? "multiple" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const summary = `${how}${inputDesc ? ` (${inputDesc})` : ""} ← ${file.name} (${file.bytes} bytes, ${file.mime}; ${file.source})`;
    let notes = "";
    if (acceptMatches(meta.accept, file.name, file.mime) === false) {
      notes += `\n⚠ "${file.name}" does NOT match the input's accept="${meta.accept}". A correct app rejects it (picker filter, client validation, or server); if it was accepted, that is a validation gap — file it.`;
    }
    if (kept === 0) {
      notes += `\n⚠ After selection the input reports NO file — the app cleared it (client-side rejection, or a re-render that reset the field). Nothing will be sent on submit.`;
    } else if (kept < 0) {
      notes += ` (post-selection state of the input could not be re-read)`;
    }
    return { summary, notes, mutationsBefore, blockedBefore };
  }

  /** Where the file goes: the input itself, the chooser a control opens, or the page's only file input. */
  private async pickUploadTarget(locator: Locator | null): Promise<{ refused: string } | { input: Locator | null; chooser: FileChooser | null; how: string }> {
    const page = this.requirePage();
    const fileInputs = page.locator('input[type="file"]');
    const listAll = async (): Promise<string> => (await this.listFileInputs(page)).map(fileInputLabel).join("; ");
    if (!locator) {
      const n = await fileInputs.count();
      if (n === 0) return { refused: "No file input on this page. If the upload sits behind a button or dropzone, pass its ref." };
      if (n > 1) return { refused: `${n} file inputs on this page (${await listAll()}) — pass the ref of the one you mean, or of the control that opens it.` };
      return { input: fileInputs.first(), chooser: null, how: "set on the page's only file input" };
    }
    const isFileInput = await locator
      .evaluate((node) => node instanceof HTMLInputElement && node.type === "file", undefined, { timeout: ACTION_TIMEOUT_MS })
      .catch(() => false);
    if (isFileInput) return { input: locator, chooser: null, how: "set directly on the file input" };
    // A styled control: click it and answer the chooser it opens. The listener
    // is armed BEFORE the click (the event fires during it) with a budget that
    // outlasts the click's own — forced retry included — plus a grace period
    // after it, for apps that fetch an upload URL before opening the picker. A
    // wait shorter than the click reported such controls as "uploads nothing".
    const opened = page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS + FORCED_CLICK_TIMEOUT_MS + CHOOSER_GRACE_MS }).catch(() => null);
    await this.resilientClick(locator, ACTION_TIMEOUT_MS);
    const chooser = await Promise.race([opened, page.waitForTimeout(CHOOSER_GRACE_MS).then(() => null)]);
    if (chooser) return { input: null, chooser, how: "via the file chooser the click opened" };
    const n = await fileInputs.count();
    if (n === 1)
      return { input: fileInputs.first(), chooser: null, how: "the click opened no file chooser, so the file was set on the page's only file input" };
    if (n === 0) return { refused: "The click opened no file chooser and the page has no file input — this control does not upload anything." };
    return {
      refused: `The click opened no file chooser and the page has ${n} file inputs (${await listAll()}) — pass the ref of the file input, or of the control that opens the one you want.`,
    };
  }

  /** A real file to upload, inside the project fence — nothing here touches the page. */
  private resolveDiskUpload(filePath: string, name?: string): { refused: string } | ResolvedUpload {
    if (!this.projectDir) return { refused: "Not attached — uploads need a session with a project." };
    const resolved = path.resolve(this.projectDir, filePath);
    // realpath, so a symlink inside the project cannot point the upload at a
    // file outside it. A missing path stays as resolved and is reported below.
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      /* missing — the stat below says so */
    }
    const rel = path.relative(this.projectDir, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        refused:
          `REFUSED: filePath ${filePath} is outside the attached project (${this.projectDir})${this.projectDirNote}. Uploads are fenced to the project under test, ` +
          `as navigation is fenced to its origin — copy the fixture into the project (e.g. .scenescout/fixtures/) or omit filePath to upload a generated one.`,
      };
    }
    const stat = fs.statSync(real, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      return {
        refused: `filePath not found (or not a file): ${real}. To upload a generated file instead, omit filePath (or pass fixture: ${FIXTURE_KINDS.join(" | ")}).`,
      };
    }
    const finalName = name ?? path.basename(real);
    const mime = mimeForName(finalName);
    if (!name) return { payload: real, name: finalName, mime, bytes: stat.size, source: `from disk: ${rel}` };
    // A renamed upload has to travel as an in-memory payload.
    if (stat.size > MAX_RENAMED_UPLOAD_BYTES) {
      return { refused: `Renaming an upload reads it into memory; ${real} is ${stat.size} bytes — pass it without name, or use a smaller file.` };
    }
    return {
      payload: { name: finalName, mimeType: mime, buffer: fs.readFileSync(real) },
      name: finalName,
      mime,
      bytes: stat.size,
      source: `from disk: ${rel}, as ${finalName}`,
    };
  }

  /** Selector for transient hover-revealed surfaces (tooltips, poppers, hover cards). */
  private static readonly OVERLAY_SELECTOR =
    '[role="tooltip"], [data-tippy-root], [data-radix-popper-content-wrapper], [data-floating-ui-portal], ' +
    '[data-slot*="tooltip" i], [data-slot*="popover" i], ' +
    '[class*="tooltip" i], [class*="hovercard" i], [class*="popover" i]';

  /**
   * Visible overlay texts right now — diffed before/after a hover to isolate
   * what the hover revealed. Returns null when the read itself failed, so a
   * failed baseline is never mistaken for "no overlays were open".
   */
  private async collectOverlayTexts(): Promise<string[] | null> {
    const page = this.requirePage();
    return (await page
      .evaluate(
        `(() => Array.from(document.querySelectorAll(${JSON.stringify(BrowserEngine.OVERLAY_SELECTOR)}))
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((el) => (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300))
          .filter(Boolean))()`,
      )
      .catch(() => null)) as string[] | null;
  }

  /**
   * Shared reveal detection used by ft_hover and plan hover steps. Takes the
   * pre-hover baselines, polls the overlay selector across the reveal window
   * (tooltips are delay-gated — component libraries commonly warm up for as
   * long as 1500ms), and falls back to a visible-text diff for tooltips built
   * from arbitrary markup. A baseline that failed to read (null) disables its
   * detection path rather than fabricating an empty comparison. The text-diff
   * fallback is skipped on churning pages (content that was already changing
   * on its own) so unrelated live updates are not attributed to the hover.
   */
  private async detectHoverReveal(
    before: string[] | null,
    bodyBefore: string | null,
    churning: boolean,
  ): Promise<{ revealed: string[]; fallbackUsed: boolean }> {
    const page = this.requirePage();
    let revealed: string[] = [];
    if (before !== null) {
      for (let waited = 0; waited < HOVER_REVEAL_WINDOW_MS; waited += 250) {
        await page.waitForTimeout(250);
        const after = await this.collectOverlayTexts();
        if (after === null) break;
        revealed = after.filter((t) => !before.includes(t));
        if (revealed.length > 0) return { revealed, fallbackUsed: false };
      }
    } else {
      await page.waitForTimeout(HOVER_REVEAL_WINDOW_MS);
    }
    if (bodyBefore === null || churning) return { revealed: [], fallbackUsed: false };
    const bodyAfter = (await page.evaluate(`document.body ? document.body.innerText : ""`).catch(() => null)) as string | null;
    if (bodyAfter === null) return { revealed: [], fallbackUsed: false };
    const beforeLines = new Set(
      bodyBefore
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    revealed = bodyAfter
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !beforeLines.has(l))
      .slice(0, 5)
      .map((l) => l.slice(0, 300));
    return { revealed, fallbackUsed: revealed.length > 0 };
  }

  /** Pre-hover baselines: overlay texts, body text, and whether the page is already churning on its own. */
  private async hoverBaselines(): Promise<{ before: string[] | null; bodyBefore: string | null; churning: boolean }> {
    const page = this.requirePage();
    const before = await this.collectOverlayTexts();
    const body1 = (await page.evaluate(`document.body ? document.body.innerText : ""`).catch(() => null)) as string | null;
    await page.waitForTimeout(300);
    const body2 = (await page.evaluate(`document.body ? document.body.innerText : ""`).catch(() => null)) as string | null;
    return { before, bodyBefore: body2, churning: body1 === null || body2 === null || body1 !== body2 };
  }

  /**
   * Hover an element like a real user pausing the pointer on it, then report
   * what appeared: tooltip/popover overlays (diffed against pre-hover state),
   * any other new page text, the title attribute, and aria-describedby text.
   * Hover-gated UI (error badges, truncated-text tooltips, row action
   * reveals) is invisible to snapshots and clicks — this is the only way to
   * see it. Hovering does NOT mark the element as exercised: a hover is a
   * look, not an interaction, and the element still deserves a click.
   */
  async hover(ref: string): Promise<string> {
    const page = this.requirePage();
    const { el } = await this.resolveForAction(ref);
    const { before, bodyBefore, churning } = await this.hoverBaselines();
    const locator = page.locator(`xpath=${el.xpath}`);
    await locator.hover({ timeout: ACTION_TIMEOUT_MS });
    // Wiggle inside the element: pointer-tracking libraries distinguish real
    // movement from a single synthetic hover event.
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 1);
      await page.mouse.move(box.x + box.width / 2 - 2, box.y + box.height / 2 - 1);
    }
    const { revealed, fallbackUsed } = await this.detectHoverReveal(before, bodyBefore, churning);
    const attrTexts = (await page
      .evaluate(
        `(() => { const node = ${xpathLookup(el.xpath)}; if (!node) return []; const out = []; ` +
          `const t = node.getAttribute('title'); if (t) out.push('title: ' + t.slice(0, 300)); ` +
          `const d = node.getAttribute('aria-describedby'); if (d) { for (const id of d.split(/\\s+/)) { ` +
          `const refEl = document.getElementById(id); const txt = refEl ? (refEl.innerText || refEl.textContent || '').trim() : ''; ` +
          `if (txt) out.push(txt.replace(/\\s+/g, ' ').slice(0, 300)); } } return out; })()`,
      )
      .catch(() => [])) as string[];
    const result = await this.afterAction("hover", `${el.role} "${el.name}"`);
    const notes = [...new Set([...revealed, ...attrTexts])];
    const caveat = fallbackUsed ? "\n  (from page-text diff — may include unrelated page activity)" : "";
    return (
      result +
      (notes.length > 0
        ? `\nRevealed on hover:\n${notes.map((t) => `  · ${t}`).join("\n")}${caveat}`
        : `\n(no tooltip, overlay, or new page text appeared within ${HOVER_REVEAL_WINDOW_MS / 1000}s — this element reveals nothing on hover${churning ? "; page content was changing on its own, so the text-diff fallback was suppressed" : ""}${this.headed ? ". NOTE: in headed mode the PHYSICAL mouse cursor competes with the synthetic pointer — if it is resting over the browser window, hover warm-ups are cancelled; ask the user to move it off the window and retry" : ""})`)
    );
  }

  async select(ref: string, value: string): Promise<string> {
    const page = this.requirePage();
    const { el, liveLabel } = await this.resolveForAction(ref);
    const refusal = this.actionPolicyCheck(el, liveLabel);
    if (refusal) return refusal;
    if (this.readOnly) {
      // Bulk-action dropdowns fire on change — vet the chosen option itself.
      const optionLabel = (await page
        .evaluate(
          `(() => { const node = ${xpathLookup(el.xpath)}; if (!node) return ''; const v = ${JSON.stringify(value)}; ` +
            `const opts = Array.from(node.options || []); ` +
            `const o = opts.find(o => o.value === v || o.label === v || (o.textContent || '').trim() === v); ` +
            `return o ? (o.label || o.textContent || '').trim().slice(0, 120) : ''; })()`,
        )
        .catch(() => "")) as string;
      if (isDestructive(value) || isDestructive(optionLabel)) {
        this.logAction({ action: "select:refused", target: optionLabel || value, url: page.url() });
        return destructiveRefusal(optionLabel || value);
      }
    }
    await page.locator(`xpath=${el.xpath}`).selectOption(value, { timeout: ACTION_TIMEOUT_MS });
    this.memory!.markExercised(this.currentFingerprint, el.key, "select");
    return this.afterAction("select", `${el.role} "${el.name}" = ${value}`);
  }

  /**
   * Enter/Space activate the focused element — apply the same destructive
   * policy as click, or the keyboard becomes a read-only bypass. Shared by
   * ft_press and plan press steps; returns a refusal message or null.
   */
  private async vetFocusedActivation(key: string): Promise<string | null> {
    if (!(this.readOnly && /^(Enter|NumpadEnter|Space| )$/i.test(key))) return null;
    const page = this.requirePage();
    const focusedLabel = await page
      .evaluate(
        `(() => { const el = document.activeElement; if (!el) return ""; ` +
          `return (el.getAttribute("aria-label") || el.getAttribute("data-testid") || el.innerText || el.textContent || "").trim().slice(0, 120); })()`,
      )
      .catch(() => "");
    if (typeof focusedLabel === "string" && isDestructive(focusedLabel)) {
      this.logAction({ action: "press:refused", target: focusedLabel, url: page.url() });
      return destructiveRefusal(focusedLabel);
    }
    return null;
  }

  /**
   * Keys that ACT on the focused control rather than just moving between
   * controls. Activating a button with Enter is the same interaction as
   * clicking it, and the `extensive` contract explicitly asks for a
   * keyboard-only pass — so a run driven entirely from the keyboard used to
   * record zero coverage and could never satisfy the gate it was told to meet.
   * Tab and Escape stay out: traversal and dismissal are not interactions with
   * the element under focus.
   *
   * Deliberately IDENTICAL to the set `vetFocusedActivation` guards. Arrow keys
   * genuinely act on selects and radio groups, but the vet does not screen
   * them, so counting them here would have let the keyboard record coverage on
   * a path that skips the destructive-label check — a read-only bypass. The two
   * lists must be changed together.
   */
  private static readonly ACTIVATION_KEY_RE = /^(Enter|NumpadEnter|Space| )$/i;

  async press(key: string): Promise<string> {
    this.actionStartedAt = Date.now();
    const page = this.requirePage();
    const refusal = await this.vetFocusedActivation(key);
    if (refusal) return refusal;
    // Identify the focused control BEFORE the key lands — activating it may
    // navigate, close a dialog, or otherwise destroy the element.
    const focused = BrowserEngine.ACTIVATION_KEY_RE.test(key) ? await this.focusedInteractable() : null;
    await page.keyboard.press(key);
    if (focused && this.memory && this.currentFingerprint) {
      this.memory.markExercised(this.currentFingerprint, focused, `press:${key}`);
    }
    return this.afterAction("press", key);
  }

  /**
   * The focused element's coverage key, taken FROM THE SNAPSHOT.
   *
   * Deliberately not re-derived from the DOM. Computing role and name here
   * independently looked equivalent and was not: the collector resolves a
   * checkbox to role `checkbox` and names an input from its `label[for]`,
   * while a second implementation drifts to `textbox` and an empty name. Since
   * markExercised CREATES an unknown key rather than rejecting it, every
   * divergence minted a phantom exercised element — inflating coverage while
   * the control the user actually pressed stayed an open gap. Matching the
   * live element against the snapshot's own xpaths means the key is, by
   * construction, one the snapshot produced.
   *
   * Returns null when focus is on nothing, on an element this snapshot never
   * listed, or when the page cannot be evaluated — no coverage is better than
   * coverage attributed to the wrong control.
   */
  private async focusedInteractable(): Promise<string | null> {
    if (this.refs.size === 0) return null;
    const known = [...this.refs.values()].map((el) => el.xpath);
    const idx = (await this.requirePage()
      .evaluate(
        `((paths) => { const el = document.activeElement;` +
          ` if (!el || el === document.body) return -1;` +
          ` for (let i = 0; i < paths.length; i++) {` +
          `   const r = document.evaluate(paths[i], document, null, 9, null);` +
          `   if (r && r.singleNodeValue === el) return i;` +
          ` }` +
          ` return -1; })`,
        known,
      )
      .catch(() => -1)) as number;
    if (typeof idx !== "number" || idx < 0) return null;
    return [...this.refs.values()][idx]?.key ?? null;
  }

  /** Origin fence: exploration stays on the attached app's origin. */
  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  async navigate(target: string): Promise<string> {
    this.actionStartedAt = Date.now();
    const page = this.requirePage();
    const url = target.startsWith("http") ? target : `${this.baseUrl}${target.startsWith("/") ? "" : "/"}${target}`;
    if (!this.isSameOrigin(url)) {
      return `REFUSED: ${url} is outside the attached origin (${this.baseUrl}). Exploration is fenced to the app under test.`;
    }
    // A notice describes ONE navigation. Clearing up front means a notice left
    // undelivered by a previous throw can never prepend itself to this result.
    this.authLoss.clear();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Settle BEFORE judging where we landed. A client-side auth guard redirects
    // after hydration, not during goto, so reading page.url() here showed the
    // requested path and the bounce went unnoticed — which is precisely how a
    // dead session stayed invisible in a single-page app.
    //
    // The bookkeeping runs in a `finally` so a throw during settling — a closed
    // page, a torn-down execution context — still records the attempt. And if
    // it did throw, the notice is attached to the ERROR rather than dropped:
    // returning a bare exception for the one call that detected the auth loss
    // is how the whole failure mode stayed invisible in the first place.
    let settled = "";
    try {
      settled = await this.afterAction("navigate", url);
    } catch (err) {
      this.recordNavigationOutcome(url, page.url());
      const notice = this.authLoss.take();
      if (!notice) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${notice}${msg}`);
    }
    this.recordNavigationOutcome(url, page.url());
    return this.authLoss.take() + settled;
  }

  /** Where did we ASK to go, where did we END UP, and does that count as coverage? */
  private recordNavigationOutcome(requestedUrl: string, landedUrl: string): void {
    const requestedRoute = normalizePath(requestedUrl);
    const landedRoute = normalizePath(landedUrl);
    const bounced = this.authLoss.isLoginRedirect(requestedRoute, landedUrl, this.baseUrl);
    if (landedRoute !== requestedRoute) {
      const outcome = bounced ? `${AUTH_LOSS_PREFIX}${landedRoute}` : `landed:${landedRoute}`;
      this.memory?.markAttempted(requestedRoute, outcome, this.role);
      this.memory?.recordRoleAccess(this.role, requestedRoute, outcome);
    }
    this.authLoss.record({ requestedRoute, landedRoute, bounced, role: this.role });
  }

  async goBack(): Promise<string> {
    this.actionStartedAt = Date.now();
    const page = this.requirePage();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    return this.afterAction("back", "");
  }

  /** The full route contract: scanned filesystem routes ∪ link-discovered route classes. */
  allKnownRoutes(): string[] {
    const discovered = this.memory ? Object.keys(this.memory.discoveredRoutes) : [];
    return [...new Set([...this.knownRoutes, ...discovered])].filter((r) => !isNonPageRoute(r));
  }

  /**
   * Contract routes neither visited nor attempted by THIS role.
   *
   * A permission redirect satisfies the contract — an operator who cannot reach
   * an admin route must not block the run forever. Two things it deliberately
   * does NOT satisfy it with:
   *  - another role's redirect. Attempts are role-scoped, so the operator
   *    bouncing off an admin route no longer erases that route from the
   *    admin's ledger.
   *  - an auth-loss bounce (`authloss:`), filtered out in attemptedByRole. A
   *    dead token used to certify every route the run had not reached yet.
   *
   * Visited/attempted keys are stored NORMALIZED, so the normalized form of
   * each known route is compared too — normalizePath is idempotent, so this
   * only adds matches for routes that genuinely were reached.
   */
  unvisitedKnownRoutes(): string[] {
    if (!this.memory) return [];
    const all = this.allKnownRoutes();
    if (all.length === 0) return [];
    const visited = new Set(Object.values(this.memory.states).map((s) => s.route));
    const attempted = this.memory.attemptedByRole(this.role);
    return all.filter((r) => {
      const n = normalizePath(r);
      return !visited.has(r) && !(r in attempted) && !visited.has(n) && !(n in attempted);
    });
  }

  /** Map a route class to something goto-able (discovered classes carry a concrete example). */
  private navigablePath(routeClass: string): string {
    return this.memory?.discoveredRoutes[routeClass] ?? routeClass;
  }

  /**
   * Engine-side route sweep: visit each path, record the state in memory, and
   * collect per-route health — one tool call instead of one LLM turn per route.
   * Output is anomaly-oriented: a summary line per route, details only where
   * something is wrong. Navigation-only, so it is safe in read-only mode.
   */
  async crawl(paths?: string[]): Promise<string> {
    const page = this.requirePage();
    const memory = this.memory!;
    const targets = (paths && paths.length > 0 ? paths : this.unvisitedKnownRoutes().map((r) => this.navigablePath(r))).slice(0, 150);
    if (targets.length === 0) {
      return this.allKnownRoutes().length > 0
        ? "Nothing to crawl: every known route has been visited. Use ft_coverage for remaining unexercised elements."
        : "No routes to crawl yet: no scanned or link-discovered routes. Take a snapshot first (links harvest routes) or pass explicit paths.";
    }

    const summary: string[] = [];
    const problems: string[] = [];
    for (const path of targets) {
      const url = `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
      if (!this.isSameOrigin(url)) {
        summary.push(`${path} — SKIPPED (off-origin)`);
        continue;
      }
      this.actionStartedAt = Date.now();
      this.oracles.drain(false); // discard pre-route leftovers WITHOUT marking their signatures as reported
      let status: number | string = "ERR";
      try {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        status = resp?.status() ?? "no-response";
      } catch (err) {
        summary.push(`${path} — LOAD FAILED`);
        problems.push(`${path}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
        continue;
      }
      await this.settle();
      const { elements } = await this.collect();
      const finalUrl = page.url();
      const route = normalizePath(finalUrl);
      const fp = fingerprintState(finalUrl, elements);
      memory.visitState(
        fp,
        finalUrl,
        route,
        elements.map((el) => el.key),
      );
      memory.recordRoleAccess(this.role, route, "reached");
      // If we landed somewhere else (auth wall, canonical redirect), the
      // REQUESTED route still counts as covered for THIS role — a role that
      // can't see /admin must not block the completion contract forever. An
      // auth-loss bounce is recorded under a prefix that does NOT count.
      const requestedRoute = normalizePath(url);
      const loginRedirect = this.authLoss.isLoginRedirect(path, finalUrl, this.baseUrl);
      if (route !== requestedRoute) {
        const outcome = loginRedirect ? `${AUTH_LOSS_PREFIX}${route}` : `landed:${route}`;
        memory.markAttempted(requestedRoute, outcome, this.role);
        memory.recordRoleAccess(this.role, requestedRoute, outcome);
      }
      // Feeds the streak. The per-route notice is discarded — crawl already
      // flags AUTH-REDIRECT per route in its own summary, and the verdict for
      // the sweep as a whole is emitted once at the end via batchVerdict().
      this.authLoss.record({ requestedRoute, landedRoute: route, bounced: loginRedirect, role: this.role });
      this.authLoss.clear();
      // Error-status routes render but would otherwise be re-crawled forever —
      // an attempt with the status satisfies the contract.
      if (typeof status === "number" && status >= 400) memory.markAttempted(requestedRoute, `status:${status}`, this.role);
      this.logAction({ action: "crawl", target: path, url: finalUrl });

      const violations = this.oracles.drain();
      const deadEnd = elements.length === 0;
      const unnamed = elements.filter((el) => !el.name).length;
      const missingTestid = elements.filter((el) => !el.testid && !el.disabled).length;

      const flags = [loginRedirect ? "AUTH-REDIRECT" : null, deadEnd ? "DEAD-END" : null, violations.length > 0 ? `${violations.length}⚠` : null].filter(
        Boolean,
      );
      summary.push(
        `${path} — ${status} · ${elements.length} el` +
          (missingTestid ? ` · ${missingTestid} no-testid` : "") +
          (unnamed ? ` · ${unnamed} unnamed` : "") +
          (flags.length ? ` · ${flags.join(" ")}` : ""),
      );
      if (violations.length > 0 || deadEnd || loginRedirect || (typeof status === "number" && status >= 400)) {
        const detail = violations
          .slice(0, 3)
          .map((v) => `    ${v.kind}: ${v.detail.slice(0, 160)}`)
          .join("\n");
        problems.push(
          `${path}${loginRedirect ? " → redirected to login (auth missing/expired?)" : ""}${deadEnd ? " → dead end" : ""}${detail ? `\n${detail}` : ""}`,
        );
      }
    }
    // Crawl leaves the page wherever it ended — refs from before are gone.
    this.refs.clear();
    this.lastSnap = null;
    this.snapshotUrl = "";

    const unvisited = this.unvisitedKnownRoutes();
    return (
      // Crawl is the bulk navigator and the place a mid-run token death shows
      // up first — a 150-route sweep against dead credentials. Emitting the
      // banner only from navigate() left exactly that case silent until someone
      // happened to call ft_navigate afterwards.
      this.authLoss.batchVerdict() +
      `CRAWL of ${targets.length} route(s):\n` +
      summary.join("\n") +
      (problems.length > 0 ? `\n\nPROBLEM ROUTES (${problems.length}):\n` + problems.join("\n") : "\n\nAll crawled routes healthy.") +
      (this.allKnownRoutes().length > 0
        ? `\n\nRoutes visited: ${this.allKnownRoutes().length - unvisited.length}/${this.allKnownRoutes().length}${unvisited.length > 0 ? ` — still unvisited: ${unvisited.slice(0, 20).join(", ")}${unvisited.length > 20 ? " …" : ""}` : ""}`
        : "") +
      `\nTake ft_snapshot to inspect the current page, or navigate into a problem route.`
    );
  }

  /**
   * Execute a batch of actions in one call — targets resolve at execution
   * time by semantic locator (testid= / text= / label=), never by snapshot
   * ref, so the plan is immune to DOM drift. Aborts on the first oracle
   * violation or policy refusal so the driver re-enters at the interesting moment.
   */
  async runPlan(
    steps: Array<{
      action: "navigate" | "click" | "type" | "select" | "press" | "hover" | "scroll" | "upload";
      target?: string;
      value?: string;
      pressEnter?: boolean;
      replace?: boolean;
    }>,
  ): Promise<string> {
    const page = this.requirePage();
    const transcript: string[] = [];
    const resolveTarget = (target: string) => {
      if (target.startsWith("testid=")) return page.locator(`[data-testid=${JSON.stringify(target.slice(7))}]`).first();
      if (target.startsWith("text=")) return page.getByText(target.slice(5), { exact: false }).first();
      if (target.startsWith("label=")) return page.getByLabel(target.slice(6)).first();
      throw new Error(`Plan targets must be "testid=…", "text=…", or "label=…" (got: ${target})`);
    };
    /** Last state captured this plan — reused as the next step's pre-state while the page has not moved. */
    let lastCapture: { fp: string; elements: SnapshotElement[]; url: string } | null = null;
    const liveLabel = async (loc: ReturnType<typeof resolveTarget>): Promise<string> => {
      const [aria, testid, txt] = await Promise.all([
        loc.getAttribute("aria-label").catch(() => null),
        loc.getAttribute("data-testid").catch(() => null),
        loc.textContent({ timeout: 1000 }).catch(() => null),
      ]);
      return (aria ?? txt ?? testid ?? "").trim().slice(0, 120);
    };

    for (const [i, step] of steps.slice(0, 20).entries()) {
      this.actionStartedAt = Date.now();
      const desc = `${i + 1}. ${step.action} ${step.target ?? step.value ?? ""}`;
      // Identity captured BEFORE the action — buttons that relabel themselves
      // (Add to Cart → View Cart) are unmatchable in the post-action DOM.
      let preTestid: string | null = null;
      let preLabel = "";
      let forcedClick = false;
      let preState: { fp: string; elements: SnapshotElement[]; url: string } | null = null;
      try {
        if (step.action === "navigate") {
          const result = await this.navigate(step.target ?? step.value ?? "/");
          if (result.startsWith("REFUSED")) {
            transcript.push(`${desc} → ${result}`);
            break;
          }
        } else if (step.action === "scroll") {
          // performScroll, not this.scroll(): the shared drain below must
          // still see scroll-triggered oracle violations (afterAction would
          // consume them), and plans inherit the same native-user refusals.
          const v = (step.value ?? step.target ?? "bottom").trim();
          const edge = v === "top" || v === "bottom" ? (v as "top" | "bottom") : undefined;
          const r = await this.performScroll(edge, edge ? undefined : Number.parseInt(v, 10) || 600);
          if (r.refused) {
            transcript.push(`${desc} → ${r.refused}`);
            break;
          }
          if (r.note) transcript.push(`  ${r.note.trim()}`);
        } else if (step.action === "press") {
          const key = step.value ?? step.target ?? "Enter";
          const refusal = await this.vetFocusedActivation(key);
          if (refusal) {
            transcript.push(`${desc} → ${refusal}`);
            break;
          }
          await page.keyboard.press(key);
        } else {
          if (!step.target) throw new Error(`${step.action} needs a target`);
          const loc = resolveTarget(step.target);
          // Coverage is recorded against the state the element LIVED IN, so it
          // has to be captured before the action changes the page. Marking it
          // afterwards (as this did) recorded against the state the click
          // LANDED on: a tab switch or navigation produces a different
          // fingerprint, that state never listed the clicked key, and
          // markExercised correctly refuses an unknown key — so the click
          // vanished and the route stayed "visited but NOTHING exercised" no
          // matter how many plan steps hit it.
          if (step.action === "click" || step.action === "type" || step.action === "select" || step.action === "upload") {
            // Reuse the previous step's post-action capture when the page has
            // not moved since: collect() waits for two stable probes, so a
            // fresh one per step would add seconds per step against the plan's
            // watchdog for a result identical to the one just taken.
            preState = lastCapture?.url === page.url() ? lastCapture : await this.captureCoverageState().catch(() => null);
          }
          preTestid = await loc.getAttribute("data-testid").catch(() => null);
          const label = await liveLabel(loc);
          preLabel = label;
          if (this.readOnly && (step.action === "click" || step.action === "select" || step.action === "upload") && isDestructive(label, step.value)) {
            transcript.push(`${desc} → ${destructiveRefusal(label || step.target)}`);
            break;
          }
          if (step.action === "click") forcedClick = (await this.resilientClick(loc, ACTION_TIMEOUT_MS)).forced;
          else if (step.action === "hover") {
            const { before, bodyBefore, churning } = await this.hoverBaselines();
            await loc.hover({ timeout: ACTION_TIMEOUT_MS });
            const { revealed } = await this.detectHoverReveal(before, bodyBefore, churning);
            transcript.push(
              revealed.length > 0
                ? `   hover revealed: ${revealed.join(" · ").slice(0, 300)}`
                : `   hover revealed nothing within ${HOVER_REVEAL_WINDOW_MS / 1000}s`,
            );
          } else if (step.action === "type") {
            const fillNote = await this.fillOrAppend(loc, step.value ?? "", step.replace ?? false);
            if (fillNote) transcript.push(`  ${fillNote.trim()}`);
            if (step.pressEnter) {
              if (this.readOnly) {
                const submit = loc.locator("xpath=ancestor::form[1]").locator('[type="submit"], button:not([type="button"]):not([type="reset"])').first();
                const submitLabel = (await submit.textContent({ timeout: 1000 }).catch(() => "")) ?? "";
                if (isDestructive(submitLabel)) {
                  transcript.push(`${desc} → filled, Enter withheld: ${destructiveRefusal(submitLabel.trim())}`);
                  break;
                }
              }
              await loc.press("Enter", { timeout: ACTION_TIMEOUT_MS });
            }
          } else if (step.action === "select") await loc.selectOption(step.value ?? "", { timeout: ACTION_TIMEOUT_MS });
          else if (step.action === "upload") {
            const r = await this.performUpload(loc, planUploadOptions(step.value));
            if (r.refused) {
              transcript.push(`${desc} → ${r.refused}`);
              break;
            }
            transcript.push(`  ${r.summary}${r.notes}`);
          }
        }
        await this.settle();
        this.logAction({ action: `plan:${step.action}`, target: step.target ?? step.value, url: page.url() });
        // Plans must feed coverage like ref-based actions do: record the
        // state and mark the acted-on element class as exercised.
        // Hover is deliberately excluded: a hover is a look, not an
        // interaction — marking it exercised would hide the element from
        // ft_coverage before it was ever clicked.
        if (step.action === "click" || step.action === "type" || step.action === "select" || step.action === "upload") {
          try {
            // Record the state the action LANDED on (it may be a new screen
            // this plan just reached, and it deserves coverage of its own)…
            const { elements } = await this.collect();
            const url = page.url();
            const fp = fingerprintState(url, elements);
            this.memory!.visitState(
              fp,
              url,
              normalizePath(url),
              elements.map((el) => el.key),
            );
            this.memory!.recordRoleAccess(this.role, normalizePath(url), "reached");
            lastCapture = { fp, elements, url };
            // …but mark the acted-on element in the state it came FROM, using
            // the pre-action capture. Falls back to the post-action state when
            // the pre-capture failed, which is the old behaviour and still
            // correct whenever the action did not change the page.
            const spec = step.target ?? "";
            const value = spec.slice(spec.indexOf("=") + 1);
            // Match by pre-action identity first: testid survives relabeling;
            // fall back to name only when nothing better exists.
            const wantedTestid = spec.startsWith("testid=") ? value : preTestid;
            const findIn = (list: SnapshotElement[]): SnapshotElement | undefined =>
              (wantedTestid ? list.find((el) => el.testid === wantedTestid) : undefined) ??
              list.find((el) => el.name.toLowerCase().includes(value.toLowerCase())) ??
              (preLabel ? list.find((el) => el.name.toLowerCase().includes(preLabel.toLowerCase().slice(0, 30))) : undefined);
            // Prefer the state the element lived in; fall back to the landed
            // state so a target the pre-capture missed (or a failed capture)
            // still records something rather than nothing.
            const preHit = preState ? findIn(preState.elements) : undefined;
            if (preHit) this.memory!.markExercised(preState!.fp, preHit.key, `plan:${step.action}`);
            else {
              const postHit = findIn(elements);
              if (postHit) this.memory!.markExercised(fp, postHit.key, `plan:${step.action}`);
            }
          } catch {
            /* coverage bookkeeping must never fail the plan */
          }
        }
        const violations = this.oracles.drain();
        const mutations = this.drainMutations() + this.drainBlocked();
        // Abort only on NEW violations: a known-failing endpoint repeating on
        // every navigation must not make every plan abort at step 1.
        if (violations.some((v) => !v.repeat)) {
          transcript.push(`${desc} → OK, but oracle fired:${formatViolations(violations)}${mutations}`);
          transcript.push(`PLAN ABORTED at step ${i + 1} — investigate before continuing.`);
          break;
        }
        const forcedNote = forcedClick
          ? " (forced — the strict click timed out on this element's hit-test/stability check but a forced click still landed; something may render on top of it or delegate via a label, cross-check GEOMETRY overlaps before calling it a bug)"
          : "";
        transcript.push(`${desc} → OK (${page.url()})${mutations}${forcedNote}`);
      } catch (err) {
        const fullMsg = err instanceof Error ? err.message : String(err);
        const firstLine = fullMsg.split("\n")[0];
        // The actionable diagnostic (which element actually intercepted the
        // hit-test) lives further down the multi-line Playwright error, not
        // on line 1 — surface it instead of discarding it, or a genuine
        // "wrong element is covering this" gets misread as a dead control.
        const diagnosticLine = actionabilityDiagnostic(fullMsg);
        let hint = "";
        if (/Timeout/i.test(firstLine)) {
          hint = ` (timeout${diagnosticLine ? ` — ${diagnosticLine}` : ""} — the target may no longer match: element relabeled, removed, or genuinely covered by an overlay; re-snapshot to see current state)`;
        } else if (/Input of type "file" cannot be filled/i.test(firstLine)) {
          hint = ` (this is a file input — use an {action:"upload"} step, or ft_upload)`;
        }
        transcript.push(`${desc} → FAILED: ${firstLine}${hint}`);
        break;
      }
    }
    this.refs.clear();
    this.lastSnap = null;
    this.snapshotUrl = "";
    // Count step lines, not transcript lines — hover reveals and scroll
    // positions push informational entries that are not steps.
    const ran = transcript.filter((l) => /^\d+\. /.test(l)).length;
    return `PLAN (${ran}/${Math.min(steps.length, 20)} steps ran):\n${transcript.join("\n")}\nTake ft_snapshot to see the resulting state.`;
  }

  /** Computed-style design audit of the current page — visual judgment material without pixels. */
  async designAudit(): Promise<string> {
    const page = this.requirePage();
    await this.settle();
    const payload = (await page.evaluate(DESIGN_COLLECT_SCRIPT)) as DesignPayload;
    payload.page.focusSamples = await this.probeFocusIndicators(page);
    this.designAuditCount += 1;
    // The census is built from previous audits, so the first few pages of a run
    // score with chrome included and later ones don't. That is the same warm-up
    // the coverage census has: nothing is knowable as "shared" until it has been
    // seen on several routes.
    const { report, score, signatures } = analyzeDesign(
      payload,
      page.viewportSize() ?? { width: 1280, height: 900 },
      this.memory?.designChromeKeys() ?? new Set(),
    );
    const route = normalizePath(page.url());
    this.memory?.recordDesignElements(route, signatures);
    // Only a page that actually produced a score counts as audited. An empty or
    // unhydrated page (and, since the chrome partition, one that is entirely
    // shell) returns no score — recording it as audited anyway dropped it from
    // the "never design-audited" ledger while it had never been measured.
    if (score) {
      this.memory?.setPageScore(route, { ...score, at: new Date().toISOString(), url: page.url() });
      this.memory?.markRouteFact(route, { audited: true });
    }
    this.logAction({ action: "design-audit", url: page.url(), result: score ? `score:${score.overall}` : undefined });
    return `URL: ${page.url()}\n` + report;
  }

  /**
   * Scroll like a user — and notice when the page won't let you. Reports the
   * resulting scroll position, and flags the case where scrollable content
   * exists but scrolling does nothing (leaked modal scroll-lock: users are
   * silently cut off from everything below the fold).
   */
  async scroll(to?: "top" | "bottom", by?: number, target?: string): Promise<string> {
    this.actionStartedAt = Date.now();
    const { refused, note } = target ? await this.scrollContainer(target, to, by) : await this.performScroll(to, by);
    if (refused) return refused;
    const amount = Math.trunc(by ?? 600);
    const label = to ?? `${amount >= 0 ? "down" : "up"} ${Math.abs(amount)}px`;
    const result = await this.afterAction("scroll", target ? `${label} in ${target}` : label);
    return result + note;
  }

  /**
   * Scroll ONE named region rather than the page. The page-level heuristic
   * picks the largest scrollable pane, so a smaller independently-scrolling
   * region — a sidebar nav beside a taller main pane — is otherwise
   * unreachable, and its content reads as truncated when it is merely scrolled
   * away. Resolves the element, then scrolls the nearest scrollable ancestor
   * (the target itself is usually the content, not the scroll port).
   */
  private async scrollContainer(target: string, to?: "top" | "bottom", by?: number): Promise<{ refused?: string; note: string }> {
    const page = this.requirePage();
    let locator;
    if (target.startsWith("testid=")) locator = page.locator(`[data-testid=${JSON.stringify(target.slice(7))}]`).first();
    else if (target.startsWith("text=")) locator = page.getByText(target.slice(5), { exact: false }).first();
    else if (target.startsWith("label=")) locator = page.getByLabel(target.slice(6)).first();
    else return { refused: `Scroll target must be "testid=…", "text=…" or "label=…" (got: ${target})`, note: "" };

    const amount = Math.trunc(by ?? 600);
    const outcome = await locator
      .evaluate(
        (el: Element, args: { edge: string | null; delta: number }) => {
          const scrollable = (n: Element): boolean => {
            const s = getComputedStyle(n);
            const oy = s.overflowY;
            return (oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 4;
          };
          let node: Element | null = el;
          while (node && node !== document.body && !scrollable(node)) node = node.parentElement;
          if (!node || node === document.body) return null;
          const before = node.scrollTop;
          if (args.edge === "top") node.scrollTo(0, 0);
          else if (args.edge === "bottom") node.scrollTo(0, node.scrollHeight);
          else node.scrollBy(0, args.delta);
          const tid = node.getAttribute("data-testid");
          const cls = typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\s+/)[0] : "";
          return {
            name: node.tagName.toLowerCase() + (tid ? `[data-testid="${tid}"]` : cls),
            before,
            y: Math.round(node.scrollTop),
            max: Math.max(0, node.scrollHeight - node.clientHeight),
          };
        },
        { edge: to ?? null, delta: amount },
        { timeout: ACTION_TIMEOUT_MS },
      )
      .catch(() => undefined);
    if (outcome === undefined) return { refused: `Scroll target not found: ${target}`, note: "" };

    if (!outcome) {
      return {
        note: `\nNothing to scroll: ${target} has no scrollable ancestor — its content is not clipped by a scroll port, so everything it holds is already laid out on the page.`,
      };
    }
    const pct = outcome.max > 0 ? Math.round((outcome.y / outcome.max) * 100) : 100;
    const edge = outcome.y >= outcome.max - 4 ? " — at its bottom" : outcome.y <= 4 ? " — at its top" : "";
    const moved = Math.abs(outcome.y - outcome.before) > 4;
    return {
      note: `\nScrolled ${outcome.name}: ${outcome.y}px of ${outcome.max}px (${pct}%)${edge}.` + (moved ? "" : ` It did not move — already at that position.`),
    };
  }

  /**
   * The user-emulating scroll core, shared by ft_scroll and plan steps. Does
   * NOT run afterAction — plan steps drain oracles themselves, and draining
   * here would empty the queue their abort-on-fresh-violation check reads.
   */
  private async performScroll(to?: "top" | "bottom", by?: number): Promise<{ refused?: string; note: string }> {
    const page = this.requirePage();
    // `lock` matters because overflow:hidden only blocks USER scrolling
    // (wheel/keys/touch) — window.scrollTo sails right through it. Emulating a
    // native user means refusing to scroll where they couldn't. A lock is
    // legitimate while ANY overlay is up — dialog-like panel (DIALOG_LIKE_SEL,
    // so role-less hand-rolled modals count) or a full-viewport backdrop.
    const read = `({y: window.scrollY, dh: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), vh: window.innerHeight,
      lock: [getComputedStyle(document.documentElement).overflowY, document.body ? getComputedStyle(document.body).overflowY : ""].some((o) => o === "hidden" || o === "clip"),
      ov: [...document.querySelectorAll('${DIALOG_LIKE_SEL}')].some((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        || [...document.querySelectorAll("body *")].some((e) => { const s = getComputedStyle(e); if (s.position !== "fixed") return false; const r = e.getBoundingClientRect(); return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9; })})`;
    const before = (await page.evaluate(read)) as { y: number; dh: number; vh: number; lock: boolean; ov: boolean };
    const amount = Math.trunc(by ?? 600);
    const wantedDown = to === "bottom" || (!to && amount > 0);
    const hadRoomDown = before.dh > before.vh + 50 && before.y < before.dh - before.vh - 4;
    if (before.lock && !before.ov && wantedDown && hadRoomDown) {
      return {
        refused:
          `⚠ SCROLL LOCKED: the document is ${Math.round(before.dh - before.vh)}px taller than the viewport but page scrolling is disabled (overflow hidden on body/html) with NO open dialog — ` +
          `a real user cannot reach anything below the fold (classic leaked modal scroll-lock; check the snapshot's OVERLAY lines and file it). Did not scroll.`,
        note: "",
      };
    }
    if (before.dh <= before.vh + 50) {
      // App-shell layout: the document fits the viewport and real scrolling
      // happens inside an inner pane. Reporting "at the bottom (100%)" here
      // would tell the brain it has seen a whole page it never scrolled.
      const inner = (await page.evaluate(`(() => {
        let best = null;
        for (const e of document.querySelectorAll("body *")) {
          const s = getComputedStyle(e);
          if (s.overflowY !== "auto" && s.overflowY !== "scroll") continue;
          if (e.scrollHeight <= e.clientHeight + 50) continue;
          const r = e.getBoundingClientRect();
          if (r.width < 100 || r.height < 100) continue;
          if (!best || r.width * r.height > best.a) best = { a: r.width * r.height, e };
        }
        if (!best) return null;
        const e = best.e;
        const to = ${JSON.stringify(to ?? null)};
        if (to === "top") e.scrollTo(0, 0);
        else if (to === "bottom") e.scrollTo(0, e.scrollHeight);
        else e.scrollBy(0, ${amount});
        const tid = e.getAttribute("data-testid");
        const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/)[0] : "";
        return { name: e.tagName.toLowerCase() + (tid ? '[data-testid="' + tid + '"]' : cls), y: Math.round(e.scrollTop), max: Math.max(0, e.scrollHeight - e.clientHeight) };
      })()`)) as { name: string; y: number; max: number } | null;
      if (!inner) return { note: `\nPage does not scroll — the content fits the viewport and no scrollable inner container was found.` };
      const pct = inner.max > 0 ? Math.round((inner.y / inner.max) * 100) : 100;
      return {
        note: `\nThe document itself does not scroll (app-shell layout) — scrolled the inner container ${inner.name} instead: ${inner.y}px of ${inner.max}px (${pct}%)${inner.y >= inner.max - 4 ? " — at its bottom" : inner.y <= 4 ? " — at its top" : ""}.`,
      };
    }
    if (to === "top") await page.evaluate("window.scrollTo(0, 0)");
    else if (to === "bottom") await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
    else await page.evaluate(`window.scrollBy(0, ${amount})`);
    const after = (await page.evaluate(read)) as { y: number; dh: number; vh: number };
    const max = Math.max(0, after.dh - after.vh);
    const pct = max > 0 ? Math.round((after.y / max) * 100) : 100;
    let note = `\nScroll position: ${Math.round(after.y)}px of ${max}px (${pct}%)${after.y >= max - 4 ? " — at the bottom" : after.y <= 4 ? " — at the top" : ""}.`;
    if (wantedDown && hadRoomDown && Math.abs(after.y - before.y) <= 4) {
      note +=
        before.lock && before.ov
          ? `\nPage scroll is locked by an open overlay (normal modal behaviour).`
          : `\n⚠ SCROLL LOCKED: the document is ${Math.round(before.dh - before.vh)}px taller than the viewport but the page did not scroll — content below the fold is unreachable (file it).`;
    }
    return { note };
  }

  /**
   * Overlay/modal defect probe, run on every snapshot. Native `page.on("dialog")`
   * only sees browser dialogs; APP modals (backdrop + positioned panel) are just
   * DOM, and their canonical failure modes — a grayed-out page with an EMPTY
   * dialog, a dialog shoved off-centre leaving a blank band, a backdrop with no
   * dialog at all, a dialog taller than the viewport with no way to reach its
   * buttons — all look perfectly healthy to the interactables collector.
   * Best-effort: probe failure must never break the snapshot.
   */
  private async probeOverlays(page: Page): Promise<string[]> {
    try {
      return (await page.evaluate(`(() => {
        const issues = [];
        const vw = window.innerWidth, vh = window.innerHeight;
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        // Backdrops: fixed, near-full-viewport, visually darkening/blurring.
        const backdrops = [];
        for (const el of document.querySelectorAll("body *")) {
          if (!visible(el)) continue;
          const s = getComputedStyle(el);
          if (s.position !== "fixed") continue;
          const r = el.getBoundingClientRect();
          if (r.width < vw * 0.9 || r.height < vh * 0.9) continue;
          const m = (s.backgroundColor || "").match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?/);
          const alpha = m ? (m[4] === undefined ? 1 : Number(m[4])) : 0;
          const darkens = (alpha > 0.05 && alpha < 0.98) || ((s.backdropFilter || "") + "").includes("blur");
          if (darkens) backdrops.push(el);
        }
        const hasContent = (el) => {
          const t = (el.textContent || "").trim();
          return t.length >= 10 || el.querySelectorAll("button, a[href], input, select, textarea").length > 0;
        };
        // Dialogs: aria/role/class-marked panels (role-less hand-rolled modals
        // count). Do NOT exclude backdrops here — a modal that carries its own
        // dim background (a full-screen [role=alertdialog] that IS the backdrop
        // and centres its card inside) is both, and excluding it would wrongly
        // read as "backdrop with no dialog".
        const dialogsAll = [...document.querySelectorAll('${DIALOG_LIKE_SEL}')].filter((d) => visible(d));
        // Leaked modal scroll-lock: content extends past the fold, the page
        // itself cannot scroll (overflow hidden on body/html), and NO overlay
        // of any kind — dialog-like panel OR backdrop — is up to justify the
        // lock; everything below the fold is unreachable and the page looks
        // perfectly healthy otherwise.
        const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
        const ovLock = [getComputedStyle(document.documentElement).overflowY, document.body ? getComputedStyle(document.body).overflowY : ""].some((o) => o === "hidden" || o === "clip");
        if (ovLock && docH > vh + 50 && dialogsAll.length === 0 && backdrops.length === 0) {
          issues.push("OVERLAY: page scrolling is DISABLED (overflow hidden on body/html) with " + Math.round(docH - vh) + "px of content below the fold and NO open dialog to justify it — likely a leaked modal scroll-lock; users cannot reach the rest of the page");
        }
        if (backdrops.length === 0) return issues;
        if (dialogsAll.length === 0) {
          // No marked dialog anywhere. Only a genuine stuck-grey-screen if the
          // backdrop region itself holds nothing to interact with.
          if (!backdrops.some(hasContent)) {
            issues.push("OVERLAY: page is covered by a modal backdrop but NO dialog content was found — the page is grayed out with nothing to interact with (user is stuck)");
          }
          return issues;
        }
        // The actual CARD, for geometry/emptiness checks: a full-viewport dialog
        // is a centring wrapper, not the panel — descend to its largest content
        // child that is smaller than the viewport.
        const panelOf = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < vw * 0.9 || r.height < vh * 0.9) return el;
          let best = null;
          for (const c of el.querySelectorAll("*")) {
            if (!visible(c)) continue;
            const cr = c.getBoundingClientRect();
            if (cr.width >= vw * 0.9 && cr.height >= vh * 0.9) continue;
            if (cr.width < 40 || cr.height < 40 || !hasContent(c)) continue;
            if (!best || cr.width * cr.height > best.a) best = { a: cr.width * cr.height, c };
          }
          return best ? best.c : el;
        };
        const panels = [];
        for (const d of dialogsAll) { const p = panelOf(d); if (p && panels.indexOf(p) < 0) panels.push(p); }
        for (const d of panels.slice(0, 3)) {
          const r = d.getBoundingClientRect();
          const text = (d.textContent || "").trim();
          const controls = d.querySelectorAll("button, a[href], input, select, textarea").length;
          const name = d.getAttribute("data-testid") ? "[" + d.getAttribute("data-testid") + "]" : "<" + d.tagName.toLowerCase() + ">";
          if (text.length < 10 && controls === 0) {
            issues.push("OVERLAY: open dialog " + name + " appears EMPTY (" + text.length + " chars, 0 controls) over a grayed-out page — likely failed content load or broken conditional render");
            continue;
          }
          const topGap = r.top, bottomGap = vh - r.bottom;
          if (r.height < vh && Math.abs(topGap - bottomGap) > vh * 0.35 && (topGap > vh * 0.4 || bottomGap > vh * 0.4)) {
            issues.push("OVERLAY: dialog " + name + " is far off-centre — " + Math.round(Math.max(topGap, bottomGap)) + "px empty band " + (topGap > bottomGap ? "above" : "below") + " it while the page is grayed out (broken centering)");
          }
          if (r.bottom > vh + 8 && d.scrollHeight <= d.clientHeight + 8) {
            issues.push("OVERLAY: dialog " + name + " extends " + Math.round(r.bottom - vh) + "px below the viewport with NO internal scroll — its lower controls may be unreachable");
          }
        }
        return issues;
      })()`)) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Keyboard-focus sampling for the design audit. Uses TRUSTED Tab presses:
   * programmatic el.focus() does not match :focus-visible on buttons/links in
   * Chromium, so an in-page probe would flag every default-styled control as
   * focusless. As Tab advances, the previous stop is naturally blurred, so
   * each stop's focused style (captured at visit time) can be diffed against
   * its blurred style (captured in one pass at the end) without fighting the
   * tab order. Best-effort: any failure returns an empty sample set rather
   * than failing the audit.
   */
  private async probeFocusIndicators(page: Page): Promise<FocusSample[]> {
    const styleSig = "s.outlineStyle + '|' + s.outlineWidth + '|' + s.outlineColor + '|' + s.boxShadow + '|' + s.borderColor + '|' + s.backgroundColor";
    const stops: Array<{ i: number; label: string; focused: string }> = [];
    try {
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        const info = (await page.evaluate(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return null;
          if (el.hasAttribute("data-ft-focus-probe")) return "wrapped";
          el.setAttribute("data-ft-focus-probe", "${i}");
          const s = getComputedStyle(el);
          const tid = el.getAttribute("data-testid");
          const name = ((el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 30));
          return { label: tid ? "[" + tid + "]" : "<" + el.tagName.toLowerCase() + "> " + JSON.stringify(name), focused: ${styleSig} };
        })()`)) as { label: string; focused: string } | "wrapped" | null;
        if (info === null || info === "wrapped") break;
        stops.push({ i, ...info });
      }
      await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
      const blurred = (await page.evaluate(`(() => {
        const out = {};
        for (const el of document.querySelectorAll("[data-ft-focus-probe]")) {
          const s = getComputedStyle(el);
          out[el.getAttribute("data-ft-focus-probe")] = ${styleSig};
          el.removeAttribute("data-ft-focus-probe");
        }
        return out;
      })()`)) as Record<string, string>;
      // A stop that vanished between passes gets the benefit of the doubt.
      return stops.map((st) => ({
        label: st.label,
        indicator: blurred[String(st.i)] === undefined ? true : st.focused !== blurred[String(st.i)],
      }));
    } catch {
      return [];
    }
  }

  async screenshot(): Promise<{ base64: string; mimeType: string }> {
    const page = this.requirePage();
    const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
    this.logAction({ action: "screenshot", url: page.url() });
    return { base64: buf.toString("base64"), mimeType: "image/jpeg" };
  }

  get currentState(): string {
    return this.currentFingerprint;
  }

  get currentUrl(): string {
    return this.page?.url() ?? "";
  }

  get oracleLog(): OracleMonitor {
    return this.oracles;
  }

  /**
   * Launch the browser with a hard timeout and one self-healing retry: a
   * leftover browser from a crashed previous run has been observed to wedge
   * fresh launches indefinitely (the failure surfaces as ft_attach hanging).
   * On the first failure or timeout, reap orphaned Playwright processes and
   * try once more before giving up with a diagnosable error.
   */
  private async launchWithRecovery(headed: boolean): Promise<Browser> {
    const attempt = async (): Promise<Browser> => {
      // The marker is what makes reapOrphanBrowsers safe to run at startup:
      // it appears in the child's command line, so the sweep can tell a browser
      // WE leaked from one belonging to somebody else's Playwright run.
      // `--enable-features` takes arbitrary names and ignores unknown ones.
      const launch = chromium.launch({
        headless: !headed,
        args: [`--enable-features=${BROWSER_MARKER}`],
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          launch,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("browser launch timed out after 30s")), 30_000);
          }),
        ]);
      } catch (err) {
        // If the launch resolves late, close that browser instead of leaking it.
        void launch.then((b) => b.close().catch(() => {})).catch(() => {});
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await attempt();
    } catch (firstErr) {
      const reaped = reapOrphanBrowsers();
      try {
        return await attempt();
      } catch {
        throw new Error(
          `browser launch failed twice (${firstErr instanceof Error ? firstErr.message : firstErr})` +
            (reaped > 0 ? ` — ${reaped} orphaned browser process(es) were reaped between attempts` : "") +
            `. Check disk space and that Playwright's chromium is installed (npx playwright install chromium).`,
        );
      }
    }
  }

  async close(): Promise<void> {
    // Pending debounced coverage writes must land before the process can exit.
    try {
      this.memory?.flush();
    } catch (err) {
      // A failed final flush must not block browser teardown, but it must
      // not vanish either — record it so ft_close can tell the caller the
      // very last save may not have landed.
      if (this.memory) this.memory.lastSaveError = err instanceof Error ? err.message : String(err);
    }
    // Bounded teardown: a wedged renderer must not hang ft_close forever.
    // If teardown overruns the cap, the leftover process is reaped by the
    // orphan cleaner on the next attach (or server start).
    await BrowserEngine.settleWithin(
      (async () => {
        await this.page?.close().catch(() => {});
        await this.context?.close().catch(() => {});
        await this.browser?.close().catch(() => {});
      })(),
      8000,
    );
    this.page = null;
    this.context = null;
    this.browser = null;
    this.refs.clear();
    this.snapshotUrl = "";
    this.currentFingerprint = "";
    this.lastSnap = null;
  }
}
