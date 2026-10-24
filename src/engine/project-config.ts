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
 *
 * The write-judgement locks (`writeClassifier`, `refuseDestructiveGets` and
 * `authPosts`) are joined with their environment variables by
 * writeRulesSettings, and the result is handed to the browser engine through
 * the attach (or a command's check options), so the engine never reads those
 * variables on its own once a caller passes them.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_READ_POSTS,
  MAX_TRUSTED_EMBEDS,
  AUTH_POSTS_ENV,
  READ_POSTS_ENV,
  readPostEntries,
  readPostsSetting,
  stricterMode,
  trustedEmbedOrigins,
  type WriteMode,
  WRITE_MODES,
} from "./policy.js";
import { EVIDENCE_MODES, type EvidenceMode } from "./capture.js";
import { REFUSE_DESTRUCTIVE_GETS_ENV, refuseDestructiveGetsSetting, STRICT_WRITES_ENV, writeClassifierSetting, type WriteClassifier } from "./strict-writes.js";
import { DEDUP_ENV, DEDUP_MODES, type DedupMode } from "./ci.js";
import { flagName } from "./args.js";
import { CONFIG_FILE_NAME, MEMORY_DIRNAME } from "./memory-dir.js";

/** The environment variable naming the operator's config file, read before the launch directory's. */
export const CONFIG_ENV = "SCENESCOUT_CONFIG";

/** Where the config file sits in a directory: beside the project's other SceneScout files. */
export const CONFIG_FILE = path.join(MEMORY_DIRNAME, CONFIG_FILE_NAME);

/** The write classifiers a file may name, from the one that lets the most out to the one that lets the least. */
export const WRITE_CLASSIFIERS = ["standard", "strict"] as const satisfies readonly WriteClassifier[];

/** The presets a file may start from. */
export const PRESETS = ["strict"] as const;
export type Preset = (typeof PRESETS)[number];

