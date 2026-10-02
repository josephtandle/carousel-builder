"use strict";

// Pexels stock photo search. Needs PEXELS_API_KEY (free).

const { envValue, fetchWithTimeout, short } = require("../util");

const LICENSE = "Pexels License: free to use, attribution appreciated. https://www.pexels.com/license/";

function isConfigured({ env }) {
  return envValue(env, "PEXELS_API_KEY") ? { ok: true, detail: "" } : { ok: false, detail: "PEXELS_API_KEY is not set" };
}

async function search({ query, count, orientation }, ctx) {
  const key = envValue(ctx.env, "PEXELS_API_KEY");
  const params = new URLSearchParams({ query: String(query || ""), per_page: String(count) });
  if (["portrait", "landscape", "square"].includes(orientation)) params.set("orientation", orientation);
  const response = await fetchWithTimeout(
    ctx.fetchImpl,
    `https://api.pexels.com/v1/search?${params.toString()}`,
    { method: "GET", headers: { Authorization: key } },
    20000,
  );
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "the API key was rejected" : short(await response.text(), 160);
    return { status: "error", results: [], detail: `Pexels HTTP ${response.status}: ${hint}` };
  }
  const data = await response.json();
  const photos = Array.isArray(data.photos) ? data.photos : [];
  const results = photos
    .filter((photo) => photo && photo.src)
    .slice(0, count)
    .map((photo) => ({
      src: photo.src.large2x || photo.src.large || photo.src.original,
      thumb: photo.src.medium || photo.src.small || photo.src.large,
      credit: `Photo by ${photo.photographer || "a Pexels contributor"} on Pexels`,
      license: LICENSE,
      alt: photo.alt || "",
      sourceUrl: photo.url || "",
    }))
    .filter((photo) => photo.src);
  if (!results.length) return { status: "empty", results: [], detail: "Pexels returned no photos for this query" };
  return { status: "ok", results, detail: `${results.length} photo(s) from Pexels` };
}

module.exports = { id: "pexels", kind: "search", env: ["PEXELS_API_KEY"], license: LICENSE, isConfigured, search };
