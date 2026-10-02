"use strict";

// Baseline JPEG encoder in pure Node (no chroma subsampling, standard Huffman
// tables). Instagram and TikTok only accept JPEG from a public URL while the
// renderer writes PNG, so the publishers convert a copy before upload.

const fs = require("node:fs");
const path = require("node:path");

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];
// Zigzag position -> natural (row-major) index.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const DC_LUMA = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  values: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  values: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

function huffmanCodes(spec) {
  const codes = new Array(256);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < spec.counts[length - 1]; i += 1) {
      codes[spec.values[k]] = { code, length };
      k += 1;
      code += 1;
    }
    code <<= 1;
  }
  return codes;
}

function scaledTable(base, quality) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

const COS = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    const c = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x += 1) table[u * 8 + x] = 0.5 * c * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return table;
})();

function fdct(block, tmp) {
  for (let y = 0; y < 8; y += 1) {
    const r = y * 8;
    for (let u = 0; u < 8; u += 1) {
      const c = u * 8;
      tmp[r + u] =
        block[r] * COS[c] + block[r + 1] * COS[c + 1] + block[r + 2] * COS[c + 2] + block[r + 3] * COS[c + 3] +
        block[r + 4] * COS[c + 4] + block[r + 5] * COS[c + 5] + block[r + 6] * COS[c + 6] + block[r + 7] * COS[c + 7];
    }
  }
  for (let x = 0; x < 8; x += 1) {
    for (let v = 0; v < 8; v += 1) {
      const c = v * 8;
      block[v * 8 + x] =
        tmp[x] * COS[c] + tmp[8 + x] * COS[c + 1] + tmp[16 + x] * COS[c + 2] + tmp[24 + x] * COS[c + 3] +
        tmp[32 + x] * COS[c + 4] + tmp[40 + x] * COS[c + 5] + tmp[48 + x] * COS[c + 6] + tmp[56 + x] * COS[c + 7];
    }
  }
}

class ByteSink {
  constructor(size) {
    this.buf = Buffer.allocUnsafe(Math.max(1024, size));
    this.length = 0;
    this.bits = 0;
    this.bitCount = 0;
  }

  byte(b) {
    if (this.length === this.buf.length) {
      const next = Buffer.allocUnsafe(this.buf.length * 2);
      this.buf.copy(next, 0, 0, this.length);
      this.buf = next;
    }
    this.buf[this.length] = b;
    this.length += 1;
  }

  word(w) {
    this.byte((w >> 8) & 255);
    this.byte(w & 255);
  }

  bytes(list) {
    for (const b of list) this.byte(b);
  }

  // Entropy-coded bits, with 0xFF byte stuffing.
  writeBits(code, length) {
    this.bits = (this.bits << length) | code;
    this.bitCount += length;
    while (this.bitCount >= 8) {
      const b = (this.bits >>> (this.bitCount - 8)) & 255;
      this.byte(b);
      if (b === 255) this.byte(0);
      this.bitCount -= 8;
    }
    this.bits &= (1 << this.bitCount) - 1;
  }

  flushBits() {
    if (this.bitCount > 0) this.writeBits((1 << (8 - this.bitCount)) - 1, 8 - this.bitCount);
  }

  result() {
    return this.buf.subarray(0, this.length);
  }
}

function category(value) {
  let v = value < 0 ? -value : value;
  let bits = 0;
  while (v) {
    bits += 1;
    v >>= 1;
  }
  return bits;
}

function writeDht(sink, tableClass, id, spec) {
  sink.byte((tableClass << 4) | id);
  sink.bytes(spec.counts);
  sink.bytes(spec.values);
}

