"use strict";

// Brief (or a pasted post) -> deck JSON, and deck -> caption.
// Both functions work without any API key: when `llm` is null they fall back
// to a deterministic draft built only from the text they were given.

const fs = require("node:fs");
const { extractJson } = require("./llm");
const schema = require("./deck-schema");

const SIZES = ["portrait", "square", "story"];
const MIN_SLIDES = 3;
const MAX_SLIDES = 20;
const DEFAULT_SLIDES = 8;

// Field spec per template: only the curated set in lib/deck-schema.js is ever drafted. `t` is the field type,
// `cap` a word cap for text, `max` a count cap for lists. Image fields are never taken from model output.
// The "use" line a model reads is the template's own purpose line, plus a drafting note where one is needed.
const use = (id, note) => `${schema.LAYOUTS[id].name}. ${schema.LAYOUTS[id].purpose}${note ? " " + note : ""}`;
const LAYOUTS = {
  "01-editorial-statement": {
    use: use("01-editorial-statement", "Nothing else on the slide."),
    fields: { headline: { t: "text", cap: 12 }, sub: { t: "text", cap: 14 } },
    required: ["headline"],
  },
  "02-face-claim-cover": {
    use: use("02-face-claim-cover", "The claim is 8 words or fewer."),
    fields: { photo: { t: "image" }, eyebrow: { t: "text", cap: 5 }, headline: { t: "text", cap: 8 } },
    required: ["headline"],
    needsPortrait: true,
  },
  "03-big-number-cover": {
    use: use("03-big-number-cover", "As the hook or as the proof. Only with a number that appears in the input."),
    fields: { number: { t: "text", cap: 2 }, unit: { t: "text", cap: 10 }, eyebrow: { t: "text", cap: 5 } },
    required: ["number", "unit"],
    stat: true,
  },
  "04-tweet-card": {
    use: use("04-tweet-card", "One or two sentences."),
    fields: { avatar: { t: "image" }, name: { t: "brandName" }, text: { t: "text", cap: 30 } },
    required: ["text"],
  },
  "06-numbered-step": {
    use: use("06-numbered-step", "Optional copy-and-paste prompt box."),
    fields: {
      step: { t: "auto" },
      title: { t: "text", cap: 9 },
      body: { t: "text", cap: 18 },
      prompt_label: { t: "text", cap: 3 },
      prompt: { t: "text", cap: 20 },
    },
    required: ["title"],
  },
  "07-contrast-myth-truth": {
    use: use("07-contrast-myth-truth", "Myth and truth, before and after, old way and new way: relabel freely."),
    fields: {
      a_label: { t: "text", cap: 3 },
      a_text: { t: "text", cap: 10 },
      b_label: { t: "text", cap: 3 },
      b_text: { t: "text", cap: 10 },
    },
    required: ["a_text", "b_text"],
  },
  "08-data-chart": {
    use: use("08-data-chart", "Only with numbers that appear in the input."),
    fields: { headline: { t: "text", cap: 9 }, bars: { t: "bars" } },
    required: ["headline", "bars"],
    stat: true,
  },
  "09-framework-2x2": {
    use: use("09-framework-2x2"),
    fields: {
      headline: { t: "text", cap: 8 },
      col_a: { t: "text", cap: 4 },
      col_b: { t: "text", cap: 4 },
      row_a: { t: "text", cap: 3 },
      row_b: { t: "text", cap: 3 },
      quads: { t: "quads" },
    },
    required: ["headline", "col_a", "col_b", "row_a", "row_b", "quads"],
  },
  "10-cta-comment-keyword": {
    use: use("10-cta-comment-keyword", "Comment a keyword, or save and share."),
    fields: {
      photo: { t: "image" },
      lead: { t: "text", cap: 3 },
      keyword: { t: "text", cap: 2 },
      promise: { t: "text", cap: 10 },
    },
    required: ["keyword"],
  },
  "11-recap-list": {
    use: use("11-recap-list", "As the recap it goes second to last, every step in two to four words."),
    fields: { title: { t: "text", cap: 6 }, items: { t: "list", cap: 6, max: 6 } },
    required: ["items"],
  },
};

