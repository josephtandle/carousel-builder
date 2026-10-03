"use strict";
/*
 * Render a deck to PNG files through render.mjs (headless Chrome, with the in-page QA gate).
 *
 *   renderDeck(deck, { outDir, brand, size, chromePath }) -> Promise<{ ok, files, qa: { ok, issues } }>
 *   findChrome() -> path of a headless shell, Chrome, Chromium or Edge binary, or null
 *   launchBrowser({ chromePath, width, height }) -> Promise<browser>   one browser process, shared by many captures
 *   chromeScreenshot({ browser | chromePath, url, out, width, height }) -> one capture, in its own tab
 *
 * renderDeck never throws for an expected problem (invalid deck, no browser, a slide failing QA): it resolves
 * with ok: false and the reasons in qa.issues, plus `error` set to a short code.
 *
 * Browser search order (findChrome):
 *   1. CHROME_BIN, when it points at a runnable file.
 *   2. A headless-only binary (chrome-headless-shell): Playwright's cache (PLAYWRIGHT_BROWSERS_PATH, else
 *      ~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux, %LOCALAPPDATA%\ms-playwright on
 *      Windows; the highest chromium_headless_shell-<revision> folder wins), then Chrome for Testing's layout under
 *      Puppeteer's cache (PUPPETEER_CACHE_DIR, else ~/.cache/puppeteer/chrome-headless-shell/<platform>-<version>;
 *      the highest version wins), then chrome-headless-shell on PATH.
 *   3. The macOS app bundles (Chrome, Chromium, Edge, Canary, system and per-user Applications), then the usual
 *      Linux binary names on PATH.
 * CAROUSEL_PREFER_APP_BUNDLE=1 skips step 2, which is the old behaviour. A GUI app bundle is a last resort: every
 * launch of one gets a Dock icon and a window server session, so on macOS the user sees Chrome flash open.
 */
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateDeck, SIZES, DEFAULT_SIZE } = require("./deck-schema.js");
const { normalizeBrand } = require("./brand.js");
const { decodePng } = require("./pdf.js");

const ROOT = path.resolve(__dirname, "..");
const RENDER_MJS = path.join(ROOT, "render.mjs");

const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];
const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
const SHELL_NAME = "chrome-headless-shell";
const SHELL_FILES = process.platform === "win32" ? [SHELL_NAME + ".exe", SHELL_NAME] : [SHELL_NAME];

function isRunnable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch (e) { return false; }
}
function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); } catch (e) { return []; }
}
/* "chromium_headless_shell-1243" -> [1243]; "mac_arm-150.0.7871.24" -> [150, 0, 7871, 24]. Higher wins. */
function versionOf(name) { return (name.match(/\d+/g) || []).map(Number); }
function byVersionDesc(a, b) {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) { const d = (vb[i] || 0) - (va[i] || 0); if (d) return d; }
  return a < b ? 1 : a > b ? -1 : 0;
}
/* the binary inside one version folder: <folder>/chrome-headless-shell-<platform>/chrome-headless-shell */
function shellInside(folder) {
  const subs = listDirs(folder).filter((n) => n.startsWith(SHELL_NAME + "-"));
  const mine = `${SHELL_NAME}-${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux"}`;
  subs.sort((a, b) => (b.startsWith(mine) ? 1 : 0) - (a.startsWith(mine) ? 1 : 0) || a.localeCompare(b));
  for (const sub of subs) for (const file of SHELL_FILES) { const p = path.join(folder, sub, file); if (isRunnable(p)) return p; }
  for (const file of SHELL_FILES) { const p = path.join(folder, file); if (isRunnable(p)) return p; }
  return null;
}
function isHeadlessShell(file) { return /chrome-headless-shell(\.exe)?$/i.test(path.basename(String(file || ""))); }

/*
 * Every chrome-headless-shell binary we can see, best first. `env` and `opts` exist so tests can point the search
 * at a fake file layout: opts.home replaces the user's home folder, opts.pathDirs the PATH entries.
 */
