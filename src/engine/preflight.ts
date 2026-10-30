/**
 * `scenescout preflight <url>`: whether a runner can reach what a run needs,
 * answered in seconds and with no browser, so a CI job stops on a plain cause
 * before it installs a browser or starts a check (#539).
 *
 * It asks three things, each only when it applies:
 * - the app: one GET of the start URL. A DNS failure, a refused or dropped
 *   connection, a timeout, a TLS failure, an HTTP 4xx or 5xx, and a bot
 *   challenge (challenge.ts, the rule `check` stops on) each end it with a
 *   cause and an exit code of its own;
 * - a saved sign-in (`--role`, `--storage-state`): whether it has expired, read
 *   from the profile's own dates (expiry.ts) without signing in or sending it;
 * - the model's API (`--model-api`): one list-the-models request carrying the
 *   key and nothing of the app, and only where the config's `egress` lets a
 *   model be reached.
 *
 * Every check runs, so one run names every cause; the exit code is the first
 * failure's, in that order. The rules (how an error, a status or a profile
 * becomes a verdict) are pure and table-tested in check-test; the network is
 * reached only through the `fetch` the caller passes, each call bounded by
 * `--timeout-ms`.
 */
import { flagName, readFlagValue } from "./args.js";
import { botChallenge, CHALLENGE_BODY_LIMIT, challengeBodyMatters } from "./challenge.js";
import { checkBaseUrl, detectProvider, DIRECT_PROVIDERS, KEY_ENV, redactKeys, secretValues, type ProviderName } from "./ci.js";
import { describeLifetime, judgeLifetime, readLifetime } from "./expiry.js";
import { egressAllows, readCommandPolicy, refusalText, type PolicyReader } from "./project-config.js";
import { loginCommand, profilePath, validateRoleName } from "./profiles.js";
import { BLOCKED_PORT, errorParts, networkCause, type NetworkCause } from "./network-failure.js";
import { redactRoute } from "./redact.js";
import { appHeaderApplies, appHeaderLine, readAppHeader, withAppHeader, type AppHeader } from "./app-header.js";
import { proxyLine, readProxy, type ProxySettings } from "./proxy.js";

/** The options `scenescout preflight` takes. `model-api` is the one switch. */
export const PREFLIGHT_OPTION_NAMES = ["role", "storage-state", "project", "model-api", "provider", "base-url", "timeout-ms"] as const;
const SWITCHES: readonly string[] = ["model-api"];

/**
 * Exit codes: 0 ready, 2 could not run (a bad argument or a config that refuses
 * it), and one code per cause, above the 1 a failed gate uses elsewhere.
 */
export const EXIT_PREFLIGHT = {
  ready: 0,
  couldNotRun: 2,
  dns: 10,
  connection: 11,
  timeout: 12,
  tls: 13,
  http: 14,
  challenge: 15,
  signIn: 16,
  modelApi: 17,
} as const;
export type PreflightCause = Exclude<keyof typeof EXIT_PREFLIGHT, "ready" | "couldNotRun">;

/** How long one request may take, headers and body together. */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;
export const PREFLIGHT_TIMEOUT_BOUNDS = { min: 1_000, max: 120_000 } as const;

/** What the requests call themselves, so a firewall's log names them and an allowlist can match them. */
export const PREFLIGHT_USER_AGENT = "scenescout-preflight";

export interface PreflightOptions {
  url: string;
  role?: string;
  /** An absolute path. */
  storageState?: string;
  projectDir: string;
  modelApi: boolean;
  provider?: ProviderName;
  baseUrl?: string;
  timeoutMs: number;
}

