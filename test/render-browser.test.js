"use strict";
/*
 * Browser choice and browser sharing. The bug these guard against: a render that launched the GUI Chrome app
 * bundle once per slide (77 launches in 40 seconds), so the user saw Chrome flash open on every slide and the
 * CPU pinned. Now a headless-only binary is preferred and one browser process serves a whole batch.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const render = require("../lib/render.js");
const { findChrome, headlessShellCandidates, appBundleCandidates, isHeadlessShell, browserArgs, launchBrowser, chromeScreenshot, renderDeck, cornerCheck, pngSize, launchGuard } = render;
const { normalizeBrand } = require("../lib/brand.js");
const { SIZES } = require("../lib/deck-schema.js");

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `carousel-browser-${name}-`));
const readDeck = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "examples", name), "utf8"));
const neutral = () => normalizeBrand({}, null);
const mac = process.platform === "darwin";
const exe = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body || "#!/bin/sh\nexit 0\n", { mode: 0o755 }); return file; };

// the real headless shell on this machine, if any: the real-render tests below run with it and never with the app bundle
const realShell = headlessShellCandidates()[0] || null;
const noShell = realShell ? false : "no chrome-headless-shell found (Playwright or Chrome for Testing cache); the browser-sharing render tests need one";
if (noShell) console.log(`# browser tests partly skipped: ${noShell}`);

/*
 * A fake machine: a home folder with Playwright and Puppeteer caches, an Applications folder with a Chrome app
 * bundle, and a PATH folder. Every binary is a script; the headless shells exec the real one when asked.
 */
