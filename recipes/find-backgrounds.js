"use strict";

// Background images through the provider chain: your library first, then free
// stock, then generators. Says which providers were tried and why each one
// was skipped, so a missing key never looks like "no results".
const engine = require("./_engine.js");

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const { value, lazy, contextOf, errorReply } = engine;
  const ctx = contextOf(context);
  const images = lazy("lib/images/index.js");
  if (!images.ok) return errorReply(`Background search is not available: ${images.error}.`, { found: 0 });

  const query = String(value(input, "query")).trim();
  const prompt = String(value(input, "prompt")).trim();
  const generate = value(input, "generate", false) === true || value(input, "generate", false) === "true";
  if (!query && !prompt) return errorReply("Say what to look for (query), or describe an image to generate (prompt with generate: true).", { found: 0 });

  const opts = { env: ctx.env, fetchImpl: ctx.fetchImpl, dataDir: ctx.dataDir };
  const provider = String(value(input, "provider")).trim();
  if (provider) opts.provider = provider;
  let out;
  try {
    if (generate) out = await images.mod.generateBackground({ prompt: prompt || query, size: String(value(input, "size", "portrait")) }, opts);
    else out = await images.mod.findBackgrounds({ query, count: Number(value(input, "count", 6)) || 6, orientation: String(value(input, "orientation", "portrait")) }, opts);
  } catch (err) {
    return errorReply(`Background ${generate ? "generation" : "search"} failed: ${String((err && err.message) || err).split("\n")[0]}`, { found: 0 });
  }

  const results = Array.isArray(out && out.results) ? out.results : [];
  const tried = Array.isArray(out && out.tried) ? out.tried : [];
  const skipped = tried.filter((t) => t.status !== "ok").map((t) => `${t.id} (${t.status}${t.detail ? `: ${t.detail}` : ""})`);
  let reply;
  if (results.length) reply = `${results.length} background${results.length === 1 ? "" : "s"} from ${out.provider}.${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}`;
  else if (out && out.needsChoice) reply = `Pick a generator and run again with provider: ${(out.options || []).map((o) => `${o.id} (${o.costHint || "cost not stated"})`).join("; ") || "none are configured"}.`;
  else reply = `No backgrounds found.${skipped.length ? ` Tried: ${skipped.join("; ")}.` : ""}`;
  return {
    status: "ok",
    reply,
    artifacts: results.map((r) => r.src).filter((src) => typeof src === "string" && !/^https?:/i.test(src)),
    metadata: { found: results.length, provider: (out && out.provider) || null, results, tried, needsChoice: Boolean(out && out.needsChoice), options: (out && out.options) || [] },
  };
};
