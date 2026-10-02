/**
 * Answering the tickets: reading acceptance criteria from the shapes tickets
 * are written in, checking each verdict an agent records on one, and the
 * per-ticket section of the report.
 *
 * The parser is held to two directions at once: it finds criteria in every
 * common shape, and it finds none in a ticket that has none, saying so,
 * rather than turning prose into criteria a person never wrote.
 *
 *   npx tsx --test scripts/tickets-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { MemoryStore, type Finding } from "../src/engine/memory.ts";
import { generateReport } from "../src/engine/report.ts";
import { settingsFromAnswers } from "../src/intake.ts";
import {
  addReading,
  addVerdict,
  answerCriterion,
  answerTicket,
  findCriterion,
  formatCriteriaForLanes,
  formatReading,
  formatTicketsPlain,
  formatTicketsTechnical,
  isTicketFileName,
  judgeCriterion,
  mergeTicketData,
  parseTickets,
  tally,
  ticketSummaryLine,
  type CriterionVerdict,
  type JudgeContext,
  type StoredTicket,
  type Ticket,
} from "../src/engine/tickets.ts";

/** Each ticket as id, title and its criteria's "id text". */
const shape = (tickets: Ticket[]): Array<{ id: string; title: string; criteria: string[] }> =>
  tickets.map((t) => ({ id: t.id, title: t.title, criteria: t.criteria.map((c) => `${c.id} ${c.text}`) }));

// ── Reading ───────────────────────────────────────────────────────────────────

test("Given/When/Then: each scenario is one criterion, with its name and steps", () => {
  const feature = [
    "# A comment in a feature file",
    "@orders",
    "Feature: Order filters",
    "",
    "  Scenario: Filter by status",
    "    Given I am on the orders page",
    "    When I choose Archived in the status filter",
    "    Then only archived orders are listed",
    "    And the filter is kept in the address",
    "",
    "  Scenario Outline: Each status",
    "    Given I am on the orders page",
    "    When I choose <status>",
    "    Then only <status> orders are listed",
    "    Examples:",
    "      | status |",
    "      | open   |",
  ].join("\n");
  const tickets = parseTickets(feature, "orders.feature");
  assert.deepEqual(shape(tickets), [
    {
      id: "T1",
      title: "Order filters",
      criteria: [
        "AC1 Filter by status: Given I am on the orders page; When I choose Archived in the status filter; Then only archived orders are listed; And the filter is kept in the address",
        "AC2 Each status: Given I am on the orders page; When I choose <status>; Then only <status> orders are listed",
      ],
    },
  ]);
  assert.ok(tickets[0].criteria.every((c) => c.shape === "given-when-then"));
  assert.equal(tickets[0].source, "orders.feature");

  // Steps with no Scenario line: a Given after a Then starts the next criterion.
  const bare = parseTickets(
    [
      "Saved searches",
      "",
      "Given I saved a search",
      "When I open the list",
      "Then it is there",
      "Given I deleted it",
      "When I open the list",
      "Then it is gone",
    ].join("\n"),
  );
  assert.deepEqual(shape(bare)[0].criteria, [
    "AC1 Given I saved a search; When I open the list; Then it is there",
    "AC2 Given I deleted it; When I open the list; Then it is gone",
  ]);
  assert.equal(bare[0].title, "Saved searches");
});

test("checklists, numbered lists and labelled criteria are each read in order", () => {
  assert.deepEqual(
    shape(parseTickets("Faster dashboard\n- [ ] Loads within 2 seconds\n- [x] The chart shows the last 7 days\n[ ] Bare boxes count too"))[0].criteria,
    ["AC1 Loads within 2 seconds", "AC2 The chart shows the last 7 days", "AC3 Bare boxes count too"],
  );
  assert.deepEqual(
    shape(parseTickets("Archive orders\n1. An order can be archived\n2) Archived orders leave the open list\n3. A confirmation is shown"))[0].criteria,
    ["AC1 An order can be archived", "AC2 Archived orders leave the open list", "AC3 A confirmation is shown"],
  );
  // A ticket's own "AC3" keeps its number, even out of order; the others fill the gaps.
  const labelled = parseTickets("AC1: Sign in with an email\nAC3: A wrong password says so\n- AC 2 - A locked account is told why\n- [ ] Unlabelled");
  assert.deepEqual(shape(labelled)[0].criteria, [
    "AC1 Sign in with an email",
    "AC3 A wrong password says so",
    "AC2 A locked account is told why",
    "AC4 Unlabelled",
  ]);
});

