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

/** The outputs summaryOutputs sets, each declared in action.yml; all empty when there is no verdict. */
export const SUMMARY_OUTPUT_NAMES = ["passed", "failing", "high", "medium", "low", "could-not-run", "retests-failing", "worth-a-look"];

/** The numbers the action publishes, read from check.json. Null when there is no verdict to read. */
export function summaryOutputs(json) {
  if (!json || typeof json !== "object" || !json.gate || !json.counts) return null;
  return {
    passed: String(json.gate.passed === true),
    failing: String(json.gate.failing ?? 0),
    high: String(json.counts.high ?? 0),
    medium: String(json.counts.medium ?? 0),
    low: String(json.counts.low ?? 0),
    // Flows a refused step kept from running (--on-refused-step report): the rest has a verdict, this part does not.
    "could-not-run": String(json.gate.couldNotRun ?? 0),
    // Of `failing`, how many are re-tested findings (--gate-retests), so the annotation can say what it counts.
    "retests-failing": String(json.gate.retestsFailing ?? 0),
    // Observations that are defects only under a convention of the project: listed, never counted or gated.
    // A check.json written before the tier existed has none.
    "worth-a-look": String(Array.isArray(json.worthALook) ? json.worthALook.length : 0),
  };
}

/**
 * The folder of pictures kept beside the results: those of the visual
 * baselines this run found changed (`--baseline compare`). The check removes
 * the pictures an earlier run left there before it writes its own, and this is
 * empty unless this run's check.json names pictures it wrote, so a folder only
 * an earlier run filled is never kept as this run's.
 */
export function picturesDir(json, outDir, exists = fs.existsSync) {
  const results = json && typeof json === "object" && json.baselines && Array.isArray(json.baselines.results) ? json.baselines.results : [];
  const dir = path.join(outDir, "visual");
  return results.some((r) => r && typeof r === "object" && r.files) && exists(dir) ? dir : "";
}

/** The mark a check writes into its replay page (check-replay.ts REPLAY_GENERATOR); check-test holds the two equal. */
export const REPLAY_GENERATOR_META = '<meta name="generator" content="scenescout-check-replay">';

/** Whether the file is a replay page a check wrote. False for a missing or unreadable file. */
export function writtenReplay(file) {
  try {
    return fs.readFileSync(file, "utf8").includes(REPLAY_GENERATOR_META);
  } catch {
    return false;
  }
}

/**
 * The replay page of a recorded check and the folders of frames and journey
 * videos beside it, or empty: the folders are kept only with a page this run wrote, which the run
 * step removed beforehand, so frames an earlier run left are never kept as
 * this run's.
 */
export function replayOutputs(outDir, exists = fs.existsSync, written = writtenReplay) {
  const page = path.join(outDir, "replay.html");
  if (!exists(page) || !written(page)) return { replay: "", "replay-frames": "", "replay-videos": "" };
  const frames = path.join(outDir, "replay-frames");
  const videos = path.join(outDir, "replay-videos");
  return { replay: page, "replay-frames": exists(frames) ? frames : "", "replay-videos": exists(videos) ? videos : "" };
}

/** The mark a check writes into a template's test report (check-report.ts REPORT_GENERATOR); report-test holds the two equal. */
export const REPORT_GENERATOR_META = '<meta name="generator" content="scenescout-check-report">';

/**
 * The test report a check wrote (--template), by path, or empty: the file
 * check.json records as its `testReport` (a plain file name in the output
 * folder, never replay.html), and only while it carries the mark. Nothing else
 * in the folder is looked at, so a copy renamed or kept under another name is
 * never taken, or removed, as a check's.
 */
export function testReportOf(json, outDir, read = (file) => fs.readFileSync(file, "utf8")) {
  const name = json && typeof json === "object" ? json.testReport : undefined;
  // check-report.ts isReportFileName, held equal by report-test.
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.html$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name) ||
    name.toLowerCase() === "replay.html"
  )
    return "";
  const file = path.join(outDir, name);
  try {
    return read(file).includes(REPORT_GENERATOR_META) ? file : "";
  } catch {
    return "";
  }
}

/** The check.json in the folder, parsed, or null when there is none or it cannot be read. */
function readCheckJson(outDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, "check.json"), "utf8"));
  } catch {
    return null;
  }
}

/** A workflow command's message must not break the line it is written on. */
export function escapeAnnotation(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * How the step ends. Exit 1 is the gate's verdict; 2, or anything else (a
 * crash, a signal), means the check could not run, and says so, so a broken
 * setup is never read as a failing app. A 2 that left a check.json behind
 * with flows that could not run is a partly-run check: it says which flow and
 * step, and what the rest of the check found, rather than "no verdict".
 */
/** What `failing` counts, in words: issues, and re-tested findings when --gate-retests put some in the gate. */
export function failingText(failing, retestsFailing, failOn) {
  const n = Number(failing) || 0;
  const r = Math.min(Number(retestsFailing) || 0, n);
  const at = `at ${failOn || "high"} severity or worse`;
  return r > 0 ? `${n} failing the gate (${n - r} issue(s) ${at}, ${r} re-tested finding(s) still reproducing)` : `${n} issue(s) ${at}`;
}