/** The keys a config file may set; any other key is refused. */
export const CONFIG_KEYS = [
  "preset",
  "maxMode",
  "requireGuidedPlan",
  "readPosts",
  "trustedEmbeds",
  "dedup",
  "evidence",
  "uploads",
  "egress",
  "projectsRoot",
  "writeClassifier",
  "refuseDestructiveGets",
  "authPosts",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** What scout_upload may send: only files it generates, or a file from the project as well (the fence in uploads.ts). */
export const UPLOAD_MODES = ["fixtures", "project"] as const;
export type UploadMode = (typeof UPLOAD_MODES)[number];

/**
 * What SceneScout itself may send off the machine (issue #537), from the least
 * to the most: `none` sends nothing, `model-only` sends pages to a model and
 * nothing else, `all` is every path, as without a file.
 */
export const EGRESS_MODES = ["none", "model-only", "all"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

/**
 * The kinds of path by which SceneScout itself sends data off the machine:
 * a model's API (`scenescout ci`, the dedup judge, a finding's picture in the
 * conversation), an issue tracker (`scenescout export` and the ticket tools)
 * and a pull request (`/scenescout qa`'s replies and its picture branch).
 */
export const EGRESS_PATHS = ["model", "tracker", "pull-request"] as const;
export type EgressPath = (typeof EGRESS_PATHS)[number];

/** Whether `egress` lets a path send. No setting is `all`, as without a file. */
export function egressAllows(egress: EgressMode | undefined, via: EgressPath): boolean {
  if (egress === undefined || egress === "all") return true;
  return egress === "model-only" && via === "model";
}

/** What each path sends, as a refusal names it. */
const EGRESS_WHAT: Record<EgressPath, string> = {
  model: "sending the app's pages to a model's API",
  tracker: "contacting GitHub or Jira with this project's findings",
  "pull-request": "posting results on a pull request",
};

/**
 * Why the config refuses a path that sends data off the machine, or null when
 * it allows it. `what` names the command or tool, for the person reading it.
 */
export function egressRefusal(loaded: LoadedPolicy, via: EgressPath, what: string): string | null {
  const egress = loaded.policy.egress;
  if (egressAllows(egress, via)) return null;
  return refusalText(loaded, [
    {
      key: "egress",
      why: `egress "${egress}" ${egress === "none" ? "lets SceneScout send nothing off this machine" : "lets SceneScout send pages to a model and nothing else"}, so ${what} is not run (it means ${EGRESS_WHAT[via]})`,
    },
  ]);
}

/**
 * Why the config refuses a tool that returns a picture of the app into the
 * conversation (`scout_screenshot`, `scout_cards` with inline pictures), or
 * null: egress that sends nothing to a model, or `evidence` capped at "file"
 * or "off", which keep pictures out of the conversation. scout_capture, which
 * saves its picture to a file, is not refused.
 */
export function conversationPictureRefusal(loaded: LoadedPolicy, what: string, instead?: string): string | null {
  const egress = egressRefusal(loaded, "model", what);
  if (egress) return egress;
  const evidence = loaded.policy.evidence;
  if (evidence === undefined || evidence === "inline") return null;
  return refusalText(loaded, [
    {
      key: "evidence",
      why: `evidence "${evidence}" keeps pictures of the app out of the conversation, so ${what} is not run${instead ? `: ${instead}` : ""}`,
    },
  ]);
}

/**
 * What a config file sets, after its preset is expanded. A key that is
 * undefined leaves the setting as it is without a file.
 */
export interface Policy extends WriteRulesPolicy {
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
  /** The most scout_upload may send: "fixtures" refuses every file from disk, whatever SCENESCOUT_UPLOAD_ALLOW lists. */
  uploads?: UploadMode;
  /** What SceneScout itself may send off the machine. Unset: everything, as without a file. */
  egress?: EgressMode;
  /**
   * The folder every project folder must sit inside, by its real path: an
   * attach's projectPath (or the folder it would default to), scout_login's,
   * scout_scan's, and a command's --project. Read from the operator's file
   * only, since the project's own file is inside what it limits.
   */
  projectsRoot?: string;
}

/** A policy with where it came from, for every message that names it. */
export interface LoadedPolicy {
  policy: Policy;
  /** The files it was read from, in the order read. Empty when there is no file. */
  sources: string[];
}

/** No file: every setting as it is without one. */
export const NO_POLICY: LoadedPolicy = { policy: {}, sources: [] };

/**
 * What a preset sets: every key but projectsRoot, which names a folder on one
 * machine; egress, which no preset sets so that adopting one never stops an
 * export or a `ci` run that worked before; and writeClassifier and authPosts,
 * which no preset sets because the strict classifier refuses writes the
 * standard one lets out and a sign-in list names one app's endpoints.
 */
export type PresetPolicy = Required<Omit<Policy, "projectsRoot" | "egress" | "writeClassifier" | "authPosts" | "authPostsNarrowOnly">>;

/** What each preset sets. A key the file sets beside the preset replaces the preset's value for that key. */
export const PRESET_POLICY: Record<Preset, PresetPolicy> = {
  strict: {
    maxMode: "observe",
    requireGuidedPlan: true,
    readPosts: [],
    trustedEmbeds: [],
    dedup: "rule",
    evidence: "file",
    uploads: "fixtures",
    refuseDestructiveGets: true,
  },
};

/** Evidence modes from the least that leaves the machine to the most. */
const EVIDENCE_ORDER: readonly EvidenceMode[] = ["off", "file", "inline"];
/** Dedup modes from the least that leaves the machine to the most. */
const DEDUP_ORDER: readonly DedupMode[] = ["rule", "judge"];
/** Upload modes from the least that reads the disk to the most. */
const UPLOAD_ORDER: readonly UploadMode[] = ["fixtures", "project"];
/** Egress modes from the least that leaves the machine to the most. */
const EGRESS_ORDER: readonly EgressMode[] = EGRESS_MODES;

const below = <T>(order: readonly T[], a: T, b: T): T => (order.indexOf(a) <= order.indexOf(b) ? a : b);

const quoted = (list: readonly string[]): string => list.map((v) => `"${v}"`).join(", ");

/**
 * The keys that appear more than once in one object of a JSON text that
 * JSON.parse accepted, compared after their escapes are decoded. JSON.parse
 * keeps the last one silently, so a reader of the file would take the first
 * value for the lock while the second is the one applied.
 */
function duplicateKeys(text: string): string[] {
  const dups = new Set<string>();
  const open: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const token = text.slice(i, j + 1);
      i = j;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const keys = open[open.length - 1];
      if (keys && text[k] === ":") {
        const key = JSON.parse(token) as string;
        if (keys.has(key)) dups.add(key);
        else keys.add(key);
      }
    } else if (c === "{") open.push(new Set());
    else if (c === "[") open.push(null);
    else if (c === "}" || c === "]") open.pop();
  }
  return [...dups];
}

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
  const twice = duplicateKeys(text);
  if (twice.length > 0) return bad(`${quoted(twice)} ${twice.length > 1 ? "are each" : "is"} set more than once: set each key once`);
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
  const list = (key: ConfigKey, max: number, check: (entries: string[]) => string[]): { ok: true; value?: string[] } | { ok: false; error: string } => {
    const v = obj[key];
    if (v === undefined) return { ok: true };
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) return bad(`"${key}" must be a list of strings, such as [] for none`);
    if (v.length > max) return bad(`"${key}" may hold at most ${max} entries`);
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
  const uploads = oneOf("uploads", UPLOAD_MODES);
  if (!uploads.ok) return uploads;
  const egress = oneOf("egress", EGRESS_MODES);
  if (!egress.ok) return egress;
  const root = obj.projectsRoot;
  if (root !== undefined && (typeof root !== "string" || !path.isAbsolute(root.trim())))
    return bad(`"projectsRoot" must be the absolute path of a folder, not ${JSON.stringify(root)}`);
  if (obj.requireGuidedPlan !== undefined && typeof obj.requireGuidedPlan !== "boolean") return bad(`"requireGuidedPlan" must be true or false`);
  if (obj.refuseDestructiveGets !== undefined && typeof obj.refuseDestructiveGets !== "boolean") return bad(`"refuseDestructiveGets" must be true or false`);
  const writeClassifier = oneOf("writeClassifier", WRITE_CLASSIFIERS);
  if (!writeClassifier.ok) return writeClassifier;
  const authPosts = list("authPosts", MAX_READ_POSTS, (entries) => readPostEntries(entries).rejected);
  if (!authPosts.ok) return authPosts;
  const readPosts = list("readPosts", MAX_READ_POSTS, (entries) => readPostEntries(entries).rejected);
  if (!readPosts.ok) return readPosts;
  const trustedEmbeds = list("trustedEmbeds", MAX_TRUSTED_EMBEDS, (entries) => trustedEmbedOrigins(entries).rejected);
  if (!trustedEmbeds.ok) return trustedEmbeds;

  const base: Policy = preset.value ? structuredClone(PRESET_POLICY[preset.value]) : {};
  const set: Policy = {
    maxMode: maxMode.value,
    requireGuidedPlan: obj.requireGuidedPlan as boolean | undefined,
    readPosts: readPosts.value,
    trustedEmbeds: trustedEmbeds.value,
    dedup: dedup.value,
    evidence: evidence.value,
    uploads: uploads.value,
    egress: egress.value,
    projectsRoot: typeof root === "string" ? path.resolve(root.trim()) : undefined,
    writeClassifier: writeClassifier.value,
    refuseDestructiveGets: obj.refuseDestructiveGets as boolean | undefined,
    authPosts: authPosts.value,
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
 * operator's file allows and never loosen it: `a` is the operator's, `b` the
 * project's.
 *
 * A sign-in list replaces the path rule, so one only the project lists would
 * let out as a sign-in a POST the path rule refuses. It is kept as a narrowing
 * of the path rule instead (`authPostsNarrowOnly`): a POST must be listed and
 * also look like a sign-in by its path.
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
  if (a.uploads || b.uploads) out.uploads = a.uploads && b.uploads ? below(UPLOAD_ORDER, a.uploads, b.uploads) : (a.uploads ?? b.uploads);
  if (a.egress || b.egress) out.egress = a.egress && b.egress ? below(EGRESS_ORDER, a.egress, b.egress) : (a.egress ?? b.egress);
  if (a.writeClassifier || b.writeClassifier) out.writeClassifier = a.writeClassifier === "strict" || b.writeClassifier === "strict" ? "strict" : "standard";
  if (a.refuseDestructiveGets !== undefined || b.refuseDestructiveGets !== undefined)
    out.refuseDestructiveGets = a.refuseDestructiveGets === true || b.refuseDestructiveGets === true;
  if (a.authPosts || b.authPosts) out.authPosts = a.authPosts && b.authPosts ? intersect(b.authPosts, a.authPosts, readPostKey) : (a.authPosts ?? b.authPosts);
  if (a.authPosts ? a.authPostsNarrowOnly === true : b.authPosts !== undefined) out.authPostsNarrowOnly = true;
  // The operator's only: withProjectPolicy refuses a project's file that sets it.
  if (a.projectsRoot) out.projectsRoot = a.projectsRoot;
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
  // Only "nothing there" is no file. A link whose target is missing, or a path that cannot be looked at,
  // is a file that cannot be read: reading it fails and stops the start, where existsSync would skip the lock.
  exists: (file) => {
    try {
      fs.lstatSync(file);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ENOTDIR";
    }
  },
  read: (file) => fs.readFileSync(file, "utf8"),
  realpath: (file) => realOrWhereItLeads(file, 0),
};

