/**
 * The hosts SceneScout may point a browser at: the operator's `hosts` list
 * (the config file's key, or SCENESCOUT_HOSTS) caps the address an attach, a
 * sign-in window, `scenescout check` and `scenescout ci` start on. Navigation,
 * a crawl and a replayed request are already fenced to the attached origin, so
 * the cap on the start address holds them too. No list is every host, as
 * without a config. Pure logic, table-tested in policy-test; the `/scenescout
 * qa` gate keeps its own copy (action/qa-action.mjs), held equal in qa-test.
 */

/** The environment variable naming the hosts. The config file's list is the most it may name. */
export const HOSTS_ENV = "SCENESCOUT_HOSTS";

/** The most hosts one list may name. */
export const MAX_HOSTS = 50;

/** One host an entry names: its name, whether it stands for the subdomains of that name instead, and its port if it names one. */
export interface HostPattern {
  /** The entry in one spelling: lower case, no trailing dot. */
  entry: string;
  hostname: string;
  subdomains: boolean;
  port: number | null;
}

const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };

/** A host name as the URL parser writes it, lower case and punycode, without a trailing dot; null when it is not one. */
function canonicalHost(name: string): string | null {
  if (name === "" || [...name].some((c) => c.trim() === "" || "/?#@\\%".includes(c))) return null;
  let u: URL;
  try {
    u = new URL(`http://${name}`);
  } catch {
    return null;
  }
  if (u.port !== "" || u.pathname !== "/") return null;
  return u.hostname.endsWith(".") ? u.hostname.slice(0, -1) : u.hostname;
}

/**
 * The entries parsed, and what was given that is not one. An entry is a host
 * (`app.example.com`, `localhost`, `127.0.0.1`, `[::1]`), optionally with a
 * port (`localhost:3000`), or `*.` before a name of two labels or more
 * (`*.preview.example.com`), which stands for that name's subdomains and not
 * the name itself. A URL, a path or a bare `*` is not an entry.
 */
export function hostEntries(list: readonly string[]): { hosts: HostPattern[]; rejected: string[] } {
  const hosts: HostPattern[] = [];
  const rejected: string[] = [];
  for (const raw of list) {
    const parsed = hostEntry(raw.trim().toLowerCase());
    if (parsed) hosts.push(parsed);
    else rejected.push(raw);
  }
  return { hosts, rejected };
}

function hostEntry(text: string): HostPattern | null {
  const subdomains = text.startsWith("*.");
  let rest = subdomains ? text.slice(2) : text;
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  // A colon after the closing bracket of an IPv6 address, or the only colon of a name, starts a port.
  if (colon !== -1 && (rest.startsWith("[") ? rest.lastIndexOf("]") < colon : rest.indexOf(":") === colon)) {
    const digits = rest.slice(colon + 1);
    if (digits === "" || [...digits].some((c) => c < "0" || c > "9")) return null;
    port = Number(digits);
    if (port < 1 || port > 65535) return null;
    rest = rest.slice(0, colon);
  }
  const hostname = canonicalHost(rest);
  if (hostname === null || hostname.includes("*")) return null;
  // A wildcard over one label (`*.com`) would stand for a whole top-level domain.
  if (subdomains && (hostname.startsWith("[") || hostname.split(".").length < 2)) return null;
  const entry = `${subdomains ? "*." : ""}${hostname}${port === null ? "" : `:${port}`}`;
  return { entry, hostname, subdomains, port };
}

/** An entry in one spelling, so lists are compared entry by entry. Unreadable: trimmed as written. */
export function hostKey(entry: string): string {
  return hostEntries([entry]).hosts[0]?.entry ?? entry.trim();
}

/** A rejected entry as an error quotes it: an address loses its user name and password, which a pasted URL may carry. */
export function shownHostEntry(entry: string): string {
  try {
    const u = new URL(entry.trim());
    if (u.username || u.password) return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    // Not an address: nothing in it is a credential the URL parser would find.
  }
  return entry;
}

/** The entries SCENESCOUT_HOSTS names: separated by commas, spaces or new lines. */
export function hostsFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** The entry that allows `url`, or null: an http(s) address whose host is named (or is a subdomain of a `*.` entry) on the port the entry names, if any. */
export function matchHost(hosts: readonly HostPattern[], url: string): HostPattern | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!(u.protocol in DEFAULT_PORT)) return null;
  const port = u.port === "" ? DEFAULT_PORT[u.protocol] : Number(u.port);
  const name = u.hostname.endsWith(".") ? u.hostname.slice(0, -1) : u.hostname;
  return hosts.find((h) => (h.port === null || h.port === port) && (h.subdomains ? name.endsWith(`.${h.hostname}`) : name === h.hostname)) ?? null;
}
