/**
 * In-page probes: scrolling like a user, and reading what the page is doing to
 * the viewport (leaked scroll locks, stray overlays, missing focus rings).
 *
 * Each one is a function of a Page and nothing else — no engine state — which
 * is the whole reason they live here and not in browser.ts. They still need a
 * real browser, so they are exercised by the smoke suite; what moved is ~300
 * lines of page scripts that made the engine class hard to read.
 */
import type { Page } from "playwright";
import { DIALOG_LIKE_SEL } from "./collector.js";
import type { FocusSample } from "./design.js";

/** Per-action Playwright timeout, shared with the engine so a scroll into view fails as fast as a click would. */
export const ACTION_TIMEOUT_MS = 5000;

/**
 * Scroll ONE named region rather than the page. The page-level heuristic
 * picks the largest scrollable pane, so a smaller independently-scrolling
 * region — a sidebar nav beside a taller main pane — is otherwise
 * unreachable, and its content reads as truncated when it is merely scrolled
 * away. Resolves the element, then scrolls the nearest scrollable ancestor
 * (the target itself is usually the content, not the scroll port).
 */
export async function scrollContainer(page: Page, target: string, to?: "top" | "bottom", by?: number): Promise<{ refused?: string; note: string }> {
  let locator;
  if (target.startsWith("testid=")) locator = page.locator(`[data-testid=${JSON.stringify(target.slice(7))}]`).first();
  else if (target.startsWith("text=")) locator = page.getByText(target.slice(5), { exact: false }).first();
  else if (target.startsWith("label=")) locator = page.getByLabel(target.slice(6)).first();
  else return { refused: `Scroll target must be "testid=…", "text=…" or "label=…" (got: ${target})`, note: "" };

  const amount = Math.trunc(by ?? 600);
  const outcome = await locator
    .evaluate(
      (el: Element, args: { edge: string | null; delta: number }) => {
        const scrollable = (n: Element): boolean => {
          const s = getComputedStyle(n);
          const oy = s.overflowY;
          return (oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 4;
        };
        let node: Element | null = el;
        while (node && node !== document.body && !scrollable(node)) node = node.parentElement;
        if (!node || node === document.body) return null;
        const before = node.scrollTop;
        if (args.edge === "top") node.scrollTo(0, 0);
        else if (args.edge === "bottom") node.scrollTo(0, node.scrollHeight);
        else node.scrollBy(0, args.delta);
        const tid = node.getAttribute("data-testid");
        const cls = typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\s+/)[0] : "";
        return {
          name: node.tagName.toLowerCase() + (tid ? `[data-testid="${tid}"]` : cls),
          before,
          y: Math.round(node.scrollTop),
          max: Math.max(0, node.scrollHeight - node.clientHeight),
        };
      },
      { edge: to ?? null, delta: amount },
      { timeout: ACTION_TIMEOUT_MS },
    )
    .catch(() => undefined);
  if (outcome === undefined) return { refused: `Scroll target not found: ${target}`, note: "" };

  if (!outcome) {
    return {
      note: `\nNothing to scroll: ${target} has no scrollable ancestor — its content is not clipped by a scroll port, so everything it holds is already laid out on the page.`,
    };
  }
  const pct = outcome.max > 0 ? Math.round((outcome.y / outcome.max) * 100) : 100;
  const edge = outcome.y >= outcome.max - 4 ? " — at its bottom" : outcome.y <= 4 ? " — at its top" : "";
  const moved = Math.abs(outcome.y - outcome.before) > 4;
  return {
    note: `\nScrolled ${outcome.name}: ${outcome.y}px of ${outcome.max}px (${pct}%)${edge}.` + (moved ? "" : ` It did not move — already at that position.`),
  };
}

/**
 * The user-emulating scroll core, shared by scout_scroll and plan steps. Does
 * NOT run afterAction — plan steps drain oracles themselves, and draining
 * here would empty the queue their abort-on-fresh-violation check reads.
 */
