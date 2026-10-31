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

/** The most redirects of one page load followed through stand-in pages before the load is refused, as a browser stops a loop. */
export const BROWSER_HOST_MAX_HOPS = 20;

/** The attach's line for the list, or "" when none is set. `from` names what set it. */
export function browserHostsNotice(list: BrowserHostList | null, from: string, redirectHops: "browser-level" | "page-loads"): string {
  if (list === null) return "";
  const named = list.hosts.map((h) => h.entry);
  const hops =
    redirectHops === "browser-level"
      ? "a redirect to one included"
      : "a page load's redirect to one included (in this browser a redirect of a script's request or a frame's load is not judged)";
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
