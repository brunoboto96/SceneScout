/**
 * The run, as one file that outlives it.
 *
 * The live view dies with the engine: its address is a port in a process, so
 * refreshing after a run is over gets nothing. This builds a self-contained
 * HTML document instead — the report, and every session's steps grouped by
 * the task they served — written next to report.md. It opens from the file
 * system with no server, works offline, and can be handed to somebody who was
 * never watching.
 *
 * Frames appear beside the steps only when the run was recorded
 * (`scout_attach {record:true}`), which is off by default: a recording is
 * pictures of somebody's app sitting in their project folder, and ADR 7's
 * "no frame touches the disk" is the rule it deliberately relaxes. The
 * document is built the same way either way; a step with no frame simply
 * shows none.
 *
 * Everything here is pure string work — no browser, no filesystem — so the
 * escaping and the grouping are table-tested.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ActivityLine } from "./live.js";
import { cspMeta, savedPageCsp } from "./csp.js";
import { EVIDENCE_HEADING, IMPACT, isSafeRelativePath, SUMMARY_HEADING, TECHNICAL_HEADING, type CardImpact } from "./plain.js";
import { scriptLiteral } from "./script-literal.js";

/** One session's trail, as the document shows it. */
export interface ReplaySession {
  session: string;
  role: string;
  /** The session's objective, if it gave one. */
  objective?: string;
  steps: ActivityLine[];
}

/** The frames that were on screen while a finding was being found, for the accordion under it. */
export interface FindingEvidence {
  id: string;
  frames: Array<{ at: string; action: string; detail: string; frame: string }>;
  /** The picture taken when it was filed (capture.ts FindingPicture), shown above the frames. */
  picture?: { file: string; width?: number; height?: number; caption: string };
}

export interface ReplayInput {
  /** The report, as markdown. Rendered to elements here, never as markup. */
  markdown: string;
  sessions: ReplaySession[];
  /** Frames for each finding, keyed by its id. A run that was not recorded has none. */
  evidence?: FindingEvidence[];
  /** For the header: which project, when it was written, which engine. */
  project: string;
  at: string;
  version: string;
  /**
   * What to put before a frame's stored path. Empty for the file written next
   * to the frames; the live view serves the same document over HTTP and
   * reaches them through its own route.
   */
  framePrefix?: string;
  /**
   * Where this run's frames and its own saved copy live on disk. Set only for
   * the document the engine SERVES: that page dies with the process, and a
   * browser cannot be shown a `file://` image from an `http://` page, so the
   * next best thing is to say where each picture actually is. The copy written
   * to disk sits beside its frames already and needs none of this — and must
   * not carry the author's paths, since it is the one handed to other people.
   */
  savedAt?: string;
}

/** Most frames one recorded session keeps. A long run is thousands of actions, and a project folder is not a video store. */
export const RECORD_MAX_FRAMES = 600;

/** A name reduced to one plain path segment: letters, digits, dot, dash and underscore, never leading with a dot or dash. */
export function plainSegment(text: string, fallback: string): string {
  return (
    text
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 60) || fallback
  );
}

/**
 * Where a recorded frame is stored, relative to the memory directory — and
 * the path the live view serves it at, so it is always written with forward
 * slashes. The session name is the agent's and the action the tool's, so both
 * are reduced to a plain file name here: a session called `../../etc` decides
 * nothing about where the engine writes.
 */
export function framePath(session: string, index: number, action: string): string {
  return `recordings/${plainSegment(session, "session")}/${String(index).padStart(4, "0")}-${plainSegment(action, "step")}.jpg`;
}

/**
 * The file a viewer's frame request names, or null when it is not one of this
 * run's frames. The path comes from a browser and may be anything, so it is
 * resolved and then required to still be under the recordings directory —
 * `..`, an absolute path and a sibling directory whose name merely starts the
 * same way are all refused. The one filesystem rule in the frame route, kept
 * here so it can be table-tested rather than reached only through HTTP.
 */
export function resolveFrame(root: string, relPath: string): string | null {
  if (!relPath) return null;
  const inside = relPath.replace(/^recordings[\\/]/, "");
  if (!inside || inside.includes("\0")) return null;
  // Both sides resolved: on Windows `path.resolve` prefixes the drive, so
  // comparing its output against a root that has none rejects every frame.
  const base = path.resolve(root);
  const file = path.resolve(base, inside);
  return file.startsWith(base + path.sep) ? file : null;
}

/**
 * A frame's file as it really is on disk, when it is a file inside the
 * recordings folder: links are followed first, so a link to a file elsewhere,
 * or a file under a linked folder, is not one. The live view serves what this
 * names and `scenescout export` uploads it, so the two refuse the same files.
 * Missing or unreadable is null too: the caller treats it as no such frame.
 */