test("under an Acceptance criteria heading, plain bullets count, wrapped lines join, and only that section counts", () => {
  const ticket = [
    "# PROJ-12: Export orders as CSV",
    "",
    "## Description",
    "Users export orders for accounting.",
    "1. A numbered aside in the description",
    "",
    "## Acceptance criteria",
    "- The Export button downloads a CSV",
    "- The file has one row per order",
    "  and a header row",
    "  - nested detail joins its parent",
    "- [ ] An empty table exports a header only",
    "",
    "## Steps to reproduce",
    "1. Go to reports",
  ].join("\n");
  assert.deepEqual(shape(parseTickets(ticket)), [
    {
      id: "PROJ-12",
      title: "Export orders as CSV",
      criteria: [
        "AC1 The Export button downloads a CSV",
        "AC2 The file has one row per order and a header row; nested detail joins its parent",
        "AC3 An empty table exports a header only",
      ],
    },
  ]);
  // The heading's other spellings, as a bold line or a label, and a scenario under one.
  for (const heading of ["**Acceptance Criteria:**", "Acceptance criteria:", "### AC", "Definition of done:"]) {
    const t = parseTickets(`Export\n${heading}\n- Downloads a file\n- Names it after the date`);
    assert.deepEqual(shape(t)[0].criteria, ["AC1 Downloads a file", "AC2 Names it after the date"], heading);
  }
  // A labelled criterion spelled out in steps below it is one criterion.
  const spelled = parseTickets(
    "Notes\nAC1: Notes are saved\n  Given I typed a note\n  When I press Save\n  Then it is shown after a reload\nAC2: Empty notes are refused",
  );
  assert.deepEqual(shape(spelled)[0].criteria, [
    "AC1 Notes are saved; Given I typed a note; When I press Save; Then it is shown after a reload",
    "AC2 Empty notes are refused",
  ]);
});

test("a bulleted list is criteria under an Acceptance criteria heading and not without one", () => {
  // The contrastive pair: the same list, and the heading is the one difference.
  const list = "- The Export button downloads a CSV\n- The file has a header row";
  const withHeading = parseTickets(`Export orders\n\nAcceptance criteria:\n${list}`);
  const without = parseTickets(`Export orders\n\n${list}`);
  assert.deepEqual(shape(withHeading)[0].criteria, ["AC1 The Export button downloads a CSV", "AC2 The file has a header row"]);
  assert.deepEqual(without[0].criteria, []);
  assert.match(without[0].note ?? "", /bulleted list but no "Acceptance criteria" heading/);
});

test("a ticket with no recognisable criteria says so instead of guessing", () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      "prose only",
      "The export button is broken. When I click it nothing happens. Please fix it.",
      /no Given\/When\/Then, checklist, numbered list or "Acceptance criteria" section/,
    ],
    [
      "a bug's steps",
      "Export is broken\n\nSteps to reproduce:\n1. Open reports\n2. Click Export\n\nExpected:\n- a file",
      /under a heading such as "Steps to reproduce"/,
    ],
    ["a numbered aside in the description", "Export\n## Description\n1. accounting needs it\n2. so does sales", /no Given\/When\/Then/],
    ["a table", "Export\n| a | b |\n|---|---|\n| 1 | 2 |", /no Given\/When\/Then/],
  ];
  for (const [name, text, note] of cases) {
    const [ticket] = parseTickets(text);
    assert.deepEqual(ticket.criteria, [], name);
    assert.match(ticket.note ?? "", note, name);
    assert.match(ticket.note ?? "", /say what to check in words/, `${name}: the note says how to give them`);
  }
  // A ticket with criteria carries no note.
  assert.equal(parseTickets("X\n1. a")[0].note, undefined);
});

test("several tickets at once: split at headings, at lines opening with a key, and at rules", () => {
  const pasted = [
    "Here are the tickets:",
    "",
    "# Epic: Orders",
    "## PROJ-12 Export orders",
    "### Acceptance criteria",
    "- Downloads a CSV",
    "#### Filtering",
    "- A sub-heading inside the criteria keeps them",
    "## PROJ-14: Filters reset on refresh",
    "**Acceptance Criteria**",
    "1. The filter survives a reload",
    "---",
    "A ticket with no heading",
    "1. Its only criterion",
  ].join("\n");
  // The introduction and the epic with nothing under it are not tickets to answer.
  assert.deepEqual(shape(parseTickets(pasted)), [
    { id: "PROJ-12", title: "Export orders", criteria: ["AC1 Downloads a CSV", "AC2 A sub-heading inside the criteria keeps them"] },
    { id: "PROJ-14", title: "Filters reset on refresh", criteria: ["AC1 The filter survives a reload"] },
    { id: "T3", title: "A ticket with no heading", criteria: ["AC1 Its only criterion"] },
  ]);
  // A line opening with a key starts a ticket; a key elsewhere in a line names it.
  assert.deepEqual(
    parseTickets("WID-1: First\n- [ ] one\nWID-2 - Second\n- [ ] two").map((t) => `${t.id} ${t.title}`),
    ["WID-1 First", "WID-2 Second"],
  );
  assert.deepEqual(
    parseTickets("## Export (#42)\n1. a").map((t) => `${t.id} ${t.title}`),
    ["#42 Export"],
  );
  // The same key twice in one paste keeps both.
  assert.deepEqual(
    parseTickets("# WID-1 A\n1. a\n# WID-1 B\n1. b").map((t) => t.id),
    ["WID-1", "WID-1~2"],
  );
});

