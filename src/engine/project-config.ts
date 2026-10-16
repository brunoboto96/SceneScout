/**
 * The operator's SceneScout config: a committed JSON file that sets what an
 * agent may and may not loosen (issue #546).
 *
 * Over MCP an agent chooses its own scout_attach arguments, and every
 * environment variable loses to an argument. This file is the one place a
 * team sets a rule the agent cannot override:
 *
 *   - **File over environment over arguments, for anything that loosens.** A
 *     setting the file caps is a ceiling. An argument may only ask for the
 *     same or less, and an attach whose argument asks for more is refused,
 *     with the reason. A value from the environment, or a default, above the
 *     ceiling is lowered to it, with a note.
 *   - **No file is today's behaviour.** Every key is optional, and a key left
 *     out leaves its setting as it was.
 *   - **A bad file stops the server or the command as it starts**, naming the
 *     key. Nothing in it is guessed at or skipped.
 *
 * Where it is read from (readLaunchPolicy): the file `SCENESCOUT_CONFIG` names,
 * else `.scenescout/config.json` in the directory the server or command was
 * started in. The project's own `.scenescout/config.json` is read too, at
 * attach, and may only tighten what that file allows (tightenPolicy): the
 * agent chooses the project folder, so a file there cannot be a lock on its
 * own.
 *
 * The reading is passed in (fsPolicyReader is the real one), so every rule
 * is table-tested in policy-test.
 */
import fs from "node:fs";
import path from "node:path";
import { READ_POSTS_ENV, readPostEntries, readPostsSetting, stricterMode, trustedEmbedOrigins, type WriteMode, WRITE_MODES } from "./policy.js";
import { EVIDENCE_MODES, type EvidenceMode } from "./capture.js";
import { DEDUP_ENV, DEDUP_MODES, type DedupMode } from "./ci.js";
import { flagName } from "./args.js";
import { CONFIG_FILE_NAME, MEMORY_DIRNAME } from "./memory-dir.js";

/** The environment variable naming the operator's config file, read before the launch directory's. */
export const CONFIG_ENV = "SCENESCOUT_CONFIG";

/** Where the config file sits in a directory: beside the project's other SceneScout files. */
export const CONFIG_FILE = path.join(MEMORY_DIRNAME, CONFIG_FILE_NAME);

/** The presets a file may start from. */
export const PRESETS = ["strict"] as const;
export type Preset = (typeof PRESETS)[number];

