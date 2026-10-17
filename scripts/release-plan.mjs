#!/usr/bin/env node
/**
 * Whether the release workflow publishes this commit's version, and under which npm dist-tag.
 * ADR 27 records why: the job that publishes runs none of this repository's code, so the
 * decision is made here, in the build job that holds no token, and handed to it as outputs.
 *
 * Plain JavaScript with no dependencies: the workflow runs it before `npm ci`.
 *
 *   node scripts/release-plan.mjs     read package.json, .changeset/pre.json and what npm has,
 *                                     and write version, dist-tag and publish as step outputs
 *
 * It reads DRY_RUN ("true" for a rehearsal) and NPM_PUBLISH (the repository variable).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// npm refuses a dist-tag that is itself a version or a range; Changesets' prerelease tags are words.
const DIST_TAG = /^[A-Za-z][0-9A-Za-z._-]*$/;

/**
 * The dist-tag `changeset publish` would use: the prerelease tag while .changeset/pre.json exists,
 * otherwise `latest`. (Changesets also publishes to `latest` a package npm holds only prereleases
 * of; this package has had normal releases since 1.0.0, so that case cannot arise.)
 * @param {{ tag?: unknown } | null} preState the parsed .changeset/pre.json, or null when there is none
 */
export function distTagFor(preState) {
  if (preState == null) return "latest";
  const tag = preState.tag;
  if (typeof tag !== "string" || !DIST_TAG.test(tag)) throw new Error(`.changeset/pre.json names no usable tag: ${JSON.stringify(tag)}`);
  return tag;
}

/**
 * The decision. A real run publishes exactly when npm lacks the version, so a version a failed run
 * left unpublished is published by the next run on main, and one npm already has is never sent
 * again. A rehearsal always goes through to `npm publish --dry-run` with the current version.
 * @param {{ version: string, published: string[], preState: { tag?: unknown } | null, dryRun: boolean, publishEnabled: boolean }} input
 * @returns {{ version: string, distTag: string, publish: boolean, reason: string }}
 */
export function releasePlan({ version, published, preState, dryRun, publishEnabled }) {
  if (!SEMVER.test(version)) throw new Error(`package.json's version is not a release version: ${JSON.stringify(version)}`);
  const distTag = distTagFor(preState);
  const base = { version, distTag };
  if (dryRun) return { ...base, publish: true, reason: `rehearsal: npm publish --dry-run of ${version} under "${distTag}"` };
  if (!publishEnabled) return { ...base, publish: false, reason: "the repository variable NPM_PUBLISH is not enabled" };
  if (published.includes(version)) return { ...base, publish: false, reason: `npm already has ${version}` };
  return { ...base, publish: true, reason: `npm does not have ${version}: publishing it under "${distTag}"` };
}

/**
 * The versions npm has of a package, from `npm view <name> versions --json`. A package npm has never
 * seen has none; any other failure (the registry unreachable, a refused request) throws, so the
 * workflow stops rather than guess.
 * @param {string} stdout what npm printed
 * @param {boolean} failed whether npm exited non-zero
 * @returns {string[]}
 */
export function parseVersions(stdout, failed) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`npm view printed no JSON: ${stdout.slice(0, 200)}`);
  }
  if (failed || (json && typeof json === "object" && !Array.isArray(json))) {
    if (json?.error?.code === "E404") return [];
    throw new Error(`npm view failed: ${json?.error?.code ?? "no code"} ${json?.error?.summary ?? ""}`.trim());
  }
  if (typeof json === "string") return [json];
  if (Array.isArray(json) && json.every((v) => typeof v === "string")) return json;
  throw new Error(`npm view printed an unexpected list of versions: ${stdout.slice(0, 200)}`);
}

function npmVersions(name) {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return parseVersions(out, false);
  } catch (err) {
    if (typeof err?.stdout === "string" && err.stdout.trim()) return parseVersions(err.stdout, true);
    throw err;
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const prePath = path.join(root, ".changeset", "pre.json");
  const preState = fs.existsSync(prePath) ? JSON.parse(fs.readFileSync(prePath, "utf8")) : null;
  const dryRun = process.env.DRY_RUN === "true";
  const publishEnabled = process.env.NPM_PUBLISH === "enabled";
  // A rehearsal and a switched-off publish need no answer from npm.
  const published = dryRun || !publishEnabled ? [] : npmVersions(pkg.name);
  const p = releasePlan({ version: pkg.version, published, preState, dryRun, publishEnabled });
  console.log(`release plan: ${p.publish ? "publish" : "nothing to publish"} (${p.reason})`);
  const out = process.env.GITHUB_OUTPUT;
  if (!out) throw new Error("GITHUB_OUTPUT is not set");
  fs.appendFileSync(out, `version=${p.version}\ndist-tag=${p.distTag}\npublish=${p.publish}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exitCode = main();
