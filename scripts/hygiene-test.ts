/**
 * Repository hygiene: nothing personal, nothing secret, and nothing from a real
 * application under test may be tracked here.
 *
 * SceneScout is developed by pointing it at real apps, which is exactly how
 * their data ends up in a repository: a saved login, a run's memory folder, a
 * pasted snapshot with somebody's email in it, a home-directory path in a
 * script. Review does not catch this reliably — the words look ordinary. This
 * suite reads every tracked file and fails on the shapes that matter.
 *
 * It is a guard, not a proof: it cannot know that a plain word is a customer's
 * product name. ADR 6 and the pull request checklist cover that part.
 *
 *   npx tsx --test scripts/hygiene-test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);

/** Files whose content is not ours to vet, or not text. */
const SKIP_CONTENT = /^package-lock\.json$|\.(png|jpe?g|gif|webp|avif|ico|woff2?|pdf|zip|tgz|gz|mp4|webm)$/i;
const SKIP_PREFIXES = ["examples/screenshots/"];

function textFiles(): Array<{ file: string; text: string }> {
  return (
    tracked
      .filter((f) => !SKIP_CONTENT.test(f) && !SKIP_PREFIXES.some((p) => f.startsWith(p)))
      // `git ls-files` also lists files deleted from the working tree but not
      // yet from the index; a half-finished `rm` must not read as a broken suite.
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((file) => ({ file, text: fs.readFileSync(path.join(root, file), "utf8") }))
  );
}

/** Every match of `re` in tracked text, as "file:line: match", minus allowed files. */
function hits(re: RegExp, allowFiles: RegExp | null = null): string[] {
  const out: string[] = [];
  for (const { file, text } of textFiles()) {
    if (allowFiles?.test(file)) continue;
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(re)) out.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
  return out;
}

const SELF = /^scripts\/hygiene-test\.ts$/;

// ── the rules ───────────────────────────────────────────────────────────────

/**
 * Paths that hold run output, saved sessions or local secrets. HAR files and
 * Playwright traces are on the list because both bundle the cookies and bearer
 * tokens of the session they recorded.
 */
export const FORBIDDEN_PATH_RE = new RegExp(
  [
    "(^|/)(\\.scenescout|\\.scenecraft|\\.frontend-tester)/",
    "(^|/)playwright/\\.auth/",
    "(^|/)\\.env(\\.(?!example$)[^/]*)?$",
    "(^|/)\\.npmrc$",
    "(^|/)\\.ssh/",
    "(^|/)id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$",
    "\\.(pem|p12|pfx|key|har)$",
    "(^|/)(credentials|cookies|auth|service-account)\\.json$",
    "storage-?state[^/]*\\.json$",
    "(^|/)trace\\.zip$",
    "(^|/)(test-results|playwright-report)/",
  ].join("|"),
  "i",
);

/** Addresses on domains reserved for documentation (RFC 2606 / 6761), plus GitHub's no-reply addresses. */
const ALLOWED_EMAIL_RE = /@((?:[a-z0-9-]+\.)*example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*(?:example|test|invalid|localhost)|users\.noreply\.github\.com)$/i;
/** The top-level domain must be alphabetic, or every `package@1.2.3` specifier reads as an address. */
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
export const isAllowedEmail = (email: string): boolean => ALLOWED_EMAIL_RE.test(email);

/**
 * A home directory with a real-looking account name. One-letter placeholder
 * accounts (`/home/u/`) are fine. Deliberately case-sensitive on the POSIX
 * side: lowercase `/users/<x>` is what REST routes look like, and this
 * repository is full of those.
 */
