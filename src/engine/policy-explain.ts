/**
 * `scenescout policy explain <METHOD> <URL>`: whether the write policy would let
 * one request out in each mode, and which rule decided (#538).
 *
 * Nothing here judges a request by a rule of its own. Every verdict comes from
 * the functions the route handler (route-guard.ts RouteGuard.judge) calls, in
 * the order it calls them: the method a request is judged as (policy.ts
 * writeMethod), the destructive page-load rule (strict-writes.ts
 * destructiveGet), the destructive-write classifier (policy.ts
 * isDestructiveRequest), the read-POST allowlist (policy.ts readPostAllowed),
 * the handler's own write verdict (route-guard.ts routedWriteVerdict, which
 * holds the sign-in exemption) and the ownership rule (policy.ts allowsWrite).
 * policy-test holds the verdicts here equal to a RouteGuard's on the same
 * requests, so the two cannot drift apart.
 *
 * What a command line cannot know is said, not guessed: which frame sent the
 * request (a write from another site's embedded frame is refused below
 * destructive), whether this run created the record a safe-write change
 * addresses, and whether a GET is a page load or a script's read.
 */
import { flagName, readFlagValue } from "./args.js";
import {
  AUTH_POSTS_ENV,
  allowsWrite,
  authPostsSetting,
  isDestructiveRequest,
  READ_POSTS_ENV,
  readPostAllowed,
  readPostEntries,
  readPostsSetting,
  WRITE_MODES,
  writeMethod,
  writeMethodLabel,
  type ReadPost,
  type WriteMode,
} from "./policy.js";
import { applyToCommand, readLaunchPolicy, withProjectPolicy, type PolicyReader, type SessionWriteRules, type WriteRulesSources } from "./project-config.js";
import { redactRoute } from "./redact.js";
import { ALLOWED_WRITES_ENV, allowedWriteEntries, allowedWritesFromEnv, writeAllowListFor, type AllowedWrite } from "./write-allowlist.js";
import { pathnameOf, routedWriteVerdict } from "./route-guard.js";
import {
  destructiveGet,
  REFUSE_DESTRUCTIVE_GETS_ENV,
  refuseDestructiveGetsSetting,
  STRICT_WRITES_ENV,
  writeClassifierSetting,
  type WriteClassifier,
} from "./strict-writes.js";
import { isReadMethod } from "./unload.js";

/** The options `scenescout policy explain` takes. */
export const POLICY_EXPLAIN_OPTION_NAMES = ["mode", "body", "header", "app"] as const;

/** The most headers one command line may give. */
const MAX_HEADERS = 20;

/** The longest body read from `--body`, in bytes: more than any rule reads. */
export const MAX_EXPLAIN_BODY = 1_000_000;

/** Exit codes: 0 explained, 2 could not explain (a bad argument, a body file that cannot be read). */
export const EXIT_POLICY = { explained: 0, couldNotExplain: 2 } as const;

/** One method name as HTTP writes it. */
const METHOD_NAME = /^[A-Za-z][A-Za-z-]*$/;

export interface PolicyExplainOptions {
  method: string;
  url: string;
  /** One mode, or every mode when absent. */
  mode?: WriteMode;
  /** The file holding the request body. */
  bodyFile?: string;
  headers: Record<string, string>;
  /** The app's address, as the server is attached to it: entries with no origin in the read-POST and sign-in lists mean this origin. Default: the request's own. */
  appUrl: string;
}

