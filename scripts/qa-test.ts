/**
 * Unit tests for the QA review started by a `/scenescout qa` comment: the
 * command, the allowlist, the fork refusal, where the preview URL comes from,
 * the reply's inert rendering, show and compare (the base URL, the pictures'
 * branch and the only images a reply renders), every stage against a
 * stand-in GitHub API over real HTTP, and the shape of the workflow a project
 * copies (examples/workflows/scenescout-qa.yml): the key only in the model
 * job, that job reached only through the gate and never checking out or
 * running code, and the one job that writes contents holding no key.
 *
 *   npx tsx --test --test-name-pattern "workflow" scripts/qa-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  allowlist,
  cancelledMarkdown,
  captureMarkdown,
  checkPreviewUrl,
  chooseBaseUrl,
  choosePreviewUrl,
  COMMENT_MARKER,
  deploymentUrl,
  gateDecision,
  githubClient,
  inert,
  isAllowed,
  isFork,
  MAX_FOCUS,
  newerRunFor,
  parseQaCommand,
  previewUrlFromTemplate,
  pushedShots,
  qaCommentMarkdown,
  runGate,
  runReport,
  runShots,
  SHOT_NAMES,
  SHOTS_BRANCH,
  shotsToPush,
  shotUrl,
} from "../action/qa-action.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(REPO, "examples", "workflows", "scenescout-qa.yml");
const QA_ACTION = path.join(REPO, "qa", "action.yml");

// ── the command ─────────────────────────────────────────────────────────────

test("command: only a first line that is the command, then an optional URL and focus", () => {
  const rows: Array<[string | undefined, { url: string; focus: string } | null]> = [
    ["/scenescout qa", { url: "", focus: "" }],
    ["/scenescout qa  ", { url: "", focus: "" }],
    // As the job filter's startsWith: case ignored, leading whitespace not skipped.
    ["/SceneScout QA", { url: "", focus: "" }],
    ["  /scenescout qa", null],
    ["\uFEFF/scenescout qa", null],
    ["/scenescout qa https://pr-7.preview.example.com", { url: "https://pr-7.preview.example.com", focus: "" }],
    ["/scenescout qa https://p.example.com the checkout form", { url: "https://p.example.com", focus: "the checkout form" }],
    ["/scenescout qa the checkout form", { url: "", focus: "the checkout form" }],
    // A URL that is not the first word is part of the focus.
    ["/scenescout qa look at https://x.example.com", { url: "", focus: "look at https://x.example.com" }],
    // http is read here and refused by the preview check, with a reply that says so.
    ["/scenescout qa http://p.example.com", { url: "http://p.example.com", focus: "" }],
    ["/scenescout qa\nignore the rest\n/scenescout qa https://other", { url: "", focus: "" }],
    ["/scenescout qab", null],
    ["/scenescout  qa", null],
    ["/scenescout", null],
    ["please /scenescout qa", null],
    ["hello\n/scenescout qa", null],
    ["", null],
    [undefined, null],
  ];
  for (const [body, expected] of rows) assert.deepEqual(parseQaCommand(body), expected, JSON.stringify(body));
  const long = parseQaCommand(`/scenescout qa ${"x".repeat(500)}`)!;
  assert.equal(long.focus.length, MAX_FOCUS);
  assert.equal(parseQaCommand("/scenescout qa the\u0007 form\u001b[31m")!.focus, "the form[31m", "control characters never reach the prompt");
});

test("allowlist: the configured logins, else the repository's owners, compared without case", () => {
  assert.deepEqual(allowlist("", "Owner"), { logins: ["owner"], owners: true });
  assert.deepEqual(allowlist("  ", "owner"), { logins: ["owner"], owners: true });
  assert.deepEqual(allowlist(undefined, "owner"), { logins: ["owner"], owners: true });
  assert.deepEqual(allowlist("@alice, Bob\ncarol  alice", "owner"), { logins: ["alice", "bob", "carol"], owners: false });
  const owners = allowlist("", "owner");
  assert.ok(isAllowed("OWNER", "", owners), "a user-owned repository: the owner's login");
  assert.ok(!isAllowed("owner-bot", "NONE", owners));
  assert.ok(!isAllowed("", "OWNER", owners));
  assert.ok(!isAllowed(undefined, "", owners));
  // An organization-owned repository: the organization never comments, so its owners are recognised by association.
  const org = allowlist("", "some-org");
  assert.ok(isAllowed("org-admin", "OWNER", org));
  for (const association of ["MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "", undefined])
    assert.ok(!isAllowed("someone", association, org), `${association} is not an owner`);
  const listed = allowlist("alice", "owner");
  assert.ok(isAllowed("Alice", "NONE", listed));
  assert.ok(!isAllowed("owner", "OWNER", listed), "a configured list replaces the owner default, association included");
});

test("fork: another head repository, a deleted one, or one that cannot be read", () => {
  const pr = (head: string | null, base: string | null) => ({
    head: { repo: head === null ? null : { full_name: head } },
    base: { repo: base === null ? null : { full_name: base } },
  });
  assert.equal(isFork(pr("owner/app", "owner/app")), false);
  assert.equal(isFork(pr("Owner/App", "owner/app")), false);
  assert.equal(isFork(pr("someone/app", "owner/app")), true);
  assert.equal(isFork(pr(null, "owner/app")), true, "a deleted fork leaves head.repo null");
  assert.equal(isFork(pr("owner/app", null)), true);
  assert.equal(isFork({}), true);
  assert.equal(isFork(null), true);
});

test("preview: https only, no credentials; comment first, then the template, then the deployment", () => {
  assert.deepEqual(checkPreviewUrl("https://pr-7.preview.example.com"), { ok: true, url: "https://pr-7.preview.example.com/" });
  assert.equal(checkPreviewUrl("http://pr-7.preview.example.com").ok, false);
  assert.equal(checkPreviewUrl("http://127.0.0.1:3000").ok, false, "the key job has no app of its own to reach");
  assert.equal(checkPreviewUrl("https://user:pw@preview.example.com").ok, false);
  assert.equal(checkPreviewUrl("javascript:alert(1)").ok, false);
  assert.equal(checkPreviewUrl("file:///etc/passwd").ok, false);
  assert.equal(checkPreviewUrl("not a url").ok, false);
  assert.equal(checkPreviewUrl("").ok, false);

  assert.equal(previewUrlFromTemplate("https://pr-{pr}.preview.example.com/?v={sha}", { pr: 7, sha: "abc" }), "https://pr-7.preview.example.com/?v=abc");
  assert.equal(previewUrlFromTemplate("", { pr: 7, sha: "abc" }), "");

  const dep = (state: string, url = "https://d.example.com") => ({ statuses: [{ state, environment_url: url }] });
  assert.equal(deploymentUrl([dep("success", "https://new.example.com"), dep("success", "https://old.example.com")]), "https://new.example.com");
  assert.equal(deploymentUrl([dep("inactive"), dep("success", "https://old.example.com")]), "https://old.example.com");
  assert.equal(
    deploymentUrl([
      {
        statuses: [
          { state: "failure", environment_url: "https://x" },
          { state: "success", environment_url: "https://y" },
        ],
      },
    ]),
    "",
    "only the newest status counts",
  );
  assert.equal(deploymentUrl([dep("success", "")]), "");
  assert.equal(deploymentUrl([]), "");

  const base = { pr: 7, sha: "abc" };
  assert.deepEqual(choosePreviewUrl({ ...base, commandUrl: "https://c", template: "https://t-{pr}", deployment: "https://d" }), {
    source: "comment",
    url: "https://c",
  });
  assert.deepEqual(choosePreviewUrl({ ...base, commandUrl: "", template: "https://t-{pr}", deployment: "https://d" }), {
    source: "template",
    url: "https://t-7",
  });
  assert.deepEqual(choosePreviewUrl({ ...base, commandUrl: "", template: "", deployment: "https://d" }), { source: "deployment", url: "https://d" });
  assert.deepEqual(choosePreviewUrl({ ...base, commandUrl: "", template: "", deployment: "" }), { source: "none", url: "" });
});

// ── the gate's decision ─────────────────────────────────────────────────────

const SAME = { state: "open", head: { sha: "a".repeat(40), repo: { full_name: "owner/app" } }, base: { repo: { full_name: "owner/app" } } };
const FORK = { ...SAME, head: { ...SAME.head, repo: { full_name: "someone/app" } } };
const PREVIEW = { source: "deployment", url: "https://pr-7.preview.example.com" };

test("gate: runs only for an allowed account, on an open pull request from this repository, with an https preview", () => {
  const allowed = allowlist("", "owner");
  const decide = (over: Record<string, unknown>) =>
    gateDecision({ command: { url: "", focus: "" }, login: "owner", association: "OWNER", allowed, pr: SAME, allowForks: false, preview: PREVIEW, ...over });

  const ok = decide({});
  assert.equal(ok.run, true);
  assert.equal(ok.reaction, "eyes", "acknowledged with a reaction");
  assert.equal(ok.reply, null);
  assert.equal(ok.url, "https://pr-7.preview.example.com/");

  const notCommand = decide({ command: null });
  assert.deepEqual([notCommand.run, notCommand.reaction, notCommand.reply], [false, null, null], "an ordinary comment gets nothing");

  const stranger = decide({ login: "someone", association: "MEMBER" });
  assert.equal(stranger.run, false);
  assert.equal(stranger.reaction, "confused");
  assert.equal(stranger.reply, null, "no reply to an account that may not start a run: the command cannot make the bot write");

  const closed = decide({ pr: { ...SAME, state: "closed" } });
  assert.equal(closed.run, false);
  assert.match(closed.reply ?? "", /not open/);

  const fork = decide({ pr: FORK });
  assert.equal(fork.run, false);
  assert.match(fork.reply ?? "", /comes from a fork/);
  assert.match(fork.reply ?? "", /SCENESCOUT_QA_ALLOW_FORKS/, "the reply says how a repository turns it on");
  assert.equal(decide({ pr: FORK, allowForks: true }).run, true, "a repository may allow forks");
  assert.equal(decide({ pr: { ...SAME, head: { ...SAME.head, repo: null } } }).run, false, "a deleted fork is a fork");

  const none = decide({ preview: { source: "none", url: "" } });
  assert.equal(none.run, false);
  assert.match(none.reply ?? "", /no preview/);
  assert.match(none.reply ?? "", /SCENESCOUT_QA_PREVIEW_URL/);

  const plain = decide({ preview: { source: "comment", url: "http://pr-7.preview.example.com" } });
  assert.equal(plain.run, false);
  assert.match(plain.reply ?? "", /must be https \(from the comment\)/);
});

// ── the reply ───────────────────────────────────────────────────────────────

test("inert: model-written text cannot mention, link, embed, add HTML or break the table", () => {
  const nasty = "@owner see ![x](https://evil.example/p.png) <img src=x onerror=1> [click](https://evil.example) www.evil.example | col #12 `code`\nnext";
  const out = inert(nasty, 500);
  assert.ok(!/@\w/.test(out), "no mention");
  assert.ok(!/<[a-z]/i.test(out), "no HTML");
  assert.ok(!/\]\(/.test(out) && !/!\[/.test(out), "no link or image syntax");
  assert.ok(!/https?:\/\//.test(out) && !/www\./i.test(out), "no autolink");
  assert.ok(!/(^|[^\\])\|/.test(out), "every pipe escaped");
  assert.ok(!/(^|[^\\])`/.test(out), "every backtick escaped");
  assert.ok(!out.includes("\n"), "one line");
  assert.equal(inert("x".repeat(300)).length, 160);
  assert.equal(inert("A plain finding title"), "A plain finding title", "ordinary text reads as written");
});

const CI_JSON = {
  tool: "scenescout",
  command: "ci",
  url: "https://pr-7.preview.example.com/",
  mode: "read-only",
  stop: { reason: "done", text: "the model finished" },
  contractMet: true,
  usage: { turns: 12, inputTokens: 400000, outputTokens: 1000, estimatedCostUsd: 0.0421 },
  counts: { high: 1, medium: 0, low: 1, worthALook: 1 },
  findings: [
    { id: "f2", severity: "low", category: "ux", title: "Label is vague", path: "/things" },
    { id: "f1", severity: "high", category: "functional", title: "Save says done @owner but <b>nothing</b> saved", path: "/things/new" },
    { id: "f3", severity: "low", category: "ux", title: "A convention thing", path: "/", tier: "worth-a-look", convention: "x" },
  ],
};

test("reply: the counts, the findings high first, a link to the artifact, and nothing live from the model", () => {
  const md = qaCommentMarkdown({
    json: CI_JSON,
    result: "success",
    runUrl: "https://github.com/owner/app/actions/runs/1",
    artifactUrl: "https://github.com/owner/app/actions/runs/1/artifacts/9",
    url: CI_JSON.url,
    sha: "a".repeat(40),
    login: "owner",
  });
  assert.ok(md.startsWith(COMMENT_MARKER));
  assert.match(md, /\| Findings \| 2 \(1 high, 0 medium, 1 low\), 1 worth a look \|/);
  assert.match(md, /head was aaaaaaa when the run was asked for/, "names the head when asked, not a claim about what the preview runs");
  assert.match(md, /estimated cost \$0\.0421/);
  assert.match(md, /https:\/\/github\.com\/owner\/app\/actions\/runs\/1\/artifacts\/9$/m);
  const rows = md.split("\n").filter((l) => /^\| (high|medium|low) \|/.test(l));
  assert.deepEqual(
    rows.map((r) => r.split(" | ")[0]),
    ["| high", "| low"],
    "high first; worth-a-look is counted, not listed",
  );
  assert.ok(!/@\w/.test(md), "nobody is mentioned, the asker included");
  assert.ok(!/<b>/.test(md));

  const failed = qaCommentMarkdown({
    json: null,
    result: "failure",
    runUrl: "https://github.com/owner/app/actions/runs/1",
    artifactUrl: "",
    url: CI_JSON.url,
    sha: "",
    login: "owner",
  });
  assert.match(failed, /could not run \(the job ended: failure\)/);
  assert.match(failed, /actions\/runs\/1$/m);
});

// ── both stages, against a stand-in GitHub API ──────────────────────────────

interface Call {
  method: string;
  url: string;
  body: any;
}

async function withGitHub(routes: (method: string, url: string) => unknown, fn: (apiUrl: string, calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer test-token", "the job's token is sent");
      calls.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null });
      const answer = routes(req.method!, req.url!);
      if (answer === undefined) {
        res.writeHead(404).end("{}");
        return;
      }
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    server.close();
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-qa-test-"));
}

function eventFile(dir: string, login: string, body = "/scenescout qa the sign-in form", association = "NONE"): string {
  const file = path.join(dir, "event.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      action: "created",
      issue: { number: 7, pull_request: { url: "x" } },
      comment: { id: 55, body, user: { login }, author_association: association },
      repository: { owner: { login: "owner" } },
    }),
  );
  return file;
}

function gateEnv(dir: string, apiUrl: string, login: string, body?: string, association?: string): NodeJS.ProcessEnv {
  const out = path.join(dir, "out");
  fs.writeFileSync(out, "");
  process.env.GITHUB_OUTPUT = out;
  return { GITHUB_REPOSITORY: "owner/app", GITHUB_EVENT_PATH: eventFile(dir, login, body, association), GITHUB_API_URL: apiUrl };
}

const quiet = () => {};

test("gate stage: a stranger gets a reaction and nothing else; the pull request is not even read", async () => {
  const dir = tempDir();
  await withGitHub(
    () => ({}),
    async (api, calls) => {
      const out = await runGate({ env: gateEnv(dir, api, "someone"), inputs: { "github-token": "test-token", allowed: "" }, log: quiet });
      assert.equal(out.run, "false");
      assert.deepEqual(
        calls.map((c) => `${c.method} ${c.url}`),
        ["POST /repos/owner/app/issues/comments/55/reactions"],
      );
      assert.deepEqual(calls[0].body, { content: "confused" });
    },
  );
});

test("gate stage: the owner on a same-repository pull request gets eyes and a run on the head commit's deployment", async () => {
  const dir = tempDir();
  const sha = "b".repeat(40);
  await withGitHub(
    (method, url) => {
      if (url === "/repos/owner/app/pulls/7") return { ...SAME, head: { ...SAME.head, sha } };
      if (url.startsWith(`/repos/owner/app/deployments?sha=${sha}&environment=preview`)) return [{ id: 3 }];
      if (url.startsWith("/repos/owner/app/deployments/3/statuses")) return [{ state: "success", environment_url: "https://pr-7.preview.example.com" }];
      if (method === "POST") return {};
      return undefined;
    },
    async (api, calls) => {
      const out = await runGate({ env: gateEnv(dir, api, "Owner"), inputs: { "github-token": "test-token", environment: "preview" }, log: quiet });
      assert.deepEqual(out, {
        run: "true",
        pr: "7",
        sha,
        url: "https://pr-7.preview.example.com/",
        focus: "the sign-in form",
        login: "Owner",
        show: "",
        base: "",
      });
      const posts = calls.filter((c) => c.method === "POST");
      assert.deepEqual(
        posts.map((c) => [c.url, c.body]),
        [["/repos/owner/app/issues/comments/55/reactions", { content: "eyes" }]],
        "a reaction, and no comment",
      );
      assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT!, "utf8"), /^run=true$/m);
    },
  );
});

test("gate stage: a fork is refused with a reply, before any deployment is looked up", async () => {
  const dir = tempDir();
  await withGitHub(
    (method, url) => (url === "/repos/owner/app/pulls/7" ? FORK : method === "POST" ? {} : undefined),
    async (api, calls) => {
      const out = await runGate({
        env: gateEnv(dir, api, "owner", "/scenescout qa https://pr-7.preview.example.com"),
        inputs: { "github-token": "test-token" },
        log: quiet,
      });
      assert.equal(out.run, "false");
      const reply = calls.find((c) => c.url === "/repos/owner/app/issues/7/comments");
      assert.ok(reply, "a reply explains the refusal");
      assert.match(reply.body.body, /comes from a fork/);
      assert.ok(!calls.some((c) => c.url.includes("/deployments")));
    },
  );
});

test("gate stage: on an organization's repository, an owner of the organization may start a run and a member may not", async () => {
  const dir = tempDir();
  const routes = (method: string, url: string) => (url === "/repos/owner/app/pulls/7" ? SAME : method === "POST" ? {} : undefined);
  await withGitHub(routes, async (api, calls) => {
    const inputs = { "github-token": "test-token", "preview-url": "https://pr-{pr}.preview.example.com" };
    const env = (login: string, association: string) => ({ ...gateEnv(dir, api, login, undefined, association), GITHUB_REPOSITORY: "owner/app" });
    // The payload's repository owner is the organization; neither commenter is it.
    const org = (e: NodeJS.ProcessEnv) => {
      const file = String(e.GITHUB_EVENT_PATH);
      const ev = JSON.parse(fs.readFileSync(file, "utf8"));
      ev.repository.owner.login = "some-org";
      fs.writeFileSync(file, JSON.stringify(ev));
      return e;
    };
    assert.equal((await runGate({ env: org(env("org-admin", "OWNER")), inputs, log: quiet })).run, "true");
    calls.length = 0;
    assert.equal((await runGate({ env: org(env("org-member", "MEMBER")), inputs, log: quiet })).run, "false");
    assert.ok(!calls.some((c) => c.url === "/repos/owner/app/pulls/7"), "a member is decided on the payload alone");
  });
});

test("report stage: posts the results with the artifact's link; a run a newer one cancelled stays silent, one cancelled otherwise says so", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "ci.json"), JSON.stringify(CI_JSON));
  const env = { GITHUB_REPOSITORY: "owner/app", GITHUB_API_URL: "", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42", RESULTS: dir };
  const inputs = {
    "github-token": "test-token",
    result: "success",
    pr: "7",
    sha: "c".repeat(40),
    url: CI_JSON.url,
    login: "owner",
    "artifact-name": "scenescout-qa-7",
  };
  const TITLE = "scenescout-qa · #7";
  const self = { id: 42, workflow_id: 5, display_title: TITLE, created_at: "2026-09-27T10:00:00Z" };
  let later: Array<Record<string, unknown>> = [];
  const jobsOf: Record<string, unknown> = {};
  await withGitHub(
    (method, url) => {
      if (url.startsWith("/repos/owner/app/actions/runs/42/artifacts?name=scenescout-qa-7")) return { artifacts: [{ id: 99 }] };
      if (url === "/repos/owner/app/actions/runs/42") return self;
      if (url.startsWith("/repos/owner/app/actions/workflows/5/runs?event=issue_comment&created=%3E%3D2026-09-27T10%3A00%3A00Z"))
        return { workflow_runs: [self, ...later] };
      const jobs = /^\/repos\/owner\/app\/actions\/runs\/(\d+)\/jobs/.exec(url);
      if (jobs) return { jobs: jobsOf[jobs[1]] ?? [] };
      return method === "POST" ? {} : undefined;
    },
    async (api, calls) => {
      const body = await runReport({ env: { ...env, GITHUB_API_URL: api }, inputs, log: quiet });
      const post = calls.find((c) => c.method === "POST")!;
      assert.equal(post.url, "/repos/owner/app/issues/7/comments");
      assert.equal(post.body.body, body);
      assert.match(body!, /actions\/runs\/42\/artifacts\/99/);

      const cancelled = () => runReport({ env: { ...env, GITHUB_API_URL: api }, inputs: { ...inputs, result: "cancelled" }, log: quiet });
      const posted = () => calls.filter((c) => c.method === "POST");

      // Cancelled by hand or by the timeout: no newer run, so the pull request is told.
      calls.length = 0;
      later = [
        // A later comment on the same pull request that was not the command: its key job was skipped.
        { id: 43, display_title: TITLE, created_at: "2026-09-27T10:05:00Z" },
        // A later command on another pull request.
        { id: 44, display_title: "scenescout-qa · #8", created_at: "2026-09-27T10:06:00Z" },
      ];
      jobsOf["43"] = [
        { name: "gate", conclusion: "success" },
        { name: "qa", conclusion: "skipped" },
      ];
      jobsOf["44"] = [{ name: "qa", conclusion: null }];
      assert.equal(await cancelled(), cancelledMarkdown({ runUrl: "https://github.com/owner/app/actions/runs/42" }));
      assert.equal(posted().length, 1);
      assert.match(posted()[0].body.body, /cancelled or timed out.*actions\/runs\/42$/m);

      // Cancelled by a newer command on the same pull request, whose key job started: that run replies.
      calls.length = 0;
      later.push({ id: 45, display_title: TITLE, created_at: "2026-09-27T10:07:00Z" });
      jobsOf["45"] = [{ name: "qa", conclusion: null, status: "in_progress" }];
      assert.equal(await cancelled(), null);
      assert.equal(posted().length, 0, "the newer run on the same pull request replies instead");

      const failed = await runReport({ env: { ...env, GITHUB_API_URL: api, RESULTS: tempDir() }, inputs: { ...inputs, result: "failure" }, log: quiet });
      assert.match(failed!, /could not run/);
    },
  );
});

test("newer run: a later run with the same title whose key job was not skipped, and nothing else", () => {
  const self = { id: 1, display_title: "t · #7", created_at: "2026-09-27T10:00:00Z" };
  const run = (over: Record<string, unknown>) => ({
    id: 2,
    display_title: "t · #7",
    created_at: "2026-09-27T10:01:00Z",
    jobs: [{ name: "qa", conclusion: null }],
    ...over,
  });
  assert.equal(newerRunFor(self, [run({})]), true);
  assert.equal(newerRunFor(self, [run({ jobs: [{ name: "qa", conclusion: "success" }] })]), true);
  assert.equal(newerRunFor(self, [run({ jobs: [{ name: "qa", conclusion: "skipped" }] })]), false, "a comment that was not the command");
  assert.equal(newerRunFor(self, [run({ jobs: [{ name: "gate", conclusion: null }] })]), false, "the gate has not said yes");
  assert.equal(newerRunFor(self, [run({ display_title: "t · #8" })]), false, "another pull request");
  assert.equal(newerRunFor(self, [run({ created_at: "2026-09-27T09:59:00Z" })]), false, "an older run");
  assert.equal(newerRunFor(self, [run({ id: 1 })]), false, "itself");
  assert.equal(newerRunFor(self, []), false);
});

test("github client: a server error is retried, a refusal is not, and no call waits forever", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return new Response("{}", { status: n < 2 ? 502 : 200 });
  }) as typeof fetch;
  const call = githubClient({ token: "t", apiUrl: "https://api.example", fetchImpl, wait: async () => {} });
  assert.deepEqual(await call("GET", "/x"), {});
  assert.equal(n, 2);
  let m = 0;
  const refused = githubClient({
    token: "t",
    apiUrl: "https://api.example",
    fetchImpl: (async () => (m++, new Response("{}", { status: 403 }))) as typeof fetch,
    wait: async () => {},
  });
  await assert.rejects(refused("POST", "/y", {}), /HTTP 403/);
  assert.equal(m, 1);
  assert.throws(() => githubClient({ token: "", apiUrl: "" }), /no GitHub token/);
});

// ── show and compare ────────────────────────────────────────────────────────

test("command: show and compare name an element; a URL may come first; the plain form is unchanged", () => {
  const rows: Array<[string, unknown]> = [
    ["/scenescout qa show the Save button", { url: "", focus: "", capture: { kind: "show", what: "the Save button" } }],
    ["/scenescout qa compare the Save button", { url: "", focus: "", capture: { kind: "compare", what: "the Save button" } }],
    ["/scenescout qa COMPARE  the   Save button", { url: "", focus: "", capture: { kind: "compare", what: "the Save button" } }],
    [
      "/scenescout qa https://p.example.com show the header link",
      { url: "https://p.example.com", focus: "", capture: { kind: "show", what: "the header link" } },
    ],
    ["/scenescout qa show", { url: "", focus: "", capture: { kind: "show", what: "" } }],
    // Only as a word of its own, and only first: otherwise it is an ordinary focus.
    ["/scenescout qa showcase page", { url: "", focus: "showcase page" }],
    ["/scenescout qa the page to show", { url: "", focus: "the page to show" }],
    ["/scenescout qa show-stoppers in checkout", { url: "", focus: "show-stoppers in checkout" }],
  ];
  for (const [body, expected] of rows) assert.deepEqual(parseQaCommand(body), expected, body);
  const long = parseQaCommand(`/scenescout qa compare ${"x".repeat(500)}`)!;
  assert.equal(long.capture.what.length, MAX_FOCUS);
  assert.equal(parseQaCommand("/scenescout qa show the\u0007 button")!.capture.what, "the button", "control characters never reach the prompt");
});

test("gate: show needs words; compare needs an https base URL; each says how to fix it", () => {
  const allowed = allowlist("", "owner");
  const decide = (command: Record<string, unknown>, base?: { source: string; url: string }) =>
    gateDecision({ command, login: "owner", association: "OWNER", allowed, pr: SAME, allowForks: false, preview: PREVIEW, ...(base ? { base } : {}) });
  const show = decide({ url: "", focus: "", capture: { kind: "show", what: "the Save button" } });
  assert.deepEqual([show.run, show.show, show.base], [true, "the Save button", ""]);
  const plain = decide({ url: "", focus: "the form" });
  assert.deepEqual([plain.run, plain.show, plain.base], [true, "", ""], "an ordinary run shows nothing");
  const empty = decide({ url: "", focus: "", capture: { kind: "show", what: "" } });
  assert.equal(empty.run, false);
  assert.match(empty.reply ?? "", /say which element to show, e\.g\. `\/scenescout qa show the Save button`/);

  const compare = { url: "", focus: "", capture: { kind: "compare", what: "the Save button" } };
  const noBase = decide(compare);
  assert.equal(noBase.run, false);
  assert.match(noBase.reply ?? "", /nothing to compare/);
  assert.match(noBase.reply ?? "", /SCENESCOUT_QA_BASE_URL/);
  const plainHttp = decide(compare, { source: "variable", url: "http://www.example.com" });
  assert.equal(plainHttp.run, false);
  assert.match(plainHttp.reply ?? "", /the base URL must be https \(from the variable\)/);
  assert.equal(decide(compare, { source: "variable", url: "https://u:p@www.example.com" }).run, false);
  const ok = decide(compare, { source: "base branch's deployment", url: "https://www.example.com" });
  assert.deepEqual([ok.run, ok.url, ok.show, ok.base], [true, "https://pr-7.preview.example.com/", "the Save button", "https://www.example.com/"]);

  assert.deepEqual(chooseBaseUrl({ configured: " https://www.example.com ", deployment: "https://d.example.com" }), {
    source: "variable",
    url: "https://www.example.com",
  });
  assert.deepEqual(chooseBaseUrl({ configured: "", deployment: "https://d.example.com" }), {
    source: "base branch's deployment",
    url: "https://d.example.com",
  });
  assert.deepEqual(chooseBaseUrl({ configured: "", deployment: "" }), { source: "none", url: "" });
});

const SERVER = "https://github.com";
const IMAGES = Object.fromEntries(SHOT_NAMES.map((name: string) => [name, shotUrl({ server: SERVER, repo: "owner/app", runId: "42", name })]));

test("pictures: their URLs are built from the repository, the run and a fixed name, and nothing else", () => {
  assert.equal(IMAGES["diff.png"], "https://github.com/owner/app/raw/scenescout-shots/42/diff.png");
  assert.throws(() => shotUrl({ server: SERVER, repo: "owner/app", runId: "42", name: "../x.png" }), /not a picture/);
  assert.throws(() => shotUrl({ server: SERVER, repo: "owner/app", runId: "42/../1", name: "diff.png" }), /not a run id/);
  assert.throws(() => shotUrl({ server: "http://github.com", repo: "owner/app", runId: "42", name: "diff.png" }), /https origin/);
  assert.throws(() => shotUrl({ server: SERVER, repo: "owner/app/x", runId: "42", name: "diff.png" }), /owner\/name/);
  assert.deepEqual(pushedShots("preview.png, base.png,diff.png,evil.svg,../x.png"), ["preview.png", "base.png", "diff.png"]);
  assert.deepEqual(pushedShots(""), []);
});

test("pictures: only the three names, only PNGs, only up to the size limit, are pushed", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "shots"));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  fs.writeFileSync(path.join(dir, "shots", "preview.png"), png);
  fs.writeFileSync(path.join(dir, "shots", "base.png"), "<svg onload=alert(1)>");
  fs.writeFileSync(path.join(dir, "shots", "other.png"), png);
  fs.writeFileSync(path.join(dir, "shots", "diff.png"), Buffer.concat([png, Buffer.alloc(6_000_000)]));
  assert.deepEqual(
    shotsToPush(dir).map((s: { name: string }) => s.name),
    ["preview.png"],
  );
});

const CAPTURE = {
  what: "the Save button",
  status: "captured",
  preview: { file: "shots/preview.png", key: "testid:save", label: "Save", path: "/things", width: 96, height: 46 },
  base: { file: "shots/base.png", path: "/things", width: 90, height: 46 },
  diff: { file: "shots/diff.png", changedPixels: 441, totalPixels: 4416, percent: 9.99, sizeChanged: true, box: null },
};
const CAPTURE_JSON = { ...CI_JSON, counts: { high: 0, medium: 0, low: 0, worthALook: 0 }, findings: [], capture: CAPTURE };
const imageUrls = (md: string) => [...md.matchAll(/!\[[^\]]*\]\(([^)]*)\)/g)].map((m) => m[1]);

test("reply: a comparison shows base and preview side by side and the diff, and every image is one the workflow built", () => {
  const md = qaCommentMarkdown({
    json: CAPTURE_JSON,
    result: "success",
    runUrl: "https://github.com/owner/app/actions/runs/42",
    artifactUrl: "",
    url: CI_JSON.url,
    sha: "",
    login: "owner",
    images: IMAGES,
  });
  assert.match(md, /### Compared: the Save button/);
  assert.match(
    md,
    /\| Base \| This pull request \|\n\|---\|---\|\n\| !\[base\]\(https:\/\/github\.com\/owner\/app\/raw\/scenescout-shots\/42\/base\.png\) \| !\[this pull request\]/,
  );
  assert.match(md, /\*\*9\.99%\*\* of pixels changed \(441 of 4416\)/);
  assert.match(md, /size changed, from 90×46 to 96×46 pixels/);
  assert.deepEqual(imageUrls(md), [IMAGES["base.png"], IMAGES["preview.png"], IMAGES["diff.png"]]);
  assert.ok(!/Completion contract/.test(md), "a picture has no completion contract");

  const unchanged = qaCommentMarkdown({
    json: { ...CAPTURE_JSON, capture: { ...CAPTURE, diff: { ...CAPTURE.diff, changedPixels: 0, percent: 0, sizeChanged: false } } },
    result: "success",
    runUrl: "r",
    artifactUrl: "",
    url: CI_JSON.url,
    sha: "",
    login: "",
    images: IMAGES,
  });
  assert.match(unchanged, /No pixels changed\./);
  assert.ok(!imageUrls(unchanged).includes(IMAGES["diff.png"]), "an all-grey diff is not shown");

  const show = qaCommentMarkdown({
    json: { ...CAPTURE_JSON, capture: { what: "the Save button", status: "captured", preview: CAPTURE.preview } },
    result: "success",
    runUrl: "r",
    artifactUrl: "",
    url: CI_JSON.url,
    sha: "",
    login: "",
    images: { "preview.png": IMAGES["preview.png"] },
  });
  assert.match(show, /### Shown: the Save button/);
  assert.deepEqual(imageUrls(show), [IMAGES["preview.png"]]);

  const noImages = qaCommentMarkdown({ json: CAPTURE_JSON, result: "success", runUrl: "r", artifactUrl: "", url: CI_JSON.url, sha: "", login: "", images: {} });
  assert.deepEqual(imageUrls(noImages), []);
  assert.match(noImages, /all of them are in the run's artifact/);
});

test("reply: markdown image syntax in anything a model or a comment wrote stays inert", () => {
  const evil = "![x](https://evil.example/p.png) <img src=https://evil.example/q.png> @owner";
  const json = {
    ...CAPTURE_JSON,
    stop: { reason: "done", text: evil },
    findings: [{ id: "f1", severity: "high", category: "functional", title: evil, path: evil }],
    capture: { ...CAPTURE, what: evil, detail: evil, preview: { ...CAPTURE.preview, label: evil } },
  };
  const md = qaCommentMarkdown({ json, result: "success", runUrl: "r", artifactUrl: "", url: evil, sha: "", login: evil, images: IMAGES });
  assert.deepEqual(imageUrls(md), [IMAGES["base.png"], IMAGES["preview.png"], IMAGES["diff.png"]], "only the workflow's images");
  assert.ok(!/https?:\/\/evil/.test(md), "no live link to anywhere else");
  assert.ok(!/<img/i.test(md) && !/@owner/.test(md));
  // Not captured: the model's explanation is inert too.
  const lines = captureMarkdown({ what: evil, status: "not-found", detail: evil }, IMAGES).join("\n");
  assert.deepEqual(imageUrls(lines), []);
  assert.match(lines, /Nothing was captured/);
});

test("shots stage: refuses to run beside a key; otherwise pushes the pictures to the image branch, starting it with no history", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "shots"));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
  fs.writeFileSync(path.join(dir, "shots", "preview.png"), png);
  fs.writeFileSync(path.join(dir, "shots", "diff.png"), png);
  const out = path.join(dir, "out");
  fs.writeFileSync(out, "");
  process.env.GITHUB_OUTPUT = out;
  const env = { GITHUB_REPOSITORY: "owner/app", GITHUB_RUN_ID: "42", RESULTS: dir };
  await assert.rejects(
    runShots({ env: { ...env, OPENAI_API_KEY: "fake-key-value-000000" }, inputs: { "github-token": "test-token" }, log: quiet }),
    /never runs beside a model's key/,
  );

  let branch: string | null = null;
  await withGitHub(
    (method, url) => {
      if (method === "POST" && url === "/repos/owner/app/git/blobs") return { sha: `blob${Math.random()}` };
      if (method === "GET" && url === "/repos/owner/app/git/ref/heads/scenescout-shots") return branch ? { object: { sha: branch } } : undefined;
      if (method === "GET" && url.startsWith("/repos/owner/app/git/commits/")) return { tree: { sha: "tree0" } };
      if (method === "POST" && url === "/repos/owner/app/git/trees") return { sha: "tree1" };
      if (method === "POST" && url === "/repos/owner/app/git/commits") return { sha: "commit1" };
      if (method === "POST" && url === "/repos/owner/app/git/refs") {
        branch = "commit1";
        return {};
      }
      return undefined;
    },
    async (api, calls) => {
      const first = await runShots({ env: { ...env, GITHUB_API_URL: api }, inputs: { "github-token": "test-token" }, log: quiet });
      assert.deepEqual(first, { pushed: "preview.png,diff.png" });
      const tree = calls.find((c) => c.url === "/repos/owner/app/git/trees")!;
      assert.deepEqual(
        tree.body.tree.map((t: { path: string }) => t.path),
        ["42/preview.png", "42/diff.png"],
      );
      assert.equal(tree.body.base_tree, undefined, "a new branch: no base tree");
      assert.deepEqual(calls.find((c) => c.url === "/repos/owner/app/git/commits")!.body.parents, [], "no history, so no code, on the branch");
      assert.deepEqual(calls.find((c) => c.url === "/repos/owner/app/git/refs")!.body.ref, "refs/heads/scenescout-shots");
      assert.match(fs.readFileSync(out, "utf8"), /^pushed=preview\.png,diff\.png$/m);
      assert.ok(!calls.some((c) => c.method === "PATCH" || c.method === "DELETE"));
    },
  );
});

test("shots stage: on an existing branch, it builds on the tip and never forces; a moved tip is retried", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "shots"));
  fs.writeFileSync(path.join(dir, "shots", "preview.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
  fs.writeFileSync(path.join(dir, "out"), "");
  process.env.GITHUB_OUTPUT = path.join(dir, "out");
  let patches = 0;
  // A 422 for an update that is not a fast-forward is the API's answer when another run pushed first.
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.method === "PATCH") {
        patches++;
        assert.equal(JSON.parse(raw).force, false);
        return patches === 1 ? send(422, { message: "Update is not a fast forward" }) : send(200, {});
      }
      if (req.url === "/repos/owner/app/git/ref/heads/scenescout-shots") return send(200, { object: { sha: `tip${patches}` } });
      if (req.url!.startsWith("/repos/owner/app/git/commits/")) return send(200, { tree: { sha: "t" } });
      return send(201, { sha: "x" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const outcome = await runShots({
      env: { GITHUB_REPOSITORY: "owner/app", GITHUB_RUN_ID: "43", RESULTS: dir, GITHUB_API_URL: api },
      inputs: { "github-token": "t" },
      log: quiet,
    });
    assert.deepEqual(outcome, { pushed: "preview.png" });
    assert.equal(patches, 2, "tried again on the new tip");
  } finally {
    server.close();
  }
});

test("gate stage: compare finds the base in the base branch's newest successful deployment", async () => {
  const dir = tempDir();
  await withGitHub(
    (method, url) => {
      if (url === "/repos/owner/app/pulls/7") return { ...SAME, base: { ...SAME.base, ref: "main" } };
      if (url.startsWith("/repos/owner/app/deployments?ref=main&per_page=5")) return [{ id: 9 }];
      if (url.startsWith("/repos/owner/app/deployments/9/statuses")) return [{ state: "success", environment_url: "https://www.example.com" }];
      return method === "POST" ? {} : undefined;
    },
    async (api) => {
      const out = await runGate({
        env: gateEnv(dir, api, "owner", "/scenescout qa compare the Save button"),
        inputs: { "github-token": "test-token", "preview-url": "https://pr-{pr}.preview.example.com" },
        log: quiet,
      });
      assert.deepEqual([out.run, out.show, out.base, out.focus], ["true", "the Save button", "https://www.example.com/", ""]);
      const configured = await runGate({
        env: gateEnv(dir, api, "owner", "/scenescout qa compare the Save button"),
        inputs: { "github-token": "test-token", "preview-url": "https://pr-{pr}.preview.example.com", "base-url": "https://prod.example.com" },
        log: quiet,
      });
      assert.equal(configured.base, "https://prod.example.com/", "the variable wins");
    },
  );
});

test("report stage: shows the pictures the shots job pushed, and no others", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "ci.json"), JSON.stringify(CAPTURE_JSON));
  await withGitHub(
    (method) => (method === "POST" ? {} : { artifacts: [] }),
    async (api) => {
      const body = await runReport({
        env: { GITHUB_REPOSITORY: "owner/app", GITHUB_API_URL: api, GITHUB_SERVER_URL: SERVER, GITHUB_RUN_ID: "42", RESULTS: dir },
        inputs: { "github-token": "test-token", result: "success", pr: "7", url: CI_JSON.url, shots: "preview.png,diff.png" },
        log: quiet,
      });
      assert.deepEqual(imageUrls(body!), [IMAGES["preview.png"], IMAGES["diff.png"]]);
    },
  );
});

// ── the workflow a project copies ───────────────────────────────────────────

type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps?: Step[];
};

const SCENESCOUT_PINNED = /^brunoboto96\/SceneScout\/(ci|qa)@(v\d+\.\d+\.\d+|[0-9a-f]{40})$/;
const THIRD_PARTY_PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const CHECKS_OUT = /(^|\s)(git\s+(clone|fetch|checkout|switch|worktree)|gh\s+(pr|repo)\s+(checkout|clone))\b/m;

/**
 * Everything that would make the QA workflow unsafe or wrong, as sentences. Empty for a sound workflow.
 * Held here, not in the action: it describes the copied workflow, and it is tested against mutated copies below.
 */
