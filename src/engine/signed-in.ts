/**
 * When an interactive sign-in has finished, so `scenescout login` and
 * scout_login can save the profile and close the window without anyone
 * pressing Enter in a terminal.
 *
 * The window is looked at every half second or so (login-run.ts). Each look
 * is reduced to a few facts: where the tab is, whether it shows a password or
 * one-time-code field, and which cookies and storage entries the app's page
 * holds. This file decides from a run of those looks whether the person is
 * signed in. It never sees the browser, so every case is a table test.
 *
 * Signed in means all of these, on two looks in a row at the same address:
 *   - the tab is back on the app (the origin the sign-in started at, or the
 *     same host's other scheme or www. its first page landed on), not on
 *     an identity provider, and no other tab is still on one;
 *   - the page shows no password or one-time-code field and its path is not
 *     a sign-in route or step (a second factor, an account picker);
 *   - it is not an OAuth, OpenID Connect or SAML return the app has yet to
 *     exchange (a `code` with a `state`, a token in the fragment, a SAML
 *     response);
 *   - a credential appeared that was not there when the window opened, or
 *     one there then changed: a cookie sent to this page or a storage entry
 *     of its origin whose name or value looks like a session;
 *   - the person went through a sign-in screen first (a sign-in field, a
 *     sign-in route, or another origin), so a landing page that sets a cookie
 *     when a banner is dismissed is never taken for a sign-in.
 *
 * A success URL, when one is given, replaces the credential and the sign-in
 * route: once a sign-in screen has been seen, the page at that URL with no
 * sign-in field on it is signed in.
 */
import { LOGIN_ROUTE_RE } from "./authloss.js";
import { urlMatches } from "./scripted-login.js";

/** One cookie or storage entry the app's page holds. */
export interface HeldValue {
  kind: "cookie" | "local" | "session";
  /** Identity across looks: for a cookie its domain, path and name; for storage the origin and key. */
  key: string;
  name: string;
  value: string;
}

/** What one look at the window found. */
export interface SignInLook {
  /** The sign-in tab's address. */
  url: string;
  /** A password or one-time-code field is on screen in that tab. Read on the app's origin and at an absolute success URL. */
  signInField: boolean;
  /** Cookies the browser would send to `url` and the storage of its origin. Only read on the app's origin. */
  held: readonly HeldValue[];
  /** Another tab (a sign-in popup) is open on an origin that is not the app's. */
  popupAway: boolean;
}

/** What the watch carries from one look to the next. */
export interface SignInWatch {
  /** The origins that count as the app: the one the sign-in started at. */
  appOrigins: readonly string[];
  /** Every value held when the window opened, by key. */
  baseline: ReadonlyMap<string, string>;
  /** A sign-in screen or another origin has been seen. */
  sawSignIn: boolean;
  /** The address of the last look that read as signed in, and how many in a row did. */
  candidate: { url: string; looks: number } | null;
  /** `--success-url`: what the URL's path contains once signed in, or an absolute URL it starts with. */
  successUrl?: string;
}

/** Why the watch is still waiting, said to the person in plain words. */
export type WaitReason = "away" | "popup" | "sign-in-screen" | "returning" | "no-session" | "not-started" | "settling";

export type SignInVerdict = { kind: "signed-in"; via: "credential" | "success-url"; credential?: string } | { kind: "waiting"; reason: WaitReason };

/** Looks in a row that must agree before the window is closed: a redirect chain passes through pages that look done for a moment. */
export const STABLE_LOOKS = 2;

/** How often the window is looked at, in ms. */
export const LOOK_EVERY_MS = 500;

export const WAIT_SAYS: Record<WaitReason, string> = {
  away: "on another site (the identity provider)",
  popup: "a sign-in window on another site is still open",
  "sign-in-screen": "on the sign-in screen",
  returning: "back on the app, which is still finishing the sign-in",
  "no-session": "on the app, but it holds no new session yet",
  "not-started": "no sign-in screen has been seen yet",
  settling: "signed in, making sure the page has settled",
};

/**
 * Start watching. The app is the origin of the URL the window opened at, and
 * also the origin its first page landed on when that is the same host but
 * for a leading `www.` or the scheme (http to https, the apex to www): an app
 * that redirects there before anyone signs in. A redirect to any other host
 * is the identity provider. The baseline is what the window held then.
 */
