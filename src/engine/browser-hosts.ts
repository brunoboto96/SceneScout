/**
 * The hosts a page may reach (the operator's `browserHosts` list, or
 * SCENESCOUT_BROWSER_HOSTS): with a list set, every request the browser sends
 * to a host that is neither the app's nor listed is refused before it leaves
 * the machine (ADR 35). That holds for page loads and the later hops of their
 * redirects, a page's scripts, styles, images and frames, fetch and XHR, and
 * WebSockets. No list is every host, as without a config.
 *
 * The rule is here, table-tested in policy-test; the route handler applies it
 * (route-guard.ts RouteGuard.handleHosts, probeRedirect and the browser-level
 * interception), and `scenescout policy explain` reads it from here too.
 */
import { hostEntries, matchHost, type HostPattern } from "./hosts.js";

/** The environment variable naming the hosts a page may reach besides the app's. The config file's list is the most it may name. */
export const BROWSER_HOSTS_ENV = "SCENESCOUT_BROWSER_HOSTS";

/** The why a refusal of another host carries, as the notice and the action log name it. */
export const BROWSER_HOST_REFUSAL = "not the app's host and not on the browserHosts list";

/** The list as one session holds it: the app it is attached to, and the hosts the operator named besides it. */
export interface BrowserHostList {
  appUrl: string;
  hosts: readonly HostPattern[];
}

/** The list for a session on `appUrl`, from the entries the operator named; an entry that is not a host is dropped (the config refuses one first). */
export function browserHostList(appUrl: string, entries: readonly string[]): BrowserHostList {
  return { appUrl, hosts: hostEntries(entries).hosts };
}

/**
 * The app's own host as entries: its name on its port, and, when it is on
 * plain http's default port, the same name on https's, since an app commonly
 * moves its pages to https on the same name. Another port of the same name is
 * another service and must be listed.
 */
export function appHostPatterns(appUrl: string): HostPattern[] {
  let u: URL;
  try {
    u = new URL(appUrl);
  } catch {
    return [];
  }
  const hostname = u.hostname.endsWith(".") ? u.hostname.slice(0, -1) : u.hostname;
  const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const own: HostPattern = { entry: hostname, hostname, subdomains: false, port };
  return u.protocol === "http:" && port === 80 ? [own, { ...own, port: 443 }] : [own];
}

/** Schemes that load nothing from the network: a page may always use them. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);
/** A WebSocket's scheme as the http one its handshake is sent over, so the same entries hold it. */
const SOCKET_SCHEME: Record<string, string> = { "ws:": "http:", "wss:": "https:" };

/**
 * The host the list refuses `url` for, as a refusal names it (the host and
 * port, never the address, which may carry a token), or null when it may go:
 * no list, an address on the app's host or a listed one, or one that loads
 * nothing from the network (data:, blob:, about:). Any other scheme, and an
 * address that does not parse, is refused.
 */
export function refusedBrowserHost(list: BrowserHostList | null, url: string): string | null {
  if (list === null) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "an address that is not a URL";
  }
  if (LOCAL_SCHEMES.has(u.protocol)) return null;
  const scheme = SOCKET_SCHEME[u.protocol] ?? u.protocol;
  if (scheme !== "http:" && scheme !== "https:") return `a ${u.protocol} address`;
  if (scheme !== u.protocol) u = new URL(`${scheme}//${u.host}${u.pathname}`);
  if (matchHost(appHostPatterns(list.appUrl), u.href) || matchHost(list.hosts, u.href)) return null;
  return u.host;
}

/**
 * What to do with the answer to a top-level page load SceneScout sent itself
 * to see where it leads, on an engine whose later redirect hops are not routed
 * (browsers.ts hostRedirectHops): null when it is not a redirect (the answer is
 * handed to the browser); "refuse" when the next hop is on a host the list
 * refuses; "stand-in" when it is allowed, answered with a page that loads the
 * next address itself, as a new page load that comes back to the route
 * handler. A load is only probed when it is a GET, and a redirect of a GET is
 * a GET, so no body is ever resent.
 */