function qaWorkflowProblems(wf: Record<string, any>): string[] {
  const problems: string[] = [];
  const on = wf.on ?? wf[true as unknown as string];
  if (JSON.stringify(on) !== JSON.stringify({ issue_comment: { types: ["created"] } }))
    problems.push("the trigger must be issue_comment, created, and nothing else");
  if (JSON.stringify(wf.permissions) !== "{}") problems.push("the workflow's default permissions must be empty");
  if (!/\$\{\{ github\.event\.issue\.number \}\}/.test(String(wf["run-name"] ?? ""))) problems.push("run-name must carry the pull request's number");
  if (/secrets\./.test(JSON.stringify(wf.env ?? {}))) problems.push("no secret in the workflow's env");
  const jobs = (wf.jobs ?? {}) as Record<string, Job>;
  const needs = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);

  const withKey = Object.entries(jobs)
    .filter(([, j]) => /secrets\./.test(JSON.stringify(j)))
    .map(([n]) => n);
  if (JSON.stringify(withKey) !== JSON.stringify(["qa"])) problems.push(`only the qa job may reference a secret, not: ${withKey.join(", ") || "none"}`);

  for (const [name, job] of Object.entries(jobs)) {
    for (const s of job.steps ?? []) {
      if (s.uses && /^actions\/checkout@/.test(s.uses)) problems.push(`${name}: checks out code`);
      if (s.uses && !SCENESCOUT_PINNED.test(s.uses) && !THIRD_PARTY_PINNED.test(s.uses))
        problems.push(`${name}: ${s.uses} is not pinned to a release or a commit`);
      if (s.run && CHECKS_OUT.test(s.run)) problems.push(`${name}: fetches code in a script`);
      if (s.run && /\$\{\{[^}]*github\.event\./.test(s.run)) problems.push(`${name}: pastes the event into a script`);
    }
  }

  const gate = jobs.gate;
  if (!gate) problems.push("no gate job");
  else {
    if (!/github\.event\.issue\.pull_request/.test(gate.if ?? "") || !/startsWith\(github\.event\.comment\.body, '\/scenescout qa'\)/.test(gate.if ?? ""))
      problems.push("the gate must run only for the command on a pull request");
    if (!(gate.steps ?? []).some((s) => /^brunoboto96\/SceneScout\/qa@/.test(s.uses ?? "") && s.with?.stage === "gate"))
      problems.push("the gate must run the qa action's gate stage");
    const writes = Object.entries(gate.permissions ?? {})
      .filter(([, v]) => v === "write")
      .map(([k]) => k);
    if (JSON.stringify(writes) !== JSON.stringify(["pull-requests"])) problems.push("the gate may write to pull requests only");
  }

  const qa = jobs.qa;
  if (!qa) problems.push("no qa job");
  else {
    if (qa.name !== undefined) problems.push("the qa job keeps its id as its name: the report finds newer runs by it");
    if (JSON.stringify(qa.permissions) !== JSON.stringify({ contents: "read" })) problems.push("the qa job must have contents: read and nothing else");
    if (!needs(qa).includes("gate")) problems.push("the qa job must need the gate");
    if (!/needs\.gate\.outputs\.run == 'true'/.test(qa.if ?? "")) problems.push("the qa job must run only when the gate said so");
    if ((qa.steps ?? []).some((s) => s.run !== undefined)) problems.push("the qa job must run no script of its own: only SceneScout from a release");
    const ci = (qa.steps ?? []).find((s) => /^brunoboto96\/SceneScout\/ci@/.test(s.uses ?? ""));
    if (!ci) problems.push("the qa job must run the ci action");
    else {
      if (!/^\$\{\{ secrets\.[A-Z_]+ \}\}$/.test(Object.values(ci.env ?? {}).join("")) || Object.keys(ci.env ?? {}).length !== 1)
        problems.push("the key reaches the ci step through its env, from one secret");
      if (ci.with?.url !== "${{ needs.gate.outputs.url }}") problems.push("the run's URL comes from the gate");
      if (ci.with?.show !== undefined && ci.with.show !== "${{ needs.gate.outputs.show }}") problems.push("the element to show comes from the gate");
      if (ci.with?.["compare-url"] !== undefined && ci.with["compare-url"] !== "${{ needs.gate.outputs.base }}")
        problems.push("the base URL comes from the gate, which checked it");
      if (ci.with?.cli !== undefined || ci.with?.version !== undefined) problems.push("the ci action runs the release its ref names");
      if (["destructive", "safe-write"].includes(String(ci.with?.mode))) problems.push("a QA run on a preview is read-only or observe");
      if (ci.with?.["allow-destructive"] !== undefined) problems.push("no allow-destructive");
      const minutes = Number(ci.with?.["max-minutes"] ?? 20);
      if (!(Number(qa["timeout-minutes"]) >= minutes + 5)) problems.push("the qa job's timeout must leave room to write the report");
    }
    if (!/needs\.gate\.outputs\.pr/.test(qa.concurrency?.group ?? "") || qa.concurrency?.["cancel-in-progress"] !== true)
      problems.push("one run per pull request: a concurrency group on the pull request, cancelling the run in progress");
  }

  // The only job that may write contents: it pushes the pictures, holds no key (checked above) and runs the qa action's shots stage only.
  const writesContents = Object.entries(jobs)
    .filter(([, j]) => (j.permissions ?? {}).contents === "write")
    .map(([n]) => n);
  if (JSON.stringify(writesContents) !== JSON.stringify(["shots"]))
    problems.push(`only the shots job may write contents, not: ${writesContents.join(", ") || "none"}`);
  const shots = jobs.shots;
  if (!shots) problems.push("no shots job");
  else {
    if (JSON.stringify(shots.permissions) !== JSON.stringify({ contents: "write" })) problems.push("the shots job has contents: write and nothing else");
    if (!needs(shots).includes("qa") || !/needs\.qa\.result == 'success'/.test(shots.if ?? "") || !/needs\.gate\.outputs\.run == 'true'/.test(shots.if ?? ""))
      problems.push("the shots job runs only after a run the gate started has succeeded");
    const steps = shots.steps ?? [];
    if (steps.length !== 1 || !/^brunoboto96\/SceneScout\/qa@/.test(steps[0].uses ?? "") || steps[0].with?.stage !== "shots")
      problems.push("the shots job runs the qa action's shots stage and nothing else");
    else if (Object.keys(steps[0].with ?? {}).some((k) => !["stage", "artifact-name"].includes(k)))
      problems.push("the shots stage takes no branch or path: they are fixed in the action");
  }

  const report = jobs.report;
  if (!report) problems.push("no report job");
  else {
    if (!needs(report).includes("qa") || !needs(report).includes("gate")) problems.push("the report needs the gate and the qa job");
    if (!needs(report).includes("shots") || report.steps?.[0]?.with?.shots !== "${{ needs.shots.outputs.pushed }}")
      problems.push("the report waits for the pictures and shows only those the shots job pushed");
    if (!/always\(\)/.test(report.if ?? "") || !/needs\.gate\.outputs\.run == 'true'/.test(report.if ?? ""))
      problems.push("the report runs after any run that started, failed ones included");
    const writes = Object.entries(report.permissions ?? {})
      .filter(([, v]) => v === "write")
      .map(([k]) => k);
    if (JSON.stringify(writes) !== JSON.stringify(["pull-requests"])) problems.push("the report may write to pull requests only");
  }
  return problems;
}

