"use strict";

// The Meta ads carousel handoff: one local JSON file, nothing sent anywhere.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildMetaCarouselSpec, writeMetaCarouselSpec, SPEC_NAME } = require("../lib/meta-handoff.js");
const { createApi } = require("../lib/api.js");
const store = require("../lib/store.js");
const { tmpDir, writeExport, mockFetch } = require("./publish-helpers.js");

const ID = "20260102-093000-sell-out-by-nine";
const SLIDES = [
  { layout: "02-face-claim-cover", headline: "Sell out by *nine*, not by chance." },
  { layout: "03-big-number-cover", number: "38%", unit: "of our weekend loaves are **ordered** ahead." },
  { layout: "06-numbered-step", step: "1", title: "Post the menu on Thursday, with one photo and one clear cut-off time for orders", body: "One link." },
  { layout: "11-recap-list", items: ["Post the menu Thursday", "Close orders Friday noon"] },
  { layout: "10-cta-comment-keyword", lead: "Comment", keyword: "MENU", promise: "and we will send this week's bake list." },
];
const CAPTION = "Selling out is a plan, not a lucky morning. Here is the weekly rhythm we use at our (fictional) bakery: menu on Thursday, orders closed Friday noon, bake to the list.";

function exportOf(count, size) {
  const dir = path.join(tmpDir("carousel-meta-"), "exports", ID);
  const files = writeExport(dir, count, size ? { size } : undefined);
  return { dir, files };
}

test("the spec has exactly the handoff shape, with placeholders where only the advertiser knows the value", () => {
  const { dir, files } = exportOf(5, { width: 40, height: 40 });
  const { spec, warnings } = buildMetaCarouselSpec({ exportDir: dir, files, deckTitle: "Sell out by nine", caption: "Selling out is a plan.", slides: SLIDES });
  assert.deepEqual(Object.keys(spec), ["name", "pageId", "instagramUserId", "message", "link", "callToAction", "optimizeOrder", "endCard", "cards"]);
  assert.deepEqual(spec, {
    name: "Sell out by nine",
    pageId: "FILL_IN_PAGE_ID",
    instagramUserId: "FILL_IN_INSTAGRAM_USER_ID",
    message: "Selling out is a plan.",
    link: "FILL_IN_LINK",
    callToAction: "LEARN_MORE",
    optimizeOrder: false,
    endCard: true,
    cards: [
      { image: "slide-01.png", headline: "Sell out by nine, not by chance." },
      { image: "slide-02.png", headline: "38% of our weekend loaves are ordered" },
      { image: "slide-03.png", headline: "Post the menu on Thursday, with one" },
      { image: "slide-04.png", headline: "Post the menu Thursday" },
      { image: "slide-05.png", headline: "and we will send this week's bake list." },
    ],
  });
  assert.deepEqual(warnings, [], "square slides and a short caption need no warning");
  for (const card of spec.cards) {
    assert.ok(card.headline.length <= 40, card.headline);
    assert.ok(!card.headline.includes("*"));
    assert.deepEqual(Object.keys(card), ["image", "headline"]);
  }
  assert.ok(!/token|secret|access/i.test(JSON.stringify(spec)));
});

test("card count: fewer than 2 is an error, more than 10 takes the first 10 with a warning, 6 or more optimises the order", () => {
  const one = exportOf(1, { width: 40, height: 40 });
  assert.throws(() => buildMetaCarouselSpec({ exportDir: one.dir, files: one.files, deckTitle: "T", caption: "C", slides: [] }), (error) => error.code === "too_few_cards" && /at least 2 slides/.test(error.message));
  assert.throws(() => buildMetaCarouselSpec({ exportDir: one.dir, files: [], deckTitle: "T" }), /at least 2/);

  const two = exportOf(2, { width: 40, height: 40 });
  assert.equal(buildMetaCarouselSpec({ exportDir: two.dir, files: two.files, deckTitle: "T", caption: "C", slides: SLIDES }).spec.cards.length, 2);
  for (const [count, optimise] of [[5, false], [6, true], [10, true]]) {
    const made = exportOf(count, { width: 40, height: 40 });
    const { spec, warnings } = buildMetaCarouselSpec({ exportDir: made.dir, files: made.files, deckTitle: "T", caption: "C", slides: Array.from({ length: count }, () => SLIDES[0]) });
    assert.equal(spec.cards.length, count);
    assert.equal(spec.optimizeOrder, optimise, `${count} cards`);
    assert.deepEqual(warnings, []);
  }
  const many = exportOf(12, { width: 40, height: 40 });
  const { spec, warnings } = buildMetaCarouselSpec({ exportDir: many.dir, files: many.files, deckTitle: "T", caption: "C", slides: Array.from({ length: 12 }, () => SLIDES[0]) });
  assert.equal(spec.cards.length, 10);
  assert.deepEqual(spec.cards.map((card) => card.image), many.files.slice(0, 10).map((file) => path.basename(file)));
  assert.equal(spec.optimizeOrder, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /12 slides.*takes 10.*first 10/);
});

