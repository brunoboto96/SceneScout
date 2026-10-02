/**
 * Destructive-action policy. In read-only mode the engine refuses to interact
 * with elements whose accessible name / testid / id matches these patterns —
 * enforcement lives here, at the tool layer, never in the model's prompt.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  // "Remove" a filter chip drops a condition from the view: "Remove Status:
  // Open filter" re-queries the list, the same sense the reset rule exempts.
  // A label whose object, at its end, is a filter or a chip, or a test id with
  // the chip before the verb ("filter-remove"), is exempt; "Remove member",
  // and "Remove member. Use the filter to find others.", still count.
  /(?<!\b(?:filters?|chips?)[\s-]{1,3})\bremove\b(?![^\n]{0,60}?\b(?:filters?|chips?)\W*$)/i,
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
  // "Discard" names two different things. "Discard changes", "Discard your
  // edits" and "Discard unsaved changes" drop what the tester typed and has not
  // sent: no record exists to lose, and refusing it left a session stuck on a
  // dirty form behind the app's own leave-confirmation. Those senses are
  // exempt, written as words or as a test id ("discard-changes"); "Discard
  // draft", "Discard record" and a bare "Discard" still count.
  // If the confirm does send a write, the wire policy judges that request as it
  // judges any other, and `discard` is a destructive verb in a path there.
  /\bdiscard\b(?![\s_-]+(?:(?:your|my|all|the|any)[\s_-]+)?(?:unsaved[\s_-]+|pending[\s_-]+|local[\s_-]+|draft[\s_-]+)?(?:changes|edits)\b)/i,
  /\bcancel subscription\b/i,
  // The verb: a control that signs the user off, starting the label ("Sign
  // off", "(Sign off)", a test id "sign-off-button") or joined to another verb
  // ("Save and sign off", "Save & sign off"). Anywhere else it is the noun
  // approval apps label things with ("Needs sign-off", "Manager sign-off",
  // "Final sign-off recorded"), which destroys nothing. Told by position, not
  // by a list of the words that may come before it: any modifier can.
  /(?:^[^\p{L}\p{N}]*|\b(?:and|then)\s+|&\s*)sign(?: |-)?off\b/iu,
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
const DESTRUCTIVE_URL_RE = /(\/|\b|_)(delete|remove|purge|destroy|archive|revoke|deactivate|wipe|discard|bulk[-_]?delete|force[-_]?delete)(\/|\b|_)/i;

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
  /\bmutation\b[\s\S]{0,200}?\b(?:delete|remove|archive|destroy|purge|revoke)[A-Za-z_]|(?:^|[{,[\s]*["']|[?&])\s*(?:action|operation|op|method|_method|command|cmd)["']?\s*[:=]\s*["']?(?:delete|remove|purge|destroy|archive|revoke|deactivate|wipe|discard)\b/i;

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

/**
 * A listed element as the label policy judges it. `name` is its accessible
 * name, which for an element with no label of its own is all its text,
 * descendants included. `ownText` is the label it is given (aria-label,
 * aria-labelledby) and its text without what belongs to the controls inside it, and `centre` the labels and test ids of the controls
 * inside it that cover its centre point, the spot a click on it lands; both
 * are read in the page and absent when they could not be.
 */
export interface JudgedControl {
  tag: string;
  role: string;
  name: string;
  testid?: string | null;
  ownText?: string | null;
  centre?: readonly string[] | null;
  /** Whether a user can act on it (collector.ts isInteractive). False for an element listed only for its test id or text. */
  interactive?: boolean;
}

/** The most words a click target's own text may have and still be read as its command. */
export const COMMAND_TEXT_WORDS = 4;

/** A short verb phrase, or null: at most COMMAND_TEXT_WORDS words and no sentence. */
function commandText(text: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= COMMAND_TEXT_WORDS && !SENTENCE_RE.test(text) ? text : null;
}

/** Roles whose accessible name is the label of the one thing a click does. */
const LABELLED_CONTROL_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
  "image",
]);

