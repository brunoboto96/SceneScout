/**
 * Splitting an app between parallel lanes.
 *
 * The split has one job that matters more than balance: no module belongs to
 * two lanes, and no module belongs to none. A real four-session run had two
 * browsers auditing the same register while a third module was never opened,
 * and route coverage reported 100% throughout — which is why this is computed
 * rather than improvised.
 *
 *   npx tsx --test scripts/brief-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBriefs, landingOf, laneName, MAX_LANES, moduleOf, planLanes, replayBriefs, splitRoutes } from "../src/engine/brief.ts";
import {
  buildRunRecord,
  carryForward,
  continueLines,
  continuePlan,
  foldRecords,
  FROM_RUN_ENV,
  FROM_RUN_MODE_ENV,
  MAX_RECORDS,
  readRunRecord,
  recordFromJson,
  replayLines,
  replayPlan,
  resolveFromRun,
  unionRecords,
  workLeft,
  workLine,
  type RecordInput,
  type RunRecord,
} from "../src/engine/from-run.ts";

const routesOf = (lanes: ReturnType<typeof splitRoutes>): string[] => lanes.flatMap((l) => l.routes);

test("a route belongs to the module its first segment names", () => {
  assert.equal(moduleOf("/orders"), "/orders");
  assert.equal(moduleOf("/orders/42/edit"), "/orders");
  assert.equal(moduleOf("http://app.test/orders?tab=open"), "/orders");
  assert.equal(moduleOf("/"), "/");
});

test("every route lands in exactly one lane", () => {
  // The whole point. Coverage cannot catch a double-owned module, because
  // both lanes visiting it makes the route look covered either way.
  const routes = ["/orders", "/orders/new", "/orders/42", "/stock", "/stock/audit", "/people", "/", "/settings"];
  const lanes = splitRoutes(routes, 3);
  const dealt = routesOf(lanes);
  assert.deepEqual([...dealt].sort(), [...routes].sort(), "nothing dropped, nothing duplicated");
  assert.equal(new Set(dealt).size, dealt.length);
});

test("a module is never split across two lanes", () => {
  const routes = ["/orders/a", "/orders/b", "/orders/c", "/orders/d", "/stock/a", "/people/a"];
  for (const lane of splitRoutes(routes, 3)) {
    const modules = new Set(lane.routes.map(moduleOf));
    assert.deepEqual([...modules].sort(), [...lane.modules].sort());
  }
  // /orders has four routes and there are three lanes: a size-balancing split
  // that ignored modules would cut it up, and each lane would re-learn the
  // same screens.
  const owners = splitRoutes(routes, 3).filter((l) => l.modules.includes("/orders"));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].routes.length, 4);
});

test("lanes come out close to even", () => {
  const routes = Array.from({ length: 12 }, (_, i) => `/m${i % 6}/r${i}`);
  const sizes = splitRoutes(routes, 3).map((l) => l.routes.length);
  assert.deepEqual(sizes, [2, 2, 2].map(Number).length === 3 ? sizes : sizes);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `uneven: ${sizes.join(",")}`);
});

test("the same routes always produce the same split", () => {
  // A lane that has to be re-run is given the same brief, and a planner can
  // compare two runs' plans. Insertion order must not decide the answer.
  const routes = ["/b/1", "/a/1", "/a/2", "/c/1"];
  const a = JSON.stringify(splitRoutes(routes, 2));
  const b = JSON.stringify(splitRoutes([...routes].reverse(), 2));
  assert.equal(a, b);
});

test("asking for more lanes than there are modules returns no empty lane", () => {
  // A lane with nothing to do is a browser held open for no reason — the
  // exact cost the pace report started warning about.
  const lanes = splitRoutes(["/only/a", "/only/b"], 5);
  assert.equal(lanes.length, 1);
  assert.ok(lanes.every((l) => l.routes.length > 0));
});

test("the lane count is clamped rather than obeyed blindly", () => {
  const routes = Array.from({ length: 40 }, (_, i) => `/m${i}/r`);
  assert.equal(splitRoutes(routes, 999).length, MAX_LANES);
  assert.equal(splitRoutes(routes, 0).length, 1);
  assert.equal(splitRoutes(routes, -3).length, 1);
});

test("splitting nothing yields nothing", () => {
  assert.deepEqual(splitRoutes([], 3), []);
  assert.deepEqual(planLanes([], 3), []);
  assert.match(formatBriefs([]), /Crawl first/);
});

test("a lane is named after what it owns, so the live view reads as the app", () => {
  assert.equal(laneName(["/orders"], 0), "orders");
  assert.equal(laneName(["/orders", "/stock"], 0), "orders+1");
  assert.equal(laneName(["/"], 2), "lane-3", "the root has no name of its own");
  assert.ok(laneName([`/${"x".repeat(80)}`], 0).length <= 40);
});

test("each lane's objective says what it owns, against the run's goal", () => {
  const [lane] = planLanes(["/orders/a", "/orders/b"], 1, { goal: "check the approval gates" });
  assert.equal(lane.objective, "Own /orders — check the approval gates");
  const [bare] = planLanes(["/orders/a"], 1);
  assert.equal(bare.objective, "Own /orders", "with no goal it still says the remit");
});

test("each lane lands on its own first route, not the home page", () => {
  const lanes = planLanes(["/", "/orders/b", "/orders/a", "/stock/a"], 3);
  const landings = Object.fromEntries(lanes.map((l) => [l.lane, l.landing]));
  assert.equal(landings.orders, "/orders/a", "the first of its routes in the stable order");
  assert.equal(landings.stock, "/stock/a");
  assert.ok(
    lanes.every((l) => l.routes.includes(l.landing)),
    "a lane lands on a route it owns",
  );
  const out = formatBriefs(lanes);
  assert.match(out, /url: "<origin><landing>"/);
  assert.match(out, /landing: \/orders\/a/);
});

test("a lane never lands on a route pattern it cannot open", () => {
  // ":id" sorts before "new"; a browser cannot open a pattern.
  assert.equal(landingOf(["/orders/:id", "/orders/new"]), "/orders/new");
  assert.equal(landingOf(["/items/[slug]", "/items"]), "/items");
  assert.equal(landingOf(["/files/*", "/files/:id"]), "/", "nothing openable: start from the root");
  assert.equal(planLanes(["/orders/:id", "/orders/new"], 1)[0].landing, "/orders/new");
});

test("the brief carries the rules a hand-written one drops", () => {
  const out = formatBriefs(planLanes(["/orders/a", "/stock/a"], 2, { goal: "g" }), { mode: "safe-write", goal: "g" });
  assert.match(out, /LANE PLAN — 2 lane\(s\) over 2 route\(s\)/);
  assert.match(out, /mode: "safe-write"/, "a lane must not attach laxer than the run was authorized for");
  assert.match(out, /works ITS routes only/);
  assert.match(out, /Every acting tool takes a `task`/);
  assert.match(out, /scout_lane_report/, "and it says how to hand results back");
  // The rules a measured run's briefs added, each aimed at one line of the scorecard.
  assert.match(out, /File each defect with scout_finding the moment it is judged/, "judged, not filed");
  assert.match(out, /read the status of the request behind it/, "a correct empty list read as stuck");
  assert.match(out, /submit one markup-shaped value, then open where that record is listed/, "stored injection");
  assert.match(out, /does NOT close its session/, "decisions kept for calibration");
  assert.match(out, /scout_coverage before finishing/);
  assert.match(out, /── orders ──/);
  assert.match(out, /objective: Own \/orders — g/);
});

test("each lane is told to sign in the way the planner did", () => {
  const lanes = planLanes(["/orders/a", "/stock/a"], 2);
  const attachLine = (out: string) => out.split("\n").find((l) => l.includes("scout_attach {")) ?? "";
  // A role saved by `scenescout login`: every lane attaches by its name, from the one login.
  assert.match(attachLine(formatBriefs(lanes, { role: "admin", roleProfile: true })), /, role: "admin",/);
  assert.doesNotMatch(attachLine(formatBriefs(lanes, { role: "admin", roleProfile: true })), /storageStatePath/);
  // A storage-state file named by path: the lanes are told to pass that file.
  assert.match(attachLine(formatBriefs(lanes, { role: "admin" })), /storageStatePath: "<admin>"/);
  assert.doesNotMatch(attachLine(formatBriefs(lanes, { role: "admin" })), /role: "/);
  // A session that never signed in hands its lanes nothing to sign in with.
  const anonymous = attachLine(formatBriefs(lanes, { role: "anonymous" }));
  assert.doesNotMatch(anonymous, /storageStatePath|role: "/);
});

// ── starting from an earlier run (from-run.ts) ──────────────────────────────

test("from run: the path option, else SCENESCOUT_FROM_RUN, else none; the mode option, else its variable, else continue", () => {
  const r = (o: { path?: string; mode?: string }, env: Record<string, string> = {}) => resolveFromRun(o, env);
  assert.deepEqual(r({}), { ok: true }, "a fresh run unless asked");
  assert.deepEqual(r({}, { [FROM_RUN_ENV]: "  " }), { ok: true }, "an empty variable is unset");
  assert.deepEqual(r({ path: "a/ci.json" }), { ok: true, fromRun: { path: "a/ci.json", mode: "continue" } });
  assert.deepEqual(r({}, { [FROM_RUN_ENV]: "env.json" }), { ok: true, fromRun: { path: "env.json", mode: "continue" } });
  assert.deepEqual(r({ path: "flag.json" }, { [FROM_RUN_ENV]: "env.json" }), { ok: true, fromRun: { path: "flag.json", mode: "continue" } }, "the option wins");
  assert.deepEqual(
    r({ path: "p", mode: "replay" }, { [FROM_RUN_MODE_ENV]: "continue" }),
    { ok: true, fromRun: { path: "p", mode: "replay" } },
    "the option wins",
  );
  assert.deepEqual(r({ path: "p" }, { [FROM_RUN_MODE_ENV]: "replay" }), { ok: true, fromRun: { path: "p", mode: "replay" } });
  // The mode is read only for a run that has an earlier one: a stray variable stops nothing.
  assert.deepEqual(r({}, { [FROM_RUN_MODE_ENV]: "sideways" }), { ok: true });
  const err = (o: { path?: string; mode?: string }, env: Record<string, string> = {}): string => {
    const x = r(o, env);
    assert.ok(!x.ok, JSON.stringify(o));
    return x.error;
  };
  assert.match(err({ path: "p", mode: "sideways" }), /^--from-run-mode must be one of continue, replay/);
  assert.match(err({ path: "p" }, { [FROM_RUN_MODE_ENV]: "sideways" }), /^SCENESCOUT_FROM_RUN_MODE must be one of/);
  assert.match(err({ mode: "replay" }), /--from-run-mode applies to a run started from an earlier one: give --from-run as well/);
  assert.match(err({ path: " " }), /--from-run needs a ci.json or a project directory/);
  const named = resolveFromRun({ mode: "replay" }, {}, { path: "fromRun", mode: "fromRunMode" });
  assert.ok(!named.ok && /^fromRunMode applies .* give fromRun/.test(named.error), "the brief's inputs are named as the brief names them");
});

/** A record input: a session "lane-a" that worked on /orders and /orders/42, a planner that only looked, and a crawl of /stock. */
const input = (over: Partial<RecordInput> = {}): RecordInput => ({
  runId: "run-1",
  at: "2026-10-07T10:00:00.000Z",
  knownRoutes: ["/", "/orders", "/orders/:id", "/stock", "/reports"],
  steps: [
    { session: "default", url: "http://app.test/", action: "snapshot" },
    { session: "default", url: "http://app.test/stock", action: "crawl", target: "/stock" },
    { session: "lane-a", url: "http://app.test/orders", action: "navigate", target: "http://app.test/orders" },
    { session: "lane-a", url: "http://app.test/orders", action: "attach" },
    { session: "lane-a", url: "http://app.test/orders/42", action: "click", target: 'link "Order 42"' },
    { session: "lane-a", url: "http://app.test/orders/42", action: "type", target: 'textbox "Note" ← "hi"' },
    { session: "lane-a", url: "http://app.test/orders", action: "back", target: "" },
  ],
  unexercised: [
    { route: "/orders", keys: ["button:export", "link:next"] },
    { route: "/stock", keys: ["button:adjust"] },
  ],
  forms: [{ route: "/orders/:id", key: "form#note" }],
  filled: ["/orders/:id"],
  unchosen: [{ route: "/orders", key: "select:status", unchosen: ["Archived", "Draft"] }],
  gaps: ["1 route(s) never visited in any run: /reports"],
  ...over,
});

