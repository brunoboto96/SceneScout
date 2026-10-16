/**
 * The page-side collector: the script that lists a page's interactables,
 * shipped to the browser as a STRING, and the constants it interpolates.
 *
 * Split out of the engine because none of it needs Playwright. The rest of
 * what the snapshot is built from lives beside it, re-exported here so every
 * importer keeps one entry point: the page-side sources the collector shares
 * with the probes (page-sources.ts), how the snapshot reads the collector's
 * elements (collector-elements.ts), the geometry oracles (geometry.ts), the
 * main region and broken images (page-content.ts) and frames (frames.ts).
 * Keeping them out of browser.ts means the oracle rules — the part that has
 * repeatedly shipped false positives — can be table-tested without launching
 * a browser (see scripts/oracle-test.ts).
 */

import { NAME_SRC, POLICY_TEXT_SRC, VISIBLE_SRC, XPATH_OF_SRC } from "./page-sources.js";

export * from "./page-sources.js";
export * from "./collector-elements.js";
export * from "./geometry.js";
export * from "./page-content.js";
export * from "./frames.js";

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

/** The most elements a snapshot lists in full; past it, what is left is counted (cutSummary). */
export const COLLECTOR_CAP = 150;
/** Pager and "load more" controls listed past the cap, so a lane can still reach the rest of a long list. */
const MAX_KEPT_PAST_CAP = 10;
/** How many elements past the cap are looked at, to keep them or count them, before the rest goes uncounted. */
const MAX_SCANNED_PAST_CAP = 2000;

/**
 * A control that pages a list or loads more of it, by its name: "Next",
 * "Previous page", "Page 3", "»", "Load more", "Show 20 more", "More results".
 * Narrower than PAGER_NAME, which also takes "Item 4" and "Step 2" for a
 * carousel's slides: past the cap, those are the list itself.
 */
export const LIST_PAGER_NAME =
  /^(?:[‹›«»<>←→]|(?:go to )?(?:next|previous|prev|first|last)(?: page)?|(?:go to )?page \d+|(?:load|show|see|view) (?:\d+ )?more\b.*|more results)$/i;

/** A test id that names a pager or a "load more" control: "pager-next", "pagination", "load-more", "next-page". */
export const PAGER_TESTID =
  /(?:^|[-_.:])(?:pager|pagination|paginator|load-?more|show-?more|(?:next|prev|previous)-?page|page-?(?:next|prev|previous))(?:$|[-_.:])/i;

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
  // For an element that is neither a native control nor in a control role:
  // what alone makes it actionable (affordanceFlags). Null for a control.
  const affordancesOf = (el) => {
    if (el.matches('a[href], button, input, select, textarea, summary, [contenteditable="true"], [contenteditable=""]')) return null;
    if (CONTROL_ROLES.test(el.getAttribute("role") || "")) return null;
    const tabindex = el.getAttribute("tabindex");
    const tabStop = tabindex !== null && tabindex.trim() !== "" && Number(tabindex) >= 0;
    const clickHandler = el.hasAttribute("onclick") || typeof el.onclick === "function";
    let pointer = false;
    if (window.getComputedStyle(el).cursor === "pointer") {
      const parent = el.parentElement;
      pointer = !parent || window.getComputedStyle(parent).cursor !== "pointer";
    }
    return { tabStop, clickHandler, pointer };
  };
  const isInteractive = (aff) => aff === null || aff.tabStop || aff.clickHandler || aff.pointer;
  // Past the element cap, a control that pages the list or loads more of it
  // is still listed (up to MAX_KEPT_PAST_CAP), and the rest is only counted.
  const LIST_PAGER = ${String(LIST_PAGER_NAME)};
  const PAGER_TID = ${String(PAGER_TESTID)};
  let keptPastCap = 0;
  let scannedPastCap = 0;
  const cut = [];
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
    if (out.length >= ${COLLECTOR_CAP}) {
      // Past the cap only a bounded number of elements is looked at at all.
      if (++scannedPastCap > ${MAX_SCANNED_PAST_CAP}) { cut.push({ cut: true, uncounted: true }); break; }
      const tid = el.getAttribute("data-testid");
      const said = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
      const pages = LIST_PAGER.test(said) || (tid !== null && PAGER_TID.test(tid));
      if (!pages || keptPastCap >= ${MAX_KEPT_PAST_CAP}) { cut.push({ cut: true, role, testid: tid }); continue; }
      keptPastCap += 1;
    }
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
    const affords = affordancesOf(el);
    const interactive = isInteractive(affords);
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
      ...(named.priors ? { priorNames: named.priors } : {}),
      testid: el.getAttribute("data-testid"),
      interactive,
      affords: affords && (affords.tabStop || affords.clickHandler || affords.pointer) ? affords : null,
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
  }
  return cut.length > 0 ? out.concat(cut) : out;
})()`;
