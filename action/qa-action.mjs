#!/usr/bin/env node
/**
 * The logic behind the GitHub Action in qa/action.yml, which turns a
 * `/scenescout qa` comment on a pull request into a `scenescout ci` run against
 * that pull request's preview deployment, and the run's results into a reply.
 * How it is used, and the workflow it belongs in: docs/ci.md. Why it is shaped
 * this way: docs/adr/0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md.
 *
 *   node qa-action.mjs gate     decide whether this comment starts a run (no key, no checkout)
 *   node qa-action.mjs shots    put a show or compare run's pictures on the image branch (no key)
 *   node qa-action.mjs report   post the run's results on the pull request (no key)
 *
 * `/scenescout qa check [focus]` takes another path after the gate: the
 * check job dispatches the project's own workflow and replies with its
 * verdict (qa-check.mjs). No model key is involved in that mode.
 *
 * No stage ever sees a model's API key, checks out the repository or runs
 * any of the pull request's code. They read the event payload, call the
 * GitHub REST API with the job's token (and, in the gate, read team
 * membership with the separate team token when a project allows teams), and,
 * for the shots and the report, read the run's artifact.
 * The pure rules are exported and table-tested by qa-test.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { escapeAnnotation, inputsFromEnv, setOutputs } from "./check-action.mjs";

/** The command, as the first line of a comment. */
export const QA_COMMAND = "/scenescout qa";
/** A focus longer than this is cut: it becomes part of the model's prompt. */
export const MAX_FOCUS = 200;
/** Every comment this action posts starts with this, so they can be found. */
export const COMMENT_MARKER = "<!-- scenescout-qa -->";
/** Findings listed in the reply; the rest are in the report. */
export const MAX_LISTED = 20;

/** The words that turn a run into a picture of one element: `show` it, or `compare` it with the base. */
export const CAPTURE_KINDS = ["show", "compare"];
/** The word that runs the project's own recorded check instead of a model: `/scenescout qa check [focus]`. */
export const CHECK_WORD = "check";

/**
 * Reads a comment. Null when it is not the command: only the first line
 * counts, the comment must begin with the command, and the command must end
 * there or at a space (`/scenescout qab` is not it). What follows is an
 * optional preview URL (the first word, when it starts with http:// or
 * https://) and an optional focus: the rest, on one line, cut to MAX_FOCUS
 * characters. When the rest begins with `show` or `compare` (any case, a word
 * of its own), it is not a focus but an element to capture, and `capture`
 * holds the kind and the words that describe the element. When the words
 * after the command begin with `check` (no URL before it), `check.focus`
 * holds the rest: the project's own check runs instead of a model.
 *
 * The command is matched as the workflow's job filter matches it, so the two
 * never disagree: `startsWith(github.event.comment.body, '/scenescout qa')`
 * ignores case and does not skip leading whitespace, and neither does this.
 */
export function parseQaCommand(body) {
  const first = String(body ?? "").split(/\r?\n/)[0] ?? "";
  if (first.slice(0, QA_COMMAND.length).toLowerCase() !== QA_COMMAND) return null;
  const rest = first.slice(QA_COMMAND.length).trimEnd();
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const words = rest.trim().split(/\s+/).filter(Boolean);
  let url = "";
  if (words.length > 0 && /^https?:\/\//i.test(words[0])) url = words.shift();
  // Control characters out: the focus, and an element's description, are sent to the model as a line of its prompt.
  const clean = (ws) =>
    ws
      .join(" ")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, MAX_FOCUS)
      .trim();
  const kind = String(words[0] ?? "").toLowerCase();
  // `check` as the first word, with no URL before it: the project's own check, with the rest as the focus passed to it.
  if (kind === CHECK_WORD && !url) return { url: "", focus: "", check: { focus: clean(words.slice(1)) } };
  if (CAPTURE_KINDS.includes(kind)) return { url, focus: "", capture: { kind, what: clean(words.slice(1)) } };
  return { url, focus: clean(words) };
}

/**
 * The author associations a project may allow by role. GitHub's other values
 * (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE) describe
 * people with no standing in the repository, so they are refused as
 * configuration rather than accepted.
 */
export const ALLOWED_ROLES = ["OWNER", "MEMBER", "COLLABORATOR"];

