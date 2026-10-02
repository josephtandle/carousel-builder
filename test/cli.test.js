"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const store = require("../lib/store.js");
const { tmpDir, writeSlides, writeExport, response, mockFetch } = require("./publish-helpers.js");

const ROOT = path.resolve(__dirname, "..");
const RECIPES = ["status", "create-carousel", "render-deck", "find-backgrounds", "publish-carousel", "list-carousels"];

// A clean environment: no model keys, no publisher tokens, nothing inherited.
function cleanEnv(dataDir, extra = {}) {
  return { PATH: process.env.PATH || "", HOME: dataDir, CAROUSEL_HOME: dataDir, CI: "1", ...extra };
}

function run(root, args, dataDir, extra) {
  return spawnSync(process.execPath, [path.join(root, "bin", "carousel.js"), ...args], { cwd: dataDir, env: cleanEnv(dataDir, extra), encoding: "utf8", timeout: 60000 });
}

// A copy of the engine with only the store, pdf, publish, CLI and recipe
// parts: render, brand, schema, copy, images and seat are genuinely absent.
function strippedEngine() {
  const root = tmpDir("carousel-stripped-");
  for (const dir of ["bin", "recipes", path.join("lib", "publish")]) fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  for (const file of [path.join("lib", "store.js"), path.join("lib", "pdf.js"), "package.json", path.join("config", "publishers.example.json")]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

test("doctor --json exits 0 and marks missing modules when the rest of the engine is absent", () => {
  const root = strippedEngine();
  const dataDir = tmpDir();
  const first = run(root, ["doctor", "--json"], dataDir);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  for (const key of ["chrome", "llm", "images", "publishers", "codexSeat"]) assert.ok(key in report, `report has ${key}`);
  assert.equal(report.ok, false);
  assert.equal(report.chrome.ok, false);
  assert.match(report.chrome.detail, /lib\/render\.js is not installed/);
  assert.equal(report.llm.ok, false);
  assert.equal(report.codexSeat.available, false);
  assert.match(report.codexSeat.reason, /lib\/seat\.js is not installed/);
  assert.ok(Array.isArray(report.images) && report.images.length >= 1);
  assert.equal(report.images.find((row) => row.id === "pexels").configured, false);
  assert.deepEqual(report.publishers.map((p) => [p.id, p.wired]), [["instagram", false], ["linkedin", false], ["facebook", false], ["tiktok", false]]);
  assert.equal(report.modules.render, "missing");
  assert.equal(report.modules.images, "missing");
  assert.ok(report.mismatches.includes("module:render:missing"));

  // Expected vs actual is logged, and a repeat failure is counted.
  const second = run(root, ["doctor", "--json"], dataDir);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).repeats["module:render:missing"], 1);
  const lines = fs.readFileSync(path.join(dataDir, "logs", "doctor.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].expected, { modules: "all ok", chrome: true });
  assert.equal(lines[0].actual.chrome, false);
  assert.equal(lines[0].actual.modules.render, "missing");
  assert.equal(lines[1].repeats["module:render:missing"], 1);

  const text = run(root, ["doctor"], dataDir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\[miss\] chrome/);
  assert.match(text.stdout, /still failing after earlier runs: .*module:render:missing \(3 runs in a row\)/);
});

test("the stripped engine degrades with clear messages and never crashes", () => {
  const root = strippedEngine();
  const dataDir = tmpDir();
  const draft = run(root, ["draft", "A brief about planning"], dataDir);
  assert.equal(draft.status, 1);
  assert.match(draft.stdout, /Drafting is not available: lib\/copy\.js is not installed/);
  const images = run(root, ["images", "mountains"], dataDir);
  assert.equal(images.status, 1);
  assert.match(images.stdout, /Background search is not available: lib\/images\/index\.js is not installed/);
  const deck = path.join(dataDir, "deck.json");
  fs.writeFileSync(deck, JSON.stringify({ title: "T", slides: [{ layout: "01-editorial-statement", headline: "Hi" }] }));
  const render = run(root, ["render", deck], dataDir);
  assert.equal(render.status, 1);
  assert.match(render.stdout, /Rendering is not available: lib\/render\.js is not installed/);
  assert.equal(run(root, ["status"], dataDir).status, 0);
  assert.equal(run(root, ["list"], dataDir).status, 0);
});

test("doctor --json exits 0 in the real tree with a clean environment", () => {
  const dataDir = tmpDir();
  const out = run(ROOT, ["doctor", "--json"], dataDir);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  for (const key of ["chrome", "llm", "images", "publishers", "codexSeat"]) assert.ok(key in report);
  assert.equal(report.publishers.length, 4);
  assert.equal(report.llm.ok, false, "no key in a clean environment");
});

test("help, unknown commands and usage errors", () => {
  const dataDir = tmpDir();
  const help = run(ROOT, ["--help"], dataDir);
  assert.equal(help.status, 0);
  for (const word of ["render", "draft", "images", "publish", "doctor", "--confirm PUBLISH"]) assert.ok(help.stdout.includes(word), word);
  assert.equal(run(ROOT, [], dataDir).status, 0);
  const unknown = run(ROOT, ["launch"], dataDir);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command: launch/);
  assert.equal(run(ROOT, ["publish"], dataDir).status, 1);
  assert.equal(run(ROOT, ["render"], dataDir).status, 1);
});

// Runs the CLI in this process with a scripted global fetch, so a publish
// command can never reach the network, even if a gate were to regress.
async function runMain(args, dataDir, env = {}, handler) {
  const { main } = require("../bin/carousel.js");
  const fetchImpl = mockFetch(handler);
  const saved = { fetch: globalThis.fetch, env: {} };
  const vars = { CAROUSEL_HOME: dataDir, ...env };
  for (const name of Object.keys(vars)) {
    saved.env[name] = process.env[name];
    process.env[name] = vars[name];
  }
  let stdout = "";
  let stderr = "";
  globalThis.fetch = fetchImpl;
  try {
    const code = await main(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    return { code, stdout, stderr, calls: fetchImpl.calls };
  } finally {
    globalThis.fetch = saved.fetch;
    for (const name of Object.keys(vars)) {
      if (saved.env[name] === undefined) delete process.env[name];
      else process.env[name] = saved.env[name];
    }
  }
}

const LI_ENV = { LINKEDIN_ACCESS_TOKEN: "li-token-abcdefgh", LINKEDIN_AUTHOR_URN: "urn:li:person:abc123" };
const LI_OK = (call, i) => (i === 0 ? response(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", document: "urn:li:document:D9" } }) : response(201, "", { "x-restli-id": "urn:li:share:55" }));
const EXPORT_ID = "20260304-050607-test-deck";

test("carousel publish: dry run by default, then --confirm PUBLISH with the token from the dry run", async () => {
  const dataDir = tmpDir();
  const dir = path.join(dataDir, "exports", EXPORT_ID);
  writeExport(dir, 3);

  const dry = await runMain(["publish", dir, "--to", "linkedin,facebook", "--caption", "Hello there"], dataDir, LI_ENV);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^Dry run, nothing was sent\./);
  assert.match(dry.stdout, /linkedin: Would post carousel\.pdf \(3 pages\) to LinkedIn/);
  assert.match(dry.stdout, /facebook: Would publish a 3 photo post.*Not wired yet/);
  assert.match(dry.stdout, /    PUT carousel\.pdf to the upload URL LinkedIn returns/);
  assert.ok(fs.existsSync(path.join(dir, "carousel.pdf")), "the PDF LinkedIn needs was built from the slides");
  assert.ok(!dry.stdout.includes("li-token-abcdefgh"));
  assert.equal(dry.calls.length, 0);

  const byId = await runMain(["publish", EXPORT_ID, "--to", "linkedin", "--caption", "Hello there", "--json"], dataDir, LI_ENV);
  assert.equal(byId.code, 0, byId.stderr);
  const plan = JSON.parse(byId.stdout);
  assert.equal(plan.metadata.results[0].status, "dry_run");
  const token = plan.metadata.confirmToken;
  assert.match(token, /^[0-9a-f]{24}$/);
  assert.match(plan.reply, new RegExp(`To publish exactly this, call again with confirm: PUBLISH and confirmToken: ${token}`));

  // A wrong confirm word, PUBLISH with no token, and PUBLISH with a token for other targets.
  const wrong = await runMain(["publish", dir, "--to", "linkedin", "--caption", "Hello there", "--confirm", "yes", "--confirm-token", token], dataDir, LI_ENV, LI_OK);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stdout, /Publishing is irreversible\. Confirm this exact request with confirm: PUBLISH\. Nothing was sent\./);
  const noToken = await runMain(["publish", dir, "--to", "linkedin", "--caption", "Hello there", "--confirm", "PUBLISH"], dataDir, LI_ENV, LI_OK);
  assert.equal(noToken.code, 2);
  assert.match(noToken.stdout, /^Nothing was sent: the confirmToken is missing or does not match this exact request\./);
  const widened = await runMain(["publish", dir, "--to", "linkedin,facebook", "--caption", "Hello there", "--confirm", "PUBLISH", "--confirm-token", token], dataDir, LI_ENV, LI_OK);
  assert.equal(widened.code, 2, "a token approved for linkedin does not cover linkedin plus facebook");
  const otherCaption = await runMain(["publish", dir, "--to", "linkedin", "--caption", "Something else", "--confirm", "PUBLISH", "--confirm-token", token], dataDir, LI_ENV, LI_OK);
  assert.equal(otherCaption.code, 2);
  for (const attempt of [wrong, noToken, widened, otherCaption]) assert.equal(attempt.calls.length, 0);

  // --dry-run in every spelling wins over a valid confirmation.
  for (const flag of ["--dry-run", "--dry-run=true", "--dry-run=1", "--dry-run=yes", "--dry-run=", "--dry-run=TRUE"]) {
    const out = await runMain(["publish", dir, "--to", "linkedin", "--caption", "Hello there", "--confirm", "PUBLISH", "--confirm-token", token, flag], dataDir, LI_ENV, LI_OK);
    assert.equal(out.code, 0, flag);
    assert.match(out.stdout, /^Dry run, nothing was sent\./, flag);
    assert.equal(out.calls.length, 0, `${flag} sent nothing`);
  }

  // The real thing: confirm plus the matching token (and --dry-run=false is not a dry run).
  const live = await runMain(["publish", dir, "--to", "linkedin", "--caption", "Hello there", "--confirm", "PUBLISH", "--token", token, "--dry-run=false"], dataDir, LI_ENV, LI_OK);
  assert.equal(live.code, 0, live.stdout + live.stderr);
  assert.match(live.stdout, /^1 of 1 published\.\nlinkedin: published https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:55\//);
  assert.equal(live.calls.length, 3);
  assert.equal(live.calls[2].json.commentary, "Hello there");

  const log = store.readPublishLog({ dataDir });
  assert.equal(log.filter((e) => e.status === "published").length, 1);
  assert.ok(!JSON.stringify(log).includes("li-token-abcdefgh"));
});

test("a caption that starts with dashes is a caption, not a flag", async () => {
  const { parseArgs } = require("../bin/carousel.js");
  assert.deepEqual(parseArgs(["publish", "x", "--to", "linkedin", "--caption", "--launch day--", "--title=--T", "--dry-run=false", "--json=1"]).flags, { to: "linkedin", caption: "--launch day--", title: "--T", "dry-run": false, json: true });
  assert.deepEqual(parseArgs(["publish", "x", "--caption=--also fine", "--confirm"]).flags, { caption: "--also fine", confirm: "" });

  const dataDir = tmpDir();
  const dir = path.join(dataDir, "exports", EXPORT_ID);
  writeExport(dir, 2, { manifest: { caption: "The manifest caption" } });
  const out = await runMain(["publish", dir, "--to", "linkedin", "--caption", "--launch day--", "--json"], dataDir, LI_ENV);
  assert.equal(out.code, 0, out.stderr);
  assert.match(JSON.parse(out.stdout).metadata.results[0].detail, /with a 14 character caption/);
});

test("publish only takes exports inside the data dir, by id or folder, with a passed layout check", async () => {
  const dataDir = tmpDir();
  const recipe = require("../recipes/publish-carousel.js");
  const gated = mockFetch(LI_OK);
  const ctx = { env: LI_ENV, dataDir, fetchImpl: gated };
  const good = path.join(dataDir, "exports", EXPORT_ID);
  writeExport(good, 2);
  const refuse = async (input, pattern, label) => {
    for (const extra of [{}, { dryRun: true }, { confirm: "PUBLISH", confirmToken: "x" }]) {
      const out = await recipe.runRecipe({ targets: ["linkedin"], ...input, ...extra }, ctx);
      assert.equal(out.status, "error", label);
      assert.equal(out.metadata.published, false, label);
      assert.match(out.reply, pattern, label);
    }
    assert.equal(gated.calls.length, 0, label);
  };

  // Traversal and folders outside the data dir: refused for that reason, not by accident.
  const outside = tmpDir();
  writeExport(path.join(outside, "20260304-050607-outside"), 2);
  await refuse({ id: "../../etc" }, /^Only exports inside the data dir can be published/, "dotdot id");
  await refuse({ id: path.join(dataDir, "exports", EXPORT_ID, "..", "..", "..") }, /^Only exports inside the data dir can be published/, "climbs out of the data dir");
  await refuse({ exportDir: path.join(outside, "20260304-050607-outside") }, /^Only exports inside the data dir can be published/, "a complete export elsewhere");
  await refuse({ exportDir: outside }, /^Only exports inside the data dir can be published/, "any folder elsewhere");
  await refuse({ id: dataDir }, /^Only exports inside the data dir can be published/, "the data dir itself");
  fs.symlinkSync(path.join(outside, "20260304-050607-outside"), path.join(dataDir, "exports", "20260304-050607-linked"));
  await refuse({ id: "20260304-050607-linked" }, /^No export found/, "an id that is a symlink out of the data dir");
  await refuse({ id: ["../x"] }, /^Say which carousel/, "a non-string id");
  await refuse({ id: "20260101-000000-nothing" }, /^No export found/, "an id with no export");
  const cliOutside = await runMain(["publish", outside, "--to", "linkedin"], dataDir, LI_ENV);
  assert.equal(cliOutside.code, 1);
  assert.match(cliOutside.stdout, /^Only exports inside the data dir can be published/);

  // The layout gate by directory: no manifest, a failed check, a corrupt manifest.
  const bare = path.join(dataDir, "exports", "20260304-050607-bare");
  writeSlides(bare, 2);
  await refuse({ exportDir: bare }, /no layout check on record/, "a folder of PNGs with no manifest");
  await refuse({ id: "20260304-050607-bare" }, /no layout check on record/, "the same by id");
  const flawed = path.join(dataDir, "exports", "20260304-050607-flawed");
  writeExport(flawed, 2, { qa: { ok: false, issues: ["slide-2: text overflows the safe area"] } });
  const byDir = await recipe.runRecipe({ exportDir: flawed, targets: ["linkedin"], confirm: "PUBLISH" }, ctx);
  assert.equal(byDir.metadata.qaFailed, true);
  await refuse({ exportDir: flawed }, /did not pass the layout check.*slide-2: text overflows the safe area/, "failed check by folder");
  await refuse({ id: "20260304-050607-flawed" }, /did not pass the layout check/, "failed check by id");
  fs.writeFileSync(path.join(flawed, "export.json"), "{broken");
  await refuse({ exportDir: flawed }, /not valid JSON/, "corrupt manifest");

  // Manifest entries that point out of the export folder.
  const tricky = path.join(dataDir, "exports", "20260304-050607-tricky");
  writeExport(tricky, 2);
  const rewrite = (manifest) => fs.writeFileSync(path.join(tricky, "export.json"), JSON.stringify({ files: ["slide-01.png", "slide-02.png"], qa: { ok: true }, ...manifest }));
  rewrite({ files: ["slide-01.png", `../${EXPORT_ID}/slide-02.png`] });
  await refuse({ id: "20260304-050607-tricky" }, /lists a slide outside its own folder/, "dotdot manifest entry");
  rewrite({ files: [path.join(outside, "20260304-050607-outside", "slide-01.png")] });
  await refuse({ id: "20260304-050607-tricky" }, /lists a slide outside its own folder/, "absolute manifest entry");
  const planted = path.join(outside, "written-by-manifest.pdf");
  rewrite({ pdf: planted });
  await refuse({ id: "20260304-050607-tricky" }, /points its PDF outside its own folder/, "absolute pdf");
  assert.equal(fs.existsSync(planted), false, "a manifest never chooses where the PDF is written");
  rewrite({ pdf: "../../../planted.pdf" });
  await refuse({ id: "20260304-050607-tricky" }, /points its PDF outside its own folder/, "dotdot pdf");

  // A caption file outside the data dir is never read into a public caption.
  const secret = path.join(outside, "secret.env");
  fs.writeFileSync(secret, "API_KEY=do-not-post-me");
  for (const extra of [{}, { dryRun: true }, { confirm: "PUBLISH" }]) {
    const out = await recipe.runRecipe({ id: EXPORT_ID, targets: ["linkedin"], captionFile: secret, ...extra }, ctx);
    assert.equal(out.status, "error");
    assert.match(out.reply, /^Could not use the caption file: Caption file secret\.env is outside the data dir\..*must be inside the data dir/);
    assert.ok(!JSON.stringify(out).includes("do-not-post-me"));
  }
  fs.writeFileSync(path.join(dataDir, "caption.txt"), "From my caption file");
  const withFile = await recipe.runRecipe({ id: EXPORT_ID, targets: ["linkedin"], captionFile: path.join(dataDir, "caption.txt"), dryRun: true }, ctx);
  assert.equal(withFile.status, "ok");
  assert.match(withFile.reply, /with a 20 character caption/);
  const notText = await recipe.runRecipe({ id: EXPORT_ID, targets: ["linkedin"], caption: { toString: () => "x" } }, ctx);
  assert.match(notText.reply, /caption must be text/);
  assert.equal(gated.calls.length, 0);
});

test("render-deck keeps writes inside the data dir and never echoes a file it could not parse", async () => {
  const dataDir = tmpDir();
  const outside = tmpDir();
  const recipe = require("../recipes/render-deck.js");
  const deck = { title: "T", slides: [{ layout: "01-editorial-statement", headline: "Hi" }] };

  const escaped = await recipe.runRecipe({ deck, outDir: path.join(outside, "render") }, { env: {}, dataDir });
  assert.equal(escaped.status, "error");
  assert.match(escaped.reply, /^outDir must be inside the data dir/);
  assert.equal(fs.existsSync(path.join(outside, "render")), false, "nothing was created outside");
  fs.mkdirSync(path.join(dataDir, "exports"), { recursive: true });
  fs.symlinkSync(outside, path.join(dataDir, "exports", "link"));
  const viaLink = await recipe.runRecipe({ deck, outDir: path.join(dataDir, "exports", "link", "render") }, { env: {}, dataDir });
  assert.match(viaLink.reply, /^outDir must be inside the data dir/);
  assert.deepEqual(fs.readdirSync(outside), []);
  const { insideDataDir } = require("../recipes/_engine.js");
  assert.equal(insideDataDir(path.join(dataDir, "exports", "new", "deeper"), { dataDir }), true);
  assert.equal(insideDataDir(path.join(dataDir, "..", "x"), { dataDir }), false);

  const secret = path.join(outside, "notes.txt");
  fs.writeFileSync(secret, "AWS_SECRET_ACCESS_KEY=abcdefgh12345678 and more text");
  const parsed = await recipe.runRecipe({ deckPath: secret }, { env: {}, dataDir });
  assert.equal(parsed.status, "error");
  assert.equal(parsed.reply, "The deck file is not valid JSON.");
  assert.ok(!JSON.stringify(parsed).includes("AWS_SECRET"));
  const gone = await recipe.runRecipe({ deckPath: path.join(outside, "missing.json") }, { env: {}, dataDir });
  assert.equal(gone.reply, "Could not read the deck file (ENOENT).");
});

function chromeForRender() {
  try {
    return require("../lib/render.js").findChrome();
  } catch {
    return null;
  }
}

test("a render to a custom folder carries its layout check with it", { skip: chromeForRender() ? false : "needs lib/render.js and a local Chrome" }, async () => {
  const dataDir = tmpDir();
  const work = tmpDir();
  const good = path.join(work, "good.json");
  const bad = path.join(work, "bad.json");
  fs.writeFileSync(good, JSON.stringify({ title: "Fine", slides: [{ layout: "01-editorial-statement", headline: "One *clear* idea." }, { layout: "11-recap-list", title: "Recap", items: ["First point", "Second point"] }] }));
  fs.writeFileSync(bad, JSON.stringify({ title: "Flawed", slides: [{ layout: "01-editorial-statement", headline: "One *clear* idea." }, { layout: "02-face-claim-cover", photo: "missing-photo.png", headline: "No photo here." }] }));

  // Inside the data dir: the folder gets its own manifest and can be published from.
  const inside = path.join(dataDir, "exports", "custom-out");
  const rendered = await runMain(["render", good, "--out", inside], dataDir);
  assert.equal(rendered.code, 0, rendered.stdout + rendered.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(inside, "export.json"), "utf8"));
  assert.equal(manifest.qa.ok, true);
  assert.deepEqual(manifest.files, ["slide-01.png", "slide-02.png"]);
  assert.equal(manifest.pdf, "carousel.pdf");
  const dry = await runMain(["publish", inside, "--to", "linkedin"], dataDir, LI_ENV);
  assert.equal(dry.code, 0, dry.stdout);
  assert.match(dry.stdout, /linkedin: Would post carousel\.pdf \(2 pages\)/);

  // A failed layout check is refused by folder and by id.
  const flawedOut = path.join(dataDir, "exports", "flawed-out");
  const flawed = await runMain(["render", bad, "--out", flawedOut, "--json"], dataDir);
  assert.equal(flawed.code, 1);
  const flawedId = JSON.parse(flawed.stdout).metadata.id;
  assert.equal(JSON.parse(fs.readFileSync(path.join(flawedOut, "export.json"), "utf8")).qa.ok, false);
  for (const ref of [flawedOut, flawedId]) {
    const out = await runMain(["publish", ref, "--to", "linkedin", "--confirm", "PUBLISH"], dataDir, LI_ENV, LI_OK);
    assert.equal(out.code, 1, ref);
    assert.match(out.stdout, /did not pass the layout check|lists a slide outside its own folder/, ref);
    assert.equal(out.calls.length, 0);
  }

  // Outside the data dir: allowed for the CLI render command, never publishable.
  const outside = path.join(work, "elsewhere");
  const external = await runMain(["render", good, "--out", outside, "--json"], dataDir);
  assert.equal(external.code, 0, external.stdout + external.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outside, "export.json"), "utf8")).qa.ok, true);
  const externalId = JSON.parse(external.stdout).metadata.id;
  const byFolder = await runMain(["publish", outside, "--to", "linkedin"], dataDir, LI_ENV);
  assert.equal(byFolder.code, 1);
  assert.match(byFolder.stdout, /^Only exports inside the data dir can be published/);
  const byId = await runMain(["publish", externalId, "--to", "linkedin"], dataDir, LI_ENV);
  assert.equal(byId.code, 1);
  assert.match(byId.stdout, /lists a slide outside its own folder/);
});

