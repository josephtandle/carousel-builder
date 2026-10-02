"use strict";

// Turns local export files into public URLs for the platforms that only pull
// media from the web (Instagram and TikTok). Nothing is uploaded here: with
// kind "url-prefix" you sync your exports dir to a host you control and this
// module works out the URL each file will have there.

const fs = require("node:fs");
const path = require("node:path");
const { request, header } = require("./http.js");

const KINDS = ["none", "url-prefix"];

function hostConfig(config) {
  const mediaHost = (config && config.mediaHost) || {};
  return { kind: mediaHost.kind || "none", urlPrefix: String(mediaHost.urlPrefix || "").trim().replace(/\/+$/, "") };
}

// check({ config }) -> { ok, kind, reason }
function check(ctx = {}) {
  const { kind, urlPrefix } = hostConfig(ctx.config);
  if (!KINDS.includes(kind)) return { ok: false, kind, reason: `Unknown mediaHost.kind "${kind}" in publishers.json. Use "none" or "url-prefix".` };
  if (kind === "none") {
    return { ok: false, kind, reason: 'No media host is configured, so there are no public image URLs to hand over. Set mediaHost.kind to "url-prefix" and mediaHost.urlPrefix to the https address your exports dir is synced to.' };
  }
  if (!/^https:\/\/[^\s/]+/i.test(urlPrefix)) return { ok: false, kind, reason: "mediaHost.urlPrefix must be a public https:// address." };
  return { ok: true, kind, reason: `Public URLs come from ${urlPrefix}/<file>.` };
}

function exportsRoot(dataDir) {
  if (!dataDir) return null;
  try {
    return fs.realpathSync(path.join(dataDir, "exports"));
  } catch {
    return path.resolve(dataDir, "exports");
  }
}

// Path of a file under the exports dir (so "<id>/slide-01.png"), or just the
// file name when it lives somewhere else.
function relativeName(file, dataDir) {
  let abs = path.resolve(String(file));
  try {
    abs = fs.realpathSync(abs);
  } catch {
    // The file may not exist yet in a dry run: use the resolved path.
  }
  const root = exportsRoot(dataDir);
  if (root && abs.startsWith(root + path.sep)) return path.relative(root, abs).split(path.sep).join("/");
  return path.basename(abs);
}

function urlFor(file, ctx = {}) {
  const { urlPrefix } = hostConfig(ctx.config);
  const rel = relativeName(file, ctx.dataDir).split("/").map(encodeURIComponent).join("/");
  return `${urlPrefix}/${rel}`;
}

// JPEG copies live next to the PNGs in <dir>/jpeg/<name>.jpg and are rebuilt
// only when the PNG is newer.
function jpegPathFor(file) {
  const abs = path.resolve(String(file));
  return path.join(path.dirname(abs), "jpeg", `${path.basename(abs).replace(/\.png$/i, "")}.jpg`);
}

// Returns { path, written }. "written" is true when the JPEG had to be built
// or rebuilt, which means the copy on the media host is missing or out of date.
function ensureJpeg(file, quality) {
  const abs = path.resolve(String(file));
  if (/\.jpe?g$/i.test(abs)) return { path: abs, written: false };
  const out = jpegPathFor(abs);
  const dir = path.dirname(out);
  fs.mkdirSync(dir, { recursive: true });
  // The jpeg folder and the copy must be a real folder and a real file: a
  // symlink planted there could redirect the write somewhere else.
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("the jpeg folder is a symlink");
  let existing = null;
  try {
    existing = fs.lstatSync(out);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile()) throw new Error("the JPEG copy is not a regular file");
  const fresh = Boolean(existing) && existing.mtimeMs >= fs.statSync(abs).mtimeMs && existing.size > 0;
  if (!fresh) require("./jpeg.js").pngToJpeg(abs, out, { quality });
  return { path: out, written: !fresh };
}

