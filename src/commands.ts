/**
 * How the CLI decides what a command line asks for, before any command runs.
 *
 * It lives apart from cli.ts so it can be table-tested: `scenescout install
 * --help` once ran a real install, because install read only the flags it knew
 * and ignored the rest. Every subcommand now answers `--help` / `-h` with the
 * usage text and exit 0 before it does anything, and a command that parses its
 * own flags by hand refuses one it does not know.
 */

/** Every subcommand, each run by a handler cli.ts supplies. */
export type Subcommand = "scan" | "serve" | "install" | "doctor" | "check" | "ci" | "login" | "status" | "watch";
const HANDLERS_OF: Readonly<Record<Subcommand, true>> = {
  scan: true,
  serve: true,
  install: true,
  doctor: true,
  check: true,
  ci: true,
  login: true,
  status: true,
  watch: true,
};
export const SUBCOMMANDS = Object.keys(HANDLERS_OF) as Subcommand[];

/** The arguments a hand-parsed command accepts. */
interface FlagSpec {
  /** Flags that stand alone. */
  switches: readonly string[];
  /** Flags that take a value, as `--name value` or `--name=value`. */
  valued: readonly string[];
  /** A likely slip and the flag it was probably meant to be. */
  hints?: Readonly<Record<string, string>>;
  /** How many arguments that are not flags it takes. */
  positional: number;
}

/**
 * Commands that read their arguments by hand. `check`, `ci` and `login` are
 * absent: their own parsers refuse unknown options. `serve` is absent on
 * purpose: it is the line an MCP client launches, and a stray argument there
 * should not stop the server from starting.
 */
export const HAND_PARSED: Readonly<Record<string, FlagSpec>> = {
  install: {
    switches: ["--skip-browser", "--no-register", "--no-command", "--browser-only"],
    valued: ["--browsers", "--client", "--clients"],
    // `--browser` is what `check` and `login` call it; for install it would otherwise download Chromium regardless.
    hints: { "--browser": "--browsers" },
    positional: 0,
  },
  doctor: { switches: ["--engine"], valued: [], positional: 0 },
  scan: { switches: [], valued: [], positional: 1 },
  status: { switches: [], valued: [], positional: 1 },
  watch: { switches: ["--no-open"], valued: [], positional: 1 },
};

/** True when the arguments ask for help. */
export function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** The first argument `spec` does not accept, as an error sentence; null when every one is accepted. */
export function unknownArgument(args: readonly string[], spec: FlagSpec): string | null {
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-") {
      if (++positional > spec.positional) return `unexpected argument ${arg}`;
      continue;
    }
    const name = arg.split("=")[0];
    if (spec.valued.includes(name)) {
      // The value after a valued flag is not itself a flag, even when it starts with a dash.
      if (!arg.includes("=")) i++;
      continue;
    }
    if (spec.switches.includes(name) && !arg.includes("=")) continue;
    const hint = spec.hints?.[name];
    return `unknown option ${name}${hint ? ` — did you mean ${hint}?` : ""}`;
  }
  return null;
}

/** What to do with a command line before running anything. */
export type Preflight = { kind: "help" } | { kind: "error"; message: string } | { kind: "run" };

/** Whether `command` names a subcommand. */
export function isSubcommand(command: string | undefined): command is Subcommand {
  return command !== undefined && Object.hasOwn(HANDLERS_OF, command);
}

/** Settle help and flag errors for a subcommand before its handler is reached. */
export function preflight(command: Subcommand, args: readonly string[]): Preflight {
  if (wantsHelp(args)) return { kind: "help" };
  const spec = Object.hasOwn(HAND_PARSED, command) ? HAND_PARSED[command] : undefined;
  const problem = spec ? unknownArgument(args, spec) : null;
  return problem ? { kind: "error", message: problem } : { kind: "run" };
}

export interface CliHandlers {
  /** Print the usage text and exit with this code. */
  usage: (exitCode: number) => never;
  version: () => void;
  /** A command line the preflight refused: print the sentence and exit non-zero. */
  refuse: (message: string) => never;
  commands: Record<Subcommand, (args: string[]) => void | Promise<void>>;
}

/**
 * Run the command line: help and flag errors are settled here, so a subcommand's
 * handler is reached only when it is actually meant to run.
 */
export async function dispatch(command: string | undefined, args: string[], h: CliHandlers): Promise<void> {
  switch (command) {
    // Asking for help is not an error; scripts and shells treat a non-zero exit as one.
    case "--help":
    case "-h":
    case "help":
      return h.usage(0);
    case "--version":
    case "-v":
      return h.version();
  }
  if (!isSubcommand(command)) return h.usage(1);
  const verdict = preflight(command, args);
  if (verdict.kind === "help") return h.usage(0);
  if (verdict.kind === "error") return h.refuse(verdict.message);
  await h.commands[command](args);
}
