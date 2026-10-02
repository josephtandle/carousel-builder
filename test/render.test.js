"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { pathToFileURL } = require("node:url");
const { renderDeck, findChrome, pngSize, chromeScreenshot, cornerCheck, flatCornerBlocks } = require("../lib/render.js");
const { decodePng } = require("../lib/pdf.js");
const { makePng } = require("./publish-helpers.js");
const { splitPanorama } = require("../lib/panorama.js");
const { normalizeBrand } = require("../lib/brand.js");
const { SIZES, LAYOUTS, TEMPLATE_ORDER } = require("../lib/deck-schema.js");
const { listTemplates, renderTemplatePreviews, previewPath, previewDir } = require("../lib/templates.js");

const chrome = findChrome();
const noChrome = chrome ? false : "no Chrome, Chromium or Edge found (install one or set CHROME_BIN to run the render tests)";
if (noChrome) console.log(`# render tests skipped: ${noChrome}`);

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `carousel-test-${name}-`));
const readDeck = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "examples", name), "utf8"));
const neutral = () => normalizeBrand({}, null);
const PNG_MAGIC = "89504e470d0a1a0a";

function assertPngs(files, count, size) {
  assert.equal(files.length, count);
  files.forEach((file, i) => {
    assert.equal(path.basename(file), `slide-${String(i + 1).padStart(2, "0")}.png`);
    assert.equal(fs.readFileSync(file).subarray(0, 8).toString("hex"), PNG_MAGIC, `${file} is not a PNG`);
    assert.deepEqual(pngSize(file), { w: SIZES[size].w, h: SIZES[size].h }, `${path.basename(file)} has the wrong pixel size`);
  });
}