/** The command line of `scenescout policy explain`, read; the first argument is the action, `explain`. */
export function parsePolicyArgs(args: readonly string[]): { ok: true; options: PolicyExplainOptions } | { ok: false; error: string } {
  const [action, ...rest] = args;
  if (action !== "explain")
    return {
      ok: false,
      error:
        action === undefined
          ? "say what to do: scenescout policy explain <METHOD> <URL>"
          : action.startsWith("--")
            ? `unknown option --${flagName(action)}`
            : `unknown action ${action}: the one action is explain`,
    };
  const positional: string[] = [];
  const headers: Record<string, string> = {};
  let mode: WriteMode | undefined;
  let bodyFile: string | undefined;
  let app: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = flagName(a);
    if (!(POLICY_EXPLAIN_OPTION_NAMES as readonly string[]).includes(name)) return { ok: false, error: `unknown option --${name}` };
    const read = readFlagValue(rest, i);
    if (!read.ok) return read;
    i = read.last;
    if (name === "mode") {
      if (!(WRITE_MODES as readonly string[]).includes(read.value)) return { ok: false, error: `--mode must be one of ${WRITE_MODES.join(", ")}` };
      mode = read.value as WriteMode;
    } else if (name === "body") bodyFile = read.value;
    else if (name === "app") app = read.value;
    else {
      const colon = read.value.indexOf(":");
      // The value is not repeated: a header given without its colon may still be a credential.
      if (colon <= 0) return { ok: false, error: `--header must be "Name: value"` };
      if (Object.keys(headers).length >= MAX_HEADERS) return { ok: false, error: `at most ${MAX_HEADERS} --header options` };
      headers[read.value.slice(0, colon).trim().toLowerCase()] = read.value.slice(colon + 1).trim();
    }
  }
  if (positional.length !== 2)
    return { ok: false, error: "give a method and a URL, e.g. scenescout policy explain POST https://app.example.com/api/things/3/delete" };
  const [method, url] = positional;
  if (!METHOD_NAME.test(method)) return { ok: false, error: `not an HTTP method: ${method}` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not repeated: an address that does not parse may still carry a password or a token.
    return { ok: false, error: "the URL is not an absolute http or https URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, error: `only http and https URLs can be explained (got ${parsed.protocol})` };
  let appUrl = parsed.origin;
  if (app !== undefined) {
    let a: URL;
    try {
      a = new URL(app);
    } catch {
      return { ok: false, error: "--app is not an absolute http or https URL" };
    }
    if (a.protocol !== "http:" && a.protocol !== "https:") return { ok: false, error: `--app must be an http or https URL (got ${a.protocol})` };
    appUrl = a.origin;
  }
  return { ok: true, options: { method: method.toUpperCase(), url: wireUrl(parsed.href), mode, bodyFile, headers, appUrl } };
}

/** The URL as a browser sends it: the fragment never leaves the page, so no rule may read it (a `#?_method=DELETE` is not a query). */
function wireUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/** The URL as printed: no user name or password, and a token in its query masked, as every other line the engine writes. */
function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return redactRoute(u.href);
  } catch {
    return redactRoute(url);
  }
}

/** The operator's settings the write policy reads from the server's environment, as the server reads them (browser.ts attach). */
export interface PolicySettings {
  classifier: WriteClassifier;
  refuseDestructiveGets: boolean;
  /** SCENESCOUT_READ_POSTS, parsed. */
  readPosts: readonly ReadPost[];
  /** The config's authPosts or SCENESCOUT_AUTH_POSTS, parsed, or null when neither sets a list (the path rule decides). */
  authPosts: readonly ReadPost[] | null;
  /** True: a listed POST must also look like a sign-in by its path (a list only a project's own file set; project-config.ts writeRulesSettings). */
  authPostsNarrowOnly?: boolean;
  /** The list of writes that may leave the page (the config's allowedWrites or SCENESCOUT_ALLOWED_WRITES), parsed, or null when none is set. */
  allowedWrites?: { entries: readonly AllowedWrite[]; andModeRules: boolean } | null;
  /** What turned each write-judgement setting on, when the operator's config was read (project-config.ts writeRulesSettings). Absent: the environment. */
  from?: WriteRulesSources;
}

/**
 * The settings from an environment, with the same parsers the server uses; a value the server would refuse throws as it would.
 * `rules`: the write-judgement settings with the operator's config applied, as an attach takes them; absent, the environment's alone.
 */
export function policySettingsFrom(env: Record<string, string | undefined>, rules?: SessionWriteRules): PolicySettings {
  if (!rules)
    return {
      classifier: writeClassifierSetting(env),
      refuseDestructiveGets: refuseDestructiveGetsSetting(env),
      readPosts: readPostEntries(readPostsSetting(undefined, env[READ_POSTS_ENV])).entries,
      authPosts: authPostsSetting(env[AUTH_POSTS_ENV])?.entries ?? null,
      allowedWrites: allowedWritesFromEnv(env[ALLOWED_WRITES_ENV]).length > 0 ? listedWrites(allowedWritesFromEnv(env[ALLOWED_WRITES_ENV]), false) : null,
    };
  return {
    classifier: rules.writeClassifier,
    refuseDestructiveGets: rules.refuseDestructiveGets,
    readPosts: readPostEntries(readPostsSetting(undefined, env[READ_POSTS_ENV])).entries,
    authPosts: rules.authPosts ? readPostEntries(rules.authPosts.entries).entries : null,
    authPostsNarrowOnly: rules.authPosts?.andSignInPath === true,
    allowedWrites: rules.allowedWrites ? listedWrites(rules.allowedWrites.entries, rules.allowedWrites.andModeRules) : null,
    from: rules.from,
  };
}

