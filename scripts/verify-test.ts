/**
 * The re-test campaign: which findings it hands back, in what order, and what
 * recording a verdict says; and the guided re-check built on it, which never
 * attaches above the care level a finding was found in and never carries over
 * a confirmation the original check was given.
 *
 * The ordering is the whole value of the tool. A worklist that sends a run to
 * four routes to check four findings costs four times what one that groups
 * them by route does, and a worklist that re-checks the same finding twice
 * while another has never been looked at is worse than no worklist at all.
 *
 *   npx tsx --test scripts/verify-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, type Finding } from "../src/engine/memory.ts";
import { mergeMemory } from "../src/engine/memory-merge.ts";
import {
  buildRecheckPlan,
  CARE_MODE,
  CARES,
  careOfMode,
  confirmVerdict,
  GuidedPlans,
  guidedAttachVerdict,
  guidedPlan,
  guidedPlanText,
  recheckCandidates,
  recheckSpec,
  withSignInHealth,
  type Care,
  type GuidedPlan,
  type RecheckSpec,
} from "../src/engine/guided.ts";
import { RECHECK_WORDS } from "../src/engine/guided-words.ts";
import { WRITE_MODES, type WriteMode } from "../src/engine/policy.ts";
import { describeVerdict, formatWorklist, MAX_WORKLIST, resolvesFinding, sayVerification, unknownIds, verifyWorklist } from "../src/engine/verify.ts";

let n = 0;
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: `f${(n += 1)}`,
  severity: "medium",
  category: "data-inconsistency",
  title: `finding ${n}`,
  detail: "detail",
  url: "http://app.test/things",
  state: "things#1",
  repro: ["click Save", "read the row"],
  foundAt: "2026-08-01T10:00:00.000Z",
  runs: 1,
  ...over,
});

test("only open findings are handed back", () => {
  const list = [finding({ id: "open1" }), finding({ id: "done1", status: "resolved" }), finding({ id: "open2", status: "open" })];
  assert.deepEqual(
    verifyWorklist(list).map((i) => i.id),
    ["open1", "open2"],
  );
});

test("the worst route comes first, and its other findings come with it", () => {
  // A route carrying a high is walked before one carrying three mediums, and
  // the mediums that share the high's route are checked while it is open.
  const list = [
    finding({ id: "m1", url: "http://app.test/quiet", severity: "medium" }),
    finding({ id: "m2", url: "http://app.test/quiet", severity: "medium" }),
    finding({ id: "h1", url: "http://app.test/loud", severity: "high" }),
    finding({ id: "l1", url: "http://app.test/loud", severity: "low" }),
  ];
  assert.deepEqual(
    verifyWorklist(list).map((i) => i.id),
    ["h1", "l1", "m1", "m2"],
  );
});

test("within a route, one nobody has re-tested comes before one somebody has", () => {
  const list = [
    finding({ id: "seen", verdict: "present", verifiedAt: "2026-09-01T00:00:00.000Z" }),
    finding({ id: "never" }),
    finding({ id: "older", verdict: "changed", verifiedAt: "2026-08-15T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    verifyWorklist(list).map((i) => i.id),
    ["never", "older", "seen"],
    "never-checked first, then longest since it was last looked at",
  );
});

test("ids narrow the worklist, and ones that match nothing open are named", () => {
  const list = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c", status: "resolved" })];
  assert.deepEqual(
    verifyWorklist(list, ["a", "c", "zzz"]).map((i) => i.id),
    ["a"],
  );
  // A silently short worklist hides the fact that two of the three asked for
  // are not open — which a caller would read as "they are fine".
  assert.deepEqual(unknownIds(list, ["a", "c", "zzz"]), ["c", "zzz"]);
});

test("a campaign is capped at a length somebody will actually work down", () => {
  const many = Array.from({ length: MAX_WORKLIST + 10 }, (_, i) => finding({ id: `x${i}` }));
  assert.equal(verifyWorklist(many).length, MAX_WORKLIST);
});

test("the brief carries what re-testing one needs", () => {
  const out = formatWorklist(verifyWorklist([finding({ id: "abc", evidence: "GET /api/things 403", severity: "high" })]));
  assert.match(out, /VERIFY CAMPAIGN/);
  assert.match(out, /── \/things ──/);
  assert.match(out, /\[high\] abc/);
  assert.match(out, /evidence: GET \/api\/things 403/);
  assert.match(out, /repro: click Save → read the row/);
  assert.match(out, /never re-tested/);
  assert.match(out, /scout_verify \{ id, verdict/, "it says how to record the answer");
});

test("an empty campaign says why it is empty", () => {
  assert.match(formatWorklist([]), /no open findings/);
  assert.match(formatWorklist([], ["gone1"]), /No OPEN finding matches: gone1/);
});

test("only 'gone' resolves the finding", () => {
  assert.equal(resolvesFinding("gone"), true);
  assert.equal(resolvesFinding("present"), false);
  assert.equal(resolvesFinding("changed"), false);
});

test("each verdict reads back as what it means for the finding", () => {
  const f = { id: "abc", severity: "high", title: "the list is empty for an admin" };
  assert.match(describeVerdict(f, "gone"), /Resolved by re-test/);
  assert.match(describeVerdict(f, "present"), /Confirmed still present/);
  assert.match(describeVerdict(f, "present"), /instead of calling it unverified/);
  assert.match(describeVerdict(f, "changed"), /changed/);
  assert.match(describeVerdict(f, "gone", "the 403 is now a 200"), /the 403 is now a 200/);
});

test("the report says nothing about verification until somebody has verified", () => {
  // A finding nobody has looked at again must not gain a reassuring line.
  assert.equal(sayVerification({}), "");
  assert.equal(sayVerification({ verdict: "present" }), "", "a verdict with no date is not a confirmation");
  assert.match(sayVerification({ verdict: "present", verifiedAt: "2026-09-21T08:00:00.000Z" }), /confirmed still present on 2026-09-21/);
  assert.match(sayVerification({ verdict: "changed", verifiedAt: "2026-09-21T08:00:00.000Z" }), /behaviour has changed/);
});

test("a finding filed before a control's coverage key changed is re-tested on the same route as one filed after", () => {
  // Naming an image-only button changes its key and so the state fingerprint; a re-test target is the route, never the fingerprint.
  const list = [
    finding({ id: "before", url: "http://app.test/things?tab=1", state: "/things#a1b2c3d4" }),
    finding({ id: "elsewhere", url: "http://app.test/other", state: "/other#00000000" }),
    finding({ id: "after", url: "http://app.test/things?tab=1", state: "/things#e5f6a7b8" }),
  ];
  const items = verifyWorklist(list);
  const at = (id: string) => items.findIndex((i) => i.id === id);
  assert.equal(Math.abs(at("before") - at("after")), 1, "walked together");
  assert.equal(items[at("before")].route, items[at("after")].route);
});

// ---- The guided re-check (design 2.7) ----

const REMOTE = "https://staging.example.com";
const MODE_RANK: Record<WriteMode, number> = { observe: 0, "read-only": 1, "safe-write": 2, destructive: 3 };
/** The mode a finding is known to reproduce in: none recorded is observe. */
const foundRank = (f: Finding) => MODE_RANK[f.foundInMode ?? "observe"];

