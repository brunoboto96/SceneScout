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
  /\bsign(?: |-)?off\b/i,
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

export function isDestructive(...labels: Array<string | null | undefined>): boolean {
  return labels.some((label) => typeof label === "string" && label.length > 0 && DESTRUCTIVE_PATTERNS.some((re) => re.test(label)));
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

export function allowsWrite(mode: WriteMode, method: string, destructiveWire: boolean, owned: boolean): boolean {
  if (mode === "destructive") return true;
  if (mode === "observe") return false;
  // POST: creation/RPC passes unless it looks destructive and is not ours.
  if (method === "POST") return !destructiveWire || owned;
  // PUT/PATCH/DELETE: only in safe-write, only on this run's own records.
  return mode === "safe-write" && owned;
}
