/**
 * The page-side collector and the pure geometry oracles.
 *
 * Split out of the engine because none of it needs Playwright: the collector
 * ships to the browser as a STRING, and `geometryIssues` is a pure function
 * over layout boxes. Keeping them here means the oracle rules — the part that
 * has repeatedly shipped false positives — can be table-tested without
 * launching a browser (see scripts/oracle-test.ts).
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
 * What an element's accessible name is read from, as page-side source: every
 * candidate source, read from the DOM and nothing decided. PICK_NAME_SRC
 * decides, so the order can be table-tested without a browser.
 *
 * A label's text is read without the control's own text: a wrapping label
 * holds the control, and a select's options or a textarea's contents are not
 * its label.
 */
export const NAME_FACTS_SRC = `(el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const inputType = tag === "input" ? el.type : "";
    const byId = (id) => { const n = document.getElementById(id); return n ? n.textContent || "" : ""; };
    const labels = [];
    for (const label of Array.from(el.labels || [])) {
      const own = label.contains(el) ? el.textContent || "" : "";
      labels.push((label.textContent || "").replace(own, ""));
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
 * - Other elements are named by their text, and by title when they have none
 *   (an icon-only button with a tooltip).
 * - A live region (status, alert, log, timer, an aria-live region, <output>)
 *   is named by the text it announces, which is what matters after an action.
 * - A whitespace-only aria-label ends the name with nothing, as it always has
 *   here: the field it hides is reported as unnamed.
 */
export const PICK_NAME_SRC = `(f) => {
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
}

/**
 * PICK_NAME_SRC run outside a page, from the same source the page runs, so a
 * table test exercises exactly the rule the collector ships.
 */
export function pickName(facts: NameFacts): { name: string; from: NameFrom | null } {
  return (new Function(`return (${PICK_NAME_SRC});`)() as (f: NameFacts) => { name: string; from: NameFrom | null })(facts);
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
 * Anything that plausibly presents as a modal/dialog panel. Deliberately wider
 * than the ARIA set: a hand-rolled role-less modal must still count as "an
 * overlay is up", or the scroll-lock oracle files a false leaked-lock finding
 * against every healthy modal that locks the page behind it.
 */
export const DIALOG_LIKE_SEL = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]';
// Declared above the collector script because that script interpolates it.

/**
 * The accessible name of a control that pages a clipping container: next and
 * previous arrows, numbered slide or page buttons, scroll-left and
 * scroll-right. Content clipped inside a container such a control sits beside
 * is revealed by it, so it is not unreachable. The page-side walk carries a
 * literal copy (no value is spliced into page code); oracle-test holds the two
 * equal.
 */
export const PAGER_NAME =
  /^(?:[‹›«»<>←→⟨⟩❮❯]|(?:go to |show )?(?:next|previous|prev)(?:\s+\w+)?|(?:go to |show )?(?:slide|page|image|item|step)\s*\d+.*|scroll (?:left|right|up|down)\b.*)$/i;

/** Whether a control's name says it pages a container (see PAGER_NAME). */
export function isPagerName(name: string): boolean {
  return PAGER_NAME.test(name.trim());
}

/**
 * An href that points at a place in this same document: "#main". Not a bare
 * "#", and not a hash route ("#/reports", "#!/reports"), which is navigation.
 * The collector carries a literal copy; oracle-test holds the two equal.
 */
export const IN_PAGE_ANCHOR = /^#(?![/!])./;

/**
 * Style properties that can bring a box parked off the page back into it. A
 * :focus rule that sets one of these is how a skip link is revealed; a :focus
 * rule that only draws an outline is not. The collector carries a literal
 * copy; oracle-test holds the two equal.
 */
export const FOCUS_MOVES_PROPS = [
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "inset",
  "transform",
  "translate",
  "clip",
  "clip-path",
  "margin",
  "margin-top",
  "margin-left",
  "width",
  "height",
];

/**
 * Page-side interactable collector. Shipped as a STRING, not a function:
 * loader transforms (tsx/vitest esbuild hooks inject a `__name` helper) break
 * serialized functions inside the browser, where the helper doesn't exist.
 * A string expression is immune to any build/loader instrumentation.
 */
