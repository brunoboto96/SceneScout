/**
 * The refresh broker: one role's stored refresh token, presented by one
 * session at a time.
 *
 * Every session attached by the same role loads the same saved profile, so
 * every one of them holds the same refresh token. An app that rotates refresh
 * tokens with reuse detection treats a second presentation of a spent token as
 * theft and revokes the whole token family — every session of that role is
 * then signed out at once. The broker stops that: when a session's page is
 * about to send the role's refresh token, it first takes a lock next to the
 * profile. Holding it, the session re-reads the profile; if another session
 * has already rotated the token, it loads the rotated profile and sends the
 * current token in place of the spent one. When the response arrives and the
 * page has stored what it got back, the session writes its state over the
 * profile and releases the lock. No two sessions ever present one token.
 *
 * Sessions may be separate processes (one MCP server per lane) sharing the
 * profile on disk, so the lock is a file, created exclusively, owner-only,
 * and taken over only once it has gone stale.
 *
 * Everything here is Playwright-free so it can be table-tested; the browser
 * half — spotting the request and swapping the token on the wire — is in
 * browser.ts. No function here returns, logs or prints a token's value:
 * slots are named by where the token lives, never by what it is.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

// ── Where a refresh token lives in a profile ─────────────────────────────────

/** Cookie names, storage keys and JSON field names that hold a refresh token. */
export const REFRESH_NAME_RE = /refresh/i;

/**
 * The shortest value treated as a token. A real refresh token is long and
 * random; a short value ("1", "true") would match unrelated requests.
 */
export const MIN_TOKEN_LENGTH = 16;

/** How deep inside a JSON-valued storage entry a refresh-token field is looked for. */
const MAX_JSON_DEPTH = 4;

/**
 * One refresh token in a profile. `slot` names where it lives — a cookie, or a
 * storage key and the field inside it — so the same slot can be compared
 * across two versions of a profile. `value` is the token; it is never printed.
 */
export interface TokenSlot {
  slot: string;
  value: string;
}

interface CookieShape {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
}

interface OriginShape {
  origin?: unknown;
  localStorage?: Array<{ name?: unknown; value?: unknown }>;
}

function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_TOKEN_LENGTH && !/\s/.test(value);
}

/** Refresh-token fields inside a JSON value, by dotted path. */
function jsonFields(value: unknown, at: string, depth: number, out: Array<{ path: string; value: string }>): void {
  if (depth > MAX_JSON_DEPTH || !value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const here = at ? `${at}.${key}` : key;
    if (REFRESH_NAME_RE.test(key) && looksLikeToken(inner)) out.push({ path: here, value: inner });
    else jsonFields(inner, here, depth + 1, out);
  }
}

/**
 * The refresh tokens a storage state holds: cookies named for one, storage
 * entries named for one, and fields named for one inside a JSON-valued
 * storage entry (an app that keeps `{ accessToken, refreshToken }` under one
 * key). Anything that is not a storage state yields none.
 */
