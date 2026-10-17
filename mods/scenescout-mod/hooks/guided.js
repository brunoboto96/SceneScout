/**
 * The guided panel's rules, with no mods API in them, so every one is
 * table-tested (scripts/live-test.ts) without Claude Code running.
 *
 * The panel is a wizard for a person who never sees a tool name (design:
 * docs/design/non-technical-assistant.md, sections 2.12 and 4.1): welcome,
 * configuring a check, the confirmation's preview, the running check, the
 * results, one card, the safety explainer, and the error screens. Every
 * sentence it shows is the engine's (`src/engine/guided-words.ts`), copied
 * here because a mod is installed on its own and cannot import the engine;
 * live-test holds each copy equal to the original.
 *
 * The panel never accepts a care level itself. Its confirmation screen is a
 * preview: pressing yes calls `scout_guided_confirm`, whose form the server
 * shows the person, and only their answer there accepts the plan (ADR 24).
 *
 * register.js wires these rules to events: it keeps the wizard in `$.state`,
 * calls the server, and starts or reaches Claude. A drawing here only ever
 * calls `act(type, payload)`, which register.js answers, so a test can press
 * every button and read what it asked for.
 */

// ---- Names ----

/** The command that opens the guided panel. `/scenescout-pane` opens the same one. */
export const GUIDED_COMMAND = "scenescout-guided";
/** The tools a button may call on the server directly: reading cards, labelling one, and the person's own confirmation. */
export const DIRECT_TOOLS = ["scout_cards", "scout_feedback", "scout_guided_confirm"];
export const PLAN_TOOL = "scout_guided_plan";
export const CONFIRM_TOOL = "scout_guided_confirm";
export const CARDS_TOOL = "scout_cards";
export const FEEDBACK_TOOL = "scout_feedback";
/** The labels a person may put on a card, as memory.ts's FEEDBACK_VERDICTS. */
export const FEEDBACK_VERDICTS = ["not-a-bug", "confirmed"];
/** How many saved checks may wait to start after the one that runs. */
export const QUEUE_MAX = 5;
/** The team report: written by the server, with no turn for Claude (design 3.8). Only the results screen's own button calls it. */
export const TEAM_REPORT_TOOL = "scout_team_report";
/** A re-check of the open problems: the server builds its plan, and Claude is handed only its id (design 3.8). Only the results screen's own button calls it. */
export const RECHECK_TOOL = "scout_recheck_plan";
/** The person's saved checks: listed on the welcome, saved from the results, run again or deleted, with no turn for Claude. */
export const SAVED_TOOL = "scout_saved_checks";
/** The longest name a saved check takes, as saved-checks.ts's MAX_SAVED_NAME. */
export const SAVED_NAME_MAX = 60;
/** How many cards the results show at once. */
export const RESULTS_LIMIT = 20;
/** The longest `Svg` source a surface draws. */
export const SVG_SOURCE_MAX = 131072;
/** The widest a card's picture is drawn in the panel, in CSS pixels. */
export const PICTURE_WIDTH = 320;
/** Where a person reads how to fix a server that does not answer. */
export const TROUBLESHOOTING_URL = "https://github.com/brunoboto96/SceneScout/blob/main/docs/guide/Troubleshooting.md";
/** The steps the wizard has. */
export const STEPS = ["welcome", "configuring", "confirm", "running", "results", "card", "safety", "tour"];
/** The `$.store` key that remembers the first-run tour was seen or skipped. One per person, not per project: the tour is about SceneScout, not a site. */
export const TOUR_SEEN_KEY = "tourSeen";

// ---- Words, copied from src/engine/guided-words.ts and src/intake.ts (live-test holds them equal) ----

export const CARES = ["look-only", "may-submit-forms", "may-create-test-data"];
export const THOROUGHNESSES = ["quick", "normal", "thorough"];
/** The areas the panel offers. Tickets are pasted text, which the chat and the start form take. */
export const PANEL_AREAS = ["sign-in", "forms", "broken-pages", "phone", "journey"];

export const CARE_LABEL = {
  "look-only": "Look only",
  "may-submit-forms": "May submit forms",
  "may-create-test-data": "May create test data",
};

export const CARE_EXPLAIN = {
  "look-only":
    "Opens pages and signs in. A form is sent only when all it does is open a page, such as a search; anything that would save something is held back. Links are opened like any page, so a link that changes something just by being opened, such as an unsubscribe link, is not stopped. The safest choice for a live site.",
  "may-submit-forms":
    "Fills in and sends forms, and presses buttons that send something, such as a contact form, a sign-up or a settings page. What it sends can create a record, and can change one that was there, as it would for anyone. Deletes are blocked.",
  "may-create-test-data":
    "Creates records it needs, such as an account or an order. What it sends can also change records that were there, but it deletes only what it created. Use only on a test copy.",
};

export const DESTRUCTIVE_NOT_OFFERED = "Deleting data that was already there needs a developer to ask for it by name.";

export const CARE_PREVIEW = {
  "look-only": [
    "+ open pages, follow links and sign in",
    "+ send a search, or another form that only opens a page",
    "- hold back anything that would save, change or delete something",
    "~ a link that changes something just by being opened, such as an unsubscribe link, is followed like any other",
  ],
  "may-submit-forms": [
    "+ fill in and send forms, and press buttons that send something",
    "~ what it sends can create a record, or change one that was there",
    "- never delete anything",
  ],
  "may-create-test-data": [
    "+ create accounts, orders or other records it needs",
    "~ what it sends can also change a record that was there",
    "~ delete only the records it created",
    "- never delete anything outside its own records",
  ],
};

export const AREA_LABEL = {
  "sign-in": "Sign-up and sign-in",
  forms: "Forms",
  "broken-pages": "Broken pages and links",
  phone: "How it looks on a phone",
  journey: "A journey in a sentence",
  tickets: "Tickets",
};

/** Which areas the start form ticks before the person does, as src/intake.ts's AREA_FIELDS. */
export const AREA_DEFAULT = { "sign-in": true, forms: true, "broken-pages": true, phone: false };

export const HELD_BACK = {
  "sign-in": { "look-only": "Only signing in is tried. Sign-up is looked at but never sent." },
  forms: {
    "look-only": "Forms are filled in and checked. Only a form that just opens a page, such as a search, is sent; one that would save something is never sent.",
  },
  "broken-pages": {},
  phone: {},
  journey: {
    "look-only": "The journey stops at the first step that would save something on your site, and says so.",
    "may-submit-forms": "The journey stops at the first step this care level blocks, such as a delete, and says so.",
    "may-create-test-data": "The journey stops at the first step this care level blocks, such as deleting something it did not create, and says so.",
  },
  tickets: {
    "look-only": "A criterion that needs something saved on your site is marked not tested, and says why.",
    "may-submit-forms": "A criterion that needs a step this care level blocks, such as a delete, is marked not tested, and says why.",
    "may-create-test-data":
      "A criterion that needs a step this care level blocks, such as deleting something it did not create, is marked not tested, and says why.",
  },
};

export const THOROUGHNESS_LABEL = { quick: "Quick look", normal: "Normal", thorough: "Thorough" };

/** How the person signs in, in the start form's words. */
export const SIGN_IN_LABEL = {
  none: "No sign-in",
  sso: "Google or Microsoft single sign-on",
  password: "An email and password",
  "one-time-code": "A one-time code",
};

export const CONFIRM_COMING = {
  "creates-data": "Before it starts, a short form asks you to confirm this is a test copy and to type the code it shows.",
  "forms-on-remote-site": "Before it starts, a short form asks you to confirm that forms may be sent there.",
};

export const CONFIRM_ANSWER = { yes: "Yes, I understand", testCopy: "Yes, it is a test copy", back: "Go back" };

export const CONFIRM_PREVIEW_HEADING = "What this check may do there:";

export const SAFETY_EXPLAINER = [
  `${CARE_LABEL["look-only"]}, the default, opens pages and signs in. A search still runs, because all it does is open a page of results, but nothing that would save something is sent. Links are opened like any page, so a link that changes something just by being opened, such as an unsubscribe link, is not stopped. It is the safest choice for a live site.`,
  `${CARE_LABEL["may-submit-forms"]} sends forms, and presses buttons that send something. What it sends can create a record, or change one that was there, as it would for anyone who sent it; deletes are blocked. On a site that is not on this computer, it asks you first.`,
  `${CARE_LABEL["may-create-test-data"]} creates the records it needs. What it sends can also change records that were there, but it deletes only what it created. It always asks you first, and is for a test copy only.`,
  "Deleting data that was already there is never offered here.",
  "These limits are checked on every request your browser sends, not left to the AI's judgement. A request a care level does not allow never reaches your site. What a care level does allow, a form or a button, does on your site whatever it does for anyone who uses it.",
  "It never asks for your password. When your site needs one, a browser window opens for you to sign in as you normally would.",
];

export const SERVER_ERROR_SENTENCE = "I could not reach the SceneScout server: check that the scenescout plugin is installed and turned on.";

/** The heading over a screen for something that went wrong, and over one that waits on the person. */
export const SCREEN_HEADING = { wentWrong: "Something went wrong", needYou: "I need you" };

/** Which heading each error screen goes under, as guided-words.ts's ERROR_HEADING. */
export const ERROR_HEADING = {
  "server-error": "wentWrong",
  "address-unreachable": "wentWrong",
  "browser-download-failed": "wentWrong",
  "sign-in-expired": "needYou",
  "stopped-by-cap": "wentWrong",
};

export const STARTING_SENTENCE = "Getting ready to start.";

export const ACTION_LABEL = {
  seeAll: "See all problems",
  stop: "Stop",
  recheck: "Check them again",
  plainReport: "Write the report in plain words",
  teamReport: "Make a team report",
  fileTickets: "File as tickets",
  confirm: "Confirm the care level",
  notABug: "Not a bug",
  explain: "Explain more",
  again: "Check again",
  tryAgain: "Try again",
  signInAgain: "Sign in again",
};

export const ACTION_PROMPT = {
  stop: "Stop the SceneScout run now and write what you have.",
  recheck: "Check the open SceneScout problems again: call scout_recheck_plan, follow the plan it returns, and tell me which are gone.",
  plainReport: 'Write the SceneScout report in plain words: scout_report {report: "qa"}.',
  fileTickets:
    "File SceneScout problems as tickets: show me the open ones with scout_cards, ask me which and where (GitHub or Jira), preview them with scout_ticket_preview, then call scout_ticket_file so I confirm in SceneScout's own form.",
  explain: (/** @type {string} */ id) =>
    `Explain SceneScout finding ${id} to me in more detail, in plain words, from its evidence and steps only (scout_cards {ids: ["${id}"]}).`,
  again: (/** @type {string} */ id) => `Check SceneScout finding ${id} again with scout_verify, and tell me whether it is still there.`,
};

