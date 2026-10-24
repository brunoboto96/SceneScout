/**
 * Acting on the page and recording what was found: scout_snapshot through scout_capture, and scout_finding.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BrowserEngine } from "../engine/browser.js";
import { siteAuditSection } from "../engine/design.js";
import { normalizePath } from "../engine/fingerprint.js";
import { describeMerge, FINDING_CATEGORIES, isWorthALook, mergeableCategories, type FiledFinding } from "../engine/memory.js";
import { LANE_CONVENTION_MAX } from "../engine/lane.js";
import { FIXTURE_KINDS, type FixtureKind } from "../engine/fixtures.js";
import {
  CAPTURE_MARGIN,
  CAPTURES_DIRNAME,
  captureFileName,
  captureResultText,
  describePicture,
  EVIDENCE_LIMITS,
  EVIDENCE_MARGIN,
  evidenceFrame,
  findingPicturePath,
  MAX_CAPTURE_MARGIN,
  returnsInline,
} from "../engine/capture.js";
import { decodePng, fitPicture } from "../engine/png.js";

import {
  engineFor,
  server,
  text,
  errorText,
  serializedPerSession,
  sessionParam,
  taskParam,
  legacyObjectiveParam,
  logLine,
  evidenceFor,
  guidedSessions,
  policyFor,
} from "../server-context.js";
import { egressRefusal, uploadRefusal } from "../engine/project-config.js";
import { planUploadOptions } from "../engine/uploads.js";
import { writeDocumentSync } from "../engine/owner-file.js";

type ImageContent = { type: "image"; data: string; mimeType: string };

/**
 * Take, bound and keep a filed finding's picture (capture.ts decides whether
 * and of what; png.ts fits it). Returns the line the result adds and, when the
 * result carries it, the picture. A picture that cannot be taken or kept never
 * fails the filing, which is already recorded: the line says why there is none.
 */
