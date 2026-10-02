"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { loadBrand, brandCss, DEFAULT_BRAND, normalizeBrand } = require("../lib/brand.js");
const { renderDeck, findChrome } = require("../lib/render.js");

const chrome = findChrome();
const noChrome = chrome ? false : "no Chrome, Chromium or Edge found (set CHROME_BIN to run the render tests)";
const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `carousel-test-${name}-`));

test("DEFAULT_BRAND is neutral: no byline, logo or portrait, all chrome off", () => {
  assert.equal(DEFAULT_BRAND.byline, "");
  assert.equal(DEFAULT_BRAND.name, "");
  assert.equal(DEFAULT_BRAND.logo, null);
  assert.equal(DEFAULT_BRAND.portrait, null);
  for (const v of Object.values(DEFAULT_BRAND.chrome)) assert.equal(v, false);
  assert.deepEqual(Object.keys(DEFAULT_BRAND.colors), ["bg", "bgDeep", "bgAlt", "text", "accent", "accentSoft", "highlight"]);
});

test("brandCss(DEFAULT_BRAND) matches the defaults written in kit/tokens.css", () => {
  const tokens = fs.readFileSync(path.join(ROOT, "kit", "tokens.css"), "utf8");
  const lines = brandCss(DEFAULT_BRAND).split("\n").filter((l) => l.trim().startsWith("--"));
  assert.ok(lines.length >= 19);
  for (const line of lines) assert.ok(tokens.includes(line.trim()), `tokens.css is missing or differs on: ${line.trim()}`);
});

test("layouts and tokens carry no hardcoded brand colours", () => {
  const files = [path.join(ROOT, "kit", "tokens.css")].concat(
    fs.readdirSync(path.join(ROOT, "kit", "layouts")).filter((f) => f.endsWith(".html")).map((f) => path.join(ROOT, "kit", "layouts", f)));
  assert.equal(files.length, 11);   // tokens.css plus the ten templates
  for (const file of files) {
    const css = fs.readFileSync(file, "utf8");
    const literals = (css.match(/rgba?\(\s*\d[^)]*\)/g) || []).filter((m) => !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(m));
    assert.deepEqual(literals, [], `${path.basename(file)} still has colour literals`);
    if (file.endsWith(".html")) {
      const style = (css.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
      const hex = (style.match(/#[0-9a-fA-F]{3,6}\b/g) || []).filter((h) => h.toLowerCase() !== "#000");
      assert.deepEqual(hex, [], `${path.basename(file)} still has hex colours in its styles`);
    }
  }
});

test("config/brand.example.json documents every key and holds the neutral default", () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "brand.example.json"), "utf8"));
  const doc = example._doc;
  for (const key of Object.keys(DEFAULT_BRAND)) {
    assert.ok(key in example, `example is missing ${key}`);
    assert.ok(key in doc, `_doc is missing ${key}`);
  }
  for (const group of ["colors", "chrome", "fonts"]) {
    for (const key of Object.keys(DEFAULT_BRAND[group])) assert.ok(typeof doc[group][key] === "string" && doc[group][key].length > 10, `_doc.${group}.${key}`);
  }
  const { warnings, source, ...loaded } = normalizeBrand(example, path.join(ROOT, "config"));
  assert.deepEqual(warnings, []);
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(DEFAULT_BRAND)));
});