export const HOME_PATH_RE = /(?:\/Users\/|\/home\/)[A-Za-z][A-Za-z0-9._-]+|[A-Za-z]:[\\/]+[Uu]sers[\\/]+[A-Za-z][^\\/\s"']+/g;

/** Credential shapes issued by real services. */
export const SECRET_RE = new RegExp(
  [
    "\\bnpm_[A-Za-z0-9]{36,}\\b",
    "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b",
    "\\bgithub_pat_[A-Za-z0-9_]{40,}\\b",
    "\\bglpat-[A-Za-z0-9_-]{20,}\\b",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bAIza[0-9A-Za-z_-]{35}\\b",
    "\\bsk_(live|test)_[A-Za-z0-9]{16,}\\b",
    "\\bsk-(ant|proj)-[A-Za-z0-9_-]{20,}",
    "\\bxox[baprs]-[A-Za-z0-9-]{20,}\\b",
    "https://hooks\\.slack\\.com/services/[A-Za-z0-9/]{20,}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  ].join("|"),
  "g",
);

/**
 * A three-part JSON Web Token. Checked separately because the redaction tests
 * need realistic ones; everywhere else a JWT is somebody's live session.
 */
export const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}/g;
/** The redaction tests need realistic credential shapes to prove they are removed. Invented values only. */
const REDACTION_FIXTURE_FILES = /^scripts\/((memory|oracle|hygiene)-test\.ts|smoke\/.*\.ts)$/;

// ── the rules work ──────────────────────────────────────────────────────────

test("the rules fire on the shapes they exist for, and stay quiet on placeholders", () => {
  for (const p of [
    ".scenescout/memory.json",
    "app/playwright/.auth/admin.json",
    ".env",
    ".env.local",
    ".env.production",
    "deploy/.npmrc",
    "certs/server.pem",
    "auth/qa-storage-state.json",
    "e2e/storageState.admin.json",
    "session.har",
    "secrets/id_rsa",
    "home/.ssh/config",
    "config/credentials.json",
    "cookies.json",
    "fixtures/trace.zip",
    "test-results/run/video.webm",
  ]) {
    assert.ok(FORBIDDEN_PATH_RE.test(p), `${p} must be refused`);
  }
  for (const p of [".env.example", "src/engine/memory.ts", "docs/adr/0002-enforce-the-write-policy-at-the-network-layer.md", "skills/scenescout/SKILL.md"]) {
    assert.ok(!FORBIDDEN_PATH_RE.test(p), `${p} is an ordinary file`);
  }

  assert.equal(isAllowedEmail("qa@example.com"), true);
  assert.equal(isAllowedEmail("dev@mail.example.org"), true);
  assert.equal(isAllowedEmail("z@y.test"), true);
  assert.equal(isAllowedEmail("12345+someone@users.noreply.github.com"), true);
  assert.equal(isAllowedEmail("first.last@acme-corp.com"), false);
  assert.equal(isAllowedEmail("me@gmail.com"), false);
  assert.deepEqual([..."npm install -g npm@11.19.1 and config@4.0.1/schema.json".matchAll(EMAIL_RE)], [], "a package specifier is not an address");
  assert.equal([..."write to first.last@acme-corp.com today".matchAll(EMAIL_RE)].length, 1);

  const homes = (s: string) => [...s.matchAll(HOME_PATH_RE)].length;
  assert.equal(homes('projectDir: "/Users/jsmith/Dev/shop"'), 1);
  assert.equal(homes("cd /home/deploy/app && ls"), 1);
  assert.equal(homes("C:\\Users\\jsmith\\AppData\\Local"), 1);
  assert.equal(homes("/home/u/.cache/ms-playwright and /opt/node/bin"), 0, "a one-letter placeholder account is not a person");
  assert.equal(homes("/Users/Bob Smith/Dev"), 1, "a name with a space is caught by its first word");
  assert.equal(homes("cwd=/Users/jsmith"), 1, "no trailing slash needed");
  assert.equal(homes("C:/Users/jsmith/AppData and c:\\users\\jsmith\\x"), 2);
  assert.equal(homes("DELETE /api/users/bulk-delete and /users/3/delete"), 0, "a REST route is not a home directory");

  const secrets = (s: string) => [...s.matchAll(SECRET_RE)].length;
  assert.equal(secrets(`token: npm_${"a1".repeat(18)}`), 1);
  assert.equal(secrets(`ghp_${"Z9".repeat(18)}`), 1);
  assert.equal(secrets("AKIAIOSFODNN7EXAMPLE"), 1);
  assert.equal(secrets("-----BEGIN OPENSSH PRIVATE KEY-----"), 1);
  assert.equal(secrets(`npm_${"a1".repeat(20)}`), 1, "longer than the usual 36 characters");
  assert.equal(secrets(`sk-ant-api03-${"x".repeat(30)}`), 1);
  assert.equal(secrets(`sk-proj-${"y".repeat(30)}`), 1);
  assert.equal(secrets(`AIza${"B".repeat(35)}`), 1);
  assert.equal(secrets(`glpat-${"c".repeat(20)}`), 1);
  assert.equal(secrets("https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnop"), 1);
  assert.equal(secrets("pk_customer_identifier and sk_[redacted]"), 0);
  assert.equal([..."Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123".matchAll(JWT_RE)].length, 1);
  assert.equal([..."eyJ is how they start, but this is prose".matchAll(JWT_RE)].length, 0);
});

// ── the repository passes them ──────────────────────────────────────────────

test("no run output, saved login, env file or key is tracked", () => {
  assert.deepEqual(
    tracked.filter((f) => FORBIDDEN_PATH_RE.test(f)),
    [],
    "these paths hold data from a run or a secret; remove them from git and keep them ignored",
  );
});

test("every email address in the repository is on a reserved example domain", () => {
  // This file is excluded from all three content scans: its own test strings are, by design, the shapes the rules reject.
  const found = hits(EMAIL_RE, SELF).filter((h) => !isAllowedEmail(h.slice(h.lastIndexOf(" ") + 1)));
  assert.deepEqual(found, [], "use someone@example.com — a real address here is somebody's personal data");
});

test("no path into a real person's home directory", () => {
  assert.deepEqual(hits(HOME_PATH_RE, SELF), [], "write <project> or a /home/u/ placeholder; a real path names a person and often the app they were testing");
});

test("no credential shaped like a real service's token", () => {
  assert.deepEqual(hits(SECRET_RE, REDACTION_FIXTURE_FILES), [], "rotate it now — a secret that reached a commit is compromised — then remove it");
});

test("no JSON Web Token outside the redaction fixtures", () => {
  assert.deepEqual(
    hits(JWT_RE, REDACTION_FIXTURE_FILES),
    [],
    "a JWT is a live session for someone; the only ones allowed are the invented ones the redaction tests need",
  );
});
