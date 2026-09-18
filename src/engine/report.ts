import fs from "node:fs";
import path from "node:path";
import { SHARED_CHROME_ROUTE, type Finding, type MemoryStore, type PageScore } from "./memory.js";
import type { OracleViolation } from "./oracles.js";

function playwrightSkeleton(f: Finding): string {
  const routeClass = f.state.split("#")[0].split("?")[0];
  let gotoPath = routeClass;
  let routeComment = "";
  try {
    gotoPath = new URL(f.url).pathname + new URL(f.url).search;
  } catch {
    /* keep normalized route */
  }
  // A session-specific id in the path (chat ids, record uuids) will not exist
  // in any future environment — goto the route's stable parent instead and
  // tell the test author to create/pick a concrete instance.
  if (routeClass.includes(":id")) {
    gotoPath = routeClass.split("/:id")[0] || "/";
    routeComment = `\n  // route class ${routeClass} — navigate to a concrete instance from here (the recorded id was session-specific)`;
  }
  const steps = f.repro.map((s) => `  // ${s}`).join("\n");
  return `test(${JSON.stringify(`regression: ${f.title}`)}, async ({ page }) => {
  await page.goto(${JSON.stringify(gotoPath)});${routeComment}
${steps}
  // TODO: replay the steps above with page.getByTestId()/getByRole(), then assert the fix:
  // expect(consoleErrors).toHaveLength(0);
});`;
}

