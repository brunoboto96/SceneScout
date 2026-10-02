/**
 * The refresh broker's rules: which values in a profile are refresh tokens,
 * when a request is carrying one, what a session holding the lock does with
 * it, how a spent token is swapped for the current one on the wire, when the
 * page has stored a rotation, and the lock itself — exclusive across real
 * processes, owner-only, taken over only when stale.
 *
 *   npx tsx --test scripts/refresh-test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  brokerEnabled,
  isStale,
  lockPathFor,
  LOCK_FILE_MODE,
  MIN_TOKEN_LENGTH,
  brokerDecision,
  cookieMayCount,
  endpointKey,
  endpointsPathFor,
  headersForResend,
  isStaticAsset,
  learnableEndpoint,
  lockCreateError,
  MAX_LEARNED_ENDPOINTS,
  planRefresh,
  profileAfterRotation,
  readLearnedEndpoints,
  refreshLikePath,
  rotatedCookies,
  tokenPresence,
  withLearnedEndpoint,
  writeLearnedEndpoints,
  refreshTokenSlots,
  rotatedFromResponse,
  rotationStored,
  swapProfileToken,
  swapRequest,
  swapToken,
  tryAcquireLock,
} from "../src/engine/refresh.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const POSIX = process.platform !== "win32";
const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-refresh-"));

const R1 = "rt_AAAAAAAAAAAAAAAAAAAAAAAA1";
const R2 = "rt_BBBBBBBBBBBBBBBBBBBBBBBB2";
const A1 = "at_CCCCCCCCCCCCCCCCCCCCCCCC1";
const ORIGIN = "http://127.0.0.1:3000";

const stateWith = (refresh: string, access = A1) => ({
  cookies: [
    { name: "sid", value: "session-cookie-value-long", domain: "127.0.0.1", path: "/" },
    { name: "refresh_token", value: `${refresh}c`, domain: "127.0.0.1", path: "/auth" },
  ],
  origins: [
    {
      origin: ORIGIN,
      localStorage: [
        { name: "session", value: JSON.stringify({ accessToken: access, refreshToken: refresh, user: { id: 7 } }) },
        { name: "theme", value: "dark" },
      ],
    },
  ],
});

test("a profile's refresh tokens are found by name, in cookies, storage keys and JSON storage fields", () => {
  const slots = refreshTokenSlots(stateWith(R1));
  assert.deepEqual(
    slots.map((s) => s.slot),
    ["cookie refresh_token (127.0.0.1/auth)", `storage ${ORIGIN} session → refreshToken`],
  );
  assert.deepEqual(
    slots.map((s) => s.value),
    [`${R1}c`, R1],
  );
  // A plain storage key named for it, and a nested field.
  const flat = { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "refresh", value: R2 }] }] };
  assert.deepEqual(refreshTokenSlots(flat), [{ slot: `storage ${ORIGIN} refresh`, value: R2 }]);
  const nested = { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "auth", value: JSON.stringify({ tokens: { refresh_token: R2 } }) }] }] };
  assert.deepEqual(
    refreshTokenSlots(nested).map((s) => s.slot),
    [`storage ${ORIGIN} auth → tokens.refresh_token`],
  );
});

test("short values, whitespace, access tokens and non-states are not refresh tokens", () => {
  const short = { cookies: [{ name: "refresh", value: "x".repeat(MIN_TOKEN_LENGTH - 1) }], origins: [] };
  assert.deepEqual(refreshTokenSlots(short), []);
  const spaced = { cookies: [{ name: "refresh", value: "a sentence that is long enough" }], origins: [] };
  assert.deepEqual(refreshTokenSlots(spaced), []);
  const accessOnly = { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "session", value: JSON.stringify({ accessToken: A1 }) }] }] };
  assert.deepEqual(refreshTokenSlots(accessOnly), []);
  const brokenJson = { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "session", value: "{not json" }] }] };
  assert.deepEqual(refreshTokenSlots(brokenJson), []);
  for (const bad of [null, undefined, 42, "state", { cookies: "x" }]) assert.deepEqual(refreshTokenSlots(bad), []);
  // An address kept under a refresh-named key is where the app refreshes, not a token: every request to it would seem to carry it.
  const addresses = {
    cookies: [],
    origins: [
      {
        origin: ORIGIN,
        localStorage: [
          { name: "refresh_url", value: "/api/auth/refresh" },
          { name: "refreshEndpoint", value: "https://id.example.test/oauth/token" },
        ],
      },
    ],
  };
  assert.deepEqual(refreshTokenSlots(addresses), []);
});

test("a request carries a known token in its body, its URL, a header the page set, or only its Cookie header", () => {
  const known = refreshTokenSlots(stateWith(R1));
  const bare = { url: `${ORIGIN}/auth/token`, body: null, headers: {} };
  const where = (req: { url: string; body: string | null; headers: Record<string, string> }) => {
    const found = tokenPresence(req, known);
    return found && { value: found.slot.value, via: found.via };
  };
  assert.deepEqual(where({ ...bare, body: JSON.stringify({ refresh_token: R1 }) }), { value: R1, via: "body" });
  assert.deepEqual(where({ ...bare, url: `${ORIGIN}/auth/token?rt=${R1}` }), { value: R1, via: "url" });
  assert.deepEqual(where({ ...bare, headers: { "x-refresh-token": R1 } }), { value: R1, via: "header" });
  assert.deepEqual(where({ ...bare, headers: { Cookie: `sid=x; refresh_token=${R1}c` } }), { value: `${R1}c`, via: "cookie" });
  // The browser adds Cookie, Referer and Origin itself: a token in them was not sent by the page.
  assert.deepEqual(where({ ...bare, headers: { referer: `${ORIGIN}/cb?rt=${R1}`, cookie: "sid=x" } }), null);
  // Explicit wins over the cookie riding along.
  assert.deepEqual(where({ ...bare, body: `t=${R1}`, headers: { cookie: `refresh_token=${R1}c` } }), { value: R1, via: "body" });
  const odd = "rt+with/slashes=and+plus==";
  const oddFound = tokenPresence({ ...bare, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(odd)}` }, [{ slot: "s", value: odd }]);
  assert.equal(oddFound?.slot.value, odd);
  // Nothing known, or a request carrying something else: not a refresh.
  assert.equal(tokenPresence({ ...bare, body: JSON.stringify({ refresh_token: R2 }) }, known), null);
  assert.equal(tokenPresence({ ...bare, body: JSON.stringify({ refresh_token: R1 }) }, []), null);
  assert.equal(tokenPresence({ ...bare, headers: { authorization: `Bearer ${A1}` } }, known), null);
});

/** A role whose refresh token is only a cookie scoped to "/", as many single-page apps keep it. */
const ROOT_COOKIE = [{ slot: "cookie rt (app.example.test/)", value: R1, cookie: "rt" }];
const withCookie = { cookie: `sid=abc; rt=${R1}` };
const decide = (
  method: string,
  url: string,
  resourceType: string,
  opts: { body?: string | null; headers?: Record<string, string>; learned?: string[] } = {},
) => {
  const d = brokerDecision(
    { method, url: `${ORIGIN}${url}`, resourceType, body: opts.body ?? null, headers: opts.headers ?? withCookie },
    ROOT_COOKIE,
    new Set(opts.learned ?? []),
  );
  return d.kind === "broker" ? `broker via ${d.via}` : `pass: ${d.why}`;
};

