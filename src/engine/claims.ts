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
  /**
   * True when the action being judged did not send it: it was already in
   * flight when the action began, or no user input was pending at all (a page
   * load, a scroll). A poll or an error-monitoring beacon the page sends on its
   * own is refused like any other write, but no message on screen is an
   * answer to it, so a refused one is never paired with a success claim.
   */
  background?: boolean;
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
  /\b(?:error|failed|failure|could ?n[o'’]?t|unable to|went wrong|try again|retry|denied|forbidden|unauthori[sz]ed|not allowed|no permission|timed out|unavailable|problem loading)\b/i;

/**
 * A refusal explained in the app's own words: "Only an open order can be sent
 * for approval", "You can't delete an approved order", "Nothing was saved".
 * Correct behaviour after a refused request, though it uses none of the words
 * for an error and may contain one for success ("sent").
 *
 * Unlike ERROR_RE, this counts only in text the page ANNOUNCES — a live region
 * or an alert (see PageState.announced). The same phrasing is ordinary
 * help text everywhere else ("This cannot be undone", "Password must be at
 * least 8 characters", "Only admins can invite members"), and page-wide it
 * excused real lies: a refused delete reporting "Workspace deleted." went
 * unreported because the Danger zone said "This cannot be undone."
 */
const REFUSAL_RE =
  /\b(?:can(?:not|[’'`]?t| not)|must be|(?:is|are) already|only (?:an? |the )?\w+(?: \w+)? (?:can|may|be)|may only|can only(?: be)?|(?:nothing|not) (?:was|has been|have been|been) (?:saved|sent|deleted|updated|created|changed|submitted)|(?:was|were|has|have|is|are)(?: not|n[’']t)(?: been)? (?:saved|sent|deleted|updated|created|changed|submitted))\b/i;

/**
 * Words that name a refusal outright. An admission when the page ANNOUNCES them
 * or puts them up in answer to the action, as when a toast echoes the server's
 * "was refused" message. Not page-wide: "Rejected" and "Blocked" are ordinary
 * status badges and filter tabs on record pages, and counted wherever they
 * stood they would excuse every lie on such a page.
 */
const REFUSED_RE = /\b(?:refused|rejected|blocked)\b/i;

/**
 * Addresses of a page's own infrastructure writes: a token refresh, telemetry,
 * an error monitor, a heartbeat. Refusing one says nothing about whether the
 * change the user made was kept, so it is never paired with a success claim.
 */
export const INFRASTRUCTURE_WRITE_RE =
  /\/auth\/(refresh|token|session)|refresh[-_]?token|\/telemetry|\/analytics|\/heartbeat|\/sentry|\/envelope\b|client[-_]?errors?\b|\/collect\b|\/logs?\b|\/metrics\b/i;

/** When one watched request was sent, against the action being judged. All times are the engine's clock, in ms. */
export interface RequestTiming {
  /** When the request started. */
  started: number;
  /** When the current user input began, or null before the first. */
  inputSince: number | null;
  /** When the current action began. An action that is not input moves this past `inputSince`. */
  actionStartedAt: number;
  /**
   * When the input started loading a new main-frame document (its first
   * navigation request), or null when it loaded none. A client-side route
   * change sends no navigation request and leaves this null.
   */
  documentLoadSince: number | null;
  /** True for the main frame's navigation request itself: a native form post, or a link's GET. */
  isDocumentLoad: boolean;
}

/**
 * Whether a request is one the action being judged did not send (see
 * `WatchedRequest.background`).
 *
 * Once a click has started loading a new document, what follows is not the
 * click's own write. Requests the old page sends as it is left (a preference
 * save on pagehide) belong to that page, and requests the new page sends as it
 * loads (an error monitor, a visit beacon) are sent with no input on it yet.
 * Neither is answered by anything on screen, and the new page's text is all
 * new against the old page's, so paired they read every static "Completed" as
 * a false success. The click's own writes come before the navigation starts:
 * a script's save awaited before it moves the page, or the navigation itself
 * when it is a native form post.
 */
export function isBackgroundRequest(t: RequestTiming): boolean {
  if (t.inputSince === null || t.inputSince < t.actionStartedAt || t.started < t.inputSince) return true;
  if (t.isDocumentLoad) return false;
  return t.documentLoadSince !== null && t.started > t.documentLoadSince;
}

/** Whether a piece of announced text explains a refusal. */
export function isRefusalNotice(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= CLAIM_TEXT_MAX && REFUSAL_RE.test(trimmed);
}

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

/**
 * Words in an empty-state sentence that name nothing in particular: the
 * generic nouns for "the things", the verbs that follow them ("No results
 * found", "No entries recorded yet") and the adjectives in front of them ("No
 * new items", "No matching records"). Stemmed, as `stem` leaves them.
 */
const GENERIC_EMPTY_WORDS = new Set([
  "result", "item", "record", "row", "data", "entry", "match", "thing", "one",
  "yet", "found", "show", "display", "here", "recorded", "added", "created", "saved", "available", "been",
  "matching", "more", "new", "recent", "upcoming", "open", "pending", "other", "further",
  "api", "v1", "v2", "v3",
]);

/** Words that end the subject of an empty-state sentence: "No results | for your search". */
const SUBJECT_STOP_WORDS = new Set([
  "for", "your", "you", "to", "in", "on", "of", "at", "by", "with", "that", "this", "which", "from",
  "match", "matches", "yet", "found", "here", "available", "left", "anymore",
  "have", "has", "had", "been", "was", "were", "is", "are", "such",
]);

/** Crude singular form, enough to match "comments" to "/comment/" and "entries" to "/entry". */
function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("yses")) return `${w.slice(0, -4)}ysis`;
  if (w.endsWith("uses")) return w.slice(0, -2);
  if (w.endsWith("es") && /(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

/** A word or a path segment as stems, split on hyphens and underscores the same way on both sides. */
function stems(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}

/**
 * The words naming what an empty-state sentence says is missing: "comment"
 * for "No comments yet", "corrective action" for "No corrective actions
 * recorded yet", "order" for "There are no orders". Empty for sentences that
 * name nothing in particular ("No results for your search", "Nothing to show",
 * "This list is empty"). Read from where the empty-state phrase starts, so a
 * "no" earlier in the text ("No longer available. No results.") is not taken.
 */
export function emptyStateSubject(text: string): string[] {
  const at = EMPTY_RE.exec(text)?.index ?? 0;
  const m = /\bno\s+((?:[a-z][a-z-]*\s+){0,3}[a-z][a-z-]*)/i.exec(text.slice(at));
  if (!m) return [];
  const words: string[] = [];
  for (const word of m[1].split(/\s+/)) {
    if (SUBJECT_STOP_WORDS.has(word.toLowerCase())) break;
    words.push(...stems(word));
  }
  return words.filter((w) => w.length > 2 && !GENERIC_EMPTY_WORDS.has(w));
}

/** Whether a request's path names one of these subject words. */
function pathNames(req: WatchedRequest, subject: readonly string[]): boolean {
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    path = req.url;
  }
  const segments = new Set(stems(path));
  return subject.some((w) => segments.has(w));
}

/** How an empty-state sentence relates to the page's refused reads (#413). */
export type EmptyStatePairing =
  /** It names nothing in particular, or names what this refused read fetched: reported at high. */
  | { certain: true; read: WatchedRequest }
  /** It names something a read on the page loaded successfully, and no refused read: it is about that, and is not reported. */
  | { unrelated: true }
  /** It names something no read on the page names either way: reported at medium, since it may or may not be about the refused read. */
  | { certain: false; read: WatchedRequest; subject: string[] };

/**
 * Pairs one empty-state sentence with the refused reads it could be about.
 * `loaded` are the page's reads that succeeded: positive evidence that a
 * sentence naming what they fetched is a genuinely empty section rather than
 * a refusal hidden behind an empty state.
 */
export function pairEmptyState(
  text: string,
  refusedReads: readonly WatchedRequest[],
  loaded: readonly WatchedRequest[],
): EmptyStatePairing {
  const subject = emptyStateSubject(text);
  if (subject.length === 0) return { certain: true, read: refusedReads[0] };
  const named = refusedReads.find((r) => pathNames(r, subject));
  if (named) return { certain: true, read: named };
  if (loaded.some((r) => pathNames(r, subject))) return { unrelated: true };
  return { certain: false, read: refusedReads[0], subject };
}

/** The page's visible claims, plus the structural signal that a rendered list has no rows. */
export interface PageState {
  /** Short pieces of visible text, in document order. */
  texts: readonly string[];
  /**
   * The text of what the page announces: each live region (role=status or
   * alert, aria-live) and <output>, read as a whole and past the cap on texts.
   * What the page SAYS in response to an action lives here; help text — even
   * inside a dialog — does not.
   */
  announced?: readonly string[];
  /**
   * A list or table that renders its container and its header but no rows.
   * Structural, so it holds in any language and on any app that does not write
   * an empty-state sentence at all — which is most of them.
   */
  emptyLists: number;
  /** Open dialogs (native, role=dialog or alertdialog) on the page. Read with the texts so the engine needs no second call. */
  dialogs?: number;
  /** Visible fields marked aria-invalid="true": a form's client-side validation answering. */
  invalid?: number;
}

/** What counts as an open dialog: a native one or an ARIA one. */
const DIALOG_SEL = 'dialog[open], [role="dialog"], [role="alertdialog"]';

/** Page-side count of the open dialogs alone, for a caller that needs nothing else the claim scan reads. */
export const OPEN_DIALOGS_SCRIPT = `(() => {
  const visible = ${VISIBLE_SRC};
  let dialogs = 0;
  for (const d of document.querySelectorAll(${JSON.stringify(DIALOG_SEL)})) if (visible(d)) dialogs += 1;
  return dialogs;
})()`;

export interface Contradiction {
  kind: "refused_empty" | "false_success";
  detail: string;
  /** The canonical signature, for dedup across runs. */
  evidence: string;
  /**
   * High unless said otherwise. A partial false success (some of the action's
   * writes kept, some refused) is medium: the claim may be about the part that
   * was kept, but part of the user's change was still lost without a word.
   */
  severity?: "high" | "medium";
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

/** Whether an announced sentence admits the failure: an error, a refusal named outright, or one explained in the app's own words. */
function admitsInAnnouncement(text: string): boolean {
  return classify(text) === "error" || REFUSED_RE.test(text) || isRefusalNotice(text);
}

/**
 * The contradictions this action produced, if any.
 *
 * Both rules are silent whenever the page admits the failure, and both require
 * a genuinely refused request — the page half never fires alone.
 *
 * `before` is what the page said when the action began, when the action was
 * the user's (a click, a keypress, typing). A success claim already on screen
 * then is not the page's answer to this action's write: a status badge reading
 * "Published", a heading, a row from earlier. Only what the action put up can
 * contradict what the action's write met. Without it, every text counts.
 */
export function findContradictions(
  requests: readonly WatchedRequest[],
  page: PageState,
  before?: PageState | null,
  acted?: { before: ActedControl; after: ActedControl } | null,
): Contradiction[] {
  const refused = requests.filter(isRefused);
  if (refused.length === 0) return [];

  const claims = page.texts.map(classify);
  const earlier = before ? new Set([...before.texts, ...(before.announced ?? [])]) : null;
  const isNew = (text: string): boolean => earlier === null || !earlier.has(text);
  // An app that says what went wrong has behaved correctly, and nothing below
  // applies. This is checked before anything else so that a page carrying both
  // an error banner and a stale empty state is not reported.
  if (claims.includes("error")) return [];
  // An admission where the page announces its responses: an error, a refusal
  // named outright (an app echoing the server's "was refused"), or one
  // explained in the app's own words. Help text with the same wording
  // elsewhere excuses nothing.
  if ((page.announced ?? []).some(admitsInAnnouncement)) return [];
  // A refusal named outright in text the action put up, announced or not.
  if (earlier !== null && page.texts.some((t) => isNew(t) && t.length <= CLAIM_TEXT_MAX && REFUSED_RE.test(t))) return [];

  const out: Contradiction[] = [];

  const reads = refused.filter((r) => !WRITING_METHODS.has(r.method.toUpperCase()));
  if (reads.length > 0) {
    // An empty-state sentence that names what is missing is evidence about
    // requests for that thing (#413). "No comments yet" beside a refused
    // history read, with the comments read loaded fine, is a genuinely empty
    // comments section, not a refusal shown as an empty state.
    // Positive evidence only: a data read the page made that succeeded. The
    // page's own document, its images and scripts, and redirects say nothing
    // about which section of it is empty.
    const loaded = requests.filter(
      (r) => (r.resourceType === "xhr" || r.resourceType === "fetch") && r.status !== null && r.status >= 200 && r.status < 300 && !WRITING_METHODS.has(r.method.toUpperCase()),
    );
    const pairings = page.texts.filter((_, i) => claims[i] === "empty").map((t) => ({ text: t, pairing: pairEmptyState(t, reads, loaded) }));
    // A sentence naming what a refused read fetched points at that read; a generic one points at none in particular.
    const certain =
      pairings.find((p) => "certain" in p.pairing && p.pairing.certain && emptyStateSubject(p.text).length > 0) ??
      pairings.find((p) => "certain" in p.pairing && p.pairing.certain);
    const possible = pairings.find((p) => "certain" in p.pairing && !p.pairing.certain);
    const hit = certain ?? (page.emptyLists > 0 ? undefined : possible);
    if (hit || page.emptyLists > 0) {
      const read = hit && "read" in hit.pairing ? hit.pairing.read : reads[0];
      const how = hit ? "an empty state" : `an empty list (${page.emptyLists})`;
      const unsure = hit !== undefined && hit === possible;
      out.push({
        kind: "refused_empty",
        detail:
          `${say(read)} was refused, and the page shows ${how} with no error. ` +
          (unsure
            ? `The empty state ("${hit.text}") names something no request on the page was for, so it may be about another section; the user may be told there is nothing to see when nothing could be loaded.`
            : `The user is told there is nothing to see when the truth is that nothing could be loaded.`) +
          standIn(read),
        evidence: `refused-empty ${say(read)}`,
        ...(unsure ? { severity: "medium" as const } : {}),
      });
    }
  }

  // Only writes this action sent, and not the page's own infrastructure.
  const isActionWrite = (r: WatchedRequest): boolean => WRITING_METHODS.has(r.method.toUpperCase()) && !r.background && !INFRASTRUCTURE_WRITE_RE.test(r.url);
  const writes = refused.filter(isActionWrite);
  // Writes of the same action that went through. The message may be about
  // one of them, so a success claim beside them is a PARTIAL false success:
  // part of the user's change was refused and the page said nothing about
  // that part. Still reported, at medium, because silent partial loss is a
  // real defect; all refused stays high.
  const kept = requests.filter((r) => isActionWrite(r) && DATA_RESOURCES.has(r.resourceType) && !r.blockedByPolicy && r.status !== null && r.status < 400);
  const successAt = claims.findIndex((c, i) => c === "success" && isNew(page.texts[i]));
  if (writes.length > 0 && successAt >= 0) {
    const worst = writes[0];
    const message = JSON.stringify(page.texts[successAt].trim().slice(0, 80));
    if (kept.length === 0) {
      out.push({
        kind: "false_success",
        detail: `${say(worst)} was refused, and the page says ${message}. The user is told their change was kept when the server rejected it.${standIn(worst)}`,
        evidence: `false-success ${say(worst)}`,
      });
    } else {
      const total = writes.length + kept.length;
      out.push({
        kind: "false_success",
        severity: "medium",
        detail:
          `partial: ${writes.length} of ${total} writes from this action were refused (${say(worst)}), and the page says ${message} with no word about the refused part. ` +
          `The user is told their change was kept when part of it was rejected.${standIn(worst)}`,
        evidence: `false-success-partial ${say(worst)}`,
      });
    }
  }

  // No success word, but the control or a counter beside it shows the change
  // as kept: an optimistic UI telling the same falsehood without words.
  // Medium: the page never said "saved", and a reader may still notice a
  // reload putting the old value back.
  const change = acted && writes.length > 0 && kept.length === 0 && successAt < 0 ? keptChange(acted.before, acted.after) : null;
  if (change) {
    const worst = writes[0];
    out.push({
      kind: "false_success",
      severity: "medium",
      detail: `${say(worst)} was refused, and the page shows the change as kept (${change}) with no error. The user is told their change was kept when the server rejected it.${standIn(worst)}`,
      evidence: `false-success-kept ${say(worst)}`,
    });
  }

  return out;
}

/** The acted-on control as the click found it and as it left it, read by ACTED_CONTROL_SRC. */
export interface ActedControl {
  /** The control's role (its ARIA role, else "checkbox"/"radio" for a native box, else its tag). */
  role: string;
  /** Null when the control has no such state. */
  checked: boolean | null;
  pressed: boolean | null;
  selected: boolean | null;
  /**
   * Counter-shaped texts ("1/3 completed", "Step 2 of 5", "40%") near the
   * control: in the container it shares with it (a dialog, a form, a group,
   * a region), and in what the page announces.
   */
  counters: string[];
}

/** A counter: "1/3", "2 of 5", "40%". Not a date ("10/02/2026") nor a part of a longer number. */
export const COUNTER_RE = /(?<![\d/.,:])(?:\d{1,4} ?(?:\/|of) ?\d{1,4}|\d{1,3} ?%)(?![\d/.,:])/i;

/** The containers a counter must share with the control to count as its counter. */
const CONTROL_CONTAINER_SEL =
  'dialog, [role="dialog"], [role="alertdialog"], fieldset, form, [role="group"], [role="radiogroup"], [role="toolbar"], [role="region"], section, aside, [role="complementary"]';

/** Most counters read for one control. */
export const MAX_COUNTERS = 20;

/**
 * Page-side reader of an acted-on control: `(${ACTED_CONTROL_SRC})(node)`
 * returns an ActedControl, or null for no node. A label stands for the box it
 * labels. Shipped as a string for the same reason CLAIM_SCAN_SCRIPT is.
 */
export const ACTED_CONTROL_SRC = `(node) => {
  if (!node) return null;
  const visible = ${VISIBLE_SRC};
  const box = (n) => n && n.tagName === "INPUT" && (n.type === "checkbox" || n.type === "radio");
  const control = node.control || (box(node) ? node : node.querySelector && node.querySelector("input[type=checkbox], input[type=radio]")) || node;
  const flag = (v) => (v === "true" ? true : v === "false" ? false : null);
  const role = control.getAttribute("role") || (box(control) ? control.type : control.tagName.toLowerCase());
  const counter = ${COUNTER_RE};
  const counters = [];
  const add = (t) => {
    const text = (t || "").replace(/\\s+/g, " ").trim();
    if (text && text.length <= 60 && counter.test(text) && !counters.includes(text) && counters.length < ${MAX_COUNTERS}) counters.push(text);
  };
  const near = control.closest(${JSON.stringify(CONTROL_CONTAINER_SEL)}) || (control.parentElement && control.parentElement.parentElement);
  if (near) {
    const walker = document.createTreeWalker(near, NodeFilter.SHOW_ELEMENT);
    for (let el = near; el && counters.length < ${MAX_COUNTERS}; el = walker.nextNode()) {
      let own = "";
      for (const child of el.childNodes) if (child.nodeType === 3) own += child.nodeValue;
      if (own.trim() && visible(el)) add(own);
    }
  }
  for (const region of document.querySelectorAll("[role~='status'], [role~='alert'], [aria-live]:not([aria-live='off']), output")) {
    if (visible(region)) add(region.innerText);
  }
  return {
    role,
    checked: box(control) ? control.checked : flag(control.getAttribute("aria-checked")),
    pressed: flag(control.getAttribute("aria-pressed")),
    selected: flag(control.getAttribute("aria-selected")),
    counters,
  };
}`;

/**
 * How the acted-on control shows its change as kept, or null when it does not.
 *
 * A checked, pressed or selected state that moved is the change itself (a
 * tab's selection is not: choosing a tab is moving around, not a change the
 * user asked to keep). A counter beside it that moved ("0/3" to "1/3
 * completed") counts it as done. A counter that merely appeared does not: a
 * step that opens with "Step 1 of 3" counts nothing yet.
 */
export function keptChange(before: ActedControl, after: ActedControl): string | null {
  for (const state of ["checked", "pressed", "selected"] as const) {
    if (state === "selected" && after.role === "tab") continue;
    const was = before[state];
    const now = after[state];
    if (was !== null && now !== null && was !== now) return `the control is now ${now ? state : `not ${state}`}`;
  }
  const gone = before.counters.filter((c) => !after.counters.includes(c));
  const fresh = after.counters.filter((c) => !before.counters.includes(c));
  if (gone.length > 0 && fresh.length > 0) return `${JSON.stringify(gone[0])} became ${JSON.stringify(fresh[0])}`;
  return null;
}

/** How a click that sent nothing was answered on the page, when it was. */
export type QuietAnswer = "dialog" | "validation";

/**
 * Whether a submit-shaped click that sent no request was answered on the page
 * anyway, judged from the page as the click began and as it settled.
 *
 * - A dialog opened: a step (a confirmation), not a submit.
 * - A field became invalid, or the page announced something new that is not
 *   a success claim: client-side validation said what was wrong, and no
 *   request was expected. A new "Saved!" is the opposite, the very case the
 *   silent-submit note is for, so it never counts.
 *
 * Null when either reading is missing or nothing visible answered.
 */
export function quietAnswer(before: PageState | null, after: PageState | null): QuietAnswer | null {
  if (!before || !after) return null;
  if ((after.dialogs ?? 0) > (before.dialogs ?? 0)) return "dialog";
  if ((after.invalid ?? 0) > (before.invalid ?? 0)) return "validation";
  const said = new Set(before.announced ?? []);
  if ((after.announced ?? []).some((text) => !said.has(text) && classify(text) !== "success")) return "validation";
  return null;
}

/**
 * Whether a piece of announced text (an alert's or a live region's name, as
 * the snapshot lists it) was not on the page at `baseline`. The name may be a
 * region's sentences run together and cut short, so it is matched by prefix
 * either way against the baseline's texts and announced sentences. False
 * when there is no baseline: nothing says when the text arrived.
 */
export function saidSince(text: string, baseline: PageState | null): boolean {
  if (!baseline) return false;
  const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
  const said = norm(text);
  if (!said) return false;
  for (const earlier of [...baseline.texts, ...(baseline.announced ?? [])]) {
    const e = norm(earlier);
    if (!e) continue;
    if (e === said) return false;
    const shorter = Math.min(e.length, said.length);
    if (shorter >= 20 && (e.startsWith(said) || said.startsWith(e))) return false;
  }
  return true;
}

/** Most announced regions read from one page. */
export const MAX_ANNOUNCED = 40;

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
  const announced = [];
  // Where a page SAYS something in response to an action. Not dialogs: a modal
  // is a container of static text (its form's help, its warning), and counting
  // it brought back the help text this set exists to exclude.
  const ANNOUNCES = "[role~='status'], [role~='alert'], [aria-live]:not([aria-live='off']), output";
  const COLUMN_HEADER = "th, [role~='columnheader'], [aria-sort]";
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el = document.body;
  while (el && texts.length < ${MAX_CLAIM_TEXTS}) {
    let own = "";
    for (const node of el.childNodes) if (node.nodeType === 3) own += node.nodeValue;
    own = own.replace(/\\s+/g, " ").trim();
    // A column header names what a column holds ("Updated on", "Completed"); it claims nothing.
    if (own && own.length <= ${CLAIM_TEXT_MAX} && !seen.has(own) && !el.closest(COLUMN_HEADER) && visible(el)) {
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
  // Read on its own, past the cap on page texts: a toast rendered at the end of
  // a long page is exactly the text that must not be missed.
  for (const region of document.querySelectorAll(ANNOUNCES)) {
    if (!visible(region)) continue;
    // innerText, not textContent: hidden parts of a region are not said. Split
    // into sentences so a long region is read rather than dropped whole.
    const said = (region.innerText || "").replace(/\\s+/g, " ").trim();
    for (const sentence of said.split(/(?<=[.!?])\\s+/)) {
      if (announced.length >= ${MAX_ANNOUNCED}) break;
      const s = sentence.trim();
      if (s && s.length <= ${CLAIM_TEXT_MAX} && !announced.includes(s)) announced.push(s);
    }
  }
  // Open dialogs, so a page error raised as one opens can be read as the
  // confirmation a router cancelled a route change for (oracles.ts).
  let dialogs = 0;
  for (const d of document.querySelectorAll(${JSON.stringify(DIALOG_SEL)})) if (visible(d)) dialogs += 1;
  // Fields the page marked invalid, so a submit answered by validation is not called silent.
  let invalid = 0;
  for (const f of document.querySelectorAll('[aria-invalid="true"]')) if (visible(f)) invalid += 1;

  return { texts, announced, emptyLists, dialogs, invalid };
})()`;
