/**
 * What the page says about itself, checked against what actually happened.
 *
 * Two of the most expensive bugs a web app ships are invisible to every oracle
 * that watches only one side of the wire:
 *
 *   - A list request is refused (401, 403, 500) and the page renders its empty
 *     state. The user is told they have nothing, when the truth is that nothing
 *     could be loaded. Nobody files a bug, because the screen looks fine — it
 *     is the single most common way a permission regression reaches production
 *     without anyone noticing.
 *   - A save is refused and the page says "Saved". The user walks away
 *     believing their work is stored.
 *
 * Neither is a crash, so `console_error` and `http_error` miss the harm: the
 * HTTP oracle sees the 403 and reports it as a medium, indistinguishable from
 * the dozens of expected 401s an auth probe produces. The defect is not the
 * refusal. It is the page CONTRADICTING the refusal.
 *
 * The rules pair a precise half with a fuzzy one. The request half is exact —
 * a status code either is an error or is not. The page half only has to be
 * roughly right, because it is never enough on its own: no contradiction is
 * reported unless a request was genuinely refused during the same action. That
 * asymmetry is what keeps the false-positive rate low enough to be worth
 * reporting at high severity.
 *
 * Everything here is pure so it can be table-tested; the DOM read lives in
 * browser.ts.
 */
import { VISIBLE_SRC } from "./collector.js";

/** What a piece of page text asserts about the state it describes. */
export type Claim = "empty" | "success" | "error";

/**
 * Methods whose refusal a success message would be lying about. A refused GET
 * is the empty-state rule's business; a refused POST is this one's.
 */
const WRITING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resource types worth correlating. A failed image, font or analytics beacon
 * says nothing about whether the list on screen is real, and correlating them
 * would fire on every page with a broken logo.
 */
const DATA_RESOURCES = new Set(["xhr", "fetch", "document"]);

/** A request the engine watched during one action, reduced to what these rules need. */
export interface WatchedRequest {
  method: string;
  url: string;
  /** The status, or null when the request failed outright (no response). */
  status: number | null;
  resourceType: string;
  /**
   * True when the engine's own write policy stopped it. With no status it was
   * dropped, and the page never met a refusal it could have handled. With one,
   * the policy answered in the server's place, and the page's handling of that
   * refusal is exactly what these rules judge.
   */
  blockedByPolicy?: boolean;
}

/** Whether this request is one whose refusal the page should be admitting to. */
export function isRefused(req: WatchedRequest): boolean {
  if (req.blockedByPolicy && req.status === null) return false;
  if (!DATA_RESOURCES.has(req.resourceType)) return false;
  if (req.status === null) return true;
  return req.status >= 400;
}

/**
 * Phrases that assert there is nothing to show.
 *
 * Deliberately narrow: these are the stock empty-state sentences, not any
 * sentence containing "no". "No results", "Nothing to show", "You have no
 * orders" match; "No changes were saved since yesterday" does not, because the
 * assertion has to be about the absence of the things themselves.
 */
const EMPTY_RE =
  /\b(?:no (?:results?|items?|records?|rows?|data|entries|matches)\b|nothing (?:to (?:show|display)|here|found)\b|(?:there are|you have|we found) no\b|(?:0|zero) (?:results?|items?|records?|rows?|matches)\b|no [a-z]{3,20}s (?:found|yet|to show)\b|empty\b)/i;

/**
 * Phrases that assert something worked. A page that says one of these while
 * the write that produced it was refused is telling the user a falsehood.
 */
const SUCCESS_RE = /\b(?:success(?:fully)?|saved|created|updated|deleted|removed|submitted|sent|published|approved|completed|added|changes? saved|done)\b/i;

/**
 * Phrases that admit something went wrong — including a refusal explained in
 * the app's own words ("Only an open order can be sent for approval", "You
 * can't delete an approved order"), which is correct behaviour even though it
 * uses none of the words for an error and may contain one for success. Their presence is what makes a page
 * INNOCENT: an app that refuses a request and says so has behaved correctly,
 * whatever else is on the screen, and must not be reported.
 */
const ERROR_RE =
  /\b(?:error|failed|failure|could ?n[o']?t|unable to|went wrong|try again|retry|denied|forbidden|unauthori[sz]ed|not allowed|no permission|timed out|unavailable|problem loading)\b|\b(?:can(?:not|[’']t)|must be|is already|are already|only (?:an? |the )?\w+(?: \w+)? (?:can|may))\b|\b(?:nothing|not) (?:was |been |be )?(?:saved|sent|deleted|updated|created|changed|submitted)\b/i;

/** Longest piece of text judged. An empty state is a sentence; a paragraph that happens to contain one of these words is not a claim. */
export const CLAIM_TEXT_MAX = 120;

/**
 * What one piece of visible page text asserts, or nothing when it asserts none
 * of these. An admission of error outranks the others: a banner reading
 * "Couldn't load orders — no results to show" is the app being honest.
 */
export function classify(text: string): Claim | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > CLAIM_TEXT_MAX) return null;
  if (ERROR_RE.test(trimmed)) return "error";
  if (SUCCESS_RE.test(trimmed)) return "success";
  if (EMPTY_RE.test(trimmed)) return "empty";
  return null;
}

