/**
 * The template-driven test report of a recorded `scenescout check`
 * (`--record --template <file.json>`): the same run the replay page shows, laid
 * out as a document a reviewer signs off on paper or in their own system.
 *
 * The template decides the layout only: the title block, the document ID, the
 * order of the sections, the columns of the test table, the sign-off roles,
 * free text and every word the page uses. The data is the run's: each saved
 * flow is a test, each of its steps a row, and a step's result comes from the
 * replay's assertions alone, never from a model. A step that failed or was
 * refused is a deviation. The manifest lists the SHA-256 of every evidence
 * file, so a reader can tell the frames and videos beside the report are the
 * ones the run wrote.
 *
 * Everything here but readReportTemplate and evidenceIndex is pure: the same
 * result, template and evidence render the same bytes (a golden file in
 * scripts/report-test.ts holds that). check-run.ts reads the files and writes the page.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPLAY_FILE, replayFrames, replayVideos, type ReplayJourney, type ReplayStep, type ReplayStepResult } from "./check-replay.js";
import { summarise, type CheckResult } from "./check.js";
import { parseJsonFile } from "./flow.js";
import { escapeHtml } from "./replay.js";

/** The page's generator mark: an earlier run's report is removed or replaced only when it carries it. */
export const REPORT_GENERATOR = "scenescout-check-report";
/** The file the report is written to when the template names none. */
export const DEFAULT_REPORT_FILE = "report.html";
/** What the cell of a missing value shows. */
export const MISSING = "—";

/** A report's file name: plain, in the output folder itself, ending .html. */
export const REPORT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.html$/;

/**
 * The report file an earlier check.json records it wrote (its `testReport`),
 * or null: anything that is not a plain report file name is ignored, so the
 * value can never point outside the output folder or at the replay page.
 */
export function recordedReportFile(checkJson: unknown): string | null {
  if (typeof checkJson !== "object" || checkJson === null) return null;
  const file = (checkJson as { testReport?: unknown }).testReport;
  return typeof file === "string" && REPORT_FILE_RE.test(file) && file.toLowerCase() !== REPLAY_FILE ? file : null;
}

/** Whether an HTML file is a report a check wrote. */
export function isGeneratedReport(html: string): boolean {
  return html.includes(`<meta name="generator" content="${REPORT_GENERATOR}">`);
}

// ── the template ────────────────────────────────────────────────────────────

/** The columns a test table may have, in any order. */
export const REPORT_COLUMNS = ["testId", "requirements", "step", "expected", "actual", "result", "evidence"] as const;
export type ReportColumn = (typeof REPORT_COLUMNS)[number];

/** The sections a template may order. Each data section appears at most once; `text` as often as wanted. */
export const REPORT_SECTIONS = ["summary", "tests", "deviations", "manifest", "signoff", "text"] as const;

/** The tokens the title block may use, each replaced by a fact of the run. */
export const REPORT_TOKENS = {
  date: "the day the run started, YYYY-MM-DD (UTC)",
  time: "the time the run started, HH:MM:SS (UTC)",
  run: "the run's start as YYYYMMDD-HHMMSS (UTC)",
  version: "the SceneScout version",
  commit: "the commit the run was of (GITHUB_SHA), shortened to 12 characters, or — when none",
} as const;
type ReportToken = keyof typeof REPORT_TOKENS;

