/**
 * The linear-time checks of memory-test and guided-test: each crafted 1 MB
 * text goes through the redaction or the credential check, and each must be
 * done within a bound. A backtracking pattern can take hours on one of these,
 * and nothing interrupts a regular expression on the thread running it, so the
 * suites call runLinearTimeCases, which runs this file in a child process and
 * stops it at the bound. As a child:
 *
 *   tsx scripts/linear-time-child.ts <redaction|credential>
 *
 * prints `start <case>` before each case and `done <case> <ms>` after it.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { holdsCredential } from "../src/engine/guided.ts";
import { redactSecrets } from "../src/engine/redact.ts";
import { maskFillCalls, redactPersonal, secretWordKind } from "../src/engine/sensitive.ts";

/** One megabyte of `unit`, between `prefix` and `suffix`. */
function megabyte(unit: string, prefix = "", suffix = ""): string {
  const room = 1_000_000 - prefix.length - suffix.length;
  return prefix + unit.repeat(Math.max(1, Math.floor(room / unit.length))) + suffix;
}

const CASES: Record<string, Array<[string, () => unknown]>> = {
  redaction: [
    ["a secret's name, then spaces and no colon (name=value rule)", () => redactSecrets(megabyte(" ", "password", "x"))],
    ["a value of full stops (name=value rule's full stop)", () => redactSecrets(megabyte(".", "password: ", "x"))],
    ["a parameter named by one long word (the name's words)", () => redactSecrets(megabyte("A", "?", "=1"))],
    ["a field label of one long word (a value typed into a secret field)", () => redactSecrets(megabyte("A", '"', '" ← "x"'))],
    ["keyword values with no digit, over and over (name=value and keyword rules)", () => redactSecrets(megabyte("token="))],
    ["a keyword, then equals signs (name=value and keyword rules)", () => redactSecrets(megabyte("=", "token"))],
    ["a provider prefix, over and over (sk_ rule)", () => redactSecrets(megabyte("sk-aaaaaaaa-"))],
    ["a bearer word inside each token (bearer rules)", () => redactSecrets(megabyte("Bearer a."))],
    ["a bearer token of letters, then a mark (letters-only bearer rule)", () => redactSecrets(megabyte("a", "Bearer ", "!"))],
    ["a PIN, then digits (PIN rule)", () => redactSecrets(megabyte("1", "PIN "))],
    ["codes after an error's word, over and over (sign-in code rule)", () => redactSecrets(megabyte("error code 123456 "))],
    ["private keys' starts with no end (private key rule)", () => redactSecrets(megabyte("-----BEGIN PRIVATE KEY-----"))],
    ["an address's domain of numbered labels (email rule)", () => redactPersonal(megabyte("b.1", "a@"))],
    ["a run of digits between two addresses (email rule's lookbehind)", () => redactPersonal(megabyte("1", "a@b.cc", "@d.ee"))],
    ["quoted local parts, over and over (email rule)", () => redactPersonal(megabyte('x"a"@'))],
    ["an address spelled out with words (spelled email rule)", () => redactPersonal(megabyte("x dot ", "jo at "))],
    ["phone numbers, over and over (phone rule)", () => redactPersonal(megabyte(`phone +1 ${"1".repeat(30)} `))],
    ["a phone's word, then spaces (phone rule)", () => redactPersonal(megabyte(" ", "phone"))],
    ["single digits apart (card rule)", () => redactPersonal(megabyte("1 "))],
    ["digits between dots and hyphens (card rule)", () => redactPersonal(megabyte("1.-"))],
    ["a name of capitals (field name words)", () => secretWordKind(megabyte("A"))],
    ["a name of digits, then a letter (field name words)", () => secretWordKind(megabyte("1", "", "a"))],
    ["a fill call to the end of a long line (fill calls)", () => maskFillCalls(megabyte("x", "fill("))],
  ],
  credential: [
    ["one long word (#578: the address remover)", () => holdsCredential(megabyte("a"))],
    ["a long word, then a scheme's colon and slashes (the address remover)", () => holdsCredential(megabyte("a", "", "://"))],
    ["names and colons inside words (colon pairs)", () => holdsCredential(megabyte("1ab:"))],
    ["a name and a slash, over and over (slash pairs)", () => holdsCredential(megabyte("bob / "))],
    ["pass, over and over (pass and its value)", () => holdsCredential(megabyte("pass "))],
    ["a secret's word, over and over (a secret's word and its value)", () => holdsCredential(megabyte("password "))],
    ["use, then a long word (a value to type when asked)", () => holdsCredential(megabyte("x", "use "))],
  ],
};

/** How long one case may take: on a laptop each linear pass over 1 MB takes under five seconds; a quadratic one, hours. */
export const CASE_BOUND_MS = 30_000;

/**
 * Each case of a suite and how long it took, run in a child process; if a
 * case is still running at the bound, the child is stopped and that case is
 * `stoppedIn`.
 */
export function runLinearTimeCases(suite: "redaction" | "credential"): Promise<{ done: Array<{ name: string; ms: number }>; stoppedIn: string | null }> {
  // Node itself with tsx's loader, never the npx/tsx shim: Windows refuses to spawn a .cmd without a shell.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), suite], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done: Array<{ name: string; ms: number }> = [];
  let running: string | null = null;
  let stoppedIn: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let pending = "";
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout.on("data", (d: Buffer) => {
    pending += d.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("start ")) {
        running = line.slice("start ".length);
        const name = running;
        timer = setTimeout(() => {
          stoppedIn = name;
          child.kill();
        }, CASE_BOUND_MS);
      } else if (line.startsWith("done ")) {
        clearTimeout(timer);
        const finished = line.slice("done ".length);
        const at = finished.lastIndexOf(" ");
        done.push({ name: finished.slice(0, at), ms: Number(finished.slice(at + 1)) });
        running = null;
      }
    }
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (stoppedIn !== null) resolve({ done, stoppedIn });
      else if (code !== 0 || running !== null) reject(new Error(`the linear-time child exited ${code}: ${stderr}`));
      else resolve({ done, stoppedIn: null });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = CASES[process.argv[2] ?? ""];
  if (!cases) throw new Error(`usage: linear-time-child <${Object.keys(CASES).join("|")}>`);
  for (const [name, run] of cases) {
    console.log(`start ${name}`);
    const t = performance.now();
    run();
    console.log(`done ${name} ${Math.round(performance.now() - t)}`);
  }
}
