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
  /**
   * What the main area showed when it held nothing but its state (collector
   * mainState): the app's error or not-found view, or a loading placeholder
   * still up after the page settled. Flagged ERROR-VIEW or STILL-LOADING.
   */
  mainState?: "error" | "loading" | null;
}

/** The crawl flag for a main area showing only its state, or null. */
export function mainStateFlag(state: CrawlOutcome["mainState"]): "ERROR-VIEW" | "STILL-LOADING" | null {
  return state === "error" ? "ERROR-VIEW" : state === "loading" ? "STILL-LOADING" : null;
}

/**
 * The route an explicitly requested crawl path adds to the route contract,
 * or null. A path someone asked for, that answered with a page and stayed
 * where it was asked, is a route of the app whether or not any link names
 * it: left out, a sweep of forty extra paths left "Routes visited: 37/37"
 * unchanged and the report understated what was checked. A path that
 * redirected is not added (the page it landed on is the route that exists),
 * nor one that failed, nor a dead end (an app that answers 200 for every
 * path), nor one whose main area showed only an error view or a loading
 * placeholder (a client-rendered app answers 200 and draws its not-found
 * view), nor an API or download path. Added routes are remembered across
 * runs, so a probe of made-up paths must not become part of the contract.
 */
export function crawledRoute(o: CrawlOutcome): string | null {
  if (typeof o.status !== "number" || o.status >= 400 || o.deadEnd || o.mainState) return null;
  if (o.loginRedirect || o.landedRoute !== o.requestedRoute) return null;
  if (isNonPageRoute(o.requestedRoute)) return null;
  return o.requestedRoute;
}

/**
 * The crawl's one line for a route. A path that ended on another route says
 * so, as scout_navigate does: "/old — 200 · 94 el" read as the old page
 * answering, when the 200 and the 94 elements were the page it landed on.
 * The sign-in bounce has its own flag (AUTH-REDIRECT) and is not repeated.
 * `main` is what the page's main area holds (collector mainRegionTag), so
 * "41 el" alone cannot hide a main area that rendered nothing.
 */
export function crawlLine(
  o: CrawlOutcome,
  counts: { elements: number; missingTestid: number; unnamed: number; main?: string | null },
  flags: readonly string[],
): string {
  const redirected = !o.loginRedirect && o.landedRoute !== o.requestedRoute;
  const allFlags = [...(redirected ? [`REDIRECTED → ${o.landedRoute}`] : []), ...flags];
  return (
    `${o.path} — ${o.status} · ${counts.elements} el` +
    (counts.main ? ` · ${counts.main}` : "") +
    (counts.missingTestid ? ` · ${counts.missingTestid} no-testid` : "") +
    (counts.unnamed ? ` · ${counts.unnamed} unnamed` : "") +
    (allFlags.length ? ` · ${allFlags.join(" ")}` : "")
  );
}

/** The media types a browser renders as a page: anything else a route answers with is a file, a feed or data. */
export const PAGE_MEDIA_TYPES: readonly string[] = ["text/html", "application/xhtml+xml"];

/**
 * A Content-Type header's media type, lowercased and without its parameters
 * ("text/HTML; charset=utf-8" → "text/html"); undefined when there is none.
 */
export function mediaTypeOf(header: string | null | undefined): string | undefined {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  return type === "" ? undefined : type;
}

/**
 * Whether a route's document answered as something other than a page: an RSS
 * or Atom feed, XML, JSON, plain text, a PDF, an image. Decided from the
 * response's content type, not the path, because a feed at `/feed`, a licence
 * file or a raw-file view has no extension to give it away, and a path ending
 * `.xml` can be served as HTML. Such a route has no controls by nature, so the
 * page rules (a dead end among them) do not apply to it, and it is not a page
 * for the route count. Only a response that succeeded counts: the body of a
 * 4xx or 5xx describes the error, not the route, and the error is reported as
 * the route's own. A response with no content type is read as a page, the
 * behaviour before the type was consulted.
 */
export function isNonPageResource(r: { status: number | null; contentType?: string | null }): boolean {
  if (r.status === null || r.status >= 400) return false;
  return isFileMediaType(r.contentType);
}

/**
 * Whether a response's content type names something other than a page, whatever
 * its status. A browser may take such a response as a download and fail the
 * navigation, so this is what says the route answered (with its status) rather
 * than failed to load.
 */
export function isFileMediaType(contentType: string | null | undefined): boolean {
  const type = mediaTypeOf(contentType);
  return type !== undefined && !PAGE_MEDIA_TYPES.includes(type);
}