/** The keys a config file may set; any other key is refused. */
export const CONFIG_KEYS = ["preset", "maxMode", "requireGuidedPlan", "readPosts", "trustedEmbeds", "dedup", "evidence"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** The most entries a list setting may hold, as for the arguments it caps. */
const MAX_LIST = 20;

/**
 * What a config file sets, after its preset is expanded. A key that is
 * undefined leaves the setting as it is without a file.
 */
export interface Policy {
  /** The loosest write mode any attach or command may run in. */
  maxMode?: WriteMode;
  /** Open the guided gate (ADR 24) as the server starts: an attach above observe needs an accepted guided plan. */
  requireGuidedPlan?: boolean;
  /** The only POST endpoints an attach may name as reads, and the ones it gets when it names none. [] allows none. */
  readPosts?: string[];
  /** The only embedded-frame origins an attach may trust, and the ones it gets when it names none. [] allows none. */
  trustedEmbeds?: string[];
  /** The most the dedup setting may be: "rule" keeps the model judge off. */
  dedup?: DedupMode;
  /** The most a finding's picture may do: "file" keeps pictures out of the conversation, "off" takes none. */
  evidence?: EvidenceMode;
}

/** A policy with where it came from, for every message that names it. */
export interface LoadedPolicy {
  policy: Policy;
  /** The files it was read from, in the order read. Empty when there is no file. */
  sources: string[];
}

/** No file: every setting as it is without one. */
export const NO_POLICY: LoadedPolicy = { policy: {}, sources: [] };

/** What each preset sets. A key the file sets beside the preset replaces the preset's value for that key. */
export const PRESET_POLICY: Record<Preset, Required<Policy>> = {
  strict: {
    maxMode: "observe",
    requireGuidedPlan: true,
    readPosts: [],
    trustedEmbeds: [],
    dedup: "rule",
    evidence: "file",
  },
};

/** Evidence modes from the least that leaves the machine to the most. */
const EVIDENCE_ORDER: readonly EvidenceMode[] = ["off", "file", "inline"];
/** Dedup modes from the least that leaves the machine to the most. */
const DEDUP_ORDER: readonly DedupMode[] = ["rule", "judge"];

const below = <T>(order: readonly T[], a: T, b: T): T => (order.indexOf(a) <= order.indexOf(b) ? a : b);

const quoted = (list: readonly string[]): string => list.map((v) => `"${v}"`).join(", ");

/**
 * A config file's text, checked and with its preset expanded. Every problem
 * is an error naming the file and the key, so the person who wrote it can
 * fix it; an unknown key is refused rather than ignored, since a misspelt
 * lock that did nothing would look like a lock.
 */
export function parsePolicy(text: string, source: string): { ok: true; policy: Policy } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `${source}: ${why}` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return bad(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad('must be a JSON object, such as {"preset": "strict"}');
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !(CONFIG_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0)
    return bad(`unknown key${unknown.length > 1 ? "s" : ""} ${quoted(unknown)}. The keys are ${quoted(CONFIG_KEYS)} (see the configuration reference)`);

  const oneOf = <T extends string>(key: ConfigKey, allowed: readonly T[]): { ok: true; value?: T } | { ok: false; error: string } => {
    const v = obj[key];
    if (v === undefined) return { ok: true };
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
      return bad(`"${key}" must be one of ${quoted(allowed)}, not ${JSON.stringify(v)}`);
    return { ok: true, value: v as T };
  };
  const list = (key: ConfigKey, check: (entries: string[]) => string[]): { ok: true; value?: string[] } | { ok: false; error: string } => {
    const v = obj[key];
    if (v === undefined) return { ok: true };
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) return bad(`"${key}" must be a list of strings, such as [] for none`);
    if (v.length > MAX_LIST) return bad(`"${key}" may hold at most ${MAX_LIST} entries`);
    const rejected = check(v as string[]);
    if (rejected.length > 0) return bad(`"${key}" has entries that are not valid: ${quoted(rejected)}`);
    return { ok: true, value: (v as string[]).map((e) => e.trim()) };
  };

  const preset = oneOf("preset", PRESETS);
  if (!preset.ok) return preset;
  const maxMode = oneOf("maxMode", WRITE_MODES);
  if (!maxMode.ok) return maxMode;
  const dedup = oneOf("dedup", DEDUP_MODES);
  if (!dedup.ok) return dedup;
  const evidence = oneOf("evidence", EVIDENCE_MODES);
  if (!evidence.ok) return evidence;
  if (obj.requireGuidedPlan !== undefined && typeof obj.requireGuidedPlan !== "boolean") return bad(`"requireGuidedPlan" must be true or false`);
  const readPosts = list("readPosts", (entries) => readPostEntries(entries).rejected);
  if (!readPosts.ok) return readPosts;
  const trustedEmbeds = list("trustedEmbeds", (entries) => trustedEmbedOrigins(entries).rejected);
  if (!trustedEmbeds.ok) return trustedEmbeds;

  const base: Policy = preset.value ? structuredClone(PRESET_POLICY[preset.value]) : {};
  const set: Policy = {
    maxMode: maxMode.value,
    requireGuidedPlan: obj.requireGuidedPlan as boolean | undefined,
    readPosts: readPosts.value,
    trustedEmbeds: trustedEmbeds.value,
    dedup: dedup.value,
    evidence: evidence.value,
  };
  for (const [k, v] of Object.entries(set)) if (v !== undefined) (base as Record<string, unknown>)[k] = v;
  return { ok: true, policy: base };
}

/** A read-post entry in one spelling, so "post  /api/x/" and "POST /api/x" are one entry. */
function readPostKey(entry: string): string {
  const m = /^\s*POST\s+(\S+)\s*$/i.exec(entry);
  return m ? `POST ${m[1].replace(/(?<=.)\/$/, "")}` : entry.trim();
}

/** An embed origin in one spelling, as trustedEmbedOrigins writes it. */
function embedKey(entry: string): string {
  return trustedEmbedOrigins([entry]).origins[0] ?? entry.trim();
}

/** The entries of `inner` in `outer`, kept in `inner`'s order. */
function intersect(inner: readonly string[], outer: readonly string[], key: (e: string) => string): string[] {
  const allowed = new Set(outer.map(key));
  return inner.filter((e) => allowed.has(key(e)));
}

