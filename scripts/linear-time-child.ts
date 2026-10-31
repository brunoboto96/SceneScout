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
import { landingOf } from "../src/engine/brief.ts";
import { templateIds } from "../src/engine/calibration.ts";
import { markdownCell, withoutOwnResponse, type RouteHealth } from "../src/engine/check.ts";
import { crawlFoundNothing, crawlNotes } from "../src/engine/ci-lanes.ts";
import { downloadIsNavigations } from "../src/engine/crawl.ts";
import { shadowLayers } from "../src/engine/design.ts";
import { readLifetime } from "../src/engine/expiry.ts";
import { endpointSignatures, sameFinding } from "../src/engine/finding-dedup.ts";
import { requestPathMatches } from "../src/engine/flow.ts";
import { isPattern } from "../src/engine/from-run.ts";
import { parseLaneReport, statedRequests } from "../src/engine/lane.ts";
import type { Finding } from "../src/engine/memory.ts";
import { withoutFragment } from "../src/engine/oracles.ts";
import { formatEvidenceSection, plainStep } from "../src/engine/plain.ts";
import { tokenShapeOf } from "../src/engine/postmessage.ts";
import { chooseSubmit, type FieldInfo } from "../src/engine/scripted-login.ts";
import { identifierIsDestructive, strictBodyIsDestructive } from "../src/engine/strict-writes.ts";
import { elementKey, isNonPageRoute, laneRoutePaths, stripRouteQuery } from "../src/engine/fingerprint.ts";
import { holdsCredential } from "../src/engine/guided.ts";
import {
  blockSignature,
  graphqlWriteOperation,
  hostileForEmbed,
  isDestructive,
  isDestructiveWire,
  readPostEntries,
  readPostsSetting,
  writeMethod,
} from "../src/engine/policy.ts";
import { findCriterion, parseTickets } from "../src/engine/tickets.ts";
import { redactSecrets } from "../src/engine/redact.ts";
import { maskFillCalls, redactPersonal, secretWordKind } from "../src/engine/sensitive.ts";

/** One megabyte of `unit`, between `prefix` and `suffix`. */
function megabyte(unit: string, prefix = "", suffix = ""): string {
  const room = 1_000_000 - prefix.length - suffix.length;
  return prefix + unit.repeat(Math.max(1, Math.floor(room / unit.length))) + suffix;
}

/** A finding with a picture, so the Evidence section lists it under this title. */
function titled(title: string): Finding {
  return {
    id: "0a1b2c3d4e",
    severity: "low",
    category: "visual",
    title,
    detail: "",
    evidence: "",
    url: "http://h/",
    state: "/",
    repro: [],
    foundAt: "2026-01-01T00:00:00.000Z",
    runs: 1,
    picture: "recordings/s1/finding-0a1b2c3d4e.png",
  };
}

/** A submit button with this text, as the scripted login reads it from a page. */
function button(text: string): FieldInfo {
  return {
    index: 0,
    tag: "button",
    type: "submit",
    name: "",
    id: "",
    autocomplete: "",
    label: "",
    text,
    inputmode: "",
    maxLength: -1,
    filled: false,
    disabled: false,
  };
}

