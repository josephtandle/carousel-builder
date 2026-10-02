"use strict";

// Publisher registry and the one public way to publish.
//
// The rules, all enforced here:
//   1. A dry run always wins. Any dryRun (or dry_run) value other than
//      absent, false, "false", 0 or "" is a dry run: nothing is sent and each
//      target comes back as "dry_run" with a description of exactly what would
//      be sent, plus a confirmToken.
//   2. Without confirm === "PUBLISH" (the exact string) every target is
//      "refused".
//   3. A confirmed publish must also carry the confirmToken of a dry run of
//      this exact request (same slides, PDF, caption, title and targets).
//      Without a matching token it is refused, with the description and the
//      current token, so the caller can show it and confirm again.
//   4. Only slides inside the data dir, listed in an export manifest that
//      passed the layout check, can be published (see export-guard.js).
// Credentials are only ever read from the env object passed in; this module
// never opens a .env file.

const path = require("node:path");
const gate = require("./gate.js");
const guard = require("./export-guard.js");
const { redact } = require("./http.js");

const IDS = ["instagram", "linkedin", "facebook", "tiktok"];
const { CONFIRM_WORD, isDryRun } = gate;
const STATUSES = ["published", "dry_run", "refused", "not_wired", "error", "unknown", "processing"];

const DEFAULT_CONFIG = {
  mediaHost: { kind: "none", urlPrefix: "" },
  targets: {
    instagram: { enabled: true, transport: "auto", format: "images", maxSlides: 10, needsPublicUrls: true, imageFormat: "jpeg" },
    linkedin: { enabled: true, transport: "rest", format: "pdf", maxSlides: 300, needsPublicUrls: false },
    facebook: { enabled: true, transport: "graph", format: "images", maxSlides: 10, needsPublicUrls: false },
    tiktok: { enabled: true, transport: "content-posting", format: "images", maxSlides: 35, needsPublicUrls: true, imageFormat: "jpeg", privacyLevel: "SELF_ONLY" },
  },
};

function adapter(id) {
  switch (id) {
    case "instagram":
      return require("./instagram.js");
    case "linkedin":
      return require("./linkedin.js");
    case "facebook":
      return require("./facebook.js");
    case "tiktok":
      return require("./tiktok.js");
    default:
      return null;
  }
}

function normalizeConfig(config) {
  const given = config && typeof config === "object" ? config : {};
  const targets = {};
  for (const id of IDS) targets[id] = { ...DEFAULT_CONFIG.targets[id], ...((given.targets && given.targets[id]) || {}) };
  return { ...given, mediaHost: { ...DEFAULT_CONFIG.mediaHost, ...(given.mediaHost || {}) }, targets };
}

function stateOf(id, ctx) {
  if (!ctx.target.enabled) return { wired: false, missing: [], reason: `${adapter(id).label} is switched off (targets.${id}.enabled is false in publishers.json).` };
  return adapter(id).check(ctx);
}

// listPublishers({ config, env }) -> [ { id, wired, reason, ... } ]
function listPublishers(opts = {}) {
  const config = normalizeConfig(opts.config);
  const env = opts.env || process.env;
  return IDS.map((id) => {
    const target = config.targets[id];
    const state = stateOf(id, { config, env, target, dataDir: opts.dataDir, now: opts.now, existsImpl: opts.existsImpl });
    return {
      id,
      wired: Boolean(state.wired),
      reason: state.reason,
      enabled: Boolean(target.enabled),
      missing: state.missing || [],
      transport: state.transport || target.transport || null,
      format: target.format,
      maxSlides: target.maxSlides,
      needsPublicUrls: Boolean(target.needsPublicUrls),
    };
  });
}

