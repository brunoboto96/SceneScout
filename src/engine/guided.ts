/**
 * The guided assistant's start: what a person chose, whether those choices
 * can be used, the plan built from them, and when the person must confirm
 * before the plan may start.
 *
 * A person who does not write prompts chooses an address, what to check, how
 * careful to be and how they sign in. This module turns those choices into the
 * calls an agent makes, the sentences the person is told first, and the write
 * mode the run is held to. Nothing here launches a browser or talks to a
 * client: it is pure, so every rule is table-tested in guided-test (ADR 5).
 *
 * The care levels and the confirmation rule are ADR 24. In short: "Look only"
 * is observe and needs no confirmation; "May submit forms" is read-only and
 * needs one on an address that is not on this computer; "May create test data"
 * is safe-write and always needs one, with a typed code; destructive is never
 * offered. A confirmation counts only when the person gives it through the
 * server's own form, which the server tools hold (not this module).
 *
 * Design: docs/design/non-technical-assistant.md, sections 3.2 and 3.6.
 */
import crypto from "node:crypto";
import { INTAKE_ROLE, SIGN_IN_HINT, type SignInAnswer } from "../intake.js";
import {
  AREA_LABEL,
  AREA_WHAT_HAPPENS,
  budgetSentence,
  CARE_EXPLAIN,
  CARE_LABEL,
  CARE_PREVIEW,
  CONFIRM_ANSWER,
  CONFIRM_ANSWER_LINE,
  CONFIRM_COMING,
  CONFIRM_FIELD,
  CONFIRM_PREVIEW_HEADING,
  CONFIRM_SAYS,
  confirmCodeLine,
  confirmSentence,
  DESTRUCTIVE_NOT_OFFERED,
  HELD_BACK,
  PHONE_VIEWPORT,
  signInSentence,
} from "./guided-words.js";
import { redactSecrets } from "./redact.js";
import { redactPersonal, secretWordKind } from "./sensitive.js";

/** How careful the run is, in the words the person chooses from. */
export const CARES = ["look-only", "may-submit-forms", "may-create-test-data"] as const;
export type Care = (typeof CARES)[number];

/** The write mode a guided run can be in. `destructive` is not one of them. */
export type GuidedMode = "observe" | "read-only" | "safe-write";

/** The write mode each care level is. `destructive` is never offered. */
export const CARE_MODE: Record<Care, GuidedMode> = {
  "look-only": "observe",
  "may-submit-forms": "read-only",
  "may-create-test-data": "safe-write",
};

export const CHECK_AREAS = ["sign-in", "forms", "broken-pages", "phone", "journey", "tickets"] as const;
export type CheckArea = (typeof CHECK_AREAS)[number];

export const THOROUGHNESSES = ["quick", "normal", "thorough"] as const;
export type Thoroughness = (typeof THOROUGHNESSES)[number];

/** How a person signs in to the app, as intake.ts asks it. */
export type SignIn = SignInAnswer;
export const SIGN_INS: readonly SignIn[] = ["none", "sso", "password", "one-time-code"];

/** The report's completion level each thoroughness is. */
export const THOROUGHNESS_LEVEL: Record<Thoroughness, "minimal" | "medium" | "extensive"> = {
  quick: "minimal",
  normal: "medium",
  thorough: "extensive",
};

/** The time and page limits each thoroughness states, so a guided run is never unbounded. */
export const THOROUGHNESS_BUDGET: Record<Thoroughness, { minutes: number; pages: number }> = {
  quick: { minutes: 10, pages: 20 },
  normal: { minutes: 20, pages: 60 },
  thorough: { minutes: 30, pages: 120 },
};

/** What the person chose. Never holds a password, code or token. */
export interface GuidedChoices {
  /** http(s), no userinfo; at most MAX_ADDRESS characters. */
  address: string;
  /** At least one. */
  areas: CheckArea[];
  /** Required with "journey"; at most MAX_JOURNEY characters. */
  journey?: string;
  /** Required with "tickets". */
  tickets?: string[];
  signIn: SignIn;
  /** Default "look-only". */
  care: Care;
  /** Default "normal". */
  thoroughness: Thoroughness;
}

/** Why a plan needs the person to confirm it before it starts. */
export type ConfirmReason = "creates-data" | "forms-on-remote-site";

/** A call the agent makes, in the order the plan lists it. */
export interface GuidedCall {
  tool: "scout_login" | "scout_attach" | "scout_tickets" | "scout_session";
  args: Record<string, unknown>;
}

