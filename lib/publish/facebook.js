"use strict";

// Facebook Page multi-photo post: upload every photo unpublished, then one
// feed post that attaches them. Photos are uploaded straight from disk, so no
// public URLs are needed unless needsPublicUrls is switched on.

const fs = require("node:fs");
const path = require("node:path");
const { request, failure, uncertain, unknownOutcome } = require("./http.js");
const { gateOpen, closedResult } = require("./gate.js");
const mediaHost = require("./media-host.js");

const id = "facebook";
const label = "Facebook";
const REQUIRED_ENV = ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"];

const API_HOSTS = ["https://graph.facebook.com"];
const DEFAULT_VERSION = "v24.0";

// The token only ever goes to the real Graph API host: a config file cannot
// point it anywhere else.
function endpoint(ctx) {
  const target = (ctx && ctx.target) || {};
  const base = String(target.apiBase || API_HOSTS[0]).replace(/\/+$/, "");
  const version = String(target.graphVersion || DEFAULT_VERSION);
  if (!API_HOSTS.includes(base)) return { ok: false, reason: `targets.facebook.apiBase must be ${API_HOSTS.join(" or ")}. The access token is never sent to any other host.` };
  if (!/^v\d+\.\d+$/.test(version)) return { ok: false, reason: "targets.facebook.graphVersion must look like v24.0." };
  return { ok: true, url: `${base}/${version}` };
}

function graphBase(ctx) {
  const point = endpoint(ctx);
  return point.ok ? point.url : `${API_HOSTS[0]}/${DEFAULT_VERSION}`;
}

function maxSlides(ctx) {
  const n = Number(ctx.target && ctx.target.maxSlides);
  return Number.isInteger(n) && n >= 1 ? n : 10;
}

function usesUrls(ctx) {
  return Boolean(ctx.target && ctx.target.needsPublicUrls);
}

function check(ctx = {}) {
  const env = ctx.env || {};
  const missing = REQUIRED_ENV.filter((name) => !String(env[name] || "").trim());
  if (missing.length) return { wired: false, missing, reason: `Facebook needs ${missing.join(" and ")} in the environment (a Page access token with pages_manage_posts and pages_read_engagement).` };
  const point = endpoint(ctx);
  if (!point.ok) return { wired: false, missing: [], reason: point.reason };
  if (usesUrls(ctx)) {
    const host = mediaHost.check(ctx);
    if (!host.ok) return { wired: false, missing: [], reason: `Facebook is set to needsPublicUrls. ${host.reason}` };
  }
  return { wired: true, missing: [], reason: `Ready: Page multi-photo post (${usesUrls(ctx) ? "photos pulled from public URLs" : "photos uploaded from disk"}).` };
}

function problems(payload, ctx) {
  const out = [];
  const count = (payload.files || []).length;
  if (count < 1) out.push("There are no images to post.");
  if (count > maxSlides(ctx)) out.push(`This export has ${count} slides and the Facebook limit here is ${maxSlides(ctx)}. Trim the deck or raise targets.facebook.maxSlides.`);
  for (const file of payload.files || []) if (!fs.existsSync(file)) out.push(`File not found: ${path.basename(String(file))}.`);
  return out;
}

async function plan(payload, ctx = {}) {
  const base = graphBase(ctx);
  const page = String((ctx.env && ctx.env.FACEBOOK_PAGE_ID) || "").trim() || "<FACEBOOK_PAGE_ID>";
  const count = (payload.files || []).length;
  const steps = [];
  if (usesUrls(ctx)) {
    const media = mediaHost.resolve(payload.files, { config: ctx.config, dataDir: ctx.dataDir, imageFormat: "png", prepare: false });
    if (media.ok) for (const item of media.items) steps.push(`POST ${base}/${page}/photos (url ${item.url}, published: false)`);
    else steps.push(`Public URLs: ${media.reason}`);
  } else {
    for (const file of payload.files || []) steps.push(`POST ${base}/${page}/photos (upload ${path.basename(String(file))}, published: false)`);
  }
  steps.push(`POST ${base}/${page}/feed (message, attached_media with the ${count} photo ids)`);
  return {
    summary: `Would publish a ${count} photo post to Facebook Page ${page} with a ${String(payload.caption || "").length} character message.`,
    steps,
    warnings: [],
    problems: problems(payload, ctx),
  };
}

function photoBody(file) {
  const form = new FormData();
  form.append("published", "false");
  form.append("source", new Blob([fs.readFileSync(file)], { type: /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png" }), path.basename(file));
  return form;
}

async function publish(payload, ctx = {}) {
  if (!gateOpen(ctx)) return closedResult(label);
  const state = check(ctx);
  if (!state.wired) return { status: "not_wired", detail: state.reason, url: null };
  const found = problems(payload, ctx);
  if (found.length) return { status: "error", detail: found.join(" "), url: null };
  const env = ctx.env || {};
  const pageId = String(env.FACEBOOK_PAGE_ID).trim();
  const auth = { Authorization: `Bearer ${String(env.FACEBOOK_PAGE_ACCESS_TOKEN).trim()}` };
  const base = graphBase(ctx);

  let urls = null;
  if (usesUrls(ctx)) {
    const media = mediaHost.resolve(payload.files, { config: ctx.config, dataDir: ctx.dataDir, imageFormat: "png" });
    if (!media.ok) return { status: "error", detail: media.reason, url: null };
    urls = media.items.map((item) => item.url);
    const blocked = await mediaHost.staleOrUnreachable(media, { fetchImpl: ctx.fetchImpl, verify: ctx.target.verifyUrls !== false });
    if (blocked) return blocked;
  }

  const photoIds = [];
  for (let i = 0; i < payload.files.length; i += 1) {
    const init = urls
      ? { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ url: urls[i], published: false }) }
      : { method: "POST", headers: auth, body: photoBody(payload.files[i]), timeoutMs: 180000 };
    const res = await request(ctx.fetchImpl, `${base}/${pageId}/photos`, init);
    if (!res.ok || !res.json || !res.json.id) {
      return { status: "error", detail: `${failure(`Facebook photo ${i + 1} of ${payload.files.length}`, res, env)}. No post was created${photoIds.length ? "; the photos already uploaded stay unpublished" : ""}.`, url: null };
    }
    photoIds.push(String(res.json.id));
  }

  const post = await request(ctx.fetchImpl, `${base}/${pageId}/feed`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message: String(payload.caption || ""), attached_media: photoIds.map((photoId) => ({ media_fbid: photoId })) }),
  });
  // No answer or a server error on the create call: the post may exist.
  if (uncertain(post)) return unknownOutcome(label, "Facebook post", post, env);
  if (!post.ok || !post.json || !post.json.id) return { status: "error", detail: `${failure("Facebook post", post, env)}. The photos were uploaded unpublished but Facebook rejected the post, so nothing is live.`, url: null };
  const postId = String(post.json.id);
  return { status: "published", detail: `Facebook Page post published (${postId}) with ${photoIds.length} photos.`, url: `https://www.facebook.com/${postId}`, postId };
}

module.exports = { id, label, REQUIRED_ENV, check, plan, publish };
