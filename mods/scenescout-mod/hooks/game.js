/**
 * The optional game layer (design 2.10): a bestiary of the open problems,
 * each a creature sized by its impact, and the problems a re-check found gone
 * counted as defeated. Off unless the person sets `game` to `on` in the mod's
 * settings. It is drawn by the mod only, in the panel only: the engine knows
 * nothing of it, it changes no word on a card, the report or a ticket, and it
 * is never put into the end-of-check picture or anything else that is shared.
 *
 * Like guided.js it has no mods API in it, so every rule is table-tested in
 * scripts/live-test.ts.
 */

/** The settings value that turns it on. Anything else, the default included, leaves it off. */
export const GAME_ON = "on";

/** Whether the layer is on: only the setting `on`. @param {unknown} value */
export function gameOn(value) {
  return value === GAME_ON;
}

/** Each impact's creature: its name, its radius in the picture and its mark in text. */
export const CREATURES = {
  "Blocks users": { name: "Brute", r: 22, mark: "@" },
  Annoying: { name: "Gremlin", r: 15, mark: "&" },
  Cosmetic: { name: "Sprite", r: 10, mark: "*" },
  "Worth a look": { name: "Wisp", r: 7, mark: "." },
};

/** The most creatures drawn; the rest are counted. */
export const BESTIARY_MAX = 12;

export const GAME_WORDS = {
  heading: "Bestiary",
  count: (/** @type {number} */ defeated, /** @type {number} */ about) => `${defeated} defeated, ${about} still about`,
  none: "Nothing about. Every problem here is defeated or not a bug.",
};

/** @param {unknown} v */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The bestiary from the cards the panel holds and the number a re-check
 * confirmed fixed: each open card that is not marked not a bug is a creature
 * about, worst first as the cards come.
 *
 * @param {unknown[] | null} cards
 * @param {number} defeated
 * @returns {{ about: Array<{ id: string, impact: keyof typeof CREATURES }>, defeated: number }}
 */
export function bestiary(cards, defeated) {
  const about = (cards ?? [])
    .filter((c) => isRecord(c) && typeof c.id === "string" && Object.hasOwn(CREATURES, String(c.impact)))
    .filter((c) => !(isRecord(c.feedback) && c.feedback.verdict === "not-a-bug") && c.status !== "fixed")
    .map((c) => ({ id: String(c.id), impact: /** @type {keyof typeof CREATURES} */ (String(c.impact)) }));
  return { about, defeated: Number.isFinite(defeated) && defeated > 0 ? Math.floor(defeated) : 0 };
}

/** "Brute ×2 · Gremlin ×1", in the creatures' order. @param {ReturnType<typeof bestiary>} b */
export function bestiaryTally(b) {
  return Object.entries(CREATURES)
    .map(([impact, c]) => [c, b.about.filter((x) => x.impact === impact).length])
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${/** @type {{ mark: string, name: string }} */ (c).mark} ${/** @type {{ name: string }} */ (c).name} ×${n}`)
    .join(" · ");
}

/**
 * The bestiary as a picture: a row of creatures sized by impact, then the
 * defeated, greyed and crossed out. Only numbers the mod counted go into it.
 *
 * @param {ReturnType<typeof bestiary>} b
 */
export function bestiarySvg(b) {
  const shown = b.about.slice(0, BESTIARY_MAX);
  const down = Math.min(b.defeated, BESTIARY_MAX);
  const step = 52;
  const width = Math.max(1, shown.length + down) * step + 8;
  const parts = shown.map((x, i) => {
    const c = CREATURES[x.impact];
    const cx = 30 + i * step;
    return `<circle cx="${cx}" cy="30" r="${c.r}" fill="#7c3aed"/><circle cx="${cx - c.r / 3}" cy="${30 - c.r / 4}" r="${Math.max(1.5, c.r / 6)}" fill="#ffffff"/><circle cx="${cx + c.r / 3}" cy="${30 - c.r / 4}" r="${Math.max(1.5, c.r / 6)}" fill="#ffffff"/>`;
  });
  for (let i = 0; i < down; i++) {
    const cx = 30 + (shown.length + i) * step;
    parts.push(
      `<circle cx="${cx}" cy="30" r="12" fill="#d1d5db"/><path d="M${cx - 9} 21 L${cx + 9} 39 M${cx + 9} 21 L${cx - 9} 39" stroke="#6b7280" stroke-width="3"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60" viewBox="0 0 ${width} 60">${parts.join("")}</svg>`;
}

/**
 * The bestiary's rows in the panel: its heading, the count, the picture where
 * the surface draws Svg, and the tally in text.
 *
 * @param {Record<string, Function>} els
 * @param {ReturnType<typeof bestiary>} b
 */
export function renderBestiary(els, b) {
  const { Box, Text } = els;
  const rows = [Text({ bold: true, children: [GAME_WORDS.heading] }), Text({ children: [GAME_WORDS.count(b.defeated, b.about.length)] })];
  if (b.about.length === 0) rows.push(Text({ dimColor: true, children: [GAME_WORDS.none] }));
  if ("Svg" in els && b.about.length + b.defeated > 0)
    rows.push(els.Svg({ source: bestiarySvg(b), alt: `Bestiary: ${GAME_WORDS.count(b.defeated, b.about.length)}` }));
  const tally = bestiaryTally(b);
  if (tally) rows.push(Text({ dimColor: true, wrap: "truncate-end", children: [tally] }));
  return Box({ key: "guided-bestiary", flexDirection: "column", marginTop: 1, children: rows });
}