export function startWatch(startUrl: string, held: readonly HeldValue[], successUrl?: string, landedUrl?: string): SignInWatch {
  const start = originOf(startUrl);
  const landed = landedUrl === undefined ? null : originOf(landedUrl);
  const origins = [start ?? startUrl];
  if (start && landed && landed !== start && bareHost(start) === bareHost(landed)) origins.push(landed);
  return {
    appOrigins: origins,
    baseline: new Map(held.map((h) => [h.key, h.value])),
    sawSignIn: false,
    candidate: null,
    ...(successUrl ? { successUrl } : {}),
  };
}

/** An origin's host without a leading `www.`. The port is left out: a scheme change moves the default port. */
function bareHost(origin: string): string {
  return new URL(origin).hostname.replace(/^www\./i, "");
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The address is one of the app's. */
export function onApp(watch: Pick<SignInWatch, "appOrigins">, url: string): boolean {
  const origin = originOf(url);
  return origin !== null && watch.appOrigins.includes(origin);
}

/**
 * An address an identity provider sends the browser back to before the app
 * has exchanged what it carries: an authorization code with its state, a
 * token or an error in the fragment, or a SAML response. The page that
 * follows it is the one to judge.
 */
export function isAuthReturn(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const q = u.searchParams;
  if (q.has("code") && q.has("state")) return true;
  if (q.has("SAMLResponse") || q.has("SAMLart")) return true;
  const fragment = new URLSearchParams(u.hash.replace(/^#/, ""));
  return fragment.has("access_token") || fragment.has("id_token") || (fragment.has("code") && fragment.has("state"));
}

/** Names a session credential goes by. */
const CREDENTIAL_NAME = /sess|auth|token|jwt|(^|[^a-z])sid([^a-z]|$)|login|ident|user|account|remember|bearer|oidc|saml|msal|cognito|aspnetcore/i;
/** Names of values a sign-in sets on the way that are not the session: anti-forgery, the redirect's own state, where to go after. */
const NOT_CREDENTIAL_NAME = /csrf|xsrf|nonce|pkce|verifier|consent|redirect|return_?(to|url)|state$/i;
/** Analytics and marketing cookies, whose long values say nothing about a session. */
const ANALYTICS_NAME = /^(_ga|_gid|_gcl|_fbp|_fbc|_hj|_pk_|_uet|_clck|_clsk|ajs_|amp_|mp_|optimizely|intercom|hubspot|__hs)/i;
const JWT = /^(Bearer\s+)?eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** A token inside a JSON value: what a sign-in library stores beside the user it signed in. */
const JSON_TOKEN = /"(access_?token|id_?token|refresh_?token|token|jwt)"\s*:\s*"[^"]{8,}"/i;
/** An opaque random-looking value: long, one token, from the alphabets session ids are written in. */
const OPAQUE = /^[A-Za-z0-9+/=_.%:-]{20,}$/;

/**
 * This value looks like a session credential. A JWT always does and a JSON
 * value does when it carries a token, whatever their names; otherwise the
 * name decides, and a long opaque value under a name that says nothing.
 */
export function looksLikeCredential(h: Pick<HeldValue, "name" | "value">): boolean {
  if (h.value === "") return false;
  if (ANALYTICS_NAME.test(h.name)) return false;
  if (JWT.test(h.value)) return true;
  if (/^\s*[{[]/.test(h.value)) return JSON_TOKEN.test(h.value);
  if (NOT_CREDENTIAL_NAME.test(h.name)) return false;
  if (CREDENTIAL_NAME.test(h.name)) return true;
  return OPAQUE.test(h.value);
}

/** The first value held now that was not held when the window opened, or held a different value, and looks like a session. */
export function newCredential(watch: Pick<SignInWatch, "baseline">, held: readonly HeldValue[]): HeldValue | null {
  for (const h of held) {
    if (watch.baseline.get(h.key) === h.value) continue;
    if (looksLikeCredential(h)) return h;
  }
  return null;
}

/**
 * Steps of a sign-in that can show no field: approving a push on a phone, a
 * second factor's challenge, choosing an account or a tenant. An app often
 * holds a partial session by then, so the path is what says it is not done.
 */
const SIGN_IN_STEP_RE = /\/(log-in|mfa|2fa|otp|verify|challenge|select-account|choose-account|account-picker)(\/|$)/;

/** The path is a sign-in route (/login, /signin, /auth/..., /mfa, /verify, an account picker). */
export function signInRoute(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return LOGIN_ROUTE_RE.test(path) || SIGN_IN_STEP_RE.test(path);
  } catch {
    return false;
  }
}

/**
 * Judge one look. Returns the watch to carry to the next look and the
 * verdict; signed-in only once STABLE_LOOKS looks in a row at one address
 * read that way.
 */
export function judgeSignIn(watch: SignInWatch, look: SignInLook): { watch: SignInWatch; verdict: SignInVerdict } {
  const waiting = (reason: WaitReason, sawSignIn = watch.sawSignIn): { watch: SignInWatch; verdict: SignInVerdict } => ({
    watch: { ...watch, sawSignIn, candidate: null },
    verdict: { kind: "waiting", reason },
  });
  const app = onApp(watch, look.url);
  // An absolute success URL may be anywhere; a path is only looked for on the app.
  const successAbsolute = watch.successUrl !== undefined && /^https?:\/\//i.test(watch.successUrl);
  if (!app && !(successAbsolute && urlMatches(look.url, watch.successUrl!))) {
    // about:blank before the first page loads is nowhere, not another site.
    return originOf(look.url) === null ? waiting("not-started") : waiting("away", true);
  }
  if (look.popupAway) return waiting("popup", true);
  if (look.signInField) return waiting("sign-in-screen", true);
  if (isAuthReturn(look.url)) return waiting("returning", true);
  if (signInRoute(look.url)) return waiting("sign-in-screen", true);
  let via: Extract<SignInVerdict, { kind: "signed-in" }>;
  if (watch.successUrl !== undefined) {
    if (!urlMatches(look.url, watch.successUrl)) return waiting("no-session");
    // A success URL the first page already matches (a path such as "/") is not a sign-in until one has been seen.
    if (!watch.sawSignIn) return waiting("not-started");
    via = { kind: "signed-in", via: "success-url" };
  } else {
    const credential = newCredential(watch, look.held);
    if (!credential) return waiting(watch.sawSignIn ? "no-session" : "not-started");
    if (!watch.sawSignIn) return waiting("not-started");
    via = {
      kind: "signed-in",
      via: "credential",
      credential: `${credential.kind === "cookie" ? "cookie" : credential.kind === "local" ? "localStorage" : "sessionStorage"} "${credential.name}"`,
    };
  }
  const looks = watch.candidate?.url === look.url ? watch.candidate.looks + 1 : 1;
  const next: SignInWatch = { ...watch, candidate: { url: look.url, looks } };
  if (looks < STABLE_LOOKS) return { watch: next, verdict: { kind: "waiting", reason: "settling" } };
  return { watch: next, verdict: via };
}

/** What an interactive login saves on: `auto` when sign-in is detected or Enter is pressed, `enter` on Enter alone. */
export const SAVE_MODES = ["auto", "enter"] as const;
export type SaveMode = (typeof SAVE_MODES)[number];
export const DEFAULT_SAVE_MODE: SaveMode = "auto";

/**
 * The sign-in windows scout_login has open, one per project and role, so a
 * second call waits on the window the first one opened. A window that has
 * finished is kept, with its outcome, until a call has reported it: a sign-in
 * that ends between two calls is reported by the next one rather than lost
 * behind a fresh window. An outcome nobody asks for within `keepMs` is
 * dropped, so a call long after starts over.
 */
export class LoginWindows<T extends { done: Promise<unknown> }> {
  private readonly open = new Map<string, { window: T; settledAt?: number }>();

  constructor(
    private readonly keepMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The window for `key`: the open one, a finished one not yet reported, or a new one from `start`. */
  async get(key: string, start: () => Promise<T>): Promise<{ window: T; resumed: boolean }> {
    const held = this.open.get(key);
    if (held && (held.settledAt === undefined || this.now() - held.settledAt <= this.keepMs)) return { window: held.window, resumed: true };
    const window = await start();
    const entry: { window: T; settledAt?: number } = { window };
    this.open.set(key, entry);
    void window.done.then(
      () => (entry.settledAt = this.now()),
      () => (entry.settledAt = this.now()),
    );
    return { window, resumed: false };
  }

  /** A call has reported this window's outcome: the next call for `key` opens a new one. */
  reported(key: string, window: T): void {
    if (this.open.get(key)?.window === window) this.open.delete(key);
  }

  /** Every window still held, for shutdown. */
  all(): T[] {
    return [...this.open.values()].map((e) => e.window);
  }
}