test("a sentence opening with When or Then is prose; steps from a Given or When to a Then are a scenario", () => {
  // The contrastive pair: the same opening word, and whether the steps reach a Then.
  const prose = parseTickets("# Export bug\n\nWhen I export a report the file is empty.\n\n## Steps to reproduce\n1. Open reports");
  assert.deepEqual(prose[0].criteria, []);
  assert.deepEqual(parseTickets("## Description\nBut the page never loads after saving.")[0].criteria, []);
  const scenario = parseTickets("# Export bug\n\nWhen I export a report\nThen the file has every row.\n\n## Steps to reproduce\n1. Open reports");
  assert.deepEqual(shape(scenario)[0].criteria, ["AC1 When I export a report; Then the file has every row."]);
  // Under an Acceptance criteria heading a single step is a criterion: the heading says so.
  assert.deepEqual(shape(parseTickets("X\nAcceptance criteria:\nThen the file has every row"))[0].criteria, ["AC1 Then the file has every row"]);
});

test("a word shaped like a key is not a ticket; a heading that starts Acceptance criteria is still the criteria", () => {
  const names = parseTickets(
    "# PROJ-1 Names\n## Acceptance criteria\n- [ ] Accented names save\nUTF-8 names round-trip through the export\n- [ ] Long names truncate",
  );
  assert.deepEqual(
    names.map((t) => `${t.id} ${t.criteria.length}`),
    ["PROJ-1 2"],
  );
  assert.deepEqual(
    parseTickets("[WID-3] Bracketed\n- [ ] one").map((t) => `${t.id} ${t.title}`),
    ["WID-3 Bracketed"],
  );
  const suffixed = parseTickets("# PROJ-2 Export\n## Acceptance Criteria (AC)\n- Downloads a file\n- Has a header");
  assert.deepEqual(shape(suffixed), [{ id: "PROJ-2", title: "Export", criteria: ["AC1 Downloads a file", "AC2 Has a header"] }]);
});

test("labels inside criteria opened by a label group them; a known part's label ends them", () => {
  const grouped = parseTickets(
    "Save\nAcceptance criteria:\n- Saving shows a toast\nError handling:\n- A failed save shows an error\n- The form keeps its values\nNotes:\n- not a criterion",
  );
  assert.deepEqual(shape(grouped)[0].criteria, ["AC1 Saving shows a toast", "AC2 A failed save shows an error", "AC3 The form keeps its values"]);
});

test("a Gherkin Background is context, not a criterion, and does not shift the scenarios' ids", () => {
  const feature = "Feature: Login\n  Background:\n    Given a user exists\n  Scenario: Sign in\n    When I sign in\n    Then I see my dashboard";
  assert.deepEqual(shape(parseTickets(feature))[0].criteria, ["AC1 Sign in: When I sign in; Then I see my dashboard"]);
});

test("a ticket with more criteria than are kept says how many were read", () => {
  const [t] = parseTickets(`Many\n${Array.from({ length: 55 }, (_, i) => `${i + 1}. c${i}`).join("\n")}`);
  assert.equal(t.criteria.length, 50);
  assert.equal(t.note, "Only the first 50 criteria were read.");
});

test("criterion text is cleaned and bounded, and a file is read only by a text extension", () => {
  const [t] = parseTickets(`X\n1. **Bold** and \`code\`   spaced\n2. ${"long ".repeat(200)}`);
  assert.equal(t.criteria[0].text, "Bold and code spaced");
  assert.equal(t.criteria[1].text.length, 500);
  assert.ok(t.criteria[1].text.endsWith("…"));
  for (const name of ["t.md", "T.MARKDOWN", "a.txt", "b.text", "c.feature"]) assert.ok(isTicketFileName(name), name);
  for (const name of ["a.pdf", "a.docx", "id_rsa", "a.md.png", "a.json"]) assert.ok(!isTicketFileName(name), name);
});

