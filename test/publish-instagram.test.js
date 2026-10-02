"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { publish, listPublishers, confirmTokenFor } = require("../lib/publish/index.js");
const live = (req, opts) => goLive(publish, req, opts);
const instagram = require("../lib/publish/instagram.js");
const { encodeJpeg, jpegSize, pngToJpeg } = require("../lib/publish/jpeg.js");
const { tmpDir, writeSlides, writeExport, goLive, makePng, response, mockFetch, noSleep } = require("./publish-helpers.js");

const ENV = { INSTAGRAM_ACCESS_TOKEN: "ig-token-abcdefgh", INSTAGRAM_USER_ID: "1789" };
const HOST = { kind: "url-prefix", urlPrefix: "https://media.example.com/c" };
const ID = "20260304-050607-test-deck";

function fixture(slides = 3, size) {
  const dataDir = tmpDir();
  const dir = path.join(dataDir, "exports", ID);
  return { dataDir, dir, files: writeExport(dir, slides, { size }) };
}

// Answers the Graph API the way Instagram does for a healthy carousel.
function graph(overrides = {}) {
  let child = 0;
  return mockFetch((call) => {
    const special = overrides[call.method] ? overrides[call.method](call) : null;
    if (special) return special;
    if (call.method === "HEAD") return response(200, "");
    if (call.url.endsWith("/1789/media") && call.json && call.json.is_carousel_item) {
      child += 1;
      return response(200, { id: `child-${child}` });
    }
    if (call.url.endsWith("/1789/media")) return response(200, { id: "container-1" });
    if (call.url.includes("container-1?fields=status_code")) return response(200, { status_code: "FINISHED", id: "container-1" });
    if (call.url.endsWith("/1789/media_publish")) return response(200, { id: "media-99" });
    if (call.url.includes("media-99?fields=permalink")) return response(200, { permalink: "https://www.instagram.com/p/AbCdEf/", id: "media-99" });
    return response(404, { error: { message: "unexpected call" } });
  });
}

test("Graph happy path: verify URLs, child containers, carousel container, publish, permalink", async () => {
  const { dataDir, dir, files } = fixture(3);
  const fetchImpl = graph();
  const [result] = await live({ files, caption: "Swipe through #carousel", targets: ["instagram"] },
    { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep }
  );
  assert.equal(result.status, "published");
  assert.equal(result.url, "https://www.instagram.com/p/AbCdEf/");
  assert.equal(result.postId, "media-99");

  const urls = [1, 2, 3].map((n) => `https://media.example.com/c/${ID}/jpeg/slide-0${n}.jpg`);
  const calls = fetchImpl.calls;
  assert.deepEqual(calls.map((c) => c.method), ["HEAD", "HEAD", "HEAD", "POST", "POST", "POST", "POST", "GET", "POST", "GET"]);
  assert.deepEqual(calls.slice(0, 3).map((c) => c.url), urls);
  for (let i = 0; i < 3; i += 1) {
    const call = calls[3 + i];
    assert.equal(call.url, "https://graph.facebook.com/v24.0/1789/media");
    assert.deepEqual(call.json, { image_url: urls[i], is_carousel_item: true });
    assert.equal(call.headers.Authorization, "Bearer ig-token-abcdefgh");
  }
  assert.deepEqual(calls[6].json, { media_type: "CAROUSEL", children: "child-1,child-2,child-3", caption: "Swipe through #carousel" });
  assert.equal(calls[7].url, "https://graph.facebook.com/v24.0/container-1?fields=status_code");
  assert.equal(calls[8].url, "https://graph.facebook.com/v24.0/1789/media_publish");
  assert.deepEqual(calls[8].json, { creation_id: "container-1" });
  for (const call of calls) assert.ok(!call.url.includes("ig-token"), "the token never goes in a URL");

  // The JPEG copies Instagram needs were written next to the PNGs.
  for (const n of [1, 2, 3]) {
    const jpg = fs.readFileSync(path.join(dir, "jpeg", `slide-0${n}.jpg`));
    assert.equal(jpg.readUInt16BE(0), 0xffd8);
    assert.equal(jpg.readUInt16BE(jpg.length - 2), 0xffd9);
    assert.deepEqual(jpegSize(jpg), { width: 40, height: 50 });
  }
});

