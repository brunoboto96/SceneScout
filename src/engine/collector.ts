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
    // An image's name is its alt text. Without this an <img> read as
    // "(unnamed)" even when it was labelled, and a missing alt looked the same
    // as a present one.
    if (tag === "img") return (el.getAttribute("alt") || "").trim().slice(0, 80);
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
  const coveredByPinnedChrome = (el, rect, role) => {
    if (INTERACTIVE_ROLES.indexOf(role) === -1) return null;
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;
    const ownRoot = pinnedRootOf(el);
    if (!ownRoot || insideScrollablePane(el)) return null;
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
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

/**
 * Roles that announce content rather than take input: a live region is empty
 * until it has something to say, and ARIA does not require it to have a name.
 * Reporting an empty status line as an unnamed control sent lanes to file it
 * as an accessibility defect — twice in one measured run.
 */
const LIVE_REGION_ROLES = new Set(["status", "alert", "log", "timer", "marquee"]);

/** Whether an element with this role and no accessible name is an unnamed control, as opposed to a live region with nothing in it yet. */
export function missingName(el: { role: string; name: string }): boolean {
  return !el.name && !LIVE_REGION_ROLES.has(el.role);
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

/** One frame on the page, read from its <iframe> element. */
export interface FrameInfo {
  url: string;
  /** The element's title, or its name when it has no title. */
  title: string;
  width: number;
  height: number;
}

/** A frame smaller than this in both directions is plumbing (a tracking pixel, a messaging bridge), not something a user sees. */
const VISIBLE_FRAME_PX = 2;

/**
 * The snapshot's account of the page's frames. Nothing inside a frame is
 * collected or can be acted on yet, and a page that shows its form in an
 * embed used to look like a page with no form at all: say what is there,
 * where it comes from, and that it was not looked inside.
 */
export function frameLines(appUrl: string, frames: readonly FrameInfo[]): string[] {
  const visible = frames.filter((f) => f.width >= VISIBLE_FRAME_PX && f.height >= VISIBLE_FRAME_PX);
  const hidden = frames.length - visible.length;
  if (visible.length === 0 && hidden === 0) return [];
  let app = "";
  try {
    app = new URL(appUrl).origin;
  } catch {
    /* no origin to compare: every frame reads as foreign */
  }
  const lines = visible.slice(0, 10).map((f) => {
    let where = f.url || "(no address)";
    let foreign = false;
    try {
      const u = new URL(f.url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        foreign = u.origin !== app;
        if (!foreign) where = u.pathname + u.search;
      }
    } catch {
      /* about:blank, srcdoc: shown as they are */
    }
    const label = f.title ? ` "${f.title.slice(0, 60)}"` : "";
    return `  ${foreign ? "cross-origin" : "same-origin"} ${where.slice(0, 120)}${label} ${f.width}×${f.height}${foreign ? " — writes from it are never sent" : ""}`;
  });
  if (visible.length > 10) lines.push(`  … +${visible.length - 10} more`);
  if (hidden > 0) lines.push(`  (+${hidden} hidden frame${hidden === 1 ? "" : "s"})`);
  return [`FRAMES not explored — their controls are not listed above and cannot be acted on:`, ...lines];
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
