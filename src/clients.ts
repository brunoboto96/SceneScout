/**
 * Registering the MCP server with clients other than Claude Code.
 *
 * Each client keeps its server list somewhere different. Where a client has a
 * command for adding a server, that command is used: it knows its own config
 * format and location. Where it has none, the JSON file it reads is edited in
 * place, keeping every other entry.
 *
 * Nothing here launches a process or touches the home directory on its own:
 * the runner, the home directory and the platform are passed in, so every rule
 * can be table-tested.
 */
import fs from "node:fs";
import path from "node:path";
import { MCP_NAME, type Runner } from "./installer.js";

export const OTHER_CLIENTS = ["cursor", "vscode", "codex", "gemini", "copilot", "windsurf"] as const;
export type OtherClient = (typeof OTHER_CLIENTS)[number];
export const CLIENTS = ["claude-code", ...OTHER_CLIENTS] as const;
export type Client = (typeof CLIENTS)[number];

export const CLIENT_LABELS: Record<Client, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code (GitHub Copilot agent mode)",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot CLI",
  windsurf: "Windsurf",
};

/** Read the value of `--client`. Absent means Claude Code, which is what install has always set up. */
export function parseClients(value: string | undefined): { clients: Client[] } | { error: string } {
  if (value === undefined) return { clients: ["claude-code"] };
  const names = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const choices = CLIENTS.join(", ");
  if (names.length === 0) return { error: `--client needs a value. Choose from: ${choices}.` };
  const picked = new Set<Client>();
  for (const name of names) {
    if (!(CLIENTS as readonly string[]).includes(name)) return { error: `"${name}" is not a client install knows how to set up. Choose from: ${choices}.` };
    picked.add(name as Client);
  }
  return { clients: CLIENTS.filter((c) => picked.has(c)) };
}

/** A client whose server list is a JSON file with one object of named servers. */
type FileClient = { kind: "file"; file: (home: string) => string; key: string };
/** A client with its own command for adding a server. */
type CommandClient = {
  kind: "command";
  binary: string;
  add: (launch: string[]) => string[];
  /** Run first when `add` refuses a name that already exists. */
  removeFirst?: string[];
};