const LAYOUT_IDS = Object.keys(LAYOUTS);
const RETIRED_IDS = Object.keys(schema.LAYOUT_ALIASES);
const CTA_LAYOUT = "10-cta-comment-keyword";
const RECAP_LAYOUT = "11-recap-list";
const STEP_LAYOUT = "06-numbered-step";
const STATEMENT_LAYOUT = "01-editorial-statement";
const QUOTE_LAYOUT = "04-tweet-card";
// Templates that can open a carousel: the hook is a line, a photo with a claim, or one number.
const OPENERS = ["01-editorial-statement", "02-face-claim-cover", "03-big-number-cover"];
const MAX_RUN = 2;   // no template more than twice in a row

const PLACEHOLDER_TITLE = "Add your next point here";
const PLACEHOLDER_BODY = "One idea per slide, in under 20 words.";

const STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from get has have how i if in into is it its just more most my no not " +
    "of on or our out so than that the their them then there these they this to too up use was we what when which who " +
    "why will with you your yours about after again all also any been before being both each every here make makes " +
    "much need needs never only other over same should some stop such take very want where while without would").split(" "),
);

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

function clean(value) {
  return String(value == null ? "" : value)
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\u2013/g, "-")
    .replace(EMOJI, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/,\s*,/g, ",")
    .trim();
}

function stripMarkup(text) {
  return String(text || "").replace(/\*+/g, "").replace(/\s*\n\s*/g, " ").trim();
}

function wordCount(text) {
  const plain = stripMarkup(text);
  return plain ? plain.split(/\s+/).length : 0;
}

function hasDigits(text) {
  return /\d/.test(String(text || ""));
}

// Cut to a word cap. Prefers ending on a full sentence inside the cap.
function capWords(text, cap) {
  const value = clean(text);
  if (!cap || wordCount(value) <= cap) return value;
  const tokens = value.split(/(\s+)/);
  let count = 0;
  let out = "";
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      out += token;
      continue;
    }
    if (count >= cap) break;
    out += token;
    count += 1;
  }
  out = out.trim();
  const sentenceEnd = Math.max(out.lastIndexOf(". "), out.lastIndexOf("? "), out.lastIndexOf("! "));
  if (sentenceEnd > out.length * 0.5) out = out.slice(0, sentenceEnd + 1);
  out = out.replace(/[\s,;:(-]+$/g, "");
  out = out.replace(/\s+(?:and|or|but|to|of|the|a|an|with|for|in|on)$/i, "");
  const stars = (out.match(/\*/g) || []).length;
  if (stars % 2 !== 0) out = out.replace(/\*/g, "");
  return out;
}

// Keeps the first *accent* pair on a slide and drops the rest.
function limitAccents(slide) {
  let used = false;
  const fix = (text) =>
    String(text).replace(/(\*\*[^*]+\*\*)|\*([^*\n]+)\*/g, (whole, strong, accent) => {
      if (strong) return strong;
      if (used) return accent;
      used = true;
      return whole;
    });
  for (const key of Object.keys(slide)) {
    if (key === "layout") continue;
    const value = slide[key];
    if (typeof value === "string") slide[key] = fix(value);
    else if (Array.isArray(value)) {
      slide[key] = value.map((item) => {
        if (typeof item === "string") return fix(item);
        if (item && typeof item === "object" && typeof item.title === "string") return { ...item, title: fix(item.title) };
        return item;
      });
    }
  }
  return slide;
}

function accentLongestWord(text) {
  if (/\*/.test(text)) return text;
  const words = text.match(/[A-Za-z][A-Za-z'-]{4,}/g) || [];
  let best = "";
  for (const word of words) {
    if (!STOPWORDS.has(word.toLowerCase()) && word.length > best.length) best = word;
  }
  if (!best) return text;
  const index = text.indexOf(best);
  return `${text.slice(0, index)}*${best}*${text.slice(index + best.length)}`;
}

function stripSourceNoise(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)[#@][\w.]+/g, "$1")
    .replace(/[ \t]+/g, " ");
}

function splitSentences(text) {
  const out = [];
  for (const rawLine of clean(text).split(/\n+/)) {
    const line = rawLine.replace(/^\s*(?:[-*\u2022]+|\d+[.)]|\(\d+\))\s+/, "").trim();
    if (!line) continue;
    for (const part of line.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e|vs|etc|mr|mrs|ms|dr)\.)\s+/i)) {
      const sentence = part.trim();
      if (/[A-Za-z0-9]/.test(sentence)) out.push(sentence);
    }
  }
  return out;
}

function splitClauses(sentence) {
  const parts = String(sentence)
    .split(/[,;:]\s+|\s+-\s+|\s+(?:and|but|then|so)\s+/)
    .map((part) => part.trim())
    .filter((part) => wordCount(part) >= 3);
  return parts.length >= 2 ? parts : [sentence];
}

