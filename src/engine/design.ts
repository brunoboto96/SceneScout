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
  bg: string; // effective (ancestor-resolved) background, or "image"/"unknown"
  padding: [number, number, number, number]; // t r b l
  /** Vertical margins [top, bottom] — the other half of spacing rhythm. */
  marginV: [number, number];
  radius: number;
  /** box-shadow value (truncated) or "" — elevation-system consistency. */
  shadow: string;
  clipped: boolean;
  /** position:fixed/sticky — chrome that rides along as the user scrolls. */
  fixed: boolean;
  /** Form-control burden signals: is this a required field, and is it a submit control? */
  required: boolean;
  submitish: boolean;
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

export interface DesignPagePayload {
  /** Document scroll width vs window width — horizontal overflow detection. */
  scrollW: number;
  clientW: number;
  headings: Array<{ level: number; size: number; text: string }>;
  images: Array<{ label: string; nw: number; nh: number; rw: number; rh: number }>;
  /** Interactive elements intersecting the initial viewport — cognitive-density signal. */
  density: number;
  /** Filled engine-side (needs trusted keyboard events, not in-page JS). */
  focusSamples: FocusSample[];
}

export interface DesignPayload {
  records: StyleRecord[];
  page: DesignPagePayload;
}

/**
 * In-page collector, shipped as a string expression (immune to loader
 * transforms — same rationale as the interactables collector).
 */
