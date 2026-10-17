// The guided panel mounted on every surface by Claude Code's own test kit
// (`claude plugin test mods/scenescout-mod`): what a table cannot show, that
// each surface's element table accepts the tree, and that the presses reach
// the server and Claude as they should. The rules themselves are table-tested
// in scripts/live-test.ts, which needs no Claude Code.
import { expect, mock, test } from "claude-code/testing";

const PLUGIN = "scenescout-mod";
const PANE = { plugin: PLUGIN, component: "Pane", requestId: "scenescout-run" } as const;
const PROPS = { title: "SceneScout", isFocused: true, bodyColumns: 80, placement: "dock" } as never;
const SURFACES = ["terminal", "desktop", "vscode", "mobile"] as const;

const status = (guided?: Record<string, unknown>) => ({
  content: [{ type: "text", text: "Live view: off" }],
  structuredContent: {
    liveUrl: null,
    liveNote: "The live view starts with the first scout_attach.",
    sessions: [],
    findings: { open: 0, high: 0, medium: 0, low: 0, thisRun: 0 },
    ...(guided ? { guided } : {}),
  },
});

const PLAN = {
  planId: "gp-abcdefghij",
  choices: { address: "https://staging.example.com", areas: ["forms"], signIn: "none", care: "may-create-test-data", thoroughness: "normal" },
  mode: "safe-write",
  confirm: { reason: "creates-data", sentence: 'You chose "May create test data" for https://staging.example.com.', accepted: false },
};

const SAVED = [{ name: "Admin area", address: "https://staging.example.com", care: "look-only", lastRunAt: "2026-10-17T11:00:00.000Z" }];

const FINISHED = { planId: PLAN.planId, phase: "done", next: [{ kind: "direct", tool: "scout_cards", label: "See the problems" }] };
const finished = { on: false };

/** Answer the server's tools from memory, and record every call. */
function server(on: any, calls: Array<{ tool: string; args: unknown }>) {
  on("mcp.call", async (_$: unknown, e: { tool: string; args: Record<string, unknown> }) => {
    calls.push({ tool: e.tool, args: e.args });
    if (e.tool === "scout_status_poll") return { value: status(finished.on ? FINISHED : undefined) };
    if (e.tool === "scout_cards")
      return {
        value: {
          content: [{ type: "text", text: "cards" }],
          structuredContent: { cards: [{ id: "f1", title: "Save button does nothing", severity: "high" }], total: 1 },
        },
      };
    if (e.tool === "scout_saved_checks") {
      const args = e.args as { action: string };
      return {
        value: { content: [{ type: "text", text: args.action === "delete" ? "Deleted." : "Saved." }], structuredContent: { saved: SAVED, refused: [] } },
      };
    }
    if (e.tool === "scout_recheck_plan")
      return {
        value: {
          content: [{ type: "text", text: "plan" }],
          structuredContent: { ...PLAN, planId: "gp-recheck001", recheck: { ids: ["a"] }, confirm: null, mode: "read-only" },
        },
      };
    if (e.tool === "scout_guided_plan") return { value: { content: [{ type: "text", text: "plan" }], structuredContent: PLAN } };
    if (e.tool === "scout_guided_confirm")
      return {
        value: {
          content: [{ type: "text", text: "accepted" }],
          structuredContent: { planId: PLAN.planId, accepted: true, outcome: "accepted", tellPerson: "Thank you.", mode: "safe-write" },
        },
      };
    return { value: { isError: true, content: [{ type: "text", text: "not here" }] } };
  });
}

