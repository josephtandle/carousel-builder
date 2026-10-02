"use strict";
/*
 * Brand config: one JSON file turns into the CSS variables every layout reads.
 *
 *   loadBrand(dataDir?)  -> brand object with defaults merged. Reads <dataDir>/brand.json when present,
 *                           else config/brand.example.json, else DEFAULT_BRAND.
 *   brandCss(brand)      -> CSS string: optional @font-face rules plus one :root block of variables.
 *   DEFAULT_BRAND        -> the neutral shipped look (near-black, warm off-white, one teal accent).
 *
 * Byline, logo and portrait are never defaulted: a slide only shows them when the brand (or the slide) sets them.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const EXAMPLE_FILE = path.join(ROOT, "config", "brand.example.json");

const DEFAULT_BRAND = Object.freeze({
  name: "",
  handle: "",
  byline: "",
  colors: Object.freeze({
    bg: "#101314",
    bgDeep: "#161C1D",
    bgAlt: "#1B2B2C",
    text: "#F4EFE6",
    accent: "#2FB5A6",
    accentSoft: "#93DDD3",
    highlight: "#CDEFE9",
  }),
  fonts: Object.freeze({
    display: Object.freeze({ family: "Cormorant Garamond", file: null }),
    body: Object.freeze({ family: "Plus Jakarta Sans", file: null }),
  }),
  logo: null,
  portrait: null,
  chrome: Object.freeze({ showByline: false, showCounter: false, showProgress: false, showCue: false, showCorners: false }),
  voiceProfilePath: null,
  defaultHashtags: Object.freeze([]),
});

const COLOR_KEYS = ["bg", "bgDeep", "bgAlt", "text", "accent", "accentSoft", "highlight"];
const CHROME_KEYS = ["showByline", "showCounter", "showProgress", "showCue", "showCorners"];
const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
const FONT_FORMAT = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };
const FALLBACKS = {
  display: 'Georgia, "Times New Roman", serif',
  body: '"Helvetica Neue", Arial, sans-serif',
};

function dataDirFrom(dataDir) {
  return path.resolve(dataDir || process.env.CAROUSEL_HOME || path.join(process.cwd(), ".carousel"));
}

function isUrl(v) { return /^(https?:\/\/|data:)/i.test(v); }

/* "#abc" or "#aabbcc" -> "#AABBCC"; anything else -> null */
function normalizeHex(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h.toUpperCase();
}
function hexToRgb(hex) {
  const h = normalizeHex(hex) || "#000000";
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function rgbToHex(rgb) {
  return "#" + rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("").toUpperCase();
}
/* t = 0 gives a, t = 1 gives b */
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}

/* Font family names go into a <style> block: keep letters, digits, spaces and a few safe marks only. */
function cleanFamily(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[^A-Za-z0-9 _.\-]/g, "").trim().slice(0, 80);
}

function resolvePath(v, baseDir) {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (isUrl(s)) return s;
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(baseDir || process.cwd(), s);
}

/*
 * Merge a raw brand object over the defaults. Relative paths resolve against baseDir (the folder of the
 * file the brand came from). Problems never throw: they land in brand.warnings and the default is used.
 */
function normalizeBrand(raw, baseDir) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warnings = [];
  const str = (k) => (typeof src[k] === "string" ? src[k].trim() : DEFAULT_BRAND[k]);

  const colors = {};
  const rawColors = src.colors && typeof src.colors === "object" ? src.colors : {};
  for (const k of COLOR_KEYS) {
    if (rawColors[k] === undefined || rawColors[k] === null || rawColors[k] === "") { colors[k] = DEFAULT_BRAND.colors[k]; continue; }
    const hex = normalizeHex(rawColors[k]);
    if (hex) colors[k] = hex;
    else { colors[k] = DEFAULT_BRAND.colors[k]; warnings.push(`colors.${k} is not a hex colour, using the default ${DEFAULT_BRAND.colors[k]}`); }
  }

  const fonts = {};
  const rawFonts = src.fonts && typeof src.fonts === "object" ? src.fonts : {};
  for (const slot of ["display", "body"]) {
    const rf = rawFonts[slot] && typeof rawFonts[slot] === "object" ? rawFonts[slot] : {};
    const family = cleanFamily(rf.family) || DEFAULT_BRAND.fonts[slot].family;
    let file = null;
    if (typeof rf.file === "string" && rf.file.trim()) {
      const abs = resolvePath(rf.file, baseDir);
      if (isUrl(abs)) warnings.push(`fonts.${slot}.file must be a local font file, not a URL`);
      else if (!FONT_EXT.has(path.extname(abs).toLowerCase())) warnings.push(`fonts.${slot}.file must be .woff2, .woff, .ttf or .otf`);
      else if (!fs.existsSync(abs)) warnings.push(`fonts.${slot}.file not found: ${rf.file}`);
      else file = abs;
    }
    fonts[slot] = { family, file };
  }

  const image = (k) => {
    if (typeof src[k] !== "string" || !src[k].trim()) return null;
    const abs = resolvePath(src[k], baseDir);
    if (isUrl(abs)) return abs;
    if (!fs.existsSync(abs)) { warnings.push(`${k} not found: ${src[k]}`); return null; }
    return abs;
  };

  const chrome = {};
  const rawChrome = src.chrome && typeof src.chrome === "object" ? src.chrome : {};
  for (const k of CHROME_KEYS) chrome[k] = rawChrome[k] === undefined ? DEFAULT_BRAND.chrome[k] : rawChrome[k] === true;

  const hashtags = Array.isArray(src.defaultHashtags)
    ? src.defaultHashtags.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim())
    : [];

  return {
    name: str("name"),
    handle: str("handle"),
    byline: str("byline"),
    colors,
    fonts,
    logo: image("logo"),
    portrait: image("portrait"),
    chrome,
    voiceProfilePath: typeof src.voiceProfilePath === "string" && src.voiceProfilePath.trim() ? resolvePath(src.voiceProfilePath, baseDir) : null,
    defaultHashtags: hashtags,
    warnings,
  };
}

