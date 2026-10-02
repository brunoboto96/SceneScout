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
