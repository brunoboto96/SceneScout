/**
 * PNG in and out, and a pixel diff of two pictures, with nothing but
 * node:zlib. A `/scenescout qa compare` reply shows an element before and
 * after with the changed pixels highlighted; the pictures are browser
 * screenshots, so this reads what a browser writes (8 bits a channel, not
 * interlaced) and writes plain RGBA. Kept free of Playwright and of any
 * image package so it is table-tested on pictures built in the test, and so
 * the npm package gains no dependency for a feature few runs use.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** A picture as four bytes a pixel, red, green, blue, alpha, row after row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels a pixel has, by PNG colour type: grey, RGB, grey and alpha, RGBA. Palette images are not read. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
/** The largest picture read or diffed, in pixels. An element's capture is far smaller; this bounds the memory a bad file can ask for. */
export const MAX_PIXELS = 40_000_000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Whether these bytes start the way every PNG does. */
export function isPng(buf: Uint8Array): boolean {
  return buf.length >= SIGNATURE.length && SIGNATURE.every((b, i) => buf[i] === b);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reads a PNG into RGBA. Throws, saying why, on anything it does not read: a palette, 16-bit channels, interlacing, a bad checksum. */
export function decodePng(buf: Uint8Array): RgbaImage {
  if (!isPng(buf)) throw new Error("not a PNG");
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let ended = false;
  while (pos + 8 <= view.length) {
    const length = view.readUInt32BE(pos);
    const type = view.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + length > view.length) throw new Error(`the PNG is cut short in its ${type} chunk`);
    const body = view.subarray(pos + 8, pos + 8 + length);
    if (crc32(view.subarray(pos + 4, pos + 8 + length)) !== view.readUInt32BE(pos + 8 + length)) throw new Error(`the PNG's ${type} chunk fails its checksum`);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9];
      if (depth !== 8) throw new Error(`a PNG with ${depth}-bit channels is not read, only 8-bit`);
      if (!(colorType in CHANNELS)) throw new Error(`a PNG of colour type ${colorType} is not read (palette images are not)`);
      if (body[12] !== 0) throw new Error("an interlaced PNG is not read");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    pos += 12 + length;
  }
  if (!ended || colorType < 0) throw new Error("the PNG has no header or no end");
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(`a ${width}×${height} PNG is outside what is read`);
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  let raw: Buffer;
  try {
    // Bounded by what the header promises, so a small file cannot inflate into gigabytes.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1 });
  } catch (err) {
    throw new Error(`the PNG's pixel data does not inflate to the size its header gives (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw.length !== height * (stride + 1)) throw new Error("the PNG's pixel data is not the size its header gives");
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[out + x - channels] : 0;
      const up = y > 0 ? rows[out - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? rows[out - stride + x - channels] : 0;
      const v = raw[src + x];
      let r: number;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + left;
      else if (filter === 2) r = v + up;
      else if (filter === 3) r = v + ((left + up) >> 1);
      else if (filter === 4) r = v + paeth(left, up, upLeft);
      else throw new Error(`the PNG uses row filter ${filter}, which does not exist`);
      rows[out + x] = r & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const grey = channels <= 2;
    data[i * 4] = rows[j];
    data[i * 4 + 1] = grey ? rows[j] : rows[j + 1];
    data[i * 4 + 2] = grey ? rows[j] : rows[j + 2];
    data[i * 4 + 3] = channels === 2 ? rows[j + 1] : channels === 4 ? rows[j + 3] : 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Writes RGBA as a PNG: 8-bit colour with alpha, no filtering, deflated. */
export function encodePng(img: RgbaImage): Buffer {
  if (img.data.length !== img.width * img.height * 4) throw new Error("the pixel data is not width × height × 4 bytes");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/**
 * How far apart two channel values may be and the pixel still count as the
 * same, out of 255. Two screenshots of one unchanged element in one browser
 * match exactly; the allowance absorbs the odd colour rounded one step
 * differently, not a change anyone would see.
 */
export const DIFF_THRESHOLD = 8;

/** The colour a changed pixel is painted in the diff picture. */
export const DIFF_HIGHLIGHT = [255, 0, 80] as const;

export interface DiffResult {
  /** The diff picture's size: the larger of the two in each direction. */
  width: number;
  height: number;
  /** Pixels that differ, those inside only one of the two pictures included. */
  changed: number;
  total: number;
  /** changed / total × 100, to two decimals, and at least 0.01 when any pixel changed. */
  percent: number;
  /** The two pictures are not the same size; the diff lays them over each other from the top-left corner. */
  sizeChanged: boolean;
  before: { width: number; height: number };
  after: { width: number; height: number };
  /** The smallest rectangle holding every changed pixel, or null when none changed. */
  box: { x: number; y: number; width: number; height: number } | null;
  /** The after picture faded to grey, changed pixels painted DIFF_HIGHLIGHT. */
  image: RgbaImage;
}

/**
 * Compares two pictures pixel by pixel. Pictures of different sizes are laid
 * over each other from the top-left corner, which is where an element's
 * capture starts (its bounds plus a fixed margin), and every pixel only one of
 * them covers counts as changed: an element that grew has changed.
 */
export function diffImages(before: RgbaImage, after: RgbaImage, threshold = DIFF_THRESHOLD): DiffResult {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  if (width * height > MAX_PIXELS) throw new Error(`a ${width}×${height} diff is outside what is compared`);
  const data = new Uint8Array(width * height * 4);
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const at = (img: RgbaImage, x: number, y: number): number => (x < img.width && y < img.height ? (y * img.width + x) * 4 : -1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = at(before, x, y);
      const b = at(after, x, y);
      let differs = a < 0 || b < 0;
      if (!differs)
        for (let c = 0; c < 4; c++)
          if (Math.abs(before.data[a + c] - after.data[b + c]) > threshold) {
            differs = true;
            break;
          }
      const o = (y * width + x) * 4;
      if (differs) {
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        data[o] = DIFF_HIGHLIGHT[0];
        data[o + 1] = DIFF_HIGHLIGHT[1];
        data[o + 2] = DIFF_HIGHLIGHT[2];
        data[o + 3] = 255;
      } else {
        // Faded grey of the after picture, so the eye goes to the highlight and still sees where it is.
        const lum = 0.299 * after.data[b] + 0.587 * after.data[b + 1] + 0.114 * after.data[b + 2];
        const v = Math.round(255 - (255 - lum) * 0.3);
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
  }
  const total = width * height;
  return {
    width,
    height,
    changed,
    total,
    // Never rounded down to 0 when something changed: "0%" must mean nothing did.
    percent: changed === 0 ? 0 : Math.max(0.01, Math.round((changed / total) * 10_000) / 100),
    sizeChanged: before.width !== after.width || before.height !== after.height,
    before: { width: before.width, height: before.height },
    after: { width: after.width, height: after.height },
    box: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    image: { width, height, data },
  };
}

/**
 * Shrinks a picture to `width` × `height` by averaging the source pixels each
 * output pixel covers, so text and thin lines fade rather than vanish the way
 * picking one pixel in every few would make them. Never enlarges: a size
 * larger than the source in either direction is the source's in it.
 */
export function shrinkImage(img: RgbaImage, width: number, height: number): RgbaImage {
  const w = Math.max(1, Math.min(img.width, Math.floor(width)));
  const h = Math.max(1, Math.min(img.height, Math.floor(height)));
  if (w === img.width && h === img.height) return img;
  const data = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          a += img.data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
      data[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data };
}

/**
 * Writes a picture as a PNG as small as this encoder makes one: three
 * channels when every pixel is opaque (a screenshot always is), and each row
 * filtered by whichever of the five PNG filters leaves the smallest sum, the
 * usual heuristic. encodePng stays as it is, since the diff is written by it.
 */
export function encodePngCompact(img: RgbaImage): Buffer {
  if (img.data.length !== img.width * img.height * 4) throw new Error("the pixel data is not width × height × 4 bytes");
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4)
    if (img.data[i] !== 255) {
      opaque = false;
      break;
    }
  const channels = opaque ? 3 : 4;
  const stride = img.width * channels;
  const rows = new Uint8Array(img.height * stride);
  if (opaque) {
    for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
      rows[j] = img.data[i];
      rows[j + 1] = img.data[i + 1];
      rows[j + 2] = img.data[i + 2];
    }
  } else rows.set(img.data);
  const raw = Buffer.alloc(img.height * (stride + 1));
  const trial = new Uint8Array(stride);
  for (let y = 0; y < img.height; y++) {
    const row = y * stride;
    let best = Infinity;
    const out = y * (stride + 1);
    for (let filter = 0; filter <= 4; filter++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? rows[row + x - channels] : 0;
        const up = y > 0 ? rows[row - stride + x] : 0;
        const upLeft = y > 0 && x >= channels ? rows[row - stride + x - channels] : 0;
        const v = rows[row + x];
        const p = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const f = (v - p) & 0xff;
        trial[x] = f;
        sum += f < 128 ? f : 256 - f;
      }
      if (sum < best) {
        best = sum;
        raw[out] = filter;
        raw.set(trial, out + 1);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}

/** The most a picture is shrunk to fit its bytes: below this on its longer side it is no longer worth showing. */
export const FIT_MIN_SIDE = 120;

export interface FittedPicture {
  png: Buffer;
  width: number;
  height: number;
  /** Smaller than the picture taken, to fit the bounds. */
  shrunk: boolean;
}

/**
 * A picture within `maxSide` pixels on its longer side and `maxBytes` as a
 * PNG: shrunk to the side first, then, while the file is still too large,
 * shrunk again in proportion to how far over it is. Null when even
 * FIT_MIN_SIDE on its longer side is over the bytes: nothing worth looking at
 * fits, and the caller says so rather than keeping a smudge.
 */
export function fitPicture(img: RgbaImage, maxSide: number, maxBytes: number): FittedPicture | null {
  const longer = Math.max(img.width, img.height);
  let scale = Math.min(1, maxSide / longer);
  for (let attempt = 0; attempt < 8; attempt++) {
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const png = encodePngCompact(shrinkImage(img, width, height));
    if (png.length <= maxBytes) return { png, width, height, shrunk: width !== img.width || height !== img.height };
    if (Math.max(width, height) <= FIT_MIN_SIDE) return null;
    // Bytes go roughly with area, so the side goes with the square root; a little under, so one more pass usually fits.
    scale = Math.max(FIT_MIN_SIDE / longer, scale * Math.sqrt(maxBytes / png.length) * 0.9);
  }
  return null;
}
