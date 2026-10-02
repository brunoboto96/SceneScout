/**
 * Visual baselines for `scenescout check --baseline compare|update`, as data.
 *
 * A baseline is an approved picture of a page (its viewport, from the top) or
 * of one element on it, kept per route and per browser engine, beside a small
 * JSON saying how it was taken. `compare` takes the same picture again and
 * diffs it with the baseline (png.ts); `update` writes new baselines, and only
 * when it is asked to. What has a baseline is the project's choice, listed in
 * the baselines folder's targets.json; nothing is baselined by default.
 *
 * Everything here is pure: the targets file and its errors, the file layout,
 * what a baseline records, whether two pictures were taken alike, the verdict,
 * and the evidence an unmet baseline is filed with. The browser half is
 * BrowserEngine.captureForBaseline, which only takes the picture; check-run.ts
 * reads and writes the files. Table-tested in check-test.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { BrowserEngineName } from "../browsers.js";
import { CAPTURE_MARGIN } from "./capture.js";
import { ARIA_ROLES, fieldPath, issueMessage, parseJsonFile, parseTarget, TARGET_HELP, type FlowTarget } from "./flow.js";
import { MEMORY_DIRNAME, redactRoute } from "./memory.js";
import { decodePng, diffImages, type DiffResult, type RgbaImage } from "./png.js";

export const BASELINE_MODES = ["off", "compare", "update"] as const;
export type BaselineMode = (typeof BASELINE_MODES)[number];

/** The targets file, at the top of the baselines folder. */
export const TARGETS_FILE = "targets.json";
/** The most targets one check takes pictures of: each one is a page load. */
export const MAX_BASELINE_TARGETS = 100;
/** The share of pixels, in percent, that may change before a baseline counts as not met: none, by default. */
const DEFAULT_BASELINE_THRESHOLD = 0;
/** The element a target names when it names none: the page's viewport, from the top. */
const PAGE_ELEMENT = "page";
/** Where the pictures of an unmet baseline go, beside report.md. */
export const VISUAL_DIRNAME = "visual";

/** The baselines folder when --baselines names none: inside .scenescout/, which git ignores, so nothing is committed unless the project chooses a folder of its own. */
export function defaultBaselinesDir(projectDir: string): string {
  return path.join(projectDir, MEMORY_DIRNAME, "baselines");
}

/** How a picture was taken. Two pictures are compared only when every one of these is the same. */
export interface CaptureSettings {
  /** The browser window's size in CSS pixels. */
  viewport: { width: number; height: number };
  /** CSS pixels to device pixels. Pictures are taken at one picture pixel per CSS pixel whatever it is. */
  deviceScaleFactor: number;
  /** CSS pixels kept around an element (capture.ts). */
  margin: number;
  /** prefers-reduced-motion, as the page is told. */
  reducedMotion: string;
  /** CSS animations and transitions: finished, or stopped at their start when they repeat forever. */
  animations: string;
  /** The text cursor. */
  caret: string;
}

/** The settings the browser takes a picture by (BrowserEngine.captureForBaseline). The window and scale are set when the check attaches. */
export interface PictureSettings {
  margin: number;
  reducedMotion: "reduce" | "no-preference";
  animations: "disabled" | "allow";
  caret: "hide" | "initial";
}

/**
 * The settings every baseline is taken with, in one copy: the check attaches
 * with its window and scale, the browser takes the picture by the rest, and
 * the JSON records them all, the window and scale as the browser reports them.
 */
export const BASELINE_CAPTURE = {
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  margin: CAPTURE_MARGIN,
  reducedMotion: "reduce",
  animations: "disabled",
  caret: "hide",
} as const satisfies CaptureSettings & PictureSettings;

/**
 * Page-side source that stops every animation and transition before an
 * element is measured, not only while the screenshot is taken: a target that
 * itself moves would otherwise be cropped wherever it was mid-movement. Finite
 * ones are finished, infinite ones cancelled, as the screenshot's own setting
 * does. A string, like the collector, so no build step can wrap it in a
 * helper the page does not have.
 */
export const STOP_ANIMATIONS_SCRIPT = `(() => {
  for (const a of document.getAnimations()) {
    const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
    if (end === Infinity) a.cancel();
    else a.finish();
  }
  return true;
})()`;

