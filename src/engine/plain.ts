/**
 * The report in plain words, for a reader who does not read request
 * signatures and route patterns: a QA tester, a product owner, anyone who
 * needs to act on a finding without decoding it first.
 *
 * It is a view over the same findings the technical report prints, never a
 * replacement: each item keeps its technical detail one click away, and the
 * `report` setting chooses which parts a document carries. Everything here is
 * pure string work, so the wording and the step translation are table-tested.
 */
import type { Finding, FindingCategory } from "./memory.js";
import type { OracleKind, OracleViolation } from "./oracles.js";

/** Which parts a report carries: the plain view and the technical one ("both"), or one of them. */
export const REPORT_AUDIENCES = ["both", "qa", "dev"] as const;
export type ReportAudience = (typeof REPORT_AUDIENCES)[number];
/** Both, so nobody loses the part they rely on unless they ask to. */
export const DEFAULT_REPORT_AUDIENCE: ReportAudience = "both";

/** How one kind of problem reads to someone who is not a developer. */
export interface PlainWording {
  /** What kind of problem it is, as a short sentence. */
  problem: string;
  /** What a person using the app would expect instead. */
  expected: string;
}

/**
 * The plain wording for every finding category and every oracle kind, in one
 * table. contract-test holds its keys equal to FINDING_CATEGORIES and
 * ORACLE_KINDS, so a new category or oracle cannot ship without its words.
 */
export const PLAIN_WORDING: Record<FindingCategory | OracleKind, PlainWording> = {
  // Finding categories.
  "console-error": { problem: "The page reported an error behind the scenes", expected: "The page works without reporting errors." },
  "page-error": { problem: "Something on the page broke while it was being used", expected: "The page keeps working while it is used." },
  "http-error": { problem: "The server refused or failed a request", expected: "The action completes, or the page says clearly why it could not." },
  network: { problem: "A request to the server did not get through", expected: "The page loads what it needs, or says what is missing." },
  "dead-end": { problem: "A path led nowhere", expected: "Every link and button leads somewhere useful, with a way back." },
  "ux-confusing": { problem: "Something is confusing to use", expected: "It is clear what to do and what happened." },
  "ux-polish": { problem: "Something feels unfinished", expected: "The page looks finished and consistent." },
  visual: { problem: "Something looks wrong on screen", expected: "Everything is visible, readable and in its place." },
  a11y: { problem: "Some people cannot use this part", expected: "Everyone can use it, including with a keyboard or a screen reader." },
  "permission-leak": { problem: "Someone can see or do something they should not", expected: "Each person sees and does only what their role allows." },
  "data-inconsistency": { problem: "The information shown does not add up", expected: "The same information agrees everywhere it is shown." },
  "stale-state": { problem: "The page shows out-of-date information", expected: "The page shows the current state after every change." },
  "data-loss": { problem: "Work or information was lost", expected: "What a person enters is kept." },
  performance: { problem: "Something is too slow", expected: "The page responds without a noticeable wait." },
  security: { problem: "A security weakness", expected: "The app keeps people's data and accounts safe." },
  "missing-testid": { problem: "A control automated tests cannot find reliably", expected: "Every control can be found reliably by automated tests." },
  other: { problem: "Something else is wrong", expected: "The app behaves the way a person using it would expect." },
  // Oracle kinds: what the automatic checks notice on every page.
  console_error: { problem: "The page reported an error behind the scenes", expected: "The page works without reporting errors." },
  page_error: { problem: "Something on the page broke while it was being used", expected: "The page keeps working while it is used." },
  request_failed: { problem: "A request to the server did not get through", expected: "The page loads what it needs, or says what is missing." },
  http_error: { problem: "The server refused or failed a request", expected: "The action completes, or the page says clearly why it could not." },
  dom_injection: { problem: "Text typed into a field came back as part of the page itself", expected: "What a person types is always shown as plain text." },
  refused_empty: {
    problem: "The server refused a request and the page showed nothing instead of an error",
    expected: "When something fails, the page says so.",
  },
  false_success: { problem: "The page said something worked when the server had refused it", expected: "The page reports only what really happened." },
  postmessage_token: { problem: "The page handed a sign-in token to any site that asked", expected: "Sign-in details go only to the app's own pages." },
};

/** The words for a category or oracle kind; one the table does not know (an older finding's) reads as "other". */
export function plainWording(kind: string): PlainWording {
  return Object.prototype.hasOwnProperty.call(PLAIN_WORDING, kind) ? PLAIN_WORDING[kind as FindingCategory | OracleKind] : PLAIN_WORDING.other;
}

/** Severity as its effect on the people using the app. */
export const IMPACT: Record<Finding["severity"], string> = { high: "Blocks users", medium: "Annoying", low: "Cosmetic" };

