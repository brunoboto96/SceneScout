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
 *
 * The plugin's server launch line is pinned to the same release
 * (`npx -y scenescout@<version> serve`), so a plugin install runs the version
 * it was released with rather than whatever npm calls latest on each launch.
 * The copy-paste launch lines in the README, the guide's client setups and the
 * skill's by-hand line carry the same pin and move with it; install-test holds
 * them equal to the package version.
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
  const before = JSON.stringify(json);
  json.version = pkg.version;
  const server = json.mcpServers?.[pkg.name];
  if (server?.command === "npx") server.args = ["-y", `${pkg.name}@${pkg.version}`, "serve"];
  if (JSON.stringify(json) === before) continue;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${relative} → ${pkg.version}`);
}

// Copy-paste launch lines: `npx -y scenescout@<version> serve`, and the same
// pair written as a config file's argument list (`"scenescout@<version>", "serve"`).
const LAUNCH_PIN = /scenescout@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?="?,? ?"?serve)/g;
for (const relative of ["README.md", path.join("docs", "guide", "Start-here.md"), path.join("skills", "scenescout", "SKILL.md")]) {
  const file = path.join(root, relative);
  const text = fs.readFileSync(file, "utf8");
  const next = text.replace(LAUNCH_PIN, `${pkg.name}@${pkg.version}`);
  if (next === text) continue;
  fs.writeFileSync(file, next);
  console.log(`${relative} → ${pkg.version}`);
}
