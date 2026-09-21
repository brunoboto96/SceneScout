/**
 * The contradiction oracles against real pages: a refused list rendered as an
 * empty state, and a refused save reported as a success.
 *
 * Half of this suite is about the oracles staying QUIET. A page that is
 * refused and says so is the correct behaviour, and it carries every other
 * ingredient of a contradiction — the same 403, the same empty table, the same
 * affirmation-shaped words. If the rules cannot tell those two pages apart
 * they are unusable against a real app, where most refusals are handled
 * properly and only a few are not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "contradiction oracles";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("contradiction oracles: a refusal the page does not admit to");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-contra-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "contra";
  const found = (kind: string): Array<{ url: string; detail: string }> => engine.oracleLog.all.filter((v) => v.kind === kind);

  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "safe-write" });

    // ── the page that hides its refusals ───────────────────────────────────
    await engine.navigate("/contradiction.html");
    const snap = await engine.snapshot();
    const loadRef = /(e\d+) button "Load widgets"/.exec(snap)?.[1];
    const saveRef = /(e\d+) button "Save"/.exec(snap)?.[1];
    if (!loadRef || !saveRef) throw new Error(`fixture buttons not in snapshot: ${snap.slice(0, 400)}`);

    const loaded = await engine.click(loadRef);
    check("a refused list rendered as an empty state is reported on the action that caused it", /refused_empty/.test(loaded), loaded.slice(0, 700));
    check(
      "...naming the request that was refused",
      found("refused_empty")[0]?.detail.includes("GET /api/refuse/403 403"),
      JSON.stringify(found("refused_empty")[0] ?? null),
    );
    check(
      "...and saying what the user was told instead",
      /nothing could be loaded/.test(found("refused_empty")[0]?.detail ?? ""),
      found("refused_empty")[0]?.detail ?? "(none)",
    );

    const saved = await engine.click(saveRef);
    check("a refused save reported as a success is its own violation", /false_success/.test(saved), saved.slice(0, 700));
    check(
      "...quoting the message the page showed",
      /Saved successfully/.test(found("false_success")[0]?.detail ?? ""),
      found("false_success")[0]?.detail ?? "(none)",
    );
    check(
      "...against the write that was refused, not the read",
      (found("false_success")[0]?.detail ?? "").includes("POST /api/refuse/500 500"),
      found("false_success")[0]?.detail ?? "(none)",
    );

    const before = found("refused_empty").length + found("false_success").length;
    await engine.click(loadRef);
    await engine.click(saveRef);
    check(
      "the same contradiction on the same endpoint is not reported twice",
      found("refused_empty").length + found("false_success").length === before,
      `${before} → ${found("refused_empty").length + found("false_success").length}`,
    );

    // ── the page that admits them ──────────────────────────────────────────
    // This is the check that decides whether the oracles are shippable.
    await engine.navigate("/contradiction-honest.html");
    const honestSnap = await engine.snapshot();
    const refs = {
      load: /(e\d+) button "Load gadgets"/.exec(honestSnap)?.[1],
      save: /(e\d+) button "Save"/.exec(honestSnap)?.[1],
      ok: /(e\d+) button "Load allowed list"/.exec(honestSnap)?.[1],
    };
    if (!refs.load || !refs.save || !refs.ok) throw new Error(`honest fixture buttons not in snapshot: ${honestSnap.slice(0, 400)}`);
    const baseline = found("refused_empty").length + found("false_success").length;

    const honestLoad = await engine.click(refs.load);
    check("a refused list the page admits to is not a contradiction", !/refused_empty/.test(honestLoad), honestLoad.slice(0, 700));
    const honestSave = await engine.click(refs.save);
    check("a refused save the page admits to is not a contradiction", !/false_success/.test(honestSave), honestSave.slice(0, 700));
    const genuinelyEmpty = await engine.click(refs.ok);
    check("an empty list that every request agreed to is an ordinary empty list", !/refused_empty/.test(genuinelyEmpty), genuinelyEmpty.slice(0, 700));
    check(
      "nothing new was reported across the whole honest page",
      found("refused_empty").length + found("false_success").length === baseline,
      `${baseline} → ${found("refused_empty").length + found("false_success").length}`,
    );

    // The HTTP oracle still reports every refusal on its own. The contradiction
    // rules answer a different question and must not silence it.
    check(
      "the refusals themselves are still reported by the HTTP oracle",
      engine.oracleLog.all.some((v) => v.kind === "http_error" && v.detail.includes("/api/refuse/403")),
      JSON.stringify(engine.oracleLog.all.filter((v) => v.kind === "http_error").map((v) => v.detail)),
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
