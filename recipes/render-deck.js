"use strict";

// Renders a deck (a saved draft id, a deck JSON file, or an inline deck) to
// PNG slides plus carousel.pdf. Never publishes.
const fs = require("node:fs");
const path = require("node:path");
const engine = require("./_engine.js");

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const { value, contextOf, errorReply, renderAndExport, insideDataDir, store } = engine;
  const ctx = contextOf(context);
  const id = String(value(input, "id")).trim();
  const deckPath = String(value(input, "deckPath")).trim();
  const inline = value(input, "deck", null);

  let deck = null;
  let draftId = null;
  let baseDir;
  if (inline && typeof inline === "object") {
    deck = inline;
  } else if (id) {
    if (!store.isValidId(id)) return errorReply("That is not a carousel id. Ids look like 20260102-093000-my-title.", { rendered: false });
    deck = store.loadDraft(id, { dataDir: ctx.dataDir });
    if (!deck) return errorReply(`No draft with id ${id}. Use list-carousels to see what exists.`, { rendered: false });
    draftId = id;
  } else if (deckPath) {
    // The error never quotes the file: a parse error would echo its first bytes.
    let text;
    try {
      const stat = fs.statSync(path.resolve(deckPath));
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return errorReply("The deck file must be a JSON file under 5 MB.", { rendered: false });
      text = fs.readFileSync(path.resolve(deckPath), "utf8");
    } catch (err) {
      return errorReply(`Could not read the deck file (${(err && err.code) || "unreadable"}).`, { rendered: false });
    }
    try {
      deck = JSON.parse(text);
    } catch {
      return errorReply("The deck file is not valid JSON.", { rendered: false });
    }
    baseDir = path.dirname(path.resolve(deckPath));
  } else {
    return errorReply("Say what to render: id (a saved draft), deckPath (a deck JSON file) or deck (inline JSON).", { rendered: false });
  }
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.slides)) return errorReply("The deck needs a slides array.", { rendered: false });

  const size = String(value(input, "size")).trim() || undefined;
  const outDir = String(value(input, "outDir")).trim() || undefined;
  // Writes stay inside the data dir. Only a caller that sets
  // context.allowExternalOutDir (the CLI render command, for the person at
  // the keyboard) may render to a folder elsewhere, and that export can then
  // not be published.
  if (outDir && !context.allowExternalOutDir && !insideDataDir(outDir, ctx)) {
    return errorReply("outDir must be inside the data dir. Leave it out to render into the carousel's own export folder.", { rendered: false });
  }
  const out = await renderAndExport(deck, { id: draftId || undefined, size, outDir, baseDir }, ctx);
  if (!out.files || out.files.length === 0) return errorReply(out.reason, { rendered: false, stage: out.stage, qa: out.qa || null, validation: out.validation || null });
  const issues = (out.qa && out.qa.issues) || [];
  return {
    status: out.ok ? "ok" : "error",
    reply: out.ok
      ? `Rendered ${out.files.length} slides to ${out.dir}${out.pdf ? ", with carousel.pdf" : ""}. Layout check passed. Id: ${out.id}.`
      : `Rendered ${out.files.length} slides to ${out.dir}, but the layout check found ${issues.length} issue(s): ${issues.slice(0, 5).map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("; ")}. Fix the deck before publishing.`,
    artifacts: [...out.files, ...(out.pdf ? [out.pdf] : [])],
    metadata: { rendered: true, id: out.id, exportDir: out.dir, files: out.files, pdf: out.pdf, pdfError: out.pdfError, qa: out.qa, validation: out.validation, published: false },
  };
};
