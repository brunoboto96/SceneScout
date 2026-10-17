/**
 * The run around the panel (design: docs/design/non-technical-assistant.md,
 * sections 2.3 and 4.1): the band above the prompt and the status line that
 * keep a guided check in view once the panel is closed, and when a queued
 * check starts. Like guided.js it has no mods API in it, so every rule is
 * table-tested in scripts/live-test.ts; register.js wires it to events.
 *
 * A queued check is a saved check. It starts on its own plan, built by the
 * server when its turn comes, so it is confirmed by the person again wherever
 * its care level needs it: a confirmation given to the check before it is
 * never carried over. It starts only in the care level it had when the person
 * queued it.
 */
import { CARE_LABEL, afterSavedRun, guidedOf, plainLine, readSaved } from "./guided.js";

/** The band's and the status line's cleaning, the same as the panel's. */
export { plainLine };

/** How long after the panel handed Claude a plan the queue waits before it reads "nothing is going" as the check having ended. */
export const QUEUE_GRACE_MS = 15_000;
/** How long the mod polls, with the panel closed, for a plan it handed Claude that the server does not show yet. */
export const HANDED_WAIT_MS = 5 * 60_000;
/** The longest status line the mod sets. */
export const STATUS_MAX = 120;

export const BAND_WORDS = {
  open: "Open the panel",
  needsYou: (/** @type {string} */ sentence) => `SceneScout needs you: ${sentence}`,
  now: (/** @type {string} */ now) => `SceneScout · Now: ${now}`,
  queued: (/** @type {number} */ n) => `${n} queued`,
  waiting: (/** @type {number} */ n, /** @type {string} */ name) => `SceneScout · ${n} check${n === 1 ? "" : "s"} queued, next: "${name}"`,
  paused: (/** @type {number} */ n) => `SceneScout · ${n} check${n === 1 ? "" : "s"} queued, paused: open the panel to go on`,
  confirmNext: (/** @type {string} */ name) => `SceneScout: "${name}" is next, and waits for your yes in the panel before it starts.`,
  careChanged: (/** @type {string} */ name, /** @type {string} */ now, /** @type {string} */ then) =>
    `"${name}" now uses "${now}", not "${then}" as when you queued it, so it did not start. Press Run again on the welcome to start it.`,
  toastConfirm: (/** @type {string} */ name) => `SceneScout: your next check, "${name}", needs your yes before it starts.`,
  toastNotStarted: (/** @type {string} */ name, /** @type {string} */ why) => `SceneScout: the queued check "${name}" did not start. ${why}`,
  toastStarted: (/** @type {string} */ name) => `SceneScout: the queued check "${name}" has started. Follow it from the panel.`,
  toastKept: (/** @type {string} */ name) =>
    `SceneScout: "${name}" stays first in the queue, which is paused. Press Go on in the panel to start it, or Remove to drop it.`,
  busy: "SceneScout: a check is already being planned. Wait for it before pressing again.",
};

/** @param {unknown} v */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** @param {unknown} v */
function str(v) {
  return typeof v === "string" ? v : "";
}
/** @param {unknown} v */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Whether a guided check has ended: done, or stopped. */
export function isFinished(/** @type {any} */ g) {
  return isRecord(g) && (g.phase === "done" || g.phase === "stopped");
}

/** "no problems so far", "1 problem so far", "4 problems so far": the four impacts added up. */
export function problemCount(/** @type {any} */ p) {
  const n = num(p?.blocksUsers) + num(p?.annoying) + num(p?.cosmetic) + num(p?.worthALook);
  return n === 0 ? "no problems so far" : `${n} problem${n === 1 ? "" : "s"} so far`;
}

/**
 * The band's one line, or null when there is nothing to keep in view: a
 * queued check waiting on the person's yes, else the check going (what it
 * asks of the person, or what it is doing now and the problems so far), else
 * the checks waiting to start, else the open tickets SceneScout filed.
 *
 * @param {import("./guided.js").Wizard} w
 * @param {{ kind: string, data?: any }} status
 * @param {Ticket[] | null} [tickets] the watched tickets, as the last scout_ticket_status reading had them
 * @returns {string | null}
 */
export function bandLine(w, status, tickets = null) {
  const line = bandWords(w, status) ?? ticketBand(tickets);
  return line === null ? null : plainLine(line);
}

