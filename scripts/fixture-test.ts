/**
 * Unit tests for the synthetic upload fixtures.
 *
 * The point of a generated fixture is that it is VALID — an upload pipeline
 * that parses, previews or scans the file must get past the first byte. So the
 * assertions here are structural (a PDF whose xref offsets really point at
 * their objects; a PNG with its signature and IEND chunk), not "some bytes
 * came out". The accept-attribute logic is what decides whether the engine
 * hands the app a file it should take or one it should refuse, so both
 * directions are pinned.
 *
 *   npx tsx --test scripts/fixture-test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURE_KINDS, acceptMatches, fixtureKindFor, generatedUpload, isFixtureKind, mimeForName, syntheticFile } from "../src/engine/fixtures.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planUploadOptions, resolveDiskUpload } from "../src/engine/uploads.ts";
import { matchOption, normaliseDateValue, type SelectOption } from "../src/engine/forms.ts";

test("generatedUpload says honestly where the kind came from", () => {
  assert.match(generatedUpload(".pdf").source, /generated pdf fixture \(inferred from accept\)/);
  assert.match(generatedUpload(null).source, /no accept attribute; pdf is the default/);
  assert.match(generatedUpload(undefined).source, /accept unknown; pdf is the default/, "an input we could not inspect is not 'no accept'");
  assert.match(generatedUpload(".docx").source, /accept lists no type we can generate; pdf is the fallback/, "a fallback must not claim to be inferred");
  assert.doesNotMatch(generatedUpload(".docx", "txt").source, /inferred|fallback|default/, "an explicit kind makes no inference claim");
  assert.equal(generatedUpload(".docx", "txt", "a.txt").file.name, "a.txt");
});

test("every fixture kind yields a non-empty file named for its kind, with its mime", () => {
  for (const kind of FIXTURE_KINDS) {
    const f = syntheticFile(kind);
    assert.ok(f.buffer.length > 0, `${kind} is empty`);
    assert.equal(f.name, `scenescout-fixture.${kind}`);
    assert.ok(f.mimeType.includes("/"), `${kind} mime "${f.mimeType}"`);
  }
});

test("the PDF is structurally valid: header, xref offsets that land on their objects, stream length, trailer", () => {
  const pdf = syntheticFile("pdf").buffer.toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4\n"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  const startxref = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref", "startxref must point at the xref table");
  const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) \d{5} n \n/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 5, "five in-use objects");
  entries.forEach((offset, i) => {
    assert.ok(pdf.slice(offset).startsWith(`${i + 1} 0 obj\n`), `xref entry ${i + 1} points at ${JSON.stringify(pdf.slice(offset, offset + 12))}`);
  });
  const stream = /\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf);
  assert.ok(stream, "content stream present");
  assert.equal(Buffer.byteLength(stream[2], "latin1"), Number(stream[1]), "/Length matches the stream bytes");
});

test("the PNG carries the PNG signature and ends with an IEND chunk", () => {
  const png = syntheticFile("png").buffer;
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(-8, -4).toString("latin1"), "IEND");
});

test("accept inference follows the input's declaration, first listed type first", () => {
  assert.equal(fixtureKindFor(".pdf,.docx"), "pdf");
  assert.equal(fixtureKindFor("application/pdf"), "pdf");
  assert.equal(fixtureKindFor("image/*"), "png");
  assert.equal(fixtureKindFor("image/png,image/jpeg"), "png");
  assert.equal(fixtureKindFor(".jpg,.png"), "png");
  assert.equal(fixtureKindFor(".csv,text/csv"), "csv");
  assert.equal(fixtureKindFor(".xlsx"), "csv");
  assert.equal(fixtureKindFor("application/json"), "json");
  assert.equal(fixtureKindFor("text/plain"), "txt");
  assert.equal(fixtureKindFor(".txt, .pdf"), "txt", "the app's first-listed type is its primary");
  assert.equal(fixtureKindFor(null), "pdf", "no accept → the most widely whitelisted document type");
  assert.equal(fixtureKindFor(""), "pdf");
  assert.equal(fixtureKindFor(".xyz"), "pdf", "an unfabricable type falls back rather than failing");
});

test("accept matching mirrors the browser picker: extension, wildcard mime, exact mime — and null when nothing to match", () => {
  assert.equal(acceptMatches(".pdf,application/pdf", "a.pdf", "application/pdf"), true);
  assert.equal(acceptMatches(".pdf,application/pdf", "notes.txt", "text/plain"), false);
  assert.equal(acceptMatches("image/*", "x.png", "image/png"), true);
  assert.equal(acceptMatches("image/*", "x.pdf", "application/pdf"), false);
  assert.equal(acceptMatches("image/jpeg", "x.png", "image/png"), false, "png does not satisfy a jpeg-only input");
  assert.equal(acceptMatches(".PDF", "A.pdf", "application/pdf"), true, "case-insensitive");
  assert.equal(acceptMatches(null, "anything.bin", "application/octet-stream"), null);
  assert.equal(acceptMatches("", "anything.bin", "application/octet-stream"), null);
});

test("a custom name is used verbatim — that is how upload names get fuzzed", () => {
  const long = `${"x".repeat(255)}.pdf`;
  assert.equal(syntheticFile("pdf", long).name, long);
  assert.equal(syntheticFile("txt", "résumé ✓.txt").name, "résumé ✓.txt");
  assert.equal(syntheticFile("txt", "report.exe").name, "report.exe", "a wrong extension is the caller's to choose");
});

test("isFixtureKind admits only the kinds we can generate", () => {
  assert.equal(isFixtureKind("pdf"), true);
  assert.equal(isFixtureKind("docx"), false);
  assert.equal(isFixtureKind(""), false);
  assert.equal(isFixtureKind(undefined), false);
});

test("mime by extension covers what fixtures produce and the common office/image types, with a safe default", () => {
  assert.equal(mimeForName("a.pdf"), "application/pdf");
  assert.equal(mimeForName("a.PNG"), "image/png");
  assert.equal(mimeForName("a.jpeg"), "image/jpeg");
  assert.equal(mimeForName("a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeForName("noext"), "application/octet-stream");
});

// ---------------------------------------------------------------------------
// Disk uploads: the fence. `filePath` makes the engine read a file and hand
// its bytes to the app under test, so an unfenced path is an exfiltration tool.
// ---------------------------------------------------------------------------

function project(): { projectDir: string; outside: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ft-upload-")));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "fixtures", "note.txt"), "inside");
  const outside = path.join(root, "secret.txt");
  fs.writeFileSync(outside, "outside the project");
  return { projectDir, outside };
}

test("a file inside the project is uploaded from disk, by relative or absolute path", () => {
  const { projectDir } = project();
  const rel = resolveDiskUpload({ projectDir }, "fixtures/note.txt");
  assert.ok(!("refused" in rel), JSON.stringify(rel));
  assert.equal(rel.payload, path.join(projectDir, "fixtures", "note.txt"), "streamed from disk, not read into memory");
  assert.equal(rel.name, "note.txt");
  assert.equal(rel.bytes, 6);
  const abs = resolveDiskUpload({ projectDir }, path.join(projectDir, "fixtures", "note.txt"));
  assert.ok(!("refused" in abs));
});

test("a path that leaves the project is refused — by .., by absolute path, and through a symlink", () => {
  const { projectDir, outside } = project();
  for (const attempt of ["../secret.txt", "fixtures/../../secret.txt", outside]) {
    const r = resolveDiskUpload({ projectDir }, attempt);
    assert.ok("refused" in r && /outside the attached project/.test(r.refused), `${attempt} → ${JSON.stringify(r)}`);
  }
  // The one a string check cannot catch: a link INSIDE the project whose
  // target is outside it. Only comparing real paths stops this.
  fs.symlinkSync(outside, path.join(projectDir, "fixtures", "innocent.txt"));
  const viaLink = resolveDiskUpload({ projectDir }, "fixtures/innocent.txt");
  assert.ok("refused" in viaLink && /outside the attached project/.test(viaLink.refused), JSON.stringify(viaLink));
  // A sibling directory that merely shares the project's name as a prefix is outside too.
  fs.mkdirSync(`${projectDir}-backup`);
  fs.writeFileSync(path.join(`${projectDir}-backup`, "x.txt"), "x");
  const sibling = resolveDiskUpload({ projectDir }, `../${path.basename(projectDir)}-backup/x.txt`);
  assert.ok(
    "refused" in sibling && /outside the attached project/.test(sibling.refused),
    "a name-prefix sibling is refused BY THE FENCE, not merely reported missing",
  );
});

test("a missing file, a directory, and an unattached session each say what is wrong", () => {
  const { projectDir } = project();
  assert.match((resolveDiskUpload({ projectDir }, "fixtures/nope.pdf") as { refused: string }).refused, /not found \(or not a file\)/);
  assert.match((resolveDiskUpload({ projectDir }, "fixtures") as { refused: string }).refused, /not found \(or not a file\)/);
  assert.match((resolveDiskUpload({ projectDir: "" }, "fixtures/note.txt") as { refused: string }).refused, /Not attached/);
});

test("a renamed upload travels in memory under the new name and its mime type", () => {
  const { projectDir } = project();
  const r = resolveDiskUpload({ projectDir }, "fixtures/note.txt", "report.pdf");
  assert.ok(!("refused" in r));
  assert.equal(r.name, "report.pdf");
  assert.equal(r.mime, "application/pdf");
  assert.ok(typeof r.payload !== "string" && r.payload.buffer.toString() === "inside");
});

test("a plan's upload value is a fixture kind, a path, or nothing", () => {
  assert.deepEqual(planUploadOptions(undefined), {});
  assert.deepEqual(planUploadOptions("  "), {});
  assert.deepEqual(planUploadOptions("PDF"), { fixture: "pdf" });
  assert.deepEqual(planUploadOptions("fixtures/scan.pdf"), { filePath: "fixtures/scan.pdf" });
});

const severity: SelectOption[] = [
  { value: "", label: "Choose…", disabled: false },
  { value: "low", label: "Low — minor impact", disabled: false },
  { value: "medium", label: "Medium — some impact", disabled: false },
  { value: "high", label: "High", disabled: false },
  { value: "retired", label: "Retired", disabled: true },
];

test("a select value is matched to one option before the pick: value, label, then either ignoring case, then a label it starts with", () => {
  const picked = (v: string) => {
    const m = matchOption(severity, v);
    return "refused" in m ? `refused: ${m.refused}` : m.index;
  };
  assert.equal(picked("low"), 1, "exact value");
  assert.equal(picked("Low — minor impact"), 1, "exact label");
  assert.equal(picked("HIGH"), 3, "value or label ignoring case");
  assert.equal(picked("  high "), 3, "...and surrounding space");
  assert.equal(picked("Low"), 1, "a label it starts with");
  assert.equal(picked("medium — SOME"), 2);
  assert.equal(picked(""), 0, "the empty placeholder by its value");
  // An exact value beats a label that merely starts with it.
  const shadow: SelectOption[] = [
    { value: "a", label: "Alpha", disabled: false },
    { value: "Al", label: "Other", disabled: false },
  ];
  assert.equal((matchOption(shadow, "Al") as { index: number }).index, 1);
});

test("a select value matching no option, several, or only a disabled one is refused with the options listed", () => {
  const none = matchOption(severity, "Critical");
  assert.ok("refused" in none);
  assert.equal(
    none.refused,
    'no option matches "Critical"; options: "" ("Choose…"), low ("Low — minor impact"), medium ("Medium — some impact"), high ("High"), retired ("Retired") [disabled].',
  );
  const two = matchOption(
    [
      { value: "1", label: "Pat Lee", disabled: false },
      { value: "2", label: "Pat Long", disabled: false },
    ],
    "Pat",
  );
  assert.ok("refused" in two && /^"Pat" matches more than one option: 1 \("Pat Lee"\), 2 \("Pat Long"\)/.test(two.refused), JSON.stringify(two));
  const off = matchOption(severity, "retired");
  assert.ok("refused" in off && /disabled/.test(off.refused), JSON.stringify(off));
  const many = matchOption(
    Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `Label ${i}`, disabled: false })),
    "zzz",
  );
  assert.ok("refused" in many && many.refused.endsWith(", … +5 more."), JSON.stringify(many));
  // A long label is matched whole, and shortened only where a refusal lists it.
  const longLabel = `Escalate to ${"the regional review board ".repeat(4)}`.trim();
  const long: SelectOption[] = [{ value: "esc", label: longLabel, disabled: false }];
  assert.equal((matchOption(long, longLabel) as { index: number }).index, 0);
  const listed = matchOption(long, "nope");
  assert.ok("refused" in listed && listed.refused.includes('esc ("Escalate to the regional') && listed.refused.includes('…")'), JSON.stringify(listed));
});

test("a date or time value is put in the field's format, or refused naming that format", () => {
  const typed = (type: string, v: string) => {
    const r = normaliseDateValue(type, v);
    return "refused" in r ? "refused" : r.value;
  };
  // A plain date into a date-and-time field: the near miss that fails as "Malformed value".
  assert.equal(typed("datetime-local", "2026-09-20"), "2026-09-20T00:00");
  assert.equal(typed("datetime-local", "2026-09-20 10:00"), "2026-09-20T10:00");
  assert.equal(typed("datetime-local", "2026-09-20T10:00"), "2026-09-20T10:00");
  assert.equal(typed("datetime-local", "2026-9-2T7:05:09"), "2026-09-02T07:05:09");
  assert.equal(typed("date", "2026-09-20"), "2026-09-20");
  assert.equal(typed("date", "2026-09-20T10:00"), "2026-09-20");
  assert.equal(typed("month", "2026-09-20"), "2026-09");
  assert.equal(typed("month", "2026-9"), "2026-09");
  assert.equal(typed("week", "2026-w5"), "2026-W05");
  assert.equal(typed("week", "2026-09-20"), "2026-W38");
  assert.equal(typed("week", "2027-01-01"), "2026-W53", "an ISO week can belong to the year before");
  assert.equal(typed("time", "9:30"), "09:30");
  assert.equal(typed("time", "14:30:05.250"), "14:30:05.250");
  for (const [type, v] of [
    ["date", "20/09/2026"],
    ["date", "2026-02-30"],
    ["datetime-local", "tomorrow"],
    ["datetime-local", "2026-09-20T25:00"],
    ["time", "2pm"],
    ["month", "2026-13"],
    ["week", "2026-W60"],
  ]) {
    assert.equal(typed(type, v), "refused", `${type} ${v}`);
  }
  const refusal = normaliseDateValue("datetime-local", "20/09/2026");
  assert.ok("refused" in refusal && refusal.refused.includes("YYYY-MM-DDTHH:MM (e.g. 2026-09-20T10:00)"), JSON.stringify(refusal));
  // What was changed is said; a value already in form is not remarked on.
  assert.deepEqual(normaliseDateValue("datetime-local", "2026-09-20"), {
    value: "2026-09-20T00:00",
    note: "entered as 2026-09-20T00:00, the form a datetime-local field takes",
  });
  assert.deepEqual(normaliseDateValue("date", "2026-09-20"), { value: "2026-09-20" });
  // An empty value clears the field, and other types pass through.
  assert.deepEqual(normaliseDateValue("date", ""), { value: "" });
  assert.deepEqual(normaliseDateValue("text", "2026-09-20"), { value: "2026-09-20" });
  assert.deepEqual(normaliseDateValue("number", "12"), { value: "12" });
});
