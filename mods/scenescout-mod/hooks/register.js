/**
 * SceneScout's optional Claude Code mod. It adds only what an MCP server
 * cannot: a guided panel in the Claude Code CLI and the desktop Code tab
 * (`/scenescout-guided`, and `/scenescout-pane`, which opens the same panel)
 * that starts a check in plain words, follows it and shows what it found; a
 * question to the person before Claude's own SceneScout calls that would send
 * things to a site; and, when the user sets `lane_model`, the model SceneScout
 * lane agents start on. The scenescout plugin, its skill and its server work
 * the same without it.
 *
 * Every rule lives in ./pane.js and ./guided.js, which have no mods API in
 * them and are table-tested. This file only wires those rules to events. It
 * imports nothing from `claude-code`, so the tests can load it in Node.
 */
import { PANE_ID, POLL_MS, callPlan, fallbackText, laneModelSetting, readResult, renderPane, serverCandidates, spawnModel, unreachable } from "./pane.js";
import {
  CARDS_TOOL,
  CONFIRM_TOOL,
  DIRECT_TOOLS,
  FEEDBACK_TOOL,
  PANEL_WORDS,
  PLAN_TOOL,
  RESULTS_LIMIT,
  afterConfirm,
  afterPlan,
  choicesFromDraft,
  endsMainTurn,
  errorSentence,
  guardFor,
  guidedText,
  pictureSvg,
  readCards,
  reduce,
  renderGuided,
  resultText,
  sendRoute,
  startsTour,
  TOUR_SEEN_KEY,
  wizardOf,
} from "./guided.js";

// What a drawing reads lives in $.state (types/index.d.ts), so a reload of the mod keeps the panel where it was.
const WIZARD = { plugin: "scenescout-mod", key: "wizard" };
const STATUS = { plugin: "scenescout-mod", key: "status" };
const PICTURE = { plugin: "scenescout-mod", key: "picture" };
const CONFIRMED = { plugin: "scenescout-mod", key: "confirmed" };

/** Whether the pane is open; the timer polls only while it is. */
let isOpen = false;
/** Whether a poll is in flight, so a slow server never has two at once. */
let isPolling = false;
/** The [server, tool] pair that answered last, tried first next time. */
let lastGood = null;
/** The poll timer, so a second session.start replaces it rather than adding one. */
let timer = null;
/** Whether a model turn is running: a message then goes into it rather than waiting for a turn of its own. */
let isWorking = false;

