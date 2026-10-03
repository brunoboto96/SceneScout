#!/usr/bin/env node
/**
 * Copy the version from package.json into .claude-plugin/plugin.json, the
 * optional mod's manifest (mods/scenescout-mod/.claude-plugin/plugin.json) and
 * the desktop extension's manifest (desktop-extension/manifest.json).
 *
 * Claude Code only offers a plugin update when the plugin's own version
 * changes, and the mod is a plugin of its own; a desktop extension shows the
 * version its manifest names. All three must move with the package. Runs as part of `npm run version-packages`,
 * right after Changesets has bumped package.json. install-test asserts the
 * versions are equal.
 *
 * The files are rewritten with JSON.stringify, which lays arrays out
 * differently from Prettier, so `version-packages` runs Prettier over them
 * afterwards. Without that the generated version pull request fails the format
 * check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

for (const relative of [
  path.join(".claude-plugin", "plugin.json"),
  path.join("mods", "scenescout-mod", ".claude-plugin", "plugin.json"),
  path.join("desktop-extension", "manifest.json"),
]) {
  const file = path.join(root, relative);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (json.version === pkg.version) continue;
  json.version = pkg.version;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${relative} → ${pkg.version}`);
}
