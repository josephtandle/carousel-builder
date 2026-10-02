"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { draftDeck, draftCaption, LAYOUT_IDS, buildDeckPrompt } = require("../lib/copy");
const { getLlm, extractJson } = require("../lib/llm");

const TEN = [
  "01-editorial-statement",
  "02-face-claim-cover",
  "03-big-number-cover",
  "04-tweet-card",
  "06-numbered-step",
  "07-contrast-myth-truth",
  "08-data-chart",
  "09-framework-2x2",
  "10-cta-comment-keyword",
  "11-recap-list",
];
const OPENERS = ["01-editorial-statement", "02-face-claim-cover", "03-big-number-cover"];

// The arc every draft must have: a hook first, the call to action last, no template three times in a row.
function assertArc(deck) {
  const layouts = deck.slides.map((slide) => slide.layout);
  assert.ok(OPENERS.includes(layouts[0]), `slide 1 is not a hook: ${layouts[0]}`);
  assert.equal(layouts[layouts.length - 1], "10-cta-comment-keyword");
  assert.equal(layouts.filter((id) => id === "10-cta-comment-keyword").length, 1, "one call to action");
  for (let i = 2; i < layouts.length; i += 1) {
    assert.ok(!(layouts[i] === layouts[i - 1] && layouts[i] === layouts[i - 2]), `${layouts[i]} three times in a row at slide ${i + 1}: ${layouts.join(" ")}`);
  }
}
const EM_DASH = String.fromCharCode(0x2014);
const BRIEF =
  "Stop writing long captions. Lead with one clear promise. Cut every sentence that does not earn the next swipe, then end on a single action.";

function mockLlm(output) {
  const calls = [];
  return {
    name: "mock",
    calls,
    async complete(prompt, options) {
      calls.push({ prompt, options });
      return typeof output === "function" ? output(prompt) : output;
    },
  };
}

function optionalSchema() {
  const file = path.join(__dirname, "..", "lib", "deck-schema.js");
  if (!fs.existsSync(file)) return null;
  try {
    return require(file);
  } catch {
    return null;
  }
}

function assertValidDeck(deck, count) {
  assert.equal(typeof deck.title, "string");
  assert.ok(deck.title.length > 0);
  assert.ok(["portrait", "square", "story"].includes(deck.size));
  assert.equal(deck.slides.length, count);
  for (const slide of deck.slides) {
    assert.ok(TEN.includes(slide.layout), `unexpected layout ${slide.layout}`);
  }
  assertArc(deck);
  const json = JSON.stringify(deck);
  assert.ok(!json.includes(EM_DASH), "deck contains an em dash");
  assert.ok(!json.includes("draftMeta"), "draft meta leaked into the deck JSON");
  assert.equal(deck.slides[deck.slides.length - 1].layout, "10-cta-comment-keyword");
  const schema = optionalSchema();
  if (schema && typeof schema.validateDeck === "function") {
    const verdict = schema.validateDeck(JSON.parse(json));
    assert.ok(verdict.ok, `deck-schema rejected the deck: ${JSON.stringify(verdict.errors)}`);
    const copyWarnings = verdict.warnings.filter((warning) => /the cap is|unknown/.test(warning));
    assert.deepEqual(copyWarnings, [], "no word-cap or unknown-field warnings from deck-schema");
  }
}

test("the layout list is exactly the curated templates in lib/deck-schema.js", () => {
  assert.deepEqual(LAYOUT_IDS, TEN);
  assert.deepEqual([...LAYOUT_IDS].sort(), Object.keys(optionalSchema().LAYOUTS).sort());
  assert.deepEqual([...LAYOUT_IDS].sort(), [...optionalSchema().TEMPLATE_ORDER].sort());
});

test("keyless fallback returns a valid deck of the requested length", async () => {
  for (const count of [3, 4, 5, 8, 12]) {
    const deck = await draftDeck({ brief: BRIEF, slides: count }, { llm: null });
    assertValidDeck(deck, count);
    assert.equal(deck.draftMeta.engine, "fallback");
    assert.equal(deck.slides[0].layout, "01-editorial-statement");
    assert.match(deck.slides[0].headline, /Stop writing long/);
  }
});