/** Whether the saved sign-in lasts the check, as guided-words.ts's SIGN_IN_HEALTH; the plan carries the sentence, and the button's label is ACTION_LABEL.signInAgain, so only the command line is copied. */
export const SIGN_IN_AGAIN_COMMAND = (/** @type {string} */ command) => `To sign in again from a terminal instead: ${command}`;

// ---- The first-run tour: three panels, the panel's own words (the chat has no tour) ----

export const TOUR = [
  {
    title: "What it does",
    body: "SceneScout opens your site in a test browser and goes through it the way a careful tester would: its pages, its forms, signing in, and how it looks on a phone. While it works, it tells you in one sentence what it is doing.",
  },
  {
    title: "How it keeps your data safe",
    body: "It starts in Look only, which opens pages and holds back anything that would save something on your site. Sending forms or creating test data needs you to choose it and then confirm it yourself, and it never asks for your password.",
  },
  {
    title: "What you get",
    body: "Each problem comes back as a card in plain words: what was done, what was expected, what happened, and a picture. You can mark one not a bug, ask for more, or check it again after a fix.",
  },
];

// ---- The panel's own words (no engine original) ----

export const PANEL_WORDS = {
  welcome: "Find what is broken on your site, in plain words.",
  checkSite: "Check a site",
  safety: "How it keeps your data safe",
  newHere: "New here?",
  takeTour: "Take the 30-second tour",
  skipTour: "Skip the tour",
  next: "Next",
  done: "Done",
  isItSafe: "Is it safe on a live site?",
  following: "A check is going:",
  follow: "Follow it",
  lastCheck: "Your last check:",
  runAgain: "Run again",
  newCheck: "New check",
  back: "Back",
  cancel: "Cancel",
  start: "Start",
  address: "Address of the site",
  addressHint: "https://staging.example.com",
  whatToCheck: "What should I check?",
  journey: "The journey, in a sentence",
  journeyHint: "Buy the cheapest item and pay",
  signIn: "Do you need to sign in?",
  careful: "How careful should I be?",
  thorough: "How thorough?",
  willConfirm: "Before it starts, you will be asked to confirm this care level in a form the AI cannot answer.",
  beforeStart: "Before I start",
  watchLive: "Watch it live",
  problemsSoFar: "Problems so far:",
  results: "Results",
  open: "Open",
  seePicture: "See picture",
  pictureNote: "If no picture shows above, use See picture.",
  noPicture: "This problem has no picture.",
  liveView: "See it in the live view",
  whatWasDone: "What was done",
  expected: "What was expected",
  happened: "What happened",
  technical: "Technical detail",
  tryAgain: ACTION_LABEL.tryAgain,
  technicalDetail: "Technical detail",
  howToFix: "How to fix this",
  lookOnly: `Run it as "${CARE_LABEL["look-only"]}"`,
  waitingForm: "A form has opened for you to answer. The check starts only when you say yes there.",
  starting: "Starting the check. Claude is following the plan.",
  mobileCheck: "On this device, type the address in the message box: I have started the message for you.",
  mobileFill: "Check my site with SceneScout. The address is ",
  noCards: "No problems to show.",
  writingTeamReport: "Writing the team report...",
  openReport: "Open the report",
  showFolder: "Show the folder",
  fallbackNext: "Say one of these to Claude:",
  savedChecks: "Saved checks",
  saveName: "Name this check",
  saveHint: "Shop sign-up on a phone",
  saveCheck: "Save this check",
  deleteSaved: "Delete",
  deleteAsk: (/** @type {string} */ name) => `Delete "${name}"?`,
  deleteYes: "Yes, delete it",
  deleteKeep: "Keep it",
  neverRun: "never run again",
  lastRun: "last run",
  rechecking: "Planning the re-check...",
  confirmedBug: "Confirmed",
  markedNotABug: "You marked this not a bug.",
  markedConfirmed: "You confirmed this is a bug.",
  queueAnother: "Queue another check",
  queuePick: "Which saved check should start when this one ends?",
  queueIt: "Queue it",
  queueClose: "Done",
  queueHeading: "Waiting to start, one at a time:",
  queueRemove: "Remove",
  queueWillAsk: "asks you to confirm when it starts",
  queueNoSaved: "Only a saved check can wait here: save one from its results first.",
  queueFull: `At most ${QUEUE_MAX} checks can wait.`,
  queueAlready: (/** @type {string} */ name) => `"${name}" is already waiting.`,
  queueAdded: (/** @type {string} */ name) => `"${name}" will start when this check ends.`,
  queuedStarted: (/** @type {string} */ name) => `"${name}" has started from the queue.`,
  queuedWaits: (/** @type {string} */ name) => `"${name}" is next, and waits for your yes.`,
  queuePaused: "The queue is paused: nothing in it starts until you go on.",
  queueResume: "Go on",
  capHeading: "Stop the check at",
  ticketsHeading: "Tickets SceneScout filed:",
  ticketOpen: "open",
  ticketClosed: "closed",
  ticketFixed: "fixed and confirmed",
};

/** Impact, as a short mark in front of a card's title. */
export const IMPACT_MARK = { "Blocks users": "!", Annoying: "~", Cosmetic: ".", "Worth a look": "?" };

// ---- The wizard ----

/** @typedef {"look-only" | "may-submit-forms" | "may-create-test-data"} Care */
/** @typedef {{ address: string, areas: string[], journey: string, signIn: string, care: Care, thoroughness: string, cap: number | null }} Draft */
/** @typedef {{ tone: "info" | "error", text: string }} Notice */
/**
 * @typedef {{
 *   step: string,
 *   draft: Draft,
 *   planId: string | null,
 *   plan: any,
 *   busy: string | null,
 *   notice: Notice | null,
 *   cards: any[] | null,
 *   cardsTotal: number,
 *   pictureFiles: Record<string, string>,
 *   teamReport: { path: string, folder: string } | null,
 *   cardId: string | null,
 *   lastChoices: any,
 *   tourPage: number,
 *   returnTo: string | null,
 *   saved: SavedEntry[] | null,
 *   saveName: string,
 *   deleting: string | null,
 *   queue: QueuedCheck[],
 *   queuing: boolean,
 *   fromQueue: string | null,
 *   started: string | null,
 *   queuePaused: boolean,
 *   results: ResultsPlan | null,
 * }} Wizard
 */
/** The plan the results screen shows, kept apart from the panel's current one, which a queued check's start replaces. @typedef {{ planId: string | null, plan: any, lastChoices: any }} ResultsPlan */
/** @typedef {{ name: string, address: string, care: string, lastRunAt: string }} SavedEntry */
/** A saved check waiting to start, with the care level it had when the person queued it. @typedef {{ name: string, address: string, care: Care }} QueuedCheck */

/** A fresh check's choices: the start form's defaults, Look only and Normal. */
export function defaultDraft() {
  return {
    address: "",
    areas: PANEL_AREAS.filter((a) => AREA_DEFAULT[/** @type {keyof typeof AREA_DEFAULT} */ (a)] === true),
    journey: "",
    signIn: "none",
    care: /** @type {Care} */ ("look-only"),
    thoroughness: "normal",
    // No limit unless the person sets one (design 2.11); never sent to the server, which plans by choices alone.
    cap: /** @type {number | null} */ (null),
  };
}

/** @returns {Wizard} */
export function initialWizard() {
  return {
    step: "welcome",
    draft: defaultDraft(),
    planId: null,
    plan: null,
    busy: null,
    notice: null,
    cards: null,
    cardsTotal: 0,
    pictureFiles: {},
    teamReport: null,
    cardId: null,
    lastChoices: null,
    tourPage: 0,
    returnTo: null,
    saved: null,
    saveName: "",
    deleting: null,
    queue: [],
    queuing: false,
    fromQueue: null,
    started: null,
    queuePaused: false,
    results: null,
  };
}

/** @param {unknown} v */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** @param {unknown} v */
function str(v) {
  return typeof v === "string" ? v : "";
}
/** @param {unknown} v */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---- Text from the tested page, made plain ----

/**
 * C0 and C1 control characters, DEL, and the bidirectional overrides: what a
 * terminal would read as a code rather than draw. A step's words, a card's
 * title and a saved check's name can quote the tested page or be typed, so
 * nothing the mod draws or prints carries them.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;
/** A run of control characters with the spaces on either side of it. */
const CONTROL_RUN = new RegExp(` *(?:${CONTROL.source})+ *`, "g");

/**
 * Text as the panel draws it: each run of control characters, with the
 * spaces beside it, one space. The panel's own spacing (an indent, the gap
 * between a name and an address) is kept.
 */
export function plainText(/** @type {string} */ t) {
  return t.replace(CONTROL_RUN, " ");
}

/** A line as plain text: each run of control characters a space, and the spaces it leaves collapsed. */
export function plainLine(/** @type {string} */ line) {
  return plainText(line).replace(/ {2,}/g, " ").trim();
}

/**
 * A wizard read back from `$.state`, with anything missing or of the wrong
 * shape put back to its default, so a value an older version wrote never
 * breaks the drawing.
 *
 * @param {unknown} value
 * @returns {Wizard}
 */
