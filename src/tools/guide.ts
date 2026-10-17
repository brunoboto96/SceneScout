/**
 * The method and the start: scout_playbook, scout_intake, the guided plan and its confirmation (scout_guided_plan,
 * scout_guided_confirm), and the MCP prompts that start a run, show the live view or sign in.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import fs from "node:fs";
import path from "node:path";
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError, type ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formElicitationSupported, INTAKE_FORM_MESSAGE, INTAKE_TOOL, intakeFormSchema, intakeFromForm, intakeReplyText, type FormOutcome } from "../intake.js";
import {
  buildGuidedPlan,
  buildRecheckPlan,
  checkAddress,
  recheckCandidates,
  recheckSpec,
  SIGN_INS,
  CARES,
  checkGuidedChoices,
  savedSignInHealth,
  withSignInHealth,
  type GuidedChoices,
  type SignInHealth,
  CHECK_AREAS,
  confirmForm,
  confirmVerdict,
  guidedPlan,
  guidedPlanText,
  isPlanId,
  MAX_ADDRESS,
  MAX_JOURNEY,
  MAX_TICKET_CHARS,
  MAX_TICKETS,
  newConfirmCode,
  THOROUGHNESSES,
  type ConfirmFormOutcome,
  type ConfirmVerdict,
  type GuidedPlan,
} from "../engine/guided.js";
import { CONFIRM_SAYS, SAVED_WORDS } from "../engine/guided-words.js";
import { MEMORY_DIRNAME } from "../engine/memory-dir.js";
import type { Finding } from "../engine/memory.js";
import {
  deleteSavedCheckReply,
  listSavedChecks,
  MAX_SAVED_NAME,
  readSavedCheck,
  savedCheckFrom,
  savedChecksDir,
  writeSavedCheck,
  type SavedCheck,
} from "../engine/saved-checks.js";
import { MAX_WORKLIST, wellFormedFindings } from "../engine/verify.js";
import { EXPLORE_PROMPT_ARGUMENTS, explorePrompt, loadPlaybook, PLAYBOOK_PROMPT, PLAYBOOK_TOOL } from "../playbook.js";
import {
  GUIDED_PROMPTS,
  guidedPromptOptions,
  guidedPromptText,
  livePrompt,
  loginPrompt,
  LOGIN_PROMPT,
  LIVE_PROMPT,
  LOGIN_PROMPT_ARGUMENTS,
  LIVE_PROMPT_ARGUMENTS,
} from "../prompts.js";

import { PACKAGE_ROOT, server, engines, errorText, guidedPlans, guidedRuns, guidedSessions, operatorPolicy, projectEngine } from "../server-context.js";
import { projectFolderFor } from "./sessions.js";

// The guided start as one form, where the client can show one (MCP
// elicitation, form mode); otherwise, or when the person declines or closes it,
// the plain questions come back as text for the agent to ask in chat. The
// mapping is intake.ts's and the plan guided.ts's; this only shows the forms
// and reports how they ended.
/** How long a form waits for the person before the tool gives up on it. */
const FORM_WAIT_MS = 10 * 60_000;

export const GUIDED_PLAN_TOOL = "scout_guided_plan";
export const GUIDED_CONFIRM_TOOL = "scout_guided_confirm";
export const RECHECK_PLAN_TOOL = "scout_recheck_plan";
export const SAVED_CHECKS_TOOL = "scout_saved_checks";

/** What the SDK hands a handler that a form needs: the call's signal and id, so the form ends with the call. */
export type FormExtra = { signal: AbortSignal; requestId: string | number };

/**
 * Show the person a form through the client and report how it ended. Only a
 * client that declared form-mode elicitation is sent one; a failed form is
 * reported, never retried, and never read as an answer.
 */
