/**
 * MCP prompts other than the testing method.
 *
 * `explore` lives in playbook.ts because its text is the skill. `live` and
 * `login` are short instructions: hand back the loopback live-view address,
 * or call scout_login for a role. Neither accepts a password.
 *
 * The guided prompts (`check-my-site`, `recheck`, `team-report`,
 * `file-tickets`, `is-it-safe`) are the chat's entry points for a person who
 * does not write prompts (docs/design/non-technical-assistant.md, 3.5). Every
 * sentence a person reads from them comes from guided-words.ts, so the chat
 * and the Code tab's panel say the same things.
 *
 * The protocol server in tools/guide.ts lists them all; the SDK prompt helper
 * is not used, because it rejects a request that omits `arguments`.
 */
import { CARES, caresWithin, checkAddress, type Care } from "./engine/guided.js";
import { ACTION_PROMPT, CARE_LABEL, careCapSentence, NOT_YET, PROMPT_TITLE, SAFETY_EXPLAINER } from "./engine/guided-words.js";
import type { WriteMode } from "./engine/policy.js";
import { validateRoleName } from "./engine/profiles.js";

export const LIVE_PROMPT = "live";
export const LOGIN_PROMPT = "login";

/** An argument as MCP lists it. `required: false` is still listed, so a host shows the field and accepts it being left out. */
export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

/** `live` takes nothing. A password field here would ask the person for a credential the live view does not use. */
export const LIVE_PROMPT_ARGUMENTS: PromptArgument[] = [];

/** `login` names a role, and the app's address when the caller has one. There is no password argument. */
export const LOGIN_PROMPT_ARGUMENTS: PromptArgument[] = [
  {
    name: "role",
    description: "The name to save the sign-in under, e.g. admin. scout_attach { role } uses it afterwards. Not a password.",
    required: true,
  },
  {
    name: "url",
    description: "The app's address or its sign-in page, when you have it, e.g. http://localhost:3000. Omit when the conversation already has it.",
    required: false,
  },
];

/**
 * Argument names that would carry a credential. Matched on the name only, so
 * a refusal can name the argument without repeating the value the client sent.
 */
const CREDENTIAL_ARGUMENT = /^(?:password|passwd|pass|secret|token|credential|credentials|otp|totp|mfa|apikey|api_key)$/i;

function refuseCredentialArguments(args: Record<string, unknown> | undefined): void {
  if (!args) return;
  for (const key of Object.keys(args)) {
    if (CREDENTIAL_ARGUMENT.test(key)) {
      throw new Error(`this prompt does not take ${key}: never pass a password or any other credential`);
    }
  }
}

/**
 * The opening message of the `live` prompt. The address itself is printed by
 * the engine on tool results (`Live view: http://127.0.0.1:…`); this only
 * tells the model to hand that line back. Any argument is refused.
 */
export function livePrompt(args: Record<string, unknown> | undefined): string {
  refuseCredentialArguments(args);
  const given = Object.keys(args ?? {}).filter((key) => args?.[key] !== undefined);
  if (given.length > 0) throw new Error("the live prompt takes no arguments");
  return (
    "Return the loopback live-view URL for the current session.\n\n" +
    "The live view is one address for every session of this run. It is served on 127.0.0.1 only, and a tool result prints it as a line starting " +
    '"Live view: http://127.0.0.1:". If this conversation does not already contain that line, call scout_session with no arguments and read it from the result. ' +
    "Calling scout_session with a name would change the default session; do not pass one.\n\n" +
    "Reply with that address. Where you can open a URL for the user, you may open it as well. " +
    "If the result says the live view is unavailable, say so and do not invent an address.\n\n" +
    "Do not ask for a password or any other credential. This prompt takes none."
  );
}