function specOf(findings: Finding[], opts: Parameters<typeof recheckSpec>[1] = {}, ids?: string[]): RecheckSpec {
  const spec = recheckSpec(recheckCandidates(findings, ids, opts.address).candidates, opts);
  assert.ok(spec.ok, JSON.stringify(spec));
  return spec.value;
}
const accepted = { accepted: true, outcome: "accepted", tellPerson: "" } as const;

test("re-check: the care level each write mode is re-checked in, none recorded being Look only", () => {
  const want: Array<[WriteMode | undefined, Care]> = [
    [undefined, "look-only"],
    ["observe", "look-only"],
    ["read-only", "may-submit-forms"],
    ["safe-write", "may-create-test-data"],
    // Never offered to a guided check, so the loosest a guided check may be: never above it.
    ["destructive", "may-create-test-data"],
  ];
  for (const [mode, care] of want) {
    assert.equal(careOfMode(mode), care, String(mode));
    if (mode) assert.ok(MODE_RANK[CARE_MODE[care]] <= MODE_RANK[mode], `${mode}: not above it`);
  }
});

test("re-check: never attaches above the mode any finding it re-tests was found in, for every mix of modes", () => {
  const modes: Array<WriteMode | undefined> = [undefined, ...WRITE_MODES];
  for (const a of modes)
    for (const b of modes)
      for (const c of modes) {
        const list = [a, b, c].map((m, i) => finding({ id: `m${i}`, url: `${REMOTE}/p${i}`, ...(m ? { foundInMode: m } : {}) }));
        const spec = specOf(list);
        const plan = buildRecheckPlan(spec, "gp-0123456789");
        const attach = plan.calls.find((x) => x.tool === "scout_attach")!;
        const label = `${a}/${b}/${c}`;
        assert.equal(attach.args.mode, plan.mode, label);
        for (const id of spec.ids) assert.ok(MODE_RANK[plan.mode] <= foundRank(list.find((f) => f.id === id)!), `${label}: ${id} re-tested above its mode`);
        // Every finding is either re-tested or left out with its reason: none disappears.
        assert.deepEqual([...spec.ids, ...spec.leftOut.map((l) => l.id)].sort(), ["m0", "m1", "m2"], label);
        for (const l of spec.leftOut) assert.equal(l.why, "looser-care", label);
      }
});

