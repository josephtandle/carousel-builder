"use strict";

// What may be published: only slides that sit inside the data dir, are listed
// in an export manifest (export.json) in their own folder, and passed the
// layout check. Everything here fails closed and runs before any file is
// decoded, converted or sent.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = "export.json";
const MAX_SLIDES = 100;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CAPTION_BYTES = 64 * 1024;

function no(reason) {
  return { ok: false, reason };
}

function dataRoot(dataDir) {
  const resolved = require("../store.js").resolveDataDir(dataDir ? { dataDir } : undefined);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return null;
  }
}

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// A regular file (never a symlink) whose real location is inside root and
// whose size is within the cap. Returns { ok, real, size } or { ok: false, reason }.
function regularFileInside(file, root, maxBytes, what, hint = "") {
  const name = path.basename(String(file));
  let link;
  try {
    link = fs.lstatSync(file);
  } catch {
    return no(`${what} not found: ${name}.`);
  }
  if (link.isSymbolicLink()) return no(`${what} ${name} is a symlink. Only regular files are published.`);
  if (!link.isFile()) return no(`${what} ${name} is not a regular file.`);
  if (link.size > maxBytes) return no(`${what} ${name} is larger than the ${Math.round(maxBytes / (1024 * 1024)) || 1} MB limit.`);
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return no(`${what} not found: ${name}.`);
  }
  if (!isInside(root, real)) return no(`${what} ${name} is outside the data dir.${hint ? ` ${hint}` : ""}`);
  return { ok: true, real, size: link.size };
}

// A manifest entry must be a plain relative path that stays in the export folder.
function safeRelative(entry) {
  if (typeof entry !== "string" || !entry.trim()) return false;
  if (path.isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry) || entry.includes("\0")) return false;
  return !entry.split(/[\\/]+/).some((part) => part === "..");
}

// readManifest(dir, root) -> { ok, manifest, files: [absolute], pdf: absolute | null }
function readManifest(dir, root) {
  const file = path.join(dir, MANIFEST);
  const checked = regularFileInside(file, root, MAX_MANIFEST_BYTES, "Export manifest");
  if (!checked.ok) return no(`There is no usable ${MANIFEST} in ${path.basename(dir)}, so there is no layout check on record for these slides. Render the deck with the engine (without a custom folder outside the data dir) and publish that export.`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return no(`${MANIFEST} in ${path.basename(dir)} is not valid JSON, so the layout check cannot be confirmed. Render the deck again.`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return no(`${MANIFEST} in ${path.basename(dir)} is not a manifest. Render the deck again.`);
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  if (entries.length === 0) return no(`${MANIFEST} in ${path.basename(dir)} lists no slides. Render the deck again.`);
  for (const entry of entries) {
    if (!safeRelative(entry)) return no(`${MANIFEST} lists a slide outside its own folder (${JSON.stringify(String(entry)).slice(0, 80)}). Absolute paths and ".." are not allowed: render the deck again without a custom output folder.`);
  }
  if (manifest.pdf !== null && manifest.pdf !== undefined && !safeRelative(manifest.pdf)) {
    return no(`${MANIFEST} points its PDF outside its own folder. Absolute paths and ".." are not allowed: render the deck again.`);
  }
  if (!manifest.qa || manifest.qa.ok !== true) {
    const issues = manifest.qa && Array.isArray(manifest.qa.issues) ? manifest.qa.issues.map((i) => (typeof i === "string" ? i : JSON.stringify(i))) : [];
    return { ok: false, qaFailed: true, qaIssues: issues, reason: `This export did not pass the layout check, so it will not be published${issues.length ? `: ${issues.slice(0, 5).join("; ")}` : " (no passing check is on record)"}. Fix the deck and render it again.` };
  }
  return { ok: true, manifest, files: entries.map((entry) => path.join(dir, entry)), pdf: manifest.pdf ? path.join(dir, manifest.pdf) : null };
}

// inspect(files, pdf, { dataDir }) -> { ok, files: [real paths], pdf, dir, manifest } or { ok: false, reason }
function inspect(files, pdf, opts = {}) {
  const root = dataRoot(opts.dataDir);
  if (!root) return no("The data dir does not exist yet, so there is nothing to publish.");
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return no("There are no slides to publish.");
  if (list.length > MAX_SLIDES) return no(`This export has ${list.length} slides. At most ${MAX_SLIDES} can be published.`);

  const real = [];
  for (const file of list) {
    if (!/\.(png|jpe?g)$/i.test(String(file))) return no(`Slide ${path.basename(String(file))} is not a PNG or JPEG.`);
    const checked = regularFileInside(file, root, MAX_IMAGE_BYTES, "Slide", "Only exports inside the data dir can be published.");
    if (!checked.ok) return checked;
    real.push(checked.real);
  }
  const dir = path.dirname(real[0]);
  if (!real.every((file) => path.dirname(file) === dir)) return no("The slides are not all in one export folder.");

  const manifest = readManifest(dir, root);
  if (!manifest.ok) return manifest;
  const listed = new Set();
  for (const entry of manifest.files) {
    try {
      listed.add(fs.realpathSync(entry));
    } catch {
      // A listed slide that is gone cannot be one of the files being published.
    }
  }
  const stray = real.find((file) => !listed.has(file));
  if (stray) return no(`Slide ${path.basename(stray)} is not part of this export (it is not listed in ${MANIFEST}), so it has no layout check on record.`);

  let realPdf = null;
  if (pdf) {
    if (!/\.pdf$/i.test(String(pdf))) return no("The document to publish must be a PDF.");
    const checked = regularFileInside(pdf, root, MAX_PDF_BYTES, "PDF", "Only exports inside the data dir can be published.");
    if (!checked.ok) return checked;
    if (path.dirname(checked.real) !== dir) return no("The PDF is not in the same export folder as the slides.");
    realPdf = checked.real;
  }
  return { ok: true, files: real, pdf: realPdf, dir, manifest: manifest.manifest, root };
}

// Reads a caption file: a small regular file inside the data dir, nothing else.
function readCaptionFile(file, opts = {}) {
  const root = dataRoot(opts.dataDir);
  if (!root) return no("The data dir does not exist yet.");
  const checked = regularFileInside(path.resolve(String(file)), root, MAX_CAPTION_BYTES, "Caption file");
  if (!checked.ok) return checked;
  return { ok: true, caption: fs.readFileSync(checked.real, "utf8") };
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// The confirmation token: a hash of exactly what a dry run described. The
// slides (path and bytes), the PDF, the caption, the title and the targets.
// Change any of them and the token from the earlier dry run no longer fits.
function confirmToken({ files, pdf, caption, title, targets }) {
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify({
      v: 1,
      files: (files || []).map((file) => [file, sha(file)]),
      pdf: pdf ? [pdf, sha(pdf)] : null,
      caption: String(caption || ""),
      title: String(title || ""),
      targets: [...new Set(targets || [])].sort(),
    })
  );
  return hash.digest("hex").slice(0, 24);
}

module.exports = { MANIFEST, MAX_SLIDES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_CAPTION_BYTES, inspect, readManifest, readCaptionFile, regularFileInside, safeRelative, isInside, dataRoot, confirmToken };