/**
 * A path's real path; for a link whose target is not there yet, where it
 * would lead, so projectsRoot judges a dangling link by its target rather
 * than by its own name. Anything else that cannot be resolved is its path as
 * written.
 */
function realOrWhereItLeads(file: string, hops: number): string {
  try {
    // native: it expands a Windows short name (PROGRA~1), which the JavaScript one leaves as written.
    return fs.realpathSync.native(file);
  } catch {
    const at = path.resolve(file);
    let link: string | null = null;
    try {
      link = fs.lstatSync(at).isSymbolicLink() ? fs.readlinkSync(at) : null;
    } catch {
      // Not there: the real path of the folder it would be in, with its name.
      const up = path.dirname(at);
      return up === at ? at : path.join(realOrWhereItLeads(up, hops), path.basename(at));
    }
    // A relative target is read from the link's real folder, as the system reads it, so `..` cannot step back into the root.
    // A chain of dangling links is followed for 40 links, as far as Linux follows one.
    return link !== null && hops < 40 ? realOrWhereItLeads(path.resolve(realOrWhereItLeads(path.dirname(at), hops + 1), link), hops + 1) : at;
  }
}

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
  if (project.loaded.policy.projectsRoot !== undefined)
    return {
      ok: false,
      error: `${file}: "projectsRoot" is read from the operator's config only (${CONFIG_ENV}, or the directory the server or command starts in), since the project folder is what it limits`,
    };
  return { ok: true, loaded: { policy: tightenPolicy(launch.policy, project.loaded.policy), sources: [...launch.sources, file] } };
}

