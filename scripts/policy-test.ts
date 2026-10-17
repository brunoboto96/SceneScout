/**
 * Unit tests for the write-policy classifier and the auth-loss state machine.
 *
 * Both are small pure-ish units that shipped with zero direct coverage, and
 * both had real bugs found only by reading: `isDestructiveWire` was being
 * called with its two arguments swapped at one of its two call sites, and the
 * auth-loss notice was lost whenever the surrounding call threw. Neither is
 * expensive to pin once the logic is reachable without a browser.
 *
 *   npx tsx --test --test-name-pattern "swapped" scripts/policy-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { confirmVerdict, GuidedPlans, guidedAttachVerdict, guidedPlan, holdGuidedPlan } from "../src/engine/guided.ts";
import {
  applyToCommand,
  configureCommand,
  fsPolicyReader,
  NO_POLICY,
  parsePolicy,
  PRESET_POLICY,
  projectFolderRefusal,
  readLaunchPolicy,
  uploadRefusal,
  writeRulesSettings,
  refusalText,
  resolveSettings,
  tightenPolicy,
  withProjectPolicy,
  type LoadedPolicy,
  type Policy,
} from "../src/engine/project-config.ts";
import {
  allowsWrite,
  answersWithRefusal,
  AUTH_FLOW_RE,
  destructiveRefusal,
  foreignFrameOrigin,
  foreignWrite,
  withForeignFrameSandbox,
  hostileForEmbed,
  embedOfRequest,
  trustedEmbedOrigins,
  trustsEmbedWrite,
  trustsForeignWrite,
  offAppPageWrite,
  EmbedMoveTracker,
  sandboxedRedirectPage,
  FOREIGN_FRAME_SANDBOX,
  allowsForeignWriteOnSignIn,
  isAuthExempt,
  authPostsSetting,
  AUTH_POSTS_ENV,
  isDestructive,
  isDestructiveWire,
  isDestructiveRequest,
  BlockNotices,
  blockSignature,
  destructiveLabelOf,
  dialogNote,
  dialogResponse,
  ESCAPE_REFUSAL,
  DESTRUCTIVE_GET_REFUSAL,
  pickIsDestructive,
  LABEL_HEAD_WORDS,
  COMMAND_TEXT_WORDS,
  MAX_READ_POSTS,
  graphqlWriteOperation,
  matchReadPost,
  refusedPostPage,
  readPostAllowed,
  readPostEntries,
  readPostsSetting,
  POLICY_REFUSAL_HEADER,
  policyRefusal,
  WRITE_MODES,
  LOOSENED_RULE_HOLD_MS,
  stricterMode,
  WriteRule,
  writeMethod,
  writeMethodLabel,
} from "../src/engine/policy.ts";
import type { WriteMode } from "../src/engine/policy.ts";
import { scriptLiteral } from "../src/engine/script-literal.ts";
import {
  deriveCollection,
  extractCreatedIds,
  isOwnedResource,
  keyMatchesUrl,
  normalizeId,
  type CreationEvidence,
  type OwnedIds,
} from "../src/engine/ownership.ts";
import { AUTH_LOSS_STREAK, AuthLossTracker, LOGIN_ROUTE_RE, shouldReattach } from "../src/engine/authloss.ts";
import {
  bodyDigest,
  headerOf,
  judgeUnseenWrite,
  pausedRequestBody,
  pausedRequestBytes,
  ROUTED_WRITE_TTL_MS,
  RoutedWrites,
  UNSEEN_REFUSAL_TTL_MS,
  UnseenRefusals,
  unseenWriteSource,
} from "../src/engine/unload.ts";
import { LOGIN_ROUTE_RE_STORAGE } from "../src/engine/memory.ts";
import type { Request, Route } from "playwright";
import { marksRouteExercised, pathnameOf, RouteGuard, routedWriteVerdict, type RouteGuardHost } from "../src/engine/route-guard.ts";
import {
  destructiveGet,
  identifierWords,
  mutationRootFields,
  refuseDestructiveGetsSetting,
  strictIsDestructive,
  writeClassifierSetting,
  type WriteClassifier,
} from "../src/engine/strict-writes.ts";
import { fuzzCases, fuzzRates } from "./policy-fuzz.ts";

// ---------------------------------------------------------------------------
// isDestructiveWire — argument order is load-bearing
// ---------------------------------------------------------------------------

test("a destructive intent living only in the POST body is caught", () => {
  // The bug this pins: one call site passed (method, url) instead of
  // (pathname, body). For a POST to a generic endpoint the method never
  // matches, so the check fell through to testing the URL as if it were the
  // body — and the real payload was never inspected at all.
  const body = JSON.stringify({ query: 'mutation { deleteUser(id: "7") { ok } }' });
  assert.equal(isDestructiveWire("/graphql", body), true, "a delete mutation in the body is destructive");
  assert.equal(isDestructiveWire("/graphql", null), false, "the same endpoint with no such body is not");
});

test("swapping the arguments changes the answer — they are not interchangeable", () => {
  const pathname = "/api/widgets/7";
  const body = JSON.stringify({ query: "mutation { archiveWidget(id: 7) }" });
  assert.equal(isDestructiveWire(pathname, body), true, "correct order sees the body");
  // Method-as-url is what the buggy call site did. "POST" matches nothing, and
  // the url-as-body is a benign path, so a genuinely destructive request reads
  // as safe.
  assert.equal(isDestructiveWire("POST", pathname), false, "swapped order misses it entirely");
});

test("a DELETE path is destructive from the path alone", () => {
  assert.equal(isDestructiveWire("/api/users/3/delete", null), true);
  assert.equal(isDestructiveWire("/api/users/bulk-delete", null), true);
  assert.equal(isDestructiveWire("/api/users/3", null), false, "a plain resource path is not");
});

test("the body is only read up to a bound", () => {
  // Guards against a multi-megabyte upload body being regex-scanned in full.
  // Uses a command-key signal (not a bare keyword) since that is what the body
  // scan now looks for.
  const signal = '{"action":"delete"}';
  assert.equal(isDestructiveWire("/api/upload", `${"x".repeat(5000)}${signal}`), false, "past the 2000-char window it is not scanned");
  assert.equal(isDestructiveWire("/api/upload", `${signal}${"x".repeat(5000)}`), true, "within the window it is");
});

test("a destructive word in ordinary CONTENT does not block a create/submit POST", () => {
  // The regression this pins, seen live twice: a document being analysed contained
  // "Remove jewellery" and a description said the record was "Safe to delete";
  // the old body scan matched the bare keyword and refused POST /api/ai/analyze
  // and a plain create. A request body is frequently user content — a keyword
  // in prose is not destructive intent.
  assert.equal(
    isDestructiveWire("/api/ai/analyze", "1. Take off the wrapper. 2. Remove the old draft and archive it."),
    false,
    "prose mentioning remove/archive is not a destructive request",
  );
  assert.equal(
    isDestructiveWire(
      "/api/tickets",
      JSON.stringify({ title: "Old request", description: "The customer asked us to delete their data and purge the archive." }),
    ),
    false,
    "destructive words as ordinary field values are content, not commands",
  );
  assert.equal(
    isDestructiveWire("/api/documents", JSON.stringify({ title: "How to delete a user", action: "create" })),
    false,
    "a create action whose title merely mentions deletion is allowed",
  );
});

test("STRUCTURED destructive intent in a body is still caught", () => {
  // A command-like key with a destructive value is a genuine destructive POST.
  assert.equal(isDestructiveWire("/api/batch", JSON.stringify({ action: "delete", ids: [1, 2, 3] })), true, "action:delete");
  assert.equal(isDestructiveWire("/api/records", JSON.stringify({ operation: "archive", id: 5 })), true, "operation:archive");
  assert.equal(isDestructiveWire("/api/x", JSON.stringify({ _method: "DELETE" })), true, "_method:DELETE (case-insensitive)");
  assert.equal(isDestructiveWire("/api/form", "action=delete&id=3"), true, "form-encoded command field");
  // ...but a command key with a SAFE value, or destructive words under other
  // keys, are not.
  assert.equal(isDestructiveWire("/api/x", JSON.stringify({ action: "create" })), false, "action:create is not destructive");
  assert.equal(isDestructiveWire("/api/notes", JSON.stringify({ note: "delete", tag: "remove" })), false, "non-command keys are content");
  assert.equal(isDestructiveWire("/api/x", JSON.stringify({ prop: "delete" })), false, "'op' inside 'prop' is not a command key");
  // A command key must look STRUCTURAL. Sentence-shaped prose that happens to
  // contain "<word>: delete" is the very false-positive this fix exists to
  // kill, so it must not come back through the command branch.
  assert.equal(
    isDestructiveWire("/api/tickets", JSON.stringify({ description: "Our intent: delete duplicate accounts next quarter." })),
    false,
    "prose with a colon is not a command field",
  );
  assert.equal(
    isDestructiveWire("/api/notes", "The plan of action: delete the old records once approved."),
    false,
    "an unquoted prose phrase is not a command field",
  );
  // ...while the real structural forms still match, including JSON-Patch.
  assert.equal(isDestructiveWire("/api/patch", JSON.stringify([{ op: "remove", path: "/a" }])), true, "JSON-Patch op:remove");
  assert.equal(isDestructiveWire("/api/x?action=delete&id=3", null), true, "query-string command on the URL");
});

// ---------------------------------------------------------------------------
// isDestructive — UI-label matching
// ---------------------------------------------------------------------------

test("destructive labels are caught across the languages the list covers", () => {
  for (const label of ["Delete account", "Remove user", "Eliminar", "Supprimer", "削除", "удалить"]) {
    assert.equal(isDestructive(label), true, `expected destructive: ${label}`);
  }
});

test("ordinary labels are left alone", () => {
  for (const label of ["Save draft", "Publish now", "Add row", "Submit for approval", "Next"]) {
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  }
});

test("a non-destructive 'reset' is not refused", () => {
  // `\breset\b` used to match every one of these. Refusing them in read-only
  // mode cost real coverage — a filter reset destroys nothing, and the engine
  // skipping it means the page's own controls never get exercised.
  for (const label of ["Reset filters", "Reset zoom", "Reset search", "Reset password"]) {
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  }
  // ...while the genuinely destructive sense still is.
  assert.equal(isDestructive("Reset workspace"), true);
  assert.equal(isDestructive("Factory reset"), true);
  assert.equal(isDestructive("Reset all data"), true);
});

test("a description inside a control is not its command", () => {
  // A role card on a sign-in page is one button whose accessible name is the
  // role's name plus a sentence about it. "sign-off" in that sentence refused
  // the click in read-only mode, so the manager role was unreachable and a
  // whole lane came back partial. The verb the click sends is at the head of
  // a label; a paragraph after it is content.
  assert.equal(isDestructive("Manager Approves or rejects orders that need sign-off."), false);
  assert.equal(isDestructive("Operator Runs the nightly jobs and may archive old reports."), false, "a Latin verb deep in the sentence");
  assert.equal(isDestructive("Reviewer\nApproves or rejects\nrequests that can archive old ones."), false, "newlines between the card's spans");
  // ...while a long label that LEADS with the verb is still the command.
  assert.equal(isDestructive("Delete this project and everything in it, permanently"), true);
  assert.equal(isDestructive("Remove all 14 selected users from the workspace now"), true);
  // The boundary, built from the constant so the test moves with it. The
  // trailing sentence is what makes the label prose.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.equal(isDestructive(`${filler(LABEL_HEAD_WORDS - 1)} delete it. Then go home.`), true, "the verb as the head's last word");
  assert.equal(isDestructive(`${filler(LABEL_HEAD_WORDS)} delete it. Then go home.`), false, "the verb just past the head");
  // The pattern sees the whole label: an exemption that looks past the
  // boundary still applies, and a two-word pattern straddling it still matches.
  assert.equal(isDestructive("Use this control to quickly reset filters. Handy."), false, "'filters' is past the head, 'reset' is not");
  assert.equal(isDestructive("Yes I want to really cancel subscription. Now."), true, "'cancel' is in the head");
  // Only prose is judged by its head. A long label with no sentence in it is
  // a command however it is worded, so a confirm button stays refused.
  assert.equal(isDestructive("Yes, I am sure I want to delete this"), true);
  assert.equal(isDestructive("I understand this cannot be undone, delete everything"), true);
  assert.equal(isDestructive("Danger zone This cannot be undone. Permanently delete the repository."), false, "a heading plus a sentence is a description");
});

test("'sign off' is destructive as a verb, not as the noun approval apps use", () => {
  for (const label of [
    "Sign off",
    "Sign-off",
    "Sign off now",
    "(Sign off)",
    "\n  Sign off",
    "Save and sign off now",
    "Approve and sign off",
    "Save & sign off",
    "Review, then sign off",
    "sign-off-button",
  ]) {
    assert.equal(isDestructive(label), true, `expected destructive: ${label}`);
  }
  // The noun is told by position, not by the word before it: any modifier can
  // come first. A label that leads with the noun ("Sign-off required") still
  // matches, and a status chip worded that way pays for it; a chip that is not
  // a control is not judged by its text at all (destructiveLabelOf).
  for (const label of [
    "Needs sign-off",
    "Awaiting sign off",
    "Send for sign-off",
    "2 orders pending sign-off",
    "Requires sign-off from a manager",
    "Manager sign-off",
    "Pending manager sign-off",
    "Final sign-off recorded for order 12",
    "Approved without the required second-reviewer sign-off",
    // "Confirm" is the verb and the sign-off its object: confirming an approval.
    "Confirm sign off",
  ]) {
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  }
});

test("removing a filter chip is not destructive; removing a record is", () => {
  for (const label of [
    "Remove Status: Open filter",
    "Remove filter",
    "Remove all filters",
    "Remove tag filter",
    "Remove Owner: me chip",
    "filter-remove",
    "chip-remove-status",
  ])
    assert.equal(isDestructive(label), false, `expected safe: ${label}`);
  for (const label of [
    "Remove member",
    "Remove",
    "Remove user from team",
    "remove-member",
    "Remove Status: Open",
    "Remove member. Use the filter to find others.",
  ])
    assert.equal(isDestructive(label), true, `expected destructive: ${label}`);
});

test("isDestructive ignores empty and absent labels", () => {
  assert.equal(isDestructive(null, undefined, ""), false);
});

test("auth flows are recognised so they survive a strict write policy", () => {
  for (const p of ["/api/auth/login", "/api/session", "/oauth/token", "/api/auth/refresh"]) {
    assert.equal(AUTH_FLOW_RE.test(p), true, `expected auth flow: ${p}`);
  }
  assert.equal(AUTH_FLOW_RE.test("/api/widgets"), false);
});

test("the refusal message tells the caller how to proceed, not just no", () => {
  const msg = destructiveRefusal("Delete account");
  assert.ok(msg.includes("Delete account"), "names what was refused");
  assert.ok(msg.includes("destructive"), "names the mode that would allow it");
  assert.ok(msg.includes("do not attempt this element again"), "tells the agent not to retry");
});

// ---------------------------------------------------------------------------
// AuthLossTracker
// ---------------------------------------------------------------------------

const BASE = "http://app.test";

test("a bounce to a login page is detected; asking for login is not", () => {
  const t = new AuthLossTracker();
  assert.equal(t.isLoginRedirect("/documents", `${BASE}/login`, BASE), true);
  // The anonymous auth-surface pass walks /login deliberately.
  assert.equal(t.isLoginRedirect("/login", `${BASE}/login`, BASE), false);
  // crawl passes slash-less targets; normalizing inside means they behave the same.
  assert.equal(t.isLoginRedirect("login", `${BASE}/login`, BASE), false);
});

test("an ordinary redirect is not a login bounce", () => {
  const t = new AuthLossTracker();
  assert.equal(t.isLoginRedirect("/old", `${BASE}/new`, BASE), false);
});

test("the verdict needs a streak, and one good navigation clears it", () => {
  const t = new AuthLossTracker();
  const bounce = () => {
    t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
    return t.take();
  };
  for (let i = 1; i < AUTH_LOSS_STREAK; i++) {
    assert.ok(!bounce().includes("SESSION AUTH LOST"), `bounce ${i} is not yet a verdict`);
  }
  assert.ok(bounce().includes("SESSION AUTH LOST"), "the threshold bounce delivers the verdict");

  t.record({ requestedRoute: "/b", landedRoute: "/b", bounced: false, role: "admin" });
  t.take();
  assert.ok(!bounce().includes("SESSION AUTH LOST"), "a successful navigation resets the streak");
});

test("the sign-in counts as lost from the verdict until a navigation lands signed in or a new attach starts", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "admin");
  const bounce = () => t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
  for (let i = 1; i < AUTH_LOSS_STREAK; i++) {
    bounce();
    assert.equal(t.lost, false, `bounce ${i} is not yet a loss`);
  }
  bounce();
  // A role session earns its one re-attach here; until the navigation that decides it, the loss is not final.
  if (t.takeReattach()) {
    assert.equal(t.lost, false, "a re-attach is still to say otherwise");
    bounce();
  }
  assert.equal(t.lost, true, "the verdict: the sign-in is gone");
  t.record({ requestedRoute: "/b", landedRoute: "/b", bounced: false, role: "admin" });
  assert.equal(t.lost, false, "a navigation that lands signed in ends it");
  for (let i = 0; i < AUTH_LOSS_STREAK; i++) bounce();
  assert.equal(t.lost, true);
  t.beginSession("role", "admin");
  assert.equal(t.lost, false, "a new attach ends it");
});

test("a session that was given no sign-in never counts its sign-in as lost, however often it lands on a login page", () => {
  // An anonymous check of a site whose links lead to pages behind a sign-in
  // bounces to the login page on each one. That is the site's access rule,
  // not a sign-in that ran out, so it must not raise the "sign in again" screen.
  for (const kind of ["none", "file"] as const) {
    const t = new AuthLossTracker();
    t.beginSession(kind, "someone");
    for (let i = 0; i < AUTH_LOSS_STREAK + 2; i++) t.record({ requestedRoute: `/p${i}`, landedRoute: "/login", bounced: true, role: "someone" });
    assert.equal(t.lost, kind !== "none", `a ${kind} session ${kind === "none" ? "has no sign-in to lose" : "has lost its sign-in"}`);
  }
});

test("the notice is consumed exactly once", () => {
  // Left set, it prepended a stale "REDIRECTED: asked for X" onto the NEXT,
  // unrelated call — which is what happened whenever navigate() threw before
  // reaching its return.
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
  assert.ok(t.take().includes("REDIRECTED"), "first take gets it");
  assert.equal(t.take(), "", "a second take gets nothing");
});

test("clear() drops an undelivered notice so it cannot leak forward", () => {
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
  t.clear();
  assert.equal(t.take(), "", "the stale notice is gone");
});

test("a redirect that is not a bounce says the route still counts as covered", () => {
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/admin", landedRoute: "/", bounced: false, role: "viewer" });
  const notice = t.take();
  assert.ok(notice.includes("REDIRECTED"), "the divergence is still reported");
  assert.ok(notice.includes("counts as covered for role 'viewer'"), "and is attributed to the role");
  assert.ok(!notice.includes("SESSION AUTH LOST"), "a permission wall is not auth loss");
});

test("the batch verdict survives a sweep whose last route happened to succeed", () => {
  // A crawl records every route in turn, so only the final notice survives to
  // be taken. Token dies, forty routes bounce, the sweep then reaches a public
  // route — the streak resets and the crawl used to report nothing wrong.
  const t = new AuthLossTracker();
  for (let i = 0; i <= AUTH_LOSS_STREAK; i++) {
    t.record({ requestedRoute: "/a", landedRoute: "/login", bounced: true, role: "admin" });
    t.clear();
  }
  t.record({ requestedRoute: "/public", landedRoute: "/public", bounced: false, role: "admin" });
  t.clear();
  assert.ok(t.batchVerdict().includes("SESSION AUTH LOST"), "the sweep still reports the session died");
});

test("a clean sweep produces no batch verdict", () => {
  const t = new AuthLossTracker();
  t.record({ requestedRoute: "/a", landedRoute: "/a", bounced: false, role: "admin" });
  t.clear();
  assert.equal(t.batchVerdict(), "", "nothing went wrong, so nothing is claimed");
});

// ---------------------------------------------------------------------------
// Re-attaching a role session once on SESSION AUTH LOST
// ---------------------------------------------------------------------------

test("only a role session re-attaches, only at the verdict, and only once", () => {
  const cases: Array<[Parameters<typeof shouldReattach>[0], boolean, string]> = [
    [{ streak: AUTH_LOSS_STREAK, signIn: "role", alreadyReattached: false }, true, "a role session at the verdict"],
    [{ streak: AUTH_LOSS_STREAK + 4, signIn: "role", alreadyReattached: false }, true, "past the verdict still counts"],
    [{ streak: AUTH_LOSS_STREAK - 1, signIn: "role", alreadyReattached: false }, false, "a bounce short of the verdict may be a permission wall"],
    [{ streak: AUTH_LOSS_STREAK, signIn: "role", alreadyReattached: true }, false, "the second loss of a session"],
    [{ streak: AUTH_LOSS_STREAK, signIn: "file", alreadyReattached: false }, false, "a storage-state file has no profile to re-read"],
    [{ streak: AUTH_LOSS_STREAK, signIn: "none", alreadyReattached: false }, false, "an anonymous session has no sign-in to restore"],
  ];
  for (const [input, want, why] of cases) assert.equal(shouldReattach(input), want, why);
});

/** Bounce a tracker to the verdict on /a, /b, /c (targets with their real ids), returning the last notice. */
function loseSignIn(t: AuthLossTracker): string {
  let notice = "";
  for (const [route, target] of [
    ["/things/:id", "/things/7"],
    ["/b", "/b"],
    ["/c", "/c?tab=2"],
  ].slice(0, AUTH_LOSS_STREAK)) {
    t.record({ requestedRoute: route, landedRoute: "/login", bounced: true, role: "member", target });
    notice = t.take();
  }
  return notice;
}

test("a role session's loss earns one re-attach back to what it asked for", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  const plan = t.takeReattach();
  assert.deepEqual(plan, { returnTo: "/c?tab=2", retry: [] }, "back to the real target; a navigation revisits nothing else itself");
  assert.equal(t.takeReattach(), null, "the plan is consumed once");

  t.record({ requestedRoute: "/c", landedRoute: "/c", bounced: false, role: "member", target: "/c?tab=2" });
  const notice = t.take();
  assert.ok(notice.includes("SESSION RE-ATTACHED"), notice);
  assert.ok(notice.includes("role 'member'"), "names the role whose profile it used");
  assert.ok(notice.includes("/things/7, /b") && notice.includes("NOT covered"), "the other bounced routes are still gaps to visit");
  assert.ok(!notice.includes("SESSION AUTH LOST"), "a recovered session is not reported dead");
  assert.ok(!t.batchVerdict().includes("SESSION AUTH LOST"), "nor by a later batch verdict");
  assert.ok(t.reattachSummary().includes("re-attached once") && t.reattachSummary().includes("/c"), t.reattachSummary());
});

test("a second loss is reported, not retried, and says the one re-attach is spent", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  t.takeReattach();
  t.record({ requestedRoute: "/c", landedRoute: "/c", bounced: false, role: "member" });
  t.take();
  const second = loseSignIn(t);
  assert.equal(t.takeReattach(), null, "no second re-attach");
  assert.ok(second.includes("SESSION AUTH LOST"), second);
  assert.ok(second.includes("already re-attached once") && second.includes("scenescout login"), "says why it is not retried and what to do");
});

test("a session not attached by role reports the loss exactly as before", () => {
  for (const kind of ["file", "none"] as const) {
    const plain = new AuthLossTracker();
    const begun = new AuthLossTracker();
    begun.beginSession(kind, "someone");
    const before = loseSignIn(plain);
    const after = loseSignIn(begun);
    assert.equal(begun.takeReattach(), null, `${kind}: never re-attaches`);
    assert.equal(after, before, `${kind}: the same verdict text`);
    assert.equal(begun.reattachSummary(), "", `${kind}: nothing to say about a re-attach`);
  }
});

