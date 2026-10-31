/**
 * The operator's browserHosts list against a real browser (browser-hosts.ts),
 * on the contrastive pair browser-hosts.html and browser-hosts-own.html: the
 * same script, WebSocket and redirect, reached on another host (the fixture
 * server's other port) or on the page's own.
 *
 * - With the list set to the app's host alone, the other host's script,
 *   object and socket, and an image and a worker's request the app's own
 *   address redirects there,
 *   are refused before they leave, and a page load that redirects there
 *   (an attach's start address included) is stopped, reported, and never
 *   arrives. The own-host page loads in full, and its redirect is sent once.
 * - With no list, and with the other host listed, the same page reaches it.
 */
import { BrowserEngine } from "../../dist/engine/browser.js";
import { writeRulesSettings } from "../../dist/engine/project-config.js";
import { check, eventually, WAIT_MS, type SmokeContext } from "./harness.ts";

export const title = "browser hosts";

export async function run({ baseUrl, foreignBaseUrl, projectDir, stats }: SmokeContext): Promise<void> {
  const appHost = new URL(baseUrl).host;
  const otherHost = new URL(foreignBaseUrl).host;
  const loads = (host: string, path: string): number => stats.loads[`GET ${host}${path}`] ?? 0;
  const lineOf = (snap: string, testid: string): string => snap.split("\n").find((l) => l.includes(`[testid=${testid}`)) ?? "";
  const attach = (list: string[] | undefined, url = baseUrl) => {
    const engine = new BrowserEngine();
    const out = engine.attach({ url, projectDir, mode: "observe", writeRules: writeRulesSettings(list ? { browserHosts: list } : {}, {}, false) });
    return { engine, out };
  };
  /** The page once its script and socket have both settled. */
  const settled = async (engine: InstanceType<typeof BrowserEngine>, page: string): Promise<{ out: string; snap: string }> => {
    const out = await engine.navigate(page);
    let snap = "";
    const done = await eventually(
      async () => {
        snap = await engine.snapshot(true);
        return ["script-state", "socket-state", "hop-state"].every((id) => !lineOf(snap, id).includes("pending"));
      },
      WAIT_MS,
      100,
    );
    if (!done) throw new Error(`browser-hosts fixture never settled:\n${snap}`);
    return { out, snap };
  };
  if (new URL(foreignBaseUrl).hostname !== "127.0.0.1") throw new Error(`browser-hosts.html reaches only 127.0.0.1, not ${foreignBaseUrl}`);
  const offPage = `/browser-hosts.html?otherPort=${new URL(foreignBaseUrl).port}`;

  console.log("browserHosts set to the app's host alone: another host is refused, the app's own is not");
  {
    const { engine, out } = attach([]);
    try {
      const attached = await out;
      check("the attach names the list", attached.includes("Browser hosts (the SceneScout config): the page may reach only the app's own host;"), attached);
      const scriptsBefore = loads(otherHost, "/browser-hosts.js");
      const hopsBefore = loads(otherHost, "/browser-hosts-landed");
      const off = await settled(engine, offPage);
      // The worker's request is not on the page: given time to arrive, if it were going to.
      await new Promise((r) => setTimeout(r, 300));
      check("another host's script is refused", lineOf(off.snap, "script-state").includes("script: failed"), off.snap);
      check("...and never arrives, nor does an object's load of it", loads(otherHost, "/browser-hosts.js") === scriptsBefore, JSON.stringify(stats.loads));
      check(
        "an image or a worker's request the app's own address redirects to another host never reaches it",
        loads(otherHost, "/browser-hosts-landed") === hopsBefore,
        JSON.stringify(stats.loads),
      );
      check("another host's WebSocket is closed before it connects", lineOf(off.snap, "socket-state").includes("closed 1008"), off.snap);
      check("a page cannot open a peer connection, which no route handler sees", lineOf(off.snap, "peer-state").includes("unavailable"), off.snap);
      const notice = off.out + (await engine.navigate(offPage));
      check(
        "the refusals are reported as the operator's setting, by host and path",
        notice.includes("BROWSER-HOSTS blocked") &&
          notice.includes(`${foreignBaseUrl}/browser-hosts.js`) &&
          notice.includes("NOT an app bug") &&
          // Chromium names the hop; Firefox and WebKit, whose own policy refused it, name the app's address it started at.
          (notice.includes(`${foreignBaseUrl}/browser-hosts-landed (a redirect)`) ||
            notice.includes("/browser-hosts-redirect (redirected to a host off the list)")),
        notice.slice(0, 1500),
      );

      const redirectsBefore = loads(appHost, "/browser-hosts-redirect");
      const landedBefore = loads(otherHost, "/browser-hosts-landed");
      const away = await engine.navigate(`/browser-hosts-redirect?to=${encodeURIComponent(foreignBaseUrl)}`).catch((err: unknown) => String(err));
      check(
        "a page load that redirects to another host never reaches it",
        loads(otherHost, "/browser-hosts-landed") === landedBefore,
        JSON.stringify(stats.loads),
      );
      check("...the app's redirect itself is asked once", loads(appHost, "/browser-hosts-redirect") === redirectsBefore + 1, JSON.stringify(stats.loads));
      const snap = await engine.snapshot(true);
      check(
        "...the page is not left on the other host",
        !snap.includes("data-testid=landed") && !lineOf(snap, "landed").includes("landed"),
        snap.slice(0, 800),
      );
      check(
        "...and the result says the redirect was refused, naming where it went",
        away.startsWith("NOT NAVIGATED") &&
          away.includes("BROWSER-HOSTS blocked") &&
          away.includes(`navigation to ${foreignBaseUrl}/browser-hosts-landed (a redirect`),
        away.slice(0, 1500),
      );

      const own = await settled(engine, "/browser-hosts-own.html");
      check("the app's own script loads", lineOf(own.snap, "script-state").includes("script: loaded"), own.snap);
      check("the app's own WebSocket is not refused", !lineOf(own.snap, "socket-state").includes("1008"), own.snap);
      const ownRedirects = loads(appHost, "/browser-hosts-redirect");
      const ownLanded = loads(appHost, "/browser-hosts-landed");
      await engine.navigate(`/browser-hosts-redirect?to=${encodeURIComponent(baseUrl)}`);
      const landedSnap = await engine.snapshot(true);
      check("a redirect within the app's host lands", lineOf(landedSnap, "landed").includes("landed"), landedSnap.slice(0, 800));
      check(
        "...with the redirect and the page it lands on each asked once",
        loads(appHost, "/browser-hosts-redirect") === ownRedirects + 1 && loads(appHost, "/browser-hosts-landed") === ownLanded + 1,
        JSON.stringify(stats.loads),
      );
    } finally {
      await engine.close().catch(() => {});
    }
  }

  console.log("browserHosts: an attach whose start address redirects to another host is stopped there");
  {
    const landedBefore = loads(otherHost, "/browser-hosts-landed");
    const { engine, out } = attach([], `${baseUrl}/browser-hosts-redirect?to=${encodeURIComponent(foreignBaseUrl)}`);
    try {
      const attached = await out.catch((err: unknown) => String(err));
      check(
        "the start address's redirect never reaches the other host",
        loads(otherHost, "/browser-hosts-landed") === landedBefore,
        JSON.stringify(stats.loads),
      );
      check(
        "...and the attach says so plainly, naming the host it led to",
        attached.includes(`Not attached: the start address leads off the app's host (navigation to ${foreignBaseUrl}/browser-hosts-landed (a redirect`),
        attached.slice(0, 1500),
      );
    } finally {
      await engine.close().catch(() => {});
    }
  }

  for (const [label, list] of [
    ["no browserHosts list", undefined],
    ["browserHosts listing the other host", [otherHost]],
  ] as const) {
    console.log(`${label}: the same page reaches the other host`);
    const { engine, out } = attach(list ? [...list] : undefined);
    try {
      await out;
      const hopsBefore = loads(otherHost, "/browser-hosts-landed");
      const off = await settled(engine, offPage);
      check(
        `${label}: an image the app redirects to the other host reaches it`,
        await eventually(async () => loads(otherHost, "/browser-hosts-landed") > hopsBefore, WAIT_MS, 100),
        JSON.stringify(stats.loads),
      );
      check(`${label}: the other host's script loads`, lineOf(off.snap, "script-state").includes("script: loaded"), off.snap);
      check(`${label}: its WebSocket is not refused`, !lineOf(off.snap, "socket-state").includes("1008"), off.snap);
      if (!list) check(`${label}: peer connections are left alone`, lineOf(off.snap, "peer-state").includes("peer connections: available"), off.snap);
      const landedBefore = loads(otherHost, "/browser-hosts-landed");
      await engine.navigate(`/browser-hosts-redirect?to=${encodeURIComponent(foreignBaseUrl)}`);
      check(`${label}: a redirect to the other host lands there`, loads(otherHost, "/browser-hosts-landed") === landedBefore + 1, JSON.stringify(stats.loads));
    } finally {
      await engine.close().catch(() => {});
    }
  }
}
