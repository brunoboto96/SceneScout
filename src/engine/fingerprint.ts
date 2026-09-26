import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const NUM_RE = /^\d+$/;

/** Query params that name a UI state (a different screen), not transient data. */
const UI_STATE_PARAM_RE = /^(tab|view|mode|step|panel|section)$/i;

/**
 * Whether a path segment is an id that route identity collapses to `:id`: a
 * UUID or long hex string anywhere, a number from the second real segment on.
 * `index` counts as `path.split("/")` does, so the first real segment of a
 * leading-slash path is 1 (see the note on numeric first segments below).
 */
export function isIdSegment(seg: string, index: number): boolean {
  if (UUID_RE.test(seg) || HEX_RE.test(seg)) return true;
  return NUM_RE.test(seg) && index > 1;
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
  if (/^\/api(\/|$)/i.test(path)) return true;
  if (/\.(pdf|zip|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|ico|mp4|webm|json|xml)$/i.test(path)) return true;
  return /\b(format=(csv|pdf|xlsx?|docx?)|download=(1|true))\b/i.test(query);
}

export interface InteractableInfo {
  role: string;
  name: string;
  testid: string | null;
}

/** Stable key identifying an element class within a state (for coverage tracking). */
export function elementKey(el: InteractableInfo): string {
  if (el.testid) return `tid:${el.testid}`;
  const name = el.name.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
  return `${el.role}:${name}`;
}

/**
 * Fingerprint a UI state: normalized route + hash of the set of interactable
 * element classes. Same page with different data → same fingerprint; a page
 * whose available actions changed (modal opened, different role) → new one.
 */
export function fingerprintState(url: string, elements: InteractableInfo[]): string {
  const route = normalizePath(url);
  const keys = [...new Set(elements.map(elementKey))].sort();
  const hash = createHash("sha1").update(keys.join("|")).digest("hex").slice(0, 8);
  return `${route}#${hash}`;
}

export function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}