test("findChrome prefers CHROME_BIN and otherwise returns a path or null", () => {
  assert.equal(findChrome({ CHROME_BIN: process.execPath, PATH: "" }), process.execPath);
  const found = findChrome({ CHROME_BIN: path.join(os.tmpdir(), "no-such-browser"), PATH: "" });
  assert.ok(found === null || (typeof found === "string" && fs.existsSync(found)));
  const dir = tmpDir("path");
  try {
    const fake = path.join(dir, "chromium");
    fs.writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    const viaPath = findChrome({ PATH: dir });
    assert.ok(viaPath === fake || process.platform === "darwin", "a chromium binary on PATH is found");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("renderDeck returns a structured failure for an invalid deck or a missing browser, without throwing", async () => {
  const bad = await renderDeck({ slides: [{ layout: "99-nope" }] }, { outDir: path.join(os.tmpdir(), "carousel-never") });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid_deck");
  assert.deepEqual(bad.files, []);
  assert.equal(bad.qa.ok, false);
  assert.match(bad.qa.issues[0], /unknown layout/);

  const none = await renderDeck(readDeck("example-deck.json"), { outDir: path.join(os.tmpdir(), "carousel-never"), chromePath: path.join(os.tmpdir(), "no-such-browser") });
  assert.equal(none.ok, false);
  assert.equal(none.error, "chrome_not_found");
  assert.match(none.qa.issues[0], /CHROME_BIN/);

  const size = await renderDeck(readDeck("example-deck.json"), { size: "banner" });
  assert.equal(size.error, "invalid_size");
});

test("example deck renders 8 portrait PNGs at 1080x1350 and passes QA", { skip: noChrome }, async () => {
  const dir = tmpDir("portrait");
  try {
    const res = await renderDeck(readDeck("example-deck.json"), { outDir: path.join(dir, "out"), size: "portrait", brand: neutral(), baseDir: path.join(ROOT, "examples"), dataDir: dir, chromePath: chrome });
    assert.equal(res.ok, true, res.qa.issues.join("; "));
    assert.deepEqual(res.qa, { ok: true, issues: [] });
    assertPngs(res.files, 8, "portrait");
    assert.equal(res.slides.length, 8);
    assert.ok(res.slides.every((s) => s.captures === 1), "every slide is captured once: no corner needed a second look");
    for (const file of res.files) assert.deepEqual(cornerCheck(file), { ok: true, issues: [], blocks: [] }, `${path.basename(file)} has a flat corner block`);
    console.log(`# portrait example deck: ${res.ms} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("example deck renders 8 square PNGs at 1080x1080 and passes QA", { skip: noChrome }, async () => {
  const dir = tmpDir("square");
  try {
    const res = await renderDeck(readDeck("example-deck.json"), { outDir: path.join(dir, "out"), size: "square", brand: neutral(), baseDir: path.join(ROOT, "examples"), dataDir: dir, chromePath: chrome });
    assert.equal(res.ok, true, res.qa.issues.join("; "));
    assertPngs(res.files, 8, "square");
    console.log(`# square example deck: ${res.ms} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("background deck renders in story size (1080x1920) with the image under a tint and passes QA", { skip: noChrome }, async () => {
  const dir = tmpDir("story");
  try {
    const deck = readDeck("bg-deck.json");
    const res = await renderDeck(deck, { outDir: path.join(dir, "out"), size: "story", brand: neutral(), baseDir: path.join(ROOT, "examples"), dataDir: dir, chromePath: chrome });
    assert.equal(res.ok, true, res.qa.issues.join("; "));
    assertPngs(res.files, deck.slides.length, "story");

    // every template that takes a background is in this deck
    assert.deepEqual(deck.slides.map((s) => s.layout).sort(), Object.keys(LAYOUTS).filter((id) => LAYOUTS[id].supportsBackground).sort());
    assert.ok(deck.slides.every((s) => s.background && s.background.src));

    // the same slides without their background must render different pixels: the image is really there,
    // both as a tinted background (the statement) and as the cover's own full-bleed photo
    const pair = deck.slides.filter((s) => s.layout === "01-editorial-statement" || s.layout === "02-face-claim-cover");
    assert.equal(pair.length, 2);
    const plain = { slides: pair.map((s) => Object.assign({}, s, { background: undefined })) };
    const a = await renderDeck(plain, { outDir: path.join(dir, "plain"), brand: neutral(), baseDir: path.join(ROOT, "examples"), dataDir: dir, chromePath: chrome });
    const b = await renderDeck({ slides: pair }, { outDir: path.join(dir, "bg"), brand: neutral(), baseDir: path.join(ROOT, "examples"), dataDir: dir, chromePath: chrome });
    assert.equal(a.ok && b.ok, true, a.qa.issues.concat(b.qa.issues).join("; "));
    for (const i of [0, 1]) assert.notEqual(Buffer.compare(fs.readFileSync(a.files[i]), fs.readFileSync(b.files[i])), 0, `${pair[i].layout}: the background changed nothing`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the QA gate fails copy that cannot fit, and names the slide", { skip: noChrome }, async () => {
  const dir = tmpDir("overflow");
  try {
    const long = Array.from({ length: 90 }, () => "overflowing").join(" ");
    const res = await renderDeck({ slides: [{ layout: "01-editorial-statement", headline: "Fits fine." }, { layout: "02-face-claim-cover", headline: long }] },
      { outDir: path.join(dir, "out"), brand: neutral(), dataDir: dir, chromePath: chrome });
    assert.equal(res.ok, false);
    assert.equal(res.error, "qa_failed");
    assert.equal(res.slides[0].ok, true);
    assert.equal(res.slides[1].ok, false);
    assert.ok(res.qa.issues.length > 0);
    assert.ok(res.qa.issues.every((i) => i.startsWith("slide-2 (02-face-claim-cover)")), res.qa.issues.join("; "));
    assert.ok(res.warnings.some((w) => /words, the cap is/.test(w)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("local images are only served from the allowlist: deck folder and data dir library yes, elsewhere no", { skip: noChrome }, async () => {
  const deckDir = tmpDir("deckdir"), dataDir = tmpDir("data"), outside = tmpDir("outside");
  try {
    const bg = fs.readFileSync(path.join(ROOT, "assets", "placeholder-background.svg"));
    fs.writeFileSync(path.join(deckDir, "mine.svg"), bg);
    fs.mkdirSync(path.join(dataDir, "library"));
    fs.writeFileSync(path.join(dataDir, "library", "saved.svg"), bg);
    fs.writeFileSync(path.join(outside, "secret.svg"), bg);
    fs.writeFileSync(path.join(deckDir, "notes.txt"), "not an image");
    const slide = (src) => ({ layout: "01-editorial-statement", headline: "Slow mornings.", background: { src, tint: 0.6 } });
    const run = (src) => renderDeck({ slides: [slide(src)] }, { outDir: path.join(deckDir, "out"), brand: neutral(), baseDir: deckDir, dataDir, chromePath: chrome });

    const relative = await run("mine.svg");
    assert.equal(relative.ok, true, relative.qa.issues.join("; "));
    const library = await run(path.join(dataDir, "library", "saved.svg"));
    assert.equal(library.ok, true, library.qa.issues.join("; "));

    const blocked = await run(path.join(outside, "secret.svg"));
    assert.equal(blocked.ok, false);
    assert.match(blocked.qa.issues.join("\n"), /outside the allowed folders/);
    const escaped = await run("../" + path.basename(outside) + "/secret.svg");
    assert.equal(escaped.ok, false);
    assert.match(escaped.qa.issues.join("\n"), /outside the allowed folders/);
    const notImage = await run("notes.txt");
    assert.equal(notImage.ok, false);
    assert.match(notImage.qa.issues.join("\n"), /not an image file/);
    const missing = await run("gone.png");
    assert.equal(missing.ok, false);
    assert.match(missing.qa.issues.join("\n"), /image not found/);
  } finally { for (const d of [deckDir, dataDir, outside]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("render.mjs --all renders all ten templates with their sample content and exits 0", { skip: noChrome }, () => {
  const dir = tmpDir("all");
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, "render.mjs"), "--all", "--out-dir", path.join(dir, "previews"), "--data-dir", dir, "--result", path.join(dir, "result.json")],
      { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { CHROME_BIN: chrome }) });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /10\/10 passed the overflow gate/);
    const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 10);
    console.log(`# render.mjs --all: ${result.ms} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- the template family ---------- */
const familyDeck = () => ({ title: "Family", slides: TEMPLATE_ORDER.map((id) => JSON.parse(JSON.stringify(LAYOUTS[id].sampleSlide))) });

for (const size of Object.keys(SIZES)) {
  test(`every template's sampleSlide renders in ${size} (${SIZES[size].w}x${SIZES[size].h}) and passes the layout check`, { skip: noChrome }, async () => {
    const dir = tmpDir(`family-${size}`);
    try {
      const res = await renderDeck(familyDeck(), { outDir: path.join(dir, "out"), size, brand: neutral(), dataDir: dir, chromePath: chrome });
      assert.equal(res.ok, true, res.qa.issues.join("; "));
      assert.deepEqual(res.warnings, []);
      assertPngs(res.files, TEMPLATE_ORDER.length, size);
      assert.deepEqual(res.slides.map((s) => s.layout), [...TEMPLATE_ORDER]);
      for (const s of res.slides) {
        assert.equal(s.ok, true, `${s.layout}: ${s.issues.join("; ")}`);
        assert.ok(s.textElements > 0, `${s.layout}: no text was rendered`);
        // sample copy is short: no template has to shrink it to make it fit
        for (const [box, scale] of Object.entries(s.fitScales)) assert.ok(scale >= 0.9, `${s.layout}: ${box} shrank to ${scale} in ${size}`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("every template takes copy at its word caps, and the barest copy, without failing the layout check", { skip: noChrome }, async () => {
  const dir = tmpDir("caps");
  try {
    const pool = ["sourdough", "customers", "Thursday", "ordering", "weekend", "bakery", "regulars", "croissants", "mornings", "wholesale", "everything", "deliveries"];
    const words = (n, from = 0) => Array.from({ length: n }, (_, i) => pool[(i + from) % pool.length]).join(" ");
    const atCaps = (id) => {
      const spec = LAYOUTS[id], slide = { layout: id };
      for (const [name, field] of Object.entries(spec.fields)) {
        if (field.type === "text") slide[name] = words(spec.wordCaps[name]);
        else if (field.type === "list" && field.item === "text") slide[name] = Array.from({ length: field.maxItems }, (_, i) => words(spec.wordCaps[name], i));
      }
      return slide;
    };
    const long = TEMPLATE_ORDER.map(atCaps);
    const at = (id) => long.find((s) => s.layout === id);
    Object.assign(at("06-numbered-step"), { step: "12" });
    Object.assign(at("03-big-number-cover"), { number: "$12,480 saved" });
    Object.assign(at("10-cta-comment-keyword"), { keyword: "SOURDOUGH STARTER" });
    at("08-data-chart").bars = [0, 1, 2, 3].map((i) => Object.assign({ label: words(4, i), value: 45 - i * 11, display: `${45 - i * 11} loaves` }, i === 1 ? { highlight: true } : {}));
    at("09-framework-2x2").quads = [0, 1, 2, 3].map((i) => Object.assign({ title: words(4, i) }, i === 0 ? { highlight: true } : {}));
    const short = [
      { layout: "01-editorial-statement", headline: "Bake *less*." },
      { layout: "02-face-claim-cover", headline: "Sold out." },
      { layout: "06-numbered-step", title: "Ask." },
      { layout: "07-contrast-myth-truth", a_text: "Guess.", b_text: "*Ask.*" },
      { layout: "09-framework-2x2", headline: "Bake or drop?", quads: [{ title: "Bake", highlight: true }, { title: "Order" }, { title: "Special" }, { title: "Drop" }] },
      { layout: "03-big-number-cover", number: "9" },
      { layout: "08-data-chart", headline: "Orders.", bars: [{ label: "Ahead", value: 38, highlight: true }, { label: "Walk-in", value: 45 }] },
      { layout: "04-tweet-card", text: "Worth the queue." },
      { layout: "11-recap-list", items: ["Ask", "Bake"] },
      { layout: "10-cta-comment-keyword", keyword: "GO" },
    ];
    assert.deepEqual(short.map((s) => s.layout), [...TEMPLATE_ORDER]);
    for (const size of Object.keys(SIZES)) {
      const res = await renderDeck({ slides: long.concat(short) }, { outDir: path.join(dir, size), size, brand: neutral(), dataDir: dir, chromePath: chrome });
      assert.deepEqual(res.warnings.filter((w) => /the cap is/.test(w)), [], "the long copy is inside the caps");
      assert.equal(res.ok, true, `${size}: ${res.qa.issues.join("; ")}`);
      assert.equal(res.files.length, 20);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a deck saved with retired layout ids still renders, through the alias, with a warning", { skip: noChrome }, async () => {
  const dir = tmpDir("alias");
  try {
    const old = { title: "Saved last year", slides: [
      { layout: "05-notes-app", app: "Notes", title: "Prep the night before", lines: ["Feed the starter", "Weigh the *flour*", "Label every tray"] },
      { layout: "12-path-line", path: "low-high", title: "Start with the loaf that sells out *first*.", body: "That is where an order list pays off soonest." },
    ] };
    const res = await renderDeck(old, { outDir: path.join(dir, "out"), brand: neutral(), dataDir: dir, chromePath: chrome });
    assert.equal(res.ok, true, res.qa.issues.join("; "));
    assert.equal(res.error, undefined);
    assertPngs(res.files, 2, "portrait");
    assert.deepEqual(res.slides.map((s) => s.layout), ["11-recap-list", "06-numbered-step"]);
    assert.equal(res.warnings.length, 2);
    assert.match(res.warnings[0], /"05-notes-app" was retired: rendered with "11-recap-list"/);
    assert.match(res.warnings[1], /"12-path-line" was retired: rendered with "06-numbered-step"/);
    assert.equal(old.slides[0].layout, "05-notes-app", "the saved deck is not rewritten");

    // the same words on the new template give the same picture
    const fresh = await renderDeck({ slides: [{ layout: "11-recap-list", title: "Prep the night before", items: ["Feed the starter", "Weigh the *flour*", "Label every tray"] }] },
      { outDir: path.join(dir, "fresh"), brand: neutral(), dataDir: dir, chromePath: chrome });
    assert.equal(fresh.ok, true);
    assert.deepEqual(fresh.slides[0].fitScales, res.slides[0].fitScales);
    assert.equal(fresh.slides[0].textElements, res.slides[0].textElements);

    // the single-template command line takes a retired id the same way
    const run = spawnSync(process.execPath, [path.join(ROOT, "render.mjs"), "--template", "12-path-line", "--out", path.join(dir, "one.png"), "--data-dir", dir],
      { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { CHROME_BIN: chrome }) });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /"12-path-line" was retired, using "06-numbered-step"/);
    assert.deepEqual(pngSize(path.join(dir, "one.png")), { w: 1080, h: 1350 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("renderTemplatePreviews writes one PNG per template, reuses them on a second call, and follows the brand and size", { skip: noChrome }, async () => {
  const dir = tmpDir("previews");
  try {
    const brand = neutral();
    // two calls at once: the second waits for the first and finds its work done
    const [first, second] = await Promise.all([
      renderTemplatePreviews({ dataDir: dir, brand, chromePath: chrome }),
      renderTemplatePreviews({ dataDir: dir, brand, chromePath: chrome }),
    ]);
    assert.deepEqual(first.map((p) => p.id), listTemplates().map((t) => t.id));
    assert.equal(first.length, 10);
    const folder = previewDir({ dataDir: dir, brand, size: "portrait" });
    assert.equal(path.dirname(folder), path.join(dir, "template-previews"));
    for (const p of first) {
      assert.equal(p.file, previewPath({ dataDir: dir, brand, size: "portrait", id: p.id }));
      assert.equal(p.file, path.join(folder, `${p.id}.png`));
      assert.equal(fs.readFileSync(p.file).subarray(0, 8).toString("hex"), PNG_MAGIC);
      assert.deepEqual(pngSize(p.file), { w: 1080, h: 1350 });
      assert.equal(p.ok, true, `${p.id}: ${(p.issues || []).join("; ")}`);
      assert.equal(p.cached, false);
    }
    assert.deepEqual(fs.readdirSync(folder).filter((f) => f.endsWith(".png")).sort(), first.map((p) => `${p.id}.png`).sort(), "one PNG per template and nothing else");
    assert.deepEqual(fs.readdirSync(path.join(dir, "template-previews")), [path.basename(folder)], "no scratch folder is left behind");
    assert.ok(second.every((p) => p.cached === true && p.ok === true), "the call that waited rendered nothing");
    assert.deepEqual(second.map((p) => p.file), first.map((p) => p.file));

    // a later call is served from the files: nothing is rewritten
    const stamp = () => first.map((p) => fs.statSync(p.file).mtimeMs);
    const before = stamp();
    const t0 = Date.now();
    const again = await renderTemplatePreviews({ dataDir: dir, brand, size: "portrait" });
    assert.ok(again.every((p) => p.cached === true));
    assert.deepEqual(stamp(), before);
    assert.ok(Date.now() - t0 < 1000, "a cached call does not start a browser");

    // one missing file means the set is rendered again; force does the same on a complete set
    fs.unlinkSync(first[3].file);
    const healed = await renderTemplatePreviews({ dataDir: dir, brand, chromePath: chrome });
    assert.ok(healed.every((p) => p.cached === false && fs.existsSync(p.file)));
    const forced = await renderTemplatePreviews({ dataDir: dir, brand, force: true, chromePath: chrome });
    assert.ok(forced.every((p) => p.cached === false));

    // another brand, another size: another folder, and different pixels
    const warm = normalizeBrand({ colors: { bg: "#F7F0E4", bgDeep: "#F0E6D5", bgAlt: "#E9DBC5", text: "#2A1F17", accent: "#C2542D", accentSoft: "#B0471F", highlight: "#7A2E12" } }, null);
    const other = await renderTemplatePreviews({ dataDir: dir, brand: warm, size: "square", chromePath: chrome });
    assert.notEqual(path.dirname(other[0].file), folder);
    assert.match(path.basename(path.dirname(other[0].file)), /^[0-9a-f]{12}-square$/);
    assert.ok(other.every((p) => p.ok === true), other.filter((p) => !p.ok).map((p) => `${p.id}: ${p.issues.join("; ")}`).join(" | "));
    assert.deepEqual(pngSize(other[0].file), { w: 1080, h: 1080 });
    assert.equal(fs.readdirSync(path.join(dir, "template-previews")).length, 2);

    await assert.rejects(renderTemplatePreviews({ dataDir: dir, brand, size: "banner" }), { code: "invalid_size" });
    await assert.rejects(renderTemplatePreviews({ dataDir: dir, brand: warm, size: "story", chromePath: path.join(dir, "no-such-browser") }), { code: "chrome_not_found" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("render.mjs exits 2 on a usage error and 1 on an invalid deck, rendering nothing", () => {
  const usage = spawnSync(process.execPath, [path.join(ROOT, "render.mjs")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: node render\.mjs/);
  const dir = tmpDir("invalid");
  try {
    fs.writeFileSync(path.join(dir, "deck.json"), JSON.stringify({ slides: [{ layout: "99-nope" }] }));
    const run = spawnSync(process.execPath, [path.join(ROOT, "render.mjs"), "--deck", path.join(dir, "deck.json"), "--out-dir", path.join(dir, "out")], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unknown layout/);
    assert.equal(fs.existsSync(path.join(dir, "out")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("splitPanorama cuts one image into slide-sized slices", { skip: noChrome }, async () => {
  const dir = tmpDir("pano");
  try {
    const files = await splitPanorama(path.join(ROOT, "assets", "placeholder-background.svg"), 3, dir, { chromePath: chrome });
    assert.equal(files.length, 3);
    files.forEach((f, i) => {
      assert.equal(path.basename(f), `panorama-0${i + 1}.png`);
      assert.deepEqual(pngSize(f), { w: 1080, h: 1350 });
    });
    assert.notEqual(Buffer.compare(fs.readFileSync(files[0]), fs.readFileSync(files[2])), 0, "slices show different parts of the image");
    await assert.rejects(splitPanorama(path.join(dir, "missing.png"), 3, dir), { code: "image_not_found" });
    await assert.rejects(splitPanorama(path.join(ROOT, "assets", "placeholder-background.svg"), 0, dir), { code: "bad_input" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- capture sanity check: unpainted corner blocks ---------- */
// a slide-like image: a dark gradient with per-pixel grain, so no corner is flat unless a test paints one
const grain = (x, y) => { const n = (x * 7 + y * 13 + ((x * y) % 5)) % 6; return [16 + n, 19 + n + (y >> 6), 20 + n]; };
const withBlock = (block, colour, base = grain) => (x, y) => (x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h ? colour : base(x, y));
const png = (pixel, width = 270, height = 338) => makePng({ width, height, channels: 3, filter: 4, pixel });

test("cornerCheck passes a normal capture and flags a flat block in a corner", () => {
  const clean = png(grain);
  assert.deepEqual(cornerCheck(clean), { ok: true, issues: [], blocks: [] });

  // the reported defect: 63x79 px of the page background, bottom right of a 1080x1350 slide
  const bad = makePng({ width: 1080, height: 1350, channels: 3, filter: 1, pixel: withBlock({ x: 1017, y: 1271, w: 63, h: 79 }, [0x10, 0x13, 0x14]) });
  const res = cornerCheck(bad);
  assert.equal(res.ok, false);
  assert.deepEqual(res.issues, ["capture defect: flat 63x79 block of #101314 in the bottom-right corner (possible unpainted region)"]);
  assert.deepEqual(res.blocks.map((k) => [k.corner, k.x, k.y, k.w, k.h, k.colour]), [["bottom-right", 1017, 1271, 63, 79, "#101314"]]);

  // every corner is covered, a whole unpainted tile row is named as an edge, and a file path works like a buffer
  assert.match(cornerCheck(png(withBlock({ x: 0, y: 0, w: 40, h: 30 }, [1, 2, 3]))).issues[0], /flat 40x30 block of #010203 in the top-left corner/);
  assert.match(cornerCheck(png(withBlock({ x: 230, y: 0, w: 40, h: 30 }, [1, 2, 3]))).issues[0], /in the top-right corner/);
  assert.match(cornerCheck(png(withBlock({ x: 0, y: 308, w: 40, h: 30 }, [1, 2, 3]))).issues[0], /in the bottom-left corner/);
  const row = cornerCheck(png(withBlock({ x: 0, y: 318, w: 270, h: 20 }, [16, 19, 20])));
  assert.deepEqual(row.issues, ["capture defect: flat 270x20 block of #101314 along the bottom edge (possible unpainted region)"]);
  const dir = tmpDir("corner");
  try {
    const file = path.join(dir, "bad.png");
    fs.writeFileSync(file, bad);
    assert.equal(cornerCheck(file).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // too small to be a tile, or not touching the corner: ordinary page content
  assert.equal(cornerCheck(png(withBlock({ x: 262, y: 330, w: 8, h: 8 }, [16, 19, 20]))).ok, true);
  assert.equal(cornerCheck(png(withBlock({ x: 150, y: 200, w: 60, h: 60 }, [16, 19, 20]))).ok, true);
  assert.deepEqual(flatCornerBlocks(decodePng(clean)), []);
  assert.equal(cornerCheck(Buffer.from("not a png")).ok, false);
});

test("cornerCheck with a second capture: a block that is the same twice is page content, a block that changed is a defect", () => {
  const block = { x: 207, y: 259, w: 63, h: 79 };
  const defect = png(withBlock(block, [16, 19, 20])), clean = png(grain);
  const changed = cornerCheck(defect, clean);
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.issues, ["capture defect: flat 63x79 block of #101314 in the bottom-right corner, not the same in a second capture of the page (unpainted region)"]);
  // a solid panel that really is on the page shows up in both captures
  assert.deepEqual(cornerCheck(defect, png(withBlock(block, [16, 19, 20]))).issues, []);
  assert.equal(cornerCheck(defect, defect).ok, true);
  // a second capture of another size can confirm nothing
  assert.equal(cornerCheck(defect, png(withBlock(block, [16, 19, 20]), 270, 300)).ok, false);
  assert.equal(cornerCheck(clean, defect).ok, true, "only the first capture is judged");
});

test("the capture viewport is the full slide, and a flat corner is confirmed with a second capture", { skip: noChrome }, async () => {
  const dir = tmpDir("capture");
  try {
    const page = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1080px;height:1350px;overflow:hidden}</style></head><body>${body}</body></html>`); return pathToFileURL(f).href; };
    const shoot = (url, name) => chromeScreenshot({ chromePath: chrome, url, out: path.join(dir, name), width: 1080, height: 1350 });

    // a gradient to every edge: one capture, and the page sees a 1080x1350 viewport (not the window minus its frame)
    const full = await shoot(page("gradient.html", `<div style="width:1080px;height:1350px;background:repeating-linear-gradient(135deg,#123,#abc 7px,#456 13px)"></div><script>document.title=innerWidth+"x"+innerHeight</script>`), "gradient.png");
    assert.deepEqual(full.viewport, { w: 1080, h: 1350, scale: 1 });
    assert.equal(full.captures, 1);
    assert.deepEqual(full.cornerCheck, { ok: true, issues: [] });
    assert.deepEqual(pngSize(full.out), { w: 1080, h: 1350 });
    const img = decodePng(full.out), last = (1349 * 1080 + 1079) * 3;
    assert.notDeepEqual([img.rgb[last], img.rgb[last + 1], img.rgb[last + 2]], [255, 255, 255], "the bottom right pixel is painted");

    // a page that really is one flat colour: the corner check looks twice, sees the same pixels, and passes
    const flat = await shoot(page("flat.html", `<div style="width:1080px;height:1350px;background:#204060"></div>`), "flat.png");
    assert.equal(flat.captures, 2);
    assert.deepEqual(flat.cornerCheck, { ok: true, issues: [] });

    // a corner block that is different on every frame is never confirmed: the capture is reported, not shipped silently
    const moving = await shoot(page("moving.html", `<div style="width:1080px;height:1350px;background:repeating-linear-gradient(135deg,#123,#abc 7px,#456 13px)"></div>
<div id="b" style="position:absolute;right:0;bottom:0;width:63px;height:79px;background:rgb(0,0,0)"></div>
<script>let n=0;const b=document.getElementById("b");(function tick(){n=(n+1)%250;b.style.background="rgb("+n+",0,"+(250-n)+")";requestAnimationFrame(tick)})()</script>`), "moving.png");
    assert.equal(moving.captures, 3);
    assert.equal(moving.cornerCheck.ok, false);
    assert.match(moving.cornerCheck.issues[0], /^capture defect: flat 63x79 block of #[0-9a-f]{6} in the bottom-right corner, not the same in a second capture/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
