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
import { createHash } from "node:crypto";
import { formatBriefs, landingOf, laneName, MAX_LANES, moduleOf, planLanes, splitRoutes } from "../src/engine/brief.ts";
import {
  earlierChoices,
  MAX_SCHEDULES,
  readSchedules,
  resolveSeed,
  resolveSeedExclusion,
  scheduleOrder,
  SEED_ENV,
  SEED_EXCLUSION_ENV,
  seededOrder,
  seededRank,
  startsOf,
  unionSchedules,
  type ScheduleRecord,
} from "../src/engine/schedule.ts";

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

// ── a seeded schedule (schedule.ts) ─────────────────────────────────────────

const ITEMS = ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"];

test("seeded order: SHA-256 of the seed and the item, so the same seed gives the same order anywhere", () => {
  assert.equal(seededRank("s", "/a"), createHash("sha256").update("s\u0000/a").digest("hex"));
  assert.deepEqual(seededOrder(ITEMS, "s1"), seededOrder([...ITEMS].reverse(), "s1"), "the input order does not matter");
  assert.deepEqual(seededOrder(ITEMS, "s1"), seededOrder(ITEMS, "s1"));
  assert.deepEqual([...seededOrder(ITEMS, "s1")].sort(), ITEMS, "a permutation: nothing lost, nothing added");
});

test("seeded order: different seeds give different orders", () => {
  const orders = new Set(Array.from({ length: 20 }, (_, i) => seededOrder(ITEMS, `seed-${i}`).join(",")));
  // 8! orders: twenty seeds landing on fewer than nineteen distinct ones would mean the seed barely matters.
  assert.ok(orders.size >= 19, `${orders.size} distinct orders from 20 seeds`);
  const firsts = new Set(Array.from({ length: 20 }, (_, i) => seededOrder(ITEMS, `seed-${i}`)[0]));
  assert.ok(firsts.size >= 4, "and the opening route varies, which is the point");
});

test("schedule: what earlier seeded runs began with goes to the back, least-chosen first; skip leaves it out until the cycle is done", () => {
  const earlier = new Map([
    ["/a", 2],
    ["/b", 1],
    ["/c", 1],
  ]);
  const back = scheduleOrder(ITEMS, { seed: "s1", earlier, exclusion: "back" });
  assert.deepEqual(back.slice(0, 5).sort(), ["/d", "/e", "/f", "/g", "/h"], "never-chosen first");
  assert.deepEqual(back.slice(5, 7).sort(), ["/b", "/c"]);
  assert.equal(back[7], "/a", "chosen most, last");
  assert.deepEqual(back.slice(0, 5), seededOrder(["/d", "/e", "/f", "/g", "/h"], "s1"), "each group in the seed's order");
  assert.deepEqual(scheduleOrder(ITEMS, { seed: "s1", earlier }), back, "back is the default");
  assert.deepEqual(scheduleOrder(ITEMS, { seed: "s1", earlier, exclusion: "skip" }), back.slice(0, 5));
  const all = new Map(ITEMS.map((i) => [i, 1]));
  assert.deepEqual(
    scheduleOrder(ITEMS, { seed: "s1", earlier: all, exclusion: "skip" }),
    seededOrder(ITEMS, "s1"),
    "every route chosen once: the cycle starts over",
  );
  assert.deepEqual(scheduleOrder([], { seed: "s1", exclusion: "skip" }), []);
  assert.deepEqual(scheduleOrder(ITEMS, { seed: "s1" }), seededOrder(ITEMS, "s1"), "no history: the seed's order");
});

const record = (seed: string, at: string, routes: string[], roles?: string[]): ScheduleRecord => ({
  seed,
  at,
  source: "ci",
  exclusion: "back",
  routes,
  ...(roles ? { roles } : {}),
});

test("schedule: a seed used again sees the history its first run saw, so it repeats that order", () => {
  const history = [record("s1", "2026-01-01", ["/a", "/b"]), record("s2", "2026-01-02", ["/c"]), record("s1", "2026-01-03", ["/a", "/b"])];
  assert.deepEqual(
    [...earlierChoices(history, "routes")],
    [
      ["/a", 2],
      ["/b", 2],
      ["/c", 1],
    ],
  );
  assert.deepEqual([...earlierChoices(history, "routes", "s1")], [], "s1's first run came first: nothing was earlier");
  assert.deepEqual(
    [...earlierChoices(history, "routes", "s2")],
    [
      ["/a", 1],
      ["/b", 1],
    ],
  );
  assert.deepEqual([...earlierChoices(history, "routes", "new")].length, 3, "a new seed sees everything");
  assert.deepEqual([...earlierChoices([record("s", "t", [], ["admin"])], "roles")], [["admin", 1]]);
  assert.deepEqual(startsOf([["/a", "/b", "/c", "/d"], ["/x"], ["/a"]]), ["/a", "/b", "/c", "/x"], "the first three of each order, once each");
});

