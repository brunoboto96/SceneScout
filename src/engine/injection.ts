/**
 * The DOM-injection oracle's rules: what a typed value has to look like to be
 * worth watching for, how to look for it on a later page, and how to describe
 * it when it turns up as an element.
 *
 * The engine never tells the agent what to type. It only remembers the shape
 * of any markup-shaped value the agent chose to type, and checks every page it
 * sees afterwards for an element of that shape. A value that comes back as an
 * element rather than text means whoever opens that page runs the input:
 * stored or reflected injection (XSS).
 *
 * An element counts as the typed one only when it carries exactly the
 * payload's attributes (an app's own link has extras such as a testid; an
 * injected one has just what was typed) and, when the payload had text, that
 * text. A payload with neither is not watched: `<script>` or `<br>` on their
 * own would match any page. No browser is needed for these rules, so they are
 * table-tested; the one DOM query lives in browser.ts.
 */
import { normalizePath } from "./fingerprint.js";

/** A markup-shaped value the agent typed, reduced to what identifies the element it would become. */
export interface InjectionProbe {
  /** The value as typed, for the report. */
  payload: string;
  tag: string;
  attrs: Array<[string, string]>;
  /** The element's text, when the payload had any; compared on its first INJECTION_TEXT_MAX characters. */
  text: string | null;
  /** A CSS selector for candidates; the exact-attribute and text rules are applied to each. */
  selector: string;
  /** The field it was typed into, as the agent saw it. */
  field: string;
  /** The page it was typed on. */
  typedOn: string;
  /** How many such elements the page held before the value was typed: shared chrome is not an injection. */
  baseline: number;
}

/** Most probes a session keeps. Every page is checked for each in one query, so the list can be generous: a fuzzing pass types many. */
export const MAX_PROBES = 60;
/** Text is compared on this many characters, on both sides, so a long fuzz value still matches its element. */
export const INJECTION_TEXT_MAX = 200;
/** Most matching elements reported per probe per page. */
export const MAX_HITS = 20;

const OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)/;
// One attribute at a time, anchored where the last one ended: a slash between
// attributes is the same as a space to a browser (`<svg/onload=…>`). Each
// match consumes at least one character, so a hostile value cannot make the
// parse backtrack.
const ATTR_RE = /[\s/]*([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
const CLOSE_RE = /[\s/]*>/y;
/** Values longer than this are cut before parsing; no payload needs more. */
const MAX_VALUE_LENGTH = 2000;

/** Attribute names that can go into a selector as they are. Anything else is dropped rather than escaped. */
const ATTR_NAME_RE = /^[A-Za-z_][-A-Za-z0-9_]*$/;

function cssValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ").replace(/\r/g, "\\d ");
}

function routeOf(url: string): string {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return url || "?";
  }
}

/** The shape of a typed value, without the page-dependent baseline. */
export type ProbeShape = Omit<InjectionProbe, "field" | "typedOn" | "baseline">;

/**
 * The shape for a typed value, or null when the value holds no element worth
 * watching: plain text, an email, a URL, a stray `<`, and an element with
 * nothing to tell it apart by (`<script>`, `<br>`) are none of the oracle's
 * business.
 */
export function probeShape(raw: string): ProbeShape | null {
  const value = raw.slice(0, MAX_VALUE_LENGTH);
  const open = OPEN_RE.exec(value);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const attrs: Array<[string, string]> = [];
  let pos = open.index + open[0].length;
  for (;;) {
    CLOSE_RE.lastIndex = pos;
    const close = CLOSE_RE.exec(value);
    if (close) {
      pos += close[0].length;
      break;
    }
    ATTR_RE.lastIndex = pos;
    const a = ATTR_RE.exec(value);
    // Neither an attribute nor the end of the tag: not an element, just a "<".
    if (!a) return null;
    pos += a[0].length;
    const name = a[1].toLowerCase();
    if (!ATTR_NAME_RE.test(name)) continue;
    attrs.push([name, a[2] ?? a[3] ?? a[4] ?? ""]);
  }
  const rest = value.slice(pos);
  const close = rest.toLowerCase().indexOf(`</${tag}`);
  const inner = (close >= 0 ? rest.slice(0, close) : rest).trim();
  const text = inner ? inner.slice(0, INJECTION_TEXT_MAX) : null;
  if (attrs.length === 0 && text === null) return null;
  return {
    payload: value.slice(0, 200),
    tag,
    attrs,
    text,
    selector: tag + attrs.map(([name, v]) => `[${name}="${cssValue(v)}"]`).join(""),
  };
}

