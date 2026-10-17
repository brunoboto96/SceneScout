import { createHash } from "node:crypto";
import { fromJs } from "./js-regex.js";
import { isSpace, LinearRegex, runEnd } from "./linear-regex.js";

const UUID_RE = fromJs(String.raw`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, "i");
const HEX_RE = fromJs(String.raw`^[0-9a-f]{12,}$`, "i");
const NUM_RE = fromJs(String.raw`^\d+$`);

/** Query params that name a UI state (a different screen), not transient data. */
const UI_STATE_PARAM_RE = fromJs(String.raw`^(tab|view|mode|step|panel|section)$`, "i");

/** Letters, digits and single `-`/`_` separators: the alphabet a code-shaped record id is written in. */
const CODE_ALPHABET_RE = fromJs(String.raw`^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$`);
/** An upper-case prefix, then digits: `WID-2025-001`, `INV2024`, `PO_77`. */
const CODE_PREFIX_RE = fromJs(String.raw`^[A-Z]{1,6}[-_]?\d[A-Za-z0-9_-]*$`);

const DIGIT_RE = fromJs(String.raw`\d`);
const SEPARATOR_RE = fromJs(String.raw`[-_]`);
const WHITE_SPACE_RE = fromJs(String.raw`\s+`);
const API_PATH_RE = fromJs(String.raw`^\/api(\/|$)`, "i");
const FILE_PATH_RE = fromJs(String.raw`\.(pdf|zip|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|ico|mp4|webm|json|xml)$`, "i");
const EXPORT_QUERY_RE = fromJs(String.raw`\b(format=(csv|pdf|xlsx?|docx?)|download=(1|true))\b`, "i");
const QUERY_RE = fromJs(String.raw`\?[^\s()[\]]*`);
/** A character that ends a route in a lane's text: white space or a bracket. */
const isRouteEnd = (c: string) => isSpace(c) || "()[]".includes(c);
// A "#" not followed by a slash, and the fragment after it: the group is the lookahead, and the match is read on to the end of the fragment.
const FRAGMENT_RE = new LinearRegex(String.raw`#([^/]|$)`, { lookahead: true, extend: ({ end }, text) => runEnd(text, end, (c) => !isRouteEnd(c)) });
const CREDENTIAL_PAIR_RE = fromJs(String.raw`[\w-]*(token|signature|secret|password|session|code|key|auth|credential)[\w-]*=[^\s()[\]]*`, "i");

/**
 * Whether a segment reads as a code-shaped record id (`WID-2025-001`,
 * `A1B2C3`) rather than a word or a slug. Every record such an id addresses
 * would otherwise be its own route. Words are kept: a slug whose digits are a
 * small part of it (`how-to-2024-guide`, `iphone-15-pro`), a short one with a
 * digit or two (`v2`, `2fa`, `q3`), and anything outside the id alphabet.
 * An upper-case prefix followed by digits is an id with two digits or more;
 * otherwise it takes three digits making up at least half the characters.
 */
function isCodeId(seg: string): boolean {
  if (!CODE_ALPHABET_RE.test(seg)) return false;
  const digits = [...DIGIT_RE.matchAll(seg)].length;
  if (CODE_PREFIX_RE.test(seg) && digits >= 2) return true;
  const chars = SEPARATOR_RE.replace(seg, "").length;
  return digits >= 3 && digits * 2 >= chars;
}

/**
 * Whether a path segment is an id that route identity collapses to `:id`: a
 * UUID or long hex string anywhere, and from the second real segment on, a
 * number or a code-shaped id (isCodeId). `index` counts as `path.split("/")`
 * does, so the first real segment of a leading-slash path is 1 (see the note
 * on numeric first segments below).
 */
export function isIdSegment(seg: string, index: number): boolean {
  if (UUID_RE.test(seg) || HEX_RE.test(seg)) return true;
  if (index <= 1) return false;
  return NUM_RE.test(seg) || isCodeId(seg);
}

/**
 * Normalize a URL into a route-class identity:
 * - path ids collapse (/orders/123 → /orders/:id)
 * - hash-router paths count as the path (#/orders/5 → /orders/:id)
 * - UI-state query params are KEPT (?tab=audit is a different screen;
 *   ?page=2 is not) so tabs are enumerable, crawlable, and countable.
 *
 * A NUMERIC FIRST SEGMENT IS NOT AN ID. `/404` and `/500` are the two most
 * common static pages in any web app, and collapsing them to `/:id` made them
 * aliases of each other: visiting the 404 page marked the 500 page covered,
 * because the unvisited filter compares normalized forms. Ids in real apps
 * follow a collection noun (`/documents/239`, `/orders/5`), so position 1 is
 * where static numeric pages live and position 2+ is where ids live. A UUID or
 * long hex string still collapses anywhere — no static page is named one.
 */
export function normalizePath(rawUrl: string): string {
  let path: string;
  let search: string;
  try {
    const u = new URL(rawUrl, "http://x");
    path = u.pathname;
    search = u.search;
    if (u.hash.startsWith("#/")) {
      const [hashPath, hashQuery] = u.hash.slice(1).split("?");
      path = hashPath;
      search = hashQuery ? `?${hashQuery}` : "";
    }
  } catch {
    [path = "/", search = ""] = rawUrl.split("?");
    search = search ? `?${search}` : "";
  }
  // segments[0] is always "" for a leading-slash path, so the first REAL
  // segment is index 1 — that is the one a bare numeric page occupies.
  const segments = path.split("/").map((seg, i) => (isIdSegment(seg, i) ? ":id" : seg));
  let normalized = segments.join("/") || "/";
  if (normalized === "") normalized = "/";

  const kept: string[] = [];
  for (const [k, v] of new URLSearchParams(search)) {
    if (UI_STATE_PARAM_RE.test(k)) kept.push(`${k}=${v.slice(0, 40)}`);
  }
  if (kept.length > 0) normalized += `?${kept.sort().join("&")}`;
  return normalized;
}

/**
 * Whether refs a snapshot took at `from` may still be used at `to`: the same
 * origin and the exact same path (hash-route path included), differing at
 * most in query parameters that are not UI state, or in an in-page fragment.
 * A search box's "Clear" or a filter that rewrites only `?q=` leaves the same
 * screen with the same controls; a tab parameter, another path or an id in the
 * path does not. A record chosen by a query parameter (`?id=6`) does keep them,
 * so the action checks the element it finds (test id and name) before acting:
 * a list that now shows other rows under the same paths cannot hand it another one.
 */
export function refsSurviveUrlChange(from: string, to: string): boolean {
  if (from === to) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return false;
  }
  if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
  const hashPath = (u: URL): string => (u.hash.startsWith("#/") ? u.hash.split("?")[0] : "");
  if (hashPath(a) !== hashPath(b)) return false;
  return normalizePath(from) === normalizePath(to);
}

