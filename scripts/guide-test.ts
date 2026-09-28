/**
 * The guide in docs/guide/ is checked against the code, so it cannot drift
 * from what ships:
 *
 * - the configuration reference lists exactly the CLI options, environment
 *   variables, GitHub Action inputs and outputs, `/scenescout qa` repository
 *   settings and `scenescout check` rules the code has, with the defaults the
 *   code uses where the code states one;
 * - every `--option`, `scenescout <command>` and `SCENESCOUT_*` name a page
 *   mentions exists;
 * - every link resolves to a file, and every anchor to a heading;
 * - every page renders as GitHub Markdown: tables with the same number of
 *   cells in every row, code fences closed;
 * - no page names a local path or a real address;
 * - the workflow that publishes the guide to the wiki keeps its token where
 *   it belongs, and the page transform it runs is table-tested here.
 *
 * `scout_*` tools and their parameters are checked against the live server in
 * mcp-check, which already lists the tool schemas.
 *
 *   npx tsx --test scripts/guide-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CHECK_OPTION_NAMES, CHECK_RULES, parseCheckArgs, WORTH_A_LOOK_RULES } from "../src/engine/check.ts";
import { CI_OPTION_NAMES, KEY_ENV, parseCiArgs } from "../src/engine/ci.ts";
import { LOGIN_OPTION_NAMES } from "../src/engine/profiles.ts";
import { SCRIPT_FLAGS } from "../src/engine/scripted-login.ts";
import { GUIDE_DIR, toWikiPage } from "./guide-wiki.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Line endings as a Windows checkout may have them (\r\n) become \n, so every parser below sees one shape. */
const lf = (text: string): string => text.replace(/\r\n?/g, "\n");
const read = (rel: string): string => lf(fs.readFileSync(path.join(REPO, rel), "utf8"));
const readYaml = (rel: string) => parseYaml(read(rel)) as Record<string, any>;

const PAGE_NAMES = [
  "Home.md",
  "_Sidebar.md",
  "Start-here.md",
  "Ways-to-use-it.md",
  "Signing-in.md",
  "Safety-model.md",
  "Recipes.md",
  "Configuration-reference.md",
  "Measuring-it.md",
  "Troubleshooting.md",
];
const pages = new Map(PAGE_NAMES.map((name) => [name, read(`${GUIDE_DIR}/${name}`)]));
const REFERENCE = pages.get("Configuration-reference.md")!;

// ── Markdown, as GitHub reads it ─────────────────────────────────────────────

/** The page's lines, each marked as prose or inside a fenced code block. */
function lines(text: string): Array<{ text: string; code: boolean; n: number }> {
  let fence: string | null = null;
  return lf(text)
    .split("\n")
    .map((line, i) => {
      const opener = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && line.trim() === opener[1]) fence = null;
        return { text: line, code: true, n: i + 1 };
      }
      if (opener) {
        fence = opener[1];
        return { text: line, code: true, n: i + 1 };
      }
      return { text: line, code: false, n: i + 1 };
    });
}

/** Prose with inline code spans blanked out: where links and headings live. */
function prose(text: string): Array<{ text: string; n: number }> {
  return lines(text)
    .filter((l) => !l.code)
    .map((l) => ({ text: l.text.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length)), n: l.n }));
}

/** Everything a reader would type: fenced blocks and inline code spans. */
function codeText(text: string): string {
  const out: string[] = [];
  for (const l of lines(text)) {
    if (l.code) out.push(l.text);
    else for (const m of l.text.matchAll(/(`+)([^`]*?)\1/g)) out.push(m[2]);
  }
  return out.join("\n");
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const l of lines(text)) {
    if (l.code) continue;
    const h = l.text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!h) continue;
    const base = slug(h[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}

function links(text: string): Array<{ target: string; n: number }> {
  const out: Array<{ target: string; n: number }> = [];
  for (const l of prose(text)) for (const m of l.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ target: m[1], n: l.n });
  return out;
}

