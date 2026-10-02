"use strict";

// Zero-network setup check: what the engine can do right now and what is
// missing. Reports env names only, never values.
const { doctor, doctorText } = require("./_engine.js");

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const report = doctor(context);
  const wired = report.publishers.filter((p) => p.wired).map((p) => p.id);
  const sources = report.images.filter((row) => row.enabled !== false && row.configured).map((row) => row.id);
  const lines = [];
  lines.push(report.chrome.ok ? "Rendering: ready (browser found)." : `Rendering: not ready. ${report.chrome.detail}`);
  lines.push(report.llm.ok ? `Copy drafting: uses ${report.llm.name}.` : "Copy drafting: no model key set, so drafts come from the built-in keyless fallback.");
  lines.push(sources.length ? `Background sources ready: ${sources.join(", ")}.` : "Background sources: none ready yet.");
  lines.push(wired.length ? `Publishers wired: ${wired.join(", ")}. Publishing still needs confirm: PUBLISH every time.` : "Publishers: none wired, so the engine can build and export but not post.");
  for (const p of report.publishers.filter((item) => !item.wired)) lines.push(`${p.id}: ${p.reason}`);
  return {
    status: "ok",
    reply: lines.join(" "),
    artifacts: [],
    metadata: { ...report, text: doctorText(report), networkCalls: 0 },
  };
};
