/**
 * Reading and closing out a run: scout_coverage, scout_report, scout_resolve, scout_verify, scout_tickets, scout_criterion,
 * scout_cards, scout_feedback and scout_team_report.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { computeGaps, coverageView, formatRouteCoverage, generateReport, lastFrames, runRecordOf } from "../engine/report.js";
import { teamReportData, teamReportText, writeTeamReport } from "../engine/team-report.js";
import { DEFAULT_REPORT_AUDIENCE, REPORT_AUDIENCES, type ReportAudience } from "../engine/plain.js";
import { describeVerdict, formatWorklist, unknownIds, VERDICTS, verifyWorklist, type Verdict } from "../engine/verify.js";
import {
  CRITERION_VERDICTS,
  findCriterion,
  formatReading,
  isTicketFileName,
  judgeCriterion,
  MAX_CRITERION_FINDINGS,
  MAX_REASON,
  MAX_TICKET_FILE_BYTES,
  MAX_TICKET_TEXT,
  MAX_TICKETS,
  NOT_TESTED_REASONS,
  parseTickets,
  TICKET_DIRS_ENV,
  TICKET_FILE_EXTENSIONS,
  ticketFileFor,
  type CriterionVerdictKind,
  type NotTestedReason,
} from "../engine/tickets.js";

import { CANDIDATES_NOTE, FEEDBACK_SAYS } from "../engine/guided-words.js";
import { CHECK_AREAS } from "../engine/guided.js";
import { FEEDBACK_VERDICTS, MAX_FEEDBACK_REASON, type FeedbackVerdict } from "../engine/memory.js";
import {
  CARD_FEEDBACK,
  CARD_IMPACTS,
  CARD_STATUSES,
  cardText,
  feedbackCandidates,
  MAX_CARDS,
  MAX_INLINE_PICTURES,
  readInlinePicture,
  selectCards,
  type CardFilter,
} from "../engine/progress.js";

import {
  engines,
  engineFor,
  server,
  text,
  errorText,
  openDecisions,
  openForUser,
  serializedPerSession,
  sessionParam,
  logLine,
  guidedRuns,
  guidedSessions,
  guidedPlans,
  projectEngine,
  PKG_VERSION,
} from "../server-context.js";

/** A PlainCard, as scout_cards' structuredContent carries it. */
const PLAIN_CARD_OUTPUT = z.object({
  id: z.string(),
  impact: z.enum(CARD_IMPACTS),
  severity: z.enum(["high", "medium", "low"]),
  title: z.string(),
  problem: z.string(),
  expected: z.string(),
  happened: z.string(),
  page: z.string(),
  alsoOn: z.array(z.string()),
  steps: z.array(z.string()),
  area: z.enum(CHECK_AREAS).optional(),
  picture: z.object({ file: z.string(), width: z.number(), height: z.number(), what: z.string() }).nullable(),
  status: z.enum(CARD_STATUSES),
  feedback: z.object({ verdict: z.enum(FEEDBACK_VERDICTS), reason: z.string().optional(), at: z.string() }).optional(),
  ticket: z.object({ tracker: z.enum(["github", "jira"]), ref: z.string(), url: z.string() }).optional(),
  technical: z.object({ category: z.string(), evidence: z.string().optional(), route: z.string() }),
  firstSeen: z.string(),
  timesSeen: z.number(),
});

const CARDS_OUTPUT = {
  cards: z.array(PLAIN_CARD_OUTPUT),
  total: z.number(),
  notABug: z.number(),
  missing: z.array(z.string()),
};

const FEEDBACK_OUTPUT = {
  findingId: z.string().optional(),
  verdict: z.enum(FEEDBACK_VERDICTS).optional(),
  candidates: z
    .array(
      z.object({
        findingId: z.string(),
        verdict: z.enum(FEEDBACK_VERDICTS),
        reason: z.string().optional(),
        at: z.string(),
        suggests: z.enum(["non-defect", "defect"]),
        title: z.string(),
        category: z.string(),
        severity: z.enum(["high", "medium", "low"]),
        route: z.string(),
        evidence: z.string().optional(),
      }),
    )
    .optional(),
};