test("the panel draws on every surface, and mobile gets buttons alone", async ($, on) => {
  const calls: Array<{ tool: string; args: unknown }> = [];
  server(on, calls);
  mock.clock(on, { now: 1_000 });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS });
    expect(await ui.find({ key: "guided-welcome-check" })).toBeDefined();
    expect(await ui.find({ key: "guided-welcome-safety" })).toBeDefined();
    await ui.press({ key: "guided-welcome-safety" });
    expect(await ui.find({ type: "Text", text: /never asks for your password/ })).toBeDefined();
    await ui.press({ key: "guided-safety-back" });
    if (surface !== "mobile") {
      await ui.press({ key: "guided-welcome-check" });
      expect(await ui.find({ type: "Input", key: "guided-config-address" })).toBeDefined();
      await ui.press({ key: "guided-config-cancel" });
    }
    expect((await ui.findAll({ type: "Input" })).length).toBe(0);
    await ui.unmount();
  }
});

test("Start builds a plan, the preview waits for the person, and only the server's yes starts Claude", async ($, on) => {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const sent: string[] = [];
  server(on, calls);
  on("prompt.submit", async (_$: unknown, e: { text: string }) => {
    sent.push(e.text);
    return { text: e.text };
  });
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await ui.press({ key: "guided-welcome-check" });
  await ui.input({ key: "guided-config-address", text: "https://staging.example.com" });
  await ui.press({ key: "guided-config-care-may-create-test-data" });
  await ui.press({ key: "guided-config-start" });
  expect(calls.some((c) => c.tool === "scout_guided_plan")).toBe(true);
  expect(sent).toEqual([]);
  expect(await ui.find({ key: "guided-confirm-yes" })).toMatchObject({ props: { label: "Yes, it is a test copy" } });
  await ui.press({ key: "guided-confirm-yes" });
  expect(calls.filter((c) => c.tool === "scout_guided_confirm")).toEqual([{ tool: "scout_guided_confirm", args: { planId: "gp-abcdefghij" } }]);
  expect(sent).toEqual(['Run the SceneScout guided plan gp-abcdefghij: call scout_guided_plan {planId: "gp-abcdefghij"} and follow it.']);
  await ui.unmount();
});

test("Claude's own attach that writes asks the person first, and a no denies it", async ($, on) => {
  let asked = 0;
  on("tool.call", { tool: "AskUserQuestion" }, async (_$: unknown, e: { questions: Array<{ question: string }> }) => {
    asked += 1;
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: "Stop it" } } };
  });
  on("tool.call", async () => ({ result: { content: [{ type: "text", text: "attached" }] } }));
  const denied = await $.tool.call({
    tool: "mcp__scenescout__scout_attach",
    tool_use_id: "t1",
    url: "https://staging.example.com",
    mode: "safe-write",
  } as never);
  expect(asked).toBe(1);
  expect(denied).toMatchObject({ deny: expect.stringContaining("did not agree") });
  // No mode at all: the server attaches in read-only, so it asks too.
  await $.tool.call({ tool: "mcp__scenescout__scout_attach", tool_use_id: "t0", url: "https://staging.example.com" } as never);
  expect(asked).toBe(2);
  const looking = await $.tool.call({ tool: "mcp__scenescout__scout_attach", tool_use_id: "t2", url: "https://staging.example.com", mode: "observe" } as never);
  expect(asked).toBe(2);
  expect(looking).not.toMatchObject({ deny: expect.anything() });
});

test("a plan the person started from the panel is not asked about a second time when Claude attaches with it", async ($, on) => {
  let asked = 0;
  const sent: string[] = [];
  const local = {
    planId: "gp-klmnopqrst",
    choices: { address: "http://localhost:3000", areas: ["forms"], signIn: "none", care: "may-submit-forms", thoroughness: "normal" },
    mode: "read-only",
    confirm: null,
  };
  on("mcp.call", async (_$: unknown, e: { tool: string }) => {
    if (e.tool === "scout_guided_plan") return { value: { content: [{ type: "text", text: "plan" }], structuredContent: local } };
    return { value: { isError: true, content: [{ type: "text", text: "not here" }] } };
  });
  on("prompt.submit", async (_$: unknown, e: { text: string }) => {
    sent.push(e.text);
    return { text: e.text };
  });
  on("tool.call", { tool: "AskUserQuestion" }, async (_$: unknown, e: { questions: Array<{ question: string }> }) => {
    asked += 1;
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: "Let it" } } };
  });
  on("tool.call", async () => ({ result: { content: [{ type: "text", text: "attached" }] } }));
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await ui.press({ key: "guided-welcome-check" });
  await ui.input({ key: "guided-config-address", text: "http://localhost:3000" });
  await ui.press({ key: "guided-config-care-may-submit-forms" });
  await ui.press({ key: "guided-config-start" });
  expect(sent.length).toBe(1);
  await $.tool.call({
    tool: "mcp__scenescout__scout_attach",
    tool_use_id: "t1",
    url: "http://localhost:3000",
    mode: "read-only",
    planId: local.planId,
  } as never);
  expect(asked).toBe(0);
  // Another plan, or none, is still asked about.
  await $.tool.call({ tool: "mcp__scenescout__scout_attach", tool_use_id: "t2", url: "http://localhost:3000", mode: "read-only" } as never);
  expect(asked).toBe(1);
  await ui.unmount();
});

