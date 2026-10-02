"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../lib/store.js");
const { tmpDir, writeSlides } = require("./publish-helpers.js");

const DECK = { title: "Five Ways to Plan a Week!", size: "portrait", slides: [{ layout: "01-editorial-statement", headline: "Plan less" }, { layout: "11-recap-list", title: "Recap", items: ["a", "b"] }] };

test("saveDraft writes drafts/<timestamp>-<slug>.json and loadDraft returns the deck", () => {
  const dataDir = tmpDir();
  const saved = store.saveDraft(DECK, { dataDir, now: new Date("2026-03-04T05:06:07Z") });
  assert.equal(saved.id, "20260304-050607-five-ways-to-plan-a-week");
  assert.equal(saved.path, path.join(dataDir, "drafts", `${saved.id}.json`));
  assert.ok(store.isValidId(saved.id));
  assert.deepEqual(store.loadDraft(saved.id, { dataDir }), DECK);
  for (const sub of ["drafts", "exports", "library", "logs"]) assert.ok(fs.statSync(path.join(dataDir, sub)).isDirectory());
});

test("two drafts in the same second get different ids, and an existing id is updated in place", () => {
  const dataDir = tmpDir();
  const now = new Date("2026-03-04T05:06:07Z");
  const a = store.saveDraft(DECK, { dataDir, now });
  const b = store.saveDraft(DECK, { dataDir, now });
  assert.notEqual(a.id, b.id);
  assert.equal(b.id, `${a.id}-2`);
  assert.ok(store.isValidId(b.id));

  const edited = { ...DECK, title: "Changed" };
  const again = store.saveDraft(edited, { dataDir, id: a.id, now: new Date("2026-03-05T00:00:00Z") });
  assert.equal(again.id, a.id);
  const record = store.getDraft(a.id, { dataDir });
  assert.equal(record.deck.title, "Changed");
  assert.equal(record.createdAt, now.toISOString());
  assert.equal(record.updatedAt, "2026-03-05T00:00:00.000Z");
  assert.equal(fs.readdirSync(path.join(dataDir, "drafts")).length, 2);
});

test("a title with no usable characters still gets a valid id", () => {
  const dataDir = tmpDir();
  const saved = store.saveDraft({ title: "../../../etc/passwd", slides: [] }, { dataDir, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(saved.id, "20260101-000000-etc-passwd");
  const blank = store.saveDraft({ slides: [] }, { dataDir, now: new Date("2026-01-01T00:00:01Z") });
  assert.equal(blank.id, "20260101-000001-untitled");
  assert.equal(store.slugify("  Crème brûlée & Co.  "), "creme-brulee-co");
});

test("ids that could leave the data dir are rejected everywhere", () => {
  const dataDir = tmpDir();
  const outside = path.join(path.dirname(dataDir), `escape-${path.basename(dataDir)}`);
  const bad = ["../x", "..", "", "a/b", "20260101-000000-../../x", "20260101-000000-a/../../b", "20260101-000000-a\0b", "/etc/passwd", "20260101-000000-", "20260101-000000-UPPER", null, undefined, 42, `20260101-000000-${"a".repeat(200)}`];
  for (const id of bad) {
    assert.equal(store.isValidId(id), false, `isValidId(${String(id).slice(0, 30)})`);
    assert.throws(() => store.loadDraft(id, { dataDir }), { code: "INVALID_ID" });
    assert.throws(() => store.getDraft(id, { dataDir }), { code: "INVALID_ID" });
    assert.throws(() => store.exportDir(id, { dataDir }), { code: "INVALID_ID" });
    assert.throws(() => store.recordExport(id, ["x.png"], { dataDir }), { code: "INVALID_ID" });
    if (id) assert.throws(() => store.saveDraft(DECK, { dataDir, id }), { code: "INVALID_ID" });
  }
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "drafts")), [], "no rejected id wrote a draft");
  assert.throws(() => store.appendLog("../publish", { a: 1 }, { dataDir }), { code: "INVALID_LOG_NAME" });
  assert.throws(() => store.readLog("a/b", { dataDir }), { code: "INVALID_LOG_NAME" });
});

test("loadDraft returns null for a well-formed id that does not exist", () => {
  const dataDir = tmpDir();
  assert.equal(store.loadDraft("20260101-000000-nothing-here", { dataDir }), null);
  assert.deepEqual(store.listDrafts({ dataDir }), []);
  assert.deepEqual(store.readPublishLog({ dataDir }), []);
});

test("listDrafts is newest first and skips stray files", () => {
  const dataDir = tmpDir();
  const a = store.saveDraft({ ...DECK, title: "Older" }, { dataDir, now: new Date("2026-01-01T00:00:00Z") });
  const b = store.saveDraft({ ...DECK, title: "Newer" }, { dataDir, now: new Date("2026-02-01T00:00:00Z") });
  fs.writeFileSync(path.join(dataDir, "drafts", "notes.txt"), "x");
  fs.writeFileSync(path.join(dataDir, "drafts", "bad name.json"), "{}");
  fs.writeFileSync(path.join(dataDir, "drafts", "20260301-000000-broken.json"), "{not json");
  const list = store.listDrafts({ dataDir });
  assert.deepEqual(list.map((d) => d.id), [b.id, a.id]);
  assert.equal(list[0].title, "Newer");
  assert.equal(list[0].slides, 2);
  assert.equal(list[0].exported, false);
});

