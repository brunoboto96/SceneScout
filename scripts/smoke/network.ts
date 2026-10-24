/**
 * The network settings against a real browser and a real proxy (#554, #555),
 * on servers of the suite's own:
 *
 * - a proxy: `scenescout preflight` and an attach reach an app at a host name
 *   only the proxy can resolve, so getting through proves the proxy was used,
 *   and the same preflight with no proxy fails on DNS;
 * - the allowlist header: the app's own requests carry it, cookies still
 *   arrive beside it, and neither another origin's image nor a redirect away
 *   from the app ever sees it; WebKit refuses it at attach;
 * - the retry: with SCENESCOUT_RETRY_NETWORK=on a load whose connection is
 *   dropped is tried once more and says so, and with it off it fails;
 * - the classification: a page whose script comes from a host that does not
 *   resolve is one network entry in the check's rules, not request-failed and
 *   console-error.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { checkFindings } from "../../dist/engine/check.js";
import { BROWSER, check, type SmokeContext } from "./harness.ts";

export const title = "network: proxy, allowlist header, retry";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");
/** A name no resolver knows (.test is reserved), so only the proxy can reach it. */
const APP_HOST = "app.scenescout.test";
const NOWHERE_HOST = "cdn.scenescout.test";
const HEADER = "x-ci-allow";
/** How long the fixture's file takes to arrive in full. */
const FILE_STREAM_MS = 6000;
const SECRET = "ci-allow-5e3f9a0c71";
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SCENESCOUT_PROXY"];
const OWN_VARS = ["SCENESCOUT_APP_HEADER", "SCENESCOUT_RETRY_NETWORK"];

interface Seen {
  method: string;
  url: string;
  header: string | null;
  cookie: string | null;
}

/** A server that keeps what it was asked, and closes every socket it holds when told to. */
async function server(handle: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void) {
  const seen: Seen[] = [];
  const sockets = new Set<net.Socket>();
  const s = http.createServer((req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      header: (req.headers[HEADER] as string | undefined) ?? null,
      cookie: req.headers.cookie ?? null,
    });
    handle(req, res, seen);
  });
  s.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const sock of sockets) sock.destroy();
        s.close(() => r());
      }),
  };
}