/** What a control's role is called in a sentence. */
const ROLE_WORD: Record<string, string> = {
  button: "button",
  link: "link",
  textbox: "field",
  searchbox: "search box",
  combobox: "list",
  listbox: "list",
  checkbox: "checkbox",
  radio: "option",
  switch: "switch",
  tab: "tab",
  menuitem: "menu item",
  option: "option",
  spinbutton: "field",
  slider: "slider",
  row: "row",
  cell: "cell",
};

/** `role "name"` as "the "name" button"; a target that is not that shape is quoted as it is. */
function control(target: string): string {
  const m = /^(\w+) "(.*)"$/.exec(target.trim());
  if (!m) return target.trim();
  const word = ROLE_WORD[m[1]] ?? m[1];
  return m[2] ? `the "${m[2]}" ${word}` : `the unnamed ${word}`;
}

/** One action-log step, split into what was done, to what, and on which page. */
function splitStep(line: string): { action: string; target: string; url: string } {
  const at = line.lastIndexOf(" @ ");
  const head = at >= 0 ? line.slice(0, at) : line;
  const url = at >= 0 ? line.slice(at + 3) : "";
  const space = head.indexOf(" ");
  return space < 0 ? { action: head, target: "", url } : { action: head.slice(0, space), target: head.slice(space + 1), url };
}

/** Actions that move to a page, and so start the steps that matter. */
const OPENS = new Set(["navigate", "crawl"]);

/**
 * One repro step as a person would do it, or null for a step only the tester
 * takes (a snapshot, a screenshot, an audit, the write policy's own notes).
 */
export function plainStep(line: string): string | null {
  const { action: raw, target, url } = splitStep(line);
  // A plan's step is the same action, run from a list.
  const action = raw.replace(/^plan:/, "");
  if (OPENS.has(action)) return `Go to ${url || target}`;
  let m: RegExpExecArray | null;
  if ((m = /^click(?:×(\d+))?$/.exec(action))) {
    const times = Number(m[1] ?? 1);
    const verb = times === 2 ? "Double-click" : times > 2 ? `Click ${times} times on` : "Click";
    return `${verb} ${control(target)}`;
  }
  if (action === "type") {
    const t = /^(\w+ ".*") ← ("(?:[^"\\]|\\.)*")( \+ Enter)?/.exec(target);
    if (!t) return `Type into ${control(target)}`;
    return `Type ${t[2]} into ${control(t[1])}${t[3] ? " and press Enter" : ""}`;
  }
  if (action === "select") {
    const s = /^(\w+ ".*") = (.*)$/.exec(target);
    return s ? `Choose "${s[2]}" in ${control(s[1])}` : `Choose an option in ${control(target)}`;
  }
  if (action === "upload") {
    const u = / ← (.+?) \(/.exec(target);
    return u ? `Attach the file "${u[1]}"` : "Attach a file";
  }
  if (action === "hover") return `Point at ${control(target)}`;
  if (action === "press") return `Press ${target}`;
  if (action === "scroll") return target ? `Scroll ${target}` : "Scroll the page";
  if (action === "back") return "Go back to the previous page";
  return null;
}

/** The page a step was on, for the first step when the trace has no navigation of its own. */
function pageOf(line: string | undefined): string {
  return line ? splitStep(line).url : "";
}

/**
 * A finding's repro trace as numbered steps a person can follow. It starts at
 * the last time the run went to a page, since what came before that was on
 * another page; when it never did, it starts by going to the page the trace
 * began on. Steps only the tester takes are left out.
 */
export function plainSteps(repro: readonly string[]): string[] {
  let start = -1;
  for (let i = repro.length - 1; i >= 0; i--) {
    if (OPENS.has(splitStep(repro[i]).action.replace(/^plan:/, ""))) {
      start = i;
      break;
    }
  }
  const steps = (start >= 0 ? repro.slice(start) : repro).map(plainStep).filter((s): s is string => s !== null);
  if (start < 0) {
    const first = pageOf(repro[0]);
    if (first) steps.unshift(`Go to ${first}`);
  }
  return steps;
}

/** A relative path inside the run's folder, safe to put in a document: no scheme, no `..`, nothing absolute. */
export function isSafeRelativePath(p: string): boolean {
  return /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(p) && !p.split("/").includes("..") && !p.includes("//");
}

/**
 * The picture of a finding, as a path relative to the run's folder, or
 * undefined. A finding's own picture (`picture`, set when it is filed) comes
 * first; on a recorded run the last frame on screen before it was filed stands
 * in. A value that is not a safe relative path is ignored, since the file is
 * read back without a schema and the path goes into a page.
 */
export function pictureOf(f: Finding, lastFrame?: string): string | undefined {
  const own = (f as Finding & { picture?: unknown }).picture;
  for (const p of [own, lastFrame]) if (typeof p === "string" && isSafeRelativePath(p)) return p;
  return undefined;
}