/** Every word the page writes that is not data. A template may replace any of them, so it carries its own vocabulary. */
export const DEFAULT_LABELS = {
  pass: "Pass",
  fail: "Fail",
  refused: "Could not run",
  notRun: "Not run",
  asExpected: "As expected",
  summary: "Summary",
  tests: "Test results",
  deviations: "Deviations",
  manifest: "Evidence manifest",
  signoff: "Sign-off",
  testId: "Test ID",
  requirements: "Requirements",
  step: "Step",
  expected: "Expected result",
  actual: "Actual result",
  result: "Result",
  evidence: "Evidence",
  frame: "Frame after the step",
  video: "Video",
  test: "Test",
  number: "#",
  noDeviations: "No deviations.",
  noTests: "No saved flow ran.",
  overall: "Overall result",
  target: "Target",
  started: "Started",
  ended: "Ended",
  tool: "SceneScout version",
  commit: "Commit",
  testsRun: "Tests",
  testsPassed: "Passed",
  testsFailed: "Failed",
  testsNotRun: "Could not run",
  gateIssues: "Issues failing the check's gate",
  file: "File",
  bytes: "Bytes",
  sha256: "SHA-256",
  notFound: "not found",
  name: "Name",
  role: "Role",
  signature: "Signature",
  signedDate: "Date",
  meaning: "Meaning of signature",
  documentId: "Document ID",
} as const;
export type ReportLabel = keyof typeof DEFAULT_LABELS;

const text = (what: string, max: number) => z.string().trim().min(1, `is ${what}`).max(max, `is at most ${max} characters`);

const TOKEN_RE = /\{([^{}]*)\}/g;

/** Text that may use the title block's tokens: every `{…}` must name one. */
const tokenText = (what: string, max: number) =>
  text(what, max).superRefine((value, ctx) => {
    for (const m of value.matchAll(TOKEN_RE)) {
      if (!Object.hasOwn(REPORT_TOKENS, m[1]))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `uses {${m[1]}}, which is not a token: use ${Object.keys(REPORT_TOKENS)
            .map((t) => `{${t}}`)
            .join(", ")}`,
        });
    }
  });

const paragraphs = z.array(text("a paragraph of text", 4000)).max(50, "holds at most 50 paragraphs");
const heading = text("the section's heading", 200);

const columnSchema = z.union([z.enum(REPORT_COLUMNS), z.object({ key: z.enum(REPORT_COLUMNS), heading }).strict()], {
  errorMap: () => ({ message: `must be one of ${REPORT_COLUMNS.join(", ")}, or { "key": one of those, "heading": "…" }` }),
});

const signoffRole = z.union(
  [text("the role that signs", 200), z.object({ role: text("the role that signs", 200), meaning: text("what the signature means", 500).optional() }).strict()],
  {
    errorMap: () => ({ message: 'must be the role that signs, e.g. "Reviewer", or { "role": "…", "meaning": "…" }' }),
  },
);

const sectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("summary"), heading: heading.optional(), paragraphs: paragraphs.optional() }).strict(),
  z
    .object({
      type: z.literal("tests"),
      heading: heading.optional(),
      paragraphs: paragraphs.optional(),
      columns: z
        .array(columnSchema)
        .min(1, "needs at least one column")
        .refine((cols) => new Set(cols.map((c) => (typeof c === "string" ? c : c.key))).size === cols.length, { message: "names a column twice" }),
    })
    .strict(),
  z.object({ type: z.literal("deviations"), heading: heading.optional(), paragraphs: paragraphs.optional() }).strict(),
  z.object({ type: z.literal("manifest"), heading: heading.optional(), paragraphs: paragraphs.optional() }).strict(),
  z
    .object({
      type: z.literal("signoff"),
      heading: heading.optional(),
      paragraphs: paragraphs.optional(),
      roles: z.array(signoffRole).min(1, "needs at least one role").max(20, "holds at most 20 roles"),
    })
    .strict(),
  z.object({ type: z.literal("text"), heading: heading.optional(), paragraphs: paragraphs.min(1, "needs at least one paragraph") }).strict(),
]);

const labelsSchema = z
  .object(
    Object.fromEntries(Object.keys(DEFAULT_LABELS).map((k) => [k, text("the word to use", 200).optional()])) as Record<ReportLabel, z.ZodOptional<z.ZodString>>,
  )
  .strict();