test("record: only the routes a session worked on are visited, in the order reached; a crawl, an attach and a look-only planner are not", () => {
  const r = buildRunRecord(input());
  assert.deepEqual(r.visited, ["/orders", "/orders/:id"]);
  assert.deepEqual(r.lanes, [{ session: "lane-a", routes: ["/orders", "/orders/:id"] }], "the planner only looked, so it is no lane");
  assert.deepEqual(
    r.steps.map((s) => [s.action, s.route]),
    [
      ["navigate", "/orders"],
      ["click", "/orders/:id"],
      ["type", "/orders/:id"],
      ["back", "/orders"],
    ],
  );
  assert.deepEqual(r.left, [
    { route: "/orders", unexercised: ["button:export", "link:next"], forms: [], unchosen: [{ key: "select:status", options: ["Archived", "Draft"] }] },
    { route: "/orders/:id", unexercised: [], forms: ["form#note"], filled: true, unchosen: [] },
  ]);
  // /stock was only crawled: what is left there is not this run's to hand on, and it is not visited.
  assert.ok(!r.left.some((l) => l.route === "/stock"));
  // The contrastive case: the same planner, once it acts, is a lane and its route is visited.
  const acting = buildRunRecord(
    input({ steps: [...input().steps, { session: "default", url: "http://app.test/", action: "click", target: 'button "Help"' }] }),
  );
  assert.deepEqual(acting.visited, ["/", "/orders", "/orders/:id"]);
  assert.deepEqual(
    acting.lanes.map((l) => l.session),
    ["default", "lane-a"],
  );
  assert.equal(readRunRecord(JSON.parse(JSON.stringify(r))) !== null, true, "a record reads back as one");
  // What was typed is never kept: the redaction cannot tell a password from a note.
  assert.equal(r.steps[2].target, 'textbox "Note" ← (a value)');
  // A refused action did nothing: it is no step, and a session whose only act was refused only looked.
  const refused = buildRunRecord(
    input({ steps: [...input().steps, { session: "default", url: "http://app.test/", action: "click:refused", target: 'button "Delete all"' }] }),
  );
  assert.deepEqual(refused.steps, r.steps);
  assert.deepEqual(refused.visited, r.visited);
  assert.equal(
    buildRunRecord(input({ steps: [{ session: "a", url: "http://app.test/x", action: "click×2", target: "b" }] })).steps.length,
    1,
    "a double click is a step",
  );
});