function targetList(targets) {
  const list = Array.isArray(targets) ? targets : typeof targets === "string" ? targets.split(",") : [];
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

function writeLog(entry, dataDir) {
  try {
    require("../store.js").appendPublishLog(entry, { dataDir });
    return true;
  } catch {
    return false;
  }
}

// confirmTokenFor(request, { dataDir }) -> token string, or null when the
// request is not publishable (the reason comes back from publish itself).
function confirmTokenFor(req = {}, opts = {}) {
  const checked = guard.inspect(Array.isArray(req.files) ? req.files : [], req.pdf || null, { dataDir: opts.dataDir });
  if (!checked.ok) return null;
  return guard.confirmToken({ files: checked.files, pdf: checked.pdf, caption: String(req.caption || ""), title: req.title ? String(req.title) : "", targets: targetList(req.targets) });
}

// publish({ files, pdf, caption, title, targets, confirm, confirmToken, dryRun }, { config, env, fetchImpl, dataDir })
// -> Promise<[ { id, status, detail, url, ... } ]>
// status: "published" | "dry_run" | "refused" | "not_wired" | "error" | "unknown" | "processing"
//   unknown:    the platform did not confirm the final call. Check the account before retrying.
//   processing: TikTok accepted the post but had not finished it when polling stopped.
async function publish(req = {}, opts = {}) {
  const config = normalizeConfig(opts.config);
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : undefined);
  const targets = targetList(req.targets);
  const dryRun = isDryRun(req.dryRun) || isDryRun(req.dry_run);
  const confirmed = gate.isConfirmed(req.confirm);
  const caption = String(req.caption || "");
  const title = req.title ? String(req.title) : "";
  const givenFiles = Array.isArray(req.files) ? req.files.map((f) => String(f)) : [];

  // Containment, manifest and layout check, before anything is read or decoded.
  const checked = guard.inspect(givenFiles, req.pdf || null, { dataDir: opts.dataDir });
  const payload = checked.ok ? { files: checked.files, pdf: checked.pdf, caption, title } : null;
  const token = payload ? guard.confirmToken({ ...payload, targets }) : null;
  const tokenMatches = Boolean(token) && typeof req.confirmToken === "string" && req.confirmToken === token;

  const results = [];
  for (const id of targets) {
    let result;
    const impl = adapter(id);
    if (!impl) {
      result = { id, status: "error", detail: `Unknown target "${id}". Known targets: ${IDS.join(", ")}.`, url: null };
    } else if (!dryRun && !confirmed) {
      result = { id, status: "refused", detail: `Nothing was sent. Publishing is irreversible and reaches a real audience: run a dry run (dryRun: true) to see exactly what would be sent, then pass confirm: "${CONFIRM_WORD}" with that dry run's confirmToken.`, url: null };
    } else if (!payload) {
      result = { id, status: "error", detail: `${checked.reason} Nothing was sent.`, url: null };
      if (checked.qaFailed) result.qaFailed = true;
    } else {
      const ctx = {
        config,
        env,
        fetchImpl,
        target: config.targets[id],
        dataDir: opts.dataDir,
        now: opts.now,
        sleepImpl: opts.sleepImpl,
        runProcess: opts.runProcess,
        requireImpl: opts.requireImpl,
        existsImpl: opts.existsImpl,
        // The adapters check the gate again themselves.
        confirm: dryRun || !tokenMatches ? undefined : req.confirm,
        dryRun,
      };
      try {
        const state = stateOf(id, ctx);
        if (dryRun || !tokenMatches) {
          const plan = await impl.plan(payload, ctx);
          const notes = [];
          if (!dryRun) notes.push(`Nothing was sent. The confirmToken ${typeof req.confirmToken === "string" && req.confirmToken ? "does not match this request (the slides, caption, title or targets changed since the dry run)" : "is missing"}. Review what would be sent and confirm again with the confirmToken returned here.`);
          notes.push(plan.summary);
          if (plan.problems.length) notes.push(`Would fail as it stands: ${plan.problems.join(" ")}`);
          if (plan.warnings.length) notes.push(plan.warnings.join(" "));
          if (dryRun) notes.push(state.wired ? "Dry run: nothing was sent." : `Dry run: nothing was sent. Not wired yet: ${state.reason}`);
          else if (!state.wired) notes.push(`Not wired yet: ${state.reason}`);
          result = { id, status: dryRun ? "dry_run" : "refused", detail: notes.join(" "), url: null, wired: Boolean(state.wired), steps: plan.steps, problems: plan.problems, warnings: plan.warnings, confirmToken: token };
        } else if (!state.wired) {
          result = { id, status: "not_wired", detail: state.reason, url: null };
        } else {
          const out = await impl.publish(payload, ctx);
          result = { id, status: STATUSES.includes(out.status) ? out.status : "error", detail: out.detail, url: out.url || null };
          if (out.postId) result.postId = out.postId;
        }
      } catch (err) {
        result = { id, status: "error", detail: `${impl.label} publisher crashed: ${String((err && err.message) || err).split("\n")[0]}`, url: null };
      }
    }
    result.detail = redact(result.detail, env);
    if (Array.isArray(result.steps)) result.steps = result.steps.map((s) => redact(s, env));
    result.logged = writeLog(
      {
        target: id,
        status: result.status,
        detail: result.detail,
        url: result.url,
        dryRun,
        confirmed,
        tokenMatched: tokenMatches,
        slides: givenFiles.length,
        pdf: req.pdf ? path.basename(String(req.pdf)) : null,
        source: givenFiles.length ? path.basename(path.dirname(path.resolve(givenFiles[0]))) : null,
        title: title || null,
        captionChars: caption.length,
      },
      opts.dataDir
    );
    results.push(result);
  }
  return results;
}

module.exports = { IDS, CONFIRM_WORD, STATUSES, DEFAULT_CONFIG, listPublishers, publish, confirmTokenFor, isDryRun, normalizeConfig, redact };