export const COLLECT_INTERACTABLES_SCRIPT = `(() => {
  const xpathOf = ${XPATH_OF_SRC};
  const visible = ${VISIBLE_SRC};
  const nameOf = ${NAME_SRC};
  const policyText = ${POLICY_TEXT_SRC};
  // What the collector lists before anything else: controls, and anything the
  // app tagged with a test id so it can be targeted.
  const controlSelector =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], ' +
    '[role="menuitem"], [role="checkbox"], [role="switch"], [role="combobox"], [onclick], [data-testid]';
  // Live regions: what a page announces after an action (an error banner, a
  // "Saved" status). Listed whether or not the app tagged them, because what
  // the user is told must not depend on a test id. Those listed only for this
  // are marked liveOnly: they are read, not acted on.
  const liveSelector = '[role="alert"], [role="alertdialog"], [role="status"], [aria-live]:not([aria-live="off"]), output';
  const selector = controlSelector + ", " + liveSelector;
  // Whether a user can act on the element: a native control, an interactive
  // role, a tab stop, a click handler, or a pointer cursor it sets itself (a
  // cursor inherited from a clickable card is the card's, not its badge's).
  // Everything else listed is here for its test id or its text, and is neither
  // an unnamed control nor a gap in coverage.
  const CONTROL_ROLES = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|switch|combobox|textbox|searchbox|slider|spinbutton|option|treeitem)$/;
  const isInteractive = (el) => {
    if (el.matches('a[href], button, input, select, textarea, summary, [contenteditable="true"], [contenteditable=""]')) return true;
    if (CONTROL_ROLES.test(el.getAttribute("role") || "")) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && tabindex.trim() !== "" && Number(tabindex) >= 0) return true;
    if (el.hasAttribute("onclick") || typeof el.onclick === "function") return true;
    if (window.getComputedStyle(el).cursor === "pointer") {
      const parent = el.parentElement;
      return !parent || window.getComputedStyle(parent).cursor !== "pointer";
    }
    return false;
  };
  // A horizontally scrolling container a control sits outside of: the control
  // is reachable, by a sideways scroll of that container, but nothing on screen
  // shows it is there. Carousels (scroll-snap) page sideways by design and are
  // left out. Returns how to name the container, or null.
  const scrolledOutIn = (el, rect) => {
    for (let anc = el.parentElement; anc && anc !== document.body && anc !== document.documentElement; anc = anc.parentElement) {
      const as = window.getComputedStyle(anc);
      if ((as.overflowX === "auto" || as.overflowX === "scroll") && anc.scrollWidth > anc.clientWidth + 1) {
        if (as.scrollSnapType && as.scrollSnapType !== "none") return null;
        const left = anc.getBoundingClientRect().left + anc.clientLeft;
        const cx = rect.left + rect.width / 2;
        if (cx >= left && cx <= left + anc.clientWidth) return null;
        const tid = anc.getAttribute("data-testid");
        if (tid) return "[" + tid + "]";
        const label = (anc.getAttribute("aria-label") || "").trim().slice(0, 40);
        return "<" + anc.tagName.toLowerCase() + (anc.id ? "#" + anc.id : "") + ">" + (label ? ' "' + label + '"' : "");
      }
      if (as.position === "fixed") return null;
    }
    return null;
  };
  const seen = new Set();
  const out = [];
  // Positioning/scroll LAYER + CHROME classification, for the overlap oracle.
  // Elements in different fixed/sticky/scroll contexts are STACKED by design
  // (a sticky footer riding over a scrolled nav, a modal over the page); their
  // document-coordinate rects "overlap" without colliding. Only elements that
  // share a positioning/scroll context can genuinely collide, and overlaps
  // between two pieces of fixed/sticky chrome are almost always intended
  // layering — so we tag each element with its nearest layer id and whether it
  // lives inside fixed/sticky chrome, and let the oracle skip the phantoms.
  const ctxIds = new WeakMap();
  let ctxSeq = 0;
  const ctxId = (node) => {
    let id = ctxIds.get(node);
    if (id === undefined) { id = ++ctxSeq; ctxIds.set(node, id); }
    return id;
  };
  const layerAndChrome = (el) => {
    let chrome = false, layer = 0, first = true;
    // An element that is ITSELF position:fixed is lifted out of the document
    // flow and stacked over it — a modal panel, a toast, a floating bar. It is
    // its own layer root, so it must not be compared against the page content
    // it deliberately covers. Without this, every open dialog reported a 100%
    // "overlap" against the very content it was meant to sit on top of, since
    // a dialog parented directly to <body> otherwise inherited layer 0.
    if (window.getComputedStyle(el).position === "fixed") layer = ctxId(el);
    let node = el;
    while (node && node.tagName !== "HTML" && node.tagName !== "BODY") {
      const s = window.getComputedStyle(node);
      const pos = s.position;
      if (pos === "fixed" || pos === "sticky") chrome = true;
      // The element's OWN box does not define its layer — siblings share their
      // parent's context. A positioned or scroll/clip ANCESTOR does.
      if (!first && layer === 0) {
        const scrolls = s.overflow === "auto" || s.overflow === "scroll" ||
          s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowY === "hidden" || s.overflowY === "clip" ||
          s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden" || s.overflowX === "clip";
        if (pos === "fixed" || pos === "sticky" || pos === "absolute" || pos === "relative" || scrolls) layer = ctxId(node);
      }
      first = false;
      node = node.parentElement;
    }
    return { layer, chrome };
  };
  // A pinned control (inside position:fixed/sticky chrome) whose centre is
  // owned by ANOTHER piece of pinned chrome. Two pieces of chrome overlapping
  // is usually intended layering, which is why the box-overlap oracle skips
  // that pair — but boxes cannot tell which one is on top. A hit test can: if
  // the point at the control's centre belongs to a different pinned element,
  // a click aimed at the control lands on that element instead.
  // Deliberately narrow, to stay quiet on intended layering:
  //  - only interactive controls, and only while their centre is in the viewport;
  //  - the control must be pinned with NO scrollable pane anywhere above it, or
  //    scrolling that pane would simply bring it out from under;
  //  - dialogs, menus, consent banners, toasts and anything covering half the
  //    viewport are overlays, not chrome.
  const INTERACTIVE_ROLES = ["button", "link", "textbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "file"];
  const isScroller = (n) => {
    const cs = window.getComputedStyle(n);
    return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1);
  };
  /** Nearest fixed/sticky ancestor-or-self. */
  const pinnedRootOf = (node) => {
    for (let n = node; n && n !== document.documentElement; n = n.parentElement) {
      const pos = window.getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return n;
    }
    return null;
  };
  /**
   * Is there a scrollable pane anywhere between this node and the document?
   * Checked over the WHOLE chain, above the pinned root as well as below it: a
   * sticky first-column cell inside a scrolling grid is pinned within that
   * grid, and scrolling the grid brings it out from under the sticky header.
   * position:fixed escapes every ancestor's scrolling, so the walk stops there.
   */
  const insideScrollablePane = (node) => {
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n !== node && isScroller(n)) return true;
      if (window.getComputedStyle(n).position === "fixed") return false;
    }
    return false;
  };
  // Pinned things that are overlays by nature, not layout: consent banners sit
  // over everything until dismissed, toasts are gone in seconds. A click they
  // intercept is real but it is not an app defect, and the consent case would
  // otherwise fire on the first snapshot of nearly every site.
  const TRANSIENT_SEL = '[role="alert"], [role="status"], [aria-live], [class*="toast" i], [class*="snackbar" i], [class*="cookie" i], [class*="consent" i], [id*="cookie" i], [id*="consent" i]';
  const describe = (node) => {
    const tid = node.getAttribute("data-testid");
    if (tid) return "[" + tid + "]";
    const text = (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return "<" + node.tagName.toLowerCase() + ">" + (text ? ' "' + text + '"' : "");
  };
  /** A link to a place in this same document (a skip link's shape): "#main", never a bare "#" or a hash route ("#/reports"). */
  const inPageAnchor = (node) => node.tagName === "A" && /^#(?![/!])./.test(node.getAttribute("href") || "");
  // The page's :focus rules that move a box (FOCUS_MOVES_PROPS), as selectors
  // with the :focus part removed: an element they match is shown when it takes
  // focus. Read once, only when an element sits off the page.
  let focusMoveSelectors = null;
  const FOCUS_MOVES = ["position", "top", "left", "right", "bottom", "inset", "transform", "translate", "clip", "clip-path", "margin", "margin-top", "margin-left", "width", "height"];
  const readFocusRules = (rules, out) => {
    for (const rule of Array.from(rules || [])) {
      if (out.length >= 500) return;
      if (rule.cssRules && !rule.selectorText) { readFocusRules(rule.cssRules, out); continue; }
      const sel = rule.selectorText || "";
      if (!/:focus/.test(sel) || !rule.style) continue;
      const props = Array.from(rule.style);
      if (!props.some((p) => FOCUS_MOVES.indexOf(p) >= 0 || /^(inset|margin)-/.test(p))) continue;
      for (const part of sel.split(",")) {
        if (/:focus/.test(part)) out.push(part.replace(/:focus(-visible|-within)?/g, "").trim() || "*");
      }
    }
  };
  const focusMoves = (el) => {
    if (focusMoveSelectors === null) {
      focusMoveSelectors = [];
      for (const sheet of Array.from(document.styleSheets)) {
        // Reading another origin's stylesheet throws by design; its rules stay unknown.
        try { readFocusRules(sheet.cssRules, focusMoveSelectors); } catch (e) { continue; }
      }
    }
    return focusMoveSelectors.some((sel) => {
      // Removing :focus can leave an invalid selector (":not()"), which matches nothing.
      try { return el.matches(sel); } catch (e) { return false; }
    });
  };
  const coveredByPinnedChrome = (el, rect, role) => {
    if (INTERACTIVE_ROLES.indexOf(role) === -1) return null;
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;
    const ownRoot = pinnedRootOf(el);
    if (!ownRoot || insideScrollablePane(el)) return null;
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    // A skip link is pinned out of sight until it takes focus, then shown over
    // the header. While focused it covers whatever is under it, by design, and
    // it leaves again as soon as focus moves on.
    const active = document.activeElement;
    if (active && inPageAnchor(active) && (top === active || active.contains(top))) return null;
    const coverRoot = pinnedRootOf(top);
    if (!coverRoot || coverRoot === ownRoot || coverRoot.contains(ownRoot) || ownRoot.contains(coverRoot)) return null;
    // A dialog's fixed wrapper often carries no role or class itself; the
    // role="dialog" is on a child. Look both ways.
    const OVERLAY_SEL = '${DIALOG_LIKE_SEL}, ' + TRANSIENT_SEL + ', [role="menu"], [role="listbox"], [role="tooltip"]';
    if (coverRoot.closest(OVERLAY_SEL) || coverRoot.querySelector(OVERLAY_SEL) || top.closest(OVERLAY_SEL)) return null;
    const cr = coverRoot.getBoundingClientRect();
    if (cr.width * cr.height > window.innerWidth * window.innerHeight * 0.5) return null;
    return describe(coverRoot);
  };

  const PAGER = /^(?:[‹›«»<>←→⟨⟩❮❯]|(?:go to |show )?(?:next|previous|prev)(?:\\s+\\w+)?|(?:go to |show )?(?:slide|page|image|item|step)\\s*\\d+.*|scroll (?:left|right|up|down)\\b.*)$/i;
  // Per container and axis: a carousel clips every slide but one, and they share the answer.
  const pagedClips = new Map();
  const revealedByControl = (clip, axis) => {
    const key = pagedClips.get(clip) || {};
    if (key[axis] === undefined) { key[axis] = pagesClip(clip, axis); pagedClips.set(clip, key); }
    return key[axis];
  };
  // Content laid out as slides along the clipped axis: two or more children
  // (of the clip, or of its single track) the clip's own size on that axis,
  // at least one starting outside it. A table wider than its card, or a list
  // longer than it, is not; a "Next page" in its footer pages rows, not them.
  const slidesIn = (clip, axis) => {
    const cr = clip.getBoundingClientRect();
    const start = axis === "x" ? cr.left : cr.top;
    const span = axis === "x" ? cr.width : cr.height;
    const track = clip.children.length === 1 ? clip.children[0] : clip;
    let size = 0, outside = 0;
    for (const kid of Array.from(track.children).slice(0, 50)) {
      const r = kid.getBoundingClientRect();
      const s = axis === "x" ? r.width : r.height;
      if (s < span * 0.9 || s > span * 1.1) continue;
      size += 1;
      const at = axis === "x" ? r.left : r.top;
      if (at >= start + span - 1 || at + s <= start + 1) outside += 1;
    }
    return size >= 2 && outside >= 1;
  };
  /**
   * Whether a control in or beside a clipping container pages it: a visible
   * control within two levels above the container that names the container
   * (or something in it) in aria-controls, or, when the container holds
   * slides on the clipped axis, one whose name says next, previous, or a
   * numbered slide or page.
   */
  const pagesClip = (clip, axis) => {
    let region = clip;
    for (let i = 0; i < 2 && region.parentElement && region.parentElement !== document.body; i++) region = region.parentElement;
    const cr = clip.getBoundingClientRect();
    let slides = null;
    const controls = region.querySelectorAll('button, [role="button"], a[href], [role="tab"], input[type="button"]');
    for (const c of Array.from(controls).slice(0, 200)) {
      if (!visible(c)) continue;
      // A control inside the clip must itself be showing: a button on another
      // hidden slide (the clipped element among them) pages nothing.
      if (clip.contains(c)) {
        const r = c.getBoundingClientRect();
        if (r.bottom <= cr.top || r.top >= cr.bottom || r.right <= cr.left || r.left >= cr.right) continue;
      }
      const controlled = (c.getAttribute("aria-controls") || "").split(/\\s+/).filter(Boolean);
      if (controlled.some((id) => { const t = document.getElementById(id); return t && (t === clip || clip.contains(t) || t.contains(clip)); })) return true;
      const name = (c.getAttribute("aria-label") || c.getAttribute("title") || c.textContent || "").trim().replace(/\\s+/g, " ");
      if (PAGER.test(name) && (slides === null ? (slides = slidesIn(clip, axis)) : slides)) return true;
    }
    return false;
  };

  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute("role");
    const inputType = tag === "input" ? el.type : null;
    const role = explicitRole ||
      (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox"
        : tag === "textarea" ? "textbox"
        : tag === "input" ? (inputType === "checkbox" ? "checkbox"
          : inputType === "radio" ? "radio"
          : inputType === "submit" || inputType === "button" ? "button"
          // A file input is not a text field: fill() refuses it, and calling
          // it a textbox sent the driver to scout_type, which could only throw.
          // Its own role routes it to scout_upload instead.
          : inputType === "file" ? "file"
          : "textbox")
        : tag === "img" ? "image"
        // An aria-live region without a role announces like one: assertive
        // interrupts as an alert does, polite waits as a status does.
        : tag === "output" ? "status"
        : el.hasAttribute("aria-live") && el.getAttribute("aria-live") !== "off" ? (el.getAttribute("aria-live") === "assertive" ? "alert" : "status")
        : "generic");
    const rect = el.getBoundingClientRect();
    const elStyle = window.getComputedStyle(el);
    // Below-the-fold is reachable (scroll); clipped INSIDE an overflow-hidden
    // ancestor is not — the container cannot scroll, so the control exists in
    // layout but no user can ever see or reach it. Out-of-flow boxes are only
    // clipped by their CONTAINING-BLOCK chain: position:fixed escapes ordinary
    // ancestors entirely, and position:absolute skips static ones — a dropdown
    // panel deliberately escaping its clipping wrapper is NOT unreachable.
    // A scrolling ancestor reveals what it holds: past one, what the user can
    // see is that scroller's box, so it is the scroller's box (not the
    // element's) that the clipping ancestors above it are tested against.
    let clippedByAncestor = false;
    if (elStyle.position !== "fixed") {
      let escaping = elStyle.position === "absolute";
      const box = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      let anc = el.parentElement;
      while (anc && anc !== document.body && anc.tagName !== "HTML") {
        const as = window.getComputedStyle(anc);
        if (escaping) {
          const establishes = as.position !== "static" || as.transform !== "none" || as.filter !== "none" || (as.willChange || "").indexOf("transform") >= 0;
          if (!establishes) { anc = anc.parentElement; continue; }
          escaping = false;
        }
        const oy = as.overflowY, ox = as.overflowX;
        const ar = anc.getBoundingClientRect();
        if (ar.width > 0 && ar.height > 0) {
          let hidden = null;
          let scrolls = false;
          // A scroller reveals anything it holds on that axis. Not tested
          // against its scroll range: reversed flex columns (chat logs) and
          // right-to-left text scroll to negative offsets.
          if (oy === "auto" || oy === "scroll") { box.top = ar.top; box.bottom = ar.bottom; scrolls = true; }
          else if ((oy === "hidden" || oy === "clip") && (box.bottom <= ar.top || box.top >= ar.bottom)) hidden = "y";
          if (ox === "auto" || ox === "scroll") { box.left = ar.left; box.right = ar.right; scrolls = true; }
          else if ((ox === "hidden" || ox === "clip") && (box.right <= ar.left || box.left >= ar.right)) hidden = "x";
          if (hidden) {
            // A pager beside the container (next/previous, numbered slides, or
            // a control naming it in aria-controls) reveals what it clips.
            if (!revealedByControl(anc, hidden)) clippedByAncestor = true;
            break;
          }
          // Above a scroller, clipping follows the SCROLLER's containing chain.
          if (scrolls) {
            if (as.position === "fixed") break;
            if (as.position === "absolute") escaping = true;
          }
        }
        anc = anc.parentElement;
      }
    }
    // Parked above or left of the page: can taking focus bring it back?
    const docX = rect.x + window.scrollX, docY = rect.y + window.scrollY;
    const offPage = docX + rect.width <= 0 || docY + rect.height <= 0;
    const focusable = el.tabIndex >= 0 && el.disabled !== true;
    const named = nameOf(el);
    const interactive = isInteractive(el);
    const checkable = tag === "input" && (inputType === "checkbox" || inputType === "radio");
    out.push({
      coveredBy: coveredByPinnedChrome(el, rect, role),
      focusable,
      focusMoves: offPage && focusable ? focusMoves(el) : false,
      // pointer-events:none lets every click through: it cannot take one meant for something else.
      passThrough: elStyle.pointerEvents === "none",
      // A text field's side padding, where an adornment (a clear button, an icon) is meant to sit.
      fieldPad: tag === "textarea" || (tag === "input" && /^(textbox|combobox|searchbox|spinbutton)$/.test(role))
        ? { l: parseFloat(elStyle.paddingLeft) || 0, r: parseFloat(elStyle.paddingRight) || 0 }
        : null,
      tag,
      role,
      name: named.name,
      ...policyText(el),
      nameFrom: named.from,
      testid: el.getAttribute("data-testid"),
      interactive,
      ariaHidden: el.closest('[aria-hidden="true"]') !== null,
      liveOnly: !el.matches(controlSelector),
      state: {
        pressed: el.getAttribute("aria-pressed"),
        selected: el.getAttribute("aria-selected"),
        checked: checkable ? String(el.checked) : el.getAttribute("aria-checked"),
        expanded: el.getAttribute("aria-expanded"),
        current: el.getAttribute("aria-current"),
      },
      // Only controls: a tagged cell or row out of view is not something the user has to reach.
      scrolledOutIn: elStyle.position === "fixed" || clippedByAncestor || !interactive ? null : scrolledOutIn(el, rect),
      xpath: xpathOf(el),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      href: tag === "a" ? el.getAttribute("href") : null,
      clipped: clippedByAncestor,
      ...layerAndChrome(el),
      // DOCUMENT coordinates, not viewport: after scrolling, viewport-relative
      // rects made every above-the-fold header element look "off-screen".
      rect: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    });
    if (out.length >= 150) break;
  }
  return out;
})()`;

