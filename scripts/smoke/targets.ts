/**
 * Where a path goes when the session attached on a page below the root.
 * A path starting with `/` names a page on the origin, as URL rules read it,
 * so `/page2.html` is the same page whether the session attached on `/` or
 * on `/account/checkout.html`. Navigation, a crawl and a replayed flow all
 * resolve it that way, and a full URL on the origin is used as given.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "targets from a sub-path attach";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("targets: paths resolve against the origin, not the page the session attached on");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-targets-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "targets";
  try {
    await engine.attach({ url: `${baseUrl}/account/checkout.html`, projectDir, mode: "read-only" });

    const nav = await engine.navigate("/page2.html");
    const landed = new URL(engine.currentUrl || "about:blank").pathname;
    check("a session attached on a sub-path page navigates /page2.html to /page2.html", landed === "/page2.html", `${landed}\n${nav}`);
    check("...and the page answered, not the server's 404", !/HTTP 404/.test(nav), nav);

    const crawled = await engine.crawl(["/page2.html", `${baseUrl}/index.html`]);
    check(
      "a crawl visits the path and the full same-origin URL as given, both answering 200",
      /^\/page2\.html — 200 /m.test(crawled) && new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/index\\.html — 200 `, "m").test(crawled),
      crawled,
    );

    // The crawl ended on /index.html, so a page at /page2.html is the step's doing. The old join answered 404, a failed step.
    const replay = await engine.replayFlow([
      { action: "navigate", target: "/page2.html" },
      { action: "expect-url", pattern: "^/page2\\.html$" },
    ]);
    check("a replayed flow's navigate step lands on /page2.html too", replay.outcome.status === "passed", JSON.stringify(replay.outcome));

    const fenced = await engine.navigate("//elsewhere.invalid/x");
    check("a protocol-relative URL to another host is refused by the fence", /REFUSED/.test(fenced) && /fenced/.test(fenced), fenced);
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
