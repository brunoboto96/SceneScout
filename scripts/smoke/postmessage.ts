/**
 * The postMessage-token oracle against real pages: a token posted with
 * targetOrigin "*" is reported in the result of the navigation that loaded
 * the page; the same token posted to the page's own origin is not, and
 * neither is a "*" message with no credential in it. The token itself never
 * appears in a tool result or the oracle log.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "postmessage oracle";

/** The fixtures' invented token, built by the same recipe as the pages build it. */
function fixtureToken(): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [part({ alg: "HS256", typ: "JWT" }), part({ sub: "demo-user", scope: "read write", exp: 4102444800 }), "c2lnbmF0dXJlLWludmVudGVkLWZvci10ZXN0cw"].join(
    ".",
  );
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("postmessage oracle: a token posted to any origin");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-postmessage-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "postmessage";
  const found = (): Array<{ url: string; detail: string; severity: string }> => engine.oracleLog.all.filter((v) => v.kind === "postmessage_token");
  const token = fixtureToken();
  const [, claims, signature] = token.split(".");
  // No part of the token past the four characters the preview allows: not the whole, not its claims, not its signature.
  const leaks = (text: string): boolean => text.includes(token) || text.includes(claims) || text.includes(signature);
  const outputs: string[] = [];
  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });

    const honest = await engine.navigate("/postmessage-token-origin.html");
    outputs.push(honest);
    check("the token posted to the page's own origin is not reported", !/postmessage_token/.test(honest) && found().length === 0, honest.slice(0, 500));

    const plain = await engine.navigate("/postmessage-plain.html");
    outputs.push(plain);
    check('a "*" message with no token in it is not reported', !/postmessage_token/.test(plain) && found().length === 0, plain.slice(0, 500));

    const leaked = await engine.navigate("/postmessage-token.html");
    outputs.push(leaked);
    check(
      'the same token posted with targetOrigin "*" is reported by the navigation that loaded the page',
      /postmessage_token/.test(leaked),
      leaked.slice(0, 700),
    );
    const v = found()[0];
    check(
      "the violation names the shape, the path and a masked preview, at high severity",
      v !== undefined &&
        v.severity === "high" &&
        /^jwt token at data\.access_token \("eyJh…" \(\d+ chars\)\)/.test(v.detail) &&
        v.detail.includes(`(${token.length} chars)`),
      JSON.stringify(v ?? null),
    );

    const again = await engine.snapshot();
    outputs.push(again);
    const reloaded = await engine.navigate("/postmessage-token.html");
    outputs.push(reloaded);
    check("the same page is reported once, not on every load", found().length === 1, JSON.stringify(found()));

    const everything = [...outputs, JSON.stringify(engine.oracleLog.all)].join("\n");
    check("the token never appears in a tool result or the oracle log", !leaks(everything), found()[0]?.detail ?? "(none)");
  } finally {
    await engine.close();
  }
}