function trimEnd(text) {
  return String(text).replace(/[.:;,\s]+$/g, "").trim();
}

function upperFirst(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function clampSlides(value) {
  const count = Math.round(Number(value));
  if (!Number.isFinite(count)) return DEFAULT_SLIDES;
  return Math.max(MIN_SLIDES, Math.min(MAX_SLIDES, count));
}

function normalizeSize(size) {
  return SIZES.includes(size) ? size : "portrait";
}

function withMeta(deck, meta) {
  // Not enumerable, so it never reaches JSON files or schema validation.
  Object.defineProperty(deck, "draftMeta", { value: meta, enumerable: false });
  return deck;
}

// ---------------------------------------------------------------------------
// Keyless fallback
// ---------------------------------------------------------------------------

function headAndRest(sentence, headCap, restCap) {
  const text = trimEnd(sentence);
  if (wordCount(text) <= headCap) return { head: text, rest: "" };
  const boundary = text.search(/[,;:]\s|\s-\s/);
  if (boundary > 0) {
    const head = text.slice(0, boundary).trim();
    const count = wordCount(head);
    if (count >= 3 && count <= headCap) {
      const rest = text.slice(boundary).replace(/^[\s,;:-]+/, "");
      return { head, rest: capWords(upperFirst(rest), restCap) };
    }
  }
  const tokens = text.split(/\s+/);
  // No punctuation to break on: break before a connector near the middle.
  for (let i = 3; i < tokens.length - 2 && i <= headCap; i += 1) {
    if (/^(?:that|which|because|so|when|if|before|after|without|until|unless|instead)$/i.test(tokens[i])) {
      return { head: tokens.slice(0, i).join(" "), rest: capWords(upperFirst(tokens.slice(i).join(" ")), restCap) };
    }
  }
  const headWords = Math.min(headCap, 8);
  return {
    head: tokens.slice(0, headWords).join(" ").replace(/[,;:]+$/, ""),
    rest: capWords(tokens.slice(headWords).join(" "), restCap),
  };
}

function stepSlide(sentence, index) {
  const { head, rest } = headAndRest(sentence, 9, 18);
  return { layout: STEP_LAYOUT, step: String(index + 1), title: upperFirst(head), body: rest ? `${trimEnd(rest)}.` : "" };
}

function placeholderStep(index) {
  return { layout: STEP_LAYOUT, step: String(index + 1), title: PLACEHOLDER_TITLE, body: PLACEHOLDER_BODY };
}

function recapItem(title) {
  const text = trimEnd(stripMarkup(title));
  if (wordCount(text) <= 5) return text;
  const tokens = text.split(/\s+/).slice(0, 5);
  while (tokens.length > 2 && STOPWORDS.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  return tokens.join(" ").replace(/[,;:]+$/, "");
}

function defaultCta() {
  return {
    layout: CTA_LAYOUT,
    lead: "Found this useful?",
    keyword: "SAVE",
    promise: "Save this post and send it to a friend.",
  };
}

// ---------------------------------------------------------------------------
// The arc: hook first, call to action last, no template three times in a row
// ---------------------------------------------------------------------------

// The same content on another template, for the third slide of a run. Lossless where the fields allow it.
function restyle(slide) {
  if (slide.layout === STEP_LAYOUT && !slide.prompt) {
    return { layout: STATEMENT_LAYOUT, headline: slide.title, sub: slide.body || "" };
  }
  if (slide.layout === STATEMENT_LAYOUT) {
    const text = [slide.headline, slide.sub].filter(Boolean).join("\n\n");
    return { layout: QUOTE_LAYOUT, text: capWords(text, 30) };
  }
  const text = firstText(slide);
  if (!text) return null;
  const { head, rest } = headAndRest(text, 12, 14);
  return { layout: STATEMENT_LAYOUT, headline: upperFirst(head), sub: rest ? `${trimEnd(rest)}.` : "" };
}

function breakRuns(slides) {
  for (let i = MAX_RUN; i < slides.length; i += 1) {
    const layout = slides[i].layout;
    let run = true;
    for (let back = 1; back <= MAX_RUN; back += 1) if (slides[i - back].layout !== layout) run = false;
    if (!run) continue;
    const next = restyle(slides[i]);
    if (next) slides[i] = next;
  }
  return slides;
}

// Slide 1 is a hook. Anything else the model put first becomes a statement with the same words.
function ensureOpener(slides) {
  if (!slides.length || OPENERS.includes(slides[0].layout)) return slides;
  const text = firstText(slides[0]);
  if (!text) return slides;
  const { head, rest } = headAndRest(text, 12, 14);
  slides[0] = { layout: STATEMENT_LAYOUT, headline: upperFirst(head), sub: rest ? `${trimEnd(rest)}.` : "" };
  return slides;
}

function fallbackDeck({ brief, slides, sourceText, size }) {
  const notes = [];
  const count = clampSlides(slides);
  const fromSource = Boolean(sourceText && String(sourceText).trim());
  const material = fromSource ? stripSourceNoise(sourceText) : brief;
  let points = splitSentences(material);
  if (!points.length) points = splitSentences(brief);
  if (!points.length) points = [trimEnd(clean(material || brief)) || "Your idea"];

  const cover = headAndRest(points[0], 12, 14);
  const coverSlide = {
    layout: STATEMENT_LAYOUT,
    headline: accentLongestWord(upperFirst(cover.head)),
    sub: cover.rest ? `${trimEnd(cover.rest)}.` : "",
  };

  const stepSlots = count >= 4 ? count - 3 : 1;
  let candidates = points.slice(1);
  // Not enough sentences: break the longest ones into clauses, then pad.
  let guard = 0;
  while (candidates.length < stepSlots && guard < 40) {
    guard += 1;
    let target = -1;
    let longest = 0;
    candidates.forEach((candidate, index) => {
      const clauses = splitClauses(candidate);
      if (clauses.length >= 2 && wordCount(candidate) > longest) {
        longest = wordCount(candidate);
        target = index;
      }
    });
    if (target === -1) break;
    candidates.splice(target, 1, ...splitClauses(candidates[target]).map(upperFirst));
  }
  if (candidates.length > stepSlots) {
    notes.push(`${candidates.length - stepSlots} sentence(s) did not fit and were left out`);
    candidates = candidates.slice(0, stepSlots);
  }
  const steps = candidates.map((sentence, index) => stepSlide(sentence, index));
  let placeholders = 0;
  while (steps.length < stepSlots) {
    steps.push(placeholderStep(steps.length));
    placeholders += 1;
  }
  if (placeholders) notes.push(`${placeholders} placeholder slide(s) added: the text had too few points for ${count} slides`);

  // Recap lines come from every step, then the run of step slides is broken up so the deck has a rhythm.
  const deckSlides = breakRuns([coverSlide, ...steps.map((step) => ({ ...step }))]);
  let stepNumber = 0;
  for (const slide of deckSlides) if (slide.layout === STEP_LAYOUT) slide.step = String((stepNumber += 1));
  if (count >= 4) {
    const items = steps
      .filter((step) => step.title !== PLACEHOLDER_TITLE)
      .slice(0, 6)
      .map((step) => recapItem(step.title));
    // The recap layout needs at least two lines to read as a list.
    while (items.length < 2) items.push(`Recap point ${items.length + 1}`);
    deckSlides.push({ layout: RECAP_LAYOUT, title: "Recap", items });
  }
  deckSlides.push(defaultCta());

  const titleSource = clean(brief) ? splitSentences(brief)[0] || clean(brief) : points[0];
  const deck = {
    title: capWords(trimEnd(stripMarkup(titleSource)), 10) || "Untitled carousel",
    size: normalizeSize(size),
    slides: deckSlides.map(limitAccents),
  };
  return withMeta(deck, { engine: "fallback", placeholders, notes });
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

function layoutCatalog(allowStats, hasPortrait) {
  const lines = [];
  for (const id of LAYOUT_IDS) {
    const spec = LAYOUTS[id];
    if (spec.stat && !allowStats) continue;
    if (spec.needsPortrait && !hasPortrait) continue;
    const fields = Object.entries(spec.fields)
      .filter(([, field]) => field.t !== "image" && field.t !== "auto" && field.t !== "brandName")
      .map(([name, field]) => {
        if (field.t === "text") return `${name} (max ${field.cap} words)`;
        if (field.t === "list") return `${name} (array of up to ${field.max} strings, max ${field.cap} words each)`;
        if (field.t === "bars") return `${name} (array of 3 or 4 objects: {"label", "value" as a number, "display", "highlight" true on exactly one})`;
        if (field.t === "quads") return `${name} (array of exactly 4 objects: {"title" max 4 words, "highlight" true on exactly one}, order: top-left, top-right, bottom-left, bottom-right)`;
        return name;
      });
    lines.push(`- "${id}": ${spec.use} Fields: ${fields.join("; ")}.`);
  }
  return lines.join("\n");
}

function buildDeckPrompt({ brief, sourceText, count, size, allowStats, hasPortrait }) {
  const recreate = Boolean(sourceText && String(sourceText).trim());
  const statsRule = allowStats
    ? "Only use numbers and statistics that appear in the input below. Never invent, round up, or estimate a number."
    : "The input contains no numbers, so do not state any statistic, percentage, price, or count as fact. The big-number and data-chart layouts are not available.";
  return `You are a carousel copywriter. ${recreate ? "Recreate the source post below as a swipeable carousel. Keep its claims and its order of ideas. Do not add facts it does not contain." : "Write a swipeable carousel from the brief below."}

${brief && String(brief).trim() ? `BRIEF:\n${clean(brief)}\n` : ""}${recreate ? `\nSOURCE POST:\n${clean(sourceText)}\n` : ""}
FORMAT: ${size} social carousel, exactly ${count} slides.

LAYOUTS (only these; pick one per slide by what the slide says, not by habit):
${layoutCatalog(allowStats, hasPortrait)}

ARC: a hook that stops the scroll, then proof or the problem, then the steps or points (one per slide), then a contrast slide, then a recap, then the call to action. Slide 1 is a hook: ${hasPortrait ? '"01-editorial-statement", "02-face-claim-cover"' : '"01-editorial-statement"'}${allowStats ? ' or "03-big-number-cover"' : ""}. The last slide is "10-cta-comment-keyword". With enough slides, the second to last is "11-recap-list". Vary the layouts: never use the same layout more than twice in a row.

RULES:
- One idea per slide. 20 words or fewer per slide in total. Respect every word cap.
- Each slide must earn the next swipe.
- Mark at most one accent word per slide with single asterisks, like *this*.
- ${statsRule}
- No em dashes. No emoji. No hashtags. No links. Sources and hashtags belong in the caption, not on slides.
- The call to action keyword is one word in capitals.
- Plain language. No filler, no hype words.

OUTPUT: return only a JSON object, with no markdown fences and no text around it, in this shape:
{"title": "short working title", "slides": [{"layout": "01-editorial-statement", "headline": "...", "sub": ""}]}
The slides array must have exactly ${count} items, and each item only uses the fields listed for its layout.`;
}

function resolveLayout(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (!raw) return null;
  // A retired id (an older draft, or a model that remembers one) resolves to itself here and is upgraded to the
  // template that replaced it in normalizeSlide.
  const known = [...LAYOUT_IDS, ...RETIRED_IDS];
  if (known.includes(raw)) return raw;
  const number = raw.match(/^(\d{1,2})\b/);
  if (number) {
    const prefix = number[1].padStart(2, "0");
    const byNumber = known.find((id) => id.startsWith(`${prefix}-`));
    if (byNumber) return byNumber;
  }
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return known.find((id) => id.slice(3) === slug) || null;
}

function firstText(raw) {
  for (const key of ["headline", "title", "text", "unit", "promise", "b_text", "body", "sub"]) {
    if (typeof raw[key] === "string" && clean(raw[key])) return clean(raw[key]);
  }
  return "";
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/\n+/);
  return [];
}

function numbersIn(text) {
  return (String(text || "").match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ""));
}

function numberAllowed(value, allowed) {
  const found = numbersIn(value);
  return found.length > 0 && found.every((n) => allowed.has(n));
}

function normalizeSlide(given, ctx) {
  if (!given || typeof given !== "object") return null;
  let raw = given;
  let id = resolveLayout(raw.layout);
  if (id && RETIRED_IDS.includes(id)) {
    raw = schema.upgradeSlide({ ...raw, layout: id }).slide;
    id = raw.layout;
  }
  if (!id) {
    const text = firstText(raw);
    return text ? { layout: STATEMENT_LAYOUT, headline: capWords(text, 12), sub: "" } : null;
  }
  const spec = LAYOUTS[id];
  const statement = () => {
    const text = id === "03-big-number-cover" ? clean(raw.unit || raw.eyebrow || "") : firstText(raw);
    return text ? { layout: STATEMENT_LAYOUT, headline: capWords(upperFirst(stripLeadingOf(text)), 12), sub: "" } : null;
  };
  if (spec.needsPortrait && !ctx.portrait) return statement();

  const slide = { layout: id };
  for (const [name, field] of Object.entries(spec.fields)) {
    const value = raw[name];
    if (field.t === "text") {
      slide[name] = typeof value === "string" || typeof value === "number" ? capWords(String(value), field.cap) : "";
    } else if (field.t === "list") {
      slide[name] = toList(value)
        .map((item) => capWords(typeof item === "string" ? item : item && item.text ? item.text : "", field.cap))
        .filter(Boolean)
        .slice(0, field.max);
    } else if (field.t === "bars") {
      const bars = toList(value)
        .filter((bar) => bar && typeof bar === "object" && Number.isFinite(Number(bar.value)))
        .slice(0, 4)
        .map((bar) => ({
          label: capWords(bar.label, 4),
          value: Number(bar.value),
          display: capWords(bar.display == null || bar.display === "" ? String(bar.value) : String(bar.display), 2),
          highlight: bar.highlight === true,
        }));
      if (bars.length && bars.filter((bar) => bar.highlight).length !== 1) {
        const top = bars.reduce((best, bar, index) => (bar.value > bars[best].value ? index : best), 0);
        bars.forEach((bar, index) => {
          bar.highlight = index === top;
        });
      }
      slide[name] = bars.map((bar) => (bar.highlight ? bar : { label: bar.label, value: bar.value, display: bar.display }));
    } else if (field.t === "quads") {
      const quads = toList(value)
        .map((quad) => (typeof quad === "string" ? { title: quad } : quad))
        .filter((quad) => quad && typeof quad === "object" && clean(quad.title))
        .slice(0, 4)
        .map((quad) => ({ title: capWords(quad.title, 4), highlight: quad.highlight === true }));
      if (quads.length === 4 && quads.filter((quad) => quad.highlight).length !== 1) {
        quads.forEach((quad, index) => {
          quad.highlight = index === 0;
        });
      }
      slide[name] = quads.map((quad) => (quad.highlight ? quad : { title: quad.title }));
    } else if (field.t === "image") {
      if (ctx.portrait) slide[name] = ctx.portrait;
    } else if (field.t === "brandName") {
      if (ctx.brandName) slide[name] = capWords(ctx.brandName, 4);
    }
  }

  // Defaults that keep a slide usable.
  if (id === "07-contrast-myth-truth") {
    slide.a_label = slide.a_label || "Myth";
    slide.b_label = slide.b_label || "Truth";
  }
  if (id === RECAP_LAYOUT) slide.title = slide.title || "Recap";
  if (id === CTA_LAYOUT) {
    slide.keyword = stripMarkup(slide.keyword).split(/\s+/)[0].replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
    slide.lead = slide.lead || "Comment";
  }

  // Structural checks.
  for (const name of spec.required) {
    const value = slide[name];
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return statement();
  }
  if (id === "08-data-chart" && slide.bars.length < 2) return statement();
  if (id === "09-framework-2x2" && slide.quads.length !== 4) return statement();
  if (id === RECAP_LAYOUT && slide.items.length < 2) return statement();

  // Never invent statistics: stat layouts need numbers that exist in the input.
  if (spec.stat) {
    if (!ctx.allowStats) return statement();
    if (id === "03-big-number-cover" && !numberAllowed(slide.number, ctx.numbers)) return statement();
    if (id === "08-data-chart") {
      const ok = slide.bars.every((bar) => numberAllowed(`${bar.display} ${bar.value}`, ctx.numbers) || ctx.numbers.has(String(bar.value)));
      if (!ok) return statement();
    }
  }
  return slide;
}

// "of the hours you lose" reads badly once the number is gone.
function stripLeadingOf(text) {
  return String(text).replace(/^(?:of|in|per)\s+/i, "");
}

function finishSlides(slides) {
  let step = 0;
  for (const slide of slides) {
    if (slide.layout === STEP_LAYOUT) {
      step += 1;
      slide.step = String(step);
    }
    limitAccents(slide);
  }
  return slides;
}

function deckFromLlm(parsed, input, ctx) {
  const rawSlides = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.slides) ? parsed.slides : null;
  if (!rawSlides) throw new Error("no slides array in the model output");
  let slides = rawSlides.map((raw) => normalizeSlide(raw, ctx)).filter(Boolean);
  if (slides.length < MIN_SLIDES) throw new Error(`only ${slides.length} usable slide(s) in the model output`);

  const notes = [];
  const count = ctx.count;
  // The deck always ends on the call to action.
  const lastCta = slides.map((slide) => slide.layout).lastIndexOf(CTA_LAYOUT);
  let cta;
  if (lastCta === -1) {
    cta = defaultCta();
    notes.push("the model returned no call to action slide, a default one was added");
  } else {
    cta = slides[lastCta];
    slides = slides.filter((slide) => slide.layout !== CTA_LAYOUT);
  }
  let tail = [cta];
  if (slides.length && slides[slides.length - 1].layout === RECAP_LAYOUT) tail = [slides.pop(), cta];

  const bodySlots = count - tail.length;
  if (slides.length > bodySlots) {
    notes.push(`${slides.length - bodySlots} extra slide(s) were trimmed to reach ${count}`);
    slides = slides.slice(0, Math.max(1, bodySlots));
  } else if (slides.length < bodySlots) {
    const spare = fallbackDeck(input).slides.filter((slide) => slide.layout === STEP_LAYOUT && slide.title !== PLACEHOLDER_TITLE);
    const have = new Set(slides.map((slide) => stripMarkup(slide.title || slide.headline || "").toLowerCase()));
    let added = 0;
    for (const extra of spare) {
      if (slides.length >= bodySlots) break;
      if (have.has(stripMarkup(extra.title).toLowerCase())) continue;
      slides.push(extra);
      added += 1;
    }
    while (slides.length < bodySlots) {
      slides.push(placeholderStep(slides.length));
      added += 1;
    }
    notes.push(`the model returned too few slides, ${added} were filled in`);
  }

  // The arc: a hook first, no template three times in a row (the closing call to action is never restyled).
  const body = breakRuns(ensureOpener([...slides, ...tail.slice(0, -1)]));
  const all = finishSlides([...body, cta]).slice(0, Math.max(count, MIN_SLIDES));
  const title = capWords(trimEnd(stripMarkup(clean((parsed && parsed.title) || ""))), 10);
  return {
    deck: {
      title: title || fallbackDeck(input).title,
      size: normalizeSize(input.size),
      slides: all,
    },
    notes,
  };
}