export function refreshTokenSlots(state: unknown): TokenSlot[] {
  if (!state || typeof state !== "object") return [];
  const s = state as { cookies?: unknown; origins?: unknown };
  const out: TokenSlot[] = [];
  if (Array.isArray(s.cookies)) {
    for (const c of s.cookies as CookieShape[]) {
      if (typeof c?.name === "string" && REFRESH_NAME_RE.test(c.name) && looksLikeToken(c.value)) {
        out.push({ slot: `cookie ${c.name} (${String(c.domain ?? "")}${String(c.path ?? "")})`, value: c.value });
      }
    }
  }
  if (Array.isArray(s.origins)) {
    for (const o of s.origins as OriginShape[]) {
      if (!Array.isArray(o?.localStorage)) continue;
      for (const item of o.localStorage) {
        if (typeof item?.name !== "string" || typeof item.value !== "string") continue;
        const where = `storage ${String(o.origin ?? "")} ${item.name}`;
        if (REFRESH_NAME_RE.test(item.name) && looksLikeToken(item.value)) {
          out.push({ slot: where, value: item.value });
          continue;
        }
        if (!/^\s*[{[]/.test(item.value)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(item.value);
        } catch {
          continue; // a storage value that only looks like JSON holds no field to find
        }
        const fields: Array<{ path: string; value: string }> = [];
        jsonFields(parsed, "", 0, fields);
        for (const f of fields) out.push({ slot: `${where} → ${f.path}`, value: f.value });
      }
    }
  }
  return out;
}

/** The forms a token can take on the wire: as is, and percent-encoded in a form body or query. */
function wireForms(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return encoded === value ? [value] : [value, encoded];
}

/** A request as the broker reads it: its body and headers, never its response. */
export interface WireRequest {
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

/**
 * The known refresh token a request carries — in its body, a header (a Cookie
 * header included) or its URL — or null. `known` is what the session last
 * loaded from the profile; a token the page got some other way is not the
 * role's and is left alone.
 */
export function presentedToken(req: WireRequest, known: readonly TokenSlot[]): TokenSlot | null {
  if (known.length === 0) return null;
  const haystacks = [req.body ?? "", req.url, ...Object.values(req.headers)];
  for (const t of known) {
    for (const form of wireForms(t.value)) {
      if (haystacks.some((h) => h.includes(form))) return t;
    }
  }
  return null;
}

/**
 * What a session holding the lock does with the token its page is about to
 * send, given the profile as it is on disk now:
 * - `send`: the profile still holds it — nobody rotated it, so this session
 *   is the one that refreshes.
 * - `swap`: another session rotated it while this one waited. Load the
 *   profile, and send the current token in place of the spent one.
 * - `unknown`: the profile no longer has that slot at all (signed in again
 *   as something else, or the app moved the token). Send it as is: the
 *   broker cannot know what would be current. Nothing is written back, so
 *   a login saved since is not overwritten by this session's state.
 */
export type RefreshPlan = { kind: "send" } | { kind: "swap"; to: TokenSlot } | { kind: "unknown" };

export function planRefresh(sent: TokenSlot, current: readonly TokenSlot[]): RefreshPlan {
  if (current.some((c) => c.value === sent.value)) return { kind: "send" };
  const same = current.find((c) => c.slot === sent.slot);
  return same ? { kind: "swap", to: same } : { kind: "unknown" };
}

/** Replace a spent token with the current one in a body, URL or header value, in whichever wire form it appears. */
export function swapToken(text: string, from: string, to: string): string {
  let out = text.split(from).join(to);
  const fromEnc = encodeURIComponent(from);
  if (fromEnc !== from) out = out.split(fromEnc).join(encodeURIComponent(to));
  return out;
}

/** Apply a swap to a whole request: the parts that changed, and nothing else. */
export function swapRequest(req: WireRequest, from: string, to: string): { url?: string; body?: string; headers?: Record<string, string> } {
  const out: { url?: string; body?: string; headers?: Record<string, string> } = {};
  const url = swapToken(req.url, from, to);
  if (url !== req.url) out.url = url;
  if (req.body !== null) {
    const body = swapToken(req.body, from, to);
    if (body !== req.body) out.body = body;
  }
  let headersChanged = false;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = swapToken(v, from, to);
    if (headers[k] !== v) headersChanged = true;
  }
  if (headersChanged) out.headers = headers;
  return out;
}

/**
 * Whether the page has stored the rotation it was sent: the slot the token
 * was sent from now holds a different token. Until then, writing the state
 * back would save the spent token for every other session to present.
 */
export function rotationStored(state: unknown, sent: TokenSlot): boolean {
  const now = refreshTokenSlots(state).find((t) => t.slot === sent.slot);
  return now !== undefined && now.value !== sent.value;
}

/**
 * The rotated refresh token a refresh response carries, for a page that did
 * not store it in time: a refresh-named field in a JSON body, else a
 * refresh-named Set-Cookie. Null when neither names exactly one; guessing
 * between two would save the wrong one.
 */
export function rotatedFromResponse(body: string, setCookies: readonly string[]): string | null {
  const found = new Set<string>();
  try {
    const fields: Array<{ path: string; value: string }> = [];
    jsonFields(JSON.parse(body), "", 0, fields);
    for (const f of fields) found.add(f.value);
  } catch {
    // Not a JSON body: the Set-Cookie headers are all there is to read.
  }
  if (found.size === 0) {
    for (const line of setCookies) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (REFRESH_NAME_RE.test(name) && looksLikeToken(value)) found.add(value);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** A copy of a storage state with one token replaced wherever it is held: a cookie's value, or inside a storage entry. */
export function swapProfileToken(state: unknown, from: string, to: string): unknown {
  const s = JSON.parse(JSON.stringify(state)) as { cookies?: CookieShape[]; origins?: OriginShape[] };
  for (const c of s.cookies ?? []) if (c.value === from) c.value = to;
  for (const o of s.origins ?? []) {
    for (const item of o.localStorage ?? []) if (typeof item.value === "string") item.value = swapToken(item.value, from, to);
  }
  return s;
}

// ── Whether the broker runs ──────────────────────────────────────────────────

export const REFRESH_BROKER_ENV = "SCENESCOUT_REFRESH_BROKER";

/**
 * Whether a session brokers its role's refresh token. On by default for a
 * session attached by role; SCENESCOUT_REFRESH_BROKER=off turns it off, and
 * any other value than on/off is refused rather than guessed at. An explicit
 * attach option wins over the environment.
 */
export function brokerEnabled(opts: { roleSession: boolean; option?: boolean; env?: string }): boolean {
  if (!opts.roleSession) return false;
  if (opts.option !== undefined) return opts.option;
  const raw = opts.env?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`${REFRESH_BROKER_ENV} must be "on" or "off" (got "${opts.env!.slice(0, 20)}")`);
}

// ── The lock ─────────────────────────────────────────────────────────────────

/** Owner read/write only, like the profile it guards. */
export const LOCK_FILE_MODE = 0o600;

/** A lock untouched this long is taken to belong to a process that died holding it. */
export const DEFAULT_STALE_MS = 30_000;

/** How long a session waits for the lock before it gives up and says so. */
export const DEFAULT_WAIT_MS = 45_000;

/** The lock file for a profile: beside it, so it shares the profile's owner-only directory. */
export function lockPathFor(profileFile: string): string {
  return `${profileFile}.lock`;
}

/** Whether a lock last touched at `mtimeMs` is stale at `now`. */
export function isStale(mtimeMs: number, now: number, staleMs: number): boolean {
  return now - mtimeMs > staleMs;
}

export interface HeldLock {
  path: string;
  /** Random, and written into the file, so a release never removes a lock another process took over. */
  nonce: string;
  release(): void;
}

export interface LockOptions {
  staleMs?: number;
  waitMs?: number;
  /** Poll interval, jittered. */
  pollMs?: number;
  now?: () => number;
}

function readNonce(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { nonce?: unknown };
    return typeof parsed.nonce === "string" ? parsed.nonce : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Half-written by its creator, or not ours: no nonce to compare.
    if (err instanceof SyntaxError) return "";
    throw err;
  }
}

/** One attempt: the lock, or null when another process holds a live one. */
export function tryAcquireLock(file: string, opts: { staleMs?: number; now?: () => number } = {}): HeldLock | null {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = opts.now ?? Date.now;
  const nonce = crypto.randomBytes(12).toString("hex");
  try {
    const fd = fs.openSync(file, "wx", LOCK_FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: now(), nonce }));
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === "ENOENT") return null; // released between the two calls: try again next poll
      throw statErr;
    }
    if (!isStale(mtimeMs, now(), staleMs)) return null;
    // Take over a stale lock by moving it aside under a name only this attempt
    // uses, then judging the file that was actually moved: if another waiter
    // took the stale lock over first, what was moved is its fresh lock, whose
    // time is recent, and it goes straight back.
    const aside = `${file}.${nonce}.stale`;
    try {
      fs.renameSync(file, aside);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw renameErr;
    }
    if (!isStale(fs.statSync(aside).mtimeMs, now(), staleMs)) {
      try {
        fs.linkSync(aside, file);
      } catch (linkErr) {
        // A third process took the free name meanwhile. Two locks now exist for a
        // moment; the one moved aside can only be dropped, and its holder's
        // release finds a nonce not its own and leaves the new lock alone.
        if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") throw linkErr;
      }
      fs.rmSync(aside, { force: true });
      return null;
    }
    fs.rmSync(aside, { force: true });
    return tryAcquireLock(file, opts);
  }
  return {
    path: file,
    nonce,
    release() {
      // Only our own lock: one taken over as stale belongs to someone else now.
      if (readNonce(file) === nonce) fs.rmSync(file, { force: true });
    },
  };
}

/**
 * Wait for the lock. While it is held, its file is touched regularly so a
 * long refresh is never mistaken for a dead holder; the returned release
 * stops that. Throws after `waitMs` with a message that names the lock file.
 */
export async function acquireLock(file: string, opts: LockOptions = {}): Promise<HeldLock> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? 25;
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  for (;;) {
    const held = tryAcquireLock(file, { staleMs, now });
    if (held) {
      const beat = setInterval(
        () => {
          try {
            if (readNonce(file) === held.nonce) fs.utimesSync(file, new Date(), new Date());
          } catch {
            /* the lock was released or taken over; the next beat is cleared by release */
          }
        },
        Math.max(50, Math.floor(staleMs / 3)),
      );
      beat.unref();
      const release = held.release;
      return {
        ...held,
        release() {
          clearInterval(beat);
          release();
        },
      };
    }
    if (now() >= deadline) {
      throw new Error(
        `timed out after ${waitMs} ms waiting for the refresh lock at ${file}; another session is refreshing, or a stale lock is not yet ${staleMs} ms old`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs + Math.floor(Math.random() * pollMs)));
  }
}
