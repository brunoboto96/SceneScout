/**
 * Snapshot collection: reading the page's interactables (and its frames'),
 * giving each a coverage key and a ref that survives a re-snapshot, and
 * keeping the last snapshot of each recent route for the next one's diff.
 *
 * Moved out of browser.ts behind `SnapshotHost`, the little the collector
 * needs from the engine (the page, the form read's time limit, which site a
 * frame belongs to, and where harvested links go), so the bookkeeping of refs
 * and kept snapshots can be table-tested with a stand-in page (contract-test).
 * The page-side scripts it runs are collector.ts's and forms.ts's.
 */
import type { Frame, Page } from "playwright";
import { bestEffort } from "./best-effort.js";
import {
  capForeignName,
  COLLECT_INTERACTABLES_SCRIPT,
  frameElementKey,
  frameToPageRect,
  MASKED_NAME,
  masksForeignName,
  matchPrevious,
  stripForeignHref,
  type Affordances,
  type CutElement,
  type ElementState,
  type FrameTag,
  type NameFrom,
  type Rect,
} from "./collector.js";
import { elementKey, keyAliasSteps, normalizePath, ordinalKeys, routeBase, type InteractableInfo } from "./fingerprint.js";
import { FORMS_INVENTORY_SCRIPT, formIdentity, formStatus, isNavigationTeardown, type FormFacts } from "./forms.js";
import { NAME_RULE, type KeyAliasSteps } from "./memory.js";
import { destructiveLabelOf } from "./policy.js";
import { recheckBusy, recheckWait } from "./settle.js";

/**
 * How long the page's document has been up, in ms: since its response arrived (the navigation entry's responseEnd),
 * or since the document's start where the browser has no such entry. Read in the page, so it is the page's own clock.
 */
export const PAGE_AGE_SCRIPT = `(() => { const n = performance.getEntriesByType("navigation")[0]; return performance.now() - (n && n.responseEnd > 0 ? n.responseEnd : 0); })()`;

export interface SnapshotElement extends InteractableInfo {
  /** The frame it was collected from; absent for the page itself. */
  frame?: FrameTag;
  ref: string;
  key: string;
  tag: string;
  xpath: string;
  disabled: boolean;
  href: string | null;
  destructive: boolean;
  clipped?: boolean;
  /** Nearest positioning/scroll-context id (0 = document flow) — overlap grouping. */
  layer?: number;
  /** Inside position:fixed/sticky chrome — overlaps between chrome are intended layering. */
  chrome?: boolean;
  rect: Rect;
  /** Set when the control is pinned chrome whose centre is owned by other pinned chrome (hit-tested in the page). */
  coveredBy?: string | null;
  /** Set when a field's name is its placeholder, name attribute or type rather than a label. */
  nameFrom?: NameFrom | null;
  /** Read by the geometry oracles (geometry.ts GeometryElement). */
  focusable?: boolean;
  focusMoves?: boolean;
  passThrough?: boolean;
  fieldPad?: { l: number; r: number } | null;
  /** A user can act on it (collector isInteractive); false for what is listed only for its test id or its text. */
  interactive?: boolean;
  /** For an element with no control role or native control: what alone makes it actionable (collector-elements.ts affordanceFlags). */
  affords?: Affordances | null;
  /** Inside an aria-hidden subtree. */
  ariaHidden?: boolean;
  /** A live region listed only for what it says: kept out of the state's identity and its coverage (trackedElements). */
  liveOnly?: boolean;
  /** Pressed, selected, checked, expanded, current (stateFlags). */
  state?: ElementState;
  /** The horizontally scrolling container it sits outside the visible width of, when it does. */
  scrolledOutIn?: string | null;
}

/** One kept snapshot: its route and, by element key, what the diff compares and the ref the element had. */
export interface SnapRecord {
  route: string;
  byKey: Map<string, { ref: string; label: string; href: string | null; disabled: boolean; state: string[] }>;
}

/**
 * The kept snapshot a new one is compared with: the latest snapshot, an
 * earlier one of the same route, or the latest of another tab of the screen.
 */
export interface PrevSnap {
  snap: SnapRecord;
  how: "latest" | "revisited" | "tab";
}

/** How many routes' last snapshots are kept for diffs. */
export const SNAPSHOTS_KEPT = 20;

/** A form a collect found: its identity key, and whether the page itself refuses its empty submit. */
export type SeenForm = { key: string; guarded: boolean };

