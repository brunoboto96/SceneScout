/**
 * Page-side sources the collector shares with the probes: the visibility
 * rule, the element path, the accessible name and the label policy's text,
 * each shipped as a STRING and, where its order matters, run outside a page
 * from the same source so a table test exercises exactly what the page runs.
 */

/**
 * The collector's visibility rule, as page-side source. Exported so the
 * file-input probe (browser.ts) can ask "would the collector have listed
 * this?" with the SAME rule — two copies of it would drift.
 */
export const VISIBLE_SRC = `(el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }`;

/**
 * The collector's element path, as page-side source. Exported so a page-side
 * probe that names an element (forms.ts) names it with the SAME path the
 * snapshot listed it under, and the engine can map it back to that element's
 * coverage key.
 */
export const XPATH_OF_SRC = `(el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html") {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + "[" + index + "]");
      node = node.parentElement;
    }
    return "/html/" + parts.join("/");
  }`;

/**
 * What one descendant of a control says toward the control's name, as
 * page-side source, in the order the accessible-name computation reads it
 * when a name comes from content: its aria-label; for an <img>, its alt text,
 * and when that is empty or missing, its title (an avatar with alt="" and a
 * title names the link around it); for an <svg>, its <title>. Anything else
 * says nothing. Kept apart from NAME_FACTS_SRC so the order can be
 * table-tested without a browser (contentSays).
 */
const CONTENT_SAYS_SRC = `(d) => {
    if (d.ariaLabel && d.ariaLabel.trim()) return d.ariaLabel;
    if (d.tag === "img") return d.alt && d.alt.trim() ? d.alt : d.title;
    if (d.tag === "svg") return d.svgTitle;
    return "";
  }`;

/** The facts CONTENT_SAYS_SRC reads of one descendant. */
export interface ContentFacts {
  tag: string;
  ariaLabel: string | null;
  alt: string | null;
  title: string;
  svgTitle: string;
}

/** CONTENT_SAYS_SRC run outside a page, from the same source the page runs. */
export function contentSays(facts: ContentFacts): string {
  return (new Function(`return (${CONTENT_SAYS_SRC});`)() as (d: ContentFacts) => string)(facts);
}

/**
 * What an element's accessible name is read from, as page-side source: every
 * candidate source, read from the DOM and nothing decided. PICK_NAME_SRC
 * decides, so the order can be table-tested without a browser.
 *
 * A label's text is read without the control's own text: a wrapping label
 * holds the control, and a select's options or a textarea's contents are not
 * its label.
 *
 * `content` is what the element's content says that its text cannot hold:
 * the first descendant, in document order, that CONTENT_SAYS_SRC finds a word
 * in (an aria-label, an image's alt or title, an svg's <title>), skipping
 * anything inside an aria-hidden part of the element. `content2` is what the
 * same content said under name rule 2 (memory.ts NAME_RULE), which read only
 * an <img>'s alt and an <svg>'s or role="img"'s aria-label or <title>: it is
 * read so a control renamed since keeps its coverage.
 */
