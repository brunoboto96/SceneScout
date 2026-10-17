/**
 * Runs scout_ticket_preview and scout_ticket_file: a thin second front door to
 * `scenescout export` (export-run.ts), whose selection, marker, inert issue
 * body, severity map and cap it uses unchanged. The rules of a preview (its
 * identity, its ten minutes, what binds it, what the confirmation form says)
 * are engine/ticket-preview.ts's; this file reads the project's findings, runs
 * the export, and asks the person through whatever form the caller shows.
 *
 * Credentials come from the environment only, as the CLI's do, and nothing
 * written here or by the export carries them: every line goes through the
 * same redactor.
 */
import fs from "node:fs";
import path from "node:path";
import { readFindings, redactKeys } from "./engine/ci.js";
import {
  credentialSecrets,
  EXPORT_RECORD_FILE,
  parseExportArgs,
  parseExportRecord,
  recordKey,
  selectFindings,
  trackerCredentials,
  TRACKER_LABEL,
  type ExportOptions,
  type PlanEntry,
} from "./engine/export.js";
import type { ConfirmFormOutcome } from "./engine/guided.js";
import { TICKET_SAYS, ticketNoSignIn, ticketsFiled } from "./engine/guided-words.js";
import { MEMORY_DIRNAME, type Finding } from "./engine/memory.js";
import {
  checkPreview,
  checkTicketTarget,
  MAX_PREVIEW_IDS,
  newPreviewId,
  PREVIEW_TTL_MS,
  previewDigest,
  ticketConfirmForm,
  ticketConfirmVerdict,
  ticketExportArgs,
  ticketExportCommand,
  ticketTitle,
  trackerEnv,
  trackerWhere,
  type KeptPreview,
  type TicketConfirmOutcome,
  type TicketPreview,
  type TicketPreviews,
} from "./engine/ticket-preview.js";
import { placeTickets, recordDigest, recordPlaces, type TicketStatus, type TicketStatusReads, type WatchedTicket } from "./engine/ticket-status.js";
import { readFiledIssues, runExport, type ExportDeps } from "./export-run.js";

/** What a preview or a filing needs besides its input: the environment, the clock, and the export's own dependencies (a stand-in tracker in tests). */
export type TicketDeps = Omit<ExportDeps, "log" | "error">;

export type PreviewResult = { ok: true; preview: TicketPreview; text: string } | { ok: false; error: string };

export interface FileResult {
  filed: boolean;
  outcome: TicketConfirmOutcome | "unknown" | "expired" | "altered" | "empty" | "could-not-file";
  tellPerson: string;
  tickets: Array<{ id: string; ref: string; url: string }>;
  /** What went wrong while filing, already redacted. */
  problems: string[];
  text: string;
}