test("re-check: a contrastive pair, the same finding found in observe and in read-only, differs only in the plan's mode and its confirmation", () => {
  const base = { id: "same", url: `${REMOTE}/things/new` };
  const looking = buildRecheckPlan(specOf([finding({ ...base, foundInMode: "observe" })]), "gp-aaaaaaaaaa");
  const sending = buildRecheckPlan(specOf([finding({ ...base, foundInMode: "read-only" })]), "gp-bbbbbbbbbb");
  assert.deepEqual([looking.mode, looking.choices.care, looking.confirm], ["observe", "look-only", null]);
  assert.deepEqual(
    [sending.mode, sending.choices.care, sending.confirm?.reason, sending.confirm?.accepted],
    ["read-only", "may-submit-forms", "forms-on-remote-site", false],
  );
  assert.deepEqual(looking.recheck?.ids, sending.recheck?.ids);
  // The gate holds the observe re-check to observe.
  const plans = new GuidedPlans();
  plans.add(looking);
  const above = guidedAttachVerdict(plans, { planId: looking.planId, mode: "read-only", url: REMOTE });
  assert.ok(!above.ok && /"observe" at most/.test(above.why), JSON.stringify(above));
  assert.equal(guidedAttachVerdict(plans, { planId: looking.planId, mode: "observe", url: REMOTE }).ok, true);
});

