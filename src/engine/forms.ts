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
  /** Whether its value is anything other than the empty string. */
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
  const facts = (f) => ({
    tag: f.tagName.toLowerCase(),
    type: f.tagName.toLowerCase() === "input" ? String(f.type || "text").toLowerCase() : "",
    disabled: f.matches(":disabled"),
    readOnly: f.readOnly === true,
    visible: visible(f),
    filled: typeof f.value === "string" && f.value !== "",
  });
  // The type PROPERTY: a button with no type, or an unknown one, reports "submit".
  const isSubmit = (el) => {
    const tag = el.tagName.toLowerCase();
    return (tag === "button" && el.type === "submit") || (tag === "input" && (el.type === "submit" || el.type === "image"));
  };
  const submitsOf = (form) => Array.from(form.elements).filter((c) => isSubmit(c) && visible(c));
  // Each DISTINCT set of field facts once. The rules ask whether any field is
  // text entry and whether every one is blank, which repeats do not change,
  // and a form of 2000 identical rows would otherwise ship 2000 objects back.
  const fieldFactsOf = (form) => {
    const seen = new Map();
    for (const c of Array.from(form.elements)) {
      if (!/^(input|textarea|select)$/i.test(c.tagName) || c.type === "hidden") continue;
      const f = facts(c);
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
      fields: fieldFactsOf(form),
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
    fields: fieldFactsOf(form),
    self: facts(node),
    selfIsSubmit: isSubmit(node),
    defaultDisabled: submits[0].matches(":disabled"),
  };
`;

/** The probe as an expression over a node expression, for a page-level evaluate. */
export function formProbeExpression(nodeExpression: string): string {
  return `((node) => {${FORM_PROBE_BODY}})(${nodeExpression})`;
}

/**
 * The scout_coverage lines for forms no session has submitted empty this
 * run. Empty when there is nothing to say.
 */
export function formatNeverSubmittedEmpty(forms: ReadonlyArray<{ route: string; key: string }>): string[] {
  if (forms.length === 0) return [];
  return [
    "Forms never submitted empty this run (submit each once with every text field blank: a submit that silently does nothing — no request, no message — hides there):",
    ...forms.slice(0, 15).map((f) => `  ${f.route} ${f.key}`),
    ...(forms.length > 15 ? [`  … +${forms.length - 15} more`] : []),
  ];
}
