"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const images = require("../lib/images");
const { findBackgrounds, generateBackground, listProviders, loadProvidersConfig, PROVIDER_IDS } = images;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

const CHAIN = ["library", "pexels", "unsplash", "codex-imagegen", "openai-image", "huggingface", "whisk", "open-generative-ai"];

function config(overrides = {}, mode = "first-available") {
  return {
    mode,
    chain: CHAIN.map((id) => ({ id, enabled: true, env: [], costHint: `hint for ${id}`, ...(overrides[id] || {}) })),
  };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carousel-images-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function response({ ok = true, status = 200, json, bytes, text }) {
  return {
    ok,
    status,
    async json() {
      return json;
    },
    async text() {
      return text != null ? text : JSON.stringify(json || {});
    },
    async arrayBuffer() {
      const buffer = bytes || Buffer.from("");
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [needle, reply] of Object.entries(routes)) {
      if (String(url).includes(needle)) return typeof reply === "function" ? reply(String(url), init) : reply;
    }
    throw new Error(`unexpected network call to ${url}`);
  };
  return { calls, fetchImpl };
}

const noNetwork = async (url) => {
  throw new Error(`unexpected network call to ${url}`);
};
const noSeat = () => {
  throw new Error("codex not installed");
};

const pexelsPayload = {
  photos: [
    {
      photographer: "Ada Example",
      url: "https://www.pexels.com/photo/1",
      alt: "desk",
      src: { large2x: "https://images.pexels.com/1-large.jpg", medium: "https://images.pexels.com/1-medium.jpg" },
    },
  ],
};
const unsplashPayload = {
  results: [
    {
      urls: { regular: "https://images.unsplash.com/u1-regular", small: "https://images.unsplash.com/u1-small" },
      user: { name: "Grace Example" },
      links: { html: "https://unsplash.com/photos/u1" },
      alt_description: "ocean",
    },
  ],
};

function assertCredited(results) {
  assert.ok(results.length > 0);
  for (const item of results) {
    assert.equal(typeof item.src, "string");
    assert.ok(item.src.length > 0);
    assert.ok(item.thumb.length > 0);
    assert.ok(typeof item.credit === "string" && item.credit.length > 0, "credit text");
    assert.ok(typeof item.license === "string" && item.license.length > 0, "license text");
  }
}

test("the provider set is the documented chain and has no web scrape source", () => {
  assert.deepEqual(PROVIDER_IDS, CHAIN);
  for (const banned of ["web", "web-images", "scrape", "search-engine"]) {
    assert.ok(!PROVIDER_IDS.includes(banned));
  }
  const banned = new RegExp(["duck", "duck", "go"].join(""), "i");
  const root = path.join(__dirname, "..", "lib", "images");
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const files = walk(root);
  assert.ok(files.length >= 9);
  for (const file of files) {
    assert.ok(!banned.test(fs.readFileSync(file, "utf8")), `${path.basename(file)} mentions a scrape source`);
  }
  assert.ok(!files.some((file) => /web|scrape/i.test(path.basename(file))));
});

test("a scrape source named in a config is refused without any network call", async (t) => {
  const dataDir = tmpDir(t);
  const custom = { mode: "first-available", chain: [{ id: "web", enabled: true }] };
  const out = await findBackgrounds({ query: "desk" }, { config: custom, env: {}, fetchImpl: noNetwork, dataDir });
  assert.equal(out.provider, null);
  assert.deepEqual(out.results, []);
  assert.equal(out.tried[0].status, "not_configured");
  assert.match(out.tried[0].detail, /unknown provider/);
});

test("chain order and not_configured statuses with no keys", async (t) => {
  const dataDir = tmpDir(t);
  const out = await findBackgrounds({ query: "desk", count: 3 }, { config: config(), env: {}, fetchImpl: noNetwork, dataDir });
  assert.equal(out.provider, null);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.tried.map((row) => row.id), ["library", "pexels", "unsplash"]);
  assert.deepEqual(out.tried.map((row) => row.status), ["empty", "not_configured", "not_configured"]);
  assert.match(out.tried[1].detail, /PEXELS_API_KEY/);
  assert.match(out.tried[2].detail, /UNSPLASH_ACCESS_KEY/);
});