test("the API host and version are configurable and status is polled while IN_PROGRESS", async () => {
  const { dataDir, files } = fixture(2);
  let polls = 0;
  const fetchImpl = graph({
    GET: (call) => {
      if (!call.url.includes("status_code")) return null;
      polls += 1;
      return response(200, { status_code: polls < 3 ? "IN_PROGRESS" : "FINISHED" });
    },
  });
  let slept = 0;
  const [result] = await live({ files, targets: ["instagram"] },
    { config: { mediaHost: HOST, targets: { instagram: { apiBase: "https://graph.instagram.com/", graphVersion: "v26.0", verifyUrls: false } } }, env: ENV, fetchImpl, dataDir, sleepImpl: async () => { slept += 1; } }
  );
  assert.equal(result.status, "published");
  assert.equal(fetchImpl.calls[0].url, "https://graph.instagram.com/v26.0/1789/media");
  assert.equal(fetchImpl.calls.filter((c) => c.method === "HEAD").length, 0);
  assert.equal(polls, 3);
  assert.equal(slept, 2);
});

test("slide count limits are enforced before any network call, never by dropping slides", async () => {
  const eleven = fixture(11);
  const fetchImpl = mockFetch();
  const [tooMany] = await live({ files: eleven.files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir: eleven.dataDir });
  assert.equal(tooMany.status, "error");
  assert.match(tooMany.detail, /11 slides.*limit here is 10/);
  const one = fixture(1);
  const [tooFew] = await live({ files: one.files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir: one.dataDir });
  assert.equal(tooFew.status, "error");
  assert.match(tooFew.detail, /at least 2 images/);
  assert.equal(fetchImpl.calls.length, 0);

  // maxSlides is configurable (the app allows 20 even though the API takes 10).
  const raised = graph();
  const [ok] = await live({ files: eleven.files, targets: ["instagram"] }, { config: { mediaHost: HOST, targets: { instagram: { maxSlides: 20 } } }, env: ENV, fetchImpl: raised, dataDir: eleven.dataDir, sleepImpl: noSleep });
  assert.equal(ok.status, "published");
  assert.equal(raised.calls.filter((c) => c.json && c.json.is_carousel_item).length, 11);
  assert.equal(listPublishers({ config: { mediaHost: HOST, targets: { instagram: { maxSlides: 20 } } }, env: ENV }).find((p) => p.id === "instagram").maxSlides, 20);
});

test("an unreachable public URL stops the post before Instagram is called", async () => {
  const { dataDir, files } = fixture(2);
  const fetchImpl = mockFetch((call) => (call.method === "HEAD" && call.url.endsWith("slide-02.jpg") ? response(404, "") : response(200, { id: "x" })));
  const [result] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir });
  assert.equal(result.status, "error");
  assert.match(result.detail, /1 public URL\(s\) did not answer.*slide-02\.jpg.*Sync the exports dir.*Nothing was sent/);
  assert.ok(fetchImpl.calls.every((c) => c.method === "HEAD"));
});

test("a failed container stops the flow and says nothing was published", async () => {
  const { dataDir, files } = fixture(3);
  let posts = 0;
  const fetchImpl = mockFetch((call) => {
    if (call.method === "HEAD") return response(200, "");
    posts += 1;
    return posts === 2 ? response(400, { error: { message: "Only photo or video can be accepted as media type.", code: 9004 } }) : response(200, { id: `child-${posts}` });
  });
  const [result] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir });
  assert.equal(result.status, "error");
  assert.match(result.detail, /Instagram image 2 of 3 failed \(HTTP 400\).*Only photo or video.*Nothing was published/);
  assert.equal(posts, 2);
  assert.ok(!fetchImpl.calls.some((c) => c.url.endsWith("/media_publish")));

  const errored = graph({ GET: (call) => (call.url.includes("status_code") ? response(200, { status_code: "ERROR" }) : null) });
  const [second] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl: errored, dataDir, sleepImpl: noSleep });
  assert.equal(second.status, "error");
  assert.match(second.detail, /status ERROR/);
  assert.ok(!errored.calls.some((c) => c.url.endsWith("/media_publish")));
});