/** The band's line before it is made plain. @param {import("./guided.js").Wizard} w @param {{ kind: string, data?: any }} status */
function bandWords(w, status) {
  if (w.fromQueue) return BAND_WORDS.confirmNext(w.fromQueue);
  const g = guidedOf(status, null);
  if (g && !isFinished(g)) {
    if (isRecord(g.needsYou) && str(g.needsYou.sentence)) return BAND_WORDS.needsYou(str(g.needsYou.sentence));
    const parts = [BAND_WORDS.now(str(g.now)), problemCount(g.problems)];
    if (w.queue.length) parts.push(BAND_WORDS.queued(w.queue.length));
    return parts.join(" · ");
  }
  if (w.queue.length) return w.queuePaused ? BAND_WORDS.paused(w.queue.length) : BAND_WORDS.waiting(w.queue.length, w.queue[0].name);
  return null;
}

/**
 * The status line: the band's line, cut to STATUS_MAX characters, or
 * undefined, which clears it.
 *
 * @param {import("./guided.js").Wizard} w
 * @param {{ kind: string, data?: any }} status
 * @param {Ticket[] | null} [tickets]
 * @returns {string | undefined}
 */
export function statusLine(w, status, tickets = null) {
  const line = bandLine(w, status, tickets);
  if (!line) return undefined;
  return line.length > STATUS_MAX ? `${line.slice(0, STATUS_MAX - 3)}...` : line;
}

/**
 * Whether the mod polls the server: while the panel is open, and with it
 * closed while there is a check to keep in view: one going, one waiting in
 * the queue (but not while a preview waits on the person's yes, which holds
 * the queue and only the open panel can give), or one the panel handed
 * Claude that the server does not show yet, for HANDED_WAIT_MS after it was
 * sent (Claude may never start it).
 *
 * @param {boolean} isOpen
 * @param {import("./guided.js").Wizard} w
 * @param {{ kind: string, data?: any }} status
 * @param {{ now: number, sentAt: number }} at
 */
export function keepsPolling(isOpen, w, status, at) {
  if (isOpen) return true;
  const g = guidedOf(status, null);
  if (g && !isFinished(g)) return true;
  // A preview waiting on the person's yes (a queued check's or their own) holds the queue, and changes only when they open the panel, which polls.
  if (awaitsYes(w)) return false;
  if (w.queue.length > 0 && !w.queuePaused) return true;
  const handed = w.step === "running" && w.planId !== null && !(g && str(g.planId) === w.planId);
  return handed && at.now - at.sentAt < HANDED_WAIT_MS;
}

/** Whether a plan waits on the person's yes: their own preview, or a queued check's, open or not. @param {import("./guided.js").Wizard} w */
export function awaitsYes(w) {
  return w.step === "confirm" || w.fromQueue !== null;
}

/**
 * The queued check to start now, or null. One starts only when nothing is
 * going: no guided check running, Claude idle, the panel not busy and not
 * waiting on a confirmation, and the last plan the panel handed Claude
 * either seen to end or handed over more than QUEUE_GRACE_MS ago (Claude may
 * not have started it yet). One at a time, first in first out.
 *
 * @param {import("./guided.js").Wizard} w
 * @param {{ kind: string, data?: any }} status
 * @param {{ isWorking: boolean, now: number, sentAt: number }} at
 * @returns {import("./guided.js").QueuedCheck | null}
 */
export function nextQueued(w, status, at) {
  if (w.queue.length === 0 || w.queuePaused || at.isWorking || w.busy || awaitsYes(w) || status.kind !== "data") return null;
  const g = guidedOf(status, null);
  if (g && !isFinished(g)) return null;
  const seenToEnd = g !== null && str(g.planId) === w.planId;
  if (w.planId && !seenToEnd && at.now - at.sentAt < QUEUE_GRACE_MS) return null;
  return w.queue[0];
}

