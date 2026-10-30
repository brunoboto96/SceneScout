/**
 * Recurring CI failures, kept visible. A failing check is never dismissed as
 * flaky without a cause; what a person needs first is the record that shows a
 * check keeps coming back. This reads the jobs of recent runs of test.yml (their
 * conclusions and, for the jobs that did not pass, their logs) into one stable
 * record per failing or stalled check, and lists the checks that failed in more
 * than one run with the platforms, browsers, shards and commits they failed on.
 * The runs themselves are the history, so nothing is stored. All pure; the
 * command that fetches the runs is scripts/flaky/ci-flakes.ts, and ci-test
 * table-tests this.
 */

/** One job of a run, as the Actions API reports it (a run's earlier attempts included). */
export interface JobInput {
  /** The job's own id, which its log is fetched by. */
  id?: number;
  runId: number;
  attempt: number;
  /** The commit the run tested. */
  commit: string;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The first step that did not pass, when the API names one. */
  failedStep?: string;
}

/** What a failing job's log says. */
export interface ParsedLog {
  /** Checks that printed a failure, as `{suite, check}`; a crashed suite is `check: "crashed"`. */
  failures: { suite: string; check: string }[];
  /** The last suite whose header printed, and the last check line after it: where a stalled job stopped. */
  lastSuite?: string;
  lastCheck?: string;
}

export type RecordKind = "check" | "crashed" | "stalled" | "step";

export interface FlakeRecord {
  runId: number;
  attempt: number;
  commit: string;
  /** The job's name as the Actions UI shows it. */
  job: string;
  os: string;
  node?: string;
  browser?: string;
  shard?: string;
  kind: RecordKind;
  /** The smoke suite (or "unit suites", or the failed step's name for a record with no log to read). */
  suite: string;
  /** The check's name; for a stall, the last check that passed before it. */
  check: string;
  seconds: number | null;
  /** A later attempt of the same run passed this job. */
  rerunPassed: boolean;
}

/** The required check that fails whenever any job does; its failure adds nothing to the jobs' own records. */
export const AGGREGATE_JOB = "test";

/** A job that ran this long (minutes) before ending without a verdict hit the job's own limit. */
export const JOB_LIMIT_MINUTES = 35;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
// ANSI colour codes in a log line.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** A log line without the runner's timestamp and colour codes. */
export function plainLine(line: string): string {
  return line.replace(/^﻿/, "").replace(TIMESTAMP, "").replace(ANSI, "").replace(/\r$/, "");
}

/** Ports, temp folders and timings that differ per run, removed so one check keeps one name. */
export function normalizeCheck(name: string): string {
  return name
    .replace(/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, "$host")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "$time")
    .replace(/\s+/g, " ")
    .trim();
}

