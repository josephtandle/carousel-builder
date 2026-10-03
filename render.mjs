#!/usr/bin/env node
/*
 * Carousel renderer + overflow gate.
 *
 *   node render.mjs --deck deck.json --out-dir ./out          render a whole carousel
 *   node render.mjs --all                                     render every template with its sample content
 *   node render.mjs --template 04-tweet-card --content my.json --out slide.png
 *
 * Options:
 *   --size portrait|square|story   1080x1350 (default), 1080x1080, 1080x1920. A deck's own "size" is the default.
 *   --brand <brand.json>           brand config; default is <data dir>/brand.json, then config/brand.example.json
 *   --out-dir <dir>                where PNGs go (default for --all: <data dir>/exports/previews)
 *   --base-dir <dir>               folder that relative image paths resolve against (default: the deck's folder)
 *   --data-dir <dir>               data dir (default: CAROUSEL_HOME or ./.carousel)
 *   --result <file>                also write the run result as JSON
 *
 * Every render runs the in-page QA (kit/kit.js): text inside canvas and safe area, no scroll overflow,
 * no clipping, no overlapping text, no em dashes or emoji, fonts and images loaded.
 * Every PNG is then checked for a capture defect: the browser viewport must be the full slide, and a flat
 * single-colour block in a corner that a second capture does not confirm (an unpainted region) fails the slide.
 * Any issue prints loudly and the process exits 1. Exit 2 is a usage error, exit 3 means no browser was found.
 *
 * Local images: a slide may only use image files inside the deck's folder, the kit, the bundled assets,
 * the data dir library, or the files named by the brand config. Anything else fails the slide.
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadBrand, readBrandFile, brandCss } = require("./lib/brand.js");
const { validateDeck, upgradeDeck, resolveLayoutId, LAYOUTS, SIZES, DEFAULT_SIZE } = require("./lib/deck-schema.js");
const { findChrome, launchBrowser, chromeScreenshot, pngSize } = require("./lib/render.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(HERE, "kit");
const ASSETS = path.join(HERE, "assets");
const LAYOUT_DIR = path.join(KIT, "layouts");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"]);
const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };

function args(argv) {
  const a = argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2), v = a[i + 1] !== undefined && !a[i + 1].startsWith("--") ? a[++i] : true;
    o[k] = v;
  }
  return o;
}

function real(p) { try { return fs.realpathSync(p); } catch (e) { return null; } }
function inside(file, dir) { return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep); }

/* ---------- allowlist: the only local files the render pages can load ---------- */
function makeAllowlist() {
  const dirs = new Set(), files = new Set();
  const home = real(os.homedir()), fsRoot = path.parse(HERE).root;
  return {
    // A whole folder (and what is under it). The filesystem root and the home folder itself are never opened up.
    addDir(dir) {
      const r = dir && real(dir);
      if (!r || r === fsRoot || r === home) return false;
      dirs.add(r); return true;
    },
    addFile(file) { const r = file && real(file); if (r) files.add(r); },
    allows(file) {
      const r = real(file);
      if (!r) return false;
      if (files.has(r)) return true;
      for (const d of dirs) if (inside(r, d)) return true;
      return false;
    },
  };
}

