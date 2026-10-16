/**
 * The run-status pane's page: the `ui://` resource an MCP Apps host renders
 * in a sandboxed iframe (SEP-1865, specification 2026-01-26).
 *
 * It speaks the extension's JSON-RPC over postMessage itself rather than
 * bundling the ext-apps SDK, so it is one string with no external asset and
 * the resource declares no outside origin: the host's restrictive default CSP
 * applies. The handshake is the one the SDK's App.connect sends:
 * `ui/initialize` with appInfo, appCapabilities and protocolVersion, then
 * `ui/notifications/initialized`. Data comes from `tools/call` on the app-only
 * poll tool every STATUS_POLL_MS, as the system-monitor example polls its own.
 *
 * Everything shown is untrusted (session names, tasks and objectives come from
 * the agent, URLs from the app under test), so the script sets text with
 * textContent and never builds markup from data. It accepts messages only from
 * its parent window. Like live-page.ts, the client script avoids template
 * literals because the page is one; status-pane tests check the script parses.
 *
 * In a guided check it also draws the progress (progress.ts): the narrator's
 * line and the few before it, each area, pages, time, problems by impact, the
 * newest cards with their buttons, the clicking saved with its basis, and the
 * buttons to offer now. A button calls one of three tools directly
 * (scout_cards, scout_feedback, scout_guided_confirm) or, where the host takes
 * a message from the view (`ui/message`), sends the fixed words a prompt
 * button carries; where it does not, the pane shows those words to say.
 */
import { scriptLiteral } from "./script-literal.js";
import { ACTION_LABEL, PANE_WORDS } from "./guided-words.js";
import { MCP_APPS_PROTOCOL, STATUS_POLL_MS, STATUS_POLL_TOOL } from "./status-pane.js";

