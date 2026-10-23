/**
 * Whether two findings are one defect: the rule the memory store applies when a
 * finding is filed (isDuplicateFinding) and the pieces it is built from, by
 * kind, evidence, quoted literal and title. Split from memory.ts; memory.ts
 * re-exports the public names, so importers are unchanged.
 */
import type { Finding } from "./memory.js";
import { normalizePath, shortHash } from "./fingerprint.js";
import { fromJs } from "./js-regex.js";

const NOT_TOKEN_RE = fromJs(String.raw`[^a-z0-9/ ]+`);
const WHITE_SPACE_RE = fromJs(String.raw`\s+`);
const IES_END_RE = fromJs(String.raw`ies$`);
const isWordChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
/** `(?<=\w{3})e?s$`: a plural's ending after three letters of a word, the lookbehind a check of the three before. */
const PLURAL_END_RE = fromJs(
  String.raw`e?s$`,
  "",
  { accept: ({ index }, text) => [1, 2, 3].every((k) => index >= k && isWordChar(text[index - k])) },
  String.raw`(?<=\w{3})e?s$`,
);
const LITERAL_RE = fromJs(String.raw`"([^"]{8,80})"|'([^']{8,80})'|\(([^)]{8,80})\)|“([^”]{8,80})”`);
const FAILING_SIGNATURE_RE = fromJs(String.raw`\s[45]\d{2}$`);
const ENDPOINT_RE = fromJs(String.raw`\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/[A-Za-z0-9/_.:{}$-]*)`, "i");
const TRAILING_SLASHES_RE = fromJs(String.raw`\/+$`);
const STATUS_RE = fromJs(String.raw`\b([45]\d{2})\b`);

/** Shared finding-similarity helpers (used by live dedup and retro-merge). */
function findingTokens(s: string): Set<string> {
  return new Set(
    WHITE_SPACE_RE.splitText(NOT_TOKEN_RE.replace(s.toLowerCase(), " "))
      .filter((t) => t.length > 2)
      // crude stemming so entries/entry, displays/display collide
      .map((t) => PLURAL_END_RE.replaceFirst(IES_END_RE.replaceFirst(t, "y"), "")),
  );
}

function findingJaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/** How alike two titles are, 0 to 1, by the token overlap the rule's last tier uses. Orders the dedup judge's candidates. */
export function titleSimilarity(a: string, b: string): number {
  return findingJaccard(findingTokens(a), findingTokens(b));
}

/**
 * Distinctive literals — quoted or parenthesized fragments like
 * `"(role not recorded)"` or `"Document not found"`. Two findings on the same
 * route sharing one are the same bug however the prose around it is phrased.
 */
function findingLiterals(...texts: Array<string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of LITERAL_RE.matchAll(text)) {
      const literal = (m.groups[1] ?? m.groups[2] ?? m.groups[3] ?? m.groups[4] ?? "").toLowerCase().trim();
      if (literal) out.add(literal);
    }
  }
  return out;
}

/**
 * Canonical `METHOD /path STATUS` triples named by a finding's evidence.
 *
 * `evidence` exists to be a MACHINE signature, so when two findings name the
 * same endpoint failing the same way they are the same bug — whichever page
 * the tester happened to be on when they wrote it up. Ids in the path collapse
 * (`/api/users/7` and `/api/users/9` are one endpoint) so a per-record repro
 * does not read as a per-record bug.
 */
/**
 * The signatures that identify a BUG: only those carrying a failure status.
 *
 * A bare `POST /api/orders` says which endpoint was involved, not what went
 * wrong — a double submit and an accepted negative quantity both name it, and
 * are two bugs. Exported so calibration applies the store's own rule instead
 * of a second copy of this regex, which is what it had.
 */
export function failingSignatures(evidence: string | undefined): Set<string> {
  return new Set([...endpointSignatures(evidence)].filter((sig) => FAILING_SIGNATURE_RE.test(sig)));
}