/** What the engine says will happen. Built from GuidedChoices alone. */
export interface GuidedPlan {
  /** "gp-" and 10 random characters; held in the server process only. */
  planId: string;
  choices: GuidedChoices;
  mode: GuidedMode;
  level: "minimal" | "medium" | "extensive";
  objective: string;
  /** Each area in plain words, and what the care level holds back there. */
  areas: Array<{ area: CheckArea; label: string; whatHappens: string; heldBack?: string }>;
  /** Null, or the sentence the person must accept before the run starts. */
  confirm: null | { reason: ConfirmReason; sentence: string; accepted: boolean };
  /** Sentences to tell the person before starting, in order. */
  tellPerson: string[];
  /** The tool calls the agent makes, in order; the same shape intake.ts returns. */
  calls: GuidedCall[];
  /** Time and page caps, so progress can show "6m of 20m". */
  budget: { minutes: number; pages: number };
}

export const MAX_ADDRESS = 2048;
export const MAX_JOURNEY = 500;
/** Most tickets one check reads, and the most characters in one. */
export const MAX_TICKETS = 50;
export const MAX_TICKET_CHARS = 10_000;
/** scout_attach takes an objective of at most this many characters. */
export const MAX_OBJECTIVE = 300;

/** The session the phone area's second browser runs in, when other areas share the first. */
export const PHONE_SESSION = "phone";

/** Every field GuidedChoices has. Any other is refused, so nothing can ride along in one. */
const CHOICE_FIELDS = new Set(["address", "areas", "journey", "tickets", "signIn", "care", "thoroughness"]);

const NO_CREDENTIALS =
  "never type a password, code or token into the choices: when your site needs one, a browser window opens for you to sign in as you normally would";

/** Not part of a longer word, in any script: `\b` reads only ASCII letters as letters. */
const EDGE_BEFORE = "(?<![\\p{L}\\p{N}_])";
const EDGE_AFTER = "(?![\\p{L}\\p{N}_])";

/**
 * A word that names a secret, as someone writes it in a sentence: "password",
 * "pw", "PIN", "login code", "token", "credentials" and the like, and the
 * word for a password in the languages a journey is most often written in.
 */
const SECRET_WORD = new RegExp(
  `${EDGE_BEFORE}(?:password|passwort|passphrase|passcode|pass code|pw|pwd|pin|one-time code|verification code|login code|sign-in code|security code|2fa code|two-factor code|mfa code|authenticator code|otp|token|api key|apikey|secret|credentials?|creds|mot de passe|contraseña|senha|wachtwoord|kennwort|passord|lösenord|hasło|пароль)${EDGE_AFTER}`,
  "giu",
);

/** "pass" names a secret only when a value is set against it: "pass: hunter2", "pass=…". */
const PASS_SET = new RegExp(`${EDGE_BEFORE}pass(?=\\s*[:=])`, "giu");

/** "Sign in" or "log in", then "with" within a short phrase: what follows is how they sign in ("sign in as bob with hunter2"). */
const SIGN_IN_WITH = /\b(?:sign|log)[\s-]?in\b[^.;\n]{0,60}?\bwith\b/giu;

/** A code as a sign-in asks for one: six to eight digits after the word "code" ("use the code 482913"). */
const DIGIT_CODE = new RegExp(`${EDGE_BEFORE}code\\s*(?:is\\s*|[:=]\\s*)?\\d{6,8}(?!\\d)`, "iu");

/** How many words after a secret's name are read for its value ("the password for it is Summer2024!"). */
const VALUE_WINDOW = 5;

/** Words that, set after a field's name and a colon, name something about the field rather than its value ("Password: required"). */
const FIELD_WORDS = new Set([
  "label",
  "field",
  "box",
  "input",
  "placeholder",
  "hint",
  "required",
  "optional",
  "missing",
  "empty",
  "blank",
  "wrong",
  "invalid",
  "hidden",
  "masked",
  "shown",
  "visible",
  "error",
  "errors",
  "message",
  "too",
  "must",
  "should",
]);

/**
 * Query keys whose value is a credential on an address, beyond the ones the
 * report's redaction masks: a sign-in callback's code, a signed link's
 * signature, a key, a session or an auth value, a password under a short name.
 */
const SECRET_PARAM = /^(?:code|sig|signature|xamzsignature|xgoogsignature|key|session|sessionid|sid|auth|authorization|pass|nonce|jwt)$/;

/**
 * Whether a word reads as a credential's value rather than as English: at
 * least four characters with a digit in it, or with a symbol other than a
 * hyphen or an apostrophe. An email address is personal data, not a
 * credential, and does not count; nor do a link, a path on the site, a
 * numbered item ("#42") or a setting written as name=value ("role=editor").
 */