test("message: the caption cut at a whole word within 125 characters, or the title when there is no caption", () => {
  const { dir, files } = exportOf(2, { width: 40, height: 40 });
  const long = buildMetaCarouselSpec({ exportDir: dir, files, deckTitle: "Sell out by nine", caption: CAPTION, slides: SLIDES });
  assert.ok(long.spec.message.length <= 125);
  assert.ok(CAPTION.startsWith(long.spec.message));
  assert.ok(/\s/.test(CAPTION[long.spec.message.length]) || /[\s,;:.]/.test(CAPTION[long.spec.message.length]), "cut between words");
  assert.equal(long.warnings.filter((warning) => /longer than 125/.test(warning)).length, 1);

  const none = buildMetaCarouselSpec({ exportDir: dir, files, deckTitle: "Sell out by *nine*", caption: "   ", slides: SLIDES });
  assert.equal(none.spec.message, "Sell out by nine");
  assert.equal(none.spec.name, "Sell out by nine");
  assert.equal(none.warnings.filter((warning) => /no caption/.test(warning)).length, 1);

  const hard = buildMetaCarouselSpec({ exportDir: dir, files, deckTitle: "T", caption: "x".repeat(300), slides: [{ headline: "y".repeat(90) }, {}] });
  assert.equal(hard.spec.message.length, 125);
  assert.equal(hard.spec.cards[0].headline.length, 40);
  assert.equal(hard.spec.cards[1].headline, "T", "a slide with no line of its own uses the title");
  assert.ok(hard.warnings.some((warning) => /Slide 2 has no headline/.test(warning)));
  assert.equal(buildMetaCarouselSpec({ exportDir: dir, files, deckTitle: "", caption: "", slides: [] }).spec.name, "Carousel");
});

test("slides that are not square get a warning that says to render in Square", () => {
  const portrait = exportOf(3);
  const { warnings } = buildMetaCarouselSpec({ exportDir: portrait.dir, files: portrait.files, deckTitle: "T", caption: "C", slides: SLIDES });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /40x50.*square images \(1:1\).*Square and render again/);
});

test("a slide outside the export folder is refused, and the file is written without following a link", () => {
  const { dir, files } = exportOf(2, { width: 40, height: 40 });
  const outside = path.join(tmpDir("carousel-meta-out-"), "slide-09.png");
  fs.copyFileSync(files[0], outside);
  assert.throws(() => buildMetaCarouselSpec({ exportDir: dir, files: [files[0], outside], deckTitle: "T" }), (error) => error.code === "outside_export");

  const target = path.join(path.dirname(outside), "written-through.json");
  fs.symlinkSync(target, path.join(dir, SPEC_NAME));
  const written = writeMetaCarouselSpec({ exportDir: dir, files, deckTitle: "T", caption: "C", slides: SLIDES });
  assert.equal(written.file, path.join(dir, SPEC_NAME));
  assert.ok(!fs.existsSync(target), "the link was replaced, not followed");
  assert.ok(fs.lstatSync(written.file).isFile());
  assert.deepEqual(JSON.parse(fs.readFileSync(written.file, "utf8")), written.spec);
  // Writing again replaces the file.
  writeMetaCarouselSpec({ exportDir: dir, files, deckTitle: "Second", caption: "C", slides: SLIDES });
  assert.equal(JSON.parse(fs.readFileSync(written.file, "utf8")).name, "Second");
});