/**
 * Two policies as one, each setting the stricter of the two. The project's
 * own file is joined to the operator's this way, so it can tighten what the
 * operator's file allows and never loosen it.
 */
export function tightenPolicy(a: Policy, b: Policy): Policy {
  const out: Policy = {};
  if (a.maxMode || b.maxMode) out.maxMode = a.maxMode && b.maxMode ? stricterMode(a.maxMode, b.maxMode) : (a.maxMode ?? b.maxMode);
  if (a.requireGuidedPlan !== undefined || b.requireGuidedPlan !== undefined)
    out.requireGuidedPlan = a.requireGuidedPlan === true || b.requireGuidedPlan === true;
  if (a.readPosts || b.readPosts) out.readPosts = a.readPosts && b.readPosts ? intersect(b.readPosts, a.readPosts, readPostKey) : (a.readPosts ?? b.readPosts);
  if (a.trustedEmbeds || b.trustedEmbeds)
    out.trustedEmbeds = a.trustedEmbeds && b.trustedEmbeds ? intersect(b.trustedEmbeds, a.trustedEmbeds, embedKey) : (a.trustedEmbeds ?? b.trustedEmbeds);
  if (a.dedup || b.dedup) out.dedup = a.dedup && b.dedup ? below(DEDUP_ORDER, a.dedup, b.dedup) : (a.dedup ?? b.dedup);
  if (a.evidence || b.evidence) out.evidence = a.evidence && b.evidence ? below(EVIDENCE_ORDER, a.evidence, b.evidence) : (a.evidence ?? b.evidence);
  return out;
}

/** What reading the config needs from the filesystem, passed in so the rule is tested without one. */
export interface PolicyReader {
  exists(file: string): boolean;
  read(file: string): string;
  /** The file's real path, so one file reached two ways is read once. */
  realpath(file: string): string;
}

/** The filesystem, for the server and the commands. */
export const fsPolicyReader: PolicyReader = {
  exists: (file) => fs.existsSync(file),
  read: (file) => fs.readFileSync(file, "utf8"),
  realpath: (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  },
};

/**
 * The operator's config: the file CONFIG_ENV names (which must exist), else
 * CONFIG_FILE in `launchDir` when there is one, else none. Read once, as the
 * server or command starts.
 */
export function readLaunchPolicy(
  env: Record<string, string | undefined>,
  launchDir: string,
  fsx: PolicyReader,
): { ok: true; loaded: LoadedPolicy } | { ok: false; error: string } {
  const named = (env[CONFIG_ENV] ?? "").trim();
  if (named) {
    if (!path.isAbsolute(named)) return { ok: false, error: `${CONFIG_ENV} must be an absolute path to a JSON file, not "${named}"` };
    if (!fsx.exists(named)) return { ok: false, error: `${CONFIG_ENV} names "${named}", which is not there` };
    return readOne(named, fsx);
  }
  const file = path.join(launchDir, CONFIG_FILE);
  if (!fsx.exists(file)) return { ok: true, loaded: NO_POLICY };
  return readOne(file, fsx);
}