function siblingRoot(body) {
  const root = tmpDir("allsorted-root-");
  const recipes = path.join(root, "instagram-agent", "recipes");
  fs.mkdirSync(recipes, { recursive: true });
  fs.writeFileSync(path.join(recipes, "post-carousel.js"), body);
  return root;
}

test("hands off to a sibling instagram module recipe when one is installed", async () => {
  const { dataDir, files } = fixture(3);
  const record = path.join(tmpDir(), "seen.json");
  const root = siblingRoot(`"use strict";
const fs = require("node:fs");
module.exports.runRecipe = async function runRecipe(input, context) {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ input, hasRunProcess: typeof context.runProcess === "function" }));
  if (input.confirm !== "PUBLISH") return { status: "error", reply: "confirm required", metadata: { published: false } };
  return { status: "ok", reply: "Instagram carousel published. Media ID: 4242.", metadata: { published: true, source: "official", result: { mediaId: "4242", permalink: "https://www.instagram.com/p/Sib/" } } };
};`);
  const env = { ALLSORTED_ROOT: root, META_IG_ACCESS_TOKEN: "meta-token-abcdefgh", META_IG_ACCOUNT_ID: "1789" };
  const config = { mediaHost: HOST };

  const listed = listPublishers({ config, env }).find((p) => p.id === "instagram");
  assert.equal(listed.wired, true);
  assert.equal(listed.transport, "sibling");
  assert.match(listed.reason, /hands off to the installed instagram module/);

  const fetchImpl = mockFetch((call) => (call.method === "HEAD" ? response(200, "") : response(500, "the Graph API must not be called")));
  const [result] = await live({ files, caption: "From the engine", targets: ["instagram"] }, { config, env, fetchImpl, dataDir });
  assert.equal(result.status, "published");
  assert.equal(result.url, "https://www.instagram.com/p/Sib/");
  assert.equal(result.postId, "4242");
  assert.ok(fetchImpl.calls.every((c) => c.method === "HEAD"), "only the reachability check used fetch");

  const seen = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(seen.input, {
    imageUrls: [1, 2, 3].map((n) => `https://media.example.com/c/${ID}/jpeg/slide-0${n}.jpg`),
    caption: "From the engine",
    confirm: "PUBLISH",
  });
  assert.equal(seen.hasRunProcess, true);

  // Without confirm the sibling recipe is never loaded.
  fs.rmSync(record);
  const [refused] = await publish({ files, targets: ["instagram"] }, { config, env, fetchImpl: mockFetch(), dataDir });
  assert.equal(refused.status, "refused");
  assert.equal(fs.existsSync(record), false);

  // transport "graph" ignores the sibling; with only META_IG_* set those act as the Graph credentials.
  const forced = graph();
  const [viaGraph] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST, targets: { instagram: { transport: "graph" } } }, env, fetchImpl: forced, dataDir, sleepImpl: noSleep });
  assert.equal(viaGraph.status, "published");
  assert.equal(forced.calls.find((c) => c.method === "POST").headers.Authorization, "Bearer meta-token-abcdefgh");
});