const STRATEGIES: Record<Exclude<OtherClient, "vscode">, FileClient | CommandClient> = {
  cursor: { kind: "file", file: (home) => path.join(home, ".cursor", "mcp.json"), key: "mcpServers" },
  windsurf: { kind: "file", file: (home) => path.join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
  // `add` replaces an entry of the same name.
  codex: { kind: "command", binary: "codex", add: (launch) => ["mcp", "add", MCP_NAME, "--", ...launch] },
  // `add` updates an entry of the same name. The default scope is the project; a tool like this belongs to the user.
  gemini: { kind: "command", binary: "gemini", add: (launch) => ["mcp", "add", "--scope", "user", MCP_NAME, ...launch] },
  // `add` refuses a name that already exists, so the old entry is removed first.
  copilot: { kind: "command", binary: "copilot", add: (launch) => ["mcp", "add", MCP_NAME, "--", ...launch], removeFirst: ["mcp", "remove", MCP_NAME] },
};

export type ClientRegistration =
  | { status: "registered"; where: string; replaced: boolean; notes: string[] }
  | { status: "client-missing"; manual: string }
  | { status: "failed"; detail: string; manual: string };

const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The entry every `mcpServers`-style file takes. */
export function serverEntry(launch: string[]): { command: string; args: string[] } {
  return { command: launch[0], args: launch.slice(1) };
}

/**
 * Put the server into a client's JSON server list, keeping everything else in
 * the file. A file that is not valid JSON is left exactly as it is: rewriting
 * it would discard whatever the person had in it.
 */
export function registerInFile(file: string, key: string, launch: string[]): ClientRegistration {
  const entry = serverEntry(launch);
  const manual = `add this under "${key}" in ${file}:\n  ${JSON.stringify({ [MCP_NAME]: entry })}`;
  let config: Record<string, unknown> = {};
  // A config kept in a dotfiles repository is a link. Renaming over the link
  // would replace it with a plain file and leave the real one unchanged, so
  // the write goes to whatever the link points at.
  let target = file;
  let mode = 0o600;
  try {
    if (fs.existsSync(file)) {
      target = fs.realpathSync(file);
      mode = fs.statSync(target).mode & 0o777;
      // Some editors save with a byte-order mark, which JSON.parse rejects.
      const raw = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
      if (raw.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          return {
            status: "failed",
            detail: `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}), so it was left untouched`,
            manual,
          };
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { status: "failed", detail: `${file} does not hold a JSON object, so it was left untouched`, manual };
        }
        config = parsed as Record<string, unknown>;
      }
    }
  } catch (err) {
    return { status: "failed", detail: `${file} could not be read (${err instanceof Error ? err.message : String(err)})`, manual };
  }
  const existing = config[key];
  if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
    return { status: "failed", detail: `"${key}" in ${file} is not an object, so the file was left untouched`, manual };
  }
  const servers = (existing ?? {}) as Record<string, unknown>;
  const before = servers[MCP_NAME];
  const notes: string[] = [];
  if (before !== undefined && JSON.stringify(before) !== JSON.stringify(entry)) {
    notes.push(`the previous "${MCP_NAME}" entry was replaced; it ran: ${JSON.stringify(before)}`);
  }
  config[key] = { ...servers, [MCP_NAME]: entry };
  // Written beside the target and renamed over it, so a crash cannot leave half a file.
  const tmp = `${target}.scenescout-${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
    fs.renameSync(tmp, target);
  } catch (err) {
    // The temporary file is a full copy of the config, which can hold secrets in `env`; it must not stay behind.
    fs.rmSync(tmp, { force: true });
    return { status: "failed", detail: `${file} could not be written (${err instanceof Error ? err.message : String(err)}), so it was left untouched`, manual };
  }
  return { status: "registered", where: file, replaced: before !== undefined, notes };
}

function registerWithCommand(client: CommandClient, launch: string[], run: Runner): ClientRegistration {
  const manual = [client.binary, ...client.add(launch)].map(quote).join(" ");
  let removed = false;
  if (client.removeFirst) {
    const removal = run(client.binary, client.removeFirst);
    if (removal.missing) return { status: "client-missing", manual };
    // A non-zero exit here only means there was nothing of that name to remove.
    removed = removal.status === 0;
  }
  const added = run(client.binary, client.add(launch));
  if (added.missing) return { status: "client-missing", manual };
  if (added.status !== 0) {
    const reason = (added.stdout + added.stderr).trim().split("\n")[0] || `exit code ${added.status}`;
    // Having removed the old entry to make room, say so: the person now has no registration at all.
    const lost = removed ? ` The previous "${MCP_NAME}" entry had already been removed to make room, so ${client.binary} now has none.` : "";
    return { status: "failed", detail: reason + lost, manual };
  }
  return { status: "registered", where: `${client.binary} mcp`, replaced: removed, notes: [] };
}

/** A `code` command found on PATH: what to run, and where it really lives. */
export type CodeOnPath = { command: string; realPath: string };

/**
 * The VS Code command line, or null when only a fork is installed. Cursor and
 * Windsurf both install a `code` command of their own, and running that one
 * registers the server in the wrong editor: it reports success and VS Code
 * never sees the entry. A `code` that resolves into another editor's files is
 * therefore not VS Code.
 *
 * The real path is only inspected. What gets run is the command as found on
 * PATH: some installs (snap) link `code` to a launcher that decides what to
 * start from the name it was called by, and running the link's target directly
 * starts the wrong thing.
 */
export function vscodeBinary(opts: { platform: NodeJS.Platform; home: string; exists: (p: string) => boolean; codeOnPath: CodeOnPath | null }): string | null {
  if (opts.platform === "darwin") {
    for (const root of ["/Applications", path.posix.join(opts.home, "Applications")]) {
      const bundled = path.posix.join(root, "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code");
      if (opts.exists(bundled)) return bundled;
    }
  }
  if (!opts.codeOnPath) return null;
  // Looked for below the home directory's own name, so an account called "cursor" does not disqualify every install under it.
  const real = opts.codeOnPath.realPath;
  const belowHome = real.toLowerCase().startsWith(opts.home.toLowerCase()) ? real.slice(opts.home.length) : real;
  return /cursor|windsurf|codeium|vscodium/i.test(belowHome) ? null : opts.codeOnPath.command;
}

/** What `code --add-mcp` takes: the entry plus its name. */
export function vscodeAddArgs(launch: string[]): string[] {
  return ["--add-mcp", JSON.stringify({ name: MCP_NAME, ...serverEntry(launch) })];
}

export function registerWithClient(client: OtherClient, opts: { launch: string[]; home: string; run: Runner; vscode: string | null }): ClientRegistration {
  if (client === "vscode") {
    const manual = `in VS Code run "MCP: Add Server…" and choose a command (stdio) server, or run:\n  code ${vscodeAddArgs(opts.launch).map(quote).join(" ")}`;
    if (!opts.vscode) return { status: "client-missing", manual };
    const added = opts.run(opts.vscode, vscodeAddArgs(opts.launch));
    if (added.missing) return { status: "client-missing", manual };
    const output = (added.stdout + added.stderr).trim();
    if (added.status !== 0) return { status: "failed", detail: output.split("\n")[0] || `exit code ${added.status}`, manual };
    // This command replaces an entry of the same name and does not say whether there was one.
    return { status: "registered", where: "VS Code's user profile", replaced: false, notes: [] };
  }
  const strategy = STRATEGIES[client];
  return strategy.kind === "file" ? registerInFile(strategy.file(opts.home), strategy.key, opts.launch) : registerWithCommand(strategy, opts.launch, opts.run);
}

/** How to register with a client by hand, without running anything. */
export function manualFor(client: OtherClient, launch: string[], home: string): string {
  if (client === "vscode") return `code ${vscodeAddArgs(launch).map(quote).join(" ")}`;
  const strategy = STRATEGIES[client];
  if (strategy.kind === "command") return [strategy.binary, ...strategy.add(launch)].map(quote).join(" ");
  return `add under "${strategy.key}" in ${strategy.file(home)}:  ${JSON.stringify({ [MCP_NAME]: serverEntry(launch) })}`;
}

/** What to tell the person once their clients are set up: how the method reaches an agent that has no skill. */
export function firstMessageHint(clients: readonly OtherClient[]): string {
  const names = clients.map((c) => CLIENT_LABELS[c]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return (
    `Restart ${list} (or reload the MCP servers there), then ask the agent:\n` +
    `  Use SceneScout to test http://localhost:3000\n` +
    `The server hands the agent the testing method through its scout_playbook tool.`
  );
}
