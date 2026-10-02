"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { pngsToPdf, decodePng, pngSize } = require("../lib/pdf.js");
const { tmpDir, makePng } = require("./publish-helpers.js");

const colour = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y * 7 + 13) & 255, 255];

function expectedRgb(width, height, pixel) {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y);
      const over = (v) => Math.round((v * a + 255 * (255 - a)) / 255);
      out.set([over(r), over(g), over(b)], (y * width + x) * 3);
    }
  }
  return out;
}

test("decodePng reverses every scanline filter for RGB and RGBA", () => {
  for (const channels of [3, 4]) {
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = makePng({ width: 13, height: 9, channels, filter, pixel: colour });
      const decoded = decodePng(png);
      assert.equal(decoded.width, 13);
      assert.equal(decoded.height, 9);
      assert.ok(decoded.rgb.equals(expectedRgb(13, 9, colour)), `channels ${channels}, filter ${filter}`);
    }
  }
});

test("alpha is dropped against white", () => {
  const pixel = (x) => (x === 0 ? [255, 0, 0, 0] : x === 1 ? [0, 0, 0, 128] : [10, 20, 30, 255]);
  const decoded = decodePng(makePng({ width: 3, height: 1, channels: 4, filter: 4, pixel }));
  assert.deepEqual([...decoded.rgb], [255, 255, 255, 127, 127, 127, 10, 20, 30]);
});

test("unsupported or broken PNGs fail with a clear error", () => {
  assert.throws(() => decodePng(Buffer.from("definitely not a png, just some text padding here")), /not a PNG/);
  assert.throws(() => decodePng(makePng({ width: 2, height: 2, bitDepth: 16 })), /8-bit/);
  assert.throws(() => decodePng(makePng({ width: 2, height: 2, interlace: 1 })), /interlaced/);
  assert.deepEqual(pngSize(makePng({ width: 21, height: 34 })), { width: 21, height: 34 });
});

function parsePdf(buf) {
  const text = buf.toString("latin1");
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  const xrefHead = /^xref\n0 (\d+)\n/.exec(text.slice(startxref));
  const total = Number(xrefHead[1]);
  const rows = text.slice(startxref + xrefHead[0].length, startxref + xrefHead[0].length + total * 20);
  const offsets = [];
  for (let n = 0; n < total; n += 1) offsets.push({ offset: Number(rows.slice(n * 20, n * 20 + 10)), flag: rows.slice(n * 20 + 17, n * 20 + 18), line: rows.slice(n * 20, n * 20 + 20) });
  return { text, startxref, total, offsets };
}

test("pngsToPdf writes a valid PDF with one page per PNG sized to the image", async () => {
  const dir = tmpDir();
  const specs = [
    { width: 24, height: 30, channels: 4, filter: 4 },
    { width: 24, height: 30, channels: 3, filter: 1 },
    { width: 32, height: 18, channels: 4, filter: 3 },
  ];
  const files = specs.map((spec, i) => {
    const file = path.join(dir, `slide-${i + 1}.png`);
    fs.writeFileSync(file, makePng({ ...spec, pixel: colour }));
    return file;
  });
  const out = path.join(dir, "nested", "deck.pdf");
  const returned = await pngsToPdf(files, out, { title: "A (test) deck" });
  assert.equal(returned, out);
  const buf = fs.readFileSync(out);
  const { text, startxref, total, offsets } = parsePdf(buf);

  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.endsWith("%%EOF\n"));
  assert.equal(text.slice(startxref, startxref + 5), "xref\n");
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 3, "three page objects");
  assert.match(text, /\/Type \/Pages \/Count 3 \/Kids \[3 0 R 6 0 R 9 0 R\]/);
  assert.match(text, /\/MediaBox \[0 0 24 30\]/);
  assert.match(text, /\/MediaBox \[0 0 32 18\]/);
  assert.match(text, /\/Title \(A \\\(test\\\) deck\)/);
  assert.match(text, /trailer\n<< \/Size 13 \/Root 1 0 R \/Info 12 0 R >>/);

  // Catalog, Pages, 3 x (page, content, image), Info, plus the free entry.
  assert.equal(total, 13);
  assert.equal(offsets[0].line, "0000000000 65535 f \n");
  for (let n = 1; n < total; n += 1) {
    assert.equal(offsets[n].flag, "n");
    assert.equal(text.slice(offsets[n].offset, offsets[n].offset + `${n} 0 obj\n`.length), `${n} 0 obj\n`, `xref entry ${n} points at its object`);
  }

  // Each image stream inflates back to the flattened RGB pixels.
  specs.forEach((spec, i) => {
    const start = offsets[5 + i * 3].offset;
    const head = /<< \/Type \/XObject \/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(text.slice(start));
    assert.ok(head, `image object ${i + 1}`);
    assert.equal(Number(head[1]), spec.width);
    assert.equal(Number(head[2]), spec.height);
    const dataStart = start + head.index + head[0].length;
    const data = buf.subarray(dataStart, dataStart + Number(head[3]));
    assert.ok(zlib.inflateSync(data).equals(expectedRgb(spec.width, spec.height, colour)));
    assert.equal(text.slice(dataStart + Number(head[3]), dataStart + Number(head[3]) + 18), "\nendstream\nendobj\n");
  });
  assert.equal(fs.readdirSync(path.dirname(out)).length, 1, "no temp file left behind");
});

test("pngsToPdf rejects bad input and leaves nothing behind", async () => {
  const dir = tmpDir();
  await assert.rejects(() => pngsToPdf([], path.join(dir, "a.pdf")), TypeError);
  await assert.rejects(() => pngsToPdf(["x.png"]), TypeError);
  const notPng = path.join(dir, "fake.png");
  fs.writeFileSync(notPng, "plain text pretending to be an image, long enough to parse");
  await assert.rejects(() => pngsToPdf([notPng], path.join(dir, "b.pdf")), /fake\.png: not a PNG/);
  assert.deepEqual(fs.readdirSync(dir), ["fake.png"]);
});