test("tickets given as answers to the plain questions are read one ticket each", () => {
  const settings = settingsFromAnswers({
    address: "http://app.test",
    signIn: "none",
    realData: "yes",
    whatToCheck: { tickets: ["Export\n1. Downloads a file", "Import\n- [ ] Reads a file"] },
  });
  assert.equal(settings.readTickets?.tool, "scout_tickets");
  assert.deepEqual(shape(parseTickets(settings.readTickets!.text)), [
    { id: "T1", title: "Export", criteria: ["AC1 Downloads a file"] },
    { id: "T2", title: "Import", criteria: ["AC1 Reads a file"] },
  ]);
});

// ── Readings in a run ─────────────────────────────────────────────────────────

const stored = (t: Partial<StoredTicket> & Pick<Ticket, "id">): StoredTicket => ({
  title: "t",
  criteria: [{ id: "AC1", text: "a", shape: "numbered" }],
  source: "pasted text",
  loadedAt: "2026-10-01T10:00:00.000Z",
  ...t,
});

test("a ticket read again replaces its reading; a different keyless one takes the next T number", () => {
  const first = addReading([], parseTickets("Export\n1. a"), "2026-10-01T10:00:00.000Z");
  assert.deepEqual(
    first.added.map((t) => t.id),
    ["T1"],
  );
  // The same keyless ticket pasted again is T1 again; another keyless ticket is T2, not a second T1.
  const second = addReading(first.tickets, [...parseTickets("Export\n1. a"), ...parseTickets("Import\n1. b")], "2026-10-01T10:05:00.000Z");
  assert.deepEqual(
    second.tickets.map((t) => `${t.id} ${t.title} ${t.loadedAt.slice(11, 16)}`),
    ["T1 Export 10:05", "T2 Import 10:05"],
  );
  // A keyed ticket replaces its earlier reading by key, whatever changed in it.
  const keyed = addReading([stored({ id: "WID-1", title: "Old" })], parseTickets("# WID-1 New\n1. a\n2. b"), "2026-10-01T11:00:00.000Z");
  assert.deepEqual(
    keyed.tickets.map((t) => `${t.id} ${t.title} ${t.criteria.length}`),
    ["WID-1 New 2"],
  );
});

test("a criterion is found by any of the ways an agent names it", () => {
  const ticket = { criteria: [1, 2, 12].map((n) => ({ id: `AC${n}`, text: "x", shape: "numbered" as const })) };
  for (const name of ["AC2", "ac2", "AC 2", "AC-2", "2", " 2 ", "AC02"]) assert.equal(findCriterion(ticket, name)?.id, "AC2", name);
  assert.equal(findCriterion(ticket, "12")?.id, "AC12");
  for (const name of ["AC3", "two", "AC", "2a", ""]) assert.equal(findCriterion(ticket, name), undefined, name);
});

// ── Judging ───────────────────────────────────────────────────────────────────

const ctx = (over: Partial<JudgeContext> = {}): JudgeContext => ({
  tickets: [stored({ id: "WID-1", criteria: ["AC1", "AC2"].map((id) => ({ id, text: id, shape: "numbered" as const })) }), stored({ id: "T2", criteria: [] })],
  findings: [{ id: "aaaaaaaaaa" }, { id: "bbbbbbbbbb" }],
  mode: "read-only",
  session: "default",
  at: "2026-10-01T12:00:00.000Z",
  ...over,
});
const base = { ticket: "WID-1", criterion: "AC1", confidence: 0.8, reason: "Saw it" } as const;