function listedWrites(entries: readonly string[], andModeRules: boolean): { entries: AllowedWrite[]; andModeRules: boolean } {
  return { entries: allowedWriteEntries(entries).entries, andModeRules };
}

/** The settings with nothing turned on: what a server started with no policy variables applies. */
export const DEFAULT_POLICY_SETTINGS: PolicySettings = { classifier: "standard", refuseDestructiveGets: false, readPosts: [], authPosts: null };

/** What happens to the request in one mode. `depends` is safe-write's ownership rule: out only on a record this run created. */
export type ExplainOutcome = "allowed" | "refused" | "depends";

export interface ModeVerdict {
  mode: WriteMode;
  outcome: ExplainOutcome;
  /** The rule that decided, in a sentence. */
  rule: string;
  /** The function that holds that rule. */
  source: string;
}

export interface PolicyExplanation {
  /** "POST", or "POST as DELETE" when an override names another method. */
  label: string;
  /** The method the policy judges it as. */
  judgedAs: string;
  /** Where an override named that method, when one did. */
  via?: string;
  /** Whether the classifier in force reads it as destructive (meaningful for a write). */
  destructive: boolean;
  /** For a read: whether its address reads as a destructive command (destructiveGet). */
  destructiveAddress: boolean;
  verdicts: ModeVerdict[];
  /** The app's origin the request was judged against. */
  appUrl: string;
}

/** A verdict for one mode, as the route handler would reach it for a request sent from the app's own top page. */
function verdictFor(
  mode: WriteMode,
  input: { method: string; url: string; body: string | null; headers: Record<string, string>; appUrl: string },
  settings: PolicySettings,
): ModeVerdict {
  // destructive: the route handler is not installed at all (browser.ts routeRequests).
  if (mode === "destructive") return { mode, outcome: "allowed", rule: "destructive mode judges no request", source: "browser.ts routeRequests" };
  const judged = writeMethod({ method: input.method, url: input.url, headers: input.headers, body: input.body });
  const method = judged.method;
  if (isReadMethod(method)) {
    // Only a page load is judged by it, and a page load is a GET (route-guard.ts asks for a document request).
    if (method === "GET" && (mode === "observe" || mode === "read-only") && settings.refuseDestructiveGets && destructiveGet(input.url))
      return {
        mode,
        outcome: "refused",
        rule: `as a page load: its address is a destructive command, and ${settings.from?.refuseDestructiveGets ?? REFUSE_DESTRUCTIVE_GETS_ENV} turns that refusal on (a script's ${method} is not judged by this rule and goes out)`,
        source: "strict-writes.ts destructiveGet",
      };
    return { mode, outcome: "allowed", rule: `${method} is a read, which every mode lets out`, source: "unload.ts isReadMethod" };
  }
  const pathname = pathnameOf(input.url);
  const destructiveWire = isDestructiveRequest(input.url, input.body, settings.classifier);
  const appUrl = input.appUrl;
  const readPost = readPostAllowed({ mode, method, url: input.url, appUrl, body: input.body, destructiveWire, entries: settings.readPosts });
  const verdict = routedWriteVerdict({
    rule: mode,
    method,
    pathname,
    destructiveWire,
    // From the command line the sender is the app's own top page: no foreign frame, no page an embed moved.
    foreign: null,
    offApp: null,
    readPost: readPost !== null,
    authList: settings.authPosts ? { entries: settings.authPosts, appUrl, url: input.url, andSignInPath: settings.authPostsNarrowOnly === true } : null,
    allowList: writeAllowListFor(settings.allowedWrites ?? null, appUrl, method, input.url),
  });
  if (verdict.kind === "refuse") return { mode, outcome: "refused", rule: verdict.why, source: "route-guard.ts routedWriteVerdict" };
  if (verdict.kind === "auth")
    return {
      mode,
      outcome: "allowed",
      rule: settings.authPosts
        ? `a sign-in POST listed in ${settings.from?.authPosts ?? AUTH_POSTS_ENV}${settings.authPostsNarrowOnly ? " that also looks like a sign-in by its path" : ""}`
        : mode === "observe"
          ? "a sign-in, sign-out or token refresh by its path (observe's narrow sign-in rule)"
          : "an auth or session request by its path",
      source: "policy.ts isAuthExempt",
    };
  if (verdict.kind === "listed-write") {
    const entry = writeAllowListFor(settings.allowedWrites ?? null, appUrl, method, input.url)?.entry?.entry ?? "listed";
    return {
      mode,
      outcome: "allowed",
      rule: `named in the list of allowed writes, ${settings.from?.allowedWrites ?? ALLOWED_WRITES_ENV} (${entry}); the list lets it out whatever it looks like`,
      source: "write-allowlist.ts matchAllowedWrite",
    };
  }
  if (verdict.kind === "read-post" && readPost)
    return { mode, outcome: "allowed", rule: `named as a read in ${READ_POSTS_ENV} (${readPost.entry})`, source: "policy.ts readPostAllowed" };
  const notOwned = allowsWrite(mode, method, destructiveWire, false);
  const owned = allowsWrite(mode, method, destructiveWire, true);
  const kind = method === "POST" ? (destructiveWire ? "a POST that looks destructive" : "a plain POST") : `a ${method}`;
  if (notOwned) return { mode, outcome: "allowed", rule: `${mode} lets ${kind} out`, source: "policy.ts allowsWrite" };
  if (owned) return { mode, outcome: "depends", rule: `${kind} goes out only on a record this run created`, source: "policy.ts allowsWrite" };
  const why = mode === "observe" ? `observe lets out only GET, HEAD and OPTIONS, signing in and named read POSTs; this is ${kind}` : `${mode} refuses ${kind}`;
  return { mode, outcome: "refused", rule: why, source: "policy.ts allowsWrite" };
}