/** What scout_team_report's structuredContent carries (design 3.2's TeamReport, with the page's and the folder's absolute paths). */
const TEAM_REPORT_OUTPUT = {
  file: z.string(),
  evidenceDir: z.string(),
  manifest: z.array(z.object({ file: z.string(), sha256: z.string() })),
  problems: z.number(),
  pictures: z.number(),
  missingPictures: z.number(),
  path: z.string(),
  folder: z.string(),
};

export function registerResultTools(): void {
  server.registerTool(
    "scout_coverage",
    {
      description:
        "Show exploration coverage: states visited, which elements remain unexercised, which options of a dropdown used this run no session has chosen yet, and which forms seen this run no session has submitted with every text field blank. Use to decide where to explore next and when the level's budget is satisfied. In a parallel run it shows this session's own work by default — the routes it reached this run and the forms it saw — so one lane is not handed another's gaps; scope:\"project\" shows every session's, each form and route tagged with the sessions that saw it.",
      inputSchema: {
        scope: z
          .enum(["session", "project"])
          .optional()
          .describe(
            "'session': only the routes this session reached this run and the forms it saw. 'project': every route in the memory, across runs and sessions. Default: 'session' when other sessions share this project, else 'project'.",
          ),
        session: sessionParam,
      },
    },
    serializedPerSession("scout_coverage", async (args: { scope?: "session" | "project"; session?: string }, session) => {
      try {
        const eng = engineFor(session);
        const memory = eng.memory;
        if (!memory) throw new Error("Not attached.");
        const shared = [...engines.values()].some((e) => e !== eng && e.memory === memory);
        const unvisited = eng.unvisitedKnownRoutes();
        const lines = [
          ...(memory.lastSaveError
            ? [
                `⚠ MEMORY WRITE FAILING: ${memory.lastSaveError} — coverage/findings since the last successful write are NOT persisted to disk. If this doesn't clear on its own, check the project directory still exists and is writable.`,
              ]
            : []),
          ...coverageView(memory, eng.sessionKey, args.scope ?? (shared ? "session" : "project"), formatRouteCoverage(eng.allKnownRoutes(), unvisited)),
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
        history: z
          .enum(["index", "full"])
          .default("index")
          .describe(
            "How much of the history to print. 'index' lists findings from earlier runs, and resolved ones, as a row each: id, severity, age, title. 'full' prints every one in full as before — on one project that was 1.75 MB against 113 KB, nearly half of it findings already fixed. Use 'full' when handing the document to someone who has no access to the memory.",
          ),
        report: z
          .enum(REPORT_AUDIENCES)
          .default(DEFAULT_REPORT_AUDIENCE)
          .describe(
            "Which parts the report carries. 'both' (default): a plain-language section first — a short summary, then each problem with numbered steps, what was expected, what happened, its picture and its impact (blocks users, annoying, cosmetic), each with its technical detail folded beneath — followed by the technical report. 'qa': the plain section alone, for a tester or anyone not technical. 'dev': the technical report alone, as before the plain section existed. It applies to the files this call writes; the live view always shows both.",
          ),
        session: sessionParam,
      },
    },
    serializedPerSession(
      "scout_report",
      async (
        { force, level, history, report }: { force?: boolean; level?: "minimal" | "medium" | "extensive"; history?: "index" | "full"; report?: ReportAudience },
        session,
      ) => {
        try {
          const eng = engineFor(session);
          if (!eng.memory) throw new Error("Not attached.");
          // A ci run notes the earlier run it started from in its own process: the report names it.
          eng.memory.foldInFromRuns();
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
          // Counted across every session on this project, not just the one
          // asking: in a parallel run the lanes audit and the planner reports.
          const auditsThisRun = eng.memory.auditsThisRun;
          if (auditsThisRun === 0) {
            gates.push(
              `No scout_design_audit was run in this run, by any session — run it on at least one representative page (visual/a11y coverage is part of every level).`,
            );
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
            designAudits: auditsThisRun,
            unvisitedRoutes: unvisited,
            knownRoutes: all,
            mode: eng.mode,
          });
          if (lvl === "extensive" && gapList.length > 0) {
            gates.push(
              `Level 'extensive' claims completeness, so it refuses while the GAP LEDGER is non-empty:\n` +
                (eng.mode === "observe"
                  ? `(observe mode blocks every form submission, so the unsubmitted-forms gap cannot be closed in this mode: report at level 'medium', which discloses it.)\n`
                  : "") +
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
          const {
            path: p,
            summary,
            html,
          } = generateReport(eng.memory, eng.oracleLog.all, {
            history,
            report,
            routesVisited: all.length - unvisited.length,
            routesTotal: all.length,
            designAudits: auditsThisRun,
            createdResources: eng.createdResources,
            unvisitedRoutes: unvisited,
            knownRoutes: all,
            mode: eng.mode,
            trustedEmbeds: [...eng.trustedEmbeds],
            readPosts: eng.readPosts.map((e) => e.entry),
            policyAttributed: eng.oracleLog.policyAttributed,
            // Which sessions are still open decides whether a quiet one is holding a browser, and how long its trailing idle runs.
            attachedSessions: [...engines.keys()],
          });
          void p;
          // A guided check's report is written: its progress says done once nothing is running.
          const carried = guidedSessions.get(session)?.planId;
          if (carried) guidedRuns.reported(carried);
          // What this run left, for a later run to continue or replay from (--from-run). Never fatal: the report is written.
          try {
            eng.memory.addRunRecord(runRecordOf(eng.memory, all, gapList));
          } catch (err) {
            logLine(`the run's record could not be kept, so a later run cannot continue from it: ${err instanceof Error ? err.message : String(err)}`);
          }
          const openNote = html && openDecisions.get(session)?.report ? openForUser("the report", html) : "";
          return text(summary + openNote, session);
        } catch (err) {
          return errorText(err);
        }
      },
    ),
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
    "scout_verify",
    {
      description:
        'Re-test findings earlier runs left open. With no arguments, returns the open findings in the order to re-test them — worst route first, grouped so a route is walked once — each with its evidence and repro steps. Pass ids to narrow it to specific findings. After re-testing one, call again with id and verdict to record what you saw: "gone" resolves it, "present" stamps it confirmed so the report stops calling it unverified, "changed" keeps it open and says the behaviour differs. Use after a fix wave, or at the start of a run against an app this project has tested before.',
      inputSchema: {
        id: z.string().optional().describe("The finding being verified. Omit to get the worklist."),
        verdict: z.enum(VERDICTS).optional().describe('What the re-test found: "gone", "present" or "changed". Requires id.'),
        note: z.string().max(500).optional().describe("What you saw, in a sentence. Shown in the report beside the verdict."),
        ids: z.array(z.string()).max(50).optional().describe("Narrow the worklist to these finding ids."),
        session: sessionParam,
      },
    },
    serializedPerSession("scout_verify", async ({ id, verdict, note, ids }: { id?: string; verdict?: Verdict; note?: string; ids?: string[] }, session) => {
      try {
        const eng = engineFor(session);
        if (!eng.memory) throw new Error("Not attached.");
        if (verdict && !id) return text(`Pass the finding the verdict is about: scout_verify { id: "a1b2c3d4e5", verdict: "${verdict}" }.`, session);
        if (id && !verdict) {
          return text(`Pass what the re-test found: scout_verify { id: "${id}", verdict: "gone" | "present" | "changed" }.`, session);
        }
        if (id && verdict) {
          const f = eng.memory.verifyFinding(id, verdict, note);
          if (!f) return text(`No finding with id ${id}.`, session);
          return text(describeVerdict(f, verdict, note), session);
        }
        const findings = eng.memory.findings;
        const missing = ids && ids.length > 0 ? unknownIds(findings, ids) : [];
        return text(formatWorklist(verifyWorklist(findings, ids), missing), session);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  // Answering the tickets: read their acceptance criteria, then record a verdict on each.
  server.registerTool(
    "scout_tickets",
    {
      description:
        "Read the tickets or acceptance criteria the person gave this run, pasted (`text`) or from a file (`path`), and keep them so the report answers each criterion: passed, failed or not tested. " +
        'Recognises Given/When/Then scenarios, checklists, numbered and "AC1:" criteria, and lists under an "Acceptance criteria" heading; several tickets may be given at once. ' +
        "A ticket with no recognisable criteria is reported as such, never guessed at. Returns each criterion's id (AC1, AC2, …) to judge it by with scout_criterion. Touches no browser.",
      inputSchema: {
        text: z.string().max(MAX_TICKET_TEXT).optional().describe("The tickets as pasted. Pass this or `path`."),
        path: z
          .string()
          .optional()
          .describe(
            `A ticket file to read (${TICKET_FILE_EXTENSIONS.join(", ")}), absolute or relative to the project folder, and inside it unless the server's ${TICKET_DIRS_ENV} names the folder it is in. Pass this or \`text\`.`,
          ),
        session: sessionParam,
      },
    },
    serializedPerSession("scout_tickets", async ({ text: pasted, path: file }: { text?: string; path?: string }, session) => {
      try {
        const eng = engineFor(session);
        if (!eng.memory) throw new Error("Not attached — attach first, so the tickets are kept with the project.");
        if ((pasted === undefined) === (file === undefined)) return text("Pass the tickets as `text`, or a file as `path`: one of the two.", session);
        let body = pasted ?? "";
        let source = "pasted text";
        if (file !== undefined) {
          // The file a link points at is what is read, so where it is and its name are what is checked:
          // inside the project, or a folder SCENESCOUT_TICKET_DIRS names, and a "notes.md" link to a key file is refused.
          const found = ticketFileFor(file, path.dirname(eng.memory.dir), process.env);
          if ("refused" in found) return text(found.refused, session);
          const full = found.file;
          if (!isTicketFileName(full))
            return text(`Not read: a ticket file is one of ${TICKET_FILE_EXTENSIONS.join(", ")}. Paste anything else as \`text\`.`, session);
          const stat = fs.statSync(full);
          if (!stat.isFile()) return text(`Not read: ${full} is not a file.`, session);
          if (stat.size > MAX_TICKET_FILE_BYTES) return text(`Not read: ${full} is larger than ${MAX_TICKET_FILE_BYTES} bytes.`, session);
          body = fs.readFileSync(full, "utf8");
          source = path.basename(full);
        }
        if (!body.trim()) return text("Nothing to read: the tickets are empty.", session);
        const parsed = parseTickets(body, source);
        const kept = eng.memory.addTickets(parsed);
        // Say what a bound left out, so a long backlog is never answered in part without a word.
        const cuts = [
          ...(body.length > MAX_TICKET_TEXT ? [`only the first ${MAX_TICKET_TEXT} characters were read`] : []),
          ...(parsed.length >= MAX_TICKETS ? [`at most ${MAX_TICKETS} tickets are read at once`] : []),
        ];
        return text(formatReading(kept) + (cuts.length ? `\n\n⚠ Not everything was read: ${cuts.join("; ")}. Read the rest in another call.` : ""), session);
      } catch (err) {
        return errorText(err);
      }
    }),
  );

  server.registerTool(
    "scout_criterion",
    {
      description:
        "Record whether one acceptance criterion of a ticket read with scout_tickets passed, failed or was not tested, with how sure you are. " +
        "The link from a criterion to the findings that show it is YOUR judgement, stated with a confidence — never matched on words. " +
        'A "fail" names the findings that show it (file them with scout_finding first); "not-tested" says why in untestedBecause. Recording the same criterion again from the same session replaces your earlier verdict. Touches no browser.',
      inputSchema: {
        ticket: z.string().min(1).describe('The ticket\'s id as scout_tickets gave it, e.g. "PROJ-12" or "T1"'),
        criterion: z.string().min(1).describe('The criterion\'s id, e.g. "AC2" (or just "2")'),
        verdict: z.enum(CRITERION_VERDICTS).describe('"pass", "fail" or "not-tested"'),
        findings: z
          .array(z.string())
          .max(MAX_CRITERION_FINDINGS)
          .optional()
          .describe("Ids of the findings that show this criterion failing (required for a fail; may be given for a pass, none for not-tested)"),
        confidence: z.number().min(0).max(1).describe("How sure you are of this verdict and of the findings linked to it, from 0 to 1. State it honestly"),
        reason: z.string().min(1).max(MAX_REASON).describe("What you saw, or why it could not be tried, in a sentence"),
        untestedBecause: z
          .enum(NOT_TESTED_REASONS)
          .optional()
          .describe(
            'Only with verdict "not-tested": "no-access" (the role this run used could not reach it), "observe-blocked" (it needs a change sent and this session is in observe mode), "out-of-scope" (it is outside what this run could check, such as an email or another system)',
          ),
        session: sessionParam,
      },
    },
    serializedPerSession(
      "scout_criterion",
      async (
        args: {
          ticket: string;
          criterion: string;
          verdict: CriterionVerdictKind;
          findings?: string[];
          confidence: number;
          reason: string;
          untestedBecause?: NotTestedReason;
        },
        session,
      ) => {
        try {
          const eng = engineFor(session);
          const memory = eng.memory;
          if (!memory) throw new Error("Not attached.");
          const judged = judgeCriterion(args, {
            tickets: memory.tickets,
            findings: memory.findings,
            mode: eng.mode,
            session: eng.sessionKey,
            at: new Date().toISOString(),
          });
          if (!judged.ok) return text(`Not recorded: ${judged.reason}.`, session);
          memory.addCriterionVerdict(judged.record);
          const r = judged.record;
          const ticket = memory.tickets.find((t) => t.id === r.ticket);
          const criterion = ticket ? findCriterion(ticket, r.criterion) : undefined;
          const linked = r.findings.map((id) => memory.findings.find((f) => f.id === id)).filter((f) => f !== undefined);
          const said = r.verdict === "pass" ? "passes" : r.verdict === "fail" ? "fails" : `was not tested (${r.untestedBecause})`;
          return text(
            [
              `Recorded: ${r.ticket} ${r.criterion} ${said}, confidence ${r.confidence.toFixed(2)}.`,
              ...(criterion ? [`  ${criterion.text}`] : []),
              ...linked.map((f) => `  linked: [${f.severity}] ${f.title} (${f.id})`),
            ].join("\n"),
            session,
          );
        } catch (err) {
          return errorText(err);
        }
      },
    ),
  );

  // Findings as cards a person reads, and the person's own label on one (design 3.3 and 3.4).
  // Neither touches a browser or waits behind a session's calls: they read and label the project's memory.
  server.registerTool(
    "scout_cards",
    {
      title: "Finding cards",
      description:
        "Show the project's findings as plain cards, worst first: impact (Blocks users, Annoying, Cosmetic, Worth a look), title, what kind of problem, the page, numbered steps, what was expected, what happened, and the finding id. " +
        "Use it at the end of a guided check, or whenever the person wants to read what was found in plain words; post each card's text as it is. " +
        'By default fixed findings and the ones the person marked not a bug are left out (the count of the second is given; filter {feedback: ["not-a-bug"]} lists them). Pass ids to show exactly those. ' +
        'pictures: "inline" puts each card\'s picture in the result as an image (at most 10, at most 1024 px on the longer side), "files" (default) names each picture\'s file, "none" leaves them out. Touches no browser.',
      inputSchema: {
        filter: z
          .object({
            impact: z.array(z.enum(CARD_IMPACTS)).max(CARD_IMPACTS.length).optional().describe("Only these impacts"),
            area: z.array(z.enum(CHECK_AREAS)).max(CHECK_AREAS.length).optional().describe("Only findings found while checking these areas of a guided check"),
            status: z
              .array(z.enum(CARD_STATUSES))
              .max(CARD_STATUSES.length)
              .optional()
              .describe('Only these: "open", "fixed", "still-there", "changed". Default: all but fixed'),
            feedback: z
              .array(z.enum(CARD_FEEDBACK))
              .max(CARD_FEEDBACK.length)
              .optional()
              .describe('Only these labels: "not-a-bug", "confirmed", or "none" for no label. Default: all but not-a-bug'),
          })
          .optional()
          .describe("Narrow the cards. Omitted parts take their defaults"),
        ids: z.array(z.string().max(40)).max(MAX_CARDS).optional().describe("Show exactly these finding ids, whatever their status or label"),
        limit: z.number().int().min(1).max(MAX_CARDS).optional().describe(`How many cards at most (default 20, at most ${MAX_CARDS})`),
        pictures: z
          .enum(["inline", "files", "none"])
          .optional()
          .describe('"inline": each picture as an image in the result; "files" (default): its file; "none"'),
      },
      outputSchema: CARDS_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ filter, ids, limit, pictures }: { filter?: CardFilter; ids?: string[]; limit?: number; pictures?: "inline" | "files" | "none" }) => {
      try {
        const memory = projectEngine()?.memory;
        if (!memory) throw new Error("No project is open yet: findings are read from the project a session attached to, so attach first.");
        const chosen = selectCards(memory.findings, { filter, ids, limit });
        const mode = pictures ?? "files";
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        const head =
          chosen.total === 0
            ? "No findings match."
            : `${chosen.total} finding${chosen.total === 1 ? "" : "s"}${chosen.cards.length < chosen.total ? `, the first ${chosen.cards.length} shown` : ""}, worst first.`;
        const extra = [
          chosen.notABug > 0
            ? `${chosen.notABug} marked not a bug ${chosen.notABug === 1 ? "is" : "are"} left out: filter {feedback: ["not-a-bug"]} shows ${chosen.notABug === 1 ? "it" : "them"}.`
            : "",
          chosen.missing.length > 0 ? `No finding with id ${chosen.missing.join(", ")}.` : "",
        ].filter(Boolean);
        content.push({ type: "text", text: [head, ...extra].join("\n") });
        let shown = 0;
        for (const card of chosen.cards) {
          const file = mode === "files" && card.picture ? path.join(memory.dir, card.picture.file) : undefined;
          content.push({ type: "text", text: cardText(card, file) });
          if (mode !== "inline" || !card.picture) continue;
          if (shown >= MAX_INLINE_PICTURES) {
            content.push({ type: "text", text: `(Picture not shown: this call already shows ${MAX_INLINE_PICTURES}. Ask for this card by its id to see it.)` });
            continue;
          }
          const got = readInlinePicture(memory.dir, card.picture.file);
          if ("image" in got) {
            content.push(got.image);
            shown += 1;
          } else content.push({ type: "text", text: `(Picture not shown: ${got.why}.)` });
        }
        return { content, structuredContent: { ...chosen } };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "scout_feedback",
    {
      title: "Label a finding",
      description:
        'Record the person\'s own verdict on a finding: "not-a-bug" or "confirmed", with their reason if they gave one (at most 300 characters). Call it only with what the person said; never label a finding yourself. ' +
        "The finding is kept either way, keeps its id, and a later filing of the same problem still merges into it; cards and the status pane list a not-a-bug one apart. " +
        "export: true instead lists every label in the project as candidates for a maintainer to review: they never change an answer key or the dedup by themselves. Touches no browser.",
      inputSchema: {
        id: z.string().max(40).optional().describe("The finding the person is labelling. Required unless export"),
        verdict: z.enum(FEEDBACK_VERDICTS).optional().describe('"not-a-bug" or "confirmed". Required unless export'),
        reason: z.string().max(MAX_FEEDBACK_REASON).optional().describe("Why, in the person's words"),
        export: z.boolean().optional().describe("List every label as candidates for a maintainer, instead of labelling"),
      },
      outputSchema: FEEDBACK_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, verdict, reason, export: list }: { id?: string; verdict?: FeedbackVerdict; reason?: string; export?: boolean }) => {
      try {
        const memory = projectEngine()?.memory;
        if (!memory) throw new Error("No project is open yet: labels are kept on the project a session attached to, so attach first.");
        if (list) {
          if (id !== undefined || verdict !== undefined) throw new Error("pass export alone, or id and verdict to label a finding");
          const candidates = feedbackCandidates(memory.findings);
          const lines =
            candidates.length === 0
              ? ["No finding has a label yet."]
              : [
                  CANDIDATES_NOTE,
                  "",
                  ...candidates.map(
                    (c) =>
                      `- ${c.findingId} ${c.verdict} (suggests a ${c.suggests}): [${c.severity}] ${c.title} on ${c.route}${c.reason ? ` - "${c.reason}"` : ""}`,
                  ),
                ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: { candidates } };
        }
        if (!id || !verdict) throw new Error('pass the finding and the person\'s verdict: scout_feedback {id: "a1b2c3d4e5", verdict: "not-a-bug"}');
        const f = memory.setFeedback(id, verdict, reason);
        if (!f) throw new Error(`no finding with id ${id} in this project`);
        return {
          content: [{ type: "text" as const, text: `${f.title} (${f.id}): ${FEEDBACK_SAYS[verdict]}` }],
          structuredContent: { findingId: f.id, verdict },
        };
      } catch (err) {
        return errorText(err);
      }
    },
  );
  server.registerTool(
    "scout_team_report",
    {
      title: "Make a team report",
      description:
        "Write the team report: the plain report made for sharing, as one page that opens in any browser. It has a cover (the site, the date, what was checked, the care level and how thorough), a short summary, each problem this check found as a plain card with its picture, the ones the person marked not a bug listed apart, what the check did not test, and blank sign-off lines. " +
        "Beside it, an evidence folder holds the pictures, the report as Markdown and manifest.json with every file's SHA-256, the SceneScout version and the check's times. " +
        "Writes only inside the project's .scenescout/ folder (team-report.html and team-report/), replacing the last team report; sends nothing anywhere and touches no browser. Tell the person where the page is.",
      inputSchema: {},
      outputSchema: TEAM_REPORT_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const eng = projectEngine();
        const memory = eng?.memory;
        if (!eng || !memory) throw new Error("No project is open yet: the report is made from the project a session attached to, so attach first.");
        const unvisited = eng.unvisitedKnownRoutes();
        const all = eng.allKnownRoutes();
        const gaps = computeGaps(memory, {
          routesVisited: all.length - unvisited.length,
          routesTotal: all.length,
          designAudits: memory.auditsThisRun,
          unvisitedRoutes: unvisited,
          knownRoutes: all,
          mode: eng.mode,
        });
        // A guided check on show, carried by this project's session: its address, areas and thoroughness go on the cover.
        const focused = guidedRuns.focused;
        const carried = focused && [...guidedSessions.entries()].some(([name, s]) => s.planId === focused && engines.get(name) === eng);
        const plan = carried ? guidedPlans.get(focused) : undefined;
        const data = teamReportData({
          findings: memory.findings,
          sessionStart: memory.sessionStart,
          lastFrames: lastFrames(memory),
          violations: eng.oracleLog.all.filter((v) => !v.embed),
          routes: all.length > 0 ? { visited: all.length - unvisited.length, total: all.length } : undefined,
          gaps,
          mode: eng.mode,
          address: plan?.choices.address ?? eng.baseUrl,
          ...(plan ? { guided: { areas: plan.choices.areas, thoroughness: plan.choices.thoroughness } } : {}),
          version: PKG_VERSION,
          generatedAt: new Date().toISOString(),
        });
        const report = writeTeamReport(memory.dir, data);
        return { content: [{ type: "text" as const, text: teamReportText(report) }], structuredContent: { ...report } };
      } catch (err) {
        return errorText(err);
      }
    },
  );
}