test("api, recipe and command: the file lands beside the slides and nothing touches the network", async () => {
  const dataDir = tmpDir("carousel-meta-api-");
  const fetchImpl = mockFetch(() => { throw new Error("the handoff must not use the network"); });
  const deck = { title: "Sell out by nine", size: "portrait", slides: SLIDES, caption: "Selling out is a plan.", hashtags: ["#bakery"] };
  store.saveDraft(deck, { dataDir, id: ID });
  const dir = path.join(dataDir, "exports", ID);
  writeExport(dir, 5, { manifest: { title: "Sell out by nine", caption: "From the manifest" } });
  const api = createApi({ dataDir, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "made-up-secret-value" }, fetchImpl });

  const reply = await api.handle("export", "GET", { query: { id: ID, format: "meta" } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  assert.equal(reply.json.file, `exports/${ID}/meta-carousel.json`);
  assert.deepEqual(reply.json.fillIn, ["pageId", "instagramUserId", "link"]);
  assert.equal(reply.json.spec.cards.length, 5);
  assert.equal(reply.json.spec.message, "Selling out is a plan.");
  assert.equal(reply.json.spec.cards[0].headline, "Sell out by nine, not by chance.");
  assert.equal(reply.json.warnings.length, 1, "the helper slides are 40x50, so one warning about square");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SPEC_NAME), "utf8")), reply.json.spec);
  assert.ok(!JSON.stringify(reply.json).includes("made-up-secret-value"));
  assert.equal((await api.handle("export", "GET", { query: { id: ID } })).json.meta, `/api/export?id=${ID}&format=meta`);

  const download = await api.handle("export", "GET", { query: { id: ID, format: "meta", download: "1" } });
  assert.equal(download.status, 200);
  assert.equal(download.headers["Content-Disposition"], `attachment; filename="${ID}-meta-carousel.json"`);
  assert.deepEqual(JSON.parse(download.buffer.toString("utf8")), reply.json.spec);

  // One slide is not a carousel; an unknown id is a 404; a failed layout check is said out loud.
  const single = "20260102-093000-single";
  writeExport(path.join(dataDir, "exports", single), 1);
  const tooFew = await api.handle("export", "GET", { query: { id: single, format: "meta" } });
  assert.equal(tooFew.status, 422);
  assert.equal(tooFew.json.code, "too_few_cards");
  assert.equal((await api.handle("export", "GET", { query: { id: "20260102-093000-none", format: "meta" } })).status, 404);
  const flawed = "20260102-093000-flawed";
  writeExport(path.join(dataDir, "exports", flawed), 2, { qa: { ok: false, issues: ["slide 2: text overflows"] } });
  const warned = await api.handle("export", "GET", { query: { id: flawed, format: "meta" } });
  assert.equal(warned.status, 200);
  assert.match(warned.json.warnings[0], /layout check/);

  // The recipe and the command go through the same call.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "recipes", "export-meta-carousel.recipe.json"), "utf8"));
  assert.equal(manifest.id, "agent/carousel-builder/export-meta-carousel");
  assert.equal(manifest.handler, "./export-meta-carousel.js");
  assert.equal(manifest.safety.destructive, false);
  assert.equal(manifest.phrases.length, 5);
  assert.equal(manifest.phrases.filter((phrase) => !/carousel/i.test(phrase)).length, 2);
  fs.rmSync(path.join(dir, SPEC_NAME));
  const recipe = await require("../recipes/export-meta-carousel.js").runRecipe({ id: ID }, { env: {}, dataDir, fetchImpl });
  assert.equal(recipe.status, "ok", recipe.reply);
  assert.equal(recipe.metadata.file, path.join(dataDir, "exports", ID, SPEC_NAME));
  assert.ok(fs.existsSync(recipe.metadata.file));
  assert.match(recipe.reply, /Fill in before use: pageId, instagramUserId, link\./);
  assert.match(recipe.reply, /Meta was not contacted/);
  assert.equal((await require("../recipes/export-meta-carousel.js").runRecipe({ id: "../x" }, { env: {}, dataDir, fetchImpl })).status, "error");
  assert.equal((await require("../recipes/export-meta-carousel.js").runRecipe({ id: single }, { env: {}, dataDir, fetchImpl })).status, "error");

  const { main } = require("../bin/carousel.js");
  let stdout = "";
  assert.equal(await main(["export-meta", ID, "--data", dataDir], { stdout: (chunk) => { stdout += chunk; }, stderr: () => {} }), 0);
  assert.match(stdout, /Meta ads carousel handoff written: .*meta-carousel\.json/);
  let usage = "";
  assert.equal(await main(["export-meta"], { stdout: () => {}, stderr: (chunk) => { usage += chunk; } }), 1);
  assert.match(usage, /Usage: carousel export-meta <id>/);
  assert.equal(await main(["export-meta", single, "--data", dataDir], { stdout: () => {}, stderr: () => {} }), 1);
  assert.equal(fetchImpl.calls.length, 0);
});