/* ---------- local server: kit files, registered files, render pages, QA posts ---------- */
function createServer() {
  const pages = new Map(), qaWaiters = new Map(), registered = new Map(), byPath = new Map();
  const secret = crypto.randomBytes(8).toString("hex");
  const kitReal = real(KIT), assetsReal = real(ASSETS);
  let server, port;

  const send = (res, file) => fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });

  const handler = (req, res) => {
    let u, p;
    try { u = new URL(req.url, "http://x"); p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
    if (req.method === "POST" && p.startsWith("/__qa/")) {
      let body = ""; req.on("data", (d) => { if (body.length < 1e6) body += d; });
      req.on("end", () => { const w = qaWaiters.get(p.slice(6)); if (w) w(body); res.writeHead(204, { "Access-Control-Allow-Origin": "*" }); res.end(); });
      return;
    }
    if (req.method !== "GET") { res.writeHead(405); return res.end(); }
    if (pages.has(p)) { res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" }); return res.end(pages.get(p)); }
    // files registered by the renderer after the allowlist check: /__file/<secret>/<n>/<name>
    if (p.startsWith("/__file/")) {
      const file = registered.get(p);
      if (!file) { res.writeHead(404); return res.end(); }
      return send(res, file);
    }
    // static: only the kit and the bundled assets, never a path that resolves outside them
    if (p.startsWith("/kit/") || p.startsWith("/assets/")) {
      const file = real(path.join(HERE, p));
      const base = p.startsWith("/kit/") ? kitReal : assetsReal;
      if (!file || !base || !inside(file, base) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
      return send(res, file);
    }
    res.writeHead(404); res.end();
  };

  return {
    pages, qaWaiters,
    async start() {
      if (server) return;
      server = http.createServer(handler);
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      port = server.address().port;
    },
    origin() { return `http://127.0.0.1:${port}`; },
    // register one already-allowed local file and return the URL path the page should use
    register(file) {
      const r = real(file);
      if (byPath.has(r)) return byPath.get(r);
      const url = `/__file/${secret}/${registered.size + 1}/${encodeURIComponent(path.basename(r))}`;
      registered.set(decodeURIComponent(url), r); byPath.set(r, url);
      return url;
    },
    close() { if (server) server.close(); server = null; },
  };
}

/* ---------- content assembly ---------- */
function isRemote(v) { return /^(https?:\/\/|data:image\/)/i.test(v); }

/* Turn an image value from a deck or brand into something the page can load, or record why it cannot. */
function resolveImage(value, baseDir, ctx, issues, what) {
  if (typeof value !== "string" || !value.trim()) return value;
  const v = value.trim();
  if (isRemote(v)) return v;
  let abs;
  try { abs = v.startsWith("file://") ? fileURLToPath(v) : path.isAbsolute(v) ? v : path.resolve(baseDir, v); }
  catch (e) { issues.push(`${what}: not a usable path: ${v}`); return ""; }
  if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) { issues.push(`${what}: not an image file (png, jpg, webp, gif, avif, svg): ${v}`); return ""; }
  if (!fs.existsSync(abs)) { issues.push(`${what}: image not found: ${v}`); return ""; }
  if (!ctx.allow.allows(abs)) { issues.push(`${what}: image is outside the allowed folders (the deck's folder, the kit, the bundled assets, the data dir library): ${v}`); return ""; }
  return ctx.server.register(abs);
}

function chromeDefaults(brand) {
  const c = brand.chrome || {};
  return { show_byline: !!c.showByline, show_counter: !!c.showCounter, show_progress: !!c.showProgress, show_cue: !!c.showCue, show_corners: !!c.showCorners };
}

/*
 * One slide's content: brand chrome and byline first, then deck defaults, then the slide's own fields.
 * Portrait, name, byline and logo fall back to the brand; a slide can switch any of them off with "".
 */
function buildContent(layoutId, fields, meta, ctx, baseDir) {
  const { brand } = ctx, issues = [];
  const c = Object.assign({}, chromeDefaults(brand), fields, meta, { size: ctx.size });
  const own = (k) => Object.prototype.hasOwnProperty.call(fields, k);

  if (!own("byline") && brand.byline) c.byline = brand.byline;
  const brandImage = (k) => (brand[k] ? resolveImage(brand[k], HERE, ctx, issues, `brand ${k}`) : "");
  c.logo = own("logo") ? resolveImage(fields.logo, baseDir, ctx, issues, "logo") : brandImage("logo");
  if (layoutId === "02-face-claim-cover" || layoutId === "10-cta-comment-keyword") {
    // on the photo cover a slide's own background image comes before the brand portrait (kit.js makes it the photo)
    const ownBackground = layoutId === "02-face-claim-cover" && c.background && typeof c.background === "object" && c.background.src;
    c.photo = own("photo") ? resolveImage(fields.photo, baseDir, ctx, issues, "photo") : ownBackground ? "" : brandImage("portrait");
  }
  if (layoutId === "04-tweet-card") {
    c.avatar = own("avatar") ? resolveImage(fields.avatar, baseDir, ctx, issues, "avatar") : brandImage("portrait");
    if (!own("name") && brand.name) c.name = brand.name;
  }
  if (c.background && typeof c.background === "object") {
    c.background = Object.assign({}, c.background, { src: resolveImage(c.background.src, baseDir, ctx, issues, "background") });
  }
  return { content: c, issues };
}

function sampleContent(html) {
  const m = html.match(/<script type="application\/json" id="content">([\s\S]*?)<\/script>/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (e) { return {}; }
}

/* ---------- one slide ---------- */
let seq = 0;
async function renderSlide(job, ctx) {
  const { server, size } = ctx, dims = SIZES[size];
  const tpl = path.join(LAYOUT_DIR, job.layout + ".html");
  let html = fs.readFileSync(tpl, "utf8");
  // no fields given: render the layout's own sample content
  const sample = job.fields ? null : sampleContent(html);
  const fields = Object.assign({}, job.fields || sample);
  const meta = { slide: (sample ? sample.slide : job.slide) || 1, total: (sample ? sample.total : job.total) || 1 };
  delete fields.slide; delete fields.total;
  const { content, issues } = buildContent(job.layout, fields, meta, ctx, job.baseDir);
  const failed = (list) => ({ ok: false, issues: list, textElements: 0, fitScales: {} });
  if (issues.length) return failed(issues);

  const json = JSON.stringify(content, null, 2).replace(/<\//g, "<\\/");
  const re = /(<script type="application\/json" id="content">)[\s\S]*?(<\/script>)/;
  if (!re.test(html)) return failed([`${job.layout}: no <script type="application/json" id="content"> block`]);
  html = html.replace(re, (_, a, b) => `${a}\n${json}\n${b}`);
  const id = `${process.pid}-${++seq}`;
  html = html.replace(/<html([^>]*)>/i, (_, attrs) => `<html${attrs} data-size="${size}">`);
  html = html.replace(/<head>/i, () => `<head><meta name="qa-endpoint" content="/__qa/${id}">`);
  html = html.replace(/<\/head>/i, () => `<style id="brand">\n${ctx.brandCss}</style>\n</head>`);

  // the page lives beside the layouts so their relative links (../tokens.css, ../kit.js) resolve
  const urlPath = `/kit/layouts/__render-${id}.html`;
  server.pages.set(urlPath, html);
  const qaPromise = new Promise((resolve) => { server.qaWaiters.set(id, resolve); });
  const outAbs = path.resolve(job.out);
  try {
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
    let shot;
    try {
      shot = await chromeScreenshot({ browser: ctx.browser, url: server.origin() + urlPath, out: outAbs, width: dims.w, height: dims.h, settle: qaPromise });
    } catch (e) {
      return failed([e.message]);
    }
    let wait;
    const body = await Promise.race([qaPromise, new Promise((r) => { wait = setTimeout(() => r(null), 3000); })]);
    clearTimeout(wait);
    let qa;
    try { qa = body ? JSON.parse(body) : null; } catch (e) { qa = null; }
    if (!qa) qa = failed(["QA result never arrived: kit.js did not finish in time"]);
    if (!Array.isArray(qa.issues)) qa.issues = [];
    // capture sanity check: a corner the browser never painted fails the slide, the same way overflow does
    if (shot.cornerCheck && !shot.cornerCheck.ok) { qa.issues.push(...shot.cornerCheck.issues); qa.ok = false; }
    qa.captures = shot.captures;
    if (!fs.existsSync(outAbs)) { qa.issues.push("screenshot not written"); qa.ok = false; }
    else {
      const s = pngSize(outAbs);
      if (s.w !== dims.w || s.h !== dims.h) { qa.issues.push(`PNG is ${s.w}x${s.h}, expected ${dims.w}x${dims.h}`); qa.ok = false; }
    }
    return qa;
  } finally {
    server.pages.delete(urlPath); server.qaWaiters.delete(id);
  }
}

/* run jobs a few at a time, results in job order */
async function pool(jobs, limit, fn) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; results[i] = await fn(jobs[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return results;
}

/*
 * Render a list of jobs: [{ name, layout, fields (null = the layout's sample), slide, total, baseDir, out }].
 * Returns { ok, size, files, slides: [{ index, name, layout, file, ok, issues, fitScales, textElements, captures, ms }], qa: { ok, issues } }.
 * captures is how many screenshots the slide took: 1 normally, more when a corner looked unpainted and was captured again.
 *
 * One browser process serves the whole batch: every slide is a tab in it, closed after its capture, and the
 * process is closed once at the end. `concurrency` (default CAROUSEL_RENDER_CONCURRENCY, then 2) is how many tabs
 * render at once, never how many browsers. If the browser dies mid-batch the slides still open fail with that
 * error, the slides still to come fail the same way at once, and the batch returns; nothing waits on a dead process.
 */
export async function renderJobs(jobs, { brand, size = DEFAULT_SIZE, chromePath, allowDirs = [], dataDir, concurrency } = {}) {
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) throw Object.assign(new Error(`unknown size "${size}": use ${Object.keys(SIZES).join(", ")}`), { code: "invalid_size" });
  const chrome = chromePath || findChrome();
  if (!chrome) throw Object.assign(new Error("No Chrome, Chromium or Edge found. Install one, or set CHROME_BIN to its binary."), { code: "chrome_not_found" });
  const b = brand || loadBrand(dataDir);
  const dims = SIZES[size];

  const allow = makeAllowlist();
  allow.addDir(KIT); allow.addDir(ASSETS);
  if (dataDir) allow.addDir(path.join(dataDir, "library"));
  for (const d of allowDirs) allow.addDir(d);
  for (const f of [b.logo, b.portrait, b.fonts && b.fonts.display && b.fonts.display.file, b.fonts && b.fonts.body && b.fonts.body.file]) {
    if (typeof f === "string" && !/^(https?:|data:)/i.test(f)) allow.addFile(f);
  }

  const server = createServer();
  await server.start();
  let browser = null;
  try {
    const css = brandCss(b, { assetUrl: (file) => (FONT_EXT.has(path.extname(file).toLowerCase()) && allow.allows(file) ? server.register(file) : "") });
    // one process for the batch (launchBrowser rejects with code chrome_not_found when the binary cannot run)
    browser = await launchBrowser({ chromePath: chrome, width: dims.w, height: dims.h });
    const ctx = { brand: b, brandCss: css, size, chromePath: chrome, browser, allow, server };
    const limit = Number(concurrency || process.env.CAROUSEL_RENDER_CONCURRENCY) || 2;
    const slides = await pool(jobs, limit, async (job, index) => {
      const t0 = Date.now();
      let qa;
      if (!browser.alive) {
        // the shared browser is gone: say so for this slide instead of opening a tab that cannot exist
        let why = "the browser is gone"; await browser.exited.then((e) => { why = e.message; });
        qa = { ok: false, issues: [why], textElements: 0, fitScales: {} };
      } else {
        try { qa = await renderSlide(job, ctx); }
        catch (e) { qa = { ok: false, issues: [String(e && e.message || e)], textElements: 0, fitScales: {} }; }
      }
      return { index: index + 1, name: job.name, layout: job.layout, file: path.resolve(job.out), ok: qa.ok === true, issues: qa.issues || [], fitScales: qa.fitScales || {}, textElements: qa.textElements || 0, captures: qa.captures || 0, ms: Date.now() - t0 };
    });
    const issues = [];
    for (const s of slides) for (const i of s.issues) issues.push(`${s.name}: ${i}`);
    const ok = slides.every((s) => s.ok);
    return { ok, size, files: slides.filter((s) => fs.existsSync(s.file)).map((s) => s.file), slides, qa: { ok, issues } };
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

function report(s) {
  if (s.ok) console.log(`PASS  ${s.name}  -> ${s.file}  (${s.textElements} text elements, fit ${JSON.stringify(s.fitScales)}, ${s.ms} ms)`);
  else {
    console.error(`\nFAIL  ${s.name}  -> ${s.file}`);
    s.issues.forEach((i) => console.error(`   x ${i}`));
  }
}

function writeResult(file, result) {
  if (!file || file === true) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), JSON.stringify(result, null, 2));
}

const USAGE = "usage: node render.mjs --deck deck.json [--out-dir dir] | --all [--out-dir dir] | --template <layout> [--content c.json] [--out x.png]\n" +
  "       options: --size portrait|square|story  --brand brand.json  --base-dir dir  --data-dir dir  --result file.json";

async function main() {
  const o = args(process.argv);
  const dataDir = path.resolve(typeof o["data-dir"] === "string" ? o["data-dir"] : process.env.CAROUSEL_HOME || path.join(process.cwd(), ".carousel"));
  const brand = typeof o.brand === "string" ? readBrandFile(o.brand) : loadBrand(dataDir);
  (brand.warnings || []).forEach((w) => console.error(`brand: ${w}`));
  const stop = (code, result, message) => { if (message) console.error(message); writeResult(o.result, result); process.exit(code); };
  const empty = (error, issues) => ({ ok: false, error, files: [], slides: [], qa: { ok: false, issues } });

  let size = typeof o.size === "string" ? o.size : null;
  const jobs = [], allowDirs = [];

  if (o.all) {
    const outDir = path.resolve(typeof o["out-dir"] === "string" ? o["out-dir"] : path.join(dataDir, "exports", "previews"));
    for (const id of Object.keys(LAYOUTS)) jobs.push({ name: id, layout: id, fields: null, baseDir: LAYOUT_DIR, out: path.join(outDir, id + ".png") });
  } else if (typeof o.deck === "string") {
    let deck;
    try { deck = JSON.parse(fs.readFileSync(o.deck, "utf8")); }
    catch (e) { stop(2, empty("invalid_deck", [`could not read the deck: ${e.message}`]), `could not read the deck ${o.deck}: ${e.message}`); }
    const check = validateDeck(deck);
    check.warnings.forEach((w) => console.error(`warning: ${w}`));
    if (!check.ok) {
      check.errors.forEach((e) => console.error(`error: ${e}`));
      stop(1, empty("invalid_deck", check.errors), `\nThe deck has ${check.errors.length} error(s). Nothing was rendered.`);
    }
    // slides on a retired layout id render with the template that replaced them (the warning is printed above)
    deck = upgradeDeck(deck).deck;
    size = size || deck.size || null;
    const baseDir = path.resolve(typeof o["base-dir"] === "string" ? o["base-dir"] : path.dirname(o.deck));
    allowDirs.push(baseDir);
    const outDir = path.resolve(typeof o["out-dir"] === "string" ? o["out-dir"] : path.dirname(o.deck));
    deck.slides.forEach((s, i) => {
      const fields = Object.assign({}, deck.defaults || {}, s);
      delete fields.layout;
      jobs.push({ name: `slide-${i + 1} (${s.layout})`, layout: s.layout, fields, slide: i + 1, total: deck.slides.length, baseDir, out: path.join(outDir, `slide-${String(i + 1).padStart(2, "0")}.png`) });
    });
  } else if (typeof o.template === "string") {
    const asked = path.basename(o.template).replace(/\.html$/, "");
    const found = resolveLayoutId(asked);
    const id = found ? found.id : asked;
    if (found && found.aliasOf) console.error(`warning: layout "${asked}" was retired, using "${id}" (${LAYOUTS[id].name})`);
    if (!Object.prototype.hasOwnProperty.call(LAYOUTS, id)) stop(2, empty("unknown_layout", [`unknown layout "${id}"`]), `unknown layout "${id}". Layouts: ${Object.keys(LAYOUTS).join(", ")}`);
    let fields = null, baseDir = LAYOUT_DIR;
    if (typeof o.content === "string") {
      try { fields = JSON.parse(fs.readFileSync(o.content, "utf8")); }
      catch (e) { stop(2, empty("invalid_content", [e.message]), `could not read ${o.content}: ${e.message}`); }
      baseDir = path.resolve(typeof o["base-dir"] === "string" ? o["base-dir"] : path.dirname(o.content));
      allowDirs.push(baseDir);
    }
    jobs.push({ name: id, layout: id, fields, slide: fields ? fields.slide : undefined, total: fields ? fields.total : undefined, baseDir, out: typeof o.out === "string" ? o.out : "slide.png" });
  } else {
    console.error(USAGE);
    process.exit(2);
  }

  size = size || DEFAULT_SIZE;
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) stop(2, empty("invalid_size", [`unknown size "${size}"`]), `unknown size "${size}". Use ${Object.keys(SIZES).join(", ")}.`);
  const chromePath = findChrome();
  if (!chromePath) {
    stop(3, empty("chrome_not_found", ["No Chrome, Chromium or Edge found. Install one, or set CHROME_BIN to its binary."]),
      "No Chrome, Chromium or Edge found.\nInstall Google Chrome, Chromium or Microsoft Edge, or set CHROME_BIN to the browser binary, then run this again.");
  }

  const started = Date.now();
  const result = await renderJobs(jobs, { brand, size, chromePath, allowDirs, dataDir });
  result.slides.forEach(report);
  const failed = result.slides.filter((s) => !s.ok).length;
  result.ms = Date.now() - started;
  if (failed) result.error = "qa_failed";
  writeResult(o.result, result);
  console.log(`\n${jobs.length - failed}/${jobs.length} passed the overflow gate (${size} ${SIZES[size].w}x${SIZES[size].h}, ${result.ms} ms).`);
  if (failed) {
    console.error(`OVERFLOW GATE FAILED on ${failed} slide(s). Do not post these.`);
    process.exit(1);
  }
}

// run as a script (compare real paths: the entry path may come through a symlink)
function isMain() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch (e) { return false; }
}
if (isMain()) {
  main().catch((e) => {
    console.error(e && e.code ? `${e.code}: ${e.message}` : e);
    process.exit(e && e.code === "chrome_not_found" ? 3 : 1);
  });
}