test("a failing sibling recipe is an unknown outcome and is not retried on the Graph API", async () => {
  const { dataDir, files } = fixture(2);
  const root = siblingRoot(`module.exports.runRecipe = async () => { throw new Error("python3 exited 1"); };`);
  const env = { ...ENV, ALLSORTED_ROOT: root, META_IG_ACCESS_TOKEN: "meta-token-abcdefgh", META_IG_ACCOUNT_ID: "1789" };
  const fetchImpl = mockFetch(() => response(200, ""));
  const [result] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST, targets: { instagram: { verifyUrls: false } } }, env, fetchImpl, dataDir });
  assert.equal(result.status, "unknown");
  assert.match(result.detail, /Instagram module failed: python3 exited 1.*may or may not be live.*not doubled/);
  assert.equal(fetchImpl.calls.length, 0);

  // A sibling that is installed but has no credentials falls back to the Graph transport in auto mode.
  const fallbackEnv = { ...ENV, ALLSORTED_ROOT: root };
  assert.equal(instagram.check({ config: { mediaHost: HOST }, env: fallbackEnv, target: { transport: "auto" } }).transport, "graph");
  const strict = instagram.check({ config: { mediaHost: HOST }, env: fallbackEnv, target: { transport: "sibling" } });
  assert.equal(strict.wired, false);
  assert.match(strict.reason, /sibling module transport/);
  assert.equal(instagram.findSibling({ env: {} }), null);
});

test("a dry run lists the public URLs, writes the JPEG copies and warns about story-sized slides", async () => {
  const { dataDir, dir, files } = fixture(2, { width: 27, height: 48 });
  const fetchImpl = mockFetch();
  const [result] = await publish({ files, caption: "x", targets: ["instagram"], dryRun: true }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir });
  assert.equal(result.status, "dry_run");
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(result.steps.includes(`  slide-01.jpg -> https://media.example.com/c/${ID}/jpeg/slide-01.jpg`));
  assert.ok(fs.existsSync(path.join(dir, "jpeg", "slide-02.jpg")), "JPEG copies are ready to sync");
  assert.match(result.detail, /27x48.*4:5 to 1\.91:1/);
  assert.equal(result.warnings.length, 1);
});

test("the JPEG encoder writes a baseline JPEG and only re-encodes when the PNG changes", () => {
  const rgb = Buffer.alloc(19 * 11 * 3, 200);
  const jpg = encodeJpeg({ width: 19, height: 11, rgb }, { quality: 85 });
  assert.equal(jpg.readUInt16BE(0), 0xffd8);
  assert.equal(jpg.toString("latin1", 6, 10), "JFIF");
  assert.equal(jpg.readUInt16BE(jpg.length - 2), 0xffd9);
  assert.deepEqual(jpegSize(jpg), { width: 19, height: 11 });
  assert.ok(encodeJpeg({ width: 19, height: 11, rgb }, { quality: 30 }).length <= jpg.length);
  assert.throws(() => encodeJpeg({ width: 4, height: 4, rgb: Buffer.alloc(3) }), TypeError);

  const dir = tmpDir();
  const png = path.join(dir, "slide.png");
  fs.writeFileSync(png, makePng({ width: 16, height: 16, pixel: (x, y) => [x * 16, y * 16, 90, 255] }));
  const out = pngToJpeg(png, path.join(dir, "jpeg", "slide.jpg"));
  assert.deepEqual(jpegSize(fs.readFileSync(out)), { width: 16, height: 16 });
});

// ---------------------------------------------------------------------------
// Hardening.

test("apiBase is an allowlist and graphVersion a strict pattern: the token never goes to another host", async () => {
  const { dataDir, files } = fixture(2);
  const bad = [
    { apiBase: "https://evil.example" },
    { apiBase: "http://graph.facebook.com" },
    { apiBase: "https://graph.facebook.com.evil.example" },
    { apiBase: "https://graph.facebook.com@evil.example" },
    { apiBase: "https://graph.facebook.com/../x" },
    { graphVersion: "v24.0/../../evil" },
    { graphVersion: "24" },
  ];
  for (const override of bad) {
    const config = { mediaHost: HOST, targets: { instagram: { ...override, verifyUrls: false } } };
    const listed = listPublishers({ config, env: ENV }).find((p) => p.id === "instagram");
    assert.equal(listed.wired, false, JSON.stringify(override));
    assert.match(listed.reason, /apiBase must be https:\/\/graph\.facebook\.com or https:\/\/graph\.instagram\.com|graphVersion must look like v24\.0/);
    const fetchImpl = mockFetch(() => response(200, { id: "x" }));
    const [r] = await live({ files, targets: ["instagram"] }, { config, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep });
    assert.equal(r.status, "not_wired", JSON.stringify(override));
    assert.equal(fetchImpl.calls.length, 0, "nothing was sent anywhere");
  }
  for (const apiBase of ["https://graph.facebook.com", "https://graph.instagram.com", "https://graph.instagram.com/"]) {
    assert.equal(listPublishers({ config: { mediaHost: HOST, targets: { instagram: { apiBase } } }, env: ENV }).find((p) => p.id === "instagram").wired, true);
  }
});