async function draftDeck({ brief = "", slides = DEFAULT_SLIDES, sourceText = "", size = "portrait" } = {}, { llm = null, brand = null } = {}) {
  const input = { brief: String(brief || ""), slides, sourceText: String(sourceText || ""), size };
  if (!clean(input.brief) && !clean(input.sourceText)) {
    throw new TypeError("draftDeck needs a brief or sourceText");
  }
  if (!llm || typeof llm.complete !== "function") return fallbackDeck(input);

  const everything = `${input.brief}\n${input.sourceText}`;
  const ctx = {
    count: clampSlides(slides),
    allowStats: hasDigits(everything),
    numbers: new Set(numbersIn(everything)),
    portrait: brand && typeof brand.portrait === "string" && brand.portrait ? brand.portrait : "",
    brandName: brand && typeof brand.name === "string" ? brand.name : "",
  };
  try {
    const prompt = buildDeckPrompt({
      brief: input.brief,
      sourceText: input.sourceText,
      count: ctx.count,
      size: normalizeSize(size),
      allowStats: ctx.allowStats,
      hasPortrait: Boolean(ctx.portrait),
    });
    const output = await llm.complete(prompt, { maxTokens: 8000, json: true });
    const parsed = extractJson(output);
    if (!parsed) throw new Error("could not find JSON in the model output");
    const { deck, notes } = deckFromLlm(parsed, input, ctx);
    return withMeta(deck, { engine: `llm:${llm.name || "custom"}`, placeholders: 0, notes });
  } catch (error) {
    const deck = fallbackDeck(input);
    deck.draftMeta.notes.unshift(`model draft failed (${error && error.message ? error.message : "unknown error"}), used the keyless draft`);
    return deck;
  }
}

