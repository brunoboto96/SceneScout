/**
 * Every fixed sentence the guided assistant shows a person: the care levels,
 * the areas to check, what each care level holds back there, how thorough a
 * check is, the confirmation, the safety explainer, and the messages for when
 * a check needs the person. Both guided surfaces (the Code tab's panel and the
 * chat) read these, so neither writes wording of its own, and guided-test holds
 * them to plain language. Nothing here is built from text a page supplied.
 *
 * Design: docs/design/non-technical-assistant.md. Decision: ADR 24.
 */
import type { Care, CheckArea, Thoroughness } from "./guided.js";

/** A care level as the person chooses it. */
export const CARE_LABEL: Record<Care, string> = {
  "look-only": "Look only",
  "may-submit-forms": "May submit forms",
  "may-create-test-data": "May create test data",
};

/** What each care level does, in the small text under its name. */
export const CARE_EXPLAIN: Record<Care, string> = {
  "look-only": "Only opens pages. Nothing is sent to your site except signing in. Safe on a live site.",
  "may-submit-forms":
    "Fills in and sends forms, and presses buttons that send something, such as a contact form, a sign-up or a settings page. What it sends can create a record, and can change one that was there, as it would for anyone. Deletes are blocked.",
  "may-create-test-data":
    "Creates records it needs, such as an account or an order. What it sends can also change records that were there, but it deletes only what it created. Use only on a test copy.",
};

/** Said where the care levels are listed: the level that deletes is not one of them. */
export const DESTRUCTIVE_NOT_OFFERED = "Deleting data that was already there needs a developer to ask for it by name.";

