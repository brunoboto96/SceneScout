/**
 * An operator's list of exact files: the value of a server setting such as
 * SCENESCOUT_UPLOAD_ALLOW, which names files a refusal would otherwise stop.
 * It lives in the server's environment, so the agent driving the tools cannot
 * add to it. Entries are absolute paths separated as PATH is, and match by
 * exact path (or the real path the entry leads to), never by folder or prefix.
 */
import fs from "node:fs";
import path from "node:path";

/** The settings read this way. Both are checked as the server starts (mcp-server.ts). */
export const UPLOAD_ALLOW_ENV = "SCENESCOUT_UPLOAD_ALLOW";
export const STORAGE_STATE_ALLOW_ENV = "SCENESCOUT_STORAGE_STATE_ALLOW";
export const ALLOW_PATH_SETTINGS = [UPLOAD_ALLOW_ENV, STORAGE_STATE_ALLOW_ENV] as const;
export type AllowPathSetting = (typeof ALLOW_PATH_SETTINGS)[number];

/**
 * The paths a setting names, or what is wrong with it. A relative entry is
 * refused rather than resolved against wherever the server happens to run, and
 * `~` is not expanded, as for SCENESCOUT_TICKET_DIRS. Blank entries are skipped.
 */
export function allowedPathsFrom(env: NodeJS.ProcessEnv, name: AllowPathSetting): { paths: string[] } | { error: string } {
  const paths: string[] = [];
  for (const raw of (env[name] ?? "").split(path.delimiter)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\"))
      return { error: `${name} names "${entry}", but ~ is not expanded there: write the file as an absolute path` };
    if (!path.isAbsolute(entry)) return { error: `${name} names "${entry}", which is not an absolute path` };
    paths.push(path.resolve(entry));
  }
  return { paths };
}

/** The paths a setting names; a setting that is wrong throws, since the server would not have started with it. */
export function allowedPaths(env: NodeJS.ProcessEnv, name: AllowPathSetting): string[] {
  const read = allowedPathsFrom(env, name);
  if ("error" in read) throw new Error(read.error);
  return read.paths;
}

/** Whether any candidate is one of the listed paths, comparing each entry as written and as its real path. */
export function isListedPath(allow: readonly string[], ...candidates: string[]): boolean {
  if (allow.length === 0) return false;
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const named = new Set(allow.flatMap((p) => [p, real(p)]));
  return candidates.some((c) => named.has(c));
}