async function findingPicture(eng: BrowserEngine, filed: FiledFinding, ref: string | undefined): Promise<{ line: string; image?: ImageContent }> {
  const settings = evidenceFor.get(eng);
  const dir = eng.memory?.dir;
  if (!settings || !dir) return { line: "" };
  const { finding, isNew } = filed;
  const plan = evidenceFrame({
    mode: settings.mode,
    ref,
    pageOpen: eng.alive,
    isNew,
    hasPicture: !!finding.picture,
    regressed: !isNew && !!finding.regressedAt && finding.regressedAt === finding.foundAt,
  });
  if (!plan.take) return { line: settings.mode === "off" ? "" : `\nNo picture taken: ${plan.why}.` };
  try {
    const shot = await eng.captureEvidence(plan.frame === "element" ? plan.ref : undefined, EVIDENCE_MARGIN);
    const fitted = fitPicture(decodePng(shot.png), settings.maxPx, settings.maxBytes);
    if (!fitted) return { line: `\nNo picture kept: none small enough to be readable fits in ${Math.round(settings.maxBytes / 1024)} KB.` };
    const rel = findingPicturePath(eng.sessionKey, finding.id);
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeDocumentSync(file, fitted.png);
    const picture = {
      width: fitted.width,
      height: fitted.height,
      frame: shot.frame,
      ...(shot.label ? { label: shot.label } : {}),
      at: new Date().toISOString(),
    };
    eng.memory?.setPicture(finding.id, rel, picture);
    const said = `\n📷 Picture (${describePicture(picture)}${fitted.shrunk ? ", shrunk to fit" : ""}): ${file}${shot.note ? ` — ${shot.note}` : ""}`;
    if (!returnsInline(settings.mode, settings.shown, settings.inlineMax)) {
      const capped =
        settings.mode === "inline"
          ? ` Not shown here: this session has returned its ${settings.inlineMax} (${EVIDENCE_LIMITS.inline.env} sets how many); it is in report.html.`
          : "";
      return { line: said + capped };
    }
    settings.shown += 1;
    return { line: said, image: { type: "image", data: fitted.png.toString("base64"), mimeType: "image/png" } };
  } catch (err) {
    return { line: `\nNo picture kept: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** What scout_finding tells the agent about what filing did. */
function filedText(filed: FiledFinding, category: string): string {
  const { finding, isNew, promoted } = filed;
  if (isNew && isWorthALook(finding))
    return `Recorded as worth a look (not a defect in the report's totals): ${finding.title} (id ${finding.id}) — a defect only if your project uses ${finding.convention}`;
  if (isNew) return `Finding recorded: [${finding.severity}] ${finding.title} (id ${finding.id})`;
  if (filed.judged)
    return (
      `Not recorded as new: the dedup judge read it as the same defect as finding ${finding.id} (p_same ${filed.judged.pSame.toFixed(2)}) — [${finding.severity}] ${finding.title}, filed as ${finding.category}, seen in ${finding.runs} runs.` +
      `${promoted ? " That finding was worth a look and is now a defect." : ""} Its title, category, severity and evidence are kept on that finding, so the report shows the merge. If yours is a different defect, file it again with a title that says what differs.`
    );
  if (promoted)
    return `Merged into finding ${finding.id}, which was worth a look, and promoted to a defect: [${finding.severity}] ${finding.title}. It now counts among the report's findings.`;
  if (finding.regressedAt)
    return `⟳ REOPENED as a REGRESSION: finding ${finding.id} was previously resolved but the evidence reproduces again (seen in ${finding.runs} runs). Worth calling out to the user.`;
  return `Not recorded as new: merged into existing finding ${finding.id} — [${finding.severity}] ${finding.title}${finding.evidence ? ` (evidence: ${finding.evidence.slice(0, 160)})` : " (no evidence)"}, filed as ${finding.category}, seen in ${finding.runs} run${finding.runs === 1 ? "" : "s"}${filed.merge?.sameRun ? " (already filed this run, so the count did not change)" : ""}.${filed.merge ? describeMerge(filed.merge, finding.convention) : ""} If yours is a different bug, file it again: under the category that says what is wrong if it is another kind of defect (a finding filed as ${category} merges only with one filed as ${mergeableCategories(category).join(" or ")}), or with evidence naming the request that failed for you (method and path) — two findings are kept apart when both name requests and none is shared.`;
}

const leaveParam = z
  .boolean()
  .optional()
  .describe(
    "How to answer if the page asks to confirm leaving (a beforeunload prompt over unsent input): true leaves and discards that input, false stays. Omitted, observe and read-only stay and other modes leave. The result says when the page asked.",
  );

export function registerExploreTools(): void {
  server.registerTool(
    "scout_snapshot",
    {
      description:
        "Capture the current page state: URL, state fingerprint, a one-line summary of the main area's heading and text, interactable elements with refs (e1, e2, …) and their state (pressed, selected, checked, expanded, current), what the page announces (alert and status regions, by their text), geometry issues, coverage, and oracle violations since the last action. Re-snapshotting a route returns a DIFF against its last snapshot, even after visiting elsewhere, and another tab of the same screen diffs against that screen's last tab; refs stay stable, including across a search or filter that rewrites only the query string. On a dense page, says what past the element cap was cut. Cheap — prefer this over screenshots.",
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
        "Engine-side route sweep in ONE call: visits each path (default: all known routes not yet visited), records states into coverage memory, and returns a per-route health summary (HTTP status, element count, what the main area holds, oracle violations, dead-ends, auth-redirects, and ERROR-VIEW or STILL-LOADING for a main area showing only an alert or a loading placeholder). Navigation-only — safe in read-only mode. Use this FIRST for broad coverage; explore interactively only where it flags problems or where journeys matter.",
      inputSchema: {
        paths: z
          .array(z.string())
          .max(150)
          .optional()
          .describe(
            "Paths to visit, e.g. ['/orders','/settings'], or full URLs on the attached origin. A path resolves from the origin's root, whatever page the session attached on. Omit to crawl all unvisited known routes.",
          ),
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
        "Execute up to 20 actions in ONE call — use for mechanical sequences (fill a form, walk a wizard) so each step doesn't cost a round-trip. Targets resolve at execution time by semantic locator: 'testid=…', 'text=…', 'label=…' or 'role=button[name=Save]' (never snapshot refs). The same steps, saved to .scenescout/flows/<name>.json with expect-text / expect-url / expect-request steps added, are replayed by `scenescout check` on every pull request. An `upload` step attaches a file as scout_upload does (target required — the file input or the control that opens its chooser; value = a fixture kind or a project-relative path). The plan ABORTS at the first NEW oracle violation, policy refusal, or failed step, returning a transcript of how far it got; repeats of already-reported violations do not abort (they stay logged for the report). For a sweep of independent steps (tabs, filters, pages) pass onViolation \"continue\": a new error status or its console echo is listed on its step's line and the plan goes on; a failed step, a policy refusal or any other violation still stops it. A select step whose value names no option fails at once, listing the options.",
      inputSchema: {
        steps: z
          .array(
            z.object({
              action: z.enum(["navigate", "click", "type", "select", "press", "hover", "scroll", "upload"]),
              target: z
                .string()
                .optional()
                .describe(
                  "testid=…, text=…, label=…, role=<role>[name=\"…\"] (or a path for navigate; 'top'/'bottom'/±px for scroll; for upload: the file input or the control that opens its chooser)",
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
        onViolation: z
          .enum(["stop", "continue"])
          .default("stop")
          .describe(
            "stop (default): end the plan at the first new oracle violation, right for a form flow whose steps depend on each other. continue: list a new http_error or console_error on its step's line and run the next step, for a sweep of independent steps",
          ),
        task: taskParam,
        objective: legacyObjectiveParam,
        session: sessionParam,
      },
    },
    serializedPerSession(
      "scout_run_plan",
      async ({ steps, onViolation }: { steps: Parameters<BrowserEngine["runPlan"]>[0]; onViolation?: "stop" | "continue" }, session) => {
        try {
          const eng = engineFor(session);
          // A step that would upload a file from disk is refused before any step runs, as scout_upload refuses it.
          for (const [i, step] of steps.entries()) {
            const refused = step.action === "upload" ? uploadRefusal(policyFor(eng), planUploadOptions(step.value).filePath) : null;
            if (refused) return errorText(new Error(`scout_run_plan step ${i + 1} ${refused}`));
          }
          return text(await eng.runPlan(steps, onViolation ?? "stop"), session);
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
        leave: leaveParam,
        task: taskParam,
        objective: legacyObjectiveParam,
        session: sessionParam,
      },
    },
    serializedPerSession("scout_click", async ({ ref, clicks, leave }: { ref: string; clicks?: number; leave?: boolean }, session) => {
      try {
        return text(await engineFor(session).click(ref, clicks ?? 1, leave), session);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_type",
    {
      description:
        "Type into a text input/textarea/composer by ref, the way a real user does: if the field already holds content (e.g. an @-mention chip a menu click inserted), the text is APPENDED at the end — preserving that content — and the result reports what was already there (a separating space is added only at a word-to-word boundary). Pass replace=true to clear the field first (correcting a previous entry); an empty textValue always clears. Appending fires input events but not keydown, so keydown-driven triggers (slash/mention menus) will not react to appended text. Use for both valid values and boundary/fuzz values (empty, very long, unicode, script tags). A value typed into a secret field (a password, a one-time code, a card number, a field labelled secret or token) is masked in the result and the log, as is what the field held.",
      inputSchema: {
        ref: z.string().describe("Element ref, e.g. e12"),
        textValue: z.string().optional().describe("Text to type"),
        // A `type` step inside scout_run_plan spells this `value`, as does scout_select.
        // One vocabulary for "the text going in", whichever tool takes it.
        value: z.string().optional().describe("Alias for `textValue`."),
        pressEnter: z.boolean().default(false).describe("Press Enter after typing"),
        replace: z.boolean().default(false).describe("Clear the field before typing instead of appending to existing content"),
        task: taskParam,
        objective: legacyObjectiveParam,
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
        "Attach a file to an upload control the way a user does. `ref` is either a visible <input type=file> (snapshots list these with role `file`) or the button/label/dropzone that opens the file chooser — the chooser is intercepted and answered, which is how the hidden input behind a styled 'Choose file' control is reached. Omit `ref` to target the page's only file input, hidden or not (snapshots disclose hidden ones on a FILE INPUTS line). Nothing needs to exist on disk: a small VALID fixture (real PDF/PNG structure) is generated in memory, its kind inferred from the input's accept attribute or chosen with `fixture`; `filePath` uploads a real file but must live inside the attached project (fenced like navigation is fenced to the origin), and a credential-shaped one (a dotfile or anything in a hidden folder, `.env*`, an SSH key, `*.pem`/`*.key`/`*.p8`/`*.p12`/`*.pfx`/`*.ppk`/`*.jks`/`*.keystore`/`*.asc`/`*.kdbx`, anything under `.ssh`, `.aws`, `.gnupg`, `.config`, `.kube` or `.docker`) is refused unless the operator listed it; `name` overrides the filename for boundary tests (wrong extension vs accept, very long, unicode). The result names the input, how the file reached it, flags a file that violates accept (a mismatch the app then accepts is a validation finding), warns if the app cleared the input after selection, and says whether a state-changing request fired on selection — if none did, click the form's submit, or check the next snapshot for a client-side rejection.",
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
        task: taskParam,
        objective: legacyObjectiveParam,
        session: sessionParam,
      },
    },
    serializedPerSession(
      "scout_upload",
      async ({ ref, filePath, fixture, name }: { ref?: string; filePath?: string; fixture?: FixtureKind; name?: string }, session) => {
        try {
          const eng = engineFor(session);
          // The config's uploads lock, before the engine's own fence (engine/project-config.ts).
          const refused = uploadRefusal(policyFor(eng), filePath);
          if (refused) return errorText(new Error(`scout_upload ${refused}`));
          return text(await eng.upload({ ref, filePath, fixture, name }), session);
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
      description:
        "Select an option in a <select> by ref. The value is matched against the options before anything is picked: an exact value, an exact label, either ignoring case, then a label it starts with. A value matching no option, or several, is refused at once with the options listed.",
      inputSchema: {
        ref: z.string(),
        value: z.string().describe("Option value or label (or the start of a label, when only one option has it)"),
        task: taskParam,
        objective: legacyObjectiveParam,
        session: sessionParam,
      },
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
      description:
        "Navigate to a path on the attached origin (e.g. '/orders') or a full URL on it. A path resolves from the origin's root, whatever page the session attached on. Also supports 'back' via scout_back.",
      inputSchema: {
        target: z.string().describe("Absolute URL or path like /settings"),
        leave: leaveParam,
        task: taskParam,
        objective: legacyObjectiveParam,
        session: sessionParam,
      },
    },
    serializedPerSession("scout_navigate", async ({ target, leave }: { target: string; leave?: boolean }, session) => {
      try {
        return text(await engineFor(session).navigate(target, leave), session);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_request",
    {
      description:
        "Call the app's own API as this session, with the UI bypassed — the check that turns a hidden or disabled control into a proven refusal. A button that is not shown proves nothing; the same action refused by the server does. The fetch runs IN the page, so it carries the session's cookies and replays the Authorization header the app itself last sent, and it passes through the same interception the write policy is enforced on: in safe-write a mutation on a record this session did not create is refused here exactly as it would be for a click, and that refusal is the engine's safety net, not a finding. Returns the status line, the timing, the headers that decide whether two responses are truly identical (content-type, location, www-authenticate, retry-after, cache-control), and the body — its first 2000 characters, or the part named by select (one JSON value by path) or offset/limit (a window of characters). Unlike a shell call, every request is recorded in the run's trail and its signature is what a finding should quote. Paths are fenced to the attached origin: use another session to reach another host.",
      inputSchema: {
        path: z.string().min(1).max(2000).describe("Path on the attached origin, e.g. /api/things/12, or a full URL on that same origin"),
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional().describe("Default GET"),
        body: z.string().max(20000).optional().describe("Request body, sent as application/json unless a content-type header is given"),
        headers: z
          .record(z.string(), z.string().max(2000))
          .optional()
          .describe(
            "Extra headers. One given here wins over the app's own, which is how a session tests a different or absent credential. A method override (X-HTTP-Method-Override, X-HTTP-Method, X-Method-Override, or _method in the path's query or the body) is judged by the write policy as the method it names.",
          ),
        select: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Return one value of a JSON response body by its dotted path, e.g. "stats.open" or "items.0.name", pretty-printed and up to 8000 characters. A path that is not there says which keys are.',
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .optional()
          .describe(
            "Return the body (or the selected value) from this character on. The body is cut at 2000 characters by default; the result names the next offset.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(8000)
          .optional()
          .describe("How many characters to return with offset or select. Default 2000, or 8000 for a select with no offset."),
        task: taskParam,
        objective: legacyObjectiveParam,
        session: sessionParam,
      },
    },
    serializedPerSession(
      "scout_request",
      async (
        args: {
          path: string;
          method?: string;
          body?: string;
          headers?: Record<string, string>;
          select?: string;
          offset?: number;
          limit?: number;
          session?: string;
        },
        session,
      ) => {
        try {
          const view = { select: args.select, offset: args.offset, limit: args.limit };
          return text(await engineFor(session).apiRequest({ method: args.method, path: args.path, body: args.body, headers: args.headers, view }), session);
        } catch (err) {
          return errorText(err);
        }
      },
    ),
  );

  server.registerTool(
    "scout_network",
    {
      description:
        "List the data requests (fetch and XHR) the current page made since its document loaded: method, path, status and time, oldest first, each marked with the route it was sent from when a client-side route change moved the page since. Use it when the page and the server seem to disagree — an empty list where the API has data, a stale value after a save — to tell a request that failed, one still pending and one that never ran apart. Read-only: it lists what the browser already saw and sends nothing. Credentials in query strings are redacted. A full page load starts a new list; scout_request's own calls are marked.",
      inputSchema: {
        contains: z.string().max(200).optional().describe("Only requests whose path contains this text, e.g. /api/things"),
        limit: z.number().int().min(1).max(200).optional().describe("How many of the newest to list. Default 40."),
        session: sessionParam,
      },
    },
    serializedPerSession("scout_network", async (args: { contains?: string; limit?: number; session?: string }, session) => {
      try {
        return text(engineFor(session).listPageRequests({ contains: args.contains, limit: args.limit }), session);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_back",
    {
      description: "Go back in browser history (tests back-button resilience).",
      inputSchema: { leave: leaveParam, task: taskParam, objective: legacyObjectiveParam, session: sessionParam },
    },
    serializedPerSession("scout_back", async ({ leave }: { leave?: boolean; session?: string }, session) => {
      try {
        return text(await engineFor(session).goBack(leave), session);
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
      inputSchema: { key: z.string(), task: taskParam, objective: legacyObjectiveParam, session: sessionParam },
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
        "Computed-style design audit of the current page — a design connoisseur's read WITHOUT screenshots. Measurable defects (⚠): WCAG contrast, tiny targets, clipped text, aspect-distorted images, horizontal overflow, sibling cards touching with no gap (naming their parent), missing keyboard-focus indicators (sampled with real Tab presses). Craft suggestions (→): line measure and line-height rhythm, spacing-scale adherence, typography entropy, palette discipline (gray census, accent hue families, pure-#000 body text), elevation/control consistency, heading structure, indistinguishable links, and AI-slop tells (gradient text, glassmorphism, side-stripe borders, neon glows, violet gradients, identical card grids). Ends with a SYSTEM SUMMARY of design-system coherence and a PAGE SCORE whose why: line lists the largest deductions behind it; once four pages are audited, a SITE CONSISTENCY block sets this page's button heights, radii, headers, tabs and grays beside the other pages' and names the values only one page uses. Run once per representative page; the → tier is improvement feedback — file genuine opportunities as ux-polish findings with the concrete numbers, not just defects.",
      inputSchema: { session: sessionParam },
    },
    serializedPerSession("scout_design_audit", async (_args: { session?: string }, session) => {
      try {
        const engine = engineFor(session);
        const audit = await engine.designAudit();
        // The audited page set beside every other page with a score (design.ts siteAuditSection), read now rather than
        // stored: which pages were audited decides it. The audit's own lines begin with the URL it measured; a sign-in
        // notice may come before them, so the line is found anywhere in the text.
        const url = /^URL: (\S+)/m.exec(audit)?.[1];
        const site = url && engine.memory ? siteAuditSection(engine.memory.pageScores, normalizePath(url)) : "";
        return text(site ? `${audit}\n\n${site}` : audit, session);
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
        "Cumulative WRITTEN knowledge about the tested app — .scenescout/ASSUMPTIONS.md, in prose a human can read and correct. memory.json stores coverage; this stores UNDERSTANDING, so every run starts smarter than the last. READ it at the start of every session ({action:'read'}). ADD durable learnings as you go ({action:'add', section, note}): what the app is for (app-model), who each role is and what they're FOR — infer the persona from what the role can see and do, e.g. 'qa-role = reviewer: approves orders, cannot administer' (roles), UI patterns the app follows (conventions), rules discovered the hard way like 'an order can only ship once approved' (constraints), fragile areas worth re-testing every run (risks), domain terms (glossary), and how to get the app testable at all — the command that regenerates an expired login state, what has to be running (setup), which the engine reads back to you the next time a storage state has expired. Notes are dated, attributed to the acting role, and deduplicated. Do NOT record session-specific facts (ids, counts) — only durable knowledge.",
      inputSchema: {
        action: z.enum(["read", "add"]).describe("'read' the accumulated knowledge, or 'add' one durable learning"),
        section: z
          .enum(["app-model", "roles", "conventions", "constraints", "risks", "glossary", "setup"])
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
        const eng = engineFor(session);
        // egress "none": a picture of the page is not returned into the conversation, as a finding's is kept to a file.
        const refused = egressRefusal(policyFor(eng), "model", "scout_screenshot");
        if (refused) throw new Error(refused);
        const { base64, mimeType } = await eng.screenshot();
        return { content: [{ type: "image", data: base64, mimeType }] };
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_capture",
    {
      description:
        "Save a PNG of ONE element — its bounds plus a margin, from a real screenshot — under .scenescout/captures/, to show a person how it looks. Give the element's ref from the latest scout_snapshot. Not a way to judge design: scout_design_audit measures it.",
      inputSchema: {
        ref: z.string().max(20).optional().describe("The element's ref from the latest scout_snapshot"),
        key: z
          .string()
          .max(300)
          .optional()
          .describe("Instead of a ref: the element's key from an earlier scout_capture result, to capture the same element on another deployment"),
        name: z.string().max(40).optional().describe("The file's name: letters, digits and dashes. Default: capture"),
        margin: z.number().int().min(0).max(MAX_CAPTURE_MARGIN).optional().describe(`CSS pixels kept around the element. Default ${CAPTURE_MARGIN}`),
        session: sessionParam,
      },
    },
    serializedPerSession("scout_capture", async ({ ref, key, name, margin }: { ref?: string; key?: string; name?: string; margin?: number }, session) => {
      try {
        const eng = engineFor(session);
        const dir = eng.memory?.dir;
        if (!dir) throw new Error("Not attached — call scout_attach first.");
        const shot = await eng.captureElement({ ref, key }, margin ?? CAPTURE_MARGIN);
        const file = path.join(dir, CAPTURES_DIRNAME, captureFileName(name));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeDocumentSync(file, shot.png);
        const size = { width: shot.png.readUInt32BE(16), height: shot.png.readUInt32BE(20) };
        return text(captureResultText({ file, key: shot.key, label: shot.label, url: shot.url, ...size }), session);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_finding",
    {
      description:
        "Record a structured finding (bug, UX issue, or improvement). Deduplicates across runs; automatically captures the recent action trace as the repro, and a picture of what it is about (the element `ref` names, else the viewport), kept for report.html and returned in this result as an image. Use for anything worth reporting: crashes, oracle violations you confirmed, dead ends, confusing UX, permission leaks, missing testids — and design-audit improvement opportunities (ux-polish) with their concrete measurements.",
      inputSchema: {
        severity: z.enum(["high", "medium", "low"]),
        category: z.enum(FINDING_CATEGORIES).describe("Pick the closest — use 'other' only when nothing fits"),
        title: z.string().describe("One-line summary of the defect"),
        detail: z.string().describe("What happened, what was expected, and the evidence"),
        evidence: z
          .string()
          .optional()
          .describe(
            "Canonical machine signature for dedup, e.g. 'GET /api/reports/dashboard 403' or 'widget dashboard-summary-widget shows 0'. Same bug re-found later should produce the same string.",
          ),
        convention: z
          .string()
          .min(1)
          .max(LANE_CONVENTION_MAX)
          .optional()
          .describe(
            "Only for a WORTH-A-LOOK finding: the observation is real, and it is a defect only under a convention of this project you cannot see. Name that convention, e.g. 'a 4px spacing scale' or 'test ids on every control'. The report lists it under \"Worth a look\", apart from the defects, and does not count it as one. Not for \"I could not tell\": leave that unfiled or look closer. Omit for a defect.",
          ),
        ref: z
          .string()
          .max(20)
          .optional()
          .describe(
            "The ref, from the latest scout_snapshot, of the element the finding is about. Its picture (the element plus a margin) is kept with the finding and shown in report.html. Omit it and the picture is the viewport.",
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
          convention,
          ref,
        }: {
          severity: "high" | "medium" | "low";
          category: string;
          title: string;
          detail: string;
          evidence?: string;
          convention?: string;
          ref?: string;
        },
        session,
      ) => {
        try {
          const eng = engineFor(session);
          if (!eng.memory) throw new Error("Not attached — findings need an active session.");
          const filed = await eng.memory.fileFinding({
            severity,
            category,
            title,
            detail,
            evidence,
            ...(convention ? { tier: "worth_a_look" as const, convention } : {}),
            url: eng.currentUrl,
            state: eng.currentState || "(unknown)",
            session: eng.sessionKey,
            // The mode it was filed in, so a guided re-check of it never attaches above that (guided.ts recheckSpec).
            foundInMode: eng.mode,
          });
          if (filed.judgeError) logLine(`dedup judge: ${filed.judgeError}; the rule decided`);
          // In a guided check, the area this session is working on is where the finding was found (its card and scout_cards' filter).
          const area = guidedSessions.get(session)?.area;
          if (area) eng.memory.setArea(filed.finding.id, area);
          const picture = await findingPicture(eng, filed, ref);
          const result = text(filedText(filed, category) + picture.line, session);
          if (picture.image) result.content.push(picture.image);
          return result;
        } catch (err) {
          return errorText(err);
        }
      },
    ),
  );
}
