/**
 * Unit and integration tests for `scenescout export`: its options and where
 * credentials come from, which findings it files, the marker a later export
 * finds an issue by (and that quoted text cannot forge it), the inert
 * rendering of every issue (no mention, link, cross-reference or markup from
 * a finding survives), which screenshots belong to a finding, the plan and the
 * cap, and then whole exports against a stand-in GitHub API and a stand-in
 * Jira API over real HTTP: files N, a second export files nothing, a dry run
 * files nothing, the token never reaches the output, a 429 is waited out, a
 * 5xx after the tracker created the issue is not filed twice, and a redirect
 * is refused.
 *
 *   npx tsx --test --test-name-pattern "GitHub:" scripts/export-test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inert as qaInert } from "../action/qa-action.mjs";
import {
  checkTrackerUrl,
  credentialSecrets,
  DEFAULT_SEVERITY_MAP,
  EXIT_EXPORT,
  EXPORT_RECORD_FILE,
  findingIdsInGithubBody,
  findingIdsInJiraDescription,
  failedCriteriaByFinding,
  findingLine,
  frameIsOriginal,
  framesFor,
  githubIssue,
  githubMarker,
  inertMarkdown,
  inertPlain,
  isJiraKey,
  jiraDescription,
  jiraEditFields,
  jiraIssueFields,
  jiraMarkerRevision,
  jiraRevision,
  MARKER_LABEL,
  parseExportArgs,
  parseExportRecord,
  planExport,
  planJiraUpdate,
  rateLimit,
  recordKey,
  recordWith,
  rememberFiled,
  selectFindings,
  ticketsToLink,
  trackerCredentials,
  trackerMessage,
  UNCERTAIN_HOLD_MS,
  uncertainHolds,
  uploadName,
  type ExportOptions,
  type FiledIssue,
  type IssueContext,
} from "../src/engine/export.ts";
import type { Finding } from "../src/engine/memory.ts";
import { backoffMs } from "../src/engine/provider.ts";
import { runExport, type ExportDeps } from "../src/export-run.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GH_TOKEN = "test-gh-token-0123456789";
const JIRA_EMAIL = "qa@example.com";
const JIRA_TOKEN = "jira-test-token-0123456789";
const JIRA_BASIC = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "a1b2c3d4e5",
    severity: "high",
    category: "http-error",
    title: "Saving a thing answers 500",
    detail: "The Save button sends POST /api/things and the server answers 500; the page shows nothing.",
    evidence: "POST /api/things 500",
    url: "http://127.0.0.1:4173/things/new",
    state: "/things/new#3f2a",
    repro: ["navigate /things/new @ http://127.0.0.1:4173/things/new", 'click e4 "Save" @ http://127.0.0.1:4173/things/new'],
    foundAt: "2026-09-30T10:00:00.000Z",
    runs: 2,
    status: "open",
    session: "default",
    ...over,
  };
}

const parse = (args: string[], env: Record<string, string | undefined> = {}) => parseExportArgs(args, "/p", env);
const GH = ["--to", "github", "--repo", "owner/app"];
const JIRA = ["--to", "jira", "--jira-url", "https://example.atlassian.net", "--jira-project", "QA"];

function options(args: string[], env: Record<string, string | undefined> = {}): ExportOptions {
  const r = parse(args, env);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.options;
}

/** The Jira settings of options that must be for Jira. */
function jiraOf(o: ExportOptions) {
  assert.equal(o.to, "jira");
  return (o as Extract<ExportOptions, { to: "jira" }>).jira;
}

/** The GitHub settings of options that must be for GitHub. */
function githubOf(o: ExportOptions) {
  assert.equal(o.to, "github");
  return (o as Extract<ExportOptions, { to: "github" }>).github;
}

// ── options ─────────────────────────────────────────────────────────────────

test("options: GitHub's defaults are a dry run of every open defect, at most 20, screenshots on", () => {
  assert.deepEqual(options(GH), {
    to: "github",
    projectDir: "/p",
    github: { repo: "owner/app", apiUrl: "https://api.github.com" },
    minSeverity: "low",
    maxIssues: 20,
    severityMap: DEFAULT_SEVERITY_MAP.github,
    labels: [],
    screenshots: true,
    refileClosed: false,
    includeWorthALook: false,
    dryRun: true,
  });
});

test("options: only --yes files; --dry-run says the default out loud, and the two together are refused", () => {
  assert.equal(options([...GH, "--yes"]).dryRun, false);
  assert.equal(options([...GH, "--dry-run"]).dryRun, true);
  const both = parse([...GH, "--dry-run", "--yes"]);
  assert.ok(!both.ok && /contradict/.test(both.error));
});

test("options: Jira from flags or from the environment, a flag winning over its variable", () => {
  assert.deepEqual(jiraOf(options(JIRA)), { baseUrl: "https://example.atlassian.net", projectKey: "QA", issueType: "Bug", linkType: "Relates", update: true });
  const env = { JIRA_BASE_URL: "https://env.atlassian.net/", JIRA_PROJECT_KEY: "OPS", JIRA_ISSUE_TYPE: "Task", JIRA_LINK_TYPE: "Blocks" };
  assert.deepEqual(jiraOf(options(["--to", "jira"], env)), {
    baseUrl: "https://env.atlassian.net",
    projectKey: "OPS",
    issueType: "Task",
    linkType: "Blocks",
    update: true,
  });
  assert.deepEqual(jiraOf(options([...JIRA, "--jira-issue-type", "Defect", "--jira-link-type", "none", "--jira-update", "off"], env)), {
    baseUrl: "https://example.atlassian.net",
    projectKey: "QA",
    issueType: "Defect",
    linkType: null,
    update: false,
  });
  assert.deepEqual(options(JIRA).severityMap, { high: "High", medium: "Medium", low: "Low" });
  // A GitHub Enterprise Server API, and a stand-in on this machine.
  assert.equal(githubOf(options(GH, { GITHUB_API_URL: "https://ghe.example.com/api/v3/" })).apiUrl, "https://ghe.example.com/api/v3");
  assert.equal(githubOf(options(GH, { GITHUB_API_URL: "http://127.0.0.1:9999" })).apiUrl, "http://127.0.0.1:9999");
  assert.equal(options([...GH, "--project", "app"]).projectDir, "/p/app");
});

