"use strict";

// lib/ui-server.js: the local web server of the browser UI. It can publish to
// social accounts, so these tests are about what it refuses. Everything runs
// against 127.0.0.1 on a port picked by the system; nothing leaves the machine.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const { startUiServer, parseMultipart, CSP, MAX_JSON } = require("../lib/ui-server.js");
const { tmpDir, makePng } = require("./publish-helpers.js");

const PNG = makePng({ width: 8, height: 10, pixel: () => [200, 80, 40, 255] });
const DECK = { title: "Sell out by nine", slides: [{ layout: "01-editorial-statement", headline: "Bake to the *list*" }] };

// The session cookie each test server handed out, by port: sent on every call unless a
// test passes cookie: false to be a stranger.
const cookies = new Map();

// A raw request: the Host header, the path and the body go out exactly as given.
function call(port, { method = "GET", path: target = "/", headers = {}, body, host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const known = cookie === false ? null : cookie || cookies.get(port);
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers: { Host: host === undefined ? `127.0.0.1:${port}` : host, ...(known ? { Cookie: known } : {}), ...(payload ? { "Content-Length": payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buffer.toString("utf8"));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString("utf8"), json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function multipart(parts, boundary = "----carouseltest") {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"${part.filename ? `; filename="${part.filename}"` : ""}\r\nContent-Type: ${part.type || "application/octet-stream"}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

async function start(t, extra = {}) {
  const dataDir = tmpDir("carousel-ui-");
  const running = await startUiServer({ dataDir, env: {}, port: 0, fetchImpl: async () => { throw new Error("the network is off in tests"); }, ...extra });
  t.after(() => running.close());
  // The way in is the one-time link, exactly as the browser opened by the command uses it.
  const entry = await call(running.port, { path: running.openUrl.slice(running.url.length), cookie: false });
  assert.equal(entry.status, 303, entry.text);
  cookies.set(running.port, String(entry.headers["set-cookie"][0]).split(";")[0]);
  const page = await call(running.port, { path: "/" });
  const token = (/<meta name="carousel-token" content="([^"]+)">/.exec(page.text) || [])[1];
  const json = (name, body, headers = {}, method = "POST") => call(running.port, { method, path: `/api/${name}`, headers: { "Content-Type": "application/json", "X-Carousel-Token": token, ...headers }, body: JSON.stringify(body) });
  return { ...running, dataDir, token, page, json, entry };
}

test("the page is served with the session token and the security headers, and no CORS header", async (t) => {
  const ui = await start(t);
  assert.equal(ui.url, `http://127.0.0.1:${ui.port}`);
  assert.equal(ui.server.address().address, "127.0.0.1", "it listens on the loopback address only");
  assert.equal(ui.page.status, 200);
  assert.match(ui.page.headers["content-type"], /^text\/html/);
  assert.equal(ui.page.headers["content-security-policy"], CSP);
  assert.equal(CSP, "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  assert.equal(ui.page.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(ui.page.headers["x-content-type-options"], "nosniff");
  assert.equal(ui.page.headers["referrer-policy"], "no-referrer");
  assert.equal(ui.page.headers["cache-control"], "no-store");
  assert.match(ui.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(!ui.page.text.includes("{{CAROUSEL_TOKEN}}"));

  const other = await start(t);
  assert.notEqual(other.token, ui.token, "every run has its own token");

  for (const target of ["/app.js", "/style.css", "/js/state.js", "/favicon.svg", "/api/schema"]) {
    const reply = await call(ui.port, { path: target });
    assert.equal(reply.status, 200, target);
    assert.equal(reply.headers["content-security-policy"], CSP, target);
    assert.equal(reply.headers["x-content-type-options"], "nosniff", target);
    for (const name of Object.keys(reply.headers)) assert.ok(!name.startsWith("access-control-"), `${target} sends no CORS header`);
  }
  assert.match((await call(ui.port, { path: "/app.js" })).headers["content-type"], /^text\/javascript/);
  assert.match((await call(ui.port, { path: "/style.css" })).headers["content-type"], /^text\/css/);
  const head = await call(ui.port, { method: "HEAD", path: "/" });
  assert.equal(head.status, 200);
  assert.equal(head.buffer.length, 0);
});

test("a request whose Host header is not this server is refused (DNS rebinding)", async (t) => {
  const ui = await start(t);
  for (const host of ["evil.example", `evil.example:${ui.port}`, `127.0.0.1:${ui.port + 1}`, "127.0.0.1", `127.0.0.1.evil.example:${ui.port}`, `localhost.evil.example:${ui.port}`]) {
    for (const target of ["/", "/api/schema", "/app.js"]) {
      const reply = await call(ui.port, { path: target, host });
      assert.equal(reply.status, 403, `${host} ${target}`);
      assert.ok(!reply.text.includes(ui.token));
    }
    const post = await call(ui.port, { method: "POST", path: "/api/drafts", host, headers: { "Content-Type": "application/json", "X-Carousel-Token": ui.token }, body: JSON.stringify({ deck: DECK }) });
    assert.equal(post.status, 403, `POST with ${host}`);
  }
  // No Host header at all (written by hand, since a normal client always sends one).
  for (const [request, expected] of [["GET / HTTP/1.0\r\n\r\n", /^HTTP\/1\.[01] 403 /], ["GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n", /^HTTP\/1\.1 40[03] /], ["GET /api/schema HTTP/1.1\r\n\r\n", /^HTTP\/1\.1 40[03] /]]) {
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect(ui.port, "127.0.0.1", () => socket.write(request));
      let text = "";
      socket.on("data", (chunk) => { text += chunk; });
      socket.on("end", () => resolve(text));
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
      setTimeout(() => socket.destroy(), 1500).unref();
    });
    assert.match(answer, expected, JSON.stringify(request));
    assert.ok(!answer.includes(ui.token));
  }
  assert.equal((await call(ui.port, { path: "/api/schema", host: `localhost:${ui.port}` })).status, 200);
  assert.equal((await call(ui.port, { path: "/api/schema", host: `LOCALHOST:${ui.port}` })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(ui.dataDir, "drafts")), []);
});

test("every request that changes something needs the session token", async (t) => {
  const ui = await start(t);
  const body = JSON.stringify({ deck: DECK });
  const type = { "Content-Type": "application/json" };
  const none = await call(ui.port, { method: "POST", path: "/api/drafts", headers: type, body });
  assert.equal(none.status, 403);
  assert.match(none.json.error, /session token/);
  for (const wrong of ["nope", ui.token.slice(0, -1), `${ui.token}x`, ui.token.toUpperCase() === ui.token ? ui.token.toLowerCase() : ui.token.toUpperCase(), "", "x".repeat(4000)]) {
    const reply = await call(ui.port, { method: "POST", path: "/api/drafts", headers: { ...type, "X-Carousel-Token": wrong }, body });
    assert.equal(reply.status, 403, `token ${wrong.slice(0, 12)}`);
  }
  // The token in the address or in the body is not the token in the header.
  assert.equal((await call(ui.port, { method: "POST", path: `/api/drafts?token=${ui.token}`, headers: type, body: JSON.stringify({ deck: DECK, token: ui.token }) })).status, 403);
  assert.equal((await call(ui.port, { method: "PUT", path: "/api/brand", headers: type, body: JSON.stringify({ name: "x" }) })).status, 403);
  assert.equal((await call(ui.port, { method: "POST", path: "/api/publish", headers: type, body: JSON.stringify({ id: "20260102-093000-a", targets: ["linkedin"], confirm: "PUBLISH" }) })).status, 403);
  assert.deepEqual(fs.readdirSync(path.join(ui.dataDir, "drafts")), [], "nothing was written without the token");
  assert.ok(!fs.existsSync(path.join(ui.dataDir, "brand.json")));

  const saved = await ui.json("drafts", { deck: DECK });
  assert.equal(saved.status, 200, saved.text);
  assert.match(saved.json.id, /sell-out-by-nine$/);
  assert.equal((await call(ui.port, { path: `/api/drafts?id=${saved.json.id}` })).json.deck.title, DECK.title, "reading needs no token");
  assert.equal((await ui.json("brand", { name: "Riverbend Bakery" }, {}, "PUT")).status, 200);

  // Methods outside the four are refused, and nothing can be changed outside /api.
  assert.equal((await call(ui.port, { method: "DELETE", path: "/api/drafts", headers: { "X-Carousel-Token": ui.token } })).status, 405);
  assert.equal((await call(ui.port, { method: "OPTIONS", path: "/api/drafts", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } })).status, 405);
  assert.equal((await call(ui.port, { method: "POST", path: "/index.html", headers: { ...type, "X-Carousel-Token": ui.token }, body: "{}" })).status, 405);
});

test("an Origin that is not this server is refused, even with the right token", async (t) => {
  const ui = await start(t);
  for (const origin of ["https://evil.example", `http://127.0.0.1:${ui.port + 1}`, `https://127.0.0.1:${ui.port}`, `http://localhost:${ui.port}`, "null"]) {
    const reply = await ui.json("drafts", { deck: DECK }, { Origin: origin });
    assert.equal(reply.status, 403, origin);
    assert.match(reply.json.error, /did not come from the Carousel Builder page/);
  }
  assert.equal((await ui.json("drafts", { deck: DECK }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.deepEqual(fs.readdirSync(path.join(ui.dataDir, "drafts")), []);
  assert.equal((await ui.json("drafts", { deck: DECK }, { Origin: `http://127.0.0.1:${ui.port}`, "Sec-Fetch-Site": "same-origin" })).status, 200);
  // The same page opened as localhost has the localhost origin.
  const local = await call(ui.port, { method: "POST", path: "/api/drafts", host: `localhost:${ui.port}`, headers: { "Content-Type": "application/json", "X-Carousel-Token": ui.token, Origin: `http://localhost:${ui.port}` }, body: JSON.stringify({ deck: DECK }) });
  assert.equal(local.status, 200);
  // Another site cannot read the API either.
  assert.equal((await call(ui.port, { path: "/api/drafts", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call(ui.port, { path: "/api/drafts", headers: { "Sec-Fetch-Site": "same-site" } })).status, 403);
  assert.equal((await call(ui.port, { path: "/api/drafts", headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
});

test("bodies are capped and content types are strict", async (t) => {
  const ui = await start(t);
  const big = JSON.stringify({ deck: DECK, pad: "x".repeat(MAX_JSON) });
  const tooBig = await ui.json("drafts", JSON.parse(big));
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.json.error, /2 MB/);
  // The same body without a declared length is counted as it streams.
  const streamed = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: ui.port, method: "POST", path: "/api/drafts", headers: { Host: `127.0.0.1:${ui.port}`, "Content-Type": "application/json", "X-Carousel-Token": ui.token, Cookie: cookies.get(ui.port), "Transfer-Encoding": "chunked" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", (error) => (error.code === "EPIPE" || error.code === "ECONNRESET" ? resolve(413) : reject(error)));
    for (let sent = 0; sent < big.length; sent += 256 * 1024) req.write(big.slice(sent, sent + 256 * 1024));
    req.end();
  });
  assert.equal(streamed, 413);
  assert.deepEqual(fs.readdirSync(path.join(ui.dataDir, "drafts")), []);

  const plain = await call(ui.port, { method: "POST", path: "/api/drafts", headers: { "Content-Type": "text/plain", "X-Carousel-Token": ui.token }, body: JSON.stringify({ deck: DECK }) });
  assert.equal(plain.status, 415);
  const form = await call(ui.port, { method: "POST", path: "/api/drafts", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Carousel-Token": ui.token }, body: "deck=1" });
  assert.equal(form.status, 415);
  const broken = await call(ui.port, { method: "POST", path: "/api/drafts", headers: { "Content-Type": "application/json", "X-Carousel-Token": ui.token }, body: "{not json" });
  assert.equal(broken.status, 400);
  assert.equal((await ui.json("drafts", ["a list"])).status, 400);
  assert.equal((await call(ui.port, { path: "/api/nope" })).status, 404);
  assert.equal((await call(ui.port, { path: "/api/__proto__" })).status, 404);
  assert.equal((await call(ui.port, { path: "/api/" })).status, 404);
});

test("static files come only from ui/: traversal and other file types are 404", async (t) => {
  const ui = await start(t);
  const escapes = [
    "/../lib/api.js", "/../../package.json", "/%2e%2e/lib/api.js", "/..%2flib%2fapi.js", "/js/../../package.json", "/js/%2e%2e/%2e%2e/package.json", "/js/..%2f..%2fpackage.json",
    "/..%5clib%5capi.js", "/%2e%2e%2f%2e%2e%2fREADME.md", "/....//lib/api.js", "//lib/api.js", "/js/../../lib/ui-server.js", "/app.js%00.html", "/%00", "/js", "/js/", "/missing.js",
    "/package.json", "/README.md", "/index.html.bak", "/.env", "/app.js/", "/%",
  ];
  for (const target of escapes) {
    const reply = await call(ui.port, { path: target });
    assert.ok(reply.status === 404 || reply.status === 400, `${target} -> ${reply.status}`);
    assert.ok(!reply.text.includes("createApi") && !reply.text.includes('"carousel-builder"'), `${target} leaked a file`);
  }
  // A link inside ui/ that points out of it is not followed.
  const uiDir = tmpDir("carousel-uidir-");
  fs.writeFileSync(path.join(uiDir, "index.html"), '<meta name="carousel-token" content="{{CAROUSEL_TOKEN}}">');
  const secret = path.join(tmpDir("carousel-secret-"), "secret.js");
  fs.writeFileSync(secret, "top secret");
  fs.symlinkSync(secret, path.join(uiDir, "leak.js"));
  const linked = await start(t, { uiDir });
  assert.equal((await call(linked.port, { path: "/" })).status, 200);
  assert.equal((await call(linked.port, { path: "/leak.js" })).status, 404);
});

test("an upload is checked by its first bytes and lands in the library under a safe name", async (t) => {
  const ui = await start(t);
  const send = (form, headers = {}) => call(ui.port, { method: "POST", path: "/api/images", headers: { "Content-Type": form.type, "X-Carousel-Token": ui.token, ...headers }, body: form.body });

  const fake = await send(multipart([{ field: "file", filename: "photo.png", type: "image/png", data: "<script>alert(1)</script> this is not an image" }]));
  assert.equal(fake.status, 415);
  assert.match(fake.json.error, /PNG, JPEG or WebP/);
  const svg = await send(multipart([{ field: "file", filename: "logo.svg", type: "image/svg+xml", data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }]));
  assert.equal(svg.status, 415);
  assert.deepEqual(fs.readdirSync(path.join(ui.dataDir, "library")), []);

  const good = await send(multipart([{ field: "file", filename: "../../../etc/My Photo.html", type: "text/html", data: PNG }]));
  assert.equal(good.status, 200, good.text);
  assert.match(good.json.name, /^my-photo-[0-9a-f]{8}\.png$/);
  assert.deepEqual(fs.readdirSync(path.join(ui.dataDir, "library")), [good.json.name]);
  assert.deepEqual(fs.readFileSync(path.join(ui.dataDir, "library", good.json.name)), PNG);
  const served = await call(ui.port, { path: good.json.thumb });
  assert.equal(served.status, 200);
  assert.equal(served.headers["content-type"], "image/png");
  assert.equal(served.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(served.buffer, PNG);

  assert.equal((await send(multipart([{ field: "other", filename: "a.png", data: PNG }]))).status, 400);
  assert.equal((await send(multipart([{ field: "file", filename: "a.png", data: PNG }, { field: "file", filename: "b.png", data: PNG }]))).status, 400);
  assert.equal((await send({ type: "multipart/form-data", body: Buffer.from("no boundary") })).status, 400);
  assert.equal((await send({ type: "multipart/form-data; boundary=x", body: Buffer.from("garbage") })).status, 400);
  // Uploads go to the image call only, and need the token like every other change.
  const elsewhere = multipart([{ field: "file", filename: "a.png", data: PNG }]);
  assert.equal((await call(ui.port, { method: "POST", path: "/api/drafts", headers: { "Content-Type": elsewhere.type, "X-Carousel-Token": ui.token }, body: elsewhere.body })).status, 415);
  assert.equal((await call(ui.port, { method: "POST", path: "/api/images", headers: { "Content-Type": elsewhere.type }, body: elsewhere.body })).status, 403);
  // An image larger than 15 MB is refused before it is kept.
  const huge = await send(multipart([{ field: "file", filename: "big.png", data: Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024 + 70 * 1024)]) }]));
  assert.equal(huge.status, 413);
  assert.equal(fs.readdirSync(path.join(ui.dataDir, "library")).length, 1);
});

test("parseMultipart reads the parts and rejects a broken body", () => {
  const form = multipart([{ field: "file", filename: "a.png", type: "image/png", data: PNG }, { field: "note", data: "hello\r\nworld" }], "abc123");
  const parts = parseMultipart(form.body, "abc123");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].data, PNG);
  assert.equal(parts[0].filename, "a.png");
  assert.equal(parts[0].contentType, "image/png");
  assert.equal(parts[1].data.toString(), "hello\r\nworld");
  assert.throws(() => parseMultipart(Buffer.from("--abc123\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nnever closed"), "abc123"));
  assert.throws(() => parseMultipart(Buffer.from("nothing here"), "abc123"));
});

test("publish through the server keeps the gate: a dry run first, and a wrong token is a 409", async (t) => {
  const ui = await start(t);
  const id = "20260102-093000-sell-out-by-nine";
  const dir = path.join(ui.dataDir, "exports", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "slide-01.png"), PNG);
  fs.writeFileSync(path.join(dir, "export.json"), JSON.stringify({ id, files: ["slide-01.png"], pdf: null, qa: { ok: true, issues: [] } }));
  const request = { id, targets: ["linkedin"], caption: "Hello" };
  const plan = await ui.json("publish", request);
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.dryRun, true);
  assert.equal(plan.json.results[0].wired, false);
  const mismatch = await ui.json("publish", { ...request, confirm: "PUBLISH", confirmToken: "0".repeat(64) });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.code, "confirm_token_mismatch");
  assert.equal(mismatch.json.confirmToken, plan.json.confirmToken);
  const unwired = await ui.json("publish", { ...request, confirm: "PUBLISH", confirmToken: plan.json.confirmToken });
  assert.equal(unwired.status, 409);
  assert.equal(unwired.json.results[0].status, "not_wired");
  const still = await ui.json("publish", { ...request, confirm: "PUBLISH", confirmToken: plan.json.confirmToken, dry_run: 1 });
  assert.equal(still.status, 200);
  assert.equal(still.json.dryRun, true);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("the default port walks from 4410 to 4430, and a port that was asked for is exact", async (t) => {
  const first = await startUiServer({ dataDir: tmpDir("carousel-ui-"), env: {} });
  t.after(() => first.close());
  const second = await startUiServer({ dataDir: tmpDir("carousel-ui-"), env: {} });
  t.after(() => second.close());
  assert.ok(first.port >= 4410 && first.port <= 4430, `first server on ${first.port}`);
  assert.ok(second.port > first.port && second.port <= 4430, `second server on ${second.port}`);

  const wanted = await freePort();
  const exact = await startUiServer({ dataDir: tmpDir("carousel-ui-"), env: {}, port: wanted });
  t.after(() => exact.close());
  assert.equal(exact.port, wanted);
  await assert.rejects(() => startUiServer({ dataDir: tmpDir("carousel-ui-"), env: {}, port: wanted }), new RegExp(`Port ${wanted} is already in use`));
  await assert.rejects(() => startUiServer({ dataDir: tmpDir("carousel-ui-"), env: {}, port: 80 }), /port must be/);
  await assert.rejects(() => startUiServer({ dataDir: tmpDir("carousel-ui-"), env: {}, port: 70000 }), /port must be/);
});

test("the page, the token and the API are only served after the one-time link from the terminal", async (t) => {
  const links = [];
  const dataDir = tmpDir("carousel-ui-");
  const running = await startUiServer({ dataDir, env: {}, port: 0, linkEveryMs: 0, onLink: (link) => links.push(link) });
  t.after(() => running.close());
  const stranger = (target, extra = {}) => call(running.port, { path: target, cookie: false, ...extra });
  assert.match(running.openUrl, new RegExp(`^http://127\\.0\\.0\\.1:${running.port}/\\?k=[A-Za-z0-9_-]{40,}$`));
  assert.equal(running.url, `http://127.0.0.1:${running.port}`);

  // A stranger (any other local program) gets a page that says where to start, and nothing else.
  const gate = await stranger("/");
  assert.equal(gate.status, 401);
  assert.match(gate.text, /opens from the terminal/);
  assert.ok(!gate.text.includes("carousel-token"));
  assert.equal(gate.headers["cache-control"], "no-store");
  for (const target of ["/index.html", "/api/schema", "/api/drafts", "/api/brand", "/app.js", "/style.css", "/api/export"]) {
    const reply = await stranger(target);
    assert.equal(reply.status, 401, target);
    assert.ok(!reply.text.includes("carousel-token") && !reply.text.includes("createApi"), target);
  }
  const write = await stranger("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json", "X-Carousel-Token": "guess" }, body: JSON.stringify({ deck: DECK }) });
  assert.equal(write.status, 401);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "drafts")), []);
  assert.equal(links.length, 0, "a link is waiting, so no new one is printed");

  // A wrong key is refused and does not use up the real one.
  assert.equal((await stranger("/?k=wrong")).status, 403);
  assert.equal((await stranger(`/?k=${"A".repeat(43)}`)).status, 403);
  assert.equal((await stranger("/", { cookie: `carousel_session_${running.port}=guess` })).status, 401);

  // The real key works once: it sets the session cookie and sends the browser to the page.
  const key = running.openUrl.slice(running.url.length);
  const entry = await stranger(key);
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.location, "/");
  const setCookie = String(entry.headers["set-cookie"][0]);
  assert.match(setCookie, new RegExp(`^carousel_session_${running.port}=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=/$`));
  const cookie = setCookie.split(";")[0];
  const again = await stranger(key);
  assert.equal(again.status, 403, "the key was used up");
  assert.ok(!again.headers["set-cookie"]);

  const page = await stranger("/", { cookie });
  assert.equal(page.status, 200);
  const token = (/<meta name="carousel-token" content="([^"]+)">/.exec(page.text) || [])[1];
  assert.ok(token && token !== cookie.split("=")[1], "the token is not the cookie");
  assert.equal((await stranger("/api/schema", { cookie })).status, 200);
  // The cookie alone changes nothing: the token header is still needed, and the other way round.
  assert.equal((await stranger("/api/drafts", { cookie, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deck: DECK }) })).status, 403);
  assert.equal((await stranger("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json", "X-Carousel-Token": token }, body: JSON.stringify({ deck: DECK }) })).status, 401);
  assert.equal((await stranger("/api/drafts", { cookie, method: "POST", headers: { "Content-Type": "application/json", "X-Carousel-Token": token }, body: JSON.stringify({ deck: DECK }) })).status, 200);
  // A used link in a browser that is already in just goes to the page.
  assert.equal((await stranger(key, { cookie })).status, 303);

  // A second browser turns up: the terminal gets a fresh one-time link, which works.
  assert.equal((await stranger("/")).status, 401);
  assert.equal(links.length, 1);
  assert.notEqual(links[0], running.openUrl);
  await stranger("/");
  assert.equal(links.length, 1, "one link at a time");
  const second = await stranger(links[0].slice(running.url.length));
  assert.equal(second.status, 303);
  assert.equal(String(second.headers["set-cookie"][0]).split(";")[0], cookie, "the same session for this run");
});

