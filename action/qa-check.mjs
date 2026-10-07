#!/usr/bin/env node
/**
 * The check mode of the `/scenescout qa` comment: `/scenescout qa check [focus]`
 * dispatches the project's own workflow (named by the repository variable
 * SCENESCOUT_QA_CHECK_WORKFLOW) on the pull request's head branch, waits for
 * that run, reads the check.json its artifact holds and replies with the
 * verdict. How it is used: docs/ci.md ("The project's own check: `/scenescout qa check`").
 * Why it is shaped this way: ADR 15, amendment "the project's own check".
 *
 *   node qa-check.mjs dispatch   dispatch the workflow, find its run, wait for it (no key, no checkout)
 *   node qa-check.mjs reply      read the downloaded check.json and post the verdict (no key, no checkout)
 *
 * Neither stage holds a model's key, checks out the repository or runs any of
 * the pull request's code. The dispatched workflow is the project's: it runs
 * on the project's runners under its own permissions. The gate (qa-action.mjs)
 * decides whether a comment may start a check, exactly as for a preview run.
 * The pure rules are exported and table-tested by qa-test.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { escapeAnnotation, inputsFromEnv, setOutputs } from "./check-action.mjs";
import { checkWorkflowId, COMMENT_MARKER, githubClient, inert } from "./qa-action.mjs";

export { checkWorkflowId };

/** The artifact the project's workflow uploads its check's output folder as, unless SCENESCOUT_QA_CHECK_ARTIFACT names another. */
export const DEFAULT_CHECK_ARTIFACT = "scenescout-check";
/** How long the check stage waits for the dispatched run, unless the workflow says otherwise. */
export const DEFAULT_WAIT_MINUTES = 30;
/** The bounds on that wait. */
export const MAX_WAIT_MINUTES = 300;
/** The inputs every dispatch sends: the project's workflow must declare all three under workflow_dispatch. */
export const DISPATCH_INPUTS = ["pr", "focus", "dispatch-id"];
/** A check.json larger than this is not read. */
export const MAX_CHECK_JSON_BYTES = 10_000_000;
/** Journeys, findings and videos listed in the reply; the rest are in the artifact. */
export const MAX_ROWS = 20;

/** How long to wait, in minutes: the input when it is a whole number in bounds, else the default. */
export function waitMinutes(raw) {
  const n = Number(String(raw ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_WAIT_MINUTES ? n : DEFAULT_WAIT_MINUTES;
}

/** The artifact name to read: the variable, else the default. Only the characters an artifact name may sensibly hold. */
export function checkArtifactName(raw) {
  const s = String(raw ?? "").trim();
  return /^[\w.-]{1,100}$/.test(s) ? s : DEFAULT_CHECK_ARTIFACT;
}

/**
 * The dispatched run, when the dispatch did not name it. GitHub's dispatch
 * call answers with the run's id; where it does not (an older API), the run is
 * found among the workflow's runs: first by the dispatch id, a word of its
 * own in the run's title, where the example's `run-name` puts it, then, for a workflow whose
 * title does not carry it, by the head commit among runs created since the
 * dispatch (less a few seconds of clock skew), oldest first. Null when none
 * matches yet.
 */
export function findDispatchedRun(runs, { dispatchId, sha, since, skewMs = 10_000 }) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.event === "workflow_dispatch");
  if (dispatchId) {
    const byId = list.find((r) =>
      String(r.display_title ?? "")
        .split(/\s+/)
        .includes(dispatchId),
    );
    if (byId) return byId;
  }
  const after = Number(since) - skewMs;
  const bySha = list.filter((r) => r.head_sha === sha && Date.parse(r.created_at) >= after).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return bySha[0] ?? null;
}

// ---------------------------------------------------------------------------
// The replies that end the check stage early. Each starts with the marker.

