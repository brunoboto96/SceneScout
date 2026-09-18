import fs from "node:fs";
import path from "node:path";

export interface ScanResult {
  projectDir: string;
  frontendDir: string | null;
  framework: string | null;
  devCommand: string | null;
  portGuess: number | null;
  routes: string[];
  authStates: string[];
  hasPlaywright: boolean;
  usesTestids: boolean;
  readmeExcerpt: string | null;
  notes: string[];
}

/**
 * What marks a package.json as a frontend workspace.
 *
 * Meta-frameworks are listed explicitly rather than relying on the UI library
 * underneath them: Nuxt supplies vue and Remix supplies react, so an app that
 * depends only on the meta-framework has neither in its own manifest — and was
 * therefore not recognised as a frontend at all, making the whole scan report
 * "No frontend workspace found" for a perfectly ordinary project.
 */
const FRONTEND_DEPS = ["next", "nuxt", "@sveltejs/kit", "@remix-run/react", "@remix-run/node", "react", "vue", "svelte", "@angular/core", "vite"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "out", "docs", "examples", "e2e-tests"]);

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isFrontendPackage(pkg: Record<string, unknown>): boolean {
  const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, string>;
  return FRONTEND_DEPS.some((d) => d in deps);
}

/** Collect every frontend workspace: the root itself and child dirs (depth ≤ 2) with a React/Vue/etc package.json. */
function findFrontendDirs(projectDir: string): string[] {
  const found: string[] = [];
  const rootPkg = readJson(path.join(projectDir, "package.json"));
  if (rootPkg && isFrontendPackage(rootPkg)) found.push(projectDir);

  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > 2) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const sub = path.join(dir, entry.name);
      const pkg = readJson(path.join(sub, "package.json"));
      if (pkg && isFrontendPackage(pkg)) found.push(sub);
      else queue.push({ dir: sub, depth: depth + 1 });
    }
  }
  return found;
}

const NAME_BONUS = ["frontend", "web", "app", "client", "ui"];

/**
 * A monorepo can hold several frontend apps (main app + admin panel + landing
 * page). Pick the primary one: most routes wins, conventional names break ties.
 */
function pickPrimary(candidates: string[]): { primary: string; others: string[] } {
  const scored = candidates.map((dir) => {
    const routeCount = nextRoutes(dir).length;
    const base = path.basename(dir).toLowerCase();
    const nameBonus = NAME_BONUS.includes(base) ? NAME_BONUS.length - NAME_BONUS.indexOf(base) : 0;
    return { dir, score: routeCount * 10 + nameBonus };
  });
  scored.sort((a, b) => b.score - a.score);
  return { primary: scored[0].dir, others: scored.slice(1).map((s) => s.dir) };
}

/**
 * Order matters: the most specific meta-framework wins. Nuxt and SvelteKit both
 * depend on vite, and Nuxt depends on vue — checked later, they were reported as
 * bare "vite"/"vue" with that ecosystem's default port instead of their own.
 */
function detectFramework(pkg: Record<string, unknown>): { framework: string | null; port: number | null } {
  const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, string>;
  if ("next" in deps) return { framework: "next", port: 3000 };
  if ("nuxt" in deps || "nuxt3" in deps) return { framework: "nuxt", port: 3000 };
  if ("@sveltejs/kit" in deps) return { framework: "sveltekit", port: 5173 };
  if ("@remix-run/react" in deps || "@remix-run/node" in deps) return { framework: "remix", port: 3000 };
  if ("@angular/core" in deps) return { framework: "angular", port: 4200 };
  if ("react-scripts" in deps) return { framework: "create-react-app", port: 3000 };
  if ("vite" in deps) return { framework: deps.react ? "vite+react" : "vite", port: 5173 };
  if ("vue" in deps) return { framework: "vue", port: 5173 };
  if ("react" in deps) return { framework: "react", port: 3000 };
  return { framework: null, port: null };
}

/**
 * SvelteKit / Nuxt file-based routes.
 *
 * Both put pages under a conventional directory and both use bracket params,
 * so one walker covers them. SvelteKit marks a page with `+page.svelte` and
 * uses `(group)` directories exactly as Next's App Router does; Nuxt treats
 * every `.vue` file as a page, with `index.vue` as the directory root.
 */
