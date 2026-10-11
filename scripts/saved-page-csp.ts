/**
 * What every saved page's Content-Security-Policy is held to, shared by the
 * suites that build one (contract-test for report.html, check-test for a
 * check's replay page, report-test for its test report). The browser half,
 * that pictures still load from disk under it, is in scripts/smoke/.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** The policy a page's own `<meta http-equiv>` carries, by directive. */
export function pagePolicy(html: string): Map<string, string[]> {
  const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  assert.equal(metas.length, 1, "the page carries exactly one Content-Security-Policy");
  const policy = new Map<string, string[]>();
  for (const part of metas[0][1].split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) policy.set(name, values);
  }
  return policy;
}

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const hashOf = (code: string): string => `'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`;

/**
 * The page's policy comes first in its head, refuses everything by default,
 * lets nothing from elsewhere load, and lets run exactly the inline code the
 * page carries: each script and event handler by its hash, and nothing at all
 * on a page with none.
 */
export function assertSavedPagePolicy(html: string, label: string): void {
  const policy = pagePolicy(html);
  const head = html.slice(0, html.indexOf("</head>"));
  const at = head.indexOf('<meta http-equiv="Content-Security-Policy"');
  assert.ok(at > 0 && at < head.indexOf("<title>") && at < head.indexOf("<style>"), `${label}: the policy comes before the title and styles it governs`);
  assert.deepEqual(policy.get("default-src"), ["'none'"], `${label}: nothing loads by default`);
  assert.deepEqual(policy.get("img-src"), ["'self'"], `${label}: pictures come from beside the page only`);
  assert.deepEqual(policy.get("base-uri"), ["'none'"], `${label}: no <base> can move where relative paths point`);
  assert.deepEqual(policy.get("form-action"), ["'none'"], `${label}: no form can send anything`);
  const scriptSrc = policy.get("script-src") ?? [];
  assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.some((s) => /[*:]/.test(s)), `${label}: no blanket script source: ${scriptSrc.join(" ")}`);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map((m) => decode(m[1]));
  const needed = new Set([...scripts, ...handlers].map(hashOf));
  if (needed.size === 0) {
    assert.deepEqual(scriptSrc, ["'none'"], `${label}: a page with no scripts runs none`);
  } else {
    const allowed = scriptSrc.filter((s) => s.startsWith("'sha256-"));
    assert.deepEqual(new Set(allowed), needed, `${label}: exactly the page's own inline code may run`);
    assert.equal(scriptSrc.includes("'unsafe-hashes'"), handlers.length > 0, `${label}: handler hashes are allowed only where the page has handlers`);
  }
}
