/**
 * Runs `scenescout login <url> --role <name>` and scout_login: opens a
 * visible browser at the URL, lets the person sign in however the app asks
 * (SSO, MFA, a password manager), and once they are signed in saves the
 * browser's storage state as that role's profile.
 *
 * The window saves by itself once engine/signed-in.ts says the sign-in has
 * finished; Enter in the terminal saves at once, and `--save enter` makes it
 * the only way, as before. Closing the window or Ctrl+C saves nothing: by the
 * time a window is closed its state can no longer be read, and a profile saved
 * by accident half-way through a sign-in would be attached later as if it
 * worked.
 *
 * The rules (role names, where the file goes, its mode, what may be printed)
 * are in engine/profiles.ts; this file only drives the browser and the terminal.
 */
import readline from "node:readline";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { defaultEngine, type BrowserEngineName } from "./browsers.js";
import { explainLaunchFailure } from "./engine/launch.js";
import { explicitLimits, isTimeoutMessage, LIMIT_NAMES, type LimitKind } from "./engine/limits.js";
import { redactRoute } from "./engine/check.js";
import { describeLifetime, readLifetime, type ProfileLifetime } from "./engine/expiry.js";
import { describeSaved, mergeSessionStorage, withSessionStorage, writeProfile, type LoginOptions, type ProfileSummary } from "./engine/profiles.js";
import {
  afterTyping,
  chooseFields,
  describeStep,
  fieldIdentity,
  filledNames,
  nextStep,
  otpBoxes,
  quotable,
  secondsLeft,
  splitCode,
  totp as totpCode,
  TOTP_MIN_SECONDS_LEFT,
  urlMatches,
  type AfterTyping,
  type CodeSource,
  type FieldInfo,
  type FieldKind,
  type Progress,
  type Redactor,
  type ScriptedLogin,
  type Selectors,
  type StepOptions,
  type SubmittedBy,
  unansweredSubmit,
} from "./engine/scripted-login.js";
import {
  DEFAULT_SAVE_MODE,
  judgeSignIn,
  LOOK_EVERY_MS,
  onApp,
  startWatch,
  type HeldValue,
  type SaveMode,
  type SignInLook,
  type SignInVerdict,
  type SignInWatch,
  type WaitReason,
} from "./engine/signed-in.js";

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

/** How the interactive sign-in ended: signed in (seen, or Enter pressed), or not. */
export type LoginEnd = "signed-in" | "enter" | "window-closed" | "input-ended" | "interrupted" | "timed-out";

/** How long after the prompt input still counts as typed before it. */
const EARLY_INPUT_MS = 300;

/**
 * Wait for Enter on the terminal, the input ending or Ctrl+C. With `keepOnEnd`
 * (the window saves by itself), input that ends is not an answer: a client
 * that starts the command with no terminal closes it at once, and the window
 * is still the way to finish.
 */