function fileRoutes(frontendDir: string, kind: "sveltekit" | "nuxt"): string[] {
  const root =
    kind === "sveltekit" ? path.join(frontendDir, "src", "routes") : firstExisting([path.join(frontendDir, "pages"), path.join(frontendDir, "app", "pages")]);
  if (!root || !fs.existsSync(root)) return [];

  const routes: string[] = [];
  const walk = (dir: string, base: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_") || ROUTE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // SvelteKit route groups, like Next's, are layout-only and contribute
        // nothing to the URL.
        const organisational = kind === "sveltekit" && /^\(.*\)$/.test(entry.name);
        walk(full, organisational ? base : `${base}/${entry.name}`);
      } else if (kind === "sveltekit" && /^\+page\.(svelte|ts|js)$/.test(entry.name)) {
        routes.push(base || "/");
      } else if (kind === "nuxt" && /\.vue$/.test(entry.name)) {
        const name = entry.name.replace(/\.vue$/, "");
        routes.push(name === "index" ? base || "/" : `${base}/${name}`);
      }
    }
  };
  walk(root, "");
  // SvelteKit spells params [id] and [...rest]; Nuxt [id] and [...slug]. Both
  // collapse to the same :param shape the rest of the engine speaks.
  return [...new Set(routes.map((r) => r.replace(/\[\.\.\.([^\]]+)\]/g, ":$1").replace(/\[([^\]]+)\]/g, ":$1")))].sort();
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Route-walk skip set — deliberately smaller than SKIP_DIRS: inside pages/ or
 * app/, directories like docs/ or examples/ are REAL routes, not artifacts.
 */
const ROUTE_SKIP_DIRS = new Set(["node_modules", "api"]);

/** Enumerate Next.js routes from pages/ or app/ directory structure. */
function nextRoutes(frontendDir: string): string[] {
  const routes: string[] = [];
  const pagesDir = path.join(frontendDir, "pages");
  const appDir = path.join(frontendDir, "app");

  const walk = (dir: string, base: string, mode: "pages" | "app"): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_") || ROUTE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // App Router organisational directories contribute NOTHING to the URL:
        // a route group `(marketing)` exists to share a layout, and a parallel
        // slot `@modal` renders into a named outlet. Concatenating them
        // produced routes like `/(marketing)/about` for a page that actually
        // lives at `/about` — a "known route" no navigation could ever reach,
        // which then sat in the completion contract forever.
        const organisational = mode === "app" && (/^\(.*\)$/.test(entry.name) || entry.name.startsWith("@"));
        walk(full, organisational ? base : `${base}/${entry.name}`, mode);
      } else if (mode === "pages" && /\.(tsx|jsx|ts|js)$/.test(entry.name)) {
        const name = entry.name.replace(/\.(tsx|jsx|ts|js)$/, "");
        routes.push(name === "index" ? base || "/" : `${base}/${name}`);
      } else if (mode === "app" && /^page\.(tsx|jsx|ts|js)$/.test(entry.name)) {
        routes.push(base || "/");
      }
    }
  };

  if (fs.existsSync(pagesDir)) walk(pagesDir, "", "pages");
  else if (fs.existsSync(appDir)) walk(appDir, "", "app");
  return routes.map((r) => r.replace(/\[([^\]]+)\]/g, ":$1")).sort();
}

function findAuthStates(frontendDir: string): string[] {
  const authDir = path.join(frontendDir, "playwright", ".auth");
  try {
    return fs
      .readdirSync(authDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(authDir, f));
  } catch {
    return [];
  }
}

