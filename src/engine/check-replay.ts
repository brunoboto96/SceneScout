/**
 * The replay page of a recorded `scenescout check` (`--record`): what each
 * role did, journey by journey and step by step, with the frame the page
 * showed after each step, so a green run leaves evidence of what passed and a
 * red one shows where it broke.
 *
 * A journey is a saved flow (flow.ts); a role is the session it ran in, the
 * check's own or the one its `role` names. The check's own session also lists
 * the routes it visited, one frame each.
 *
 * Everything here is pure: the mapping of steps to captions and results, the
 * frame cap, the redaction and the page itself are table-tested. check-run.ts
 * gathers the frames from the browser and copies them beside the page.
 */
import { redactRoute } from "./memory.js";
import { describeStep, type FlowOutcome, type FlowStep } from "./flow.js";
import { escapeHtml, plainSegment, RECORD_MAX_FRAMES } from "./replay.js";

/** The file the page is written to, beside report.md. */
export const REPLAY_FILE = "replay.html";
/** The page's generator mark: an earlier run's page is removed only when it carries it, never a file of the same name. */
export const REPLAY_GENERATOR = "scenescout-check-replay";

/** Whether a replay.html is one a check wrote. */
export function isGeneratedReplay(html: string): boolean {
  return html.includes(`<meta name="generator" content="${REPLAY_GENERATOR}">`);
}

/** The folder beside it that holds the frames the page shows. */
export const REPLAY_FRAMES_DIRNAME = "replay-frames";
/** The folder beside it that holds one video per journey (--video). */
export const REPLAY_VIDEOS_DIRNAME = "replay-videos";

/** What became of one step: done, broken, refused by the write policy, or never reached because an earlier one broke. */
export type ReplayStepResult = "passed" | "failed" | "refused" | "not-run";

export interface ReplayStep {
  /** 1-based, as the check's report counts steps. */
  n: number;
  /** The action and its target, as the report words it. A typed value is never part of it. */
  caption: string;
  result: ReplayStepResult;
  /** Why it failed or was refused. */
  reason?: string;
  /** The page it was on when it failed or was refused. */
  path?: string;
  /** The frame after the step, relative to the page. */
  frame?: string;
  /** No frame, because the session had already kept as many as it may. */
  pastCap?: true;
}

/** What a recorded session kept after one step: its frame, or why it has none. */
export interface StepShot {
  frame?: string;
  /** The session had already kept as many frames as it may. */
  pastCap?: true;
}

export interface ReplayJourney {
  name: string;
  file: string;
  status: FlowOutcome["status"];
  steps: ReplayStep[];
  /** The step that broke or was refused, when one did. */
  firstFailing?: number;
  /** The journey's video (--video), relative to the page. */
  video?: string;
}

/** What a visited route answered. */
export type ReplayVisitResult = "loaded" | "http-error" | "sign-in" | "not-loaded";

export interface ReplayVisit {
  path: string;
  status: number | null;
  result: ReplayVisitResult;
  reason?: string;
  frame?: string;
  pastCap?: true;
}

export interface ReplayRole {
  /** The role a journey named, or the label of the check's own session. */
  role: string;
  /** The check's own session: the one that crawled. */
  own: boolean;
  visits: ReplayVisit[];
  journeys: ReplayJourney[];
}

/** The page's model, kept on the check's result so the same masking and redaction reach it. */
export interface CheckReplay {
  startedAt: string;
  roles: ReplayRole[];
  /** Steps and visits with no frame because of the cap: those the session did not take, and those the page drops. */
  framesLeftOut: number;
  /** The most frames one session keeps; RECORD_MAX_FRAMES unless a test lowered it. */
  frameCap?: number;
}

/** A shot's fields as an item carries them. */
function shotFields(shot: StepShot | null | undefined): StepShot {
  if (shot?.frame) return { frame: shot.frame };
  return shot?.pastCap ? { pastCap: true } : {};
}

/**
 * Each step of a replayed flow with its caption, its result and its frame.
 * The replay stops at the first step that breaks, so every step before it
 * passed, it is the failing one, and those after it never ran (and have no
 * frame). `frames` holds one entry per executed step: its frame, or why it has none.
 */