function headlessShellCandidates(env, opts) {
  const e = env || process.env, o = opts || {};
  const home = o.home || os.homedir();
  const out = [], roots = [];
  if (e.PLAYWRIGHT_BROWSERS_PATH && e.PLAYWRIGHT_BROWSERS_PATH !== "0") roots.push(e.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === "darwin") roots.push(path.join(home, "Library", "Caches", "ms-playwright"));
  else if (process.platform === "win32") roots.push(path.join(e.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright"));
  else roots.push(path.join(e.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright"));
  for (const root of roots) {
    const folders = listDirs(root).filter((n) => n.startsWith("chromium_headless_shell-")).sort(byVersionDesc);
    for (const f of folders) { const bin = shellInside(path.join(root, f)); if (bin) out.push(bin); }
  }
  // Chrome for Testing, as Puppeteer lays it out: <cache>/chrome-headless-shell/<platform>-<version>/chrome-headless-shell-<platform>/
  const cft = [e.PUPPETEER_CACHE_DIR, path.join(home, ".cache", "puppeteer")].filter(Boolean).map((d) => path.join(d, SHELL_NAME));
  for (const root of cft) {
    for (const f of listDirs(root).sort(byVersionDesc)) { const bin = shellInside(path.join(root, f)); if (bin) out.push(bin); }
  }
  const dirs = o.pathDirs || String(e.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) for (const file of SHELL_FILES) { const p = path.join(dir, file); if (isRunnable(p)) out.push(p); }
  return Array.from(new Set(out));
}

/* The app bundles and PATH browsers, in order. opts.appDirs replaces the Applications folders (tests). */
function appBundleCandidates(env, opts) {
  const e = env || process.env, o = opts || {}, out = [];
  if (process.platform === "darwin") {
    const bases = o.appDirs || ["/Applications", path.join(o.home || os.homedir(), "Applications")];
    for (const base of bases) for (const app of MAC_APPS) { const p = path.join(base, app); if (isRunnable(p)) out.push(p); }
  }
  const dirs = o.pathDirs || String(e.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of PATH_NAMES) for (const dir of dirs) { const p = path.join(dir, name); if (isRunnable(p)) out.push(p); }
  return out;
}

/*
 * The search order is documented at the top of this file. `env` defaults to process.env; `opts` (home, appDirs,
 * pathDirs) lets a test inject a file layout. Returns null when nothing is found.
 */
function findChrome(env, opts) {
  const e = env || process.env;
  if (e.CHROME_BIN && isRunnable(e.CHROME_BIN)) return e.CHROME_BIN;
  if (e.CAROUSEL_PREFER_APP_BUNDLE !== "1") {
    const shell = headlessShellCandidates(e, opts)[0];
    if (shell) return shell;
  }
  return appBundleCandidates(e, opts)[0] || null;
}

function pngComplete(file) {
  // a finished PNG ends with the IEND chunk
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size < 57) return false;
    fd = fs.openSync(file, "r");
    const tail = Buffer.alloc(8);
    fs.readSync(fd, tail, 0, 8, size - 8);
    return tail.toString("latin1", 0, 4) === "IEND";
  } catch (e) { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}

function pngSize(file) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(24); fs.readSync(fd, b, 0, 24, 0); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
  finally { fs.closeSync(fd); }
}

const live = new Set(), profiles = new Set();
function removeProfile(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch (e) { /* temp dir, best effort */ }
  profiles.delete(dir);
}
function killTree(child) {
  if (!child || child.killed && child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (e) { try { child.kill("SIGKILL"); } catch (e2) { /* already gone */ } }
}
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  process.on("exit", () => { for (const c of live) killTree(c); for (const d of Array.from(profiles)) removeProfile(d); });
}

/*
 * Launch guard. A render batch shares one browser; a browser per slide is the bug this guards against (77 GUI
 * Chrome launches in 40 seconds, each with a Dock icon). More than LAUNCH_BURST launches inside LAUNCH_WINDOW_MS
 * in one process logs one warning naming the cause and carries on: a render is never failed for it.
 */
const LAUNCH_BURST = 3, LAUNCH_WINDOW_MS = 10000;
const launchGuard = {
  times: [], warned: false, total: 0,
  log: (line) => console.error(line),
  note(bin) {
    const now = Date.now();
    this.total++;
    this.times.push(now);
    while (this.times.length && this.times[0] < now - LAUNCH_WINDOW_MS) this.times.shift();
    if (this.times.length > LAUNCH_BURST && !this.warned) {
      this.warned = true;
      this.log(`carousel render: ${this.times.length} browser launches within ${LAUNCH_WINDOW_MS / 1000} seconds in one process (${path.basename(String(bin))}). ` +
        "Cause: captures are each starting their own browser instead of sharing one per batch (chromeScreenshot called without a `browser`, or several batches at once). Rendering continues.");
      return true;
    }
    return false;
  },
  reset() { this.times = []; this.warned = false; this.total = 0; },
};

/*
 * Chrome DevTools Protocol over --remote-debugging-pipe: fd 3 carries our commands, fd 4 carries the
 * browser's replies and events. Every message is one JSON object ended by a NUL byte.
 */
function cdpPipe(child) {
  const tx = child.stdio[3], rx = child.stdio[4];
  const pending = new Map(), listeners = new Set();
  let nextId = 0, parts = [], closed = null, onClosed = null;
  const whenClosed = new Promise((r) => { onClosed = r; });
  const fail = (err) => {
    if (closed) return; closed = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    onClosed(err);
  };
  if (!tx || !rx) {
    fail(Object.assign(new Error("the browser control pipe could not be opened"), { code: "cdp_closed" }));
    return { send: () => Promise.reject(closed), on() { return () => {}; }, fail, whenClosed, get closed() { return closed; } };
  }
  const handle = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { code: "cdp_error" }));
      else p.resolve(msg.result || {});
    } else if (msg.method) for (const l of Array.from(listeners)) l(msg);
  };
  rx.on("data", (d) => {
    let start = 0, end;
    while ((end = d.indexOf(0, start)) !== -1) {
      parts.push(d.subarray(start, end));
      handle(Buffer.concat(parts).toString("utf8"));
      parts = []; start = end + 1;
    }
    if (start < d.length) parts.push(d.subarray(start));
  });
  const gone = () => fail(Object.assign(new Error("the browser closed its control pipe"), { code: "cdp_closed" }));
  rx.on("error", gone); rx.on("close", gone); tx.on("error", gone);
  return {
    send(method, params, sessionId) {
      if (closed) return Promise.reject(closed);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try { tx.write(JSON.stringify(Object.assign({ id, method, params: params || {} }, sessionId ? { sessionId } : {})) + "\0"); }
        catch (e) { pending.delete(id); reject(Object.assign(new Error(`${method}: ${e.message}`), { code: "cdp_closed" })); }
      });
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fail, whenClosed,
    get closed() { return closed; },
  };
}

