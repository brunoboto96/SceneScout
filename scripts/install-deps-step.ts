/**
 * Runs an action's "Install the browser's system libraries" step in bash with
 * `id`, `sudo`, `timeout` and `dpkg` replaced by stand-ins, so a suite can
 * see each command the step would run as root and how it ends when an
 * attempt fails or runs out of time. Shared by check-test (action.yml) and
 * ci-test (ci/action.yml).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type InstallDepsRun = { status: number | null; stdout: string; calls: string[]; node: string };

/** `attempts` is how each `timeout` call ends, in order: "ok" exits 0, "stall" exits 124 as GNU timeout does. */
export function runInstallDepsStep(script: string, opts: { root: boolean; attempts: Array<"ok" | "stall"> }): InstallDepsRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-install-deps-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const log = path.join(dir, "calls.log");
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("id", `echo ${opts.root ? 0 : 1001}`);
    // sudo resets PATH to a fixed list; the stand-in records that, so a call that depends on the caller's PATH shows.
    stub("sudo", `echo "sudo $*" >> "$CALLS"; exec "$@"`);
    stub(
      "timeout",
      `echo "timeout $*" >> "$CALLS"; n=$(($(cat "$COUNT" 2>/dev/null || echo 0) + 1)); echo $n > "$COUNT"\n` +
        `outcome=$(echo "$OUTCOMES" | cut -d' ' -f$n); [ "$outcome" = ok ] && exit 0; exit 124`,
    );
    stub("dpkg", `echo "dpkg $*" >> "$CALLS"`);
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CALLS: log,
        COUNT: path.join(dir, "count"),
        OUTCOMES: opts.attempts.join(" "),
        PLAYWRIGHT_CLI: "/opt/playwright/cli.js",
        ENGINE: "chromium",
      },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    const node = spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }).stdout.trim();
    return { status: r.status, stdout: r.stdout, calls, node };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The step's contract: every attempt runs under root's `timeout`, a stalled or failed attempt is
 * tried once more after dpkg finishes what it cut off, and two failures end the step with an error
 * naming it, both attempts inside `jobMinutes` with time to spare for the error to be seen.
 */
export function assertBoundedInstallDeps(script: string, label: string, jobMinutes: number): void {
  const stalled = runInstallDepsStep(script, { root: false, attempts: ["stall", "stall"] });
  const attempts = stalled.calls.filter((c) => c.startsWith("sudo timeout "));
  assert.equal(attempts.length, 2, `${label}: a stalled attempt is tried once more, under sudo: ${stalled.calls.join(" | ")}`);
  const bound = /^sudo timeout --kill-after=(\d+) (\d+) (.+) \/opt\/playwright\/cli\.js install-deps chromium$/.exec(attempts[0]);
  assert.ok(bound, `${label}: each attempt is bounded by root's timeout: ${attempts[0]}`);
  assert.equal(bound[3], stalled.node, `${label}: node is named by path, since sudo resets PATH`);
  assert.equal(attempts[1], attempts[0], `${label}: the retry runs the same command`);
  assert.equal(stalled.calls.filter((c) => c === "sudo dpkg --configure -a").length, 2, `${label}: an install cut off part-way is finished`);
  assert.equal(stalled.status, 1, `${label}: two failed attempts fail the step`);
  assert.match(stalled.stdout, /^::error title=Install the browser's system libraries::.*install-deps/m, `${label}: the error names the step`);
  const [kill, limit] = [Number(bound[1]), Number(bound[2])];
  assert.ok(limit >= 120 && kill > 0, `${label}: an attempt gets at least two minutes and is killed if it ignores the signal`);
  assert.ok(2 * (kill + limit) <= (jobMinutes - 4) * 60, `${label}: both attempts end inside a ${jobMinutes}-minute job with minutes to spare`);

  const second = runInstallDepsStep(script, { root: false, attempts: ["stall", "ok"] });
  assert.equal(second.status, 0, `${label}: a second attempt that succeeds passes the step`);
  assert.doesNotMatch(second.stdout, /::error/, label);
  assert.equal(second.stdout.match(/::warning/g)?.length, 1, `${label}: the stalled attempt is named in a warning`);

  const first = runInstallDepsStep(script, { root: false, attempts: ["ok"] });
  assert.deepEqual(
    first.calls.filter((c) => c.startsWith("sudo ")),
    [attempts[0]],
    `${label}: a first success runs once`,
  );
  assert.equal(first.status, 0, label);

  const root = runInstallDepsStep(script, { root: true, attempts: ["stall", "stall"] });
  assert.ok(!root.calls.some((c) => c.startsWith("sudo")), `${label}: as root, sudo is not used`);
  assert.equal(root.calls.filter((c) => c.startsWith("timeout ")).length, 2, `${label}: as root, each attempt is bounded too`);
  assert.equal(root.status, 1, label);
}
