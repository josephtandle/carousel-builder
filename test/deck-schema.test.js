"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { LAYOUTS, validateDeck, SIZES, BACKGROUND_LAYOUTS, TEMPLATE_ORDER, TEMPLATE_GROUPS, LAYOUT_ALIASES, resolveLayoutId, upgradeSlide, upgradeDeck } = require("../lib/deck-schema.js");
const { listTemplates, previewPath, previewDir, brandHash } = require("../lib/templates.js");
const { normalizeBrand } = require("../lib/brand.js");

const cover = (extra) => Object.assign({ layout: "01-editorial-statement", headline: "One clear line." }, extra || {});
const deckOf = (slides, extra) => Object.assign({ title: "Test", slides }, extra || {});

test("LAYOUTS lists the ten kit templates, each with fields, required and wordCaps", () => {
  const files = fs.readdirSync(path.join(ROOT, "kit", "layouts")).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
  assert.equal(files.length, 10);
  assert.deepEqual(Object.keys(LAYOUTS).sort(), files);
  for (const [id, spec] of Object.entries(LAYOUTS)) {
    assert.ok(Object.keys(spec.fields).length > 0, id);
    assert.ok(Array.isArray(spec.required) && spec.required.length > 0, id);
    for (const r of spec.required) assert.ok(spec.fields[r], `${id}: required field ${r} has no spec`);
    for (const key of Object.keys(spec.wordCaps)) {
      const [field, sub] = key.split(".");
      assert.ok(spec.fields[field], `${id}: wordCaps.${key} has no field`);
      if (sub) assert.ok(spec.fields[field].item[sub], `${id}: wordCaps.${key} has no sub-field`);
      assert.ok(Number.isInteger(spec.wordCaps[key]) && spec.wordCaps[key] > 0);
    }
  }
});

test("every template carries its picker metadata: id, name, purpose, group, supportsBackground, sampleSlide", () => {
  const names = new Set();
  for (const [id, spec] of Object.entries(LAYOUTS)) {
    assert.equal(spec.id, id);
    assert.ok(typeof spec.name === "string" && spec.name.length >= 4 && spec.name.length <= 20, `${id}: name`);
    assert.ok(!names.has(spec.name), `${id}: the name ${spec.name} is used twice`);
    names.add(spec.name);
    assert.match(spec.purpose, /^Use it .{15,90}\.$/, `${id}: purpose is one "Use it ..." line`);
    assert.ok(!spec.purpose.includes("\n"));
    assert.ok(Object.prototype.hasOwnProperty.call(TEMPLATE_GROUPS, spec.group), `${id}: group ${spec.group}`);
    assert.equal(typeof spec.supportsBackground, "boolean", id);
    assert.equal(spec.title, spec.name, `${id}: title stays as the older key for name`);
    assert.equal(spec.use, spec.purpose, `${id}: use stays as the older key for purpose`);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.sampleSlide), `${id}: frozen`);
    assert.ok(!/\u2014/.test(JSON.stringify(spec)), `${id}: em dash`);
  }
  assert.deepEqual(Object.keys(TEMPLATE_GROUPS), ["open", "point", "proof", "close"]);
  for (const group of Object.keys(TEMPLATE_GROUPS)) assert.ok(Object.values(LAYOUTS).some((t) => t.group === group), `no template in group ${group}`);
  assert.deepEqual(BACKGROUND_LAYOUTS, Object.keys(LAYOUTS).filter((id) => LAYOUTS[id].supportsBackground));
});

test("every template's sampleSlide is a complete slide that validates clean, with no image paths", () => {
  for (const [id, spec] of Object.entries(LAYOUTS)) {
    const sample = spec.sampleSlide;
    assert.equal(sample.layout, id);
    for (const r of spec.required) assert.ok(sample[r] !== undefined && sample[r] !== "", `${id}: sampleSlide is missing ${r}`);
    for (const [name, field] of Object.entries(spec.fields)) if (field.type === "image") assert.equal(sample[name], undefined, `${id}: sampleSlide carries an image path in ${name}`);
    const res = validateDeck(deckOf([JSON.parse(JSON.stringify(sample))]));
    assert.deepEqual(res.errors, [], id);
    assert.deepEqual(res.warnings, [], id);
  }
  // the ten samples in display order are themselves a valid deck
  const all = validateDeck(deckOf(TEMPLATE_ORDER.map((id) => LAYOUTS[id].sampleSlide)));
  assert.deepEqual([all.ok, all.errors, all.warnings], [true, [], []]);
});