/** The most frames a snapshot reads controls from. */
export const MAX_READ_FRAMES = 10;

/** How long a snapshot waits for its frames' elements to answer. */
export const FRAME_READ_MS = 1500;

/** The coverage key of the page's own element at this xpath (never one in a frame: its xpath names a node in another document). */
export function keyAtXpath(elements: readonly SnapshotElement[], xpath: string): string | null {
  return elements.find((el) => !el.frame && el.xpath === xpath)?.key ?? null;
}

/** How many times a read of the page is taken again after the page's own navigation interrupted it (readPage). */
export const NAVIGATED_READ_RETRIES = 3;

/** The part of the page readPage uses. */
export interface ReadablePage {
  evaluate(script: string): Promise<unknown>;
  waitForLoadState(state: "domcontentloaded"): Promise<unknown>;
  isClosed(): boolean;
}

/**
 * A read of the page's own document that survives the page navigating under it. A route's scripts can move the
 * visitor on (a sign-in guard, a redirect after a check) while the read is in the page, and Playwright then rejects it
 * ("Execution context was destroyed"). That is not a failed snapshot: the read is taken again in the document that
 * replaced it, once that has arrived, so the collect lists the page the session is on. Only a read a navigation ended
 * is taken again (forms.ts isNavigationTeardown): a script that throws, a closed page, or a read still interrupted after
 * NAVIGATED_READ_RETRIES (a redirect loop) is the caller's error, at once.
 */
export async function readPage(page: ReadablePage, script: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(script);
    } catch (err) {
      if (attempt >= NAVIGATED_READ_RETRIES || page.isClosed() || !isNavigationTeardown(err instanceof Error ? err.message : String(err))) throw err;
      await bestEffort(page.waitForLoadState("domcontentloaded"));
    }
  }
}

/** A frame read that gives up after FRAME_READ_MS, answering null. */
export async function withinFrameLimit<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FRAME_READ_MS);
  });
  return Promise.race([bestEffort(work, null), limit]).finally(() => clearTimeout(timer));
}

/** What the collector needs from the engine that drives the session. */
export interface SnapshotHost {
  /** The page the session drives; throws when the session is not attached. */
  page(): Page;
  /** A form read within its time limit, or null when it did not answer (browser.ts formRead). */
  formRead<T>(what: string, work: Promise<T>): Promise<T | null>;
  /** The other site a frame belongs to, or null for the page and the app's own frames (browser.ts foreignOriginOf). */
  foreignOriginOf(frame: Frame): string | null;
  /** Feed a collect's elements to the route list (browser.ts harvestRoutes). */
  harvestRoutes(elements: SnapshotElement[]): void;
  /**
   * The page's requests now: how many young ones are out (settle.ts RECHECK_OPEN_MS), and when the latest started; and
   * when the latest action started (`changedAt`), all on Date.now's clock.
   */
  requests(): { inFlight: number; lastRequestStart: number; changedAt: number };
}

/** The interactables of the page the host drives, their refs, and the snapshots kept for diffs. */
export class SnapshotCollector {
  constructor(private readonly host: SnapshotHost) {}

  refs = new Map<string, SnapshotElement>();
  private refCounter = 0;
  /**
   * The last snapshot of each recent route, newest last (at most
   * SNAPSHOTS_KEPT): a route snapshotted again keeps its refs and is shown as
   * a diff, even after a visit elsewhere, and a tab of a screen diffs against
   * the screen's last tab.
   */
  private snaps = new Map<string, SnapRecord>();
  /** The route of the latest snapshot, so a diff can say whether it is against that one. */
  private lastSnapRoute = "";
  /** Why the refs of the latest snapshot were dropped since it was taken, or null when they were not. */
  refsDropped: string | null = null;
  /** Forget every kept snapshot: the next one of any route is listed in full, with new refs. */
  forgetSnapshots(): void {
    this.snaps.clear();
    this.lastSnapRoute = "";
    this.refsDropped = null;
  }

  /** Drop the latest snapshot's refs, remembering why so the next diff does not call them stable. */
  dropRefs(reason: string): void {
    this.refs.clear();
    this.refsDropped ??= reason;
  }