test("keyless fallback is deterministic and builds cover, steps, recap, CTA, with the third step in a row restyled", async () => {
  const a = await draftDeck({ brief: BRIEF, slides: 6 }, { llm: null });
  const b = await draftDeck({ brief: BRIEF, slides: 6 }, { llm: null });
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.slides.map((slide) => slide.layout),
    ["01-editorial-statement", "06-numbered-step", "06-numbered-step", "01-editorial-statement", "11-recap-list", "10-cta-comment-keyword"],
  );
  assert.deepEqual(a.slides.filter((slide) => slide.layout === "06-numbered-step").map((slide) => slide.step), ["1", "2"]);
  assert.equal(a.slides[1].title, "Lead with one clear promise");
  assert.equal(a.slides[3].headline, "Then end on a single action", "the third point keeps its words on another template");
  assert.equal(a.slides[4].items.length, 3, "the recap still lists every point");
});

test("every draft has the arc: hook first, call to action last, no template three times in a row", async () => {
  const long = Array.from({ length: 14 }, (_, i) => `Point number ${i + 1} is worth its own slide.`).join(" ");
  for (const count of [3, 5, 8, 10, 14, 20]) {
    const deck = await draftDeck({ brief: long, slides: count }, {});
    assertValidDeck(deck, count);
    const steps = deck.slides.filter((slide) => slide.layout === "06-numbered-step").map((slide) => slide.step);
    assert.deepEqual(steps, steps.map((_, i) => String(i + 1)), "steps count up with no gaps");
  }

  // a model that opens on a step and then repeats itself: same words, repaired arc
  const stubborn = mockLlm(JSON.stringify({
    title: "All steps",
    slides: [
      { layout: "06-numbered-step", title: "Open on the promise", body: "Say what they get." },
      { layout: "06-numbered-step", title: "Second step", body: "" },
      { layout: "06-numbered-step", title: "Third step", body: "" },
      { layout: "06-numbered-step", title: "Fourth step", body: "Keep it short." },
      { layout: "06-numbered-step", title: "Fifth step", body: "" },
      { layout: "01-editorial-statement", headline: "One line" },
      { layout: "01-editorial-statement", headline: "Two lines" },
      { layout: "01-editorial-statement", headline: "Three lines", sub: "And a sub." },
      { layout: "10-cta-comment-keyword", lead: "Comment", keyword: "ARC", promise: "for the outline." },
    ],
  }));
  const deck = await draftDeck({ brief: BRIEF, slides: 9 }, { llm: stubborn });
  assertValidDeck(deck, 9);
  assert.equal(deck.slides[0].layout, "01-editorial-statement");
  assert.equal(deck.slides[0].headline, "Open on the promise");
  assert.equal(deck.slides[3].layout, "01-editorial-statement", "the third step in a row became a statement");
  assert.equal(deck.slides[3].headline, "Fourth step");
  assert.equal(deck.slides[3].sub, "Keep it short.");
  const text = JSON.stringify(deck);
  for (const words of ["Second step", "Third step", "Fifth step", "One line", "Two lines", "Three lines", "And a sub."]) assert.ok(text.includes(words), `lost: ${words}`);
});

test("keyless fallback pads a one-line brief and says so", async () => {
  const deck = await draftDeck({ brief: "how to plan a week", slides: 6 }, {});
  assertValidDeck(deck, 6);
  assert.ok(deck.draftMeta.placeholders > 0);
  assert.match(deck.draftMeta.notes.join(" "), /placeholder/);
});

test("slide count is clamped and size is normalised", async () => {
  const small = await draftDeck({ brief: BRIEF, slides: 1, size: "story" }, {});
  assert.equal(small.slides.length, 3);
  assert.equal(small.size, "story");
  const big = await draftDeck({ brief: BRIEF, slides: 99, size: "banner" }, {});
  assert.equal(big.slides.length, 20);
  assert.equal(big.size, "portrait");
  const byDefault = await draftDeck({ brief: BRIEF }, {});
  assert.equal(byDefault.slides.length, 8);
});

