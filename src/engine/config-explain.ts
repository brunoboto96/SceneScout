/**
 * `scenescout config explain [--project dir]`: every setting of the operator's
 * config file as an attach or a command would run under it, and where each
 * value came from (a default, a preset, the operator's file, the project's
 * own file, an environment variable).
 *
 * Nothing here resolves a setting by a rule of its own. The files are read by
 * readCommandPolicy (the launch file, SCENESCOUT_CONFIG, the project's own file
 * that may only tighten, the projectsRoot fence), the environment and the
 * ceilings are applied by resolveSettings and writeRulesSettings, which the
 * attach and the commands call. What is added is the account of where a value
 * came from, which those functions do not keep, and the lines it is printed as.
 * A file that is not valid stops it with exit 2, as it stops an attach.
 *
 * It starts no browser and sends nothing. No key holds a secret, but an
 * `authPosts` entry is an address, so each printed entry loses a user name and
 * password and has a token in its query masked, as every other line the engine
 * writes.
 */
import path from "node:path";
import { flagName, readFlagValue } from "./args.js";
import { evidenceSettings, type EvidenceMode } from "./capture.js";
import { READ_POSTS_ENV, readPostsSetting } from "./policy.js";
import {
  CONFIG_KEYS,
  parsePolicy,
  PRESET_POLICY,
  readCommandPolicy,
  resolveSettings,
  writeRulesSettings,
  type ConfigKey,
  type LoadedPolicy,
  type Policy,
  type PolicyReader,
  type Preset,
} from "./project-config.js";
import { redactSecrets } from "./redact.js";

/** The options `scenescout config explain` takes. */
export const CONFIG_EXPLAIN_OPTION_NAMES = ["project"] as const;

/** Exit codes: 0 explained, 2 the config could not be read or is not valid. */
export const EXIT_CONFIG = { explained: 0, couldNotExplain: 2 } as const;

/** The command line of `scenescout config explain`; the first argument is the action, `explain`. */
export function parseConfigArgs(args: readonly string[]): { ok: true; project?: string } | { ok: false; error: string } {
  const [action, ...rest] = args;
  if (action !== "explain")
    return {
      ok: false,
      error:
        action === undefined
          ? "say what to do: scenescout config explain"
          : action.startsWith("--")
            ? `unknown option --${flagName(action)}`
            : `unknown action ${action}: the one action is explain`,
    };
  let project: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) return { ok: false, error: `unexpected argument ${a}` };
    const name = flagName(a);
    if (!(CONFIG_EXPLAIN_OPTION_NAMES as readonly string[]).includes(name)) return { ok: false, error: `unknown option --${name}` };
    const read = readFlagValue(rest, i);
    if (!read.ok) return read;
    i = read.last;
    project = read.value;
  }
  return { ok: true, project };
}

/** What a key is when nothing sets it, as the rows say it. */
const UNSET: Record<ConfigKey, string> = {
  preset: "none",
  maxMode: "no limit",
  requireGuidedPlan: "false",
  readPosts: "no limit",
  trustedEmbeds: "no limit",
  dedup: "no limit",
  evidence: "no limit",
  uploads: "project",
  egress: "all",
  projectsRoot: "no limit",
  writeClassifier: "standard",
  refuseDestructiveGets: "false",
  authPosts: "no list (sign-in is recognised by its path)",
};

/** One layer of the config: a file, the keys it sets itself and the preset it started from. */
export interface ConfigLayer {
  /** The label the rows name it by: "operator file" or "project file". */
  label: string;
  file: string;
  policy: Policy;
  /** The keys the file names, whatever their value. */
  named: ConfigKey[];
  preset?: Preset;
}

export interface ConfigRow {
  key: ConfigKey;
  /** The value the settings resolve to, as printed. */
  value: string;
  /** Where it came from. */
  source: string;
}