/** A route without its UI-state query: the screen whose tabs are its variants ("/things/:id?tab=history" → "/things/:id"). */
export function routeBase(route: string): string {
  return route.split("?")[0];
}

/**
 * Paths that are not UI pages, however they entered the route list: API
 * endpoints and file downloads.
 *
 * `harvestRoutes` already skips these when it reads an href, but a route can
 * also arrive by navigation, or from a memory written before that filter
 * existed — and once in the contract it sits in the gap ledger forever, since
 * "visiting" it downloads a file instead of rendering a page, so it can never
 * be exercised or audited. Filtering at the CONTRACT boundary means no entry
 * path can reintroduce one. The query check catches export links whose path
 * looks page-like (`/reports/export?format=csv`).
 */
export function isNonPageRoute(route: string): boolean {
  const [path, query = ""] = route.split("?");
  if (API_PATH_RE.test(path)) return true;
  if (FILE_PATH_RE.test(path)) return true;
  return EXPORT_QUERY_RE.test(query);
}

export interface InteractableInfo {
  role: string;
  name: string;
  testid: string | null;
}

/** Stable key identifying an element class within a state (for coverage tracking). */
export function elementKey(el: InteractableInfo): string {
  if (el.testid) return `tid:${el.testid}`;
  const name = WHITE_SPACE_RE.replace(el.name.toLowerCase(), " ").trim().slice(0, 60);
  return `${el.role}:${name}`;
}

/**
 * Element keys made unique within one snapshot: the first holder of a base key
 * keeps it, later ones get `~1`, `~2` in document order.
 */
