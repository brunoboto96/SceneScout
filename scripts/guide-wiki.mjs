#!/usr/bin/env node
/**
 * Turn the guide in docs/guide/ into GitHub wiki pages.
 *
 *   node scripts/guide-wiki.mjs --src docs/guide --out <dir> --repo owner/name --ref v3.14.0
 *
 * The guide is written to read correctly in the repository, where a page links
 * to another as `Signing-in.md` and to the rest of the repository by a relative
 * path (`../ci.md`). On the wiki a page is addressed without its extension, and
 * nothing outside the wiki exists, so each link is rewritten:
 *
 * - a link to another guide page loses `.md` (`Signing-in.md#x` → `Signing-in#x`);
 * - a relative link to anything else in the repository becomes an absolute link
 *   to that file at the ref being published, so it opens the version the page
 *   describes;
 * - absolute URLs, `#anchors` and anything inside code are left alone.
 *
 * Plain Node with no dependencies: the workflow runs it without `npm ci`, in a
 * step that holds no token. guide-test imports `toWikiPage` and table-tests it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the guide lives in the repository; relative links are resolved from here. */
export const GUIDE_DIR = "docs/guide";

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Rewrite one page's links for the wiki. `pages` is the set of guide file
 * names (`Home.md`, …); `repo` is `owner/name`; `ref` the tag or branch.
 */
export function toWikiPage(text, { pages, repo, ref }) {
  const lines = text.split("\n");
  let fence = null;
  return lines
    .map((line) => {
      const opener = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && line.trim() === opener[1]) fence = null;
        return line;
      }
      if (opener) {
        fence = opener[1];
        return line;
      }
      // Split out inline code spans so a `[x](y)` inside backticks is not a link.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 === 1 ? part : rewriteLinks(part, pages, repo, ref)))
        .join("");
    })
    .join("\n");
}

function rewriteLinks(text, pages, repo, ref) {
  return text.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (whole, open, target, close) => {
    if (EXTERNAL.test(target)) return whole;
    const hash = target.indexOf("#");
    const file = hash >= 0 ? target.slice(0, hash) : target;
    const anchor = hash >= 0 ? target.slice(hash) : "";
    if (!file.includes("/") && pages.has(file)) return `${open}${file.replace(/\.md$/, "")}${anchor}${close}`;
    const resolved = path.posix.normalize(path.posix.join(GUIDE_DIR, file));
    if (resolved.startsWith("..")) throw new Error(`link leaves the repository: ${target}`);
    return `${open}https://github.com/${repo}/blob/${ref}/${resolved}${anchor}${close}`;
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`usage: guide-wiki.mjs --src dir --out dir --repo owner/name --ref ref (at ${name})`);
    out[name.slice(2)] = value;
  }
  for (const need of ["src", "out", "repo", "ref"]) if (!out[need]) throw new Error(`--${need} is required`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(out.repo)) throw new Error(`--repo is not owner/name: ${out.repo}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(out.ref)) throw new Error(`--ref is not a tag or branch name: ${out.ref}`);
  return out;
}

function main() {
  const { src, out, repo, ref } = parseArgs(process.argv.slice(2));
  const files = fs.readdirSync(src).filter((f) => f.endsWith(".md"));
  if (!files.includes("Home.md")) throw new Error(`${src} has no Home.md: the wiki's front page would be missing`);
  const pages = new Set(files);
  fs.mkdirSync(out, { recursive: true });
  for (const file of files) {
    const text = fs.readFileSync(path.join(src, file), "utf8");
    fs.writeFileSync(path.join(out, file), toWikiPage(text, { pages, repo, ref }));
  }
  console.log(`Wrote ${files.length} page(s) to ${out}: ${files.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`guide-wiki: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
