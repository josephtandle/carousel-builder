"use strict";

// Publishes an exported carousel to the chosen platforms.
//
// Two steps, always:
//   1. Dry run (dryRun: true, or simply no confirm). Nothing is sent. The reply
//      describes exactly what would be sent and returns a confirmToken.
//   2. Publish: confirm: "PUBLISH" (the exact string) plus that confirmToken.
//      The token is a hash of the slides, the caption, the title and the
//      targets, so a confirmation only ever covers what the dry run showed.
// A dry run wins over a confirmation. Any dryRun value other than absent,
// false, "false", 0 or "" counts as a dry run.
// A dry run also writes the JPEG copies some platforms need, so they can be
// synced to the media host before confirming.
const engine = require("./_engine.js");

function raw(input, key) {
  if (input && input[key] !== undefined) return input[key];
  if (input && input.args && input.args[key] !== undefined) return input.args[key];
  return undefined;
}

module.exports.runRecipe = async function runRecipe(input = {}, context = {}) {
  const { value, contextOf, config, errorReply, resolveExport, ensurePdf, captionText } = engine;
  const publisher = require("../lib/publish/index.js");
  const guard = require("../lib/publish/export-guard.js");
  const ctx = contextOf(context);

  // Only an export id, or an export folder inside the data dir, with a passed layout check.
  const found = resolveExport(raw(input, "id") || raw(input, "exportDir"), ctx);
  if (!found.ok) return errorReply(found.reason, { published: false, ...(found.qaFailed ? { qaFailed: true, qaIssues: found.qaIssues || [] } : {}) });

  const rawTargets = value(input, "targets", value(input, "to", ""));
  const targets = (Array.isArray(rawTargets) ? rawTargets : typeof rawTargets === "string" ? rawTargets.split(",") : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const publishersConfig = config("publishers", ctx);
  const available = publisher.listPublishers({ config: publishersConfig, env: ctx.env, dataDir: ctx.dataDir });
  const chosen = [...new Set(targets.includes("all") ? available.filter((p) => p.wired).map((p) => p.id) : targets)];
  if (chosen.length === 0) {
    return errorReply(targets.includes("all") ? "No publisher is wired yet. Run the status recipe to see what each one needs." : `Say where to publish: targets, one or more of ${publisher.IDS.join(", ")} (or all for every wired one).`, { published: false, publishers: available });
  }

  let caption = raw(input, "caption");
  if (caption !== undefined && caption !== null && typeof caption !== "string") return errorReply("caption must be text.", { published: false });
  const captionFile = typeof raw(input, "captionFile") === "string" ? raw(input, "captionFile").trim() : "";
  if ((caption === undefined || caption === null) && captionFile) {
    // A small regular file inside the data dir, nothing else: a caption is public.
    const read = guard.readCaptionFile(captionFile, { dataDir: ctx.dataDir });
    if (!read.ok) return errorReply(`Could not use the caption file: ${read.reason} Caption files must be inside the data dir.`, { published: false });
    caption = read.caption;
  }
  if (caption === undefined || caption === null) caption = captionText(found.manifest.caption, found.manifest.hashtags);
  const givenTitle = raw(input, "title");
  const title = String((typeof givenTitle === "string" && givenTitle) || found.manifest.title || "Carousel");

  const wantsPdf = chosen.some((id) => (available.find((p) => p.id === id) || {}).format === "pdf");
  let pdf = found.pdf;
  if (wantsPdf && !pdf) {
    try {
      pdf = await ensurePdf(found, title);
    } catch (err) {
      return errorReply(`Could not build the PDF: ${String(err.message).split("\n")[0]}`, { published: false });
    }
  }

  // Raw values go straight through: the publisher decides, strictly.
  const confirm = raw(input, "confirm");
  const confirmToken = raw(input, "confirmToken");
  const dryRunValue = raw(input, "dryRun");
  const dryRunAlt = raw(input, "dry_run");
  const dryRun = publisher.isDryRun(dryRunValue) || publisher.isDryRun(dryRunAlt);
  const confirmed = confirm === publisher.CONFIRM_WORD;
  const request = { files: found.files, pdf, caption, title, targets: chosen };
  const options = { config: publishersConfig, env: ctx.env, fetchImpl: ctx.fetchImpl, dataDir: ctx.dataDir, sleepImpl: context.sleepImpl, runProcess: context.runProcess, now: ctx.now };
  const describe = (list) => list.map((r) => [`${r.id}: ${r.detail}`, ...(r.steps || []).map((step) => `    ${step}`)].join("\n")).join("\n");
  const howTo = (token) => `To publish exactly this, call again with confirm: ${publisher.CONFIRM_WORD} and confirmToken: ${token}`;

  if (dryRun || !confirmed) {
    const plan = await publisher.publish({ ...request, dryRun: true }, options);
    const token = (plan.find((r) => r.confirmToken) || {}).confirmToken || null;
    const metadata = { published: false, dryRun: true, confirmToken: token, targets: chosen, results: plan };
    if (dryRun) return { status: "ok", reply: `Dry run, nothing was sent.\n${describe(plan)}${token ? `\n${howTo(token)}` : ""}`, artifacts: [], metadata };
    return {
      status: "error",
      reply: `Publishing is irreversible. Confirm this exact request with confirm: PUBLISH. Nothing was sent.\n${describe(plan)}${token ? `\n${howTo(token)}` : ""}`,
      artifacts: [],
      metadata: { ...metadata, dryRun: false, confirmationRequired: publisher.CONFIRM_WORD },
    };
  }

  const results = await publisher.publish({ ...request, confirm, confirmToken, dryRun: dryRunValue, dry_run: dryRunAlt }, options);
  const token = (results.find((r) => r.confirmToken) || {}).confirmToken || null;
  if (results.length && results.every((r) => r.status === "refused")) {
    return {
      status: "error",
      reply: `Nothing was sent: the confirmToken is missing or does not match this exact request.\n${describe(results)}${token ? `\n${howTo(token)}` : ""}`,
      artifacts: [],
      metadata: { published: false, confirmationRequired: publisher.CONFIRM_WORD, confirmTokenRequired: true, confirmToken: token, targets: chosen, results },
    };
  }
  const done = results.filter((r) => r.status === "published");
  const unsure = results.filter((r) => r.status === "unknown" || r.status === "processing");
  const lines = results.map((r) => `${r.id}: ${r.status}${r.url ? ` ${r.url}` : ""}${r.status === "published" ? "" : `. ${r.detail}`}`);
  return {
    status: done.length === results.length ? "ok" : "error",
    reply: `${done.length} of ${results.length} published.${unsure.length ? ` ${unsure.length} not confirmed: check ${unsure.map((r) => r.id).join(", ")} before retrying.` : ""}\n${lines.join("\n")}`,
    artifacts: [],
    metadata: { published: done.length > 0, publishedTo: done.map((r) => r.id), unconfirmed: unsure.map((r) => r.id), results },
  };
};
