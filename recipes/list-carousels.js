"use strict";

// Lists saved drafts, what has been exported, and recent publish attempts.
const engine = require("./_engine.js");

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const { value, contextOf, store } = engine;
  const ctx = contextOf(context);
  const limit = Math.max(1, Math.min(200, Number(value(input, "limit", 20)) || 20));
  const drafts = store.listDrafts({ dataDir: ctx.dataDir });
  const exports = store.listExports({ dataDir: ctx.dataDir });
  const log = store.readPublishLog({ dataDir: ctx.dataDir });
  const published = log.filter((entry) => entry.status === "published");

  const known = new Set(drafts.map((d) => d.id));
  const rows = drafts.map((d) => ({ ...d, published: published.filter((p) => p.source === d.id).map((p) => ({ target: p.target, url: p.url || null, at: p.at })) }));
  for (const item of exports) {
    if (known.has(item.id)) continue;
    rows.push({ id: item.id, title: item.title || "", size: item.size || null, slides: item.files.length, createdAt: null, updatedAt: null, exported: true, exportedAt: item.exportedAt || null, published: published.filter((p) => p.source === item.id).map((p) => ({ target: p.target, url: p.url || null, at: p.at })) });
  }
  rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const shown = rows.slice(0, limit);

  const lines = shown.map((r) => `${r.id}: "${r.title || "untitled"}", ${r.slides} slides, ${r.exported ? "exported" : "draft only"}${r.published.length ? `, published to ${[...new Set(r.published.map((p) => p.target))].join(", ")}` : ""}`);
  return {
    status: "ok",
    reply: rows.length ? `${rows.length} carousel${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? ` (showing the newest ${shown.length})` : ""}:\n${lines.join("\n")}` : 'No carousels yet. Start one with: carousel draft "<brief>" (or the create-carousel recipe).',
    artifacts: [],
    metadata: { count: rows.length, carousels: shown, recentPublishAttempts: log.slice(-limit).reverse(), dataDir: ctx.dataDir },
  };
};
