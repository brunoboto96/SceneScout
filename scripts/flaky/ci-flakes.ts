/**
 * Prints the recurring CI failures of the last runs of test.yml on a branch
 * (scripts/flaky/flakes.ts holds the rules). It reads job conclusions from the
 * Actions API through `gh`, fetches the log of each job that failed, and prints
 * only the check names it parsed, never log text.
 *
 *   npx tsx scripts/flaky/ci-flakes.ts [--runs 30] [--branch main|any] [--event push|pull_request|any] [--min-runs 2] [--workflow test.yml] [--json file]
 *
 * With GITHUB_STEP_SUMMARY set, the report is appended to the job's summary too.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isFailure, recordsOf, renderReport, type FlakeRecord, type JobInput } from "./flakes.ts";

const RUNS_MAX = 100;

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function boundedInt(text: string, name: string, min: number, max: number): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, not "${text}"`);
  return n;
}

/** `gh api`, tried four times with a growing pause: the API answers 502 in bursts, not once. */
function gh(args: string[]): string {
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * 2 ** (attempt - 2) + Math.floor(Math.random() * 1000));
    try {
      return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      last = err;
      // A log that expired or was never kept answers 404 every time.
      if (/HTTP 404/.test(String((err as { stderr?: unknown }).stderr ?? ""))) break;
    }
  }
  throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${last instanceof Error ? last.message.split("\n")[0] : String(last)}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const runsWanted = boundedInt(option(args, "runs", "30"), "runs", 1, RUNS_MAX);
  const minRuns = boundedInt(option(args, "min-runs", "2"), "min-runs", 1, RUNS_MAX);
  const branch = option(args, "branch", "main");
  const workflow = option(args, "workflow", "test.yml");
  const event = option(args, "event", "any");
  if (!/^(push|pull_request|schedule|workflow_dispatch|merge_group|any)$/.test(event))
    throw new Error(`--event must be push, pull_request or any, not "${event}"`);
  const repo = process.env.GITHUB_REPOSITORY || gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  const runs = JSON.parse(
    gh([
      "api",
      `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=${runsWanted}${branch === "any" ? "" : `&branch=${encodeURIComponent(branch)}`}${event === "any" ? "" : `&event=${event}`}`,
    ]),
  ).workflow_runs as { id: number; head_sha: string }[];
  const records: FlakeRecord[] = [];
  let unreadable = 0;
  for (const run of runs) {
    const listed: Record<string, any>[] = [];
    try {
      // Every attempt's jobs are listed, so a run re-tried a few times can pass one page.
      for (let page = 1; page <= 10; page++) {
        const body = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`]));
        listed.push(...body.jobs);
        if (body.jobs.length < 100 || listed.length >= body.total_count) break;
      }
    } catch (err) {
      unreadable += 1;
      console.error(`run ${run.id} left out, its jobs could not be read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const jobs = listed.map((j): JobInput => ({
      id: j.id,
      runId: run.id,
      attempt: j.run_attempt ?? 1,
      commit: run.head_sha,
      name: j.name,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      failedStep: (j.steps as { name: string; conclusion: string | null }[] | undefined)?.find(
        (s) => s.conclusion === "failure" || s.conclusion === "cancelled",
      )?.name,
    }));
    for (const job of jobs.filter(isFailure)) {
      let log: string | undefined;
      try {
        log = job.id ? gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job.id}/logs`]) : undefined;
      } catch (err) {
        // The record then names the failed step instead of a check; say why.
        console.error(`no log for job ${job.id} of run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
        log = undefined;
      }
      records.push(...recordsOf(job, log, jobs));
    }
  }
  const report = renderReport(records, runs.length - unreadable, minRuns, unreadable);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  const jsonPath = option(args, "json", "");
  if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify(records, null, 2)}\n`);
}

main();