const reply = (lines) => `${COMMENT_MARKER}\n${lines.join("\n")}\n`;
/**
 * A name (a workflow, a branch, an artifact) as a code span. Inside one,
 * Markdown renders nothing, so it needs no backslash escapes (GitHub would
 * show them); only backticks and control characters are taken out, and it is
 * cut to `max` characters.
 */
export function codeSpan(text, max = 100) {
  let s = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return `\`${s || "?"}\``;
}
const workflowName = (w) => codeSpan(w, 120);

export function unknownWorkflowMarkdown({ workflow }) {
  return reply([
    `No check was started: this repository has no workflow ${workflowName(workflow)}, or the job's token cannot see it.`,
    "",
    "`SCENESCOUT_QA_CHECK_WORKFLOW` names the project's own workflow by its file name in `.github/workflows/` (e.g. `browser-tests.yml`). The workflow must be on the default branch.",
  ]);
}

export function disabledWorkflowMarkdown({ workflow, state }) {
  return reply([`No check was started: the workflow ${workflowName(workflow)} is ${inert(state, 40)}. Enable it in the repository's Actions tab.`]);
}

export function dispatchFailedMarkdown({ workflow, status }) {
  const why =
    status === 403
      ? "The job's token was refused: the job that dispatches needs `actions: write`."
      : `The workflow must have a \`workflow_dispatch\` trigger declaring the inputs ${DISPATCH_INPUTS.map((i) => `\`${i}\``).join(", ")}; GitHub refuses an input the workflow does not declare.`;
  return reply([`No check was started: GitHub refused to dispatch ${workflowName(workflow)}${status ? ` (HTTP ${Number(status)})` : ""}.`, "", why]);
}

export function runNotFoundMarkdown({ workflow, workflowUrl }) {
  return reply([
    `The check ${workflowName(workflow)} was dispatched, but its run could not be found, so there is no verdict here. Its runs: ${workflowUrl}`,
    "",
    "Give the workflow a `run-name` that includes `${{ inputs.dispatch-id }}`, as the example does, so the run can be told apart.",
  ]);
}

export function timedOutMarkdown({ workflow, minutes, runUrl }) {
  return reply([
    `The check ${workflowName(workflow)} had not finished after ${Number(minutes)} minutes, so there is no verdict here. It may still finish: ${runUrl}`,
  ]);
}

export function failedToFollowMarkdown({ workflow, message }) {
  return reply([`The check ${workflowName(workflow)} could not be followed: ${inert(message, 300)}. The gate's log says more.`]);
}

// ---------------------------------------------------------------------------
// The verdict: check.json rendered as inert text.

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Why there is no verdict, in the words of the reply: what readCheckArtifact or the download step found. */
export function noVerdictReason(problem, artifact) {
  const name = codeSpan(artifact);
  const p = String(problem ?? "");
  if (p === "download-failed")
    return `the artifact ${name} could not be downloaded from it (expired, never uploaded, or under another name); this job's log says why.`;
  if (p === "too-large") return `the check.json in the artifact ${name} is larger than ${MAX_CHECK_JSON_BYTES} bytes, so it was not read.`;
  if (p.startsWith("unreadable")) return `the check.json in the artifact ${name} is not valid JSON, so there is nothing to read.`;
  if (p === "not-a-check")
    return `the check.json in the artifact ${name} is not one \`scenescout check\` wrote (no tool, gate or counts), so there is nothing to read.`;
  return `the artifact ${name} holds no check.json, so there is nothing to read. Its log says why.`;
}

/** Whether this is a check.json with a verdict to read. */
export function isCheckJson(json) {
  return Boolean(json && typeof json === "object" && json.tool === "scenescout-check" && json.gate && typeof json.gate === "object" && json.counts);
}

/** The first journey that broke, or a refused one when none broke: the step a reader opens first. Null when every journey passed. */
export function firstFailingStep(json) {
  const flows = Array.isArray(json?.flows) ? json.flows.filter((f) => f && typeof f === "object") : [];
  return flows.find((f) => f.status === "failed") ?? flows.find((f) => f.status === "refused") ?? null;
}