test("first-available stops at the first provider with results", async (t) => {
  const dataDir = tmpDir(t);
  const net = router({ "api.pexels.com": response({ json: pexelsPayload }) });
  const env = { PEXELS_API_KEY: "pexels-key", UNSPLASH_ACCESS_KEY: "unsplash-key" };
  const out = await findBackgrounds({ query: "calm desk", count: 4, orientation: "portrait" }, { config: config(), env, fetchImpl: net.fetchImpl, dataDir });
  assert.equal(out.provider, "pexels");
  assert.deepEqual(out.tried.map((row) => `${row.id}:${row.status}`), ["library:empty", "pexels:ok"]);
  assert.equal(net.calls.length, 1, "unsplash is never called");
  assert.match(net.calls[0].url, /query=calm\+desk/);
  assert.match(net.calls[0].url, /per_page=4/);
  assert.match(net.calls[0].url, /orientation=portrait/);
  assert.equal(net.calls[0].init.headers.Authorization, "pexels-key");
  assert.ok(!net.calls[0].url.includes("pexels-key"));
  assertCredited(out.results);
  assert.equal(out.results[0].src, "https://images.pexels.com/1-large.jpg");
  assert.equal(out.results[0].credit, "Photo by Ada Example on Pexels");
  assert.match(out.results[0].license, /Pexels License/);
  assert.equal(out.results[0].provider, "pexels");
});

test("empty and failing providers are recorded and the chain continues", async (t) => {
  const dataDir = tmpDir(t);
  const env = { PEXELS_API_KEY: "p", UNSPLASH_ACCESS_KEY: "u" };
  const empty = router({ "api.pexels.com": response({ json: { photos: [] } }), "api.unsplash.com": response({ json: unsplashPayload }) });
  const a = await findBackgrounds({ query: "ocean", orientation: "square" }, { config: config(), env, fetchImpl: empty.fetchImpl, dataDir });
  assert.equal(a.provider, "unsplash");
  assert.deepEqual(a.tried.map((row) => `${row.id}:${row.status}`), ["library:empty", "pexels:empty", "unsplash:ok"]);
  assert.match(empty.calls[1].url, /orientation=squarish/);
  assert.equal(empty.calls[1].init.headers.Authorization, "Client-ID u");
  assert.equal(a.results[0].credit, "Photo by Grace Example on Unsplash");
  assertCredited(a.results);

  const failing = router({
    "api.pexels.com": response({ ok: false, status: 401, text: "nope" }),
    "api.unsplash.com": async () => {
      throw new Error("socket hang up");
    },
  });
  const b = await findBackgrounds({ query: "ocean" }, { config: config(), env, fetchImpl: failing.fetchImpl, dataDir });
  assert.equal(b.provider, null);
  assert.deepEqual(b.tried.map((row) => `${row.id}:${row.status}`), ["library:empty", "pexels:error", "unsplash:error"]);
  assert.match(b.tried[1].detail, /401/);
  assert.match(b.tried[2].detail, /socket hang up/);
});

test("disabled providers and extra env requirements are skipped with a reason", async (t) => {
  const dataDir = tmpDir(t);
  const env = { PEXELS_API_KEY: "p", UNSPLASH_ACCESS_KEY: "u" };
  const custom = config({ pexels: { enabled: false }, unsplash: { env: ["UNSPLASH_ACCESS_KEY", "EXTRA_FLAG"] } });
  const out = await findBackgrounds({ query: "desk" }, { config: custom, env, fetchImpl: noNetwork, dataDir });
  assert.equal(out.tried[1].status, "not_configured");
  assert.match(out.tried[1].detail, /disabled/);
  assert.equal(out.tried[2].status, "not_configured");
  assert.match(out.tried[2].detail, /EXTRA_FLAG/);
});

test("library provider matches file names by substring and ignores non-images", async (t) => {
  const dataDir = tmpDir(t);
  const library = path.join(dataDir, "library");
  fs.mkdirSync(library, { recursive: true });
  for (const name of ["Ocean-Sunset.jpg", "desk-setup.png", "ocean-waves.webp", "notes.txt", ".hidden.png"]) {
    fs.writeFileSync(path.join(library, name), PNG);
  }
  const out = await findBackgrounds({ query: "ocean" }, { config: config(), env: { PEXELS_API_KEY: "p" }, fetchImpl: noNetwork, dataDir });
  assert.equal(out.provider, "library");
  assert.deepEqual(out.tried, [{ id: "library", status: "ok", detail: "2 file(s) from your library" }]);
  assert.deepEqual(out.results.map((item) => path.basename(item.src)).sort(), ["Ocean-Sunset.jpg", "ocean-waves.webp"]);
  assert.ok(out.results.every((item) => path.isAbsolute(item.src)));
  assertCredited(out.results);

  const all = await findBackgrounds({ query: "" }, { config: config(), env: {}, fetchImpl: noNetwork, dataDir });
  assert.equal(all.results.length, 3);

  const net = router({ "api.pexels.com": response({ json: pexelsPayload }) });
  const miss = await findBackgrounds({ query: "mountain" }, { config: config(), env: { PEXELS_API_KEY: "p" }, fetchImpl: net.fetchImpl, dataDir });
  assert.equal(miss.tried[0].status, "empty");
  assert.equal(miss.provider, "pexels");
});

