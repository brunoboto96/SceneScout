/**
 * The questions a run starts with when the person gave no settings.
 *
 * Someone who is not a developer should not have to know what "observe" or a
 * storage state is. When the skill is invoked with none of its flags, the agent
 * asks four plain questions instead, and each answer chooses a setting: the
 * address chooses the URL, the sign-in answer chooses whether to call
 * scout_login and attach by role, what to check chooses the objective (and, for
 * tickets, the criteria scout_tickets reads so the report answers each), and real
 * data chooses the write mode. A developer who passes flags is asked nothing.
 *
 * The skill (skills/scenescout/SKILL.md) states the same questions and the same
 * mapping in words; guide-test holds that text to this module, so the two
 * cannot drift. The `explore` prompt asks them through `introQuestions`.
 *
 * Where the client can show a form, scout_intake asks the guided start instead
 * (below): the same address and sign-in, what to check as areas, and a care
 * level and thoroughness in plain words, which become a guided plan (ADR 24).
 */
import { AREA_LABEL, AREA_WHAT_HAPPENS, CARE_EXPLAIN, CARE_LABEL, DESTRUCTIVE_NOT_OFFERED, THOROUGHNESS_LABEL } from "./engine/guided-words.js";
// guided.ts imports this module too; what is taken from it here is used only inside functions, so the cycle is safe.
import {
  caresWithin,
  checkGuidedChoices,
  MAX_ADDRESS,
  MAX_JOURNEY,
  type Care,
  type CheckArea,
  type GuidedChoices,
  type Thoroughness,
} from "./engine/guided.js";
import type { WriteMode } from "./engine/policy.js";

/** The flags the skill reads. Any one given means the person chose settings themselves. */
export const SKILL_FLAGS = ["url", "role", "focus", "level", "observe", "read-only", "safe-write", "allow-destructive"] as const;
export type SkillFlag = (typeof SKILL_FLAGS)[number];

type QuestionId = "address" | "sign-in" | "what-to-check" | "real-data";

export interface IntakeQuestion {
  id: QuestionId;
  /** What the agent asks, in the person's words. */
  ask: string;
  /** The setting the answer chooses. */
  sets: "url" | "role" | "objective" | "mode";
  /** The flags that already say what this question would find out. */
  flags: readonly SkillFlag[];
}

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  { id: "address", ask: "What is the address of the site?", sets: "url", flags: ["url"] },
  {
    id: "sign-in",
    ask: "Do you need to sign in to use it? If so, how: Google or Microsoft single sign-on, an email and password, or a one-time code?",
    sets: "role",
    flags: ["role"],
  },
  {
    id: "what-to-check",
    ask: 'What should I check? Upload or paste the tickets, or describe it in a sentence. Say "everything" to look at the whole site.',
    sets: "objective",
    flags: ["focus", "level"],
  },
  {
    id: "real-data",
    ask: "Does the site hold real data, such as real customers, orders or records?",
    sets: "mode",
    flags: ["observe", "read-only", "safe-write", "allow-destructive"],
  },
];

/** The skill's flags present in what the person typed after the command, in the order SKILL_FLAGS lists them. */
export function flagsGiven(argumentText: string): SkillFlag[] {
  const seen = new Set<string>();
  // A flag is `--name` standing alone or followed by `=` or a space; `--urlx` and a word inside a value are not flags.
  for (const m of argumentText.matchAll(/(?<![\w-])--([a-z][a-z-]*)(?![\w-])/g)) seen.add(m[1]);
  return SKILL_FLAGS.filter((f) => seen.has(f));
}

/**
 * The questions to ask before setup. None when any flag was given: a person who
 * passes flags has chosen settings, and what they left out takes its default.
 */
export function questionsToAsk(argumentText: string): IntakeQuestion[] {
  return flagsGiven(argumentText).length > 0 ? [] : [...INTAKE_QUESTIONS];
}

export type SignInAnswer = "none" | "sso" | "password" | "one-time-code";
export type RealDataAnswer = "yes" | "no" | "unsure";
type WhatToCheck = { tickets: readonly string[] } | { description: string } | "everything";

export interface IntakeAnswers {
  address: string;
  signIn: SignInAnswer;
  whatToCheck: WhatToCheck;
  realData: RealDataAnswer;
}

/** The role a plain-question run saves its sign-in under; any later run that asks for it reuses that login. */
export const INTAKE_ROLE = "user";