export function journeySteps(steps: readonly FlowStep[], outcome: FlowOutcome, frames: ReadonlyArray<StepShot | null> = []): ReplayStep[] {
  const broke = outcome.status === "passed" ? null : outcome.step;
  return steps.map((step, i) => {
    const n = i + 1;
    const shot = broke === null || n <= broke ? shotFields(frames[i]) : {};
    const base = { n, caption: describeStep(step), ...shot };
    if (broke === null || n < broke) return { ...base, result: "passed" as const };
    if (n > broke) return { n, caption: base.caption, result: "not-run" as const };
    // `broke` is set only when the outcome is not "passed".
    const failed = outcome as Exclude<FlowOutcome, { status: "passed" }>;
    return { ...base, result: failed.status, reason: failed.reason, path: failed.path };
  });
}

/** One journey of the page, from a flow and how its replay went. */
export function journeyOf(
  flow: { name: string; file: string; steps: readonly FlowStep[] },
  outcome: FlowOutcome,
  frames?: ReadonlyArray<StepShot | null>,
): ReplayJourney {
  return {
    name: flow.name,
    file: flow.file,
    status: outcome.status,
    steps: journeySteps(flow.steps, outcome, frames),
    ...(outcome.status === "passed" ? {} : { firstFailing: outcome.step }),
  };
}

/** One visited route, from what the crawl measured. */
export function visitOf(route: { path: string; status: number | null; loadError?: string; loginRedirect: boolean }, shot?: StepShot | null): ReplayVisit {
  const result: ReplayVisitResult =
    route.loadError !== undefined ? "not-loaded" : route.loginRedirect ? "sign-in" : route.status !== null && route.status >= 400 ? "http-error" : "loaded";
  return {
    path: route.path,
    status: route.status,
    result,
    ...(route.loadError !== undefined ? { reason: route.loadError } : {}),
    ...shotFields(shot),
  };
}

/**
 * At most `max` frames per role, the first ones kept: the same cap a recorded
 * session keeps (RECORD_MAX_FRAMES), held here too so the page never shows
 * more than the run was allowed to take, whatever it is handed. A step
 * dropped here is marked past the cap like one the session did not take, and
 * `framesLeftOut` counts both, so the page says why each has no frame.
 */
export function capFrames(replay: CheckReplay, max: number = replay.frameCap ?? RECORD_MAX_FRAMES): CheckReplay {
  let leftOut = 0;
  const roles = replay.roles.map((role) => {
    let kept = 0;
    const take = <T extends { frame?: string; pastCap?: true }>(item: T): T => {
      if (item.pastCap) leftOut += 1;
      if (!item.frame) return item;
      if (kept < max) {
        kept += 1;
        return item;
      }
      leftOut += 1;
      const { frame: _dropped, ...rest } = item;
      return { ...rest, pastCap: true } as T;
    };
    return {
      ...role,
      visits: role.visits.map(take),
      journeys: role.journeys.map((j) => ({ ...j, steps: j.steps.map(take) })),
    };
  });
  return { ...replay, roles, framesLeftOut: leftOut, frameCap: max };
}

/** The report's redaction (memory.ts redactRoute) on every path, caption and reason the page shows. */
export function redactReplay(replay: CheckReplay): CheckReplay {
  return {
    ...replay,
    roles: replay.roles.map((role) => ({
      ...role,
      visits: role.visits.map((v) => ({ ...v, path: redactRoute(v.path), ...(v.reason !== undefined ? { reason: redactRoute(v.reason) } : {}) })),
      journeys: role.journeys.map((j) => ({
        ...j,
        steps: j.steps.map((s) => ({
          ...s,
          caption: redactRoute(s.caption),
          ...(s.reason !== undefined ? { reason: redactRoute(s.reason) } : {}),
          ...(s.path !== undefined ? { path: redactRoute(s.path) } : {}),
        })),
      })),
    })),
  };
}

/**
 * Where the video of the n-th journey run (1-based) goes beside the page. The
 * flow's file name is reduced to a plain segment, so it decides nothing about
 * where the file is written; the number keeps two flows' videos apart.
 */
export function journeyVideoPath(n: number, file: string): string {
  return `${REPLAY_VIDEOS_DIRNAME}/journey-${String(n).padStart(2, "0")}-${plainSegment(file.replace(/\.json$/i, ""), "flow")}.webm`;
}