export function register(on, options) {
  const lane = laneModelSetting(options?.lane_model);
  const servers = serverCandidates(options?.mcp_server);

  on("session.start", async ($, e, next) => {
    // session.start runs again after a reload of this mod; keep one timer.
    timer?.cancel();
    timer = $.clock.every(POLL_MS, async () => {
      if (isOpen) await poll($, servers);
    });
    if (lane.error) $.ui.log(lane.error);
    // Last, because a refused name throws and skips the rest of this hook.
    await $.command.register({
      name: "scenescout-guided",
      description: "Check a site with SceneScout in plain words: start a check, follow it and read what it found",
      immediate: true,
    });
    await $.command.register({
      name: "scenescout-pane",
      description: "Open the SceneScout panel: the running check, its findings and the live view",
      immediate: true,
    });
    return next(e);
  });

  on("command.run", { command: "scenescout-guided" }, async ($) => openPanel($, servers, "guided"));
  on("command.run", { command: "scenescout-pane" }, async ($) => openPanel($, servers, "pane"));

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE_ID) isOpen = false;
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    isWorking = true;
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    // A lane subagent's turn ending leaves the main turn running.
    if (endsMainTurn(e)) isWorking = false;
    return next(e);
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    isOpen = true;
    const els = $.ui.resolve(e);
    const wizard = wizardOf((await $.state.get(WIZARD)).value);
    const status = (await $.state.get(STATUS)).value ?? { kind: "loading" };
    const picture = (await $.state.get(PICTURE)).value ?? null;
    const runPane = status.kind === "data" || status.kind === "text" ? renderPane(els, status) : null;
    const shown = picture && picture.id === wizard.cardId ? picture : null;
    return renderGuided(els, wizard, { surface: e.surface, status, picture: shown, runPane }, (type, payload = {}) => {
      // Fired, never awaited: a press must not hold anything up while the server or a form answers.
      void perform($, servers, type, payload).catch((err) => $.ui.toast(`SceneScout: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)));
    });
  });

  // Before Claude's own SceneScout call that would send things to a site, ask the person (design 6.3).
  // The server's own confirmation form stays the rule; this is the mod's reminder in front of it.
  on("tool.call", async ($, e, next) => {
    // Most calls are not SceneScout's: settle those without reading any state.
    if (!guardFor(e, [])) return next(e);
    const guard = guardFor(e, (await $.state.get(CONFIRMED)).value ?? []);
    if (!guard) return next(e);
    let answer = "";
    try {
      answer = await $.ui.ask(guard.question, [guard.allow, guard.refuse]);
    } catch (err) {
      // An older Claude Code build has no dialog to ask with: the server's form still decides.
      if (err instanceof TypeError && /\bask\b.*not a function|not a function.*\bask\b/.test(err.message)) return next(e);
      // Dismissed, or nobody to ask (claude -p): that is a no.
      return { deny: guard.deny };
    }
    return answer === guard.allow ? next(e) : { deny: guard.deny };
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : guardFor(e, [])
        ? { deny: "The SceneScout mod could not ask the person first, so this call was not made. Ask the person what they want." }
        : next(e),
  );

  // Registered only when the user chose a model: with lane_model empty the mod never sees a spawn.
  if (lane.model) {
    on("agent.spawn", async ($, e, next) => {
      const model = spawnModel(e, lane.model);
      return next(model ? { ...e, model } : e);
    });
  }
}

/** Open the panel, or print the state where nothing draws (the VS Code chat panel, claude -p). */
async function openPanel($, servers, which) {
  await poll($, servers);
  const surfaces = await $.session.surfaces();
  // A first open of the guided panel starts on the tour; where nothing draws there is no tour to show.
  if (which === "guided" && surfaces.length > 0) await maybeStartTour($);
  if (surfaces.length === 0) {
    const status = (await $.state.get(STATUS)).value ?? { kind: "loading" };
    if (which === "pane") return { text: fallbackText(status) };
    return { text: guidedText(wizardOf((await $.state.get(WIZARD)).value), status) };
  }
  isOpen = true;
  await $.ui.open({ id: PANE_ID, title: "SceneScout", closeOnEscape: true });
  return {};
}

/** What `$.store` says about the tour, or the Error when it could not be read (an older build without `$.store`). */
async function tourSeen($) {
  try {
    return await $.store.get(TOUR_SEEN_KEY);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function maybeStartTour($) {
  const seen = await tourSeen($);
  if (seen instanceof Error) $.ui.log(`SceneScout: the tour's setting could not be read, so it is not shown: ${seen.message}`);
  const status = (await $.state.get(STATUS)).value ?? { kind: "loading" };
  await updateWizard($, (w) => (startsTour(seen, w, status) ? reduce(w, { type: "tour" }) : w));
}

/** Read the wizard, apply `fn`, and write it back only if nothing wrote it meanwhile; again on a miss. */
async function updateWizard($, fn) {
  for (let i = 0; i < 5; i++) {
    const held = await $.state.get(WIZARD);
    const next = fn(wizardOf(held.value));
    const { isSet } = await $.state.set(WIZARD, next, { ifVersion: held.version });
    if (isSet) return next;
  }
  throw new Error("the panel changed too often to save");
}

/** Call a SceneScout tool on whichever server answered the status poll, else each one the mod knows. */
async function callServer($, servers, tool, args) {
  const order = lastGood ? [lastGood[0], ...servers.filter((s) => s !== lastGood[0])] : servers;
  let failure = "";
  for (const server of order) {
    try {
      return await $.mcp.call(server, tool, args);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  return { isError: true, content: [{ type: "text", text: `No SceneScout server answered: ${failure.slice(0, 200)}` }] };
}

/**
 * Hand Claude a message: a turn of its own when it is idle, or a row the
 * running turn reads (design 4.1.1). Neither is awaited by the press that
 * asked; a refusal is said in a toast.
 */
async function sendToClaude($, text) {
  if (sendRoute(isWorking) === "append") {
    try {
      const appended = await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
      if (!appended?.deny) {
        $.ui.toast("SceneScout: sent to Claude, which reads it at its next step.");
        return;
      }
    } catch {
      // An older build without session.append, or a refused row: a turn of its own instead, once Claude is idle.
    }
  }
  try {
    void $.prompt.submit({ text }).then(
      (r) => {
        if (r?.drop) $.ui.toast(`SceneScout: the message was not sent: ${r.drop}`.slice(0, 300));
      },
      (err) => $.ui.toast(`SceneScout: the message was not sent: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)),
    );
  } catch {
    $.ui.toast(`SceneScout: this Claude Code cannot send for you. Say this to Claude: ${text}`.slice(0, 600));
  }
}

/** Build a plan from these choices, then preview its confirmation or start Claude on it. */
async function buildAndStart($, servers, choices) {
  await updateWizard($, (w) => ({ ...w, busy: "plan", notice: null }));
  const result = await callServer($, servers, PLAN_TOOL, { choices });
  let send;
  let planId = null;
  await updateWizard($, (w) => {
    const after = afterPlan(w, result);
    send = after.send;
    planId = after.wizard.planId;
    return after.wizard;
  });
  // The person pressed Start on a plan that needs no form: Claude's attach with it is theirs, so it is not asked about again.
  if (send && planId) await rememberConfirmed($, planId);
  if (send) await sendToClaude($, send);
}

/** A plan the person said yes to, so the guard does not ask about Claude's attach with it again. */
async function rememberConfirmed($, planId) {
  const held = await $.state.get(CONFIRMED);
  await $.state.set(CONFIRMED, [...(held.value ?? []).filter((id) => id !== planId), planId].slice(-20));
}

/** What a press asked for. */
async function perform($, servers, type, payload) {
  switch (type) {
    case "retry":
      return poll($, servers);
    case "tourDone": {
      await updateWizard($, (w) => reduce(w, { type: "tourDone" }));
      try {
        await $.store.set(TOUR_SEEN_KEY, true);
      } catch (err) {
        // Not remembered: the tour shows again next time, which is the only harm.
        $.ui.log(`SceneScout: the tour could not be marked as seen: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    case "build": {
      const w = wizardOf((await $.state.get(WIZARD)).value);
      const checked = choicesFromDraft(w.draft);
      if (!checked.ok) {
        const text = checked.error;
        return updateWizard($, (x) => ({ ...x, notice: { tone: "error", text } }));
      }
      return buildAndStart($, servers, checked.choices);
    }
    case "lookOnly": {
      const w = wizardOf((await $.state.get(WIZARD)).value);
      const choices = w.plan?.choices;
      if (!choices) return updateWizard($, (x) => reduce(x, { type: "go", step: "configuring" }));
      await updateWizard($, (x) => ({ ...x, draft: { ...x.draft, care: "look-only" } }));
      return buildAndStart($, servers, { ...choices, care: "look-only" });
    }
    case "runAgain": {
      const w = wizardOf((await $.state.get(WIZARD)).value);
      if (!w.lastChoices) return updateWizard($, (x) => reduce(x, { type: "newCheck" }));
      return buildAndStart($, servers, w.lastChoices);
    }
    case "confirm":
      return confirmPlan($, servers, wizardOf((await $.state.get(WIZARD)).value).planId);
    case "cards":
      return loadCards($, servers, true);
    case "openCard":
      await updateWizard($, (w) => reduce(w, { type, ...payload }));
      return probePicture($, servers, String(payload.id ?? ""), String(payload.surface ?? ""));
    case "feedback": {
      const result = await callServer($, servers, FEEDBACK_TOOL, { id: payload.id, verdict: payload.verdict });
      const failed = result?.isError === true;
      return updateWizard($, (w) => ({
        ...w,
        notice: failed ? { tone: "error", text: errorSentence(result) } : { tone: "info", text: resultText(result).split("\n")[0] },
        cards:
          failed || !w.cards
            ? w.cards
            : w.cards.map((c) => (c.id === payload.id ? { ...c, feedback: { verdict: payload.verdict, at: new Date().toISOString() } } : c)),
      }));
    }
    case "send":
      return sendToClaude($, String(payload.text ?? ""));
    case "call": {
      // An engine action from the progress: only the three tools a button may call.
      if (!DIRECT_TOOLS.includes(String(payload.tool))) return;
      if (payload.tool === CONFIRM_TOOL) return confirmPlan($, servers, String(payload.args?.planId ?? ""));
      if (payload.tool === CARDS_TOOL) return loadCards($, servers, true);
      const result = await callServer($, servers, String(payload.tool), payload.args ?? {});
      return updateWizard($, (w) => ({
        ...w,
        notice: result?.isError ? { tone: "error", text: errorSentence(result) } : { tone: "info", text: resultText(result).split("\n")[0] },
      }));
    }
    case "mobileCheck": {
      let filled = null;
      try {
        filled = await $.prompt.fill({ text: PANEL_WORDS.mobileFill });
      } catch {
        // An older build without prompt.fill: the toast below says what to type.
      }
      if (!filled?.isFilled) $.ui.toast(`SceneScout: say "${PANEL_WORDS.mobileFill.trim()} ..." to Claude.`);
      return updateWizard($, (w) => ({ ...w, step: "configuring", notice: null }));
    }
    default:
      return updateWizard($, (w) => reduce(w, { type, ...payload }));
  }
}

/** Ask the person, through the server's own form, to confirm the plan; the panel only waits for their answer. */
async function confirmPlan($, servers, planId) {
  if (!planId) return;
  await updateWizard($, (w) => ({ ...w, planId, busy: "confirm", notice: null }));
  const result = await callServer($, servers, CONFIRM_TOOL, { planId });
  let send;
  await updateWizard($, (w) => {
    const after = afterConfirm(w, result);
    send = after.send;
    return after.wizard;
  });
  if (result?.structuredContent?.accepted === true) await rememberConfirmed($, planId);
  if (send) await sendToClaude($, send);
}

/** The findings as cards, worst first. */
async function loadCards($, servers, show) {
  await updateWizard($, (w) => ({ ...w, busy: "cards", ...(show ? { step: "results", notice: null } : {}) }));
  const result = await callServer($, servers, CARDS_TOOL, { limit: RESULTS_LIMIT, pictures: "files" });
  const read = readCards(result);
  if (!read.ok) {
    const text = read.error;
    await updateWizard($, (w) => ({ ...w, busy: null, notice: { tone: "error", text } }));
    return;
  }
  await updateWizard($, (w) => ({ ...w, busy: null, cards: read.cards, cardsTotal: read.total, pictureFiles: read.pictureFiles }));
}

/**
 * The picture probe: on a surface that draws Svg, ask the server for the
 * card's picture inline and wrap it in an Svg. The links stay either way.
 */
async function probePicture($, servers, id, surface) {
  await $.state.set(PICTURE, null);
  if (!id || surface === "terminal" || surface === "") return;
  const w = wizardOf((await $.state.get(WIZARD)).value);
  const card = (w.cards ?? []).find((c) => c.id === id);
  if (card && !card.picture) return;
  const result = await callServer($, servers, CARDS_TOOL, { ids: [id], pictures: "inline", limit: 1 });
  const size = card?.picture ?? result?.structuredContent?.cards?.[0]?.picture ?? null;
  await $.state.set(PICTURE, { id, ...pictureSvg(result, size) });
}

/** One poll: try each server and tool until one answers, then keep what it said for the drawing. */
async function poll($, servers) {
  if (isPolling) return;
  isPolling = true;
  try {
    const failures = [];
    let next = null;
    // The first error the server itself reported, shown when no other pair answers.
    let reported = null;
    for (const [server, tool] of callPlan(servers, lastGood)) {
      try {
        const read = readResult(await $.mcp.call(server, tool, {}), await $.clock.now());
        // A host may refuse an app-only tool with an error result rather than a throw: try the next pair.
        if (read.kind === "error") {
          reported ??= read;
          failures.push(`${server} ${tool}: ${read.error.slice(0, 120)}`);
          continue;
        }
        lastGood = [server, tool];
        next = read;
        break;
      } catch (err) {
        failures.push(`${server} ${tool}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      }
    }
    await $.state.set(STATUS, next ?? reported ?? unreachable(failures, await $.clock.now()));
  } finally {
    isPolling = false;
  }
}