test("every template's fields exist in its html, and the html's own sample is the sampleSlide", () => {
  for (const [id, spec] of Object.entries(LAYOUTS)) {
    const html = fs.readFileSync(path.join(ROOT, "kit", "layouts", id + ".html"), "utf8");
    const sample = JSON.parse(html.match(/<script type="application\/json" id="content">([\s\S]*?)<\/script>/)[1]);
    for (const field of Object.keys(spec.fields)) {
      assert.ok(new RegExp(`data-(field|src|list)="${field}"`).test(html), `${id}: template has no binding for ${field}`);
    }
    assert.equal(/<main class="slide[^"]*" data-bg/.test(html), spec.supportsBackground, `${id}: data-bg and supportsBackground disagree`);
    assert.match(html, new RegExp(`<title>${spec.name}</title>`), `${id}: the html title is the template name`);
    const res = validateDeck(deckOf([Object.assign({ layout: id }, sample)]));
    assert.deepEqual(res.errors, [], id);
    assert.deepEqual(res.warnings, [], id);
    // same words as the schema sample; the html adds only its placeholder images and the slide counter
    const words = Object.assign({ layout: id }, sample);
    for (const key of ["slide", "total", "photo", "avatar", "logo", "byline"]) delete words[key];
    assert.deepEqual(words, JSON.parse(JSON.stringify(spec.sampleSlide)), `${id}: html sample and sampleSlide differ`);
  }
});

test("listTemplates returns the ten templates in display order with the fields a picker needs", () => {
  const list = listTemplates();
  assert.deepEqual(list.map((t) => t.id), [...TEMPLATE_ORDER]);
  assert.deepEqual(list.map((t) => t.id), [
    "01-editorial-statement", "02-face-claim-cover",
    "06-numbered-step", "07-contrast-myth-truth", "09-framework-2x2",
    "03-big-number-cover", "08-data-chart", "04-tweet-card",
    "11-recap-list", "10-cta-comment-keyword",
  ]);
  assert.deepEqual([...TEMPLATE_ORDER].sort(), Object.keys(LAYOUTS).sort());
  // grouped: open, point, proof, close, each group in one run
  assert.deepEqual(list.map((t) => t.group), ["open", "open", "point", "point", "point", "proof", "proof", "proof", "close", "close"]);
  for (const t of list) {
    assert.deepEqual(Object.keys(t), ["id", "name", "purpose", "group", "supportsBackground", "sampleSlide"]);
    assert.equal(t.name, LAYOUTS[t.id].name);
    assert.equal(t.purpose, LAYOUTS[t.id].purpose);
    assert.equal(t.supportsBackground, BACKGROUND_LAYOUTS.includes(t.id));
    assert.equal(t.sampleSlide.layout, t.id);
  }
  // a caller may edit what it was given without touching the schema
  list[0].sampleSlide.headline = "changed";
  assert.notEqual(listTemplates()[0].sampleSlide.headline, "changed");
  assert.equal(list[0].name, "Statement");
  assert.equal(list[list.length - 1].name, "Call to action");
});

test("previewPath is <dataDir>/template-previews/<brand hash>-<size>/<id>.png and follows the brand", () => {
  const dataDir = path.join(ROOT, "no-such-data-dir");
  const plain = normalizeBrand({}, null), warm = normalizeBrand({ colors: { accent: "#C2542D" } }, null);
  const file = previewPath({ dataDir, brand: plain, size: "square", id: "03-big-number-cover" });
  assert.equal(file, path.join(dataDir, "template-previews", `${brandHash(plain)}-square`, "03-big-number-cover.png"));
  assert.equal(path.dirname(file), previewDir({ dataDir, brand: plain, size: "square" }));
  assert.match(brandHash(plain), /^[0-9a-f]{12}$/);
  assert.equal(brandHash(plain), brandHash(normalizeBrand({}, null)), "the same brand hashes the same");
  assert.notEqual(brandHash(plain), brandHash(warm), "another accent colour is another set of previews");
  assert.equal(previewPath({ dataDir, brand: plain, id: "03-big-number-cover" }), path.join(dataDir, "template-previews", `${brandHash(plain)}-portrait`, "03-big-number-cover.png"));
  assert.throws(() => previewPath({ dataDir, brand: plain, size: "banner", id: "03-big-number-cover" }), { code: "invalid_size" });
  assert.throws(() => previewPath({ dataDir, brand: plain, id: "05-notes-app" }), { code: "unknown_template" });
});