const NAME_FACTS_SRC = `(el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const inputType = tag === "input" ? el.type : "";
    const byId = (id) => { const n = (el.ownerDocument || document).getElementById(id); return n ? n.textContent || "" : ""; };
    const labels = [];
    for (const label of Array.from(el.labels || [])) {
      const own = label.contains(el) ? el.textContent || "" : "";
      labels.push((label.textContent || "").replace(own, ""));
    }
    const says = ${CONTENT_SAYS_SRC};
    let content = "";
    let content2 = "";
    for (const d of el.querySelectorAll("img, svg, [role='img'], [aria-label]")) {
      const hidden = d.closest('[aria-hidden="true"]');
      if (hidden && el.contains(hidden)) continue;
      const svgTitle = d.tagName.toLowerCase() === "svg" ? d.querySelector(":scope > title") : null;
      const said = says({
        tag: d.tagName.toLowerCase(),
        ariaLabel: d.getAttribute("aria-label"),
        alt: d.getAttribute("alt"),
        title: d.getAttribute("title") || "",
        svgTitle: svgTitle ? svgTitle.textContent || "" : "",
      });
      if (!content && said.trim()) content = said;
      // Name rule 2, frozen: what this content said before a descendant's aria-label and an image's title counted.
      if (!content2 && d.matches("img, svg, [role='img']")) {
        const said2 = (d.tagName === "IMG" ? d.getAttribute("alt") : d.getAttribute("aria-label") || (svgTitle ? svgTitle.textContent : "")) || "";
        if (said2.trim()) content2 = said2;
      }
      if (content && content2) break;
    }
    const live = /^(status|alert|log|timer|marquee)$/.test(role) || tag === "output" ||
      (el.hasAttribute("aria-live") && el.getAttribute("aria-live") !== "off");
    return {
      tag,
      inputType,
      labelledBy: (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean).map(byId).join(" "),
      ariaLabel: el.getAttribute("aria-label"),
      labels,
      title: el.getAttribute("title") || "",
      placeholder: el.getAttribute("placeholder") || "",
      nameAttr: el.getAttribute("name") || "",
      // Read only for button-like inputs: a text field's value is what the user typed, not its name.
      value: inputType === "submit" || inputType === "reset" || inputType === "button" ? el.value || "" : "",
      alt: el.getAttribute("alt") || "",
      live,
      text: el.innerText || el.textContent || "",
      content,
      content2,
    };
  }`;

/**
 * The accessible name chosen from NAME_FACTS_SRC's facts, as page-side source,
 * in the order of the accessible-name computation: aria-labelledby,
 * aria-label, then the host language's label (an image's alt; a <label>,
 * for= or wrapping; a button-like input's value), then title, then the
 * placeholder. Returns the name and, for a field, where it came from when that
 * is not a label (`from`, see NameFrom): the name falls back to the
 * placeholder, the name attribute or the type so every field can be told apart
 * and targeted, and the name is half of the element's coverage key, so the
 * fallback stays.
 *
 * - A select is never named by its options: their text is its value, not its name.
 * - Other elements are named by their text; with none, by their content
 *   (a link holding only a logo with alt text, a button holding only an svg
 *   with a <title>, a link around an icon element with an aria-label or an
 *   avatar with a title); and with neither, by title (an icon-only button
 *   with a tooltip). Text and content are not joined: a control with both is
 *   named by its text, as it was before content counted.
 * - A name taken from content carries `priors`, the name each earlier rule
 *   gave (memory.ts NAME_RULE), rule 1 first: rule 1 read no content (the
 *   title, or nothing), rule 2 read only image content. The name is half of
 *   the coverage key, so the key under each earlier rule is kept beside the
 *   new one and coverage recorded under it carries over (memory.ts keyAliases,
 *   ruleKeyAliases).
 * - A live region (status, alert, log, timer, an aria-live region, <output>)
 *   is named by the text it announces, which is what matters after an action.
 * - A whitespace-only aria-label ends the name with nothing, as it always has
 *   here: the field it hides is reported as unnamed.
 */
const PICK_NAME_SRC = `(f) => {
    const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const named = (s) => ({ name: s.slice(0, 80), from: null });
    const field = f.tag === "input" || f.tag === "textarea" || f.tag === "select";
    if (clean(f.labelledBy)) return named(clean(f.labelledBy));
    if (f.ariaLabel) {
      if (clean(f.ariaLabel)) return named(clean(f.ariaLabel));
      return { name: "", from: field ? "fallback" : null };
    }
    if (f.tag === "img") return named(clean(f.alt));
    if (f.live && clean(f.text)) return named(clean(f.text));
    const labels = f.labels.map(clean).filter(Boolean).join(" ");
    if (labels) return named(labels);
    if (field) {
      const t = f.inputType;
      if (t === "submit" || t === "reset" || t === "button") {
        if (clean(f.value)) return named(clean(f.value));
        // The browser's own text: what a user sees on the button.
        if (t !== "button") return named(t === "submit" ? "Submit" : "Reset");
      }
      if (t === "image" && clean(f.alt)) return named(clean(f.alt));
      if (clean(f.title)) return named(clean(f.title));
      if (f.tag !== "select" && clean(f.placeholder)) return { name: clean(f.placeholder).slice(0, 80), from: "placeholder" };
      return { name: (clean(f.nameAttr) || t || f.tag).slice(0, 80), from: "fallback" };
    }
    if (clean(f.text)) return named(clean(f.text));
    if (clean(f.content)) {
      // The name under rule 1 (no content) and under rule 2 (content2), so coverage keys can be carried across.
      const title = clean(f.title).slice(0, 80);
      return { ...named(clean(f.content)), priors: [title, clean(f.content2) ? clean(f.content2).slice(0, 80) : title] };
    }
    return named(clean(f.title));
  }`;

