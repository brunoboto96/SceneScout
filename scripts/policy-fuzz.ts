/**
 * Generated write requests, labelled destructive or harmless, for measuring
 * the write classifiers' miss and false-alarm rates (#548). The generator is
 * seeded, so a run is repeatable and two classifiers are scored on the same
 * cases; policy-test asserts on the rates, and running this file prints them:
 *
 *   npx tsx scripts/policy-fuzz.ts [cases] [seed]
 *
 * The shapes are the ones REST, RPC, JSON-RPC and GraphQL APIs commonly use,
 * written with made-up resource names. A generator written beside the
 * classifier it scores shares its author's blind spots, so the rates are a
 * floor on what is missed, not a measurement of any real app.
 */
import { isDestructiveRequest } from "../src/engine/policy.ts";
import type { WriteClassifier } from "../src/engine/strict-writes.ts";

export interface FuzzCase {
  url: string;
  body: string | null;
  destructive: boolean;
  /** The shape the case was generated from, for reading the misses. */
  shape: string;
}

/** A small seeded generator (mulberry32): the same seed gives the same cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ["delete", "remove", "purge", "destroy", "archive", "revoke", "deactivate", "wipe", "trash", "erase", "terminate", "disable", "cancel", "refund"];
const NOUNS = ["widget", "order", "thing", "account", "member", "invoice", "project", "token", "device", "report"];
const HARMLESS_VERBS = ["create", "update", "save", "submit", "rename", "search", "list", "export", "preview", "approve"];
const HOST = "https://app.example.com";

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** Generate `n` cases, about half destructive. */
export function fuzzCases(n = 2000, seed = 548): FuzzCase[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const id = (): string => String(1 + Math.floor(r() * 9999));
  const filler = (len: number): string => "lorem ipsum ".repeat(Math.ceil(len / 12)).slice(0, len);
  const destructive: Array<() => FuzzCase> = [
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s/${id()}/${pick(VERBS)}`, body: "{}", destructive: true, shape: "verb segment" }),
    () => ({ url: `${HOST}/api/${pick(VERBS)}${cap(pick(NOUNS))}`, body: JSON.stringify({ id: Number(id()) }), destructive: true, shape: "camelCase path" }),
    () => ({ url: `${HOST}/rpc/${cap(pick(NOUNS))}Service.${cap(pick(VERBS))}${cap(pick(NOUNS))}`, body: "{}", destructive: true, shape: "RPC path" }),
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s/${id()}?action=${pick(VERBS)}`, body: null, destructive: true, shape: "query action" }),
    () => ({
      url: `${HOST}/jsonrpc`,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `${pick(NOUNS)}.${pick(VERBS)}`, params: { id: Number(id()) } }),
      destructive: true,
      shape: "JSON-RPC method",
    }),
    () => ({
      url: `${HOST}/graphql`,
      body: JSON.stringify({ query: `mutation { ${pick(NOUNS)}${cap(pick(VERBS))}(id: ${id()}) { id } }` }),
      destructive: true,
      shape: "noun-first GraphQL",
    }),
    () => ({
      url: `${HOST}/graphql`,
      body: JSON.stringify({ query: `mutation Go($id: ID!) { ${pick(VERBS)}${cap(pick(NOUNS))}(id: $id) { ok } }`, variables: { id: id() } }),
      destructive: true,
      shape: "verb-first GraphQL",
    }),
    () => ({
      url: `${HOST}/api/batch`,
      body: JSON.stringify({ filter: filler(2500), action: pick(VERBS) }),
      destructive: true,
      shape: "command after 2,000 characters",
    }),
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s`, body: `id=${id()}&action=${pick(VERBS)}`, destructive: true, shape: "form command" }),
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s/bulk-${pick(VERBS)}`, body: JSON.stringify({ ids: [1, 2] }), destructive: true, shape: "bulk path" }),
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s/${id()}/${pick(VERBS)}_all`, body: "{}", destructive: true, shape: "snake_case path" }),
    () => ({ url: `${HOST}/api/patch`, body: JSON.stringify([{ op: "remove", path: `/${pick(NOUNS)}s/${id()}` }]), destructive: true, shape: "JSON-Patch" }),
    () => ({
      url: `${HOST}/api/${pick(NOUNS)}s/${id()}/${pick(VERBS)}-${pick(["history", "logs", "settings", "queue", "status"])}`,
      body: "{}",
      destructive: true,
      shape: "verb before its object",
    }),
    // A verb joined to another word with no separator (#684): `deleteAll`, `bulkPurge`, `RemoveWidgets`.
    () => {
      const verb = pick(VERBS);
      const noun = pick(NOUNS);
      const segment = pick([`${verb}All`, `bulk${cap(verb)}`, `${cap(verb)}${cap(noun)}s`, `${verb}${cap(noun)}Cache`]);
      return { url: `${HOST}/api/${noun}s/${segment}`, body: JSON.stringify({ ids: [1, 2] }), destructive: true, shape: "joined verb segment" };
    },
    // Verbs no list here names: what both classifiers are expected to miss.
    () => ({
      url: `${HOST}/api/${pick(NOUNS)}s/${id()}/${pick(["void", "ban", "unpublish", "drop", "reset", "expire"])}`,
      body: "{}",
      destructive: true,
      shape: "verb outside every list",
    }),
  ];
  const harmless: Array<() => FuzzCase> = [
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s`, body: JSON.stringify({ name: `New ${pick(NOUNS)}` }), destructive: false, shape: "plain create" }),
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s/${id()}/${pick(HARMLESS_VERBS)}`, body: "{}", destructive: false, shape: "harmless verb segment" }),
    () => ({ url: `${HOST}/api/${pick(HARMLESS_VERBS)}${cap(pick(NOUNS))}`, body: "{}", destructive: false, shape: "harmless camelCase path" }),
    () => ({
      url: `${HOST}/api/notes`,
      body: JSON.stringify({ note: `action: ${pick(VERBS)} the old ${pick(NOUNS)}` }),
      destructive: false,
      shape: "prose that looks like a command",
    }),
    () => ({
      url: `${HOST}/api/${pick(["delete", "cancel", "refund"])}-requests`,
      body: JSON.stringify({ reason: "moving" }),
      destructive: false,
      shape: "noun phrase path",
    }),
    () => ({
      url: `${HOST}/api/documents`,
      body: JSON.stringify({ title: `How to ${pick(VERBS)} a ${pick(NOUNS)}`, body: `Steps: ${pick(VERBS)} it, then ${pick(VERBS)} the rest.` }),
      destructive: false,
      shape: "content mentioning verbs",
    }),
    () => ({
      url: `${HOST}/graphql`,
      body: JSON.stringify({ query: `query { ${pick(NOUNS)}s { id deletedAt canDelete archived } }` }),
      destructive: false,
      shape: "GraphQL query naming verbs",
    }),
    () => ({
      url: `${HOST}/graphql`,
      body: JSON.stringify({ query: `mutation { update${cap(pick(NOUNS))}(id: ${id()}, input: { note: "${pick(VERBS)} later" }) { id deletedAt } }` }),
      destructive: false,
      shape: "harmless mutation with verbs in strings and fields",
    }),
    () => ({ url: `${HOST}/api/search?q=${pick(VERBS)}`, body: JSON.stringify({ q: pick(VERBS) }), destructive: false, shape: "search for a verb" }),
    () => ({
      url: `${HOST}/jsonrpc`,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `${pick(NOUNS)}.${pick(HARMLESS_VERBS)}`, params: { note: pick(VERBS) } }),
      destructive: false,
      shape: "harmless JSON-RPC",
    }),
    () => ({
      url: `${HOST}/api/${pick(NOUNS)}s/${id()}`,
      body: JSON.stringify({ status: "removed-from-sale", tags: ["archive"] }),
      destructive: false,
      shape: "verb words as values",
    }),
    () => ({ url: `${HOST}/api/${pick(NOUNS)}s/${id()}/cancel-reasons`, body: "{}", destructive: false, shape: "noun phrase segment" }),
    // Another form of a verb, joined to other words: a read that a substring match would refuse (#684).
    () => ({
      url: `${HOST}/api/${pick(NOUNS)}s/${pick([
        "deletedAtFilter",
        "removedItems",
        "purgeable",
        "archives",
        "bulkDeletionStatus",
        "cancellationPolicy",
        "revokedTokens",
        "deactivatedSince",
        "destroyedCount",
        "discardedDrafts",
      ])}`,
      body: JSON.stringify({ page: 1 }),
      destructive: false,
      shape: "other form of a verb, joined",
    }),
    // A verb used as a noun with no word after it that says so: what the strict classifier is expected to flag.
    () => ({
      url: `${HOST}/api/products/${pick(["trash-can", "archive-box", "wipe-dispenser", "remove-tool"])}/reviews`,
      body: JSON.stringify({ stars: 5 }),
      destructive: false,
      shape: "verb used as a noun",
    }),
  ];
  const out: FuzzCase[] = [];
  for (let i = 0; i < n; i++) out.push(r() < 0.5 ? pick(destructive)() : pick(harmless)());
  return out;
}

export interface FuzzRates {
  destructive: number;
  harmless: number;
  /** Destructive cases judged harmless. */
  missed: number;
  /** Harmless cases judged destructive. */
  falseAlarms: number;
  missRate: number;
  falseAlarmRate: number;
  missedShapes: Record<string, number>;
  falseAlarmShapes: Record<string, number>;
}

/** Score a classifier on the cases. */
export function fuzzRates(cases: readonly FuzzCase[], classifier: WriteClassifier): FuzzRates {
  const rates: FuzzRates = { destructive: 0, harmless: 0, missed: 0, falseAlarms: 0, missRate: 0, falseAlarmRate: 0, missedShapes: {}, falseAlarmShapes: {} };
  for (const c of cases) {
    const judged = isDestructiveRequest(c.url, c.body, classifier);
    if (c.destructive) {
      rates.destructive += 1;
      if (!judged) {
        rates.missed += 1;
        rates.missedShapes[c.shape] = (rates.missedShapes[c.shape] ?? 0) + 1;
      }
    } else {
      rates.harmless += 1;
      if (judged) {
        rates.falseAlarms += 1;
        rates.falseAlarmShapes[c.shape] = (rates.falseAlarmShapes[c.shape] ?? 0) + 1;
      }
    }
  }
  rates.missRate = rates.destructive ? rates.missed / rates.destructive : 0;
  rates.falseAlarmRate = rates.harmless ? rates.falseAlarms / rates.harmless : 0;
  return rates;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2] ?? 2000);
  const seed = Number(process.argv[3] ?? 548);
  const cases = fuzzCases(n, seed);
  for (const classifier of ["standard", "strict"] as const) {
    const r = fuzzRates(cases, classifier);
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    console.log(
      `${classifier}: missed ${r.missed}/${r.destructive} destructive (${pct(r.missRate)}), ` +
        `flagged ${r.falseAlarms}/${r.harmless} harmless (${pct(r.falseAlarmRate)})`,
    );
    if (r.missed) console.log(`  missed: ${JSON.stringify(r.missedShapes)}`);
    if (r.falseAlarms) console.log(`  false alarms: ${JSON.stringify(r.falseAlarmShapes)}`);
  }
}
