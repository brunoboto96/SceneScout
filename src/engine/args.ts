/**
 * The one rule for a valued command-line option, shared by the parsers of
 * `check`, `ci` and `export`: `--name value` or `--name=value`, and a value
 * that is missing or looks like the next option is a mistake, not a value.
 * Each parser keeps its own rules for which names exist and which are switches.
 */

/** The option name in `--name` or `--name=value`. */
export function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq > 0 ? arg.slice(2, eq) : arg.slice(2);
}

/** The value of the option at `args[i]` and the index of the last argument it used. */
export function readFlagValue(args: readonly string[], i: number): { ok: true; name: string; value: string; last: number } | { ok: false; error: string } {
  const a = args[i];
  const eq = a.indexOf("=");
  const name = flagName(a);
  const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
  if (value === undefined || (eq < 0 && value.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
  return { ok: true, name, value, last: eq < 0 ? i + 1 : i };
}