/**
 * Roles that announce content rather than take input: a live region is empty
 * until it has something to say, and ARIA does not require it to have a name.
 * Reporting an empty status line as an unnamed control sent lanes to file it
 * as an accessibility defect — twice in one measured run.
 */
const LIVE_REGION_ROLES = new Set(["status", "alert", "log", "timer", "marquee"]);

/**
 * Where a field's shown name came from when it is not a label (the collector's
 * nameFrom): its placeholder, or its name attribute or type. Absent or null
 * when the name is a real one.
 */
export type NameFrom = "placeholder" | "fallback";

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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One control as the geometry oracles read it (the collector's record, plus the snapshot's ref). */
export interface GeometryElement {
  ref: string;
  name: string;
  role: string;
  xpath: string;
  rect: Rect;
  clipped?: boolean;
  layer?: number;
  chrome?: boolean;
  coveredBy?: string | null;
  /** A link's href as written, or null. */
  href?: string | null;
  /** Reachable by Tab. */
  focusable?: boolean;
  /** Matched by a :focus rule that moves or resizes it (read only for boxes off the page). */
  focusMoves?: boolean;
  /** pointer-events:none: clicks pass through it. */
  passThrough?: boolean;
  /** A text field's left and right padding in px, or null for anything else. */
  fieldPad?: { l: number; r: number } | null;
  /** The horizontally scrolling container it sits outside the visible width of, when it does. */
  scrolledOutIn?: string | null;
}