export async function askWithForm(message: string, requestedSchema: object, extra: FormExtra, tool: string): Promise<ConfirmFormOutcome> {
  if (!formElicitationSupported(server.server.getClientCapabilities())) return { kind: "unsupported" };
  try {
    const result = await server.server.elicitInput(
      { mode: "form", message, requestedSchema: requestedSchema as ElicitRequestFormParams["requestedSchema"] },
      { timeout: FORM_WAIT_MS, signal: extra.signal, relatedRequestId: extra.requestId },
    );
    if (result.action === "accept") return { kind: "accepted", content: (result.content ?? {}) as Record<string, unknown> };
    return result.action === "decline" ? { kind: "declined" } : { kind: "cancelled" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[scenescout] ${tool}: the form failed: ${error}`);
    return { kind: "failed", error };
  }
}

/**
 * Ask the person to confirm a kept plan in the server's own form, and mark it
 * accepted only on their yes (ADR 24). A plan that needs no confirmation, or
 * one already accepted, is not asked about again.
 */
async function confirmWithPerson(planId: string, extra: FormExtra): Promise<ConfirmVerdict> {
  const plan = guidedPlans.get(planId);
  if (!plan) throw new Error(`no guided plan ${planId} is kept`);
  if (!plan.confirm) return confirmVerdict(plan, { kind: "cancelled" }, "");
  if (plan.confirm.accepted) return { accepted: true, outcome: "accepted", tellPerson: CONFIRM_SAYS.accepted };
  const code = newConfirmCode();
  const form = confirmForm(plan, code)!;
  const outcome = await askWithForm(form.message, form.requestedSchema, extra, GUIDED_CONFIRM_TOOL);
  const verdict = confirmVerdict(plan, outcome, code);
  if (verdict.accepted) guidedPlans.accept(planId, verdict);
  return verdict;
}

/** A confirmation's result as the agent reads it. */
function confirmedText(plan: GuidedPlan, verdict: ConfirmVerdict): string {
  const head = verdict.accepted
    ? `Guided plan ${plan.planId} is accepted: scout_attach may run in "${plan.mode}" on ${plan.choices.address} with planId "${plan.planId}".`
    : `Guided plan ${plan.planId} is NOT accepted (${verdict.outcome}): scout_attach above "observe" with it is refused. Do not call scout_guided_confirm again unless the person asks to try again.`;
  return `${head}\nTell the person: "${verdict.tellPerson}"`;
}

/**
 * Before a check with a sign-in starts: whether the sign-in saved in the
 * folder its attach will use lasts the check (design section 5 item 6).
 * A folder the attach would refuse has no saved sign-in to judge.
 */
async function signInHealthFor(choices: GuidedChoices): Promise<SignInHealth | undefined> {
  if (choices.signIn === "none") return undefined;
  const folder = await projectFolderFor(choices.address, undefined);
  if ("refused" in folder) return undefined;
  return savedSignInHealth(choices, path.resolve(folder.dir), { now: Date.now(), projectChosen: folder.source === "default", exists: fs.existsSync });
}

/** A kept plan as it is handed out to start: whether the saved sign-in lasts is judged now, not when the plan was built. */
async function judgedNow(plan: GuidedPlan): Promise<GuidedPlan> {
  return plan.choices.signIn === "none" ? plan : withSignInHealth(plan, await signInHealthFor(plan.choices));
}

const GUIDED_CALL_OUTPUT = z.object({
  tool: z.enum(["scout_login", "scout_attach", "scout_tickets", "scout_session", "scout_verify"]),
  args: z.record(z.unknown()),
});

/** A guided choice set, as a plan and a saved check carry it. */
const CHOICES_OUTPUT = z.object({
  address: z.string(),
  areas: z.array(z.enum(CHECK_AREAS)),
  journey: z.string().optional(),
  tickets: z.array(z.string()).optional(),
  signIn: z.enum(["none", "sso", "password", "one-time-code"]),
  care: z.enum(CARES),
  thoroughness: z.enum(THOROUGHNESSES),
});

/** A GuidedPlan, as scout_guided_plan's structuredContent. */
const GUIDED_PLAN_OUTPUT = {
  planId: z.string(),
  choices: CHOICES_OUTPUT,
  mode: z.enum(["observe", "read-only", "safe-write"]),
  level: z.enum(["minimal", "medium", "extensive"]),
  objective: z.string(),
  areas: z.array(z.object({ area: z.enum(CHECK_AREAS), label: z.string(), whatHappens: z.string(), heldBack: z.string().optional() })),
  confirm: z.object({ reason: z.enum(["creates-data", "forms-on-remote-site"]), sentence: z.string(), accepted: z.boolean() }).nullable(),
  tellPerson: z.array(z.string()),
  calls: z.array(GUIDED_CALL_OUTPUT),
  budget: z.object({ minutes: z.number(), pages: z.number() }),
  signInHealth: z
    .object({
      state: z.enum(["lasts", "may-run-out", "runs-out", "unknown", "none"]),
      sentence: z.string(),
      signInAgain: z.object({ label: z.string(), prompt: z.string(), command: z.string() }),
    })
    .optional(),
  recheck: z
    .object({
      ids: z.array(z.string()),
      foundIn: z.enum(CARES),
      leftOut: z.array(z.object({ id: z.string(), title: z.string(), why: z.enum(["looser-care", "other-site"]), care: z.enum(CARES) })),
    })
    .optional(),
};

/** scout_saved_checks' structuredContent: the project's saved checks, and the plan a run built. */
const SAVED_CHECKS_OUTPUT = {
  folder: z.string(),
  saved: z.array(z.object({ name: z.string(), choices: CHOICES_OUTPUT, savedAt: z.string(), lastRunAt: z.string().optional() })),
  refused: z.array(z.string()),
  plan: z.object(GUIDED_PLAN_OUTPUT).optional(),
};

/**
 * The project folder a re-check or a saved check reads, in this order: the
 * session carrying `planId`; an open session on `address`'s site; with no
 * address, the project a session attached to; else the folder an attach
 * there would choose (the client's workspace, or the folder kept per site).
 */
async function projectDirFor(address: string | undefined, planId?: string): Promise<string> {
  const carrying = planId ? [...guidedSessions.entries()].find(([, s]) => s.planId === planId) : undefined;
  const carried = carrying ? engines.get(carrying[0])?.memory : undefined;
  if (carried) return path.dirname(carried.dir);
  let site: string | undefined;
  if (address !== undefined) {
    const checked = checkAddress(address);
    if (!checked.ok) throw new Error(checked.error);
    site = new URL(checked.value).origin;
    for (const eng of engines.values()) {
      let origin = "";
      try {
        origin = new URL(eng.baseUrl).origin;
      } catch {
        // An engine with no base address is not on this site.
      }
      if (eng.memory && origin === site) return path.dirname(eng.memory.dir);
    }
  } else {
    const open = projectEngine()?.memory;
    if (open) return path.dirname(open.dir);
  }
  const folder = await projectFolderFor(site ?? "", undefined);
  if ("refused" in folder)
    throw new Error(
      site ? folder.refused : "No project is open yet: pass the site's address (address), so SceneScout can find the folder it keeps for that site.",
    );
  return path.resolve(folder.dir);
}

/** The findings kept in a project: an open session's memory, else its memory.json read as it is, never written. */
function findingsIn(projectDir: string): Finding[] {
  const dir = path.join(projectDir, MEMORY_DIRNAME);
  for (const eng of engines.values()) if (eng.memory && path.resolve(eng.memory.dir) === path.resolve(dir)) return eng.memory.findings;
  const file = path.join(dir, "memory.json");
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`the project's memory.json could not be read (${err instanceof Error ? err.message : String(err)}): attach once to repair it`);
  }
  const list = (raw as { findings?: unknown }).findings;
  return Array.isArray(list) ? wellFormedFindings(list) : [];
}

/** The saved checks of a folder, as the tool returns them. */
function savedList(dir: string): { folder: string; saved: SavedCheck[]; refused: string[] } {
  const { checks, refused } = listSavedChecks(dir);
  return { folder: savedChecksDir(dir), saved: checks, refused };
}

function savedListText(list: { saved: SavedCheck[]; refused: string[] }): string {
  const lines =
    list.saved.length === 0
      ? [SAVED_WORDS.none]
      : list.saved.map(
          (c) => `- ${c.name}: ${c.choices.address}, ${c.choices.care}${c.lastRunAt ? `, last run ${c.lastRunAt.slice(0, 10)}` : ", never run again"}`,
        );
  if (list.refused.length > 0) lines.push(`Not read, because they are not saved checks SceneScout can use: ${list.refused.join(", ")}.`);
  return lines.join("\n");
}

/** scout_guided_confirm's structuredContent. */
const GUIDED_CONFIRM_OUTPUT = {
  planId: z.string(),
  accepted: z.boolean(),
  outcome: z.enum(["not-needed", "accepted", "went-back", "wrong-code", "declined", "cancelled", "failed", "unsupported"]),
  tellPerson: z.string(),
  mode: z.enum(["observe", "read-only", "safe-write"]),
};

export function registerGuideTools(): void {
  // The method, for every client that has no skill loader. It is read per call,
  // not cached: a source checkout's skill file can change under a running server.
  server.registerTool(
    PLAYBOOK_TOOL,
    {
      description:
        "Return the SceneScout testing method: setup order, write modes, how to explore, what counts as done, how to report. " +
        "Call this ONCE before the first scout_attach in a conversation, then follow it. " +
        "If this client offers a SceneScout skill, load that instead — it is the same text, so never read both. Takes no input and touches no browser.",
      // No inputSchema on purpose: with one, a call that carries no `arguments` field is rejected as invalid.
    },
    async () => {
      try {
        return { content: [{ type: "text" as const, text: loadPlaybook(PACKAGE_ROOT) }] };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    INTAKE_TOOL,
    {
      title: "Start a guided check",
      description:
        "Ask how the person wants their site checked when they gave no settings. " +
        "Where this client can show a form, the person chooses there: the site's address, what to check, a journey or tickets, how they sign in, how careful to be and how thorough. " +
        "This then builds a guided plan, asks the person to confirm it in a second form when its care level needs that, and returns the plan: what to tell them, then the calls in order. " +
        "Otherwise, or when they decline or close the form, it returns four plain questions for you to ask in chat. Never asks for a password. Touches no browser.",
      inputSchema: {
        url: z.string().max(2048).optional().describe("The site's address, when the person already said it: the form starts with it filled in"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ url }: { url?: string }, extra) => {
      try {
        // The operator's config caps the care levels offered: one above its maxMode would only be refused at scout_attach.
        const maxMode = operatorPolicy.policy.maxMode;
        const outcome = await askWithForm(INTAKE_FORM_MESSAGE, intakeFormSchema(url, maxMode), extra, INTAKE_TOOL);
        const reply = intakeFromForm(outcome as FormOutcome, maxMode);
        if (reply.kind !== "choices") return { content: [{ type: "text" as const, text: intakeReplyText(reply) }] };
        const signInHealth = await signInHealthFor(reply.choices);
        const plan = guidedPlans.add(buildGuidedPlan(reply.choices, undefined, { maxMode, ...(signInHealth ? { signInHealth } : {}) }));
        guidedRuns.focus(plan.planId);
        // A care level that needs the person's confirmation asks for it now, in a second form, so the person answers both in one go.
        const confirmed = plan.confirm ? await confirmWithPerson(plan.planId, extra) : null;
        const now = await judgedNow(guidedPlans.get(plan.planId)!);
        // Turned down: the plan's steps would say to ask again and to attach in a mode the gate refuses, so only the offer of Look only is given.
        if (confirmed && !confirmed.accepted)
          return {
            content: [
              {
                type: "text" as const,
                text: `${confirmedText(now, confirmed)}\nNothing has started. If the person wants the same check in Look only, call scout_guided_plan with the same choices and care "look-only" and follow that plan instead.`,
              },
            ],
          };
        const lines = [
          "The person answered the form. Use this plan; do not ask the questions again.",
          ...(confirmed ? ["", confirmedText(now, confirmed)] : []),
          "",
          guidedPlanText(now),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    GUIDED_PLAN_TOOL,
    {
      title: "Build a guided plan",
      description:
        "Turn a person's guided choices into a plan in plain words: the write mode its care level is, what each area does and holds back, what to tell the person, the calls to make in order, and its time and page limits. " +
        "Pass `choices` to build a new plan, or `planId` to read one already built (a panel builds it and hands you only the id). " +
        "A plan whose care level writes on a site that is not on this computer, or that creates test data anywhere, is built unaccepted: scout_guided_confirm asks the person, and until they accept, scout_attach above observe is refused. " +
        "Once any plan is built, every scout_attach above observe must name an accepted plan's planId. A care level above the SceneScout config's maxMode is refused. Touches no browser.",
      inputSchema: {
        choices: z
          .object({
            address: z.string().max(MAX_ADDRESS).describe("The site's address, http(s), with no user name or password in it"),
            areas: z.array(z.enum(CHECK_AREAS)).min(1).max(CHECK_AREAS.length).describe("What to check, at least one"),
            journey: z.string().max(MAX_JOURNEY).optional().describe('With "journey": the journey to follow, in a sentence'),
            tickets: z.array(z.string().max(MAX_TICKET_CHARS)).max(MAX_TICKETS).optional().describe('With "tickets": each pasted ticket'),
            signIn: z.enum(["none", "sso", "password", "one-time-code"]).optional().describe("How the person signs in (default none). Never a password"),
            care: z
              .enum(CARES)
              .optional()
              .describe("How careful to be (default look-only). Only the person chooses this; never pick a writing care level yourself"),
            thoroughness: z.enum(THOROUGHNESSES).optional().describe("How thorough (default normal)"),
          })
          // Any other field is refused by checkGuidedChoices, which never repeats its name: it may be a value typed in the wrong place.
          .passthrough()
          .optional()
          .describe("The person's choices. Exactly one of choices or planId"),
        planId: z.string().max(20).optional().describe("A plan already built, to read it back. Exactly one of choices or planId"),
      },
      outputSchema: GUIDED_PLAN_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ choices, planId }: { choices?: Record<string, unknown>; planId?: string }) => {
      try {
        if ((choices === undefined) === (planId === undefined)) throw new Error("pass exactly one of choices (to build a plan) or planId (to read one)");
        let plan: GuidedPlan;
        if (planId !== undefined) {
          const kept = isPlanId(planId) ? guidedPlans.get(planId) : undefined;
          if (!kept) throw new Error("this server holds no guided plan with that id: build one with choices");
          plan = await judgedNow(kept);
        } else {
          const maxMode = operatorPolicy.policy.maxMode;
          const checked = checkGuidedChoices(choices, { maxMode });
          const health = checked.ok ? await signInHealthFor(checked.choices) : undefined;
          const built = guidedPlan(choices, undefined, { maxMode, health: () => health });
          if (!built.ok) throw new Error(built.error);
          plan = guidedPlans.add(built.plan);
          guidedRuns.focus(plan.planId);
        }
        return { content: [{ type: "text" as const, text: guidedPlanText(plan) }], structuredContent: { ...plan } };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    GUIDED_CONFIRM_TOOL,
    {
      title: "Ask the person to confirm a guided plan",
      description:
        "Ask the PERSON, through a form this server shows them, whether a guided plan whose care level writes may start: May submit forms on a site that is not on this computer, or May create test data anywhere (which also asks them to type a code the form shows). " +
        "You may make this call; you cannot answer it, and nothing you pass accepts a plan. The plan is accepted only when the person says yes in the form. " +
        "When they decline, close it, go back, mistype the code, or this client cannot show forms, the plan stays unaccepted and the result says so: tell the person, and offer the same check in Look only. Never retry it on their behalf. Touches no browser.",
      inputSchema: {
        planId: z.string().max(20).describe("The plan to confirm, as scout_guided_plan or scout_intake returned it"),
      },
      outputSchema: GUIDED_CONFIRM_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ planId }: { planId: string }, extra) => {
      try {
        const plan = isPlanId(planId) ? guidedPlans.get(planId) : undefined;
        if (!plan) throw new Error("this server holds no guided plan with that id: build one with scout_guided_plan");
        const verdict = await confirmWithPerson(plan.planId, extra);
        const now = await judgedNow(guidedPlans.get(plan.planId)!);
        return {
          content: [{ type: "text" as const, text: confirmedText(now, verdict) }],
          structuredContent: { planId: now.planId, accepted: verdict.accepted, outcome: verdict.outcome, tellPerson: verdict.tellPerson, mode: now.mode },
        };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    RECHECK_PLAN_TOOL,
    {
      title: "Plan a re-check after a fix",
      description:
        "Build a guided plan that checks again the problems earlier checks left open, and says which are gone, still there or changed. " +
        "It runs in the care level the problems were found in, never a looser one: problems found in a looser care level are left for a re-check of their own, and problems on another site for a re-check of that site. " +
        "It is a new plan: where its care level needs the person's confirmation, scout_guided_confirm asks them again, whatever an earlier check was given. Follow it as you would scout_guided_plan's: attach with its planId, then scout_verify. " +
        "By default every open problem but those the person marked not a bug, worst route first, at most 25; pass ids for exactly those. Touches no browser.",
      inputSchema: {
        ids: z
          .array(z.string().max(40))
          .max(MAX_WORKLIST)
          .optional()
          .describe("Re-check exactly these finding ids. Default: every open one but those marked not a bug"),
        signIn: z
          .enum(SIGN_INS as [string, ...string[]])
          .optional()
          .describe("How the person signs in to the site, as in the check that found them (default none). Never a password"),
        address: z
          .string()
          .max(MAX_ADDRESS)
          .optional()
          .describe(
            "The site, when no check has run in this conversation: its problems are read from the folder SceneScout keeps for it, and only those on it are re-checked",
          ),
      },
      outputSchema: GUIDED_PLAN_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ ids, signIn, address }: { ids?: string[]; signIn?: string; address?: string }) => {
      try {
        const dir = await projectDirFor(address);
        const { candidates, missing } = recheckCandidates(findingsIn(dir), ids, address);
        const maxMode = operatorPolicy.policy.maxMode;
        const spec = recheckSpec(candidates, {
          maxMode,
          ...(signIn ? { signIn: signIn as GuidedChoices["signIn"] } : {}),
          ...(address !== undefined ? { address } : {}),
        });
        if (!spec.ok) throw new Error(missing.length > 0 ? `${spec.error} No open finding has the id ${missing.join(", ")}.` : spec.error);
        const health = await signInHealthFor({
          address: spec.value.address,
          areas: [],
          signIn: spec.value.signIn,
          care: spec.value.care,
          thoroughness: "quick",
        });
        const plan = guidedPlans.add(buildRecheckPlan(spec.value, undefined, { maxMode, ...(health ? { signInHealth: health } : {}) }));
        guidedRuns.focus(plan.planId);
        const note = missing.length > 0 ? `\nNo open finding has the id ${missing.join(", ")}: it may already be fixed, or belong to another project.` : "";
        return { content: [{ type: "text" as const, text: guidedPlanText(plan) + note }], structuredContent: { ...plan } };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    SAVED_CHECKS_TOOL,
    {
      title: "The person's saved checks",
      description:
        "List, save, run or delete the person's saved guided checks. A saved check keeps the choices of a guided plan under a name (the address, what to check, the journey, how they sign in, the care level and how thorough), never a password, code, token or cookie, in the project's .scenescout/guided/ folder, readable by its owner only. " +
        '"save" takes a name and the planId of a plan built from choices (a re-check is not saved). "run" builds a new plan from a saved check, unaccepted: where its care level needs the person\'s confirmation, scout_guided_confirm asks them again. Follow that plan as scout_guided_plan\'s. ' +
        "\"delete\" removes one saved check's file and nothing else. With no check open in this conversation, pass the site's address so SceneScout finds its folder. Touches no browser.",
      inputSchema: {
        action: z.enum(["list", "save", "run", "delete"]).describe('"list", "save" (name and planId), "run" (name) or "delete" (name)'),
        name: z.string().max(MAX_SAVED_NAME).optional().describe("The saved check's name: letters, digits, spaces and dashes"),
        planId: z.string().max(20).optional().describe('With "save": the plan whose choices to keep'),
        address: z
          .string()
          .max(MAX_ADDRESS)
          .optional()
          .describe("The site, when no check has run in this conversation: its saved checks are in the folder SceneScout keeps for it"),
      },
      outputSchema: SAVED_CHECKS_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, name, planId, address }: { action: "list" | "save" | "run" | "delete"; name?: string; planId?: string; address?: string }) => {
      try {
        if (action !== "save" && planId !== undefined) throw new Error(`planId is for "save" only`);
        if (action === "list") {
          const list = savedList(await projectDirFor(address));
          return { content: [{ type: "text" as const, text: savedListText(list) }], structuredContent: { ...list } };
        }
        if (name === undefined) throw new Error(`"${action}" needs the saved check's name`);
        if (action === "save") {
          const plan = planId !== undefined && isPlanId(planId) ? guidedPlans.get(planId) : undefined;
          if (!plan) throw new Error("this server holds no guided plan with that id: save a check from its plan's id");
          const made = savedCheckFrom(plan, name, new Date().toISOString());
          if (!made.ok) throw new Error(made.error);
          const dir = await projectDirFor(address ?? plan.choices.address, plan.planId);
          const { replaced } = writeSavedCheck(dir, made.saved);
          const list = savedList(dir);
          return {
            content: [{ type: "text" as const, text: replaced ? SAVED_WORDS.replaced(made.saved.name) : SAVED_WORDS.saved(made.saved.name) }],
            structuredContent: { ...list },
          };
        }
        const dir = await projectDirFor(address);
        if (action === "delete") {
          const gone = deleteSavedCheckReply(dir, name);
          if (!gone.ok) throw new Error(gone.error);
          const list = savedList(dir);
          return { content: [{ type: "text" as const, text: gone.text }], structuredContent: { ...list } };
        }
        const read = readSavedCheck(dir, name);
        if (!read.ok) throw new Error(read.error);
        const maxMode = operatorPolicy.policy.maxMode;
        const health = await signInHealthFor(read.saved.choices);
        const built = guidedPlan(read.saved.choices, undefined, { maxMode, health: () => health });
        if (!built.ok) throw new Error(`the saved check "${read.saved.name}" cannot run here: ${built.error}`);
        // When it last ran is a convenience: a folder that cannot be written to does not stop the run.
        try {
          writeSavedCheck(dir, { ...read.saved, lastRunAt: new Date().toISOString() });
        } catch (err) {
          console.error(
            `[scenescout] ${SAVED_CHECKS_TOOL}: when "${read.saved.name}" last ran could not be kept: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const plan = guidedPlans.add(built.plan);
        guidedRuns.focus(plan.planId);
        const list = savedList(dir);
        return {
          content: [{ type: "text" as const, text: `${SAVED_WORDS.run(read.saved.name)}\n\n${guidedPlanText(plan)}` }],
          structuredContent: { ...list, plan: { ...plan } },
        };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // Prompts, for clients that list server prompts as commands. Registered on the
  // protocol server directly: the SDK's prompt helper rejects a request that
  // carries no `arguments` object, which is exactly what a client sends when the
  // person typed none. `explore`, `live` and the guided prompts accept that;
  // `login` then says the role is missing. None of them takes a password.
  server.server.registerCapabilities({ prompts: {} });

  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: PLAYBOOK_PROMPT,
        title: "Explore a web app with SceneScout",
        description: "Start an exploratory test session: loads the SceneScout method and states the target.",
        arguments: EXPLORE_PROMPT_ARGUMENTS,
      },
      {
        name: LIVE_PROMPT,
        title: "Watch the live view",
        description: "Return the loopback live-view URL for the current session. Takes no arguments and no password.",
        arguments: LIVE_PROMPT_ARGUMENTS,
      },
      {
        name: LOGIN_PROMPT,
        title: "Sign in as a role",
        description:
          "Call scout_login for a role and wait the way that tool waits. The person signs in in the window it opens. Takes the role, and the app URL when you have it. Never a password.",
        arguments: LOGIN_PROMPT_ARGUMENTS,
      },
      // The chat's guided entry points (design 3.5), titled in the guided panel's words.
      ...GUIDED_PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
    ],
  }));

  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const name = request.params.name;
    let message: string;
    try {
      if (name === PLAYBOOK_PROMPT) message = explorePrompt(loadPlaybook(PACKAGE_ROOT), request.params.arguments);
      else if (name === LIVE_PROMPT) message = livePrompt(request.params.arguments);
      else if (name === LOGIN_PROMPT) message = loginPrompt(request.params.arguments);
      // The operator's config caps the care levels a prompt offers, as it caps the intake form's.
      else if (GUIDED_PROMPTS.some((p) => p.name === name))
        message = guidedPromptText(name, request.params.arguments, guidedPromptOptions(operatorPolicy.policy.maxMode));
      else throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: message } }] };
  });
}
