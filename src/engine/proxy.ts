/**
 * Reaching the network through a proxy (#555). SceneScout reads the standard
 * variables, `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (each also in lower
 * case, which wins, as curl and Node's own proxy support read them), or
 * `SCENESCOUT_PROXY`, which replaces them for SceneScout alone: a proxy URL,
 * or `off` to reach everything directly whatever the standard variables say.
 *
 * Two clients use what is read here:
 * - the browser a session drives, through Playwright's `proxy` option on its
 *   context (`browserProxy`): one proxy for every request the pages make, with
 *   `NO_PROXY`'s hosts passed as its bypass list;
 * - SceneScout's own requests through Node's `fetch` (the preflight, the
 *   model's API, GitHub and Jira), through undici's EnvHttpProxyAgent as the
 *   process's global dispatcher (`installFetchProxy`), only when a proxy is set.
 *
 * A proxy URL may carry a user name and password. They go to the browser as
 * its own fields and never into a line that is printed: `proxyLine` names the
 * proxy without them. Nothing here decides what may be sent: the `egress`
 * setting (project-config.ts) is applied before any request is made, and a
 * proxy only changes the route a permitted request takes.
 *
 * The rules are table-tested in policy-test.
 */

/** SceneScout's own proxy setting: a URL, or `off`. It replaces the standard variables for SceneScout. */
export const PROXY_ENV = "SCENESCOUT_PROXY";

/** The standard variables, in the order they are read: lower case first. */
export const STANDARD_PROXY_ENV = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY"] as const;

/** The proxy settings in effect: one URL per scheme and the hosts that go direct. Null when no proxy is set. */
export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  /** NO_PROXY's entries, as written: hosts, `.domain` suffixes, `host:port`, addresses. */
  noProxy: string[];
  /** Where the settings came from, for the line that names them. */
  source: "SCENESCOUT_PROXY" | "environment";
}

function first(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** A proxy URL, checked: http or https, a host, and nothing past the port. The error never repeats the URL, which may carry a password. */
function checkProxyUrl(raw: string, name: string): string {
  let u: URL;
  try {
    // "proxy.example.com:3128" with no scheme is how many people write it; curl and undici read it as http.
    u = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new Error(`${name} is not a proxy URL (write it as http://host:port).`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${name} must be an http or https proxy URL (got ${u.protocol}).`);
  if (!u.hostname) throw new Error(`${name} names no host.`);
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) throw new Error(`${name} must be a proxy's address only, with no path or query.`);
  return u.href.replace(/\/$/, "");
}

/** The NO_PROXY list, split. `*` alone means no proxy for anything. */
function splitNoProxy(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * The proxy settings the environment gives, or null when there is none (or
 * SCENESCOUT_PROXY is `off`, or NO_PROXY is `*`). A URL that is not a proxy's
 * throws, naming the variable, so a run never goes direct while the operator
 * believes it is proxied.
 */
export function readProxy(env: Record<string, string | undefined>): ProxySettings | null {
  const own = env[PROXY_ENV]?.trim();
  if (own && own.toLowerCase() === "off") return null;
  const noProxy = splitNoProxy(first(env, ["no_proxy", "NO_PROXY"]));
  if (noProxy.includes("*")) return null;
  if (own) {
    const url = checkProxyUrl(own, PROXY_ENV);
    return { httpProxy: url, httpsProxy: url, noProxy, source: "SCENESCOUT_PROXY" };
  }
  const httpRaw = first(env, ["http_proxy", "HTTP_PROXY"]);
  const httpsRaw = first(env, ["https_proxy", "HTTPS_PROXY"]);
  if (!httpRaw && !httpsRaw) return null;
  const httpProxy = httpRaw ? checkProxyUrl(httpRaw, env.http_proxy?.trim() ? "http_proxy" : "HTTP_PROXY") : undefined;
  const httpsProxy = httpsRaw ? checkProxyUrl(httpsRaw, env.https_proxy?.trim() ? "https_proxy" : "HTTPS_PROXY") : undefined;
  return { ...(httpProxy ? { httpProxy } : {}), ...(httpsProxy ? { httpsProxy } : {}), noProxy, source: "environment" };
}

/** Playwright's proxy option. */
export interface BrowserProxy {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

/**
 * The browser's proxy for an app at `appUrl`, or null. A browser takes one
 * proxy for everything, so it is the one for the app's scheme: an https app
 * uses HTTPS_PROXY, falling back to HTTP_PROXY as undici does, and an http app
 * uses HTTP_PROXY. NO_PROXY's entries are the bypass list; a browser never
 * sends its own machine's addresses through a proxy whatever the list says.
 */
export function browserProxy(settings: ProxySettings | null, appUrl: string): BrowserProxy | null {
  if (!settings) return null;
  let https = true;
  try {
    https = new URL(appUrl).protocol === "https:";
  } catch {
    // An address that does not parse is refused by the attach itself; the https proxy is the safer guess meanwhile.
  }
  const chosen = https ? (settings.httpsProxy ?? settings.httpProxy) : settings.httpProxy;
  if (!chosen) return null;
  const u = new URL(chosen);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  return {
    server: u.href.replace(/\/$/, ""),
    ...(settings.noProxy.length > 0 ? { bypass: settings.noProxy.join(",") } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/** A proxy URL as printed: no user name or password. */
export function shownProxy(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return "(a proxy URL that does not parse)";
  }
}

/** The one line that says which proxy is in effect, with no credential in it. */
export function proxyLine(settings: ProxySettings): string {
  const parts: string[] = [];
  if (settings.httpsProxy && settings.httpsProxy === settings.httpProxy) parts.push(`through ${shownProxy(settings.httpsProxy)}`);
  else {
    if (settings.httpsProxy) parts.push(`https through ${shownProxy(settings.httpsProxy)}`);
    if (settings.httpProxy) parts.push(`http through ${shownProxy(settings.httpProxy)}`);
  }
  if (settings.noProxy.length > 0) parts.push(`direct for ${settings.noProxy.join(", ")}`);
  return `Proxy (${settings.source === "SCENESCOUT_PROXY" ? PROXY_ENV : "HTTPS_PROXY / HTTP_PROXY / NO_PROXY"}): ${parts.join("; ")}.`;
}

/** The options undici's EnvHttpProxyAgent takes for these settings. */
export function fetchProxyOptions(settings: ProxySettings): { httpProxy?: string; httpsProxy?: string; noProxy: string } {
  return {
    ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}),
    ...(settings.httpsProxy ? { httpsProxy: settings.httpsProxy } : {}),
    noProxy: settings.noProxy.join(","),
  };
}

let installed = false;

/**
 * Send this process's `fetch` through the proxy the environment names, when
 * it names one; otherwise change nothing. Called once as a command or the MCP
 * server starts, before any request. Returns the settings it installed, or null.
 */
export async function installFetchProxy(env: Record<string, string | undefined>): Promise<ProxySettings | null> {
  const settings = readProxy(env);
  if (!settings || installed) return settings;
  // Loaded only when a proxy is set, so a run with none pays nothing for it.
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent(fetchProxyOptions(settings)));
  installed = true;
  return settings;
}
