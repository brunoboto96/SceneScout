/**
 * How the snapshot reads the collector's elements: unnamed controls, state
 * markers, flags and evidence lines, the summary of what was cut past the
 * cap, and which element of the previous snapshot each one is.
 */

import type { NameFrom } from "./page-sources.js";

/**
 * Roles that announce content rather than take input: a live region is empty
 * until it has something to say, and ARIA does not require it to have a name.
 * Reporting an empty status line as an unnamed control sent lanes to file it
 * as an accessibility defect — twice in one measured run.
 */
const LIVE_REGION_ROLES = new Set(["status", "alert", "log", "timer", "marquee"]);

/**
 * Whether an element is an unnamed control, as opposed to a live region with
 * nothing in it yet. A field whose shown name is only its name attribute or
 * type is unnamed too: the collector fills those in so the field can be
 * targeted, but nothing announces them.
 */
export function missingName(el: { role: string; name: string; nameFrom?: NameFrom | null; interactive?: boolean; ariaHidden?: boolean }): boolean {
  // Listed for its test id or its text, not a control: a decorative badge, a
  // page wrapper. Absent on elements collected before the collector said.
  if (el.interactive === false) return false;
  // Hidden from assistive technology on purpose: nothing announces it, so it needs no name.
  if (el.ariaHidden) return false;
  if (el.nameFrom === "fallback") return true;
  return !el.name && !LIVE_REGION_ROLES.has(el.role);
}

/** An element's ARIA state as the collector reads it: each attribute's value, or null when absent. */
export interface ElementState {
  pressed?: string | null;
  selected?: string | null;
  /** A native checkbox or radio's checked property ("true"/"false"), else aria-checked. */
  checked?: string | null;
  expanded?: string | null;
  current?: string | null;
}

/**
 * The snapshot's state markers: which filter is active, which tab is chosen,
 * which box is ticked, which section is open. Only states that are on are
 * shown, so a page of plain buttons stays as short as it was.
 */
export function stateFlags(state: ElementState | undefined): string[] {
  if (!state) return [];
  const flags: string[] = [];
  if (state.pressed === "true") flags.push("pressed");
  else if (state.pressed === "mixed") flags.push("partly pressed");
  if (state.selected === "true") flags.push("selected");
  if (state.checked === "true") flags.push("checked");
  else if (state.checked === "mixed") flags.push("partly checked");
  if (state.expanded === "true") flags.push("expanded");
  if (state.current && state.current !== "false") flags.push("current");
  return flags;
}

/**
 * How the snapshot diff says an element's state moved: what it gained, then
 * what it lost. Null when the state is the same.
 */
export function stateChange(was: readonly string[], now: readonly string[]): string | null {
  const gained = now.filter((f) => !was.includes(f));
  const lost = was.filter((f) => !now.includes(f));
  if (gained.length === 0 && lost.length === 0) return null;
  return [gained.length ? `now [${gained.join(", ")}]` : null, lost.length ? `no longer [${lost.join(", ")}]` : null].filter(Boolean).join(", ");
}

/**
 * The elements a state's identity and coverage are kept over: all but the
 * live regions listed only for what they say. Their text changes with every
 * message, so in a fingerprint they would make each message a new state, and
 * nothing in them can be exercised.
 */
export function trackedElements<T extends { liveOnly?: boolean }>(elements: readonly T[]): T[] {
  return elements.filter((el) => !el.liveOnly);
}

/**
 * Keys of tracked elements a user cannot act on: listed for their test id (a
 * wrapper, a heading, a badge). Coverage leaves them out of what there is to
 * exercise, or the denominator counts page structure as untested controls.
 */
export function inertKeys(elements: ReadonlyArray<{ key: string; interactive?: boolean; liveOnly?: boolean }>): string[] {
  return elements.filter((el) => !el.liveOnly && el.interactive === false).map((el) => el.key);
}

