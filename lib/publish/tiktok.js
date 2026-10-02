"use strict";

// TikTok photo post through the Content Posting API. TikTok pulls the images
// from public URLs on a domain (or URL prefix) verified for the app.

const fs = require("node:fs");
const path = require("node:path");
const { request, failure, uncertain, unknownOutcome, sleep } = require("./http.js");
const { gateOpen, closedResult } = require("./gate.js");
const mediaHost = require("./media-host.js");

const id = "tiktok";
const label = "TikTok";
const REQUIRED_ENV = ["TIKTOK_ACCESS_TOKEN"];
const API = "https://open.tiktokapis.com";
const AUDIT_NOTE = "requires an audited TikTok app; unaudited apps can only post privately";
const PRIVACY_LEVELS = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
const MAX_TITLE = 90;
const MAX_DESCRIPTION = 4000;

function maxSlides(ctx) {
  const n = Number(ctx.target && ctx.target.maxSlides);
  return Number.isInteger(n) && n >= 1 ? n : 35;
}

function settings(ctx) {
  const target = ctx.target || {};
  return {
    privacyLevel: PRIVACY_LEVELS.includes(target.privacyLevel) ? target.privacyLevel : "SELF_ONLY",
    postMode: target.postMode === "MEDIA_UPLOAD" ? "MEDIA_UPLOAD" : "DIRECT_POST",
    autoAddMusic: target.autoAddMusic !== false,
    disableComment: Boolean(target.disableComment),
  };
}

function check(ctx = {}) {
  const env = ctx.env || {};
  const missing = REQUIRED_ENV.filter((name) => !String(env[name] || "").trim());
  if (missing.length) return { wired: false, missing, reason: `TikTok needs ${missing.join(" and ")} in the environment (a user token with the video.publish scope). Note: ${AUDIT_NOTE}.` };
  const host = mediaHost.check(ctx);
  if (!host.ok) return { wired: false, missing: [], reason: `TikTok pulls photos from public URLs on a domain verified for your app. ${host.reason} Note: ${AUDIT_NOTE}.` };
  return { wired: true, missing: [], reason: `Ready: Content Posting API photo post (privacy ${settings(ctx).privacyLevel}). Note: ${AUDIT_NOTE}.` };
}

function problems(payload, ctx) {
  const out = [];
  const count = (payload.files || []).length;
  if (count < 1) out.push("There are no images to post.");
  if (count > maxSlides(ctx)) out.push(`This export has ${count} slides and the TikTok limit here is ${maxSlides(ctx)} (TikTok takes 35 per photo post).`);
  for (const file of payload.files || []) if (!fs.existsSync(file)) out.push(`File not found: ${path.basename(String(file))}.`);
  return out;
}

function titleFor(payload) {
  const source = String(payload.title || "").trim() || String(payload.caption || "").split("\n")[0].trim();
  return source.slice(0, MAX_TITLE);
}

function resolveMedia(payload, ctx, prepare) {
  const target = ctx.target || {};
  return mediaHost.resolve(payload.files, { config: ctx.config, dataDir: ctx.dataDir, imageFormat: target.imageFormat || "jpeg", jpegQuality: target.jpegQuality, prepare });
}

function requestBody(payload, ctx, urls) {
  const s = settings(ctx);
  const postInfo = { title: titleFor(payload), description: String(payload.caption || "").slice(0, MAX_DESCRIPTION) };
  if (s.postMode === "DIRECT_POST") Object.assign(postInfo, { privacy_level: s.privacyLevel, disable_comment: s.disableComment, auto_add_music: s.autoAddMusic });
  return {
    post_info: postInfo,
    source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: urls },
    post_mode: s.postMode,
    media_type: "PHOTO",
  };
}

async function plan(payload, ctx = {}) {
  const found = problems(payload, ctx);
  const filesOk = found.every((p) => !p.startsWith("File not found"));
  const media = resolveMedia(payload, ctx, filesOk);
  const s = settings(ctx);
  const count = (payload.files || []).length;
  const steps = [];
  if (media.ok) {
    steps.push(`Make sure these ${media.items.length} files are reachable on a domain verified for your TikTok app:`);
    for (const item of media.items) steps.push(`  ${path.basename(item.upload)} -> ${item.url}`);
  } else {
    steps.push(`Public URLs: ${media.reason}`);
  }
  steps.push(`POST ${API}/v2/post/publish/creator_info/query/ (allowed privacy levels)`);
  steps.push(`POST ${API}/v2/post/publish/content/init/ (media_type PHOTO, post_mode ${s.postMode}${s.postMode === "DIRECT_POST" ? `, privacy_level ${s.privacyLevel}` : ""}, title "${titleFor(payload)}")`);
  steps.push(`POST ${API}/v2/post/publish/status/fetch/ (until TikTok finishes pulling the photos)`);
  return {
    summary: `Would ${s.postMode === "DIRECT_POST" ? `post a ${count} photo carousel to TikTok with privacy ${s.privacyLevel}` : `send a ${count} photo draft to the TikTok inbox`}. Note: ${AUDIT_NOTE}.`,
    steps,
    warnings: [],
    problems: found,
  };
}