function looksLikeValue(raw: string): boolean {
  const word = raw.replace(/^["'“‘(\[]+|["'”’)\],.;:?]+$/gu, "");
  if (word.length < 4 || /^[^@\s]+@[^@\s]+\.\p{L}{2,}$/u.test(word)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) || word.startsWith("/") || /^#\d+$/.test(word)) return false;
  const setting = /^([\p{L}_-]+)=[\p{L}\p{N}_-]+$/u.exec(word);
  if (setting && !new RegExp(SECRET_WORD.source, "iu").test(setting[1])) return false;
  return /\p{N}/u.test(word) || /[^\p{L}\p{N}'’-]/u.test(word);
}

/**
 * Whether the words after position `end` hold a value: one set against the
 * name with a colon or an equals sign ("Password: letmein"), a quoted one
 * straight after it, or one of the next few words that reads as a value.
 */
function valueFollows(text: string, end: number): boolean {
  const rest = text.slice(end, end + 120);
  const set = /^\s*[:=]\s*["'“‘]?([^\s"'”’,;)/]{3,})["'”’]?\s*(?:$|[,;)/]|\.(?:\s|$))/u.exec(rest);
  if (set && !FIELD_WORDS.has(set[1].toLowerCase())) return true;
  const quoted = /^\s*(?:is|was|[:=-])?\s*["'“‘]([^"'”’]{4,})["'”’]/u.exec(rest);
  if (quoted && (/[^\p{L}\s]/u.test(quoted[1]) || !/\s/u.test(quoted[1]))) return true;
  return rest.split(/\s+/).filter(Boolean).slice(0, VALUE_WINDOW).some(looksLikeValue);
}

/** Whether an address carries a credential under a query or fragment key the report's redaction does not know. */
function addressHoldsSecretParam(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  return keys.some((k) => SECRET_PARAM.test(k.toLowerCase().replace(/[^a-z]/g, "")));
}

/**
 * Whether text holds a credential: a shape the report's redaction would mask
 * (a key, a bearer token, `?password=…`, a value typed into a password field),
 * an address with a code, signature, key or session in its query, or one
 * written out in words: a word that names a secret, or "sign in … with",
 * followed by a value: one set against it with a colon ("Password:
 * letmein"), a quoted one, or within a few words one with a digit or a symbol
 * in it, such as "the PIN is 4821" or "the password for it is Summer2024!".
 * Otherwise words of letters only ("the password is required", "the login
 * code screen loads", "Password: required") read as a sentence about the
 * field, so a letters-only password written as "the password is hunter" is
 * not caught: that sentence cannot be told from "the password is required". Email
 * addresses are not credentials here: a journey may name the address to sign
 * up with.
 */
export function holdsCredential(text: string): boolean {
  if (redactSecrets(text) !== redactPersonal(text)) return true;
  if (addressHoldsSecretParam(text) || DIGIT_CODE.test(text)) return true;
  for (const re of [SECRET_WORD, PASS_SET, SIGN_IN_WITH]) for (const m of text.matchAll(re)) if (valueFollows(text, (m.index ?? 0) + m[0].length)) return true;
  return false;
}

/** Whether an address is on this computer: only localhost, 127.0.0.1 and ::1 are. */
export function isLocalAddress(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function checkAddress(raw: unknown): Checked<string> {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "give the address of the site, e.g. https://staging.example.com" };
  const address = raw.trim();
  if (address.length > MAX_ADDRESS) return { ok: false, error: `the address is longer than ${MAX_ADDRESS} characters` };
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, error: "the address must be written in full, starting with http:// or https://" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "the address must start with http:// or https://" };
  // Neither refusal quotes the address: it holds the credential.
  if (url.username || url.password) return { ok: false, error: `put no user name or password in the address: ${NO_CREDENTIALS}` };
  if (holdsCredential(address)) return { ok: false, error: `the address holds what looks like a password, code or token: ${NO_CREDENTIALS}` };
  return { ok: true, value: address };
}

function checkAreas(raw: unknown): Checked<CheckArea[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "choose at least one thing to check" };
  const areas: CheckArea[] = [];
  for (const a of raw) {
    if (typeof a !== "string" || !(CHECK_AREAS as readonly string[]).includes(a))
      return { ok: false, error: `one of the areas is not something to check: choose from ${CHECK_AREAS.join(", ")}` };
    if (!areas.includes(a as CheckArea)) areas.push(a as CheckArea);
  }
  return { ok: true, value: areas };
}

function oneOfOr<T extends string>(raw: unknown, list: readonly T[], fallback: T, what: string): Checked<T> {
  if (raw === undefined) return { ok: true, value: fallback };
  if (typeof raw === "string" && (list as readonly string[]).includes(raw)) return { ok: true, value: raw as T };
  return { ok: false, error: `${what} must be one of ${list.join(", ")}` };
}

/**
 * The person's choices, checked, or the one sentence that says what to fix.
 * Unknown fields are refused, and a field named for a credential is refused
 * by its name without its value being repeated. A credential in the address,
 * the journey or a ticket is refused the same way. Nothing is guessed: a
 * journey with no "journey" area, or tickets with no "tickets" area, is a
 * contradiction and is refused rather than dropped or added.
 */
