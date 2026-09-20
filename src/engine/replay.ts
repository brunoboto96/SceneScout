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
import path from "node:path";
import type { ActivityLine } from "./live.js";

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

/**
 * Where a recorded frame is stored, relative to the memory directory — and
 * the path the live view serves it at, so it is always written with forward
 * slashes. The session name is the agent's and the action the tool's, so both
 * are reduced to a plain file name here: a session called `../../etc` decides
 * nothing about where the engine writes.
 */
export function framePath(session: string, index: number, action: string): string {
  const plain = (text: string, fallback: string): string =>
    text
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 60) || fallback;
  return `recordings/${plain(session, "session")}/${String(index).padStart(4, "0")}-${plain(action, "step")}.jpg`;
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
  const file = path.resolve(root, inside);
  return file.startsWith(root + path.sep) ? file : null;
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

/** A result that reads as a failure, so a step that went wrong is visible without reading every line. */
const BAD_RESULT = /error|fail|refus|block|violation|abandoned/i;

function renderStep(step: ActivityLine, framePrefix = "", savedAt = ""): string {
  const detail = [step.target, step.result ? `→ ${step.result}` : ""].filter(Boolean).join(" ") || step.url || "";
  const bad = BAD_RESULT.test(step.result ?? "") ? " bad" : "";
  const frame = step.frame
    ? `<a class="frame" href="${escapeHtml(framePrefix + step.frame)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${escapeHtml(framePrefix + step.frame)}" alt="What the page showed at this step"></a>`
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

function renderEvidence(e: FindingEvidence, framePrefix = "", savedAt = ""): string {
  if (e.frames.length === 0) return "";
  const shots = e.frames
    .map(
      (f) =>
        `<figure><img loading="lazy" src="${escapeHtml(framePrefix + f.frame)}" alt="The page when this step ran">` +
        `<figcaption>${escapeHtml(clock(f.at))} <b>${escapeHtml(f.action)}</b> ${escapeHtml(f.detail)}` +
        (savedAt ? `<span class="onDisk">${escapeHtml(savedAt + "/" + f.frame)}</span>` : "") +
        `</figcaption></figure>`,
    )
    .join("");
  return `<details class="evidence"><summary>Evidence — the ${e.frames.length} step${e.frames.length === 1 ? "" : "s"} on screen before this was filed</summary><div class="shots">${shots}</div></details>`;
}

/**
 * The report's markdown as elements. A deliberately small subset — headings,
 * tables, lists, code fences, the report's own <details> repro blocks — built
 * by escaping every piece of text, because finding titles and element names
 * come from the app under test.
 */
export function renderMarkdown(md: string, evidence: readonly FindingEvidence[] = [], framePrefix = "", savedAt = ""): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  let para: string[] = [];
  const inline = (text: string): string =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const flush = (): void => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
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
      const level = Math.min(6, m[1].length + 1);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      i += 1;
    } else if ((m = /^<details><summary>(.*)<\/summary>$/.exec(line))) {
      flush();
      out.push(`<details><summary>${inline(m[1])}</summary>`);
      i += 1;
    } else if (/^<\/details>$/.test(line)) {
      flush();
      out.push(`</details>`);
      i += 1;
    } else if (/^\|/.test(line)) {
      flush();
      const rows: string[] = [];
      let first = true;
      while (i < lines.length && /^\|/.test(lines[i])) {
        const row = lines[i];
        i += 1;
        if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(row)) continue;
        const cells = row
          .replace(/^\||\|\s*$/g, "")
          .split("|")
          .map((c) => `<${first ? "th" : "td"}>${inline(c.trim())}</${first ? "th" : "td"}>`);
        rows.push(`<tr>${cells.join("")}</tr>`);
        first = false;
      }
      out.push(`<table>${rows.join("")}</table>`);
    } else if (/^\s*[-*] /.test(line)) {
      flush();
      const items: string[] = [];
      // A finding's id sits in this list; its evidence goes straight under it,
      // which is where a reader is when they ask "show me".
      let found: FindingEvidence | undefined;
      while (i < lines.length && (m = /^\s*[-*] (.*)$/.exec(lines[i]))) {
        const id = /\*\*Id:\*\* `([0-9a-f]+)`/.exec(m[1])?.[1];
        if (id) found = evidence.find((e) => e.id === id);
        items.push(`<li>${inline(m[1])}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      if (found) out.push(renderEvidence(found, framePrefix, savedAt));
    } else if (/^\d+\. /.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && (m = /^\d+\. (.*)$/.exec(lines[i]))) {
        items.push(`<li>${inline(m[1])}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
    } else if (line.trim() === "") {
      flush();
      i += 1;
    } else {
      para.push(line);
      i += 1;
    }
  }
  flush();
  return out.join("\n");
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --panel:#fff; --line:#d9dde3; --text:#15181d; --muted:#5d6673; --accent:#2563eb; --bad:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --panel:#161a21; --line:#2a303a; --text:#e6e9ee; --muted:#98a2b3; --accent:#7aa2ff; --bad:#fca5a5; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
header { position:sticky; top:0; z-index:2; display:flex; flex-wrap:wrap; gap:8px 16px; align-items:baseline; padding:14px 20px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { margin:0; font-size:17px; }
header .meta { color:var(--muted); font-size:13px; }
nav { margin-left:auto; display:flex; gap:12px; font-size:14px; }
nav a { color:var(--accent); }
main { max-width:1000px; margin:0 auto; padding:24px 20px 64px; }
h2 { font-size:21px; margin:32px 0 12px; padding-top:20px; border-top:1px solid var(--line); }
h3 { font-size:17px; margin:24px 0 8px; }
h4 { font-size:15px; margin:20px 0 6px; }
table { border-collapse:collapse; margin:10px 0 16px; font-size:13px; }
th, td { border:1px solid var(--line); padding:5px 9px; text-align:left; vertical-align:top; }
th { background:var(--panel); }
code { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
pre { padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:6px; overflow-x:auto; }
pre code { border:0; padding:0; background:none; }
details.session { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin:12px 0; padding:10px 14px; }
details.session > summary { cursor:pointer; font-size:15px; display:flex; gap:10px; align-items:baseline; }
details.session .role { color:var(--muted); font-size:13px; }
details.session .count { margin-left:auto; color:var(--muted); font-size:12px; }
.objective { margin:8px 0 14px; color:var(--muted); }
.block { border-left:2px solid transparent; border-radius:4px; padding:6px 10px; margin:8px 0; }
.block.g0 { background:rgba(96,165,250,.22); border-color:rgba(96,165,250,.85); }
.block.g1 { background:rgba(52,211,153,.22); border-color:rgba(52,211,153,.85); }
.block.g2 { background:rgba(251,191,36,.24); border-color:rgba(251,191,36,.9); }
.block.g3 { background:rgba(244,114,182,.22); border-color:rgba(244,114,182,.85); }
@media (prefers-color-scheme: light) {
  .block.g0 { background:rgba(37,99,235,.13); } .block.g1 { background:rgba(5,150,105,.13); }
  .block.g2 { background:rgba(217,119,6,.15); } .block.g3 { background:rgba(219,39,119,.12); }
}
.task { margin:2px 0 8px; font-weight:600; }
.task.none { font-weight:400; color:var(--muted); font-style:italic; }
ol.steps { list-style:none; margin:0; padding:0; }
.step { margin:0 0 2px; }
.step .row { display:flex; gap:8px; font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.step .t { color:var(--muted); flex:0 0 auto; }
.step .a { font-weight:600; flex:0 0 auto; }
.step .a.bad { color:var(--bad); }
.step .d { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.step .frame { display:block; margin:4px 0 10px; }
.step .frame img { max-width:min(100%,720px); max-height:360px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; display:block; }
details.evidence { margin:6px 0 18px; padding:8px 12px; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
details.evidence > summary { cursor:pointer; color:var(--muted); font-size:13px; }
details.evidence .shots { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; }
details.evidence figure { margin:0; max-width:min(100%,460px); }
details.evidence img { width:100%; max-height:300px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; display:block; background:var(--panel); }
.onDisk { display:block; margin-top:4px; color:var(--muted); font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
header .served { flex:1 1 100%; margin:6px 0 0; color:var(--muted); font-size:12px; }
header .served code { font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
details.evidence figcaption { margin-top:4px; color:var(--muted); font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
`;

/** The whole document: one file, no external assets, opens from the file system. */
export function buildReplayHtml(input: ReplayInput): string {
  const framed = input.sessions.some((s) => s.steps.some((x) => x.frame));
  const prefix = input.framePrefix ?? "";
  const savedAt = input.savedAt ?? "";
  const sessions = input.sessions.map((s, i) => renderSession(s, i, prefix, savedAt)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SceneScout run — ${escapeHtml(input.project)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>SceneScout run</h1>
  <span class="meta">${escapeHtml(input.project)} · written ${escapeHtml(stamp(input.at))}${input.version ? ` · v${escapeHtml(input.version)}` : ""}</span>
  ${savedAt ? `<p class="served">This page is served by the engine and goes when it does. The copy that stays is <code>${escapeHtml(savedAt)}/report.html</code>, beside the frames it shows.</p>` : ""}
  <nav><a href="#report">Report</a><a href="#steps">Steps</a></nav>
</header>
<main>
<h2 id="report">Report</h2>
${renderMarkdown(input.markdown, input.evidence ?? [], prefix, savedAt)}
<h2 id="steps">What each session did</h2>
<p class="objective">Every action, in the blocks its tasks made. ${
    framed
      ? "Each step shows the page as it was; click a frame to open it full size."
      : "This run was not recorded, so there are no frames — attach with record:true to keep them."
  }</p>
${sessions || "<p>No session recorded any action.</p>"}
</main>
</body>
</html>
`;
}