/**
 * Whether a field's only label is its placeholder. Kept apart from missingName
 * because browsers do announce a placeholder when nothing else names the
 * field, so it is not nameless; but the text is gone as soon as the user
 * types, and it was never a label. The shown name must be non-empty: a blank
 * aria-label ends the name before the placeholder is reached, so that field is
 * unnamed (missingName) and only that.
 */
export function placeholderOnly(el: { name: string; nameFrom?: NameFrom | null }): boolean {
  return el.nameFrom === "placeholder" && !!el.name;
}

/** How a crawl names a control in the check's evidence: by role and test id, or role and XPath. */
export function describeControl(el: { role: string; testid: string | null; xpath: string }): string {
  return `${el.role}${el.testid ? ` [testid=${el.testid}]` : ` at ${el.xpath}`}`;
}

/**
 * The element on top of a control at the point a click aims at, as the page
 * reported it just before a forced click (browser.ts readCoverAt): its role
 * (explicit, else implied by its tag), tag, visible text and test id.
 */
export interface CoverFacts {
  role: string | null;
  tag: string;
  text: string;
  testid: string | null;
}

/**
 * What a forced click's note says about the element on top of its target:
 * `covered by status "Could not save…" [testid=toast-error]`. With
 * `afterBlock`, the write policy refused a request after the tester last
 * looked at the page, so the covering element may be the app's response to
 * the engine's own refusal (an error toast) and in no snapshot.
 */
export function describeCover(cover: CoverFacts, afterBlock: boolean): string {
  const text = cover.text.replace(/\s+/g, " ").trim();
  const shown = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  const who = cover.role ?? `<${cover.tag}>`;
  return (
    `covered by ${who}${shown ? ` ${JSON.stringify(shown)}` : ""}${cover.testid ? ` [testid=${cover.testid}]` : ""}` +
    (afterBlock ? " (after a write-policy block since the last snapshot: it may be the app's response to the engine's own refusal)" : "")
  );
}

/** A placeholder-only field's evidence: the control, then its placeholder, capped so a paragraph of hint text stays one line. */
export function placeholderEvidence(el: { role: string; testid: string | null; xpath: string; name: string }): string {
  const text = el.name.length > 80 ? `${el.name.slice(0, 79)}…` : el.name;
  return `${describeControl(el)} "${text}"`;
}

/** The snapshot's flag for a field with no label, or null when it has one. */
export function labelFlag(el: { name: string; nameFrom?: NameFrom | null }): string | null {
  if (placeholderOnly(el)) return "no label: placeholder only";
  if (el.nameFrom) return "no label";
  return null;
}

/** How the snapshot shows an element's name: an empty live region says so rather than reading as an unnamed control. */
export function displayName(el: { role: string; name: string }): string {
  if (el.name) return el.name;
  return LIVE_REGION_ROLES.has(el.role) ? "(empty live region)" : "(unnamed)";
}

/** What alone makes an element that is neither a native control nor in a control role actionable (the collector's affordancesOf). */
export interface Affordances {
  /** tabindex 0 or more. */
  tabStop: boolean;
  /** An onclick attribute or property. Listeners added with addEventListener cannot be seen from the page. */
  clickHandler: boolean;
  /** A pointer cursor it sets itself, not one inherited from a clickable parent. */
  pointer: boolean;
}

/**
 * The snapshot's flags for an element listed without a control's role that a
 * user can still act on: "clickable" for a click handler or its own pointer
 * cursor, "focusable" for a tab stop. A row a click opens then reads apart
 * from a wrapper listed only for its test id, which gets neither.
 */
export function affordanceFlags(el: { affords?: Affordances | null }): string[] {
  const a = el.affords;
  if (!a) return [];
  const flags: string[] = [];
  if (a.clickHandler || a.pointer) flags.push("clickable");
  if (a.tabStop) flags.push("focusable");
  return flags;
}