/** Whether, and why, each mode (or the one asked for) would let this request out. */
export function explainRequest(input: {
  method: string;
  url: string;
  body?: string | null;
  headers?: Record<string, string>;
  mode?: WriteMode;
  settings?: PolicySettings;
  /** The app's address (default: the request's own origin). */
  appUrl?: string;
}): PolicyExplanation {
  const settings = input.settings ?? DEFAULT_POLICY_SETTINGS;
  const req = {
    method: input.method.toUpperCase(),
    url: wireUrl(input.url),
    body: input.body ?? null,
    headers: input.headers ?? {},
    appUrl: input.appUrl ?? new URL(input.url).origin,
  };
  const judged = writeMethod(req);
  const modes = input.mode ? [input.mode] : [...WRITE_MODES];
  return {
    label: writeMethodLabel(req.method, judged),
    judgedAs: judged.method,
    via: judged.via,
    destructive: isDestructiveRequest(req.url, req.body, settings.classifier),
    destructiveAddress: destructiveGet(req.url),
    verdicts: modes.map((mode) => verdictFor(mode, req, settings)),
    appUrl: req.appUrl,
  };
}

/** What `scenescout policy explain` prints. */
export function formatExplanation(url: string, e: PolicyExplanation, settings: PolicySettings): string[] {
  const lines = [`${e.label} ${shownUrl(url)}`];
  if (e.via) lines.push(`Judged as ${e.judgedAs}: ${e.via}.`);
  if (isReadMethod(e.judgedAs)) {
    lines.push(
      e.destructiveAddress
        ? `Its address reads as a destructive command (strict-writes.ts destructiveGet).${settings.refuseDestructiveGets ? "" : ` A page load of it is refused in observe and read-only only when ${REFUSE_DESTRUCTIVE_GETS_ENV}=1 or the config sets refuseDestructiveGets.`}`
        : "Its address does not read as a destructive command.",
    );
  } else {
    lines.push(
      `${e.destructive ? "Looks destructive" : "Does not look destructive"} to the ${settings.classifier} classifier (policy.ts isDestructiveRequest). This is pattern matching: best effort, not a guarantee.`,
    );
  }
  const width = Math.max(...e.verdicts.map((v) => v.mode.length));
  for (const v of e.verdicts) lines.push(`  ${v.mode.padEnd(width)}  ${v.outcome.padEnd(8)}  ${v.rule}  [${v.source}]`);
  const from = settings.from ?? {};
  const byConfig = (source: string | undefined): boolean => source !== undefined && source.startsWith("the SceneScout config");
  const on = [
    settings.classifier === "strict" ? (byConfig(from.writeClassifier) ? `writeClassifier "strict" (${from.writeClassifier})` : `${STRICT_WRITES_ENV}=1`) : "",
    settings.refuseDestructiveGets
      ? byConfig(from.refuseDestructiveGets)
        ? `refuseDestructiveGets (${from.refuseDestructiveGets})`
        : `${REFUSE_DESTRUCTIVE_GETS_ENV}=1`
      : "",
    settings.readPosts.length > 0 ? `${READ_POSTS_ENV} (${settings.readPosts.length})` : "",
    settings.authPosts
      ? byConfig(from.authPosts)
        ? `authPosts (${settings.authPosts.length}, ${from.authPosts})`
        : `${AUTH_POSTS_ENV} (${settings.authPosts.length})`
      : "",
    settings.allowedWrites
      ? byConfig(from.allowedWrites)
        ? `allowedWrites (${settings.allowedWrites.entries.length}, ${from.allowedWrites})`
        : `${ALLOWED_WRITES_ENV} (${settings.allowedWrites.entries.length})`
      : "",
  ].filter(Boolean);
  const anyConfig = [from.writeClassifier, from.refuseDestructiveGets, from.authPosts, from.allowedWrites].some(byConfig);
  lines.push(`Settings read from this environment${anyConfig ? " and the config" : ""}: ${on.length > 0 ? on.join(", ") : "none (the defaults)"}.`);
  lines.push(
    `Assumed: the app is ${e.appUrl} (--app to change it), and its own top page sent the request. ` +
      "A write sent from another site's embedded frame is judged by the embed rules instead (refused below destructive, except on the app's sign-in page and for an origin trusted in safe-write), " +
      "and a click on a destructive-labelled control is refused in observe and read-only before any request is sent.",
  );
  return lines;
}

