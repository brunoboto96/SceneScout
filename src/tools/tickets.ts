/**
 * Filing findings as tickets from the guided surfaces: scout_ticket_preview and
 * scout_ticket_file (design 2.6 and 3.4). The work is ticket-run.ts's, over
 * `scenescout export`; the rules are engine/ticket-preview.ts's. This file
 * finds the open project, shows the person the server's confirmation form, and
 * reads the tracker's credentials from this process's environment only.
 *
 * Registered by mcp-server.ts, after the result tools.
 */
import path from "node:path";
import { z } from "zod";
import { MAX_PREVIEW_IDS, TicketPreviews } from "../engine/ticket-preview.js";
import { fileTickets, previewTickets } from "../ticket-run.js";
import { errorText, projectEngine, server } from "../server-context.js";
import { askWithForm } from "./guide.js";

export const TICKET_PREVIEW_TOOL = "scout_ticket_preview";
export const TICKET_FILE_TOOL = "scout_ticket_file";

/** The previews this server holds: in this process only, so a restart drops them all. */
const previews = new TicketPreviews();

/** The open project's folder, with what it has found written to disk first, since the export reads the file. */
function openProject(): string {
  const memory = projectEngine()?.memory;
  if (!memory) throw new Error("No project is open yet: tickets are filed from the findings of the project a session attached to, so attach first.");
  memory.flush();
  return path.dirname(memory.dir);
}

const TICKET = z.object({ id: z.string(), severity: z.enum(["high", "medium", "low"]), title: z.string() });

const PREVIEW_OUTPUT = {
  previewId: z.string().nullable(),
  to: z.enum(["github", "jira"]),
  where: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  toFile: z.array(TICKET),
  alreadyFiled: z.array(TICKET.extend({ ref: z.string(), url: z.string(), open: z.boolean() })),
  later: z.array(TICKET),
  cap: z.number(),
  leftOut: z.array(z.object({ id: z.string(), reason: z.string() })),
};

const FILE_OUTPUT = {
  filed: z.boolean(),
  outcome: z.enum(["confirmed", "went-back", "declined", "cancelled", "failed", "unsupported", "unknown", "expired", "altered", "empty", "could-not-file"]),
  tellPerson: z.string(),
  tickets: z.array(z.object({ id: z.string(), ref: z.string(), url: z.string() })),
  problems: z.array(z.string()),
};

export function registerTicketTools(): void {
  server.registerTool(
    TICKET_PREVIEW_TOOL,
    {
      title: "Preview problems as tickets",
      description:
        "Preview filing the problems the person chose as GitHub or Jira tickets. Reads the tracker to find which are already filed (by the marker `scenescout export` writes) and sends nothing. " +
        "Returns each ticket that would be filed, the ones already filed, any over the limit of one filing, and a previewId that lasts 10 minutes. Show the person the list; to file it, call scout_ticket_file with the previewId. " +
        'to: "github" with target the repository as owner/name, or "jira" with target the project key (the Jira site is JIRA_BASE_URL in the server\'s settings). ' +
        "The tracker's sign-in comes from the server's environment or the desktop extension's settings only (GH_TOKEN or GITHUB_TOKEN; JIRA_EMAIL and JIRA_API_TOKEN): never ask the person for a token and never pass one. Touches no browser.",
      inputSchema: {
        ids: z.array(z.string().max(64)).min(1).max(MAX_PREVIEW_IDS).describe("The finding ids the person chose, as scout_cards shows them"),
        to: z.enum(["github", "jira"]).describe("Where the team keeps its tickets"),
        target: z.string().max(201).describe('GitHub: the repository as owner/name. Jira: the project key, such as "QA"'),
      },
      outputSchema: PREVIEW_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ids, to, target }: { ids: string[]; to: "github" | "jira"; target: string }) => {
      try {
        const got = await previewTickets({ ids, to, target }, openProject(), previews, { env: process.env });
        if (!got.ok) throw new Error(got.error);
        return { content: [{ type: "text" as const, text: got.text }], structuredContent: { ...got.preview } };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    TICKET_FILE_TOOL,
    {
      title: "File previewed tickets",
      description:
        "File the tickets a preview from scout_ticket_preview listed. Before anything is sent, this server asks the PERSON in its own form, listing the tickets; it files only on their yes there. " +
        "You may make this call; you cannot answer the form, and nothing you pass confirms it. It files only the previewed problems, only while the preview is under 10 minutes old and only if those problems have not changed since; otherwise it refuses and a new preview is needed. " +
        "A preview is used once: after the person goes back, turns the form down or closes it, or this client cannot show forms, nothing is filed: tell them, and never call it again on their behalf. Returns each filed ticket's link. Touches no browser.",
      inputSchema: {
        previewId: z.string().max(40).describe("The previewId scout_ticket_preview returned"),
      },
      outputSchema: FILE_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ previewId }: { previewId: string }, extra) => {
      try {
        // What the open project has found goes to disk first, so a preview of it is checked against what it holds now.
        openProject();
        const got = await fileTickets(previewId, previews, (form) => askWithForm(form.message, form.requestedSchema, extra, TICKET_FILE_TOOL), {
          env: process.env,
        });
        const { text, ...structured } = got;
        return { content: [{ type: "text" as const, text: `${text}\nTell the person: "${got.tellPerson}"` }], structuredContent: structured };
      } catch (err) {
        return errorText(err);
      }
    },
  );
}
