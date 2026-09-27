#!/usr/bin/env node
/**
 * The logic behind the GitHub Action in ci/action.yml, which runs
 * `scenescout ci` in a workflow: an exploratory run driven by a model's API
 * that reports and never gates. Kept here rather than in the YAML for the same
 * reasons as check-action.mjs, whose helpers it shares, and table-tested by
 * ci-test.
 *
 *   node ci-action.mjs resolve   work out what to install and where results go
 *   node ci-action.mjs run       run it and publish its numbers as outputs
 *   node ci-action.mjs verdict   end the step: 0 when the run ran, 2 when it could not
 *
 * Inputs come from INPUTS (the `inputs` context as JSON). The API key is never
 * an input: the workflow sets ANTHROPIC_API_KEY or OPENAI_API_KEY in the
 * step's `env`, from a secret, and the CLI reads it from there.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browsersPath, engineOf, escapeAnnotation, inputsFromEnv, installPackage, installTarget, setOutputs } from "./check-action.mjs";

/** Inputs that configure the action rather than the run. Every other input is a `scenescout ci` option of the same name (ci-test holds the lists equal). */
export const CI_ACTION_ONLY_INPUTS = [
  "url",
  "working-directory",
  "version",
  "cli",
  "node-version",
  "install-deps",
  "upload-sarif",
  "upload-artifact",
  "artifact-name",
  "cache",
];

/** The arguments for `scenescout ci`, from the action's inputs. */
export function ciArgs(inputs) {
  const url = String(inputs.url ?? "").trim();
  if (!url) throw new Error("the url input is required: the address of the running app to explore");
  const args = ["ci", url];
  for (const [name, raw] of Object.entries(inputs)) {
    if (CI_ACTION_ONLY_INPUTS.includes(name)) continue;
    const value = String(raw ?? "").trim();
    if (value) args.push(`--${name}=${value}`);
  }
  return args;
}

/** Where the run writes, resolved the way the CLI resolves it: --out, else <project>/.scenescout/ci. */
export function ciOutDirFor(inputs, cwd) {
  const out = String(inputs.out ?? "").trim();
  if (out) return path.resolve(cwd, out);
  return path.resolve(cwd, String(inputs.project ?? "").trim() || ".", ".scenescout", "ci");
}

/** Whether a CLI's --help lists `ci`: releases before it have no such command. */
export function hasCiCommand(helpText) {
  return /scenescout ci <url>/.test(helpText);
}

export const CI_SUMMARY_OUTPUT_NAMES = ["stop", "high", "medium", "low", "worth-a-look", "turns", "tokens", "estimated-cost"];

/** The numbers the action publishes, read from ci.json. Null when there is none. */
export function ciSummaryOutputs(json) {
  if (!json || typeof json !== "object" || !json.stop || !json.counts || !json.usage) return null;
  return {
    stop: String(json.stop.reason ?? ""),
    high: String(json.counts.high ?? 0),
    medium: String(json.counts.medium ?? 0),
    low: String(json.counts.low ?? 0),
    "worth-a-look": String(json.counts.worthALook ?? 0),
    turns: String(json.usage.turns ?? 0),
    tokens: String((json.usage.inputTokens ?? 0) + (json.usage.outputTokens ?? 0)),
    "estimated-cost": json.usage.estimatedCostUsd === null || json.usage.estimatedCostUsd === undefined ? "" : String(json.usage.estimatedCostUsd),
  };
}

export function defaultCiArtifactName(job, use) {
  const base = `scenescout-ci${job ? `-${String(job).replace(/[^\w.-]/g, "_")}` : ""}`;
  return use > 1 ? `${base}-${use}` : base;
}

/**
 * How the step ends. Findings never fail it: exit 0 is a run that ran, whatever
 * it found. Anything else means the run could not run, and says so.
 */
export function ciVerdict({ exitCode, url, error }) {
  const code = Number(exitCode);
  if (code === 0) return { exit: 0, annotation: null };
  const why = String(error ?? "").trim() || (Number.isNaN(code) ? "the run did not start" : `it exited with code ${code}`);
  return {
    exit: 2,
    annotation: `::error title=SceneScout CI run could not run::${escapeAnnotation(`No report for ${url}: ${why}. This is a setup problem, not a result about the app.`)}`,
  };
}