/*
 * The command line for one browser process. chrome-headless-shell is headless by construction, so it gets no
 * --headless flag; a full browser binary gets --headless=new. Everything else is the same for both.
 */
function browserArgs({ chromePath, width, height, profile, env }) {
  const e = env || process.env;
  const args = [];
  if (!isHeadlessShell(chromePath)) args.push("--headless=new");
  args.push("--disable-gpu", "--hide-scrollbars", "--remote-debugging-pipe",
    `--window-size=${width},${height}`, "--force-device-scale-factor=1",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    "--disable-background-networking", "--disable-component-update", "--password-store=basic", "--use-mock-keychain",
    `--user-data-dir=${profile}`);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (root || e.CAROUSEL_CHROME_NO_SANDBOX === "1") args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

/*
 * launchBrowser({ chromePath, width, height, startTimeoutMs }) -> Promise<browser>
 * One browser process with its own throwaway profile, driven over the DevTools pipe. Open as many tabs in it as
 * you like (chromeScreenshot does, one per capture) and close it once with browser.close().
 *
 *   browser.send(method, params, sessionId)   a CDP command (the browser session, or a tab's session)
 *   browser.on(fn) -> unsubscribe              CDP events
 *   browser.exited                            resolves with an Error once the process is gone or the pipe broke
 *   browser.alive                             false once that happened
 *   browser.close() -> Promise                stop the process and remove the profile (idempotent)
 */
function launchBrowser({ chromePath, width = 1080, height = 1350, startTimeoutMs = 30000, env } = {}) {
  hookExit();
  if (!chromePath || !isRunnable(chromePath)) {
    return Promise.reject(Object.assign(new Error("No Chrome, Chromium or Edge found. Install one, or set CHROME_BIN to its binary."), { code: "chrome_not_found" }));
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "carousel-chrome-"));
  profiles.add(profile);
  const args = browserArgs({ chromePath, width, height, profile, env });
  launchGuard.note(chromePath);
  let stderr = "";
  const child = cp.spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  live.add(child);
  if (child.stderr) child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
  const cdp = cdpPipe(child);
  const lastLine = () => (stderr ? ": " + stderr.trim().split("\n").pop().slice(0, 200) : "");

  let closing = null;
  const browser = {
    chromePath, child, profile, headlessShell: isHeadlessShell(chromePath),
    get alive() { return !cdp.closed; },
    exited: cdp.whenClosed,
    send: (method, params, sessionId) => cdp.send(method, params, sessionId),
    on: (fn) => cdp.on(fn),
    close() {
      if (closing) return closing;
      closing = new Promise((resolve) => {
        let settled = false;
        const settleUp = () => {
          if (settled) return; settled = true;
          live.delete(child); removeProfile(profile);
          cdp.fail(Object.assign(new Error("the browser was closed"), { code: "browser_closed" }));
          resolve();
        };
        if (child.exitCode !== null || child.signalCode !== null) return settleUp();
        child.once("exit", () => setTimeout(settleUp, 40));
        killTree(child);
        setTimeout(settleUp, 2000).unref();
      });
      return closing;
    },
  };
  child.on("error", (e) => cdp.fail(Object.assign(new Error(`could not start the browser: ${e.message}`), { code: "chrome_spawn_failed" })));
  child.on("exit", (code, signal) => {
    if (!closing) cdp.fail(Object.assign(new Error(`the browser exited (${signal || "code " + code})${lastLine()}`), { code: "browser_exited" }));
    live.delete(child);
  });

  // the browser is ready once it answers its first command; a browser that never answers is killed
  let timer;
  const ready = Promise.race([
    cdp.send("Browser.getVersion").then(() => browser),
    cdp.whenClosed.then((err) => { throw err; }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`the browser did not start within ${Math.round(startTimeoutMs / 1000)}s`), { code: "chrome_timeout" })), startTimeoutMs); }),
  ]);
  return ready.then((b) => { clearTimeout(timer); return b; }, (e) => { clearTimeout(timer); return browser.close().then(() => { throw e; }); });
}