/**
 * What the panel does once the server built the queued check's plan: as any
 * saved check run again (Claude started on it, or its confirmation waiting on
 * the person where its care level needs one), unless the saved check no
 * longer has the care level it was queued with, which then does not start.
 *
 * The person stays where they are: a queued check's start never moves the
 * panel off the results or a card they are reading, and the results keep the
 * plan they were opened for. `started` names it, so the panel offers Follow it.
 *
 * @param {import("./guided.js").Wizard} w
 * @param {any} result scout_saved_checks' answer to `run`
 * @param {import("./guided.js").QueuedCheck} entry
 * @returns {{ wizard: import("./guided.js").Wizard, send?: string }}
 */
export function afterQueuedRun(w, result, entry) {
  const read = readSaved(result);
  const care = read.ok && isRecord(read.plan) && isRecord(read.plan.choices) ? str(read.plan.choices.care) : "";
  if (read.ok && read.plan && care !== entry.care) {
    const now = CARE_LABEL[/** @type {keyof typeof CARE_LABEL} */ (care)] ?? care;
    return {
      wizard: { ...w, saved: read.saved, busy: null, notice: { tone: "error", text: BAND_WORDS.careChanged(entry.name, now, CARE_LABEL[entry.care]) } },
    };
  }
  const after = afterSavedRun(w, result);
  if (after.wizard.planId === w.planId) return after;
  const waits = after.wizard.step === "confirm";
  return {
    ...after,
    wizard: { ...after.wizard, step: w.step, notice: null, fromQueue: waits ? entry.name : null, started: entry.name },
  };
}

/**
 * The band: the line and Open the panel, above whatever the rows beneath
 * drew (`below`, another mod's band or the engine's), which it keeps.
 *
 * @param {Record<string, Function>} els
 * @param {string} line
 * @param {unknown} below
 * @param {() => void} open
 */
export function renderBand(els, line, below, open) {
  const { Box, Text, Button } = els;
  const ours = Box({
    key: "guided-band",
    flexDirection: "row",
    columnGap: 2,
    children: [Text({ wrap: "truncate-end", children: [line] }), Button({ key: "guided-band-open", label: BAND_WORDS.open, onPress: open })],
  });
  return below ? Box({ flexDirection: "column", children: [ours, below] }) : ours;
}

// ---- Cost before and during a check (design 2.11) ----

/** Where the person's own earlier checks' use is kept in `$.store`: one list per person, not per project. */
export const COST_STORE_KEY = "checkCosts";
/** How many of the person's own checks the estimate needs before it stops using the stated default. */
export const COST_OWN_MIN = 3;
/** How many earlier checks are kept. */
export const COST_KEEP = 20;
/** The share of the cap at which the mod warns. */
export const COST_WARN_AT = 0.8;
/** The caps the person can choose, in each unit; none is the default. */
export const COST_CAPS = { percent: [10, 25, 50], usd: [1, 5, 20] };
/**
 * The stated default before the person has run three checks: what a check of
 * each thoroughness is assumed to use, said as a starting figure.
 */
export const COST_DEFAULT = {
  percent: { quick: 3, normal: 8, thorough: 20 },
  usd: { quick: 0.5, normal: 2, thorough: 6 },
};

/** How each rate-limit window is named; one this table does not know is "usage limit". */
export const WINDOW_NAME = { five_hour: "5-hour limit", seven_day: "weekly limit", spend_limit: "spend limit" };

/** A window's name, as the words say it. @param {string} kind */
export function windowName(kind) {
  return WINDOW_NAME[/** @type {keyof typeof WINDOW_NAME} */ (kind)] ?? "usage limit";
}

export const COST_WORDS = {
  capHeading: "Stop the check at",
  capOff: "No limit",
  cap: (/** @type {"percent" | "usd"} */ unit, /** @type {number} */ n, kind = "five_hour") =>
    unit === "percent" ? `${n}% of my ${windowName(kind)}` : `$${n} of usage`,
  estimate: (/** @type {"percent" | "usd"} */ unit, /** @type {string} */ label, /** @type {number} */ n, /** @type {number} */ own, kind = "five_hour") =>
    `A ${label} check ${own >= COST_OWN_MIN ? "usually uses" : "uses"} about ${unit === "percent" ? `${roundTo(n, 1)}% of your ${windowName(kind)}` : `$${roundTo(n, 2)} of usage`}${
      own >= COST_OWN_MIN ? `, from your last ${own} checks like it.` : `: a starting figure until you have run ${COST_OWN_MIN} checks like it.`
    }`,
  noFigures: "This Claude Code does not report usage, so no estimate or limit is offered.",
  toastWarn: (/** @type {string} */ used, /** @type {string} */ cap) =>
    `SceneScout: this check has used ${used} of the ${cap} you set. Claude will be asked to stop there.`,
  toastStop: (/** @type {string} */ cap) => `SceneScout: this check reached the ${cap} you set, so Claude was asked to stop and write what it has.`,
};