// ---------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------

function slideLines(slide) {
  const lines = [];
  for (const [key, value] of Object.entries(slide || {})) {
    if (key === "layout" || key === "background" || key === "photo" || key === "avatar" || key === "path") continue;
    if (typeof value === "string" && value.trim()) lines.push(`${key}: ${stripMarkup(value)}`);
    else if (Array.isArray(value)) {
      const items = value
        .map((item) => (typeof item === "string" ? item : item && (item.title || [item.label, item.display].filter(Boolean).join(" "))))
        .filter(Boolean)
        .map(stripMarkup);
      if (items.length) lines.push(`${key}: ${items.join(" | ")}`);
    }
  }
  return lines;
}

function normalizeHashtags(...sources) {
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    const items = Array.isArray(source) ? source : typeof source === "string" ? source.split(/[\s,]+/) : [];
    for (const item of items) {
      const tag = String(item || "").replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(`#${tag}`);
    }
  }
  return out.slice(0, 10);
}

function keywordTags(deck) {
  const text = [deck.title, ...(deck.slides || []).slice(0, 2).map((slide) => slide.headline || slide.title || "")].join(" ");
  const tags = [];
  for (const word of stripMarkup(text).toLowerCase().match(/[a-z][a-z0-9]{4,}/g) || []) {
    if (!STOPWORDS.has(word) && !tags.includes(word)) tags.push(word);
  }
  return tags.slice(0, 4);
}