/** What a sign-in answer tells the person before the window opens. */
export const SIGN_IN_HINT: Record<Exclude<SignInAnswer, "none">, string> = {
  sso: "sign in with Google or Microsoft as you normally would",
  password: "sign in with your email and password as you normally would",
  "one-time-code": "sign in as you normally would and enter the code when it arrives",
};

export interface IntakeSettings {
  /** null when the site needs no sign-in. Otherwise the agent calls scout_login with these first. */
  login: { tool: "scout_login"; url: string; role: string; tellUser: string } | null;
  /** What scout_attach is called with. */
  attach: { url: string; mode: "observe" | "read-only"; role?: string; objective: string };
  /** Only for a ticket or a description: the area to keep to. */
  focus?: string;
  /** Only for tickets: read them with scout_tickets once attached, so the report answers each acceptance criterion. */
  readTickets?: { tool: "scout_tickets"; text: string };
}

/**
 * The settings the four answers choose. Real data, or an answer that is not
 * sure, is observe: nothing but GET requests leaves the page. Only a plain no
 * allows read-only, and plain answers never reach safe-write or destructive,
 * which need the person to ask for them by name.
 */
export function settingsFromAnswers(a: IntakeAnswers): IntakeSettings {
  const url = a.address.trim();
  if (!url) throw new Error("the address is empty: ask for it again before attaching");
  const mode = a.realData === "no" ? "read-only" : "observe";
  const login =
    a.signIn === "none" ? null : { tool: "scout_login" as const, url, role: INTAKE_ROLE, tellUser: `A browser window will open: ${SIGN_IN_HINT[a.signIn]}.` };
  let objective = "Explore the whole site";
  let focus: string | undefined;
  let readTickets: IntakeSettings["readTickets"];
  if (a.whatToCheck !== "everything") {
    if ("tickets" in a.whatToCheck) {
      const tickets = a.whatToCheck.tickets.map((t) => t.trim()).filter(Boolean);
      if (tickets.length === 0) throw new Error("no tickets were given: ask what to check again, or explore the whole site");
      focus = tickets.join("; ");
      objective = `Check the tickets: ${focus}`;
      // A rule between them, so each one given is read as its own ticket.
      readTickets = { tool: "scout_tickets", text: tickets.join("\n\n---\n\n") };
    } else {
      focus = a.whatToCheck.description.trim();
      if (!focus) throw new Error("the description is empty: ask what to check again, or explore the whole site");
      objective = focus;
    }
  }
  return {
    login,
    attach: { url, mode, ...(login ? { role: login.role } : {}), objective },
    ...(focus ? { focus } : {}),
    ...(readTickets ? { readTickets } : {}),
  };
}