test("a refresh cookie scoped to '/' alone never makes a request a refresh: scripts, styles, images, pages and API GETs pass", () => {
  for (const [method, url, type] of [
    ["GET", "/assets/app.js", "script"],
    ["GET", "/assets/app.css", "stylesheet"],
    ["GET", "/logo.png", "image"],
    ["GET", "/fonts/a.woff2", "font"],
    ["GET", "/dashboard", "document"],
    ["GET", "/api/items", "fetch"],
    ["GET", "/api/auth/refresh", "fetch"],
    ["POST", "/api/items", "fetch"],
    ["POST", "/api/auth/login", "fetch"],
    ["DELETE", "/api/token", "fetch"],
  ] as const) {
    assert.equal(
      decide(method, url, type),
      "pass: " + (type === "fetch" || type === "document" ? "only in a cookie" : "static asset"),
      `${method} ${url} (${type})`,
    );
  }
});

test("a cookie-only request counts when it is plausibly the refresh call: a POST to a path named for one, or a learned endpoint", () => {
  for (const url of ["/auth/refresh", "/api/token/refresh", "/oauth/token", "/api/v1/auth/token", "/session/refresh/", "/auth/refresh-token", "/api/renew"]) {
    assert.equal(decide("POST", url, "fetch"), "broker via cookie", url);
  }
  assert.equal(decide("PUT", "/auth/refresh", "xhr"), "broker via cookie");
  // Whole segments only, near the end: these are not refresh calls.
  for (const url of ["/api/tokens", "/refreshments/order", "/auth/refresh/history/export", "/api/token-usage"]) {
    assert.equal(decide("POST", url, "fetch"), "pass: only in a cookie", url);
  }
  // A body asking for another grant is a sign-in, whatever cookie rides along.
  assert.equal(decide("POST", "/oauth/token", "fetch", { body: "grant_type=password&username=a" }), "pass: another grant");
  assert.equal(decide("POST", "/oauth/token", "fetch", { body: "grant_type=refresh_token" }), "broker via cookie");
  // An endpoint seen to rotate the cookie counts by method and path, query aside, even as a GET.
  assert.equal(decide("POST", "/api/keepalive?x=1", "fetch", { learned: ["POST /api/keepalive"] }), "broker via cookie");
  assert.equal(decide("GET", "/api/whoami", "fetch", { learned: ["GET /api/whoami"] }), "broker via cookie");
  assert.equal(decide("GET", "/api/keepalive", "fetch", { learned: ["POST /api/keepalive"] }), "pass: only in a cookie");
  // ...but never a static asset, learned or not.
  assert.equal(decide("GET", "/app.js", "script", { learned: ["GET /app.js"], body: R1 }), "pass: static asset");
  // Without the cookie there is nothing to broker.
  assert.equal(decide("POST", "/auth/refresh", "fetch", { headers: { cookie: "sid=abc" } }), "pass: no known token");
});

