#!/usr/bin/env node
/**
 * The logic behind the GitHub Action in action.yml, which runs
 * `scenescout check` in a workflow. It lives here rather than in the YAML's
 * shell steps so it runs the same on Linux, macOS and Windows runners, and so
 * check-test can table-test it without a runner.
 *
 * Plain JavaScript with no dependencies: the action runs it straight from the
 * checked-out ref, before any SceneScout package is installed.
 *
 *   node check-action.mjs resolve   work out what to install and where results go
 *   node check-action.mjs run       run the check and publish its numbers as outputs
 *   node check-action.mjs verdict   fail the step the way the exit code says
 *
 * Every subcommand reads the action's inputs from INPUTS (the `inputs` context
 * as JSON), never from values pasted into a script, so an input cannot inject
 * shell.
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Inputs that configure the action rather than the check. Every other input
 * is passed to `scenescout check` as `--<name>=<value>` when it is not empty,
 * so an input's name IS the CLI option's name; check-test holds the two lists
 * equal.
 */
export const ACTION_ONLY_INPUTS = [
  "url",
  "working-directory",
  "version",
  "cli",
  "node-version",
  "install-deps",
  "upload-sarif",
  "upload-artifact",
  "artifact-name",
];

export const ENGINES = ["chromium", "firefox", "webkit"];

/** The arguments for `scenescout check`, from the action's inputs. */
export function checkArgs(inputs) {
  const url = String(inputs.url ?? "").trim();
  if (!url) throw new Error("the url input is required: the address of the running app to check");
  const args = ["check", url];
  for (const [name, raw] of Object.entries(inputs)) {
    if (ACTION_ONLY_INPUTS.includes(name)) continue;
    const value = String(raw ?? "").trim();
    // `=` keeps a value that starts with "--" from being read as the next option.
    if (value) args.push(`--${name}=${value}`);
  }
  return args;
}

/** The engine to check with; empty means the CLI's default, Chromium. */
export function engineOf(inputs) {
  const browser = String(inputs.browser ?? "").trim() || "chromium";
  if (!ENGINES.includes(browser)) throw new Error(`the browser input must be one of ${ENGINES.join(", ")} (got "${browser}")`);
  return browser;
}

/** What to download: a check runs headless, and headless Chromium is the smaller headless shell. */
export function installTarget(engine) {
  return engine === "chromium" ? "chromium-headless-shell" : engine;
}

/** Where the check writes, resolved the way the CLI resolves it: --out, else <project>/.scenescout/check. */
export function outDirFor(inputs, cwd) {
  const out = String(inputs.out ?? "").trim();
  if (out) return path.resolve(cwd, out);
  return path.resolve(cwd, String(inputs.project ?? "").trim() || ".", ".scenescout", "check");
}

/** Playwright's own default browser cache, which the action caches between runs. */
export function browsersPath(env, platform, home) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "ms-playwright");
  if (platform === "darwin") return path.posix.join(home, "Library", "Caches", "ms-playwright");
  return path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, ".cache"), "ms-playwright");
}

/** The numbers the action publishes, read from check.json. Null when there is no verdict to read. */
export function summaryOutputs(json) {
  if (!json || typeof json !== "object" || !json.gate || !json.counts) return null;
  return {
    passed: String(json.gate.passed === true),
    failing: String(json.gate.failing ?? 0),
    high: String(json.counts.high ?? 0),
    medium: String(json.counts.medium ?? 0),
    low: String(json.counts.low ?? 0),
  };
}

/** A workflow command's message must not break the line it is written on. */
export function escapeAnnotation(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * How the step ends. Exit 1 is the gate's verdict; 2, or anything else (a
 * crash, a signal), means the check could not run, and says so, so a broken
 * setup is never read as a failing app.
 */
