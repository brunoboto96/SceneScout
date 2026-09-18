/**
 * Synthetic upload fixtures.
 *
 * An upload control is the one form field that cannot be exercised with text:
 * `fill()` refuses `<input type="file">`, so every upload flow used to sit in
 * the gap ledger forever as "filled but never submitted". Playwright can set a
 * file input from an in-memory payload, which means nothing has to exist on
 * disk — this module generates small files that are VALID for their type (a
 * real PDF structure, a real PNG), so the app's own parser / preview / scan
 * path runs against something it would accept from a user, not a renamed text
 * file it rejects on the first byte.
 *
 * Pure module: no browser, no filesystem — see scripts/fixture-test.ts.
 */

export const FIXTURE_KINDS = ["pdf", "png", "txt", "csv", "json"] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/** Shape Playwright accepts for an in-memory upload. */
export interface FixtureFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const MIME: Record<FixtureKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
};

/** Mime types for extensions a disk file may carry beyond the fixture kinds. */
const EXTRA_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function isFixtureKind(value: unknown): value is FixtureKind {
  return typeof value === "string" && (FIXTURE_KINDS as readonly string[]).includes(value);
}

/** Mime type for a filename by extension — needed when a disk file is uploaded under a custom name. */
export function mimeForName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (!ext) return "application/octet-stream";
  return (isFixtureKind(ext) ? MIME[ext] : EXTRA_MIME[ext]) ?? "application/octet-stream";
}

function tokens(accept: string | null | undefined): string[] {
  return (accept ?? "")
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Which fixture an input's `accept` attribute would admit. Tokens are read in
 * the order the app listed them — the first names the primary type — and the
 * first that maps to a kind we can generate wins (spreadsheet types get the
 * CSV, the nearest thing we can make). No `accept`, or only types we cannot
 * approximate at all (.docx, .zip), falls back to PDF, the most widely
 * whitelisted document type; `generatedUpload` says which of those happened.
 */
export function fixtureKindFor(accept: string | null | undefined): FixtureKind {
  for (const token of tokens(accept)) {
    if (token === ".pdf" || token === "application/pdf") return "pdf";
    if (token.startsWith("image/") || /^\.(png|jpe?g|gif|webp|bmp)$/.test(token)) return "png";
    if (token === ".csv" || token === "text/csv" || /excel|spreadsheet|^\.xlsx?$/.test(token)) return "csv";
    if (token === ".json" || token === "application/json") return "json";
    if (token === ".txt" || token === "text/plain" || token === "text/*") return "txt";
  }
  return "pdf";
}

/**
 * Does a file satisfy an `accept` attribute? `null` when there is no accept
 * (nothing to satisfy). Mirrors the browser's own picker filter: `.ext`
 * matches the filename's extension, `type/*` the mime's major type, `type/sub`
 * exactly. A file that fails this and is accepted anyway is a validation gap —
 * the caller says so.
 */
export function acceptMatches(accept: string | null | undefined, fileName: string, mimeType: string): boolean | null {
  const list = tokens(accept);
  if (list.length === 0) return null;
  const lowerName = fileName.toLowerCase();
  const mime = mimeType.toLowerCase();
  return list.some((token) => {
    if (token.startsWith(".")) return lowerName.endsWith(token);
    if (token.endsWith("/*")) return mime.startsWith(token.slice(0, -1));
    return mime === token;
  });
}

/** Build a small, valid file of the given kind — in memory, nothing on disk. */
export function syntheticFile(kind: FixtureKind, name?: string): FixtureFile {
  return { name: name ?? `scenescout-fixture.${kind}`, mimeType: MIME[kind], buffer: BUILDERS[kind]() };
}

/**
 * The fixture an upload should send, with an honest account of how its kind
 * was chosen. `accept` is the input's attribute (`null` = the input has none;
 * `undefined` = the input could not be inspected), `fixture` an explicit
 * kind, `name` a filename override. The wording matters: "inferred from
 * accept" when the accept listed only types we cannot generate would tell the
 * driver the file matches when it does not.
 */
export function generatedUpload(accept: string | null | undefined, fixture?: FixtureKind, name?: string): { file: FixtureFile; source: string } {
  const kind = fixture ?? fixtureKindFor(accept);
  const file = syntheticFile(kind, name);
  let why = "";
  if (!fixture) {
    if (accept === undefined) why = " (accept unknown; pdf is the default)";
    else if (!accept) why = " (no accept attribute; pdf is the default)";
    else if (acceptMatches(accept, file.name, file.mimeType)) why = " (inferred from accept)";
    else why = " (accept lists no type we can generate; pdf is the fallback)";
  }
  return { file, source: `generated ${kind} fixture${why}` };
}

const BUILDERS: Record<FixtureKind, () => Buffer> = {
  txt: () => Buffer.from("SceneScout synthetic upload fixture.\nGenerated for exploratory testing; contains no real data.\n", "utf8"),
  csv: () => Buffer.from("id,name,status\n1,Alpha widget,active\n2,Beta widget,inactive\n3,Gamma widget,active\n", "utf8"),
  json: () => Buffer.from(`${JSON.stringify({ fixture: "scenescout", generated: true, items: [{ id: 1, name: "Alpha widget" }] }, null, 2)}\n`, "utf8"),
  // A tiny well-formed PNG: 1×1 RGBA, one half-transparent pixel, CRCs intact.
  png: () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
  pdf: minimalPdf,
};

/**
 * A one-page PDF with a line of text. The cross-reference table carries REAL
 * byte offsets, computed as the objects are laid down — most viewers tolerate
 * a wrong xref, but a strict parser (and a backend that validates uploads)
 * does not, and "valid" is the whole point of a fixture.
 */
function minimalPdf(): Buffer {
  const content = "BT /F1 24 Tf 72 720 Td (SceneScout synthetic upload fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  // Every xref entry is exactly 20 bytes: 10-digit offset, 5-digit generation, type, space, newline.
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
