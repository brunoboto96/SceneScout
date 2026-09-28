/**
 * How long a saved sign-in profile will last, read from the profile itself:
 * each cookie's `expires`, and the `exp` claim of any JWT found in a cookie
 * value or a localStorage value. A JWT's payload is decoded to read `exp` and
 * nothing else; its signature is never checked (there is no key to check it
 * with, and nothing here trusts it), and no token value is ever returned,
 * printed or logged — only the name of the cookie or storage key it was in.
 *
 * Used twice: `scenescout login` says how long the profile it just saved will
 * last, and scout_lane_brief refuses to hand out lanes that attach by a role
 * whose profile will not outlast the run.
 *
 * The verdict refuses only when it is certain. A profile holds more than the
 * sign-in: analytics cookies that expire in a minute, preference cookies that
 * last a year. So the profile counts as lasting until its LAST dated
 * credential expires, and a session cookie with no date (it lives until the
 * browser closes, and the server decides when it stops working) means the
 * end is unknown. The first credential to expire is still reported, as a
 * warning when it falls inside the run.
 *
 * Playwright-free and table-tested in profiles-test.
 */
import fs from "node:fs";
import { sayDuration } from "./pace.js";

/** Where a dated credential was found. */
export type CredentialSource = "cookie" | "cookie-jwt" | "local-storage-jwt";

/** One credential the profile holds, by name only. `expiresAt` is epoch ms, or null for a session cookie with no date. */
export interface Credential {
  source: CredentialSource;
  name: string;
  expiresAt: number | null;
}

/** What a profile says about its own lifetime. */
export interface ProfileLifetime {
  credentials: Credential[];
  /** Dated credentials, soonest first. */
  dated: Credential[];
  /** Credentials with no date: session cookies holding no dated JWT, and JWTs with no readable `exp` (a refresh token often has none). */
  undated: number;
  /** Cookies left out because they are not sent to the app's host (another subdomain, an identity provider). One may still keep the sign-in alive, so any means the end is not certain. */
  elsewhere: number;
  /** JWT-shaped values whose payload could not be read or had no numeric `exp`. */
  unreadableTokens: number;
}

/** Default run length the lane check assumes when the planner names none. */
export const DEFAULT_RUN_MINUTES = 60;
/** Default slack past the run's end a profile must still last, so a lane is not signed out while writing its report. */
export const DEFAULT_EXPIRY_MARGIN_MINUTES = 10;

/** A JWT: three base64url parts, the first two starting with `{"` (eyJ). */
const JWT_RE = /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;
/** Longest value scanned for tokens; a larger one is skipped rather than searched. */
const MAX_SCAN_CHARS = 64 * 1024;
/** Most tokens read out of one value. */
const MAX_TOKENS_PER_VALUE = 8;

/** The `exp` of a JWT in epoch ms, or null when the payload cannot be read or has none. Never verifies the signature. */
export function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  return exp * 1000;
}

/** Every JWT expiry in a value, and how many JWT-shaped strings in it had none readable. URL-encoded values are decoded first. */
function tokenExpiries(raw: string): { expiries: number[]; unreadable: number } {
  if (raw.length > MAX_SCAN_CHARS) return { expiries: [], unreadable: 0 };
  let value = raw;
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding: scan it as it is.
    }
  }
  const found = (value.match(JWT_RE) ?? []).slice(0, MAX_TOKENS_PER_VALUE);
  const expiries: number[] = [];
  let unreadable = 0;
  for (const token of found) {
    const at = jwtExpiry(token);
    if (at === null) unreadable += 1;
    else expiries.push(at);
  }
  return { expiries, unreadable };
}

/** Whether a cookie set for `domain` is sent to `host`, per the cookie domain-match rule. */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Read every credential a storage state holds. With `url`, only cookies sent
 * to its host and localStorage of its origin count: the rest belong to other
 * sites the sign-in passed through (an identity provider, say) and do not
 * sign the app in.
 */