test("options: each mistake is refused with a sentence that says what to do", () => {
  const rows: Array<[string[], RegExp, Record<string, string>?]> = [
    [[], /--to github or --to jira/],
    [["--to", "gitlab"], /--to must be one of github, jira/],
    [["--to", "github"], /needs --repo owner\/name/],
    [["--to", "github", "--repo", "owner"], /not owner\/name/],
    [["--to", "github", "--repo", "../app"], /not owner\/name/],
    [[...GH, "--jira-url", "https://example.atlassian.net"], /--jira-url is not an option of --to github/],
    [["--to", "jira", "--repo", "owner/app"], /--repo is not an option of --to jira/],
    [["--to", "jira"], /needs the site's address/],
    [["--to", "jira", "--jira-url", "http://jira.example.com", "--jira-project", "QA"], /must be https/],
    [["--to", "jira", "--jira-url", "https://me:pw@jira.example.com", "--jira-project", "QA"], /no credentials/],
    [["--to", "jira", "--jira-url", "https://example.atlassian.net/?a=1", "--jira-project", "QA"], /no query/],
    [["--to", "jira", "--jira-url", "https://example.atlassian.net"], /needs a project key/],
    [["--to", "jira", "--jira-url", "https://example.atlassian.net", "--jira-project", "qa"], /not a key/],
    [["--to", "jira", "--jira-url", "https://example.atlassian.net", "--jira-project", 'QA" OR project = "X'], /not a key/],
    [["--to", "jira"], /JIRA_BASE_URL must be https/, { JIRA_BASE_URL: "http://jira.example.com", JIRA_PROJECT_KEY: "QA" }],
    [GH, /GITHUB_API_URL must be https/, { GITHUB_API_URL: "http://api.example.com" }],
    [[...GH, "--token", "x"], /there is no --token: credentials are read from the environment only/],
    [[...GH, "--github-token=x"], /there is no --github-token/],
    [[...JIRA, "--jira-email", "a@example.com"], /there is no --jira-email/],
    [[...GH, "--nope"], /unknown option --nope/],
    [[...GH, "--to", "jira"], /--to is given twice/],
    [[...GH, "--yes=true"], /--yes takes no value/],
    [[...GH, "--project"], /--project needs a value/],
    [[...GH, "--max-issues", "0"], /from 1 to 100/],
    [[...GH, "--max-issues", "101"], /from 1 to 100/],
    [[...GH, "--max-issues", "2.5"], /from 1 to 100/],
    [[...GH, "--min-severity", "critical"], /--min-severity must be one of high, medium, low/],
    [[...GH, "--only", ","], /--only needs finding ids/],
    [[...GH, "--only", "a1b2,<x>"], /is not a finding id/],
    [[...GH, "--screenshots", "maybe"], /on or off/],
    [[...GH, "project-dir"], /unexpected argument project-dir/],
    [[...GH, "--labels", "bug,,ui"], /empty/],
    [[...JIRA, "--labels", "needs triage"], /cannot contain spaces/],
    [[...GH, "--severity-map", "high"], /severity=name pairs/],
    [[...GH, "--severity-map", "urgent=P0"], /not high, medium or low/],
    [[...GH, "--severity-map", "high=a,high=b"], /names high twice/],
    [[...GH, "--severity-map", `high=${"x".repeat(51)}`], /longer than 50/],
  ];
  for (const [args, message, env] of rows) {
    const r = parse(args, env);
    assert.ok(!r.ok, `${args.join(" ")} was accepted`);
    assert.match(r.error, message, args.join(" "));
  }
});

test("options: the severity map keeps the defaults it does not name; an empty name sets none; none sets none at all", () => {
  assert.deepEqual(options([...GH, "--severity-map", "high=P1, low=P3"]).severityMap, { high: "P1", medium: "severity: medium", low: "P3" });
  assert.deepEqual(options([...GH, "--severity-map", "low="]).severityMap, { high: "severity: high", medium: "severity: medium", low: null });
  assert.deepEqual(options([...JIRA, "--severity-map", "none"]).severityMap, { high: null, medium: null, low: null });
  assert.deepEqual(options([...JIRA, "--severity-map", "HIGH=Highest"]).severityMap, { high: "Highest", medium: "Medium", low: "Low" });
});

test("options: labels are trimmed, the marker label and repeats are dropped, and at most ten are taken", () => {
  assert.deepEqual(options([...GH, "--labels", " bug , needs triage,Bug,scenescout"]).labels, ["bug", "needs triage"]);
  const many = Array.from({ length: 11 }, (_, i) => `l${i}`).join(",");
  const r = parse([...GH, "--labels", many]);
  assert.ok(!r.ok && /at most 10/.test(r.error));
});

test("options: an address a credential goes to is https, or http only to this machine", () => {
  const ok = (raw: string) => checkTrackerUrl(raw, "X");
  assert.deepEqual(ok("https://example.atlassian.net/"), { ok: true, value: "https://example.atlassian.net" });
  assert.deepEqual(ok("https://jira.example.com/jira"), { ok: true, value: "https://jira.example.com/jira" });
  assert.deepEqual(ok("http://localhost:8080"), { ok: true, value: "http://localhost:8080" });
  assert.deepEqual(ok("http://[::1]:8080/"), { ok: true, value: "http://[::1]:8080" });
  for (const bad of [
    "http://jira.example.com",
    // Near misses: a host that only starts like this machine is somewhere else.
    "http://localhost.example.com",
    "http://127.0.0.1.example.com",
    "http://127.0.0.2",
    "ftp://example.com",
    "https://u:p@example.com",
    "https://example.com/#x",
    "not a url",
  ])
    assert.equal(ok(bad).ok, false, bad);
});

// ── credentials ─────────────────────────────────────────────────────────────

test("credentials: GH_TOKEN, then GITHUB_TOKEN; Jira needs both; an error names variables and never a value", () => {
  const gh = trackerCredentials("github", { GH_TOKEN: " first-token-value ", GITHUB_TOKEN: "second-token-value" });
  assert.ok(gh.ok);
  assert.deepEqual(gh.headers, { authorization: "Bearer first-token-value" });
  assert.equal(gh.source, "GH_TOKEN");
  const fallback = trackerCredentials("github", { GH_TOKEN: "  ", GITHUB_TOKEN: "second-token-value" });
  assert.ok(fallback.ok && fallback.source === "GITHUB_TOKEN");
  assert.deepEqual(fallback.headers, { authorization: "Bearer second-token-value" });
  const none = trackerCredentials("github", {});
  assert.ok(!none.ok && /GH_TOKEN or GITHUB_TOKEN/.test(none.error));

  const jira = trackerCredentials("jira", { JIRA_EMAIL: JIRA_EMAIL, JIRA_API_TOKEN: JIRA_TOKEN });
  assert.ok(jira.ok);
  assert.deepEqual(jira.headers, { authorization: `Basic ${JIRA_BASIC}` });
  const half = trackerCredentials("jira", { JIRA_EMAIL: JIRA_EMAIL });
  assert.ok(!half.ok);
  assert.match(half.error, /missing: JIRA_API_TOKEN/);
  assert.ok(!half.error.includes(JIRA_EMAIL), "the error names the variable, not the value it holds");
});

test("credentials: every one that is set is kept from the output, whichever tracker the export is for and however incomplete", () => {
  assert.deepEqual(credentialSecrets({ GH_TOKEN: " gh-value-0001 ", GITHUB_TOKEN: "github-value-0002", JIRA_EMAIL: JIRA_EMAIL, JIRA_API_TOKEN: JIRA_TOKEN }), [
    "gh-value-0001",
    "github-value-0002",
    JIRA_TOKEN,
    JIRA_BASIC,
  ]);
  assert.deepEqual(credentialSecrets({ JIRA_API_TOKEN: JIRA_TOKEN }), [JIRA_TOKEN], "a token without its email is still a secret");
  assert.deepEqual(credentialSecrets({ GH_TOKEN: "  ", JIRA_EMAIL: JIRA_EMAIL }), []);
});

// ── which findings ──────────────────────────────────────────────────────────

const memoryOf = (findings: unknown[]) => ({ version: 1, states: {}, findings });

test("selection: open defects at or above the minimum severity, worst first and then oldest first", () => {
  const all = [
    finding({ id: "low1", severity: "low", foundAt: "2026-09-01T00:00:00.000Z" }),
    finding({ id: "high2", severity: "high", foundAt: "2026-09-03T00:00:00.000Z" }),
    finding({ id: "high1", severity: "high", foundAt: "2026-09-02T00:00:00.000Z" }),
    finding({ id: "med1", severity: "medium" }),
    finding({ id: "fixed", status: "resolved" }),
    finding({ id: "look", severity: "low", tier: "worth_a_look", convention: "a 4px spacing scale" }),
  ];
  const every = selectFindings(memoryOf(all), { minSeverity: "low", includeWorthALook: false });
  assert.deepEqual(
    every.candidates.map((f) => f.id),
    ["high1", "high2", "med1", "low1"],
  );
  assert.deepEqual(every.counts, { open: 5, resolved: 1, worthALook: 1, belowSeverity: 0 });
  assert.deepEqual(every.unreadable, []);
  const medium = selectFindings(memoryOf(all), { minSeverity: "medium", includeWorthALook: true });
  assert.deepEqual(
    medium.candidates.map((f) => f.id),
    ["high1", "high2", "med1"],
  );
  assert.equal(medium.counts.belowSeverity, 2, "the low defect and the low worth-a-look");
  assert.deepEqual(
    selectFindings(memoryOf(all), { minSeverity: "low", includeWorthALook: true }).candidates.map((f) => f.id),
    ["high1", "high2", "med1", "low1", "look"],
  );
});

test("selection: --only narrows, says why a named finding was left out, and names an id no finding has", () => {
  const all = [finding({ id: "keep" }), finding({ id: "gone", status: "resolved" }), finding({ id: "minor", severity: "low" })];
  const s = selectFindings(memoryOf(all), { minSeverity: "medium", includeWorthALook: false, only: ["keep", "gone", "minor", "typo"] });
  assert.deepEqual(
    s.candidates.map((f) => f.id),
    ["keep"],
  );
  assert.deepEqual(s.leftOut, [
    { id: "gone", reason: "resolved" },
    { id: "minor", reason: "below --min-severity medium" },
  ]);
  assert.deepEqual(s.unknownOnly, ["typo"]);
});

test("selection: an entry that is not a finding, or whose id could not sit in a marker, is counted and never exported", () => {
  const s = selectFindings(memoryOf([finding(), { id: 7, title: "x" }, finding({ id: "has space" }), "text"]), {
    minSeverity: "low",
    includeWorthALook: false,
  });
  assert.deepEqual(
    s.candidates.map((f) => f.id),
    ["a1b2c3d4e5"],
  );
  assert.deepEqual(s.unreadable, ["#2", "has space", "#4"], "named by id where there is one, else by place");
  assert.equal(selectFindings(null, { minSeverity: "low", includeWorthALook: false }).candidates.length, 0);
});

// ── the plan ────────────────────────────────────────────────────────────────

const filedAs = (n: number, open = true): FiledIssue => ({ ref: `#${n}`, number: n, url: `https://github.example/owner/app/issues/${n}`, open });

test("plan: what is filed is skipped, the cap counts only what is filed, and the rest waits for the next export", () => {
  const cands = ["a", "b", "c", "d"].map((id) => finding({ id }));
  const plan = planExport(cands, new Map([["b", filedAs(4)]]), 2);
  assert.deepEqual(
    plan.map((e) => `${e.finding.id}:${e.outcome}`),
    ["a:file", "b:already-filed", "c:file", "d:over-cap"],
  );
  // The next export: a and c are filed now, so d is filed.
  const next = planExport(
    cands,
    new Map([
      ["a", filedAs(5)],
      ["b", filedAs(4)],
      ["c", filedAs(6)],
    ]),
    2,
  );
  assert.deepEqual(
    next.map((e) => e.outcome),
    ["already-filed", "already-filed", "already-filed", "file"],
  );
  assert.deepEqual(
    planExport(cands, null, 3).map((e) => e.outcome),
    ["file", "file", "file", "over-cap"],
    "no tracker asked: everything up to the cap",
  );
});

test("plan: of two issues for one finding, an open one wins over a closed one, then the earlier one", () => {
  const map = new Map<string, FiledIssue>();
  rememberFiled(map, "x", filedAs(9, false));
  rememberFiled(map, "x", filedAs(12));
  assert.equal(map.get("x")?.ref, "#12", "open beats closed");
  rememberFiled(map, "x", filedAs(10));
  assert.equal(map.get("x")?.ref, "#10", "earlier beats later");
  rememberFiled(map, "x", filedAs(3, false));
  assert.equal(map.get("x")?.ref, "#10", "an earlier closed one does not beat an open one");
});

// ── the marker ──────────────────────────────────────────────────────────────

const CTX: IssueContext = { severityName: "severity: high", labels: [], screenshots: [] };

test("marker: a GitHub body's own marker is read back, and the same words quoted by a finding are not", () => {
  const own = githubIssue(finding(), CTX).body;
  assert.ok(own.startsWith(`${githubMarker("a1b2c3d4e5")}\n`), "the marker is the body's first line");
  assert.deepEqual(findingIdsInGithubBody(own), ["a1b2c3d4e5"]);
  // The contrastive case: the same marker, written into the finding's own text.
  const forged = githubIssue(finding({ detail: "see <!-- scenescout-finding: otherid123 --> here", evidence: "scenescout-finding: otherid123" }), CTX).body;
  assert.deepEqual(findingIdsInGithubBody(forged), ["a1b2c3d4e5"]);
  assert.deepEqual(findingIdsInGithubBody("<!-- scenescout-finding: b2 -->\nand <!-- scenescout-finding: c3 -->"), ["b2", "c3"]);
  assert.deepEqual(findingIdsInGithubBody(null), []);
});

test("marker: a Jira description's own marker is read back after the API's round trip, and quoted words are not", () => {
  const own = JSON.parse(JSON.stringify(jiraDescription(finding(), CTX)));
  assert.deepEqual(findingIdsInJiraDescription(own), ["a1b2c3d4e5"]);
  const forged = JSON.parse(
    JSON.stringify(jiraDescription(finding({ detail: "scenescout-finding: otherid123", evidence: "SceneScout-Finding: otherid123" }), CTX)),
  );
  assert.deepEqual(findingIdsInJiraDescription(forged), ["a1b2c3d4e5"]);
  assert.deepEqual(findingIdsInJiraDescription(undefined), []);
});

// ── inert text ──────────────────────────────────────────────────────────────

test("inert: no mention, link, cross-reference, HTML or Markdown survives into a GitHub body", () => {
  const rows: Array<[string, RegExp]> = [
    ["ping @alice and @org/team", /@(?!\u200b)/],
    ["see https://evil.example.com/x", /https:\/\//],
    ["www.evil.example.com", /www\./i],
    ["mail bob@example.com", /@(?!\u200b)/],
    ["fixes #12 and owner/app#3, GH-7", /#\d|GH-\d/],
    ["<img src=x onerror=alert(1)>", /</],
    ["<!-- scenescout-finding: x -->", /<!--/],
    ["[click](https://evil.example.com)", /(?<!\\)\[|(?<!\\)\(/],
    ["![pixel](https://evil.example.com/p.png)", /(?<!\\)!/],
    ["**bold** _em_ `code` ~~gone~~ | cell", /(?<!\\)[*_`~|]/],
    ["line one\n# heading\n- item", /\n/],
    ["&lt;b&gt;", /&lt;b/],
  ];
  for (const [input, forbidden] of rows) assert.doesNotMatch(inertMarkdown(input, 500), forbidden, input);
  assert.equal(inertMarkdown("x".repeat(200), 50).length, 50, "capped, with an ellipsis");
});

test("inert: the same escaping as the /scenescout qa reply, with the cross-reference and marker breaks added", () => {
  const inputs = [
    "plain words",
    "@alice <b>x</b> & [a](b) `c` *d* _e_ #f +g !h |i ~j {k} \\l",
    "https://a.example.com www.b.example.com",
    "fixes #12, GH-3 and scenescout-finding: x",
    "tab\there\nnewline\u0007bell",
    "y".repeat(400),
  ];
  for (const input of inputs) assert.equal(inertMarkdown(input).replace(/\u200b/g, ""), qaInert(input).replace(/\u200b/g, ""), input);
});

test("inert: plain text (a title, a Jira text node) breaks the triggers and escapes nothing", () => {
  assert.equal(inertPlain("Total is <b>NaN</b> for @bob, see #4"), "Total is <b>NaN</b> for @\u200bbob, see #\u200b4");
  assert.equal(inertPlain("a\u202eb\u0000c\r\nd"), "a b c d", "bidirectional overrides and control characters go");
});

// ── what an issue says ──────────────────────────────────────────────────────

test("GitHub issue: the title, the marker first, the facts, the steps, the evidence and the labels", () => {
  const issue = githubIssue(finding({ regressedAt: "2026-09-29T00:00:00.000Z", verdict: "present", verifiedAt: "2026-09-30T08:00:00.000Z" }), {
    severityName: "severity: high",
    labels: ["bug"],
    screenshots: [],
  });
  assert.equal(issue.title, "Saving a thing answers 500");
  assert.deepEqual(issue.labels, [MARKER_LABEL, "severity: high", "bug"]);
  for (const part of [
    "| Severity | high |",
    "| Category | http-error |",
    "| Page | /things/new |",
    "| Last found | 2026-09-30 |",
    "| Runs that found it | 2 |",
    "| Regressed | 2026-09-29: it had been marked resolved |",
    "| Last re-test | present \\(2026-09-30\\) |",
    "### Steps to reproduce",
    '2. click e4 "Save" @\u200b http:\u200b//127.0.0.1:4173/things/new',
    "### Evidence",
    "POST /api/things 500",
    "Filed by SceneScout from finding `a1b2c3d4e5`",
  ])
    assert.ok(issue.body.includes(part), `the body has: ${part}\n---\n${issue.body}`);
  const bare = githubIssue(finding({ repro: [], evidence: undefined }), { severityName: null, labels: [], screenshots: [] });
  assert.deepEqual(bare.labels, [MARKER_LABEL], "no severity label when the map sets none");
  assert.ok(bare.body.includes("No steps were recorded") && bare.body.includes("No machine evidence was recorded"));
});

test("GitHub issue: screenshots are named when the run kept them, said to be none when it did not, and left out when off", () => {
  const named = githubIssue(finding(), { ...CTX, screenshots: ["recordings/default/0003-click.jpg"] }).body;
  assert.match(named, /Not attached: GitHub's API cannot upload a file to an issue/);
  assert.match(named, /- recordings\/default\/0003-click\.jpg/);
  assert.match(githubIssue(finding(), CTX).body, /None: only a recorded run keeps a frame/);
  assert.doesNotMatch(githubIssue(finding(), { ...CTX, screenshots: "off" }).body, /### Screenshots/);
});

test("GitHub issue: no text from a finding can mention, link, reference or mark up anything", () => {
  const hostile = finding({
    title: "@here look at https://evil.example.com #1",
    detail: "<script>alert(1)</script> [x](https://evil.example.com) @alice",
    evidence: "GET /api/x 500 `whoami` ![i](https://evil.example.com/i.png)",
    category: "<b>other</b>",
    url: "https://app.example.com/a?b=<c>",
    state: "/a <b>#x",
    repro: ["click @bob www.evil.example.com", "| table | forged |"],
  });
  const { title, body } = githubIssue(hostile, CTX);
  // Everything after the marker line is the finding's text in our framing.
  const rendered = body.split("\n").slice(1).join("\n");
  assert.doesNotMatch(title, /@(?!\u200b)|https:\/\/|#\d/);
  // The renderer escapes every "<", so no tag of any spelling can open, and each one reads as text.
  assert.ok(!rendered.includes("<"), "no markup can open in the rendered text");
  assert.ok(rendered.includes("&lt;script&gt;") && rendered.includes("&lt;b&gt;"), "the markup is shown as text");
  assert.doesNotMatch(rendered, /@(?!\u200b)/);
  assert.doesNotMatch(rendered, /https:\/\/evil|www\.evil/i);
  assert.doesNotMatch(rendered, /(?<!\\)\]\(/);
  assert.doesNotMatch(rendered, /\| table \| forged \|/);
});

test("redaction: a credential in any field of a finding never reaches either tracker's issue", () => {
  // Built at runtime, so this file holds no credential-shaped string for hygiene-test to find.
  const bearer = ["Bearer", "abcd1234efgh5678ijkl"].join(" ");
  const key = ["sk", "test", "abcd1234wxyz"].join("_");
  const password = ["password", "hunter2abc123def"].join("=");
  const leaky = finding({
    title: `Saving fails with ${bearer}`,
    detail: `The page shows ${key} in its error`,
    evidence: `POST /api/things 500 ${password}`,
    url: `http://127.0.0.1:4173/things?${password}`,
    state: `/things ${key}#1`,
    category: `other ${key}`,
    repro: [`type e3 "${password}" @ http://127.0.0.1:4173/login`],
  });
  const gh = githubIssue(leaky, CTX);
  const jira = JSON.stringify(jiraIssueFields(leaky, { ...CTX, projectKey: "QA", issueType: "Bug" }));
  for (const secret of ["abcd1234efgh5678ijkl", "abcd1234wxyz", "hunter2abc123def"]) {
    assert.ok(!gh.title.includes(secret) && !gh.body.includes(secret), `GitHub: ${secret}`);
    assert.ok(!jira.includes(secret), `Jira: ${secret}`);
  }
});

test("marker: no field of a finding can forge either tracker's marker", () => {
  const word = "scenescout-finding: forged1234";
  const comment = `<!-- ${word} -->`;
  const hostile = finding({
    id: "realid0001",
    title: `${comment} ${word}`,
    detail: `${comment} ${word}`,
    evidence: `${comment} ${word}`,
    url: `https://app.example.com/?q=${word}`,
    state: `/x ${comment}#1`,
    category: word,
    repro: [comment, word],
    tier: "worth_a_look",
    convention: `${comment} ${word}`,
  });
  assert.deepEqual(findingIdsInGithubBody(githubIssue(hostile, CTX).body), ["realid0001"]);
  assert.deepEqual(findingIdsInJiraDescription(JSON.parse(JSON.stringify(jiraDescription(hostile, CTX)))), ["realid0001"]);
});

test("Jira issue: no mention or link survives in the summary or any text node", () => {
  const hostile = finding({
    title: "@here see https://evil.example.com",
    detail: "ping @alice at www.evil.example.com",
    evidence: "GET https://evil.example.com/x 500",
    repro: ["click @bob"],
  });
  const fields = jiraIssueFields(hostile, { ...CTX, projectKey: "QA", issueType: "Bug" });
  const texts: string[] = [String(fields.summary)];
  const walk = (node: Record<string, unknown>): void => {
    if (node.type === "text") texts.push(String(node.text));
    for (const child of (node.content as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
  };
  walk(fields.description as Record<string, unknown>);
  for (const t of texts) {
    assert.doesNotMatch(t, /@(?!\u200b)/, t);
    assert.doesNotMatch(t, /:\/\/|www\./i, t);
  }
});

test("issue: frames the run kept but that are gone are said to be gone, not that the run was unrecorded", () => {
  assert.match(githubIssue(finding(), { ...CTX, framesLeftOut: 2 }).body, /None: the run's frames of these steps are missing/);
  assert.match(githubIssue(finding(), CTX).body, /None: only a recorded run keeps a frame/);
  assert.match(JSON.stringify(jiraDescription(finding(), { screenshots: [], framesLeftOut: 1 })), /None: the run's frames of these steps are missing/);
});

test("inert: GitHub's maths delimiter is escaped too", () => {
  assert.equal(inertMarkdown("costs $5 or $x^2$"), "costs \\$5 or \\$x^2\\$");
});

test("Jira issue: the fields, a priority from the map or none, labels, and a document with no empty text node", () => {
  const fields = jiraIssueFields(finding({ evidence: "" }), {
    severityName: "Highest",
    labels: ["ui"],
    screenshots: ["recordings/default/0003-click.jpg"],
    projectKey: "QA",
    issueType: "Bug",
  });
  assert.deepEqual(fields.project, { key: "QA" });
  assert.deepEqual(fields.issuetype, { name: "Bug" });
  assert.equal(fields.summary, "Saving a thing answers 500");
  assert.deepEqual(fields.priority, { name: "Highest" });
  assert.deepEqual(fields.labels, [MARKER_LABEL, "ui"], "the severity is the priority here, not a label");
  assert.equal("priority" in jiraIssueFields(finding(), { ...CTX, severityName: null, projectKey: "QA", issueType: "Bug" }), false);

  const allowed = new Set(["doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "rule"]);
  const texts: string[] = [];
  const walk = (node: Record<string, unknown>): void => {
    assert.ok(allowed.has(String(node.type)), `node type ${String(node.type)}`);
    if (node.type === "text") {
      assert.ok(typeof node.text === "string" && node.text.length > 0, "ADF refuses an empty text node");
      texts.push(node.text as string);
    }
    for (const child of (node.content as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
  };
  walk(fields.description as Record<string, unknown>);
  assert.ok(texts.includes("Attached: 0003-click.jpg, the frames of the steps before it was last found."));
  assert.ok(texts.some((t) => /^scenescout-finding: a1b2c3d4e5 rev [0-9a-f]{16}$/.test(t)));
});

test("title: within the 255 characters both trackers take, however many triggers it breaks", () => {
  assert.ok(githubIssue(finding({ title: "@".repeat(400) }), CTX).title.length <= 250);
  assert.equal(githubIssue(finding({ title: "   " }), CTX).title, "SceneScout finding");
});

test("terminal: a finding's line carries no control characters, so no terminal escape", () => {
  const line = findingLine(finding({ title: "Red \u001b[31malert\u001b[0m\u0007 here" }));
  assert.doesNotMatch(line, /[\u0000-\u001f]/);
  assert.match(line, /^high {2}/);
});

// ── screenshots ─────────────────────────────────────────────────────────────

test("frames: the finding's own session, the last three framed steps before it was filed, within ten minutes", () => {
  const at = (minutesBefore: number) => new Date(Date.parse("2026-09-30T10:00:00.000Z") - minutesBefore * 60_000).toISOString();
  const log = [
    { at: at(30), session: "default", frame: "recordings/default/0001-navigate.jpg" },
    { at: at(5), session: "default", frame: "recordings/default/0002-click.jpg" },
    { at: at(4), session: "default", frame: "recordings/default/0003-type.jpg" },
    { at: at(3), session: "lane-b", frame: "recordings/lane-b/0001-click.jpg" },
    { at: at(2), session: "default" },
    { at: at(1), session: "default", frame: "recordings/default/0004-click.jpg" },
    { at: at(0.5), session: "default", frame: "recordings/default/0005-click.jpg" },
    { at: at(-1), session: "default", frame: "recordings/default/0006-after.jpg" },
  ];
  assert.deepEqual(
    framesFor(finding(), log).map((x) => x.frame),
    ["recordings/default/0003-type.jpg", "recordings/default/0004-click.jpg", "recordings/default/0005-click.jpg"],
  );
  assert.deepEqual(
    framesFor(finding({ session: "lane-b" }), log).map((x) => x.frame),
    ["recordings/lane-b/0001-click.jpg"],
  );
  assert.deepEqual(framesFor(finding({ session: undefined }), log), [], "with no session, another session's frame could be another page");
  assert.deepEqual(framesFor(finding({ foundAt: "garbage" }), log), []);
});

test("frames: a file rewritten after its step is not that step's picture", () => {
  const step = "2026-09-30T10:00:00.000Z";
  assert.equal(frameIsOriginal(step, Date.parse(step) - 300), true);
  assert.equal(frameIsOriginal(step, Date.parse(step) + 3 * 60_000), false, "a later run reused the file name");
  assert.equal(frameIsOriginal("garbage", Date.parse(step)), false);
});

// ── talking to a tracker ────────────────────────────────────────────────────

test("rate limit: 429 always is one; a 403 only when it says so; the wait it names", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
  const now = Date.parse("2026-09-30T10:00:00.000Z");
  assert.deepEqual(rateLimit(429, headers({ "retry-after": "3" }), now), { limited: true, waitMs: 3000 });
  assert.deepEqual(rateLimit(429, headers({}), now), { limited: true, waitMs: null });
  assert.deepEqual(rateLimit(429, headers({ "retry-after": "Wed, 30 Sep 2026 10:00:05 GMT" }), now), { limited: true, waitMs: 5000 });
  assert.deepEqual(rateLimit(403, headers({ "retry-after": "60" }), now), { limited: true, waitMs: 60_000 });
  assert.deepEqual(rateLimit(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 30) }), now), {
    limited: true,
    waitMs: 30_000,
  });
  assert.deepEqual(rateLimit(403, headers({}), now), { limited: false }, "a plain 403 is a missing permission");
  // GitHub sends its rate headers on every answer, permission refusals included.
  assert.deepEqual(
    rateLimit(403, headers({ "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(now / 1000 + 30) }), now, "Resource not accessible by integration"),
    { limited: false },
  );
  assert.deepEqual(rateLimit(403, headers({}), now, "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."), {
    limited: true,
    waitMs: 60_000,
  });
  assert.deepEqual(rateLimit(500, headers({ "retry-after": "1" }), now), { limited: false });
});

test("tracker message: GitHub's and Jira's error shapes, as one short line", () => {
  assert.equal(
    trackerMessage({ message: "Validation Failed", errors: [{ resource: "Issue", field: "title", code: "missing_field" }] }),
    "Validation Failed; title: missing_field",
  );
  assert.equal(
    trackerMessage({ errorMessages: ["You do not have permission."], errors: { priority: "Priority name 'High' is not valid" } }),
    "You do not have permission.; priority: Priority name 'High' is not valid",
  );
  assert.equal(trackerMessage("text"), "");
  assert.equal(trackerMessage({ message: "a\nb".repeat(200) }).length <= 300, true);
});

// ── stand-in trackers over real HTTP ────────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
}
/**
 * A canned answer to the next request that matches, used once. `then`: do the
 * real work first, and then answer this way ("answer"), never answer
 * ("hang"), or start a successful answer and drop the connection half-way
 * ("cut"): each time the tracker acted and the client never learnt it.
 */
interface Fault {
  method: string;
  path: RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  then?: "answer" | "hang" | "cut";
  /** Let this many matching requests through first. */
  after?: number;
}
interface StandIn {
  url: string;
  seen: Seen[];
  faults: Fault[];
  /** What a request did that the real API would refuse. Answered with a 400 and asserted empty by the test, never thrown in a handler. */
  violations: string[];
  close: () => Promise<void>;
}

async function serve(
  handle: (seen: Seen, send: (status: number, body?: unknown, headers?: Record<string, string>) => void, violations: string[]) => void,
): Promise<StandIn> {
  const seen: Seen[] = [];
  const faults: Fault[] = [];
  const violations: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, raw: Buffer.concat(chunks) };
      seen.push(s);
      const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const at = faults.findIndex((f) => f.method === s.method && f.path.test(s.url.split("?")[0]));
      if (at >= 0 && (faults[at].after ?? 0) > 0) faults[at].after! -= 1;
      else if (at >= 0) {
        const [fault] = faults.splice(at, 1);
        if (fault.then === undefined) return send(fault.status, fault.body, fault.headers);
        const cut = () => {
          res.writeHead(201, { "content-type": "application/json", "content-length": "400" });
          res.flushHeaders();
          res.write('{"number": 1, "html_url": "https://github.ex');
          // Late enough that the client has the headers, so it is the body that fails.
          setTimeout(() => res.socket?.destroy(), 100);
        };
        const never = () => {
          // The answer that never comes.
        };
        return handle(s, fault.then === "answer" ? () => send(fault.status, fault.body, fault.headers) : fault.then === "cut" ? cut : never, violations);
      }
      handle(s, send, violations);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    faults,
    violations,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: "open" | "closed";
  pull_request?: boolean;
}

interface GhOptions {
  /** Drop the labels of a created issue, as GitHub does for an account that may not set them. */
  dropLabels?: boolean;
  /** Answer a label in this case, as a repository that already had the label spelled another way. */
  labelAs?: string;
  /** The API's path on its host, as GitHub Enterprise Server serves it under /api/v3. */
  prefix?: string;
  /** Put this into every issue's address, as a tracker quoting a credential back in a successful answer would. */
  urlSuffix?: string;
  /** Leave the body out of listed issues, as an API that does not return it would. */
  omitBody?: boolean;
  /** Leave a new issue out of the label-filtered list until `settle()`, as GitHub's eventually consistent label filter does. */
  lag?: boolean;
  /** With `lag`, leave it out of the unfiltered list too, as when more than 100 newer issues and pull requests push it off the first page. */
  lagEverywhere?: boolean;
}

async function standInGitHub(opts: GhOptions = {}): Promise<StandIn & { issues: GhIssue[]; settle: () => void }> {
  const issues: GhIssue[] = [];
  const unsettled = new Set<number>();
  const prefix = opts.prefix ?? "";
  const view = (i: GhIssue) => ({
    number: i.number,
    html_url: `https://github.example/owner/app/issues/${i.number}${opts.urlSuffix ?? ""}`,
    state: i.state,
    ...(opts.omitBody ? {} : { body: i.body }),
    labels: i.labels.map((name) => ({ name: name === "scenescout" && opts.labelAs ? opts.labelAs : name })),
    ...(i.pull_request ? { pull_request: { url: "x" } } : {}),
  });
  const stand = await serve((s, send, violations) => {
    // A tracker that quotes the credentials back in an error: the export must still never print them.
    if (s.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: `Bad credentials: ${String(s.headers.authorization)}` });
    const u = new URL(s.url, "http://x");
    const one = new RegExp(`^${prefix}/repos/owner/app/issues/(\\d+)$`).exec(u.pathname);
    if (s.method === "GET" && one) {
      // Read by number, an issue shows as soon as it is made.
      const issue = issues.find((i) => i.number === Number(one[1]));
      return issue ? send(200, view(issue)) : send(404, { message: "Not Found" });
    }
    if (u.pathname !== `${prefix}/repos/owner/app/issues`) return send(404, { message: "Not Found" });
    if (s.method === "GET") {
      const state = u.searchParams.get("state") ?? "open";
      const label = u.searchParams.get("labels");
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Number(u.searchParams.get("per_page") ?? 30);
      const list = issues.filter(
        (i) => (state === "all" || i.state === state) && (!label || i.labels.includes(label)) && !((label || opts.lagEverywhere) && unsettled.has(i.number)),
      );
      if (u.searchParams.get("direction") === "desc") list.reverse();
      return send(200, list.slice((page - 1) * per, page * per).map(view));
    }
    const input = JSON.parse(s.raw.toString("utf8")) as { title: string; body: string; labels: string[] };
    if (typeof input.title !== "string" || input.title.length > 256) {
      violations.push(`a title GitHub refuses: ${String(input.title).slice(0, 40)}`);
      return send(400, { message: "Invalid title" });
    }
    const issue: GhIssue = { number: issues.length + 1, title: input.title, body: input.body, labels: opts.dropLabels ? [] : input.labels, state: "open" };
    issues.push(issue);
    if (opts.lag) unsettled.add(issue.number);
    send(201, view(issue));
  });
  return Object.assign(stand, { issues, settle: () => unsettled.clear() });
}

interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
  done: boolean;
  attachments: string[];
  /** Keys of the issues it is linked to, as `${type}:${key}`. */
  links?: string[];
  /** How many times it was edited. */
  edits?: number;
}

interface JiraOptions {
  omitDescription?: boolean;
  /** Issues on the site outside the project, such as the tickets a run was given. */
  tickets?: string[];
  /** The link types the site has. */
  linkTypes?: string[];
  /** Leave a new issue out of the search until `settle()`, as Jira's search index does for a while. */
  lag?: boolean;
}

async function standInJira(opts: JiraOptions = {}): Promise<StandIn & { issues: JiraIssue[]; settle: () => void }> {
  const issues: JiraIssue[] = [];
  const unsettled = new Set<string>();
  const tickets = new Set(opts.tickets ?? []);
  const linkTypes = new Set(opts.linkTypes ?? ["Relates", "Blocks"]);
  const viewOf = (i: JiraIssue, fields: readonly string[]) => ({
    key: i.key,
    fields: {
      ...(fields.includes("summary") ? { summary: i.fields.summary } : {}),
      ...(opts.omitDescription ? {} : { description: i.fields.description }),
      status: { statusCategory: { key: i.done ? "done" : "new" } },
      ...(fields.includes("attachment") ? { attachment: i.attachments.map((filename, n) => ({ id: String(n + 1), filename })) } : {}),
      ...(fields.includes("issuelinks")
        ? {
            issuelinks: (i.links ?? []).map((l) => {
              const [type, key] = l.split(":");
              return { type: { name: type }, inwardIssue: { key, fields: {} } };
            }),
          }
        : {}),
    },
  });
  const stand = await serve((s, send, violations) => {
    if (s.headers.authorization !== `Basic ${JIRA_BASIC}`)
      return send(401, { errorMessages: [`Client must be authenticated: ${String(s.headers.authorization)}`] });
    const p = s.url.split("?")[0];
    if (s.method === "POST" && p === "/rest/api/3/search/jql") {
      const input = JSON.parse(s.raw.toString("utf8")) as { jql: string; maxResults: number; nextPageToken?: string; fields: string[] };
      if (!/^project = "QA" AND labels = "scenescout"/.test(input.jql)) {
        violations.push(`an unexpected query: ${input.jql}`);
        return send(400, { errorMessages: ["The query is not this project's"] });
      }
      const open = /statusCategory != Done/.test(input.jql);
      const list = issues.filter((i) => (i.fields.labels as string[]).includes("scenescout") && (!open || !i.done) && !unsettled.has(i.key));
      const from = Number(input.nextPageToken ?? 0);
      const page = list.slice(from, from + input.maxResults);
      const more = from + input.maxResults < list.length;
      return send(200, {
        issues: page.map((i) => viewOf(i, input.fields)),
        ...(more ? { nextPageToken: String(from + input.maxResults) } : {}),
        isLast: !more,
      });
    }
    const read = /^\/rest\/api\/3\/issue\/(QA-\d+)$/.exec(p);
    if (s.method === "GET" && read) {
      // Read by key, an issue shows as soon as it is made.
      const issue = issues.find((i) => i.key === read[1]);
      const fields = (new URL(s.url, "http://x").searchParams.get("fields") ?? "").split(",");
      return issue ? send(200, viewOf(issue, fields)) : send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    }
    if (s.method === "POST" && p === "/rest/api/3/issue") {
      const { fields } = JSON.parse(s.raw.toString("utf8")) as { fields: Record<string, unknown> };
      if (typeof fields.summary !== "string" || fields.summary.length > 255) {
        violations.push(`a summary Jira refuses: ${String(fields.summary).slice(0, 40)}`);
        return send(400, { errorMessages: [], errors: { summary: "Summary must be less than 255 characters." } });
      }
      const key = `QA-${issues.length + 1}`;
      issues.push({ key, fields, done: false, attachments: [] });
      if (opts.lag) unsettled.add(key);
      return send(201, { id: String(10000 + issues.length), key, self: `https://example.atlassian.net/rest/api/3/issue/${key}` });
    }
    const edit = /^\/rest\/api\/3\/issue\/(QA-\d+)$/.exec(p);
    if (s.method === "PUT" && edit) {
      const issue = issues.find((i) => i.key === edit[1]);
      if (!issue) return send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      const { fields, ...rest } = JSON.parse(s.raw.toString("utf8")) as { fields: Record<string, unknown> };
      const touched = Object.keys(fields).filter((k) => k !== "summary" && k !== "description");
      if (touched.length || Object.keys(rest).length)
        violations.push(`an edit beyond the summary and description: ${[...touched, ...Object.keys(rest)].join(", ")}`);
      Object.assign(issue.fields, fields);
      issue.edits = (issue.edits ?? 0) + 1;
      return send(204);
    }
    if (s.method === "POST" && p === "/rest/api/3/issueLink") {
      const input = JSON.parse(s.raw.toString("utf8")) as { type?: { name?: string }; inwardIssue?: { key?: string }; outwardIssue?: { key?: string } };
      // Jira gives the type's outward words ("blocks") to the issue sent as inwardIssue: the issue filed here.
      const from = issues.find((i) => i.key === input.inwardIssue?.key);
      const to = input.outwardIssue?.key ?? "";
      if (!linkTypes.has(input.type?.name ?? "")) return send(404, { errorMessages: [`No issue link type with name '${input.type?.name}' found.`] });
      if (!from || !(tickets.has(to) || issues.some((i) => i.key === to)))
        return send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      // A link that already exists is answered as made, as Jira does.
      const tag = `${input.type!.name}:${to}`;
      if (!(from.links ?? []).includes(tag)) from.links = [...(from.links ?? []), tag];
      return send(201);
    }
    const attach = /^\/rest\/api\/3\/issue\/(QA-\d+)\/attachments$/.exec(p);
    if (s.method === "POST" && attach) {
      if (s.headers["x-atlassian-token"] !== "no-check") return send(403, { errorMessages: ["XSRF check failed"] });
      if (!/^multipart\/form-data; boundary=/.test(String(s.headers["content-type"]))) {
        violations.push(`an upload that is not multipart: ${String(s.headers["content-type"])}`);
        return send(415, { errorMessages: ["Unsupported media type"] });
      }
      const names = [...s.raw.toString("latin1").matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);
      issues.find((i) => i.key === attach[1])?.attachments.push(...names);
      return send(
        200,
        names.map((filename) => ({ filename })),
      );
    }
    send(404, { errorMessages: ["Not found"] });
  });
  return Object.assign(stand, { issues, settle: () => unsettled.clear() });
}

function projectWith(findings: Finding[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-export-test-"));
  fs.mkdirSync(path.join(dir, ".scenescout"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".scenescout", "memory.json"), JSON.stringify({ version: 1, states: {}, findings }));
  return dir;
}

/** A recorded frame for the default session, written at its step's time, and the session log line that names it. */
function recordFrame(dir: string, name: string, at: string): void {
  const rel = `recordings/default/${name}`;
  const file = path.join(dir, ".scenescout", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]));
  fs.utimesSync(file, new Date(at), new Date(at));
  const log = path.join(dir, ".scenescout", "session-2026-09-30T09-50-00-000Z.jsonl");
  fs.appendFileSync(log, JSON.stringify({ at, action: "click", url: "http://127.0.0.1:4173/things/new", session: "default", frame: rel }) + "\n");
}

const THREE = [
  finding({ id: "aaa0000001", title: "Saving a thing answers 500" }),
  finding({ id: "bbb0000002", severity: "medium", title: "The list keeps a deleted row" }),
  finding({ id: "ccc0000003", severity: "low", title: "The Save button is 20px tall" }),
];

interface Run {
  exitCode: number;
  out: string[];
  err: string[];
  waits: number[];
  filed: string[];
}

async function exportOnce(args: string[], env: Record<string, string | undefined>, dir: string, extra: Partial<ExportDeps> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const waits: number[] = [];
  const o = options([...args, "--project", dir], env);
  const outcome = await runExport(o, {
    env,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    wait: async (ms) => {
      waits.push(ms);
    },
    pauseMs: 0,
    random: () => 0,
    // Short, so a stand-in that never answers fails a test in seconds rather than holding it.
    timeoutMs: 5000,
    ...extra,
  });
  return { exitCode: outcome.exitCode, out, err, waits, filed: outcome.filed.map((f) => f.issue.ref) };
}

const posts = (s: StandIn) => s.seen.filter((x) => x.method === "POST");

/** The address an export printed for the issue it filed as `ref`, parsed: the last word of that line. */
function filedUrl(out: readonly string[], ref: string): string {
  const line = out.find((l) => l.trimStart().startsWith(`filed ${ref} `));
  assert.ok(line, `no line says filed ${ref}`);
  return new URL(line.trim().split(/\s+/).at(-1)!).href;
}

test("GitHub: an export files one issue per finding, and a second export of the same run files nothing", async () => {
  const gh = await standInGitHub();
  try {
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const first = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(first.exitCode, EXIT_EXPORT.done, first.err.join("\n"));
    assert.deepEqual(first.filed, ["#1", "#2", "#3"]);
    assert.equal(posts(gh).length, 3);
    assert.deepEqual(
      gh.issues.map((i) => findingIdsInGithubBody(i.body)[0]),
      ["aaa0000001", "bbb0000002", "ccc0000003"],
    );
    assert.deepEqual(gh.issues[1].labels, ["scenescout", "severity: medium"]);
    for (const s of gh.seen) {
      assert.equal(s.headers.authorization, `Bearer ${GH_TOKEN}`);
      assert.equal(s.headers["x-github-api-version"], "2022-11-28");
    }
    assert.equal(filedUrl(first.out, "#1"), "https://github.example/owner/app/issues/1");

    const second = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(second.exitCode, EXIT_EXPORT.done);
    assert.deepEqual(second.filed, []);
    assert.equal(posts(gh).length, 3, "nothing new was sent");
    assert.equal(second.out.filter((l) => /already filed .* as #\d/.test(l)).length, 3);
    assert.ok(second.out.some((l) => l.startsWith("Filed 0; 3 already filed")));
  } finally {
    await gh.close();
  }
});

test("GitHub: a dry run files nothing, and still says which findings are already filed", async () => {
  const gh = await standInGitHub();
  try {
    gh.issues.push({ number: 1, title: "x", body: `${githubMarker("bbb0000002")}\nfiled by hand`, labels: ["scenescout"], state: "open" });
    gh.issues.push({ number: 2, title: "a pull request", body: githubMarker("aaa0000001"), labels: ["scenescout"], state: "open", pull_request: true });
    const run = await exportOnce(GH, { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done);
    assert.equal(posts(gh).length, 0, "a dry run sends no create");
    assert.ok(run.out[0].includes("a dry run, so nothing is filed"));
    assert.equal(run.out.filter((l) => l.includes("would file")).length, 2, "a pull request carrying a marker is not an issue");
    assert.ok(run.out.some((l) => l.includes("already filed") && l.includes("bbb0000002") && l.endsWith("as #1")));
    assert.ok(run.out.some((l) => l.startsWith("Would file 2; 1 already filed")));
  } finally {
    await gh.close();
  }
});

test("GitHub: with no token a dry run asks the tracker nothing and says so, and --yes refuses before any request", async () => {
  const gh = await standInGitHub();
  try {
    const dir = projectWith(THREE);
    const dry = await exportOnce(GH, { GITHUB_API_URL: gh.url }, dir);
    assert.equal(dry.exitCode, EXIT_EXPORT.done);
    assert.ok(dry.out.some((l) => l.startsWith("Not compared with GitHub: no GitHub token")));
    const yes = await exportOnce([...GH, "--yes"], { GITHUB_API_URL: gh.url }, dir);
    assert.equal(yes.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(yes.err.join("\n"), /set GH_TOKEN or GITHUB_TOKEN/);
    assert.equal(gh.seen.length, 0);
  } finally {
    await gh.close();
  }
});

test("GitHub: the token never reaches the output, even when the tracker quotes it back", async () => {
  const gh = await standInGitHub();
  try {
    // Credentials the stand-in refuses: its 401 message quotes the header it was sent.
    const wrong = "wrong-token-that-is-long-enough";
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN: wrong, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    const all = [...run.out, ...run.err].join("\n");
    assert.match(all, /HTTP 401 \(the credentials were not accepted\): Bad credentials: Bearer \[redacted key\]/);
    assert.ok(!all.includes(wrong));
    const ok = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.ok(![...ok.out, ...ok.err].join("\n").includes(GH_TOKEN));
  } finally {
    await gh.close();
  }
});

test("GitHub: a 429 is waited out for as long as it asks and the create is sent again, once", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 429, headers: { "retry-after": "2" }, body: { message: "slow down" } });
    gh.faults.push({
      method: "GET",
      path: /\/issues$/,
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
      body: { message: "API rate limit exceeded" },
    });
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.filed, ["#1"]);
    assert.equal(gh.issues.length, 1);
    assert.ok(run.waits.includes(2000), `waited ${run.waits.join(", ")}`);
    assert.equal(posts(gh).length, 2, "the refused create and the one that worked");
  } finally {
    await gh.close();
  }
});

test("GitHub: a rate limit that asks for more than a minute ends the export with when to try again", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "GET", path: /\/issues$/, status: 429, headers: { "retry-after": "3600" } });
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /asks to wait 3600 s; export again after that/);
    assert.equal(posts(gh).length, 0);
  } finally {
    await gh.close();
  }
});

test("GitHub: a 5xx on a read is retried with backoff; a refusal is not retried", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "GET", path: /\/issues$/, status: 502, body: { message: "Bad gateway" } });
    const run = await exportOnce(GH, { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.waits, [backoffMs(1, () => 0)]);
    // The newest issues, sent twice, then the labelled ones.
    assert.equal(gh.seen.length, 3);

    gh.faults.push({ method: "POST", path: /\/issues$/, status: 422, body: { message: "Validation Failed", errors: [{ field: "labels", code: "invalid" }] } });
    const refused = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(refused.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(refused.err.join("\n"), /POST \/repos\/owner\/app\/issues was refused: HTTP 422: Validation Failed; labels: invalid/);
    assert.equal(gh.issues.length, 0);
  } finally {
    await gh.close();
  }
});