test("a verdict is refused until it is whole and consistent, and each refusal says what to do", () => {
  const refused: Array<[string, Parameters<typeof judgeCriterion>[0], JudgeContext, RegExp]> = [
    ["unknown ticket", { ...base, ticket: "WID-9", verdict: "pass" }, ctx(), /no ticket "WID-9".*WID-1, T2/],
    ["no tickets at all", { ...base, verdict: "pass" }, ctx({ tickets: [] }), /Read them with scout_tickets first/],
    ["unknown criterion", { ...base, criterion: "AC7", verdict: "pass" }, ctx(), /no criterion "AC7".*AC1, AC2/],
    ["a ticket with no criteria", { ...base, ticket: "T2", verdict: "pass" }, ctx(), /no recognised criteria.*rather than inventing them/],
    ["confidence out of range", { ...base, verdict: "pass", confidence: 1.2 }, ctx(), /from 0 to 1/],
    ["confidence not a number", { ...base, verdict: "pass", confidence: Number.NaN }, ctx(), /from 0 to 1/],
    ["no reason", { ...base, verdict: "pass", reason: "   " }, ctx(), /in a sentence/],
    ["a fail with no finding", { ...base, verdict: "fail" }, ctx(), /links to the findings that show it failing/],
    ["an unknown finding", { ...base, verdict: "fail", findings: ["cccccccccc"] }, ctx(), /no finding with id cccccccccc/],
    ["not tested with a finding", { ...base, verdict: "not-tested", findings: ["aaaaaaaaaa"], untestedBecause: "no-access" }, ctx(), /no findings to link/],
    ["not tested without why", { ...base, verdict: "not-tested" }, ctx(), /no-access, observe-blocked, out-of-scope/],
    ["observe-blocked outside observe", { ...base, verdict: "not-tested", untestedBecause: "observe-blocked" }, ctx(), /runs in read-only mode/],
    ["a reason for not testing on a pass", { ...base, verdict: "pass", untestedBecause: "no-access" }, ctx(), /only for a criterion that was not tested/],
  ];
  for (const [name, input, context, reason] of refused) {
    const r = judgeCriterion(input, context);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.reason, reason, name);
  }
});

test("a whole verdict becomes a record: ids normalised, duplicates dropped, confidence rounded", () => {
  const fail = judgeCriterion(
    { ...base, criterion: "1", verdict: "fail", findings: ["aaaaaaaaaa", " aaaaaaaaaa", "bbbbbbbbbb"], confidence: 0.876, reason: " It  threw " },
    ctx(),
  );
  assert.ok(fail.ok);
  assert.deepEqual(fail.record, {
    ticket: "WID-1",
    criterion: "AC1",
    verdict: "fail",
    findings: ["aaaaaaaaaa", "bbbbbbbbbb"],
    confidence: 0.88,
    reason: "It threw",
    text: "AC1",
    session: "default",
    at: "2026-10-01T12:00:00.000Z",
  });
  // A pass may name a finding (it passed, with a cosmetic problem); observe-blocked is accepted in observe.
  assert.ok(judgeCriterion({ ...base, verdict: "pass", findings: ["aaaaaaaaaa"] }, ctx()).ok);
  const blocked = judgeCriterion({ ...base, verdict: "not-tested", untestedBecause: "observe-blocked" }, ctx({ mode: "observe" }));
  assert.ok(blocked.ok);
  if (blocked.ok) assert.equal(blocked.record.untestedBecause, "observe-blocked");
});

const verdict = (v: Partial<CriterionVerdict>): CriterionVerdict => ({
  ticket: "WID-1",
  criterion: "AC1",
  verdict: "pass",
  findings: [],
  confidence: 0.8,
  reason: "r",
  session: "default",
  at: "2026-10-01T12:00:00.000Z",
  ...v,
});
const ac1 = { id: "AC1", text: "a", shape: "numbered" as const };

test("one criterion's answer: a fail from any session decides it, and no verdict is not judged", () => {
  assert.deepEqual(answerCriterion(ac1, []), {
    criterion: ac1,
    verdict: "not-tested",
    untestedBecause: "not-judged",
    findings: [],
    reasons: [],
    sessions: [],
    disputed: false,
  });
  const lanes = [
    verdict({ session: "orders", verdict: "pass", confidence: 0.9 }),
    verdict({ session: "reports", verdict: "fail", findings: ["aaaaaaaaaa"], confidence: 0.7, reason: "threw" }),
    verdict({ session: "admin", verdict: "not-tested", untestedBecause: "no-access" }),
  ];
  const answer = answerCriterion(ac1, lanes);
  assert.equal(answer.verdict, "fail");
  assert.deepEqual([answer.findings, answer.confidence, answer.sessions, answer.disputed], [["aaaaaaaaaa"], 0.7, ["reports"], true]);
  // A pass decides it over not tested; not tested alone keeps the latest reason.
  assert.equal(answerCriterion(ac1, [lanes[0], lanes[2]]).verdict, "pass");
  assert.equal(answerCriterion(ac1, [lanes[0], lanes[2]]).disputed, false);
  assert.deepEqual([answerCriterion(ac1, [lanes[2]]).verdict, answerCriterion(ac1, [lanes[2]]).untestedBecause], ["not-tested", "no-access"]);
  assert.equal(tally([{ verdict: "pass" }, { verdict: "pass" }, { verdict: "fail" }, { verdict: "not-tested" }]), "2 passed, 1 failed and 1 was not tested");
  assert.equal(tally([{ verdict: "not-tested" }, { verdict: "not-tested" }]), "2 were not tested");
});

