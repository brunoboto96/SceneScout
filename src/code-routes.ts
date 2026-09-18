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
/** `name` and `meta` are deliberately absent: a sidebar or breadcrumb entry is `{ path, name }` too. */
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
];

interface Frame {
  kind: "obj" | "other";
  /** Index of the nearest enclosing object frame, or -1. */
  parent: number;
  keys: Set<string>;
  path?: string;
  lazyImport?: string;
  currentKey?: string;
  /** The key of the nearest enclosing object under which this frame was opened (`children`, `meta`, …). */
  via?: string;
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
  // A ' or " string cannot span lines. When there is no closing quote before
  // the newline this is not a string at all — an apostrophe in JSX text
  // ("couldn't"), a quote inside a regex (/['"]/) — and treating it as one
  // swallowed the rest of the file, routes included.
  if (quote !== "`") {
    let k = i + 1;
    while (k < src.length && src[k] !== quote && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
    if (src[k] !== quote) return { value: null, end: i + 1 };
  }
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
      const enclosing = nearestObj();
      frames.push({ kind: isObject ? "obj" : "other", parent: enclosing, keys: new Set(), via: enclosing === -1 ? undefined : frames[enclosing].currentKey });
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
  // A record belongs to the route tree only when every object between it and
  // the top was entered through `children` (or `routes`, the router's own
  // option). `{ path, component }` under `meta.breadcrumbs` or `props.link` is
  // data carried BY a route, not a route.
  const inRouteTree = (f: Frame): boolean => {
    for (let cur: Frame | undefined = f; cur && cur.parent !== -1; cur = frames[cur.parent]) {
      if (cur.via !== "children" && cur.via !== "routes") return false;
    }
    return true;
  };
  const recordFrames = frames.map((f, index) => ({ f, index })).filter(({ f }) => f.kind === "obj" && isRecord(f) && inRouteTree(f));
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

/**
 * The source with comments blanked out, offsets preserved. `<Route>` tags are
 * found by pattern, so a commented-out route would otherwise be read as live.
 */
export function maskComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = readString(src, i).end;
      continue;
    }
    if (c === "/" && src[i + 1] === "/" && src[i - 1] !== ":") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? src.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** `<Route path="…">` elements (React Router), with their nesting. */
export function readRouteElements(source: string): RouteRecord[] {
  const src = maskComments(source);
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

/**
 * Text that marks a file as the ENTRY of a router: the place where the router
 * is created or mounted at the app's root. A relative top-level path there
 * means "relative to /".
 */
const ENTRY_MARKERS =
  /createBrowserRouter\s*\(|createHashRouter\s*\(|createMemoryRouter\s*\(|<RouterProvider\b|<BrowserRouter\b|<HashRouter\b|<MemoryRouter\b|createRouter\s*\(|new\s+VueRouter\s*\(|RouterModule\s*\.\s*forRoot\s*\(|provideRouter\s*\(/;
/**
 * `<Routes>` and `useRoutes()` mount routes wherever they are rendered — at
 * the root, or inside a component reached through a splat route
 * (`<Route path="admin/*">`). In the second case their paths are relative to
 * that parent, which this reader cannot see, so a file with only these markers
 * is trusted for relative paths only when it is the single such file in the
 * project.
 */
const MOUNT_MARKERS = /<Routes\b|useRoutes\s*\(/;
/** Angular's conventional root files: relative top-level paths there are relative to "/". */
const ANGULAR_ROOT_FILENAMES = /(^|[\\/])(app\.routes|app-routing\.module)\.(ts|js|mjs)$/;
/** Conventional names for router files in general. Read, but only their ABSOLUTE top-level paths are trusted. */
const ROUTER_FILENAMES = /(^|[\\/])(routes|router|router[\\/]index)\.(ts|tsx|js|jsx|mjs)$/;
const ROUTER_MENTION = /react-router|vue-router|@angular\/router|<Route\b|createBrowserRouter|RouterModule|provideRouter/;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
/** Matched against the path RELATIVE to the scanned root: a checkout that happens to live under a directory called `build` or `tests` must still be read. */
const SKIP = /(^|[\\/])(node_modules|dist|build|coverage|\.next|\.nuxt|\.svelte-kit|__tests__|e2e|tests?)([\\/]|$)|\.(spec|test|stories|d)\.[a-z]+$/;
/** Files read for routes. Candidates are listed first, so the budget is spent on likely router files. */
const MAX_FILES = 600;
/** Paths listed before giving up on a very large tree. */
const MAX_LISTED = 20_000;
const MAX_DEPTH = 14;
const MAX_BYTES = 400_000;
const LIKELY_ROUTER_FILE = /(^|[\\/])(app\.routes|app-routing\.module|routes|router|index|main|App|app)\.(ts|tsx|js|jsx|mjs)$|rout/i;

function sourceFiles(root: string): { files: string[]; truncated: boolean } {
  const listed: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || listed.length >= MAX_LISTED) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to read routes from
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name.startsWith(".") || SKIP.test(path.relative(root, p))) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (SOURCE_EXT.test(e.name)) listed.push(p);
    }
  };
  walk(root, 0);
  // Likely router files first; within each group, shallower paths first.
  const depthOf = (f: string): number => f.split(path.sep).length;
  listed.sort((a, b) => Number(LIKELY_ROUTER_FILE.test(b)) - Number(LIKELY_ROUTER_FILE.test(a)) || depthOf(a) - depthOf(b) || a.localeCompare(b));
  if (listed.length > MAX_FILES) truncated = true;
  return { files: listed.slice(0, MAX_FILES), truncated };
}

/** Resolve a relative import to a file INSIDE `root`. Bare and aliased specifiers, and anything outside the project, are not followed. */
function resolveImport(root: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((x) => base + x), ...["index.ts", "index.js"].map((x) => path.join(base, x))]) {
    const rel = path.relative(root, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
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

/**
 * The file that holds a lazily loaded branch's routes. Angular's classic shape
 * points `loadChildren` at an NgModule (`admin.module`) whose routes live in
 * its sibling `admin-routing.module`; the standalone shape points straight at
 * the routes file.
 */
function lazyRouteFile(root: string, fromFile: string, spec: string): string | null {
  const direct = resolveImport(root, fromFile, spec);
  if (direct) {
    const src = readSource(direct);
    if (src !== null && readRouteObjects(src).length > 0) return direct;
  }
  const sibling = /\.module$/.test(spec) ? resolveImport(root, fromFile, spec.replace(/\.module$/, "-routing.module")) : null;
  return sibling ?? null;
}

interface ReadContext {
  root: string;
  seen: Set<string>;
  /** Module specifiers of lazy branches that could not be followed. */
  unresolved: string[];
}

/** Routes of one file, following Angular `loadChildren` imports: each child file's routes are prefixed with the path of the record that loads it. */
function routesOfFile(ctx: ReadContext, file: string, prefix: string, absoluteTopOnly: boolean): string[] {
  // A child loaded under two parents keeps the first prefix only: a miss, never an invention.
  if (ctx.seen.has(file)) return [];
  ctx.seen.add(file);
  const src = readSource(file);
  if (src === null) return [];
  const records = readRouteObjects(src);
  const out = [...resolveRoutes(records, prefix, absoluteTopOnly), ...resolveRoutes(readRouteElements(src), prefix, absoluteTopOnly)];
  records.forEach((r, idx) => {
    if (!r.lazyImport) return;
    const lazyPrefix = recordPath(records, idx, prefix, absoluteTopOnly);
    if (lazyPrefix === null) return;
    // The record's own path is a page whichever way the branch resolves: it is
    // where the lazily loaded module mounts.
    out.push(lazyPrefix);
    const child = lazyRouteFile(ctx.root, file, r.lazyImport);
    if (child) out.push(...routesOfFile(ctx, child, lazyPrefix === "/" ? "" : lazyPrefix, absoluteTopOnly));
    else ctx.unresolved.push(r.lazyImport);
  });
  return out;
}

export interface CodeRouteResult {
  routes: string[];
  /** Files the routes were read from, relative to the frontend directory. */
  files: string[];
  /** Lazy branches whose routes could not be followed (an alias, a package, a file this reader could not find). */
  unresolved: string[];
  /** The tree was too large or too deep to list completely, so a router file may have been missed. */
  truncated: boolean;
}

/** Read routes from router configuration under `frontendDir`. Empty when none is recognisable. */
export function codeRoutes(frontendDir: string): CodeRouteResult {
  const srcDir = fs.existsSync(path.join(frontendDir, "src")) ? path.join(frontendDir, "src") : frontendDir;
  const { files: candidates, truncated } = sourceFiles(srcDir);
  const mentions: Array<{ file: string; src: string }> = [];
  for (const file of candidates) {
    const src = readSource(file);
    if (src !== null && ROUTER_MENTION.test(src)) mentions.push({ file, src: maskComments(src) });
  }
  const mountFiles = mentions.filter(({ src }) => MOUNT_MARKERS.test(src));
  const roots: Array<{ file: string; trusted: boolean }> = [];
  for (const { file, src } of mentions) {
    const entry = ENTRY_MARKERS.test(src) || ANGULAR_ROOT_FILENAMES.test(file);
    // The only file that mounts routes must be the root, wherever the router itself is created.
    const soleMount = MOUNT_MARKERS.test(src) && mountFiles.length === 1;
    if (entry || soleMount) roots.push({ file, trusted: true });
    else if (MOUNT_MARKERS.test(src) || ROUTER_FILENAMES.test(file)) roots.push({ file, trusted: false });
  }
  // Trusted roots first, so a child file they load lazily is claimed with its prefix before it can be read bare.
  roots.sort((a, b) => Number(b.trusted) - Number(a.trusted));
  const ctx: ReadContext = { root: frontendDir, seen: new Set(), unresolved: [] };
  const routes = new Set<string>();
  const files: string[] = [];
  for (const { file, trusted } of roots) {
    const found = routesOfFile(ctx, file, "", !trusted);
    if (found.length > 0) files.push(path.relative(frontendDir, file));
    for (const r of found) routes.add(r);
  }
  return { routes: [...routes].sort(), files, unresolved: [...new Set(ctx.unresolved)], truncated };
}