test("an empty brief with no source is rejected", async () => {
  await assert.rejects(() => draftDeck({ brief: "  " }, {}), /brief or sourceText/);
});

test("fallback never uses stat layouts, even when the brief has numbers", async () => {
  const deck = await draftDeck({ brief: "We cut costs by 40% in 3 months. Here is how. Start with the biggest bill.", slides: 5 }, {});
  for (const slide of deck.slides) {
    assert.ok(!["03-big-number-cover", "08-data-chart"].includes(slide.layout));
  }
});

test("llm path parses fenced JSON with prose around it", async () => {
  const llm = mockLlm(
    [
      "Sure, here is the deck:",
      "```json",
      JSON.stringify({
        title: "Shorter captions",
        slides: [
          { layout: "01-editorial-statement", headline: "Your caption is *too* long", sub: "" },
          { layout: "07-contrast-myth-truth", a_label: "Myth", a_text: "Longer captions rank better.", b_label: "Truth", b_text: "Clear captions get *read*." },
          { layout: "06-numbered-step", step: "9", title: "Lead with one promise", body: "Say what they get." },
          { layout: "12-path-line", title: "Cut what does not earn the swipe", body: "Every line pulls forward." },
          { layout: "11-recap-list", title: "Recap", items: ["One promise", "Cut the rest", "One action"] },
          { layout: "10-cta-comment-keyword", lead: "Comment", keyword: "caption", promise: "and I will send the checklist." },
        ],
      }),
      "```",
      "Let me know if you want changes.",
    ].join("\n"),
  );
  const deck = await draftDeck({ brief: BRIEF, slides: 6 }, { llm });
  assertValidDeck(deck, 6);
  assert.equal(deck.draftMeta.engine, "llm:mock");
  assert.equal(deck.title, "Shorter captions");
  assert.equal(deck.slides[1].layout, "07-contrast-myth-truth");
  assert.equal(deck.slides[2].step, "1", "steps are renumbered");
  assert.equal(deck.slides[3].layout, "06-numbered-step", "a retired layout id is drafted as the template that replaced it");
  assert.equal(deck.slides[3].title, "Cut what does not earn the swipe");
  assert.equal(deck.slides[3].step, "2");
  assert.equal(deck.slides[3].path, undefined);
  assert.equal(deck.slides[5].keyword, "CAPTION");
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.json, true);
});

test("no big-number or data-chart layout when the brief has no digits", async () => {
  const llm = mockLlm(
    JSON.stringify({
      title: "Invented numbers",
      slides: [
        { layout: "03-big-number-cover", number: "70%", unit: "of captions never get read" },
        { layout: "08-data-chart", headline: "What works", bars: [{ label: "Short", value: 80, display: "80%" }, { label: "Long", value: 20, display: "20%" }] },
        { layout: "06-numbered-step", title: "Lead with one promise", body: "" },
        { layout: "11-recap-list", items: ["One promise"] },
        { layout: "10-cta-comment-keyword", lead: "Comment", keyword: "SHORT", promise: "for the checklist." },
      ],
    }),
  );
  const deck = await draftDeck({ brief: BRIEF, slides: 5 }, { llm });
  assertValidDeck(deck, 5);
  for (const slide of deck.slides) {
    assert.ok(!["03-big-number-cover", "08-data-chart"].includes(slide.layout), `stat layout survived: ${slide.layout}`);
  }
  assert.equal(deck.slides[0].layout, "01-editorial-statement");
  assert.ok(!/70/.test(deck.slides[0].headline), "the invented number is gone");
  assert.match(llm.calls[0].prompt, /contains no numbers/);
  assert.ok(!llm.calls[0].prompt.includes('"03-big-number-cover"'));
  assert.ok(!llm.calls[0].prompt.includes('"08-data-chart"'));
});

