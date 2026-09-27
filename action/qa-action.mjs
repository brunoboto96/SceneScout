#!/usr/bin/env node
/**
 * The logic behind the GitHub Action in qa/action.yml, which turns a
 * `/scenescout qa` comment on a pull request into a `scenescout ci` run against
 * that pull request's preview deployment, and the run's results into a reply.
 * How it is used, and the workflow it belongs in: docs/ci.md. Why it is shaped
 * this way: docs/adr/0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md.
 *
 *   node qa-action.mjs gate     decide whether this comment starts a run (no key, no checkout)
 *   node qa-action.mjs report   post the run's results on the pull request (no key)
 *
 * Neither stage ever sees a model's API key, checks out the repository or runs
 * any of the pull request's code. They read the event payload, call the
 * GitHub REST API with the job's token (and, in the gate, read team
 * membership with the separate team token when a project allows teams), and,
 * for the report, read ci.json.
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

/**
 * Reads a comment. Null when it is not the command: only the first line
 * counts, the comment must begin with the command, and the command must end
 * there or at a space (`/scenescout qab` is not it). What follows is an
 * optional preview URL (the first word, when it starts with http:// or
 * https://) and an optional focus: the rest, on one line, cut to MAX_FOCUS
 * characters.
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
  // Control characters out: the focus is sent to the model as a line of its prompt.
  const focus = words
    .join(" ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_FOCUS)
    .trim();
  return { url, focus };
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

/** A preview URL the run may be pointed at: https only, with no credentials in it. */
export function checkPreviewUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "no preview URL" };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "the preview URL is not a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "the preview URL must be https" };
  if (u.username || u.password) return { ok: false, reason: "the preview URL must not carry credentials" };
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
 * The gate's decision, with no side effects: whether to run, the reaction to
 * put on the comment, and the reply to post (null for none). Nothing is
 * posted to a commenter who may not start a run beyond a reaction, so the
 * command cannot be used to make the bot write on a pull request.
 */
export function gateDecision({ command, login, association, allowed, teamMember = false, pr, allowForks, preview }) {
  if (!command) return { run: false, reason: "not the command", reaction: null, reply: null };
  if (!teamMember && !isAllowed(login, association, allowed))
    return { run: false, reason: `@${login} is not in the list of accounts that may start a QA run`, reaction: "confused", reply: null };
  if (!pr || pr.state !== "open")
    return { run: false, reason: "the pull request is not open", reaction: "confused", reply: "The pull request is not open, so no QA run was started." };
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
  return { run: true, reason: "ok", reaction: "eyes", reply: null, url: checked.url };
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

/**
 * The reply posted on the pull request. `json` is ci.json, or null when the
 * run left none; `result` is the model job's result (success, failure, ...).
 */
export function qaCommentMarkdown({ json, result, runUrl, artifactUrl, url, sha, login }) {
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
    `| Usage | ${Number(json.usage?.turns) || 0} turn(s), ${(Number(json.usage?.inputTokens) || 0) + (Number(json.usage?.outputTokens) || 0)} tokens${
      typeof json.usage?.estimatedCostUsd === "number" ? `, estimated cost $${json.usage.estimatedCostUsd.toFixed(4)}` : ""
    } |`,
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

/** The deployments of one commit, each with its statuses. At most five: the newest successful one is what counts. */
async function deploymentsOf(call, repo, sha, environment) {
  const env = environment ? `&environment=${encodeURIComponent(environment)}` : "";
  const list = (await call("GET", `/repos/${repo}/deployments?sha=${encodeURIComponent(sha)}${env}&per_page=5`)) ?? [];
  const out = [];
  for (const d of list) out.push({ ...d, statuses: (await call("GET", `/repos/${repo}/deployments/${d.id}/statuses?per_page=5`)) ?? [] });
  return out;
}

/** The gate stage. Returns the outputs it set, for the test. */
export async function runGate({ env = process.env, inputs = inputsFromEnv(), fetchImpl = fetch, log = console.log } = {}) {
  const repo = repoOf(env);
  const event = JSON.parse(fs.readFileSync(String(env.GITHUB_EVENT_PATH ?? ""), "utf8"));
  const none = { run: "false", pr: "", sha: "", url: "", focus: "", login: "" };
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
  if (pr) {
    const sha = String(pr.head?.sha ?? "");
    const needsDeployment = !command.url && !previewUrlFromTemplate(inputs["preview-url"], { pr: number, sha });
    const deployment = needsDeployment && sha ? deploymentUrl(await deploymentsOf(call, repo, sha, String(inputs.environment ?? "").trim())) : "";
    preview = choosePreviewUrl({ commandUrl: command.url, template: inputs["preview-url"], deployment, pr: number, sha });
  }
  const decision = gateDecision({ command, login, association, allowed, teamMember, pr, allowForks: String(inputs["allow-forks"]).trim() === "true", preview });
  log(`${decision.run ? "Starting a QA run" : "No QA run"}: ${decision.reason}.`);
  if (decision.reaction && event.comment?.id)
    await call("POST", `/repos/${repo}/issues/comments/${Number(event.comment.id)}/reactions`, { content: decision.reaction });
  if (decision.reply) await call("POST", `/repos/${repo}/issues/${number}/comments`, { body: `${COMMENT_MARKER}\n${decision.reply}\n` });
  const outputs = decision.run
    ? { run: "true", pr: String(number), sha: String(pr.head.sha), url: decision.url, focus: command.focus, login }
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
  const body = qaCommentMarkdown({ json, result, runUrl, artifactUrl, url: inputs.url, sha: inputs.sha, login: inputs.login });
  await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const stages = { gate: runGate, report: runReport };
  const stage = stages[process.argv[2]];
  try {
    if (!stage) throw new Error(`unknown stage "${process.argv[2] ?? ""}": use gate or report`);
    await stage();
  } catch (err) {
    console.log(`::error title=SceneScout QA::${escapeAnnotation(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
