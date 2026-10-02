/**
 * Forms never submitted empty.
 *
 * The commonest defect behind a form is a submit that silently does nothing
 * when its required fields are blank: no request, no message. The engine
 * already notes a submit-style click that fires no request, but only when
 * somebody tries the empty submit, and lanes that fill a form in and submit
 * it rarely do. So scout_coverage lists every form a session saw that no
 * session has yet submitted empty.
 *
 * THE DEFINITION. A form is a `<form>` element. Its controls are the ones the
 * browser associates with it (`form.elements`), so a submit button outside
 * the element linked back by `form="id"` is one of them. It is tracked when it
 * has a native submit control (a `<button>` with no type or type="submit", an
 * `<input type="submit|image">`) and at least one TEXT-ENTRY field.
 *
 * IDENTITY (formIdentity), per route, first match wins:
 *   1. the form's own `id` attribute         → `form:#signup`
 *   2. its `name` attribute                  → `form:name=pay`
 *   3. its `action` attribute with its method → `form:POST /things`
 *   4. only when it has none of those, the coverage key the snapshot gives its
 *      first submit control (`tid:thing-save`, `button:save`).
 * The form's own attributes come first because a submit control's key is the
 * weakest name it has: an untagged "Save" in two tab panels is the same key
 * for two forms, and a label that changes ("Pay $12", "Saving…") is a new key
 * for the same one. Attributes are read with getAttribute, never `form.id` or
 * `form.name`, which a field named "id" or "name" shadows.
 *
 * Only the inventory (a snapshot, a crawl, a plan's capture) puts a form on
 * the list. A submit only marks a listed form; one that cannot be matched to
 * a listed form is logged (FORMS_SUBMIT_UNMATCHED), never guessed.
 *
 * A text-entry field is a `<textarea>`, or an `<input>` whose type takes typed
 * text (TEXT_ENTRY_TYPES), that is visible, not disabled (itself or by a
 * disabled fieldset) and not read-only. Checkboxes, radios, selects, file,
 * hidden, search, range and colour inputs are not: none of them can be "left
 * blank" by typing, and a search box's empty submit is a filter, not the
 * defect this looks for.
 *
 * A form counts as SUBMITTED EMPTY when a submit happened while every one of
 * its text-entry fields held the empty string (whitespace is content: that is
 * a separate boundary probe). A submit is a click on one of its native submit
 * controls, or Enter where the browser's implicit submission applies: in one
 * of its text-like inputs (IMPLICIT_SUBMIT_TYPES) while its default button is
 * enabled, or on a focused submit control. It counts whether the click or key
 * came from scout_click, scout_type's pressEnter, scout_press or a plan step.
 * A form with no text-entry field is never listed, and neither is one whose
 * every submit control is disabled while its fields are blank: the page
 * already refuses the empty submit, and nothing could clear the entry.
 *
 * WHY ONLY `<form>`. A "form-like group" of loose fields and buttons had to be
 * guessed from layout and button labels. The guess listed page chrome (a
 * header search box beside "Sign in", under an app root that held every
 * row's "Add" button) and walked the whole document once per button. A real
 * form is the one grouping the browser itself submits, so it is exact and
 * cheap (`document.forms`).
 *
 * NOT CAUGHT, by design of the above:
 *   - fields and a save button with no `<form>` around them (a JS-driven panel);
 *   - forms whose only submit control is a `role="button"` element, or a
 *     `<button type="button">` wired up in script;
 *   - forms that submit from script on change (`form.submit()` in a handler);
 *   - Ctrl+Enter or Cmd+Enter in a textarea, which some apps treat as send.
 * And kept apart imperfectly, by design of IDENTITY:
 *   - forms with no id or name that share an action and method are one entry,
 *     so an empty submit of one clears them all;
 *   - forms with no id, name or action whose first submit controls are the
 *     same untagged button ("Save") are one entry too;
 *   - on a page with more controls than a snapshot lists (150), a form with
 *     none of those attributes whose submit control is past the cap is not
 *     tracked at all.
 *
 * The page reports facts; the rule deciding what they mean lives here as pure
 * functions, so it is table-tested (memory-test) without a browser.
 */
