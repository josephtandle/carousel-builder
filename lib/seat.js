"use strict";

// Detects whether a signed-in Codex CLI seat is usable on this machine.
// It checks two things only: the `codex` command runs, and the login marker
// file exists and is not empty. The marker file is never opened or read, so
// no credential value can reach the return value, a log, or an error.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function defaultExec(command, args, options) {
  return execFileSync(command, args, options);
}

function truthy(value) {
  return typeof value === "string" && /^(1|true|yes)$/i.test(value.trim());
}

function detectCodexSeat({ env = process.env, execImpl = defaultExec, fsImpl = fs } = {}) {
  if (truthy(env.CAROUSEL_DISABLE_CODEX_SEAT)) {
    return { available: false, reason: "codex seat use is switched off (CAROUSEL_DISABLE_CODEX_SEAT)" };
  }
  // A subscription seat belongs to a person at a keyboard, not to a pipeline.
  if (truthy(env.CI)) {
    return { available: false, reason: "unattended context (CI), codex seat not used" };
  }

  try {
    execImpl("codex", ["--version"], {
      env,
      timeout: 5000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return { available: false, reason: "codex CLI not found on PATH" };
  }

  const home = env.HOME || env.USERPROFILE || os.homedir();
  const marker = path.join(env.CODEX_HOME || path.join(home, ".codex"), "auth.json");
  let size = 0;
  try {
    const stat = fsImpl.statSync(marker);
    size = stat && typeof stat.size === "number" ? stat.size : 0;
  } catch {
    return { available: false, reason: "codex CLI found but not signed in (no login marker)" };
  }
  if (size <= 0) {
    return { available: false, reason: "codex CLI found but not signed in (login marker is empty)" };
  }
  return { available: true, reason: "codex CLI found and signed in" };
}

module.exports = { detectCodexSeat };
