"use strict";
/*
 * Deck schema: the ten slide templates, what each one accepts, how long each field may run, and the deck-level lint.
 *
 *   LAYOUTS          id -> { id, name, purpose, group, supportsBackground, sampleSlide, title, use, fields, required, wordCaps }
 *   TEMPLATE_ORDER   the ids in the order a picker should show them (grouped: open, point, proof, close)
 *   TEMPLATE_GROUPS  group id -> { name, hint }
 *   LAYOUT_ALIASES   retired id -> { to, fields: { old: new }, drop: [..] }. An old deck still renders.
 *   resolveLayoutId  id -> { id, aliasOf } or null
 *   upgradeSlide     slide -> { slide, warning }: a slide on a retired id, rewritten for the template that replaced it
 *   upgradeDeck      deck -> { deck, warnings }
 *   validateDeck     deck -> { ok, errors: [..], warnings: [..] }
 *
 * name is the short human name, purpose the one-line "use it when". title and use are the same two strings under
 * their older keys. sampleSlide is a complete slide in a fictional bakery's voice that passes the layout check;
 * it carries no image paths, so it can be dropped into any deck.
 *
 * fields: name -> { type: "text" | "image" | "enum" | "list", ... }
 *   list fields carry `item` ("text" for a list of strings, or an object spec of sub-fields), minItems, maxItems.
 * wordCaps: field -> max words. For a list of strings the cap is per item; for a list of objects the key is
 *   "<list>.<subfield>" (for example "bars.label").
 *
 * Errors stop a render. Warnings do not: the render gate (kit.js QA) is the final word on what fits.
 * A retired layout id is a warning, never an error.
 */

const SIZES = Object.freeze({
  portrait: Object.freeze({ w: 1080, h: 1350, safeX: 90, safeY: 120 }),
  square: Object.freeze({ w: 1080, h: 1080, safeX: 90, safeY: 96 }),
  story: Object.freeze({ w: 1080, h: 1920, safeX: 90, safeY: 250 }),
});
const DEFAULT_SIZE = "portrait";

const WARN_SLIDES = 10;   // several publishing APIs cap a carousel at 10 images
const MAX_SLIDES = 20;    // the hard platform ceiling

const text = (extra) => Object.assign({ type: "text" }, extra || {});
const image = () => ({ type: "image" });

const TEMPLATE_GROUPS = Object.freeze({
  open: Object.freeze({ name: "Open", hint: "Slide 1: stop the scroll." }),
  point: Object.freeze({ name: "Point", hint: "The middle: one idea per slide." }),
  proof: Object.freeze({ name: "Proof", hint: "A number, a chart or someone's words." }),
  close: Object.freeze({ name: "Close", hint: "The recap and the one action." }),
});