function grepTestids(frontendDir: string): boolean {
  // Cheap sample: look for data-testid in a handful of component files.
  const candidates = ["components", "src/components", "src", "app", "pages"];
  for (const rel of candidates) {
    const dir = path.join(frontendDir, rel);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).slice(0, 40);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isFile() && /\.(tsx|jsx)$/.test(name)) {
          if (fs.readFileSync(file, "utf8").includes("data-testid")) return true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

export function scanProject(projectDir: string): ScanResult {
  const resolved = path.resolve(projectDir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }
  const notes: string[] = [];
  const candidates = findFrontendDirs(resolved);
  const picked = candidates.length > 0 ? pickPrimary(candidates) : null;
  const frontendDir = picked?.primary ?? null;
  if (picked && picked.others.length > 0) {
    const others = picked.others.map((d) => path.relative(resolved, d) || ".");
    notes.push(
      `Multiple frontend workspaces found — using the largest (${path.relative(resolved, frontendDir!) || "."}). ` +
        `Others: ${others.join(", ")}. Re-scan a specific one by passing its path directly.`,
    );
  }
  if (!frontendDir) {
    return {
      projectDir: resolved,
      frontendDir: null,
      framework: null,
      devCommand: null,
      portGuess: null,
      routes: [],
      authStates: [],
      hasPlaywright: false,
      usesTestids: false,
      readmeExcerpt: null,
      notes: ["No frontend workspace found (no package.json with a known frontend dependency at depth ≤ 2)."],
    };
  }
  if (frontendDir !== resolved) notes.push(`Monorepo: frontend workspace is ${path.relative(resolved, frontendDir)}/`);

  const pkg = readJson(path.join(frontendDir, "package.json")) ?? {};
  const { framework, port } = detectFramework(pkg);
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const devCommand = scripts.dev ? "dev" : scripts.start ? "start" : null;

  const routes =
    framework === "next"
      ? nextRoutes(frontendDir)
      : framework === "sveltekit"
        ? fileRoutes(frontendDir, "sveltekit")
        : framework === "nuxt"
          ? fileRoutes(frontendDir, "nuxt")
          : [];
  // Say so when filesystem discovery cannot help. Returning [] silently left
  // the agent to assume the app genuinely had no routes, when in fact nothing
  // had looked — the completion contract then rested entirely on link
  // harvesting without ever admitting it.
  if (routes.length === 0 && framework !== null && !["next", "sveltekit", "nuxt"].includes(framework)) {
    notes.push(
      `No filesystem route discovery for "${framework}" (routes are defined in code, not files) — ` +
        `the route contract will be built from links harvested during exploration. Crawl breadth depends on what the UI links to.`,
    );
  }
  const authStates = findAuthStates(frontendDir);
  const hasPlaywright = fs.existsSync(path.join(frontendDir, "playwright.config.ts")) || fs.existsSync(path.join(frontendDir, "playwright.config.js"));

  // Full-stack heuristics: launching the frontend alone probably isn't enough.
  for (const marker of ["docker-compose.yml", "docker", "Makefile", "backend"]) {
    if (fs.existsSync(path.join(resolved, marker))) {
      notes.push(`Full-stack marker found (${marker}) — the app likely needs its backend running. Prefer attaching to an already-running instance with --url.`);
      break;
    }
  }
  if (authStates.length > 0) {
    notes.push(`Playwright auth storage states found — pass one to scout_attach as storageStatePath to explore as that role.`);
  }

  let readmeExcerpt: string | null = null;
  for (const candidate of [path.join(resolved, "README.md"), path.join(frontendDir, "README.md")]) {
    try {
      readmeExcerpt = fs.readFileSync(candidate, "utf8").split("\n").slice(0, 30).join("\n");
      break;
    } catch {
      /* keep looking */
    }
  }

  return {
    projectDir: resolved,
    frontendDir,
    framework,
    devCommand,
    portGuess: port,
    routes,
    authStates,
    hasPlaywright,
    usesTestids: grepTestids(frontendDir),
    readmeExcerpt,
    notes,
  };
}

export function formatScan(result: ScanResult): string {
  const lines = [
    `Project: ${result.projectDir}`,
    `Frontend: ${result.frontendDir ?? "NOT FOUND"}`,
    `Framework: ${result.framework ?? "unknown"}${result.devCommand ? ` · dev script: "${result.devCommand}"` : ""}${result.portGuess ? ` · likely port ${result.portGuess}` : ""}`,
    `Playwright config: ${result.hasPlaywright ? "yes" : "no"} · data-testid convention: ${result.usesTestids ? "yes" : "not detected"}`,
    `Auth storage states (${result.authStates.length}): ${
      result.authStates
        .slice(0, 8)
        .map((p) => path.basename(p))
        .join(", ") || "none"
    }`,
    `Routes (${result.routes.length}):`,
    ...result.routes.slice(0, 60).map((r) => `  ${r}`),
    ...(result.routes.length > 60 ? [`  … and ${result.routes.length - 60} more`] : []),
    ...(result.notes.length > 0 ? ["Notes:", ...result.notes.map((n) => `  - ${n}`)] : []),
  ];
  return lines.join("\n");
}
