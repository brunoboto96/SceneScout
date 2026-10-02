/**
 * Where a SARIF result points. GitHub code scanning keeps a result only when
 * its location is a file in the repository, so a result about a page of the
 * running app cannot point at the page itself. Each result's physical
 * location is a repository file instead, and the route travels beside it: in
 * a logical location, in the result's properties and in its message.
 *
 *  - An issue a saved flow raised points at that flow's file.
 *  - Anything else points at the anchor: --sarif-file-anchor when given, else
 *    the workflow file that is running (GITHUB_WORKFLOW_REF), else
 *    package.json when the repository has one, else README.md.
 *
 * Paths are relative to the repository root: GITHUB_WORKSPACE when it is set,
 * else the project directory. Pure, so check-test can table-test it.
 */
import path from "node:path";

/** The anchors tried, in order, when there is no option and no workflow. */
export const SARIF_ANCHOR_FALLBACKS = ["package.json", "README.md"] as const;

/** The files a SARIF file's results point at, as paths relative to the repository root. */
export interface SarifFiles {
  /** The file a result with no file of its own points at. */
  anchor: string;
  /** The directory the saved flows were read from, when it is inside the repository. */
  flowsDir?: string;
}

/** A repository-relative path with forward slashes, or an error: what --sarif-file-anchor accepts. */
export function checkSarifAnchor(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "");
  if (!value) return { ok: false, error: "--sarif-file-anchor needs a file, relative to the repository root" };
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value))
    return { ok: false, error: "--sarif-file-anchor is a path relative to the repository root, not an absolute path" };
  const parts = value.split("/");
  if (parts.includes("..")) return { ok: false, error: "--sarif-file-anchor must stay inside the repository: no .. in the path" };
  if (value.endsWith("/")) return { ok: false, error: "--sarif-file-anchor names a file, not a directory" };
  return { ok: true, value: parts.filter((p) => p !== "." && p !== "").join("/") };
}

/**
 * The workflow file in GITHUB_WORKFLOW_REF (`owner/repo/.github/workflows/x.yml@refs/heads/main`),
 * or null when the variable is unset or is not of that shape.
 */
export function workflowFileOf(ref: string | undefined): string | null {
  if (!ref) return null;
  const parts = ref.split("/");
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  // The ref after the first "@" may hold "@" itself (a branch named fix@2); the workflow's path comes before it.
  const rest = parts.slice(2).join("/");
  const at = rest.indexOf("@");
  const file = at >= 0 ? rest.slice(0, at) : rest;
  return checkSarifAnchor(file).ok ? file : null;
}

export type SarifAnchorSource = "option" | "workflow" | "fallback";

/**
 * The anchor file, where it came from, and a warning when the file it should
 * have been is not in the repository. Candidates are tried in order: the
 * option, the workflow file, then each fallback; the first that exists wins.
 * When none does, the first candidate is kept so the SARIF is still written,
 * and the warning says code scanning will drop its results.
 * `exists` is asked about repository-relative paths.
 */
export function resolveSarifAnchor(o: { option?: string; env: { GITHUB_WORKFLOW_REF?: string }; exists: (repoRelative: string) => boolean }): {
  file: string;
  source: SarifAnchorSource;
  warning?: string;
} {
  const workflow = workflowFileOf(o.env.GITHUB_WORKFLOW_REF);
  const candidates: Array<{ file: string; source: SarifAnchorSource }> = [
    ...(o.option !== undefined ? [{ file: o.option, source: "option" as const }] : []),
    ...(workflow ? [{ file: workflow, source: "workflow" as const }] : []),
    ...SARIF_ANCHOR_FALLBACKS.map((file) => ({ file, source: "fallback" as const })),
  ];
  const describe = (c: { file: string; source: SarifAnchorSource }): string =>
    c.source === "option" ? `--sarif-file-anchor ${c.file}` : c.source === "workflow" ? `the workflow file ${c.file}` : c.file;
  const chosen = candidates.find((c) => o.exists(c.file));
  // Fallbacks are tried quietly; only a file that was asked for, or the workflow running, is missed out loud.
  const missed = candidates.slice(0, chosen ? candidates.indexOf(chosen) : candidates.length).filter((c) => c.source !== "fallback");
  if (!chosen) {
    const first = candidates[0];
    return {
      ...first,
      warning: `SARIF: no anchor file exists in the repository (tried ${candidates.map(describe).join(", ")}); results point at ${first.file}, and code scanning will drop them`,
    };
  }
  if (missed.length === 0) return chosen;
  return { ...chosen, warning: `SARIF: ${missed.map(describe).join(" and ")} is not in the repository; results point at ${chosen.file} instead` };
}

/** The repository root the paths are relative to: the Actions checkout when there is one, else the project. */
export function repositoryRoot(env: { GITHUB_WORKSPACE?: string }, projectDir: string): string {
  return env.GITHUB_WORKSPACE || projectDir;
}

/** `target` relative to `root` with forward slashes, or null when it is outside it. */
export function repoRelative(root: string, target: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** The file a result points at: its flow's file when a flow raised it and the flows are in the repository, else the anchor. */
export function sarifFileFor(files: SarifFiles, flowFile?: string): string {
  return flowFile && files.flowsDir !== undefined ? (files.flowsDir ? `${files.flowsDir}/${flowFile}` : flowFile) : files.anchor;
}

/**
 * One SARIF location: a repository file code scanning can resolve, and the
 * route as a logical location of kind "resource".
 */
export function sarifLocation(file: string, route: string, message?: string): object {
  return {
    physicalLocation: { artifactLocation: { uri: file } },
    logicalLocations: [{ kind: "resource", name: route, fullyQualifiedName: route }],
    ...(message ? { message: { text: message } } : {}),
  };
}

/**
 * Everything a run's SARIF needs to know about the repository, from its
 * option, its environment and the directories it read. `exists` takes an
 * absolute path.
 */
export function sarifFilesFor(o: {
  option?: string;
  env: { GITHUB_WORKFLOW_REF?: string; GITHUB_WORKSPACE?: string };
  projectDir: string;
  /** The absolute directory the saved flows were read from, when there were any. */
  flowsDir?: string | null;
  exists: (absolute: string) => boolean;
}): SarifFiles & { source: SarifAnchorSource; warning?: string } {
  const root = repositoryRoot(o.env, o.projectDir);
  const { file, source, warning } = resolveSarifAnchor({ option: o.option, env: o.env, exists: (f) => o.exists(path.join(root, f)) });
  const flowsDir = o.flowsDir ? repoRelative(root, o.flowsDir) : null;
  return { anchor: file, source, ...(warning ? { warning } : {}), ...(flowsDir !== null ? { flowsDir } : {}) };
}