/**
 * Whether a box parked off the page comes back when it takes focus: a skip
 * link. Either a link into this same document (the skip-link shape), or any
 * focusable element a :focus rule moves. It must be reachable by Tab, or
 * nothing ever brings it back.
 */
export function revealedOnFocus(el: Pick<GeometryElement, "href" | "focusable" | "focusMoves">): boolean {
  if (!el.focusable) return false;
  return IN_PAGE_ANCHOR.test(el.href ?? "") || el.focusMoves === true;
}

/**
 * Whether `other` is an adornment of the text field `field`: a clear button or
 * icon lying wholly inside the padding the field reserves at its left or right
 * edge. Text never runs under that padding, so nothing collides. An element
 * that reaches into the text area is a real collision and is not an adornment.
 */
export function isFieldAdornment(field: Pick<GeometryElement, "rect" | "fieldPad">, other: Pick<GeometryElement, "rect">): boolean {
  const pad = field.fieldPad;
  if (!pad) return false;
  const f = field.rect;
  const r = other.rect;
  const t = 4; // borders, and rounding to whole pixels
  if (r.y < f.y - t || r.y + r.h > f.y + f.h + t) return false;
  const inLeft = pad.l > 0 && r.x >= f.x - t && r.x + r.w <= f.x + pad.l + t;
  const inRight = pad.r > 0 && r.x >= f.x + f.w - pad.r - t && r.x + r.w <= f.x + f.w + t;
  return inLeft || inRight;
}

