/**
 * Reading one file out of a downloaded artifact's zip without extracting it.
 * The `/scenescout qa check` reply reads check.json from an artifact the pull
 * request's code produced, so the archive is untrusted: nothing in it is
 * written to disk, entry names are only compared with fixed names, and the one
 * entry that is inflated is held to a byte cap before and while it is inflated
 * (a zip bomb ends at the cap). Only the central directory and that entry are
 * read. Plain zip only: an archive needing ZIP64 (over 4 GB, or over 65535
 * entries) is refused, as the size check before the download already refuses
 * anything that large. Table-tested by qa-test.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end-of-central-directory record is within the last 22 bytes plus a comment of at most 65535. */
const EOCD_SEARCH = 22 + 0xffff;

/** A reader over a file: its size, and `read(position, length)` returning a Buffer. */
export function fileReader(file) {
  const fd = fs.openSync(file, "r");
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(position, length) {
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd, buf, 0, length, position);
      return buf.subarray(0, got);
    },
    close: () => fs.closeSync(fd),
  };
}

/** A reader over a Buffer, for the tests. */
export function bufferReader(buf) {
  return { size: buf.length, read: (position, length) => buf.subarray(position, position + length), close: () => {} };
}

/**
 * The archive's entries from its central directory: name, compression method,
 * sizes and where the local header is. Throws on anything that is not a plain
 * zip it can read.
 */
export function zipEntries(reader) {
  const tailLength = Math.min(reader.size, EOCD_SEARCH);
  const tail = reader.read(reader.size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  if (at < 0) throw new Error("not a zip archive (no end of central directory)");
  const count = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("a ZIP64 archive, which is not read");
  if (cdOffset + cdSize > reader.size) throw new Error("the central directory lies outside the archive");
  const cd = reader.read(cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new Error("a malformed central directory");
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.subarray(p + 46, p + 46 + nameLength).toString("utf8"),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's bytes, at most `maxBytes` of them: an entry that says it is
 * larger, or inflates past the cap, throws with `tooLarge` set. Stored and
 * deflated entries only.
 */
export function readZipEntry(reader, entry, maxBytes) {
  const tooLarge = () => Object.assign(new Error(`${entry.name} is larger than ${maxBytes} bytes`), { tooLarge: true });
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) throw tooLarge();
  const header = reader.read(entry.offset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new Error(`${entry.name}: a malformed local header`);
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = reader.read(start, entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new Error(`${entry.name}: the archive ends inside it`);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} is not read`);
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (err) {
    if (err instanceof RangeError || err?.code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw err;
  }
}