/** A table row's cells: split on pipes a backslash does not escape. */
function cells(row: string): string[] {
  const inner = row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

interface Table {
  header: string[];
  rows: string[][];
  line: number;
}

/** Every table in the page, with the problems that would stop GitHub rendering it as one. */
function tables(text: string): { tables: Table[]; problems: string[] } {
  const all = lines(text);
  const found: Table[] = [];
  const problems: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (l.code || !l.text.trimStart().startsWith("|")) continue;
    if (i > 0 && all[i - 1].text.trim() !== "" && !all[i - 1].text.trimStart().startsWith("|")) {
      problems.push(`line ${l.n}: a table must follow a blank line`);
    }
    const block: typeof all = [];
    while (i < all.length && !all[i].code && all[i].text.trimStart().startsWith("|")) block.push(all[i++]);
    const [head, delimiter, ...body] = block;
    const header = cells(head.text);
    if (!delimiter || !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(delimiter.text)) {
      problems.push(`line ${head.n}: the second row of a table must be its delimiter row (|---|---|)`);
      continue;
    }
    if (cells(delimiter.text).length !== header.length)
      problems.push(`line ${delimiter.n}: ${cells(delimiter.text).length} delimiter cells for ${header.length} header cells`);
    for (const row of body) {
      const n = cells(row.text).length;
      if (n !== header.length) problems.push(`line ${row.n}: ${n} cells where the header has ${header.length} (an unescaped | inside code splits a cell)`);
    }
    found.push({ header, rows: body.map((r) => cells(r.text)), line: head.n });
  }
  return { tables: found, problems };
}

/** The body of the section under a heading, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const all = lf(text).split("\n");
  const start = all.findIndex((l) => l.trim() === heading);
  assert.ok(start >= 0, `the configuration reference has no "${heading}" heading`);
  const level = heading.match(/^#+/)![0].length;
  const end = all.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)![0].length <= level);
  return all.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** The first table in a section, as rows of cells. */
function tableIn(text: string, heading: string): string[][] {
  const t = tables(section(text, heading)).tables[0];
  assert.ok(t, `no table under "${heading}"`);
  return t.rows;
}