const RAW_LAYOUTS = {
  "01-editorial-statement": {
    name: "Statement",
    purpose: "Use it when one bold line is the whole slide: your hook or your punchline.",
    group: "open",
    supportsBackground: true,
    fields: { eyebrow: text(), headline: text(), sub: text() },
    required: ["headline"],
    wordCaps: { eyebrow: 5, headline: 12, sub: 20 },
    sampleSlide: { headline: "Fresh bread is *not* luck.\nIt is a plan." },
  },
  "02-face-claim-cover": {
    name: "Photo cover",
    purpose: "Use it to open with a face or a photo and one short claim.",
    group: "open",
    supportsBackground: true,
    fields: { photo: image(), eyebrow: text(), headline: text() },
    required: ["headline"],
    wordCaps: { eyebrow: 5, headline: 8 },
    sampleSlide: { headline: "Sell out by *nine*, not by chance." },
  },
  "03-big-number-cover": {
    name: "Big number",
    purpose: "Use it when one number makes the case.",
    group: "proof",
    supportsBackground: true,
    fields: { number: text(), unit: text(), eyebrow: text() },
    required: ["number"],
    wordCaps: { number: 2, unit: 10, eyebrow: 5 },
    sampleSlide: { number: "38%", unit: "of our weekend loaves are ordered ahead." },
  },
  "04-tweet-card": {
    name: "Quote",
    purpose: "Use it for a customer's words, or one opinion in your own voice.",
    group: "proof",
    supportsBackground: true,
    fields: { avatar: image(), name: text(), text: text() },
    required: ["text"],
    wordCaps: { name: 4, text: 30 },
    sampleSlide: { name: "A Saturday regular", text: "I stopped setting an alarm. My loaf is waiting with my name on it." },
  },
  "06-numbered-step": {
    name: "Step",
    purpose: "Use it to teach one step or make one point per slide.",
    group: "point",
    supportsBackground: true,
    fields: { step: text(), title: text(), body: text(), prompt_label: text(), prompt: text() },
    required: ["title"],
    wordCaps: { step: 1, title: 9, body: 18, prompt_label: 3, prompt: 20 },
    sampleSlide: { step: "1", title: "Post the menu on Thursday.", body: "One photo, one link, one clear cut-off time." },
  },
  "07-contrast-myth-truth": {
    name: "Old way, new way",
    purpose: "Use it to set a tired belief against the better one.",
    group: "point",
    supportsBackground: false,
    fields: { a_label: text(), a_text: text(), b_label: text(), b_text: text() },
    required: ["a_text", "b_text"],
    wordCaps: { a_label: 3, a_text: 10, b_label: 3, b_text: 10 },
    sampleSlide: { a_label: "Old way", a_text: "Guess the bake and hope.", b_label: "New way", b_text: "Bake what is *already* sold." },
  },
  "08-data-chart": {
    name: "Bar chart",
    purpose: "Use it to compare two to four numbers, with the one that matters lit.",
    group: "proof",
    supportsBackground: false,
    fields: {
      headline: text(),
      bars: {
        type: "list", minItems: 2, maxItems: 4,
        item: { label: text({ required: true }), value: { type: "number", required: true }, display: text(), highlight: { type: "boolean" } },
      },
    },
    required: ["headline", "bars"],
    wordCaps: { headline: 9, "bars.label": 4, "bars.display": 2 },
    sampleSlide: {
      headline: "Where a week of orders comes from.",
      bars: [
        { label: "Walk-in", value: 45, display: "45%" },
        { label: "Ordered ahead", value: 38, display: "38%", highlight: true },
        { label: "Wholesale", value: 17, display: "17%" },
      ],
    },
  },
  "09-framework-2x2": {
    name: "Two by two",
    purpose: "Use it when four options sort on two questions and one of them wins.",
    group: "point",
    supportsBackground: false,
    fields: {
      headline: text(), col_a: text(), col_b: text(), row_a: text(), row_b: text(),
      quads: { type: "list", minItems: 4, maxItems: 4, item: { title: text({ required: true }), highlight: { type: "boolean" } } },
    },
    required: ["headline", "quads"],
    wordCaps: { headline: 8, col_a: 4, col_b: 4, row_a: 3, row_b: 3, "quads.title": 4 },
    sampleSlide: {
      headline: "What to bake first.",
      col_a: "Sells fast", col_b: "Sells slow", row_a: "Low cost", row_b: "High cost",
      quads: [{ title: "Bake it daily", highlight: true }, { title: "Bake to order" }, { title: "Weekend special" }, { title: "Drop it" }],
    },
  },
  "10-cta-comment-keyword": {
    name: "Call to action",
    purpose: "Use it last: one action and one word to comment.",
    group: "close",
    supportsBackground: false,
    fields: { photo: image(), lead: text(), keyword: text(), promise: text(), byline: text(), logo: image() },
    required: ["keyword"],
    wordCaps: { lead: 3, keyword: 2, promise: 10, byline: 8 },
    sampleSlide: { lead: "Comment", keyword: "MENU", promise: "and we will send this week's bake list." },
  },
  "11-recap-list": {
    name: "List",
    purpose: "Use it to recap the steps, or to list up to six short points.",
    group: "close",
    supportsBackground: true,
    fields: { title: text(), items: { type: "list", item: "text", minItems: 2, maxItems: 6 } },
    required: ["items"],
    wordCaps: { title: 6, items: 6 },
    sampleSlide: { title: "Recap", items: ["Post the menu Thursday", "Close orders Friday noon", "Bake to the *list*", "Keep a small buffer"] },
  },
};

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