/**
 * What the configuring screen says before Start: the estimate for this
 * thoroughness, from the person's own checks or the stated default, and the
 * limits they may set, in the unit this Claude Code reports. Where it reports
 * no usage at all, it says so and offers no limit.
 *
 * @param {unknown} usage `$.session.usage()`'s answer, or null where it could not be read
 * @param {CostEntry[]} history
 * @param {string} thoroughness
 * @param {string} label the thoroughness as the panel names it
 * @returns {{ sentence: string, options: Array<{ value: number | null, label: string }> }}
 */
export function costOffer(usage, history, thoroughness, label) {
  const r = usageReading(usage);
  if (!r) return { sentence: COST_WORDS.noFigures, options: [] };
  const kind = r.unit === "percent" ? r.kind : "";
  const est = costEstimate(history, thoroughness, r.unit, kind);
  return {
    sentence: COST_WORDS.estimate(r.unit, label, est.amount, est.own, kind),
    options: [{ value: null, label: COST_WORDS.capOff }, ...COST_CAPS[r.unit].map((n) => ({ value: n, label: COST_WORDS.cap(r.unit, n, kind) }))],
  };
}

/** @param {number} n @param {number} places */
function roundTo(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * What a check is measured in, from `$.session.usage()` or a `session.measure`:
 * the 5-hour window where the account reports one (else its first window), in
 * percentage points; else, with no subscription windows, the session's cost in
 * dollars; else null, and nothing is estimated or capped.
 *
 * @param {unknown} usage
 * @returns {{ unit: "percent", kind: string, value: number } | { unit: "usd", value: number } | null}
 */
export function usageReading(usage) {
  if (!isRecord(usage)) return null;
  const windows = Array.isArray(usage.rateLimits) ? usage.rateLimits.filter((w) => isRecord(w) && str(w.kind) && Number.isFinite(w.percentUsed)) : [];
  const w = windows.find((x) => x.kind === "five_hour") ?? windows[0];
  if (w) return { unit: "percent", kind: str(w.kind), value: num(w.percentUsed) };
  if (isRecord(usage.cost) && Number.isFinite(usage.cost.usd)) return { unit: "usd", value: num(usage.cost.usd) };
  return null;
}

/** One earlier check: its unit, which window a share is of ("" for dollars), its thoroughness and what it used. @typedef {{ unit: "percent" | "usd", kind: string, thoroughness: string, used: number }} CostEntry */

/** The person's earlier checks as `$.store` holds them, anything misshapen left out, the newest COST_KEEP kept. @param {unknown} v @returns {CostEntry[]} */
export function costHistory(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e) => isRecord(e) && (e.unit === "percent" || e.unit === "usd") && typeof e.thoroughness === "string" && Number.isFinite(e.used) && e.used >= 0)
    .map((e) => ({
      unit: e.unit,
      kind: e.unit === "percent" ? (typeof e.kind === "string" && e.kind ? e.kind : "five_hour") : "",
      thoroughness: e.thoroughness,
      used: e.used,
    }))
    .slice(-COST_KEEP);
}

/**
 * The estimate before Start: the median of the person's own earlier checks of
 * this thoroughness in this unit once there are COST_OWN_MIN, else the stated
 * default. `own` is how many of their checks it is based on (0 for the default).
 *
 * @param {CostEntry[]} history
 * @param {string} thoroughness
 * @param {"percent" | "usd"} unit
 * @param {string} [kind] the window, for a share of one: a share of another window is not counted
 */
export function costEstimate(history, thoroughness, unit, kind = unit === "percent" ? "five_hour" : "") {
  const own = history.filter((e) => e.unit === unit && e.kind === kind && e.thoroughness === thoroughness).map((e) => e.used);
  if (own.length < COST_OWN_MIN) {
    const table = /** @type {Record<string, number>} */ (COST_DEFAULT[unit]);
    return { amount: table[thoroughness] ?? table.normal, own: 0 };
  }
  const sorted = [...own].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { amount: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, own: own.length };
}

