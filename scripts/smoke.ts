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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failureCount, recordCrash, startFixtureServer, type SmokeContext } from "./smoke/harness.ts";
import * as readOnly from "./smoke/read-only.ts";
import * as safeWrite from "./smoke/safe-write.ts";
import * as multiSession from "./smoke/multi-session.ts";
import * as authLoss from "./smoke/auth-loss.ts";
import * as liveView from "./smoke/live-view.ts";
import * as contradiction from "./smoke/contradiction.ts";
import * as injection from "./smoke/injection.ts";

const suites = [readOnly, safeWrite, multiSession, authLoss, liveView, injection, contradiction];

async function main(): Promise<void> {
  const server = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-smoke-"));
  const ctx: SmokeContext = { baseUrl: server.baseUrl, projectDir, stats: server.stats };
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
    }
  } finally {
    server.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
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