export function frameOnDisk(root: string, relPath: string): string | null {
  const named = resolveFrame(root, relPath);
  if (!named) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const file = fs.realpathSync(named);
    if (!file.startsWith(realRoot + path.sep)) return null;
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * A short name for a project folder, used in the live view's frame addresses so
 * a page says which project its pictures belong to. One engine can serve runs
 * in several folders in turn, and a page already open in a browser loads its
 * images later, after another folder may have attached. The name is derived
 * from the folder's resolved path and reveals nothing of it.
 */
export function projectKey(dir: string): string {
  return "p-" + crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 12);
}

/** A frame address split into the project it names, when it names one, and the path inside that project's recordings. */
export function splitProjectFrame(relPath: string): { key?: string; rest: string } {
  const m = /^(p-[0-9a-f]{12})\/(.+)$/.exec(relPath);
  return m ? { key: m[1], rest: m[2] } : { rest: relPath };
}

/**
 * The project folders this process has rendered a run page or a board report
 * for, by key. Only a folder one was rendered from can be named, so a viewer
 * cannot reach any other folder by guessing a key.
 */
export class ProjectDirs {
  private readonly byKey = new Map<string, string>();

  /** Remember `dir` and return its key. */
  remember(dir: string): string {
    const key = projectKey(dir);
    this.byKey.set(key, dir);
    return key;
  }

  /** The folder a key names, or undefined when nothing was rendered from one with that key. */
  dir(key: string): string | undefined {
    return this.byKey.get(key);
  }
}

/** Text from the app under test reaches this document, so nothing is interpolated unescaped. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** A step with a frame beside it, and the steps of one task in one block. */
export interface TaskBlock {
  task: string | null;
  steps: ActivityLine[];
}

/**
 * A session's steps in the blocks its tasks made. Consecutive steps that
 * served the same task are one block, so the document reads the way the live
 * feed did: a change of task is a change of block, and of colour.
 */
export function taskBlocks(steps: readonly ActivityLine[]): TaskBlock[] {
  const blocks: TaskBlock[] = [];
  for (const step of steps) {
    const task = step.task ?? null;
    const last = blocks[blocks.length - 1];
    if (!last || last.task !== task) blocks.push({ task, steps: [step] });
    else last.steps.push(step);
  }
  return blocks;
}

/** The viewer's own clock is not this document's to assume; times are shown as they were logged. */
function clock(iso: string): string {
  const at = iso.length >= 19 ? iso.slice(11, 19) : iso;
  return at;
}

/**
 * When the document was written. The log is UTC and this page may be opened
 * anywhere, so it says which clock it is quoting rather than implying the
 * reader's own.
 */