test("loadBrand falls back to the example config, then merges a user brand.json over the defaults", () => {
  const dir = tmpDir("brand");
  try {
    const fallback = loadBrand(dir);
    assert.equal(fallback.colors.accent, DEFAULT_BRAND.colors.accent);
    assert.equal(fallback.byline, "");

    fs.copyFileSync(path.join(ROOT, "assets", "placeholder-logo.svg"), path.join(dir, "mark.svg"));
    fs.writeFileSync(path.join(dir, "brand.json"), JSON.stringify({
      _note: "ignored",
      name: "Riverbend Bakery",
      byline: "**Riverbend Bakery** · Fresh every morning",
      colors: { accent: "#c63", bg: "not-a-colour" },
      logo: "mark.svg",
      portrait: "missing.jpg",
      chrome: { showCounter: true },
      defaultHashtags: ["#bakery", 7, ""],
    }));
    const brand = loadBrand(dir);
    assert.equal(brand.name, "Riverbend Bakery");
    assert.equal(brand.colors.accent, "#CC6633");
    assert.equal(brand.colors.bg, DEFAULT_BRAND.colors.bg);
    assert.equal(brand.colors.text, DEFAULT_BRAND.colors.text);
    assert.equal(brand.logo, path.join(dir, "mark.svg"));
    assert.equal(brand.portrait, null);
    assert.equal(brand.chrome.showCounter, true);
    assert.equal(brand.chrome.showByline, false);
    assert.deepEqual(brand.defaultHashtags, ["#bakery"]);
    assert.equal(brand.warnings.length, 2);
    assert.equal(brand.source, path.join(dir, "brand.json"));

    fs.writeFileSync(path.join(dir, "brand.json"), "{ not json");
    const broken = loadBrand(dir);
    assert.equal(broken.colors.accent, DEFAULT_BRAND.colors.accent);
    assert.equal(broken.warnings.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("brandCss derives every variable from the brand and cannot be broken out of", () => {
  const css = brandCss(normalizeBrand({ colors: { bg: "#ffffff", text: "#111111", accent: "#ff0000", accentSoft: "#ff8080" } }, null));
  assert.match(css, /--bg: #FFFFFF;/);
  assert.match(css, /--bg-rgb: 255, 255, 255;/);
  assert.match(css, /--accent-rgb: 255, 0, 0;/);
  assert.match(css, /--accent-mid: #FF2626;/);
  assert.match(css, /--font-display: "Cormorant Garamond", Georgia/);

  const dir = tmpDir("font");
  try {
    fs.copyFileSync(path.join(ROOT, "kit", "fonts", "PlusJakartaSans.woff2"), path.join(dir, "Custom.woff2"));
    const brand = normalizeBrand({ fonts: { display: { family: 'Evil"</style><script>x', file: "Custom.woff2" } } }, dir);
    const out = brandCss(brand, { assetUrl: () => "/fonts/custom.woff2" });
    assert.match(out, /@font-face\{font-family:"Evilstylescriptx"/);
    assert.match(out, /url\("\/fonts\/custom\.woff2"\) format\("woff2"\)/);
    assert.ok(!out.includes("<"), "no markup can reach the style block");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("two different brands both pass QA and produce different pixels", { skip: noChrome }, async () => {
  const dir = tmpDir("two-brands");
  try {
    const deck = { title: "Brand check", slides: [{ layout: "01-editorial-statement", headline: "Fresh bread is *not* luck.\nIt is a plan." }] };
    const sand = normalizeBrand({
      name: "Riverbend Bakery",
      byline: "**Riverbend Bakery** · Fresh every morning",
      logo: path.join(ROOT, "assets", "placeholder-logo.svg"),
      colors: { bg: "#1A1410", bgDeep: "#211911", bgAlt: "#33241A", text: "#FFF6EA", accent: "#E08A3C", accentSoft: "#F3C08F", highlight: "#FBE3C4" },
      chrome: { showByline: true, showCounter: true, showProgress: true, showCue: true, showCorners: true },
    }, ROOT);
    const a = await renderDeck(deck, { outDir: path.join(dir, "a"), brand: normalizeBrand({}, null), dataDir: dir, chromePath: chrome });
    const b = await renderDeck(deck, { outDir: path.join(dir, "b"), brand: sand, dataDir: dir, chromePath: chrome });
    assert.equal(a.ok, true, a.qa.issues.join("; "));
    assert.equal(b.ok, true, b.qa.issues.join("; "));
    assert.equal(a.files.length, 1);
    assert.equal(b.files.length, 1);
    const pa = fs.readFileSync(a.files[0]), pb = fs.readFileSync(b.files[0]);
    assert.notEqual(Buffer.compare(pa, pb), 0, "the two brands rendered identical PNG bytes");
    // the second brand switched the byline, counter, progress bar and cue on: more text on the slide
    assert.ok(b.slides[0].textElements > a.slides[0].textElements);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