/* ---------- post-capture sanity check: flat blocks in the corners ---------- */
/*
 * A raster tile the browser had not painted yet shows up in a screenshot as a flat rectangle of one single
 * colour (the page background) that starts exactly in a corner: 63x79 px bottom right on a 1080x1350 slide
 * is the classic one. flatCornerBlocks finds such rectangles; cornerCheck decides whether one is a defect.
 */
const CORNER_MIN = 16;      // px: smaller flat runs are ordinary page content
const MAX_CAPTURES = 3;
const CORNERS = [["top-left", 0, 0], ["top-right", 1, 0], ["bottom-left", 0, 1], ["bottom-right", 1, 1]];

function hexColour(r, g, b) { return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""); }

/* img: { width, height, rgb } (packed RGB, as decodePng returns). Returns [{ corner, where, x, y, w, h, colour }]. */
function flatCornerBlocks(img, min = CORNER_MIN) {
  const W = img.width, H = img.height, rgb = img.rgb, blocks = [], seen = new Set();
  for (const [corner, right, bottom] of CORNERS) {
    const cx = right ? W - 1 : 0, cy = bottom ? H - 1 : 0, sx = right ? -1 : 1, sy = bottom ? -1 : 1;
    const p0 = (cy * W + cx) * 3, r = rgb[p0], g = rgb[p0 + 1], b = rgb[p0 + 2];
    // widest same-colour run on each row, walking inward from the corner; keep the largest rectangle
    let limit = W, best = null;
    for (let j = 0; j < H; j++) {
      const row = (cy + sy * j) * W + cx;
      let run = 0;
      while (run < limit) {
        const p = (row + sx * run) * 3;
        if (rgb[p] !== r || rgb[p + 1] !== g || rgb[p + 2] !== b) break;
        run++;
      }
      if (run < min) break;
      limit = run;
      if (j + 1 >= min && (!best || limit * (j + 1) > best.w * best.h)) best = { w: limit, h: j + 1 };
    }
    if (!best) continue;
    const where = best.w === W && best.h === H ? "over the whole image" : best.w === W ? `along the ${bottom ? "bottom" : "top"} edge`
      : best.h === H ? `along the ${right ? "right" : "left"} edge` : `in the ${corner} corner`;
    const block = { corner, where, x: right ? W - best.w : 0, y: bottom ? H - best.h : 0, w: best.w, h: best.h, colour: hexColour(r, g, b) };
    const key = [block.x, block.y, block.w, block.h].join(",");
    if (!seen.has(key)) { seen.add(key); blocks.push(block); }
  }
  return blocks;
}

