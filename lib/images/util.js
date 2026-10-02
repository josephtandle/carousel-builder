"use strict";

// Shared helpers for image providers: format sniffing, saving into the
// library folder, downloading through an injectable fetch, and running a
// child process with a hard timeout.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

// Pixel sizes per deck size, in the shape each generator can accept.
const SIZE_HINTS = {
  portrait: { width: 1080, height: 1350, openai: "1024x1536", flux: { width: 896, height: 1120 }, ratio: "4:5" },
  square: { width: 1080, height: 1080, openai: "1024x1024", flux: { width: 1024, height: 1024 }, ratio: "1:1" },
  story: { width: 1080, height: 1920, openai: "1024x1536", flux: { width: 720, height: 1280 }, ratio: "9:16" },
};

function sizeHint(size) {
  return SIZE_HINTS[size] || SIZE_HINTS.portrait;
}

function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function slug(text, max = 40) {
  const value = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return value || "image";
}

function stamp(now) {
  const date = typeof now === "function" ? now() : new Date();
  return new Date(date).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function libraryPath({ libraryDir, provider, prompt, ext, now }) {
  return path.join(libraryDir, `gen-${slug(provider, 24)}-${slug(prompt)}-${stamp(now)}.${ext}`);
}

// Writes image bytes into the library folder. Returns the absolute file path.
function saveToLibrary(buffer, { libraryDir, provider, prompt, now, fsImpl = fs }) {
  const ext = sniffImage(buffer);
  if (!ext) throw new Error("the provider did not return a PNG, JPEG, or WebP image");
  fsImpl.mkdirSync(libraryDir, { recursive: true });
  const file = libraryPath({ libraryDir, provider, prompt, ext, now });
  fsImpl.writeFileSync(file, buffer);
  return file;
}

async function download(fetchImpl, url, { headers } = {}) {
  if (!/^https:\/\//i.test(String(url))) throw new Error("refusing to download a non-https image URL");
  const response = await fetchImpl(url, { method: "GET", headers: headers || {} });
  if (!response.ok) throw new Error(`image download failed (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error("image download is larger than 30 MB");
  return buffer;
}

async function fetchWithTimeout(fetchImpl, url, init, ms) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    return await fetchImpl(url, { ...init, signal: controller ? controller.signal : undefined });
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`request timed out after ${ms} ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Default child-process runner. Resolves, never rejects:
// { code, stdout, stderr, timedOut, error }.
function runProcess(command, args, { timeoutMs = 120000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    let child;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child) child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ code: null, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    try {
      child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ code: null, error: error.message });
      return;
    }
    const keep = (current, chunk) => (current.length < 200000 ? current + chunk.toString("utf8") : current);
    child.stdout.on("data", (chunk) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = keep(stderr, chunk);
    });
    child.on("error", (error) => finish({ code: null, error: error.message }));
    child.on("close", (code) => finish({ code }));
  });
}

function short(text, max = 300) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, max);
}

function envValue(env, name) {
  const value = env && env[name];
  return typeof value === "string" ? value.trim() : "";
}

// A prompt tail that keeps generated images usable behind slide text.
const BACKGROUND_SUFFIX =
  "Background image for a social media slide. No text, no letters, no logos, no watermarks. Calm composition with open space for a headline.";

module.exports = {
  IMAGE_EXTENSIONS,
  BACKGROUND_SUFFIX,
  sizeHint,
  sniffImage,
  slug,
  saveToLibrary,
  download,
  fetchWithTimeout,
  runProcess,
  short,
  envValue,
};
