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
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEngine } from "../../dist/browsers.js";

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
}

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
export async function until(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * A deliberate fixed pause, for the cases where the thing being asserted is
 * that something did NOT happen. There is no condition to poll for when the
 * expected outcome is absence, so name the wait honestly rather than dressing
 * it up as a poll.
 */
export function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A loopback origin (the fixture server's other port), or "" for anything else: a redirect built from a query parameter goes nowhere else. */
function loopbackOrigin(value: string | null): string {
  return value && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value) ? value : "";
}

/** Start the fixture server: static pages from test-app/ plus a minimal items API for write-policy testing. */
export async function startFixtureServer(): Promise<{ baseUrl: string; foreignBaseUrl: string; stats: ServerStats; close: () => void }> {
  const stats: ServerStats = { uploadLog: [], itemPosts: 0, workerDeletes: 0, sharedWorkerDeletes: 0, writes: {} };
  const board: string[] = [];
  let codeCounter = 0;
  const usedCodes = new Set<string>();
  // Tiny server for the test app: static pages + a minimal items API for
  // write-policy testing.
  const handle: http.RequestListener = (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    // An embed that redirects before it loads, as many do (/embed → /embed/).
    // A server error, served on both origins.
    if (urlPath === "/api/fail-500") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
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
    // A write carried on by a redirect: a 307 keeps the method and the body, to a destructive address.
    if (urlPath === "/api/unload/redirect") {
      res.writeHead(307, { location: "/api/unload/redirected/delete" });
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
    close: () => {
      server.close();
      foreignServer.close();
    },
  };
}