function readOne(file: string, fsx: PolicyReader): { ok: true; loaded: LoadedPolicy } | { ok: false; error: string } {
  let text: string;
  try {
    text = fsx.read(file);
  } catch (err) {
    return { ok: false, error: `${file}: could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = parsePolicy(text, file);
  return parsed.ok ? { ok: true, loaded: { policy: parsed.policy, sources: [file] } } : parsed;
}

/**
 * The operator's config joined with the project's own file, when the project
 * has one that is not the operator's file itself. The project's file can only
 * tighten (tightenPolicy).
 */
export function withProjectPolicy(
  launch: LoadedPolicy,
  projectDir: string,
  fsx: PolicyReader,
): { ok: true; loaded: LoadedPolicy } | { ok: false; error: string } {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!fsx.exists(file)) return { ok: true, loaded: launch };
  const real = fsx.realpath(file);
  if (launch.sources.some((s) => fsx.realpath(s) === real)) return { ok: true, loaded: launch };
  const project = readOne(file, fsx);
  if (!project.ok) return project;
  return { ok: true, loaded: { policy: tightenPolicy(launch.policy, project.loaded.policy), sources: [...launch.sources, file] } };
}

/** What an attach or a command asked for, before the config is applied. Undefined: not asked. */
export interface AskedSettings {
  mode?: WriteMode;
  readPosts?: readonly string[];
  trustedEmbeds?: readonly string[];
  dedup?: DedupMode;
  evidence?: EvidenceMode;
}

/** The settings a run uses, with the config applied. Undefined: as without a config (the argument, else the environment, else the default). */
export interface EffectiveSettings {
  mode: WriteMode;
  readPosts?: string[];
  trustedEmbeds?: string[];
  dedup?: DedupMode;
  evidence?: EvidenceMode;
  requireGuidedPlan: boolean;
}

/** One argument the config refused, and why. */
export interface Refusal {
  key: keyof AskedSettings;
  why: string;
}

/** What a setting is when nothing names it, where the config needs it to cap a default. */
export interface Defaults {
  mode: WriteMode;
  /** The evidence mode the run would use with no argument (capture.ts evidenceSettings). */
  evidence: () => EvidenceMode;
}

/**
 * The settings a run uses: the config (`policy`), then the environment, then
 * what was asked (`asked`), where each later one may only tighten.
 *
 * - An argument above a ceiling, or naming an entry outside a list the file
 *   sets, is refused: `refused` says which and why, and the caller refuses
 *   the attach or the command rather than lowering it quietly.
 * - A value from the environment, or a default, above a ceiling is lowered to
 *   it, and `notes` says so.
 * - A setting the file leaves out is passed through as asked.
 */
export function resolveSettings(
  loaded: LoadedPolicy,
  env: Record<string, string | undefined>,
  asked: AskedSettings,
  defaults: Defaults,
): { settings: EffectiveSettings; refused: Refusal[]; notes: string[] } {
  const { policy } = loaded;
  const refused: Refusal[] = [];
  const notes: string[] = [];
  const settings: EffectiveSettings = { mode: asked.mode ?? defaults.mode, requireGuidedPlan: policy.requireGuidedPlan === true };

  if (policy.maxMode) {
    const max = policy.maxMode;
    if (asked.mode !== undefined && stricterMode(asked.mode, max) !== asked.mode)
      refused.push({
        key: "mode",
        why: `mode "${asked.mode}" is above the config's maxMode "${max}": attach in "${max}"${max === "observe" ? "" : " or a stricter mode"}`,
      });
    else if (asked.mode === undefined && stricterMode(defaults.mode, max) !== defaults.mode) {
      settings.mode = max;
      notes.push(`mode "${max}": the default "${defaults.mode}" is above the config's maxMode`);
    }
  }

  const listed = (
    key: "readPosts" | "trustedEmbeds",
    allowed: string[],
    fromEnv: string[] | undefined,
    envName: string | undefined,
    norm: (e: string) => string,
  ): void => {
    const arg = asked[key];
    if (arg !== undefined) {
      const outside = arg.filter((e) => !allowed.map(norm).includes(norm(e)));
      if (outside.length > 0)
        refused.push({
          key,
          why:
            allowed.length === 0
              ? `the config allows no ${key}, and this attach named ${quoted(outside)}: attach without ${key}`
              : `${key} may name only entries the config lists (${quoted(allowed)}), and ${quoted(outside)} ${outside.length > 1 ? "are" : "is"} not among them`,
        });
      else settings[key] = [...arg];
      return;
    }
    if (fromEnv && fromEnv.length > 0) {
      const kept = intersect(fromEnv, allowed, norm);
      const dropped = fromEnv.filter((e) => !kept.includes(e));
      if (dropped.length > 0) notes.push(`${envName} entries the config does not list were left out: ${quoted(dropped)}`);
      settings[key] = kept;
      return;
    }
    settings[key] = [...allowed];
  };
  if (policy.readPosts) listed("readPosts", policy.readPosts, readPostsSetting(undefined, env[READ_POSTS_ENV]), READ_POSTS_ENV, readPostKey);
  else if (asked.readPosts !== undefined) settings.readPosts = [...asked.readPosts];
  if (policy.trustedEmbeds) listed("trustedEmbeds", policy.trustedEmbeds, undefined, undefined, embedKey);
  else if (asked.trustedEmbeds !== undefined) settings.trustedEmbeds = [...asked.trustedEmbeds];

  settings.dedup = asked.dedup;
  if (policy.dedup) {
    const max = policy.dedup;
    if (asked.dedup !== undefined && below(DEDUP_ORDER, asked.dedup, max) !== asked.dedup)
      refused.push({ key: "dedup", why: `dedup "${asked.dedup}" is above the config's dedup "${max}": the model judge is off for this project` });
    else if (asked.dedup === undefined && max === "rule") {
      // Set, not left to the environment: an earlier attach's choice and SCENESCOUT_DEDUP both lose to the file.
      settings.dedup = "rule";
      if ((env[DEDUP_ENV] ?? "").trim() === "judge") notes.push(`dedup "rule": ${DEDUP_ENV}=judge is above the config's dedup "rule"`);
    }
  }

  settings.evidence = asked.evidence;
  if (policy.evidence) {
    const max = policy.evidence;
    if (asked.evidence !== undefined && below(EVIDENCE_ORDER, asked.evidence, max) !== asked.evidence)
      refused.push({ key: "evidence", why: `evidence "${asked.evidence}" is above the config's evidence "${max}"` });
    else if (asked.evidence === undefined) {
      const would = defaults.evidence();
      if (below(EVIDENCE_ORDER, would, max) !== would) {
        settings.evidence = max;
        notes.push(`evidence "${max}": "${would}" is above the config's evidence`);
      }
    }
  }
  return { settings, refused, notes };
}