function waitForEnter(keepOnEnd: boolean): { done: Promise<LoginEnd>; dispose: () => void } {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // Lines typed before the prompt (while the browser launched or the page
  // loaded) arrive at once, buffered; they are not an answer to it.
  const listening = Date.now() + EARLY_INPUT_MS;
  let onSigint: (() => void) | undefined;
  const done = new Promise<LoginEnd>((resolve) => {
    rl.on("line", () => {
      if (Date.now() >= listening) resolve("enter");
    });
    if (!keepOnEnd) rl.once("close", () => resolve("input-ended"));
    onSigint = () => resolve("interrupted");
    process.once("SIGINT", onSigint);
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

const NOT_SAVED: Record<Exclude<LoginEnd, "enter" | "signed-in">, string> = {
  "window-closed": "The browser was closed before the sign-in finished, so nothing was saved. Run the command again and sign in in the window it opens.",
  "input-ended":
    "The terminal's input ended before Enter was pressed, so nothing was saved. Run this command in an interactive terminal, or leave out --save enter so the window saves by itself once you are signed in.",
  interrupted: "Interrupted, so nothing was saved.",
  "timed-out": "The sign-in did not finish in time, so the window was closed and nothing was saved.",
};

/** A visible browser opened at the sign-in URL, and a promise that settles when it closes. */
export interface LoginWindow {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  engine: BrowserEngineName;
  closed: Promise<void>;
}

/** Open the window a person signs in in. Throws a sentence when the browser cannot start or the page cannot load. */
export async function openLoginWindow(options: Pick<LoginOptions, "url" | "browser">, opts: { headless?: boolean } = {}): Promise<LoginWindow> {
  const engine: BrowserEngineName = options.browser ?? defaultEngine(process.env);
  const types: Record<BrowserEngineName, BrowserType> = { chromium, firefox, webkit };
  // Checked before a window opens: a limit out of bounds is a sentence, not a browser left behind.
  const navMs = explicitLimits({}, process.env).navMs ?? LOGIN_NAV_MS;
  const headless = opts.headless ?? false;
  let browser: Browser;
  try {
    browser = await types[engine].launch({ headless });
  } catch (err) {
    throw new Error(explainLaunchFailure(err instanceof Error ? err.message : String(err), 0, { engine, headed: !headless }));
  }
  const closed = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Closing the sign-in tab is how most people close the window; treat it the
    // same. The browser may already be closing, and either way it ends up closed.
    page.once("close", () => void browser.close().catch(() => {}));
    try {
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: navMs });
    } catch (err) {
      const explained = loginTimeout(err, "nav", navMs);
      throw new Error(`could not open ${options.url}: ${explained instanceof Error ? explained.message.split("\n")[0] : String(explained)}`);
    }
    return { browser, context, page, engine, closed };
  } catch (err) {
    // The error being thrown is the one to report; a browser that fails to close as well adds nothing to it.
    await browser.close().catch(() => {});
    throw err;
  }
}

/** Longest storage value read for a look; a longer one is compared by its start. */
const MAX_HELD_VALUE = 64 * 1024;

/** The cookies the browser would send to `url` and the top document's storage: what a look compares with the baseline. */
async function readHeld(context: BrowserContext, page: Page, url: string): Promise<HeldValue[]> {
  const held: HeldValue[] = (await context.cookies([url])).map((c) => ({
    kind: "cookie" as const,
    key: `cookie|${c.domain}|${c.path}|${c.name}`,
    name: c.name,
    value: c.value,
  }));
  const storage = await page.evaluate((max) => {
    const out: { kind: "local" | "session"; name: string; value: string }[] = [];
    for (const [kind, store] of [
      ["local", localStorage],
      ["session", sessionStorage],
    ] as const) {
      for (let i = 0; i < store.length; i++) {
        const name = store.key(i);
        if (name !== null) out.push({ kind, name, value: (store.getItem(name) ?? "").slice(0, max) });
      }
    }
    return { origin: location.origin, out };
  }, MAX_HELD_VALUE);
  for (const e of storage.out) held.push({ kind: e.kind, key: `${e.kind}|${storage.origin}|${e.name}`, name: e.name, value: e.value });
  return held;
}

/** A read the page's own navigation interrupted: the look is skipped and taken again. */
const betweenPages = (err: Error): boolean => /context was destroyed|navigat|detached|target closed|has been closed/i.test(err.message);

/** One look at the window, or null when the page was between documents and the look should be taken again. */
async function lookAt(win: LoginWindow, watch: SignInWatch): Promise<SignInLook | null> {
  const url = win.page.url();
  const popupAway = win.context.pages().some((p) => p !== win.page && !p.isClosed() && /^https?:/i.test(p.url()) && !onApp(watch, p.url()));
  // Off the app nothing is read, except at an absolute success URL, where a sign-in field still says it is not done.
  const atSuccess = watch.successUrl !== undefined && /^https?:\/\//i.test(watch.successUrl) && urlMatches(url, watch.successUrl);
  if (!onApp(watch, url) && !atSuccess) return { url, signInField: false, held: [], popupAway };
  try {
    const fields = await win.page.evaluate(collectFields, { selectors: {}, tag: false });
    if (!Array.isArray(fields)) return null;
    const chosen = chooseFields(fields);
    const held = await readHeld(win.context, win.page, url);
    // The page moved while it was read: what was read belongs to two pages.
    if (win.page.url() !== url) return null;
    return { url, signInField: Boolean(chosen.password || chosen.otp), held, popupAway };
  } catch (err) {
    if (err instanceof Error && betweenPages(err)) return null;
    throw err;
  }
}