export function wizardOf(value) {
  const base = initialWizard();
  if (!isRecord(value)) return base;
  const draft = isRecord(value.draft) ? value.draft : {};
  return {
    step: STEPS.includes(str(value.step)) ? str(value.step) : base.step,
    draft: {
      address: str(draft.address),
      areas: Array.isArray(draft.areas) ? draft.areas.filter((a) => PANEL_AREAS.includes(a)) : base.draft.areas,
      journey: str(draft.journey),
      signIn: Object.hasOwn(SIGN_IN_LABEL, str(draft.signIn)) ? str(draft.signIn) : base.draft.signIn,
      care: /** @type {Care} */ (CARES.includes(str(draft.care)) ? str(draft.care) : base.draft.care),
      thoroughness: THOROUGHNESSES.includes(str(draft.thoroughness)) ? str(draft.thoroughness) : base.draft.thoroughness,
      cap: typeof draft.cap === "number" && Number.isFinite(draft.cap) && draft.cap > 0 ? draft.cap : null,
    },
    planId: str(value.planId) || null,
    plan: isRecord(value.plan) ? value.plan : null,
    busy: str(value.busy) || null,
    notice:
      isRecord(value.notice) && (value.notice.tone === "info" || value.notice.tone === "error")
        ? { tone: value.notice.tone, text: str(value.notice.text) }
        : null,
    cards: Array.isArray(value.cards) ? value.cards.filter(isRecord) : null,
    cardsTotal: num(value.cardsTotal),
    pictureFiles: isRecord(value.pictureFiles) ? /** @type {Record<string, string>} */ (value.pictureFiles) : {},
    teamReport: isRecord(value.teamReport) ? teamReportPlace(value.teamReport.path, value.teamReport.folder) : null,
    cardId: str(value.cardId) || null,
    lastChoices: isRecord(value.lastChoices) ? value.lastChoices : null,
    tourPage: Math.min(TOUR.length - 1, Math.max(0, Math.floor(num(value.tourPage)))),
    returnTo: STEPS.includes(str(value.returnTo)) && str(value.returnTo) !== "safety" ? str(value.returnTo) : null,
    saved: Array.isArray(value.saved) ? savedEntries(value.saved) : null,
    saveName: str(value.saveName).slice(0, SAVED_NAME_MAX),
    deleting: str(value.deleting).slice(0, SAVED_NAME_MAX) || null,
    queue: Array.isArray(value.queue) ? queueEntries(value.queue) : [],
    queuing: value.queuing === true,
    fromQueue: str(value.fromQueue).slice(0, SAVED_NAME_MAX) || null,
    started: str(value.started).slice(0, SAVED_NAME_MAX) || null,
    queuePaused: value.queuePaused === true,
    results: isRecord(value.results)
      ? {
          planId: str(value.results.planId) || null,
          plan: isRecord(value.results.plan) ? value.results.plan : null,
          lastChoices: isRecord(value.results.lastChoices) ? value.results.lastChoices : null,
        }
      : null,
  };
}

/**
 * The plan the results act on: the one they were opened for (Save this
 * check, Run again and Check them again use it), or, for a wizard saved before
 * the results kept one, the panel's current plan.
 *
 * @param {Wizard} w
 * @returns {ResultsPlan}
 */
export function resultsPlan(w) {
  return w.results ?? { planId: w.planId, plan: w.plan, lastChoices: w.lastChoices };
}

/** The results opened for the panel's current plan, which they keep whatever starts after. @param {Wizard} w @returns {Wizard} */
export function openResults(w) {
  return { ...w, step: "results", notice: null, results: { planId: w.planId, plan: w.plan, lastChoices: w.lastChoices } };
}

/**
 * The queued check whose plan waits on the person's yes, put back at the head
 * of the queue, from its plan's choices: a preview left with Back, or a plan
 * of the person's own built over it, never drops it.
 *
 * @param {Wizard} w
 * @returns {Wizard}
 */
export function requeued(w) {
  if (!w.fromQueue) return w;
  const choices = isRecord(w.plan) && isRecord(w.plan.choices) ? w.plan.choices : {};
  const entry = { name: w.fromQueue, address: str(choices.address), care: str(choices.care) };
  return { ...w, queue: queueEntries([entry, ...w.queue.filter((q) => q.name !== w.fromQueue)]), fromQueue: null, started: null };
}

/**
 * The queue as the panel keeps it: entries with a name, an address and a
 * care level the panel knows, each name once, at most QUEUE_MAX.
 *
 * @param {unknown[]} list
 * @returns {QueuedCheck[]}
 */
export function queueEntries(list) {
  /** @type {QueuedCheck[]} */
  const out = [];
  for (const q of list.filter(isRecord)) {
    const name = str(q.name).slice(0, SAVED_NAME_MAX);
    if (!name || !str(q.address) || !CARES.includes(str(q.care)) || out.some((x) => x.name === name)) continue;
    out.push({ name, address: str(q.address), care: /** @type {Care} */ (str(q.care)) });
    if (out.length === QUEUE_MAX) break;
  }
  return out;
}

/**
 * Saved checks as the panel lists them, from the server's answer or the
 * panel's state: only entries with a name and an address are kept.
 *
 * @param {unknown[]} list
 * @returns {SavedEntry[]}
 */
export function savedEntries(list) {
  return list
    .filter(isRecord)
    .map((c) => {
      const choices = isRecord(c.choices) ? c.choices : c;
      return { name: str(c.name).slice(0, SAVED_NAME_MAX), address: str(choices.address), care: str(choices.care), lastRunAt: str(c.lastRunAt) };
    })
    .filter((c) => c.name && c.address);
}

/**
 * Each saved check's test id part: its name in lower case with anything but
 * letters and digits as dashes, made unique by its place where two read alike.
 *
 * @param {SavedEntry[]} saved
 */
export function savedKeys(saved) {
  /** @type {string[]} */
  const keys = [];
  saved.forEach((c, i) => {
    const slug =
      c.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "check";
    keys.push(keys.includes(slug) ? `${slug}-${i}` : slug);
  });
  return keys;
}

/**
 * The wizard after a press that needs nothing from the server or Claude.
 * Anything else (`build`, `confirm`, `send`, ...) is register.js's, and
 * leaves the wizard as it is here.
 *
 * @param {Wizard} w
 * @param {{ type: string, [k: string]: any }} action
 * @returns {Wizard}
 */
export function reduce(w, action) {
  let next = step(w, action);
  // A delete question belongs to the welcome's list: leaving the welcome drops it, so it is not waiting when the person comes back.
  if (w.step === "welcome" && next.step !== "welcome" && next.deleting) next = { ...next, deleting: null };
  // The list to queue from belongs to the running check: leaving it closes the list, and keeps the queue.
  if (next.step !== w.step && next.queuing) next = { ...next, queuing: false };
  return next;
}

/**
 * @param {Wizard} w
 * @param {{ type: string, [k: string]: any }} action
 * @returns {Wizard}
 */
function step(w, action) {
  switch (action.type) {
    case "go":
      if (!STEPS.includes(action.step)) return w;
      // The explainer goes back to where it was opened from: the welcome, or a check being set up, whose choices are kept.
      if (action.step === "safety") return { ...w, step: "safety", returnTo: w.step === "safety" ? w.returnTo : w.step, notice: null, busy: null };
      // Going to the running check follows it: a queued start's Follow it is then said.
      return { ...w, step: action.step, notice: null, busy: null, started: action.step === "running" ? null : w.started };
    // A queued check waiting on a yes keeps its place in the queue: its plan is about to be cleared.
    case "newCheck":
      return { ...requeued(w), step: "configuring", draft: defaultDraft(), planId: null, plan: null, notice: null, busy: null };
    case "address":
      return { ...w, draft: { ...w.draft, address: String(action.value ?? "").slice(0, 2048) } };
    case "journey":
      return { ...w, draft: { ...w.draft, journey: String(action.value ?? "").slice(0, 500) } };
    case "toggleArea": {
      if (!PANEL_AREAS.includes(action.area)) return w;
      const on = w.draft.areas.includes(action.area);
      const areas = on ? w.draft.areas.filter((a) => a !== action.area) : PANEL_AREAS.filter((a) => a === action.area || w.draft.areas.includes(a));
      return { ...w, draft: { ...w.draft, areas } };
    }
    case "care":
      return CARES.includes(action.value) ? { ...w, draft: { ...w.draft, care: action.value } } : w;
    case "cap": {
      const v = action.value;
      return { ...w, draft: { ...w.draft, cap: typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null } };
    }
    case "thoroughness":
      return THOROUGHNESSES.includes(action.value) ? { ...w, draft: { ...w.draft, thoroughness: action.value } } : w;
    case "signIn":
      return Object.hasOwn(SIGN_IN_LABEL, action.value) ? { ...w, draft: { ...w.draft, signIn: action.value } } : w;
    case "follow":
      return { ...w, step: "running", planId: str(action.planId) || w.planId, notice: null };
    case "openCard":
      return { ...w, step: "card", cardId: str(action.id) || null, notice: null };
    case "dismiss":
      return { ...w, notice: null };
    case "saveName":
      return { ...w, saveName: String(action.value ?? "").slice(0, SAVED_NAME_MAX) };
    // Delete asks first, so a misplaced press deletes nothing.
    case "askDelete":
      return { ...w, deleting: str(action.name).slice(0, SAVED_NAME_MAX) || null, notice: null };
    case "keepSaved":
      return { ...w, deleting: null };
    case "tour":
      return { ...w, step: "tour", tourPage: 0, notice: null, busy: null };
    case "tourNext":
      return w.step === "tour" ? { ...w, tourPage: Math.min(TOUR.length - 1, w.tourPage + 1) } : w;
    case "tourBack":
      return w.step === "tour" ? { ...w, tourPage: Math.max(0, w.tourPage - 1) } : w;
    case "tourDone":
      return w.step === "tour" ? { ...w, step: "welcome", tourPage: 0 } : w;
    case "queuePick":
      return { ...w, queuing: !w.queuing, notice: !w.queuing && !(w.saved ?? []).length ? { tone: "info", text: PANEL_WORDS.queueNoSaved } : null };
    case "queueAdd":
      return queueAdd(w, str(action.name));
    case "queueRemove": {
      const queue = w.queue.filter((q) => q.name !== str(action.name));
      return { ...w, queue, queuePaused: queue.length > 0 && w.queuePaused, notice: null };
    }
    // Follow a queued check that started while the person was elsewhere: its preview when it waits on their yes.
    case "followQueued":
      return { ...w, step: w.fromQueue ? "confirm" : "running", started: null, notice: null };
    // Back on a queued check's preview: kept, first in line, and the queue waits for the person to go on.
    case "queueBack":
      return w.fromQueue ? { ...requeued(w), step: "welcome", queuePaused: true, notice: null, busy: null } : w;
    case "queueResume":
      return { ...w, queuePaused: false, notice: null };
    default:
      return w;
  }
}

/**
 * A saved check put at the end of the queue, with the care level and the
 * address the saved check has now: those are what it starts with, and a
 * saved check changed to another care level before it starts does not start
 * (run.js's afterQueuedRun). A name already waiting, one the welcome does not
 * list, or a full queue changes nothing but the notice.
 *
 * @param {Wizard} w
 * @param {string} name
 * @returns {Wizard}
 */
function queueAdd(w, name) {
  const saved = (w.saved ?? []).find((c) => c.name === name);
  if (!saved || !CARES.includes(saved.care)) return { ...w, notice: { tone: "error", text: PANEL_WORDS.queueNoSaved } };
  if (w.queue.some((q) => q.name === name) || w.fromQueue === name) return { ...w, notice: { tone: "info", text: PANEL_WORDS.queueAlready(name) } };
  // A queued check waiting on a yes still holds its place: Back puts it first in line again.
  if (w.queue.length + (w.fromQueue ? 1 : 0) >= QUEUE_MAX) return { ...w, notice: { tone: "error", text: PANEL_WORDS.queueFull } };
  const entry = { name, address: saved.address, care: /** @type {Care} */ (saved.care) };
  return { ...w, queue: [...w.queue, entry], queuing: false, notice: { tone: "info", text: PANEL_WORDS.queueAdded(name) } };
}

