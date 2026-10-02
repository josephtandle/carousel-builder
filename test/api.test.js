"use strict";

// lib/api.js: the application API as plain functions. No HTTP and no network:
// every call that could reach a platform or a model gets a scripted fetch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createApi, MAX_UPLOAD } = require("../lib/api.js");
const { findChrome } = require("../lib/render.js");
const { LAYOUTS } = require("../lib/deck-schema.js");
const { tmpDir, makePng, writeExport, response, mockFetch } = require("./publish-helpers.js");

const ID = "20260102-093000-sell-out-by-nine";
const LI_ENV = { LINKEDIN_ACCESS_TOKEN: "li-token-abcdefgh", LINKEDIN_AUTHOR_URN: "urn:li:person:abc123" };
const LI_OK = (call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D9" } }) : response(201, "", { "x-restli-id": "urn:li:share:55" }));
const DECK = { title: "Sell out by nine", size: "square", slides: [{ layout: "01-editorial-statement", headline: "Bake to the *list*" }, { layout: "03-big-number-cover", number: "38%", unit: "ordered ahead" }] };
const PNG = makePng({ width: 8, height: 10, pixel: () => [40, 120, 200, 255] });

function setup(env = {}, handler, extra = {}) {
  const dataDir = tmpDir("carousel-api-");
  const fetchImpl = mockFetch(handler);
  const api = createApi({ dataDir, env, fetchImpl, ...extra });
  return { dataDir, fetchImpl, api };
}

function exported(dataDir, id = ID, options) {
  return writeExport(path.join(dataDir, "exports", id), 3, options);
}

test("unknown calls are 404 and a wrong method is 405 with the allowed ones", async () => {
  const { api } = setup();
  const missing = await api.handle("nope", "GET", {});
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
  const wrong = await api.handle("draft", "GET", {});
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.Allow, "POST");
  assert.equal((await api.handle("constructor", "GET", {})).status, 404, "inherited property names are not routes");
  assert.deepEqual(api.names.sort(), ["brand", "caption", "doctor", "draft", "drafts", "export", "images", "publish", "render", "schema", "serve", "templates"]);
});