function stamp(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

/**
 * What an image that will not load does. This page is meant to be handed on,
 * and a copy sent without its `recordings/` folder would otherwise show a row
 * of broken icons under a finding that still counts them as evidence. It is
 * the one event handler the page carries, and its policy allows it by hash, so
 * the handler's text and the attribute's are one constant.
 */
const GONE_HANDLER = "this.parentNode.classList.add('gone')";
const GONE = `onerror="${GONE_HANDLER}"`;

/** A result that reads as a failure, so a step that went wrong is visible without reading every line. */
const BAD_RESULT = /error|fail|refus|block|violation|abandoned/i;

function renderStep(step: ActivityLine, framePrefix = "", savedAt = ""): string {
  const detail = [step.target, step.result ? `→ ${step.result}` : ""].filter(Boolean).join(" ") || step.url || "";
  const bad = BAD_RESULT.test(step.result ?? "") ? " bad" : "";
  const frame = step.frame
    ? `<a class="frame" href="${escapeHtml(framePrefix + step.frame)}" target="_blank" rel="noreferrer"><img loading="lazy" ${GONE} src="${escapeHtml(framePrefix + step.frame)}" alt="What the page showed at this step"></a>`
    : "";
  const where = savedAt && step.frame ? `<p class="onDisk">${escapeHtml(savedAt + "/" + step.frame)}</p>` : "";
  return (
    `<li class="step"><div class="row"><span class="t">${escapeHtml(clock(step.at))}</span>` +
    `<span class="a${bad}">${escapeHtml(step.action)}</span>` +
    `<span class="d" title="${escapeHtml([step.target, step.result, step.url].filter(Boolean).join(" · "))}">${escapeHtml(detail)}</span></div>${frame}${where}</li>`
  );
}

function renderSession(s: ReplaySession, index: number, framePrefix = "", savedAt = ""): string {
  const blocks = taskBlocks(s.steps);
  const body = blocks
    .map((b, i) => {
      const head = b.task ? `<p class="task">${escapeHtml(b.task)}</p>` : `<p class="task none">No task stated for these</p>`;
      return `<section class="block g${i % 4}">${head}<ol class="steps">${b.steps.map((step) => renderStep(step, framePrefix, savedAt)).join("")}</ol></section>`;
    })
    .join("");
  const framed = s.steps.filter((x) => x.frame).length;
  return (
    `<details class="session"${index === 0 ? " open" : ""}><summary><b>${escapeHtml(s.session)}</b> <span class="role">${escapeHtml(s.role)}</span>` +
    `<span class="count">${s.steps.length} steps · ${blocks.length} task${blocks.length === 1 ? "" : "s"}${framed ? ` · ${framed} frames` : ""}</span></summary>` +
    (s.objective ? `<p class="objective">${escapeHtml(s.objective)}</p>` : "") +
    body +
    `</details>`
  );
}

/**
 * The steps that were on screen just before a finding was filed. The report's
 * own repro trace says what happened; on a recorded run these show it.
 */
export function evidenceFor(steps: readonly ActivityLine[], foundAt: string, most = 4): FindingEvidence["frames"] {
  const before = steps.filter((x) => x.frame && x.at <= foundAt);
  return before.slice(-most).map((x) => ({
    at: x.at,
    action: x.action,
    detail: [x.target, x.result ? `→ ${x.result}` : ""].filter(Boolean).join(" ") || x.url || "",
    frame: x.frame as string,
  }));
}

/** A finding's own picture, shown open under it: the evidence a reader looks for first. */
function renderPicture(p: NonNullable<FindingEvidence["picture"]>, id: string, framePrefix = "", savedAt = ""): string {
  const src = escapeHtml(framePrefix + p.file);
  return (
    `<figure class="picture"><a class="frame" href="${src}" target="_blank" rel="noreferrer" data-testid="finding-picture-open" data-finding="${escapeHtml(id)}">` +
    `<img loading="lazy" ${GONE} src="${src}"${p.width && p.height ? ` width="${p.width}" height="${p.height}"` : ""} alt="What the finding is about, when it was filed">` +
    `<p class="gone-note">This picture is not beside this file. Pictures live in the run's <code>recordings/</code> folder, which travels with it.</p></a>` +
    `<figcaption>${escapeHtml(p.caption)}${savedAt ? `<span class="onDisk">${escapeHtml(savedAt + "/" + p.file)}</span>` : ""}</figcaption></figure>`
  );
}

/** The recorded frames before a finding was filed, as a strip of small pictures, each opening full size. */
function renderFrames(e: FindingEvidence, framePrefix = "", savedAt = ""): string {
  if (e.frames.length === 0) return "";
  const shots = e.frames
    .map(
      (f) =>
        `<figure><a class="frame" href="${escapeHtml(framePrefix + f.frame)}" target="_blank" rel="noreferrer" data-testid="report-frame-open">` +
        `<img loading="lazy" ${GONE} src="${escapeHtml(framePrefix + f.frame)}" alt="The page when this step ran">` +
        `<p class="gone-note">This frame is not beside this file. Frames live in the run's <code>recordings/</code> folder, which travels with it.</p></a>` +
        `<figcaption>${escapeHtml(clock(f.at))} <b>${escapeHtml(f.action)}</b> ${escapeHtml(f.detail)}` +
        (savedAt ? `<span class="onDisk">${escapeHtml(savedAt + "/" + f.frame)}</span>` : "") +
        `</figcaption></figure>`,
    )
    .join("");
  return (
    `<div class="filmstrip" data-testid="report-evidence-frames"><p class="strip-label">The ${e.frames.length} step${e.frames.length === 1 ? "" : "s"} on screen before this was filed</p>` +
    `<div class="shots">${shots}</div></div>`
  );
}

/** A finding's own picture and its frames, together: where the technical report names its id and no Evidence section showed them. */
function renderEvidence(e: FindingEvidence, framePrefix = "", savedAt = ""): string {
  const picture = e.picture ? renderPicture(e.picture, e.id, framePrefix, savedAt) : "";
  return `${picture}${renderFrames(e, framePrefix, savedAt)}`;
}

/**
 * The report's sections the header links to, by heading. Built on first use:
 * plain.ts reaches this module through its own imports, so its constants are
 * not there yet while this one loads.
 */
function sectionAnchor(heading: string): string | undefined {
  const anchors: Record<string, string> = { [SUMMARY_HEADING]: "summary", [EVIDENCE_HEADING]: "evidence", [TECHNICAL_HEADING]: "technical" };
  return Object.hasOwn(anchors, heading) ? anchors[heading] : undefined;
}

/** A section folded by default: its heading and one line say what is in it. */
const FOLDED_TESTID: Record<string, string> = { technical: "report-technical-toggle" };

/** The impact words, as the chip each is drawn in. Typed by CardImpact, so a new impact word cannot be left without one. */
function impactClasses(): Record<CardImpact, string> {
  return { [IMPACT.high]: "high", [IMPACT.medium]: "medium", [IMPACT.low]: "low", "Worth a look": "look" };
}

function impactClass(word: string): string | undefined {
  const classes = impactClasses();
  return Object.hasOwn(classes, word) ? classes[word as CardImpact] : undefined;
}

function impactChip(word: string): string {
  return `<span class="impact ${impactClass(word)}">${word}</span>`;
}

/**
 * A Markdown table row's cells. `\|` is a pipe in the text and `\\` a
 * backslash (escapeTableCell writes both), so a title holding a pipe stays in
 * its own cell rather than forging another column.
 */
export function tableCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === "\\" && (inner[k + 1] === "|" || inner[k + 1] === "\\")) {
      cell += inner[k + 1];
      k += 1;
    } else if (c === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/** Text that Markdown kept as HTML entities inside a raw element (a `<summary>`), back to the characters, to be escaped once more. */
function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e] as string);
}

