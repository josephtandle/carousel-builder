"use strict";

// Instagram carousel. Two transports:
//   sibling: hand off to the All Sorted `instagram` module's post-carousel
//            recipe when it is installed under ALLSORTED_ROOT (preferred)
//   graph:   the official Graph API container flow (child containers from
//            public image URLs, a carousel container, then publish)
// Both need public https image URLs, which come from media-host.js.

const fs = require("node:fs");
const path = require("node:path");
const { request, failure, uncertain, unknownOutcome, sleep } = require("./http.js");
const { gateOpen, closedResult } = require("./gate.js");
const mediaHost = require("./media-host.js");

const id = "instagram";
const label = "Instagram";
const REQUIRED_ENV = ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"];
const API_LIMIT = 10; // the Graph API caps a carousel at 10 items even though the app allows 20
const MAX_CAPTION = 2200;
const SIBLING_PATHS = [
  ["instagram-agent", "recipes", "post-carousel.js"],
  ["agents", "instagram-agent", "recipes", "post-carousel.js"],
  ["agents", "instagram", "recipes", "post-carousel.js"],
  ["instagram", "recipes", "post-carousel.js"],
  ["modules", "instagram", "recipes", "post-carousel.js"],
];

function credentials(env = {}) {
  return {
    token: String(env.INSTAGRAM_ACCESS_TOKEN || env.META_IG_ACCESS_TOKEN || "").trim(),
    userId: String(env.INSTAGRAM_USER_ID || env.META_IG_ACCOUNT_ID || "").trim(),
  };
}

// Returns the absolute, symlink-resolved path of the sibling recipe, or null.
// ALLSORTED_ROOT must be an absolute path: a relative one would be resolved
// against whatever folder the engine happens to run in.
function findSibling(ctx = {}) {
  const root = String((ctx.env && ctx.env.ALLSORTED_ROOT) || "").trim();
  if (!root || !path.isAbsolute(root)) return null;
  const exists = ctx.existsImpl || fs.existsSync;
  for (const parts of SIBLING_PATHS) {
    const candidate = path.join(root, ...parts);
    if (!exists(candidate)) continue;
    if (ctx.existsImpl) return candidate;
    try {
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(candidate);
      if (real.startsWith(realRoot + path.sep) && fs.statSync(real).isFile()) return real;
    } catch {
      // Not a usable file: keep looking.
    }
  }
  return null;
}

// The only variables the sibling module's child process receives. Tokens for
// the other platforms never leave this process.
const SIBLING_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "PYTHON3", "PYTHONPATH", "VIRTUAL_ENV", "META_IG_ACCESS_TOKEN", "META_IG_ACCOUNT_ID", "IG_USERNAME", "IG_PASSWORD", "IG_SESSION_PATH"];

function siblingEnv(env = {}) {
  const out = {};
  for (const name of SIBLING_ENV) if (env[name] !== undefined && env[name] !== "") out[name] = String(env[name]);
  return out;
}

function siblingHasCredentials(env = {}) {
  const has = (name) => Boolean(String(env[name] || "").trim());
  return (has("META_IG_ACCESS_TOKEN") && has("META_IG_ACCOUNT_ID")) || (has("IG_USERNAME") && has("IG_PASSWORD"));
}

function maxSlides(ctx) {
  const n = Number(ctx.target && ctx.target.maxSlides);
  return Number.isInteger(n) && n >= 2 ? n : API_LIMIT;
}

const API_HOSTS = ["https://graph.facebook.com", "https://graph.instagram.com"];
const DEFAULT_VERSION = "v24.0";

// The token only ever goes to a real Graph API host: a config file cannot
// point it anywhere else.
function endpoint(ctx) {
  const target = (ctx && ctx.target) || {};
  const base = String(target.apiBase || API_HOSTS[0]).replace(/\/+$/, "");
  const version = String(target.graphVersion || DEFAULT_VERSION);
  if (!API_HOSTS.includes(base)) return { ok: false, reason: `targets.instagram.apiBase must be ${API_HOSTS.join(" or ")}. The access token is never sent to any other host.` };
  if (!/^v\d+\.\d+$/.test(version)) return { ok: false, reason: "targets.instagram.graphVersion must look like v24.0." };
  return { ok: true, url: `${base}/${version}` };
}

function graphBase(ctx) {
  const point = endpoint(ctx);
  return point.ok ? point.url : `${API_HOSTS[0]}/${DEFAULT_VERSION}`;
}

