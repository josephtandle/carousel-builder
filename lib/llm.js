"use strict";

// Provider-neutral text completion with zero dependencies.
// getLlm() picks the first configured key (Anthropic, then OpenAI, then Gemini)
// and returns { name, model, complete(prompt, { maxTokens, json }) }.
// It returns null when no key is set so callers can use their keyless fallback.

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
};

const DEFAULT_TIMEOUT_MS = 90000;
const JSON_SYSTEM = "Respond with one valid JSON value and nothing else. No markdown fences, no commentary.";

function envValue(env, name) {
  const value = env && env[name];
  return typeof value === "string" ? value.trim() : "";
}

function redact(text, secret) {
  let out = String(text == null ? "" : text);
  if (secret) out = out.split(secret).join("[redacted]");
  return out.slice(0, 400);
}

function timeoutMs(env) {
  const raw = Number(envValue(env, "CAROUSEL_LLM_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

async function postJson(fetchImpl, url, { headers, body, secret, label, ms }) {
  if (typeof fetchImpl !== "function") throw new Error(`${label}: no fetch implementation available`);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    const reason = error && error.name === "AbortError" ? `timed out after ${ms} ms` : redact(error && error.message, secret);
    throw new Error(`${label}: request failed (${reason})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status} ${redact(raw, secret)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label}: response was not JSON`);
  }
}

function anthropicClient(env, fetchImpl) {
  const key = envValue(env, "ANTHROPIC_API_KEY");
  const model = envValue(env, "CAROUSEL_ANTHROPIC_MODEL") || DEFAULT_MODELS.anthropic;
  const base = (envValue(env, "ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    name: "anthropic",
    model,
    async complete(prompt, { maxTokens = 8000, json = false } = {}) {
      // The body stays minimal on purpose: current models reject sampling
      // parameters and assistant prefill, and thinking is left at its default.
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: String(prompt) }],
      };
      if (json) body.system = JSON_SYSTEM;
      const data = await postJson(fetchImpl, `${base}/v1/messages`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        body,
        secret: key,
        label: "anthropic",
        ms: timeoutMs(env),
      });
      if (data.stop_reason === "refusal") {
        throw new Error("anthropic: the model declined this request");
      }
      const text = (Array.isArray(data.content) ? data.content : [])
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) {
        const why = data.stop_reason === "max_tokens" ? "hit max_tokens before any text" : "empty response";
        throw new Error(`anthropic: ${why}`);
      }
      return text;
    },
  };
}

function openaiClient(env, fetchImpl) {
  const key = envValue(env, "OPENAI_API_KEY");
  const model = envValue(env, "CAROUSEL_OPENAI_MODEL") || DEFAULT_MODELS.openai;
  const base = (envValue(env, "OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    name: "openai",
    model,
    async complete(prompt, { maxTokens = 8000, json = false } = {}) {
      const messages = [];
      if (json) messages.push({ role: "system", content: JSON_SYSTEM });
      messages.push({ role: "user", content: String(prompt) });
      const body = { model, messages, max_completion_tokens: maxTokens };
      if (json) body.response_format = { type: "json_object" };
      const data = await postJson(fetchImpl, `${base}/chat/completions`, {
        headers: { authorization: `Bearer ${key}` },
        body,
        secret: key,
        label: "openai",
        ms: timeoutMs(env),
      });
      const message = data.choices && data.choices[0] && data.choices[0].message;
      if (message && message.refusal) throw new Error("openai: the model declined this request");
      const text = message && typeof message.content === "string" ? message.content.trim() : "";
      if (!text) throw new Error("openai: empty response");
      return text;
    },
  };
}

function geminiClient(env, fetchImpl) {
  const key = envValue(env, "GEMINI_API_KEY");
  const model = envValue(env, "CAROUSEL_GEMINI_MODEL") || DEFAULT_MODELS.gemini;
  const base = (envValue(env, "GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  return {
    name: "gemini",
    model,
    async complete(prompt, { maxTokens = 8000, json = false } = {}) {
      const generationConfig = { maxOutputTokens: maxTokens };
      if (json) generationConfig.responseMimeType = "application/json";
      // The key travels in a header, never in the URL.
      const data = await postJson(fetchImpl, `${base}/models/${encodeURIComponent(model)}:generateContent`, {
        headers: { "x-goog-api-key": key },
        body: { contents: [{ role: "user", parts: [{ text: String(prompt) }] }], generationConfig },
        secret: key,
        label: "gemini",
        ms: timeoutMs(env),
      });
      const candidate = data.candidates && data.candidates[0];
      const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
      const text = parts.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("").trim();
      if (!text) {
        const why = (candidate && candidate.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || "empty response";
        throw new Error(`gemini: ${why}`);
      }
      return text;
    },
  };
}

function getLlm({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (envValue(env, "ANTHROPIC_API_KEY")) return anthropicClient(env, fetchImpl);
  if (envValue(env, "OPENAI_API_KEY")) return openaiClient(env, fetchImpl);
  if (envValue(env, "GEMINI_API_KEY")) return geminiClient(env, fetchImpl);
  return null;
}

// ---------------------------------------------------------------------------
// JSON extraction from model output
// ---------------------------------------------------------------------------

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function repair(text) {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

// Returns every balanced {...} or [...] span, scanning with string awareness.
function balancedSpans(text) {
  const spans = [];
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") {
        const last = stack.pop();
        if ((ch === "}" && last !== "{") || (ch === "]" && last !== "[")) break;
        if (!stack.length) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      spans.push(text.slice(start, end + 1));
      start = end;
    }
  }
  return spans;
}

// Accepts raw JSON, fenced JSON, or JSON wrapped in prose. Returns the parsed
// value, or null when nothing parseable is found. Objects win over arrays
// unless the whole text is an array.
function extractJson(output) {
  if (output && typeof output === "object") return output;
  const text = String(output == null ? "" : output).replace(/^\uFEFF/, "").trim();
  if (!text) return null;

  const candidates = [text];
  const fence = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
  let match = fence.exec(text);
  while (match) {
    candidates.push(match[1].trim());
    match = fence.exec(text);
  }
  const spans = balancedSpans(text).sort((a, b) => b.length - a.length);
  candidates.push(...spans.filter((span) => span[0] === "{"), ...spans.filter((span) => span[0] === "["));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const direct = tryParse(candidate);
    if (direct.ok && direct.value && typeof direct.value === "object") return direct.value;
    const fixed = tryParse(repair(candidate));
    if (fixed.ok && fixed.value && typeof fixed.value === "object") return fixed.value;
  }
  return null;
}

// Convenience: run a JSON completion and parse it. Throws when unparseable.
async function completeJson(llm, prompt, options = {}) {
  const output = await llm.complete(prompt, { ...options, json: true });
  const parsed = extractJson(output);
  if (!parsed) throw new Error(`${llm.name || "llm"}: could not find JSON in the response`);
  return parsed;
}

module.exports = { getLlm, extractJson, completeJson, DEFAULT_MODELS };