/**
 * The labels a card offers: Not a bug and Confirmed, less the one the person
 * already gave it, so they can change their mind but not give the same twice.
 *
 * @param {any} card
 * @returns {string[]}
 */
export function feedbackChoices(card) {
  const given = isRecord(card) && isRecord(card.feedback) ? str(card.feedback.verdict) : "";
  return FEEDBACK_VERDICTS.filter((v) => v !== given);
}

/** A label's button text. */
export function feedbackLabel(/** @type {string} */ verdict) {
  return verdict === "confirmed" ? PANEL_WORDS.confirmedBug : ACTION_LABEL.notABug;
}

/**
 * Whether opening the panel starts the tour: only for a person who has not
 * seen or skipped it, and only on the welcome, so a check being set up or
 * followed is never interrupted. A store that could not be read (an older
 * Claude Code) counts as seen, so nobody is shown the tour on every open.
 *
 * A check going on (a guided one, or sessions the run pane lists) that the
 * welcome would show is not covered by the tour either.
 *
 * @param {unknown} seen what `$.store` holds under TOUR_SEEN_KEY, or an Error when it could not be read
 * @param {Wizard} w
 * @param {{ kind: string, data?: any }} status the server's latest status
 */
export function startsTour(seen, w, status) {
  if (seen instanceof Error) return false;
  const going = guidedOf(status, null) !== null || (isRecord(status.data) && Array.isArray(status.data.sessions) && status.data.sessions.length > 0);
  return seen !== true && w.step === "welcome" && !going;
}

/** Whether an address is on this computer: only localhost, 127.0.0.1 and ::1 are (as guided.ts's isLocalAddress). */
export function isLocalAddress(/** @type {string} */ address) {
  let host;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Whether a care level on an address will ask the person to confirm it, as guided.ts's confirmationReason. */
export function confirmReason(/** @type {Care} */ care, /** @type {string} */ address) {
  if (care === "may-create-test-data") return "creates-data";
  if (care === "may-submit-forms" && !isLocalAddress(address)) return "forms-on-remote-site";
  return null;
}

/**
 * The choices to send to scout_guided_plan, or the one sentence that says
 * what is missing. The server checks them in full; this only catches what the
 * person can fix before a round trip.
 *
 * @param {Draft} draft
 * @returns {{ ok: true, choices: Record<string, unknown> } | { ok: false, error: string }}
 */
export function choicesFromDraft(draft) {
  const address = draft.address.trim();
  if (!address) return { ok: false, error: "Type the address of the site first, starting with http:// or https://." };
  if (!/^https?:\/\//i.test(address)) return { ok: false, error: "Write the address in full, starting with http:// or https://." };
  const areas = PANEL_AREAS.filter((a) => draft.areas.includes(a));
  if (areas.length === 0) return { ok: false, error: "Choose at least one thing to check." };
  const journey = draft.journey.trim();
  if (areas.includes("journey") && !journey) return { ok: false, error: "Describe the journey in a sentence, or untick it." };
  /** @type {Record<string, unknown>} */
  const choices = { address, areas, signIn: draft.signIn, care: draft.care, thoroughness: draft.thoroughness };
  if (areas.includes("journey")) choices.journey = journey;
  return { ok: true, choices };
}

// ---- What the server answered ----

/** The text blocks of a tool result, joined. */
export function resultText(/** @type {any} */ result) {
  const blocks = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** The server's refusal as a person reads it: its first line, with the error prefix the server adds taken off. */
export function errorSentence(/** @type {any} */ result) {
  const first = resultText(result)
    .split("\n")[0]
    .replace(/^Error:\s*/i, "");
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "The SceneScout server could not do that.";
}

/** The message to start Claude on a plan the panel built (design 3.8). */
export function startPrompt(/** @type {string} */ planId) {
  return `Run the SceneScout guided plan ${planId}: call scout_guided_plan {planId: "${planId}"} and follow it.`;
}

/**
 * The confirmation, when the form could not be shown from the panel's own
 * call: Claude makes the call instead, and the person still answers the
 * server's form (ADR 24). Claude starts only on an accepted plan.
 */
export function confirmByClaudePrompt(/** @type {string} */ planId) {
  return `Ask me to confirm the SceneScout guided plan ${planId}: call scout_guided_confirm {planId: "${planId}"}. Only if it says the plan is accepted, call scout_guided_plan {planId: "${planId}"} and follow it; otherwise tell me what it said and stop.`;
}

/**
 * What a press does after scout_guided_plan answered: show the confirmation's
 * preview, or start Claude on a plan that needs none.
 *
 * @param {Wizard} w
 * @param {any} result
 * @returns {{ wizard: Wizard, send?: string }}
 */
export function afterPlan(w, result) {
  const plan = isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : null;
  if (!plan || result.isError === true || !str(plan.planId)) return { wizard: { ...w, busy: null, notice: { tone: "error", text: errorSentence(result) } } };
  // A re-check's choices name no area, so Run again keeps the last check that did.
  // A queued check still waiting on a yes goes back to the head of the queue rather than away.
  const next = {
    ...requeued(w),
    busy: null,
    notice: null,
    fromQueue: null,
    started: null,
    planId: str(plan.planId),
    plan,
    lastChoices: isRecord(plan.choices) && !isRecord(plan.recheck) ? plan.choices : w.lastChoices,
  };
  if (isRecord(plan.confirm) && plan.confirm.accepted !== true) return { wizard: { ...next, step: "confirm" } };
  return { wizard: { ...next, step: "running", notice: { tone: "info", text: PANEL_WORDS.starting } }, send: startPrompt(str(plan.planId)) };
}

/**
 * What the person's answer in the server's form came to. Accepted starts
 * Claude; a form the panel's call could not show is handed to Claude, whose
 * call shows the same form; anything else stays on the preview with the
 * server's words and the offer of Look only.
 *
 * @param {Wizard} w
 * @param {any} result
 * @returns {{ wizard: Wizard, send?: string }}
 */
export function afterConfirm(w, result) {
  const c = isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : null;
  const planId = w.planId ?? "";
  if (!c || result.isError === true) return { wizard: { ...w, busy: null, notice: { tone: "error", text: errorSentence(result) } } };
  if (c.accepted === true)
    return {
      wizard: {
        ...w,
        busy: null,
        step: "running",
        fromQueue: null,
        started: null,
        plan: w.plan ? { ...w.plan, confirm: { ...w.plan.confirm, accepted: true } } : w.plan,
        notice: { tone: "info", text: str(c.tellPerson) },
      },
      send: startPrompt(planId),
    };
  if (c.outcome === "failed")
    return {
      wizard: { ...w, busy: null, step: "running", fromQueue: null, started: null, notice: { tone: "info", text: PANEL_WORDS.waitingForm } },
      send: confirmByClaudePrompt(planId),
    };
  return { wizard: { ...w, busy: null, step: "confirm", notice: { tone: "error", text: str(c.tellPerson) || errorSentence(result) } } };
}

/**
 * What scout_saved_checks answered: the project's saved checks, and the plan
 * a run built, or the server's refusal.
 *
 * @param {any} result
 * @returns {{ ok: true, saved: SavedEntry[], plan: any, said: string } | { ok: false, error: string }}
 */
export function readSaved(result) {
  const s = isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : null;
  if (!s || result.isError === true || !Array.isArray(s.saved)) return { ok: false, error: errorSentence(result) };
  return { ok: true, saved: savedEntries(s.saved), plan: isRecord(s.plan) ? s.plan : null, said: resultText(result).split("\n")[0] };
}

/**
 * After a saved check was run again: the list as it now stands, then the plan
 * as any other the panel built, so its confirmation is asked again where its
 * care level needs one.
 *
 * @param {Wizard} w
 * @param {any} result
 * @returns {{ wizard: Wizard, send?: string }}
 */
export function afterSavedRun(w, result) {
  const read = readSaved(result);
  if (!read.ok || !read.plan) return { wizard: { ...w, busy: null, notice: { tone: "error", text: read.ok ? errorSentence(result) : read.error } } };
  return afterPlan({ ...w, saved: read.saved }, { structuredContent: read.plan });
}

/**
 * The cards scout_cards sent, and where each picture is on disk: the result's
 * text names it, one card per text block after the first, in the cards' order.
 *
 * @param {any} result
 * @returns {{ ok: true, cards: any[], total: number, pictureFiles: Record<string, string> } | { ok: false, error: string }}
 */
export function readCards(result) {
  const s = isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : null;
  if (!s || result.isError === true || !Array.isArray(s.cards)) return { ok: false, error: errorSentence(result) };
  const cards = s.cards.filter(isRecord);
  const texts = (Array.isArray(result.content) ? result.content : []).filter((b) => isRecord(b) && b.type === "text").map((b) => str(b.text));
  /** @type {Record<string, string>} */
  const pictureFiles = {};
  cards.forEach((card, i) => {
    const text = texts[i + 1] ?? "";
    if (!text.includes(`(id ${str(card.id)}:`)) return;
    // The card's text carries the tested app's words, which may hold a "Picture:" line of their own:
    // only the line naming this card's own picture, inside .scenescout/, is taken.
    const own = isRecord(card.picture) ? str(card.picture.file) : "";
    const file = [...text.matchAll(/^Picture: (.+)$/gm)].map((m) => m[1].trim()).find((f) => isOwnPicture(f, own));
    if (file) pictureFiles[str(card.id)] = file;
  });
  return { ok: true, cards, total: num(s.total), pictureFiles };
}

/**
 * Whether `file` is the card's own picture: the absolute path of `relative`
 * (the card's `picture.file`) inside a `.scenescout/` folder, as the server
 * names it, with no segment that climbs out.
 *
 * @param {string} file
 * @param {string} relative
 */
export function isOwnPicture(file, relative) {
  const rel = relative.replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || !/\.(png|jpe?g)$/i.test(rel)) return false;
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) return false;
  const abs = file.replace(/\\/g, "/");
  return abs.endsWith(`/.scenescout/${rel}`) && !abs.split("/").some((s) => s === "." || s === "..");
}

/**
 * Where scout_team_report wrote the page and its evidence folder, and the line
 * to tell the person, or the error. Only absolute paths of a page named
 * team-report.html, and its folder, inside a `.scenescout/` folder are taken.
 *
 * @param {any} result
 * @returns {{ ok: true, path: string, folder: string, said: string } | { ok: false, error: string }}
 */
export function readTeamReport(result) {
  const s = isRecord(result) && isRecord(result.structuredContent) ? result.structuredContent : null;
  if (!s || result.isError === true) return { ok: false, error: errorSentence(result) };
  const place = teamReportPlace(s.path, s.folder);
  if (!place) return { ok: false, error: "The SceneScout server did not say where it wrote the team report." };
  return { ok: true, ...place, said: resultText(result).split("\n")[0] };
}

/**
 * The team report's page and folder, when they are absolute paths of a page
 * named team-report.html inside a `.scenescout/` folder and that page's own
 * folder; else null. The server's answer and the saved panel state are both
 * held to it, so nothing else is ever offered as a link.
 *
 * @param {unknown} pagePath
 * @param {unknown} folderPath
 * @returns {{ path: string, folder: string } | null}
 */
export function teamReportPlace(pagePath, folderPath) {
  const page = str(pagePath).replace(/\\/g, "/");
  const folder = str(folderPath).replace(/\\/g, "/");
  if (!fileHref(pagePath) || !fileHref(folderPath) || !page.endsWith("/.scenescout/team-report.html") || folder !== page.replace(/\.html$/, "")) return null;
  return { path: str(pagePath), folder: str(folderPath) };
}

/** A `file:` address for a picture on disk, or null for anything that is not an absolute path. */
export function fileHref(/** @type {unknown} */ file) {
  if (typeof file !== "string" || file.length === 0 || file.length > 1024) return null;
  if (/[\u0000-\u001f]/.test(file)) return null;
  const posix = file.startsWith("/");
  const windows = /^[A-Za-z]:[\\/]/.test(file);
  if (!posix && !windows) return null;
  const path = file.replace(/\\/g, "/");
  const encoded = path
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29")))
    .join("/")
    .replace(/^([A-Za-z])%3A/, "$1:");
  return `file://${posix ? "" : "/"}${encoded}`;
}

/**
 * The picture probe (design 4.1, "Pictures, again"): a card's picture, sent
 * inline by scout_cards, wrapped in an `Svg` the desktop may draw. Only a PNG
 * whose data is plain base64 and whose wrapper fits the element's limit is
 * drawn; otherwise the reason, and the panel keeps its links.
 *
 * @param {any} result scout_cards' answer for one id, pictures "inline"
 * @param {{ width?: number, height?: number } | null | undefined} size the card's picture size
 * @returns {{ svg: string, width: number, height: number } | { why: string }}
 */
export function pictureSvg(result, size) {
  const blocks = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const image = blocks.find((b) => isRecord(b) && b.type === "image");
  if (!image) return { why: "the server sent no picture" };
  if (image.mimeType !== "image/png" || typeof image.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))
    return { why: "the picture is not a PNG" };
  const w0 = num(size?.width) || PICTURE_WIDTH;
  const h0 = num(size?.height) || Math.round(PICTURE_WIDTH * 0.75);
  const width = Math.min(PICTURE_WIDTH, w0);
  const height = Math.max(1, Math.round((h0 * width) / w0));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/png;base64,${image.data}" width="${width}" height="${height}"/></svg>`;
  if (svg.length > SVG_SOURCE_MAX) return { why: "the picture is too large to draw here" };
  return { svg, width, height };
}

