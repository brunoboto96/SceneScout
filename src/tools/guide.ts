/**
 * The method and the start: scout_playbook, scout_intake, the guided plan and its confirmation (scout_guided_plan,
 * scout_guided_confirm), and the MCP prompts that start a run, show the live view or sign in.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError, type ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formElicitationSupported, INTAKE_FORM_MESSAGE, INTAKE_TOOL, intakeFormSchema, intakeFromForm, intakeReplyText, type FormOutcome } from "../intake.js";
import {
  buildGuidedPlan,
  CARES,
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
import { CONFIRM_SAYS } from "../engine/guided-words.js";
import { EXPLORE_PROMPT_ARGUMENTS, explorePrompt, loadPlaybook, PLAYBOOK_PROMPT, PLAYBOOK_TOOL } from "../playbook.js";
import {
  GUIDED_PROMPTS,
  guidedPromptText,
  livePrompt,
  loginPrompt,
  LOGIN_PROMPT,
  LIVE_PROMPT,
  LOGIN_PROMPT_ARGUMENTS,
  LIVE_PROMPT_ARGUMENTS,
} from "../prompts.js";

import { PACKAGE_ROOT, server, errorText, guidedPlans, guidedRuns } from "../server-context.js";

// The guided start as one form, where the client can show one (MCP
// elicitation, form mode); otherwise, or when the person declines or closes it,
// the plain questions come back as text for the agent to ask in chat. The
// mapping is intake.ts's and the plan guided.ts's; this only shows the forms
// and reports how they ended.
/** How long a form waits for the person before the tool gives up on it. */
const FORM_WAIT_MS = 10 * 60_000;

export const GUIDED_PLAN_TOOL = "scout_guided_plan";
export const GUIDED_CONFIRM_TOOL = "scout_guided_confirm";

/** What the SDK hands a handler that a form needs: the call's signal and id, so the form ends with the call. */
type FormExtra = { signal: AbortSignal; requestId: string | number };

/**
 * Show the person a form through the client and report how it ended. Only a
 * client that declared form-mode elicitation is sent one; a failed form is
 * reported, never retried, and never read as an answer.
 */
async function askWithForm(message: string, requestedSchema: object, extra: FormExtra, tool: string): Promise<ConfirmFormOutcome> {
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

const GUIDED_CALL_OUTPUT = z.object({ tool: z.enum(["scout_login", "scout_attach", "scout_tickets", "scout_session"]), args: z.record(z.unknown()) });

/** A GuidedPlan, as scout_guided_plan's structuredContent. */
const GUIDED_PLAN_OUTPUT = {
  planId: z.string(),
  choices: z.object({
    address: z.string(),
    areas: z.array(z.enum(CHECK_AREAS)),
    journey: z.string().optional(),
    tickets: z.array(z.string()).optional(),
    signIn: z.enum(["none", "sso", "password", "one-time-code"]),
    care: z.enum(CARES),
    thoroughness: z.enum(THOROUGHNESSES),
  }),
  mode: z.enum(["observe", "read-only", "safe-write"]),
  level: z.enum(["minimal", "medium", "extensive"]),
  objective: z.string(),
  areas: z.array(z.object({ area: z.enum(CHECK_AREAS), label: z.string(), whatHappens: z.string(), heldBack: z.string().optional() })),
  confirm: z.object({ reason: z.enum(["creates-data", "forms-on-remote-site"]), sentence: z.string(), accepted: z.boolean() }).nullable(),
  tellPerson: z.array(z.string()),
  calls: z.array(GUIDED_CALL_OUTPUT),
  budget: z.object({ minutes: z.number(), pages: z.number() }),
};

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
        const outcome = await askWithForm(INTAKE_FORM_MESSAGE, intakeFormSchema(url), extra, INTAKE_TOOL);
        const reply = intakeFromForm(outcome as FormOutcome);
        if (reply.kind !== "choices") return { content: [{ type: "text" as const, text: intakeReplyText(reply) }] };
        const plan = guidedPlans.add(buildGuidedPlan(reply.choices));
        guidedRuns.focus(plan.planId);
        // A care level that needs the person's confirmation asks for it now, in a second form, so the person answers both in one go.
        const confirmed = plan.confirm ? await confirmWithPerson(plan.planId, extra) : null;
        const now = guidedPlans.get(plan.planId)!;
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
        "Once any plan is built, every scout_attach above observe must name an accepted plan's planId. Touches no browser.",
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
          plan = kept;
        } else {
          const built = guidedPlan(choices);
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
        const now = guidedPlans.get(plan.planId)!;
        return {
          content: [{ type: "text" as const, text: confirmedText(now, verdict) }],
          structuredContent: { planId: now.planId, accepted: verdict.accepted, outcome: verdict.outcome, tellPerson: verdict.tellPerson, mode: now.mode },
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
      // No care cap is passed: this server has no operator setting for one yet. guidedPromptText takes it as { maxCare }.
      else if (GUIDED_PROMPTS.some((p) => p.name === name)) message = guidedPromptText(name, request.params.arguments);
      else throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: message } }] };
  });
}
