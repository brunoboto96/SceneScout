/**
 * The live view's single page. It is served as one string with no external
 * assets, so it works offline and the Content-Security-Policy can forbid
 * everything but itself.
 *
 * Everything shown here is untrusted: URLs, element names and the report's
 * text come from the app under test, session names, tasks and objectives from
 * the agent. The script sets them all with textContent and never builds markup
 * from them. The client script avoids template literals, but because the whole
 * page is one, a backtick inside it is written \` and a backslash \\ (the
 * regexes in renderMarkdown), and live-test checks that the script still parses.
 */
export const LIVE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SceneScout live</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #ffffff; --line: #d9dde3; --text: #15181d; --muted: #5d6673;
    --run: #b45309; --run-bg: #fef3c7; --idle: #475569; --idle-bg: #e8ebf0; --stuck: #b91c1c; --stuck-bg: #fee2e2;
    --accent: #2563eb; --shade: #0b0d10;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --panel: #161a21; --line: #2a303a; --text: #e6e9ee; --muted: #98a2b3;
      --run: #fbbf24; --run-bg: #3a2a08; --idle: #a3adba; --idle-bg: #222831; --stuck: #fca5a5; --stuck-bg: #3f1518;
      --accent: #7aa2ff; --shade: #000000;
    }
  }
  * { box-sizing: border-box; }
  ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .feed, .brief, #report { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .badge, .meta, .feed .t, .since, #focus .bar .line { font-variant-numeric: tabular-nums; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
    padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: 16px; font-weight: 650; }
  .meta { color: var(--muted); font-size: 13px; }
  .spacer { flex: 1 1 auto; }
  .actions { display: flex; gap: 8px; flex: 0 0 auto; }
  button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button:focus-visible, .shot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  #banner { display: none; margin: 12px 16px 0; padding: 8px 12px; border-radius: 6px; background: var(--stuck-bg); color: var(--stuck); }
  #empty { display: none; padding: 48px 16px; text-align: center; color: var(--muted); }
  #finished { display: none; max-width: 640px; margin: 48px auto; padding: 24px; text-align: center;
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
  #finished.open { display: block; }
  #finished h2 { margin: 0 0 8px; font-size: 18px; }
  #finished p { margin: 0 0 8px; color: var(--muted); }
  #finished .where { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  #finished button { margin-top: 8px; padding: 7px 14px; font-weight: 600; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 12px; padding: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .card.stuck { border-color: var(--stuck); }
  .top { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
  .name { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .role { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .badge { margin-left: auto; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .badge.running { color: var(--run); background: var(--run-bg); }
  .badge.idle { color: var(--idle); background: var(--idle-bg); }
  .badge.stuck { color: var(--stuck); background: var(--stuck-bg); }
  .line { padding: 0 12px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line b { color: var(--text); font-weight: 600; }
  .shot { position: relative; margin: 8px 12px 0; aspect-ratio: 64 / 45; background: var(--shade); border-radius: 6px; overflow: hidden;
    cursor: zoom-in; border: 0; padding: 0; display: block; width: calc(100% - 24px); }
  .shot img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .shot .tag { position: absolute; top: 6px; left: 6px; font-size: 11px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px;
    border-radius: 4px; background: var(--stuck); color: #fff; display: none; }
  .shot.live .tag { display: block; }
  .shot .none { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 12px;
    color: #98a2b3; font-size: 12px; text-align: center; }
  .shot.empty .none { display: flex; }
  .shot.empty img { visibility: hidden; }
  .feed { margin: 8px 12px 0; padding: 6px 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-height: 108px; overflow-y: auto; overscroll-behavior: contain; }
  .feed .row { display: flex; gap: 6px; white-space: nowrap; }
  /* Consecutive actions of one journey share a tint, so where one goal ends and the next begins is visible in the log. */
  .feed .group { border-left: 1px solid transparent; padding-left: 5px; margin-left: -6px; border-radius: 3px; }
  .feed .g0 { background: rgba(96, 165, 250, .13); border-color: rgba(96, 165, 250, .7); }
  .feed .g1 { background: rgba(52, 211, 153, .13); border-color: rgba(52, 211, 153, .7); }
  .feed .g2 { background: rgba(251, 191, 36, .13); border-color: rgba(251, 191, 36, .7); }
  .feed .g3 { background: rgba(244, 114, 182, .13); border-color: rgba(244, 114, 182, .7); }
  #focus .feed .group:hover { outline: 1px solid rgba(230, 233, 238, .35); }
  .feed .t { color: var(--muted); flex: 0 0 auto; }
  .feed .a { color: var(--text); font-weight: 600; flex: 0 0 auto; }
  .feed .d { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
  .feed .bad { color: var(--stuck); }
  .feed .none { color: var(--muted); }
  #focus .lower { display: flex; gap: 10px; flex: 0 0 auto; height: 30vh; min-height: 140px; }
  #focus .feed { margin: 0; max-height: none; flex: 2 1 0; min-width: 0; background: #11151b; border-color: #2a303a; scrollbar-color: #2a303a transparent; }
  #focus .brief { flex: 1 1 0; min-width: 0; overflow-y: auto; padding: 10px 14px; background: #11151b; border: 1px solid #2a303a;
    border-radius: 6px; color: #e6e9ee; scrollbar-color: #2a303a transparent; }
  #focus .brief h3 { margin: 0 0 4px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #98a2b3; }
  #focus .brief p { margin: 0 0 14px; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
  #focus .brief p.unset { color: #98a2b3; font-style: italic; }
  #focus .brief .since { margin-top: -10px; font-size: 12px; color: #98a2b3; }
  @media (max-width: 700px) { #focus .lower { flex-direction: column; height: 45vh; } }
  .task { padding: 0 12px 2px; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #focus .feed .a { color: #e6e9ee; }
  #focus .feed .t, #focus .feed .d, #focus .feed .none { color: #98a2b3; }
  #focus .feed .bad { color: #fca5a5; }
  .foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px 10px; }
  .foot .spec { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #focus { display: none; position: fixed; inset: 0; z-index: 5; background: #0b0d10; padding: 16px; flex-direction: column; gap: 10px; }
  #focus.open { display: flex; }
  #focus .bar { display: flex; align-items: center; gap: 12px; color: #fff; }
  #focus .bar .line { color: #cbd5e1; padding: 0; flex: 1 1 auto; }
  #focus .bar .line b { color: #fff; }
  #focus img { flex: 1 1 auto; min-height: 0; width: 100%; object-fit: contain; background: #000; border-radius: 6px; }
  #report { display: none; position: fixed; inset: 0; z-index: 6; background: var(--bg); overflow-y: auto; padding: 0 16px 32px; }
  #report.open { display: block; }
  #report .bar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
    padding: 12px 0; background: var(--bg); border-bottom: 1px solid var(--line); }
  #report .bar strong { font-size: 16px; }
  #report .doc { max-width: 900px; margin: 0 auto; padding-top: 16px; line-height: 1.55; overflow-wrap: anywhere; }
  #report .doc h2 { font-size: 22px; margin: 8px 0 12px; }
  #report .doc h3 { font-size: 17px; margin: 28px 0 8px; padding-top: 12px; border-top: 1px solid var(--line); }
  #report .doc h4 { font-size: 15px; margin: 22px 0 6px; }
  #report .doc table { border-collapse: collapse; margin: 8px 0 12px; font-size: 13px; }
  #report .doc th, #report .doc td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
  #report .doc th { background: var(--panel); }
  #report .doc code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--panel); border: 1px solid var(--line);
    border-radius: 4px; padding: 0 4px; }
  #report .doc pre { padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
  #report .doc pre code { border: 0; padding: 0; background: none; white-space: pre; }
  #report .doc details { margin: 8px 0; }
  #report .doc summary { cursor: pointer; color: var(--muted); }
  #report .doc .unset { color: var(--muted); font-style: italic; }
  @media (prefers-reduced-motion: no-preference) { .badge.running { animation: pulse 1.6s ease-in-out infinite; } }
  @keyframes pulse { 50% { opacity: .55; } }
</style>
</head>
<body>
<header>
  <h1>SceneScout live</h1>
  <span class="meta" id="engine" data-testid="live-engine-summary"></span>
  <span class="spacer"></span>
  <span class="meta" id="counts" data-testid="live-session-counts"></span>
  <span class="actions">
    <button type="button" id="report-open" data-testid="live-report-toggle">Report</button>
    <button type="button" id="all" aria-pressed="false" data-testid="live-all-toggle">Stream all</button>
  </span>
</header>
<div id="banner" role="alert" data-testid="live-unreachable-banner">The engine is not answering. It may have exited; this page will pick up again if it comes back.</div>
<div id="empty" data-testid="live-empty-state">No session is attached yet. Cards appear here as soon as one attaches.</div>
<div id="finished" data-testid="live-finished-state">
  <h2>The run has finished</h2>
  <p>Its browsers are closed, so there is nothing left to watch. What it found is in the report.</p>
  <p class="where" id="finished-where" data-testid="live-finished-where"></p>
  <button type="button" id="finished-report" data-testid="live-finished-report">Read the report</button>
</div>
<main id="grid"></main>
<div id="report" role="dialog" aria-modal="true" aria-label="The run's report" data-testid="live-report-dialog">
  <div class="bar">
    <strong>Report</strong>
    <span class="meta" id="report-meta" data-testid="live-report-meta"></span>
    <span class="spacer"></span>
    <button type="button" id="report-save" data-testid="live-report-save">Save a copy</button>
    <button type="button" id="report-close" data-testid="live-report-close">Close</button>
  </div>
  <div class="doc" id="report-doc" data-testid="live-report-doc"></div>
</div>
<div id="focus" role="dialog" aria-modal="true" aria-label="Session close-up" data-testid="live-focus-dialog">
  <div class="bar">
    <strong id="focus-name"></strong>
    <span class="line" id="focus-line"></span>
    <button type="button" id="focus-close" data-testid="live-focus-close">Close</button>
  </div>
  <img id="focus-img" alt="">
  <div class="lower">
    <div class="feed" id="focus-feed" data-testid="live-focus-feed"></div>
    <aside class="brief" aria-label="What this session is doing" data-testid="live-focus-brief">
      <h3>Task</h3>
      <p id="focus-task" data-testid="live-focus-task"></p>
      <h3 id="focus-objective-head">Current objective</h3>
      <p id="focus-objective" data-testid="live-focus-objective"></p>
      <p class="since" id="focus-objective-since"></p>
    </aside>
  </div>
</div>
<script>
(function () {
  var THUMB_EVERY_MS = 3000;
  var cards = {};
  var streamAll = false;
  var focused = null;
  var skew = 0;
  var latest = {};
  var focusTick = 0;
  var events = null;
  var eventsKey = '';
  var frames = {};
  var hoverObjective = null;
  var reportOpen = false;
  var reportTimer = null;
  var reportProblem = null;
  // The run had sessions and has none now: its browsers are gone, and this
  // page holds the only rendering of the report unless it was written to disk.
  var sawRun = false;
  var finished = false;
  var reportShown = false;
  var reportFile = null;
  var reportMarkdown = null;
  var savedACopy = false;
  // A result that reads as a failure is shown in red.
  var BAD_RESULT = /error|fail|refus|block|violation|abandoned/i;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function held(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return total + 's';
    var minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + 'm' + String(total % 60).padStart(2, '0') + 's';
    return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
  }
  // The viewer's clock, 24-hour: the log stores UTC, and a feed an hour off the person's own watch reads as stale.
  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }
  function shotUrl(name) { return 'shot/' + encodeURIComponent(name) + '.jpg?ts=' + Date.now(); }

  // Every watched session's frames come over ONE connection. A browser allows
  // about six open connections to a host, and a stream per <img> used them
  // all up on six sessions, leaving the status poll queued behind them.
  function syncEvents() {
    var want = {};
    Object.keys(cards).forEach(function (name) { if (cards[name].live) want[name] = true; });
    if (focused && cards[focused]) want[focused] = true;
    var key = Object.keys(want).sort().join(',');
    if (key === eventsKey) return;
    eventsKey = key;
    if (events) { events.close(); events = null; }
    if (!key) return;
    events = new EventSource('events?sessions=' + encodeURIComponent(key));
    events.addEventListener('frame', function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      if (!d || typeof d.jpeg !== 'string') return;
      var src = 'data:image/jpeg;base64,' + d.jpeg;
      frames[d.session] = src;
      var card = cards[d.session];
      if (card && card.live) card.img.src = src;
      if (focused === d.session) document.getElementById('focus-img').src = src;
    });
    events.addEventListener('unavailable', function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      var card = d && cards[d.session];
      if (!card) return;
      // The session cannot stream, or its page is gone: the LIVE tag would lie.
      setLive(card, false);
      card.shot.classList.add('empty');
    });
    // A connection the browser gave up on (a 500, say) is not retried by EventSource; the next poll reopens it.
    events.onerror = function () { if (events && events.readyState === EventSource.CLOSED) eventsKey = ''; };
  }
  function describe(s) {
    var since = held(Date.now() + skew - Date.parse(s.since));
    if (s.state === 'idle') return { badge: 'idle ' + since, tool: 'last: ' + s.tool };
    return { badge: (s.state === 'stuck' ? 'stuck ' : 'running ') + since, tool: s.tool };
  }

  function setLive(card, on) {
    if (card.live === on) return;
    card.live = on;
    card.shot.classList.toggle('live', on);
    card.toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.toggle.textContent = on ? 'Streaming' : 'Stream';
    // Frames for a live card arrive over the shared connection; the thumbnail poll takes over again when it is switched off.
    if (on && frames[card.name]) card.img.src = frames[card.name];
    if (!on) card.img.src = shotUrl(card.name);
    syncEvents();
  }
  function refreshThumb(card) {
    if (card.live || document.hidden) return;
    var next = new Image();
    next.onload = function () { if (!card.live) card.img.src = next.src; };
    next.onerror = function () { if (!card.live) card.shot.classList.add('empty'); };
    next.src = shotUrl(card.name);
  }

  function build(name) {
    var root = el('section', 'card');
    root.setAttribute('data-testid', 'live-card-' + name);
    var top = el('div', 'top');
    var nameEl = el('span', 'name', name);
    nameEl.title = name;
    var role = el('span', 'role');
    var badge = el('span', 'badge idle');
    top.appendChild(nameEl); top.appendChild(role); top.appendChild(badge);
    var task = el('div', 'task');
    task.setAttribute('data-testid', 'live-card-task-' + name);
    var tool = el('div', 'line');
    var url = el('div', 'line');
    var shot = el('button', 'shot');
    shot.type = 'button';
    shot.setAttribute('aria-label', 'Open a close-up of ' + name);
    shot.setAttribute('data-testid', 'live-card-image-' + name);
    var img = el('img');
    img.alt = 'What ' + name + ' is showing';
    shot.appendChild(img); shot.appendChild(el('span', 'tag', 'LIVE'));
    shot.appendChild(el('span', 'none', 'No frame available. The page may be closed, or not answering.'));
    // A session with nothing to show answers 503. Say so instead of leaving a broken-image icon.
    img.addEventListener('error', function () { shot.classList.add('empty'); });
    img.addEventListener('load', function () { shot.classList.remove('empty'); });
    var feed = el('div', 'feed');
    feed.setAttribute('data-testid', 'live-card-feed-' + name);
    var foot = el('div', 'foot');
    var toggle = el('button', '', 'Stream');
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('data-testid', 'live-card-toggle-' + name);
    var spec = el('span', 'spec');
    foot.appendChild(toggle); foot.appendChild(spec);
    root.appendChild(top); root.appendChild(task); root.appendChild(tool); root.appendChild(url); root.appendChild(shot); root.appendChild(feed); root.appendChild(foot);

    var card = { name: name, root: root, role: role, badge: badge, task: task, tool: tool, url: url, shot: shot, img: img, feed: feed, toggle: toggle, spec: spec, live: false };
    toggle.addEventListener('click', function () { setLive(card, !card.live); });
    shot.addEventListener('click', function () { openFocus(name); });
    img.src = shotUrl(name);
    if (streamAll) setLive(card, true);
    return card;
  }

  // The report is Markdown whose text comes from the app under test (finding
  // titles, element names, URLs). It is turned into elements here, node by
  // node with textContent, so none of it is ever parsed as markup.
  function inline(node, text) {
    var re = /(\`[^\`]+\`|\\*\\*[^*]+\\*\\*)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      node.appendChild(tok.charAt(0) === '\`' ? el('code', '', tok.slice(1, -1)) : el('strong', '', tok.slice(2, -2)));
      last = m.index + tok.length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderMarkdown(root, md) {
    root.textContent = '';
    var lines = md.split('\\n');
    var i = 0;
    var container = root;
    var para = [];
    function flush() {
      if (!para.length) return;
      var p = el('p');
      inline(p, para.join(' '));
      container.appendChild(p);
      para = [];
    }
    function list(tag, re) {
      var box = el(tag);
      var m;
      while (i < lines.length && (m = re.exec(lines[i]))) {
        var li = el('li');
        inline(li, m[1]);
        box.appendChild(li);
        i += 1;
      }
      container.appendChild(box);
    }
    while (i < lines.length) {
      var line = lines[i];
      var m;
      if (/^\`\`\`/.test(line)) {
        flush();
        var code = [];
        i += 1;
        while (i < lines.length && !/^\`\`\`/.test(lines[i])) { code.push(lines[i]); i += 1; }
        i += 1;
        var pre = el('pre');
        pre.appendChild(el('code', '', code.join('\\n')));
        container.appendChild(pre);
      } else if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
        flush();
        var h = el('h' + Math.min(6, m[1].length + 1));
        inline(h, m[2]);
        container.appendChild(h);
        i += 1;
      } else if ((m = /^<details><summary>(.*)<\\/summary>$/.exec(line))) {
        flush();
        var details = el('details');
        details.appendChild(el('summary', '', m[1]));
        container.appendChild(details);
        container = details;
        i += 1;
      } else if (/^<\\/details>$/.test(line)) {
        flush();
        container = root;
        i += 1;
      } else if (/^\\|/.test(line)) {
        flush();
        var table = el('table');
        var rowIndex = 0;
        while (i < lines.length && /^\\|/.test(lines[i])) {
          var row = lines[i];
          i += 1;
          if (/^\\|(\\s*:?-+:?\\s*\\|)+\\s*$/.test(row)) continue;
          var tr = el('tr');
          row.replace(/^\\||\\|\\s*$/g, '').split('|').forEach(function (cell) {
            var td = el(rowIndex === 0 ? 'th' : 'td');
            inline(td, cell.trim());
            tr.appendChild(td);
          });
          table.appendChild(tr);
          rowIndex += 1;
        }
        container.appendChild(table);
      } else if (/^\\s*[-*] /.test(line)) {
        flush();
        list('ul', /^\\s*[-*] (.*)$/);
      } else if (/^\\d+\\. /.test(line)) {
        flush();
        list('ol', /^\\d+\\. (.*)$/);
      } else if (line.trim() === '') {
        flush();
        i += 1;
      } else {
        para.push(line);
        i += 1;
      }
    }
    flush();
  }

  function loadReport() {
    fetch('api/report', { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!reportOpen) return;
        var doc = document.getElementById('report-doc');
        var meta = document.getElementById('report-meta');
        reportProblem = null;
        if (!d) {
          doc.textContent = '';
          doc.appendChild(el('p', 'unset', 'No run is attached, so there is nothing to report yet.'));
          meta.textContent = '';
          return;
        }
        reportMarkdown = d.markdown;
        meta.textContent = (finished ? 'as the run left it at ' : 'as the run stands at ') + clock(d.at) + ' · ' + whereItIs();
        renderMarkdown(doc, d.markdown);
      })
      .catch(function (err) {
        // The last rendering stays; with none, say why there is nothing to read.
        var doc = document.getElementById('report-doc');
        reportProblem = err && err.message ? err.message : 'no answer';
        if (!doc.childElementCount) {
          doc.textContent = '';
          doc.appendChild(el('p', 'unset', 'The report could not be loaded (' + reportProblem + '). Trying again.'));
        }
      });
  }
  /** Where the report's file is, and whether the agent has written it there. */
  function whereItIs() {
    if (!reportFile) return 'scout_report writes this document to .scenescout/report.md at the end';
    if (reportFile.written) return 'saved at ' + reportFile.path;
    return 'NOT saved: ' + reportFile.path + ' does not exist — the agent has not run scout_report, so this page holds the only copy';
  }

  // Saving is the viewer's own browser writing a file the page already has;
  // nothing is sent to the engine, which only ever answers GET (ADR 7).
  function saveACopy() {
    if (!reportMarkdown) return;
    var url = URL.createObjectURL(new Blob([reportMarkdown], { type: 'text/markdown' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'scenescout-report.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    savedACopy = true;
  }

  function openReport() {
    reportOpen = true;
    document.getElementById('report').classList.add('open');
    loadReport();
    reportTimer = setInterval(loadReport, 5000);
    document.getElementById('report-close').focus();
  }
  function closeReport() {
    reportOpen = false;
    clearInterval(reportTimer);
    document.getElementById('report').classList.remove('open');
    document.getElementById('report-open').focus();
  }

  // Built with textContent only: an action's target is text from the app under test.
  function renderFeed(node, lines, onGroup) {
    // Measured before the node is emptied: an empty node always reads as scrolled to its end.
    var atTail = node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
    node.textContent = '';
    if (!lines || !lines.length) { node.appendChild(el('div', 'none', 'nothing recorded yet')); return; }
    var group = null;
    var groupObjective = null;
    var groups = 0;
    lines.forEach(function (line) {
      var objective = line.objective || '';
      if (!group || objective !== groupObjective) {
        group = el('div', 'group' + (objective ? ' g' + (groups % 4) : ''));
        if (objective) { groups += 1; group.title = objective; }
        if (onGroup) {
          group.addEventListener('mouseenter', function () { onGroup(objective); });
          group.addEventListener('mouseleave', function () { onGroup(null); });
        }
        groupObjective = objective;
        node.appendChild(group);
      }
      var row = el('div', 'row');
      row.appendChild(el('span', 't', clock(line.at)));
      row.appendChild(el('span', 'a' + (BAD_RESULT.test(line.result || '') ? ' bad' : ''), line.action));
      var rest = [line.target, line.result ? '-> ' + line.result : ''].filter(Boolean).join(' ');
      var detail = el('span', 'd', rest || line.url || '');
      detail.title = [line.target, line.result, line.url].filter(Boolean).join(' · ');
      row.appendChild(detail);
      group.appendChild(row);
    });
    // Follow the tail unless the reader has scrolled up to look at something.
    if (atTail) node.scrollTop = node.scrollHeight;
  }

  function paint(card, s) {
    var d = describe(s);
    card.root.className = 'card' + (s.state === 'stuck' ? ' stuck' : '');
    card.role.textContent = s.role === 'anonymous' ? '' : s.role;
    card.task.textContent = s.task || '';
    card.task.title = s.task || '';
    card.task.hidden = !s.task;
    card.badge.className = 'badge ' + s.state;
    card.badge.textContent = d.badge;
    card.tool.textContent = d.tool;
    card.url.textContent = s.url || '(no page yet)';
    card.url.title = s.url || '';
    card.spec.textContent = [s.mode, s.browser, s.headed ? 'headed' : 'headless'].filter(Boolean).join(' · ');
    renderFeed(card.feed, s.feed);
  }

  function openFocus(name) {
    focused = name;
    document.getElementById('focus-name').textContent = name;
    document.getElementById('focus-img').alt = 'Live view of ' + name;
    document.getElementById('focus-img').src = frames[name] || shotUrl(name);
    document.getElementById('focus').classList.add('open');
    hoverObjective = null;
    renderFeed(document.getElementById('focus-feed'), (latest[name] || {}).feed, showObjective);
    syncEvents();
    loadFullFeed(name);
    paintFocus();
    document.getElementById('focus-close').focus();
  }
  function closeFocus() {
    var was = focused;
    focused = null;
    document.getElementById('focus').classList.remove('open');
    document.getElementById('focus-img').removeAttribute('src');
    syncEvents();
    if (was && cards[was]) cards[was].shot.focus();
  }
  function loadFullFeed(name) {
    fetch('api/activity?session=' + encodeURIComponent(name), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && focused === d.session) renderFeed(document.getElementById('focus-feed'), d.feed, showObjective); })
      .catch(function () { /* the short feed from the last poll stays on screen */ });
  }

  function setBrief(id, text, unset) {
    var node = document.getElementById(id);
    node.textContent = text || unset;
    node.className = text ? '' : 'unset';
  }

  // The pointer is over a group of the close-up's feed: the brief shows the
  // objective those actions served. It goes back to the current one on leaving.
  function showObjective(objective) {
    hoverObjective = objective;
    paintBrief();
  }
  function paintBrief() {
    var s = focused && latest[focused];
    // The engine sees tool calls, not reasoning: both of these are the agent's own words, or nothing.
    setBrief('focus-task', s && s.task, 'Not given. An agent sets it when it attaches the session.');
    var head = document.getElementById('focus-objective-head');
    if (hoverObjective !== null) {
      head.textContent = 'Objective for these actions';
      setBrief('focus-objective', hoverObjective, 'No journey was running.');
      document.getElementById('focus-objective-since').textContent = '';
    } else {
      head.textContent = 'Current objective';
      setBrief('focus-objective', s && s.objective, 'No journey running. An agent starts one with scout_journey.');
      document.getElementById('focus-objective-since').textContent =
        s && s.objective && s.objectiveSince ? 'for ' + held(Date.now() + skew - Date.parse(s.objectiveSince)) : '';
    }
  }
  // Once a second, from the status poll: the bar, the brief, and every third time the long feed.
  function paintFocus() {
    var s = focused && latest[focused];
    var line = document.getElementById('focus-line');
    paintBrief();
    if (!s) { line.textContent = focused ? 'This session has closed.' : ''; return; }
    var d = describe(s);
    line.textContent = d.badge + ' · ' + d.tool + ' · ' + (s.url || '');
    if (focusTick % 3 === 0) loadFullFeed(focused);
    focusTick += 1;
  }

  function apply(snap) {
    skew = Date.parse(snap.at) - Date.now();
    var grid = document.getElementById('grid');
    var seen = {};
    latest = {};
    var counts = { running: 0, idle: 0, stuck: 0 };
    snap.sessions.forEach(function (s) {
      seen[s.session] = true;
      latest[s.session] = s;
      counts[s.state] += 1;
      if (!cards[s.session]) {
        cards[s.session] = build(s.session);
        // Sessions arrive sorted; inserting in that order keeps the grid
        // stable without ever moving a card that is already streaming.
        // Before the first card that sorts after this one; at the end when there is none.
        var next = Object.keys(cards).sort().filter(function (k) { return k > s.session && cards[k].root.parentNode; })[0];
        grid.insertBefore(cards[s.session].root, next ? cards[next].root : null);
      }
      paint(cards[s.session], s);
    });
    Object.keys(cards).forEach(function (name) {
      if (seen[name]) return;
      cards[name].img.removeAttribute('src');
      cards[name].root.remove();
      delete cards[name];
      delete frames[name];
    });
    syncEvents();
    reportFile = snap.report || reportFile;
    if (snap.sessions.length > 0) sawRun = true;
    finished = sawRun && snap.sessions.length === 0;
    document.getElementById('empty').style.display = snap.sessions.length || finished ? 'none' : 'block';
    document.getElementById('finished').classList.toggle('open', finished);
    if (finished) {
      var where = document.getElementById('finished-where');
      where.textContent = whereItIs();
      where.className = 'where' + (reportFile && reportFile.written ? '' : ' unset');
      // The moment somebody wants the report is the moment the run ends: show it.
      if (!reportShown) {
        reportShown = true;
        if (!reportOpen) openReport();
      }
    }
    document.getElementById('engine').textContent = 'engine pid ' + snap.pid + ' · v' + snap.version;
    document.getElementById('counts').textContent = snap.sessions.length + ' session' + (snap.sessions.length === 1 ? '' : 's') +
      ' · ' + counts.running + ' running · ' + counts.idle + ' idle' + (counts.stuck ? ' · ' + counts.stuck + ' stuck' : '');
    paintFocus();
  }

  function poll() {
    fetch('api/status', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (snap) { document.getElementById('banner').style.display = 'none'; apply(snap); })
      .catch(function () { document.getElementById('banner').style.display = 'block'; });
  }

  document.getElementById('all').addEventListener('click', function () {
    streamAll = !streamAll;
    this.setAttribute('aria-pressed', streamAll ? 'true' : 'false');
    this.textContent = streamAll ? 'Streaming all' : 'Stream all';
    Object.keys(cards).forEach(function (name) { setLive(cards[name], streamAll); });
  });
  document.getElementById('focus-close').addEventListener('click', closeFocus);
  // A re-rendered feed replaces the group under the pointer without a mouseleave; leaving the feed itself still resets.
  document.getElementById('focus-feed').addEventListener('mouseleave', function () { showObjective(null); });
  document.getElementById('focus').addEventListener('click', function (e) { if (e.target === this) closeFocus(); });
  document.getElementById('report-open').addEventListener('click', openReport);
  document.getElementById('finished-report').addEventListener('click', openReport);
  document.getElementById('report-save').addEventListener('click', saveACopy);
  // Closing the tab on a finished run whose report was never written to disk
  // throws the only copy away. The browser shows its own confirm/dismiss, and
  // only when the person has interacted with the page at least once.
  window.addEventListener('beforeunload', function (e) {
    if (!finished || savedACopy || (reportFile && reportFile.written)) return;
    e.preventDefault();
    e.returnValue = '';
  });
  document.getElementById('report-close').addEventListener('click', closeReport);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (reportOpen) closeReport();
    else if (focused) closeFocus();
  });

  poll();
  setInterval(poll, 1000);
  setInterval(function () { Object.keys(cards).forEach(function (name) { refreshThumb(cards[name]); }); }, THUMB_EVERY_MS);
})();
</script>
</body>
</html>
`;
