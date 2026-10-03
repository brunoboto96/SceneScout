/**
 * MCP prompts other than the testing method.
 *
 * `explore` lives in playbook.ts because its text is the skill. `live` and
 * `login` are short instructions: hand back the loopback live-view address,
 * or call scout_login for a role. Neither accepts a password. The protocol
 * server in mcp-server.ts lists all three; the SDK prompt helper is not used,
 * because it rejects a request that omits `arguments`.
 */
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
