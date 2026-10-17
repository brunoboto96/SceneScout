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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExportRecord, Tracker } from "./export.js";
import { MEMORY_DIRNAME } from "./memory.js";
import { tryAcquireLock } from "./refresh.js";

/** The least time between two reads of the tracker for one project. A call sooner answers what the last read found. */
export const TICKET_STATUS_EVERY_MS = 5 * 60_000;
/** The last read's answer, kept in the project's `.scenescout/` folder so every server process for it shares one limit. */
export const TICKET_STATUS_FILE = "ticket-status.json";
/** Held while one process reads the trackers for a project, so two never read at once. */
export const TICKET_STATUS_LOCK_FILE = "ticket-status.lock";
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

/** What a read kept: when, for which record of filed tickets, and its answer. */
interface Kept {
  atMs: number;
  /** The SHA-256 of the record's text the read was made for ("" with no record): a filing changes it, and a read is due at once. */
  record: string;
  status: TicketStatus;
}

/** The identity of a record's text, as a kept read names it. */
export function recordDigest(text: string | null): string {
  return text === null ? "" : crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * The last read of each project, so its trackers are asked at most once every
 * TICKET_STATUS_EVERY_MS whoever calls (the mod's watch in any Claude Code
 * window, or Claude) and whichever server process answers: the answer is kept
 * in the project's `.scenescout/` folder, and a read is made holding a lock
 * there. A project with no such folder has filed nothing, so nothing is read
 * and its answer is kept in this process only.
 */
export class TicketStatusReads {
  private readonly last = new Map<string, Kept>();

  private static dir(project: string): string {
    return path.join(project, MEMORY_DIRNAME);
  }

  /** The kept read: the project's file where it can be read, else this process's own. */
  private kept(project: string): Kept | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TicketStatusReads.dir(project), TICKET_STATUS_FILE), "utf8")) as Partial<Kept>;
      const st = raw.status as Partial<TicketStatus> | undefined;
      if (
        typeof raw.atMs === "number" &&
        typeof raw.record === "string" &&
        st &&
        typeof st.readAt === "string" &&
        typeof st.nextReadAt === "string" &&
        Array.isArray(st.tickets) &&
        Array.isArray(st.problems)
      )
        return { atMs: raw.atMs, record: raw.record, status: { ...(st as TicketStatus), tickets: st.tickets.slice(0, TICKET_STATUS_MAX) } };
    } catch {
      // None kept on disk yet, or one this version cannot read: this process's own, if any, and else a read is due.
    }
    return this.last.get(project) ?? null;
  }

  /** The last answer for this project and record when the next read is not due, as not fresh; else null, and the caller reads the tracker. */
  cached(project: string, nowMs: number, record = ""): TicketStatus | null {
    const held = this.kept(project);
    if (!held || held.record !== record || nowMs - held.atMs >= TICKET_STATUS_EVERY_MS || nowMs < held.atMs) return null;
    return { ...held.status, fresh: false };
  }

  /**
   * The answer for this project: the kept one while it is current, else what
   * `read` finds, read holding the project's lock. While another process holds
   * it, the kept answer for this record is given again (not fresh) rather
   * than reading too, and with none, an answer that says so.
   */
  async read(project: string, nowMs: number, record: string, read: () => Promise<{ tickets: WatchedTicket[]; problems: string[] }>): Promise<TicketStatus> {
    const held = this.cached(project, nowMs, record);
    if (held) return held;
    const dir = TicketStatusReads.dir(project);
    if (!fs.existsSync(dir)) {
      const r = await read();
      return this.remember(project, nowMs, r.tickets, r.problems, record);
    }
    const lock = tryAcquireLock(path.join(dir, TICKET_STATUS_LOCK_FILE), { staleMs: TICKET_STATUS_EVERY_MS });
    if (!lock) {
      // Only an answer for this same record: one kept from before a filing would say the new tickets are not there.
      const kept = this.kept(project);
      return kept && kept.record === record
        ? { ...kept.status, fresh: false }
        : {
            readAt: new Date(nowMs).toISOString(),
            fresh: false,
            nextReadAt: new Date(nowMs + 60_000).toISOString(),
            tickets: [],
            problems: ["another SceneScout process is reading the trackers for this project now; ask again in a minute"],
          };
    }
    try {
      // Read under the lock only if no other process read while this one waited for it.
      const again = this.cached(project, nowMs, record);
      if (again) return again;
      const r = await read();
      return this.remember(project, nowMs, r.tickets, r.problems, record);
    } finally {
      lock.release();
    }
  }

  /** Keep a read's answer, stamped with when it was read and when the next may be, in the project's folder where it has one. */
  remember(project: string, nowMs: number, tickets: WatchedTicket[], problems: string[], record = ""): TicketStatus {
    const status: TicketStatus = {
      readAt: new Date(nowMs).toISOString(),
      fresh: true,
      nextReadAt: new Date(nowMs + TICKET_STATUS_EVERY_MS).toISOString(),
      tickets: tickets.slice(0, TICKET_STATUS_MAX),
      problems,
    };
    const kept: Kept = { atMs: nowMs, record, status };
    this.last.set(project, kept);
    const dir = TicketStatusReads.dir(project);
    if (fs.existsSync(dir)) {
      // By rename, so another process never reads half a file. A write that fails leaves this process's own copy, which still limits it.
      const file = path.join(dir, TICKET_STATUS_FILE);
      const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(kept), { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch {
        fs.rmSync(temp, { force: true });
      }
    }
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