export function readLifetime(state: unknown, opts: { url?: string } = {}): ProfileLifetime {
  const s = (state && typeof state === "object" ? state : {}) as { cookies?: unknown; origins?: unknown };
  let target: URL | undefined;
  if (opts.url) {
    try {
      target = new URL(opts.url);
    } catch {
      target = undefined;
    }
  }
  const credentials: Credential[] = [];
  let unreadableTokens = 0;
  let elsewhere = 0;

  for (const c of Array.isArray(s.cookies) ? s.cookies : []) {
    if (!c || typeof c !== "object") continue;
    const cookie = c as { name?: unknown; value?: unknown; domain?: unknown; expires?: unknown };
    if (typeof cookie.name !== "string") continue;
    if (target && typeof cookie.domain === "string" && !cookieMatchesHost(cookie.domain, target.hostname)) {
      elsewhere += 1;
      continue;
    }
    const dated = typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0 ? cookie.expires * 1000 : null;
    const tokens = typeof cookie.value === "string" ? tokenExpiries(cookie.value) : { expiries: [], unreadable: 0 };
    unreadableTokens += tokens.unreadable;
    if (tokens.expiries.length > 0) {
      // The cookie stops working at whichever comes first: the browser
      // dropping it, or the server refusing the token inside it.
      const jwtAt = Math.min(...tokens.expiries);
      const at = dated === null ? jwtAt : Math.min(dated, jwtAt);
      credentials.push({ source: at === dated ? "cookie" : "cookie-jwt", name: cookie.name, expiresAt: at });
    } else {
      credentials.push({ source: "cookie", name: cookie.name, expiresAt: dated });
    }
  }

  for (const o of Array.isArray(s.origins) ? s.origins : []) {
    if (!o || typeof o !== "object") continue;
    const origin = o as { origin?: unknown; localStorage?: unknown };
    if (target && origin.origin !== target.origin) continue;
    for (const item of Array.isArray(origin.localStorage) ? origin.localStorage : []) {
      if (!item || typeof item !== "object") continue;
      const entry = item as { name?: unknown; value?: unknown };
      if (typeof entry.name !== "string" || typeof entry.value !== "string") continue;
      // A localStorage entry with no token in it is not a credential this can
      // date (most are preferences), so it is not counted at all.
      const tokens = tokenExpiries(entry.value);
      unreadableTokens += tokens.unreadable;
      if (tokens.expiries.length > 0) credentials.push({ source: "local-storage-jwt", name: entry.name, expiresAt: Math.min(...tokens.expiries) });
      // A token with no readable expiry (a refresh token often has none) may
      // keep the sign-in alive past every dated one: undated, not ignored.
      else if (tokens.unreadable > 0) credentials.push({ source: "local-storage-jwt", name: entry.name, expiresAt: null });
    }
  }

  const dated = credentials.filter((c) => c.expiresAt !== null).sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number));
  return { credentials, dated, undated: credentials.length - dated.length, elsewhere, unreadableTokens };
}

/** A span as a person says it; days past two, since "73h00m" reads badly. */
export function sayLifetime(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  return days >= 2 ? `${days} days` : sayDuration(ms);
}

function describeCredential(c: Credential): string {
  const where = c.source === "cookie" ? "cookie" : c.source === "cookie-jwt" ? "token in cookie" : "token in localStorage";
  return `${where} "${c.name.slice(0, 60)}"`;
}

/**
 * The line `scenescout login` prints after saving: how long the profile will
 * last, and what that is read from. Names only, never values.
 */
export function describeLifetime(life: ProfileLifetime, now: number): string {
  const live = life.dated.filter((c) => (c.expiresAt as number) > now);
  const last = live.at(-1);
  const first = live[0];
  const undatedNote =
    life.undated > 0
      ? `${life.undated} credential${life.undated === 1 ? "" : "s"} with no date (a session cookie, or a token with no expiry; the server decides when ${life.undated === 1 ? "it stops" : "they stop"} working)`
      : "";
  if (!last) {
    if (life.dated.length > 0 && life.undated === 0)
      return "Lasts: every dated credential in it has already expired, so it is unlikely to sign anyone in. Sign in again.";
    if (life.undated > 0)
      return `Lasts: unknown — ${life.dated.length > 0 ? "its dated credentials have already expired, leaving" : "no expiry found, only"} ${undatedNote}.`;
    return "Lasts: unknown — no cookie or token with an expiry was found in it.";
  }
  const lastIn = sayLifetime((last.expiresAt as number) - now);
  let line =
    life.undated > 0
      ? `Lasts: unknown — the last dated credential, ${describeCredential(last)}, ends in ${lastIn}, but it also holds ${undatedNote}.`
      : `Lasts: about ${lastIn} (the last dated credential, ${describeCredential(last)}).`;
  if (first && first !== last) line += ` The first to expire is ${describeCredential(first)}, in ${sayLifetime((first.expiresAt as number) - now)}.`;
  return line;
}

