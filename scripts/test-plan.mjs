#!/usr/bin/env node
/**
 * Which jobs of .github/workflows/test.yml a run needs, and whether the jobs
 * that ran add up to a passing `test` check. ADR 26 records the decision; this
 * file is its one copy, so ci-test can table-test it without a runner.
 *
 * Plain JavaScript with no dependencies: the workflow runs it before `npm ci`.
 *
 *   node scripts/test-plan.mjs plan      decide the run's jobs and write them as step outputs
 *   node scripts/test-plan.mjs verdict   fail unless every job that should have run passed
 *                                        and every job that should not have run was skipped
 *
 * `plan` reads EVENT (the event name), FILES (changed paths, one per line,
 * absent when they could not be listed) and LABELS (the pull request's
 * labels, one per line). `verdict` reads NEEDS (the `needs` context as JSON).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Every cell of the suite's matrix, as a push to main and a dispatched run test it. */
export const FULL_PLATFORMS = [
  // The oldest maintained LTS line (the engines floor, ADR 34) and the default, on the platform CI is cheapest on.
  { os: "ubuntu-latest", node: 22 },
  { os: "ubuntu-latest", node: 24 },
  // Where most contributors actually run it.
  { os: "macos-latest", node: 24 },
  // Path handling, the installer's symlink fallback, and the engine driving a real Chromium on Windows.
  { os: "windows-latest", node: 24 },
];

/** The cells a pull request runs: Linux on the current LTS, and Windows, which catches path bugs the others do not. */
export const PULL_REQUEST_PLATFORMS = FULL_PLATFORMS.filter((p) => p.node === 24 && p.os !== "macos-latest");

/** The label that gives a pull request the full matrix. */
export const FULL_CI_LABEL = "full-ci";

/**
 * Changed paths that give a pull request the full matrix without the label:
 * the code that differs between browser engines, the dependency tree (a
 * Playwright bump changes every browser), and this plan and the workflow it
 * shapes, so a change to either is tested on every cell it decides about.
 */
export const FULL_CI_PATHS = [
  "src/browsers.ts",
  "src/engine/browser.ts",
  "package.json",
  "package-lock.json",
  ".github/workflows/test.yml",
  "scripts/test-plan.mjs",
];

/**
 * Whether a path is prose no browser-suite cell can be affected by. Several
 * unit suites and mcp-check DO read these files (the guide, the README, the
 * changesets, AGENTS.md), so a docs-only pull request still runs all of them
 * in the `docs` job. Markdown anywhere else (the skill, the demo apps'
 * READMEs, golden files, examples) is read as data and counts as code.
 */
export function isDocsPath(file) {
  if (file.startsWith("docs/")) return true;
  if (file.startsWith(".changeset/")) return true;
  return !file.includes("/") && file.endsWith(".md");
}

/**
 * The run's plan. `kind` is "docs" when every changed file of a pull request
 * is prose, "code" otherwise; `full` gives the cross-browser jobs and every
 * platform. Anything other than a pull request is a full run, and so is a
 * pull request whose changed files could not be listed: when in doubt, test.
 *
 * @param {{ event: string, files?: string[], labels?: string[] }} input
 */
export function plan({ event, files, labels = [] }) {
  if (event !== "pull_request") return { kind: "code", full: true, platforms: FULL_PLATFORMS, reason: `a ${event} run tests everything` };
  if (!Array.isArray(files) || files.length === 0)
    return { kind: "code", full: true, platforms: FULL_PLATFORMS, reason: "the changed files could not be listed, so everything runs" };
  if (labels.includes(FULL_CI_LABEL)) return { kind: "code", full: true, platforms: FULL_PLATFORMS, reason: `the ${FULL_CI_LABEL} label is set` };
  const trigger = files.find((f) => FULL_CI_PATHS.includes(f));
  if (trigger) return { kind: "code", full: true, platforms: FULL_PLATFORMS, reason: `${trigger} changed` };
  if (files.every(isDocsPath)) return { kind: "docs", full: false, platforms: PULL_REQUEST_PLATFORMS, reason: "only documentation changed" };
  return { kind: "code", full: false, platforms: PULL_REQUEST_PLATFORMS, reason: "a pull request runs Linux and Windows on Node 24" };
}

/**
 * For each job the `test` check waits on, whether this plan runs it.
 *
 * @param {{ kind: string, full: boolean }} p
 */
export function expectedJobs(p) {
  const code = p.kind === "code";
  return { docs: !code, suite: code, "cross-browser": code && p.full, "check-action": code, "ci-action": code };
}

/**
 * What is wrong with a finished run, given the `needs` context of the `test`
 * job. Empty means the check passes. A job the plan runs must have succeeded;
 * a job it leaves out must have been skipped, so a skip caused by a failure
 * upstream is never read as a pass.
 *
 * @param {Record<string, any>} needs
 * @returns {string[]}
 */
export function verdict(needs) {
  const planned = needs?.plan;
  if (!planned || planned.result !== "success") return [`the plan job did not succeed: ${planned?.result ?? "missing"}`];
  const p = { kind: planned.outputs?.kind, full: planned.outputs?.full === "true" };
  if (p.kind !== "docs" && p.kind !== "code") return [`the plan job wrote no kind: ${JSON.stringify(planned.outputs ?? {})}`];
  const problems = [];
  for (const [job, runs] of Object.entries(expectedJobs(p))) {
    const result = needs[job]?.result ?? "missing";
    if (runs && result !== "success") problems.push(`${job} should have passed: ${result}`);
    if (!runs && result !== "skipped") problems.push(`${job} should have been skipped: ${result}`);
  }
  return problems;
}

const lines = (text) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function main(command) {
  if (command === "plan") {
    const files = process.env.FILES === undefined ? undefined : lines(process.env.FILES);
    const p = plan({ event: process.env.EVENT ?? "", files, labels: lines(process.env.LABELS) });
    console.log(`plan: ${p.kind}, ${p.full ? "full matrix" : "pull request matrix"} (${p.reason})`);
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error("GITHUB_OUTPUT is not set");
    fs.appendFileSync(out, `kind=${p.kind}\nfull=${p.full}\nplatforms=${JSON.stringify(p.platforms)}\n`);
    return 0;
  }
  if (command === "verdict") {
    const needs = JSON.parse(process.env.NEEDS ?? "{}");
    for (const [job, n] of Object.entries(needs)) console.log(`${job}: ${n.result}`);
    const problems = verdict(needs);
    for (const problem of problems) console.error(problem);
    return problems.length ? 1 : 0;
  }
  console.error("usage: node scripts/test-plan.mjs plan|verdict");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exitCode = main(process.argv[2]);