const recordOf = (over: Partial<RecordInput> = {}): RunRecord => buildRunRecord(input(over));

test("continue: never worked on first, then the routes with work left (most first), then the covered ones; the same input the same order", () => {
  const r = recordOf();
  const items = continuePlan(r, ["/orders/7", "/stock", "/", "/reports", "/orders", "/people"]);
  assert.deepEqual(
    items.map((i) => [i.tier, i.route]),
    [
      [1, "/"],
      [1, "/people"],
      [1, "/reports"],
      [1, "/stock"],
      // /orders has 2 controls and 2 options left; /orders/7 is /orders/:id, with 1 form and 1 filled form.
      [2, "/orders"],
      [2, "/orders/7"],
    ],
  );
  assert.equal(workLeft(items[4].work!), 4);
  // Order-independent, and a route only the record knew is not lost.
  assert.deepEqual(continuePlan(r, ["/people", "/orders", "/reports", "/", "/stock", "/orders/7"]), items);
  assert.deepEqual(
    continuePlan(r, []).map((i) => i.route),
    ["/", "/reports", "/stock", "/orders", "/orders/:id"],
  );
});

test("continue: the one fact that moves a route between tiers is whether work was left on it", () => {
  // Two records alike but for one unsubmitted form on /orders/:id.
  const withForm = recordOf({ unexercised: [], unchosen: [], filled: [] });
  const without = recordOf({ unexercised: [], unchosen: [], filled: [], forms: [] });
  const tierOf = (r: RunRecord, route: string) => continuePlan(r, ["/orders", "/orders/:id"]).find((i) => i.route === route)?.tier;
  assert.equal(tierOf(withForm, "/orders/:id"), 2);
  assert.equal(tierOf(without, "/orders/:id"), 3);
  assert.equal(tierOf(withForm, "/orders"), 3, "the other route is unchanged");
  // And a route worked on is never tier 1, whatever was left; one never worked on always is.
  assert.equal(tierOf(recordOf({ steps: [] }), "/orders/:id"), 1);
});