test("a token the page put in a body, URL or header is a refresh whatever the path; a static asset never is", () => {
  assert.equal(decide("POST", "/api/session", "fetch", { body: JSON.stringify({ refresh_token: R1 }) }), "broker via body");
  assert.equal(decide("GET", `/api/renew?rt=${R1}`, "fetch"), "broker via url");
  assert.equal(decide("POST", "/api/x", "fetch", { headers: { ...withCookie, "x-refresh": R1 } }), "broker via header");
  assert.equal(decide("GET", `/app.js?rt=${R1}`, "script"), "pass: static asset");
  assert.equal(decide("HEAD", "/logo.png", "image"), "pass: static asset");
  assert.equal(isStaticAsset("POST", "image"), false, "only a GET or HEAD is an asset load");
});

test("which paths are named for a refresh, which endpoints may be learned, and how an endpoint is keyed", () => {
  assert.equal(refreshLikePath("/auth/refresh"), true);
  assert.equal(refreshLikePath("/token/refresh/v2"), true, "the last two segments");
  assert.equal(refreshLikePath("/refresh/a/b"), false, "deeper than that is not");
  assert.equal(refreshLikePath("/"), false);
  assert.equal(cookieMayCount("GET", `${ORIGIN}/auth/refresh`, new Set()), false, "a GET counts only once learned");
  assert.equal(cookieMayCount("GET", `${ORIGIN}/auth/refresh`, new Set(["GET /auth/refresh"])), true);
  assert.equal(endpointKey("post", `${ORIGIN}/a/b?c=d#e`), "POST /a/b");
  for (const url of ["/api/auth/login", "/signin", "/auth/logout/", "/oauth/callback", "/api/otp/verify"])
    assert.equal(learnableEndpoint(`${ORIGIN}${url}`), false, url);
  for (const url of ["/api/keepalive", "/api/session", "/auth/refresh"]) assert.equal(learnableEndpoint(`${ORIGIN}${url}`), true, url);
});

