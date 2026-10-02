/**
 * Answering the tickets: acceptance criteria go in, and pass, fail or not
 * tested comes out per criterion.
 *
 * Three parts, all pure so each is table-tested (tickets-test):
 *
 * - Reading. `parseTickets` finds the criteria in a ticket as people write
 *   them: Given/When/Then scenarios, checklists, numbered or "AC1:" criteria,
 *   and bullets under an "Acceptance criteria" heading, pasted or from a file.
 *   A ticket where none of these appear says so: the parser never turns prose
 *   into criteria, because a criterion it made up would be answered as if the
 *   ticket's author had written it.
 * - Judging. Whether a criterion passed, and which findings show it failing,
 *   is the agent's judgement, recorded through `scout_criterion` with its
 *   confidence. Nothing here matches criteria to findings by their words;
 *   `judgeCriterion` only checks the record is complete and consistent.
 * - Reporting. One section per ticket in plain words, and a table per ticket
 *   in the technical report.
 */
import type { Finding } from "./memory.js";

/** The shape a criterion was written in. */
export type CriterionShape = "given-when-then" | "checklist" | "numbered" | "labelled" | "bullet";

export interface Criterion {
  /** "AC1", "AC2", …: the ticket's own number when it labelled the criterion "AC3", else its place in the ticket. */
  id: string;
  /** The criterion as one line. A scenario's steps are joined with "; ". */
  text: string;
  shape: CriterionShape;
}

export interface Ticket {
  /** The ticket's key when it carries one ("PROJ-12", "#12"), else "T1", "T2", … in reading order. */
  id: string;
  title: string;
  criteria: Criterion[];
  /** Where it was read from: "pasted text", or a file's name. */
  source: string;
  /** Set when no criteria were recognised: what was found instead, and what would make them readable. */
  note?: string;
}

/** A ticket kept in the project's memory, with when it was read. */
export interface StoredTicket extends Ticket {
  loadedAt: string;
}

export const CRITERION_VERDICTS = ["pass", "fail", "not-tested"] as const;
export type CriterionVerdictKind = (typeof CRITERION_VERDICTS)[number];

/** Why a criterion was not tested, as the agent states it. */
export const NOT_TESTED_REASONS = ["no-access", "observe-blocked", "out-of-scope"] as const;
export type NotTestedReason = (typeof NOT_TESTED_REASONS)[number];

/** One session's judgement of one criterion. */
export interface CriterionVerdict {
  ticket: string;
  criterion: string;
  verdict: CriterionVerdictKind;
  /** The findings that show it: required for a fail, optional for a pass, none for not tested. */
  findings: string[];
  /** How sure the agent is, 0 to 1. */
  confidence: number;
  /** What was seen, or why it could not be tried, in a sentence. */
  reason: string;
  /** For a criterion not tested: which kind of reason. */
  untestedBecause?: NotTestedReason;
  /** The criterion's text when it was judged: a ticket read again with that criterion changed leaves this verdict behind. */
  text?: string;
  session: string;
  at: string;
}

/** Bounds, so one pasted backlog cannot grow the memory file without limit. */
export const MAX_TICKET_TEXT = 200_000;
export const MAX_TICKETS = 50;
/** Most tickets the project keeps across runs: the newest readings. */
export const MAX_TICKETS_KEPT = 100;
export const MAX_CRITERIA_PER_TICKET = 50;
export const MAX_CRITERION_TEXT = 500;
export const MAX_REASON = 300;
export const MAX_CRITERION_FINDINGS = 20;
export const MAX_CRITERION_VERDICTS = 1000;
/** A ticket file is read only up to this size. */
export const MAX_TICKET_FILE_BYTES = 1_000_000;
/** The file types a ticket is read from: text, never a binary or a document format. */
export const TICKET_FILE_EXTENSIONS = [".md", ".markdown", ".txt", ".text", ".feature"] as const;
/** Below this confidence, the plain report says the verdict is unsure. */
export const UNSURE_BELOW = 0.6;

/** Whether a file name has one of the extensions a ticket is read from. */
export function isTicketFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return TICKET_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** A heading that opens the criteria. */
const AC_HEADING = /^(?:(?:acceptance criteria|acceptance criterion|acceptance tests?|definition of done)\b.*|acs?|criteria|dod|scenarios?)$/i;
/** A heading whose lists are not criteria: how to reproduce a bug, what is excluded. */
const EXCLUDED_HEADING =
  /^(steps|steps to reproduce|reproduction steps|repro|repro steps|to reproduce|how to reproduce|expected|expected result|expected behaviou?r|actual|actual result|actual behaviou?r|environment|out of scope|not in scope|non-goals?)$/i;
/** A heading that belongs to a ticket rather than starting one. */
const PART_HEADING =
  /^(description|summary|background|context|notes?|details|user story|story|design|technical notes|implementation notes|dependencies|links?|attachments?|screenshots?|comments?|testing notes|how to test|why|goal|problem)$/i;