/** Whether a file under replay-videos/ is a video a check wrote, and so one an earlier run's clean-up may remove. */
export function isJourneyVideoFile(name: string): boolean {
  return /^journey-\d{2,}-[a-z0-9._-]+\.webm$/i.test(name);
}

/** Every journey video the page links, in page order. */
export function replayVideos(replay: CheckReplay): string[] {
  return replay.roles.flatMap((r) => r.journeys.flatMap((j) => (j.video ? [j.video] : [])));
}

/** Every frame the page shows, in page order. */
export function replayFrames(replay: CheckReplay): string[] {
  return replay.roles.flatMap((r) => [
    ...r.visits.flatMap((v) => (v.frame ? [v.frame] : [])),
    ...r.journeys.flatMap((j) => j.steps.flatMap((s) => (s.frame ? [s.frame] : []))),
  ]);
}

const RECORDED_FRAME = /^recordings\/([a-z0-9._-]+)\/(\d{4}-[a-z0-9._-]+\.jpg)$/i;

/**
 * Where a frame a session recorded (replay.ts framePath) goes beside the
 * page, or null for anything that is not one: the path is used to write a
 * file, so nothing else is let through.
 */
export function replayFramePath(recorded: string): string | null {
  const m = RECORDED_FRAME.exec(recorded);
  return m ? `${REPLAY_FRAMES_DIRNAME}/${m[1]}/${m[2]}` : null;
}

/** Whether a file in a session folder under replay-frames/ is a frame a check wrote, and so one an earlier run's clean-up may remove. */
export function isReplayFrameFile(name: string): boolean {
  return /^\d{4}-[a-z0-9._-]+\.jpg$/i.test(name);
}

/** The session name a check's own browser records its frames under, and one for each role's. Distinct, so their frames never share a folder. */
export function replaySessionKey(role?: string): string {
  return role === undefined ? "check" : `role-${plainSegment(role, "role")}`;
}

/** A commit to name in the page's header: GITHUB_SHA when it is one, else none. */
export function commitOf(env: Record<string, string | undefined>): string | undefined {
  const sha = (env.GITHUB_SHA ?? "").trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha.toLowerCase() : undefined;
}

/** What the page's header says about the run. */
export interface ReplayMeta {
  version: string;
  /** The app's origin. */
  origin: string;
  startedAt: string;
  endedAt: string;
  commit?: string;
  /** The gate's verdict, and how many flows a refused step kept from running. */
  passed: boolean;
  couldNotRun: number;
}

const RESULT_WORD: Record<ReplayStepResult, string> = { passed: "passed", failed: "failed", refused: "refused", "not-run": "not run" };
const VISIT_WORD: Record<ReplayVisitResult, string> = {
  loaded: "loaded",
  "http-error": "HTTP error",
  "sign-in": "sent to sign-in",
  "not-loaded": "did not load",
};

/** A UTC time as the page shows it: the reader's own clock is not this page's to assume. */
function stamp(iso: string): string {
  return iso.length >= 19 ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : iso;
}

/**
 * A frame, or a line saying why there is none. No script: the note sits in the
 * same grid cell under the picture, so a picture that loads covers it and one
 * that is missing (a copy sent without replay-frames/) leaves it showing.
 */
function frameHtml(item: { frame?: string; pastCap?: true }, alt: string, cap: number): string {
  if (!item.frame)
    return item.pastCap
      ? `<p class="noframe">No frame: the session had already kept ${cap}, the most one session keeps.</p>`
      : `<p class="noframe">No frame</p>`;
  const src = escapeHtml(item.frame);
  return (
    `<a class="frame" href="${src}" target="_blank" rel="noreferrer" data-testid="replay-frame-open">` +
    `<span class="gone-note">If no picture shows here, this frame is not beside this file. Frames live in the <code>${REPLAY_FRAMES_DIRNAME}/</code> folder, which travels with it.</span>` +
    `<img loading="lazy" src="${src}" alt="${escapeHtml(alt)}"></a>`
  );
}

