/**
 * Frames: what a snapshot says about a page's embeds, and a write from a
 * cross-origin frame never reaching the server, against the same write from a
 * same-origin frame that does.
 */
import type { Frame, Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { BROWSER, check, until, type SmokeContext } from "./harness.ts";

export const title = "frames";

export async function run({ baseUrl, foreignBaseUrl, projectDir, stats }: SmokeContext): Promise<void> {
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: `${baseUrl}/frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`, projectDir, mode: "read-only" });
    // White-box: the frames themselves, which the engine does not act in yet.
    const page = (engine as unknown as { page: Page }).page;
    const frameAs = (as: string): Frame | undefined => page.frames().find((f) => f.url().includes(`as=${as}`));
    const framesLoaded = () =>
      until(
        "all three frames to load",
        async () => {
          for (const as of ["same", "foreign", "bridge"]) {
            const f = frameAs(as);
            if (!f || !(await f.evaluate(() => typeof (window as unknown as { sendNote?: unknown }).sendNote === "function").catch(() => false))) return false;
          }
          return true;
        },
        8000,
      );
    await framesLoaded();

    console.log("frames: the snapshot says what is embedded");
    const snap = await engine.snapshot();
    check(
      "a snapshot lists the page's frames and says their controls are listed",
      snap.includes("FRAMES — the controls of each frame read are listed above"),
      snap,
    );
    check(
      "...a same-origin frame by its path and title",
      /same-origin \/frame-child\.html\?as=same "Same-site widget" \d+×\d+ — controls listed above/.test(snap),
      snap,
    );
    check(
      "...a cross-origin frame by its origin, saying its writes are refused",
      /cross-origin http:\/\/127\.0\.0\.1:\d+\/frame-child\.html\?as=foreign "Third-party form" \d+×\d+ — controls listed above — writes it sends outside the app are refused/.test(
        snap,
      ),
      snap,
    );
    check("...and a 0×0 bridge only as a count", snap.includes("(+1 hidden frame)") && !snap.includes("as=bridge"), snap);
    check("a page whose content is all in frames is not called a dead end", !snap.includes("DEAD END"), snap);

    console.log("frames: controls inside frames are listed, marked, and can be acted on");
    const refIn = (role: string, name: string, where: string) => new RegExp(`(e\\d+) ${role} "${name}"[^\\n]*⟨in ${where}`).exec(snap)?.[1];
    const sameSend = refIn("button", "Send", "same-origin frame /frame-child\\.html\\?as=same");
    const foreignSend = refIn("button", "Send", "cross-origin frame http://127\\.0\\.0\\.1:\\d+");
    const foreignNote = refIn("textbox", "Note", "cross-origin frame http://127\\.0\\.0\\.1:\\d+");
    check("a same-origin frame's controls are listed, marked with the frame", !!sameSend, snap);
    check("...and so are another site's frame's", !!foreignSend && !!foreignNote, snap);
    check(
      "a container's text is shown from the app's own frame, and masked from another site's",
      /Message from Alice[^\n]*⟨in same-origin frame/.test(snap) &&
        !/Message from Alice[^\n]*⟨in cross-origin frame/.test(snap) &&
        /content masked[^\n]*⟨in cross-origin frame/.test(snap),
      snap,
    );
    const before = stats.writes["POST /api/frame-note-same"] ?? 0;
    const sameClick = await engine.click(sameSend!);
    await until("the same-origin frame's write to arrive", () => (stats.writes["POST /api/frame-note-same"] ?? 0) === before + 1, 5000).catch(() => {});
    check("clicking inside the app's own frame acts there, and its write arrives", (stats.writes["POST /api/frame-note-same"] ?? 0) === before + 1, sameClick);
    const markup = await engine.type(foreignNote!, "<img src=x onerror=alert(1)>");
    check("markup typed into another site's frame is refused", /^REFUSED: typing this value \(it is markup\)/.test(markup), markup);
    const long = await engine.type(foreignNote!, "x".repeat(300));
    check("...and so is a fuzzing-length value", /^REFUSED: typing this value \(it is longer than 200/.test(long), long);
    const plain = await engine.type(foreignNote!, "hello");
    check("...while ordinary typing there is allowed", /^OK: type/.test(plain), plain);
    const doubled = await engine.click(foreignSend!, 2);
    check("a repeated-click probe in another site's frame is refused", /^REFUSED: a 2-click probe/.test(doubled), doubled);
    const foreignClick = await engine.click(foreignSend!);
    check(
      "a plain click there is allowed, and the write it sends is refused by the write policy",
      /^OK: click/.test(foreignClick) && /WRITE-POLICY blocked/.test(foreignClick) && stats.writes["POST /api/frame-note-foreign"] === undefined,
      foreignClick,
    );

    console.log("frames: a frame inside another site's frame, its links, and the keyboard");
    const innerForeign = /(e\d+) textbox "Inner note"[^\n]*⟨in cross-origin frame/.exec(snap)?.[1];
    check("a srcdoc frame inside another site's frame is that site's", !!innerForeign, snap);
    check(
      "...so what it holds is masked, while the same inside the app's frame is shown",
      /Message from Bob[^\n]*⟨in same-origin frame/.test(snap) && !/Message from Bob[^\n]*⟨in cross-origin frame/.test(snap),
      snap,
    );
    const innerTyped = innerForeign ? await engine.type(innerForeign, "<svg onload=alert(1)>") : "no ref";
    check("...and markup typed into it is refused", /^REFUSED: typing this value \(it is markup\)/.test(innerTyped), innerTyped);
    check(
      "another site's link is shown without its query, the app's own with it",
      /Conversation[^\n]*href=\/conv\/1\][^\n]*⟨in cross-origin frame/.test(snap) &&
        /Conversation[^\n]*token=SECRET123[^\n]*⟨in same-origin frame/.test(snap) &&
        !/token=SECRET123[^\n]*⟨in cross-origin frame/.test(snap),
      snap,
    );
    await frameAs("same")!.focus('[data-testid="frame-delete-action"]');
    const pressed = await engine.press("Enter");
    const deleted = await frameAs("same")!.evaluate(() => document.title);
    check(
      "Enter on a destructive control focused inside a frame is refused in read-only",
      /REFUSED/.test(pressed) && deleted !== "DELETED",
      `${deleted} ${pressed}`,
    );
    // A frame that navigates holds a new document: its old refs must not act there.
    const oldSameNote = refIn("textbox", "Note", "same-origin frame /frame-child\\.html\\?as=same");
    await frameAs("same")!.evaluate((go) => {
      location.href = go + "/frame-child.html?as=moved";
    }, foreignBaseUrl);
    await until("the frame to move", async () => !!frameAs("moved"), 5000).catch(() => {});
    const afterMove = await engine.type(oldSameNote!, "<b>x</b>").catch((e: unknown) => String(e));
    check("a ref into a frame that has since moved to another site is stale", /navigated/.test(afterMove), afterMove);
    await engine.navigate(`${baseUrl}/frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await framesLoaded();

    console.log("frames: hidden frames do not use up the frames a snapshot reads");
    await engine.navigate(`${baseUrl}/frames-many.html`);
    await until("the visible frame to load", async () => !!frameAs("visibleone"), 8000).catch(() => {});
    await page.waitForTimeout(500);
    const many = await engine.snapshot(true);
    check("a visible frame after eleven hidden ones is read", /button "Send"[^\n]*⟨in same-origin frame \/frame-child\.html\?as=visibleone/.test(many), many);
    await engine.navigate(`${baseUrl}/frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await framesLoaded();

    console.log("frames: a write from a cross-origin frame never leaves; the same write from a same-origin frame does");
    const sameBefore = stats.writes["POST /api/frame-note-same"] ?? 0;
    const sameStatus = await frameAs("same")!.evaluate(() => (window as unknown as { sendNote: () => Promise<unknown> }).sendNote());
    await until("the same-origin write to arrive", () => (stats.writes["POST /api/frame-note-same"] ?? 0) === sameBefore + 1, 5000).catch(() => {});
    check(
      "a write from a same-origin frame reaches the server in read-only",
      stats.writes["POST /api/frame-note-same"] === sameBefore + 1,
      `status ${sameStatus}`,
    );
    const foreignStatus = await frameAs("foreign")!.evaluate(() => (window as unknown as { sendNote: () => Promise<unknown> }).sendNote());
    await page.waitForTimeout(500);
    check(
      "a write from a cross-origin frame never reaches the server",
      stats.writes["POST /api/frame-note-foreign"] === undefined,
      JSON.stringify(stats.writes),
    );
    check("...and the frame's script is answered with a refusal, so its own handling runs", foreignStatus === 403, `status ${foreignStatus}`);
    const logged = (engine.memory?.actionLog ?? []).some(
      (e) => e.action === "write-policy:blocked" && /sent from a frame of http:\/\/127\.0\.0\.1:\d+/.test(e.target ?? ""),
    );
    check("...and the run's log says where it came from", logged);

    console.log("frames: a foreign frame's write into the app is the app's business");
    type Child = {
      sendToApp: (app: string) => Promise<string>;
      postToTop: () => void;
      openPopup: () => void;
      openPopupLink: () => void;
      openPopupBorrowed: () => void;
    };
    await frameAs("foreign")!.evaluate((app) => (window as unknown as Child).sendToApp(app), baseUrl);
    await page.waitForTimeout(800);
    const refusedIntoApp = (engine.memory?.actionLog ?? []).some((e) => e.action === "write-policy:blocked" && (e.target ?? "").includes("/api/frame-to-app"));
    check("a foreign frame's write whose destination is the app is not refused by the policy", !refusedIntoApp);
    // Chromium's own local-network rule stops a document the engine re-served
    // (to add the sandbox) from calling a loopback address, which is where the
    // fixture's app lives; a real embed is public and meets the same rule
    // calling an app on localhost. Elsewhere the write arrives.
    if (BROWSER !== "chromium") {
      await until("the write into the app to arrive", () => stats.writes["POST /api/frame-to-app"] === 1, 5000).catch(() => {});
      check("...and it arrives", stats.writes["POST /api/frame-to-app"] === 1, JSON.stringify(stats.writes));
    }

    console.log("frames: a popup a foreign frame opens on its own site");
    const popups: Page[] = [];
    const onPopup = (p: Page) => popups.push(p);
    page.context().on("page", onPopup);
    for (const how of ["openPopup", "openPopupLink", "openPopupBorrowed"] as const) {
      await frameAs("foreign")!
        .evaluate((h) => (window as unknown as Child)[h](), how)
        .catch(() => {});
    }
    await page.waitForTimeout(1500);
    page.context().off("page", onPopup);
    check(
      "a foreign frame cannot open a window: not by window.open, a detached link, or a borrowed window.open",
      popups.length === 0,
      `${popups.length} popup(s)`,
    );
    check("...so the popup's write never reaches the server", stats.writes["POST /api/frame-popup"] === undefined, JSON.stringify(stats.writes));
    check("...while a same-origin frame keeps its window.open", await frameAs("same")!.evaluate(() => typeof window.open === "function"));

    console.log("frames: a form aimed at the top window, from each frame");
    await frameAs("foreign")!.evaluate(() => (window as unknown as Child).postToTop());
    await page.waitForTimeout(800);
    check(
      "a foreign frame's form aimed at the top window never reaches the server",
      stats.writes["POST /api/frame-top-foreign"] === undefined,
      JSON.stringify(stats.writes),
    );
    console.log("frames: the same embed on a sign-in page and on a checkout page");
    for (const [name, arrives] of [
      ["login", true],
      ["checkout", false],
    ] as const) {
      await engine.navigate(`${baseUrl}/account/${name}.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
      await until(
        `the embed on ${name} to load`,
        async () => {
          const f = frameAs(name);
          return !!f && (await f.evaluate(() => typeof (window as unknown as { sendNote?: unknown }).sendNote === "function").catch(() => false));
        },
        8000,
      );
      await frameAs(name)!.evaluate(() => (window as unknown as { sendNote: () => Promise<unknown> }).sendNote());
      await page.waitForTimeout(500);
      const got = stats.writes[`POST /api/frame-note-${name}`] === 1;
      check(
        arrives ? "a captcha-like embed on the app's sign-in page can post to its own site" : "...while the same embed on a checkout page cannot",
        got === arrives,
        JSON.stringify(stats.writes),
      );
    }

    console.log("frames: an embed behind a redirect, and one that tries to move the whole page");
    await engine.navigate(`${baseUrl}/frames-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await until(
      "the redirected embed to load",
      async () => {
        const f = frameAs("redirected");
        return !!f && (await f.evaluate(() => typeof (window as unknown as { openPopup?: unknown }).openPopup === "function").catch(() => false));
      },
      8000,
    );
    const afterRedirect: Page[] = [];
    const onRedirectPopup = (p: Page) => afterRedirect.push(p);
    page.context().on("page", onRedirectPopup);
    await frameAs("redirected")!
      .evaluate(() => (window as unknown as { openPopup: () => void }).openPopup())
      .catch(() => {});
    await page.waitForTimeout(1500);
    page.context().off("page", onRedirectPopup);
    check("an embed reached through a redirect is sandboxed too: it cannot open a window", afterRedirect.length === 0, `${afterRedirect.length} popup(s)`);
    await frameAs("redirected")!
      .evaluate(() => (window as unknown as { dataFetch: () => void }).dataFetch())
      .catch(() => {});
    await page.waitForTimeout(1200);
    check(
      "a frame that loads a data: URL in its own place cannot post to its site with Origin: null",
      stats.writes["POST /api/frame-datafetch"] === undefined,
      JSON.stringify(stats.writes),
    );
    const redirectedLoaded = () =>
      until(
        "the redirected embed to load again",
        async () => {
          const f = frameAs("redirected");
          return !!f && (await f.evaluate(() => typeof (window as unknown as { moveTop?: unknown }).moveTop === "function").catch(() => false));
        },
        8000,
      );
    await engine.navigate(`${baseUrl}/frames-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await redirectedLoaded();
    await frameAs("redirected")!
      .evaluate(() => (window as unknown as { dataTopForm: () => void }).dataTopForm())
      .catch(() => {});
    await page.waitForTimeout(1500);
    check(
      "...nor from there aim a form at the top window",
      stats.writes["POST /api/frame-datatop"] === undefined,
      `${page.url()} ${JSON.stringify(stats.writes)}`,
    );
    // A same-document route change on the app page, then the escape: the page still knows what it embeds.
    await engine.navigate(`${baseUrl}/frames-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await until(
      "the redirected embed to load again",
      async () => {
        const f = frameAs("redirected");
        return !!f && (await f.evaluate(() => typeof (window as unknown as { moveTop?: unknown }).moveTop === "function").catch(() => false));
      },
      8000,
    );
    await page.evaluate(() => history.pushState({}, "", location.pathname + location.search + "#step-2"));
    // And a navigation that never commits: the frames stay, and so does what the page knows of them.
    await page.click("#no-content");
    await page.waitForTimeout(500);
    await frameAs("redirected")!
      .evaluate(() => (window as unknown as { moveTop: () => void }).moveTop())
      .catch(() => {});
    await page.waitForTimeout(2500);
    check(
      "...and if it moves the whole page to its own site, that page's writes out never arrive",
      stats.writes["POST /api/frame-popup"] === undefined,
      `${page.url()} ${JSON.stringify(stats.writes)}`,
    );

    console.log("frames: the app's own frame redirecting into another site");
    await engine.navigate(`${baseUrl}/frames-app-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await until(
      "the app frame's redirect target to load",
      async () => {
        const f = frameAs("appredirect");
        return !!f && (await f.evaluate(() => typeof (window as unknown as { openPopup?: unknown }).openPopup === "function").catch(() => false));
      },
      8000,
    );
    const fromAppFrame: Page[] = [];
    const onAppFramePopup = (p: Page) => fromAppFrame.push(p);
    page.context().on("page", onAppFramePopup);
    await frameAs("appredirect")!
      .evaluate(() => (window as unknown as { openPopup: () => void }).openPopup())
      .catch(() => {});
    await page.waitForTimeout(1500);
    page.context().off("page", onAppFramePopup);
    check(
      "a foreign page reached by the app's own frame redirecting is sandboxed: it cannot open a window",
      fromAppFrame.length === 0,
      `${fromAppFrame.length} popup(s)`,
    );

    const popupsAfter = async (as: string, act: () => Promise<unknown>) => {
      const seen: Page[] = [];
      const on = (p: Page) => seen.push(p);
      page.context().on("page", on);
      await act().catch(() => {});
      await page.waitForTimeout(1500);
      page.context().off("page", on);
      return seen.length;
    };
    const loadedAs = (as: string) =>
      until(
        `the frame ${as} to load`,
        async () => {
          const f = frameAs(as);
          return !!f && (await f.evaluate(() => typeof (window as unknown as { openPopup?: unknown }).openPopup === "function").catch(() => false));
        },
        8000,
      );
    await engine.navigate(`${baseUrl}/frames-app-redirect.html?hops=2&foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await loadedAs("appredirect");
    const twoHop = await popupsAfter("appredirect", () => frameAs("appredirect")!.evaluate(() => (window as unknown as { openPopup: () => void }).openPopup()));
    check("...and so is one reached through the app first, then out (two hops)", twoHop === 0, `${twoHop} popup(s)`);

    console.log("frames: a sign-in provider's silent renewal, with a one-time code, into the app's frame");
    await engine.navigate(`${baseUrl}/frames-app-redirect.html?hops=code&foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await loadedAs("cbdone").catch(() => {});
    check(
      "a one-time code redirected into the app's frame is used once, and the frame signs in",
      !!frameAs("cbdone"),
      page
        .frames()
        .map((f) => f.url())
        .join(" | "),
    );

    console.log("frames: in WebKit a data: frame drops the sandbox; moving the page to a site it does not embed");
    await engine.navigate(`${baseUrl}/frames-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await loadedAs("redirected");
    const third = foreignBaseUrl.replace("127.0.0.1", "localhost");
    await frameAs("redirected")!
      .evaluate((t) => (window as unknown as { moveTopThird: (t: string) => void }).moveTopThird(t), third)
      .catch(() => {});
    await page.waitForTimeout(2500);
    check(
      "a frame cannot move the page to a site it does not embed, and nothing is sent from there",
      new URL(page.url()).origin === new URL(baseUrl).origin && stats.writes["POST /api/frame-popup"] === undefined,
      `${page.url()} ${JSON.stringify(stats.writes)}`,
    );

    // The tester's own no-referrer click out, while a foreign frame sits on data:: refused, and said so.
    await engine.navigate(`${baseUrl}/frames-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await loadedAs("redirected");
    await frameAs("redirected")!
      .evaluate(() => (window as unknown as { dataFetch: () => void }).dataFetch())
      .catch(() => {});
    await page.waitForTimeout(800);
    const outSnap = await engine.snapshot(true);
    const outRef = /(e\d+) link "Leave the app"/.exec(outSnap)?.[1];
    const clicked = outRef ? await engine.click(outRef) : `no ref in:\n${outSnap}`;
    check(
      "a no-referrer move out while a foreign frame sits on data: is refused with a WRITE-POLICY notice",
      /WRITE-POLICY blocked/.test(clicked) && /A move of the whole page off the app/.test(clicked),
      clicked,
    );
    check("...and is not also filed as a failed request", !/request_failed/.test(clicked), clicked);

    // The contrast: the app itself set the frame back to about:blank, then the
    // tester follows a no-referrer link out. That is the tester's move, and it goes.
    await engine.navigate(`${baseUrl}/frames-redirect.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    await loadedAs("redirected");
    await page.evaluate(() => {
      (document.getElementById("embed") as HTMLIFrameElement).src = "about:blank";
    });
    await page.waitForTimeout(500);
    await page.evaluate((href) => {
      const a = document.createElement("a");
      a.href = href;
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
    }, `${third}/page2.html`);
    await page.waitForTimeout(1500);
    check(
      "...while a no-referrer link out, after the app set that frame back to about:blank, is followed",
      new URL(page.url()).origin === new URL(third).origin,
      page.url(),
    );

    // The refused top-window navigation leaves the page on the browser's error page: load it again.
    const reload = async () => {
      // A navigation the page started itself (a form post) can still be landing; let it, then go back.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const target = `${baseUrl}/frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`;
      await engine.navigate(target).catch(async (err: unknown) => {
        if (!/interrupted by another navigation/.test(String(err))) throw err;
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await engine.navigate(target);
      });
      await framesLoaded();
    };
    await reload();
    // Its one-fact contrast: the same form to the same place, sent by the app's own page.
    await page.evaluate((url) => (window as unknown as { postOut: (u: string) => void }).postOut(url), `${foreignBaseUrl}/api/frame-top-foreign`);
    await until("the app's own form to the other site to arrive", () => stats.writes["POST /api/frame-top-foreign"] === 1, 5000).catch(() => {});
    await page.waitForURL((u) => u.origin === new URL(foreignBaseUrl).origin, { timeout: 5000 }).catch(() => {});
    check(
      "...while the app's own page posting the same form to that site is the app's behaviour, and arrives",
      stats.writes["POST /api/frame-top-foreign"] === 1,
      JSON.stringify(stats.writes),
    );
    await reload();
    // Last, because it navigates the whole page away.
    await frameAs("same")!.evaluate(() => (window as unknown as Child).postToTop());
    await until("the same-origin frame's top-window form to arrive", () => stats.writes["POST /api/frame-top-same"] === 1, 5000).catch(() => {});
    check("...while the same form in a same-origin frame does", stats.writes["POST /api/frame-top-same"] === 1, JSON.stringify(stats.writes));
  } finally {
    await engine.close().catch(() => {});
  }
}
