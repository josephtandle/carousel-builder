"use strict";

// Adapter for the sibling `open-generative-ai` module (All Sorted), a
// bring-your-own-key proxy to generative media providers. It only runs when
// <ALLSORTED_ROOT>/open-generative-ai exists and a provider key is set.
// Defaults target fal.ai FLUX schnell; override with
// CAROUSEL_OGA_PROVIDER and CAROUSEL_OGA_PATH.

const fs = require("node:fs");
const { findSibling } = require("./sibling");
const { BACKGROUND_SUFFIX, envValue, runProcess, saveToLibrary, download, sizeHint, short } = require("../util");
const { extractJson } = require("../../llm");

const LICENSE = "AI generated through your open-generative-ai module. Use is subject to the terms of the provider you connected.";
const KEY_BY_PROVIDER = { fal: "FAL_API_KEY", muapi: "MUAPI_API_KEY", replicate: "REPLICATE_API_TOKEN" };

function target(env) {
  return {
    provider: envValue(env, "CAROUSEL_OGA_PROVIDER") || "fal",
    requestPath: envValue(env, "CAROUSEL_OGA_PATH") || "fal-ai/flux/schnell",
  };
}

function isConfigured({ env, fsImpl }) {
  const found = findSibling("open-generative-ai", ["call.js"], { env, fsImpl });
  if (!found.ok) return { ok: false, detail: found.detail };
  const { provider } = target(env);
  const keyName = KEY_BY_PROVIDER[provider];
  if (keyName && !envValue(env, keyName)) return { ok: false, detail: `${keyName} is not set` };
  return { ok: true, detail: "" };
}

// Finds the first https image URL anywhere in a provider response.
function findImageUrl(value, depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return /^https:\/\/\S+$/i.test(value) && /\.(png|jpe?g|webp)(\?|$)/i.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findImageUrl(item, depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.url === "string" && /^https:\/\//i.test(value.url)) return value.url;
    for (const item of Object.values(value)) {
      const hit = findImageUrl(item, depth + 1);
      if (hit) return hit;
    }
  }
  return "";
}

async function generate({ prompt, size }, ctx) {
  const fsImpl = ctx.fsImpl || fs;
  const ready = isConfigured({ env: ctx.env, fsImpl });
  if (!ready.ok) return { status: "not_configured", results: [], detail: ready.detail };
  const found = findSibling("open-generative-ai", ["call.js"], { env: ctx.env, fsImpl });
  const { provider, requestPath } = target(ctx.env);
  const hint = sizeHint(size);
  const body = { prompt: `${prompt}. ${BACKGROUND_SUFFIX}`, image_size: { width: hint.flux.width, height: hint.flux.height }, num_images: 1 };
  const run = ctx.runImpl || runProcess;
  const result = await run(
    process.execPath,
    [found.entry, "call", requestPath, "--method", "POST", "--provider", provider, "--body", JSON.stringify(body), "--confirm"],
    { timeoutMs: 180000, cwd: found.dir, env: ctx.env },
  );
  if (result.timedOut) return { status: "error", results: [], detail: "open-generative-ai timed out" };
  if (result.code !== 0) {
    return { status: "error", results: [], detail: `open-generative-ai: ${short(result.stderr || result.error || result.stdout, 200) || "failed"}` };
  }
  const url = findImageUrl(extractJson(result.stdout));
  if (!url) return { status: "error", results: [], detail: "open-generative-ai returned no image URL" };
  let file;
  try {
    const buffer = await download(ctx.fetchImpl, url);
    file = saveToLibrary(buffer, { libraryDir: ctx.libraryDir, provider: "open-generative-ai", prompt, now: ctx.now, fsImpl });
  } catch (error) {
    return { status: "error", results: [], detail: `open-generative-ai: ${error.message}` };
  }
  return {
    status: "ok",
    detail: `generated through ${provider} (${requestPath})`,
    results: [{ src: file, thumb: file, credit: `AI generated (${provider} via open-generative-ai)`, license: LICENSE, alt: prompt }],
  };
}

module.exports = { id: "open-generative-ai", kind: "generate", env: ["ALLSORTED_ROOT"], license: LICENSE, isConfigured, generate };
