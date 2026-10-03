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
 */

/** The flags the skill reads. Any one given means the person chose settings themselves. */
export const SKILL_FLAGS = ["url", "role", "focus", "level", "observe", "read-only", "safe-write", "allow-destructive"] as const;
export type SkillFlag = (typeof SKILL_FLAGS)[number];

export type QuestionId = "address" | "sign-in" | "what-to-check" | "real-data";

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
export type WhatToCheck = { tickets: readonly string[] } | { description: string } | "everything";

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

// ── The questions as one form ────────────────────────────────────────────────
//
// A client that can show a form (MCP elicitation, form mode) gets the four
// questions as one, through scout_intake; every other client, and a person who
// declines or dismisses the form, gets them as text for the agent to ask in
// chat. Specification: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
// (the version the SDK speaks; the 2026-07-28 revision keeps the same capability,
// schema subset and three actions). Two of its rules shape this:
// - a server MUST NOT send a mode the client did not declare, and an empty
//   `elicitation` capability means form mode only (formElicitationSupported);
// - a server MUST NOT ask for passwords, API keys or tokens in form mode. The
//   form asks HOW the person signs in, never with what: the sign-in itself is
//   scout_login's window.

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

/** What the person picks for what to check. The free text is in `details`. */
export type CheckKind = "everything" | "description" | "tickets";

/** The form's fields, as the client returns them on accept. */
export interface IntakeFormContent {
  address?: unknown;
  signIn?: unknown;
  whatToCheck?: unknown;
  details?: unknown;
  realData?: unknown;
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
  whatToCheck: [
    choice<CheckKind>("everything", "Everything: the whole site"),
    choice<CheckKind>("description", "What I describe below"),
    choice<CheckKind>("tickets", "The tickets I paste below"),
  ],
  realData: [choice<RealDataAnswer>("yes", "Yes"), choice<RealDataAnswer>("no", "No"), choice<RealDataAnswer>("unsure", "Not sure")],
} as const;

/** What the form says above its fields. */
export const INTAKE_FORM_MESSAGE =
  "Four questions before SceneScout starts testing. It never asks for a password here: if the site needs one, a browser window opens later for you to sign in as you normally would.";

/**
 * The form, as an `elicitation/create` request's `requestedSchema`: a flat object
 * of strings and single-choice lists, the only shapes form mode allows. `address`
 * starts filled in when the agent already knows it. Real data starts at "Not sure",
 * which tests as carefully as "Yes".
 */
