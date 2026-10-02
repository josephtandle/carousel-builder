"use strict";

// Your own images: every image file in <dataDir>/library.
// Matching is a case-insensitive substring match on the file name.

const fs = require("node:fs");
const path = require("node:path");
const { IMAGE_EXTENSIONS } = require("../util");

const LICENSE = "Your own file. You are responsible for the rights to use it.";

function isConfigured() {
  return { ok: true, detail: "" };
}

async function search({ query, count }, ctx) {
  const fsImpl = ctx.fsImpl || fs;
  let names;
  try {
    names = fsImpl.readdirSync(ctx.libraryDir);
  } catch {
    return { status: "empty", results: [], detail: "the library folder does not exist yet" };
  }
  const images = names
    .filter((name) => !name.startsWith(".") && IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  if (!images.length) return { status: "empty", results: [], detail: "the library folder has no images" };

  const needle = String(query || "").trim().toLowerCase();
  const tokens = needle.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  const whole = [];
  const partial = [];
  for (const name of images) {
    const hay = name.toLowerCase();
    if (!needle || hay.includes(needle)) whole.push(name);
    else if (tokens.some((token) => hay.includes(token))) partial.push(name);
  }
  const picked = [...whole, ...partial].slice(0, count);
  if (!picked.length) return { status: "empty", results: [], detail: `no library file name matches "${needle}"` };
  return {
    status: "ok",
    detail: `${picked.length} file(s) from your library`,
    results: picked.map((name) => {
      const file = path.join(ctx.libraryDir, name);
      return { src: file, thumb: file, credit: "Your library", license: LICENSE, alt: path.basename(name, path.extname(name)) };
    }),
  };
}

module.exports = { id: "library", kind: "search", env: [], license: LICENSE, isConfigured, search };
