"use strict";
/*
 * Split one wide image into a strip of slide backgrounds, so a photo continues across the swipe.
 *
 *   splitPanorama(imagePath, slideCount, outDir, { size, chromePath }?) -> Promise<[png paths in order]>
 *
 * The image is scaled to cover slideCount canvases laid side by side (centred, cropped where needed) and
 * each canvas is captured with the system browser. No image library is needed. Use each slice as a slide's
 * background.src. Rejects with an Error carrying `code` (bad_input, image_not_found, chrome_not_found, ...).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { findChrome, chromeScreenshot, pngSize } = require("./render.js");
const { SIZES, DEFAULT_SIZE, MAX_SLIDES } = require("./deck-schema.js");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"]);

function err(code, message) { return Object.assign(new Error(message), { code }); }

async function splitPanorama(imagePath, slideCount, outDir, opts) {
  const o = opts || {};
  const n = Number(slideCount);
  if (typeof imagePath !== "string" || !imagePath) throw err("bad_input", "splitPanorama: imagePath is required");
  if (!Number.isInteger(n) || n < 1 || n > MAX_SLIDES) throw err("bad_input", `splitPanorama: slideCount must be a whole number from 1 to ${MAX_SLIDES}`);
  if (typeof outDir !== "string" || !outDir) throw err("bad_input", "splitPanorama: outDir is required");
  const size = o.size || DEFAULT_SIZE;
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) throw err("bad_input", `splitPanorama: unknown size "${size}"`);
  const abs = path.resolve(imagePath);
  if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) throw err("bad_input", "splitPanorama: imagePath must be a png, jpg, webp, gif, avif or svg file");
  if (!fs.existsSync(abs)) throw err("image_not_found", `splitPanorama: image not found: ${imagePath}`);
  const chromePath = o.chromePath || findChrome();
  if (!chromePath) throw err("chrome_not_found", "No Chrome, Chromium or Edge found. Install one, or set CHROME_BIN to its binary.");

  const { w, h } = SIZES[size];
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carousel-pano-"));
  const src = pathToFileURL(abs).href.replace(/"/g, "%22");
  try {
    const jobs = Array.from({ length: n }, (_, i) => {
      const page = path.join(tmp, `slice-${i + 1}.html`);
      fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000}
img{position:absolute;top:0;left:${-i * w}px;width:${n * w}px;height:${h}px;object-fit:cover;object-position:50% 50%}
</style></head><body><img src="${src}" alt=""></body></html>`);
      return { page, file: path.join(out, `panorama-${String(i + 1).padStart(2, "0")}.png`) };
    });
    const files = [];
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (fs.existsSync(job.file)) fs.unlinkSync(job.file);
        await chromeScreenshot({ chromePath, url: pathToFileURL(job.page).href, out: job.file, width: w, height: h, virtualTime: 4000 });
        const s = pngSize(job.file);
        if (s.w !== w || s.h !== h) throw err("bad_slice", `panorama slice is ${s.w}x${s.h}, expected ${w}x${h}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    for (const job of jobs) files.push(job.file);
    return files;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { splitPanorama };