export interface ConfigExplanation {
  /** The files read, in the order read. */
  files: string[];
  rows: ConfigRow[];
  /** A value the files or the environment asked for that a setting lowered or left out. */
  notes: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `text` with the user name and password taken out of every address in it: `https://user:pw@host/p` reads `https://host/p`. */
export function withoutUserinfo(text: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf("://"); at >= 0; at = text.indexOf("://", from)) {
    const start = at + 3;
    let end = start;
    // The authority ends at a path, query, fragment, quote or space; a user name or password may hold none of them unescaped.
    while (end < text.length && !"/?#\"' \t\r\n,;".includes(text[end])) end++;
    const authority = text.slice(start, end);
    out += text.slice(from, start) + authority.slice(authority.lastIndexOf("@") + 1);
    from = end;
  }
  return out + text.slice(from);
}

/** Text as printed: no credential in an address, a token or secret masked as every other line the engine writes. */
export function shown(text: string): string {
  return redactSecrets(withoutUserinfo(text));
}

/** An entry of a list as printed. */
export function shownEntry(entry: string): string {
  return shown(entry.trim());
}

function shownValue(key: ConfigKey, value: unknown): string {
  if (value === undefined) return UNSET[key];
  if (Array.isArray(value)) return value.length === 0 ? "[] (none)" : value.map((e) => shownEntry(String(e))).join(", ");
  return shown(String(value));
}

/**
 * A layer's own account of a key: the file when it names it, the preset when
 * the preset sets it, else nothing.
 */
function originIn(layer: ConfigLayer | undefined, key: ConfigKey): string | null {
  if (!layer) return null;
  if (layer.named.includes(key)) return layer.label;
  if (layer.preset && key in PRESET_POLICY[layer.preset]) return `${layer.label}'s preset "${layer.preset}"`;
  return null;
}

/**
 * Where each key of `joined` came from. `operator` and `project` are the two
 * layers; `joined` is what readCommandPolicy made of them. The project's file
 * is named as the source only when it changed the value, since it can only
 * tighten: a value it repeats is the operator's.
 */
export function explainConfig(input: {
  operator?: ConfigLayer;
  project?: ConfigLayer;
  loaded: LoadedPolicy;
  env: Record<string, string | undefined>;
}): ConfigExplanation {
  const { operator, project, loaded, env } = input;
  const notes: string[] = [];
  const resolved = resolveSettings(loaded, env, {}, { mode: "read-only", evidence: () => evidenceSettings(undefined, env).mode as EvidenceMode }, "command");
  notes.push(...resolved.notes);
  const rules = writeRulesSettings(loaded.policy, env, false);
  notes.push(...rules.notes);
  const rows: ConfigRow[] = [];
  const policy = loaded.policy as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (key === "preset") {
      const presets = [operator, project].flatMap((l) => (l?.preset ? [`${l.label}: ${l.preset}`] : []));
      rows.push({ key, value: presets.length > 0 ? presets.join(", ") : UNSET.preset, source: presets.length > 0 ? "the files" : "default" });
      continue;
    }
    const fromOperator = originIn(operator, key);
    const operatorValue = (operator?.policy as Record<string, unknown> | undefined)?.[key];
    const fromProject = originIn(project, key);
    let value: unknown = policy[key];
    let source: string;
    if (value === undefined) source = "default";
    else if (fromProject && !same(operatorValue, value)) source = fromOperator ? `${fromProject}, tightening the ${fromOperator}` : fromProject;
    else source = fromOperator ?? "default";
    // The environment's part, as the attach and the commands apply it.
    if (key === "writeClassifier") {
      value = rules.writeClassifier;
      if (rules.from.writeClassifier && rules.from.writeClassifier !== "the SceneScout config") source = `environment ${rules.from.writeClassifier}`;
      else if (!rules.from.writeClassifier && policy[key] === undefined) source = "default";
    } else if (key === "refuseDestructiveGets") {
      value = rules.refuseDestructiveGets;
      if (rules.from.refuseDestructiveGets && rules.from.refuseDestructiveGets !== "the SceneScout config")
        source = `environment ${rules.from.refuseDestructiveGets}`;
    } else if (key === "authPosts") {
      value = rules.authPosts?.entries;
      const via = rules.from.authPosts;
      if (via && via !== "the SceneScout config")
        source = via.includes("narrowed by") ? `${source}, narrowed by ${via.split("narrowed by ")[1]}` : `environment ${via}`;
    } else if (key === "readPosts") {
      if (resolved.settings.readPosts !== undefined) {
        value = resolved.settings.readPosts;
        if (policy.readPosts && readPostsSetting(undefined, env[READ_POSTS_ENV]).length > 0) source += `, narrowed by ${READ_POSTS_ENV}`;
      } else {
        const fromEnv = readPostsSetting(undefined, env[READ_POSTS_ENV]);
        if (fromEnv.length > 0) {
          value = fromEnv;
          source = `environment ${READ_POSTS_ENV}`;
        }
      }
    } else if (key === "maxMode" && value === undefined) {
      source = "default";
    }
    rows.push({ key, value: shownValue(key, value), source });
  }
  return { files: loaded.sources, rows, notes };
}