test("mode ask returns results per provider", async (t) => {
  const dataDir = tmpDir(t);
  fs.mkdirSync(path.join(dataDir, "library"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "library", "ocean.png"), PNG);
  const net = router({ "api.pexels.com": response({ json: pexelsPayload }), "api.unsplash.com": response({ json: unsplashPayload }) });
  const env = { PEXELS_API_KEY: "p", UNSPLASH_ACCESS_KEY: "u" };
  const out = await findBackgrounds({ query: "ocean" }, { config: config({}, "ask"), env, fetchImpl: net.fetchImpl, dataDir });
  assert.deepEqual(Object.keys(out.byProvider), ["library", "pexels", "unsplash"]);
  assert.deepEqual(out.tried.map((row) => row.status), ["ok", "ok", "ok"]);
  assert.equal(out.results.length, 3);
  assert.deepEqual(out.results.map((item) => item.provider), ["library", "pexels", "unsplash"]);
  assertCredited(out.results);

  const one = await findBackgrounds({ query: "ocean" }, { config: config({}, "ask"), env, fetchImpl: net.fetchImpl, dataDir, provider: "unsplash" });
  assert.equal(one.provider, "unsplash");
  assert.deepEqual(one.tried.map((row) => row.id), ["unsplash"]);
});

test("generateBackground reports every generator as not_configured with no keys", async (t) => {
  const dataDir = tmpDir(t);
  const out = await generateBackground({ prompt: "soft gradient", size: "portrait" }, { config: config(), env: {}, fetchImpl: noNetwork, execImpl: noSeat, dataDir });
  assert.equal(out.provider, null);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.tried.map((row) => row.id), ["codex-imagegen", "openai-image", "huggingface", "whisk", "open-generative-ai"]);
  assert.ok(out.tried.every((row) => row.status === "not_configured"));
  assert.match(out.tried[0].detail, /codex CLI not found/);
  assert.match(out.tried[1].detail, /OPENAI_API_KEY/);
  assert.match(out.tried[2].detail, /HF_TOKEN/);
  assert.match(out.tried[3].detail, /ALLSORTED_ROOT/);
});