test("reads of the API are refused when the browser says they come from somewhere else", async (t) => {
  const ui = await start(t);
  const own = `http://127.0.0.1:${ui.port}`;
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Referer: "https://evil.example/page" }, { Referer: `${own}.evil.example/` }, { Referer: `http://127.0.0.1:${ui.port + 1}/` }, { "Sec-Fetch-Site": "cross-site" }]) {
    for (const target of ["/api/schema", "/api/doctor", `/api/export?id=20260102-093000-a&format=pdf`]) {
      assert.equal((await call(ui.port, { path: target, headers })).status, 403, `${target} ${JSON.stringify(headers)}`);
    }
  }
  for (const headers of [{ Origin: own }, { Referer: `${own}/` }, { Referer: own }, { Referer: `${own}/#draft=x`, "Sec-Fetch-Site": "same-origin" }]) {
    assert.equal((await call(ui.port, { path: "/api/schema", headers })).status, 200, JSON.stringify(headers));
  }
  // Another spelling of a file name is not another way in (a file system that ignores case).
  for (const target of ["/INDEX.HTML", "/Index.html", "/APP.JS", "/JS/state.js"]) {
    const reply = await call(ui.port, { path: target });
    assert.equal(reply.status, 404, target);
    assert.ok(!reply.text.includes("CAROUSEL_TOKEN"));
  }
});