// resolve(files, { config, dataDir, imageFormat, jpegQuality, prepare })
// -> { ok, reason, items: [ { file, upload, url, written } ], rebuilt: [names] }
// "upload" is the local file that must be reachable at "url". With prepare
// false nothing is written to disk (the JPEG path is only computed).
// "rebuilt" names the JPEG copies this call had to write.
function resolve(files, ctx = {}) {
  const state = check(ctx);
  if (!state.ok) return { ok: false, reason: state.reason, items: [], rebuilt: [] };
  const wantJpeg = (ctx.imageFormat || "png") === "jpeg";
  const items = [];
  const rebuilt = [];
  for (const file of files || []) {
    let upload = path.resolve(String(file));
    let written = false;
    if (wantJpeg) {
      try {
        if (ctx.prepare === false) upload = /\.jpe?g$/i.test(upload) ? upload : jpegPathFor(upload);
        else ({ path: upload, written } = ensureJpeg(upload, ctx.jpegQuality));
      } catch (err) {
        return { ok: false, reason: `Could not make a JPEG copy of ${path.basename(String(file))}: ${err.message}`, items: [], rebuilt: [] };
      }
    }
    if (written) rebuilt.push(path.basename(upload));
    items.push({ file: path.resolve(String(file)), upload, url: urlFor(upload, ctx), written });
  }
  return { ok: true, reason: state.reason, items, rebuilt };
}

function remoteSize(res, ranged) {
  if (ranged) {
    const total = /\/(\d+)\s*$/.exec(header(res, "content-range"));
    return total ? Number(total[1]) : null;
  }
  const length = header(res, "content-length");
  return /^\d+$/.test(String(length).trim()) ? Number(length) : null;
}

// Confirms every URL answers before a platform is asked to pull it, so a
// forgotten sync fails here and not halfway through a post. With ctx.sizes
// (local byte sizes, same order as urls) it also catches a stale copy: a file
// on the host whose size differs from the local one is an old render.
// These requests carry no credentials.
async function verifyReachable(urls, ctx = {}) {
  const failures = [];
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    let ranged = false;
    let res = await request(ctx.fetchImpl, url, { method: "HEAD", timeoutMs: ctx.timeoutMs || 20000 });
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      ranged = true;
      res = await request(ctx.fetchImpl, url, { method: "GET", headers: { Range: "bytes=0-0" }, timeoutMs: ctx.timeoutMs || 20000 });
    }
    if (!res.ok) {
      failures.push({ url, status: res.status, error: res.error });
      continue;
    }
    const local = Array.isArray(ctx.sizes) ? ctx.sizes[i] : null;
    const remote = remoteSize(res, ranged);
    if (Number.isInteger(local) && remote !== null && remote !== local) failures.push({ url, status: res.status, error: `the copy on the host is ${remote} bytes and the local file is ${local} bytes, so the host has an older version`, stale: true });
  }
  return { ok: failures.length === 0, failures };
}

function unreachableDetail(failures) {
  const first = failures[0];
  if (failures.every((f) => f.stale)) return `${failures.length} public URL(s) hold an older version of the slide (first: ${first.url}, ${first.error}). Sync the exports dir to your media host, then retry. Nothing was sent to the platform.`;
  return `${failures.length} public URL(s) did not answer (first: ${first.url}, ${first.error || `HTTP ${first.status}`}). Sync the exports dir to your media host, then try again. Nothing was sent to the platform.`;
}

function localSizes(files) {
  return files.map((file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  });
}

// One call for the adapters that pull from public URLs: stop when a JPEG copy
// was only just (re)built, then check each URL answers with the current file.
// Returns null when all is well, or an error result.
async function staleOrUnreachable(media, ctx = {}) {
  if (media.rebuilt && media.rebuilt.length) {
    return { status: "error", detail: `${media.rebuilt.length} JPEG ${media.rebuilt.length === 1 ? "copy was" : "copies were"} only just built or rebuilt (${media.rebuilt.slice(0, 3).join(", ")}${media.rebuilt.length > 3 ? ", ..." : ""}), so your media host does not have the current slides yet. Sync the exports dir, then retry. Nothing was sent to the platform.`, url: null };
  }
  if (ctx.verify === false) return null;
  const reach = await verifyReachable(media.items.map((item) => item.url), { fetchImpl: ctx.fetchImpl, sizes: localSizes(media.items.map((item) => item.upload)) });
  return reach.ok ? null : { status: "error", detail: unreachableDetail(reach.failures), url: null };
}

module.exports = { KINDS, check, resolve, urlFor, jpegPathFor, verifyReachable, unreachableDetail, staleOrUnreachable };
