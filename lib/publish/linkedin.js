"use strict";

// LinkedIn document post (the swipeable PDF carousel) over the versioned REST
// API: initialize the upload, PUT the PDF, then create the post.

const fs = require("node:fs");
const path = require("node:path");
const { request, header, failure, uncertain, unknownOutcome } = require("./http.js");
const { gateOpen, closedResult } = require("./gate.js");

const id = "linkedin";
const label = "LinkedIn";
const REQUIRED_ENV = ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"];
const API = "https://api.linkedin.com";
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_COMMENTARY = 3000;

// LinkedIn publishes one API version a month and retires each after about a
// year. Last month's version is always live, so that is the default.
function apiVersion(now = new Date(), override) {
  if (override && /^\d{6}$/.test(String(override))) return String(override);
  const d = now instanceof Date ? now : new Date(now);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Post commentary uses LinkedIn's "little text" format, where these
// characters are syntax. Hashtags (#) are left alone so they still link.
function escapeCommentary(text) {
  return String(text || "").replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}

function versionFor(ctx) {
  return apiVersion(ctx.now, (ctx.target && ctx.target.apiVersion) || (ctx.env && ctx.env.LINKEDIN_API_VERSION));
}

function check(ctx = {}) {
  const env = ctx.env || {};
  const missing = REQUIRED_ENV.filter((name) => !String(env[name] || "").trim());
  if (missing.length) return { wired: false, missing, reason: `LinkedIn needs ${missing.join(" and ")} in the environment. The token needs the w_member_social scope (or w_organization_social for a company page) and the author URN looks like urn:li:person:<id> or urn:li:organization:<id>.` };
  if (!/^urn:li:(person|organization):[^\s]+$/.test(String(env.LINKEDIN_AUTHOR_URN).trim())) {
    return { wired: false, missing: [], reason: "LINKEDIN_AUTHOR_URN must look like urn:li:person:<id> or urn:li:organization:<id>." };
  }
  return { wired: true, missing: [], reason: `Ready: document post over the LinkedIn REST API (version ${versionFor(ctx)}).` };
}

function problems(payload) {
  const out = [];
  if (!payload.pdf) out.push("LinkedIn posts the carousel as a PDF document, and no PDF was given.");
  else if (!fs.existsSync(payload.pdf)) out.push(`PDF not found: ${path.basename(String(payload.pdf))}.`);
  else if (fs.statSync(payload.pdf).size > MAX_PDF_BYTES) out.push("The PDF is larger than LinkedIn's 100 MB limit.");
  if ((payload.files || []).length > MAX_PAGES) out.push(`LinkedIn documents take at most ${MAX_PAGES} pages.`);
  if (String(payload.caption || "").length > MAX_COMMENTARY) out.push(`The caption is longer than LinkedIn's ${MAX_COMMENTARY} characters.`);
  return out;
}

async function plan(payload, ctx = {}) {
  const author = String((ctx.env && ctx.env.LINKEDIN_AUTHOR_URN) || "").trim() || "<LINKEDIN_AUTHOR_URN>";
  const version = versionFor(ctx);
  const pdfName = payload.pdf ? path.basename(String(payload.pdf)) : "<no PDF>";
  const pages = (payload.files || []).length;
  return {
    summary: `Would post ${pdfName}${pages ? ` (${pages} pages)` : ""} to LinkedIn as a document post by ${author}, visible to everyone, titled "${payload.title || "Carousel"}", with a ${String(payload.caption || "").length} character caption (LinkedIn-Version ${version}).`,
    steps: [
      `POST ${API}/rest/documents?action=initializeUpload (owner ${author})`,
      `PUT ${pdfName} to the upload URL LinkedIn returns`,
      `POST ${API}/rest/posts (document post, visibility PUBLIC, lifecycleState PUBLISHED)`,
    ],
    warnings: [],
    problems: problems(payload),
  };
}

function isLinkedInHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(linkedin\.com|licdn\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function publish(payload, ctx = {}) {
  if (!gateOpen(ctx)) return closedResult(label);
  const state = check(ctx);
  if (!state.wired) return { status: "not_wired", detail: state.reason, url: null };
  const found = problems(payload);
  if (found.length) return { status: "error", detail: found.join(" "), url: null };
  const env = ctx.env || {};
  const token = String(env.LINKEDIN_ACCESS_TOKEN).trim();
  const author = String(env.LINKEDIN_AUTHOR_URN).trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": versionFor(ctx),
    "X-Restli-Protocol-Version": "2.0.0",
  };

  const init = await request(ctx.fetchImpl, `${API}/rest/documents?action=initializeUpload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
  });
  if (!init.ok) return { status: "error", detail: `${failure("LinkedIn upload setup", init, env)}. Nothing was posted.`, url: null };
  const uploadUrl = init.json && init.json.value && init.json.value.uploadUrl;
  const documentUrn = init.json && init.json.value && init.json.value.document;
  if (!uploadUrl || !documentUrn) return { status: "error", detail: "LinkedIn did not return an upload URL. Nothing was posted.", url: null };
  if (!isLinkedInHost(uploadUrl)) return { status: "error", detail: "LinkedIn returned an upload URL on an unexpected host, so the token was not sent there. Nothing was posted.", url: null };

  const upload = await request(ctx.fetchImpl, uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: fs.readFileSync(payload.pdf),
    timeoutMs: 300000,
  });
  if (!upload.ok) return { status: "error", detail: `${failure("LinkedIn PDF upload", upload, env)}. Nothing was posted.`, url: null };

  const post = await request(ctx.fetchImpl, `${API}/rest/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      author,
      commentary: escapeCommentary(payload.caption),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title: payload.title || "Carousel", id: documentUrn } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  // No answer or a server error on the create call: the post may exist.
  if (uncertain(post)) return unknownOutcome(label, "LinkedIn post", post, env);
  if (!post.ok) return { status: "error", detail: `${failure("LinkedIn post", post, env)}. The PDF was uploaded but LinkedIn rejected the post, so nothing is live.`, url: null };
  const postUrn = header(post, "x-restli-id") || header(post, "x-linkedin-id") || (post.json && post.json.id) || "";
  return {
    status: "published",
    detail: postUrn ? `LinkedIn document post published (${postUrn}).` : "LinkedIn document post published.",
    url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : "https://www.linkedin.com/feed/",
    postId: postUrn || null,
  };
}

module.exports = { id, label, REQUIRED_ENV, apiVersion, escapeCommentary, check, plan, publish };
