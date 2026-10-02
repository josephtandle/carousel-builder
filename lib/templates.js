"use strict";
/*
 * The slide templates as a picker sees them, and their preview images.
 *
 *   listTemplates() -> [{ id, name, purpose, group, supportsBackground, sampleSlide }] in display order
 *   renderTemplatePreviews({ dataDir, brand, size = "portrait", force = false }) -> Promise<[{ id, file, cached }]>
 *   previewPath({ dataDir, brand, size, id }) -> the PNG path a preview has (whether or not it exists yet)
 *   previewDir({ dataDir, brand, size }) -> the folder: <dataDir>/template-previews/<brand hash>-<size>/
 *
 * Previews render each template's sampleSlide in the given brand. The folder name carries a hash of the brand
 * and of the kit files, so a changed brand.json (or an updated kit) gets a fresh set and an unchanged one is
 * reused: a second call renders nothing. The whole set is rendered in one pass, one slide at a time, and calls
 * made while a pass is running wait their turn, so two sets never render at once.
 *
 * Templates with a photo slot (the photo cover, the quote, the call to action) use the brand portrait when the
 * brand has one and the bundled placeholder otherwise, so a preview always shows where the photo goes.
 *
 * renderTemplatePreviews rejects with an Error carrying `code` (invalid_size, chrome_not_found, preview_failed)
 * when no preview could be written. A preview whose layout check failed is still written and returned, with
 * ok: false and its issues, so a picker can show it and say why.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { LAYOUTS, TEMPLATE_ORDER, SIZES, DEFAULT_SIZE } = require("./deck-schema.js");
const { loadBrand, normalizeBrand, COLOR_KEYS, CHROME_KEYS } = require("./brand.js");
const { findChrome, pngComplete } = require("./render.js");

const ROOT = path.resolve(__dirname, "..");
const KIT = path.join(ROOT, "kit");
const PLACEHOLDER_PORTRAIT = path.join(ROOT, "assets", "placeholder-portrait.svg");
/* template id -> the image field its preview fills when the brand has no portrait */
const PREVIEW_PHOTO = Object.freeze({ "02-face-claim-cover": "photo", "04-tweet-card": "avatar", "10-cta-comment-keyword": "photo" });

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function listTemplates() {
  return TEMPLATE_ORDER.map((id) => {
    const t = LAYOUTS[id];
    return { id, name: t.name, purpose: t.purpose, group: t.group, supportsBackground: t.supportsBackground, sampleSlide: clone(t.sampleSlide) };
  });
}

function dataDirFrom(dataDir) {
  return path.resolve(dataDir || process.env.CAROUSEL_HOME || path.join(process.cwd(), ".carousel"));
}

function fullBrand(brand, dataDir) {
  if (!brand) return loadBrand(dataDir);
  return brand.colors && brand.fonts && brand.chrome ? brand : normalizeBrand(brand, null);
}

/* A hash of every kit file: a preview made by an older kit must not be reused. */
let kitHashCache = null;
function kitHash() {
  if (kitHashCache) return kitHashCache;
  const h = crypto.createHash("sha256");
  const files = ["tokens.css", "fonts.css", "kit.js"].map((f) => path.join(KIT, f))
    .concat(fs.readdirSync(path.join(KIT, "layouts")).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(KIT, "layouts", f)));
  for (const file of files) { h.update(path.basename(file)); h.update(fs.readFileSync(file)); }
  h.update(JSON.stringify(TEMPLATE_ORDER.map((id) => LAYOUTS[id].sampleSlide)));
  kitHashCache = h.digest("hex");
  return kitHashCache;
}

function fileStamp(file) {
  if (typeof file !== "string" || !file || /^(https?:|data:)/i.test(file)) return file || "";
  try { const s = fs.statSync(file); return `${file}:${s.size}:${Math.round(s.mtimeMs)}`; } catch (e) { return `${file}:missing`; }
}

/* Twelve hex characters that change whenever anything a preview shows changes. */
function brandHash(brand) {
  const b = fullBrand(brand);
  const look = {
    name: b.name || "", byline: b.byline || "",
    colors: COLOR_KEYS.map((k) => b.colors[k]),
    fonts: ["display", "body"].map((slot) => [b.fonts[slot].family, fileStamp(b.fonts[slot].file)]),
    logo: fileStamp(b.logo), portrait: fileStamp(b.portrait),
    chrome: CHROME_KEYS.map((k) => !!b.chrome[k]),
    kit: kitHash(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(look)).digest("hex").slice(0, 12);
}

function checkSize(size) {
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) {
    throw Object.assign(new Error(`unknown size "${size}": use ${Object.keys(SIZES).join(", ")}`), { code: "invalid_size" });
  }
}

