"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { publish, listPublishers } = require("../lib/publish/index.js");
const live = (req, opts) => goLive(publish, req, opts);
const tiktok = require("../lib/publish/tiktok.js");
const { tmpDir, writeSlides, writeExport, goLive, response, mockFetch, noSleep } = require("./publish-helpers.js");

const ENV = { TIKTOK_ACCESS_TOKEN: "tt-token-abcdefgh" };
const HOST = { kind: "url-prefix", urlPrefix: "https://media.example.com/c" };
const ID = "20260304-050607-test-deck";
const LABEL = "requires an audited TikTok app; unaudited apps can only post privately";
const OK = { code: "ok", message: "", log_id: "1" };

function fixture(slides = 3) {
  const dataDir = tmpDir();
  return { dataDir, files: writeExport(path.join(dataDir, "exports", ID), slides) };
}

function api({ options = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], statuses = ["PUBLISH_COMPLETE"], init } = {}) {
  let poll = 0;
  return mockFetch((call) => {
    if (call.method === "HEAD") return response(200, "");
    if (call.url.endsWith("/v2/post/publish/creator_info/query/")) return response(200, { data: { creator_username: "studio", privacy_level_options: options }, error: OK });
    if (call.url.endsWith("/v2/post/publish/content/init/")) return init ? init(call) : response(200, { data: { publish_id: "p_pub_url~v2.123" }, error: OK });
    if (call.url.endsWith("/v2/post/publish/status/fetch/")) {
      const status = statuses[Math.min(poll, statuses.length - 1)];
      poll += 1;
      return response(200, { data: { status, publicaly_available_post_id: status === "PUBLISH_COMPLETE" ? [7301] : [] }, error: OK });
    }
    return response(404, { error: { code: "not_found", message: "unexpected call" } });
  });
}

test("happy path: verify URLs, creator check, photo init from public URLs, status until complete", async () => {
  const { dataDir, files } = fixture(3);
  const fetchImpl = api({ statuses: ["PROCESSING_DOWNLOAD", "PUBLISH_COMPLETE"] });
  const caption = `Three ideas for a calmer week\nMore detail on the second line. ${"x".repeat(120)}`;
  const [result] = await live({ files, caption, targets: ["tiktok"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep });
  assert.equal(result.status, "published");
  assert.equal(result.url, "https://www.tiktok.com/@studio/photo/7301");
  assert.match(result.detail, /privacy SELF_ONLY/);

  const calls = fetchImpl.calls;
  assert.deepEqual(calls.map((c) => c.method), ["HEAD", "HEAD", "HEAD", "POST", "POST", "POST", "POST"]);
  assert.equal(calls[3].url, "https://open.tiktokapis.com/v2/post/publish/creator_info/query/");
  const init = calls[4];
  assert.equal(init.url, "https://open.tiktokapis.com/v2/post/publish/content/init/");
  assert.equal(init.headers.Authorization, "Bearer tt-token-abcdefgh");
  assert.equal(init.headers["Content-Type"], "application/json; charset=UTF-8");
  assert.deepEqual(init.json, {
    post_info: { title: "Three ideas for a calmer week", description: caption, privacy_level: "SELF_ONLY", disable_comment: false, auto_add_music: true },
    source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [1, 2, 3].map((n) => `https://media.example.com/c/${ID}/jpeg/slide-0${n}.jpg`) },
    post_mode: "DIRECT_POST",
    media_type: "PHOTO",
  });
  assert.deepEqual(calls[5].json, { publish_id: "p_pub_url~v2.123" });
  assert.equal(calls[6].url, "https://open.tiktokapis.com/v2/post/publish/status/fetch/");
});

