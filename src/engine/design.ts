/**
 * Computed-style design audit — visual/UX understanding WITHOUT pixels.
 *
 * The renderer already knows every element's typography, colors, spacing, and
 * geometry. We extract that (one in-page pass) and reduce it to a measurable
 * design digest. Two kinds of output, deliberately distinct:
 *
 *   ⚠  measurable defects — contrast failures, clipped text, tiny targets,
 *      aspect-distorted images, horizontal overflow, missing focus states
 *   →  craft suggestions — line measure, line-height rhythm, palette
 *      discipline (gray census, accent hue count), elevation consistency,
 *      control sizing, heading structure, pure-black body text
 *
 * The suggestion tier is the point of the tool: e2e suites answer "does it
 * work?" as a binary; this answers "how could it be better?" with concrete
 * numbers ("~142ch per line", "9 distinct grays") an LLM can judge with
 * product context and turn into actionable feedback. The heuristics encode
 * the computable subset of studio-craft checklists (impeccable.style et al.):
 * readable measure, breathing line-height, a deliberate spacing scale,
 * limited type sizes, near-black over #000, a gray scale instead of ad-hoc
 * grays, a focused accent palette, one elevation system, consistent
 * controls, visible keyboard focus.
 */

import { missingName, NAME_SRC, placeholderOnly, type NameFrom } from "./collector.js";

export interface StyleRecord {
  tag: string;
  testid: string | null;
  text: string;
  /** Full normalized own-text length (the 50-char `text` is only a label). */
  textLen: number;
  interactive: boolean;
  rect: { x: number; y: number; w: number; h: number };
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  /** Computed line-height in px; 0 when "normal" (unknown ratio). */
  lineHeight: number;
  textTransform: string;
  textAlign: string;
  /** Whether the text decoration includes an underline (link affordance). */
  underline: boolean;
  color: string;
  /**
   * The background the text is read against: one colour when one is known, "varies" when it may be any of
   * `bgRange` (a gradient's stops, or a layer that may or may not lie under it), "image" when a picture
   * paints behind it, and "unknown" when the read could not tell.
   */
  bg: string;
  /** Every colour the text may sit on, when `bg` is "varies" (BG_STACK_SRC). */
  bgRange?: string[];
  padding: [number, number, number, number]; // t r b l
  /** Vertical margins [top, bottom] — the other half of spacing rhythm. */
  marginV: [number, number];
  radius: number;
  /** Computed box-shadow, every layer (capped at 400 characters), or "" — elevation-system consistency; see elevationKey. */
  shadow: string;
  clipped: boolean;
  /**
   * The box a pointer user actually hits to operate this control, when it is
   * not the control's own: a native input together with the label that wraps
   * or touches it, or, for a visually hidden input, the label or clickable
   * container (a drop zone) that operates it. Absent when the target is `rect`.
   */
  target?: { x: number; y: number; w: number; h: number };
  /** position:fixed/sticky — chrome that rides along as the user scrolls. */
  fixed: boolean;
  /** Form-control burden signals: is this a required field, and is it a submit control? */
  required: boolean;
  submitish: boolean;
  /**
   * An interactive element's accessible name and, for a field, where it came
   * from when that is not a label: computed by the snapshot's own rule
   * (page-sources.ts NAME_SRC), so the audit and the snapshot name a control
   * alike. Absent on non-interactive records, which are named by their text.
   */
  name?: string;
  nameFrom?: NameFrom | null;
  /** Inside an aria-hidden subtree: nothing announces it, so it needs no name. */
  ariaHidden?: boolean;
  /** Lowercased `type` of an <input>, "" for any other element: a checkbox, a search box and a submit button are all <input>. */
  inputType: string;
  /** The element's own `role` attribute, "" when it has none. */
  role: string;
  /** Paints its OWN background (colour or image), rather than showing an ancestor's: what makes a link look like a button. */
  filled: boolean;
  /**
   * Where the control sits. The task-efficiency rules mean different things in
   * different places: a checkbox in a table row selects the row, a select in a
   * row edits it in place, a search box filters, and none of them is a form
   * field the user must fill in and submit; a breadcrumb link is navigation, not
   * an action competing with the page's own.
   */
  inForm: boolean;
  inRow: boolean;
  inSearch: boolean;
  inBreadcrumb: boolean;
  /**
   * In, or itself, a control that names itself a filter or facet (a test id,
   * id, aria-label, aria-labelledby or legend containing the word, see
   * FILTER_WORDS_SRC): a filter applies as it changes and asks for nothing.
   */
  inFilter?: boolean;
  /**
   * Inside the app shell's landmarks — a navigation, banner, complementary or
   * content-info region that is not part of the main content, an article or a
   * dialog. The markup states this on the first page audited, so the shell is
   * kept out of a page's score before the cross-route census has seen enough
   * routes to recognise it.
   */
  shell: boolean;
  /** AI-slop tells (impeccable.style's "absolute bans"), computed in-page. */
  sideStripe: boolean; // colored border-left/right accent > 1px
  gradientText: boolean; // background-clip:text over a gradient
  glass: boolean; // decorative backdrop-filter blur + translucent bg
  glow: boolean; // large-blur saturated box-shadow (neon glow)
  aiGradient: boolean; // violet/purple gradient background
}

/** One keyboard-tab stop: did focusing it produce ANY visible style change? */
export interface FocusSample {
  label: string;
  indicator: boolean;
}

/** The part of a document the focus walk reads (a DOM Document, page-side). */
export interface FocusDocument {
  activeElement: FocusElement | null;
  body: unknown;
  documentElement: unknown;
}

/** The part of an element the focus walk reads; `contentDocument` is null for another site's frame. */
export interface FocusElement {
  tagName: string;
  contentDocument?: FocusDocument | null;
}

/**
 * The control a Tab press focused, as the focus-indicator rule measures it. It runs
 * page-side (probes.ts embeds its source), so it is plain JavaScript once compiled.
 *
 * A Tab that lands on an iframe or frame moves focus into the frame's document: the
 * frame element is not the control the user sees focused, and its own outline staying
 * the same says nothing. So the walk follows focus into a same-origin frame and returns
 * the element focused there. It returns "frame" when focus is inside a frame it cannot
 * follow (another site's, whose document is not readable) or a frame whose document has
 * nothing focused: that press is skipped, not sampled. It returns null when nothing in
 * the page is focused, which ends the sampling.
 */
export function focusedControl(doc: FocusDocument): FocusElement | "frame" | null {
  let d = doc;
  let el = d.activeElement;
  while (el && /^i?frame$/i.test(el.tagName)) {
    const inner = el.contentDocument ?? null;
    if (!inner) return "frame";
    d = inner;
    el = inner.activeElement;
  }
  if (!el || el === d.body || el === d.documentElement) return d === doc ? null : "frame";
  return el;
}

interface DesignPagePayload {
  /** Document scroll width vs window width — horizontal overflow detection. */
  scrollW: number;
  clientW: number;
  headings: Array<{ level: number; size: number; text: string }>;
  /** `fit` is the computed object-fit, so a class sets it as surely as an inline style. */
  images: PageImage[];
  /** Interactive elements intersecting the initial viewport — cognitive-density signal. */
  density: number;
  /** Filled engine-side (needs trusted keyboard events, not in-page JS). */
  focusSamples: FocusSample[];
  /** Sibling boxes that paint an edge, grouped by parent: what touchingContainers() reads. Absent from an older collector. */
  boxGroups?: BoxGroup[];
}

/** One child box that paints something of its own: a border, a background or a shadow. Measured in-page, judged by touchingContainers(). */
export interface PaintedBox {
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  /** The widest visible border side, in px; 0 for none. */
  border: number;
  /** Its own computed background colour (normalized rgba), "unknown" when unreadable. */
  bg: string;
  /** The background it sits on: the parent's effective one, or "image"/"unknown". */
  parentBg: string;
  /** Computed box-shadow, or "". */
  shadow: string;
  /** Corner radii in px: top-left, top-right, bottom-right, bottom-left. */
  radii: [number, number, number, number];
}

/** A parent's painted children, in document order, and whether the parent sits in the app shell. */
export interface BoxGroup {
  parent: string;
  shell: boolean;
  boxes: PaintedBox[];
}

export interface DesignPayload {
  records: StyleRecord[];
  page: DesignPagePayload;
}

/**
 * Whether some text names a filter or a facet, as page-side source: one of its
 * words, split at camelCase and punctuation, is filter(s) or facet(s). Whole
 * words only, so "filterable-list" or "unfiltered" says nothing.
 */
const FILTER_WORDS_SRC = `(s) => (s || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).some((w) => w === "filter" || w === "filters" || w === "facet" || w === "facets")`;

/** FILTER_WORDS_SRC run outside a page, from the same source, so a table test exercises the rule the collector ships. */
export function namesFilter(text: string): boolean {
  return (new Function(`return (${FILTER_WORDS_SRC});`)() as (s: string) => boolean)(text);
}

/**
 * The colours a computed `background-image` paints, as page-side source: every
 * colour stop of every layer when each layer is a gradient, or null when any
 * layer is something else (a url(), an image-set()), or names no colour the
 * rule can read. A computed value writes each colour as a function or a hex
 * word, whatever the stylesheet wrote.
 */
const GRADIENT_COLOURS_SRC = `(img) => {
  const split = (s) => {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(s.slice(start).trim());
    return parts;
  };
  const colourFns = ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix"];
  const out = [];
  for (const layer of split(img || "")) {
    const open = layer.indexOf("(");
    if (open < 0 || !layer.endsWith(")") || !/^(repeating-)?(linear|radial|conic)-gradient$/.test(layer.slice(0, open).trim())) return null;
    const body = layer.slice(open + 1, -1);
    let depth = 0, word = "", fnStart = -1, fnName = "";
    for (let i = 0; i <= body.length; i++) {
      const ch = i < body.length ? body[i] : " ";
      if (ch === "(") {
        if (depth === 0) { fnName = word.trim().toLowerCase(); fnStart = i - word.trim().length; }
        depth++; word = "";
      } else if (ch === ")") {
        depth--;
        if (depth === 0 && colourFns.includes(fnName)) out.push(body.slice(fnStart, i + 1));
        word = "";
      } else if (depth === 0 && (ch === " " || ch === ",")) {
        const w = word.trim();
        if (w.startsWith("#") || w.toLowerCase() === "transparent") out.push(w);
        word = "";
      } else if (depth === 0) word += ch;
    }
  }
  return out.length > 0 ? out : null;
}`;

/** GRADIENT_COLOURS_SRC run outside a page, from the same source, so a table test exercises the rule the collector ships. */
export function gradientColours(img: string): string[] | null {
  return (new Function(`return (${GRADIENT_COLOURS_SRC});`)() as (s: string) => string[] | null)(img);
}

/** One layer behind the text, topmost first: the colours it may paint there, and whether it may not lie under the text at all. */
export interface BgLayer {
  cs: Array<[number, number, number, number]>;
  maybe: boolean;
}

/** Past this many colours a text may sit on, its background is "unknown" rather than a list nobody reads. */
const BG_RANGE_CAP = 12;

/**
 * Composite the layers behind a text over the white page canvas, as page-side
 * source: one colour when every layer is certain and paints one colour there,
 * else every colour the text may sit on. A layer that may not be under the
 * text (a pseudo-element or a positioned box whose extent is not known) keeps
 * what lies beneath it as a possibility; a gradient paints one of its stops,
 * or something between them.
 */
const BG_STACK_SRC = `(layers) => {
  let set = [[255, 255, 255]];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const next = layer.maybe ? set.slice() : [];
    for (const b of set) {
      for (const c of layer.cs) {
        const a = c[3];
        next.push([c[0] * a + b[0] * (1 - a), c[1] * a + b[1] * (1 - a), c[2] * a + b[2] * (1 - a)]);
      }
    }
    const seen = new Map();
    for (const c of next) {
      const key = c.map(Math.round).join(",");
      if (!seen.has(key)) seen.set(key, c);
    }
    set = Array.from(seen.values());
    if (set.length > ${BG_RANGE_CAP}) return { bg: "unknown" };
  }
  const fmt = (c) => "rgb(" + Math.round(c[0]) + ", " + Math.round(c[1]) + ", " + Math.round(c[2]) + ")";
  return set.length === 1 ? { bg: fmt(set[0]) } : { bg: "varies", bgRange: set.map(fmt) };
}`;

/** BG_STACK_SRC run outside a page, from the same source. */
export function bgStack(layers: BgLayer[]): { bg: string; bgRange?: string[] } {
  return (new Function(`return (${BG_STACK_SRC});`)() as (l: BgLayer[]) => { bg: string; bgRange?: string[] })(layers);
}

/**
 * In-page collector, shipped as a string expression (immune to loader
 * transforms — same rationale as the interactables collector).
 */