/** The command line of `scenescout preflight`, read. Relative paths resolve from `cwd`. */
export function parsePreflightArgs(
  args: readonly string[],
  cwd: string,
  resolve: (cwd: string, p: string) => string,
): { ok: true; options: PreflightOptions } | { ok: false; error: string } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let modelApi = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = flagName(a);
    if (!(PREFLIGHT_OPTION_NAMES as readonly string[]).includes(name)) return { ok: false, error: `unknown option --${name}` };
    if (SWITCHES.includes(name)) {
      if (a.includes("=")) return { ok: false, error: `--${name} takes no value` };
      modelApi = true;
      continue;
    }
    const read = readFlagValue(args, i);
    if (!read.ok) return read;
    i = read.last;
    values.set(name, read.value);
  }
  if (positional.length === 0) return { ok: false, error: "give the app's address, e.g. scenescout preflight https://staging.example.com" };
  if (positional.length > 1) return { ok: false, error: `unexpected argument ${positional[1]}` };
  let u: URL;
  try {
    u = new URL(positional[0]);
  } catch {
    // Not repeated: an address that does not parse may still carry a password or a token.
    return { ok: false, error: "the address is not an absolute http or https URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: `only http and https addresses can be checked (got ${u.protocol})` };
  if (u.username || u.password)
    return { ok: false, error: "put no credentials in the URL: they would be printed. Use --role or --storage-state for a sign-in" };
  const role = values.get("role");
  const storage = values.get("storage-state");
  if (role !== undefined && storage !== undefined)
    return { ok: false, error: "pass --role or --storage-state, not both: --role reads the profile `scenescout login` saved, --storage-state a file you name" };
  if (role !== undefined) {
    const checked = validateRoleName(role);
    if (!checked.ok) return { ok: false, error: checked.error };
  }
  let provider: ProviderName | undefined;
  const p = values.get("provider");
  if (p !== undefined) {
    if (!(DIRECT_PROVIDERS as readonly string[]).includes(p)) return { ok: false, error: `--provider must be one of ${DIRECT_PROVIDERS.join(", ")}` };
    provider = p as ProviderName;
  }
  let baseUrl: string | undefined;
  const b = values.get("base-url");
  if (b !== undefined) {
    const checked = checkBaseUrl(b);
    if (!checked.ok) return { ok: false, error: checked.error };
    baseUrl = checked.url;
  }
  if (!modelApi && (provider || baseUrl)) return { ok: false, error: "--provider and --base-url choose the model API to check: add --model-api" };
  let timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const t = values.get("timeout-ms");
  if (t !== undefined) {
    const n = Number(t);
    const { min, max } = PREFLIGHT_TIMEOUT_BOUNDS;
    if (!/^\d+$/.test(t) || n < min || n > max) return { ok: false, error: `--timeout-ms must be a whole number from ${min} to ${max}` };
    timeoutMs = n;
  }
  const project = values.get("project");
  return {
    ok: true,
    options: {
      url: u.href,
      ...(role !== undefined ? { role } : {}),
      ...(storage !== undefined ? { storageState: resolve(cwd, storage) } : {}),
      projectDir: project !== undefined ? resolve(cwd, project) : cwd,
      modelApi,
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      timeoutMs,
    },
  };
}

// ── what a failed request means ─────────────────────────────────────────────

// The causes, and how a Node error is read into one, are shared with the run's own classification (network-failure.ts).
export { BLOCKED_PORT, networkCause, type NetworkCause } from "./network-failure.js";

/** The most redirects fetch follows (the Fetch standard's limit, and a browser's): past it the request fails with no HTTP answer. */
export const MAX_REDIRECTS = 20;

/** Whether a request failed because it was redirected more than MAX_REDIRECTS times (Node's fetch says "redirect count exceeded" behind "fetch failed"). */
export function redirectLoop(err: unknown): boolean {
  const queue: unknown[] = [err];
  for (let seen = 0; queue.length > 0 && seen < 20; seen++) {
    const parts = errorParts(queue.shift());
    if (parts.message === "redirect count exceeded") return true;
    queue.push(...parts.inner);
  }
  return false;
}

/** The sentence for a request to `url` that failed with `cause`. */
export function networkSentence(url: string, failure: { cause: NetworkCause; code: string }, timeoutMs: number): string {
  const u = new URL(url);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  switch (failure.cause) {
    case "dns":
      return `could not resolve ${u.hostname} (DNS, ${failure.code}): the runner's resolver has no address for it. Check the spelling, and that the runner can see the network the app is on: a private or internal name needs a runner inside that network.`;
    case "connection":
      if (failure.code === BLOCKED_PORT)
        return `port ${port} is one browsers refuse to connect to (the Fetch standard's blocked ports), so no check could load ${u.hostname}:${port} either. Serve the app on another port.`;
      return `could not connect to ${u.hostname}:${port} (${failure.code}): the connection was refused or dropped. Check that the app is running on that port, and that no firewall or security group keeps the runner out.`;
    case "timeout":
      // Node's fetch gives up on a connection that is never set up after its own 10 s, whatever the request's limit.
      if (failure.code === "UND_ERR_CONNECT_TIMEOUT")
        return `no connection to ${u.hostname}:${port} within Node's 10-second connect limit (${failure.code}): a firewall that drops the runner's packets looks like this. Check the runner's route to it; --timeout-ms cannot lengthen this limit.`;
      return `no answer from ${u.hostname}:${port} within ${timeoutMs} ms (${failure.code}): a firewall that drops the runner's packets looks like this, as does an app still starting. Check the runner's route to it, or raise --timeout-ms.`;
    case "tls":
      return `the TLS handshake with ${u.hostname} failed (${failure.code}): its certificate has expired, does not name this host, or is signed by an authority this machine does not trust. A certificate from your own authority needs NODE_EXTRA_CA_CERTS for this check.`;
  }
}

// ── what an answer means ────────────────────────────────────────────────────

/** One check's verdict: passed, passed with something to know, or failed with its cause. */
export type Verdict = { kind: "ok"; line: string } | { kind: "note"; line: string } | { kind: "fail"; cause: PreflightCause; line: string };

/** The URL as printed: no user name or password, and a token in its query masked. */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return redactRoute(u.href);
  } catch {
    return redactRoute(url);
  }
}

