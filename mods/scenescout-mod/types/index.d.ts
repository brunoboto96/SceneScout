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
  /** The limit the person set for a check (a share of the 5-hour window, or dollars with no subscription windows), or null for none. */
  cap: number | null;
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
  /** The queued check whose plan waits on the person's yes, previewed or not yet opened, or null. */
  fromQueue: string | null;
  /** A queued check that started, or waits on a yes, while the person was on another screen: the panel offers Follow it. */
  started: string | null;
  /** Whether the queue waits for the person's Go on, after Back on a queued check's preview. */
  queuePaused: boolean;
  /** The plan the results were opened for, which Save this check, Run again and Check them again act on. */
  results: { planId: string | null; plan: Record<string, unknown> | null; lastChoices: Record<string, unknown> | null } | null;
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

/** A ticket SceneScout filed, as scout_ticket_status last read it. */
export type ScenescoutModTicket = {
  id: string;
  title: string;
  where: string;
  ref: string;
  url: string;
  open: boolean;
  finding: "open" | "resolved" | "unknown";
};

/** A check being measured against the person's limit (hooks/run.js's CostWatch). */
export type ScenescoutModCost = {
  planId: string;
  unit: "percent" | "usd";
  kind: string;
  thoroughness: string;
  start: number;
  last: number;
  carried: number;
  cap: number | null;
  warned: boolean;
  stopped: boolean;
  record: boolean;
} | null;

export type ScenescoutModPicture = { id: string; svg?: string; width?: number; height?: number; why?: string } | null;

declare module "claude-code" {
  interface PluginState {
    "scenescout-mod": {
      wizard: ScenescoutModWizard;
      status: ScenescoutModStatus;
      picture: ScenescoutModPicture;
      confirmed: string[];
      tickets: ScenescoutModTicket[] | null;
      cost: ScenescoutModCost;
    };
  }
}
