/**
 * An element's picture: which rectangle of the viewport it is (its bounds plus
 * a margin), what the file is called, how scout_capture reports it, and where
 * the same page is on another deployment. The screenshot itself is taken in
 * browser.ts; everything here is table-tested without a browser (ci-test).
 * Used by `scenescout ci --show`, which a `/scenescout qa show` or `compare`
 * comment runs (docs/ci.md).
 */

/** CSS pixels kept around the element, so its edges and shadow are in the picture. */
import { plainSegment } from "./replay.js";

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

// ── a finding's picture ─────────────────────────────────────────────────────
//
// Every finding is filed with a picture of what it is about: the element it
// names plus a margin, or the viewport when it names none. scout_finding
// takes the picture (browser.ts), and these rules decide whether one is taken,
// what it frames, how big it may be, whether the tool result carries it, and
// where it is kept, so each is table-tested (ci-test) without a browser.

/**
 * What happens to a finding's picture. "inline": it is kept under the run's
 * recordings/ folder, shown in report.html, and returned in the scout_finding
 * result, so a chat client shows it as the finding is filed. "file": kept and
 * shown in the report, not returned. "off": none is taken.
 */
export const EVIDENCE_MODES = ["inline", "file", "off"] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

export const EVIDENCE_ENV = "SCENESCOUT_EVIDENCE";
export const EVIDENCE_MAX_PX_ENV = "SCENESCOUT_EVIDENCE_MAX_PX";
export const EVIDENCE_MAX_KB_ENV = "SCENESCOUT_EVIDENCE_MAX_KB";
export const EVIDENCE_INLINE_ENV = "SCENESCOUT_EVIDENCE_INLINE";
export const RECORD_ENV = "SCENESCOUT_RECORD";

/**
 * The bounds a finding's picture is held to, and their defaults. The longer
 * side keeps a picture readable while a chat client's cost for it stays small;
 * the bytes bound what each picture adds to the conversation and the folder;
 * the inline count stops a run that files many findings from filling the
 * conversation with pictures (later ones are still kept and in the report).
 */
export const EVIDENCE_LIMITS = {
  maxPx: { env: EVIDENCE_MAX_PX_ENV, min: 160, max: 2000, default: 800, unit: "pixels on the picture's longer side" },
  maxKb: { env: EVIDENCE_MAX_KB_ENV, min: 16, max: 2048, default: 200, unit: "kilobytes a picture may take" },
  inline: { env: EVIDENCE_INLINE_ENV, min: 0, max: 500, default: 10, unit: "pictures one session returns in its scout_finding results" },
} as const;
export type EvidenceLimit = keyof typeof EVIDENCE_LIMITS;

/** CSS pixels kept around an element a finding names: more than scout_capture's, so what is next to it is in view. */
export const EVIDENCE_MARGIN = 24;

/** Whether this process runs in a CI job: the CI variable every hosted runner sets, read the way they set it. */
export function isCiEnv(env: Record<string, string | undefined>): boolean {
  const ci = (env.CI ?? "").trim().toLowerCase();
  return (ci !== "" && ci !== "0" && ci !== "false") || (env.GITHUB_ACTIONS ?? "").trim().toLowerCase() === "true";
}

export interface EvidenceSettings {
  mode: EvidenceMode;
  /** Where the mode came from: the attach option, the environment, or the default for this kind of run. */
  source: "option" | "environment" | "default (interactive)" | "default (CI)";
  maxPx: number;
  maxBytes: number;
  inlineMax: number;
}

function readLimit(kind: EvidenceLimit, env: Record<string, string | undefined>): number {
  const spec = EVIDENCE_LIMITS[kind];
  const raw = env[spec.env];
  if (raw === undefined || raw.trim() === "") return spec.default;
  const text = raw.trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < spec.min || value > spec.max)
    throw new Error(`${spec.env} must be a whole number of ${spec.unit}, from ${spec.min} to ${spec.max} (got "${raw}").`);
  return value;
}

/**
 * How this session treats a finding's picture: the attach option, else the
 * environment, else the default for the kind of run. Interactive use returns
 * the picture inline, which is what a person following the conversation
 * wants. A CI job keeps it on file only: nobody reads the conversation, and
 * `scenescout ci`'s model loop is text-only, so an image there is bytes no one
 * sees. A value outside the known ones is refused, never guessed at.
 */
export function evidenceSettings(asked: EvidenceMode | undefined, env: Record<string, string | undefined>): EvidenceSettings {
  const limits = { maxPx: readLimit("maxPx", env), maxBytes: readLimit("maxKb", env) * 1024, inlineMax: readLimit("inline", env) };
  if (asked) return { mode: asked, source: "option", ...limits };
  const raw = (env[EVIDENCE_ENV] ?? "").trim().toLowerCase();
  if (raw) {
    if (!(EVIDENCE_MODES as readonly string[]).includes(raw))
      throw new Error(`${EVIDENCE_ENV} must be one of ${EVIDENCE_MODES.join(", ")} (got "${env[EVIDENCE_ENV]}").`);
    return { mode: raw as EvidenceMode, source: "environment", ...limits };
  }
  return isCiEnv(env) ? { mode: "file", source: "default (CI)", ...limits } : { mode: "inline", source: "default (interactive)", ...limits };
}

