#!/usr/bin/env node
/**
 * Build the desktop extension bundle (.mcpb) from the compiled engine.
 *
 *   npm run build && npm run mcpb
 *
 * An MCPB bundle is a zip archive with a manifest.json at its root, the
 * server's files and, for a Node server, its production node_modules: the
 * desktop app runs the server with its own Node and installs nothing. The
 * manifest is desktop-extension/manifest.json, whose version install-test holds
 * equal to package.json's.
 *
 * Writes .mcpb-build/scenescout-<version>.mcpb. The staging folder beside it is
 * what the archive holds, so it can be inspected or validated with the MCPB
 * command line tool. Needs `zip` on PATH (macOS and Linux have it).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".mcpb-build");
const stage = path.join(outDir, "stage");

function fail(message) {
  console.error(`build-mcpb: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "desktop-extension", "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  fail(`desktop-extension/manifest.json is version ${manifest.version} and package.json is ${pkg.version}; run scripts/sync-plugin-version.mjs`);
}
if (!fs.existsSync(path.join(root, manifest.server.entry_point))) {
  fail(`${manifest.server.entry_point} is missing: run \`npm run build\` first`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// What the npm package ships (package.json "files"), plus the lock file so the
// bundle holds exactly the dependency versions the release was tested with.
// The server reads its playbook from skills/, so that folder is not optional.
for (const entry of ["dist", "skills", "README.md", "LICENSE", "package.json", "package-lock.json"]) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// --ignore-scripts: no dependency's install script runs, and the package's own
// `prepare` (a TypeScript build the bundle does not need) is skipped too.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stage,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (install.status !== 0) fail(`npm ci in the staging folder exited ${install.status ?? install.error?.message ?? "without finishing"}`);
fs.rmSync(path.join(stage, "package-lock.json"));

const file = path.join(outDir, `scenescout-${pkg.version}.mcpb`);
// -X leaves out file attributes that differ between machines.
const zip = spawnSync("zip", ["-r", "-q", "-X", file, "."], { cwd: stage, stdio: "inherit" });
if (zip.error)
  fail(
    `could not run zip (${zip.error.message}); install it, or pack the staging folder with the MCPB tool: npx @anthropic-ai/mcpb pack ${path.relative(root, stage)}`,
  );
if (zip.status !== 0) fail(`zip exited ${zip.status}`);

const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
console.log(`Built ${path.relative(root, file)} (${mb} MB)`);