/**
 * A check being measured: its plan, the unit and the reading when it started,
 * the cap the person chose (or none), what was used before a window reset, and
 * whether it was warned about or stopped.
 *
 * `kind` is the window a share is of ("" for dollars): a reading of another
 * window is never compared with it. `record` is whether what it used joins the
 * person's history (a re-check does not: it is no check of a thoroughness).
 *
 * @typedef {{ planId: string, unit: "percent" | "usd", kind: string, thoroughness: string, start: number, last: number, carried: number, cap: number | null, warned: boolean, stopped: boolean, record: boolean }} CostWatch
 */

/**
 * Start measuring a check from the reading now, or null where there is none.
 *
 * @param {string} planId
 * @param {unknown} usage
 * @param {number | null} cap
 * @param {string} thoroughness
 * @param {boolean} [record]
 * @returns {CostWatch | null}
 */
export function startCostWatch(planId, usage, cap, thoroughness, record = true) {
  const r = usageReading(usage);
  if (!r || !planId) return null;
  const allowed = /** @type {number[]} */ (COST_CAPS[r.unit]);
  return {
    planId,
    unit: r.unit,
    kind: r.unit === "percent" ? r.kind : "",
    thoroughness,
    start: r.value,
    last: r.value,
    carried: 0,
    cap: cap !== null && allowed.includes(cap) ? cap : null,
    warned: false,
    stopped: false,
    record,
  };
}

/** How much a watched check has used so far. @param {CostWatch} w */
export function costUsed(w) {
  return roundTo(w.carried + Math.max(0, w.last - w.start), 2);
}

/**
 * A reading in the unit a watched check started in: its window's share, or
 * the session's dollars. A check that started in dollars before the account's
 * first window reading stays in dollars, so its limit still holds once windows
 * appear. Null where the reading has no figure in that unit.
 *
 * @param {unknown} usage
 * @param {"percent" | "usd"} unit
 * @param {string} kind
 * @returns {number | null}
 */
function readingIn(usage, unit, kind) {
  if (!isRecord(usage)) return null;
  if (unit === "usd") return isRecord(usage.cost) && Number.isFinite(usage.cost.usd) ? num(usage.cost.usd) : null;
  const w = Array.isArray(usage.rateLimits) ? usage.rateLimits.find((x) => isRecord(x) && x.kind === kind && Number.isFinite(x.percentUsed)) : undefined;
  return w ? num(w.percentUsed) : null;
}

/**
 * A new reading for a watched check: what it has used (a window that reset
 * keeps what was used before it), and whether this reading crosses the warning
 * at COST_WARN_AT of the cap or the cap itself, each said once. A reading in
 * with no figure in the unit the check started in changes nothing.
 *
 * @param {CostWatch} w
 * @param {unknown} usage
 * @returns {{ watch: CostWatch, says: "warn" | "stop" | null }}
 */
export function costStep(w, usage) {
  const value = readingIn(usage, w.unit, w.kind);
  if (value === null) return { watch: w, says: null };
  const reset = value < w.last;
  const next = reset ? { ...w, carried: w.carried + Math.max(0, w.last - w.start), start: 0, last: value } : { ...w, last: value };
  if (next.cap === null) return { watch: next, says: null };
  const used = costUsed(next);
  if (used >= next.cap && !next.stopped) return { watch: { ...next, warned: true, stopped: true }, says: "stop" };
  if (used >= next.cap * COST_WARN_AT && !next.warned) return { watch: { ...next, warned: true }, says: "warn" };
  return { watch: next, says: null };
}

/** An amount as the toasts say it: in full ("25% of your 5-hour limit"), or `short` for what was used ("20%"). @param {CostWatch} w @param {number} n */
export function costAmount(w, n, short = false) {
  if (w.unit === "usd") return `$${roundTo(n, 2)}`;
  return short ? `${roundTo(n, 1)}%` : `${roundTo(n, 1)}% of your ${windowName(w.kind)}`;
}

// ---- Watched tickets (design 2.6) ----

/** How often the mod asks the server for the filed tickets' state; the server reads each tracker at most this often anyway. */
export const TICKET_POLL_MS = 5 * 60_000;
export const TICKET_STATUS_TOOL = "scout_ticket_status";