import { ACCESSIBLE_NAME_SRC, VISIBLE_SRC, XPATH_OF_SRC } from "./collector.js";
import { normalizePath } from "./fingerprint.js";

/**
 * Action-log entries this bookkeeping writes. They record what the engine
 * could not do, not a step anyone took on the page: pace.ts does not count
 * them as actions and a finding's repro trace leaves them out.
 */
export const FORMS_READ_FAILED = "forms:read-failed";
export const FORMS_SUBMIT_UNMATCHED = "forms:submit-unmatched";

/** Whether an action-log entry is this bookkeeping rather than a step. */
export function isFormBookkeeping(action: string): boolean {
  return action === FORMS_READ_FAILED || action === FORMS_SUBMIT_UNMATCHED;
}

/** A form's own identifying attributes, as the page reports them (empty when absent). */
export interface FormAttrs {
  id: string;
  name: string;
  action: string;
  method: string;
}

/** The form's identity from its own attributes, or null when it has none (see IDENTITY above). */
export function formIdentity(attrs: FormAttrs): string | null {
  const id = attrs.id.trim();
  if (id) return `form:#${id.slice(0, 80)}`;
  const name = attrs.name.trim();
  if (name) return `form:name=${name.slice(0, 80)}`;
  // Normalized as a route is: a record id or a per-load token in the action
  // would otherwise name a new form on every record or every load.
  const action = attrs.action.trim();
  if (action) return `form:${(attrs.method.trim() || "get").toUpperCase()} ${normalizePath(action).slice(0, 120)}`;
  return null;
}

/**
 * Whether a snapshot element is the submit control the probe found. An xpath
 * alone is not enough: a sibling added or removed since the snapshot makes the
 * same path name another button (a "Cancel" where "Send" was). The testid and
 * the accessible name, computed by the collector's own rule, must agree too.
 */
export function sameControl(el: { testid: string | null; name: string }, probe: { submitTestid: string | null; submitName: string }): boolean {
  return (el.testid ?? null) === (probe.submitTestid ?? null) && el.name === probe.submitName;
}

/** Input types that take typed text. `search` is left out on purpose (see above). */
export const TEXT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "text",
  "email",
  "number",
  "tel",
  "url",
  "password",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

/**
 * Text-entry types an app commonly fills in itself before anyone types (a
 * date or time set to now). Left at that value, such a field counts as
 * blank for the empty submit (FieldFacts.filled). Free text is not here: a
 * pre-filled text field is an edit form holding its record.
 */
export const APP_FILLED_TYPES: ReadonlySet<string> = new Set(["date", "datetime-local", "month", "week", "time"]);

/**
 * Input types in which Enter submits the form (the HTML standard's implicit
 * submission). Not checkboxes, radios or buttons: Enter does nothing there.
 */
export const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([...TEXT_ENTRY_TYPES, "search"]);

/** What the page says about one field of a form. */
export interface FieldFacts {
  tag: string;
  /** The field's normalized type (`input.type`, lower case); empty for a textarea or select. */
  type: string;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  /**
   * Whether it holds something the session put there: a value other than the
   * empty string and, for a date or time field (APP_FILLED_TYPES), other than
   * the one the app gave it before anyone typed (recorded when the inventory
   * first read the field). A date the app pre-fills with today is the app's
   * value, so a submit that leaves it alone and every other field blank is
   * still the empty submit. A pre-filled text field counts as filled, and a
   * field the inventory never read is judged on its value alone.
   */
  filled: boolean;
}

/** One form as the inventory reads it. */
export interface FormFacts {
  /** The form's own identifying attributes: its identity when it has any. */
  attrs: FormAttrs;
  /** The collector's xpath of the form's first submit control: its identity when the form has no attributes. */
  submit: string;
  /** Its fields' facts, each distinct set once (repeats change no rule here). */
  fields: FieldFacts[];
  /** Whether every one of its submit controls is disabled right now. */
  submitDisabled: boolean;
}