/**
 * The endpoint signatures a piece of evidence names: method + normalised path,
 * with the failure status when one follows.
 */
export function endpointSignatures(evidence: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!evidence) return out;
  const endpoints = [...ENDPOINT_RE.matchAll(evidence)];
  for (const [i, m] of endpoints.entries()) {
    const method = (m.groups[1] ?? "").toUpperCase();
    const path = normalizePath(TRAILING_SLASHES_RE.replaceFirst(m.groups[2] ?? "", "") || "/").toLowerCase();
    // Each endpoint takes the status from its OWN window — the text between it
    // and the next endpoint mentioned. Pairing every endpoint with every status
    // in the string invented signatures that were never claimed: evidence
    // reading "list loads (GET /api/x 200) but POST /api/x returns 500" also
    // produced "GET /api/x 500", which then merged — and silently discarded —
    // a genuine, separate finding about the GET. Two-endpoint evidence is
    // ordinary prose ("this works, that doesn't"), not an edge case.
    // The status must FOLLOW its endpoint. Reading one from earlier in the
    // string turned a quantity into a status — "list shows 500 items; GET
    // /api/items 200" claimed a 500 on an endpoint the evidence said returned
    // 200. So `GET /api/x 404` written as "404 on GET /api/x" yields only
    // `GET /api/x` and will not merge with the same bug written the other way
    // round: a visible duplicate, which is the safe direction to fail, since
    // the alternative discards a finding.
    const from = m.end;
    const to = i + 1 < endpoints.length ? endpoints[i + 1].index : evidence.length;
    const status = STATUS_RE.exec(evidence.slice(from, to))?.groups[1];
    out.add(status ? `${method} ${path} ${status}` : `${method} ${path}`);
  }
  return out;
}

/**
 * Same endpoint, same failure — regardless of which route it was filed from.
 * The route-scoped rules below cannot see this: one agent filed the analytics
 * 404 from the page that calls it, another from a different page, so two
 * findings for one bug survived a run. Requires evidence on BOTH sides and an
 * exact triple match, so it stays a machine-signal match, never a fuzzy one.
 */
function sharesEndpointSignature(a: { evidence?: string }, b: { evidence?: string }): boolean {
  if (!a.evidence || !b.evidence) return false;
  // Only a triple with a failure status is a signature of a bug. A bare
  // `POST /api/orders` (the endpoint answered 2xx, or no status was named)
  // says which endpoint was involved, not what went wrong: a double submit
  // and an accepted negative quantity both name it, and are two bugs.
  const aSigs = failingSignatures(a.evidence);
  if (aSigs.size === 0) return false;
  for (const sig of failingSignatures(b.evidence)) if (aSigs.has(sig)) return true;
  return false;
}

/**
 * The cross-route merge rule, with the two guards a bare signature match needs.
 *
 * - NEVER absorb into a RESOLVED finding. Without evidence identical enough to
 *   count as a regression, a signature match would increment the old entry's
 *   run count and return it — so a genuinely new bug on an endpoint that once
 *   had a fixed bug would never appear in the report at all. A duplicate is
 *   visible and cheap; a swallowed finding is neither.
 * - Require the same CATEGORY. One endpoint+status can carry two different
 *   bugs (a `security` 403 and a `ux-confusing` 403; a 400 for a bad date and a
 *   400 for a zero quantity), and the loser's title, detail and severity are
 *   discarded on merge.
 */
export function sameEndpointBug(
  existing: { status?: string; category: string; evidence?: string },
  incoming: { category: string; evidence?: string },
): boolean {
  if (existing.status === "resolved") return false;
  if (existing.category !== incoming.category) return false;
  return sharesEndpointSignature(existing, incoming);
}

/**
 * Whether two pieces of evidence each name a request and share none — compared
 * by method and normalised path, ignoring the status, so `GET /api/x` and
 * `GET /api/x/ 404` are one request. Evidence that names no request (a test id,
 * a toast's text) disagrees with nothing.
 */