test("stale slides never go live: freshly built JPEGs or a size mismatch on the host stop the post", async () => {
  const { dataDir, dir, files } = fixture(2);
  const config = { mediaHost: HOST };
  const req = { files, caption: "x", targets: ["instagram"] };
  const token = confirmTokenFor(req, { dataDir });
  const size = (n) => fs.statSync(path.join(dir, "jpeg", `slide-0${n}.jpg`)).size;

  // Confirmed with a valid token, but no dry run wrote the JPEG copies: they
  // are built now, which means the host cannot have them yet.
  const first = graph();
  const [r1] = await publish({ ...req, confirm: "PUBLISH", confirmToken: token }, { config, env: ENV, fetchImpl: first, dataDir, sleepImpl: noSleep });
  assert.equal(r1.status, "error");
  assert.match(r1.detail, /2 JPEG copies were only just built or rebuilt \(slide-01\.jpg, slide-02\.jpg\).*Sync the exports dir, then retry\. Nothing was sent/);
  assert.equal(first.calls.length, 0);

  // The copies exist now, but the host still serves an older, different file.
  const stale = graph({ HEAD: (call) => response(200, "", { "content-length": String(size(call.url.endsWith("slide-01.jpg") ? 1 : 2) + (call.url.endsWith("slide-02.jpg") ? 17 : 0)) }) });
  const [r2] = await publish({ ...req, confirm: "PUBLISH", confirmToken: token }, { config, env: ENV, fetchImpl: stale, dataDir, sleepImpl: noSleep });
  assert.equal(r2.status, "error");
  assert.match(r2.detail, /1 public URL\(s\) hold an older version of the slide.*slide-02\.jpg.*Sync the exports dir to your media host, then retry\. Nothing was sent/);
  assert.ok(stale.calls.every((c) => c.method === "HEAD"));

  // Same size on the host: it goes out.
  const synced = graph({ HEAD: (call) => response(200, "", { "content-length": String(size(call.url.endsWith("slide-01.jpg") ? 1 : 2)) }) });
  const [r3] = await publish({ ...req, confirm: "PUBLISH", confirmToken: token }, { config, env: ENV, fetchImpl: synced, dataDir, sleepImpl: noSleep });
  assert.equal(r3.status, "published");

  // A re-render (newer PNG) makes the JPEG stale again, and changes the token.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(files[0], later, later);
  const again = graph();
  const [r4] = await publish({ ...req, confirm: "PUBLISH", confirmToken: token }, { config, env: ENV, fetchImpl: again, dataDir, sleepImpl: noSleep });
  assert.equal(r4.status, "error");
  assert.match(r4.detail, /1 JPEG copy was only just built or rebuilt \(slide-01\.jpg\)/);
  assert.equal(again.calls.length, 0);

  // A symlink planted as the jpeg folder is not followed.
  const other = fixture(2);
  const elsewhere = tmpDir();
  fs.symlinkSync(elsewhere, path.join(other.dir, "jpeg"));
  const [r5] = await publish({ files: other.files, targets: ["instagram"], dryRun: true }, { config, env: ENV, fetchImpl: mockFetch(), dataDir: other.dataDir });
  assert.match(JSON.stringify(r5.steps), /Could not make a JPEG copy of slide-01\.png: the jpeg folder is a symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("no answer on the publish call is an unknown outcome", async () => {
  const { dataDir, files } = fixture(2);
  const fetchImpl = graph({ POST: (call) => (call.url.endsWith("/media_publish") ? response(502, "bad gateway") : null) });
  const [r] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep });
  assert.equal(r.status, "unknown");
  assert.match(r.detail, /Instagram did not confirm the post, so it may or may not be live\. Check the account before you retry/);
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith("/media_publish")).length, 1);
  const rejected = graph({ POST: (call) => (call.url.endsWith("/media_publish") ? response(400, { error: { message: "Media ID is not available" } }) : null) });
  const [r2] = await live({ files, targets: ["instagram"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl: rejected, dataDir, sleepImpl: noSleep });
  assert.equal(r2.status, "error");
  assert.match(r2.detail, /rejected the publish call, so nothing is live/);
});