export function ordinalKeys(baseKeys: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return baseKeys.map((base) => {
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base}~${count}`;
  });
}

/**
 * Each key the earlier name rule gave a control that the current rule names
 * differently, as current key → earlier key, from both rules' base keys in
 * document order. Ordinals are worked out under each rule separately, so when
 * one of two unnamed image buttons gains a name, the other's move from `~1`
 * to the bare key is listed too. Only keys in `tracked` are listed: an
 * element coverage does not count needs no alias.
 */
export function keyAliases(bases: ReadonlyArray<{ base: string; prior: string; tracked: boolean }>): Record<string, string> {
  const now = ordinalKeys(bases.map((b) => b.base));
  const before = ordinalKeys(bases.map((b) => b.prior));
  const out: Record<string, string> = {};
  bases.forEach((b, i) => {
    if (b.tracked && now[i] !== before[i]) out[now[i]] = before[i];
  });
  return out;
}

/**
 * keyAliases for every step between name rules, from each element's base key
 * under each rule, rule 1 first and the current rule last: rule r (from 2)
 * → the step's aliases, current key under r → key under r - 1. A step that
 * renamed nothing is left out.
 */
export function keyAliasSteps(bases: ReadonlyArray<{ byRule: readonly string[]; tracked: boolean }>): Record<number, Record<string, string>> {
  const rules = bases.length > 0 ? bases[0].byRule.length : 0;
  const out: Record<number, Record<string, string>> = {};
  for (let i = 1; i < rules; i++) {
    const step = keyAliases(bases.map((b) => ({ base: b.byRule[i], prior: b.byRule[i - 1], tracked: b.tracked })));
    if (Object.keys(step).length > 0) out[i + 1] = step;
  }
  return out;
}

/**
 * Fingerprint a UI state: normalized route + hash of the set of interactable
 * element classes. Same page with different data → same fingerprint; a page
 * whose available actions changed (modal opened, different role) → new one.
 */
export function fingerprintState(url: string, elements: InteractableInfo[]): string {
  const route = normalizePath(url);
  const keys = [...new Set(elements.map(elementKey))].sort();
  const hash = createHash("sha256").update(keys.join("|")).digest("hex").slice(0, 8);
  return `${route}#${hash}`;
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 10);
}

/**
 * A route as a lane wrote it, with every query string and every fragment that
 * is not a hash route removed. A lane copies routes out of the address bar, and
 * an address can carry `?access_token=`, `?code=`, `?session_id=` or a signed
 * URL's `X-Amz-Signature=`; none of it identifies the page, and none of it may
 * be stored or archived. A hash route (`#/things`) keeps its path, not its query.
 * A `name=value` pair whose name reads as a credential is removed wherever it is.
 */
export function stripRouteQuery(route: string): string {
  return CREDENTIAL_PAIR_RE.replace(FRAGMENT_RE.replace(QUERY_RE.replace(route, ""), ""), "").trim();
}

/** Page files a lane may name without a leading slash ("orders.html"). */
const BARE_PAGE_RE = fromJs(String.raw`^[\w-]+(\/[\w.-]+)*\.(html?|php|aspx?|jsp)$`, "i");
/** A host with a port, or a loopback or IPv4 host, written without a scheme ("127.0.0.1:4173/orders.html"). */
const BARE_HOST_RE = fromJs(String.raw`^(?:[\w.-]+:\d+|localhost|\d{1,3}(?:\.\d{1,3}){3})(\/.*)?$`, "i");
const LANE_ROUTE_SPLIT_RE = fromJs(String.raw`[\s,;|+()[\]]+|→|->|=>`);
const TOKEN_EDGE_RE = fromJs(String.raw`^[<"'\`]+|[>"'\`.:!]+$`);
const SCHEME_URL_RE = fromJs(String.raw`^https?:\/\/[^/\s]+(\/.*)?$`, "i");
const QUERY_OR_HASH_RE = fromJs(String.raw`[?#]`);
const INDEX_PAGE_RE = fromJs(String.raw`\/index\.html?$`, "i");
const TRAILING_SLASHES_RE = fromJs(String.raw`\/+$`);

/**
 * Every path one route from a lane report names, in the form a benchmark key
 * entry's `route` is written in; empty when it names none.
 *
 * A lane writes its routes as free text — "/order.html?id=1042 (from
 * /orders.html link)", "Orders (/orders.html)", "orders.html",
 * "127.0.0.1:4173/orders.html", "/reports.html and /reports-scheduled.html".
 * EVERY path in it counts, including one in a note: the benchmark uses these
 * to set aside a verdict as another lane's, so a page left out makes a wrong
 * verdict disappear, while a page taken in only keeps a verdict scored. A bare
 * origin is "/", a bare page file gains its slash, the query goes, ids
 * collapse as the engine's route identity collapses them, and "/index.html" is
 * "/".
 */
export function laneRoutePaths(raw: string): string[] {
  const out = new Set<string>();
  for (const word of LANE_ROUTE_SPLIT_RE.splitText(raw)) {
    const token = TOKEN_EDGE_RE.replace(word, "");
    if (!token) continue;
    let path: string | undefined;
    const url = SCHEME_URL_RE.exec(token) ?? BARE_HOST_RE.exec(token);
    if (url) path = url.groups[1] || "/";
    else if (token.startsWith("/") || token.startsWith("#/")) path = token;
    else if (BARE_PAGE_RE.test(QUERY_OR_HASH_RE.splitText(token)[0])) path = `/${token}`;
    if (path === undefined) continue;
    let p = normalizePath(path).split("?")[0];
    p = INDEX_PAGE_RE.replace(p, "/");
    if (p.length > 1) p = TRAILING_SLASHES_RE.replace(p, "");
    out.add(p || "/");
  }
  return [...out];
}