/** What the watch said last, for whoever asks how the sign-in is going. */
export interface WatchProgress {
  reason: WaitReason | "starting";
  url: string;
}

/**
 * Watch the window until the person is signed in (engine/signed-in.ts says
 * when), the window closes, or `signal` aborts. Resolves with how it ended;
 * the caller saves and closes.
 */
export async function watchForSignIn(
  win: LoginWindow,
  options: { url: string; successUrl?: string },
  opts: { signal?: AbortSignal; progress?: (p: WatchProgress) => void } = {},
): Promise<{ kind: "signed-in"; verdict: Extract<SignInVerdict, { kind: "signed-in" }>; url: string } | { kind: "closed" } | { kind: "aborted" }> {
  let closed = false;
  void win.closed.then(() => {
    closed = true;
  });
  // The baseline is what the window holds once the first page is there: whatever the app set before anyone signed in.
  const firstUrl = win.page.url();
  let watch = startWatch(options.url, [], options.successUrl, firstUrl);
  const baseline: HeldValue[] = [];
  try {
    for (const c of await win.context.cookies()) baseline.push({ kind: "cookie", key: `cookie|${c.domain}|${c.path}|${c.name}`, name: c.name, value: c.value });
    if (onApp(watch, firstUrl)) {
      const first = await readHeld(win.context, win.page, firstUrl).catch((err: Error) => {
        if (betweenPages(err)) return [];
        throw err;
      });
      baseline.push(...first.filter((h) => h.kind !== "cookie"));
    }
  } catch (err) {
    if (opts.signal?.aborted) return { kind: "aborted" };
    if (closed || win.page.isClosed()) return { kind: "closed" };
    throw err;
  }
  watch = startWatch(options.url, baseline, options.successUrl, firstUrl);
  opts.progress?.({ reason: "starting", url: firstUrl });
  for (;;) {
    if (closed || win.page.isClosed()) return { kind: "closed" };
    if (opts.signal?.aborted) return { kind: "aborted" };
    let look: SignInLook | null;
    try {
      look = await lookAt(win, watch);
    } catch (err) {
      // The window closing under a look is the window closing, not an error; nor is a look the caller already stopped
      // (Enter was pressed and the window is being closed to save).
      if (opts.signal?.aborted) return { kind: "aborted" };
      if (closed || win.page.isClosed()) return { kind: "closed" };
      throw err;
    }
    if (look !== null) {
      const judged = judgeSignIn(watch, look);
      watch = judged.watch;
      if (judged.verdict.kind === "signed-in") return { kind: "signed-in", verdict: judged.verdict, url: look.url };
      opts.progress?.({ reason: judged.verdict.reason, url: look.url });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

/** What the window says once the sign-in is seen: where, and by what. */
function sayDetected(verdict: Extract<SignInVerdict, { kind: "signed-in" }>, url: string): string {
  const how = verdict.via === "success-url" ? "reached the success URL" : `the app holds a new session (${verdict.credential})`;
  return `Signed in: back on ${redactRoute(url)} and ${how}. Saving and closing the window.`;
}

export async function runLogin(
  options: LoginOptions,
  log: (line: string) => void,
): Promise<{ path: string; summary: ProfileSummary; lifetime: ProfileLifetime }> {
  const mode: SaveMode = options.save ?? DEFAULT_SAVE_MODE;
  const win = await openLoginWindow(options);
  let enter: ReturnType<typeof waitForEnter> | undefined;
  const stop = new AbortController();
  try {
    log(`A ${win.engine} window is open at ${options.url}.`);
    if (mode === "auto") {
      log(`Sign in as "${options.role}" there — SSO, MFA, whatever the app asks. The window saves and closes by itself once you are signed in.`);
      log(`(To save sooner, press Enter here. Closing the window or pressing Ctrl+C saves nothing.)`);
    } else {
      log(`Sign in as "${options.role}" there — SSO, MFA, whatever the app asks — then come back here and press Enter to save.`);
      log(`(Closing the window or pressing Ctrl+C saves nothing.)`);
    }
    // Listening starts only now, after the prompt: an Enter pressed while the
    // page was still loading must not save a signed-out profile.
    enter = waitForEnter(mode === "auto");
    const racers: Promise<LoginEnd>[] = [enter.done, win.closed.then((): LoginEnd => "window-closed")];
    if (mode === "auto") {
      racers.push(
        watchForSignIn(win, options, { signal: stop.signal }).then((r): LoginEnd => {
          if (r.kind === "signed-in") {
            log(sayDetected(r.verdict, r.url));
            return "signed-in";
          }
          return r.kind === "closed" ? "window-closed" : "interrupted";
        }),
      );
    }
    const how = await Promise.race(racers);
    stop.abort();
    if (how !== "enter" && how !== "signed-in") throw new Error(NOT_SAVED[how]);
    return await saveLogin(win.context, options);
  } finally {
    stop.abort();
    enter?.dispose();
    // Closing a browser the person already closed fails; nothing is left to clean up then.
    await win.browser.close().catch(() => {});
  }
}

/** How long a sign-in window opened from the conversation stays open, at most, before it closes saving nothing. */
export const LOGIN_WINDOW_MAX_MS = 15 * 60_000;

/** A sign-in window opened by scout_login, watched in the background so one tool call need not last as long as the person takes. */
export interface PendingLogin {
  role: string;
  url: string;
  /** The window itself: a smoke test acts in it as the person would. */
  window: LoginWindow;
  /** Settles once the window has saved a profile, or with why it did not. */
  done: Promise<{ ok: true; saved: { path: string; summary: ProfileSummary; lifetime: ProfileLifetime }; detected: string } | { ok: false; error: string }>;
  /** What the watch said last. */
  progress(): WatchProgress;
  /** Close the window, saving nothing. */
  cancel(): Promise<void>;
}

/**
 * Open a window for a person to sign in, watch it, and save the profile once
 * they are signed in: what scout_login does. Never waits for Enter; the
 * window closing, `cancel`, or LOGIN_WINDOW_MAX_MS passing saves nothing.
 */
export async function startLoginWindow(options: LoginOptions, opts: { headless?: boolean; maxMs?: number } = {}): Promise<PendingLogin> {
  const win = await openLoginWindow(options, opts);
  const stop = new AbortController();
  let last: WatchProgress = { reason: "starting", url: options.url };
  const timer = setTimeout(() => stop.abort(), opts.maxMs ?? LOGIN_WINDOW_MAX_MS);
  const done = (async (): Promise<Awaited<PendingLogin["done"]>> => {
    try {
      const r = await watchForSignIn(win, options, { signal: stop.signal, progress: (p) => (last = p) });
      if (r.kind === "closed") return { ok: false, error: NOT_SAVED["window-closed"] };
      if (r.kind === "aborted") return { ok: false, error: NOT_SAVED["timed-out"] };
      const saved = await saveLogin(win.context, options);
      return { ok: true, saved, detected: sayDetected(r.verdict, r.url).replace(/ Saving and closing the window\.$/, "") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      // The outcome is decided; a window the person already closed fails to close again, and nothing is left then.
      await win.browser.close().catch(() => {});
    }
  })();
  return {
    role: options.role,
    url: options.url,
    window: win,
    done,
    progress: () => last,
    cancel: async () => {
      stop.abort();
      // Closed either way: a window already gone fails to close again. `done` settles once the watch sees it.
      await win.browser.close().catch(() => {});
      await done;
    },
  };
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
/**
 * The attribute put on each element a value is typed into. The page drawing
 * the field again (or another page) drops it, so a later read can tell a
 * submit the page has not answered yet from the field coming back.
 */
const TYPED = "data-scenescout-typed";

/** How often the page is read while waiting for the form to move on. */
const POLL_MS = 250;
/**
 * The error with what to raise when it is a timeout. Signing in reads only the
 * environment variable, so the hint names only that, or `--timeout` when the
 * sign-in's own overall limit was the shorter one and ran out.
 */
function loginTimeout(err: unknown, kind: LimitKind, ms: number, overallCapped = false): unknown {
  if (!(err instanceof Error) || !isTimeoutMessage(err.message)) return err;
  const [first, ...rest] = err.message.split("\n");
  const raise = overallCapped ? "raise --timeout, the sign-in's overall limit" : `raise it with ${LIMIT_NAMES[kind].env} in the environment`;
  return new Error(
    [`${first} — the ${LIMIT_NAMES[kind].what} (${ms} ms) ran out; if the machine is loaded rather than the app slow, ${raise}.`, ...rest].join("\n"),
  );
}

/** How long a login page may take to load, unless SCENESCOUT_NAV_TIMEOUT_MS says otherwise (engine/limits.ts). */
const LOGIN_NAV_MS = 30_000;
/** How long filling a sign-in field or submitting may take, unless SCENESCOUT_ACTION_TIMEOUT_MS says otherwise. */
const LOGIN_ACTION_MS = 10_000;
/** How many times the form may be submitted before the run gives up: username, password and a code, with room for an interstitial. */
const MAX_SUBMITS = 5;

/**
 * Read every visible form control on the page (the top document only), tag
 * each with its index when asked (a scripted sign-in acts on them; watching a
 * person sign in only reads them, so leaves the page as it is), and mark those
 * matching a configured selector. Runs in the page, so it may use only what
 * the page has.
 */
function collectFields({ selectors, tag: tagging }: { selectors: Selectors; tag: boolean }): FieldInfo[] | { badSelector: string } {
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
  if (tagging) for (const old of Array.from(document.querySelectorAll("[data-scenescout-login]"))) old.removeAttribute("data-scenescout-login");
  const out: FieldInfo[] = [];
  const all = Array.from(document.querySelectorAll("input, textarea, select, button"));
  for (const el of all) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "hidden" || !visible(el)) continue;
    const index = out.length;
    if (tagging) el.setAttribute("data-scenescout-login", String(index));
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
      // The literal, since this runs in the page: TYPED.
      typed: el.hasAttribute("data-scenescout-typed"),
      ...(forced.has(el) ? { forced: forced.get(el) } : {}),
    });
  }
  return out;
}

/**
 * The error or alert a page shows, if any: the first one on screen with text
 * in it (a hidden, pre-rendered alert says nothing about this run), whole.
 * The caller redacts it before shortening it (quotable).
 */
async function alertText(page: Page): Promise<string> {
  return (
    page
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], .error, .alert'))) {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          const text = (el.textContent ?? "").trim();
          if (text && r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none") return text;
        }
        return "";
      })
      // The page's message only adds to the error being reported; a page navigating away as it is read leaves that error as it stands.
      .catch(() => "")
  );
}

