/**
 * The team report (design: docs/design/non-technical-assistant.md, 2.5): the
 * plain report made for handing round, as one HTML page with a cover, a short
 * summary, each problem as a card with its picture, what the check did not
 * test (the gap ledger), blank sign-off lines, and an evidence folder beside
 * it with the pictures, the report as Markdown and a manifest of every file's
 * SHA-256, the SceneScout version and the check's times.
 *
 * It writes only inside the project's `.scenescout/` folder:
 *
 *   .scenescout/team-report.html
 *   .scenescout/team-report/report.md
 *   .scenescout/team-report/manifest.json
 *   .scenescout/team-report/<each picture, at its path under .scenescout/>
 *
 * The layout is built in. ADR 22's template schema lays out a recorded
 * check's flows and steps; an exploratory check has neither, and its cards
 * and its not-checked list have no section there, so a template for this
 * report would need new fields and is left for a later change.
 *
 * Everything but writeTeamReport is pure: the same data and evidence render
 * the same bytes (a golden file in scripts/report-test.ts holds that). Every
 * word the app supplied (titles, details, addresses, steps) is escaped, and
 * the page carries a Content-Security-Policy that runs no script (csp.ts).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cspMeta, savedPageCsp } from "./csp.js";
import { AREA_LABEL, MODE_CARE_LABEL, notCheckedCount, pagesChecked, TEAM_REPORT_WORDS as W, teamReportFooter, THOROUGHNESS_LABEL } from "./guided-words.js";
import type { CheckArea, Thoroughness } from "./guided.js";
import { MEMORY_DIRNAME } from "./memory-dir.js";
import { isNotABug, isWorthALook, type Finding } from "./memory.js";
import type { OracleViolation } from "./oracles.js";
import { writeDocumentSync } from "./owner-file.js";
import { IMPACT, isSafeRelativePath, plainCard, plainSummary, type CardImpact, type PlainCard } from "./plain.js";
import type { WriteMode } from "./policy.js";
import { redactRoute } from "./redact.js";
import { escapeHtml } from "./replay.js";

/** The page, in the project's .scenescout/ folder. */
export const TEAM_REPORT_FILE = "team-report.html";
/** The evidence folder beside it, in .scenescout/. */
export const TEAM_EVIDENCE_DIR = "team-report";
/** The report as Markdown, in the evidence folder. */
export const TEAM_MARKDOWN_FILE = "report.md";
/** The manifest, in the evidence folder. */
export const TEAM_MANIFEST_FILE = "manifest.json";
/** The page's and the manifest's generator mark: an earlier report's evidence is cleared only when its manifest carries it. */
export const TEAM_REPORT_GENERATOR = "scenescout-team-report";
/** The largest picture copied into the evidence folder; a larger one is listed as not found. */
export const MAX_EVIDENCE_PICTURE_BYTES = 8 * 1024 * 1024;

/** Everything the report says, decided before any of it is laid out. */
export interface TeamReportData {
  /** The site's address, or "" when the check did not keep one. */
  address: string;
  /** When the check started, ISO. */
  startedAt: string;
  /** When the report was made, ISO. */
  generatedAt: string;
  /** The SceneScout version. */
  version: string;
  /** The care level, in the words the person chose it by. */
  care: string;
  /** How thorough, in the person's words, or TEAM_REPORT_WORDS.notGiven. */
  thoroughness: string;
  /** What was checked: the areas a guided check chose, or the pages it reached. */
  checked: string;
  /** The opening summary, as the plain report words it: paragraphs, and "- " items. */
  summary: string[];
  /** This check's problems, worst first. */
  cards: PlainCard[];
  /** This check's problems the person marked not a bug, listed apart. */
  notABug: PlainCard[];
  /** The gap ledger: what the check knew about and did not test. */
  notChecked: string[];
}

/** What the check knew, as the report is built from it. */
export interface TeamReportSource {
  findings: readonly Finding[];
  /** When this check started (MemoryStore.sessionStart). Problems filed or re-found since are this check's. */
  sessionStart: string;
  /** The last recorded frame before each finding, by id, on a recorded check. */
  lastFrames?: ReadonlyMap<string, string>;
  /** The app's own oracle violations this check (not other sites' frames). */
  violations: readonly Pick<OracleViolation, "kind">[];
  routes?: { visited: number; total: number };
  gaps: readonly string[];
  mode: WriteMode;
  address: string;
  /** A guided check's choices, when the report is of one. */
  guided?: { areas: readonly CheckArea[]; thoroughness: Thoroughness };
  version: string;
  generatedAt: string;
}

