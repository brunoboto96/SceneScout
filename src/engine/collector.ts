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
 * Anything that plausibly presents as a modal/dialog panel. Deliberately wider
 * than the ARIA set: a hand-rolled role-less modal must still count as "an
 * overlay is up", or the scroll-lock oracle files a false leaked-lock finding
 * against every healthy modal that locks the page behind it.
 */
export const DIALOG_LIKE_SEL = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]';
// Declared above the collector script because that script interpolates it.

/**
 * Page-side interactable collector. Shipped as a STRING, not a function:
 * loader transforms (tsx/vitest esbuild hooks inject a `__name` helper) break
 * serialized functions inside the browser, where the helper doesn't exist.
 * A string expression is immune to any build/loader instrumentation.
 */
export const COLLECT_INTERACTABLES_SCRIPT = `(() => {
  const xpathOf = (el) => {
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
  };
  const visible = ${VISIBLE_SRC};
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    // aria-labelledby before any fallback: it is the standard way to name an
    // icon-only control from adjacent text, and skipping it made exactly those
    // buttons report an empty name — which then read as an a11y defect the app
    // did not actually have, and made the element harder to target.
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const named = labelledBy
        .split(/\\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n && n.textContent ? n.textContent.trim() : "";
        })
        .filter(Boolean)
        .join(" ");
      if (named) return named.replace(/\\s+/g, " ").slice(0, 80);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const id = el.getAttribute("id");
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label && label.textContent) return label.textContent.trim();
      }
      return (el.getAttribute("placeholder") || el.getAttribute("name") || el.type || "input").trim();
    }
    const text = el.innerText || el.textContent || "";
    return text.trim().replace(/\\s+/g, " ").slice(0, 80);
  };
  const selector =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], ' +
    '[role="menuitem"], [role="checkbox"], [role="switch"], [role="combobox"], [onclick], [data-testid]';
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
  //  - the control must be pinned with NO scrollable ancestor in between, or
  //    scrolling that pane would simply bring it out from under;
  //  - dialogs and anything covering half the viewport are overlays, not
  //    chrome (the overlay oracle owns those).
  const INTERACTIVE_ROLES = ["button", "link", "textbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "file"];
  const pinnedRootOf = (node, stopAtScroller) => {
    for (let n = node; n && n !== document.documentElement; n = n.parentElement) {
      const cs = window.getComputedStyle(n);
      // The scroller test comes FIRST: a pane that is both sticky and
      // scrollable pins itself, not its rows — they scroll inside it.
      if (stopAtScroller && n !== node && /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) return null;
      if (cs.position === "fixed" || cs.position === "sticky") return n;
    }
    return null;
  };
  const describe = (node) => {
    const tid = node.getAttribute("data-testid");
    if (tid) return "[" + tid + "]";
    const text = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return "<" + node.tagName.toLowerCase() + ">" + (text ? ' "' + text + '"' : "");
  };
  const coveredByPinnedChrome = (el, rect, role) => {
    if (INTERACTIVE_ROLES.indexOf(role) === -1) return null;
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;
    const ownRoot = pinnedRootOf(el, true);
    if (!ownRoot) return null;
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    const coverRoot = pinnedRootOf(top, false);
    if (!coverRoot || coverRoot === ownRoot || coverRoot.contains(ownRoot) || ownRoot.contains(coverRoot)) return null;
    if (coverRoot.closest('${DIALOG_LIKE_SEL}')) return null;
    const cr = coverRoot.getBoundingClientRect();
    if (cr.width * cr.height > window.innerWidth * window.innerHeight * 0.5) return null;
    return describe(coverRoot);
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
        : "generic");
    const rect = el.getBoundingClientRect();
    // Below-the-fold is reachable (scroll); clipped INSIDE an overflow-hidden
    // ancestor is not — the container cannot scroll, so the control exists in
    // layout but no user can ever see or reach it. Out-of-flow boxes are only
    // clipped by their CONTAINING-BLOCK chain: position:fixed escapes ordinary
    // ancestors entirely, and position:absolute skips static ones — a dropdown
    // panel deliberately escaping its clipping wrapper is NOT unreachable.
    const ePos = window.getComputedStyle(el).position;
    let clippedByAncestor = false;
    if (ePos !== "fixed") {
      let escaping = ePos === "absolute";
      let anc = el.parentElement;
      while (anc && anc !== document.body && anc.tagName !== "HTML") {
        const as = window.getComputedStyle(anc);
        if (escaping) {
          const establishes = as.position !== "static" || as.transform !== "none" || as.filter !== "none" || (as.willChange || "").indexOf("transform") >= 0;
          if (!establishes) { anc = anc.parentElement; continue; }
          escaping = false;
        }
        const oy = as.overflowY, ox = as.overflowX;
        const hidesY = oy === "hidden" || oy === "clip";
        const hidesX = ox === "hidden" || ox === "clip";
        if (hidesY || hidesX) {
          const ar = anc.getBoundingClientRect();
          if (ar.width > 0 && ar.height > 0) {
            const outY = hidesY && (rect.bottom <= ar.top || rect.top >= ar.bottom);
            const outX = hidesX && (rect.right <= ar.left || rect.left >= ar.right);
            if (outY || outX) { clippedByAncestor = true; break; }
          }
        }
        anc = anc.parentElement;
      }
    }
    out.push({
      coveredBy: coveredByPinnedChrome(el, rect, role),
      tag,
      role,
      name: accessibleName(el),
      testid: el.getAttribute("data-testid"),
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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Deterministic geometry oracles — the checks people reach for screenshots to
 * do, computed from layout boxes instead: interactables rendered fully outside
 * the viewport, and heavy overlap between non-nested interactables.
 */
export function geometryIssues(
  elements: Array<{
    ref: string;
    name: string;
    role: string;
    xpath: string;
    rect: Rect;
    clipped?: boolean;
    layer?: number;
    chrome?: boolean;
    coveredBy?: string | null;
  }>,
  viewport: { width: number; height: number },
): string[] {
  const issues: string[] = [];
  let clippedTotal = 0;
  for (const el of elements) {
    const { x, y, w, h } = el.rect;
    // Rects are DOCUMENT coords: below-the-fold content is normal; unreachable
    // means left/above the document origin, or absurdly far right (no page
    // scrolls 3 viewports horizontally on purpose).
    if (w > 0 && h > 0 && (x + w <= 0 || y + h <= 0 || x >= viewport.width * 3)) {
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