export function requestsDisagree(a: string | undefined, b: string | undefined): boolean {
  const requests = (ev: string | undefined) => new Set([...endpointSignatures(ev)].map((sig) => sig.split(" ").slice(0, 2).join(" ")));
  const aReq = requests(a);
  const bReq = requests(b);
  if (aReq.size === 0 || bReq.size === 0) return false;
  for (const r of aReq) if (bReq.has(r)) return false;
  return true;
}

/**
 * Families of finding kinds that one bug is plausibly filed under by two
 * sessions: a crash is a page-error to one and a console-error to another, a
 * refused save is data-loss to one and data-inconsistency to another. Across
 * families — a layout defect and a data defect — a shared quoted string names
 * a place on the page, not a bug.
 *
 * The presentation kinds are each a family of their own. They are not
 * alternative labels for one observation: one element is routinely wrong in
 * several independent ways at once — clipped out of view (visual), styled like
 * body text (ux-polish), unnamed to a screen reader (a11y), missing its test id
 * — and the findings about it quote the same control name and name the same
 * test id. As one family, a link "styled like body text" was merged into the
 * finding that the same link was clipped, and the second finding was lost.
 */
const CATEGORY_FAMILY: Record<string, string> = {
  "data-inconsistency": "data",
  "data-loss": "data",
  "stale-state": "data",
  "http-error": "failure",
  network: "failure",
  "console-error": "failure",
  "page-error": "failure",
  visual: "visual",
  "ux-polish": "ux-polish",
  a11y: "a11y",
  "missing-testid": "missing-testid",
  "ux-confusing": "flow",
  "dead-end": "flow",
  security: "security",
  "permission-leak": "security",
  performance: "performance",
};

/**
 * Whether two categories are one family. "other" — the category for nothing
 * that fits — is a family of its own: as a wildcard, one "other" finding
 * quoting a control absorbed both the layout and the data finding about it. A
 * missing or unknown category matches nothing, so a finding read from an older
 * file never merges on a guess.
 */
export function sameFamily(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === "other" || b === "other") return a === b;
  const fa = CATEGORY_FAMILY[a];
  return fa !== undefined && fa === CATEGORY_FAMILY[b];
}

/**
 * Whether two findings may be one defect by KIND — what is wrong, as opposed
 * to where. The same category, or two categories of one family. Every
 * route-scoped rule below asks this first: evidence, a quoted literal and a
 * title all say where a defect is as often as what it is, so none of them may
 * merge a finding of one kind into a finding of another.
 */
export function sameKind(a: string | undefined, b: string | undefined): boolean {
  return (!!a && a === b) || sameFamily(a, b);
}

/** Evidence in lower case with each run of white space one space, to compare two as written. */
function squashed(evidence: string | undefined): string | undefined {
  return typeof evidence === "string" ? WHITE_SPACE_RE.replace(evidence.toLowerCase(), " ").trim() : undefined;
}