/** The project's findings as memory.json holds them on disk, or null when there is none. */
function readMemory(projectDir: string): unknown {
  const file = path.join(projectDir, MEMORY_DIRNAME, "memory.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * The findings a preview names, as they read now: each must still be one the
 * export would file (open, readable). Null when any is not, which makes the
 * preview's digest no longer match.
 */
function currentFindings(projectDir: string, ids: readonly string[], o: ExportOptions): Finding[] | null {
  const memory = readMemory(projectDir);
  if (!memory) return null;
  const selection = selectFindings(memory, { minSeverity: o.minSeverity, only: [...ids], includeWorthALook: o.includeWorthALook });
  const byId = new Map(selection.candidates.map((f) => [f.id, f]));
  const found = ids.map((id) => byId.get(id));
  return found.every((f): f is Finding => f !== undefined) ? found : null;
}

const quietDeps = (deps: TicketDeps, env: Record<string, string | undefined>, lines: string[]): ExportDeps => ({
  ...deps,
  env,
  log: (l) => lines.push(l),
  error: (l) => lines.push(l),
});

/** Preview filing these findings: reads the tracker to find what it already holds, and sends nothing. */
export async function previewTickets(
  input: { ids: unknown; to: unknown; target: unknown },
  projectDir: string,
  store: TicketPreviews,
  deps: TicketDeps,
): Promise<PreviewResult> {
  const env = trackerEnv(deps.env);
  const secrets = credentialSecrets(env);
  const clean = (s: string): string => redactKeys(s, secrets);
  const t = checkTicketTarget(input.to, input.target);
  if (!t.ok) return { ok: false, error: t.error };
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.filter((x): x is string => typeof x === "string"))] : [];
  if (ids.length === 0) return { ok: false, error: "pass the ids of the problems the person chose, as scout_cards shows them" };
  if (ids.length > MAX_PREVIEW_IDS) return { ok: false, error: `a preview names at most ${MAX_PREVIEW_IDS} problems` };
  const parsed = parseExportArgs(ticketExportArgs(t, ids, projectDir), projectDir, env);
  if (!parsed.ok) return { ok: false, error: clean(parsed.error) };
  const o = parsed.options;
  const credentials = trackerCredentials(o.to, env);
  if (!credentials.ok) return { ok: false, error: `${ticketNoSignIn(TRACKER_LABEL[o.to])} (${credentials.error})` };

  const memory = readMemory(projectDir);
  if (!memory) return { ok: false, error: "this project has no findings yet: run a check first" };
  const selection = selectFindings(memory, o);
  if (selection.unknownOnly.length > 0) return { ok: false, error: `no finding with id ${selection.unknownOnly.join(", ")} in this project` };

  const lines: string[] = [];
  const now = deps.now ?? Date.now;
  const outcome = selection.candidates.length > 0 ? await runExport(o, quietDeps(deps, env, lines)) : { exitCode: 0, plan: [] as PlanEntry[] };
  if (outcome.exitCode !== 0)
    return { ok: false, error: clean(`could not read ${trackerWhere(o)}: ${lines.filter((l) => /scenescout export:/.test(l)).join(" ")}`) };
  const ticket = (f: Finding) => ({ id: f.id, severity: f.severity, title: ticketTitle(f) });
  const toFile = outcome.plan.filter((e) => e.outcome === "file").map((e) => e.finding);
  const createdMs = now();
  const preview: TicketPreview = {
    previewId: toFile.length > 0 ? newPreviewId() : null,
    to: o.to,
    where: trackerWhere(o),
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + PREVIEW_TTL_MS).toISOString(),
    toFile: toFile.map(ticket),
    alreadyFiled: outcome.plan.flatMap((e) =>
      e.outcome === "already-filed" ? [{ ...ticket(e.finding), ref: e.issue.ref, url: clean(e.issue.url), open: e.issue.open }] : [],
    ),
    later: outcome.plan.filter((e) => e.outcome === "over-cap").map((e) => ticket(e.finding)),
    cap: o.maxIssues,
    leftOut: [
      ...selection.leftOut.map((x) => ({ id: x.id, reason: x.reason })),
      // A Jira create that may have gone through holds its finding back for a while, out of the export's plan: say so rather than drop it.
      ...selection.candidates
        .filter((f) => !outcome.plan.some((e) => e.finding.id === f.id))
        .map((f) => ({ id: f.id, reason: "held back: a filing a few minutes ago may already have made it; make a new preview later" })),
    ],
  };
  store.add({ preview, options: o, digest: previewDigest(preview.where, toFile), createdMs });
  return { ok: true, preview, text: clean(previewText(preview)) };
}

/** A preview as the agent reads it and shows it. */
export function previewText(p: TicketPreview): string {
  const out = [
    p.previewId
      ? `Preview ${p.previewId} for ${p.where}: ${p.toFile.length} ticket(s) would be filed. Nothing has been sent. It can be filed until ${p.expiresAt}.`
      : `Nothing to file in ${p.where}.`,
    ...p.toFile.map((t, i) => `  ${i + 1}. ${t.title} (${t.severity}) [finding ${t.id}]`),
  ];
  if (p.alreadyFiled.length)
    out.push("Already filed, so not filed again:", ...p.alreadyFiled.map((t) => `  ${t.ref} ${t.title}${t.open ? "" : " (closed)"} ${t.url}`));
  if (p.later.length) out.push(`Waiting for the next filing (one filing sends at most ${p.cap}):`, ...p.later.map((t) => `  ${t.title} [finding ${t.id}]`));
  if (p.leftOut.length) out.push("Left out:", ...p.leftOut.map((x) => `  ${x.id}: ${x.reason}`));
  if (p.previewId)
    out.push(
      "",
      `Show the person this list. When they want it filed, call scout_ticket_file with previewId "${p.previewId}": the server then asks THEM in its own form, and files only on their yes. You cannot answer that form.`,
    );
  return out.join("\n");
}