test("a big number is kept only when it appears in the brief", async () => {
  const slides = (number) =>
    JSON.stringify({
      title: "Costs",
      slides: [
        { layout: "03-big-number-cover", number, unit: "lower costs in *three* months" },
        { layout: "06-numbered-step", title: "Start with the biggest bill", body: "" },
        { layout: "10-cta-comment-keyword", lead: "Comment", keyword: "COSTS", promise: "for the sheet." },
      ],
    });
  const brief = "We cut costs by 40% in 3 months. Start with the biggest bill.";
  const kept = await draftDeck({ brief, slides: 3 }, { llm: mockLlm(slides("40%")) });
  assert.equal(kept.slides[0].layout, "03-big-number-cover");
  assert.equal(kept.slides[0].number, "40%");
  const dropped = await draftDeck({ brief, slides: 3 }, { llm: mockLlm(slides("73%")) });
  assert.equal(dropped.slides[0].layout, "01-editorial-statement");
});

test("llm output is repaired: wrong count, missing CTA, unknown layout, em dashes, image fields", async () => {
  const llm = mockLlm(
    JSON.stringify({
      slides: [
        { layout: "editorial-statement", headline: `Short captions ${EM_DASH} they win`, sub: "" },
        { layout: "02-face-claim-cover", headline: "Fix the hook first", photo: "https://example.com/tracker.png" },
        { layout: "made-up-layout", headline: "Something else entirely" },
        { layout: "4", text: "Nobody reads paragraph three.", avatar: "/etc/passwd", name: "Someone" },
      ],
    }),
  );
  const deck = await draftDeck({ brief: BRIEF, slides: 7 }, { llm });
  assertValidDeck(deck, 7);
  assert.equal(deck.slides[0].layout, "01-editorial-statement");
  assert.equal(deck.slides[1].layout, "01-editorial-statement", "face cover needs a portrait, so it became a statement");
  assert.equal(deck.slides[3].layout, "04-tweet-card");
  assert.equal(deck.slides[3].avatar, undefined, "image fields from model output are dropped");
  assert.equal(deck.slides[3].name, undefined);
  assert.ok(!JSON.stringify(deck).includes("tracker.png"));
  assert.match(deck.draftMeta.notes.join(" "), /call to action/);
});

test("brand portrait and name fill image fields", async () => {
  const llm = mockLlm(
    JSON.stringify({
      slides: [
        { layout: "02-face-claim-cover", headline: "Fix the hook first" },
        { layout: "04-tweet-card", text: "Nobody reads paragraph three." },
        { layout: "10-cta-comment-keyword", keyword: "HOOK", promise: "for the guide." },
      ],
    }),
  );
  const deck = await draftDeck({ brief: BRIEF, slides: 3 }, { llm, brand: { name: "Example Studio", portrait: "assets/portrait.svg" } });
  assert.equal(deck.slides[0].layout, "02-face-claim-cover");
  assert.equal(deck.slides[0].photo, "assets/portrait.svg");
  assert.equal(deck.slides[1].name, "Example Studio");
});

test("llm failure or junk output falls back to the keyless deck", async () => {
  const broken = { name: "broken", async complete() { throw new Error("HTTP 529"); } };
  const a = await draftDeck({ brief: BRIEF, slides: 5 }, { llm: broken });
  assertValidDeck(a, 5);
  assert.equal(a.draftMeta.engine, "fallback");
  assert.match(a.draftMeta.notes[0], /HTTP 529/);
  const b = await draftDeck({ brief: BRIEF, slides: 5 }, { llm: mockLlm("I cannot help with that.") });
  assertValidDeck(b, 5);
  assert.equal(b.draftMeta.engine, "fallback");
});