test("openai-image generator saves a PNG into the library", async (t) => {
  const dataDir = tmpDir(t);
  const net = router({ "/images/generations": response({ json: { data: [{ b64_json: PNG.toString("base64") }] } }) });
  const out = await generateBackground(
    { prompt: "Soft purple gradient, studio light", size: "portrait" },
    { config: config(), env: { OPENAI_API_KEY: "openai-key" }, fetchImpl: net.fetchImpl, execImpl: noSeat, dataDir, now: () => new Date("2026-01-02T03:04:05Z") },
  );
  assert.equal(out.provider, "openai-image");
  assert.deepEqual(out.tried.map((row) => `${row.id}:${row.status}`), ["codex-imagegen:not_configured", "openai-image:ok"]);
  assert.equal(out.results.length, 1);
  const file = out.results[0].src;
  assert.equal(path.dirname(file), path.join(dataDir, "library"));
  assert.equal(path.basename(file), "gen-openai-image-soft-purple-gradient-studio-light-20260102030405.png");
  assert.deepEqual(fs.readFileSync(file), PNG);
  assertCredited(out.results);
  const body = JSON.parse(net.calls[0].init.body);
  assert.equal(net.calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(net.calls[0].init.headers.authorization, "Bearer openai-key");
  assert.equal(body.size, "1024x1536");
  assert.equal(body.n, 1);
  assert.match(body.prompt, /No text/);

  // The saved file is now findable through the library provider.
  const found = await findBackgrounds({ query: "purple" }, { config: config(), env: {}, fetchImpl: noNetwork, dataDir });
  assert.equal(found.provider, "library");
});

test("huggingface generator uses the router host and saves the bytes", async (t) => {
  const dataDir = tmpDir(t);
  const net = router({ "router.huggingface.co": response({ bytes: JPEG }) });
  const out = await generateBackground(
    { prompt: "misty forest", size: "story" },
    { config: config(), env: { HF_TOKEN: "hf-token" }, fetchImpl: net.fetchImpl, execImpl: noSeat, dataDir },
  );
  assert.equal(out.provider, "huggingface");
  assert.equal(net.calls[0].url, "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell");
  assert.equal(net.calls[0].init.headers.authorization, "Bearer hf-token");
  const body = JSON.parse(net.calls[0].init.body);
  assert.deepEqual(body.parameters, { num_inference_steps: 4, width: 720, height: 1280 });
  assert.match(out.results[0].src, /gen-huggingface-misty-forest-\d{14}\.jpg$/);
  assert.deepEqual(fs.readFileSync(out.results[0].src), JPEG);
  assertCredited(out.results);
});

test("a generator that returns junk is an error and the chain continues", async (t) => {
  const dataDir = tmpDir(t);
  const net = router({
    "/images/generations": response({ ok: false, status: 429, text: "rate limited openai-key" }),
    "router.huggingface.co": response({ bytes: Buffer.from("<html>not an image</html>") }),
  });
  const out = await generateBackground(
    { prompt: "anything" },
    { config: config(), env: { OPENAI_API_KEY: "openai-key", HF_TOKEN: "hf" }, fetchImpl: net.fetchImpl, execImpl: noSeat, dataDir },
  );
  assert.equal(out.provider, null);
  assert.deepEqual(out.tried.slice(1, 3).map((row) => `${row.id}:${row.status}`), ["openai-image:error", "huggingface:error"]);
  assert.match(out.tried[1].detail, /429/);
  assert.ok(!out.tried[1].detail.includes("openai-key"), "keys are redacted from error detail");
  assert.ok(!fs.existsSync(path.join(dataDir, "library")) || fs.readdirSync(path.join(dataDir, "library")).length === 0);
});

function seatHome(t) {
  const home = tmpDir(t);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "seat-token-value" } }));
  return home;
}
const seatExec = () => "codex-cli 1.0.0";

test("codex-imagegen: seat present and the CLI writes a PNG", async (t) => {
  const dataDir = tmpDir(t);
  const home = seatHome(t);
  const runs = [];
  const runImpl = async (command, args, options) => {
    runs.push({ command, args, options });
    const target = /exactly this path: (.+)$/m.exec(args[args.length - 1])[1].trim();
    fs.writeFileSync(target, PNG);
    return { code: 0, stdout: target, stderr: "", timedOut: false };
  };
  const out = await generateBackground(
    { prompt: "paper texture", size: "square" },
    { config: config(), env: { HOME: home, OPENAI_API_KEY: "k" }, fetchImpl: noNetwork, execImpl: seatExec, runImpl, dataDir },
  );
  assert.equal(out.provider, "codex-imagegen");
  assert.deepEqual(out.tried, [{ id: "codex-imagegen", status: "ok", detail: "generated with a Codex seat (experimental)" }]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "codex");
  assert.equal(runs[0].args[0], "exec");
  assert.ok(runs[0].options.timeoutMs > 0, "a hard timeout is always set");
  assert.equal(path.dirname(out.results[0].src), path.join(dataDir, "library"));
  assert.match(path.basename(out.results[0].src), /^gen-codex-imagegen-paper-texture-\d{14}\.png$/);
  assertCredited(out.results);
  assert.ok(!JSON.stringify(out).includes("seat-token-value"));
});