function stepHtml(s: ReplayStep, anchor: string, cap: number): string {
  const first = s.result === "failed" || s.result === "refused";
  const detail = [s.reason, s.path ? `on ${s.path}` : ""].filter(Boolean).join(" ");
  return (
    `<li class="step ${s.result}${first ? " first-failing" : ""}"${first ? ` id="${anchor}"` : ""} data-result="${s.result}">` +
    `<div class="caption"><span class="n">${s.n}</span> <span class="what">${escapeHtml(s.caption)}</span> <span class="result r-${s.result}">${RESULT_WORD[s.result]}</span></div>` +
    (detail ? `<p class="why">${escapeHtml(detail)}</p>` : "") +
    (s.result === "not-run" ? "" : frameHtml(s, `The page after step ${s.n}: ${s.caption}`, cap)) +
    `</li>`
  );
}

function journeyHtml(j: ReplayJourney, id: string, cap: number): string {
  const ok = j.status === "passed";
  const anchor = `${id}-first-failing`;
  const badge = ok ? `<span class="badge pass">passed</span>` : `<span class="badge fail">${j.status}</span>`;
  const jump =
    j.firstFailing !== undefined
      ? `<a class="jump" href="#${anchor}" data-testid="replay-first-failing-link">Step ${j.firstFailing} ${j.status}</a>`
      : `<span class="count">${j.steps.length} step${j.steps.length === 1 ? "" : "s"}</span>`;
  return (
    `<details class="journey ${ok ? "pass" : "fail"}"${ok ? "" : " open"} data-status="${j.status}"><summary data-testid="replay-journey-toggle">${badge} <b>${escapeHtml(j.name)}</b> <span class="file">${escapeHtml(j.file)}</span> ${jump}</summary>` +
    (j.video
      ? `<figure class="video"><video controls preload="metadata" src="${escapeHtml(j.video)}" data-testid="replay-journey-video"></video>` +
        `<figcaption>The whole journey as it ran. <a href="${escapeHtml(j.video)}" target="_blank" rel="noreferrer" data-testid="replay-video-open">Open the video</a></figcaption></figure>`
      : "") +
    `<ol class="steps">${j.steps.map((s) => stepHtml(s, anchor, cap)).join("")}</ol></details>`
  );
}

function visitsHtml(visits: readonly ReplayVisit[], cap: number): string {
  if (visits.length === 0) return "";
  const items = visits
    .map(
      (v) =>
        `<li class="visit ${v.result}"><div class="caption"><span class="what">visit ${escapeHtml(v.path)}</span> <span class="result v-${v.result}">${v.status ?? "—"} · ${VISIT_WORD[v.result]}</span></div>` +
        (v.reason ? `<p class="why">${escapeHtml(v.reason)}</p>` : "") +
        frameHtml(v, `The page at ${v.path}`, cap) +
        `</li>`,
    )
    .join("");
  return `<details class="visits"><summary data-testid="replay-visits-toggle">Routes visited <span class="count">${visits.length}</span></summary><ol class="steps">${items}</ol></details>`;
}