const words = (text) =>
  String(text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Who may start a run, from three lists that combine as a union: logins
 * (`configured`: separated by commas, spaces or new lines, a leading @
 * allowed), author associations (`roles`: OWNER, MEMBER, COLLABORATOR) and
 * organization teams (`teams`: `org/team-slug`). With all three empty, the
 * repository's owners: the owner's login for a repository a user owns, and any
 * commenter GitHub marks with the author association OWNER, which on a
 * repository an organization owns is an owner of that organization (the
 * organization's own login never comments). Any list set replaces that
 * default. Logins and teams are compared without case, as GitHub compares them.
 *
 * A role outside ALLOWED_ROLES or a team that is not `org/team-slug` throws:
 * a list that cannot be read is never half-applied. A team in an organization
 * other than the repository's owner is kept apart in `otherOrgTeams`: it is
 * never looked up, so the team token is only ever sent about the repository's
 * own organization, and the gate says so when it refuses.
 */
export function allowlist(configured, owner, { roles: configuredRoles = "", teams: configuredTeams = "" } = {}) {
  const logins = [
    ...new Set(
      words(configured)
        .map((s) => s.replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
  const roleWords = words(configuredRoles).map((s) => s.toUpperCase());
  const unknown = roleWords.filter((r) => !ALLOWED_ROLES.includes(r));
  if (unknown.length > 0)
    throw new Error(
      `SCENESCOUT_QA_ALLOWED_ROLES has ${unknown.map((r) => `"${r}"`).join(", ")}; the roles that may be allowed are ${ALLOWED_ROLES.join(", ")}`,
    );
  const roles = [...new Set(roleWords)];
  const o = String(owner ?? "")
    .trim()
    .toLowerCase();
  const teams = [];
  const otherOrgTeams = [];
  for (const t of words(configuredTeams)) {
    const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/([a-z0-9][a-z0-9_-]*)$/i.exec(t);
    if (!m) throw new Error(`SCENESCOUT_QA_ALLOWED_TEAMS has "${t}", which is not org/team-slug`);
    const team = { org: m[1].toLowerCase(), slug: m[2].toLowerCase() };
    const key = `${team.org}/${team.slug}`;
    if (team.org !== o) {
      if (!otherOrgTeams.includes(key)) otherOrgTeams.push(key);
    } else if (!teams.some((x) => x.org === team.org && x.slug === team.slug)) teams.push(team);
  }
  if (logins.length === 0 && roles.length === 0 && teams.length === 0 && otherOrgTeams.length === 0)
    return { logins: o ? [o] : [], roles: ["OWNER"], teams: [], otherOrgTeams: [], owners: true };
  return { logins, roles, teams, otherOrgTeams, owners: false };
}

/** Whether the event payload alone allows the commenter: a listed login or an allowed association. Teams need the API: teamMembership. */
export function isAllowed(login, association, allowed) {
  const l = String(login ?? "")
    .trim()
    .toLowerCase();
  if (l === "") return false;
  if (allowed.logins.includes(l)) return true;
  return (allowed.roles ?? []).includes(String(association ?? ""));
}

/**
 * Whether the commenter is an active member of one of the allowed teams, read
 * with GET /orgs/{org}/teams/{team_slug}/memberships/{username}. `call` is a
 * GitHub client holding the team token, or null when none was given. Every
 * way the answer cannot be confirmed refuses: no token, a team in another
 * organization, a 401, 403 or 404, a pending invitation, a failed call. Nothing
 * falls back to allowing. `notes` says why each team did not allow, as
 * annotations for the job's log: an error where the setup needs fixing, a
 * notice where the commenter is simply not a member.
 */
export async function teamMembership(call, allowed, login) {
  const notes = [];
  const teams = allowed.teams ?? [];
  for (const t of allowed.otherOrgTeams ?? [])
    notes.push({ level: "error", text: `${t} is not a team of this repository's organization, so its membership is not read` });
  if (teams.length === 0) return { member: false, team: "", notes };
  if (!call) {
    notes.push({
      level: "error",
      text: `SCENESCOUT_QA_ALLOWED_TEAMS is set but the gate has no team-token (a GitHub App token or a personal access token with read:org), so team membership cannot be read and no one is allowed by team`,
    });
    return { member: false, team: "", notes };
  }
  const user = String(login ?? "").trim();
  if (!user) return { member: false, team: "", notes };
  for (const t of teams) {
    const name = `${t.org}/${t.slug}`;
    try {
      const m = await call("GET", `/orgs/${encodeURIComponent(t.org)}/teams/${encodeURIComponent(t.slug)}/memberships/${encodeURIComponent(user)}`);
      if (m?.state === "active") return { member: true, team: name, notes };
      notes.push({ level: "notice", text: `@${user}'s membership of ${name} is ${m?.state ? `"${m.state}"` : "unknown"}, not active` });
    } catch (err) {
      const status = err?.status;
      if (status === 404) notes.push({ level: "notice", text: `@${user} is not a member of ${name}, or the team-token cannot see that team (HTTP 404)` });
      else if (status === 401 || status === 403)
        notes.push({
          level: "error",
          text: `the team-token was refused reading ${name} (HTTP ${status}); it needs read:org on the organization, and a 403 can also be a rate limit`,
        });
      else notes.push({ level: "error", text: `${name}'s membership could not be read: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { member: false, team: "", notes };
}

/**
 * Whether a pull request comes from a fork: its head is in another
 * repository, or in one that no longer exists (a deleted fork leaves
 * `head.repo` null). A pull request whose repositories cannot be read is
 * treated as a fork, so an unexpected payload is refused rather than run.
 */
export function isFork(pr) {
  const head = pr?.head?.repo?.full_name;
  const base = pr?.base?.repo?.full_name;
  if (typeof head !== "string" || typeof base !== "string" || !head || !base) return true;
  return head.toLowerCase() !== base.toLowerCase();
}

/** A preview URL the run may be pointed at: https only, with no credentials in it. The base URL of a comparison is held to the same, named as `name`. */
export function checkPreviewUrl(raw, name = "preview URL") {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: `no ${name}` };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: `the ${name} is not a URL` };
  }
  if (u.protocol !== "https:") return { ok: false, reason: `the ${name} must be https` };
  if (u.username || u.password) return { ok: false, reason: `the ${name} must not carry credentials` };
  return { ok: true, url: u.href };
}

/** A URL from the template a project configures, e.g. https://pr-{pr}.preview.example.com. {pr} and {sha} are filled in. */
export function previewUrlFromTemplate(template, { pr, sha }) {
  const t = String(template ?? "").trim();
  if (!t) return "";
  return t.replaceAll("{pr}", String(pr)).replaceAll("{sha}", String(sha));
}

/**
 * The newest successful deployment's URL. `deployments` is the list the API
 * returns for the head commit (newest first), each with its `statuses` (newest
 * first). Only a deployment whose newest status is `success` counts: one
 * that later failed or went inactive is not a preview to test.
 */
export function deploymentUrl(deployments) {
  for (const d of deployments ?? []) {
    const newest = (d.statuses ?? [])[0];
    if (newest && newest.state === "success" && newest.environment_url) return String(newest.environment_url);
  }
  return "";
}

/**
 * Where the run goes, in order: the URL in the comment, the project's
 * template, then the newest successful deployment of the head commit.
 */
export function choosePreviewUrl({ commandUrl, template, deployment, pr, sha }) {
  if (commandUrl) return { source: "comment", url: commandUrl };
  const fromTemplate = previewUrlFromTemplate(template, { pr, sha });
  if (fromTemplate) return { source: "template", url: fromTemplate };
  if (deployment) return { source: "deployment", url: deployment };
  return { source: "none", url: "" };
}

/**
 * What a comparison compares with, in order: the URL the repository
 * configures (SCENESCOUT_QA_BASE_URL), then the newest successful deployment
 * of the pull request's base branch.
 */
export function chooseBaseUrl({ configured, deployment }) {
  const c = String(configured ?? "").trim();
  if (c) return { source: "variable", url: c };
  if (deployment) return { source: "base branch's deployment", url: deployment };
  return { source: "none", url: "" };
}

/**
 * The gate's decision, with no side effects: whether to run, the reaction to
 * put on the comment, and the reply to post (null for none). Nothing is
 * posted to a commenter who may not start a run beyond a reaction, so the
 * command cannot be used to make the bot write on a pull request.
 */
export function gateDecision({
  command,
  login,
  association,
  allowed,
  teamMember = false,
  pr,
  allowForks,
  preview,
  base = { source: "none", url: "" },
  checkWorkflow = "",
}) {
  if (!command) return { run: false, reason: "not the command", reaction: null, reply: null };
  if (!teamMember && !isAllowed(login, association, allowed))
    return { run: false, reason: `@${login} is not in the list of accounts that may start a QA run`, reaction: "confused", reply: null };
  if (!pr || pr.state !== "open")
    return { run: false, reason: "the pull request is not open", reaction: "confused", reply: "The pull request is not open, so no QA run was started." };
  if (command.check) return checkDecision({ pr, checkWorkflow });
  if (isFork(pr) && !allowForks)
    return {
      run: false,
      reason: "the pull request comes from a fork",
      reaction: "confused",
      reply: [
        "No QA run was started: this pull request comes from a fork.",
        "",
        "A QA run sends the preview's pages to a model with this repository's API key, and a fork's pages are text written by someone outside the repository. " +
          "Runs on forks are off unless the repository sets the variable `SCENESCOUT_QA_ALLOW_FORKS` to `true`.",
      ].join("\n"),
    };
  if (preview.source === "none")
    return {
      run: false,
      reason: "no preview URL",
      reaction: "confused",
      reply: [
        "No QA run was started: there is no preview of this pull request to test.",
        "",
        "A QA run tests a deployed preview and never builds the pull request itself. Give the URL in the comment (`/scenescout qa https://…`), " +
          "set the variable `SCENESCOUT_QA_PREVIEW_URL` to a template such as `https://pr-{pr}.preview.example.com`, or deploy the head commit with a deployment status that carries its URL.",
      ].join("\n"),
    };
  const checked = checkPreviewUrl(preview.url);
  if (!checked.ok)
    return { run: false, reason: checked.reason, reaction: "confused", reply: `No QA run was started: ${checked.reason} (from the ${preview.source}).` };
  const capture = command.capture;
  if (capture && !capture.what)
    return {
      run: false,
      reason: `nothing to ${capture.kind}`,
      reaction: "confused",
      reply: `No QA run was started: say which element to ${capture.kind}, e.g. \`/scenescout qa ${capture.kind} the Save button\`.`,
    };
  if (capture?.kind === "compare") {
    if (base.source === "none")
      return {
        run: false,
        reason: "no base URL to compare with",
        reaction: "confused",
        reply: [
          "No QA run was started: there is nothing to compare this pull request's preview with.",
          "",
          "A comparison captures the same element on a base URL. Set the variable `SCENESCOUT_QA_BASE_URL` to one (the production site, say), " +
            "or deploy the base branch with a deployment status that carries its URL.",
        ].join("\n"),
      };
    const checkedBase = checkPreviewUrl(base.url, "base URL");
    if (!checkedBase.ok)
      return { run: false, reason: checkedBase.reason, reaction: "confused", reply: `No QA run was started: ${checkedBase.reason} (from the ${base.source}).` };
    return { run: true, reason: "ok", reaction: "eyes", reply: null, url: checked.url, show: capture.what, base: checkedBase.url };
  }
  return { run: true, reason: "ok", reaction: "eyes", reply: null, url: checked.url, show: capture?.what ?? "", base: "" };
}

/**
 * A workflow the check may dispatch: a file name in .github/workflows
 * (`browser-tests.yml`) or a workflow's numeric id. No path, so it can only
 * name one of the repository's own workflows. Empty when it is not one.
 */
export function checkWorkflowId(raw) {
  const s = String(raw ?? "").trim();
  if (/^\d{1,20}$/.test(s)) return s;
  if (/^[A-Za-z0-9][\w.-]*\.ya?ml$/.test(s) && !s.includes("..")) return s;
  return "";
}

/**
 * The gate's decision for `/scenescout qa check`, once the commenter is
 * allowed and the pull request is open. `run` stays false, because no model
 * runs; `check` is true when the check job may dispatch the project's
 * workflow. A fork is always refused here, SCENESCOUT_QA_ALLOW_FORKS or not:
 * the dispatch runs the workflow on the head branch with the repository's
 * secrets, and a fork's branch is not in the repository to dispatch on.
 */
export function checkDecision({ pr, checkWorkflow }) {
  const configured = String(checkWorkflow ?? "").trim();
  if (!configured)
    return {
      run: false,
      check: false,
      reason: "no check workflow is configured",
      reaction: "confused",
      reply: [
        "No check was started: this repository has not set up `/scenescout qa check`.",
        "",
        "It runs the project's own workflow and replies with its verdict. Set the repository variable `SCENESCOUT_QA_CHECK_WORKFLOW` to that workflow's file name (e.g. `browser-tests.yml`). " +
          "The workflow needs a `workflow_dispatch` trigger with the inputs `pr`, `focus` and `dispatch-id`, and must upload its `scenescout check` output folder as an artifact; " +
          "`examples/workflows/scenescout-qa-check.yml` in the SceneScout repository is one.",
      ].join("\n"),
    };
  const workflow = checkWorkflowId(configured);
  if (!workflow)
    return {
      run: false,
      check: false,
      reason: "SCENESCOUT_QA_CHECK_WORKFLOW is not a workflow file name",
      reaction: "confused",
      reply:
        "No check was started: `SCENESCOUT_QA_CHECK_WORKFLOW` must be a workflow's file name in `.github/workflows/`, such as `browser-tests.yml`, or its numeric id.",
    };
  if (isFork(pr))
    return {
      run: false,
      check: false,
      reason: "the pull request comes from a fork",
      reaction: "confused",
      reply: [
        "No check was started: this pull request comes from a fork.",
        "",
        "`/scenescout qa check` runs this repository's workflow on the pull request's branch, with the repository's secrets, and a fork's branch is not in this repository. " +
          "`SCENESCOUT_QA_ALLOW_FORKS` does not change that.",
      ].join("\n"),
    };
  const ref = String(pr.head?.ref ?? "").trim();
  if (!ref)
    return {
      run: false,
      check: false,
      reason: "the pull request's head branch is unknown",
      reaction: "confused",
      reply: "No check was started: the pull request's head branch could not be read.",
    };
  return { run: false, check: true, reason: "ok", reaction: "eyes", reply: null, workflow, ref };
}

// ---------------------------------------------------------------------------
// The reply: ci.json rendered as inert text.

/**
 * Text from ci.json as inert Markdown. Finding titles and paths are written
 * by a model that read the preview's pages, so they can say anything: here
 * they cannot mention anyone, link anywhere, embed an image, add HTML or
 * break the table. One line, cut to `max` characters.
 */
export function inert(text, max = 160) {
  let s = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+!|~])/g, "\\$1")
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":\u200b//")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\u200b.`);
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// Pictures: a show or compare run's PNGs, on a branch only the shots job writes.

/** The branch the pictures go on, one folder per workflow run. Fixed: no input names it. */
export const SHOTS_BRANCH = "scenescout-shots";
/** The only files ever pushed, by the only names they may have. The ci run writes them under shots/ in its output. */
export const SHOT_NAMES = ["preview.png", "base.png", "diff.png"];
/** A picture larger than this is left out: an element's capture is far smaller. */
export const MAX_SHOT_BYTES = 5_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The environment variables that hold a model's key. The shots stage refuses to run where one is set. */
export const KEY_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/**
 * The pictures to push from a downloaded artifact: each of SHOT_NAMES that is
 * there, is a PNG and is not too large. Nothing else in the artifact is read.
 */
export function shotsToPush(dir, { exists = fs.existsSync, read = fs.readFileSync } = {}) {
  const out = [];
  for (const name of SHOT_NAMES) {
    const file = path.join(String(dir), "shots", name);
    if (!exists(file)) continue;
    const bytes = read(file);
    if (bytes.length > MAX_SHOT_BYTES || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) continue;
    out.push({ name, bytes });
  }
  return out;
}

/** A workflow run's id: digits only, as it goes into a path and a URL. */
function runIdOf(raw) {
  const id = String(raw ?? "").trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error(`GITHUB_RUN_ID is not a run id: "${id}"`);
  return id;
}

/**
 * Where a pushed picture is served from, built from the server, the
 * repository, the run's id and a name from SHOT_NAMES and nothing else. These
 * are the only images the reply ever renders.
 */
export function shotUrl({ server, repo, runId, name }) {
  const s = String(server ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(s)) throw new Error(`GITHUB_SERVER_URL is not an https origin: "${server}"`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error(`not owner/name: "${repo}"`);
  if (!SHOT_NAMES.includes(name)) throw new Error(`not a picture this workflow writes: "${name}"`);
  return `${s}/${repo}/raw/${SHOTS_BRANCH}/${runIdOf(runId)}/${name}`;
}

/** The pictures the shots job pushed, from its output: names in SHOT_NAMES, and nothing else. */
export function pushedShots(raw) {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .filter((n) => SHOT_NAMES.includes(n));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The pictures part of the reply. Every image is one of `images` (URLs the
 * workflow built with shotUrl); every word from ci.json goes through inert().
 */
export function captureMarkdown(capture, images) {
  const lines = [];
  const kind = capture.base || capture.diff ? "Compared" : "Shown";
  lines.push(`### ${kind}: ${inert(capture.what, 200)}`, "");
  if (capture.status !== "captured") {
    lines.push(
      `Nothing was captured${capture.detail ? `: ${inert(capture.detail, 300)}` : "."} Only what a page shows when it is opened by its URL can be captured, and the element must be one a snapshot lists (a control, a link, a field).`,
      "",
    );
    return lines;
  }
  const img = (name, alt) => (images[name] ? `![${alt}](${images[name]})` : "");
  if (capture.base && images["base.png"] && images["preview.png"])
    lines.push("| Base | This pull request |", "|---|---|", `| ${img("base.png", "base")} | ${img("preview.png", "this pull request")} |`, "");
  else if (images["preview.png"]) lines.push(img("preview.png", "this pull request"), "");
  if (capture.diff) {
    const d = capture.diff;
    const size =
      d.sizeChanged && capture.base && capture.preview
        ? ` The element's size changed, from ${num(capture.base.width)}×${num(capture.base.height)} to ${num(capture.preview.width)}×${num(capture.preview.height)} pixels.`
        : "";
    lines.push(
      num(d.changedPixels) === 0
        ? `No pixels changed.${size}`
        : `**${num(d.percent)}%** of pixels changed (${num(d.changedPixels)} of ${num(d.totalPixels)}), highlighted below.${size}`,
      "",
    );
    if (num(d.changedPixels) > 0 && images["diff.png"]) lines.push(img("diff.png", "changed pixels"), "");
  }
  if (capture.detail) lines.push(inert(capture.detail, 300), "");
  const missing = [capture.preview && "preview.png", capture.base && "base.png", capture.diff && "diff.png"].filter((n) => n && !images[n]);
  if (missing.length > 0) lines.push("Some pictures could not be put in this comment; all of them are in the run's artifact.", "");
  return lines;
}

/**
 * The reply posted on the pull request. `json` is ci.json, or null when the
 * run left none; `result` is the model job's result (success, failure, ...).
 */
export function qaCommentMarkdown({ json, result, runUrl, artifactUrl, url, sha, login, images = {} }) {
  const lines = [COMMENT_MARKER, "## SceneScout QA", ""];
  const target = inert(url, 300);
  // The head when the run was asked for. The preview may have been deployed from an earlier commit, so this is not a claim about what was tested.
  const short = String(sha ?? "")
    .slice(0, 7)
    .replace(/[^0-9a-f]/gi, "");
  const at = short ? ` (the pull request's head was ${short} when the run was asked for)` : "";
  const asked = login ? ` Asked for by @\u200b${inert(login, 60)}.` : "";
  if (!json || typeof json !== "object" || !json.counts || !json.stop) {
    lines.push(
      `The QA run of ${target}${at} could not run (the job ended: ${inert(result || "unknown", 40)}), so there is no report.${asked}`,
      "",
      `The job's log says why: ${runUrl}`,
      "",
    );
    return lines.join("\n");
  }
  const usage = `| Usage | ${Number(json.usage?.turns) || 0} turn(s), ${(Number(json.usage?.inputTokens) || 0) + (Number(json.usage?.outputTokens) || 0)} tokens${
    typeof json.usage?.estimatedCostUsd === "number" ? `, estimated cost $${json.usage.estimatedCostUsd.toFixed(4)}` : ""
  } |`;
  if (json.capture && typeof json.capture === "object") {
    lines.push(
      `A picture of one element of ${target}${at}, taken by a browser, not drawn by the model.${asked}`,
      "",
      ...captureMarkdown(json.capture, images),
      `| | |`,
      `|---|---|`,
      `| Ended | ${inert(json.stop.text || json.stop.reason, 200)} |`,
      usage,
      "",
      `The pictures and the run's files: ${artifactUrl || runUrl}`,
      "",
    );
    return lines.join("\n");
  }
  const c = json.counts;
  const total = (Number(c.high) || 0) + (Number(c.medium) || 0) + (Number(c.low) || 0);
  lines.push(
    `An unattended exploratory run of ${target}${at}. It reports and does not gate: two runs find different things, so read these as leads.${asked}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Findings | ${total} (${Number(c.high) || 0} high, ${Number(c.medium) || 0} medium, ${Number(c.low) || 0} low)${Number(c.worthALook) ? `, ${Number(c.worthALook)} worth a look` : ""} |`,
    `| Ended | ${inert(json.stop.text || json.stop.reason, 200)} |`,
    `| Completion contract | ${json.contractMet ? "met" : "not met (the report's gap ledger says what is missing)"} |`,
    `| Mode | ${inert(json.mode, 20)} |`,
    usage,
    "",
  );
  const findings = (Array.isArray(json.findings) ? json.findings : [])
    .filter((f) => f && f.tier !== "worth-a-look")
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
  if (findings.length > 0) {
    lines.push(`| Severity | Finding | Page |`, `|---|---|---|`);
    for (const f of findings.slice(0, MAX_LISTED)) lines.push(`| ${inert(f.severity, 10)} | ${inert(f.title)} | ${inert(f.path, 100)} |`);
    if (findings.length > MAX_LISTED) lines.push("", `… and ${findings.length - MAX_LISTED} more in the report.`);
    lines.push("");
  }
  lines.push(`The report, with repro steps and the gap ledger: ${artifactUrl || runUrl}`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub's REST API, with a timeout on every call and a retry for a failure a retry can change.

export function githubClient({ token, apiUrl, fetchImpl = fetch, timeoutMs = 15_000, retries = 2, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!token) throw new Error("no GitHub token: the github-token input is empty");
  const base = String(apiUrl || "https://api.github.com").replace(/\/+$/, "");
  return async function call(method, route, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) {
          await wait(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
          continue;
        }
        throw new Error(`${method} ${route} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status >= 500 && attempt < retries) {
        await wait(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`${method} ${route} failed: HTTP ${res.status}`), { status: res.status });
      return res.status === 204 ? null : res.json();
    }
  };
}

function repoOf(env) {
  const repo = String(env.GITHUB_REPOSITORY ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPOSITORY is not owner/name: "${repo}"`);
  return repo;
}

/** The deployments of one commit (`sha`) or branch (`ref`), each with its statuses. At most five: the newest successful one is what counts. */
async function deploymentsOf(call, repo, { sha, ref }, environment) {
  const env = environment ? `&environment=${encodeURIComponent(environment)}` : "";
  const which = sha ? `sha=${encodeURIComponent(sha)}` : `ref=${encodeURIComponent(ref)}`;
  const list = (await call("GET", `/repos/${repo}/deployments?${which}${env}&per_page=5`)) ?? [];
  const out = [];
  for (const d of list) out.push({ ...d, statuses: (await call("GET", `/repos/${repo}/deployments/${d.id}/statuses?per_page=5`)) ?? [] });
  return out;
}

/** The gate stage. Returns the outputs it set, for the test. */
export async function runGate({ env = process.env, inputs = inputsFromEnv(), fetchImpl = fetch, log = console.log } = {}) {
  const repo = repoOf(env);
  const event = JSON.parse(fs.readFileSync(String(env.GITHUB_EVENT_PATH ?? ""), "utf8"));
  const none = { run: "false", pr: "", sha: "", url: "", focus: "", login: "", show: "", base: "", check: "false", ref: "", "check-workflow": "" };
  if (!event.issue?.pull_request || event.action !== "created") {
    log("Not a new comment on a pull request; nothing to do.");
    setOutputs(none);
    return none;
  }
  const command = parseQaCommand(event.comment?.body);
  const login = String(event.comment?.user?.login ?? "");
  const association = String(event.comment?.author_association ?? "");
  const allowed = allowlist(inputs.allowed, event.repository?.owner?.login ?? repo.split("/")[0], {
    roles: inputs["allowed-roles"],
    teams: inputs["allowed-teams"],
  });
  const call = githubClient({ token: inputs["github-token"], apiUrl: env.GITHUB_API_URL, fetchImpl });
  const number = Number(event.issue.number);
  // Teams are looked up only for the command, and only when the payload has not already allowed the commenter.
  let teamMember = false;
  if (command && !isAllowed(login, association, allowed)) {
    const teamToken = String(inputs["team-token"] ?? "").trim();
    const teamCall = teamToken ? githubClient({ token: teamToken, apiUrl: env.GITHUB_API_URL, fetchImpl }) : null;
    const membership = await teamMembership(teamCall, allowed, login);
    for (const n of membership.notes) log(`::${n.level} title=SceneScout QA::${escapeAnnotation(n.text)}`);
    teamMember = membership.member;
    if (teamMember) log(`@${login} is an active member of ${membership.team}.`);
  }
  // The pull request is read only for a command from an allowed account: anything else is decided without it.
  const pr = command && (teamMember || isAllowed(login, association, allowed)) ? await call("GET", `/repos/${repo}/pulls/${number}`) : null;
  let preview = { source: "none", url: "" };
  let base = { source: "none", url: "" };
  if (pr && !command.check) {
    const sha = String(pr.head?.sha ?? "");
    const needsDeployment = !command.url && !previewUrlFromTemplate(inputs["preview-url"], { pr: number, sha });
    const deployment = needsDeployment && sha ? deploymentUrl(await deploymentsOf(call, repo, { sha }, String(inputs.environment ?? "").trim())) : "";
    preview = choosePreviewUrl({ commandUrl: command.url, template: inputs["preview-url"], deployment, pr: number, sha });
    if (command.capture?.kind === "compare") {
      const baseRef = String(pr.base?.ref ?? "");
      const configured = String(inputs["base-url"] ?? "").trim();
      const baseDeployment = !configured && baseRef ? deploymentUrl(await deploymentsOf(call, repo, { ref: baseRef }, "")) : "";
      base = chooseBaseUrl({ configured, deployment: baseDeployment });
    }
  }
  const decision = gateDecision({
    command,
    login,
    association,
    allowed,
    teamMember,
    pr,
    allowForks: String(inputs["allow-forks"]).trim() === "true",
    preview,
    base,
    checkWorkflow: inputs["check-workflow"],
  });
  log(`${decision.run ? "Starting a QA run" : decision.check ? "Starting the project's check" : "No QA run"}: ${decision.reason}.`);
  if (decision.reaction && event.comment?.id)
    await call("POST", `/repos/${repo}/issues/comments/${Number(event.comment.id)}/reactions`, { content: decision.reaction });
  if (decision.reply) await call("POST", `/repos/${repo}/issues/${number}/comments`, { body: `${COMMENT_MARKER}\n${decision.reply}\n` });
  const outputs = decision.run
    ? {
        ...none,
        run: "true",
        pr: String(number),
        sha: String(pr.head.sha),
        url: decision.url,
        focus: command.focus,
        login,
        show: decision.show,
        base: decision.base,
      }
    : decision.check
      ? {
          ...none,
          check: "true",
          pr: String(number),
          sha: String(pr.head.sha),
          focus: command.check.focus,
          login,
          ref: decision.ref,
          "check-workflow": decision.workflow,
        }
      : { ...none, pr: String(number) };
  setOutputs(outputs);
  return outputs;
}

/** The one-line reply for a run that was cancelled by hand or reached its job's timeout. */
export function cancelledMarkdown({ runUrl }) {
  return `${COMMENT_MARKER}\nThe QA run was cancelled or timed out before it wrote a report: ${runUrl}\n`;
}

/** The name of the job that holds the key, in the workflow. A newer run is one in which this job started. */
export const QA_JOB = "qa";

/**
 * Whether another run of the same workflow, for the same pull request, was
 * started after this one and got as far as the key job. That is what cancels a
 * run through the key job's concurrency group, and that run will reply. `runs`
 * are the workflow's runs with their jobs; the pull request is told apart by
 * the run's title, which the workflow's `run-name` sets to include its number.
 */
export function newerRunFor(self, runs) {
  return runs.some(
    (r) =>
      r.id !== self.id &&
      r.display_title === self.display_title &&
      Date.parse(r.created_at) > Date.parse(self.created_at) &&
      (r.jobs ?? []).some((j) => j.name === QA_JOB && j.conclusion !== "skipped"),
  );
}

async function supersededBy(call, repo, runId) {
  const self = await call("GET", `/repos/${repo}/actions/runs/${encodeURIComponent(runId)}`);
  const list = await call(
    "GET",
    `/repos/${repo}/actions/workflows/${Number(self.workflow_id)}/runs?event=issue_comment&created=${encodeURIComponent(`>=${self.created_at}`)}&per_page=20`,
  );
  const runs = [];
  for (const r of list?.workflow_runs ?? []) {
    if (r.id === self.id || r.display_title !== self.display_title) continue;
    const jobs = await call("GET", `/repos/${repo}/actions/runs/${Number(r.id)}/jobs?per_page=20`);
    runs.push({ ...r, jobs: jobs?.jobs ?? [] });
  }
  return newerRunFor(self, runs);
}

/** The report stage. Returns the comment it posted, or null when it posted none. */
export async function runReport({ env = process.env, inputs = inputsFromEnv(), fetchImpl = fetch, log = console.log } = {}) {
  const repo = repoOf(env);
  const result = String(inputs.result ?? "").trim();
  const pr = Number(inputs.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`the pr input is not a pull request number: "${inputs.pr}"`);
  const call = githubClient({ token: inputs["github-token"], apiUrl: env.GITHUB_API_URL, fetchImpl });
  const server = String(env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const runUrl = `${server}/${repo}/actions/runs/${runId}`;
  // Cancelled: by a newer command on the same pull request (that run replies), by hand, or by the job's timeout.
  if (result === "cancelled") {
    if (runId && (await supersededBy(call, repo, runId))) {
      log("A newer run on the same pull request cancelled this one; it will reply.");
      return null;
    }
    const body = cancelledMarkdown({ runUrl });
    await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    return body;
  }
  // The ci action uploads its output folder, so ci.json is at the top of the downloaded artifact.
  const jsonPath = env.RESULTS ? path.join(String(env.RESULTS), "ci.json") : "";
  let json = null;
  if (jsonPath && fs.existsSync(jsonPath)) {
    try {
      json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (err) {
      log(`ci.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let artifactUrl = "";
  const name = String(inputs["artifact-name"] ?? "").trim();
  if (json && name && runId) {
    const found = await call("GET", `/repos/${repo}/actions/runs/${encodeURIComponent(runId)}/artifacts?name=${encodeURIComponent(name)}`);
    const id = found?.artifacts?.[0]?.id;
    if (id) artifactUrl = `${server}/${repo}/actions/runs/${runId}/artifacts/${Number(id)}`;
  }
  const images = {};
  try {
    for (const name of pushedShots(inputs.shots)) images[name] = shotUrl({ server, repo, runId, name });
  } catch (err) {
    // The reply still goes out, with no pictures, saying they are in the artifact.
    for (const k of Object.keys(images)) delete images[k];
    log(`The pictures cannot be linked: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = qaCommentMarkdown({ json, result, runUrl, artifactUrl, url: inputs.url, sha: inputs.sha, login: inputs.login, images });
  await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return body;
}

const isNotFound = (err) => err instanceof Error && /HTTP 404$/.test(err.message);
const isConflict = (err) => err instanceof Error && /HTTP (409|422)$/.test(err.message);

/**
 * The shots stage: pushes the pictures of a show or compare run to
 * SHOTS_BRANCH, under the run's id, through the Git Data API. It holds no
 * model key (and refuses to run where one is set), checks nothing out and
 * runs nothing from the artifact: it reads at most three PNGs by fixed names.
 * The branch starts with no history of its own, so it never carries code. Two
 * runs pushing at once: the ref update is not forced, and the loser tries
 * again on the new tip. Returns the outputs it set.
 */
export async function runShots({ env = process.env, inputs = inputsFromEnv(), fetchImpl = fetch, log = console.log, retries = 3 } = {}) {
  const withKey = KEY_ENV_NAMES.filter((k) => String(env[k] ?? "").trim() !== "");
  if (withKey.length > 0) throw new Error(`the shots stage never runs beside a model's key, and ${withKey.join(" and ")} is set in this job`);
  const repo = repoOf(env);
  const runId = runIdOf(env.GITHUB_RUN_ID);
  const shots = shotsToPush(String(env.RESULTS ?? ""));
  if (shots.length === 0) {
    log("No pictures in the run's results; nothing to push.");
    setOutputs({ pushed: "" });
    return { pushed: "" };
  }
  const call = githubClient({ token: inputs["github-token"], apiUrl: env.GITHUB_API_URL, fetchImpl });
  const blobs = [];
  for (const s of shots)
    blobs.push({
      path: `${runId}/${s.name}`,
      mode: "100644",
      type: "blob",
      sha: (await call("POST", `/repos/${repo}/git/blobs`, { content: s.bytes.toString("base64"), encoding: "base64" })).sha,
    });
  const ref = `heads/${SHOTS_BRANCH}`;
  for (let attempt = 0; ; attempt++) {
    let parent = null;
    try {
      parent = (await call("GET", `/repos/${repo}/git/ref/${ref}`)).object.sha;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const baseTree = parent ? (await call("GET", `/repos/${repo}/git/commits/${parent}`)).tree.sha : undefined;
    const tree = await call("POST", `/repos/${repo}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: blobs });
    const commit = await call("POST", `/repos/${repo}/git/commits`, {
      message: `SceneScout QA pictures of run ${runId}`,
      tree: tree.sha,
      parents: parent ? [parent] : [],
    });
    try {
      if (parent) await call("PATCH", `/repos/${repo}/git/refs/${ref}`, { sha: commit.sha, force: false });
      else await call("POST", `/repos/${repo}/git/refs`, { ref: `refs/${ref}`, sha: commit.sha });
      break;
    } catch (err) {
      if (!isConflict(err) || attempt >= retries) throw err;
      log("The image branch moved while this run pushed; trying again on its new tip.");
    }
  }
  const pushed = shots.map((s) => s.name).join(",");
  log(`Pushed ${pushed} to ${SHOTS_BRANCH} under ${runId}/.`);
  setOutputs({ pushed });
  return { pushed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const stages = { gate: runGate, shots: runShots, report: runReport };
  const stage = stages[process.argv[2]];
  try {
    if (!stage) throw new Error(`unknown stage "${process.argv[2] ?? ""}": use gate, shots or report`);
    await stage();
  } catch (err) {
    console.log(`::error title=SceneScout QA::${escapeAnnotation(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
