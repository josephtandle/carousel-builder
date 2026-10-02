"use strict";

// Brief (or a pasted post) -> deck JSON -> saved draft -> rendered slides.
// Never publishes.
const engine = require("./_engine.js");

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const { value, lazy, contextOf, errorReply, renderAndExport, store } = engine;
  const ctx = contextOf(context);
  const brief = String(value(input, "brief")).trim();
  const sourceText = String(value(input, "sourceText")).trim();
  if (!brief && !sourceText) return errorReply("Tell me what the carousel is about (brief), or paste the post to turn into one (sourceText).", { created: false });

  const copy = lazy("lib/copy.js");
  if (!copy.ok) return errorReply(`Drafting is not available: ${copy.error}.`, { created: false });
  const llmModule = lazy("lib/llm.js");
  let llm = null;
  if (llmModule.ok) {
    try {
      llm = llmModule.mod.getLlm({ env: ctx.env, fetchImpl: ctx.fetchImpl });
    } catch {
      llm = null;
    }
  }
  const brandModule = lazy("lib/brand.js");
  let brand = null;
  if (brandModule.ok) {
    try {
      brand = brandModule.mod.loadBrand(ctx.dataDir);
    } catch {
      brand = null;
    }
  }

  const slides = Number(value(input, "slides", 0)) || undefined;
  const size = String(value(input, "size", "portrait"));
  let deck;
  try {
    deck = await copy.mod.draftDeck({ brief, slides, sourceText, size }, { llm, brand });
  } catch (err) {
    return errorReply(`Could not draft the deck: ${String((err && err.message) || err).split("\n")[0]}`, { created: false });
  }

  if (value(input, "caption", true) !== false && typeof copy.mod.draftCaption === "function" && !deck.caption) {
    try {
      const written = await copy.mod.draftCaption(deck, { llm, brand });
      if (written && written.caption) deck = { ...deck, caption: written.caption, hashtags: written.hashtags || deck.hashtags || [] };
    } catch {
      // A caption is a nice-to-have: the deck is still good without one.
    }
  }

  const saved = store.saveDraft(deck, { dataDir: ctx.dataDir, now: ctx.now });
  const count = Array.isArray(deck.slides) ? deck.slides.length : 0;
  const metadata = { created: true, id: saved.id, draftPath: saved.path, slides: count, usedModel: llm ? llm.name || true : false, rendered: false, published: false };
  const wantsRender = value(input, "render", true) !== false && value(input, "render", true) !== "false";
  if (!wantsRender) {
    return { status: "ok", reply: `Draft saved as ${saved.id} with ${count} slides${llm ? "" : " (keyless fallback copy, edit before use)"}. Render it with: carousel render ${saved.id} (or the render-deck recipe).`, artifacts: [saved.path], metadata };
  }

  const out = await renderAndExport(deck, { id: saved.id, size }, ctx);
  if (!out.files || out.files.length === 0) {
    return { status: "ok", reply: `Draft saved as ${saved.id} with ${count} slides, but it was not rendered. ${out.reason}`, artifacts: [saved.path], metadata: { ...metadata, renderError: out.reason } };
  }
  const issues = (out.qa && out.qa.issues) || [];
  return {
    status: "ok",
    reply: `Carousel ${saved.id}: ${out.files.length} slides rendered to ${out.dir}${out.pdf ? ", with carousel.pdf" : ""}. ${out.ok ? "Layout check passed." : `Layout check found ${issues.length} issue(s): fix them before publishing.`} Nothing was published.`,
    artifacts: [...out.files, ...(out.pdf ? [out.pdf] : [])],
    metadata: { ...metadata, rendered: true, exportDir: out.dir, files: out.files, pdf: out.pdf, qa: out.qa },
  };
};
