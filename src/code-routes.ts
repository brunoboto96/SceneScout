/**
 * Route discovery for frameworks that define routes in CODE rather than in the
 * filesystem: React Router, Vue Router and Angular.
 *
 * Without this, those projects fell back to link discovery, so a page nothing
 * linked to was outside the completion contract. The three routers share two
 * shapes — route records written as object literals (`{ path, children }`) and,
 * for React, `<Route path>` elements — so one reader covers them.
 *
 * It is a static READER, not an evaluator, and it prefers missing a route to
 * inventing one: an invented route becomes a page the contract demands and the
 * app does not have. So it only reads files that are recognisably router
 * configuration, only accepts object literals that look like route records,
 * and skips anything it cannot resolve (identifiers, spreads, computed paths).
 */
import fs from "node:fs";
import path from "node:path";

/** Keys that make an object literal with a `path` a route record rather than, say, a build config. */
const ROUTE_RECORD_KEYS = [
  "element",
  "Component",
  "component",
  "components",
  "children",
  "loadComponent",
  "loadChildren",
  "lazy",
  "loader",
  "redirect",
  "redirectTo",
  "index",
  "name",
  "meta",
  "canActivate",
];

interface Frame {
  kind: "obj" | "other";
  /** Index of the nearest enclosing object frame, or -1. */
  parent: number;
  keys: Set<string>;
  path?: string;
  lazyImport?: string;
  currentKey?: string;
}

export interface RouteRecord {
  /** The record's own `path` value, as written. */
  path: string;
  /** Index into the returned list of the nearest enclosing route record, or -1. */
  parent: number;
  /** A record that only redirects: its path prefixes its children but is not itself a page. */
  redirectOnly: boolean;
  /** Module specifier of a lazily imported child route file (Angular `loadChildren`). */
  lazyImport?: string;
}

/** Read a JS string literal starting at `i` (which points at the quote). Returns the value and the index after it, or null for a template literal with interpolation. */
function readString(src: string, i: number): { value: string | null; end: number } {
  const quote = src[i];
  let j = i + 1;
  let value = "";
  let interpolated = false;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") {
      value += src[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (quote === "`" && src[j] === "$" && src[j + 1] === "{") interpolated = true;
    value += src[j];
    j += 1;
  }
  return { value: interpolated ? null : value, end: j + 1 };
}