/** What the page says about the form an action touched. */
export interface FormProbe {
  attrs: FormAttrs;
  /** The collector's xpath of the form's first submit control. */
  submit: string;
  /** That control's testid and accessible name (the collector's rule), to check a snapshot element really is it. */
  submitTestid: string | null;
  submitName: string;
  fields: FieldFacts[];
  /** The element acted on. */
  self: FieldFacts;
  /** Whether the element acted on is one of the form's native submit controls. */
  selfIsSubmit: boolean;
  /** Whether the form's default (first) submit control is disabled, which stops Enter submitting. */
  defaultDisabled: boolean;
}

/** Whether a field takes typed text and a user could type into it right now. */
export function isTextEntry(f: FieldFacts): boolean {
  if (!f.visible || f.disabled || f.readOnly) return false;
  if (f.tag === "textarea") return true;
  return f.tag === "input" && TEXT_ENTRY_TYPES.has(f.type || "text");
}

/** Whether a form is tracked at all: it must hold something to leave blank. */
export function tracksForm(fields: readonly FieldFacts[]): boolean {
  return fields.some(isTextEntry);
}

/** Whether every text-entry field is empty — and there is at least one. */
export function allTextEmpty(fields: readonly FieldFacts[]): boolean {
  const text = fields.filter(isTextEntry);
  return text.length > 0 && text.every((f) => !f.filled);
}

/**
 * What the inventory makes of a form: not tracked, tracked and owed an empty
 * submit, or GUARDED — every submit control disabled while the fields are
 * blank, so the page itself refuses the empty submit and nobody could clear
 * the entry by trying it.
 */
export function formStatus(form: Pick<FormFacts, "fields" | "submitDisabled">): "untracked" | "guarded" | "open" {
  if (!tracksForm(form.fields)) return "untracked";
  return form.submitDisabled && allTextEmpty(form.fields) ? "guarded" : "open";
}

/**
 * Whether the action submitted the form. A click submits when it lands on a
 * native submit control. Enter submits from a focused submit control, or from
 * a text-like input while the form's default button is enabled.
 */
export function submits(kind: "click" | "enter", probe: Pick<FormProbe, "self" | "selfIsSubmit" | "defaultDisabled">): boolean {
  if (probe.selfIsSubmit) return true;
  if (kind !== "enter" || probe.defaultDisabled) return false;
  return probe.self.tag === "input" && IMPLICIT_SUBMIT_TYPES.has(probe.self.type || "text");
}

/** Whether this action was an empty submit of a tracked form. */
export function isEmptySubmit(kind: "click" | "enter", probe: FormProbe | null): boolean {
  return probe !== null && submits(kind, probe) && allTextEmpty(probe.fields);
}

/** The words that make a button submit-style, matched as whole words. */
const SUBMIT_WORDS = new Set(["submit", "send", "save", "create", "apply", "subscribe", "register", "sign", "signin", "signup", "post", "add"]);

/**
 * Whether a button reads as one that sends something, by its name and test
 * id. Whole words only: a test id is split on its separators and its camel
 * case first, so "sign-in" and "Sign" count but the "sign" inside "assignee"
 * and the "post" inside "postcode" do not.
 */