/** What the app's start page answered: status, headers (names lowercase), the start of its body on a refusing status, and where redirects ended. */
export interface PageAnswer {
  status: number;
  headers: Readonly<Record<string, string>>;
  body?: string;
  finalUrl: string;
  ms: number;
}

/** The verdict on the start page's answer. A bot challenge is decided first, by the rule `check` stops on. */
export function judgePage(url: string, a: PageAnswer): Verdict {
  const shown = shownUrl(url);
  const moved = a.finalUrl && new URL(a.finalUrl).href !== new URL(url).href ? ` (after redirects, at ${shownUrl(a.finalUrl)})` : "";
  const vendor = botChallenge({ status: a.status, headers: a.headers, body: a.body });
  if (vendor)
    return {
      kind: "fail",
      cause: "challenge",
      line: `${vendor} answered ${shown}${moved} with a bot challenge (HTTP ${a.status}) in the app's place, so a check would measure the challenge. Let the runner through the protection (an allowlist for its address), or use a deployment without it.`,
    };
  if (a.status >= 400) {
    const hint =
      a.status === 401 || a.status === 403
        ? "The page needs a signed-in session, or something in front of the app refuses the runner: pass a sign-in to the check with --storage-state, or let the runner's address through."
        : a.status === 404
          ? "Check the URL and its path."
          : a.status === 429
            ? "Something is rate-limiting the runner: run fewer jobs against it at once, or allowlist the runner."
            : a.status >= 500
              ? "The app, or a proxy or load balancer in front of it, is failing: check that the app has started and is healthy."
              : "Check the URL.";
    return { kind: "fail", cause: "http", line: `${shown}${moved} answered HTTP ${a.status}. ${hint}` };
  }
  return { kind: "ok", line: `${shown} answered HTTP ${a.status} in ${a.ms} ms${moved}` };
}

// ── a saved sign-in ─────────────────────────────────────────────────────────

/**
 * The verdict on a saved sign-in's text, judged at `now` by its own dates: failed only when
 * every credential in it is dated and the last has ended (expiry.ts judgeLifetime, with no run to outlast).
 */