/** The suites and checks a smoke or unit log reports as failed, and where it stopped. */
export function parseJobLog(text: string): ParsedLog {
  const failures: { suite: string; check: string }[] = [];
  const seen = new Set<string>();
  let suite = "";
  let lastSuite: string | undefined;
  let lastCheck: string | undefined;
  const add = (s: string, check: string) => {
    const key = `${s}\u0000${check}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({ suite: s, check });
  };
  for (const raw of text.split("\n")) {
    const line = plainLine(raw);
    const header = /^━━ (.+) ━━$/.exec(line);
    if (header) {
      suite = header[1].trim();
      lastSuite = suite;
      lastCheck = undefined;
      continue;
    }
    const mark = /^\s{2}([✓✗]) (.+)$/.exec(line);
    if (mark && suite) {
      const name = mark[2].trim();
      lastCheck = normalizeCheck(name);
      if (mark[1] === "✗") {
        if (name.endsWith(" CRASHED — the rest of this suite did not run")) add(suite, "crashed");
        else add(suite, normalizeCheck(name));
      }
      continue;
    }
    // node:test's spec reporter marks a failed test with ✖ and a duration; Node 20 prints TAP when not on a terminal.
    const failed = /^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/.exec(line);
    if (failed && !suite) {
      const name = normalizeCheck(failed[1]);
      if (!/^failing tests:?$/i.test(name)) add("unit suites", name);
    }
    const notOk = /^\s*not ok \d+ - (.+?)(?: # (TODO|SKIP)\b.*)?$/.exec(line);
    if (notOk && !notOk[2] && !suite) add("unit suites", normalizeCheck(notOk[1].replace(/\\#/g, "#")));
  }
  return { failures, lastSuite, lastCheck };
}

/** `macos-latest · node 24 · shard 3/3` or `ubuntu-latest · webkit · shard 3/3` as its parts. */
export function jobCell(name: string): { os: string; node?: string; browser?: string; shard?: string } {
  const parts = name.split("·").map((p) => p.trim());
  const cell: { os: string; node?: string; browser?: string; shard?: string } = { os: parts[0] ?? name };
  for (const p of parts.slice(1)) {
    const node = /^node (\S+)$/.exec(p);
    const shard = /^shard (\d+\/\d+)$/.exec(p);
    if (node) cell.node = node[1];
    else if (shard) cell.shard = shard[1];
    else if (/^(chromium|firefox|webkit)$/.test(p)) cell.browser = p;
  }
  return cell;
}

function secondsOf(job: JobInput): number | null {
  if (!job.startedAt || !job.completedAt) return null;
  const s = (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
}

/** A job that ended without a verdict after running to its limit: the log stopped, the job did not. */
export function hitJobLimit(job: JobInput): boolean {
  const s = secondsOf(job);
  return s !== null && s >= (JOB_LIMIT_MINUTES - 2) * 60;
}

/** Jobs whose conclusion is a failure, or a cancellation that came from the job's own limit. */
export function isFailure(job: JobInput): boolean {
  if (job.conclusion === "failure" || job.conclusion === "timed_out") return true;
  return job.conclusion === "cancelled" && hitJobLimit(job);
}

/**
 * The records for one failing job. `log` is its log text, or undefined when it
 * could not be fetched: the record then names the failed step instead of a check.
 */
export function recordsOf(job: JobInput, log: string | undefined, all: readonly JobInput[]): FlakeRecord[] {
  if (!isFailure(job) || job.name === AGGREGATE_JOB) return [];
  const base = {
    runId: job.runId,
    attempt: job.attempt,
    commit: job.commit,
    job: job.name,
    ...jobCell(job.name),
    seconds: secondsOf(job),
    rerunPassed: all.some((o) => o.runId === job.runId && o.name === job.name && o.attempt > job.attempt && o.conclusion === "success"),
  };
  const parsed = log === undefined ? undefined : parseJobLog(log);
  const out: FlakeRecord[] = [];
  for (const f of parsed?.failures ?? []) {
    out.push({ ...base, kind: f.check === "crashed" ? "crashed" : "check", suite: f.suite, check: f.check });
  }
  if (out.length > 0) return out;
  if (hitJobLimit(job)) {
    // A job cancelled at its limit often keeps no log; the step it was in is then all there is.
    const suite = parsed?.lastSuite ?? job.failedStep ?? "(no log kept, no step named)";
    return [{ ...base, kind: "stalled", suite, check: parsed?.lastSuite ? (parsed.lastCheck ?? "(before its first check)") : "(no suite started)" }];
  }
  return [{ ...base, kind: "step", suite: job.failedStep ?? "(no step named)", check: "" }];
}

/** The key two records share when they are the same check: platform and commit are what vary. */
export function recordKey(r: FlakeRecord): string {
  if (r.kind === "stalled") return `stalled in ${r.suite}`;
  if (r.kind === "step") return `step ${r.suite}`;
  if (r.kind === "crashed") return `${r.suite} crashed`;
  return `${r.suite} › ${r.check}`;
}

export interface RecurringCheck {
  key: string;
  kind: RecordKind;
  /** Distinct runs it failed in. */
  runs: number;
  /** Distinct runs the window holds. */
  window: number;
  /** Failed-job counts per platform cell, most first. */
  cells: { cell: string; count: number }[];
  commits: string[];
  runIds: number[];
  /** Failures a later attempt of the same run passed. */
  rerunsPassed: number;
  /** For a stall, the last check that passed before it, per distinct value. */
  stoppedAfter: string[];
}

function cellLabel(r: FlakeRecord): string {
  return [r.os, r.node && `node ${r.node}`, r.browser, r.shard && `shard ${r.shard}`].filter(Boolean).join(" · ");
}

/** Every failing check with the runs it failed in, most runs first; the caller filters on `runs`. */
export function groupChecks(records: readonly FlakeRecord[], window: number): RecurringCheck[] {
  const groups = new Map<string, FlakeRecord[]>();
  for (const r of records) groups.set(recordKey(r), [...(groups.get(recordKey(r)) ?? []), r]);
  const out: RecurringCheck[] = [];
  for (const [key, rs] of groups) {
    const cells = new Map<string, number>();
    for (const r of rs) cells.set(cellLabel(r), (cells.get(cellLabel(r)) ?? 0) + 1);
    const runIds = [...new Set(rs.map((r) => r.runId))];
    out.push({
      key,
      kind: rs[0].kind,
      runs: runIds.length,
      window,
      cells: [...cells].map(([cell, count]) => ({ cell, count })).sort((a, b) => b.count - a.count || a.cell.localeCompare(b.cell)),
      commits: [...new Set(rs.map((r) => r.commit.slice(0, 8)))],
      runIds,
      rerunsPassed: rs.filter((r) => r.rerunPassed).length,
      stoppedAfter: rs[0].kind === "stalled" ? [...new Set(rs.map((r) => r.check))] : [],
    });
  }
  return out.sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
}

/** The report: checks that failed in at least `minRuns` runs first, with their history; the rest listed once. */
export function renderReport(records: readonly FlakeRecord[], window: number, minRuns = 2, unreadable = 0): string {
  const groups = groupChecks(records, window);
  const recurring = groups.filter((g) => g.runs >= minRuns);
  const once = groups.filter((g) => g.runs < minRuns);
  const lines = [
    `# Recurring CI failures`,
    "",
    `Window, the last ${window} completed runs. A check is listed as recurring when it failed in ${minRuns} or more of them.`,
    "",
  ];
  if (unreadable > 0) lines.push(`${unreadable} further run(s) were left out because their jobs could not be read.`, "");
  if (recurring.length === 0) lines.push("No check failed in more than one run of this window.", "");
  for (const g of recurring) {
    lines.push(`## ${g.key}`, "", `Failed in ${g.runs} of ${g.window} runs${g.rerunsPassed > 0 ? `; a later attempt passed ${g.rerunsPassed} time(s)` : ""}.`);
    if (g.stoppedAfter.length > 0) lines.push(`Stopped after ${g.stoppedAfter.map((c) => `\`${c}\``).join(", ")}.`);
    lines.push(`Seen on ${g.cells.map((c) => `${c.cell} (${c.count})`).join("; ")}.`, `Commits ${g.commits.join(", ")}; runs ${g.runIds.join(", ")}.`, "");
  }
  if (once.length > 0) {
    lines.push("## Failed once in this window", "");
    for (const g of once) lines.push(`- ${g.key} — ${g.cells[0].cell}, commit ${g.commits[0]}, run ${g.runIds[0]}`);
    lines.push("");
  }
  return lines.join("\n");
}