test("re-check: a check confirmed in May create test data is re-checked by a new plan that asks again, never by its confirmation", () => {
  const plans = new GuidedPlans();
  const built = guidedPlan({ address: REMOTE, areas: ["forms"], care: "may-create-test-data" }, "gp-original01");
  assert.ok(built.ok);
  plans.add(built.plan);
  const original = plans.accept(built.plan.planId, accepted);
  assert.equal(original.confirm?.accepted, true);
  assert.equal(guidedAttachVerdict(plans, { planId: original.planId, mode: "safe-write", url: REMOTE }).ok, true, "the original check may write");
  // What it found was filed in safe-write.
  const found = [finding({ id: "wrote", url: `${REMOTE}/orders`, foundInMode: "safe-write" })];
  const recheck = plans.add(buildRecheckPlan(specOf(found), "gp-recheck001"));
  assert.notEqual(recheck.planId, original.planId);
  assert.deepEqual([recheck.mode, recheck.confirm?.reason, recheck.confirm?.accepted], ["safe-write", "creates-data", false]);
  const refused = guidedAttachVerdict(plans, { planId: recheck.planId, mode: "safe-write", url: REMOTE });
  assert.ok(!refused.ok && /needs the person's confirmation/.test(refused.why), JSON.stringify(refused));
  for (const mode of ["read-only", "safe-write"] as const)
    assert.equal(guidedAttachVerdict(plans, { planId: recheck.planId, mode, url: REMOTE }).ok, false, `${mode}: no inherited yes`);
  assert.equal(guidedAttachVerdict(plans, { planId: recheck.planId, mode: "observe", url: REMOTE }).ok, true, "looking is always allowed");
  assert.match(guidedPlanText(recheck), /Call scout_guided_confirm \{"planId":"gp-recheck001"\}/);
  // Only the person's own yes accepts it, and then only up to its own mode.
  assert.equal(confirmVerdict(recheck, { kind: "accepted", content: { answer: "yes", code: "1234" } }, "1234").accepted, true);
  plans.accept(recheck.planId, accepted);
  assert.equal(guidedAttachVerdict(plans, { planId: recheck.planId, mode: "safe-write", url: REMOTE }).ok, true);
  assert.equal(guidedAttachVerdict(plans, { planId: recheck.planId, mode: "destructive", url: REMOTE }).ok, false);
  // Its sign-in judged again later keeps the person's answer and the re-check, as any plan does.
  const again = withSignInHealth(plans.get(recheck.planId)!, undefined);
  assert.deepEqual([again.confirm?.accepted, again.recheck?.ids, again.mode], [true, ["wrote"], "safe-write"]);
});

test("re-check: findings found in a looser care level are left for a re-check of their own, which then uses theirs", () => {
  const list = [
    finding({ id: "look", severity: "low", url: `${REMOTE}/a` }),
    finding({ id: "form", severity: "high", url: `${REMOTE}/b`, foundInMode: "read-only" }),
  ];
  const first = specOf(list);
  assert.deepEqual([first.care, first.ids], ["look-only", ["look"]]);
  assert.deepEqual(first.leftOut, [{ id: "form", title: list[1].title, why: "looser-care", care: "may-submit-forms" }]);
  const plan = buildRecheckPlan(first, "gp-0123456789");
  assert.ok(plan.tellPerson.includes(RECHECK_WORDS.looserCare(1, "may-submit-forms")), plan.tellPerson.join("\n"));
  assert.match(guidedPlanText(plan), /call scout_recheck_plan \{"ids":\["form"\]\}/);
  const second = specOf(list, {}, ["form"]);
  assert.deepEqual([second.care, second.ids, second.leftOut], ["may-submit-forms", ["form"], []]);
});

test("re-check: the SceneScout config's cap only ever lowers the care level, and the person is told", () => {
  const list = [finding({ id: "wrote", url: `${REMOTE}/a`, foundInMode: "safe-write" })];
  const capped = specOf(list, { maxMode: "observe" });
  assert.deepEqual([capped.care, capped.foundIn, capped.ids], ["look-only", "may-create-test-data", ["wrote"]]);
  const plan = buildRecheckPlan(capped, "gp-0123456789", { maxMode: "observe" });
  assert.equal(plan.mode, "observe");
  assert.ok(plan.tellPerson.includes(RECHECK_WORDS.capped("look-only")));
  const free = buildRecheckPlan(specOf(list), "gp-0123456789");
  assert.ok(!free.tellPerson.includes(RECHECK_WORDS.capped("may-create-test-data")), "no cap, nothing said");
  // A spec asking for a looser level than its findings were found in is never built.
  assert.throws(() => buildRecheckPlan({ ...capped, care: "may-submit-forms", foundIn: "look-only" }, "gp-0123456789"), /care "may-submit-forms"/);
  assert.throws(() => buildRecheckPlan({ ...capped, care: "may-submit-forms", foundIn: "may-submit-forms" }, "gp-0123456789", { maxMode: "observe" }));
});

test("re-check: which findings it covers, on which site, and what it says when there are none", () => {
  const list = [
    finding({ id: "open", url: `${REMOTE}/a` }),
    finding({ id: "fixed", url: `${REMOTE}/a`, status: "resolved" }),
    finding({ id: "label", url: `${REMOTE}/a`, feedback: { verdict: "not-a-bug", at: "2026-10-01T00:00:00.000Z" } }),
    finding({ id: "other", url: "https://other.example.com/x" }),
  ];
  const all = recheckCandidates(list);
  assert.deepEqual(all.candidates.map((c) => c.id).sort(), ["open", "other"], "open ones, not those marked not a bug");
  assert.deepEqual(recheckCandidates(list, ["label", "fixed", "nope"]), {
    candidates: [{ id: "label", title: list[2].title, url: list[2].url, care: "look-only" }],
    missing: ["fixed", "nope"],
  });
  const spec = specOf(list);
  assert.equal(spec.address, REMOTE);
  assert.deepEqual(
    spec.leftOut.map((l) => [l.id, l.why]),
    [["other", "other-site"]],
  );
  const there = specOf(list, { address: "https://other.example.com/start" });
  assert.deepEqual([there.address, there.ids], ["https://other.example.com", ["other"]]);
  const none = recheckSpec([], {});
  assert.deepEqual(none, { ok: false, error: RECHECK_WORDS.none });
  const elsewhere = recheckSpec(recheckCandidates(list).candidates, { address: "https://nowhere.example.com" });
  assert.deepEqual(elsewhere, { ok: false, error: RECHECK_WORDS.noneOnSite("nowhere.example.com") });
  const bad = recheckSpec(recheckCandidates(list).candidates, { address: "https://user:pw@staging.example.com" });
  assert.ok(!bad.ok && !bad.error.includes("pw"), "an address with a password is refused without repeating it");
});

test("re-check: one site's findings are chosen before the cap, so another site's many cannot crowd them out", () => {
  const busy = Array.from({ length: MAX_WORKLIST + 1 }, (_, i) => finding({ id: `busy${i}`, severity: "high", url: `${REMOTE}/p${i}` }));
  const quiet = finding({ id: "quiet", severity: "low", url: "https://other.example.com/x" });
  const all = recheckCandidates([...busy, quiet]);
  assert.ok(!all.candidates.some((c) => c.id === "quiet"), "with no site named, the worst routes fill the cap");
  const there = specOf([...busy, quiet], { address: "https://other.example.com" });
  assert.deepEqual(there.ids, ["quiet"]);
  // recheckSpec's own filter alone would have found nothing there: the site is chosen before the cap.
  const late = recheckSpec(all.candidates, { address: "https://other.example.com" });
  assert.equal(late.ok, false);
});

test("re-check: the plan attaches with its own id, then lists the findings with scout_verify, and names no area", () => {
  const spec = specOf([finding({ id: "a1", url: `${REMOTE}/a` }), finding({ id: "a2", url: `${REMOTE}/b` })], { signIn: "password" });
  const plan: GuidedPlan = buildRecheckPlan(spec, "gp-0123456789");
  assert.deepEqual(
    plan.calls.map((c) => c.tool),
    ["scout_login", "scout_attach", "scout_verify"],
  );
  assert.deepEqual(plan.calls[1].args, { url: REMOTE, mode: "observe", role: "user", objective: RECHECK_WORDS.objective(2), planId: "gp-0123456789" });
  assert.deepEqual(plan.calls[2].args, { ids: spec.ids });
  assert.deepEqual([plan.areas, plan.choices.areas, plan.level, plan.budget], [[], [], "minimal", { minutes: 10, pages: 20 }]);
  const text = guidedPlanText(plan);
  assert.ok(!text.includes("scout_session {area}"), "a re-check checks no area");
  assert.match(text, /never record it as gone/);
  assert.match(text, /Then call scout_cards \{"ids":\["a1","a2"\]\}/);
  for (const care of CARES) assert.ok(RECHECK_WORDS.tellPerson(1, care).length > 0);
});

test("re-check: a finding keeps the strictest write mode it was filed in, in this process and when two processes' copies merge", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-found-in-"));
  try {
    const store = new MemoryStore(dir);
    const filing = { severity: "medium" as const, category: "http-error", url: "http://x/a", state: "/a#f1", title: "A mode is kept", detail: "d" };
    const [filed] = store.addFinding({ ...filing, foundInMode: "read-only" });
    // Born with it: written in the same flush as the finding, so no other process can read the finding without its mode.
    assert.equal(new MemoryStore(dir).findings.find((f) => f.id === filed.id)?.foundInMode, "read-only");
    assert.equal(store.addFinding({ ...filing, foundInMode: "safe-write" })[0].foundInMode, "read-only", "a looser filing does not loosen it");
    assert.equal(store.addFinding({ ...filing, foundInMode: "observe" })[0].foundInMode, "observe", "a stricter one tightens it");
    store.flush();
    assert.equal(new MemoryStore(dir).findings.find((f) => f.id === filed.id)?.foundInMode, "observe");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // A finding filed before modes were kept counts as found in observe: filed again in a looser mode, it stays observe.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-found-in-legacy-"));
  try {
    const store = new MemoryStore(legacyDir);
    const filing = { severity: "medium" as const, category: "http-error", url: "http://x/a", state: "/a#f1", title: "Filed by an older engine", detail: "d" };
    const [old] = store.addFinding(filing);
    assert.equal(old.foundInMode, undefined);
    assert.equal(store.addFinding({ ...filing, foundInMode: "safe-write" })[0].foundInMode, "observe");
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
  // Two copies of one finding folded at load keep the strictest mode of the two, whichever is kept.
  for (const order of [
    ["safe-write", "observe"],
    ["observe", "safe-write"],
    ["safe-write", undefined],
  ] as const) {
    const foldDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-found-in-fold-"));
    try {
      const copy = (id: string, mode: WriteMode | undefined) =>
        finding({ id, title: "Same defect", category: "http-error", url: "http://x/a", state: "/a#f1", ...(mode ? { foundInMode: mode } : {}) });
      fs.mkdirSync(path.join(foldDir, ".scenescout"), { recursive: true });
      fs.writeFileSync(
        path.join(foldDir, ".scenescout", "memory.json"),
        JSON.stringify({ version: 1, states: {}, findings: [copy("c1", order[0]), copy("c2", order[1])] }),
      );
      const folded = new MemoryStore(foldDir).findings;
      assert.equal(folded.length, 1, "the two copies fold into one");
      assert.equal(folded[0].foundInMode, "observe", `folded ${JSON.stringify(order)}`);
    } finally {
      fs.rmSync(foldDir, { recursive: true, force: true });
    }
  }
  const base = {
    id: "x",
    severity: "low" as const,
    category: "c",
    title: "t",
    detail: "d",
    url: "u",
    state: "/a#1",
    repro: [],
    foundAt: "2026-01-01",
    runs: 1,
  };
  const one = (over: Record<string, unknown>, foundAt = "2026-01-01"): Parameters<typeof mergeMemory>[0] => ({
    version: 1,
    states: {},
    findings: [{ ...base, foundAt, ...over }],
  });
  const cases: Array<[Record<string, unknown>, Record<string, unknown>, string | undefined]> = [
    [{ foundInMode: "safe-write" }, { foundInMode: "observe" }, "observe"],
    // A copy with none recorded was filed before modes were kept: it counts as observe.
    [{ foundInMode: "read-only" }, {}, "observe"],
    [{}, {}, undefined],
    // A value this engine does not know (a newer version's, or a hand edit) is not carried on, and counts as observe too.
    [{ foundInMode: "everything" }, { foundInMode: "safe-write" }, "observe"],
    [{ foundInMode: "everything" }, {}, undefined],
  ];
  for (const [a, b, want] of cases)
    for (const merged of [mergeMemory(one(a), one(b, "2026-01-02")), mergeMemory(one(b, "2026-01-02"), one(a))])
      assert.equal(merged.findings[0].foundInMode, want, `${JSON.stringify(a)} + ${JSON.stringify(b)}`);
  // And a re-check reads an unknown value as none recorded: Look only.
  assert.equal(recheckCandidates([finding({ id: "odd", foundInMode: "everything" as never })]).candidates[0].care, "look-only");
});