/**
 * The reply with the check's verdict. Everything from check.json, the
 * artifact's file names and the focus goes through inert(): the pull
 * request's code wrote the check's output, so it can say anything.
 * `recording` says what the artifact holds beside check.json: replay.html and
 * the journey videos' file names.
 */
export function checkReplyMarkdown({
  json,
  conclusion,
  workflow,
  runUrl,
  artifactUrl,
  artifact,
  ref,
  sha,
  testedSha,
  login,
  focus,
  recording = { replay: false, videos: [] },
  problem = "",
}) {
  const lines = [COMMENT_MARKER, "## SceneScout QA check", ""];
  const short = (s) =>
    String(s ?? "")
      .replace(/[^0-9a-f]/gi, "")
      .slice(0, 7);
  const tested = short(testedSha || sha);
  const moved = testedSha && sha && short(testedSha) !== short(sha) ? ` (the branch moved after the command, which saw ${short(sha)})` : "";
  const asked = login ? ` Asked for by @​${inert(login, 60)}.` : "";
  lines.push(
    `The project's own check, ${workflowName(workflow)}, run on ${codeSpan(ref)}${tested ? ` at ${tested}` : ""}${moved}.${asked}`,
    ...(focus ? ["", `Focus passed to the workflow: ${inert(focus, 200)}`] : []),
    "",
  );
  const links = [`The run: ${runUrl}`, ...(artifactUrl ? [`The artifact (${codeSpan(artifact)}): ${artifactUrl}`] : [])];
  if (!isCheckJson(json)) {
    lines.push(`**No verdict.** The run ended ${inert(conclusion || "unknown", 40)}, and ${noVerdictReason(problem, artifact)}`, "", ...links, "");
    return lines.join("\n");
  }
  const g = json.gate;
  const c = json.counts;
  const failing = n(g.failing);
  const couldNotRun = n(g.couldNotRun);
  const verdict =
    g.passed === true && couldNotRun === 0
      ? "**Passed.**"
      : g.passed === true
        ? `**Partly ran.** Nothing that ran failed the gate, but ${couldNotRun} journey(s) could not run.`
        : `**Failed.** ${failing} issue(s) fail the gate (fail-on: ${inert(g.failOn, 10)})${couldNotRun ? `, and ${couldNotRun} journey(s) could not run` : ""}.`;
  const total = n(c.high) + n(c.medium) + n(c.low);
  const worth = Array.isArray(json.worthALook) ? json.worthALook.length : 0;
  lines.push(
    verdict,
    "",
    "| | |",
    "|---|---|",
    `| Findings | ${total} (${n(c.high)} high, ${n(c.medium)} medium, ${n(c.low)} low)${worth ? `, ${worth} worth a look` : ""} |`,
    `| Run | ${inert(conclusion || "unknown", 40)} |`,
    "",
  );

  const flows = (Array.isArray(json.flows) ? json.flows : []).filter((f) => f && typeof f === "object");
  if (flows.length > 0) {
    lines.push("### Journeys", "", "| Journey | Role | Result |", "|---|---|---|");
    for (const f of flows.slice(0, MAX_ROWS)) {
      const result =
        f.status === "passed"
          ? "passed"
          : f.status === "refused"
            ? `could not run (step ${n(f.step)} was refused)`
            : f.status === "failed"
              ? `failed at step ${n(f.step)}`
              : inert(f.status, 20);
      lines.push(`| ${inert(f.name, 100)} | ${f.role ? inert(f.role, 40) : "—"} | ${result} |`);
    }
    if (flows.length > MAX_ROWS) lines.push("", `… and ${flows.length - MAX_ROWS} more in the artifact.`);
    lines.push("");
  }
  const first = firstFailingStep(json);
  if (first)
    lines.push(
      `**First failing step:** ${inert(first.name, 100)}, step ${n(first.step)}: ${inert(first.did, 160)}. ${inert(first.reason, 300)}${first.path ? ` (on ${inert(first.path, 100)})` : ""}`,
      "",
    );

  const issues = (Array.isArray(json.issues) ? json.issues : [])
    .filter((i) => i && typeof i === "object")
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
  if (issues.length > 0) {
    lines.push("### Findings", "", "| Severity | Rule | Evidence | Page |", "|---|---|---|---|");
    for (const i of issues.slice(0, MAX_ROWS))
      lines.push(`| ${inert(i.severity, 10)} | ${inert(i.rule, 40)} | ${inert(i.evidence)} | ${inert(Array.isArray(i.routes) ? i.routes[0] : "", 100)} |`);
    if (issues.length > MAX_ROWS) lines.push("", `… and ${issues.length - MAX_ROWS} more in the artifact's report.md.`);
    lines.push("");
  }

  const videos = Array.isArray(recording.videos) ? recording.videos : [];
  if (recording.replay || videos.length > 0) {
    const parts = [];
    if (recording.replay) parts.push("`replay.html`, every journey step by step with the page after each step");
    if (videos.length > 0)
      parts.push(`${videos.length} journey video(s) in \`replay-videos/\`${recording.replay ? ", each played beside its journey on the page" : ""}`);
    lines.push(`**Recorded.** The artifact holds ${parts.join(", and ")}. Download it and open the page from the unzipped folder.`, "");
    if (videos.length > 0) {
      lines.push(...videos.slice(0, MAX_ROWS).map((v) => `- ${inert(v, 120)}`));
      if (videos.length > MAX_ROWS) lines.push(`- … and ${videos.length - MAX_ROWS} more`);
      lines.push("");
    }
  }
  lines.push(...links, "");
  return lines.join("\n");
}