/**
 * The report's markdown as elements. A deliberately small subset — headings,
 * tables, lists, code fences, the report's own <details> blocks — built by
 * escaping every piece of text, because finding titles and element names come
 * from the app under test.
 *
 * The technical details' `## ` heading, followed by its `<details>` line, is a
 * part folded by default, with the heading in its summary. Under Evidence, each problem is one item,
 * its title beside its picture, with the frames recorded before it was filed
 * under the picture. Elsewhere a finding's frames go under the list that names
 * its `**Id:**`, once: a finding the Evidence section showed is not repeated.
 */
export function renderMarkdown(md: string, evidence: readonly FindingEvidence[] = [], framePrefix = "", savedAt = ""): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  let para: string[] = [];
  /** What each open <details> is, so its close closes the right thing. */
  const open: Array<"part" | "plain"> = [];
  let section = "";
  /** Inside an Evidence item: "head" (title and words) or "media" (its picture and frames). */
  let item: "" | "head" | "media" = "";
  let itemId = "";
  const shown = new Set<string>();
  const inline = (text: string): string =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/<strong>([^<]+)<\/strong>/g, (whole, w: string) => (impactClass(w) ? impactChip(w) : whole));
  const flush = (): void => {
    if (!para.length) return;
    const text = para.join(" ");
    out.push(`<p>${inline(open.length > 0 ? decodeEntities(text) : text)}</p>`);
    para = [];
  };
  const closeItem = (): void => {
    if (item === "head" || item === "media") out.push(`</div></article>`);
    item = "";
    itemId = "";
  };
  /** Heading levels inside a folded part go one deeper, under the part's own heading. */
  const depth = (): number => (open.includes("part") ? 1 : 0);
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    } else if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      flush();
      const level = m[1].length;
      if (level <= 3) closeItem();
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === "") next += 1;
      const folds = level === 2 && m[2] === TECHNICAL_HEADING && /^<details><summary>.*<\/summary>$/.test(lines[next] ?? "");
      if (level === 2 && !open.includes("part")) section = m[2];
      const anchor = level === 2 ? sectionAnchor(m[2]) : undefined;
      if (folds) {
        const hint = /^<details><summary>(.*)<\/summary>$/.exec(lines[next])![1];
        const id = anchor ?? "";
        out.push(
          `<details class="part"${id ? ` id="${id}"` : ""} data-testid="report-${id || "part"}-section"><summary data-testid="${FOLDED_TESTID[id] ?? "report-part-toggle"}">` +
            `<h2>${inline(m[2])}</h2><span class="hint">${inline(decodeEntities(hint))}</span></summary>`,
        );
        open.push("part");
        i = next + 1;
        continue;
      }
      const h = Math.min(6, level + depth());
      if (section === EVIDENCE_HEADING && level === 3 && !open.includes("part")) {
        out.push(`<article class="ev" data-testid="report-evidence-item"><div class="ev-head">`);
        item = "head";
      }
      out.push(`<h${h}${anchor && !open.includes("part") ? ` id="${anchor}"` : ""}>${inline(open.includes("part") ? decodeEntities(m[2]) : m[2])}</h${h}>`);
      i += 1;
    } else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line))) {
      // A finding's picture. The path is the report's own, relative to the run's
      // folder, and anything else (a scheme, an absolute path, `..`) is dropped.
      flush();
      if (item === "head") {
        out.push(`</div><div class="ev-media">`);
        item = "media";
      }
      if (isSafeRelativePath(m[2])) {
        const src = (m[2].startsWith("recordings/") ? framePrefix : "") + m[2];
        out.push(
          `<figure class="picture"><a href="${escapeHtml(src)}" target="_blank" rel="noreferrer" data-testid="report-picture-open"><img loading="lazy" ${GONE} src="${escapeHtml(src)}" alt="${escapeHtml(m[1])}"></a>` +
            `<p class="gone-note">This picture is not beside this file. It lives in the run's folder, which travels with it.</p>` +
            (savedAt ? `<span class="onDisk">${escapeHtml(savedAt + "/" + m[2])}</span>` : "") +
            `</figure>`,
        );
      }
      if (item === "media" && itemId && !shown.has(itemId)) {
        const found = evidence.find((e) => e.id === itemId);
        if (found) out.push(renderFrames(found, framePrefix, savedAt));
        shown.add(itemId);
      }
      i += 1;
    } else if ((m = /^<details><summary>(.*)<\/summary>$/.exec(line))) {
      flush();
      const text = decodeEntities(m[1]);
      const problem = section === SUMMARY_HEADING && /^\d+\. /.test(text);
      const testid = problem ? "report-problem-toggle" : "report-details-toggle";
      out.push(`<details${problem ? ` class="problem"` : ""}><summary data-testid="${testid}">${inline(text)}</summary><div class="fold">`);
      open.push("plain");
      i += 1;
    } else if (/^<\/details>$/.test(line)) {
      flush();
      // A close with nothing open is dropped rather than written unmatched.
      if (open.length === 0) {
        i += 1;
        continue;
      }
      const was = open.pop();
      if (was === "part") closeItem();
      out.push(was === "part" ? `</details>` : `</div></details>`);
      i += 1;
    } else if (/^\|/.test(line)) {
      flush();
      const rows: string[] = [];
      let head: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const row = lines[i];
        i += 1;
        if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(row)) continue;
        const cells = tableCells(row);
        if (head.length === 0) {
          head = cells;
          rows.push(`<thead><tr>${cells.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>`);
          continue;
        }
        rows.push(
          `<tr>${cells
            .map((c, k) => `<td data-label="${escapeHtml(head[k] ?? "")}">${impactClass(c) && head[k] === "Impact" ? impactChip(c) : inline(c)}</td>`)
            .join("")}</tr>`,
        );
      }
      const problems = head.includes("Impact") && head.includes("What was expected");
      out.push(
        `<div class="table-wrap"><table${problems ? ` class="problems" data-testid="report-problems-table"` : ""}>${rows.join("")}</tbody></table></div>`,
      );
    } else if (/^\s*[-*] /.test(line)) {
      flush();
      const items: string[] = [];
      // A finding's id sits in this list; its evidence goes straight under it,
      // which is where a reader is when they ask "show me" — unless the
      // Evidence section already showed it.
      let found: FindingEvidence | undefined;
      while (i < lines.length && (m = /^\s*[-*] (.*)$/.exec(lines[i]))) {
        const id = /\*\*Id:\*\* `([0-9a-f]+)`/.exec(m[1])?.[1];
        if (id && !shown.has(id)) found = evidence.find((e) => e.id === id);
        items.push(`<li>${inline(open.length > 0 ? decodeEntities(m[1]) : m[1])}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      if (found) {
        out.push(renderEvidence(found, framePrefix, savedAt));
        shown.add(found.id);
      }
    } else if (/^\d+\. /.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && (m = /^\d+\. (.*)$/.exec(lines[i]))) {
        items.push(`<li>${inline(open.length > 0 ? decodeEntities(m[1]) : m[1])}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
    } else if ((m = /^<!-- finding ([0-9a-f]+) -->$/.exec(line))) {
      // The id an Evidence item's frames hang from; it is not text.
      flush();
      if (item === "head") itemId = m[1];
      i += 1;
    } else if (line.trim() === "") {
      flush();
      i += 1;
    } else {
      para.push(line);
      i += 1;
    }
  }
  flush();
  closeItem();
  // A fold the document left open is closed here, so the page after it is not swallowed.
  while (open.length > 0) out.push(open.pop() === "part" ? `</details>` : `</div></details>`);
  return out.join("\n");
}