export function checkGuidedChoices(input: unknown): { ok: true; choices: GuidedChoices } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "the choices must be an object" };
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (CHOICE_FIELDS.has(key)) continue;
    // Neither refusal repeats what was sent, not even the field's name: a name can be a value typed in the wrong place.
    if (secretWordKind(key)) return { ok: false, error: `the choices have no field for a password, code or token: ${NO_CREDENTIALS}` };
    return { ok: false, error: `the choices have a field they do not take: they are ${[...CHOICE_FIELDS].join(", ")}` };
  }
  const address = checkAddress(given.address);
  if (!address.ok) return address;
  const areas = checkAreas(given.areas);
  if (!areas.ok) return areas;
  const choices: GuidedChoices = {
    address: address.value,
    areas: areas.value,
    signIn: "none",
    care: "look-only",
    thoroughness: "normal",
  };

  if (given.journey !== undefined && !areas.value.includes("journey"))
    return { ok: false, error: 'a journey was written but "journey" is not chosen: choose it, or leave the journey empty' };
  if (areas.value.includes("journey")) {
    const journey = typeof given.journey === "string" ? given.journey.trim().replace(/\s+/g, " ") : "";
    if (!journey) return { ok: false, error: "describe the journey in a sentence, e.g. Buy the cheapest item and check the receipt" };
    if (journey.length > MAX_JOURNEY) return { ok: false, error: `the journey is longer than ${MAX_JOURNEY} characters` };
    if (holdsCredential(journey)) return { ok: false, error: `the journey holds what looks like a password, code or token: ${NO_CREDENTIALS}` };
    choices.journey = journey;
  }

  if (given.tickets !== undefined && !areas.value.includes("tickets"))
    return { ok: false, error: 'tickets were given but "tickets" is not chosen: choose it, or leave the tickets out' };
  if (areas.value.includes("tickets")) {
    if (!Array.isArray(given.tickets) || given.tickets.some((t) => typeof t !== "string"))
      return { ok: false, error: "paste the tickets to check, one per entry" };
    const tickets = (given.tickets as string[]).map((t) => t.trim()).filter(Boolean);
    if (tickets.length === 0) return { ok: false, error: "paste the tickets to check, one per entry" };
    if (tickets.length > MAX_TICKETS) return { ok: false, error: `one check reads at most ${MAX_TICKETS} tickets` };
    if (tickets.some((t) => t.length > MAX_TICKET_CHARS)) return { ok: false, error: `a ticket is longer than ${MAX_TICKET_CHARS} characters` };
    const which = tickets.findIndex(holdsCredential);
    if (which >= 0) return { ok: false, error: `ticket ${which + 1} holds what looks like a password, code or token: ${NO_CREDENTIALS}` };
    choices.tickets = tickets;
  }

  const signIn = oneOfOr(given.signIn, SIGN_INS, "none", "signIn");
  if (!signIn.ok) return signIn;
  choices.signIn = signIn.value;
  if (given.care === "destructive") return { ok: false, error: `that care level is not offered here. ${DESTRUCTIVE_NOT_OFFERED}` };
  const care = oneOfOr(given.care, CARES, "look-only", "care");
  if (!care.ok) return care;
  choices.care = care.value;
  const thoroughness = oneOfOr(given.thoroughness, THOROUGHNESSES, "normal", "thoroughness");
  if (!thoroughness.ok) return thoroughness;
  choices.thoroughness = thoroughness.value;
  return { ok: true, choices };
}

/**
 * When the person must confirm before a plan starts, and why. Look only:
 * never. May submit forms: when the address is not on this computer, since a
 * form sent to a live site can create a real record. May create test data:
 * always, on any address.
 */
export function confirmationReason(choices: Pick<GuidedChoices, "care" | "address">): ConfirmReason | null {
  if (choices.care === "may-create-test-data") return "creates-data";
  if (choices.care === "may-submit-forms" && !isLocalAddress(choices.address)) return "forms-on-remote-site";
  return null;
}

/** Whether a confirmation also asks the person to type a code it shows: only for creating data. */
export const CONFIRM_NEEDS_CODE: Record<ConfirmReason, boolean> = { "creates-data": true, "forms-on-remote-site": false };

const PLAN_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** "gp-" and 10 random characters. */
export function newPlanId(): string {
  const bytes = crypto.randomBytes(10);
  let id = "gp-";
  // 252 is the largest multiple of 36 below 256: a byte at or above it is redrawn, so every character is equally likely.
  for (let i = 0; i < 10; i++) {
    let b = bytes[i];
    while (b >= 252) b = crypto.randomBytes(1)[0];
    id += PLAN_ID_ALPHABET[b % 36];
  }
  return id;
}

