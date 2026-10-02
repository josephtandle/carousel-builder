"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { detectCodexSeat } = require("../lib/seat");

const TOKEN = "tok_super_secret_value_do_not_print";
const HOME = path.join(path.sep, "home", "tester");

function fakeFs({ size, missing = false } = {}) {
  const calls = { stat: [], read: 0 };
  return {
    calls,
    statSync(file) {
      calls.stat.push(file);
      if (missing) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return { size };
    },
    readFileSync() {
      calls.read += 1;
      return JSON.stringify({ tokens: { access_token: TOKEN } });
    },
  };
}

function okExec(calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return "codex-cli 1.0.0";
  };
}

function missingExec() {
  const error = new Error("spawn codex ENOENT");
  error.code = "ENOENT";
  throw error;
}

test("seat is available when the CLI runs and the login marker is non-empty", () => {
  const execCalls = [];
  const fsImpl = fakeFs({ size: 512 });
  const result = detectCodexSeat({ env: { HOME }, execImpl: okExec(execCalls), fsImpl });
  assert.deepEqual(result, { available: true, reason: "codex CLI found and signed in" });
  assert.equal(execCalls[0].command, "codex");
  assert.deepEqual(execCalls[0].args, ["--version"]);
  assert.ok(execCalls[0].options.timeout > 0);
  assert.deepEqual(fsImpl.calls.stat, [path.join(HOME, ".codex", "auth.json")]);
});

test("CODEX_HOME moves the login marker", () => {
  const fsImpl = fakeFs({ size: 10 });
  const codexHome = path.join(path.sep, "opt", "codex-home");
  detectCodexSeat({ env: { HOME, CODEX_HOME: codexHome }, execImpl: okExec(), fsImpl });
  assert.deepEqual(fsImpl.calls.stat, [path.join(codexHome, "auth.json")]);
});

test("no CLI on PATH", () => {
  const fsImpl = fakeFs({ size: 512 });
  const result = detectCodexSeat({ env: { HOME }, execImpl: missingExec, fsImpl });
  assert.equal(result.available, false);
  assert.match(result.reason, /not found on PATH/);
  assert.equal(fsImpl.calls.stat.length, 0);
});

test("CLI present but no login marker", () => {
  const result = detectCodexSeat({ env: { HOME }, execImpl: okExec(), fsImpl: fakeFs({ missing: true }) });
  assert.equal(result.available, false);
  assert.match(result.reason, /not signed in/);
});

test("an empty login marker does not count", () => {
  const result = detectCodexSeat({ env: { HOME }, execImpl: okExec(), fsImpl: fakeFs({ size: 0 }) });
  assert.equal(result.available, false);
  assert.match(result.reason, /empty/);
});

test("unattended or switched-off contexts never use the seat", () => {
  const exec = () => {
    throw new Error("must not be called");
  };
  const ci = detectCodexSeat({ env: { HOME, CI: "true" }, execImpl: exec, fsImpl: fakeFs({ size: 512 }) });
  assert.equal(ci.available, false);
  assert.match(ci.reason, /unattended/);
  const off = detectCodexSeat({ env: { HOME, CAROUSEL_DISABLE_CODEX_SEAT: "1" }, execImpl: exec, fsImpl: fakeFs({ size: 512 }) });
  assert.equal(off.available, false);
});

test("output never contains token text and the marker is never read", () => {
  const variants = [
    { execImpl: okExec(), fsImpl: fakeFs({ size: 512 }) },
    { execImpl: okExec(), fsImpl: fakeFs({ size: 0 }) },
    { execImpl: okExec(), fsImpl: fakeFs({ missing: true }) },
    { execImpl: missingExec, fsImpl: fakeFs({ size: 512 }) },
  ];
  for (const { execImpl, fsImpl } of variants) {
    const result = detectCodexSeat({ env: { HOME, OPENAI_API_KEY: TOKEN }, execImpl, fsImpl });
    const text = JSON.stringify(result);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!/tok_|access_token/.test(text));
    assert.deepEqual(Object.keys(result).sort(), ["available", "reason"]);
    assert.equal(fsImpl.calls.read, 0, "the login marker must not be opened");
  }
});