/**
 * Whether a session keeps a frame after every action (scout_attach `record`):
 * the option, else SCENESCOUT_RECORD, else off. Off in every kind of run by
 * default: a recording is a picture per step of the app under test, and a
 * team that wants every QA run recorded says so once, in the server's
 * environment, rather than relying on each attach to ask.
 */
export function recordChoice(asked: boolean | undefined, env: Record<string, string | undefined>): boolean {
  if (asked !== undefined) return asked;
  const raw = (env[RECORD_ENV] ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (["on", "true", "1"].includes(raw)) return true;
  if (["off", "false", "0"].includes(raw)) return false;
  throw new Error(`${RECORD_ENV} must be on or off (got "${env[RECORD_ENV]}").`);
}

/** What a finding's picture frames, or why none is taken. */
export type EvidenceFrame = { take: true; frame: "element"; ref: string } | { take: true; frame: "viewport" } | { take: false; why: string };

/**
 * Whether a picture is taken for a filing, and of what. None when pictures
 * are off, when the session has no page open, or when the filing was merged
 * into a finding that already has its picture (one picture a finding, from
 * when it was first seen) — unless the merge reopened it as a regression,
 * when the new picture shows it is back. Otherwise the element the filing
 * names, else the viewport.
 */
export function evidenceFrame(o: {
  mode: EvidenceMode;
  ref?: string;
  pageOpen: boolean;
  isNew: boolean;
  hasPicture: boolean;
  regressed: boolean;
}): EvidenceFrame {
  if (o.mode === "off") return { take: false, why: "pictures are off for this session" };
  if (!o.pageOpen) return { take: false, why: "the session has no page open" };
  if (!o.isNew && o.hasPicture && !o.regressed) return { take: false, why: "the finding it merged into already has its picture" };
  const ref = (o.ref ?? "").trim();
  return ref ? { take: true, frame: "element", ref } : { take: true, frame: "viewport" };
}

/** Whether this picture goes into the tool result: inline mode, and the session's count not yet reached. */
export function returnsInline(mode: EvidenceMode, shownSoFar: number, inlineMax: number): boolean {
  return mode === "inline" && shownSoFar < inlineMax;
}

/**
 * Where a finding's picture is kept, relative to the project's .scenescout/
 * folder, with forward slashes: beside the session's recorded frames, so the
 * report and the live view reach it the way they reach a frame. The session
 * name is the agent's, so it is reduced to a plain name; the id is the
 * finding's, which is hex.
 */
export function findingPicturePath(session: string, id: string): string {
  // The same folder name as the session's frames (replay.ts framePath), so the two sit together.
  const plain = plainSegment(session, "session");
  const safeId = id.replace(/[^0-9a-f]/gi, "").slice(0, 40) || "finding";
  return `recordings/${plain}/finding-${safeId}.png`;
}

/** A finding's picture, as memory.json keeps it. */
export interface FindingPicture {
  /** Relative to the project's .scenescout/ folder (findingPicturePath). */
  file: string;
  width: number;
  height: number;
  /** What it shows: the element the filing named, or the viewport. */
  frame: "element" | "viewport";
  /** The element's name, when it frames one. */
  label?: string;
  /** When it was taken. */
  at: string;
}

/** Reads a finding's picture back from disk, or null for anything that is not one: the report links only what it can trust. */
export function readFindingPicture(v: unknown): FindingPicture | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<FindingPicture>;
  if (typeof o.file !== "string" || !/^recordings\/[a-z0-9._-]+\/finding-[0-9a-f]+\.png$/i.test(o.file)) return null;
  if (!Number.isInteger(o.width) || !Number.isInteger(o.height) || (o.frame !== "element" && o.frame !== "viewport")) return null;
  return {
    file: o.file,
    width: o.width!,
    height: o.height!,
    frame: o.frame,
    ...(typeof o.label === "string" && o.label ? { label: o.label } : {}),
    at: typeof o.at === "string" ? o.at : "",
  };
}

/** What a picture frames, in words for the report and the tool result. */
export function describePicture(p: Pick<FindingPicture, "frame" | "label" | "width" | "height">): string {
  const what =
    p.frame === "element" ? (p.label ? `"${p.label.replace(/\s+/g, " ").slice(0, 80)}" and around it` : "the element and around it") : "the page as it was";
  return `${p.width}×${p.height}, ${what}`;
}
