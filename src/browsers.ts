/**
 * Which browsers SceneScout can drive, which builds `scenescout install`
 * downloads for them, and which build a given launch needs.
 *
 * Kept free of Playwright so the rules can be table-tested: the CLI and the
 * engine pass in the paths Playwright reports and get decisions back.
 */
import fs from "node:fs";
import path from "node:path";

/** A browser the engine can launch. */
export const BROWSER_ENGINES = ["chromium", "firefox", "webkit"] as const;
export type BrowserEngineName = (typeof BROWSER_ENGINES)[number];

/**
 * A build Playwright downloads. Chromium comes as two: the full browser, which
 * a headed run opens, and the headless shell, which every headless run uses.
 * Installing "chromium" brings both, which is what install has always done.
 */
export const INSTALL_TARGETS = ["chromium", "chromium-headless-shell", "firefox", "webkit"] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

export const DEFAULT_ENGINE: BrowserEngineName = "chromium";
/** Environment variable naming the browser an attach uses when it does not name one. */
export const DEFAULT_ENGINE_ENV = "SCENESCOUT_BROWSER";

/** Approximate size on disk, so the install output can say what it is about to fetch. */
export const APPROX_DISK_MB: Record<InstallTarget, number> = {
  chromium: 550,
  "chromium-headless-shell": 200,
  firefox: 270,
  webkit: 290,
};

export function isBrowserEngine(value: string): value is BrowserEngineName {
  return (BROWSER_ENGINES as readonly string[]).includes(value);
}

/** The engine an attach uses when the caller names none: the environment's choice, else Chromium. */
export function defaultEngine(env: NodeJS.ProcessEnv): BrowserEngineName {
  const raw = env[DEFAULT_ENGINE_ENV]?.trim().toLowerCase();
  if (!raw) return DEFAULT_ENGINE;
  if (!isBrowserEngine(raw)) {
    throw new Error(`${DEFAULT_ENGINE_ENV}="${env[DEFAULT_ENGINE_ENV]}" is not a browser SceneScout can drive. Use one of: ${BROWSER_ENGINES.join(", ")}.`);
  }
  return raw;
}

/**
 * Read the value of `--browsers`. Absent means what install has always done.
 * `all` is every engine; a comma-separated list picks several. "chromium"
 * already includes the headless shell, so naming both is the same as naming it.
 */
export function parseBrowserSelection(value: string | undefined): { targets: InstallTarget[] } | { error: string } {
  if (value === undefined) return { targets: ["chromium"] };
  const names = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const choices = `${INSTALL_TARGETS.join(", ")}, all`;
  if (names.length === 0) return { error: `--browsers needs a value. Choose from: ${choices}.` };
  const picked = new Set<InstallTarget>();
  for (const name of names) {
    if (name === "all") {
      for (const t of ["chromium", "firefox", "webkit"] as const) picked.add(t);
    } else if ((INSTALL_TARGETS as readonly string[]).includes(name)) {
      picked.add(name as InstallTarget);
    } else {
      return { error: `"${name}" is not a browser SceneScout can install. Choose from: ${choices}.` };
    }
  }
  if (picked.has("chromium")) picked.delete("chromium-headless-shell");
  return { targets: INSTALL_TARGETS.filter((t) => picked.has(t)) };
}

/** The arguments for Playwright's own installer. Target names are Playwright's names. */
export function playwrightInstallArgs(targets: readonly InstallTarget[]): string[] {
  return ["install", ...targets];
}

/** The build a launch needs on disk. */
export function launchTarget(engine: BrowserEngineName, headed: boolean): InstallTarget {
  if (engine !== "chromium") return engine;
  return headed ? "chromium" : "chromium-headless-shell";
}

/** The engine each build belongs to. */
export function engineOf(target: InstallTarget): BrowserEngineName {
  return target === "chromium-headless-shell" ? "chromium" : target;
}

/**
 * Where the headless shell lives, worked out from the full browser's path.
 * Playwright exposes no path for the shell, but it keeps the two side by side
 * under one revision: `chromium-1234/…` next to `chromium_headless_shell-1234/`.
 * Null when the path does not have that shape.
 */
export function headlessShellDir(chromiumExecutable: string | null): string | null {
  if (!chromiumExecutable) return null;
  const parts = chromiumExecutable.split(/[\\/]/);
  // The LAST such segment: a cache kept under a directory that happens to be
  // named the same way must not be mistaken for the build directory.
  let at = -1;
  for (let i = parts.length - 1; i >= 0 && at < 0; i--) if (/^chromium-\d+$/.test(parts[i])) at = i;
  if (at < 0) return null;
  const sep = chromiumExecutable.includes("\\") && !chromiumExecutable.includes("/") ? "\\" : "/";
  return [...parts.slice(0, at), parts[at].replace(/^chromium-/, "chromium_headless_shell-")].join(sep);
}

export type BrowserPresence = Record<InstallTarget, { installed: boolean; path: string | null }>;

/**
 * Which builds are on disk. `executables` is what Playwright reports for each
 * engine; a path Playwright names is not proof the file is there. The shell is
 * counted only once Playwright has marked its download complete.
 */
export function browserPresence(executables: Record<BrowserEngineName, string | null>, exists: (p: string) => boolean = fs.existsSync): BrowserPresence {
  const at = (p: string | null) => ({ installed: !!p && exists(p), path: p });
  const shellDir = headlessShellDir(executables.chromium);
  const shellMarker = shellDir ? path.join(shellDir, "INSTALLATION_COMPLETE") : null;
  const chromium = at(executables.chromium);
  return {
    chromium: { installed: chromium.installed && !!shellMarker && exists(shellMarker), path: chromium.path },
    "chromium-headless-shell": { installed: !!shellMarker && exists(shellMarker), path: shellDir },
    firefox: at(executables.firefox),
    webkit: at(executables.webkit),
  };
}