/** An http(s) address with no userinfo. The raw string is returned only after that check, so a refusal never quotes a password embedded in it. */
function publicHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be an http or https address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https URLs can be opened (got ${url.protocol})`);
  if (url.username || url.password) throw new Error("put no credentials in the URL: sign in in the window instead");
  return raw;
}

/**
 * The opening message of the `login` prompt: call scout_login for the role and
 * wait the way that tool already waits. A missing or illegal role is refused.
 * A password argument is refused without the value being repeated.
 */
export function loginPrompt(args: Record<string, unknown> | undefined): string {
  refuseCredentialArguments(args);
  const given = args ?? {};
  const unknown = Object.keys(given).filter((key) => key !== "role" && key !== "url");
  if (unknown.length > 0) throw new Error("the login prompt takes role and url only");
  const checked = validateRoleName(typeof given.role === "string" ? given.role.trim() : given.role);
  if (!checked.ok) throw new Error(checked.error);
  const url = publicHttpUrlOrNone(typeof given.url === "string" ? given.url.trim() : "");
  // JSON so a quote in the address cannot rewrite the instruction. The address has already been refused when it carries credentials.
  const where = url
    ? `Call scout_login with ${JSON.stringify({ role: checked.role, url })}.`
    : `Call scout_login with role ${JSON.stringify(checked.role)} and the app's address as url. ` +
      "Use the address this conversation already has; if it has none, ask for the app's address or its sign-in page, then pass that as url.";
  return (
    `Sign in as the role "${checked.role}" by calling scout_login. ` +
    "Do not ask for a password, and do not type credentials yourself: the person signs in in the browser window the tool opens.\n\n" +
    'Tell them first, in plain words: "A browser window is opening. Sign in there as you normally would; it closes by itself once you are in."\n\n' +
    `${where}\n\n` +
    "The call returns once they are signed in and the login is saved, or after its wait with the window still open. " +
    `When it is still waiting, call scout_login again with the same role ("${checked.role}") to keep waiting, once they say they are done or to check. ` +
    "Never pass a password."
  );
}

/** `publicHttpUrl("")` would throw. An omitted url is the optional argument left out, not an illegal address. */
function publicHttpUrlOrNone(raw: string): string {
  return raw ? publicHttpUrl(raw) : "";
}

// ---- The guided prompts ----

export const CHECK_MY_SITE_PROMPT = "check-my-site";
export const RECHECK_PROMPT = "recheck";
export const TEAM_REPORT_PROMPT = "team-report";
export const FILE_TICKETS_PROMPT = "file-tickets";
export const IS_IT_SAFE_PROMPT = "is-it-safe";

export type GuidedPromptName = keyof typeof PROMPT_TITLE;

/** A prompt as prompts/list shows it. */
export interface ListedPrompt {
  name: GuidedPromptName;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

/** What caps the guided prompts: the loosest care level whoever set SceneScout up allows. No cap offers every care level. */
export interface GuidedPromptOptions {
  maxCare?: Care;
}

/** The guided prompts in the order the chat lists them. None takes a password, a code or a token. */
export const GUIDED_PROMPTS: readonly ListedPrompt[] = [
  {
    name: CHECK_MY_SITE_PROMPT,
    title: PROMPT_TITLE[CHECK_MY_SITE_PROMPT],
    description:
      "Start a guided check: a short form asks the address, what to check, how careful to be (Look only is the default) and how thorough; then the check runs and ends with each problem as a card. Never asks for a password.",
    arguments: [
      {
        name: "url",
        description:
          "The site's address, when you have it, e.g. https://staging.example.com. The form starts with it filled in. No user name or password in it.",
        required: false,
      },
    ],
  },
  {
    name: RECHECK_PROMPT,
    title: PROMPT_TITLE[RECHECK_PROMPT],
    description: "Check the problems earlier checks left open again, in Look only, and say which are gone, which are still there and which changed.",
    arguments: [],
  },
  {
    name: TEAM_REPORT_PROMPT,
    title: PROMPT_TITLE[TEAM_REPORT_PROMPT],
    description: "Write the report in plain words, a page that opens in any browser, and say where it is. Nothing is sent anywhere.",
    arguments: [],
  },
  {
    name: FILE_TICKETS_PROMPT,
    title: PROMPT_TITLE[FILE_TICKETS_PROMPT],
    description:
      "Show the problems, then give the command a developer runs to file them as GitHub or Jira issues, after a dry run that lists what it would file. Files nothing from the chat, and never asks for a token.",
    arguments: [{ name: "to", description: "Where the team keeps its tickets: github or jira. Leave it out to see both.", required: false }],
  },
  {
    name: IS_IT_SAFE_PROMPT,
    title: PROMPT_TITLE[IS_IT_SAFE_PROMPT],
    description: "What each care level may and may not do on your site, word for word as the guided panel says it. Calls nothing.",
    arguments: [],
  },
];

/** The prompts' cap under the operator's config: the loosest care level its maxMode allows (engine/project-config.ts). No maxMode, no cap. */
export function guidedPromptOptions(maxMode: WriteMode | undefined): GuidedPromptOptions {
  return maxMode ? { maxCare: caresWithin(maxMode).at(-1) } : {};
}

/** The care levels a guided prompt may offer, loosest last, under a cap. */
export function offeredCares(maxCare: Care | undefined): Care[] {
  return maxCare ? CARES.slice(0, CARES.indexOf(maxCare) + 1) : [...CARES];
}

/** The arguments given, with credential-named ones and any the prompt does not take refused by name. An argument sent as undefined is one left out. */
function givenArguments(prompt: ListedPrompt, args: Record<string, unknown> | undefined): Record<string, unknown> {
  refuseCredentialArguments(args);
  const given = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined));
  const takes = prompt.arguments.map((a) => a.name);
  const stray = Object.keys(given).filter((k) => !takes.includes(k));
  if (stray.length > 0)
    throw new Error(takes.length === 0 ? `the ${prompt.name} prompt takes no arguments` : `the ${prompt.name} prompt takes ${takes.join(" and ")} only`);
  return given;
}