  /**
   * The kept snapshot a route's next snapshot is compared with: the route's
   * own, else the latest of another tab of the same screen (routeBase).
   */
  private prevSnapFor(route: string): PrevSnap | null {
    const own = this.snaps.get(route);
    if (own) return { snap: own, how: route === this.lastSnapRoute ? "latest" : "revisited" };
    const base = routeBase(route);
    const tabs = [...this.snaps.values()].filter((s) => routeBase(s.route) === base);
    const latest = tabs[tabs.length - 1];
    return latest ? { snap: latest, how: "tab" } : null;
  }

  /** Keep a snapshot as its route's latest, dropping the least recent route past SNAPSHOTS_KEPT. */
  keepSnapshot(snap: SnapRecord): void {
    this.snaps.delete(snap.route);
    this.snaps.set(snap.route, snap);
    while (this.snaps.size > SNAPSHOTS_KEPT) this.snaps.delete(this.snaps.keys().next().value!);
    this.lastSnapRoute = snap.route;
    this.refsDropped = null;
  }

  /** Collect the current page's interactables into SnapshotElements with stable refs. */
  async collect(): Promise<{
    elements: SnapshotElement[];
    truncated: boolean;
    forms: SeenForm[];
    /** What past the element cap was left out (collector-elements.ts cutSummary). */
    cut: CutElement[];
    /** The snapshot this collect's refs were carried over from, and how it relates to this page. */
    prev: PrevSnap | null;
    /** For each element, its key in `prev`, or null when it is new since (collector-elements.ts matchPrevious). */
    matched: Array<string | null>;
    /** For each step between name rules, each listed key the rule before made differently, current → earlier (memory.ts KeyAliasSteps). */
    aliases: KeyAliasSteps;
  }> {
    const page = this.host.page();
    type RawElement = {
      tag: string;
      role: string;
      name: string;
      testid: string | null;
      xpath: string;
      disabled: boolean;
      href: string | null;
      rect: Rect;
      clipped?: boolean;
      layer?: number;
      chrome?: boolean;
      coveredBy?: string | null;
      nameFrom?: NameFrom | null;
      /** Its name under each earlier name rule, rule 1 first, when content named it (page-sources.ts PICK_NAME_SRC); not kept on the listed element. */
      priorNames?: string[];
      focusable?: boolean;
      focusMoves?: boolean;
      passThrough?: boolean;
      fieldPad?: { l: number; r: number } | null;
      /** Read for the label policy only (page-sources.ts POLICY_TEXT_SRC); not kept on the listed element. */
      ownText?: string;
      centre?: string[];
      interactive?: boolean;
      ariaHidden?: boolean;
      liveOnly?: boolean;
      state?: ElementState;
      scrolledOutIn?: string | null;
      affords?: Affordances | null;
      /** Past the collector's cap: only counted (CutElement). */
      cut?: boolean;
    };
    // SPAs (and dev servers mid-recompile) can present an empty shell for a
    // few seconds — and a shell that already renders its chrome (sidebar,
    // nav) passes a zero-check while the route content is still loading.
    // Read again until two reads agree on the element count once the page is
    // quiet (settle.ts recheckWait), so we snapshot the hydrated page, not the
    // loading state.
    const busyNow = (): boolean => {
      const { inFlight, lastRequestStart } = this.host.requests();
      return recheckBusy(inFlight, Date.now() - lastRequestStart);
    };
    // How long the page has been up: since its document arrived or the latest action, whichever is later
    // (recheckWait: a page that has just loaded is read for longer, as it may still draw from a timer).
    const ageNow = async (): Promise<number> => {
      const doc = Number(await readPage(page, PAGE_AGE_SCRIPT));
      return Math.min(Number.isFinite(doc) ? doc : 0, Date.now() - this.host.requests().changedAt);
    };
    const busyAt = [busyNow()];
    // The age is read before the controls, so a read is never credited with an age it had not reached.
    let ageMs = await ageNow();
    let rawElements: RawElement[] = (await readPage(page, COLLECT_INTERACTABLES_SCRIPT)) as RawElement[];
    const counts = [rawElements.length];
    const started = Date.now();
    for (;;) {
      const { inFlight, lastRequestStart } = this.host.requests();
      const now = Date.now();
      const wait = recheckWait({ counts, busyAt, elapsedMs: now - started, inFlight, sinceLastStartMs: now - lastRequestStart, ageMs });
      if (wait === null) break;
      await page.waitForTimeout(wait);
      busyAt.push(busyNow());
      ageMs = await ageNow();
      rawElements = (await readPage(page, COLLECT_INTERACTABLES_SCRIPT)) as RawElement[];
      counts.push(rawElements.length);
    }

    const cut = rawElements.filter((r) => r.cut) as CutElement[];
    rawElements = rawElements.filter((r) => !r.cut);
    // The page's forms, read in the same settled page as its elements. The
    // page's own document only: an xpath names a node in one document.
    const rawForms = ((await this.host.formRead("form inventory", page.evaluate(FORMS_INVENTORY_SCRIPT))) ?? []) as FormFacts[];
    // Then each frame's own controls, read once, each within its own limit.
    const framed = await this.collectFrames(page);

    // Element identity is the coverage key (testid or role+name, ordinal-
    // disambiguated). When a key persists across snapshots of the same route,
    // its ref is REUSED — diffs stay meaningful and the agent's mental model
    // (and previously issued refs) survive re-snapshots. An element inside a
    // frame carries the frame in its key (frames.ts frameElementKey).
    const route = normalizePath(page.url());
    const prev = this.prevSnapFor(route);
    this.refs.clear();
    this.refFrames.clear();
    const all: Array<{ raw: RawElement; frame?: Frame; tag?: FrameTag }> = [
      ...rawElements.map((raw) => ({ raw })),
      ...framed.flatMap((g) => g.raws.map((raw) => ({ raw: raw as RawElement, frame: g.frame, tag: g.tag }))),
    ];
    // A live region listed for what it says is known by its role, not its
    // text, so a new message reads as the same region saying something else.
    const baseKeyOf = (el: RawElement, name: string, tag?: FrameTag) => frameElementKey(el.liveOnly ? `live:${el.role}` : elementKey({ ...el, name }), tag);
    // Each element's base key under every name rule, rule 1 first, so each step between two rules gets its own aliases.
    const bases = all.map(({ raw: el, tag }) => ({
      byRule: Array.from({ length: NAME_RULE }, (_, i) => baseKeyOf(el, i < NAME_RULE - 1 ? (el.priorNames?.[i] ?? el.name) : el.name, tag)),
      tracked: !el.liveOnly,
    }));
    const keys = ordinalKeys(bases.map((b) => b.byRule[NAME_RULE - 1]));
    const aliases = keyAliasSteps(bases);
    const built = all.map(({ raw: el, frame, tag }, i) => {
      const key = keys[i];
      const { ownText: _ownText, centre: _centre, cut: _cut, priorNames: _priorNames, ...listed } = el;
      const full: SnapshotElement = {
        ...listed,
        ...(tag ? { frame: tag } : {}),
        // Judged on the real label, then masked: the policy must see what a click would press.
        // A message is not a control: "Could not delete" in an alert is not a Delete button.
        destructive: el.liveOnly ? false : destructiveLabelOf(el) !== null,
        ...(tag?.foreign ? { name: masksForeignName(el.tag, el.role) ? MASKED_NAME : capForeignName(el.name) } : {}),
        ...(tag?.foreign && el.href ? { href: stripForeignHref(el.href) } : {}),
        ref: "",
        key,
      };
      return { full, frame };
    });
    // An element keeps the ref it had in the snapshot it is matched to, so
    // refs an agent holds survive a re-snapshot and the diff stays readable.
    const matched = matchPrevious(
      prev?.snap.byKey ?? new Map(),
      built.map(({ full }) => ({ key: full.key, name: full.name, href: full.href, byPosition: full.liveOnly })),
    );
    const elements: SnapshotElement[] = built.map(({ full, frame }, i) => {
      const was = matched[i];
      full.ref = (was ? prev?.snap.byKey.get(was)?.ref : undefined) ?? `e${++this.refCounter}`;
      this.refs.set(full.ref, full);
      if (frame) this.refFrames.set(full.ref, frame);
      return full;
    });
    this.host.harvestRoutes(elements.filter((el) => !el.frame?.foreign));
    this.framesRead = new Set(framed.map((g) => g.frame));
    // A form is known by its own attributes, else by its submit control's coverage
    // key (forms.ts formIdentity); a form with neither is not tracked.
    const forms = rawForms.flatMap((f): SeenForm[] => {
      const status = formStatus(f);
      const key = status === "untracked" ? null : (formIdentity(f.attrs) ?? keyAtXpath(elements, f.submit));
      return key ? [{ key, guarded: status === "guarded" }] : [];
    });
    this.lastCollectTruncated = cut.length > 0;
    return { elements, truncated: cut.length > 0, forms, cut, prev, matched, aliases };
  }