test("every recipe has a manifest in the shared shape and a runRecipe handler", () => {
  for (const name of RECIPES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", `${name}.recipe.json`), "utf8"));
    assert.equal(manifest.id, `agent/carousel-builder/${name}`);
    assert.equal(manifest.owner, "carousel-builder");
    for (const key of ["title", "description"]) assert.ok(typeof manifest[key] === "string" && manifest[key].length > 10, `${name}.${key}`);
    assert.ok(Array.isArray(manifest.phrases) && manifest.phrases.length >= 3, `${name}.phrases`);
    assert.equal(typeof manifest.safety.destructive, "boolean");
    assert.ok(manifest.safety.rule.length > 5);
    assert.equal(manifest.handler, `./${name}.js`);
    assert.equal(typeof require(path.join(ROOT, "recipes", manifest.handler)).runRecipe, "function");
  }
  const publish = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "publish-carousel.recipe.json"), "utf8"));
  assert.equal(publish.safety.destructive, true);
  assert.match(publish.safety.rule, /confirm: PUBLISH/);
});

test("status recipe: zero network, env names only", async () => {
  const dataDir = tmpDir();
  const fetchImpl = mockFetch();
  const out = await require("../recipes/status.js").runRecipe({}, { env: { LINKEDIN_ACCESS_TOKEN: "li-token-abcdefgh", LINKEDIN_AUTHOR_URN: "urn:li:person:abc123" }, dataDir, fetchImpl });
  assert.equal(out.status, "ok");
  assert.equal(out.metadata.networkCalls, 0);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(out.reply, /Publishers wired: linkedin\. Publishing still needs confirm: PUBLISH every time\./);
  assert.match(out.reply, /instagram: Instagram needs INSTAGRAM_ACCESS_TOKEN/);
  assert.equal(out.metadata.publishers.find((p) => p.id === "linkedin").wired, true);
  assert.ok(!JSON.stringify(out).includes("li-token-abcdefgh"));

  const bare = await require("../recipes/status.js").runRecipe({}, { env: {}, dataDir });
  assert.match(bare.reply, /Publishers: none wired/);
});