/** Aggregate raw oracle events into a top-offenders table — 250 raw events are unreadable; 10 grouped signatures are actionable. */
function violationRollup(oracleLog: OracleViolation[]): string[] {
  if (oracleLog.length === 0) return [];
  const groups = new Map<string, { count: number; sample: string }>();
  for (const v of oracleLog) {
    // Signature: kind + detail with ids/hashes collapsed so the same failing
    // endpoint groups across records.
    const sig = `${v.kind}: ${v.detail.replace(/\b\d+\b/g, ":n").replace(/[0-9a-f]{8,}/gi, ":h").slice(0, 140)}`;
    const g = groups.get(sig);
    if (g) g.count += 1;
    else groups.set(sig, { count: 1, sample: v.detail.slice(0, 160) });
  }
  const top = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  return [
    `## Oracle violation rollup (${oracleLog.length} events, ${groups.size} distinct signatures)`,
    ``,
    `| Count | Signature |`,
    `|---|---|`,
    ...top.map(([sig, g]) => `| ${g.count} | \`${escapeTableCell(sig)}\` |`),
    ``,
  ];
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_ICON: Record<Finding["severity"], string> = { high: "🔴", medium: "🟠", low: "🟡" };

export interface ReportExtras {
  routesVisited: number;
  routesTotal: number;
  designAudits: number;
  /** Resources created by this session in safe-write mode — the cleanup list. */
  createdResources?: string[];
  /** Known routes never visited — first entry of the gap ledger. */
  unvisitedRoutes?: string[];
}

/**
 * Split an element key into words. Keys are `tid:some-test-id` or `role:name`,
 * and testids come in every casing convention there is — a `\b`-anchored regex
 * does NOT fire around an underscore, so `tid:widget_submit_btn` read as having
 * no submit control and the whole form was dropped from the ledger. Splitting
 * on separators AND camelCase boundaries makes the three conventions equal.
 */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Words naming a FILTER rather than a form field. Typing into a register's
 * search box exercises the control correctly; it is not a form left
 * unsubmitted. Matched per TOKEN, never as a substring — "search" inside
 * "research-title-input" is not a filter, and classing it as one hid a real
 * field.
 */
const FILTER_TOKENS = new Set(["search", "filter", "filters", "query", "lookup", "sort", "facet", "q"]);

/**
 * Words that offer a SUBMIT. A page with no such control cannot have an
 * unsubmitted form on it — whatever was typed there went into a filter.
 * Deliberately wide: a wizard's "Next" commits its step, and this list is the
 * difference between reporting a real gap and silently dropping it.
 */
const SUBMIT_TOKENS = new Set([
  "submit", "save", "create", "send", "apply", "register", "post", "upload", "add", "confirm", "continue", "next",
  "finish", "generate", "assign", "approve", "report", "request", "update", "publish", "login", "signin", "signup",
  "proceed", "done", "ok", "go", "pay", "checkout", "subscribe", "place", "sign", "start", "invite", "import",
]);

/** An element key naming a filter control (a search box, a facet, a sort). */
function isFilterKey(key: string): boolean {
  return keyTokens(key).some((t) => FILTER_TOKENS.has(t));
}

/**
 * Does this state offer something to submit? A key that ALSO reads as a filter
 * does not count — `tid:report-filter` names a filter, not a "report" action.
 */
function offersSubmit(elements: Record<string, unknown>): boolean {
  return Object.keys(elements).some((key) => {
    const toks = keyTokens(key);
    return toks.some((t) => SUBMIT_TOKENS.has(t)) && !toks.some((t) => FILTER_TOKENS.has(t));
  });
}

/**
 * The collector stops at 150 elements, so on a dense page the submit control
 * may simply not be in the element list. "No submit found" then means "we did
 * not look far enough", not "there is nothing to submit" — never suppress on
 * that basis.
 */
const COLLECTOR_CAP = 150;

/**
 * Make app-controlled text safe inside a Markdown table cell. The backslash
 * must be escaped FIRST: escaping only the pipe turns an input of `\|` into
 * `\\|`, which Markdown reads as a literal backslash followed by a live
 * column separator — the app's own error text could then break the table, or
 * forge an extra column in a report people trust. Newlines end a row, so they
 * are flattened too.
 */
export function escapeTableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Split routes where something was typed/picked/attached into the ones that
 * genuinely look like an unsubmitted FORM, and the ones the heuristic declined
 * to judge because it found no submit control.
 *
 * The second list is reported too — as a DISCLOSURE, not a gap. Suppressing a
 * would-be entry silently is the failure mode this whole rule risks: filters
 * and read-only views look exactly like a form whose submit button is unlabeled
 * or icon-only, and the ledger's claim is that it enumerates what was not
 * tested. It must not gate `extensive`, though: a register search box exists on
 * nearly every app, and gating on it would make the contract unsatisfiable —
 * which is what the original false positive did.
 */
export function classifyFilledStates(
  memory: MemoryStore,
  facts: Record<string, { mutated?: boolean }>,
): { unsubmitted: string[]; noSubmitControl: string[] } {
  const unsubmitted = new Set<string>();
  const noSubmitControl = new Set<string>();
  for (const st of Object.values(memory.states)) {
    const keys = Object.keys(st.elements);
    const filledForReal = keys.some(
      (key) =>
        st.elements[key].exercised &&
        /^(type|select|upload|plan:(type|select|upload))/.test(st.elements[key].lastAction ?? "") &&
        !isFilterKey(key),
    );
    if (!filledForReal) continue;
    if (facts[st.route]?.mutated || mutatedSiblingStep(st.route, facts)) continue;
    if (offersSubmit(st.elements) || keys.length >= COLLECTOR_CAP) unsubmitted.add(st.route);
    else noSubmitControl.add(st.route);
  }
  // A route with several states counts as testable if ANY of them offered a
  // submit — the modal holding the form is a different state from the page
  // behind it.
  for (const r of unsubmitted) noSubmitControl.delete(r);
  return { unsubmitted: [...unsubmitted], noSubmitControl: [...noSubmitControl] };
}

/** Only a STEP param marks a multi-URL form. `tab=`/`section=` are distinct screens, not stages of one form. */
const STEP_PARAM_RE = /(^|&)step=/i;

/**
 * Did a SIBLING step of the same multi-URL form actually submit? A wizard keeps
 * one form across `/x?step=1..n` (and `/x` itself); the POST lands on whichever
 * URL is last, so every earlier step reads as abandoned.
 *
 * Deliberately narrow to `step=`. Grouping on the path alone let ANY
 * query-bearing sibling clear another: a genuinely abandoned form on
 * `/settings?tab=profile` was silenced by an unrelated save on
 * `/settings?tab=billing`. The engine treats `tab=`/`section=` as separate
 * screens everywhere else, so those are exactly the routes the ledger exists
 * to report — suppressing them there would hide true positives.
 */
function mutatedSiblingStep(route: string, facts: Record<string, { mutated?: boolean }>): boolean {
  const [path, query = ""] = route.split("?");
  if (!STEP_PARAM_RE.test(query)) return false;
  return Object.entries(facts).some(([other, f]) => {
    if (!f?.mutated) return false;
    const [otherPath, otherQuery = ""] = other.split("?");
    // The submitting sibling is another step, or the wizard's bare entry URL.
    return otherPath === path && (STEP_PARAM_RE.test(otherQuery) || otherQuery === "");
  });
}

/**
 * The route line of ft_coverage.
 *
 * It must count the SAME route set the report enforces — scanned routes plus
 * link-discovered ones. It used to count scanned routes only while taking the
 * unvisited list from the full set: a project with no scannable routes (any
 * code-routed framework, or a remote URL with no source at all) was told "no
 * enumerable route list" while dozens of discovered routes sat unvisited, and
 * a project with a few scanned routes and many discovered ones got a negative
 * visited count.
 */
export function formatRouteCoverage(allRoutes: string[], unvisited: string[]): string {
  if (allRoutes.length === 0) {
    return "No routes known yet — none were found in source and no links have been harvested. Snapshot the landing page and main navigation to discover them.";
  }
  const visited = allRoutes.length - unvisited.length;
  return (
    `Routes visited: ${visited}/${allRoutes.length}` +
    (unvisited.length > 0
      ? ` — UNVISITED: ${unvisited.slice(0, 25).join(", ")}${unvisited.length > 25 ? " …" : ""} (ft_crawl covers these in one call)`
      : " ✓")
  );
}

/**
 * The GAP LEDGER — an explicit enumeration of what was NOT tested. This is
 * what turns "extensive" from a vibe into a verifiable claim: a run is only
 * as trustworthy as its list of known gaps, and an empty ledger is the only
 * honest way to say "nothing was left untested".
 */
export function computeGaps(memory: MemoryStore, extras?: ReportExtras): string[] {
  const gaps: string[] = [];
  const cov = memory.coverage();
  const facts = memory.routeFacts;
  const visitedRoutes = [...new Set(Object.values(memory.states).map((st) => st.route))];
  if (extras?.unvisitedRoutes?.length) {
    gaps.push(`${extras.unvisitedRoutes.length} route(s) never visited: ${extras.unvisitedRoutes.slice(0, 10).join(", ")}${extras.unvisitedRoutes.length > 10 ? " …" : ""}`);
  }
  // `total` comes from coverage() so it is the SAME deduped, chrome-stripped
  // denominator that `keys` is a subset of. Recomputing it from raw state
  // elements (as this once did) counts every state's copy of a shared element,
  // so any route with two states had total > keys.length, the equality never
  // held, and a genuinely untouched route vanished from the ledger.
  // SHARED_CHROME_ROUTE is a pseudo-route: no state carries it, so it cannot be
  // "visited" and there is nothing to navigate to in order to clear it. Before
  // coverage() reported a total for it, it fell out of this filter by accident
  // (total === 0); excluding it explicitly keeps the ledger to entries a tester
  // can actually act on.
  const untouched = cov.unexercised.filter(
    (u) => u.state !== SHARED_CHROME_ROUTE && u.total > 0 && u.keys.length === u.total,
  );
  if (untouched.length > 0) {
    gaps.push(`${untouched.length} route(s) visited but NOTHING exercised (looked at, never touched): ${untouched.slice(0, 8).map((u) => u.state).join(", ")}${untouched.length > 8 ? " …" : ""}`);
  }
  const unaudited = visitedRoutes.filter((r) => !facts[r]?.audited);
  if (unaudited.length > 0) {
    gaps.push(`${unaudited.length}/${visitedRoutes.length} visited route(s) never design-audited: ${unaudited.slice(0, 8).join(", ")}${unaudited.length > 8 ? " …" : ""}`);
  }
  // Filled in, never committed. `mutated` records that a state-changing request
  // actually left the page; a route where someone typed, picked an option or
  // attached a file but nothing was ever submitted is a form that was looked
  // at, not tested. This is the only consumer of `mutated` — without it the
  // flag was write-only.
  //
  // Three shapes are NOT unsubmitted forms, and each used to be reported as one
  // on every run — noise a reader learns to skip, which is worse than silence:
  //   1. A register's SEARCH/FILTER box. Typing into it is the control working
  //      as designed; there is no submit on that route at all.
  //   2. A read-only page whose only inputs are filters (an audit-trail view,
  //      a usage dashboard). Same shape: nothing to submit.
  //   3. A WIZARD's intermediate step. The POST fires on the final step's URL,
  //      so the earlier `?step=` routes look abandoned even when the wizard
  //      completed — the form spans several URLs but is one form.
  // So: ignore filter-ish fields, require the state to actually offer a submit,
  // and let a mutation anywhere in a wizard clear its sibling steps.
  const { unsubmitted } = classifyFilledStates(memory, facts);
  if (unsubmitted.length > 0) {
    gaps.push(
      `${unsubmitted.length} route(s) had a form filled but NEVER submitted (no state-changing request left the page): ${unsubmitted.slice(0, 8).join(", ")}${unsubmitted.length > 8 ? " …" : ""}`,
    );
  }
  const journeyTotal = Object.values(facts).reduce((a, f) => a + (f.journeysCompleted ?? 0), 0);
  if (journeyTotal === 0) {
    gaps.push(
      `no COMPLETED ft_journey measurements — task EASE is untested. An abandoned journey is a finding, not coverage: it proves a task is blocked, not that it was measured.`,
    );
  }
  const roles = Object.keys(memory.roleAccess);
  if (roles.length < 2) gaps.push(`single-role run (${roles.join(", ") || "no role recorded"}) — permission boundaries and role capability gaps are untested`);
  return gaps;
}

export function generateReport(
  memory: MemoryStore,
  oracleLog: OracleViolation[],
  extras?: ReportExtras,
): { markdown: string; path: string; summary: string } {
  const cov = memory.coverage();
  const findings = [...memory.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const lines: string[] = [];
  const resolved = findings.filter((f) => f.status === "resolved");
  const open = findings.filter((f) => f.status !== "resolved");
  const current = open.filter((f) => f.foundAt >= memory.sessionStart);
  const historical = open.filter((f) => f.foundAt < memory.sessionStart);

  lines.push(`# SceneScout Report`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Open findings | ${open.length} (${open.filter((f) => f.severity === "high").length} high) — ${current.length} seen this session, ${historical.length} historical${resolved.length ? `, ${resolved.length} resolved (listed at the bottom)` : ""} |`);
  if (extras && extras.routesTotal > 0) lines.push(`| Route coverage | ${extras.routesVisited}/${extras.routesTotal} |`);
  lines.push(`| States explored | ${cov.states} |`);
  if (extras) lines.push(`| Design audits this session | ${extras.designAudits} |`);
  lines.push(`| Oracle violations this session | ${oracleLog.length} |`);
  lines.push(`| Elements exercised (informational — denominator grows with every state) | ${cov.elementsExercised}/${cov.elementsTotal} |`);
  lines.push(``);

  // ---- Page quality scores, worst first — the cross-page comparator. ----
  // Scores persist across runs, so a table sorted purely by number ranks
  // yesterday's un-fixed measurement above today's re-audit and reports a page
  // as "worst" when it simply wasn't re-measured. Mark anything not refreshed
  // this session so the ranking is read with its age attached.
  const scores = Object.entries(memory.pageScores).sort((a, b) => a[1].overall - b[1].overall);
  const isFresh = (sc: PageScore): boolean => sc.at >= memory.sessionStart;
  if (scores.length > 0) {
    const staleCount = scores.filter(([, sc]) => !isFresh(sc)).length;
    lines.push(`## Page quality scores (worst first)`);
    lines.push(``);
    if (staleCount > 0) {
      lines.push(`⏳ ${staleCount} of ${scores.length} scores are from an EARLIER run (marked stale). They rank against this run's numbers but were not re-measured — re-audit before treating a stale row as the worst page.`);
      lines.push(``);
    }
    lines.push(`| Route | Overall | A11y | Craft | Consistency | Task clarity | Audited |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const [route, sc] of scores.slice(0, 15)) {
      const age = isFresh(sc) ? sc.at.slice(0, 10) : `${sc.at.slice(0, 10)} ⏳ stale`;
      lines.push(`| \`${route}\` | **${sc.overall}** | ${sc.a11y} | ${sc.craft} | ${sc.consistency} | ${sc.clarity} | ${age} |`);
    }
    lines.push(``);
  }

  // ---- Role capability matrix — what each role could/couldn't reach. ----
  const roleAccess = memory.roleAccess;
  const roles = Object.keys(roleAccess);
  if (roles.length >= 2) {
    const allRoutes = [...new Set(roles.flatMap((r) => Object.keys(roleAccess[r])))].sort();
    // A role with NO entry for a route simply never went there — that is a
    // coverage gap, not a permission boundary. Comparing "absent" against
    // "reached" produced rows like "/ : admin ✓, qa —" for a route every role
    // can obviously reach, which reads as a denial and invites false findings.
    // Only compare roles that actually attempted the route, and only when at
    // least two did.
    const attemptedBy = (rt: string): string[] => roles.filter((r) => roleAccess[r][rt] !== undefined);
    const differing = allRoutes.filter((rt) => {
      const tried = attemptedBy(rt);
      return tried.length >= 2 && new Set(tried.map((r) => roleAccess[r][rt])).size > 1;
    });
    const oneRoleOnly = allRoutes.filter((rt) => attemptedBy(rt).length === 1).length;
    lines.push(`## Role capability matrix (${roles.length} roles)`);
    lines.push(``);
    lines.push(`Routes where roles that BOTH tried it diverged — each row is either a correct permission boundary or a gap ("should this role be able to do this?"). ✓ reached · ✗ redirected/denied · — not attempted by that role.`);
    lines.push(``);
    if (oneRoleOnly > 0) {
      lines.push(`${oneRoleOnly} route(s) were visited by only ONE role and are omitted — with nothing to compare against they say nothing about permissions, only about coverage.`);
      lines.push(``);
    }
    lines.push(`| Route | ${roles.join(" | ")} |`);
    lines.push(`|---|${roles.map(() => "---").join("|")}|`);
    for (const rt of differing.slice(0, 25)) {
      lines.push(`| \`${rt}\` | ${roles.map((r) => {
        const o = roleAccess[r][rt];
        return o === "reached" ? "✓" : o ? `✗ ${o.replace(/\|/g, "/")}` : "—";
      }).join(" | ")} |`);
    }
    if (differing.length === 0) lines.push(`(no divergence recorded — all roles saw the same surface)`);
    lines.push(``);
  }

  // ---- GAP LEDGER — what this run did NOT test. ----
  const gaps = computeGaps(memory, extras);
  lines.push(`## Gap ledger — what was NOT tested`);
  lines.push(``);
  if (gaps.length === 0) {
    lines.push(`Empty — every known route visited, exercised, audited; journeys measured; multi-role compared. This is what a complete extensive run looks like.`);
  } else {
    for (const g of gaps) lines.push(`- ⚠ ${g}`);
  }
  // Non-gating disclosures: what the ledger's heuristics declined to judge.
  // Printed so a suppressed entry is visible rather than absent, but kept out
  // of computeGaps so an ordinary search box cannot make `extensive`
  // unsatisfiable.
  const { noSubmitControl } = classifyFilledStates(memory, memory.routeFacts);
  if (noSubmitControl.length > 0) {
    lines.push(``);
    lines.push(
      `- ℹ ${noSubmitControl.length} route(s) had inputs filled but NO recognizable submit control, so they are NOT counted as unsubmitted forms above. ` +
        `Filters and read-only views look like this — but so does a real form whose submit is icon-only or unlabeled, so scan the list: ${noSubmitControl.slice(0, 10).join(", ")}${noSubmitControl.length > 10 ? " …" : ""}`,
    );
  }
  lines.push(``);

  const renderFinding = (f: Finding, complete = false): void => {
    lines.push(complete ? `### 🟢 [COMPLETE] ${f.title}` : `### ${SEVERITY_ICON[f.severity]} [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(``);
    if (complete) lines.push(`- **Resolved** (was ${f.severity})`);
    if (!complete && f.regressedAt) lines.push(`- **⟳ REGRESSED:** previously marked resolved, re-found ${f.regressedAt} — the fix did not hold`);
    lines.push(`- **Id:** \`${f.id}\` · **Category:** ${f.category}`);
    if (f.evidence) lines.push(`- **Evidence:** \`${f.evidence}\``);
    lines.push(`- **Where:** \`${f.state}\` (${f.url})`);
    lines.push(`- **Seen in runs:** ${f.runs}`);
    lines.push(``);
    lines.push(f.detail);
    lines.push(``);
    if (f.repro.length > 0) {
      lines.push(`<details><summary>Repro trace (last actions before finding)</summary>`);
      lines.push(``);
      f.repro.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      lines.push(``);
      lines.push(`</details>`);
      lines.push(``);
    }
    lines.push("```ts");
    lines.push(playwrightSkeleton(f));
    lines.push("```");
    lines.push(``);
  };

  lines.push(`## Findings — seen this session (${current.length})`);
  lines.push(``);
  if (current.length === 0) lines.push(`None recorded or re-confirmed this session.`, ``);
  for (const f of current) renderFinding(f);

  if (historical.length > 0) {
    lines.push(`## Historical findings — not re-verified this session (${historical.length})`);
    lines.push(``);
    lines.push(`Recorded in earlier runs and not re-confirmed. Re-test before acting; resolve fixed ones with \`ft_resolve <id>\`.`);
    lines.push(``);
    for (const f of historical) renderFinding(f);
  }

  if (resolved.length > 0) {
    lines.push(`## ✅ Resolved (${resolved.length})`);
    lines.push(``);
    lines.push(`Fixed and verified (or confirmed no longer reproducing). A resolved finding that is re-found reopens automatically and is flagged as a regression above.`);
    lines.push(``);
    for (const f of resolved) renderFinding(f, true);
  }

  if (extras?.createdResources && extras.createdResources.length > 0) {
    lines.push(`## Data created by this session (cleanup list)`);
    lines.push(``);
    lines.push(`Safe-write mode created these resources; delete them if the environment should stay pristine:`);
    lines.push(``);
    for (const r of extras.createdResources.slice(0, 50)) lines.push(`- \`${r}\``);
    lines.push(``);
  }

  lines.push(...violationRollup(oracleLog));

  if (cov.unexercised.length > 0) {
    lines.push(`## Unexplored surface (for the next run)`);
    lines.push(``);
    for (const u of cov.unexercised.slice(0, 30)) {
      lines.push(`- \`${u.state}\`: ${u.keys.slice(0, 8).join(", ")}${u.keys.length > 8 ? ` … +${u.keys.length - 8}` : ""}`);
    }
    lines.push(``);
  }

  const markdown = lines.join("\n");
  const outPath = path.join(memory.dir, "report.md");
  fs.writeFileSync(outPath, markdown);

  // Bounded summary for the tool result: full reports have exceeded client
  // token limits in real runs (66–72KB observed) — the wire gets the digest,
  // the disk gets the document.
  const summaryLines: string[] = [
    `Report written to ${outPath}`,
    ``,
    `OPEN FINDINGS: ${open.length} (${open.filter((f) => f.severity === "high").length} high) — ${current.length} this session, ${historical.length} historical${resolved.length ? `, ${resolved.length} resolved` : ""}`,
    ...(extras && extras.routesTotal > 0 ? [`COVERAGE: routes ${extras.routesVisited}/${extras.routesTotal} · ${cov.states} states · ${cov.elementsExercised}/${cov.elementsTotal} elements exercised`] : []),
    ...(scores.length > 0
      ? [`WORST PAGES: ${scores.slice(0, 3).map(([r, sc]) => `${r} ${sc.overall}/100`).join(" · ")}`]
      : []),
    ``,
    `Top open findings:`,
    ...open.slice(0, 10).map((f) => `  ${SEVERITY_ICON[f.severity]} [${f.severity}] ${f.title} (${f.id})`),
    ...(open.length > 10 ? [`  … +${open.length - 10} more in the report`] : []),
    ``,
    `Gap ledger${gaps.length === 0 ? ": EMPTY — nothing known left untested" : ` (${gaps.length}):`}`,
    ...gaps.map((g) => `  ⚠ ${g}`),
  ];
  return { markdown, path: outPath, summary: summaryLines.join("\n") };
}