const answerCommands = (on: any) => {
  on("session.surfaces", async () => ({ value: ["desktop"] }));
  on("command.run", async () => ({}));
};

test("saved checks: Delete asks first and a Keep or leaving the welcome drops the question; Run again reaches the server", async ($, on) => {
  const calls: Array<{ tool: string; args: { action?: string } }> = [];
  server(on, calls as never);
  answerCommands(on);
  mock.clock(on, { now: 1_000 });
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  const deletes = () => calls.filter((c) => c.tool === "scout_saved_checks" && c.args.action === "delete");
  await ui.press({ key: "guided-saved-delete-admin-area" });
  expect(await ui.find({ key: "guided-saved-delete-yes-admin-area" })).toBeDefined();
  await ui.press({ key: "guided-saved-delete-keep-admin-area" });
  expect(deletes()).toEqual([]);
  // Leaving the welcome with the question open: it is gone when the person comes back.
  await ui.press({ key: "guided-saved-delete-admin-area" });
  await ui.press({ key: "guided-welcome-safety" });
  await ui.press({ key: "guided-safety-back" });
  expect(await ui.findAll({ key: "guided-saved-delete-yes-admin-area" })).toEqual([]);
  await ui.press({ key: "guided-saved-delete-admin-area" });
  await ui.press({ key: "guided-saved-delete-yes-admin-area" });
  expect(deletes()).toEqual([{ tool: "scout_saved_checks", args: { action: "delete", name: "Admin area" } }]);
  await ui.press({ key: "guided-saved-run-admin-area" });
  expect(calls.some((c) => c.tool === "scout_saved_checks" && c.args.action === "run")).toBe(true);
  await ui.unmount();
});

test("saved checks: the finished check can be named and saved, and Check them again plans a re-check", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  server(on, calls as never);
  on("prompt.submit", async (_$: unknown, e: { text: string }) => ({ text: e.text }));
  mock.clock(on, { now: 1_000 });
  answerCommands(on);
  finished.on = true;
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  await ui.press({ key: "guided-welcome-check" });
  await ui.input({ key: "guided-config-address", text: "https://staging.example.com" });
  await ui.press({ key: "guided-config-start" });
  await ui.press({ key: "guided-confirm-yes" });
  await ui.press({ key: "guided-running-see-the-problems" });
  await ui.input({ key: "guided-save-name", text: "Settings page" });
  await ui.press({ key: "guided-save-check" });
  expect(calls.filter((c) => c.tool === "scout_saved_checks" && c.args.action === "save")).toEqual([
    { tool: "scout_saved_checks", args: { action: "save", name: "Settings page", planId: PLAN.planId } },
  ]);
  await ui.press({ key: "guided-results-recheck" });
  expect(calls.some((c) => c.tool === "scout_recheck_plan")).toBe(true);
  await ui.unmount();
  finished.on = false;
});

// ---- The run around the panel: the band, card labels and queued checks ----