test("sourceText is recreated as a carousel, with and without a key", async () => {
  const sourceText = [
    "I posted daily for years and got nowhere.",
    "",
    "Then I changed three things:",
    "- I picked one topic and stayed on it",
    "- I wrote the hook before anything else",
    "- I replied to every comment in the first hour",
    "",
    "Read more at https://example.com/post #growth @someone",
  ].join("\n");

  const keyless = await draftDeck({ sourceText, slides: 6 }, {});
  assertValidDeck(keyless, 6);
  assert.match(keyless.slides[0].headline.replace(/\*/g, ""), /I posted daily for years/);
  const text = JSON.stringify(keyless);
  assert.match(text, /I picked one topic/);
  assert.ok(!text.includes("example.com"), "links stay out of slides");
  assert.ok(!text.includes("#growth"), "hashtags stay out of slides");

  const llm = mockLlm((prompt) => {
    assert.match(prompt, /SOURCE POST:/);
    assert.match(prompt, /I picked one topic and stayed on it/);
    assert.match(prompt, /Recreate the source post/);
    return JSON.stringify({
      title: "Three changes",
      slides: [
        { layout: "01-editorial-statement", headline: "Posting daily got me *nowhere*" },
        { layout: "05-notes-app", title: "What I changed", lines: ["One topic", "Hook first", "Reply in the first hour"] },
        { layout: "10-cta-comment-keyword", lead: "Comment", keyword: "GROW", promise: "for the full list." },
      ],
    });
  });
  const withKey = await draftDeck({ brief: "growth story", sourceText, slides: 3 }, { llm });
  assertValidDeck(withKey, 3);
  assert.equal(withKey.slides[1].layout, "11-recap-list", "the retired notes layout is drafted as a list");
  assert.equal(withKey.slides[1].title, "What I changed");
  assert.deepEqual(withKey.slides[1].items, ["One topic", "Hook first", "Reply in the first hour"]);
});

test("the prompt carries the rules that matter", () => {
  const prompt = buildDeckPrompt({ brief: "x 5", sourceText: "", count: 8, size: "portrait", allowStats: true, hasPortrait: false });
  assert.match(prompt, /exactly 8 slides/);
  assert.match(prompt, /One idea per slide/);
  assert.match(prompt, /Never invent/);
  assert.ok(!prompt.includes('"02-face-claim-cover"'), "face cover is not offered without a portrait");
  assert.match(prompt, /never use the same layout more than twice in a row/);
  assert.ok(!prompt.includes("05-notes-app") && !prompt.includes("12-path-line"), "retired layouts are not offered");
  for (const id of TEN.filter((id) => id !== "02-face-claim-cover")) assert.ok(prompt.includes(`"${id}"`), `${id} is offered`);
  assert.ok(!prompt.includes(EM_DASH));
});

