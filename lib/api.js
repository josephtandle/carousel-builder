"use strict";

// The application API of the carousel engine, as plain functions.
//
//   createApi({ dataDir, env, fetchImpl, apiBase }) -> { handle(name, method, { query, body, files }) }
//   handle(...) -> Promise<{ status, headers?, json? | buffer? }>
//
// There is no HTTP in this file. The built-in browser UI (lib/ui-server.js) maps
// /api/<name> to handle(), and a host application can map its own routes to the
// same function, so there is one implementation of every rule.
//
//   name        methods     what it does
//   draft       POST        brief or source text -> a drafted deck
//   render      POST        deck -> PNG slides plus the layout check, stored as the export of that id
//   serve       GET         one rendered slide, or one library image
//   images      POST        search backgrounds, generate one, or add an upload to the library
//   caption     POST        deck -> caption and hashtags
//   brand       GET, PUT    read or change brand.json
//   drafts      GET, POST   list, open or save drafts
//   doctor      GET         what is ready (names only, never a key)
//   publish     POST        dry run first, then confirm "PUBLISH" plus that dry run's token
//   export      GET         history, the PNG list of one export, its PDF, or its Meta ads handoff file
//   schema      GET         the layout schema
//   templates   GET, POST   the template list, one preview image, or (POST) build the previews
//
// Rendering, the PDF build and publishing of one carousel run strictly one after
// another, so a PDF or a publish never sees a half replaced set of slides.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SUBDIRS = ["drafts", "exports", "library", "logs"];
const NO_STORE = { "Cache-Control": "no-store" };
const RASTER_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_UPLOAD = 15 * 1024 * 1024;
const DOCTOR_TTL = 30 * 1000;
const RENDER_STATUS = { invalid_deck: 422, invalid_size: 422, chrome_not_found: 503 };
const CODE_STATUS = { INVALID_ID: 400, PATH_ESCAPE: 400, ENOENT: 404 };
const TEXT_LIMITS = { name: 80, handle: 80, byline: 200 };
const GROUPS = [
  { id: "open", label: "Open", hint: "The first slide: stop the scroll." },
  { id: "point", label: "Make a point", hint: "One idea per slide." },
  { id: "proof", label: "Prove it", hint: "Numbers, contrasts and frameworks." },
  { id: "close", label: "Close", hint: "Recap, then one clear action." },
];
// Where each shipped layout sits when the schema does not say.
const GROUP_GUESS = { "01": "open", "02": "open", "03": "proof", "04": "proof", "06": "point", "07": "point", "08": "proof", "09": "point", "10": "close", "11": "close" };

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, max = 100000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function ok(body = {}, status = 200) {
  return { status, headers: { ...NO_STORE }, json: { ok: true, ...body } };
}

function reply(status, json) {
  return { status, headers: { ...NO_STORE }, json };
}

const UNEXPECTED = "The engine hit an unexpected problem. The terminal that runs it has the details.";
const CODE_MESSAGE = { INVALID_ID: "That is not a valid carousel id.", PATH_ESCAPE: "That path is outside the carousel data folder.", ENOENT: "That file was not found." };

// Turns any thrown value into { ok: false, error } with a real status code. Only messages
// written for the person (HttpError) go out: anything unexpected may name local paths, so it
// is reported to `onError` and the reply carries a plain sentence.
function fail(error, name, onError) {
  if (error instanceof HttpError) {
    return { status: error.status, headers: { ...NO_STORE, ...(error.headers || {}) }, json: { ok: false, error: error.message || "Something went wrong.", ...error.extra } };
  }
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  if (CODE_STATUS[code]) return { status: CODE_STATUS[code], headers: { ...NO_STORE }, json: { ok: false, error: CODE_MESSAGE[code] } };
  if (typeof onError === "function") {
    try {
      onError(error, name);
    } catch {
      // Reporting is best effort.
    }
  }
  return { status: 500, headers: { ...NO_STORE }, json: { ok: false, error: UNEXPECTED } };
}

/** A post link is passed on only when it is a plain https address. */
function httpsUrl(value) {
  return typeof value === "string" && /^https:\/\/[^\s]+$/i.test(value) ? value : null;
}

// Engine modules are loaded on first use, so one missing or broken module turns
// into a clear 503 for the calls that need it and never stops the rest.
function engine(relative) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) throw new HttpError(503, `The carousel engine is incomplete: ${relative} is missing.`);
  try {
    return require(file);
  } catch (error) {
    throw new HttpError(503, `The carousel engine could not load ${relative}: ${String((error && error.message) || error).split("\n")[0]}`);
  }
}

// ---- one job at a time per carousel ----
//
// The queue lives on globalThis so that every copy of this module in one
// process (a host application may bundle each route on its own) shares it.
const QUEUE_KEY = "__carouselBuilderQueues";
function queues() {
  if (!globalThis[QUEUE_KEY]) globalThis[QUEUE_KEY] = new Map();
  return globalThis[QUEUE_KEY];
}
function inOrder(key, job) {
  const all = queues();
  const run = (all.get(key) || Promise.resolve()).then(job, job);
  const settled = run.then(() => undefined, () => undefined);
  all.set(key, settled);
  settled.then(() => {
    if (all.get(key) === settled) all.delete(key);
  });
  return run;
}

function requireBody(body) {
  if (body === undefined || body === null) throw new HttpError(400, "The request body must be JSON.");
  if (!isObject(body)) throw new HttpError(400, "The request body must be a JSON object.");
  return body;
}

function requireDeck(value) {
  if (!isObject(value)) throw new HttpError(400, "Send the deck as an object with a slides list.");
  return value;
}

function sniff(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  const ascii = (from, to) => Buffer.from(bytes.subarray(from, to)).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  return null;
}