test("recordExport copies outside files in, writes a manifest and marks the draft exported", () => {
  const dataDir = tmpDir();
  const saved = store.saveDraft(DECK, { dataDir, now: new Date("2026-03-04T05:06:07Z") });
  const elsewhere = tmpDir();
  const files = writeSlides(elsewhere, 3);
  const out = store.recordExport(saved.id, files, { dataDir, title: DECK.title, caption: "Hello", hashtags: ["#one"], now: new Date("2026-03-04T06:00:00Z") });
  assert.equal(out.dir, path.join(dataDir, "exports", saved.id));
  assert.deepEqual(out.files.map((f) => path.basename(f)), ["slide-01.png", "slide-02.png", "slide-03.png"]);
  for (const f of out.files) assert.ok(f.startsWith(out.dir + path.sep) && fs.existsSync(f));
  const manifest = JSON.parse(fs.readFileSync(out.manifestPath, "utf8"));
  assert.deepEqual(manifest.files, ["slide-01.png", "slide-02.png", "slide-03.png"]);
  assert.equal(manifest.caption, "Hello");
  assert.equal(manifest.exportedAt, "2026-03-04T06:00:00.000Z");

  const found = store.getExport(saved.id, { dataDir });
  assert.equal(found.files.length, 3);
  assert.equal(store.listDrafts({ dataDir })[0].exported, true);
  assert.equal(store.listExports({ dataDir }).length, 1);

  // Files already inside the export dir are recorded in place, not duplicated.
  const again = store.recordExport(saved.id, out.files, { dataDir });
  assert.deepEqual(again.files, out.files);
  assert.equal(fs.readdirSync(out.dir).filter((n) => n.endsWith(".png")).length, 3);
  assert.throws(() => store.recordExport(saved.id, [], { dataDir }), TypeError);
});

test("the publish log is append-only JSON lines", () => {
  const dataDir = tmpDir();
  const first = store.appendPublishLog({ target: "linkedin", status: "dry_run" }, { dataDir, now: new Date("2026-03-04T05:06:07Z") });
  assert.equal(first.at, "2026-03-04T05:06:07.000Z");
  const file = path.join(dataDir, "logs", "publish.jsonl");
  const before = fs.readFileSync(file, "utf8");
  store.appendPublishLog({ target: "instagram", status: "refused" }, { dataDir });
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.startsWith(before), "earlier lines are never rewritten");
  assert.equal(after.trim().split("\n").length, 2);

  // A torn line (crash mid-write) is skipped on read and left alone on disk.
  fs.appendFileSync(file, '{"target":"face');
  fs.appendFileSync(file, "\n");
  store.appendPublishLog({ target: "tiktok", status: "not_wired" }, { dataDir });
  const log = store.readPublishLog({ dataDir });
  assert.deepEqual(log.map((e) => e.target), ["linkedin", "instagram", "tiktok"]);
  assert.ok(fs.readFileSync(file, "utf8").includes('{"target":"face'));
});

test("loadConfig prefers the data dir and falls back to the shipped example", () => {
  const dataDir = tmpDir();
  const fallback = store.loadConfig("publishers", { dataDir });
  assert.equal(fallback.config.mediaHost.kind, "none");
  assert.ok(fallback.source.endsWith(path.join("config", "publishers.example.json")));
  fs.writeFileSync(path.join(dataDir, "publishers.json"), JSON.stringify({ mediaHost: { kind: "url-prefix", urlPrefix: "https://media.example.com/c" }, targets: {} }));
  const own = store.loadConfig("publishers", { dataDir });
  assert.equal(own.config.mediaHost.kind, "url-prefix");
  assert.equal(own.source, path.join(dataDir, "publishers.json"));
  fs.writeFileSync(path.join(dataDir, "publishers.json"), "{broken");
  const broken = store.loadConfig("publishers", { dataDir, fallback: { mediaHost: { kind: "none" } } });
  assert.match(broken.error, /Could not parse/);
  assert.equal(broken.config.mediaHost.kind, "none");
  assert.throws(() => store.loadConfig("../secrets", { dataDir }));
});

test("the data dir honours CAROUSEL_HOME and defaults to ./.carousel", () => {
  const saved = process.env.CAROUSEL_HOME;
  try {
    process.env.CAROUSEL_HOME = "/somewhere/else";
    assert.equal(store.resolveDataDir(), path.resolve("/somewhere/else"));
    delete process.env.CAROUSEL_HOME;
    assert.equal(store.resolveDataDir(), path.join(process.cwd(), ".carousel"));
    assert.equal(store.resolveDataDir({ dataDir: "/explicit" }), path.resolve("/explicit"));
  } finally {
    if (saved === undefined) delete process.env.CAROUSEL_HOME;
    else process.env.CAROUSEL_HOME = saved;
  }
});
