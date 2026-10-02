"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listPublishers, publish, confirmTokenFor, isDryRun, IDS, STATUSES, redact } = require("../lib/publish/index.js");
const live = (req, opts) => goLive(publish, req, opts);
const linkedin = require("../lib/publish/linkedin.js");
const mediaHost = require("../lib/publish/media-host.js");
const store = require("../lib/store.js");
const { pngsToPdf } = require("../lib/pdf.js");
const { tmpDir, writeSlides, writeExport, goLive, makePng, rawPng, response, mockFetch, noSleep } = require("./publish-helpers.js");
const guard = require("../lib/publish/export-guard.js");
const http = require("../lib/publish/http.js");
const { decodePng, MAX_SIDE } = require("../lib/pdf.js");

const ALL = ["instagram", "linkedin", "facebook", "tiktok"];
const FULL_ENV = {
  LINKEDIN_ACCESS_TOKEN: "li-token-abcdefgh",
  LINKEDIN_AUTHOR_URN: "urn:li:person:abc123",
  INSTAGRAM_ACCESS_TOKEN: "ig-token-abcdefgh",
  INSTAGRAM_USER_ID: "1789",
  FACEBOOK_PAGE_ID: "5550001",
  FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token-abcdefgh",
  TIKTOK_ACCESS_TOKEN: "tt-token-abcdefgh",
};
const HOSTED = { mediaHost: { kind: "url-prefix", urlPrefix: "https://media.example.com/carousels/" } };

async function fixture(slides = 3) {
  const dataDir = tmpDir();
  const dir = path.join(dataDir, "exports", "20260304-050607-test-deck");
  const files = writeExport(dir, slides);
  const pdf = await pngsToPdf(files, path.join(dir, "carousel.pdf"));
  return { dataDir, dir, files, pdf };
}

test("listPublishers reports every target with wired and a reason", () => {
  const none = listPublishers({ config: null, env: {} });
  assert.deepEqual(none.map((p) => p.id), ALL);
  assert.deepEqual(IDS, ALL);
  for (const p of none) {
    assert.equal(p.wired, false);
    assert.equal(typeof p.reason, "string");
    assert.ok(p.reason.length > 10);
  }
  const wired = listPublishers({ config: HOSTED, env: FULL_ENV });
  assert.deepEqual(wired.map((p) => p.wired), [true, true, true, true]);
  assert.equal(wired.find((p) => p.id === "linkedin").format, "pdf");
  assert.equal(wired.find((p) => p.id === "instagram").maxSlides, 10);
});

test("without confirm PUBLISH every target is refused and nothing is fetched", async () => {
  const { dataDir, files, pdf } = await fixture();
  for (const confirm of [undefined, "", "publish", "Publish", "PUBLISH ", "yes", true, 1]) {
    const fetchImpl = mockFetch();
    const results = await publish({ files, pdf, caption: "Hi", targets: ALL, confirm }, { config: HOSTED, env: FULL_ENV, fetchImpl, dataDir });
    assert.deepEqual(results.map((r) => r.id), ALL);
    assert.deepEqual(results.map((r) => r.status), ["refused", "refused", "refused", "refused"], `confirm ${JSON.stringify(confirm)}`);
    for (const r of results) {
      assert.match(r.detail, /Nothing was sent/);
      assert.equal(r.url, null);
    }
    assert.equal(fetchImpl.calls.length, 0);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(files[0]), "jpeg")), false, "a refusal prepares nothing");
});

test("a dry run describes exactly what would be sent and sends nothing, even with confirm", async () => {
  const { dataDir, files, pdf } = await fixture();
  for (const confirm of [undefined, "PUBLISH"]) {
    const fetchImpl = mockFetch();
    const results = await publish({ files, pdf, caption: "Caption here", title: "My deck", targets: ALL, confirm, dryRun: true }, { config: HOSTED, env: FULL_ENV, fetchImpl, dataDir, now: new Date("2026-10-02T00:00:00Z") });
    assert.deepEqual(results.map((r) => r.status), ["dry_run", "dry_run", "dry_run", "dry_run"]);
    assert.equal(fetchImpl.calls.length, 0);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const r of results) {
      assert.match(r.detail, /^Would /);
      assert.match(r.detail, /nothing was sent/i);
      assert.equal(r.wired, true);
      assert.equal(r.url, null);
      assert.ok(Array.isArray(r.steps) && r.steps.length >= 3);
    }
    assert.match(byId.linkedin.detail, /carousel\.pdf \(3 pages\).*urn:li:person:abc123.*"My deck".*12 character caption.*LinkedIn-Version 202609/);
    assert.deepEqual(byId.linkedin.steps, [
      "POST https://api.linkedin.com/rest/documents?action=initializeUpload (owner urn:li:person:abc123)",
      "PUT carousel.pdf to the upload URL LinkedIn returns",
      "POST https://api.linkedin.com/rest/posts (document post, visibility PUBLIC, lifecycleState PUBLISHED)",
    ]);
    assert.ok(byId.instagram.steps.some((s) => s.includes("slide-01.jpg -> https://media.example.com/carousels/20260304-050607-test-deck/jpeg/slide-01.jpg")));
    assert.ok(byId.instagram.steps.some((s) => s.includes("/1789/media_publish")));
    assert.ok(byId.facebook.steps.some((s) => s.includes("/5550001/photos (upload slide-02.png, published: false)")));
    assert.ok(byId.tiktok.steps.some((s) => s.includes("/v2/post/publish/content/init/")));
    for (const r of results) assert.ok(!JSON.stringify(r).includes("token-abcdefgh"), "no credential in a dry run");
  }
});

