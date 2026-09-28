/**
 * A child process for refresh-test's multi-process lock check: takes the
 * refresh lock, reads a counter, waits a moment so an unlocked writer would
 * interleave, writes it back incremented, and releases. Run by refresh-test
 * only.
 *
 *   tsx scripts/refresh-lock-child.ts <lock> <counter> <rounds>
 */
import fs from "node:fs";
import { acquireLock } from "../src/engine/refresh.ts";

const [lock, counter, rounds] = process.argv.slice(2);
if (!lock || !counter || !rounds) throw new Error("usage: refresh-lock-child <lock> <counter> <rounds>");

for (let i = 0; i < Number(rounds); i++) {
  const held = await acquireLock(lock, { waitMs: 20_000, pollMs: 5 });
  try {
    const n = Number(fs.readFileSync(counter, "utf8"));
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(counter, String(n + 1));
  } finally {
    held.release();
  }
}