const templateSchema = z
  .object({
    /** The file name the report is written to, beside replay.html. */
    file: z
      .string()
      .regex(REPORT_FILE_RE, "must be a plain file name ending .html, e.g. test-report.html")
      .refine((f) => f.toLowerCase() !== REPLAY_FILE, { message: `must not be ${REPLAY_FILE}, which the replay page is written to` })
      .optional(),
    title: tokenText("the document's title", 300),
    subtitle: tokenText("a line under the title", 300).optional(),
    documentId: tokenText("the document ID pattern, e.g. TR-{run}", 200).optional(),
    fields: z
      .array(z.object({ label: text("the field's label", 200), value: tokenText("the field's value", 500) }).strict())
      .max(20, "holds at most 20 fields")
      .optional(),
    labels: labelsSchema.optional(),
    sections: z
      .array(sectionSchema)
      .min(1, "needs at least one section")
      .max(50, "holds at most 50 sections")
      .superRefine((sections, ctx) => {
        const seen = new Set<string>();
        sections.forEach((s, i) => {
          if (s.type !== "text" && seen.has(s.type))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, "type"],
              message: `"${s.type}" appears more than once: each section but text appears at most once`,
            });
          seen.add(s.type);
        });
      }),
  })
  .strict();

export type ReportTemplate = z.infer<typeof templateSchema>;
type ReportSection = ReportTemplate["sections"][number];

/** Validate a template's text. Every mistake names the file and the field, as a flow's do. */
export function parseReportTemplate(raw: string, file: string): { ok: true; template: ReportTemplate } | { ok: false; error: string } {
  const parsed = parseJsonFile(raw, file, templateSchema);
  if (!parsed.ok) {
    // A section's discriminator is "type", not a flow's "action": say so in its own words.
    return { ok: false, error: parsed.error.replace(/must be one of navigate, [^;]*/g, `must be one of ${REPORT_SECTIONS.join(", ")}`) };
  }
  return { ok: true, template: parsed.data };
}