/** The explanation as lines: the files read, one line per key, then what was lowered. */
export function formatConfigExplanation(e: ConfigExplanation): string[] {
  const out: string[] = [];
  out.push(e.files.length === 0 ? "Config files: none (every setting is as it is without a file)" : `Config files: ${e.files.join(", ")}`);
  const width = Math.max(...e.rows.map((r) => r.key.length));
  for (const r of e.rows) out.push(`  ${r.key.padEnd(width)}  ${r.value}  (${r.source})`);
  if (e.notes.length > 0) {
    out.push("Lowered or left out:");
    for (const n of e.notes) out.push(`  ${n}`);
  }
  out.push("A project's own file and an argument can only tighten these.");
  return out;
}

/** A layer of the config from a file readCommandPolicy already checked: its policy, the keys its text names and its preset. */
function layerOf(label: string, file: string, fsx: PolicyReader): ConfigLayer {
  const text = fsx.read(file);
  const parsed = parsePolicy(text, file);
  if (!parsed.ok) throw new Error(parsed.error);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    label,
    file,
    policy: parsed.policy,
    named: CONFIG_KEYS.filter((k) => k in raw),
    preset: typeof raw.preset === "string" ? (raw.preset as Preset) : undefined,
  };
}

/**
 * The command, given its arguments and what it reads and writes through.
 * Returns the exit code (EXIT_CONFIG). Every failure is one line starting
 * `scenescout config:`.
 */
export function runConfigCommand(
  args: readonly string[],
  io: {
    env: Record<string, string | undefined>;
    launchDir: string;
    reader: PolicyReader;
    out: (line: string) => void;
    err: (line: string) => void;
  },
): number {
  const fail = (message: string): number => {
    io.err(`scenescout config: ${shown(message)}`);
    return EXIT_CONFIG.couldNotExplain;
  };
  const parsed = parseConfigArgs(args);
  if (!parsed.ok) return fail(parsed.error);
  const projectDir = path.resolve(io.launchDir, parsed.project ?? ".");
  try {
    const read = readCommandPolicy(io.env, io.launchDir, projectDir, io.reader);
    if (!read.ok) return fail(read.error);
    const loaded = read.loaded;
    // The first source is the operator's file; a second is the project's own.
    const [operatorFile, projectFile] = loaded.sources;
    const operator = operatorFile ? layerOf("operator file", operatorFile, io.reader) : undefined;
    const project = projectFile ? layerOf("project file", projectFile, io.reader) : undefined;
    for (const line of formatConfigExplanation(explainConfig({ operator, project, loaded, env: io.env }))) io.out(line);
    return EXIT_CONFIG.explained;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
