/**
 * Watched tickets (design 2.6): which tickets this project filed, read back
 * from the tracker for whether each is still open, at most once every
 * TICKET_STATUS_EVERY_MS. The rules live here so they are table-tested in
 * export-test with no tracker; ticket-run.ts reads the tracker.
 *
 * What a project filed is the export record (`.scenescout/exported.json`),
 * which `scenescout export` and scout_ticket_file both write: one entry per
 * finding per tracker, keyed by the tracker's API address and its repository
 * or project. A place is watched only where the server's own settings point
 * at the same tracker, so a read never goes to an address the settings did
 * not name.
 */
import type { ExportRecord, Tracker } from "./export.js";

/** The least time between two reads of the tracker for one project. A call sooner answers what the last read found. */
export const TICKET_STATUS_EVERY_MS = 5 * 60_000;
/** The most tickets one answer lists, the newest filed first. */
export const TICKET_STATUS_MAX = 50;
/** The most trackers one read asks. */
export const TICKET_STATUS_PLACES = 5;

/** A place the record names: the tracker, the repository or project key, and the record's key for it. */
export interface RecordPlace {
  key: string;
  to: Tracker;
  /** The API address (GitHub) or the site (Jira) the record was written against. */
  api: string;
  /** owner/name, or a Jira project key. */
  target: string;
}

/** The places an export record names, in the order it holds them, at most TICKET_STATUS_PLACES; a key that cannot be read is left out. */
export function recordPlaces(record: ExportRecord): RecordPlace[] {
  const out: RecordPlace[] = [];
  for (const key of Object.keys(record)) {
    const m = /^(github|jira) (\S+) (\S+)$/.exec(key);
    if (!m) continue;
    out.push({ key, to: m[1] as Tracker, api: m[2], target: m[3] });
    if (out.length === TICKET_STATUS_PLACES) break;
  }
  return out;
}

/** One filed ticket as the watch reports it. */
export interface WatchedTicket {
  /** The finding it was filed for. */
  id: string;
  title: string;
  severity: "high" | "medium" | "low" | "";
  /**
   * The finding in this project: still open, resolved (a re-check found it
   * gone), or unknown when the project no longer keeps it, which is never
   * read as fixed.
   */
  finding: "open" | "resolved" | "unknown";
  /** "GitHub owner/app", "Jira QA". */
  where: string;
  ref: string;
  url: string;
  /** Whether the ticket is open in the tracker. */
  open: boolean;
}

/** What scout_ticket_status answers. */
export interface TicketStatus {
  /** When the tracker was read for this answer. */
  readAt: string;
  /** False when this answer is the last read's, given again because the next read is not due. */
  fresh: boolean;
  /** When the tracker may be read again. */
  nextReadAt: string;
  tickets: WatchedTicket[];
  /** Places not read, and why, already redacted. */
  problems: string[];
}

/**
 * The tickets of one place, newest filed first: each finding the record holds
 * an issue number for, with the tracker's state where its listing or a read by
 * number showed it, else the issue as gone (not open). A finding the project no
 * longer keeps is listed by its id.
 */
export function placeTickets(
  where: string,
  recorded: Readonly<Record<string, { ref: string; number: number; url: string; at: string } | { uncertain: true; at: string }>>,
  read: ReadonlyMap<string, { ref: string; url: string; open: boolean }>,
  findings: ReadonlyMap<string, { title: string; severity: string; status?: string }>,
): WatchedTicket[] {
  const out: Array<WatchedTicket & { at: number }> = [];
  for (const [id, entry] of Object.entries(recorded)) {
    if ("uncertain" in entry) continue;
    const issue = read.get(id);
    const f = findings.get(id);
    const severity = f && (f.severity === "high" || f.severity === "medium" || f.severity === "low") ? f.severity : "";
    out.push({
      id,
      title: f ? f.title : `finding ${id}`,
      severity,
      finding: !f ? "unknown" : f.status === "resolved" ? "resolved" : "open",
      where,
      ref: issue?.ref ?? entry.ref,
      url: issue?.url ?? entry.url,
      open: issue?.open ?? false,
      at: Date.parse(entry.at) || 0,
    });
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).map(({ at: _at, ...t }) => t);
}

/**
 * The last read of each project, so the tracker is asked at most once every
 * TICKET_STATUS_EVERY_MS per project, whoever calls (the mod's watch, or
 * Claude). In this process only.
 */
export class TicketStatusReads {
  private readonly last = new Map<string, { atMs: number; status: TicketStatus }>();

  /** The last answer for this project when the next read is not due, as not fresh; else null, and the caller reads the tracker. */
  cached(project: string, nowMs: number): TicketStatus | null {
    const held = this.last.get(project);
    if (!held || nowMs - held.atMs >= TICKET_STATUS_EVERY_MS || nowMs < held.atMs) return null;
    return { ...held.status, fresh: false };
  }

  /** Keep a read's answer, stamped with when it was read and when the next may be. */
  remember(project: string, nowMs: number, tickets: WatchedTicket[], problems: string[]): TicketStatus {
    const status: TicketStatus = {
      readAt: new Date(nowMs).toISOString(),
      fresh: true,
      nextReadAt: new Date(nowMs + TICKET_STATUS_EVERY_MS).toISOString(),
      tickets: tickets.slice(0, TICKET_STATUS_MAX),
      problems,
    };
    this.last.set(project, { atMs: nowMs, status });
    return status;
  }
}

/** The answer as Claude reads it: each ticket on a line, open or closed, and whether its problem is still there. */
export function ticketStatusText(s: TicketStatus): string {
  const head = s.fresh
    ? `Read the trackers at ${s.readAt}: ${s.tickets.length} ticket(s) filed for this project.`
    : `The trackers were last read at ${s.readAt}; the next read is due at ${s.nextReadAt}. ${s.tickets.length} ticket(s) filed for this project.`;
  const lines = s.tickets.map(
    (t) =>
      `  ${t.where} ${t.ref} ${t.open ? "open" : "closed"}: ${t.title} [finding ${t.id}, ${t.finding === "open" ? "still open here" : t.finding === "resolved" ? "found gone by a re-check" : "not kept here"}] ${t.url}`,
  );
  return [head, ...lines, ...(s.problems.length ? ["Not read:", ...s.problems.map((p) => `  ${p}`)] : [])].join("\n");
}