test("a retired layout id validates as the template that replaced it, with a warning and never an error", () => {
  assert.deepEqual(Object.keys(LAYOUT_ALIASES).sort(), ["05-notes-app", "12-path-line"]);
  for (const [old, alias] of Object.entries(LAYOUT_ALIASES)) {
    assert.ok(!LAYOUTS[old], `${old} is retired`);
    assert.ok(LAYOUTS[alias.to], `${old} points at a live template`);
    assert.deepEqual(resolveLayoutId(old), { id: alias.to, aliasOf: old });
  }
  assert.deepEqual(resolveLayoutId("01-editorial-statement"), { id: "01-editorial-statement", aliasOf: null });
  assert.equal(resolveLayoutId("99-made-up"), null);

  const oldDeck = deckOf([
    cover(),
    { layout: "05-notes-app", app: "Notes", title: "Prep the night before", lines: ["Feed the starter", "Weigh the *flour*", "Label every tray"] },
    { layout: "12-path-line", path: "high-low", title: "Start with the loaf that sells out *first*.", body: "That is where an order list pays off soonest." },
  ]);
  const res = validateDeck(oldDeck);
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.deepEqual(res.errors, []);
  assert.equal(res.warnings.length, 2);
  assert.match(res.warnings[0], /^slides\[1\]: layout "05-notes-app" was retired: rendered with "11-recap-list" \(List\)/);
  assert.match(res.warnings[1], /^slides\[2\]: layout "12-path-line" was retired: rendered with "06-numbered-step" \(Step\)/);

  const up = upgradeDeck(oldDeck);
  assert.deepEqual(up.warnings, res.warnings);
  assert.deepEqual(up.deck.slides[1], { layout: "11-recap-list", title: "Prep the night before", items: ["Feed the starter", "Weigh the *flour*", "Label every tray"] });
  assert.deepEqual(up.deck.slides[2], { layout: "06-numbered-step", title: "Start with the loaf that sells out *first*.", body: "That is where an order list pays off soonest." });
  assert.equal(oldDeck.slides[1].layout, "05-notes-app", "the deck that was passed in is not changed");
  assert.deepEqual(validateDeck(up.deck).warnings, []);
  // a deck with nothing retired comes back as the same object, and odd input is left alone
  const fresh = deckOf([cover()]);
  assert.equal(upgradeDeck(fresh).deck, fresh);
  assert.deepEqual(upgradeSlide(cover()).warning, null);
  assert.deepEqual(upgradeDeck(null), { deck: null, warnings: [] });
  // the retired slide is still checked: a real mistake in it is still an error
  assert.equal(validateDeck(deckOf([{ layout: "05-notes-app", title: "Prep", lines: "not a list" }])).ok, false);
});

test("the example decks validate with no errors and no warnings", () => {
  for (const name of ["example-deck.json", "bg-deck.json"]) {
    const deck = JSON.parse(fs.readFileSync(path.join(ROOT, "examples", name), "utf8"));
    const res = validateDeck(deck);
    assert.equal(res.ok, true, name + ": " + res.errors.join("; "));
    assert.deepEqual(res.warnings, [], name);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "examples", "example-deck.json"), "utf8")).slides.length, 8);
});

test("rejects a deck that is not an object or has no slides", () => {
  assert.equal(validateDeck(null).ok, false);
  assert.equal(validateDeck([]).ok, false);
  assert.equal(validateDeck({}).ok, false);
  assert.equal(validateDeck({ slides: [] }).ok, false);
  assert.equal(validateDeck({ slides: ["x"] }).ok, false);
});

test("unknown layout is an error that names the known layouts", () => {
  const res = validateDeck(deckOf([{ layout: "99-made-up", headline: "x" }]));
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /unknown layout "99-made-up"/);
  assert.match(res.errors[0], /01-editorial-statement/);
  assert.equal(validateDeck(deckOf([{ headline: "no layout" }])).ok, false);
});

test("missing required fields and wrong types are errors; deck defaults can supply a required field", () => {
  const res = validateDeck(deckOf([{ layout: "06-numbered-step", step: "1", body: "No title" }]));
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /title: required/);
  assert.equal(validateDeck(deckOf([{ layout: "06-numbered-step", title: "A point with no number" }])).ok, true, "the step numeral is optional");

  assert.equal(validateDeck(deckOf([{ layout: "08-data-chart", headline: "h", bars: [{ label: "A", value: "ten" }, { label: "B", value: 2 }] }])).ok, false);
  assert.equal(validateDeck(deckOf([{ layout: "08-data-chart", headline: "h", bars: [{ label: "A", value: 1 }] }])).ok, false, "one bar is below minItems");
  assert.equal(validateDeck(deckOf([{ layout: "09-framework-2x2", headline: "h", quads: [{ title: "a" }, { title: "b" }, { title: "c" }] }])).ok, false, "a 2x2 needs four quadrants");
  assert.equal(validateDeck(deckOf([{ layout: "08-data-chart", headline: "h", bars: [{ label: "A", value: 1, highlight: "yes" }, { label: "B", value: 2 }] }])).ok, false);
  assert.equal(validateDeck(deckOf([{ layout: "11-recap-list", items: "not a list" }])).ok, false);

  const viaDefaults = validateDeck({ defaults: { keyword: "MENU" }, slides: [{ layout: "10-cta-comment-keyword", lead: "Comment" }] });
  assert.equal(viaDefaults.ok, true, viaDefaults.errors.join("; "));
});