test("titles are capped at 90 characters and the privacy level and mode are configurable", async () => {
  const { dataDir, files } = fixture(2);
  const fetchImpl = api();
  const config = { mediaHost: HOST, targets: { tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", autoAddMusic: false, verifyUrls: false } } };
  await live({ files, caption: "c", title: "T".repeat(140), targets: ["tiktok"] }, { config, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep });
  const body = fetchImpl.calls[1].json;
  assert.equal(body.post_info.title.length, 90);
  assert.equal(body.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(body.post_info.auto_add_music, false);

  const inbox = api({ statuses: ["SEND_TO_USER_INBOX"] });
  const [draft] = await live({ files, caption: "c", targets: ["tiktok"] }, { config: { mediaHost: HOST, targets: { tiktok: { postMode: "MEDIA_UPLOAD", verifyUrls: false } } }, env: ENV, fetchImpl: inbox, dataDir, sleepImpl: noSleep });
  assert.equal(draft.status, "published");
  assert.match(draft.detail, /draft delivered to the account inbox/);
  assert.equal(inbox.calls[1].json.post_mode, "MEDIA_UPLOAD");
  assert.equal("privacy_level" in inbox.calls[1].json.post_info, false);
});

test("a privacy level the account does not allow stops before anything is posted", async () => {
  const { dataDir, files } = fixture(2);
  const fetchImpl = api({ options: ["SELF_ONLY"] });
  const config = { mediaHost: HOST, targets: { tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE" } } };
  const [result] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep });
  assert.equal(result.status, "error");
  assert.match(result.detail, /does not allow privacy level PUBLIC_TO_EVERYONE.*Allowed: SELF_ONLY.*Nothing was posted/);
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("/content/init/")));
});

test("API errors, failed and slow posts are reported honestly", async () => {
  const { dataDir, files } = fixture(2);
  const config = { mediaHost: HOST, targets: { tiktok: { verifyUrls: false } } };

  const rejected = api({ init: () => response(200, { data: {}, error: { code: "url_ownership_unverified", message: "Please verify the URL prefix", log_id: "9" } }) });
  const [r1] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: rejected, dataDir, sleepImpl: noSleep });
  assert.equal(r1.status, "error");
  assert.match(r1.detail, /TikTok post failed.*url_ownership_unverified.*Nothing was posted/);

  const expired = mockFetch(() => response(401, { error: { code: "access_token_invalid", message: "expired tt-token-abcdefgh" } }));
  const [r2] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: expired, dataDir, sleepImpl: noSleep });
  assert.equal(r2.status, "error");
  assert.match(r2.detail, /TikTok creator check failed \(HTTP 401\)/);
  assert.ok(!r2.detail.includes("tt-token-abcdefgh"));
  assert.equal(expired.calls.length, 1);

  const failed = api({ statuses: ["FAILED"] });
  const [r3] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: failed, dataDir, sleepImpl: noSleep });
  assert.equal(r3.status, "error");
  assert.match(r3.detail, /could not publish the photos/);

  const slow = api({ statuses: ["PROCESSING_DOWNLOAD"] });
  const [r4] = await live({ files, targets: ["tiktok"] }, { config: { mediaHost: HOST, targets: { tiktok: { verifyUrls: false, statusChecks: 2 } } }, env: ENV, fetchImpl: slow, dataDir, sleepImpl: noSleep });
  assert.equal(r4.status, "processing", "never reported as published without a final state");
  assert.equal(r4.url, null);
  assert.match(r4.detail, /had not finished it after 2 status checks \(last state PROCESSING_DOWNLOAD\).*check the TikTok app before you retry/);
  assert.equal(slow.calls.filter((c) => c.url.includes("/status/fetch/")).length, 2);

  const unreachable = mockFetch((call) => (call.method === "HEAD" ? response(403, "") : response(200, {})));
  const [r5] = await live({ files, targets: ["tiktok"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl: unreachable, dataDir });
  assert.equal(r5.status, "error");
  assert.match(r5.detail, /2 public URL\(s\) did not answer/);
});

