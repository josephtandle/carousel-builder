"use strict";

// Hugging Face Inference (FLUX.1 schnell) through the router host.
// Needs HF_TOKEN. Saves the image into the library folder.

const { BACKGROUND_SUFFIX, envValue, fetchWithTimeout, saveToLibrary, sizeHint, short } = require("../util");

const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell";
const LICENSE = "AI generated with FLUX.1 schnell (Apache 2.0 model) through your Hugging Face account.";

function isConfigured({ env }) {
  return envValue(env, "HF_TOKEN") ? { ok: true, detail: "" } : { ok: false, detail: "HF_TOKEN is not set" };
}

async function generate({ prompt, size }, ctx) {
  const token = envValue(ctx.env, "HF_TOKEN");
  const model = envValue(ctx.env, "CAROUSEL_HF_IMAGE_MODEL") || DEFAULT_MODEL;
  const { width, height } = sizeHint(size).flux;
  const response = await fetchWithTimeout(
    ctx.fetchImpl,
    `https://router.huggingface.co/hf-inference/models/${model}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, accept: "image/png" },
      body: JSON.stringify({
        inputs: `${prompt}. ${BACKGROUND_SUFFIX}`,
        parameters: { num_inference_steps: 4, width, height },
      }),
    },
    120000,
  );
  if (!response.ok) {
    const body = short(await response.text(), 200).split(token).join("[redacted]");
    return { status: "error", results: [], detail: `Hugging Face HTTP ${response.status}: ${body}` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  let file;
  try {
    file = saveToLibrary(buffer, { libraryDir: ctx.libraryDir, provider: "huggingface", prompt, now: ctx.now, fsImpl: ctx.fsImpl });
  } catch (error) {
    return { status: "error", results: [], detail: `Hugging Face: ${error.message}` };
  }
  return {
    status: "ok",
    detail: `generated with ${model}`,
    results: [{ src: file, thumb: file, credit: "AI generated (FLUX.1 schnell on Hugging Face)", license: LICENSE, alt: prompt }],
  };
}

module.exports = { id: "huggingface", kind: "generate", env: ["HF_TOKEN"], license: LICENSE, isConfigured, generate };