export function verdict({ exitCode, failing, failOn, url, error }) {
  const code = Number(exitCode);
  if (code === 0) return { exit: 0, annotation: null };
  if (code === 1) {
    const n = Number(failing) || 0;
    return {
      exit: 1,
      annotation: `::error title=SceneScout check failed::${escapeAnnotation(
        `${n} issue(s) at ${failOn || "high"} severity or worse on ${url}. The report is on the job summary and in report.md.`,
      )}`,
    };
  }
  const why = String(error ?? "").trim() || (Number.isNaN(code) ? "the check did not start" : `it exited with code ${code}`);
  return {
    exit: 2,
    annotation: `::error title=SceneScout check could not run::${escapeAnnotation(`No verdict for ${url}: ${why}. This is a setup problem, not a result about the app.`)}`,
  };
}

function inputsFromEnv() {
  try {
    return JSON.parse(process.env.INPUTS || "{}");
  } catch (err) {
    throw new Error(`INPUTS is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
  if (file) fs.appendFileSync(file, lines.join("\n") + "\n");
  else for (const line of lines) console.log(line);
}

/**
 * npm, run without a shell: on Windows npm is a .cmd script, which Node only
 * starts through a shell, and a shell would reinterpret the version spec.
 * There, npm's own entry point beside node.exe is run with node instead.
 */
export function npmCommand(platform, execPath, exists = fs.existsSync) {
  if (platform !== "win32") return { file: "npm", prefixArgs: [] };
  const cli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!exists(cli)) throw new Error(`npm was not found beside ${execPath}; install node with actions/setup-node`);
  return { file: execPath, prefixArgs: [cli] };
}

/** A version, a range like ^3.10 or a dist-tag: nothing a command line could read as anything else. */
export function isVersionSpec(version) {
  return /^[0-9A-Za-z.^~+-]+$/.test(version);
}

/** Install the published package into a directory of its own, so install and check use one copy with one Playwright. */
function installPackage(version) {
  if (!isVersionSpec(version)) throw new Error(`the version input is not an npm version, range or tag: "${version}"`);
  const prefix = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `scenescout-${version.replace(/[^0-9A-Za-z.-]/g, "_")}`);
  fs.mkdirSync(prefix, { recursive: true });
  // --ignore-scripts: no dependency's install script runs in the user's workflow.
  const npmArgs = ["install", "--prefix", prefix, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts", `scenescout@${version}`];
  const npm = npmCommand(process.platform, process.execPath);
  execFileSync(npm.file, [...npm.prefixArgs, ...npmArgs], { stdio: "inherit" });
  return path.join(prefix, "node_modules", "scenescout", "dist", "cli.js");
}

/** Whether a CLI's --help lists `check`: releases before it have no such command. */
export function hasCheckCommand(helpText) {
  return /scenescout check <url>/.test(helpText);
}

const PIN_ADVICE =
  "Use the action at a release: a vX.Y.Z tag or the commit a release was tagged at. Between releases the action's ref installs the last published CLI, which may be older than the action. Or set the version input";

export function noCheckCommand(version) {
  return `scenescout ${version} has no check command, so this action cannot run it. ${PIN_ADVICE}.`;
}

/** The CLI's own error, with the likely cause added when it is an older CLI refusing a newer action's input. */
export function explainError(error, version) {
  const unknown = /^unknown option --(\S+)/.exec(String(error ?? ""));
  if (!unknown) return String(error ?? "");
  return `scenescout ${version || "(unknown version)"} does not accept the ${unknown[1]} input, so it is older than this action. ${PIN_ADVICE}.`;
}

/**
 * The artifact's name when none is given: unique per use within a job, so a
 * second use does not collide with the first. Jobs in a matrix share a job id,
 * so they still need an artifact-name each.
 */
export function defaultArtifactName(job, use) {
  const base = `scenescout-check${job ? `-${String(job).replace(/[^\w.-]/g, "_")}` : ""}`;
  return use > 1 ? `${base}-${use}` : base;
}

/** This job's count of uses of the action so far, kept in the job's own temp directory. */
function nextUse() {
  const counter = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "scenescout-check-uses");
  let n = 0;
  try {
    n = Number(fs.readFileSync(counter, "utf8")) || 0;
  } catch {
    // The first use in this job: no counter yet.
  }
  fs.writeFileSync(counter, String(n + 1));
  return n + 1;
}

function resolve() {
  const inputs = inputsFromEnv();
  checkArgs(inputs); // fail on a missing url before downloading anything
  const engine = engineOf(inputs);
  const cwd = process.cwd();
  let cli;
  const local = String(inputs.cli ?? "").trim();
  if (local) {
    cli = path.resolve(cwd, local);
    if (!fs.existsSync(cli)) throw new Error(`the cli input names ${cli}, which does not exist; build it first`);
  } else {
    const actionPath = process.env.GITHUB_ACTION_PATH || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    // The default is the version this action's ref was released as, so @v3.10.0 runs scenescout 3.10.0.
    const version = String(inputs.version ?? "").trim() || JSON.parse(fs.readFileSync(path.join(actionPath, "package.json"), "utf8")).version;
    cli = installPackage(version);
  }
  const packageRoot = path.dirname(path.dirname(cli));
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  if (!hasCheckCommand(`${help.stdout ?? ""}${help.stderr ?? ""}`)) throw new Error(noCheckCommand(version));
  const require = createRequire(path.join(packageRoot, "package.json"));
  const playwrightPkg = require.resolve("playwright/package.json");
  setOutputs({
    cli,
    version,
    "artifact-name": String(inputs["artifact-name"] ?? "").trim() || defaultArtifactName(process.env.GITHUB_JOB, nextUse()),
    engine,
    "install-target": installTarget(engine),
    "playwright-version": JSON.parse(fs.readFileSync(playwrightPkg, "utf8")).version,
    "playwright-cli": path.join(path.dirname(playwrightPkg), "cli.js"),
    "browsers-path": browsersPath(process.env, process.platform, os.homedir()),
    "out-dir": outDirFor(inputs, cwd),
  });
}

function run() {
  const inputs = inputsFromEnv();
  const cli = process.env.SCENESCOUT_CLI;
  const outDir = process.env.SCENESCOUT_OUT_DIR;
  if (!cli || !outDir) throw new Error("SCENESCOUT_CLI and SCENESCOUT_OUT_DIR must be set by the resolve step");
  // Results of an earlier run in the same directory must not be read as this run's.
  for (const f of ["report.md", "check.json", "check.sarif"]) fs.rmSync(path.join(outDir, f), { force: true });
  const child = spawnSync(process.execPath, [cli, ...checkArgs(inputs)], { stdio: ["ignore", "inherit", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const stderr = child.stderr ? child.stderr.toString() : "";
  if (stderr) process.stderr.write(stderr);
  const exitCode = child.status ?? (child.error ? "error" : `signal ${child.signal}`);
  const error =
    stderr
      .split(/\r?\n/)
      .filter((l) => l.startsWith("scenescout check:"))
      .pop()
      ?.replace(/^scenescout check:\s*(could not run:\s*)?/, "") ?? (child.error ? child.error.message : "");
  const explained = explainError(error, process.env.SCENESCOUT_VERSION);
  const file = (name) => (fs.existsSync(path.join(outDir, name)) ? path.join(outDir, name) : "");
  let summary = null;
  if (file("check.json")) summary = summaryOutputs(JSON.parse(fs.readFileSync(file("check.json"), "utf8")));
  setOutputs({
    "exit-code": exitCode,
    error: explained,
    report: file("report.md"),
    json: file("check.json"),
    sarif: file("check.sarif"),
    ...(summary ?? { passed: "", failing: "", high: "", medium: "", low: "" }),
  });
}

function end() {
  const inputs = inputsFromEnv();
  const v = verdict({
    exitCode: process.env.EXIT_CODE === "" || process.env.EXIT_CODE === undefined ? NaN : process.env.EXIT_CODE,
    failing: process.env.FAILING,
    failOn: String(inputs["fail-on"] ?? "").trim(),
    url: String(inputs.url ?? "").trim(),
    error: process.env.ERROR,
  });
  if (v.annotation) console.log(v.annotation);
  process.exit(v.exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const commands = { resolve, run, verdict: end };
  const command = commands[process.argv[2]];
  try {
    if (!command) throw new Error(`unknown subcommand "${process.argv[2] ?? ""}": use resolve, run or verdict`);
    command();
  } catch (err) {
    console.log(`::error title=SceneScout check could not run::${escapeAnnotation(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
