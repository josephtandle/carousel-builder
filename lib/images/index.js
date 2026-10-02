"use strict";

// Background image chain.
//
// findBackgrounds() walks the search providers of the providers.json chain in
// order; generateBackground() walks the generators. Disabled or unconfigured
// providers are skipped and recorded in `tried`, never thrown. In mode
// "first-available" the walk stops at the first provider that returns
// results. In mode "ask" searches return results per provider so a person can
// choose, and generation waits for an explicit provider choice (generators
// can cost money, so they never all run at once).
//
// Every result carries `credit` and `license` text.

const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = {
  library: require("./providers/library"),
  pexels: require("./providers/pexels"),
  unsplash: require("./providers/unsplash"),
  "codex-imagegen": require("./providers/codex-imagegen"),
  "openai-image": require("./providers/openai-image"),
  huggingface: require("./providers/huggingface"),
  whisk: require("./providers/whisk"),
  "open-generative-ai": require("./providers/open-generative-ai"),
};

const PROVIDER_IDS = Object.keys(PROVIDERS);
const MODES = ["first-available", "ask"];
const EXAMPLE_CONFIG = path.join(__dirname, "..", "..", "config", "providers.example.json");

function resolveDataDir({ dataDir, env } = {}) {
  if (dataDir) return path.resolve(dataDir);
  const home = env && typeof env.CAROUSEL_HOME === "string" ? env.CAROUSEL_HOME.trim() : "";
  return home ? path.resolve(home) : path.join(process.cwd(), ".carousel");
}

function readJson(file, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function defaultConfig() {
  return { mode: "first-available", chain: PROVIDER_IDS.map((id) => ({ id, enabled: true, env: [], costHint: "" })) };
}

// providers.json from the data dir when present, else the shipped example,
// else a built-in default with every provider enabled.
function loadProvidersConfig({ config, dataDir, env, fsImpl = fs } = {}) {
  const raw =
    (config && typeof config === "object" ? config : null) ||
    readJson(path.join(resolveDataDir({ dataDir, env }), "providers.json"), fsImpl) ||
    readJson(EXAMPLE_CONFIG, fsImpl) ||
    defaultConfig();
  const chain = (Array.isArray(raw.chain) ? raw.chain : defaultConfig().chain)
    .map((entry) => (typeof entry === "string" ? { id: entry } : entry))
    .filter((entry) => entry && typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      enabled: entry.enabled !== false,
      env: Array.isArray(entry.env) ? entry.env.filter((name) => typeof name === "string") : [],
      costHint: typeof entry.costHint === "string" ? entry.costHint : "",
    }));
  return { mode: MODES.includes(raw.mode) ? raw.mode : "first-available", chain };
}

function context(opts = {}) {
  const env = opts.env || process.env;
  const dataDir = resolveDataDir({ dataDir: opts.dataDir, env });
  return {
    env,
    dataDir,
    libraryDir: path.join(dataDir, "library"),
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    execImpl: opts.execImpl,
    runImpl: opts.runImpl,
    fsImpl: opts.fsImpl || fs,
    now: opts.now,
  };
}

// Why a chain entry cannot run, or "" when it can.
function blocker(entry, provider, ctx) {
  if (!provider) return `unknown provider "${entry.id}"`;
  if (!entry.enabled) return "disabled in providers.json";
  const missing = entry.env.filter((name) => !(typeof ctx.env[name] === "string" && ctx.env[name].trim()));
  if (missing.length) return `${missing.join(", ")} is not set`;
  let ready;
  try {
    ready = provider.isConfigured(ctx);
  } catch (error) {
    return `could not check configuration (${error.message})`;
  }
  return ready.ok ? "" : ready.detail || "not configured";
}

// One row per chain entry, for a doctor or settings screen. Makes no network calls.
function listProviders(opts = {}) {
  const ctx = context(opts);
  const config = loadProvidersConfig({ config: opts.config, dataDir: ctx.dataDir, env: ctx.env, fsImpl: ctx.fsImpl });
  return config.chain.map((entry) => {
    const provider = PROVIDERS[entry.id];
    const reason = blocker(entry, provider, ctx);
    return {
      id: entry.id,
      kind: provider ? provider.kind : "unknown",
      enabled: entry.enabled,
      configured: !reason,
      status: reason ? "not_configured" : "ok",
      detail: reason,
      costHint: entry.costHint,
      license: provider ? provider.license : "",
      experimental: Boolean(provider && provider.experimental),
    };
  });
}