const STYLE = `
:root { color-scheme: light dark;
  --bg:#f4f5f7; --panel:#fff; --sunk:#eceef1; --line:#dde1e6; --text:#16191d; --muted:#565f6b; --accent:#1f5fd6;
  --bad:#b42318; --warn:#7c4a03; --warn-bg:#fef3c7;
  --high:#b42318; --high-bg:#fde8e6; --medium:#8a5300; --medium-bg:#fdf0d5; --low:#1f5fd6; --low-bg:#e3edfd; --look:#565f6b; --look-bg:#eceef1;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#0f1215; --panel:#171b20; --sunk:#1d2228; --line:#2a3038; --text:#e7eaee; --muted:#9ea8b4; --accent:#8fb0ff;
  --bad:#ff9b8f; --warn:#fbbf24; --warn-bg:#3a2a08;
  --high:#ffa499; --high-bg:#3b1714; --medium:#f5c060; --medium-bg:#352507; --low:#a3bfff; --low-bg:#172540; --look:#b3bcc7; --look-bg:#252a31; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; overflow-wrap:anywhere; }
::selection { background:var(--low-bg); color:var(--text); }
a { color:var(--accent); text-underline-offset:2px; }
[id] { scroll-margin-top:84px; }
a:focus-visible, summary:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:4px; }
header.top { position:sticky; top:0; z-index:2; display:flex; flex-wrap:wrap; gap:6px 24px; align-items:center; padding:12px max(16px, calc((100vw - 968px) / 2)); background:var(--panel); border-bottom:1px solid var(--line); }
header.top h1 { margin:0; font-size:17px; line-height:1.3; }
header.top .meta { margin:0; color:var(--muted); font-size:13px; }
nav { margin-left:auto; display:flex; flex-wrap:wrap; gap:4px 18px; font-size:14px; }
nav a { text-decoration:none; font-weight:500; }
nav a:hover { text-decoration:underline; }
main { max-width:1000px; margin:0 auto; padding:8px 16px 80px; }
main > p, .fold > p, .ev-head > p, details.part > p { max-width:72ch; }
h2 { font-size:26px; line-height:1.25; letter-spacing:-0.01em; margin:48px 0 14px; }
main > h2:first-child { margin-top:28px; }
#summary + p { font-size:18px; line-height:1.55; }
h3 { font-size:18px; line-height:1.35; margin:32px 0 8px; }
h4 { font-size:15px; margin:22px 0 6px; }
p { margin:0 0 12px; }
ul, ol { padding-left:24px; margin:0 0 14px; }
li { margin:2px 0; }
.impact { display:inline-block; padding:1px 8px; border-radius:999px; font-weight:600; font-size:13px; line-height:1.6; white-space:nowrap; color:var(--look); background:var(--look-bg); }
.impact.high { color:var(--high); background:var(--high-bg); } .impact.medium { color:var(--medium); background:var(--medium-bg); } .impact.low { color:var(--low); background:var(--low-bg); }
.table-wrap { overflow-x:auto; margin:12px 0 20px; }
table { border-collapse:collapse; font-size:14px; font-variant-numeric:tabular-nums; background:var(--panel); }
th, td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; overflow-wrap:normal; }
th { background:var(--sunk); font-weight:600; }
table.problems { width:100%; }
table.problems td:first-child { color:var(--muted); text-align:right; width:2.5em; }
table.problems td:nth-child(3) { font-weight:600; }
code { font:13px/1.45 var(--mono); background:var(--sunk); border-radius:4px; padding:1px 5px; overflow-wrap:anywhere; }
pre { padding:12px 14px; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow-x:auto; font-size:13px; }
pre code { background:none; padding:0; overflow-wrap:normal; }
summary { cursor:pointer; }
details.problem { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin:8px 0; }
details.problem > summary { padding:12px 16px; font-weight:600; }
details.problem[open] > summary { border-bottom:1px solid var(--line); }
details.problem .fold { padding:14px 16px 4px; }
details.part { margin:48px 0 0; border-top:1px solid var(--line); }
details.part > summary { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 14px; padding:24px 0 16px; list-style:none; }
details.part > summary::-webkit-details-marker { display:none; }
details.part > summary::before { content:""; align-self:center; width:9px; height:9px; border-right:2px solid var(--muted); border-bottom:2px solid var(--muted); transform:rotate(-45deg); transition:transform .15s ease-out; }
details.part[open] > summary::before { transform:rotate(45deg); }
details.part > summary h2 { margin:0; }
details.part > summary .hint { flex:1 1 320px; color:var(--muted); font-size:14px; }
details.part > summary:hover h2 { text-decoration:underline; text-underline-offset:4px; text-decoration-thickness:1px; }
details.part > h3 { font-size:21px; margin-top:36px; }
details:not(.part):not(.problem):not(.session) { margin:4px 0 18px; padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
details:not(.part):not(.problem):not(.session) > summary { color:var(--muted); font-size:14px; }
article.ev { display:grid; grid-template-columns:minmax(0,1fr); gap:4px 28px; padding:22px 0; border-top:1px solid var(--line); }
article.ev h3 { margin:0 0 8px; }
@media (min-width:760px) { article.ev { grid-template-columns:minmax(0,5fr) minmax(0,7fr); } }
figure { margin:0; }
figure.picture { margin:6px 0 14px; max-width:min(100%,720px); }
figure.picture img { width:auto; max-width:100%; height:auto; max-height:440px; border:1px solid var(--line); border-radius:8px; display:block; background:var(--panel); }
.ev-media figure.picture { margin-top:0; }
figure.picture figcaption { margin-top:6px; color:var(--muted); font-size:13px; }
.filmstrip { margin:4px 0 8px; }
.strip-label { margin:0 0 6px; color:var(--muted); font-size:13px; }
.filmstrip .shots { display:flex; gap:10px; overflow-x:auto; padding-bottom:6px; }
.filmstrip figure { flex:0 0 180px; }
.filmstrip img { width:180px; height:112px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; display:block; background:var(--panel); }
.filmstrip figcaption { margin-top:4px; color:var(--muted); font:11px/1.45 var(--mono); }
details.session { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin:12px 0; padding:10px 14px; }
details.session > summary { font-size:15px; display:flex; flex-wrap:wrap; gap:4px 10px; align-items:baseline; }
details.session .role { color:var(--muted); font-size:13px; }
details.session .count { margin-left:auto; color:var(--muted); font-size:12px; }
.objective { margin:8px 0 14px; color:var(--muted); max-width:72ch; }
.block { border-left:2px solid transparent; border-radius:4px; padding:6px 10px; margin:8px 0; }
.block.g0 { background:rgba(96,165,250,.16); border-color:rgba(96,165,250,.85); }
.block.g1 { background:rgba(52,211,153,.16); border-color:rgba(52,211,153,.85); }
.block.g2 { background:rgba(251,191,36,.18); border-color:rgba(251,191,36,.9); }
.block.g3 { background:rgba(244,114,182,.16); border-color:rgba(244,114,182,.85); }
.task { margin:2px 0 8px; font-weight:600; }
.task.none { font-weight:400; color:var(--muted); font-style:italic; }
ol.steps { list-style:none; margin:0; padding:0; }
.step { margin:0 0 2px; }
.step .row { display:flex; gap:8px; font:12px/1.6 var(--mono); }
.step .t { color:var(--muted); flex:0 0 auto; }
.step .a { font-weight:600; flex:0 0 auto; }
.step .a.bad { color:var(--bad); }
.step .d { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.step .frame { display:block; margin:4px 0 10px; }
.step .frame img { max-width:min(100%,720px); max-height:360px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; display:block; }
#gone-bar { position:sticky; top:0; z-index:3; margin:0; padding:14px 22px; background:var(--warn-bg); color:var(--warn); border-bottom:1px solid var(--line); }
#gone-bar p { margin:0 0 6px; max-width:68ch; }
#gone-bar .path { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
#gone-bar code { font:12px/1.6 var(--mono); background:none; user-select:all; }
#gone-bar button { font:inherit; padding:4px 10px; border:1px solid currentColor; border-radius:6px; background:transparent; color:inherit; cursor:pointer; }
#gone-bar .why { margin:0; font-size:12px; opacity:.85; }
.onDisk { display:block; margin-top:4px; color:var(--muted); font:11px/1.5 var(--mono); overflow-wrap:anywhere; }
header.top .served { flex:1 1 100%; margin:2px 0 0; color:var(--muted); font-size:12px; }
header.top .served code { font:11px/1.5 var(--mono); }
.gone-note { display:none; margin:0; padding:14px; border:1px dashed var(--line); border-radius:6px; color:var(--muted); font-size:12px; }
figure.gone .gone-note, a.gone .gone-note { display:block; }
/* A picture that did not load gives way to its note; the element stays, 1px and transparent, so nothing that points at it loses it. */
figure.gone img, a.gone img { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
a.frame.gone { display:block; max-width:min(100%,720px); }
@media (max-width:640px) {
  header.top { position:static; padding:12px 16px; }
  nav { margin-left:0; }
  h2 { font-size:22px; margin-top:36px; }
  #summary + p { font-size:17px; }
  table.problems, table.problems tbody, table.problems tr, table.problems td { display:block; width:auto; }
  table.problems thead { display:none; }
  table.problems tr { border:1px solid var(--line); border-radius:8px; margin:0 0 10px; padding:10px 12px; background:var(--panel); }
  table.problems td { border:0; padding:2px 0; text-align:left; }
  table.problems td:first-child { width:auto; text-align:left; }
  table.problems td::before { content:attr(data-label); display:block; color:var(--muted); font-size:12px; font-weight:400; }
  table.problems td:first-child::before, table.problems td:nth-child(2)::before, table.problems td:nth-child(3)::before { display:none; }
  table.problems td:first-child { float:left; margin-right:8px; }
  .step .frame img { max-width:100%; }
}
@media (prefers-reduced-motion: reduce) { details.part > summary::before { transition:none; } }
@media print {
  :root { --bg:#fff; --panel:#fff; --sunk:#f1f2f4; --line:#c9ced6; --text:#000; --muted:#444; }
  header.top { position:static; padding:0 0 8px; }
  nav, #gone-bar, header.top .served { display:none; }
  main { max-width:none; padding:0; }
  a { color:inherit; text-decoration:none; }
  article.ev, figure, tr, details.problem { break-inside:avoid; }
  h2, h3, .ev-head { break-after:avoid; }
  .impact { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .filmstrip .shots { flex-wrap:wrap; overflow:visible; }
  details.part > summary::before { display:none; }
}
`;

