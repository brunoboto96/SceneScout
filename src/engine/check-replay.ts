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
/** The folder beside it that holds the frames the page shows. */
export const REPLAY_FRAMES_DIRNAME = "replay-frames";

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
}

export interface ReplayJourney {
  name: string;
  file: string;
  status: FlowOutcome["status"];
  steps: ReplayStep[];
  /** The step that broke or was refused, when one did. */
  firstFailing?: number;
}

/** What a visited route answered. */
export type ReplayVisitResult = "loaded" | "http-error" | "sign-in" | "not-loaded";

export interface ReplayVisit {
  path: string;
  status: number | null;
  result: ReplayVisitResult;
  reason?: string;
  frame?: string;
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
  /** Frames left off the page by the cap. */
  framesLeftOut: number;
}

/**
 * Each step of a replayed flow with its caption, its result and its frame.
 * The replay stops at the first step that breaks, so every step before it
 * passed, it is the failing one, and those after it never ran (and have no
 * frame). `frames` holds one entry per executed step, null where none was kept.
 */
export function journeySteps(steps: readonly FlowStep[], outcome: FlowOutcome, frames: ReadonlyArray<string | null> = []): ReplayStep[] {
  const broke = outcome.status === "passed" ? null : outcome.step;
  return steps.map((step, i) => {
    const n = i + 1;
    const frame = broke === null || n <= broke ? (frames[i] ?? undefined) : undefined;
    const base = { n, caption: describeStep(step), ...(frame ? { frame } : {}) };
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
  frames?: ReadonlyArray<string | null>,
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
export function visitOf(route: { path: string; status: number | null; loadError?: string; loginRedirect: boolean }, frame?: string): ReplayVisit {
  const result: ReplayVisitResult =
    route.loadError !== undefined ? "not-loaded" : route.loginRedirect ? "sign-in" : route.status !== null && route.status >= 400 ? "http-error" : "loaded";
  return {
    path: route.path,
    status: route.status,
    result,
    ...(route.loadError !== undefined ? { reason: route.loadError } : {}),
    ...(frame ? { frame } : {}),
  };
}

/**
 * At most `max` frames per role, the first ones kept: the same cap a recorded
 * session keeps (RECORD_MAX_FRAMES), held here too so the page never shows
 * more than the run was allowed to take, whatever it is handed.
 */
export function capFrames(replay: CheckReplay, max: number = RECORD_MAX_FRAMES): CheckReplay {
  let leftOut = replay.framesLeftOut;
  const roles = replay.roles.map((role) => {
    let kept = 0;
    const take = <T extends { frame?: string }>(item: T): T => {
      if (!item.frame) return item;
      if (kept < max) {
        kept += 1;
        return item;
      }
      leftOut += 1;
      const { frame: _dropped, ...rest } = item;
      return rest as T;
    };
    return {
      ...role,
      visits: role.visits.map(take),
      journeys: role.journeys.map((j) => ({ ...j, steps: j.steps.map(take) })),
    };
  });
  return { ...replay, roles, framesLeftOut: leftOut };
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

const GONE = `onerror="this.parentNode.classList.add('gone')"`;

function frameHtml(frame: string | undefined, alt: string): string {
  if (!frame) return `<p class="noframe">No frame</p>`;
  const src = escapeHtml(frame);
  return (
    `<a class="frame" href="${src}" target="_blank" rel="noreferrer" data-testid="replay-frame-open"><img loading="lazy" ${GONE} src="${src}" alt="${escapeHtml(alt)}">` +
    `<span class="gone-note">This frame is not beside this file. Frames live in the <code>${REPLAY_FRAMES_DIRNAME}/</code> folder, which travels with it.</span></a>`
  );
}

function stepHtml(s: ReplayStep, anchor: string): string {
  const first = s.result === "failed" || s.result === "refused";
  const detail = [s.reason, s.path ? `on ${s.path}` : ""].filter(Boolean).join(" ");
  return (
    `<li class="step ${s.result}${first ? " first-failing" : ""}"${first ? ` id="${anchor}"` : ""} data-result="${s.result}">` +
    `<div class="caption"><span class="n">${s.n}</span> <span class="what">${escapeHtml(s.caption)}</span> <span class="result r-${s.result}">${RESULT_WORD[s.result]}</span></div>` +
    (detail ? `<p class="why">${escapeHtml(detail)}</p>` : "") +
    (s.result === "not-run" ? "" : frameHtml(s.frame, `The page after step ${s.n}: ${s.caption}`)) +
    `</li>`
  );
}

function journeyHtml(j: ReplayJourney, id: string): string {
  const ok = j.status === "passed";
  const anchor = `${id}-first-failing`;
  const badge = ok ? `<span class="badge pass">passed</span>` : `<span class="badge fail">${j.status}</span>`;
  const jump =
    j.firstFailing !== undefined
      ? `<a class="jump" href="#${anchor}" data-testid="replay-first-failing-link">Step ${j.firstFailing} ${j.status}</a>`
      : `<span class="count">${j.steps.length} step${j.steps.length === 1 ? "" : "s"}</span>`;
  return (
    `<details class="journey ${ok ? "pass" : "fail"}"${ok ? "" : " open"} data-status="${j.status}"><summary data-testid="replay-journey-toggle">${badge} <b>${escapeHtml(j.name)}</b> <span class="file">${escapeHtml(j.file)}</span> ${jump}</summary>` +
    `<ol class="steps">${j.steps.map((s) => stepHtml(s, anchor)).join("")}</ol></details>`
  );
}

function visitsHtml(visits: readonly ReplayVisit[]): string {
  if (visits.length === 0) return "";
  const items = visits
    .map(
      (v) =>
        `<li class="visit ${v.result}"><div class="caption"><span class="what">visit ${escapeHtml(v.path)}</span> <span class="result v-${v.result}">${v.status ?? "—"} · ${VISIT_WORD[v.result]}</span></div>` +
        (v.reason ? `<p class="why">${escapeHtml(v.reason)}</p>` : "") +
        frameHtml(v.frame, `The page at ${v.path}`) +
        `</li>`,
    )
    .join("");
  return `<details class="visits"><summary data-testid="replay-visits-toggle">Routes visited <span class="count">${visits.length}</span></summary><ol class="steps">${items}</ol></details>`;
}

function roleHtml(r: ReplayRole, i: number): string {
  const failing = r.journeys.filter((j) => j.status !== "passed").length;
  const tally = `${r.journeys.length} journey${r.journeys.length === 1 ? "" : "s"}${failing ? `, ${failing} not passed` : ""}`;
  return (
    `<section class="role" id="role-${i}"><h2>${escapeHtml(r.role)} <span class="count">${r.own ? "the check's own session · " : ""}${tally}</span></h2>` +
    visitsHtml(r.visits) +
    (r.journeys.length > 0 ? r.journeys.map((j, k) => journeyHtml(j, `role-${i}-journey-${k}`)).join("") : `<p class="none">No journey ran as this role.</p>`) +
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
a.frame { display:block; margin:6px 0 2px; max-width:min(100%,720px); }
a.frame img { max-width:100%; max-height:400px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; display:block; }
.gone-note { display:none; padding:12px; border:1px dashed var(--line); border-radius:6px; color:var(--muted); font-size:12px; }
a.frame.gone img { display:none; } a.frame.gone .gone-note { display:block; }
.noframe, .none { color:var(--muted); font-size:12px; font-style:italic; margin:4px 0; }
.note { color:var(--muted); font-size:13px; }
`;

/** The whole page: one HTML file with no external assets or scripts; its frames sit beside it in replay-frames/. */
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
<title>SceneScout check replay — ${escapeHtml(meta.origin)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>SceneScout check replay ${badge}</h1>
  <dl>${pair("App", meta.origin)}${pair("Started", stamp(meta.startedAt))}${pair("Ended", stamp(meta.endedAt))}${meta.commit ? pair("Commit", meta.commit) : ""}${pair("SceneScout", `v${meta.version}`)}${pair("Frames", String(frames))}</dl>
</header>
<main>
<p class="note">Each role, then each journey it walked, step by step, with the page as it was after the step. Typed values are never shown, and secrets in addresses are redacted as in the report.${
    replay.framesLeftOut > 0 ? ` ${replay.framesLeftOut} frame(s) past the cap of ${RECORD_MAX_FRAMES} per role are not kept; those steps show no frame.` : ""
  }</p>
${replay.roles.map(roleHtml).join("\n") || '<p class="none">Nothing was recorded.</p>'}
</main>
</body>
</html>
`;
}