test("a latest profile that is dead too is reported, with why, and not retried", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  t.takeReattach();
  t.record({ requestedRoute: "/c", landedRoute: "/login", bounced: true, role: "member" });
  const notice = t.take();
  assert.ok(notice.includes("SESSION AUTH LOST"), notice);
  assert.ok(notice.includes("expired too") && notice.includes("not retried"), notice);
  assert.ok(!notice.includes("SESSION RE-ATTACHED"), "not claimed as recovered");
  loseSignIn(t);
  assert.equal(t.takeReattach(), null, "the once is spent");
  assert.ok(t.reattachSummary().includes("did not recover"), t.reattachSummary());
});

test("a profile that cannot be applied reports the loss and the reason", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  t.takeReattach();
  t.abortReattach("its saved profile could not be read (missing)");
  const notice = t.take();
  assert.ok(notice.includes("SESSION AUTH LOST") && notice.includes("could not be read (missing)"), notice);
  assert.ok(t.batchVerdict().includes("SESSION AUTH LOST"), "a later batch still says the session is dead");
});

test("a verdict whose call threw keeps the once for the next loss", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  // The engine never took the plan; the next navigation clears it.
  t.record({ requestedRoute: "/d", landedRoute: "/login", bounced: true, role: "member" });
  assert.notEqual(t.takeReattach(), null, "the still-dead session earns the re-attach on its next bounce");
});

test("attaching again gives the session its one re-attach back", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  t.takeReattach();
  t.abortReattach("x");
  t.beginSession("role", "member");
  t.record({ requestedRoute: "/e", landedRoute: "/e", bounced: false, role: "member" });
  loseSignIn(t);
  assert.notEqual(t.takeReattach(), null);
});

test("a sweep revisits only its own paths, and the notice asks for the rest", () => {
  // A streak that began with scout_navigate holds a full URL the sweep will not visit.
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  t.record({ requestedRoute: "/x", landedRoute: "/login", bounced: true, role: "member", target: "http://app.test/x" });
  for (const r of ["/a", "/b"]) t.record({ requestedRoute: r, landedRoute: "/login", bounced: true, role: "member" });
  const plan = t.takeReattach({ revisits: (p) => p.startsWith("/") });
  assert.deepEqual(plan, { returnTo: "/b", retry: ["/a"] }, "only the sweep's own paths come back to it");
  t.record({ requestedRoute: "/b", landedRoute: "/b", bounced: false, role: "member" });
  const notice = t.take();
  assert.ok(notice.includes("(/a) are visited again in this sweep"), notice);
  assert.ok(notice.includes("(http://app.test/x) are still NOT covered"), notice);
});

test("a re-attach whose return page never loaded is reported, not decided by a later navigation", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  loseSignIn(t);
  t.takeReattach({ revisits: () => true });
  assert.equal(t.reattaching, true);
  t.abortReattach("the page it went back to, /c, did not load (refused)");
  assert.equal(t.reattaching, false);
  t.record({ requestedRoute: "/public", landedRoute: "/public", bounced: false, role: "member" });
  assert.ok(!t.take().includes("RE-ATTACHED"), "a later public page is not claimed as the recovery");
  assert.ok(t.reattachSummary().includes("did not load"), t.reattachSummary());
});

test("a new attach does not inherit the last session's bounces", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  for (let i = 1; i < AUTH_LOSS_STREAK; i++) t.record({ requestedRoute: `/old${i}`, landedRoute: "/login", bounced: true, role: "member" });
  t.beginSession("role", "member");
  t.record({ requestedRoute: "/new", landedRoute: "/login", bounced: true, role: "member" });
  assert.equal(t.takeReattach(), null, "one bounce of the new session is not a verdict");
  assert.equal(t.batchVerdict(), "", "nor is the last session's verdict carried over");
});

test("a sweep's re-attach is said at the end of that sweep only", () => {
  const t = new AuthLossTracker();
  t.beginSession("role", "member");
  t.beginBatch();
  for (const r of ["/a", "/b", "/c"]) {
    t.record({ requestedRoute: r, landedRoute: "/login", bounced: true, role: "member" });
    t.clear();
  }
  assert.deepEqual(t.takeReattach({ revisits: () => true }), { returnTo: "/c", retry: ["/a", "/b"] });
  t.record({ requestedRoute: "/c", landedRoute: "/c", bounced: false, role: "member" });
  t.clear();
  const verdict = t.batchVerdict();
  assert.ok(verdict.includes("SESSION RE-ATTACHED") && verdict.includes("visited again in this sweep"), verdict);
  assert.ok(!verdict.includes("SESSION AUTH LOST"), verdict);
  t.beginBatch();
  assert.equal(t.batchVerdict(), "", "the next sweep does not repeat it");
});

test("the login pattern matches a segment, not a substring", () => {
  assert.equal(LOGIN_ROUTE_RE.test("/login"), true);
  assert.equal(LOGIN_ROUTE_RE.test("/auth/callback"), true);
  assert.equal(LOGIN_ROUTE_RE.test("/login.html"), false, "an extension is not a login route segment");
  assert.equal(LOGIN_ROUTE_RE.test("/logindetails"), false, "nor is a longer word starting with it");
});

test("the two copies of the login pattern have not drifted apart", () => {
  // memory.ts cannot import from the engine layer, so the pattern is duplicated
  // on purpose. A comment used to assert this was "kept in sync by the
  // migration test" — no test compared them, so editing one (adding `sso`, say)
  // would silently leave the storage layer classifying bounces differently from
  // the engine that detects them. This is that test.
  assert.equal(LOGIN_ROUTE_RE_STORAGE.source, LOGIN_ROUTE_RE.source, "storage-layer and engine-layer login patterns must stay identical");
  assert.equal(LOGIN_ROUTE_RE_STORAGE.flags, LOGIN_ROUTE_RE.flags);
});

// ---------------------------------------------------------------------------
// Ownership (safe-write): which records did this run create?
// A wrong "yes" here licenses a real DELETE on pre-existing data.
// ---------------------------------------------------------------------------

const created = (over: Partial<CreationEvidence>): CreationEvidence => ({ pathname: "/api/widgets", status: 201, requestBody: "", ...over });

test("ownership: a plain create claims the id the server minted", () => {
  assert.deepEqual(extractCreatedIds(created({ body: { id: 41, name: "w" } })), { collection: "/api/widgets", identityCollection: false, ids: ["41"] });
  assert.deepEqual(extractCreatedIds(created({ status: 200, body: { data: { uuid: "a1b2" } } })).ids, ["a1b2"], "ids nested under data/result/item are found");
  assert.deepEqual(extractCreatedIds(created({ location: "/api/widgets/77?x=1", body: undefined })).ids, ["77"], "a Location header alone is enough");
});

test("ownership: an id named after its resource is claimed, a foreign key beside it is not", () => {
  // {widget_id, owner_id}: owner_id is server-derived, so the request-echo
  // filter never sees it — only the key-names-this-URL rule keeps it out.
  const v = extractCreatedIds(created({ body: { widget_id: 9, owner_id: 3, createdById: 3 } }));
  assert.deepEqual(v.ids, ["9"]);
  assert.equal(keyMatchesUrl("widget_id", "/api/widgets"), true);
  assert.equal(keyMatchesUrl("owner_id", "/api/widgets"), false);
  assert.equal(keyMatchesUrl("orderItemId", "/api/order-items"), true, "camelCase key against a hyphenated segment");
  assert.equal(keyMatchesUrl("duplicate_id", "/api/widgets/duplicate"), false, "a key named after the RPC verb does not name the resource");
});

test("ownership: an id the client already sent is an echo, not a creation", () => {
  // Upsert: 200 with the id that was in the request body.
  assert.deepEqual(extractCreatedIds(created({ status: 200, body: { id: "555" }, requestBody: '{"id":"555","name":"x"}' })).ids, []);
  // ...but a 201 excuses a BARE id the client supplied (client-generated ids).
  assert.deepEqual(extractCreatedIds(created({ status: 201, body: { id: "555" }, requestBody: '{"id":"555"}' })).ids, ["555"]);
  // A PREFIXED key is never excused: it is exactly what an echoed foreign key looks like.
  const fromTemplate = extractCreatedIds(
    created({ pathname: "/api/widgets/from-template/5", status: 201, body: { widget_id: 88, template_id: 5 }, requestBody: '{"template_id":5}' }),
  );
  assert.deepEqual(fromTemplate.ids, ["88"], "the template that was copied FROM is not ours");
  // An id in the request PATH addresses an existing record, whatever comes back.
  assert.deepEqual(extractCreatedIds(created({ pathname: "/api/widgets/123/publish", body: { id: 123 } })).ids, []);
});

test("ownership: identity collections are listed for cleanup but never grant write access", () => {
  const v = extractCreatedIds(created({ pathname: "/api/users", body: { id: 12 } }));
  assert.equal(v.identityCollection, true);
  assert.deepEqual(v.ids, ["12"]);
  assert.equal(extractCreatedIds(created({ pathname: "/api/widgets", body: { id: 12 } })).identityCollection, false);
});

test("ownership: one response cannot mint a page of ownership", () => {
  const body = { data: { id: 1 }, result: { id: 2 }, item: { id: 3 }, uuid: "u4", _id: "x5", id: 6 };
  assert.equal(extractCreatedIds(created({ body })).ids.length, 5);
});

test("ownership: the creation collection is collapsed before any RPC verb", () => {
  assert.equal(deriveCollection("/api/widgets/from-template/5"), "/api/widgets");
  assert.equal(deriveCollection("/api/widgets/5/comments"), "/api/widgets/5/comments", "a nested create is not truncated at the numeric segment");
  assert.equal(deriveCollection("/clone"), "/clone", "never an empty collection");
});

const owns = (collection: string, id: string, pathname: string): boolean => isOwnedResource(new Map([[id, new Set([collection])]]) as OwnedIds, pathname);

test("ownership: the four path shapes a created record is reached by", () => {
  // 1. directly under the collection, and anything beneath the record
  assert.equal(owns("/api/widgets", "88", "/api/widgets/88"), true);
  assert.equal(owns("/api/widgets", "88", "/api/widgets/88/attachments/2"), true);
  assert.equal(owns("/widgets", "88", "/widgets/88"), true, "an API with no /api prefix");
  assert.equal(owns("/api/widgets/", "88", "/api/widgets/88"), true, "a stored trailing slash");
  // 2. a verb between the collection and the id
  assert.equal(owns("/api/widgets", "88", "/api/widgets/archive/88"), true);
  assert.equal(owns("/api/widgets", "88", "/api/widgets/bulk/delete/88"), true);
  // 3. a verb in the CREATION path, below the collection
  assert.equal(owns("/api/widgets/quick", "7", "/api/widgets/7"), true);
  // 4. created nested under a parent record, addressed at the top level afterwards
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/tasks/9"), true);
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/projects/3/tasks/9"), true);
});

test("ownership never steps across another record's id", () => {
  // Numeric ids collide across tables: "9 is ours under tasks" says nothing
  // about project 9, order 77, or widget 12's link 88 — all pre-existing data.
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/projects/9"), false, "a task's id is not a project's id");
  assert.equal(owns("/api/orders/5/items", "77", "/api/orders/77"), false);
  assert.equal(owns("/api/widgets", "88", "/api/widgets/12/links/88"), false, "88 under somebody else's widget 12");
  assert.equal(owns("/api/widgets", "88", "/api/widgets/89"), false, "a neighbour");
  assert.equal(owns("/api/widgets", "88", "/api/gadgets/88"), false, "the same id in another collection");
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/projects/4/tasks/9"), false, "same id under a different parent record");
  assert.equal(owns("/api/widgets", "88", "/api/widgets/0a1b2c3d4e5f/88"), false, "a hex token in between is an id too");
  assert.equal(owns("/api/projects/3/tasks", "9", "/api/subtasks/9"), false, "shallow nesting needs the SAME collection name");
  assert.equal(owns("/api/tasks", "9", "/api/v2/tasks/9"), false, "a flat create does not license a differently-rooted path");
  // The word between a collection and an id is as often a SUB-COLLECTION as a
  // verb, so only allowlisted verbs are accepted in either position.
  assert.equal(owns("/api/widgets", "88", "/api/widgets/links/88"), false, "link 88 is not widget 88");
  assert.equal(owns("/api/widgets/links", "7", "/api/widgets/7"), false, "creating link 7 does not license a write on widget 7");
});

test("ownership: a generic creation endpoint owns its own path and nothing else", () => {
  // POST /api (or /rpc) stores a collection that prefixes the whole app.
  assert.equal(owns("/api", "7", "/api/7"), true);
  assert.equal(owns("/api", "7", "/api/gadgets/7"), false);
  assert.equal(owns("/api", "7", "/api/gadgets/7/children/1"), false);
});

test("ownership: ids match whatever case or encoding the URL uses", () => {
  const owned: OwnedIds = new Map([[normalizeId("7B2E9F10-AAAA-4BBB-8CCC-1234567890AB"), new Set(["/api/widgets"])]]);
  assert.equal(isOwnedResource(owned, "/api/widgets/7b2e9f10-aaaa-4bbb-8ccc-1234567890ab"), true);
  assert.equal(isOwnedResource(owned, "/api/widgets/7B2E9F10-AAAA-4BBB-8CCC-1234567890AB"), true);
  const spaced: OwnedIds = new Map([[normalizeId("Q3 plan"), new Set(["/api/docs"])]]);
  assert.equal(isOwnedResource(spaced, "/api/docs/Q3%20plan"), true);
  assert.equal(normalizeId("100%"), "100%", "a stray percent sign is compared as written, not thrown on");
});

test("the wire decision, mode by mode", () => {
  // columns: method, destructive-looking?, addresses a record this run created?
  const cases: Array<[string, boolean, boolean]> = [
    ["POST", false, false], // an ordinary form submission
    ["POST", true, false], // POST /items/7/archive
    ["POST", true, true], // ...on our own record
    ["PUT", false, false],
    ["PUT", false, true],
    ["DELETE", false, false],
    ["DELETE", false, true],
  ];
  const table = (mode: (typeof WRITE_MODES)[number]) => cases.map(([method, destructive, owned]) => allowsWrite(mode, method, destructive, owned));

  assert.deepEqual(
    table("observe"),
    [false, false, false, false, false, false, false],
    "observe lets nothing but GETs leave the page — not even an ordinary form POST, not even on a record the run owns",
  );
  assert.deepEqual(table("read-only"), [true, false, true, false, false, false, false], "read-only lets plain POSTs through and nothing that edits or deletes");
  assert.deepEqual(table("safe-write"), [true, false, true, false, true, false, true], "safe-write edits and deletes only what the run created");
  assert.deepEqual(table("destructive"), [true, true, true, true, true, true, true]);
  assert.deepEqual([...WRITE_MODES], ["observe", "read-only", "safe-write", "destructive"], "ordered from strictest to loosest");
});

test("the auth exemption never covers a destructive request, in any mode", () => {
  // The exemption used to be tested before the destructive check, so a path
  // that merely contained "session" or "auth" carried a delete through read-only.
  for (const mode of WRITE_MODES) {
    assert.equal(isAuthExempt(mode, "POST", "/api/session/123/delete", true), false, mode);
    assert.equal(isAuthExempt(mode, "POST", "/api/auth/users/5/delete", true), false, mode);
    assert.equal(isAuthExempt(mode, "PUT", "/api/auth/login", false), false, `${mode}: only POST is ever exempt`);
  }
  assert.equal(isAuthExempt("read-only", "POST", "/api/auth/login", false), true);
  assert.equal(isAuthExempt("read-only", "POST", "/signup", false), true, "outside observe, signing up is part of the auth surface a tester walks");
});

test("in observe mode only the requests a login itself needs are exempt", () => {
  const exempt = (p: string): boolean => isAuthExempt("observe", "POST", p, false);
  // A session has to be able to exist.
  for (const p of [
    "/login",
    "/api/auth/login",
    "/api/v1/auth/sign-in",
    "/auth/token/refresh",
    "/oauth/token",
    "/api/session",
    "/api/sessions",
    "/logout",
    "/sso/callback",
  ]) {
    assert.equal(exempt(p), true, `${p} should be let through`);
  }
  // Everything else changes data on the target, whatever word is in its path.
  for (const p of [
    "/signup",
    "/api/auth/signup",
    "/api/auth/register",
    "/api/auth/users", // invite or create a user
    "/account/password",
    "/api/user/password/change",
    "/password/reset/confirm",
    "/verify/documents/12/approve",
    "/users/login-history/clear", // "login" as part of a longer segment
    "/api/tokens", // mint an API token
    "/api/session/123/extend", // acts ON a session
    "/api/orders",
    "/",
  ]) {
    assert.equal(exempt(p), false, `${p} must be blocked in observe`);
  }
});

test("in observe, refresh, token, session, callback and authorize are sign-in only on an auth path, not on a record or another resource (#549)", () => {
  const exempt = (p: string): boolean => isAuthExempt("observe", "POST", p, false);
  // A session still has to be able to exist and be renewed.
  for (const p of [
    "/api/auth/refresh",
    "/oauth/token",
    "/auth/token/refresh",
    "/api/token/refresh",
    "/api/v1/auth/session",
    "/api/session",
    "/session",
    "/refresh",
    "/connect/token",
    "/oauth2/v1/token",
    "/realms/acme/protocol/openid-connect/token",
    "/api/auth/callback/credentials",
    "/sso/callback",
    "/oauth/authorize",
    "/.auth/refresh",
    // Identity providers whose tenant, realm or server id comes before the auth path.
    "/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token",
    "/oauth2/aus1a2b3c4d5e6f7g8h9/v1/token",
    "/b2c_1_signin/oauth2/v2.0/token",
    "/realms/tenant2024prod/protocol/openid-connect/token",
    // A provider's callback: /auth/:provider/callback.
    "/auth/github/callback",
    "/users/auth/google_oauth2/callback",
    "/.auth/login/aad/callback",
    // An auth service named for itself.
    "/rt-auth/token",
  ])
    assert.equal(exempt(p), true, `${p} should be let through`);
  // The same words acting on a record, or naming another resource's action, are writes.
  for (const p of [
    "/api/reports/refresh",
    "/api/cache/refresh",
    "/api/devices/4/refresh",
    "/api/users/7/token",
    "/api/carts/9/session",
    "/api/payments/callback",
    "/api/integrations/slack/authorize",
    "/api/auth/sessions/0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b/refresh",
    "/api/payments/callback/stripe",
    "/api/auth/session/extend",
    // The word second to last, with an action after it.
    "/api/refresh/reports",
    "/api/token/mint",
    "/api/callback/run",
    "/api/v1/authorize/grant",
    "/api/integrations/slack/callback",
  ])
    assert.equal(exempt(p), false, `${p} must be refused in observe`);
  // Outside observe the broad auth rule is unchanged.
  assert.equal(isAuthExempt("read-only", "POST", "/api/carts/9/session", false), true);
});

test("in observe, an auth path that belongs to a record or an integration is not a sign-in (#549)", () => {
  const exempt = (p: string): boolean => isAuthExempt("observe", "POST", p, false);
  // Each pair differs in the one fact that flips the verdict.
  const pairs: Array<[signIn: string, write: string, why: string]> = [
    ["/api/auth/refresh", "/api/devices/7/auth/refresh", "a device's auth credentials, not the session's"],
    ["/api/v1/auth/token", "/api/apps/42/auth/token", "an app record's token"],
    ["/api/auth/token", "/api/orgs/5f9c2b1e8a7d6c5b4a3f2e1d/auth/token", "a record whose id is hex"],
    [
      "/realms/12345/protocol/openid-connect/token",
      "/api/projects/12345/openid-connect/token",
      "a realm is an identity provider's scope; a project is a record",
    ],
    ["/auth/github/callback", "/api/sessions/7/callback", "a session record, not a provider"],
    ["/auth/github/callback", "/auth/7/callback", "a provider has a name, not an id"],
    ["/connect/token", "/api/stripe-connect/callback", "connect inside a longer segment names an integration"],
    ["/auth/github/callback", "/api/connect/stripe/callback", "a provider callback under connect links an integration"],
    ["/oauth/github/callback", "/api/tokens/github/callback", "tokens is not where a provider's callback lands"],
    // A tenant's sign-in policy follows the tenant, and is not a record of it.
    ["/tenant.example.com/B2C_1_signupsignin/oauth2/v2.0/token", "/api/projects/B2C_1_signupsignin/oauth2/v2.0/token", "a policy after a tenant"],
    ["/tfp/tenant.example.com/B2C_1A_signin/oauth2/v2.0/token", "/api/devices/7/oauth2/v2.0/token", "a policy after tfp's tenant"],
    [
      "/72f988bf-86f1-41af-91ab-2d7cd011db47/B2C_1_signin/oauth2/v2.0/token",
      "/devices/7/auth/refresh",
      "a policy after a tenant's id; a record with no API prefix",
    ],
  ];
  for (const [signIn, write, why] of pairs) {
    assert.equal(exempt(signIn), true, `${signIn} should be let through`);
    assert.equal(exempt(write), false, `${write} must be refused in observe: ${why}`);
  }
});

test("in observe, sign-in steps that frameworks spell their own way are let through, and their look-alikes are not (#549)", () => {
  const exempt = (p: string): boolean => isAuthExempt("observe", "POST", p, false);
  const pairs: Array<[signIn: string, write: string]> = [
    ["/users/sign_in", "/users/sign_up"], // underscores, as some frameworks spell it
    ["/sign_in", "/users/password"], // a password reset request
    ["/users/sign_out", "/users/confirmation"],
    ["/api/v1/authn", "/api/v1/authn/recovery/password"], // a sign-in transaction, and a password reset in the same API
    ["/u/login/password", "/account/password"], // the password step of signing in, and changing one
    ["/login/password", "/api/users/7/password"],
    ["/u/login/password", "/api/users/7/login/password"], // a user record's password
  ];
  for (const [signIn, write] of pairs) {
    assert.equal(exempt(signIn), true, `${signIn} should be let through`);
    assert.equal(exempt(write), false, `${write} must be refused in observe`);
  }
  // GraphQL carries every operation on one path, so a sign-in mutation is not told apart by its path: refused, and named in SCENESCOUT_AUTH_POSTS only knowingly.
  assert.equal(exempt("/graphql"), false);
  assert.equal(exempt("/api/graphql"), false);
});

test("an auth allowlist (SCENESCOUT_AUTH_POSTS) replaces the path rule: only the listed sign-in POSTs are exempt (#549)", () => {
  assert.equal(AUTH_POSTS_ENV, "SCENESCOUT_AUTH_POSTS");
  assert.equal(authPostsSetting(undefined), null, "unset: the path rule");
  assert.equal(authPostsSetting("  "), null, "empty: the path rule");
  const setting = authPostsSetting("POST /api/login, POST https://idp.example.com/oauth/token\nGET /x");
  assert.ok(setting);
  assert.deepEqual(
    setting.entries.map((e) => e.entry),
    ["POST /api/login", "POST https://idp.example.com/oauth/token"],
  );
  assert.deepEqual(setting.rejected, ["GET /x"]);
  const app = "https://app.example.com";
  const list = (url: string) => ({ entries: setting.entries, appUrl: app, url });
  const exempt = (mode: (typeof WRITE_MODES)[number], url: string, destructive = false) =>
    isAuthExempt(mode, "POST", new URL(url).pathname, destructive, list(url));
  assert.equal(exempt("observe", `${app}/api/login`), true, "listed");
  assert.equal(exempt("observe", "https://idp.example.com/oauth/token"), true, "listed on another origin");
  assert.equal(exempt("observe", `${app}/api/auth/refresh`), false, "the path rule would let it out; the list does not name it");
  assert.equal(exempt("observe", `${app}/oauth/token`), false, "an entry with an origin matches that origin only");
  assert.equal(exempt("observe", `${app}/api/login`, true), false, "never a destructive one");
  assert.equal(exempt("read-only", `${app}/api/auth/login`), false, "in every mode, the list is the exemption");
  // A list whose every entry was rejected still replaces the path rule: no POST counts as signing in.
  const none = authPostsSetting("/api/login");
  assert.ok(none);
  assert.deepEqual(none.entries, []);
  assert.equal(isAuthExempt("observe", "POST", "/api/auth/login", false, { entries: none.entries, appUrl: app, url: `${app}/api/auth/login` }), false);
  // Without a list, the path rule.
  assert.equal(isAuthExempt("observe", "POST", "/api/auth/refresh", false, null), true);
});

