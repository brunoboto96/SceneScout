/**
 * The method and the intake: scout_playbook, scout_intake and the MCP prompts that start a run, show the live view or sign in.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formElicitationSupported, INTAKE_FORM_MESSAGE, INTAKE_TOOL, intakeFormSchema, intakeFromForm, intakeReplyText, type FormOutcome } from "../intake.js";
import { EXPLORE_PROMPT_ARGUMENTS, explorePrompt, loadPlaybook, PLAYBOOK_PROMPT, PLAYBOOK_TOOL } from "../playbook.js";
import { livePrompt, loginPrompt, LOGIN_PROMPT, LIVE_PROMPT, LOGIN_PROMPT_ARGUMENTS, LIVE_PROMPT_ARGUMENTS } from "../prompts.js";

import { PACKAGE_ROOT, server, errorText } from "../server-context.js";

// The start-of-run questions as one form, where the client can show one (MCP
// elicitation, form mode); otherwise, or when the person declines or closes it,
// the questions come back as text for the agent to ask in chat. The mapping is
// intake.ts's; this only shows the form and reports how it ended.
/** How long the form waits for the person before the questions go back to chat. */
const INTAKE_FORM_WAIT_MS = 10 * 60_000;

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
      description:
        "Ask the start-of-run questions (the site's address, whether and how to sign in, what to check, whether the site holds real data) when the person gave no settings. " +
        "Where this client can show a form, the person answers there and this returns the settings to use: the scout_login and scout_attach calls, in order. " +
        "Otherwise, or when they decline or close the form, it returns the questions for you to ask in chat. Never asks for a password. Touches no browser.",
      inputSchema: {
        url: z.string().max(2048).optional().describe("The site's address, when the person already said it: the form starts with it filled in"),
      },
    },
    async ({ url }: { url?: string }, extra) => {
      let outcome: FormOutcome;
      if (!formElicitationSupported(server.server.getClientCapabilities())) outcome = { kind: "unsupported" };
      else {
        try {
          const result = await server.server.elicitInput(
            { mode: "form", message: INTAKE_FORM_MESSAGE, requestedSchema: intakeFormSchema(url) },
            { timeout: INTAKE_FORM_WAIT_MS, signal: extra.signal, relatedRequestId: extra.requestId },
          );
          outcome =
            result.action === "accept"
              ? { kind: "accepted", content: result.content ?? {} }
              : result.action === "decline"
                ? { kind: "declined" }
                : { kind: "cancelled" };
        } catch (err) {
          // A client that advertised forms and then failed one: the questions still get asked, in chat, with why.
          outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
          console.error(`[scenescout] ${INTAKE_TOOL}: the form failed, asking in chat instead: ${outcome.error}`);
        }
      }
      try {
        return { content: [{ type: "text" as const, text: intakeReplyText(intakeFromForm(outcome)) }] };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // Prompts, for clients that list server prompts as commands. Registered on the
  // protocol server directly: the SDK's prompt helper rejects a request that
  // carries no `arguments` object, which is exactly what a client sends when the
  // person typed none. `explore` and `live` accept that; `login` then says the
  // role is missing. None of them takes a password.
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
    ],
  }));

  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const name = request.params.name;
    let message: string;
    try {
      if (name === PLAYBOOK_PROMPT) message = explorePrompt(loadPlaybook(PACKAGE_ROOT), request.params.arguments);
      else if (name === LIVE_PROMPT) message = livePrompt(request.params.arguments);
      else if (name === LOGIN_PROMPT) message = loginPrompt(request.params.arguments);
      else throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: message } }] };
  });
}