test("list-carousels recipe shows drafts, exports and where they were published", async () => {
  const dataDir = tmpDir();
  const list = require("../recipes/list-carousels.js");
  const empty = await list.runRecipe({}, { env: {}, dataDir });
  assert.match(empty.reply, /No carousels yet/);

  const a = store.saveDraft({ title: "First deck", slides: [{}, {}] }, { dataDir, now: new Date("2026-03-01T00:00:00Z") });
  const b = store.saveDraft({ title: "Second deck", slides: [{}, {}, {}] }, { dataDir, now: new Date("2026-03-02T00:00:00Z") });
  store.recordExport(b.id, writeSlides(path.join(dataDir, "exports", b.id), 3), { dataDir, title: "Second deck" });
  store.appendPublishLog({ target: "linkedin", status: "published", url: "https://www.linkedin.com/feed/update/urn:li:share:1/", source: b.id }, { dataDir });
  const out = await list.runRecipe({}, { env: {}, dataDir });
  assert.equal(out.metadata.count, 2);
  assert.deepEqual(out.metadata.carousels.map((c) => c.id), [b.id, a.id]);
  assert.match(out.reply, new RegExp(`${b.id}: "Second deck", 3 slides, exported, published to linkedin`));
  assert.match(out.reply, new RegExp(`${a.id}: "First deck", 2 slides, draft only`));
  assert.equal(out.metadata.recentPublishAttempts.length, 1);
});

