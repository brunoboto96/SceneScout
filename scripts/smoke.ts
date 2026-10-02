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
import { descendants, extraHandles, type Leftover } from "./smoke/leaks.ts";
import * as readOnly from "./smoke/read-only.ts";
import * as safeWrite from "./smoke/safe-write.ts";
import * as multiSession from "./smoke/multi-session.ts";
import * as authLoss from "./smoke/auth-loss.ts";
import * as loginProfiles from "./smoke/login-profiles.ts";
import * as scriptedLogin from "./smoke/scripted-login.ts";
import * as reattach from "./smoke/reattach.ts";
import * as refreshBroker from "./smoke/refresh-broker.ts";
import * as liveView from "./smoke/live-view.ts";
import * as contradiction from "./smoke/contradiction.ts";
import * as frames from "./smoke/frames.ts";
import * as injection from "./smoke/injection.ts";
import * as postmessage from "./smoke/postmessage.ts";
import * as checkGate from "./smoke/check.ts";
import * as unload from "./smoke/unload.ts";
import * as ciRun from "./smoke/ci.ts";
import * as timeLimits from "./smoke/time-limits.ts";

const suites = [
  readOnly,
  safeWrite,
  multiSession,
  authLoss,
  loginProfiles,
  scriptedLogin,
  reattach,
  refreshBroker,
  liveView,
  injection,
  postmessage,
  contradiction,
  frames,
  unload,
  timeLimits,
  checkGate,
  ciRun,
];

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

async function main(): Promise<void> {
  // What is open before anything runs (stdio), so what is open at the end can be compared with it.
  const baseline = process.getActiveResourcesInfo();
  if (process.platform === "win32") console.log("(leftover-process check skipped: no ps on Windows; open handles are still checked)");
  const server = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-smoke-"));
  const ctx: SmokeContext = { baseUrl: server.baseUrl, foreignBaseUrl: server.foreignBaseUrl, projectDir, stats: server.stats };
  // `npm run smoke:run -- auth` runs only the suites whose title matches.
  const only = process.argv[2]?.toLowerCase();
  let ran = 0;
  try {
    for (const suite of suites) {
      if (only && !suite.title.toLowerCase().includes(only)) continue;
      ran += 1;
      console.log(`\n━━ ${suite.title} ━━`);
      try {
        await suite.run(ctx);
      } catch (err) {
        recordCrash(suite.title, err);
      }
      await checkNothingLeft(suite.title);
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
    console.error(`\nNo suite matched "${only}". Suites: ${suites.map((s) => s.title).join(" | ")}`);
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