/**
 * Only the SERVED copy carries this. It watches the engine, and the moment the
 * engine is gone it says so, because from then on a refresh gets the browser's
 * "site can't be reached" and the tab is lost for nothing — this page is still
 * perfectly readable, and the copy on disk is the one that survives.
 *
 * A browser refuses to follow a `file://` link from an `http://` page, so the
 * saved copy cannot be opened from here. The path is offered to copy instead.
 *
 * No template literals and no backticks: this whole module is one.
 */
function exitWatch(savedFile: string): string {
  return (
    "(function () {\n" +
    "  var saved = " +
    // Escaped: a folder named with "</script>" must not end this element.
    scriptLiteral(savedFile) +
    ";\n" +
    "  var gone = false;\n" +
    "  var bar = document.getElementById('gone-bar');\n" +
    "  function ended() {\n" +
    "    if (gone) return;\n" +
    "    gone = true;\n" +
    "    bar.hidden = false;\n" +
    "    document.body.classList.add('engine-gone');\n" +
    "  }\n" +
    "  function check() {\n" +
    "    fetch('api/status', { cache: 'no-store' })\n" +
    "      .then(function (r) { if (!r.ok && r.status >= 500) ended(); })\n" +
    "      .catch(ended);\n" +
    "  }\n" +
    "  setInterval(check, 5000);\n" +
    "  check();\n" +
    "  document.getElementById('gone-copy').addEventListener('click', function () {\n" +
    "    var self = this;\n" +
    "    function said(text) { self.textContent = text; setTimeout(function () { self.textContent = 'Copy the path'; }, 2000); }\n" +
    "    if (navigator.clipboard && navigator.clipboard.writeText) {\n" +
    "      navigator.clipboard.writeText(saved).then(function () { said('Copied'); }, function () { said('Select it and copy'); });\n" +
    "    } else { said('Select it and copy'); }\n" +
    "  });\n" +
    "  // Refresh, close, back — all of them lose this page once the engine has\n" +
    "  // exited, and none of them can be told apart here. Ask first.\n" +
    "  window.addEventListener('beforeunload', function (e) {\n" +
    "    if (!gone) return;\n" +
    "    e.preventDefault();\n" +
    "    e.returnValue = '';\n" +
    "  });\n" +
    "})();"
  );
}