function sameRegion(a, b, k) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let y = k.y; y < k.y + k.h; y++) {
    const from = (y * a.width + k.x) * 3, to = from + k.w * 3;
    if (a.rgb.compare(b.rgb, from, to, from, to) !== 0) return false;
  }
  return true;
}

function describeBlock(k, compared) {
  return `capture defect: flat ${k.w}x${k.h} block of ${k.colour} ${k.where}` +
    (compared ? ", not the same in a second capture of the page (unpainted region)" : " (possible unpainted region)");
}

function toImage(png) { return png && png.rgb && png.width ? png : decodePng(png); }

/*
 * cornerCheck(capture, second?) -> { ok, issues, blocks }
 * capture and second are PNGs (path, Buffer, or an already decoded { width, height, rgb }).
 * Without a second capture every flat corner block is reported. With one, a block that is pixel for pixel the
 * same in both is page content (a solid panel, a plain background) and passes; a block that differs was never
 * on the page and fails.
 */
function cornerCheck(capture, second) {
  let a, b = null;
  try { a = toImage(capture); if (second !== undefined && second !== null) b = toImage(second); }
  catch (e) { return { ok: false, issues: [`capture could not be checked: ${e.message}`], blocks: [] }; }
  const blocks = flatCornerBlocks(a);
  const bad = b ? blocks.filter((k) => !sameRegion(a, b, k)) : blocks;
  return { ok: bad.length === 0, issues: bad.map((k) => describeBlock(k, !!b)), blocks };
}

/* Runs in the page before every capture: fonts loaded, images decoded, then two animation frames. */
const PAINT_READY = `(async () => {
  const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  if (document.fonts && document.fonts.ready) await cap(document.fonts.ready, 5000);
  await cap(Promise.all(Array.from(document.images).map((i) => (i.decode ? i.decode().catch(() => {}) : null))), 5000);
  await cap(new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), 2000);
  return { w: window.innerWidth, h: window.innerHeight, scale: window.devicePixelRatio };
})()`;

/*
 * One headless screenshot in its own tab. Pass `browser` (from launchBrowser) to reuse a running browser: that is
 * what a batch does, one process for every slide. Without it, a browser is launched for this capture alone and
 * closed afterwards (fine for a one-off; a batch of those trips the launch guard).
 *
 * Why not `--screenshot`: a headless window of WxH has a viewport that is shorter than H (the window frame
 * takes its share: 87 px on macOS), while the screenshot still covers WxH. The strip below the viewport is
 * outside what the compositor must paint before a frame, so under load its raster tiles could be captured
 * unpainted: a flat block of the page background in the bottom right corner. Here the viewport is set to
 * exactly WxH before the page loads, the capture waits for fonts, images and two animation frames, the clip is
 * explicit, and the result is checked (cornerCheck) and captured again when a corner looks unpainted.
 *
 * Resolves { out, viewport: { w, h, scale }, captures, cornerCheck: { ok, issues } }. Rejects with an Error carrying
 * `code` (chrome_timeout, browser_exited, cdp_error, viewport_mismatch, ...); the timeout is per capture, and when
 * the shared browser dies every capture still running or still to come rejects at once instead of hanging.
 * `settle` (optional promise, for example "the page posted its QA result") is awaited after the load event for
 * at most settleMs. `virtualTime` is accepted for older callers and ignored: the capture follows real page events.
 */