/** Read and validate a template file, or throw a sentence naming it. */
export function readReportTemplate(file: string): ReportTemplate {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`--template: cannot read ${file} (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = parseReportTemplate(raw, file);
  if (!parsed.ok) throw new Error(`--template: ${parsed.error}`);
  return parsed.template;
}

/** The file the template's report is written to. */
export function reportFileOf(template: Pick<ReportTemplate, "file">): string {
  return template.file ?? DEFAULT_REPORT_FILE;
}

/** Why --template cannot be used with these options, or null: the report renders a recorded run, so recording must be on. */
export function templateRecordError(options: { template?: string; record?: boolean }): string | null {
  if (options.template === undefined || options.record === true) return null;
  return "--template renders the report from a recorded check's frames: add --record (or set SCENESCOUT_RECORD=on)";
}

// ── the evidence ────────────────────────────────────────────────────────────

/** One file the report vouches for: its path beside the report, its size and its SHA-256, or that it was not there. */
export interface EvidenceEntry {
  path: string;
  bytes: number | null;
  sha256: string | null;
}

/** The files a recorded check's report vouches for, in this order: check.json, the replay page, every frame and every video. */
export function evidenceFiles(result: Pick<CheckResult, "replay">): string[] {
  if (!result.replay) return ["check.json"];
  return ["check.json", REPLAY_FILE, ...replayFrames(result.replay), ...replayVideos(result.replay)];
}

/** Hash each file beside the report. A file that is not there is listed as missing rather than left out. */
export function evidenceIndex(outDir: string, files: readonly string[]): EvidenceEntry[] {
  return files.map((rel) => {
    try {
      const data = fs.readFileSync(path.join(outDir, ...rel.split("/")));
      return { path: rel, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: rel, bytes: null, sha256: null };
      throw err;
    }
  });
}

// ── the page ────────────────────────────────────────────────────────────────

/** What the report says about the run beyond its result. */
export interface ReportMeta {
  version: string;
  commit?: string;
}

/** One test of the report: a saved flow, as the replay recorded it. */
interface ReportTest {
  journey: ReplayJourney;
  /** The role it ran as, or null for the check's own session. */
  role: string | null;
}

/** Every test in the order the replay shows them: the check's own session first, then each role. */
function testsOf(result: CheckResult): ReportTest[] {
  return (result.replay?.roles ?? []).flatMap((r) => r.journeys.map((journey) => ({ journey, role: r.own ? null : r.role })));
}

function tokensOf(result: CheckResult, meta: ReportMeta): Record<ReportToken, string> {
  const started = result.replay?.startedAt ?? result.generatedAt;
  const date = started.slice(0, 10);
  const time = started.slice(11, 19);
  return {
    date,
    time,
    run: `${date.replace(/-/g, "")}-${time.replace(/:/g, "")}`,
    version: meta.version,
    commit: meta.commit ? meta.commit.slice(0, 12) : MISSING,
  };
}

function fill(value: string, tokens: Record<ReportToken, string>): string {
  return value.replace(TOKEN_RE, (whole, name: string) => (Object.hasOwn(tokens, name) ? tokens[name as ReportToken] : whole));
}

/** A UTC time as the page shows it. */
function stamp(iso: string): string {
  return iso.length >= 19 ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : iso;
}

/** Escaped text, or the missing mark. */
function cell(value: string | undefined | null): string {
  return value === undefined || value === null || value === "" ? MISSING : escapeHtml(value);
}

type Labels = Record<ReportLabel, string>;

function resultWord(result: ReplayStepResult | ReplayJourney["status"], L: Labels): string {
  return result === "passed" ? L.pass : result === "failed" ? L.fail : result === "refused" ? L.refused : L.notRun;
}

/** What a step did, in words: as expected when it passed, why when it did not, nothing when it never ran. */
function actualOf(step: ReplayStep, L: Labels): string | undefined {
  if (step.result === "passed") return L.asExpected;
  if (step.result === "not-run") return undefined;
  return [step.reason, step.path ? `on ${step.path}` : ""].filter(Boolean).join(" ") || undefined;
}

function paragraphsHtml(list: readonly string[] | undefined): string {
  return (list ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

function sectionHead(section: ReportSection, fallback: string): string {
  return `<h2>${escapeHtml(section.heading ?? fallback)}</h2>${paragraphsHtml(section.paragraphs)}`;
}

function frameCellHtml(step: ReplayStep, L: Labels): string {
  if (!step.frame) return MISSING;
  const src = escapeHtml(step.frame);
  return `<a class="frame" href="${src}" target="_blank" rel="noreferrer" data-testid="report-frame-open"><img loading="lazy" src="${src}" alt="${escapeHtml(`${L.frame}: ${step.caption}`)}"><span>${escapeHtml(step.frame)}</span></a>`;
}

function summaryHtml(section: ReportSection, result: CheckResult, meta: ReportMeta, L: Labels): string {
  const tests = testsOf(result);
  const { passed, couldNotRun, failing } = summarise(result);
  const overall = couldNotRun > 0 ? L.refused : passed ? L.pass : L.fail;
  const count = (status: ReplayJourney["status"]) => tests.filter((t) => t.journey.status === status).length;
  const row = (term: string, value: string, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><th scope="row">${escapeHtml(term)}</th><td>${value}</td></tr>`;
  const overallClass = couldNotRun === 0 && passed ? "pass" : "fail";
  return (
    `<section class="summary" data-section="summary">${sectionHead(section, L.summary)}<table class="facts">` +
    row(L.overall, `<span class="verdict ${overallClass}" data-testid="report-verdict">${escapeHtml(overall)}</span>`) +
    row(L.target, cell(result.url)) +
    row(L.started, cell(stamp(result.replay?.startedAt ?? result.generatedAt))) +
    row(L.ended, cell(stamp(result.generatedAt))) +
    row(L.tool, cell(meta.version)) +
    row(L.commit, cell(meta.commit)) +
    row(L.testsRun, String(tests.length)) +
    row(L.testsPassed, String(count("passed"))) +
    row(L.testsFailed, String(count("failed"))) +
    row(L.testsNotRun, String(count("refused"))) +
    row(L.deviations, String(deviationsOf(result).length)) +
    row(L.gateIssues, String(failing)) +
    `</table></section>`
  );
}