/** Route records written as object literals, in source order, with their nesting. */
export function readRouteObjects(src: string): RouteRecord[] {
  const frames: Frame[] = [];
  const stack: number[] = [];
  let lastSignificant = "";
  let i = 0;
  const nearestObj = (): number => {
    for (let k = stack.length - 1; k >= 0; k--) if (frames[stack[k]].kind === "obj") return stack[k];
    return -1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const { value, end } = readString(src, i);
      const owner = nearestObj();
      const top = stack[stack.length - 1];
      if (owner !== -1 && value !== null) {
        const f = frames[owner];
        // A quoted KEY: `'path': '/x'`.
        let k = end;
        while (k < src.length && /\s/.test(src[k])) k += 1;
        if (top === owner && (lastSignificant === "{" || lastSignificant === ",") && src[k] === ":") {
          f.currentKey = value;
          f.keys.add(value);
        } else if (top === owner && f.currentKey === "path" && lastSignificant === ":") {
          f.path = value;
        } else if (f.currentKey === "loadChildren" && /import\s*\(\s*$/.test(src.slice(Math.max(0, i - 12), i))) {
          f.lazyImport = value;
        }
      }
      lastSignificant = "s";
      i = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      // `{` opens an object literal when it follows something a value can follow.
      const isObject = c === "{" && /[[(,:=?]|^$|r/.test(lastSignificant === "return" ? "r" : lastSignificant);
      frames.push({ kind: isObject ? "obj" : "other", parent: nearestObj(), keys: new Set() });
      stack.push(frames.length - 1);
      lastSignificant = c;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      const idx = stack.pop();
      void idx;
      lastSignificant = c;
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      const owner = nearestObj();
      const top = stack[stack.length - 1];
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k += 1;
      if (owner !== -1 && top === owner && (lastSignificant === "{" || lastSignificant === ",")) {
        if (src[k] === ":") {
          frames[owner].currentKey = word;
          frames[owner].keys.add(word);
        } else if (src[k] === "," || src[k] === "}") {
          frames[owner].keys.add(word); // shorthand property, e.g. `{ path, component }` — no literal to read
          frames[owner].currentKey = undefined;
        }
      }
      lastSignificant = word === "return" ? "return" : "w";
      i = j;
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }

  // Keep the frames that are route records, in source order, and re-link parents among them.
  const isRecord = (f: Frame): boolean => f.path !== undefined && ROUTE_RECORD_KEYS.some((k) => f.keys.has(k));
  const recordFrames = frames.map((f, index) => ({ f, index })).filter(({ f }) => f.kind === "obj" && isRecord(f));
  const position = new Map(recordFrames.map(({ index }, pos) => [index, pos]));
  return recordFrames.map(({ f }) => {
    let p = f.parent;
    while (p !== -1 && !position.has(p)) p = frames[p].parent;
    const redirectOnly =
      (f.keys.has("redirect") || f.keys.has("redirectTo")) &&
      !["element", "Component", "component", "components", "loadComponent", "lazy"].some((k) => f.keys.has(k));
    return { path: f.path as string, parent: p === -1 ? -1 : (position.get(p) as number), redirectOnly, lazyImport: f.lazyImport };
  });
}

/** `<Route path="…">` elements (React Router), with their nesting. */
export function readRouteElements(src: string): RouteRecord[] {
  const out: RouteRecord[] = [];
  const open: number[] = [];
  const tagRe = /<\/?Route\b/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    if (m[0].startsWith("</")) {
      open.pop();
      continue;
    }
    // Scan to the end of the opening tag, stepping over `{…}` expressions and
    // strings: `element={<Orders />}` contains a `>` that is not the tag's own.
    let i = m.index + m[0].length;
    let depth = 0;
    let attrs = "";
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        const { end } = readString(src, i);
        attrs += src.slice(i, end);
        i = end;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
      attrs += c;
      i += 1;
    }
    const selfClosing = attrs.trimEnd().endsWith("/");
    const pathAttr = /(?:^|\s)path\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/.exec(attrs);
    const isIndex = /(?:^|\s)index(?=[\s/>=]|$)/.test(attrs);
    const parent = open.length > 0 ? open[open.length - 1] : -1;
    let self = -1;
    if (pathAttr || isIndex) {
      out.push({ path: pathAttr ? (pathAttr[1] ?? pathAttr[2] ?? pathAttr[3] ?? pathAttr[4] ?? "") : "", parent, redirectOnly: false });
      self = out.length - 1;
    }
    // A pathless layout route still nests its children under ITS parent.
    if (!selfClosing) open.push(self === -1 ? parent : self);
    tagRe.lastIndex = i + 1;
  }
  return out;
}

const tidy = (p: string): string => `/${p}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");

/** The absolute path of one record, or null when it (or an ancestor) is a wildcard. */
export function recordPath(records: RouteRecord[], idx: number, prefix = "", absoluteTopOnly = false): string | null {
  const r = records[idx];
  if (/[*]/.test(r.path)) return null;
  // An absolute child path is absolute (React Router and Vue Router both allow it).
  if (r.path.startsWith("/")) return tidy(r.path);
  // A relative path at the top of a file that is not provably the router's
  // root has an unknown parent; joining it onto "/" would invent a page.
  if (r.parent === -1 && absoluteTopOnly) return null;
  const base = r.parent === -1 ? prefix : recordPath(records, r.parent, prefix, absoluteTopOnly);
  return base === null ? null : tidy(`${base}/${r.path}`);
}

/** Join nested route records into absolute paths. Wildcards, redirect-only records and lazily loaded parents are not pages themselves. */
export function resolveRoutes(records: RouteRecord[], prefix = "", absoluteTopOnly = false): string[] {
  const out = new Set<string>();
  records.forEach((r, idx) => {
    if (r.redirectOnly || r.lazyImport) return;
    const p = recordPath(records, idx, prefix, absoluteTopOnly);
    if (p !== null) out.add(p);
  });
  return [...out];
}

/** Text that marks a file as the ROOT of a router configuration, where a relative top-level path means "relative to /". */
const ROOT_MARKERS =
  /createBrowserRouter\s*\(|createHashRouter\s*\(|createMemoryRouter\s*\(|useRoutes\s*\(|<Routes\b|<BrowserRouter\b|<HashRouter\b|createRouter\s*\(|new\s+VueRouter\s*\(|RouterModule\s*\.\s*forRoot\s*\(|provideRouter\s*\(/;
/** Angular's conventional root files: relative top-level paths there are relative to "/". */
const ANGULAR_ROOT_FILENAMES = /(^|[\\/])(app\.routes|app-routing\.module)\.(ts|js|mjs)$/;
/** Conventional names for router files in general. Accepted as roots, but only their ABSOLUTE top-level paths are trusted. */
const ROUTER_FILENAMES = /(^|[\\/])(routes|router|router[\\/]index)\.(ts|tsx|js|jsx|mjs)$/;
const ROUTER_MENTION = /react-router|vue-router|@angular\/router|<Route\b|createBrowserRouter|RouterModule|provideRouter/;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIP = /(^|[\\/])(node_modules|dist|build|coverage|\.next|\.nuxt|\.svelte-kit|__tests__|e2e|tests?)([\\/]|$)|\.(spec|test|stories|d)\.[a-z]+$/;
const MAX_FILES = 600;
const MAX_BYTES = 400_000;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to read routes from
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (SKIP.test(p) || e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (SOURCE_EXT.test(e.name) && out.length < MAX_FILES) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((x) => base + x), ...["index.ts", "index.js"].map((x) => path.join(base, x))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function readSource(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Routes of one file, following Angular `loadChildren` imports: each child file's routes are prefixed with the path of the record that loads it. */
function routesOfFile(file: string, prefix: string, seen: Set<string>, absoluteTopOnly = false): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const src = readSource(file);
  if (src === null) return [];
  const records = readRouteObjects(src);
  const out = [...resolveRoutes(records, prefix, absoluteTopOnly), ...resolveRoutes(readRouteElements(src), prefix, absoluteTopOnly)];
  records.forEach((r, idx) => {
    if (!r.lazyImport) return;
    const child = resolveImport(file, r.lazyImport);
    const lazyPrefix = recordPath(records, idx, prefix, absoluteTopOnly);
    if (child && lazyPrefix !== null) out.push(...routesOfFile(child, lazyPrefix === "/" ? "" : lazyPrefix, seen));
  });
  return out;
}

export interface CodeRouteResult {
  routes: string[];
  /** Files the routes were read from, relative to the frontend directory. */
  files: string[];
}

/** Read routes from router configuration under `frontendDir`. Empty when none is recognisable. */
export function codeRoutes(frontendDir: string): CodeRouteResult {
  const srcDir = fs.existsSync(path.join(frontendDir, "src")) ? path.join(frontendDir, "src") : frontendDir;
  // A file is a trusted root when it visibly mounts a router, or follows
  // Angular's root naming. A file that is merely CALLED routes/router is read
  // too, but only its absolute paths count.
  const roots: Array<{ file: string; trusted: boolean }> = [];
  for (const file of sourceFiles(srcDir)) {
    const src = readSource(file);
    if (src === null || !ROUTER_MENTION.test(src)) continue;
    if (ROOT_MARKERS.test(src) || ANGULAR_ROOT_FILENAMES.test(file)) roots.push({ file, trusted: true });
    else if (ROUTER_FILENAMES.test(file)) roots.push({ file, trusted: false });
  }
  // Trusted roots first, so a child file they load lazily is claimed with its prefix before it can be read bare.
  roots.sort((a, b) => Number(b.trusted) - Number(a.trusted));
  const seen = new Set<string>();
  const routes = new Set<string>();
  const files: string[] = [];
  for (const { file: f, trusted } of roots) {
    const found = routesOfFile(f, "", seen, !trusted);
    if (found.length > 0) files.push(path.relative(frontendDir, f));
    for (const r of found) routes.add(r);
  }
  return { routes: [...routes].sort(), files };
}