function apiFailed(res) {
  const code = res.json && res.json.error && res.json.error.code;
  return !res.ok || (code && code !== "ok");
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
  const target = ctx.target || {};
  const blocked = await mediaHost.staleOrUnreachable(media, { fetchImpl: ctx.fetchImpl, verify: target.verifyUrls !== false });
  if (blocked) return blocked;
  const env = ctx.env || {};

  const headers = { Authorization: `Bearer ${String(env.TIKTOK_ACCESS_TOKEN).trim()}`, "Content-Type": "application/json; charset=UTF-8" };
  const post = (pathPart, body) => request(ctx.fetchImpl, `${API}${pathPart}`, { method: "POST", headers, body: JSON.stringify(body) });
  const s = settings(ctx);

  const creator = await post("/v2/post/publish/creator_info/query/", {});
  if (apiFailed(creator)) return { status: "error", detail: `${failure("TikTok creator check", creator, env)}. Nothing was posted.`, url: null };
  const info = (creator.json && creator.json.data) || {};
  const options = Array.isArray(info.privacy_level_options) ? info.privacy_level_options : null;
  if (s.postMode === "DIRECT_POST" && options && !options.includes(s.privacyLevel)) {
    return { status: "error", detail: `TikTok does not allow privacy level ${s.privacyLevel} for this account. Allowed: ${options.join(", ")}. Set targets.tiktok.privacyLevel in publishers.json. Nothing was posted.`, url: null };
  }

  const init = await post("/v2/post/publish/content/init/", requestBody(payload, ctx, urls));
  const publishId = init.json && init.json.data && init.json.data.publish_id;
  // No answer or a server error on the create call: the post may exist.
  if (uncertain(init)) return unknownOutcome(label, "TikTok post", init, env);
  if (apiFailed(init) || !publishId) return { status: "error", detail: `${failure("TikTok post", init, env)}. Nothing was posted.`, url: null };

  const checks = Number.isInteger(target.statusChecks) ? target.statusChecks : 5;
  const wait = ctx.sleepImpl || sleep;
  let status = null;
  let postId = null;
  for (let i = 0; i < checks; i += 1) {
    const res = await post("/v2/post/publish/status/fetch/", { publish_id: publishId });
    const data = (res.json && res.json.data) || {};
    if (data.status) status = data.status;
    const ids = data.publicaly_available_post_id || data.publicly_available_post_id;
    if (Array.isArray(ids) && ids.length) postId = String(ids[0]);
    if (status === "FAILED") return { status: "error", detail: `TikTok could not publish the photos (${data.fail_reason || "no reason given"}).`, url: null };
    if (status === "PUBLISH_COMPLETE" || status === "SEND_TO_USER_INBOX") break;
    if (i < checks - 1) await wait(Number(target.statusWaitMs) || 3000);
  }

  const url = postId && info.creator_username ? `https://www.tiktok.com/@${info.creator_username}/photo/${postId}` : null;
  if (status === "SEND_TO_USER_INBOX") return { status: "published", detail: `TikTok draft delivered to the account inbox (publish id ${publishId}). Finish the post in the TikTok app.`, url, postId: postId || publishId };
  if (status === "PUBLISH_COMPLETE") return { status: "published", detail: `TikTok photo post published with privacy ${s.privacyLevel} (publish id ${publishId}).`, url, postId: postId || publishId };
  // TikTok took the request but never reported a final state while we watched.
  // It may still finish or still fail, so this is not reported as published.
  return {
    status: "processing",
    detail: `TikTok accepted the post (publish id ${publishId}) but had not finished it after ${checks} status check${checks === 1 ? "" : "s"}${status ? ` (last state ${status})` : " (no status came back)"}. It may still go live or still fail: check the TikTok app before you retry, and do not post it again blind.`,
    url: null,
    postId: publishId,
  };
}

module.exports = { id, label, REQUIRED_ENV, AUDIT_NOTE, PRIVACY_LEVELS, check, plan, publish };
