/**
 * Destructive-action policy. In read-only mode the engine refuses to interact
 * with elements whose accessible name / testid / id matches these patterns —
 * enforcement lives here, at the tool layer, never in the model's prompt.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\brevoke\b/i,
  /\bdestroy\b/i,
  /\bpurge\b/i,
  /\bterminate\b/i,
  /\bdeactivate\b/i,
  /\barchive\b/i,
  /\bwipe\b/i,
  // "Reset" is destructive only in some of its senses. Matching it bare refused
  // "Reset filters", "Reset zoom", "Reset search" and "Reset password" — none
  // of which destroy anything — so read-only runs skipped ordinary controls and
  // lost coverage on the very pages they were sent to explore. Exempt the
  // view/form senses; everything else ("Reset workspace", "Factory reset",
  // "Reset all data") still counts.
  /\breset\b(?!\s+(filters?|zoom|search|view|sort|order|form|password|layout|columns?|selection|preferences?|defaults?))/i,
  /\bdiscard\b/i,
  /\bcancel subscription\b/i,
  // The verb: a control that signs the user off, alone or after another verb
  // ("Save and sign off"). The noun is how approval apps label things, and it
  // is told by the word before it ("Needs sign-off", "Awaiting sign-off",
  // "Send for sign-off"); those destroy nothing. Same shape as the reset rule.
  /(?<!\b(?:needs?|awaiting|awaits|pending|requires?|required|for|before|after|without|of|the|a|an|its|their|your|my)\s)\bsign(?: |-)?off\b/i,
  // The tool is generic — destructive labels come in many languages.
  /\b(eliminar|borrar|suprimir)\b/i, // es
  /\b(excluir|apagar|remover)\b/i, // pt
  /\bsupprimer\b/i, // fr
  /\b(löschen|loeschen|entfernen)\b/i, // de
  /\belimina(?:re)?\b/i, // it
  /\bverwijder(?:en)?\b/i, // nl
  // \b is ASCII-only in JS regexes — non-Latin scripts match as substrings.
  /(удалить|удаление)/i, // ru
  /(削除|删除|삭제)/, // ja/zh/ko
];

/**
 * Network-layer destructive signals that delete/disable data regardless of
 * what the button was labeled. Used by the write-policy interceptor.
 *
 * URL and BODY are judged by DIFFERENT rules, on purpose. A URL path is
 * STRUCTURE — a bare destructive verb as a path segment (`/users/3/delete`,
 * `/widgets/bulk-delete`) is a strong, unambiguous signal. A request BODY is
 * often user CONTENT — a document being analysed, a record description, a document
 * uploaded for review — so a bare keyword in it is usually prose, not intent.
 * Scanning the body for bare `delete`/`remove` blocked ordinary create/submit
 * POSTs whose payload merely MENTIONED a destructive word: seen live, an document
 * text containing "Remove jewellery" and a description saying "Safe to delete"
 * each got their `POST /api/ai/analyze` (and a plain create) refused. That is
 * pure lost coverage with no safety gain — the analyse/create was never
 * destructive. So the body is matched only for STRUCTURED destructive intent.
 */

/** A destructive verb occupying a URL PATH segment. Bare keywords are meaningful here — a path is not prose. */
const DESTRUCTIVE_URL_RE = /(\/|\b|_)(delete|remove|purge|destroy|archive|revoke|deactivate|wipe|bulk[-_]?delete|force[-_]?delete)(\/|\b|_)/i;

/**
 * Structured destructive intent inside a body — never a bare keyword.
 * Two shapes: (a) a GraphQL destructive mutation (the 200-char window after
 * `mutation` catches the anonymous `mutation { deleteUser(id: 7) }`, not just
 * the named `mutation DeleteUser {`); (b) a destructive verb as the VALUE of a
 * command-like key (`"action":"delete"`, `operation=archive`, `"_method":"DELETE"`).
 * A destructive word sitting in any OTHER field value (a title, a description,
 * document text) is content, not a command, and is deliberately not matched.
 *
 * The key must be preceded by a STRUCTURAL character (quote, brace, bracket,
 * comma, or the start of the body / a query string) so the same sentence-shaped
 * prose this fix exists to allow cannot sneak back in through the command
 * branch: "Our intent: delete duplicate accounts" is still content. `intent`
 * and `verb` are not in the key list at all — they read as prose far more often
 * than as command fields.
 */