/** What the collector reports of an element past its cap: its role and test id, or that the count stopped. */
export interface CutElement {
  role?: string;
  testid?: string | null;
  uncounted?: boolean;
}

/**
 * A test id as a family: a trailing number or id after a separator becomes
 * "*", so "row-12" and "row-13" read as "row-*" while "pager-next" stays itself.
 */
export function testidFamily(testid: string): string {
  return testid.replace(/([-_.:])(?:\d+|[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}|[0-9a-f]{12,})$/i, "$1*");
}

/**
 * What a truncated snapshot left out, by role and test-id family, largest
 * group first: "38 link [row-*], 1 button [pager-next], 12 generic". At most
 * `groups` groups are named; the rest is counted together. "and more past
 * those, not counted" when the collector stopped looking.
 */
export function cutSummary(cut: readonly CutElement[], groups = 8): string {
  const counts = new Map<string, number>();
  let uncounted = false;
  for (const c of cut) {
    if (c.uncounted) {
      uncounted = true;
      continue;
    }
    const label = `${c.role ?? "element"}${c.testid ? ` [${testidFamily(c.testid)}]` : ""}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const named = sorted.slice(0, groups).map(([label, n]) => `${n} ${label}`);
  const rest = sorted.slice(groups).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) named.push(`${rest} other`);
  if (uncounted) named.push("and more past those, not counted");
  return named.join(", ");
}

/** A key without the ordinal the collector adds to the second and later elements sharing it ("tid:row~3" → "tid:row"). */
function keyFamily(key: string): string {
  return key.replace(/~\d+$/, "");
}

/**
 * Which element of the previous snapshot each current element is, as that
 * snapshot's key, or null for an element new since. Gives the ref an element
 * keeps, and what the diff calls added, removed or changed.
 *
 * An element alone under its key is the one that held the key before, so its
 * new text reads as a relabel. Elements sharing a key (rows tagged with one
 * test id) are told apart by their own text and href, not their position: a
 * filtered list then reads as the rows it lost and gained, where by position
 * the first row "became" another record. A row that kept its link but changed
 * its text is still matched by the link. `byPosition` keeps the position for
 * elements whose text is meant to change, such as live regions.
 */
export function matchPrevious(
  prev: ReadonlyMap<string, { label: string; href?: string | null }>,
  current: ReadonlyArray<{ key: string; name: string; href?: string | null; byPosition?: boolean }>,
): Array<string | null> {
  const prevByFamily = new Map<string, string[]>();
  for (const key of prev.keys()) {
    const fam = keyFamily(key);
    const list = prevByFamily.get(fam);
    if (list) list.push(key);
    else prevByFamily.set(fam, [key]);
  }
  const curByFamily = new Map<string, number[]>();
  current.forEach((el, i) => {
    const fam = keyFamily(el.key);
    const list = curByFamily.get(fam);
    if (list) list.push(i);
    else curByFamily.set(fam, [i]);
  });
  const out: Array<string | null> = current.map(() => null);
  for (const [fam, idxs] of curByFamily) {
    const prevKeys = prevByFamily.get(fam) ?? [];
    const single = prevKeys.length <= 1 && idxs.length <= 1;
    if (single || idxs.some((i) => current[i].byPosition)) {
      for (const i of idxs) out[i] = prev.has(current[i].key) ? current[i].key : null;
      continue;
    }
    const free = new Set(prevKeys);
    const take = (i: number, same: (p: { label: string; href?: string | null }) => boolean): void => {
      for (const k of free) {
        if (same(prev.get(k)!)) {
          out[i] = k;
          free.delete(k);
          return;
        }
      }
    };
    for (const i of idxs) take(i, (p) => p.label === current[i].name && (p.href ?? null) === (current[i].href ?? null));
    for (const i of idxs) if (out[i] === null && current[i].href) take(i, (p) => !!p.href && p.href === current[i].href);
  }
  return out;
}