const BAND = { plugin: PLUGIN, component: "AbovePrompt", requestId: "band" } as const;
const bandProps = (hasSurvey = false) => ({ hasSurvey, isWorking: false, maxRows: 6, bodyColumns: 80 }) as never;
const RUNNING = {
  planId: "gp-running0001",
  title: "Checking staging.example.com",
  phase: "exploring",
  now: "Opening /orders",
  story: ["Opening /orders"],
  areas: [],
  problems: { blocksUsers: 1, annoying: 1, cosmetic: 0, worthALook: 0 },
  latest: [],
  next: [],
};
const QUEUED_SAVED = [{ name: "Admin area", address: "https://staging.example.com", care: "may-create-test-data", lastRunAt: "" }];

/** What Claude Code itself does beneath the mod: draws nothing of its own in the band, opens the pane, sets the status line. */
function engineBeneath(on: any, statusLines: Array<string | undefined>) {
  on("ui.render", { component: "AbovePrompt" }, async () => ({ type: "engine", ref: 0 }));
  on("ui.open", async () => ({ value: { isPlaced: true } }));
  on("ui.status", async (_$: unknown, e: { text?: string }) => {
    statusLines.push(e.text);
    return { value: undefined };
  });
}

/** A server whose guided check runs until `run.done`, whose one saved check writes, and which records every call. */
function runServer(on: any, calls: Array<{ tool: string; args: Record<string, unknown> }>, run: { done: boolean; now?: string; seeAll?: boolean }) {
  on("mcp.call", async (_$: unknown, e: { tool: string; args: Record<string, unknown> }) => {
    calls.push({ tool: e.tool, args: e.args });
    if (e.tool === "scout_status_poll")
      return {
        value: status(
          run.done
            ? { ...RUNNING, phase: "done", now: "Finished", next: [{ kind: "direct", tool: "scout_cards", label: "See the problems", args: {} }] }
            : {
                ...RUNNING,
                ...(run.now === undefined ? {} : { now: run.now }),
                ...(run.seeAll ? { next: [{ kind: "direct", tool: "scout_cards", label: "See the problems", args: {} }] } : {}),
              },
        ),
      };
    if (e.tool === "scout_saved_checks")
      return {
        value: {
          content: [{ type: "text", text: "Saved checks." }],
          structuredContent: { saved: QUEUED_SAVED, refused: [], ...(e.args.action === "run" ? { plan: PLAN } : {}) },
        },
      };
    if (e.tool === "scout_cards")
      return {
        value: {
          content: [{ type: "text", text: "cards" }],
          structuredContent: { cards: [{ id: "f1", title: "Save button does nothing", impact: "Blocks users", page: "/things" }], total: 1 },
        },
      };
    if (e.tool === "scout_feedback") return { value: { content: [{ type: "text", text: "Labelled." }], structuredContent: { findingId: "f1" } } };
    if (e.tool === "scout_recap")
      return {
        value: {
          content: [{ type: "text", text: "SceneScout check" }],
          structuredContent: {
            planId: RUNNING.planId,
            title: "SceneScout check",
            address: "https://staging.example.com",
            date: "2026-10-17",
            rows: [
              ["Pages checked", "14"],
              ["Confirmed fixed", "1"],
            ],
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"></svg>',
            file: (e.args as { save?: boolean }).save ? "/home/u/site/.scenescout/recap.svg" : null,
          },
        },
      };
    // The person's own check, which looks only on their computer: the one the server then shows running.
    if (e.tool === "scout_guided_plan")
      return {
        value: {
          content: [{ type: "text", text: "plan" }],
          structuredContent: { planId: RUNNING.planId, choices: { ...(e.args.choices as object), care: "look-only" }, mode: "observe", confirm: null },
        },
      };
    if (e.tool === "scout_guided_confirm")
      return {
        value: {
          content: [{ type: "text", text: "accepted" }],
          structuredContent: { planId: PLAN.planId, accepted: true, outcome: "accepted", tellPerson: "Thank you.", mode: "safe-write" },
        },
      };
    return { value: { isError: true, content: [{ type: "text", text: "not here" }] } };
  });
}

