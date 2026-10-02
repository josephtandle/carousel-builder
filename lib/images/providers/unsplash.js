"use strict";

// Unsplash stock photo search. Needs UNSPLASH_ACCESS_KEY (free).

const { envValue, fetchWithTimeout, short } = require("../util");

const LICENSE = "Unsplash License: free to use, attribution appreciated. https://unsplash.com/license";

function isConfigured({ env }) {
  return envValue(env, "UNSPLASH_ACCESS_KEY")
    ? { ok: true, detail: "" }
    : { ok: false, detail: "UNSPLASH_ACCESS_KEY is not set" };
}

async function search({ query, count, orientation }, ctx) {
  const key = envValue(ctx.env, "UNSPLASH_ACCESS_KEY");
  const params = new URLSearchParams({ query: String(query || ""), per_page: String(count) });
  const mapped = { portrait: "portrait", landscape: "landscape", square: "squarish" }[orientation];
  if (mapped) params.set("orientation", mapped);
  const response = await fetchWithTimeout(
    ctx.fetchImpl,
    `https://api.unsplash.com/search/photos?${params.toString()}`,
    { method: "GET", headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" } },
    20000,
  );
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "the access key was rejected" : short(await response.text(), 160);
    return { status: "error", results: [], detail: `Unsplash HTTP ${response.status}: ${hint}` };
  }
  const data = await response.json();
  const photos = Array.isArray(data.results) ? data.results : [];
  const results = photos
    .filter((photo) => photo && photo.urls)
    .slice(0, count)
    .map((photo) => ({
      src: photo.urls.regular || photo.urls.full || photo.urls.raw,
      thumb: photo.urls.small || photo.urls.thumb || photo.urls.regular,
      credit: `Photo by ${(photo.user && photo.user.name) || "an Unsplash contributor"} on Unsplash`,
      license: LICENSE,
      alt: photo.alt_description || photo.description || "",
      sourceUrl: (photo.links && photo.links.html) || "",
    }))
    .filter((photo) => photo.src);
  if (!results.length) return { status: "empty", results: [], detail: "Unsplash returned no photos for this query" };
  return { status: "ok", results, detail: `${results.length} photo(s) from Unsplash` };
}

module.exports = { id: "unsplash", kind: "search", env: ["UNSPLASH_ACCESS_KEY"], license: LICENSE, isConfigured, search };
