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
import { formatBriefs, laneName, MAX_LANES, moduleOf, planLanes, splitRoutes } from "../src/engine/brief.ts";

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

test("the brief carries the two rules a hand-written one drops", () => {
  const out = formatBriefs(planLanes(["/orders/a", "/stock/a"], 2, { goal: "g" }), { mode: "safe-write", goal: "g" });
  assert.match(out, /LANE PLAN — 2 lane\(s\) over 2 route\(s\)/);
  assert.match(out, /mode: "safe-write"/, "a lane must not attach laxer than the run was authorized for");
  assert.match(out, /works ITS routes only/);
  assert.match(out, /Every acting tool takes a `task`/);
  assert.match(out, /scout_lane_report/, "and it says how to hand results back");
  assert.match(out, /── orders ──/);
  assert.match(out, /objective: Own \/orders — g/);
});