export function sameFinding(
  a: { title: string; detail?: string; evidence?: string; category?: string },
  b: { title: string; detail?: string; evidence?: string; category?: string },
): boolean {
  // What is wrong before where: two kinds of defect are two findings, however
  // alike their evidence, quoted text or titles.
  if (!sameKind(a.category, b.category)) return false;
  const aEv = squashed(a.evidence);
  const bEv = squashed(b.evidence);
  if (aEv && bEv && aEv === bEv) return true;
  // A shared distinctive literal (e.g. "Document not found anymore") marks the
  // same bug even when two sessions wrote DIFFERENT evidence strings. The
  // literal must be one the finding is ABOUT — i.e. quoted in at least one of
  // the two TITLES. Drawing it from detail prose as well merged unrelated bugs
  // that merely described the same screen: a data-integrity finding and a
  // layout finding on one page both quoted the UI strings they saw, shared
  // them, and collapsed into one. Matching a title literal against the other
  // finding's full text keeps the intended case (one states the string in its
  // title, the other mentions it in its detail).
  //
  // Only between findings of one FAMILY of kinds (see sameFamily). A quoted
  // string is as often the name of a control as a message the app showed, and
  // a layout defect naming the button it covers ("Save notes") shares that
  // literal with the data defect describing what the button does — in its
  // detail or its own title. Merged, the layout defect was filed and then lost
  // from the report on most runs of a benchmark. Within a family, one bug
  // filed twice under neighbouring categories still merges. Stricter than the
  // kind check above in one way: an unknown category read from an older file
  // is never merged on a quoted string, even with itself.
  //
  // And never when both findings' evidence names requests with no endpoint in
  // common. A quoted control name bridges two findings about that control
  // within one family too: "an unknown order id still offers its actions"
  // (GET /api/orders/9999 404) mentions the "Request manager approval" button
  // that "Request manager approval stays enabled on a pending order" (POST
  // …/request-approval 409) quotes in its title, and was merged into it.
  // Evidence that names a request is the finding's own statement of where it
  // happened; two findings naming different requests are two bugs. A request
  // that answered 2xx counts too — a false success names one — so the same bug
  // described once by its page load and once by its failing call stays as two
  // findings: a visible duplicate, the direction ADR 4 accepts.
  //
  // And when both findings carry evidence (and it differs, or it would have
  // matched above), the detail does not count: the literal must be in the
  // other finding's title or evidence, the two places a finding states what
  // it is about. A filter option's label ("Last 7 days") quoted in one title
  // and in passing in the other finding's detail names the control both
  // defects were found through, not one defect: an undated row listed under
  // the wrong group and four widgets ignoring the filter shared only that
  // label, and the second filing was lost to the first. Without evidence on
  // one side the detail still counts — nothing machine-written says they
  // differ.
  if (sameFamily(a.category, b.category) && !requestsDisagree(a.evidence, b.evidence)) {
    const aTitleLits = findingLiterals(a.title);
    const bTitleLits = findingLiterals(b.title);
    if (aTitleLits.size > 0 || bTitleLits.size > 0) {
      const bothEvidenced = !!(aEv && bEv);
      const aAll = findingLiterals(a.title, bothEvidenced ? undefined : a.detail, a.evidence);
      const bAll = findingLiterals(b.title, bothEvidenced ? undefined : b.detail, b.evidence);
      for (const lit of aTitleLits) if (bAll.has(lit)) return true;
      for (const lit of bTitleLits) if (aAll.has(lit)) return true;
    }
  }
  // Both carry evidence and neither matched above: distinct bugs, however
  // similar the titles — never fuzzy-merge across differing evidence.
  if (aEv && bEv) return false;
  return findingJaccard(findingTokens(a.title), findingTokens(b.title)) >= 0.5;
}

/** A finding's stored id: its category, title and route, so the same finding filed twice hashes the same. */
export function findingId(f: Pick<Finding, "category" | "title" | "state">): string {
  return shortHash(`${f.category}|${f.title.toLowerCase().trim()}|${f.state.split("#")[0]}`);
}

/**
 * The dedup rule `addFinding` applies: whether `incoming` is the finding
 * `existing` already records. The same id; or, on the same route, the same
 * finding by evidence, a quoted literal or title overlap (sameFinding); or,
 * from any route, the same endpoint failing the same way (sameEndpointBug).
 * Exported so the benchmark scores the rule the store runs, not a copy of it.
 */
export function isDuplicateFinding(
  existing: Pick<Finding, "id" | "category" | "title" | "state" | "status"> & { detail?: string; evidence?: string },
  incoming: Pick<Finding, "category" | "title" | "state"> & { detail?: string; evidence?: string },
): boolean {
  return (
    existing.id === findingId(incoming) ||
    (existing.state.split("#")[0] === incoming.state.split("#")[0] && sameFinding(existing, incoming)) ||
    sameEndpointBug(existing, incoming)
  );
}