test("in a guided check the auth allowlist only narrows the path rule: a POST must be listed and look like a sign-in (#549)", () => {
  const app = "https://app.example.com";
  const listed = authPostsSetting("POST /api/login, POST /api/graphql")!.entries;
  const exempt = (pathname: string, andSignInPath: boolean) =>
    isAuthExempt("observe", "POST", pathname, false, { entries: listed, appUrl: app, url: `${app}${pathname}`, andSignInPath });
  // Listed and a sign-in by its path: out either way.
  assert.equal(exempt("/api/login", true), true);
  assert.equal(exempt("/api/login", false), true);
  // Listed, but no sign-in by its path: the list alone lets it out; in a guided check it does not.
  assert.equal(exempt("/api/graphql", false), true, "the list replaces the path rule");
  assert.equal(exempt("/api/graphql", true), false, "a guided check also asks the path rule");
  // A sign-in by its path, but not listed: refused either way, so the operator's narrower list stays narrow.
  assert.equal(exempt("/api/auth/refresh", true), false);
  assert.equal(exempt("/api/auth/refresh", false), false);
  assert.equal(isAuthExempt("observe", "POST", "/api/auth/refresh", false, null), true, "with no list, the path rule alone");
});

test("a blocked script request is answered with a refusal; a blocked navigation is dropped", () => {
  assert.equal(answersWithRefusal("fetch"), true);
  assert.equal(answersWithRefusal("xhr"), true);
  // Answering a form post would replace the page the user was on with the stand-in body.
  assert.equal(answersWithRefusal("document"), false);
  for (const other of ["ping", "beacon", "other", "image"]) assert.equal(answersWithRefusal(other), false, other);
});

test("the policy's refusal is a marked 403 the page can read", () => {
  const same = policyRefusal("read-only", "DELETE", "/api/things/9");
  // 403: a 5xx invites retries and a 401 reads as "signed out" to many apps.
  assert.equal(same.status, 403);
  assert.match(same.headers[POLICY_REFUSAL_HEADER], /mode=read-only/);
  assert.equal(same.headers["content-type"], "application/json");
  const body = JSON.parse(same.body) as { error: string; message: string };
  assert.equal(body.error, "Forbidden");
  assert.match(body.message, /DELETE \/api\/things\/9/);
  assert.match(body.message, /never received/);
  // No Origin header, no CORS headers: nothing to echo.
  assert.equal(same.headers["access-control-allow-origin"], undefined);

  // A cross-origin API call has to be allowed to read the refusal, or it fails as a network error and is dropped all over again.
  const cross = policyRefusal("observe", "POST", "/api/things", "http://app.test");
  assert.equal(cross.headers["access-control-allow-origin"], "http://app.test");
  assert.equal(cross.headers["access-control-allow-credentials"], "true");
});

test("foreignFrameOrigin: a write is foreign when a frame of another site sent it", () => {
  const app = "http://app.test:3000/orders";
  for (const [chain, expected, why] of [
    [[], null, "the top document"],
    [["http://app.test:3000/widget"], null, "a same-origin frame"],
    [["https://forms.example.com/embed"], "https://forms.example.com", "a third party's embedded form"],
    [["http://app.test:4000/embed"], "http://app.test:4000", "another port is another origin"],
    [["about:blank", "https://chat.example.com/w"], "https://chat.example.com", "a blank frame belongs to the frame that made it"],
    [["about:blank"], null, "a blank frame made by the app"],
    [["http://app.test:3000/inner", "https://pay.example.com/box"], "https://pay.example.com", "an app page nested inside a widget is still driven by it"],
    [["not a url"], null, "an address that cannot be read decides nothing"],
  ] as const) {
    assert.equal(foreignFrameOrigin(app, chain), expected, why);
  }
});

test("foreignWrite: a write started by another site and headed outside the app", () => {
  const app = "http://app.test:3000/checkout";
  const at = (over: Partial<Parameters<typeof foreignWrite>[1]>) =>
    foreignWrite(app, { url: "https://forms.example.com/submit", frameChain: [], frameUrl: app, ...over });
  // The frame the browser reports.
  assert.equal(at({ frameChain: ["https://forms.example.com/embed"], frameUrl: "https://forms.example.com/embed" }), "https://forms.example.com");
  assert.equal(
    at({ frameChain: ["http://app.test:3000/widget"], frameUrl: "http://app.test:3000/widget" }),
    null,
    "a same-origin frame's call out is the app's own",
  );
  // A foreign frame's form aimed at _top: reported against the top page, but its Origin header names the frame's site.
  assert.equal(at({ originHeader: "https://forms.example.com" }), "https://forms.example.com", "target=_top");
  assert.equal(at({ frameUrl: null, originHeader: "https://forms.example.com" }), "https://forms.example.com", "target=_blank or a popup: no frame at all");
  // The contrasts: the header says nothing new.
  assert.equal(at({ originHeader: "http://app.test:3000" }), null, "the app's own page calling a third party");
  assert.equal(at({ frameUrl: "https://idp.example.com/login", originHeader: "https://idp.example.com" }), null, "a sign-in page loaded as the whole page");
  assert.equal(at({ originHeader: "null" }), null, "an opaque origin says nothing");
  // A foreign frame writing into the app: a sign-in reply to the app's callback.
  assert.equal(
    at({ url: "http://app.test:3000/auth/callback", frameChain: ["https://idp.example.com/authorize"], frameUrl: "https://idp.example.com/authorize" }),
    null,
    "a write that lands in the app is the ordinary rules' business",
  );
  // A popup a foreign frame opened on its own site: header and page agree, but the session never adopted that page.
  assert.equal(
    at({ frameUrl: "https://forms.example.com/thanks", originHeader: "https://forms.example.com", unadoptedPageUrl: "https://forms.example.com/thanks" }),
    "https://forms.example.com",
  );
  assert.equal(at({ unadoptedPageUrl: null, originHeader: "http://app.test:3000" }), null, "the session's own page");
  // "Origin: null" (a no-referrer frame) out of the app, only when the page embeds another site.
  assert.equal(at({ originHeader: "null", pageHasForeignFrame: true }), "an embedded frame (Origin: null)");
  assert.equal(at({ originHeader: "null", pageHasForeignFrame: false }), null);
});

test("allowsForeignWriteOnSignIn: a captcha frame on the app's own sign-in page, outside observe", () => {
  const app = "http://app.test/";
  assert.equal(allowsForeignWriteOnSignIn("read-only", "http://app.test/login", app), true);
  assert.equal(allowsForeignWriteOnSignIn("safe-write", "http://app.test/auth/sign-in?next=/", app), true);
  assert.equal(allowsForeignWriteOnSignIn("read-only", "http://app.test/account/login.html", app), true, "a file extension is ignored");
  assert.equal(allowsForeignWriteOnSignIn("observe", "http://app.test/login", app), false, "observe sends the login request and nothing else");
  // The contrasts: where a payment provider's frame sits, and pages that only mention a sign-in word.
  assert.equal(allowsForeignWriteOnSignIn("read-only", "http://app.test/users/sign_in", app), true, "an underscore spelling");
  for (const path of [
    "/checkout",
    "/checkout/verify",
    "/checkout/auth",
    "/payments/3ds/auth",
    "/orders/verify-order",
    "/admin/token-list",
    "/session-report",
    "/password",
  ]) {
    assert.equal(allowsForeignWriteOnSignIn("read-only", `http://app.test${path}`, app), false, path);
  }
  assert.equal(allowsForeignWriteOnSignIn("read-only", "https://idp.example.com/login", app), false, "a sign-in page of another site");
  assert.equal(allowsForeignWriteOnSignIn("read-only", "not a url", app), false);
});

test("withForeignFrameSandbox: adds the sandbox, keeping the document's own policy", () => {
  assert.equal(withForeignFrameSandbox(undefined), "sandbox allow-scripts allow-forms allow-same-origin");
  assert.equal(withForeignFrameSandbox("  "), "sandbox allow-scripts allow-forms allow-same-origin");
  assert.equal(withForeignFrameSandbox("default-src 'self'"), "default-src 'self', sandbox allow-scripts allow-forms allow-same-origin");
  assert.doesNotMatch(FOREIGN_FRAME_SANDBOX, /allow-popups|allow-top-navigation/, "no popups and no top-window navigation");
});

test("offAppPageWrite: only a page an embed moved off the app, writing to another site", () => {
  const app = "http://app.test:3000/";
  const moved = "https://forms.example.com";
  assert.equal(offAppPageWrite(app, "https://forms.example.com/thanks", "https://forms.example.com/api/x", moved), moved);
  assert.equal(offAppPageWrite(app, "https://forms.example.com/thanks", "https://tracker.example.com/collect", moved), moved);
  // The contrasts.
  assert.equal(
    offAppPageWrite(app, "https://idp.example.com/idp/idx/identify", "https://idp.example.com/idp/idx/identify", null),
    null,
    "a sign-in page the tester went to",
  );
  assert.equal(
    offAppPageWrite(app, "https://idp.example.com/login", "https://idp.example.com/api/v1/authn", moved),
    null,
    "moved there by the tester, not the embed",
  );
  assert.equal(offAppPageWrite(app, "http://app.test:3000/orders", "https://payments.example.com/charge", moved), null, "back on the app");
  assert.equal(offAppPageWrite(app, "https://forms.example.com/thanks", "http://app.test:3000/callback", moved), null, "a write that lands in the app");
  assert.equal(offAppPageWrite(app, undefined, "https://x.example.com/", moved), null);
});

test("EmbedMoveTracker: who moved the page, decided on its navigation's first request", () => {
  const app = "http://app.test:3000/";
  const forms = new Set(["https://forms.example.com"]);
  const moved = (url: string, referer: string | undefined, embedded: ReadonlySet<string>) => {
    const t = new EmbedMoveTracker(app);
    t.pageLoaded("http://app.test:3000/checkout");
    t.navigationStarted(url, referer, embedded);
    t.pageLoaded(url);
    return t.movedTo;
  };
  // An embed moving the page: another site's Referer, or none at all to the embed's own site.
  assert.equal(moved("https://forms.example.com/thanks", "https://forms.example.com/embed", forms), "https://forms.example.com");
  assert.equal(moved("https://forms.example.com/thanks", undefined, forms), "https://forms.example.com", "a data: frame hides its origin");
  assert.equal(
    moved("https://evil.example.net/x", "https://forms.example.com/embed", forms),
    "https://evil.example.net",
    "to a third site, with the embed's Referer",
  );
  // The tester moving the page: the app as Referer, even to a site the app embeds for silent sign-in.
  assert.equal(moved("https://idp.example.com/login", "http://app.test:3000/checkout", new Set(["https://idp.example.com"])), null);
  // No Referer (an app that sends none), to a site the page does not embed: the tester's.
  assert.equal(moved("https://idp.example.com/login", undefined, forms), null);
  // No embeds on the page: nothing could have moved it but the tester.
  assert.equal(moved("https://forms.example.com/thanks", "https://forms.example.com/embed", new Set()), null);
  // It stays moved while the page stays on that site, and ends back on the app.
  const t = new EmbedMoveTracker(app);
  t.navigationStarted("https://forms.example.com/a", undefined, forms);
  t.pageLoaded("https://forms.example.com/a");
  t.pageLoaded("https://forms.example.com/b");
  assert.equal(t.movedTo, "https://forms.example.com");
  t.pageLoaded("http://app.test:3000/");
  assert.equal(t.movedTo, null);
});

test("sandboxedRedirectPage: navigates to the target, and a target cannot close the script", () => {
  const page = sandboxedRedirectPage("https://x.test/a?b=</script><script>alert(1)</script>");
  assert.match(page, /location\.replace\("https:\/\/x\.test\/a\?b=\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>"\)/);
  assert.equal(page.split("</script>").length, 2, "exactly one closing tag: the page's own");
});

test("scriptLiteral: nothing in the value can end or comment out an inline script", () => {
  for (const value of ["</script><script>alert(1)</script>", "<!-- a", "<script", "</SCRIPT >", "a\u2028b\u2029c", "]]>", "plain"]) {
    const literal = scriptLiteral(value);
    assert.ok(!literal.includes("<"), `no "<" survives in ${literal}`);
    assert.equal(JSON.parse(literal), value, "the script reads back the same string");
  }
});

test("hostileForEmbed: what is never typed into another site's frame", () => {
  for (const [value, why] of [
    ["<img src=x onerror=alert(1)>", "it is markup"],
    ["</textarea><script>", "it is markup"],
    ["javascript:alert(1)", "it is markup"],
    ["x".repeat(201), "it is longer than 200 characters"],
    ["a\u0000b", "it holds control characters"],
  ] as const) {
    assert.equal(hostileForEmbed(value), why, JSON.stringify(value).slice(0, 40));
  }
  // The contrasts: what a user types.
  for (const value of ["hello", "Zoë Müller", "qa-demo@example.com", "2 < 3 is true", "x".repeat(200), "line one\nline two", "日本語のテキスト"]) {
    assert.equal(hostileForEmbed(value), null, value.slice(0, 30));
  }
});

test("trustedEmbedOrigins: only plain http(s) origins, at most ten", () => {
  const { origins, rejected } = trustedEmbedOrigins([
    "https://pay.example.com",
    "https://pay.example.com/",
    "http://127.0.0.1:4242",
    "https://checkout.example.com/v3",
    "https://*.example.com",
    "ftp://files.example.com",
    "https://user:pw@example.com",
    "https://example.com/?x=1",
    "not a url",
  ]);
  assert.deepEqual(origins, ["https://pay.example.com", "http://127.0.0.1:4242"], "a trailing slash is the same origin, once");
  assert.deepEqual(rejected, [
    "https://checkout.example.com/v3",
    "https://*.example.com",
    "ftp://files.example.com",
    "https://user:pw@example.com",
    "https://example.com/?x=1",
    "not a url",
  ]);
  const many = trustedEmbedOrigins(Array.from({ length: 12 }, (_, i) => `https://p${i}.example.com`));
  assert.equal(many.origins.length, 10);
  assert.deepEqual(many.overflow, ["https://p10.example.com", "https://p11.example.com"], "valid, but over the limit: said as such");
  assert.deepEqual(many.rejected, []);
  assert.deepEqual(trustedEmbedOrigins(undefined), { origins: [], rejected: [], overflow: [] });
  assert.deepEqual(
    trustedEmbedOrigins(["https://pay.example.com.", "https://pay.example.com"]).origins,
    ["https://pay.example.com"],
    "a trailing dot is the same host",
  );
});

test("trustsEmbedWrite: a named origin, in safe-write only", () => {
  const trusted = new Set(["https://pay.example.com"]);
  assert.equal(trustsEmbedWrite("safe-write", trusted, "https://pay.example.com"), true);
  for (const mode of ["observe", "read-only", "destructive"] as const) {
    assert.equal(trustsEmbedWrite(mode, trusted, "https://pay.example.com"), false, mode);
  }
  assert.equal(trustsEmbedWrite("safe-write", trusted, "https://forms.example.com"), false, "an origin nobody named");
});

test("trustsForeignWrite: every other site involved must be trusted", () => {
  const app = "http://app.test/checkout";
  const trusted = new Set(["https://pay.example.com"]);
  const at = (req: Parameters<typeof trustsForeignWrite>[3], mode: Parameters<typeof trustsForeignWrite>[0] = "safe-write") =>
    trustsForeignWrite(mode, trusted, app, req);
  assert.equal(at({ frameChain: ["https://pay.example.com/card"], originHeader: "https://pay.example.com" }), true);
  // An untrusted embed wrapping a trusted one cannot borrow its trust; nor the other way round.
  assert.equal(at({ frameChain: ["https://pay.example.com/card", "https://forms.example.net/wrap"], originHeader: "https://forms.example.net" }), false);
  assert.equal(at({ frameChain: ["https://forms.example.net/inner", "https://pay.example.com/card"], originHeader: "https://forms.example.net" }), false);
  // A trusted frame whose request names an untrusted site in its Origin header.
  assert.equal(at({ frameChain: ["https://pay.example.com/card"], originHeader: "https://forms.example.net" }), false);
  // A popup the session never adopted is not a frame, trusted origin or not.
  assert.equal(at({ frameChain: [], originHeader: "https://pay.example.com", unadoptedPageUrl: "https://pay.example.com/checkout" }), false);
  // A wrapper with no web address of its own (blob:, data:) cannot pass as trusted; a blank or srcdoc one is its parent's.
  assert.equal(at({ frameChain: ["https://pay.example.com/card", "blob:https://forms.example.net/1b2c"], originHeader: "https://pay.example.com" }), false);
  assert.equal(at({ frameChain: ["https://pay.example.com/card", "data:text/html,x"], originHeader: "https://pay.example.com" }), false);
  assert.equal(at({ frameChain: ["about:srcdoc", "https://pay.example.com/card"], originHeader: "https://pay.example.com" }), true);
  // Only in safe-write, and never with nothing foreign to trust.
  assert.equal(at({ frameChain: ["https://pay.example.com/card"] }, "read-only"), false);
  assert.equal(at({ frameChain: ["about:srcdoc", "http://app.test/widget"], originHeader: "http://app.test" }), false);
});

test("embedOfRequest: an embed's failing request, unless it went to the app", () => {
  const app = "http://app.test/";
  assert.equal(embedOfRequest(app, "https://chat.example.com/api/x", "https://chat.example.com"), "https://chat.example.com");
  assert.equal(embedOfRequest(app, "https://cdn.example.net/lib.js", "https://chat.example.com"), "https://chat.example.com", "anywhere outside the app");
  // The contrasts: the app answered, or no embed sent it.
  assert.equal(embedOfRequest(app, "http://app.test/api/orders", "https://chat.example.com"), null, "a 500 from the app is the app's");
  assert.equal(embedOfRequest(app, "https://chat.example.com/api/x", null), null, "the app's own page or frame");
});

// ---------------------------------------------------------------------------
// Writes the route handler never sees (Chromium's unload beacons): unload.ts
// ---------------------------------------------------------------------------

test("an unseen write is judged by the route handler's rules: observe refuses a plain beacon, read-only lets it go and refuses a destructive one", () => {
  const judge = (mode: (typeof WRITE_MODES)[number], pathname: string, body: string | null, extra: Partial<Parameters<typeof judgeUnseenWrite>[0]> = {}) =>
    judgeUnseenWrite({
      mode,
      method: "POST",
      pathname,
      destructiveWire: isDestructiveWire(pathname, body),
      foreign: null,
      offApp: null,
      owned: false,
      ...extra,
    });
  // The contrastive pair the unload smoke suite drives: one body, the mode flips the verdict; one mode, the body flips it.
  assert.deepEqual(judge("observe", "/api/unload/beacon", '{"note":"draft"}'), { allow: false });
  assert.deepEqual(judge("read-only", "/api/unload/beacon", '{"note":"draft"}'), { allow: true });
  assert.deepEqual(judge("read-only", "/api/unload/beacon", '{"action":"delete"}'), { allow: false });
  assert.deepEqual(judge("destructive", "/api/unload/beacon", '{"action":"delete"}'), { allow: true });
  assert.deepEqual(judge("safe-write", "/api/items/7/delete", null, { owned: true }), { allow: true }, "safe-write: its own record");
  assert.deepEqual(judge("safe-write", "/api/items/7/delete", null), { allow: false });
  // Same answer as allowsWrite on every mode and method, for a write from the app's own page.
  for (const mode of WRITE_MODES)
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      for (const destructiveWire of [false, true])
        for (const owned of [false, true])
          assert.equal(
            judgeUnseenWrite({ mode, method, pathname: "/api/things/1", destructiveWire, foreign: null, offApp: null, owned }).allow,
            allowsWrite(mode, method, destructiveWire, owned),
            `${mode} ${method} destructive=${destructiveWire} owned=${owned}`,
          );
  assert.deepEqual(judge("observe", "/api/auth/login", "{}"), { allow: true }, "a sign-in still goes out in observe");
  assert.deepEqual(judgeUnseenWrite({ mode: "observe", method: "GET", pathname: "/x", destructiveWire: false, foreign: null, offApp: null, owned: false }), {
    allow: true,
  });
});

test("an unseen write another site sent, or one from a page an embed moved off the app, is refused with the reason the route handler gives", () => {
  const base = { method: "POST", pathname: "/collect", destructiveWire: false, offApp: null, owned: false } as const;
  assert.deepEqual(judgeUnseenWrite({ ...base, mode: "read-only", foreign: "https://chat.example.com" }), {
    allow: false,
    why: "sent from a frame of https://chat.example.com",
  });
  assert.deepEqual(judgeUnseenWrite({ ...base, mode: "read-only", foreign: null }), { allow: true }, "the contrast: the app's own beacon");
  assert.deepEqual(judgeUnseenWrite({ ...base, mode: "destructive", foreign: "https://chat.example.com" }), { allow: true });
  const moved = { ...base, foreign: null, offApp: "https://idp.example.com" };
  assert.deepEqual(judgeUnseenWrite({ ...moved, mode: "read-only" }), { allow: false, why: "sent from a page of https://idp.example.com, outside the app" });
  assert.deepEqual(judgeUnseenWrite({ ...moved, mode: "read-only", pathname: "/login" }), { allow: true }, "a sign-in excepted");
});

test("a write the route handler let through is claimed once, under the mode it was judged in, and not after it has gone stale", () => {
  const ledger = new RoutedWrites();
  const plain = bodyDigest(Buffer.from('{"note":"draft"}'));
  ledger.note("read-only", "POST", "http://app.test/api/items#top", plain, 1000);
  assert.equal(ledger.claim("observe", "POST", "http://app.test/api/items", plain, 1001), false, "a flow's stricter rule is not excused by the crawl's");
  assert.equal(ledger.claim("read-only", "PUT", "http://app.test/api/items", plain, 1001), false);
  assert.equal(ledger.claim("read-only", "POST", "http://app.test/api/items", plain, 1001), true, "the fragment is not part of the request");
  assert.equal(ledger.claim("read-only", "POST", "http://app.test/api/items", plain, 1002), false, "claimed once: an identical unload write is still judged");
  ledger.note("observe", "POST", "http://app.test/api/auth/login", "", 2000);
  assert.equal(ledger.claim("observe", "POST", "http://app.test/api/auth/login", "", 2000 + ROUTED_WRITE_TTL_MS + 1), false, "stale");
  for (let i = 0; i < 250; i++) ledger.note("observe", "POST", `http://app.test/api/n/${i}`, "", 3000);
  assert.equal(ledger.claim("observe", "POST", "http://app.test/api/n/0", "", 3000), false, "the oldest are dropped past the cap");
  assert.equal(ledger.claim("observe", "POST", "http://app.test/api/n/249", "", 3000), true);
});

test("a write heard of just after a flow hands back is judged by the flow's rule, not the crawl's it hands back to", () => {
  // The race: a beacon the flow's page sent as it was left, under observe, paused at the browser level 20 ms after the
  // crawl's read-only rule came back. Judged by the rule in force when it was heard of, read-only let it out.
  const rule = new WriteRule("read-only");
  rule.set("observe", 1000);
  assert.equal(rule.at(1000), "observe", "tightening applies at once");
  rule.set("read-only", 2000);
  assert.equal(rule.at(2020), "observe", "the flow's rule still judges a write heard of 20 ms after the hand-back");
  assert.equal(rule.at(2000 + LOOSENED_RULE_HOLD_MS), "observe");
  assert.equal(rule.at(2000 + LOOSENED_RULE_HOLD_MS + 1), "read-only", "and only for the hold: the crawl gets its own rule back");
  // The hold runs from the loosening, not from the tightening: a flow that ran longer than the hold is still covered.
  const long = new WriteRule("read-only");
  long.set("observe", 1000);
  long.set("read-only", 1000 + 3 * LOOSENED_RULE_HOLD_MS);
  assert.equal(long.at(1000 + 3 * LOOSENED_RULE_HOLD_MS + 20), "observe");
  // Two hand-backs in a row: each looser step is held, so the strictest recent one judges.
  const steps = new WriteRule("observe");
  steps.set("read-only", 1000);
  steps.set("safe-write", 1500);
  assert.equal(steps.at(1600), "observe");
  assert.equal(steps.at(1000 + LOOSENED_RULE_HOLD_MS + 1), "read-only");
  assert.equal(steps.at(1500 + LOOSENED_RULE_HOLD_MS + 1), "safe-write");
  assert.deepEqual(
    WRITE_MODES.map((m) => stricterMode(m, "read-only")),
    ["observe", "read-only", "read-only", "read-only"],
  );
});