test("slide count: warns above 10, errors above 20", () => {
  const n = (count) => validateDeck(deckOf(Array.from({ length: count }, () => cover())));
  assert.deepEqual(n(10).warnings, []);
  assert.equal(n(11).ok, true);
  assert.match(n(11).warnings.join("\n"), /11 slides/);
  assert.equal(n(20).ok, true);
  assert.equal(n(21).ok, false);
  assert.match(n(21).errors.join("\n"), /21 slides, the limit is 20/);
});

test("word caps warn, per field and per list item, without failing the deck", () => {
  const long = Array.from({ length: 14 }, (_, i) => "word" + i).join(" ");
  const res = validateDeck(deckOf([cover({ headline: long }), { layout: "11-recap-list", items: ["Short one", "this item runs on for far too many words"] }]));
  assert.equal(res.ok, true);
  assert.equal(res.warnings.length, 2);
  assert.match(res.warnings[0], /headline: 14 words, the cap is 12/);
  assert.match(res.warnings[1], /items\[1\]: 9 words, the cap is 6/);
  // markup does not count as words
  assert.deepEqual(validateDeck(deckOf([cover({ headline: "One *two* **three** four five six seven eight nine ten eleven twelve" })])).warnings, []);
});

test("em dashes and emoji in copy are errors", () => {
  const dash = validateDeck(deckOf([cover({ headline: "Bread \u2014 and butter" })]));
  assert.equal(dash.ok, false);
  assert.match(dash.errors[0], /em dash/);
  const emoji = validateDeck(deckOf([{ layout: "11-recap-list", title: "Prep", items: ["Feed the starter \u{1F35E}", "Weigh the flour"] }]));
  assert.equal(emoji.ok, false);
  assert.match(emoji.errors[0], /emoji/);
});

test("background: shape is checked, light tints and unsupported layouts warn", () => {
  const ok = validateDeck(deckOf([cover({ background: { src: "photo.jpg", tint: 0.6 } })]));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(validateDeck(deckOf([cover({ background: "photo.jpg" })])).ok, false);
  assert.equal(validateDeck(deckOf([cover({ background: { tint: 0.5 } })])).ok, false);
  assert.equal(validateDeck(deckOf([cover({ background: { src: "photo.jpg", tint: 1.5 } })])).ok, false);
  assert.match(validateDeck(deckOf([cover({ background: { src: "photo.jpg", tint: 0.1 } })])).warnings.join("\n"), /tint/);
  const unsupported = validateDeck(deckOf([{ layout: "07-contrast-myth-truth", a_text: "Old", b_text: "New", background: { src: "photo.jpg" } }]));
  assert.equal(unsupported.ok, true);
  assert.match(unsupported.warnings.join("\n"), /does not take a background/);
  assert.deepEqual(BACKGROUND_LAYOUTS.map((id) => id.slice(0, 2)), ["01", "02", "03", "04", "06", "11"]);
});

test("size and deck-level fields are checked; unknown keys only warn", () => {
  assert.equal(validateDeck(deckOf([cover()], { size: "landscape" })).ok, false);
  for (const size of Object.keys(SIZES)) assert.equal(validateDeck(deckOf([cover()], { size })).ok, true);
  assert.equal(validateDeck(deckOf([cover()], { hashtags: "#one" })).ok, false);
  assert.equal(validateDeck(deckOf([cover()], { caption: 5 })).ok, false);
  const extra = validateDeck(deckOf([cover({ mystery: "x", show_counter: true })], { colour: "red" }));
  assert.equal(extra.ok, true);
  assert.equal(extra.warnings.length, 2);
});

test("SIZES match the presets inside kit/kit.js and kit/tokens.css", () => {
  assert.deepEqual(SIZES.portrait, { w: 1080, h: 1350, safeX: 90, safeY: 120 });
  assert.deepEqual(SIZES.square, { w: 1080, h: 1080, safeX: 90, safeY: 96 });
  assert.deepEqual(SIZES.story, { w: 1080, h: 1920, safeX: 90, safeY: 250 });
  const kit = fs.readFileSync(path.join(ROOT, "kit", "kit.js"), "utf8");
  const tokens = fs.readFileSync(path.join(ROOT, "kit", "tokens.css"), "utf8");
  for (const [name, s] of Object.entries(SIZES)) {
    assert.ok(kit.includes(`${name}: { w: ${s.w}, h: ${s.h}, safeX: ${s.safeX}, safeY: ${s.safeY} }`), `kit.js ${name}`);
    if (name !== "portrait") assert.ok(tokens.includes(`html[data-size="${name}"] { --h: ${s.h}px; --safe-y: ${s.safeY}px;`), `tokens.css ${name}`);
  }
  assert.ok(tokens.includes("--h: 1350px;") && tokens.includes("--safe-y: 120px;") && tokens.includes("--safe-x: 90px;"));
});