export function verdict({ exitCode, failing, failOn, url, error, passed, couldNotRun, retestsFailing }) {
  const code = Number(exitCode);
  if (code === 0) return { exit: 0, annotation: null };
  if (code === 1) {
    return {
      exit: 1,
      annotation: `::error title=SceneScout check failed::${escapeAnnotation(
        `${failingText(failing, retestsFailing, failOn)} on ${url}. The report is on the job summary and in report.md.`,
      )}`,
    };
  }
  const why = String(error ?? "").trim() || (Number.isNaN(code) ? "the check did not start" : `it exited with code ${code}`);
  const incomplete = Number(couldNotRun) || 0;
  if (code === 2 && incomplete > 0 && (passed === "true" || passed === "false")) {
    const rest = passed === "true" ? "The rest of the check passed" : `The rest of the check failed: ${failingText(failing, retestsFailing, failOn)}`;
    return {
      exit: 2,
      annotation: `::error title=SceneScout check could not run ${incomplete} flow(s)::${escapeAnnotation(
        `On ${url}: ${why.replace(/^could not run a saved flow:\s*/, "")} ${rest}. The report is on the job summary and in report.md.`,
      )}`,
    };
  }
  return {
    exit: 2,
    annotation: `::error title=SceneScout check could not run::${escapeAnnotation(`No verdict for ${url}: ${why}. This is a setup problem, not a result about the app.`)}`,
  };
}

