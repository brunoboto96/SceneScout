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
import { chromium, firefox, webkit, type BrowserContext, type BrowserType, type Page } from "playwright";
import { defaultEngine, type BrowserEngineName } from "./browsers.js";
import { explainLaunchFailure } from "./engine/launch.js";
import { redactRoute } from "./engine/check.js";
import { describeLifetime, readLifetime, type ProfileLifetime } from "./engine/expiry.js";
import { describeSaved, writeProfile, type LoginOptions, type ProfileSummary } from "./engine/profiles.js";
import {
  chooseFields,
  chooseSubmit,
  describeStep,
  fieldIdentity,
  nextStep,
  secondsLeft,
  totp as totpCode,
  TOTP_MIN_SECONDS_LEFT,
  urlMatches,
  type FieldInfo,
  type FieldKind,
  type Progress,
  type Redactor,
  type ScriptedLogin,
  type Selectors,
} from "./engine/scripted-login.js";

/**
 * Read what the profile keeps from a signed-in context. One place on purpose:
 * capturing more than cookies and localStorage (sessionStorage, IndexedDB) is
 * a change here and in what attach restores, and nowhere else.
 */
export async function captureState(context: BrowserContext): Promise<unknown> {
  return context.storageState();
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

export async function runLogin(
  options: LoginOptions,
  log: (line: string) => void,
): Promise<{ path: string; summary: ProfileSummary; lifetime: ProfileLifetime }> {
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
    return await saveLogin(context, options);
  } finally {
    end?.dispose();
    // Closing a browser the person already closed fails; nothing is left to clean up then.
    await browser.close().catch(() => {});
  }
}

/**
 * Save a signed-in context as the role's profile and read how long it lasts:
 * what `scenescout login` does once Enter is pressed, apart so it can be run
 * against a headless browser.
 */
export async function saveLogin(
  context: BrowserContext,
  options: Pick<LoginOptions, "url" | "role" | "projectDir">,
): Promise<{ path: string; summary: ProfileSummary; lifetime: ProfileLifetime }> {
  const state = await captureState(context);
  const saved = writeProfile(options.projectDir, options.role, state);
  return { ...saved, lifetime: readLifetime(state, { url: options.url }) };
}

/** The lines printed on success: where, how much, how long it lasts. Never the profile's contents. */
export function savedLine(
  options: LoginOptions,
  saved: { path: string; summary: ProfileSummary; lifetime: ProfileLifetime },
  now: number = Date.now(),
): string {
  return (
    `${describeSaved(saved.path, saved.summary)}\n` +
    `${describeLifetime(saved.lifetime, now)}\n` +
    `Attach as this role with scout_attach { role: "${options.role}" } — every session given it signs in from this one login.`
  );
}

// ── scenescout login --script ────────────────────────────────────────────────

/** The attribute the collector tags each visible control with, so a step can act on the one it chose. */
const TAG = "data-scenescout-login";

/** How often the page is read while waiting for the form to move on. */
const POLL_MS = 250;
/** How many times the form may be submitted before the run gives up: username, password and a code, with room for an interstitial. */
const MAX_SUBMITS = 5;

/**
 * Read every visible form control on the page (the top document only), tag
 * each with its index, and mark those matching a configured selector. Runs in
 * the page, so it may use only what the page has.
 */