const template = (): Record<string, any> => parseYaml(fs.readFileSync(TEMPLATE, "utf8")) as Record<string, any>;

test("workflow: the template is sound", () => {
  assert.deepEqual(qaWorkflowProblems(template()), []);
});

test("workflow: each unsafe change to the template is caught", () => {
  const mutations: Array<[string, (wf: Record<string, any>) => void, RegExp]> = [
    ["a pull_request_target trigger", (wf) => (wf.on.pull_request_target = { types: ["opened"] }), /trigger/],
    ["write-all by default", (wf) => (wf.permissions = "write-all"), /default permissions/],
    [
      "checkout in the key job",
      (wf) => wf.jobs.qa.steps.unshift({ uses: "actions/checkout@v7", with: { ref: "${{ github.event.issue.number }}" } }),
      /qa: checks out code/,
    ],
    ["a script in the key job", (wf) => wf.jobs.qa.steps.unshift({ run: "npm ci && npm start &" }), /no script of its own/],
    ["gh pr checkout in the report", (wf) => wf.jobs.report.steps.unshift({ run: "gh pr checkout 7" }), /report: fetches code/],
    ["the key in the gate", (wf) => (wf.jobs.gate.env = { OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}" }), /only the qa job may reference a secret/],
    ["the key in the report", (wf) => (wf.jobs.report.steps[0].env = { OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}" }), /only the qa job/],
    ["the key job without the gate", (wf) => delete wf.jobs.qa.needs, /must need the gate/],
    ["the key job not waiting for the gate's yes", (wf) => delete wf.jobs.qa.if, /only when the gate said so/],
    ["the key job with a write token", (wf) => (wf.jobs.qa.permissions["pull-requests"] = "write"), /contents: read and nothing else/],
    ["SceneScout from a moving ref", (wf) => (wf.jobs.qa.steps[0].uses = "brunoboto96/SceneScout/ci@v3"), /not pinned/],
    ["SceneScout from main", (wf) => (wf.jobs.gate.steps[0].uses = "brunoboto96/SceneScout/qa@main"), /not pinned/],
    ["SceneScout from the pull request's build", (wf) => (wf.jobs.qa.steps[0].with.cli = "dist/cli.js"), /runs the release/],
    ["a URL from the comment", (wf) => (wf.jobs.qa.steps[0].with.url = "${{ github.event.comment.body }}"), /comes from the gate/],
    ["destructive mode", (wf) => (wf.jobs.qa.steps[0].with.mode = "destructive"), /read-only/],
    ["no pull request in the run's title", (wf) => delete wf["run-name"], /run-name/],
    ["a renamed key job", (wf) => (wf.jobs.qa.name = "QA run"), /keeps its id/],
    ["no concurrency", (wf) => delete wf.jobs.qa.concurrency, /one run per pull request/],
    ["no cancelling", (wf) => (wf.jobs.qa.concurrency["cancel-in-progress"] = false), /one run per pull request/],
    ["a gate for any comment", (wf) => (wf.jobs.gate.if = "github.event.issue.pull_request"), /only for the command/],
    ["the event pasted into a script", (wf) => wf.jobs.gate.steps.unshift({ run: 'echo "${{ github.event.comment.body }}"' }), /pastes the event/],
    ["a gate that can push", (wf) => (wf.jobs.gate.permissions.contents = "write"), /gate may write to pull requests only/],
    ["a timeout the run outlasts", (wf) => (wf.jobs.qa["timeout-minutes"] = 20), /timeout/],
    [
      "the key in the shots job",
      (wf) => (wf.jobs.shots.steps[0].env = { OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}" }),
      /only the qa job may reference a secret/,
    ],
    [
      "the key job pushing pictures",
      (wf) => (wf.jobs.qa.permissions.contents = "write"),
      /contents: read and nothing else|only the shots job may write contents/,
    ],
    ["the report pushing pictures", (wf) => (wf.jobs.report.permissions.contents = "write"), /only the shots job may write contents/],
    ["a shots job that can write pull requests", (wf) => (wf.jobs.shots.permissions["pull-requests"] = "write"), /contents: write and nothing else/],
    ["a shots job that pushes after a failed run", (wf) => (wf.jobs.shots.if = "always() && needs.gate.outputs.run == 'true'"), /has succeeded/],
    ["a shots job with a script", (wf) => wf.jobs.shots.steps.push({ run: "git push" }), /shots stage and nothing else/],
    ["a branch chosen in the workflow", (wf) => (wf.jobs.shots.steps[0].with.branch = "main"), /no branch or path/],
    ["the element from the comment", (wf) => (wf.jobs.qa.steps[0].with.show = "${{ github.event.comment.body }}"), /element to show comes from the gate/],
    ["an unchecked base URL", (wf) => (wf.jobs.qa.steps[0].with["compare-url"] = "${{ vars.SCENESCOUT_QA_BASE_URL }}"), /base URL comes from the gate/],
    ["images from anywhere", (wf) => (wf.jobs.report.steps[0].with.shots = "preview.png,base.png,diff.png"), /only those the shots job pushed/],
  ];
  for (const [what, mutate, expected] of mutations) {
    const wf = template();
    mutate(wf);
    const problems = qaWorkflowProblems(wf);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${what}: expected a problem matching ${expected}, got ${JSON.stringify(problems)}`,
    );
  }
});

test("workflow: the same SceneScout release in every job, and this repository does not run it", () => {
  const refs = new Set(
    Object.values(template().jobs as Record<string, Job>)
      .flatMap((j) => j.steps ?? [])
      .map((s) => s.uses ?? "")
      .filter((u) => u.startsWith("brunoboto96/SceneScout/"))
      .map((u) => u.split("@")[1]),
  );
  assert.equal(refs.size, 1, `one release across the jobs, not ${[...refs].join(", ")}`);
  // SceneScout has no preview deployment of its own; its workflows must never answer an issue comment with a key in reach.
  for (const f of fs.readdirSync(path.join(REPO, ".github", "workflows"))) {
    const wf = parseYaml(fs.readFileSync(path.join(REPO, ".github", "workflows", f), "utf8")) as Record<string, any>;
    const on = wf.on ?? {};
    assert.ok(!("issue_comment" in on) && !("pull_request_target" in on), `${f} must not run on issue_comment or pull_request_target`);
  }
});

/** The first release with qa/: the template may never pin an earlier one. */
const FIRST_QA_RELEASE = [3, 13, 0];
/** The first release with show and compare (the ci action's show input, the qa action's shots stage). */
const FIRST_SHOTS_RELEASE = [3, 14, 0];

test("workflow: the release it pins ships qa/, whichever order the pull requests land in", () => {
  const pinned = [...fs.readFileSync(TEMPLATE, "utf8").matchAll(/brunoboto96\/SceneScout\/(?:ci|qa)@v(\d+)\.(\d+)\.(\d+)/g)].map((m) =>
    m.slice(1, 4).map(Number),
  );
  assert.ok(pinned.length >= 3);
  const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"))
    .version.split("-")[0]
    .split(".")
    .map(Number);
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const pending = ["qa-comment.md", "qa-show-compare.md"].some((f) => fs.existsSync(path.join(REPO, ".changeset", f)));
  for (const p of pinned) {
    if (pending)
      assert.ok(cmp(p, version) > 0, `what the template uses is unreleased, so it must pin a release after ${version.join(".")}, not ${p.join(".")}`);
    else {
      // Released: any release from the first that has what it uses up to this one, so a later Version Packages pull request never has to move it.
      assert.ok(cmp(p, FIRST_QA_RELEASE) >= 0, `qa/ first shipped in ${FIRST_QA_RELEASE.join(".")}; ${p.join(".")} has no qa/`);
      assert.ok(cmp(p, FIRST_SHOTS_RELEASE) >= 0, `show and compare first shipped in ${FIRST_SHOTS_RELEASE.join(".")}; ${p.join(".")} has neither`);
      assert.ok(cmp(p, version) <= 0, `the template pins ${p.join(".")}, which is not released yet (package.json is ${version.join(".")})`);
    }
  }
});

test("qa action: pinned third-party steps, no input pasted into a script, no secret, no checkout", () => {
  const action = parseYaml(fs.readFileSync(QA_ACTION, "utf8")) as Record<string, any>;
  const steps = action.runs.steps as Step[];
  for (const s of steps) if (s.uses) assert.match(s.uses, THIRD_PARTY_PINNED, s.uses);
  for (const s of steps) if (s.run) assert.ok(!/\$\{\{\s*inputs\./.test(s.run), s.run);
  const text = fs.readFileSync(QA_ACTION, "utf8");
  assert.ok(!/secrets\./.test(text), "the action never names a secret");
  assert.ok(!steps.some((s) => /^actions\/checkout@/.test(s.uses ?? "")), "the action checks out nothing");
  // Every output the template reads from the gate is one the action declares.
  const declared = Object.keys(action.outputs);
  const read = Object.keys(template().jobs.gate.outputs);
  assert.deepEqual(
    read.filter((o) => !declared.includes(o)),
    [],
  );
  // The template's inputs are the action's.
  const inputs = Object.keys(action.inputs);
  for (const job of ["gate", "shots", "report"])
    for (const k of Object.keys(template().jobs[job].steps[0].with)) assert.ok(inputs.includes(k), `${job}: ${k} is not an input`);
  // The pictures' branch is not something a workflow can choose.
  assert.ok(!inputs.some((k) => /branch|path/.test(k)), "no input names a branch or a path");
  assert.equal(SHOTS_BRANCH, "scenescout-shots");
});

test("docs: every variable the template reads is documented", () => {
  const vars = [...fs.readFileSync(TEMPLATE, "utf8").matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(vars.length >= 3);
  const doc = fs.readFileSync(path.join(REPO, "docs", "ci.md"), "utf8");
  for (const v of new Set(vars)) assert.ok(doc.includes(v), `${v} is not in docs/ci.md`);
  assert.ok(doc.includes("examples/workflows/scenescout-qa.yml"), "docs/ci.md points at the template");
});