// ---- Buttons that reach the server or Claude ----

/**
 * What one of the engine's GuidedActions does from the panel: a call on the
 * server (only the three tools a button may call), a message to Claude, or
 * nothing for anything else.
 *
 * @param {unknown} action
 * @returns {{ kind: "call", tool: string, args: Record<string, unknown> } | { kind: "send", text: string } | null}
 */
export function actionEffect(action) {
  if (!isRecord(action)) return null;
  if (action.kind === "direct" && DIRECT_TOOLS.includes(str(action.tool)) && isRecord(action.args))
    return { kind: "call", tool: str(action.tool), args: action.args };
  if (action.kind === "prompt" && str(action.text)) return { kind: "send", text: str(action.text) };
  return null;
}

/**
 * How a message reaches Claude: a turn of its own while Claude is idle, or a
 * row the running turn reads at its next step (design 4.1.1).
 *
 * @param {boolean} isWorking
 */
export function sendRoute(isWorking) {
  return isWorking ? "append" : "submit";
}

/**
 * Whether a `turn.complete` ends Claude's own turn. A subagent's run (a
 * SceneScout lane) raises one too, with its `agentId`, while the main turn
 * goes on; it raises no `turn.start`.
 *
 * @param {unknown} e the `turn.complete` input
 */
export function endsMainTurn(e) {
  return !(isRecord(e) && str(e.agentId));
}

/** The buttons on a card, as the engine's cardActions builds them. */
export function cardActions(/** @type {string} */ id) {
  return [
    { kind: "direct", label: ACTION_LABEL.notABug, tool: "scout_feedback", args: { id, verdict: "not-a-bug" } },
    { kind: "prompt", label: ACTION_LABEL.explain, text: ACTION_PROMPT.explain(id) },
    { kind: "prompt", label: ACTION_LABEL.again, text: ACTION_PROMPT.again(id) },
  ];
}

// ---- The guard before Claude's own writing calls ----

/** The write modes above looking only. */
const WRITING_MODES = ["read-only", "safe-write", "destructive"];

/**
 * Whether a tool call Claude is about to make needs the person's say-so first
 * (design 6.3): `scout_attach` in a mode that writes, unless it names a plan
 * the person already started or confirmed from the panel, and filing tickets. Null to
 * let it through. The server's own form stays the rule; this is a reminder
 * at the mod's level.
 *
 * @param {{ tool?: unknown, mode?: unknown, url?: unknown, planId?: unknown }} call
 * @param {readonly string[]} confirmedPlans plan ids the person started or confirmed in the panel
 * @returns {{ question: string, allow: string, refuse: string, deny: string } | null}
 */
export function guardFor(call, confirmedPlans) {
  const tool = str(call.tool);
  const name = tool.startsWith("mcp__") ? tool.slice(tool.lastIndexOf("__") + 2) : "";
  if (name === "scout_attach") {
    // scout_attach defaults to read-only when no mode is given, so a call without one sends things too.
    const mode = str(call.mode) || "read-only";
    if (!WRITING_MODES.includes(mode)) return null;
    if (str(call.planId) && confirmedPlans.includes(str(call.planId))) return null;
    const where = str(call.url).slice(0, 200) || "the site";
    const level = mode === "read-only" ? CARE_LABEL["may-submit-forms"] : mode === "safe-write" ? CARE_LABEL["may-create-test-data"] : "may delete data";
    return {
      question: `Claude wants to open ${where} in SceneScout's "${mode}" mode (${level}). It may send things to that site. Let it?`,
      allow: "Let it",
      refuse: "Stop it",
      deny: `The person did not agree to scout_attach in "${mode}" mode. Do not retry it; ask the person what they want, or attach in "observe" mode.`,
    };
  }
  if (name === "scout_ticket_file") {
    return {
      question: "Claude wants to file SceneScout's problems as tickets in your tracker. Let it?",
      allow: "Let it",
      refuse: "Stop it",
      deny: "The person did not agree to file tickets. Do not retry it; ask the person what they want.",
    };
  }
  return null;
}

// ---- The running check, from the status poll ----

/**
 * The guided check the panel shows, from the status the pane polls: the one
 * with the wizard's plan, or, with no plan of the panel's, whichever the
 * server shows. Null when there is none.
 *
 * @param {{ kind: string, data?: any }} status
 * @param {string | null} planId
 */
export function guidedOf(status, planId) {
  if (status.kind !== "data" || !isRecord(status.data) || !isRecord(status.data.guided)) return null;
  const g = status.data.guided;
  if (planId && str(g.planId) !== planId) return null;
  return g;
}

/** "6m of 20m". */
export function timeLine(/** @type {any} */ time) {
  const m = (/** @type {number} */ ms) => `${Math.floor(Math.max(0, ms) / 60_000)}m`;
  return `${m(num(time?.usedMs))} of ${m(num(time?.budgetMs))}`;
}

/** "2 block users · 3 annoying · 1 cosmetic". */
export function problemsLine(/** @type {any} */ p) {
  const parts = [`${num(p?.blocksUsers)} block users`, `${num(p?.annoying)} annoying`, `${num(p?.cosmetic)} cosmetic`];
  if (num(p?.worthALook)) parts.push(`${num(p?.worthALook)} worth a look`);
  return parts.join(" · ");
}

const AREA_MARK = { waiting: "[    ]", "in-progress": "[....]", done: "[done]", skipped: "[skip]" };

/** The live view's address as a link a remote surface draws: http://localhost, which the live view answers. */
export function liveHref(/** @type {unknown} */ url) {
  if (typeof url !== "string") return null;
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})(\/[A-Za-z0-9_-]+\/)$/.exec(url);
  return m ? `http://localhost:${m[1]}${m[2]}` : null;
}

// ---- Drawing ----

/**
 * @typedef {(type: string, payload?: Record<string, unknown>) => void} Act
 * @typedef {{ value: number | null, label: string }} CapOption
 * @typedef {{ sentence: string, options: CapOption[] }} CostOffer what the configuring screen says a check uses, and the limits the person may set (run.js's costOffer)
 * @typedef {{ id: string, title: string, where: string, ref: string, url: string, open: boolean, finding: "open" | "resolved" | "unknown" }} WatchedTicket
 * @typedef {{ surface: string, status: { kind: string, data?: any, error?: string }, picture?: { svg?: string, width?: number, height?: number, why?: string } | null, runPane?: unknown, cost?: CostOffer | null, tickets?: WatchedTicket[] | null }} Context
 */

/**
 * The panel's tree for the wizard's step. `els` is what `$.ui.resolve(e)`
 * returns for the surface drawing it: Input appears only where the table has
 * it, Svg only where the table has it, and mobile, which has neither Input
 * nor Select, gets buttons alone. Every press calls `act`.
 *
 * @param {Record<string, Function>} els
 * @param {Wizard} w
 * @param {Context} ctx
 * @param {Act} act
 */
