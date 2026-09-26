/**
 * The demo app's server rules, over real HTTP: what each role may do, and the
 * seeded defects `examples/report.md` documents. A well-meant fix to one of
 * those defects would silently invalidate the sample report and the README's
 * numbers; this suite makes that a red test instead.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
// @ts-expect-error — plain .mjs, no types; it exports createDemoServer().
import { createDemoServer } from "../demo-app/server.mjs";

let server: http.Server;
let base = "";

before(async () => {
  server = createDemoServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

type Reply = { status: number; body: unknown; headers: Headers };
async function call(method: string, urlPath: string, role?: string, body?: object): Promise<Reply> {
  const res = await fetch(base + urlPath, {
    method,
    headers: { ...(role ? { cookie: `harbor_role=${role}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

test("a visitor who has picked no role is a clerk, and sign-in accepts only the three roles", async () => {
  assert.deepEqual((await call("GET", "/api/me")).body, { role: "clerk" });
  assert.equal((await call("POST", "/api/signin", undefined, { role: "owner" })).status, 400);
  const manager = await call("POST", "/api/signin", undefined, { role: "manager" });
  assert.equal(manager.status, 200);
  assert.match(manager.headers.get("set-cookie") ?? "", /harbor_role=manager/);
});

test("an auditor reads everything and changes nothing, refused by the server rather than by a hidden button", async () => {
  assert.equal((await call("GET", "/api/audit", "auditor")).status, 200);
  assert.equal((await call("POST", "/api/orders", "auditor", { customer: "x", items: 1 })).status, 403);
  assert.equal((await call("POST", "/api/orders/1038/request-approval", "auditor")).status, 403);
  assert.equal((await call("DELETE", "/api/workspace", "auditor")).status, 403);
});

test("the audit log and the destructive controls are closed to a clerk", async () => {
  assert.equal((await call("GET", "/api/audit", "clerk")).status, 403);
  assert.equal((await call("GET", "/api/audit", "manager")).status, 200);
  assert.equal((await call("DELETE", "/api/orders/1042", "clerk")).status, 403);
  assert.equal((await call("DELETE", "/api/workspace", "clerk")).status, 403);
});

test("seeded: the approve endpoint accepts a clerk while reject checks for a manager", async () => {
  assert.equal((await call("POST", "/api/orders/1037/reject", "clerk")).status, 403);
  const approved = await call("POST", "/api/orders/1038/approve", "clerk");
  assert.equal(approved.status, 200);
  assert.equal((approved.body as { status: string }).status, "approved");
});

test("seeded: sorting inventory by quantity compares the numbers as text", async () => {
  const list = (await call("GET", "/api/inventory?sort=qty")).body as Array<{ qty: number }>;
  assert.deepEqual(
    list.map((i) => i.qty),
    [10, 120, 250, 3, 64, 9],
  );
});

test("seeded: the archived filter fails with a 500", async () => {
  assert.equal((await call("GET", "/api/orders?status=archived")).status, 500);
  assert.equal((await call("GET", "/api/orders?status=open")).status, 200);
});

test("seeded: creating an order is not idempotent, so a double submit makes two", async () => {
  const one = await call("POST", "/api/orders", "clerk", { customer: "Twice Co", items: 2 });
  const two = await call("POST", "/api/orders", "clerk", { customer: "Twice Co", items: 2 });
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.notEqual((one.body as { id: number }).id, (two.body as { id: number }).id);
});

test("nothing the browser is served tells a tester where the seeded defects are", () => {
  // The demo app is the benchmark target: a comment in a served file naming a
  // planted defect hands the answer to the agent being scored.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../demo-app");
  const key = JSON.parse(fs.readFileSync(path.join(root, "answer-key.json"), "utf8")) as { defects: Array<{ id: string }> };
  assert.ok(key.defects.length > 0);
  const spoilers = ["seeded defect", ...key.defects.map((d) => d.id.toLowerCase())];
  const publicDir = path.join(root, "public");
  const served = fs.readdirSync(publicDir, { recursive: true, encoding: "utf8" }).filter((f) => fs.statSync(path.join(publicDir, f)).isFile());
  assert.ok(served.includes("index.html"));
  const hits: string[] = [];
  for (const file of served) {
    const lines = fs.readFileSync(path.join(publicDir, file), "latin1").toLowerCase().split("\n");
    lines.forEach((line, i) => hits.push(...spoilers.filter((s) => line.includes(s)).map((s) => `${file}:${i + 1} ${s}`)));
  }
  assert.deepEqual(hits, []);
});