test("the band above the prompt carries what the check is doing now and its problems, yields to a survey, and opens the panel", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const lines: Array<string | undefined> = [];
  runServer(on, calls, { done: false });
  answerCommands(on);
  engineBeneath(on, lines);
  mock.clock(on, { now: 1_000 });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  // The status line says the same, for a person who keeps neither the panel nor the band in view.
  expect(lines.at(-1)).toBe("SceneScout · Now: Opening /orders · 2 problems so far");
  for (const surface of ["terminal", "desktop"] as const) {
    const band = await $.ui.mount({ ...BAND, surface, props: bandProps() });
    expect(await band.find({ type: "Text", text: /Now: Opening \/orders · 2 problems so far/ })).toBeDefined();
    expect(await band.find({ key: "guided-band-open" })).toBeDefined();
    await band.unmount();
    const survey = await $.ui.mount({ ...BAND, surface, props: bandProps(true) });
    expect(await survey.findAll({ key: "guided-band-open" })).toEqual([]);
    await survey.unmount();
  }
});

test("the band and the status line draw a site's words as plain text, with no terminal codes", async ($, on) => {
  const lines: Array<string | undefined> = [];
  // A step's words can quote the tested page: an escape sequence, a bell and a line break in them are never drawn as codes.
  runServer(on, [], { done: false, now: "\u001b[2J\u001b[31mOpening\u0007 /orders\nnext\u009b1m" });
  answerCommands(on);
  engineBeneath(on, lines);
  mock.clock(on, { now: 1_000 });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  expect(lines.at(-1)).toBe("SceneScout · Now: [2J [31mOpening /orders next 1m · 2 problems so far");
  const band = await $.ui.mount({ ...BAND, surface: "terminal", props: bandProps() });
  expect(await band.find({ type: "Text", text: /^SceneScout · Now: \[2J \[31mOpening \/orders next 1m · 2 problems so far$/ })).toBeDefined();
  expect(await band.find({ key: "guided-band-open" })).toBeDefined();
  await band.unmount();
});

test("a card takes Not a bug or Confirmed, each sent to scout_feedback, and offers the other once one is given", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  runServer(on, calls, { done: true });
  answerCommands(on);
  mock.clock(on, { now: 1_000 });
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  await ui.press({ key: "guided-welcome-follow" });
  await ui.press({ key: "guided-running-see-the-problems" });
  const feedback = () => calls.filter((c) => c.tool === "scout_feedback").map((c) => c.args);
  await ui.press({ key: "guided-results-f1-not-a-bug" });
  expect(feedback()).toEqual([{ id: "f1", verdict: "not-a-bug" }]);
  expect(await ui.find({ type: "Text", text: /You marked this not a bug/ })).toBeDefined();
  expect(await ui.findAll({ key: "guided-results-f1-not-a-bug" })).toEqual([]);
  await ui.press({ key: "guided-results-open-f1" });
  expect(await ui.findAll({ key: "guided-card-not-a-bug" })).toEqual([]);
  await ui.press({ key: "guided-card-confirmed" });
  expect(feedback()).toEqual([
    { id: "f1", verdict: "not-a-bug" },
    { id: "f1", verdict: "confirmed" },
  ]);
  expect(await ui.find({ type: "Text", text: /You confirmed this is a bug/ })).toBeDefined();
  expect(await ui.find({ key: "guided-card-not-a-bug" })).toBeDefined();
  await ui.unmount();
});

test("a queued check starts when the running one ends, on its own plan, and waits for its own confirmation", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const run = { done: false };
  runServer(on, calls, run);
  answerCommands(on);
  engineBeneath(on, []);
  on("prompt.submit", async (_$: unknown, e: { text: string }) => {
    sent.push(e.text);
    return { text: e.text };
  });
  mock.clock(on, { now: 1_000 });
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  await ui.press({ key: "guided-welcome-follow" });
  await ui.press({ key: "guided-queue-another" });
  await ui.press({ key: "guided-queue-add-admin-area" });
  expect(await ui.find({ type: "Text", text: /1\. Admin area · May create test data · asks you to confirm when it starts/ })).toBeDefined();
  expect(await ui.find({ key: "guided-queue-remove-admin-area" })).toBeDefined();
  // While the check runs, nothing starts.
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  expect(calls.some((c) => c.tool === "scout_saved_checks" && c.args.action === "run")).toBe(false);
  const band = await $.ui.mount({ ...BAND, surface: "terminal", props: bandProps() });
  expect(await band.find({ type: "Text", text: /1 queued/ })).toBeDefined();
  await band.unmount();
  // It ends: the queued check's own plan is built, and it waits on the preview; nothing is sent to Claude yet.
  run.done = true;
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  expect(calls.filter((c) => c.tool === "scout_saved_checks" && c.args.action === "run")).toEqual([
    { tool: "scout_saved_checks", args: { action: "run", name: "Admin area" } },
  ]);
  expect(sent).toEqual([]);
  // The person is not moved off what they were reading: Follow it opens the preview.
  expect(await ui.findAll({ key: "guided-confirm-yes" })).toEqual([]);
  await ui.press({ key: "guided-queued-follow" });
  expect(await ui.find({ key: "guided-confirm-yes" })).toMatchObject({ props: { label: "Yes, it is a test copy" } });
  const waiting = await $.ui.mount({ ...BAND, surface: "desktop", props: bandProps() });
  expect(await waiting.find({ type: "Text", text: /"Admin area" is next, and waits for your yes/ })).toBeDefined();
  await waiting.unmount();
  await ui.press({ key: "guided-confirm-yes" });
  expect(calls.filter((c) => c.tool === "scout_guided_confirm")).toEqual([{ tool: "scout_guided_confirm", args: { planId: PLAN.planId } }]);
  expect(sent).toEqual([`Run the SceneScout guided plan ${PLAN.planId}: call scout_guided_plan {planId: "${PLAN.planId}"} and follow it.`]);
  await ui.unmount();
});