/** The page's visible claims, plus the structural signal that a rendered list has no rows. */
export interface PageState {
  /** Short pieces of visible text, in document order. */
  texts: readonly string[];
  /**
   * A list or table that renders its container and its header but no rows.
   * Structural, so it holds in any language and on any app that does not write
   * an empty-state sentence at all — which is most of them.
   */
  emptyLists: number;
}

export interface Contradiction {
  kind: "refused_empty" | "false_success";
  detail: string;
  /** The canonical signature, for dedup across runs. */
  evidence: string;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.slice(0, 120);
  }
}

function say(req: WatchedRequest): string {
  return `${req.method} ${shortUrl(req.url)} ${req.status === null ? "failed" : req.status}`;
}

/** Said after a contradiction whose refusal the write policy wrote, so nobody goes looking for it in the server's logs. */
function standIn(req: WatchedRequest): string {
  return req.blockedByPolicy
    ? ` The refusal was the write policy's stand-in (the server never received the request); what failed is the page's handling of a refusal, which a real one would meet the same way.`
    : "";
}

/**
 * The contradictions this action produced, if any.
 *
 * Both rules are silent whenever the page admits the failure, and both require
 * a genuinely refused request — the page half never fires alone.
 */
export function findContradictions(requests: readonly WatchedRequest[], page: PageState): Contradiction[] {
  const refused = requests.filter(isRefused);
  if (refused.length === 0) return [];

  const claims = page.texts.map(classify);
  // An app that says what went wrong has behaved correctly, and nothing below
  // applies. This is checked before anything else so that a page carrying both
  // an error banner and a stale empty state is not reported.
  if (claims.includes("error")) return [];

  const out: Contradiction[] = [];

  const reads = refused.filter((r) => !WRITING_METHODS.has(r.method.toUpperCase()));
  const saysEmpty = claims.includes("empty") || page.emptyLists > 0;
  if (reads.length > 0 && saysEmpty) {
    const worst = reads[0];
    const how = claims.includes("empty") ? "an empty state" : `an empty list (${page.emptyLists})`;
    out.push({
      kind: "refused_empty",
      detail:
        `${say(worst)} was refused, and the page shows ${how} with no error. ` +
        `The user is told there is nothing to see when the truth is that nothing could be loaded.` +
        standIn(worst),
      evidence: `refused-empty ${say(worst)}`,
    });
  }

  const writes = refused.filter((r) => WRITING_METHODS.has(r.method.toUpperCase()));
  if (writes.length > 0 && claims.includes("success")) {
    const worst = writes[0];
    const message = page.texts[claims.indexOf("success")];
    out.push({
      kind: "false_success",
      detail: `${say(worst)} was refused, and the page says ${JSON.stringify(message.trim().slice(0, 80))}. The user is told their change was kept when the server rejected it.${standIn(worst)}`,
      evidence: `false-success ${say(worst)}`,
    });
  }

  return out;
}

/** Most pieces of text read from one page. A page with more than this has nothing useful to say in the extra ones. */
export const MAX_CLAIM_TEXTS = 120;

/**
 * Page-side reader for the two signals `findContradictions` needs. Shipped as
 * a STRING expression for the same reason the collector is: loader transforms
 * inject a `__name` helper that does not exist in the browser, and a
 * serialized function carrying a call to it fails there.
 *
 * Text is taken as each element's OWN text nodes, not its subtree, so a
 * sentence is read once rather than again for every ancestor that contains it.
 *
 * The empty-list count is structural on purpose: most apps write no
 * empty-state sentence at all, and the ones that do write it in the user's
 * language. A container that renders its header and no rows says the same
 * thing in every language and in every design system.
 */
export const CLAIM_SCAN_SCRIPT = `(() => {
  const visible = ${VISIBLE_SRC};
  const texts = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el = document.body;
  while (el && texts.length < ${MAX_CLAIM_TEXTS}) {
    let own = "";
    for (const node of el.childNodes) if (node.nodeType === 3) own += node.nodeValue;
    own = own.replace(/\\s+/g, " ").trim();
    if (own && own.length <= ${CLAIM_TEXT_MAX} && !seen.has(own) && visible(el)) {
      seen.add(own);
      texts.push(own);
    }
    el = walker.nextNode();
  }

  // A list or table that renders its container but no rows. Hidden ones are
  // templates and dropdown shells, not empty states.
  let emptyLists = 0;
  for (const list of document.querySelectorAll("table, ul, ol, [role='table'], [role='grid'], [role='list']")) {
    if (!visible(list)) continue;
    const tag = list.tagName.toLowerCase();
    if (tag === "table") {
      const body = list.tBodies[0];
      // No header means it is a layout table, not a record list.
      if (!list.querySelector("th, thead")) continue;
      if (body && body.rows.length === 0) emptyLists += 1;
      continue;
    }
    const rows = list.querySelectorAll(":scope > li, :scope > [role='row'], :scope > [role='listitem']");
    if (rows.length === 0) emptyLists += 1;
  }
  return { texts, emptyLists };
})()`;
