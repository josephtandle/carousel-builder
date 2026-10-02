"use strict";

// Small fetch wrapper shared by the publishers. It never throws: network
// failures and non-2xx answers come back as { ok: false, ... } so an adapter
// can return a structured result.

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)$/i;

// Removes any credential value that slipped into a message (API error bodies
// sometimes echo the request). Works on the trimmed value, which is what is
// actually sent.
function redact(text, env) {
  let out = String(text === undefined || text === null ? "" : text);
  for (const [name, value] of Object.entries(env || {})) {
    if (!SECRET_ENV.test(name)) continue;
    const secret = String(value || "").trim();
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function hasAuthorization(headers) {
  if (!headers || typeof headers !== "object") return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

async function request(fetchImpl, url, init = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, status: 0, json: null, text: "", headers: null, error: "No fetch implementation available (Node 18+ is required)." };
  const { timeoutMs = 60000, ...rest } = init;
  // A request that carries a token never follows a redirect to another host.
  if (hasAuthorization(rest.headers)) rest.redirect = "error";
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { ...rest, ...(controller ? { signal: controller.signal } : {}) });
    let text = "";
    if (res && typeof res.text === "function") text = await res.text();
    else if (res && typeof res.json === "function") text = JSON.stringify(await res.json());
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const status = Number(res && res.status) || 0;
    const ok = res && typeof res.ok === "boolean" ? res.ok : status >= 200 && status < 300;
    return { ok, status, json, text: String(text || ""), headers: (res && res.headers) || null, error: null };
  } catch (err) {
    const message = err && err.name === "AbortError" ? `timed out after ${timeoutMs} ms` : String((err && err.message) || err);
    return { ok: false, status: 0, json: null, text: "", headers: null, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function header(res, name) {
  const headers = res && res.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : "";
}

// One short, human line about a failed call. The body is redacted first and
// trimmed second, so a token can never survive as a cut-off prefix.
function failure(step, res, env) {
  if (res.error) return `${step} failed: ${redact(res.error, env)}`;
  const body = res.json && (res.json.error || res.json.message) ? JSON.stringify(res.json.error || res.json.message) : res.text;
  const clean = redact(String(body || ""), env).replace(/\s+/g, " ").slice(0, 300);
  return `${step} failed (HTTP ${res.status})${clean ? `: ${clean}` : ""}`;
}

// True when a call may have gone through even though no answer confirmed it:
// no response at all (timeout, dropped connection) or a server error.
function uncertain(res) {
  return !res.ok && (res.status === 0 || res.status >= 500);
}

// The result for a final "create the post" call whose outcome is not known.
function unknownOutcome(label, step, res, env) {
  return {
    status: "unknown",
    detail: `${failure(step, res, env)}. ${label} did not confirm the post, so it may or may not be live. Check the account before you retry: it was not retried automatically, and retrying blind could post it twice.`,
    url: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { request, header, failure, uncertain, unknownOutcome, redact, sleep, SECRET_ENV };