const LAYOUTS = (() => {
  const out = {};
  for (const [id, spec] of Object.entries(RAW_LAYOUTS)) {
    out[id] = Object.assign({ id }, spec, {
      title: spec.name,      // older key for name
      use: spec.purpose,     // older key for purpose
      sampleSlide: Object.assign({ layout: id }, spec.sampleSlide),
    });
  }
  return deepFreeze(out);
})();

/* The order a picker shows them in: open, point, proof, close. */
const TEMPLATE_ORDER = Object.freeze([
  "01-editorial-statement", "02-face-claim-cover",
  "06-numbered-step", "07-contrast-myth-truth", "09-framework-2x2",
  "03-big-number-cover", "08-data-chart", "04-tweet-card",
  "11-recap-list", "10-cta-comment-keyword",
]);

/* Templates that take the optional per-slide background: { src, tint }. */
const BACKGROUND_LAYOUTS = Object.freeze(Object.keys(LAYOUTS).filter((id) => LAYOUTS[id].supportsBackground));

/*
 * Retired layout ids. A saved deck that still names one renders with the nearest template and gets a warning.
 * fields renames a field, drop removes one the new template has no place for.
 */
const LAYOUT_ALIASES = deepFreeze({
  "05-notes-app": { to: "11-recap-list", fields: { lines: "items" }, drop: ["app"] },
  "12-path-line": { to: "06-numbered-step", fields: {}, drop: ["path"] },
});

function resolveLayoutId(id) {
  if (typeof id !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(LAYOUTS, id)) return { id, aliasOf: null };
  if (Object.prototype.hasOwnProperty.call(LAYOUT_ALIASES, id)) return { id: LAYOUT_ALIASES[id].to, aliasOf: id };
  return null;
}

/* A slide on a retired id, rewritten for the template that replaced it. Any other slide comes back untouched. */
function upgradeSlide(slide) {
  if (!isPlainObject(slide) || !Object.prototype.hasOwnProperty.call(LAYOUT_ALIASES, slide.layout)) return { slide, warning: null };
  const alias = LAYOUT_ALIASES[slide.layout];
  const next = {};
  for (const [key, value] of Object.entries(slide)) {
    if (key === "layout") { next.layout = alias.to; continue; }
    if (alias.drop.includes(key)) continue;
    const renamed = alias.fields[key] || key;
    if (!(renamed in next) || renamed === key) next[renamed] = value;
  }
  return { slide: next, warning: `layout "${slide.layout}" was retired: rendered with "${alias.to}" (${LAYOUTS[alias.to].name}), the nearest template` };
}

function upgradeDeck(deck) {
  if (!isPlainObject(deck) || !Array.isArray(deck.slides)) return { deck, warnings: [] };
  const warnings = [];
  const slides = deck.slides.map((slide, i) => {
    const up = upgradeSlide(slide);
    if (up.warning) warnings.push(`slides[${i}]: ${up.warning}`);
    return up.slide;
  });
  return { deck: warnings.length ? Object.assign({}, deck, { slides }) : deck, warnings };
}

/* Keys every slide may carry on top of its layout fields. */
const COMMON_FIELDS = Object.freeze({
  layout: { type: "text" },
  background: { type: "background" },
  theme: { type: "enum", values: ["deep"] },
  byline: { type: "text" },
  logo: { type: "image" },
  cue: { type: "text" },
  show_byline: { type: "boolean" },
  show_counter: { type: "boolean" },
  show_progress: { type: "boolean" },
  show_cue: { type: "boolean" },
  show_corners: { type: "boolean" },
});
const DECK_KEYS = new Set(["title", "size", "slides", "caption", "hashtags", "defaults"]);