  /** Whether the latest collect stopped at the element cap, so some controls have no key at all. */
  lastCollectTruncated = false;

  /**
   * The controls inside the page's frames, up to MAX_READ_FRAMES visible ones,
   * each read within FRAME_READ_MS so one busy frame cannot stall a snapshot.
   * Positions are moved into the page's coordinates (the frame element's box
   * on screen, the frame's own scroll, the page's scroll), so geometry and
   * the design audit can place them.
   */
  private async collectFrames(page: Page): Promise<Array<{ frame: Frame; tag: FrameTag; raws: unknown[] }>> {
    const top = page.mainFrame();
    const frames = page.frames().filter((f) => f !== top && !f.isDetached());
    if (frames.length === 0) return [];
    const pageScroll = ((await bestEffort(page.evaluate("({ x: window.scrollX, y: window.scrollY })"), null)) as { x: number; y: number } | null) ?? {
      x: 0,
      y: 0,
    };
    const read = async (frame: Frame): Promise<{ frame: Frame; tag: FrameTag; raws: unknown[] } | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = bestEffort(
        (async () => {
          const el = await frame.frameElement();
          const box = await el.boundingBox();
          if (!box || box.width < 2 || box.height < 2) return null;
          const title = ((await el.getAttribute("title")) || (await el.getAttribute("name")) || "").trim();
          const got = (await frame.evaluate(`(() => ({ els: ${COLLECT_INTERACTABLES_SCRIPT}, sx: window.scrollX, sy: window.scrollY }))()`)) as {
            els: Array<{ rect: Rect }>;
            sx: number;
            sy: number;
          };
          const raws = got.els
            .filter((r) => !(r as { cut?: boolean }).cut)
            .map((r) => ({ ...r, rect: frameToPageRect(r.rect, box, { x: got.sx, y: got.sy }, pageScroll) }));
          let origin = "";
          try {
            const u = new URL(frame.url());
            if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
          } catch {
            /* no web address */
          }
          const foreignOrigin = this.host.foreignOriginOf(frame);
          return { frame, tag: { url: frame.url(), origin: foreignOrigin ?? origin, title, foreign: foreignOrigin !== null }, raws };
        })(),
        null,
      );
      const limit = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FRAME_READ_MS);
      });
      return Promise.race([work, limit]).finally(() => clearTimeout(timer));
    };
    // Visible frames first: a page's hidden plumbing frames must not use up the budget.
    const boxes = await Promise.all(frames.map((f) => withinFrameLimit(f.frameElement().then((el) => el.boundingBox()))));
    const visible = frames.filter((_, i) => {
      const b = boxes[i];
      return !!b && b.width >= 2 && b.height >= 2;
    });
    const got = await Promise.all(visible.slice(0, MAX_READ_FRAMES).map(read));
    return got.filter((g): g is { frame: Frame; tag: FrameTag; raws: unknown[] } => g !== null);
  }

  /** Frames not directly under the page, less those whose controls were read anyway. */
  unreadNestedFrames(page: Page, nested: number): number {
    const top = page.mainFrame();
    const readNested = [...this.framesRead].filter((f) => !f.isDetached() && f.parentFrame() !== top).length;
    return Math.max(0, nested - readNested);
  }

  /** The frames whose controls the last snapshot listed. */
  framesRead = new Set<Frame>();

  /** The frame each ref of the last snapshot lives in; refs of the page itself are absent. */
  refFrames = new Map<string, Frame>();

  /**
   * Where to look for a ref's element: its frame, or the page. A frame that has
   * gone makes the ref stale, like a page that has navigated.
   */
  scopeOf(el: SnapshotElement): Page | Frame {
    const frame = this.refFrames.get(el.ref);
    if (!frame) return this.host.page();
    if (frame.isDetached()) throw new Error(`The frame holding ${el.ref} has gone — take a new scout_snapshot.`);
    // A frame that navigated holds a new document: the ref, and what it knew of the frame's site, are stale.
    if (el.frame && frame.url() !== el.frame.url) throw new Error(`The frame holding ${el.ref} has navigated — take a new scout_snapshot.`);
    return frame;
  }
}
