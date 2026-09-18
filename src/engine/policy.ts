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

export function destructiveRefusal(label: string): string {
  return (
    `REFUSED by read-only policy: "${label}" matches a destructive-action pattern. ` +
    `This run is read-only; do not attempt this element again. If destructive flows must be tested, ` +
    `the user has to re-attach with mode="destructive" against a disposable/seeded environment.`
  );
}

/**
 * Mutation notices must not include requests the policy aborted.
 *
 * The request event fires for every non-GET the page attempts, before the
 * route handler decides its fate. Reporting all of them told the agent, about
 * one and the same DELETE, both "server state may have mutated despite
 * read-only mode" and "WRITE-POLICY blocked" — two opposite facts, and an
 * invitation to file a false finding against the app under test.
 *
 * Signatures are `METHOD url` truncated to different lengths by the two
 * recorders, so a blocked signature is matched by prefix.
 */
export function withoutBlocked<T extends { sig: string }>(mutations: T[], blocked: Array<{ sig: string }>): T[] {
  if (blocked.length === 0) return mutations;
  return mutations.filter((m) => !blocked.some((b) => b.sig.startsWith(m.sig) || m.sig.startsWith(b.sig)));
}