/** Roles of the controls a click is aimed at; anything else with pointer-events:none is decoration. */
const CONTROL_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "file",
  "searchbox",
  "spinbutton",
  "slider",
  "option",
]);

/** Whether `overlay` is a decorative layer over `other` that lets clicks through to it. */
export function isPassThroughOverlay(overlay: Pick<GeometryElement, "rect" | "role" | "passThrough">, other: Pick<GeometryElement, "rect">): boolean {
  return overlay.passThrough === true && !CONTROL_ROLES.has(overlay.role) && overlay.rect.w * overlay.rect.h >= other.rect.w * other.rect.h;
}

/**
 * Deterministic geometry oracles — the checks people reach for screenshots to
 * do, computed from layout boxes instead: interactables rendered fully outside
 * the viewport, and heavy overlap between non-nested interactables.
 */
export function geometryIssues(elements: GeometryElement[], viewport: { width: number; height: number }): string[] {
  const issues: string[] = [];
  let clippedTotal = 0;
  for (const el of elements) {
    const { x, y, w, h } = el.rect;
    // Rects are DOCUMENT coords: below-the-fold content is normal; unreachable
    // means left/above the document origin, or absurdly far right (no page
    // scrolls 3 viewports horizontally on purpose). A skip link parked there
    // until it takes focus is the accessibility pattern working.
    if (w > 0 && h > 0 && (x + w <= 0 || y + h <= 0 || x >= viewport.width * 3) && !revealedOnFocus(el)) {
      issues.push(`${el.ref} ${el.role} "${el.name}" is rendered outside the reachable page area (${x},${y} ${w}×${h})`);
    }
    // Distinct from below-the-fold: this control's own container hides it and
    // cannot scroll — layout says it exists, no user can ever reach it.
    if (el.clipped && w > 0 && h > 0) {
      clippedTotal += 1;
      if (clippedTotal <= 3) {
        issues.push(
          `${el.ref} ${el.role} "${el.name}" is UNREACHABLE — fully clipped inside an overflow-hidden ancestor (at ${x},${y}; the container cannot scroll to reveal it)`,
        );
      }
    }
  }
  // Cap: one transform-based carousel legitimately clips dozens of off-track
  // slides; an uncapped list floods GEOMETRY and starves the overlap oracle
  // (which shares this list's length budget below).
  if (clippedTotal > 3) {
    issues.push(`…and ${clippedTotal - 3} more controls clipped inside overflow-hidden ancestors`);
  }
  // Pinned controls sitting underneath other pinned chrome (hit-tested in the
  // page; see coveredByPinnedChrome). Reported before the box overlaps because
  // an unclickable Save button outranks two badges touching.
  let coveredTotal = 0;
  for (const el of elements) {
    if (!el.coveredBy) continue;
    coveredTotal += 1;
    if (coveredTotal <= 3) {
      issues.push(
        `${el.ref} ${el.role} "${el.name}" is COVERED by pinned chrome ${el.coveredBy} at this scroll position — a click aimed at it lands on that element instead`,
      );
    }
  }
  if (coveredTotal > 3) issues.push(`…and ${coveredTotal - 3} more pinned controls covered by other pinned chrome`);
  // Controls a horizontally scrolling container holds outside its visible
  // width (the last column of a wide table): reachable by a sideways scroll,
  // but nothing on screen says they are there. One line per container, since
  // a table repeats its row actions; a layout choice, so worded as one.
  const sideways = new Map<string, number>();
  for (const el of elements) {
    if (el.scrolledOutIn && el.rect.w > 0 && el.rect.h > 0) sideways.set(el.scrolledOutIn, (sideways.get(el.scrolledOutIn) ?? 0) + 1);
  }
  for (const [container, n] of [...sideways].slice(0, 2)) {
    issues.push(
      `${n} control${n === 1 ? " is" : "s are"} scrolled out of view inside a horizontally scrolling container ${container} — only a sideways scroll of it shows ${n === 1 ? "it" : "them"}; worth a look at this width, not necessarily a defect`,
    );
  }
  if (sideways.size > 2) issues.push(`…and ${sideways.size - 2} more horizontally scrolling containers holding controls out of view`);
  const overlapArea = (a: Rect, b: Rect): number => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  outer: for (let i = 0; i < elements.length && issues.length < 8; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      // Nested elements legitimately overlap (wrapper + button).
      if (a.xpath.startsWith(b.xpath) || b.xpath.startsWith(a.xpath)) continue;
      // Different positioning/scroll LAYERS are stacked by design (a modal over
      // the page, a scrolled list panel beside another) — their document-coord
      // rects "overlap" without colliding.
      if ((a.layer ?? 0) !== (b.layer ?? 0)) continue;
      // Two pieces of fixed/sticky CHROME overlapping is almost always intended
      // layering (a sticky footer riding over the nav list it pins). Real
      // collision bugs that matter live in the content flow, not the chrome.
      if (a.chrome && b.chrome) continue;
      // An overlay with pointer-events:none cannot take a click meant for what
      // it lies over. Only a non-control at least as large as the other counts:
      // design systems also set it on disabled buttons, and a disabled button
      // drawn over another is still a collision.
      if (isPassThroughOverlay(a, b) || isPassThroughOverlay(b, a)) continue;
      // A clear button or icon inside a text field's reserved padding.
      if (isFieldAdornment(a, b) || isFieldAdornment(b, a)) continue;
      const area = overlapArea(a.rect, b.rect);
      const smaller = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
      if (smaller > 0 && area / smaller > 0.6) {
        issues.push(`${a.ref} "${a.name}" overlaps ${b.ref} "${b.name}" (${Math.round((area / smaller) * 100)}%)`);
        if (issues.length >= 8) break outer;
      }
    }
  }
  return issues;
}

