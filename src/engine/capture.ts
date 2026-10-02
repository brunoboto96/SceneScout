/**
 * An element's picture: which rectangle of the viewport it is (its bounds plus
 * a margin), what the file is called, how scout_capture reports it, and where
 * the same page is on another deployment. The screenshot itself is taken in
 * browser.ts; everything here is table-tested without a browser (ci-test).
 * Used by `scenescout ci --show`, which a `/scenescout qa show` or `compare`
 * comment runs (docs/ci.md).
 */

/** CSS pixels kept around the element, so its edges and shadow are in the picture. */
export const CAPTURE_MARGIN = 8;
export const MAX_CAPTURE_MARGIN = 64;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle to screenshot: the element's box grown by `margin` on each
 * side, cut to the viewport, in whole pixels. Null when nothing of it is in
 * the viewport, or it has no area.
 */
export function captureClip(box: Box, margin: number, viewport: { width: number; height: number }): Box | null {
  const m = Math.max(0, Math.min(MAX_CAPTURE_MARGIN, Math.floor(margin)));
  if (!(box.width > 0 && box.height > 0)) return null;
  const left = Math.max(0, Math.floor(box.x - m));
  const top = Math.max(0, Math.floor(box.y - m));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + m));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + m));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Whether an element itself (its margin aside) reaches outside the viewport
 * once scrolled into view, so only the part inside is pictured: then a phrase
 * saying so, for the report; null when all of it is in the picture. A pixel of
 * slack, for boxes at fractional positions.
 */
export function cutByViewport(box: Box, viewport: { width: number; height: number }): string | null {
  const inside = box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1;
  if (inside) return null;
  return `only the part inside the ${viewport.width}×${viewport.height} window is pictured: the element is ${Math.round(box.width)}×${Math.round(box.height)}`;
}

/** A capture's file name: lower-case letters, digits and dashes, then .png. Nothing else reaches the path. */
export function captureFileName(name: string | undefined): string {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "capture"}.png`;
}

/** The folder, under the project's .scenescout/, that scout_capture saves into. */
export const CAPTURES_DIRNAME = "captures";

/**
 * The name a capture was saved under, read back from its file's path: the
 * file must be directly in a captures folder. Either separator is read, so a
 * path written on Windows (C:\…\captures\preview.png) reads the same as
 * one written elsewhere. Null for any other path.
 */
export function capturedName(file: string): string | null {
  const parts = String(file).split(/[\\/]+/);
  const name = parts.at(-1) ?? "";
  if (parts.length < 2 || parts.at(-2) !== CAPTURES_DIRNAME || !/^[a-z0-9-]{1,40}\.png$/.test(name)) return null;
  return name.slice(0, -".png".length);
}

/** What scout_capture saved, as its result's last line carries it for a program to read. */
export interface CaptureInfo {
  /** The PNG's absolute path. */
  file: string;
  /** The element's identity (a test id, or role and name): the same element on another deployment has the same key. */
  key: string;
  /** Its accessible name as the snapshot listed it. */
  label: string;
  /** The page it was on. */
  url: string;
  /** The picture's size in pixels. */
  width: number;
  height: number;
}

export const CAPTURED_PREFIX = "CAPTURED ";

/** scout_capture's result: a line for whoever reads it, then the details as one line of JSON. */
export function captureResultText(info: CaptureInfo): string {
  return (
    `Saved a ${info.width}×${info.height} picture of ${info.label ? `"${info.label.replace(/\s+/g, " ")}"` : info.key} on ${info.url} to ${info.file}.\n` +
    `${CAPTURED_PREFIX}${JSON.stringify(info)}`
  );
}

/** Reads a scout_capture result back. Null for any other text, or a line that is not a whole capture. */
export function parseCaptureResult(text: string): CaptureInfo | null {
  const line = text
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(CAPTURED_PREFIX));
  if (!line) return null;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(CAPTURED_PREFIX.length));
  } catch {
    return null;
  }
  const o = v as Partial<CaptureInfo> | null;
  if (!o || typeof o !== "object") return null;
  if (typeof o.file !== "string" || typeof o.key !== "string" || typeof o.url !== "string") return null;
  if (!Number.isInteger(o.width) || !Number.isInteger(o.height)) return null;
  return { file: o.file, key: o.key, label: typeof o.label === "string" ? o.label : "", url: o.url, width: o.width!, height: o.height! };
}

/** A URL's directory: everything up to and including the last slash of its path. */
function directoryOf(u: URL): string {
  return `${u.origin}${u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1)}`;
}

/**
 * Where a page of one deployment is on another. `page` is where the element
 * was found on the deployment reached at `fromRoot`; the answer is the same
 * page under `toRoot`. A page under `fromRoot`'s directory keeps its path
 * relative to it (so roots with a path prefix map onto each other); the root
 * itself maps to `toRoot`; any other page of the same origin keeps its path
 * on `toRoot`'s origin. Null for a page on another origin: there is no telling
 * where it is on the other deployment.
 */
export function rebaseUrl(page: string, fromRoot: string, toRoot: string): string | null {
  let p: URL;
  let from: URL;
  let to: URL;
  try {
    p = new URL(page);
    from = new URL(fromRoot);
    to = new URL(toRoot);
  } catch {
    return null;
  }
  if (p.origin !== from.origin) return null;
  const rest = `${p.search}${p.hash}`;
  if (p.pathname === from.pathname) return `${to.origin}${to.pathname}${rest || to.search}`;
  const dir = directoryOf(from);
  const here = `${p.origin}${p.pathname}`;
  if (here.startsWith(dir)) return new URL(`${here.slice(dir.length)}${rest}`, directoryOf(to)).href;
  return new URL(`${p.pathname}${rest}`, to.origin).href;
}

/** What a run that was asked to show an element did, as ci.json records it. */
export interface CaptureOutcome {
  /** The words the element was asked for by. */
  what: string;
  /** captured: the pictures are in shots/. not-found: the model found no element to capture. failed: a capture was attempted and did not complete. */
  status: "captured" | "not-found" | "failed";
  /** Why, when it is not captured, or when the base half of a comparison failed. */
  detail?: string;
  /** The picture on the target: shots/preview.png. */
  preview?: { file: string; key: string; label: string; path: string; width: number; height: number };
  /** The same element on the base URL: shots/base.png. Absent without --compare-url, or when it could not be captured there. */
  base?: { file: string; path: string; width: number; height: number };
  /** The comparison: shots/diff.png. */
  diff?: {
    file: string;
    changedPixels: number;
    totalPixels: number;
    percent: number;
    sizeChanged: boolean;
    box: Box | null;
  };
}

/** The files a capture run writes, under shots/ in the run's output. Fixed names: nothing a model says becomes a path. */
export const SHOT_FILES = { preview: "preview.png", base: "base.png", diff: "diff.png" } as const;
export const SHOTS_DIRNAME = "shots";
