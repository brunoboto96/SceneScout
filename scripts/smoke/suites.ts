/**
 * Every browser suite, in three shards, so CI can run them on three jobs at once (`--shard k/3`). Run unsharded, they
 * run in this order. Each shard is balanced from the suites' measured times on the CI runners (the minutes beside it),
 * and the suites that share state stay in one shard, in order: "cross-run memory, safe-write, uploads" reads what
 * "read-only exploration" recorded. The second shard is the lightest because its CI job also runs the unit suites and
 * mcp-check. The runner checks the split before it runs anything (shardProblems in shards.ts).
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

export const shards = [
  // ~8 minutes
  [readOnly, safeWrite, multiSession, authLoss, loginProfiles, scriptedLogin, passwordlessLogin, ssoLogin, reattach, refreshBroker, refreshCookie, liveView],
  // ~6 minutes
  [
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
    unload,
    timeLimits,
    firstRun,
    ciRun,
  ],
  // ~8 minutes: the deterministic check alone takes about seven
  [checkGate, baselines],
];