/**
 * Images that failed to load, read from the DOM rather than from the network.
 *
 * A 404 on an image already shows up as an HTTP violation, but a broken image
 * is not always a failed request: a 200 that returns an HTML error page, a
 * truncated upload, a wrong content type or a blocked cross-origin file all
 * respond successfully and still render as the browser's broken-image icon.
 * `complete` with no intrinsic size is what "the browser gave up" looks like.
 * SVGs are skipped: one without intrinsic dimensions reports 0×0 while
 * rendering correctly.
 */
export const BROKEN_IMAGES_SCRIPT = `(() => {
  const images = [];
  let total = 0;
  for (const img of Array.from(document.images)) {
    const src = img.currentSrc || img.getAttribute("src") || "";
    if (!src || src.indexOf("data:") === 0 || /\\.svg(\\?|#|$)/i.test(src)) continue;
    if (!img.complete || img.naturalWidth > 0 || img.naturalHeight > 0) continue;
    // Visible means it occupies space. The box test is what catches an image
    // inside a display:none ANCESTOR (a closed modal, an inactive tab): display
    // is not inherited, so the image's own computed style still says "inline".
    // It also drops tracking pixels, whose endpoint answers 204 by design.
    const r = img.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue;
    const cs = window.getComputedStyle(img);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    total += 1;
    if (images.length < 20) images.push({ alt: (img.getAttribute("alt") || "").trim().slice(0, 80), src: src.slice(0, 160), testid: img.getAttribute("data-testid") });
  }
  return { images, total };
})()`;

/**
 * What the page's main region holds besides controls, read in the page: its
 * first heading, its paragraphs and how much static text it has. A main area
 * with a heading and an empty-state sentence lists no controls, and without
 * this it reads exactly like a main area that rendered nothing.
 *
 * The region is the `<main>` or `[role=main]` landmark; without one, the body
 * less its banner, navigation, complementary and footer regions. Static text
 * is visible text outside controls (links, buttons, fields, options), so a
 * page of nothing but a nav does not count as having content. The text walk
 * stops after 5000 text nodes.
 */
export const MAIN_REGION_SCRIPT = `(() => {
  const shown = (n) => !!n && (n.offsetWidth > 0 || n.offsetHeight > 0 || n.getClientRects().length > 0) && window.getComputedStyle(n).visibility !== "hidden";
  const landmarks = Array.from(document.querySelectorAll('main, [role="main"]')).filter(shown);
  const landmark = landmarks[0] || null;
  const region = landmark || document.body;
  if (!region) return { landmark: false, heading: null, paragraphs: 0, chars: 0, controls: 0, media: 0, states: [], rest: 0, text: "" };
  const CHROME = 'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [role="complementary"]';
  const outside = (n) => !landmark && !!n.closest(CHROME);
  const CONTROL = 'a[href], button, input, select, textarea, option, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="combobox"]';
  const inRegion = (sel) => Array.from(region.querySelectorAll(sel)).filter((n) => shown(n) && !outside(n));
  const headings = inRegion('h1, h2, h3, h4, h5, h6, [role="heading"]').filter((n) => (n.textContent || "").trim());
  const h = headings.find((n) => n.tagName === "H1") || headings[0] || null;
  const level = h ? (/^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute("aria-level") || 2)) : 0;
  const heading = h ? { level, text: (h.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60) } : null;
  const paragraphs = inRegion("p").filter((n) => (n.textContent || "").trim()).length;
  // Status regions: an alert, a live status, a busy or progress marker. What lies outside
  // them is the page's own content; a main area with none is showing only its state.
  const STATE = '[role="alert"], [role="status"], [aria-busy="true"], [role="progressbar"]';
  const stateOf = (n) => {
    const s = n.closest(STATE);
    return s && (s === region || region.contains(s)) ? s : null;
  };
  const states = [];
  for (const s of [region, ...inRegion(STATE)]) {
    if (!s.matches(STATE)) continue;
    const role = s.getAttribute("role");
    const kind = role === "alert" || role === "status" || role === "progressbar" ? role : "busy";
    if (!states.includes(kind)) states.push(kind);
    if (s.getAttribute("aria-busy") === "true" && !states.includes("busy")) states.push("busy");
  }
  let chars = 0;
  let rest = 0;
  let text = "";
  let seen = 0;
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t && seen < 5000; t = walker.nextNode()) {
    seen += 1;
    const parent = t.parentElement;
    if (!parent || parent.closest('script, style, noscript, template, [aria-hidden="true"]') || parent.closest(CONTROL) || outside(parent) || !shown(parent)) continue;
    const words = (t.textContent || "").replace(/\\s+/g, " ").trim();
    chars += words.length;
    if (!stateOf(parent)) rest += words.length;
    if (words && text.length < 160) text = (text ? text + " " + words : words).slice(0, 160);
  }
  const controls = inRegion(CONTROL);
  const media = inRegion("img, svg, video, canvas, iframe, object, embed");
  rest += [...headings, ...controls, ...media].filter((n) => !stateOf(n)).length;
  return {
    landmark: !!landmark,
    heading,
    paragraphs,
    chars,
    controls: controls.length,
    media: media.length,
    states,
    rest,
    text,
  };
})()`;

