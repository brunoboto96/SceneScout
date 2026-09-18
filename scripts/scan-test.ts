/**
 * Unit tests for project scanning and state fingerprinting — including the
 * monorepo regression where a small secondary Next app (control panel) was
 * picked over the main frontend.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanProject } from "../src/scan.ts";
import { normalizePath, fingerprintState } from "../src/engine/fingerprint.ts";

let failures = 0;
function check(name: string, cond: boolean, context?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${context ? `\n    ${context}` : ""}`);
  }
}

function makeNextApp(root: string, name: string, routes: string[]): void {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, dependencies: { next: "^14.0.0", react: "^18.0.0" }, scripts: { dev: "next dev" } }));
  for (const route of routes) {
    const file = path.join(dir, "pages", route === "/" ? "index.tsx" : `${route.slice(1)}.tsx`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export default function P(){return null}");
  }
}

console.log("fingerprint normalization — UI-state params and hash routes");
check("tab param preserved", normalizePath("http://x/orders?tab=history") === "/orders?tab=history");
check("transient params dropped, tab kept", normalizePath("http://x/list?page=2&tab=b&sort=asc") === "/list?tab=b");
check("hash-router path counts as path", normalizePath("http://x/#/orders/5") === "/orders/:id");
check("hash-router with tab", normalizePath("http://x/#/settings?tab=team") === "/settings?tab=team");

console.log("fingerprint normalization");
check("numeric id normalized", normalizePath("http://x/orders/123") === "/orders/:id");
check("uuid normalized", normalizePath("http://x/doc/6f9619ff-8b86-4d01-b42d-00cf4fc964ff") === "/doc/:id");
check("long hex normalized", normalizePath("http://x/t/deadbeefdeadbeef") === "/t/:id");
check("plain routes untouched", normalizePath("http://x/admin/settings") === "/admin/settings");
check("query strings ignored", normalizePath("http://x/list?page=2") === "/list");
const fpA = fingerprintState("http://x/orders/1", [{ role: "button", name: "Save", testid: "save" }]);
const fpB = fingerprintState("http://x/orders/2", [{ role: "button", name: "Save", testid: "save" }]);
const fpC = fingerprintState("http://x/orders/1", [{ role: "button", name: "Delete", testid: "del" }]);
check("same state class → same fingerprint", fpA === fpB);
check("different actions → different fingerprint", fpA !== fpC);

console.log("monorepo workspace selection (regression: control/ vs frontend/)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ft-scan-"));
try {
  // Alphabetically 'control' comes first — the original bug picked it.
  makeNextApp(tmp, "control", ["/", "/alerts", "/tenants"]);
  makeNextApp(tmp, "frontend", ["/", "/orders", "/invoices", "/customers", "/reports", "/settings", "/admin/import"]);
  fs.mkdirSync(path.join(tmp, "docker"));

  const result = scanProject(tmp);
  check("primary workspace is the larger app", result.frontendDir === path.join(tmp, "frontend"), String(result.frontendDir));
  check("routes come from the primary app", result.routes.includes("/orders") && result.routes.length === 7, result.routes.join(","));
  check(
    "secondary workspace reported in notes",
    result.notes.some((n) => n.includes("control")),
    result.notes.join(" | "),
  );
  check(
    "full-stack marker noted",
    result.notes.some((n) => n.includes("backend running")),
    result.notes.join(" | "),
  );
  check("framework detected", result.framework === "next");

  const single = fs.mkdtempSync(path.join(os.tmpdir(), "ft-scan-single-"));
  makeNextApp(single, ".", ["/", "/about"]);
  const singleResult = scanProject(single);
  check(
    "single-app project: root is the workspace",
    singleResult.frontendDir === fs.realpathSync(single) || singleResult.frontendDir === single,
    String(singleResult.frontendDir),
  );
  fs.rmSync(single, { recursive: true, force: true });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ft-scan-empty-"));
  const emptyResult = scanProject(empty);
  check("no frontend found is reported, not thrown", emptyResult.frontendDir === null && emptyResult.notes.length > 0);
  fs.rmSync(empty, { recursive: true, force: true });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("finding lifecycle: retro-merge + resolve");
{
  const { MemoryStore } = await import("../src/engine/memory.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mem-"));
  fs.mkdirSync(path.join(dir, ".scenescout"), { recursive: true });
  const mkFinding = (id: string, title: string, evidence: string | undefined, state: string) => ({
    id,
    severity: "medium",
    category: "http-error",
    title,
    detail: "d",
    evidence,
    url: "http://x/",
    state,
    repro: [],
    foundAt: "2026-08-16T00:00:00.000Z",
    runs: 1,
  });
  fs.writeFileSync(
    path.join(dir, ".scenescout", "memory.json"),
    JSON.stringify({
      version: 1,
      states: {},
      findings: [
        mkFinding("aaa", "Dashboard calls /api/reports as User → 403", undefined, "/#x"),
        mkFinding("bbb", "Dashboard calls /api/reports for User role → 403 on every load", undefined, "/#y"),
        mkFinding("ccc", "Widget A fails 403", "GET /api/a 403", "/#x"),
        mkFinding("ddd", "Widget B fails 403", "GET /api/b 403", "/#x"),
      ],
    }),
  );
  const store = new MemoryStore(dir);
  check("retro-merge collapses paraphrased dups", store.findings.length === 3, `got ${store.findings.length}`);
  // Literal-match dedup: token overlap below threshold, but both carry "(role not recorded)".
  const [, litNew1] = store.addFinding({
    severity: "medium",
    category: "data-inconsistency",
    title: 'Order audit-trail entries display "(role not recorded)" for the acting user',
    detail: "d",
    url: "http://x/tickets/1",
    state: "/tickets/:id#a",
  });
  const [, litNew2] = store.addFinding({
    severity: "medium",
    category: "other",
    title: 'Audit-trail history entry shows "(role not recorded)" for actor',
    detail: "d2",
    url: "http://x/tickets/2",
    state: "/tickets/:id#b",
  });
  check("shared literal dedups low-overlap paraphrase", litNew1 && !litNew2);
  // Regression: same distinctive literal but DIFFERENT evidence strings must still merge.
  const [, evLit1] = store.addFinding({
    severity: "medium",
    category: "data-inconsistency",
    title: 'History rows render "(actor missing entirely)" in the trail',
    detail: "d",
    evidence: "audit-trail entry actor blank on ORD-61",
    url: "http://x/orders/1",
    state: "/orders/:id#a",
  });
  const [, evLit2] = store.addFinding({
    severity: "medium",
    category: "other",
    title: 'Trail displays "(actor missing entirely)" for each event',
    detail: "d2",
    evidence: "trail rows show placeholder instead of user",
    url: "http://x/orders/2",
    state: "/orders/:id#b",
  });
  check("shared literal overrides differing evidence", evLit1 && !evLit2);
  store.markAttempted("/admin/import", "landed:/login");
  check("attempted routes recorded", store.attemptedRoutes["/admin/import"] === "landed:/login");
  check(
    "distinct evidence NOT merged",
    store.findings.some((f: { id: string }) => f.id === "ccc") && store.findings.some((f: { id: string }) => f.id === "ddd"),
  );
  const merged = store.findings.find((f: { id: string }) => f.id === "aaa");
  check("merged finding sums runs", merged?.runs === 2, String(merged?.runs));
  store.resolveFinding("ccc");
  check("resolve marks status", store.findings.find((f: { id: string }) => f.id === "ccc")?.status === "resolved");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("App Router: organisational directories are not part of the URL");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-approuter-"));
  const app = path.join(dir, "app");
  const page = (rel: string): void => {
    const file = path.join(app, rel, "page.tsx");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export default function P(){return null}");
  };
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "approuter", dependencies: { next: "^14.0.0", react: "^18.0.0" } }));
  page("");
  page("(marketing)/about"); // route group — shares a layout, adds nothing to the URL
  page("(shop)/(promos)/sale"); // nested groups
  page("@modal/preview"); // parallel-route slot — renders into a named outlet
  page("blog/[slug]");

  const scan = scanProject(dir);
  const routes = scan.routes;
  check("route group is stripped from the URL", routes.includes("/about"), JSON.stringify(routes));
  check("nested route groups are both stripped", routes.includes("/sale"), JSON.stringify(routes));
  check("parallel-route slot is stripped", routes.includes("/preview"), JSON.stringify(routes));
  check("no route retains a bracketed group", !routes.some((r: string) => r.includes("(")), JSON.stringify(routes));
  check("no route retains an @slot", !routes.some((r: string) => r.includes("@")), JSON.stringify(routes));
  check("ordinary dynamic segments still normalize", routes.includes("/blog/:slug"), JSON.stringify(routes));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("framework detection: meta-frameworks beat the ecosystem they build on");
{
  const mk = (deps: Record<string, string>): ReturnType<typeof scanProject> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-fw-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: deps }));
    const out = scanProject(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  };
  // Each of these depends on vite and/or vue; checked in the wrong order they
  // were reported as the underlying tool, with that tool's default port.
  check("nuxt is not reported as vue", mk({ nuxt: "^3.0.0", vue: "^3.0.0" }).framework === "nuxt");
  check("sveltekit is not reported as vite", mk({ "@sveltejs/kit": "^2.0.0", vite: "^5.0.0" }).framework === "sveltekit");
  check("remix is detected", mk({ "@remix-run/react": "^2.0.0" }).framework === "remix");
  check("plain vite is still vite", mk({ vite: "^5.0.0" }).framework === "vite");
  check("next still wins over react", mk({ next: "^14.0.0", react: "^18.0.0" }).framework === "next");
}

console.log("SvelteKit route discovery");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-svelte-"));
  const routesDir = path.join(dir, "src", "routes");
  const page = (rel: string): void => {
    const file = path.join(routesDir, rel, "+page.svelte");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "<h1>p</h1>");
  };
  fs.mkdirSync(routesDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sk", devDependencies: { "@sveltejs/kit": "^2.0.0", vite: "^5.0.0" } }));
  page("");
  page("about");
  page("(app)/dashboard"); // group
  page("blog/[slug]");
  const scan = scanProject(dir);
  check("sveltekit routes are discovered at all", scan.routes.length > 0, JSON.stringify(scan.routes));
  check("sveltekit root route", scan.routes.includes("/"), JSON.stringify(scan.routes));
  check("sveltekit group stripped", scan.routes.includes("/dashboard"), JSON.stringify(scan.routes));
  check("sveltekit param normalized", scan.routes.includes("/blog/:slug"), JSON.stringify(scan.routes));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("a framework with no filesystem routes says so instead of reporting none");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-cra-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cra", dependencies: { "react-scripts": "^5.0.0", react: "^18.0.0" } }));
  const scan = scanProject(dir);
  check("no routes found for a code-routed app", scan.routes.length === 0);
  check(
    "and the scan discloses that nothing looked, rather than implying none exist",
    scan.notes.some((n: string) => n.includes("No filesystem route discovery")),
    JSON.stringify(scan.notes),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nSCAN TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nSCAN TESTS PASSED");