/** The header's links: the report's parts it holds, then the steps. */
function navLinks(markdown: string): string {
  const has = (heading: string): boolean => markdown.split("\n").includes(`## ${heading}`);
  return [
    has(SUMMARY_HEADING)
      ? `<a href="#summary" data-testid="report-summary-link">${SUMMARY_HEADING}</a>`
      : `<a href="#report" data-testid="report-top-link">Report</a>`,
    has(EVIDENCE_HEADING) ? `<a href="#evidence" data-testid="report-evidence-link">${EVIDENCE_HEADING}</a>` : "",
    has(TECHNICAL_HEADING) ? `<a href="#technical" data-testid="report-technical-link">${TECHNICAL_HEADING}</a>` : "",
    `<a href="#steps" data-testid="report-steps-link">Steps</a>`,
  ]
    .filter(Boolean)
    .join("");
}

/** The report's own title and date: the page's header says both, so the body starts at the first section. */
function withoutTitle(markdown: string): string {
  return markdown.replace(/^# SceneScout Report\n+(Generated: [^\n]*\n+)?/, "");
}

/** The whole document: one file, no external assets, opens from the file system. */
export function buildReplayHtml(input: ReplayInput): string {
  const framed = input.sessions.some((s) => s.steps.some((x) => x.frame));
  const prefix = input.framePrefix ?? "";
  const savedAt = input.savedAt ?? "";
  const sessions = input.sessions.map((s, i) => renderSession(s, i, prefix, savedAt)).join("\n");
  const report = renderMarkdown(withoutTitle(input.markdown), input.evidence ?? [], prefix, savedAt);
  const watch = savedAt ? exitWatch(`${savedAt}/report.html`) : "";
  const stepCount = input.sessions.reduce((n, s) => n + s.steps.length, 0);
  // The copy on disk runs nothing but the picture handler; the served copy also runs its watch on the engine, and the fetch that watch makes.
  const policy = savedPageCsp({
    scripts: watch ? [watch] : [],
    handlers: report.includes(GONE) || sessions.includes(GONE) ? [GONE_HANDLER] : [],
    connect: Boolean(watch),
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta(policy)}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SceneScout run report — ${escapeHtml(input.project)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <div><h1>SceneScout run report</h1>
  <p class="meta">${escapeHtml(input.project)} · written ${escapeHtml(stamp(input.at))}${input.version ? ` · v${escapeHtml(input.version)}` : ""}</p></div>
  <nav aria-label="Report sections">${navLinks(input.markdown)}</nav>
  ${savedAt ? `<p class="served">This page is served by the engine and goes when it does. The copy that stays is <code>${escapeHtml(savedAt)}/report.html</code>, beside the frames it shows.</p>` : ""}
</header>
${
  savedAt
    ? `<div id="gone-bar" role="alert" data-testid="run-engine-gone" hidden>
  <p><b>The engine has exited.</b> Everything here is still readable, but reloading this address will not reach anything. The copy that survives, with its frames, is on disk:</p>
  <p class="path"><code>${escapeHtml(savedAt)}/report.html</code> <button type="button" id="gone-copy" data-testid="run-copy-path">Copy the path</button></p>
  <p class="why">A browser will not open a file from a served page, so it has to be opened from there.</p>
</div>`
    : ""
}
<main id="report">
${report}
<details class="part" id="steps" data-testid="report-steps-section"><summary data-testid="report-steps-toggle"><h2>Steps</h2><span class="hint">Every action each session took, in the blocks its tasks made: ${input.sessions.length} session${input.sessions.length === 1 ? "" : "s"}, ${stepCount} step${stepCount === 1 ? "" : "s"}.</span></summary>
<p class="objective">${
    framed
      ? "Each step shows the page as it was; click a frame to open it full size."
      : "This run was not recorded, so there are no frames — attach with record:true to keep them."
  }</p>
${sessions || "<p>No session recorded any action.</p>"}
</details>
</main>
${watch ? `<script>${watch}</script>` : ""}
</body>
</html>
`;
}