async function chromeScreenshot({ browser, chromePath, url, out, width, height, virtualTime, timeoutMs = 60000, settle, settleMs = 3000, checkCorners = true }) {
  const own = !browser;
  if (own) browser = await launchBrowser({ chromePath, width, height });
  const timers = new Set();
  let timedOut = null, targetId = null;
  const pause = (ms) => new Promise((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, ms); timers.add(t); });
  const clock = new Promise((_, reject) => {
    const t = setTimeout(() => { timedOut = Object.assign(new Error(`browser timed out after ${Math.round(timeoutMs / 1000)}s`), { code: "chrome_timeout" }); reject(timedOut); }, timeoutMs);
    timers.add(t);
  });
  // every wait races the capture clock and the life of the browser, so nothing here can hang
  const guard = (p) => Promise.race([p, clock, browser.exited.then((e) => { throw e; })]);
  const send = (method, params, sessionId) => guard(browser.send(method, params, sessionId));

  const drive = async () => {
    targetId = (await send("Target.createTarget", { url: "about:blank", width, height })).targetId;
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);

    // the viewport is the slide, whatever the window frame takes
    await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page("Page.enable");
    let off = () => {};
    const loaded = new Promise((r) => { off = browser.on((m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") r(); }); });
    try {
      const nav = await page("Page.navigate", { url });
      if (nav.errorText) throw Object.assign(new Error(`the page did not load: ${nav.errorText}`), { code: "page_load_failed" });
      await guard(loaded);
    } finally { off(); }
    if (settle) await guard(Promise.race([Promise.resolve(settle).catch(() => {}), pause(settleMs)]));

    const ready = async () => {
      const r = await page("Runtime.evaluate", { expression: PAINT_READY, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails || !r.result || !r.result.value) throw Object.assign(new Error("the page could not be prepared for capture"), { code: "capture_failed" });
      return r.result.value;
    };
    const shoot = async () => {
      const r = await page("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false });
      return Buffer.from(r.data, "base64");
    };

    const viewport = await ready();
    if (viewport.w < width || viewport.h < height || viewport.scale !== 1) {
      throw Object.assign(new Error(`browser viewport is ${viewport.w}x${viewport.h} at scale ${viewport.scale}, expected ${width}x${height} at scale 1`), { code: "viewport_mismatch" });
    }
    let png = await shoot(), captures = 1, check = { ok: true, issues: [] };
    if (checkCorners) {
      try {
        let img = decodePng(png), blocks = flatCornerBlocks(img);
        while (blocks.length && captures < MAX_CAPTURES) {
          // give late paint real time, then capture again and compare the suspect corners
          await guard(pause(250)); await ready();
          const png2 = await shoot(), img2 = decodePng(png2);
          captures++;
          const before = img;
          if (blocks.every((k) => sameRegion(before, img2, k))) { blocks = []; break; }   // same pixels twice: page content
          png = png2; img = img2; blocks = flatCornerBlocks(img);                            // the earlier capture was unpainted there
        }
        if (blocks.length) check = { ok: false, issues: blocks.map((k) => describeBlock(k, true)) };
      } catch (e) {
        if (e && (e.code === "cdp_error" || e.code === "cdp_closed" || e.code === "capture_failed" || e === timedOut || !browser.alive)) throw e;
        check = { ok: false, issues: [`capture could not be checked: ${e.message}`] };
      }
    }
    fs.writeFileSync(out, png);
    return { out, viewport, captures, cornerCheck: check };
  };

  try {
    return await guard(drive());
  } finally {
    for (const t of timers) clearTimeout(t);
    // free the tab's memory right away; the process itself belongs to the batch
    if (targetId && browser.alive && !own) await Promise.race([browser.send("Target.closeTarget", { targetId }).catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref())]);
    if (own) await browser.close();
  }
}

function dataDirFrom(dataDir) {
  return path.resolve(dataDir || process.env.CAROUSEL_HOME || path.join(process.cwd(), ".carousel"));
}

function fail(code, issues, extra) {
  return Object.assign({ ok: false, files: [], qa: { ok: false, issues }, error: code }, extra || {});
}

/*
 * Options: outDir (default <data dir>/exports/<timestamp>), brand (object; default is the configured brand),
 * size (portrait | square | story; default deck.size, then portrait), chromePath (default findChrome()),
 * baseDir (folder that relative image paths in the deck resolve against; default the current directory),
 * dataDir (default CAROUSEL_HOME or ./.carousel).
 * The render runs in a child node process (render.mjs), which launches exactly one browser for the whole deck.
 */
async function renderDeck(deck, opts) {
  const o = opts || {};
  const check = validateDeck(deck);
  if (!check.ok) return fail("invalid_deck", check.errors, { warnings: check.warnings });

  const size = o.size || deck.size || DEFAULT_SIZE;
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) return fail("invalid_size", [`size: expected one of ${Object.keys(SIZES).join(", ")}`], { warnings: check.warnings });

  const chromePath = o.chromePath || findChrome();
  if (!chromePath || !isRunnable(chromePath)) {
    return fail("chrome_not_found", ["No Chrome, Chromium or Edge found. Install one, or set CHROME_BIN to its binary."], { warnings: check.warnings });
  }

  // data dir: the option, else the folder the brand's brand.json was loaded from, else the default
  const brandHome = o.brand && typeof o.brand.source === "string" && path.basename(o.brand.source) === "brand.json" ? path.dirname(o.brand.source) : null;
  const dataDir = dataDirFrom(o.dataDir || brandHome);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const outDir = path.resolve(o.outDir || path.join(dataDir, "exports", stamp));
  const baseDir = path.resolve(o.baseDir || process.cwd());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carousel-deck-"));
  const started = Date.now();
  try {
    const deckFile = path.join(tmp, "deck.json");
    const resultFile = path.join(tmp, "result.json");
    fs.writeFileSync(deckFile, JSON.stringify(deck));
    const args = [RENDER_MJS, "--deck", deckFile, "--out-dir", outDir, "--size", size, "--base-dir", baseDir, "--data-dir", dataDir, "--result", resultFile];
    if (o.brand) {
      const brand = o.brand.colors && o.brand.fonts && o.brand.chrome ? o.brand : normalizeBrand(o.brand, baseDir);
      const brandFile = path.join(tmp, "brand.json");
      fs.writeFileSync(brandFile, JSON.stringify(brand));
      args.push("--brand", brandFile);
    }
    const run = await new Promise((resolve) => {
      let stderr = "";
      const child = cp.spawn(process.execPath, args, { cwd: ROOT, env: Object.assign({}, process.env, { CHROME_BIN: chromePath }), stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (d) => { if (stderr.length < 8000) stderr += d; });
      child.on("error", (e) => resolve({ code: -1, stderr: String(e.message) }));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch (e) { /* handled below */ }
    if (!result) {
      const last = run.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
      return fail("render_failed", [`render did not finish (exit ${run.code})${last ? ": " + last : ""}`], { warnings: check.warnings });
    }
    return {
      ok: result.ok === true,
      files: result.files || [],
      qa: { ok: result.ok === true, issues: (result.qa && result.qa.issues) || [] },
      slides: result.slides || [],
      warnings: check.warnings,
      size,
      outDir,
      ms: Date.now() - started,
      ...(result.ok ? {} : { error: result.error || "qa_failed" }),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  renderDeck, findChrome, chromeScreenshot, pngSize, pngComplete, cornerCheck, flatCornerBlocks,
  launchBrowser, browserArgs, headlessShellCandidates, appBundleCandidates, isHeadlessShell, launchGuard,
};
