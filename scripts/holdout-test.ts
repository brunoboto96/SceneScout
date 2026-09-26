/**
 * The held-out benchmark app's server rules, over real HTTP: what each role
 * may do, and the planted defects its answer key scores runs against. A
 * well-meant fix to one of them would silently change what a held-out run
 * can find, and every held-out score before and after it would stop being
 * comparable; this suite makes that a red test instead.
 *
 * Defects that live only in the browser (the regular-expression search, the
 * session-storage cache, the clipped link, the icon-only button, the contrast
 * and the silent Place hold) are pinned by reading the served page, since
 * this suite runs without a browser.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
// @ts-expect-error — plain .mjs, no types; it exports createHoldoutServer().
import { createHoldoutServer, SIGNED_IN_MEMBER } from "../holdout-app/server.mjs";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../holdout-app");
const publicDir = path.join(appDir, "public");
const served = (file: string): string => fs.readFileSync(path.join(publicDir, file), "utf8");

let server: http.Server;
let base = "";

before(async () => {
  server = createHoldoutServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

type Reply = { status: number; body: unknown; headers: Headers };
async function call(method: string, urlPath: string, role?: string, body?: object): Promise<Reply> {
  const res = await fetch(base + urlPath, {
    method,
    headers: { ...(role ? { cookie: `fernbrook_role=${role}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
type Book = { id: number; copies: number; available: number };
type Loan = { id: number; member: string; due: string; renewals: number };

// ── the rules the server keeps ─────────────────────────────────────────────

test("a visitor who has picked no role is a member, and sign-in accepts only the three roles", async () => {
  assert.deepEqual((await call("GET", "/api/me")).body, { role: "member", member: SIGNED_IN_MEMBER });
  assert.equal((await call("POST", "/api/signin", undefined, { role: "admin" })).status, 400);
  const head = await call("POST", "/api/signin", undefined, { role: "head" });
  assert.equal(head.status, 200);
  assert.match(head.headers.get("set-cookie") ?? "", /fernbrook_role=head/);
});

test("a member sees only their own loans and holds, and the staff lists are closed to them", async () => {
  const loans = (await call("GET", "/api/loans", "member")).body as Loan[];
  assert.ok(loans.length > 0);
  assert.ok(loans.every((l) => l.member === SIGNED_IN_MEMBER));
  assert.ok(((await call("GET", "/api/loans", "librarian")).body as Loan[]).length > loans.length);
  assert.equal((await call("GET", "/api/members", "member")).status, 403);
  assert.equal((await call("GET", "/api/members", "librarian")).status, 200);
  assert.equal((await call("GET", "/api/fines", "member")).status, 403);
  assert.equal((await call("POST", "/api/loans", "member", { member: "M-1001", book: 5 })).status, 403);
  assert.equal((await call("POST", "/api/loans/205/return", "member")).status, 403);
  assert.equal((await call("POST", "/api/loans/205/renew", "member")).status, 403, "not their loan");
  assert.equal((await call("DELETE", "/api/holds/31", "member")).status, 403, "not their hold");
});

test("only the branch head can waive a fine, and the server enforces it", async () => {
  assert.equal((await call("POST", "/api/fines/M-1005/waive", "librarian")).status, 403);
  assert.equal((await call("POST", "/api/fines/M-1005/waive", "member")).status, 403);
  const waived = await call("POST", "/api/fines/M-1005/waive", "head");
  assert.equal(waived.status, 200);
  assert.deepEqual(waived.body, { id: "M-1005", fines: 0 });
});

test("a checkout the rules allow creates a loan, and the third renewal is refused", async () => {
  const ok = await call("POST", "/api/loans", "librarian", { member: "m-1001", book: 5 });
  assert.equal(ok.status, 201);
  const id = (ok.body as Loan).id;
  assert.equal((await call("POST", `/api/loans/${id}/renew`, "librarian")).status, 200);
  assert.equal((await call("POST", `/api/loans/${id}/renew`, "librarian")).status, 200);
  assert.equal((await call("POST", `/api/loans/${id}/renew`, "librarian")).status, 409);
});

// ── planted: the server half ───────────────────────────────────────────────

test("planted: the notices request always fails with a 500, and the home page only returns early on it", async () => {
  assert.equal((await call("GET", "/api/notices")).status, 500);
  const home = served("index.html");
  assert.match(home, /Loading notices…/);
  assert.match(home, /fetch\("\/api\/notices"\)\.then\(async \(r\) => \{\s*if \(!r\.ok\) return;/);
});

test("planted: a member can read another member's record by id, though the member list refuses them", async () => {
  assert.equal((await call("GET", "/api/members", "member")).status, 403);
  const other = await call("GET", "/api/members/M-1004", "member");
  assert.equal(other.status, 200);
  assert.equal((other.body as { email: string }).email, "dmitri.hale@example.test");
});

test("planted: Available now only keeps titles with every copy on loan, and drops only the withdrawn one", async () => {
  const all = (await call("GET", "/api/books")).body as Book[];
  const filtered = (await call("GET", "/api/books?available=1")).body as Book[];
  assert.ok(
    filtered.some((b) => b.available === 0),
    "an all-on-loan title passes the filter",
  );
  assert.deepEqual(
    all.filter((b) => !filtered.some((f) => f.id === b.id)).map((b) => b.copies),
    [0],
    "the one title dropped is the withdrawn one",
  );
});

test("planted: renewing is not idempotent, so two quick requests spend both renewals", async () => {
  const before = ((await call("GET", "/api/loans", "member")).body as Loan[]).find((l) => l.id === 202)!;
  assert.equal(before.renewals, 0);
  const [one, two] = await Promise.all([call("POST", "/api/loans/202/renew", "member"), call("POST", "/api/loans/202/renew", "member")]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  const after = ((await call("GET", "/api/loans", "member")).body as Loan[]).find((l) => l.id === 202)!;
  assert.equal(after.renewals, 2);
  const days = (Date.parse(after.due) - Date.parse(before.due)) / 86_400_000;
  assert.equal(days, 28);
  // And the page leaves the button enabled while it saves.
  assert.ok(!/disabled/.test(served("loans.html")));
});

test("planted: the server refuses a checkout for a member over the fine limit, and the page announces success for anything below 500", async () => {
  const refused = await call("POST", "/api/loans", "librarian", { member: "M-1004", book: 3 });
  assert.equal(refused.status, 409);
  assert.match((refused.body as { error: string }).error, /owes \$7\.40/);
  const page = served("checkout.html");
  assert.match(page, /if \(res\.status >= 500\)/);
  assert.ok(!/res\.ok/.test(page), "the page never reads res.ok");
  assert.match(page, /"Checked out "/);
});

test("planted: a review is stored as typed, and the book page renders its text as HTML", async () => {
  const payload = "<img src=x onerror=alert(1)>";
  const posted = await call("POST", "/api/books/2/reviews", "member", { text: payload });
  assert.equal(posted.status, 201);
  const list = (await call("GET", "/api/books/2/reviews")).body as Array<{ text: string }>;
  assert.equal(list.at(-1)?.text, payload);
  assert.match(served("book.html"), /":<\/strong> " \+ r\.text \+ "<\/li>"/);
});

test("planted: joining an event sends the visitor to a page with no navigation and no links", async () => {
  assert.equal((await call("POST", "/api/events/2/join", "member")).status, 200);
  assert.match(served("events.html"), /location\.href = "\/events-joined\.html"/);
  const joined = served("events-joined.html");
  assert.ok(!/<a\b|<button\b|<nav\b|<form\b/i.test(joined), "the confirmation page offers no way on");
});

// ── planted: the browser half, pinned in the served pages ──────────────────

test("planted: catalogue search compiles the typed text as a regular expression, outside any try", () => {
  const page = served("catalogue.html");
  assert.match(page, /new RegExp\(q, "i"\)/);
  assert.match(page, /addEventListener\("input", \(\) => render\(current\)\)/);
  assert.throws(() => new RegExp("(", "i"));
});

test("planted: the catalogue caches its full list in session storage and never refetches it in that tab", () => {
  const page = served("catalogue.html");
  assert.match(page, /sessionStorage\.getItem\(KEY\)/);
  assert.match(page, /if \(!all\) \{/);
});

test("planted: Place hold returns without a word when a copy is on the shelf", () => {
  assert.match(served("book.html"), /if \(!book \|\| book\.available > 0\) return;/);
});

test("planted: the hold-cancel button is an icon with no accessible name", () => {
  const page = served("holds.html");
  // From the button's opening tag to the icon it wraps, across the lines the markup is built on.
  const button = /<button class="icon"[\s\S]*?ICON/.exec(page)?.[0];
  assert.ok(button, "the icon button");
  assert.ok(!/aria-label|aria-labelledby|title=/.test(button), button);
  const icon = /const ICON =\s*'(<svg[^']*<\/svg>)'/.exec(page)?.[1];
  assert.ok(icon, "the icon");
  assert.match(icon, /aria-hidden="true"/);
  assert.ok(!/<title>/.test(icon), "the icon names nothing either");
});

test("planted: the overdue tag's colours are 1.84:1, and the data panel clips the export link", () => {
  const css = served("style.css");
  const late = /\.tag\.late \{\s*background: (#[0-9a-f]{6});\s*color: (#[0-9a-f]{6});/.exec(css);
  assert.ok(late, "the overdue tag's colours");
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (lum(late[1]) + 0.05) / (lum(late[2]) + 0.05);
  assert.equal(ratio.toFixed(2), "1.84");
  assert.match(css, /\.panel\.short \{\s*height: 112px;\s*overflow: hidden;/);
  const account = served("account.html");
  assert.ok(account.indexOf('data-testid="account-export"') > account.indexOf('class="panel short"'), "the link sits inside the short panel");
});

// ── nothing served gives the answers away ──────────────────────────────────

test("nothing the browser is served tells a tester where the planted defects are", () => {
  // This is the held-out benchmark target: a comment in a served file naming a
  // planted defect hands the answer to the agent being scored, and the whole
  // point of this app is that nobody has seen the answers.
  const key = JSON.parse(fs.readFileSync(path.join(appDir, "answer-key.json"), "utf8")) as { defects: Array<{ id: string }> };
  assert.ok(key.defects.length >= 12);
  const spoilers = [/seeded/, /defect/, /planted/, /deliberate/, /\bbugs?\b/, /answer.key/, /held.out/, /holdout/, ...key.defects.map((d) => new RegExp(d.id))];
  const files = fs.readdirSync(publicDir, { recursive: true, encoding: "utf8" }).filter((f) => fs.statSync(path.join(publicDir, f)).isFile());
  assert.ok(files.includes("index.html"));
  const hits: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(publicDir, file), "latin1").toLowerCase().split("\n");
    lines.forEach((line, i) => hits.push(...spoilers.filter((s) => s.test(line)).map((s) => `${file}:${i + 1} ${s}`)));
  }
  assert.deepEqual(hits, []);
});

test("the server serves nothing outside public/: not its key, its README or its own source", async () => {
  for (const p of ["/answer-key.json", "/README.md", "/server.mjs", "/../answer-key.json", "/%2e%2e/answer-key.json"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    await res.body?.cancel();
  }
});