const EM_DASH = /\u2014/;
const EMOJI = /\p{Extended_Pictographic}/u;

function countWords(value) {
  if (typeof value !== "string") return 0;
  const plain = value.replace(/\*+/g, "").trim();
  return plain ? plain.split(/\s+/).length : 0;
}
function isBlank(v) { return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0); }
function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function checkText(value, where, errors) {
  if (typeof value !== "string") return;
  if (EM_DASH.test(value)) errors.push(`${where}: contains an em dash (use a comma, colon or full stop)`);
  if (EMOJI.test(value)) errors.push(`${where}: contains an emoji (slides are text only)`);
}

function checkValue(spec, value, where, errors) {
  switch (spec.type) {
    case "text":
      if (typeof value !== "string" && typeof value !== "number") errors.push(`${where}: expected text`);
      else checkText(String(value), where, errors);
      break;
    case "image":
      if (typeof value !== "string") errors.push(`${where}: expected an image path or URL`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${where}: expected a number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${where}: expected true or false`);
      break;
    case "enum":
      if (!spec.values.includes(value)) errors.push(`${where}: expected one of ${spec.values.join(", ")}`);
      break;
    default:
      break;
  }
}

function checkCap(cap, value, where, warnings) {
  if (!cap || (typeof value !== "string" && typeof value !== "number")) return;
  const n = countWords(String(value));
  if (n > cap) warnings.push(`${where}: ${n} words, the cap is ${cap}. Long copy shrinks and may fail the render gate`);
}

function checkBackground(bg, where, layoutId, errors, warnings) {
  if (!isPlainObject(bg)) { errors.push(`${where}: expected { "src": path or URL, "tint": 0 to 1 }`); return; }
  if (typeof bg.src !== "string" || !bg.src.trim()) errors.push(`${where}.src: expected an image path or URL`);
  if (bg.tint !== undefined && bg.tint !== null) {
    if (typeof bg.tint !== "number" || !Number.isFinite(bg.tint) || bg.tint < 0 || bg.tint > 1) errors.push(`${where}.tint: expected a number from 0 to 1`);
    else if (bg.tint < 0.35) warnings.push(`${where}.tint: ${bg.tint} is light, text over a photo usually needs 0.5 or more`);
  }
  for (const k of Object.keys(bg)) if (k !== "src" && k !== "tint") warnings.push(`${where}.${k}: unknown key, ignored`);
  if (!BACKGROUND_LAYOUTS.includes(layoutId)) warnings.push(`${where}: layout ${layoutId} does not take a background, it will be ignored`);
}

function checkSlide(given, i, errors, warnings, defaults) {
  const at = `slides[${i}]`;
  if (!isPlainObject(given)) { errors.push(`${at}: expected an object`); return; }
  if (typeof given.layout !== "string" || !given.layout) { errors.push(`${at}.layout: missing`); return; }
  // a retired id is checked as the template that replaced it, with a warning
  const up = upgradeSlide(given);
  const slide = up.slide;
  if (up.warning) warnings.push(`${at}: ${up.warning}`);
  if (!Object.prototype.hasOwnProperty.call(LAYOUTS, slide.layout)) {
    errors.push(`${at}.layout: unknown layout "${slide.layout}". Known layouts: ${Object.keys(LAYOUTS).join(", ")}`);
    return;
  }
  const spec = LAYOUTS[slide.layout];
  const label = `${at} (${slide.layout})`;

  for (const name of spec.required) if (isBlank(slide[name]) && isBlank(defaults[name])) errors.push(`${label}.${name}: required`);

  for (const [name, value] of Object.entries(slide)) {
    if (name === "layout" || name === "slide" || name === "total" || name === "size" || name.startsWith("_")) continue;
    const where = `${label}.${name}`;
    if (name === "background") { if (!isBlank(value)) checkBackground(value, where, slide.layout, errors, warnings); continue; }
    const field = spec.fields[name] || COMMON_FIELDS[name];
    if (!field) { warnings.push(`${where}: unknown field for this layout, ignored`); continue; }
    if (isBlank(value)) continue;

    if (field.type !== "list") {
      checkValue(field, value, where, errors);
      checkCap(spec.wordCaps[name], value, where, warnings);
      continue;
    }
    if (!Array.isArray(value)) { errors.push(`${where}: expected a list`); continue; }
    if (field.minItems && value.length < field.minItems) errors.push(`${where}: needs at least ${field.minItems} item(s), got ${value.length}`);
    if (field.maxItems && value.length > field.maxItems) errors.push(`${where}: takes at most ${field.maxItems} item(s), got ${value.length}`);
    value.forEach((item, j) => {
      const iw = `${where}[${j}]`;
      if (field.item === "text") {
        checkValue({ type: "text" }, item, iw, errors);
        checkCap(spec.wordCaps[name], item, iw, warnings);
        return;
      }
      if (!isPlainObject(item)) { errors.push(`${iw}: expected an object`); return; }
      for (const [sub, subSpec] of Object.entries(field.item)) {
        if (isBlank(item[sub])) { if (subSpec.required) errors.push(`${iw}.${sub}: required`); continue; }
        checkValue(subSpec, item[sub], `${iw}.${sub}`, errors);
        checkCap(spec.wordCaps[`${name}.${sub}`], item[sub], `${iw}.${sub}`, warnings);
      }
      for (const sub of Object.keys(item)) if (!field.item[sub] && !sub.startsWith("_")) warnings.push(`${iw}.${sub}: unknown key, ignored`);
    });
  }
}

function validateDeck(deck) {
  const errors = [], warnings = [];
  if (!isPlainObject(deck)) return { ok: false, errors: ["deck: expected an object with a slides list"], warnings };

  if (deck.title !== undefined && typeof deck.title !== "string") errors.push("title: expected text");
  if (deck.size !== undefined && !Object.prototype.hasOwnProperty.call(SIZES, deck.size)) errors.push(`size: expected one of ${Object.keys(SIZES).join(", ")}`);
  if (deck.caption !== undefined && deck.caption !== null && typeof deck.caption !== "string") errors.push("caption: expected text");
  if (deck.hashtags !== undefined && deck.hashtags !== null && !(Array.isArray(deck.hashtags) && deck.hashtags.every((h) => typeof h === "string"))) errors.push("hashtags: expected a list of text");
  if (deck.defaults !== undefined && !isPlainObject(deck.defaults)) errors.push("defaults: expected an object");
  for (const k of Object.keys(deck)) if (!DECK_KEYS.has(k) && !k.startsWith("_")) warnings.push(`${k}: unknown deck key, ignored`);

  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    errors.push("slides: expected a list with at least one slide");
    return { ok: false, errors, warnings };
  }
  if (deck.slides.length > MAX_SLIDES) errors.push(`slides: ${deck.slides.length} slides, the limit is ${MAX_SLIDES}`);
  else if (deck.slides.length > WARN_SLIDES) warnings.push(`slides: ${deck.slides.length} slides. Some publishing routes stop at ${WARN_SLIDES} images, and 8 to 10 usually reads best`);

  const defaults = isPlainObject(deck.defaults) ? deck.defaults : {};
  deck.slides.forEach((slide, i) => checkSlide(slide, i, errors, warnings, defaults));
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  LAYOUTS, validateDeck, SIZES, DEFAULT_SIZE, BACKGROUND_LAYOUTS, COMMON_FIELDS, WARN_SLIDES, MAX_SLIDES, countWords,
  TEMPLATE_ORDER, TEMPLATE_GROUPS, LAYOUT_ALIASES, resolveLayoutId, upgradeSlide, upgradeDeck,
};
