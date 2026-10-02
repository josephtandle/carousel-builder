"use strict";

// Shared plumbing for the recipes and the CLI. Modules owned by the other
// parts of the engine (render, brand, copy, images, seat) are loaded lazily so
// a missing or broken one degrades to a clear message and never a crash.

const fs = require("node:fs");
const path = require("node:path");
const store = require("../lib/store.js");

const ROOT = path.resolve(__dirname, "..");

const FALLBACK_PROVIDERS = {
  mode: "first-available",
  chain: [
    { id: "library", enabled: true, env: [], costHint: "Free: your own images." },
    { id: "pexels", enabled: true, env: ["PEXELS_API_KEY"], costHint: "Free with an API key." },
    { id: "unsplash", enabled: true, env: ["UNSPLASH_ACCESS_KEY"], costHint: "Free with an access key." },
  ],
};

function value(input, key, fallback = "") {
  const found = input?.[key] ?? input?.args?.[key];
  return found === undefined || found === null ? fallback : found;
}

// lazy("lib/render.js") -> { ok, mod, missing, error }
function lazy(relative) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) return { ok: false, mod: null, missing: true, error: `${relative} is not installed` };
  try {
    return { ok: true, mod: require(file), missing: false, error: null };
  } catch (err) {
    return { ok: false, mod: null, missing: false, error: `${relative} failed to load: ${String((err && err.message) || err).split("\n")[0]}` };
  }
}

function contextOf(context = {}) {
  const env = context.env || process.env;
  const dataDir = context.dataDir ? path.resolve(context.dataDir) : env.CAROUSEL_HOME ? path.resolve(env.CAROUSEL_HOME) : store.resolveDataDir();
  return { env, dataDir, fetchImpl: context.fetchImpl || (typeof fetch === "function" ? fetch : undefined), now: context.now };
}

function config(name, ctx, fallback) {
  const loaded = store.loadConfig(name, { dataDir: ctx.dataDir, fallback });
  return loaded.config || fallback || null;
}

function errorReply(reply, metadata = {}) {
  return { status: "error", reply, artifacts: [], metadata };
}

function slideFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => path.join(dir, name));
}

// Accepts a carousel id, or a folder inside the data dir, and returns the
// export to publish. It fails closed: the folder must hold an export.json that
// lists the slides by plain relative name and records a passed layout check.
function resolveExport(ref, ctx) {
  const guard = require("../lib/publish/export-guard.js");
  const text = typeof ref === "string" ? ref.trim() : "";
  if (!text) return { ok: false, reason: "Say which carousel: an id from list-carousels, or its export folder inside the data dir." };
  const root = guard.dataRoot(ctx.dataDir);
  if (!root) return { ok: false, reason: "The data dir does not exist yet. Render a deck first." };

  let dir = null;
  if (store.isValidId(text)) {
    dir = store.exportDir(text, { dataDir: ctx.dataDir });
  } else {
    // Not an id: it has to be an existing folder that really sits inside the data dir.
    try {
      const real = fs.realpathSync(path.resolve(text));
      if (fs.statSync(real).isDirectory() && guard.isInside(root, real) && real !== root) dir = real;
    } catch {
      dir = null;
    }
    if (!dir) return { ok: false, reason: "Only exports inside the data dir can be published. Pass a carousel id from list-carousels, or an export folder inside the data dir." };
  }
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
    if (!fs.statSync(realDir).isDirectory() || !guard.isInside(root, realDir)) throw new Error("outside");
  } catch {
    return { ok: false, reason: `No export found for "${text.slice(0, 80)}". Render the deck first, then pass its id.` };
  }

  const listed = guard.readManifest(realDir, root);
  if (!listed.ok) return { ok: false, reason: listed.reason, qaFailed: Boolean(listed.qaFailed), qaIssues: listed.qaIssues || [] };
  const pdfPath = listed.pdf || path.join(realDir, "carousel.pdf");
  const pdf = fs.existsSync(pdfPath) ? pdfPath : null;
  const checked = guard.inspect(listed.files, pdf, { dataDir: ctx.dataDir });
  if (!checked.ok) return { ok: false, reason: checked.reason, qaFailed: Boolean(checked.qaFailed), qaIssues: checked.qaIssues || [] };
  const id = store.isValidId(path.basename(realDir)) ? path.basename(realDir) : null;
  return { ok: true, id, dir: realDir, files: checked.files, pdf: checked.pdf, manifest: listed.manifest };
}

