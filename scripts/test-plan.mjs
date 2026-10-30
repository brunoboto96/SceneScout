#!/usr/bin/env node
/**
 * Which jobs of .github/workflows/test.yml a run needs, and whether the jobs
 * that ran add up to a passing `test` check. ADR 33 records the decision; this
 * file is its one copy, so ci-test can table-test it without a runner.
 *
 * Plain JavaScript with no dependencies: the workflow runs it before `npm ci`.
 *
 *   node scripts/test-plan.mjs plan      decide the run's jobs and write them as step outputs
 *   node scripts/test-plan.mjs verdict   fail unless every job that should have run passed
 *                                        and every job that should not have run was skipped
 *
 * `plan` reads EVENT (the event name) and FILES (changed paths, one per line,
 * absent when they could not be listed). `verdict` reads NEEDS (the `needs` context as JSON).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Every cell of the suite's matrix, as a push to main and a dispatched run test it. */
export const FULL_PLATFORMS = [
  // The supported floor and the current LTS, on the platform CI is cheapest on.
  { os: "ubuntu-latest", node: 20 },
  { os: "ubuntu-latest", node: 24 },
  // Where most contributors actually run it.
  { os: "macos-latest", node: 24 },
  // Path handling, the installer's symlink fallback, and the engine driving a real Chromium on Windows.
  { os: "windows-latest", node: 24 },
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
 * is prose, "code" otherwise. A code run, from any event, tests every cell of
 * the matrix. A pull request whose changed files could not be listed is a code
 * run: when in doubt, test.
 *
 * @param {{ event: string, files?: string[] }} input
 */
export function plan({ event, files }) {
  if (event !== "pull_request") return { kind: "code", platforms: FULL_PLATFORMS, reason: `a ${event} run tests everything` };
  if (!Array.isArray(files) || files.length === 0)
    return { kind: "code", platforms: FULL_PLATFORMS, reason: "the changed files could not be listed, so everything runs" };
  if (files.every(isDocsPath)) return { kind: "docs", platforms: FULL_PLATFORMS, reason: "only documentation changed" };
  return { kind: "code", platforms: FULL_PLATFORMS, reason: "a pull request that changes code runs every cell, as main does" };
}

/**
 * For each job the `test` check waits on, whether this plan runs it.
 *
 * @param {{ kind: string }} p
 */
export function expectedJobs(p) {
  const code = p.kind === "code";
  return { docs: !code, suite: code, "cross-browser": code, "check-action": code, "ci-action": code };
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
  const p = { kind: planned.outputs?.kind };
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
    const p = plan({ event: process.env.EVENT ?? "", files });
    console.log(`plan: ${p.kind} (${p.reason})`);
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error("GITHUB_OUTPUT is not set");
    fs.appendFileSync(out, `kind=${p.kind}\nplatforms=${JSON.stringify(p.platforms)}\n`);
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