// ---------------------------------------------------------------------------
// targets.json
// ---------------------------------------------------------------------------

/** One page or element to keep a baseline of. */
export interface BaselineTarget {
  /** A path on the app, starting with /. */
  path: string;
  /** `page`, or a target as a saved flow names one (testid=…, text=…, label=…, role=…). */
  element: string;
}

const ELEMENT_HELP = `${PAGE_ELEMENT} or ${TARGET_HELP}`;

/** What an element names: null for the page itself, else the target a saved flow would use. Undefined when it is neither. */
export function elementTarget(element: string): FlowTarget | null | undefined {
  if (element === PAGE_ELEMENT) return null;
  return parseTarget(element) ?? undefined;
}

const elementSchema = z.string().superRefine((e, ctx) => {
  const target = elementTarget(e);
  if (target === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be ${ELEMENT_HELP}` });
  else if (target?.by === "role" && !ARIA_ROLES.has(target.role)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `names the role "${target.role}", which is not an ARIA role (e.g. button, link, region, img)` });
  }
});

const targetsSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            path: z.string().regex(/^\/\S*$/, "must be a path on the app, starting with / and with no spaces"),
            element: elementSchema.optional(),
          })
          .strict(),
      )
      .min(1, "lists nothing to keep a baseline of")
      .max(MAX_BASELINE_TARGETS, `holds at most ${MAX_BASELINE_TARGETS} targets`),
  })
  .strict()
  .superRefine((file, ctx) => {
    // Two entries for one picture would write one file twice and compare it twice.
    const seen = new Map<string, number>();
    file.targets.forEach((t, i) => {
      const key = `${t.path}\u0000${t.element ?? PAGE_ELEMENT}`;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, i);
      else ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targets", i], message: `repeats targets[${first}]` });
    });
  });

/** Validate a targets file's text. Every mistake names the file and the field, as a flow's do. */
export function parseBaselineTargets(text: string, file: string): { ok: true; targets: BaselineTarget[] } | { ok: false; error: string } {
  const parsed = parseJsonFile(text, file, targetsSchema);
  if (!parsed.ok) return parsed;
  return { ok: true, targets: parsed.data.targets.map((t) => ({ path: t.path, element: t.element ?? PAGE_ELEMENT })) };
}

/** What to tell someone who asked for baselines in a folder with no targets file. */
export function missingTargetsMessage(file: string): string {
  return (
    `there is no ${file}: list the pages and elements to keep baselines of there, e.g. ` +
    `{"targets": [{"path": "/", "element": "page"}, {"path": "/settings", "element": "testid=profile-card"}]}`
  );
}

// ---------------------------------------------------------------------------
// Where the files are
// ---------------------------------------------------------------------------

/**
 * Text as a file name: lower-case letters, digits and dashes, then a hash of
 * the exact text, so two that read alike never share a file. The readable part
 * is taken from the text redacted as a route is, so a token in a target's path
 * never becomes part of a file name, the report or the JSON.
 */
function fileKey(text: string, fallback: string): string {
  const slug =
    redactRoute(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || fallback;
  return `${slug}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

/** The folder of one route's baselines: `/settings/profile` → `settings-profile-<hash>`, `/` → `index-<hash>`. */
export function routeFolder(routePath: string): string {
  return fileKey(routePath, "index");
}

/** The file name of one element's baseline, without its extension: `page`, or e.g. `testid-profile-card-<hash>`. */
export function elementFile(element: string): string {
  return element === PAGE_ELEMENT ? PAGE_ELEMENT : fileKey(element, "element");
}

/**
 * A target's baseline, relative to the baselines folder and with forward
 * slashes: one folder per engine (a picture from one browser is not another's
 * baseline), one per route, then the PNG and the JSON beside it.
 */
export function baselineFiles(engine: BrowserEngineName, target: BaselineTarget): { png: string; json: string } {
  const stem = `${engine}/${routeFolder(target.path)}/${elementFile(target.element)}`;
  return { png: `${stem}.png`, json: `${stem}.json` };
}

/** The pictures of an unmet baseline, relative to the check's output folder: what was expected, what it is now, and the changed pixels. */
export function visualFiles(target: BaselineTarget): { expected: string; actual: string; diff: string } {
  const stem = `${VISUAL_DIRNAME}/${routeFolder(target.path)}/${elementFile(target.element)}`;
  return { expected: `${stem}.expected.png`, actual: `${stem}.actual.png`, diff: `${stem}.diff.png` };
}

/**
 * Whether a file under the output folder's visual/ is one visualFiles names:
 * a route folder and a picture named exactly as a check names them. Only
 * these are cleared before a run writes its own, so nothing else that happens
 * to sit there is ever deleted.
 */
export function isVisualPicture(folder: string, file: string): boolean {
  return /^[a-z0-9-]+-[0-9a-f]{8}$/.test(folder) && /^(page|[a-z0-9-]+-[0-9a-f]{8})\.(expected|actual|diff)\.png$/.test(file);
}

// ---------------------------------------------------------------------------
// What a baseline records
// ---------------------------------------------------------------------------

/** The JSON beside a baseline's PNG. */
export interface BaselineMeta {
  path: string;
  element: string;
  engine: string;
  /** The operating system it was taken on: text is drawn differently on each. */
  platform: string;
  capture: CaptureSettings;
  /** The picture's size in pixels. */
  size: { width: number; height: number };
  capturedAt: string;
}

const size = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
const metaSchema = z.object({
  path: z.string(),
  element: z.string(),
  engine: z.string(),
  platform: z.string(),
  // Read as strings, not the values this version writes, so a baseline taken another way is reported as different, not as unreadable.
  capture: z.object({
    viewport: size,
    deviceScaleFactor: z.number().positive(),
    margin: z.number().int().min(0),
    reducedMotion: z.string(),
    animations: z.string(),
    caret: z.string(),
  }),
  size,
  capturedAt: z.string(),
});

export function baselineMeta(o: {
  target: BaselineTarget;
  engine: BrowserEngineName;
  platform: string;
  capture: CaptureSettings;
  size: { width: number; height: number };
  capturedAt: string;
}): BaselineMeta {
  return {
    path: o.target.path,
    element: o.target.element,
    engine: o.engine,
    platform: o.platform,
    capture: o.capture,
    size: o.size,
    capturedAt: o.capturedAt,
  };
}

/** Read a baseline's JSON. An error says why it cannot be used, for the report. */
export function parseBaselineMeta(text: string): { ok: true; meta: BaselineMeta } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `its JSON is not valid (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = metaSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `its JSON is not a baseline's: ${fieldPath(first.path)} ${issueMessage(first)}` };
  }
  return { ok: true, meta: parsed.data };
}

/** How each setting is named and shown. Typed by CaptureSettings, so a setting added there must be added here, and so compared. */
const SETTING_SHOWN: { [K in keyof CaptureSettings]: { label: string; value: (v: CaptureSettings[K]) => string } } = {
  viewport: { label: "viewport", value: (v) => `${v.width}×${v.height}` },
  deviceScaleFactor: { label: "device scale", value: (v) => String(v) },
  margin: { label: "margin", value: (v) => `${v}px` },
  reducedMotion: { label: "reducedMotion", value: (v) => v },
  animations: { label: "animations", value: (v) => v },
  caret: { label: "caret", value: (v) => v },
};

/** How two pictures' settings differ, one phrase each; empty when they were taken alike. */
export function captureDifferences(stored: CaptureSettings, now: CaptureSettings): string[] {
  return (Object.keys(SETTING_SHOWN) as Array<keyof CaptureSettings>).flatMap((k) => {
    const { label, value } = SETTING_SHOWN[k] as { label: string; value: (v: unknown) => string };
    const was = value(stored[k]);
    const is = value(now[k]);
    return was === is ? [] : [`${label} ${was} (now ${is})`];
  });
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * What became of one target. matches: none of its pixels changed past the
 * threshold (compare), or it was within the threshold and its baseline left
 * as it was (update). changed: more pixels changed than the threshold allows,
 * or the size changed. no-baseline: compare found none yet; never a failure.
 * unusable: compare found one it cannot use (half there, unreadable, another
 * target's, or taken with other settings), which fails the gate: a baseline
 * that compares nothing must not pass. not-captured: the page or element could
 * not be pictured. updated: update wrote a new baseline.
 */
export type BaselineStatus = "matches" | "changed" | "no-baseline" | "unusable" | "not-captured" | "updated";

export interface BaselineDiff {
  /** changed / total × 100, rounded as png.ts rounds it: never 0 when a pixel changed. */
  percent: number;
  changedPixels: number;
  totalPixels: number;
  sizeChanged: boolean;
  baseline: { width: number; height: number };
  now: { width: number; height: number };
}

export interface BaselineResult {
  path: string;
  element: string;
  status: BaselineStatus;
  /** Why it is not-captured or unusable, or what an update replaced. */
  detail?: string;
  /** The baseline was taken on another operating system, which draws text differently: a change may be the system's. */
  platformNote?: string;
  /** The element reaches outside the window, so only the part inside it is pictured (capture.ts). */
  partial?: string;
  /** The comparison, when one was made. */
  diff?: BaselineDiff;
  /** Its baseline's PNG, relative to the baselines folder. */
  baseline: string;
  /** The pictures of a changed one, relative to the output folder. */
  files?: { expected: string; actual: string; diff: string };
}

export interface BaselineRun {
  mode: Exclude<BaselineMode, "off">;
  engine: BrowserEngineName;
  /** The percentage of pixels that may change. */
  threshold: number;
  /** The baselines folder, relative to the project when it is inside it. */
  dir: string;
  results: BaselineResult[];
}

/** A stored baseline: usable, unusable with the reason, or absent (null). */
export type StoredBaseline = { meta: BaselineMeta; image: RgbaImage } | { problem: string } | null;

/**
 * Make sense of a target's two baseline files as found on disk (null for one
 * that is not there). Half a baseline, a JSON that describes another target or
 * browser, and a PNG that cannot be read or is not the size its JSON says are
 * each unusable, with the reason: never silently compared, never silently
 * treated as absent.
 */
export function readStoredBaseline(target: BaselineTarget, engine: BrowserEngineName, png: Uint8Array | null, json: string | null): StoredBaseline {
  if (png === null && json === null) return null;
  if (png === null) return { problem: "its PNG is missing; only the JSON beside it is there" };
  if (json === null) return { problem: "the JSON beside its PNG is missing" };
  const parsed = parseBaselineMeta(json);
  if (!parsed.ok) return { problem: parsed.error };
  const m = parsed.meta;
  if (m.path !== target.path || m.element !== target.element || m.engine !== engine) {
    return { problem: `its JSON describes ${m.element} on ${m.path} in ${m.engine}, not this target` };
  }
  let image: RgbaImage;
  try {
    image = decodePng(png);
  } catch (err) {
    return { problem: `its PNG cannot be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (image.width !== m.size.width || image.height !== m.size.height) {
    return { problem: `its PNG is ${image.width}×${image.height} where its JSON says ${m.size.width}×${m.size.height}` };
  }
  return { meta: m, image };
}

/**
 * Far below the smallest step a share of pixels can take (100 / MAX_PIXELS),
 * so a share exactly at the threshold is never read as past it because of
 * floating point: 7 of 100 is 7.000000000000001%.
 */
const SHARE_EPSILON = 1e-9;

/** Whether a comparison is a change: any change of size, or more of the pixels than the threshold allows. */
export function isChange(diff: Pick<DiffResult, "changed" | "total" | "sizeChanged">, threshold: number): boolean {
  if (diff.sizeChanged) return true;
  return diff.total > 0 && (diff.changed / diff.total) * 100 > threshold + SHARE_EPSILON;
}

function diffSummary(d: DiffResult): BaselineDiff {
  return { percent: d.percent, changedPixels: d.changed, totalPixels: d.total, sizeChanged: d.sizeChanged, baseline: d.before, now: d.after };
}

/**
 * Decide what becomes of one captured target, given its stored baseline and
 * the picture just taken. A status of `updated` is the one that writes the new
 * picture as its baseline; `diffImage` comes with `changed`, for the pictures
 * kept beside the report. update rewrites what compare would not accept and
 * leaves alone a baseline compare would (none of its pixels changed, or no
 * more than the threshold allows), so an update that changes nothing changes
 * no file and noise under the threshold does not churn the folder.
 */
export function judgeBaseline(o: {
  mode: Exclude<BaselineMode, "off">;
  threshold: number;
  stored: StoredBaseline;
  now: { capture: CaptureSettings; platform: string; image: RgbaImage };
}): { status: BaselineStatus; detail?: string; platformNote?: string; diff?: BaselineDiff; diffImage?: RgbaImage } {
  const { mode, stored, now } = o;
  if (stored === null) return mode === "update" ? { status: "updated", detail: "it had no baseline" } : { status: "no-baseline" };
  const cannotUse = (why: string) =>
    mode === "update" ? { status: "updated" as const, detail: `replaced one that could not be used: ${why}` } : { status: "unusable" as const, detail: why };
  if ("problem" in stored) return cannotUse(stored.problem);
  const differs = captureDifferences(stored.meta.capture, now.capture);
  if (differs.length > 0) return cannotUse(`it was taken with other settings: ${differs.join(", ")}`);
  const { platform } = stored.meta;
  const note = platform !== now.platform ? { platformNote: `its baseline was taken on ${platform} and this check ran on ${now.platform}` } : {};
  const d = diffImages(stored.image, now.image);
  const diff = diffSummary(d);
  if (!isChange(d, o.threshold)) return { status: "matches", diff, ...note };
  if (mode === "update") return { status: "updated", detail: `it was ${d.percent}% different`, diff, ...note };
  return { status: "changed", diff, diffImage: d.image, ...note };
}

/** The issue rule an unmet baseline is filed under (check.ts). */
export const VISUAL_RULE = "visual-change";

/**
 * The evidence an unmet baseline is filed with, or null when the result is
 * not an issue. A change and an unusable baseline (compare), and a target that
 * could not be pictured at all (either mode), are issues: targets.json says
 * the project expects to see it, and a comparison that compared nothing must
 * not pass. No baseline yet is never one.
 */
export function baselineEvidence(r: BaselineResult, run: Pick<BaselineRun, "mode" | "threshold">): string | null {
  const what = `${r.element} on ${r.path}`;
  switch (r.status) {
    case "not-captured":
      return `${what} could not be captured: ${r.detail ?? "no reason given"}${run.mode === "update" ? ", so its baseline was not written" : ""}`;
    case "unusable":
      return `${what}: its baseline cannot be used (${r.detail ?? "no reason given"}); run the check with --baseline update to take it again`;
    case "changed":
      return `${what}: ${r.diff ? describeChange(r.diff, run.threshold) : "it no longer matches its baseline"}${r.files ? ` — diff: ${r.files.diff}` : ""}`;
    default:
      return null;
  }
}

/** A change in words. A change of size always counts, whatever the threshold, so it is named first. */
export function describeChange(d: BaselineDiff, threshold: number): string {
  if (d.sizeChanged) {
    return `its size changed from ${d.baseline.width}×${d.baseline.height} to ${d.now.width}×${d.now.height}, which always counts (${d.percent}% of its pixels differ)`;
  }
  // The count beside the rounded share, so 0.504% past a 0.5% threshold does not read as 0.5% (allowed: 0.5%).
  return `${d.percent}% of its pixels changed (${d.changedPixels} of ${d.totalPixels}; allowed: ${threshold}%)`;
}

/** The fingerprint of an unmet baseline: the same target in the same browser is the same alert, whatever its percentage this time. */
export function baselineFingerprint(engine: BrowserEngineName, r: Pick<BaselineResult, "path" | "element">): string {
  return createHash("sha256").update(`${VISUAL_RULE}\u0000${engine}\u0000${r.path}\u0000${r.element}`).digest("hex").slice(0, 32);
}

/** How many results there are of each status, for the report's summary line. */
export function countStatuses(results: readonly BaselineResult[]): Record<BaselineStatus, number> {
  const counts: Record<BaselineStatus, number> = { matches: 0, changed: 0, "no-baseline": 0, unusable: 0, "not-captured": 0, updated: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/** Parse --baseline-threshold: a percentage from 0 to 100. */
export function parseThreshold(raw: string | undefined): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: DEFAULT_BASELINE_THRESHOLD };
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) {
    return { ok: false, error: "--baseline-threshold must be a percentage from 0 to 100, e.g. 0.5" };
  }
  return { ok: true, value };
}
