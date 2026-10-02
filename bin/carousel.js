#!/usr/bin/env node
"use strict";

// carousel: command line front end for the carousel engine.
// Every command is a thin wrapper over a recipe, so the CLI, an agent and a
// UI all go through the same code and the same publish gate.

const path = require("node:path");

const RECIPES = path.join(__dirname, "..", "recipes");

const HELP = `carousel: build, export and publish social carousels

Usage:
  carousel draft "<brief>" [--slides n] [--size portrait|square|story] [--source file]
  carousel render <deck.json | draft id> [--out dir] [--size s]
  carousel images "<query>" [--count n] [--orientation o] [--generate] [--provider id]
  carousel publish <id | export dir> --to instagram,linkedin [--caption text | --caption-file f] [--title t]
  carousel publish <id | export dir> --to instagram,linkedin --confirm PUBLISH --confirm-token <token from the dry run>
  carousel list [--limit n]
  carousel status
  carousel doctor [--json]
  carousel export-meta <id> [--cta LEARN_MORE|SHOP_NOW|SIGN_UP|BOOK_NOW|GET_OFFER|CONTACT_US|SUBSCRIBE|DOWNLOAD]
  carousel templates [--json] [--previews] [--size s]
  carousel ui [--port n] [--no-open]

Global flags:
  --json        print the full result as JSON
  --data dir    use this data dir (default: $CAROUSEL_HOME, else ./.carousel)

Publishing takes two steps. Without --confirm it is a dry run: it shows
exactly what would be sent and prints a confirm token. To post, repeat the
command with --confirm PUBLISH and --confirm-token <token>. Add --dry-run to
any publish command and nothing is sent, whatever else is on the line.

carousel ui opens the builder in your browser, served from this machine only
(http://127.0.0.1:4410, or the next free port up to 4430; --port n uses exactly
that port). The page is served only to the browser opened with the one-time
link the command makes; --no-open prints that link. Press Ctrl+C to stop it.
Publishing from the page still shows the dry run first and waits for you to
press the final button.

A value that starts with "--" (a caption, say) is safest as --caption="--text".`;

const BOOLEAN_FLAGS = new Set(["json", "generate", "dry-run", "help", "no-render", "render", "no-open", "previews", "force"]);
// Flags that always take the next argument as their value, even when that
// value itself starts with "--".
const VALUE_FLAGS = new Set(["to", "caption", "caption-file", "title", "confirm", "confirm-token", "token", "out", "size", "slides", "source", "count", "orientation", "provider", "data", "limit", "port", "cta", "call-to-action"]);

// "--flag=value" on a switch: only "false" or "0" turns it off. Anything else
// (true, 1, yes, an empty value) leaves it on, so --dry-run=true is a dry run.
function switchValue(value) {
  return !["false", "0"].includes(String(value));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) flags[name] = BOOLEAN_FLAGS.has(name) ? switchValue(arg.slice(eq + 1)) : arg.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        if (i + 1 < argv.length) {
          flags[name] = argv[i + 1];
          i += 1;
        } else flags[name] = "";
      } else if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) flags[name] = true;
      else {
        flags[name] = argv[i + 1];
        i += 1;
      }
    } else if (arg === "-h") flags.help = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

function recipe(name) {
  return require(path.join(RECIPES, `${name}.js`));
}