function nextUse() {
  const counter = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "scenescout-ci-uses");
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
  ciArgs(inputs); // fail on a missing url before downloading anything
  const engine = engineOf(inputs);
  const cwd = process.cwd();
  let cli;
  const local = String(inputs.cli ?? "").trim();
  if (local) {
    cli = path.resolve(cwd, local);
    if (!fs.existsSync(cli)) throw new Error(`the cli input names ${cli}, which does not exist; build it first`);
  } else {
    // This action lives in ci/ of the repository; the package it was released as is one up.
    const actionPath = process.env.GITHUB_ACTION_PATH || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "ci");
    const version = String(inputs.version ?? "").trim() || JSON.parse(fs.readFileSync(path.join(actionPath, "..", "package.json"), "utf8")).version;
    cli = installPackage(version);
  }
  const packageRoot = path.dirname(path.dirname(cli));
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  if (!hasCiCommand(`${help.stdout ?? ""}${help.stderr ?? ""}`)) {
    throw new Error(`scenescout ${version} has no ci command, so this action cannot run it. Use the action at a release tag, or set the version input.`);
  }
  const require = createRequire(path.join(packageRoot, "package.json"));
  const playwrightPkg = require.resolve("playwright/package.json");
  setOutputs({
    cli,
    version,
    "artifact-name": String(inputs["artifact-name"] ?? "").trim() || defaultCiArtifactName(process.env.GITHUB_JOB, nextUse()),
    engine,
    "install-target": installTarget(engine),
    "playwright-version": JSON.parse(fs.readFileSync(playwrightPkg, "utf8")).version,
    "playwright-cli": path.join(path.dirname(playwrightPkg), "cli.js"),
    "browsers-path": browsersPath(process.env, process.platform, os.homedir()),
    "out-dir": ciOutDirFor(inputs, cwd),
  });
}

const FILES = ["report.md", "report.html", "summary.md", "ci.json", "ci.sarif"];

function run() {
  const inputs = inputsFromEnv();
  const cli = process.env.SCENESCOUT_CLI;
  const outDir = process.env.SCENESCOUT_OUT_DIR;
  if (!cli || !outDir) throw new Error("SCENESCOUT_CLI and SCENESCOUT_OUT_DIR must be set by the resolve step");
  for (const f of FILES) fs.rmSync(path.join(outDir, f), { force: true });
  // The CLI appends summary.md to the job summary itself; the key reaches it through this process's environment.
  const child = spawnSync(process.execPath, [cli, ...ciArgs(inputs)], { stdio: ["ignore", "inherit", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const stderr = child.stderr ? child.stderr.toString() : "";
  if (stderr) process.stderr.write(stderr);
  const exitCode = child.status ?? (child.error ? "error" : `signal ${child.signal}`);
  const error =
    stderr
      .split(/\r?\n/)
      .filter((l) => l.startsWith("scenescout ci:"))
      .pop()
      ?.replace(/^scenescout ci:\s*(could not run:\s*)?/, "") ?? (child.error ? child.error.message : "");
  const file = (name) => (fs.existsSync(path.join(outDir, name)) ? path.join(outDir, name) : "");
  const summary = file("ci.json") ? ciSummaryOutputs(JSON.parse(fs.readFileSync(file("ci.json"), "utf8"))) : null;
  setOutputs({
    "exit-code": exitCode,
    error,
    report: file("report.md"),
    summary: file("summary.md"),
    json: file("ci.json"),
    sarif: file("ci.sarif"),
    ...(summary ?? Object.fromEntries(CI_SUMMARY_OUTPUT_NAMES.map((name) => [name, ""]))),
  });
}

function end() {
  const inputs = inputsFromEnv();
  const v = ciVerdict({
    exitCode: process.env.EXIT_CODE === "" || process.env.EXIT_CODE === undefined ? NaN : process.env.EXIT_CODE,
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
    console.log(`::error title=SceneScout CI run could not run::${escapeAnnotation(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