export async function performScroll(page: Page, to?: "top" | "bottom", by?: number): Promise<{ refused?: string; note: string }> {
  // `lock` matters because overflow:hidden only blocks USER scrolling
  // (wheel/keys/touch) — window.scrollTo sails right through it. Emulating a
  // native user means refusing to scroll where they couldn't. A lock is
  // legitimate while ANY overlay is up — dialog-like panel (DIALOG_LIKE_SEL,
  // so role-less hand-rolled modals count) or a full-viewport backdrop.
  const read = `({y: window.scrollY, dh: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), vh: window.innerHeight,
    lock: [getComputedStyle(document.documentElement).overflowY, document.body ? getComputedStyle(document.body).overflowY : ""].some((o) => o === "hidden" || o === "clip"),
    ov: [...document.querySelectorAll('${DIALOG_LIKE_SEL}')].some((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      || [...document.querySelectorAll("body *")].some((e) => { const s = getComputedStyle(e); if (s.position !== "fixed") return false; const r = e.getBoundingClientRect(); return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9; })})`;
  const before = (await page.evaluate(read)) as { y: number; dh: number; vh: number; lock: boolean; ov: boolean };
  const amount = Math.trunc(by ?? 600);
  const wantedDown = to === "bottom" || (!to && amount > 0);
  const hadRoomDown = before.dh > before.vh + 50 && before.y < before.dh - before.vh - 4;
  if (before.lock && !before.ov && wantedDown && hadRoomDown) {
    return {
      refused:
        `⚠ SCROLL LOCKED: the document is ${Math.round(before.dh - before.vh)}px taller than the viewport but page scrolling is disabled (overflow hidden on body/html) with NO open dialog — ` +
        `a real user cannot reach anything below the fold (classic leaked modal scroll-lock; check the snapshot's OVERLAY lines and file it). Did not scroll.`,
      note: "",
    };
  }
  if (before.dh <= before.vh + 50) {
    // App-shell layout: the document fits the viewport and real scrolling
    // happens inside an inner pane. Reporting "at the bottom (100%)" here
    // would tell the brain it has seen a whole page it never scrolled.
    const inner = (await page.evaluate(`(() => {
      let best = null;
      for (const e of document.querySelectorAll("body *")) {
        const s = getComputedStyle(e);
        if (s.overflowY !== "auto" && s.overflowY !== "scroll") continue;
        if (e.scrollHeight <= e.clientHeight + 50) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        if (!best || r.width * r.height > best.a) best = { a: r.width * r.height, e };
      }
      if (!best) return null;
      const e = best.e;
      const to = ${JSON.stringify(to ?? null)};
      if (to === "top") e.scrollTo(0, 0);
      else if (to === "bottom") e.scrollTo(0, e.scrollHeight);
      else e.scrollBy(0, ${amount});
      const tid = e.getAttribute("data-testid");
      const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/)[0] : "";
      return { name: e.tagName.toLowerCase() + (tid ? '[data-testid="' + tid + '"]' : cls), y: Math.round(e.scrollTop), max: Math.max(0, e.scrollHeight - e.clientHeight) };
    })()`)) as { name: string; y: number; max: number } | null;
    if (!inner) return { note: `\nPage does not scroll — the content fits the viewport and no scrollable inner container was found.` };
    const pct = inner.max > 0 ? Math.round((inner.y / inner.max) * 100) : 100;
    return {
      note: `\nThe document itself does not scroll (app-shell layout) — scrolled the inner container ${inner.name} instead: ${inner.y}px of ${inner.max}px (${pct}%)${inner.y >= inner.max - 4 ? " — at its bottom" : inner.y <= 4 ? " — at its top" : ""}.`,
    };
  }
  if (to === "top") await page.evaluate("window.scrollTo(0, 0)");
  else if (to === "bottom") await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  else await page.evaluate(`window.scrollBy(0, ${amount})`);
  const after = (await page.evaluate(read)) as { y: number; dh: number; vh: number };
  const max = Math.max(0, after.dh - after.vh);
  const pct = max > 0 ? Math.round((after.y / max) * 100) : 100;
  let note = `\nScroll position: ${Math.round(after.y)}px of ${max}px (${pct}%)${after.y >= max - 4 ? " — at the bottom" : after.y <= 4 ? " — at the top" : ""}.`;
  if (wantedDown && hadRoomDown && Math.abs(after.y - before.y) <= 4) {
    note +=
      before.lock && before.ov
        ? `\nPage scroll is locked by an open overlay (normal modal behaviour).`
        : `\n⚠ SCROLL LOCKED: the document is ${Math.round(before.dh - before.vh)}px taller than the viewport but the page did not scroll — content below the fold is unreachable (file it).`;
  }
  return { note };
}

