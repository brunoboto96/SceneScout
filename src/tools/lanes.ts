/**
 * The parallel-run protocol: scout_lane_brief splits the app between lanes, and scout_lane_report folds a lane's typed report back in.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import path from "node:path";
import { z } from "zod";
import { decodedEntitiesNote, ignoredConventionsNote, LANE_NAME_MAX, laneReportInstruction, parseLaneReport, summarizeLaneReport } from "../engine/lane.js";
import { MAX_UNFILED_NAMED, unfiledDefects } from "../engine/calibration.js";
import { formatBriefs, MAX_LANES, planLanes, replayBriefs, type LaneBrief } from "../engine/brief.js";
import { DEFAULT_EXPIRY_MARGIN_MINUTES, DEFAULT_RUN_MINUTES, judgeProfileFile } from "../engine/expiry.js";
import {
  continueLines,
  continuePlan,
  FROM_RUN_ENV,
  FROM_RUN_MODE_ENV,
  FROM_RUN_MODES,
  fromRunLine,
  replayLines,
  replayPlan,
  resolveFromRun,
} from "../engine/from-run.js";
import { logAddress } from "../engine/authloss.js";
import { loadRunRecord } from "../engine/memory.js";
import { formatCriteriaForLanes } from "../engine/tickets.js";

import {
  engines,
  engineFor,
  server,
  text,
  errorText,
  serializedPerSession,
  sessionParam,
  laneLedger,
  guidedSessions,
  operatorPolicy,
} from "../server-context.js";
import { fsPolicyReader, runRecordRefusal } from "../engine/project-config.js";

// The lane report: how a parallel agent hands its results back to the planner
// as typed decisions. One tool for both halves, so the instruction a lane is
// given and the parser its reply meets are the same code.
// Splitting the app between lanes: the other half of the parallel protocol.
// scout_lane_report is how a lane hands its answers back; this is what the
// planner hands it in the first place.
export function registerLaneTools(): void {
  server.registerTool(
    "scout_lane_brief",
    {
      description:
        "For a run split across parallel agents (lanes). Divides the app's known routes between N lanes and returns each lane's session name, the `objective` to attach it with, and the routes it owns — whole modules per lane, balanced by route count, so no two lanes audit the same area and none is left unopened. Call it after the first crawl, when route knowledge is complete. Touches no browser; pass the briefs to your lane agents, then use scout_lane_report for what they hand back.",
      inputSchema: {
        lanes: z.number().int().min(1).max(MAX_LANES).describe(`How many lanes to split across (1–${MAX_LANES})`),
        goal: z.string().max(200).optional().describe("What the whole run is for; each lane's objective is written against it"),
        routes: z.array(z.string()).max(500).optional().describe("Routes to split. Omit to split every route this project knows about."),
        runMinutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe(
            `How long the lanes will run, in minutes (default ${DEFAULT_RUN_MINUTES}). When they attach by a saved role, the brief is refused if that login will not last this long plus the margin.`,
          ),
        expiryMarginMinutes: z
          .number()
          .int()
          .min(0)
          .max(240)
          .optional()
          .describe(`How long past the run a saved role's login must still last, in minutes (default ${DEFAULT_EXPIRY_MARGIN_MINUTES}).`),
        fromRun: z
          .string()
          .max(1024)
          .optional()
          .describe(
            `Start from an earlier run's record: a ci.json, or a project directory (relative to this project). With fromRunMode continue, the lanes take the routes it never worked on first, then the ones it left work on with what to do first, then the rest; with replay, one lane per session it had, following its routes and steps in order. Default ${FROM_RUN_ENV}, else none (the stable split).`,
          ),
        fromRunMode: z.enum(FROM_RUN_MODES).optional().describe(`With fromRun: continue (default) or replay. Default ${FROM_RUN_MODE_ENV}, else continue.`),
        session: sessionParam,
      },
    },
    serializedPerSession(
      "scout_lane_brief",
      async (
        {
          lanes,
          goal,
          routes,
          runMinutes,
          expiryMarginMinutes,
          fromRun,
          fromRunMode,
        }: {
          lanes: number;
          goal?: string;
          routes?: string[];
          runMinutes?: number;
          expiryMarginMinutes?: number;
          fromRun?: string;
          fromRunMode?: (typeof FROM_RUN_MODES)[number];
        },
        session,
      ) => {
        try {
          const eng = engineFor(session);
          // Lanes that attach by a saved role all sign in from one file: check it
          // lasts the run before handing out briefs that would die part-way.
          let expiryNote = "";
          if (eng.auth.kind === "role") {
            const verdict = judgeProfileFile(eng.auth.storageStatePath, {
              url: eng.baseUrl,
              now: Date.now(),
              runMs: (runMinutes ?? DEFAULT_RUN_MINUTES) * 60_000,
              marginMs: (expiryMarginMinutes ?? DEFAULT_EXPIRY_MARGIN_MINUTES) * 60_000,
              role: eng.auth.role,
              rerun: eng.reloginCommand(eng.auth.role),
            });
            if (verdict.kind === "refuse") return errorText(new Error(verdict.message));
            if (verdict.kind !== "ok") expiryNote = `⚠ ${verdict.message}\n\n`;
          }
          const all = routes && routes.length > 0 ? routes : eng.allKnownRoutes();
          // Started from an earlier run only when asked, by the input or the server's environment: otherwise the split is the stable one.
          const asked = resolveFromRun({ path: fromRun, mode: fromRunMode }, process.env, { path: "fromRun", mode: "fromRunMode" });
          if (!asked.ok) return errorText(new Error(asked.error));
          let briefs: LaneBrief[];
          let fromRunNote: string | undefined;
          let laneLines: ((b: LaneBrief) => readonly string[]) | undefined;
          if (asked.fromRun) {
            const projectDir = eng.memory ? path.dirname(eng.memory.dir) : process.cwd();
            const source = path.resolve(projectDir, asked.fromRun.path);
            const outside = runRecordRefusal(operatorPolicy, source, fsPolicyReader);
            if (outside) return errorText(new Error(`scout_lane_brief ${outside}`));
            const record = loadRunRecord(source);
            // Named as it was given, so the brief and the report carry no local directory.
            const note = { at: new Date().toISOString(), mode: asked.fromRun.mode, source: asked.fromRun.path, runId: record.runId, recordAt: record.at };
            fromRunNote = fromRunLine(note);
            if (asked.fromRun.mode === "continue") {
              const items = continuePlan(record, all);
              // Every route it orders is split, the record's own included, so none is left out of every lane.
              const order = items.map((i) => i.route);
              briefs = planLanes(order, lanes, { goal, mode: eng.mode, role: eng.role, order });
              laneLines = (b) => continueLines(items, { from: note.source, only: b.routes });
            } else {
              // A replay has one lane per session the recorded run had, whatever number was asked for.
              const replay = replayPlan(record);
              if (replay.length === 0) return errorText(new Error(`The run recorded in ${note.source} took no steps, so there is nothing to replay.`));
              briefs = replayBriefs(replay, goal);
              const byLane = new Map(briefs.map((b, i) => [b.lane, replay[i]] as const));
              laneLines = (b) => replayLines(byLane.get(b.lane)!, { from: note.source });
            }
            eng.memory?.noteFromRun(note);
          } else {
            briefs = planLanes(all, lanes, { goal, mode: eng.mode, role: eng.role });
          }
          laneLedger.nameBriefed(
            briefs.map((b) => b.lane),
            (s) => engines.has(s),
          );
          // A run given tickets tells every lane which criteria it answers.
          const criteria = eng.memory ? formatCriteriaForLanes(eng.memory.ticketsThisRun().tickets) : "";
          return text(
            expiryNote +
              formatBriefs(briefs, {
                goal,
                mode: eng.mode,
                // The plan this session carries, so each lane's attach passes the gate the planner's did.
                ...(guidedSessions.get(session)?.planId ? { planId: guidedSessions.get(session)!.planId } : {}),
                role: eng.role,
                roleProfile: eng.auth.kind === "role",
                ...(fromRunNote ? { fromRunNote } : {}),
                ...(laneLines ? { laneLines } : {}),
              }) +
              (criteria ? `\n${criteria}` : ""),
            session,
          );
        } catch (err) {
          return errorText(err);
        }
      },
    ),
  );

  server.registerTool(
    "scout_lane_report",
    {
      description:
        "For a run split across parallel agents (lanes). Without `reply`: returns the paragraph to put in a lane's prompt, telling it to hand back ONE typed JSON object (verdicts, severities and categories from closed sets, a calibrated confidence per decision, routes covered, what blocked it). " +
        "With `reply`: parses what the lane handed back and returns the one-line fold (defects, highs, unsure, mean confidence, routes) or the reason it was refused, to relay to the lane once. Touches no browser.",
      inputSchema: {
        lane: z.string().min(1).max(LANE_NAME_MAX).describe("The lane's name, as used in its session"),
        reply: z.string().optional().describe("The text the lane handed back; omit to get the instruction instead"),
      },
    },
    async ({ lane, reply }: { lane: string; reply?: string }) => {
      try {
        if (reply === undefined) {
          laneLedger.name(lane);
          return { content: [{ type: "text" as const, text: laneReportInstruction(lane) }] };
        }
        const parsed = parseLaneReport(reply, lane);
        if (!parsed.ok) {
          laneLedger.refuse(lane, engines.get(lane)?.attached === true);
          return {
            content: [
              { type: "text" as const, text: `Lane report REFUSED: ${parsed.reason}. Ask the lane once for the corrected object; do not re-judge its prose.` },
            ],
          };
        }
        // Keep what the lane decided, so the confidence it stated can be checked
        // against what the run goes on to file. Best-effort: a lane report is
        // still accepted if this project has no memory open yet, because the
        // planner's fold must not depend on where the report was written.
        // ONLY the lane's own session. Falling back to any engine with memory
        // open put one project's decisions into another project's store whenever
        // two sessions were attached to different apps — and the lane having
        // already closed makes that the ordinary case, not an edge one.
        const owner = engines.get(lane)?.memory;
        const at = new Date().toISOString();
        // Marks the moment the lane's browser stopped being needed, so the pace
        // section can tell a lane still reporting from one waiting to be closed.
        // Another site's page (a sign-in provider's) is kept as its origin and path, as every address the memory holds is (authloss.ts logAddress).
        const laneEngine = engines.get(lane);
        owner?.logAction({ action: "lane-report", url: logAddress(laneEngine?.currentUrl ?? "", laneEngine?.baseUrl ?? ""), session: lane });
        const kept = owner
          ? owner.addLaneDecisions(
              lane,
              parsed.report.decisions.map((d) => ({ ...d, lane, at })),
            )
          : 0;
        // And the routes it covered, so the benchmark can tell a lane's remark
        // about another lane's page from a verdict on its own.
        owner?.addLaneRoutes(lane, parsed.report.routes);
        // Say when nothing was kept. Every lane closing its session before the
        // planner folds its report is the order the method describes, and it
        // leaves no memory to write to — reporting a bare "accepted" while the
        // skill promises the decisions are kept is the kind of silence that
        // makes a later calibration section look wrong rather than absent.
        const note =
          kept > 0
            ? ` (${kept} decision(s) kept for calibration)`
            : ` (nothing kept for calibration, and no check that its defects were filed — session ${JSON.stringify(lane)} is not attached here, so there is no project memory to write to or read. Fold a lane report before closing that lane's session.)`;
        // Follow-through: a defect judged and never filed never reaches the
        // report. Checked against every finding on the lane's project, so one
        // the planner or another lane filed counts. Only that project's: the
        // same reason decisions are kept only there.
        const unfiled = owner ? unfiledDefects(parsed.report.decisions, owner.findings) : [];
        const followUp =
          unfiled.length > 0
            ? `\n⚠ ${unfiled.length} judged defect(s) have no finding with matching evidence yet:\n` +
              unfiled
                .slice(0, MAX_UNFILED_NAMED)
                .map((u) => `  · ${u}`)
                .join("\n") +
              (unfiled.length > MAX_UNFILED_NAMED ? `\n  … +${unfiled.length - MAX_UNFILED_NAMED} more` : "") +
              `\nFile each with scout_finding (the same evidence), or have the lane name the finding's id in the decision's "finding", before closing the lane's session. A judged defect that is never filed is not in the report.`
            : "";
        laneLedger.fold(lane, engines.get(lane)?.attached === true);
        // A lane that lost its sign-in and re-attached from its role's profile
        // says so here, where the planner folds it, not only in the lane's own calls.
        const reattach = engines.get(lane)?.reattachSummary() ?? "";
        const reattached = reattach ? `\n↻ Session ${JSON.stringify(lane)}: ${reattach}.` : "";
        const refreshed = engines.get(lane)?.refreshSummary() ?? "";
        const brokered = refreshed ? `\n↻ Session ${JSON.stringify(lane)}: ${refreshed}.` : "";
        const around = parsed.aroundIgnored ? `\n(The text around the report's JSON block was discarded unread.)` : "";
        const decoded = decodedEntitiesNote(parsed.entitiesDecoded) + ignoredConventionsNote(parsed.conventionsIgnored);
        return {
          content: [
            {
              type: "text" as const,
              text: `Lane report accepted — ${summarizeLaneReport(parsed.report)}${note}${reattached}${brokered}${around}${decoded}${followUp}`,
            },
          ],
        };
      } catch (err) {
        return errorText(err);
      }
    },
  );
}
