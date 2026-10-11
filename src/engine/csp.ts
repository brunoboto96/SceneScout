/**
 * The Content-Security-Policy a saved page carries in its own head.
 *
 * report.html, a recorded check's replay page and its test report are files
 * that outlive the engine and are opened straight from disk, where no server
 * sends a header. What they show came from the app under test (titles, text,
 * addresses), and every piece of it is escaped; the policy is the second line
 * behind that escaping. A page with no scripts says `script-src 'none'`; a page
 * that needs a script names that script's hash, and nothing else may run.
 *
 * Pictures and videos are files beside the page, loaded by relative path, so
 * `'self'` is all they need: the page's own origin, which is the local file
 * system for a file opened from disk and the live view for the served copy.
 * The policy keeps out anything from the network; that the pictures come from
 * beside the page is the generator's doing, which writes relative paths only.
 * Styles are inline, in the page's own `<style>` element.
 */
import crypto from "node:crypto";

/** What a page needs beyond pictures, videos and its own styles. */
export interface SavedPageNeeds {
  /** The exact text of each inline `<script>` element the page carries. */
  scripts?: readonly string[];
  /** The exact value of each inline event-handler attribute (`onerror="…"`) the page carries. */
  handlers?: readonly string[];
  /** The page fetches from where it was served (the run page asking the engine whether it is still there). */
  connect?: boolean;
}

/** A CSP hash source for an inline script or handler: `'sha256-…'` of its exact text. */
export function cspHash(source: string): string {
  return `'sha256-${crypto.createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

/** The policy for a saved page: nothing loads or runs but what the page names. */
export function savedPageCsp(needs: SavedPageNeeds = {}): string {
  const scripts = [...new Set(needs.scripts ?? [])].map(cspHash);
  const handlers = [...new Set(needs.handlers ?? [])].map(cspHash);
  // 'unsafe-hashes' lets a hash match an event-handler attribute too; only the hashes listed can run either way.
  const scriptSrc =
    scripts.length + handlers.length === 0 ? "'none'" : [...(handlers.length > 0 ? ["'unsafe-hashes'"] : []), ...scripts, ...handlers].join(" ");
  return [
    "default-src 'none'",
    "img-src 'self'",
    "media-src 'self'",
    "style-src 'unsafe-inline'",
    `script-src ${scriptSrc}`,
    ...(needs.connect ? ["connect-src 'self'"] : []),
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The `<meta>` element that carries a policy. It belongs first in `<head>`
 * after the charset: a policy applies only to what the parser meets after it.
 */
export function cspMeta(policy: string): string {
  // The policy is built here from fixed words and base64 hashes, so it holds no quote or angle bracket to escape.
  if (/["<>&]/.test(policy)) throw new Error("a Content-Security-Policy with markup characters in it is not one this module built");
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}
