// The API client. Every slide image, layout check, draft, caption and publish
// result comes from the engine through /api/<name> on this same local server.

const API = "/api";
const tokenTag = document.querySelector('meta[name="carousel-token"]');
// The session token of this run. Every request that changes something carries it.
const TOKEN = tokenTag ? tokenTag.getAttribute("content") || "" : "";

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function withToken(init) {
  const method = String((init && init.method) || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return init || {};
  return { ...init, headers: { ...((init && init.headers) || {}), "X-Carousel-Token": TOKEN } };
}

export async function api(path, init) {
  let response;
  try {
    response = await fetch(`${API}/${path}`, { cache: "no-store", ...withToken(init) });
  } catch {
    throw new ApiError("Could not reach the Carousel Builder. Check that the carousel ui command is still running in your terminal, then try again.", 0, null);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok !== true) {
    const message = payload && typeof payload.error === "string" && payload.error ? payload.error : `The request failed (${response.status}).`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

export function postJson(body, method = "POST") {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  return api("images", { method: "POST", body: form });
}

/** A save that outlives the page: used when the tab is closing inside the save delay. */
export function saveOnLeave(body) {
  try {
    fetch(`${API}/drafts`, { ...withToken(postJson(body)), keepalive: true }).catch(() => undefined);
  } catch {
    // Nothing more can be done while the page is going away.
  }
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