export function judgeSignIn(text: string, o: { label: string; url: string; now: number; rerun: string }): Verdict {
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    // The parser's message quotes the text around the fault, and the text is a live session: say only that it is not JSON.
    return { kind: "fail", cause: "signIn", line: `the saved sign-in ${o.label} is not valid JSON. Record it again: ${o.rerun}` };
  }
  const life = readLifetime(state, { url: o.url });
  const verdict = judgeLifetime(life, { now: o.now, runMs: 0, marginMs: 0, role: o.label, rerun: o.rerun });
  if (verdict.kind === "refuse")
    return {
      kind: "fail",
      cause: "signIn",
      line: `the saved sign-in ${o.label} has expired: every dated credential in it has ended. Record it again: ${o.rerun}`,
    };
  const lasts = describeLifetime(life, o.now);
  if (verdict.kind === "ok") return { kind: "ok", line: `the saved sign-in ${o.label} has not expired. ${lasts}` };
  return { kind: "note", line: `the saved sign-in ${o.label} may still work. ${lasts} This reads its dates only; it does not sign in.` };
}

// ── the model's API ─────────────────────────────────────────────────────────

/** The request that asks a provider for its models: a read that spends no tokens and carries nothing of the app. */
export function modelListRequest(provider: ProviderName, baseUrl: string, key: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> =
    provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  return { url: `${baseUrl}/models`, headers: { ...headers, "user-agent": PREFLIGHT_USER_AGENT } };
}

/**
 * The verdict on the models list's status. Any answer below 500 but a refused key means the API is reachable.
 * A redirect fails: the key is not sent on to another address, and a ci run, which follows no redirect either, would stop there.
 * `location` is where the redirect pointed, as printed.
 */
export function judgeModelReply(api: string, status: number, location?: string): Verdict {
  if (status >= 200 && status < 300) return { kind: "ok", line: `${api} answered and accepted the key (HTTP ${status})` };
  if (status >= 300 && status < 400)
    return {
      kind: "fail",
      cause: "modelApi",
      line: `${api} answered with a redirect (HTTP ${status}${location ? ` to ${location}` : ""}). The key is not sent on to another address, and a ci run would stop here too: set --base-url to the address the API answers at.`,
    };
  if (status === 401 || status === 403)
    return { kind: "fail", cause: "modelApi", line: `${api} refused the key (HTTP ${status}): check the key, and that it may use this API.` };
  if (status >= 500) return { kind: "fail", cause: "modelApi", line: `${api} answered HTTP ${status}: the API is failing. Try again later.` };
  if (status === 404 || status === 405)
    return { kind: "note", line: `${api} is reachable, but does not list models (HTTP ${status}), so the key was not checked.` };
  if (status === 429) return { kind: "note", line: `${api} is reachable, and rate-limiting this key now (HTTP 429).` };
  return { kind: "note", line: `${api} is reachable (HTTP ${status}).` };
}

// ── the command ─────────────────────────────────────────────────────────────

/** The exit code of a set of verdicts: the first failure's, in the order they were checked. */
export function preflightExitCode(verdicts: readonly Verdict[]): number {
  const failed = verdicts.find((v): v is Extract<Verdict, { kind: "fail" }> => v.kind === "fail");
  return failed ? EXIT_PREFLIGHT[failed.cause] : EXIT_PREFLIGHT.ready;
}

/** What the command reaches the world through, so a test can stand in for each. */
export interface PreflightIo {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; redirect: "follow" | "manual"; signal: AbortSignal }) => Promise<Response>;
  env: Record<string, string | undefined>;
  readFile: (file: string) => string;
  exists: (file: string) => boolean;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  resolve: (cwd: string, p: string) => string;
  cwd: string;
  config: PolicyReader;
}