function columnsOf(section: Extract<ReportSection, { type: "tests" }>, L: Labels): Array<{ key: ReportColumn; heading: string }> {
  return section.columns.map((c) => (typeof c === "string" ? { key: c, heading: L[c] } : { key: c.key, heading: c.heading }));
}

function testsHtml(section: Extract<ReportSection, { type: "tests" }>, result: CheckResult, L: Labels): string {
  const tests = testsOf(result);
  const columns = columnsOf(section, L);
  const head = `<thead><tr>${columns.map((c) => `<th scope="col" data-column="${c.key}">${escapeHtml(c.heading)}</th>`).join("")}</tr></thead>`;
  const bodies = tests.map(({ journey: j, role }, ti) => {
    const verdictClass = j.status === "passed" ? "pass" : "fail";
    const video = j.video
      ? ` <a class="video" href="${escapeHtml(j.video)}" target="_blank" rel="noreferrer" data-testid="report-video-open">${escapeHtml(L.video)}: ${escapeHtml(j.video)}</a>`
      : "";
    const caption =
      `<tr class="test-head ${verdictClass}"><th colspan="${columns.length}" scope="rowgroup">` +
      `<span class="verdict ${verdictClass}">${escapeHtml(resultWord(j.status, L))}</span> ` +
      `<b>${cell(j.id)}</b> ${escapeHtml(j.name)} <span class="file">${escapeHtml(j.file)}${role === null ? "" : ` · ${escapeHtml(L.role)}: ${escapeHtml(role)}`}</span>${video}</th></tr>`;
    const rows = j.steps.map((s, si) => {
      const cells = columns.map(({ key }) => {
        switch (key) {
          case "testId":
          case "requirements":
            // One cell for the whole test, spanning its steps.
            if (si > 0) return "";
            return `<td rowspan="${j.steps.length}" class="span">${key === "testId" ? cell(j.id) : j.requirements && j.requirements.length > 0 ? j.requirements.map(escapeHtml).join(", ") : MISSING}</td>`;
          case "step":
            return `<td class="step"><span class="n">${s.n}.</span> ${escapeHtml(s.caption)}</td>`;
          case "expected":
            return `<td>${cell(s.expected)}</td>`;
          case "actual":
            return `<td>${cell(actualOf(s, L))}</td>`;
          case "result":
            return `<td class="result r-${s.result}" data-result="${s.result}">${escapeHtml(resultWord(s.result, L))}</td>`;
          case "evidence":
            return `<td class="evidence">${frameCellHtml(s, L)}</td>`;
        }
      });
      return `<tr class="${s.result}">${cells.join("")}</tr>`;
    });
    return `<tbody id="test-${ti + 1}" data-status="${j.status}">${caption}${rows.join("")}</tbody>`;
  });
  return (
    `<section class="tests" data-section="tests">${sectionHead(section, L.tests)}` +
    (tests.length === 0 ? `<p class="none">${escapeHtml(L.noTests)}</p>` : `<table class="grid">${head}${bodies.join("")}</table>`) +
    `</section>`
  );
}

/** One deviation: a step that failed or was refused, with what was expected and what happened. */
export interface Deviation {
  test: string;
  testId?: string;
  step: number;
  caption: string;
  expected?: string;
  actual?: string;
  result: "failed" | "refused";
}

/** Every step that failed or was refused, in the order of the tests. */
export function deviationsOf(result: CheckResult, labels: Partial<Labels> = {}): Deviation[] {
  const L = { ...DEFAULT_LABELS, ...labels };
  return testsOf(result).flatMap(({ journey: j }) =>
    j.steps.flatMap((s): Deviation[] =>
      s.result === "failed" || s.result === "refused"
        ? [
            {
              test: j.name,
              ...(j.id !== undefined ? { testId: j.id } : {}),
              step: s.n,
              caption: s.caption,
              ...(s.expected !== undefined ? { expected: s.expected } : {}),
              ...(actualOf(s, L) !== undefined ? { actual: actualOf(s, L) } : {}),
              result: s.result,
            },
          ]
        : [],
    ),
  );
}

