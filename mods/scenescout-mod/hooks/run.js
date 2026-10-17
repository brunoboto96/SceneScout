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
import { CARE_LABEL, afterSavedRun, guidedOf, readSaved } from "./guided.js";

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
  confirmNext: (/** @type {string} */ name) => `SceneScout: "${name}" is next, and waits for your yes in the panel before it starts.`,
  careChanged: (/** @type {string} */ name, /** @type {string} */ now, /** @type {string} */ then) =>
    `"${name}" now uses "${now}", not "${then}" as when you queued it, so it did not start. Press Run again on the welcome to start it.`,
  toastConfirm: (/** @type {string} */ name) => `SceneScout: your next check, "${name}", needs your yes before it starts.`,
  toastNotStarted: (/** @type {string} */ name, /** @type {string} */ why) => `SceneScout: the queued check "${name}" did not start. ${why}`,
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

/**
 * C0 and C1 control characters, DEL, and the bidirectional overrides: what a
 * terminal would read as a code rather than draw. A step's words can quote
 * the tested page, so the band and the status line never carry them.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/** A line as plain text: each run of control characters a space, and the spaces it leaves collapsed. */
export function plainLine(/** @type {string} */ line) {
  return line.replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();
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
 * the checks waiting to start.
 *
 * @param {import("./guided.js").Wizard} w
 * @param {{ kind: string, data?: any }} status
 * @returns {string | null}
 */
export function bandLine(w, status) {
  const line = bandWords(w, status);
  return line === null ? null : plainLine(line);
}

/** The band's line before it is made plain. @param {import("./guided.js").Wizard} w @param {{ kind: string, data?: any }} status */
function bandWords(w, status) {
  if (w.step === "confirm" && w.fromQueue) return BAND_WORDS.confirmNext(w.fromQueue);
  const g = guidedOf(status, null);
  if (g && !isFinished(g)) {
    if (isRecord(g.needsYou) && str(g.needsYou.sentence)) return BAND_WORDS.needsYou(str(g.needsYou.sentence));
    const parts = [BAND_WORDS.now(str(g.now)), problemCount(g.problems)];
    if (w.queue.length) parts.push(BAND_WORDS.queued(w.queue.length));
    return parts.join(" · ");
  }
  if (w.queue.length) return BAND_WORDS.waiting(w.queue.length, w.queue[0].name);
  return null;
}

/**
 * The status line: the band's line, cut to STATUS_MAX characters, or
 * undefined, which clears it.
 *
 * @param {import("./guided.js").Wizard} w
 * @param {{ kind: string, data?: any }} status
 * @returns {string | undefined}
 */
export function statusLine(w, status) {
  const line = bandLine(w, status);
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
  if (w.step === "confirm") return false;
  if (w.queue.length > 0) return true;
  const handed = w.step === "running" && w.planId !== null && !(g && str(g.planId) === w.planId);
  return handed && at.now - at.sentAt < HANDED_WAIT_MS;
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
  if (w.queue.length === 0 || at.isWorking || w.busy || w.step === "confirm" || status.kind !== "data") return null;
  const g = guidedOf(status, null);
  if (g && !isFinished(g)) return null;
  const seenToEnd = g !== null && str(g.planId) === w.planId;
  if (w.planId && !seenToEnd && at.now - at.sentAt < QUEUE_GRACE_MS) return null;
  return w.queue[0];
}

/**
 * What the panel does once the server built the queued check's plan: as any
 * saved check run again (its confirmation previewed where its care level
 * needs one, else Claude started on it), unless the saved check no longer
 * has the care level it was queued with, which then does not start.
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
      wizard: {
        ...w,
        saved: read.saved,
        busy: null,
        step: "welcome",
        notice: { tone: "error", text: BAND_WORDS.careChanged(entry.name, now, CARE_LABEL[entry.care]) },
      },
    };
  }
  const after = afterSavedRun(w, result);
  return { ...after, wizard: { ...after.wizard, fromQueue: after.wizard.step === "confirm" ? entry.name : null } };
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