export const DESIGN_COLLECT_SCRIPT = `(() => {
  const out = [];
  const px = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 10) / 10; };
  // Canvas fillStyle normalizes ANY CSS color (oklch, lab, color(), named) to
  // #rrggbb or rgba() — Tailwind v4 palettes compute to oklch and would
  // otherwise read as unparseable (and wrongly composite to white).
  const cctx = document.createElement("canvas").getContext("2d");
  const parseColor = (c) => {
    if (!c || c === "transparent") return null;
    let m = c.match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?/);
    if (!m && cctx) {
      try {
        cctx.fillStyle = "#010203";
        cctx.fillStyle = c;
        const norm = cctx.fillStyle;
        const hex = norm.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1];
        m = norm.match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?/);
      } catch (e) { /* unparseable — treated as absent */ }
    }
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  };
  const normColor = (c) => {
    const p = parseColor(c);
    return p ? "rgba(" + p[0] + ", " + p[1] + ", " + p[2] + ", " + p[3] + ")" : "unknown";
  };
  // Effective background: COMPOSITE translucent ancestor layers (a chip with
  // rgba(...,0.12) over white is nearly white — treating it as opaque produces
  // false WCAG failures). Stops at the first opaque layer; white fallback.
  const effBg = (el) => {
    const layers = [];
    let node = el;
    for (let i = 0; node && i < 20; i++, node = node.parentElement) {
      const s = window.getComputedStyle(node);
      if (s.backgroundImage && s.backgroundImage !== "none") return "image";
      const c = parseColor(s.backgroundColor);
      if (!c || c[3] === 0) continue;
      layers.push(c);
      if (c[3] >= 1) break;
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    }
    return "rgb(" + Math.round(base[0]) + ", " + Math.round(base[1]) + ", " + Math.round(base[2]) + ")";
  };
  const hasOwnText = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim().length > 0) return true;
    }
    return false;
  };
  const interactiveSel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]';
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
      bg: effBg(el),
      padding: [px(s.paddingTop), px(s.paddingRight), px(s.paddingBottom), px(s.paddingLeft)],
      marginV: [px(s.marginTop), px(s.marginBottom)],
      radius: px(s.borderTopLeftRadius),
      shadow: s.boxShadow && s.boxShadow !== "none" ? s.boxShadow.replace(/\\s+/g, " ").slice(0, 80) : "",
      // srOnly text is DELIBERATELY a 1px box with overflow hidden — the exact
      // signature of "text wider than its box". Flagging it reported the
      // accessibility affordance itself as an accessibility defect.
      clipped: !srOnly && el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(s.overflowX) && s.textOverflow !== "ellipsis" && ownText,
      fixed: s.position === "fixed" || s.position === "sticky",
      required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
      submitish: el.matches('button[type="submit"], input[type="submit"]') || /\\b(save|submit|create|send|confirm|apply|continue|next|finish|approve|sign)\\b/i.test(fullText),
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
    images.push({ label, nw: img.naturalWidth, nh: img.naturalHeight, rw: Math.round(r.width), rh: Math.round(r.height) });
  }
  const page = {
    scrollW: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    clientW: window.innerWidth,
    headings,
    images,
    density,
    focusSamples: [],
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

const label = (r: StyleRecord): string => (r.testid ? `[${r.testid}]` : `<${r.tag}> "${r.text.slice(0, 30) || "(no text)"}"`);

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

/**
 * WCAG contrast check over a record set. Shared by the page pass and the
 * shared-chrome pass so the thresholds (and the message shape a reader learns
 * to scan) are stated once rather than copied.
 */
function contrastFailures(records: StyleRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (!r.text || r.bg === "image" || r.bg === "unknown" || r.color === "unknown") continue;
    const ratio = contrastRatio(r.color, r.bg);
    if (ratio === null) continue;
    const isLarge = r.fontSize >= 24 || (r.fontSize >= 18.7 && r.fontWeight >= 700);
    const threshold = isLarge ? 3 : 4.5;
    if (ratio < threshold) out.push(`${label(r)} — ${ratio.toFixed(2)}:1 (needs ${threshold}:1) ${r.color} on ${r.bg}`);
  }
  return out;
}

/** Below the WCAG 2.2 target-size minimum; inline links are exempt by that rule. */
function tooSmall(r: StyleRecord): boolean {
  return r.tag !== "a" && (r.rect.h < 24 || r.rect.w < 24) && r.rect.h > 0;
}

/** Multi-indicator quality score for one page (0–100 each; overall weighted). */
export interface DesignScore {
  overall: number;
  a11y: number;
  craft: number;
  consistency: number;
  clarity: number;
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
): { report: string; score: DesignScore | null; signatures: string[] } {
  const { records: allRecords, page } = payload;
  if (allRecords.length === 0) {
    return { report: "DESIGN AUDIT: no visible styled elements found (page empty or not hydrated).", score: null, signatures: [] };
  }
  const signatures = allRecords.map(styleSignature);
  const isChrome = (r: StyleRecord): boolean => chromeKeys.has(styleSignature(r));
  const chromeRecords = allRecords.filter(isChrome);
  // Everything below scores THIS page. `records` deliberately shadows the full
  // set so no rule can accidentally reach past the page's own content.
  const records = chromeKeys.size > 0 ? allRecords.filter((r) => !isChrome(r)) : allRecords;
  if (records.length === 0) {
    return { report: "DESIGN AUDIT: this page is entirely shared layout chrome — nothing page-specific to score.", score: null, signatures };
  }
  const sections: string[] = [];

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

  // ---- 2. TYPOGRAPHY entropy: a page using >7 font sizes or >2 families usually
  //      lacks a scale, and sizes <1px apart are drift, not deliberate steps.
  const sizes = [...new Set(records.filter((r) => r.text).map((r) => r.fontSize))].sort((a, b) => a - b);
  const families = [...new Set(records.filter((r) => r.text && r.fontFamily).map((r) => r.fontFamily))];
  const nearDupSizes = sizes.filter((s, i) => i > 0 && s - sizes[i - 1] < 1 && s - sizes[i - 1] > 0);
  if (sizes.length > 7 || families.length > 2 || nearDupSizes.length > 0) {
    sections.push(
      `TYPOGRAPHY: ${sizes.length} distinct font sizes (${sizes.slice(0, 12).join(", ")}${sizes.length > 12 ? "…" : ""})` +
        (families.length > 2 ? ` · ${families.length} font families (${families.slice(0, 4).join(", ")})` : "") +
        (nearDupSizes.length > 0
          ? `\n  → sizes <1px apart (${nearDupSizes.join(", ")}) are drift, not scale steps — a type scale wants ≥1.15× between steps`
          : ""),
    );
  }

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

  // ---- 5. Touch/click targets below ~24px are hard to hit. Inline links are
  //      exempt (mirrors the WCAG 2.2 target-size exception); worst offenders first.
  const tiny = records.filter((r) => r.interactive && tooSmall(r)).sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
  if (tiny.length > 0) {
    sections.push(
      `TINY targets (${tiny.length}, smallest first):\n` +
        tiny
          .slice(0, 6)
          .map((r) => `  ⚠ ${label(r)} — ${r.rect.w}×${r.rect.h}px`)
          .join("\n"),
    );
  }

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
    sections.push(`ALIGNMENT near-misses:\n` + nearMiss.map((s) => `  ⚠ ${s}`).join("\n"));
  }

  // ---- 8. CONSISTENCY: one control system, one elevation system.
  //      Radii ≥ half the element height render as a pill regardless of raw value (9999px, Chromium's 16777200px clamp).
  const consistency: string[] = [];
  const radiusLabel = (r: StyleRecord): string => (r.radius >= r.rect.h / 2 && r.radius > 0 ? "pill" : `${r.radius}px`);
  const buttons = records.filter((r) => r.interactive && r.tag === "button");
  const buttonRadii = [...new Set(buttons.map(radiusLabel))];
  if (buttonRadii.length > 3) {
    consistency.push(`→ buttons use ${buttonRadii.length} different corner radii (${buttonRadii.slice(0, 6).join(", ")}) — pick one radius per control tier`);
  }
  const buttonHeights = [...new Set(buttons.filter((b) => b.rect.h >= 12 && b.rect.h <= 80).map((b) => Math.round(b.rect.h / 2) * 2))].sort((a, b) => a - b);
  if (buttonHeights.length > 3) {
    consistency.push(
      `→ buttons render at ${buttonHeights.length} different heights (${buttonHeights.slice(0, 8).join(", ")}px) — 1–2 control sizes read as a system`,
    );
  }
  const shadows = new Map<string, number>();
  for (const r of records) if (r.shadow) shadows.set(r.shadow, (shadows.get(r.shadow) ?? 0) + 1);
  if (shadows.size > 4) {
    const top = [...shadows.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s]) => `"${s.slice(0, 40)}"`);
    consistency.push(`→ ${shadows.size} distinct box-shadow styles (${top.join(", ")}…) — an elevation system needs 2–3 levels, not one per component`);
  }
  if (consistency.length > 0) sections.push(`CONSISTENCY:\n` + consistency.map((s) => `  ${s}`).join("\n"));

  // ---- 9. PALETTE discipline: near-black beats #000; a gray SCALE beats ad-hoc grays; few accent hues beat many.
  const palette: string[] = [];
  const pureBlack = prose.filter((r) => r.color === "rgba(0, 0, 0, 1)" && (parseRgb(r.bg) ?? [0, 0, 0]).slice(0, 3).every((c) => c >= 250));
  if (pureBlack.length > 0) {
    palette.push(
      `→ pure #000-on-#fff body text (${pureBlack.length} block(s), e.g. ${label(pureBlack[0])}) — near-black (rgb(23,23,23)-ish) reads softer at length`,
    );
  }
  const grayFreq = new Map<string, number>();
  const hueFamilies = new Map<number, number>();
  for (const r of records) {
    for (const c of [r.color, r.bg]) {
      const p = parseRgb(c);
      if (!p) continue;
      const rgb: [number, number, number] = [p[0], p[1], p[2]];
      const spread = Math.max(...rgb) - Math.min(...rgb);
      const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
      if (spread <= 10 && avg > 20 && avg < 245) {
        const key = rgb.join(",");
        grayFreq.set(key, (grayFreq.get(key) ?? 0) + 1);
      }
      const hue = hueOf(rgb);
      if (hue !== null) {
        const bucket = (Math.round(hue / 30) * 30) % 360;
        hueFamilies.set(bucket, (hueFamilies.get(bucket) ?? 0) + 1);
      }
    }
  }
  if (grayFreq.size > 6) {
    const top = [...grayFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => `rgb(${k})`);
    palette.push(`→ ${grayFreq.size} distinct grays (${top.join(", ")}…) — a deliberate gray scale runs 4–6 steps; near-duplicates suggest ad-hoc values`);
  }
  if (hueFamilies.size > 5) {
    const hues = [...hueFamilies.keys()].sort((a, b) => a - b);
    palette.push(
      `→ ${hueFamilies.size} accent hue families (~${hues.join("°, ")}°) — focused palettes run 1–3 hues plus semantic status colors (charts are a legitimate exception)`,
    );
  }
  if (palette.length > 0) sections.push(`PALETTE:\n` + palette.map((s) => `  ${s}`).join("\n"));

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
  if (dominantBody) {
    const indistinct = records.filter((r) => r.tag === "a" && r.textLen > 0 && !r.underline && r.color === dominantBody);
    if (indistinct.length > 0) {
      affordances.push(`→ ${indistinct.length} link(s) with no underline AND the same color as body text (e.g. ${label(indistinct[0])}) — invisible as links`);
    }
  }
  if (affordances.length > 0) sections.push(`AFFORDANCES:\n` + affordances.map((s) => `  ${s}`).join("\n"));

  // ---- 12. IMAGES: aspect-ratio distortion (rendered box fights the source's proportions).
  const distorted = page.images.map((img) => ({ img, off: Math.abs(img.rw / img.rh / (img.nw / img.nh) - 1) })).filter(({ off }) => off > 0.12);
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

  // ---- 14. TASK EFFICIENCY: not "does it work" but "is it easy" — can a user
  //      see what to do, find it without scrolling, and finish without being
  //      over-asked? These are the journey-level questions a pass/fail e2e
  //      suite never answers.
  const effort: string[] = [];
  const pageBg = parseRgb(records.find((r) => r.bg && r.bg.startsWith("rgb"))?.bg ?? "") ?? [255, 255, 255, 1];
  // A "prominent" action = filled control whose background clearly departs
  // from the page background, at a clickable size. That is what the eye lands
  // on, so it is the page's implied primary action.
  const prominent = records.filter((r) => {
    if (!r.interactive || r.rect.w < 60 || r.rect.h < 24) return false;
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
  const fields = records.filter((r) => r.interactive && /input|select|textarea/.test(r.tag));
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

  // ---- Always-on coherence summary: the design system at a glance, with healthy ranges.
  const gridPct = pad.n > 0 ? 100 - pad.pct : 100;
  const summary =
    `SYSTEM SUMMARY: ${sizes.length} font sizes (≤7 healthy) · ${families.length} families (≤2) · ` +
    `${buttonRadii.length} button radii (1–2) · ${buttonHeights.length} button heights (1–3) · ${shadows.size} shadow styles (≤3) · ` +
    `${grayFreq.size} grays (4–6) · ${hueFamilies.size} accent hue families (1–3 + status) · ${gridPct}% spacing on 4px grid · ` +
    `${page.density} interactive elements in first viewport${page.density > 40 ? " (dense — consider progressive disclosure)" : ""}`;

  // ---- Multi-indicator PAGE SCORE. Deductive: start at 100 per dimension,
  //      subtract per measured issue, floor at 0. Weights favour a11y and
  //      task clarity — a page can be pretty and still hard to use.
  const floor0 = (n: number): number => Math.max(0, Math.round(n));
  const a11yScore = floor0(100 - contrastFails.length * 4 - focusless.length * 6 - tiny.length * 3);
  const craftScore = floor0(100 - readability.length * 4 - palette.length * 4 - slopTells.length * 5 - clipped.length * 3 - distorted.length * 4);
  const consistencyScore = floor0(
    100 -
      consistency.length * 8 -
      (pad.n > 10 && pad.pct > 20 ? 10 : 0) -
      (mar.n > 10 && mar.pct > 20 ? 6 : 0) -
      nearMiss.length * 3 -
      (sizes.length > 7 ? 5 : 0) -
      (nearDupSizes.length > 0 ? 5 : 0),
  );
  const clarityScore = floor0(100 - effort.length * 8 - (page.scrollW > viewport.width + 8 ? 15 : 0) - structure.length * 4);
  const overall = Math.round(a11yScore * 0.3 + craftScore * 0.25 + consistencyScore * 0.2 + clarityScore * 0.25);
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "E";
  const score: DesignScore = { overall, a11y: a11yScore, craft: craftScore, consistency: consistencyScore, clarity: clarityScore };
  const scoreLine = `PAGE SCORE: ${overall}/100 (${grade}) — a11y ${a11yScore} · craft ${craftScore} · consistency ${consistencyScore} · task-clarity ${clarityScore}`;

  // Shared shell, reported separately and NOT scored into this page. Contrast
  // is the only rule worth restating here: it is the one that generated the
  // duplicate findings, and the fix lives in one stylesheet rather than on
  // whichever page happened to be audited when it was noticed.
  // Chrome is excluded from the page's SCORE, but its defects must still be
  // reported or the partition would silently delete whole rule classes for the
  // shell — sub-minimum tap targets and clipped labels in a sidebar would be
  // seen by no page at all.
  const chromeSection: string[] = [];
  if (chromeRecords.length > 0) {
    const chromeIssues = [
      ...contrastFailures(chromeRecords),
      ...chromeRecords.filter((r) => r.interactive && tooSmall(r)).map((r) => `${label(r)} — ${Math.round(r.rect.w)}×${Math.round(r.rect.h)}px tap target`),
      ...chromeRecords.filter((r) => r.clipped && r.textLen > 0).map((r) => `${label(r)} — text is clipped by its container`),
    ];
    if (chromeIssues.length > 0) {
      chromeSection.push(
        `SHARED CHROME (${chromeRecords.length} shell elements, excluded from this page's score and reported here instead):\n` +
          [...new Set(chromeIssues)]
            .slice(0, CHROME_ISSUE_CAP)
            .map((s) => `  ⚠ ${s}`)
            .join("\n") +
          `\n  → these belong to the app shell and recur on every page that renders it. File ONE finding for the shell, not one per page.`,
      );
    }
  }

  const header =
    `DESIGN AUDIT (${records.length} page elements sampled` +
    `${chromeRecords.length > 0 ? `, ${chromeRecords.length} shared-chrome elements excluded from the score` : ""}): ` +
    `${sections.length === 0 ? "no measurable issues — and see the system summary below." : `${sections.length} issue group(s).`}`;
  const report =
    [header, ...sections, ...chromeSection, summary, scoreLine].join("\n\n") +
    `\n\nJudge with product context: ⚠ lines are measurable defects; → lines are craft suggestions (how the page could be BETTER, not just what's broken). ` +
    `Not every flag is a bug — dense data tables legitimately use small targets. The score is a comparator across pages and runs, not an absolute verdict. ` +
    `File real defects with scout_finding (category "visual"/"a11y") and genuine improvement opportunities as severity-low "ux-polish", quoting the concrete numbers.`;
  return { report, score, signatures };
}