// Picks the transport and says whether it can run.
function check(ctx = {}) {
  const env = ctx.env || {};
  const wanted = (ctx.target && ctx.target.transport) || "auto";
  const sibling = wanted === "graph" ? null : findSibling(ctx);
  const { token, userId } = credentials(env);
  const missing = [];
  if (!token) missing.push("INSTAGRAM_ACCESS_TOKEN");
  if (!userId) missing.push("INSTAGRAM_USER_ID");
  const graphReady = missing.length === 0;
  const siblingReady = Boolean(sibling) && siblingHasCredentials(env);

  let transport = null;
  if (wanted === "sibling") transport = siblingReady ? "sibling" : null;
  else if (wanted === "graph") transport = graphReady ? "graph" : null;
  else transport = siblingReady ? "sibling" : graphReady ? "graph" : null;

  if (!transport) {
    if (wanted === "sibling") {
      const why = sibling ? "its credentials are not in the environment (META_IG_ACCESS_TOKEN and META_IG_ACCOUNT_ID)" : "no instagram module was found under ALLSORTED_ROOT";
      return { wired: false, transport: null, sibling, missing: [], reason: `Instagram is set to the sibling module transport, but ${why}.` };
    }
    return { wired: false, transport: null, sibling, missing, reason: `Instagram needs ${missing.join(" and ")} in the environment (a professional account connected to the Graph API with the content publishing permission).` };
  }
  if (transport === "graph") {
    const point = endpoint(ctx);
    if (!point.ok) return { wired: false, transport, sibling, missing: [], reason: point.reason };
  }
  const host = mediaHost.check(ctx);
  if (!host.ok) return { wired: false, transport, sibling, missing: [], reason: `Instagram only accepts images from public URLs. ${host.reason}` };
  return {
    wired: true,
    transport,
    sibling,
    missing: [],
    reason: transport === "sibling" ? "Ready: hands off to the installed instagram module's post-carousel recipe." : "Ready: Graph API carousel from public image URLs.",
  };
}

function problems(payload, ctx) {
  const out = [];
  const count = (payload.files || []).length;
  const limit = maxSlides(ctx);
  if (count < 2) out.push("An Instagram carousel needs at least 2 images.");
  if (count > limit) out.push(`This export has ${count} slides and the Instagram limit here is ${limit} (the Graph API takes 10 per carousel). Trim the deck: slides are never dropped silently.`);
  if (String(payload.caption || "").length > MAX_CAPTION) out.push(`The caption is longer than Instagram's ${MAX_CAPTION} characters.`);
  for (const file of payload.files || []) if (!fs.existsSync(file)) out.push(`File not found: ${path.basename(String(file))}.`);
  return out;
}

function ratioWarnings(payload) {
  const first = (payload.files || [])[0];
  if (!first || !/\.png$/i.test(String(first)) || !fs.existsSync(first)) return [];
  try {
    const { width, height } = require("../pdf.js").pngSize(first);
    const ratio = width / height;
    if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) return [`Slides are ${width}x${height}. Instagram feed carousels take 4:5 to 1.91:1, so use the portrait or square size.`];
  } catch {
    // Not a readable PNG: the platform will have the last word.
  }
  return [];
}

function resolveMedia(payload, ctx, prepare) {
  const target = ctx.target || {};
  return mediaHost.resolve(payload.files, {
    config: ctx.config,
    dataDir: ctx.dataDir,
    imageFormat: target.imageFormat || "jpeg",
    jpegQuality: target.jpegQuality,
    prepare,
  });
}

async function plan(payload, ctx = {}) {
  const state = check(ctx);
  const found = problems(payload, ctx);
  const filesOk = found.every((p) => !p.startsWith("File not found"));
  const media = resolveMedia(payload, ctx, filesOk);
  const count = (payload.files || []).length;
  const transport = state.transport || ((ctx.target && ctx.target.transport) === "sibling" ? "sibling" : "graph");
  const steps = [];
  if (media.ok) {
    steps.push(`Make sure these ${media.items.length} files are reachable (sync the exports dir to your media host first):`);
    for (const item of media.items) steps.push(`  ${path.basename(item.upload)} -> ${item.url}`);
  } else {
    steps.push(`Public URLs: ${media.reason}`);
  }
  if (transport === "sibling") {
    steps.push(`Call the instagram module recipe post-carousel with ${count} imageUrls, the caption and confirm: PUBLISH`);
  } else {
    const base = graphBase(ctx);
    const user = credentials(ctx.env).userId || "<INSTAGRAM_USER_ID>";
    steps.push(`POST ${base}/${user}/media once per image (image_url, is_carousel_item: true)`);
    steps.push(`POST ${base}/${user}/media (media_type CAROUSEL, children, caption)`);
    steps.push(`POST ${base}/${user}/media_publish (creation_id)`);
  }
  return {
    summary: `Would publish a ${count} image carousel to Instagram ${transport === "sibling" ? "through the installed instagram module" : "through the Graph API"} with a ${String(payload.caption || "").length} character caption.`,
    steps,
    warnings: ratioWarnings(payload),
    problems: found,
  };
}