/**
 * The command, given its arguments and what it reads and writes through:
 * the environment the policy settings come from, a body file's text, and its
 * output. Returns the exit code (EXIT_POLICY). Every failure is one line
 * starting `scenescout policy:`.
 */
export function runPolicyCommand(
  args: readonly string[],
  io: {
    env: Record<string, string | undefined>;
    readBody: (file: string) => string;
    out: (line: string) => void;
    err: (line: string) => void;
    /**
     * The operator's config file, read as the other commands read it (project-config.ts configureCommand): its
     * `readPosts` is the most a session may name, so it changes what observe lets out. Absent: no file is read.
     */
    config?: { launchDir: string; reader: PolicyReader };
  },
): number {
  const fail = (message: string): number => {
    io.err(`scenescout policy: ${message}`);
    return EXIT_POLICY.couldNotExplain;
  };
  const parsed = parsePolicyArgs(args);
  if (!parsed.ok) return fail(parsed.error);
  const o = parsed.options;
  let body: string | null = null;
  if (o.bodyFile !== undefined) {
    try {
      body = io.readBody(o.bodyFile);
    } catch (err) {
      return fail(`could not read the body file ${o.bodyFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let env = io.env;
  let configNote = "";
  let rules: SessionWriteRules | undefined;
  if (io.config) {
    // As configureCommand reads it, short of the projectsRoot fence: nothing is opened or written, so no folder is out of bounds.
    const launch = readLaunchPolicy(io.env, io.config.launchDir, io.config.reader);
    const loaded = launch.ok ? withProjectPolicy(launch.loaded, io.config.launchDir, io.config.reader) : launch;
    if (!loaded.ok) return fail(loaded.error);
    const applied = applyToCommand(loaded.loaded, io.env, [], { mode: "observe" });
    if (!applied.ok) return fail(applied.error);
    if (applied.readPosts !== undefined) env = { ...io.env, [READ_POSTS_ENV]: applied.readPosts.join("\n") };
    rules = applied.writeRules;
    configNote = applied.note;
  }
  let settings: PolicySettings;
  try {
    settings = policySettingsFrom(env, rules);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const explanation = explainRequest({ method: o.method, url: o.url, body, headers: o.headers, mode: o.mode, settings, appUrl: o.appUrl });
  for (const line of formatExplanation(o.url, explanation, settings)) io.out(line);
  if (configNote) io.out(configNote);
  return EXIT_POLICY.explained;
}
