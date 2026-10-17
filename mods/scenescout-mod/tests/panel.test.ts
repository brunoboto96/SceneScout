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
