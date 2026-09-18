/**
 * Ownership tracking for `safe-write` mode: which records did THIS run create?
 *
 * It is the most dangerous rule in the engine. An id wrongly claimed as "ours"
 * licenses a real DELETE on data that existed before the run, so precision
 * matters more than recall everywhere in this file: when in doubt, the answer
 * is "not ours" and the write is blocked.
 *
 * It lives outside browser.ts because every rule here is a pure function of a
 * URL, a status code and two bodies — which means it can be table-tested
 * without launching a browser (ADR 5), and a rule this consequential should
 * never have been reachable only through a smoke test.
 */

/** Collections that hold identities/accounts — never claimable as session-created, whatever the response says. */
const IDENTITY_COLLECTION_RE = /\b(users?|accounts?|profiles?|members?|identit(y|ies)|me)\b/i;

/** Matches the original, unprefixed id shape: bare "id"/"_id"/"uuid" only. */
const BARE_ID_KEY_RE = /^(id|_id|uuid)$/i;

/**
 * Matches a resource-prefixed id key: snake_case-suffixed ("widget_id",
 * "order_item_id") or camelCase-suffixed ("widgetId"). Many REST APIs
 * name a create response's own primary key after the resource rather than
 * a bare "id" — an unprefixed-only match silently drops every one of those
 * responses from ownership tracking. Kept as a SEPARATE, more-strictly-
 * filtered bucket from BARE_ID_KEY_RE (see extractCreatedIds): this shape is
 * exactly what a foreign key echoing a client-supplied value also looks
 * like ("template_id"), so it must never ride the explicitCreation bypass
 * that lets a bare id survive even when its value was in the request body.
 */
const PREFIXED_ID_KEY_RE = /^[a-z][a-z0-9_]*_(id|uuid)$/i;
const PREFIXED_ID_KEY_CAMEL_RE = /[a-z0-9](Id|Uuid|UUID)$/;

/**
 * RPC-style action verbs that follow a resource collection in
 * create-from/clone/bulk endpoints (POST /api/things/from-template/:id,
 * /api/things/clone/:id, ...). A collection derived for ownership matching
 * must stop BEFORE one of these, or a later plain CRUD path on the created
 * resource (/api/things/:id) won't share a path prefix with the creation
 * URL and legitimate follow-up writes get wrongly blocked. Deliberately
 * does NOT also stop at a bare numeric segment: a nested create like
 * POST /api/documents/5/comments has no ownership-scoping problem (its
 * exact pathname already prefixes any later path under that comment), and
 * truncating there would only widen the stored collection unnecessarily.
 */
const ACTION_SEGMENT_RE = /^(from|via|clone|duplicate|copy|bulk|import|export|generate|batch)([-_].+)?$/i;

/** At most this many ids are claimed from one response — a list endpoint answering a POST must not mint a page of ownership. */
const MAX_IDS_PER_RESPONSE = 5;

/** id → the collection paths it was created under. */
export type OwnedIds = Map<string, Set<string>>;

/** Does this request path address a record this run created? */
export function isOwnedResource(ownedIds: OwnedIds, pathname: string): boolean {
  const segments = pathname.split("/");
  for (let i = 0; i < segments.length; i++) {
    const collections = ownedIds.get(segments[i]);
    if (!collections) continue;
    const parent = segments.slice(0, i).join("/");
    for (const c of collections) {
      // The id must sit DIRECTLY under the collection it was created in. A
      // bare prefix test is not enough: a record created through a generic
      // endpoint (POST /api, POST /rpc) stores the collection "/api", which
      // prefixes every path in the app — so creating record 7 anywhere would
      // have licensed a DELETE on /api/<any collection>/7, and numeric ids
      // collide across tables all the time.
      const own = `${c.replace(/\/$/, "")}/${segments[i]}`;
      if (pathname === own || pathname.startsWith(`${own}/`)) return true;
      // Creation URL and CRUD URL can diverge below a shared collection
      // (POST /api/documents/quick → PUT /api/documents/:id): the record's
      // parent path is then an ANCESTOR of the stored creation collection.
      // Only that direction is accepted. The reverse — the stored collection
      // being an ancestor of the parent — is what /api/widgets/12/links/88
      // looks like: 88 sitting under somebody else's widget 12. Guard: the
      // parent must have ≥2 real segments so a bare "/api" never matches.
      if (parent.split("/").filter(Boolean).length >= 2 && c.startsWith(`${parent}/`)) return true;
    }
  }
  return false;
}

/** Collapse a creation request's pathname down to its resource collection, stopping before any RPC-action segment. */
export function deriveCollection(pathname: string): string {
  const segments = pathname.split("/");
  const kept: string[] = [];
  for (const seg of segments) {
    if (seg !== "" && ACTION_SEGMENT_RE.test(seg)) break;
    kept.push(seg);
  }
  const collection = kept.join("/");
  return collection || pathname; // never produce an empty collection
}