function collectFields(selectors: Selectors): FieldInfo[] | { badSelector: string } {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const forced = new Map<Element, FieldInfo["forced"]>();
  for (const kind of ["username", "password", "otp", "submit"] as const) {
    const sel = selectors[kind];
    if (!sel) continue;
    let el: Element | null;
    try {
      el = document.querySelector(sel);
    } catch {
      return { badSelector: kind };
    }
    if (el) forced.set(el, kind);
  }
  const labelOf = (el: Element): string => {
    const parts: string[] = [];
    const id = el.getAttribute("id");
    if (id) for (const l of Array.from(document.querySelectorAll(`label[for="${CSS.escape(id)}"]`))) parts.push(l.textContent ?? "");
    const wrapping = el.closest("label");
    if (wrapping) parts.push(wrapping.textContent ?? "");
    parts.push(el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? "");
    const by = el.getAttribute("aria-labelledby");
    if (by) for (const ref of by.split(/\s+/)) parts.push(document.getElementById(ref)?.textContent ?? "");
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  // Tags from an earlier read name other elements now: one index, one element.
  for (const old of Array.from(document.querySelectorAll("[data-scenescout-login]"))) old.removeAttribute("data-scenescout-login");
  const out: FieldInfo[] = [];
  const all = Array.from(document.querySelectorAll("input, textarea, select, button"));
  for (const el of all) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "hidden" || !visible(el)) continue;
    const index = out.length;
    el.setAttribute("data-scenescout-login", String(index));
    const tag = el.tagName.toLowerCase() as FieldInfo["tag"];
    const input = el as HTMLInputElement;
    out.push({
      index,
      tag,
      type: tag === "button" ? (el.getAttribute("type") ?? "").toLowerCase() : type,
      name: el.getAttribute("name") ?? "",
      id: el.getAttribute("id") ?? "",
      autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(),
      label: labelOf(el),
      text: tag === "button" ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : type === "submit" || type === "button" ? input.value : "",
      inputmode: (el.getAttribute("inputmode") ?? "").toLowerCase(),
      maxLength: typeof input.maxLength === "number" ? input.maxLength : -1,
      filled: tag !== "button" && typeof input.value === "string" && input.value.length > 0,
      disabled: input.disabled === true,
      ...(forced.has(el) ? { forced: forced.get(el) } : {}),
    });
  }
  return out;
}

/** A page's error or alert text, if it shows one: the reason a refused sign-in gives. Redacted before it is printed. */
async function alertText(page: Page): Promise<string> {
  const text = await page
    .evaluate(() => {
      const el = document.querySelector('[role="alert"], [aria-live="assertive"], .error, .alert');
      return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    })
    // The page's message only adds to the refusal being reported; a page navigating away as it is read leaves the refusal as it stands.
    .catch(() => "");
  return text.slice(0, 200);
}

/**
 * Sign in with no one at the keyboard: headless, the credentials from the
 * environment, the form found by engine/scripted-login.ts's rules. Every line
 * it logs and every error it throws goes through the credential redaction
 * first. Saves the profile exactly as the manual login does.
 */