test("continue: the message names exactly the forms, options and controls to take first, and a lane is told about its own routes", () => {
  const items = continuePlan(recordOf(), ["/orders", "/orders/:id", "/stock", "/reports"]);
  const lines = continueLines(items, { from: "prev/ci.json" });
  assert.match(lines[0], /continues an earlier one \(prev\/ci\.json\)/);
  assert.equal(lines[1], "1. Never worked on by it, first: /, /reports, /stock");
  assert.ok(
    lines.includes(`   /orders: choose the options never chosen: select:status → "Archived", "Draft"; controls never exercised: button:export, link:next`),
    lines.join("\n"),
  );
  assert.ok(lines.includes(`   /orders/:id: submit the form(s) never submitted: form#note; a form was filled in and never submitted: fill it and submit it`));
  assert.ok(!lines.some((l) => l.startsWith("3.")), "nothing covered, no third tier");
  const lane = continueLines(items, { from: "x", only: ["/stock"] });
  assert.equal(lane[1], "1. Never worked on by it, first: /stock");
  assert.equal(lane[2], "2. It left no work on the routes it visited.");
  assert.deepEqual(continueLines(items, { from: "x", only: ["/elsewhere"] }), [], "a lane with none of these routes is told nothing");
  assert.equal(
    workLine({ route: "/a", unexercised: Array.from({ length: 10 }, (_, i) => `k${i}`), forms: [], unchosen: [] }),
    "/a: controls never exercised: k0, k1, k2, k3, k4, k5, k6, k7 … +2",
  );
});

