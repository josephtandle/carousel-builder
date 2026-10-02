"use strict";

// EXPERIMENTAL. Asks a signed-in Codex CLI seat to generate one image file.
//
// Whether a given Codex seat can write image files from `codex exec` is not
// guaranteed: it depends on the CLI version, the plan, and the tools that
// seat has. So this provider must fail soft. It never throws for a missing
// seat, it enforces a hard timeout, and it only reports "ok" after it has
// checked that the output file exists and really is a PNG or JPEG. On any
// other outcome it returns status "error" with a detail and the chain moves
// on to the next provider.

const fs = require("node:fs");
const path = require("node:path");
const { detectCodexSeat } = require("../../seat");
const { BACKGROUND_SUFFIX, envValue, runProcess, sniffImage, sizeHint, slug, short } = require("../util");

const LICENSE = "AI generated with your Codex seat. Use is subject to the OpenAI terms that apply to your account.";
const DEFAULT_TIMEOUT_MS = 180000;

function seat(ctx) {
  return detectCodexSeat({ env: ctx.env, execImpl: ctx.execImpl, fsImpl: ctx.fsImpl });
}

function isConfigured(ctx) {
  const found = seat(ctx);
  return { ok: found.available, detail: found.available ? "" : found.reason };
}

async function generate({ prompt, size }, ctx) {
  const fsImpl = ctx.fsImpl || fs;
  const found = seat(ctx);
  if (!found.available) return { status: "not_configured", results: [], detail: found.reason };

  const hint = sizeHint(size);
  const date = typeof ctx.now === "function" ? ctx.now() : new Date();
  const stampText = new Date(date).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const outFile = path.join(ctx.libraryDir, `gen-codex-imagegen-${slug(prompt)}-${stampText}.png`);
  fsImpl.mkdirSync(ctx.libraryDir, { recursive: true });
  if (fsImpl.existsSync(outFile)) return { status: "error", results: [], detail: "the output path already exists, try again" };

  const instruction = [
    "Generate exactly one image with your image generation tool.",
    `Description: ${prompt}. ${BACKGROUND_SUFFIX}`,
    `Aspect ratio ${hint.ratio}, about ${hint.width}x${hint.height} pixels.`,
    `Save it as a PNG file at exactly this path: ${outFile}`,
    "Do not create, edit, or delete any other file. Do not draw the image with code.",
    "If you cannot generate images, reply CANNOT_GENERATE and do nothing else.",
  ].join("\n");

  const raw = Number(envValue(ctx.env, "CAROUSEL_CODEX_TIMEOUT_MS"));
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  const run = ctx.runImpl || runProcess;
  const result = await run(
    "codex",
    ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", ctx.libraryDir, instruction],
    { timeoutMs, cwd: ctx.libraryDir, env: ctx.env },
  );

  if (result.timedOut) return { status: "error", results: [], detail: `codex exec timed out after ${timeoutMs} ms` };
  if (result.code !== 0) {
    return { status: "error", results: [], detail: `codex exec failed: ${short(result.error || result.stderr, 160) || `exit code ${result.code}`}` };
  }
  let kind = null;
  try {
    kind = sniffImage(fsImpl.readFileSync(outFile));
  } catch {
    return { status: "error", results: [], detail: "codex exec finished but wrote no image file (this seat may not support image output)" };
  }
  if (kind !== "png" && kind !== "jpg") {
    try {
      fsImpl.unlinkSync(outFile);
    } catch {
      // leave it, the result is still an error
    }
    return { status: "error", results: [], detail: "codex exec wrote a file that is not a PNG or JPEG" };
  }
  return {
    status: "ok",
    detail: "generated with a Codex seat (experimental)",
    results: [{ src: outFile, thumb: outFile, credit: "AI generated (Codex seat)", license: LICENSE, alt: prompt }],
  };
}

module.exports = { id: "codex-imagegen", kind: "generate", env: [], license: LICENSE, experimental: true, isConfigured, generate };
