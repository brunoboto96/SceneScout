#!/usr/bin/env node
/**
 * Copy the version from package.json into .claude-plugin/plugin.json.
 *
 * Claude Code only offers a plugin update when the plugin's own version
 * changes, so the two must move together. Runs as part of `npm run version`,
 * right after Changesets has bumped package.json. `--check` exits non-zero
 * instead of writing, for the test suite.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const pluginPath = path.join(root, ".claude-plugin", "plugin.json");
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));

if (plugin.version === pkg.version) process.exit(0);
if (process.argv.includes("--check")) {
  console.error(`plugin.json is at ${plugin.version} but package.json is at ${pkg.version} — run: node scripts/sync-plugin-version.mjs`);
  process.exit(1);
}
plugin.version = pkg.version;
fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`plugin.json → ${pkg.version}`);