/** Read at most `limit` characters of a body, then let the rest go. */
async function bodyStart(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Only what was read is judged; a cancel that fails leaves nothing to undo, and the request's timeout still bounds it.
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

/**
 * The start page's answer. With an allowlist header (app-header.ts), redirects are followed here rather than by fetch,
 * which would copy the header to wherever the app redirects: each hop carries it only when it is to the app's origin.
 */
async function fetchStartPage(o: PreflightOptions, io: PreflightIo, header: AppHeader | null): Promise<Response> {
  const base = { "user-agent": PREFLIGHT_USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  const signal = AbortSignal.timeout(o.timeoutMs);
  if (!header) return io.fetch(o.url, { method: "GET", headers: base, redirect: "follow", signal });
  let at = o.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = appHeaderApplies(at, o.url) ? withAppHeader(base, header) : base;
    const res = await io.fetch(at, { method: "GET", headers, redirect: "manual", signal });
    const to = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !to) return res;
    await res.body?.cancel().catch(() => undefined);
    at = new URL(to, at).href;
  }
  // Worded as fetch words its own, so the loop is told apart the same way (redirectLoop).
  throw new TypeError("fetch failed", { cause: new Error("redirect count exceeded") });
}

async function checkPage(o: PreflightOptions, io: PreflightIo, header: AppHeader | null): Promise<Verdict> {
  const started = io.now();
  let res: Response;
  try {
    res = await fetchStartPage(o, io, header);
  } catch (err) {
    if (redirectLoop(err))
      return {
        kind: "fail",
        cause: "http",
        line: `${shownUrl(o.url)} redirected more than ${MAX_REDIRECTS} times without answering: a redirect loop, often a sign-in or HTTPS rule that sends the request back where it came from. Open the address in a browser to follow the loop, and check the app's redirect rules.`,
      };
    const failure = networkCause(err);
    return { kind: "fail", cause: failure.cause, line: networkSentence(o.url, failure, o.timeoutMs) };
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
  let body: string | undefined;
  try {
    if (challengeBodyMatters(res.status)) body = await bodyStart(res, CHALLENGE_BODY_LIMIT);
    else await res.body?.cancel();
  } catch {
    // The status and headers are the answer; a body cut off past them still lets the headers decide.
  }
  return judgePage(o.url, { status: res.status, headers, body, finalUrl: res.url || o.url, ms: io.now() - started });
}

function checkSignIn(o: PreflightOptions, io: PreflightIo): Verdict | null {
  let file: string;
  let label: string;
  let rerun: string;
  if (o.role !== undefined) {
    file = profilePath(o.projectDir, o.role);
    label = `for role "${o.role}"`;
    rerun = `\`${loginCommand(o.role, shownUrl(o.url), o.projectDir === io.cwd ? undefined : o.projectDir)}\``;
    if (!io.exists(file)) return { kind: "fail", cause: "signIn", line: `no sign-in is saved for role "${o.role}" in ${o.projectDir}. Save one: ${rerun}` };
  } else if (o.storageState !== undefined) {
    file = o.storageState;
    label = `in ${o.storageState}`;
    rerun = "sign in again and save the storage state (`scenescout login <url> --role <name>`, or `--script` in CI)";
    if (!io.exists(file)) return { kind: "fail", cause: "signIn", line: `the storage state ${o.storageState} does not exist.` };
  } else return null;
  let text: string;
  try {
    text = io.readFile(file);
  } catch (err) {
    return { kind: "fail", cause: "signIn", line: `the saved sign-in ${label} could not be read (${(err as NodeJS.ErrnoException).code ?? "read error"}).` };
  }
  return judgeSignIn(text, { label, url: o.url, now: io.now(), rerun });
}

async function checkModelApi(o: PreflightOptions, io: PreflightIo): Promise<Verdict> {
  const provider = detectProvider(io.env, { provider: o.provider, baseUrl: o.baseUrl });
  if (!provider.ok)
    return { kind: "fail", cause: "modelApi", line: `the model API cannot be checked: ${provider.error.replace(": a CI run needs a model to drive it", "")}` };
  const { resolved } = provider;
  const key = (io.env[KEY_ENV[resolved.provider]] ?? "").trim();
  const req = modelListRequest(resolved.provider, resolved.baseUrl, key);
  const api = `the ${resolved.provider === "anthropic" ? "Anthropic" : "OpenAI"} API at ${resolved.baseUrl}`;
  let res: Response;
  try {
    // "manual": a redirect is answered as its own status and never followed, so the key goes to this address only.
    res = await io.fetch(req.url, { method: "GET", headers: req.headers, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (err) {
    const failure = networkCause(err);
    return { kind: "fail", cause: "modelApi", line: `${api}: ${networkSentence(req.url, failure, o.timeoutMs)}` };
  }
  // The status is the whole answer; the list itself is never read.
  await res.body?.cancel().catch(() => undefined);
  const to = res.headers.get("location");
  let location: string | undefined;
  if (to) {
    try {
      location = shownUrl(new URL(to, req.url).href);
    } catch {
      // A Location that does not parse is not repeated; the status still says it was a redirect.
    }
  }
  return judgeModelReply(api, res.status, location);
}

/**
 * Run the preflight; returns the exit code (EXIT_PREFLIGHT). Each check prints
 * one line; a failure goes to `err`. Every line has the keys in the environment
 * redacted, though none is ever put in one.
 */
export async function runPreflight(args: readonly string[], io: PreflightIo): Promise<number> {
  const secrets = secretValues(io.env);
  const say = (line: string) => io.out(redactKeys(line, secrets));
  const complain = (line: string) => io.err(redactKeys(line, secrets));
  const parsed = parsePreflightArgs(args, io.cwd, io.resolve);
  if (!parsed.ok) {
    complain(`scenescout preflight: ${parsed.error}`);
    return EXIT_PREFLIGHT.couldNotRun;
  }
  const o = parsed.options;
  // The config is read as every command reads it, so one that check or ci would refuse stops this too.
  const config = readCommandPolicy(io.env, io.cwd, o.projectDir, io.config);
  if (!config.ok) {
    complain(`scenescout preflight: ${config.error}`);
    return EXIT_PREFLIGHT.couldNotRun;
  }
  if (o.modelApi && !egressAllows(config.loaded.policy.egress, "model")) {
    const why = refusalText(config.loaded, [
      { key: "egress", why: `egress "${config.loaded.policy.egress}" lets SceneScout send nothing off this machine, so the model API is not contacted` },
    ]);
    complain(`scenescout preflight: ${why.replace(/ Do not retry with a looser setting\.$/, "")} Leave out --model-api.`);
    return EXIT_PREFLIGHT.couldNotRun;
  }
  const verdicts: Array<{ what: string; verdict: Verdict }> = [];
  const show = (what: string, v: Verdict) => {
    verdicts.push({ what, verdict: v });
    if (v.kind === "fail") complain(`✗ ${what}: ${v.line}`);
    else say(`${v.kind === "ok" ? "✓" : "!"} ${what}: ${v.line}`);
  };
  let header: AppHeader | null;
  try {
    header = readAppHeader(io.env);
  } catch (err) {
    complain(`scenescout preflight: ${(err as Error).message}`);
    return EXIT_PREFLIGHT.couldNotRun;
  }
  let proxy: ProxySettings | null;
  try {
    proxy = readProxy(io.env);
  } catch (err) {
    complain(`scenescout preflight: ${(err as Error).message}`);
    return EXIT_PREFLIGHT.couldNotRun;
  }
  // Said first, so a reader knows which route the answers below took and what went with them.
  if (proxy) say(`· ${proxyLine(proxy)}`);
  if (header) say(`· ${appHeaderLine(header, o.url)}`);
  show("App", await checkPage(o, io, header));
  const signIn = checkSignIn(o, io);
  if (signIn) show("Sign-in", signIn);
  if (o.modelApi) show("Model API", await checkModelApi(o, io));
  const code = preflightExitCode(verdicts.map((v) => v.verdict));
  const failed = verdicts.filter((v) => v.verdict.kind === "fail").map((v) => v.what);
  if (code === EXIT_PREFLIGHT.ready) say(`Preflight passed: ${verdicts.map((v) => v.what).join(", ")}.`);
  else complain(`Preflight failed (exit ${code}): ${failed.join(", ")}.`);
  return code;
}