test("the panel draws a page's words as plain text, and so does what it prints where nothing draws", async ($, on) => {
  const coded = "\u001b[2J\u001b[31mOpening\u0007 /orders\nnext\u009b1m";
  runServer(on, [], { done: false, now: coded });
  on("command.run", async () => ({}));
  const surfaces = { list: ["desktop"] };
  on("session.surfaces", async () => ({ value: surfaces.list }));
  mock.clock(on, { now: 1_000 });
  const ui = await $.ui.mount({ ...PANE, surface: "terminal", props: PROPS });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  await ui.press({ key: "guided-welcome-follow" });
  expect(await ui.find({ type: "Text", text: /^Now: \[2J \[31mOpening \/orders next 1m$/ })).toBeDefined();
  expect(await ui.findAll({ type: "Text", text: /[\u0000-\u001f\u007f-\u009f]/ })).toEqual([]);
  await ui.unmount();
  surfaces.list = [];
  const printed = (await $.command.run({ command: "scenescout-guided", args: "" } as never)) as { text?: string };
  expect(printed.text).toContain("Now: [2J [31mOpening /orders next 1m");
  expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(printed.text ?? "")).toBe(false);
});

test("a queued check starting while the person reads the results leaves them there, and Save acts on the results' own check; Back on its preview keeps it queued", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const run = { done: false, seeAll: true };
  runServer(on, calls, run);
  answerCommands(on);
  engineBeneath(on, []);
  on("ui.toast", async (_$: unknown, e: { text: string }) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  mock.clock(on, { now: 1_000 });
  on("prompt.submit", async (_$: unknown, e: { text: string }) => ({ text: e.text }));
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  await ui.press({ key: "guided-welcome-check" });
  await ui.input({ key: "guided-config-address", text: "http://localhost:3000" });
  await ui.press({ key: "guided-config-start" });
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  await ui.press({ key: "guided-queue-another" });
  await ui.press({ key: "guided-queue-add-admin-area" });
  // The person opens the problems found so far, and the check ends while they read them.
  await ui.press({ key: "guided-running-see-the-problems" });
  run.done = true;
  // The check ends and the queued one is planned while the results are open: they stay, with Follow it.
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  expect(calls.filter((c) => c.tool === "scout_saved_checks" && c.args.action === "run").length).toBe(1);
  expect(await ui.find({ key: "guided-queued-follow" })).toBeDefined();
  expect(toasts.some((t) => /"Admin area", needs your yes/.test(t))).toBe(true);
  await ui.input({ key: "guided-save-name", text: "Orders" });
  await ui.press({ key: "guided-save-check" });
  expect(calls.filter((c) => c.tool === "scout_saved_checks" && c.args.action === "save").map((c) => c.args)).toEqual([
    { action: "save", name: "Orders", planId: RUNNING.planId },
  ]);
  // Back on its preview: kept first in line, the queue paused, and said in a toast.
  await ui.press({ key: "guided-queued-follow" });
  await ui.press({ key: "guided-confirm-back" });
  expect(toasts.some((t) => /"Admin area" stays first in the queue/.test(t))).toBe(true);
  expect(await ui.find({ key: "guided-queue-resume" })).toBeDefined();
  expect(await ui.find({ key: "guided-queue-remove-admin-area" })).toBeDefined();
  await $.command.run({ command: "scenescout-guided", args: "" } as never);
  expect(calls.filter((c) => c.tool === "scout_saved_checks" && c.args.action === "run").length).toBe(1);
  await ui.unmount();
});

test("before Start, the panel says what a check like this uses and offers a limit, in the unit this Claude Code reports", async ($, on) => {
  runServer(on, [], { done: false });
  answerCommands(on);
  mock.clock(on, { now: 1_000 });
  const usage = { value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: "five_hour", percentUsed: 12 }], cost: { usd: 0.5 } } };
  on("session.usage", async () => usage);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop", props: PROPS });
  await ui.press({ key: "guided-welcome-check" });
  expect(
    await ui.find({ type: "Text", text: /A Normal check uses about 8% of your 5-hour limit: a starting figure until you have run 3 checks like it\./ }),
  ).toBeDefined();
  await ui.press({ key: "guided-config-cap-25" });
  expect(await ui.find({ key: "guided-config-cap-25" })).toMatchObject({ props: { label: "(o) 25% of my 5-hour limit" } });
  // No subscription windows: dollars.
  usage.value = { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0.5 } };
  await ui.press({ key: "guided-config-thorough-quick" });
  expect(await ui.find({ key: "guided-config-cap-5" })).toMatchObject({ props: { label: "( ) $5 of usage" } });
  await ui.unmount();
});