/**
 * Sign in with no one at the keyboard: headless, the credentials from the
 * environment, the form found by engine/scripted-login.ts's rules. Every line
 * it logs and every error it throws goes through the credential redaction
 * first. Saves the profile exactly as the manual login does.
 *
 * Each step fills what the page asks for, then reads the page again until it
 * is clear how to submit (engine/scripted-login.ts's afterTyping): a page that
 * submitted the step itself is not submitted again, a button the page enables
 * only once the form is complete is waited for, and a field the typing
 * revealed is filled first.
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
  // A limit set in the environment applies here too; unset, signing in keeps its own longer waits.
  const set = explicitLimits({}, process.env);
  const limits = { navMs: set.navMs ?? LOGIN_NAV_MS, actionMs: set.actionMs ?? LOGIN_ACTION_MS };
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
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: Math.min(limits.navMs, config.timeoutMs) });
    } catch (err) {
      const explained = loginTimeout(err, "nav", Math.min(limits.navMs, config.timeoutMs), config.timeoutMs < limits.navMs);
      throw fail(`could not open ${options.url}: ${explained instanceof Error ? explained.message.split("\n")[0] : String(explained)}`);
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
      const got = await page.evaluate(collectFields, { selectors: config.selectors, tag: true }).catch((err: Error) => {
        if (midNavigation(err)) return null;
        throw fail(err.message);
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
    const stepOpts = (successMatchedNow: boolean, fields: readonly FieldInfo[]): StepOptions => {
      const checking = unansweredSubmit(fields, progress.submitted);
      return {
        hasPassword: config.password !== undefined,
        ...(config.code ? { code: config.code.kind } : {}),
        successConfigured: Boolean(config.success.url || config.success.selector),
        successMatched: successMatchedNow,
        ...(checking ? { checking } : {}),
      };
    };
    /** The code to type now: the fixed one, or the TOTP code, waiting for the next one when this one is about to expire. */
    const currentCode = async (source: CodeSource): Promise<string> => {
      if (source.kind === "fixed") return source.code;
      const params = source.params;
      if (secondsLeft(params, now()) < TOTP_MIN_SECONDS_LEFT) await page.waitForTimeout(secondsLeft(params, now()) * 1000 + 200);
      const code = totpCode(params, now());
      redactor.add(code);
      return code;
    };
    const at = (f: FieldInfo) => page.locator(`[${TAG}="${f.index}"]`);
    /** Mark the element about to be typed into: see TYPED. */
    const markTyped = (f: FieldInfo): Promise<void> => at(f).evaluate((el, attr) => el.setAttribute(attr, ""), TYPED, { timeout: limits.actionMs });
    /** A failed action as this run's error: the time limit explained, redacted like everything else it throws. */
    const actionError = (err: unknown): Error => {
      const explained = loginTimeout(err, "action", limits.actionMs);
      return fail(explained instanceof Error ? explained.message : String(explained));
    };
    const actionFailed = (err: unknown): Promise<never> => Promise.reject(actionError(err));
    /** What the page says, fit to quote. */
    const pageSays = async (): Promise<string> => quotable(await alertText(page), redact, 200);
    /** A button's text fit to quote, redacted before it is shortened. */
    const buttonText = (f: FieldInfo): string => quotable(f.text || f.label || "the submit button", redact, 40);
    /** The run's deadline passed: say what it was waiting for, and what the page says, if anything. */
    const timedOut = async (waitingFor: string): Promise<Error> => {
      const says = await pageSays();
      return fail(`timed out after ${config.timeoutMs / 1000}s waiting for ${waitingFor} (at ${where()})${says ? `. The page says: "${says}"` : ""}`);
    };
    const submitOpts = { passwordless: config.password === undefined };
    let lastWait = "the sign-in form to appear";
    for (;;) {
      // Past the deadline the page is read once more, so a submit it never answered is reported as that, not as a refusal.
      const late = Date.now() > deadline;
      const fields = await read();
      if (fields === null) {
        if (late) throw await timedOut(lastWait);
        await page.waitForTimeout(POLL_MS);
        continue;
      }
      const keyAtRead = pageKey();
      const chosen = chooseFields(fields);
      const step = nextStep(chosen, progress, {
        ...stepOpts(await successMatched(), fields),
        ...(late ? { timedOutAfterS: config.timeoutMs / 1000 } : {}),
      });
      if (step.kind === "timeout") {
        const says = await pageSays();
        throw fail(`${step.reason} (at ${where()})${says ? `. The page says: "${says}"` : ""}`);
      }
      if (late && step.kind !== "refused") throw await timedOut(lastWait);
      if (step.kind === "done") {
        if (config.success.url || config.success.selector) break;
        // No sign-in field left is the signal only once the page has settled:
        // a page between a redirect and its first render shows no fields either.
        await page.waitForLoadState("load", { timeout: limits.actionMs }).catch((err: Error) => {
          if (!/timeout/i.test(err.message) && !midNavigation(err)) throw fail(err.message);
        });
        await page.waitForTimeout(POLL_MS * 2);
        const settled = await read();
        if (settled !== null && nextStep(chooseFields(settled), progress, stepOpts(false, settled)).kind === "done") break;
        continue;
      }
      if (step.kind === "refused") {
        const says = await pageSays();
        throw fail(`sign-in refused: ${step.reason}.${says ? ` The page says: "${says}"` : ""}`);
      }
      if (step.kind === "stuck") throw fail(`sign-in stuck: ${step.reason}.`);
      if (step.kind === "wait") {
        const credentialSent = progress.submitted.has("password") || progress.submitted.has("otp");
        lastWait =
          progress.submits === 0
            ? "the sign-in form to appear (set the field selectors if the form is not found)"
            : !credentialSent
              ? "the page to ask for the password or the one-time code (set --password-selector or --otp-selector if the field is there but not found)"
              : "the signed-in page (the success URL or selector, or the sign-in fields to go)";
        await page.waitForTimeout(POLL_MS);
        continue;
      }
      if (progress.submits >= MAX_SUBMITS) throw fail(`gave up after ${MAX_SUBMITS} submits without reaching the signed-in page`);
      let boxOpts: { codeBoxes?: number } = {};
      // What this step typed, recorded as submitted only once the step is: a step the page holds back (fill-more) is typed again.
      const typedIds = new Map<FieldKind, string>();
      for (const kind of step.fill) {
        const field = chosen[kind]!;
        const boxes = kind === "otp" ? otpBoxes(fields, field) : null;
        if (boxes) {
          const split = splitCode(await currentCode(config.code!), boxes.length, config.code!.kind);
          if (!split.ok) throw fail(`sign-in stuck: ${split.error}.`);
          for (const [i, box] of boxes.entries()) {
            try {
              // A box is often enabled only once the one before it is filled.
              await page.waitForFunction(
                ([attr, index]) => {
                  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLInputElement | null;
                  return el !== null && !el.disabled;
                },
                [TAG, String(box.index)] as const,
                { timeout: limits.actionMs, polling: 50 },
              );
              // Cleared only when it holds something: clearing sends Delete, which some boxes take as a step back to the box before.
              if ((await at(box).inputValue({ timeout: limits.actionMs })) !== "") await at(box).fill("", { timeout: limits.actionMs });
              await markTyped(box);
              // Typed as keys: a box that moves on to the next by itself, or reads keys rather than its value, still gets its character.
              await at(box).pressSequentially(split.chars[i], { timeout: limits.actionMs });
            } catch (err) {
              // The first line only: the call log after it names the character being typed, which no redaction of the whole code catches.
              const explained = loginTimeout(err, "action", limits.actionMs);
              const first = (explained instanceof Error ? explained.message : String(explained)).split("\n")[0];
              throw fail(`could not type into box ${i + 1} of ${boxes.length} of the one-time code: ${first}`);
            }
          }
          boxOpts = { codeBoxes: boxes.length };
        } else {
          const value = kind === "otp" ? await currentCode(config.code!) : kind === "username" ? config.username : config.password!;
          await markTyped(field).catch(actionFailed);
          await at(field).fill(value, { timeout: limits.actionMs }).catch(actionFailed);
        }
        typedIds.set(kind, fieldIdentity(field));
      }
      const before = signature(fields);
      const shownBefore = new Set(Object.keys(chosen) as FieldKind[]);
      const readNow = async (): Promise<AfterTyping> => {
        const now = await read();
        return afterTyping(step.fill, { left: now === null || pageKey() !== keyAtRead, fields: now ?? [] }, shownBefore, submitOpts);
      };
      let next: AfterTyping;
      for (;;) {
        await page.waitForTimeout(POLL_MS);
        next = await readNow();
        if (next.kind !== "wait") break;
        if (Date.now() > deadline) {
          const control = next.button ? `the "${buttonText(next.button)}" button` : "the field just filled";
          throw await timedOut(`${control} to be enabled, or the page to move on, after filling ${filledNames(step.fill, boxOpts)}`);
        }
      }
      if (next.kind === "fill-more") {
        say(describeStep(step.fill, "more", boxOpts));
        continue;
      }
      let by: SubmittedBy = "page";
      if (next.kind === "click" || next.kind === "enter") {
        try {
          if (next.kind === "click") await at(next.button).click({ timeout: limits.actionMs });
          else await at(next.field).press("Enter", { timeout: limits.actionMs });
        } catch (err) {
          // The page moved on while the click waited (it took the step itself, or the click went through as it left): the step is
          // done. Otherwise the click's own error is the one to report, also when reading the page to tell fails.
          const moved = await readNow().then(
            (after) => after.kind === "moved",
            () => false,
          );
          if (!moved) throw actionError(err);
        }
        by = next.kind === "click" ? { button: buttonText(next.button) } : "enter";
      }
      for (const [kind, identity] of typedIds) progress.submitted.set(kind, identity);
      progress.submits += 1;
      const did = describeStep(step.fill, by, boxOpts);
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
