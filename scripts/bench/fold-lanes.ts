/**
 * The planner's side of the lane-report benchmark: read every lane reply in a
 * directory, parse the ones that claim to be typed, and say how long the fold
 * took and which replies a machine could consume at all.
 *
 *   npx tsx scripts/bench/fold-lanes.ts <dir-of-replies>
 *
 * Reply files are `<name>.md` (prose) or `<name>.json` (typed); anything else
 * in the directory is skipped and said so. A prose reply cannot be folded here,
 * which is the point: it needs another model pass to become decisions, so it
 * is only measured.
 */
import fs from "node:fs";
import path from "node:path";
import { parseLaneReport, summarizeLaneReport } from "../../src/engine/lane.ts";
import { benchDir, printTable, tokens } from "./table.ts";

const dir = benchDir("usage: fold-lanes.ts <dir-of-replies>");
const rows: string[][] = [];
for (const file of fs.readdirSync(dir).sort()) {
  if (!/\.(md|json)$/.test(file)) {
    console.error(`${file}: not a reply, skipped`);
    continue;
  }
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  if (file.endsWith(".json")) {
    const started = process.hrtime.bigint();
    const r = parseLaneReport(text);
    const micros = Number(process.hrtime.bigint() - started) / 1000;
    rows.push([
      file,
      "typed",
      String(text.length),
      `~${tokens(text)}`,
      r.ok ? "parsed" : `REFUSED: ${r.reason}`,
      `${micros.toFixed(0)} µs`,
      r.ok ? summarizeLaneReport(r.report) : "—",
    ]);
  } else {
    rows.push([file, "prose", String(text.length), `~${tokens(text)}`, "needs a model pass", "—", "—"]);
  }
}
printTable(["reply", "shape", "chars", "tokens", "machine fold", "fold time", "what the planner learns"], rows);
