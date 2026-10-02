"use strict";

// Local storage for the carousel engine: drafts, exports and an append-only
// publish log. Everything lives under one data dir and every id is validated
// before it touches the filesystem, so an id can never escape that dir.

const fs = require("node:fs");
const path = require("node:path");

const SUBDIRS = ["drafts", "exports", "library", "logs"];
const ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOG_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONFIG_NAMES = ["brand", "providers", "publishers"];
const ENGINE_ROOT = path.resolve(__dirname, "..");

function resolveDataDir(opts) {
  const given = typeof opts === "string" ? opts : opts && opts.dataDir;
  if (given) return path.resolve(String(given));
  if (process.env.CAROUSEL_HOME) return path.resolve(process.env.CAROUSEL_HOME);
  return path.join(process.cwd(), ".carousel");
}

function ensureDataDir(opts) {
  const dataDir = resolveDataDir(opts);
  for (const sub of SUBDIRS) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  return dataDir;
}

function slugify(text) {
  const slug = String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function timestamp(now) {
  const d = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function makeId(title, now) {
  return `${timestamp(now)}-${slugify(title)}`;
}

function isValidId(id) {
  return typeof id === "string" && id.length <= 96 && ID_PATTERN.test(id);
}

function assertId(id) {
  if (!isValidId(id)) {
    const err = new Error(`Invalid carousel id: ${JSON.stringify(String(id).slice(0, 80))}. Ids look like 20260102-093000-my-title.`);
    err.code = "INVALID_ID";
    throw err;
  }
  return id;
}

// Belt and braces: even a validated id is resolved and checked against its base.
function inside(base, ...parts) {
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) {
    const err = new Error("Path escapes the data dir.");
    err.code = "PATH_ESCAPE";
    throw err;
  }
  return full;
}

function draftPath(id, opts) {
  return inside(path.join(resolveDataDir(opts), "drafts"), `${assertId(id)}.json`);
}

function exportDir(id, opts) {
  return inside(path.join(resolveDataDir(opts), "exports"), assertId(id));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isoNow(now) {
  return (now instanceof Date ? now : new Date(now === undefined ? Date.now() : now)).toISOString();
}

function saveDraft(deck, opts = {}) {
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) throw new TypeError("saveDraft needs a deck object.");
  const dataDir = ensureDataDir(opts);
  let id = opts.id;
  let createdAt = isoNow(opts.now);
  // baseDir: the folder relative image paths in the deck resolve against.
  let baseDir = opts.baseDir ? path.resolve(String(opts.baseDir)) : null;
  if (id) {
    const existing = readJson(draftPath(id, { dataDir }));
    if (existing && existing.createdAt) createdAt = existing.createdAt;
    if (existing && existing.baseDir && !baseDir) baseDir = existing.baseDir;
  } else {
    const base = makeId(deck.title, opts.now);
    id = base;
    for (let n = 2; fs.existsSync(draftPath(id, { dataDir })) || fs.existsSync(exportDir(id, { dataDir })); n += 1) id = `${base}-${n}`;
  }
  const file = draftPath(id, { dataDir });
  writeJsonAtomic(file, { id, createdAt, updatedAt: isoNow(opts.now), ...(baseDir ? { baseDir } : {}), deck });
  return { id, path: file };
}

function getDraft(id, opts = {}) {
  const file = draftPath(id, opts);
  const record = readJson(file);
  if (!record || typeof record.deck !== "object" || record.deck === null) return null;
  return { id, path: file, createdAt: record.createdAt || null, updatedAt: record.updatedAt || null, baseDir: record.baseDir || null, deck: record.deck };
}

// Returns the deck itself (or null when there is no such draft).
function loadDraft(id, opts = {}) {
  const record = getDraft(id, opts);
  return record ? record.deck : null;
}

function getExport(id, opts = {}) {
  const dir = exportDir(id, opts);
  const manifest = readJson(path.join(dir, "export.json"));
  if (!manifest) return null;
  const files = (manifest.files || []).map((f) => (path.isAbsolute(f) ? f : path.join(dir, f)));
  const pdf = manifest.pdf ? (path.isAbsolute(manifest.pdf) ? manifest.pdf : path.join(dir, manifest.pdf)) : null;
  return { ...manifest, id, dir, files, pdf };
}

function listDrafts(opts = {}) {
  const dataDir = resolveDataDir(opts);
  const dir = path.join(dataDir, "drafts");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isValidId(id)) continue;
    const record = getDraft(id, { dataDir });
    if (!record) continue;
    const exported = getExport(id, { dataDir });
    out.push({
      id,
      path: record.path,
      title: typeof record.deck.title === "string" ? record.deck.title : "",
      size: record.deck.size || null,
      slides: Array.isArray(record.deck.slides) ? record.deck.slides.length : 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      exported: Boolean(exported),
      exportedAt: exported ? exported.exportedAt || null : null,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function listExports(opts = {}) {
  const dataDir = resolveDataDir(opts);
  let names = [];
  try {
    names = fs.readdirSync(path.join(dataDir, "exports"));
  } catch {
    return [];
  }
  return names
    .filter(isValidId)
    .map((id) => getExport(id, { dataDir }))
    .filter(Boolean)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// Records rendered files for a carousel. Files that are not already inside
// exports/<id>/ are copied in (pass copy: false to reference them in place).
function recordExport(id, files, opts = {}) {
  const dataDir = ensureDataDir(opts);
  const dir = exportDir(id, { dataDir });
  if (!Array.isArray(files) || files.length === 0) throw new TypeError("recordExport needs a non-empty list of files.");
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  const place = (file) => {
    const abs = fs.realpathSync(path.resolve(String(file)));
    if (abs.startsWith(realDir + path.sep)) return path.relative(realDir, abs);
    if (opts.copy === false) return abs;
    const name = path.basename(abs);
    fs.copyFileSync(abs, inside(dir, name));
    return name;
  };
  const manifest = {
    id,
    exportedAt: isoNow(opts.now),
    files: files.map(place),
    pdf: opts.pdf ? place(opts.pdf) : null,
    title: opts.title || null,
    size: opts.size || null,
    caption: typeof opts.caption === "string" ? opts.caption : null,
    hashtags: Array.isArray(opts.hashtags) ? opts.hashtags : [],
    qa: opts.qa || null,
  };
  const manifestPath = path.join(dir, "export.json");
  writeJsonAtomic(manifestPath, manifest);
  return { id, dir, files: manifest.files.map((f) => (path.isAbsolute(f) ? f : path.join(dir, f))), pdf: manifest.pdf ? (path.isAbsolute(manifest.pdf) ? manifest.pdf : path.join(dir, manifest.pdf)) : null, manifestPath };
}

function logPath(name, opts) {
  if (!LOG_NAME_PATTERN.test(String(name))) {
    const err = new Error(`Invalid log name: ${JSON.stringify(String(name).slice(0, 40))}`);
    err.code = "INVALID_LOG_NAME";
    throw err;
  }
  return inside(path.join(resolveDataDir(opts), "logs"), `${name}.jsonl`);
}

// Append-only: one JSON object per line, opened with the "a" flag, never rewritten.
function appendLog(name, entry, opts = {}) {
  const file = logPath(name, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { at: isoNow(opts.now), ...(entry && typeof entry === "object" ? entry : { value: entry }) };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { flag: "a" });
  return record;
}

function readLog(name, opts = {}) {
  const file = logPath(name, opts);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line from a crash is skipped, never repaired in place.
    }
  }
  return out;
}

function appendPublishLog(entry, opts = {}) {
  return appendLog("publish", entry, opts);
}

function readPublishLog(opts = {}) {
  return readLog("publish", opts);
}

// Config: <dataDir>/<name>.json when present, else config/<name>.example.json,
// else the fallback the caller passes in.
function loadConfig(name, opts = {}) {
  if (!CONFIG_NAMES.includes(name)) throw new Error(`Unknown config: ${name}`);
  const candidates = [path.join(resolveDataDir(opts), `${name}.json`), path.join(ENGINE_ROOT, "config", `${name}.example.json`)];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      return { config: JSON.parse(fs.readFileSync(file, "utf8")), source: file, error: null };
    } catch (err) {
      return { config: opts.fallback || null, source: file, error: `Could not parse ${path.basename(file)}: ${err.message}` };
    }
  }
  return { config: opts.fallback || null, source: null, error: null };
}

module.exports = {
  SUBDIRS,
  resolveDataDir,
  ensureDataDir,
  slugify,
  makeId,
  isValidId,
  saveDraft,
  loadDraft,
  getDraft,
  listDrafts,
  exportDir,
  recordExport,
  getExport,
  listExports,
  appendPublishLog,
  readPublishLog,
  appendLog,
  readLog,
  loadConfig,
};
