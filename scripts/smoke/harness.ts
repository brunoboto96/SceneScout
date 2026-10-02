/**
 * Shared harness for the real-browser smoke suites: the fixture server, the
 * check/until/settle helpers, and the context each suite receives.
 *
 * The suites import the COMPILED engine on purpose, unlike the pure-logic
 * suites that import ../src directly. The engine passes functions into the page
 * with page.evaluate(); run through tsx, the transpiler wraps them in a helper
 * that does not exist inside the browser, and they fail there in ways that look
 * like app behaviour ("scroll target not found"). `npm run smoke` rebuilds
 * first, so this still tests your edit, not the previous build.
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEngine } from "../../dist/browsers.js";
import { parseTotpSecret, totp } from "../../dist/engine/scripted-login.js";

/** The browser this run drives: SCENESCOUT_BROWSER, else Chromium. Checks that depend on the browser read it. */
export const BROWSER = defaultEngine(process.env);

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "test-app");

/** What the fixture server saw, so a suite can assert on what actually reached it. */
export interface ServerStats {
  /** Every multipart upload received, so a test can prove the BYTES arrived (a real PDF header inside the body), not just that a request was made. */
  uploadLog: Array<{ filename: string; bytes: number; sawPdf: boolean; sawPng: boolean }>;
  /** POSTs to /api/items — a click on "Create item" fires exactly one, so this counts clicks that actually happened. */
  itemPosts: number;
  /** DELETEs that reached the server for the worker-sync fixture's record — must stay 0 in read-only mode. */
  workerDeletes: number;
  /** DELETEs issued by the shared-worker fixture. */
  sharedWorkerDeletes: number;
  /** Every non-GET request that reached the server, as "METHOD /path" → count. What the write policy let through, seen from the other side. */
  writes: Record<string, number>;
  /** Requests for /api/held-body, whose body the server never finishes sending. */
  heldBodies: number;
}

/** How long the fixture server holds /slow-page back. */
export const SLOW_PAGE_MS = 2500;

/** Everything a suite needs. `projectDir` is shared on purpose: later suites assert on memory earlier ones wrote. */
export interface SmokeContext {
  baseUrl: string;
  /** The same fixture server on another port: another origin, for pages that embed a third party. */
  foreignBaseUrl: string;
  projectDir: string;
  stats: ServerStats;
}

let failures = 0;
/** Checks failed so far, across every suite. */
export function failureCount(): number {
  return failures;
}

/** Record a suite that threw: everything after the throw in that suite did not run, which is a failure, not a pass. */
export function recordCrash(suite: string, err: unknown): void {
  failures += 1;
  console.error(`  ✗ ${suite} CRASHED — the rest of this suite did not run\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}

export function check(name: string, cond: boolean, context?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${context ? `\n    ${context}` : ""}`);
  }
}

/**
 * How long a wait gives its condition by default. A wait returns as soon as the
 * condition holds, so a generous bound costs a passing run nothing; it only
 * decides how long a genuine hang takes to be reported.
 */
export const WAIT_MS = 15_000;

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * These waits exist because a click fires a request whose RESPONSE registers
 * the created resource — a fixed 300ms sleep guessed at that round trip. It
 * passed locally and would fail on a loaded CI runner for no reason the output
 * explained. Polling turns "slow" into "still correct, just later", and only a
 * genuine hang reaches the timeout.
 */
/**
 * Poll until the condition holds. The condition may be async: an awaited
 * promise is the whole point, because `while (!cond())` on a promise-returning
 * check is always false on the first turn — a Promise is truthy — so the wait
 * silently did nothing and the assertion after it ran against the state
 * before the thing it was waiting for.
 */