/** The person's words, quoted, as the chat should offer them. */
const quoted = (words: string) => `"${words}"`;

/** The words that close every guided prompt: what Claude never asks for. */
const NEVER_A_CREDENTIAL =
  "Never ask for a password, a sign-in code or a token, and never type one yourself: when the site needs signing in, a browser window opens for the person to sign in as they normally would.";

function checkMySite(given: Record<string, unknown>, opts: GuidedPromptOptions): string {
  let url = "";
  if (given.url !== undefined) {
    if (typeof given.url !== "string") throw new Error("url must be text: the site's address");
    if (given.url.trim() !== "") {
      const checked = checkAddress(given.url);
      if (!checked.ok) throw new Error(checked.error);
      url = checked.value;
    }
  }
  const cares = offeredCares(opts.maxCare);
  const capped = cares.length < CARES.length;
  const followUps = ([RECHECK_PROMPT, TEAM_REPORT_PROMPT, FILE_TICKETS_PROMPT, IS_IT_SAFE_PROMPT] as const).map((n) => quoted(PROMPT_TITLE[n])).join(", ");
  return [
    `The person picked ${quoted(PROMPT_TITLE[CHECK_MY_SITE_PROMPT])}. Run a guided SceneScout check for them, in plain words: they may not be technical, so never name a tool, a write mode or a setting to them.`,
    "",
    // JSON, so a quote in the address cannot end this instruction. The address has already been refused when it holds a credential.
    `1. ${url ? `Call scout_intake with ${JSON.stringify({ url })}.` : "Call scout_intake with no arguments."} Where this app can show a form, the person chooses there: the address, what to check, how they sign in, how careful to be and how thorough. Follow what it returns: tell the person what the plan says to tell them, then make its calls in order. If it returns questions instead, ask them in one message and do as it says with the answers.`,
    `2. Never choose a care level for the person. ${quoted(CARE_LABEL["look-only"])} is the default.${
      capped
        ? ` Offer no care level but ${cares.map((c) => quoted(CARE_LABEL[c])).join(" or ")}, and tell the person: ${quoted(careCapSentence(opts.maxCare!))}`
        : ""
    } A care level that sends things to the site starts only once the person has confirmed it in the form the server shows them (scout_guided_confirm). You can ask for that form; you cannot answer it. If they go back, or the form cannot be shown, offer the same check in ${quoted(CARE_LABEL["look-only"])}.`,
    "3. While it runs, call scout_status. Where this app draws the status pane, it shows the progress; otherwise post one short line in plain words every few steps saying what is happening.",
    "4. When the check is done, call scout_cards and show each problem worst first: its picture, then its plain text.",
    `5. Then offer what comes next, in these words: ${followUps}.`,
    "",
    NEVER_A_CREDENTIAL,
  ].join("\n");
}

function recheck(): string {
  return [
    `The person picked ${quoted(PROMPT_TITLE[RECHECK_PROMPT])}: ${quoted(ACTION_PROMPT.recheck)}`,
    "",
    '1. Open the project with scout_attach in mode "observe" (Look only): the site\'s address and the folder SceneScout keeps its notes in, from this conversation, or ask the person for them. Never attach in another mode for a re-check. If the site needs signing in, call scout_login for the role first.',
    "2. Call scout_verify with no arguments. It lists the problems earlier checks left open, in the order to check them, each with its steps. If there are none, say so in a sentence and stop.",
    '3. Follow each problem\'s steps, then record what you saw with scout_verify {id, verdict, note}: "gone", "present" (still there) or "changed". A problem whose steps need something saved on the site cannot be checked in Look only: leave it open and tell the person it needs a check that may send forms, which they start with ' +
      `${quoted(PROMPT_TITLE[CHECK_MY_SITE_PROMPT])}.`,
    "4. Call scout_cards with the ids you checked, and tell the person in plain words which are gone, which are still there and which changed.",
    "",
    NEVER_A_CREDENTIAL,
  ].join("\n");
}