function roleHtml(r: ReplayRole, i: number, cap: number): string {
  const failing = r.journeys.filter((j) => j.status !== "passed").length;
  const tally = `${r.journeys.length} journey${r.journeys.length === 1 ? "" : "s"}${failing ? `, ${failing} not passed` : ""}`;
  return (
    `<section class="role" id="role-${i}"><h2>${escapeHtml(r.role)} <span class="count">${r.own ? "the check's own session · " : ""}${tally}</span></h2>` +
    visitsHtml(r.visits, cap) +
    (r.journeys.length > 0
      ? r.journeys.map((j, k) => journeyHtml(j, `role-${i}-journey-${k}`, cap)).join("")
      : `<p class="none">No journey ran as this role.</p>`) +
    `</section>`
  );
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --panel:#fff; --line:#d9dde3; --text:#15181d; --muted:#5d6673; --accent:#2563eb; --pass:#047857; --pass-bg:#d1fae5; --fail:#b91c1c; --fail-bg:#fee2e2; }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --panel:#161a21; --line:#2a303a; --text:#e6e9ee; --muted:#98a2b3; --accent:#7aa2ff; --pass:#6ee7b7; --pass-bg:#063b2c; --fail:#fca5a5; --fail-bg:#3f1010; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
header { padding:14px 20px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { margin:0 0 4px; font-size:18px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
header dl { display:flex; flex-wrap:wrap; gap:4px 18px; margin:0; font-size:13px; color:var(--muted); }
header dt { font-weight:600; } header dd { margin:0 0 0 4px; overflow-wrap:anywhere; }
header .pair { display:flex; }
main { max-width:1000px; margin:0 auto; padding:20px 16px 64px; }
h2 { font-size:19px; margin:28px 0 10px; }
.count, .file { color:var(--muted); font-size:13px; font-weight:400; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; }
.badge.pass { color:var(--pass); background:var(--pass-bg); } .badge.fail { color:var(--fail); background:var(--fail-bg); }
details.journey, details.visits { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin:10px 0; padding:10px 14px; }
details.journey.fail { border-color:var(--fail); }
summary { cursor:pointer; }
.jump { color:var(--fail); font-size:13px; margin-left:6px; }
ol.steps { list-style:none; margin:10px 0 0; padding:0; }
.step, .visit { border-left:3px solid var(--line); padding:6px 10px; margin:0 0 10px; }
.step.passed, .visit.loaded { border-color:var(--pass); }
.step.failed, .step.refused, .visit.http-error, .visit.not-loaded, .visit.sign-in { border-color:var(--fail); }
.step.first-failing { background:var(--fail-bg); border-left-width:6px; }
.step.not-run { opacity:.6; }
.caption { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
.caption .n { font-weight:700; color:var(--muted); min-width:1.5em; }
.caption .what { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
.result { margin-left:auto; font-size:12px; font-weight:700; }
.r-passed, .v-loaded { color:var(--pass); } .r-failed, .r-refused, .v-http-error, .v-not-loaded, .v-sign-in { color:var(--fail); } .r-not-run { color:var(--muted); }
.why { margin:4px 0; font-size:13px; overflow-wrap:anywhere; }
a.frame { display:grid; margin:6px 0 2px; max-width:min(100%,720px); color:var(--muted); font-size:12px; }
a.frame > * { grid-area:1 / 1; }
a.frame img { position:relative; max-width:100%; max-height:400px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; display:block; background:var(--panel); }
.gone-note { align-self:end; padding:2.6em 12px 12px; border:1px dashed var(--line); border-radius:6px; }
.noframe, .none { color:var(--muted); font-size:12px; font-style:italic; margin:4px 0; }
.note { color:var(--muted); font-size:13px; }
figure.video { margin:10px 0; max-width:min(100%,720px); }
figure.video video { width:100%; border:1px solid var(--line); border-radius:6px; display:block; background:#000; }
figure.video figcaption { color:var(--muted); font-size:12px; margin-top:4px; }
`;

/** The whole page: one HTML file with no scripts, no event handlers and no external assets; its frames and videos sit beside it. */
export function buildCheckReplayHtml(replay: CheckReplay, meta: ReplayMeta): string {
  const verdict = meta.couldNotRun > 0 ? "could not run every flow" : meta.passed ? "passed" : "failed";
  const badge = `<span class="badge ${meta.passed && meta.couldNotRun === 0 ? "pass" : "fail"}" data-testid="replay-verdict">${verdict}</span>`;
  const pair = (term: string, value: string): string => `<div class="pair"><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const frames = replayFrames(replay).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${REPLAY_GENERATOR}">
<title>SceneScout check replay — ${escapeHtml(meta.origin)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>SceneScout check replay ${badge}</h1>
  <dl>${pair("App", meta.origin)}${pair("Started", stamp(meta.startedAt))}${pair("Ended", stamp(meta.endedAt))}${meta.commit ? pair("Commit", meta.commit) : ""}${pair("SceneScout", `v${meta.version}`)}${pair("Frames", String(frames))}${replayVideos(replay).length > 0 ? pair("Videos", String(replayVideos(replay).length)) : ""}</dl>
</header>
<main>
<p class="note">Each role, then each journey it walked, step by step, with the page as it was after the step${
    frames === 0 ? " when the check was recorded (--record)" : ""
  }. Typed values are never shown, and secrets in addresses are redacted as in the report.${
    replay.framesLeftOut > 0
      ? ` ${replay.framesLeftOut} step(s) and visit(s) have no frame because their session had already kept ${replay.frameCap ?? RECORD_MAX_FRAMES}, the most one session keeps.`
      : ""
  }</p>
${replay.roles.map((r, i) => roleHtml(r, i, replay.frameCap ?? RECORD_MAX_FRAMES)).join("\n") || '<p class="none">Nothing was recorded.</p>'}
</main>
</body>
</html>
`;
}
