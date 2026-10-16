/**
 * The geometry oracles: pure functions over the layout boxes the collector
 * reads, so their rules can be table-tested without a browser.
 */

/**
 * An href that points at a place in this same document: "#main". Not a bare
 * "#", and not a hash route ("#/reports", "#!/reports"), which is navigation.
 * The collector carries a literal copy; oracle-test holds the two equal.
 */
export const IN_PAGE_ANCHOR = /^#(?![/!])./;

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
