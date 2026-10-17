/**
 * Filing findings as tickets from the guided surfaces (design section 2.6,
 * issue #511): the rules scout_ticket_preview and scout_ticket_file keep, with
 * no network, disk or MCP SDK, so each is table-tested in export-test.
 *
 * A preview is what the person sees before anything is sent: each ticket that
 * would be filed, what the tracker already holds, and what waits for the next
 * filing. It is bound to its content and to the tracker it names, held in the
 * server process only, and lasts ten minutes. Filing sends only a preview that
 * is still fresh and whose findings still read as they did, and only after the
 * person says yes in the server's own form (ADR 24): the model can ask for that
 * form, never answer it.
 *
 * The issues themselves are export.ts's, unchanged: the same selection, marker,
 * inert body, severity map and cap as `scenescout export`.
 */
import crypto from "node:crypto";
import { githubIssue, inertPlain, TRACKER_LABEL, type ExportOptions, type Tracker } from "./export.js";
import type { ConfirmFormOutcome } from "./guided.js";
import type { Finding } from "./memory.js";
import { shellQuote } from "./profiles.js";
import { TICKET_ANSWER, TICKET_FIELD, TICKET_SAYS, ticketFormIntro, ticketFormLines } from "./guided-words.js";

/** How long a preview may be filed from. */
export const PREVIEW_TTL_MS = 10 * 60_000;
/** How many findings one preview may name. More than the cap is allowed: the ones over it are listed as waiting for the next filing. */
export const MAX_PREVIEW_IDS = 50;
/** How many previews the server keeps at once; the oldest goes first. */
export const MAX_KEPT_PREVIEWS = 20;
/** The longest title a confirmation form lists, so a form stays readable. */
const FORM_TITLE_CHARS = 120;

/** "tp-" and 16 random characters. */
export function newPreviewId(): string {
  return `tp-${crypto.randomBytes(12).toString("base64url")}`;
}

/** Whether a string has the shape newPreviewId makes. */
export function isPreviewId(id: unknown): id is string {
  return typeof id === "string" && /^tp-[A-Za-z0-9_-]{16}$/.test(id);
}

/** Where tickets go, as the tool takes it: a repository for GitHub, a project key for Jira. Never repeated back when it is refused. */
export type TicketTarget = { ok: true; to: Tracker; target: string } | { ok: false; error: string };

/** The tool's `to` and `target`, checked before anything reads them. A token pasted into either is refused without being printed. */
export function checkTicketTarget(to: unknown, target: unknown): TicketTarget {
  if (to !== "github" && to !== "jira") return { ok: false, error: "to must be github or jira" };
  const t = typeof target === "string" ? target.trim() : "";
  if (to === "github") {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(t) || t.split("/").some((part) => /^\.+$/.test(part)))
      return { ok: false, error: "target must be the GitHub repository as owner/name, such as acme/shop" };
    return { ok: true, to, target: t };
  }
  if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(t))
    return { ok: false, error: "target must be the Jira project key: capital letters, digits and underscores, starting with a letter, such as QA" };
  return { ok: true, to, target: t };
}

/**
 * The `scenescout export` options a preview runs with: a dry run of exactly
 * the findings the person picked, whatever their severity or tier, since they
 * ticked them. Filing reuses the options the preview was made with.
 */
export function ticketExportArgs(t: Extract<TicketTarget, { ok: true }>, ids: readonly string[], projectDir: string): string[] {
  const where = t.to === "github" ? ["--to", "github", "--repo", t.target] : ["--to", "jira", "--jira-project", t.target];
  return [...where, "--project", projectDir, "--only", ids.join(","), "--include-worth-a-look", "--dry-run"];
}

/**
 * The `scenescout export` command that files what a preview listed, for a
 * developer to run where the app cannot show the confirmation form. Without
 * --yes it is a dry run; the credentials stay in that terminal's environment.
 */
export function ticketExportCommand(o: ExportOptions, ids: readonly string[]): string {
  const where = o.to === "github" ? `--to github --repo ${o.github.repo}` : `--to jira --jira-url ${o.jira.baseUrl} --jira-project ${o.jira.projectKey}`;
  return `npx -y scenescout export ${where} --only ${ids.join(",")} --project ${shellWord(o.projectDir)} --include-worth-a-look`;
}

/** A folder as one shell word for this platform's usual shell: bare when it is plain, else quoted (profiles.ts shellQuote). */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : shellQuote(s);
}

/**
 * The environment a tracker's credentials are read from. A desktop extension
 * passes each setting the person left empty as the empty string, and some
 * hosts pass the unfilled placeholder itself (`${user_config.github_token}`):
 * neither is a credential, so neither is kept.
 */
export function trackerEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v.trim() === "" || /^\$\{user_config\.[^}]*\}$/.test(v.trim())) continue;
    out[k] = v;
  }
  return out;
}

/** One ticket a preview lists. */
export interface PreviewTicket {
  id: string;
  severity: Finding["severity"];
  title: string;
}
export interface PreviewFiled extends PreviewTicket {
  ref: string;
  url: string;
  open: boolean;
}

/** What scout_ticket_preview returns, and what the server keeps to file from. */
export interface TicketPreview {
  /** Null when there is nothing to file: no preview is kept then. */
  previewId: string | null;
  to: Tracker;
  /** The tracker as a person reads it: "GitHub acme/shop", "Jira QA". */
  where: string;
  createdAt: string;
  expiresAt: string;
  toFile: PreviewTicket[];
  alreadyFiled: PreviewFiled[];
  /** Over the cap of one filing: they wait for the next one. */
  later: PreviewTicket[];
  /** The most one filing sends (`scenescout export`'s --max-issues default). */
  cap: number;
  /** Picked, and left out, each with why (resolved). */
  leftOut: Array<{ id: string; reason: string }>;
}

