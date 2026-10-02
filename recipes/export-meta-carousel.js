"use strict";

// Writes a Meta ads carousel handoff file (meta-carousel.json) beside the slides of a
// rendered carousel: the cards, the message and the call to action, with the page id, the
// Instagram user id and the link left to fill in. Nothing is uploaded and Meta is never
// contacted: this only prepares a file for whoever builds the ad.
const path = require("node:path");
const engine = require("./_engine.js");

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const { value, contextOf, errorReply, lazy, store } = engine;
  const ctx = contextOf(context);
  const id = String(value(input, "id", "")).trim();
  if (!store.isValidId(id)) return errorReply("Say which carousel: id is the id of a rendered carousel (see list-carousels).", { written: false });
  const api = lazy("lib/api.js");
  if (!api.ok) return errorReply(`The Meta handoff is not available: ${api.error}.`, { written: false });

  const result = await api.mod.createApi({ dataDir: ctx.dataDir, env: ctx.env, fetchImpl: ctx.fetchImpl }).handle("export", "GET", { query: { id, format: "meta" } });
  const body = result.json || {};
  if (result.status !== 200 || body.ok !== true) return errorReply(body.error || "The Meta handoff file could not be written.", { written: false, code: body.code || null });

  const file = path.join(ctx.dataDir, body.file);
  const lines = [
    `Meta ads carousel handoff written: ${file}`,
    `${body.spec.cards.length} cards, call to action ${body.spec.callToAction}. Nothing was uploaded and Meta was not contacted.`,
    `Fill in before use: ${body.fillIn.join(", ")}.`,
    ...body.warnings.map((warning) => `Note: ${warning}`),
  ];
  return { status: "ok", reply: lines.join("\n"), artifacts: [file], metadata: { written: true, id, file, spec: body.spec, warnings: body.warnings, fillIn: body.fillIn, networkCalls: 0 } };
};