test("verdicts: a session's second verdict on a criterion replaces its first; two processes merge, the later winning", () => {
  const one = addVerdict([], verdict({ session: "a", verdict: "pass" }));
  const two = addVerdict(one, verdict({ session: "b", verdict: "fail", findings: ["x"] }));
  const again = addVerdict(two, verdict({ session: "a", verdict: "fail", findings: ["x"], at: "2026-10-01T13:00:00.000Z" }));
  assert.deepEqual(
    again.map((v) => `${v.session} ${v.verdict}`),
    ["b fail", "a fail"],
  );
  const mine = { tickets: [stored({ id: "WID-1", title: "mine", loadedAt: "2026-10-01T10:00:00.000Z" })], criterionVerdicts: [verdict({ session: "a" })] };
  const theirs = {
    tickets: [stored({ id: "WID-1", title: "theirs, later", loadedAt: "2026-10-01T11:00:00.000Z" }), stored({ id: "WID-2" })],
    criterionVerdicts: [verdict({ session: "b" }), verdict({ session: "a", verdict: "fail", at: "2026-10-01T12:30:00.000Z" })],
  };
  const merged = mergeTicketData(mine, theirs);
  assert.deepEqual(
    merged.tickets?.map((t) => `${t.id} ${t.title}`),
    ["WID-2 t", "WID-1 theirs, later"],
  );
  assert.deepEqual(merged.criterionVerdicts?.map((v) => `${v.session} ${v.verdict}`).sort(), ["a fail", "b pass"]);
  assert.deepEqual(mergeTicketData(merged, theirs), merged, "merging the same document twice changes nothing");
  assert.deepEqual(mergeTicketData({}, {}), {});
});

test("a verdict on a criterion whose words changed since is left behind", () => {
  const judged = answerCriterion(ac1, [verdict({ verdict: "fail", findings: ["x"], text: "a" })]);
  assert.equal(judged.verdict, "fail");
  const ticket: Ticket = { id: "WID-1", title: "t", source: "s", criteria: [{ ...ac1, text: "a, reworded" }] };
  const [answer] = answerTicket(ticket, [verdict({ verdict: "fail", findings: ["x"], text: "a" })]);
  assert.deepEqual([answer.verdict, answer.untestedBecause], ["not-tested", "not-judged"]);
  // An older record with no text still counts.
  assert.equal(answerTicket(ticket, [verdict({ verdict: "pass" })])[0].verdict, "pass");
});