test("a harmless write let through never excuses another body to the same URL: the ledger's key includes the body", () => {
  const ledger = new RoutedWrites();
  const url = "http://app.test/api/unload/race";
  ledger.note("read-only", "POST", url, bodyDigest(Buffer.from('{"note":"draft"}')), 1000);
  // Same mode, method and URL, a delete command for a body: not the request that was judged, so it is judged itself.
  assert.equal(ledger.claim("read-only", "POST", url, bodyDigest(Buffer.from('{"action":"delete"}')), 1001), false);
  assert.equal(ledger.claim("read-only", "POST", url, "", 1001), false, "nor one whose body the protocol did not include");
  assert.equal(ledger.claim("read-only", "POST", url, bodyDigest(Buffer.from('{"note":"draft"}')), 1001), true, "the contrast: the very same request");
  assert.equal(bodyDigest(null), "");
  assert.equal(bodyDigest(Buffer.alloc(0)), "");
  // Both sides hash the same bytes: the route handler's postDataBuffer and the paused request's base64 entries.
  const b64 = Buffer.from('{"note":"draft"}').toString("base64");
  assert.equal(bodyDigest(pausedRequestBytes({ postDataEntries: [{ bytes: b64 }] })), bodyDigest(Buffer.from('{"note":"draft"}')));
});

test("who sent an unseen write, from its headers: embeds by Origin, the sign-in exception by the page it was sent from", () => {
  const app = "http://app.test/";
  const src = (input: Partial<Parameters<typeof unseenWriteSource>[0]> & { url: string }) =>
    unseenWriteSource({ appUrl: app, mode: "read-only", trustedEmbeds: new Set(), movedByEmbed: null, ...input });
  // A sign-in provider's page, reached as the whole page, beaconing to itself as it is left: taken to be an embed's (the cautious direction).
  assert.deepEqual(src({ url: "https://idp.example.com/collect", originHeader: "https://idp.example.com", referer: "https://idp.example.com/authorize" }), {
    foreign: "https://idp.example.com",
    offApp: null,
  });
  // The contrast: the app's own beacon to itself.
  assert.deepEqual(src({ url: "http://app.test/api/collect", originHeader: "http://app.test", referer: "http://app.test/orders" }), {
    foreign: null,
    offApp: null,
  });
  // Origin: null, out of the app: an embed's, whether or not the page embeds one.
  assert.equal(src({ url: "https://tracker.example.net/b", originHeader: "null" }).foreign, "an embedded frame (Origin: null)");
  assert.equal(src({ url: "http://app.test/api/b", originHeader: "null" }).foreign, null, "into the app it is the app's business");
  // A trusted embed's Origin: its writes out go to the ordinary rules in safe-write, and only there.
  const trusted = new Set(["https://pay.example.com"]);
  const pay = { url: "https://pay.example.com/api/confirm", originHeader: "https://pay.example.com", trustedEmbeds: trusted };
  assert.equal(src({ ...pay, mode: "safe-write" }).foreign, null);
  assert.equal(src({ ...pay, mode: "read-only" }).foreign, "https://pay.example.com");
  // Leaving the app's sign-in page, whose captcha posts to its own site. A cross-origin request carries only the
  // origin as its Referer under the default policy (strict-origin-when-cross-origin), which names no sign-in page:
  // the exception does not apply, and the write is refused. That is what a browser sends, so it is the common case.
  const captcha = { url: "https://captcha.example.com/verify", originHeader: "https://captcha.example.com" };
  assert.equal(src({ ...captcha, referer: "http://app.test/" }).foreign, "https://captcha.example.com");
  // Only a page whose referrer policy sends the full URL (unsafe-url, no-referrer-when-downgrade) names its path.
  assert.equal(src({ ...captcha, referer: "http://app.test/login" }).foreign, null);
  assert.equal(src({ ...captcha, referer: "http://app.test/login", mode: "observe" }).foreign, "https://captcha.example.com", "never in observe");
  assert.equal(src({ ...captcha, referer: "http://app.test/settings" }).foreign, "https://captcha.example.com", "not from another page");
  // Where the session is when the request is seen does not count: only the page it was sent from.
  assert.equal(src({ ...captcha, referer: "http://app.test/", currentPageUrl: "http://app.test/login" }).foreign, "https://captcha.example.com");
  assert.equal(src({ ...captcha, currentPageUrl: "http://app.test/login" }).foreign, "https://captcha.example.com", "no Referer, no exception");
  // A page an embed moved off the app: its Referer names it, else the session's page stands in.
  const moved = { url: "https://idp.example.com/x", movedByEmbed: "https://idp.example.com" };
  assert.equal(src({ ...moved, referer: "https://idp.example.com/page" }).offApp, "https://idp.example.com");
  assert.equal(src({ ...moved, currentPageUrl: "https://idp.example.com/page" }).offApp, "https://idp.example.com");
  assert.equal(src({ ...moved, url: "http://app.test/api/x", referer: "https://idp.example.com/page" }).offApp, null, "a write into the app is the app's");
});

test("a paused request's body is read from its base64 entries, else its postData, and its headers by any case", () => {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  assert.equal(pausedRequestBody({ postDataEntries: [{ bytes: b64('{"action":') }, { bytes: b64('"delete"}') }] }), '{"action":"delete"}');
  assert.equal(pausedRequestBody({ postData: "plain" }), "plain");
  assert.equal(pausedRequestBody({}), undefined);
  assert.equal(isDestructiveWire("/api/unload/beacon", pausedRequestBody({ postDataEntries: [{ bytes: b64('{"action":"delete"}') }] })), true);
  assert.equal(headerOf({ Origin: "http://app.test" }, "origin"), "http://app.test");
  assert.equal(headerOf({ referer: "http://app.test/a" }, "Referer"), "http://app.test/a");
  assert.equal(headerOf(undefined, "origin"), undefined);
});

test("a write refused at the browser level is recognised when the driver reports it, by method and URL, and only for a while", () => {
  const refused = new UnseenRefusals();
  refused.note("POST", "http://app.test/api/things/7/delete#x", 1000);
  assert.equal(refused.has("POST", "http://app.test/api/things/7/delete", 1001), true, "fragment dropped");
  assert.equal(refused.has("POST", "http://app.test/api/things/7/delete", 1002), true, "not consumed: several listeners ask");
  assert.equal(refused.has("PUT", "http://app.test/api/things/7/delete", 1001), false);
  assert.equal(refused.has("POST", "http://app.test/api/things/8/delete", 1001), false, "the contrast: another request");
  assert.equal(refused.has("POST", "http://app.test/api/things/7/delete", 1000 + UNSEEN_REFUSAL_TTL_MS + 1), false, "stale");
});

test("discarding unsent edits is not destructive; discarding a record still is, and a discard on the wire is refused", () => {
  // The app's own leave-confirmation drops what was typed and never sent.
  for (const label of [
    "Discard changes",
    "Discard your changes",
    "Discard unsaved changes",
    "Discard all edits",
    "Discard draft changes",
    "discard changes",
    "discard-changes-button",
    "discard_unsaved_changes",
  ])
    assert.equal(isDestructive(label), false, label);
  // The other half: a discard that names a record, or nothing at all.
  for (const label of ["Discard draft", "Discard record", "Discard", "Discard changes and delete record", "Discard the order", "discard-draft", "row-discard"])
    assert.equal(isDestructive(label), true, label);
  // Whatever the label, a confirm that sends a discard is judged on the wire.
  assert.equal(isDestructiveWire("/api/drafts/5/discard"), true);
  assert.equal(isDestructiveWire("/api/things/5", '{"action":"discard"}'), true);
  assert.equal(isDestructiveWire("/api/things/5", '{"note":"discard this later"}'), false, "a word in content is not a command");
});

test("a control is judged by its own label: a dropdown by the pick, a row by its own text and what covers its centre", () => {
  const filter = { tag: "select", role: "combobox", name: "All Create Update Delete Archive", testid: "changelog-filter" };
  assert.equal(destructiveLabelOf(filter), null, "a filter is not destructive because one of its options is");
  assert.equal(pickIsDestructive("Create", filter.testid, "Create"), false, "choosing a harmless option is allowed");
  assert.equal(pickIsDestructive("Delete", filter.testid, "Delete"), true, "choosing Delete is refused");
  assert.equal(pickIsDestructive("3", filter.testid, "Delete"), true, "by its label when the value is opaque");
  assert.equal(pickIsDestructive("3", filter.testid, null), true, "an option label that could not be read refuses");
  assert.equal(destructiveLabelOf({ ...filter, testid: "bulk-delete" }), "bulk-delete", "a dropdown's own test id still counts");
  assert.equal(destructiveLabelOf({ tag: "div", role: "combobox", name: "Delete", testid: null }), null, "a custom combobox shows its value, not a command");

  // A row listed for its test id: its text includes the buttons inside it.
  const row = { tag: "div", role: "generic", name: "Order 3 Archived Edit Delete", testid: "order-row-3", ownText: "Order 3 Archived", centre: [] };
  assert.equal(destructiveLabelOf(row), null, "a row holding a Delete button is not itself a delete control");
  assert.equal(destructiveLabelOf({ ...row, centre: ["Delete"] }), "Delete", "a row whose centre is a Delete button is");
  assert.equal(destructiveLabelOf({ ...row, ownText: undefined }), row.name, "no own text read: the whole name stands in");
  assert.equal(
    destructiveLabelOf({ tag: "div", role: "generic", name: "Delete", testid: null, ownText: "Delete", centre: [] }),
    "Delete",
    "a clickable div saying Delete still is",
  );
  // An icon-only control: the page puts its given label (aria-label) first in its own text.
  assert.equal(destructiveLabelOf({ tag: "div", role: "none", name: "Delete row", testid: null, ownText: "Delete row", centre: [] }), "Delete row");
  assert.equal(
    destructiveLabelOf({ tag: "div", role: "tabpanel", name: "History All Create Delete", testid: "history-panel", ownText: "History", centre: [] }),
    null,
  );

  // A labelled control is judged whole, as before.
  assert.equal(destructiveLabelOf({ tag: "button", role: "button", name: "Archive", testid: null }), "Archive");
  assert.equal(destructiveLabelOf({ tag: "a", role: "link", name: "Remove member", testid: null, ownText: "" }), "Remove member");
  assert.equal(destructiveLabelOf({ tag: "button", role: "button", name: "Open", testid: "row-delete" }), "row-delete");
  assert.equal(destructiveLabelOf({ tag: "button", role: "button", name: "Discard changes", testid: null }), null);
});

test("an element that is not a control is not judged by the record text it shows", () => {
  // A row whose title is a record's free text, an event card, a heading: their text is data.
  const row = { tag: "tr", role: "generic", name: "", testid: "finding-row-4", interactive: true, centre: [] as string[] };
  assert.equal(destructiveLabelOf({ ...row, ownText: "Order 4 was approved without the required second-reviewer sign-off" }), null, "record prose");
  assert.equal(destructiveLabelOf({ ...row, ownText: "Archive Test Widget created 2 days ago by Sam" }), null, "a long row naming Archive");
  assert.equal(destructiveLabelOf({ ...row, ownText: "Archive Test Widget", interactive: false }), null, "listed for its test id only");
  assert.equal(destructiveLabelOf({ ...row, ownText: "Final sign-off recorded for order 12." }), null, "an event card");
  // ...while a row whose centre is a Delete button is refused, and so is a click target saying Delete.
  assert.equal(destructiveLabelOf({ ...row, ownText: "Archive Test Widget created 2 days ago by Sam", centre: ["Delete"] }), "Delete");
  assert.equal(
    destructiveLabelOf({ ...row, ownText: "Archive Test Widget", interactive: false, testid: "row-delete" }),
    "row-delete",
    "its test id still counts",
  );
  assert.equal(
    destructiveLabelOf({ tag: "div", role: "generic", name: "Archive item", testid: null, ownText: "Archive item", interactive: true }),
    "Archive item",
  );
  // The boundary, from the constant: a click target's text counts up to COMMAND_TEXT_WORDS words.
  const words = (n: number) => ["Delete", ...Array.from({ length: n - 1 }, (_, i) => `w${i}`)].join(" ");
  assert.equal(destructiveLabelOf({ tag: "div", role: "generic", name: "", testid: null, ownText: words(COMMAND_TEXT_WORDS) }), words(COMMAND_TEXT_WORDS));
  assert.equal(destructiveLabelOf({ tag: "div", role: "generic", name: "", testid: null, ownText: words(COMMAND_TEXT_WORDS + 1) }), null);
  assert.equal(destructiveLabelOf({ tag: "div", role: "generic", name: "", testid: null, ownText: "Delete. It." }), null, "a sentence is not a command");
  // A real control is judged by its whole name, whatever its length; the cap is for containers showing record text.
  for (const control of [
    { tag: "button", role: "button" },
    { tag: "a", role: "link" },
    { tag: "div", role: "button" },
    { tag: "li", role: "menuitem" },
    { tag: "div", role: "tab" },
  ])
    assert.equal(
      destructiveLabelOf({ ...control, name: "Delete all my saved data", testid: null, ownText: "Delete all my saved data", interactive: true }),
      "Delete all my saved data",
      `${control.tag} ${control.role}`,
    );
  assert.equal(
    destructiveLabelOf({ ...row, ownText: "Delete all my saved data from the archive was requested by Sam" }),
    null,
    "a clickable row whose text is a record saying so",
  );
  // A heading is never judged by its text, however short; its test id and centre still are.
  for (const h of [
    { tag: "h1", role: "generic" },
    { tag: "div", role: "heading" },
  ]) {
    assert.equal(destructiveLabelOf({ ...h, name: "Archive Test Widget", testid: null, ownText: "Archive Test Widget", interactive: true }), null, h.tag);
    assert.equal(destructiveLabelOf({ ...h, name: "Archive", testid: "delete-heading", ownText: "Archive" }), "delete-heading", h.tag);
  }
  // A facet checkbox is a labelled control, judged whole: the noun passes, the verb does not.
  assert.equal(destructiveLabelOf({ tag: "input", role: "checkbox", name: "Pending manager sign-off", testid: null }), null);
  assert.equal(destructiveLabelOf({ tag: "button", role: "button", name: "Sign off", testid: null }), "Sign off");
  // A filter chip's remove button against a member's.
  assert.equal(destructiveLabelOf({ tag: "button", role: "button", name: "Remove Status: Open filter", testid: null }), null);
  assert.equal(destructiveLabelOf({ tag: "button", role: "button", name: "Remove member", testid: null }), "Remove member");
});

test("observe lets out only the POST endpoints the user named as reads", () => {
  // Nothing by default: no option and no environment variable.
  assert.deepEqual(readPostsSetting(undefined, undefined), []);
  assert.deepEqual(readPostsSetting(undefined, "POST /api/search, POST /api/reports/query\nPOST /graphql"), [
    "POST /api/search",
    "POST /api/reports/query",
    "POST /graphql",
  ]);
  assert.deepEqual(readPostsSetting([], "POST /api/search"), [], "an option, even empty, wins over the environment");

  const parsed = readPostEntries([
    "POST /api/search",
    "post /api/reports/*/query/",
    "POST https://api.example.com/v2/search",
    "POST /graphql",
    "PUT /api/search",
    "/api/search",
    "POST api/search",
    "POST /api/search?x=1",
    "POST /api/sea*",
    "POST https://api.example.com/v2/search#frag",
    "POST /api/search",
  ]);
  assert.deepEqual(
    parsed.entries.map((e) => e.entry),
    ["POST /api/search", "POST /api/reports/*/query", "POST https://api.example.com/v2/search", "POST /graphql"],
  );
  assert.deepEqual(parsed.rejected, [
    "PUT /api/search",
    "/api/search",
    "POST api/search",
    "POST /api/search?x=1",
    "POST /api/sea*",
    "POST https://api.example.com/v2/search#frag",
  ]);
  const many = readPostEntries(Array.from({ length: MAX_READ_POSTS + 2 }, (_, i) => `POST /api/q${i}`));
  assert.equal(many.entries.length, MAX_READ_POSTS);
  assert.equal(many.overflow.length, 2);

  const app = "http://app.test:3000/";
  const { entries } = parsed;
  assert.equal(matchReadPost(entries, app, "http://app.test:3000/api/search?page=2")?.entry, "POST /api/search", "the query string is not the path");
  assert.equal(matchReadPost(entries, app, "http://app.test:3000/api/search/"), entries[0], "a trailing slash is ignored");
  assert.equal(matchReadPost(entries, app, "http://app.test:3000/api/reports/7/query")?.entry, "POST /api/reports/*/query");
  assert.equal(matchReadPost(entries, app, "http://app.test:3000/api/reports/7/8/query"), null, "* is one segment");
  assert.equal(matchReadPost(entries, app, "http://app.test:3000/api/search/save"), null, "exact, not a prefix");
  assert.equal(matchReadPost(entries, app, "http://other.test/api/search"), null, "an entry with no origin is the app's own");
  assert.equal(matchReadPost(entries, app, "https://api.example.com/v2/search")?.entry, "POST https://api.example.com/v2/search");

  const judge = (mode: (typeof WRITE_MODES)[number], url: string, body: string | null, method = "POST") =>
    readPostAllowed({ mode, method, url, appUrl: app, body, destructiveWire: isDestructiveWire(new URL(url).pathname, body), entries })?.entry ?? null;
  const search = "http://app.test:3000/api/search";
  // The contrastive pairs: one endpoint, the body flips it; one body, the listing flips it.
  assert.equal(judge("observe", search, '{"q":"widgets"}'), "POST /api/search", "a listed read goes out in observe");
  assert.equal(judge("observe", search, '{"action":"delete","ids":[3]}'), null, "the same path with a destructive body is refused");
  assert.equal(judge("observe", "http://app.test:3000/api/orders", '{"q":"widgets"}'), null, "a POST nobody named is refused");
  assert.equal(judge("observe", search, '{"q":"widgets"}', "PUT"), null, "only POST");
  assert.equal(judge("read-only", search, '{"q":"widgets"}'), null, "observe only: read-only judges POSTs by its own rule");
  assert.equal(
    readPostAllowed({ mode: "observe", method: "POST", url: search, appUrl: app, body: "{}", destructiveWire: false, entries: [] }),
    null,
    "nothing named",
  );
  // GraphQL on a listed endpoint: a query reads, a mutation or subscription does not.
  const gql = "http://app.test:3000/graphql";
  assert.equal(judge("observe", gql, JSON.stringify({ query: "query Widgets { widgets { id } }" })), "POST /graphql");
  assert.equal(judge("observe", gql, JSON.stringify({ query: "{ widgets { id } }" })), "POST /graphql", "an anonymous query");
  assert.equal(judge("observe", gql, JSON.stringify({ query: "mutation RenameWidget($id: ID!) { renameWidget(id: $id) { id } }" })), null);
  assert.equal(judge("observe", gql, JSON.stringify({ query: "mutation\n{ renameWidget(id: 1) { id } }" })), null, "an escaped newline");
  assert.equal(judge("observe", gql, JSON.stringify([{ query: "{ a }" }, { query: "subscription { onWidget { id } }" }])), null, "a batch with one write");
  assert.equal(judge("observe", gql, "mutation { renameWidget(id: 1) { id } }"), null, "a raw application/graphql body");
  assert.equal(judge("observe", search, JSON.stringify({ query: "mutation testing" })), "POST /api/search", "search text is not an operation");
  assert.equal(graphqlWriteOperation('{"query":"query { a }","variables":{"note":"mutation {"}}'), true, "the safe direction: a keyword anywhere refuses");
  assert.equal(judge("observe", search, "x".repeat(100_001)), null, "a body too long to vet is refused");
  assert.equal(judge("observe", gql, "query=mutation%20Rename%7B+renameWidget(id%3A1)%7Bid%7D%7D"), null, "a form-encoded mutation");
  assert.equal(judge("observe", gql, "query=%7B+widgets%7Bid%7D%7D"), "POST /graphql", "a form-encoded query");
  assert.equal(
    judge("observe", gql, JSON.stringify({ operationName: "Rename", extensions: { persistedQuery: { sha256Hash: "ab12" } } })),
    null,
    "a persisted query cannot be read",
  );
  assert.equal(judge("observe", search, JSON.stringify({ filters: "f".repeat(3000), action: "delete" })), null, "a command past the first 2000 characters");
  assert.equal(judge("observe", search, JSON.stringify({ filters: "f".repeat(3000), q: "widget" })), "POST /api/search", "the contrast: a long plain search");
});

test("an unseen POST named as a read goes out in observe, as the route handler lets it", () => {
  const base = { mode: "observe", method: "POST", pathname: "/api/search", destructiveWire: false, foreign: null, offApp: null, owned: false } as const;
  assert.deepEqual(judgeUnseenWrite({ ...base, readPost: true }), { allow: true });
  assert.deepEqual(judgeUnseenWrite({ ...base, readPost: false }), { allow: false });
  assert.deepEqual(judgeUnseenWrite({ ...base, readPost: true, foreign: "https://chat.example.com" }), {
    allow: false,
    why: "sent from a frame of https://chat.example.com",
  });
});