/** What to do when a tool says nothing is open yet: open it, in Look only. */
const OPEN_FIRST =
  'If it says no project is open, or "Not attached.", open one with scout_attach in mode "observe": the site\'s address and the folder SceneScout keeps its notes in, from this conversation, or ask the person for them. Then call it again.';

function teamReport(): string {
  return [
    `The person picked ${quoted(PROMPT_TITLE[TEAM_REPORT_PROMPT])}. Tell them first, in these words: ${quoted(NOT_YET["team-report"])}`,
    "",
    `Then: ${ACTION_PROMPT.plainReport} Use the level of the check that ran in this conversation. ${OPEN_FIRST} If nothing has been checked there yet, say so and offer ${quoted(PROMPT_TITLE[CHECK_MY_SITE_PROMPT])} instead.`,
    "If the report comes back NOT GENERATED because parts of the site were not reached, tell the person in plain words what was not reached, and ask whether to check those first or write the report now. Call scout_report again with force: true only when the person says to write it now.",
    "Tell them where it is: report.html, a page that opens in any browser, with report.md beside it, in the folder SceneScout keeps its notes in, which the result names. It stays on this computer; nothing is sent anywhere.",
  ].join("\n");
}

const EXPORT_COMMAND = {
  github: "npx -y scenescout export --to github --repo owner/app",
  jira: "npx -y scenescout export --to jira --jira-url https://your-site.atlassian.net --jira-project KEY",
} as const;
const EXPORT_TOKEN = {
  github: "GH_TOKEN (or GITHUB_TOKEN)",
  jira: "JIRA_EMAIL and JIRA_API_TOKEN",
} as const;

function fileTickets(given: Record<string, unknown>): string {
  // A field left empty is the optional argument left out, as an empty address is for check-my-site.
  const to = given.to === "" ? undefined : given.to;
  // The refusal never repeats the value: a token pasted into the wrong box would be printed back.
  if (to !== undefined && to !== "github" && to !== "jira") throw new Error("to must be github or jira");
  const trackers: ReadonlyArray<keyof typeof EXPORT_COMMAND> = to === undefined ? ["github", "jira"] : [to];
  const commands = trackers.map((t) => `   ${EXPORT_COMMAND[t]}\n   (its sign-in comes from ${EXPORT_TOKEN[t]} in that terminal's environment)`);
  return [
    `The person picked ${quoted(PROMPT_TITLE[FILE_TICKETS_PROMPT])}. Tell them first, in these words: ${quoted(NOT_YET["file-tickets"])}`,
    "",
    "Do not file anything from this chat, and do not ask for a token.",
    "1. Call scout_cards and show the problems worst first, so the person can say which should become tickets. Note the ids of the ones they choose. " +
      OPEN_FIRST,
    `2. Give them the command for a developer to run in the project's folder, from a terminal:\n${commands.join("\n")}\n   Without --yes it is a dry run: it lists what it would file and what is already filed, and creates nothing in the tracker. Adding --yes files them, each problem once. --only followed by the chosen ids, comma-separated, files just those; --project followed by the folder SceneScout keeps its notes in reads that folder.`,
    "3. Tell them the token is set in the terminal's environment by whoever runs the command: never paste a token into the chat.",
  ].join("\n");
}

function isItSafe(opts: GuidedPromptOptions): string {
  const cap = opts.maxCare && offeredCares(opts.maxCare).length < CARES.length ? [careCapSentence(opts.maxCare)] : [];
  return [
    `The person asked ${quoted(PROMPT_TITLE[IS_IT_SAFE_PROMPT])}. Reply with the text below, word for word, as separate paragraphs: add nothing, soften nothing and change nothing. Call no tool. Then offer ${quoted(PROMPT_TITLE[CHECK_MY_SITE_PROMPT])}.`,
    ...SAFETY_EXPLAINER,
    ...cap,
  ].join("\n\n");
}

/**
 * The opening message of a guided prompt. Arguments named for a credential,
 * arguments the prompt does not take and values it cannot use are refused,
 * and no refusal repeats the value it refused.
 */
export function guidedPromptText(name: string, args: Record<string, unknown> | undefined, opts: GuidedPromptOptions = {}): string {
  const prompt = GUIDED_PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new Error(`there is no guided prompt called ${JSON.stringify(name.slice(0, 40))}`);
  const given = givenArguments(prompt, args);
  switch (prompt.name) {
    case CHECK_MY_SITE_PROMPT:
      return checkMySite(given, opts);
    case RECHECK_PROMPT:
      return recheck();
    case TEAM_REPORT_PROMPT:
      return teamReport();
    case FILE_TICKETS_PROMPT:
      return fileTickets(given);
    case IS_IT_SAFE_PROMPT:
      return isItSafe(opts);
  }
}