test("the project keeps the newest 100 tickets across merges", () => {
  const many = Array.from({ length: 120 }, (_, i) => stored({ id: `WID-${i}`, loadedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  const merged = mergeTicketData({ tickets: many.slice(0, 60) }, { tickets: many.slice(60) });
  assert.equal(merged.tickets?.length, 100);
  assert.equal(merged.tickets?.[0].id, "WID-20");
});

// ── Reporting ─────────────────────────────────────────────────────────────────

const finding = (id: string, title: string, extra: Partial<Finding> = {}): Finding =>
  ({
    id,
    title,
    severity: "high",
    category: "page-error",
    detail: "d",
    url: "http://app.test/x",
    state: "/x#1",
    repro: [],
    foundAt: "",
    runs: 1,
    ...extra,
  }) as Finding;

const reportTickets: Ticket[] = [
  {
    id: "WID-1",
    title: "Export the widget list",
    source: "WID-1.md",
    criteria: [
      { id: "AC1", text: "The export button downloads a file", shape: "bullet" },
      { id: "AC2", text: "The file has a | header row", shape: "bullet" },
      { id: "AC3", text: "Admins can schedule an export", shape: "bullet" },
      { id: "AC4", text: "The file is mailed", shape: "bullet" },
      { id: "AC5", text: "Nobody judged this", shape: "bullet" },
    ],
  },
  { id: "T2", title: "Make it nicer", source: "pasted text", criteria: [], note: "No acceptance criteria were recognised: it has no Given/When/Then." },
];
const reportVerdicts = [
  verdict({ criterion: "AC1", verdict: "fail", findings: ["aaaaaaaaaa"], confidence: 0.9, reason: "the export threw" }),
  verdict({ criterion: "AC2", verdict: "pass", confidence: 0.4, reason: "a header was there, the file was hard to read" }),
  verdict({ criterion: "AC3", verdict: "not-tested", untestedBecause: "no-access", confidence: 1, reason: "the role is not an admin" }),
  verdict({ criterion: "AC4", verdict: "not-tested", untestedBecause: "out-of-scope", confidence: 1, reason: "mail" }),
];
const reportInput = {
  tickets: reportTickets,
  verdicts: reportVerdicts,
  findings: [finding("aaaaaaaaaa", "Export throws"), finding("bbbbbbbbbb", "Not linked to anything")],
  problemNumber: new Map([["aaaaaaaaaa", 2]]),
  pictureOf: (f: Finding): string | undefined => (f.id === "aaaaaaaaaa" ? "recordings/default/0003-click.jpg" : "recordings/default/0009-other.jpg"),
};

test("the plain section answers each ticket: totals, a table of criteria, why each was not tested, and the failing pictures", () => {
  const lines = formatTicketsPlain(reportInput);
  assert.deepEqual(lines, [
    "### The tickets",
    "",
    "This run was given 2 tickets with 5 acceptance criteria: 1 passed, 1 failed and 3 were not tested.",
    "",
    "#### WID-1: Export the widget list",
    "",
    "1 passed, 1 failed and 3 were not tested.",
    "",
    "| | Acceptance criterion | Result |",
    "|---|---|---|",
    '| AC1 | The export button downloads a file | Failed: "Export throws" (problem 2 below) |',
    "| AC2 | The file has a / header row | Passed (unsure) |",
    "| AC3 | Admins can schedule an export | Not tested: the account the run used could not reach this part of the site |",
    "| AC4 | The file is mailed | Not tested: it is outside what this run could check |",
    "| AC5 | Nobody judged this | Not tested: no result was recorded for it |",
    "",
    "What the page showed when AC1 failed:",
    "",
    "![AC1 failed: Export throws](recordings/default/0003-click.jpg)",
    "",
    "#### T2: Make it nicer",
    "",
    "No acceptance criteria were recognised: it has no Given/When/Then. Nothing was checked against this ticket.",
    "",
  ]);
  // Without pictures (none taken yet), the table stands alone; a finding the plain view does not list is named by id.
  const bare = formatTicketsPlain({ ...reportInput, pictureOf: () => undefined, problemNumber: new Map() });
  assert.ok(!bare.some((l) => l.startsWith("![")));
  assert.ok(bare.includes('| AC1 | The export button downloads a file | Failed: "Export throws" (finding aaaaaaaaaa) |'));
  // Observe's reason, in words.
  const observed = formatTicketsPlain({ ...reportInput, verdicts: [verdict({ verdict: "not-tested", untestedBecause: "observe-blocked" })] });
  assert.ok(observed.some((l) => l.includes("Not tested: the run was only allowed to look, not to send changes, so this could not be tried")));
  assert.deepEqual(formatTicketsPlain({ ...reportInput, tickets: [] }), [], "no tickets, no section");
});

test("the technical section keeps every verdict's confidence, finding ids, reason and sessions", () => {
  const lines = formatTicketsTechnical(reportInput);
  assert.equal(lines[0], "## Acceptance criteria");
  assert.ok(lines.includes("### WID-1: Export the widget list"));
  assert.ok(lines.includes("Read from WID-1.md."));
  assert.ok(lines.includes("| AC1 | The export button downloads a file | fail | 0.90 | `aaaaaaaaaa` | the export threw | default |"));
  assert.ok(lines.includes("| AC3 | Admins can schedule an export | not tested (no-access) | 1.00 | — | the role is not an admin | default |"));
  assert.ok(lines.includes("| AC5 | Nobody judged this | not tested (not-judged) | — | — | — | — |"));
  assert.ok(lines.includes("No acceptance criteria were recognised: it has no Given/When/Then."));
  assert.equal(ticketSummaryLine(reportTickets, reportVerdicts), "TICKETS: 2 tickets, 5 criteria — 1 passed, 1 failed and 3 were not tested");
  assert.equal(ticketSummaryLine([], []), null);
});

test("what scout_tickets says back, and what a lane brief lists", () => {
  const said = formatReading(reportTickets);
  assert.match(said, /^Read 2 tickets with 5 acceptance criteria\./);
  assert.ok(said.includes("  AC2 [bullet] The file has a | header row"));
  assert.ok(said.includes("⚠ No acceptance criteria were recognised: it has no Given/When/Then. Ask the person for them; do not make them up."));
  assert.match(said, /scout_criterion \{ticket, criterion, verdict:"pass"\|"fail"\|"not-tested", findings, confidence, reason\}/);
  assert.equal(formatReading([reportTickets[1]]).includes("Next:"), false, "nothing to judge, no instructions to judge it");
  const brief = formatCriteriaForLanes(reportTickets);
  assert.match(brief, /^ACCEPTANCE CRITERIA this run answers/);
  assert.ok(brief.includes("    AC3 Admins can schedule an export"));
  assert.ok(!brief.includes("T2"), "a ticket with no criteria gives a lane nothing to answer");
  assert.equal(formatCriteriaForLanes([reportTickets[1]]), "");
});

// ── The report ────────────────────────────────────────────────────────────────

let dirs: string[] = [];
let stores: MemoryStore[] = [];
function freshStore(dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-tickets-"))): MemoryStore {
  dirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const s of stores) s.flush();
  stores = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test("the report answers the tickets in the plain view first and the technical report after", () => {
  const store = freshStore();
  const [f] = store.addFinding({ severity: "high", category: "page-error", title: "Export throws", detail: "d", url: "http://app.test/r", state: "/r#1" });
  const [ticket] = store.addTickets(parseTickets("# WID-1 Export\n## Acceptance criteria\n- Downloads a file\n- Has a header row"));
  for (const v of [
    { criterion: "AC1", verdict: "fail" as const, findings: [f.id], confidence: 0.9, reason: "threw" },
    { criterion: "AC2", verdict: "not-tested" as const, untestedBecause: "no-access" as const, confidence: 1, reason: "no access" },
  ]) {
    const r = judgeCriterion(
      { ticket: ticket.id, ...v },
      { tickets: store.tickets, findings: store.findings, mode: "read-only", session: "default", at: new Date().toISOString() },
    );
    assert.ok(r.ok);
    if (r.ok) store.addCriterionVerdict(r.record);
  }
  const extras = { routesVisited: 1, routesTotal: 1, designAudits: 1 };
  const both = generateReport(store, [], extras, { write: false });
  const md = both.markdown;
  const at = (s: string): number => md.indexOf(s);
  assert.ok(at("## In plain words") < at("### The tickets"));
  assert.ok(at("### The tickets") < at("### 1. Export throws"), "the tickets come before the problems");
  assert.ok(at("### 1. Export throws") < at("## Technical detail"));
  assert.ok(at("## Technical detail") < at("## Acceptance criteria"));
  assert.ok(md.includes('| AC1 | Downloads a file | Failed: "Export throws" (problem 1 below) |'));
  assert.match(both.summary, /TICKETS: 1 ticket, 2 criteria — 1 failed and 1 was not tested/);

  const qa = generateReport(store, [], { ...extras, report: "qa" }, { write: false }).markdown;
  assert.ok(qa.includes("### The tickets") && !qa.includes("## Acceptance criteria"));
  const dev = generateReport(store, [], { ...extras, report: "dev" }, { write: false }).markdown;
  assert.ok(!dev.includes("### The tickets") && dev.includes("## Acceptance criteria"));
  assert.ok(dev.includes(`| AC1 | Downloads a file | fail | 0.90 | \`${f.id}\` | threw | default |`));
});

test("a run with no tickets has no ticket section", () => {
  const store = freshStore();
  const r = generateReport(store, [], { routesVisited: 1, routesTotal: 1, designAudits: 1 }, { write: false });
  assert.ok(!r.markdown.includes("The tickets") && !r.markdown.includes("## Acceptance criteria") && !r.summary.includes("TICKETS"));
});

test("tickets are kept redacted, survive a reopen, and a later run shows only what it read or judged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-tickets-"));
  const first = freshStore(dir);
  first.addTickets(parseTickets("# WID-1 Export\n1. Works with the token ghp_abcdefghijklmnop1234567890"));
  assert.doesNotMatch(JSON.stringify(first.tickets), /abcdefghijklmnop/);
  assert.equal(first.ticketsThisRun().tickets.length, 1);
  first.flush();
  // A run starts at a later millisecond than the reading it follows.
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A later run (a new store on the same project): the old reading is kept but is not this run's.
  const later = freshStore(dir);
  assert.equal(later.tickets.length, 1);
  assert.deepEqual(later.ticketsThisRun().tickets, []);
  const r = judgeCriterion(
    { ticket: "WID-1", criterion: "AC1", verdict: "pass", confidence: 0.7, reason: "fine" },
    { tickets: later.tickets, findings: [], mode: "observe", session: "default", at: new Date().toISOString() },
  );
  assert.ok(r.ok);
  if (r.ok) later.addCriterionVerdict(r.record);
  assert.deepEqual(
    later.ticketsThisRun().tickets.map((t) => t.id),
    ["WID-1"],
    "judging an earlier reading makes it this run's",
  );
});