export function injectionProbe(value: string, field: string, typedOn: string, baseline = 0): InjectionProbe | null {
  const shape = probeShape(value);
  return shape ? { ...shape, field, typedOn, baseline } : null;
}

/**
 * The session's probe list with one more: a payload already on it is kept as
 * first seen (its baseline came from where it was first typed), and past the
 * cap the oldest goes. Returns the list to keep, so the rule is testable.
 */
export function rememberProbe(probes: readonly InjectionProbe[], probe: InjectionProbe): InjectionProbe[] {
  if (probes.some((p) => p.payload === probe.payload)) return [...probes];
  const kept = probes.length >= MAX_PROBES ? probes.slice(probes.length - MAX_PROBES + 1) : [...probes];
  return [...kept, probe];
}

/** What the page is asked for each probe: candidates by selector, then the exact-attribute and text rules. */
export interface ProbeQuery {
  selector: string;
  attrs: Array<[string, string]>;
  text: string | null;
}

export function probeQueries(probes: readonly InjectionProbe[]): ProbeQuery[] {
  return probes.map((p) => ({ selector: p.selector, attrs: p.attrs, text: p.text }));
}

/**
 * The script the page runs to find matching elements: the same rules as
 * matchesElement, applied in the page so the cap counts matches, not
 * candidates. Returns [{ index, outer }] with at most MAX_HITS per probe.
 */
export function probeScript(queries: readonly ProbeQuery[]): string {
  return (
    `(() => { const queries = ${JSON.stringify(queries)}; const max = ${MAX_HITS}; const textMax = ${INJECTION_TEXT_MAX}; const out = []; ` +
    `queries.forEach((q, index) => { let els; try { els = document.querySelectorAll(q.selector); } catch { return; } let n = 0; ` +
    `for (const el of els) { if (n >= max) break; if (el.attributes.length !== q.attrs.length) continue; ` +
    `if (!q.attrs.every(([name, value]) => el.getAttribute(name) === value)) continue; ` +
    `if (q.text !== null && (el.textContent || '').trim().slice(0, textMax) !== q.text) continue; ` +
    `out.push({ index, outer: el.outerHTML.slice(0, 200) }); n += 1; } }); return out; })()`
  );
}

/** The rule the script applies, in one place a test can reach. */
export function matchesElement(query: ProbeQuery, el: { attrs: Record<string, string>; text: string }): boolean {
  if (Object.keys(el.attrs).length !== query.attrs.length) return false;
  if (!query.attrs.every(([name, value]) => el.attrs[name] === value)) return false;
  return query.text === null || el.text.trim().slice(0, INJECTION_TEXT_MAX) === query.text;
}

export interface RawHit {
  index: number;
  outer: string;
}

export interface Injection {
  probe: InjectionProbe;
  outer: string;
  /** One report per payload per route, so a page is not reported on every snapshot. */
  key: string;
}

/**
 * Which hits on a page are injections to report: more matching elements than
 * the page the value was typed on already held (shared chrome such as a nav
 * link is the same on every page), and not reported for this route before.
 */
export function newInjections(probes: readonly InjectionProbe[], hits: readonly RawHit[], url: string, reported: Set<string>): Injection[] {
  const out: Injection[] = [];
  const route = routeOf(url);
  probes.forEach((probe, index) => {
    const mine = hits.filter((h) => h.index === index);
    if (mine.length <= probe.baseline) return;
    const key = `${probe.payload}|${route}`;
    if (reported.has(key)) return;
    reported.add(key);
    out.push({ probe, outer: mine[mine.length - 1]?.outer ?? "", key });
  });
  return out;
}

/**
 * The violation's detail: what it became, where it fired, and where it was
 * typed. The element comes first because the oracle log signs a violation on
 * the first characters of its detail: two payloads that fired on one page
 * must not read as one.
 */
export function describeInjection(probe: InjectionProbe, url: string, outerHtml: string): string {
  return (
    `${outerHtml.slice(0, 160)} on ${routeOf(url)} is a value typed into ${probe.field} on ${routeOf(probe.typedOn)}, come back as markup — ` +
    `whoever opens this page runs what was typed there (stored or reflected injection, XSS)`
  );
}