export function statusPanePage(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>SceneScout run</title>
<style>
  /* The host may set any of these (the spec's standard variables); each has a default for one that does not. */
  :root {
    color-scheme: light dark;
    --color-background-primary: light-dark(#ffffff, #171a1f);
    --color-background-secondary: light-dark(#f5f6f8, #1f232a);
    --color-text-primary: light-dark(#15181d, #e8ebef);
    --color-text-secondary: light-dark(#5b6472, #9aa3b1);
    --color-text-danger: light-dark(#b42318, #ff8a80);
    --color-text-warning: light-dark(#9a5b00, #f5c065);
    --color-text-info: light-dark(#1f5fbf, #8ab4ff);
    --color-text-success: light-dark(#18794e, #6fd3a2);
    --color-border-primary: light-dark(#d8dce2, #343a44);
    --color-ring-primary: light-dark(#2563eb, #7aa2ff);
    --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    --font-text-sm-size: 13px;
    --font-text-md-size: 14px;
    --border-radius-sm: 6px;
    --border-radius-md: 8px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--color-background-primary); color: var(--color-text-primary);
    font: var(--font-text-md-size)/1.45 var(--font-sans);
    overflow-wrap: anywhere;
  }
  main { padding: 12px; display: grid; gap: 12px; max-width: 760px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  h1 { margin: 0; font-size: 15px; font-weight: 650; flex: 1 1 auto; }
  h2 { margin: 0 0 6px; font-size: var(--font-text-sm-size); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: .04em; }
  .status { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: var(--font-text-sm-size); font-variant-numeric: tabular-nums; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-secondary); flex: none; }
  .dot.on { background: var(--color-text-success); }
  .dot.err { background: var(--color-text-danger); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  button {
    font: inherit; font-size: var(--font-text-sm-size); color: var(--color-text-primary);
    background: var(--color-background-secondary); border: 1px solid var(--color-border-primary);
    border-radius: var(--border-radius-sm); padding: 4px 10px; cursor: pointer;
  }
  button:hover { border-color: var(--color-ring-primary); }
  button:focus-visible { outline: 2px solid var(--color-ring-primary); outline-offset: 1px; }
  button[disabled] { opacity: .55; cursor: default; }
  .live { display: grid; gap: 4px; }
  .url { font: 12px/1.4 var(--font-mono); color: var(--color-text-secondary); user-select: all; }
  .note { margin: 0; color: var(--color-text-secondary); font-size: var(--font-text-sm-size); }
  section { background: var(--color-background-secondary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 10px 12px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(60px, 1fr)); gap: 8px; }
  .tile { display: grid; gap: 2px; }
  .tile b { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .tile span { font-size: var(--font-text-sm-size); color: var(--color-text-secondary); }
  .tile.high b { color: var(--color-text-danger); }
  .tile.medium b { color: var(--color-text-warning); }
  .tile.low b { color: var(--color-text-info); }
  .sub { margin: 8px 0 0; font-size: var(--font-text-sm-size); color: var(--color-text-secondary); }
  .bar { height: 6px; border-radius: 3px; background: var(--color-border-primary); overflow: hidden; margin: 4px 0 6px; }
  .bar i { display: block; height: 100%; background: var(--color-ring-primary); width: 0; }
  ul.sessions { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  ul.sessions li { display: grid; gap: 2px; padding-top: 8px; border-top: 1px solid var(--color-border-primary); }
  ul.sessions li:first-child { border-top: 0; padding-top: 0; }
  .who { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .who strong { font-weight: 600; }
  .state { font-size: 12px; padding: 0 6px; border-radius: 999px; border: 1px solid currentColor; }
  .state.running { color: var(--color-text-warning); }
  .state.idle { color: var(--color-text-secondary); }
  .state.stuck { color: var(--color-text-danger); }
  .line { font-size: var(--font-text-sm-size); color: var(--color-text-secondary); }
  .line em { font-style: normal; color: var(--color-text-primary); }
  .page { font: 12px/1.4 var(--font-mono); color: var(--color-text-secondary); }
  h2.g-title { text-transform: none; letter-spacing: 0; font-size: var(--font-text-md-size); }
  .now { margin: 0; font-size: 15px; font-weight: 600; }
  ol.story { margin: 4px 0 0; padding-left: 18px; font-size: var(--font-text-sm-size); color: var(--color-text-secondary); }
  ul.areas, ul.cards { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
  .mark { display: inline-block; min-width: 64px; font-size: 12px; color: var(--color-text-secondary); }
  .mark.in-progress { color: var(--color-text-warning); }
  .mark.done { color: var(--color-text-success); }
  ul.cards li { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid var(--color-border-primary); }
  ul.cards li:first-child { border-top: 0; padding-top: 0; }
  .impact { font-size: 12px; font-weight: 650; }
  .impact.high { color: var(--color-text-danger); }
  .impact.medium { color: var(--color-text-warning); }
  .impact.low { color: var(--color-text-info); }
  .needs { border-color: var(--color-text-warning); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main id="main" data-testid="status-pane">
  <header>
    <h1>SceneScout run</h1>
    <span class="status" role="status" aria-live="polite"><span id="dot" class="dot"></span><span id="status-text" data-testid="status-pane-updated">Connecting…</span></span>
    <div class="actions">
      <button type="button" id="open-live" data-testid="status-pane-live-open" disabled>Open live view</button>
      <button type="button" id="toggle" data-testid="status-pane-poll-toggle" aria-pressed="false">Pause</button>
    </div>
  </header>
  <div class="live">
    <code id="live-url" class="url" data-testid="status-pane-live-url" hidden></code>
    <p id="live-note" class="note" data-testid="status-pane-live-note" hidden></p>
  </div>
  <section id="guided" aria-labelledby="g-title" data-testid="status-pane-guided" hidden>
    <h2 id="g-title" class="g-title"></h2>
    <p id="g-now" class="now" aria-live="polite"></p>
    <ol id="g-story" class="story"></ol>
    <div id="g-needs" class="note" hidden></div>
    <ul id="g-areas" class="areas"></ul>
    <p class="sub"><span id="g-pages"></span> · <span id="g-time"></span></p>
    <div class="tiles">
      <div class="tile high"><b id="g-blocks">0</b><span>block users</span></div>
      <div class="tile medium"><b id="g-annoying">0</b><span>annoying</span></div>
      <div class="tile low"><b id="g-cosmetic">0</b><span>cosmetic</span></div>
    </div>
    <h2 id="g-cards-h">${PANE_WORDS.newest}</h2>
    <ul id="g-cards" class="cards"></ul>
    <p id="g-saved" class="sub" hidden></p>
    <div id="g-next" class="actions"></div>
    <p id="g-hint" class="note" data-testid="status-pane-guided-hint" hidden></p>
  </section>
  <section aria-labelledby="findings-h" data-testid="status-pane-findings">
    <h2 id="findings-h">Open findings</h2>
    <div class="tiles">
      <div class="tile high"><b id="f-high">–</b><span>high</span></div>
      <div class="tile medium"><b id="f-medium">–</b><span>medium</span></div>
      <div class="tile low"><b id="f-low">–</b><span>low</span></div>
      <div class="tile"><b id="f-open">–</b><span>open</span></div>
    </div>
    <p id="f-sub" class="sub">No session has attached yet.</p>
  </section>
  <section aria-labelledby="coverage-h" data-testid="status-pane-coverage">
    <h2 id="coverage-h">Coverage</h2>
    <div id="routes" hidden>
      <div class="line">Routes <em id="c-routes"></em></div>
      <div class="bar" role="img" id="c-bar-wrap"><i id="c-bar"></i></div>
    </div>
    <div id="c-line" class="line">Nothing measured yet.</div>
  </section>
  <section aria-labelledby="sessions-h" data-testid="status-pane-sessions">
    <h2 id="sessions-h">Sessions</h2>
    <ul id="sessions" class="sessions"></ul>
    <p id="no-sessions" class="note">No session is attached.</p>
  </section>
</main>
<script>
(function () {
  "use strict";
  var POLL_TOOL = ${scriptLiteral(STATUS_POLL_TOOL)};
  var POLL_MS = ${STATUS_POLL_MS};
  var PROTOCOL = ${scriptLiteral(MCP_APPS_PROTOCOL)};
  var VERSION = ${scriptLiteral(version)};
  var REQUEST_MS = 10000;

  var nextId = 1;
  var pending = {};
  var connected = false;
  var paused = false;
  var timer = null;
  var inFlight = false;
  var liveUrl = null;
  var canOpenLinks = false;
  var canSendMessages = false;
  var showingAll = false;
  // The only tools a button may call directly; anything else in the data is ignored.
  var DIRECT_TOOLS = ["scout_cards", "scout_feedback", "scout_guided_confirm"];
  var NEWEST_HEADING = ${scriptLiteral(PANE_WORDS.newest)};
  var ALL_HEADING = ${scriptLiteral(PANE_WORDS.all)};
  var NEWEST_LABEL = ${scriptLiteral(PANE_WORDS.backToNewest)};
  var SAY_THIS = ${scriptLiteral(PANE_WORDS.sayThis)};
  var NEEDS_YOU = ${scriptLiteral(PANE_WORDS.needsYou)};
  var NOT_A_BUG = ${scriptLiteral(ACTION_LABEL.notABug)};
  var openHint = "";
  var observer = null;

  function el(id) { return document.getElementById(id); }

  // The view cannot know its host's origin, so it posts to its parent with "*",
  // as the spec's own example and the SDK's transport do. Only the parent can
  // receive it, and every message the view sends carries data the host gave it.
  function post(message) { window.parent.postMessage(message, "*"); }

  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () {
        delete pending[id];
        reject(new Error(method + " got no answer"));
      }, REQUEST_MS);
      pending[id] = { resolve: resolve, reject: reject, timeout: timeout };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }

  function notify(method, params) {
    var message = { jsonrpc: "2.0", method: method };
    if (params !== undefined) message.params = params;
    post(message);
  }

  function reply(id, result) { post({ jsonrpc: "2.0", id: id, result: result }); }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || window.parent === window) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined && m.id !== null) {
      var waiting = pending[m.id];
      if (!waiting) return;
      delete pending[m.id];
      clearTimeout(waiting.timeout);
      if (m.error) waiting.reject(new Error(m.error.message || "request failed"));
      else waiting.resolve(m.result);
      return;
    }
    if (typeof m.method !== "string") return;
    if (m.id !== undefined && m.id !== null) {
      if (m.method === "ui/resource-teardown") { tearDown(); reply(m.id, {}); return; }
      if (m.method === "ping") { reply(m.id, {}); return; }
      post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (m.method === "ui/notifications/tool-result") {
      var data = m.params && m.params.structuredContent;
      if (data && typeof data === "object") render(data);
    } else if (m.method === "ui/notifications/host-context-changed") {
      applyContext(m.params || {});
    }
  });

  function applyContext(ctx) {
    var root = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") {
      root.setAttribute("data-theme", ctx.theme);
      root.style.colorScheme = ctx.theme;
    }
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") {
      Object.keys(vars).forEach(function (key) {
        if (key.indexOf("--") === 0 && typeof vars[key] === "string") root.style.setProperty(key, vars[key]);
      });
    }
    var inset = ctx.safeAreaInsets;
    if (inset) {
      var main = el("main");
      main.style.paddingTop = (12 + (inset.top || 0)) + "px";
      main.style.paddingRight = (12 + (inset.right || 0)) + "px";
      main.style.paddingBottom = (12 + (inset.bottom || 0)) + "px";
      main.style.paddingLeft = (12 + (inset.left || 0)) + "px";
    }
  }

  // Report the content's size so a host with a flexible container can fit it, as the SDK's autoResize does.
  function watchSize() {
    var lastW = 0, lastH = 0, scheduled = false;
    function send() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        var html = document.documentElement;
        var before = html.style.height;
        html.style.height = "max-content";
        var h = Math.ceil(html.getBoundingClientRect().height);
        html.style.height = before;
        var w = Math.ceil(window.innerWidth);
        if (w !== lastW || h !== lastH) {
          lastW = w; lastH = h;
          notify("ui/notifications/size-changed", { width: w, height: h });
        }
      });
    }
    send();
    observer = new ResizeObserver(send);
    observer.observe(document.documentElement);
    observer.observe(document.body);
  }

  function setStatus(text, state) {
    el("status-text").textContent = text;
    el("dot").className = "dot" + (state ? " " + state : "");
  }

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return (n < 10 ? "0" : "") + n; }).join(":");
  }

  function duration(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return total + "s";
    var minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + "m" + (total % 60 < 10 ? "0" : "") + (total % 60) + "s";
    return Math.floor(minutes / 60) + "h" + (minutes % 60 < 10 ? "0" : "") + (minutes % 60) + "m";
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function render(data) {
    liveUrl = typeof data.liveUrl === "string" ? data.liveUrl : null;
    el("live-url").textContent = liveUrl || "";
    el("live-url").hidden = !liveUrl;
    el("live-note").textContent = data.liveNote || (liveUrl ? openHint : "");
    el("live-note").hidden = !el("live-note").textContent;
    el("open-live").disabled = !liveUrl;

    var f = data.findings;
    ["high", "medium", "low", "open"].forEach(function (k) { el("f-" + k).textContent = f ? String(f[k]) : "–"; });
    if (f) {
      var parts = [f.thisRun + " filed this run"];
      if (f.worthALook) parts.push(f.worthALook + " worth a look");
      if (f.resolved) parts.push(f.resolved + " resolved");
      el("f-sub").textContent = parts.join(" · ");
    } else {
      el("f-sub").textContent = "No session has attached yet.";
    }

    var c = data.coverage;
    el("routes").hidden = !(c && c.routesTotal > 0);
    if (c && c.routesTotal > 0) {
      el("c-routes").textContent = c.routesVisited + " of " + c.routesTotal;
      var pct = Math.round((100 * c.routesVisited) / c.routesTotal);
      el("c-bar").style.width = Math.min(100, Math.max(0, pct)) + "%";
      el("c-bar-wrap").setAttribute("aria-label", pct + "% of known routes visited");
    }
    el("c-line").textContent = c
      ? plural(c.states, "state") + " explored · " + c.elementsExercised + " of " + c.elementsTotal + " elements exercised"
      : "Nothing measured yet.";

    var list = el("sessions");
    while (list.firstChild) list.removeChild(list.firstChild);
    var sessions = Array.isArray(data.sessions) ? data.sessions : [];
    el("no-sessions").hidden = sessions.length > 0;
    sessions.forEach(function (s) {
      var li = document.createElement("li");
      li.setAttribute("data-testid", "status-pane-session");
      var who = document.createElement("div");
      who.className = "who";
      var name = document.createElement("strong");
      name.textContent = s.session;
      var role = document.createElement("span");
      role.className = "line";
      role.textContent = s.role;
      var state = document.createElement("span");
      state.className = "state " + (s.state === "running" || s.state === "stuck" ? s.state : "idle");
      state.textContent = s.state === "idle" ? "idle " + duration(s.forMs) : s.state + " " + duration(s.forMs);
      who.appendChild(name); who.appendChild(role); who.appendChild(state);
      li.appendChild(who);
      li.appendChild(labelled(s.state === "idle" ? "Last tool" : "Tool", s.tool));
      if (s.task) li.appendChild(labelled("Task", s.task));
      if (s.objective) li.appendChild(labelled("Objective", s.objective));
      if (s.url) {
        var page = document.createElement("div");
        page.className = "page";
        page.textContent = s.url;
        li.appendChild(page);
      }
      list.appendChild(li);
    });
    renderGuided(data.guided);
    if (data.at) setStatus(paused ? "Paused" : "Updated " + clock(data.at), paused ? "" : "on");
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function slug(text) { return String(text).toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, ""); }

  // A guided check's progress: every word in it was chosen by the server from fixed sentences, and is set as text.
  function renderGuided(g) {
    el("guided").hidden = !g;
    if (!g) return;
    el("g-title").textContent = g.title;
    el("g-now").textContent = "Now: " + g.now;
    var story = el("g-story");
    clear(story);
    // The story's last entry is the "now" line while the check runs; once it has ended, every entry is a step taken.
    var all = Array.isArray(g.story) ? g.story : [];
    var before = all.length > 0 && all[all.length - 1] === g.now ? all.slice(0, -1) : all;
    before.forEach(function (line) {
      var li = document.createElement("li");
      li.textContent = line;
      story.appendChild(li);
    });
    var needs = el("g-needs");
    needs.hidden = !g.needsYou;
    needs.textContent = g.needsYou ? NEEDS_YOU + " " + g.needsYou.sentence : "";
    var areas = el("g-areas");
    clear(areas);
    (Array.isArray(g.areas) ? g.areas : []).forEach(function (a) {
      var li = document.createElement("li");
      li.setAttribute("data-testid", "status-pane-guided-area");
      var mark = document.createElement("span");
      mark.className = "mark " + a.state;
      mark.textContent = a.state === "in-progress" ? "checking" : a.state;
      li.appendChild(mark);
      li.appendChild(document.createTextNode(a.label + (a.note ? " - " + a.note : "")));
      areas.appendChild(li);
    });
    el("g-pages").textContent = "Pages checked: " + g.pages.checked + " of " + g.pages.found;
    el("g-time").textContent = "Time: " + Math.floor(g.time.usedMs / 60000) + "m of " + Math.floor(g.time.budgetMs / 60000) + "m";
    el("g-blocks").textContent = String(g.problems.blocksUsers);
    el("g-annoying").textContent = String(g.problems.annoying);
    el("g-cosmetic").textContent = String(g.problems.cosmetic);
    if (!showingAll) renderCards(Array.isArray(g.latest) ? g.latest : [], NEWEST_HEADING);
    el("g-saved").hidden = !g.saved;
    el("g-saved").textContent = g.saved ? g.saved.sentence : "";
    var next = el("g-next");
    clear(next);
    (Array.isArray(g.next) ? g.next : []).forEach(function (action) {
      // While every card is shown, the same button goes back to the newest.
      var shown = showingAll && action.tool === "scout_cards" ? { kind: "direct", label: NEWEST_LABEL, tool: "scout_cards", args: {} } : action;
      next.appendChild(actionButton(shown, "status-pane-action-"));
    });
  }

  function renderCards(cards, heading) {
    el("g-cards-h").textContent = heading;
    var list = el("g-cards");
    clear(list);
    cards.forEach(function (card) {
      var li = document.createElement("li");
      li.setAttribute("data-testid", "status-pane-guided-card");
      var impact = document.createElement("span");
      impact.className = "impact " + (card.severity === "high" || card.severity === "medium" || card.severity === "low" ? card.severity : "");
      impact.textContent = card.impact;
      var title = document.createElement("strong");
      title.textContent = " " + card.title;
      var head = document.createElement("div");
      head.appendChild(impact);
      head.appendChild(title);
      li.appendChild(head);
      li.appendChild(labelled("What kind of problem", card.problem + " - on " + card.page));
      li.appendChild(labelled("What happened", card.happened));
      var buttons = document.createElement("div");
      buttons.className = "actions";
      (Array.isArray(card.actions) ? card.actions : defaultCardActions(card.id)).forEach(function (action) {
        buttons.appendChild(actionButton(action, "status-pane-card-"));
      });
      li.appendChild(buttons);
      list.appendChild(li);
    });
  }

  // Cards from scout_cards carry no buttons of their own: only "Not a bug", which needs no words from the agent.
  function defaultCardActions(id) {
    return [{ kind: "direct", label: NOT_A_BUG, tool: "scout_feedback", args: { id: id, verdict: "not-a-bug" } }];
  }

  function actionButton(action, prefix) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.setAttribute("data-testid", prefix + slug(action.label));
    b.addEventListener("click", function () { runAction(action, b); });
    return b;
  }

  function hint(text) {
    el("g-hint").textContent = text;
    el("g-hint").hidden = !text;
  }

  function runAction(action, button) {
    if (action.kind === "prompt" && typeof action.text === "string") {
      if (!canSendMessages) { hint(SAY_THIS + " " + action.text); return; }
      button.disabled = true;
      request("ui/message", { role: "user", content: [{ type: "text", text: action.text }] })
        .then(function (r) { if (r && r.isError) hint(SAY_THIS + " " + action.text); else hint(""); },
              function () { hint(SAY_THIS + " " + action.text); })
        .then(function () { button.disabled = false; });
      return;
    }
    if (action.kind !== "direct" || DIRECT_TOOLS.indexOf(action.tool) < 0) return;
    if (showingAll && action.tool === "scout_cards") { showingAll = false; poll(); return; }
    button.disabled = true;
    request("tools/call", { name: action.tool, arguments: action.args || {} })
      .then(function (result) {
        if (result && result.isError) throw new Error("the server refused it");
        if (action.tool === "scout_cards" && result && result.structuredContent && Array.isArray(result.structuredContent.cards)) {
          showingAll = true;
          renderCards(result.structuredContent.cards, ALL_HEADING);
        }
        hint("");
        // A label changes which cards are shown: while every card is on show, fetch them again.
        if (showingAll && action.tool === "scout_feedback")
          request("tools/call", { name: "scout_cards", arguments: {} }).then(function (r) {
            if (r && !r.isError && r.structuredContent && Array.isArray(r.structuredContent.cards)) renderCards(r.structuredContent.cards, ALL_HEADING);
          }, function (err) { hint("That did not work: " + (err && err.message ? err.message : String(err))); });
        poll();
      })
      .catch(function (err) { hint("That did not work: " + (err && err.message ? err.message : String(err))); })
      .then(function () { button.disabled = false; });
  }

  function labelled(label, value) {
    var line = document.createElement("div");
    line.className = "line";
    line.appendChild(document.createTextNode(label + ": "));
    var v = document.createElement("em");
    v.textContent = value;
    line.appendChild(v);
    return line;
  }

  function poll() {
    if (!connected || paused || inFlight || document.visibilityState === "hidden") return;
    inFlight = true;
    request("tools/call", { name: POLL_TOOL, arguments: {} })
      .then(function (result) {
        if (result && result.isError) throw new Error("the server could not report the run");
        if (result && result.structuredContent) render(result.structuredContent);
      })
      .catch(function (err) {
        if (paused) return;
        setStatus("Could not update: " + (err && err.message ? err.message : String(err)), "err");
      })
      .then(function () { inFlight = false; });
  }

  function start() {
    if (timer !== null) return;
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  // The host is about to remove the view: stop everything, and never start again.
  function tearDown() {
    connected = false;
    stop();
    if (observer) observer.disconnect();
    Object.keys(pending).forEach(function (id) { clearTimeout(pending[id].timeout); delete pending[id]; });
  }

  el("toggle").addEventListener("click", function () {
    paused = !paused;
    el("toggle").textContent = paused ? "Resume" : "Pause";
    el("toggle").setAttribute("aria-pressed", paused ? "true" : "false");
    if (paused) { stop(); setStatus("Paused", ""); } else if (connected) start();
  });

  el("open-live").addEventListener("click", function () {
    if (!liveUrl) return;
    var url = liveUrl;
    var fallback = function () {
      // A sandbox may block new windows; window.open with noopener returns null either way, so say how to open it by hand.
      window.open(url, "_blank", "noopener");
      openHint = "If no tab opened, copy the address above into your browser.";
      el("live-note").textContent = openHint;
      el("live-note").hidden = false;
    };
    if (canOpenLinks) request("ui/open-link", { url: url }).then(function (r) { if (r && r.isError) fallback(); }, fallback);
    else fallback();
  });

  if (window.parent === window) {
    setStatus("Open this pane through an MCP host: it reads the run through scout_status.", "err");
    return;
  }

  request("ui/initialize", {
    appInfo: { name: "SceneScout status", version: VERSION },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: PROTOCOL,
  })
    .then(function (result) {
      result = result || {};
      applyContext(result.hostContext || {});
      canOpenLinks = !!(result.hostCapabilities && result.hostCapabilities.openLinks);
      // A host that can take a message from the view lets a card's "Explain more" start a turn; otherwise the pane shows the words to say.
      canSendMessages = !!(result.hostCapabilities && result.hostCapabilities.message);
      notify("ui/notifications/initialized");
      connected = true;
      watchSize();
      setStatus("Connected", "on");
      start();
    })
    .catch(function (err) {
      setStatus("Not connected: " + (err && err.message ? err.message : String(err)), "err");
    });
})();
</script>
</body>
</html>
`;
}