test("publish-carousel recipe: dry run, token, then a confirmed LinkedIn post end to end", async () => {
  const dataDir = tmpDir();
  const draft = store.saveDraft({ title: "Launch notes", slides: [{}, {}] }, { dataDir, now: new Date("2026-03-02T00:00:00Z") });
  store.recordExport(draft.id, writeSlides(path.join(dataDir, "exports", draft.id), 2), { dataDir, title: "Launch notes", caption: "Read this", hashtags: ["#launch", "notes"], qa: { ok: true, issues: [] } });
  const env = LI_ENV;
  const recipe = require("../recipes/publish-carousel.js");

  // No confirm: refused, with the plan and the token for it.
  const gated = mockFetch(LI_OK);
  const refused = await recipe.runRecipe({ id: draft.id, targets: ["linkedin"] }, { env, dataDir, fetchImpl: gated });
  assert.equal(refused.status, "error");
  assert.equal(refused.metadata.published, false);
  assert.equal(refused.metadata.confirmationRequired, "PUBLISH");
  assert.match(refused.reply, /Confirm this exact request with confirm: PUBLISH/);
  assert.match(refused.reply, /linkedin: Would post carousel\.pdf \(2 pages\)/);
  const token = refused.metadata.confirmToken;
  assert.match(token, /^[0-9a-f]{24}$/);

  // Every truthy dryRun spelling is a dry run, even with confirm and the right token.
  for (const dryRun of [true, "true", 1, "1", "yes", "True", "on"]) {
    for (const key of ["dryRun", "dry_run"]) {
      const out = await recipe.runRecipe({ id: draft.id, targets: "linkedin", confirm: "PUBLISH", confirmToken: token, [key]: dryRun }, { env, dataDir, fetchImpl: gated });
      assert.equal(out.status, "ok", `${key}: ${JSON.stringify(dryRun)}`);
      assert.equal(out.metadata.dryRun, true);
      assert.equal(out.metadata.published, false);
      assert.equal(out.metadata.confirmToken, token);
      assert.match(out.reply, /^Dry run, nothing was sent\./);
    }
  }
  const nested = await recipe.runRecipe({ args: { id: draft.id, targets: "linkedin", confirm: "PUBLISH", confirmToken: token, dryRun: "1" } }, { env, dataDir, fetchImpl: gated });
  assert.equal(nested.metadata.dryRun, true, "args.dryRun counts too");

  // confirm is compared as the raw value: no String(), no trim.
  for (const confirm of [["PUBLISH"], " PUBLISH", "PUBLISH\n", "publish", true, { toString: () => "PUBLISH" }]) {
    const out = await recipe.runRecipe({ id: draft.id, targets: ["linkedin"], confirm, confirmToken: token }, { env, dataDir, fetchImpl: gated });
    assert.equal(out.status, "error", JSON.stringify(confirm));
    assert.equal(out.metadata.confirmationRequired, "PUBLISH");
    assert.equal(out.metadata.published, false);
  }

  // The token is bound to the request: missing, wrong, or approved for something else.
  for (const input of [
    { confirmToken: undefined },
    { confirmToken: "f".repeat(24) },
    { confirmToken: token, targets: "linkedin,all" },
    { confirmToken: token, caption: "An injected caption" },
    { confirmToken: token, title: "Another title" },
  ]) {
    const out = await recipe.runRecipe({ id: draft.id, targets: ["linkedin"], confirm: "PUBLISH", ...input }, { env: { ...env, FACEBOOK_PAGE_ID: "1", FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token-abcdefgh" }, dataDir, fetchImpl: gated });
    assert.equal(out.status, "error", JSON.stringify(input));
    assert.equal(out.metadata.published, false);
    assert.equal(out.metadata.confirmTokenRequired, true);
    assert.match(out.reply, /^Nothing was sent: the confirmToken is missing or does not match this exact request\./);
    assert.match(out.reply, /To publish exactly this, call again with confirm: PUBLISH and confirmToken: [0-9a-f]{24}/);
    assert.notEqual(out.metadata.confirmToken, input.confirmToken === token ? token : "none");
  }
  assert.equal(gated.calls.length, 0, "nothing above reached the network");

  // confirm plus the matching token: published.
  const live = mockFetch(LI_OK);
  const done = await recipe.runRecipe({ id: draft.id, targets: ["linkedin"], confirm: "PUBLISH", confirmToken: token }, { env, dataDir, fetchImpl: live });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.metadata.publishedTo, ["linkedin"]);
  assert.match(done.reply, /1 of 1 published\.\nlinkedin: published https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:55\//);
  assert.equal(live.calls.length, 3);
  assert.equal(live.calls[2].json.commentary, "Read this\n\n#launch #notes");
  assert.equal(live.calls[2].json.content.media.title, "Launch notes");
  assert.ok(Buffer.isBuffer(live.calls[1].body) && live.calls[1].body.subarray(0, 5).toString() === "%PDF-");

  // An unknown outcome is surfaced as not confirmed, never as published.
  const shaky = mockFetch((call, i) => (i < 2 ? LI_OK(call, i === 0 ? 0 : 1) : response(504, "gateway timeout")));
  const unsure = await recipe.runRecipe({ id: draft.id, targets: ["linkedin"], confirm: "PUBLISH", confirmToken: token }, { env, dataDir, fetchImpl: shaky });
  assert.equal(unsure.status, "error");
  assert.equal(unsure.metadata.published, false);
  assert.deepEqual(unsure.metadata.unconfirmed, ["linkedin"]);
  assert.match(unsure.reply, /^0 of 1 published\. 1 not confirmed: check linkedin before retrying\.\nlinkedin: unknown\./);

  // An export that failed the layout check is never published, confirmed or not.
  const flawed = store.saveDraft({ title: "Clipped", slides: [{}, {}] }, { dataDir, now: new Date("2026-03-03T00:00:00Z") });
  store.recordExport(flawed.id, writeSlides(path.join(dataDir, "exports", flawed.id), 2), { dataDir, qa: { ok: false, issues: ["slide-2: text overflows the safe area"] } });
  const blocked = await recipe.runRecipe({ id: flawed.id, targets: ["linkedin"], confirm: "PUBLISH" }, { env, dataDir, fetchImpl: gated });
  assert.equal(blocked.status, "error");
  assert.equal(blocked.metadata.qaFailed, true);
  assert.match(blocked.reply, /did not pass the layout check.*slide-2: text overflows the safe area/);
  // recordExport without a qa result leaves no passing check on record either.
  const unchecked = store.saveDraft({ title: "Unchecked", slides: [{}, {}] }, { dataDir, now: new Date("2026-03-04T00:00:00Z") });
  store.recordExport(unchecked.id, writeSlides(path.join(dataDir, "exports", unchecked.id), 2), { dataDir });
  const noCheck = await recipe.runRecipe({ id: unchecked.id, targets: ["linkedin"], dryRun: true }, { env, dataDir, fetchImpl: gated });
  assert.match(noCheck.reply, /did not pass the layout check.*no passing check is on record/);
  assert.equal(gated.calls.length, 0);

  const none = await recipe.runRecipe({ id: draft.id, targets: "all", confirm: "PUBLISH" }, { env: {}, dataDir, fetchImpl: gated });
  assert.equal(none.status, "error");
  assert.match(none.reply, /No publisher is wired yet/);
  const noTarget = await recipe.runRecipe({ id: draft.id }, { env, dataDir, fetchImpl: gated });
  assert.match(noTarget.reply, /Say where to publish/);
  const noExport = await recipe.runRecipe({ targets: ["linkedin"] }, { env, dataDir, fetchImpl: gated });
  assert.match(noExport.reply, /Say which carousel/);
});

test("recipes that need other engine parts answer with a clear error for bad input", async () => {
  const dataDir = tmpDir();
  const render = await require("../recipes/render-deck.js").runRecipe({}, { env: {}, dataDir });
  assert.equal(render.status, "error");
  assert.match(render.reply, /Say what to render/);
  const badId = await require("../recipes/render-deck.js").runRecipe({ id: "../x" }, { env: {}, dataDir });
  assert.match(badId.reply, /not a carousel id/);
  const create = await require("../recipes/create-carousel.js").runRecipe({}, { env: {}, dataDir });
  assert.equal(create.status, "error");
  const images = await require("../recipes/find-backgrounds.js").runRecipe({}, { env: {}, dataDir, fetchImpl: mockFetch() });
  assert.equal(images.status, "error");
});