function defaultRunProcess(env) {
  return (command, args, options = {}) =>
    new Promise((resolve) => {
      const { execFile } = require("node:child_process");
      execFile(command, args, { cwd: options.cwd, env: siblingEnv(env), timeout: options.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
}

async function publishSibling(payload, ctx, urls, recipePath) {
  let recipe;
  try {
    recipe = (ctx.requireImpl || require)(recipePath);
  } catch (err) {
    return { status: "error", detail: `Could not load the instagram module recipe: ${String(err.message).split("\n")[0]}. Nothing was sent.`, url: null };
  }
  if (!recipe || typeof recipe.runRecipe !== "function") return { status: "error", detail: "The instagram module recipe does not export runRecipe.", url: null };
  try {
    const out = await recipe.runRecipe({ imageUrls: urls, caption: String(payload.caption || ""), confirm: "PUBLISH" }, { runProcess: ctx.runProcess || defaultRunProcess(ctx.env) });
    const meta = (out && out.metadata) || {};
    if (!out || out.status !== "ok" || meta.published === false) return { status: "error", detail: `Instagram module: ${(out && out.reply) || "no reply"}`, url: null };
    const result = meta.result || {};
    return { status: "published", detail: (out.reply || "Instagram carousel published.").trim(), url: result.permalink || result.url || null, postId: result.mediaId || null };
  } catch (err) {
    // The recipe threw part way through, so the post may already be live. No
    // automatic retry and no fallback to the other transport.
    return { status: "unknown", detail: `Instagram module failed: ${String(err.message).split("\n")[0]}. The post may or may not be live. Check the account before you retry so it is not doubled.`, url: null };
  }
}

async function publishGraph(payload, ctx, urls) {
  const { token, userId } = credentials(ctx.env);
  const base = graphBase(ctx);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (pathPart, body) => request(ctx.fetchImpl, `${base}/${pathPart}`, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (pathPart) => request(ctx.fetchImpl, `${base}/${pathPart}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });

  const children = [];
  for (let i = 0; i < urls.length; i += 1) {
    const res = await post(`${userId}/media`, { image_url: urls[i], is_carousel_item: true });
    if (!res.ok || !res.json || !res.json.id) return { status: "error", detail: `${failure(`Instagram image ${i + 1} of ${urls.length}`, res, ctx.env)}. Nothing was published.`, url: null };
    children.push(String(res.json.id));
  }
  const container = await post(`${userId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: String(payload.caption || "") });
  if (!container.ok || !container.json || !container.json.id) return { status: "error", detail: `${failure("Instagram carousel container", container, ctx.env)}. Nothing was published.`, url: null };
  const creationId = String(container.json.id);

  const target = ctx.target || {};
  const checks = Number.isInteger(target.statusChecks) ? target.statusChecks : 5;
  const wait = ctx.sleepImpl || sleep;
  for (let i = 0; i < checks; i += 1) {
    const status = await get(`${creationId}?fields=status_code`);
    const code = status.json && status.json.status_code;
    if (code === "ERROR" || code === "EXPIRED") return { status: "error", detail: `Instagram could not process the carousel (status ${code}). Nothing was published.`, url: null };
    if (code !== "IN_PROGRESS") break;
    await wait(Number(target.statusWaitMs) || 2000);
  }

  const published = await post(`${userId}/media_publish`, { creation_id: creationId });
  // No answer or a server error on the publish call: the post may exist.
  if (uncertain(published)) return unknownOutcome(label, "Instagram publish", published, ctx.env);
  if (!published.ok || !published.json || !published.json.id) return { status: "error", detail: `${failure("Instagram publish", published, ctx.env)}. Instagram rejected the publish call, so nothing is live.`, url: null };
  const mediaId = String(published.json.id);
  const link = await get(`${mediaId}?fields=permalink`);
  const url = (link.ok && link.json && link.json.permalink) || null;
  return { status: "published", detail: `Instagram carousel published (media id ${mediaId}).`, url, postId: mediaId };
}

async function publish(payload, ctx = {}) {
  if (!gateOpen(ctx)) return closedResult(label);
  const state = check(ctx);
  if (!state.wired) return { status: "not_wired", detail: state.reason, url: null };
  const found = problems(payload, ctx);
  if (found.length) return { status: "error", detail: found.join(" "), url: null };
  const media = resolveMedia(payload, ctx, true);
  if (!media.ok) return { status: "error", detail: media.reason, url: null };
  const urls = media.items.map((item) => item.url);
  const blocked = await mediaHost.staleOrUnreachable(media, { fetchImpl: ctx.fetchImpl, verify: !ctx.target || ctx.target.verifyUrls !== false });
  if (blocked) return blocked;
  if (state.transport === "sibling") return publishSibling(payload, ctx, urls, state.sibling);
  return publishGraph(payload, ctx, urls);
}

module.exports = { id, label, REQUIRED_ENV, API_LIMIT, SIBLING_PATHS, SIBLING_ENV, API_HOSTS, findSibling, siblingEnv, check, plan, publish };
