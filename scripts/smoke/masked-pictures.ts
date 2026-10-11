/**
 * A picture paints over what a secret field shows. The fixture's first two
 * fields differ only in their input type and both hold a value: in every kind
 * of picture the engine takes (scout_screenshot, scout_capture, a finding's
 * picture, a recorded frame, a baseline) the password field's pixels are the
 * mask colour and the text field's are not. A text field named only by
 * autocomplete=one-time-code is painted too. A second fixture holds fields no
 * attribute names: a text field secret only by its label, and a password field
 * inside an embedded frame, each beside an ordinary one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { BASELINE_CAPTURE } from "../../dist/engine/baseline.js";
import { decodePng, type RgbaImage } from "../../dist/engine/png.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "masked pictures";

type Rgb = [number, number, number];
type Box = { x: number; y: number; width: number; height: number };

/** The mask colour, #FF00FF, with room for JPEG's rounding. */
const isPaint = ([r, g, b]: Rgb): boolean => r > 200 && g < 70 && b > 200;
const centre = (box: Box): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function pngPixel(img: RgbaImage, x: number, y: number): Rgb {
  const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** A JPEG's pixel, read by the browser itself (png.ts reads PNGs only). Nothing is added to the page's document. */
async function jpegPixel(page: Page, jpeg: Buffer, x: number, y: number): Promise<{ rgb: Rgb; width: number }> {
  return page.evaluate(
    async ({ src, x, y }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const scale = img.naturalWidth / window.innerWidth;
      const d = ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
      return { rgb: [d[0], d[1], d[2]] as Rgb, width: img.naturalWidth };
    },
    { src: `data:image/jpeg;base64,${jpeg.toString("base64")}`, x, y },
  );
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("masked pictures: a secret field is painted over in every picture, an ordinary field is not");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-masked-pictures-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "pictures";
  try {
    await engine.attach({ url: `${baseUrl}/secret-fields.html`, projectDir, mode: "read-only", record: true });
    const page = (engine as unknown as { page: Page }).page;
    const boxOf = async (testid: string): Promise<Box> => {
      const box = await page.getByTestId(testid).boundingBox();
      if (!box) throw new Error(`${testid} has no box`);
      return box;
    };
    const secret = centre(await boxOf("phrase-hidden"));
    const ordinary = centre(await boxOf("phrase-shown"));
    const code = centre(await boxOf("app-code"));

    const viewport = decodePng((await engine.captureEvidence(undefined, 0)).png);
    check(
      "a finding's picture of the viewport: the password field is painted",
      isPaint(pngPixel(viewport, secret.x, secret.y)),
      `centre pixel ${pngPixel(viewport, secret.x, secret.y)}`,
    );
    check(
      "...and the text field beside it, holding a value too, is not",
      !isPaint(pngPixel(viewport, ordinary.x, ordinary.y)),
      `centre pixel ${pngPixel(viewport, ordinary.x, ordinary.y)}`,
    );
    check(
      "...and a text field named only as a one-time code is painted",
      isPaint(pngPixel(viewport, code.x, code.y)),
      `centre pixel ${pngPixel(viewport, code.x, code.y)}`,
    );

    const snap = await engine.snapshot(true);
    const refOf = (pattern: RegExp): string => {
      const m = snap.match(pattern);
      if (!m) throw new Error(`ref not found for ${pattern} in:\n${snap.slice(0, 1500)}`);
      return m[1];
    };
    const secretShot = decodePng((await engine.captureElement({ ref: refOf(/(e\d+) textbox "Account phrase"(?! \(shown\))/) }, 0)).png);
    const ordinaryShot = decodePng((await engine.captureElement({ ref: refOf(/(e\d+) textbox "Account phrase \(shown\)"/) }, 0)).png);
    check(
      "scout_capture of the password field: its middle is painted",
      isPaint(pngPixel(secretShot, secretShot.width / 2, secretShot.height / 2)),
      `${pngPixel(secretShot, secretShot.width / 2, secretShot.height / 2)}`,
    );
    check(
      "...and of the text field, it is not",
      !isPaint(pngPixel(ordinaryShot, ordinaryShot.width / 2, ordinaryShot.height / 2)),
      `${pngPixel(ordinaryShot, ordinaryShot.width / 2, ordinaryShot.height / 2)}`,
    );

    // A show-password toggle: the field becomes text, and its autocomplete token still says it is a password.
    await page.getByTestId("phrase-hidden").evaluate((el) => {
      el.setAttribute("autocomplete", "current-password");
      (el as HTMLInputElement).type = "text";
    });
    const toggled = decodePng((await engine.captureEvidence(undefined, 0)).png);
    check(
      "after a show-password toggle, the field shown as text is still painted",
      isPaint(pngPixel(toggled, secret.x, secret.y)) && !isPaint(pngPixel(toggled, ordinary.x, ordinary.y)),
      `${pngPixel(toggled, secret.x, secret.y)} / ${pngPixel(toggled, ordinary.x, ordinary.y)}`,
    );

    const jpeg = Buffer.from((await engine.screenshot()).base64, "base64");
    const shotSecret = await jpegPixel(page, jpeg, secret.x, secret.y);
    const shotOrdinary = await jpegPixel(page, jpeg, ordinary.x, ordinary.y);
    check(
      "scout_screenshot: the password field is painted, the text field is not",
      isPaint(shotSecret.rgb) && !isPaint(shotOrdinary.rgb),
      `${shotSecret.rgb} / ${shotOrdinary.rgb}`,
    );

    await engine.scroll("top");
    const recordings = path.join(projectDir, ".scenescout", "recordings");
    const frames: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".jpg")) frames.push(full);
      }
    };
    walk(recordings);
    const frame = frames.sort().at(-1);
    check("a recorded run kept a frame of the step", !!frame, `frames: ${frames.length}`);
    if (frame) {
      const bytes = fs.readFileSync(frame);
      const frameSecret = await jpegPixel(page, bytes, secret.x, secret.y);
      const frameOrdinary = await jpegPixel(page, bytes, ordinary.x, ordinary.y);
      check(
        "...in which the password field is painted and the text field is not",
        isPaint(frameSecret.rgb) && !isPaint(frameOrdinary.rgb),
        `${frameSecret.rgb} / ${frameOrdinary.rgb}`,
      );
    }

    const baseline = await engine.captureForBaseline("", null, BASELINE_CAPTURE);
    const again = await engine.captureForBaseline("", null, BASELINE_CAPTURE);
    const base = decodePng(baseline.png);
    const baseSecret = centre(await boxOf("phrase-hidden"));
    const baseOrdinary = centre(await boxOf("phrase-shown"));
    check(
      "a baseline: the password field is painted, the text field is not",
      isPaint(pngPixel(base, baseSecret.x, baseSecret.y)) && !isPaint(pngPixel(base, baseOrdinary.x, baseOrdinary.y)),
      `${pngPixel(base, baseSecret.x, baseSecret.y)} / ${pngPixel(base, baseOrdinary.x, baseOrdinary.y)}`,
    );
    check("...and two baselines of the page are the same picture, so one still compares with the next", baseline.png.equals(again.png));
    await engine.endBaselineCaptures();

    // Fields no attribute names, painted by their place: one secret only by its label, and a password field inside an
    // embedded frame, each beside an ordinary field alike in all but the fact that makes it secret.
    await engine.navigate(`${baseUrl}/secret-fields-framed.html`);
    const signIn = page.frameLocator('[data-testid="sign-in-frame"]');
    const centreOf = async (locator: ReturnType<Page["getByTestId"]>): Promise<{ x: number; y: number }> => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("no box");
      return centre(box);
    };
    const framed = decodePng((await engine.captureEvidence(undefined, 0)).png);
    const at = async (locator: ReturnType<Page["getByTestId"]>): Promise<boolean> => {
      const { x, y } = await centreOf(locator);
      return isPaint(pngPixel(framed, x, y));
    };
    check("a text field secret only by its label is painted", await at(page.getByTestId("shown-secret")));
    check("...and the text field beside it, labelled otherwise, is not", !(await at(page.getByTestId("nickname"))));
    check("a password field inside an embedded frame is painted", await at(signIn.getByTestId("frame-secret")));
    check("...and the ordinary field beside it in the frame is not", !(await at(signIn.getByTestId("frame-plain"))));
  } finally {
    await engine.close();
  }
  fs.rmSync(projectDir, { recursive: true, force: true });
}