/** Whether a profile will last a run: fine, fine with a caveat, unknown, or not (refused). */
export type LifetimeVerdict = { kind: "ok" } | { kind: "warn"; message: string } | { kind: "unknown"; message: string } | { kind: "refuse"; message: string };

/**
 * Judge a profile against a run of `runMs` plus `marginMs`. Refused only when
 * every credential it holds is dated, no cookie for another host was left
 * out, and the last of them ends before the run does; see the header for why the last and not the first. `rerun` is the
 * command that records the profile again.
 */
export function judgeLifetime(life: ProfileLifetime, opts: { now: number; runMs: number; marginMs: number; role: string; rerun: string }): LifetimeVerdict {
  const needUntil = opts.now + opts.runMs + opts.marginMs;
  const needs = `a run of ${sayLifetime(opts.runMs)} plus ${sayLifetime(opts.marginMs)} margin`;
  const redo = `Run \`${opts.rerun}\` again, sign in, then plan the lanes again.`;
  if (life.dated.length === 0) {
    return {
      kind: "unknown",
      message: `No expiry was found in the saved sign-in for role "${opts.role}"${life.undated > 0 ? " (only credentials with no date)" : ""}, so whether it lasts the run is unknown. If lanes start landing on the sign-in page, run \`${opts.rerun}\` again.`,
    };
  }
  const last = life.dated.at(-1) as Credential;
  const first = life.dated[0];
  const lastAt = last.expiresAt as number;
  // Certain only when every credential the app is sent is dated and nothing
  // was left out that could still be keeping the sign-in alive.
  const certain = life.undated === 0 && life.elsewhere === 0;
  if (certain && lastAt <= opts.now) {
    return {
      kind: "refuse",
      message: `The saved sign-in for role "${opts.role}" has expired: every dated credential in it ended, the last ${sayLifetime(opts.now - lastAt)} ago. ${redo}`,
    };
  }
  if (certain && lastAt < needUntil) {
    return {
      kind: "refuse",
      message: `The saved sign-in for role "${opts.role}" will not last the run: it ends in ${sayLifetime(lastAt - opts.now)} (${describeCredential(last)}), and the lanes need ${needs}. ${redo} (A shorter run or a smaller margin can be passed as runMinutes / expiryMarginMinutes.)`,
    };
  }
  if ((first.expiresAt as number) < needUntil) {
    const firstAt = first.expiresAt as number;
    const when = firstAt <= opts.now ? `expired ${sayLifetime(opts.now - firstAt)} ago` : `expires in ${sayLifetime(firstAt - opts.now)}`;
    return {
      kind: "warn",
      message: `In the saved sign-in for role "${opts.role}", ${describeCredential(first)} ${when}, inside ${needs}. It is not the only credential, so the sign-in may outlast it; if lanes start landing on the sign-in page, run \`${opts.rerun}\` again.`,
    };
  }
  return { kind: "ok" };
}

/** Read a profile file and judge it. A file that cannot be read or parsed is thrown: attach would fail on it too. */
export function judgeProfileFile(
  file: string,
  opts: { url?: string; now: number; runMs: number; marginMs: number; role: string; rerun: string },
  read: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): LifetimeVerdict {
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`the saved sign-in for role "${opts.role}" could not be read (${code}); run \`${opts.rerun}\` again`);
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    // The parser's message quotes the text around the fault, and the text is a live session: say only that it is not JSON.
    throw new Error(`the saved sign-in for role "${opts.role}" is not valid JSON; run \`${opts.rerun}\` again`);
  }
  return judgeLifetime(readLifetime(state, { url: opts.url }), opts);
}