function fakeMachine(dir, { shells = true, app = true, execReal = false } = {}) {
  const home = path.join(dir, "home"), apps = path.join(dir, "Applications"), bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const body = execReal && realShell ? `#!/bin/sh\nexec "${realShell}" "$@"\n` : "#!/bin/sh\nexit 0\n";
  const m = { home, apps, bin, shells: {}, app: null };
  const pw = mac ? path.join(home, "Library", "Caches", "ms-playwright") : path.join(home, ".cache", "ms-playwright");
  const plat = mac ? "mac-arm64" : "linux64";
  if (shells) {
    m.shells.old = exe(path.join(pw, "chromium_headless_shell-1208", `chrome-headless-shell-${plat}`, "chrome-headless-shell"), body);
    m.shells.newest = exe(path.join(pw, "chromium_headless_shell-1243", `chrome-headless-shell-${plat}`, "chrome-headless-shell"), body);
    m.shells.middle = exe(path.join(pw, "chromium_headless_shell-1234", `chrome-headless-shell-${plat}`, "chrome-headless-shell"), body);
    m.shells.cft = exe(path.join(home, ".cache", "puppeteer", "chrome-headless-shell", `${mac ? "mac_arm" : "linux"}-150.0.7871.24`, `chrome-headless-shell-${plat}`, "chrome-headless-shell"), body);
    m.shells.onPath = exe(path.join(bin, "chrome-headless-shell"), body);
  }
  if (app) m.app = mac ? exe(path.join(apps, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")) : exe(path.join(bin, "google-chrome"));
  m.env = { PATH: bin };
  m.opts = { home, appDirs: [apps], pathDirs: [bin] };
  return m;
}

test("findChrome order: CHROME_BIN, then the newest headless shell, then the app bundle; CAROUSEL_PREFER_APP_BUNDLE=1 skips the shells", () => {
  const dir = tmpDir("order");
  try {
    const m = fakeMachine(dir);
    assert.deepEqual(headlessShellCandidates(m.env, m.opts), [m.shells.newest, m.shells.middle, m.shells.old, m.shells.cft, m.shells.onPath], "Playwright newest first, then Chrome for Testing, then PATH");
    assert.deepEqual(appBundleCandidates(m.env, m.opts), [m.app]);
    assert.equal(findChrome(m.env, m.opts), m.shells.newest, "the newest headless shell beats the app bundle");
    assert.equal(findChrome(Object.assign({ CAROUSEL_PREFER_APP_BUNDLE: "1" }, m.env), m.opts), m.app, "the opt-out brings the app bundle back");
    assert.equal(findChrome(Object.assign({ CHROME_BIN: m.app }, m.env), m.opts), m.app, "CHROME_BIN wins over the shells");
    assert.equal(findChrome(Object.assign({ CHROME_BIN: path.join(dir, "missing") }, m.env), m.opts), m.shells.newest, "an unusable CHROME_BIN is ignored");
    // PLAYWRIGHT_BROWSERS_PATH is honoured ahead of the default cache
    const alt = exe(path.join(dir, "alt", "chromium_headless_shell-1300", `chrome-headless-shell-${mac ? "mac-arm64" : "linux64"}`, "chrome-headless-shell"));
    assert.equal(findChrome(Object.assign({ PLAYWRIGHT_BROWSERS_PATH: path.join(dir, "alt") }, m.env), m.opts), alt);
    assert.ok(isHeadlessShell(m.shells.newest) && !isHeadlessShell(m.app));
    assert.ok(!findChrome(m.env, m.opts).includes("/Contents/MacOS/"), "a headless shell is never inside an app bundle");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("findChrome falls back to the app bundle when no headless shell exists, and to null when nothing exists", () => {
  const dir = tmpDir("fallback");
  try {
    const m = fakeMachine(dir, { shells: false });
    assert.deepEqual(headlessShellCandidates(m.env, m.opts), []);
    assert.equal(findChrome(m.env, m.opts), m.app);
    const empty = fakeMachine(path.join(dir, "empty"), { shells: false, app: false });
    assert.equal(findChrome(empty.env, empty.opts), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("browserArgs: the headless shell gets no --headless flag, a full browser gets --headless=new, both keep the pipe and the window size", () => {
  const shell = browserArgs({ chromePath: "/x/chrome-headless-shell", width: 1080, height: 1350, profile: "/p", env: {} });
  const app = browserArgs({ chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", width: 1080, height: 1080, profile: "/p", env: {} });
  assert.ok(!shell.some((a) => a.startsWith("--headless")), shell.join(" "));
  assert.ok(app.includes("--headless=new"));
  for (const args of [shell, app]) {
    for (const flag of ["--disable-gpu", "--hide-scrollbars", "--remote-debugging-pipe", "--force-device-scale-factor=1", "--user-data-dir=/p"]) assert.ok(args.includes(flag), `${flag} missing`);
    assert.equal(args[args.length - 1], "about:blank");
  }
  assert.ok(shell.includes("--window-size=1080,1350") && app.includes("--window-size=1080,1080"));
  assert.ok(!shell.includes("--no-sandbox"));
  assert.ok(browserArgs({ chromePath: "/x/chrome-headless-shell", width: 1, height: 1, profile: "/p", env: { CAROUSEL_CHROME_NO_SANDBOX: "1" } }).includes("--no-sandbox"));
});

test("the launch guard warns once, naming the cause, after more than 3 launches in 10 seconds, and never throws", () => {
  const lines = [];
  const saved = launchGuard.log;
  launchGuard.reset(); launchGuard.log = (l) => lines.push(l);
  try {
    for (let i = 0; i < 3; i++) assert.equal(launchGuard.note("/x/chrome-headless-shell"), false);
    assert.deepEqual(lines, []);
    assert.equal(launchGuard.note("/x/chrome-headless-shell"), true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /4 browser launches within 10 seconds/);
    assert.match(lines[0], /Cause: .*own browser instead of sharing one per batch/);
    assert.match(lines[0], /Rendering continues/);
    for (let i = 0; i < 10; i++) launchGuard.note("/x/chrome-headless-shell");
    assert.equal(lines.length, 1, "one warning per process");
    assert.equal(launchGuard.total, 14);
  } finally { launchGuard.log = saved; launchGuard.reset(); }
});

/* ---------- real renders: all through the headless shell, counting processes through a spy on child_process.spawn ---------- */

/* record every browser launch (anything that is not a node child) while fn runs */
async function spyLaunches(fn, onLaunch) {
  const real = cp.spawn, launches = [];
  cp.spawn = function (file, args, opts) {
    const child = real.call(cp, file, args, opts);
    if (file !== process.execPath) { launches.push({ file, args, child }); if (onLaunch) onLaunch(child); }
    return child;
  };
  try { return { result: await fn(launches), launches }; } finally { cp.spawn = real; }
}

test("the renderer never spawns a binary inside an app bundle (/Contents/MacOS/) when a headless shell is available", { skip: noShell }, async () => {
  const dir = tmpDir("noapp");
  try {
    const m = fakeMachine(dir, { execReal: true });
    const chosen = findChrome(m.env, m.opts);
    assert.equal(chosen, m.shells.newest);
    const page = path.join(dir, "page.html");
    fs.writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;width:1080px;height:1350px;overflow:hidden}</style></head><body><div style="width:1080px;height:1350px;background:repeating-linear-gradient(135deg,#123,#abc 7px,#456 13px)"></div></body></html>`);
    const { result, launches } = await spyLaunches(() => chromeScreenshot({ chromePath: chosen, url: pathToFileURL(page).href, out: path.join(dir, "out.png"), width: 1080, height: 1350 }));
    assert.equal(launches.length, 1);
    assert.equal(launches[0].file, chosen);
    assert.ok(!launches[0].file.includes("/Contents/MacOS/"), launches[0].file);
    assert.ok(!launches[0].args.some((a) => a.startsWith("--headless")), "the shell is already headless");
    assert.deepEqual(result.cornerCheck, { ok: true, issues: [] });
    assert.deepEqual(pngSize(result.out), { w: 1080, h: 1350 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("one renderJobs batch of 8 slides launches exactly one browser process, and the 8 PNGs pass the layout check", { skip: noShell }, async () => {
  const dir = tmpDir("batch");
  try {
    const { renderJobs } = await import(pathToFileURL(path.join(ROOT, "render.mjs")).href);
    const deck = readDeck("example-deck.json");
    const jobs = deck.slides.map((s, i) => {
      const fields = Object.assign({}, deck.defaults || {}, s); delete fields.layout;
      return { name: `slide-${i + 1}`, layout: s.layout, fields, slide: i + 1, total: deck.slides.length, baseDir: path.join(ROOT, "examples"), out: path.join(dir, `slide-${String(i + 1).padStart(2, "0")}.png`) };
    });
    assert.equal(jobs.length, 8);
    launchGuard.reset();
    const warned = []; const saved = launchGuard.log; launchGuard.log = (l) => warned.push(l);
    let result, launches;
    try { ({ result, launches } = await spyLaunches(() => renderJobs(jobs, { brand: neutral(), size: "portrait", chromePath: realShell, allowDirs: [path.join(ROOT, "examples")], dataDir: dir, concurrency: 2 }))); }
    finally { launchGuard.log = saved; }
    assert.equal(launches.length, 1, `browser launches: ${launches.map((l) => l.file).join(", ")}`);
    assert.equal(launches[0].file, realShell);
    assert.deepEqual(warned, [], "one launch for the batch never trips the guard");
    assert.equal(result.ok, true, result.qa.issues.join("; "));
    assert.equal(result.files.length, 8);
    for (const file of result.files) {
      assert.deepEqual(pngSize(file), { w: SIZES.portrait.w, h: SIZES.portrait.h });
      assert.deepEqual(cornerCheck(file), { ok: true, issues: [], blocks: [] }, `${path.basename(file)} has a flat corner block`);
    }
    assert.ok(result.slides.every((s) => s.ok && s.textElements > 0));
    // the batch's browser is gone when the batch is: nothing stays alive between renders
    const child = launches[0].child;
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r)));
    launchGuard.reset();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CHROME_BIN still wins at render time: renderDeck of 8 slides runs exactly one browser process, the one CHROME_BIN names", { skip: noShell }, async () => {
  const dir = tmpDir("chromebin");
  const savedBin = process.env.CHROME_BIN, savedPrefer = process.env.CAROUSEL_PREFER_APP_BUNDLE;
  try {
    // a shim that logs every launch, then becomes the real headless shell (exec keeps the DevTools pipe fds)
    const log = path.join(dir, "launches.log");
    const shim = exe(path.join(dir, "my-browser"), `#!/bin/sh\necho "$$ $0" >> "${log}"\nexec "${realShell}" "$@"\n`);
    process.env.CHROME_BIN = shim; delete process.env.CAROUSEL_PREFER_APP_BUNDLE;
    assert.equal(findChrome(), shim);
    const res = await renderDeck(readDeck("example-deck.json"), { outDir: path.join(dir, "out"), brand: neutral(), baseDir: path.join(ROOT, "examples"), dataDir: dir });
    assert.equal(res.ok, true, res.qa.issues.join("; "));
    assert.equal(res.files.length, 8);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, `browser launches for an 8 slide deck: ${lines.length}`);
    assert.ok(lines[0].endsWith(shim));
  } finally {
    if (savedBin === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = savedBin;
    if (savedPrefer !== undefined) process.env.CAROUSEL_PREFER_APP_BUNDLE = savedPrefer;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* a local server that accepts connections and never answers: a page that never finishes loading */
function hangingServer() {
  const server = http.createServer(() => { /* never respond */ });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/hang`, close: () => { server.closeAllConnections(); server.close(); } })));
}

test("a shared browser: the per-capture timeout closes only that tab, and a crash fails every open and later capture at once instead of hanging", { skip: noShell }, async () => {
  const dir = tmpDir("crash");
  const hang = await hangingServer();
  let browser = null;
  try {
    const page = path.join(dir, "page.html");
    fs.writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;width:1080px;height:1350px;overflow:hidden}</style></head><body><div style="width:1080px;height:1350px;background:repeating-linear-gradient(135deg,#123,#abc 7px,#456 13px)"></div></body></html>`);
    browser = await launchBrowser({ chromePath: realShell, width: 1080, height: 1350 });
    const shoot = (url, name, extra) => chromeScreenshot(Object.assign({ browser, url, out: path.join(dir, name), width: 1080, height: 1350 }, extra));

    // a capture that cannot finish times out on its own clock; the browser and its next capture are unaffected
    await assert.rejects(shoot(hang.url, "hang.png", { timeoutMs: 1500 }), { code: "chrome_timeout" });
    assert.equal(browser.alive, true);
    const fine = await shoot(pathToFileURL(page).href, "fine.png");
    assert.deepEqual(fine.cornerCheck, { ok: true, issues: [] });
    // Target.closeTarget answers when the close starts, so a tab stuck in a load can be listed for a moment longer
    const openTabs = async () => (await browser.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page" && t.url !== "about:blank");
    let tabs = await openTabs();
    for (let i = 0; tabs.length && i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); tabs = await openTabs(); }
    assert.deepEqual(tabs.map((t) => t.url), [], "finished and timed out tabs are closed");

    // the browser dies while a capture is waiting on it: the capture fails now, with the reason, not at its timeout
    const t0 = Date.now();
    const pendingCapture = shoot(hang.url, "dead.png", { timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 300));
    process.kill(browser.child.pid, "SIGKILL");
    await assert.rejects(pendingCapture, (e) => /browser exited|control pipe/.test(e.message));
    assert.ok(Date.now() - t0 < 10000, "the failure did not wait for the capture timeout");
    assert.equal(browser.alive, false);
    await assert.rejects(shoot(pathToFileURL(page).href, "after.png"), (e) => /browser exited|control pipe/.test(e.message));
  } finally {
    hang.close();
    if (browser) await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderJobs survives its browser dying mid-batch: the slides after the crash report the error, the batch returns", { skip: noShell }, async () => {
  const dir = tmpDir("midbatch");
  try {
    const { renderJobs } = await import(pathToFileURL(path.join(ROOT, "render.mjs")).href);
    const jobs = Array.from({ length: 4 }, (_, i) => ({ name: `slide-${i + 1}`, layout: "01-editorial-statement", fields: { headline: `Slide ${i + 1}.` }, slide: i + 1, total: 4, baseDir: ROOT, out: path.join(dir, `slide-${i + 1}.png`) }));
    const t0 = Date.now();
    // kill the browser the moment the first tab is closed, so slide 1 is done and the others still have to render
    const killOnFirstClose = (child) => {
      const pipe = child.stdio[3], write = pipe.write.bind(pipe);
      let killed = false;
      pipe.write = (chunk, ...rest) => {
        const r = write(chunk, ...rest);
        if (!killed && String(chunk).includes("Target.closeTarget")) { killed = true; try { process.kill(child.pid, "SIGKILL"); } catch (e) { /* gone */ } }
        return r;
      };
    };
    const { result, launches } = await spyLaunches(() => renderJobs(jobs, { brand: neutral(), chromePath: realShell, dataDir: dir, concurrency: 1 }), killOnFirstClose);
    assert.equal(launches.length, 1, "no relaunch: one process per batch, even after it dies");
    assert.equal(result.slides.length, 4);
    assert.equal(result.ok, false);
    assert.equal(result.slides[0].ok, true, result.slides[0].issues.join("; "));
    const failed = result.slides.filter((s) => !s.ok);
    assert.ok(failed.length >= 1);
    for (const s of failed) assert.match(s.issues.join(" | "), /browser exited|control pipe|browser was closed/, `${s.name}: ${s.issues.join("; ")}`);
    assert.ok(Date.now() - t0 < 30000, "the batch did not hang on the dead browser");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