test("GitHub: a create that failed after the tracker made the issue is found by its marker, never filed twice", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 500, body: { message: "Server Error" }, then: "answer" });
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.equal(gh.issues.length, 1, "one issue, not two");
    assert.deepEqual(run.filed, ["#1"]);
    assert.ok(run.out.some((l) => l.includes("found by its marker after the tracker's error")));
  } finally {
    await gh.close();
  }
});

test("GitHub: a create that failed before the tracker made the issue is sent again after the marker is not found", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 503, body: { message: "Unavailable" } });
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.equal(gh.issues.length, 1);
    assert.equal(posts(gh).length, 2);
    // Each listing is two reads: the newest issues, then the labelled ones.
    assert.equal(gh.seen.filter((s) => s.method === "GET").length, 4, "listed once to plan, and once more before sending it again");
  } finally {
    await gh.close();
  }
});

test("GitHub: a create that keeps failing ends the export and says the issue may exist after all", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 502, body: { message: "Bad gateway" } });
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 502, body: { message: "Bad gateway" } });
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE), { retries: 1 });
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /POST \/repos\/owner\/app\/issues failed: HTTP 502: Bad gateway/);
    assert.match(run.err.join("\n"), /may have made that issue before the error/);
    assert.equal(posts(gh).length, 2, "sent once, and once more after the marker was not found");
    assert.equal(gh.issues.length, 0);
  } finally {
    await gh.close();
  }
});