/**
 * What a downloaded artifact holds: check.json (parsed, or null, with
 * `problem` saying why there is no verdict to read: missing, too-large,
 * unreadable, not-a-check; empty when there is one), whether a
 * replay.html is beside it, and the journey videos' file names. Only regular
 * files are read, check.json only up to MAX_CHECK_JSON_BYTES, and nothing in
 * the artifact is run.
 */
export function readCheckArtifact(dir, { log = () => {} } = {}) {
  const out = { json: null, problem: "missing", recording: { replay: false, videos: [] } };
  if (!dir) return out;
  const file = (p) => {
    try {
      const st = fs.lstatSync(p);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  };
  const jsonPath = path.join(dir, "check.json");
  const st = file(jsonPath);
  if (st && st.size <= MAX_CHECK_JSON_BYTES) {
    try {
      out.json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      out.problem = isCheckJson(out.json) ? "" : "not-a-check";
    } catch (err) {
      out.problem = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (st) out.problem = "too-large";
  if (out.problem && out.problem !== "missing") log(`::warning title=SceneScout QA check::${escapeAnnotation(`check.json gave no verdict: ${out.problem}`)}`);
  out.recording.replay = Boolean(file(path.join(dir, "replay.html")));
  const videosDir = path.join(dir, "replay-videos");
  try {
    if (fs.lstatSync(videosDir).isDirectory())
      out.recording.videos = fs
        .readdirSync(videosDir)
        .filter((name) => /\.webm$/i.test(name) && file(path.join(videosDir, name)))
        .sort();
  } catch {
    // No videos folder: the run recorded none.
  }
  return out;
}

// ---------------------------------------------------------------------------
// The stages.

function repoOf(env) {
  const repo = String(env.GITHUB_REPOSITORY ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPOSITORY is not owner/name: "${repo}"`);
  return repo;
}

const serverOf = (env) => String(env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");

/**
 * The dispatch stage. Dispatches the workflow on the head branch, finds its
 * run, and waits for it to complete or for the wait to run out. Anything that
 * ends it without a run to read is replied to here; otherwise it sets
 * download=true and the run's id for the steps that download the artifact and
 * reply. Returns the outputs it set.
 */
export async function runDispatch({
  env = process.env,
  inputs = inputsFromEnv(),
  fetchImpl = fetch,
  log = console.log,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 15_000,
} = {}) {
  const repo = repoOf(env);
  const server = serverOf(env);
  const workflow = checkWorkflowId(inputs["check-workflow"]);
  if (!workflow) throw new Error(`check-workflow is not a workflow file name or id: "${inputs["check-workflow"] ?? ""}"`);
  const pr = Number(inputs.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`the pr input is not a pull request number: "${inputs.pr}"`);
  const ref = String(inputs.ref ?? "").trim();
  if (!ref) throw new Error("the ref input is empty: the gate names the pull request's head branch");
  const sha = String(inputs.sha ?? "").trim();
  const artifact = checkArtifactName(inputs["artifact-name"]);
  const minutes = waitMinutes(inputs["wait-minutes"]);
  const runId = String(env.GITHUB_RUN_ID ?? "").replace(/\D/g, "");
  const dispatchId = `scenescout-${runId || now()}-${String(env.GITHUB_RUN_ATTEMPT ?? "1").replace(/\D/g, "") || "1"}`;
  const call = githubClient({ token: inputs["github-token"], apiUrl: env.GITHUB_API_URL, fetchImpl });
  const wf = encodeURIComponent(workflow);
  const workflowUrl = `${server}/${repo}/actions/workflows/${wf}`;

  const done = async (body) => {
    await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    const outputs = { download: "false", replied: "true", "run-id": "", conclusion: "", "head-sha": "", artifact, "dispatch-id": dispatchId };
    setOutputs(outputs);
    return outputs;
  };

  let found;
  try {
    found = await call("GET", `/repos/${repo}/actions/workflows/${wf}`);
  } catch (err) {
    if (err?.status === 404) return done(unknownWorkflowMarkdown({ workflow }));
    throw err;
  }
  if (found?.state && found.state !== "active") return done(disabledWorkflowMarkdown({ workflow, state: found.state }));

  const since = now();
  let dispatched;
  try {
    dispatched = await call("POST", `/repos/${repo}/actions/workflows/${wf}/dispatches`, {
      ref,
      inputs: { pr: String(pr), focus: String(inputs.focus ?? ""), "dispatch-id": dispatchId },
      // Without it, the 2022-11-28 API answers 204 with no run id, and the run must be searched for.
      return_run_details: true,
    });
  } catch (err) {
    if (err?.status >= 400 && err?.status < 500) {
      log(`::error title=SceneScout QA check::${escapeAnnotation(`dispatching ${workflow} on ${ref} was refused: ${err.message}`)}`);
      return done(dispatchFailedMarkdown({ workflow, status: err.status }));
    }
    throw err;
  }
  log(`Dispatched ${workflow} on ${ref} (dispatch id ${dispatchId}).`);

  const deadline = since + minutes * 60_000;
  let id = Number(dispatched?.workflow_run_id) || 0;
  // Without the id in the answer, look for the run: it appears within seconds of the dispatch.
  const lookUntil = Math.min(deadline, since + 3 * 60_000);
  while (!id && now() < lookUntil) {
    await sleep(Math.min(pollMs, 5_000));
    const list = await call(
      "GET",
      `/repos/${repo}/actions/workflows/${wf}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&created=${encodeURIComponent(`>=${new Date(since - 60_000).toISOString()}`)}&per_page=30`,
    );
    id = Number(findDispatchedRun(list?.workflow_runs, { dispatchId, sha, since })?.id) || 0;
  }
  if (!id) return done(runNotFoundMarkdown({ workflow, workflowUrl }));
  const runUrl = `${server}/${repo}/actions/runs/${id}`;
  log(`Following ${runUrl}.`);

  for (;;) {
    const run = await call("GET", `/repos/${repo}/actions/runs/${id}`);
    if (run?.status === "completed") {
      const outputs = {
        download: "true",
        replied: "false",
        "run-id": String(id),
        conclusion: String(run.conclusion ?? ""),
        "head-sha": String(run.head_sha ?? ""),
        artifact,
        "dispatch-id": dispatchId,
      };
      setOutputs(outputs);
      return outputs;
    }
    if (now() >= deadline) return done(timedOutMarkdown({ workflow, minutes, runUrl }));
    await sleep(pollMs);
  }
}

/** The reply stage: reads the downloaded artifact and posts the verdict. Returns the comment it posted. */
export async function runReply({ env = process.env, inputs = inputsFromEnv(), fetchImpl = fetch, log = console.log } = {}) {
  const repo = repoOf(env);
  const server = serverOf(env);
  const pr = Number(inputs.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`the pr input is not a pull request number: "${inputs.pr}"`);
  const dispatch = JSON.parse(String(env.DISPATCH || "{}"));
  const runId = String(dispatch["run-id"] ?? "");
  if (!/^\d{1,20}$/.test(runId)) throw new Error(`the dispatch stage named no run: "${runId}"`);
  const workflow = checkWorkflowId(inputs["check-workflow"]);
  const artifact = checkArtifactName(dispatch.artifact ?? inputs["artifact-name"]);
  const call = githubClient({ token: inputs["github-token"], apiUrl: env.GITHUB_API_URL, fetchImpl });
  const read = readCheckArtifact(String(env.RESULTS ?? ""), { log });
  const { json, recording } = read;
  // The download step runs with continue-on-error: a failure there is not the project's missing check.json.
  const downloadFailed = String(env.DOWNLOAD ?? "") === "failure";
  if (downloadFailed) log(`::warning title=SceneScout QA check::${escapeAnnotation(`the artifact ${artifact} could not be downloaded from run ${runId}`)}`);
  let artifactUrl = "";
  try {
    const listed = await call("GET", `/repos/${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifact)}`);
    const aid = listed?.artifacts?.[0]?.id;
    if (aid) artifactUrl = `${server}/${repo}/actions/runs/${runId}/artifacts/${Number(aid)}`;
  } catch (err) {
    log(`The artifact could not be linked: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = checkReplyMarkdown({
    json,
    conclusion: dispatch.conclusion,
    workflow,
    runUrl: `${server}/${repo}/actions/runs/${runId}`,
    artifactUrl,
    artifact,
    ref: inputs.ref,
    sha: inputs.sha,
    testedSha: dispatch["head-sha"],
    login: inputs.login,
    focus: inputs.focus,
    recording,
    problem: downloadFailed ? "download-failed" : read.problem,
  });
  await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const stages = { dispatch: runDispatch, reply: runReply };
  const stage = stages[process.argv[2]];
  try {
    if (!stage) throw new Error(`unknown stage "${process.argv[2] ?? ""}": use dispatch or reply`);
    await stage();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`::error title=SceneScout QA check::${escapeAnnotation(message)}`);
    // The commenter saw 👀; say that the check could not be followed rather than leave them waiting.
    try {
      const env = process.env;
      const inputs = inputsFromEnv();
      const pr = Number(inputs.pr);
      if (Number.isInteger(pr) && pr > 0)
        await githubClient({ token: inputs["github-token"], apiUrl: env.GITHUB_API_URL })("POST", `/repos/${repoOf(env)}/issues/${pr}/comments`, {
          body: failedToFollowMarkdown({ workflow: inputs["check-workflow"], message }),
        });
    } catch (replyErr) {
      console.log(
        `::error title=SceneScout QA check::${escapeAnnotation(`the failure could not be posted: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)}`,
      );
    }
    process.exit(2);
  }
}
