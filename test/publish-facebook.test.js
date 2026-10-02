"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { publish, listPublishers } = require("../lib/publish/index.js");
const live = (req, opts) => goLive(publish, req, opts);
const { tmpDir, writeSlides, writeExport, goLive, response, mockFetch } = require("./publish-helpers.js");

const ENV = { FACEBOOK_PAGE_ID: "5550001", FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token-abcdefgh" };
const ID = "20260304-050607-test-deck";

function fixture(slides = 3) {
  const dataDir = tmpDir();
  return { dataDir, files: writeExport(path.join(dataDir, "exports", ID), slides) };
}

function page() {
  let photo = 0;
  return mockFetch((call) => {
    if (call.method === "HEAD") return response(200, "");
    if (call.url.endsWith("/5550001/photos")) {
      photo += 1;
      return response(200, { id: `photo-${photo}` });
    }
    if (call.url.endsWith("/5550001/feed")) return response(200, { id: "5550001_777" });
    return response(404, { error: { message: "unexpected call" } });
  });
}

test("happy path: each photo is uploaded unpublished, then one feed post attaches them", async () => {
  const { dataDir, files } = fixture(3);
  const fetchImpl = page();
  const [result] = await live({ files, caption: "Three ideas for your week", targets: ["facebook"] }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(result.status, "published");
  assert.equal(result.url, "https://www.facebook.com/5550001_777");
  assert.equal(result.postId, "5550001_777");
  assert.match(result.detail, /3 photos/);

  const calls = fetchImpl.calls;
  assert.equal(calls.length, 4);
  for (let i = 0; i < 3; i += 1) {
    const call = calls[i];
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://graph.facebook.com/v24.0/5550001/photos");
    assert.equal(call.headers.Authorization, "Bearer fb-token-abcdefgh");
    assert.ok(call.body instanceof FormData);
    assert.equal(call.body.get("published"), "false");
    const source = call.body.get("source");
    assert.equal(source.name, `slide-0${i + 1}.png`);
    assert.equal(source.type, "image/png");
    assert.ok(Buffer.from(await source.arrayBuffer()).equals(fs.readFileSync(files[i])));
  }
  assert.equal(calls[3].url, "https://graph.facebook.com/v24.0/5550001/feed");
  assert.deepEqual(calls[3].json, {
    message: "Three ideas for your week",
    attached_media: [{ media_fbid: "photo-1" }, { media_fbid: "photo-2" }, { media_fbid: "photo-3" }],
  });
  for (const call of calls) assert.ok(!call.url.includes("fb-token"), "the token never goes in a URL");
});

test("with needsPublicUrls the photos are pulled from the media host after a reachability check", async () => {
  const { dataDir, files } = fixture(2);
  const fetchImpl = page();
  const config = { mediaHost: { kind: "url-prefix", urlPrefix: "https://media.example.com/c" }, targets: { facebook: { needsPublicUrls: true, graphVersion: "v26.0" } } };
  const [result] = await live({ files, caption: "Hi", targets: ["facebook"] }, { config, env: ENV, fetchImpl, dataDir });
  assert.equal(result.status, "published");
  assert.deepEqual(fetchImpl.calls.map((c) => c.method), ["HEAD", "HEAD", "POST", "POST", "POST"]);
  assert.equal(fetchImpl.calls[2].url, "https://graph.facebook.com/v26.0/5550001/photos");
  assert.deepEqual(fetchImpl.calls[2].json, { url: `https://media.example.com/c/${ID}/slide-01.png`, published: false });

  const noHost = listPublishers({ config: { targets: { facebook: { needsPublicUrls: true } } }, env: ENV }).find((p) => p.id === "facebook");
  assert.equal(noHost.wired, false);
  assert.match(noHost.reason, /needsPublicUrls.*No media host is configured/);
});

test("a failed photo upload stops before the feed post", async () => {
  const { dataDir, files } = fixture(3);
  let n = 0;
  const fetchImpl = mockFetch(() => {
    n += 1;
    return n === 2 ? response(403, { error: { message: "(#200) The user must be an administrator of the page", code: 200 } }) : response(200, { id: `photo-${n}` });
  });
  const [result] = await live({ files, targets: ["facebook"] }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(result.status, "error");
  assert.match(result.detail, /Facebook photo 2 of 3 failed \(HTTP 403\).*administrator.*No post was created; the photos already uploaded stay unpublished/);
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(!fetchImpl.calls.some((c) => c.url.endsWith("/feed")));

  const feedFails = mockFetch((call) => (call.url.endsWith("/feed") ? response(500, "oops") : response(200, { id: "p" })));
  const [second] = await live({ files, targets: ["facebook"] }, { config: null, env: ENV, fetchImpl: feedFails, dataDir });
  assert.equal(second.status, "unknown");
  assert.match(second.detail, /Facebook post failed \(HTTP 500\).*may or may not be live\. Check the account before you retry/);
  assert.equal(feedFails.calls.filter((c) => c.url.endsWith("/feed")).length, 1, "never retried");

  const feedRejected = mockFetch((call) => (call.url.endsWith("/feed") ? response(400, { error: { message: "Invalid parameter" } }) : response(200, { id: "p" })));
  const [third] = await live({ files, targets: ["facebook"] }, { config: null, env: ENV, fetchImpl: feedRejected, dataDir });
  assert.equal(third.status, "error");
  assert.match(third.detail, /Facebook rejected the post, so nothing is live/);
});

test("gate, wiring and limits", async () => {
  const { dataDir, files } = fixture(3);
  const fetchImpl = mockFetch();
  const [refused] = await publish({ files, targets: ["facebook"] }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(refused.status, "refused");
  const [notWired] = await live({ files, targets: ["facebook"] }, { config: null, env: { FACEBOOK_PAGE_ID: "5550001" }, fetchImpl, dataDir });
  assert.equal(notWired.status, "not_wired");
  assert.match(notWired.detail, /Facebook needs FACEBOOK_PAGE_ACCESS_TOKEN/);
  const [tooMany] = await live({ files, targets: ["facebook"] }, { config: { targets: { facebook: { maxSlides: 2 } } }, env: ENV, fetchImpl, dataDir });
  assert.equal(tooMany.status, "error");
  assert.match(tooMany.detail, /3 slides.*limit here is 2/);
  const [missingFile] = await live({ files: [...files, path.join(dataDir, "gone.png")], targets: ["facebook"] }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(missingFile.status, "error");
  assert.match(missingFile.detail, /Slide not found: gone\.png/);
  const [dry] = await publish({ files, caption: "abc", targets: ["facebook"], dryRun: true }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(dry.status, "dry_run");
  assert.match(dry.detail, /Would publish a 3 photo post to Facebook Page 5550001 with a 3 character message/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("apiBase must be the real Graph host and graphVersion a version", async () => {
  const { dataDir, files } = fixture(2);
  for (const override of [{ apiBase: "https://evil.example" }, { apiBase: "https://graph.instagram.com" }, { apiBase: "http://graph.facebook.com" }, { graphVersion: "v1.0/../x" }]) {
    const config = { targets: { facebook: override } };
    const listed = listPublishers({ config, env: ENV }).find((p) => p.id === "facebook");
    assert.equal(listed.wired, false, JSON.stringify(override));
    assert.match(listed.reason, /apiBase must be https:\/\/graph\.facebook\.com\. The access token is never sent to any other host|graphVersion must look like v24\.0/);
    const fetchImpl = mockFetch(() => response(200, { id: "x" }));
    const [r] = await live({ files, targets: ["facebook"] }, { config, env: ENV, fetchImpl, dataDir });
    assert.equal(r.status, "not_wired");
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test("photo uploads carry the token in a header and never follow a redirect", async () => {
  const { dataDir, files } = fixture(2);
  const fetchImpl = page();
  await live({ files, targets: ["facebook"] }, { config: null, env: ENV, fetchImpl, dataDir });
  assert.equal(fetchImpl.calls.length, 3);
  for (const call of fetchImpl.calls) assert.equal(call.redirect, "error");
});