/**
 * The site's address as the report shows it: no user name or password, and
 * what redaction masks in a route (a token or code in the query) masked. The
 * plain report never prints the address; this one puts it on the cover, in
 * the page's title and in the manifest, all of which are handed round.
 */
export function shownAddress(address: string): string {
  if (!address) return "";
  let out = address;
  try {
    const u = new URL(address);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      out = u.toString();
      // URL adds a "/" to a bare origin; keep the address as it was given.
      if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i.test(address) && out.endsWith("/")) out = out.slice(0, -1);
    }
  } catch {
    // Not an address URL can read: only the redaction below applies.
  }
  return redactRoute(out);
}

const IMPACT_RANK: Record<CardImpact, number> = { [IMPACT.high]: 0, [IMPACT.medium]: 1, [IMPACT.low]: 2, "Worth a look": 3 };

/** Worst first, then newest first: the order the cards are listed in everywhere. */
function byImpact(a: PlainCard, b: PlainCard): number {
  return IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0);
}

/**
 * The report's content. Its problems are the plain report's: the defects this
 * check found or re-found and left open, worst first. Those the person marked
 * not a bug are listed apart, never dropped (ADR 4); earlier checks' problems
 * and observations that are defects only under a convention are counted in the
 * summary, as the plain report counts them.
 */
export function teamReportData(src: TeamReportSource): TeamReportData {
  const open = src.findings.filter((f) => f.status !== "resolved" && !isWorthALook(f));
  const current = open.filter((f) => f.foundAt >= src.sessionStart);
  const historical = open.filter((f) => f.foundAt < src.sessionStart && !isNotABug(f));
  const worthALook = src.findings.filter((f) => f.status !== "resolved" && isWorthALook(f)).length;
  const card = (f: Finding): PlainCard => plainCard(f, { lastFrame: src.lastFrames?.get(f.id) });
  const problems = current.filter((f) => !isNotABug(f));
  const summary = plainSummary({
    current: problems,
    historical: historical.length,
    worthALook,
    violations: src.violations,
    routes: src.routes,
    // The not-checked list has a section of its own: the summary only counts it.
    gaps: [],
    audience: "qa",
  });
  if (src.gaps.length > 0) summary.push("", notCheckedCount(src.gaps.length));
  const checked = src.guided
    ? src.guided.areas.map((a) => AREA_LABEL[a]).join(", ")
    : src.routes && src.routes.total > 0
      ? pagesChecked(src.routes.visited, src.routes.total)
      : W.everything;
  return {
    address: shownAddress(src.address),
    startedAt: src.sessionStart,
    generatedAt: src.generatedAt,
    version: src.version,
    care: MODE_CARE_LABEL[src.mode],
    thoroughness: src.guided ? THOROUGHNESS_LABEL[src.guided.thoroughness] : W.notGiven,
    checked,
    summary,
    cards: problems.map(card).sort(byImpact),
    notABug: current.filter(isNotABug).map(card).sort(byImpact),
    notChecked: [...src.gaps],
  };
}

// ── the evidence ────────────────────────────────────────────────────────────

/** One file the report vouches for: its path relative to .scenescout/, its size and SHA-256, or null for both when it was not there. */
export interface TeamEvidenceEntry {
  file: string;
  bytes: number | null;
  sha256: string | null;
}

/** Where a picture (relative to .scenescout/) is kept in the evidence folder, relative to .scenescout/. */
export function evidencePathOf(picture: string): string {
  return `${TEAM_EVIDENCE_DIR}/${picture}`;
}

/** The kinds of file a picture is kept as. Memory is read back without a schema, so a picture path naming anything else (a saved sign-in, the report's own Markdown) is never copied into the folder made for sharing. */
const PICTURE_FILE = /\.(png|jpe?g|webp)$/i;