// main(argv, io): io.stdout and io.stderr are optional writers (text) -> void,
// so the CLI can be driven in-process. They default to the real streams.
async function main(argv, io = {}) {
  const out = typeof io.stdout === "function" ? io.stdout : (text) => process.stdout.write(text);
  const err = typeof io.stderr === "function" ? io.stderr : (text) => process.stderr.write(text);
  const print = (result, flags) => out(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.reply}\n`);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const context = {};
  if (typeof flags.data === "string") context.dataDir = path.resolve(flags.data);

  if (!command || flags.help || command === "help") {
    out(`${HELP}\n`);
    return 0;
  }

  if (command === "doctor") {
    const engine = require(path.join(RECIPES, "_engine.js"));
    const report = engine.doctor(context);
    out(flags.json ? `${JSON.stringify(report, null, 2)}\n` : `${engine.doctorText(report)}\n`);
    return 0; // the doctor reports problems, it does not fail on them
  }

  if (command === "status") {
    print(await recipe("status").runRecipe({}, context), flags);
    return 0;
  }

  if (command === "list") {
    print(await recipe("list-carousels").runRecipe({ limit: flags.limit }, context), flags);
    return 0;
  }

  if (command === "draft") {
    const brief = positional.slice(1).join(" ").trim();
    let sourceText = "";
    if (typeof flags.source === "string") {
      try {
        sourceText = require("node:fs").readFileSync(path.resolve(flags.source), "utf8");
      } catch (error) {
        err(`Could not read --source: ${error.message}\n`);
        return 1;
      }
    }
    if (!brief && !sourceText) {
      err('Usage: carousel draft "<brief>" [--slides n] [--size s] [--source file]\n');
      return 1;
    }
    const result = await recipe("create-carousel").runRecipe({ brief, sourceText, slides: flags.slides, size: flags.size || "portrait", render: flags.render === true }, context);
    print(result, flags);
    return result.status === "ok" ? 0 : 1;
  }

  if (command === "render") {
    const ref = positional[1];
    if (!ref) {
      err("Usage: carousel render <deck.json | draft id> [--out dir] [--size s]\n");
      return 1;
    }
    const isFile = /\.json$/i.test(ref) || ref.includes(path.sep);
    // --out may point outside the data dir here only: the person at the
    // keyboard chose it. Such an export cannot be published afterwards.
    const result = await recipe("render-deck").runRecipe({ [isFile ? "deckPath" : "id"]: ref, outDir: typeof flags.out === "string" ? flags.out : "", size: typeof flags.size === "string" ? flags.size : "" }, { ...context, allowExternalOutDir: true });
    print(result, flags);
    return result.status === "ok" ? 0 : 1;
  }

  if (command === "images") {
    const query = positional.slice(1).join(" ").trim();
    if (!query) {
      err('Usage: carousel images "<query>" [--count n] [--orientation o] [--generate]\n');
      return 1;
    }
    const result = await recipe("find-backgrounds").runRecipe({ query, prompt: query, count: flags.count, orientation: flags.orientation || "portrait", generate: flags.generate === true, provider: typeof flags.provider === "string" ? flags.provider : "", size: flags.size || "portrait" }, context);
    if (flags.json) print(result, flags);
    else {
      out(`${result.reply}\n`);
      for (const item of (result.metadata && result.metadata.results) || []) out(`  ${item.src}${item.credit ? `  (${item.credit}${item.license ? `, ${item.license}` : ""})` : ""}\n`);
    }
    return result.status === "ok" ? 0 : 1;
  }

  if (command === "publish") {
    const ref = positional[1];
    if (!ref || typeof flags.to !== "string") {
      err("Usage: carousel publish <id | export dir> --to instagram,linkedin [--confirm PUBLISH --confirm-token <token>]\n");
      return 1;
    }
    const confirm = typeof flags.confirm === "string" ? flags.confirm : undefined;
    const token = typeof flags["confirm-token"] === "string" ? flags["confirm-token"] : typeof flags.token === "string" ? flags.token : undefined;
    const input = {
      exportDir: ref,
      targets: flags.to,
      title: typeof flags.title === "string" ? flags.title : "",
      confirm,
      confirmToken: token,
      // No --confirm at all means "show me": a dry run. --dry-run in any form
      // other than an explicit no is a dry run too. A wrong word is refused.
      dryRun: confirm === undefined ? true : flags["dry-run"] === undefined ? false : flags["dry-run"],
    };
    if (typeof flags.caption === "string") input.caption = flags.caption;
    if (typeof flags["caption-file"] === "string") input.captionFile = flags["caption-file"];
    const result = await recipe("publish-carousel").runRecipe(input, context);
    print(result, flags);
    if (result.status === "ok") return 0;
    return result.metadata && result.metadata.confirmationRequired ? 2 : 1;
  }

  if (command === "export-meta") {
    const ref = positional[1];
    if (!ref) {
      err("Usage: carousel export-meta <id> [--cta value]\n");
      return 1;
    }
    const cta = typeof flags.cta === "string" ? flags.cta : typeof flags["call-to-action"] === "string" ? flags["call-to-action"] : "";
    const result = await recipe("export-meta-carousel").runRecipe({ id: ref, callToAction: cta }, context);
    print(result, flags);
    return result.status === "ok" ? 0 : 1;
  }

  if (command === "templates") {
    const { createApi } = require(path.join(__dirname, "..", "lib", "api.js"));
    const api = createApi({ dataDir: context.dataDir });
    const size = typeof flags.size === "string" ? flags.size : "";
    const query = size ? { size } : {};
    let result = flags.previews === true ? await api.handle("templates", "POST", { body: { ...query, force: flags.force === true } }) : await api.handle("templates", "GET", { query });
    let note = "";
    if (flags.previews === true && result.status === 501) {
      // No preview builder in this install: still list the templates.
      note = result.json.error;
      result = await api.handle("templates", "GET", { query });
    }
    if (result.status !== 200) {
      err(`${(result.json && result.json.error) || "The templates could not be listed."}\n`);
      return 1;
    }
    const listed = result.json;
    let folder = null;
    if (flags.previews === true && !note) {
      const first = listed.templates.find((entry) => entry.preview);
      if (first) {
        const shot = await api.handle("templates", "GET", { query: { id: first.id, size: listed.size } });
        if (shot.status === 200) folder = previewFolder(api.dataDir(), first.id, listed.size);
      }
    }
    if (flags.json) {
      out(`${JSON.stringify({ size: listed.size, source: listed.source, previews: listed.previews, previewFolder: folder, note: note || null, groups: listed.groups, templates: listed.templates }, null, 2)}\n`);
      return 0;
    }
    for (const group of listed.groups) {
      const rows = listed.templates.filter((entry) => entry.group === group.id);
      if (!rows.length) continue;
      out(`${group.label}\n`);
      for (const row of rows) out(`  ${row.id.padEnd(26)} ${row.name}${row.supportsBackground ? " (takes a background)" : ""}\n  ${" ".repeat(26)} ${row.purpose}\n`);
    }
    if (flags.previews === true) out(note ? `${note}\n` : folder ? `Preview images (${listed.previews.ready} of ${listed.previews.total}, ${listed.size}): ${folder}\n` : "No preview images were built.\n");
    return 0;
  }

  if (command === "ui") {
    const { startUiServer } = require(path.join(__dirname, "..", "lib", "ui-server.js"));
    let port;
    if (flags.port !== undefined) {
      port = Number(flags.port);
      if (typeof flags.port !== "string" || !/^\d{1,5}$/.test(flags.port) || port < 1024 || port > 65535) {
        err("Usage: carousel ui [--port n] [--no-open]  (the port is a number from 1024 to 65535)\n");
        return 1;
      }
    }
    let running;
    try {
      // A browser that turns up without a link gets a new one printed here.
      running = await startUiServer({ dataDir: context.dataDir, port, onLink: (link) => out(`To open the Carousel Builder in another browser, use this one-time link:\n  ${link}\n`) });
    } catch (error) {
      err(`Could not start the browser UI: ${String((error && error.message) || error)}\n`);
      return 1;
    }
    const opening = flags["no-open"] !== true;
    out(`Carousel Builder is running at ${running.url}\nIt only answers on this machine. Press Ctrl+C to stop.\n`);
    // The page is only served to the browser that arrives with this link. It works once.
    if (opening) openBrowser(running.openUrl, err);
    else out(`Open this one-time link in your browser:\n  ${running.openUrl}\n`);
    if (typeof io.onListening === "function") io.onListening(running);
    // Runs until the process is told to stop (or the caller's signal fires).
    await new Promise((resolve) => {
      let done = false;
      const stop = () => {
        if (done) return;
        done = true;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        running.close().then(resolve, resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (io.signal && typeof io.signal.addEventListener === "function") {
        if (io.signal.aborted) stop();
        else io.signal.addEventListener("abort", stop, { once: true });
      }
    });
    out("Stopped.\n");
    return 0;
  }

  err(`Unknown command: ${command}\n\n${HELP}\n`);
  return 1;
}

// The folder that holds the template preview images, as lib/templates.js reports it.
function previewFolder(dataDir, id, size) {
  try {
    const templates = require(path.join(__dirname, "..", "lib", "templates.js"));
    const brand = require(path.join(__dirname, "..", "lib", "brand.js")).loadBrand(dataDir);
    const file = templates.previewPath({ dataDir, brand, size, id });
    return typeof file === "string" && file ? path.dirname(file) : null;
  } catch {
    return null;
  }
}

// Opens the default browser with the platform's own opener. execFile with an
// argument list, never a shell: the URL is data, not a command.
function openBrowser(url, err) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/\?k=[A-Za-z0-9_-]{20,}$/.test(url)) return;
  const { execFile } = require("node:child_process");
  const [file, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = execFile(file, args, { stdio: "ignore" }, (error) => {
      if (error) err(`Could not open your browser. Open this one-time link yourself:\n  ${url}\n`);
    });
    child.unref();
  } catch {
    err(`Could not open your browser. Open this one-time link yourself:\n  ${url}\n`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`carousel: ${String((err && err.message) || err)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, parseArgs };