function tag(results, id) {
  return (Array.isArray(results) ? results : [])
    .filter((item) => item && item.src)
    .map((item) => ({
      ...item,
      thumb: item.thumb || item.src,
      credit: item.credit || PROVIDERS[id].id,
      license: item.license || PROVIDERS[id].license,
      provider: id,
    }));
}

async function runProvider(entry, action, params, ctx) {
  const provider = PROVIDERS[entry.id];
  const reason = blocker(entry, provider, ctx);
  if (reason) return { id: entry.id, status: "not_configured", detail: reason, results: [] };
  try {
    const outcome = await provider[action](params, ctx);
    const results = tag(outcome && outcome.results, entry.id);
    let status = outcome && outcome.status;
    if (!["ok", "empty", "not_configured", "error"].includes(status)) status = results.length ? "ok" : "empty";
    if (status === "ok" && !results.length) status = "empty";
    return { id: entry.id, status, detail: (outcome && outcome.detail) || "", results: status === "ok" ? results : [] };
  } catch (error) {
    return { id: entry.id, status: "error", detail: String((error && error.message) || error).slice(0, 300), results: [] };
  }
}

function clampCount(count) {
  const value = Math.round(Number(count));
  return Number.isFinite(value) ? Math.max(1, Math.min(30, value)) : 6;
}

function entriesFor(config, kind, only) {
  return config.chain.filter((entry) => {
    if (only && entry.id !== only) return false;
    const provider = PROVIDERS[entry.id];
    return !provider || provider.kind === kind;
  });
}

async function findBackgrounds({ query = "", count = 6, orientation = "portrait" } = {}, opts = {}) {
  const ctx = context(opts);
  const config = loadProvidersConfig({ config: opts.config, dataDir: ctx.dataDir, env: ctx.env, fsImpl: ctx.fsImpl });
  const params = {
    query: String(query || "").trim(),
    count: clampCount(count),
    orientation: ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait",
  };
  const ask = config.mode === "ask" && !opts.provider;
  const tried = [];
  const byProvider = {};
  let provider = null;
  let results = [];

  for (const entry of entriesFor(config, "search", opts.provider)) {
    const outcome = await runProvider(entry, "search", params, ctx);
    tried.push({ id: outcome.id, status: outcome.status, detail: outcome.detail });
    if (outcome.status !== "ok") continue;
    byProvider[outcome.id] = outcome.results;
    if (!provider) provider = outcome.id;
    if (ask) results = results.concat(outcome.results);
    else {
      results = outcome.results;
      break;
    }
  }

  const response = { provider, results, tried };
  if (ask) response.byProvider = byProvider;
  // Optional fall-through: nothing found, so generate one instead.
  if (!results.length && opts.allowGenerate && params.query) {
    const generated = await generateBackground({ prompt: params.query, size: opts.size }, opts);
    return { ...generated, tried: tried.concat(generated.tried) };
  }
  return response;
}

async function generateBackground({ prompt = "", size = "portrait" } = {}, opts = {}) {
  const ctx = context(opts);
  const config = loadProvidersConfig({ config: opts.config, dataDir: ctx.dataDir, env: ctx.env, fsImpl: ctx.fsImpl });
  const text = String(prompt || "").trim();
  const tried = [];
  if (!text) return { provider: null, results: [], tried: [{ id: "input", status: "error", detail: "a prompt is required" }] };
  const params = { prompt: text, size: ["portrait", "square", "story"].includes(size) ? size : "portrait" };
  const entries = entriesFor(config, "generate", opts.provider);

  if (config.mode === "ask" && !opts.provider) {
    const options = [];
    for (const entry of entries) {
      const reason = blocker(entry, PROVIDERS[entry.id], ctx);
      if (reason) tried.push({ id: entry.id, status: "not_configured", detail: reason });
      else options.push({ id: entry.id, costHint: entry.costHint, license: PROVIDERS[entry.id].license });
    }
    return { provider: null, results: [], tried, needsChoice: true, options };
  }

  for (const entry of entries) {
    const outcome = await runProvider(entry, "generate", params, ctx);
    tried.push({ id: outcome.id, status: outcome.status, detail: outcome.detail });
    if (outcome.status === "ok") return { provider: outcome.id, results: outcome.results.slice(0, 1), tried };
  }
  return { provider: null, results: [], tried };
}

module.exports = {
  findBackgrounds,
  generateBackground,
  listProviders,
  loadProvidersConfig,
  PROVIDER_IDS,
};