/** A preview as the server keeps it: the options it was made with and what binds it. */
export interface KeptPreview {
  preview: TicketPreview;
  options: ExportOptions;
  digest: string;
  createdMs: number;
}

/**
 * A ticket's line as the issue will carry it: one line with no control
 * characters, and a mention or a link from the page made inert, so the form
 * names the ticket in the words that are filed and nothing in it is live.
 */
export function ticketTitle(f: Pick<Finding, "title">): string {
  return inertPlain(f.title, FORM_TITLE_CHARS) || "SceneScout finding";
}

/**
 * What binds a preview: the tracker it files into, and each previewed
 * finding's issue as export.ts would write it (title, body and its facts),
 * in order. A finding found again, edited, resolved or removed after the
 * preview changes this, and so does a different tracker or project.
 */
export function previewDigest(where: string, findings: readonly Finding[]): string {
  const h = crypto.createHash("sha256");
  h.update(`${where}\n`);
  for (const f of findings) {
    const issue = githubIssue(f, { severityName: null, labels: [], screenshots: "off" });
    h.update(`${f.id}\n${f.status}\n${issue.title}\n${issue.body}\n\u0000`);
  }
  return h.digest("hex");
}

/** Why a kept preview cannot be filed from, or ok. */
export type PreviewCheck = { ok: true } | { ok: false; why: "unknown" | "expired" | "altered" | "empty" };

/**
 * Whether a preview may be filed from now: it is held, not past its ten
 * minutes, names something to file, and its findings read as they did when it
 * was made. `current` is the digest of those findings as they read now, or
 * null when one of them is gone or no longer filable.
 */
export function checkPreview(kept: KeptPreview | undefined, nowMs: number, current: string | null): PreviewCheck {
  if (!kept) return { ok: false, why: "unknown" };
  if (nowMs - kept.createdMs >= PREVIEW_TTL_MS || nowMs < kept.createdMs) return { ok: false, why: "expired" };
  if (kept.preview.toFile.length === 0) return { ok: false, why: "empty" };
  if (current === null || current !== kept.digest) return { ok: false, why: "altered" };
  return { ok: true };
}

/** The values the confirmation form's answer takes. */
export const TICKET_CONFIRM_VALUES = { file: "file", back: "back" } as const;

/**
 * The server's confirmation form for a preview: where the tickets go, each
 * one by title, what is already filed and what waits, and one answer, file or
 * go back, with no default. Nothing else is asked, and nothing in it is a
 * credential.
 */
export function ticketConfirmForm(preview: TicketPreview) {
  const n = preview.toFile.length;
  const message = [ticketFormIntro(n, preview.where), ...ticketFormLines(preview)].join("\n");
  return {
    message,
    requestedSchema: {
      type: "object" as const,
      properties: {
        answer: {
          type: "string" as const,
          title: TICKET_FIELD.title,
          description: TICKET_FIELD.description,
          oneOf: [
            { const: TICKET_CONFIRM_VALUES.file, title: TICKET_ANSWER.file(n) },
            { const: TICKET_CONFIRM_VALUES.back, title: TICKET_ANSWER.back },
          ],
        },
      },
      required: ["answer"],
    },
  };
}

export type TicketConfirmOutcome = "confirmed" | "went-back" | "declined" | "cancelled" | "failed" | "unsupported";

/** What the person's answer to the form comes to. Only an accepted form whose answer is "file" files anything. */
export function ticketConfirmVerdict(outcome: ConfirmFormOutcome): { confirmed: boolean; outcome: TicketConfirmOutcome; tellPerson: string } {
  if (outcome.kind !== "accepted") return { confirmed: false, outcome: outcome.kind, tellPerson: TICKET_SAYS[outcome.kind] };
  if (outcome.content.answer !== TICKET_CONFIRM_VALUES.file) return { confirmed: false, outcome: "went-back", tellPerson: TICKET_SAYS["went-back"] };
  return { confirmed: true, outcome: "confirmed", tellPerson: "" };
}

/** The tracker as a person reads it. */
export function trackerWhere(o: ExportOptions): string {
  return o.to === "github" ? `${TRACKER_LABEL.github} ${o.github.repo}` : `${TRACKER_LABEL.jira} ${o.jira.projectKey}`;
}

/**
 * The previews a server holds, by id. Each is used once: filing takes it,
 * whatever happens next. An expired one is dropped when anything is read, and
 * past MAX_KEPT_PREVIEWS the oldest goes.
 */
export class TicketPreviews {
  private readonly kept = new Map<string, KeptPreview>();

  add(k: KeptPreview): void {
    if (!k.preview.previewId) return;
    this.kept.set(k.preview.previewId, k);
    while (this.kept.size > MAX_KEPT_PREVIEWS) this.kept.delete(this.kept.keys().next().value!);
  }

  get(id: string, nowMs: number): KeptPreview | undefined {
    this.prune(nowMs);
    return this.kept.get(id);
  }

  /** Whether the id was held and has now been dropped. An expired one reads as held until pruned, so `get` first. */
  take(id: string): boolean {
    return this.kept.delete(id);
  }

  get size(): number {
    return this.kept.size;
  }

  private prune(nowMs: number): void {
    for (const [id, k] of this.kept) if (nowMs - k.createdMs >= PREVIEW_TTL_MS * 2) this.kept.delete(id);
  }
}
