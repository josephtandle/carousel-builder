"use strict";

// PNG pages to one PDF, in pure Node. Each PNG is decoded (zlib inflate plus
// scanline filter reconstruction), flattened against white, and embedded as a
// Flate-compressed RGB image XObject on a page sized to the image at 72 dpi
// (one pixel is one point).

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Limits checked before anything is decoded, so a crafted file cannot exhaust
// memory or block the process.
const MAX_SIDE = 8192;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 300;

function pngError(message, label) {
  const err = new Error(label ? `${label}: ${message}` : message);
  err.code = "PNG_UNSUPPORTED";
  return err;
}

function readChunks(buf, label) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw pngError("not a PNG file", label);
  const out = { ihdr: null, palette: null, trns: null, idat: [] };
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + length;
    if (end > buf.length) throw pngError("truncated PNG chunk", label);
    const data = buf.subarray(start, end);
    if (type === "IHDR") out.ihdr = data;
    else if (type === "PLTE") out.palette = data;
    else if (type === "tRNS") out.trns = data;
    else if (type === "IDAT") out.idat.push(data);
    else if (type === "IEND") break;
    pos = end + 4;
  }
  if (!out.ihdr || out.ihdr.length < 13) throw pngError("missing IHDR", label);
  return out;
}

function parseHeader(ihdr) {
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    interlace: ihdr[12],
  };
}

function readPngFile(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_FILE_BYTES) throw pngError("file is larger than the 64 MB limit", "");
    return input;
  }
  const label = path.basename(String(input));
  const stat = fs.statSync(input);
  if (!stat.isFile()) throw pngError("not a regular file", label);
  if (stat.size > MAX_FILE_BYTES) throw pngError("file is larger than the 64 MB limit", label);
  return fs.readFileSync(input);
}

function pngSize(input) {
  const buf = readPngFile(input);
  const { width, height } = parseHeader(readChunks(buf, Buffer.isBuffer(input) ? "" : path.basename(String(input))).ihdr);
  return { width, height };
}

function unfilter(raw, width, height, bpp, label) {
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw pngError("image data is shorter than the header says", label);
  const out = Buffer.allocUnsafe(stride * height);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = y * stride;
    const prev = row - stride;
    switch (filter) {
      case 0:
        raw.copy(out, row, src, src + stride);
        break;
      case 1:
        for (let x = 0; x < stride; x += 1) {
          const left = x >= bpp ? out[row + x - bpp] : 0;
          out[row + x] = (raw[src + x] + left) & 255;
        }
        break;
      case 2:
        for (let x = 0; x < stride; x += 1) {
          const up = y > 0 ? out[prev + x] : 0;
          out[row + x] = (raw[src + x] + up) & 255;
        }
        break;
      case 3:
        for (let x = 0; x < stride; x += 1) {
          const left = x >= bpp ? out[row + x - bpp] : 0;
          const up = y > 0 ? out[prev + x] : 0;
          out[row + x] = (raw[src + x] + ((left + up) >> 1)) & 255;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x += 1) {
          const left = x >= bpp ? out[row + x - bpp] : 0;
          const up = y > 0 ? out[prev + x] : 0;
          const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          out[row + x] = (raw[src + x] + predictor) & 255;
        }
        break;
      default:
        throw pngError(`unknown scanline filter ${filter}`, label);
    }
    src += stride;
  }
  return out;
}

function overWhite(value, alpha) {
  return alpha === 255 ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255);
}