/**
 * File a preview: only while it is fresh and its findings read as they did,
 * only on the person's yes in the form `confirm` shows, and only the findings
 * it listed. The preview is used up by the attempt, whatever its outcome.
 * Its findings are read from the project it was made in, whichever is open now.
 */
export async function fileTickets(
  previewId: unknown,
  store: TicketPreviews,
  confirm: (form: ReturnType<typeof ticketConfirmForm>) => Promise<ConfirmFormOutcome>,
  deps: TicketDeps,
): Promise<FileResult> {
  const now = deps.now ?? Date.now;
  const env = trackerEnv(deps.env);
  const secrets = credentialSecrets(env);
  const clean = (s: string): string => redactKeys(s, secrets);
  const refused = (outcome: FileResult["outcome"], tellPerson: string, cli?: string): FileResult => ({
    filed: false,
    outcome,
    tellPerson,
    tickets: [],
    problems: [],
    text: clean(
      [
        `Nothing was filed (${outcome}). Do not call scout_ticket_file again unless the person asks to file: it needs a new preview from scout_ticket_preview.`,
        // Only where the app has no form to ask with: a developer can file the same list from a terminal, after its dry run.
        ...(cli
          ? [
              `Give the person this command for a developer to run from a terminal, with the tracker's sign-in in that terminal's environment. Without --yes it is a dry run that lists what it would file; adding --yes files them, each problem once:`,
              `  ${cli}`,
            ]
          : []),
      ].join("\n"),
    ),
  });
  const id = typeof previewId === "string" ? previewId : "";
  const kept = store.get(id, now());
  const digestNow = (k: KeptPreview): string | null => {
    const ids = k.preview.toFile.map((t) => t.id);
    const found = currentFindings(k.options.projectDir, ids, k.options);
    return found ? previewDigest(k.preview.where, found) : null;
  };
  const before = checkPreview(kept, now(), kept ? digestNow(kept) : null);
  if (!before.ok) {
    if (kept) store.take(id);
    return refused(before.why, TICKET_SAYS[before.why]);
  }
  // Used once: whatever the person answers, a second filing needs a new preview.
  store.take(id);
  const k = kept!;
  const verdict = ticketConfirmVerdict(await confirm(ticketConfirmForm(k.preview)));
  if (!verdict.confirmed)
    return refused(
      verdict.outcome,
      verdict.tellPerson,
      verdict.outcome === "unsupported"
        ? ticketExportCommand(
            k.options,
            k.preview.toFile.map((t) => t.id),
          )
        : undefined,
    );
  // The form may have waited: the preview must still be fresh and its findings unchanged when the filing starts.
  const after = checkPreview(k, now(), digestNow(k));
  if (!after.ok) return refused(after.why, TICKET_SAYS[after.why]);

  const ids = k.preview.toFile.map((t) => t.id);
  // The tracker settings the preview was made with, not the environment's now: the person confirmed that place.
  // Exactly the previewed findings, and no more issues than there are of them.
  const o: ExportOptions = { ...k.options, only: ids, maxIssues: ids.length, dryRun: false };
  const lines: string[] = [];
  const outcome = await runExport(o, quietDeps(deps, env, lines));
  const tickets = outcome.filed.map((x) => ({ id: x.id, ref: x.issue.ref, url: clean(x.issue.url) }));
  const problems = lines.filter((l) => l.startsWith("scenescout export:")).map((l) => clean(l.replace(/^scenescout export: /, "")));
  const filedText = tickets.map((x) => `  ${x.ref} ${x.url} [finding ${x.id}]`);
  const already = outcome.plan.filter((e) => e.outcome === "already-filed").length;
  const head = `Filed ${tickets.length} ticket(s) in ${k.preview.where}${already ? `; ${already} found filed already and not filed again` : ""}.`;
  const done = outcome.exitCode === 0;
  return {
    filed: tickets.length > 0,
    outcome: done ? "confirmed" : "could-not-file",
    tellPerson: done ? ticketsFiled(tickets.length, k.preview.where) : TICKET_SAYS["could-not-file"],
    tickets,
    problems,
    text: clean([head, ...filedText, ...(problems.length ? ["Problems:", ...problems.map((p) => `  ${p}`)] : [])].join("\n")),
  };
}