/** A forward proxy (absolute-form requests and CONNECT) that sends APP_HOST to the app's port on 127.0.0.1 and refuses every other host. */
async function proxy(appPort: number) {
  const hosts: string[] = [];
  const sockets = new Set<net.Socket>();
  const keep = (sock: net.Socket) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  };
  const s = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    hosts.push(target.hostname);
    if (target.hostname !== APP_HOST) {
      res.writeHead(502).end();
      return;
    }
    const up = http.request({ host: "127.0.0.1", port: appPort, path: target.pathname + target.search, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  s.on("connection", keep);
  s.on("connect", (req, sock, head) => {
    const [host] = (req.url ?? "").split(":");
    hosts.push(host);
    if (host !== APP_HOST) {
      sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const up = net.connect(appPort, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    keep(up);
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`,
    hosts,
    close: () =>
      new Promise<void>((r) => {
        for (const sock of sockets) sock.destroy();
        s.close(() => r());
      }),
  };
}

/**
 * Run `scenescout preflight` as a command, with the proxy variables of this environment replaced by `vars`. Not
 * spawnSync: the proxy and the app answer from this process, so its event loop must keep running meanwhile.
 */
async function preflight(url: string, vars: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...PROXY_VARS, ...OWN_VARS]) delete env[name];
  const child = spawn(process.execPath, [CLI, "preflight", url, "--timeout-ms", "5000"], { env: { ...env, ...vars }, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  clearTimeout(timer);
  return { code, out };
}

/** Run `body` with these variables set in this process's environment, and put back what was there. */
async function withEnv<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = new Map([...PROXY_VARS, ...OWN_VARS].map((n) => [n, process.env[n]]));
  for (const name of saved.keys()) delete process.env[name];
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

async function errorOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function run(_ctx: SmokeContext): Promise<void> {
  console.log("network: a proxy only it can resolve, an allowlist header, a dropped connection retried");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-network-"));
  const other = await server((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", connection: "close" });
    res.end("<p>elsewhere</p>");
  });
  // Every load of /flaky in the window after its first is dropped. A window rather than a count: Firefox and WebKit
  // send a load once more themselves on a dropped connection, at once, and the engine's retry waits longer than this.
  const DROP_WINDOW_MS = 1000;
  let dropFrom = 0;
  const app = await server((req, res, seen) => {
    const url = req.url ?? "";
    if (url === "/flaky" && dropFrom >= 0 && (dropFrom === 0 || Date.now() - dropFrom < DROP_WINDOW_MS)) {
      if (dropFrom === 0) dropFrom = Date.now();
      // No answer at all: the connection is dropped, as a load balancer restarting under it would.
      req.socket.destroy();
      return;
    }
    if (url === "/report-moved") {
      res.writeHead(302, { location: "/report.pdf", connection: "close" });
      res.end();
      return;
    }
    if (url === "/report.pdf") {
      // A file that streams for longer than a navigation should take to hand it over: the browser must get it as it
      // comes, never after SceneScout has read it whole.
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="report.pdf"', connection: "close" });
      if (req.method === "HEAD") return void res.end();
      res.write("%PDF-1.4\n");
      const timer = setTimeout(() => res.end("%%EOF\n"), FILE_STREAM_MS);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (url === "/home" || url === "/api/moved") {
      res.writeHead(302, { location: url === "/home" ? "/signin" : "/api/data", connection: "close" });
      res.end();
      return;
    }
    if (url === "/go") {
      res.writeHead(302, { location: `${other.base}/landed`, connection: "close" });
      res.end();
      return;
    }
    if (url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ requests: seen.length }));
      return;
    }
    const body =
      url === "/third"
        ? `<h1>Third party</h1><script src="http://${NOWHERE_HOST}/lib.js"></script><a href="/">Home</a><button>Go</button>`
        : `<h1>Network fixture</h1><img alt="pixel" src="${other.base}/pixel.png?n=${seen.length}"><a href="/third">Third</a><button id="b">Go</button><script>fetch("/api/data")</script>`;
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=one; Path=/", connection: "close" });
    res.end(`<!doctype html><title>Network fixture</title>${body}`);
  });
  const relay = await proxy(app.port);
  const engine = new BrowserEngine();
  engine.sessionKey = "network";
  const appViaProxy = `http://${APP_HOST}:${app.port}`;
  try {
    // ── the proxy ──
    const through = await preflight(`${appViaProxy}/`, { HTTP_PROXY: relay.url }, projectDir);
    check(
      "preflight reaches an app only the proxy can resolve, through HTTP_PROXY, and names the proxy it used",
      through.code === 0 && relay.hosts.includes(APP_HOST) && /Proxy \(HTTPS_PROXY \/ HTTP_PROXY \/ NO_PROXY\): .*127\.0\.0\.1/.test(through.out),
      `exit ${through.code}; proxy saw ${JSON.stringify(relay.hosts)}; ${through.out.slice(0, 400)}`,
    );
    const direct = await preflight(`${appViaProxy}/`, {}, projectDir);
    check("...and with no proxy the same preflight fails on DNS (exit 10)", direct.code === 10, `exit ${direct.code}; ${direct.out.slice(0, 300)}`);
    const bypassed = await preflight(`${appViaProxy}/`, { HTTP_PROXY: relay.url, NO_PROXY: APP_HOST }, projectDir);
    check(
      "...and NO_PROXY naming the host sends it direct, so it fails on DNS again",
      bypassed.code === 10,
      `exit ${bypassed.code}; ${bypassed.out.slice(0, 300)}`,
    );

    relay.hosts.length = 0;
    const attachedThrough = await withEnv({ HTTP_PROXY: relay.url }, () => errorOf(() => engine.attach({ url: `${appViaProxy}/`, projectDir })));
    check(
      `the ${BROWSER} browser reaches the same app through the proxy`,
      attachedThrough === "" && relay.hosts.includes(APP_HOST) && (await engine.snapshot()).includes("Network fixture"),
      `${attachedThrough.slice(0, 300)}; proxy saw ${JSON.stringify(relay.hosts)}`,
    );
    const attachedDirect = await withEnv({}, () => errorOf(() => engine.attach({ url: `${appViaProxy}/`, projectDir })));
    check(
      "...and with no proxy its attach fails, naming the name that did not resolve rather than asking whether the app is running",
      /^Could not load \S+ — the host name does not resolve/.test(attachedDirect),
      attachedDirect.slice(0, 300),
    );

    // ── the allowlist header ──
    app.seen.length = 0;
    other.seen.length = 0;
    const header = { SCENESCOUT_APP_HEADER: `X-CI-Allow: ${SECRET}` };
    if (BROWSER === "webkit") {
      const refused = await withEnv(header, () => errorOf(() => engine.attach({ url: `${app.base}/`, projectDir })));
      check(
        "WebKit refuses the allowlist header at attach, since it cannot be handed a redirect",
        /not available on WebKit/.test(refused),
        refused.slice(0, 300),
      );
    } else {
      let signedInAt = "";
      let fetched: unknown = null;
      const attached = await withEnv(header, async () => {
        const out = await errorOf(() => engine.attach({ url: `${app.base}/`, projectDir }));
        if (out) return out;
        // The page's own fetch, sent after the cookie was set.
        for (let i = 0; i < 100 && !app.seen.some((s) => s.url === "/api/data"); i++) await new Promise((r) => setTimeout(r, 50));
        // A redirect within the app, of a page load and of a fetch: each next hop carries the header too.
        await engine.navigate(`${app.base}/home`);
        for (let i = 0; i < 100 && !app.seen.some((s) => s.url === "/signin"); i++) await new Promise((r) => setTimeout(r, 50));
        signedInAt = engine.currentUrl;
        const page = (engine as unknown as { page: Page }).page;
        fetched = await page.evaluate(() => fetch("/api/moved").then((r) => r.status)).catch((err: unknown) => String(err));
        await engine.navigate(`${app.base}/go`);
        return "";
      });
      const api = app.seen.find((s) => s.url === "/api/data");
      const hops = app.seen.filter((s) => s.url === "/home" || s.url === "/signin" || s.url === "/api/moved");
      check(
        "a redirect within the app keeps the header on its next hop, for a page load and for a fetch",
        hops.some((s) => s.url === "/signin") &&
          hops.every((s) => s.header === SECRET) &&
          app.seen.filter((s) => s.url === "/api/data").every((s) => s.header === SECRET),
        `${signedInAt} ${String(fetched)} ${JSON.stringify(app.seen)}`,
      );
      check(
        "the app's own page and its fetch carry the allowlist header, and the cookie it set still arrives beside it",
        attached === "" && app.seen[0]?.header === SECRET && api?.header === SECRET && (api?.cookie ?? "").includes("sid=one"),
        `${attached.slice(0, 200)} ${JSON.stringify(app.seen)}`,
      );
      check(
        "...and another origin never sees it: not its image, not the page a redirect from the app lands on",
        other.seen.some((s) => s.url.startsWith("/pixel.png")) && other.seen.some((s) => s.url === "/landed") && other.seen.every((s) => s.header === null),
        JSON.stringify(other.seen),
      );
      // A page load that answers with a file, behind a redirect within the app: handed back to the browser without the
      // header, so it behaves as with none and is never read whole first. The contrast is the same load with no header.
      const fileLoad = async (vars: Record<string, string>) =>
        withEnv(vars, async () => {
          await engine.attach({ url: `${app.base}/`, projectDir });
          app.seen.length = 0;
          const started = Date.now();
          const error = await errorOf(() => engine.navigate(`${app.base}/report-moved`));
          return { ms: Date.now() - started, error: error.split("\n")[0], seen: [...app.seen] };
        });
      const withHeader = await fileLoad(header);
      const without = await fileLoad({});
      const fileGets = withHeader.seen.filter((s) => s.method === "GET" && s.url === "/report.pdf");
      const heads = withHeader.seen.filter((s) => s.method === "HEAD");
      check(
        "a page load that redirects within the app to a file is handed back to the browser: the file is fetched without the header, and the load returns as it does with no header",
        fileGets.length > 0 &&
          fileGets.every((s) => s.header === null) &&
          heads.length > 0 &&
          heads.every((s) => s.header === SECRET) &&
          withHeader.ms < FILE_STREAM_MS &&
          (withHeader.error === "") === (without.error === ""),
        JSON.stringify({ withHeader, without: { ms: without.ms, error: without.error } }),
      );
      const recorded = filesUnder(projectDir).filter((f) => fs.readFileSync(f, "utf8").includes(SECRET));
      check("...and its value is in no file the session wrote", recorded.length === 0, recorded.join(", "));
    }

    // ── the retry ──
    const loads = () => app.seen.filter((s) => s.url === "/flaky").length;
    await withEnv({}, () => engine.attach({ url: `${app.base}/`, projectDir }));
    dropFrom = 0;
    app.seen.length = 0;
    const off = await errorOf(() => engine.navigate(`${app.base}/flaky`));
    check(
      "with the retry off, a load whose connection was dropped fails and is not tried again by the engine",
      off !== "" && !/retried after/.test(off),
      `${loads()} load(s); ${off.slice(0, 300)}`,
    );
    await withEnv({ SCENESCOUT_RETRY_NETWORK: "on" }, () => engine.attach({ url: `${app.base}/`, projectDir }));
    dropFrom = 0;
    app.seen.length = 0;
    let result = "";
    const on = await errorOf(async () => (result = await engine.navigate(`${app.base}/flaky`)));
    check(
      "with SCENESCOUT_RETRY_NETWORK=on, it is tried once more, loads, and the result says it was retried after the network's failure",
      on === "" && loads() >= 2 && /retried after .*the network's, not an answer from the app/.test(result),
      `${loads()} load(s); ${(on || result).slice(-400)}`,
    );

    // ── the classification ──
    await engine.crawl(["/third"], { inspect: true });
    const found = checkFindings([...engine.lastCrawlHealth], app.base);
    const failed = found.issues.filter((i) => i.rule === "request-failed" || i.rule === "console-error");
    check(
      "a script from a host that does not resolve is one network entry, of another host, and neither request-failed nor console-error",
      failed.length === 0 && found.network.length === 1 && found.network[0].what === NOWHERE_HOST && found.network[0].cause === "dns" && !found.network[0].app,
      JSON.stringify({ issues: found.issues.map((i) => `${i.rule}: ${i.evidence}`), network: found.network }),
    );
  } finally {
    await engine.close().catch(() => {});
    await relay.close();
    await app.close();
    await other.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
