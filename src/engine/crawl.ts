/**
 * What a crawl makes of one route it loaded: whether an explicitly requested
 * path joins the route contract, and the summary line it prints. Kept out of
 * browser.ts so both rules can be table-tested without a browser.
 */
import { isNonPageRoute } from "./fingerprint.js";
import { isTimeoutMessage } from "./limits.js";

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
const PAGE_MEDIA_TYPES: readonly string[] = ["text/html", "application/xhtml+xml"];

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

/** The main document's response to a navigation, as the browser received it. */
export interface MainDocumentAnswer {
  /** Where it answered from, after any redirects. */
  url: string;
  status: number;
  /** The media type (mediaTypeOf), undefined when the response named none. */
  contentType: string | undefined;
}

/** How a browser fails page.goto for a response it takes as a download. */
const DOWNLOAD_STARTED = /\bDownload is starting\b/;

/**
 * Whether a navigation that failed may leave the browser about to show an
 * error page for it, so the next navigation must wait for that page first.
 * `status` is the main document's response status, or null when none came;
 * `downloaded` says the browser started a download for it.
 *
 * The page can commit for the failed URL a few milliseconds after goto threw,
 * and a navigation started before that commit is interrupted by it, charging
 * the failure to the next page. Measured on all three browsers:
 * - a file answered 4xx or 5xx: Firefox throws NS_ERROR_NET_ERROR_RESPONSE,
 *   Chromium "Download is starting", and both then commit an error page;
 *   WebKit downloads it instead and shows none;
 * - a file answered 2xx or 3xx that became a download: the page stays where it
 *   was on every browser, so nothing follows and nothing is waited for;
 * - a download that started, whatever its status: the page stays where it was;
 * - no response at all (refused, aborted, timed out): the browser may show its
 *   own error page, so it is waited for.
 * The wait ends at the commit, at a download or at its limit, so a wrong yes
 * costs the limit once and a wrong no lets the next page's load fail.
 */
export function failedNavigationLeavesErrorPage(message: string, status: number | null, downloaded = false): boolean {
  if (downloaded) return false;
  return !(status !== null && status < 400 && DOWNLOAD_STARTED.test(message));
}

/**
 * Whether a navigation that threw should wait for its main document's
 * response before it is judged. WebKit fails goto for a download before it
 * reports the response, which follows a few milliseconds later; without it a
 * PDF that answered 200 reads as a route that did not load. Chromium and
 * Firefox report the response first, so they never wait.
 */
export function awaitsLateAnswer(message: string, answered: boolean): boolean {
  return !answered && DOWNLOAD_STARTED.test(message);
}

/**
 * What a navigation that threw is reported as when its main document did
 * answer: the HTTP status, rather than the browser's own words for refusing
 * the response ("Download is starting", NS_ERROR_NET_ERROR_RESPONSE). Null
 * when the browser's message is the better account: nothing answered, the
 * load timed out (limits.ts explains a timeout) or another navigation
 * interrupted it, or a page answered without error and failed for another
 * reason.
 */
export function answeredNavigationFailure(message: string, answer: Pick<MainDocumentAnswer, "status" | "contentType"> | null): string | null {
  if (!answer || isTimeoutMessage(message) || /\bis interrupted by another navigation\b/.test(message)) return null;
  const said = answeredStatus(answer);
  if (answer.status >= 400) return said;
  if (DOWNLOAD_STARTED.test(message)) return `${said}, which the browser downloaded instead of opening a page`;
  return null;
}

/**
 * How a navigation's answer is named in a failure: "the file answered HTTP 404 (application/pdf)" for a feed or a
 * file, "the page answered HTTP 404" for a page, whether the browser showed it or refused it.
 */
export function answeredStatus(answer: Pick<MainDocumentAnswer, "status" | "contentType">): string {
  return isFileMediaType(answer.contentType) ? `the file answered HTTP ${answer.status} (${answer.contentType})` : `the page answered HTTP ${answer.status}`;
}

/** A navigation that threw although its main document answered: the message names the answer (answeredNavigationFailure). */
export class AnsweredNavigationError extends Error {
  constructor(
    message: string,
    readonly answer: MainDocumentAnswer,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnsweredNavigationError";
  }
}
