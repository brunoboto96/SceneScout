/**
 * The end-of-check card (design 2.9): a one-screen recap of a guided check
 * the person can share, drawn as an SVG by the engine from the check's
 * figures only. No sentence a page supplied goes into it: the address is the
 * one the person typed, every figure is a number the engine counted, and each
 * is escaped before it is placed. Pure but for writeRecap, its save, so
 * report-test holds it to a golden file in scripts/golden/.
 */
import fs from "node:fs";
import path from "node:path";
import type { Finding } from "./memory.js";
import { MEMORY_DIRNAME } from "./memory-dir.js";
import { writeDocumentSync } from "./owner-file.js";
import type { GuidedProgress } from "./progress.js";
import { escapeHtml } from "./replay.js";

/** The figures a recap is drawn from. */
export interface RecapFigures {
  /** The address the person checked. */
  address: string;
  pagesChecked: number;
  problems: { blocksUsers: number; annoying: number; cosmetic: number; worthALook: number };
  /** Problems a re-check during this check found gone. */
  fixed: number;
  /** How long the check took. */
  durationMs: number;
  /** When it ended, as ISO 8601; the date is shown. */
  endedAt: string;
  /** "done" or "stopped". */
  ended: "done" | "stopped";
}

export const RECAP_WIDTH = 640;
export const RECAP_HEIGHT = 360;
/** The longest address drawn; a longer one is cut with an ellipsis. */
export const RECAP_ADDRESS_MAX = 60;
/** The file name a saved recap takes inside `.scenescout/`. */
export const RECAP_FILE = "recap.svg";

/** A count as drawn: a whole number from 0 up, anything else 0. */
function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "4 min", "1 h 5 min", "under a minute". */
export function recapDuration(ms: number): string {
  const minutes = Math.floor(count(ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The address as drawn: one line, control characters out, cut at RECAP_ADDRESS_MAX. */
export function recapAddress(address: string): string {
  // Control and direction-changing characters, the two noncharacters an XML reader refuses, and any half of a pair: a space.
  const one = address
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufffe\uffff]+|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      " ",
    )
    .trim();
  // Cut by character, never inside a pair.
  const chars = Array.from(one);
  return chars.length > RECAP_ADDRESS_MAX ? `${chars.slice(0, RECAP_ADDRESS_MAX - 1).join("")}…` : one;
}

/**
 * The recap's lines, as the panel prints them where no picture is drawn and
 * as the SVG lays them out: the same words in both.
 */
export function recapLines(f: RecapFigures): { title: string; address: string; date: string; rows: Array<[string, string]> } {
  const p = f.problems;
  const total = count(p.blocksUsers) + count(p.annoying) + count(p.cosmetic);
  const date = /^\d{4}-\d{2}-\d{2}/.test(f.endedAt) ? f.endedAt.slice(0, 10) : "";
  return {
    title: f.ended === "stopped" ? "SceneScout check, stopped early" : "SceneScout check",
    address: recapAddress(f.address),
    date,
    rows: [
      ["Pages checked", String(count(f.pagesChecked))],
      ["Problems found", String(total)],
      ["Block users", String(count(p.blocksUsers))],
      ["Annoying", String(count(p.annoying))],
      ["Cosmetic", String(count(p.cosmetic))],
      ["Worth a look", String(count(p.worthALook))],
      ["Confirmed fixed", String(count(f.fixed))],
      ["Time taken", recapDuration(f.durationMs)],
    ],
  };
}

/** The recap as an SVG document, every text escaped. Deterministic: the same figures give the same bytes. */
export function recapSvg(f: RecapFigures): string {
  const l = recapLines(f);
  const t = (x: number, y: number, size: number, text: string, extra = ""): string =>
    `<text x="${x}" y="${y}" font-size="${size}"${extra}>${escapeHtml(text)}</text>`;
  const rows = l.rows.map(([label, value], i) => {
    const col = i < 4 ? 0 : 1;
    const y = 160 + (i % 4) * 40;
    const x = 40 + col * 300;
    return `${t(x, y, 15, label, ' fill="#4b5563"')}${t(x + 250, y, 20, value, ' font-weight="700" text-anchor="end"')}`;
  });
  return (
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${RECAP_WIDTH}" height="${RECAP_HEIGHT}" viewBox="0 0 ${RECAP_WIDTH} ${RECAP_HEIGHT}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="${escapeHtml(`${l.title}: ${l.address}`)}">`,
      `<rect width="${RECAP_WIDTH}" height="${RECAP_HEIGHT}" rx="16" fill="#ffffff" stroke="#d1d5db"/>`,
      `<rect width="${RECAP_WIDTH}" height="8" rx="4" fill="#2563eb"/>`,
      t(40, 56, 24, l.title, ' font-weight="700" fill="#111827"'),
      t(40, 88, 16, l.address, ' fill="#1f2937"'),
      l.date ? t(40, 114, 13, l.date, ' fill="#6b7280"') : "",
      ...rows,
      `</svg>`,
    ].join("\n") + "\n"
  );
}

/**
 * A guided check's recap figures, once it has ended (done or stopped); null
 * while it is still going. "Confirmed fixed" counts the findings a re-check
 * during this check found gone: verified between its start and its end, so a
 * re-check after it does not change its card. The card is dated by its end.
 */
export function recapFigures(
  progress: Pick<GuidedProgress, "phase" | "pages" | "problems" | "time">,
  address: string,
  findings: readonly Pick<Finding, "verdict" | "verifiedAt">[],
  startedMs: number,
  endedMs: number,
): RecapFigures | null {
  if (progress.phase !== "done" && progress.phase !== "stopped") return null;
  const fixed = findings.filter((f) => {
    const at = Date.parse(f.verifiedAt ?? "") || 0;
    return f.verdict === "gone" && at >= startedMs && at <= endedMs;
  }).length;
  return {
    address,
    pagesChecked: progress.pages.checked,
    problems: { ...progress.problems },
    fixed,
    durationMs: progress.time.usedMs,
    endedAt: new Date(endedMs).toISOString(),
    ended: progress.phase,
  };
}

/**
 * Write the recap to `dir`/recap.svg, where `dir` must be a project's
 * `.scenescout/` folder and a real folder, not a link to one. The file is
 * replaced, never written through: a link left at recap.svg is swapped for
 * the picture, so the bytes cannot land outside the folder. Returns the path.
 */
export function writeRecap(dir: string, svg: string): string {
  if (path.basename(dir) !== MEMORY_DIRNAME) throw new Error(`the recap is written only inside a project's ${MEMORY_DIRNAME} folder, not ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is a link or a file, not a folder SceneScout made, so the recap was not saved`);
  const file = path.join(dir, RECAP_FILE);
  writeDocumentSync(file, svg);
  return file;
}