test("GitHub: a redirect is refused, and the address it points to never sees the token", async () => {
  const elsewhere = await serve((_s, send) => send(200, []));
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "GET", path: /\/issues$/, status: 301, headers: { location: `${elsewhere.url}/repos/owner/app/issues` } });
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /answered with a redirect \(HTTP 301\), which is refused/);
    assert.equal(elsewhere.seen.length, 0);
    assert.equal(posts(gh).length, 0);
  } finally {
    await gh.close();
    await elsewhere.close();
  }
});

test("GitHub: a tracker that never answers is given up on after the timeout", { timeout: 10_000 }, async () => {
  const silent = http.createServer(() => {
    // Never answers.
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: url }, projectWith(THREE), { timeoutMs: 150, retries: 1 });
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /GET \/repos\/owner\/app\/issues failed: no answer within 0\.15 s/);
    assert.deepEqual(run.waits, [backoffMs(1, () => 0)], "a read is retried once before giving up");
  } finally {
    silent.closeAllConnections();
    await new Promise<void>((r) => silent.close(() => r()));
  }
});

test("GitHub: a finding whose issue was closed is not filed again by default, and is with --refile-closed", async () => {
  const gh = await standInGitHub();
  try {
    // Closed as won't-fix, say.
    gh.issues.push({ number: 1, title: "x", body: githubMarker("aaa0000001"), labels: ["scenescout"], state: "closed" });
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const skipped = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], env, dir);
    assert.equal(skipped.exitCode, EXIT_EXPORT.done, skipped.err.join("\n"));
    assert.deepEqual(skipped.filed, []);
    assert.ok(skipped.out.some((l) => l.includes("already filed") && l.endsWith("as #1 (closed)")));
    assert.equal(posts(gh).length, 0);

    const refiled = await exportOnce([...GH, "--yes", "--only", "aaa0000001", "--refile-closed"], env, dir);
    assert.equal(refiled.exitCode, EXIT_EXPORT.done, refiled.err.join("\n"));
    assert.deepEqual(refiled.filed, ["#2"]);
    assert.deepEqual(findingIdsInGithubBody(gh.issues[1].body), ["aaa0000001"]);

    // Now an open issue carries it, so neither way files it a third time.
    for (const extra of [[], ["--refile-closed"]]) {
      const again = await exportOnce([...GH, "--yes", "--only", "aaa0000001", ...extra], env, dir);
      assert.deepEqual(again.filed, [], extra.join(" "));
      assert.ok(
        again.out.some((l) => l.includes("already filed") && l.endsWith("as #2")),
        extra.join(" "),
      );
    }
    assert.equal(gh.issues.length, 2);
  } finally {
    await gh.close();
  }
});