export const TICKET_WORDS = {
  band: (/** @type {string[]} */ refs) => `SceneScout · open tickets: ${refs.join(", ")}`,
  toastClosed: (/** @type {string} */ ref, /** @type {string} */ title) => `SceneScout: ticket ${ref} "${title}" was closed. Check it again from the panel.`,
  toastFixed: (/** @type {string} */ ref, /** @type {string} */ title) => `SceneScout: fixed and confirmed: ${ref} "${title}" is gone on a re-check.`,
};

/** @typedef {{ id: string, title: string, where: string, ref: string, url: string, open: boolean, finding: "open" | "resolved" | "unknown" }} Ticket */

/**
 * Whether the watch asks the server for the filed tickets on this tick: once
 * when asked (Claude Code opened, a ticket was filed, a check ended), and then
 * only while one of them is open. With none filed, or no tracker the server
 * can read, the first reading has no open ticket and the watch stops there.
 *
 * @param {Ticket[] | null} tickets the last reading
 * @param {boolean} asked
 */
export function ticketsDue(tickets, asked) {
  return asked || (tickets ?? []).some((t) => t.open);
}

/**
 * A new reading's tickets, with the ones of any place it could not read kept
 * from the reading before: a tracker that timed out is not every ticket there
 * closed. A reading with no problems is taken as it is.
 *
 * @param {Ticket[] | null} before
 * @param {Ticket[]} after
 * @param {readonly string[]} problems
 * @returns {Ticket[]}
 */
export function mergeTickets(before, after, problems) {
  if (!problems.length || !before) return after;
  const read = new Set(after.map((t) => t.where));
  return [...after, ...before.filter((t) => !read.has(t.where))];
}

/** Claude filing tickets through SceneScout, by whatever name its server was registered under. */
const TICKET_FILE_CALL = /^mcp__.+__scout_ticket_file$/;

/** Whether a tool call is Claude filing tickets through SceneScout. @param {{ tool?: unknown }} call */
export function filesTickets(call) {
  return typeof call.tool === "string" && TICKET_FILE_CALL.test(call.tool);
}

/** The tickets scout_ticket_status answered, or null when it did not. @param {any} result @returns {Ticket[] | null} */
export function readTicketStatus(result) {
  const s = isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : null;
  if (!s || result.isError === true || !Array.isArray(s.tickets)) return null;
  return s.tickets
    .filter((t) => isRecord(t) && str(t.id) && str(t.ref))
    .map((t) => ({
      id: str(t.id),
      title: plainLine(str(t.title)).slice(0, 200),
      where: plainLine(str(t.where)),
      ref: plainLine(str(t.ref)).slice(0, 40),
      url: str(t.url),
      open: t.open === true,
      finding: /** @type {"open" | "resolved" | "unknown"} */ (t.finding === "open" || t.finding === "resolved" ? t.finding : "unknown"),
    }));
}

/**
 * The toasts a new reading of the tickets owes the person: a ticket that was
 * open and is now closed, and one whose problem a re-check found gone. A first
 * reading (nothing before) owes none, so opening Claude Code does not replay
 * what happened while it was closed as news.
 *
 * @param {Ticket[] | null} before
 * @param {Ticket[]} after
 * @returns {string[]}
 */
export function ticketToasts(before, after) {
  if (!before) return [];
  const out = [];
  for (const t of after) {
    const was = before.find((b) => b.where === t.where && b.ref === t.ref);
    if (!was) continue;
    // Only a re-check that found the problem gone is "fixed": a finding the project no longer keeps is not.
    if (was.finding === "open" && t.finding === "resolved") out.push(TICKET_WORDS.toastFixed(t.ref, t.title));
    else if (was.open && !t.open) out.push(TICKET_WORDS.toastClosed(t.ref, t.title));
  }
  return out;
}

/** The band's line for the open tickets, or null with none open. @param {Ticket[] | null} tickets */
export function ticketBand(tickets) {
  const open = (tickets ?? []).filter((t) => t.open).map((t) => t.ref);
  return open.length ? TICKET_WORDS.band(open.length > 5 ? [...open.slice(0, 5), `${open.length - 5} more`] : open) : null;
}