/** The command that downloads one build, for the way this copy of SceneScout was installed. */
export function installCommandFor(target: InstallTarget, fromCheckout: boolean): string {
  const flags = `--browser-only --browsers ${target}`;
  return fromCheckout ? `node dist/cli.js install ${flags}` : `npx -y scenescout install ${flags}`;
}

/**
 * Whether pages may register service workers in this browser.
 *
 * The write policy works by intercepting requests. Only Chromium lets the
 * driver intercept a request a service worker issues; in Firefox and WebKit
 * such a request goes straight to the network, so an app that syncs its writes
 * from a worker would send a DELETE through read-only mode with nothing
 * logged. Blocking registration there makes the page send those requests
 * itself, where the policy sees them.
 */
export function serviceWorkerPolicy(engine: BrowserEngineName): "allow" | "block" {
  return engine === "chromium" ? "allow" : "block";
}

/**
 * How the live view gets frames of a page.
 *
 * Chromium can push a frame on every repaint through the DevTools protocol,
 * which costs nothing while the page sits still. Firefox and WebKit have no
 * such channel in the driver, so a stream there is a screenshot taken on a
 * timer for as long as somebody is watching.
 */
export function screencastSupport(engine: BrowserEngineName): "cdp" | "poll" {
  return engine === "chromium" ? "cdp" : "poll";
}

/**
 * The key that moves keyboard focus to the next control, links and buttons
 * included. WebKit on macOS follows Safari: plain Tab stops only at text
 * fields, and Option+Tab stops everywhere. A focus audit that pressed Tab
 * there would walk past every button and report nothing.
 */
export function focusAdvanceKey(engine: BrowserEngineName, platform: NodeJS.Platform): "Tab" | "Alt+Tab" {
  return engine === "webkit" && platform === "darwin" ? "Alt+Tab" : "Tab";
}

/**
 * Whether the browser prints a console error of its own for a subresource that
 * failed: "Failed to load resource: the server responded with a status of
 * 500 …" or "Failed to load resource: net::ERR_…". Chromium and WebKit do, and
 * give the resource's address as the message's location; Firefox prints
 * nothing. Where it is printed, the console oracle charges the line to
 * whoever sent the request (oracles.ts `failedLoadEchoOf`), so one failing
 * request inside an embed is not also filed as the app's console error.
 */
export function echoesFailedLoads(engine: BrowserEngineName): boolean {
  return engine !== "firefox";
}

/**
 * The resource type a navigator.sendBeacon request carries when it is
 * intercepted: Chromium calls it "ping", Firefox and WebKit "beacon". A saved
 * flow excuses a refused beacon from its step (flow.ts `splitRefusals`), so
 * every engine's name for it must be known.
 */
export function beaconResourceType(engine: BrowserEngineName): "ping" | "beacon" {
  return engine === "chromium" ? "ping" : "beacon";
}

/**
 * Whether a beacon a page sends as it is being left (sendBeacon, or a
 * keepalive fetch, on `pagehide`) escapes interception. In Chromium it is
 * never routed, so the write policy does not see it and it reaches the server
 * in every mode; Firefox and WebKit route it, and the policy refuses it like
 * any other. A limit of the network-layer policy (ADR 2), reported in ADR 12;
 * the check smoke suite asserts both directions per engine.
 */
export function unloadBeaconsEscapePolicy(engine: BrowserEngineName): boolean {
  return engine === "chromium";
}

/**
 * Run in every page before its own scripts: takes shared workers away.
 *
 * A request issued by a shared worker cannot be intercepted in any browser, so
 * a write sent from one passes the policy unseen and unlogged. Removing the
 * constructor makes feature detection fail, and an app then does that work on
 * the page, where the policy sees it. Not applied in `destructive` mode, where
 * the policy blocks nothing and the person has opted in to everything.
 */
export const REMOVE_SHARED_WORKER_SCRIPT = `(() => {
  try { delete globalThis.SharedWorker; } catch {}
  if ("SharedWorker" in globalThis) {
    try { Object.defineProperty(globalThis, "SharedWorker", { value: undefined, configurable: true, writable: true }); } catch {}
  }
})()`;

/** Whether pages may use shared workers in this write mode. */
export function sharedWorkersAllowed(mode: "observe" | "read-only" | "safe-write" | "destructive"): boolean {
  return mode === "destructive";
}

/**
 * What install says when the browsers it was asked for do not include the one
 * a default attach launches, and that one is not on disk either. Without it,
 * `install --browsers firefox` on a fresh machine ends in "ready" and the first
 * attach fails. Null when there is nothing to say.
 */
export function defaultAttachNote(opts: { selected: readonly InstallTarget[]; defaultEngine: BrowserEngineName; defaultInstalled: boolean }): string | null {
  if (opts.defaultInstalled || opts.selected.length === 0) return null;
  if (opts.selected.some((t) => engineOf(t) === opts.defaultEngine)) return null;
  const engine = engineOf(opts.selected[0]);
  return (
    `an attach drives ${opts.defaultEngine} unless told otherwise, and that build is not installed. ` +
    `Pass browser: "${engine}" when attaching, or set ${DEFAULT_ENGINE_ENV}=${engine} in the MCP server's environment.`
  );
}