test("GitHub: under --refile-closed, the re-check after a failed create does not take the closed issue for the new one", async () => {
  const gh = await standInGitHub();
  try {
    gh.issues.push({ number: 1, title: "x", body: githubMarker("aaa0000001"), labels: ["scenescout"], state: "closed" });
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 503, body: { message: "Unavailable" } });
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001", "--refile-closed"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.filed, ["#2"]);
    assert.equal(posts(gh).length, 2, "the failed create, and the one sent after the marker was not found on an open issue");
    assert.ok(!run.out.some((l) => l.includes("found by its marker")));
  } finally {
    await gh.close();
  }
});

test("GitHub: the cap files the worst first, and the next export files the rest", async () => {
  const gh = await standInGitHub();
  try {
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const first = await exportOnce([...GH, "--yes", "--max-issues", "2"], env, dir);
    assert.deepEqual(first.filed, ["#1", "#2"]);
    assert.ok(first.out.some((l) => l.includes("over the cap") && l.includes("ccc0000003")));
    assert.ok(first.out.some((l) => l.includes("1 over the cap of 2 (--max-issues): export again to file them")));
    const next = await exportOnce([...GH, "--yes", "--max-issues", "2"], env, dir);
    assert.deepEqual(next.filed, ["#3"]);
    assert.equal(findingIdsInGithubBody(gh.issues[2].body)[0], "ccc0000003");
  } finally {
    await gh.close();
  }
});

test("GitHub: labels GitHub dropped stop the export after that issue, since a later export could not find it", async () => {
  const gh = await standInGitHub({ dropLabels: true });
  try {
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.equal(gh.issues.length, 1);
    assert.match(run.err.join("\n"), /filed #1 without its scenescout label/);
    assert.match(run.err.join("\n"), /Filed before it stopped: #1\./);
  } finally {
    await gh.close();
  }
});

test("GitHub: issues past the first page of 100 are read, closed ones counted unless --refile-closed", async () => {
  const gh = await standInGitHub();
  try {
    for (let n = 1; n <= 150; n++) gh.issues.push({ number: n, title: `old ${n}`, body: githubMarker(`old${n}`), labels: ["scenescout"], state: "open" });
    gh.issues[129].body = githubMarker("aaa0000001");
    gh.issues.push({ number: 151, title: "closed", body: githubMarker("bbb0000002"), labels: ["scenescout"], state: "closed" });
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const any = await exportOnce(GH, env, dir);
    assert.ok(any.out.some((l) => l.includes("aaa0000001") && l.endsWith("as #130")));
    assert.ok(
      any.out.some((l) => l.includes("bbb0000002") && l.endsWith("as #151 (closed)")),
      "a closed issue counts as filed by default",
    );
    assert.ok(any.out.some((l) => l.includes("151 issue(s) carry the scenescout label (open or closed)")));
    const open = await exportOnce([...GH, "--refile-closed"], env, dir);
    assert.ok(open.out.some((l) => l.includes("aaa0000001") && l.endsWith("as #130")));
    assert.ok(open.out.some((l) => l.includes("would file") && l.includes("bbb0000002")));
    assert.ok(open.out.some((l) => l.includes("150 open issue(s) carry the scenescout label; a finding whose issue was closed is filed again")));
  } finally {
    await gh.close();
  }
});

test("GitHub: the body names the run's frames, since GitHub cannot take an upload", async () => {
  const gh = await standInGitHub();
  try {
    const dir = projectWith([THREE[0]]);
    recordFrame(dir, "0007-click.jpg", "2026-09-30T09:59:30.000Z");
    const dry = await exportOnce(GH, { GH_TOKEN, GITHUB_API_URL: gh.url }, dir);
    assert.ok(
      dry.out.some((l) => l.includes("would file") && l.endsWith("with 1 screenshot(s)")),
      "a dry run says what a GitHub issue would name too",
    );
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.match(gh.issues[0].body, /- recordings\/default\/0007-click\.jpg/);
  } finally {
    await gh.close();
  }
});

const JIRA_ENV = (url: string) => ({ JIRA_EMAIL, JIRA_API_TOKEN: JIRA_TOKEN, JIRA_BASE_URL: url, JIRA_PROJECT_KEY: "QA" });

test("Jira: an export files each finding with its screenshots attached, and a second export files nothing", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith(THREE);
    recordFrame(dir, "0003-click.jpg", "2026-09-30T09:59:00.000Z");
    recordFrame(dir, "0004-click.jpg", "2026-09-30T09:59:40.000Z");
    // A frame rewritten by a later run under the same name is not this finding's picture.
    recordFrame(dir, "0005-click.jpg", "2026-09-30T09:59:50.000Z");
    fs.utimesSync(
      path.join(dir, ".scenescout", "recordings", "default", "0005-click.jpg"),
      new Date("2026-10-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    );
    fs.appendFileSync(path.join(dir, ".scenescout", "session-2026-09-30T09-50-00-000Z.jsonl"), '{"frame": not json\n');
    const env = JIRA_ENV(jira.url);
    const first = await exportOnce(["--to", "jira", "--yes", "--labels", "ui"], env, dir);
    assert.equal(first.exitCode, EXIT_EXPORT.done, first.err.join("\n"));
    assert.deepEqual(first.filed, ["QA-1", "QA-2", "QA-3"]);
    const created = jira.issues[0];
    assert.equal(created.fields.summary, "Saving a thing answers 500");
    assert.deepEqual(created.fields.priority, { name: "High" });
    assert.deepEqual(created.fields.labels, ["scenescout", "ui"]);
    assert.deepEqual(created.fields.issuetype, { name: "Bug" });
    assert.deepEqual(findingIdsInJiraDescription(created.fields.description), ["aaa0000001"]);
    // Named after the step's time: a later run reusing the session's name numbers its frames from one again.
    assert.deepEqual(created.attachments, ["20260930T095900Z-0003-click.jpg", "20260930T095940Z-0004-click.jpg"]);
    assert.ok(
      first.out.some((l) => l.includes("Left out 3 frame(s)")),
      "the rewritten frame, once per finding",
    );
    assert.ok(first.out.some((l) => l.includes("Skipped 1 session-log line(s) or file(s)")));
    assert.equal(filedUrl(first.out, "QA-1"), new URL("/browse/QA-1", jira.url).href);

    const second = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.deepEqual(second.filed, []);
    assert.equal(jira.issues.length, 3);
    assert.equal(second.out.filter((l) => /already filed .* as QA-\d, up to date$/.test(l)).length, 3, second.out.join("\n"));
    assert.equal(jira.seen.filter((x) => x.method === "PUT").length, 0, "an issue whose finding has not changed is not edited, so its watchers hear nothing");
  } finally {
    await jira.close();
  }
});

test("Jira: a link in the recordings folder is not uploaded, whatever the session log says", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith([THREE[0]]);
    const outside = path.join(dir, "elsewhere.jpg");
    fs.writeFileSync(outside, "a file outside the recordings folder");
    const link = path.join(dir, ".scenescout", "recordings", "default", "0002-type.jpg");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    const at = "2026-09-30T09:59:30.000Z";
    // Dated at the step, so only the link itself can be what refuses it.
    fs.utimesSync(outside, new Date(at), new Date(at));
    fs.writeFileSync(
      path.join(dir, ".scenescout", "session-2026-09-30T09-50-00-000Z.jsonl"),
      JSON.stringify({ at, action: "type", url: "http://127.0.0.1:4173/things/new", session: "default", frame: "recordings/default/0002-type.jpg" }) + "\n",
    );
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(jira.issues[0].attachments, []);
    assert.ok(run.out.some((l) => l.includes("Left out 1 frame(s)")));
  } finally {
    await jira.close();
  }
});

test("Jira: a dry run files nothing; credentials are Basic and never printed", async () => {
  const jira = await standInJira();
  try {
    const run = await exportOnce(["--to", "jira"], JIRA_ENV(jira.url), projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done);
    assert.equal(jira.issues.length, 0);
    assert.deepEqual(
      jira.seen.map((s) => `${s.method} ${s.url}`),
      ["POST /rest/api/3/search/jql"],
      "one read, and no create",
    );
    assert.equal(run.out.filter((l) => l.includes("would file")).length, 3);

    const refused = await exportOnce(["--to", "jira", "--yes"], { ...JIRA_ENV(jira.url), JIRA_API_TOKEN: "wrong-jira-token-long-enough" }, projectWith(THREE));
    assert.equal(refused.exitCode, EXIT_EXPORT.couldNotExport);
    const all = [...refused.out, ...refused.err].join("\n");
    assert.match(all, /Client must be authenticated: Basic \[redacted key\]/);
    assert.ok(!all.includes("wrong-jira-token-long-enough") && !all.includes(Buffer.from(`${JIRA_EMAIL}:wrong-jira-token-long-enough`).toString("base64")));
  } finally {
    await jira.close();
  }
});

test("Jira: a 429 on a create is waited out and sent again", async () => {
  const jira = await standInJira();
  try {
    const env = JIRA_ENV(jira.url);
    jira.faults.push({ method: "POST", path: /\/rest\/api\/3\/issue$/, status: 429, headers: { "retry-after": "1" } });
    const run = await exportOnce(["--to", "jira", "--yes", "--only", "aaa0000001", "--screenshots", "off"], env, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.filed, ["QA-1"]);
    assert.ok(run.waits.includes(1000));
    assert.equal(jira.issues.length, 1);
  } finally {
    await jira.close();
  }
});

test("Jira: a finding whose issue was closed is not filed again by default, and is with --refile-closed", async () => {
  const jira = await standInJira();
  try {
    jira.issues.push({
      key: "QA-1",
      fields: { labels: ["scenescout"], description: jiraDescription(finding({ id: "aaa0000001" }), CTX) },
      done: true,
      attachments: [],
    });
    const env = JIRA_ENV(jira.url);
    const dir = projectWith(THREE);
    const skipped = await exportOnce(["--to", "jira", "--yes", "--only", "aaa0000001"], env, dir);
    assert.equal(skipped.exitCode, EXIT_EXPORT.done, skipped.err.join("\n"));
    assert.deepEqual(skipped.filed, []);
    assert.ok(skipped.out.some((l) => l.includes("already filed") && l.endsWith("as QA-1 (closed)")));
    assert.equal(jira.issues.length, 1);

    const refiled = await exportOnce(["--to", "jira", "--yes", "--only", "aaa0000001", "--refile-closed"], env, dir);
    assert.equal(refiled.exitCode, EXIT_EXPORT.done, refiled.err.join("\n"));
    assert.deepEqual(refiled.filed, ["QA-2"]);
    assert.deepEqual(findingIdsInJiraDescription(jira.issues[1].fields.description), ["aaa0000001"]);
    const queries = jira.seen.filter((x) => x.url === "/rest/api/3/search/jql").map((x) => (JSON.parse(x.raw.toString("utf8")) as { jql: string }).jql);
    assert.ok(!queries[0].includes("statusCategory"), "by default the query asks for closed issues too");
    assert.ok(queries.at(-1)!.includes("statusCategory != Done"), "--refile-closed asks for open ones only");
  } finally {
    await jira.close();
  }
});

test("Jira: a refused field says which options choose it", async () => {
  const jira = await standInJira();
  try {
    jira.faults.push({
      method: "POST",
      path: /\/rest\/api\/3\/issue$/,
      status: 400,
      body: { errorMessages: [], errors: { priority: "Specify the Priority (name) in the string format" } },
    });
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /HTTP 400 \(a field was refused: in Jira, check --jira-issue-type and the --severity-map priorities\): priority: Specify/);
    assert.equal(jira.issues.length, 0);
  } finally {
    await jira.close();
  }
});

test("Jira: a screenshot the tracker refuses is reported and fails the export; the issue stays filed once", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith([THREE[0]]);
    recordFrame(dir, "0003-click.jpg", "2026-09-30T09:59:00.000Z");
    jira.faults.push({ method: "POST", path: /\/attachments$/, status: 413, body: { errorMessages: ["Too large"] } });
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), dir);
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.deepEqual(run.filed, ["QA-1"]);
    assert.match(
      run.err.join("\n"),
      /QA-1: 20260930T095900Z-0003-click\.jpg was not attached \(.*HTTP 413: Too large\)\. It is at .*0003-click\.jpg; a later export attaches it/,
    );
    const again = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), dir);
    assert.deepEqual(again.filed, [], "the next export does not file it again");
  } finally {
    await jira.close();
  }
});

test("export: no memory, nothing to export, and an --only id the project does not have", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-export-test-"));
  const none = await exportOnce(GH, {}, empty);
  assert.equal(none.exitCode, EXIT_EXPORT.couldNotExport);
  assert.match(none.err.join("\n"), /no findings to export: .*memory\.json does not exist/);
  const resolved = await exportOnce(GH, {}, projectWith([finding({ status: "resolved" })]));
  assert.equal(resolved.exitCode, EXIT_EXPORT.done);
  assert.equal(resolved.out.at(-1), "Nothing to export.");
  const typo = await exportOnce([...GH, "--only", "nosuchid"], {}, projectWith(THREE));
  assert.equal(typo.exitCode, EXIT_EXPORT.couldNotExport);
  assert.match(typo.err.join("\n"), /--only names no finding of this project: nosuchid/);
});

test("GitHub: a create that times out after the tracker made the issue is found by its marker", { timeout: 10_000 }, async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 0, then: "hang" });
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE), { timeoutMs: 300 });
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.equal(gh.issues.length, 1);
    assert.deepEqual(run.filed, ["#1"]);
    assert.ok(run.out.some((l) => l.includes("found by its marker after the tracker's error")));
  } finally {
    await gh.close();
  }
});

test("GitHub: an answer cut off after the tracker made the issue is found by its marker, not filed twice", async () => {
  const gh = await standInGitHub();
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 201, then: "cut" });
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.equal(gh.issues.length, 1);
    assert.ok(run.out.some((l) => l.includes("found by its marker after the tracker's error")));
  } finally {
    await gh.close();
  }
});

test("GitHub: retries run out: a read failing every time stops after the last, each wait longer than the one before", async () => {
  const gh = await standInGitHub();
  try {
    for (let i = 0; i < 3; i++) gh.faults.push({ method: "GET", path: /\/issues$/, status: 503, body: { message: "Unavailable" } });
    const failing = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE), { retries: 2 });
    assert.equal(failing.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(failing.err.join("\n"), /failed: HTTP 503: Unavailable/);
    assert.deepEqual(failing.waits, [backoffMs(1, () => 0), backoffMs(2, () => 0)]);
    assert.ok(failing.waits[1] > failing.waits[0]);
    assert.equal(gh.seen.length, 3);

    for (let i = 0; i < 3; i++) gh.faults.push({ method: "GET", path: /\/issues$/, status: 429 });
    const limited = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE), { retries: 2 });
    assert.equal(limited.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(limited.err.join("\n"), /hit the tracker's rate limit 3 times/);
    assert.deepEqual(limited.waits, [backoffMs(1, () => 0), backoffMs(2, () => 0)]);
    assert.equal(posts(gh).length, 0);
  } finally {
    await gh.close();
  }
});