export async function until(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> {
  if (!(await eventually(cond, timeoutMs))) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/**
 * Poll like `until`, but answer whether the condition came to hold instead of
 * throwing: for a check whose failure should be reported as that check, with
 * its own context, rather than end the suite. `everyMs` spaces out a condition
 * that is costly to ask, such as one that takes a snapshot.
 */
export async function eventually(cond: () => boolean | Promise<boolean>, timeoutMs = WAIT_MS, everyMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return true;
}

/**
 * A deliberate fixed pause, for the cases where the thing being asserted is
 * that something did NOT happen. There is no condition to poll for when the
 * expected outcome is absence, so name the wait honestly rather than dressing
 * it up as a poll. A slow machine can only make such a window miss a late
 * arrival, never fail a check that should pass. Each call says why it has no
 * condition to wait on instead.
 */
export function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Requests for a page asked with `held=1`, waiting for the suite to let them be answered. */
const heldPages = new Set<() => void>();

/** How many `held=1` page requests the fixture server is holding. */
export function heldPageCount(): number {
  return heldPages.size;
}

/**
 * Answer every `held=1` page request held so far. A held page is a request
 * provably still in flight for as long as a suite needs it to be, where a
 * server timer would only make it likely.
 */
export function releaseHeldPages(): void {
  const waiting = [...heldPages];
  heldPages.clear();
  for (const answer of waiting) answer();
}

/** The single sign-on fixture: the app's session cookie, the provider's own, the code it hands back and the state it carries. */
export const SSO_SESSION_COOKIE = "sso_session";
export const SSO_PROVIDER_COOKIE = "provider_session";
const SSO_CODE = "pc-123";
const SSO_STATE = "st-1";

/** The session cookie the fixture's cookie sign-in sets. */
export const SIGN_IN_COOKIE = "fixture_session";

/**
 * The scripted sign-in fixture's test user. Invented values: a reserved
 * example domain, a password with the characters URL encoding changes, and a
 * base32 TOTP secret.
 */
export const SCRIPTED_USER = { username: "member@example.test", password: "correct horse+battery&staple", totpSecret: "JBSW Y3DP EHPK 3PXP" };
/** The cookie that carries a right password on to the code step. */
const PENDING_COOKIE = "fixture_pending";

/** The one code the passwordless sign-in fixture accepts, as a test environment configures a fixed code. Invented. */
export const FIXED_OTP_CODE = "482916";
/** How long the passwordless sign-in takes to "email" a code: longer than a page takes to settle, so the wait in between shows no field. */
const OTP_SEND_MS = 1200;
/** The passwordless sign-in's cookies: the code step, the session, and the refresh token (sent only to its own path). */
const OTP_PENDING_COOKIE = "fixture_otp_pending";
export const OTP_SESSION_COOKIE = "fixture_otp_session";
const OTP_REFRESH_COOKIE = "fixture_otp_refresh";
/** Sessions the passwordless sign-in has issued. */
const otpSessions = new Set<string>();
/** The key the passwordless sign-in signs its access tokens with: a new one per run, so no token outlives the fixture. */
const OTP_JWT_KEY = crypto.randomBytes(32);

const jwtSignature = (unsigned: string): Buffer => crypto.createHmac("sha256", OTP_JWT_KEY).update(unsigned).digest();

/** An HS256 access token for the member, valid for an hour. */
function signAccessToken(): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "member", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${unsigned}.${jwtSignature(unsigned).toString("base64url")}`;
}

/** Whether a bearer token is one this fixture signed and has not expired. The signature is compared in constant time. */
function accessTokenValid(token: string): boolean {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) return false;
  const want = jwtSignature(`${head}.${body}`);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try {
    const exp = (JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch {
    return false; // A payload that is not JSON was never signed here.
  }
}

/** A request's cookie by name. */
function cookieOf(req: http.IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** A request's JSON body, or {} for one that is not JSON. */
function jsonBody(req: http.IncomingMessage, then: (body: Record<string, unknown>) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = {};
    }
    then(body && typeof body === "object" ? (body as Record<string, unknown>) : {});
  });
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The cookie of the fixture's revocable sign-in: a fresh token per sign-in, valid until revoked. */
export const TOKEN_COOKIE = "fixture_token";

/** Tokens the revocable sign-in has issued and not yet revoked. */
const liveTokens = new Set<string>();
let tokenCounter = 0;

/** Revoke every token the fixture has issued, as a server ending its sessions does. Returns how many were live. */
export function revokeFixtureTokens(): number {
  const n = liveTokens.size;
  liveTokens.clear();
  return n;
}

/**
 * The fixture's rotating refresh tokens, as an identity provider with reuse
 * detection keeps them: each sign-in starts a token family; a refresh with the
 * family's current token rotates it (a new refresh token and a new access
 * token); a refresh with a token the family already spent revokes the whole
 * family, every access token in it included.
 */
interface TokenFamily {
  current: string;
  spent: Set<string>;
  access: Set<string>;
  revoked: boolean;
  rotations: number;
  /** For a family whose refresh token is a cookie: the Path the cookie is scoped to. */
  cookiePath?: string;
}
const families: TokenFamily[] = [];
const newToken = (): string => crypto.randomBytes(24).toString("base64url");

/**
 * Present a refresh token to the fixture's identity provider. The family's
 * current token rotates it and gets a new access token back; a token the
 * family already spent revokes the whole family, as reuse detection does;
 * anything else is refused.
 */
function presentRefreshToken(presented: string): { family: TokenFamily; access: string } | null {
  const family = families.find((f) => f.current === presented || f.spent.has(presented));
  if (!family || family.revoked) return null;
  if (family.current !== presented) {
    // A spent token presented again: taken as stolen, so the whole family ends.
    family.revoked = true;
    family.access.clear();
    return null;
  }
  family.spent.add(presented);
  family.current = newToken();
  const access = newToken();
  family.access.add(access);
  family.rotations += 1;
  return { family, access };
}

/** The cookie the fixture's cookie-held refresh token lives in. */
export const RC_REFRESH_COOKIE = "rc_refresh";

/** The Set-Cookie line that hands a family's current refresh token to the browser, scoped as the family's sign-in chose. */
function refreshCookieLine(family: TokenFamily): string {
  return `${RC_REFRESH_COOKIE}=${family.current}; Path=${family.cookiePath ?? "/"}; HttpOnly; SameSite=Lax; Max-Age=3600`;
}

/** The static assets of the cookie-refresh app: four scripts, a stylesheet and an image, served to anyone. */
const RC_STATIC: Record<string, { type: string; body: string }> = {
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [`/rc-static/s${n}.js`, { type: "text/javascript", body: "window.rcScripts = (window.rcScripts || 0) + 1;" }])),
  "/rc-static/app.css": { type: "text/css", body: "#rc-styled { color: rgb(10, 20, 30); }" },
  "/rc-static/mark.svg": {
    type: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#123456"/></svg>',
  },
};

/** Expire every access token the rotating sign-in issued, so each page's next call has to refresh. */
export function expireFixtureAccess(): void {
  for (const f of families) f.access.clear();
}

/** How the rotating sign-in's families stand: how many, how many rotations, how many revoked for reuse. Never the tokens. */
export function refreshFamilies(): { families: number; rotations: number; revoked: number } {
  return { families: families.length, rotations: families.reduce((n, f) => n + f.rotations, 0), revoked: families.filter((f) => f.revoked).length };
}

/** Whether `token` is the current refresh token of a live family: what a profile written back should hold. */
export function isCurrentRefreshToken(token: string): boolean {
  return families.some((f) => !f.revoked && f.current === token);
}

/** A loopback origin (the fixture server's other port), or "" for anything else: a redirect built from a query parameter goes nowhere else. */
function loopbackOrigin(value: string | null): string {
  return value && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value) ? value : "";
}

/** Start the fixture server: static pages from test-app/ plus a minimal items API for write-policy testing. */
export async function startFixtureServer(): Promise<{ baseUrl: string; foreignBaseUrl: string; stats: ServerStats; close: () => Promise<void> }> {
  const stats: ServerStats = { uploadLog: [], itemPosts: 0, workerDeletes: 0, sharedWorkerDeletes: 0, writes: {}, heldBodies: 0 };
  const board: string[] = [];
  let codeCounter = 0;
  const usedCodes = new Set<string>();
  // Tiny server for the test app: static pages + a minimal items API for
  // write-policy testing.
  const handle: http.RequestListener = (req, res) => {
    // Any page asked for with held=1 is answered, as if asked without it, only once the suite releases it (releaseHeldPages).
    const held = /([?&])held=1(&|$)/;
    if (held.test(req.url ?? "")) {
      const answer = (): void => {
        req.url = (req.url ?? "/").replace(held, (_, before: string, after: string) => (after ? before : "")).replace(/\?$/, "");
        handle(req, res);
      };
      heldPages.add(answer);
      res.on("close", () => heldPages.delete(answer));
      return;
    }
    const urlPath = (req.url ?? "/").split("?")[0];
    // An embed that redirects before it loads, as many do (/embed → /embed/).
    // A server error, served on both origins.
    if (urlPath === "/api/fail-500") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    // A page the server holds back before answering: slower than a lowered page-load limit, faster than the default.
    if (urlPath === "/slow-page") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(fs.readFileSync(path.join(appDir, "slow.html")));
      }, SLOW_PAGE_MS);
      return;
    }
    // A response whose headers arrive at once and whose body is held open until the client goes away: a request a
    // page leaves behind still in flight. Counted, so a suite can wait until the frame has sent it.
    if (urlPath === "/api/held-body") {
      stats.heldBodies += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      return;
    }
    // A server that hangs up without answering: the navigation fails at once (no timeout to wait out).
    if (urlPath === "/drop-connection") {
      req.socket.destroy();
      return;
    }
    // A members area that always sends the visitor to sign in, as with a missing or expired session.
    if (urlPath.startsWith("/members/")) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    // A second walled area whose sign-in page links out to a public page.
    if (urlPath.startsWith("/check-walled/")) {
      res.writeHead(302, { location: "/check/signin" });
      res.end();
      return;
    }
    if (urlPath === "/check/signin") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(appDir, "check-signin.html")));
      return;
    }
    // A link that answers with no content: the navigation starts and never commits.
    if (urlPath === "/no-content") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Two hops: through the app first, then out (/app-frame-redirect2 → /app-frame-redirect → <origin>).
    if (urlPath === "/app-frame-redirect2") {
      const to = loopbackOrigin(new URL(req.url ?? "/", "http://x").searchParams.get("to"));
      res.writeHead(302, { location: `/app-frame-redirect?to=${encodeURIComponent(to)}` });
      res.end();
      return;
    }
    // A sign-in provider's silent renewal: redirects to the app's callback with a one-time code.
    if (urlPath === "/idp-renew") {
      const to = loopbackOrigin(new URL(req.url ?? "/", "http://x").searchParams.get("to"));
      codeCounter += 1;
      res.writeHead(302, { location: `${to}/cb?code=c${codeCounter}` });
      res.end();
      return;
    }
    // The app's callback: each code works once, as a real one does.
    if (urlPath === "/cb") {
      const code = new URL(req.url ?? "/", "http://x").searchParams.get("code") ?? "";
      if (usedCodes.has(code)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("invalid_grant");
        return;
      }
      usedCodes.add(code);
      res.writeHead(302, { location: "/frame-child.html?as=cbdone" });
      res.end();
      return;
    }
    // The app's own frame URL redirecting into another site: /app-frame-redirect?to=<origin>.
    if (urlPath === "/app-frame-redirect") {
      const to = loopbackOrigin(new URL(req.url ?? "/", "http://x").searchParams.get("to"));
      res.writeHead(302, { location: `${to}/frame-child.html?as=appredirect` });
      res.end();
      return;
    }
    if (urlPath === "/frame-redirect") {
      res.writeHead(302, { location: "/frame-child.html?as=redirected" });
      res.end();
      return;
    }
    if (req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const key = `${req.method} ${urlPath}`;
      stats.writes[key] = (stats.writes[key] ?? 0) + 1;
    }
    // A search read through POST (read-posts.html). A body carrying a delete command or a GraphQL mutation is counted
    // apart, so a suite can prove none arrived while plain searches did.
    if (urlPath === "/api/search" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const tag = body.includes('"action":"delete"') ? " (delete)" : body.includes("mutation") ? " (mutation)" : "";
        if (tag) stats.writes[`POST /api/search${tag}`] = (stats.writes[`POST /api/search${tag}`] ?? 0) + 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: ["Widget A", "Widget B"] }));
      });
      return;
    }
    if (urlPath === "/api/notes" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    // A visit a page records as it loads (first-look-post.html): counted in `writes` above, and answered as a real endpoint would.
    if (urlPath === "/api/visits" && req.method === "POST") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Plain saves and a delete command share this URL: the delete-bearing ones are counted apart, so a suite can prove none arrived.
    if (urlPath === "/api/unload/race" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (Buffer.concat(chunks).toString("utf8").includes('"action":"delete"')) {
          const key = "POST /api/unload/race (delete)";
          stats.writes[key] = (stats.writes[key] ?? 0) + 1;
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    // A sign-in the page beacons as it is left, answered late with a 307 to an ordinary save: the save is a request the
    // engine hears of well after the page sent the sign-in, so after a flow has handed back to the crawl's rule.
    if (urlPath === "/api/handback/login") {
      setTimeout(() => {
        res.writeHead(307, { location: "/api/handback/saved" });
        res.end();
      }, 1500);
      return;
    }
    // A write carried on by a redirect: a 307 keeps the method and the body, to a destructive address.
    if (urlPath === "/api/unload/redirect") {
      res.writeHead(307, { location: "/api/unload/redirected/delete" });
      res.end();
      return;
    }
    // Every other write the unload fixture sends is accepted, so a write that goes out is not also an http_error.
    if (urlPath.startsWith("/api/unload/")) {
      res.writeHead(204);
      res.end();
      return;
    }
    // Endpoints that refuse, for the contradiction oracles. The status is in
    // the path so a fixture page can ask for the one it wants to be refused
    // with, and the body is JSON because these stand in for an app's own API.
    const refusal = /^\/api\/refuse\/(\d{3})$/.exec(urlPath);
    if (refusal) {
      res.writeHead(Number(refusal[1]), { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "refused" }));
      return;
    }
    // A message board kept by the server, so a value one browser posts is
    // seen by every other: the fixture for probes shared between sessions.
    if (urlPath === "/api/board") {
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            board.push(String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { message?: unknown }).message ?? ""));
          } catch {
            /* a malformed post stores nothing */
          }
          res.writeHead(201, { "content-type": "application/json" });
          res.end("{}");
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: board }));
      return;
    }
    if (urlPath === "/api/allow") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if ((urlPath === "/api/upload" || urlPath === "/api/avatar") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const entry = {
          filename: /filename="([^"]*)"/.exec(body.toString("latin1"))?.[1] ?? "",
          bytes: body.length,
          sawPdf: body.includes("%PDF-"),
          sawPng: body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        };
        stats.uploadLog.push(entry);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `u${stats.uploadLog.length}`, ...entry }));
      });
      return;
    }
    if (urlPath === "/api/items" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        stats.itemPosts += 1;
        // The fixtures' own-resource buttons are built around id 42; a create
        // that asks for a fresh id gets a distinct one, as a real store would.
        const fresh = Buffer.concat(chunks).toString("utf8").includes("fresh");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: fresh ? String(100 + stats.itemPosts) : "42", name: "smoke item" }));
      });
      return;
    }
    if (urlPath === "/api/items/upsert" && req.method === "POST") {
      // Upsert: echoes the id the client sent — must NOT become session-owned.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "7", name: "existing item" }));
      return;
    }
    if (urlPath === "/sw.js") {
      // A worker script must be served as JavaScript or registration is refused.
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(fs.readFileSync(path.join(appDir, "sw.js")));
      return;
    }
    if (urlPath === "/api/items/999" && req.method === "DELETE") stats.workerDeletes += 1;
    if (urlPath === "/api/items/998" && req.method === "DELETE") stats.sharedWorkerDeletes += 1;
    if (urlPath.startsWith("/api/items/") && (req.method === "PUT" || req.method === "DELETE")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Regression fixture: a create response naming its own id after the
    // resource ("document_id") rather than a bare "id" — the exact shape
    // that let a real backend's creations slip past ownership tracking.
    if (urlPath === "/api/documents" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "99", title: "smoke doc" }));
      return;
    }
    // Regression fixture: a 201 create response that includes a
    // server-derived foreign key (owner_id) alongside the new resource's
    // own id. Unlike template_id in the fixture below, owner_id's value is
    // never echoed anywhere in the request — it's the CURRENT USER's id,
    // supplied entirely server-side — so the request-echo filter alone
    // can't catch it; only a same-resource-name check can.
    if (urlPath === "/api/documents/quick" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "250", owner_id: "3", title: "smoke quick doc" }));
      return;
    }
    // Regression fixture: a single UI action that fires POST-then-immediately
    // PUT with NO artificial delay (create, then save content under the id
    // it just got back) — the real-world pattern a "Save" button uses, and
    // a race the earlier fixtures above (separate clicks, test waits 300ms
    // between them) don't exercise.
    if (urlPath === "/api/documents/instant" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "301", title: "smoke instant doc" }));
      return;
    }
    // Regression fixture: an RPC-style creation endpoint (own path segment,
    // matching real backends like POST /api/things/from-template/:id)
    // whose 201 response ALSO echoes a client-supplied foreign key ending in
    // "_id" (template_id) alongside the new resource's own id. Exercises two
    // fixes at once: (1) the foreign id must not ride the 201/Location bypass
    // into ownership, and (2) a later plain CRUD path on the created
    // resource (/api/documents/:id) must still be recognized as owned even
    // though the creation URL doesn't share that prefix.
    if (urlPath === "/api/documents/from-template/5" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ document_id: "199", template_id: "5", title: "smoke templated doc" }));
      return;
    }
    if (urlPath.startsWith("/api/documents/") && req.method === "PUT") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // A cookie sign-in, as an SSO callback ends: one GET sets a session cookie
    // and sends the browser on to the account page. /cookie-account then serves
    // the signed-in page or its signed-out pair by that cookie alone, and
    // /cookie-signout clears it.
    if (urlPath === "/cookie-signin") {
      res.writeHead(302, { location: "/cookie-account", "set-cookie": `${SIGN_IN_COOKIE}=member; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` });
      res.end();
      return;
    }
    if (urlPath === "/cookie-signout") {
      res.writeHead(302, { location: "/cookie-account", "set-cookie": `${SIGN_IN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      res.end();
      return;
    }
    if (urlPath === "/cookie-account") {
      const signedIn = (req.headers.cookie ?? "").split(/;\s*/).includes(`${SIGN_IN_COOKIE}=member`);
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, signedIn ? "cookie-account.html" : "cookie-account-signed-out.html")));
      return;
    }
    // A sign-in through a stand-in single sign-on provider on the second
    // origin: /sso/signin links to /sso-provider/authorize there (its origin
    // given as ?provider=), which takes any password, sets its own cookie on
    // its own path and sends the browser back to /sso/callback with a code and
    // the state. The callback moves on to /sso/finishing with no session yet,
    // and the session cookie is set only once /sso/exchange is answered.
    if (urlPath === "/sso/signin" && req.method === "GET") {
      const provider = new URL(req.url ?? "/", "http://x").searchParams.get("provider") ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(provider)) {
        res.writeHead(400);
        res.end("provider must be a loopback origin");
        return;
      }
      const authorize = `${provider}/sso-provider/authorize?return=${encodeURIComponent(`http://${req.headers.host}/sso/callback`)}&state=${SSO_STATE}`;
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "sso-signin.html"), "utf8").replace("<!--AUTHORIZE-->", escapeHtml(authorize)));
      return;
    }
    if (urlPath === "/sso-provider/authorize" && req.method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(
        fs
          .readFileSync(path.join(appDir, "sso-provider.html"), "utf8")
          .replace("<!--RETURN-->", escapeHtml(q.get("return") ?? ""))
          .replace("<!--STATE-->", escapeHtml(q.get("state") ?? "")),
      );
      return;
    }
    if (urlPath === "/sso-provider/authorize" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const back = form.get("return") ?? "";
        if (!/^http:\/\/127\.0\.0\.1:\d+\/sso\/callback$/.test(back)) {
          res.writeHead(400);
          res.end("return must be the app's callback");
          return;
        }
        res.writeHead(303, {
          location: `${back}?code=${SSO_CODE}&state=${encodeURIComponent(form.get("state") ?? "")}`,
          // The provider's own session, on its own path: never sent to the app's pages.
          "set-cookie": `${SSO_PROVIDER_COOKIE}=provider-session-0123456789abcdef; Path=/sso-provider; HttpOnly; SameSite=Lax`,
        });
        res.end();
      });
      return;
    }
    if (urlPath === "/sso/callback") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const ok = q.get("code") === SSO_CODE && q.get("state") === SSO_STATE;
      res.writeHead(302, { location: ok ? `/sso/finishing?c=${SSO_CODE}` : "/sso/signin" });
      res.end();
      return;
    }
    if (urlPath === "/sso/finishing" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "sso-finishing.html")));
      return;
    }
    if (urlPath === "/sso/exchange" && req.method === "POST") {
      const ok = new URL(req.url ?? "/", "http://x").searchParams.get("c") === SSO_CODE;
      res.writeHead(ok ? 200 : 403, {
        "content-type": "application/json",
        ...(ok ? { "set-cookie": `${SSO_SESSION_COOKIE}=member; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` } : {}),
      });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (urlPath === "/sso/home") {
      const signedIn = (req.headers.cookie ?? "").split(/;\s*/).includes(`${SSO_SESSION_COOKIE}=member`);
      if (!signedIn) {
        res.writeHead(302, { location: "/sso/signin" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "sso-home.html")));
      return;
    }
    // The scripted sign-in: email, then password on the same page, then a
    // TOTP code, then the cookie /cookie-account reads. A wrong password or
    // code serves the step again with an error; the password error repeats
    // what was typed.
    if (urlPath === "/scripted-signin" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "scripted-signin.html"), "utf8").replace("<!--ERROR-->", ""));
      return;
    }
    if ((urlPath === "/scripted-signin/session" || urlPath === "/scripted-signin/code") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const again = (file: string, error: string): void => {
          res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
          res.end(fs.readFileSync(path.join(appDir, file), "utf8").replace("<!--ERROR-->", `<p role="alert">${escapeHtml(error)}</p>`));
        };
        if (urlPath === "/scripted-signin/session") {
          const email = form.get("email") ?? "";
          const password = form.get("password") ?? "";
          if (email !== SCRIPTED_USER.username || password !== SCRIPTED_USER.password) {
            again("scripted-signin.html", `No account matches ${email} with the password ${password}.`);
            return;
          }
          res.writeHead(303, { location: "/scripted-signin/code", "set-cookie": `${PENDING_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax` });
          res.end();
          return;
        }
        const pending = (req.headers.cookie ?? "").split(/;\s*/).includes(`${PENDING_COOKIE}=1`);
        const params = parseTotpSecret(SCRIPTED_USER.totpSecret);
        if (!params.ok) throw new Error("the fixture's TOTP secret does not parse");
        const now = Date.now() / 1000;
        // The current code or the one before it, as providers allow for a code typed at a boundary.
        const valid = [totp(params.params, now), totp(params.params, now - 30)];
        if (!pending || !valid.includes(form.get("code") ?? "")) {
          again("scripted-code.html", "That code is not right. Try the one your app shows now.");
          return;
        }
        res.writeHead(303, {
          location: "/cookie-account",
          "set-cookie": [`${SIGN_IN_COOKIE}=member; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`, `${PENDING_COOKIE}=; Path=/; Max-Age=0`],
        });
        res.end();
      });
      return;
    }
    if (urlPath === "/scripted-signin/code" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "scripted-code.html"), "utf8").replace("<!--ERROR-->", ""));
      return;
    }
    // The passwordless sign-in (otp-signin.html): /otp-signin/start "emails"
    // a code after a moment, /otp-signin/verify accepts the one fixed code for
    // the test user (a session cookie, a refresh-token cookie and an access
    // token in the body) and refuses anything else repeating what was typed,
    // and /otp-api/me answers only to the access token AND the session cookie.
    if ((urlPath === "/otp-signin" || urlPath === "/otp-account") && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, urlPath === "/otp-signin" ? "otp-signin.html" : "otp-account.html")));
      return;
    }
    if (urlPath === "/otp-signin/start" && req.method === "POST") {
      jsonBody(req, () => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json", "set-cookie": `${OTP_PENDING_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax` });
          res.end(JSON.stringify({ sent: true }));
        }, OTP_SEND_MS);
      });
      return;
    }
    if (urlPath === "/otp-signin/verify" && req.method === "POST") {
      jsonBody(req, (body) => {
        const code = typeof body.code === "string" ? body.code : "";
        if (cookieOf(req, OTP_PENDING_COOKIE) !== "1" || body.email !== SCRIPTED_USER.username || code !== FIXED_OTP_CODE) {
          res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: `The code ${code} is not right. Check the email we sent you.` }));
          return;
        }
        const session = newToken();
        otpSessions.add(session);
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": [
            `${OTP_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
            `${OTP_REFRESH_COOKIE}=${newToken()}; Path=/otp-auth/refresh; HttpOnly; SameSite=Strict; Max-Age=86400`,
            `${OTP_PENDING_COOKIE}=; Path=/; Max-Age=0`,
          ],
        });
        res.end(JSON.stringify({ access_token: signAccessToken() }));
      });
      return;
    }
    if (urlPath === "/otp-api/me") {
      const session = cookieOf(req, OTP_SESSION_COOKIE);
      const ok = accessTokenValid((req.headers.authorization ?? "").replace(/^Bearer /, "")) && session !== undefined && otpSessions.has(session);
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(ok ? { name: "a member" } : { error: "unauthorized" }));
      return;
    }
    // A sign-in the server can revoke mid-run: /token-signin issues a new
    // token, and every /token-* page serves the signed-in page to a live token
    // and redirects anything else to /login, as a session guard does.
    if (urlPath === "/token-signin") {
      tokenCounter += 1;
      const token = `t${tokenCounter}`;
      liveTokens.add(token);
      res.writeHead(302, { location: "/token-home", "set-cookie": `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` });
      res.end();
      return;
    }
    if (urlPath.startsWith("/token-")) {
      const token = (req.headers.cookie ?? "")
        .split(/;\s*/)
        .find((c) => c.startsWith(`${TOKEN_COOKIE}=`))
        ?.slice(TOKEN_COOKIE.length + 1);
      if (!token || !liveTokens.has(token)) {
        res.writeHead(302, { location: "/login", "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "cookie-account.html")));
      return;
    }
    // The same revocable sign-in, kept ONLY in sessionStorage: /ss-signin
    // hands the page a new token to store there, every other /ss-* page is
    // an app that asks /ss-api/me whether its token is still live, and
    // revokeFixtureTokens() ends it along with the cookie sign-in's.
    if (urlPath === "/ss-signin") {
      tokenCounter += 1;
      const token = `s${tokenCounter}`;
      liveTokens.add(token);
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(
        `<!doctype html><title>Signing in</title><script>sessionStorage.setItem("fixture_token", ${JSON.stringify(token)}); location.replace("/ss-home");</script>`,
      );
      return;
    }
    if (urlPath === "/ss-api/me") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const ok = liveTokens.has(bearer);
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(ok ? { name: "a member" } : { error: "unauthorized" }));
      return;
    }
    if (urlPath.startsWith("/ss-")) {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "session-guarded.html")));
      return;
    }
    // The rotating sign-in. /rt-signin starts a family and hands the page its
    // tokens to keep in localStorage; /rt-app is the app, which calls
    // /rt-api/me with its access token and, on a 401, refreshes at
    // /rt-auth/token with its refresh token.
    if (urlPath === "/rt-signin") {
      const family: TokenFamily = { current: newToken(), spent: new Set(), access: new Set([newToken()]), revoked: false, rotations: 0 };
      families.push(family);
      const session = JSON.stringify({ accessToken: [...family.access][0], refreshToken: family.current });
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(
        `<!doctype html><title>Signing in</title><script>localStorage.setItem("session", ${JSON.stringify(session)}); location.replace("/rt-app");</script>`,
      );
      return;
    }
    if (urlPath === "/rt-app") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "rotating-refresh.html")));
      return;
    }
    if (urlPath === "/rt-api/me") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const ok = families.some((f) => !f.revoked && f.access.has(bearer));
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(ok ? { name: "a member" } : { error: "unauthorized" }));
      return;
    }
    if (urlPath === "/rt-auth/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let presented = "";
        try {
          presented = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { refresh_token?: unknown }).refresh_token ?? "");
        } catch {
          presented = "";
        }
        const rotated = presentRefreshToken(presented);
        if (!rotated) {
          res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ access_token: rotated.access, refresh_token: rotated.family.current }));
      });
      return;
    }
    // The rotating sign-in with its refresh token in an HttpOnly cookie and its
    // access token in localStorage, as many single-page apps keep them.
    // /rc-signin?scope=root scopes the cookie to "/", so it rides on every
    // request the app makes, its scripts and images included; scope=endpoint
    // scopes it to /rc-auth, so only the refresh call carries it. The app at
    // /rc-app refreshes with a POST that carries nothing but the cookie: to
    // /rc-auth/refresh, or with refresh=odd to /rc-api/keepalive, a path that
    // does not say it refreshes.
    if (urlPath === "/rc-signin") {
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const refreshUrl = query.get("refresh") === "odd" ? "/rc-api/keepalive" : "/rc-auth/refresh";
      const family: TokenFamily = {
        current: newToken(),
        spent: new Set(),
        access: new Set([newToken()]),
        revoked: false,
        rotations: 0,
        cookiePath: query.get("scope") === "endpoint" ? "/rc-auth" : "/",
      };
      families.push(family);
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "set-cookie": refreshCookieLine(family) });
      res.end(
        `<!doctype html><title>Signing in</title><script>localStorage.setItem("rc_access", ${JSON.stringify([...family.access][0])}); ` +
          `localStorage.setItem("rc_refresh_url", ${JSON.stringify(refreshUrl)}); location.replace("/rc-app");</script>`,
      );
      return;
    }
    if (urlPath === "/rc-app") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(fs.readFileSync(path.join(appDir, "refresh-cookie.html")));
      return;
    }
    if (RC_STATIC[urlPath]) {
      res.writeHead(200, { "content-type": RC_STATIC[urlPath].type, "cache-control": "no-store" });
      res.end(RC_STATIC[urlPath].body);
      return;
    }
    if (urlPath === "/rc-api/items") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (urlPath === "/rc-api/me") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const ok = families.some((f) => !f.revoked && f.access.has(bearer));
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(ok ? { name: "a member" } : { error: "unauthorized" }));
      return;
    }
    if ((urlPath === "/rc-auth/refresh" || urlPath === "/rc-api/keepalive") && req.method === "POST") {
      req.resume();
      const presented =
        (req.headers.cookie ?? "")
          .split(/;\s*/)
          .find((c) => c.startsWith(`${RC_REFRESH_COOKIE}=`))
          ?.slice(RC_REFRESH_COOKIE.length + 1) ?? "";
      const rotated = presentRefreshToken(presented);
      if (!rotated) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "set-cookie": refreshCookieLine(rotated.family) });
      res.end(JSON.stringify({ access_token: rotated.access }));
      return;
    }
    // Extensionless /login, because the engine's auth heuristic matches a path
    // SEGMENT — "/login.html" is not a login route and would not exercise it.
    if (urlPath === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(appDir, "login.html")));
      return;
    }
    // The path comes from the request, so keep it inside the fixture directory:
    // resolve it, then require the result to still be under appDir. Without
    // this, "/../../<anything>" served any file the test runner could read.
    const file = path.resolve(appDir, `.${path.posix.normalize(`/${urlPath === "/" ? "index.html" : urlPath}`)}`);
    const insideAppDir = file.startsWith(appDir + path.sep);
    if (insideAppDir && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  };
  const server = http.createServer(handle);
  // A second origin for the same pages: a frame served from here is
  // cross-origin to baseUrl, and whatever it manages to send lands in the same
  // stats, so a suite can prove a request never arrived.
  const foreignServer = http.createServer(handle);
  // Loopback only. With no host, Node listens on every interface, and a test
  // fixture server has no business being reachable from the network.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) => foreignServer.listen(0, "127.0.0.1", resolve));
  const foreignBaseUrl = `http://127.0.0.1:${(foreignServer.address() as { port: number }).port}`;
  return {
    baseUrl,
    foreignBaseUrl,
    stats,
    /** Resolves once both servers have stopped listening and dropped their connections, so nothing of theirs keeps node running. */
    close: async () => {
      const stop = (s: http.Server) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        });
      await Promise.all([stop(server), stop(foreignServer)]);
    },
  };
}
