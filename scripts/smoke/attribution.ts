/**
 * Who an oracle's finding belongs to, in a real browser. Each case runs on a
 * pair of fixture pages that differ in the one fact that decides it:
 *
 *   - a scout_request probe's refusal is the tester's, the same refusal
 *     fetched by the page is the page's (replay-target*.html);
 *   - a "Save" whose router moves the page late is not a silent submit, one
 *     that does nothing is (late-route*.html), and so is one the page
 *     answers with validation errors or a dialog (silent-submit.html);
 *   - a link click that throws while its page puts up a confirmation is a
 *     router cancelling the route change, the same throw with nothing on
 *     screen is a crash (route-cancel*.html).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "oracle attribution";

const SILENT_NOTE = /submit-style click fired ZERO network requests/;

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("oracle attribution: the tester's probes, a late client-side route, a cancelled route change");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-attr-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "attribution";
  const logged = () => engine.oracleLog.all.length;
  const since = (n: number) => engine.oracleLog.all.slice(n);
  const describe = (vs: Array<{ kind: string; severity: string; detail: string }>) =>
    JSON.stringify(vs.map((v) => `${v.severity} ${v.kind}: ${v.detail.slice(0, 90)}`));
  const refFor = (snap: string, label: string): string => {
    const ref = new RegExp(`(e\\d+) (?:button|link) "${label}"`).exec(snap)?.[1];
    if (!ref) throw new Error(`"${label}" not in snapshot: ${snap.slice(0, 400)}`);
    return ref;
  };

  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "safe-write" });

    // ── the tester's own probes ─────────────────────────────────────────────
    await engine.navigate("/replay-target.html");
    const beforeProbes = logged();
    const probe = await engine.apiRequest({ method: "GET", path: "/api/refuse/403?probe=boundary" });
    check("the probe's own result shows the refusal", /403/.test(probe), probe.slice(0, 300));
    await engine.apiRequest({ method: "GET", path: "/api/refuse/404?probe=boundary" });
    const landed = await engine.navigate("/replay-target.html");
    const fromProbes = since(beforeProbes).filter((v) => v.kind === "http_error" || v.kind === "console_error");
    check(
      "refused scout_request probes are not the next page's http_error or console_error",
      fromProbes.length === 0,
      describe(fromProbes) + landed.slice(0, 300),
    );
    check("...nor in that action's result", !/http_error|console_error/.test(landed), landed.slice(0, 500));

    const beforeOwn = logged();
    const own = await engine.navigate("/replay-target-fetches.html");
    check(
      "the same 403 fetched by the page itself is still the page's http_error",
      since(beforeOwn).some((v) => v.kind === "http_error" && v.detail.includes("/api/refuse/403?probe=boundary")),
      describe(since(beforeOwn)) + own.slice(0, 300),
    );

    // ── a router that moves the page after the settle ──────────────────────
    await engine.navigate("/late-route.html");
    let snap = await engine.snapshot();
    const moved = await engine.click(refFor(snap, "Save"));
    check("a Save whose router moves the page late is not called a silent submit", !SILENT_NOTE.test(moved), moved.slice(0, 500));
    check("...and the result says where the page went", /moved client-side to .*step=next/.test(moved), moved.slice(0, 500));

    await engine.navigate("/late-route-idle.html");
    snap = await engine.snapshot();
    const idle = await engine.click(refFor(snap, "Save"));
    check("a Save that does nothing at all still gets the silent-submit note", SILENT_NOTE.test(idle), idle.slice(0, 500));
    // The same kind of silent click, answered on the page instead of by a request.
    await engine.navigate("/silent-submit.html");
    snap = await engine.snapshot();
    const invalid = await engine.click(refFor(snap, "Save"));
    check("a Save answered by validation errors is not called a silent submit", !SILENT_NOTE.test(invalid), invalid.slice(0, 500));
    check("...and the result says validation answered", /Client-side validation answered/.test(invalid), invalid.slice(0, 500));
    const draft = await engine.click(refFor(snap, "Save draft"));
    check("a Save draft on the same page that does nothing still gets the silent-submit note", SILENT_NOTE.test(draft), draft.slice(0, 500));
    const sign = await engine.click(refFor(snap, "Complete and sign"));
    check(
      "a submit-shaped button that opens a dialog is not called a silent submit",
      !SILENT_NOTE.test(sign) && /opened a dialog/.test(sign),
      sign.slice(0, 500),
    );
    const told = await engine.click(refFor(snap, "Send note"));
    check('...but one that only puts up a native alert("Saved!") still gets the note', SILENT_NOTE.test(told), told.slice(0, 500));

    await engine.navigate("/late-route-idle.html");
    // In full: a revisited route is otherwise a diff, which lists no unchanged control.
    snap = await engine.snapshot(true);
    const verify = await engine.click(refFor(snap, "Verify"));
    check('a button whose test id holds "sign" inside "assignee" is not submit-style', !SILENT_NOTE.test(verify), verify.slice(0, 500));

    // ── a router cancelling a route change ──────────────────────────────────
    await engine.navigate("/route-cancel.html");
    snap = await engine.snapshot();
    const beforeCancel = logged();
    const cancelled = await engine.click(refFor(snap, "Next record"));
    const cancel = since(beforeCancel).find((v) => v.kind === "page_error");
    check(
      "a link click that throws while its page asks to confirm is a medium page_error with a note",
      cancel?.severity === "medium" && /router cancelling the route change/.test(cancel.detail),
      describe(since(beforeCancel)) + cancelled.slice(0, 300),
    );

    await engine.navigate("/route-cancel-crash.html");
    snap = await engine.snapshot();
    const beforeCrash = logged();
    const crashed = await engine.click(refFor(snap, "Next record"));
    const crash = since(beforeCrash).find((v) => v.kind === "page_error");
    check(
      "the same throw with no confirmation stays a high page_error",
      crash?.severity === "high" && !/router/.test(crash.detail),
      describe(since(beforeCrash)) + crashed.slice(0, 300),
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