/** The outputs a section names on its "Outputs: `a`, `b`." line. */
function outputsIn(text: string, heading: string): string[] {
  const line = section(text, heading).match(/Outputs: (.+?)\.\n/);
  assert.ok(line, `${heading} lists its outputs`);
  return sorted([...line[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
}

/** Backticked `--options` in a cell. */
const optionsIn = (cell: string): string[] => [...cell.matchAll(/`--([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
/** The single backticked name in a first cell. */
const nameIn = (cell: string): string => {
  const m = cell.match(/^`([^`]+)`$/);
  assert.ok(m, `expected a single backticked name, got: ${cell}`);
  return m[1];
};
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

// ── Rendering ────────────────────────────────────────────────────────────────

test("the guide is the pages Home and the sidebar link to, and nothing else", () => {
  const onDisk = fs.readdirSync(path.join(REPO, GUIDE_DIR)).filter((f) => f.endsWith(".md"));
  assert.deepEqual(sorted(onDisk), sorted(PAGE_NAMES));
  for (const index of ["Home.md", "_Sidebar.md"]) {
    const linked = new Set(links(pages.get(index)!).map((l) => l.target.split("#")[0]));
    for (const name of PAGE_NAMES) {
      if (name === "_Sidebar.md" || name === index) continue;
      assert.ok(linked.has(name), `${index} does not link to ${name}`);
    }
  }
  for (const [name, text] of pages) if (name !== "_Sidebar.md") assert.match(text, /^# \S/, `${name} starts with its title`);
});

test("every page renders as GitHub Markdown: whole tables, closed code fences", () => {
  for (const [name, text] of pages) {
    const { problems } = tables(text);
    assert.deepEqual(problems, [], `${name}: ${problems.join("; ")}`);
    assert.ok(!unclosedFence(text), `${name}: a code fence is never closed, so the rest of the page renders as code`);
  }
});

/** Whether the page ends inside a fenced code block. */
function unclosedFence(text: string): boolean {
  let fence: string | null = null;
  for (const line of lf(text).split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
  }
  return fence !== null;
}

test("the table checker catches the mistakes that break a GitHub table", () => {
  const good = "| a | b |\n|---|---|\n| `x \\| y` | z |\n";
  assert.deepEqual(tables(good).problems, []);
  assert.match(tables("| a | b |\n|---|---|\n| `x | y` | z |\n").problems.join(), /3 cells where the header has 2/);
  assert.match(tables("| a | b |\n| x | y |\n").problems.join(), /delimiter row/);
  assert.match(tables("Some text\n| a | b |\n|---|---|\n").problems.join(), /blank line/);
  assert.deepEqual(tables("```\n| not | a table\n```\n").problems, [], "a table inside a code block is not a table");
  assert.equal(unclosedFence("```bash\nnpm test\n```\n"), false);
  assert.equal(unclosedFence("```bash\nnpm test\n"), true);
  assert.equal(unclosedFence("````md\n```\n````\n"), false, "a shorter fence inside a longer one does not close it");
});

test("a page checked out with Windows line endings parses the same", () => {
  const page = "# Title\n\n### Action: x\n\n`uses: x`. Outputs: `a`, `b`.\n\n| Input | Default |\n|---|---|\n| `url` | (required) |\n\n## Next\n";
  const crlf = page.replace(/\n/g, "\r\n");
  assert.deepEqual(outputsIn(crlf, "### Action: x"), ["a", "b"]);
  assert.deepEqual(tableIn(crlf, "### Action: x"), [["`url`", "(required)"]]);
  assert.deepEqual(tables(crlf).problems, []);
  assert.deepEqual([...anchors(crlf)], ["title", "action-x", "next"]);
  assert.equal(unclosedFence("```sh\r\nnpm test\r\n```\r\n"), false);
  assert.equal(wiki("[a](Home.md)\r\n```\r\n[b](Home.md)\r\n```\r\n"), "[a](Home)\r\n```\r\n[b](Home.md)\r\n```\r\n", "the wiki transform keeps code as code");
});

test("slugs follow GitHub's rules for the headings the guide uses", () => {
  assert.equal(slug("`scenescout check`: a gate in CI"), "scenescout-check-a-gate-in-ci");
  assert.equal(slug("/scenescout qa on a pull request"), "scenescout-qa-on-a-pull-request");
  assert.equal(slug("5. A run split across parallel lanes"), "5-a-run-split-across-parallel-lanes");
  assert.equal(slug("Unattended runs (scenescout ci)"), "unattended-runs-scenescout-ci");
  assert.equal(slug("🚀 Quickstart"), "-quickstart");
  assert.deepEqual([...anchors("# A\n## A\n```\n# not a heading\n```\n")], ["a", "a-1"]);
});

test("every link resolves: pages, repository files and anchors", () => {
  const broken: string[] = [];
  for (const [name, text] of pages) {
    for (const { target, n } of links(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const [file, anchor] = target.split("#");
      const resolved = file ? path.posix.normalize(path.posix.join(GUIDE_DIR, file)) : `${GUIDE_DIR}/${name}`;
      const where = `${name}:${n} → ${target}`;
      if (resolved.startsWith("..")) {
        broken.push(`${where}: leaves the repository`);
        continue;
      }
      if (!fs.existsSync(path.join(REPO, resolved))) {
        broken.push(`${where}: no such file`);
        continue;
      }
      if (anchor !== undefined && resolved.endsWith(".md") && !anchors(read(resolved)).has(anchor)) broken.push(`${where}: no heading with that anchor`);
    }
  }
  assert.deepEqual(broken, []);
});

// ── Hygiene ──────────────────────────────────────────────────────────────────

const LOCAL_PATH_RE =
  /(?:\/Users\/|\/home\/)[A-Za-z][A-Za-z0-9._-]+|[A-Za-z]:[\\/]+[Uu]sers[\\/]+[A-Za-z]|(?:^|[\s("'`=])\/(?:tmp|private|var\/folders)\/|\.claude\/worktrees|scratchpad/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const ALLOWED_EMAIL_RE = /@((?:[a-z0-9-]+\.)*example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*(?:example|test|invalid|localhost)|users\.noreply\.github\.com)$/i;

test("no page names a local path, a home directory or a real address", () => {
  const found: string[] = [];
  for (const [name, text] of pages) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(LOCAL_PATH_RE)) found.push(`${name}:${i + 1}: ${m[0].trim()}`);
      for (const m of line.matchAll(EMAIL_RE)) if (!ALLOWED_EMAIL_RE.test(m[0])) found.push(`${name}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(found, []);
});

test("the local-path rule catches what it is for and passes placeholders", () => {
  const hits = (s: string) => [...s.matchAll(LOCAL_PATH_RE)].length;
  // Built at runtime, so this file never holds a home-directory path for hygiene-test to find.
  assert.equal(hits(`run from ${["", "Users", "someone", "Dev", "app"].join("/")}`), 1);
  assert.equal(hits("npm run bench -- /tmp/bench/run-3"), 1);
  assert.equal(hits("a worktree under .claude/worktrees/x"), 1);
  assert.equal(hits('--project "$RUNNER_TEMP/scenescout"'), 0);
  assert.equal(hits("GET /api/users/12 and ~/.cursor/mcp.json"), 0);
});

// ── The CLI ──────────────────────────────────────────────────────────────────

const CLI_SOURCE = read("src/cli.ts");
/** Flags the CLI reads by name in cli.ts itself: install, doctor and watch parse their own. */
const CLI_LITERAL_FLAGS = sorted([...CLI_SOURCE.matchAll(/"--([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
/**
 * Literals in cli.ts that are not options of install, doctor or watch, each
 * with why. Every one must still be in cli.ts, so the list cannot go stale.
 */
const NOT_THEIR_OPTIONS: Record<string, string> = {
  help: "a request for the usage, not an option",
  version: "a request for the version, not an option",
  browser: "install refuses it as a slip for --browsers",
};
const SCRIPT_ONLY = ["script", ...SCRIPT_FLAGS];
/** The subcommands: the cases of the dispatch at the end of cli.ts. */
const COMMANDS = sorted(
  [...CLI_SOURCE.slice(CLI_SOURCE.indexOf("switch (command)")).matchAll(/^\s*case "([a-z]+)":/gm)].map((m) => m[1]).filter((c) => c !== "help"),
);

test("the reference lists every command the CLI dispatches", () => {
  const listed = sorted(tableIn(REFERENCE, "## Commands").map((r) => r[0].match(/^`scenescout ([a-z]+)/)?.[1] ?? ""));
  assert.deepEqual(listed, COMMANDS);
});

test("the reference lists exactly the options of check, ci and login", () => {
  const listed = (command: string) => sorted(tableIn(REFERENCE, `### \`scenescout ${command}\``).flatMap((r) => optionsIn(r[0])));
  assert.deepEqual(listed("check"), sorted(CHECK_OPTION_NAMES));
  assert.deepEqual(listed("ci"), sorted(CI_OPTION_NAMES));
  assert.deepEqual(listed("login"), sorted([...LOGIN_OPTION_NAMES, ...SCRIPT_ONLY]));
});

test("the reference lists exactly the flags install, doctor and watch read", () => {
  for (const flag of Object.keys(NOT_THEIR_OPTIONS))
    assert.ok(CLI_LITERAL_FLAGS.includes(flag), `--${flag} is no longer in cli.ts; drop it from NOT_THEIR_OPTIONS`);
  const inCode = CLI_LITERAL_FLAGS.filter((f) => !(f in NOT_THEIR_OPTIONS) && !SCRIPT_ONLY.includes(f));
  const listed = sorted(["install", "doctor", "watch"].flatMap((c) => tableIn(REFERENCE, `### \`scenescout ${c}\``).flatMap((r) => optionsIn(r[0]))));
  assert.deepEqual(listed, sorted(inCode));
});

test("the defaults the reference gives for check and ci are the parsers' defaults", () => {
  const defaults = (command: string) => new Map(tableIn(REFERENCE, `### \`scenescout ${command}\``).map((r) => [optionsIn(r[0])[0], r[1]]));
  const check = parseCheckArgs(["http://127.0.0.1:3000"], "/p");
  const ci = parseCiArgs(["http://127.0.0.1:3000"], "/p");
  assert.ok(check.ok && ci.ok);
  const c = check.options;
  const expectCheck: Record<string, string | number> = {
    "fail-on": c.failOn,
    mode: c.mode,
    "max-routes": c.maxRoutes,
    "flow-writes": c.flowWrites,
    "on-refused-step": c.onRefusedStep,
    "gate-retests": c.gateRetests,
    retest: c.retest ? "on" : "off",
  };
  for (const [option, value] of Object.entries(expectCheck)) assert.equal(defaults("check").get(option), `\`${value}\``, `check --${option}`);
  const o = ci.options;
  const expectCi: Record<string, string | number> = {
    mode: o.mode,
    level: o.level,
    "max-turns": o.caps.turns,
    "max-tokens": o.caps.tokens,
    "max-minutes": o.caps.wallMs / 60_000,
  };
  for (const [option, value] of Object.entries(expectCi)) assert.equal(defaults("ci").get(option), `\`${value}\``, `ci --${option}`);
});

test("the check rules table is every rule with its severity", () => {
  const rows = tableIn(REFERENCE, "### Check rules");
  const listed = new Map(rows.map((r) => [nameIn(r[0]), r[1]]));
  const expected = new Map<string, string>([
    ...Object.entries(CHECK_RULES).map(([id, rule]) => [id, rule.severity] as [string, string]),
    ...Object.keys(WORTH_A_LOOK_RULES).map((id) => [id, "worth a look"] as [string, string]),
  ]);
  assert.deepEqual(new Map([...listed].sort()), new Map([...expected].sort()));
});

/** Flags of the skill's command, the bench script and other tools the pages show being run. */
const SKILL_FLAGS = [...read("skills/scenescout/SKILL.md").matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
const BENCH_FLAGS = [...read("scripts/bench.ts").matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
const OTHER_TOOLS_FLAGS = ["scope", "with-deps"];

test("every --option a page mentions is one SceneScout has", () => {
  const known = new Set<string>([
    ...CHECK_OPTION_NAMES,
    ...CI_OPTION_NAMES,
    ...LOGIN_OPTION_NAMES,
    ...SCRIPT_ONLY,
    ...CLI_LITERAL_FLAGS,
    ...SKILL_FLAGS,
    ...BENCH_FLAGS,
    ...OTHER_TOOLS_FLAGS,
  ]);
  const unknown: string[] = [];
  for (const [name, text] of pages) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) if (!known.has(m[1])) unknown.push(`${name}:${i + 1}: --${m[1]}`);
    });
  }
  assert.deepEqual(unknown, []);
});

test("every scenescout command a page shows is one the CLI has", () => {
  const unknown: string[] = [];
  for (const [name, text] of pages) {
    for (const m of codeText(text).matchAll(/(?<![\w/.@-])scenescout[ \t]+([a-z]+)\b/g))
      if (!COMMANDS.includes(m[1])) unknown.push(`${name}: scenescout ${m[1]}`);
  }
  assert.deepEqual(unknown, []);
});

// ── Environment variables ────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? sourceFiles(rel) : e.name.endsWith(".ts") ? [rel] : [];
  });
}

/** Names the code reads from the environment: its own SCENESCOUT_ variables, the API keys, and any `env.NAME`. */
const NOT_CONFIGURATION = new Set(["PATH"]);
const ENV_IN_CODE = sorted(
  sourceFiles("src").flatMap((file) => {
    const text = read(file);
    return [...text.matchAll(/\b(SCENESCOUT_[A-Z0-9_]*[A-Z0-9])\b/g), ...text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)]
      .map((m) => m[1])
      .filter((n) => !NOT_CONFIGURATION.has(n));
  }),
);

test("the reference lists exactly the environment variables the code reads", () => {
  assert.ok(ENV_IN_CODE.includes("SCENESCOUT_LIVE") && ENV_IN_CODE.includes("CLAUDE_CONFIG_DIR"), "the scan of src/ found the variables it should");
  const listed = sorted(tableIn(REFERENCE, "## Environment variables").map((r) => nameIn(r[0])));
  assert.deepEqual(listed, sorted([...ENV_IN_CODE, ...Object.values(KEY_ENV)]));
});

const QA_WORKFLOW = read("examples/workflows/scenescout-qa.yml");
const QA_VARIABLES = sorted([...QA_WORKFLOW.matchAll(/\bvars\.([A-Z0-9_]+)/g)].map((m) => m[1]));
const QA_SECRETS = sorted([...QA_WORKFLOW.matchAll(/\bsecrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));

test("the reference lists exactly the repository variables and secrets the /scenescout qa template reads", () => {
  const rows = tableIn(REFERENCE, "## Repository variables and secrets for `/scenescout qa`");
  const of = (kind: string) => sorted(rows.filter((r) => r[1] === kind).map((r) => nameIn(r[0])));
  assert.deepEqual(of("variable"), QA_VARIABLES);
  assert.deepEqual(of("secret"), QA_SECRETS);
  assert.equal(rows.length, QA_VARIABLES.length + QA_SECRETS.length, "every row is a variable or a secret");
});

test("every SCENESCOUT_ name a page mentions exists", () => {
  const known = new Set([...ENV_IN_CODE, ...QA_VARIABLES, ...QA_SECRETS, "GUIDE_WIKI_TOKEN"]);
  const unknown: string[] = [];
  for (const [name, text] of pages) {
    // `_PASSWORD_SELECTOR` and the like are suffixes of a name spelled out beside them.
    for (const m of text.matchAll(/(?<![A-Za-z0-9_])(SCENESCOUT_[A-Z0-9_]*[A-Z0-9])\b/g)) if (!known.has(m[1])) unknown.push(`${name}: ${m[1]}`);
  }
  assert.deepEqual(unknown, []);
});

// ── GitHub Action inputs ─────────────────────────────────────────────────────

const ACTIONS: Array<{ heading: string; file: string }> = [
  { heading: "### Action: check", file: "action.yml" },
  { heading: "### Action: ci", file: "ci/action.yml" },
  { heading: "### Action: qa", file: "qa/action.yml" },
];

test("the reference lists every action input with the action's default, and every output", () => {
  for (const { heading, file } of ACTIONS) {
    const action = readYaml(file);
    const inputs = action.inputs as Record<string, { default?: string; required?: boolean }>;
    const rows = tableIn(REFERENCE, heading);
    assert.deepEqual(sorted(rows.map((r) => nameIn(r[0]))), sorted(Object.keys(inputs)), `${file} inputs`);
    for (const row of rows) {
      const input = inputs[nameIn(row[0])];
      const expected = input.required ? "(required)" : input.default === undefined || input.default === "" ? "empty" : `\`${input.default}\``;
      assert.equal(row[1], expected, `${file} input ${row[0]}`);
    }
    assert.deepEqual(outputsIn(REFERENCE, heading), sorted(Object.keys(action.outputs)), `${file} outputs`);
  }
});

// ── Publishing to the wiki ───────────────────────────────────────────────────

const PAGE_SET = new Set(PAGE_NAMES);
const wiki = (text: string) => toWikiPage(text, { pages: PAGE_SET, repo: "owner/repo", ref: "v1.2.3" });

test("a guide page's links are rewritten for the wiki", () => {
  assert.equal(wiki("See [signing in](Signing-in.md)."), "See [signing in](Signing-in).");
  assert.equal(wiki("[x](Signing-in.md#the-rules-for-ci-credentials)"), "[x](Signing-in#the-rules-for-ci-credentials)");
  assert.equal(wiki("[ci](../ci.md#saved-flows)"), "[ci](https://github.com/owner/repo/blob/v1.2.3/docs/ci.md#saved-flows)");
  assert.equal(wiki("[demo](../../demo-app/README.md)"), "[demo](https://github.com/owner/repo/blob/v1.2.3/demo-app/README.md)");
  assert.equal(wiki("[here](#levels) and [out](https://example.com/a.md)"), "[here](#levels) and [out](https://example.com/a.md)");
  assert.equal(wiki("[unknown](Missing.md)"), "[unknown](https://github.com/owner/repo/blob/v1.2.3/docs/guide/Missing.md)", "only a real page loses .md");
});

test("code is never rewritten, and a link out of the repository is refused", () => {
  const fenced = "```md\n[x](Signing-in.md)\n```\n[y](Signing-in.md)";
  assert.equal(wiki(fenced), "```md\n[x](Signing-in.md)\n```\n[y](Signing-in)");
  assert.equal(wiki("`[x](Home.md)` and [x](Home.md)"), "`[x](Home.md)` and [x](Home)");
  assert.throws(() => wiki("[x](../../../outside.md)"), /leaves the repository/);
});

test("every published page links only to wiki pages, anchors and absolute URLs", () => {
  for (const [name, text] of pages) {
    for (const { target } of links(wiki(text))) {
      const file = target.split("#")[0];
      const ok = /^https:\/\//.test(target) || target.startsWith("#") || PAGE_SET.has(`${file}.md`);
      assert.ok(ok, `${name}: ${target} would not resolve on the wiki`);
    }
  }
});

test("the wiki workflow: release or by hand, a build job that cannot write, a push job that runs no repository code", () => {
  const wf = readYaml(".github/workflows/guide-wiki.yml");
  const text = read(".github/workflows/guide-wiki.yml");
  assert.deepEqual(Object.keys(wf.on).sort(), ["release", "workflow_dispatch"], "never pull_request, pull_request_target or workflow_run");
  assert.deepEqual(wf.on.release.types, ["published"]);
  assert.deepEqual(wf.permissions, { contents: "read" }, "read-only unless a job asks");
  assert.deepEqual(Object.keys(wf.jobs), ["build", "publish"]);
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const build = wf.jobs.build as { permissions: unknown; steps: Step[] };
  const publish = wf.jobs.publish as { permissions: unknown; needs: string; steps: Step[] };
  for (const job of [build, publish]) {
    for (const step of job.steps) if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${step.name}: an expression spliced into a shell script`);
  }

  // build: the repository's code runs here, with a token that cannot write.
  assert.deepEqual(build.permissions, { contents: "read" });
  const choose = build.steps.find((s) => s.run?.includes("GITHUB_OUTPUT"));
  const checkout = build.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.ok(choose && checkout && build.steps.indexOf(choose) < build.steps.indexOf(checkout), "the ref is chosen and checked before checkout");
  assert.match(choose.run!, /\^\(v\[0-9\]\+/, "the ref must be a release tag");
  assert.match(choose.run!, /\|main\)\$/, "or main");
  assert.equal(checkout.with?.["persist-credentials"], false, "the checkout leaves no token in .git/config");
  assert.ok(
    build.steps.some((s) => s.run?.includes("scripts/guide-wiki.mjs")),
    "the pages are built by the tested transform",
  );
  assert.ok(
    build.steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")),
    "and handed over as an artifact",
  );
  assert.doesNotMatch(JSON.stringify(build), /secrets\./, "no secret in the job that runs repository code");

  // publish: contents: write, and nothing but the artifact and git.
  assert.equal(publish.needs, "build");
  assert.deepEqual(publish.permissions, { contents: "write" }, "contents: write for the wiki push, and nothing else");
  assert.deepEqual(
    publish.steps.map((s) => s.uses?.split("@")[0] ?? "run"),
    ["actions/download-artifact", "run"],
    "no checkout and no other action in the job that can write",
  );
  const push = publish.steps[1];
  assert.equal(push.env?.WIKI_TOKEN, "${{ secrets.GUIDE_WIKI_TOKEN || github.token }}", "the built-in token, or the one documented secret");
  assert.doesNotMatch(push.run!, /\b(node|npm|npx|tsx|bash|sh)\b|\.\/|scripts\//, "the step holding the token runs no repository code");
  assert.match(push.run!, /::error title=Wiki push refused::.*GUIDE_WIKI_TOKEN/, "a refused push names the secret that fixes it");
  assert.match(push.run!, /::error title=Wiki not reachable::/, "a missing wiki says so");
  assert.deepEqual(sorted([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1])), ["GUIDE_WIKI_TOKEN"], "no other secret");
});

test("the release workflow dispatches the wiki publish for the exact tag it released, from a job that can do nothing else", () => {
  const wf = readYaml(".github/workflows/release.yml");
  assert.equal(wf.jobs.release.outputs.published, "${{ steps.changesets.outputs.published }}");
  assert.equal(wf.jobs.release.outputs.tag, "${{ steps.major.outputs.tag }}");
  const major = (wf.jobs.release.steps as Array<{ id?: string; run?: string }>).find((s) => s.id === "major");
  assert.match(major?.run ?? "", /echo "tag=v\$version" >> "\$GITHUB_OUTPUT"/, "the tag is the version just published");
  const job = wf.jobs["publish-guide"];
  assert.ok(job, "release.yml has a publish-guide job");
  assert.equal(job.needs, "release");
  assert.equal(job.if, "needs.release.outputs.published == 'true' && needs.release.outputs.tag != ''", "only when something was published");
  assert.deepEqual(job.permissions, { actions: "write" });
  const steps = job.steps as Array<{ run?: string; uses?: string; env?: Record<string, string> }>;
  assert.ok(!steps.some((s) => s.uses), "no checkout, no action: it only dispatches");
  assert.equal(steps[0].env?.TAG, "${{ needs.release.outputs.tag }}");
  assert.equal(steps[0].run, 'gh workflow run guide-wiki.yml --ref main -f ref="$TAG"');
});

test("the suite is wired into npm test and listed in AGENTS.md", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["guide-test"], "tsx --test scripts/guide-test.ts");
  assert.match(pkg.scripts["test:unit"], /npm run guide-test\b/);
  assert.match(read("AGENTS.md"), /`guide-test` for/);
});
