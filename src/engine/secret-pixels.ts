/**
 * Which parts of a picture are painted over before it is taken: every field
 * whose typed value the log would mask (sensitive.ts secretFieldKind), on the
 * page and in every frame. A visible secret field shows what it holds — after a
 * show-password toggle, or a card number in a plain text box — and a
 * screenshot, a recorded frame, a finding's picture or a baseline would keep it.
 *
 * Every secret field is painted, empty or not, so the paint does not depend on
 * when the field was read, and two pictures of the same page still compare. A
 * frame whose fields cannot be read, or that has more than MAX_FIELD_MASKS
 * secret ones, has all of its fields painted: masking errs towards hiding. The
 * rule is masksToPaint, table-tested in memory-test; secretFieldMasks reads the
 * page for it and is what browser.ts calls.
 */
import type { Frame, Locator, Page, PageScreenshotOptions } from "playwright";
import { secretFieldKind, type SecretFieldFacts } from "./sensitive.js";

/** The paint: one fixed colour, Playwright's own default, so a picture is the same from one run to the next. */
export const MASK_COLOR = "#FF00FF";

/** The elements a value can be typed into and shown in. Hidden inputs have no pixels. */
export const FIELD_SELECTOR = "input:not([type=hidden]), textarea, [contenteditable]:not([contenteditable=false])";

/**
 * The fields secret by an attribute alone (sensitive.ts: type=password, a
 * credential or card autocomplete token). Painted by this selector as well as
 * by place, because Playwright finds a selector's matches again as it paints:
 * a field the page adds above one of these between the read and the picture
 * moves the places, not the attributes.
 */
export const SECRET_BY_ATTRIBUTE = [
  'input[type="password" i]',
  ...["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"].map(
    (t) => `[autocomplete~="${t}" i]`,
  ),
].join(", ");

/**
 * The most fields of one frame painted by their place. Playwright finds each
 * such field again on its own as it paints, at a cost that grows with the page:
 * a grid of 625 one-character boxes took 14 s a picture in Firefox, longer than
 * a live-view still or a recorded frame may take. Past this many, every field
 * of the frame is painted by one selector instead.
 */
export const MAX_FIELD_MASKS = 32;

/**
 * For each frame, in order, which of its fields (by their place in the frame's
 * FIELD_SELECTOR matches) to paint, or "all" when the frame's fields could not
 * be read (null) or more than MAX_FIELD_MASKS of them are secret.
 */
export function masksToPaint(frames: ReadonlyArray<readonly SecretFieldFacts[] | null>): Array<number[] | "all"> {
  return frames.map((fields) => {
    if (fields === null) return "all";
    const paint: number[] = [];
    fields.forEach((facts, i) => {
      if (secretFieldKind(facts)) paint.push(i);
    });
    return paint.length > MAX_FIELD_MASKS ? "all" : paint;
  });
}

/**
 * The facts sensitive.ts reads, for every field of a frame, read in the page.
 * They are the facts typing into a field reads (browser.ts fillOrAppend, whose
 * in-page reader is its own copy, since a function passed into the page cannot
 * call another; change both together), except the snapshot's accessible name,
 * which a picture has not got.
 */
function readFieldFacts(nodes: Element[]): SecretFieldFacts[] {
  return nodes.map((node) => {
    const n = node as HTMLInputElement;
    const byIds = (ids: string | null): string =>
      (ids ?? "")
        .split(/\s+/)
        .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
        .join(" ");
    return {
      type: n.getAttribute("type"),
      autocomplete: n.getAttribute("autocomplete"),
      name: n.getAttribute("name"),
      id: n.id || null,
      placeholder: n.getAttribute("placeholder"),
      maxLength: typeof n.maxLength === "number" && n.maxLength >= 0 ? n.maxLength : null,
      label: [
        n.getAttribute("aria-label") ?? "",
        byIds(n.getAttribute("aria-labelledby")),
        ...Array.from(n.labels ?? []).map((l) => l.textContent ?? ""),
      ].filter((t) => t.trim() !== ""),
    };
  });
}

/** A frame's field facts, or null when they cannot be read within `timeoutMs` (a detached or stuck frame). */
async function frameFacts(frame: Frame, timeoutMs: number): Promise<SecretFieldFacts[] | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      frame.locator(FIELD_SELECTOR).evaluateAll(readFieldFacts),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    // Unreadable is not an error here: the frame's fields are all painted instead.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The locators to pass as a screenshot's `mask`, and the frames they were read
 * from. Each field is found again by its place among the frame's fields when
 * the picture is taken, which is the order evaluateAll read them in.
 */
async function secretFieldMasks(page: Page, readMs: number): Promise<{ mask: Locator[]; frames: Frame[] }> {
  const frames = page.frames();
  const plan = masksToPaint(await Promise.all(frames.map((f) => frameFacts(f, readMs))));
  const mask = frames.flatMap((frame, i) => {
    const paint = plan[i];
    const fields = frame.locator(FIELD_SELECTOR);
    return paint === "all" ? [fields] : [frame.locator(SECRET_BY_ATTRIBUTE), ...paint.map((n) => fields.nth(n))];
  });
  return { mask, frames };
}

/**
 * page.screenshot with every secret field painted MASK_COLOR. `readMs` bounds
 * reading each frame's fields; the picture keeps `options.timeout`. A frame
 * that went away between the read and the picture fails Playwright's paint, so
 * then the page is read again and the picture taken once more.
 */
export async function maskedScreenshot(page: Page, options: PageScreenshotOptions, readMs: number): Promise<Buffer> {
  const take = async (): Promise<{ png: Promise<Buffer>; frames: Frame[] }> => {
    const { mask, frames } = await secretFieldMasks(page, readMs);
    return { png: page.screenshot({ ...options, mask, maskColor: MASK_COLOR }), frames };
  };
  const first = await take();
  try {
    return await first.png;
  } catch (err) {
    if (page.isClosed() || !first.frames.some((f) => f.isDetached())) throw err;
    return (await take()).png;
  }
}
