/**
 * Frames: an element's key and name inside a frame, a frame's rect in the
 * page's coordinates, and the snapshot lines for the frames under the page.
 */

import type { Rect } from "./geometry.js";

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
const MAX_FOREIGN_NAME = 40;

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