test("every not_wired reason carries the audited-app label", async () => {
  const { dataDir, files } = fixture(2);
  assert.equal(tiktok.AUDIT_NOTE, LABEL);
  const fetchImpl = mockFetch();
  const [noToken] = await live({ files, targets: ["tiktok"] }, { config: { mediaHost: HOST }, env: {}, fetchImpl, dataDir });
  assert.equal(noToken.status, "not_wired");
  assert.match(noToken.detail, /TikTok needs TIKTOK_ACCESS_TOKEN/);
  assert.ok(noToken.detail.includes(LABEL));
  const [noHost] = await live({ files, targets: ["tiktok"] }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(noHost.status, "not_wired");
  assert.match(noHost.detail, /public URLs on a domain verified for your app/);
  assert.ok(noHost.detail.includes(LABEL));
  const listed = listPublishers({ config: { mediaHost: HOST }, env: ENV }).find((p) => p.id === "tiktok");
  assert.equal(listed.wired, true);
  assert.ok(listed.reason.includes(LABEL));
  const [refused] = await publish({ files, targets: ["tiktok"] }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir });
  assert.equal(refused.status, "refused");
  const [dry] = await publish({ files, targets: ["tiktok"], dryRun: true }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir });
  assert.equal(dry.status, "dry_run");
  assert.ok(dry.detail.includes(LABEL));
  assert.equal(fetchImpl.calls.length, 0);
});

test("no answer on the create call is unknown, and polls that never finish are processing", async () => {
  const { dataDir, files } = fixture(2);
  const config = { mediaHost: HOST, targets: { tiktok: { verifyUrls: false, statusChecks: 3 } } };

  const timedOut = api({
    init: async () => {
      throw new Error("timed out after 60000 ms");
    },
  });
  const [r1] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: timedOut, dataDir, sleepImpl: noSleep });
  assert.equal(r1.status, "unknown");
  assert.match(r1.detail, /TikTok post failed: timed out.*TikTok did not confirm the post, so it may or may not be live\. Check the account before you retry/);
  assert.equal(timedOut.calls.filter((c) => c.url.includes("/content/init/")).length, 1, "never retried");
  assert.equal(timedOut.calls.filter((c) => c.url.includes("/status/fetch/")).length, 0);

  const serverError = api({ init: () => response(500, "internal") });
  const [r2] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: serverError, dataDir, sleepImpl: noSleep });
  assert.equal(r2.status, "unknown");

  // Every status poll fails: the post was accepted, but nothing says it is live.
  let polls = 0;
  const blind = mockFetch((call) => {
    if (call.url.endsWith("/creator_info/query/")) return response(200, { data: { creator_username: "studio", privacy_level_options: ["SELF_ONLY"] }, error: OK });
    if (call.url.endsWith("/content/init/")) return response(200, { data: { publish_id: "p1" }, error: OK });
    polls += 1;
    return response(503, "unavailable");
  });
  const [r3] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: blind, dataDir, sleepImpl: noSleep });
  assert.equal(r3.status, "processing");
  assert.match(r3.detail, /had not finished it after 3 status checks \(no status came back\)/);
  assert.equal(r3.url, null);
  assert.equal(polls, 3);

  // A failure that shows up on a later poll is reported as a failure.
  const lateFail = api({ statuses: ["PROCESSING_DOWNLOAD", "FAILED"] });
  const [r4] = await live({ files, targets: ["tiktok"] }, { config, env: ENV, fetchImpl: lateFail, dataDir, sleepImpl: noSleep });
  assert.equal(r4.status, "error");
});

test("a just-built JPEG stops a TikTok post until the host is synced", async () => {
  const { dataDir, files } = fixture(2);
  const { confirmTokenFor } = require("../lib/publish/index.js");
  const req = { files, caption: "c", targets: ["tiktok"] };
  const fetchImpl = api();
  const [r] = await publish({ ...req, confirm: "PUBLISH", confirmToken: confirmTokenFor(req, { dataDir }) }, { config: { mediaHost: HOST }, env: ENV, fetchImpl, dataDir, sleepImpl: noSleep });
  assert.equal(r.status, "error");
  assert.match(r.detail, /only just built or rebuilt.*Sync the exports dir, then retry\. Nothing was sent/);
  assert.equal(fetchImpl.calls.length, 0);
});