export const DESIGN_COLLECT_SCRIPT = `(() => {
  const out = [];
  const px = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 10) / 10; };
  // Any CSS colour (oklch, lab, color(), named) to [r, g, b, a] in sRGB. A
  // computed colour in rgb() is read as written; Firefox's canvas fillStyle
  // turns the rest into #rrggbb or rgba(), while Chromium's and WebKit's keep
  // lab() and oklch() as written, so those are painted on one pixel and read
  // back. Unreadable is null, and the background read then says "unknown"
  // rather than composite the colour as nothing, over white.
  const cctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const colours = new Map();
  const parseColor = (c) => {
    if (!c || c === "transparent") return null;
    if (colours.has(c)) return colours.get(c);
    let out = null;
    let m = c.match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?/);
    if (!m && cctx) {
      try {
        cctx.fillStyle = "#010203";
        cctx.fillStyle = c;
        const norm = cctx.fillStyle;
        const hex = norm.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        m = norm.match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?/);
        if (hex && (norm !== "#010203" || c === "#010203")) out = [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1];
        else if (!m && norm !== "#010203") {
          // A colour the canvas keeps in its own space (lab(), oklch(), color()), as Chromium and WebKit
          // do: paint one pixel of it and read that back as sRGB. A dark lab() panel read as no colour
          // at all used to leave the text over it measured against the white page.
          cctx.clearRect(0, 0, 1, 1);
          cctx.fillRect(0, 0, 1, 1);
          const d = cctx.getImageData(0, 0, 1, 1).data;
          out = [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
        }
      } catch (e) { /* unreadable — "unknown" to the caller */ }
    }
    if (m) out = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    colours.set(c, out);
    return out;
  };
  // A colour the page set that the read cannot turn into one: not the same as no colour.
  const unreadable = (c) => !!c && c !== "transparent" && parseColor(c) === null;
  const normColor = (c) => {
    const p = parseColor(c);
    return p ? "rgba(" + p[0] + ", " + p[1] + ", " + p[2] + ", " + p[3] + ")" : "unknown";
  };
  const gradientColours = ${GRADIENT_COLOURS_SRC};
  const bgStack = ${BG_STACK_SRC};
  // The parent in the tree that is painted: a slotted element renders inside its slot, and a shadow tree's top inside its host.
  const paintParent = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
  // Whether an element starts a stacking context, so a child with a negative z-index paints over its background, not under it.
  const startsStacking = (n, s) => {
    if (s.isolation === "isolate" || s.opacity !== "1" || s.transform !== "none" || s.position === "fixed" || s.position === "sticky") return true;
    if (s.zIndex !== "auto") {
      if (s.position !== "static") return true;
      const parent = paintParent(n);
      if (parent && parent.nodeType === 1 && /flex|grid/.test(window.getComputedStyle(parent).display)) return true;
    }
    if ((s.filter && s.filter !== "none") || (s.backdropFilter && s.backdropFilter !== "none")) return true;
    if ((s.mixBlendMode && s.mixBlendMode !== "normal") || (s.clipPath && s.clipPath !== "none")) return true;
    if ((s.maskImage && s.maskImage !== "none") || (s.webkitMaskImage && s.webkitMaskImage !== "none")) return true;
    if (/paint|layout|strict|content/.test(s.contain || "") || /opacity|transform|filter|isolation|z-index/.test(s.willChange || "")) return true;
    return false;
  };
  // Replaced content that paints pixels the audit cannot read: an <img>,
  // <picture>, <video> or <canvas>, often absolutely positioned under a hero
  // heading as a sibling or cousin of the text rather than its ancestor.
  let media = null;
  const mediaUnder = (el, within) => {
    if (media === null) media = Array.from(document.querySelectorAll("img, picture, video, canvas")).slice(0, 300);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (const m of media) {
      // The text's own subtree holds inline icons, not its background; and an
      // image outside the opaque ancestor the text sits on is treated as hidden
      // behind it.
      if (el.contains(m) || (within && !within.contains(m))) continue;
      const mr = m.getBoundingClientRect();
      if (mr.width === 0 || mr.height === 0 || cx < mr.left || cx > mr.right || cy < mr.top || cy > mr.bottom) continue;
      const ms = window.getComputedStyle(m);
      if (ms.visibility === "hidden" || ms.display === "none" || ms.opacity === "0") continue;
      return true;
    }
    return false;
  };
  // What one element paints behind its content, read once per element: its
  // background colour, its background image (a gradient's colours, or
  // "image"), and its positioned pseudo-elements that paint a panel, each
  // with its box on the page where the computed style gives one.
  const paints = new Map();
  const paintOf = (node) => {
    const known = paints.get(node);
    if (known) return known;
    const s = window.getComputedStyle(node);
    const img = s.backgroundImage && s.backgroundImage !== "none" ? s.backgroundImage : "";
    const stops = img ? gradientColours(img) : null;
    const stopColours = stops ? stops.map(parseColor) : null;
    const clip = ((s.webkitBackgroundClip || "") + " " + (s.backgroundClip || "")).includes("text");
    // A gradient covers the box only when it is drawn at full size; one sized or placed
    // as a strip (an underline drawn as a gradient) may or may not be under the text.
    const fullSize = /^(auto|auto auto|100% 100%|cover)$/.test((s.backgroundSize || "auto").trim());
    const p = {
      color: unreadable(s.backgroundColor) ? "unknown" : parseColor(s.backgroundColor),
      image: !img ? null : stopColours && stopColours.every((c) => c !== null) ? stopColours : stopColours ? "unknown" : "image",
      imageMaybe: !fullSize,
      // Background clipped to the text paints the glyphs, not what is behind them: gradient text.
      clipText: clip,
      pseudos: [],
    };
    for (const which of ["::after", "::before"]) {
      const ps = window.getComputedStyle(node, which);
      if (!ps || ps.content === "none" || ps.content === "normal" || ps.display === "none") continue;
      if (ps.position !== "absolute" && ps.position !== "fixed") continue;
      if (ps.visibility === "hidden" || ps.opacity === "0") continue;
      const pImg = ps.backgroundImage && ps.backgroundImage !== "none" ? ps.backgroundImage : "";
      const pStops = pImg ? gradientColours(pImg) : null;
      const pColours = pStops ? pStops.map(parseColor) : null;
      const pc = parseColor(ps.backgroundColor);
      let cs = null;
      if (pImg) cs = pColours && pColours.every((c) => c !== null) ? pColours : "image";
      else if (unreadable(ps.backgroundColor)) cs = "unknown";
      else if (pc && pc[3] > 0) cs = [pc];
      if (!cs) continue;
      // A translucent pseudo-element paints its colours at its opacity.
      const o = parseFloat(ps.opacity);
      if (Array.isArray(cs) && o < 1) cs = cs.map((c) => [c[0], c[1], c[2], c[3] * o]);
      // A negative z-index puts it under the element's own background unless the element starts a stacking context.
      const under = parseInt(ps.zIndex, 10) < 0 && !startsStacking(node, s);
      // Moved or clipped (a hover fill scaled to nothing at rest), its box is not where its offsets say.
      const moved = (ps.transform && ps.transform !== "none") || (ps.clipPath && ps.clipPath !== "none");
      const w = px(ps.width) + px(ps.paddingLeft) + px(ps.paddingRight) + px(ps.borderLeftWidth) + px(ps.borderRightWidth);
      const h = px(ps.height) + px(ps.paddingTop) + px(ps.paddingBottom) + px(ps.borderTopWidth) + px(ps.borderBottomWidth);
      const left = parseFloat(ps.left), top = parseFloat(ps.top);
      let box = null;
      // Its offsets are from its containing block: the viewport when fixed, the element itself when the element is positioned.
      if (moved) box = null;
      else if (ps.position === "fixed" && isFinite(left) && isFinite(top)) box = { l: left, t: top, r: left + w, b: top + h };
      else if (s.position !== "static" && isFinite(left) && isFinite(top)) {
        const r = node.getBoundingClientRect();
        const ox = r.left + px(s.borderLeftWidth), oy = r.top + px(s.borderTopWidth);
        box = { l: ox + left, t: oy + top, r: ox + left + w, b: oy + top + h };
      } else if (w < 48 && h < 48) continue; // an icon or a dot of unknown position, not a panel
      p.pseudos.push({ cs, box, under });
    }
    paints.set(node, p);
    return p;
  };
  // Boxes positioned out of the flow that paint a colour or a gradient of
  // their own: a panel laid behind text as its sibling or cousin, not its
  // ancestor. One that paints a picture (a tiled grain or a photo) or blends
  // into what is under it is not read, as before: no colour stands for it.
  let panels = null;
  const panelsAt = (cx, cy) => {
    if (panels === null) {
      panels = [];
      for (const n of document.querySelectorAll("body *")) {
        if (panels.length >= 400) break;
        const s = window.getComputedStyle(n);
        if ((s.position !== "absolute" && s.position !== "fixed") || s.visibility === "hidden" || s.display === "none" || s.opacity === "0") continue;
        if (s.mixBlendMode && s.mixBlendMode !== "normal") continue;
        const p = paintOf(n);
        if (p.image === "image" || p.image === "unknown" || p.color === "unknown") continue;
        const cs = [...(p.image || []), ...(p.color && p.color[3] > 0 ? [p.color] : [])];
        if (cs.length === 0) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        // A translucent panel paints its colours at its opacity.
        const o = parseFloat(s.opacity);
        panels.push({ n, r, cs: o < 1 ? cs.map((c) => [c[0], c[1], c[2], c[3] * o]) : cs, sunk: parseInt(s.zIndex, 10) < 0 });
      }
    }
    return panels.filter(({ r }) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom);
  };
  // A panel with a negative z-index paints beneath every background in its
  // stacking context, so under the opaque box the text sits on unless that box,
  // or a box between them, starts a stacking context of its own. The root's
  // background, or the body's when the root sets none, is the page canvas,
  // which every panel paints over.
  const stackedWithin = (n, top) => {
    const root = document.documentElement;
    if (top === root) return true;
    if (top === document.body) {
      const rs = window.getComputedStyle(root);
      const rc = parseColor(rs.backgroundColor);
      if ((!rc || rc[3] === 0) && rs.backgroundImage === "none") return true;
    }
    for (let a = paintParent(n); a; a = paintParent(a)) {
      if (a.nodeType === 1 && startsStacking(a, window.getComputedStyle(a))) return true;
      if (a === top) return false;
    }
    return false;
  };
  // Effective background: COMPOSITE the layers behind the text (a chip with
  // rgba(...,0.12) over white is nearly white — treating it as opaque produces
  // false WCAG failures), up the painted tree to the first opaque layer, over
  // the white page canvas. Each element contributes its pseudo-element panels
  // under the text's centre, then its background image, then its colour. A
  // gradient is every colour of its stops; a pseudo-element or a positioned
  // box whose extent is not known, or which is not the text's ancestor, may
  // or may not lie under it, so the text may sit on either: "varies", with
  // every possibility in bgRange. "image" when a picture paints behind it,
  // "unknown" when the read cannot tell: the contrast check measures neither,
  // rather than report a ratio against the page.
  const effBgInfo = (el) => {
    const er = el.getBoundingClientRect();
    const cx = er.left + er.width / 2, cy = er.top + er.height / 2;
    const layers = [];
    const walked = new Set();
    let opaque = null;
    let node = el;
    for (let i = 0; node; i++, node = paintParent(node)) {
      if (i >= 60) return { bg: "unknown" };
      walked.add(node);
      const p = paintOf(node);
      if (p.clipText) return { bg: "unknown" };
      // Its pseudo-element panels over its own background, then the image, then the colour, then any panel under them.
      const pseudoLayers = (under) => {
        for (const ps of p.pseudos) {
          if (ps.under !== under || (ps.box && (cx < ps.box.l || cx > ps.box.r || cy < ps.box.t || cy > ps.box.b))) continue;
          if (ps.cs === "image" || ps.cs === "unknown") return ps.box ? ps.cs : "unknown";
          layers.push({ cs: ps.cs, maybe: !ps.box });
        }
        return null;
      };
      const over = pseudoLayers(false);
      if (over) return { bg: over };
      if (p.image === "image" || p.image === "unknown") return { bg: p.image };
      if (p.color === "unknown") return { bg: "unknown" };
      if (p.image) {
        layers.push({ cs: p.image, maybe: p.imageMaybe });
        if (!p.imageMaybe && p.image.every((c) => c[3] >= 1)) { opaque = node; break; }
      }
      if (p.color && p.color[3] > 0) {
        layers.push({ cs: [p.color], maybe: false });
        if (p.color[3] >= 1) { opaque = node; break; }
      }
      const below = pseudoLayers(true);
      if (below) return { bg: below };
    }
    if (mediaUnder(el, opaque)) return { bg: "image" };
    // A positioned panel that is neither the text's ancestor nor inside it may
    // lie under it. One outside the opaque ancestor is treated as behind that.
    for (const { n, cs, sunk } of panelsAt(cx, cy)) {
      if (walked.has(n) || el.contains(n) || (opaque && !opaque.contains(n))) continue;
      if (sunk && opaque && !stackedWithin(n, opaque)) continue;
      layers.unshift({ cs, maybe: true });
    }
    return bgStack(layers);
  };
  const effBg = (el) => effBgInfo(el).bg;
  const hasOwnText = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim().length > 0) return true;
    }
    return false;
  };
  const nameOf = ${NAME_SRC};
  const namesFilter = ${FILTER_WORDS_SRC};
  // A filter panel names itself one somewhere on the way up: its test id, id,
  // label, the element its aria-labelledby points at, or a fieldset's legend.
  const inFilterOf = (el) => {
    for (let n = el, i = 0; n && n !== document.body && i < 15; n = n.parentElement, i++) {
      const legend = n.tagName === "FIELDSET" ? n.querySelector(":scope > legend") : null;
      const labelledBy = (n.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
        .map((id) => { const t = document.getElementById(id); return t ? t.textContent || "" : ""; }).join(" ");
      const said = [n.getAttribute("data-testid"), n.id, n.getAttribute("aria-label"), labelledBy, legend ? legend.textContent : ""].join(" ");
      if (namesFilter(said)) return true;
    }
    return false;
  };
  const interactiveSel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]';
  // The app shell, as the markup declares it. A <header>/<footer> inside a
  // <section> is that section's own heading block, not the page banner (the
  // HTML banner/contentinfo rule), and nothing inside the main content, an
  // article or a dialog is shell however it is marked up.
  const shellSel = 'nav, aside, header, footer, [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"]';
  const inShell = (el) => {
    if (el.closest('main, [role="main"], article, [role="article"], dialog, [role="dialog"], [role="alertdialog"]')) return false;
    for (let lm = el.closest(shellSel); lm; lm = lm.parentElement ? lm.parentElement.closest(shellSel) : null) {
      const sectional = (lm.tagName === "HEADER" || lm.tagName === "FOOTER") && !lm.hasAttribute("role");
      if (!sectional || !(lm.parentElement && lm.parentElement.closest("section"))) return true;
    }
    return false;
  };
  const ownFill = (s) => {
    const c = parseColor(s.backgroundColor);
    return (c !== null && c[3] > 0) || (!!s.backgroundImage && s.backgroundImage !== "none");
  };
  // Saturated (non-gray) color test on a parsed [r,g,b,a].
  const isSaturated = (p) => p && (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])) > 40;
  const hueDeg = (p) => {
    const [r, g, b] = p; const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    let h;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    return ((h * 60) + 360) % 360;
  };
  // The box a pointer user hits to operate a native input (StyleRecord.target).
  const unionBox = (boxes) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const x of boxes) { l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom); }
    return { x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t) };
  };
  const gapBetween = (a, b) => Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom, 0);
  const targetOf = (el, rect, hiddenInput) => {
    if (el.tagName !== "INPUT") return null;
    const boxes = [];
    for (const label of Array.from(el.labels || [])) {
      const lr = label.getBoundingClientRect();
      if (lr.width === 0 || lr.height === 0) continue;
      // A label elsewhere on the page also operates the input, but it is a
      // second target, not a bigger one; only a label that wraps or touches
      // the input makes one box with it. A hidden input has no box of its own,
      // so any label of it is the target.
      if (hiddenInput || label.contains(el) || gapBetween(lr, rect) <= 4) boxes.push(lr);
    }
    if (hiddenInput && boxes.length === 0 && el.parentElement) {
      const zone = el.parentElement.closest('button, [role="button"], [onclick], [tabindex]:not([tabindex="-1"])');
      if (zone) boxes.push(zone.getBoundingClientRect());
    }
    if (boxes.length === 0) return null;
    if (!hiddenInput) boxes.push(rect);
    return unionBox(boxes);
  };
  const vh = window.innerHeight;
  let density = 0;
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    if (out.length >= 500) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const interactive = el.matches(interactiveSel);
    if (interactive && rect.top < vh && rect.bottom > 0) density += 1;
    const ownText = hasOwnText(el);
    // The visually-hidden ("sr-only") idiom: a ~1px clipped box that exists to
    // carry text for screen readers. Every published variant of it trips the
    // clipped-text heuristic by construction, so identify it once here.
    const srOnly =
      (rect.width <= 1 && rect.height <= 1) ||
      /inset\\(\\s*50%|rect\\(\\s*0(px)?[\\s,]+0(px)?[\\s,]+0(px)?[\\s,]+0(px)?\\s*\\)/.test(
        (s.clipPath || "") + " " + (s.clip || ""),
      );
    // AI-slop tells are computed for containers too (cards/heroes rarely have
    // own text), so evaluate them BEFORE the text/interactive filter.
    const leftW = px(s.borderLeftWidth), rightW = px(s.borderRightWidth), topW = px(s.borderTopWidth);
    const sideStripe =
      rect.width > 80 &&
      ((leftW > 1 && leftW > topW && isSaturated(parseColor(s.borderLeftColor))) ||
        (rightW > 1 && rightW > topW && isSaturated(parseColor(s.borderRightColor))));
    const bgImg = s.backgroundImage && s.backgroundImage !== "none" ? s.backgroundImage : "";
    const gradientText = /gradient/.test(bgImg) && ((s.webkitBackgroundClip || s.backgroundClip || "") + "").includes("text");
    const rawBgA = parseColor(s.backgroundColor);
    const glass = ((s.backdropFilter || s.webkitBackdropFilter || "") + "").includes("blur") && (!rawBgA || rawBgA[3] < 0.9);
    let glow = false;
    if (s.boxShadow && s.boxShadow !== "none") {
      const shadowColor = parseColor((s.boxShadow.match(/rgba?\\([^)]+\\)/) || [""])[0]);
      const lengths = (s.boxShadow.match(/-?[0-9.]+px/g) || []).map(parseFloat);
      glow = isSaturated(shadowColor) && lengths.length >= 3 && Math.abs(lengths[2]) > 16;
    }
    let aiGradient = false;
    if (/gradient/.test(bgImg) && !gradientText && rect.width > 100) {
      for (const cm of bgImg.match(/rgba?\\([^)]+\\)/g) || []) {
        const p = parseColor(cm);
        if (isSaturated(p) && hueDeg(p) >= 248 && hueDeg(p) <= 295) { aiGradient = true; break; }
      }
    }
    const slop = sideStripe || gradientText || glass || glow || aiGradient;
    if (!interactive && !ownText && !slop) continue;
    const fullText = ownText ? (el.textContent || "").trim().replace(/\\s+/g, " ") : "";
    const target = interactive ? targetOf(el, rect, srOnly || s.opacity === "0") : null;
    const named = interactive ? nameOf(el) : null;
    out.push({
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute("data-testid"),
      text: fullText.slice(0, 50),
      textLen: fullText.length,
      interactive,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      fontSize: px(s.fontSize),
      fontWeight: parseInt(s.fontWeight, 10) || 400,
      fontFamily: (s.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
      lineHeight: s.lineHeight === "normal" ? 0 : px(s.lineHeight),
      textTransform: s.textTransform || "",
      textAlign: s.textAlign || "",
      underline: ((s.textDecorationLine || s.textDecoration || "") + "").includes("underline"),
      color: normColor(s.color),
      ...effBgInfo(el),
      padding: [px(s.paddingTop), px(s.paddingRight), px(s.paddingBottom), px(s.paddingLeft)],
      marginV: [px(s.marginTop), px(s.marginBottom)],
      radius: px(s.borderTopLeftRadius),
      shadow: s.boxShadow && s.boxShadow !== "none" ? s.boxShadow.replace(/\\s+/g, " ").slice(0, 400) : "",
      // srOnly text is DELIBERATELY a 1px box with overflow hidden — the exact
      // signature of "text wider than its box". Flagging it reported the
      // accessibility affordance itself as an accessibility defect.
      clipped: !srOnly && el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(s.overflowX) && s.textOverflow !== "ellipsis" && ownText,
      ...(target ? { target } : {}),
      fixed: s.position === "fixed" || s.position === "sticky",
      required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
      submitish: el.matches('button[type="submit"], input[type="submit"]') || /\\b(save|submit|create|send|confirm|apply|continue|next|finish|approve|sign)\\b/i.test(fullText),
      ...(named ? { name: named.name, nameFrom: named.from, ariaHidden: el.closest('[aria-hidden="true"]') !== null } : {}),
      inputType: el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : "",
      role: (el.getAttribute("role") || "").toLowerCase(),
      filled: ownFill(s),
      inForm: !!el.closest('form, [role="form"]'),
      inRow: !!el.closest('tr, [role="row"]'),
      inSearch: !!el.closest('search, [role="search"]'),
      inBreadcrumb: !!el.closest('[aria-label*="breadcrumb" i], [class*="breadcrumb" i]'),
      inFilter: interactive && inFilterOf(el),
      shell: inShell(el),
      sideStripe, gradientText, glass, glow, aiGradient,
    });
  }
  const headings = [];
  for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (headings.length >= 30) break;
    const r = h.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    headings.push({ level: Number(h.tagName[1]), size: px(window.getComputedStyle(h).fontSize), text: (h.textContent || "").trim().slice(0, 30) });
  }
  const images = [];
  for (const img of document.querySelectorAll("img")) {
    if (images.length >= 40) break;
    const r = img.getBoundingClientRect();
    if (img.naturalWidth <= 1 || img.naturalHeight <= 1 || r.width < 24 || r.height < 24) continue;
    const tid = img.getAttribute("data-testid");
    const label = tid ? "[" + tid + "]" : (img.getAttribute("alt") || (img.getAttribute("src") || "").split("/").pop() || "img").slice(0, 40);
    images.push({ label, nw: img.naturalWidth, nh: img.naturalHeight, rw: Math.round(r.width), rh: Math.round(r.height), fit: window.getComputedStyle(img).objectFit || "fill" });
  }
  // Sibling boxes that paint an edge (a border, their own background or a
  // shadow), grouped by parent, for the touching-containers rule. Only raw
  // measurements are read here; touchingContainers() decides what touches.
  const boxGroups = [];
  const nonContainer = interactiveSel + ', table, thead, tbody, tfoot, tr, td, th, col, colgroup, caption, svg, img, picture, video, canvas, br, hr';
  const nameBox = (el) => {
    const tid = el.getAttribute("data-testid");
    if (tid) return "[" + tid + "]";
    const head = el.querySelector("h1, h2, h3, h4, h5, h6, legend, [role=heading]");
    const words = ((head || el).textContent || "").trim().replace(/\\s+/g, " ").slice(0, 30);
    return "<" + el.tagName.toLowerCase() + "> \\"" + (words || "(no text)") + "\\"";
  };
  const nameParent = (el) => {
    const tid = el.getAttribute("data-testid");
    if (tid) return "[" + tid + "]";
    const id = el.id ? "#" + el.id : "";
    const cls = !id && typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/)[0].slice(0, 40) : "";
    return "<" + el.tagName.toLowerCase() + id + cls + ">";
  };
  const visibleBorder = (s) => {
    let w = 0;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const st = s["border" + side + "Style"];
      const c = parseColor(s["border" + side + "Color"]);
      if (st === "none" || st === "hidden" || !c || c[3] === 0) continue;
      w = Math.max(w, px(s["border" + side + "Width"]));
    }
    return w;
  };
  const paintsAny = (s) => {
    const own = parseColor(s.backgroundColor);
    return visibleBorder(s) > 0 || (!!s.boxShadow && s.boxShadow !== "none") || !!(own && own[3] > 0);
  };
  // The area an element's children can show in: what no overflow:hidden or
  // clip ancestor (the element included) cuts away. A carousel's slides sit
  // edge to edge in a track, and only one is ever seen. A scrolling ancestor
  // does not count: its content can be scrolled into view. Memoized, since
  // siblings and nested groups share their ancestors' clip.
  const clips = new Map();
  const clipOf = (n) => {
    if (!n || n === document.documentElement) return { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    const known = clips.get(n);
    if (known) return known;
    let c = clipOf(n.parentElement);
    const s = window.getComputedStyle(n);
    // Content of a scrolling element can be scrolled into view, whatever clips the element itself.
    if (s.overflowX === "auto" || s.overflowX === "scroll") c = { ...c, l: -Infinity, r: Infinity };
    if (s.overflowY === "auto" || s.overflowY === "scroll") c = { ...c, t: -Infinity, b: Infinity };
    const cx = s.overflowX === "hidden" || s.overflowX === "clip";
    const cy = s.overflowY === "hidden" || s.overflowY === "clip";
    if (cx || cy) {
      const r = n.getBoundingClientRect();
      if (cx) c = { ...c, l: Math.max(c.l, r.left), r: Math.min(c.r, r.right) };
      if (cy) c = { ...c, t: Math.max(c.t, r.top), b: Math.min(c.b, r.bottom) };
    }
    clips.set(n, c);
    return c;
  };
  let parentsSeen = 0;
  for (const parent of all) {
    if (boxGroups.length >= 150 || parentsSeen >= 3000) break;
    if (parent.children.length < 2) continue;
    parentsSeen += 1;
    const boxes = [];
    let clip = null;
    let under = null;
    for (const child of parent.children) {
      if (boxes.length >= 40) break;
      if (child.matches(nonContainer) || child.matches(shellSel)) continue;
      const r = child.getBoundingClientRect();
      if (r.width < 48 || r.height < 24) continue;
      const s = window.getComputedStyle(child);
      if (s.visibility === "hidden" || s.display === "none" || s.display === "contents" || s.position === "absolute" || s.position === "fixed") continue;
      if (!paintsAny(s)) continue;
      clip = clip || clipOf(parent);
      // Cut away entirely: nothing of it can be seen beside anything.
      if (r.right <= clip.l + 1 || r.left >= clip.r - 1 || r.bottom <= clip.t + 1 || r.top >= clip.b - 1) continue;
      under = under || effBg(parent);
      const shadow = s.boxShadow && s.boxShadow !== "none" ? s.boxShadow.replace(/\\s+/g, " ").slice(0, 400) : "";
      boxes.push({
        label: nameBox(child),
        rect: { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 },
        border: visibleBorder(s),
        bg: normColor(s.backgroundColor),
        parentBg: under,
        shadow,
        radii: [px(s.borderTopLeftRadius), px(s.borderTopRightRadius), px(s.borderBottomRightRadius), px(s.borderBottomLeftRadius)],
      });
    }
    if (boxes.length >= 2) boxGroups.push({ parent: nameParent(parent), shell: inShell(parent), boxes });
  }
  const page = {
    scrollW: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    clientW: window.innerWidth,
    headings,
    images,
    density,
    focusSamples: [],
    boxGroups,
  };
  return { records: out, page };
})()`;