/** Whether a string has the shape newPlanId makes. */
export function isPlanId(id: unknown): id is string {
  return typeof id === "string" && /^gp-[a-z0-9]{10}$/.test(id);
}

/** Text cut to a length with an ellipsis, so an objective fits scout_attach. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The run's objective in one sentence: the journey when there is one, and the
 * other chosen areas after it. The journey itself is kept whole in the
 * choices; only the objective is cut to scout_attach's length.
 */
export function guidedObjective(choices: Pick<GuidedChoices, "areas" | "journey">): string {
  const others = choices.areas.filter((a) => a !== "journey").map((a) => lowerFirst(AREA_LABEL[a]));
  const list = others.length <= 1 ? others.join("") : `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`;
  if (choices.journey) {
    // A journey written without a full stop gets one, so "Also check" starts a sentence of its own.
    const journey = /[.!?…]$/u.test(choices.journey) ? choices.journey : `${choices.journey}.`;
    return clip(others.length > 0 ? `${journey} Also check: ${list}.` : choices.journey, MAX_OBJECTIVE);
  }
  return clip(`Check ${list}.`, MAX_OBJECTIVE);
}

/**
 * The calls the agent makes, in order: sign in, attach, read the tickets, and
 * a phone-sized browser when other areas share the first. Each attach names the
 * plan, which is what lets it above observe while a guided plan is open.
 */
function guidedCalls(choices: GuidedChoices, mode: GuidedMode, objective: string, planId: string): GuidedCall[] {
  const calls: GuidedCall[] = [];
  const role = choices.signIn === "none" ? {} : { role: INTAKE_ROLE };
  if (choices.signIn !== "none") calls.push({ tool: "scout_login", args: { url: choices.address, ...role } });
  const phone = { viewportWidth: PHONE_VIEWPORT.width, viewportHeight: PHONE_VIEWPORT.height };
  const phoneOnly = choices.areas.length === 1 && choices.areas[0] === "phone";
  calls.push({ tool: "scout_attach", args: { url: choices.address, mode, ...role, objective, ...(phoneOnly ? phone : {}), planId } });
  // A rule between them, so each one given is read as its own ticket (as intake.ts does).
  if (choices.tickets) calls.push({ tool: "scout_tickets", args: { text: choices.tickets.join("\n\n---\n\n") } });
  if (choices.areas.includes("phone") && !phoneOnly) {
    calls.push({
      tool: "scout_attach",
      args: {
        url: choices.address,
        mode,
        ...role,
        session: PHONE_SESSION,
        objective: `${AREA_LABEL.phone}: ${lowerFirst(AREA_WHAT_HAPPENS.phone)}`,
        ...phone,
        planId,
      },
    });
  }
  return calls;
}

/**
 * The plan for a person's choices. It is built from the choices alone, so the
 * same choices always give the same plan apart from its id. A plan that needs
 * a confirmation starts unaccepted; only the server's form, answered by the
 * person, marks it accepted.
 *
 * The choices are checked again, and a plan is never built from ones
 * checkGuidedChoices refuses: an unknown care level would leave the attach
 * with no mode, and scout_attach reads a missing mode as read-only.
 */
export function buildGuidedPlan(given: GuidedChoices, planId: string = newPlanId()): GuidedPlan {
  const checked = checkGuidedChoices(given);
  if (!checked.ok) throw new Error(`buildGuidedPlan was given choices checkGuidedChoices refuses: ${checked.error}`);
  const choices = checked.choices;
  const mode = CARE_MODE[choices.care];
  const objective = guidedObjective(choices);
  const budget = { ...THOROUGHNESS_BUDGET[choices.thoroughness] };
  const areas = choices.areas.map((area) => {
    const heldBack = HELD_BACK[area][choices.care];
    return { area, label: AREA_LABEL[area], whatHappens: AREA_WHAT_HAPPENS[area], ...(heldBack ? { heldBack } : {}) };
  });
  const reason = confirmationReason(choices);
  const confirm = reason ? { reason, sentence: confirmSentence(reason, choices.address), accepted: false } : null;
  const tellPerson = [
    `${CARE_LABEL[choices.care]}: ${CARE_EXPLAIN[choices.care]}`,
    ...areas.filter((a) => a.heldBack).map((a) => `${a.label}: ${a.heldBack}`),
    ...(choices.signIn === "none" ? [] : [signInSentence(SIGN_IN_HINT[choices.signIn])]),
    budgetSentence(budget),
    ...(reason ? [CONFIRM_COMING[reason]] : []),
  ];
  return {
    planId,
    choices,
    mode,
    level: THOROUGHNESS_LEVEL[choices.thoroughness],
    objective,
    areas,
    confirm,
    tellPerson,
    calls: guidedCalls(choices, mode, objective, planId),
    budget,
  };
}