test("a blocked endpoint is explained once per session; repeats are counted on one line", () => {
  const notices = new BlockNotices();
  const beacon = { sig: "POST https://app.test/monitoring/tunnel?key=1", late: true, answered: true };
  const first = notices.notice("observe", [beacon, { ...beacon, sig: "POST https://app.test/monitoring/tunnel?key=2" }]);
  assert.match(first, /WRITE-POLICY blocked \(observe\): POST https:\/\/app\.test\/monitoring\/tunnel\?key=1 ×2 \(late/);
  assert.match(first, /NOT an app bug/);
  assert.match(first, /observe mode lets out only GET, HEAD and OPTIONS/);
  assert.doesNotMatch(first, /only a GET\b|not a GET\b/, "the hint does not say only GET leaves");
  assert.match(first, /answered with a 403/);

  const second = notices.notice("observe", [beacon, beacon, beacon]);
  assert.match(second, /WRITE-POLICY blocked \(observe\): 3 repeat blocks of 1 known endpoint \(POST https:\/\/app\.test\/monitoring\/tunnel ×3, background\)/);
  assert.doesNotMatch(second, /NOT an app bug|observe mode lets out|answered with a 403/, "the paragraph is not repeated");
  assert.equal(second.trim().split("\n").length, 1, "one line");

  const third = notices.notice("observe", [beacon, { sig: "POST https://app.test/api/things", late: false, answered: true }]);
  assert.match(third, /POST https:\/\/app\.test\/api\/things[.;]/, "a new endpoint is named in full");
  assert.doesNotMatch(third, /api\/things \(late/, "the action's own block is not marked late");
  assert.match(third, /also 1 repeat block of 1 known endpoint/);
  assert.match(third, /explained in full earlier/);
  assert.doesNotMatch(third, /observe mode lets out/, "the full paragraph is once per rule");

  // Nothing blocked, nothing said; a new rule is explained again; a reset starts over.
  assert.equal(notices.notice("observe", []), "");
  assert.match(notices.notice("read-only", [beacon]), /NOT an app bug.*safe-write/);
  notices.reset();
  assert.match(notices.notice("observe", [beacon]), /NOT an app bug/);

  // A reason beyond the mode's rule is said whenever the endpoint is new.
  const foreign = new BlockNotices().notice("read-only", [
    { sig: "POST https://pay.example/charge", late: false, why: "sent by an embedded frame of https://pay.example" },
    { sig: "navigation to data:text/html,x", late: false, why: ESCAPE_REFUSAL },
  ]);
  assert.match(foreign, /Refused because it was sent by an embedded frame/);
  assert.match(foreign, /WebKit drops the frame's sandbox/);
  assert.equal(blockSignature("POST https://a.test/x?y=1#z"), "POST https://a.test/x");
});

test("a leave confirmation is the caller's choice, the mode's when unsaid; other dialogs keep the mode's answer", () => {
  assert.equal(dialogResponse("beforeunload", true), "dismiss", "observe and read-only stay by default");
  assert.equal(dialogResponse("beforeunload", true, true), "accept", "leave: true leaves");
  assert.equal(dialogResponse("beforeunload", false), "accept", "write modes leave by default");
  assert.equal(dialogResponse("beforeunload", false, false), "dismiss", "leave: false stays");
  // A confirm can stand between a click and a delete: leave never answers it.
  assert.equal(dialogResponse("confirm", true, true), "dismiss");
  assert.equal(dialogResponse("confirm", false), "accept");
  assert.equal(dialogResponse("alert", true), "dismiss");

  const stayed = dialogNote({ type: "beforeunload", message: "", response: "dismiss" });
  assert.match(stayed, /LEAVE CONFIRMATION: the page asked to confirm leaving/);
  assert.match(stayed, /navigation was cancelled/);
  assert.match(stayed, /leave: true/);
  assert.match(dialogNote({ type: "beforeunload", message: "", response: "accept", leave: true }), /answered "leave" as asked \(leave: true\).*discarded/);
  assert.equal(
    dialogNote({ type: "confirm", message: "Remove  this\nitem?", response: "dismiss" }),
    '\nℹ DIALOG (confirm): "Remove this item?" — dismissed by the engine.',
  );
});

test("refusedPostPage: a refused POST is charged to the page that sent it, not to a session page URL that lags", () => {
  const app = "http://app.test:3000/";
  const sent = "http://app.test:3000/search?q=1";
  // The race: the page's script sent its POST before the session heard the page commit, so the session still reports "/".
  assert.equal(refusedPostPage(app, sent, "http://app.test:3000/"), sent, "the Referer names the page that sent it");
  assert.equal(refusedPostPage(app, sent, sent), sent);
  // No Referer, or one that cannot place it, and the session's page stands in.
  assert.equal(refusedPostPage(app, undefined, "http://app.test:3000/list"), "http://app.test:3000/list");
  assert.equal(refusedPostPage(app, "not a url", "http://app.test:3000/list"), "http://app.test:3000/list");
  assert.equal(
    refusedPostPage(app, "http://other.test/search", "http://app.test:3000/list"),
    "http://app.test:3000/list",
    "another site's page is not the app's",
  );
  // An origin-only referrer policy reduces every Referer to "/": the session's page says more.
  assert.equal(refusedPostPage(app, "http://app.test:3000/", "http://app.test:3000/list"), "http://app.test:3000/list");
  assert.equal(refusedPostPage(app, "http://app.test:3000/", undefined), "http://app.test:3000/");
  assert.equal(
    refusedPostPage(app, "http://app.test:3000/?tab=2", "http://app.test:3000/list"),
    "http://app.test:3000/?tab=2",
    "a query is more than the origin",
  );
  assert.equal(refusedPostPage(app, undefined, undefined), undefined);
});

// ---------------------------------------------------------------------------
// The route handler's decisions: route-guard.ts
// ---------------------------------------------------------------------------

test("the route handler judges a write in order: a foreign frame, then a page moved off the app, then sign-in, then a read POST", () => {
  const base = {
    rule: "safe-write",
    method: "POST",
    pathname: "/api/things",
    destructiveWire: false,
    foreign: null,
    offApp: null,
    readPost: false,
  } as const;
  assert.deepEqual(routedWriteVerdict(base), { kind: "by-ownership" });
  // A foreign frame's write is refused before any other rule, a sign-in included.
  assert.deepEqual(routedWriteVerdict({ ...base, pathname: "/api/auth/login", foreign: "https://chat.example.com" }), {
    kind: "refuse",
    why: "sent from a frame of https://chat.example.com",
  });
  // A page an embed moved off the app: refused, unless the write is a sign-in.
  assert.deepEqual(routedWriteVerdict({ ...base, offApp: "https://idp.example.com" }), {
    kind: "refuse",
    why: "sent from a page of https://idp.example.com, outside the app",
  });
  assert.deepEqual(routedWriteVerdict({ ...base, pathname: "/api/auth/login", offApp: "https://idp.example.com" }), { kind: "auth" });
  assert.deepEqual(routedWriteVerdict({ ...base, pathname: "/api/auth/login" }), { kind: "auth" });
  // A destructive-looking sign-in is not exempt.
  assert.deepEqual(routedWriteVerdict({ ...base, pathname: "/api/auth/login", destructiveWire: true }), { kind: "by-ownership" });
  assert.deepEqual(routedWriteVerdict({ ...base, rule: "observe", readPost: true }), { kind: "read-post" });
  // Sign-in is checked before the read POST: a read-named login is still let out as a login.
  assert.deepEqual(routedWriteVerdict({ ...base, rule: "observe", pathname: "/api/auth/login", readPost: true }), { kind: "auth" });
  assert.deepEqual(routedWriteVerdict({ ...base, rule: "observe", readPost: true, foreign: "https://chat.example.com" }).kind, "refuse");
});

test("the route handler and the browser-level interception reach the same verdict on every write", () => {
  for (const rule of ["read-only", "observe", "safe-write"] as const)
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      for (const pathname of ["/api/auth/login", "/api/things/1", "/api/things/1/delete"])
        for (const destructiveWire of [false, true])
          for (const foreign of [null, "https://chat.example.com"])
            for (const offApp of [null, "https://idp.example.com"])
              for (const readPost of [false, true])
                for (const owned of [false, true]) {
                  const verdict = routedWriteVerdict({ rule, method, pathname, destructiveWire, foreign, offApp, readPost });
                  const routed =
                    verdict.kind === "refuse"
                      ? { allow: false, why: verdict.why }
                      : verdict.kind === "by-ownership"
                        ? allowsWrite(rule, method, destructiveWire, owned)
                          ? { allow: true }
                          : { allow: false }
                        : { allow: true };
                  assert.deepEqual(
                    routed,
                    judgeUnseenWrite({ mode: rule, method, pathname, destructiveWire, foreign, offApp, owned, readPost }),
                    `${rule} ${method} ${pathname} destructive=${destructiveWire} foreign=${foreign} offApp=${offApp} readPost=${readPost} owned=${owned}`,
                  );
                }
});

test("a write marks its page's forms exercised only when the route handler will let it out", () => {
  const exercised = (
    rule: (typeof WRITE_MODES)[number],
    pathname: string,
    body: string | null,
    extra: { foreign?: string | null; offApp?: string | null } = {},
  ): boolean =>
    marksRouteExercised({
      rule,
      method: "POST",
      pathname,
      destructiveWire: isDestructiveWire(pathname, body),
      foreign: () => extra.foreign ?? null,
      offApp: () => extra.offApp ?? null,
    });
  // Observe: only a sign-in goes out.
  assert.equal(exercised("observe", "/api/things", "{}"), false);
  assert.equal(exercised("observe", "/api/auth/login", "{}"), true);
  // Read-only: a plain POST goes out, a destructive one is refused (the contrastive pair).
  assert.equal(exercised("read-only", "/api/things", '{"note":"draft"}'), true);
  assert.equal(exercised("read-only", "/api/things", '{"action":"delete"}'), false);
  assert.equal(exercised("safe-write", "/api/things", '{"action":"delete"}'), true, "safe-write leaves the destructive POST to ownership");
  // A foreign frame's write is refused in every mode the route handler runs in; destructive has no route handler.
  assert.equal(exercised("safe-write", "/api/things", "{}", { foreign: "https://chat.example.com" }), false);
  assert.equal(exercised("destructive", "/api/things", "{}", { foreign: "https://chat.example.com" }), true);
  // A page moved off the app: refused unless a sign-in.
  assert.equal(exercised("read-only", "/api/things", "{}", { offApp: "https://idp.example.com" }), false);
  assert.equal(exercised("read-only", "/api/auth/login", "{}", { offApp: "https://idp.example.com" }), true);
  // The frame and page are read only when the rule needs them.
  const asked: string[] = [];
  const probe = (rule: (typeof WRITE_MODES)[number], pathname: string) =>
    marksRouteExercised({
      rule,
      method: "POST",
      pathname,
      destructiveWire: false,
      foreign: () => (asked.push("foreign"), null),
      offApp: () => (asked.push("offApp"), null),
    });
  assert.equal(probe("destructive", "/api/things"), true);
  assert.equal(probe("observe", "/api/things"), false);
  assert.deepEqual(asked, [], "neither destructive nor a refused observe write asks");
  assert.equal(probe("read-only", "/api/things"), true);
  assert.deepEqual(asked, ["foreign", "offApp"]);
});

test("pathnameOf reads a request URL's path, and keeps what does not parse", () => {
  assert.equal(pathnameOf("https://app.example.com/api/things/7?x=1"), "/api/things/7");
  assert.equal(pathnameOf("not a url"), "not a url");
});

// The handler itself, driven through RouteGuardHost with a stand-in route: what each verdict does to the request.
type GuardCall = string;
function guardRig(
  rule: (typeof WRITE_MODES)[number],
  opts: {
    foreign?: string | null;
    owned?: (pathname: string) => boolean;
    readPost?: string;
    frameDoc?: "foreign" | "app" | null;
    classifier?: WriteClassifier;
    refuseGets?: boolean;
    authPosts?: string[];
  } = {},
) {
  const calls: GuardCall[] = [];
  const owned = new Set<string>();
  const host: RouteGuardHost = {
    appUrl: () => "https://app.example.com",
    rule: () => rule,
    pageUrl: () => "https://app.example.com/things",
    trustedEmbeds: () => new Set(),
    movedByEmbed: () => null,
    noteBlocked: (e) => void calls.push(`noteBlocked ${e.sig} answered=${e.answered}${e.why ? ` why=${e.why}` : ""}`),
    logAction: (e) => void calls.push(`log ${e.action}`),
    notePolicyBlock: () => void calls.push("notePolicyBlock"),
    noteSentWrite: () => void calls.push("noteSentWrite"),
    foreignWriteOf: () => opts.foreign ?? null,
    embedEscapeNavigation: () => false,
    frameDocumentKind: () => opts.frameDoc ?? null,
    sentByMainFrame: () => true,
    readPostOf: (r, method, url) =>
      opts.readPost && r === "observe" && method === "POST" && pathnameOf(url) === opts.readPost
        ? { entry: `POST ${opts.readPost}`, origin: null, segments: opts.readPost.split("/").filter(Boolean) }
        : null,
    noteObserveRefusedPost: (url) => void calls.push(`noteObserveRefusedPost ${pathnameOf(url)}`),
    clearRefusedPost: (url) => void calls.push(`clearRefusedPost ${pathnameOf(url)}`),
    isOwnedResource: (pathname) => owned.has(pathname) || (opts.owned?.(pathname) ?? false),
    recordCreation: async (res) => {
      owned.add(String((res as unknown as { created: string }).created));
    },
    writeClassifier: () => opts.classifier ?? "standard",
    refuseDestructiveGets: () => opts.refuseGets ?? false,
    authPosts: () => (opts.authPosts ? readPostEntries(opts.authPosts).entries : null),
  };
  const guard = new RouteGuard(host);
  const send = (
    method: string,
    path: string,
    { type = "xhr", body = null as string | null, created = undefined as string | undefined, answerAfterMs = 0, headers = {} as Record<string, string> } = {},
  ) => {
    const url = `https://app.example.com${path}`;
    const request = {
      method: () => method,
      url: () => url,
      resourceType: () => type,
      postData: () => body,
      postDataBuffer: () => (body === null ? null : Buffer.from(body)),
      headers: () => ({ origin: "https://app.example.com", ...headers }),
      frame: () => {
        throw new Error("no frame");
      },
      response: () => new Promise((resolve) => setTimeout(() => resolve({ ok: () => true, created }), answerAfterMs)),
    };
    let outcome = "unanswered";
    const route = {
      request: () => request,
      fallback: async () => void (outcome = "fallback"),
      continue: async () => void (outcome = "continue"),
      fulfill: async (r: { status?: number }) => void (outcome = `fulfill ${r.status}`),
      abort: async (code: string) => void (outcome = `abort ${code}`),
      fetch: async () => {
        throw new Error("not fetched in this rig");
      },
    };
    const done = guard.handle(route as unknown as Route).then(() => outcome);
    return { request: request as unknown as Request, done };
  };
  return { calls, guard, send };
}

test("RouteGuard: each verdict is applied to the request, and a refusal is recorded and reported", async () => {
  // Read-only: a plain POST goes out; the same POST carrying a destructive command is answered with a refusal (the contrastive pair).
  {
    const { calls, guard, send } = guardRig("read-only");
    const plain = send("POST", "/api/things", { body: '{"note":"draft"}' });
    assert.equal(await plain.done, "fallback");
    assert.equal(guard.refused(plain.request), false);
    assert.deepEqual(calls, ["clearRefusedPost /api/things"], "a POST that went out is no longer a gap");
    calls.length = 0;
    const destructive = send("POST", "/api/things", { body: '{"action":"delete"}' });
    assert.equal(await destructive.done, "fulfill 403");
    assert.equal(guard.refused(destructive.request), true, "the request event's report must know the policy stopped it");
    assert.deepEqual(calls, ["noteBlocked POST https://app.example.com/api/things answered=true", "log write-policy:blocked", "notePolicyBlock"]);
    // A navigation's refused write is dropped, not answered.
    const form = send("DELETE", "/api/things/1", { type: "document" });
    assert.equal(await form.done, "abort blockedbyclient");
    assert.equal(guard.refused(form.request), true);
  }
  // Reads go out in every mode, and are never recorded.
  {
    const { calls, send } = guardRig("observe");
    for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(await send(method, "/api/things").done, "fallback");
    assert.deepEqual(calls, []);
  }
  // A foreign frame's write is refused before sign-in is considered, with the reason.
  {
    const { calls, guard, send } = guardRig("safe-write", { foreign: "https://chat.example.com" });
    const login = send("POST", "/api/auth/login", { body: "{}" });
    assert.equal(await login.done, "fulfill 403");
    assert.equal(guard.refused(login.request), true);
    assert.equal(calls[0], "noteBlocked POST https://app.example.com/api/auth/login answered=true why=sent from a frame of https://chat.example.com");
  }
  // Observe: a sign-in and a POST named as a read go out; any other POST is refused and remembered for the gap ledger.
  {
    const { calls, guard, send } = guardRig("observe", { readPost: "/api/search" });
    assert.equal(await send("POST", "/api/auth/login", { body: "{}" }).done, "fallback");
    assert.deepEqual(calls, []);
    assert.equal(await send("POST", "/api/search", { body: '{"q":"x"}' }).done, "fallback");
    assert.deepEqual(calls, ["log write-policy:read-post", "clearRefusedPost /api/search"]);
    calls.length = 0;
    const other = send("POST", "/api/things", { body: "{}" });
    assert.equal(await other.done, "fulfill 403");
    assert.equal(guard.refused(other.request), true);
    assert.equal(calls[0], "noteObserveRefusedPost /api/things");
  }
  // Safe-write: PUT, PATCH and DELETE go out only on this run's own records.
  {
    const { guard, send } = guardRig("safe-write", { owned: (p) => p === "/api/things/mine" });
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal(await send(method, "/api/things/mine").done, "fallback", `${method} of an owned record`);
      const theirs = send(method, "/api/things/theirs");
      assert.equal(await theirs.done, "fulfill 403", `${method} of a record this run did not create`);
      assert.equal(guard.refused(theirs.request), true);
    }
  }
});

test("RouteGuard: observe's sign-in exemption, by the path rule and by an operator's allowlist (#549)", async () => {
  {
    const { send } = guardRig("observe");
    assert.equal(await send("POST", "/api/auth/refresh", { body: "{}" }).done, "fallback", "a token refresh goes out");
    assert.equal(await send("POST", "/api/reports/refresh", { body: "{}" }).done, "fulfill 403", "refreshing a report is a write");
    assert.equal(await send("POST", "/api/devices/4/refresh", { body: "{}" }).done, "fulfill 403", "so is an action on a record");
  }
  {
    const { send } = guardRig("observe", { authPosts: ["POST /api/login"] });
    assert.equal(await send("POST", "/api/login", { body: "{}" }).done, "fallback", "the listed sign-in goes out");
    assert.equal(await send("POST", "/api/auth/refresh", { body: "{}" }).done, "fulfill 403", "an auth path the operator did not list is refused");
  }
  // The browser-level interception applies the same list.
  const unseen = async (authPosts: string[] | undefined, path: string) => {
    const { guard } = guardRig("observe", { authPosts });
    const sent: string[] = [];
    await (guard as unknown as { judgeUnseenRequest(s: unknown, e: unknown): Promise<void> }).judgeUnseenRequest(
      { send: async (cmd: string) => void sent.push(cmd) },
      {
        requestId: "1",
        resourceType: "Ping",
        request: { url: `https://app.example.com${path}`, method: "POST", headers: { Origin: "https://app.example.com" }, postData: "{}" },
      },
    );
    return sent[0];
  };
  assert.equal(await unseen(undefined, "/api/auth/logout"), "Fetch.continueRequest");
  assert.equal(await unseen(["POST /api/login"], "/api/auth/logout"), "Fetch.failRequest");
  assert.equal(await unseen(["POST /api/login"], "/api/login"), "Fetch.continueRequest");
});

// Where the sign-in exemption (#549) meets a method override and the strict classifier (#548): the stricter outcome wins.
test("RouteGuard: a sign-in POST carrying a method override is judged as the method it names, by the path rule and by the allowlist", async () => {
  // Path rule, observe: the token refresh goes out; the same request naming PUT is a write, and refused.
  {
    const { send } = guardRig("observe");
    assert.equal(await send("POST", "/api/auth/refresh", { body: "{}" }).done, "fallback");
    assert.equal(await send("POST", "/api/auth/refresh?_method=PUT", { body: "{}" }).done, "fulfill 403");
  }
  // Path rule, read-only: a sign-in goes out; the same sign-in path naming DELETE is not a sign-in.
  {
    const { send } = guardRig("read-only");
    assert.equal(await send("POST", "/api/auth/login", { body: "{}" }).done, "fallback");
    assert.equal(await send("POST", "/api/auth/login", { body: "{}", headers: { "x-http-method-override": "DELETE" } }).done, "fulfill 403");
  }
  // Allowlist, in observe and in read-only: the listed sign-in goes out; the listed path naming another method does not.
  for (const rule of ["observe", "read-only"] as const) {
    const { send } = guardRig(rule, { authPosts: ["POST /api/login"] });
    assert.equal(await send("POST", "/api/login", { body: "{}" }).done, "fallback", `${rule}: the listed sign-in`);
    assert.equal(await send("POST", "/api/login?_method=DELETE", { body: "{}" }).done, "fulfill 403", `${rule}: the listed path, overridden`);
    assert.equal(
      await send("POST", "/api/login", { body: "{}", headers: { "x-http-method-override": "PUT" } }).done,
      "fulfill 403",
      `${rule}: the listed path, overridden by a header`,
    );
  }
  // The browser-level interception: the same pair.
  const unseen = async (url: string) => {
    const { guard } = guardRig("observe", { authPosts: ["POST /api/login"] });
    const sent: string[] = [];
    await (guard as unknown as { judgeUnseenRequest(s: unknown, e: unknown): Promise<void> }).judgeUnseenRequest(
      { send: async (cmd: string) => void sent.push(cmd) },
      { requestId: "1", resourceType: "Ping", request: { url, method: "POST", headers: { Origin: "https://app.example.com" }, postData: "{}" } },
    );
    return sent[0];
  };
  assert.equal(await unseen("https://app.example.com/api/login"), "Fetch.continueRequest");
  assert.equal(await unseen("https://app.example.com/api/login?_method=DELETE"), "Fetch.failRequest");
});

test("RouteGuard: a sign-in the strict classifier calls destructive is refused, by the path rule and by the allowlist; the standard classifier lets it out", async () => {
  // Path rule, observe: a token refresh whose body is a command.
  assert.equal(await guardRig("observe").send("POST", "/api/auth/refresh", { body: '{"action":"cancel"}' }).done, "fallback");
  assert.equal(await guardRig("observe", { classifier: "strict" }).send("POST", "/api/auth/refresh", { body: '{"action":"cancel"}' }).done, "fulfill 403");
  // Allowlist: an operator listed an endpoint whose name the strict classifier reads as a command; the list never lifts that.
  for (const rule of ["observe", "read-only"] as const) {
    const listed = { authPosts: ["POST /api/session/revokeOthers"] };
    assert.equal(await guardRig(rule, listed).send("POST", "/api/session/revokeOthers", { body: "{}" }).done, "fallback", `${rule}: standard`);
    assert.equal(
      await guardRig(rule, { ...listed, classifier: "strict" }).send("POST", "/api/session/revokeOthers", { body: "{}" }).done,
      "fulfill 403",
      `${rule}: strict`,
    );
  }
  // Destructive page loads, when refused, leave a sign-out link alone: the page load that revokes a record is refused, the one that signs out is not.
  {
    const { send } = guardRig("observe", { refuseGets: true });
    assert.equal(await send("GET", "/auth/logout", { type: "document" }).done, "fallback");
    assert.equal(await send("GET", "/sessions/3/revoke", { type: "document" }).done, "abort blockedbyclient");
  }
});

test("RouteGuard: a safe-write PUT right after the POST that created its record waits for the creation to be recorded", async () => {
  const { send } = guardRig("safe-write");
  const create = send("POST", "/api/things", { body: "{}", created: "/api/things/9", answerAfterMs: 30 });
  assert.equal(await create.done, "fallback");
  // Judged while the POST's answer is still on its way: allowed only because the handler waits for the pending creation.
  assert.equal(await send("PUT", "/api/things/9", { body: "{}" }).done, "fallback");
  assert.equal(await send("PUT", "/api/things/10", { body: "{}" }).done, "fulfill 403");
});

// ── Method overrides (#548): a POST that names another method is judged as that method ──

test("writeMethod: an override is read from every place a server takes one, and never loosens the method", () => {
  const as = (method: string, url: string, headers?: Record<string, string>, body?: string | null) => writeMethod({ method, url, headers, body });
  const u = "https://app.example.com/api/things/3";
  assert.deepEqual(as("POST", u), { method: "POST" }, "no override: the sent method");
  assert.deepEqual(
    as("POST", u, { "X-HTTP-Method-Override": "delete" }),
    { method: "DELETE", via: "X-HTTP-Method-Override: DELETE" },
    "header names in any case",
  );
  assert.deepEqual(as("POST", u, { "x-http-method": "PUT" }), { method: "PUT", via: "X-HTTP-Method: PUT" });
  assert.deepEqual(as("POST", u, { "X-Method-Override": "PATCH" }), { method: "PATCH", via: "X-Method-Override: PATCH" });
  assert.equal(as("POST", `${u}?_method=DELETE`).method, "DELETE", "the query");
  assert.equal(as("POST", `${u}?a=1&_method=delete#x`).method, "DELETE");
  assert.equal(as("POST", u, {}, "name=x&_method=put").method, "PUT", "a form-encoded body (how server-rendered forms send an edit)");
  assert.equal(as("POST", u, {}, "name=x&_method=DE%4CETE").method, "DELETE", "percent-encoded");
  assert.equal(as("POST", u, {}, '--b\r\nContent-Disposition: form-data; name="_method"\r\n\r\nDELETE\r\n--b--').method, "DELETE", "a multipart field");
  assert.equal(as("POST", u, {}, JSON.stringify({ _method: "delete", id: 3 })).method, "DELETE", "a top-level JSON key");
  // Keys as a server decodes them: percent-encoded, and `.` or a space read as `_`.
  assert.equal(as("POST", u, {}, "%5Fmethod=DELETE").method, "DELETE", "a percent-encoded key");
  assert.equal(as("POST", u, {}, ".method=DELETE").method, "DELETE", "`.method`, read as `_method`");
  assert.equal(as("POST", `${u}?%5Fmethod=PUT`).method, "PUT", "a percent-encoded key in the query");
  assert.equal(as("POST", u, {}, "--b\r\nContent-Disposition: form-data; name=_method\r\n\r\nDELETE\r\n--b--").method, "DELETE", "an unquoted multipart name");
  // Never looser: an override naming a read, or a POST on a DELETE, leaves the sent method.
  assert.deepEqual(as("POST", u, { "x-http-method-override": "GET" }), { method: "POST" });
  assert.deepEqual(as("DELETE", u, { "x-http-method-override": "POST" }), { method: "DELETE" });
  assert.deepEqual(as("PUT", `${u}?_method=GET`), { method: "PUT" });
  // A list, as a lenient server might read the first of: judged by the one that writes most.
  assert.equal(as("POST", u, { "x-http-method-override": "GET, DELETE" }).method, "DELETE");
  // Several places at once: the one that writes most.
  assert.equal(as("POST", `${u}?_method=GET`, { "x-http-method-override": "PATCH" }).method, "PATCH");
  // Content that merely mentions the word is not an override.
  assert.deepEqual(as("POST", u, {}, JSON.stringify({ note: "_method=delete in the old form" })), { method: "POST" });
  assert.deepEqual(as("POST", u, { "x-requested-with": "DELETE" }), { method: "POST" }, "an unrelated header");
  assert.deepEqual(as("POST", u, { "x-http-method-override": "<script>" }), { method: "POST" }, "a value that is not a method");
  // Labels: the sent method, then what it was judged as.
  assert.equal(writeMethodLabel("POST", as("POST", u, { "x-http-method-override": "DELETE" })), "POST as DELETE");
  assert.equal(writeMethodLabel("POST", as("POST", u)), "POST");
});

test("RouteGuard: a POST carrying a method override is judged as the method it names, in every mode", async () => {
  const overrides: Array<[string, { headers?: Record<string, string>; query?: string; body?: string; type?: string }]> = [
    ["X-HTTP-Method-Override header", { headers: { "x-http-method-override": "DELETE" } }],
    ["X-HTTP-Method header", { headers: { "x-http-method": "DELETE" } }],
    ["X-Method-Override header", { headers: { "x-method-override": "delete" } }],
    ["_method in the query", { query: "?_method=DELETE" }],
    ["_method in a form body", { body: "_method=delete&id=3", type: "document" }],
  ];
  // Read-only: the contrastive pair. The same POST with no override goes out; with any override naming DELETE it is refused.
  {
    const { send } = guardRig("read-only");
    assert.equal(await send("POST", "/api/things/3", { body: "id=3" }).done, "fallback", "a plain POST goes out in read-only");
    for (const [what, o] of overrides) {
      const r = send("POST", `/api/things/3${o.query ?? ""}`, { body: o.body ?? "id=3", headers: o.headers, type: o.type ?? "xhr" });
      assert.match(await r.done, /^(fulfill 403|abort blockedbyclient)$/, `read-only refuses a POST overridden by ${what}`);
    }
    // Naming PUT or PATCH is refused too: read-only lets none of them out.
    for (const m of ["PUT", "PATCH"])
      assert.equal(await send("POST", "/api/things/3", { body: "{}", headers: { "x-http-method-override": m } }).done, "fulfill 403", m);
    // A GET that names DELETE is not a read.
    assert.equal(await send("GET", "/api/things/3", { headers: { "x-http-method-override": "DELETE" } }).done, "fulfill 403", "GET overridden to DELETE");
    assert.equal(await send("GET", "/api/things/3?_method=delete").done, "fulfill 403", "GET with ?_method=delete");
  }
  // An override never loosens: a POST that names GET is still a POST, refused in observe.
  {
    const { send } = guardRig("observe");
    assert.equal(await send("POST", "/api/things", { body: "{}", headers: { "x-http-method-override": "GET" } }).done, "fulfill 403");
    // A sign-in overridden to DELETE is no longer a sign-in.
    assert.equal(await send("POST", "/api/auth/login", { body: "{}" }).done, "fallback", "the plain sign-in goes out");
    assert.equal(await send("POST", "/api/auth/login", { body: "{}", headers: { "x-http-method-override": "DELETE" } }).done, "fulfill 403");
  }
  // Safe-write: the override is judged by ownership, as the method it names would be.
  {
    const { send } = guardRig("safe-write", { owned: (p) => p === "/api/things/mine" });
    const del = { headers: { "x-http-method-override": "DELETE" } };
    assert.equal(await send("POST", "/api/things/mine", { body: "{}", ...del }).done, "fallback", "an owned record");
    assert.equal(await send("POST", "/api/things/theirs", { body: "{}", ...del }).done, "fulfill 403", "a record this run did not create");
    assert.equal(await send("POST", "/api/things/theirs", { body: "{}" }).done, "fallback", "the plain POST to it goes out");
  }
  // Destructive lets everything out.
  {
    const { send } = guardRig("destructive");
    assert.equal(await send("POST", "/api/things/3", { body: "{}", headers: { "x-http-method-override": "DELETE" } }).done, "fallback");
  }
});

test("writeMethod: a `_method` key is read as the servers that honour it normalise names", () => {
  const as = (url: string, body?: string) => writeMethod({ method: "POST", url, body }).method;
  const u = "https://app.example.com/api/things/3";
  const part = (disposition: string, value = "DELETE") => `--b\r\nContent-Disposition: ${disposition}\r\n\r\n${value}\r\n--b--`;
  // PHP drops leading spaces from a name and reads it only up to a NUL byte; Rack 2 strips the brackets round a top-level name.
  for (const key of ["+_method", "%20_method", "_method%00x", "[_method]", "_method]", "]]_method"]) {
    assert.equal(as(u, `${key}=DELETE`), "DELETE", `form key ${key}`);
    assert.equal(as(`${u}?${key}=DELETE`), "DELETE", `query key ${key}`);
  }
  // Multipart names, normalised the same way, quoted either way, wherever `name` sits among the parameters.
  assert.equal(as(u, part('form-data; name=".method"')), "DELETE", "a dotted multipart name");
  assert.equal(as(u, part('form-data; name=" _method"')), "DELETE", "a multipart name with a leading space");
  assert.equal(as(u, part("form-data; name='_method'")), "DELETE", "a single-quoted multipart name");
  assert.equal(as(u, part('form-data; name="_method" ; x=1')), "DELETE", "a space before the next parameter");
  assert.equal(as(u, part('form-data; filename="x"; name="_method"')), "DELETE", "name after filename");
  assert.equal(as(u, part('form-data; name="_method"', "\r\n")), "POST", "an empty value");
  // A second `name` (PHP keeps the last), a `;` inside another parameter's quotes, and an RFC 2231 `name*`.
  assert.equal(as(u, part('form-data; name="note"; name="_method"')), "DELETE", "a second name parameter");
  assert.equal(as(u, part('form-data; x="a;name=y"; name="_method"')), "DELETE", "a quoted `;` before the name");
  assert.equal(as(u, part("form-data; name*=UTF-8''_method")), "DELETE", "an RFC 2231 name");
  assert.equal(as(u, part('form-data; x="name=_method"; name="note"')), "POST", "`name=_method` inside another parameter's quotes");
  // The contrast: other names, and a filename that happens to be `_method`, are not the override.
  assert.equal(as(u, "_method_x=DELETE&x_method=DELETE&method=DELETE"), "POST");
  assert.equal(as(u, part('form-data; name="note"')), "POST", "another multipart field");
  assert.equal(as(u, part('form-data; name="file"; filename="_method"')), "POST", "a file named _method");
});

test("writeMethod: a body built to slow the multipart scan is read in linear time", () => {
  const body = 'name="_method"\n'.repeat(20000);
  const started = performance.now();
  assert.deepEqual(writeMethod({ method: "POST", url: "https://app.example.com/x", body }), { method: "POST" });
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
});

test("RouteGuard: a frame document is judged for an override and, when turned on, as a destructive page load", async () => {
  // An app frame's GET naming DELETE is a write, not a frame load.
  assert.equal(
    await guardRig("read-only", { frameDoc: "app" }).send("GET", "/items/3", { type: "document", headers: { "x-http-method-override": "DELETE" } }).done,
    "abort blockedbyclient",
  );
  assert.equal(await guardRig("read-only", { frameDoc: "app" }).send("GET", "/items/3", { type: "document" }).done, "fallback", "the plain frame loads");
  assert.equal(
    await guardRig("read-only", { frameDoc: "app", refuseGets: true }).send("GET", "/items/3/delete", { type: "document" }).done,
    "abort blockedbyclient",
  );
  assert.equal(await guardRig("read-only", { frameDoc: "app" }).send("GET", "/items/3/delete", { type: "document" }).done, "fallback", "off by default");
});

test("RouteGuard: a redirect's later hop to a destructive page load is refused at the browser level when turned on", async () => {
  const hop = async (refuseGets: boolean, url: string) => {
    const { guard } = guardRig("read-only", { refuseGets });
    const sent: string[] = [];
    await (guard as unknown as { judgeUnseenRequest(s: unknown, e: unknown): Promise<void> }).judgeUnseenRequest(
      { send: async (cmd: string) => void sent.push(cmd) },
      { requestId: "1", resourceType: "Document", request: { url, method: "GET", headers: {} } },
    );
    return sent[0];
  };
  assert.equal(await hop(true, "https://app.example.com/items/3/delete"), "Fetch.failRequest");
  assert.equal(await hop(false, "https://app.example.com/items/3/delete"), "Fetch.continueRequest");
  assert.equal(await hop(true, "https://app.example.com/blog/archive"), "Fetch.continueRequest");
});

test("RouteGuard: the refusal of an overridden POST names the method it was judged as", async () => {
  const { calls, send } = guardRig("read-only");
  assert.equal(await send("POST", "/api/things/3", { body: "{}", headers: { "x-http-method-override": "DELETE" } }).done, "fulfill 403");
  assert.equal(calls[0], "noteBlocked POST as DELETE https://app.example.com/api/things/3 answered=true");
});

test("RouteGuard: the browser-level interception judges a method override too", async () => {
  const judge = async (rule: (typeof WRITE_MODES)[number], headers: Record<string, string>, url = "https://app.example.com/api/things/3") => {
    const { guard } = guardRig(rule);
    const sent: string[] = [];
    const session = { send: async (cmd: string) => void sent.push(cmd) };
    await (guard as unknown as { judgeUnseenRequest(s: unknown, e: unknown): Promise<void> }).judgeUnseenRequest(session, {
      requestId: "1",
      resourceType: "Ping",
      request: { url, method: "POST", headers: { Origin: "https://app.example.com", ...headers }, postData: "{}" },
    });
    return sent[0];
  };
  assert.equal(await judge("read-only", {}), "Fetch.continueRequest", "a plain beacon goes out in read-only");
  assert.equal(await judge("read-only", { "X-HTTP-Method-Override": "DELETE" }), "Fetch.failRequest");
  assert.equal(await judge("read-only", {}, "https://app.example.com/api/things/3?_method=DELETE"), "Fetch.failRequest");
});

// ── The strict write classifier and destructive page loads (#548): opt-in ──

test("strict classifier: identifiers are split into words on camelCase, dots, dashes and underscores", () => {
  assert.deepEqual(identifierWords("UserService.DeleteUser"), ["user", "service", "delete", "user"]);
  assert.deepEqual(identifierWords("productDelete"), ["product", "delete"]);
  assert.deepEqual(identifierWords("bulk-delete_all"), ["bulk", "delete", "all"]);
  assert.deepEqual(identifierWords("HTMLDeleteButton"), ["html", "delete", "button"]);
});

test("strict classifier: the shapes the standard one misses are destructive when it is on, and not when it is off", () => {
  const H = "https://app.example.com";
  const missedByStandard: Array<[string, string | null, string]> = [
    [`${H}/api/deleteUser`, '{"id":3}', "camelCase path"],
    [`${H}/rpc/UserService.DeleteUser`, "{}", "RPC path"],
    [`${H}/api/things/3?action=delete`, null, "the query's action"],
    [`${H}/jsonrpc`, JSON.stringify({ jsonrpc: "2.0", method: "things.delete", params: { id: 3 } }), "JSON-RPC method"],
    [`${H}/graphql`, JSON.stringify({ query: "mutation { productDelete(id: 3) { id } }" }), "noun-first GraphQL"],
    [`${H}/api/batch`, JSON.stringify({ filter: "x".repeat(2500), action: "delete" }), "a command after 2,000 characters"],
  ];
  for (const verb of ["trash", "erase", "terminate", "disable", "cancel", "refund"])
    missedByStandard.push([`${H}/api/orders/3/${verb}`, "{}", `the verb ${verb}`]);
  for (const [url, body, what] of missedByStandard) {
    assert.equal(isDestructiveRequest(url, body, "standard"), false, `standard (today's behaviour) misses: ${what}`);
    assert.equal(isDestructiveRequest(url, body, "strict"), true, `strict catches: ${what}`);
  }
  // What the standard one catches, the strict one catches too.
  for (const [url, body] of [
    [`${H}/api/users/3/delete`, null],
    [`${H}/api/widgets/bulk-delete`, "{}"],
    [`${H}/graphql`, "mutation { deleteUser(id: 7) { id } }"],
    [`${H}/api/batch`, JSON.stringify({ action: "delete", ids: [1] })],
    [`${H}/api/patch`, JSON.stringify([{ op: "remove", path: "/a" }])],
    [`${H}/api/form`, "action=delete&id=3"],
    [`${H}/api/x`, JSON.stringify({ _method: "DELETE" })],
    // A verb before its object, where the object is a word that could also head a noun phrase.
    [`${H}/api/purge_logs`, "{}"],
    [`${H}/queues/3/purge-queue`, "{}"],
    [`${H}/api/users/3/delete-history`, "{}"],
    [`${H}/api/delete-settings`, "{}"],
    [`${H}/api/items/3/remove-status`, "{}"],
    [`${H}/api/jobs`, "action=delete-logs"],
    [`${H}/api/jobs`, JSON.stringify({ cmd: "destroy-queue" })],
  ] as Array<[string, string | null]>) {
    assert.equal(isDestructiveRequest(url, body, "standard"), true, url);
    assert.equal(strictIsDestructive(url, body), true, `strict: ${url} ${body}`);
  }
});

test("strict classifier: a noun phrase and prose that looks like a command are not destructive (the false alarms the standard one raises)", () => {
  const H = "https://app.example.com";
  const harmless: Array<[string, string | null, string, boolean]> = [
    // url, body, what, what the standard classifier says today
    [`${H}/api/delete-requests`, JSON.stringify({ reason: "moving" }), "a collection of deletion requests", true],
    [`${H}/api/notes`, JSON.stringify({ note: "action: delete" }), "a note whose text looks like a command key", true],
    [`${H}/api/orders/3/cancel-reasons`, "{}", "the reasons offered for cancelling", false],
    [
      `${H}/graphql`,
      JSON.stringify({ query: 'mutation { updateThing(id: 3, input: { note: "delete later" }) { id deletedAt } }' }),
      "a harmless mutation",
      true,
    ],
    [`${H}/graphql`, JSON.stringify({ query: "query { things { id deletedAt canDelete } }" }), "a query naming verbs", false],
    [`${H}/api/search?q=delete`, JSON.stringify({ q: "delete" }), "a search for the word", false],
    [`${H}/api/things`, JSON.stringify({ title: "How to delete a user", action: "create" }), "content and a harmless command", false],
  ];
  for (const [url, body, what, today] of harmless) {
    assert.equal(isDestructiveRequest(url, body, "standard"), today, `standard: ${what}`);
    assert.equal(isDestructiveRequest(url, body, "strict"), false, `strict: ${what}`);
  }
});

test("strict classifier: a GraphQL mutation is judged by its root fields, not by its arguments or selections", () => {
  assert.deepEqual(mutationRootFields('mutation Go($id: ID!) { a: productDelete(id: $id, note: "x{y}") { id deletedAt } other { z } }'), [
    "a",
    "productDelete",
    "other",
  ]);
  assert.deepEqual(mutationRootFields("query { deleteUser { id } }"), [], "a query has no mutation fields");
  assert.deepEqual(mutationRootFields("query Q { a } mutation M { cancelOrder(id: 1) { id } }"), ["cancelOrder"]);
});

test("destructive page loads: an address that is a command counts; a listing page that shares the word does not", () => {
  const H = "https://app.example.com";
  for (const url of [
    `${H}/items/3/delete`,
    `${H}/items/delete/3`,
    `${H}/orders/3/cancel`,
    `${H}/unsubscribe?token=abc`,
    `${H}/items/3?action=delete`,
    `${H}/items/3/archive`,
    `${H}/messages/0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b/trash`,
    `${H}/api/deleteItem?id=3`,
  ])
    assert.equal(destructiveGet(url), true, url);
  for (const url of [
    `${H}/blog/archive`,
    `${H}/mail/trash`,
    `${H}/items/3`,
    `${H}/search?q=delete`,
    `${H}/help/how-to-delete-requests`,
    `${H}/items?status=archived`,
    `${H}/deleted-items`,
  ])
    assert.equal(destructiveGet(url), false, url);
});

test("strict settings: read from the environment, off by default, and a value that is not on or off is an error", () => {
  assert.equal(writeClassifierSetting({}), "standard");
  assert.equal(writeClassifierSetting({ SCENESCOUT_STRICT_WRITES: "1" }), "strict");
  assert.equal(writeClassifierSetting({ SCENESCOUT_STRICT_WRITES: "true" }), "strict");
  assert.equal(writeClassifierSetting({ SCENESCOUT_STRICT_WRITES: "0" }), "standard");
  assert.equal(writeClassifierSetting({ SCENESCOUT_STRICT_WRITES: "" }), "standard");
  assert.throws(() => writeClassifierSetting({ SCENESCOUT_STRICT_WRITES: "yes please" }), /SCENESCOUT_STRICT_WRITES must be 1 or 0/);
  assert.equal(refuseDestructiveGetsSetting({}), false);
  assert.equal(refuseDestructiveGetsSetting({ SCENESCOUT_REFUSE_DESTRUCTIVE_GETS: "on" }), true);
  assert.throws(() => refuseDestructiveGetsSetting({ SCENESCOUT_REFUSE_DESTRUCTIVE_GETS: "2" }), /SCENESCOUT_REFUSE_DESTRUCTIVE_GETS/);
});

test("RouteGuard: the strict classifier and destructive page loads apply only when turned on", async () => {
  // A camelCase delete goes out in read-only with the standard classifier, and is refused with the strict one.
  assert.equal(await guardRig("read-only").send("POST", "/api/deleteUser", { body: "{}" }).done, "fallback");
  assert.equal(await guardRig("read-only", { classifier: "strict" }).send("POST", "/api/deleteUser", { body: "{}" }).done, "fulfill 403");
  // The contrast the other way: the noun phrase the standard classifier refuses goes out with the strict one.
  assert.equal(await guardRig("read-only").send("POST", "/api/delete-requests", { body: "{}" }).done, "fulfill 403");
  assert.equal(await guardRig("read-only", { classifier: "strict" }).send("POST", "/api/delete-requests", { body: "{}" }).done, "fallback");
  // A link to /items/3/delete is followed unless destructive page loads are refused, and only in observe and read-only.
  assert.equal(await guardRig("read-only").send("GET", "/items/3/delete", { type: "document" }).done, "fallback");
  for (const rule of ["observe", "read-only"] as const) {
    const { calls, guard, send } = guardRig(rule, { refuseGets: true });
    assert.equal(await send("GET", "/items/3/delete", { type: "document" }).done, "abort blockedbyclient", rule);
    // The navigation that asked for it is told once, so it reports the refusal rather than a failed load.
    assert.equal(guard.tookRefusedLoad("https://app.example.com/items/3/delete"), true);
    assert.equal(guard.tookRefusedLoad("https://app.example.com/items/3/delete"), false);
    assert.equal(calls[0], `noteBlocked GET https://app.example.com/items/3/delete answered=false why=${DESTRUCTIVE_GET_REFUSAL}`);
    assert.equal(await send("GET", "/blog/archive", { type: "document" }).done, "fallback", `${rule}: a listing page`);
    assert.equal(await send("GET", "/items/3/delete", { type: "fetch" }).done, "fallback", `${rule}: a script's GET is not a page load`);
  }
  assert.equal(await guardRig("safe-write", { refuseGets: true }).send("GET", "/items/3/delete", { type: "document" }).done, "fallback");
});

test("the block notice explains a refused destructive page load as that, not as an embed's write", () => {
  const notice = new BlockNotices().notice("read-only", [{ sig: "GET https://app.example.com/items/3/delete", late: false, why: DESTRUCTIVE_GET_REFUSAL }]);
  assert.match(notice, /A page load whose address names a destructive command/);
  assert.doesNotMatch(notice, /embedded in the page/);
});

test("fuzz: the strict classifier misses less and flags less than the standard one, and misses nothing the standard one catches", () => {
  const cases = fuzzCases(4000, 548);
  const standard = fuzzRates(cases, "standard");
  const strict = fuzzRates(cases, "strict");
  assert.ok(strict.missRate < standard.missRate / 4, `strict misses ${strict.missRate}, standard ${standard.missRate}`);
  assert.ok(strict.falseAlarmRate < standard.falseAlarmRate, `strict flags ${strict.falseAlarmRate}, standard ${standard.falseAlarmRate}`);
  // Its residue is only the shapes written to be beyond it: a verb no list names, and a verb used as a noun.
  assert.deepEqual(Object.keys(strict.missedShapes), ["verb outside every list"]);
  assert.deepEqual(Object.keys(strict.falseAlarmShapes), ["verb used as a noun"]);
  for (const c of cases)
    if (c.destructive && isDestructiveRequest(c.url, c.body, "standard"))
      assert.equal(isDestructiveRequest(c.url, c.body, "strict"), true, `strict misses what standard catches: ${c.url} ${c.body}`);
});

// ── The guided plan's gate on scout_attach (ADR 24) ─────────────────────────

test("guided gate: with no guided plan built, attach is as it always was, in every mode", () => {
  const none = new GuidedPlans();
  for (const mode of ["observe", "read-only", "safe-write", "destructive"] as const)
    assert.deepEqual(guidedAttachVerdict(none, { mode, url: "https://staging.example.com" }), { ok: true }, mode);
});

test("guided gate: an unaccepted plan, or an attach without the open plan's id, cannot go above observe", () => {
  const REMOTE = "https://staging.example.com";
  const plans = new GuidedPlans();
  const built = guidedPlan({ address: REMOTE, areas: ["forms"], care: "may-create-test-data" });
  assert.ok(built.ok);
  const p = plans.add(built.plan);
  const above = ["read-only", "safe-write", "destructive"] as const;
  // Unaccepted: only observe, with or without its id.
  for (const mode of above) {
    const withId = guidedAttachVerdict(plans, { planId: p.planId, mode, url: REMOTE });
    assert.ok(!withId.ok && /needs the person's confirmation/.test(withId.why), `${mode} with the unaccepted plan's id`);
    const without = guidedAttachVerdict(plans, { mode, url: REMOTE });
    assert.ok(!without.ok && /must name it/.test(without.why), `${mode} without an id`);
  }
  assert.equal(guidedAttachVerdict(plans, { planId: p.planId, mode: "observe", url: REMOTE }).ok, true);
  assert.equal(guidedAttachVerdict(plans, { mode: "observe", url: REMOTE }).ok, true, "looking only never needs a plan");

  // Accepted: up to the plan's own mode, on its own site, and only with its id.
  plans.accept(p.planId, confirmVerdict(p, { kind: "accepted", content: { answer: "yes", code: "1234" } }, "1234"));
  for (const mode of ["read-only", "safe-write"] as const)
    assert.equal(guidedAttachVerdict(plans, { planId: p.planId, mode, url: `${REMOTE}/start` }).ok, true, mode);
  for (const mode of above) assert.equal(guidedAttachVerdict(plans, { mode, url: REMOTE }).ok, false, `${mode} still needs the id once accepted`);
  const over = guidedAttachVerdict(plans, { planId: p.planId, mode: "destructive", url: REMOTE });
  assert.ok(!over.ok && /"safe-write" at most/.test(over.why), "never above the plan's mode");
  for (const url of ["https://live.example.com", "http://staging.example.com", "https://staging.example.com:8443", "not a url"]) {
    const elsewhere = guidedAttachVerdict(plans, { planId: p.planId, mode: "read-only", url });
    assert.ok(!elsewhere.ok && /must be on that site/.test(elsewhere.why), url);
  }
  // An id the server does not hold is refused in any mode, and is not repeated when it is not a plan id's shape.
  for (const planId of ["gp-zzzzzzzzzz", "secret-value"]) {
    const unknown = guidedAttachVerdict(plans, { planId, mode: "observe", url: REMOTE });
    assert.ok(!unknown.ok && /holds no guided plan/.test(unknown.why), planId);
    assert.ok(!unknown.ok && !unknown.why.includes("secret-value"));
  }
});

test("guided gate: a plan that needs no confirmation goes up to its own mode, and another plan's id cannot lift a stricter one", () => {
  const LOCAL = "http://localhost:3000";
  const plans = new GuidedPlans();
  const forms = guidedPlan({ address: LOCAL, areas: ["forms"], care: "may-submit-forms" });
  const look = guidedPlan({ address: LOCAL, areas: ["forms"], care: "look-only" });
  assert.ok(forms.ok && look.ok);
  const f = plans.add(forms.plan);
  const l = plans.add(look.plan);
  assert.equal(f.confirm, null);
  assert.equal(guidedAttachVerdict(plans, { planId: f.planId, mode: "read-only", url: LOCAL }).ok, true);
  assert.equal(guidedAttachVerdict(plans, { planId: f.planId, mode: "safe-write", url: LOCAL }).ok, false);
  assert.equal(guidedAttachVerdict(plans, { planId: l.planId, mode: "read-only", url: LOCAL }).ok, false, "Look only is observe");
  assert.equal(guidedAttachVerdict(plans, { planId: l.planId, mode: "observe", url: LOCAL }).ok, true);
});

test("guided gate: while a guided plan is open, readPosts and trustedEmbeds are refused, so observe cannot be loosened into sending POSTs", () => {
  const REMOTE = "https://staging.example.com";
  const none = new GuidedPlans();
  // With no plan built, the developer settings are taken as before.
  assert.equal(guidedAttachVerdict(none, { mode: "observe", url: REMOTE, readPosts: ["POST /api/things"] }).ok, true);
  const plans = new GuidedPlans();
  const look = guidedPlan({ address: REMOTE, areas: ["forms"], care: "look-only" });
  const make = guidedPlan({ address: REMOTE, areas: ["forms"], care: "may-create-test-data" });
  assert.ok(look.ok && make.ok);
  const l = plans.add(look.plan);
  const m = plans.add(make.plan);
  plans.accept(m.planId, confirmVerdict(m, { kind: "accepted", content: { answer: "yes", code: "1234" } }, "1234"));
  for (const planId of [undefined, l.planId]) {
    const r = guidedAttachVerdict(plans, { planId, mode: "observe", url: REMOTE, readPosts: ["POST /api/things"] });
    assert.ok(!r.ok && /readPosts/.test(r.why), `observe with readPosts, plan ${planId}`);
    // An empty list asks for nothing.
    assert.equal(guidedAttachVerdict(plans, { planId, mode: "observe", url: REMOTE, readPosts: [] }).ok, true);
  }
  const t = guidedAttachVerdict(plans, { planId: m.planId, mode: "safe-write", url: REMOTE, trustedEmbeds: ["https://pay.example.com"] });
  assert.ok(!t.ok && /trustedEmbeds/.test(t.why), "safe-write with trusted embeds under an accepted plan");
});

test("guided gate: while a guided plan is open, the environment's read POSTs are ignored too, so observe stays observe", () => {
  const REMOTE = "https://staging.example.com";
  const ENV = "POST /api/search, POST /api/reports/query";
  // With no plan built, the attach takes the environment's list, as it always has.
  const none = guidedAttachVerdict(new GuidedPlans(), { mode: "observe", url: REMOTE });
  assert.ok(none.ok);
  assert.deepEqual(readPostsSetting(none.readPosts, ENV), ["POST /api/search", "POST /api/reports/query"]);
  // Once one is built, the attach passes an empty list, which wins over SCENESCOUT_READ_POSTS, with the plan's id or without.
  const plans = new GuidedPlans();
  const look = guidedPlan({ address: REMOTE, areas: ["forms"], care: "look-only" });
  const forms = guidedPlan({ address: "http://localhost:3000", areas: ["forms"], care: "may-submit-forms" });
  assert.ok(look.ok && forms.ok);
  const l = plans.add(look.plan);
  const f = plans.add(forms.plan);
  for (const [planId, mode, url] of [
    [undefined, "observe", REMOTE],
    [l.planId, "observe", REMOTE],
    [f.planId, "read-only", "http://localhost:3000"],
  ] as const) {
    const r = guidedAttachVerdict(plans, { planId, mode, url });
    assert.ok(r.ok, `${planId} ${mode}`);
    assert.deepEqual(readPostsSetting(r.readPosts, ENV), [], `${planId} ${mode}: the environment's list is not read`);
  }
});

test("guided gate: while a guided plan is open, the operator's sign-in list is not read, so it cannot loosen observe (#549)", () => {
  const plans = new GuidedPlans();
  assert.equal(
    "operatorAuthPosts" in guidedAttachVerdict(plans, { mode: "observe", url: "https://staging.example.com" }),
    false,
    "no plan: the attach reads it",
  );
  const built = guidedPlan({ address: "https://staging.example.com", areas: ["forms"], care: "look-only" });
  assert.ok(built.ok);
  const p = plans.add(built.plan);
  const verdict = guidedAttachVerdict(plans, { planId: p.planId, mode: "observe", url: "https://staging.example.com" });
  assert.ok(verdict.ok);
  assert.equal(verdict.operatorAuthPosts, false);
});

test("guided gate: an accepted plan is spent when no session carries it any more, so a later check asks again", () => {
  const REMOTE = "https://staging.example.com";
  const plans = new GuidedPlans();
  const built = guidedPlan({ address: REMOTE, areas: ["forms"], care: "may-create-test-data" });
  assert.ok(built.ok);
  const p = plans.add(built.plan);
  plans.accept(p.planId, confirmVerdict(p, { kind: "accepted", content: { answer: "yes", code: "1234" } }, "1234"));
  const holds = new Map<string, { planId?: string }>();
  // Two sessions carry it; one leaving keeps it, re-attaching the same session with it keeps it.
  holdGuidedPlan(holds, plans, "default", p.planId);
  holdGuidedPlan(holds, plans, "phone", p.planId);
  holdGuidedPlan(holds, plans, "default", p.planId);
  holdGuidedPlan(holds, plans, "phone", undefined);
  assert.equal(guidedAttachVerdict(plans, { planId: p.planId, mode: "safe-write", url: REMOTE }).ok, true, "still carried by default");
  // The last session carrying it re-attaches without it: spent.
  holdGuidedPlan(holds, plans, "default", undefined);
  const after = guidedAttachVerdict(plans, { planId: p.planId, mode: "safe-write", url: REMOTE });
  assert.ok(!after.ok && /needs the person's confirmation/.test(after.why), "spent once nothing carries it");
  assert.equal(plans.get(p.planId)!.confirm!.accepted, false);

  // Closing the last session carrying it spends it too.
  const builtQ = guidedPlan({ address: REMOTE, areas: ["forms"], care: "may-create-test-data" });
  assert.ok(builtQ.ok);
  const q = plans.add(builtQ.plan);
  plans.accept(q.planId, confirmVerdict(q, { kind: "accepted", content: { answer: "yes", code: "1234" } }, "1234"));
  holdGuidedPlan(holds, plans, "lane-a", q.planId);
  holdGuidedPlan(holds, plans, "lane-a", null);
  assert.equal(holds.has("lane-a"), false, "null forgets the session");
  assert.equal(guidedAttachVerdict(plans, { planId: q.planId, mode: "read-only", url: REMOTE }).ok, false);
  // A plan accepted but never attached with is not spent by an unrelated session closing.
  const builtR = guidedPlan({ address: REMOTE, areas: ["forms"], care: "may-create-test-data" });
  assert.ok(builtR.ok);
  const r = plans.add(builtR.plan);
  plans.accept(r.planId, confirmVerdict(r, { kind: "accepted", content: { answer: "yes", code: "1234" } }, "1234"));
  holdGuidedPlan(holds, plans, "other", undefined);
  holdGuidedPlan(holds, plans, "other", null);
  assert.equal(guidedAttachVerdict(plans, { planId: r.planId, mode: "safe-write", url: REMOTE }).ok, true);
});

// ── the operator's config file (engine/project-config.ts, issue #546) ──────────

const loadedOf = (policy: Policy, source = "/srv/.scenescout/config.json"): LoadedPolicy => ({ policy, sources: [source] });
const DEFAULTS = { mode: "read-only" as const, evidence: () => "inline" as const };
const parsed = (text: string): Policy => {
  const r = parsePolicy(text, "config.json");
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.policy;
};

test("config: a file is checked whole, and an unknown key or a bad value is refused naming it", () => {
  const refused: Array<[string, RegExp]> = [
    ['{"maxMod": "observe"}', /unknown key "maxMod"\. The keys are/],
    ['{"maxMode": "observe", "egres": "none", "x": 1}', /unknown keys "egres", "x"/],
    ['{"maxMode": "read only"}', /"maxMode" must be one of "observe", "read-only", "safe-write", "destructive", not "read only"/],
    ['{"preset": "paranoid"}', /"preset" must be one of "strict"/],
    ['{"requireGuidedPlan": "yes"}', /"requireGuidedPlan" must be true or false/],
    ['{"readPosts": "POST /api/search"}', /"readPosts" must be a list of strings/],
    ['{"readPosts": ["GET /api/search"]}', /"readPosts" has entries that are not valid: "GET \/api\/search"/],
    ['{"trustedEmbeds": ["https://pay.example.com/checkout"]}', /"trustedEmbeds" has entries that are not valid/],
    ['{"dedup": "model"}', /"dedup" must be one of "rule", "judge"/],
    ['{"evidence": "inline-only"}', /"evidence" must be one of "inline", "file", "off"/],
    ["[]", /must be a JSON object/],
    ["{maxMode: observe}", /not valid JSON/],
  ];
  for (const [text, why] of refused) {
    const r = parsePolicy(text, "config.json");
    assert.equal(r.ok, false, text);
    if (!r.ok) {
      assert.match(r.error, why, text);
      assert.ok(r.error.startsWith("config.json: "), `names the file: ${r.error}`);
    }
  }
  // The contrast: the same keys spelled right are taken as written.
  assert.deepEqual(parsed('{"maxMode": "observe", "readPosts": ["POST /api/search"], "trustedEmbeds": ["https://pay.example.com"]}'), {
    maxMode: "observe",
    readPosts: ["POST /api/search"],
    trustedEmbeds: ["https://pay.example.com"],
  });
  assert.deepEqual(parsed("{}"), {}, "an empty file sets nothing");
});

test("config: the strict preset expands to every lock, and a key beside it replaces the preset's value", () => {
  assert.deepEqual(parsed('{"preset": "strict"}'), {
    maxMode: "observe",
    requireGuidedPlan: true,
    readPosts: [],
    trustedEmbeds: [],
    dedup: "rule",
    evidence: "file",
    uploads: "fixtures",
  });
  const loosened = parsed('{"preset": "strict", "maxMode": "read-only", "readPosts": ["POST /api/search"]}');
  assert.equal(loosened.maxMode, "read-only");
  assert.deepEqual(loosened.readPosts, ["POST /api/search"]);
  assert.equal(loosened.dedup, "rule", "the keys not named keep the preset's value");
  // The preset object is not shared: one file's edit is not the next file's preset.
  assert.equal(PRESET_POLICY.strict.maxMode, "observe");
  assert.deepEqual(PRESET_POLICY.strict.readPosts, []);
});

test("config: no file leaves every argument as it was, and the same arguments under a file are refused or capped", () => {
  const asked = {
    mode: "destructive" as const,
    readPosts: ["POST /api/search"],
    trustedEmbeds: ["https://pay.example.com"],
    dedup: "judge" as const,
    evidence: "inline" as const,
  };
  const free = resolveSettings(NO_POLICY, {}, asked, DEFAULTS);
  assert.deepEqual(free.refused, []);
  assert.deepEqual(free.notes, []);
  assert.deepEqual(free.settings, { ...asked, requireGuidedPlan: false });
  const none = resolveSettings(NO_POLICY, {}, {}, DEFAULTS);
  assert.deepEqual(none.settings, { mode: "read-only", requireGuidedPlan: false, dedup: undefined, evidence: undefined }, "nothing asked: today's defaults");

  const strict = resolveSettings(loadedOf(PRESET_POLICY.strict), {}, asked, DEFAULTS);
  assert.deepEqual(
    strict.refused.map((r) => r.key),
    ["mode", "readPosts", "trustedEmbeds", "dedup", "evidence"],
  );
  const text = refusalText(loadedOf(PRESET_POLICY.strict), strict.refused);
  assert.match(text, /^refused by the SceneScout config \(\/srv\/\.scenescout\/config\.json\): mode "destructive" is above the config's maxMode "observe"/);
  assert.match(text, /only they can change it/);
});

test("config: maxMode refuses an argument above it, takes one at or below it, and lowers a default above it", () => {
  const cases: Array<[WriteMode, WriteMode | undefined, { refused: boolean; mode?: WriteMode; note?: boolean }]> = [
    ["observe", "read-only", { refused: true }],
    ["observe", "observe", { refused: false, mode: "observe" }],
    ["observe", undefined, { refused: false, mode: "observe", note: true }],
    ["read-only", "read-only", { refused: false, mode: "read-only" }],
    ["read-only", undefined, { refused: false, mode: "read-only" }],
    ["read-only", "safe-write", { refused: true }],
    ["safe-write", "destructive", { refused: true }],
    ["safe-write", "observe", { refused: false, mode: "observe" }],
    ["destructive", "destructive", { refused: false, mode: "destructive" }],
  ];
  for (const [max, mode, want] of cases) {
    const r = resolveSettings(loadedOf({ maxMode: max }), {}, { mode }, DEFAULTS);
    const label = `maxMode ${max}, asked ${mode ?? "(nothing)"}`;
    assert.equal(r.refused.length > 0, want.refused, label);
    if (want.refused) assert.match(r.refused[0].why, new RegExp(`mode "${mode}" is above the config's maxMode "${max}"`), label);
    else assert.equal(r.settings.mode, want.mode, label);
    assert.equal(r.notes.length > 0, want.note === true, label);
  }
});

test("config: a list the file sets is the most an argument may name, and what an attach gets when it names none", () => {
  const file = loadedOf({ readPosts: ["POST /api/search", "POST /api/reports/*/query"], trustedEmbeds: ["https://pay.example.com"] });
  const subset = resolveSettings(file, {}, { readPosts: ["post  /api/search/"], trustedEmbeds: ["https://pay.example.com/"] }, DEFAULTS);
  assert.deepEqual(subset.refused, [], "the same entries in another spelling are inside the list");
  assert.deepEqual(subset.settings.readPosts, ["post  /api/search/"]);
  const outside = resolveSettings(file, {}, { readPosts: ["POST /api/search", "POST /api/orders"], trustedEmbeds: ["https://evil.example.com"] }, DEFAULTS);
  assert.deepEqual(
    outside.refused.map((r) => r.key),
    ["readPosts", "trustedEmbeds"],
  );
  assert.match(outside.refused[0].why, /"POST \/api\/orders" is not among them/);
  const omitted = resolveSettings(file, {}, {}, DEFAULTS);
  assert.deepEqual(omitted.settings.readPosts, ["POST /api/search", "POST /api/reports/*/query"]);
  assert.deepEqual(omitted.settings.trustedEmbeds, ["https://pay.example.com"]);
  // An empty list allows none: even one entry is refused, and nothing asked is none rather than the environment's.
  const locked = loadedOf({ readPosts: [], trustedEmbeds: [] });
  const one = resolveSettings(locked, {}, { readPosts: ["POST /api/search"] }, DEFAULTS);
  assert.match(one.refused[0].why, /the config allows no readPosts/);
  const env = resolveSettings(locked, { SCENESCOUT_READ_POSTS: "POST /api/search" }, {}, DEFAULTS);
  assert.deepEqual(env.settings.readPosts, [], "the environment cannot add what the file leaves out");
  assert.match(env.notes.join(" "), /SCENESCOUT_READ_POSTS entries the config does not list were left out: "POST \/api\/search"/);
  // The environment may narrow the file's list.
  const narrowed = resolveSettings(file, { SCENESCOUT_READ_POSTS: "POST /api/search, POST /api/orders" }, {}, DEFAULTS);
  assert.deepEqual(narrowed.settings.readPosts, ["POST /api/search"]);
});

test("config: dedup rule refuses the judge from an argument and turns it off from the environment", () => {
  const rule = loadedOf({ dedup: "rule" });
  const asked = resolveSettings(rule, {}, { dedup: "judge" }, DEFAULTS);
  assert.match(asked.refused[0]?.why ?? "", /dedup "judge" is above the config's dedup "rule"/);
  const env = resolveSettings(rule, { SCENESCOUT_DEDUP: "judge" }, {}, DEFAULTS);
  assert.deepEqual(env.refused, []);
  assert.equal(env.settings.dedup, "rule", "set, so an earlier attach's choice is replaced too");
  assert.match(env.notes.join(" "), /SCENESCOUT_DEDUP=judge is above the config's dedup "rule"/);
  // The contrast: a file allowing the judge leaves the choice where it was.
  const judge = resolveSettings(loadedOf({ dedup: "judge" }), {}, { dedup: "judge" }, DEFAULTS);
  assert.deepEqual(judge.refused, []);
  assert.equal(judge.settings.dedup, "judge");
  assert.equal(resolveSettings(loadedOf({ dedup: "judge" }), {}, {}, DEFAULTS).settings.dedup, undefined);
});

test("config: evidence caps what a finding's picture may do, refusing an argument above it and lowering a default", () => {
  const file = loadedOf({ evidence: "file" });
  assert.match(resolveSettings(file, {}, { evidence: "inline" }, DEFAULTS).refused[0]?.why ?? "", /evidence "inline" is above the config's evidence "file"/);
  assert.equal(resolveSettings(file, {}, { evidence: "off" }, DEFAULTS).settings.evidence, "off");
  const lowered = resolveSettings(file, {}, {}, DEFAULTS);
  assert.equal(lowered.settings.evidence, "file");
  assert.match(lowered.notes.join(" "), /"inline" is above the config's evidence/);
  // A default already at or below the cap is left to the usual rule.
  assert.equal(resolveSettings(file, {}, {}, { ...DEFAULTS, evidence: () => "file" }).settings.evidence, undefined);
  assert.equal(resolveSettings(loadedOf({ evidence: "off" }), {}, { evidence: "file" }, DEFAULTS).refused.length, 1);
});

test("config: the project's own file can tighten the operator's and never loosen it", () => {
  const operator: Policy = { maxMode: "read-only", readPosts: ["POST /api/search", "POST /api/query"], dedup: "judge" };
  const project: Policy = {
    maxMode: "destructive",
    readPosts: ["POST /api/search", "POST /api/orders"],
    dedup: "rule",
    requireGuidedPlan: false,
    evidence: "inline",
  };
  assert.deepEqual(tightenPolicy(operator, project), {
    maxMode: "read-only",
    readPosts: ["POST /api/search"],
    dedup: "rule",
    requireGuidedPlan: false,
    evidence: "inline",
  });
  assert.equal(tightenPolicy({ requireGuidedPlan: true }, { requireGuidedPlan: false }).requireGuidedPlan, true);
  assert.equal(tightenPolicy({ maxMode: "safe-write" }, { maxMode: "observe" }).maxMode, "observe");
  assert.deepEqual(tightenPolicy({}, {}), {});
});

test("config: read from SCENESCOUT_CONFIG, else the launch directory, and the project's file joins it", () => {
  // Paths are built the way the code builds them, so the stand-in disk answers on Windows too.
  const at = (dir: string): string => path.join(dir, ".scenescout", "config.json");
  const etc = path.resolve("/etc/scenescout.json");
  const files = new Map<string, string>([
    [at("/srv"), '{"maxMode": "read-only"}'],
    [etc, '{"preset": "strict"}'],
    [at("/work/app"), '{"maxMode": "observe"}'],
    [at("/work/bad"), '{"maxmode": "observe"}'],
  ]);
  const fsx = { exists: (f: string) => files.has(f), read: (f: string) => files.get(f)!, realpath: (f: string) => f };
  const launched = readLaunchPolicy({}, "/srv", fsx);
  assert.ok(launched.ok);
  assert.deepEqual(launched.loaded, { policy: { maxMode: "read-only" }, sources: [at("/srv")] });
  const named = readLaunchPolicy({ SCENESCOUT_CONFIG: etc }, "/srv", fsx);
  assert.ok(named.ok && named.loaded.policy.maxMode === "observe" && named.loaded.sources[0] === etc, "the named file, not the launch directory's");
  assert.deepEqual(readLaunchPolicy({}, "/elsewhere", fsx), { ok: true, loaded: NO_POLICY }, "no file: no config");
  for (const [value, why] of [
    ["relative.json", /must be an absolute path/],
    ["/etc/none.json", /which is not there/],
  ] as const) {
    const r = readLaunchPolicy({ SCENESCOUT_CONFIG: value }, "/srv", fsx);
    assert.ok(!r.ok && why.test(r.error), value);
  }
  const joined = withProjectPolicy(launched.loaded, "/work/app", fsx);
  assert.ok(joined.ok);
  assert.deepEqual(joined.loaded, { policy: { maxMode: "observe" }, sources: [at("/srv"), at("/work/app")] });
  const same = withProjectPolicy(launched.loaded, "/srv", fsx);
  assert.ok(same.ok && same.loaded.sources.length === 1, "the operator's own file is not read twice");
  const bad = withProjectPolicy(launched.loaded, "/work/bad", fsx);
  assert.ok(!bad.ok && /unknown key "maxmode"/.test(bad.error));
  assert.deepEqual(withProjectPolicy(launched.loaded, "/work/none", fsx), { ok: true, loaded: launched.loaded });
});

test("config: a command's --mode and --dedup are capped the same way, and a flag above the file stops it", () => {
  const file = loadedOf({ maxMode: "observe", dedup: "rule" });
  const flag = applyToCommand(file, {}, ["http://localhost:3000", "--mode", "read-only"], { mode: "read-only" });
  assert.ok(!flag.ok && /mode "read-only" is above the config's maxMode "observe"/.test(flag.error));
  const eq = applyToCommand(file, {}, ["http://localhost:3000", "--mode=read-only"], { mode: "read-only" });
  assert.equal(eq.ok, false, "--mode=value is a flag too");
  const dflt = applyToCommand(file, {}, ["http://localhost:3000"], { mode: "read-only", dedup: "judge" });
  assert.ok(dflt.ok);
  assert.equal(dflt.mode, "observe");
  assert.equal(dflt.dedup, "rule", "ci's default judge is turned off by the file");
  assert.match(dflt.note, /^Config: \/srv\/\.scenescout\/config\.json; /);
  const judge = applyToCommand(file, {}, ["http://localhost:3000", "--dedup", "judge", "--mode", "observe"], { mode: "observe", dedup: "judge" });
  assert.ok(!judge.ok && /dedup "judge"/.test(judge.error));
  // Said once, when the environment asked for the judge too.
  const envJudge = applyToCommand(file, { SCENESCOUT_DEDUP: "judge" }, [], { mode: "observe", dedup: "judge" });
  assert.ok(envJudge.ok && envJudge.note.split("; ").filter((n) => n.startsWith("dedup ")).length === 1, envJudge.ok ? envJudge.note : envJudge.error);
  // A command reads POST endpoints from the environment only: the file's list is what it gets, narrowed by the environment.
  const posts = loadedOf({ readPosts: ["POST /api/search"] });
  const fromEnv = applyToCommand(posts, { SCENESCOUT_READ_POSTS: "POST /api/search, POST /api/orders" }, [], { mode: "read-only" });
  assert.ok(fromEnv.ok);
  assert.deepEqual(fromEnv.readPosts, ["POST /api/search"]);
  assert.equal(dflt.readPosts, undefined, "no list in the file: the environment as it is");
  // No file: the flags as given, and nothing said.
  assert.deepEqual(applyToCommand(NO_POLICY, {}, ["--mode", "destructive"], { mode: "destructive", dedup: "judge" }), {
    ok: true,
    mode: "destructive",
    dedup: "judge",
    note: "",
  });
});

test("config: requireGuidedPlan opens the guided gate before any plan is built, and says the config asked for it", () => {
  const REMOTE = "https://staging.example.com";
  const plain = new GuidedPlans();
  assert.equal(guidedAttachVerdict(plain, { mode: "read-only", url: REMOTE }).ok, true, "without it, no plan built: no gate");
  const required = new GuidedPlans();
  required.require();
  assert.equal(required.open, true);
  const refused = guidedAttachVerdict(required, { mode: "read-only", url: REMOTE });
  assert.ok(
    !refused.ok && /requires a guided plan \(requireGuidedPlan\)/.test(refused.why) && /build one with scout_guided_plan/.test(refused.why),
    JSON.stringify(refused),
  );
  assert.equal(guidedAttachVerdict(required, { mode: "observe", url: REMOTE }).ok, true, "looking only needs no plan");
  const posts = guidedAttachVerdict(required, { mode: "observe", url: REMOTE, readPosts: ["POST /api/search"] });
  assert.ok(!posts.ok && /readPosts/.test(posts.why));
});

test("config: a key set twice is refused, however it is spelt, since the first value would read as the lock", () => {
  for (const text of [
    '{"maxMode": "observe", "maxMode": "destructive"}',
    '{"maxMode": "observe", "max\\u004dode": "destructive"}',
    '{"preset": "strict", "readPosts": [], "readPosts": ["POST /api/orders"]}',
  ]) {
    const r = parsePolicy(text, "config.json");
    assert.ok(!r.ok && /is set more than once/.test(r.error), `${text}: ${JSON.stringify(r)}`);
  }
  // The contrast: the same strings as list entries, or once each as keys, are not duplicates.
  assert.deepEqual(parsed('{"readPosts": ["POST /api/a", "POST /api/a"], "trustedEmbeds": []}'), {
    readPosts: ["POST /api/a", "POST /api/a"],
    trustedEmbeds: [],
  });
  assert.deepEqual(parsed('{"maxMode": "observe", "dedup": "rule"}'), { maxMode: "observe", dedup: "rule" });
});

test("config: prototype keys and other spellings of a key are unknown keys, never a way to set one", () => {
  for (const [text, key] of [
    ['{"__proto__": {"maxMode": "destructive"}}', "__proto__"],
    ['{"constructor": {"maxMode": "destructive"}}', "constructor"],
    ['{"MaxMode": "destructive"}', "MaxMode"],
    ['{"maxmode": "destructive"}', "maxmode"],
  ] as const) {
    const r = parsePolicy(text, "config.json");
    assert.ok(!r.ok && r.error.includes(`unknown key "${key}"`), `${text}: ${JSON.stringify(r)}`);
  }
  assert.equal(({} as Record<string, unknown>).maxMode, undefined, "nothing reached Object.prototype");
});

test("config: trustedEmbeds holds no more origins than an attach can trust", () => {
  const origins = Array.from({ length: 11 }, (_, i) => `https://e${i}.example.com`);
  const r = parsePolicy(JSON.stringify({ trustedEmbeds: origins }), "config.json");
  assert.ok(!r.ok && /"trustedEmbeds" may hold at most 10 entries/.test(r.error), JSON.stringify(r));
  assert.ok(parsePolicy(JSON.stringify({ trustedEmbeds: origins.slice(0, 10) }), "config.json").ok);
});

test("config: on the real filesystem, a config that is there but cannot be read stops the start instead of being skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-config-"));
  try {
    const launch = path.join(dir, "launch");
    const project = path.join(dir, "project");
    for (const d of [launch, project]) fs.mkdirSync(path.join(d, ".scenescout"), { recursive: true });
    // No file: no config, as before.
    assert.deepEqual(readLaunchPolicy({}, launch, fsPolicyReader), { ok: true, loaded: NO_POLICY });
    assert.deepEqual(withProjectPolicy(NO_POLICY, project, fsPolicyReader), { ok: true, loaded: NO_POLICY });
    // A link whose target is missing (a shared config not mounted) is a config that cannot be read, not no config.
    fs.symlinkSync(path.join(dir, "not-mounted.json"), path.join(launch, ".scenescout", "config.json"));
    const dangling = readLaunchPolicy({}, launch, fsPolicyReader);
    assert.ok(!dangling.ok && /could not be read/.test(dangling.error), JSON.stringify(dangling));
    fs.symlinkSync(path.join(dir, "not-there.json"), path.join(project, ".scenescout", "config.json"));
    const projectDangling = withProjectPolicy(NO_POLICY, project, fsPolicyReader);
    assert.ok(!projectDangling.ok && /could not be read/.test(projectDangling.error), JSON.stringify(projectDangling));
    // A link to a real file is read through.
    fs.writeFileSync(path.join(dir, "not-mounted.json"), '{"maxMode": "observe"}');
    const linked = readLaunchPolicy({}, launch, fsPolicyReader);
    assert.ok(linked.ok && linked.loaded.policy.maxMode === "observe", JSON.stringify(linked));
    // A directory, and an empty file, are not configs.
    fs.mkdirSync(path.join(dir, "a-dir"));
    const asDir = readLaunchPolicy({ SCENESCOUT_CONFIG: path.join(dir, "a-dir") }, launch, fsPolicyReader);
    assert.ok(!asDir.ok && /could not be read/.test(asDir.error), JSON.stringify(asDir));
    fs.writeFileSync(path.join(dir, "empty.json"), "");
    const empty = readLaunchPolicy({ SCENESCOUT_CONFIG: path.join(dir, "empty.json") }, launch, fsPolicyReader);
    assert.ok(!empty.ok && /not valid JSON/.test(empty.error), JSON.stringify(empty));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: a command reads the launch file, joins the project's, caps --mode and hands on the read POSTs the file allows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-command-"));
  try {
    const launch = path.join(dir, "launch");
    const project = path.join(dir, "project");
    for (const d of [launch, project]) fs.mkdirSync(path.join(d, ".scenescout"), { recursive: true });
    fs.writeFileSync(path.join(launch, ".scenescout", "config.json"), '{"maxMode": "observe", "readPosts": ["POST /api/search"]}');
    // The project's file tries to loosen: it is joined, and loosens nothing.
    fs.writeFileSync(path.join(project, ".scenescout", "config.json"), '{"maxMode": "destructive", "readPosts": ["POST /api/search", "POST /api/orders"]}');
    const env = { SCENESCOUT_READ_POSTS: "POST /api/search, POST /api/orders" };
    const capped = configureCommand(env, launch, project, ["http://localhost:3000"], { mode: "read-only" }, fsPolicyReader);
    assert.ok(capped.ok, JSON.stringify(capped));
    assert.equal(capped.mode, "observe");
    assert.equal(capped.readPostsEnv, "POST /api/search", "the environment's entries outside the file's list are left out");
    assert.match(capped.note, /left out: "POST \/api\/orders"/);
    const flag = configureCommand(env, launch, project, ["http://localhost:3000", "--mode", "read-only"], { mode: "read-only" }, fsPolicyReader);
    assert.ok(!flag.ok && /mode "read-only" is above the config's maxMode "observe"/.test(flag.error), JSON.stringify(flag));
    assert.ok(!/Do not retry/.test(flag.ok ? "" : flag.error), "a person reads a command's refusal, not an agent");
    // A project file that is not valid stops the command too.
    fs.writeFileSync(path.join(project, ".scenescout", "config.json"), '{"maxmode": "observe"}');
    const bad = configureCommand(env, launch, project, [], { mode: "observe" }, fsPolicyReader);
    assert.ok(!bad.ok && /unknown key "maxmode"/.test(bad.error));
    // No file anywhere: the options and the environment as they were.
    const none = configureCommand(env, path.join(dir, "nowhere"), path.join(dir, "nowhere"), ["--mode", "read-only"], { mode: "read-only" }, fsPolicyReader);
    assert.deepEqual(none, { ok: true, mode: "read-only", dedup: undefined, note: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: check, ci and a first look stop with exit 2 on a --mode above the file, or a file that is not valid, before anything runs", () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-cli-config-"));
  try {
    const project = path.join(dir, "project");
    fs.mkdirSync(path.join(dir, ".scenescout"), { recursive: true });
    fs.mkdirSync(path.join(project, ".scenescout"), { recursive: true });
    // The launch directory's file, and a project file that tries to loosen it.
    fs.writeFileSync(path.join(dir, ".scenescout", "config.json"), '{"maxMode": "observe", "readPosts": ["POST /api/search"]}');
    fs.writeFileSync(path.join(project, ".scenescout", "config.json"), '{"maxMode": "destructive"}');
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, '{"maxMode": "observe", "maxMode": "destructive"}');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SCENESCOUT_|ANTHROPIC_|OPENAI_)/.test(k)) env[k] = v;
    const run = (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 60_000,
      });
    const url = "http://127.0.0.1:9";
    for (const [name, args] of [
      ["check", ["check", url, "--mode", "read-only", "--project", project]],
      ["ci", ["ci", url, "--mode", "read-only", "--project", project]],
      ["a first look", [url, "--mode", "read-only"]],
    ] as const) {
      const r = run([...args]);
      assert.equal(r.status, 2, `${name}: ${r.stderr}`);
      assert.match(r.stderr, /refused by the SceneScout config \(.*config\.json\): mode "read-only" is above the config's maxMode "observe"/, name);
      const invalid = run([...args], { SCENESCOUT_CONFIG: bad });
      assert.equal(invalid.status, 2, `${name}, bad config: ${invalid.stderr}`);
      assert.match(invalid.stderr, /"maxMode" is set more than once/, name);
    }
    // No --mode: ci starts in observe and drops the read POSTs the file does not list, saying both, then stops at the missing model key.
    const lowered = run(["ci", url, "--project", project], { SCENESCOUT_READ_POSTS: "POST /api/search, POST /api/orders" });
    assert.equal(lowered.status, 2, lowered.stderr);
    assert.match(lowered.stderr, /^Config: .*config\.json.*mode "observe": the default "read-only" is above the config's maxMode/m);
    assert.match(lowered.stderr, /SCENESCOUT_READ_POSTS entries the config does not list were left out: "POST \/api\/orders"/);
    assert.doesNotMatch(lowered.stderr, /refused by the SceneScout config/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: uploads and projectsRoot are checked like every key, and the locks not enforced yet are still unknown keys", () => {
  const refused: Array<[string, RegExp]> = [
    ['{"uploads": "none"}', /"uploads" must be one of "fixtures", "project", not "none"/],
    ['{"projectsRoot": "projects"}', /"projectsRoot" must be the absolute path of a folder, not "projects"/],
    ['{"projectsRoot": ["/srv/projects"]}', /"projectsRoot" must be the absolute path of a folder/],
    // Their rule exists (writeRulesSettings), but the browser engine reads them from its environment: a key that did nothing would look like a lock.
    ['{"writeClassifier": "strict"}', /unknown key "writeClassifier"/],
    ['{"refuseDestructiveGets": true}', /unknown key "refuseDestructiveGets"/],
    ['{"authPosts": ["POST /api/login"]}', /unknown key "authPosts"/],
  ];
  for (const [text, why] of refused) {
    const r = parsePolicy(text, "config.json");
    assert.ok(!r.ok && why.test(r.error), `${text}: ${r.ok ? "taken" : r.error}`);
  }
  const root = path.resolve("/srv/projects");
  assert.deepEqual(parsed(`{"uploads": "project", "projectsRoot": ${JSON.stringify(`${root}${path.sep}`)}}`), { uploads: "project", projectsRoot: root });
  // The strict preset keeps uploads to fixtures, and a key beside it replaces that.
  assert.equal(parsed('{"preset": "strict"}').uploads, "fixtures");
  assert.equal(parsed('{"preset": "strict", "uploads": "project"}').uploads, "project");
  assert.equal(parsed('{"preset": "strict"}').projectsRoot, undefined, "no preset names a folder");
});

test("config: uploads fixtures refuses a file from disk, whatever the environment lists; project leaves it to the fence", () => {
  const fixtures = loadedOf({ uploads: "fixtures" });
  const refused = uploadRefusal(fixtures, "docs/sample.pdf");
  assert.match(
    refused ?? "",
    /^refused by the SceneScout config \(\/srv\/\.scenescout\/config\.json\): uploads "fixtures" allows only generated files, so "docs\/sample\.pdf" is not sent/,
  );
  assert.equal(uploadRefusal(fixtures, undefined), null, "a generated fixture is still sent");
  // The contrast: the same file under "project", or with no file, goes on to the upload fence as before.
  assert.equal(uploadRefusal(loadedOf({ uploads: "project" }), "docs/sample.pdf"), null);
  assert.equal(uploadRefusal(NO_POLICY, "docs/sample.pdf"), null);
  assert.equal(uploadRefusal(loadedOf(PRESET_POLICY.strict), "docs/sample.pdf") !== null, true, "the strict preset refuses it");
  // The project's own file can tighten uploads and never loosen them.
  assert.equal(tightenPolicy({ uploads: "project" }, { uploads: "fixtures" }).uploads, "fixtures");
  assert.equal(tightenPolicy({ uploads: "fixtures" }, { uploads: "project" }).uploads, "fixtures");
  assert.equal(tightenPolicy({}, { uploads: "fixtures" }).uploads, "fixtures");
});

test("config: projectsRoot holds every project folder by its real path, and only the operator's file sets it", () => {
  const p = (...parts: string[]): string => path.resolve(path.sep, ...parts);
  const root = p("srv", "projects");
  // A stand-in disk: the root and one project exist, and a link inside the root leads to the home folder.
  const real = new Map<string, string>([
    [p("srv"), p("srv")],
    [root, root],
    [p("srv", "projects", "app"), p("srv", "projects", "app")],
    [p("srv", "projects", "escape"), p("home", "me")],
    [p("srv", "projects-old"), p("srv", "projects-old")],
    [p("home"), p("home")],
    [p("home", "me"), p("home", "me")],
    [p(), p()],
  ]);
  const fsx = { exists: (f: string) => real.has(f), read: () => "", realpath: (f: string) => real.get(f) ?? f };
  const loaded = loadedOf({ projectsRoot: root });
  const allowed = [root, p("srv", "projects", "app"), p("srv", "projects", "new-site"), p("srv", "projects", "app", "sub", "..", "web")];
  for (const dir of allowed) assert.equal(projectFolderRefusal(loaded, dir, fsx), null, dir);
  const outside = [
    p("home", "me"),
    p("srv", "projects-old"),
    p("srv", "projects", ".."),
    p("srv", "projects", "escape"),
    p("srv", "projects", "escape", "deeper"),
  ];
  for (const dir of outside) {
    const why = projectFolderRefusal(loaded, dir, fsx);
    assert.match(why ?? "", /is outside the config's projectsRoot/, dir);
  }
  assert.match(projectFolderRefusal(loaded, p("srv", "projects", "escape"), fsx)!, /\(really .*me\)/, "a link out of the root names where it leads");
  assert.equal(projectFolderRefusal(NO_POLICY, p("home", "me"), fsx), null, "no root: every folder, as without a config");

  // The operator's file sets it; a project's own file naming one is refused, since the project folder is what it limits.
  const at = (dir: string): string => path.join(dir, ".scenescout", "config.json");
  const files = new Map<string, string>([[at(p("srv", "projects", "app")), JSON.stringify({ projectsRoot: p("srv", "projects", "app") })]]);
  const disk = { exists: (f: string) => files.has(f), read: (f: string) => files.get(f)!, realpath: (f: string) => f };
  const joined = withProjectPolicy(loaded, p("srv", "projects", "app"), disk);
  assert.ok(!joined.ok && /"projectsRoot" is read from the operator's config only/.test(joined.error));
  assert.equal(tightenPolicy({ projectsRoot: root }, {}).projectsRoot, root);
  assert.equal(tightenPolicy({}, { maxMode: "observe" }).projectsRoot, undefined);
});

test("config: a command's --project outside projectsRoot stops it before the project's file is read", () => {
  // Its real path: on macOS the temp folder is reached through a link, which would refuse every folder here for that reason alone.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ss-root-")));
  try {
    const launch = path.join(dir, "launch");
    const root = path.join(dir, "projects");
    fs.mkdirSync(path.join(launch, ".scenescout"), { recursive: true });
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.mkdirSync(path.join(dir, "elsewhere", ".scenescout"), { recursive: true });
    fs.writeFileSync(path.join(launch, ".scenescout", "config.json"), JSON.stringify({ projectsRoot: root }));
    // Not valid: had it been read, the refusal would be about it.
    fs.writeFileSync(path.join(dir, "elsewhere", ".scenescout", "config.json"), "{");
    const out = configureCommand({}, launch, path.join(dir, "elsewhere"), [], { mode: "read-only" }, fsPolicyReader);
    assert.ok(!out.ok && /is outside the config's projectsRoot/.test(out.error) && !/Do not retry/.test(out.error), out.ok ? "ran" : out.error);
    const inRoot = configureCommand({}, launch, path.join(root, "app"), [], { mode: "read-only" }, fsPolicyReader);
    assert.ok(inRoot.ok, inRoot.ok ? "" : inRoot.error);
    // A link inside the root that leads out of it is outside it.
    fs.symlinkSync(path.join(dir, "elsewhere"), path.join(root, "link"), "dir");
    const linked = configureCommand({}, launch, path.join(root, "link"), [], { mode: "read-only" }, fsPolicyReader);
    assert.ok(!linked.ok && /is outside the config's projectsRoot/.test(linked.error), linked.ok ? "ran" : linked.error);
    // A link whose target is not there yet leads out of the root too: it is judged by where it leads, not by its own name.
    fs.symlinkSync(path.join(dir, "not-yet"), path.join(root, "dangling"), "dir");
    for (const at of [path.join(root, "dangling"), path.join(root, "dangling", "app")]) {
      const dangling = configureCommand({}, launch, at, [], { mode: "read-only" }, fsPolicyReader);
      assert.ok(!dangling.ok && /is outside the config's projectsRoot/.test(dangling.error), `${at}: ${dangling.ok ? "ran" : dangling.error}`);
    }
    // A relative target read from the link's real folder: root/out/back leads to elsewhere/../not-there, outside the root,
    // though read from where the link is written it would be root/not-there.
    fs.symlinkSync(path.join(dir, "elsewhere"), path.join(root, "out"), "dir");
    fs.symlinkSync(path.join("..", "not-there"), path.join(dir, "elsewhere", "back"), "dir");
    const back = configureCommand({}, launch, path.join(root, "out", "back"), [], { mode: "read-only" }, fsPolicyReader);
    assert.ok(!back.ok && /is outside the config's projectsRoot/.test(back.error), back.ok ? "ran" : back.error);
    // The contrast: a dangling link whose target would be inside the root is inside it.
    fs.symlinkSync(path.join(root, "later"), path.join(root, "soon"), "dir");
    const soon = configureCommand({}, launch, path.join(root, "soon"), [], { mode: "read-only" }, fsPolicyReader);
    assert.ok(soon.ok, soon.ok ? "" : soon.error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write rules: the file and the environment each turn the strict classifier and the destructive-GET refusal on, and neither turns the other's off", () => {
  const on = { SCENESCOUT_STRICT_WRITES: "1", SCENESCOUT_REFUSE_DESTRUCTIVE_GETS: "1" };
  // Nothing set: today's defaults.
  const none = writeRulesSettings({}, {}, false);
  assert.deepEqual(none, { writeClassifier: "standard", refuseDestructiveGets: false, authPosts: null, notes: [] });
  // The file stricter than the environment: on, with the environment unset or off.
  for (const env of [{}, { SCENESCOUT_STRICT_WRITES: "0", SCENESCOUT_REFUSE_DESTRUCTIVE_GETS: "off" }]) {
    const r = writeRulesSettings({ writeClassifier: "strict", refuseDestructiveGets: true }, env, false);
    assert.equal(r.writeClassifier, "strict");
    assert.equal(r.refuseDestructiveGets, true);
  }
  // The environment stricter than the file: on, and the note says the file's value lost to it.
  const envWins = writeRulesSettings({ writeClassifier: "standard", refuseDestructiveGets: false }, on, false);
  assert.equal(envWins.writeClassifier, "strict");
  assert.equal(envWins.refuseDestructiveGets, true);
  assert.match(envWins.notes.join("; "), /writeClassifier "strict": SCENESCOUT_STRICT_WRITES is stricter than the config's "standard"/);
  assert.match(envWins.notes.join("; "), /refuseDestructiveGets: SCENESCOUT_REFUSE_DESTRUCTIVE_GETS is stricter than the config's false/);
  // The environment alone: as today.
  assert.deepEqual(writeRulesSettings({}, on, false), { writeClassifier: "strict", refuseDestructiveGets: true, authPosts: null, notes: [] });
  // An environment value that cannot be read is an error naming it, as the attach reports it today.
  assert.throws(() => writeRulesSettings({ writeClassifier: "strict" }, { SCENESCOUT_STRICT_WRITES: "yes" }, false), /SCENESCOUT_STRICT_WRITES must be 1 or 0/);
});

test("write rules: the file's authPosts is the most the environment may name, and a guided check also asks the path rule", () => {
  const file = { authPosts: ["POST /api/login", "POST https://idp.example.com/oauth/token"] };
  // The file alone: its list.
  assert.deepEqual(writeRulesSettings(file, {}, false).authPosts, { entries: file.authPosts, andSignInPath: false });
  // The environment narrower than the file: the environment's, since it is within the file's.
  const narrower = writeRulesSettings(file, { SCENESCOUT_AUTH_POSTS: "post /api/login/" }, false);
  assert.deepEqual(narrower.authPosts, { entries: ["post /api/login/"], andSignInPath: false });
  assert.deepEqual(narrower.notes, []);
  // The environment naming more than the file: what it adds is left out, and said so.
  const wider = writeRulesSettings(file, { SCENESCOUT_AUTH_POSTS: "POST /api/login, POST /api/graphql" }, false);
  assert.deepEqual(wider.authPosts?.entries, ["POST /api/login"]);
  assert.match(wider.notes.join("; "), /SCENESCOUT_AUTH_POSTS entries the config does not list were left out: "POST \/api\/graphql"/);
  // [] in the file allows none, whatever the environment lists.
  assert.deepEqual(writeRulesSettings({ authPosts: [] }, { SCENESCOUT_AUTH_POSTS: "POST /api/login" }, false).authPosts?.entries, []);
  // No file list: the environment's, as today; neither: the path rule.
  assert.deepEqual(writeRulesSettings({}, { SCENESCOUT_AUTH_POSTS: "POST /api/login" }, false).authPosts, {
    entries: ["POST /api/login"],
    andSignInPath: false,
  });
  assert.equal(writeRulesSettings({}, {}, true).authPosts, null, "a guided check with no list: the path rule alone, as today");
  // A guided check keeps the list, and asks the path rule as well, rather than dropping it.
  assert.deepEqual(writeRulesSettings(file, {}, true).authPosts, { entries: file.authPosts, andSignInPath: true });
  assert.deepEqual(writeRulesSettings({}, { SCENESCOUT_AUTH_POSTS: "POST /api/login" }, true).authPosts, { entries: ["POST /api/login"], andSignInPath: true });
});