function readVoiceProfile(brand) {
  const file = brand && typeof brand.voiceProfilePath === "string" ? brand.voiceProfilePath : "";
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return "";
  }
}

function fallbackCaption(deck, brand) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const cover = slides[0] || {};
  const hook = trimEnd(stripMarkup(cover.headline || cover.text || cover.title || deck.title || ""));
  const points = slides
    .filter((slide) => slide.layout === STEP_LAYOUT && slide.title && slide.title !== PLACEHOLDER_TITLE)
    .slice(0, 6)
    .map((slide, index) => `${index + 1}. ${trimEnd(stripMarkup(slide.title))}`);
  const cta = slides.find((slide) => slide.layout === CTA_LAYOUT);
  let closing = "Save this for later and share it with someone who needs it.";
  if (cta && cta.keyword && /comment/i.test(cta.lead || "")) {
    closing = `Comment ${cta.keyword} ${trimEnd(stripMarkup(cta.promise || ""))}.`.replace(/\s+\./, ".");
  }
  const caption = [hook ? `${hook}.` : "", points.join("\n"), closing].filter(Boolean).join("\n\n");
  return {
    caption: clean(caption),
    hashtags: normalizeHashtags(brand && brand.defaultHashtags, keywordTags(deck)),
  };
}

function buildCaptionPrompt(deck, brand) {
  const slideText = (deck.slides || [])
    .map((slide, index) => [`Slide ${index + 1} (${slide.layout})`, ...slideLines(slide)].join("\n"))
    .join("\n\n");
  const voice = readVoiceProfile(brand);
  return `You are writing the caption for a social media carousel post.

${brand && brand.name ? `ACCOUNT: ${brand.name}${brand.handle ? ` (${brand.handle})` : ""}\n\n` : ""}CAROUSEL TITLE: ${deck.title || ""}

CAROUSEL SLIDES:
${slideText}
${voice ? `\nVOICE PROFILE (write the caption in this voice):\n${voice}\n` : ""}
Write one caption that matches the carousel. It should:
- open with a strong first line
- sum up the main promise of the carousel
- end by inviting the same action as the last slide
- sound human, direct, and useful, with no buzzwords and no hype
- only repeat numbers that appear on the slides, never add new claims
- use no em dashes and no emoji

Also choose 6 to 10 relevant hashtags.

Return only a JSON object, with no markdown fences, in this exact shape:
{"caption": "full caption here", "hashtags": ["#tag1", "#tag2"]}`;
}

async function draftCaption(deck, { llm = null, brand = null } = {}) {
  if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) {
    throw new TypeError("draftCaption needs a deck with slides");
  }
  if (!llm || typeof llm.complete !== "function") return fallbackCaption(deck, brand);
  try {
    const output = await llm.complete(buildCaptionPrompt(deck, brand), { maxTokens: 4000, json: true });
    const parsed = extractJson(output);
    const caption = parsed && typeof parsed.caption === "string" ? clean(parsed.caption) : "";
    if (!caption) throw new Error("no caption in the model output");
    const hashtags = normalizeHashtags(parsed.hashtags, brand && brand.defaultHashtags);
    return { caption, hashtags: hashtags.length ? hashtags : fallbackCaption(deck, brand).hashtags };
  } catch {
    return fallbackCaption(deck, brand);
  }
}

module.exports = {
  draftDeck,
  draftCaption,
  LAYOUT_IDS,
  // Exposed for tests and for callers that want to show the prompt.
  buildDeckPrompt,
  buildCaptionPrompt,
};