/** A route that answered 500 at this address. */
function failedRoute(url: string): RouteHealth {
  return {
    path: "/",
    url,
    status: 500,
    loginRedirect: false,
    elements: 0,
    unnamed: [],
    placeholderOnly: [],
    violations: [],
    geometry: [],
    brokenImages: [],
    design: [],
  };
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
    ["a name of many words and no secret's word at its end (name=value rule's words)", () => redactSecrets(megabyte("a_", "", ": x"))],
    ["a name of many words before a key, then no colon (name=value rule's words)", () => redactSecrets(megabyte("a_", "", "signing_key x"))],
    ["Basic, then base64 that never ends (Basic credentials rule)", () => redactSecrets(megabyte("A", "Basic ", "-"))],
    ["Basic credentials, over and over (Basic credentials rule)", () => redactSecrets(megabyte("Basic dXNlcjpwYXNz "))],
    ["a marked key's tail of underscores and hyphens (sk_ rule)", () => redactSecrets(megabyte("_-", "sk-proj-"))],
    [
      "key prefixes with short tails, over and over (provider key rules)",
      () => redactSecrets(megabyte("SG.aaaaaaaaaaaaaaaa.a hf_a xapp-1-a whsec_a github_pat_a ")),
    ],
    ["a PIN, then digits (PIN rule)", () => redactSecrets(megabyte("1", "PIN "))],
    ["codes after an error's word, over and over (sign-in code rule)", () => redactSecrets(megabyte("error code 123456 "))],
    // Built from its parts, so the repository holds no private key's marker for the hygiene scan to find.
    ["private keys' starts with no end (private key rule)", () => redactSecrets(megabyte(`${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}`))],
    ["an address's domain of numbered labels (email rule)", () => redactPersonal(megabyte("b.1", "a@"))],
    ["a run of digits between two addresses (email rule's lookbehind)", () => redactPersonal(megabyte("1", "a@b.example.com", "@d.example.org"))],
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
  // The readers of text the app or a ticket supplies: ticket headings and criteria, routes, the write policy's labels,
  // URLs and bodies, and the calibration's request paths. Each text is shaped to make one pattern's JavaScript form backtrack.
  patterns: [
    ["a ticket heading of spaces (heading pattern)", () => parseTickets(megabyte(" ", "# ", "x"))],
    ["a ticket heading of colons and spaces (heading words)", () => parseTickets(megabyte(" :", "# PROJ-1 ", "y"))],
    ["a ticket heading of hash marks and spaces (heading pattern)", () => parseTickets(megabyte(" #", "## x ", "y"))],
    ["criteria lines of spaces (criterion patterns)", () => parseTickets(megabyte(" ", "AC1: ", "x\n- [ ] "))],
    ["a given step of spaces (step pattern)", () => parseTickets(megabyte(" ", "Scenario: s\nGiven ", "\n"))],
    ["a criterion name of spaces (criterion name)", () => findCriterion({ criteria: [] }, megabyte(" ", "ac", "x"))],
    ["a route of slashes, then a letter (trailing slashes)", () => laneRoutePaths(`/a${"/".repeat(999_990)}x`)],
    ["a word of quotes, then a letter (word edges)", () => laneRoutePaths(megabyte(".:!", "", "x"))],
    ["a route of words and hyphens (credential pair in a route)", () => stripRouteQuery(megabyte("a-"))],
    ["a route of hash marks (fragment)", () => stripRouteQuery(megabyte("#/"))],
    ["a route of query marks (query)", () => stripRouteQuery(megabyte("?a"))],
    ["a path of dots and letters (file extension)", () => isNonPageRoute(megabyte("a.", "/", "x"))],
    ["an element name of spaces (white space)", () => elementKey({ role: "button", name: megabyte(" x"), testid: null })],
    ["a path of numbers and commas (id lists)", () => templateIds(megabyte("1, /", "a/"))],
    ["a path of numbers and a stray letter (id lists)", () => templateIds(megabyte("1,", "a/", "x"))],
    ["a path of templates (template chain)", () => templateIds(megabyte("/{a}", "a"))],
    ["a long word before a slash (path head)", () => templateIds(megabyte("a", "", "/1"))],
    ["a label of 'reset' over and over (reset)", () => isDestructive(megabyte("reset "))],
    ["a label of 'remove' over and over (remove)", () => isDestructive(megabyte("Remove filter "))],
    ["a label of 'remove', then spaces (remove's end)", () => isDestructive(megabyte(" ", "remove filter", "x"))],
    ["a label of 'discard' over and over (discard)", () => isDestructive(megabyte("discard "))],
    ["a label of 'sign' over and over (sign off)", () => isDestructive(megabyte("sign-"))],
    ["a label of marks, then 'sign off' (sign off's start)", () => isDestructive(megabyte("!", "", " sign off"))],
    ["a url of verbs (destructive verb in a path)", () => isDestructiveWire(megabyte("/delete"), "")],
    ["a body of mutation and spaces (mutation window)", () => isDestructiveWire("/x", megabyte("mutation "))],
    ["a graphql body of mutation and spaces (write operation)", () => graphqlWriteOperation(megabyte("mutation "))],
    [
      "an override header of commas (override names)",
      () => writeMethod({ method: "POST", url: "http://h/x", headers: { "X-HTTP-Method-Override": megabyte(", ") } }),
    ],
    [
      "a body of disposition lines (multipart parts)",
      () => writeMethod({ method: "POST", url: "http://h/x", body: megabyte("Content-Disposition: form-data; name=x\r\n\r\n") }),
    ],
    ["a blocked url of query marks (signature)", () => blockSignature(megabyte("?#"))],
    ["a typed value of angle brackets (markup)", () => hostileForEmbed(megabyte("< "))],
    ["a setting of entries (read posts)", () => readPostsSetting(undefined, megabyte("POST /a,"))],
    ["a read post entry of spaces (post entry)", () => readPostEntries([megabyte(" ", "POST /a", "x y")])],
    // #618, the second round. On JavaScript's engine all but three of these took over 30 s at 1 MB (0.1 to 1 s at 10 KB);
    // the JWT's value is read to 64 KB, where it took 2.3 s, and a quoted literal and a fenced block were already linear.
    ["a download's url of hash marks (crawl's fragment)", () => downloadIsNavigations(megabyte("#", "", "\n#"), "x", [])],
    [
      "a cookie of JWT starts (profile expiry's JWT)",
      () => readLifetime({ cookies: [{ name: "a", value: megabyte("eyJJJ").slice(0, 64 * 1024), domain: "h", path: "/", expires: -1 }], origins: [] }),
    ],
    ["a route of open brackets (a route pattern)", () => landingOf([megabyte("[")])],
    ["a route of open brackets (from-run's route pattern)", () => isPattern(megabyte("["))],
    ["lines of an open session mark (crawl found nothing)", () => crawlFoundNothing(megabyte("[session \n"))],
    ["a crawl of route lines (crawl notes)", () => crawlNotes(megabyte("/a — 200 · 1 el\n", "", "PROBLEM ROUTES (1):\n/a: x\n"))],
    ["a stated path of full stops (stated requests)", () => statedRequests(megabyte(".", "GET /", "a"))],
    ["a stated path of slashes (stated requests)", () => statedRequests(megabyte("/", "GET ", "a"))],
    ["stated requests over and over (stated requests)", () => statedRequests(megabyte("GET /a -> 404 "))],
    ["a fenced reply that never closes (lane report)", () => parseLaneReport(megabyte("```\n", "x"))],
    ["an endpoint of slashes (finding dedup)", () => endpointSignatures(megabyte("/", "GET ", "a"))],
    ["evidence of brackets and quotes (finding dedup's literals)", () => sameFinding({ title: "a", evidence: megabyte("(“(") }, { title: "b", evidence: "x" })],
    ["a message key path of open brackets (postMessage's last key)", () => tokenShapeOf(megabyte("["), "abcdefghij0123456789abc")],
    ["an identifier of capitals (strict writes' words)", () => identifierIsDestructive(megabyte("A"))],
    ["a form body of capitals (strict writes)", () => strictBodyIsDestructive(megabyte("A", "action=", "0"))],
    ["a page url of hash marks (check's own response)", () => withoutOwnResponse(failedRoute(megabyte("#", "", "\n#")), "https://app.test")],
    ["a table cell of tabs (check's markdown cell)", () => markdownCell(megabyte("\t", "", "x"))],
    ["a request path of slashes (flow's request path)", () => requestPathMatches("/a", megabyte("/", "", "a"))],
    ["a button of 'try' over and over (scripted login's away words)", () => chooseSubmit([button(megabyte("A-TRY\u0000"))])],
    ["a button of 'continue with' over and over (scripted login's lookahead)", () => chooseSubmit([button(megabyte("continue with a code "))])],
    ["a button of 'continue with' and 'send' over and over (scripted login's lookahead)", () => chooseSubmit([button(megabyte("continue with a code send "))])],
    // #618, the last sites. On JavaScript's engine each took 0.9 to 18 s at 100 KB and over a minute at 1 MB.
    ["a page url of hash marks (a step's own response)", () => withoutFragment(megabyte("#", "", "\n#"))],
    ["a box-shadow of full stops (a shadow layer's lengths)", () => shadowLayers(megabyte(".", "1px "))],
    ["a box-shadow of open colours (a shadow layer's colour)", () => shadowLayers(megabyte("rgb(", "1px "))],
    ["a chosen option of quotes and equals signs (the plain step's select)", () => plainStep(`select ${megabyte('" = ', '0 "', "\n")}`)],
    ["an attached file of arrows (the plain step's upload)", () => plainStep(`upload ${megabyte(" ← \u0000", "", "\n ← ( (")}`)],
    ["a finding's title of tabs (the Evidence heading)", () => formatEvidenceSection({ current: [titled(megabyte("\t", "", "\u0000\n"))] })],
  ],
  credential: [
    ["one long word (#578: the address remover)", () => holdsCredential(megabyte("a"))],
    ["a long word, then a scheme's colon and slashes (the address remover)", () => holdsCredential(megabyte("a", "", "://"))],
    ["names and colons inside words (colon pairs)", () => holdsCredential(megabyte("1ab:"))],
    ["a name and a slash, over and over (slash pairs)", () => holdsCredential(megabyte("bob / "))],
    ["pass, over and over (pass and its value)", () => holdsCredential(megabyte("pass "))],
    ["a secret's word, over and over (a secret's word and its value)", () => holdsCredential(megabyte("password "))],
    ["use, then a long word (a value to type when asked)", () => holdsCredential(megabyte("x", "use "))],
    ["sign in, then dotted names and no with (sign in with)", () => holdsCredential(megabyte("a.b ", "sign in "))],
  ],
};

/** How long one case may take: on a laptop each linear pass over 1 MB takes under five seconds; a quadratic one, hours. */
export const CASE_BOUND_MS = 30_000;

/**
 * Each case of a suite and how long it took, run in a child process; if a
 * case is still running at the bound, the child is stopped and that case is
 * `stoppedIn`.
 */
export function runLinearTimeCases(
  suite: "redaction" | "credential" | "patterns",
): Promise<{ done: Array<{ name: string; ms: number }>; stoppedIn: string | null }> {
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