/**
 * The tickets this project filed, read back from each tracker for whether
 * they are open (scout_ticket_status, design 2.6). Reads each tracker at most
 * once every TICKET_STATUS_EVERY_MS for a project; sooner, it answers what the
 * last read found. Only a place the server's settings point at is read: a
 * record written against another API address or Jira site is named as not
 * read. Nothing is sent but reads, and every line is redacted.
 */
export async function ticketStatus(projectDir: string, reads: TicketStatusReads, deps: TicketDeps): Promise<TicketStatus> {
  const now = (deps.now ?? Date.now)();
  const env = trackerEnv(deps.env);
  const clean = (s: string): string => redactKeys(s, credentialSecrets(env));
  const recordPath = path.join(projectDir, MEMORY_DIRNAME, EXPORT_RECORD_FILE);
  let text: string | null = null;
  let unreadable: string | null = null;
  try {
    text = fs.readFileSync(recordPath, "utf8");
  } catch (err) {
    // None: nothing has been filed from this project. Any other failure is said, never taken as none.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable = err instanceof Error ? err.message : String(err);
  }
  return reads.read(projectDir, now, recordDigest(text), async () => {
    if (unreadable !== null) return { tickets: [], problems: [clean(`the record of filed tickets could not be read: ${unreadable}`)] };
    const record = parseExportRecord(text);
    if (!record.ok) return { tickets: [], problems: [clean(`the record of filed tickets could not be read: ${record.error}`)] };
    const places = recordPlaces(record.value);
    if (!places.length) return { tickets: [], problems: [] };
    const findings = new Map(
      readFindings(readMemory(projectDir)).map((f): [string, { title: string; severity: string; status?: string }] => [
        f.id,
        { title: ticketTitle(f), severity: f.severity, status: f.status },
      ]),
    );
    const tickets: WatchedTicket[] = [];
    const problems: string[] = [];
    for (const place of places) {
      const t = checkTicketTarget(place.to, place.target);
      const label = `${TRACKER_LABEL[place.to]} ${place.target}`;
      if (!t.ok) continue;
      const where = t.to === "github" ? ["--to", "github", "--repo", t.target] : ["--to", "jira", "--jira-project", t.target];
      const parsed = parseExportArgs([...where, "--project", projectDir, "--dry-run"], projectDir, env);
      if (!parsed.ok || recordKey(parsed.options) !== place.key) {
        problems.push(`${label}: not read, as the server's settings point at another ${place.to === "github" ? "GitHub API address" : "Jira site"}`);
        continue;
      }
      const recorded = Object.fromEntries(
        Object.entries(record.value[place.key]).flatMap(([id, e]) => ("uncertain" in e ? [] : [[id, { ref: e.ref, number: e.number }] as const])),
      );
      try {
        const issues = await readFiledIssues(parsed.options, { ...deps, env }, recorded);
        tickets.push(...placeTickets(trackerWhere(parsed.options), record.value[place.key], issues, findings));
      } catch (err) {
        problems.push(clean(`${label}: could not be read (${err instanceof Error ? err.message : String(err)})`));
      }
    }
    return { tickets, problems };
  });
}