function previewDir({ dataDir, brand, size = DEFAULT_SIZE } = {}) {
  checkSize(size);
  const home = dataDirFrom(dataDir);
  return path.join(home, "template-previews", `${brandHash(fullBrand(brand, home))}-${size}`);
}

function previewPath({ dataDir, brand, size = DEFAULT_SIZE, id } = {}) {
  if (!Object.prototype.hasOwnProperty.call(LAYOUTS, id)) throw Object.assign(new Error(`unknown template "${id}"`), { code: "unknown_template" });
  return path.join(previewDir({ dataDir, brand, size }), `${id}.png`);
}

/* The fields a preview renders: the sample slide, plus a placeholder photo where the brand has none. */
function previewFields(id, brand) {
  const fields = clone(LAYOUTS[id].sampleSlide);
  delete fields.layout;
  const photoField = PREVIEW_PHOTO[id];
  if (photoField && !brand.portrait) fields[photoField] = PLACEHOLDER_PORTRAIT;
  return fields;
}

let queue = Promise.resolve();   // one render pass at a time, in call order

function renderTemplatePreviews(opts) {
  const run = queue.then(() => renderNow(opts || {}));
  queue = run.catch(() => {});
  return run;
}

async function renderNow({ dataDir, brand, size = DEFAULT_SIZE, force = false, chromePath } = {}) {
  checkSize(size);
  const home = dataDirFrom(dataDir);
  const b = fullBrand(brand, home);
  const dir = previewDir({ dataDir: home, brand: b, size });
  const fileOf = (id) => path.join(dir, `${id}.png`);
  const manifest = path.join(dir, "previews.json");

  if (!force && TEMPLATE_ORDER.every((id) => pngComplete(fileOf(id)))) {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(manifest, "utf8")).templates || {}; } catch (e) { /* PNGs without a manifest still count */ }
    return TEMPLATE_ORDER.map((id) => Object.assign({ id, file: fileOf(id), cached: true, ok: saved[id] ? saved[id].ok !== false : true },
      saved[id] && saved[id].ok === false ? { issues: saved[id].issues || [] } : {}));
  }

  const chrome = chromePath || findChrome();
  let runnable = false;
  try { fs.accessSync(chrome, fs.constants.X_OK); runnable = fs.statSync(chrome).isFile(); } catch (e) { /* not there */ }
  if (!chrome || !runnable) throw Object.assign(new Error("No Chrome, Chromium or Edge found. Install one, or set CHROME_BIN to its binary."), { code: "chrome_not_found" });

  // render into a scratch folder beside the target, then move the finished PNGs in: a half-made set is never taken for a cached one
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const scratch = fs.mkdtempSync(dir + ".part-");
  try {
    const { renderJobs } = await import(pathToFileURL(path.join(ROOT, "render.mjs")).href);
    const jobs = TEMPLATE_ORDER.map((id, i) => ({
      name: id, layout: id, fields: previewFields(id, b), slide: i + 1, total: TEMPLATE_ORDER.length, baseDir: ROOT, out: path.join(scratch, `${id}.png`),
    }));
    const result = await renderJobs(jobs, { brand: b, size, chromePath: chrome, dataDir: home, concurrency: 1 });
    const missing = TEMPLATE_ORDER.filter((id) => !pngComplete(path.join(scratch, `${id}.png`)));
    if (missing.length) {
      throw Object.assign(new Error(`template previews could not be rendered: ${missing.join(", ")}. ${result.qa.issues.slice(0, 3).join("; ")}`), { code: "preview_failed", issues: result.qa.issues });
    }
    fs.mkdirSync(dir, { recursive: true });
    const templates = {};
    const out = TEMPLATE_ORDER.map((id, i) => {
      fs.renameSync(path.join(scratch, `${id}.png`), fileOf(id));
      const slide = result.slides[i] || { ok: false, issues: ["no result"] };
      templates[id] = slide.ok ? { ok: true } : { ok: false, issues: slide.issues };
      return Object.assign({ id, file: fileOf(id), cached: false, ok: slide.ok }, slide.ok ? {} : { issues: slide.issues });
    });
    fs.writeFileSync(manifest, JSON.stringify({ size, brandHash: path.basename(dir).split("-")[0], renderedAt: new Date().toISOString(), templates }, null, 2));
    return out;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { listTemplates, renderTemplatePreviews, previewPath, previewDir, brandHash };