const DESTRUCTIVE_BODY_RE =
  /\bmutation\b[\s\S]{0,200}?\b(?:delete|remove|archive|destroy|purge|revoke)[A-Za-z_]|(?:^|[{,[\s]*["']|[?&])\s*(?:action|operation|op|method|_method|command|cmd)["']?\s*[:=]\s*["']?(?:delete|remove|purge|destroy|archive|revoke|deactivate|wipe)\b/i;

export function isDestructiveWire(url: string, body?: string | null): boolean {
  return DESTRUCTIVE_URL_RE.test(url) || (!!body && DESTRUCTIVE_BODY_RE.test(body.slice(0, 2000)));
}

/** Auth/session flows must work even under strict write policies (login, token refresh, logout). */
export const AUTH_FLOW_RE = /\/(auth|login|logout|signin|sign-in|signup|sign-up|session|token|verify|oauth|sso|password)\b/i;

/**
 * A control's label is a verb phrase: "Delete", "Remove user", "Archive the
 * project". A card or tile that is a button carries prose in its accessible
 * name, the title then a sentence about it ("Manager Approves or rejects
 * orders that need sign-off."), and a destructive word in that sentence
 * describes what the thing is for; it is not the command the click sends, the
 * same distinction the wire policy draws for words inside a POST body.
 *
 * So a label that is prose, longer than this many words AND containing a
 * sentence, is judged by its head, the first few words, where the imperative
 * lives: a match counts only when it STARTS there. The pattern still sees the
 * whole label, so "reset filters" straddling the boundary keeps the context
 * its exemption looks ahead at. Everything else is judged whole: a short
 * label, a long one with no sentence in it ("Yes, I am sure I want to delete
 * this"), a script written without spaces.
 *
 * A confirm button whose long label ends in a full stop and puts the verb
 * late is the residue this lets through. The wire policy below still blocks
 * the DELETE, PUT, PATCH or verb-path POST it would send; a plain POST to a
 * neutral path passes in read-only, as it does for any control this list does
 * not name.
 */
export const LABEL_HEAD_WORDS = 6;

/** The head: up to LABEL_HEAD_WORDS whitespace-separated words from the start. */
const HEAD_RE = new RegExp(`^\\s*(?:\\S+\\s+){0,${LABEL_HEAD_WORDS - 1}}\\S+`);
/** A sentence ends in the label: a full stop, question or exclamation mark followed by space or the end. */
const SENTENCE_RE = /[.!?](?:\s|$)/;

/**
 * Where a match must start to count: the end of the head for prose, the end
 * of the label for everything else.
 */
function matchLimit(label: string): number {
  if (!SENTENCE_RE.test(label)) return label.length;
  const head = HEAD_RE.exec(label);
  if (!head || head[0].length === label.trimEnd().length) return label.length;
  return head[0].length;
}

export function isDestructive(...labels: Array<string | null | undefined>): boolean {
  return labels.some((label) => {
    if (typeof label !== "string" || label.length === 0) return false;
    const limit = matchLimit(label);
    return DESTRUCTIVE_PATTERNS.some((re) => {
      const m = re.exec(label);
      return m !== null && m.index < limit;
    });
  });
}

export function destructiveRefusal(label: string, mode: string = "read-only"): string {
  return (
    `REFUSED by ${mode} policy: "${label}" matches a destructive-action pattern. ` +
    `This run is ${mode}; do not attempt this element again. If destructive flows must be tested, ` +
    `the user has to re-attach with mode="destructive" against a disposable/seeded environment.`
  );
}

/**
 * Write-policy tiers. The database behind the app may be live, so the
 * guarantee lives at the network layer (HTTP verbs), not in button labels.
 *
 * - "observe":     nothing but GET, HEAD and OPTIONS leaves the page (login and
 *                  token refresh excepted). For a target holding real data,
 *                  where even an ordinary form submission creates a record
 *                  somebody has to clean up.
 * - "read-only":   destructive-labelled controls are refused, and
 *                  PUT/PATCH/DELETE plus destructive-looking POSTs are blocked.
 *                  Plain POSTs pass, because submitting forms is how
 *                  validation bugs are found, and are reported.
 * - "safe-write":  create freely; the engine tracks what THIS RUN creates and
 *                  allows PUT/PATCH/DELETE only on those records.
 * - "destructive": everything allowed. Explicit opt-in, disposable data only.
 */
export type WriteMode = "observe" | "read-only" | "safe-write" | "destructive";
export const WRITE_MODES = ["observe", "read-only", "safe-write", "destructive"] as const;

/**
 * May this non-GET request leave the page? Auth-flow requests are let through
 * before this is asked. `owned` means the request addresses a record this run
 * created (always false outside safe-write, where nothing is tracked).
 */
/**
 * In observe mode, the only auth requests let through are the ones a session
 * needs in order to exist: logging in, logging out, refreshing a token. Whole
 * path SEGMENTS, never substrings — `/users/login-history/clear` and
 * `/api/tokens` (mint an API token) are not logins — and `session(s)` only as
 * the last segment, where a POST means "log in", not "act on session 123".
 */
const OBSERVE_AUTH_SEGMENT_RE =
  /^(login|log-in|signin|sign-in|logout|log-out|signout|sign-out|refresh|token|oauth|oauth2|sso|callback|authorize|authenticate)$/i;

/**
 * Is this request an auth flow that must work even though the mode would
 * otherwise block it?
 *
 * Never for a destructive-looking request, in any mode: the exemption used to
 * be tested first, so `POST /api/session/123/delete` went through in read-only
 * because its path contains "session".
 *
 * In observe mode the exemption is much narrower than elsewhere. Signing up,
 * changing or resetting a password, verifying an email and creating a user all
 * change data on the target, and observe promises that nothing is created.
 */
export function isAuthExempt(mode: WriteMode, method: string, pathname: string, destructiveWire: boolean): boolean {
  if (method !== "POST" || destructiveWire) return false;
  if (mode !== "observe") return AUTH_FLOW_RE.test(pathname);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1];
  if (/^sessions?$/i.test(last)) return true;
  // The matching segment must be at, or next to, the end: /auth/token/refresh, /oauth/token, /login.
  return (
    segments.slice(-2).some((seg) => OBSERVE_AUTH_SEGMENT_RE.test(seg)) &&
    !/^(users?|accounts?|members?|password|signup|sign-up|register|verify|invite|invitations?)$/i.test(last)
  );
}

/**
 * The origin of a request's frame when that frame belongs to another site than
 * the app: an embedded widget, such as a form, chat or payment box served by a
 * third party. A write from one reaches that third party, not the app under
 * test, so no mode short of destructive lets it out.
 *
 * `frameChain` lists the URLs of the frame that issued the request and each of
 * its parents, stopping before the top document. A frame with no address of
 * its own (about:blank, srcdoc) belongs to whoever created it, so it is skipped
 * and its parent decides. Any foreign frame in the chain makes the request
 * foreign: an app page nested inside a widget is still being driven by it.
 * Null for the top document, same-origin frames, and requests with no frame.
 */
export function foreignFrameOrigin(appUrl: string, frameChain: readonly string[]): string | null {
  let app: string;
  try {
    app = new URL(appUrl).origin;
  } catch {
    return null;
  }
  for (const url of frameChain) {
    let frame: URL;
    try {
      frame = new URL(url);
    } catch {
      continue;
    }
    if (frame.protocol !== "http:" && frame.protocol !== "https:") continue;
    if (frame.origin !== app) return frame.origin;
  }
  return null;
}

/**
 * The origin to name when a write started by another site is headed outside
 * the app, or null when the write is the app's own or lands in the app.
 *
 * The source is foreign when the frame that sent it (or a parent) is of
 * another origin, or when the request's Origin header names another origin
 * than both the app and the frame it is attributed to. The second catches a
 * foreign frame's form aimed at `_top` or `_blank`, and a popup it opens: the
 * browser reports those against the top page or no frame at all, but the
 * Origin header still names the frame's site. A sign-in page loaded as the
 * whole page is not caught by it, since there the header and the page agree.
 *
 * A foreign write whose destination is the app itself — a sign-in provider's
 * frame posting its reply back to the app's callback — is the app's business
 * and is left to the ordinary rules.
 */
export function foreignWrite(
  appUrl: string,
  req: {
    url: string;
    frameChain: readonly string[];
    frameUrl: string | null;
    originHeader?: string;
    /** The URL of the page that sent it, when that is not the page the session drives (a popup nobody adopted). */
    unadoptedPageUrl?: string | null;
    /** Whether the session's page has a frame of another origin right now. */
    pageHasForeignFrame?: boolean;
  },
): string | null {
  let app: string;
  try {
    app = new URL(appUrl).origin;
  } catch {
    return null;
  }
  const originOf = (url: string | null | undefined): string | null => {
    if (!url) return null;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  if (originOf(req.url) === app) return null;
  const fromFrame = foreignFrameOrigin(appUrl, req.frameChain);
  if (fromFrame) return fromFrame;
  const header = originOf(req.originHeader);
  if (header && header !== app && header !== originOf(req.frameUrl)) return header;
  // A popup a foreign frame opened on its own site posts from its own script
  // before it can be closed, and there the header and the page agree. The
  // session never drives a page it did not adopt, so its writes out are not
  // the app's.
  if (req.unadoptedPageUrl !== undefined && req.unadoptedPageUrl !== null) return originOf(req.unadoptedPageUrl) ?? "a page the session did not open";
  // A frame with a no-referrer policy sends "Origin: null". Out of the app,
  // on a page that embeds another site, that is taken to be the embed.
  if (req.originHeader === "null" && req.pageHasForeignFrame) return "an embedded frame (Origin: null)";
  return null;
}

/**
 * Whether the session's page was moved off the app by one of its embeds. The
 * sandbox forbids a frame to move the page, but WebKit drops it for a frame
 * that loads a `data:` URL in its own place, and a Chromium service worker can
 * serve a frame's document unseen.
 *
 * Decided on the navigation's first request, given the other sites the page
 * embeds at that moment (the engine asks the frames still attached, so a route
 * change, a 204 or a download changes nothing). A move from a page with no
 * embeds, or one carrying the app as its Referer — a click on the app's page —
 * is the tester's: a hosted sign-in page, even one the app also embeds for
 * silent sign-in, keeps the ordinary rules. With another site's Referer, it is
 * an embed's. With no Referer at all (an app that sends none, or a frame that
 * hides its origin) it is an embed's only when it goes to one of the embedded
 * sites.
 */
export class EmbedMoveTracker {
  private pending: string | null = null;
  /** The origin the page was moved to by an embed, while it stays there. */
  movedTo: string | null = null;
  constructor(private readonly appUrl: string) {}

  /** The top window's navigation to `url` sent its first request, with this Referer, from a page embedding these other sites. */
  navigationStarted(url: string, referer: string | undefined, embedded: ReadonlySet<string>): void {
    const target = foreignFrameOrigin(this.appUrl, [url]);
    if (!target || embedded.size === 0) {
      this.pending = null;
      return;
    }
    const refererIsHttp = !!referer && /^https?:/i.test(referer);
    if (refererIsHttp && foreignFrameOrigin(this.appUrl, [referer!]) === null) this.pending = null;
    else if (refererIsHttp) this.pending = target;
    else this.pending = embedded.has(target) ? target : null;
  }

  /** The top window now shows `url`: a new document, or a same-document route change. */
  pageLoaded(url: string): void {
    let origin: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      origin = u.origin;
    } catch {
      return;
    }
    if (foreignFrameOrigin(this.appUrl, [url]) === null) {
      this.movedTo = null;
      this.pending = null;
      return;
    }
    if (this.pending === origin) this.movedTo = origin;
    else if (this.movedTo !== origin) this.movedTo = null;
    this.pending = null;
  }
}

/**
 * The origin to name when the session's page was moved off the app by one of
 * its embeds (EmbedMoveTracker) and writes to another site from there, or
 * null. Refused unless it is a sign-in request.
 */
export function offAppPageWrite(appUrl: string, pageUrl: string | undefined, destinationUrl: string, movedByEmbed: string | null): string | null {
  if (!movedByEmbed) return null;
  const originOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const app = originOf(appUrl);
  const page = originOf(pageUrl);
  if (!app || !page || page === app || page !== movedByEmbed) return null;
  if (originOf(destinationUrl) === app) return null;
  return page;
}

/**
 * The page a sandboxed frame is given in place of a redirect: it navigates to
 * the redirect's target itself, so the next hop is a navigation the policy
 * routes and sandboxes again. A redirect answered as a redirect is followed by
 * the browser without asking, and the page it lands on was not sandboxed.
 */
export function sandboxedRedirectPage(target: string): string {
  const json = JSON.stringify(target).replace(/</g, "\\u003c");
  // No referrer: the next hop would otherwise name this stand-in page, where a real redirect names the app.
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>location.replace(${json});</script>`;
}

/** The last path segment of a page that is a sign-in page, and nothing else: not a verification step, where a payment provider's frame sits. */
const SIGN_IN_SEGMENT_RE = /^(login|log-in|signin|sign-in|signup|sign-up|sso|oauth)$/i;

/**
 * Whether a foreign frame's writes out may go on this page after all: a
 * captcha on the app's own sign-in page is a cross-origin frame that posts to
 * its own site, and refusing it would make every login fail. Only on the app's
 * own origin, only when the page's last path segment is a sign-in word (a
 * trailing file extension ignored, `_` read as `-`) — not "auth", which is
 * also the last step of a card payment's verification — and not in observe, where only the login
 * request itself goes out.
 */
export function allowsForeignWriteOnSignIn(mode: WriteMode, topPageUrl: string, appUrl: string): boolean {
  if (mode === "observe" || mode === "destructive") return false;
  let page: URL;
  try {
    page = new URL(topPageUrl);
    if (page.origin !== new URL(appUrl).origin) return false;
  } catch {
    return false;
  }
  const segments = page.pathname.split("/").filter(Boolean);
  // "sign_in" is "sign-in": underscores are how some frameworks spell it.
  const last = (segments[segments.length - 1] ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, "-");
  return SIGN_IN_SEGMENT_RE.test(last);
}

/** The most origins a session may trust with its embeds' writes. */
export const MAX_TRUSTED_EMBEDS = 10;

/**
 * The origins a session was told to trust, normalised, and what was given
 * that is not one. An entry must be a plain http(s) origin — scheme, host and
 * port, nothing after — so a path or a wildcard cannot widen it by accident.
 */
export function trustedEmbedOrigins(list: readonly string[] | undefined): { origins: string[]; rejected: string[] } {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const raw of list ?? []) {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      rejected.push(raw);
      continue;
    }
    const bare = u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !bare || raw.includes("*")) {
      rejected.push(raw);
      continue;
    }
    if (!origins.includes(u.origin) && origins.length < MAX_TRUSTED_EMBEDS) origins.push(u.origin);
    else if (!origins.includes(u.origin)) rejected.push(raw);
  }
  return { origins, rejected };
}

/**
 * Whether the writes a frame of `origin` sends outside the app may go out
 * after all: only for an origin the user named as trusted (a provider in test
 * mode, say), and only in safe-write — read-only and observe keep their
 * promise, and destructive allows everything already.
 */
export function trustsEmbedWrite(mode: WriteMode, trusted: ReadonlySet<string>, origin: string): boolean {
  return mode === "safe-write" && trusted.has(origin);
}

/** The longest text typed into another site's frame; past it, a value is a fuzzing probe, not a user's input. */
export const MAX_EMBED_TEXT = 200;

/**
 * Why a value must not be typed into another site's frame, or null when it
 * may be. The tester is authorised to test the app, not the embeds of
 * others: markup, fuzzing lengths and control characters typed there would
 * be probing a third party's system without its leave.
 */
export function hostileForEmbed(text: string): string | null {
  if (/<\s*[a-z!/?]/i.test(text) || /javascript:/i.test(text)) return "it is markup";
  if (text.length > MAX_EMBED_TEXT) return `it is longer than ${MAX_EMBED_TEXT} characters`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return "it holds control characters";
  return null;
}

/** The refusal for a probe aimed at another site's frame. */
export function embedProbeRefusal(what: string, origin: string): string {
  return (
    `REFUSED: ${what} inside a frame of ${origin}, another site embedded in the page. The tester is authorised to test the app, ` +
    `not the embeds of others, so hostile input, repeated-click probes and file uploads are never sent into one, in any mode. ` +
    `Ordinary clicks and typing there are allowed; the embed's writes out of the app are refused by the write policy.`
  );
}

/**
 * The sandbox given to every document a frame of another origin loads, outside
 * destructive mode: scripts, forms and its own origin keep working, and no
 * popups or top-window navigation are allowed. A browser applies it to every
 * realm the document makes, nested frames and blank ones included, which a
 * script patch cannot reach: in Firefox a detached link's click, a
 * `<base target>` or a borrowed `window.open` each opened a popup whose first
 * requests never reached the policy.
 */
export const FOREIGN_FRAME_SANDBOX = "sandbox allow-scripts allow-forms allow-same-origin";

/**
 * A response's Content-Security-Policy with the foreign-frame sandbox added. A
 * second policy joined with a comma is enforced alongside the first, so the
 * document's own policy still holds.
 */
export function withForeignFrameSandbox(existing: string | undefined): string {
  return existing && existing.trim() ? `${existing}, ${FOREIGN_FRAME_SANDBOX}` : FOREIGN_FRAME_SANDBOX;
}

export function allowsWrite(mode: WriteMode, method: string, destructiveWire: boolean, owned: boolean): boolean {
  if (mode === "destructive") return true;
  if (mode === "observe") return false;
  // POST: creation/RPC passes unless it looks destructive and is not ours.
  if (method === "POST") return !destructiveWire || owned;
  // PUT/PATCH/DELETE: only in safe-write, only on this run's own records.
  return mode === "safe-write" && owned;
}

/**
 * Which blocked requests the write policy answers rather than drops.
 *
 * A dropped request tells the page nothing it would ever meet in production:
 * `fetch` rejects with a network error, and the code that handles a refusal —
 * the branch that should say "couldn't save" — never runs. Answering a script's
 * request with a refusal keeps the server untouched and exercises that branch,
 * so a page that reports a refused save as saved is caught. A navigation (a
 * native form post) is still dropped: answering it would replace the page the
 * user was on with the stand-in body.
 */
export function answersWithRefusal(resourceType: string): boolean {
  return resourceType === "fetch" || resourceType === "xhr";
}

/** Header on every refusal the policy writes, so the stand-in can be told from the server's own answer. */
export const POLICY_REFUSAL_HEADER = "x-scenescout-policy";

/**
 * The response the write policy sends in the server's place. 403, because the
 * request is forbidden, not failed: a 5xx invites retries, and a 401 is what
 * many apps read as "signed out". The CORS headers let a cross-origin API
 * call read the refusal instead of failing as a network error, which would
 * drop it all over again. `origin` is the request's own Origin header, echoed
 * only when there is one.
 */
export function policyRefusal(
  mode: WriteMode,
  method: string,
  pathname: string,
  origin?: string,
  why?: string,
): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "content-type": "application/json", [POLICY_REFUSAL_HEADER]: `refused; mode=${mode}` };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
    headers["access-control-expose-headers"] = POLICY_REFUSAL_HEADER;
  }
  return {
    status: 403,
    headers,
    body: JSON.stringify({
      error: "Forbidden",
      message: `${method} ${pathname} was refused by the tester's ${mode} write policy${why ? ` (${why})` : ""}. The server never received it.`,
    }),
  };
}