/**
 * Overlay/modal defect probe, run on every snapshot. Native `page.on("dialog")`
 * only sees browser dialogs; APP modals (backdrop + positioned panel) are just
 * DOM, and their canonical failure modes — a grayed-out page with an EMPTY
 * dialog, a dialog shoved off-centre leaving a blank band, a backdrop with no
 * dialog at all, a dialog taller than the viewport with no way to reach its
 * buttons — all look perfectly healthy to the interactables collector.
 * Best-effort: probe failure must never break the snapshot.
 */
export async function probeOverlays(page: Page): Promise<string[]> {
  try {
    return (await page.evaluate(`(() => {
      const issues = [];
      const vw = window.innerWidth, vh = window.innerHeight;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      // Backdrops: fixed, near-full-viewport, visually darkening/blurring.
      const backdrops = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!visible(el)) continue;
        const s = getComputedStyle(el);
        if (s.position !== "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.9 || r.height < vh * 0.9) continue;
        const m = (s.backgroundColor || "").match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?/);
        const alpha = m ? (m[4] === undefined ? 1 : Number(m[4])) : 0;
        const darkens = (alpha > 0.05 && alpha < 0.98) || ((s.backdropFilter || "") + "").includes("blur");
        if (darkens) backdrops.push(el);
      }
      const hasContent = (el) => {
        const t = (el.textContent || "").trim();
        return t.length >= 10 || el.querySelectorAll("button, a[href], input, select, textarea").length > 0;
      };
      // Dialogs: aria/role/class-marked panels (role-less hand-rolled modals
      // count). Do NOT exclude backdrops here — a modal that carries its own
      // dim background (a full-screen [role=alertdialog] that IS the backdrop
      // and centres its card inside) is both, and excluding it would wrongly
      // read as "backdrop with no dialog".
      const dialogsAll = [...document.querySelectorAll('${DIALOG_LIKE_SEL}')].filter((d) => visible(d));
      // Leaked modal scroll-lock: content extends past the fold, the page
      // itself cannot scroll (overflow hidden on body/html), and NO overlay
      // of any kind — dialog-like panel OR backdrop — is up to justify the
      // lock; everything below the fold is unreachable and the page looks
      // perfectly healthy otherwise.
      const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      const ovLock = [getComputedStyle(document.documentElement).overflowY, document.body ? getComputedStyle(document.body).overflowY : ""].some((o) => o === "hidden" || o === "clip");
      if (ovLock && docH > vh + 50 && dialogsAll.length === 0 && backdrops.length === 0) {
        issues.push("OVERLAY: page scrolling is DISABLED (overflow hidden on body/html) with " + Math.round(docH - vh) + "px of content below the fold and NO open dialog to justify it — likely a leaked modal scroll-lock; users cannot reach the rest of the page");
      }
      if (backdrops.length === 0) return issues;
      if (dialogsAll.length === 0) {
        // No marked dialog anywhere. Only a genuine stuck-grey-screen if the
        // backdrop region itself holds nothing to interact with.
        if (!backdrops.some(hasContent)) {
          issues.push("OVERLAY: page is covered by a modal backdrop but NO dialog content was found — the page is grayed out with nothing to interact with (user is stuck)");
        }
        return issues;
      }
      // The actual CARD, for geometry/emptiness checks: a full-viewport dialog
      // is a centring wrapper, not the panel — descend to its largest content
      // child that is smaller than the viewport.
      const panelOf = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.9 || r.height < vh * 0.9) return el;
        let best = null;
        for (const c of el.querySelectorAll("*")) {
          if (!visible(c)) continue;
          const cr = c.getBoundingClientRect();
          if (cr.width >= vw * 0.9 && cr.height >= vh * 0.9) continue;
          if (cr.width < 40 || cr.height < 40 || !hasContent(c)) continue;
          if (!best || cr.width * cr.height > best.a) best = { a: cr.width * cr.height, c };
        }
        return best ? best.c : el;
      };
      const panels = [];
      for (const d of dialogsAll) { const p = panelOf(d); if (p && panels.indexOf(p) < 0) panels.push(p); }
      for (const d of panels.slice(0, 3)) {
        const r = d.getBoundingClientRect();
        const text = (d.textContent || "").trim();
        const controls = d.querySelectorAll("button, a[href], input, select, textarea").length;
        const name = d.getAttribute("data-testid") ? "[" + d.getAttribute("data-testid") + "]" : "<" + d.tagName.toLowerCase() + ">";
        if (text.length < 10 && controls === 0) {
          issues.push("OVERLAY: open dialog " + name + " appears EMPTY (" + text.length + " chars, 0 controls) over a grayed-out page — likely failed content load or broken conditional render");
          continue;
        }
        const topGap = r.top, bottomGap = vh - r.bottom;
        if (r.height < vh && Math.abs(topGap - bottomGap) > vh * 0.35 && (topGap > vh * 0.4 || bottomGap > vh * 0.4)) {
          issues.push("OVERLAY: dialog " + name + " is far off-centre — " + Math.round(Math.max(topGap, bottomGap)) + "px empty band " + (topGap > bottomGap ? "above" : "below") + " it while the page is grayed out (broken centering)");
        }
        if (r.bottom > vh + 8 && d.scrollHeight <= d.clientHeight + 8) {
          issues.push("OVERLAY: dialog " + name + " extends " + Math.round(r.bottom - vh) + "px below the viewport with NO internal scroll — its lower controls may be unreachable");
        }
      }
      return issues;
    })()`)) as string[];
  } catch {
    return [];
  }
}