function createApi(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : undefined);
  const apiBase = String(options.apiBase === undefined ? "/api" : options.apiBase).replace(/\/+$/, "");
  const store = () => engine("lib/store.js");
  const baseDir = options.dataDir ? path.resolve(String(options.dataDir)) : env.CAROUSEL_HOME ? path.resolve(String(env.CAROUSEL_HOME)) : store().resolveDataDir();

  // The data folder (brand.json, drafts, exports, library, logs). Created on first use.
  function dataDir() {
    for (const sub of SUBDIRS) fs.mkdirSync(path.join(baseDir, sub), { recursive: true });
    return baseDir;
  }
  const queueKey = (key) => `${baseDir}\n${key}`;
  // Anything that starts a browser also waits its turn in one shared line, so
  // two renders never run side by side on the same machine.
  const withBrowser = (job) => inOrder("\n@browser", job);

  const renderer = () => engine("lib/render.js");
  const brandKit = () => engine("lib/brand.js");
  const deckSchema = () => engine("lib/deck-schema.js");
  const llm = () => engine("lib/llm.js");
  const copy = () => engine("lib/copy.js");
  const images = () => engine("lib/images/index.js");
  const pdf = () => engine("lib/pdf.js");
  const recipe = (name) => engine(`recipes/${name}.js`);
  const llmClient = () => llm().getLlm({ env, fetchImpl });

  // lib/templates.js is optional: without it the list comes from the schema and
  // there are no preview images.
  function templatesModule() {
    if (options.templates === null) return null;
    if (isObject(options.templates)) return options.templates;
    const file = path.join(ROOT, "lib", "templates.js");
    if (!fs.existsSync(file)) return null;
    try {
      return require(file);
    } catch {
      return null;
    }
  }

  // URL the page can load a library image from, or null when the file is not a library image.
  function libraryUrl(file, dir) {
    const library = path.join(dir, "library");
    const absolute = path.resolve(dir, file);
    if (path.dirname(absolute) !== library) return null;
    const name = path.basename(absolute);
    if (!LIBRARY_NAME.test(name) || !RASTER_TYPES[path.extname(name).toLowerCase()]) return null;
    return { name, url: `${apiBase}/serve?lib=${encodeURIComponent(name)}`, src: `library/${name}` };
  }

  // Reads one image for the page. The file must really sit inside the data dir.
  function imageReply(file, dir, { cache, downloadName } = {}) {
    const type = RASTER_TYPES[path.extname(file).toLowerCase()];
    if (!type) throw new HttpError(415, "Only PNG, JPEG and WebP images are served.");
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      throw new HttpError(404, "Image not found.");
    }
    const root = fs.realpathSync(dir);
    if (!real.startsWith(root + path.sep)) throw new HttpError(403, "That file is outside the carousel data folder.");
    if (!RASTER_TYPES[path.extname(real).toLowerCase()]) throw new HttpError(415, "Only PNG, JPEG and WebP images are served.");
    let bytes;
    try {
      if (!fs.statSync(real).isFile()) throw new Error("not a file");
      bytes = fs.readFileSync(real);
    } catch {
      throw new HttpError(404, "Image not found.");
    }
    const headers = {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cache ? "private, max-age=3600" : "no-store",
    };
    if (downloadName) headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
    return { status: 200, headers, buffer: bytes };
  }

  // ---- draft ----

  // POST { brief, slides, size, sourceText } -> a deck drafted by the engine.
  // With no model key the keyless fallback still returns a valid deck; the reply
  // says which one wrote it.
  async function draft({ body }) {
    const input = requireBody(body);
    const brief = text(input.brief, 4000);
    const sourceText = text(input.sourceText, 40000);
    if (!brief.trim() && !sourceText.trim()) throw new HttpError(400, "Say what the carousel is about, or paste a post or article to turn into one.");
    const dir = dataDir();
    const client = llmClient();
    const deck = await copy().draftDeck(
      { brief, sourceText, slides: typeof input.slides === "number" ? input.slides : undefined, size: typeof input.size === "string" ? input.size : undefined },
      { llm: client, brand: brandKit().loadBrand(dir) }
    );
    const meta = deck.draftMeta || {};
    return ok({
      deck,
      engine: meta.engine || (client ? `llm:${client.name || "custom"}` : "fallback"),
      model: client ? client.name || "custom" : null,
      placeholders: meta.placeholders || 0,
      notes: meta.notes || [],
    });
  }

  // POST { deck } -> { caption, hashtags } drafted from the slides.
  async function caption({ body }) {
    const input = requireBody(body);
    const deck = requireDeck(input.deck);
    if (!Array.isArray(deck.slides) || deck.slides.length === 0) throw new HttpError(400, "The deck has no slides to write a caption from.");
    const client = llmClient();
    const drafted = await copy().draftCaption(deck, { llm: client, brand: brandKit().loadBrand(dataDir()) });
    return ok({ caption: drafted.caption, hashtags: drafted.hashtags, engine: client ? `llm:${client.name || "custom"}` : "fallback" });
  }

  // ---- render ----

  // POST { deck, id? } -> every slide rendered to PNG with its layout check.
  // The PNGs are stored as the export of that carousel id; the reply lists one
  // URL and one check result per slide.
  async function render({ body }) {
    const input = requireBody(body);
    const deck = requireDeck(input.deck);
    const dir = dataDir();
    const files = store();
    if (input.id !== undefined && input.id !== null && !files.isValidId(input.id)) throw new HttpError(400, "That is not a valid carousel id.");
    const givenId = files.isValidId(input.id) ? String(input.id) : null;

    return inOrder(queueKey(givenId || "new"), () => withBrowser(async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "carousel-preview-"));
      try {
        const engineRender = renderer();
        const chromePath = typeof engineRender.findChrome === "function" ? engineRender.findChrome(env) : null;
        const result = await engineRender.renderDeck(deck, { outDir, brand: brandKit().loadBrand(dir), size: deck.size, baseDir: dir, dataDir: dir, ...(chromePath ? { chromePath } : {}) });
        const written = (result.files || []).filter((file) => fs.existsSync(file));
        if (written.length === 0) {
          const issues = (result.qa && result.qa.issues) || [];
          return reply(RENDER_STATUS[result.error || ""] || 500, { ok: false, error: issues.join("; ") || "The render produced no slides.", code: result.error || "render_failed", issues, warnings: result.warnings || [], id: givenId });
        }
        // A deck sent without an id becomes a saved draft once it has rendered.
        const id = givenId || files.saveDraft(deck, { dataDir: dir, baseDir: dir }).id;
        const exported = files.recordExport(id, written, { dataDir: dir, title: deck.title, size: result.size || deck.size, caption: deck.caption, hashtags: deck.hashtags, qa: result.qa });

        // Leave nothing stale beside the fresh slides: an old PDF, old JPEG copies or a slide
        // that no longer exists must never be picked up by a later export or publish.
        const keep = new Set(exported.files.map((file) => path.basename(file)));
        for (const name of fs.readdirSync(exported.dir)) {
          if (name === "carousel.pdf" || name === "jpeg" || name === "meta-carousel.json" || (/^slide-\d+\.png$/i.test(name) && !keep.has(name))) {
            fs.rmSync(path.join(exported.dir, name), { recursive: true, force: true });
          }
        }

        const version = Date.now();
        const slides = (result.slides || []).map((slide) => {
          const name = `slide-${String(slide.index).padStart(2, "0")}.png`;
          return {
            index: slide.index,
            layout: slide.layout,
            ok: slide.ok,
            issues: slide.issues || [],
            url: keep.has(name) ? `${apiBase}/serve?id=${id}&i=${slide.index}&v=${version}` : null,
          };
        });
        return ok({ id, version, size: result.size || deck.size || "portrait", slides, qa: result.qa, warnings: result.warnings || [], ms: result.ms || null });
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }));
  }

  // ---- serve ----

  // GET ?id=<export id>&i=<slide number>   one rendered slide
  // GET ?lib=<file name>                   one image from the library folder
  // Images only. Ids and names are validated before anything touches the disk.
  async function serve({ query }) {
    const dir = dataDir();
    const lib = query.lib;
    let file;
    let downloadName;
    if (lib !== undefined) {
      if (typeof lib !== "string" || !LIBRARY_NAME.test(lib)) throw new HttpError(400, "That is not a valid library file name.");
      file = path.join(dir, "library", lib);
      downloadName = lib;
    } else {
      const id = typeof query.id === "string" ? query.id : "";
      const index = typeof query.i === "string" ? query.i : "";
      const files = store();
      if (!files.isValidId(id)) throw new HttpError(400, "That is not a valid carousel id.");
      if (!/^[1-9]\d?$/.test(index)) throw new HttpError(400, "Say which slide: i is a number from 1 to 99.");
      const exported = files.getExport(id, { dataDir: dir });
      if (!exported) throw new HttpError(404, "That carousel has not been rendered yet.");
      const name = `slide-${index.padStart(2, "0")}.png`;
      const match = exported.files.find((entry) => path.basename(entry) === name);
      if (!match) throw new HttpError(404, `Slide ${index} is not part of that export.`);
      file = match;
      downloadName = `${id}-${name}`;
    }
    return imageReply(file, dir, { cache: Boolean(query.v), downloadName: query.download === "1" ? downloadName : null });
  }

  // ---- images ----

  // Results from the engine carry file paths for local images. The page gets a path
  // relative to the data folder (what goes into the deck) and a URL it can show.
  function forPage(found, dir) {
    const results = (found.results || []).map((item) => {
      const local = /^https?:\/\//i.test(item.src) ? null : libraryUrl(item.src, dir);
      const remoteThumb = typeof item.thumb === "string" && /^https?:\/\//i.test(item.thumb) ? item.thumb : null;
      return {
        src: local ? local.src : item.src,
        thumb: local ? local.url : remoteThumb || (/^https?:\/\//i.test(item.src) ? item.src : null),
        credit: item.credit || "",
        license: item.license || "",
        provider: item.provider || found.provider || "",
      };
    });
    return { ...found, results };
  }

  // One image, checked by its first bytes, stored in the library under a name made here.
  function upload(files, dir) {
    const list = Array.isArray(files) ? files : [];
    const file = list.find((entry) => entry && entry.field === "file");
    if (!file || !Buffer.isBuffer(file.data)) throw new HttpError(400, "Attach one image as the form field named file.");
    if (file.data.length > MAX_UPLOAD) throw new HttpError(413, "That image is larger than 15 MB.");
    const ext = sniff(file.data);
    if (!ext) throw new HttpError(415, "Upload a PNG, JPEG or WebP image.");
    const given = typeof file.filename === "string" ? path.basename(file.filename.replace(/\\/g, "/")) : "";
    const base = path.basename(given, path.extname(given)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
    const library = path.join(dir, "library");
    let name = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      name = `${base}-${crypto.randomBytes(4).toString("hex")}${ext}`;
      try {
        fs.writeFileSync(path.join(library, name), file.data, { flag: "wx", mode: 0o644 });
        break;
      } catch (error) {
        if (!error || error.code !== "EEXIST" || attempt === 5) throw new HttpError(500, "The image could not be saved to the library.");
      }
    }
    const saved = libraryUrl(path.join(library, name), dir);
    if (!saved) throw new HttpError(500, "The image was saved but could not be listed.");
    return ok({ name: saved.name, src: saved.src, thumb: saved.url });
  }

  // POST JSON { query, count, orientation, provider? }        find backgrounds through the provider chain
  // POST JSON { generate: true, prompt, size, provider? }     generate one background
  // POST with files: [{ field: "file", filename, data }]      add your own image to the library
  // Every reply lists which providers were tried and why each one was skipped.
  async function imagesRoute({ body, files }) {
    const dir = dataDir();
    if (Array.isArray(files) && files.length > 0) return upload(files, dir);
    const input = requireBody(body);
    const provider = text(input.provider, 60) || undefined;
    const opts = { env, dataDir: dir, provider, fetchImpl };

    let found;
    if (input.generate === true) {
      const prompt = text(input.prompt, 1000).trim();
      if (!prompt) throw new HttpError(400, "Describe the image you want to generate.");
      found = await images().generateBackground({ prompt, size: text(input.size, 20) || "portrait" }, opts);
    } else {
      found = await images().findBackgrounds({ query: text(input.query, 300), count: typeof input.count === "number" ? input.count : 9, orientation: text(input.orientation, 20) || "portrait" }, opts);
    }

    const failed = (found.tried || []).filter((entry) => entry.status === "error");
    if ((found.results || []).length === 0 && failed.length > 0) {
      const error = failed.map((entry) => `${entry.id}: ${entry.detail || "failed"}`).join("; ");
      throw new HttpError(502, error, { provider: null, results: [], tried: found.tried });
    }
    return ok(forPage(found, dir));
  }

  // ---- brand ----

  function readBrandFile(file) {
    if (!fs.existsSync(file)) return {};
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new HttpError(500, `brand.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(parsed)) throw new HttpError(500, "brand.json must hold a JSON object.");
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith("_")));
  }

  // The editable brand: what is in brand.json laid over the engine's neutral defaults.
  function mergedBrand(raw, kit) {
    const defaults = kit.DEFAULT_BRAND;
    const part = (key) => ({ ...(isObject(defaults[key]) ? defaults[key] : {}), ...(isObject(raw[key]) ? raw[key] : {}) });
    return {
      name: typeof raw.name === "string" ? raw.name : "",
      handle: typeof raw.handle === "string" ? raw.handle : "",
      byline: typeof raw.byline === "string" ? raw.byline : "",
      colors: part("colors"),
      fonts: part("fonts"),
      logo: typeof raw.logo === "string" && raw.logo ? raw.logo : null,
      portrait: typeof raw.portrait === "string" && raw.portrait ? raw.portrait : null,
      chrome: part("chrome"),
      voiceProfilePath: typeof raw.voiceProfilePath === "string" && raw.voiceProfilePath ? raw.voiceProfilePath : null,
      defaultHashtags: Array.isArray(raw.defaultHashtags) ? raw.defaultHashtags.filter((tag) => typeof tag === "string") : [],
    };
  }

  function brandReply(dir, kit) {
    const file = path.join(dir, "brand.json");
    const brand = mergedBrand(readBrandFile(file), kit);
    const preview = (value) => {
      if (typeof value !== "string" || !value) return null;
      if (/^https:\/\//i.test(value)) return value;
      const local = libraryUrl(value, dir);
      return local ? local.url : null;
    };
    return ok({
      exists: fs.existsSync(file),
      brand,
      previews: { logo: preview(brand.logo), portrait: preview(brand.portrait) },
      warnings: kit.normalizeBrand(brand, dir).warnings,
      defaults: kit.DEFAULT_BRAND,
    });
  }

  // True when a path (relative to the data dir, or absolute) stays inside the data dir once
  // links in the part of it that exists are resolved.
  function insideData(given, dir) {
    try {
      return engine("recipes/_engine.js").insideDataDir(path.resolve(dir, given), { dataDir: dir }) === true;
    } catch {
      return false;
    }
  }

  // The brand keys the page edits. Fonts and the voice profile are set in brand.json by hand:
  // they name local files, and a browser has no business choosing those.
  function validateBrand(input, kit, dir) {
    const errors = [];
    const clean = {};
    for (const [key, value] of Object.entries(input)) {
      if (key in TEXT_LIMITS) {
        if (typeof value !== "string") errors.push(`${key}: expected text`);
        else if (value.length > TEXT_LIMITS[key]) errors.push(`${key}: keep it under ${TEXT_LIMITS[key]} characters`);
        else clean[key] = value.trim();
      } else if (key === "colors") {
        if (!isObject(value)) { errors.push("colors: expected an object"); continue; }
        const colors = {};
        for (const [name, colour] of Object.entries(value)) {
          if (!kit.COLOR_KEYS.includes(name)) { errors.push(`colors.${name}: unknown colour`); continue; }
          const hex = kit.normalizeHex(colour);
          if (!hex) errors.push(`colors.${name}: expected a hex colour such as #2FB5A6`);
          else colors[name] = hex;
        }
        clean.colors = colors;
      } else if (key === "chrome") {
        if (!isObject(value)) { errors.push("chrome: expected an object"); continue; }
        const chrome = {};
        for (const [name, flag] of Object.entries(value)) {
          if (!kit.CHROME_KEYS.includes(name)) errors.push(`chrome.${name}: unknown switch`);
          else if (typeof flag !== "boolean") errors.push(`chrome.${name}: expected true or false`);
          else chrome[name] = flag;
        }
        clean.chrome = chrome;
      } else if (key === "logo" || key === "portrait") {
        // An https address, or a file inside the data dir (an upload lands in library/).
        const given = typeof value === "string" ? value.trim() : value;
        if (given === null || given === "") clean[key] = null;
        else if (typeof given !== "string" || given.length > 600 || given.includes("\0")) errors.push(`${key}: expected an uploaded image or an https URL`);
        else if (/^https:\/\//i.test(given)) clean[key] = given;
        else if (/^[a-z][a-z0-9+.-]*:/i.test(given)) errors.push(`${key}: only https URLs or images inside the carousel data folder are accepted`);
        else if (!insideData(given, dir)) errors.push(`${key}: the image has to be inside the carousel data folder. Upload it, or use an https URL`);
        else clean[key] = given;
      } else if (key === "defaultHashtags") {
        if (!Array.isArray(value) || value.length > 30 || !value.every((tag) => typeof tag === "string" && tag.length <= 60)) errors.push("defaultHashtags: expected a list of up to 30 short hashtags");
        else clean.defaultHashtags = value.map((tag) => String(tag).trim()).filter(Boolean);
      } else {
        errors.push(`${key}: unknown brand key`);
      }
    }
    if (errors.length) throw new HttpError(422, errors.join("; "), { errors });
    return clean;
  }

  // GET -> { exists, brand, previews, warnings, defaults }
  async function brandGet() {
    return brandReply(dataDir(), brandKit());
  }

  // PUT { name, handle, byline, colors, chrome, logo, portrait, defaultHashtags } -> validated, then
  // written to brand.json. Keys left out keep their saved value (fonts and voiceProfilePath
  // included: they are never set from here).
  async function brandPut({ body }) {
    const dir = dataDir();
    const kit = brandKit();
    const clean = validateBrand(requireBody(body), kit, dir);
    const file = path.join(dir, "brand.json");
    const current = readBrandFile(file);
    const next = { ...current, ...clean };
    for (const key of ["colors", "chrome"]) {
      if (isObject(clean[key])) next[key] = { ...(isObject(current[key]) ? current[key] : {}), ...clean[key] };
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(temp, file);
    return brandReply(dir, kit);
  }

  // ---- drafts ----

  // GET            -> every saved draft, newest first
  // GET ?id=<id>   -> one draft with its deck
  async function draftsGet({ query }) {
    const dir = dataDir();
    const id = query.id;
    if (id === undefined) {
      // File paths stay on the server: the page only needs ids, titles and dates.
      const drafts = store().listDrafts({ dataDir: dir }).map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "path")));
      return ok({ drafts });
    }
    if (!store().isValidId(id)) throw new HttpError(400, "That is not a valid carousel id.");
    const found = store().getDraft(id, { dataDir: dir });
    if (!found) throw new HttpError(404, "No saved draft has that id.");
    // A deck saved with a layout that has since been retired opens on its replacement.
    let deck = found.deck;
    let upgraded = [];
    const upgrade = deckSchema().upgradeDeck;
    if (typeof upgrade === "function") {
      try {
        const result = upgrade(deck) || {};
        if (isObject(result.deck)) deck = result.deck;
        if (Array.isArray(result.warnings)) upgraded = result.warnings.map(String);
      } catch {
        deck = found.deck;
      }
    }
    return ok({ id: found.id, deck, upgraded, createdAt: found.createdAt, updatedAt: found.updatedAt });
  }

  // POST { deck, id? } -> saves the draft (a new id is made when none is given).
  async function draftsPost({ body }) {
    const input = requireBody(body);
    const deck = requireDeck(input.deck);
    const dir = dataDir();
    if (input.id !== undefined && input.id !== null && !store().isValidId(input.id)) throw new HttpError(400, "That is not a valid carousel id.");
    const saved = store().saveDraft(deck, { dataDir: dir, baseDir: dir, id: input.id || undefined });
    const record = store().getDraft(saved.id, { dataDir: dir });
    return ok({ id: saved.id, updatedAt: record ? record.updatedAt : null });
  }

  // ---- doctor ----

  // GET -> what is wired: chrome, llm, each image provider, each publisher, codexSeat.
  // This is the engine's own status report (no network calls, names only, never a key).
  // The report is kept for 30 seconds: one part of it starts a small local program, and a
  // page (or anything else) asking in a loop must not keep doing that.
  let doctorCache = null;
  async function doctor() {
    const dir = dataDir();
    const now = Date.now();
    if (!doctorCache || now - doctorCache.at > DOCTOR_TTL || now < doctorCache.at) doctorCache = { at: now, report: await recipe("status").runRecipe({}, { env, dataDir: dir, fetchImpl }) };
    const report = doctorCache.report;
    const meta = report.metadata || {};
    const chrome = meta.chrome || {};
    return ok({
      ready: meta.ok === true,
      chrome: { ok: chrome.ok === true, detail: chrome.detail || "" },
      llm: meta.llm || { ok: false, name: null, detail: "" },
      images: meta.images || [],
      publishers: meta.publishers || [],
      codexSeat: meta.codexSeat || { available: false, reason: "" },
      modules: meta.modules || {},
      mismatches: meta.mismatches || [],
      brandExists: fs.existsSync(path.join(dir, "brand.json")),
      summary: report.reply,
    });
  }

  // ---- publish ----

  // POST { id, targets, caption, title?, confirm?, confirmToken?, dryRun?, dry_run? }
  //
  // This decides nothing about the gate: confirm, confirmToken, dryRun and dry_run go to the
  // engine exactly as they arrived, and the publish recipe is the only judge.
  //   - No confirm (or a dry run): the engine describes what would be sent and returns a
  //     confirmToken. Nothing leaves the machine.
  //   - confirm "PUBLISH" plus the confirmToken of that dry run: the engine publishes.
  //   - A token that no longer matches (caption, slides or targets changed): 409 with a fresh
  //     description and token, so the page can show the summary again.
  async function publish({ body }) {
    const input = requireBody(body);
    const dir = dataDir();
    if (!store().isValidId(input.id)) throw new HttpError(400, "Say which carousel to publish: id must be the id of a rendered carousel.");
    const targets = Array.isArray(input.targets) ? input.targets.filter((target) => typeof target === "string") : [];
    if (targets.length === 0) throw new HttpError(400, "Choose at least one platform to publish to.");
    if (input.caption !== undefined && typeof input.caption !== "string") throw new HttpError(400, "caption must be text.");

    const recipeInput = { id: input.id, targets, caption: text(input.caption) };
    if (typeof input.title === "string" && input.title.trim()) recipeInput.title = input.title;
    for (const key of ["confirm", "confirmToken", "dryRun", "dry_run"]) if (input[key] !== undefined) recipeInput[key] = input[key];

    // Same queue as rendering and the PDF build: what is described or sent is one settled export.
    const result = await inOrder(queueKey(String(input.id)), () => recipe("publish-carousel").runRecipe(recipeInput, { env, dataDir: dir, fetchImpl }));
    const meta = result.metadata || {};
    const results = (Array.isArray(meta.results) ? meta.results : []).map((entry) => (entry && typeof entry === "object" ? { ...entry, url: httpsUrl(entry.url) } : entry));
    const headline = String(result.reply || "").split("\n")[0];
    const token = typeof meta.confirmToken === "string" ? meta.confirmToken : null;

    if (results.length === 0) {
      const extra = meta.qaFailed ? { code: "layout_check_failed", qaIssues: meta.qaIssues || [] } : {};
      throw new HttpError(meta.qaFailed ? 409 : 400, result.reply || "Nothing was published.", extra);
    }
    if (meta.confirmTokenRequired) {
      return reply(409, { ok: false, error: headline, code: "confirm_token_mismatch", published: false, confirmToken: token, results });
    }
    if (meta.dryRun === true || meta.confirmationRequired) {
      if (results.every((entry) => entry.status === "error")) {
        throw new HttpError(409, results.map((entry) => `${entry.id}: ${entry.detail || "cannot be published"}`).join(" "), { code: "not_publishable", results });
      }
      return ok({ dryRun: true, published: false, confirmToken: token, results, message: headline });
    }

    const sent = results.filter((entry) => entry.status === "published" || entry.status === "processing" || entry.status === "unknown");
    if (sent.length === 0) {
      const blocked = results.every((entry) => entry.status === "not_wired" || entry.status === "refused");
      return reply(blocked ? 409 : 502, { ok: false, error: result.reply, published: false, results });
    }
    return ok({ dryRun: false, published: meta.publishedTo || [], unconfirmed: meta.unconfirmed || [], results, message: headline });
  }

  // ---- export ----

  // GET                      -> history: past exports and the publish log, newest first
  // GET ?id=<id>             -> the PNG URLs of that export, plus the PDF URL
  // GET ?id=<id>&format=pdf  -> the PDF, built by the engine from the rendered PNGs
  // GET ?id=<id>&format=meta -> writes meta-carousel.json beside the slides and returns it with its warnings
  async function exportRoute({ query }) {
    const dir = dataDir();
    const files = store();
    const id = query.id;

    if (id === undefined) {
      const newestFirst = (a, b) => String(b.exportedAt || "").localeCompare(String(a.exportedAt || ""));
      const exports = files.listExports({ dataDir: dir }).sort(newestFirst).slice(0, 30).map((entry) => ({
        id: entry.id,
        title: entry.title || "",
        size: entry.size || null,
        slides: entry.files.length,
        exportedAt: entry.exportedAt || null,
        qaOk: !(entry.qa && entry.qa.ok === false),
      }));
      const publishes = files.readPublishLog({ dataDir: dir }).slice(-40).reverse().map((entry) => ({
        at: entry.at || null,
        target: entry.target || "",
        status: entry.status || "",
        detail: entry.detail || "",
        url: httpsUrl(entry.url),
        dryRun: entry.dryRun === true,
        title: entry.title || "",
        source: entry.source || null,
      }));
      return ok({ exports, publishes });
    }

    if (!files.isValidId(id)) throw new HttpError(400, "That is not a valid carousel id.");
    // The export as it really is on disk: its folder inside the data dir, and every slide a
    // plain file inside that folder. A link, or a manifest that points elsewhere, is refused.
    const read = () => {
      const found = files.getExport(id, { dataDir: dir });
      if (!found || found.files.length === 0) throw new HttpError(404, "That carousel has not been rendered yet. Render it first.");
      const outside = new HttpError(403, "That export points outside the carousel data folder, so it is not used. Render the carousel again.");
      let folder;
      try {
        folder = fs.realpathSync(found.dir);
      } catch {
        throw new HttpError(404, "That carousel has not been rendered yet. Render it first.");
      }
      if (!folder.startsWith(fs.realpathSync(dir) + path.sep)) throw outside;
      let missing = 0;
      const real = [];
      for (const file of found.files) {
        let stat;
        try {
          stat = fs.lstatSync(file);
        } catch {
          missing += 1;
          continue;
        }
        if (!stat.isFile() || !fs.realpathSync(file).startsWith(folder + path.sep)) throw outside;
        real.push(fs.realpathSync(file));
      }
      if (missing) throw new HttpError(409, `The export is incomplete (${missing} slide file(s) missing). Render it again.`);
      return { ...found, dir: folder, files: real };
    };
    // Anything at that name that is not a plain file (a link, say) is removed, never followed.
    const plainFile = (file) => {
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        return false;
      }
      if (stat.isFile()) return true;
      if (stat.isDirectory()) throw new HttpError(409, "The export folder holds something unexpected. Render the carousel again.");
      fs.unlinkSync(file);
      return false;
    };

    if (query.format === "pdf") {
      // In the same queue as rendering: the PDF is built from a settled set of slides, and a
      // render deletes it again, so a carousel.pdf on disk always matches the slides beside it.
      const bytes = await inOrder(queueKey(id), async () => {
        const current = read();
        const out = path.join(current.dir, "carousel.pdf");
        if (plainFile(out)) return fs.readFileSync(out);
        // Built under a name nobody could have prepared, then created exclusively.
        const scratch = path.join(current.dir, `.carousel-${crypto.randomBytes(8).toString("hex")}.pdf`);
        try {
          await pdf().pngsToPdf(current.files, scratch, { title: current.title || undefined });
          const built = fs.readFileSync(scratch);
          fs.writeFileSync(out, built, { flag: "wx" });
          return built;
        } finally {
          fs.rmSync(scratch, { force: true });
        }
      });
      return {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.length), "Content-Disposition": `attachment; filename="${id}.pdf"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
        buffer: bytes,
      };
    }

    if (query.format === "meta") {
      // A Meta ads carousel handoff: one JSON file beside the slides. Nothing is sent anywhere.
      const handoff = engine("lib/meta-handoff.js");
      const made = await inOrder(queueKey(id), async () => {
        const current = read();
        let deck = {};
        const saved = files.getDraft(id, { dataDir: dir });
        if (saved && isObject(saved.deck)) {
          deck = saved.deck;
          const upgrade = deckSchema().upgradeDeck;
          if (typeof upgrade === "function") {
            try {
              const result = upgrade(deck) || {};
              if (isObject(result.deck)) deck = result.deck;
            } catch {
              deck = saved.deck;
            }
          }
        }
        const caption = typeof deck.caption === "string" && deck.caption.trim() ? deck.caption : typeof current.caption === "string" ? current.caption : "";
        try {
          plainFile(path.join(current.dir, handoff.SPEC_NAME));
          const written = handoff.writeMetaCarouselSpec({ exportDir: current.dir, files: current.files, deckTitle: (typeof deck.title === "string" && deck.title) || current.title || "", caption, slides: Array.isArray(deck.slides) ? deck.slides : [] });
          const warnings = [...written.warnings];
          if (current.qa && current.qa.ok === false) warnings.unshift("Some slides do not pass the layout check, so text may be clipped in these images. Fix the slides marked in red and render again.");
          return { spec: written.spec, warnings };
        } catch (error) {
          if (error && error.code === "too_few_cards") throw new HttpError(422, error.message, { code: error.code });
          if (error && error.code === "outside_export") throw new HttpError(403, error.message, { code: error.code });
          throw error;
        }
      });
      if (query.download === "1") {
        const bytes = Buffer.from(`${JSON.stringify(made.spec, null, 2)}\n`);
        return { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(bytes.length), "Content-Disposition": `attachment; filename="${id}-meta-carousel.json"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }, buffer: bytes };
      }
      const fillIn = Object.entries(made.spec).filter(([, value]) => typeof value === "string" && value.startsWith("FILL_IN_")).map(([key]) => key);
      return ok({ id, file: `exports/${id}/${handoff.SPEC_NAME}`, spec: made.spec, warnings: made.warnings, fillIn, download: `${apiBase}/export?id=${id}&format=meta&download=1` });
    }
    const exported = read();
    const version = Date.parse(String(exported.exportedAt || "")) || Date.now();
    const pngs = exported.files.map((file) => {
      const match = /^slide-(\d+)\.png$/i.exec(path.basename(file));
      const index = match ? Number(match[1]) : 0;
      return { index, name: path.basename(file), url: `${apiBase}/serve?id=${id}&i=${index}&v=${version}`, download: `${apiBase}/serve?id=${id}&i=${index}&download=1` };
    });
    return ok({ id, title: exported.title || "", exportedAt: exported.exportedAt || null, qa: exported.qa || null, pngs, pdf: `${apiBase}/export?id=${id}&format=pdf`, meta: `${apiBase}/export?id=${id}&format=meta` });
  }

  // ---- schema ----

  // GET -> the engine's layout schema, so the page never hard codes fields or word limits.
  async function schema() {
    const found = deckSchema();
    return ok({ layouts: found.LAYOUTS, sizes: found.SIZES, backgroundLayouts: found.BACKGROUND_LAYOUTS, warnSlides: found.WARN_SLIDES, maxSlides: found.MAX_SLIDES, order: Array.isArray(found.TEMPLATE_ORDER) ? found.TEMPLATE_ORDER : Object.keys(found.LAYOUTS) });
  }

  // ---- templates ----

  function sizeOf(value) {
    const sizes = deckSchema().SIZES || {};
    if (value === undefined || value === null || value === "") return Object.prototype.hasOwnProperty.call(sizes, "portrait") ? "portrait" : Object.keys(sizes)[0];
    if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(sizes, value)) throw new HttpError(400, `size must be one of ${Object.keys(sizes).join(", ")}.`);
    return value;
  }

  // The templates in picker order. lib/templates.js is used when it is there; the
  // schema's layout list is the fallback, so the picker always has something to show.
  function templateRows(mod) {
    const found = deckSchema();
    const layouts = found.LAYOUTS || {};
    const backgrounds = Array.isArray(found.BACKGROUND_LAYOUTS) ? found.BACKGROUND_LAYOUTS : [];
    let listed = null;
    if (mod && typeof mod.listTemplates === "function") {
      try {
        const raw = mod.listTemplates();
        if (Array.isArray(raw)) listed = raw.filter(isObject);
        else if (isObject(raw)) listed = Object.entries(raw).map(([id, row]) => ({ ...(isObject(row) ? row : {}), id }));
      } catch {
        listed = null;
      }
    }
    const source = listed && listed.length ? "templates" : "schema";
    const base = source === "templates" ? listed : Object.keys(layouts).map((id) => ({ id }));
    const rows = [];
    for (const entry of base) {
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!TEMPLATE_ID.test(id)) continue;
      const spec = isObject(layouts[id]) ? layouts[id] : {};
      const pick = (...values) => values.find((value) => typeof value === "string" && value.trim()) || "";
      const group = pick(entry.group, spec.group, GROUP_GUESS[id.slice(0, 2)]);
      const flag = [entry.supportsBackground, spec.supportsBackground].find((value) => typeof value === "boolean");
      const sample = [entry.sampleSlide, spec.sampleSlide].find(isObject);
      rows.push({
        id,
        name: pick(entry.name, spec.name, entry.title, spec.title, id),
        purpose: pick(entry.purpose, spec.purpose, entry.use, spec.use),
        group: GROUPS.some((known) => known.id === group) ? group : "point",
        supportsBackground: flag === undefined ? backgrounds.includes(id) : flag,
        sampleSlide: sample ? { ...sample, layout: id } : null,
      });
    }
    return { rows, source, groups: templateGroups(found) };
  }

  // The four groups of the picker, with the schema's own names and hints when it has them.
  function templateGroups(found) {
    const own = isObject(found.TEMPLATE_GROUPS) ? found.TEMPLATE_GROUPS : {};
    return GROUPS.map((group) => {
      const given = isObject(own[group.id]) ? own[group.id] : {};
      const pick = (...values) => values.find((value) => typeof value === "string" && value.trim());
      return { id: group.id, label: pick(given.label, given.name) || group.label, hint: pick(given.hint) || group.hint };
    });
  }

  function previewFile(mod, dir, brand, size, id) {
    if (!mod || typeof mod.previewPath !== "function") return null;
    let file;
    try {
      file = mod.previewPath({ dataDir: dir, brand, size, id });
    } catch {
      return null;
    }
    if (typeof file !== "string" || !file) return null;
    try {
      const real = fs.realpathSync(file);
      const stat = fs.statSync(real);
      if (!stat.isFile() || !real.startsWith(fs.realpathSync(dir) + path.sep)) return null;
      return { file: real, version: Math.round(stat.mtimeMs) };
    } catch {
      return null;
    }
  }

  function templateList(dir, size) {
    const mod = templatesModule();
    const { rows, source, groups } = templateRows(mod);
    const brand = brandKit().loadBrand(dir);
    let ready = 0;
    const templates = rows.map((row) => {
      const found = previewFile(mod, dir, brand, size, row.id);
      if (found) ready += 1;
      return { ...row, preview: found ? `${apiBase}/templates?id=${encodeURIComponent(row.id)}&size=${size}&v=${found.version}` : null };
    });
    return {
      templates,
      groups,
      size,
      source,
      previews: { available: Boolean(mod && typeof mod.renderTemplatePreviews === "function"), ready, total: templates.length },
    };
  }

  // GET                          -> the template list (grouped, with a preview URL when one is cached)
  // GET ?id=<template>&size=<s>  -> that template's preview PNG, in the saved brand
  async function templatesGet({ query }) {
    const dir = dataDir();
    const size = sizeOf(query.size);
    if (query.id === undefined) return ok(templateList(dir, size));
    const id = typeof query.id === "string" ? query.id : "";
    const mod = templatesModule();
    if (!TEMPLATE_ID.test(id) || !templateRows(mod).rows.some((row) => row.id === id)) throw new HttpError(400, "That is not a known template.");
    const found = previewFile(mod, dir, brandKit().loadBrand(dir), size, id);
    if (!found) throw new HttpError(404, "There is no preview for that template yet.");
    return imageReply(found.file, dir, { cache: Boolean(query.v) });
  }

  // POST { size?, force? } -> builds (or rebuilds) the preview PNGs for the saved brand and
  // that size, then returns the list again.
  async function templatesPost({ body }) {
    const input = requireBody(body);
    const dir = dataDir();
    const size = sizeOf(input.size);
    const mod = templatesModule();
    if (!mod || typeof mod.renderTemplatePreviews !== "function") {
      throw new HttpError(501, "Template previews are not available in this install, so the picker shows plain tiles.", { code: "previews_unavailable", ...templateList(dir, size) });
    }
    let built = [];
    await withBrowser(async () => {
      try {
        const engineRender = renderer();
        const chromePath = typeof engineRender.findChrome === "function" ? engineRender.findChrome(env) : null;
        const out = await mod.renderTemplatePreviews({ dataDir: dir, brand: brandKit().loadBrand(dir), size, force: input.force === true, ...(chromePath ? { chromePath } : {}) });
        built = Array.isArray(out) ? out : [];
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const code = error && typeof error.code === "string" ? error.code : "previews_failed";
        throw new HttpError(code === "chrome_not_found" ? 503 : code === "invalid_size" ? 400 : 500, `The template previews could not be built: ${String((error && error.message) || error).split("\n")[0]}`, { code });
      }
    });
    return ok({ built: built.length, ...templateList(dir, size) });
  }

  const ROUTES = {
    draft: { POST: draft },
    render: { POST: render },
    serve: { GET: serve },
    images: { POST: imagesRoute },
    caption: { POST: caption },
    brand: { GET: brandGet, PUT: brandPut },
    drafts: { GET: draftsGet, POST: draftsPost },
    doctor: { GET: doctor },
    publish: { POST: publish },
    export: { GET: exportRoute },
    schema: { GET: schema },
    templates: { GET: templatesGet, POST: templatesPost },
  };

  async function handle(name, method, input = {}) {
    try {
      const route = Object.prototype.hasOwnProperty.call(ROUTES, String(name)) ? ROUTES[String(name)] : null;
      if (!route) throw new HttpError(404, "There is no such API call.");
      const verb = String(method || "GET").toUpperCase();
      const run = Object.prototype.hasOwnProperty.call(route, verb) ? route[verb] : null;
      if (!run) {
        const error = new HttpError(405, `${verb} is not supported here. Use ${Object.keys(route).join(" or ")}.`);
        error.headers = { Allow: Object.keys(route).join(", ") };
        throw error;
      }
      const query = {};
      if (isObject(input.query)) for (const [key, value] of Object.entries(input.query)) if (typeof value === "string") query[key] = value;
      return await run({ query, body: input.body, files: input.files });
    } catch (error) {
      return fail(error, String(name), options.onError);
    }
  }

  return { handle, names: Object.keys(ROUTES), methods: (name) => (Object.prototype.hasOwnProperty.call(ROUTES, name) ? Object.keys(ROUTES[name]) : []), dataDir };
}

module.exports = { createApi, HttpError, MAX_UPLOAD, sniffImage: sniff };