const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/;
const ISSUE_NUMBER = /(?:^|[\s([])#(\d{1,7})\b/;

const STEP = /^(?:[-*+•]\s+)?(?:\*\*|__)?(Given|When|Then|And|But|GIVEN|WHEN|THEN|AND|BUT)(?:\*\*|__)?\s+(.+)$/;
const SCENARIO = /^(?:[-*+•]\s+)?(?:\*\*|__)?(?:Scenario Outline|Scenario Template|Scenario|Example)(?:\*\*|__)?\s*:\s*(.*)$/i;
const BACKGROUND = /^(?:\*\*|__)?Background(?:\*\*|__)?\s*:\s*$/i;
const FEATURE = /^(?:\*\*|__)?Feature(?:\*\*|__)?\s*:\s*(.*)$/i;
const LABELLED = /^(?:[-*+•]\s+|\d{1,3}[.)]\s+)?(?:\*\*|__)?AC\s*[-#]?\s*(\d{1,3})(?:\*\*|__)?\s*[:.)\-–—]\s*(?:\*\*|__)?\s*(.*)$/i;
const CHECK = /^(?:[-*+•]\s+)?\[( |x|X)\]\s+(.+)$/;
const NUMBERED = /^(\d{1,3})[.)]\s+(.+)$/;
const BULLET = /^[-*+•]\s+(.+)$/;
const MD_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOLD_LINE = /^(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*:?\s*$/;
const LABEL_LINE = /^([A-Za-z][A-Za-z /&'-]{0,40}):\s*$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;

/** Markdown emphasis and runs of space taken out of a line of a criterion. */
function clean(text: string): string {
  return text
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A heading's words, without the ticket key, numbering or a trailing colon. */
function headingWords(text: string): string {
  return clean(text)
    .replace(/[:.\s]+$/, "")
    .trim();
}

type Region = "open" | "ac" | "part" | "excluded";

function regionOf(heading: string): Region | "ticket" {
  const words = headingWords(heading);
  if (AC_HEADING.test(words)) return "ac";
  if (EXCLUDED_HEADING.test(words)) return "excluded";
  if (PART_HEADING.test(words)) return "part";
  return "ticket";
}

interface Draft {
  shape: CriterionShape;
  parts: string[];
  region: Region;
  indent: number;
  /** The number a labelled criterion carried ("AC3" → 3). */
  label?: number;
  /** For a scenario: the last step keyword, so a Given after a Then starts the next one. */
  phase?: "given" | "when" | "then";
  /** For a scenario: its name. */
  title?: string;
  /** A Gherkin Background: read, so its steps join nothing else, and never kept. */
  background?: boolean;
  /** Which step keywords a scenario has, so a lone sentence opening with "When" is not one. */
  keywords?: Set<string>;
}

interface RawTicket {
  heading?: string;
  headingLevel?: number;
  lines: string[];
}

/** Where one ticket ends and the next begins. */
function splitTickets(text: string, gherkin: boolean): RawTicket[] {
  const out: RawTicket[] = [];
  let current: RawTicket = { lines: [] };
  const start = (heading?: string, level?: number): void => {
    if (current.heading !== undefined || current.lines.some((l) => l.trim())) out.push(current);
    current = { heading, headingLevel: level, lines: [] };
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (RULE.test(trimmed)) {
      start();
      continue;
    }
    if (gherkin && trimmed.startsWith("#")) continue; // a comment in a .feature file
    const h = gherkin ? null : MD_HEADING.exec(trimmed);
    if (h) {
      const level = h[1].length;
      // A heading below the ticket's own is part of it; one at its level or
      // above, and not a known part's name, is the next ticket. So is one that
      // carries a ticket key, or that follows a heading with nothing under it
      // (stories under an epic).
      const within = current.headingLevel !== undefined && level > current.headingLevel && !ticketKey(h[2]) && current.lines.some((l) => l.trim());
      if (!within && regionOf(h[2]) === "ticket") {
        start(h[2], level);
        continue;
      }
    }
    const feature = FEATURE.exec(trimmed);
    if (feature && line === line.trimStart()) {
      start(feature[1] || "Feature");
      continue;
    }
    // A line that opens with a ticket key ("PROJ-12: Export is empty") starts a ticket.
    // It needs a separator after the key: "UTF-8 names round-trip" is a sentence, not a ticket.
    const keyed = /^(?:\[[A-Z][A-Z0-9]{1,9}-\d{1,7}\]\s*|[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:\s*:\s*|\s+[-–—]\s+))(.+)$/.exec(trimmed);
    if (keyed && line === line.trimStart()) {
      start(trimmed);
      continue;
    }
    current.lines.push(line);
  }
  start();
  return out;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The criteria in one ticket's lines, before choosing which regions count. */
function draftsOf(lines: readonly string[], gherkin: boolean): { drafts: Draft[]; title?: string } {
  const drafts: Draft[] = [];
  let region: Region = "open";
  let regionLevel = 0;
  let current = null as Draft | null;
  let title: string | undefined;
  const open = (d: Draft): void => {
    drafts.push(d);
    current = d;
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    const indent = indentOf(line);
    if (!trimmed) {
      // A scenario's name may stand a blank line above its steps; anything else ends at a blank line.
      if (current && !(current.shape === "given-when-then" && current.parts.length === 0)) current = null;
      continue;
    }
    if (gherkin && (trimmed.startsWith("#") || trimmed.startsWith("@"))) continue;
    if (trimmed.startsWith("|")) {
      // An Examples table belongs to its scenario; elsewhere a table is not a criterion.
      if (current?.shape !== "given-when-then") current = null;
      continue;
    }
    if (/^Examples\s*:/i.test(trimmed) && current?.shape === "given-when-then") continue;
    const h = MD_HEADING.exec(trimmed);
    const label = h ? null : (BOLD_LINE.exec(trimmed) ?? LABEL_LINE.exec(trimmed));
    if (h || (label && !STEP.test(trimmed) && !SCENARIO.test(trimmed))) {
      const words = h ? h[2] : label![1];
      const level = h ? h[1].length : 7;
      const kind = regionOf(words);
      current = null;
      if (kind === "ticket") {
        // A sub-heading inside the criteria groups them; elsewhere it is neutral.
        // A label ("Error handling:") inside criteria opened by a label groups them too.
        if (!(region === "ac" && (level > regionLevel || (!h && regionLevel === 7)))) region = "part";
      } else {
        region = kind;
        regionLevel = level;
      }
      continue;
    }
    let m: RegExpExecArray | null;
    if (BACKGROUND.test(trimmed)) {
      // Steps every scenario shares: context, not a criterion. Kept out of the list.
      current = { shape: "given-when-then", parts: [], region, indent, background: true };
      continue;
    }
    if ((m = SCENARIO.exec(trimmed))) {
      open({ shape: "given-when-then", parts: [], region, indent, title: clean(m[1]) || undefined });
      continue;
    }
    if ((m = STEP.exec(trimmed))) {
      const keyword = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const step = `${keyword} ${clean(m[2])}`;
      const phase = keyword === "Given" ? "given" : keyword === "When" ? "when" : keyword === "Then" ? "then" : undefined;
      const cur = current;
      if (cur && cur.shape === "given-when-then" && !(phase === "given" && (cur.phase === "when" || cur.phase === "then"))) {
        cur.parts.push(step);
        if (phase) cur.phase = phase;
        if (phase) (cur.keywords ??= new Set()).add(phase);
      } else if (cur && cur.shape !== "given-when-then" && (indent > cur.indent || /:$/.test(cur.parts[cur.parts.length - 1] ?? ""))) {
        // Steps written under a numbered or labelled criterion spell that criterion out.
        cur.parts.push(step);
      } else {
        open({ shape: "given-when-then", parts: [step], region, indent, phase: phase ?? "given", keywords: new Set(phase ? [phase] : []) });
      }
      continue;
    }
    if ((m = LABELLED.exec(trimmed)) && m[2].trim()) {
      open({ shape: "labelled", parts: [clean(m[2])], region, indent, label: Number(m[1]) });
      continue;
    }
    if ((m = CHECK.exec(trimmed))) {
      open({ shape: "checklist", parts: [clean(m[2])], region, indent });
      continue;
    }
    const cur = current;
    if ((m = NUMBERED.exec(trimmed))) {
      if (cur && indent > cur.indent) cur.parts.push(clean(m[2]));
      else open({ shape: "numbered", parts: [clean(m[2])], region, indent });
      continue;
    }
    if ((m = BULLET.exec(trimmed))) {
      if (cur && indent > cur.indent) cur.parts.push(clean(m[1]));
      else open({ shape: "bullet", parts: [clean(m[1])], region, indent });
      continue;
    }
    if (cur) {
      // A wrapped line carries on the criterion above it.
      const last = cur.parts.length - 1;
      if (last >= 0 && cur.shape !== "given-when-then") cur.parts[last] = `${cur.parts[last]} ${clean(trimmed)}`;
      else cur.parts.push(clean(trimmed));
      continue;
    }
    if (!title && region === "open") title = clean(trimmed);
  }
  return { drafts, title };
}

/** The shapes that are criteria without an "Acceptance criteria" heading, by the region they sit in. */
function countsWithoutHeading(d: Draft): boolean {
  if (d.region === "excluded") return false;
  if (d.shape === "bullet") return false;
  // A numbered list in the description of a ticket is as often a list of
  // steps as of criteria; only one at the top of the ticket counts.
  if (d.shape === "numbered") return d.region === "open";
  // Steps outside the criteria are a scenario only when named as one or when they
  // run from a Given or When to a Then: "When I export, the file is empty." is prose.
  if (d.shape === "given-when-then") return d.title !== undefined || (d.keywords?.has("then") === true && (d.keywords.has("given") || d.keywords.has("when")));
  return true;
}

function textOf(d: Draft): string {
  const body = d.parts.filter(Boolean).join("; ");
  const text = d.title ? (body ? `${d.title}: ${body}` : d.title) : body;
  return text.length > MAX_CRITERION_TEXT ? `${text.slice(0, MAX_CRITERION_TEXT - 1)}…` : text;
}

/** What a ticket with no recognisable criteria had instead, and how to make them readable. */
function noCriteriaNote(drafts: readonly Draft[]): string {
  const how =
    'Write them as Given/When/Then, as a checklist ("- [ ] …"), as a numbered list, or as a list under an "Acceptance criteria" heading, or say what to check in words.';
  if (drafts.some((d) => d.shape === "bullet" && d.region !== "excluded"))
    return `No acceptance criteria were recognised: it has a bulleted list but no "Acceptance criteria" heading, so the list was not taken as criteria. ${how}`;
  if (drafts.some((d) => d.region === "excluded"))
    return `No acceptance criteria were recognised: its only list is under a heading such as "Steps to reproduce", which describes a bug rather than what should be true. ${how}`;
  return `No acceptance criteria were recognised: it has no Given/When/Then, checklist, numbered list or "Acceptance criteria" section. ${how}`;
}

/** The criteria of one ticket, numbered: a criterion the ticket labelled "AC3" keeps that number, the rest take the next free one in order. */
function numberCriteria(drafts: readonly Draft[]): Criterion[] {
  const kept = drafts.filter((d) => textOf(d) && !d.background).slice(0, MAX_CRITERIA_PER_TICKET);
  const taken = new Set<number>();
  const labelOf = new Map<Draft, number>();
  for (const d of kept) {
    if (d.label !== undefined && !taken.has(d.label)) {
      taken.add(d.label);
      labelOf.set(d, d.label);
    }
  }
  let next = 1;
  return kept.map((d) => {
    let n = labelOf.get(d);
    if (n === undefined) {
      while (taken.has(next)) next += 1;
      n = next;
      taken.add(n);
    }
    return { id: `AC${n}`, text: textOf(d), shape: d.shape };
  });
}

/** The key a ticket's heading carries, if any: "PROJ-12" or "#12". */
export function ticketKey(heading: string): string | undefined {
  const key = TICKET_KEY.exec(heading)?.[1];
  if (key) return key;
  const issue = ISSUE_NUMBER.exec(heading)?.[1];
  return issue ? `#${issue}` : undefined;
}

function titleOf(heading: string, key: string | undefined): string {
  let t = clean(heading);
  if (key) t = t.replace(key.startsWith("#") ? key : new RegExp(`\\[?${key}\\]?`), "");
  return t
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/^[\s:\-–—|]+|[\s:\-–—|]+$/g, "")
    .trim();
}

/**
 * The tickets in a piece of text, with their criteria. Several tickets may
 * be pasted at once: each starts at a heading, at a line opening with a key
 * such as "PROJ-12", at a Gherkin `Feature:` or after a `---` rule.
 *
 * When a ticket has an "Acceptance criteria" (or "Definition of done",
 * "Scenarios") section, only that section's items are criteria. Without one,
 * Given/When/Then scenarios, checklists and "AC1:" lines count anywhere
 * except under a heading such as "Steps to reproduce", and a numbered list
 * counts at the top of the ticket. Plain bullets and prose never count on
 * their own: the ticket is returned with no criteria and a note saying so.
 */
export function parseTickets(text: string, source = "pasted text"): Ticket[] {
  const body = text.slice(0, MAX_TICKET_TEXT);
  // A Gherkin file, where "#" starts a comment rather than a heading: named .feature, or opening with Feature:.
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !/^\s*[#@]/.test(l)) ?? "";
  const gherkin = source.toLowerCase().endsWith(".feature") || FEATURE.test(firstLine.trim());
  const raws = splitTickets(body, gherkin);
  const tickets: Ticket[] = [];
  const used = new Set<string>();
  let auto = 0;
  for (const [index, raw] of raws.entries()) {
    const { drafts, title: prose } = draftsOf(raw.lines, gherkin);
    if (raws.length > 1 && drafts.length === 0) {
      // A heading with nothing under it (an epic over its stories) is not a ticket to answer,
      // and neither is a line of introduction before the first ticket.
      if (raw.heading !== undefined && !raw.lines.some((l) => l.trim())) continue;
      if (raw.heading === undefined && index === 0) continue;
    }
    const inAc = drafts.filter((d) => d.region === "ac");
    const chosen = inAc.length > 0 ? inAc : drafts.filter(countsWithoutHeading);
    const criteria = numberCriteria(chosen);
    const key = raw.heading ? ticketKey(raw.heading) : undefined;
    auto += 1;
    let id = key ?? `T${auto}`;
    for (let n = 2; used.has(id); n += 1) id = `${key ?? `T${auto}`}~${n}`;
    used.add(id);
    const title = (raw.heading ? titleOf(raw.heading, key) : "") || (prose ?? "").slice(0, 120) || `Ticket ${auto}`;
    const cut = chosen.filter((d) => textOf(d) && !d.background).length > MAX_CRITERIA_PER_TICKET;
    const note = criteria.length === 0 ? noCriteriaNote(drafts) : cut ? `Only the first ${MAX_CRITERIA_PER_TICKET} criteria were read.` : undefined;
    tickets.push({ id, title: title.slice(0, 200), criteria, source, ...(note ? { note } : {}) });
    if (tickets.length >= MAX_TICKETS) break;
  }
  return tickets;
}

/**
 * Tickets read in this run so far, with a new reading added. A ticket with the
 * same key replaces the earlier reading; one with no key whose title and
 * criteria are the same as one already read is that ticket again; any other
 * keyless ticket takes the next free "T" number, so "T1" in a second paste is
 * not the first paste's T1.
 */
export function addReading(existing: readonly StoredTicket[], parsed: readonly Ticket[], at: string): { tickets: StoredTicket[]; added: StoredTicket[] } {
  const out = [...existing];
  const added: StoredTicket[] = [];
  const same = (a: Ticket, b: Ticket): boolean =>
    a.title === b.title && a.criteria.length === b.criteria.length && a.criteria.every((c, i) => c.text === b.criteria[i].text);
  const isAuto = (id: string): boolean => /^T\d+(~\d+)?$/.test(id);
  for (const t of parsed) {
    const index = isAuto(t.id) ? out.findIndex((e) => isAuto(e.id) && same(e, t)) : out.findIndex((e) => e.id === t.id);
    let id = t.id;
    if (index >= 0) id = out[index].id;
    else if (isAuto(t.id)) {
      let n = 1;
      while (out.some((e) => e.id === `T${n}`)) n += 1;
      id = `T${n}`;
    }
    const stored: StoredTicket = { ...t, id, loadedAt: at };
    if (index >= 0) out[index] = stored;
    else out.push(stored);
    added.push(stored);
  }
  return { tickets: out.slice(-MAX_TICKETS), added };
}

/** A criterion by what the agent called it: "AC2", "ac 2", "AC-2" or "2". */
export function findCriterion(ticket: Pick<Ticket, "criteria">, name: string): Criterion | undefined {
  const n = /^\s*(?:ac\s*[-#]?\s*)?(\d{1,3})\s*$/i.exec(name)?.[1];
  return n ? ticket.criteria.find((c) => c.id === `AC${Number(n)}`) : undefined;
}

// ── Judging ───────────────────────────────────────────────────────────────────

export interface CriterionInput {
  ticket: string;
  criterion: string;
  verdict: CriterionVerdictKind;
  findings?: readonly string[];
  confidence: number;
  reason: string;
  untestedBecause?: NotTestedReason;
}

export interface JudgeContext {
  tickets: readonly Ticket[];
  findings: readonly Pick<Finding, "id">[];
  /** The write mode of the session recording it: "observe-blocked" is only true in observe. */
  mode: string;
  session: string;
  at: string;
}

/**
 * A verdict made into a record, or the reason it is refused. It checks the
 * record is whole, never what it says: a fail names the findings that show
 * it, and they exist; a criterion not tested says which kind of reason; a
 * claim that observe blocked it comes from a session in observe.
 */
export function judgeCriterion(input: CriterionInput, ctx: JudgeContext): { ok: true; record: CriterionVerdict } | { ok: false; reason: string } {
  const ticket = ctx.tickets.find((t) => t.id === input.ticket.trim());
  if (!ticket) {
    const known = ctx.tickets.map((t) => t.id);
    return {
      ok: false,
      reason: known.length
        ? `no ticket ${JSON.stringify(input.ticket)} was read in this run. The tickets read are: ${known.join(", ")}`
        : `no tickets have been read in this run. Read them with scout_tickets first`,
    };
  }
  const criterion = findCriterion(ticket, input.criterion);
  if (!criterion) {
    return {
      ok: false,
      reason: ticket.criteria.length
        ? `ticket ${ticket.id} has no criterion ${JSON.stringify(input.criterion)}. Its criteria are ${ticket.criteria.map((c) => c.id).join(", ")}`
        : `ticket ${ticket.id} has no recognised criteria, so there is nothing to judge. Ask the person for its criteria rather than inventing them`,
    };
  }
  if (!(input.confidence >= 0 && input.confidence <= 1)) return { ok: false, reason: "confidence is a number from 0 to 1" };
  const reason = input.reason.trim().replace(/\s+/g, " ");
  if (!reason) return { ok: false, reason: "say in a sentence what you saw, or why it could not be tried" };
  const findings = [...new Set((input.findings ?? []).map((f) => f.trim()).filter(Boolean))];
  if (findings.length > MAX_CRITERION_FINDINGS) return { ok: false, reason: `at most ${MAX_CRITERION_FINDINGS} findings per criterion` };
  const unknown = findings.filter((id) => !ctx.findings.some((f) => f.id === id));
  if (unknown.length > 0) return { ok: false, reason: `no finding with id ${unknown.join(", ")}. File it with scout_finding first and pass the id it returns` };
  if (input.verdict === "fail" && findings.length === 0) {
    return {
      ok: false,
      reason: "a failing criterion links to the findings that show it failing. File each with scout_finding and pass their ids in `findings`",
    };
  }
  if (input.verdict === "not-tested") {
    if (findings.length > 0)
      return { ok: false, reason: "a criterion that was not tested has no findings to link. If a finding decides it, it passed or failed" };
    if (!input.untestedBecause) {
      return { ok: false, reason: `say why it was not tested in \`untestedBecause\`: ${NOT_TESTED_REASONS.join(", ")}` };
    }
    if (input.untestedBecause === "observe-blocked" && ctx.mode !== "observe") {
      return {
        ok: false,
        reason: `this session runs in ${ctx.mode} mode, so observe blocked nothing. Use "no-access" or "out-of-scope", or test it`,
      };
    }
  } else if (input.untestedBecause) {
    return { ok: false, reason: "`untestedBecause` is only for a criterion that was not tested" };
  }
  return {
    ok: true,
    record: {
      ticket: ticket.id,
      criterion: criterion.id,
      text: criterion.text,
      verdict: input.verdict,
      findings,
      confidence: Math.round(input.confidence * 100) / 100,
      reason: reason.slice(0, MAX_REASON),
      ...(input.verdict === "not-tested" ? { untestedBecause: input.untestedBecause } : {}),
      session: ctx.session,
      at: ctx.at,
    },
  };
}

const verdictKey = (v: Pick<CriterionVerdict, "ticket" | "criterion" | "session">): string => `${v.ticket}\u0000${v.criterion}\u0000${v.session}`;

/** Verdicts with one added: a session judging a criterion again replaces its own earlier verdict. */
export function addVerdict(list: readonly CriterionVerdict[], record: CriterionVerdict): CriterionVerdict[] {
  return [...list.filter((v) => verdictKey(v) !== verdictKey(record)), record].slice(-MAX_CRITERION_VERDICTS);
}

/** Two processes' tickets and verdicts as one: per ticket and per session's verdict, the later wins. Idempotent. */
export function mergeTicketData(
  mine: { tickets?: StoredTicket[]; criterionVerdicts?: CriterionVerdict[] },
  theirs: { tickets?: StoredTicket[]; criterionVerdicts?: CriterionVerdict[] },
): { tickets?: StoredTicket[]; criterionVerdicts?: CriterionVerdict[] } {
  const byTicket = new Map<string, StoredTicket>();
  for (const t of [...(theirs.tickets ?? []), ...(mine.tickets ?? [])]) {
    const other = byTicket.get(t.id);
    if (!other || t.loadedAt >= other.loadedAt) byTicket.set(t.id, t);
  }
  const byVerdict = new Map<string, CriterionVerdict>();
  for (const v of [...(theirs.criterionVerdicts ?? []), ...(mine.criterionVerdicts ?? [])]) {
    const other = byVerdict.get(verdictKey(v));
    if (!other || v.at >= other.at) byVerdict.set(verdictKey(v), v);
  }
  const tickets = [...byTicket.values()].sort((a, b) => a.loadedAt.localeCompare(b.loadedAt)).slice(-MAX_TICKETS_KEPT);
  const criterionVerdicts = [...byVerdict.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_CRITERION_VERDICTS);
  return { ...(tickets.length ? { tickets } : {}), ...(criterionVerdicts.length ? { criterionVerdicts } : {}) };
}

/** A criterion's answer once every session's verdict on it is taken together. */
export interface CriterionAnswer {
  criterion: Criterion;
  verdict: CriterionVerdictKind;
  /** For a criterion not tested: why. "not-judged" when no session recorded a verdict at all. */
  untestedBecause?: NotTestedReason | "not-judged";
  findings: string[];
  /** The deciding verdicts' highest confidence; undefined when nothing was judged. */
  confidence?: number;
  reasons: string[];
  sessions: string[];
  /** True when sessions disagreed: one saw it pass and another fail. */
  disputed: boolean;
}

/**
 * One criterion's answer from every verdict recorded on it. A fail from any
 * session decides it, since one session seeing it fail is the evidence; a
 * pass decides it over not tested; with no verdict it is not tested, and
 * says nobody judged it rather than giving a reason nobody gave.
 */
export function answerCriterion(criterion: Criterion, verdicts: readonly CriterionVerdict[]): CriterionAnswer {
  const fails = verdicts.filter((v) => v.verdict === "fail");
  const passes = verdicts.filter((v) => v.verdict === "pass");
  const deciding = fails.length ? fails : passes.length ? passes : verdicts.slice(-1);
  if (deciding.length === 0) {
    return { criterion, verdict: "not-tested", untestedBecause: "not-judged", findings: [], reasons: [], sessions: [], disputed: false };
  }
  const verdict = deciding[0].verdict;
  return {
    criterion,
    verdict,
    ...(verdict === "not-tested" ? { untestedBecause: deciding[0].untestedBecause } : {}),
    findings: [...new Set(deciding.flatMap((v) => v.findings))],
    confidence: Math.max(...deciding.map((v) => v.confidence)),
    reasons: [...new Set(deciding.map((v) => v.reason))],
    sessions: [...new Set(deciding.map((v) => v.session))],
    disputed: fails.length > 0 && passes.length > 0,
  };
}

/** Every criterion of a ticket, answered. */
export function answerTicket(ticket: Ticket, verdicts: readonly CriterionVerdict[]): CriterionAnswer[] {
  return ticket.criteria.map((c) =>
    answerCriterion(
      c,
      // A verdict on a criterion whose words have changed since was about something else.
      verdicts.filter((v) => v.ticket === ticket.id && v.criterion === c.id && (v.text === undefined || v.text === c.text)),
    ),
  );
}

// ── Reporting ─────────────────────────────────────────────────────────────────

/** Why a criterion was not tested, in plain words. */
export const NOT_TESTED_WORDS: Record<NotTestedReason | "not-judged", string> = {
  "no-access": "the account the run used could not reach this part of the site",
  "observe-blocked": "the run was only allowed to look, not to send changes, so this could not be tried",
  "out-of-scope": "it is outside what this run could check",
  "not-judged": "no result was recorded for it",
};

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "2 passed, 1 failed and 1 was not tested", leaving out what is zero. */
export function tally(answers: readonly Pick<CriterionAnswer, "verdict">[]): string {
  const n = (v: CriterionVerdictKind): number => answers.filter((a) => a.verdict === v).length;
  const parts = [
    n("pass") ? `${n("pass")} passed` : "",
    n("fail") ? `${n("fail")} failed` : "",
    n("not-tested") ? `${n("not-tested")} ${n("not-tested") === 1 ? "was" : "were"} not tested` : "",
  ].filter(Boolean);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What the per-ticket sections are built from. */
export interface TicketReportInput {
  tickets: readonly Ticket[];
  verdicts: readonly CriterionVerdict[];
  /** Every finding on the project, to name the ones a verdict links. */
  findings: readonly Finding[];
  /** The plain section's number for each finding it lists ("problem 3 below"). */
  problemNumber?: ReadonlyMap<string, number>;
  /** A finding's picture, relative to the run's folder, when it has one. */
  pictureOf?: (f: Finding) => string | undefined;
}

/** A table cell: the HTML renderer splits rows on every "|", so none may be inside one. */
const cell = (text: string): string => text.replace(/\|/g, "/").replace(/\r?\n/g, " ");

function findingWords(id: string, input: TicketReportInput): string {
  const f = input.findings.find((x) => x.id === id);
  if (!f) return `finding ${id}, which is no longer in the project's memory`;
  const n = input.problemNumber?.get(id);
  return n ? `"${f.title}" (problem ${n} below)` : `"${f.title}" (finding ${id})`;
}

/** The plain verdict, with "unsure" when the agent was. */
function plainResult(a: CriterionAnswer, input: TicketReportInput): string {
  const unsure = a.confidence !== undefined && a.confidence < UNSURE_BELOW ? " (unsure)" : "";
  if (a.verdict === "pass") return `Passed${unsure}`;
  if (a.verdict === "fail") {
    const shown = a.findings.map((id) => findingWords(id, input)).join(", ");
    return `Failed${unsure}: ${shown}${a.disputed ? ". Another check saw it pass" : ""}`;
  }
  return `Not tested: ${NOT_TESTED_WORDS[a.untestedBecause ?? "not-judged"]}`;
}

/**
 * The tickets in plain words, for the top of the plain section: for each
 * ticket a line of totals and a table of its criteria, then the pictures of
 * the findings that show a criterion failing. Empty when no ticket was read.
 */
export function formatTicketsPlain(input: TicketReportInput): string[] {
  if (input.tickets.length === 0) return [];
  const all = input.tickets.flatMap((t) => answerTicket(t, input.verdicts));
  const lines: string[] = [
    `### The tickets`,
    ``,
    all.length > 0
      ? `This run was given ${count(input.tickets.length, "ticket")} with ${count(all.length, "acceptance criterion", "acceptance criteria")}: ${tally(all)}.`
      : `This run was given ${count(input.tickets.length, "ticket")}, and no acceptance criteria could be found in ${input.tickets.length === 1 ? "it" : "them"}.`,
    ``,
  ];
  for (const t of input.tickets) {
    const answers = answerTicket(t, input.verdicts);
    lines.push(`#### ${t.id === t.title ? t.id : `${t.id}: ${t.title}`}`, ``);
    if (answers.length === 0) {
      lines.push(`${t.note ?? "No acceptance criteria were recognised."} Nothing was checked against this ticket.`, ``);
      continue;
    }
    // With one ticket the line above already gave its totals.
    if (input.tickets.length > 1) lines.push(`${tally(answers)[0].toUpperCase()}${tally(answers).slice(1)}.`, ``);
    lines.push(`| | Acceptance criterion | Result |`, `|---|---|---|`);
    for (const a of answers) lines.push(`| ${a.criterion.id} | ${cell(a.criterion.text)} | ${cell(plainResult(a, input))} |`);
    lines.push(``);
    // The pictures of what failed, under the table that names it.
    for (const a of answers.filter((x) => x.verdict === "fail")) {
      for (const id of a.findings) {
        const f = input.findings.find((x) => x.id === id);
        const picture = f && input.pictureOf?.(f);
        if (picture)
          lines.push(
            `What the page showed when ${a.criterion.id} failed:`,
            ``,
            `![${a.criterion.id} failed: ${f.title.replace(/[[\]]/g, "")}](${picture})`,
            ``,
          );
      }
    }
  }
  return lines;
}

/**
 * The tickets for the technical report: per ticket, each criterion's verdict
 * with its confidence, the finding ids, the reason as recorded and the
 * sessions that judged it. Empty when no ticket was read.
 */
export function formatTicketsTechnical(input: TicketReportInput): string[] {
  if (input.tickets.length === 0) return [];
  const lines: string[] = [
    `## Acceptance criteria`,
    ``,
    `Each verdict is the agent's judgement, recorded with \`scout_criterion\` and its confidence; the link from a criterion to a finding is that judgement, not a match on words. A fail from any session decides a criterion, and a criterion no session judged is listed as not judged.`,
    ``,
  ];
  for (const t of input.tickets) {
    lines.push(`### ${t.id}: ${t.title}`, ``, `Read from ${t.source}.`, ``);
    if (t.criteria.length === 0) {
      lines.push(t.note ?? "No acceptance criteria were recognised.", ``);
      continue;
    }
    lines.push(`| Id | Criterion | Verdict | Confidence | Findings | Why | Judged by |`, `|---|---|---|---:|---|---|---|`);
    for (const a of answerTicket(t, input.verdicts)) {
      const verdict = a.verdict === "not-tested" ? `not tested (${a.untestedBecause})` : a.verdict + (a.disputed ? " (disputed)" : "");
      lines.push(
        `| ${a.criterion.id} | ${cell(a.criterion.text)} | ${verdict} | ${a.confidence === undefined ? "—" : a.confidence.toFixed(2)} | ${
          a.findings.map((id) => `\`${id}\``).join(" ") || "—"
        } | ${cell(a.reasons.join(" / ")) || "—"} | ${cell(a.sessions.join(", ")) || "—"} |`,
      );
    }
    lines.push(``);
  }
  return lines;
}

/** One line for the report's summary: how the criteria came out. */
export function ticketSummaryLine(tickets: readonly Ticket[], verdicts: readonly CriterionVerdict[]): string | null {
  if (tickets.length === 0) return null;
  const all = tickets.flatMap((t) => answerTicket(t, verdicts));
  return `TICKETS: ${count(tickets.length, "ticket")}, ${count(all.length, "criterion", "criteria")}${all.length ? ` — ${tally(all)}` : ""}`;
}

/** What scout_tickets says after reading: each ticket's criteria with their ids, and what to do next. */
export function formatReading(added: readonly Ticket[]): string {
  const lines: string[] = [];
  const total = added.reduce((n, t) => n + t.criteria.length, 0);
  lines.push(`Read ${count(added.length, "ticket")} with ${count(total, "acceptance criterion", "acceptance criteria")}.`, ``);
  for (const t of added) {
    lines.push(`${t.id}: ${t.title} (from ${t.source})`);
    if (t.criteria.length === 0) lines.push(`  ⚠ ${t.note ?? "No acceptance criteria were recognised."} Ask the person for them; do not make them up.`);
    for (const c of t.criteria) lines.push(`  ${c.id} [${c.shape}] ${c.text}`);
    lines.push(``);
  }
  if (total > 0) {
    lines.push(
      `Next: plan the run against these criteria. Measure each with a journey whose goal names it (scout_journey {action:"start", goal:"${added.find((t) => t.criteria.length)!.id} AC1: …"}), and in a parallel run pass them as scout_lane_brief's goal, which then lists them in every lane's brief.`,
      `When a criterion is decided, record it: scout_criterion {ticket, criterion, verdict:"pass"|"fail"|"not-tested", findings, confidence, reason}. A fail names the findings that show it (file them first). A criterion you could not try says why in untestedBecause: ${NOT_TESTED_REASONS.join(", ")}. The link from a criterion to a finding is your judgement: state your confidence honestly.`,
    );
  }
  return lines.join("\n").trimEnd();
}

/** The criteria a lane brief lists when the run was given tickets. */
export function formatCriteriaForLanes(tickets: readonly Ticket[]): string {
  const withCriteria = tickets.filter((t) => t.criteria.length > 0);
  if (withCriteria.length === 0) return "";
  const lines = [
    `ACCEPTANCE CRITERIA this run answers. A lane whose routes decide one records it with scout_criterion {ticket, criterion, verdict, findings, confidence, reason} before reporting; a lane that cannot reach one leaves it to the lane that owns it.`,
  ];
  for (const t of withCriteria) {
    lines.push(`  ${t.id}: ${t.title}`);
    for (const c of t.criteria) lines.push(`    ${c.id} ${c.text}`);
  }
  return lines.join("\n");
}
