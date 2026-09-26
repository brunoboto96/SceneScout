#!/usr/bin/env node
/**
 * Fernbrook — SceneScout's held-out benchmark app.
 *
 * A small, invented library loans desk with deliberately planted defects. It
 * exists for one reason: to measure whether SceneScout generalises beyond the
 * demo app it was tuned on. Nothing in the engine, the skill or a lane brief
 * may ever be tuned against it — runs on it are reported, never optimised
 * against. See docs/benchmark.md, "The held-out app".
 *
 * Three roles (member, librarian, head) are picked on /signin.html. No
 * dependencies, in-memory data, loopback only.
 *
 * The planted defects are listed in holdout-app/README.md and
 * holdout-app/answer-key.json, and those with a server half are marked below.
 * Comments naming them live in this file only, which is never served to the
 * browser; nothing under public/ may name one, and holdout-test fails if it does.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};

const ROLES = ["member", "librarian", "head"];
/** The member a visitor signed in as "member" is. */
export const SIGNED_IN_MEMBER = "M-1002";
/** Fines above this block a new loan. */
const FINE_LIMIT = 5;
const MAX_RENEWALS = 2;
const DAY = 24 * 60 * 60 * 1000;

export function createHoldoutServer() {
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const inDays = (n) => new Date(today.getTime() + n * DAY).toISOString().slice(0, 10);

  const books = [
    { id: 1, title: "The Salt Road", author: "Ines Marrow", year: 2019, copies: 2 },
    { id: 2, title: "A Field Guide to Moss", author: "Tobias Reel", year: 2008, copies: 1 },
    { id: 3, title: "Night Trains of the North", author: "Petra Lund", year: 2021, copies: 3 },
    { id: 4, title: "Small Engines, Big Ideas", author: "Owen Castellan", year: 2015, copies: 1 },
    { id: 5, title: "The Quiet Orchard", author: "Mara Ellison", year: 2023, copies: 2 },
    { id: 6, title: "Letters from the Estuary", author: "Dev Halloran", year: 1998, copies: 0 },
    { id: 7, title: "Weather for Beginners", author: "June Okafor", year: 2012, copies: 1 },
    { id: 8, title: "Mapping the Old Town", author: "Rafael Stroud", year: 2017, copies: 2 },
  ];
  const members = [
    { id: "M-1001", name: "Alma Reyes", email: "alma.reyes@example.test", phone: "555-0101", address: "4 Mill Lane", fines: 0 },
    { id: "M-1002", name: "Ben Oduya", email: "ben.oduya@example.test", phone: "555-0102", address: "17 Weir Street", fines: 1.2 },
    { id: "M-1003", name: "Clara Voss", email: "clara.voss@example.test", phone: "555-0103", address: "2 Chapel Row", fines: 0 },
    { id: "M-1004", name: "Dmitri Hale", email: "dmitri.hale@example.test", phone: "555-0104", address: "9 Kiln Yard", fines: 7.4 },
    { id: "M-1005", name: "Esme Tanaka", email: "esme.tanaka@example.test", phone: "555-0105", address: "31 Ferry Road", fines: 12.0 },
  ];
  let nextLoan = 208;
  const loans = [
    { id: 201, book: 2, member: "M-1002", due: inDays(-3), renewals: 0 },
    { id: 202, book: 1, member: "M-1002", due: inDays(9), renewals: 0 },
    { id: 203, book: 4, member: "M-1001", due: inDays(-11), renewals: 2 },
    { id: 204, book: 7, member: "M-1003", due: inDays(4), renewals: 1 },
    { id: 205, book: 3, member: "M-1005", due: inDays(16), renewals: 0 },
    { id: 206, book: 8, member: "M-1004", due: inDays(-1), renewals: 0 },
    { id: 207, book: 1, member: "M-1003", due: inDays(12), renewals: 0 },
  ];
  let nextHold = 34;
  const holds = [
    { id: 31, book: 2, member: "M-1003", placed: inDays(-6) },
    { id: 32, book: 4, member: "M-1002", placed: inDays(-2) },
    { id: 33, book: 7, member: "M-1005", placed: inDays(-1) },
  ];
  const events = [
    { id: 1, title: "Tuesday reading circle", date: inDays(5), seats: 12, joined: ["M-1001"] },
    { id: 2, title: "Local history walk", date: inDays(11), seats: 20, joined: [] },
    { id: 3, title: "Children's story hour", date: inDays(2), seats: 15, joined: ["M-1003", "M-1004"] },
  ];
  let nextReview = 4;
  const reviews = [
    { id: 1, book: 1, by: "Alma R.", text: "Slow start, wonderful last third." },
    { id: 2, book: 1, by: "Clara V.", text: "Lent it to my sister straight after." },
    { id: 3, book: 3, by: "Esme T.", text: "Read it on a train, which felt right." },
  ];

  const onLoan = (bookId) => loans.filter((l) => l.book === bookId).length;
  const withAvailability = (b) => ({ ...b, available: Math.max(0, b.copies - onLoan(b.id)) });
  const bookTitle = (id) => books.find((b) => b.id === id)?.title ?? "(unknown)";
  const memberName = (id) => members.find((m) => m.id === id)?.name ?? "(unknown)";
  const loanView = (l) => ({ ...l, title: bookTitle(l.book), name: memberName(l.member) });
  const holdView = (h) => ({ ...h, title: bookTitle(h.book), name: memberName(h.member) });

  /** The signed-in role. No cookie means member, the role a visitor off the street has. */
  const roleOf = (req) => {
    const m = /(?:^|;\s*)fernbrook_role=([a-z]+)/.exec(req.headers.cookie ?? "");
    return m && ROLES.includes(m[1]) ? m[1] : "member";
  };
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /** Parsed JSON body, or {} — never rejects, never hangs, never grows past 64 KiB. */
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 64 * 1024) {
          req.destroy();
          return resolve({});
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        } catch {
          resolve({});
        }
      });
      req.on("error", () => resolve({}));
      req.on("aborted", () => resolve({}));
    });

  const handle = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const role = roleOf(req);
    const staff = role !== "member";
    const me = role === "member" ? SIGNED_IN_MEMBER : null;

    if (p === "/api/me" && req.method === "GET") return json(res, 200, { role, member: me });
    if (p === "/api/signin" && req.method === "POST") {
      const body = await readBody(req);
      if (!ROLES.includes(body.role)) return json(res, 400, { error: "Unknown role" });
      res.writeHead(200, { "content-type": "application/json", "set-cookie": `fernbrook_role=${body.role}; Path=/; SameSite=Lax; HttpOnly` });
      return res.end(JSON.stringify({ role: body.role }));
    }

    // PLANTED DEFECT (notices-500-stuck-loading): the notices query throws on
    // every call, and the home page only ever shows its loading line.
    if (p === "/api/notices" && req.method === "GET") return json(res, 500, { error: "Internal Server Error" });

    if (p === "/api/summary" && req.method === "GET") {
      const mine = me ? loans.filter((l) => l.member === me) : loans;
      const due = inDays(0);
      return json(res, 200, {
        loans: mine.length,
        overdue: mine.filter((l) => l.due < due).length,
        holds: (me ? holds.filter((h) => h.member === me) : holds).length,
      });
    }

    if (p === "/api/books" && req.method === "GET") {
      let rows = books.map(withAvailability);
      // PLANTED DEFECT (catalogue-available-filter-lies): "available now"
      // tests the copies the library owns, not the copies on the shelf, so it
      // drops only the withdrawn title and keeps every book that is out on loan.
      if (url.searchParams.get("available") === "1") rows = rows.filter((b) => b.copies > 0);
      return json(res, 200, rows);
    }
    const book = p.match(/^\/api\/books\/(\d+)$/);
    if (book && req.method === "GET") {
      const b = books.find((x) => x.id === Number(book[1]));
      if (!b) return json(res, 404, { error: "No such book" });
      return json(res, 200, withAvailability(b));
    }
    const rv = p.match(/^\/api\/books\/(\d+)\/reviews$/);
    if (rv) {
      const b = books.find((x) => x.id === Number(rv[1]));
      if (!b) return json(res, 404, { error: "No such book" });
      if (req.method === "GET")
        return json(
          res,
          200,
          reviews.filter((r) => r.book === b.id),
        );
      if (req.method === "POST") {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
        if (!text) return json(res, 400, { error: "A review needs some text" });
        // PLANTED DEFECT (book-review-stored-xss), with book.html: the text is
        // stored as typed, and the page renders it as HTML.
        const review = { id: nextReview++, book: b.id, by: me ? `${memberName(me).split(" ")[0]} ${memberName(me).split(" ")[1][0]}.` : "Staff", text };
        reviews.push(review);
        return json(res, 201, review);
      }
    }

    if (p === "/api/members" && req.method === "GET") {
      if (!staff) return json(res, 403, { error: "Only library staff can see the member list" });
      return json(
        res,
        200,
        members.map(({ id, name, fines }) => ({ id, name, fines, loans: loans.filter((l) => l.member === id).length })),
      );
    }
    const member = p.match(/^\/api\/members\/(M-\d+)$/);
    if (member && req.method === "GET") {
      // PLANTED DEFECT (member-record-any-id): the list above is closed to
      // members, but a single record is returned to anyone who asks for it by
      // id — name, email, phone and address included.
      const m = members.find((x) => x.id === member[1]);
      if (!m) return json(res, 404, { error: "No such member" });
      return json(res, 200, m);
    }
    if (p === "/api/export" && req.method === "GET") {
      if (!me) return json(res, 200, { role, note: "Staff accounts hold no member data." });
      return json(res, 200, {
        member: members.find((m) => m.id === me),
        loans: loans.filter((l) => l.member === me).map(loanView),
        holds: holds.filter((h) => h.member === me).map(holdView),
      });
    }

    if (p === "/api/loans" && req.method === "GET") return json(res, 200, (me ? loans.filter((l) => l.member === me) : loans).map(loanView));
    if (p === "/api/loans" && req.method === "POST") {
      if (!staff) return json(res, 403, { error: "Only library staff can check a book out" });
      const body = await readBody(req);
      const m = members.find(
        (x) =>
          x.id ===
          String(body.member ?? "")
            .trim()
            .toUpperCase(),
      );
      if (!m) return json(res, 404, { error: "No member has that card number" });
      const b = books.find((x) => x.id === Number(body.book));
      if (!b) return json(res, 404, { error: "No such book" });
      if (m.fines > FINE_LIMIT) return json(res, 409, { error: `${m.name} owes $${m.fines.toFixed(2)}; the limit for borrowing is $${FINE_LIMIT.toFixed(2)}` });
      if (withAvailability(b).available === 0) return json(res, 409, { error: `No copy of "${b.title}" is on the shelf` });
      // The page that calls this (checkout.html) announces success for any
      // status below 500: PLANTED DEFECT checkout-false-success.
      const loan = { id: nextLoan++, book: b.id, member: m.id, due: inDays(21), renewals: 0 };
      loans.push(loan);
      return json(res, 201, loanView(loan));
    }
    const loanAct = p.match(/^\/api\/loans\/(\d+)\/(renew|return)$/);
    if (loanAct && req.method === "POST") {
      const loan = loans.find((l) => l.id === Number(loanAct[1]));
      if (!loan) return json(res, 404, { error: "No such loan" });
      if (loanAct[2] === "return") {
        if (!staff) return json(res, 403, { error: "Returns are taken at the desk" });
        loans.splice(loans.indexOf(loan), 1);
        return json(res, 200, { ok: true });
      }
      if (me && loan.member !== me) return json(res, 403, { error: "That is not your loan" });
      if (loan.renewals >= MAX_RENEWALS) return json(res, 409, { error: `A loan can be renewed ${MAX_RENEWALS} times` });
      // PLANTED DEFECT (loans-renew-double-submit), with loans.html: each call
      // renews once more, and the page leaves Renew enabled while the request
      // is in flight, so a double-click spends both renewals at once.
      loan.renewals += 1;
      loan.due = new Date(new Date(`${loan.due}T12:00:00Z`).getTime() + 14 * DAY).toISOString().slice(0, 10);
      return json(res, 200, loanView(loan));
    }

    if (p === "/api/holds" && req.method === "GET") return json(res, 200, (me ? holds.filter((h) => h.member === me) : holds).map(holdView));
    if (p === "/api/holds" && req.method === "POST") {
      const body = await readBody(req);
      const b = books.find((x) => x.id === Number(body.book));
      if (!b) return json(res, 404, { error: "No such book" });
      const who = me ?? String(body.member ?? "");
      if (!members.some((m) => m.id === who)) return json(res, 400, { error: "A hold needs a member" });
      if (holds.some((h) => h.book === b.id && h.member === who)) return json(res, 409, { error: "That member already has a hold on this book" });
      const hold = { id: nextHold++, book: b.id, member: who, placed: inDays(0) };
      holds.push(hold);
      return json(res, 201, { ...holdView(hold), position: holds.filter((h) => h.book === b.id).length });
    }
    const hold = p.match(/^\/api\/holds\/(\d+)$/);
    if (hold && req.method === "DELETE") {
      const h = holds.find((x) => x.id === Number(hold[1]));
      if (!h) return json(res, 404, { error: "No such hold" });
      if (me && h.member !== me) return json(res, 403, { error: "That is not your hold" });
      holds.splice(holds.indexOf(h), 1);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/fines" && req.method === "GET") {
      if (!staff) return json(res, 403, { error: "Fines are handled at the desk" });
      return json(
        res,
        200,
        members.filter((m) => m.fines > 0).map(({ id, name, fines }) => ({ id, name, fines })),
      );
    }
    const waive = p.match(/^\/api\/fines\/(M-\d+)\/waive$/);
    if (waive && req.method === "POST") {
      if (role !== "head") return json(res, 403, { error: "Only the branch head can waive a fine" });
      const m = members.find((x) => x.id === waive[1]);
      if (!m) return json(res, 404, { error: "No such member" });
      m.fines = 0;
      return json(res, 200, { id: m.id, fines: 0 });
    }

    if (p === "/api/events" && req.method === "GET")
      return json(
        res,
        200,
        events.map(({ joined, ...e }) => ({ ...e, left: e.seats - joined.length })),
      );
    const join = p.match(/^\/api\/events\/(\d+)\/join$/);
    if (join && req.method === "POST") {
      const e = events.find((x) => x.id === Number(join[1]));
      if (!e) return json(res, 404, { error: "No such event" });
      if (e.joined.length >= e.seats) return json(res, 409, { error: "That event is full" });
      const body = await readBody(req);
      const who = me ?? String(body.member ?? "guest");
      if (!e.joined.includes(who)) e.joined.push(who);
      // PLANTED DEFECT (events-joined-dead-end), in events.html: after a
      // successful join the page sends the visitor to events-joined.html,
      // which has no navigation and no way back.
      return json(res, 200, { id: e.id, left: e.seats - e.joined.length });
    }

    // Static files, fenced to public/.
    const rel = p === "/" ? "/index.html" : p;
    const file = path.resolve(publicDir, `.${path.posix.normalize(rel)}`);
    if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Not found</title><h1>404</h1><p>Nothing here.</p>");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

// Other planted defects live only in public/ and are listed in the README:
// holds-drop-unnamed, loans-overdue-contrast, account-export-clipped,
// book-hold-silent-no-op, catalogue-stale-after-loan, catalogue-search-throws.

// Run directly: `node holdout-app/server.mjs [port]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4180);
  createHoldoutServer().listen(port, "127.0.0.1", () => {
    console.log(`Fernbrook held-out app on http://127.0.0.1:${port}\nTry:  /scenescout --url http://127.0.0.1:${port}`);
  });
}
