/**
 * What a crawl makes of one route it loaded: whether an explicitly requested
 * path joins the route contract, and the summary line it prints. Kept out of
 * browser.ts so both rules can be table-tested without a browser.
 */
import { isNonPageRoute } from "./fingerprint.js";

/** One crawled route, as the summary line needs it. */
export interface CrawlOutcome {
  /** The path as the crawl was given it. */
  path: string;
  /** The HTTP status, or a word when there was none ("no-response"). */
  status: number | string;
  /** The requested path's route (fingerprint.ts normalizePath). */
  requestedRoute: string;
  /** The route the page ended on. */
  landedRoute: string;
  /** Whether it ended on the sign-in page: flagged AUTH-REDIRECT, not as an ordinary redirect. */
  loginRedirect: boolean;
  /** Whether the page had no controls at all (DEAD-END): an app that answers 200 for any path shows that for a path it does not have. */
  deadEnd?: boolean;
}

/**
 * The route an explicitly requested crawl path adds to the route contract,
 * or null. A path someone asked for, that answered with a page and stayed
 * where it was asked, is a route of the app whether or not any link names
 * it: left out, a sweep of forty extra paths left "Routes visited: 37/37"
 * unchanged and the report understated what was checked. A path that
 * redirected is not added (the page it landed on is the route that exists),
 * nor one that failed, nor a dead end (an app that answers 200 for every
 * path), nor an API or download path. Added routes are remembered across
 * runs, so a probe of made-up paths must not become part of the contract.
 */
export function crawledRoute(o: CrawlOutcome): string | null {
  if (typeof o.status !== "number" || o.status >= 400 || o.deadEnd) return null;
  if (o.loginRedirect || o.landedRoute !== o.requestedRoute) return null;
  if (isNonPageRoute(o.requestedRoute)) return null;
  return o.requestedRoute;
}

/**
 * The crawl's one line for a route. A path that ended on another route says
 * so, as scout_navigate does: "/old — 200 · 94 el" read as the old page
 * answering, when the 200 and the 94 elements were the page it landed on.
 * The sign-in bounce has its own flag (AUTH-REDIRECT) and is not repeated.
 */
export function crawlLine(o: CrawlOutcome, counts: { elements: number; missingTestid: number; unnamed: number }, flags: readonly string[]): string {
  const redirected = !o.loginRedirect && o.landedRoute !== o.requestedRoute;
  const allFlags = [...(redirected ? [`REDIRECTED → ${o.landedRoute}`] : []), ...flags];
  return (
    `${o.path} — ${o.status} · ${counts.elements} el` +
    (counts.missingTestid ? ` · ${counts.missingTestid} no-testid` : "") +
    (counts.unnamed ? ` · ${counts.unnamed} unnamed` : "") +
    (allFlags.length ? ` · ${allFlags.join(" ")}` : "")
  );
}