test("carousel ui prints the one-time link with --no-open, never the token, and stops on a signal", async () => {
  const { main } = require("../bin/carousel.js");
  const dataDir = tmpDir("carousel-ui-cli-");
  const wanted = await freePort();
  const stopper = new AbortController();
  let stdout = "";
  let stderr = "";
  let seen = null;
  const done = main(["ui", "--no-open", "--port", String(wanted), "--data", dataDir], {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    signal: stopper.signal,
    onListening: async (running) => {
      const link = (/Open this one-time link in your browser:\n {2}(http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+)\n/.exec(stdout) || [])[1];
      const gate = await call(running.port, { path: "/", cookie: false });
      const entry = link ? await call(running.port, { path: link.slice(running.url.length), cookie: false }) : { status: 0, headers: {} };
      const cookie = entry.headers["set-cookie"] ? String(entry.headers["set-cookie"][0]).split(";")[0] : "";
      const page = await call(running.port, { path: "/", cookie });
      seen = { port: running.port, link, gate: gate.status, entry: entry.status, status: page.status, token: (/carousel-token" content="([^"]+)"/.exec(page.text) || [])[1], cookie };
      stopper.abort();
    },
  });
  assert.equal(await done, 0, stderr);
  assert.equal(seen.port, wanted, "an explicit port is exact");
  assert.ok(seen.link, stdout);
  assert.equal(seen.gate, 401);
  assert.equal(seen.entry, 303);
  assert.equal(seen.status, 200);
  assert.match(stdout, new RegExp(`Carousel Builder is running at http://127\\.0\\.0\\.1:${wanted}\\n`));
  assert.match(stdout, /Stopped\.\n$/);
  assert.ok(seen.token && !stdout.includes(seen.token) && !stderr.includes(seen.token), "the token is never printed");
  assert.ok(!stdout.includes(seen.cookie.split("=")[1]), "the session cookie is never printed");
  await assert.rejects(() => call(wanted, { path: "/" }), /ECONNREFUSED|ECONNRESET|socket hang up/, "the server is gone");

  // A busy explicit port is an error with a clear message, not a move to another port.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  let busy = "";
  assert.equal(await main(["ui", "--no-open", "--port", String(blocker.address().port), "--data", dataDir], { stdout: () => {}, stderr: (text) => { busy += text; } }), 1);
  assert.match(busy, /is already in use/);
  await new Promise((resolve) => blocker.close(resolve));

  let usage = "";
  assert.equal(await main(["ui", "--port", "80"], { stdout: () => {}, stderr: (text) => { usage += text; } }), 1);
  assert.match(usage, /port is a number from 1024 to 65535/);
  assert.equal(await main(["ui", "--port", "abc"], { stdout: () => {}, stderr: () => {} }), 1);
});