/** The facts NAME_FACTS_SRC reads, as PICK_NAME_SRC takes them. */
export interface NameFacts {
  tag: string;
  inputType: string;
  labelledBy: string;
  ariaLabel: string | null;
  labels: string[];
  title: string;
  placeholder: string;
  nameAttr: string;
  value: string;
  alt: string;
  live: boolean;
  text: string;
  content: string;
  content2: string;
}

/** A name PICK_NAME_SRC chose, and the names the earlier rules gave when they can differ. */
export interface PickedName {
  name: string;
  from: NameFrom | null;
  /** Present only when content named the element: its name under rule 1, then rule 2 (memory.ts NAME_RULE). */
  priors?: string[];
}

/**
 * PICK_NAME_SRC run outside a page, from the same source the page runs, so a
 * table test exercises exactly the rule the collector ships.
 */
export function pickName(facts: NameFacts): PickedName {
  return (new Function(`return (${PICK_NAME_SRC});`)() as (f: NameFacts) => PickedName)(facts);
}

/** The element's name and where a field's came from, as page-side source. */
export const NAME_SRC = `(el) => (${PICK_NAME_SRC})((${NAME_FACTS_SRC})(el))`;

/**
 * The collector's accessible name, as page-side source. Exported for the same
 * reason as XPATH_OF_SRC: a page-side probe that names an element (forms.ts)
 * must name it exactly as the snapshot did, or the two cannot be compared.
 */
export const ACCESSIBLE_NAME_SRC = `(el) => (${NAME_SRC})(el).name`;

/**
 * What the label policy reads of an element besides its name (policy.ts
 * destructiveLabelOf), as page-side source shared by the snapshot and the
 * live re-check before an action, so the two cannot judge differently.
 *
 * `ownText`: the label the element is given (aria-label, aria-labelledby),
 * then its text without the text of the controls inside it.
 * `centre`: the labels of the controls inside it whose boxes cover the
 * element's centre point, which is where a click on the element lands. Boxes,
 * not a hit test, so it reads the same whether or not the element is scrolled
 * into view, and every covering control is named, not only the topmost.
 */
export const POLICY_TEXT_SRC = `(el) => {
    const CONTROL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
      '[role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="listbox"], [onclick]';
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement && node.parentElement.closest(CONTROL);
      if (owner && owner !== el && el.contains(owner)) continue;
      const t = (node.textContent || "").trim();
      if (t) parts.push(t);
      if (parts.join(" ").length > 400) break;
    }
    // A label the element is given (aria-label, aria-labelledby) is its own: an icon-only control's only name.
    const given = [el.getAttribute("aria-label") || ""].concat((el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean).map((id) => {
      const n = document.getElementById(id);
      return n ? n.textContent || "" : "";
    })).join(" ").trim();
    const ownText = (given + " " + parts.join(" ")).replace(/\\s+/g, " ").trim().slice(0, 400);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const centre = [];
    for (const c of Array.from(el.querySelectorAll(CONTROL))) {
      const b = c.getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) continue;
      const label = (c.getAttribute("aria-label") || c.innerText || c.textContent || c.getAttribute("value") || "").trim().replace(/\\s+/g, " ").slice(0, 120);
      if (label && centre.length < 10) centre.push(label);
      const tid = c.getAttribute("data-testid");
      if (tid && centre.length < 10) centre.push(tid);
    }
    return { ownText, centre };
  }`;

/**
 * Where a field's shown name came from when it is not a label (the collector's
 * nameFrom): its placeholder, or its name attribute or type. Absent or null
 * when the name is a real one.
 */
export type NameFrom = "placeholder" | "fallback";