test("a Set-Cookie that replaces a known cookie token with a new one is a rotation; clearing it or resending it is not", () => {
  const R3 = "rt_DDDDDDDDDDDDDDDDDDDDDDDD3";
  assert.deepEqual(
    rotatedCookies([`rt=${R3}; Path=/; HttpOnly`], ROOT_COOKIE).map((t) => t.slot),
    [ROOT_COOKIE[0].slot],
  );
  assert.deepEqual(rotatedCookies([`other=x; Path=/\nrt=${R3}; Path=/`], ROOT_COOKIE).length, 1, "several cookies joined in one header value");
  assert.deepEqual(rotatedCookies([`rt=${R1}; Path=/`], ROOT_COOKIE), [], "the same token again");
  assert.deepEqual(rotatedCookies(["rt=; Max-Age=0; Path=/"], ROOT_COOKIE), [], "cleared on sign-out");
  assert.deepEqual(rotatedCookies([`sid=${R3}`], ROOT_COOKIE), [], "another cookie");
  assert.deepEqual(
    rotatedCookies([`refreshToken=${R3}`], [{ slot: `storage ${ORIGIN} refreshToken`, value: R1 }]),
    [],
    "a token held in storage is not a cookie",
  );
});

test("learned endpoints live beside the profile, owner-only, newest first and capped; a foreign file teaches nothing", () => {
  const dir = tempDir();
  try {
    const file = endpointsPathFor(path.join(dir, "member.json"));
    assert.equal(file, path.join(dir, "member.json.endpoints"));
    assert.deepEqual(readLearnedEndpoints(file), []);
    let list: string[] = [];
    for (let i = 0; i < MAX_LEARNED_ENDPOINTS + 5; i++) list = withLearnedEndpoint(list, `POST /api/e${i}`);
    list = withLearnedEndpoint(list, "POST /api/e10");
    writeLearnedEndpoints(file, list);
    if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const read = readLearnedEndpoints(file);
    assert.equal(read.length, MAX_LEARNED_ENDPOINTS);
    assert.equal(read[0], "POST /api/e10");
    assert.equal(read.filter((e) => e === "POST /api/e10").length, 1);
    assert.deepEqual(withLearnedEndpoint([], "DELETE /api/x"), [], "only methods a refresh uses");
    assert.deepEqual(withLearnedEndpoint([], "POST not-a-path"), []);
    fs.writeFileSync(file, JSON.stringify({ endpoints: ["POST /ok", 5, "rm -rf /", "GET /also ok"] }));
    assert.deepEqual(readLearnedEndpoints(file), ["POST /ok"]);
    fs.writeFileSync(file, "not json");
    assert.deepEqual(readLearnedEndpoints(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a request the broker resends itself keeps the page's headers, drops the ones the client sets, and carries the cookie line given", () => {
  assert.deepEqual(
    headersForResend(
      {
        ":authority": "x",
        Host: "app",
        "Content-Type": "application/json",
        "content-length": "9",
        cookie: `rt=${R1}`,
        "x-csrf": "t",
        "accept-encoding": "br",
        connection: "keep-alive",
      },
      `rt=${R2}`,
    ),
    { "content-type": "application/json", "x-csrf": "t", cookie: `rt=${R2}` },
  );
  assert.deepEqual(headersForResend({ cookie: `rt=${R1}`, accept: "*/*" }, null), { accept: "*/*" });
});

test("holding the lock: send the token when the profile still holds it, swap it when another session rotated it", () => {
  const sent = { slot: `storage ${ORIGIN} session → refreshToken`, value: R1 };
  assert.deepEqual(planRefresh(sent, refreshTokenSlots(stateWith(R1))), { kind: "send" });
  assert.deepEqual(planRefresh(sent, refreshTokenSlots(stateWith(R2))), { kind: "swap", to: { slot: sent.slot, value: R2 } });
  assert.deepEqual(planRefresh(sent, []), { kind: "unknown" });
  // The value is what decides "send": the same token under another slot is still current.
  assert.deepEqual(planRefresh({ slot: "elsewhere", value: R1 }, refreshTokenSlots(stateWith(R1))), { kind: "send" });
});

test("a swap replaces the spent token everywhere it is sent, in the form it was sent, and nothing else", () => {
  assert.equal(swapToken(`{"refresh_token":"${R1}"}`, R1, R2), `{"refresh_token":"${R2}"}`);
  const odd = "a+b/c=d_long_enough_token";
  const odd2 = "e+f/g=h_long_enough_token";
  assert.equal(swapToken(`t=${encodeURIComponent(odd)}`, odd, odd2), `t=${encodeURIComponent(odd2)}`);
  const req = { url: `${ORIGIN}/auth/token`, body: JSON.stringify({ refresh_token: R1 }), headers: { "content-type": "application/json", "x-refresh": R1 } };
  assert.deepEqual(swapRequest(req, R1, R2), {
    body: JSON.stringify({ refresh_token: R2 }),
    headers: { "content-type": "application/json", "x-refresh": R2 },
  });
  // Unchanged parts are left out, so the request goes on as it was.
  assert.deepEqual(swapRequest({ url: `${ORIGIN}/x`, body: null, headers: { a: "b" } }, R1, R2), {});
});

test("the write-back waits until the page has stored a rotation in the slot it sent from", () => {
  const sent = { slot: `storage ${ORIGIN} session → refreshToken`, value: R1 };
  assert.equal(rotationStored(stateWith(R1), sent), false, "still the spent token");
  assert.equal(rotationStored(stateWith(R2), sent), true);
  assert.equal(rotationStored({ cookies: [], origins: [] }, sent), false, "the slot is gone: nothing to save");
});

test("the write-back keeps the profile's sessionStorage, which the page's storage state never holds", () => {
  const session = [{ origin: ORIGIN, entries: [{ name: "id_token", value: "session-half-of-the-sign-in" }] }];
  const onDisk = { ...stateWith(R1), sessionStorage: session };
  const written = profileAfterRotation(stateWith(R2), onDisk) as { sessionStorage?: unknown; origins: unknown };
  assert.deepEqual(written.sessionStorage, session, "the sign-in's sessionStorage half survives a brokered refresh");
  assert.deepEqual(written.origins, stateWith(R2).origins, "everything else is the page's rotated state");
  assert.equal(refreshTokenSlots(written).find((t) => t.slot.includes("session"))?.value, R2);
  // A profile with no sessionStorage, or one that could not be read, leaves the page's state as it is.
  assert.deepEqual(profileAfterRotation(stateWith(R2), stateWith(R1)), stateWith(R2));
  assert.deepEqual(profileAfterRotation(stateWith(R2), null), stateWith(R2));
  // The fallback that swaps the token in the profile itself keeps it too.
  assert.deepEqual((swapProfileToken(onDisk, R1, R2) as { sessionStorage?: unknown }).sessionStorage, session);
});

test("a response names its rotated token in a JSON field or a Set-Cookie, and two candidates are not guessed between", () => {
  assert.equal(rotatedFromResponse(JSON.stringify({ access_token: A1, refresh_token: R2 }), []), R2);
  assert.equal(rotatedFromResponse("", [`refresh_token=${R2}; Path=/; HttpOnly`, "other=1"]), R2);
  assert.equal(rotatedFromResponse(JSON.stringify({ refresh_token: R1, next: { refreshToken: R2 } }), []), null);
  assert.equal(rotatedFromResponse("not json", ["sid=abc"]), null);
  const patched = swapProfileToken(stateWith(R1), R1, R2) as ReturnType<typeof stateWith>;
  assert.deepEqual(
    refreshTokenSlots(patched).map((s) => s.value),
    [`${R1}c`, R2],
    "only an exact cookie value is replaced; storage entries are swapped inside",
  );
  assert.deepEqual(refreshTokenSlots(stateWith(R1)).length, 2, "the original is not modified");
});

test("the broker runs for role sessions only, on by default, and a bad setting is refused", () => {
  assert.equal(brokerEnabled({ roleSession: true }), true);
  assert.equal(brokerEnabled({ roleSession: false }), false);
  assert.equal(brokerEnabled({ roleSession: false, option: true }), false);
  assert.equal(brokerEnabled({ roleSession: true, env: "off" }), false);
  assert.equal(brokerEnabled({ roleSession: true, env: " OFF " }), false);
  assert.equal(brokerEnabled({ roleSession: true, env: "on" }), true);
  assert.equal(brokerEnabled({ roleSession: true, env: "" }), true);
  assert.equal(brokerEnabled({ roleSession: true, env: "off", option: true }), true, "the attach option wins");
  assert.throws(() => brokerEnabled({ roleSession: true, env: "maybe" }), /must be "on" or "off"/);
});

test("the lock sits beside the profile, is owner-only, exclusive, and released only by its holder", () => {
  const dir = tempDir();
  try {
    const file = lockPathFor(path.join(dir, "member.json"));
    assert.equal(file, path.join(dir, "member.json.lock"));
    const first = tryAcquireLock(file);
    assert.ok(first);
    if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, LOCK_FILE_MODE);
    assert.equal(tryAcquireLock(file), null, "a live lock is not taken twice");
    first.release();
    assert.equal(fs.existsSync(file), false);
    const second = tryAcquireLock(file);
    assert.ok(second);
    first.release(); // a stale holder's release must not remove the new lock
    assert.equal(fs.existsSync(file), true);
    second.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock is taken over; a fresh one is waited for, and the wait gives up with the lock's path", async () => {
  assert.equal(isStale(1000, 1000 + 30_001, 30_000), true);
  assert.equal(isStale(1000, 1000 + 30_000, 30_000), false);
  const dir = tempDir();
  try {
    const file = path.join(dir, "member.json.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 1, nonce: "dead" }), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const taken = tryAcquireLock(file, { staleMs: 30_000 });
    assert.ok(taken, "a lock untouched for a minute belonged to a process that died");
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.includes(".stale")),
      [],
      "the stale file moved aside is removed",
    );
    await assert.rejects(acquireLock(file, { waitMs: 150, pollMs: 10 }), (err: Error) => err.message.includes(file) && /timed out/.test(err.message));
    taken.release();
    const held = await acquireLock(file, { waitMs: 150, pollMs: 10 });
    held.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiter that judged a lock stale gives back a fresh lock another waiter took first", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "member.json.lock");
    const holder = tryAcquireLock(file);
    assert.ok(holder);
    // The look said stale (the dead lock another waiter has since replaced); the file actually moved is fresh.
    const clock = [Date.now() + 60_000, Date.now()];
    assert.equal(tryAcquireLock(file, { staleMs: 30_000, now: () => clock.shift() ?? Date.now() }), null);
    assert.equal(fs.existsSync(file), true, "the fresh lock is back in place");
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.includes(".stale")),
      [],
    );
    assert.equal(tryAcquireLock(file), null, "and it still excludes everyone else");
    holder.release();
    assert.equal(fs.existsSync(file), false, "and its holder still owns it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creating the lock: EEXIST is a held lock everywhere; on Windows a file still being deleted is waited out, not a failure", () => {
  assert.equal(lockCreateError("EEXIST", "linux"), "held");
  assert.equal(lockCreateError("EEXIST", "win32"), "held");
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    assert.equal(lockCreateError(code, "win32"), "busy", code);
    assert.equal(lockCreateError(code, "darwin"), "error", `${code} elsewhere is a real error`);
  }
  assert.equal(lockCreateError("ENOSPC", "win32"), "error");
  assert.equal(lockCreateError(undefined, "win32"), "error");
});

test("the lock holds across real processes: concurrent read-modify-write loses no update", async () => {
  const dir = tempDir();
  try {
    const counter = path.join(dir, "counter.txt");
    const lock = path.join(dir, "member.json.lock");
    fs.writeFileSync(counter, "0");
    const children = 4;
    const rounds = 10;
    const child = path.join(here, "refresh-lock-child.ts");
    // Node itself with tsx's loader, never the npx/tsx shim: Windows refuses to
    // spawn a .cmd without a shell (EINVAL), and a shell is not wanted here.
    const loader = import.meta.resolve("tsx");
    const runs = Array.from(
      { length: children },
      () =>
        new Promise<number>((resolve, reject) => {
          const p = spawn(process.execPath, ["--import", loader, child, lock, counter, String(rounds)], { stdio: ["ignore", "ignore", "pipe"] });
          let err = "";
          p.stderr.on("data", (d: Buffer) => (err += d.toString()));
          p.on("error", reject);
          p.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(`child exited ${code}: ${err}`))));
        }),
    );
    await Promise.all(runs);
    assert.equal(Number(fs.readFileSync(counter, "utf8")), children * rounds, "every increment made under the lock survived");
    assert.equal(fs.existsSync(lock), false, "and the lock is gone when they are done");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
