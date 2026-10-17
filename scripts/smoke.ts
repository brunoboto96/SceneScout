/**
 * End-to-end smoke test for the engine (no LLM, no MCP wire): serves the test
 * app, drives BrowserEngine directly, and asserts oracles, the write policy,
 * memory, findings and report generation all work.
 *
 * It runs as independent suites under scripts/smoke/. A suite that throws is
 * recorded as a failure and the NEXT suite still runs — one stale element ref
 * used to end the whole run and hide every check after it.
 *
 * The suites are isolated from each other's CRASHES, not from each other's
 * state: they share a project directory and run in order, because cross-run
 * memory is one of the things under test. "cross-run memory, safe-write,
 * uploads" expects the coverage "read-only exploration" recorded, so running
 * it alone fails that one check by design.
 *
 * After each suite, a process still running under this one (a browser never
 * closed, a CLI never waited for) fails that suite and is ended; after the
 * last, anything still open that would keep node running fails the run. A
 * browser left open used to pass every check and then hold `npm test` open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check, eventually, failureCount, recordCrash, startFixtureServer, type SmokeContext } from "./smoke/harness.ts";
import { descendants, extraHandles, socketsLeft, type Leftover } from "./smoke/leaks.ts";
import { readMachineSockets } from "../src/engine/tcp-table.ts";
import { declaredTitle, parseShard, pickShard, shardProblems, shardSeconds, TOGETHER, withoutShard } from "./smoke/shards.ts";
import { shards, suites as allSuites, timings } from "./smoke/suites.ts";

/** Processes still running under this one. `ps` is POSIX; on Windows the check is skipped and says so. */
function leftovers(): Leftover[] {
  return descendants(execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 }), process.pid);
}

/**
 * Fail a suite that leaves a process running (a browser it never closed, a CLI
 * it never waited for), then end what it left so the next suite starts clean
 * and node can still exit. Every pid here is this process's own descendant.
 */