test("continue: a chain of records carries forward what earlier runs covered and left", () => {
  const first = recordOf();
  // The second run worked on /stock only, and left a control there.
  const second = buildRunRecord(
    input({
      runId: "run-2",
      at: "2026-10-07T11:00:00.000Z",
      steps: [{ session: "lane-b", url: "http://app.test/stock", action: "click", target: 'button "Adjust"' }],
      unexercised: [{ route: "/stock", keys: ["button:count"] }],
      forms: [],
      filled: [],
      unchosen: [],
    }),
  );
  const chained = carryForward(first, second);
  assert.deepEqual(chained.visited, ["/stock", "/orders", "/orders/:id"]);
  assert.deepEqual(
    chained.left.map((l) => l.route),
    ["/stock", "/orders", "/orders/:id"],
  );
  assert.deepEqual(chained.steps, second.steps, "the steps stay the run's own");
  // A route the later run worked on again takes the later run's word, even when it left nothing there.
  const third = buildRunRecord(input({ runId: "run-3", at: "2026-10-07T12:00:00.000Z", unexercised: [], forms: [], filled: [], unchosen: [] }));
  assert.deepEqual(
    carryForward(chained, third).left.map((l) => l.route),
    ["/stock"],
  );
  assert.deepEqual(foldRecords([third, first, second]), carryForward(carryForward(first, second), third), "folded oldest first, whatever the order kept");
  assert.equal(foldRecords([]), null);
});