export function inputsFromEnv() {
  try {
    return JSON.parse(process.env.INPUTS || "{}");
  } catch (err) {
    throw new Error(`INPUTS is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function setOutputs(values) {
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

/** The root package of the pinned install: it depends on one exact scenescout and nothing else. */
const PINNED_ROOT = "scenescout-action";

/** Why the repository's lockfile does not describe scenescout `version`, or null when it does. */
export function lockMismatch(repoLock, version) {
  const root = repoLock?.packages?.[""];
  if (!root || typeof repoLock.packages !== "object") return "the action's package-lock.json is not an npm 7+ lockfile";
  if (root.name !== "scenescout") return `the action's package-lock.json is ${root.name ?? "unnamed"}'s, not scenescout's`;
  if (version !== root.version) return `the action's package-lock.json pins the tree of scenescout ${root.version}, not ${version}`;
  return null;
}

/** An npm integrity value: sha512 and base64, nothing else. */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/**
 * The dependency tree a release was built and tested with, as a package.json
 * and lockfile `npm ci` installs exactly. It is read from the repository's own
 * package-lock.json at the action's ref: at a release tag that is the lockfile
 * the release was cut from, kept current by Dependabot and rewritten by the
 * release's version bump. Production entries are kept as they are, integrity
 * included; development tools are left out. The release's own tarball is
 * checked against `integrity`, the registry's hash for that exact version, so
 * it is verified as `npm install scenescout@<version>` would verify it.
 * Returns { reason } when the lockfile does not describe `version`, so the
 * caller can say why it floats.
 */
export function pinnedTree(repoLock, version, integrity) {
  const reason = lockMismatch(repoLock, version);
  if (reason) return { reason };
  if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) {
    throw new Error(`the registry gave no sha512 integrity for scenescout ${version} (got ${JSON.stringify(String(integrity)).slice(0, 80)})`);
  }
  const packages = repoLock.packages;
  const root = packages[""];
  const out = {
    "": { name: PINNED_ROOT, dependencies: { scenescout: version } },
    "node_modules/scenescout": {
      version,
      resolved: `https://registry.npmjs.org/scenescout/-/scenescout-${version}.tgz`,
      integrity,
      ...(root.dependencies ? { dependencies: root.dependencies } : {}),
      ...(root.optionalDependencies ? { optionalDependencies: root.optionalDependencies } : {}),
      ...(root.bin ? { bin: root.bin } : {}),
      ...(root.engines ? { engines: root.engines } : {}),
    },
  };
  for (const [name, entry] of Object.entries(packages)) {
    if (!name || entry.dev) continue;
    if (entry.link) return { reason: `the action's package-lock.json links ${name} to a local folder` };
    out[name] = entry;
  }
  return {
    packageJson: { name: PINNED_ROOT, private: true, dependencies: { scenescout: version } },
    lockfile: { name: PINNED_ROOT, lockfileVersion: 3, requires: true, packages: out },
  };
}

/**
 * npm's arguments. pinned: `npm ci`, which installs the lockfile exactly and
 * fails rather than resolve anything anew. floating: the published package
 * with its dependencies resolved now, as `npm install scenescout` would.
 * --ignore-scripts on both: no dependency's install script runs in the job.
 */
export function npmInstallArgs(kind, prefix, version) {
  if (kind === "pinned") return ["ci", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"];
  return ["install", "--prefix", prefix, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts", `scenescout@${version}`];
}

const sortedEntries = (o) => JSON.stringify(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Whether the installed package asks for exactly the dependencies the lockfile's root did. */
export function sameDependencies(lockRoot, installed) {
  return (
    sortedEntries(lockRoot.dependencies) === sortedEntries(installed.dependencies) &&
    sortedEntries(lockRoot.optionalDependencies) === sortedEntries(installed.optionalDependencies)
  );
}

function defaultIo() {
  const npm = npmCommand(process.platform, process.execPath);
  return {
    exec: (args) => execFileSync(npm.file, [...npm.prefixArgs, ...args], { stdio: "inherit" }),
    // The registry's hash for that exact version, as npm install would check the tarball against.
    integrityOf: (version) =>
      JSON.parse(execFileSync(npm.file, [...npm.prefixArgs, "view", `scenescout@${version}`, "dist.integrity", "--json"], { encoding: "utf8" }) || "null"),
    tmpDir: process.env.RUNNER_TEMP || os.tmpdir(),
    warn: (message) => console.log(`::warning title=SceneScout dependencies not pinned::${escapeAnnotation(message)}`),
  };
}

const PIN_HOW = "Leave the version input empty and use the action at a release tag to install the release's own locked dependency tree.";

/**
 * Install the published package into a directory of its own, so install and
 * check use one copy with one Playwright. The version this action's ref was
 * released as is installed with `npm ci` from the tree pinnedTree reads out of
 * the lockfile in repoRoot, so this job (which may hold a model's key) runs
 * the dependencies that release was tested with, not whatever is newest. Any
 * other version, or a ref whose lockfile has moved on from the release it
 * names, installs as npm would, with a warning that says so.
 */
export function installPackage(version, repoRoot, io = defaultIo()) {
  if (!isVersionSpec(version)) throw new Error(`the version input is not an npm version, range or tag: "${version}"`);
  const dir = (kind) => path.join(io.tmpDir, `scenescout-${kind}-${version.replace(/[^0-9A-Za-z.-]/g, "_")}`);
  const cliIn = (prefix) => path.join(prefix, "node_modules", "scenescout", "dist", "cli.js");
  const floating = (why) => {
    io.warn(`scenescout ${version} is installed with its dependencies resolved now, not pinned: ${why}. ${PIN_HOW}`);
    const prefix = dir("floating");
    fs.mkdirSync(prefix, { recursive: true });
    io.exec(npmInstallArgs("floating", prefix, version));
    return { cli: cliIn(prefix), pinned: false };
  };
  let repoLock;
  try {
    repoLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  } catch (err) {
    return floating(`the action has no readable package-lock.json (${err instanceof Error ? err.message : String(err)})`);
  }
  const mismatch = lockMismatch(repoLock, version);
  if (mismatch) return floating(mismatch);
  const tree = pinnedTree(repoLock, version, io.integrityOf(version));
  if (!tree.lockfile) return floating(tree.reason);
  const prefix = dir("pinned");
  fs.rmSync(prefix, { recursive: true, force: true });
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify(tree.packageJson, null, 2) + "\n");
  fs.writeFileSync(path.join(prefix, "package-lock.json"), JSON.stringify(tree.lockfile, null, 2) + "\n");
  io.exec(npmInstallArgs("pinned", prefix, version));
  const installed = JSON.parse(fs.readFileSync(path.join(prefix, "node_modules", "scenescout", "package.json"), "utf8"));
  if (!sameDependencies(repoLock.packages[""], installed)) {
    return floating(`the published scenescout ${version} declares other dependencies than this ref's package-lock.json, so the ref is not that release`);
  }
  return { cli: cliIn(prefix), pinned: true };
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
    cli = installPackage(version, actionPath).cli;
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
  // The test report an earlier run's check.json says it wrote (--template), while it carries the mark; read before check.json goes.
  const earlierReport = testReportOf(readCheckJson(outDir), outDir);
  if (earlierReport) fs.rmSync(earlierReport);
  // Results of an earlier run in the same directory must not be read as this run's.
  for (const f of ["report.md", "check.json", "check.sarif"]) fs.rmSync(path.join(outDir, f), { force: true });
  // A replay page only when a check wrote it: a file of that name the project keeps there is its own.
  if (writtenReplay(path.join(outDir, "replay.html"))) fs.rmSync(path.join(outDir, "replay.html"));
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
  let pictures = "";
  let testReport = "";
  if (file("check.json")) {
    const json = JSON.parse(fs.readFileSync(file("check.json"), "utf8"));
    summary = summaryOutputs(json);
    pictures = picturesDir(json, outDir);
    testReport = testReportOf(json, outDir);
  }
  setOutputs({
    "exit-code": exitCode,
    error: explained,
    report: file("report.md"),
    json: file("check.json"),
    sarif: file("check.sarif"),
    visual: pictures,
    ...replayOutputs(outDir),
    "test-report": testReport,
    ...(summary ?? Object.fromEntries(SUMMARY_OUTPUT_NAMES.map((name) => [name, ""]))),
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
    passed: process.env.PASSED,
    couldNotRun: process.env.COULD_NOT_RUN,
    retestsFailing: process.env.RETESTS_FAILING,
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