function parseRgb(color: string): [number, number, number, number] | null {
  const m = color.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const chan = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastRatio(fg: string, bg: string): number | null {
  const f = parseRgb(fg);
  const b = parseRgb(bg);
  if (!f || !b) return null;
  // Composite a translucent text color over the (already-opaque) background.
  const [fr, fg_, fb, fa] = f;
  const eff: [number, number, number] = [fr * fa + b[0] * (1 - fa), fg_ * fa + b[1] * (1 - fa), fb * fa + b[2] * (1 - fa)];
  const [l1, l2] = [luminance(eff), luminance([b[0], b[1], b[2]])].sort((a, z) => z - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Hue in degrees (0–360) for a saturated color; null for grays. */
function hueOf([r, g, b]: [number, number, number]): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min <= 40) return null; // low chroma — not an accent
  let h: number;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  return Math.round((h * 60 + 360) % 360);
}

/**
 * How an audit line names an element: its test id, else what a user hears for
 * a control (its accessible name, the snapshot's), else its own text. A name
 * that is only the field's name attribute or type is not one anybody hears,
 * so it gives way to the text.
 */
const label = (r: StyleRecord): string => {
  if (r.testid) return `[${r.testid}]`;
  const heard = r.name && r.nameFrom !== "fallback" ? r.name : r.text;
  return `<${r.tag}> "${heard.slice(0, 30) || "(no text)"}"`;
};
/** One wording for a small target, page or shell alike: the shell section's, so its prose is unchanged. */
const tinyTargetDetail = (r: StyleRecord): string => `${label(r)} — ${Math.round(targetBox(r).w)}×${Math.round(targetBox(r).h)}px tap target`;
const clippedTextDetail = (r: StyleRecord): string => `${label(r)} — text is clipped by its container`;
/** One wording for body-coloured links, page or shell alike. */
const indistinctDetail = (bodyColor: string): string => `links with no underline in the body-text colour ${bodyColor}`;

/**
 * Stable identity for one styled element, used to recognise the SAME component
 * across routes.
 *
 * Deliberately not the coverage element key: that one is built from the ARIA
 * role and accessible name, and a style record carries neither — it has a tag
 * and its own text. A separate census keyed the way the audit actually sees
 * things is what lets shared shell elements without a testid (a notification
 * badge rendering "18") be recognised as one component rather than one per page.
 */
export function styleSignature(r: StyleRecord): string {
  if (r.testid) return `tid:${r.testid}`;
  return `${r.tag}:${r.text.slice(0, SIGNATURE_TEXT_LEN).toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** How much own-text identifies a component across pages without over-fragmenting it. */
const SIGNATURE_TEXT_LEN = 40;
/** Shell issues listed individually before the reader stops reading. */
const CHROME_ISSUE_CAP = 6;

/** What the contrast rule makes of one text: below its threshold, at or above it, or not decidable from what was read. */
export type ContrastVerdict =
  | { kind: "fail"; ratio: number; threshold: number; on: string; varies: boolean }
  | { kind: "pass" }
  | { kind: "varies"; low: number; high: number; threshold: number; crosses: boolean }
  | { kind: "unmeasured" };

/**
 * The contrast verdict for one text. Over one known colour it is the WCAG
 * ratio against the threshold. Over a background that varies (a gradient, or
 * a layer that may or may not be under the text) it fails only when every
 * colour the text may sit on fails, quoting the most favourable, and passes
 * only when every one passes and the text's own lightness is not between
 * theirs, where a gradient would pass through it. Anything else is "varies",
 * which costs nothing: a false failure costs more trust than a miss.
 */
export function contrastVerdict(r: Pick<StyleRecord, "text" | "color" | "bg" | "bgRange" | "fontSize" | "fontWeight">): ContrastVerdict {
  if (!r.text || r.color === "unknown") return { kind: "unmeasured" };
  // Text whose own colour is fully transparent is not painted: a selectable text layer laid over a rendered
  // document (a PDF viewer's), or text hidden for screen readers. Its 1:1 ratio is not what anyone sees.
  const fg = parseRgb(r.color);
  if (!fg || fg[3] === 0) return { kind: "unmeasured" };
  const range = r.bg === "varies" ? (r.bgRange ?? []) : [r.bg];
  const measured = range.map((bg) => ({ bg, ratio: contrastRatio(r.color, bg) }));
  if (measured.length === 0 || measured.some((m) => m.ratio === null)) return { kind: "unmeasured" };
  const isLarge = r.fontSize >= 24 || (r.fontSize >= 18.7 && r.fontWeight >= 700);
  const threshold = isLarge ? 3 : 4.5;
  const ratios = measured.map((m) => m.ratio as number);
  const low = Math.min(...ratios);
  const high = Math.max(...ratios);
  if (high < threshold) {
    const best = measured[ratios.indexOf(high)];
    return { kind: "fail", ratio: high, threshold, on: best.bg, varies: measured.length > 1 };
  }
  if (low >= threshold) {
    if (measured.length === 1) return { kind: "pass" };
    // The text's lightness, composited as it is painted, against the range of backgrounds it may sit on.
    const textLum = (bg: string): number => {
      const b = parseRgb(bg) as [number, number, number, number];
      const a = fg[3];
      return luminance([fg[0] * a + b[0] * (1 - a), fg[1] * a + b[1] * (1 - a), fg[2] * a + b[2] * (1 - a)]);
    };
    const lums = range.map((bg) => luminance((parseRgb(bg) as [number, number, number, number]).slice(0, 3) as [number, number, number]));
    const t = textLum(range[0]);
    if (t > Math.min(...lums) && t < Math.max(...lums)) return { kind: "varies", low, high, threshold, crosses: true };
    return { kind: "pass" };
  }
  return { kind: "varies", low, high, threshold, crosses: false };
}

/**
 * WCAG contrast check over a record set. Shared by the page pass and the
 * shared-chrome pass so the thresholds (and the message shape a reader learns
 * to scan) are stated once rather than copied.
 */
function contrastFailures(records: StyleRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    const v = contrastVerdict(r);
    if (v.kind !== "fail") continue;
    out.push(
      `${label(r)} — ${v.ratio.toFixed(2)}:1 (needs ${v.threshold}:1) ${r.color} on ${v.on}${v.varies ? " at best, over a background that varies" : ""}`,
    );
  }
  return out;
}

/** Texts over a background that varies whose contrast passes on part of it and fails on the rest: worth a look, never a deduction. */
function contrastUnsure(records: StyleRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    const v = contrastVerdict(r);
    if (v.kind !== "varies") continue;
    const where = v.crosses ? ", and lower where a gradient passes through the text's own lightness" : " depending on what lies under it";
    out.push(`${label(r)} — between ${v.low.toFixed(2)}:1 and ${v.high.toFixed(2)}:1 (needs ${v.threshold}:1)${where}`);
  }
  return out;
}

/** The commonest off-grid values, smallest first and without their counts: "7px, 13px". */
function gridValues(top: ReadonlyArray<[number, number]>): string {
  return top
    .map(([v]) => v)
    .sort((a, b) => a - b)
    .map((v) => `${v}px`)
    .join(", ");
}

/** The box a pointer user hits to operate the control: its label or drop zone where one operates it, else its own. */
function targetBox(r: StyleRecord): StyleRecord["rect"] {
  return r.target ?? r.rect;
}

/** The WCAG 2.2 target-size minimum, in CSS pixels. */
const MIN_TARGET = 24;

/** Inputs that are buttons, not fields. */
const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);

/** Inputs a user types into. Every other type (a checkbox, radio, range, colour or file) is picked rather than typed, and outside a form most of those apply at once. */
const TYPED_INPUT_TYPES = new Set(["text", "email", "number", "tel", "url", "password", "date", "datetime-local", "month", "week", "time"]);

/** A button, or a link painted as one. Fields, selects and plain links never compete as actions. */
function buttonLike(r: StyleRecord): boolean {
  if (r.tag === "button" || r.role === "button") return true;
  if (r.tag === "input") return BUTTON_INPUT_TYPES.has(r.inputType);
  return r.tag === "a" && r.filled;
}

/**
 * The fields a user is asked to fill in and submit. Excluded: controls in a
 * table row (a selection checkbox, or a select that edits the row in place),
 * search boxes, controls in a panel that names itself a filter, and inputs
 * that are buttons. When some fields sit in a <form>, only those count: the
 * rest of the page (filters, toolbars) is not part of what gets submitted. A
 * page with no <form> at all is judged on the fields a user types into,
 * because many apps build their forms without the element; its selects and
 * every input not in TYPED_INPUT_TYPES (checkboxes, radios, file pickers) are
 * left out, since outside a form those are most often filters and settings
 * that apply as they change.
 */
function formFields(records: StyleRecord[]): StyleRecord[] {
  const candidates = records.filter(
    (r) =>
      r.interactive &&
      (r.tag === "input" || r.tag === "select" || r.tag === "textarea") &&
      !BUTTON_INPUT_TYPES.has(r.inputType) &&
      r.inputType !== "search" &&
      !r.inSearch &&
      !r.inRow &&
      !r.inFilter,
  );
  const inForm = candidates.filter((r) => r.inForm);
  return inForm.length > 0 ? inForm : candidates.filter(typedField);
}

/** A field a user types into: a text-like input or a textarea. */
function typedField(r: StyleRecord): boolean {
  return r.tag === "textarea" || (r.tag === "input" && TYPED_INPUT_TYPES.has(r.inputType || "text"));
}

/**
 * A shadow layer's lengths, as `layer.match(/-?[0-9.]+px/g)` gave them. The page's own box-shadow is read here, and
 * that pattern took time quadratic in a long run of digits and full stops with no `px` after it (#618, ADR 29), so it
 * is read in code: a run that does not end in `px` is passed over whole, as no start inside it can end otherwise.
 */
export function shadowLengths(layer: string): string[] {
  const out: string[] = [];
  const inRun = (c: string) => (c >= "0" && c <= "9") || c === ".";
  let i = 0;
  while (i < layer.length) {
    const from = layer[i] === "-" ? i + 1 : i;
    let end = from;
    while (end < layer.length && inRun(layer[end])) end += 1;
    if (end > from && layer.startsWith("px", end)) {
      out.push(layer.slice(i, end + 2));
      i = end + 2;
    } else i = Math.max(i + 1, end);
  }
  return out;
}

/**
 * A shadow layer's first colour, as `layer.match(/rgba?\([^)]*\)/)?.[0]` gave it, read in code for the same reason
 * as `shadowLengths`: past the first `rgb(` or `rgba(` with no `)` after it, no later one has one either.
 */
export function shadowColour(layer: string): string | null {
  let at = layer.indexOf("rgb");
  while (at >= 0) {
    const open = layer[at + 3] === "a" ? at + 4 : at + 3;
    if (layer[open] === "(") {
      const close = layer.indexOf(")", open + 1);
      return close < 0 ? null : layer.slice(at, close + 1);
    }
    at = layer.indexOf("rgb", at + 1);
  }
  return null;
}

/**
 * The layers of a computed box-shadow that draw something: a layer with no
 * offset, blur or spread, or a transparent colour, paints nothing. Utility CSS
 * stacks such placeholder layers (empty rings) in front of the real shadow on
 * every element, so a census keyed on the raw value counts the placeholders.
 * Returned in order, whitespace normalized; empty when nothing is drawn.
 */
export function shadowLayers(shadow: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of shadow) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      layers.push(current);
      current = "";
    } else current += ch;
  }
  layers.push(current);
  return layers
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => {
      if (!l || l === "none") return false;
      const lengths = shadowLengths(l).map(parseFloat);
      if (lengths.every((n) => n === 0)) return false;
      if (/\btransparent\b/.test(l)) return false;
      const colour = shadowColour(l);
      return !(colour && parseRgb(colour)?.[3] === 0);
    });
}

/** The elevation a box-shadow draws, as one key: its drawing layers. "" for none. */
export function elevationKey(shadow: string): string {
  return shadowLayers(shadow).join(", ");
}

/**
 * The layer that tells one elevation from the others listed beside it: its
 * first layer that not every other key has. Shown in place of the whole value,
 * whose differences often begin past any width an example can be given.
 */
export function distinguishingLayer(key: string, others: readonly string[]): string {
  const layers = shadowLayers(key);
  const rest = others.filter((o) => o !== key).map(shadowLayers);
  return layers.find((l) => rest.some((o) => !o.includes(l))) ?? layers[0] ?? "";
}

/**
 * A colour with no hue family is a gray: neutral or tinted (a slate or a warm
 * stone), the shades text and surfaces are built from. Near-white and
 * near-black are left out, as before: every page has them.
 */
function grayOf(rgb: [number, number, number]): boolean {
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return hueOf(rgb) === null && avg > 20 && avg < 245;
}

/**
 * Grays counted as the steps of a scale: colours within GRAY_STEP of one in
 * every channel are one step (a translucent text colour composited over two
 * backgrounds lands a unit or two apart). Commonest first, each with its use count.
 */
export function grayCensus(colours: ReadonlyArray<[number, number, number]>): Array<{ rgb: [number, number, number]; n: number }> {
  const freq = new Map<string, { rgb: [number, number, number]; n: number }>();
  for (const c of colours) {
    if (!grayOf(c)) continue;
    const k = c.join(",");
    const e = freq.get(k) ?? { rgb: c, n: 0 };
    e.n += 1;
    freq.set(k, e);
  }
  const steps: Array<{ rgb: [number, number, number]; n: number }> = [];
  for (const e of [...freq.values()].sort((a, b) => b.n - a.n)) {
    const near = steps.find((s) => s.rgb.every((v, i) => Math.abs(v - e.rgb[i]) <= GRAY_STEP));
    if (near) near.n += e.n;
    else steps.push({ ...e });
  }
  return steps.sort((a, b) => b.n - a.n);
}

/** How far apart, per channel, two grays may be and still be one step of a scale. */
const GRAY_STEP = 4;

/**
 * The page's controls a screen-reader user cannot tell apart: fields and
 * controls with no name, and fields whose only label is the placeholder. The
 * snapshot's own predicates (collector-elements.ts), over the snapshot's own name, so
 * the audit and the snapshot agree on a page. Records with no name read are
 * left out rather than guessed.
 */
function unnamedControls(records: readonly StyleRecord[]): { unnamed: StyleRecord[]; placeholder: StyleRecord[] } {
  const named = records.filter((r) => r.interactive && typeof r.name === "string");
  const asSnapshot = (r: StyleRecord) => ({
    role: r.role,
    name: r.name ?? "",
    nameFrom: r.nameFrom ?? null,
    interactive: true,
    ariaHidden: r.ariaHidden === true,
  });
  return {
    unnamed: named.filter((r) => missingName(asSnapshot(r))),
    placeholder: named.filter((r) => placeholderOnly(asSnapshot(r))),
  };
}

/** Below the WCAG 2.2 target-size minimum; inline links are exempt by that rule. */
function undersized(r: StyleRecord): boolean {
  const b = targetBox(r);
  return r.interactive && r.tag !== "a" && (b.h < MIN_TARGET || b.w < MIN_TARGET) && b.h > 0;
}

const centreOf = (b: StyleRecord["rect"]): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];

/** Distance from a point to the nearest edge of a box; 0 inside it. */
function distanceToBox([px, py]: [number, number], b: StyleRecord["rect"]): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/**
 * The WCAG 2.5.8 spacing exception: an undersized target passes when a 24px
 * circle on its centre touches no other target and no other undersized
 * target's circle. `others` is every interactive record on the page, shell
 * included, since a neighbour in the shell is as easy to hit by mistake.
 */
function spacedApart(r: StyleRecord, others: readonly StyleRecord[]): boolean {
  const c = centreOf(targetBox(r));
  for (const o of others) {
    if (o === r || !o.interactive) continue;
    const ob = targetBox(o);
    if (ob.w === 0 || ob.h === 0) continue;
    if (undersized(o)) {
      const [ox, oy] = centreOf(ob);
      if (Math.hypot(ox - c[0], oy - c[1]) < MIN_TARGET) return false;
    } else if (distanceToBox(c, ob) < MIN_TARGET / 2) return false;
  }
  return true;
}

/**
 * A target that fails WCAG 2.5.8: under 24px, measured on what the user hits
 * (targetBox), and not saved by the spacing exception.
 */
function tooSmall(r: StyleRecord, all: readonly StyleRecord[]): boolean {
  return undersized(r) && !spacedApart(r, all);
}

/**
 * One measured fact, as data. The report prints the same facts as prose;
 * `scenescout check` reads these instead of parsing it. Most are ⚠ lines.
 * Two are → lines whose measurement is exact but whose meaning depends on a
 * convention of the project: paddings and margins off a 4px grid matter only
 * where a project uses that spacing scale, and links styled like body text
 * are ordinary in navigation. They are here so a check can list them as
 * worth a look (check.ts decides the tier, never this file); every other
 * craft suggestion is a judgement call and is deliberately not.
 */
export interface DesignDefect {
  rule:
    | "contrast"
    | "tiny-target"
    | "clipped-text"
    | "focus-indicator"
    | "image-aspect"
    | "horizontal-scroll"
    | "touching-containers"
    | "off-grid-spacing"
    | "indistinct-link";
  detail: string;
  /** Part of the shared app shell rather than this page: one fix, however many pages show it. */
  chrome?: boolean;
}

/** Multi-indicator quality score for one page (0–100 each; overall weighted). */
export interface DesignScore {
  overall: number;
  a11y: number;
  craft: number;
  consistency: number;
  clarity: number;
  /** Every deduction behind the numbers, largest first (scoreFrom). */
  deductions: ScoreDeduction[];
  /** The design-system values the page uses, kept with its score so pages can be compared (siteConsistency). */
  system?: DesignSystemSample;
}

/**
 * The design-system values one page uses outside the shell's landmarks, as
 * the audit measured them. Each list is distinct values, sorted. Kept with the
 * page's score so the report can set the pages of a run side by side
 * (siteConsistency).
 */
export interface DesignSystemSample {
  /** Button heights, px, rounded to 2px as the CONSISTENCY line counts them. */
  buttonHeights: number[];
  /** Corner radii of buttons 12–80px tall: "6px", or "pill" for one at least half the height. */
  buttonRadii: string[];
  /** The h1's treatment: "28px 700". */
  headers: string[];
  /** A tab's treatment ([role=tab]): "36px tall, 6px radius". */
  tabs: string[];
  /** The gray census's steps: "rgb(64, 64, 64)". */
  grays: string[];
  /** Font sizes of text, px. */
  fontSizes: number[];
  /** Padding values used at least twice on the page, px. */
  spacing: number[];
}

/** An image the audit measured: its natural size, its rendered box and its computed object-fit. */
export interface PageImage {
  label: string;
  nw: number;
  nh: number;
  rw: number;
  rh: number;
  fit: string;
}

/** Past this, a stretched image reads as distorted rather than as rounding. */
const ASPECT_TOLERANCE = 0.12;

/**
 * How far an image is stretched out of its proportions, or null when it is not.
 * Only `fill`, the default, stretches the picture to its box: `cover` and `contain`
 * scale it uniformly and crop or letterbox, `none` draws it at its own size and
 * `scale-down` is one of those two. So a mismatched box is distortion only under `fill`.
 */
export function aspectDistortion(img: PageImage): number | null {
  if (img.fit !== "fill") return null;
  const off = Math.abs(img.rw / img.rh / (img.nw / img.nh) - 1);
  return off > ASPECT_TOLERANCE ? off : null;
}

/** At most this many px between two boxes on the axis they are stacked on, and they touch. */
const TOUCH_GAP = 2;
/** A corner this round reads as the corner of a separate card, not of a joined group. */
const ROUND_CORNER = 2;

/**
 * Whether a box shows an edge against what it sits on: a visible border, a
 * drawn shadow, or a background that differs from its parent's. A white box
 * on a white page with neither border nor shadow is invisible, so two of them
 * touching is nothing anyone sees.
 */
export function paintsEdge(b: PaintedBox): boolean {
  if (b.border >= 1 || shadowLayers(b.shadow).length > 0) return true;
  const own = parseRgb(b.bg);
  const under = parseRgb(b.parentBg);
  if (!own || own[3] === 0 || !under) return false;
  const a = own[3];
  return [0, 1, 2].some((i) => Math.abs(own[i] * a + under[i] * (1 - a) - under[i]) > 6);
}

/** Two boxes that touch, the axis they are stacked on and the px between them. */
export interface TouchingPair {
  a: string;
  b: string;
  axis: "vertical" | "horizontal";
  gap: number;
}

/**
 * Sibling containers drawn as separate boxes with no space between them: both
 * paint an edge (paintsEdge), they are stacked on one axis with 0–2px between
 * them and overlap on the other by at least half the smaller one, and they read
 * as separate cards: a corner where they meet is rounded, and neither box
 * has tightened its corners on that side below its own roundest one.
 *
 * The last condition is what keeps intended joins out. A list group, an
 * accordion, a table's rows, tabs over their panel, a segmented control and
 * full-bleed page bands abut on purpose, and they square the corners where
 * they meet, shadowed or not; grouped chat bubbles tighten them (4px inside,
 * 18px outside). Two cards rounded alike on every corner meeting edge to edge
 * are a missing gap. Square cards meeting are not reported: nothing in the
 * markup tells them from a joined group's items. Shell groups, and shell
 * landmarks among the children (an app bar over the content), are left to the
 * shared-chrome pass. One entry per parent, since the fix is usually one gap
 * on the shared wrapper.
 */
export function touchingContainers(groups: readonly BoxGroup[]): Array<{ parent: string; pairs: TouchingPair[] }> {
  const out: Array<{ parent: string; pairs: TouchingPair[] }> = [];
  for (const g of groups) {
    if (g.shell) continue;
    const boxes = g.boxes.filter(paintsEdge);
    const pairs: TouchingPair[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const pair = touching(boxes[i], boxes[j]);
        if (pair) pairs.push(pair);
      }
    }
    if (pairs.length > 0) out.push({ parent: g.parent, pairs });
  }
  return out;
}

/** The pair's touch, if the two boxes touch as separate cards; null otherwise. */
function touching(p: PaintedBox, q: PaintedBox): TouchingPair | null {
  const span = (a0: number, a1: number, b0: number, b1: number): [number, number] => [Math.max(a0, b0), Math.min(a1, b1)];
  // A corner counts only where the two boxes meet: its position along the shared edge lies inside the overlap.
  // A folder tab's square foot on a wider panel whose far corner is rounded is a join, not two cards.
  const roundIn = ([from, to]: [number, number], corners: Array<[number, number]>): boolean =>
    corners.some(([at, r]) => r >= ROUND_CORNER && at >= from - 1 && at <= to + 1);
  // A box whose corners on the side it meets the other are tighter than its own roundest corner was shaped to join it:
  // grouped chat bubbles 2px apart with 4px inner corners and 18px outer ones, a list item rounded only on its outer side.
  const tightened = (b: PaintedBox, meeting: [number, number]): boolean => Math.min(b.radii[meeting[0]], b.radii[meeting[1]]) < Math.max(...b.radii) - 0.5;
  // Vertical stack: `top` above `bottom`, sharing at least half the narrower one's width.
  const [top, bottom] = p.rect.y <= q.rect.y ? [p, q] : [q, p];
  const vGap = bottom.rect.y - (top.rect.y + top.rect.h);
  const hs = span(top.rect.x, top.rect.x + top.rect.w, bottom.rect.x, bottom.rect.x + bottom.rect.w);
  if (vGap >= -0.5 && vGap <= TOUCH_GAP && hs[1] - hs[0] >= Math.min(top.rect.w, bottom.rect.w) / 2) {
    const tr = top.rect;
    const br = bottom.rect;
    const facing = roundIn(hs, [
      [tr.x + tr.w, top.radii[2]],
      [tr.x, top.radii[3]],
      [br.x, bottom.radii[0]],
      [br.x + br.w, bottom.radii[1]],
    ]);
    const joined = tightened(top, [2, 3]) || tightened(bottom, [0, 1]);
    return facing && !joined ? { a: top.label, b: bottom.label, axis: "vertical", gap: Math.max(0, Math.round(vGap)) } : null;
  }
  const [left, right] = p.rect.x <= q.rect.x ? [p, q] : [q, p];
  const hGap = right.rect.x - (left.rect.x + left.rect.w);
  const vs = span(left.rect.y, left.rect.y + left.rect.h, right.rect.y, right.rect.y + right.rect.h);
  if (hGap >= -0.5 && hGap <= TOUCH_GAP && vs[1] - vs[0] >= Math.min(left.rect.h, right.rect.h) / 2) {
    const lr = left.rect;
    const rr = right.rect;
    const facing = roundIn(vs, [
      [lr.y, left.radii[1]],
      [lr.y + lr.h, left.radii[2]],
      [rr.y, right.radii[0]],
      [rr.y + rr.h, right.radii[3]],
    ]);
    const joined = tightened(left, [1, 2]) || tightened(right, [0, 3]);
    if (facing && !joined) return { a: left.label, b: right.label, axis: "horizontal", gap: Math.max(0, Math.round(hGap)) };
  }
  return null;
}

/** Which part of the score a deduction comes off. */
export type ScoreDimension = "a11y" | "craft" | "consistency" | "clarity";

/**
 * One reason a page lost points: what was measured, how many times, and the
 * points it cost the overall score. The report lists the largest beside the
 * score so a ranking can be checked against what caused it.
 */
export interface ScoreDeduction {
  dimension: ScoreDimension;
  /** What was measured, in a few words: "touching containers", "6 button heights". */
  label: string;
  /** How many times; shown as ×n when more than one. */
  count: number;
  points: number;
}

/** "-16 touching containers ×2": a deduction as the report prints it. */
export function formatDeduction(d: Pick<ScoreDeduction, "label" | "count" | "points">): string {
  return `-${d.points} ${d.label}${d.count > 1 ? ` ×${d.count}` : ""}`;
}

/** Deductions the report prints beside a page's score. */
export const TOP_DEDUCTIONS = 3;

/**
 * A subscore falls this many times faster than the overall: each dimension is
 * one part of four, so a cost the overall takes once is a larger share of the
 * part it belongs to, and the dimension that holds the cause shows it.
 */
const SUBSCORE_FACTOR = 2;

/**
 * Whether a rule measures a defect (its audit line is ⚠: the page fails a
 * stated threshold) or makes a suggestion (→, or a heuristic a deliberate
 * design can trip). A suggestion costs SUGGESTION_WEIGHT of its listed points.
 */
type RuleTier = "defect" | "suggestion";

/**
 * Half: at full weight the suggestions alone took well-made public pages
 * (component docs, product home pages) from the 80s into the 60s, while the
 * calibration page's defects kept their order at half.
 */
const SUGGESTION_WEIGHT = 0.5;

/**
 * The page's score from its deductions. Overall is 100 less every deduction;
 * each subscore is 100 less SUBSCORE_FACTOR times its own. Both floor at 0.
 */
export function scoreFrom(deductions: readonly ScoreDeduction[]): DesignScore {
  const sum = (dim?: ScoreDimension): number => deductions.filter((d) => !dim || d.dimension === dim).reduce((n, d) => n + d.points, 0);
  const sub = (dim: ScoreDimension): number => Math.max(0, Math.round(100 - SUBSCORE_FACTOR * sum(dim)));
  const sorted = deductions.filter((d) => d.points > 0).sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));
  return {
    overall: Math.max(0, Math.round(100 - sum())),
    a11y: sub("a11y"),
    craft: sub("craft"),
    consistency: sub("consistency"),
    clarity: sub("clarity"),
    deductions: sorted,
  };
}

// ---------------------------------------------------------------------------
// Consistency across pages: each page's design-system values set beside the
// other audited pages', and a page charged for a value no other page uses.
// ---------------------------------------------------------------------------

/** Pages that must carry a sample, and use a property, before that property is compared across them (memory.ts CHROME_MIN_ROUTES). */
export const SITE_MIN_PAGES = 4;
/** A value is the site's convention when at least this share of the pages using the property use it. */
const SITE_DOMINANT_SHARE = 0.6;
/** Listed points per value a page alone uses, and the most one property may cost, before the suggestion weight halves them. */
const SITE_EACH = 4;
const SITE_PROPERTY_CAP = 8;
/** The most the whole comparison may take off one page, after the weight. */
const SITE_CAP = 10;

type SiteKey = keyof DesignSystemSample;

/** How one property of the sample is compared. */
interface SiteRule {
  key: SiteKey;
  /** Plural and singular nouns, as a line names them. */
  noun: string;
  one: string;
  /** Appended to a list of numbers. */
  unit: string;
  /**
   * The count the page's own rule allows before it charges (the SYSTEM
   * SUMMARY's healthy range): values past it were already paid for on the
   * page, so that many of the page's lone values are not charged again.
   * Null where no per-page rule counts the property.
   */
  healthy: number | null;
  /**
   * Charged, or reported only. Type sizes and paddings are listed but not
   * charged: a home page's display heading and a component's own padding are
   * ordinary values one page alone uses.
   */
  scored: boolean;
  /** Two values that count as one; exact match when absent. */
  near?: (a: string, b: string) => boolean;
  /** The values compared; every value when absent. */
  compared?: (value: string) => boolean;
}

/** Grays within GRAY_STEP in every channel are one step, across pages as within one (grayCensus). */
const nearGray = (a: string, b: string): boolean => {
  const p = parseRgb(a);
  const q = parseRgb(b);
  return !!p && !!q && [0, 1, 2].every((i) => Math.abs(p[i] - q[i]) <= GRAY_STEP);
};

/**
 * A pale tint: light (every channel at least PALE_FLOOR) and visibly tinted
 * (channels more than TINT_SPREAD apart). The census counts it as a gray, but
 * a pale green, blue or amber surface is a status chip or a highlighted row,
 * and it belongs to the page that shows that status. On the demo app and two
 * public sites every gray one page alone used was such a tint, so across pages
 * they are left out; a slate or zinc scale, tinted but not pale, is compared.
 */
const PALE_FLOOR = 200;
const TINT_SPREAD = 12;
const notPaleTint = (value: string): boolean => {
  const p = parseRgb(value);
  if (!p) return false;
  const [lo, hi] = [Math.min(p[0], p[1], p[2]), Math.max(p[0], p[1], p[2])];
  return !(lo >= PALE_FLOOR && hi - lo > TINT_SPREAD);
};

const SITE_RULES: readonly SiteRule[] = [
  { key: "buttonHeights", noun: "button heights", one: "button height", unit: "px", healthy: 3, scored: true },
  { key: "buttonRadii", noun: "button radii", one: "button radius", unit: "", healthy: 2, scored: true },
  { key: "headers", noun: "page headers (h1)", one: "page header (h1)", unit: "", healthy: null, scored: true },
  { key: "tabs", noun: "tab styles", one: "tab style", unit: "", healthy: null, scored: true },
  { key: "grays", noun: "grays", one: "gray", unit: "", healthy: 6, scored: true, near: nearGray, compared: notPaleTint },
  { key: "fontSizes", noun: "font sizes", one: "font size", unit: "px", healthy: 7, scored: false, near: (a, b) => Math.abs(Number(a) - Number(b)) < 0.5 },
  { key: "spacing", noun: "spacing steps", one: "spacing step", unit: "px", healthy: null, scored: false },
];

/** One value of a property and the pages that use it. */
export interface SiteValue {
  value: string;
  routes: string[];
}

/** One property across the audited pages. */
export interface SiteProperty {
  key: SiteKey;
  noun: string;
  unit: string;
  scored: boolean;
  /** Pages that use the property at all. */
  pages: number;
  /** Every distinct value, the most widely used first. */
  values: SiteValue[];
  /** The value at least SITE_DOMINANT_SHARE of those pages use; null when none does, or too few pages use the property to say. */
  dominant: string | null;
  /** Route → the values only that page uses, where the property has a dominant value. */
  outliers: Record<string, string[]>;
}

/** The audited pages' design-system values side by side, and what each page is charged for its lone values. */
export interface SiteConsistency {
  /** Pages with a sample. */
  pages: number;
  properties: SiteProperty[];
  /** Route → its site deductions (dimension "consistency"); a page with none is absent. */
  deductions: Record<string, ScoreDeduction[]>;
}

/** A list of values as a line prints it: "28, 32, 36px". */
const listValues = (values: readonly string[], unit: string): string => (values.length === 0 ? "" : `${values.join(", ")}${unit}`);

/**
 * Set every audited page's design-system values beside the others'. Null
 * until SITE_MIN_PAGES pages carry a sample. A property is compared once that
 * many pages use it and one value is used on SITE_DOMINANT_SHARE of them:
 * then a page pays, at the suggestion weight, for each value of a scored
 * property that no other page uses ("a button height used only here"), less
 * the values its own per-page rule already charged it for, capped per
 * property and in all. The result depends on which pages were audited, so it
 * is computed when it is read, never stored with a page's own score.
 */
export function siteConsistency(pages: Readonly<Record<string, { system?: DesignSystemSample }>>): SiteConsistency | null {
  const sampled = Object.entries(pages)
    .filter((e): e is [string, { system: DesignSystemSample }] => !!e[1].system)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (sampled.length < SITE_MIN_PAGES) return null;
  const properties: SiteProperty[] = [];
  const charged = new Map<string, ScoreDeduction[]>();
  for (const rule of SITE_RULES) {
    // Each page's distinct values, as strings; then values that count as one (near) joined, the most widely used first.
    const perRoute = sampled
      .map(([route, p]) => [route, [...new Set((p.system[rule.key] ?? []).map(String))].filter((v) => !rule.compared || rule.compared(v))] as const)
      .filter(([, v]) => v.length > 0);
    const byValue = new Map<string, Set<string>>();
    for (const [route, values] of perRoute) for (const v of values) byValue.set(v, (byValue.get(v) ?? new Set()).add(route));
    const clusters: Array<{ value: string; routes: Set<string> }> = [];
    for (const [value, routes] of [...byValue].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "en", { numeric: true }))) {
      const into = rule.near && clusters.find((c) => rule.near!(c.value, value));
      if (into) for (const r of routes) into.routes.add(r);
      else clusters.push({ value, routes: new Set(routes) });
    }
    // Joining near values can make a later cluster the widest, so the order is taken again after the join.
    clusters.sort((a, b) => b.routes.size - a.routes.size || a.value.localeCompare(b.value, "en", { numeric: true }));
    const using = perRoute.length;
    const top = clusters[0];
    const dominant = using >= SITE_MIN_PAGES && top && top.routes.size >= SITE_DOMINANT_SHARE * using ? top.value : null;
    const outliers: Record<string, string[]> = {};
    if (dominant !== null) {
      for (const c of clusters) {
        if (c.routes.size !== 1) continue;
        const [route] = c.routes;
        (outliers[route] ??= []).push(c.value);
      }
    }
    properties.push({
      key: rule.key,
      noun: rule.noun,
      unit: rule.unit,
      scored: rule.scored,
      pages: using,
      values: clusters.map((c) => ({ value: c.value, routes: [...c.routes].sort() })),
      dominant,
      outliers,
    });
    if (!rule.scored) continue;
    for (const [route, lone] of Object.entries(outliers)) {
      const own = sampled.find(([r]) => r === route)![1].system[rule.key]?.length ?? 0;
      const paid = rule.healthy === null ? 0 : Math.max(0, own - rule.healthy);
      const count = Math.max(0, lone.length - paid);
      const points = Math.round(Math.min(SITE_PROPERTY_CAP, count * SITE_EACH) * SUGGESTION_WEIGHT);
      if (count === 0 || points === 0) continue;
      const shown = rule.unit ? [...lone].sort((a, b) => Number(a) - Number(b)) : lone;
      const label = `${lone.length > 1 ? rule.noun : rule.one} only on this page: ${listValues(shown.slice(0, 4), rule.unit)}`;
      const list = charged.get(route) ?? [];
      list.push({ dimension: "consistency", label, count, points });
      charged.set(route, list);
    }
  }
  // The cap in all: the largest first, the last one cut to what is left.
  const deductions: Record<string, ScoreDeduction[]> = {};
  for (const [route, list] of [...charged].sort((a, b) => a[0].localeCompare(b[0]))) {
    let left = SITE_CAP;
    const kept: ScoreDeduction[] = [];
    for (const d of [...list].sort((a, b) => b.points - a.points || a.label.localeCompare(b.label))) {
      const points = Math.min(d.points, left);
      if (points <= 0) break;
      kept.push({ ...d, points });
      left -= points;
    }
    deductions[route] = kept;
  }
  return { pages: sampled.length, properties, deductions };
}

/** A page's score with its site deductions added to its own: what the report ranks by once the site is compared. */
export function siteScore(
  score: { deductions?: ReadonlyArray<{ dimension: string; label: string; count: number; points: number }> },
  site: SiteConsistency,
  route: string,
): DesignScore {
  const own = (score.deductions ?? []).map((d) => ({ ...d, dimension: d.dimension as ScoreDimension }));
  return scoreFrom([...own, ...(site.deductions[route] ?? [])]);
}

/** Routes named after a value, at most this many. */
const SITE_ROUTES_SHOWN = 3;

/**
 * The comparison as lines: per property, every distinct value and how many
 * pages use it, the dominant one, and the pages holding a value no other page
 * uses.
 */
export function formatSiteConsistency(site: SiteConsistency, routeText: (route: string) => string = (r) => r): string[] {
  const lines: string[] = [];
  for (const p of site.properties) {
    if (p.pages === 0) continue;
    const numeric = p.unit !== "";
    const shown = numeric ? [...p.values].sort((a, b) => Number(a.value) - Number(b.value)) : p.values;
    const values = shown.slice(0, 12).map((v) => v.value);
    const more = shown.length > 12 ? ` (+${shown.length - 12} more)` : "";
    const head = `${p.noun}: ${p.values.length} value${p.values.length === 1 ? "" : "s"} (${listValues(values, p.unit)}${more}) across ${p.pages} page${p.pages === 1 ? "" : "s"}`;
    const verdict =
      p.pages < SITE_MIN_PAGES
        ? ` — not compared under ${SITE_MIN_PAGES} pages`
        : p.dominant === null
          ? ` — no value on ${Math.round(SITE_DOMINANT_SHARE * 100)}% of them`
          : ` — dominant ${p.dominant}${numeric ? p.unit : ""}`;
    const lone = Object.entries(p.outliers).sort((a, b) => a[0].localeCompare(b[0]));
    const where = lone
      .slice(0, SITE_ROUTES_SHOWN)
      .map(([route, v]) => `${routeText(route)} (${listValues(v.slice(0, 3), p.unit)})`)
      .join(", ");
    const tail =
      lone.length === 0 ? "" : `; only one page uses: ${where}${lone.length > SITE_ROUTES_SHOWN ? `, +${lone.length - SITE_ROUTES_SHOWN} more` : ""}`;
    lines.push(`${p.dominant !== null && lone.length > 0 ? "→" : "·"} ${head}${verdict}${tail}${p.scored ? "" : " (listed, not scored)"}`);
  }
  return lines;
}

/**
 * The audit's SITE CONSISTENCY block: the comparison across every page with a
 * sample, and where the audited route stands against it. Empty until
 * SITE_MIN_PAGES pages carry a sample.
 */
export function siteAuditSection(
  pages: Readonly<
    Record<string, { system?: DesignSystemSample; deductions?: ReadonlyArray<{ dimension: string; label: string; count: number; points: number }> }>
  >,
  route: string,
): string {
  const site = siteConsistency(pages);
  if (!site) return "";
  const own = pages[route];
  const lines = formatSiteConsistency(site).map((l) => `  ${l}`);
  const charged = site.deductions[route] ?? [];
  const against =
    own && own.system
      ? charged.length === 0
        ? `  this page (${route}): no value only it uses; its score stands at ${siteScore(own, site, route).overall}/100`
        : `  this page (${route}) against the site: ${siteScore(own, site, route).overall}/100 — ${charged.map(formatDeduction).join(" · ")}`
      : "";
  return (
    `SITE CONSISTENCY (${site.pages} audited pages; the page score above is the page alone, these values are compared at read time):\n` +
    [...lines, ...(against ? [against] : [])].join("\n")
  );
}

/**
 * Reduce raw style records + page facts to a judgeable design digest + score.
 *
 * `chromeKeys` holds the signatures of elements that appear on most routes —
 * the sidebar, header, breadcrumb bar. They are scored ONCE, globally, not once
 * per page, for exactly the reason coverage already folds them: a contrast
 * failure in the shared shell is one defect. Counting it per page did three
 * kinds of damage — it filed the same finding once per route (five findings for
 * two CSS declarations in one observed run), it drowned every page's TASK
 * EFFICIENCY line in the same two dozen nav links, and because chrome is spread
 * unevenly (breadcrumbs only on nested routes) it silently reordered the
 * worst-pages ranking the report leads with.
 *
 * Returns the signatures it saw so the caller can keep the census current.
 */
export function analyzeDesign(
  payload: DesignPayload,
  viewport: { width: number; height: number },
  chromeKeys: Set<string> = new Set(),
): { report: string; score: DesignScore | null; signatures: string[]; defects: DesignDefect[] } {
  const { records: allRecords, page } = payload;
  if (allRecords.length === 0) {
    return { report: "DESIGN AUDIT: no visible styled elements found (page empty or not hydrated).", score: null, signatures: [], defects: [] };
  }
  const signatures = allRecords.map(styleSignature);
  // Chrome is what the census has seen on most routes OR what the markup puts
  // in a shell landmark. The census alone needs several audited routes before
  // it knows anything, so the first pages of a run were scored with the whole
  // shell in them and later ones without — a page's score depended on when it
  // was audited. The landmark half is known from the first audit on.
  const isChrome = (r: StyleRecord): boolean => r.shell || chromeKeys.has(styleSignature(r));
  const chromeRecords = allRecords.filter(isChrome);
  // Everything below scores THIS page. `records` deliberately shadows the full
  // set so no rule can accidentally reach past the page's own content.
  const records = allRecords.filter((r) => !isChrome(r));
  if (records.length === 0) {
    return { report: "DESIGN AUDIT: this page is entirely shared layout chrome — nothing page-specific to score.", score: null, signatures, defects: [] };
  }
  const sections: string[] = [];

  // Each section builder adds its lines to `sections` in the report's order and returns what the score and the defects need.
  const contrastFails = contrastSection(records, sections);
  const { sizes, families, nearDupSizes, offScale } = typographySection(records, sections);
  const { readability, prose } = readabilitySection(records, sections);
  const { pad, mar } = spacingSection(records, sections);
  const tiny = tinyTargetSection(records, allRecords, sections);
  const clipped = clippedSection(records, sections);
  const touchingGroups = touchingSection(page, sections);
  const touchingPairs = touchingGroups.reduce((n, g) => n + g.pairs.length, 0);
  const nearMiss = alignmentSection(records, viewport, sections);
  const { consistency, buttonRadii, buttonHeights, shadows } = consistencySection(records, sections);
  const { palette, grays, hueFamilies, pureBlackCount } = paletteSection(records, prose, sections);
  const slopTells = slopTellSection(records, sections);
  const structure = structureSection(page, sections);
  const names = namesSection(records, sections);
  const { focusless, dominantBody, indistinct, chromeIndistinct } = affordancesSection(records, chromeRecords, page, sections);
  const distorted = imagesSection(page, sections);
  layoutSection(allRecords, page, viewport, sections);
  const effort = taskEfficiencySection(records, page, viewport, sections);

  // ---- Always-on coherence summary: the design system at a glance, with healthy ranges.
  const gridPct = pad.n > 0 ? 100 - pad.pct : 100;
  const summary =
    `SYSTEM SUMMARY: ${sizes.length} font sizes (≤7 healthy) · ${families.length} families (≤2) · ` +
    `${buttonRadii.length} button radii (1–2) · ${buttonHeights.length} button heights (1–3) · ${shadows.size} shadow styles (≤3) · ` +
    `${grays.length} grays (4–6) · ${hueFamilies.size} accent hue families (1–3 + status) · ${gridPct}% spacing on 4px grid · ` +
    `${page.density} interactive elements in first viewport${page.density > 40 ? " (dense — consider progressive disclosure)" : ""}`;

  // ---- Multi-indicator PAGE SCORE, from named deductions (scoreFrom). Each
  //      rule costs points per occurrence up to a cap, so no one rule can sink
  //      a page alone. A measured defect (a ⚠ line: contrast, focus, target
  //      size, names, touching containers, clipped text, distorted images,
  //      sideways scroll) costs its full weight; a suggestion (a → line, or a
  //      heuristic such as the 4px grid or near-miss alignments, which a
  //      well-made page often trips on purpose) costs SUGGESTION_WEIGHT of it.
  //      Calibrated on the synthetic pages in design-test and the
  //      design-scores smoke suite (a clean page stays at 100, each defect
  //      class lands below it, and a page with several lands below 80) and on
  //      well-made public pages, which land around 80 or above.
  const ded: ScoreDeduction[] = [];
  const add = (tier: RuleTier, dimension: ScoreDimension, label: string, count: number, each: number, cap: number): void => {
    const points = Math.round(Math.min(cap, count * each) * (tier === "defect" ? 1 : SUGGESTION_WEIGHT));
    if (count > 0 && points > 0) ded.push({ dimension, label, count, points });
  };
  const beyond = (n: number, healthy: number): number => Math.max(0, n - healthy);
  add("defect", "a11y", "contrast failures", contrastFails.length, 3, 15);
  add("defect", "a11y", "no visible focus", focusless.length, 4, 12);
  add("defect", "a11y", "small targets", tiny.length, 2, 10);
  add("defect", "a11y", "unnamed controls", names.unnamed.length, 5, 15);
  add("defect", "a11y", "placeholder-only labels", names.placeholder.length, 3, 9);
  add("defect", "craft", "touching containers", touchingPairs, 8, 24);
  add("defect", "craft", "clipped text", clipped.length, 3, 9);
  add("defect", "craft", "distorted images", distorted.length, 4, 8);
  add("suggestion", "craft", "readability", readability.length, 2, 8);
  add("suggestion", "craft", `${grays.length} grays`, beyond(grays.length, 6) > 0 ? 1 : 0, 2 * beyond(grays.length, 6), 12);
  add("suggestion", "craft", `${hueFamilies.size} accent hues`, beyond(hueFamilies.size, 5) > 0 ? 1 : 0, 2 * beyond(hueFamilies.size, 5), 6);
  add("suggestion", "craft", "pure black body text", pureBlackCount > 0 ? 1 : 0, 2, 2);
  add("suggestion", "craft", "template tells", slopTells.length, 3, 9);
  add(
    "suggestion",
    "consistency",
    `${buttonHeights.length} button heights`,
    beyond(buttonHeights.length, 3) > 0 ? 1 : 0,
    4 * beyond(buttonHeights.length, 3),
    12,
  );
  add("suggestion", "consistency", `${buttonRadii.length} button radii`, beyond(buttonRadii.length, 2) > 0 ? 1 : 0, 3 * beyond(buttonRadii.length, 2), 9);
  add("suggestion", "consistency", `${shadows.size} shadow styles`, beyond(shadows.size, 3) > 0 ? 1 : 0, 2 * beyond(shadows.size, 3), 8);
  add("suggestion", "consistency", "paddings off the 4px grid", pad.n > 10 && pad.pct > 20 ? 1 : 0, 6, 6);
  add("suggestion", "consistency", "margins off the 4px grid", mar.n > 10 && mar.pct > 20 ? 1 : 0, 4, 4);
  add("suggestion", "consistency", "near-miss alignments", nearMiss.length, 2, 6);
  add("suggestion", "consistency", `${sizes.length} font sizes`, beyond(sizes.length, 7) > 0 ? 1 : 0, 2 * beyond(sizes.length, 7), 8);
  add("suggestion", "consistency", "font sizes under 1px apart", nearDupSizes.length > 0 ? 1 : 0, 3, 3);
  add("suggestion", "consistency", `type sizes off the scale: ${typeSizesText(offScale)}`, offScale.length > 0 ? 1 : 0, 2 * offScale.length, 8);
  add("defect", "clarity", "sideways scroll", page.scrollW > viewport.width + 8 ? 1 : 0, 12, 12);
  add("suggestion", "clarity", "task-effort issues", effort.length, 6, 18);
  add("suggestion", "clarity", "heading structure", structure.length, 3, 9);
  const score: DesignScore = { ...scoreFrom(ded), system: systemSample(allRecords.filter((r) => !r.shell)) };
  const { overall, a11y: a11yScore, craft: craftScore, consistency: consistencyScore, clarity: clarityScore } = score;
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "E";
  const top = score.deductions.slice(0, TOP_DEDUCTIONS).map(formatDeduction);
  const more = score.deductions.length - top.length;
  const scoreLine =
    `PAGE SCORE: ${overall}/100 (${grade}) — a11y ${a11yScore} · craft ${craftScore} · consistency ${consistencyScore} · task-clarity ${clarityScore}\n` +
    (top.length === 0 ? `  why: no deductions` : `  why: ${top.join(" · ")}${more > 0 ? ` (+${more} smaller)` : ""}`);

  const { chromeSection, chromeDefects } = sharedChromeSection(chromeRecords, allRecords, chromeIndistinct, dominantBody);

  const header =
    `DESIGN AUDIT (${records.length} page elements sampled` +
    `${chromeRecords.length > 0 ? `, ${chromeRecords.length} shared-chrome elements excluded from the score` : ""}): ` +
    `${sections.length === 0 ? "no measurable issues — and see the system summary below." : `${sections.length} issue group(s).`}`;
  const report =
    [header, ...sections, ...chromeSection, summary, scoreLine].join("\n\n") +
    `\n\nJudge with product context: ⚠ lines are measurable defects; → lines are craft suggestions (how the page could be BETTER, not just what's broken). ` +
    `Not every flag is a bug — dense data tables legitimately use small targets. The score is a comparator across pages and runs, not an absolute verdict. ` +
    `File real defects with scout_finding (category "visual"/"a11y") and genuine improvement opportunities as severity-low "ux-polish", quoting the concrete numbers.`;
  const defects: DesignDefect[] = [
    ...contrastFails.map((detail) => ({ rule: "contrast" as const, detail })),
    // Worded exactly as the shell's (below), so one control is one fact whether or not it is known chrome yet.
    ...tiny.map((r) => ({ rule: "tiny-target" as const, detail: tinyTargetDetail(r) })),
    ...clipped.filter((r) => r.textLen > 0).map((r) => ({ rule: "clipped-text" as const, detail: clippedTextDetail(r) })),
    ...focusless.map((f) => ({ rule: "focus-indicator" as const, detail: `${f.label} — no visible focus indicator` })),
    ...distorted.map(({ img, off }) => ({
      rule: "image-aspect" as const,
      detail: `${img.label} — rendered ${img.rw}×${img.rh} vs natural ${img.nw}×${img.nh} (aspect off by ${Math.round(off * 100)}%)`,
    })),
    ...(page.scrollW > viewport.width + 8
      ? [{ rule: "horizontal-scroll" as const, detail: `content ${page.scrollW}px wide in a ${viewport.width}px viewport` }]
      : []),
    ...touchingGroups.map((g) => ({ rule: "touching-containers" as const, detail: touchingDetail(g) })),
    // The same thresholds as the SPACING and AFFORDANCES lines above, so the check and the audit agree on what they saw.
    // Worded without counts or percentages: a spacing scale and a link style are app-wide conventions, so the same
    // values on ten pages are one entry on ten routes, and the entry's fingerprint does not move when content does.
    ...(pad.n > 10 && pad.pct > 20 ? [{ rule: "off-grid-spacing" as const, detail: `paddings off a 4px grid: ${gridValues(pad.top)}` }] : []),
    ...(mar.n > 10 && mar.pct > 20 ? [{ rule: "off-grid-spacing" as const, detail: `vertical margins off a 4px grid: ${gridValues(mar.top)}` }] : []),
    ...(indistinct.length > 0 ? [{ rule: "indistinct-link" as const, detail: indistinctDetail(dominantBody ?? "") }] : []),
    ...chromeDefects,
  ];
  return { report, score, signatures, defects };
}

/**
 * The design-system values a page uses (DesignSystemSample), each list
 * distinct, sorted and capped. Read from every record outside the shell's
 * landmarks, the census's chrome included: the census learns as pages are
 * audited, so leaving its chrome out would make a page's values depend on when
 * it was audited, and chrome is on most pages, so it is never a value one page
 * alone uses.
 */
function systemSample(records: readonly StyleRecord[]): DesignSystemSample {
  const CAP = 16;
  const distinct = (values: string[]): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).slice(0, CAP);
  // Radii of control-sized buttons only, the 12–80px the heights are counted over: a button drawn as a card (a
  // sign-in page's role tiles) carries the card's radius, and is not a control whose radius one page alone uses.
  const { buttonHeights, buttonRadii } = buttonSystem(records.filter((r) => r.tag !== "button" || (r.rect.h >= 12 && r.rect.h <= 80)));
  const padUse = new Map<number, number>();
  for (const v of records.flatMap((r) => r.padding)) if (v > 0) padUse.set(Math.round(v), (padUse.get(Math.round(v)) ?? 0) + 1);
  const sizes = [...new Set(records.filter((r) => r.text).map((r) => Math.round(r.fontSize * 10) / 10))].sort((a, b) => a - b);
  return {
    buttonHeights: buttonHeights.slice(0, CAP),
    buttonRadii: distinct(buttonRadii),
    headers: distinct(records.filter((r) => r.tag === "h1" && r.text).map((r) => `${Math.round(r.fontSize * 10) / 10}px ${r.fontWeight}`)),
    tabs: distinct(records.filter((r) => r.role === "tab").map((r) => `${Math.round(r.rect.h / 2) * 2}px tall, ${radiusLabel(r)} radius`)),
    // The commonest steps when there are more than the cap (grayCensus lists them commonest first).
    grays: distinct(
      grayCensus(paintedColours(records))
        .slice(0, CAP)
        .map((g) => `rgb(${g.rgb.join(", ")})`),
    ),
    fontSizes: sizes.slice(0, CAP),
    spacing: [...padUse]
      .filter(([, n]) => n >= 2)
      .map(([v]) => v)
      .sort((a, b) => a - b)
      .slice(0, CAP),
  };
}

/** Section 1 of the audit, CONTRAST: the page's WCAG contrast failures. */
function contrastSection(records: StyleRecord[], sections: string[]): string[] {
  // ---- 1. CONTRAST (WCAG): normal text needs 4.5:1, large text (≥24px, or ≥18.7px bold) needs 3:1.
  const contrastFails = contrastFailures(records);
  if (contrastFails.length > 0) {
    sections.push(
      `CONTRAST failures (${contrastFails.length}):\n` +
        contrastFails
          .slice(0, 8)
          .map((s) => `  ⚠ ${s}`)
          .join("\n"),
    );
  }
  // Text over a gradient, or over a panel the read cannot place, that passes on part of it: no score, a look by eye.
  const unsure = contrastUnsure(records);
  if (unsure.length > 0) {
    sections.push(
      `CONTRAST unsure (${unsure.length}, not scored; check by eye):\n` +
        unsure
          .slice(0, 4)
          .map((s) => `  → ${s}`)
          .join("\n"),
    );
  }
  return contrastFails;
}

// ---------------------------------------------------------------------------
// Type scale: whether the page's font sizes are steps of one scale.
// ---------------------------------------------------------------------------

/** The ratios a type scale is commonly built on, from a major second (1.125) to the golden ratio (1.618). */
export const TYPE_RATIOS: readonly number[] = [1.125, 1.2, 1.25, 1.333, 1.414, 1.5, 1.618];
/** A size is a step of the scale when it is within this share of one (or TYPE_FIT_PX, whichever is larger): designers round a step to a whole pixel. */
const TYPE_FIT = 0.025;
const TYPE_FIT_PX = 0.5;
/** The steps of a scale counted from the base: a little text below it, headings far above. */
const TYPE_STEPS = { below: 2, above: 10 } as const;
/** A step system: every size a whole multiple of this many pixels (12, 14, 16, 18, 20, 24, 30…). */
const TYPE_GRID = 2;
/** A ratio is inferred from the page only when it explains at least this many sizes off the step grid (and more than it leaves out): one fit is a coincidence. */
const TYPE_RATIO_MIN_FITS = 2;
/** Text under this size is a caption, a badge or a footnote, where an off-scale size is ordinary. */
const TYPE_MIN_PX = 12;
/** Off-scale sizes needed before the page is charged: a page legitimately keeps one or two. */
export const TYPE_OFF_MIN = 3;

/** What the type-scale read found on a page. */
export interface TypeScale {
  /** The body size the scale is counted from: the size carrying the most text between 12 and 24px. Null when no text that matters is in that range. */
  base: number | null;
  /** The ratio inferred from the page, from TYPE_RATIOS; null when none explains TYPE_RATIO_MIN_FITS sizes off the step grid. */
  ratio: number | null;
  /** Distinct sizes of the text that matters, px, ascending. */
  sizes: number[];
  /** Whole-pixel sizes that are neither a step of the scale, the base itself, nor on a step grid (2px, or an eighth of the base). */
  offScale: number[];
}

/** Lower-cased family names (the first one the page asks for) of fonts whose sizes follow their own rules: code and icons. */
const TYPE_EXEMPT_FAMILIES = ["mono", "code", "consolas", "menlo", "monaco", "courier", "icon", "awesome", "symbol", "glyph"];
const TYPE_EXEMPT_TAGS = new Set(["code", "pre", "kbd", "samp", "var"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Non-interactive text this long is body text; shorter is a label or a badge. */
const TYPE_BODY_CHARS = 20;

/**
 * The text whose size a type scale is about: headings, controls and body
 * text, at least TYPE_MIN_PX, with a letter in it, and not code or an icon
 * font. A badge, a footnote, a code sample or an icon glyph keeps its own
 * size on a well-made page, so none of them counts.
 */
function typeScaleText(r: StyleRecord): boolean {
  if (!r.text || r.fontSize < TYPE_MIN_PX || TYPE_EXEMPT_TAGS.has(r.tag)) return false;
  const family = r.fontFamily.toLowerCase();
  if (TYPE_EXEMPT_FAMILIES.some((f) => family.includes(f))) return false;
  if (!/\p{L}/u.test(r.text)) return false;
  return HEADING_TAGS.has(r.tag) || r.interactive || r.textLen >= TYPE_BODY_CHARS;
}

const onStep = (size: number, step: number, within: number): boolean => Math.abs(size - step * Math.round(size / step)) <= within;
/**
 * Whether a size is on a step grid: the 2px one, or an eighth of the body size,
 * which is 0.125rem where the body is set at the root (an 18px root's 1.5rem is
 * 27px). Sizes are read to a tenth of a pixel, so the second allows that much.
 */
const onTypeGrid = (size: number, base: number): boolean => onStep(size, TYPE_GRID, 0.25) || onStep(size, base / 8, 0.06);
/**
 * A size that is not a whole pixel was computed, by a fluid formula (clamp(), a
 * vw term such as responsive headings below a breakpoint) or a multiplier, and at one
 * viewport the audit cannot tell that formula from a deliberate scale. Only a
 * whole-pixel size is held to be picked one at a time.
 */
const wholePixel = (size: number): boolean => Number.isInteger(size);

/** How far `size` is from the nearest step of `ratio` counted from `base`, as a share of that step; null when that step is past the ones counted. */
function typeStepError(size: number, base: number, ratio: number): number | null {
  const k = Math.round(Math.log(size / base) / Math.log(ratio));
  if (k < -TYPE_STEPS.below || k > TYPE_STEPS.above) return null;
  const step = base * ratio ** k;
  const off = Math.abs(size - step);
  return off <= Math.max(TYPE_FIT * step, TYPE_FIT_PX) ? off / step : null;
}

/**
 * Whether a page's type follows a scale. The base is the size most of the
 * page's text that matters is set in (12–24px). A size is on the scale when
 * it is on the 2px step grid most systems use (or an eighth of the base, the
 * same grid under another root size), or a step of one ratio (TYPE_RATIOS)
 * counted from the base. The ratio is inferred from the sizes the grid does
 * not explain: the one that explains the most of them, if it explains at
 * least two and more than it leaves out, so a rem-based scale (16, 20, 25,
 * 31.25px) reads as a scale while stray sizes that happen to fit a ratio do
 * not. What is left, and is a whole pixel, is off the scale: a size with a
 * fraction was computed (a fluid clamp() or vw size, a multiplier), and at
 * one viewport that cannot be told from a deliberate scale.
 */
export function typeScale(records: readonly StyleRecord[]): TypeScale {
  const chars = new Map<number, number>();
  for (const r of records.filter(typeScaleText)) {
    const size = Math.round(r.fontSize * 10) / 10;
    chars.set(size, (chars.get(size) ?? 0) + Math.max(1, r.textLen));
  }
  const sizes = [...chars.keys()].sort((a, b) => a - b);
  const body = sizes.filter((s) => s >= TYPE_MIN_PX && s <= 24);
  if (body.length === 0) return { base: null, ratio: null, sizes, offScale: [] };
  const base = body.reduce((best, s) => (chars.get(s)! > chars.get(best)! ? s : best));
  const offGrid = sizes.filter((s) => s !== base && !onTypeGrid(s, base));
  let ratio: number | null = null;
  let best = { fits: 0, error: Infinity };
  for (const r of TYPE_RATIOS) {
    const errors = offGrid.map((s) => typeStepError(s, base, r)).filter((e): e is number => e !== null);
    const error = errors.reduce((n, e) => n + e, 0) / Math.max(1, errors.length);
    if (errors.length > best.fits || (errors.length === best.fits && errors.length > 0 && error < best.error)) {
      best = { fits: errors.length, error };
      ratio = r;
    }
  }
  // A ratio must explain at least two sizes, and more than it leaves out: with seven ratios and a tolerance, two
  // stray sizes often fit one by chance, and a fourth stray must never excuse the first three.
  if (best.fits < TYPE_RATIO_MIN_FITS || best.fits <= offGrid.length - best.fits) ratio = null;
  const offScale = offGrid.filter((s) => wholePixel(s) && (ratio === null || typeStepError(s, base, ratio) === null));
  return { base, ratio, sizes, offScale };
}

/** "15, 17, 19px", at most four, then how many more. */
export function typeSizesText(sizes: readonly number[]): string {
  const shown = sizes.slice(0, 4).join(", ");
  return `${shown}px${sizes.length > 4 ? ` +${sizes.length - 4}` : ""}`;
}

/** Section 2 of the audit, TYPOGRAPHY: the page's font sizes and families. */
function typographySection(records: StyleRecord[], sections: string[]): { sizes: number[]; families: string[]; nearDupSizes: number[]; offScale: number[] } {
  // ---- 2. TYPOGRAPHY entropy: a page using >7 font sizes or >2 families usually
  //      lacks a scale, sizes <1px apart are drift, not deliberate steps, and
  //      several sizes that are neither a step of the page's scale nor on a 2px
  //      grid are sizes picked one at a time (typeScale).
  const sizes = [...new Set(records.filter((r) => r.text).map((r) => r.fontSize))].sort((a, b) => a - b);
  const families = [...new Set(records.filter((r) => r.text && r.fontFamily).map((r) => r.fontFamily))];
  const nearDupSizes = sizes.filter((s, i) => i > 0 && s - sizes[i - 1] < 1 && s - sizes[i - 1] > 0);
  const scale = typeScale(records);
  const offScale = scale.offScale.length >= TYPE_OFF_MIN ? scale.offScale : [];
  if (sizes.length > 7 || families.length > 2 || nearDupSizes.length > 0 || offScale.length > 0) {
    const eighth = scale.base === null ? TYPE_GRID : Math.round((scale.base / 8) * 1000) / 1000;
    const grid = eighth === TYPE_GRID ? `a ${TYPE_GRID}px step grid` : `a ${TYPE_GRID}px or ${eighth}px step grid`;
    const against =
      scale.ratio === null
        ? `not on ${grid}, and no ${TYPE_RATIOS[0]}–${TYPE_RATIOS[TYPE_RATIOS.length - 1]}× scale from the ${scale.base}px body size fits them`
        : `neither steps of the ${scale.ratio}× scale from the ${scale.base}px body size nor on ${grid}`;
    sections.push(
      `TYPOGRAPHY: ${sizes.length} distinct font sizes (${sizes.slice(0, 12).join(", ")}${sizes.length > 12 ? "…" : ""})` +
        (families.length > 2 ? ` · ${families.length} font families (${families.slice(0, 4).join(", ")})` : "") +
        (nearDupSizes.length > 0
          ? `\n  → sizes <1px apart (${nearDupSizes.join(", ")}) are drift, not scale steps — a type scale wants ≥1.15× between steps`
          : "") +
        (offScale.length > 0
          ? `\n  → ${offScale.length} sizes off the type scale in headings, body text or controls: ${typeSizesText(offScale)} — ${against}; set each on a step`
          : ""),
    );
  }
  return { sizes, families, nearDupSizes, offScale };
}

/** Section 3 of the audit, READABILITY: measure, line height, body size, justified text and long capitals. */
function readabilitySection(records: StyleRecord[], sections: string[]): { readability: string[]; prose: StyleRecord[] } {
  // ---- 3. READABILITY: measure, line-height rhythm, body size, justified text, long ALL-CAPS.
  // Per-check caps keep any single symptom from drowning the section; one
  // overall truncation caps the section itself.
  const readability: string[] = [];
  const capped = (cap: number, hits: string[]): void => void readability.push(...hits.slice(0, cap));
  const prose = records.filter((r) => r.textLen > 80 && !r.interactive);
  capped(
    6,
    prose
      .filter((p) => p.textLen > 150)
      .map((r) => ({ r, chars: Math.round(r.rect.w / (r.fontSize * 0.5)) }))
      .filter(({ chars }) => chars > 95)
      .map(({ r, chars }) => `→ ${label(r)} — ~${chars} characters per line (65–75ch ideal, 90 max); cap the text column's width`),
  );
  capped(
    3,
    prose
      .filter((r) => r.lineHeight > 0 && r.fontSize <= 20)
      .map((r) => ({ r, ratio: Math.round((r.lineHeight / r.fontSize) * 100) / 100 }))
      .filter(({ ratio }) => ratio < 1.25 || ratio > 2.0)
      .map(({ r, ratio }) =>
        ratio < 1.25
          ? `→ ${label(r)} — line-height ${ratio} is cramped for body prose (1.4–1.6 breathes)`
          : `→ ${label(r)} — line-height ${ratio} is loose; lines drift apart`,
      ),
  );
  capped(
    2,
    prose.filter((p) => p.textLen > 120 && p.fontSize < 13).map((r) => `→ ${label(r)} — ${r.fontSize}px body text for a long passage; 14–16px reads better`),
  );
  capped(
    2,
    records
      .filter((p) => p.textAlign === "justify" && p.textLen > 80)
      .map((r) => `→ ${label(r)} — justified text produces uneven word rivers on the web; left-align`),
  );
  capped(
    2,
    records
      .filter((p) => p.textTransform === "uppercase" && p.textLen > 30)
      .map((r) => `→ ${label(r)} — ${r.textLen} chars of ALL-CAPS; caps suit short labels, hurt scanning at length`),
  );
  if (readability.length > 0)
    sections.push(
      `READABILITY:\n` +
        readability
          .slice(0, 14)
          .map((s) => `  ${s}`)
          .join("\n"),
    );
  return { readability, prose };
}

/** How many spacing values sit off a 4px grid, as a percentage, the commonest of them and how many were measured. */
interface GridStats {
  pct: number;
  top: Array<[number, number]>;
  n: number;
}

/** Section 4 of the audit, SPACING: paddings and vertical margins off a 4px grid. */
function spacingSection(records: StyleRecord[], sections: string[]): { pad: GridStats; mar: GridStats } {
  // ---- 4. SPACING scale: paddings AND vertical margins off a 4px grid suggest ad-hoc values.
  const gridStats = (values: number[]): { pct: number; top: Array<[number, number]>; n: number } => {
    const off = new Map<number, number>();
    let n = 0;
    for (const v of values) {
      if (v <= 0) continue;
      n += 1;
      if (Math.abs(v - Math.round(v / 4) * 4) > 0.5) off.set(v, (off.get(v) ?? 0) + 1);
    }
    const offTotal = [...off.values()].reduce((a, b) => a + b, 0);
    return { pct: n > 0 ? Math.round((offTotal / n) * 100) : 0, top: [...off.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5), n };
  };
  const pad = gridStats(records.flatMap((r) => r.padding));
  const mar = gridStats(records.flatMap((r) => r.marginV));
  const spacingLines: string[] = [];
  if (pad.n > 10 && pad.pct > 20)
    spacingLines.push(`${pad.pct}% of paddings are off a 4px grid — ad-hoc values: ${pad.top.map(([v, n]) => `${v}px×${n}`).join(", ")}`);
  if (mar.n > 10 && mar.pct > 20)
    spacingLines.push(`${mar.pct}% of vertical margins are off a 4px grid — ad-hoc values: ${mar.top.map(([v, n]) => `${v}px×${n}`).join(", ")}`);
  if (spacingLines.length > 0) sections.push(`SPACING: ` + spacingLines.join("\n  "));
  return { pad, mar };
}

/** Section 5 of the audit, TINY targets: controls below the WCAG 2.5.8 target size. */
function tinyTargetSection(records: StyleRecord[], allRecords: StyleRecord[], sections: string[]): StyleRecord[] {
  // ---- 5. Touch/click targets below ~24px are hard to hit (WCAG 2.5.8). Measured
  //      on what the user hits (a native input's label or drop zone), with
  //      that rule's exceptions: inline links, and a small target with nothing
  //      else within its 24px circle. Worst offenders first.
  const tiny = records.filter((r) => tooSmall(r, allRecords)).sort((a, b) => targetBox(a).w * targetBox(a).h - targetBox(b).w * targetBox(b).h);
  if (tiny.length > 0) {
    sections.push(
      `TINY targets (${tiny.length}, smallest first):\n` +
        tiny
          .slice(0, 6)
          .map((r) => `  ⚠ ${label(r)} — ${targetBox(r).w}×${targetBox(r).h}px`)
          .join("\n"),
    );
  }
  return tiny;
}

/** Section 6 of the audit, CLIPPED text. */
function clippedSection(records: StyleRecord[], sections: string[]): StyleRecord[] {
  // ---- 6. Clipped text (overflow hidden without ellipsis) — content silently cut off.
  const clipped = records.filter((r) => r.clipped);
  if (clipped.length > 0) {
    sections.push(
      `CLIPPED text (${clipped.length}):\n` +
        clipped
          .slice(0, 6)
          .map((r) => `  ⚠ ${label(r)} — text wider than its box, no ellipsis`)
          .join("\n"),
    );
  }
  return clipped;
}

/** Section 7 of the audit, ALIGNMENT: columns whose left edges nearly line up. */
function alignmentSection(records: StyleRecord[], viewport: { width: number; height: number }, sections: string[]): string[] {
  // ---- 7. Near-miss alignment: columns whose left edges differ by 1–4px look "off" without being nameable from a screenshot.
  const xCounts = new Map<number, number>();
  for (const r of records) {
    if (r.rect.x >= 0 && r.rect.x < viewport.width) xCounts.set(r.rect.x, (xCounts.get(r.rect.x) ?? 0) + 1);
  }
  const columns = [...xCounts.entries()]
    .filter(([, n]) => n >= 4)
    .map(([x]) => x)
    .sort((a, b) => a - b);
  const nearMiss: string[] = [];
  for (let i = 1; i < columns.length && nearMiss.length < 4; i++) {
    const delta = columns[i] - columns[i - 1];
    if (delta >= 1 && delta <= 4) {
      nearMiss.push(`columns at x=${columns[i - 1]} (${xCounts.get(columns[i - 1])} els) vs x=${columns[i]} (${xCounts.get(columns[i])} els) — ${delta}px off`);
    }
  }
  if (nearMiss.length > 0) {
    sections.push(`ALIGNMENT near-misses:\n` + nearMiss.map((s) => `  → ${s}`).join("\n"));
  }
  return nearMiss;
}

/** One wording for a parent's touching boxes, in the report and as a defect: the parent first, since the fix is usually its gap. */
function touchingDetail(g: { parent: string; pairs: TouchingPair[] }): string {
  const shown = g.pairs
    .slice(0, 3)
    .map((p) => `${p.a} and ${p.b} ${p.gap}px apart`)
    .join("; ");
  return `in ${g.parent}: ${shown}${g.pairs.length > 3 ? `; +${g.pairs.length - 3} more` : ""}`;
}

/** Section 7b of the audit, TOUCHING CONTAINERS: sibling cards drawn edge to edge with no gap. */
function touchingSection(page: DesignPagePayload, sections: string[]): Array<{ parent: string; pairs: TouchingPair[] }> {
  const groups = touchingContainers(page.boxGroups ?? []);
  const pairs = groups.reduce((n, g) => n + g.pairs.length, 0);
  if (groups.length > 0) {
    sections.push(
      `TOUCHING CONTAINERS (${pairs} pair${pairs === 1 ? "" : "s"}):\n` +
        groups
          .slice(0, 6)
          .map((g) => `  ⚠ ${touchingDetail(g)} — separate boxes with 0–${TOUCH_GAP}px between them; give the parent a gap`)
          .join("\n"),
    );
  }
  return groups;
}

/** Section 8 of the audit, CONSISTENCY: button radii and heights, and shadow styles. */
function consistencySection(
  records: StyleRecord[],
  sections: string[],
): { consistency: string[]; buttonRadii: string[]; buttonHeights: number[]; shadows: Map<string, number> } {
  // ---- 8. CONSISTENCY: one control system, one elevation system.
  //      Radii ≥ half the element height render as a pill regardless of raw value (9999px, Chromium's 16777200px clamp).
  const consistency: string[] = [];
  const { buttonRadii, buttonHeights } = buttonSystem(records);
  if (buttonRadii.length > 2) {
    consistency.push(`→ buttons use ${buttonRadii.length} different corner radii (${buttonRadii.slice(0, 6).join(", ")}) — pick one radius per control tier`);
  }
  if (buttonHeights.length > 3) {
    consistency.push(
      `→ buttons render at ${buttonHeights.length} different heights (${buttonHeights.slice(0, 8).join(", ")}px) — 1–2 control sizes read as a system`,
    );
  }
  // Keyed on the layers that draw something (elevationKey); each example shows the layer that sets it apart.
  const shadows = new Map<string, number>();
  for (const r of records) {
    const key = elevationKey(r.shadow);
    if (key) shadows.set(key, (shadows.get(key) ?? 0) + 1);
  }
  if (shadows.size > 3) {
    const keys = [...shadows.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = keys.slice(0, 3).map((k) => `"${distinguishingLayer(k, keys.slice(0, 3)).slice(0, 60)}"`);
    consistency.push(`→ ${shadows.size} distinct box-shadow styles (${top.join(", ")}…) — an elevation system needs 2–3 levels, not one per component`);
  }
  if (consistency.length > 0) sections.push(`CONSISTENCY:\n` + consistency.map((s) => `  ${s}`).join("\n"));
  return { consistency, buttonRadii, buttonHeights, shadows };
}

/** A corner radius as the audit names it: "pill" at half the height or more (9999px, Chromium's 16777200px clamp), else its px. */
const radiusLabel = (r: StyleRecord): string => (r.radius >= r.rect.h / 2 && r.radius > 0 ? "pill" : `${r.radius}px`);

/** The buttons' distinct corner radii, and their distinct heights between 12 and 80px rounded to 2px, ascending. */
function buttonSystem(records: readonly StyleRecord[]): { buttonRadii: string[]; buttonHeights: number[] } {
  const buttons = records.filter((r) => r.interactive && r.tag === "button");
  return {
    buttonRadii: [...new Set(buttons.map(radiusLabel))],
    buttonHeights: [...new Set(buttons.filter((b) => b.rect.h >= 12 && b.rect.h <= 80).map((b) => Math.round(b.rect.h / 2) * 2))].sort((a, b) => a - b),
  };
}

/** Every text and background colour the records paint, as RGB: what the gray census and the hue families count. */
function paintedColours(records: readonly StyleRecord[]): Array<[number, number, number]> {
  const colours: Array<[number, number, number]> = [];
  for (const r of records) {
    for (const c of [r.color, r.bg]) {
      const p = parseRgb(c);
      if (p) colours.push([p[0], p[1], p[2]]);
    }
  }
  return colours;
}

/** Section 9 of the audit, PALETTE: pure black body text, the gray scale and the accent hues. */
function paletteSection(
  records: StyleRecord[],
  prose: StyleRecord[],
  sections: string[],
): { palette: string[]; grays: Array<{ rgb: [number, number, number]; n: number }>; hueFamilies: Map<number, number>; pureBlackCount: number } {
  // ---- 9. PALETTE discipline: near-black beats #000; a gray SCALE beats ad-hoc grays; few accent hues beat many.
  const palette: string[] = [];
  const pureBlack = prose.filter((r) => r.color === "rgba(0, 0, 0, 1)" && (parseRgb(r.bg) ?? [0, 0, 0]).slice(0, 3).every((c) => c >= 250));
  if (pureBlack.length > 0) {
    palette.push(
      `→ pure #000-on-#fff body text (${pureBlack.length} block(s), e.g. ${label(pureBlack[0])}) — near-black (rgb(23,23,23)-ish) reads softer at length`,
    );
  }
  const hueFamilies = new Map<number, number>();
  const colours = paintedColours(records);
  for (const rgb of colours) {
    const hue = hueOf(rgb);
    if (hue !== null) {
      const bucket = (Math.round(hue / 30) * 30) % 360;
      hueFamilies.set(bucket, (hueFamilies.get(bucket) ?? 0) + 1);
    }
  }
  const grays = grayCensus(colours);
  if (grays.length > 6) {
    const top = grays.slice(0, 5).map((g) => `rgb(${g.rgb.join(",")})`);
    palette.push(`→ ${grays.length} distinct grays (${top.join(", ")}…) — a deliberate gray scale runs 4–6 steps; near-duplicates suggest ad-hoc values`);
  }
  if (hueFamilies.size > 5) {
    const hues = [...hueFamilies.keys()].sort((a, b) => a - b);
    palette.push(
      `→ ${hueFamilies.size} accent hue families (~${hues.join("°, ")}°) — focused palettes run 1–3 hues plus semantic status colors (charts are a legitimate exception)`,
    );
  }
  if (palette.length > 0) sections.push(`PALETTE:\n` + palette.map((s) => `  ${s}`).join("\n"));
  return { palette, grays, hueFamilies, pureBlackCount: pureBlack.length };
}

/** Section 9b of the audit, AI-SLOP TELLS: stylistic patterns that read as template output. */
function slopTellSection(records: StyleRecord[], sections: string[]): string[] {
  // ---- 9b. AI-SLOP TELLS (impeccable.style's absolute bans): stylistic patterns
  //      so strongly associated with template/AI output that their presence
  //      reads as "nobody designed this". Counted, first offender named.
  const slopTells: string[] = [];
  const tell = (key: keyof StyleRecord, msg: string): void => {
    const hits = records.filter((r) => r[key] as boolean);
    if (hits.length > 0) slopTells.push(`→ ${msg} — ${hits.length}× (e.g. ${label(hits[0])})`);
  };
  tell("sideStripe", "side-stripe borders (colored border-left/right accent; rewrite with full borders, background tints, or nothing)");
  tell("gradientText", "gradient text (background-clip:text over a gradient; use a solid color, emphasize via weight/size)");
  tell("glass", "glassmorphism (decorative backdrop-filter blur; rare and purposeful, or not at all)");
  tell("glow", "neon glow shadows (large-blur saturated box-shadow)");
  tell("aiGradient", "violet/purple gradient backgrounds (the stock AI palette)");
  // Identical card grids: ≥4 same-sized rounded boxes is the template look.
  const cardKey = new Map<string, StyleRecord[]>();
  for (const r of records) {
    if (r.rect.w < 150 || r.rect.w > 520 || r.rect.h < 90 || r.rect.h > 520 || r.radius <= 0) continue;
    const key = `${Math.round(r.rect.w / 4) * 4}×${Math.round(r.rect.h / 4) * 4}`;
    const arr = cardKey.get(key) ?? [];
    arr.push(r);
    cardKey.set(key, arr);
  }
  for (const [key, arr] of cardKey) {
    if (arr.length >= 4 && slopTells.length < 8) {
      slopTells.push(
        `→ ${arr.length} identical ${key}px cards (e.g. ${label(arr[0])}) — same-size card grids read as template output; vary sizes or drop the cards`,
      );
      break;
    }
  }
  if (slopTells.length > 0) sections.push(`AI-SLOP TELLS:\n` + slopTells.map((s) => `  ${s}`).join("\n"));
  return slopTells;
}

/** Section 10 of the audit, STRUCTURE: the heading hierarchy. */
function structureSection(page: DesignPagePayload, sections: string[]): string[] {
  // ---- 10. STRUCTURE: heading hierarchy is the page's information architecture made visible.
  const structure: string[] = [];
  const h1s = page.headings.filter((h) => h.level === 1);
  if (page.headings.length > 0 && h1s.length === 0) structure.push(`→ no <h1> — the page has headings but no top-level anchor`);
  if (h1s.length > 1) structure.push(`→ ${h1s.length} <h1> elements — one page, one primary heading`);
  const levelsUsed = [...new Set(page.headings.map((h) => h.level))].sort((a, b) => a - b);
  for (let i = 1; i < levelsUsed.length; i++) {
    if (levelsUsed[i] - levelsUsed[i - 1] > 1)
      structure.push(`→ heading levels skip h${levelsUsed[i - 1]}→h${levelsUsed[i]} — screen-reader outlines lose a level`);
  }
  const avgSize = new Map<number, number>();
  for (const lvl of levelsUsed) {
    const of = page.headings.filter((h) => h.level === lvl);
    avgSize.set(lvl, of.reduce((a, h) => a + h.size, 0) / of.length);
  }
  for (let i = 1; i < levelsUsed.length; i++) {
    const [hi, lo] = [levelsUsed[i - 1], levelsUsed[i]];
    if ((avgSize.get(lo) ?? 0) > (avgSize.get(hi) ?? 0) + 1) {
      structure.push(
        `→ h${lo} renders larger than h${hi} (${Math.round(avgSize.get(lo)!)}px vs ${Math.round(avgSize.get(hi)!)}px) — visual hierarchy contradicts the semantic one`,
      );
    }
  }
  if (structure.length > 0) sections.push(`STRUCTURE:\n` + structure.map((s) => `  ${s}`).join("\n"));
  return structure;
}

/** Section 10b of the audit, NAMES: controls with no accessible name, or named only by a placeholder. */
function namesSection(records: StyleRecord[], sections: string[]): { unnamed: StyleRecord[]; placeholder: StyleRecord[] } {
  // ---- 10b. NAMES: a control a screen reader cannot name, or a field labelled
  //      only by a placeholder that disappears as the user types.
  const names = unnamedControls(records);
  const nameLines = [
    ...names.unnamed.map(
      (r) => `⚠ ${label(r)} — ${r.tag === "input" || r.tag === "select" || r.tag === "textarea" ? "field" : "control"} with no accessible name`,
    ),
    ...names.placeholder.map((r) => `⚠ ${label(r)} — labelled only by its placeholder, which is gone once the user types`),
  ];
  if (nameLines.length > 0) {
    sections.push(
      `NAMES (${nameLines.length}):\n` +
        nameLines
          .slice(0, 6)
          .map((s) => `  ${s}`)
          .join("\n"),
    );
  }
  return names;
}

/** Section 11 of the audit, AFFORDANCES: focus indicators, and links that look like body text. */
function affordancesSection(
  records: StyleRecord[],
  chromeRecords: StyleRecord[],
  page: DesignPagePayload,
  sections: string[],
): { focusless: FocusSample[]; dominantBody: string | undefined; indistinct: StyleRecord[]; chromeIndistinct: StyleRecord[] } {
  // ---- 11. AFFORDANCES: keyboard focus visibility (trusted-Tab sampled engine-side) + indistinguishable links.
  const affordances: string[] = [];
  const focusless = page.focusSamples.filter((f) => !f.indicator);
  if (focusless.length > 0) {
    affordances.push(
      `⚠ ${focusless.length}/${page.focusSamples.length} keyboard tab stops show NO visible focus indicator (outline/shadow/border unchanged on focus): ${focusless
        .slice(0, 6)
        .map((f) => f.label)
        .join(", ")}${focusless.length > 6 ? " …" : ""}`,
    );
  }
  const bodyColorFreq = new Map<string, number>();
  for (const r of records) if (r.textLen > 40 && r.tag !== "a" && r.color !== "unknown") bodyColorFreq.set(r.color, (bodyColorFreq.get(r.color) ?? 0) + 1);
  const dominantBody = [...bodyColorFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const looksLikeBody = (r: StyleRecord): boolean => r.tag === "a" && r.textLen > 0 && !r.underline && r.color === dominantBody;
  const indistinct = dominantBody ? records.filter(looksLikeBody) : [];
  // Navigation links are this rule's commonest subject and usually sit in the
  // shell, so the shell's are measured too, against the page's body colour, and
  // reported as the shell's.
  const chromeIndistinct = dominantBody ? chromeRecords.filter(looksLikeBody) : [];
  if (dominantBody) {
    if (indistinct.length > 0) {
      affordances.push(`→ ${indistinct.length} link(s) with no underline AND the same color as body text (e.g. ${label(indistinct[0])}) — invisible as links`);
    }
  }
  if (affordances.length > 0) sections.push(`AFFORDANCES:\n` + affordances.map((s) => `  ${s}`).join("\n"));
  return { focusless, dominantBody, indistinct, chromeIndistinct };
}

/** Section 12 of the audit, IMAGES: aspect-ratio distortion. */
function imagesSection(page: DesignPagePayload, sections: string[]): Array<{ img: PageImage; off: number }> {
  // ---- 12. IMAGES: aspect-ratio distortion (rendered box fights the source's proportions).
  const distorted = page.images.flatMap((img) => {
    const off = aspectDistortion(img);
    return off === null ? [] : [{ img, off }];
  });
  if (distorted.length > 0) {
    sections.push(
      `IMAGES (${distorted.length} distorted):\n` +
        distorted
          .slice(0, 5)
          .map(
            ({ img, off }) =>
              `  ⚠ ${img.label} — rendered ${img.rw}×${img.rh} vs natural ${img.nw}×${img.nh} (aspect off by ${Math.round(off * 100)}%; use object-fit)`,
          )
          .join("\n"),
    );
  }
  return distorted;
}

/** Section 13 of the audit, LAYOUT: horizontal overflow and the share of the viewport fixed chrome takes. */
function layoutSection(allRecords: StyleRecord[], page: DesignPagePayload, viewport: { width: number; height: number }, sections: string[]): void {
  // ---- 13. LAYOUT: horizontal overflow + fixed chrome share. Sticky bars ride
  //      along as the user scrolls; past ~1/4 of the viewport they turn every
  //      screenful of content into a letterbox.
  const layout: string[] = [];
  if (page.scrollW > viewport.width + 8) {
    layout.push(`⚠ page scrolls horizontally — content ${page.scrollW}px vs ${viewport.width}px viewport (a responsive break at this width)`);
  }
  // Only bands currently on screen count (a sticky header far down a list is
  // not pinned), and overlapping bars within one band count once (max, not
  // sum) — otherwise ten section headers "occupy" a third of a viewport they
  // never actually share.
  // Over allRecords, not the page partition: this rule's entire subject is the
  // fixed shell, so measuring it against records with the shell removed made it
  // structurally unable to fire once the chrome census warmed up.
  const chromeBands = new Map<number, number>();
  for (const r of allRecords) {
    if (!r.fixed || r.rect.w < viewport.width * 0.6 || r.rect.h < 24 || r.rect.h > viewport.height * 0.6) continue;
    if (r.rect.y >= viewport.height || r.rect.y + r.rect.h <= 0) continue;
    const band = Math.round(r.rect.y / 40) * 40;
    chromeBands.set(band, Math.max(chromeBands.get(band) ?? 0, r.rect.h));
  }
  const chromeH = [...chromeBands.values()].reduce((a, b) => a + b, 0);
  if (chromeH > viewport.height * 0.25) {
    layout.push(
      `→ fixed/sticky chrome occupies ~${Math.min(100, Math.round((chromeH / viewport.height) * 100))}% of the viewport (${Math.round(chromeH)}px of bars that follow every scroll) — content gets a letterbox; consider collapsing chrome on scroll`,
    );
  }
  if (layout.length > 0) sections.push(`LAYOUT:\n` + layout.map((l) => `  ${l}`).join("\n"));
}

/** Section 14 of the audit, TASK EFFICIENCY: the primary action, form burden and information scent. */
function taskEfficiencySection(records: StyleRecord[], page: DesignPagePayload, viewport: { width: number; height: number }, sections: string[]): string[] {
  // ---- 14. TASK EFFICIENCY: not "does it work" but "is it easy" — can a user
  //      see what to do, find it without scrolling, and finish without being
  //      over-asked? These are the journey-level questions a pass/fail e2e
  //      suite never answers.
  const effort: string[] = [];
  const pageBg = parseRgb(records.find((r) => r.bg && r.bg.startsWith("rgb"))?.bg ?? "") ?? [255, 255, 255, 1];
  // A "prominent" action = a button (or a link painted as one) that paints its
  // own background, clearly departing from the page background, at a clickable
  // size. That is what the eye lands on, so it is the page's implied primary
  // action. Fields never qualify — a white text field on a grey page departs
  // from the page background too — nor does a ghost button showing a card's
  // background, nor a breadcrumb, which is a way back rather than an action.
  const prominent = records.filter((r) => {
    if (!r.interactive || !buttonLike(r) || !r.filled || r.inBreadcrumb || r.rect.w < 60 || r.rect.h < 24) return false;
    const bg = parseRgb(r.bg);
    if (!bg) return false;
    const delta = Math.abs(bg[0] - pageBg[0]) + Math.abs(bg[1] - pageBg[1]) + Math.abs(bg[2] - pageBg[2]);
    return delta > 90;
  });
  const foldH = viewport.height;
  if (prominent.length === 0) {
    effort.push(
      `→ no visually dominant action on this page — nothing is filled/coloured enough to read as "the next step"; a user must read every control to decide what to do`,
    );
  } else if (prominent.length > 3) {
    effort.push(
      `→ ${prominent.length} equally-prominent actions compete for attention (${prominent
        .slice(0, 4)
        .map((r) => label(r))
        .join(", ")}…) — when everything is emphasised nothing is; demote secondary actions to outline/text style`,
    );
  }
  const aboveFold = prominent.filter((r) => r.rect.y >= 0 && r.rect.y < foldH);
  if (prominent.length > 0 && aboveFold.length === 0) {
    const nearest = prominent.reduce((a, b) => (a.rect.y < b.rect.y ? a : b));
    effort.push(
      `→ the primary action (${label(nearest)}) sits ${Math.round(nearest.rect.y - foldH)}px below the fold — the user must scroll before seeing what this page is for`,
    );
  }
  // Form burden: how much is being asked, and how much of it is actually needed.
  const fields = formFields(records);
  if (fields.length >= 5) {
    const req = fields.filter((r) => r.required).length;
    if (req === 0) {
      effort.push(
        `→ ${fields.length} form fields and NONE marked required (no required/aria-required) — the user cannot tell what is actually needed to finish, so the form reads as ${fields.length} obligations instead of the few that matter`,
      );
    } else if (fields.length - req >= 8) {
      effort.push(
        `→ ${fields.length} fields of which only ${req} are required — ${fields.length - req} optional fields are shown up-front; consider progressive disclosure ("add details" / a second step) so the required path is short`,
      );
    }
  }
  // Information scent: does the page say what it is and what to do?
  const hasHeading = page.headings.length > 0;
  const submits = records.filter((r) => r.submitish && r.interactive);
  if (!hasHeading && records.length > 20) {
    effort.push(
      `→ no heading element on a content-bearing page — nothing states what this screen is, which hurts orientation and screen-reader navigation alike`,
    );
  }
  if (fields.length >= 3 && submits.length === 0) {
    effort.push(`→ ${fields.length} input fields but no obvious submit/confirm control detected — a user filling this in has no clear way to commit it`);
  }
  if (effort.length > 0) sections.push(`TASK EFFICIENCY:\n` + effort.map((s) => `  ${s}`).join("\n"));
  return effort;
}

/** The SHARED CHROME section and its defects: the shell's own, reported apart from the page's score. */
function sharedChromeSection(
  chromeRecords: StyleRecord[],
  allRecords: StyleRecord[],
  chromeIndistinct: StyleRecord[],
  dominantBody: string | undefined,
): { chromeSection: string[]; chromeDefects: DesignDefect[] } {
  // Shared shell, reported separately and NOT scored into this page. Contrast
  // is the only rule worth restating here: it is the one that generated the
  // duplicate findings, and the fix lives in one stylesheet rather than on
  // whichever page happened to be audited when it was noticed.
  // Chrome is excluded from the page's SCORE, but its defects must still be
  // reported or the partition would silently delete whole rule classes for the
  // shell — sub-minimum tap targets and clipped labels in a sidebar would be
  // seen by no page at all.
  const chromeSection: string[] = [];
  const chromeDefects: DesignDefect[] = [];
  if (chromeRecords.length > 0) {
    chromeDefects.push(
      ...contrastFailures(chromeRecords).map((detail) => ({ rule: "contrast" as const, detail, chrome: true })),
      ...chromeRecords.filter((r) => tooSmall(r, allRecords)).map((r) => ({ rule: "tiny-target" as const, detail: tinyTargetDetail(r), chrome: true })),
      ...chromeRecords.filter((r) => r.clipped && r.textLen > 0).map((r) => ({ rule: "clipped-text" as const, detail: clippedTextDetail(r), chrome: true })),
      ...(chromeIndistinct.length > 0 ? [{ rule: "indistinct-link" as const, detail: indistinctDetail(dominantBody ?? ""), chrome: true }] : []),
    );
    // A convention (indistinct-link) is a → line, as it is on the page; the rest are measurable defects.
    const chromeIssues = chromeDefects.map((d) => `${d.rule === "indistinct-link" ? "→" : "⚠"} ${d.detail}`);
    if (chromeIssues.length > 0) {
      chromeSection.push(
        `SHARED CHROME (${chromeRecords.length} shell elements, excluded from this page's score and reported here instead):\n` +
          [...new Set(chromeIssues)]
            .slice(0, CHROME_ISSUE_CAP)
            .map((s) => `  ${s}`)
            .join("\n") +
          `\n  → these belong to the app shell and recur on every page that renders it. File ONE finding for the shell, not one per page.`,
      );
    }
  }
  return { chromeSection, chromeDefects };
}