/* Read one brand JSON file. Keys starting with "_" are documentation and are ignored. */
function readBrandFile(file) {
  const abs = path.resolve(file);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, "utf8")); }
  catch (e) {
    const brand = normalizeBrand({}, null);
    brand.source = "default";
    brand.warnings.push(`${path.basename(abs)} could not be read (${e.code || e.message}); using the default brand`);
    return brand;
  }
  const brand = normalizeBrand(raw, path.dirname(abs));
  brand.source = abs;
  return brand;
}

function loadBrand(dataDir) {
  const userFile = path.join(dataDirFrom(dataDir), "brand.json");
  if (fs.existsSync(userFile)) return readBrandFile(userFile);
  if (fs.existsSync(EXAMPLE_FILE)) return readBrandFile(EXAMPLE_FILE);
  const brand = normalizeBrand({}, null);
  brand.source = "default";
  return brand;
}

/*
 * brandCss(brand, { assetUrl }) -> CSS for a <style> block placed after tokens.css.
 * assetUrl(absPath) maps a local font file to a URL the page can load (the renderer passes its own
 * local-server mapping); the default is a file:// URL.
 */
function brandCss(brand, opts) {
  const b = brand && brand.colors && brand.fonts ? brand : normalizeBrand(brand || {}, null);
  const assetUrl = (opts && opts.assetUrl) || ((p) => pathToFileURL(p).href);
  const c = {};
  for (const k of COLOR_KEYS) c[k] = normalizeHex(b.colors[k]) || DEFAULT_BRAND.colors[k];
  const rgb = (hex) => hexToRgb(hex).join(", ");

  const faces = [];
  for (const slot of ["display", "body"]) {
    const f = b.fonts[slot];
    if (!f || !f.file) continue;
    const ext = path.extname(f.file).toLowerCase();
    const url = String(assetUrl(f.file)).replace(/["\\\n\r<>]/g, (ch) => encodeURIComponent(ch));
    faces.push(`@font-face{font-family:"${cleanFamily(f.family)}";font-style:normal;font-weight:100 900;font-display:block;src:url("${url}") format("${FONT_FORMAT[ext] || "woff2"}");}`);
  }
  const family = (slot) => `"${cleanFamily(b.fonts[slot].family) || DEFAULT_BRAND.fonts[slot].family}", ${FALLBACKS[slot]}`;

  const accentMid = mix(c.accent, c.accentSoft, 0.3);   // between the accent and its soft tint
  const accentDeep = mix(c.accent, c.bg, 0.3);          // accent that still reads on a text-coloured card
  const vars = [
    ["--bg", c.bg], ["--bg-rgb", rgb(c.bg)],
    ["--bg-deep", c.bgDeep], ["--bg-deep-rgb", rgb(c.bgDeep)],
    ["--bg-alt", c.bgAlt], ["--bg-alt-rgb", rgb(c.bgAlt)],
    ["--text", c.text], ["--text-rgb", rgb(c.text)],
    ["--accent", c.accent], ["--accent-rgb", rgb(c.accent)],
    ["--accent-mid", accentMid], ["--accent-mid-rgb", rgb(accentMid)],
    ["--accent-soft", c.accentSoft], ["--accent-soft-rgb", rgb(c.accentSoft)],
    ["--accent-deep", accentDeep],
    ["--highlight", c.highlight], ["--highlight-rgb", rgb(c.highlight)],
    ["--font-display", family("display")],
    ["--font-body", family("body")],
  ];
  return faces.join("\n") + (faces.length ? "\n" : "") + ":root {\n" + vars.map(([k, v]) => `  ${k}: ${v};`).join("\n") + "\n}\n";
}

module.exports = { loadBrand, brandCss, DEFAULT_BRAND, normalizeBrand, readBrandFile, normalizeHex, hexToRgb, mix, COLOR_KEYS, CHROME_KEYS };