test("a dry run for an unwired target says what is missing", async () => {
  const { dataDir, files, pdf } = await fixture();
  const results = await publish({ files, pdf, targets: ["linkedin", "instagram"], dryRun: true }, { config: null, env: {}, fetchImpl: mockFetch(), dataDir });
  assert.equal(results[0].status, "dry_run");
  assert.equal(results[0].wired, false);
  assert.match(results[0].detail, /Not wired yet: LinkedIn needs LINKEDIN_ACCESS_TOKEN and LINKEDIN_AUTHOR_URN/);
  assert.match(results[1].detail, /Not wired yet: Instagram needs INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID/);
});

test("LinkedIn happy path: initialize upload, PUT the PDF, create the document post", async () => {
  const { dataDir, files, pdf } = await fixture();
  const uploadUrl = "https://www.linkedin.com/dms-uploads/abc/uploadedDocument/0?ca=x";
  const fetchImpl = mockFetch((call, i) => {
    if (i === 0) return response(200, { value: { uploadUrl, document: "urn:li:document:D123", uploadUrlExpiresAt: 1 } });
    if (i === 1) return response(201, "");
    return response(201, "", { "x-restli-id": "urn:li:share:7001" });
  });
  const results = await live({ files, pdf, caption: "Ship it (today) #carousel", title: "My deck", targets: ["linkedin"] },
    { config: null, env: FULL_ENV, fetchImpl, dataDir, now: new Date("2026-10-02T03:00:00Z") }
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "published");
  assert.equal(results[0].url, "https://www.linkedin.com/feed/update/urn:li:share:7001/");
  assert.equal(results[0].postId, "urn:li:share:7001");

  const [init, upload, post] = fetchImpl.calls;
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(init.method, "POST");
  assert.equal(init.url, "https://api.linkedin.com/rest/documents?action=initializeUpload");
  assert.deepEqual(init.json, { initializeUploadRequest: { owner: "urn:li:person:abc123" } });
  assert.equal(init.headers.Authorization, "Bearer li-token-abcdefgh");
  assert.equal(init.headers["LinkedIn-Version"], "202609");
  assert.equal(init.headers["X-Restli-Protocol-Version"], "2.0.0");

  assert.equal(upload.method, "PUT");
  assert.equal(upload.url, uploadUrl);
  assert.ok(Buffer.isBuffer(upload.body) && upload.body.equals(fs.readFileSync(pdf)));
  assert.equal(upload.headers.Authorization, "Bearer li-token-abcdefgh");

  assert.equal(post.method, "POST");
  assert.equal(post.url, "https://api.linkedin.com/rest/posts");
  assert.equal(post.headers["LinkedIn-Version"], "202609");
  assert.deepEqual(post.json, {
    author: "urn:li:person:abc123",
    commentary: "Ship it \\(today\\) #carousel",
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { title: "My deck", id: "urn:li:document:D123" } },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
});

test("the LinkedIn version header is last month in YYYYMM and can be overridden", () => {
  assert.equal(linkedin.apiVersion(new Date("2026-10-02T00:00:00Z")), "202609");
  assert.equal(linkedin.apiVersion(new Date("2027-01-15T00:00:00Z")), "202612");
  assert.equal(linkedin.apiVersion(new Date("2026-03-31T23:00:00Z")), "202602");
  assert.equal(linkedin.apiVersion(new Date("2026-10-02T00:00:00Z"), "202511"), "202511");
  assert.equal(linkedin.apiVersion(new Date("2026-10-02T00:00:00Z"), "latest"), "202609");
});

test("the LinkedIn version can be pinned in config or the environment", async () => {
  const { dataDir, files, pdf } = await fixture();
  const answer = (call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D1" } }) : response(201, "", { "x-restli-id": "urn:li:share:1" }));
  const viaConfig = mockFetch(answer);
  await live({ files, pdf, targets: ["linkedin"] }, { config: { targets: { linkedin: { apiVersion: "202605" } } }, env: FULL_ENV, fetchImpl: viaConfig, dataDir });
  assert.equal(viaConfig.calls[0].headers["LinkedIn-Version"], "202605");
  const viaEnv = mockFetch(answer);
  await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: { ...FULL_ENV, LINKEDIN_API_VERSION: "202607" }, fetchImpl: viaEnv, dataDir });
  assert.equal(viaEnv.calls[2].headers["LinkedIn-Version"], "202607");
});