test("draft works without a model key and never touches the network", async () => {
  const { api, fetchImpl } = setup();
  const drafted = await api.handle("draft", "POST", { body: { brief: "Three habits that keep a small bakery sold out", slides: 6, size: "square" } });
  assert.equal(drafted.status, 200);
  assert.equal(drafted.headers["Cache-Control"], "no-store");
  assert.equal(drafted.json.ok, true);
  assert.equal(drafted.json.engine, "fallback");
  assert.equal(drafted.json.model, null);
  assert.ok(Array.isArray(drafted.json.deck.slides) && drafted.json.deck.slides.length >= 5);
  for (const slide of drafted.json.deck.slides) assert.ok(Object.prototype.hasOwnProperty.call(LAYOUTS, slide.layout), `${slide.layout} is a known layout`);

  const empty = await api.handle("draft", "POST", { body: { brief: "   " } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /what the carousel is about/);
  assert.equal((await api.handle("draft", "POST", { body: ["not", "an", "object"] })).status, 400);
  assert.equal((await api.handle("draft", "POST", {})).status, 400);

  const caption = await api.handle("caption", "POST", { body: { deck: drafted.json.deck } });
  assert.equal(caption.status, 200);
  assert.equal(typeof caption.json.caption, "string");
  assert.ok(Array.isArray(caption.json.hashtags));
  assert.equal((await api.handle("caption", "POST", { body: { deck: "x" } })).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test("drafts save, list without file paths, and open by id", async () => {
  const { api } = setup();
  const saved = await api.handle("drafts", "POST", { body: { deck: DECK } });
  assert.equal(saved.status, 200);
  assert.match(saved.json.id, /^\d{8}-\d{6}-sell-out-by-nine$/);
  const again = await api.handle("drafts", "POST", { body: { deck: { ...DECK, title: "Renamed" }, id: saved.json.id } });
  assert.equal(again.json.id, saved.json.id);
  const list = await api.handle("drafts", "GET", { query: {} });
  assert.equal(list.json.drafts.length, 1);
  assert.equal(list.json.drafts[0].title, "Renamed");
  assert.ok(!("path" in list.json.drafts[0]), "file paths stay on the server");
  const opened = await api.handle("drafts", "GET", { query: { id: saved.json.id } });
  assert.equal(opened.json.deck.title, "Renamed");
  assert.equal((await api.handle("drafts", "GET", { query: { id: "../../etc/passwd" } })).status, 400);
  assert.equal((await api.handle("drafts", "GET", { query: { id: "20260102-093000-missing" } })).status, 404);
  assert.equal((await api.handle("drafts", "POST", { body: { deck: DECK, id: "../x" } })).status, 400);
});

test("render refuses a bad id and an invalid deck before any browser starts", async () => {
  const { api } = setup();
  assert.equal((await api.handle("render", "POST", { body: { deck: DECK, id: "../../x" } })).status, 400);
  assert.equal((await api.handle("render", "POST", { body: { deck: "nope" } })).status, 400);
  const invalid = await api.handle("render", "POST", { body: { deck: { slides: [{ layout: "99-nope" }] } } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.code, "invalid_deck");
  assert.match(invalid.json.issues[0], /unknown layout/);
});

const chrome = findChrome();
test("render draws real PNG slides, serve returns them, a brand change redraws them, export lists them and builds the PDF", { skip: chrome ? false : "no Chrome, Chromium or Edge found" }, async () => {
  const { api, dataDir, fetchImpl } = setup();
  const first = await api.handle("render", "POST", { body: { deck: DECK } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const { id, slides } = first.json;
  assert.match(id, /^\d{8}-\d{6}-sell-out-by-nine$/);
  assert.equal(slides.length, 2);
  assert.equal(first.json.qa.ok, true, JSON.stringify(first.json.qa));
  assert.match(slides[0].url, new RegExp(`^/api/serve\\?id=${id}&i=1&v=\\d+$`));

  const shot = await api.handle("serve", "GET", { query: { id, i: "1", v: "1" } });
  assert.equal(shot.status, 200);
  assert.equal(shot.headers["Content-Type"], "image/png");
  assert.equal(shot.headers["Cache-Control"], "private, max-age=3600");
  assert.equal(shot.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await api.handle("serve", "GET", { query: { id, i: "9" } })).status, 404);
  assert.equal((await api.handle("serve", "GET", { query: { id, i: "1", download: "1" } })).headers["Content-Disposition"], `attachment; filename="${id}-slide-01.png"`);

  // A brand change is picked up by the next render.
  const brand = await api.handle("brand", "PUT", { body: { colors: { bg: "#F4EFE6", text: "#101314" } } });
  assert.equal(brand.status, 200);
  const second = await api.handle("render", "POST", { body: { deck: DECK, id } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.id, id);
  const redrawn = await api.handle("serve", "GET", { query: { id, i: "1" } });
  assert.equal(redrawn.headers["Cache-Control"], "no-store");
  assert.notDeepEqual(redrawn.buffer, shot.buffer, "the slide changed with the brand");

  const listing = await api.handle("export", "GET", { query: { id } });
  assert.equal(listing.status, 200);
  assert.equal(listing.json.pngs.length, 2);
  assert.equal(listing.json.pdf, `/api/export?id=${id}&format=pdf`);
  const pdf = await api.handle("export", "GET", { query: { id, format: "pdf" } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers["Content-Type"], "application/pdf");
  assert.equal(pdf.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(fs.existsSync(path.join(dataDir, "exports", id, "carousel.pdf")));

  // A new render leaves no stale PDF beside the fresh slides.
  await api.handle("render", "POST", { body: { deck: { ...DECK, slides: DECK.slides.slice(0, 1) }, id } });
  assert.ok(!fs.existsSync(path.join(dataDir, "exports", id, "carousel.pdf")));
  assert.ok(!fs.existsSync(path.join(dataDir, "exports", id, "slide-02.png")));
  const history = await api.handle("export", "GET", { query: {} });
  assert.equal(history.json.exports[0].id, id);
  assert.equal(history.json.exports[0].slides, 1);
  assert.equal(fetchImpl.calls.length, 0);
});

test("serve validates ids and names and never leaves the data dir", async () => {
  const { api, dataDir } = setup();
  exported(dataDir);
  const ok = await api.handle("serve", "GET", { query: { id: ID, i: "2" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["X-Content-Type-Options"], "nosniff");

  for (const query of [{ id: "../../etc", i: "1" }, { id: `${ID}/../..`, i: "1" }, { id: ID, i: "0" }, { id: ID, i: "100" }, { id: ID, i: "1/../../brand" }, { id: ID }, {}]) {
    assert.equal((await api.handle("serve", "GET", { query })).status, 400, JSON.stringify(query));
  }
  for (const lib of ["../brand.json", "..%2fbrand.json", "a/b.png", ".hidden.png", "", "x\\y.png"]) {
    assert.equal((await api.handle("serve", "GET", { query: { lib } })).status, 400, lib);
  }
  assert.equal((await api.handle("serve", "GET", { query: { lib: "missing.png" } })).status, 404);
  fs.writeFileSync(path.join(dataDir, "library", "notes.txt"), "not an image");
  assert.equal((await api.handle("serve", "GET", { query: { lib: "notes.txt" } })).status, 415);
  fs.writeFileSync(path.join(dataDir, "library", "mine.png"), PNG);
  assert.equal((await api.handle("serve", "GET", { query: { lib: "mine.png" } })).status, 200);

  // A link that points out of the data dir is refused, whatever it is called.
  const outside = path.join(tmpDir("carousel-outside-"), "secret.png");
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(dataDir, "library", "link.png"));
  assert.equal((await api.handle("serve", "GET", { query: { lib: "link.png" } })).status, 403);

  // An export manifest that names a file outside its folder is not served either.
  const sneaky = "20260102-093000-sneaky";
  fs.mkdirSync(path.join(dataDir, "exports", sneaky), { recursive: true });
  fs.symlinkSync(outside, path.join(dataDir, "exports", sneaky, "slide-01.png"));
  fs.writeFileSync(path.join(dataDir, "exports", sneaky, "export.json"), JSON.stringify({ id: sneaky, files: ["slide-01.png"], qa: { ok: true, issues: [] } }));
  assert.equal((await api.handle("serve", "GET", { query: { id: sneaky, i: "1" } })).status, 403);
});

test("brand: GET merges the defaults, PUT validates every key and merges what it saves", async () => {
  const { api, dataDir } = setup();
  const empty = await api.handle("brand", "GET", {});
  assert.equal(empty.status, 200);
  assert.equal(empty.json.exists, false);
  assert.match(empty.json.brand.colors.accent, /^#[0-9A-F]{6}$/);

  const bad = await api.handle("brand", "PUT", { body: { colors: { accent: "teal", nope: "#000000" }, chrome: { showCounter: "yes" }, logo: "javascript:alert(1)", portrait: "http://example.com/a.png", name: "x".repeat(81), wat: 1, defaultHashtags: "tags" } });
  assert.equal(bad.status, 422);
  const errors = bad.json.errors.join("\n");
  for (const part of ["colors.accent", "colors.nope", "chrome.showCounter", "logo:", "portrait:", "name:", "wat:", "defaultHashtags:"]) assert.ok(errors.includes(part), part);
  assert.ok(!fs.existsSync(path.join(dataDir, "brand.json")), "nothing is written when validation fails");
  assert.equal((await api.handle("brand", "PUT", { body: null })).status, 400);

  const saved = await api.handle("brand", "PUT", { body: { name: " Riverbend Bakery ", colors: { accent: "#abc" }, chrome: { showCounter: true }, defaultHashtags: ["#bakery"] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.exists, true);
  assert.equal(saved.json.brand.name, "Riverbend Bakery");
  assert.equal(saved.json.brand.colors.accent, "#AABBCC");
  // Local files are not chosen from the browser: fonts and the voice profile are not part of
  // this call at all, and an image has to be https or inside the data dir.
  const outsideFile = path.join(tmpDir("carousel-outside-"), "notes.txt");
  fs.writeFileSync(outsideFile, "private notes");
  fs.symlinkSync(path.dirname(outsideFile), path.join(dataDir, "library", "away"));
  for (const body of [
    { voiceProfilePath: outsideFile },
    { voiceProfilePath: "library/voice.txt" },
    { fonts: { display: { family: "x", file: "file:///etc/passwd" } } },
    { logo: outsideFile },
    { logo: "/etc/hosts" },
    { portrait: "../../../../etc/hosts" },
    { logo: "library/../../outside.png" },
    { portrait: "library/away/notes.txt" },
    { logo: "file:///etc/hosts" },
    { logo: "data:image/png;base64,AAAA" },
  ]) {
    const refused = await api.handle("brand", "PUT", { body });
    assert.equal(refused.status, 422, JSON.stringify(body));
  }
  const kept = JSON.parse(fs.readFileSync(path.join(dataDir, "brand.json"), "utf8"));
  assert.ok(!("voiceProfilePath" in kept) && !("fonts" in kept) && !("logo" in kept) && !("portrait" in kept));
  fs.writeFileSync(path.join(dataDir, "library", "logo.png"), PNG);
  const images = await api.handle("brand", "PUT", { body: { logo: "library/logo.png", portrait: "https://example.com/face.png" } });
  assert.equal(images.status, 200, JSON.stringify(images.json));
  assert.equal(images.json.previews.logo, "/api/serve?lib=logo.png");
  assert.equal((await api.handle("brand", "PUT", { body: { logo: path.join(dataDir, "library", "logo.png"), portrait: null } })).status, 200);

  const next = await api.handle("brand", "PUT", { body: { colors: { bg: "#000000" } } });
  assert.equal(next.json.brand.colors.accent, "#AABBCC", "keys left out keep their saved value");
  assert.equal(next.json.brand.colors.bg, "#000000");
  assert.equal(next.json.brand.chrome.showCounter, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "brand.json"), "utf8"));
  assert.deepEqual(onDisk.defaultHashtags, ["#bakery"]);
});

test("images: an upload is checked by its first bytes and stored under a name made by the engine", async () => {
  const { api, dataDir, fetchImpl } = setup();
  const good = await api.handle("images", "POST", { files: [{ field: "file", filename: "../../Evil Name!.png", data: PNG }] });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.match(good.json.name, /^evil-name-[0-9a-f]{8}\.png$/);
  assert.equal(good.json.src, `library/${good.json.name}`);
  assert.equal(good.json.thumb, `/api/serve?lib=${good.json.name}`);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "library")), [good.json.name], "exactly one file, inside the library");
  assert.equal((await api.handle("serve", "GET", { query: { lib: good.json.name } })).status, 200);

  const jpeg = await api.handle("images", "POST", { files: [{ field: "file", filename: "photo.png", data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]) }] });
  assert.match(jpeg.json.name, /\.jpg$/, "the extension follows the bytes, not the given name");

  const script = await api.handle("images", "POST", { files: [{ field: "file", filename: "page.png", data: Buffer.from("<html><script>alert(1)</script></html>") }] });
  assert.equal(script.status, 415);
  const svg = await api.handle("images", "POST", { files: [{ field: "file", filename: "logo.svg", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }] });
  assert.equal(svg.status, 415);
  const huge = await api.handle("images", "POST", { files: [{ field: "file", filename: "big.png", data: Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD)]) }] });
  assert.equal(huge.status, 413);
  assert.equal((await api.handle("images", "POST", { files: [{ field: "other", filename: "a.png", data: PNG }] })).status, 400);

  // Search with no stock key: the library answers and the tried list says why the rest was skipped.
  const found = await api.handle("images", "POST", { body: { query: "" } });
  assert.equal(found.status, 200);
  assert.ok(found.json.results.length >= 1);
  assert.match(found.json.results[0].thumb, /^\/api\/serve\?lib=/);
  assert.ok(Array.isArray(found.json.tried));
  assert.equal((await api.handle("images", "POST", { body: { generate: true, prompt: "  " } })).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test("doctor and schema report without a network call and never print a key", async () => {
  const { api, fetchImpl, dataDir } = setup({ ...LI_ENV, PEXELS_API_KEY: "pexels-secret-value" });
  const doctor = await api.handle("doctor", "GET", {});
  assert.equal(doctor.status, 200);
  // The report is kept for a while: asking again does not run the checks again.
  const runs = () => fs.readFileSync(path.join(dataDir, "logs", "doctor.jsonl"), "utf8").trim().split("\n").length;
  assert.equal(runs(), 1);
  for (let i = 0; i < 5; i += 1) assert.equal((await api.handle("doctor", "GET", {})).status, 200);
  assert.equal(runs(), 1, "five more calls, still one doctor run");
  fs.writeFileSync(path.join(dataDir, "brand.json"), "{}");
  assert.equal((await api.handle("doctor", "GET", {})).json.brandExists, true, "what is cheap to read stays fresh");
  assert.equal(doctor.json.publishers.find((row) => row.id === "linkedin").wired, true);
  assert.equal(doctor.json.publishers.find((row) => row.id === "instagram").wired, false);
  assert.equal(doctor.json.brandExists, false);
  const text = JSON.stringify(doctor.json);
  assert.ok(!text.includes("li-token-abcdefgh") && !text.includes("pexels-secret-value"));
  const schema = await api.handle("schema", "GET", {});
  assert.deepEqual(Object.keys(schema.json.layouts), Object.keys(LAYOUTS));
  assert.ok(schema.json.sizes.portrait && schema.json.maxSlides >= schema.json.warnSlides);
  assert.equal(fetchImpl.calls.length, 0);
});

test("publish: a dry run comes first, sends nothing and returns the token", async () => {
  const { api, dataDir, fetchImpl } = setup(LI_ENV, LI_OK);
  exported(dataDir);
  assert.equal((await api.handle("publish", "POST", { body: { id: "../x", targets: ["linkedin"] } })).status, 400);
  assert.equal((await api.handle("publish", "POST", { body: { id: ID, targets: [] } })).status, 400);
  assert.equal((await api.handle("publish", "POST", { body: { id: ID, targets: ["linkedin"], caption: 7 } })).status, 400);
  assert.equal((await api.handle("publish", "POST", { body: { id: "20260102-093000-not-rendered", targets: ["linkedin"] } })).status, 400);

  const plan = await api.handle("publish", "POST", { body: { id: ID, targets: ["linkedin"], caption: "Hello" } });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.dryRun, true);
  assert.equal(plan.json.published, false);
  assert.match(plan.json.confirmToken, /^[0-9a-f]{16,}$/);
  assert.equal(plan.json.results[0].status, "dry_run");
  assert.ok(plan.json.results[0].steps.length > 0);
  assert.equal(fetchImpl.calls.length, 0, "a dry run never touches the network");
});

test("publish: a token that does not match is a 409 with a fresh summary, and nothing is sent", async () => {
  const { api, dataDir, fetchImpl } = setup(LI_ENV, LI_OK);
  exported(dataDir);
  const request = { id: ID, targets: ["linkedin"], caption: "Hello" };
  const plan = await api.handle("publish", "POST", { body: request });
  for (const confirmToken of ["0".repeat(64), "", undefined, 12]) {
    const refused = await api.handle("publish", "POST", { body: { ...request, confirm: "PUBLISH", confirmToken } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "confirm_token_mismatch");
    assert.equal(refused.json.published, false);
    assert.equal(refused.json.confirmToken, plan.json.confirmToken, "the fresh token is the one of this exact request");
    assert.equal(refused.json.results[0].status, "refused");
  }
  // The caption changed after the dry run: the old token no longer fits.
  const changed = await api.handle("publish", "POST", { body: { ...request, caption: "Hello again", confirm: "PUBLISH", confirmToken: plan.json.confirmToken } });
  assert.equal(changed.status, 409);
  assert.notEqual(changed.json.confirmToken, plan.json.confirmToken);
  // The wrong word is not a confirmation at all.
  const lower = await api.handle("publish", "POST", { body: { ...request, confirm: "publish", confirmToken: plan.json.confirmToken } });
  assert.equal(lower.json.published, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test("publish: dry_run wins over a valid confirmation", async () => {
  const { api, dataDir, fetchImpl } = setup(LI_ENV, LI_OK);
  exported(dataDir);
  const request = { id: ID, targets: ["linkedin"], caption: "Hello" };
  const plan = await api.handle("publish", "POST", { body: request });
  for (const extra of [{ dry_run: "yes" }, { dryRun: 1 }, { dryRun: "True" }, { dry_run: true }]) {
    const still = await api.handle("publish", "POST", { body: { ...request, confirm: "PUBLISH", confirmToken: plan.json.confirmToken, ...extra } });
    assert.equal(still.status, 200, JSON.stringify(extra));
    assert.equal(still.json.dryRun, true);
    assert.equal(still.json.published, false);
    assert.equal(still.json.results[0].status, "dry_run");
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("publish: a platform without credentials is not_wired, with zero fetch calls", async () => {
  const { api, dataDir, fetchImpl } = setup({}, LI_OK);
  exported(dataDir);
  const request = { id: ID, targets: ["linkedin", "facebook"], caption: "Hello" };
  const plan = await api.handle("publish", "POST", { body: request });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.results[0].wired, false);
  const sent = await api.handle("publish", "POST", { body: { ...request, confirm: "PUBLISH", confirmToken: plan.json.confirmToken } });
  assert.equal(sent.status, 409);
  assert.equal(sent.json.published, false);
  assert.deepEqual(sent.json.results.map((entry) => entry.status), ["not_wired", "not_wired"]);
  assert.equal(fetchImpl.calls.length, 0);
});

test("publish: the confirmed request publishes, and unknown is passed through as not confirmed", async () => {
  const live = setup(LI_ENV, LI_OK);
  exported(live.dataDir);
  const request = { id: ID, targets: ["linkedin"], caption: "Hello" };
  const plan = await live.api.handle("publish", "POST", { body: request });
  const sent = await live.api.handle("publish", "POST", { body: { ...request, confirm: "PUBLISH", confirmToken: plan.json.confirmToken } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.dryRun, false);
  assert.deepEqual(sent.json.published, ["linkedin"]);
  assert.equal(sent.json.results[0].status, "published");
  assert.ok(live.fetchImpl.calls.length >= 2);
  assert.ok(live.fetchImpl.calls.every((call) => /^https:\/\/(api|www)\.linkedin\.com\//.test(call.url)), "only the scripted platform host was called");
  const history = await live.api.handle("export", "GET", { query: {} });
  assert.equal(history.json.publishes[0].status, "published");
  assert.ok(!JSON.stringify(history.json).includes("li-token-abcdefgh"));

  // The create call gets a server error: the post may or may not be live.
  const unsure = setup(LI_ENV, (call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D9" } }) : i === 1 ? response(201, "") : response(500, "boom")));
  exported(unsure.dataDir);
  const second = await unsure.api.handle("publish", "POST", { body: request });
  const maybe = await unsure.api.handle("publish", "POST", { body: { ...request, confirm: "PUBLISH", confirmToken: second.json.confirmToken } });
  assert.equal(maybe.status, 200);
  assert.equal(maybe.json.results[0].status, "unknown");
  assert.deepEqual(maybe.json.published, []);
  assert.deepEqual(maybe.json.unconfirmed, ["linkedin"]);
});

test("publish: an export that failed the layout check is refused with 409", async () => {
  const { api, dataDir, fetchImpl } = setup(LI_ENV, LI_OK);
  exported(dataDir, ID, { qa: { ok: false, issues: ["slide 2: text overflows"] } });
  const refused = await api.handle("publish", "POST", { body: { id: ID, targets: ["linkedin"], caption: "Hello" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "layout_check_failed");
  assert.equal(fetchImpl.calls.length, 0);
});

test("templates: the list falls back to the schema when lib/templates.js is absent", async () => {
  const { api, fetchImpl } = setup({}, undefined, { templates: null });
  const listed = await api.handle("templates", "GET", { query: {} });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.source, "schema");
  assert.deepEqual(listed.json.templates.map((entry) => entry.id).sort(), Object.keys(LAYOUTS).sort());
  assert.deepEqual(listed.json.previews, { available: false, ready: 0, total: Object.keys(LAYOUTS).length });
  assert.deepEqual(listed.json.groups.map((group) => group.id), ["open", "point", "proof", "close"]);
  for (const entry of listed.json.templates) {
    assert.equal(entry.preview, null);
    assert.ok(entry.name && typeof entry.purpose === "string");
    assert.ok(["open", "point", "proof", "close"].includes(entry.group));
    assert.equal(typeof entry.supportsBackground, "boolean");
  }
  const build = await api.handle("templates", "POST", { body: {} });
  assert.equal(build.status, 501);
  assert.equal(build.json.code, "previews_unavailable");
  assert.equal(build.json.templates.length, listed.json.templates.length, "the plain list still comes back");
  const first = listed.json.templates[0].id;
  assert.equal((await api.handle("templates", "GET", { query: { id: first } })).status, 404);
  assert.equal((await api.handle("templates", "GET", { query: { id: "../../x" } })).status, 400);
  assert.equal((await api.handle("templates", "GET", { query: { size: "poster" } })).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test("templates: with a previews module the picker gets image URLs, served only from the data dir, one build at a time", async () => {
  const ids = Object.keys(LAYOUTS);
  let running = 0;
  let peak = 0;
  let calls = 0;
  const outside = path.join(tmpDir("carousel-outside-"), "leak.png");
  fs.writeFileSync(outside, PNG);
  const dirOf = (dataDir, size) => path.join(dataDir, "template-previews", `test-${size}`);
  const fake = {
    listTemplates: () => ids.map((id, index) => ({ id, name: `Template ${index + 1}`, purpose: "Use it when you test.", group: index === 0 ? "open" : "point", supportsBackground: index === 0, sampleSlide: { layout: id } })),
    // The last template points outside the data dir: it must never be served.
    previewPath: ({ dataDir, size, id }) => (id === ids[ids.length - 1] ? outside : path.join(dirOf(dataDir, size), `${id}.png`)),
    renderTemplatePreviews: async ({ dataDir, size }) => {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      fs.mkdirSync(dirOf(dataDir, size), { recursive: true });
      for (const id of ids) fs.writeFileSync(path.join(dirOf(dataDir, size), `${id}.png`), PNG);
      running -= 1;
      return ids.map((id) => ({ id, file: path.join(dirOf(dataDir, size), `${id}.png`) }));
    },
  };
  const { api } = setup({}, undefined, { templates: fake });
  const before = await api.handle("templates", "GET", { query: {} });
  assert.equal(before.json.source, "templates");
  assert.deepEqual(before.json.previews, { available: true, ready: 0, total: ids.length });
  assert.equal(before.json.templates[0].name, "Template 1");

  const [built, again] = await Promise.all([api.handle("templates", "POST", { body: { size: "square" } }), api.handle("templates", "POST", { body: { size: "square", force: true } })]);
  assert.equal(built.status, 200, JSON.stringify(built.json));
  assert.equal(again.status, 200);
  assert.equal(calls, 2);
  assert.equal(peak, 1, "two builds never run side by side");
  assert.equal(built.json.size, "square");
  assert.equal(built.json.previews.ready, ids.length - 1, "the file outside the data dir does not count");
  const shown = built.json.templates[0];
  assert.match(shown.preview, new RegExp(`^/api/templates\\?id=${ids[0]}&size=square&v=\\d+$`));
  assert.equal(built.json.templates[ids.length - 1].preview, null);

  const image = await api.handle("templates", "GET", { query: { id: ids[0], size: "square", v: "1" } });
  assert.equal(image.status, 200);
  assert.equal(image.headers["Content-Type"], "image/png");
  assert.deepEqual(image.buffer, PNG);
  assert.equal((await api.handle("templates", "GET", { query: { id: ids[ids.length - 1], size: "square" } })).status, 404);
  assert.equal((await api.handle("templates", "GET", { query: { id: ids[0], size: "portrait" } })).status, 404, "no preview for a size that was not built");
});

test("carousel templates lists every template by group, as text and as JSON", async () => {
  const { main } = require("../bin/carousel.js");
  const dataDir = tmpDir("carousel-api-cli-");
  let text = "";
  assert.equal(await main(["templates", "--data", dataDir], { stdout: (chunk) => { text += chunk; }, stderr: () => {} }), 0);
  for (const id of Object.keys(LAYOUTS)) assert.ok(text.includes(id), `${id} is listed`);
  let json = "";
  assert.equal(await main(["templates", "--json", "--size", "square", "--data", dataDir], { stdout: (chunk) => { json += chunk; }, stderr: () => {} }), 0);
  const listed = JSON.parse(json);
  assert.equal(listed.size, "square");
  assert.equal(listed.templates.length, Object.keys(LAYOUTS).length);
  assert.deepEqual(listed.groups.map((group) => group.id), ["open", "point", "proof", "close"]);
  let problem = "";
  assert.equal(await main(["templates", "--size", "poster", "--data", dataDir], { stdout: () => {}, stderr: (chunk) => { problem += chunk; } }), 1);
  assert.match(problem, /size must be one of/);
  const help = [];
  await main(["--help"], { stdout: (chunk) => help.push(chunk), stderr: () => {} });
  for (const word of ["carousel ui [--port n] [--no-open]", "carousel templates [--json] [--previews]"]) assert.ok(help.join("").includes(word), word);
});

test("the PDF and every slide of an export stay inside the data dir: links and planted manifests are refused", async () => {
  const { api, dataDir } = setup();
  const secretDir = tmpDir("carousel-outside-");
  const secret = path.join(secretDir, "secret.txt");
  fs.writeFileSync(secret, "top secret");
  const outsidePng = path.join(secretDir, "slide-01.png");
  fs.writeFileSync(outsidePng, PNG);

  // 1. carousel.pdf is a link to a file outside: it is removed and rebuilt, never read.
  exported(dataDir);
  const dir = path.join(dataDir, "exports", ID);
  fs.symlinkSync(secret, path.join(dir, "carousel.pdf"));
  const pdf = await api.handle("export", "GET", { query: { id: ID, format: "pdf" } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(!pdf.buffer.includes("top secret"));
  assert.equal(fs.readFileSync(secret, "utf8"), "top secret", "the file outside was not written through");
  assert.ok(fs.lstatSync(path.join(dir, "carousel.pdf")).isFile());
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".")), [], "no scratch file is left behind");

  // 2. A dangling link is not written through either.
  const target = path.join(secretDir, "created-by-link.pdf");
  fs.rmSync(path.join(dir, "carousel.pdf"));
  fs.symlinkSync(target, path.join(dir, "carousel.pdf"));
  assert.equal((await api.handle("export", "GET", { query: { id: ID, format: "pdf" } })).status, 200);
  assert.ok(!fs.existsSync(target));

  // 3. A manifest that names a file outside its folder (absolute, or through a link).
  const planted = "20260102-093000-planted";
  fs.mkdirSync(path.join(dataDir, "exports", planted), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "exports", planted, "export.json"), JSON.stringify({ id: planted, files: [outsidePng, outsidePng], qa: { ok: true, issues: [] } }));
  const linked = "20260102-093000-linked";
  fs.mkdirSync(path.join(dataDir, "exports", linked), { recursive: true });
  fs.symlinkSync(outsidePng, path.join(dataDir, "exports", linked, "slide-01.png"));
  fs.writeFileSync(path.join(dataDir, "exports", linked, "slide-02.png"), PNG);
  fs.writeFileSync(path.join(dataDir, "exports", linked, "export.json"), JSON.stringify({ id: linked, files: ["slide-01.png", "slide-02.png"], qa: { ok: true, issues: [] } }));
  // 4. An export folder that is itself a link out of the data dir.
  const away = "20260102-093000-away";
  const awayDir = path.join(secretDir, "away");
  writeExport(awayDir, 2);
  fs.symlinkSync(awayDir, path.join(dataDir, "exports", away));
  for (const id of [planted, linked, away]) {
    for (const format of ["pdf", "meta", undefined]) {
      const reply = await api.handle("export", "GET", { query: format ? { id, format } : { id } });
      assert.equal(reply.status, 403, `${id} ${format}`);
      assert.match(reply.json.error, /outside the carousel data folder/);
    }
  }
  assert.ok(!fs.existsSync(path.join(awayDir, "carousel.pdf")) && !fs.existsSync(path.join(awayDir, "meta-carousel.json")));
});

test("an unexpected failure inside the engine is reported to the host and never spelled out to the page", async () => {
  const seen = [];
  const { api, dataDir } = setup({}, undefined, { onError: (error, name) => seen.push([name, error.message]) });
  fs.writeFileSync(path.join(dataDir, "drafts"), "now a file, so saving breaks");
  const broken = await api.handle("drafts", "POST", { body: { deck: DECK } });
  assert.equal(broken.status, 500);
  assert.ok(!broken.json.error.includes(dataDir) && !/ENOTDIR|EEXIST|drafts/.test(broken.json.error), broken.json.error);
  assert.match(broken.json.error, /unexpected problem/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "drafts");
  assert.equal((await api.handle("caption", "POST", { body: { deck: { slides: [] } } })).status, 400);
});

test("post links are passed on only when they are https", async () => {
  const { api, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  const row = (url) => JSON.stringify({ at: "2026-01-02T09:30:00.000Z", target: "linkedin", status: "published", url, title: "T" });
  fs.writeFileSync(path.join(dataDir, "logs", "publish.jsonl"), `${[row("https://www.linkedin.com/feed/update/1"), row("javascript:alert(1)"), row("http://example.com/x"), row("https://ok.example/a b")].join("\n")}\n`);
  const history = await api.handle("export", "GET", { query: {} });
  assert.deepEqual(history.json.publishes.map((entry) => entry.url).reverse(), ["https://www.linkedin.com/feed/update/1", null, null, null]);
});

test("carousel draft with an unreadable --source says so instead of crashing", async () => {
  const { main } = require("../bin/carousel.js");
  const dataDir = tmpDir("carousel-api-cli-");
  let stderr = "";
  const code = await main(["draft", "A brief", "--source", path.join(dataDir, "no-such-file.txt"), "--data", dataDir], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
  assert.equal(code, 1);
  assert.match(stderr, /^Could not read --source: /);
});