/**
 * The label that makes a listed element destructive, or null. A control is
 * judged by its OWN name, never by what it merely contains:
 *
 * - A button, link, menu item, tab or option (by tag or by role) is named
 *   by what it does, and that name is judged whole, however long: a button
 *   "Delete all my saved data" is refused. The word cap below is only for
 *   containers, whose text is the record they show.
 * - A dropdown (a `<select>`, a combobox, a listbox) is named by its options,
 *   all of them, so a filter offering "All, Create, Update, Delete" read as a
 *   delete control and choosing "Create" was refused. Choosing is judged where
 *   the value is known: scout_select vets the chosen option, and an option
 *   clicked in a custom list is a control of its own. Only its test id, and a
 *   control covering its centre, are judged here.
 * - Anything else (a row, a card, a heading, a panel listed for its test id
 *   or a click handler) is judged by its test id and by the control covering
 *   its centre, where a click on it lands: a row whose middle IS a delete
 *   button is still refused, and the buttons inside it are listed, and
 *   refused, on their own. Its text is the record it shows ("Archive Test
 *   Widget", "Final sign-off recorded"), not a command, so the text counts
 *   only for a click target whose own text is a short verb phrase
 *   (COMMAND_TEXT_WORDS words, no sentence): a clickable div saying "Delete".
 *   A heading is never judged by its text.
 *
 * When the page could not say what the own text is, the whole name stands in
 * and is judged whole, so a reading that failed can only refuse more.
 */
export function destructiveLabelOf(c: JudgedControl): string | null {
  const first = (...labels: Array<string | null | undefined>): string | null =>
    labels.find((l): l is string => typeof l === "string" && l.length > 0 && isDestructive(l)) ?? null;
  const centre = c.centre ?? [];
  if (c.tag === "select" || c.role === "combobox" || c.role === "listbox") return first(c.testid, ...centre);
  if (LABELLED_CONTROL_ROLES.has(c.role) || c.tag === "button" || c.tag === "a") return first(c.name, c.testid);
  if (c.role === "heading" || /^h[1-6]$/i.test(c.tag)) return first(c.testid, ...centre);
  const own = c.ownText == null ? c.name : c.interactive === false ? null : commandText(c.ownText);
  return first(own, c.testid, ...centre);
}

/**
 * A dropdown pick, judged by the value asked for, the dropdown's test id and
 * the label of the option it matches. The dropdown's own name is not judged
 * (destructiveLabelOf), so this is the check, and a label that could not be
 * read (null) refuses: an unvetted pick could be "Delete".
 */
export function pickIsDestructive(value: string | undefined, testid: string | null | undefined, optionLabel: string | null): boolean {
  return optionLabel === null || isDestructive(value, testid, optionLabel);
}

export function destructiveRefusal(label: string, mode: string = "read-only"): string {
  return (
    `REFUSED by ${mode} policy: "${label}" matches a destructive-action pattern. ` +
    `This run is ${mode}; do not attempt this element again. If destructive flows must be tested, ` +
    `the user has to re-attach with mode="destructive" against a disposable/seeded environment.`
  );
}

/** One write the policy refused, as the block notice reports it. */
export interface BlockedWrite {
  /** "POST https://host/path?query", or "navigation to …" for a refused page move. */
  sig: string;
  /** It started before the action now reporting it: background traffic, or a previous action's. */
  late: boolean;
  /** The page's own request was answered with a 403 in the server's place. */
  answered?: boolean;
  /** A reason beyond the mode's rule: a foreign embed, or ESCAPE_REFUSAL. */
  why?: string;
}

/** The `why` of a page move refused as a possible escape from a foreign frame's sandbox. */
export const ESCAPE_REFUSAL = "a possible frame escape";

/** New blocked endpoints listed by name in one notice; the rest are counted. */
export const BLOCK_NOTICE_LIST = 5;

