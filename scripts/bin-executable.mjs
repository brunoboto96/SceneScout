// Marks every `bin` target in package.json executable. `tsc` writes them as 0644, and a
// rebuild after `npm link` would otherwise leave the linked command unrunnable.
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const target of Object.values(pkg.bin ?? {})) {
  const file = new URL(`../${target}`, import.meta.url);
  fs.chmodSync(file, fs.statSync(file).mode | 0o111);
}
