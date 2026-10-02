"use strict";

// Locates a sibling All Sorted module. The install root comes only from the
// ALLSORTED_ROOT environment variable, so nothing is guessed from the disk.

const fs = require("node:fs");
const path = require("node:path");
const { envValue } = require("../util");

function findSibling(name, entryParts, { env, fsImpl = fs }) {
  const root = envValue(env, "ALLSORTED_ROOT");
  if (!root) return { ok: false, detail: "ALLSORTED_ROOT is not set" };
  const dir = path.join(root, name);
  const entry = path.join(dir, ...entryParts);
  try {
    if (!fsImpl.existsSync(dir)) return { ok: false, detail: `the ${name} module is not installed` };
    if (!fsImpl.existsSync(entry)) return { ok: false, detail: `the ${name} module is installed but its entry file is missing` };
  } catch {
    return { ok: false, detail: `the ${name} module could not be checked` };
  }
  return { ok: true, detail: "", dir, entry };
}

// Copies a file a sibling wrote into the library folder when it landed elsewhere.
function adoptIntoLibrary(file, { libraryDir, fsImpl = fs }) {
  const resolved = path.resolve(file);
  if (path.dirname(resolved) === path.resolve(libraryDir)) return resolved;
  fsImpl.mkdirSync(libraryDir, { recursive: true });
  const target = path.join(libraryDir, path.basename(resolved));
  fsImpl.copyFileSync(resolved, target);
  return target;
}

module.exports = { findSibling, adoptIntoLibrary };