test("codex-imagegen fails soft: no file, wrong file type, timeout, then the chain continues", async (t) => {
  const home = seatHome(t);
  const net = () => router({ "/images/generations": response({ json: { data: [{ b64_json: PNG.toString("base64") }] } }) });
  const env = { HOME: home, OPENAI_API_KEY: "k" };

  const cases = [
    { name: "no file", runImpl: async () => ({ code: 0, stdout: "CANNOT_GENERATE", stderr: "", timedOut: false }), detail: /wrote no image file/ },
    {
      name: "wrong type",
      runImpl: async (command, args) => {
        fs.writeFileSync(/exactly this path: (.+)$/m.exec(args[args.length - 1])[1].trim(), "<svg></svg>");
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      detail: /not a PNG or JPEG/,
    },
    { name: "timeout", runImpl: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }), detail: /timed out/ },
    { name: "exit code", runImpl: async () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false }), detail: /codex exec failed: boom/ },
  ];
  for (const item of cases) {
    const dataDir = tmpDir(t);
    const network = net();
    const out = await generateBackground(
      { prompt: "paper texture" },
      { config: config(), env, fetchImpl: network.fetchImpl, execImpl: seatExec, runImpl: item.runImpl, dataDir },
    );
    assert.deepEqual(out.tried.map((row) => `${row.id}:${row.status}`), ["codex-imagegen:error", "openai-image:ok"], item.name);
    assert.match(out.tried[0].detail, item.detail, item.name);
    assert.equal(out.provider, "openai-image", item.name);
    const names = fs.readdirSync(path.join(dataDir, "library"));
    assert.deepEqual(names.filter((name) => name.startsWith("gen-codex")), [], `${item.name}: no broken codex file is left behind`);
  }
});