export function isSubmitLike(role: string, name: string, testid: string | null): boolean {
  if (role !== "button") return false;
  const words = `${name} ${testid ?? ""}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/);
  return words.some((w) => SUBMIT_WORDS.has(w));
}

/**
 * Whether a failed page read is the page going away under it (a navigation
 * or a closed tab), which is expected after a submit and says nothing. Any
 * other failure is worth a line in the action log.
 */
export function isNavigationTeardown(message: string): boolean {
  return /execution context was destroyed|target (page, context or browser )?(has been )?closed|frame (was|has been) detached|navigat/i.test(message);
}

/** Page-side helpers shared by the inventory and the probe. Statements, not an expression. */
const FORM_HELPERS_SRC = `
  const visible = ${VISIBLE_SRC};
  const xpathOf = ${XPATH_OF_SRC};
  // Each field's value when the inventory first read it: what the app put
  // there before the session typed anything. Kept in the page, by element,
  // under a registry symbol the app has no reason to touch.
  const initialKey = Symbol.for("scenescout.form-initial-values");
  const initials = window[initialKey] || (window[initialKey] = new WeakMap());
  // remember: the inventory records a field's first value; the probe at
  // submit time only compares, so a field first met at the submit counts as
  // filled whenever it holds anything. Only date and time fields: an app
  // pre-fills those with "now" on a create form, while a pre-filled text
  // field is an edit form's record, and saving that unchanged is not the
  // empty submit.
  // Held equal to APP_FILLED_TYPES by memory-test; a literal, not a
  // JSON.stringify, so this script is built from constants alone.
  const pickerTypes = ["date", "datetime-local", "month", "week", "time"];
  const facts = (f, remember) => {
    const value = typeof f.value === "string" ? f.value : "";
    const type = f.tagName.toLowerCase() === "input" ? String(f.type || "text").toLowerCase() : "";
    const picker = pickerTypes.includes(type);
    if (picker && remember && !initials.has(f)) initials.set(f, value);
    return {
      tag: f.tagName.toLowerCase(),
      type,
      disabled: f.matches(":disabled"),
      readOnly: f.readOnly === true,
      visible: visible(f),
      filled: value !== "" && !(picker && value === initials.get(f)),
    };
  };
  // The type PROPERTY: a button with no type, or an unknown one, reports "submit".
  const isSubmit = (el) => {
    const tag = el.tagName.toLowerCase();
    return (tag === "button" && el.type === "submit") || (tag === "input" && (el.type === "submit" || el.type === "image"));
  };
  const submitsOf = (form) => Array.from(form.elements).filter((c) => isSubmit(c) && visible(c));
  // Each DISTINCT set of field facts once. The rules ask whether any field is
  // text entry and whether every one is blank, which repeats do not change,
  // and a form of 2000 identical rows would otherwise ship 2000 objects back.
  const fieldFactsOf = (form, remember) => {
    const seen = new Map();
    for (const c of Array.from(form.elements)) {
      if (!/^(input|textarea|select)$/i.test(c.tagName) || c.type === "hidden") continue;
      const f = facts(c, remember);
      const id = f.tag + "|" + f.type + "|" + f.disabled + "|" + f.readOnly + "|" + f.visible + "|" + f.filled;
      if (!seen.has(id)) seen.set(id, f);
    }
    return Array.from(seen.values());
  };
  // Resolved against the base URL, so a relative and an absolute action agree;
  // one that is not a URL at all is kept as written.
  const resolvedAction = (form) => {
    const raw = (form.getAttribute("action") || "").trim();
    if (!raw) return "";
    try { return new URL(raw, document.baseURI).href; } catch (e) { return raw; }
  };
  // getAttribute, not form.id / form.name: a field named "id" or "name" shadows those.
  const attrsOf = (form) => ({
    id: form.getAttribute("id") || "",
    name: form.getAttribute("name") || "",
    action: resolvedAction(form),
    method: form.getAttribute("method") || "",
  });
`;

/**
 * Page-side: every form on the page with a visible native submit control, as
 * the xpath of its first one and the facts of its fields. One pass over
 * `document.forms`; which of them are tracked is decided in Node (formStatus).
 */
export const FORMS_INVENTORY_SCRIPT = `(() => {
  ${FORM_HELPERS_SRC}
  const out = [];
  for (const form of Array.from(document.forms)) {
    const submits = submitsOf(form);
    if (submits.length === 0) continue;
    out.push({
      attrs: attrsOf(form),
      submit: xpathOf(submits[0]),
      fields: fieldFactsOf(form, true),
      submitDisabled: submits.every((s) => s.matches(":disabled")),
    });
  }
  return out;
})()`;

/**
 * Page-side body of the probe run on the element an action is about to
 * submit through: `(node) => FormProbe | null`, null when it belongs to no
 * form. Shipped as source rather than a transpiled function, for the reason
 * the collector is a string: a loader's helpers do not exist in the page.
 */
export const FORM_PROBE_BODY = `
  if (!node || node.nodeType !== 1 || !node.form) return null;
  ${FORM_HELPERS_SRC}
  const form = node.form;
  const submits = submitsOf(form);
  if (submits.length === 0) return null;
  const accessibleName = ${ACCESSIBLE_NAME_SRC};
  return {
    attrs: attrsOf(form),
    submit: xpathOf(submits[0]),
    submitTestid: submits[0].getAttribute("data-testid"),
    submitName: accessibleName(submits[0]),
    fields: fieldFactsOf(form, false),
    self: facts(node, false),
    selfIsSubmit: isSubmit(node),
    defaultDisabled: submits[0].matches(":disabled"),
  };
`;

/** The probe over the focused element, as an expression for a page-level evaluate. */
export const FORM_PROBE_OF_ACTIVE_ELEMENT = `((node) => {${FORM_PROBE_BODY}})(document.activeElement)`;

/**
 * The scout_coverage lines for forms no session has submitted empty this
 * run. Empty when there is nothing to say.
 */
export function formatNeverSubmittedEmpty(forms: ReadonlyArray<{ route: string; key: string; seenBy?: readonly string[] }>): string[] {
  if (forms.length === 0) return [];
  return [
    "Forms never submitted empty this run (submit each once with every text field blank: a submit that silently does nothing — no request, no message — hides there):",
    ...forms.slice(0, 15).map((f) => `  ${f.route} ${f.key}${f.seenBy && f.seenBy.length > 0 ? ` (seen by ${f.seenBy.join(", ")})` : ""}`),
    ...(forms.length > 15 ? [`  … +${forms.length - 15} more`] : []),
  ];
}

/** One `<option>` of a dropdown as the page holds it, in document order. */
export interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
}

/** The option a select asked for resolves to, or why none does. */
export type OptionMatch = { option: SelectOption; index: number } | { refused: string };

/**
 * Which option of a dropdown a requested value means, decided before any pick
 * so a value that names none fails at once instead of waiting out the action
 * limit. Tried in order, first tier with a match wins:
 *   1. an option whose value is exactly the request;
 *   2. an option whose label is exactly the request;
 *   3. a value or label equal to it ignoring case and surrounding space;
 *   4. a label that starts with it, ignoring case ("Low" for "Low — minor impact").
 * In tiers 1 and 2 the first match is taken, as the browser takes it. Tiers 3
 * and 4 are guesses, so they must find exactly one option; two or more is
 * refused, naming them. A disabled option is refused: no user can choose it.
 */
export function matchOption(options: readonly SelectOption[], requested: string): OptionMatch {
  const indexed = options.map((option, index) => ({ option, index }));
  const fold = (s: string) => s.trim().toLowerCase();
  const want = fold(requested);
  const tiers: Array<{ hits: typeof indexed; guess: boolean }> = [
    { hits: indexed.filter(({ option }) => option.value === requested), guess: false },
    { hits: indexed.filter(({ option }) => option.label === requested), guess: false },
    { hits: indexed.filter(({ option }) => fold(option.value) === want || fold(option.label) === want), guess: true },
    { hits: want === "" ? [] : indexed.filter(({ option }) => fold(option.label).startsWith(want)), guess: true },
  ];
  for (const { hits, guess } of tiers) {
    if (hits.length === 0) continue;
    if (guess && hits.length > 1) {
      return { refused: `${JSON.stringify(requested)} matches more than one option: ${listOptions(hits.map((h) => h.option))}. Pass one of the values.` };
    }
    const hit = hits[0];
    if (hit.option.disabled) return { refused: `option ${describeOption(hit.option)} is disabled, so it cannot be chosen.` };
    return hit;
  }
  return { refused: `no option matches ${JSON.stringify(requested)}; options: ${listOptions(options)}.` };
}

function describeOption(o: SelectOption): string {
  const cap = (t: string) => (t.length > 60 ? `${t.slice(0, 59)}…` : t);
  const shown = o.value === "" ? '""' : cap(o.value);
  return o.label && o.label !== o.value ? `${shown} (${JSON.stringify(cap(o.label))})` : shown;
}

/** The options as a refusal lists them: value, then label where it differs; at most 15. */
function listOptions(options: readonly SelectOption[]): string {
  if (options.length === 0) return "none";
  const shown = options.slice(0, 15).map((o) => describeOption(o) + (o.disabled ? " [disabled]" : ""));
  return shown.join(", ") + (options.length > 15 ? `, … +${options.length - 15} more` : "");
}

/** The format each date and time input type takes, with an example, for a refusal. */
const DATE_FORMATS: Readonly<Record<string, string>> = {
  date: "YYYY-MM-DD (e.g. 2026-09-20)",
  "datetime-local": "YYYY-MM-DDTHH:MM (e.g. 2026-09-20T10:00)",
  time: "HH:MM or HH:MM:SS, 24-hour (e.g. 14:30)",
  month: "YYYY-MM (e.g. 2026-09)",
  week: "YYYY-Www (e.g. 2026-W38)",
};

function realDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function realTime(h: number, min: number, sec: number | null): boolean {
  return h < 24 && min < 60 && (sec === null || sec < 60);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** ISO 8601 week of a calendar date, as `YYYY-Www`. */
function isoWeek(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

/** What to type into a field, or why it cannot take the value. `note` says what was changed, when anything was. */
export type DateValue = { value: string; note?: string } | { refused: string };

/**
 * A value for a date or time input (`date`, `datetime-local`, `time`, `month`,
 * `week`), in the one format the browser accepts there. Anything else fails
 * the fill with a bare "Malformed value", so an obvious near miss is put in
 * that format — a date into a date-and-time field gets T00:00, a space between
 * date and time becomes "T", a date into a month field keeps its month — and
 * anything else is refused, naming the format. Any other type, and an empty
 * value (which clears the field), pass through unchanged.
 */
export function normaliseDateValue(type: string, text: string): DateValue {
  const format = DATE_FORMATS[type];
  if (!format || text === "") return { value: text };
  const v = text.trim();
  const refused = { refused: `a ${type} field takes ${format}; ${JSON.stringify(text)} is not in that form.` };
  const changed = (value: string): DateValue => (value === text ? { value } : { value, note: `entered as ${value}, the form a ${type} field takes` });
  const dateRe = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
  const timeRe = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;
  const timeOf = (s: string): string | null => {
    const t = timeRe.exec(s);
    if (!t) return null;
    const [h, min, sec] = [Number(t[1]), Number(t[2]), t[3] === undefined ? null : Number(t[3])];
    if (!realTime(h, min, sec)) return null;
    return `${pad(h)}:${pad(min)}${sec === null ? "" : `:${pad(sec)}${t[4] ?? ""}`}`;
  };
  if (type === "time") {
    const t = timeOf(v);
    return t ? changed(t) : refused;
  }
  if (type === "week") {
    const w = /^(\d{4})-[Ww](\d{1,2})$/.exec(v);
    if (w) {
      const week = Number(w[2]);
      return week >= 1 && week <= 53 ? changed(`${w[1]}-W${pad(week)}`) : refused;
    }
  }
  if (type === "month") {
    const m = /^(\d{4})-(\d{1,2})$/.exec(v);
    if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? changed(`${m[1]}-${pad(Number(m[2]))}`) : refused;
  }
  const d = dateRe.exec(v);
  if (!d) return refused;
  const [y, mo, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  if (!realDate(y, mo, day)) return refused;
  const date = `${d[1]}-${pad(mo)}-${pad(day)}`;
  const rest = v.slice(d[0].length);
  // What may follow the date: nothing, or a time after "T" or a space.
  const time = rest === "" ? "" : /^[T ]/.test(rest) ? timeOf(rest.slice(1)) : null;
  if (time === null) return refused;
  switch (type) {
    case "date":
      return changed(date);
    case "month":
      return changed(date.slice(0, 7));
    case "week":
      return changed(isoWeek(y, mo, day));
    default:
      return changed(`${date}T${time || "00:00"}`);
  }
}