async function checkNothingLeft(suite: string): Promise<void> {
  if (process.platform === "win32") return;
  let left: Leftover[] = [];
  // A browser that does not close gracefully is killed by Playwright 30s after its close began, which can be after the
  // engine's own bounded close has returned. Only a process still running past that is left behind; the wait ends as
  // soon as nothing is, so a suite that closes cleanly does not pay for it.
  await eventually(() => (left = leftovers()).length === 0, 40_000);
  check(`${suite}: leaves no process running`, left.length === 0, left.map((p) => `${p.pid} ${p.command.slice(0, 160)}`).join("\n    "));
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch (err) {
      console.error(`    could not end ${p.pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Windows' range of ports for outgoing connections: each connection takes one, held through TIME_WAIT by the side that closes first. */
function windowsPortRange(): string {
  try {
    const out = execFileSync("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], { encoding: "utf8", timeout: 10_000 });
    const start = /Start Port\s*:\s*(\d+)/.exec(out)?.[1];
    const count = /Number of Ports\s*:\s*(\d+)/.exec(out)?.[1];
    return start && count ? `ports for outgoing connections: ${count} from ${start}` : out.trim().replace(/\s+/g, " ");
  } catch (err) {
    return `(could not read the port range: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }
}

/**
 * Fail a suite that leaves a TCP socket of this process open: a stand-in
 * server it never closed, or a connection to one still open, unref'd or not.
 * The wait matches the process check's, because on Windows that check does
 * not run and a browser Playwright is still closing holds its connections to
 * the fixture server until it goes. Returns the baseline the next suite is held
 * to: what is open now after a failure, so one leak fails one suite. Then log
 * the machine's TCP table, so a run that hits ERR_NO_BUFFER_SPACE shows what
 * was open.
 */
async function checkSockets(suite: string, baseline: string[]): Promise<string[]> {
  let left: string[] = [];
  await eventually(() => (left = socketsLeft(baseline, process.getActiveResourcesInfo())).length === 0, 40_000);
  check(`${suite}: leaves no socket of its own open`, left.length === 0, `open: ${left.join(", ")}`);
  console.log(`  (sockets after this suite: ${await readMachineSockets()})`);
  return left.length === 0 ? baseline : process.getActiveResourcesInfo();
}

/**
 * The engine's action limit for this run, when the environment does not set one. The default (5 s) is the right
 * answer for a person's run, and a loaded test machine overran it on a plain click. A step a suite means to time out
 * passes its own lower limit, so raising the default only stops load from posing as a failure.
 */
const SMOKE_ACTION_TIMEOUT_MS = "15000";

async function main(): Promise<void> {
  // `npm run smoke:run -- auth` runs only the suites whose title matches; `-- --shard 2/3` runs one shard of them.
  const args = process.argv.slice(2);
  // The split itself, before anything runs: every suite file in one shard, and the suites that share state together.
  const smokeDir = path.join(import.meta.dirname, "smoke");
  const files = fs
    .readdirSync(smokeDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => declaredTitle(fs.readFileSync(path.join(smokeDir, f), "utf8")))
    .filter((t): t is string => t !== undefined);
  const problems = shardProblems(shards, files, TOGETHER);
  if (problems.length > 0) throw new Error(`The shards in scripts/smoke/suites.ts are not right:\n  ${problems.join("\n  ")}`);
  const shard = parseShard(args);
  // Unsharded, the suites run in the order suites.ts lists them; a shard runs its own, in that same order.
  const suites = shard ? pickShard(shards, shard) : allSuites;
  if (shard) {
    const minutes = (shardSeconds(suites, timings.suites) / 60).toFixed(1);
    console.log(`Shard ${shard.index}/${shard.count}: ${suites.length} suites, about ${minutes} min on the CI runner they were measured on`);
  }
  const only = withoutShard(args)[0]?.toLowerCase();
  process.env.SCENESCOUT_ACTION_TIMEOUT_MS ??= SMOKE_ACTION_TIMEOUT_MS;
  // What is open before anything runs (stdio), so what is open at the end can be compared with it.
  const baseline = process.getActiveResourcesInfo();
  if (process.platform === "win32") console.log("(leftover-process check skipped: no ps on Windows; open handles are still checked)");
  const server = await startFixtureServer();
  // The shared fixture server's listening sockets are open for the whole run; each suite is held to what is open now.
  let socketBaseline = process.getActiveResourcesInfo();
  if (process.platform === "win32") console.log(`(${windowsPortRange()})`);
  console.log(`(sockets before the first suite: ${await readMachineSockets()})`);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-smoke-"));
  const ctx: SmokeContext = { baseUrl: server.baseUrl, foreignBaseUrl: server.foreignBaseUrl, projectDir, stats: server.stats };
  let ran = 0;
  try {
    for (const suite of suites) {
      if (only && !suite.title.toLowerCase().includes(only)) continue;
      ran += 1;
      console.log(`\n━━ ${suite.title} ━━`);
      try {
        await suite.run(ctx);
      } catch (err) {
        // The table as soon as the suite has given up, before the checks below wait on anything.
        if (/ERR_NO_BUFFER_SPACE/.test(err instanceof Error ? err.message : String(err)))
          console.log(`  (sockets when the page failed to load: ${await readMachineSockets()})`);
        recordCrash(suite.title, err);
      }
      await checkNothingLeft(suite.title);
      socketBaseline = await checkSockets(suite.title, socketBaseline);
    }
  } finally {
    await server.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  // Anything still open would keep node running after the last line of output, and `npm test` with it.
  let extra: string[] = [];
  await eventually(() => (extra = extraHandles(baseline, process.getActiveResourcesInfo())).length === 0);
  check("nothing is left open that would keep node running", extra.length === 0, `open: ${extra.join(", ")}`);
  if (ran === 0) {
    // A filter that matches nothing must not read as a pass.
    console.error(`\nNo suite matched "${only}". Suites: ${allSuites.map((s) => s.title).join(" | ")}`);
    process.exit(1);
  }
  if (failureCount() > 0) {
    console.error(`\nSMOKE FAILED: ${failureCount()} check(s) failed`);
    process.exit(1);
  }
  console.log("\nSMOKE PASSED");
}

main().catch((err) => {
  console.error("SMOKE CRASHED:", err);
  process.exit(1);
});