/** What a care level may and may not do, as the confirmation's preview lists it: + may, ~ may with a limit, - never. */
export const CARE_PREVIEW: Record<Care, readonly string[]> = {
  "look-only": ["+ open pages and sign in", "- never send a form", "- never create, change or delete anything"],
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

/** An area to check, as the person ticks it. */
export const AREA_LABEL: Record<CheckArea, string> = {
  "sign-in": "Sign-up and sign-in",
  forms: "Forms",
  "broken-pages": "Broken pages and links",
  phone: "How it looks on a phone",
  journey: "A journey in a sentence",
  tickets: "Tickets",
};

/** What checking an area means. */
export const AREA_WHAT_HAPPENS: Record<CheckArea, string> = {
  "sign-in": "The sign-in and sign-up pages are checked: their error messages, what a wrong password does, and the page you land on once signed in.",
  forms: "Every form found is checked: its required fields, its error messages, and what happens when it is sent.",
  "broken-pages": "Every page it can reach is opened, looking for errors, dead ends, failed requests and missing pages.",
  phone: "The same key pages are checked at the size of a phone screen, including how they are laid out.",
  journey: "The journey you described is followed from start to finish.",
  tickets: "Each acceptance criterion in your tickets is checked and answered.",
};

/** The phone screen the phone area uses, in CSS pixels. */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/**
 * What a care level holds back in an area, or nothing when it holds nothing
 * back there. A journey and tickets stop where the care level refuses a step,
 * and the card says so.
 */
export const HELD_BACK: Record<CheckArea, Partial<Record<Care, string>>> = {
  "sign-in": { "look-only": "Only signing in is tried. Sign-up is looked at but never sent." },
  forms: { "look-only": "Forms are filled in and checked but never sent." },
  "broken-pages": {},
  phone: {},
  journey: {
    "look-only": "The journey stops at the first step that would send something to your site, and says so.",
    "may-submit-forms": "The journey stops at the first step this care level blocks, such as a delete, and says so.",
    "may-create-test-data": "The journey stops at the first step this care level blocks, such as deleting something it did not create, and says so.",
  },
  tickets: {
    "look-only": "A criterion that needs something sent to your site is marked not tested, and says why.",
    "may-submit-forms": "A criterion that needs a step this care level blocks, such as a delete, is marked not tested, and says why.",
    "may-create-test-data":
      "A criterion that needs a step this care level blocks, such as deleting something it did not create, is marked not tested, and says why.",
  },
};

/** How thorough a check is, as the person chooses it. */
export const THOROUGHNESS_LABEL: Record<Thoroughness, string> = {
  quick: "Quick look",
  normal: "Normal",
  thorough: "Thorough",
};

/** The time and page limits a check states before it starts. */
export function budgetSentence(budget: { minutes: number; pages: number }): string {
  return `It stops after at most ${budget.minutes} minutes and ${budget.pages} pages.`;
}

/** What the person is told before the sign-in window opens, by how they sign in. */
export function signInSentence(hint: string): string {
  return `A browser window will open: ${hint}.`;
}

/** The sentence the person accepts before a care level that writes starts on an address. */
export function confirmSentence(reason: "creates-data" | "forms-on-remote-site", address: string): string {
  return reason === "creates-data"
    ? `You chose "${CARE_LABEL["may-create-test-data"]}" for ${address}. It may create accounts, orders or other records it needs, and what it sends can change records that were there. It deletes only the records it created. Use this only on a test copy, never on a live site.`
    : `You chose "${CARE_LABEL["may-submit-forms"]}" for ${address}, which is not on this computer. What it sends there can create a real record, such as a sign-up or a message, and can change a record that was there, such as a saved profile. Deletes are blocked.`;
}

/** What the person is told about the confirmation before it is asked for. */
export const CONFIRM_COMING: Record<"creates-data" | "forms-on-remote-site", string> = {
  "creates-data": "Before it starts, a short form asks you to confirm this is a test copy and to type the code it shows.",
  "forms-on-remote-site": "Before it starts, a short form asks you to confirm that forms may be sent there.",
};

/** The answers a confirmation offers: one of the two yeses (the second for creating test data), or go back. */
export const CONFIRM_ANSWER = { yes: "Yes, I understand", testCopy: "Yes, it is a test copy", back: "Go back" } as const;

/** Said when a confirmation cannot be asked for, because the host cannot show the server's form. */
export const CONFIRM_UNAVAILABLE = `This app cannot show the confirmation form, so the check can only run in "${CARE_LABEL["look-only"]}" here.`;

/** The answer to "Is it safe to run on my live site?", word for word on every surface. */
export const SAFETY_EXPLAINER: readonly string[] = [
  `${CARE_LABEL["look-only"]}, the default, only opens pages: nothing is sent to your site except signing in, so it is safe on a live site.`,
  `${CARE_LABEL["may-submit-forms"]} sends forms, and presses buttons that send something. What it sends can create a record, or change one that was there, as it would for anyone who sent it; deletes are blocked. On a site that is not on this computer, it asks you first.`,
  `${CARE_LABEL["may-create-test-data"]} creates the records it needs. What it sends can also change records that were there, but it deletes only what it created. It always asks you first, and is for a test copy only.`,
  "Deleting data that was already there is never offered here.",
  "These limits are checked on every request your browser sends, not left to the AI's judgement. A request a care level does not allow never reaches your site. What a care level does allow, a form or a button, does on your site whatever it does for anyone who uses it.",
  "It never asks for your password. When your site needs one, a browser window opens for you to sign in as you normally would.",
];

/** When a check needs the person, in one sentence each. `where` is the site's host. */
export const NEEDS_YOU_SENTENCE = {
  "sign-in": (where: string) => `${where} needs you to sign in before I can go on.`,
  "sign-in-expired": (where: string) => `Your sign-in to ${where} has run out.`,
  confirm: (_where: string) => "I need you to confirm the care level before I start.",
  "browser-download-failed": (_where: string) => "I could not download the test browser. Check your internet connection and try again.",
  "server-error": (_where: string) => "I could not reach the SceneScout server. Is the scenescout plugin installed and turned on?",
  "address-unreachable": (where: string) => `I could not open ${where}. Check the address, and that the site is running.`,
} as const;
