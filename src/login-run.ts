/**
 * Runs `scenescout login <url> --role <name>`: opens a visible browser at the
 * URL, lets the person sign in however the app asks (SSO, MFA, a password
 * manager), and when they press Enter in the terminal saves the browser's
 * storage state as that role's profile.
 *
 * Enter is the one way to save. Closing the window, Ctrl+C, or the terminal's
 * input ending saves nothing: by the time a window is closed its state can no
 * longer be read, and a profile saved by accident half-way through a sign-in
 * would be attached later as if it worked.
 *
 * The rules (role names, where the file goes, its mode, what may be printed)
 * are in engine/profiles.ts; this file only drives the browser and the terminal.
 */
import readline from "node:readline";
import { chromium, firefox, webkit, type BrowserContext, type BrowserType } from "playwright";
import { defaultEngine, type BrowserEngineName } from "./browsers.js";
import { explainLaunchFailure } from "./engine/launch.js";
import { describeSaved, mergeSessionStorage, withSessionStorage, writeProfile, type LoginOptions, type ProfileSummary } from "./engine/profiles.js";

/**
 * Read what the profile keeps from a signed-in context: cookies, localStorage
 * and IndexedDB through Playwright's storage state, and sessionStorage, which
 * the storage state has no field for, read from every frame of every open
 * tab. One place on purpose: attach restores exactly what this captures (see
 * splitProfile and sessionStorageInitScript in engine/profiles.ts).
 */
export async function captureState(context: BrowserContext): Promise<unknown> {
  const state = await context.storageState({ indexedDB: true });
  const frames: { origin: unknown; entries: unknown }[] = [];
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      try {
        frames.push(
          await frame.evaluate(() => {
            // A sandboxed or opaque-origin frame throws on access; it has nothing to keep.
            try {
              const entries: [string, string][] = [];
              for (let i = 0; i < sessionStorage.length; i++) {
                const name = sessionStorage.key(i);
                if (name !== null) entries.push([name, sessionStorage.getItem(name) ?? ""]);
              }
              return { origin: location.origin, entries };
            } catch {
              return { origin: location.origin, entries: [] };
            }
          }),
        );
      } catch (err) {
        // A child frame that went away between listing and reading has nothing
        // left to keep; the tab's own document failing to answer is a real error.
        if (frame === page.mainFrame()) throw err;
      }
    }
  }
  return withSessionStorage(state, mergeSessionStorage(frames));
}

/** How the person signalled they were done: Enter saves; everything else does not. */
export type LoginEnd = "enter" | "window-closed" | "input-ended" | "interrupted";

/** How long after the prompt input still counts as typed before it. */
const EARLY_INPUT_MS = 300;

/** Wait for Enter on the terminal, the window closing, the input ending or Ctrl+C, whichever comes first. */
function waitForEnd(browserClosed: Promise<void>): { done: Promise<LoginEnd>; dispose: () => void } {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // Lines typed before the prompt (while the browser launched or the page
  // loaded) arrive at once, buffered; they are not an answer to it.
  const listening = Date.now() + EARLY_INPUT_MS;
  let onSigint: (() => void) | undefined;
  const done = new Promise<LoginEnd>((resolve) => {
    rl.on("line", () => {
      if (Date.now() >= listening) resolve("enter");
    });
    rl.once("close", () => resolve("input-ended"));
    onSigint = () => resolve("interrupted");
    process.once("SIGINT", onSigint);
    void browserClosed.then(() => resolve("window-closed"));
  });
  return {
    done,
    dispose: () => {
      if (onSigint) process.removeListener("SIGINT", onSigint);
      rl.removeAllListeners();
      rl.close();
    },
  };
}

const NOT_SAVED: Record<Exclude<LoginEnd, "enter">, string> = {
  "window-closed": "The browser was closed before Enter was pressed, so nothing was saved. Run the command again and press Enter here once you are signed in.",
  "input-ended": "The terminal's input ended before Enter was pressed, so nothing was saved. Run this command in an interactive terminal.",
  interrupted: "Interrupted, so nothing was saved.",
};

export async function runLogin(options: LoginOptions, log: (line: string) => void): Promise<{ path: string; summary: ProfileSummary }> {
  const engine: BrowserEngineName = options.browser ?? defaultEngine(process.env);
  const types: Record<BrowserEngineName, BrowserType> = { chromium, firefox, webkit };
  let browser;
  try {
    browser = await types[engine].launch({ headless: false });
  } catch (err) {
    throw new Error(explainLaunchFailure(err instanceof Error ? err.message : String(err), 0, { engine, headed: true }));
  }
  const browserClosed = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
  let end: ReturnType<typeof waitForEnd> | undefined;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Closing the only tab is how most people close the window; treat it the
    // same. The browser may already be closing, and either way it ends up closed.
    page.once("close", () => void browser.close().catch(() => {}));
    try {
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      throw new Error(`could not open ${options.url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    log(`A ${engine} window is open at ${options.url}.`);
    log(`Sign in as "${options.role}" there — SSO, MFA, whatever the app asks — then come back here and press Enter to save.`);
    log(`(Closing the window or pressing Ctrl+C saves nothing.)`);
    // Listening starts only now, after the prompt: an Enter pressed while the
    // page was still loading must not save a signed-out profile.
    end = waitForEnd(browserClosed);
    const how = await end.done;
    if (how !== "enter") throw new Error(NOT_SAVED[how]);
    const state = await captureState(context);
    return writeProfile(options.projectDir, options.role, state);
  } finally {
    end?.dispose();
    // Closing a browser the person already closed fails; nothing is left to clean up then.
    await browser.close().catch(() => {});
  }
}

/** The line printed on success. Never the profile's contents. */
export function savedLine(options: LoginOptions, saved: { path: string; summary: ProfileSummary }): string {
  return (
    `${describeSaved(saved.path, saved.summary)}\n` +
    `Attach as this role with scout_attach { role: "${options.role}" } — every session given it signs in from this one login.`
  );
}
