"use strict";

// The built-in browser UI: a small node:http server that serves the static
// files in ui/ and maps /api/<name> to lib/api.js. No dependencies.
//
//   startUiServer({ dataDir, env, fetchImpl, port }) -> Promise<{ url, port, close() }>
//
// This server can publish to social accounts, so it is locked down:
//   - it listens on 127.0.0.1 only;
//   - a request whose Host header is not 127.0.0.1:<port> or localhost:<port> is
//     refused, which stops a web page from reaching it through DNS rebinding;
//   - the page and the API are only served to the browser that was opened from
//     the terminal. `carousel ui` opens /?k=<one-time key>; the key works once,
//     sets an HttpOnly, SameSite=Strict session cookie and redirects to /. Any
//     other local program that asks gets a page that says to start from the
//     terminal, and nothing else;
//   - every request that changes something (anything but GET or HEAD) must also
//     carry the session token of this run in an X-Carousel-Token header. The
//     token is random, made at start, embedded in the served index.html, compared
//     in constant time and never written to a log. An Origin header, when
//     present, must be this server's own origin, on reads of the API too. No CORS
//     headers are ever sent;
//   - JSON bodies stop at 2 MB and uploads at 15 MB, counted while they stream;
//   - static files come only from ui/, by extension allowlist, and a path is
//     resolved and checked against that folder before it is opened;
//   - images are served through lib/api.js, which never leaves the data dir.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createApi, MAX_UPLOAD } = require("./api.js");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4410;
const LAST_PORT = 4430;
const MAX_JSON = 2 * 1024 * 1024;
const UPLOAD_ENVELOPE = 64 * 1024; // the multipart wrapper around a 15 MB file
const UI_DIR = path.resolve(__dirname, "..", "ui");
const TOKEN_HEADER = "x-carousel-token";
const TOKEN_PLACEHOLDER = "{{CAROUSEL_TOKEN}}";
const CSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const KEY_PARAM = "k";
const GATE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Carousel Builder</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080c14;color:#f0eeff;font:16px/1.6 system-ui,sans-serif}main{max-width:32rem;padding:24px}h1{font-size:24px;margin:0 0 12px}p{margin:0 0 12px;color:#d2d5e8}code{font-family:ui-monospace,Menlo,monospace;color:#b8abe4}</style></head>
<body><main><h1>Carousel Builder</h1><p>This page opens from the terminal.</p><p>Go to the terminal where <code>carousel ui</code> is running and open the link it printed. Each link works once, and only in the browser that opens it. If the command is not running, start it again.</p></main></body></html>`;
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const BOUNDARY = /^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/;
const API_NAME = /^[a-z]{1,24}$/;
const STATIC_PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;

class RequestError extends Error {
  constructor(status, message, cut = false) {
    super(message);
    this.status = status;
    this.cut = cut; // true when the connection was dropped instead of being read to the end
  }
}

function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function mediaType(header) {
  return String(header || "").split(";")[0].trim().toLowerCase();
}

function boundaryOf(header) {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(header || ""));
  const value = match ? match[1] || match[2] : "";
  return BOUNDARY.test(value) ? value : null;
}

// Reads a request body, counting as it streams. Past the limit nothing more is
// kept: the rest is read and thrown away so the caller can be told 413, and a
// body that keeps coming far past the limit is cut off.
function readBody(req, limit, tooLarge) {
  return new Promise((resolve, reject) => {
    const cutOff = Math.max(limit * 4, 64 * 1024 * 1024);
    const chunks = [];
    let total = 0;
    let over = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) over = true;
    if (Number.isFinite(declared) && declared > cutOff) {
      finish(new RequestError(413, tooLarge, true));
      return;
    }
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        over = true;
        chunks.length = 0;
        if (total > cutOff) {
          finish(new RequestError(413, tooLarge, true));
        }
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => (over ? finish(new RequestError(413, tooLarge)) : finish(null, Buffer.concat(chunks, total))));
    req.on("error", () => finish(new RequestError(400, "The request could not be read.")));
    req.on("aborted", () => finish(new RequestError(400, "The request was cut off.")));
  });
}

// multipart/form-data -> [{ field, filename, contentType, data }]. Only what an
// image upload needs: a handful of parts, each with a Content-Disposition.
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  const bad = () => new RequestError(400, "The upload could not be read. Send one image as multipart form data.");
  const parts = [];
  let at = buffer.indexOf(delimiter);
  if (at !== 0 && at !== 2) throw bad();
  for (;;) {
    let start = at + delimiter.length;
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    if (buffer[start] !== 0x0d || buffer[start + 1] !== 0x0a) throw bad();
    start += 2;
    const end = buffer.indexOf(next, start);
    const headerEnd = buffer.indexOf("\r\n\r\n", start);
    if (end === -1 || headerEnd === -1 || headerEnd > end || headerEnd - start > 4096) throw bad();
    const head = buffer.subarray(start, headerEnd).toString("utf8");
    const disposition = /^content-disposition:\s*form-data\s*;(.*)$/im.exec(head);
    if (!disposition) throw bad();
    const field = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition[1]);
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition[1]);
    const type = /^content-type:\s*([^\r\n;]+)/im.exec(head);
    parts.push({ field: field ? field[1] : "", filename: filename ? filename[1] : "", contentType: type ? type[1].trim().toLowerCase() : "", data: Buffer.from(buffer.subarray(headerEnd + 4, end)) });
    if (parts.length > 8) throw bad();
    at = end + 2;
  }
  return parts;
}

function createUiServer(options = {}) {
  const env = options.env || process.env;
  const uiDir = path.resolve(options.uiDir || UI_DIR);
  // What went wrong inside the engine goes to the terminal, never to the page.
  const report = typeof options.onError === "function" ? options.onError : (error, name) => process.stderr.write(`carousel ui: ${name}: ${String((error && error.message) || error).split("\n")[0]}\n`);
  const api = options.api || createApi({ dataDir: options.dataDir, env, fetchImpl: options.fetchImpl, apiBase: "/api", templates: options.templates, onError: report });
  const digest = (text) => crypto.createHash("sha256").update(String(text)).digest();
  const same = (given, wanted) => typeof given === "string" && given.length > 0 && given.length <= 256 && crypto.timingSafeEqual(digest(given), wanted);
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenDigest = digest(token);
  const session = crypto.randomBytes(32).toString("base64url");
  const sessionDigest = digest(session);
  let port = 0;
  let bootKey = null; // digest of the one-time key that is waiting to be used, or null
  let lastMint = 0;
  const linkEvery = Number.isFinite(options.linkEveryMs) ? Number(options.linkEveryMs) : 5000; // new links are not printed faster than this

  const tokenMatches = (given) => same(given, tokenDigest);
  const cookieName = () => `carousel_session_${port}`;

  // A fresh one-time link. Only one is ever waiting; using it, or making another, ends it.
  function mintLink() {
    const key = crypto.randomBytes(32).toString("base64url");
    bootKey = digest(key);
    lastMint = Date.now();
    return `http://${HOST}:${port}/?${KEY_PARAM}=${key}`;
  }

  function hasSession(req) {
    const wanted = `${cookieName()}=`;
    for (const part of String(req.headers.cookie || "").split(";")) {
      const item = part.trim();
      if (item.startsWith(wanted)) return same(item.slice(wanted.length), sessionDigest);
    }
    return false;
  }

  function sendGate(req, res, status) {
    // Someone is at the door without a link: put a new one in the terminal (not too often).
    if (!bootKey && typeof options.onLink === "function" && Date.now() - lastMint >= linkEvery) options.onLink(mintLink());
    send(req, res, status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, GATE_PAGE);
  }

  function send(req, res, status, headers, body) {
    const payload = body === undefined || body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const all = securityHeaders({ ...headers, "Content-Length": String(payload.length) });
    res.writeHead(status, all);
    res.end(req.method === "HEAD" ? undefined : payload);
  }

  function sendJson(req, res, status, json, headers = {}) {
    send(req, res, status, { "Cache-Control": "no-store", ...headers, "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(json));
  }

  function sendError(req, res, status, message, headers = {}) {
    sendJson(req, res, status, { ok: false, error: message }, headers);
  }

  function serveStatic(req, res, pathname) {
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return sendError(req, res, 400, "That address is not valid.");
    }
    if (relative === "/") relative = "/index.html";
    // Plain names only: no dot files, no empty or dot segments, no trailing slash.
    if (!STATIC_PATH.test(relative)) return sendError(req, res, 404, "Not found.");
    const type = STATIC_TYPES[path.extname(relative).toLowerCase()];
    // Resolve first, then check: the result must still be inside ui/.
    const file = path.resolve(uiDir, `.${relative}`);
    if (!type || !file.startsWith(uiDir + path.sep)) return sendError(req, res, 404, "Not found.");
    let bytes;
    try {
      const realpath = typeof fs.realpathSync.native === "function" ? fs.realpathSync.native : fs.realpathSync;
      const real = realpath(file);
      // The real path is this exact file: no link out of ui/, and no other spelling of the
      // name (a file system that ignores case would otherwise answer to INDEX.HTML).
      if (real !== path.join(realpath(uiDir), relative) || !fs.statSync(real).isFile()) throw new Error("outside");
      bytes = fs.readFileSync(real);
    } catch {
      return sendError(req, res, 404, "Not found.");
    }
    if (path.basename(file) === "index.html") {
      // The page reads the session token from here and sends it back on every change.
      bytes = Buffer.from(bytes.toString("utf8").split(TOKEN_PLACEHOLDER).join(token));
      return send(req, res, 200, { "Content-Type": type, "Cache-Control": "no-store" }, bytes);
    }
    return send(req, res, 200, { "Content-Type": type, "Cache-Control": "no-cache" }, bytes);
  }

  async function serveApi(req, res, name, search) {
    const method = req.method;
    const query = {};
    for (const [key, value] of new URLSearchParams(search)) if (!(key in query)) query[key] = value;
    const input = { query };

    if (method !== "GET" && method !== "HEAD") {
      const type = mediaType(req.headers["content-type"]);
      if (type === "application/json") {
        const raw = await readBody(req, MAX_JSON, "That request is larger than 2 MB.");
        try {
          input.body = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new RequestError(400, "The request body must be JSON.");
        }
      } else if (type === "multipart/form-data" && name === "images" && method === "POST") {
        const boundary = boundaryOf(req.headers["content-type"]);
        if (!boundary) throw new RequestError(400, "The upload could not be read. Send one image as multipart form data.");
        const raw = await readBody(req, MAX_UPLOAD + UPLOAD_ENVELOPE, "That image is larger than 15 MB.");
        input.files = parseMultipart(raw, boundary).filter((part) => part.field === "file");
        if (input.files.length !== 1) throw new RequestError(400, "Attach one image as the form field named file.");
      } else {
        throw new RequestError(415, name === "images" ? "Send JSON, or one image as multipart form data." : "Send the request as application/json.");
      }
    }

    const result = await api.handle(name, method === "HEAD" ? "GET" : method, input);
    const headers = result.headers || {};
    if (result.buffer) return send(req, res, result.status, headers, result.buffer);
    return sendJson(req, res, result.status, result.json || { ok: result.status < 400 }, headers);
  }

  async function onRequest(req, res) {
    // 1. Only this machine, by its own name.
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return sendError(req, res, 403, "This server only answers on 127.0.0.1 and localhost.");
    }
    const origin = `http://${host}`;
    const method = req.method;
    if (!["GET", "HEAD", "POST", "PUT"].includes(method)) {
      req.resume();
      return sendError(req, res, 405, "That method is not supported.", { Allow: "GET, HEAD, POST, PUT" });
    }
    const url = String(req.url || "");
    if (!url.startsWith("/") || url.length > 4096) return sendError(req, res, 400, "That address is not valid.");
    const mark = url.indexOf("?");
    const pathname = mark === -1 ? url : url.slice(0, mark);
    const search = mark === -1 ? "" : url.slice(mark + 1);
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    const reading = method === "GET" || method === "HEAD";
    const signedIn = hasSession(req);

    // 2. The one-time link from the terminal: it works once, hands this browser the session
    //    cookie and sends it on to the page.
    if (reading && pathname === "/" && search) {
      const key = new URLSearchParams(search).get(KEY_PARAM);
      if (key !== null) {
        if (bootKey && same(key, bootKey)) {
          bootKey = null;
          return send(req, res, 303, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/` }, "");
        }
        if (signedIn) return send(req, res, 303, { Location: "/", "Cache-Control": "no-store" }, "");
        return sendGate(req, res, 403);
      }
    }

    // 3. Without the session cookie there is no page, no token and no API.
    if (!signedIn) {
      if (reading && !isApi && (pathname === "/" || pathname === "/index.html")) return sendGate(req, res, 401);
      req.resume();
      return sendError(req, res, 401, "Open the Carousel Builder from the link the carousel ui command printed in your terminal.", reading ? {} : { Connection: "close" });
    }

    // 4. Anything that changes state needs the session token and, when the browser says
    //    where the request came from, that must be this page.
    if (!reading) {
      const given = req.headers.origin;
      const refuse = (message) => {
        req.resume();
        return sendError(req, res, 403, message, { Connection: "close" });
      };
      if (given !== undefined && given !== origin) return refuse("This request did not come from the Carousel Builder page.");
      if (site && site !== "same-origin" && site !== "none") return refuse("This request did not come from the Carousel Builder page.");
      if (!tokenMatches(req.headers[TOKEN_HEADER])) return refuse("The session token is missing or wrong. Reload the Carousel Builder page and try again.");
      if (!isApi) {
        req.resume();
        return sendError(req, res, 405, "Nothing can be changed at that address.", { Allow: "GET, HEAD", Connection: "close" });
      }
    } else if (isApi) {
      // Another site has no business reading this API, even without a way to see the answer.
      const from = req.headers.origin;
      const referer = req.headers.referer;
      const foreign = (site && site !== "same-origin" && site !== "none") || (from !== undefined && from !== origin) || (referer !== undefined && referer !== origin && !String(referer).startsWith(`${origin}/`));
      if (foreign) return sendError(req, res, 403, "This request did not come from the Carousel Builder page.");
    }

    if (!isApi) return serveStatic(req, res, pathname);
    const name = pathname.slice("/api/".length);
    if (!API_NAME.test(name)) return sendError(req, res, 404, "There is no such API call.");
    try {
      return await serveApi(req, res, name, search);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message = error instanceof RequestError ? error.message : "The server hit an unexpected problem.";
      if (res.headersSent) return res.destroy();
      // A refused body may still be arriving: answer, let the rest drain, then hang up.
      if (error instanceof RequestError && error.cut) {
        // Far too large to read to the end: say so, then drop the connection.
        res.on("finish", () => req.destroy());
        return sendError(req, res, status, message, { Connection: "close" });
      }
      req.resume();
      return sendError(req, res, status, message, status === 413 ? { Connection: "close" } : {});
    }
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) sendError(req, res, 500, "The server hit an unexpected problem.");
      else res.destroy();
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.maxHeadersCount = 64;

  function listenOn(candidate) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: HOST, port: candidate, exclusive: true });
    });
  }

  async function start() {
    const explicit = !(options.port === undefined || options.port === null || options.port === "");
    const wanted = explicit ? Number(options.port) : DEFAULT_PORT;
    if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535 || (wanted !== 0 && wanted < 1024)) throw new Error("The port must be a whole number from 1024 to 65535.");
    if (!fs.existsSync(path.join(uiDir, "index.html"))) throw new Error("The browser UI files are missing (ui/index.html).");
    if (typeof api.dataDir === "function") api.dataDir(); // the data folder exists before the first request
    // A port that was asked for is used exactly. Only the default walks on, up to 4430.
    const last = explicit ? wanted : LAST_PORT;
    for (let candidate = wanted; candidate <= last; candidate += 1) {
      try {
        port = await listenOn(candidate);
        const url = `http://${HOST}:${port}`;
        return { url, openUrl: mintLink(), port, close, server };
      } catch (error) {
        if (!error || (error.code !== "EADDRINUSE" && error.code !== "EACCES")) throw error;
      }
    }
    if (explicit) throw new Error(`Port ${wanted} is already in use. Pick another one with --port, or leave --port out to use the first free port from ${DEFAULT_PORT} to ${LAST_PORT}.`);
    throw new Error(`No free port from ${DEFAULT_PORT} to ${LAST_PORT}. Close the program using one of them, or pass --port.`);
  }

  function close() {
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    });
  }

  return { start, close, server };
}

async function startUiServer(options = {}) {
  return createUiServer(options).start();
}

module.exports = { createUiServer, startUiServer, parseMultipart, DEFAULT_PORT, LAST_PORT, MAX_JSON, CSP, TOKEN_HEADER, HOST };