test("GitHub: the label spelled another way by the repository is still the marker label", async () => {
  const gh = await standInGitHub({ labelAs: "SceneScout" });
  try {
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.filed, ["#1", "#2", "#3"]);
  } finally {
    await gh.close();
  }
});

test("GitHub: an API under a path (GitHub Enterprise Server's /api/v3) keeps its path", async () => {
  const gh = await standInGitHub({ prefix: "/api/v3" });
  try {
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: `${gh.url}/api/v3` }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.filed, ["#1"]);
  } finally {
    await gh.close();
  }
});

test("GitHub: creates are a second apart by default, as GitHub asks", async () => {
  const gh = await standInGitHub();
  try {
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE), { pauseMs: undefined });
    assert.deepEqual(run.filed, ["#1", "#2", "#3"]);
    assert.deepEqual(run.waits, [1000, 1000], "between the creates, not before the first");
  } finally {
    await gh.close();
  }
});

test("GitHub: a credential the tracker quotes back in a successful answer is not printed either", async () => {
  const gh = await standInGitHub({ urlSuffix: `?token=${GH_TOKEN}` });
  try {
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    const all = [...run.out, ...run.err].join("\n");
    assert.ok(!all.includes(GH_TOKEN));
    assert.match(all, /filed #1 .*\?token=\[redacted key\]/);
  } finally {
    await gh.close();
  }
});

test("GitHub: a listing that leaves out the bodies is refused, not read as nothing filed", async () => {
  const gh = await standInGitHub({ omitBody: true });
  try {
    gh.issues.push({ number: 1, title: "x", body: githubMarker("aaa0000001"), labels: ["scenescout"], state: "open" });
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /without its number or its body/);
    assert.equal(posts(gh).length, 0);
  } finally {
    await gh.close();
  }
});