// Decodes an 8-bit, non-interlaced PNG to packed RGB with alpha dropped
// against white. Returns { width, height, rgb }.
function decodePng(input, label = "") {
  const buf = readPngFile(input);
  const name = label || (Buffer.isBuffer(input) ? "" : path.basename(String(input)));
  const chunks = readChunks(buf, name);
  const { width, height, bitDepth, colorType, interlace } = parseHeader(chunks.ihdr);
  if (!width || !height) throw pngError("empty image", name);
  if (width > MAX_SIDE || height > MAX_SIDE) throw pngError(`image is ${width}x${height}, larger than the ${MAX_SIDE} pixel limit per side`, name);
  if (bitDepth !== 8) throw pngError(`only 8-bit PNGs are supported (this one is ${bitDepth}-bit)`, name);
  if (!(colorType in CHANNELS)) throw pngError(`unknown colour type ${colorType}`, name);
  if (interlace !== 0) throw pngError("interlaced PNGs are not supported", name);
  if (colorType === 3 && !chunks.palette) throw pngError("palette image without a palette", name);
  if (chunks.idat.length === 0) throw pngError("no image data", name);

  const bpp = CHANNELS[colorType];
  let raw;
  try {
    // The header says exactly how many bytes the image data inflates to.
    raw = zlib.inflateSync(Buffer.concat(chunks.idat), { maxOutputLength: (width * bpp + 1) * height });
  } catch (err) {
    if (err && err.code === "ERR_BUFFER_TOO_LARGE") throw pngError("image data is larger than the header says", name);
    throw pngError(`image data could not be read (${String(err && err.message).split("\n")[0]})`, name);
  }
  const pixels = unfilter(raw, width, height, bpp, name);
  const count = width * height;
  if (colorType === 2) return { width, height, rgb: pixels };

  const rgb = Buffer.allocUnsafe(count * 3);
  for (let i = 0, s = 0, d = 0; i < count; i += 1, s += bpp, d += 3) {
    if (colorType === 6) {
      const a = pixels[s + 3];
      rgb[d] = overWhite(pixels[s], a);
      rgb[d + 1] = overWhite(pixels[s + 1], a);
      rgb[d + 2] = overWhite(pixels[s + 2], a);
    } else if (colorType === 0) {
      rgb[d] = rgb[d + 1] = rgb[d + 2] = pixels[s];
    } else if (colorType === 4) {
      rgb[d] = rgb[d + 1] = rgb[d + 2] = overWhite(pixels[s], pixels[s + 1]);
    } else {
      const index = pixels[s];
      const p = index * 3;
      const a = chunks.trns && index < chunks.trns.length ? chunks.trns[index] : 255;
      rgb[d] = overWhite(chunks.palette[p] || 0, a);
      rgb[d + 1] = overWhite(chunks.palette[p + 1] || 0, a);
      rgb[d + 2] = overWhite(chunks.palette[p + 2] || 0, a);
    }
  }
  return { width, height, rgb };
}

function pdfString(text) {
  const clean = String(text).replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  return `(${clean})`;
}

function pdfDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

// pngsToPdf(files, outPath, { title }) -> Promise<outPath>
async function pngsToPdf(files, outPath, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new TypeError("pngsToPdf needs at least one PNG.");
  if (files.length > MAX_PAGES) throw new RangeError(`pngsToPdf takes at most ${MAX_PAGES} pages.`);
  if (!outPath) throw new TypeError("pngsToPdf needs an output path.");
  const out = path.resolve(String(outPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  const offsets = [];
  let position = 0;
  const write = (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
    fs.writeSync(fd, data);
    position += data.length;
  };
  const beginObject = (number) => {
    offsets[number] = position;
    write(`${number} 0 obj\n`);
  };

  try {
    const pageCount = files.length;
    const pageNumber = (i) => 3 + i * 3;
    const infoNumber = 3 + pageCount * 3;
    write("%PDF-1.4\n");
    write(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    beginObject(1);
    write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    beginObject(2);
    write(`<< /Type /Pages /Count ${pageCount} /Kids [${files.map((_, i) => `${pageNumber(i)} 0 R`).join(" ")}] >>\nendobj\n`);

    for (let i = 0; i < pageCount; i += 1) {
      const { width, height, rgb } = decodePng(files[i]);
      const image = zlib.deflateSync(rgb, { level: 6 });
      const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
      const base = pageNumber(i);
      beginObject(base);
      write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>\nendobj\n`);
      beginObject(base + 1);
      write(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
      beginObject(base + 2);
      write(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`);
      write(image);
      write("\nendstream\nendobj\n");
      // Let the event loop breathe between pages: a slide is a few megabytes of pixels.
      await new Promise((resolve) => setImmediate(resolve));
    }

    beginObject(infoNumber);
    write(`<< /Producer (carousel-builder) /CreationDate (${pdfDate(opts.now instanceof Date ? opts.now : new Date())})${opts.title ? ` /Title ${pdfString(opts.title)}` : ""} >>\nendobj\n`);

    const xrefAt = position;
    const total = infoNumber + 1;
    write(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let n = 1; n < total; n += 1) write(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    write(`trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoNumber} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    fs.closeSync(fd);
    fs.renameSync(tmp, out);
    return out;
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { pngsToPdf, decodePng, pngSize, MAX_SIDE, MAX_FILE_BYTES, MAX_PAGES };
