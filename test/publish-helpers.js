"use strict";

// Shared helpers for the store, pdf, publish and cli tests: temp dirs, tiny
// PNGs built with zlib, and a scripted fetch that records every call. No test
// in this suite touches the network.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

function tmpDir(prefix = "carousel-test-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// makePng({ width, height, channels: 3 | 4, filter: 0..4, pixel(x, y) -> [r, g, b, a?], bitDepth, interlace })
function makePng({ width, height, channels = 4, filter = 0, pixel = () => [0, 0, 0, 255], bitDepth = 8, interlace = 0 }) {
  const stride = width * channels;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = pixel(x, y);
      for (let c = 0; c < channels; c += 1) raw[y * stride + x * channels + c] = p[c] === undefined ? 255 : p[c];
    }
  }
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[y * stride + x];
      const left = x >= channels ? raw[y * stride + x - channels] : 0;
      const up = y > 0 ? raw[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? raw[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      filtered[y * (stride + 1) + 1 + x] = (cur - predictor) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[12] = interlace;
  const idat = zlib.deflateSync(filtered);
  // Two IDAT chunks, to prove the decoder joins them.
  const cut = Math.max(1, Math.floor(idat.length / 2));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat.subarray(0, cut)),
    chunk("IDAT", idat.subarray(cut)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Writes n small slide PNGs into dir and returns their paths in order.
function writeSlides(dir, n, { width = 40, height = 50 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < n; i += 1) {
    const file = path.join(dir, `slide-${String(i + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(file, makePng({ width, height, channels: 4, filter: i % 5, pixel: (x, y) => [(x * 6 + i * 20) & 255, (y * 5) & 255, 120, 255] }));
    files.push(file);
  }
  return files;
}

// Slides plus the export.json manifest the publisher requires: plain relative
// file names and a passed layout check (override with qa).
function writeExport(dir, n, { size, qa = { ok: true, issues: [] }, manifest = {} } = {}) {
  const files = writeSlides(dir, n, size);
  fs.writeFileSync(path.join(dir, "export.json"), JSON.stringify({ id: path.basename(dir), files: files.map((f) => path.basename(f)), pdf: null, qa, ...manifest }));
  return files;
}

// A PNG whose header and image data are set independently, for hostile files.
function rawPng({ width, height, data, bitDepth = 8, colorType = 6 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(data)), chunk("IEND", Buffer.alloc(0))]);
}

function response(status, body, headers = {}) {
  const text = body === undefined || body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] || null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// mockFetch(handler) -> fetchImpl with .calls. handler(call, index) returns a
// response(...) or nothing (which answers 200 {}).
function mockFetch(handler = () => undefined) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: String(init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body, redirect: init.redirect };
    if (typeof init.body === "string") {
      try {
        call.json = JSON.parse(init.body);
      } catch {
        call.json = null;
      }
    }
    calls.push(call);
    const out = await handler(call, calls.length - 1);
    return out || response(200, {});
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const noSleep = async () => {};

// The two-step flow every real caller uses: a dry run (which must not touch
// the network), then the confirmed publish carrying that dry run's token.
async function goLive(publish, req, opts) {
  const silent = async () => {
    throw new Error("a dry run must not use the network");
  };
  const plan = await publish({ ...req, dryRun: true }, { ...opts, fetchImpl: silent });
  const token = (plan.find((r) => r.confirmToken) || {}).confirmToken;
  return publish({ ...req, confirm: "PUBLISH", confirmToken: token }, opts);
}

module.exports = { tmpDir, makePng, rawPng, writeSlides, writeExport, response, mockFetch, noSleep, goLive, crc32 };