/** The sentence an attach or a command is refused with: every reason, the file, and who can change it. */
export function refusalText(loaded: LoadedPolicy, refused: readonly Refusal[]): string {
  return (
    `refused by the SceneScout config (${loaded.sources.join(", ")}): ${refused.map((r) => r.why).join("; ")}. ` +
    "Whoever runs SceneScout set this in that file; only they can change it. Do not retry with a looser setting."
  );
}

/** The line that tells the agent the config applied, or "" with no file. */
export function policyNote(loaded: LoadedPolicy, notes: readonly string[]): string {
  if (loaded.sources.length === 0) return "";
  return `\n🔒 CONFIG: ${loaded.sources.join(", ")} sets what this server may do${notes.length > 0 ? `; ${notes.join("; ")}` : ""}.`;
}

/** Whether `--name` was given on a command line, as `--name value` or `--name=value`. */
function flagGiven(args: readonly string[], name: string): boolean {
  return args.some((a) => a.startsWith("--") && flagName(a) === name);
}

/**
 * The config applied to a command (`check`, `ci`, a first look): its `--mode`, `ci`'s
 * `--dedup`, and the read POSTs it takes from the environment. A flag above the config's ceiling stops the command, naming the
 * file; a default above it is lowered, with a line saying so.
 */
export function applyToCommand(
  loaded: LoadedPolicy,
  env: Record<string, string | undefined>,
  args: readonly string[],
  options: { mode: WriteMode; dedup?: DedupMode },
): { ok: true; mode: WriteMode; dedup?: DedupMode; readPosts?: string[]; note: string } | { ok: false; error: string } {
  if (loaded.sources.length === 0) return { ok: true, mode: options.mode, dedup: options.dedup, note: "" };
  const asked: AskedSettings = { mode: flagGiven(args, "mode") ? options.mode : undefined };
  if (options.dedup !== undefined && flagGiven(args, "dedup")) asked.dedup = options.dedup;
  const r = resolveSettings(loaded, env, asked, { mode: options.mode, evidence: () => "off" });
  if (r.refused.length > 0) return { ok: false, error: refusalText(loaded, r.refused).replace(/ Do not retry with a looser setting\.$/, "") };
  const dedup = options.dedup === undefined ? undefined : (r.settings.dedup ?? options.dedup);
  const notes = [...r.notes];
  // Said once: resolveSettings already said so when the environment asked for the judge.
  if (options.dedup !== undefined && dedup !== options.dedup && !notes.some((n) => n.startsWith("dedup ")))
    notes.push(`dedup "${dedup}": the default "${options.dedup}" is above the config's dedup`);
  // A command takes read POSTs from the environment only, so the list the file allows is what it reads (undefined: as the environment says).
  return {
    ok: true,
    mode: r.settings.mode,
    dedup,
    readPosts: r.settings.readPosts,
    note: `Config: ${loaded.sources.join(", ")}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}.`,
  };
}