/** The questions as a numbered list, the way the explore prompt and the skill put them. */
export function introQuestions(): string {
  return INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q.ask}`).join("\n");
}

// ── The guided start as one form ─────────────────────────────────────────────
//
// A client that can show a form (MCP elicitation, form mode) gets the guided
// start through scout_intake: the address, what to check, a journey, tickets,
// how the person signs in, how careful to be and how thorough. The answers are
// GuidedChoices (src/engine/guided.ts), and the tool builds the plan from them;
// a care level that writes is then confirmed by the person in a second form
// (scout_guided_confirm, ADR 24). Every other client, and a person who declines
// or dismisses the form, gets the four plain questions above as text for the
// agent to ask in chat, mapped by settingsFromAnswers as before.
// Specification: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
// (the version the SDK speaks; the 2026-07-28 revision keeps the same capability,
// schema subset and three actions). Two of its rules shape this:
// - a server MUST NOT send a mode the client did not declare, and an empty
//   `elicitation` capability means form mode only (formElicitationSupported);
// - a server MUST NOT ask for passwords, API keys or tokens in form mode. The
//   form asks HOW the person signs in, never with what: the sign-in itself is
//   scout_login's window.
// What to check is one yes-or-no field per area rather than a multi-select:
// booleans are in every revision of form mode, so every client that shows a
// form can show these.

/** The tool that asks the questions, as a form where the client can show one. */
export const INTAKE_TOOL = "scout_intake";

/** What a client declared under `elicitation` in its capabilities, as far as this module needs to know. */
export interface ElicitationCapability {
  form?: object;
  url?: object;
}

/**
 * Whether the client can show a form. Declared `form` says so; an empty
 * `elicitation` object is form mode by the specification's backwards-compatibility
 * rule; `url` alone, or no `elicitation` at all, is not.
 */
export function formElicitationSupported(capabilities: { elicitation?: ElicitationCapability } | undefined): boolean {
  const e = capabilities?.elicitation;
  if (!e || typeof e !== "object") return false;
  return e.form !== undefined || e.url === undefined;
}

/** The form's yes-or-no fields, one per area that needs no text, in the order the areas are listed. */
export const AREA_FIELDS = [
  { field: "checkSignIn", area: "sign-in", default: true },
  { field: "checkForms", area: "forms", default: true },
  { field: "checkBrokenPages", area: "broken-pages", default: true },
  { field: "checkPhone", area: "phone", default: false },
] as const satisfies ReadonlyArray<{ field: string; area: CheckArea; default: boolean }>;

/** The form's fields, as the client returns them on accept. */
interface IntakeFormContent {
  address?: unknown;
  checkSignIn?: unknown;
  checkForms?: unknown;
  checkBrokenPages?: unknown;
  checkPhone?: unknown;
  journey?: unknown;
  tickets?: unknown;
  signIn?: unknown;
  care?: unknown;
  thoroughness?: unknown;
}

const choice = <T extends string>(value: T, title: string) => ({ const: value, title });
const askOf = (id: QuestionId): string => INTAKE_QUESTIONS.find((q) => q.id === id)!.ask;

/** Every value the form offers for a choice, with the words the person sees. */
export const FORM_CHOICES = {
  signIn: [
    choice<SignInAnswer>("none", "No sign-in"),
    choice<SignInAnswer>("sso", "Google or Microsoft single sign-on"),
    choice<SignInAnswer>("password", "An email and password"),
    choice<SignInAnswer>("one-time-code", "A one-time code"),
  ],
  care: [
    choice<Care>("look-only", CARE_LABEL["look-only"]),
    choice<Care>("may-submit-forms", CARE_LABEL["may-submit-forms"]),
    choice<Care>("may-create-test-data", CARE_LABEL["may-create-test-data"]),
  ],
  thoroughness: [
    choice<Thoroughness>("quick", THOROUGHNESS_LABEL.quick),
    choice<Thoroughness>("normal", THOROUGHNESS_LABEL.normal),
    choice<Thoroughness>("thorough", THOROUGHNESS_LABEL.thorough),
  ],
} as const;

/** What the form says above its fields. */
export const INTAKE_FORM_MESSAGE =
  "Before SceneScout starts: the site, what to check, and how careful to be. It never asks for a password here: if the site needs one, a browser window opens later for you to sign in as you normally would.";

/** The words under "How careful", one sentence per care level, so the choice is explained where it is made. */
export function careFieldDescription(maxMode?: WriteMode): string {
  return ["How careful should I be?", ...careChoices(maxMode).map((c) => `${c.title}: ${CARE_EXPLAIN[c.const]}`), DESTRUCTIVE_NOT_OFFERED].join(" ");
}

/** The care levels the form offers: those the SceneScout config's maxMode allows (all of them with no config). */
function careChoices(maxMode?: WriteMode) {
  const allowed = caresWithin(maxMode);
  return FORM_CHOICES.care.filter((c) => allowed.includes(c.const));
}

/**
 * The form, as an `elicitation/create` request's `requestedSchema`: a flat
 * object of strings, yes-or-no fields and single-choice lists, the only shapes
 * form mode allows. `address` starts filled in when the agent already knows
 * it. The care level starts at Look only and the thoroughness at Normal, the
 * least-harm defaults; how the person signs in has no default, so it is chosen.
 */
export function intakeFormSchema(knownAddress?: string, maxMode?: WriteMode) {
  const address = knownAddress?.trim();
  const areaFields = Object.fromEntries(
    AREA_FIELDS.map((f) => [f.field, { type: "boolean" as const, title: AREA_LABEL[f.area], description: AREA_WHAT_HAPPENS[f.area], default: f.default }]),
  ) as Record<(typeof AREA_FIELDS)[number]["field"], { type: "boolean"; title: string; description: string; default: boolean }>;
  return {
    type: "object" as const,
    properties: {
      address: {
        type: "string" as const,
        title: "Address",
        description: askOf("address"),
        minLength: 1,
        maxLength: MAX_ADDRESS,
        ...(address ? { default: address } : {}),
      },
      ...areaFields,
      journey: {
        type: "string" as const,
        title: AREA_LABEL.journey,
        description: "Optional: a journey to follow, in a sentence, e.g. Buy the cheapest item and check the receipt.",
        maxLength: MAX_JOURNEY,
      },
      tickets: {
        type: "string" as const,
        title: AREA_LABEL.tickets,
        description: "Optional: paste tickets to check, with a line of --- between them. Each acceptance criterion is answered.",
      },
      signIn: { type: "string" as const, title: "Sign-in", description: askOf("sign-in"), oneOf: [...FORM_CHOICES.signIn] },
      care: { type: "string" as const, title: "How careful", description: careFieldDescription(maxMode), oneOf: careChoices(maxMode), default: "look-only" },
      thoroughness: {
        type: "string" as const,
        title: "How thorough",
        description: "A quick look, a normal check, or a thorough one. Each stops at its own time and page limits.",
        oneOf: [...FORM_CHOICES.thoroughness],
        default: "normal",
      },
    },
    required: ["address", "signIn", "care", "thoroughness"],
  };
}

const oneOf = <T extends string>(list: ReadonlyArray<{ const: T }>, value: unknown): T | undefined => list.find((c) => c.const === value)?.const;

/** Pasted tickets, split on a line of three or more dashes, empty ones dropped. */
export function splitTickets(text: string): string[] {
  return text
    .split(/^[ \t]*-{3,}[ \t]*$/m)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** How a form round ended, as scout_intake saw it. */
export type FormOutcome =
  { kind: "unsupported" } | { kind: "declined" } | { kind: "cancelled" } | { kind: "failed"; error: string } | { kind: "accepted"; content: IntakeFormContent };

/**
 * What scout_intake hands on: the person's choices to build a plan from, one
 * sentence saying what to fix in the form, or the plain questions to ask in chat.
 */
export type IntakeReply =
  { kind: "choices"; choices: GuidedChoices } | { kind: "fix"; error: string } | { kind: "ask"; questions: IntakeQuestion[]; known: string[]; why: string };

/**
 * What a form round comes to. Accepted answers become GuidedChoices, checked
 * by checkGuidedChoices: a yes-or-no field ticks its area, and a journey or
 * tickets written in their boxes choose those areas. Answers it refuses come
 * back as the one sentence that says what to fix, never as a guess. Anything
 * else asks the four plain questions in chat, as before.
 */
export function intakeFromForm(outcome: FormOutcome, maxMode?: WriteMode): IntakeReply {
  const all = (why: string): IntakeReply => ({ kind: "ask", questions: [...INTAKE_QUESTIONS], known: [], why });
  if (outcome.kind === "unsupported") return all("this client cannot show a form");
  if (outcome.kind === "declined") return all("the person declined the form");
  if (outcome.kind === "cancelled") return all("the person closed the form without answering");
  if (outcome.kind === "failed") return all(`the form failed: ${outcome.error}`);
  const c = outcome.content;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const journey = text(c.journey);
  const tickets = splitTickets(text(c.tickets));
  const areas: CheckArea[] = AREA_FIELDS.filter((f) => c[f.field] === true).map((f) => f.area);
  if (journey) areas.push("journey");
  if (tickets.length > 0) areas.push("tickets");
  const signIn = oneOf(FORM_CHOICES.signIn, c.signIn);
  if (!signIn) return { kind: "fix", error: "choose how you sign in, or No sign-in" };
  const checked = checkGuidedChoices(
    {
      address: c.address,
      areas,
      ...(journey ? { journey } : {}),
      ...(tickets.length > 0 ? { tickets } : {}),
      signIn,
      // A care level or a thoroughness the form never offered is refused by name in checkGuidedChoices, not replaced by a default.
      ...(c.care !== undefined ? { care: c.care } : {}),
      ...(c.thoroughness !== undefined ? { thoroughness: c.thoroughness } : {}),
    },
    { maxMode },
  );
  return checked.ok ? { kind: "choices", choices: checked.choices } : { kind: "fix", error: checked.error };
}

/** scout_intake's reply as text when no plan was built: the questions to ask in chat, or what to fix in the form. */
export function intakeReplyText(reply: Exclude<IntakeReply, { kind: "choices" }>): string {
  if (reply.kind === "fix")
    return [
      `The form came back with answers that cannot be used: ${reply.error}.`,
      `Tell the person that, in those words, and call ${INTAKE_TOOL} again (with url when they gave it) so they can change it. Nothing was started.`,
    ].join("\n");
  const numbered = reply.questions.map((q, i) => `${i + 1}. ${q.ask}`).join("\n");
  return [
    `No settings from a form (${reply.why}). Ask the person ${reply.questions.length === 1 ? "this question" : "these questions"} in chat, in one message, then choose the settings from the answers as the method says.`,
    ...(reply.known.length > 0 ? ["", "Already answered in the form:", ...reply.known.map((k) => `- ${k}`)] : []),
    "",
    numbered,
  ].join("\n");
}