/** What MAIN_REGION_SCRIPT reports. */
export interface MainRegion {
  /** A `<main>`/`[role=main]` landmark was found; false means the body less its chrome was read instead. */
  landmark: boolean;
  heading: { level: number; text: string } | null;
  paragraphs: number;
  chars: number;
  controls: number;
  media: number;
  /**
   * The status regions in the area: `alert`, `status` (a live status), `busy`
   * (`aria-busy="true"`) and `progressbar`, each named once. Absent from an older reading.
   */
  states?: string[];
  /** How much lies outside those regions: characters of static text, plus one per heading, control or image. */
  rest?: number;
  /** The area's static text, its first 160 characters, whitespace collapsed. */
  text?: string;
}

/**
 * Whether text says only that something is on its way, e.g. "Loading…",
 * "Loading orders...", "Please wait", once or repeated. Each sentence must
 * open with the loading words and stay short.
 */
function isLoadingText(text: string): boolean {
  const parts = text
    .split(/\.{1,3}|…/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^(?:loading|please wait)\b[^!?]{0,30}$/i.test(p));
}

/**
 * What a main area holding nothing but its state is showing, or null when it
 * holds content of its own. A client-rendered app answers 200 for a path it
 * does not have and draws its not-found or error view; a route still waiting
 * on data after the page settled shows only a placeholder. Both read as a
 * healthy page to a status code and an element count.
 *
 * - `error`: everything in the area is inside a `role="alert"` region that says something.
 * - `loading`: everything is inside an `aria-busy="true"` region or a
 *   progress bar, or inside a live status whose only words are a loading
 *   message or that holds only a spinner, or (with no such marker at all)
 *   the area's only words are a loading message.
 *
 * A live status saying anything else ("No orders yet") is an empty state,
 * which is content, and so is an alert beside a heading or a control.
 */
export function mainState(m: MainRegion): "error" | "loading" | null {
  const states = m.states ?? [];
  const text = (m.text ?? "").trim();
  if (states.length === 0) {
    return !m.heading && m.controls === 0 && m.media === 0 && isLoadingText(text) ? "loading" : null;
  }
  if ((m.rest ?? 1) > 0) return null;
  // An alert with nothing in it is a live region waiting for a message, not a message.
  if (states.includes("alert") && text !== "") return "error";
  if (states.includes("busy") || states.includes("progressbar")) return "loading";
  // A spinner inside a status, or a status saying it is loading; an empty one alone is just an empty main area.
  return states.includes("status") && (isLoadingText(text) || (text === "" && m.media > 0)) ? "loading" : null;
}

/** Nothing at all in the region: no heading, no text, no control, no image or embed. */
function mainIsEmpty(m: MainRegion): boolean {
  return !m.heading && m.chars === 0 && m.controls === 0 && m.media === 0;
}

/**
 * The snapshot's one line on the main region, e.g.
 * `main: h1 "Orders" · 2 paragraphs · 180 chars of static text`, or
 * `main: EMPTY`. Named `content` when the page has no main landmark.
 */
export function mainRegionLine(m: MainRegion): string {
  const where = m.landmark ? "main" : "content (no main landmark)";
  if (mainIsEmpty(m)) return `${where}: EMPTY`;
  const parts = [
    m.heading ? `h${m.heading.level} "${m.heading.text}"` : null,
    m.paragraphs > 0 ? `${m.paragraphs} paragraph${m.paragraphs === 1 ? "" : "s"}` : null,
    m.chars > 0 ? `${m.chars} chars of static text` : "no static text",
  ].filter(Boolean);
  return `${where}: ${parts.join(" · ")}`;
}

/** The same in a crawl line's few words: `main 180 chars`, or `main EMPTY`. */
export function mainRegionTag(m: MainRegion): string {
  const where = m.landmark ? "main" : "content";
  return mainIsEmpty(m) ? `${where} EMPTY` : `${where} ${m.chars} chars`;
}

export interface BrokenImage {
  alt: string;
  src: string;
  testid: string | null;
}

/** What the page script returns: up to 20 images, and how many there were in all. */
export interface BrokenImageScan {
  images: BrokenImage[];
  total: number;
}

/** The frame an element was collected from, when it is not the page itself. */
export interface FrameTag {
  url: string;
  /** The frame document's origin, or "" when it has no web address (about:blank, srcdoc). */
  origin: string;
  /** The <iframe> element's title or name. */
  title: string;
  /** Of another origin than the app's (policy.ts foreignFrameOrigin). */
  foreign: boolean;
}

/**
 * An element's coverage key inside a frame: the frame's origin (another site)
 * or path (the app's own) before the element's own key, so a "Submit" in an
 * embed is not the page's "Submit". Elements of the page itself keep their key
 * unchanged, so pages without frames keep the coverage they had.
 */
export function frameElementKey(baseKey: string, frame: FrameTag | undefined): string {
  if (!frame) return baseKey;
  let where = frame.origin || frame.url;
  if (!frame.foreign) {
    try {
      const u = new URL(frame.url);
      // A frame with no web address (srcdoc, about:blank) is told apart by its title.
      where = u.protocol === "http:" || u.protocol === "https:" ? u.pathname : `${frame.url}#${frame.title}`;
    } catch {
      where = `${frame.url}#${frame.title}`;
    }
  }
  return `frame:${where}|${baseKey}`;
}

/** The longest name kept for a control in another site's frame: a chat that renders messages as buttons would otherwise print them whole. */
export const MAX_FOREIGN_NAME = 40;

/** A control's name from another site's frame, cut to MAX_FOREIGN_NAME. */
export function capForeignName(name: string): string {
  return name.length > MAX_FOREIGN_NAME ? `${name.slice(0, MAX_FOREIGN_NAME)}…` : name;
}