test("draftCaption keyless fallback", async () => {
  const deck = await draftDeck({ brief: BRIEF, slides: 6 }, {});
  const out = await draftCaption(deck, { llm: null, brand: { defaultHashtags: ["#carousel", "tips"] } });
  assert.match(out.caption, /^Stop writing long captions\./);
  assert.match(out.caption, /1\. Lead with one clear promise/);
  assert.ok(Array.isArray(out.hashtags));
  assert.deepEqual(out.hashtags.slice(0, 2), ["#carousel", "#tips"]);
  assert.ok(out.hashtags.every((tag) => /^#[\p{L}\p{N}_]+$/u.test(tag)));
  assert.ok(!out.caption.includes("*"));
  assert.ok(!out.caption.includes(EM_DASH));
});

test("draftCaption with an llm parses JSON, cleans dashes, normalises hashtags", async () => {
  const deck = await draftDeck({ brief: BRIEF, slides: 5 }, {});
  const llm = mockLlm("```json\n" + JSON.stringify({ caption: `Short wins ${EM_DASH} every time.`, hashtags: "#Writing #captions writing" }) + "\n```");
  const out = await draftCaption(deck, { llm, brand: { name: "Example Studio" } });
  assert.equal(out.caption, "Short wins, every time.");
  assert.deepEqual(out.hashtags, ["#Writing", "#captions"]);
  assert.match(llm.calls[0].prompt, /Slide 1 \(01-editorial-statement\)/);
  assert.match(llm.calls[0].prompt, /ACCOUNT: Example Studio/);

  const failing = await draftCaption(deck, { llm: mockLlm("no json here") });
  assert.match(failing.caption, /Stop writing long captions/);
});

// ---------------------------------------------------------------------------
// lib/llm.js
// ---------------------------------------------------------------------------

function fetchRecorder(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

test("getLlm returns null with no key", () => {
  assert.equal(getLlm({ env: {}, fetchImpl: async () => { throw new Error("no network"); } }), null);
  assert.equal(getLlm({ env: { ANTHROPIC_API_KEY: "  " } }), null);
});

test("getLlm prefers Anthropic, then OpenAI, then Gemini", () => {
  const all = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" };
  assert.equal(getLlm({ env: all }).name, "anthropic");
  assert.equal(getLlm({ env: { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" } }).name, "openai");
  assert.equal(getLlm({ env: { GEMINI_API_KEY: "g" } }).name, "gemini");
});

test("anthropic client calls the Messages API with the default model", async () => {
  const { calls, fetchImpl } = fetchRecorder({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok": true}' }],
  });
  const llm = getLlm({ env: { ANTHROPIC_API_KEY: "test-key-a" }, fetchImpl });
  const out = await llm.complete("Return JSON", { maxTokens: 1234, json: true });
  assert.equal(out, '{"ok": true}');
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key-a");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].body.model, "claude-sonnet-5");
  assert.equal(calls[0].body.max_tokens, 1234);
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "Return JSON" }]);
  assert.equal(calls[0].body.temperature, undefined);
  assert.ok(!calls[0].url.includes("test-key-a"));

  const custom = getLlm({ env: { ANTHROPIC_API_KEY: "k", CAROUSEL_ANTHROPIC_MODEL: "claude-opus-5-5" }, fetchImpl });
  await custom.complete("hi");
  assert.equal(calls[1].body.model, "claude-opus-5-5");
});

test("anthropic refusal and http errors are reported without the key", async () => {
  const refusal = fetchRecorder({ stop_reason: "refusal", content: [] });
  await assert.rejects(() => getLlm({ env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: refusal.fetchImpl }).complete("x"), /declined/);
  const failing = fetchRecorder({ error: { message: "bad key secret-key-123" } }, { ok: false, status: 401 });
  await assert.rejects(
    () => getLlm({ env: { ANTHROPIC_API_KEY: "secret-key-123" }, fetchImpl: failing.fetchImpl }).complete("x"),
    (error) => /HTTP 401/.test(error.message) && !error.message.includes("secret-key-123"),
  );
});

test("openai client calls Chat Completions", async () => {
  const { calls, fetchImpl } = fetchRecorder({ choices: [{ message: { content: " hello " } }] });
  const llm = getLlm({ env: { OPENAI_API_KEY: "test-key-o", CAROUSEL_OPENAI_MODEL: "custom-small" }, fetchImpl });
  assert.equal(await llm.complete("Say hello", { json: true }), "hello");
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key-o");
  assert.equal(calls[0].body.model, "custom-small");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(calls[0].body.messages[calls[0].body.messages.length - 1].content, "Say hello");
});

test("gemini client keeps the key out of the URL", async () => {
  const { calls, fetchImpl } = fetchRecorder({ candidates: [{ content: { parts: [{ text: "hi" }, { text: " there" }] } }] });
  const llm = getLlm({ env: { GEMINI_API_KEY: "test-key-g" }, fetchImpl });
  assert.equal(await llm.complete("Say hi", { json: true, maxTokens: 50 }), "hi there");
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
  assert.ok(!calls[0].url.includes("test-key-g"));
  assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key-g");
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 50);
});

test("extractJson handles fences, prose, trailing commas, and junk", () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here it is: {"a": {"b": "x } y"}} thanks'), { a: { b: "x } y" } });
  assert.deepEqual(extractJson('Note {this} first. {"a": [1, 2,], }'), { a: [1, 2] });
  assert.deepEqual(extractJson("[1, 2]"), [1, 2]);
  assert.deepEqual(extractJson({ already: "parsed" }), { already: "parsed" });
  assert.equal(extractJson("no json at all"), null);
  assert.equal(extractJson(""), null);
});