function deviationsHtml(section: ReportSection, result: CheckResult, L: Labels): string {
  const list = deviationsOf(result, L);
  const body =
    list.length === 0
      ? `<p class="none" data-testid="report-no-deviations">${escapeHtml(L.noDeviations)}</p>`
      : `<table class="grid"><thead><tr><th scope="col">${escapeHtml(L.number)}</th><th scope="col">${escapeHtml(L.testId)}</th><th scope="col">${escapeHtml(L.test)}</th><th scope="col">${escapeHtml(L.step)}</th><th scope="col">${escapeHtml(L.expected)}</th><th scope="col">${escapeHtml(L.actual)}</th><th scope="col">${escapeHtml(L.result)}</th></tr></thead><tbody>` +
        list
          .map(
            (d, i) =>
              `<tr class="deviation" data-testid="report-deviation"><td>${i + 1}</td><td>${cell(d.testId)}</td><td>${escapeHtml(d.test)}</td><td><span class="n">${d.step}.</span> ${escapeHtml(d.caption)}</td><td>${cell(d.expected)}</td><td>${cell(d.actual)}</td><td>${escapeHtml(resultWord(d.result, L))}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`;
  return `<section class="deviations" data-section="deviations">${sectionHead(section, L.deviations)}${body}</section>`;
}

function manifestHtml(section: ReportSection, result: CheckResult, meta: ReportMeta, evidence: readonly EvidenceEntry[], L: Labels): string {
  const facts =
    `<table class="facts">` +
    `<tr><th scope="row">${escapeHtml(L.tool)}</th><td>${cell(meta.version)}</td></tr>` +
    `<tr><th scope="row">${escapeHtml(L.target)}</th><td>${cell(result.url)}</td></tr>` +
    `<tr><th scope="row">${escapeHtml(L.started)}</th><td>${cell(stamp(result.replay?.startedAt ?? result.generatedAt))}</td></tr>` +
    `<tr><th scope="row">${escapeHtml(L.ended)}</th><td>${cell(stamp(result.generatedAt))}</td></tr>` +
    `</table>`;
  const rows = evidence
    .map(
      (e) =>
        `<tr data-testid="report-manifest-entry"><td class="path">${escapeHtml(e.path)}</td><td>${e.bytes === null ? escapeHtml(L.notFound) : e.bytes}</td><td class="hash">${e.sha256 === null ? escapeHtml(L.notFound) : escapeHtml(e.sha256)}</td></tr>`,
    )
    .join("");
  return (
    `<section class="manifest" data-section="manifest">${sectionHead(section, L.manifest)}${facts}` +
    `<table class="grid"><thead><tr><th scope="col">${escapeHtml(L.file)}</th><th scope="col">${escapeHtml(L.bytes)}</th><th scope="col">${escapeHtml(L.sha256)}</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

function signoffHtml(section: Extract<ReportSection, { type: "signoff" }>, L: Labels): string {
  const rows = section.roles
    .map((r) => {
      const role = typeof r === "string" ? r : r.role;
      const meaning = typeof r === "string" ? undefined : r.meaning;
      return `<tr class="signature"><td>${escapeHtml(role)}</td><td class="blank"></td><td class="blank"></td><td class="blank"></td><td>${meaning === undefined ? "" : escapeHtml(meaning)}</td></tr>`;
    })
    .join("");
  return (
    `<section class="signoff" data-section="signoff">${sectionHead(section, L.signoff)}` +
    `<table class="grid sign"><thead><tr><th scope="col">${escapeHtml(L.role)}</th><th scope="col">${escapeHtml(L.name)}</th><th scope="col">${escapeHtml(L.signature)}</th><th scope="col">${escapeHtml(L.signedDate)}</th><th scope="col">${escapeHtml(L.meaning)}</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

const STYLE = `
:root { color-scheme: light; --line:#c9ced6; --text:#15181d; --muted:#5d6673; --pass:#047857; --pass-bg:#d1fae5; --fail:#b91c1c; --fail-bg:#fee2e2; --head:#eef0f3; }
* { box-sizing:border-box; }
body { margin:0; background:#fff; color:var(--text); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
header.title { border-bottom:2px solid var(--text); padding-bottom:12px; margin-bottom:8px; }
header.title h1 { font-size:22px; margin:0 0 4px; }
header.title .subtitle { margin:0 0 8px; color:var(--muted); }
h2 { font-size:17px; margin:28px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
table { border-collapse:collapse; width:100%; margin:8px 0; }
th, td { border:1px solid var(--line); padding:5px 8px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
thead th, table.facts th { background:var(--head); }
table.facts { width:auto; min-width:50%; }
tr.test-head th { background:var(--head); font-weight:400; }
.verdict { display:inline-block; padding:0 8px; border-radius:4px; font-weight:700; }
.verdict.pass { color:var(--pass); background:var(--pass-bg); } .verdict.fail { color:var(--fail); background:var(--fail-bg); }
.file { color:var(--muted); font-size:12px; }
.n { color:var(--muted); font-weight:700; }
td.step { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
td.r-passed { color:var(--pass); font-weight:700; } td.r-failed, td.r-refused { color:var(--fail); font-weight:700; } td.r-not-run { color:var(--muted); }
tr.failed td, tr.refused td { background:var(--fail-bg); }
a.frame { display:block; color:var(--muted); font-size:11px; }
a.frame img { display:block; max-width:220px; max-height:150px; object-fit:cover; object-position:top; border:1px solid var(--line); }
td.hash, td.path { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
table.sign td.blank { height:2.6em; min-width:8em; }
.none { color:var(--muted); font-style:italic; }
@media print { main { max-width:none; padding:0; } a { color:inherit; text-decoration:none; } tbody, tr { break-inside:avoid; } }
`;

/**
 * The whole report: one HTML file with no scripts, no event handlers and no
 * external assets. The frames and videos it links sit beside it, as they do
 * for the replay page. Every word from the template and every value from the
 * app is escaped.
 */
export function buildTemplateReport(result: CheckResult, template: ReportTemplate, evidence: readonly EvidenceEntry[], meta: ReportMeta): string {
  const L: Labels = { ...DEFAULT_LABELS, ...(template.labels ?? {}) } as Labels;
  const tokens = tokensOf(result, meta);
  const title = fill(template.title, tokens);
  const fields = [
    ...(template.documentId !== undefined ? [{ label: L.documentId, value: fill(template.documentId, tokens) }] : []),
    ...(template.fields ?? []).map((f) => ({ label: f.label, value: fill(f.value, tokens) })),
  ];
  const sections = template.sections.map((s) => {
    switch (s.type) {
      case "summary":
        return summaryHtml(s, result, meta, L);
      case "tests":
        return testsHtml(s, result, L);
      case "deviations":
        return deviationsHtml(s, result, L);
      case "manifest":
        return manifestHtml(s, result, meta, evidence, L);
      case "signoff":
        return signoffHtml(s, L);
      case "text":
        return `<section class="text" data-section="text">${s.heading !== undefined ? `<h2>${escapeHtml(s.heading)}</h2>` : ""}${paragraphsHtml(s.paragraphs)}</section>`;
    }
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${REPORT_GENERATOR}">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="title">
<h1 data-testid="report-title">${escapeHtml(title)}</h1>
${template.subtitle !== undefined ? `<p class="subtitle">${escapeHtml(fill(template.subtitle, tokens))}</p>\n` : ""}${
    fields.length > 0
      ? `<table class="facts">${fields.map((f) => `<tr><th scope="row">${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}</td></tr>`).join("")}</table>\n`
      : ""
  }</header>
${sections.join("\n")}
</main>
</body>
</html>
`;
}
