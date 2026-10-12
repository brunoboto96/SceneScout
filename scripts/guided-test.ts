/**
 * The guided assistant's start, and the cards it shows: every choice to its
 * plan, when a person must confirm before a plan starts (each rule as a
 * contrastive pair, so both directions are asserted), credentials refused in
 * the choices, the fixed wording, and a finding as a card.
 *
 *   npm run guided-test
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGuidedPlan,
  CARE_MODE,
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
} from "../src/engine/guided.ts";
import {
  AREA_LABEL,
  AREA_WHAT_HAPPENS,
  CARE_EXPLAIN,
  CARE_LABEL,
  CARE_PREVIEW,
  CONFIRM_COMING,
  confirmSentence,
  DESTRUCTIVE_NOT_OFFERED,
  HELD_BACK,
  NEEDS_YOU_SENTENCE,
  SAFETY_EXPLAINER,
  THOROUGHNESS_LABEL,
} from "../src/engine/guided-words.ts";
import { settingsFromAnswers } from "../src/intake.ts";
import { allowsWrite } from "../src/engine/policy.ts";
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
  for (const address of ["http://localhost", "http://localhost:3000/app", "http://LOCALHOST:8080", "http://127.0.0.1:5173", "http://[::1]:3000"]) {
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
    { tool: "scout_attach", args: { url: REMOTE, mode: "observe", objective: "Check broken pages and links." } },
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
  assert.deepEqual({ ...a.plan, planId: "" }, { ...b.plan, planId: "" });
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