/**
 * Keyboard-focus sampling for the design audit. Uses TRUSTED Tab presses:
 * programmatic el.focus() does not match :focus-visible on buttons/links in
 * Chromium, so an in-page probe would flag every default-styled control as
 * focusless. As Tab advances, the previous stop is naturally blurred, so
 * each stop's focused style (captured at visit time) can be diffed against
 * its blurred style (captured in one pass at the end) without fighting the
 * tab order. Best-effort: any failure returns an empty sample set rather
 * than failing the audit.
 */
export async function probeFocusIndicators(page: Page): Promise<FocusSample[]> {
  const styleSig = "s.outlineStyle + '|' + s.outlineWidth + '|' + s.outlineColor + '|' + s.boxShadow + '|' + s.borderColor + '|' + s.backgroundColor";
  const stops: Array<{ i: number; label: string; focused: string }> = [];
  try {
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const info = (await page.evaluate(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        if (el.hasAttribute("data-scout-focus-probe")) return "wrapped";
        el.setAttribute("data-scout-focus-probe", "${i}");
        const s = getComputedStyle(el);
        const tid = el.getAttribute("data-testid");
        const name = ((el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 30));
        return { label: tid ? "[" + tid + "]" : "<" + el.tagName.toLowerCase() + "> " + JSON.stringify(name), focused: ${styleSig} };
      })()`)) as { label: string; focused: string } | "wrapped" | null;
      if (info === null || info === "wrapped") break;
      stops.push({ i, ...info });
    }
    await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
    const blurred = (await page.evaluate(`(() => {
      const out = {};
      for (const el of document.querySelectorAll("[data-scout-focus-probe]")) {
        const s = getComputedStyle(el);
        out[el.getAttribute("data-scout-focus-probe")] = ${styleSig};
        el.removeAttribute("data-scout-focus-probe");
      }
      return out;
    })()`)) as Record<string, string>;
    // A stop that vanished between passes gets the benefit of the doubt.
    return stops.map((st) => ({
      label: st.label,
      indicator: blurred[String(st.i)] === undefined ? true : st.focused !== blurred[String(st.i)],
    }));
  } catch {
    return [];
  }
}