// Builds carousel.pdf inside the export folder when it is not there yet. The
// name is fixed: a manifest never chooses where this file is written.
async function ensurePdf(found, title) {
  if (found.pdf) return found.pdf;
  const { pngsToPdf } = require("../lib/pdf.js");
  return pngsToPdf(found.files, path.join(found.dir, "carousel.pdf"), { title });
}

// True when a path (which may not exist yet) lands inside the data dir once
// symlinks in its existing part are resolved.
function insideDataDir(target, ctx) {
  const guard = require("../lib/publish/export-guard.js");
  const root = guard.dataRoot(ctx.dataDir);
  if (!root) return false;
  let current = path.resolve(String(target));
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return guard.isInside(root, path.join(real, ...tail));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return false;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function captionText(caption, hashtags) {
  const text = String(caption || "").trim();
  const tags = (Array.isArray(hashtags) ? hashtags : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => !text.includes(t));
  return tags.length ? `${text}${text ? "\n\n" : ""}${tags.join(" ")}` : text;
}

// Validates, renders, exports and builds the PDF for one deck.
async function renderAndExport(deck, opts, ctx) {
  const schema = lazy("lib/deck-schema.js");
  const render = lazy("lib/render.js");
  const brandModule = lazy("lib/brand.js");
  if (!render.ok) return { ok: false, stage: "setup", reason: `Rendering is not available: ${render.error}.` };

  const size = opts.size || deck.size || "portrait";
  const deckToRender = { ...deck, size };
  let validation = { ok: true, errors: [], warnings: [] };
  if (schema.ok && typeof schema.mod.validateDeck === "function") {
    validation = schema.mod.validateDeck(deckToRender) || validation;
    if (!validation.ok) return { ok: false, stage: "validate", reason: `The deck is not valid: ${(validation.errors || []).join("; ")}`, validation };
  }

  const chromePath = typeof render.mod.findChrome === "function" ? render.mod.findChrome() : null;
  if (!chromePath) return { ok: false, stage: "chrome", reason: "No Chrome, Chromium or Edge was found. Install one (or set CHROME_BIN) and run the doctor again.", validation };

  const saved = store.saveDraft(deckToRender, { dataDir: ctx.dataDir, id: opts.id || undefined, baseDir: opts.baseDir, now: ctx.now });
  const record = store.getDraft(saved.id, { dataDir: ctx.dataDir });
  const baseDir = opts.baseDir || (record && record.baseDir) || process.cwd();
  const outDir = opts.outDir ? path.resolve(opts.outDir) : store.exportDir(saved.id, { dataDir: ctx.dataDir });
  fs.mkdirSync(outDir, { recursive: true });
  let brand = null;
  if (brandModule.ok && typeof brandModule.mod.loadBrand === "function") brand = brandModule.mod.loadBrand(ctx.dataDir);

  let result;
  try {
    result = await render.mod.renderDeck(deckToRender, { outDir, brand, size, chromePath, baseDir, dataDir: ctx.dataDir });
  } catch (err) {
    return { ok: false, stage: "render", id: saved.id, reason: `Render failed: ${String((err && err.message) || err).split("\n")[0]}`, validation };
  }
  const files = (result && Array.isArray(result.files) ? result.files : []).filter((f) => fs.existsSync(f));
  const qa = (result && result.qa) || { ok: Boolean(result && result.ok), issues: [] };
  if (files.length === 0) return { ok: false, stage: "render", id: saved.id, reason: `Render produced no slides${qa.issues && qa.issues.length ? `: ${qa.issues.slice(0, 3).map(String).join("; ")}` : "."}`, qa, validation };

  let pdf = null;
  let pdfError = null;
  try {
    pdf = await require("../lib/pdf.js").pngsToPdf(files, path.join(outDir, "carousel.pdf"), { title: deck.title });
  } catch (err) {
    pdfError = String((err && err.message) || err);
  }
  const exported = store.recordExport(saved.id, files, {
    dataDir: ctx.dataDir,
    copy: !opts.outDir,
    pdf: pdf || undefined,
    title: deck.title,
    size,
    caption: deck.caption,
    hashtags: deck.hashtags,
    qa,
    now: ctx.now,
  });
  // A custom output folder gets its own manifest next to the slides, with
  // plain relative names and the layout check result, so the check travels
  // with the files.
  if (opts.outDir) {
    const manifest = {
      id: saved.id,
      exportedAt: new Date(ctx.now === undefined ? Date.now() : ctx.now).toISOString(),
      files: files.map((f) => path.basename(f)),
      pdf: pdf ? path.basename(pdf) : null,
      title: deck.title || null,
      size,
      caption: typeof deck.caption === "string" ? deck.caption : null,
      hashtags: Array.isArray(deck.hashtags) ? deck.hashtags : [],
      qa,
    };
    fs.writeFileSync(path.join(outDir, "export.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { ok: Boolean(result.ok) && qa.ok !== false, stage: "done", id: saved.id, draftPath: saved.path, dir: opts.outDir ? outDir : exported.dir, files: opts.outDir ? files : exported.files, pdf: opts.outDir ? pdf : exported.pdf, pdfError, qa, validation };
}

function imageRows(ctx, seat) {
  const images = lazy("lib/images/index.js");
  if (images.ok && typeof images.mod.listProviders === "function") {
    try {
      return { moduleOk: true, error: null, rows: images.mod.listProviders({ env: ctx.env, dataDir: ctx.dataDir }) };
    } catch (err) {
      return { moduleOk: false, error: `lib/images/index.js listProviders failed: ${String(err.message).split("\n")[0]}`, rows: [] };
    }
  }
  // The image module is missing: report the configured chain by env names only.
  const chain = (config("providers", ctx, FALLBACK_PROVIDERS) || FALLBACK_PROVIDERS).chain || [];
  const rows = chain.map((entry) => {
    const names = Array.isArray(entry.env) ? entry.env : [];
    const missing = names.filter((name) => !String(ctx.env[name] || "").trim());
    const seatBlocked = entry.id === "codex-imagegen" && !(seat && seat.available);
    return {
      id: entry.id,
      enabled: entry.enabled !== false,
      configured: missing.length === 0 && !seatBlocked,
      status: missing.length === 0 && !seatBlocked ? "ok" : "not_configured",
      detail: missing.length ? `missing ${missing.join(", ")}` : seatBlocked ? "no Codex seat detected" : "",
      costHint: entry.costHint || "",
    };
  });
  return { moduleOk: false, error: images.error, rows };
}

// doctor(ctx) -> { chrome, llm, images: [...], publishers: [...], codexSeat, ... }
// Zero network calls. Also appends an "expected vs actual" line to
// logs/doctor.jsonl so a failure that keeps coming back is easy to spot.
function doctor(context = {}) {
  const ctx = contextOf(context);
  const modules = {};
  const note = (name, loaded) => {
    modules[name] = loaded.ok ? "ok" : loaded.missing ? "missing" : "broken";
    return loaded;
  };

  const render = note("render", lazy("lib/render.js"));
  let chrome = { ok: false, path: null, detail: render.error };
  if (render.ok) {
    try {
      const found = typeof render.mod.findChrome === "function" ? render.mod.findChrome() : null;
      chrome = found ? { ok: true, path: found, detail: "found" } : { ok: false, path: null, detail: "No Chrome, Chromium or Edge found. Install one or set CHROME_BIN." };
    } catch (err) {
      chrome = { ok: false, path: null, detail: `findChrome failed: ${String(err.message).split("\n")[0]}` };
    }
  }

  const llmModule = note("llm", lazy("lib/llm.js"));
  let llm = { ok: false, name: null, detail: llmModule.error };
  if (llmModule.ok) {
    try {
      const client = llmModule.mod.getLlm({ env: ctx.env, fetchImpl: ctx.fetchImpl });
      llm = client ? { ok: true, name: client.name || "configured", detail: "key found" } : { ok: false, name: null, detail: "No key found (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY). Drafting still works with the built-in keyless fallback." };
    } catch (err) {
      llm = { ok: false, name: null, detail: `getLlm failed: ${String(err.message).split("\n")[0]}` };
    }
  }

  const seatModule = note("seat", lazy("lib/seat.js"));
  let codexSeat = { available: false, reason: seatModule.error };
  if (seatModule.ok) {
    try {
      const seat = seatModule.mod.detectCodexSeat({ env: ctx.env }) || {};
      codexSeat = { available: Boolean(seat.available), reason: String(seat.reason || "") };
    } catch (err) {
      codexSeat = { available: false, reason: `detectCodexSeat failed: ${String(err.message).split("\n")[0]}` };
    }
  }

  note("images", lazy("lib/images/index.js"));
  const imageState = imageRows(ctx, codexSeat);
  if (imageState.error && modules.images === "ok") modules.images = "broken";
  for (const name of ["brand", "deck-schema", "copy"]) note(name, lazy(`lib/${name}.js`));

  let publishers = [];
  try {
    publishers = require("../lib/publish/index.js").listPublishers({ config: config("publishers", ctx), env: ctx.env, dataDir: ctx.dataDir });
  } catch (err) {
    publishers = [];
    modules.publish = "broken";
  }

  // Expected: every engine module loads and Chrome is present. Keys and
  // publisher credentials are optional, so they are reported but not expected.
  const mismatches = [];
  for (const [name, state] of Object.entries(modules)) if (state !== "ok") mismatches.push(`module:${name}:${state}`);
  if (modules.render === "ok" && !chrome.ok) mismatches.push("chrome:not_found");

  const report = {
    ok: mismatches.length === 0,
    dataDir: ctx.dataDir,
    chrome,
    llm,
    images: imageState.rows,
    publishers,
    codexSeat,
    modules,
    mismatches,
  };

  try {
    const history = store.readLog("doctor", { dataDir: ctx.dataDir });
    const repeats = {};
    for (const item of mismatches) {
      let streak = 0;
      for (let i = history.length - 1; i >= 0 && Array.isArray(history[i].mismatches) && history[i].mismatches.includes(item); i -= 1) streak += 1;
      repeats[item] = streak;
    }
    report.repeats = repeats;
    store.appendLog(
      "doctor",
      {
        expected: { modules: "all ok", chrome: true },
        actual: {
          modules,
          chrome: chrome.ok,
          llm: llm.ok ? llm.name : null,
          images: imageState.rows.filter((row) => row.enabled !== false && row.configured).map((row) => row.id),
          publishers: publishers.filter((p) => p.wired).map((p) => p.id),
          codexSeat: codexSeat.available,
        },
        ok: report.ok,
        mismatches,
        repeats,
      },
      { dataDir: ctx.dataDir, now: ctx.now }
    );
    report.logged = true;
  } catch {
    report.logged = false;
  }
  return report;
}

function doctorText(report) {
  const mark = (ok) => (ok ? "ok  " : "miss");
  const lines = [];
  lines.push(`data dir: ${report.dataDir}`);
  lines.push(`[${mark(report.chrome.ok)}] chrome: ${report.chrome.ok ? report.chrome.path : report.chrome.detail}`);
  lines.push(`[${mark(report.llm.ok)}] llm: ${report.llm.ok ? report.llm.name : report.llm.detail}`);
  lines.push("image providers:");
  if (report.images.length === 0) lines.push("  (none listed)");
  for (const row of report.images) lines.push(`  [${mark(row.enabled !== false && row.configured)}] ${row.id}${row.enabled === false ? " (off)" : ""}${row.detail ? `: ${row.detail}` : ""}`);
  lines.push("publishers:");
  for (const p of report.publishers) lines.push(`  [${mark(p.wired)}] ${p.id}: ${p.reason}`);
  lines.push(`[${mark(report.codexSeat.available)}] codex seat: ${report.codexSeat.reason || (report.codexSeat.available ? "available" : "not available")}`);
  const bad = Object.entries(report.modules).filter(([, state]) => state !== "ok");
  if (bad.length) lines.push(`engine modules not loaded: ${bad.map(([name, state]) => `${name} (${state})`).join(", ")}`);
  const stuck = Object.entries(report.repeats || {}).filter(([, n]) => n >= 2);
  if (stuck.length) lines.push(`still failing after earlier runs: ${stuck.map(([item, n]) => `${item} (${n + 1} runs in a row)`).join(", ")}`);
  lines.push(report.ok ? "Everything the engine needs is in place." : "Some parts are missing. The lines marked miss say what to fix.");
  return lines.join("\n");
}

module.exports = { ROOT, value, lazy, contextOf, config, errorReply, slideFiles, resolveExport, ensurePdf, insideDataDir, captionText, renderAndExport, doctor, doctorText, store };