test("LinkedIn failures stop the flow, come back as error and never leak the token", async () => {
  const { dataDir, files, pdf } = await fixture();
  const denied = mockFetch(() => response(401, { message: "Invalid access token li-token-abcdefgh", status: 401 }));
  const [r1] = await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl: denied, dataDir });
  assert.equal(r1.status, "error");
  assert.match(r1.detail, /HTTP 401/);
  assert.ok(!r1.detail.includes("li-token-abcdefgh"));
  assert.match(r1.detail, /\[redacted\]/);
  assert.equal(denied.calls.length, 1);

  const strangeHost = mockFetch(() => response(200, { value: { uploadUrl: "https://uploads.example.net/steal", document: "urn:li:document:D1" } }));
  const [r2] = await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl: strangeHost, dataDir });
  assert.equal(r2.status, "error");
  assert.match(r2.detail, /unexpected host/);
  assert.equal(strangeHost.calls.length, 1, "the token is never sent to an unknown host");

  const uploadFails = mockFetch((call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D1" } }) : response(500, "boom")));
  const [r3] = await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl: uploadFails, dataDir });
  assert.equal(r3.status, "error");
  assert.match(r3.detail, /PDF upload failed \(HTTP 500\).*Nothing was posted/);
  assert.equal(uploadFails.calls.length, 2);

  const offline = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.linkedin.com");
  };
  const [r4] = await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl: offline, dataDir });
  assert.equal(r4.status, "error");
  assert.match(r4.detail, /ENOTFOUND/);

  const [r5] = await live({ files, pdf: null, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl: mockFetch(), dataDir });
  assert.equal(r5.status, "error");
  assert.match(r5.detail, /no PDF was given/);
});

test("not_wired reasons name what is missing, per target", async () => {
  const { dataDir, files, pdf } = await fixture();
  const fetchImpl = mockFetch();
  const bare = await live({ files, pdf, targets: ALL }, { config: null, env: {}, fetchImpl, dataDir });
  assert.deepEqual(bare.map((r) => r.status), ["not_wired", "not_wired", "not_wired", "not_wired"]);
  const byId = Object.fromEntries(bare.map((r) => [r.id, r.detail]));
  assert.match(byId.instagram, /INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID/);
  assert.match(byId.linkedin, /LINKEDIN_ACCESS_TOKEN and LINKEDIN_AUTHOR_URN/);
  assert.match(byId.facebook, /FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN/);
  assert.match(byId.tiktok, /TIKTOK_ACCESS_TOKEN/);
  assert.match(byId.tiktok, /requires an audited TikTok app; unaudited apps can only post privately/);

  // Credentials present but no media host: the URL-only targets say so.
  const noHost = await live({ files, pdf, targets: ["instagram", "linkedin", "tiktok"] }, { config: { mediaHost: { kind: "none" } }, env: { ...FULL_ENV, LINKEDIN_AUTHOR_URN: "not-a-urn" }, fetchImpl, dataDir });
  const second = Object.fromEntries(noHost.map((r) => [r.id, r]));
  assert.equal(second.instagram.status, "not_wired");
  assert.match(second.instagram.detail, /public URLs.*mediaHost\.kind.*url-prefix/);
  assert.equal(second.tiktok.status, "not_wired");
  assert.match(second.tiktok.detail, /mediaHost\.kind/);
  assert.match(second.tiktok.detail, /requires an audited TikTok app; unaudited apps can only post privately/);
  assert.equal(second.linkedin.status, "not_wired");
  assert.match(second.linkedin.detail, /LINKEDIN_AUTHOR_URN must look like/);

  const off = await live({ files, pdf, targets: ["linkedin"] }, { config: { targets: { linkedin: { enabled: false } } }, env: FULL_ENV, fetchImpl, dataDir });
  assert.equal(off[0].status, "not_wired");
  assert.match(off[0].detail, /switched off/);

  const badHost = await live({ files, pdf, targets: ["instagram"] }, { config: { mediaHost: { kind: "url-prefix", urlPrefix: "http://plain.example.com" } }, env: FULL_ENV, fetchImpl, dataDir });
  assert.equal(badHost[0].status, "not_wired");
  assert.match(badHost[0].detail, /https:\/\//);
  assert.equal(fetchImpl.calls.length, 0);
});

test("unknown targets are errors, target lists are normalised", async () => {
  const { dataDir, files, pdf } = await fixture();
  const results = await live({ files, pdf, targets: " LinkedIn, myspace ,linkedin" }, { config: null, env: {}, fetchImpl: mockFetch(), dataDir });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [["linkedin", "not_wired"], ["myspace", "error"]]);
  assert.match(results[1].detail, /Unknown target "myspace"/);
  assert.deepEqual(await publish({ files, targets: [] }, { env: {}, dataDir }), []);
});

