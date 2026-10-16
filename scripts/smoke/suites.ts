/**
 * Every browser suite, and its split into three shards so CI can run them on three jobs at once (`--shard k/3`). Run
 * unsharded, they run in this order. The shards are balanced on the suites' measured times on the CI runners
 * (timings.json; balanceShards in shards.ts), counting the time the second shard's job also spends on the unit suites
 * and mcp-check, and the suites that share state stay in one shard, in order: "cross-run memory, safe-write, uploads"
 * reads what "read-only exploration" recorded. The runner checks the split before it runs anything (shardProblems).
 */
import * as readOnly from "./read-only.ts";
import * as safeWrite from "./safe-write.ts";
import * as multiSession from "./multi-session.ts";
import * as authLoss from "./auth-loss.ts";
import * as loginProfiles from "./login-profiles.ts";
import * as scriptedLogin from "./scripted-login.ts";
import * as passwordlessLogin from "./passwordless-login.ts";
import * as ssoLogin from "./sso-login.ts";
import * as reattach from "./reattach.ts";
import * as refreshBroker from "./refresh-broker.ts";
import * as refreshCookie from "./refresh-cookie.ts";
import * as liveView from "./live-view.ts";
import * as contradiction from "./contradiction.ts";
import * as geometry from "./geometry.ts";
import * as attribution from "./attribution.ts";
import * as frames from "./frames.ts";
import * as injection from "./injection.ts";
import * as postmessage from "./postmessage.ts";
import * as checkGate from "./check.ts";
import * as baselines from "./baselines.ts";
import * as firstRun from "./first-run.ts";
import * as unload from "./unload.ts";
import * as ciRun from "./ci.ts";
import * as timeLimits from "./time-limits.ts";
import * as snapshotContents from "./snapshot.ts";
import * as refsAndDiffs from "./refs.ts";
import * as targets from "./targets.ts";
import * as fromRunPath from "./from-run-path.ts";
import * as settleAfterLeaving from "./settle.ts";
import * as actionResults from "./action-results.ts";
import * as maskedTyping from "./masked-typing.ts";
import * as maskedPictures from "./masked-pictures.ts";
import type { SmokeContext } from "./harness.ts";
import { balanceShards, TOGETHER } from "./shards.ts";
import { readTimings } from "./timings.ts";

/** What the runner needs of a suite's module: its title, and the run it awaits. */
export interface SmokeSuite {
  title: string;
  run(ctx: SmokeContext): Promise<void>;
}

/** The number of shards CI runs; `--shard k/n` with any other n is refused. */
export const SHARD_COUNT = 3;

export const suites: SmokeSuite[] = [
  readOnly,
  safeWrite,
  multiSession,
  authLoss,
  loginProfiles,
  scriptedLogin,
  passwordlessLogin,
  ssoLogin,
  reattach,
  refreshBroker,
  refreshCookie,
  liveView,
  injection,
  postmessage,
  contradiction,
  geometry,
  attribution,
  frames,
  snapshotContents,
  refsAndDiffs,
  targets,
  fromRunPath,
  settleAfterLeaving,
  actionResults,
  maskedTyping,
  maskedPictures,
  unload,
  timeLimits,
  firstRun,
  ciRun,
  checkGate,
  baselines,
];

export const timings = readTimings();

export const shards: SmokeSuite[][] = balanceShards(suites, SHARD_COUNT, timings.suites, { together: TOGETHER, extra: timings.jobExtra });