test("GitHub: labelled issues that carry no marker are counted, and file nothing", async () => {
  const gh = await standInGitHub();
  try {
    gh.issues.push({ number: 1, title: "filed by hand", body: "Saving a thing answers 500", labels: ["scenescout"], state: "open" });
    gh.issues.push({ number: 2, title: "empty", body: null, labels: ["scenescout"], state: "open" });
    const run = await exportOnce(GH, { GH_TOKEN, GITHUB_API_URL: gh.url }, projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.ok(run.out.some((l) => l.includes("2 issue(s) carry the scenescout label (open or closed), 2 of them with no marker")));
    assert.equal(run.out.filter((l) => l.includes("would file")).length, 3);
  } finally {
    await gh.close();
  }
});

test("GitHub: an address nothing answers on says why, not only that fetch failed", async () => {
  const gone = http.createServer();
  await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(gone.address() as { port: number }).port}`;
  await new Promise<void>((r) => gone.close(() => r()));
  const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: url }, projectWith(THREE), { retries: 0 });
  assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
  assert.match(run.err.join("\n"), /GET \/repos\/owner\/app\/issues failed: .*ECONNREFUSED/);
});

test("Jira: a create that may have been made is never sent again, since Jira's search can lag", async () => {
  const jira = await standInJira();
  try {
    jira.faults.push({ method: "POST", path: /\/rest\/api\/3\/issue$/, status: 500, body: { errorMessages: ["Internal error"] }, then: "answer" });
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.equal(jira.issues.length, 1, "made once, and never sent again");
    assert.equal(jira.seen.filter((x) => x.url === "/rest/api/3/issue").length, 1);
    const said = run.err.join("\n");
    assert.match(said, /creating the issue for finding aaa0000001 \(Saving a thing answers 500\)/);
    assert.match(said, /Jira may have made that issue before the error, and its search can take minutes/);
  } finally {
    await jira.close();
  }
});

test("Jira: issues past the first page of 100 are read, closed ones counted unless --refile-closed", async () => {
  const jira = await standInJira();
  try {
    for (let n = 1; n <= 150; n++)
      jira.issues.push({
        key: `QA-${n}`,
        fields: { labels: ["scenescout"], description: jiraDescription(finding({ id: `old${n}` }), CTX) },
        done: false,
        attachments: [],
      });
    jira.issues[129].fields.description = jiraDescription(finding({ id: "aaa0000001" }), CTX);
    jira.issues.push({
      key: "QA-151",
      fields: { labels: ["scenescout"], description: jiraDescription(finding({ id: "bbb0000002" }), CTX) },
      done: true,
      attachments: [],
    });
    const env = JIRA_ENV(jira.url);
    const dir = projectWith(THREE);
    const any = await exportOnce(["--to", "jira"], env, dir);
    assert.ok(any.out.some((l) => l.includes("aaa0000001") && / as QA-130\b(?! \(closed\))/.test(l)));
    assert.ok(
      any.out.some((l) => l.includes("bbb0000002") && l.endsWith("as QA-151 (closed)")),
      "a closed issue counts as filed by default",
    );
    const open = await exportOnce(["--to", "jira", "--refile-closed"], env, dir);
    assert.ok(open.out.some((l) => l.includes("aaa0000001") && / as QA-130\b(?! \(closed\))/.test(l)));
    assert.ok(open.out.some((l) => l.includes("would file") && l.includes("bbb0000002")));
    assert.deepEqual(jira.violations, []);
  } finally {
    await jira.close();
  }
});

test("Jira: a listing that leaves out the descriptions is refused, not read as nothing filed", async () => {
  const jira = await standInJira({ omitDescription: true });
  try {
    jira.issues.push({
      key: "QA-1",
      fields: { labels: ["scenescout"], description: jiraDescription(finding({ id: "aaa0000001" }), CTX) },
      done: false,
      attachments: [],
    });
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), projectWith(THREE));
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /without its key or its description/);
    assert.equal(jira.issues.length, 1);
  } finally {
    await jira.close();
  }
});

test("Jira: a linked folder in the recordings is not followed out of it", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith([THREE[0]]);
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    const at = "2026-09-30T09:59:30.000Z";
    fs.writeFileSync(path.join(elsewhere, "0002-type.jpg"), "a file outside the recordings folder");
    fs.utimesSync(path.join(elsewhere, "0002-type.jpg"), new Date(at), new Date(at));
    fs.mkdirSync(path.join(dir, ".scenescout", "recordings"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, ".scenescout", "recordings", "default"), process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(
      path.join(dir, ".scenescout", "session-2026-09-30T09-50-00-000Z.jsonl"),
      JSON.stringify({ at, action: "type", url: "http://127.0.0.1:4173/things/new", session: "default", frame: "recordings/default/0002-type.jpg" }) + "\n",
    );
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(jira.issues[0].attachments, []);
    assert.ok(run.out.some((l) => l.includes("Left out 1 frame(s)")));
  } finally {
    await jira.close();
  }
});

test("Jira: a frame that is gone and one over 10 MB are left out, and the export still succeeds", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith([THREE[0]]);
    recordFrame(dir, "0003-click.jpg", "2026-09-30T09:59:00.000Z");
    recordFrame(dir, "0004-click.jpg", "2026-09-30T09:59:30.000Z");
    fs.rmSync(path.join(dir, ".scenescout", "recordings", "default", "0003-click.jpg"));
    const big = path.join(dir, ".scenescout", "recordings", "default", "0004-click.jpg");
    fs.truncateSync(big, 10_000_001);
    fs.utimesSync(big, new Date("2026-09-30T09:59:30.000Z"), new Date("2026-09-30T09:59:30.000Z"));
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(jira.issues[0].attachments, []);
    assert.ok(run.out.some((l) => l.includes("Left out 2 frame(s)")));
    assert.match(JSON.stringify(jira.issues[0].fields.description), /None: the run's frames of these steps are missing/);
  } finally {
    await jira.close();
  }
});

test("Jira: a screenshot that was not attached is still reported when a later create stops the export", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith([THREE[0], THREE[1]]);
    recordFrame(dir, "0003-click.jpg", "2026-09-30T09:59:00.000Z");
    jira.faults.push({ method: "POST", path: /\/attachments$/, status: 413, body: { errorMessages: ["Too large"] } });
    // The first create goes through; the second meets the 400.
    jira.faults.push({ method: "POST", path: /\/rest\/api\/3\/issue$/, status: 400, body: { errors: { issuetype: "Specify a valid issue type" } }, after: 1 });
    const run = await exportOnce(["--to", "jira", "--yes"], JIRA_ENV(jira.url), dir);
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    const said = run.err.join("\n");
    assert.match(said, /QA-1: 20260930T095900Z-0003-click\.jpg was not attached/);
    assert.match(said, /HTTP 400 .*issuetype: Specify a valid issue type/);
    assert.match(said, /Filed before it stopped: QA-1\./);
  } finally {
    await jira.close();
  }
});

test("export: a memory file this version cannot read is refused, not exported as nothing", async () => {
  const dir = projectWith(THREE);
  const memory = path.join(dir, ".scenescout", "memory.json");
  fs.writeFileSync(memory, JSON.stringify({ version: 2, findings: THREE }));
  const newer = await exportOnce(GH, {}, dir);
  assert.equal(newer.exitCode, EXIT_EXPORT.couldNotExport);
  assert.match(newer.err.join("\n"), /is not a memory file this version reads \(version 2\)/);
  fs.writeFileSync(memory, JSON.stringify({ version: 1, findings: {} }));
  const noList = await exportOnce(GH, {}, dir);
  assert.equal(noList.exitCode, EXIT_EXPORT.couldNotExport);
  assert.match(noList.err.join("\n"), /holds no list of findings/);
  fs.writeFileSync(memory, JSON.stringify({ version: 1, findings: [THREE[0], { id: "broken1" }] }));
  const some = await exportOnce(GH, {}, dir);
  assert.equal(some.exitCode, EXIT_EXPORT.done);
  assert.ok(some.out.some((l) => l.includes("Not exported, as this version cannot read them: broken1")));
});

test("the CLI: `scenescout export` files through the stand-in, prints no token, and exits 2 on a bad option", async () => {
  const gh = await standInGitHub();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-export-home-"));
  try {
    const run = promisify(execFile);
    // The whole environment (Windows needs its system variables), with a home and a token of the test's own.
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home, npm_config_prefix: home, GH_TOKEN, GITHUB_API_URL: gh.url };
    const cli = [process.execPath, ["--import", "tsx", path.join(REPO, "src", "cli.ts"), "export"]] as const;
    const ok = await run(cli[0], [...cli[1], ...GH, "--yes", "--project", projectWith([THREE[0]])], { cwd: REPO, env });
    assert.match(ok.stdout, /filed #1/);
    assert.ok(!`${ok.stdout}${ok.stderr}`.includes(GH_TOKEN));
    await assert.rejects(run(cli[0], [...cli[1], ...GH, "--token", "abc"], { cwd: REPO, env }), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, EXIT_EXPORT.couldNotExport);
      assert.match(String(err.stderr), /scenescout export: there is no --token/);
      return true;
    });
    // A token pasted where the repository goes is refused without being printed.
    await assert.rejects(run(cli[0], [...cli[1], "--to", "github", "--repo", GH_TOKEN], { cwd: REPO, env }), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, EXIT_EXPORT.couldNotExport);
      assert.match(String(err.stderr), /--repo is not owner\/name: \[redacted key\]/);
      assert.ok(!String(err.stderr).includes(GH_TOKEN));
      return true;
    });
  } finally {
    await gh.close();
  }
});

// ── tickets, pictures and updates (Jira) ───────────────────────────────────

const TICKET = {
  id: "PROJ-12",
  title: "Save a thing",
  source: "pasted text",
  loadedAt: "2026-09-30T09:00:00.000Z",
  criteria: [
    { id: "AC1", text: "Saving a thing shows it in the list", shape: "numbered" },
    { id: "AC2", text: "A failed save says why", shape: "numbered" },
  ],
};
const verdict = (over: Record<string, unknown>) => ({
  ticket: "PROJ-12",
  criterion: "AC2",
  verdict: "fail",
  findings: ["aaa0000001"],
  confidence: 0.9,
  reason: "the page shows nothing after a 500",
  session: "default",
  at: "2026-09-30T10:00:00.000Z",
  ...over,
});

test("tickets: a finding fails the criteria whose answer is a fail naming it, as the report answers them", () => {
  const memory = {
    tickets: [
      TICKET,
      { id: "#7", title: "A GitHub issue", source: "pasted text", loadedAt: TICKET.loadedAt, criteria: [{ id: "AC1", text: "It loads", shape: "numbered" }] },
      { id: "T1", title: "No key", source: "pasted text", loadedAt: TICKET.loadedAt, criteria: [{ id: "AC1", text: "It saves", shape: "numbered" }] },
      { id: "broken" },
    ],
    criterionVerdicts: [
      verdict({}),
      // A pass in another session does not undo a fail: any fail decides the criterion.
      verdict({ verdict: "pass", findings: [], session: "lane-2" }),
      // A pass names no failing finding.
      verdict({ criterion: "AC1", verdict: "pass", findings: ["bbb0000002"] }),
      verdict({ ticket: "#7", criterion: "AC1", findings: ["aaa0000001"] }),
      verdict({ ticket: "T1", criterion: "AC1", findings: ["aaa0000001"] }),
      // A verdict on a criterion that has since been reworded was about something else.
      verdict({ criterion: "AC1", findings: ["ccc0000003"], text: "Saving shows a toast" }),
      "not a verdict",
    ],
  };
  const byFinding = failedCriteriaByFinding(memory);
  assert.deepEqual(byFinding.get("aaa0000001"), [
    { ticket: "PROJ-12", criterion: "AC2", text: "A failed save says why" },
    { ticket: "#7", criterion: "AC1", text: "It loads" },
    { ticket: "T1", criterion: "AC1", text: "It saves" },
  ]);
  assert.equal(byFinding.has("bbb0000002"), false);
  assert.equal(byFinding.has("ccc0000003"), false);
  assert.deepEqual(ticketsToLink(byFinding.get("aaa0000001")!), ["PROJ-12"], "only a Jira key can be linked to");
  assert.equal(failedCriteriaByFinding({ findings: [] }).size, 0);
  assert.equal(failedCriteriaByFinding(null).size, 0);
  for (const key of ["PROJ-12", "QA_2-1"]) assert.equal(isJiraKey(key), true, key);
  for (const key of ["#12", "T1", "proj-12", "PROJ-0", "PROJ-", "P-1"]) assert.equal(isJiraKey(key), false, key);
});

test("options: --jira-link-type and --jira-update are Jira's, and say what they take", () => {
  assert.deepEqual(parse([...GH, "--jira-update", "off"]), { ok: false, error: "--jira-update is not an option of --to github" });
  assert.deepEqual(parse([...GH, "--jira-link-type", "Blocks"]), { ok: false, error: "--jira-link-type is not an option of --to github" });
  assert.deepEqual(parse([...JIRA, "--jira-update", "yes"]), { ok: false, error: "--jira-update must be on or off" });
  assert.deepEqual(parse([...JIRA, "--jira-link-type", " "]), { ok: false, error: "the Jira link type is empty" });
  assert.equal(jiraOf(options([...JIRA, "--jira-link-type", "NONE"])).linkType, null);
});

/**
 * Jira gives back a stored document with attributes it adds (a local id on
 * each node, a code block's language) and may split one text node into two.
 * None of that is an edit; a word added, removed or reworded is.
 */
function roundTrip(doc: unknown, change?: (texts: Array<{ text: string }>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  const texts: Array<{ text: string }> = [];
  let n = 0;
  const walk = (node: Record<string, unknown>): void => {
    node.attrs = { ...((node.attrs as object) ?? {}), localId: `id-${n++}` };
    const content = node.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;
    const split = content.flatMap((child) =>
      child.type === "text" && typeof child.text === "string" && child.text.length > 6 && !child.marks
        ? [
            { type: "text", text: child.text.slice(0, 3) },
            { type: "text", text: child.text.slice(3) },
          ]
        : [child],
    );
    node.content = split;
    for (const child of split) {
      if (child.type === "text") texts.push(child as { text: string });
      else walk(child);
    }
  };
  walk(copy);
  change?.(texts);
  return copy;
}

test("revision: Jira's round trip leaves it as it was, and a word a person changes moves it", () => {
  const f = finding();
  const { summary, description } = jiraEditFields(f, CTX);
  const recorded = jiraMarkerRevision(description, f.id);
  assert.match(String(recorded), /^[0-9a-f]{16}$/);
  assert.equal(jiraRevision(summary, roundTrip(description)), recorded, "attributes Jira adds and a text node it splits are not an edit");
  assert.equal(jiraMarkerRevision(roundTrip(description), f.id), recorded, "the marker survives the round trip");
  const reworded = roundTrip(description, (t) => {
    t[0].text = `${t[0].text} (triaged: frontend)`;
  });
  assert.notEqual(jiraRevision(summary, reworded), recorded, "a note a person added is an edit");
  assert.notEqual(jiraRevision(`${summary}!`, roundTrip(description)), recorded, "a summary a person reworded is an edit");
  // Things a person pastes that carry no text are edits too: a picture, a mention, a link on existing words.
  const withNode = (node: Record<string, unknown>) => {
    const doc = roundTrip(description) as { content: unknown[] };
    doc.content.splice(1, 0, node);
    return doc;
  };
  assert.notEqual(jiraRevision(summary, withNode({ type: "mediaSingle", content: [{ type: "media", attrs: { id: "x", type: "file" } }] })), recorded);
  assert.notEqual(jiraRevision(summary, withNode({ type: "paragraph", content: [{ type: "mention", attrs: { id: "abc", text: "@Sam" } }] })), recorded);
  const linked = roundTrip(description) as { content: Array<{ content?: Array<Record<string, unknown>> }> };
  linked.content[0].content![0].marks = [{ type: "link", attrs: { href: "https://example.com" } }];
  assert.notEqual(jiraRevision(summary, linked), recorded, "a link a person put on existing words is an edit");
  assert.equal(jiraRevision(summary, withNode({ type: "paragraph", content: [] })), recorded, "an empty line is not");
  assert.equal(jiraMarkerRevision(description, "otherid123"), null, "another finding's marker records nothing for this one");
  // Quoted text cannot pose as a marker carrying a revision, any more than as one without.
  const quoted = jiraDescription(finding({ detail: "scenescout-finding: a1b2c3d4e5 rev 0123456789abcdef" }), CTX);
  assert.notEqual(jiraMarkerRevision(quoted, "a1b2c3d4e5"), "0123456789abcdef");
});

test("upload names: a file is attached under the time it was taken, so a retaken picture or a later run's frame is a new file", () => {
  assert.equal(uploadName("recordings/default/0003-click.jpg", "2026-09-30T09:59:00.123Z"), "20260930T095900Z-0003-click.jpg");
  assert.notEqual(
    uploadName("recordings/default/finding-a1b2c3d4e5.png", "2026-09-30T10:00:00.000Z"),
    uploadName("recordings/default/finding-a1b2c3d4e5.png", "2026-10-02T10:00:00.000Z"),
  );
  assert.equal(uploadName("recordings/default/finding-a1b2c3d4e5.png", undefined), "finding-a1b2c3d4e5.png", "with no time, the file's own name");
});

test("update plan: rewrite only what SceneScout last wrote and has changed; attach and link only what is missing", () => {
  const f = finding();
  const filedCtx: IssueContext = { ...CTX, screenshots: [] };
  const filed = jiraEditFields(f, filedCtx);
  const state = { summary: filed.summary, description: roundTrip(filed.description), attachments: ["finding-a1b2c3d4e5.png"], links: ["PROJ-12"] };
  const same = { ...filed, files: ["finding-a1b2c3d4e5.png"], tickets: ["PROJ-12"] };
  assert.deepEqual(planJiraUpdate(f, state, same), { fields: "same", attach: [], link: [] });

  const later = jiraEditFields(finding({ runs: 3, foundAt: "2026-10-01T10:00:00.000Z" }), filedCtx);
  assert.deepEqual(planJiraUpdate(f, state, { ...later, files: ["finding-a1b2c3d4e5.png", "0003-click.jpg"], tickets: ["PROJ-12", "PROJ-14"] }), {
    fields: "change",
    attach: ["0003-click.jpg"],
    link: ["PROJ-14"],
  });

  const edited = {
    ...state,
    description: roundTrip(filed.description, (t) => {
      t[1].text = "frontend owns this";
    }),
  };
  assert.equal(planJiraUpdate(f, edited, { ...later, files: [], tickets: [] }).fields, "edited");
  assert.equal(planJiraUpdate(f, { ...state, summary: "Renamed in triage" }, { ...later, files: [], tickets: [] }).fields, "edited");
  // Someone pointed this issue at a second finding too: a rewrite would drop that finding's marker.
  const merged = JSON.parse(JSON.stringify(state.description)) as { content: unknown[] };
  merged.content.push({ type: "paragraph", content: [{ type: "text", text: "scenescout-finding: otherid123" }] });
  assert.equal(planJiraUpdate(f, { ...state, description: merged }, { ...later, files: [], tickets: [] }).fields, "edited");

  // An issue filed before markers carried a revision: whether it was edited cannot be told.
  const old = JSON.parse(JSON.stringify(filed.description).replace(/ rev [0-9a-f]{16}/, ""));
  assert.equal(planJiraUpdate(f, { ...state, description: old }, { ...later, files: [], tickets: [] }).fields, "no-revision");
});

test("GitHub issue: the picture and the failed criteria are named, since GitHub takes no upload and no link", () => {
  const body = githubIssue(finding(), {
    ...CTX,
    picture: "recordings/default/finding-a1b2c3d4e5.png",
    criteria: [{ ticket: "PROJ-12", criterion: "AC2", text: "A failed save says why" }],
  }).body;
  assert.match(body, /### Acceptance criteria it fails\n\n- PROJ-12 AC2: A failed save says why/);
  assert.match(body, /The picture taken when it was filed is in the run's `\.scenescout\/` folder, not attached .*finding-a1b2c3d4e5\.png/);
  assert.match(body, /No frames of the steps before it were kept\./);
  assert.doesNotMatch(githubIssue(finding(), CTX).body, /Acceptance criteria|picture taken/);
});

/** A project whose memory holds tickets and verdicts beside its findings. */
function projectWithTickets(findings: Finding[], tickets: unknown[], verdicts: unknown[]): string {
  const dir = projectWith(findings);
  const file = path.join(dir, ".scenescout", "memory.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), tickets, criterionVerdicts: verdicts }));
  return dir;
}

/** The finding's own picture, where scout_finding writes it. */
function writePicture(dir: string, id: string): string {
  const rel = `recordings/default/finding-${id}.png`;
  const file = path.join(dir, ".scenescout", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return rel;
}

test("Jira: the finding's picture is attached first, and the issue is linked to the ticket whose criterion it fails", async () => {
  const jira = await standInJira({ tickets: ["PROJ-12"] });
  try {
    const dir = projectWithTickets([{ ...THREE[0] }, THREE[1]], [TICKET], [verdict({})]);
    const picture = writePicture(dir, "aaa0000001");
    const memory = path.join(dir, ".scenescout", "memory.json");
    const m = JSON.parse(fs.readFileSync(memory, "utf8"));
    m.findings[0].picture = picture;
    fs.writeFileSync(memory, JSON.stringify(m));
    recordFrame(dir, "0003-click.jpg", "2026-09-30T09:59:00.000Z");
    const env = JIRA_ENV(jira.url);

    const dry = await exportOnce(["--to", "jira"], env, dir);
    assert.ok(dry.out.some((l) => l.includes("would file") && l.includes("aaa0000001") && l.includes("with 2 screenshot(s)")));
    assert.equal(posts(jira).filter((x) => x.url !== "/rest/api/3/search/jql").length, 0, "a dry run sends nothing but reads");

    const run = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.deepEqual(run.filed, ["QA-1", "QA-2"]);
    const [qa1, qa2] = jira.issues;
    assert.deepEqual(qa1.attachments, ["finding-aaa0000001.png", "20260930T095900Z-0003-click.jpg"]);
    assert.deepEqual(qa1.links, ["Relates:PROJ-12"]);
    assert.equal(qa2.links, undefined, "a finding that fails no criterion links nothing");
    const text = JSON.stringify(qa1.fields.description);
    assert.match(text, /Acceptance criteria it fails/);
    assert.match(text, /PROJ-12 AC2: A failed save says why/);
    assert.match(text, /Attached: finding-aaa0000001\.png, the picture taken when it was filed\./);
    const link = jira.seen.find((x) => x.url === "/rest/api/3/issueLink")!;
    assert.deepEqual(JSON.parse(link.raw.toString("utf8")), { type: { name: "Relates" }, inwardIssue: { key: "QA-1" }, outwardIssue: { key: "PROJ-12" } });
    assert.ok(!`${run.out.join("\n")}${run.err.join("\n")}`.includes(JIRA_TOKEN));
    assert.deepEqual(jira.violations, []);

    // --jira-link-type none links nothing, and --screenshots off attaches nothing.
    const other = await standInJira({ tickets: ["PROJ-12"] });
    try {
      const quiet = await exportOnce(["--to", "jira", "--yes", "--jira-link-type", "none", "--screenshots", "off"], JIRA_ENV(other.url), dir);
      assert.equal(quiet.exitCode, EXIT_EXPORT.done, quiet.err.join("\n"));
      assert.equal(other.issues[0].links, undefined);
      assert.deepEqual(other.issues[0].attachments, []);
      assert.equal(other.seen.filter((x) => x.url === "/rest/api/3/issueLink").length, 0);
    } finally {
      await other.close();
    }
  } finally {
    await jira.close();
  }
});

test("Jira: a ticket the site does not have is reported and fails the export; the issue stays filed once", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWithTickets([THREE[0]], [TICKET], [verdict({})]);
    const env = JIRA_ENV(jira.url);
    const run = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.deepEqual(run.filed, ["QA-1"]);
    assert.match(run.err.join("\n"), /QA-1: not linked to PROJ-12 \(.*HTTP 404.*\); check that PROJ-12 is an issue on this site/);
    const again = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.deepEqual(again.filed, [], "the next export does not file it again");
    assert.equal(jira.issues.length, 1);
  } finally {
    await jira.close();
  }
});

test("Jira: a later export updates an open issue in place: new text, the picture and the link it lacks; never a second issue", async () => {
  const jira = await standInJira({ tickets: ["PROJ-12"] });
  try {
    const dir = projectWith([THREE[0], THREE[1]]);
    const env = JIRA_ENV(jira.url);
    const first = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.deepEqual(first.filed, ["QA-1", "QA-2"]);

    // A later run finds the first defect again, takes its picture, and judges it against a ticket.
    const memory = path.join(dir, ".scenescout", "memory.json");
    const m = JSON.parse(fs.readFileSync(memory, "utf8"));
    m.findings[0] = { ...m.findings[0], runs: 3, foundAt: "2026-10-01T10:00:00.000Z", picture: writePicture(dir, "aaa0000001") };
    m.tickets = [TICKET];
    m.criterionVerdicts = [verdict({})];
    fs.writeFileSync(memory, JSON.stringify(m));
    // Someone triaging the second issue adds a note to its description.
    const desc = jira.issues[1].fields.description as { content: Array<Record<string, unknown>> };
    desc.content.splice(1, 0, { type: "paragraph", content: [{ type: "text", text: "Frontend owns this." }] });

    const dry = await exportOnce(["--to", "jira"], env, dir);
    assert.ok(
      dry.out.some((l) => / as QA-1; would rewrite its summary and description, attach finding-aaa0000001\.png, link it to PROJ-12$/.test(l)),
      dry.out.join("\n"),
    );
    assert.equal(jira.seen.filter((x) => x.method === "PUT" || x.url.endsWith("/attachments") || x.url.endsWith("/issueLink")).length, 0);

    const second = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(second.exitCode, EXIT_EXPORT.done, second.err.join("\n"));
    assert.deepEqual(second.filed, []);
    assert.equal(jira.issues.length, 2, "updated, never filed again");
    const [qa1, qa2] = jira.issues;
    assert.equal(qa1.edits, 1);
    assert.match(JSON.stringify(qa1.fields.description), /Runs that found it: 3/);
    assert.match(JSON.stringify(qa1.fields.description), /PROJ-12 AC2/);
    assert.deepEqual(qa1.attachments, ["finding-aaa0000001.png"]);
    assert.deepEqual(qa1.links, ["Relates:PROJ-12"]);
    assert.equal(qa2.edits, undefined, "a description someone edited is left as they wrote it");
    assert.match(JSON.stringify(qa2.fields.description), /Frontend owns this\./);
    assert.ok(second.out.some((l) => l.includes("updated QA-1")));
    assert.ok(second.out.some((l) => / as QA-2; its summary or description was edited in Jira, so it is left as written$/.test(l)));
    assert.ok(second.out.some((l) => l.startsWith("Filed 0; 2 already filed, 1 of them updated")));
    assert.deepEqual(jira.violations, []);

    // Nothing has changed since: the third export writes nothing.
    const third = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(jira.seen.filter((x) => x.method === "PUT").length, 1);
    assert.ok(third.out.some((l) => / as QA-1, up to date$/.test(l)));
  } finally {
    await jira.close();
  }
});

test("Jira: --jira-update off, a closed issue and an issue from an earlier version are listed and never edited", async () => {
  const jira = await standInJira({ tickets: ["PROJ-12"] });
  try {
    const dir = projectWithTickets([THREE[0], THREE[1], THREE[2]], [TICKET], [verdict({})]);
    const env = JIRA_ENV(jira.url);
    await exportOnce(["--to", "jira", "--yes", "--jira-link-type", "none"], env, dir);
    jira.issues[1].done = true;
    jira.issues[2].fields.description = JSON.parse(JSON.stringify(jira.issues[2].fields.description).replace(/ rev [0-9a-f]{16}/, ""));
    const memory = path.join(dir, ".scenescout", "memory.json");
    const m = JSON.parse(fs.readFileSync(memory, "utf8"));
    for (const f of m.findings) f.runs = 5;
    fs.writeFileSync(memory, JSON.stringify(m));

    const off = await exportOnce(["--to", "jira", "--yes", "--jira-update", "off"], env, dir);
    assert.equal(off.exitCode, EXIT_EXPORT.done, off.err.join("\n"));
    assert.equal(jira.seen.filter((x) => x.method === "PUT" || x.url.endsWith("/issueLink")).length, 0);
    assert.ok(off.out.some((l) => /already filed .* as QA-1$/.test(l)));

    const on = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(on.exitCode, EXIT_EXPORT.done, on.err.join("\n"));
    assert.equal(jira.issues[0].edits, 1);
    assert.deepEqual(jira.issues[0].links, ["Relates:PROJ-12"], "the link an earlier export left out is made now");
    assert.equal(jira.issues[1].edits, undefined, "a closed issue is the team's decision");
    assert.ok(on.out.some((l) => /already filed .* as QA-2 \(closed\)$/.test(l)));
    assert.equal(jira.issues[2].edits, undefined);
    assert.ok(on.out.some((l) => / as QA-3; it was filed by an earlier version, so its summary and description are left as they are$/.test(l)));
  } finally {
    await jira.close();
  }
});

test("Jira: an update whose every link fails says nothing was updated, and fails the export", async () => {
  const jira = await standInJira();
  try {
    const dir = projectWith([THREE[0]]);
    const env = JIRA_ENV(jira.url);
    await exportOnce(["--to", "jira", "--yes"], env, dir);
    // Someone edits the issue, so its text is theirs; then a run finds the defect fails a ticket the site does not have.
    jira.issues[0].fields.summary = "Saving fails (triaged)";
    const memory = path.join(dir, ".scenescout", "memory.json");
    fs.writeFileSync(memory, JSON.stringify({ ...JSON.parse(fs.readFileSync(memory, "utf8")), tickets: [TICKET], criterionVerdicts: [verdict({})] }));
    const run = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.ok(
      run.out.some((l) => / as QA-1; nothing could be updated; its summary or description was edited in Jira/.test(l)),
      run.out.join("\n"),
    );
    assert.ok(!run.out.some((l) => l.includes("updated QA-1")));
    assert.ok(run.out.some((l) => l.startsWith("Filed 0; 1 already filed.")));
    assert.match(run.err.join("\n"), /QA-1: not linked to PROJ-12/);
    assert.equal(jira.issues[0].edits, undefined);
  } finally {
    await jira.close();
  }
});

// ── a listing that lags behind a create ─────────────────────────────────────

const recordOf = (dir: string): string => path.join(dir, ".scenescout", EXPORT_RECORD_FILE);

test("record: read back as written, refused when it cannot be read, keyed by tracker and place", () => {
  assert.deepEqual(parseExportRecord(null), { ok: true, value: {} });
  const filed = { ref: "#3", number: 3, url: "https://github.example/owner/app/issues/3", at: "2026-10-03T10:00:00.000Z" };
  const text = recordWith({}, "github https://api.github.com owner/app", "aaa0000001", filed);
  const read = parseExportRecord(text);
  assert.deepEqual(read, { ok: true, value: { "github https://api.github.com owner/app": { aaa0000001: filed } } });
  // Another entry is added beside the first, and the record passed in is left as it was.
  const before = read.ok ? read.value : {};
  const again = parseExportRecord(recordWith(before, "jira https://example.atlassian.net QA", "bbb0000002", { uncertain: true, at: filed.at }));
  assert.ok(again.ok && Object.keys(again.value).length === 2);
  assert.equal(Object.keys(before).length, 1);
  for (const bad of [
    "{",
    "[]",
    '{"version":2,"trackers":{}}',
    '{"version":1}',
    '{"version":1,"trackers":{"k":{"aaa0000001":{"ref":"#1"}}}}',
    '{"version":1,"trackers":{"k":{"no spaces":{"uncertain":true,"at":"x"}}}}',
  ])
    assert.equal(parseExportRecord(bad).ok, false, bad);

  const gh = (apiUrl: string, repo: string) => recordKey({ to: "github", github: { repo, apiUrl } });
  assert.equal(gh("https://api.github.com/", "owner/app"), gh("https://api.github.com", "owner/app"));
  assert.notEqual(gh("https://api.github.com", "owner/app"), gh("https://api.github.com", "owner/other"));
  assert.notEqual(gh("https://api.github.com", "owner/app"), gh("https://ghe.example/api/v3", "owner/app"));
  const jiraKey = recordKey({
    to: "jira",
    jira: { baseUrl: "https://example.atlassian.net", projectKey: "QA", issueType: "Bug", linkType: null, update: true },
  });
  assert.match(jiraKey, /^jira https:\/\/example\.atlassian\.net QA$/);
});

test("record: a create that may have been made holds its finding back for a while, and never for good", () => {
  const at = Date.parse("2026-10-03T10:00:00.000Z");
  const uncertain = { uncertain: true as const, at: new Date(at).toISOString() };
  assert.equal(uncertainHolds(uncertain, at + 1000), true);
  assert.equal(uncertainHolds(uncertain, at + UNCERTAIN_HOLD_MS - 1), true);
  assert.equal(uncertainHolds(uncertain, at + UNCERTAIN_HOLD_MS), false);
  // A clock set far ahead, or a time that cannot be read, does not hold a finding back for good.
  assert.equal(uncertainHolds(uncertain, at - 2 * UNCERTAIN_HOLD_MS), false);
  assert.equal(uncertainHolds({ uncertain: true, at: "not a time" }, at), false);
  assert.equal(uncertainHolds({ ref: "#1", number: 1, url: "u", at: uncertain.at }, at), false);
});

test("GitHub: an export straight after another files nothing, though the labelled list does not show the new issues yet", async () => {
  const gh = await standInGitHub({ lag: true });
  try {
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const first = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(first.exitCode, EXIT_EXPORT.done, first.err.join("\n"));
    assert.equal(gh.issues.length, 3);
    const second = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(second.exitCode, EXIT_EXPORT.done, second.err.join("\n"));
    assert.equal(gh.issues.length, 3, "nothing filed twice");
    assert.match(second.out.join("\n"), /Filed 0; 3 already filed/);

    // On another machine there is no record: the newest issues, listed with no label filter, show them.
    fs.rmSync(recordOf(dir));
    const fresh = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(fresh.exitCode, EXIT_EXPORT.done, fresh.err.join("\n"));
    assert.equal(gh.issues.length, 3, "nothing filed twice from a fresh record either");
  } finally {
    await gh.close();
  }
});

test("GitHub: with no list showing the new issues yet, the numbers the record holds are what keep a second export from filing them", async () => {
  const gh = await standInGitHub({ lag: true, lagEverywhere: true });
  try {
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const first = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(first.exitCode, EXIT_EXPORT.done, first.err.join("\n"));
    const second = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(second.exitCode, EXIT_EXPORT.done, second.err.join("\n"));
    assert.equal(gh.issues.length, 3, "nothing filed twice");
    assert.match(second.out.join("\n"), /3 more finding\(s\) found filed by the issue number recorded in/);
    assert.deepEqual(
      gh.seen.filter((x) => x.method === "GET" && /\/issues\/\d+$/.test(x.url)).map((x) => x.url.split("/").at(-1)),
      ["1", "2", "3"],
    );
  } finally {
    await gh.close();
  }
});

test("GitHub: a dry run with credentials reads the tracker and writes no record", async () => {
  const gh = await standInGitHub();
  try {
    const dir = projectWith(THREE);
    const run = await exportOnce(GH, { GH_TOKEN, GITHUB_API_URL: gh.url }, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.ok(gh.seen.length > 0, "the tracker was asked");
    assert.equal(fs.existsSync(recordOf(dir)), false);
  } finally {
    await gh.close();
  }
});

test("GitHub: a create that failed after the tracker made the issue is found by its marker while the labelled list lags", async () => {
  const gh = await standInGitHub({ lag: true });
  try {
    gh.faults.push({ method: "POST", path: /\/issues$/, status: 500, body: { message: "Server Error" }, then: "answer" });
    const dir = projectWith(THREE);
    const run = await exportOnce([...GH, "--yes", "--only", "aaa0000001"], { GH_TOKEN, GITHUB_API_URL: gh.url }, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.done, run.err.join("\n"));
    assert.equal(gh.issues.length, 1, "one issue, not two");
    assert.deepEqual(run.filed, ["#1"]);
    // Found that way, it is recorded like any other.
    const record = parseExportRecord(fs.readFileSync(recordOf(dir), "utf8"));
    assert.ok(record.ok && Object.values(record.value)[0].aaa0000001 && "number" in Object.values(record.value)[0].aaa0000001);
  } finally {
    await gh.close();
  }
});

test("GitHub: a recorded issue that is gone, closed under --refile-closed, or carries another marker is filed again", async () => {
  const gh = await standInGitHub({ lag: true });
  try {
    const env = { GH_TOKEN, GITHUB_API_URL: gh.url };
    const dir = projectWith(THREE);
    const first = await exportOnce([...GH, "--yes"], env, dir);
    assert.equal(first.exitCode, EXIT_EXPORT.done, first.err.join("\n"));
    gh.settle();
    // #1 is deleted, #2 closed, and #3 rewritten to carry no marker.
    gh.issues.splice(0, 1);
    gh.issues[0].state = "closed";
    gh.issues[1].body = "Rewritten by hand.";
    const second = await exportOnce([...GH, "--yes", "--refile-closed"], env, dir);
    assert.equal(second.exitCode, EXIT_EXPORT.done, second.err.join("\n"));
    assert.equal(posts(gh).length, 6, "each of the three filed again");
  } finally {
    await gh.close();
  }
});

test("export: a record that cannot be read ends the export before anything is filed", async () => {
  const gh = await standInGitHub();
  try {
    const dir = projectWith(THREE);
    fs.writeFileSync(recordOf(dir), "{ not json");
    const run = await exportOnce([...GH, "--yes"], { GH_TOKEN, GITHUB_API_URL: gh.url }, dir);
    assert.equal(run.exitCode, EXIT_EXPORT.couldNotExport);
    assert.match(run.err.join("\n"), /could not read .*exported\.json: it is not JSON.*move it aside/);
    assert.equal(posts(gh).length, 0);
    // A dry run with no credentials asks the tracker nothing, so it does not need the record either.
    const dry = await exportOnce(GH, {}, dir);
    assert.equal(dry.exitCode, EXIT_EXPORT.done, dry.err.join("\n"));
  } finally {
    await gh.close();
  }
});

test("Jira: an export straight after another files nothing, though the search does not show the new issues yet", async () => {
  const jira = await standInJira({ lag: true });
  try {
    const env = JIRA_ENV(jira.url);
    const dir = projectWith(THREE);
    const first = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(first.exitCode, EXIT_EXPORT.done, first.err.join("\n"));
    assert.equal(jira.issues.length, 3);
    const second = await exportOnce(["--to", "jira", "--yes"], env, dir);
    assert.equal(second.exitCode, EXIT_EXPORT.done, second.err.join("\n"));
    assert.equal(jira.issues.length, 3, "nothing filed twice");
    assert.match(second.out.join("\n"), /3 more finding\(s\) found filed by the issue number recorded in/);
    assert.match(second.out.join("\n"), /Filed 0; 3 already filed/);
  } finally {
    await jira.close();
  }
});

test("Jira: a finding whose create may have been made is held back while the search does not show it, then found or filed", async () => {
  const jira = await standInJira({ lag: true });
  try {
    const env = JIRA_ENV(jira.url);
    const dir = projectWith([THREE[0]]);
    const at = Date.parse("2026-10-03T10:00:00.000Z");
    // Made, then answered with a 500.
    jira.faults.push({ method: "POST", path: /\/rest\/api\/3\/issue$/, status: 500, body: { errorMessages: ["Internal error"] }, then: "answer" });
    const first = await exportOnce(["--to", "jira", "--yes"], env, dir, { now: () => at });
    assert.equal(first.exitCode, EXIT_EXPORT.couldNotExport);
    assert.equal(jira.issues.length, 1);

    const soon = await exportOnce(["--to", "jira", "--yes"], env, dir, { now: () => at + 60_000 });
    assert.equal(soon.exitCode, EXIT_EXPORT.couldNotExport, "held back, so not done");
    assert.equal(jira.issues.length, 1, "not filed twice while the search lags");
    assert.match(soon.out.join("\n"), /Filed 0; 0 already filed; 1 held back\./);
    assert.match(soon.out.join("\n"), /held back\s+high\s+Saving a thing answers 500  \[finding aaa0000001\]/);
    assert.match(soon.err.join("\n"), /finding aaa0000001 was held back: .*An export after 2026-10-03T10:15:00\.000Z files it/);
    // A dry run lists the hold and files nothing either way, so it is not a failure there.
    const dry = await exportOnce(["--to", "jira"], env, dir, { now: () => at + 60_000 });
    assert.equal(dry.exitCode, EXIT_EXPORT.done, dry.err.join("\n"));
    assert.match(dry.out.join("\n"), /held back\s+high/);

    jira.settle();
    const later = await exportOnce(["--to", "jira", "--yes"], env, dir, { now: () => at + UNCERTAIN_HOLD_MS + 1 });
    assert.equal(later.exitCode, EXIT_EXPORT.done, later.err.join("\n"));
    assert.equal(jira.issues.length, 1, "found by its marker once the search shows it");
  } finally {
    await jira.close();
  }
});

test("Jira: a create that failed before Jira made the issue is filed by an export after the hold", async () => {
  const jira = await standInJira({ lag: true });
  try {
    const env = JIRA_ENV(jira.url);
    const dir = projectWith([THREE[0]]);
    const at = Date.parse("2026-10-03T10:00:00.000Z");
    // Refused with a 503 and never made.
    jira.faults.push({ method: "POST", path: /\/rest\/api\/3\/issue$/, status: 503, body: { errorMessages: ["Unavailable"] } });
    const first = await exportOnce(["--to", "jira", "--yes"], env, dir, { now: () => at });
    assert.equal(first.exitCode, EXIT_EXPORT.couldNotExport);
    assert.equal(jira.issues.length, 0);
    const later = await exportOnce(["--to", "jira", "--yes"], env, dir, { now: () => at + UNCERTAIN_HOLD_MS + 1 });
    assert.equal(later.exitCode, EXIT_EXPORT.done, later.err.join("\n"));
    assert.equal(jira.issues.length, 1);
  } finally {
    await jira.close();
  }
});