test("the sibling module only gets the Instagram variables, and a relative ALLSORTED_ROOT is ignored", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    META_IG_ACCESS_TOKEN: "meta-token-abcdefgh",
    META_IG_ACCOUNT_ID: "1789",
    IG_USERNAME: "",
    LINKEDIN_ACCESS_TOKEN: "li-token-abcdefgh",
    FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token-abcdefgh",
    TIKTOK_ACCESS_TOKEN: "tt-token-abcdefgh",
    OPENAI_API_KEY: "sk-abcdefgh",
    ALLSORTED_ROOT: "/somewhere",
  };
  assert.deepEqual(instagram.siblingEnv(env), { PATH: "/usr/bin", HOME: "/home/someone", META_IG_ACCESS_TOKEN: "meta-token-abcdefgh", META_IG_ACCOUNT_ID: "1789" });

  const root = siblingRoot(`module.exports.runRecipe = async () => ({ status: "ok", metadata: { published: true } });`);
  const found = instagram.findSibling({ env: { ALLSORTED_ROOT: root } });
  assert.equal(found, path.join(root, "instagram-agent", "recipes", "post-carousel.js"));
  assert.ok(path.isAbsolute(found));
  const cwd = process.cwd();
  process.chdir(path.dirname(root));
  try {
    assert.equal(instagram.findSibling({ env: { ALLSORTED_ROOT: path.basename(root) } }), null, "a relative root is never resolved against the working directory");
    assert.equal(instagram.findSibling({ env: { ALLSORTED_ROOT: `./${path.basename(root)}` } }), null);
  } finally {
    process.chdir(cwd);
  }
  // A recipe path that is a symlink out of the root is not used.
  const fake = tmpDir("allsorted-root-");
  fs.mkdirSync(path.join(fake, "instagram-agent", "recipes"), { recursive: true });
  fs.symlinkSync(found, path.join(fake, "instagram-agent", "recipes", "post-carousel.js"));
  assert.equal(instagram.findSibling({ env: { ALLSORTED_ROOT: fake } }), null);
});

test("JPEG output decodes back to the source image", { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/sips") ? "needs the macOS sips decoder" : false }, () => {
  const { spawnSync } = require("node:child_process");
  const { decodePng } = require("../lib/pdf.js");
  const dir = tmpDir();
  const width = 96;
  const height = 72;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 3;
      const block = ((x >> 4) + (y >> 4)) % 2;
      rgb[p] = block ? 230 : Math.round((x * 255) / width);
      rgb[p + 1] = block ? 40 : Math.round((y * 255) / height);
      rgb[p + 2] = block ? 60 : 128;
    }
  }
  const jpg = path.join(dir, "probe.jpg");
  const back = path.join(dir, "probe.png");
  fs.writeFileSync(jpg, encodeJpeg({ width, height, rgb }, { quality: 92 }));
  const run = spawnSync("/usr/bin/sips", ["-s", "format", "png", jpg, "--out", back], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const decoded = decodePng(back);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  let total = 0;
  for (let i = 0; i < rgb.length; i += 1) total += Math.abs(rgb[i] - decoded.rgb[i]);
  const mean = total / rgb.length;
  assert.ok(mean < 6, `mean absolute error ${mean.toFixed(2)} (a broken entropy coder gives 40 or more)`);
});