/** The pictures the report shows, each once, in the order the cards show them. Only safe relative paths to picture files are taken. */
export function reportPictures(data: Pick<TeamReportData, "cards">): string[] {
  const out: string[] = [];
  for (const c of data.cards) {
    const file = c.picture?.file;
    if (file && isSafeRelativePath(file) && PICTURE_FILE.test(file) && !out.includes(file)) out.push(file);
  }
  return out;
}

/** A SHA-256 as hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** A table cell's text: one line, and no pipe to end the cell early. */
function mdCell(text: string): string {
  return text.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|");
}

/** A UTC time as the report shows it. */
export function stamp(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

/** The cover's rows, in order. */
function coverRows(data: TeamReportData): Array<[string, string]> {
  return [
    [W.site, data.address || W.notGiven],
    [W.date, stamp(data.generatedAt)],
    [W.checked, data.checked],
    [W.care, data.care],
    [W.thoroughness, data.thoroughness],
  ];
}

/** Where a card was seen, in one line. */
function whereOf(card: PlainCard): string {
  return `${W.on} ${card.page}${card.alsoOn.length > 0 ? `, ${W.alsoOn} ${card.alsoOn.join(", ")}` : ""}`;
}

/**
 * The report as Markdown, kept in the evidence folder: the same content as the
 * page, so it reads in a ticket or a chat. Its pictures are linked relative to
 * the evidence folder, where it sits.
 */
export function teamReportMarkdown(data: TeamReportData, present: ReadonlySet<string>): string {
  const lines: string[] = [`# ${W.title}`, ``, `| | |`, `|---|---|`];
  for (const [k, v] of coverRows(data)) lines.push(`| ${k} | ${mdCell(v)} |`);
  lines.push(``, `## ${W.summary}`, ``, ...data.summary, ``, `## ${W.problems}`, ``);
  if (data.cards.length === 0) lines.push(W.noProblems, ``);
  data.cards.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.title}`, ``, `**${c.impact}** · ${c.problem} · ${whereOf(c)}`, ``);
    if (c.picture && present.has(c.picture.file)) lines.push(`![${c.picture.what}](${c.picture.file})`, ``);
    else if (c.picture) lines.push(`_${W.pictureMissing}_`, ``);
    if (c.steps.length > 0) {
      lines.push(`**${W.whatWasDone}:**`, ``);
      c.steps.forEach((s, n) => lines.push(`${n + 1}. ${s}`));
      lines.push(``);
    }
    lines.push(`**${W.expected}:** ${c.expected}`, ``, `**${W.happened}:** ${c.happened}`, ``);
    lines.push(`${W.technical}: id \`${c.id}\` · ${c.technical.category} · ${c.severity} · \`${c.technical.route}\``, ``);
  });
  if (data.notABug.length > 0) {
    lines.push(`## ${W.notABug}`, ``, W.notABugNote, ``);
    for (const c of data.notABug) lines.push(`- ${c.title} (${c.page})${c.feedback?.reason ? `: "${c.feedback.reason}"` : ""}`);
    lines.push(``);
  }
  lines.push(`## ${W.notChecked}`, ``);
  if (data.notChecked.length === 0) lines.push(W.nothingLeft, ``);
  else lines.push(W.notCheckedNote, ``, ...data.notChecked.map((g) => `- ${g}`), ``);
  lines.push(`## ${W.signoff}`, ``, W.signoffNote, ``, `| ${W.role} | ${W.name} | ${W.signature} | ${W.signedDate} |`, `|---|---|---|---|`);
  for (const r of W.signRoles) lines.push(`| ${r} | | | |`);
  lines.push(``, teamReportFooter(data.version), ``);
  return lines.join("\n");
}

// ── the page ────────────────────────────────────────────────────────────────

const IMPACT_CLASS: Record<CardImpact, string> = { [IMPACT.high]: "high", [IMPACT.medium]: "medium", [IMPACT.low]: "low", "Worth a look": "look" };