for (const [label, options, shown] of [
  ["off by default", {}, false],
  ["on when set", { game: "on" }, true],
] as const)
  for (const surface of ["terminal", "desktop"] as const)
    test(`${surface}: the end-of-check card shows when a check ends, Save as picture saves it, and the game layer is ${label}`, { options }, async ($, on) => {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      runServer(on, calls, { done: true });
      answerCommands(on);
      mock.clock(on, { now: 1_000 });
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS });
      await $.command.run({ command: "scenescout-guided", args: "" } as never);
      await ui.press({ key: "guided-welcome-follow" });
      expect(await ui.find({ type: "Text", text: /^End-of-check card$/ })).toBeDefined();
      expect(await ui.find({ key: "guided-recap-save" })).toBeDefined();
      await ui.press({ key: "guided-running-see-the-problems" });
      expect((await ui.findAll({ type: "Text", text: /still about/ })).length > 0).toBe(shown);
      // The cards' words are the same either way.
      expect(await ui.find({ type: "Text", text: /Save button does nothing/ })).toBeDefined();
      await ui.press({ key: "guided-recap-save" });
      expect(calls.filter((c) => c.tool === "scout_recap" && c.args.save === true).length).toBe(1);
      expect(calls.filter((c) => c.tool === "scout_recap" && !c.args.save).length).toBe(1);
      await ui.unmount();
    });