/** What a blocked write is remembered by: its method and URL, without query or fragment. */
export function blockSignature(sig: string): string {
  return sig.replace(/[?#].*$/, "");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The write-policy block notice, said once. A page that beacons to a
 * monitoring endpoint on every load had every tool result open with the same
 * blocked request five times over and the whole explanation after it, which
 * buried the action's own result and the blocks that mattered.
 *
 * So a session remembers what it has been told. Each endpoint (by
 * blockSignature, per write rule) is named in full the first time it is
 * blocked; after that it is counted on one line. The explanation is given in
 * full once per rule, and later notices for a new endpoint refer back to it.
 * Nothing about the blocking changes: every request is still refused, and
 * every refusal is still reported, if only as a count.
 */
export class BlockNotices {
  private seen = new Set<string>();
  private explained = new Set<WriteMode>();

  /** Forget everything said: a re-attached session starts a new conversation. */
  reset(): void {
    this.seen.clear();
    this.explained.clear();
  }

  /**
   * The notice for the writes refused since the last action, or "" when there
   * were none. `createdCount` is how many records this run has created, which
   * the safe-write advice names.
   */
  notice(rule: WriteMode, blocked: readonly BlockedWrite[], createdCount = 0): string {
    if (blocked.length === 0) return "";
    type Group = { first: BlockedWrite; count: number; allLate: boolean; answered: boolean; whys: Set<string> };
    const groups = new Map<string, Group>();
    for (const b of blocked) {
      const key = blockSignature(b.sig);
      const g = groups.get(key);
      if (g) {
        g.count += 1;
        g.allLate &&= b.late;
        g.answered ||= !!b.answered;
        if (b.why) g.whys.add(b.why);
      } else groups.set(key, { first: b, count: 1, allLate: b.late, answered: !!b.answered, whys: new Set(b.why ? [b.why] : []) });
    }
    const fresh: Array<[string, Group]> = [];
    const repeats: Array<[string, Group]> = [];
    for (const [key, g] of groups) {
      const memo = `${rule} ${key}`;
      if (this.seen.has(memo)) repeats.push([key, g]);
      else {
        this.seen.add(memo);
        fresh.push([key, g]);
      }
    }
    const late = (g: Group): string => (g.allLate ? " (late — likely from a previous action or background traffic)" : "");
    const times = (g: Group): string => (g.count > 1 ? ` ×${g.count}` : "");
    const repeatCount = repeats.reduce((n, [, g]) => n + g.count, 0);
    const repeatLine =
      repeats.length === 0
        ? ""
        : `${plural(repeatCount, "repeat block")} of ${plural(repeats.length, "known endpoint")} (` +
          repeats
            .slice(0, 3)
            .map(([key, g]) => `${key} ×${g.count}${g.allLate ? ", background" : ""}`)
            .join("; ") +
          (repeats.length > 3 ? `; +${repeats.length - 3} more` : "") +
          `)`;
    const head = `\n🛡 WRITE-POLICY blocked (${rule}): `;
    if (fresh.length === 0) return `${head}${repeatLine}, refused as before. The tester's safety policy, not an app bug.`;

    const list = fresh
      .slice(0, BLOCK_NOTICE_LIST)
      .map(([, g]) => `${g.first.sig}${times(g)}${late(g)}`)
      .join("; ");
    const more = fresh.length > BLOCK_NOTICE_LIST ? ` (+${fresh.length - BLOCK_NOTICE_LIST} more new)` : "";
    const also = repeatLine ? `; also ${repeatLine}` : "";
    const whys = new Set(fresh.flatMap(([, g]) => [...g.whys]));
    const escaped = whys.delete(ESCAPE_REFUSAL);
    const foreign = [...whys];
    const answered = fresh.some(([, g]) => g.answered);
    const reasons =
      (foreign.length > 0
        ? `Refused because it was ${foreign.join("; ")}: it would reach a site embedded in the page rather than the app, which no mode but destructive allows. `
        : "") +
      (escaped
        ? `A move of the whole page off the app, with no Referer, was refused: a frame that held another site now sits on a data: or blob: URL, where WebKit drops the frame's sandbox, so the move may be that frame's. No mode but destructive allows it. `
        : "");
    if (this.explained.has(rule)) {
      return (
        `${head}${list}${more}${also}. The tester's safety policy, not an app bug (explained in full earlier in this session). ` +
        reasons +
        (answered ? `The page's request was answered with a 403 in the server's place, as before. ` : "")
      ).trimEnd();
    }
    this.explained.add(rule);
    return (
      `${head}${list}${more}${also}. ` +
      `This is the tester's safety policy, NOT an app bug — do not file a finding for the resulting error UI. ` +
      reasons +
      (answered
        ? `The page's own requests were answered with a 403 in the server's place, so the page's handling of a refusal is real: an error message is correct, and a success message is a false_success violation. `
        : "") +
      (rule === "observe"
        ? `observe mode blocks every request that is not a GET, so no form submission reaches the server. Re-attach with mode="read-only" ONLY if the user confirms that ordinary form submissions are acceptable on this target. If a refused POST only reads (a search or query sent as POST), the user can name it in readPosts instead; never add one yourself.`
        : rule === "read-only"
          ? `Re-attach with mode="safe-write" to test create/edit flows, or "destructive" (user-approved disposable env only).`
          : `In safe-write, updates/deletes are only allowed on resources this session created (${createdCount} so far).`)
    );
  }
}

/** How the engine answers a native dialog the page opens. */
export type DialogResponse = "accept" | "dismiss";

/**
 * The answer to a native dialog. alert, confirm and prompt are dismissed in
 * the modes that protect data (observe, read-only) and accepted otherwise, as
 * before: a confirm can stand between a click and a delete.
 *
 * `beforeunload` is the page asking whether to leave while it holds unsent
 * input. Leaving sends no write of its own, and whatever the page sends as it
 * goes is judged by the wire policy like any other request, but leaving does
 * throw away what the tester typed. So it is the caller's choice: `leave: true`
 * leaves, `leave: false` stays, and with no choice the mode decides, staying
 * in observe and read-only. Either way the result says what happened (see
 * dialogNote), because a dismissed one surfaced only as a bare ERR_ABORTED.
 */
export function dialogResponse(type: string, readOnly: boolean, leave?: boolean): DialogResponse {
  if (type === "beforeunload") return (leave ?? !readOnly) ? "accept" : "dismiss";
  return readOnly ? "dismiss" : "accept";
}

/** The line an action's result carries for a native dialog the page opened during it. */
export function dialogNote(d: { type: string; message: string; response: DialogResponse; leave?: boolean }): string {
  const message = d.message.trim().replace(/\s+/g, " ").slice(0, 120);
  if (d.type === "beforeunload") {
    return d.response === "dismiss"
      ? `\n⚠ LEAVE CONFIRMATION: the page asked to confirm leaving (it holds input that was never sent), and the engine answered "stay"` +
          `${d.leave === false ? " as asked (leave: false)" : ""}, so the navigation was cancelled and the page is unchanged. ` +
          `This is not an app bug, and nothing was sent. To leave and discard that unsent input, repeat the action with leave: true.`
      : `\nℹ LEAVE CONFIRMATION: the page asked to confirm leaving (it held input that was never sent), and the engine answered "leave"` +
          `${d.leave === true ? " as asked (leave: true)" : ""}, so that unsent input is discarded. ` +
          `Any request the page sends as it is left is judged by the write policy like any other.`;
  }
  return `\nℹ DIALOG (${d.type})${message ? `: "${message}"` : ""} — ${d.response === "accept" ? "accepted" : "dismissed"} by the engine.`;
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

/** The stricter of two modes: WRITE_MODES runs from the strictest to the loosest. */
export function stricterMode(a: WriteMode, b: WriteMode): WriteMode {
  return WRITE_MODES.indexOf(a) <= WRITE_MODES.indexOf(b) ? a : b;
}

/**
 * How long a rule that was just loosened still judges writes. A request is
 * judged when the engine hears of it, which can be after the page sent it: a
 * beacon a page sends as it is left reaches the browser-level interception
 * tens of milliseconds after the page has gone, and a routed request waits its
 * turn behind the handler. Five seconds is two orders of magnitude above the
 * delays seen, and the price is only that writes sent in the first seconds
 * after a flow ends are judged by the flow's stricter rule.
 */
export const LOOSENED_RULE_HOLD_MS = 5000;

/**
 * The write rule in force, as the judges must read it: a request is judged by
 * the rule in force when the page sent it, which the engine cannot see, so by
 * the strictest rule in force at any time in the hold before it is judged.
 * Tightening the rule applies at once; loosening it (a flow handing back to
 * the crawl) keeps the stricter rule in force for `holdMs`, so a write the
 * flow's page sent under the flow's rule is never judged under the looser one
 * because it was heard of a moment late.
 */
export class WriteRule {
  private held: Array<{ mode: WriteMode; until: number }> = [];

  constructor(
    private current: WriteMode,
    private readonly holdMs = LOOSENED_RULE_HOLD_MS,
  ) {}

  set(mode: WriteMode, now = Date.now()): void {
    if (stricterMode(this.current, mode) === this.current && this.current !== mode) this.held.push({ mode: this.current, until: now + this.holdMs });
    this.current = mode;
  }

  /** The rule a write heard of now is judged by. */
  at(now = Date.now()): WriteMode {
    this.held = this.held.filter((h) => h.until >= now);
    return this.held.reduce((rule, h) => stricterMode(rule, h.mode), this.current);
  }
}

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

/**
 * The embed a failing request is attributed to: the other site whose frame
 * sent it (`frameSite`, judged on the frame chain), unless the request went to
 * the app itself — a 500 from the app is the app's to answer, whoever called.
 */
export function embedOfRequest(appUrl: string, requestUrl: string, frameSite: string | null): string | null {
  if (!frameSite) return null;
  return foreignFrameOrigin(appUrl, [requestUrl]) === null ? null : frameSite;
}

/** The most origins a session may trust with its embeds' writes. */
export const MAX_TRUSTED_EMBEDS = 10;

/**
 * The origins a session was told to trust, normalised, and what was given
 * that is not one. An entry must be a plain http(s) origin — scheme, host and
 * port, nothing after — so a path or a wildcard cannot widen it by accident.
 */
export function trustedEmbedOrigins(list: readonly string[] | undefined): { origins: string[]; rejected: string[]; overflow: string[] } {
  const origins: string[] = [];
  const rejected: string[] = [];
  const overflow: string[] = [];
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
    // "pay.example.com." is "pay.example.com": one origin, one slot.
    const origin = u.origin.replace(/\.(?=(:\d+)?$)/, "");
    if (origins.includes(origin)) continue;
    if (origins.length < MAX_TRUSTED_EMBEDS) origins.push(origin);
    else overflow.push(raw);
  }
  return { origins, rejected, overflow };
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

/**
 * Whether a foreign write may go out because of trust: every other site
 * involved — each http(s) frame from the sender up to the page, and the
 * Origin header when it names one — must be trusted, so an untrusted embed
 * cannot borrow a trusted one it wraps. A page the session never adopted (a
 * popup) is not a frame, and trust does not reach it.
 */
export function trustsForeignWrite(
  mode: WriteMode,
  trusted: ReadonlySet<string>,
  appUrl: string,
  req: { frameChain: readonly string[]; originHeader?: string; unadoptedPageUrl?: string | null },
): boolean {
  if (mode !== "safe-write" || trusted.size === 0 || req.unadoptedPageUrl) return false;
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
  const involved = new Set<string>();
  for (const url of req.frameChain) {
    // A blank or srcdoc frame is its parent's, and the parent is judged next.
    // Any other frame with no web address (blob:, data:) could be an untrusted
    // site that moved itself there to wrap a trusted one: no trust through it.
    if (/^about:(blank|srcdoc)/i.test(url)) continue;
    const o = originOf(url);
    if (!o) return false;
    if (o !== app) involved.add(o);
  }
  const header = originOf(req.originHeader);
  if (header && header !== app) involved.add(header);
  return involved.size > 0 && [...involved].every((o) => trustsEmbedWrite(mode, trusted, o));
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

/** The most POST endpoints a session may name as reads. */
export const MAX_READ_POSTS = 20;

/** The environment variable naming POST endpoints that only read, for every surface that attaches. A `readPosts` option wins over it. */
export const READ_POSTS_ENV = "SCENESCOUT_READ_POSTS";

/** One POST endpoint the user named as a read: an origin (null for the app's own) and path segments, `*` standing for any one segment. */
export interface ReadPost {
  /** The entry as given, for the log and the report. */
  entry: string;
  origin: string | null;
  segments: string[];
}

/**
 * The POST endpoints a session was told only read, from the `readPosts`
 * option, else the environment variable (entries separated by commas or new
 * lines). Nothing by default: observe refuses every POST until the user names
 * one, and the agent must never add one itself.
 */
export function readPostsSetting(option: readonly string[] | undefined, env: string | undefined): string[] {
  if (option !== undefined) return [...option];
  return (env ?? "")
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * The entries parsed, and what was given that is not one. An entry is
 * `POST <path>` for the app's own origin, or `POST <http(s) URL>` for an API
 * on another origin: the method must be POST, the path must start with `/`
 * and carry no query or fragment, and `*` may stand only for one whole path
 * segment, such as an id. Exact otherwise, so nothing is widened by accident;
 * a trailing slash is ignored.
 */
export function readPostEntries(list: readonly string[]): { entries: ReadPost[]; rejected: string[]; overflow: string[] } {
  const entries: ReadPost[] = [];
  const rejected: string[] = [];
  const overflow: string[] = [];
  for (const raw of list) {
    const m = /^\s*POST\s+(\S+)\s*$/i.exec(raw);
    if (!m) {
      rejected.push(raw);
      continue;
    }
    let origin: string | null = null;
    let pathname = m[1];
    if (/^https?:\/\//i.test(pathname)) {
      let u: URL;
      try {
        u = new URL(pathname);
      } catch {
        rejected.push(raw);
        continue;
      }
      if (u.search || u.hash || u.username || u.password || /[?#]/.test(pathname)) {
        rejected.push(raw);
        continue;
      }
      origin = u.origin;
      // The path as written: URL would percent-encode a `*`.
      const slash = pathname.indexOf("/", pathname.indexOf("//") + 2);
      pathname = slash === -1 ? "/" : pathname.slice(slash);
    }
    const segments = pathname.split("/").filter(Boolean);
    if (!pathname.startsWith("/") || /[?#\s]/.test(pathname) || segments.some((seg) => seg.includes("*") && seg !== "*")) {
      rejected.push(raw);
      continue;
    }
    const entry = `POST ${origin ?? ""}${"/" + segments.join("/")}`;
    if (entries.some((e) => e.entry === entry)) continue;
    if (entries.length < MAX_READ_POSTS) entries.push({ entry, origin, segments });
    else overflow.push(raw);
  }
  return { entries, rejected, overflow };
}

/** The entry a POST to `url` matches, or null. An entry with no origin matches the app's own origin only. */
export function matchReadPost(entries: readonly ReadPost[], appUrl: string, url: string): ReadPost | null {
  let target: URL;
  let app: string;
  try {
    target = new URL(url);
    app = new URL(appUrl).origin;
  } catch {
    return null;
  }
  const segments = target.pathname.split("/").filter(Boolean);
  return (
    entries.find(
      (e) => (e.origin ?? app) === target.origin && e.segments.length === segments.length && e.segments.every((seg, i) => seg === "*" || seg === segments[i]),
    ) ?? null
  );
}

/** The longest body read for a GraphQL operation; a longer one cannot be vetted and is refused. */
export const MAX_READ_POST_BODY = 100_000;

/** A GraphQL operation that writes: `mutation` or `subscription`, then an optional name, then its variables, directives or selection. */
const GRAPHQL_WRITE_OP_RE = /(?:^|[^A-Za-z0-9_$])(?:mutation|subscription)\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*)?[({@]/;

/**
 * Whether a body carries a GraphQL operation that is not a query, or one that
 * cannot be read. Read from the body as sent, from every `query` string in a
 * JSON body (or a batch of them), so an escaped newline cannot hide the
 * keyword, and from a form-encoded `query` field. A persisted query (a hash
 * and no text) counts, since its operation is unknown. A search box's text
 * ("mutation testing") is not an operation and does not match.
 */
export function graphqlWriteOperation(body: string): boolean {
  if (GRAPHQL_WRITE_OP_RE.test(body)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A form-encoded body: its `query` field, decoded.
    const query = /(?:^|&)query=/.test(body) ? new URLSearchParams(body).get("query") : null;
    return query !== null && GRAPHQL_WRITE_OP_RE.test(query);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { query, extensions } = item as { query?: unknown; extensions?: { persistedQuery?: unknown } };
    if (typeof query === "string") return GRAPHQL_WRITE_OP_RE.test(query);
    // A persisted query names its operation by hash alone, so what it runs cannot be read: refused.
    return typeof extensions === "object" && extensions !== null && extensions.persistedQuery !== undefined;
  });
}

/**
 * The entry that lets this POST out of observe, or null. Only in observe:
 * read-only and safe-write already let a POST out unless it looks
 * destructive, and destructive lets everything out. Even a listed endpoint is
 * refused when its path or body looks destructive (the whole body is read),
 * when its body is a GraphQL mutation, subscription or persisted query, or
 * when the body is too long to vet.
 */
export function readPostAllowed(input: {
  mode: WriteMode;
  method: string;
  url: string;
  appUrl: string;
  body: string | null | undefined;
  destructiveWire: boolean;
  entries: readonly ReadPost[];
}): ReadPost | null {
  if (input.mode !== "observe" || input.method !== "POST" || input.destructiveWire || input.entries.length === 0) return null;
  const entry = matchReadPost(input.entries, input.appUrl, input.url);
  if (!entry) return null;
  const body = input.body ?? "";
  // The whole body, not the first 2000 characters isDestructiveWire reads: a command after a long filter still counts.
  if (body.length > MAX_READ_POST_BODY || DESTRUCTIVE_BODY_RE.test(body) || graphqlWriteOperation(body)) return null;
  return entry;
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