/** The summary's lines as HTML: runs of "- " items become a list, other lines paragraphs. */
function summaryHtml(lines: readonly string[]): string {
  const out: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length > 0) out.push(`<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`);
    items = [];
  };
  for (const line of lines) {
    if (line.startsWith("- ")) items.push(line.slice(2));
    else {
      flush();
      if (line.trim()) out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  flush();
  return out.join("");
}

function cardHtml(c: PlainCard, n: number, present: ReadonlySet<string>): string {
  const pictureHtml = !c.picture
    ? ""
    : present.has(c.picture.file)
      ? `<a class="picture" href="${escapeHtml(evidencePathOf(c.picture.file))}" target="_blank" rel="noreferrer" data-testid="team-report-picture-open"><img loading="lazy" src="${escapeHtml(evidencePathOf(c.picture.file))}" alt="${escapeHtml(c.picture.what)}"${c.picture.width && c.picture.height ? ` width="${c.picture.width}" height="${c.picture.height}"` : ""}></a>`
      : `<p class="none">${escapeHtml(W.pictureMissing)}</p>`;
  const steps = c.steps.length > 0 ? `<h4>${escapeHtml(W.whatWasDone)}</h4><ol>${c.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>` : "";
  return (
    `<article class="card ${IMPACT_CLASS[c.impact]}" id="problem-${n}" data-finding="${escapeHtml(c.id)}">` +
    `<h3><span class="n">${n}.</span> ${escapeHtml(c.title)}</h3>` +
    `<p class="where"><span class="impact">${escapeHtml(c.impact)}</span> ${escapeHtml(c.problem)} · ${escapeHtml(whereOf(c))}</p>` +
    pictureHtml +
    steps +
    `<h4>${escapeHtml(W.expected)}</h4><p>${escapeHtml(c.expected)}</p>` +
    `<h4>${escapeHtml(W.happened)}</h4><p>${escapeHtml(c.happened)}</p>` +
    `<details data-testid="team-report-technical-toggle"><summary>${escapeHtml(W.technical)}</summary><p class="tech">id ${escapeHtml(c.id)} · ${escapeHtml(c.technical.category)} · ${escapeHtml(c.severity)} · ${escapeHtml(c.technical.route)}${c.technical.evidence ? ` · ${escapeHtml(c.technical.evidence)}` : ""}</p></details>` +
    `</article>`
  );
}

const STYLE = `
:root { color-scheme: light; --line:#c9ced6; --text:#15181d; --muted:#5d6673; --head:#eef0f3; --high:#b91c1c; --high-bg:#fee2e2; --medium:#b45309; --medium-bg:#fef3c7; --low:#1d4ed8; --low-bg:#dbeafe; --look:#5d6673; --look-bg:#eef0f3; }
* { box-sizing:border-box; }
body { margin:0; background:#fff; color:var(--text); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:900px; margin:0 auto; padding:32px 16px 64px; }
header.cover { border-bottom:3px solid var(--text); padding-bottom:16px; margin-bottom:8px; }
header.cover h1 { font-size:28px; margin:0 0 12px; }
h2 { font-size:19px; margin:32px 0 10px; border-bottom:1px solid var(--line); padding-bottom:4px; }
h3 { font-size:16px; margin:0 0 6px; }
h4 { font-size:13px; margin:12px 0 2px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
p { margin:4px 0; }
table { border-collapse:collapse; width:100%; margin:8px 0; }
th, td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
thead th, table.facts th { background:var(--head); }
table.facts { width:auto; min-width:60%; }
article.card { border:1px solid var(--line); border-left:6px solid var(--look); border-radius:6px; padding:12px 16px; margin:14px 0; break-inside:avoid; }
article.card.high { border-left-color:var(--high); } article.card.medium { border-left-color:var(--medium); } article.card.low { border-left-color:var(--low); }
.impact { display:inline-block; padding:0 8px; border-radius:4px; font-weight:700; font-size:13px; margin-right:4px; color:var(--look); background:var(--look-bg); }
.high .impact { color:var(--high); background:var(--high-bg); } .medium .impact { color:var(--medium); background:var(--medium-bg); } .low .impact { color:var(--low); background:var(--low-bg); }
.where { color:var(--muted); }
.n { color:var(--muted); }
a.picture { display:block; margin:10px 0; }
a.picture img { display:block; max-width:100%; height:auto; max-height:420px; object-fit:contain; object-position:left top; border:1px solid var(--line); }
details summary { cursor:pointer; color:var(--muted); font-size:13px; margin-top:10px; }
.tech, td.hash, td.path { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
.bytes { white-space:nowrap; }
table.sign td.blank { height:2.8em; min-width:9em; }
table.sign td:first-child { white-space:nowrap; }
.none { color:var(--muted); font-style:italic; }
footer { margin-top:40px; color:var(--muted); font-size:13px; }
@media (max-width:600px) { table.sign td.blank { min-width:0; } th, td { padding:6px 5px; } }
@media print { main { max-width:none; padding:0; } a { color:inherit; text-decoration:none; } details { display:none; } article.card, tr { break-inside:avoid; } }
`;

/**
 * The page: one HTML file with no scripts and nothing loaded from elsewhere.
 * Its pictures are in the evidence folder beside it, linked by relative path.
 * `evidence` is the manifest of that folder's pictures and Markdown, which the
 * page lists; a picture whose entry has no hash was not found and is not shown.
 */
export function teamReportHtml(data: TeamReportData, evidence: readonly TeamEvidenceEntry[]): string {
  const present = new Set(evidence.filter((e) => e.sha256 !== null).map((e) => e.file.slice(TEAM_EVIDENCE_DIR.length + 1)));
  const cover = coverRows(data)
    .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  const cards = data.cards.length === 0 ? `<p class="none">${escapeHtml(W.noProblems)}</p>` : data.cards.map((c, i) => cardHtml(c, i + 1, present)).join("\n");
  const notABug =
    data.notABug.length === 0
      ? ""
      : `<section class="not-a-bug" data-section="not-a-bug"><h2>${escapeHtml(W.notABug)}</h2><p>${escapeHtml(W.notABugNote)}</p><ul>${data.notABug
          .map(
            (c) =>
              `<li data-finding="${escapeHtml(c.id)}">${escapeHtml(c.title)} (${escapeHtml(c.page)})${c.feedback?.reason ? `: &quot;${escapeHtml(c.feedback.reason)}&quot;` : ""}</li>`,
          )
          .join("")}</ul></section>\n`;
  const notChecked =
    data.notChecked.length === 0
      ? `<p class="none">${escapeHtml(W.nothingLeft)}</p>`
      : `<p>${escapeHtml(W.notCheckedNote)}</p><ul>${data.notChecked.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>`;
  const signRows = W.signRoles
    .map((r) => `<tr class="signature"><td>${escapeHtml(r)}</td><td class="blank"></td><td class="blank"></td><td class="blank"></td></tr>`)
    .join("");
  const evidenceRows = evidence
    .map(
      (e) =>
        `<tr data-testid="team-report-manifest-entry"><td class="path">${escapeHtml(e.file)}</td><td class="bytes">${e.bytes === null ? escapeHtml(W.notFound) : e.bytes}</td><td class="hash">${e.sha256 === null ? escapeHtml(W.notFound) : escapeHtml(e.sha256)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta(savedPageCsp())}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${TEAM_REPORT_GENERATOR}">
<title>${escapeHtml(`${W.title}${data.address ? `: ${data.address}` : ""}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="cover" data-section="cover">
<h1 data-testid="team-report-title">${escapeHtml(W.title)}</h1>
<table class="facts">${cover}</table>
</header>
<section class="summary" data-section="summary"><h2>${escapeHtml(W.summary)}</h2>${summaryHtml(data.summary)}</section>
<section class="problems" data-section="problems"><h2>${escapeHtml(W.problems)}</h2>
${cards}
</section>
${notABug}<section class="not-checked" data-section="not-checked"><h2>${escapeHtml(W.notChecked)}</h2>${notChecked}</section>
<section class="signoff" data-section="signoff"><h2>${escapeHtml(W.signoff)}</h2><p>${escapeHtml(W.signoffNote)}</p><table class="sign"><thead><tr><th scope="col">${escapeHtml(W.role)}</th><th scope="col">${escapeHtml(W.name)}</th><th scope="col">${escapeHtml(W.signature)}</th><th scope="col">${escapeHtml(W.signedDate)}</th></tr></thead><tbody>${signRows}</tbody></table></section>
<section class="evidence" data-section="evidence"><h2>${escapeHtml(W.evidence)}</h2><p>${escapeHtml(W.evidenceNote)}</p>${
    evidence.length === 0
      ? `<p class="none">${escapeHtml(W.noEvidence)}</p>`
      : `<table class="grid"><thead><tr><th scope="col">${escapeHtml(W.file)}</th><th scope="col" class="bytes">${escapeHtml(W.bytes)}</th><th scope="col">${escapeHtml(W.sha256)}</th></tr></thead><tbody>${evidenceRows}</tbody></table>`
  }</section>
<footer>${escapeHtml(teamReportFooter(data.version))}</footer>
</main>
</body>
</html>
`;
}

/** The manifest written beside the evidence: every file the report made, with the version and the check's times. */
export interface TeamManifest {
  generator: typeof TEAM_REPORT_GENERATOR;
  version: string;
  site: string;
  startedAt: string;
  generatedAt: string;
  /** Paths relative to .scenescout/. */
  files: TeamEvidenceEntry[];
}

// ── writing it ──────────────────────────────────────────────────────────────

/** What scout_team_report returns (design 3.2), with the page's and the folder's absolute paths for a surface to open. */
export interface TeamReport {
  /** Relative to the project: ".scenescout/team-report.html". */
  file: string;
  /** Relative to the project: ".scenescout/team-report". */
  evidenceDir: string;
  /** Every file the report wrote and vouches for, relative to the project, with its SHA-256. */
  manifest: Array<{ file: string; sha256: string }>;
  problems: number;
  pictures: number;
  /** Pictures the cards name that were not found, and so are listed as not found. */
  missingPictures: number;
  /** The page, absolute. */
  path: string;
  /** The evidence folder, absolute. */
  folder: string;
}

/** Whether `target` is inside `root` once every link along it is resolved. Both must exist. */
function insideReal(root: string, target: string): boolean {
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(target);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/** The bytes of a picture under .scenescout/, or null when it is not there, not a plain file, too large, or reached through a link out of the folder. */
function readPicture(dir: string, rel: string): Buffer | null {
  if (!isSafeRelativePath(rel)) return null;
  const full = path.join(dir, ...rel.split("/"));
  try {
    const st = fs.lstatSync(full);
    if (!st.isFile() || st.size > MAX_EVIDENCE_PICTURE_BYTES) return null;
    if (!insideReal(dir, full)) return null;
    return fs.readFileSync(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Whether every folder from `dir` down to the one holding `rel` exists and is a folder, not a link. */
function plainFoldersTo(dir: string, rel: string): boolean {
  let at = dir;
  for (const part of rel.split("/").slice(0, -1)) {
    at = path.join(at, part);
    try {
      if (!fs.lstatSync(at).isDirectory()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
  return true;
}

/** The files an earlier team report listed in its manifest, when it was this generator's: the only ones a new report removes. */
function earlierEvidence(evidenceDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(evidenceDir, TEAM_MANIFEST_FILE), "utf8")) as Partial<TeamManifest>;
    if (raw.generator !== TEAM_REPORT_GENERATOR || !Array.isArray(raw.files)) return [];
    return raw.files.map((f) => (f && typeof f.file === "string" ? f.file : "")).filter((f) => f.startsWith(`${TEAM_EVIDENCE_DIR}/`) && isSafeRelativePath(f));
  } catch {
    // No manifest, or one that does not parse: nothing is known to be ours, so nothing is removed.
    return [];
  }
}

/**
 * Write the page, the evidence folder and its manifest into `dir`, which must
 * be a project's `.scenescout/` folder. Nothing is written anywhere else: the
 * evidence folder is refused when it is a link, and every file is checked to
 * land inside `dir` once links are resolved. An earlier team report's evidence
 * is removed first, file by file from its own manifest, so a picture no longer
 * shown does not linger beside the new report.
 */
export function writeTeamReport(dir: string, data: TeamReportData): TeamReport {
  if (path.basename(dir) !== MEMORY_DIRNAME) throw new Error(`a team report is written only inside a project's ${MEMORY_DIRNAME} folder, not ${dir}`);
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  const evidenceDir = path.join(dir, TEAM_EVIDENCE_DIR);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(evidenceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (st && !st.isDirectory()) throw new Error(`${evidenceDir} is not a folder SceneScout made (it is a link or a file), so the team report was not written`);

  if (st) {
    for (const rel of earlierEvidence(evidenceDir)) {
      const full = path.join(dir, ...rel.split("/"));
      // Only a file whose every folder is a real folder: a linked folder on the way would lead the removal outside.
      if (!plainFoldersTo(dir, rel)) continue;
      try {
        const old = fs.lstatSync(full);
        if (old.isFile() || old.isSymbolicLink()) fs.rmSync(full, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (!insideReal(dir, evidenceDir)) throw new Error(`${evidenceDir} leads outside ${dir}, so the team report was not written`);

  /** Write one file under the evidence folder, making its folders one at a time and refusing any that is a link or a file. */
  const put = (rel: string, data: string | Uint8Array): TeamEvidenceEntry => {
    const parts = rel.split("/");
    let at = dir;
    for (const part of parts.slice(0, -1)) {
      at = path.join(at, part);
      let here: fs.Stats | null = null;
      try {
        here = fs.lstatSync(at);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (here === null) fs.mkdirSync(at);
      else if (!here.isDirectory()) throw new Error(`${at} is a link or a file, not a folder SceneScout made, so the team report was not written`);
    }
    const full = path.join(dir, ...parts);
    writeDocumentSync(full, data);
    return { file: rel, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.length, sha256: sha256Hex(data) };
  };

  const pictures: TeamEvidenceEntry[] = [];
  const present = new Set<string>();
  for (const pic of reportPictures(data)) {
    const bytes = readPicture(dir, pic);
    if (bytes === null) {
      pictures.push({ file: evidencePathOf(pic), bytes: null, sha256: null });
      continue;
    }
    pictures.push(put(evidencePathOf(pic), bytes));
    present.add(pic);
  }
  const markdown = put(`${TEAM_EVIDENCE_DIR}/${TEAM_MARKDOWN_FILE}`, teamReportMarkdown(data, present));
  const evidence = [markdown, ...pictures];
  const html = teamReportHtml(data, evidence);
  const htmlPath = path.join(dir, TEAM_REPORT_FILE);
  writeDocumentSync(htmlPath, html);
  const files: TeamEvidenceEntry[] = [{ file: TEAM_REPORT_FILE, bytes: Buffer.byteLength(html), sha256: sha256Hex(html) }, ...evidence];
  const manifest: TeamManifest = {
    generator: TEAM_REPORT_GENERATOR,
    version: data.version,
    site: data.address,
    startedAt: data.startedAt,
    generatedAt: data.generatedAt,
    files,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestEntry = put(`${TEAM_EVIDENCE_DIR}/${TEAM_MANIFEST_FILE}`, manifestText);
  const listed = [...files, manifestEntry].filter((f): f is TeamEvidenceEntry & { sha256: string } => f.sha256 !== null);
  return {
    file: `${MEMORY_DIRNAME}/${TEAM_REPORT_FILE}`,
    evidenceDir: `${MEMORY_DIRNAME}/${TEAM_EVIDENCE_DIR}`,
    manifest: listed.map((f) => ({ file: `${MEMORY_DIRNAME}/${f.file}`, sha256: f.sha256 })),
    problems: data.cards.length,
    pictures: present.size,
    missingPictures: pictures.length - present.size,
    path: htmlPath,
    folder: evidenceDir,
  };
}

/** The tool's answer in words: where the page is, what it holds, and that it stays on this computer. */
export function teamReportText(r: TeamReport): string {
  const missingPictures = r.missingPictures;
  return [
    `Team report written: ${r.path}`,
    `Evidence folder beside it: ${r.folder} (the pictures, report.md and manifest.json with each file's SHA-256).`,
    `${r.problems} problem${r.problems === 1 ? "" : "s"}, ${r.pictures} picture${r.pictures === 1 ? "" : "s"}.${missingPictures > 0 ? ` ${missingPictures} picture${missingPictures === 1 ? " was" : "s were"} not found and ${missingPictures === 1 ? "is" : "are"} listed as not found.` : ""}`,
    "It opens in any browser and stays on this computer; nothing was sent anywhere.",
  ].join("\n");
}