export function hostRedirectPlan(input: {
  status: number;
  location: string | undefined;
  requestUrl: string;
  list: BrowserHostList;
}): { kind: "refuse"; host: string; url: string } | { kind: "stand-in"; url: string } | null {
  if (input.status < 300 || input.status >= 400 || !input.location) return null;
  let next: string;
  try {
    next = new URL(input.location, input.requestUrl).href;
  } catch {
    return { kind: "refuse", host: "an address that is not a URL", url: input.location };
  }
  const host = refusedBrowserHost(input.list, next);
  return host === null ? { kind: "stand-in", url: next } : { kind: "refuse", host, url: next };
}

/**
 * The Content-Security-Policy a document gets while a list is set, on an
 * engine that routes no redirect hop (browsers.ts hostRedirectHops
 * "page-loads"): the browser itself then refuses a subresource, or a redirect
 * of one, to a host the list refuses, and a form sent there, which is the one
 * thing those engines would otherwise let out unseen (and Firefox does not
 * route an <object>'s load at all). Joined to the document's own policy, so
 * it only narrows (withBrowserHostsPolicy). A host CSP cannot spell
 * (an IPv6 address) is left out, so a listed one is refused; the app's own is
 * still 'self'.
 */
export function browserHostsPolicy(list: BrowserHostList): string {
  const hosts: string[] = [];
  const sockets: string[] = [];
  for (const p of [...appHostPatterns(list.appUrl), ...list.hosts]) {
    if (p.hostname.startsWith("[")) continue;
    const at = `${p.subdomains ? "*." : ""}${p.hostname}:${p.port === null ? "*" : p.port}`;
    hosts.push(`http://${at}`, `https://${at}`);
    sockets.push(`ws://${at}`, `wss://${at}`);
  }
  const own = ["'self'", ...new Set(hosts)].join(" ");
  // Each socket host by name: WebKit lets a bare ws: or wss: source match an http or https address too.
  return [
    `default-src ${own} data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
    `connect-src ${own} ${[...new Set(sockets)].join(" ")} data: blob:`,
    `form-action ${own}`,
  ].join("; ");
}

/** A response's Content-Security-Policy with the list's added: a second policy joined with a comma is enforced alongside the first. */
export function withBrowserHostsPolicy(existing: string | undefined, policy: string): string {
  return existing && existing.trim() ? `${existing}, ${policy}` : policy;
}

/** The binding a page reports a refusal of the list's policy through (browserHostsViolationScript). */
export const BROWSER_HOSTS_VIOLATION_BINDING = "__scenescoutBrowserHosts";

/**
 * Run in every page before its own scripts while the list's policy is in
 * force: a request the policy refused never reaches a route handler, so each
 * refusal of a host is handed to SceneScout here, to be reported as the route
 * handler's are. Only the list's own refusals (by its form-action, or a
 * blocked address the list refuses): the app's own policy's are the app's.
 */
export function browserHostsViolationScript(binding = BROWSER_HOSTS_VIOLATION_BINDING): string {
  return `(() => {
  const send = globalThis[${JSON.stringify(binding)}];
  if (typeof send !== "function") return;
  // A send that throws means the page is going away: nothing is left to report it to.
  addEventListener("securitypolicyviolation", (e) => {
    try { send({ url: String(e.blockedURI || ""), directive: String(e.effectiveDirective || e.violatedDirective || ""), policy: String(e.originalPolicy || "") }); } catch {}
  }, true);
})()`;
}

/**
 * What a reported policy refusal is to the list: the address refused, or null
 * when it is not the list's (another policy's, or an address the list allows,
 * which a browser names for a redirect it refused, since it reports the
 * address the request started at). `policy` is the list's, as sent.
 */
export function browserHostsViolation(
  list: BrowserHostList | null,
  policy: string | null,
  report: unknown,
): { url: string; redirect: boolean; form: boolean } | null {
  if (list === null || policy === null || typeof report !== "object" || report === null) return null;
  const { url, directive, policy: original } = report as Record<string, unknown>;
  if (typeof url !== "string" || typeof directive !== "string" || typeof original !== "string") return null;
  // A browser serializes the policy as it parsed it: compared by its directives, each in one spelling.
  const spelled = (text: string) =>
    text
      .split(";")
      .map((d) => d.trim().split(" ").filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ");
  if (spelled(original) !== spelled(policy)) return null;
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return null;
  }
  const form = directive === "form-action";
  if (refusedBrowserHost(list, href) !== null) return { url: href, redirect: false, form };
  return { url: href, redirect: true, form };
}

/** The most redirects of one page load followed through stand-in pages before the load is refused, as a browser stops a loop. */
export const BROWSER_HOST_MAX_HOPS = 20;

/** The attach's line for the list, or "" when none is set. `from` names what set it. */
export function browserHostsNotice(list: BrowserHostList | null, from: string, redirectHops: "browser-level" | "page-loads"): string {
  if (list === null) return "";
  const named = list.hosts.map((h) => h.entry);
  const hops =
    redirectHops === "browser-level"
      ? "a redirect to one included"
      : "a redirect to one included (in this browser a page's or frame's load and a worker's script are sent by SceneScout to judge their redirects, and every other request's redirect is refused by a Content-Security-Policy the page is given)";
  return ` Browser hosts (${from}): the page may reach only the app's own host${named.length > 0 ? ` and ${named.join(", ")}` : ""}; a request to any other host, ${hops}, is refused before it leaves the machine.`;
}

/** One refusal, as the engine noted it: what it was, and whether it came before the action reporting it. */
export interface HostBlock {
  sig: string;
  late: boolean;
}

/** The notices for refused hosts: each in full once per session, then counted. */
export class HostBlockNotices {
  private seen = new Set<string>();
  private explained = false;

  /** Forget everything said: a re-attached session starts a new conversation. */
  reset(): void {
    this.seen.clear();
    this.explained = false;
  }

  /** The notice for the requests refused since the last action, or "" when there were none. */
  notice(blocked: readonly HostBlock[]): string {
    if (blocked.length === 0) return "";
    const counts = new Map<string, { n: number; late: boolean }>();
    for (const b of blocked) {
      const c = counts.get(b.sig);
      if (c) {
        c.n += 1;
        c.late &&= b.late;
      } else counts.set(b.sig, { n: 1, late: b.late });
    }
    const fresh = [...counts].filter(([sig]) => !this.seen.has(sig));
    const repeats = counts.size - fresh.length;
    for (const [sig] of fresh) this.seen.add(sig);
    const head = "\n🛡 BROWSER-HOSTS blocked: ";
    const again = repeats > 0 ? `${repeats === 1 ? "1 known request" : `${repeats} known requests`} refused as before` : "";
    if (fresh.length === 0) return `${head}${again}. The operator's browserHosts setting, not an app bug.`;
    const list =
      fresh
        .slice(0, 5)
        .map(([sig, c]) => `${sig}${c.n > 1 ? ` ×${c.n}` : ""}${c.late ? " (late — likely background traffic)" : ""}`)
        .join("; ") + (fresh.length > 5 ? ` (+${fresh.length - 5} more)` : "");
    const also = again ? `; also ${again}` : "";
    if (this.explained) return `${head}${list}${also}. The operator's browserHosts setting, not an app bug (explained earlier in this session).`;
    this.explained = true;
    return (
      `${head}${list}${also}. The operator's browserHosts setting lets the browser reach only the app's own host and the hosts it lists, ` +
      "so these requests never left the machine. This is the tester's safety setting, NOT an app bug: do not file a finding for a part of the page that did not load because of it, " +
      "and note what it stopped as untested. A page load that was refused, a redirect to another site included, left the page where it was."
    );
  }
}