/** What the plain section is built from: the run's findings and what it noticed, already split by the report. */
export interface PlainInput {
  /** Defects this run found or re-confirmed, worst first. */
  current: readonly Finding[];
  /** Open defects from earlier runs, not re-confirmed by this one. */
  historical: number;
  /** Observations that are defects only under a project convention. */
  worthALook: number;
  /** The app's own oracle violations this session (not other sites' frames). */
  violations: readonly Pick<OracleViolation, "kind">[];
  /** Pages known and visited, when the report knows them. */
  routes?: { visited: number; total: number };
  /** The gap ledger's entries. */
  gaps: readonly string[];
  /** The last recorded frame before each finding, by id, on a recorded run. */
  lastFrames?: ReadonlyMap<string, string>;
  /** Which parts the document carries; decides where the technical detail is said to be. */
  audience: ReportAudience;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "a, b and c". */
function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The short summary that opens the plain section. */
export function plainSummary(input: PlainInput): string[] {
  const lines: string[] = [];
  const { current } = input;
  const by = (s: Finding["severity"]): number => current.filter((f) => f.severity === s).length;
  const where = input.routes && input.routes.total > 0 ? ` It went to ${input.routes.visited} of the ${input.routes.total} pages it knew about.` : "";
  if (current.length === 0) {
    lines.push(`This run found no problems.${where}`);
  } else {
    const split = (
      [
        ["high", "blocks users", "block users"],
        ["medium", "is annoying", "are annoying"],
        ["low", "is cosmetic", "are cosmetic"],
      ] as const
    )
      .filter(([s]) => by(s) > 0)
      .map(([s, one, many]) => `${by(s)} ${by(s) === 1 ? one : many}`);
    lines.push(`This run found ${count(current.length, "problem")}: ${joinAnd(split)}.${where}`);
  }
  const elsewhere = input.audience === "qa" ? "" : " They are listed in the technical detail below.";
  if (input.historical > 0) {
    lines.push(
      ``,
      `${count(input.historical, "problem")} found by earlier runs ${input.historical === 1 ? "was" : "were"} not checked again this time.${elsewhere}`,
    );
  }
  if (input.worthALook > 0) {
    lines.push(
      ``,
      `${count(input.worthALook, "observation")} ${input.worthALook === 1 ? "is a problem" : "are problems"} only if your project follows a particular convention, so ${input.worthALook === 1 ? "it is" : "they are"} not counted here.${elsewhere}`,
    );
  }
  const kinds = new Map<string, number>();
  for (const v of input.violations) kinds.set(v.kind, (kinds.get(v.kind) ?? 0) + 1);
  if (kinds.size > 0) {
    lines.push(``, `While it worked, the automatic checks noticed:`, ``);
    for (const [kind, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1]))
      lines.push(`- ${plainWording(kind).problem} (${n === 1 ? "once" : `${n} times`})`);
  }
  if (input.gaps.length > 0) {
    lines.push(``, `The run left ${count(input.gaps.length, "thing")} unchecked.${input.audience === "qa" ? "" : " The gap ledger below says which."}`);
    if (input.audience === "qa") {
      lines.push(``);
      for (const g of input.gaps) lines.push(`- ${g}`);
    }
  }
  return lines;
}

/** One finding in plain words, with its technical detail folded beneath it. */
export function plainFinding(f: Finding, index: number, input: Pick<PlainInput, "lastFrames" | "audience">): string[] {
  const words = plainWording(f.category);
  const lines = [`### ${index}. ${f.title}`, ``, `**${IMPACT[f.severity]}** · ${words.problem} · on ${f.url}`, ``];
  const picture = pictureOf(f, input.lastFrames?.get(f.id));
  if (picture) lines.push(`![What the page showed](${picture})`, ``);
  const steps = plainSteps(f.repro);
  if (steps.length > 0) {
    lines.push(`**What was done:**`, ``);
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push(``);
  }
  lines.push(`**What was expected:** ${words.expected}`, ``, `**What happened:** ${f.detail.replace(/\r?\n+/g, " ")}`, ``);
  lines.push(`<details><summary>Technical detail</summary>`, ``);
  // "Finding id", not "Id": the HTML and the live view hang a finding's recorded
  // frames under the list that names its "Id", and that is the full entry's.
  lines.push(`- **Finding id:** \`${f.id}\` · **Category:** ${f.category} · **Severity:** ${f.severity}`);
  if (f.evidence) lines.push(`- **Evidence:** \`${f.evidence}\``);
  lines.push(`- **Route:** \`${f.state}\``);
  if (input.audience !== "qa") lines.push(`- The full entry, with the repro trace and a test skeleton, is under the same id in the technical detail below.`);
  lines.push(``, `</details>`, ``);
  return lines;
}

/** The whole plain section: the summary, then each problem this run found, worst first. */
export function formatPlainSection(input: PlainInput): string[] {
  const lines = [`## In plain words`, ``, ...plainSummary(input), ``];
  input.current.forEach((f, i) => lines.push(...plainFinding(f, i + 1, input)));
  return lines;
}