/** A link's address from another site's frame without its query and fragment, where tokens and addresses travel. */
export function stripForeignHref(href: string): string {
  try {
    const u = new URL(href);
    return u.origin + u.pathname;
  } catch {
    return href.split(/[?#]/)[0];
  }
}

/**
 * A rect read inside a frame, in the page's document coordinates: the frame
 * element's box on screen, less the frame's own scroll, plus the page's.
 */
export function frameToPageRect(rect: Rect, box: { x: number; y: number }, frameScroll: { x: number; y: number }, pageScroll: { x: number; y: number }): Rect {
  return { ...rect, x: rect.x + box.x + pageScroll.x - frameScroll.x, y: rect.y + box.y + pageScroll.y - frameScroll.y };
}

/** How a snapshot line names the frame an element is in. */
export function frameLabel(frame: FrameTag): string {
  let where = frame.url;
  if (!frame.foreign) {
    try {
      const u = new URL(frame.url);
      where = u.pathname + u.search;
    } catch {
      /* shown as it is */
    }
  } else if (frame.origin) where = frame.origin;
  return `${frame.foreign ? "cross-origin" : "same-origin"} frame ${where.slice(0, 80)}${frame.title ? ` "${frame.title.slice(0, 40)}"` : ""}`;
}

/**
 * Whether an element's name, read from another site's frame, is masked. A
 * name taken from a container's text — a select's options, a textarea's
 * contents, a tagged <div> — can carry other people's data (a support chat,
 * a customer record) into the snapshot, the transcript and the report. The
 * label of a link, a button or a field is the interface itself and is kept:
 * the agent needs it to act.
 */
export function masksForeignName(tag: string, role: string): boolean {
  if (tag === "a" || tag === "button" || tag === "input") return false;
  return !/^(button|link|tab|menuitem|checkbox|switch|radio)$/.test(role);
}

/** The name shown for a masked element. */
export const MASKED_NAME = "(content masked: another site's frame)";

/** One frame directly under the page, read from its <iframe> element. */
export interface FrameInfo {
  url: string;
  /** The element's title, or its name when it has no title. */
  title: string;
  width: number;
  height: number;
  /** Of another origin than the app, by the write policy's own test (policy.ts foreignFrameOrigin). */
  foreign: boolean;
}

/** A frame smaller than this in both directions is plumbing (a tracking pixel, a messaging bridge), not something a user sees. */
const VISIBLE_FRAME_PX = 2;

/**
 * The snapshot's account of the page's frames: what is embedded, where it
 * comes from, and whether its controls were read (`read`, by frame URL) —
 * a page that shows its form in an embed used to look like a page with no
 * form at all. Without `read`, nothing was looked inside. `nested` counts
 * frames that are not read: nested inside others, or past the first 30; `writesRefused` is false only in
 * destructive mode, where a foreign frame's writes do go out.
 */
export function frameLines(
  appUrl: string,
  frames: readonly FrameInfo[],
  opts: { nested?: number; writesRefused?: boolean; read?: ReadonlySet<string>; trustedWrites?: ReadonlySet<string> } = {},
): string[] {
  const visible = frames.filter((f) => f.width >= VISIBLE_FRAME_PX && f.height >= VISIBLE_FRAME_PX);
  const hidden = frames.length - visible.length;
  const nested = opts.nested ?? 0;
  if (frames.length === 0 && nested === 0) return [];
  let app = "";
  try {
    app = new URL(appUrl).origin;
  } catch {
    /* no origin: paths are shown in full */
  }
  const lines = visible.slice(0, 10).map((f) => {
    let where = f.url || "(no address)";
    try {
      const u = new URL(f.url);
      if (u.origin === app) where = u.pathname + u.search;
    } catch {
      /* about:blank, srcdoc: shown as they are */
    }
    const label = f.title ? ` "${f.title.slice(0, 60)}"` : "";
    let frameOrigin = "";
    try {
      frameOrigin = new URL(f.url).origin;
    } catch {
      /* no origin */
    }
    const writes = f.foreign
      ? opts.writesRefused === false
        ? " — its writes go out (destructive mode)"
        : opts.trustedWrites?.has(frameOrigin)
          ? " — trusted embed: its writes go out (safe-write)"
          : " — writes it sends outside the app are refused"
      : "";
    const read = opts.read ? (opts.read.has(f.url) ? " — controls listed above" : " — not read") : "";
    return `  ${f.foreign ? "cross-origin" : "same-origin"} ${where.slice(0, 120)}${label} ${f.width}×${f.height}${read}${writes}`;
  });
  if (visible.length > 10) lines.push(`  … +${visible.length - 10} more`);
  if (hidden > 0) lines.push(`  (+${hidden} hidden frame${hidden === 1 ? "" : "s"})`);
  if (nested > 0) lines.push(`  (+${nested} more frame${nested === 1 ? "" : "s"}, nested inside those or past the first 30, not read)`);
  const header =
    opts.read && opts.read.size > 0
      ? "FRAMES — the controls of each frame read are listed above, marked ⟨in … frame⟩, and can be acted on by ref" +
        (visible.some((f) => f.foreign)
          ? "; in another site's frame, content is masked and hostile input, repeated-click probes and uploads are refused"
          : "") +
        ":"
      : "FRAMES not explored — their controls are not listed above and cannot be acted on:";
  return [header, ...lines];
}

/** Whether any frame on the page is one a user can see. */
export function hasVisibleFrame(frames: readonly FrameInfo[]): boolean {
  return frames.some((f) => f.width >= VISIBLE_FRAME_PX && f.height >= VISIBLE_FRAME_PX);
}

/** Snapshot lines for images that failed to load. The origin is dropped when it is the page's own, to keep the line short. */
export function brokenImageIssues(scan: BrokenImageScan, pageUrl: string): string[] {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* an unparseable page URL just means the full src is shown */
  }
  // Only a real origin match: "http://x" is also a prefix of "http://x.other.test/a.png".
  const short = (src: string): string => (origin && (src === origin || src.startsWith(`${origin}/`)) ? src.slice(origin.length) || "/" : src);
  const lines = scan.images.slice(0, 5).map((img) => {
    const name = img.alt ? `"${img.alt}"` : "(no alt text)";
    return `image ${name}${img.testid ? ` [testid=${img.testid}]` : ""} FAILED TO LOAD — ${short(img.src)}`;
  });
  const total = Math.max(scan.total, scan.images.length);
  if (total > 5) lines.push(`…and ${total - 5} more images that failed to load`);
  return lines;
}
