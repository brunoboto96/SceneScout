/**
 * What the page holds besides controls: images that failed to load and the
 * main region's content, each read by a page script and turned into snapshot
 * lines here.
 */

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

interface BrokenImage {
  alt: string;
  src: string;
  testid: string | null;
}

/** What the page script returns: up to 20 images, and how many there were in all. */
export interface BrokenImageScan {
  images: BrokenImage[];
  total: number;
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