export async function runScriptedLogin(
  options: LoginOptions,
  config: ScriptedLogin,
  redactor: Redactor,
  log: (line: string) => void,
  now: () => number = () => Date.now() / 1000,
): Promise<{ path: string; summary: ProfileSummary; lifetime: ProfileLifetime }> {
  const redact = (text: string): string => redactor.redact(text);
  const say = (line: string): void => log(redact(line));
  /** Every error this run throws, redacted. */
  const fail = (message: string): Error => new Error(redact(message));
  const engine: BrowserEngineName = options.browser ?? defaultEngine(process.env);
  const types: Record<BrowserEngineName, BrowserType> = { chromium, firefox, webkit };
  let browser;
  try {
    browser = await types[engine].launch({ headless: true });
  } catch (err) {
    throw new Error(redact(explainLaunchFailure(err instanceof Error ? err.message : String(err), 0, { engine, headed: false })));
  }
  const deadline = Date.now() + config.timeoutMs;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, config.timeoutMs) });
    } catch (err) {
      throw fail(`could not open ${options.url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    say(`Signing in as "${options.role}" at ${options.url} (${engine}, headless).`);
    if (!config.success.url && !config.success.selector) {
      say("No --success-url or --success-selector: signed in will mean no sign-in field is left on the page. Set one to be sure.");
    }
    const progress: Progress = { submitted: new Map(), submits: 0 };
    const pageKey = (): string => {
      const u = new URL(page.url());
      return `${u.origin}${u.pathname}`;
    };
    /** A read the page's own navigation interrupted: nothing is known about the page yet, so the caller polls again. */
    const midNavigation = (err: Error): boolean => /context was destroyed|navigat|detached/i.test(err.message);
    const successMatched = async (): Promise<boolean> => {
      if (!config.success.url && !config.success.selector) return false;
      if (config.success.url && !urlMatches(page.url(), config.success.url)) return false;
      if (config.success.selector) {
        const visible = await page
          .locator(config.success.selector)
          .first()
          .isVisible()
          .catch((err: Error) => {
            if (midNavigation(err)) return false;
            throw fail(`the success selector could not be used: ${err.message.split("\n")[0]}`);
          });
        if (!visible) return false;
      }
      return true;
    };
    const read = async (): Promise<FieldInfo[] | null> => {
      const got = await page.evaluate(collectFields, config.selectors).catch((err: Error) => {
        if (midNavigation(err)) return null;
        throw err;
      });
      if (got === null) return null;
      if (!Array.isArray(got)) throw fail(`the ${got.badSelector} selector is not a valid CSS selector`);
      return got;
    };
    /** The page's URL for a message, with any token in it redacted. */
    const where = (): string => redactRoute(page.url());
    const signature = (fields: FieldInfo[]): string => {
      const chosen = chooseFields(fields);
      return `${pageKey()}|${(Object.keys(chosen) as FieldKind[]).sort().join(",")}`;
    };
    const stepOpts = (successMatchedNow: boolean) => ({
      hasTotp: config.totp !== undefined,
      successConfigured: Boolean(config.success.url || config.success.selector),
      successMatched: successMatchedNow,
    });
    let lastWait = "the sign-in form to appear";
    for (;;) {
      if (Date.now() > deadline) throw fail(`timed out after ${config.timeoutMs / 1000}s waiting for ${lastWait} (at ${where()})`);
      const fields = await read();
      if (fields === null) {
        await page.waitForTimeout(POLL_MS);
        continue;
      }
      const chosen = chooseFields(fields);
      const step = nextStep(chosen, progress, stepOpts(await successMatched()));
      if (step.kind === "done") {
        if (config.success.url || config.success.selector) break;
        // No sign-in field left is the signal only once the page has settled:
        // a page between a redirect and its first render shows no fields either.
        await page.waitForLoadState("load", { timeout: 10_000 }).catch((err: Error) => {
          if (!/timeout/i.test(err.message) && !midNavigation(err)) throw err;
        });
        await page.waitForTimeout(POLL_MS * 2);
        const settled = await read();
        if (settled !== null && nextStep(chooseFields(settled), progress, stepOpts(false)).kind === "done") break;
        continue;
      }
      if (step.kind === "refused") {
        const says = await alertText(page);
        throw fail(`sign-in refused: ${step.reason}.${says ? ` The page says: "${says}"` : ""}`);
      }
      if (step.kind === "stuck") throw fail(`sign-in stuck: ${step.reason}.`);
      if (step.kind === "wait") {
        lastWait =
          progress.submits === 0
            ? "the sign-in form to appear (set the field selectors if the form is not found)"
            : "the signed-in page (the success URL or selector, or the sign-in fields to go)";
        await page.waitForTimeout(POLL_MS);
        continue;
      }
      if (progress.submits >= MAX_SUBMITS) throw fail(`gave up after ${MAX_SUBMITS} submits without reaching the signed-in page`);
      let last = null as FieldInfo | null;
      for (const kind of step.fill) {
        const field = chosen[kind]!;
        let value: string;
        if (kind === "otp") {
          const totp = config.totp!;
          if (secondsLeft(totp, now()) < TOTP_MIN_SECONDS_LEFT) await page.waitForTimeout(secondsLeft(totp, now()) * 1000 + 200);
          value = totpCode(totp, now());
          redactor.add(value);
        } else value = kind === "username" ? config.username : config.password;
        await page.locator(`[${TAG}="${field.index}"]`).fill(value, { timeout: 10_000 });
        progress.submitted.set(kind, fieldIdentity(field));
        last = field;
      }
      const button = chooseSubmit(fields);
      const before = signature(fields);
      if (button) await page.locator(`[${TAG}="${button.index}"]`).click({ timeout: 10_000 });
      else await page.locator(`[${TAG}="${last!.index}"]`).press("Enter", { timeout: 10_000 });
      progress.submits += 1;
      const did = describeStep(step.fill, button ? button.text || button.label || "the submit button" : null);
      say(did);
      lastWait = `the page to move on after that step (${did})`;
      // Wait for the form to move on: another page, or other fields on this one.
      while (Date.now() <= deadline) {
        await page.waitForTimeout(POLL_MS);
        const after = await read();
        if (after === null) continue;
        if (signature(after) !== before || (await successMatched())) break;
        const again = chooseFields(after);
        // The same fields, emptied: a refused submit re-rendered in place.
        if (step.fill.some((k) => again[k] && !again[k]!.filled)) break;
      }
    }
    say(`Signed in: now at ${where()}.`);
    return await saveLogin(context, options);
  } finally {
    // The result (a saved profile or the error being thrown) is already decided; a browser that fails to close changes neither.
    await browser.close().catch(() => {});
  }
}