export function intakeFormSchema(knownAddress?: string) {
  const address = knownAddress?.trim();
  return {
    type: "object" as const,
    properties: {
      address: { type: "string" as const, title: "Address", description: askOf("address"), minLength: 1, ...(address ? { default: address } : {}) },
      signIn: { type: "string" as const, title: "Sign-in", description: askOf("sign-in"), oneOf: [...FORM_CHOICES.signIn] },
      whatToCheck: {
        type: "string" as const,
        title: "What to check",
        description: "What should I check?",
        oneOf: [...FORM_CHOICES.whatToCheck],
        default: "everything",
      },
      details: {
        type: "string" as const,
        title: "Description or tickets",
        description:
          "Describe what to check in a sentence, or paste the tickets with a line of --- between them. To upload a file of tickets instead, leave this empty and I will ask for it.",
      },
      realData: { type: "string" as const, title: "Real data", description: askOf("real-data"), oneOf: [...FORM_CHOICES.realData], default: "unsure" },
    },
    required: ["address", "signIn", "whatToCheck", "realData"],
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

/** What scout_intake hands the agent: settings to use, or questions to ask in chat. */
export type IntakeReply = { kind: "settings"; settings: IntakeSettings } | { kind: "ask"; questions: IntakeQuestion[]; known: string[]; why: string };

const SIGN_IN_WORDS: Record<SignInAnswer, string> = {
  none: "no sign-in",
  sso: "Google or Microsoft single sign-on",
  password: "an email and password",
  "one-time-code": "a one-time code",
};

/**
 * What a form round comes to. Accepted answers become settings through
 * settingsFromAnswers. Anything else asks in chat: all four questions when
 * there was no form or the person turned it down, and only what is still
 * missing when the form came back without it (tickets to upload, an empty
 * description). An answer is never guessed.
 */
export function intakeFromForm(outcome: FormOutcome): IntakeReply {
  const all = (why: string): IntakeReply => ({ kind: "ask", questions: [...INTAKE_QUESTIONS], known: [], why });
  if (outcome.kind === "unsupported") return all("this client cannot show a form");
  if (outcome.kind === "declined") return all("the person declined the form");
  if (outcome.kind === "cancelled") return all("the person closed the form without answering");
  if (outcome.kind === "failed") return all(`the form failed: ${outcome.error}`);
  const c = outcome.content;
  const address = typeof c.address === "string" ? c.address.trim() : "";
  const signIn = oneOf(FORM_CHOICES.signIn, c.signIn);
  const kind = oneOf(FORM_CHOICES.whatToCheck, c.whatToCheck);
  const realData = oneOf(FORM_CHOICES.realData, c.realData);
  const details = typeof c.details === "string" ? c.details.trim() : "";
  let whatToCheck: WhatToCheck | undefined;
  // "Everything" with text in the box is a contradiction (the choice starts on everything, so pasted tickets
  // would be dropped unseen): asked again rather than guessed either way.
  if (kind === "everything" && !details) whatToCheck = "everything";
  else if (kind === "description" && details) whatToCheck = { description: details };
  else if (kind === "tickets" && splitTickets(details).length > 0) whatToCheck = { tickets: splitTickets(details) };
  const missing = INTAKE_QUESTIONS.filter(
    (q) =>
      (q.id === "address" && !address) || (q.id === "sign-in" && !signIn) || (q.id === "what-to-check" && !whatToCheck) || (q.id === "real-data" && !realData),
  );
  if (!address || !signIn || !whatToCheck || !realData) {
    const known = [
      address ? `Address: ${address}` : "",
      signIn ? `Sign-in: ${SIGN_IN_WORDS[signIn]}` : "",
      kind === "everything" && details
        ? "What to check: everything was chosen, but there is text in the box too"
        : kind
          ? `What to check: ${kind}${whatToCheck ? "" : ", not given yet"}`
          : "",
      realData ? `Real data: ${FORM_CHOICES.realData.find((r) => r.const === realData)!.title.toLowerCase()}` : "",
    ].filter(Boolean);
    return { kind: "ask", questions: missing, known, why: "the form came back without every answer" };
  }
  return { kind: "settings", settings: settingsFromAnswers({ address, signIn, whatToCheck, realData }) };
}

/** scout_intake's reply as text: the calls to make in order, or the questions to ask in chat. */
export function intakeReplyText(reply: IntakeReply): string {
  if (reply.kind === "ask") {
    const numbered = reply.questions.map((q, i) => `${i + 1}. ${q.ask}`).join("\n");
    return [
      `No settings from a form (${reply.why}). Ask the person ${reply.questions.length === 1 ? "this question" : "these questions"} in chat, in one message, then choose the settings from the answers as the method says.`,
      ...(reply.known.length > 0 ? ["", "Already answered in the form:", ...reply.known.map((k) => `- ${k}`)] : []),
      "",
      numbered,
    ].join("\n");
  }
  const s = reply.settings;
  const steps: string[] = [];
  if (s.login) {
    steps.push(`Tell the person: "${s.login.tellUser}"`);
    steps.push(`Call ${s.login.tool} ${JSON.stringify({ url: s.login.url, role: s.login.role })}, which returns once they are signed in.`);
  }
  steps.push(`Call scout_attach ${JSON.stringify(s.attach)}, with projectPath as the method's setup says.`);
  if (s.readTickets) steps.push(`Once attached, read the tickets: ${s.readTickets.tool} ${JSON.stringify({ text: s.readTickets.text })}.`);
  if (s.focus) steps.push(`Keep to this area: ${s.focus}`);
  return ["The person answered the form. Use these settings; do not ask the questions again.", ...steps.map((step, i) => `${i + 1}. ${step}`)].join("\n");
}
