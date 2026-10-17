// The values the SceneScout mod keeps in the session's $.state, so a reload of
// the mod keeps the panel where it was. hooks/guided.js reads them back through
// wizardOf, which puts anything missing or misshapen back to its default.

export type ScenescoutModNotice = { tone: "info" | "error"; text: string };

export type ScenescoutModDraft = {
  address: string;
  areas: string[];
  journey: string;
  signIn: string;
  care: "look-only" | "may-submit-forms" | "may-create-test-data";
  thoroughness: string;
};

export type ScenescoutModWizard = {
  step: "welcome" | "configuring" | "confirm" | "running" | "results" | "card" | "safety" | "tour";
  draft: ScenescoutModDraft;
  planId: string | null;
  plan: Record<string, unknown> | null;
  busy: string | null;
  notice: ScenescoutModNotice | null;
  cards: Array<Record<string, unknown>> | null;
  cardsTotal: number;
  pictureFiles: Record<string, string>;
  cardId: string | null;
  lastChoices: Record<string, unknown> | null;
  tourPage: number;
  returnTo: ScenescoutModWizard["step"] | null;
  /** The project's saved checks as the welcome lists them (no choices beyond these, and never a credential). */
  saved: Array<{ name: string; address: string; care: string; lastRunAt: string }> | null;
  saveName: string;
  /** The saved check whose Delete was pressed and is waiting on the person's yes. */
  deleting: string | null;
  /** Saved checks waiting to start, one at a time, each with the care level it had when it was queued. */
  queue: ScenescoutModQueued[];
  /** Whether the list of saved checks to queue is open. */
  queuing: boolean;
  /** The queued check whose confirmation the panel is previewing, or null. */
  fromQueue: string | null;
};

export type ScenescoutModQueued = { name: string; address: string; care: ScenescoutModDraft["care"] };

export type ScenescoutModStatus = {
  kind: "loading" | "data" | "text" | "error";
  at?: number;
  data?: Record<string, unknown>;
  text?: string;
  liveUrl?: string | null;
  error?: string;
};

export type ScenescoutModPicture = { id: string; svg?: string; width?: number; height?: number; why?: string } | null;

declare module "claude-code" {
  interface PluginState {
    "scenescout-mod": {
      wizard: ScenescoutModWizard;
      status: ScenescoutModStatus;
      picture: ScenescoutModPicture;
      confirmed: string[];
    };
  }
}
