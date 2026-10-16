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
};

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