/** Choices to a plan in one step: the plan, or the sentence that says what to fix. */
export function guidedPlan(input: unknown, planId?: string): { ok: true; plan: GuidedPlan } | { ok: false; error: string } {
  const checked = checkGuidedChoices(input);
  return checked.ok ? { ok: true, plan: buildGuidedPlan(checked.choices, planId) } : checked;
}

// ---- The plans a server holds, the person's confirmation, and the gate on scout_attach ----
//
// ADR 24: a plan that needs a confirmation is accepted only by the person's
// answer to the server's own form (MCP elicitation). The server tools show the
// form and pass its outcome here; everything that decides what the outcome
// means, and what an attach may do while a guided plan is open, is below, so it
// is table-tested (guided-test for the confirmation, policy-test for the gate).

/** How many plans one server keeps. An older one is forgotten, and an attach that names it is then refused, never let through. */
export const MAX_PLANS = 50;

/**
 * The guided plans built in this server process, by id. Nothing else holds
 * them: they are never written to disk, and they end with the process. A plan
 * handed out is a copy, so the only way to mark one accepted is `accept`,
 * which only the confirmation's verdict calls.
 *
 * Once any plan has been built the store stays open for the rest of the
 * process, so that leaving a plan's id out of an attach is never a way round
 * its confirmation (see guidedAttachVerdict).
 */
export class GuidedPlans {
  private readonly plans = new Map<string, GuidedPlan>();
  private opened = false;

  /** Keeps a plan, which must be unaccepted, and opens the store. */
  add(plan: GuidedPlan): GuidedPlan {
    if (plan.confirm?.accepted) throw new Error("a guided plan is kept unaccepted: only the person's confirmation accepts it");
    if (this.plans.has(plan.planId)) throw new Error(`a guided plan with id ${plan.planId} is already kept`);
    this.plans.set(plan.planId, structuredClone(plan));
    while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value!);
    this.opened = true;
    return structuredClone(plan);
  }

  /** A copy of the plan, or undefined for an id this server does not hold. */
  get(planId: string): GuidedPlan | undefined {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : undefined;
  }

  /** Whether a guided plan has been built in this server: from then on an attach above observe must name an accepted one. */
  get open(): boolean {
    return this.opened;
  }

  /** Marks a kept plan's confirmation accepted. Called with a verdict that accepted it, and nothing else. */
  accept(planId: string, verdict: ConfirmVerdict): GuidedPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`no guided plan ${planId} is kept`);
    if (!verdict.accepted) throw new Error("a plan is accepted only by a verdict that accepted it");
    if (plan.confirm) plan.confirm.accepted = true;
    return structuredClone(plan);
  }

  /**
   * Ends a kept plan's acceptance, so the next check with it asks the person
   * again. Called when no session carries the plan any more (holdGuidedPlan):
   * one yes is one check, as design section 6.2 asks of a re-run.
   */
  spend(planId: string): void {
    const plan = this.plans.get(planId);
    if (plan?.confirm) plan.confirm.accepted = false;
  }
}

/**
 * Records which plan a session now carries (`undefined` for none, `null` when
 * the session closed), and spends the plan it carried before when no session
 * carries that one any more. Re-attaching a session with the plan it already
 * carries keeps it, so signing in again mid-check is not a new check.
 */
export function holdGuidedPlan(
  sessions: Map<string, { planId?: string }>,
  plans: Pick<GuidedPlans, "spend">,
  session: string,
  planId: string | undefined | null,
): void {
  const before = sessions.get(session)?.planId;
  if (planId === null) sessions.delete(session);
  else sessions.set(session, planId ? { planId } : {});
  if (before === undefined || before === planId) return;
  if (![...sessions.values()].some((s) => s.planId === before)) plans.spend(before);
}

/** The digits a confirmation for creating test data asks the person to type back. */
export const CONFIRM_CODE_LENGTH = 4;

/** A fresh code for one confirmation form: four random digits. It is a pause, not a secret (ADR 24). */
export function newConfirmCode(): string {
  return String(crypto.randomInt(0, 10 ** CONFIRM_CODE_LENGTH)).padStart(CONFIRM_CODE_LENGTH, "0");
}

/** The answer values the confirmation form offers. */
export const CONFIRM_VALUES = { yes: "yes", back: "back" } as const;

/**
 * The confirmation form for a plan, as an `elicitation/create` request's
 * message and requestedSchema: the sentence the person accepts, what the care
 * level may do there, and one choice with no default, so pressing Enter alone
 * accepts nothing. For creating test data it also has a field for the code
 * the message shows. Null for a plan that needs no confirmation.
 */