/** Strip an id-key's id/uuid suffix and normalize away separators, for comparing against a URL path segment (e.g. "document_id" → "document", "sopDocumentUuid" → "sopdocument"). */
function keyStem(key: string): string {
  return key
    .replace(/(?:_)?(id|uuid)$/i, "")
    .replace(/[-_]/g, "")
    .toLowerCase();
}

/**
 * True when a prefixed id key plausibly names the resource this creation
 * URL is actually about — e.g. "widget_id" for a request under
 * "/api/widgets/...". Without this, any OTHER *_id-shaped field a
 * create response happens to include (owner_id, parent_id, assigned_to_id
 * — server-derived, so never caught by the request-echo filter) would be
 * wrongly claimed as the new resource's own id. A stem that shares no
 * substring relationship with any path segment is assumed foreign.
 */
export function keyMatchesUrl(key: string, pathname: string): boolean {
  const stem = keyStem(key);
  if (!stem) return false;
  return (
    pathname
      .split("/")
      .filter(Boolean)
      // RPC-action segments (from-template, clone, ...) aren't the resource's
      // name — a foreign key that happens to be named after the verb itself
      // (e.g. "duplicate_id" on a POST .../duplicate endpoint) must not pass
      // just because it echoes the verb.
      .filter((seg) => !ACTION_SEGMENT_RE.test(seg))
      .some((seg) => {
        const normSeg = seg.replace(/[-_]/g, "").toLowerCase();
        return normSeg.length > 0 && (normSeg.includes(stem) || stem.includes(normSeg));
      })
  );
}

/** Everything about a successful POST that ownership is decided from. */
export interface CreationEvidence {
  pathname: string;
  status: number;
  /** The Location response header, if any. */
  location?: string;
  /** The parsed JSON response body, or undefined when it was not JSON / not readable. */
  body?: unknown;
  /** The raw request body, for telling a minted id from one the client already sent. */
  requestBody: string;
}

export interface CreationVerdict {
  /** Where the ids were created, collapsed so later plain CRUD paths still prefix-match. */
  collection: string;
  /** Identity/account collections are listed for cleanup but never grant mutation rights. */
  identityCollection: boolean;
  /** Ids this response genuinely minted. */
  ids: string[];
}

/**
 * Extract created-resource ids from a successful POST (JSON body + Location
 * header). Upsert echoes — ids the client already sent in the URL or body —
 * are excluded. A 201 or a Location header marks a true creation.
 */
export function extractCreatedIds(ev: CreationEvidence): CreationVerdict {
  // The identity check runs against the raw pathname (broadest net); the
  // stored collection is collapsed via deriveCollection so a later plain
  // CRUD path on the created resource still prefix-matches it even when
  // creation went through an RPC-style action endpoint.
  const identityCollection = IDENTITY_COLLECTION_RE.test(ev.pathname);
  const collection = deriveCollection(ev.pathname);
  // Kept as two buckets, not one merged list: a bare "id" is unambiguously
  // the response's own subject, so a 201/Location can excuse it appearing
  // in the request body too (client-supplied-id creates). A prefixed key
  // ("template_id") is exactly what an echoed FOREIGN key also looks like,
  // so it must always be checked against the request body — never excused
  // by explicitCreation — or a 201 response that echoes a foreign id
  // (e.g. {document_id, template_id}) would wrongly grant ownership of
  // the template.
  const bareIds: string[] = [];
  const prefixedIds: string[] = [];
  if (ev.location) {
    const last = ev.location.split("?")[0].split("/").filter(Boolean).pop();
    if (last) bareIds.push(last);
  }
  const scan = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const isIdValue = typeof v === "string" || typeof v === "number";
      if (isIdValue && BARE_ID_KEY_RE.test(k)) bareIds.push(String(v));
      else if (isIdValue && (PREFIXED_ID_KEY_RE.test(k) || PREFIXED_ID_KEY_CAMEL_RE.test(k)) && keyMatchesUrl(k, ev.pathname)) prefixedIds.push(String(v));
      else if (k === "data" || k === "result" || k === "item") scan(v);
    }
  };
  scan(ev.body);
  // An upsert echoes an id the client already had; a create mints a new one.
  // An id already in the REQUEST PATH is never ours (POST /items/123 targets
  // an existing resource whatever the response says); a 201/Location only
  // excuses a BARE id echoed in the request body (see bucket comment above).
  const explicitCreation = ev.status === 201 || !!ev.location;
  const notEchoedInPath = (id: string) => !ev.pathname.includes(id);
  const ids = [
    ...bareIds.filter((id) => notEchoedInPath(id) && (explicitCreation || !ev.requestBody.includes(id))),
    ...prefixedIds.filter((id) => notEchoedInPath(id) && !ev.requestBody.includes(id)),
  ].slice(0, MAX_IDS_PER_RESPONSE);
  return { collection, identityCollection, ids };
}