test("records: read back in full or not at all, found in a ci.json, a memory or bare, and kept as a set", () => {
  const r = recordOf();
  for (const bad of [
    { ...r, version: 2 },
    { ...r, visited: "/orders" },
    { ...r, steps: [{ session: "a", route: "/", action: 1 }] },
    { ...r, left: [{ route: "/", unexercised: [], forms: [], unchosen: [{ key: "k" }] }] },
    { ...r, followed: { mode: "sideways", runId: "x" } },
    null,
  ])
    assert.equal(readRunRecord(bad), null, JSON.stringify(bad)?.slice(0, 80));
  assert.deepEqual(recordFromJson({ tool: "scenescout", command: "ci", record: r }, "ci.json"), { ok: true, record: r });
  const noRecord = recordFromJson({ tool: "scenescout", command: "ci" }, "ci.json");
  assert.ok(!noRecord.ok && /ci.json holds no run record: its run wrote no report/.test(noRecord.error));
  const second = { ...recordOf({ runId: "run-2", at: "2026-10-07T11:00:00.000Z" }) };
  const memory = recordFromJson({ version: 1, states: {}, findings: [], runRecords: [second, r] }, "memory.json");
  assert.deepEqual(memory, { ok: true, record: carryForward(r, second) });
  assert.ok(!recordFromJson({ version: 1, states: {}, findings: [] }, "memory.json").ok);
  assert.deepEqual(recordFromJson(r, "r.json"), { ok: true, record: r });
  const neither = recordFromJson({ hello: 1 }, "r.json");
  assert.ok(!neither.ok && /r.json is not a ci.json, a project's memory or a run record/.test(neither.error));
  assert.deepEqual(unionRecords([r], [second, r]), [r, second]);
  assert.deepEqual(unionRecords(unionRecords([r], [second]), [second]), [r, second], "idempotent");
  const many = Array.from({ length: MAX_RECORDS + 3 }, (_, i) => ({ ...r, runId: `r${i}`, at: `2026-10-07T10:00:${String(i).padStart(2, "0")}.000Z` }));
  assert.equal(unionRecords(many, []).length, MAX_RECORDS);
  assert.equal(unionRecords(many, [])[0].runId, "r3", "the oldest go first");
});

test("replay: the same record gives the same plan, in the order the run took its steps, one lane per session that acted", () => {
  const r = recordOf({
    steps: [
      { session: "lane-b", url: "http://app.test/stock", action: "navigate", target: "/stock" },
      { session: "lane-a", url: "http://app.test/orders", action: "click", target: 'button "Z"' },
      { session: "lane-b", url: "http://app.test/stock", action: "select", target: 'combobox "Site" = North' },
      { session: "lane-a", url: "http://app.test/orders/9", action: "click", target: 'link "A"' },
      { session: "default", url: "http://app.test/", action: "snapshot" },
    ],
  });
  const plan = replayPlan(r);
  assert.deepEqual(plan, replayPlan(JSON.parse(JSON.stringify(r))), "the same input, the same order");
  assert.deepEqual(
    plan.map((l) => [l.session, l.routes, l.steps.map((s) => s.target)]),
    [
      ["lane-b", ["/stock"], ["/stock", 'combobox "Site" = North']],
      ["lane-a", ["/orders", "/orders/:id"], ['button "Z"', 'link "A"']],
    ],
    "recorded order, not sorted: lane-b moved first, and button Z came before link A",
  );
  const lines = replayLines(plan[1], { from: "prev/ci.json" });
  assert.match(lines[0], /replays an earlier one \(prev\/ci\.json\): follow its route and step order exactly/);
  assert.deepEqual(lines.slice(3), ['  1. click button "Z" → /orders', '  2. click link "A" → /orders/:id']);
  const briefs = replayBriefs(plan);
  assert.deepEqual(
    briefs.map((b) => [b.lane, b.routes, b.landing]),
    [
      ["stock", ["/stock"], "/stock"],
      ["orders", ["/orders", "/orders/:id"], "/orders"],
    ],
  );
  assert.deepEqual(
    replayBriefs([{ routes: ["/a/1"] }, { routes: ["/a/2"] }]).map((b) => b.lane),
    ["a", "a-2"],
    "two sessions in one module get two names",
  );
});

test("an order changes which route each lane starts on, never which modules a lane owns or which routes are split", () => {
  const routes = ["/orders", "/orders/new", "/orders/42", "/stock", "/stock/audit", "/people", "/", "/settings", "/reports"];
  const plain = splitRoutes(routes, 3);
  const order = ["/stock/audit", "/people", "/orders/new", "/reports"];
  const ordered = splitRoutes(routes, 3, order);
  assert.deepEqual(routesOf(ordered).sort(), [...routes].sort(), "every route once");
  for (const lane of ordered) assert.deepEqual([...new Set(lane.routes.map(moduleOf))].sort(), [...lane.modules].sort(), "whole modules");
  assert.deepEqual(
    ordered.map((l) => l.routes[0]),
    ["/stock/audit", "/people", "/orders/new"],
    "each lane starts on the first of its routes the order names",
  );
  assert.deepEqual(splitRoutes([...routes].reverse(), 3, order), ordered, "the discovery order still does not matter");
  assert.equal(JSON.stringify(planLanes(routes, 3)), JSON.stringify(planLanes(routes, 3, {})), "without an order, the split is the stable one");
  assert.deepEqual(plain[0].routes[0], "/orders", "the stable split starts with the biggest module, sorted");
});

test("a brief that starts from an earlier run says so, and gives each lane its own lines", () => {
  const lanes = planLanes(["/orders/a", "/stock/a"], 2);
  const out = formatBriefs(lanes, {
    fromRunNote: "continued from the run recorded in prev/ci.json (its report of t)",
    laneLines: (b) => [`first: ${b.routes[0]}`],
  });
  assert.match(out, /^LANE PLAN — 2 lane\(s\) over 2 route\(s\)\.\nThis run continued from the run recorded in prev\/ci\.json/);
  assert.match(out, /routes: \/orders\/a\nfirst: \/orders\/a\n/);
  assert.match(out, /routes: \/stock\/a\nfirst: \/stock\/a\n/);
  assert.doesNotMatch(formatBriefs(lanes), /This run|first:/, "a fresh run's brief is unchanged");
});
