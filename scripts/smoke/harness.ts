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
export async function until(label: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
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

/** Start the fixture server: static pages from test-app/ plus a minimal items API for write-policy testing. */
export async function startFixtureServer(): Promise<{ baseUrl: string; stats: ServerStats; close: () => void }> {
  const stats: ServerStats = { uploadLog: [], itemPosts: 0, workerDeletes: 0, sharedWorkerDeletes: 0, writes: {} };
  // Tiny server for the test app: static pages + a minimal items API for
  // write-policy testing.
  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    if (req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const key = `${req.method} ${urlPath}`;
      stats.writes[key] = (stats.writes[key] ?? 0) + 1;
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
      stats.itemPosts += 1;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "42", name: "smoke item" }));
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
  });
  // Loopback only. With no host, Node listens on every interface, and a test
  // fixture server has no business being reachable from the network.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { baseUrl, stats, close: () => server.close() };
}