export function renderGuided(els, w, ctx, act) {
  const { Box, Text, Button, Markdown } = els;
  const canType = "Input" in els;
  const canDraw = "Svg" in els;
  // Every string drawn passes here or through `button`: a title, a step's words or a name can quote the tested page.
  const text = (/** @type {string} */ t, /** @type {Record<string, unknown>} */ style = {}) => Text({ ...style, children: [plainText(t)] });
  const dim = (/** @type {string} */ t) => text(t, { dimColor: true });
  const heading = (/** @type {string} */ t) => text(t, { bold: true });
  const button = (
    /** @type {string} */ key,
    /** @type {string} */ label,
    /** @type {() => void} */ onPress,
    /** @type {Record<string, unknown>} */ extra = {},
  ) => Button({ key, label: plainText(label), onPress, ...extra });
  const row = (/** @type {unknown[]} */ children) => Box({ flexDirection: "row", columnGap: 2, flexWrap: "wrap", children });
  const column = (/** @type {unknown[]} */ children, /** @type {Record<string, unknown>} */ extra = {}) => Box({ flexDirection: "column", ...extra, children });
  const link = (/** @type {string} */ label, /** @type {string | null} */ href) =>
    href ? Markdown({ text: `[${label.replace(/[[\]]/g, "")}](${href})` }) : null;
  /** @type {unknown[]} */
  const rows = [];

  // The server: every step but the explainer needs it, so its error leads.
  if (ctx.status.kind === "error" && w.step !== "safety") {
    rows.push(
      column(
        [
          heading(SCREEN_HEADING[ERROR_HEADING["server-error"]]),
          text(SERVER_ERROR_SENTENCE, { color: "red" }),
          row([button("guided-error-retry", PANEL_WORDS.tryAgain, () => act("retry")), link(PANEL_WORDS.howToFix, TROUBLESHOOTING_URL)].filter(Boolean)),
          dim(`${PANEL_WORDS.technicalDetail}: ${str(ctx.status.error).slice(0, 300)}`),
        ],
        { marginBottom: 1 },
      ),
    );
  }
  if (w.notice) rows.push(text(w.notice.text, w.notice.tone === "error" ? { color: "red" } : { color: "green" }));
  // A queued check that started, or waits on a yes, while the person was elsewhere: said, with Follow it, and nothing moved.
  // One waiting on a yes is said on every screen but its preview, whatever cleared `started`: the preview is the only place to give the yes.
  const startedPlan = guidedOf(ctx.status, w.planId);
  const startedEnded = startedPlan !== null && (startedPlan.phase === "done" || startedPlan.phase === "stopped");
  if (w.step !== "confirm" && (w.fromQueue || (w.started && !startedEnded)))
    rows.push(
      row([
        text(w.fromQueue ? PANEL_WORDS.queuedWaits(w.fromQueue) : PANEL_WORDS.queuedStarted(w.started ?? ""), { color: "yellow", wrap: "truncate-end" }),
        button("guided-queued-follow", PANEL_WORDS.follow, () => act("followQueued"), { variant: "primary" }),
      ]),
    );

  const step = w.step;
  if (step === "welcome") rows.push(...welcomeRows());
  else if (step === "configuring") rows.push(...(canType ? configuringRows() : mobileConfiguringRows()));
  else if (step === "confirm") rows.push(...confirmRows());
  else if (step === "running") rows.push(...runningRows());
  else if (step === "results") rows.push(...resultsRows());
  else if (step === "card") rows.push(...cardRows());
  else if (step === "safety") rows.push(...safetyRows());
  else if (step === "tour") rows.push(...tourRows());
  return column(rows);

  function tourRows() {
    const page = Math.min(TOUR.length - 1, Math.max(0, w.tourPage));
    const last = page === TOUR.length - 1;
    return [
      dim(`${page + 1} of ${TOUR.length}`),
      heading(TOUR[page].title),
      text(TOUR[page].body),
      row([
        ...(page > 0 ? [button("guided-tour-back", PANEL_WORDS.back, () => act("tourBack"))] : []),
        last
          ? button("guided-tour-done", PANEL_WORDS.done, () => act("tourDone"), { variant: "primary" })
          : button("guided-tour-next", PANEL_WORDS.next, () => act("tourNext"), { variant: "primary" }),
        ...(last ? [] : [button("guided-tour-skip", PANEL_WORDS.skipTour, () => act("tourDone"))]),
      ]),
    ];
  }

  /** Before the check is under way: whether the saved sign-in lasts it, and the way to sign in again anyway. */
  function signInHealthRows() {
    const h = isRecord(w.plan) && isRecord(w.plan.signInHealth) ? w.plan.signInHealth : null;
    if (!h || !str(h.sentence)) return [];
    const again = isRecord(h.signInAgain) ? h.signInAgain : {};
    const out = [text(str(h.sentence), { color: str(h.state) === "lasts" ? "green" : "yellow" })];
    // Only a sign-in used as it is offers this: in every other case the check signs in first anyway.
    if (str(h.state) === "lasts" && str(again.prompt)) {
      out.push(row([button("guided-signin-again", str(again.label) || ACTION_LABEL.signInAgain, () => act("send", { text: str(again.prompt) }))]));
      if (str(again.command)) out.push(dim(SIGN_IN_AGAIN_COMMAND(str(again.command))));
    }
    return out;
  }

  function welcomeRows() {
    const out = [
      text(PANEL_WORDS.welcome),
      row([
        button("guided-welcome-check", PANEL_WORDS.checkSite, () => act(canType ? "newCheck" : "mobileCheck"), { variant: "primary" }),
        button("guided-welcome-safety", PANEL_WORDS.safety, () => act("go", { step: "safety" })),
      ]),
    ];
    const g = guidedOf(ctx.status, null);
    if (g)
      out.push(
        column(
          [
            dim(PANEL_WORDS.following),
            text(`${str(g.title)}: ${str(g.now)}`, { wrap: "truncate-end" }),
            button("guided-welcome-follow", PANEL_WORDS.follow, () => act("follow", { planId: str(g.planId) })),
          ],
          { marginTop: 1 },
        ),
      );
    if (w.lastChoices)
      out.push(
        column(
          [
            dim(PANEL_WORDS.lastCheck),
            text(`${str(w.lastChoices.address)} · ${CARE_LABEL[/** @type {Care} */ (w.lastChoices.care)] ?? ""}`, { wrap: "truncate-end" }),
            button("guided-welcome-again", PANEL_WORDS.runAgain, () => act("runAgain")),
          ],
          { marginTop: 1 },
        ),
      );
    if (w.saved && w.saved.length > 0) {
      const keys = savedKeys(w.saved);
      out.push(
        column(
          [
            text(PANEL_WORDS.savedChecks, { bold: true }),
            ...w.saved.flatMap((c, i) => [
              text(
                `${c.name}   ${c.address} · ${CARE_LABEL[/** @type {Care} */ (c.care)] ?? ""} · ${c.lastRunAt ? `${PANEL_WORDS.lastRun} ${c.lastRunAt.slice(0, 10)}` : PANEL_WORDS.neverRun}`,
                { wrap: "truncate-end" },
              ),
              w.deleting === c.name
                ? row([
                    text(PANEL_WORDS.deleteAsk(c.name), { wrap: "truncate-end" }),
                    button(`guided-saved-delete-yes-${keys[i]}`, PANEL_WORDS.deleteYes, () => act("deleteSaved", { name: c.name })),
                    button(`guided-saved-delete-keep-${keys[i]}`, PANEL_WORDS.deleteKeep, () => act("keepSaved"), { plain: true }),
                  ])
                : row([
                    button(`guided-saved-run-${keys[i]}`, PANEL_WORDS.runAgain, () => act("runSaved", { name: c.name })),
                    button(`guided-saved-delete-${keys[i]}`, PANEL_WORDS.deleteSaved, () => act("askDelete", { name: c.name }), { plain: true }),
                  ]),
            ]),
          ],
          { marginTop: 1 },
        ),
      );
    }
    // Checks waiting to start, and Go on when the queue is paused.
    if (w.queue.length) out.push(...queueRows(false));
    // A run started some other way: what the run pane shows.
    if (!g && ctx.runPane && ctx.status.kind !== "error") out.push(column([ctx.runPane], { marginTop: 1 }));
    // The tickets SceneScout filed for this project, watched: a closed one whose problem is still here offers Check again.
    const tickets = ctx.tickets ?? [];
    if (tickets.length) {
      const keys = savedKeys(tickets.map((t) => ({ name: `${t.where} ${t.ref}`, address: "x", care: "", lastRunAt: "" })));
      out.push(
        column(
          [
            text(PANEL_WORDS.ticketsHeading, { bold: true }),
            ...tickets
              .slice(0, 10)
              .map((t, i) =>
                row([
                  text(
                    `${t.ref} ${t.open ? PANEL_WORDS.ticketOpen : PANEL_WORDS.ticketClosed}${t.finding === "resolved" ? ` · ${PANEL_WORDS.ticketFixed}` : ""} · ${t.title}`,
                    { wrap: "truncate-end", ...(t.open ? {} : { dimColor: true }) },
                  ),
                  ...(!t.open && t.finding === "open"
                    ? [button(`guided-ticket-again-${keys[i]}`, ACTION_LABEL.again, () => act("send", { text: ACTION_PROMPT.again(t.id) }))]
                    : []),
                ]),
              ),
          ],
          { marginTop: 1 },
        ),
      );
    }
    out.push(row([dim(PANEL_WORDS.newHere), button("guided-welcome-tour", PANEL_WORDS.takeTour, () => act("tour"), { plain: true })]));
    return out;
  }

  function configuringRows() {
    const { Input } = els;
    const d = w.draft;
    const out = [heading(`SceneScout: ${PANEL_WORDS.newCheck.toLowerCase()}`)];
    out.push(
      Input({
        key: "guided-config-address",
        label: PANEL_WORDS.address,
        placeholder: PANEL_WORDS.addressHint,
        value: d.address,
        onInput: (/** @type {string} */ v) => act("address", { value: v }),
        onSubmit: (/** @type {string} */ v) => act("address", { value: v }),
      }),
    );
    out.push(text(PANEL_WORDS.whatToCheck, { bold: true }));
    for (const area of PANEL_AREAS) {
      const on = d.areas.includes(area);
      out.push(
        button(
          `guided-config-area-${area}`,
          `${on ? "[x]" : "[ ]"} ${AREA_LABEL[/** @type {keyof typeof AREA_LABEL} */ (area)]}`,
          () => act("toggleArea", { area }),
          { plain: true },
        ),
      );
      if (area === "journey" && on)
        out.push(
          Input({
            key: "guided-config-journey",
            label: PANEL_WORDS.journey,
            placeholder: PANEL_WORDS.journeyHint,
            value: d.journey,
            onInput: (/** @type {string} */ v) => act("journey", { value: v }),
            onSubmit: (/** @type {string} */ v) => act("journey", { value: v }),
          }),
        );
    }
    out.push(...choiceRows(d));
    out.push(
      row([
        button("guided-config-cancel", PANEL_WORDS.cancel, () => act("go", { step: "welcome" })),
        button("guided-config-start", PANEL_WORDS.start, () => act("build"), { variant: "primary" }),
      ]),
    );
    return out;
  }

  /** The care level, the sign-in and how thorough: buttons with the chosen one marked, as the API has no radio. */
  function choiceRows(/** @type {Draft} */ d) {
    const out = [text(PANEL_WORDS.signIn, { bold: true })];
    out.push(
      row(
        Object.keys(SIGN_IN_LABEL).map((k) =>
          button(
            `guided-config-signin-${k}`,
            `${d.signIn === k ? "(o)" : "( )"} ${SIGN_IN_LABEL[/** @type {keyof typeof SIGN_IN_LABEL} */ (k)]}`,
            () => act("signIn", { value: k }),
            { plain: true },
          ),
        ),
      ),
    );
    out.push(
      row([
        text(PANEL_WORDS.careful, { bold: true }),
        button("guided-config-safety", PANEL_WORDS.isItSafe, () => act("go", { step: "safety" }), { plain: true }),
      ]),
    );
    for (const care of CARES) {
      out.push(
        button(
          `guided-config-care-${care}`,
          `${d.care === care ? "(o)" : "( )"} ${CARE_LABEL[/** @type {Care} */ (care)]}`,
          () => act("care", { value: care }),
          { plain: true },
        ),
      );
      if (d.care === care) out.push(Box({ paddingLeft: 4, children: [dim(CARE_EXPLAIN[/** @type {Care} */ (care)])] }));
    }
    out.push(dim(DESTRUCTIVE_NOT_OFFERED));
    out.push(text(PANEL_WORDS.thorough, { bold: true }));
    out.push(
      row(
        THOROUGHNESSES.map((t) =>
          button(
            `guided-config-thorough-${t}`,
            `${d.thoroughness === t ? "(o)" : "( )"} ${THOROUGHNESS_LABEL[/** @type {keyof typeof THOROUGHNESS_LABEL} */ (t)]}`,
            () => act("thoroughness", { value: t }),
            { plain: true },
          ),
        ),
      ),
    );
    // What the chosen care level holds back in each chosen area, and whether it asks first.
    for (const area of d.areas) {
      const held = HELD_BACK[/** @type {keyof typeof HELD_BACK} */ (area)]?.[d.care];
      if (held) out.push(dim(held));
    }
    if (confirmReason(d.care, d.address.trim())) out.push(text(PANEL_WORDS.willConfirm, { color: "yellow" }));
    // What a check like this uses, and a limit the person may set (design 2.11); nothing where this Claude Code reports no usage.
    if (ctx.cost) {
      out.push(dim(ctx.cost.sentence));
      if (ctx.cost.options.length)
        out.push(
          row([
            text(PANEL_WORDS.capHeading, { bold: true }),
            ...ctx.cost.options.map((o) =>
              button(
                `guided-config-cap-${o.value === null ? "none" : String(o.value).replace(".", "-")}`,
                `${d.cap === o.value ? "(o)" : "( )"} ${o.label}`,
                () => act("cap", { value: o.value }),
                {
                  plain: true,
                },
              ),
            ),
          ]),
        );
    }
    return out;
  }

  /** Mobile draws no field: the address is typed in the message box, and Claude asks the rest with the start form. */
  function mobileConfiguringRows() {
    return [text(PANEL_WORDS.mobileCheck), row([button("guided-config-cancel", PANEL_WORDS.back, () => act("go", { step: "welcome" }))])];
  }

  function confirmRows() {
    const plan = w.plan ?? {};
    const care = /** @type {Care} */ (CARES.includes(str(plan.choices?.care)) ? str(plan.choices.care) : w.draft.care);
    const reason = str(plan.confirm?.reason) || confirmReason(care, str(plan.choices?.address)) || "forms-on-remote-site";
    const out = [heading(PANEL_WORDS.beforeStart), text(str(plan.confirm?.sentence)), ...signInHealthRows()];
    out.push(text(CONFIRM_PREVIEW_HEADING, { bold: true }));
    for (const line of CARE_PREVIEW[care]) out.push(text(`  ${line}`));
    out.push(dim(CONFIRM_COMING[/** @type {keyof typeof CONFIRM_COMING} */ (reason)] ?? ""));
    if (w.busy === "confirm") {
      out.push(text(PANEL_WORDS.waitingForm, { color: "yellow" }));
      return out;
    }
    const yes = reason === "creates-data" ? CONFIRM_ANSWER.testCopy : CONFIRM_ANSWER.yes;
    // A re-check has no choices to go back to or to run as Look only: it goes back to the results it came from.
    const recheck = isRecord(plan.recheck);
    out.push(
      row([
        button("guided-confirm-back", CONFIRM_ANSWER.back, () => (w.fromQueue ? act("queueBack") : act("go", { step: recheck ? "results" : "configuring" })), {
          autoFocus: true,
        }),
        button("guided-confirm-yes", yes, () => act("confirm"), { variant: "primary" }),
      ]),
    );
    if (w.notice?.tone === "error" && !recheck && !w.fromQueue) out.push(button("guided-confirm-lookonly", PANEL_WORDS.lookOnly, () => act("lookOnly")));
    return out;
  }

  function runningRows() {
    const g = guidedOf(ctx.status, w.planId);
    if (!g)
      return [
        ...(w.fromQueue ? [] : [dim(STARTING_SENTENCE)]),
        ...signInHealthRows(),
        ...queueRows(true),
        row([button("guided-running-back", PANEL_WORDS.back, () => act("go", { step: "welcome" }))]),
      ];
    const out = [heading(`${str(g.title)} · ${timeLine(g.time)}`), text(`Now: ${str(g.now)}`)];
    if (str(g.phase) === "starting" || str(g.phase) === "signing-in") out.push(...signInHealthRows());
    const story = Array.isArray(g.story) ? g.story.map(str).filter(Boolean) : [];
    const before = story.slice(0, -1).slice(-2);
    if (before.length) out.push(dim(`before: ${before.join("; ")}`));
    for (const a of Array.isArray(g.areas) ? g.areas.filter(isRecord) : []) {
      const mark = AREA_MARK[/** @type {keyof typeof AREA_MARK} */ (str(a.state))] ?? "[    ]";
      out.push(text(`${mark} ${str(a.label)}${str(a.note) ? ` - ${str(a.note)}` : ""}`, { wrap: "truncate-end" }));
    }
    if (isRecord(g.pages)) out.push(dim(`Pages: ${num(g.pages.checked)} of ${num(g.pages.found)}`));
    out.push(text(`${PANEL_WORDS.problemsSoFar} ${problemsLine(g.problems)}`));
    for (const card of Array.isArray(g.latest) ? g.latest.filter(isRecord) : [])
      out.push(
        button(
          `guided-running-card-${str(card.id)}`,
          `${IMPACT_MARK[/** @type {keyof typeof IMPACT_MARK} */ (str(card.impact))] ?? "-"} ${str(card.impact)}  ${str(card.title)}  ${str(card.page)}`,
          () => act("openCard", { id: str(card.id), surface: ctx.surface }),
          { plain: true },
        ),
      );
    if (isRecord(g.saved)) out.push(dim(str(g.saved.sentence)));
    if (isRecord(g.needsYou)) {
      const wentWrong = needsYouHeading(g.needsYou.kind) === SCREEN_HEADING.wentWrong;
      out.push(
        column(
          [
            heading(needsYouHeading(g.needsYou.kind)),
            text(str(g.needsYou.sentence), { color: wentWrong ? "red" : "yellow" }),
            row(actionButtons(g.needsYou.actions, "guided-needs")),
          ],
          { marginTop: 1 },
        ),
      );
    }
    const live = link(PANEL_WORDS.watchLive, liveHref(ctx.status.data?.liveUrl));
    const finished = str(g.phase) === "done" || str(g.phase) === "stopped";
    out.push(
      row([
        ...(live ? [live] : []),
        ...actionButtons(g.next, "guided-running"),
        ...(finished
          ? [
              button("guided-running-again", PANEL_WORDS.runAgain, () => act("runAgain")),
              button("guided-running-new", PANEL_WORDS.newCheck, () => act("newCheck")),
            ]
          : []),
      ]),
    );
    out.push(...queueRows(!finished));
    if (ctx.runPane) out.push(column([ctx.runPane], { marginTop: 1 }));
    return out;
  }

  /** The checks waiting to start, each with Remove; while a check runs, Queue another check and the saved checks to pick from. */
  function queueRows(/** @type {boolean} */ canQueue) {
    const out = [];
    if (w.queue.length) {
      const keys = savedKeys(w.queue.map((q) => ({ ...q, lastRunAt: "" })));
      out.push(
        column(
          [
            text(PANEL_WORDS.queueHeading, { bold: true }),
            ...(w.queuePaused
              ? [row([text(PANEL_WORDS.queuePaused, { color: "yellow" }), button("guided-queue-resume", PANEL_WORDS.queueResume, () => act("queueResume"))])]
              : []),
            ...w.queue.map((q, i) =>
              row([
                text(`${i + 1}. ${q.name} · ${CARE_LABEL[q.care]}${confirmReason(q.care, q.address) ? ` · ${PANEL_WORDS.queueWillAsk}` : ""}`, {
                  wrap: "truncate-end",
                }),
                button(`guided-queue-remove-${keys[i]}`, PANEL_WORDS.queueRemove, () => act("queueRemove", { name: q.name }), { plain: true }),
              ]),
            ),
          ],
          { marginTop: 1 },
        ),
      );
    }
    if (!canQueue) return out;
    if (!w.queuing) {
      if (w.queue.length < QUEUE_MAX) out.push(row([button("guided-queue-another", PANEL_WORDS.queueAnother, () => act("queuePick"))]));
      return out;
    }
    const saved = w.saved ?? [];
    const keys = savedKeys(saved);
    out.push(
      column(
        [
          text(PANEL_WORDS.queuePick, { bold: true }),
          ...saved.flatMap((c, i) =>
            w.queue.some((q) => q.name === c.name)
              ? []
              : [
                  row([
                    text(`${c.name} · ${CARE_LABEL[/** @type {Care} */ (c.care)] ?? ""}`, { wrap: "truncate-end" }),
                    button(`guided-queue-add-${keys[i]}`, PANEL_WORDS.queueIt, () => act("queueAdd", { name: c.name })),
                  ]),
                ],
          ),
          row([button("guided-queue-close", PANEL_WORDS.queueClose, () => act("queuePick"), { plain: true })]),
        ],
        { marginTop: 1 },
      ),
    );
    return out;
  }

  /** A card's labels as buttons: Not a bug and Confirmed, less the one already given. */
  function feedbackButtons(/** @type {any} */ card, /** @type {string} */ prefix) {
    const id = str(card.id);
    return feedbackChoices(card).map((verdict) => button(`${prefix}-${verdict}`, feedbackLabel(verdict), () => act("feedback", { id, verdict })));
  }

  /** What the person already said of a card, or nothing. */
  function feedbackSaid(/** @type {any} */ card) {
    if (!isRecord(card.feedback)) return null;
    return card.feedback.verdict === "not-a-bug" ? PANEL_WORDS.markedNotABug : card.feedback.verdict === "confirmed" ? PANEL_WORDS.markedConfirmed : null;
  }

  /** The engine's GuidedActions as buttons: "See all problems" opens the results; the rest call the server or send to Claude. */
  function actionButtons(/** @type {unknown} */ actions, /** @type {string} */ prefix) {
    const list = Array.isArray(actions) ? actions.filter(isRecord) : [];
    return list.flatMap((a) => {
      const slug = str(a.label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (a.kind === "direct" && a.tool === CARDS_TOOL) return [button(`${prefix}-${slug}`, str(a.label), () => act("cards"))];
      const effect = actionEffect(a);
      if (!effect) return [];
      return [
        button(`${prefix}-${slug}`, str(a.label), () =>
          act(effect.kind, effect.kind === "call" ? { tool: effect.tool, args: effect.args } : { text: effect.text }),
        ),
      ];
    });
  }

  function resultsRows() {
    const cards = w.cards ?? [];
    const own = resultsPlan(w);
    const where = str(own.plan?.choices?.address) || str(own.lastChoices?.address);
    const out = [heading(`${PANEL_WORDS.results}${where ? `: ${where}` : ""} · ${w.cardsTotal} problem${w.cardsTotal === 1 ? "" : "s"}`)];
    if (w.busy === "cards") out.push(dim("Reading the problems..."));
    else if (cards.length === 0) out.push(dim(PANEL_WORDS.noCards));
    if (w.busy === "team-report") out.push(dim(PANEL_WORDS.writingTeamReport));
    else if (w.teamReport) {
      const made = [link(PANEL_WORDS.openReport, fileHref(w.teamReport.path)), link(PANEL_WORDS.showFolder, fileHref(w.teamReport.folder))].filter(Boolean);
      if (made.length) out.push(row(made));
    }
    for (const card of cards) {
      out.push(
        column([
          text(`${IMPACT_MARK[/** @type {keyof typeof IMPACT_MARK} */ (str(card.impact))] ?? "-"} ${str(card.impact)}   ${str(card.title)}`, {
            bold: true,
            wrap: "truncate-end",
          }),
          dim(`  on ${str(card.page)} · seen ${num(card.timesSeen)} time${num(card.timesSeen) === 1 ? "" : "s"}`),
          ...(feedbackSaid(card) ? [text(`  ${feedbackSaid(card)}`, { color: "yellow" })] : []),
          row([
            button(`guided-results-open-${str(card.id)}`, PANEL_WORDS.open, () => act("openCard", { id: str(card.id), surface: ctx.surface })),
            ...feedbackButtons(card, `guided-results-${str(card.id)}`),
          ]),
        ]),
      );
    }
    if (w.busy === "recheck") out.push(dim(PANEL_WORDS.rechecking));
    // Saving keeps the choices of the plan the panel built; a re-check is made from problems, not choices, so it is not saved.
    if (canType && own.planId && isRecord(own.plan) && !isRecord(own.plan.recheck))
      out.push(
        row([
          els.Input({
            key: "guided-save-name",
            label: PANEL_WORDS.saveName,
            placeholder: PANEL_WORDS.saveHint,
            value: w.saveName,
            onInput: (/** @type {string} */ v) => act("saveName", { value: v }),
            onSubmit: (/** @type {string} */ v) => act("saveName", { value: v }),
          }),
          button("guided-save-check", PANEL_WORDS.saveCheck, () => act("saveCheck")),
        ]),
      );
    out.push(
      row([
        ...(w.busy === "recheck" ? [] : [button("guided-results-recheck", ACTION_LABEL.recheck, () => act("recheck"))]),
        button("guided-results-report", ACTION_LABEL.plainReport, () => act("send", { text: ACTION_PROMPT.plainReport })),
        // Hidden while one is being written, so a second press cannot start another; Back clears a stuck one.
        ...(w.busy === "team-report" ? [] : [button("guided-results-team-report", ACTION_LABEL.teamReport, () => act("teamReport"))]),
        // Claude previews and files; the server's own form, listing the tickets, is where the person says yes.
        ...(cards.length > 0 ? [button("guided-results-file-tickets", ACTION_LABEL.fileTickets, () => act("send", { text: ACTION_PROMPT.fileTickets }))] : []),
        ...(own.lastChoices ? [button("guided-results-again", PANEL_WORDS.runAgain, () => act("runAgain", { from: "results" }))] : []),
        ...(canType ? [button("guided-results-new", PANEL_WORDS.newCheck, () => act("newCheck"))] : []),
        button("guided-results-back", PANEL_WORDS.back, () => act("go", { step: w.planId ? "running" : "welcome" })),
      ]),
    );
    return out;
  }

  function cardRows() {
    const id = w.cardId ?? "";
    const g = guidedOf(ctx.status, w.planId);
    const latest = g && Array.isArray(g.latest) ? g.latest : [];
    const card = [...(w.cards ?? []), ...latest].find((c) => isRecord(c) && str(c.id) === id);
    const back = button("guided-card-back", PANEL_WORDS.back, () => act("go", { step: w.cards ? "results" : "running" }));
    if (!card) return [dim(`No problem with id ${id} is loaded.`), back];
    const out = [heading(str(card.title))];
    out.push(
      text(
        `${IMPACT_MARK[/** @type {keyof typeof IMPACT_MARK} */ (str(card.impact))] ?? "-"} ${str(card.impact)} · ${str(card.problem)} · on ${str(card.page)}`,
      ),
    );
    const also = Array.isArray(card.alsoOn) ? card.alsoOn.map(str).filter(Boolean) : [];
    if (also.length) out.push(dim(`also seen on ${also.join(", ")}`));
    // The picture: the Svg probe where the surface draws Svg, and the links either way.
    if (canDraw && ctx.picture && ctx.picture.svg)
      out.push(
        els.Svg({
          source: ctx.picture.svg,
          alt: plainLine(`Picture of the problem: ${str(card.title)}`).slice(0, 200),
          width: ctx.picture.width,
          height: ctx.picture.height,
        }),
      );
    const file = fileHref(w.pictureFiles[id]);
    const pictureLinks = [link(PANEL_WORDS.seePicture, file), link(PANEL_WORDS.liveView, liveHref(ctx.status.data?.liveUrl))].filter(Boolean);
    if (pictureLinks.length) out.push(row(pictureLinks));
    else if (!card.picture) out.push(dim(PANEL_WORDS.noPicture));
    else out.push(button("guided-card-report", ACTION_LABEL.plainReport, () => act("send", { text: ACTION_PROMPT.plainReport })));
    if (canDraw && ctx.picture?.svg) out.push(dim(PANEL_WORDS.pictureNote));
    const steps = Array.isArray(card.steps) ? card.steps.map(str).filter(Boolean) : [];
    if (steps.length) out.push(text(PANEL_WORDS.whatWasDone, { bold: true }), ...steps.map((s, i) => text(`  ${i + 1}. ${s}`)));
    out.push(text(PANEL_WORDS.expected, { bold: true }), text(`  ${str(card.expected)}`));
    out.push(text(PANEL_WORDS.happened, { bold: true }), text(`  ${str(card.happened)}`));
    const said = feedbackSaid(card);
    if (said) out.push(text(said, { color: "yellow" }));
    const t = isRecord(card.technical) ? card.technical : {};
    out.push(dim(`${PANEL_WORDS.technical}: ${str(t.category)} · ${str(t.route)} · id ${id}`));
    // The engine's buttons, with its Not a bug drawn as the pair of labels the panel offers.
    const prompts = cardActions(id).filter((a) => a.kind === "prompt");
    out.push(
      row([
        ...feedbackButtons(card, "guided-card"),
        ...prompts.map((a) => button(`guided-card-${a.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, a.label, () => act("send", { text: str(a.text) }))),
        back,
      ]),
    );
    return out;
  }

  function safetyRows() {
    return [
      heading(PANEL_WORDS.safety),
      ...SAFETY_EXPLAINER.map((s) => text(s)),
      row([button("guided-safety-back", PANEL_WORDS.back, () => act("go", { step: w.returnTo ?? "welcome" }))]),
    ];
  }
}

/**
 * The heading over what the engine says it needs of the person: an error
 * screen's own heading, or "I need you" for a confirmation, a sign-in and a
 * step that is stuck.
 *
 * @param {unknown} kind
 */
export function needsYouHeading(kind) {
  const k = str(kind);
  return SCREEN_HEADING[Object.hasOwn(ERROR_HEADING, k) ? ERROR_HEADING[/** @type {keyof typeof ERROR_HEADING} */ (k)] : "needYou"];
}

/**
 * What `/scenescout-guided` prints where nothing draws (the VS Code chat
 * panel, `claude -p`): the current state in words, and what to say to Claude
 * next, since no button can be pressed there and no confirmation given.
 *
 * @param {Wizard} w
 * @param {{ kind: string, data?: any, error?: string }} status
 */
export function guidedText(w, status) {
  if (status.kind === "error") return [SERVER_ERROR_SENTENCE, plainLine(str(status.error))].filter(Boolean).join("\n");
  const g = guidedOf(status, w.planId);
  const lines = [];
  if (g) {
    lines.push(`${str(g.title)} (${timeLine(g.time)}). Now: ${str(g.now)}`, `${PANEL_WORDS.problemsSoFar} ${problemsLine(g.problems)}`);
    for (const card of Array.isArray(g.latest) ? g.latest.filter(isRecord) : [])
      lines.push(`- ${str(card.impact)}: ${str(card.title)} (${str(card.page)}, id ${str(card.id)})`);
    if (isRecord(g.needsYou)) lines.push(`${needsYouHeading(g.needsYou.kind)}: ${str(g.needsYou.sentence)}`);
    lines.push(
      "",
      PANEL_WORDS.fallbackNext,
      `  "${ACTION_PROMPT.recheck}"`,
      `  "${ACTION_PROMPT.plainReport}"`,
      '  "show me the SceneScout problems as cards"',
    );
  } else {
    lines.push(PANEL_WORDS.welcome, "", PANEL_WORDS.fallbackNext, '  "check my site with SceneScout"', '  "is SceneScout safe to run on my live site?"');
    lines.push(
      `Here, a check can start only in "${CARE_LABEL["look-only"]}": a care level that writes needs a confirmation this view cannot show. Use the terminal or the desktop Code tab for that.`,
    );
  }
  // Printed into the transcript: a page's words in it are made plain, line by line.
  return lines.map(plainText).join("\n");
}