test("schedule: the seed is the option, else SCENESCOUT_SEED, else none; auto is generated; exclusion likewise", () => {
  const gen = () => "feedbeef";
  assert.deepEqual(resolveSeed(undefined, {}, gen), { ok: true });
  assert.deepEqual(resolveSeed(undefined, { [SEED_ENV]: "" }, gen), { ok: true });
  assert.deepEqual(resolveSeed("x.1_y-2", { [SEED_ENV]: "env" }, gen), { ok: true, seed: { value: "x.1_y-2", generated: false } });
  assert.deepEqual(resolveSeed(undefined, { [SEED_ENV]: "env" }, gen), { ok: true, seed: { value: "env", generated: false } });
  assert.deepEqual(resolveSeed(undefined, { [SEED_ENV]: "auto" }, gen), { ok: true, seed: { value: "feedbeef", generated: true } });
  const bad = resolveSeed("no spaces", {}, gen, "seed");
  assert.ok(!bad.ok && /^seed must be/.test(bad.error));
  assert.match(resolveSeed("auto", {}).ok ? (resolveSeed("auto", {}) as { seed: { value: string } }).seed.value : "", /^[0-9a-f]{8}$/);
  assert.deepEqual(resolveSeedExclusion(undefined, {}), { ok: true, value: "back" });
  assert.deepEqual(resolveSeedExclusion(undefined, { [SEED_EXCLUSION_ENV]: "skip" }), { ok: true, value: "skip" });
  assert.deepEqual(resolveSeedExclusion("back", { [SEED_EXCLUSION_ENV]: "skip" }), { ok: true, value: "back" });
  assert.ok(!resolveSeedExclusion("later", {}).ok);
});

test("schedule: records merge as a set, oldest first and capped, and a malformed one is left out", () => {
  const a = [record("s1", "2026-01-01", ["/a"])];
  const b = [record("s2", "2026-01-02", ["/b"]), ...a];
  assert.deepEqual(unionSchedules(a, b), [a[0], b[0]]);
  assert.deepEqual(unionSchedules(unionSchedules(a, b), b), unionSchedules(a, b), "idempotent");
  const many = Array.from({ length: MAX_SCHEDULES + 5 }, (_, i) => record(`s${i}`, `2026-01-01T00:00:${String(i).padStart(3, "0")}`, []));
  assert.equal(unionSchedules(many, []).length, MAX_SCHEDULES);
  assert.equal(unionSchedules(many, [])[0].seed, "s5", "the oldest go first");
  assert.deepEqual(readSchedules({ schedules: [a[0], { seed: 1 }, null, { seed: "x", at: "t", routes: [2] }] }), a);
  assert.deepEqual(readSchedules({}), []);
});

test("seeded split: still whole modules and every route once, the same seed the same plan, and unseeded exactly as before", () => {
  const routes = ["/orders", "/orders/new", "/orders/42", "/stock", "/stock/audit", "/people", "/", "/settings", "/reports"];
  const before = JSON.stringify(planLanes(routes, 3));
  for (const seed of ["s1", "s2", "s3"]) {
    const lanes = splitRoutes(routes, 3, { seed });
    assert.deepEqual(lanes.flatMap((l) => l.routes).sort(), [...routes].sort(), seed);
    for (const lane of lanes) assert.deepEqual([...new Set(lane.routes.map(moduleOf))].sort(), [...lane.modules].sort());
    assert.deepEqual(JSON.stringify(splitRoutes([...routes].reverse(), 3, { seed })), JSON.stringify(lanes));
  }
  assert.equal(JSON.stringify(planLanes(routes, 3)), before, "no schedule, no change");
  const plans = new Set(["s1", "s2", "s3", "s4", "s5", "s6"].map((seed) => JSON.stringify(planLanes(routes, 3, { schedule: { seed } }))));
  assert.ok(plans.size >= 3, "different seeds deal differently");
});

test("seeded split: a lane lands on a route earlier seeded runs did not start with, and skip leaves those out of the split", () => {
  const routes = ["/orders/a", "/orders/b", "/orders/c", "/stock/a", "/stock/b"];
  const earlier = new Map([
    ["/orders/a", 1],
    ["/orders/b", 1],
    ["/stock/a", 1],
  ]);
  const lanes = planLanes(routes, 2, { schedule: { seed: "s1", earlier } });
  const landing = Object.fromEntries(lanes.map((l) => [l.modules[0], l.landing]));
  assert.deepEqual(landing, { "/orders": "/orders/c", "/stock": "/stock/b" });
  for (const l of lanes) assert.ok(!earlier.has(l.routes[0]), `${l.lane} starts fresh`);
  const skipped = planLanes(routes, 2, { schedule: { seed: "s1", earlier, exclusion: "skip" } });
  assert.deepEqual(skipped.flatMap((l) => l.routes).sort(), ["/orders/c", "/stock/b"]);
});

test("seeded brief: it opens with the seed, says to take the routes in order, and orders the saved roles", () => {
  const lanes = planLanes(["/orders/a", "/stock/a"], 2, { schedule: { seed: "s1" } });
  const out = formatBriefs(lanes, { seedNote: "Seed: s1, earlier seeded runs' starting choices moved to the back.", roleOrder: ["clerk", "admin"] });
  assert.match(out, /^LANE PLAN — 2 lane\(s\) over 2 route\(s\)\.\nSeed: s1/);
  assert.match(out, /listed in the order to take them: start with the first/);
  assert.match(out, /Saved roles, in this run's order .*: clerk, admin\. Run as the first/);
  const plain = formatBriefs(planLanes(["/orders/a", "/stock/a"], 2));
  assert.doesNotMatch(plain, /Seed:|Saved roles/, "unseeded, the brief is unchanged");
  assert.doesNotMatch(formatBriefs(lanes, { roleOrder: ["only"] }), /Saved roles/, "one role is no choice");
});