test("codex-imagegen without a seat never shells out", async (t) => {
  const dataDir = tmpDir(t);
  const emptyHome = tmpDir(t);
  let ran = 0;
  const runImpl = async () => {
    ran += 1;
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const only = { mode: "first-available", chain: [{ id: "codex-imagegen", enabled: true }] };
  const noCli = await generateBackground({ prompt: "x" }, { config: only, env: { HOME: emptyHome }, fetchImpl: noNetwork, execImpl: noSeat, runImpl, dataDir });
  assert.deepEqual(noCli.tried.map((row) => row.status), ["not_configured"]);
  const noLogin = await generateBackground({ prompt: "x" }, { config: only, env: { HOME: emptyHome }, fetchImpl: noNetwork, execImpl: seatExec, runImpl, dataDir });
  assert.deepEqual(noLogin.tried.map((row) => row.status), ["not_configured"]);
  assert.match(noLogin.tried[0].detail, /not signed in/);
  assert.equal(ran, 0);
});

test("sibling module adapters: absent root, then whisk and open-generative-ai through their CLIs", async (t) => {
  const dataDir = tmpDir(t);
  const root = tmpDir(t);
  const only = (id) => ({ mode: "first-available", chain: [{ id, enabled: true, env: ["ALLSORTED_ROOT"] }] });

  const missing = await generateBackground({ prompt: "x" }, { config: only("whisk"), env: { ALLSORTED_ROOT: root }, fetchImpl: noNetwork, dataDir });
  assert.equal(missing.tried[0].status, "not_configured");
  assert.match(missing.tried[0].detail, /not installed/);

  fs.mkdirSync(path.join(root, "whisk", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "whisk", "src", "index.js"), "// stub");
  const whiskRuns = [];
  const whiskRun = async (command, args, options) => {
    whiskRuns.push({ command, args, options });
    const file = path.join(options.env.OUTPUT_DIRECTORY, "whisk-123.png");
    fs.writeFileSync(file, PNG);
    return { code: 0, stdout: JSON.stringify({ filepath: file, cost: null, costNote: "none" }), stderr: "", timedOut: false };
  };
  const whisk = await generateBackground({ prompt: "warm studio" }, { config: only("whisk"), env: { ALLSORTED_ROOT: root }, fetchImpl: noNetwork, runImpl: whiskRun, dataDir });
  assert.equal(whisk.provider, "whisk");
  assert.equal(whiskRuns[0].args[0], path.join(root, "whisk", "src", "index.js"));
  assert.deepEqual(whiskRuns[0].args.slice(1, 3), ["remix", "--text"]);
  assert.equal(path.dirname(whisk.results[0].src), path.join(dataDir, "library"));
  assertCredited(whisk.results);

  const unconfigured = async () => ({ code: 1, stdout: "", stderr: "[whisk] no key. Set the relevant provider key, then try again.", timedOut: false });
  const noKey = await generateBackground({ prompt: "warm studio" }, { config: only("whisk"), env: { ALLSORTED_ROOT: root }, fetchImpl: noNetwork, runImpl: unconfigured, dataDir });
  assert.equal(noKey.tried[0].status, "not_configured");

  fs.mkdirSync(path.join(root, "open-generative-ai"), { recursive: true });
  fs.writeFileSync(path.join(root, "open-generative-ai", "call.js"), "// stub");
  const needsKey = await generateBackground({ prompt: "x" }, { config: only("open-generative-ai"), env: { ALLSORTED_ROOT: root }, fetchImpl: noNetwork, dataDir });
  assert.equal(needsKey.tried[0].status, "not_configured");
  assert.match(needsKey.tried[0].detail, /FAL_API_KEY/);

  const ogaRuns = [];
  const ogaRun = async (command, args) => {
    ogaRuns.push(args);
    return { code: 0, stdout: JSON.stringify({ status: 200, data: { images: [{ url: "https://cdn.example.com/out.png" }] } }), stderr: "", timedOut: false };
  };
  const net = router({ "cdn.example.com": response({ bytes: PNG }) });
  const oga = await generateBackground(
    { prompt: "warm studio" },
    { config: only("open-generative-ai"), env: { ALLSORTED_ROOT: root, FAL_API_KEY: "fal" }, fetchImpl: net.fetchImpl, runImpl: ogaRun, dataDir },
  );
  assert.equal(oga.provider, "open-generative-ai");
  assert.deepEqual(ogaRuns[0].slice(1, 3), ["call", "fal-ai/flux/schnell"]);
  assert.ok(ogaRuns[0].includes("--confirm"));
  assert.deepEqual(fs.readFileSync(oga.results[0].src), PNG);
  assertCredited(oga.results);
});

test("mode ask never spends on generation until a provider is chosen", async (t) => {
  const dataDir = tmpDir(t);
  const env = { OPENAI_API_KEY: "k", HF_TOKEN: "h" };
  const waiting = await generateBackground({ prompt: "x" }, { config: config({}, "ask"), env, fetchImpl: noNetwork, execImpl: noSeat, dataDir });
  assert.equal(waiting.needsChoice, true);
  assert.deepEqual(waiting.results, []);
  assert.deepEqual(waiting.options.map((option) => option.id), ["openai-image", "huggingface"]);
  assert.equal(waiting.options[0].costHint, "hint for openai-image");

  const net = router({ "router.huggingface.co": response({ bytes: PNG }) });
  const chosen = await generateBackground({ prompt: "x" }, { config: config({}, "ask"), env, fetchImpl: net.fetchImpl, execImpl: noSeat, dataDir, provider: "huggingface" });
  assert.equal(chosen.provider, "huggingface");
  assert.equal(net.calls.length, 1);
});

test("an empty prompt is an error result, not a throw", async (t) => {
  const out = await generateBackground({ prompt: "  " }, { config: config(), env: {}, fetchImpl: noNetwork, execImpl: noSeat, dataDir: tmpDir(t) });
  assert.equal(out.provider, null);
  assert.equal(out.tried[0].status, "error");
});

test("config loading: data dir file, shipped example, CAROUSEL_HOME", (t) => {
  const example = loadProvidersConfig({ dataDir: tmpDir(t), env: {} });
  assert.equal(example.mode, "first-available");
  assert.deepEqual(example.chain.map((entry) => entry.id), CHAIN);
  assert.ok(example.chain.every((entry) => typeof entry.costHint === "string" && entry.costHint.length > 0));

  const home = tmpDir(t);
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify({ mode: "ask", chain: [{ id: "library" }, "pexels"] }));
  const own = loadProvidersConfig({ env: { CAROUSEL_HOME: home } });
  assert.equal(own.mode, "ask");
  assert.deepEqual(own.chain.map((entry) => entry.id), ["library", "pexels"]);
  assert.ok(own.chain.every((entry) => entry.enabled));
});

test("listProviders gives one row per chain entry without any network call", (t) => {
  const rows = listProviders({ config: config(), env: { PEXELS_API_KEY: "p" }, fetchImpl: noNetwork, execImpl: noSeat, dataDir: tmpDir(t) });
  assert.deepEqual(rows.map((row) => row.id), CHAIN);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.library.configured, true);
  assert.equal(byId.pexels.configured, true);
  assert.equal(byId.unsplash.status, "not_configured");
  assert.equal(byId["codex-imagegen"].experimental, true);
  assert.equal(byId["openai-image"].kind, "generate");
  assert.ok(rows.every((row) => row.license.length > 0));
});

test("the default process runner captures output and enforces its timeout", async () => {
  const { runProcess } = require("../lib/images/util");
  const ok = await runProcess(process.execPath, ["-e", "process.stdout.write('done')"], { timeoutMs: 10000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "done");
  assert.equal(ok.timedOut, false);
  const slow = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  const missing = await runProcess("definitely-not-a-real-command-xyz", [], { timeoutMs: 2000 });
  assert.notEqual(missing.code, 0);
  assert.ok(missing.error);
});
