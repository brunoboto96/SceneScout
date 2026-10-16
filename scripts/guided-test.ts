/**
 * The guided assistant's start, and the cards it shows: every choice to its
 * plan, when a person must confirm before a plan starts (each rule as a
 * contrastive pair, so both directions are asserted), credentials refused in
 * the choices, the fixed wording, and a finding as a card; then the progress
 * a person watches while a check runs (phase, areas, the narrator's line and
 * story, the clicking saved with its basis), and which cards scout_cards shows
 * and what scout_feedback's export lists.
 *
 *   npm run guided-test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildGuidedPlan,
  CARE_MODE,
  confirmForm,
  confirmVerdict,
  GuidedPlans,
  guidedPlanText,
  MAX_PLANS,
  newConfirmCode,
  CARES,
  CHECK_AREAS,
  checkGuidedChoices,
  CONFIRM_NEEDS_CODE,
  confirmationReason,
  guidedObjective,
  guidedPlan,
  holdsCredential,
  isLocalAddress,
  isPlanId,
  MAX_OBJECTIVE,
  newPlanId,
  THOROUGHNESSES,
  type GuidedChoices,
  type GuidedPlan,
} from "../src/engine/guided.ts";
import {
  AREA_LABEL,
  AREA_WHAT_HAPPENS,
  CARE_EXPLAIN,
  CARE_LABEL,
  CARE_PREVIEW,
  CONFIRM_ANSWER,
  CONFIRM_ANSWER_LINE,
  CONFIRM_COMING,
  CONFIRM_FIELD,
  CONFIRM_SAYS,
  confirmCodeLine,
  confirmSentence,
  DESTRUCTIVE_NOT_OFFERED,
  HELD_BACK,
  NEEDS_YOU_SENTENCE,
  NOW_SENTENCE,
  ACTION_PROMPT,
  AREA_NOT_REACHED,
  PHASE_NOW,
  SAFETY_EXPLAINER,
  STUCK_SENTENCE,
  THOROUGHNESS_LABEL,
  ACTION_LABEL,
  ERROR_HEADING,
  ERROR_KINDS,
  SCREEN_HEADING,
} from "../src/engine/guided-words.ts";
import {
  areaStates,
  cardText,
  CLICKING_RATES,
  clickingSaved,
  feedbackCandidates,
  guidedPhase,
  guidedProgress,
  GuidedRuns,
  INLINE_PICTURE_SIDE,
  LATEST_MAX,
  MAX_CARDS,
  MAX_INLINE_PICTURES,
  nowSentence,
  pushStory,
  selectCards,
  STORY_MAX,
  stoppedByCap,
  troubleOf,
  troubleOfResult,
  troubleTell,
  type Trouble,
  type GuidedRun,
  type ProgressSession,
} from "../src/engine/progress.ts";
import { settingsFromAnswers } from "../src/intake.ts";
import { encodePng } from "../src/engine/png.ts";
import { readInlinePicture } from "../src/engine/progress.ts";
import { allowsWrite } from "../src/engine/policy.ts";
import { isReadMethod } from "../src/engine/unload.ts";
import { readyBrowser } from "../src/engine/launch.ts";
import type { Finding } from "../src/engine/memory.ts";
import { IMPACT, PLAIN_WORDING, plainCard, plainFinding, plainSteps } from "../src/engine/plain.ts";

const REMOTE = "https://staging.example.com";
const LOCAL = "http://localhost:3000";

function ok(input: unknown): GuidedChoices {
  const r = checkGuidedChoices(input);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.choices;
}

function refused(input: unknown): string {
  const r = checkGuidedChoices(input);
  assert.ok(!r.ok, `refused: ${JSON.stringify(input)}`);
  return r.error;
}

const plan = (input: Record<string, unknown>) => buildGuidedPlan(ok({ address: REMOTE, areas: ["broken-pages"], ...input }), "gp-0123456789");

// ---- The choices ----

test("choices: only the address and an area are needed; the rest take their safe defaults", () => {
  assert.deepEqual(ok({ address: REMOTE, areas: ["broken-pages"] }), {
    address: REMOTE,
    areas: ["broken-pages"],
    signIn: "none",
    care: "look-only",
    thoroughness: "normal",
  });
  assert.equal(ok({ address: `  ${REMOTE}  `, areas: ["forms"] }).address, REMOTE, "the address is trimmed");
  assert.deepEqual(ok({ address: REMOTE, areas: ["forms", "phone", "forms"] }).areas, ["forms", "phone"], "an area ticked twice counts once");
});

test("choices: a mistake is one sentence, never a half-made plan", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [[REMOTE], /must be an object/],
    [{ areas: ["forms"] }, /give the address/],
    [{ address: "staging.example.com", areas: ["forms"] }, /written in full/],
    [{ address: "ftp://staging.example.com", areas: ["forms"] }, /http:\/\/ or https:\/\//],
    [{ address: `https://example.com/${"a".repeat(2048)}`, areas: ["forms"] }, /longer than 2048/],
    [{ address: REMOTE }, /at least one thing/],
    [{ address: REMOTE, areas: [] }, /at least one thing/],
    [{ address: REMOTE, areas: ["everything"] }, /^one of the areas is not something to check/],
    [{ address: REMOTE, areas: ["journey"] }, /describe the journey/],
    [{ address: REMOTE, areas: ["journey"], journey: "   " }, /describe the journey/],
    [{ address: REMOTE, areas: ["journey"], journey: "a".repeat(501) }, /longer than 500/],
    [{ address: REMOTE, areas: ["forms"], journey: "Buy a thing" }, /"journey" is not chosen/],
    [{ address: REMOTE, areas: ["tickets"] }, /paste the tickets/],
    [{ address: REMOTE, areas: ["tickets"], tickets: ["  ", ""] }, /paste the tickets/],
    [{ address: REMOTE, areas: ["tickets"], tickets: [42] }, /paste the tickets/],
    [{ address: REMOTE, areas: ["tickets"], tickets: Array(51).fill("A ticket") }, /at most 50 tickets/],
    [{ address: REMOTE, areas: ["forms"], tickets: ["A ticket"] }, /"tickets" is not chosen/],
    [{ address: REMOTE, areas: ["forms"], signIn: "magic-link" }, /signIn must be one of none, sso, password, one-time-code/],
    [{ address: REMOTE, areas: ["forms"], care: "careful" }, /care must be one of look-only, may-submit-forms, may-create-test-data/],
    [{ address: REMOTE, areas: ["forms"], thoroughness: "max" }, /thoroughness must be one of quick, normal, thorough/],
    [{ address: REMOTE, areas: ["forms"], mode: "safe-write" }, /^the choices have a field they do not take: they are address, areas/],
  ];
  for (const [input, want] of cases) assert.match(refused(input), want, JSON.stringify(input).slice(0, 120));
});

test("choices: a refusal never repeats what was typed, not even a field's name or an area's", () => {
  const typed = "Hunter2Typed";
  for (const input of [
    { address: REMOTE, areas: [typed] },
    { address: REMOTE, areas: ["forms"], [typed]: "x" },
    { address: REMOTE, areas: ["forms"], [`${typed}Password`]: "x" },
  ])
    assert.ok(!refused(input).includes(typed), JSON.stringify(input));
});

test("choices: the level that deletes is never offered, whatever it is called", () => {
  for (const care of ["destructive"])
    assert.match(refused({ address: LOCAL, areas: ["forms"], care }), /not offered here\. Deleting data that was already there needs a developer/);
  assert.ok(!(CARES as readonly string[]).includes("destructive"));
  assert.deepEqual(new Set(Object.values(CARE_MODE)), new Set(["observe", "read-only", "safe-write"]));
});

// ---- Credentials ----

test("credentials: a field named for one is refused by its name, and its value is never repeated", () => {
  for (const key of ["password", "Password", "token", "apiKey", "api_key", "otp", "pin", "secret", "clientSecret", "accessToken"]) {
    const error = refused({ address: REMOTE, areas: ["forms"], [key]: "Hunter2-value" });
    assert.match(error, /^the choices have no field for a password, code or token: never type a password, code or token into the choices/, key);
    assert.equal(error, refused({ address: REMOTE, areas: ["forms"], password: "x" }), `${key}: the same sentence whatever the field is called`);
    assert.ok(!error.includes("Hunter2-value"), `${key}: the value is not repeated`);
  }
});

test("credentials: in the address, the journey or a ticket, refused without being quoted", () => {
  const secret = "Summer2024!x";
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ address: `https://me:${secret}@staging.example.com`, areas: ["forms"] }, /no user name or password in the address/],
    [{ address: `https://staging.example.com/start?password=${secret}`, areas: ["forms"] }, /address holds what looks like/],
    [{ address: `https://staging.example.com/start?access_token=abc123def456`, areas: ["forms"] }, /address holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: `Sign in with password: ${secret} and buy a thing` }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: `Sign in, my password is ${secret}, then buy a thing` }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: "Enter the PIN 4821 at checkout" }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: "Call the API with Bearer abcdef0123456789abcdef" }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: `Sign in; the password for it is ${secret}` }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: `Sign in with password - ${secret}` }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: `Sign in (pw: ${secret}) and buy a thing` }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: "Enter the login code 482913 when asked" }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: `Sign in as bob with ${secret} and buy a thing` }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["journey"], journey: 'Sign in with password="Summer 2024" and buy a thing' }, /journey holds what looks like/],
    [{ address: REMOTE, areas: ["tickets"], tickets: ["A fine ticket", "Use the key ghp_abcdefghijklmnop0123456789"] }, /ticket 2 holds what looks like/],
  ];
  for (const [input, want] of cases) {
    const error = refused(input);
    assert.match(error, want, JSON.stringify(input));
    assert.match(error, /a browser window opens for you to sign in/);
    for (const leak of [secret, "4821", "482913", "Summer 2024", "ghp_", "abcdef0123", "abc123def456"])
      assert.ok(!error.includes(leak), `${leak} is not repeated in: ${error}`);
  }
});

test("credentials: the near misses are ordinary sentences and pass", () => {
  // Each differs from a refused case above in the one fact that makes it a credential.
  const sentences = [
    "Check that the password is required on the sign-up form",
    "Try a wrong password and check the error message",
    "Sign up as someone@example.com and check the welcome email",
    "Reset the password and check the email that arrives",
    "Check the token expiry message after signing in",
    "Enter a PIN of the wrong length and check the error",
    "Check the password reset page",
    "Check that the login code screen loads",
    "Sign in as bob with Google and check the dashboard",
    "Sign in with the account someone@example.com and check the orders",
    "Check that the password field - on the sign-up form - is masked",
  ];
  for (const journey of sentences) {
    assert.equal(holdsCredential(journey), false, journey);
    assert.equal(ok({ address: REMOTE, areas: ["journey"], journey }).journey, journey);
  }
  assert.equal(
    ok({ address: "https://staging.example.com/start?page=2&sort=name", areas: ["forms"] }).address,
    "https://staging.example.com/start?page=2&sort=name",
  );
});

test("credentials: a value after a colon or in quotes, other languages' words, a sign-in code and a signed address are refused", () => {
  for (const text of [
    "Password: letmein",
    "password = 'letmein'",
    "Sign in (user: admin, password: admin) and open the orders",
    "pass: Tr0ub4dor&3",
    "credentials: admin / qwerty",
    "creds admin:admin123",
    "Connecte-toi avec le mot de passe Soleil2024!",
    "Inicia sesión con la contraseña Verano2024!",
    "Войдите, пароль Лето2024!",
    "Enter the two-factor code 123456",
    "Enter the 2FA code 654321",
    "Use the code 482913 to sign in",
  ])
    assert.equal(holdsCredential(text), true, text);
  for (const address of [
    "https://x.example.com/callback?code=4/0AX4XfWhabc",
    "https://x.example.com/file?X-Amz-Signature=abcdef0123456789",
    "https://x.example.com/?sig=abcdef0123456789abcdef",
    "https://x.example.com/?key=AIzaSyA1234567890abcdefghij",
    "https://x.example.com/?session=abcdef0123456789",
    "https://x.example.com/?auth=abcdef0123456789",
    "https://x.example.com/?pass=hunter2",
  ])
    assert.match(refused({ address, areas: ["forms"] }), /address holds what looks like/, address);
});

test("credentials: the near misses of those pass: a field's name before a colon, a link, a page number, a role", () => {
  for (const text of [
    "Check the error under Password: required",
    "Check the Password: label is above the box",
    "Sign in with SSO, then open https://app.example.com/reports/2024/q3",
    "Sign in with role=editor and edit post #42",
    "Sign in with your usual credentials and open the settings",
    "Check that the error code 404 page has a link home",
    "Check the mot de passe oublié link",
  ])
    assert.equal(holdsCredential(text), false, text);
  for (const address of ["https://x.example.com/products?page=2&sort=name", "https://x.example.com/search?q=shoes&lang=en"])
    assert.equal(ok({ address, areas: ["forms"] }).address, address);
});

// ---- The confirmation rule, each as a contrastive pair ----

test("confirmation: may submit forms on this computer needs none; the same choice on another address needs one", () => {
  const local = plan({ address: LOCAL, care: "may-submit-forms" });
  const remote = plan({ address: REMOTE, care: "may-submit-forms" });
  assert.equal(local.confirm, null);
  assert.deepEqual(remote.confirm, { reason: "forms-on-remote-site", sentence: confirmSentence("forms-on-remote-site", REMOTE), accepted: false });
  assert.equal(local.mode, "read-only");
  assert.equal(remote.mode, "read-only", "the confirmation changes nothing about the mode it asks for");
});

test("confirmation: only localhost, 127.0.0.1 and ::1 are on this computer; anything else is asked about", () => {
  // Numeric forms the browser itself reads as 127.0.0.1 or ::1 are the same address, so they count as local too (ADR 24).
  for (const address of [
    "http://localhost",
    "http://localhost:3000/app",
    "http://LOCALHOST:8080",
    "http://127.0.0.1:5173",
    "http://[::1]:3000",
    "http://127.1:3000",
    "http://2130706433:3000",
    "http://0x7f.0.0.1",
    "http://[0:0:0:0:0:0:0:1]:3000",
  ]) {
    assert.equal(isLocalAddress(address), true, address);
    assert.equal(confirmationReason({ care: "may-submit-forms", address }), null, address);
  }
  for (const address of [
    REMOTE,
    "http://127.0.0.2:3000",
    "http://0.0.0.0:3000",
    "http://localhost.example.com",
    "http://app.localhost:3000",
    "http://192.168.1.10:3000",
    "http://[::2]:3000",
  ]) {
    assert.equal(isLocalAddress(address), false, address);
    assert.equal(confirmationReason({ care: "may-submit-forms", address }), "forms-on-remote-site", address);
  }
});

test("confirmation: look only on another address needs none; may submit forms on the same address needs one", () => {
  assert.equal(plan({ address: REMOTE, care: "look-only" }).confirm, null);
  assert.equal(plan({ address: REMOTE, care: "may-submit-forms" }).confirm?.reason, "forms-on-remote-site");
  assert.equal(plan({ address: LOCAL, care: "look-only" }).confirm, null);
});

test("confirmation: may create test data is always confirmed, with a typed code, even on this computer", () => {
  for (const address of [LOCAL, "http://127.0.0.1:3000", REMOTE]) {
    const p = plan({ address, care: "may-create-test-data" });
    assert.equal(p.mode, "safe-write");
    assert.deepEqual(p.confirm, { reason: "creates-data", sentence: confirmSentence("creates-data", address), accepted: false }, address);
    assert.equal(CONFIRM_NEEDS_CODE[p.confirm!.reason], true);
  }
  // The pair: the same local address one care level down needs nothing.
  assert.equal(plan({ address: LOCAL, care: "may-submit-forms" }).confirm, null);
  assert.equal(CONFIRM_NEEDS_CODE["forms-on-remote-site"], false, "a form on another address needs the answer only");
});

test("plan: choices that were never checked cannot make a plan with no mode, which scout_attach would read as read-only", () => {
  const good = ok({ address: REMOTE, areas: ["forms"] });
  // A mode left undefined drops out of the attach's arguments, and scout_attach's default is read-only: a form-sending run nobody confirmed.
  for (const bad of [
    { ...good, care: "destructive" },
    { ...good, care: "MAY-CREATE-TEST-DATA" },
    { ...good, thoroughness: "forever" },
    { ...good, areas: ["everything"] },
    { ...good, signIn: "magic-link" },
  ])
    assert.throws(() => buildGuidedPlan(bad as unknown as GuidedChoices), /checkGuidedChoices/, JSON.stringify(bad));
  assert.equal(buildGuidedPlan(good).mode, "observe");
});

test("confirmation: no plan is ever built already accepted", () => {
  for (const care of CARES) for (const address of [LOCAL, REMOTE]) assert.notEqual(plan({ address, care }).confirm?.accepted, true, `${care} ${address}`);
});

// ---- Every choice to its plan ----

test("plan: each care level is its write mode, and the person is told what it does and what is coming", () => {
  for (const care of CARES) {
    const p = plan({ care });
    assert.equal(p.mode, CARE_MODE[care]);
    assert.equal(p.tellPerson[0], `${CARE_LABEL[care]}: ${CARE_EXPLAIN[care]}`);
    const attach = p.calls.find((c) => c.tool === "scout_attach")!;
    assert.equal(attach.args.mode, CARE_MODE[care], "the attach asks for exactly the care level's mode");
    if (p.confirm) assert.equal(p.tellPerson.at(-1), CONFIRM_COMING[p.confirm.reason]);
    else assert.match(p.tellPerson.at(-1)!, /^It stops after at most/);
  }
});

test("plan: each thoroughness is a report level and a stated budget", () => {
  const want = { quick: ["minimal", 10, 20], normal: ["medium", 20, 60], thorough: ["extensive", 30, 120] } as const;
  for (const t of THOROUGHNESSES) {
    const p = plan({ thoroughness: t });
    assert.equal(p.level, want[t][0]);
    assert.deepEqual(p.budget, { minutes: want[t][1], pages: want[t][2] });
    assert.ok(p.tellPerson.includes(`It stops after at most ${want[t][1]} minutes and ${want[t][2]} pages.`));
  }
});

test("plan: each area is labelled and explained, and says what the care level holds back there", () => {
  const all = ok({ address: REMOTE, areas: [...CHECK_AREAS], journey: "Buy the cheapest item and check the receipt", tickets: ["A ticket"] });
  for (const care of CARES) {
    const p = buildGuidedPlan({ ...all, care }, "gp-0123456789");
    assert.deepEqual(
      p.areas.map((a) => a.area),
      [...CHECK_AREAS],
    );
    for (const a of p.areas) {
      assert.equal(a.label, AREA_LABEL[a.area]);
      assert.equal(a.whatHappens, AREA_WHAT_HAPPENS[a.area]);
      assert.equal(a.heldBack, HELD_BACK[a.area][care]);
      if (a.heldBack) assert.ok(p.tellPerson.includes(`${a.label}: ${a.heldBack}`));
    }
  }
  // The pair the design names: sign-up is looked at but not sent in Look only, and sent once forms may be.
  const look = plan({ areas: ["sign-in", "forms"], care: "look-only" });
  const submit = plan({ areas: ["sign-in", "forms"], care: "may-submit-forms" });
  assert.match(look.areas[0].heldBack!, /Sign-up is looked at but never sent/);
  assert.match(look.areas[1].heldBack!, /never sent/);
  assert.equal(submit.areas[0].heldBack, undefined);
  assert.equal(submit.areas[1].heldBack, undefined);
  for (const area of ["broken-pages", "phone"] as const) for (const care of CARES) assert.equal(HELD_BACK[area][care], undefined, `${area} holds nothing back`);
});

test("plan: no sign-in attaches without a role; any sign-in calls scout_login first, as the plain questions do", () => {
  assert.deepEqual(plan({ signIn: "none" }).calls, [
    { tool: "scout_attach", args: { url: REMOTE, mode: "observe", objective: "Check broken pages and links.", planId: "gp-0123456789" } },
  ]);
  for (const signIn of ["sso", "password", "one-time-code"] as const) {
    const p = plan({ signIn });
    // The same login, role and sentence intake.ts gives for the same answer.
    const intake = settingsFromAnswers({ address: REMOTE, signIn, whatToCheck: "everything", realData: "yes" });
    assert.deepEqual(p.calls[0], { tool: "scout_login", args: { url: REMOTE, role: intake.login!.role } });
    assert.equal(p.calls[1].tool, "scout_attach");
    assert.equal(p.calls[1].args.role, intake.login!.role);
    assert.ok(p.tellPerson.includes(intake.login!.tellUser), signIn);
  }
});

test("plan: tickets are read once attached, each its own ticket; the phone area gets a phone-sized browser", () => {
  const p = plan({ areas: ["tickets", "phone"], tickets: ["First ticket", "Second ticket"] });
  assert.deepEqual(
    p.calls.map((c) => c.tool),
    ["scout_attach", "scout_tickets", "scout_attach"],
  );
  assert.deepEqual(p.calls[1].args, { text: "First ticket\n\n---\n\nSecond ticket" });
  assert.equal(p.calls[0].args.viewportWidth, undefined, "the first browser is desktop-sized when other areas share it");
  assert.deepEqual(
    { session: p.calls[2].args.session, w: p.calls[2].args.viewportWidth, h: p.calls[2].args.viewportHeight, mode: p.calls[2].args.mode },
    { session: "phone", w: 390, h: 844, mode: "observe" },
  );
  const phoneOnly = plan({ areas: ["phone"] });
  assert.equal(phoneOnly.calls.length, 1, "phone alone is one phone-sized browser");
  assert.deepEqual([phoneOnly.calls[0].args.viewportWidth, phoneOnly.calls[0].args.viewportHeight, phoneOnly.calls[0].args.session], [390, 844, undefined]);
});

test("plan: the objective is the journey first, then the other areas, and fits scout_attach", () => {
  assert.equal(guidedObjective({ areas: ["forms"] }), "Check forms.");
  assert.equal(guidedObjective({ areas: ["sign-in", "forms", "broken-pages"] }), "Check sign-up and sign-in, forms and broken pages and links.");
  assert.equal(guidedObjective({ areas: ["journey"], journey: "Buy the cheapest item." }), "Buy the cheapest item.");
  assert.equal(
    guidedObjective({ areas: ["journey", "phone"], journey: "Buy the cheapest item." }),
    "Buy the cheapest item. Also check: how it looks on a phone.",
  );
  assert.equal(
    guidedObjective({ areas: ["journey", "forms"], journey: "Buy the cheapest item" }),
    "Buy the cheapest item. Also check: forms.",
    "a journey without a full stop gets one before the other areas",
  );
  assert.equal(guidedObjective({ areas: ["journey"], journey: "Buy the cheapest item" }), "Buy the cheapest item", "alone, it is kept as written");
  const long = plan({ areas: ["journey", "forms"], journey: `${"Add an item and check the basket. ".repeat(14)}`.trim() });
  assert.ok(long.objective.length <= MAX_OBJECTIVE && long.objective.endsWith("…"), long.objective);
  assert.equal(long.choices.journey!.length > MAX_OBJECTIVE, true, "the journey itself is kept whole");
});

test("plan: the same choices give the same plan apart from its id", () => {
  const input = { address: REMOTE, areas: ["sign-in", "journey"], journey: "Sign up and check the welcome page", signIn: "password", care: "may-submit-forms" };
  const a = guidedPlan(input);
  const b = guidedPlan(input);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.plan.planId, b.plan.planId);
  // Each attach names its own plan, so the plan can be held to it; that is the only other difference.
  const apart = (p: GuidedPlan) => ({
    ...p,
    planId: "",
    calls: p.calls.map((c) => ({ ...c, args: { ...c.args, planId: c.args.planId === p.planId ? "" : c.args.planId } })),
  });
  assert.deepEqual(apart(a.plan), apart(b.plan));
  for (const c of a.plan.calls) if (c.tool === "scout_attach") assert.equal(c.args.planId, a.plan.planId);
  assert.deepEqual(guidedPlan({ address: REMOTE }), { ok: false, error: "choose at least one thing to check" });
});

test("plan ids: gp- and 10 characters, random, recognised by their shape", () => {
  const ids = new Set(Array.from({ length: 500 }, newPlanId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.ok(isPlanId(id), id);
  for (const bad of ["gp-0123", "gp-0123456789x", "GP-0123456789", "gp-ABCDEFGHIJ", "xx-0123456789", 42, undefined])
    assert.equal(isPlanId(bad), false, String(bad));
});

// ---- The fixed wording ----

test("wording: every care level, area and thoroughness has its words, and none reads as a developer's", () => {
  const sentences = [
    ...Object.values(CARE_LABEL),
    ...Object.values(CARE_EXPLAIN),
    ...Object.values(CARE_PREVIEW).flat(),
    ...Object.values(AREA_LABEL),
    ...Object.values(AREA_WHAT_HAPPENS),
    ...Object.values(HELD_BACK).flatMap((h) => Object.values(h)),
    ...Object.values(THOROUGHNESS_LABEL),
    ...Object.values(CONFIRM_COMING),
    ...SAFETY_EXPLAINER,
    DESTRUCTIVE_NOT_OFFERED,
    ...Object.values(NEEDS_YOU_SENTENCE).map((f) => f("staging.example.com")),
    confirmSentence("creates-data", REMOTE),
    confirmSentence("forms-on-remote-site", REMOTE),
  ];
  for (const s of sentences) {
    assert.ok(s.trim().length > 0);
    assert.doesNotMatch(s, /scout_|observe|read-only|safe-write|destructive|\bPOST\b|\bGET\b|\bHTTP\b|\bAPI\b|_/, `"${s}" is not plain`);
  }
  assert.deepEqual(Object.keys(CARE_LABEL), [...CARES]);
  assert.deepEqual(Object.keys(AREA_LABEL), [...CHECK_AREAS]);
  assert.deepEqual(Object.keys(THOROUGHNESS_LABEL), [...THOROUGHNESSES]);
  assert.match(SAFETY_EXPLAINER.join(" "), /never asks for your password/);
});

test("wording: May submit forms never claims that what was there is left untouched, because a form can change it", () => {
  // read-only lets a plain form submission through (policy.ts), and a form such as "Save profile" changes an existing record.
  const said = [
    CARE_EXPLAIN["may-submit-forms"],
    ...CARE_PREVIEW["may-submit-forms"],
    confirmSentence("forms-on-remote-site", REMOTE),
    SAFETY_EXPLAINER[1],
    CARE_EXPLAIN["may-create-test-data"],
    confirmSentence("creates-data", REMOTE),
  ];
  for (const s of said) {
    assert.doesNotMatch(
      s,
      /nothing (?:that (?:already exists|was there)|existing) is changed|never changes? or deletes? (?:anything|what) (?:that )?was there|never change or delete anything that was there|change or delete only/i,
      s,
    );
  }
  for (const s of [CARE_EXPLAIN["may-submit-forms"], confirmSentence("forms-on-remote-site", REMOTE), CARE_EXPLAIN["may-create-test-data"]])
    assert.match(s, /change (?:one|a record|records) that (?:was|were) there/, s);
});

test("wording: no care level says a form is the only way something changes, because the write policy cannot tell a form from a button", () => {
  // policy.ts judges the request, not what sent it: a plain POST a script sends
  // ("Like", "Mark as read", a settings toggle) passes exactly as a form's does.
  assert.equal(allowsWrite("read-only", "POST", false, false), true);
  assert.equal(allowsWrite("safe-write", "POST", false, false), true);
  const said = [
    ...Object.values(CARE_EXPLAIN),
    ...Object.values(CARE_PREVIEW).flat(),
    ...Object.values(HELD_BACK).flatMap((h) => Object.values(h)),
    ...SAFETY_EXPLAINER,
    DESTRUCTIVE_NOT_OFFERED,
    confirmSentence("creates-data", REMOTE),
    confirmSentence("forms-on-remote-site", REMOTE),
  ];
  for (const s of said) assert.doesNotMatch(s, /(?:other|another) (?:way )?than (?:through )?a form|any other way|a form is the one/i, s);
  // What does hold: deletes are blocked below safe-write, and limited to its own records in it.
  assert.equal(allowsWrite("read-only", "DELETE", false, false), false);
  assert.equal(allowsWrite("read-only", "POST", true, false), false);
  assert.equal(allowsWrite("safe-write", "DELETE", false, false), false);
  assert.equal(allowsWrite("safe-write", "DELETE", false, true), true);
  assert.match(CARE_EXPLAIN["may-submit-forms"], /Deletes are blocked/);
  assert.match(CARE_EXPLAIN["may-create-test-data"], /deletes only what it created/);
});

test("wording: Look only says exactly what observe lets out: page loads, so a search runs and a link that changes something when opened is not stopped", () => {
  // observe judges the method, not the page: every page load passes, a form sent by GET (a search) is a page load,
  // and a link whose page changes something just by being opened is one too. Anything else is held back.
  assert.equal(isReadMethod("GET"), true);
  assert.equal(allowsWrite("observe", "POST", false, false), false);
  assert.equal(allowsWrite("observe", "PUT", false, true), false);
  const said = [CARE_EXPLAIN["look-only"], ...CARE_PREVIEW["look-only"], SAFETY_EXPLAINER[0], ...Object.values(HELD_BACK).map((h) => h["look-only"] ?? "")];
  for (const s of said) {
    // Promises observe cannot keep: a search form is sent, and a page load can change something.
    assert.doesNotMatch(
      s,
      /never send(?:s)? a form|forms? (?:are|is) (?:filled in and checked but )?never sent|never create, change or delete anything|Nothing is sent to your site except signing in|Safe on a live site\./i,
      s,
    );
  }
  for (const s of [CARE_EXPLAIN["look-only"], SAFETY_EXPLAINER[0], CARE_PREVIEW["look-only"].join(" ")]) {
    assert.match(s, /search/i, `says a search still runs: ${s}`);
    assert.match(s, /link/i, `says a link that changes something when opened is not stopped: ${s}`);
  }
  assert.match(HELD_BACK.forms["look-only"]!, /search/i, "the forms area says which forms are still sent");
});

// ---- The person's confirmation (scout_guided_confirm) ----

const CODE = "4821";

test("confirmation: only the person's yes with the code the form showed accepts May create test data", () => {
  const p = plan({ care: "may-create-test-data" });
  const yes = (content: Record<string, unknown>) => confirmVerdict(p, { kind: "accepted", content }, CODE);
  assert.deepEqual(yes({ answer: "yes", code: CODE }), { accepted: true, outcome: "accepted", tellPerson: CONFIRM_SAYS.accepted });
  assert.equal(yes({ answer: "yes", code: ` ${CODE} ` }).accepted, true, "spaces around the code are forgiven");
  // A wrong or missing code never accepts it.
  for (const content of [
    { answer: "yes" },
    { answer: "yes", code: "" },
    { answer: "yes", code: "1234" },
    { answer: "yes", code: `${CODE}0` },
    { answer: "yes", code: "48 21" },
    { answer: "yes", code: 4821 },
  ])
    assert.deepEqual(yes(content), { accepted: false, outcome: "wrong-code", tellPerson: CONFIRM_SAYS["wrong-code"] }, JSON.stringify(content));
  // A code the server never made matches nothing, not even an empty answer.
  assert.equal(confirmVerdict(p, { kind: "accepted", content: { answer: "yes", code: "" } }, "").accepted, false);
  // Anything but the yes value is going back, whatever code comes with it.
  for (const answer of ["back", "Yes", "YES", "true", true, undefined, "Yes, it is a test copy"])
    assert.equal(yes({ answer, code: CODE }).outcome, "went-back", String(answer));
});

test("confirmation: a declined, closed, failed or absent form leaves the plan unaccepted", () => {
  for (const care of ["may-create-test-data", "may-submit-forms"] as const) {
    const p = plan({ care });
    for (const outcome of [{ kind: "unsupported" }, { kind: "declined" }, { kind: "cancelled" }, { kind: "failed", error: "timed out" }] as const) {
      const v = confirmVerdict(p, outcome, CODE);
      assert.deepEqual(v, { accepted: false, outcome: outcome.kind, tellPerson: CONFIRM_SAYS[outcome.kind] }, `${care} ${outcome.kind}`);
    }
    assert.equal(confirmVerdict(p, { kind: "accepted", content: {} }, CODE).accepted, false, "an accept with no answer is not a yes");
  }
  assert.match(CONFIRM_SAYS.unsupported, /cannot show the confirmation form/);
  for (const o of ["went-back", "wrong-code", "declined", "cancelled", "failed", "unsupported"] as const)
    assert.match(CONFIRM_SAYS[o], /has not started|Look only/, o);
});

test("confirmation: May submit forms on another site needs the yes alone; a plan that needs none is never asked", () => {
  const remote = plan({ address: REMOTE, care: "may-submit-forms" });
  assert.equal(confirmVerdict(remote, { kind: "accepted", content: { answer: "yes" } }, CODE).accepted, true);
  assert.equal(confirmVerdict(remote, { kind: "accepted", content: { answer: "back" } }, CODE).accepted, false);
  for (const p of [plan({ address: LOCAL, care: "may-submit-forms" }), plan({ care: "look-only" })]) {
    assert.equal(p.confirm, null);
    assert.equal(confirmForm(p, CODE), null, "no form for a plan that needs no confirmation");
    assert.deepEqual(confirmVerdict(p, { kind: "unsupported" }, CODE), { accepted: true, outcome: "not-needed", tellPerson: CONFIRM_SAYS["not-needed"] });
  }
});

test("confirmation form: the sentence, what the care level may do, one answer with no default, and a code field only for test data", () => {
  const create = confirmForm(plan({ care: "may-create-test-data" }), CODE)!;
  assert.ok(create.message.startsWith(confirmSentence("creates-data", REMOTE)));
  for (const line of CARE_PREVIEW["may-create-test-data"]) assert.ok(create.message.includes(line), line);
  assert.ok(create.message.includes(CODE), "the form shows the code to type");
  assert.deepEqual(Object.keys(create.requestedSchema.properties), ["answer", "code"]);
  assert.deepEqual(create.requestedSchema.required, ["answer"]);
  const answer = create.requestedSchema.properties.answer;
  assert.ok(!("default" in answer), "a held Enter key accepts nothing");
  assert.deepEqual(
    answer.oneOf.map((o) => o.title),
    [CONFIRM_ANSWER.testCopy, CONFIRM_ANSWER.back],
  );
  const forms = confirmForm(plan({ care: "may-submit-forms" }), CODE)!;
  assert.deepEqual(Object.keys(forms.requestedSchema.properties), ["answer"]);
  assert.ok(!forms.message.includes(CODE), "no code where none is asked for");
  assert.deepEqual(
    forms.requestedSchema.properties.answer.oneOf.map((o) => o.title),
    [CONFIRM_ANSWER.yes, CONFIRM_ANSWER.back],
  );
  // Form mode's subset: flat strings, and nothing a client might draw as a secret field.
  for (const [name, field] of Object.entries(create.requestedSchema.properties)) {
    assert.equal(field.type, "string", name);
    assert.ok(!("format" in field), name);
    assert.doesNotMatch(`${field.title} ${field.description}`, /password|token|secret/i, name);
  }
  for (const s of [
    confirmCodeLine(CODE),
    CONFIRM_ANSWER_LINE,
    ...Object.values(CONFIRM_SAYS),
    CONFIRM_FIELD.answer.description,
    CONFIRM_FIELD.code.description,
  ])
    assert.doesNotMatch(s, /scout_|observe|read-only|safe-write|destructive|\bPOST\b|\bGET\b|_/, `"${s}" is not plain`);
});

test("confirmation codes: four digits, fresh each time", () => {
  const codes = Array.from({ length: 200 }, newConfirmCode);
  for (const c of codes) assert.match(c, /^\d{4}$/);
  assert.ok(new Set(codes).size > 100, "codes vary");
});

// ---- The plans a server holds ----

test("plans: kept unaccepted, handed out as copies, accepted only by an accepting verdict", () => {
  const plans = new GuidedPlans();
  assert.equal(plans.open, false, "no plan built: nothing is gated");
  const p = plans.add(plan({ care: "may-create-test-data" }));
  assert.equal(plans.open, true);
  // A copy changed by a caller changes nothing kept.
  p.confirm!.accepted = true;
  assert.equal(plans.get(p.planId)!.confirm!.accepted, false);
  assert.throws(() => plans.add(p), /kept unaccepted/, "a plan arriving accepted is refused");
  assert.throws(() => plans.add(plan({ care: "look-only" })), /already kept/, "one id, one plan");
  assert.throws(() => plans.accept(p.planId, { accepted: false, outcome: "wrong-code", tellPerson: "" }), /only by a verdict that accepted it/);
  assert.equal(plans.get(p.planId)!.confirm!.accepted, false);
  const verdict = confirmVerdict(plans.get(p.planId)!, { kind: "accepted", content: { answer: "yes", code: CODE } }, CODE);
  assert.equal(plans.accept(p.planId, verdict).confirm!.accepted, true);
  assert.equal(plans.get(p.planId)!.confirm!.accepted, true);
  assert.equal(plans.get("gp-zzzzzzzzzz"), undefined);
});

test("plans: the oldest is forgotten past the cap, and the store stays open", () => {
  const plans = new GuidedPlans();
  const ids = Array.from({ length: MAX_PLANS + 1 }, () => plans.add(buildGuidedPlan(ok({ address: REMOTE, areas: ["forms"] }))).planId);
  assert.equal(plans.get(ids[0]), undefined);
  assert.ok(plans.get(ids[MAX_PLANS]));
  assert.equal(plans.open, true);
});

test("plan text: the confirmation first while it is needed, then the calls with the plan's id, the areas and the limits", () => {
  const p = plan({ care: "may-create-test-data", areas: ["forms", "sign-in"], signIn: "sso" });
  const t = guidedPlanText(p);
  for (const s of p.tellPerson) assert.ok(t.includes(`- ${s}`), s);
  const order = [
    `scout_guided_confirm {"planId":"${p.planId}"}`,
    "scout_login {",
    `scout_attach {`,
    `"planId":"${p.planId}"`,
    'scout_session {area} with it: "forms", "sign-in"',
    "at most 20 minutes and 60 pages",
  ];
  let at = -1;
  for (const part of order) {
    const i = t.indexOf(part, at + 1);
    assert.ok(i > at, `${part} comes next in:\n${t}`);
    at = i;
  }
  assert.match(t, /you cannot answer it for them/);
  const accepted = { ...p, confirm: { ...p.confirm!, accepted: true } };
  assert.doesNotMatch(guidedPlanText(accepted), /scout_guided_confirm/);
  assert.doesNotMatch(guidedPlanText(plan({ care: "look-only" })), /scout_guided_confirm|confirmed/);
});

// ---- A finding as a card ----

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "0a1b2c3d4e",
  severity: "high",
  category: "false_success",
  title: "Saving a thing says it worked when it did not",
  detail: 'The page shows "Saved".\nThe server answered with an error.',
  evidence: "POST /api/things → HTTP 500",
  url: "http://app.test/things/new?draft=1",
  state: "/things/new#abc",
  repro: ["navigate http://app.test/things/new @ http://app.test/things/new", 'click button "Save" @ http://app.test/things/new'],
  foundAt: "2026-01-01T00:00:00.000Z",
  runs: 3,
  ...over,
});

test("card: a finding's plain parts, its page as a path, and its technical detail", () => {
  const f = finding({ seenOn: ["/other-things"] });
  assert.deepEqual(plainCard(f, { area: "forms" }), {
    id: f.id,
    impact: "Blocks users",
    severity: "high",
    title: f.title,
    problem: PLAIN_WORDING.false_success.problem,
    expected: PLAIN_WORDING.false_success.expected,
    happened: 'The page shows "Saved". The server answered with an error.',
    page: "/things/new?draft=1",
    alsoOn: ["/other-things"],
    steps: plainSteps(f.repro),
    area: "forms",
    picture: null,
    status: "open",
    technical: { category: "false_success", evidence: f.evidence, route: f.state },
    firstSeen: f.foundAt,
    timesSeen: 3,
  });
  assert.equal(plainCard(finding({ url: "not an address" })).page, "not an address");
  assert.equal("evidence" in plainCard(finding({ evidence: undefined })).technical, false);
});

test("card: impact is the severity's words, or Worth a look for an observation under a convention", () => {
  for (const severity of ["high", "medium", "low"] as const) assert.equal(plainCard(finding({ severity })).impact, IMPACT[severity]);
  assert.equal(plainCard(finding({ severity: "low", tier: "worth_a_look", convention: "a spacing scale" })).impact, "Worth a look");
});

test("card: status follows the last re-test, then whether it was resolved", () => {
  const cases: Array<[Partial<Finding>, string]> = [
    [{}, "open"],
    [{ status: "open" }, "open"],
    [{ status: "resolved" }, "fixed"],
    [{ verdict: "gone" }, "fixed"],
    [{ verdict: "present" }, "still-there"],
    [{ verdict: "changed" }, "changed"],
    [{ verdict: "present", status: "resolved" }, "still-there"],
  ];
  for (const [over, want] of cases) assert.equal(plainCard(finding(over)).status, want, JSON.stringify(over));
});

test("card: its own picture with its size, a recorded frame with none, and never a path that leaves the folder", () => {
  const own = finding({
    picture: "recordings/s1/finding-0a1b2c3d4e.png",
    pictureShot: { width: 400, height: 120, frame: "element", label: "Save", at: "2026-01-01T00:00:00.000Z" },
  });
  assert.deepEqual(plainCard(own).picture, { file: own.picture, width: 400, height: 120, what: '400×120, "Save" and around it' });
  assert.deepEqual(plainCard(finding(), { lastFrame: "recordings/s1/0004-click.jpg" }).picture, {
    file: "recordings/s1/0004-click.jpg",
    width: 0,
    height: 0,
    what: "what the page showed",
  });
  assert.equal(plainCard(finding({ picture: "../outside.png" })).picture, null);
});

test("card: the report's plain entry says exactly what the card says", () => {
  const f = finding({
    seenOn: ["/other-things"],
    picture: "recordings/s1/finding-0a1b2c3d4e.png",
    pictureShot: { width: 400, height: 120, frame: "viewport", at: "" },
  });
  const card = plainCard(f);
  const entry = plainFinding(f, 1, { audience: "both" }).join("\n");
  for (const part of [
    card.title,
    card.impact,
    card.problem,
    card.expected,
    card.happened,
    card.id,
    card.technical.route,
    card.technical.evidence!,
    ...card.alsoOn,
  ])
    assert.ok(entry.includes(part), `the report carries "${part}"`);
  card.steps.forEach((s, i) => assert.ok(entry.includes(`${i + 1}. ${s}`), s));
  assert.ok(entry.includes(`](${card.picture!.file})`));
});

// ---- Progress while a guided check runs (progress.ts) ----

const AT = Date.parse("2026-01-01T10:00:00.000Z");
const sess = (over: Partial<ProgressSession> = {}): ProgressSession => ({
  session: "default",
  state: "running",
  tool: "scout_click",
  url: "http://app.test/things?id=7",
  since: "2026-01-01T10:05:00.000Z",
  ...over,
});
const runOf = (over: Partial<GuidedRun> = {}): GuidedRun => ({ startedMs: AT, lastActiveMs: AT, story: [], areasStarted: [], reported: false, ...over });
const planFor = (over: Partial<GuidedChoices> = {}): GuidedPlan =>
  buildGuidedPlan(
    { address: "http://localhost:3000", areas: ["sign-in", "forms", "phone"], signIn: "none", care: "look-only", thoroughness: "normal", ...over },
    "gp-0123456789",
  );

test("progress phase: what the plan waits for, what the leading session runs, and how the check ended", () => {
  const plain = planFor();
  const confirming = planFor({ address: "https://staging.example.com", care: "may-create-test-data" });
  const cases: Array<[string, GuidedPlan, GuidedRun | undefined, ProgressSession[], string]> = [
    ["not started, nothing to confirm", plain, undefined, [], "starting"],
    ["not started, waiting for the person's confirmation", confirming, undefined, [], "needs-you"],
    ["started, then every session left with the report written", plain, runOf({ reported: true }), [], "done"],
    ["started, then every session left without a report", plain, runOf(), [], "stopped"],
    ["a session stuck past its watchdog", plain, runOf(), [sess({ state: "stuck" }), sess({ session: "phone" })], "needs-you"],
    ["signing in", plain, runOf(), [sess({ tool: "scout_login" })], "signing-in"],
    ["re-checking", plain, runOf(), [sess({ tool: "scout_verify" })], "re-checking"],
    ["writing the report", plain, runOf(), [sess({ tool: "scout_report" })], "writing-report"],
    ["the report is written and nothing runs", plain, runOf({ reported: true }), [sess({ state: "idle", tool: "scout_report" })], "done"],
    ["the report is written but a session runs on", plain, runOf({ reported: true }), [sess()], "exploring"],
    ["the phone session leads", plain, runOf(), [sess({ session: "phone" })], "checking-phone"],
    ["a session on the phone area leads", plain, runOf(), [sess({ area: "phone" })], "checking-phone"],
    ["exploring", plain, runOf(), [sess({ area: "forms" })], "exploring"],
    // A running session leads an idle one, even an idle one whose state began later.
    [
      "a running session leads",
      plain,
      runOf(),
      [sess({ session: "phone", state: "idle", since: "2026-01-01T10:09:00.000Z" }), sess({ tool: "scout_login" })],
      "signing-in",
    ],
  ];
  for (const [name, plan, run, sessions, want] of cases) assert.equal(guidedPhase(plan, run, sessions), want, name);
});

test("progress areas: in progress while a session says so, done once moved on or reported, skipped when never reached", () => {
  const plan = planFor({ care: "look-only" });
  const states = (run: GuidedRun | undefined, sessions: ProgressSession[], phase: Parameters<typeof areaStates>[3]) =>
    areaStates(plan, run, sessions, phase).map((a) => `${a.area}:${a.state}${a.note ? "+note" : ""}`);
  assert.deepEqual(states(undefined, [], "starting"), ["sign-in:waiting", "forms:waiting", "phone:waiting"]);
  // Working on sign-in: it is in progress and carries what Look only holds back there.
  assert.deepEqual(states(runOf({ areasStarted: ["sign-in"] }), [sess({ area: "sign-in" })], "exploring"), [
    "sign-in:in-progress+note",
    "forms:waiting",
    "phone:waiting",
  ]);
  // Moved on to forms: sign-in is done.
  assert.deepEqual(states(runOf({ areasStarted: ["sign-in", "forms"] }), [sess({ area: "forms" })], "exploring"), [
    "sign-in:done+note",
    "forms:in-progress+note",
    "phone:waiting",
  ]);
  // Two sessions on two areas at once: both in progress.
  assert.deepEqual(states(runOf({ areasStarted: ["forms", "phone"] }), [sess({ area: "forms" }), sess({ session: "phone", area: "phone" })], "exploring"), [
    "sign-in:waiting",
    "forms:in-progress+note",
    "phone:in-progress",
  ]);
  // The report is written: what was being worked on is done, what was never started is skipped with a reason.
  const ended = areaStates(plan, runOf({ areasStarted: ["forms"], reported: true }), [], "done");
  assert.deepEqual(
    ended.map((a) => [a.area, a.state]),
    [
      ["sign-in", "skipped"],
      ["forms", "done"],
      ["phone", "skipped"],
    ],
  );
  assert.equal(ended[0].note, AREA_NOT_REACHED);
  assert.equal(ended[1].note, plan.areas[1].heldBack);
  // A care level that holds nothing back in an area gives it no note.
  const forms = planFor({ address: "http://localhost:3000", care: "may-submit-forms", areas: ["forms"] });
  assert.equal(areaStates(forms, runOf({ areasStarted: ["forms"] }), [sess({ area: "forms" })], "exploring")[0].note, undefined);
});

test("progress now: the session's own task first, else a fixed sentence by tool and page, never the page's own text", () => {
  assert.equal(nowSentence("scout_click", "http://app.test/cart?coupon=x", "Try the checkout with an empty cart"), "Try the checkout with an empty cart");
  assert.equal(nowSentence("scout_navigate", "http://app.test/orders/7?token=abc#top"), "Opening /orders/7");
  assert.equal(nowSentence("scout_type", "http://app.test/register"), "Typing into a field on /register");
  assert.equal(nowSentence("scout_something_new", "http://app.test/x"), "Working on /x");
  assert.equal(nowSentence("scout_click", "about:blank"), "Pressing something on the site");
  assert.equal(nowSentence("scout_click", ""), "Pressing something on the site");
  assert.equal(nowSentence("toString", "http://app.test/x"), "Working on /x", "an inherited name is not a table entry");
  for (const [tool, line] of Object.entries(NOW_SENTENCE)) {
    assert.match(tool, /^scout_[a-z_]+$/);
    const said = line("/things");
    assert.doesNotMatch(said, /scout_|observe|read-only|safe-write|\bPOST\b|\bAPI\b|_/, `"${said}" is not plain`);
  }
  for (const s of [...Object.values(PHASE_NOW), AREA_NOT_REACHED, STUCK_SENTENCE]) assert.doesNotMatch(s, /scout_|_/);
});

test("progress now: an email, phone number or card number in the task or the page's path is redacted before it is shown", () => {
  // The task is the agent's own words and often quotes what it typed; the path is the app's, and can name a person.
  const person = ["jo.sample", "contoso-mail.net"].join("@");
  const task = nowSentence("scout_type", "http://app.test/x", `Sign up as ${person}, phone +1 415 555 0134, card 4111 1111 1111 1111`);
  assert.doesNotMatch(task, /jo\.sample|555 0134|4111 1111/, task);
  assert.match(task, /^Sign up as \[email redacted\]/);
  assert.equal(nowSentence("scout_navigate", `http://app.test/users/${person}/profile`), "Opening /users/[email redacted]/profile");
  // Encoded in the path, it is still an address.
  assert.doesNotMatch(nowSentence("scout_navigate", `http://app.test/users/${person.replace("@", "%40")}`), /jo\.sample/);
  // A path with no one in it is left as it is.
  assert.equal(nowSentence("scout_navigate", "http://app.test/orders/7"), "Opening /orders/7");
});

test("progress story: a new sentence is kept only when it differs from the last, and only the newest five", () => {
  let story: string[] = [];
  for (const s of ["a", "a", "b", "c", "c", "d", "e", "f", "g"]) story = pushStory(story, s);
  assert.deepEqual(story, ["c", "d", "e", "f", "g"]);
  assert.equal(STORY_MAX, 5);
  assert.deepEqual(pushStory(["a"], ""), ["a"], "an empty sentence adds nothing");
  const runs = new GuidedRuns();
  runs.step("gp-0123456789", "ignored before the check starts", AT);
  assert.equal(runs.get("gp-0123456789"), undefined);
  runs.start("gp-0123456789", AT);
  runs.start("gp-0123456789", AT + 60_000, true);
  runs.step("gp-0123456789", "Opening /", AT + 1000);
  runs.areaStarted("gp-0123456789", "forms");
  runs.areaStarted("gp-0123456789", "forms");
  runs.reported("gp-0123456789");
  assert.deepEqual(runs.get("gp-0123456789"), {
    startedMs: AT,
    lastActiveMs: AT + 1000,
    story: ["Opening /"],
    areasStarted: ["forms"],
    reported: true,
  });
  assert.equal(runs.focused, "gp-0123456789");
  // A second session carrying it is the same check; an attach once nothing carries it is a new check, with a fresh run.
  runs.start("gp-0123456789", AT + 2000, true);
  assert.equal(runs.get("gp-0123456789")!.reported, true);
  runs.start("gp-0123456789", AT + 120_000, false);
  assert.deepEqual(runs.get("gp-0123456789"), { startedMs: AT + 120_000, lastActiveMs: AT + 120_000, story: [], areasStarted: [], reported: false });
  runs.step("gp-0123456789", "Opening /", AT + 1000);
  runs.focus("gp-abcdefghij");
  assert.equal(runs.focused, "gp-abcdefghij");
  // A copy: changing it changes nothing kept.
  runs.get("gp-0123456789")!.story.push("x");
  assert.deepEqual(runs.get("gp-0123456789")!.story, ["Opening /"]);
});

test("progress clicking saved: never a bare number, always with its basis, and nothing until a page is checked", () => {
  assert.equal(clickingSaved(0, 40), null);
  const s = clickingSaved(41, 63)!;
  assert.equal(s.minutes, Math.round((41 * CLICKING_RATES.perPageSeconds + 63 * CLICKING_RATES.perControlSeconds) / 60));
  assert.match(s.basis, /^41 pages and 63 controls checked, at \d+ s a page and \d+ s a control\. These rates are a rough default, not a measurement\.$/);
  assert.ok(s.sentence.startsWith(`About ${s.minutes} minutes of clicking saved: `) && s.sentence.endsWith(s.basis));
  assert.match(clickingSaved(1, 0, { perPageSeconds: 10, perControlSeconds: 5 })!.sentence, /^Less than a minute of clicking saved: 1 page and 0 controls/);
  assert.equal(clickingSaved(2, 0, { perPageSeconds: 30, perControlSeconds: 5 })!.minutes, 1);
});

test("progress clicking saved: the figure stays out of every report and ticket", () => {
  // It is for the person watching (design question 12): only the progress, the status pane and its page may use it.
  const allowed = new Set(["progress.ts", "status-pane.ts", "status-pane-page.ts", "guided-words.ts"]);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    if (/clickingSaved|savedBasis|savedSentence|CLICKING_RATES|of clicking saved/.test(body))
      assert.ok(allowed.has(path.basename(f)), `${f} uses the clicking-saved figure`);
  }
});

test("progress: the whole model for a running check, its problems, newest cards and buttons", () => {
  const plan = planFor({ care: "look-only" });
  const run = runOf({ story: ["Opening /", "Reading /login"], areasStarted: ["sign-in"] });
  const findings = [
    finding({ id: "a000000001", severity: "high", foundAt: "2026-01-01T10:02:00.000Z" }),
    finding({ id: "a000000002", severity: "medium", foundAt: "2026-01-01T10:03:00.000Z" }),
    finding({ id: "a000000003", severity: "low", foundAt: "2026-01-01T10:04:00.000Z", tier: "worth_a_look" }),
    // Not counted: before the check, resolved, or labelled not a bug by the person.
    finding({ id: "a000000004", severity: "high", foundAt: "2025-12-31T10:00:00.000Z" }),
    finding({ id: "a000000005", severity: "high", foundAt: "2026-01-01T10:05:00.000Z", status: "resolved" }),
    finding({ id: "a000000006", severity: "high", foundAt: "2026-01-01T10:06:00.000Z", feedback: { verdict: "not-a-bug", at: "2026-01-01T10:07:00.000Z" } }),
  ];
  const p = guidedProgress({
    nowMs: AT + 6 * 60_000,
    plan,
    run,
    sessions: [sess({ area: "sign-in", tool: "scout_type", url: "http://localhost:3000/login" })],
    coverage: { routesVisited: 34, routesTotal: 41, elementsExercised: 20 },
    findings,
  });
  assert.equal(p.title, "Checking localhost:3000");
  assert.equal(p.phase, "exploring");
  assert.equal(p.now, "Typing into a field on /login");
  assert.deepEqual(p.story, ["Opening /", "Reading /login", "Typing into a field on /login"]);
  assert.deepEqual(p.pages, { checked: 34, found: 41 });
  assert.deepEqual(p.time, { usedMs: 6 * 60_000, budgetMs: 20 * 60_000 });
  assert.deepEqual(p.problems, { blocksUsers: 1, annoying: 1, cosmetic: 0, worthALook: 1 });
  assert.deepEqual(
    p.latest.map((c) => c.id),
    ["a000000003", "a000000002", "a000000001"],
  );
  assert.deepEqual(
    p.latest[0].actions.map((a) => [a.kind, a.label]),
    [
      ["direct", "Not a bug"],
      ["prompt", "Explain more"],
      ["prompt", "Check again"],
    ],
  );
  assert.deepEqual(p.latest[0].actions[0], { kind: "direct", label: "Not a bug", tool: "scout_feedback", args: { id: "a000000003", verdict: "not-a-bug" } });
  assert.ok(p.saved && p.saved.basis.startsWith("34 pages and 20 controls"));
  assert.deepEqual(
    p.next.map((a) => a.label),
    ["See all problems", "Stop"],
  );
  assert.equal(p.needsYou, undefined);
  assert.ok(!("needsYou" in p));
  // The latest cards are capped.
  const many = Array.from({ length: 9 }, (_, i) => finding({ id: `b00000000${i}`, foundAt: `2026-01-01T10:0${i}:30.000Z` }));
  assert.equal(guidedProgress({ nowMs: AT, plan, run, sessions: [sess()], coverage: null, findings: many }).latest.length, LATEST_MAX);
});

test("progress: before the start it asks for the confirmation, and once ended the clock and the story stop", () => {
  const confirming = planFor({ address: "https://staging.example.com", care: "may-create-test-data" });
  const waiting = guidedProgress({ nowMs: AT, plan: confirming, run: undefined, sessions: [], coverage: null, findings: [] });
  assert.equal(waiting.phase, "needs-you");
  assert.equal(waiting.needsYou?.kind, "confirm");
  assert.equal(waiting.now, NEEDS_YOU_SENTENCE.confirm("staging.example.com"));
  assert.deepEqual(waiting.next, [{ kind: "direct", label: "Confirm the care level", tool: "scout_guided_confirm", args: { planId: confirming.planId } }]);
  assert.equal(waiting.saved, null);
  assert.deepEqual(waiting.time, { usedMs: 0, budgetMs: 20 * 60_000 });

  const plan = planFor();
  const ended = guidedProgress({
    nowMs: AT + 60 * 60_000,
    plan,
    run: runOf({ lastActiveMs: AT + 9 * 60_000, story: ["Writing up what it found"], reported: true }),
    sessions: [],
    coverage: { routesVisited: 3, routesTotal: 3, elementsExercised: 0 },
    findings: [],
  });
  assert.equal(ended.phase, "done");
  assert.equal(ended.now, PHASE_NOW.done);
  assert.equal(ended.time.usedMs, 9 * 60_000, "the clock stops at the last step");
  assert.deepEqual(ended.story, ["Writing up what it found"]);
  assert.deepEqual(
    ended.next.map((a) => a.kind === "prompt" && a.text),
    [false, ACTION_PROMPT.recheck, ACTION_PROMPT.plainReport],
  );
  const stuck = guidedProgress({ nowMs: AT, plan, run: runOf(), sessions: [sess({ state: "stuck" })], coverage: null, findings: [] });
  assert.equal(stuck.needsYou?.kind, "stuck");
  assert.deepEqual(
    stuck.next.map((a) => a.label),
    ["Stop"],
  );
});

// ---- The plain error screens (progress.ts): which failure becomes which screen, with one sentence and one button ----

/** The messages readyBrowser throws, made by readyBrowser itself, so a change to its wording fails here. */
async function downloadFailure(opts: { ok: boolean; env?: NodeJS.ProcessEnv; presentAfter?: boolean }): Promise<string> {
  let calls = 0;
  const present = async () => {
    calls += 1;
    const installed = calls > 1 && opts.presentAfter === true;
    return {
      chromium: { installed, path: null },
      "chromium-headless-shell": { installed, path: null },
      firefox: { installed, path: null },
      webkit: { installed, path: null },
    } as never;
  };
  try {
    await readyBrowser(
      { engine: "chromium", headed: false },
      { env: opts.env ?? { SCENESCOUT_BROWSER_DOWNLOAD: "on" }, present, download: async () => ({ ok: opts.ok, detail: "exit code 1" }), say: () => {} },
    );
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("readyBrowser did not throw");
}

test("error screens: each failure the engine words is read as its screen, and nothing else is", async () => {
  const cases: Array<[string, string, string | null]> = [
    [
      "an attach whose first page did not load",
      "Could not load https://staging.example.com — is the app running? (page.goto: net::ERR_CONNECTION_REFUSED at https://staging.example.com/)",
      "address-unreachable",
    ],
    [
      "the same, as the tool result says it",
      "ERROR: Could not load http://localhost:3000 — is the app running? (page.goto: Timeout 20000ms exceeded.)",
      "address-unreachable",
    ],
    ["a later page on a host that no longer resolves (Chromium)", "page.goto: net::ERR_NAME_NOT_RESOLVED at https://nowhere.example/", "address-unreachable"],
    ["a refused connection (Firefox)", "page.goto: NS_ERROR_CONNECTION_REFUSED", "address-unreachable"],
    ["an unknown host (WebKit)", "page.goto: A server with the specified hostname could not be found.", "address-unreachable"],
    ["the browser download failed", await downloadFailure({ ok: false }), "browser-download-failed"],
    ["the download said it worked but the build is missing", await downloadFailure({ ok: true }), "browser-download-failed"],
    // Near misses: the same words in another place, or a failure the person cannot fix with Try again.
    ["a download the setting forbids is not a failed download", await downloadFailure({ ok: false, env: { SCENESCOUT_BROWSER_DOWNLOAD: "off" } }), null],
    ["the words quoted later in another failure", 'Element e12 not found; the page says "Could not load https://x.example — is the app running?"', null],
    ["a navigation the page itself aborted", "page.goto: net::ERR_ABORTED at https://staging.example.com/download", null],
    ["a refused attach", "ERROR: scout_attach refused: this plan has not been confirmed by the person", null],
    ["a sign-in window closed before saving", 'ERROR: nothing was saved for role "user": the window was closed', null],
  ];
  for (const [name, message, want] of cases) assert.equal(troubleOf(message), want, `${name}: ${message}`);
});

test("error screens: a result is read only when it failed, and a lost sign-in comes from the engine's flag, never the text", () => {
  const said = (text: string, isError?: boolean) => ({ content: [{ type: "text", text }], ...(isError === undefined ? {} : { isError }) });
  const unreachable = "ERROR: Could not load https://staging.example.com — is the app running? (page.goto: net::ERR_CONNECTION_REFUSED)";
  assert.equal(troubleOfResult(said(unreachable, true), false), "address-unreachable");
  assert.equal(troubleOfResult(said(unreachable), false), null, "the same words in a result that did not fail, such as a page's text in a snapshot");
  assert.equal(troubleOfResult(said("Navigated to /orders", true), false), null, "a failure with no screen of its own");
  assert.equal(
    troubleOfResult(said("⚠ SESSION AUTH LOST — 3 consecutive navigations were redirected to a login page."), false),
    null,
    "the banner's words alone are not the flag: a page can show them",
  );
  // The engine's own flag says the sign-in is gone, whatever the result says.
  assert.equal(troubleOfResult(said("Navigated to /login", false), true), "sign-in-expired");
  assert.equal(troubleOfResult(said(unreachable, true), true), "sign-in-expired");
});

test("error screens: a plan keeps the latest call's trouble, says it once, and a call that goes well or a new start clears it", () => {
  const runs = new GuidedRuns();
  assert.equal(runs.trouble("gp-0123456789"), undefined);
  assert.equal(runs.settle("gp-0123456789", "address-unreachable"), true, "new: the person is told");
  assert.equal(runs.settle("gp-0123456789", "address-unreachable"), false, "the same again: not told twice");
  assert.equal(runs.trouble("gp-0123456789"), "address-unreachable");
  assert.equal(runs.settle("gp-0123456789", "sign-in-expired"), true, "another trouble is told");
  assert.equal(runs.settle("gp-0123456789", null), false);
  assert.equal(runs.trouble("gp-0123456789"), undefined, "a call that went well clears it");
  runs.settle("gp-0123456789", "browser-download-failed");
  runs.start("gp-0123456789", AT);
  assert.equal(runs.trouble("gp-0123456789"), undefined, "a session attaching with the plan clears it");
});

test("error screens: each trouble is one sentence and one button, and the same check without it shows no screen", () => {
  const plan = planFor({ address: "https://staging.example.com", signIn: "password" });
  const base = { nowMs: AT + 60_000, plan, run: runOf(), sessions: [sess()], coverage: null, findings: [] };
  const clean = guidedProgress(base);
  assert.equal(clean.phase, "exploring");
  assert.equal(clean.needsYou, undefined);
  const want: Record<Trouble, { label: string; text: string }> = {
    "address-unreachable": { label: ACTION_LABEL.tryAgain, text: ACTION_PROMPT.retry(plan.planId) },
    "browser-download-failed": { label: ACTION_LABEL.tryAgain, text: ACTION_PROMPT.retry(plan.planId) },
    "sign-in-expired": { label: ACTION_LABEL.signInAgain, text: ACTION_PROMPT.signInAgain(plan.planId, "https://staging.example.com", "user") },
  };
  for (const trouble of Object.keys(want) as Trouble[]) {
    for (const run of [runOf(), undefined]) {
      const p = guidedProgress({ ...base, run, sessions: run ? base.sessions : [], trouble });
      assert.equal(p.phase, "needs-you", trouble);
      assert.equal(p.needsYou?.kind, trouble);
      assert.equal(p.needsYou?.sentence, NEEDS_YOU_SENTENCE[trouble]("staging.example.com"));
      assert.equal(p.now, p.needsYou?.sentence);
      assert.deepEqual(p.next, [{ kind: "prompt", ...want[trouble] }], `${trouble}: one button`);
    }
  }
  // The sign-in prompt names the window to open and the plan to carry on with.
  assert.match(
    ACTION_PROMPT.signInAgain("gp-0123456789", "https://staging.example.com", "user"),
    /scout_login \{url: "https:\/\/staging\.example\.com", role: "user"\}.*gp-0123456789/,
  );
  // What the agent is told to say is the panel's sentence, word for word.
  assert.equal(
    troubleTell("address-unreachable", "https://staging.example.com/shop"),
    `Tell the person, in these words: "${NEEDS_YOU_SENTENCE["address-unreachable"]("staging.example.com")}"`,
  );
});

test("error screens: a check that stopped at its time limit says so with one button; one that stopped short of it, or wrote its report, does not", () => {
  const plan = planFor({ thoroughness: "quick" }); // 10 minutes
  const ended = (over: { lastActiveMin: number; reported?: boolean; pages?: number }) =>
    guidedProgress({
      nowMs: AT + 60 * 60_000,
      plan,
      run: runOf({ lastActiveMs: AT + over.lastActiveMin * 60_000, reported: over.reported ?? false }),
      sessions: [],
      coverage: { routesVisited: over.pages ?? 5, routesTotal: 400, elementsExercised: 0 },
      findings: [],
    });
  const atLimit = ended({ lastActiveMin: 10 });
  assert.equal(atLimit.phase, "stopped");
  assert.equal(atLimit.needsYou?.kind, "stopped-by-cap");
  assert.equal(atLimit.needsYou?.sentence, NEEDS_YOU_SENTENCE["stopped-by-cap"]("localhost:3000"));
  assert.deepEqual(atLimit.next, [{ kind: "direct", label: ACTION_LABEL.seeAll, tool: "scout_cards", args: {} }]);
  assert.equal(atLimit.now, PHASE_NOW.stopped, "the narrator says it stopped; the screen says why");
  const short = ended({ lastActiveMin: 9 });
  assert.equal(short.phase, "stopped");
  assert.equal(short.needsYou, undefined, "stopped before its time was up: no limit screen");
  // The project's page count is not this check's: a stop short of the time is not called a limit, however many pages the project has.
  assert.equal(ended({ lastActiveMin: 9, pages: 300 }).needsYou, undefined);
  const reported = ended({ lastActiveMin: 10, reported: true });
  assert.equal(reported.phase, "done");
  assert.equal(reported.needsYou, undefined, "a check that wrote its report at its limit finished");
  assert.equal(stoppedByCap("exploring", { usedMs: 11 * 60_000, budgetMs: 10 * 60_000 }), false, "still running");
});

test("error screens: a trouble left by the last call does not outlive the check", () => {
  const plan = planFor({ signIn: "password" });
  const at = (sessions: ProgressSession[], reported: boolean) =>
    guidedProgress({
      nowMs: AT + 5 * 60_000,
      plan,
      run: runOf({ lastActiveMs: AT + 5 * 60_000, reported }),
      sessions,
      coverage: null,
      findings: [],
      trouble: "sign-in-expired",
    });
  assert.equal(at([sess()], false).phase, "needs-you", "while a session carries the plan");
  const finished = at([], true);
  assert.equal(finished.phase, "done", "reported and closed: done, not the sign-in screen");
  assert.equal(finished.needsYou, undefined);
  assert.equal(at([], false).phase, "stopped");
});

test("error screens: every error sentence is one plain sentence, and each kind has its heading", () => {
  for (const kind of ERROR_KINDS) {
    const s = NEEDS_YOU_SENTENCE[kind]("staging.example.com");
    assert.equal(s.replace(/staging\.example\.com/g, "").match(/[.?!](\s|$)/g)?.length, 1, `one sentence: ${s}`);
    assert.doesNotMatch(s, /scout_|ERROR|net::|NS_ERROR|Playwright|\bHTTP\b/, `plain: ${s}`);
    assert.ok(ERROR_HEADING[kind] in SCREEN_HEADING);
  }
  assert.equal(ERROR_HEADING["sign-in-expired"], "needYou", "signing in again is a request, not a failure");
  assert.equal(ERROR_HEADING["address-unreachable"], "wentWrong");
});

// ---- scout_cards and scout_feedback's rules ----

test("cards: worst first, fixed and not-a-bug left out by default, ids and filters show exactly what they name", () => {
  const all = [
    finding({ id: "c000000001", severity: "low", foundAt: "2026-01-01T10:01:00.000Z" }),
    finding({ id: "c000000002", severity: "high", foundAt: "2026-01-01T10:02:00.000Z", area: "forms" }),
    finding({ id: "c000000003", severity: "high", foundAt: "2026-01-01T10:03:00.000Z" }),
    finding({ id: "c000000004", severity: "medium", foundAt: "2026-01-01T10:04:00.000Z", status: "resolved" }),
    finding({ id: "c000000005", severity: "high", foundAt: "2026-01-01T10:05:00.000Z", feedback: { verdict: "not-a-bug", at: "2026-01-01T11:00:00.000Z" } }),
    finding({ id: "c000000006", severity: "medium", foundAt: "2026-01-01T10:06:00.000Z", tier: "worth_a_look" }),
  ];
  const ids = (sel: { cards: Array<{ id: string }> }) => sel.cards.map((c) => c.id);
  const byDefault = selectCards(all);
  assert.deepEqual(ids(byDefault), ["c000000003", "c000000002", "c000000001", "c000000006"]);
  assert.equal(byDefault.total, 4);
  assert.equal(byDefault.notABug, 1, "left out, and counted so the person can ask for it");
  assert.deepEqual(byDefault.missing, []);
  assert.deepEqual(ids(selectCards(all, { filter: { feedback: ["not-a-bug"] } })), ["c000000005"]);
  assert.deepEqual(ids(selectCards(all, { filter: { status: ["fixed"] } })), ["c000000004"]);
  assert.deepEqual(ids(selectCards(all, { filter: { impact: ["Blocks users"] } })), ["c000000003", "c000000002"]);
  assert.deepEqual(ids(selectCards(all, { filter: { area: ["forms"] } })), ["c000000002"]);
  // Named ids are shown whatever their status or label; an unknown one is said.
  const named = selectCards(all, { ids: ["c000000004", "c000000005", "nope"] });
  assert.deepEqual(ids(named), ["c000000005", "c000000004"]);
  assert.deepEqual(named.missing, ["nope"]);
  // The limit cuts the list, never the total.
  const one = selectCards(all, { limit: 1 });
  assert.deepEqual([one.cards.length, one.total], [1, 4]);
  assert.equal(selectCards(all, { limit: 999 }).cards.length, 4);
  assert.ok(MAX_CARDS <= 50 && MAX_INLINE_PICTURES <= 10 && INLINE_PICTURE_SIDE === 1024);
});

test("cards: a card's text says what the card says, and a label shows on it", () => {
  const card = plainCard(finding({ feedback: { verdict: "not-a-bug", reason: "Staging only", at: "2026-01-01T11:00:00.000Z" } }));
  const t = cardText(card, "/proj/.scenescout/recordings/s/finding.png");
  const lines = t.split("\n");
  assert.equal(lines[0], `BLOCKS USERS - ${card.title}`);
  assert.equal(lines[1], `${card.problem} - on /things/new?draft=1`);
  assert.ok(t.includes(`What was done: 1. ${card.steps[0]}  2. ${card.steps[1]}`), t);
  assert.ok(t.includes(`Expected: ${card.expected}`) && t.includes(`Happened: ${card.happened}`));
  assert.ok(t.includes("Picture: /proj/.scenescout/recordings/s/finding.png"));
  assert.ok(t.includes("You marked this not a bug: Staging only"));
  assert.equal(lines[lines.length - 1], `(id ${card.id}: say "check ${card.id} again", "explain ${card.id}" or "${card.id} is not a bug")`);
  assert.deepEqual(plainCard(finding({ area: "forms" })).area, "forms", "the area it was found in is on its card");
});

test("cards: a label or an area the engine does not know, read from a project's memory, is left off the card rather than breaking every card", () => {
  // memory.json is merged between people (memory-merge.ts), so a newer version's label or a hand edit can reach an older reader.
  // scout_cards' output schema holds both to their known values, and one unknown value would refuse the whole call.
  const odd = finding({
    id: "e000000001",
    feedback: { verdict: "duplicate", at: "2026-01-01T11:00:00.000Z" } as unknown as Finding["feedback"],
    area: "nowhere" as unknown as Finding["area"],
  });
  const card = plainCard(odd);
  assert.equal("feedback" in card, false);
  assert.equal("area" in card, false);
  assert.equal(plainCard(finding({ feedback: { verdict: "confirmed", at: 7 } as unknown as Finding["feedback"] })).feedback, undefined, "a label with no time");
  assert.deepEqual(feedbackCandidates([odd]), []);
  assert.deepEqual(
    selectCards([odd]).cards.map((c) => c.id),
    ["e000000001"],
    "it is shown as a card with no label",
  );
});

test(
  "cards: an inline picture is read only from inside .scenescout/, never through a link out of it, and only a PNG within the size caps",
  { skip: process.platform === "win32" },
  () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "guided-pictures-"));
    try {
      const dir = path.join(top, ".scenescout");
      fs.mkdirSync(path.join(dir, "recordings"), { recursive: true });
      const png = encodePng({ width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(200) });
      fs.writeFileSync(path.join(dir, "recordings", "inside.png"), png);
      // A picture just outside the folder, and links to it from inside.
      fs.writeFileSync(path.join(top, "outside.png"), png);
      fs.symlinkSync(path.join(top, "outside.png"), path.join(dir, "recordings", "link.png"));
      fs.symlinkSync(top, path.join(dir, "up"));
      fs.writeFileSync(path.join(dir, "recordings", "notes.png"), "not a picture");
      const got = readInlinePicture(dir, "recordings/inside.png");
      assert.ok("image" in got && got.image.mimeType === "image/png" && got.image.data.length > 0, JSON.stringify(got));
      for (const file of ["recordings/link.png", "up/outside.png", "../outside.png", path.join(top, "outside.png")]) {
        const r = readInlinePicture(dir, file);
        assert.ok("why" in r && /outside the project's folder/.test(r.why), `${file}: ${JSON.stringify(r).slice(0, 120)}`);
      }
      assert.match((readInlinePicture(dir, "recordings/notes.png") as { why: string }).why, /not a PNG/);
      assert.match((readInlinePicture(dir, "recordings/missing.png") as { why: string }).why, /could not be read/);
      assert.match((readInlinePicture(dir, "recordings/inside.png", { maxFileBytes: 10 }) as { why: string }).why, /too large/);
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  },
);

test("feedback: every label is a candidate for a maintainer, newest first, and nothing more", () => {
  const all = [
    finding({ id: "d000000001", feedback: { verdict: "not-a-bug", reason: "Expected on staging", at: "2026-01-01T11:00:00.000Z" } }),
    finding({ id: "d000000002" }),
    finding({ id: "d000000003", severity: "low", feedback: { verdict: "confirmed", at: "2026-01-01T12:00:00.000Z" } }),
  ];
  assert.deepEqual(feedbackCandidates(all), [
    {
      findingId: "d000000003",
      verdict: "confirmed",
      at: "2026-01-01T12:00:00.000Z",
      suggests: "defect",
      title: all[2].title,
      category: "false_success",
      severity: "low",
      route: "/things/new",
      evidence: all[2].evidence,
    },
    {
      findingId: "d000000001",
      verdict: "not-a-bug",
      reason: "Expected on staging",
      at: "2026-01-01T11:00:00.000Z",
      suggests: "non-defect",
      title: all[0].title,
      category: "false_success",
      severity: "high",
      route: "/things/new",
      evidence: all[0].evidence,
    },
  ]);
  assert.deepEqual(feedbackCandidates([finding()]), []);
});