/**
 * A folder's real path, for a folder that may not exist yet: the nearest
 * folder above it that does is resolved through its links, and the rest is
 * joined on as written.
 */
function realFolder(dir: string, fsx: PolicyReader): string {
  const rest: string[] = [];
  for (let at = path.resolve(dir); ;) {
    if (fsx.exists(at)) return path.join(fsx.realpath(at), ...rest.reverse());
    const up = path.dirname(at);
    if (up === at) return path.join(at, ...rest.reverse());
    rest.push(path.basename(at));
    at = up;
  }
}

/** Whether `dir` is `root` or inside it; both real paths. Windows compares without case, as it opens them. */
function inside(root: string, dir: string): boolean {
  const rel = process.platform === "win32" ? path.relative(root.toLowerCase(), dir.toLowerCase()) : path.relative(root, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Why a project folder is refused, or null: the config's projectsRoot, when
 * it sets one, must hold the folder by its real path, so a link inside the
 * root that leads out of it is outside it. With no projectsRoot, every folder
 * is allowed, as without a config.
 */
export function projectFolderRefusal(loaded: LoadedPolicy, dir: string, fsx: PolicyReader): string | null {
  const root = loaded.policy.projectsRoot;
  if (!root) return null;
  const real = realFolder(dir, fsx);
  if (inside(realFolder(root, fsx), real)) return null;
  return refusalText(loaded, [
    {
      key: "projectPath",
      why: `the project folder ${path.resolve(dir)}${real === path.resolve(dir) ? "" : ` (really ${real})`} is outside the config's projectsRoot ${root}: name a project folder inside it`,
    },
  ]);
}

/**
 * Why scout_upload, or a run plan's upload step (its path from
 * planUploadOptions), may not send the file from disk it names, or null.
 * Under `uploads: "fixtures"` only a generated file may be sent: a file from
 * disk is refused, whatever SCENESCOUT_UPLOAD_ALLOW lists. Anything else is
 * left to the upload fence (uploads.ts) as without a config.
 */
export function uploadRefusal(loaded: LoadedPolicy, filePath: string | undefined): string | null {
  if (loaded.policy.uploads !== "fixtures" || filePath === undefined) return null;
  return refusalText(loaded, [
    {
      key: "filePath",
      why: `uploads "fixtures" allows only generated files, so "${filePath}" is not sent: upload a fixture kind (pdf, png, txt, csv, json) instead`,
    },
  ]);
}

/**
 * The write-judgement locks a config file sets. The browser engine takes the
 * settings writeRulesSettings makes of them from the attach.
 */
export interface WriteRulesPolicy {
  /** The least strict classifier any session judges writes with: "strict" turns it on whatever SCENESCOUT_STRICT_WRITES says. */
  writeClassifier?: WriteClassifier;
  /** true: page loads whose address is a destructive command are refused in observe and read-only, whatever SCENESCOUT_REFUSE_DESTRUCTIVE_GETS says. */
  refuseDestructiveGets?: boolean;
  /** The only POSTs that may count as signing in. SCENESCOUT_AUTH_POSTS may narrow it. [] allows none. */
  authPosts?: string[];
  /**
   * Not a key, so no file sets it: true when `authPosts` came from a project's
   * own file alone (tightenPolicy), so the list only narrows the path rule
   * unless SCENESCOUT_AUTH_POSTS, the operator's, also lists the entry.
   */
  authPostsNarrowOnly?: boolean;
}

/** The sign-in allowlist a session judges by: its entries, and whether a POST must also look like a sign-in (policy.ts isAuthExempt). */
export interface AuthPostsSetting {
  entries: string[];
  andSignInPath: boolean;
}

/** What turned each write-judgement setting on, as the attach names it: the config or the environment variable. Absent: not on. */
export interface WriteRulesSources {
  writeClassifier?: string;
  refuseDestructiveGets?: string;
  authPosts?: string;
}

/** The write-judgement settings a session runs with (writeRulesSettings), as the browser engine takes them from the attach. */
export interface SessionWriteRules {
  writeClassifier: WriteClassifier;
  refuseDestructiveGets: boolean;
  authPosts: AuthPostsSetting | null;
  notes: string[];
  from: WriteRulesSources;
}

/** How the attach names the config as the source of a setting. */
const BY_CONFIG = "the SceneScout config";

/**
 * The write-judgement settings a session runs with: the file's, then the
 * environment's, where the stricter of the two wins.
 *
 * - `writeClassifier` and `refuseDestructiveGets` are on when either turns
 *   them on; neither can turn off what the other turned on.
 * - `authPosts`: the file's list, narrowed to the entries
 *   SCENESCOUT_AUTH_POSTS also names when it is set; with no file list, the
 *   environment's as before; null when neither sets one (the path rule).
 * - While a guided plan is open (`guided`), a POST must be both listed and
 *   look like a sign-in to the path rule, so an operator's stricter list stays
 *   strict, and the list cannot let out a POST the path rule would refuse.
 *   With no list, the path rule decides, as before. A list only a project's
 *   own file set (`authPostsNarrowOnly`) is held the same way in every
 *   session, unless SCENESCOUT_AUTH_POSTS lists the entries too.
 *
 * Throws, naming the variable, on an environment value strict-writes.ts
 * cannot read, as the attach does today.
 */
export function writeRulesSettings(file: WriteRulesPolicy, env: Record<string, string | undefined>, guided: boolean): SessionWriteRules {
  const notes: string[] = [];
  const envClassifier = writeClassifierSetting(env);
  const envGets = refuseDestructiveGetsSetting(env);
  const writeClassifier: WriteClassifier = file.writeClassifier === "strict" || envClassifier === "strict" ? "strict" : "standard";
  if (file.writeClassifier === "standard" && envClassifier === "strict")
    notes.push(`writeClassifier "strict": ${STRICT_WRITES_ENV} is stricter than the config's "standard"`);
  const refuseDestructiveGets = file.refuseDestructiveGets === true || envGets;
  if (file.refuseDestructiveGets === false && envGets) notes.push(`refuseDestructiveGets: ${REFUSE_DESTRUCTIVE_GETS_ENV} is stricter than the config's false`);
  const fromEnv = readPostsSetting(undefined, env[AUTH_POSTS_ENV]);
  let entries: string[] | null = null;
  if (file.authPosts) {
    entries = [...file.authPosts];
    if (fromEnv.length > 0) {
      entries = intersect(fromEnv, file.authPosts, readPostKey);
      const dropped = fromEnv.filter((e) => !entries!.includes(e));
      if (dropped.length > 0) notes.push(`${AUTH_POSTS_ENV} entries the config does not list were left out: ${quoted(dropped)}`);
    }
  } else if (fromEnv.length > 0) entries = fromEnv;
  const from: WriteRulesSources = {};
  if (writeClassifier === "strict") from.writeClassifier = file.writeClassifier === "strict" ? BY_CONFIG : STRICT_WRITES_ENV;
  if (refuseDestructiveGets) from.refuseDestructiveGets = file.refuseDestructiveGets === true ? BY_CONFIG : REFUSE_DESTRUCTIVE_GETS_ENV;
  if (entries !== null) from.authPosts = file.authPosts ? (fromEnv.length > 0 ? `${BY_CONFIG}, narrowed by ${AUTH_POSTS_ENV}` : BY_CONFIG) : AUTH_POSTS_ENV;
  const andSignInPath = guided || (file.authPostsNarrowOnly === true && fromEnv.length === 0);
  return { writeClassifier, refuseDestructiveGets, authPosts: entries === null ? null : { entries, andSignInPath }, notes, from };
}

/**
 * What the config's write-judgement locks did, for the attach's and a
 * command's "Config:" line: each lock the config turned on, then the notes
 * writeRulesSettings made (an environment value the config lowered or lost
 * to). Empty when the config sets none of them.
 */
export function writeRulesNote(policy: WriteRulesPolicy, rules: SessionWriteRules): string[] {
  const out: string[] = [];
  if (policy.writeClassifier === "strict") out.push(`writeClassifier "strict": writes are judged by the strict classifier`);
  if (policy.refuseDestructiveGets === true)
    out.push("refuseDestructiveGets: page loads whose address is a destructive command are refused in observe and read-only");
  if (policy.authPosts && rules.authPosts) {
    const { entries, andSignInPath } = rules.authPosts;
    const which = entries.length === 0 ? "no POST counts" : `only ${quoted(entries)} ${entries.length === 1 ? "counts" : "count"}`;
    out.push(
      `authPosts: ${which} as signing in${andSignInPath && entries.length > 0 ? `, and only when it also looks like a sign-in by its path (${policy.authPostsNarrowOnly === true ? "the list is the project's own" : "a guided check"})` : ""}`,
    );
  }
  return [...out, ...rules.notes];
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
  key: keyof AskedSettings | "projectPath" | "filePath" | "egress";
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
  /** Who asked: an attach is told the mode to attach in, a command the flag to pass. */
  surface: "attach" | "command" = "attach",
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
        why: `mode "${asked.mode}" is above the config's maxMode "${max}": ${surface === "attach" ? `attach in "${max}"` : `use --mode ${max}`}${max === "observe" ? "" : " or a stricter mode"}`,
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

  // egress "none" sends nothing to a model: the judge is off and pictures stay out of the conversation, whatever dedup and evidence say.
  const noEgress = policy.egress === "none";
  const dedupMax: DedupMode | undefined = noEgress ? "rule" : policy.dedup;
  const dedupBy = noEgress && policy.dedup !== "rule" ? `egress "none"` : `dedup "${dedupMax}"`;
  settings.dedup = asked.dedup;
  if (dedupMax) {
    const max = dedupMax;
    if (asked.dedup !== undefined && below(DEDUP_ORDER, asked.dedup, max) !== asked.dedup)
      refused.push({ key: "dedup", why: `dedup "${asked.dedup}" is above the config's ${dedupBy}: the model judge is off for this project` });
    else if (asked.dedup === undefined && max === "rule") {
      // Set, not left to the environment: an earlier attach's choice and SCENESCOUT_DEDUP both lose to the file.
      settings.dedup = "rule";
      if ((env[DEDUP_ENV] ?? "").trim() === "judge") notes.push(`dedup "rule": ${DEDUP_ENV}=judge is above the config's ${dedupBy}`);
    }
  }

  const evidenceMax: EvidenceMode | undefined = noEgress ? (policy.evidence ? below(EVIDENCE_ORDER, policy.evidence, "file") : "file") : policy.evidence;
  const evidenceBy = noEgress && evidenceMax !== policy.evidence ? `egress "none"` : `evidence "${evidenceMax}"`;
  settings.evidence = asked.evidence;
  if (evidenceMax) {
    const max = evidenceMax;
    if (asked.evidence !== undefined && below(EVIDENCE_ORDER, asked.evidence, max) !== asked.evidence)
      refused.push({ key: "evidence", why: `evidence "${asked.evidence}" is above the config's ${evidenceBy}` });
    else if (asked.evidence === undefined) {
      const would = defaults.evidence();
      if (below(EVIDENCE_ORDER, would, max) !== would) {
        settings.evidence = max;
        notes.push(`evidence "${max}": "${would}" is above the config's ${noEgress && evidenceMax !== policy.evidence ? `egress "none"` : "evidence"}`);
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

/** A refusal as a command prints it: a command is run by a person, not an agent that might retry. */
export const forCommand = (refusal: string): string => refusal.replace(/ Do not retry with a looser setting\.$/, "");

/**
 * The config applied to a command (`check`, `ci`, a first look): its `--mode`, `ci`'s
 * `--dedup`, and the read POSTs it takes from the environment. A flag above the config's ceiling stops the command, naming the
 * file; a default above it is lowered, with a line saying so. `sends` names the path by which the command
 * sends data off the machine (`ci`: a model's API), and a command whose path egress does not allow is refused.
 */
export function applyToCommand(
  loaded: LoadedPolicy,
  env: Record<string, string | undefined>,
  args: readonly string[],
  options: CommandOptions,
): { ok: true; mode: WriteMode; dedup?: DedupMode; readPosts?: string[]; writeRules?: SessionWriteRules; note: string } | { ok: false; error: string } {
  const egress = options.sends ? egressRefusal(loaded, options.sends.via, options.sends.what) : null;
  if (egress) return { ok: false, error: forCommand(egress) };
  if (loaded.sources.length === 0) return { ok: true, mode: options.mode, dedup: options.dedup, note: "" };
  const asked: AskedSettings = { mode: flagGiven(args, "mode") ? options.mode : undefined };
  if (options.dedup !== undefined && flagGiven(args, "dedup")) asked.dedup = options.dedup;
  // An agent-driven command (`ci`) has no person to accept a guided plan, so requireGuidedPlan holds it to observe, as the
  // gate holds an attach that names no plan: said here, before it starts, rather than at the agent's first attach.
  const gateNotes: string[] = [];
  let mode = options.mode;
  if (options.agentDriven === true && loaded.policy.requireGuidedPlan === true && mode !== "observe") {
    const why = "needs a guided plan the person accepts (the config's requireGuidedPlan), which an unattended run cannot have";
    if (asked.mode !== undefined)
      return { ok: false, error: forCommand(refusalText(loaded, [{ key: "mode", why: `mode "${mode}" ${why}: use --mode observe` }])) };
    gateNotes.push(`mode "observe": the default "${mode}" ${why}`);
    mode = "observe";
  }
  const r = resolveSettings(loaded, env, asked, { mode, evidence: () => "off" }, "command");
  if (r.refused.length > 0) return { ok: false, error: forCommand(refusalText(loaded, r.refused)) };
  let writeRules: SessionWriteRules;
  try {
    writeRules = writeRulesSettings(loaded.policy, env, false);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const dedup = options.dedup === undefined ? undefined : (r.settings.dedup ?? options.dedup);
  const notes = [...gateNotes, ...r.notes, ...writeRulesNote(loaded.policy, writeRules)];
  // Said once: resolveSettings already said so when the environment asked for the judge.
  if (options.dedup !== undefined && dedup !== options.dedup && !notes.some((n) => n.startsWith("dedup ")))
    notes.push(`dedup "${dedup}": the default "${options.dedup}" is above the config's dedup`);
  // A command takes read POSTs from the environment only, so the list the file allows is what it reads (undefined: as the environment says).
  return {
    ok: true,
    mode: r.settings.mode,
    dedup,
    readPosts: r.settings.readPosts,
    writeRules,
    note: `Config: ${loaded.sources.join(", ")}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}.`,
  };
}

/** What a command asks of the config: its mode and dedup, the path it sends data by, and whether a model drives it (`ci`). */
export interface CommandOptions {
  mode: WriteMode;
  dedup?: DedupMode;
  sends?: { via: EgressPath; what: string };
  agentDriven?: boolean;
}

/**
 * The config a command runs under: the launch file (CONFIG_ENV, else
 * `launchDir`'s), joined with the project's own, after the project folder is
 * checked against projectsRoot. An error stops the command.
 */
export function readCommandPolicy(
  env: Record<string, string | undefined>,
  launchDir: string,
  projectDir: string,
  fsx: PolicyReader,
): { ok: true; loaded: LoadedPolicy } | { ok: false; error: string } {
  const launch = readLaunchPolicy(env, launchDir, fsx);
  if (!launch.ok) return launch;
  // Before the project's own file is read: a folder outside the root is not the operator's to read from.
  const outside = projectFolderRefusal(launch.loaded, projectDir, fsx);
  if (outside) return { ok: false, error: forCommand(outside) };
  return withProjectPolicy(launch.loaded, projectDir, fsx);
}

/**
 * The config for a command (`check`, `ci`, a first look), read and applied in
 * one step: readCommandPolicy, then applyToCommand. `readPostsEnv` is what the command puts
 * in READ_POSTS_ENV, since a command reads POST endpoints from there only;
 * undefined leaves the environment as it is.
 */
export function configureCommand(
  env: Record<string, string | undefined>,
  launchDir: string,
  projectDir: string,
  args: readonly string[],
  options: CommandOptions,
  fsx: PolicyReader,
): { ok: true; mode: WriteMode; dedup?: DedupMode; note: string; readPostsEnv?: string; writeRules?: SessionWriteRules } | { ok: false; error: string } {
  const loaded = readCommandPolicy(env, launchDir, projectDir, fsx);
  if (!loaded.ok) return loaded;
  const applied = applyToCommand(loaded.loaded, env, args, options);
  if (!applied.ok) return applied;
  const { readPosts, ...rest } = applied;
  return readPosts === undefined ? rest : { ...rest, readPostsEnv: readPosts.join("\n") };
}