export function confirmForm(plan: GuidedPlan, code: string) {
  if (!plan.confirm) return null;
  const needsCode = CONFIRM_NEEDS_CODE[plan.confirm.reason];
  const message = [
    plan.confirm.sentence,
    "",
    CONFIRM_PREVIEW_HEADING,
    ...CARE_PREVIEW[plan.choices.care].map((line) => `  ${line}`),
    "",
    needsCode ? confirmCodeLine(code) : CONFIRM_ANSWER_LINE,
  ].join("\n");
  const yesTitle = needsCode ? CONFIRM_ANSWER.testCopy : CONFIRM_ANSWER.yes;
  return {
    message,
    requestedSchema: {
      type: "object" as const,
      properties: {
        answer: {
          type: "string" as const,
          title: CONFIRM_FIELD.answer.title,
          description: CONFIRM_FIELD.answer.description,
          oneOf: [
            { const: CONFIRM_VALUES.yes, title: yesTitle },
            { const: CONFIRM_VALUES.back, title: CONFIRM_ANSWER.back },
          ],
        },
        ...(needsCode
          ? {
              code: {
                type: "string" as const,
                title: CONFIRM_FIELD.code.title,
                description: CONFIRM_FIELD.code.description,
                maxLength: 20,
              },
            }
          : {}),
      },
      required: ["answer"],
    },
  };
}

/** How the confirmation form ended, as the server tool saw it. */
export type ConfirmFormOutcome =
  | { kind: "unsupported" }
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string }
  | { kind: "accepted"; content: Record<string, unknown> };

/** What a confirmation came to. `accepted` is true only for the person's yes (with the right code where one is asked), or a plan that needs none. */
export interface ConfirmVerdict {
  accepted: boolean;
  outcome: "not-needed" | "accepted" | "went-back" | "wrong-code" | "declined" | "cancelled" | "failed" | "unsupported";
  /** What to tell the person, in plain words. */
  tellPerson: string;
}

/**
 * What the person's answer to the confirmation form means. Only an accepted
 * form whose answer is yes accepts a plan, and for creating test data only
 * with the code the form showed, typed back. A form that was declined, closed,
 * failed or could not be shown leaves the plan unaccepted, and so does any
 * other answer: nothing here guesses a yes.
 */
export function confirmVerdict(plan: Pick<GuidedPlan, "confirm">, outcome: ConfirmFormOutcome, code: string): ConfirmVerdict {
  if (!plan.confirm) return { accepted: true, outcome: "not-needed", tellPerson: CONFIRM_SAYS["not-needed"] };
  const no = (o: Exclude<ConfirmVerdict["outcome"], "accepted" | "not-needed">): ConfirmVerdict => ({
    accepted: false,
    outcome: o,
    tellPerson: CONFIRM_SAYS[o],
  });
  if (outcome.kind !== "accepted") return no(outcome.kind);
  if (outcome.content.answer !== CONFIRM_VALUES.yes) return no("went-back");
  if (CONFIRM_NEEDS_CODE[plan.confirm.reason]) {
    const typed = outcome.content.code;
    // A code the server did not make is never matched: an empty one would otherwise equal an empty answer.
    if (!/^\d{4}$/.test(code) || typeof typed !== "string" || typed.trim() !== code) return no("wrong-code");
  }
  return { accepted: true, outcome: "accepted", tellPerson: CONFIRM_SAYS.accepted };
}

/** The write modes from the strictest to the loosest, as the attach gate compares them. */
const MODE_ORDER = ["observe", "read-only", "safe-write", "destructive"] as const;
type AnyMode = (typeof MODE_ORDER)[number];

function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/**
 * Whether scout_attach may go ahead while guided plans are kept.
 *
 * - No plan built in this server: yes, exactly as before (`plan` is absent).
 * - `observe` without a plan id: yes. Looking only is always allowed.
 * - Above `observe` without a plan id, once any plan has been built: no, so
 *   leaving the id out is not a way round a confirmation.
 * - A plan id this server does not hold: no, in any mode.
 * - A plan that needs a confirmation the person has not given: no, above
 *   `observe`.
 * - A mode above the plan's, or (above `observe`) an address on another site
 *   than the plan's: no.
 * - readPosts or trustedEmbeds, once any plan has been built: no, in any mode.
 *   Both loosen a mode, and no guided check takes them (design 6.1).
 */
