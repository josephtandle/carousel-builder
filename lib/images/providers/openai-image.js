"use strict";

// OpenAI image generation (metered, billed to your own OpenAI account).
// Needs OPENAI_API_KEY. Saves the image into the library folder.

const { BACKGROUND_SUFFIX, envValue, fetchWithTimeout, saveToLibrary, download, sizeHint, short } = require("../util");

const DEFAULT_MODEL = "gpt-image-1";
const LICENSE = "AI generated with your OpenAI account. Use is subject to the OpenAI terms that apply to your account.";

function isConfigured({ env }) {
  return envValue(env, "OPENAI_API_KEY") ? { ok: true, detail: "" } : { ok: false, detail: "OPENAI_API_KEY is not set" };
}

async function generate({ prompt, size }, ctx) {
  const key = envValue(ctx.env, "OPENAI_API_KEY");
  const model = envValue(ctx.env, "CAROUSEL_OPENAI_IMAGE_MODEL") || DEFAULT_MODEL;
  const base = (envValue(ctx.env, "OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetchWithTimeout(
    ctx.fetchImpl,
    `${base}/images/generations`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt: `${prompt}. ${BACKGROUND_SUFFIX}`, size: sizeHint(size).openai, n: 1 }),
    },
    180000,
  );
  if (!response.ok) {
    const body = short(await response.text(), 200).split(key).join("[redacted]");
    return { status: "error", results: [], detail: `OpenAI images HTTP ${response.status}: ${body}` };
  }
  const data = await response.json();
  const item = Array.isArray(data.data) ? data.data[0] : null;
  let buffer = null;
  if (item && typeof item.b64_json === "string") buffer = Buffer.from(item.b64_json, "base64");
  else if (item && typeof item.url === "string") buffer = await download(ctx.fetchImpl, item.url);
  if (!buffer) return { status: "error", results: [], detail: "OpenAI images returned no image data" };
  const file = saveToLibrary(buffer, { libraryDir: ctx.libraryDir, provider: "openai-image", prompt, now: ctx.now, fsImpl: ctx.fsImpl });
  return {
    status: "ok",
    detail: `generated with ${model}`,
    results: [{ src: file, thumb: file, credit: `AI generated (OpenAI ${model})`, license: LICENSE, alt: prompt }],
  };
}

module.exports = { id: "openai-image", kind: "generate", env: ["OPENAI_API_KEY"], license: LICENSE, isConfigured, generate };