// encodeJpeg({ width, height, rgb }, { quality }) -> Buffer
function encodeJpeg(image, opts = {}) {
  const { width, height, rgb } = image;
  if (!width || !height || !rgb || rgb.length < width * height * 3) throw new TypeError("encodeJpeg needs { width, height, rgb }.");
  if (width > 8192 || height > 8192) throw new RangeError("Image is larger than the 8192 pixel limit per side.");
  const quality = opts.quality === undefined ? 90 : opts.quality;
  const tables = [scaledTable(LUMA_Q, quality), scaledTable(CHROMA_Q, quality)];
  const dc = [huffmanCodes(DC_LUMA), huffmanCodes(DC_CHROMA)];
  const ac = [huffmanCodes(AC_LUMA), huffmanCodes(AC_CHROMA)];
  const sink = new ByteSink(Math.floor((width * height) / 2));

  sink.word(0xffd8);
  sink.word(0xffe0);
  sink.word(16);
  sink.bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 1]);
  sink.word(72);
  sink.word(72);
  sink.bytes([0, 0]);
  for (let t = 0; t < 2; t += 1) {
    sink.word(0xffdb);
    sink.word(67);
    sink.byte(t);
    for (let k = 0; k < 64; k += 1) sink.byte(tables[t][ZIGZAG[k]]);
  }
  sink.word(0xffc0);
  sink.word(17);
  sink.byte(8);
  sink.word(height);
  sink.word(width);
  sink.byte(3);
  sink.bytes([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sink.word(0xffc4);
  sink.word(2 + 4 * 17 + DC_LUMA.values.length + DC_CHROMA.values.length + AC_LUMA.values.length + AC_CHROMA.values.length);
  writeDht(sink, 0, 0, DC_LUMA);
  writeDht(sink, 1, 0, AC_LUMA);
  writeDht(sink, 0, 1, DC_CHROMA);
  writeDht(sink, 1, 1, AC_CHROMA);
  sink.word(0xffda);
  sink.word(12);
  sink.byte(3);
  sink.bytes([1, 0x00, 2, 0x11, 3, 0x11]);
  sink.bytes([0, 63, 0]);

  const blocks = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  const tmp = new Float64Array(64);
  const quantized = new Int32Array(64);
  const previousDc = [0, 0, 0];

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y += 1) {
        const py = Math.min(height - 1, by + y);
        for (let x = 0; x < 8; x += 1) {
          const px = Math.min(width - 1, bx + x);
          const p = (py * width + px) * 3;
          const r = rgb[p];
          const g = rgb[p + 1];
          const b = rgb[p + 2];
          const i = y * 8 + x;
          blocks[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          blocks[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          blocks[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      for (let c = 0; c < 3; c += 1) {
        const t = c === 0 ? 0 : 1;
        fdct(blocks[c], tmp);
        for (let k = 0; k < 64; k += 1) {
          const n = ZIGZAG[k];
          quantized[k] = Math.round(blocks[c][n] / tables[t][n]);
        }
        const diff = quantized[0] - previousDc[c];
        previousDc[c] = quantized[0];
        const size = category(diff);
        sink.writeBits(dc[t][size].code, dc[t][size].length);
        if (size) sink.writeBits(diff < 0 ? diff + (1 << size) - 1 : diff, size);

        let last = 63;
        while (last > 0 && quantized[last] === 0) last -= 1;
        let run = 0;
        for (let k = 1; k <= last; k += 1) {
          const value = quantized[k];
          if (value === 0) {
            run += 1;
            continue;
          }
          while (run > 15) {
            sink.writeBits(ac[t][0xf0].code, ac[t][0xf0].length);
            run -= 16;
          }
          const bits = category(value);
          const symbol = ac[t][(run << 4) | bits];
          sink.writeBits(symbol.code, symbol.length);
          sink.writeBits(value < 0 ? value + (1 << bits) - 1 : value, bits);
          run = 0;
        }
        if (last < 63) sink.writeBits(ac[t][0x00].code, ac[t][0x00].length);
      }
    }
  }
  sink.flushBits();
  sink.word(0xffd9);
  return Buffer.from(sink.result());
}

// Reads the frame size back out of a JPEG (used by tests and sanity checks).
function jpegSize(buf) {
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    const length = buf.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    pos += 2 + length;
  }
  return null;
}

// pngToJpeg(pngPath, jpgPath, { quality }) -> jpgPath. Alpha is flattened on white.
function pngToJpeg(pngPath, jpgPath, opts = {}) {
  const { decodePng } = require("../pdf.js");
  const data = encodeJpeg(decodePng(pngPath), opts);
  fs.mkdirSync(path.dirname(jpgPath), { recursive: true });
  const tmp = `${jpgPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, jpgPath);
  return jpgPath;
}

module.exports = { encodeJpeg, pngToJpeg, jpegSize };