export function guidedAttachVerdict(
  plans: Pick<GuidedPlans, "open" | "get">,
  input: { planId?: string; mode: AnyMode; url: string; readPosts?: readonly string[]; trustedEmbeds?: readonly string[] },
): { ok: true; plan?: GuidedPlan } | { ok: false; why: string } {
  const above = input.mode !== "observe";
  // Developer settings no guided check takes (design 6.1): readPosts lets named POSTs out of observe, and
  // trustedEmbeds lets frames' writes out of safe-write, so either would loosen a care level the person chose.
  if (plans.open) {
    const named = [input.readPosts?.length ? "readPosts" : "", input.trustedEmbeds?.length ? "trustedEmbeds" : ""].filter(Boolean);
    if (named.length > 0)
      return {
        ok: false,
        why: `a guided plan is open in this server, and ${named.join(" and ")} ${named.length > 1 ? "are developer settings" : "is a developer setting"} no guided check takes: attach without ${named.length > 1 ? "them" : "it"}. A developer who needs ${named.length > 1 ? "them" : "it"} sets ${named.length > 1 ? "them" : "it"} in a server with no guided plan.`,
      };
  }
  if (input.planId === undefined) {
    if (above && plans.open)
      return {
        ok: false,
        why: `a guided plan is open in this server, so an attach in "${input.mode}" must name it: pass the planId its scout_attach call lists. Without one, only mode "observe" is allowed.`,
      };
    return { ok: true };
  }
  const plan = isPlanId(input.planId) ? plans.get(input.planId) : undefined;
  if (!plan)
    return {
      ok: false,
      why: `this server holds no guided plan "${isPlanId(input.planId) ? input.planId : "(not a plan id)"}": build one with scout_guided_plan.`,
    };
  if (!above) return { ok: true, plan };
  if (plan.confirm && !plan.confirm.accepted)
    return {
      ok: false,
      why: `guided plan ${plan.planId} needs the person's confirmation before it may run in "${input.mode}": call scout_guided_confirm {"planId":"${plan.planId}"}, and the person answers its form. Until then only mode "observe" is allowed.`,
    };
  if (MODE_ORDER.indexOf(input.mode) > MODE_ORDER.indexOf(plan.mode))
    return { ok: false, why: `guided plan ${plan.planId} is for mode "${plan.mode}" at most; "${input.mode}" is above it.` };
  const want = originOf(plan.choices.address);
  if (want === null || originOf(input.url) !== want)
    return { ok: false, why: `guided plan ${plan.planId} is for ${want ?? plan.choices.address}; an attach above "observe" with it must be on that site.` };
  return { ok: true, plan };
}

/**
 * A plan as the agent reads it: what to tell the person, the confirmation
 * when one is still needed, the calls in order, and the limits to keep to.
 */
export function guidedPlanText(plan: GuidedPlan): string {
  const lines = [
    `Guided plan ${plan.planId}: ${CARE_LABEL[plan.choices.care]} (mode "${plan.mode}"), level "${plan.level}".`,
    "",
    "Tell the person, in these words:",
    ...plan.tellPerson.map((s) => `- ${s}`),
    "",
  ];
  let step = 0;
  const steps: string[] = [];
  if (plan.confirm && !plan.confirm.accepted) {
    steps.push(
      `Call scout_guided_confirm ${JSON.stringify({ planId: plan.planId })}. The person answers its form; you cannot answer it for them. ` +
        `Go on only if it says the plan is accepted. If it is not, nothing above mode "observe" may run with this plan: offer the person the same check in ${CARE_LABEL["look-only"]}.`,
    );
  } else if (plan.confirm) steps.push("The person has confirmed this plan.");
  for (const call of plan.calls) {
    const after =
      call.tool === "scout_attach"
        ? ", with projectPath as the method's setup says"
        : call.tool === "scout_login"
          ? ", which returns once they are signed in"
          : "";
    steps.push(`Call ${call.tool} ${JSON.stringify(call.args)}${after}.`);
  }
  steps.push(
    `As you start each area, call scout_session {area} with it: ${plan.areas.map((a) => `"${a.area}"`).join(", ")}. Where the care level holds a step back, stop there and say so.`,
  );
  steps.push(
    `Stop after at most ${plan.budget.minutes} minutes and ${plan.budget.pages} pages, then write the report with scout_report ${JSON.stringify({ level: plan.level, force: true })} if the limits ended the run, else ${JSON.stringify({ level: plan.level })}.`,
  );
  lines.push("Then, in order:", ...steps.map((s) => `${(step += 1)}. ${s}`));
  return lines.join("\n");
}

/**
 * Why a session may not be marked as working on an area, or null when it may.
 * A session attached with a plan works only on that plan's areas; one attached
 * without a plan may name any area.
 */
export function areaRefusal(plan: Pick<GuidedPlan, "planId" | "areas"> | undefined, area: CheckArea): string | null {
  if (!plan || plan.areas.some((a) => a.area === area)) return null;
  return `guided plan ${plan.planId} does not check "${area}": its areas are ${plan.areas.map((a) => `"${a.area}"`).join(", ")}`;
}