test("every attempt is appended to the publish log through the store", async () => {
  const { dataDir, files, pdf } = await fixture();
  const fetchImpl = mockFetch((call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D1" } }) : response(201, "", { "x-restli-id": "urn:li:share:9" })));
  await publish({ files, pdf, caption: "Hello", targets: ["linkedin", "facebook"] }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
  await publish({ files, pdf, caption: "Hello", targets: ["linkedin"], dryRun: true }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
  const results = await live({ files, pdf, caption: "Hello", title: "T", targets: ["linkedin", "tiktok"] }, { config: null, env: { ...FULL_ENV, TIKTOK_ACCESS_TOKEN: "" }, fetchImpl, dataDir });
  assert.ok(results.every((r) => r.logged === true));

  const log = store.readPublishLog({ dataDir });
  assert.deepEqual(log.map((e) => [e.target, e.status]), [["linkedin", "refused"], ["facebook", "refused"], ["linkedin", "dry_run"], ["linkedin", "dry_run"], ["tiktok", "dry_run"], ["linkedin", "published"], ["tiktok", "not_wired"]]);
  const published = log[5];
  assert.equal(published.tokenMatched, true);
  assert.equal(published.url, "https://www.linkedin.com/feed/update/urn:li:share:9/");
  assert.equal(published.confirmed, true);
  assert.equal(published.dryRun, false);
  assert.equal(published.slides, 3);
  assert.equal(published.pdf, "carousel.pdf");
  assert.equal(published.source, "20260304-050607-test-deck");
  assert.equal(published.captionChars, 5);
  assert.match(published.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!fs.readFileSync(path.join(dataDir, "logs", "publish.jsonl"), "utf8").includes("token-abcdefgh"));
});

test("credentials come only from the env object: a .env file on disk is never read", async () => {
  const { dataDir, files, pdf } = await fixture();
  const secrets = Object.entries(FULL_ENV).map(([k, v]) => `${k}=${v}`).join("\n");
  fs.writeFileSync(path.join(dataDir, ".env"), secrets);
  const cwd = process.cwd();
  const work = tmpDir();
  fs.writeFileSync(path.join(work, ".env"), secrets);
  process.chdir(work);
  try {
    assert.ok(listPublishers({ config: HOSTED, env: {}, dataDir }).every((p) => p.wired === false));
    const results = await live({ files, pdf, targets: ALL }, { config: HOSTED, env: {}, fetchImpl: mockFetch(), dataDir });
    assert.ok(results.every((r) => r.status === "not_wired"));
  } finally {
    process.chdir(cwd);
  }
  const sources = fs.readdirSync(path.join(__dirname, "..", "lib", "publish")).map((name) => fs.readFileSync(path.join(__dirname, "..", "lib", "publish", name), "utf8"));
  for (const source of sources) assert.ok(!/["'`][^"'`]*\.env["'`]|dotenv/.test(source), "no publisher opens a .env file");
});

test("redact strips credential values from messages", () => {
  assert.equal(redact("bad token li-token-abcdefgh here", FULL_ENV), "bad token [redacted] here");
  assert.equal(redact("page 5550001", FULL_ENV), "page 5550001");
  assert.equal(redact(undefined, FULL_ENV), "");
});

test("media host: url-prefix maps export files under the prefix, none is not wired", () => {
  const dataDir = tmpDir();
  const dir = path.join(dataDir, "exports", "20260304-050607-test-deck");
  const [first] = writeSlides(dir, 1);
  const spaced = path.join(tmpDir(), "my slide #1.png");
  fs.copyFileSync(first, spaced);
  const ctx = { config: { mediaHost: { kind: "url-prefix", urlPrefix: "https://cdn.example.com/c/" } }, dataDir };
  assert.equal(mediaHost.urlFor(first, ctx), "https://cdn.example.com/c/20260304-050607-test-deck/slide-01.png");
  assert.equal(mediaHost.urlFor(spaced, ctx), "https://cdn.example.com/c/my%20slide%20%231.png");

  const png = mediaHost.resolve([first], { ...ctx, imageFormat: "png" });
  assert.equal(png.ok, true);
  assert.deepEqual(png.items, [{ file: first, upload: first, url: "https://cdn.example.com/c/20260304-050607-test-deck/slide-01.png", written: false }]);
  assert.deepEqual(png.rebuilt, []);

  const planned = mediaHost.resolve([first], { ...ctx, imageFormat: "jpeg", prepare: false });
  assert.equal(planned.items[0].url, "https://cdn.example.com/c/20260304-050607-test-deck/jpeg/slide-01.jpg");
  assert.equal(fs.existsSync(planned.items[0].upload), false, "prepare: false writes nothing");

  assert.equal(mediaHost.check({ config: { mediaHost: { kind: "none" } } }).ok, false);
  assert.match(mediaHost.check({ config: {} }).reason, /No media host is configured/);
  assert.match(mediaHost.check({ config: { mediaHost: { kind: "ftp" } } }).reason, /Unknown mediaHost\.kind/);
  assert.equal(mediaHost.resolve([first], { config: {}, dataDir }).ok, false);
});

test("verifyReachable reports URLs that do not answer and falls back from HEAD to GET", async () => {
  const fetchImpl = mockFetch((call) => {
    if (call.url.endsWith("/a.jpg")) return response(200, "");
    if (call.url.endsWith("/b.jpg")) return call.method === "HEAD" ? response(405, "") : response(206, "x");
    return response(404, "");
  });
  const out = await mediaHost.verifyReachable(["https://h.example/a.jpg", "https://h.example/b.jpg", "https://h.example/c.jpg"], { fetchImpl });
  assert.equal(out.ok, false);
  assert.deepEqual(out.failures.map((f) => [f.url, f.status]), [["https://h.example/c.jpg", 404]]);
  assert.deepEqual(fetchImpl.calls.map((c) => c.method), ["HEAD", "HEAD", "GET", "HEAD"]);
  assert.match(mediaHost.unreachableDetail(out.failures), /Sync the exports dir/);
});

// ---------------------------------------------------------------------------
// The gates, one by one.

const LI = (call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D1" } }) : response(201, "", { "x-restli-id": "urn:li:share:9" }));

test("isDryRun fails closed: only absent, false, \"false\", 0 and \"\" are not a dry run", () => {
  for (const off of [undefined, null, false, "false", 0, ""]) assert.equal(isDryRun(off), false, JSON.stringify(off));
  for (const on of [true, "true", 1, "1", "yes", "True", "FALSE", "no", " ", [], {}, ["false"]]) assert.equal(isDryRun(on), true, JSON.stringify(on));
});

test("any truthy dryRun or dry_run is a dry run, even with confirm and a valid token", async () => {
  const { dataDir, files, pdf } = await fixture();
  const req = { files, pdf, caption: "Hi", targets: ["linkedin"] };
  const token = confirmTokenFor(req, { dataDir });
  assert.match(token, /^[0-9a-f]{24}$/);
  for (const value of [true, 1, "1", "yes", "True", "true", "on", {}]) {
    for (const key of ["dryRun", "dry_run"]) {
      const fetchImpl = mockFetch(LI);
      const [r] = await publish({ ...req, confirm: "PUBLISH", confirmToken: token, [key]: value }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
      assert.equal(r.status, "dry_run", `${key}: ${JSON.stringify(value)}`);
      assert.equal(fetchImpl.calls.length, 0, `${key}: ${JSON.stringify(value)} sent nothing`);
    }
  }
  // The values that are not a dry run publish, given confirm and the token.
  for (const value of [false, "false", 0, ""]) {
    const fetchImpl = mockFetch(LI);
    const [r] = await publish({ ...req, confirm: "PUBLISH", confirmToken: token, dryRun: value }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
    assert.equal(r.status, "published", JSON.stringify(value));
  }
});

test("confirm must be the exact string PUBLISH: no coercion, no trimming", async () => {
  const { dataDir, files, pdf } = await fixture();
  const req = { files, pdf, caption: "Hi", targets: ["linkedin"] };
  const token = confirmTokenFor(req, { dataDir });
  for (const confirm of [["PUBLISH"], " PUBLISH", "PUBLISH\n", "PUBLISH ", "publish", { toString: () => "PUBLISH" }, new String("PUBLISH"), true, 1, null]) {
    const fetchImpl = mockFetch(LI);
    const [r] = await publish({ ...req, confirm, confirmToken: token }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
    assert.equal(r.status, "refused", JSON.stringify(confirm));
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test("a confirmed publish needs the confirmToken of a dry run of this exact request", async () => {
  const { dataDir, files, pdf } = await fixture();
  const opts = { config: null, env: FULL_ENV, dataDir };
  const req = { files, pdf, caption: "Approved caption", title: "T", targets: ["linkedin"] };
  const [dry] = await publish({ ...req, dryRun: true }, { ...opts, fetchImpl: mockFetch() });
  assert.equal(dry.status, "dry_run");
  assert.match(dry.confirmToken, /^[0-9a-f]{24}$/);
  assert.equal(dry.confirmToken, confirmTokenFor(req, { dataDir }));

  // No token, a wrong token, or a non-string token: refused, with the plan and the current token.
  for (const confirmToken of [undefined, "", "0".repeat(24), [dry.confirmToken], 12345]) {
    const fetchImpl = mockFetch(LI);
    const [r] = await publish({ ...req, confirm: "PUBLISH", confirmToken }, { ...opts, fetchImpl });
    assert.equal(r.status, "refused", JSON.stringify(confirmToken));
    assert.match(r.detail, /^Nothing was sent\. The confirmToken (is missing|does not match this request)/);
    assert.match(r.detail, /Would post carousel\.pdf \(3 pages\) to LinkedIn/);
    assert.equal(r.confirmToken, dry.confirmToken);
    assert.ok(Array.isArray(r.steps) && r.steps.length === 3);
    assert.equal(fetchImpl.calls.length, 0);
  }

  // The approved token does not cover a changed caption, title, target list or slide.
  const changes = [
    { ...req, caption: "Approved caption plus an injected line" },
    { ...req, title: "Other" },
    { ...req, targets: ["linkedin", "facebook"] },
    { ...req, files: files.slice(0, 2) },
  ];
  for (const changed of changes) {
    const fetchImpl = mockFetch(LI);
    const out = await publish({ ...changed, confirm: "PUBLISH", confirmToken: dry.confirmToken }, { ...opts, fetchImpl });
    assert.ok(out.every((r) => r.status === "refused"), JSON.stringify(out.map((r) => r.status)));
    assert.ok(out.every((r) => r.confirmToken && r.confirmToken !== dry.confirmToken));
    assert.equal(fetchImpl.calls.length, 0);
  }
  fs.writeFileSync(files[0], makePng({ width: 40, height: 50, pixel: () => [1, 2, 3, 255] }));
  const edited = mockFetch(LI);
  const [afterEdit] = await publish({ ...req, confirm: "PUBLISH", confirmToken: dry.confirmToken }, { ...opts, fetchImpl: edited });
  assert.equal(afterEdit.status, "refused", "a re-rendered slide needs a new dry run");
  assert.equal(edited.calls.length, 0);

  // The matching token publishes. Target order does not matter.
  const two = { ...req, targets: ["facebook", "linkedin"] };
  assert.equal(confirmTokenFor(two, { dataDir }), confirmTokenFor({ ...two, targets: "linkedin, facebook" }, { dataDir }));
  const live2 = mockFetch(LI);
  const [ok] = await publish({ ...req, confirm: "PUBLISH", confirmToken: afterEdit.confirmToken }, { ...opts, fetchImpl: live2 });
  assert.equal(ok.status, "published");
});

test("only exports inside the data dir with a passed layout check can be published", async () => {
  const { dataDir, dir, files, pdf } = await fixture();
  const opts = { config: null, env: FULL_ENV, dataDir };
  const blocked = async (req, pattern, label) => {
    for (const mode of [{ dryRun: true }, { confirm: "PUBLISH", confirmToken: "x" }]) {
      const fetchImpl = mockFetch(LI);
      const out = await publish({ targets: ["linkedin", "facebook"], ...req, ...mode }, { ...opts, fetchImpl });
      assert.ok(out.every((r) => r.status === "error"), `${label}: ${JSON.stringify(out.map((r) => r.status))}`);
      assert.match(out[0].detail, pattern, label);
      assert.match(out[0].detail, /Nothing was sent\.$/);
      assert.equal(fetchImpl.calls.length, 0, label);
      assert.equal(confirmTokenFor(req, { dataDir }), null);
    }
  };

  // Slides outside the data dir, even with a perfect manifest next to them.
  const outside = tmpDir();
  const stray = writeExport(path.join(outside, "20260304-050607-outside"), 2);
  await blocked({ files: stray }, /outside the data dir/, "outside");

  // No manifest, a corrupt manifest, a failed or missing layout check.
  const bare = path.join(dataDir, "exports", "20260304-050607-bare");
  await blocked({ files: writeSlides(bare, 2) }, /no layout check on record/, "no manifest");
  fs.writeFileSync(path.join(bare, "export.json"), "{not json");
  await blocked({ files: writeSlides(bare, 2) }, /not valid JSON/, "corrupt manifest");
  const failedDir = path.join(dataDir, "exports", "20260304-050607-failed");
  await blocked({ files: writeExport(failedDir, 2, { qa: { ok: false, issues: ["slide-2: text overflows"] } }) }, /did not pass the layout check.*slide-2: text overflows/, "qa failed");
  await blocked({ files: writeExport(failedDir, 2, { qa: null }) }, /did not pass the layout check.*no passing check is on record/, "qa missing");
  await blocked({ files: writeExport(failedDir, 2, { qa: { ok: "true" } }) }, /did not pass the layout check/, "qa.ok must be the boolean true");

  // Manifest entries that are absolute or climb out with "..".
  const tricky = path.join(dataDir, "exports", "20260304-050607-tricky");
  const trickyFiles = writeExport(tricky, 2);
  const rewrite = (manifest) => fs.writeFileSync(path.join(tricky, "export.json"), JSON.stringify({ files: ["slide-01.png", "slide-02.png"], qa: { ok: true }, ...manifest }));
  rewrite({ files: ["slide-01.png", stray[0]] });
  await blocked({ files: trickyFiles }, /lists a slide outside its own folder/, "absolute entry");
  rewrite({ files: ["slide-01.png", "../20260304-050607-test-deck/slide-02.png"] });
  await blocked({ files: trickyFiles }, /lists a slide outside its own folder/, "dotdot entry");
  rewrite({ pdf: "/etc/hosts" });
  await blocked({ files: trickyFiles }, /points its PDF outside its own folder/, "absolute pdf");
  rewrite({ pdf: "../../secrets.pdf" });
  await blocked({ files: trickyFiles }, /points its PDF outside its own folder/, "dotdot pdf");
  rewrite({});

  // A slide that is not listed, a symlinked slide, a PDF from elsewhere, a non-image.
  const extra = path.join(tricky, "slide-99.png");
  fs.copyFileSync(trickyFiles[0], extra);
  await blocked({ files: [...trickyFiles, extra] }, /slide-99\.png is not part of this export/, "unlisted slide");
  const link = path.join(tricky, "slide-02.png");
  fs.rmSync(link);
  fs.symlinkSync(stray[1], link);
  await blocked({ files: trickyFiles }, /slide-02\.png is a symlink/, "symlinked slide");
  await blocked({ files, pdf: path.join(outside, "x.pdf") }, /PDF not found|outside the data dir/, "pdf elsewhere");
  fs.writeFileSync(path.join(outside, "x.pdf"), "%PDF-1.4");
  await blocked({ files, pdf: path.join(outside, "x.pdf") }, /PDF x\.pdf is outside the data dir/, "pdf outside");
  await blocked({ files: [path.join(dir, "export.json")] }, /not a PNG or JPEG/, "not an image");
  await blocked({ files: [] }, /no slides to publish/, "no files");
  await blocked({ files: Array.from({ length: guard.MAX_SLIDES + 1 }, () => files[0]) }, /At most 100 can be published/, "too many slides");
  assert.equal(pdf.endsWith("carousel.pdf"), true);
});

test("a caption file must be a small regular file inside the data dir", () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "caption.txt"), "From a file");
  assert.deepEqual(guard.readCaptionFile(path.join(dataDir, "caption.txt"), { dataDir }), { ok: true, caption: "From a file" });
  const outside = path.join(tmpDir(), "secrets.env");
  fs.writeFileSync(outside, "API_KEY=abc");
  assert.match(guard.readCaptionFile(outside, { dataDir }).reason, /outside the data dir/);
  fs.symlinkSync(outside, path.join(dataDir, "link.txt"));
  assert.match(guard.readCaptionFile(path.join(dataDir, "link.txt"), { dataDir }).reason, /is a symlink/);
  fs.writeFileSync(path.join(dataDir, "big.txt"), Buffer.alloc(guard.MAX_CAPTION_BYTES + 1, 97));
  assert.match(guard.readCaptionFile(path.join(dataDir, "big.txt"), { dataDir }).reason, /larger than/);
  assert.match(guard.readCaptionFile(path.join(dataDir, "exports"), { dataDir }).reason, /not found|not a regular file/);
  assert.match(guard.readCaptionFile(path.join(dataDir, "..", path.basename(dataDir), "..", `no-such-file-${path.basename(dataDir)}`), { dataDir }).reason, /not found/);
  assert.equal(guard.readCaptionFile(outside, { dataDir }).reason, "Caption file secrets.env is outside the data dir.");
});

test("crafted PNGs are refused before they can exhaust memory", async () => {
  const dir = tmpDir();
  // A header that claims a huge image.
  assert.throws(() => decodePng(rawPng({ width: MAX_SIDE + 1, height: 10, data: Buffer.alloc(16) })), /larger than the 8192 pixel limit/);
  assert.throws(() => decodePng(rawPng({ width: 10, height: 70000, data: Buffer.alloc(16) })), /larger than the 8192 pixel limit/);
  // A small header with image data that inflates far past what it declares (a zlib bomb).
  const bomb = rawPng({ width: 4, height: 4, data: Buffer.alloc(8 * 1024 * 1024) });
  assert.ok(bomb.length < 64 * 1024, "the bomb is tiny on disk");
  assert.throws(() => decodePng(bomb), /image data is larger than the header says/);
  const bombFile = path.join(dir, "bomb.png");
  fs.writeFileSync(bombFile, bomb);
  await assert.rejects(() => require("../lib/pdf.js").pngsToPdf([bombFile], path.join(dir, "out.pdf")), /larger than the header says/);
  assert.throws(() => require("../lib/publish/jpeg.js").pngToJpeg(bombFile, path.join(dir, "jpeg", "bomb.jpg")), /larger than the header says/);
  assert.equal(fs.existsSync(path.join(dir, "jpeg", "bomb.jpg")), false);
  // Too many pages, and a directory passed as a PNG.
  await assert.rejects(() => require("../lib/pdf.js").pngsToPdf(Array.from({ length: 301 }, () => bombFile), path.join(dir, "out.pdf")), /at most 300 pages/);
  assert.throws(() => decodePng(dir), /not a regular file/);
  assert.throws(() => require("../lib/publish/jpeg.js").encodeJpeg({ width: 9000, height: 2, rgb: Buffer.alloc(9000 * 2 * 3) }), /8192 pixel limit/);
});

test("the adapters are gated themselves: a direct call without confirm sends nothing", async () => {
  const { dataDir, files, pdf } = await fixture();
  const payload = { files, pdf, caption: "x", title: "t" };
  const cfg = { mediaHost: HOSTED.mediaHost, targets: {} };
  for (const id of ALL) {
    const adapter = require(`../lib/publish/${id}.js`);
    for (const extra of [{}, { confirm: "publish" }, { confirm: ["PUBLISH"] }, { confirm: "PUBLISH", dryRun: true }, { confirm: "PUBLISH", dryRun: "yes" }]) {
      const fetchImpl = mockFetch();
      const out = await adapter.publish(payload, { config: cfg, env: FULL_ENV, fetchImpl, dataDir, target: { enabled: true }, ...extra });
      assert.equal(out.status, "refused", `${id} ${JSON.stringify(extra)}`);
      assert.equal(fetchImpl.calls.length, 0);
    }
  }
});

test("requests that carry a token never follow redirects, and error bodies are redacted before they are cut", async () => {
  const { dataDir, files, pdf } = await fixture();
  const fetchImpl = mockFetch(LI);
  await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
  assert.equal(fetchImpl.calls.length, 3);
  for (const call of fetchImpl.calls) assert.equal(call.redirect, "error");

  // The token sits right across the 300 character cut of the error body.
  const env = { LINKEDIN_ACCESS_TOKEN: "  li-token-abcdefgh  " };
  const body = `${"x".repeat(292)}li-token-abcdefgh and more`;
  const detail = http.failure("Step", { ok: false, status: 400, json: null, text: body, error: null }, env);
  assert.ok(!detail.includes("li-token"), "no prefix of the token survives the cut");
  assert.match(detail, /x\[redacte$/, "the cut lands inside the placeholder, not inside the token");
  assert.equal(http.redact("x li-token-abcdefgh y", env), "x [redacted] y", "redaction uses the trimmed value");
  assert.equal(http.uncertain({ ok: false, status: 0 }), true);
  assert.equal(http.uncertain({ ok: false, status: 503 }), true);
  assert.equal(http.uncertain({ ok: false, status: 400 }), false);
  assert.deepEqual(STATUSES, ["published", "dry_run", "refused", "not_wired", "error", "unknown", "processing"]);
});

test("LinkedIn: no answer or a server error on the create call is an unknown outcome, never retried", async () => {
  const { dataDir, files, pdf } = await fixture();
  const init = response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D1" } });
  const cases = [
    (call, i) => (i === 0 ? init : i === 1 ? response(201, "") : response(503, "upstream unavailable")),
    async (call, i) => {
      if (i === 0) return init;
      if (i === 1) return response(201, "");
      throw new Error("socket hang up");
    },
  ];
  for (const handler of cases) {
    const fetchImpl = mockFetch(handler);
    const [r] = await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl, dataDir });
    assert.equal(r.status, "unknown");
    assert.match(r.detail, /LinkedIn did not confirm the post, so it may or may not be live\. Check the account before you retry/);
    assert.equal(fetchImpl.calls.length, 3, "the create call is made once and never retried");
  }
  // A clear rejection is still a plain error.
  const rejected = mockFetch((call, i) => (i === 0 ? init : i === 1 ? response(201, "") : response(422, { message: "bad commentary" })));
  const [r] = await live({ files, pdf, targets: ["linkedin"] }, { config: null, env: FULL_ENV, fetchImpl: rejected, dataDir });
  assert.equal(r.status, "error");
  assert.match(r.detail, /LinkedIn rejected the post, so nothing is live/);
  const log = store.readPublishLog({ dataDir });
  assert.ok(log.some((e) => e.status === "unknown"));
});
