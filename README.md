# Carousel Builder

Turn a brief (or a post that already worked) into a branded, swipeable carousel: PNG slides, a PDF, a caption, and, when you say so, a post on Instagram, LinkedIn, Facebook or TikTok.

It is a headless engine with a command line, a browser UI and a set of recipes an agent can call. It runs on your machine, needs Node 18 or newer and a local Chrome, Chromium or Edge, and has zero npm dependencies.

The engine, the command line and the browser UI each work on their own. A host application is optional: it can call the same API (`lib/api.js`) from its own routes, but nothing here needs one.

What you get:

- Ten slide templates that work as one family (statement, photo cover, step, old way and new way, two by two, big number, bar chart, quote, list, call to action) in three sizes: portrait 1080x1350, square 1080x1080, story 1080x1920.
- One brand file that restyles every template: colours, fonts, logo, portrait, byline.
- A layout check on every render. Text that overflows, clips or leaves the safe area fails the render, and a failed export is never published.
- Copy drafting from a brief with your own model key, or a built-in keyless fallback.
- Background images through a chain of providers: your own library first, then free stock, then generators.
- Publishing behind a confirmation gate. Nothing is posted unless you pass the exact word `PUBLISH`.

## Use it in your browser

```bash
carousel ui                       # or: node bin/carousel.js ui
```

That starts the builder at `http://127.0.0.1:4410` (the next free port up to 4430 when that one is busy) and opens your browser with a one-time link. `--port n` uses exactly that port, and `--no-open` prints the one-time link for you to open yourself. Press Ctrl+C to stop it.

One screen does the whole job: describe the idea, edit the slides with a true preview of every render, pick a template from previews drawn in your brand, set your brand, add a background, export PNG and PDF, and publish. Work is saved as you go, and the address bar carries `#draft=<id>`, so a reload opens the same carousel.

It is a local tool and it stays local:

- It answers on `127.0.0.1` only, and only to requests addressed to `127.0.0.1` or `localhost` on its own port.
- The page and its API are served only to the browser that arrived with the one-time link from your terminal. The link works once and leaves a session cookie in that browser; any other program on the machine gets a page that says to start from the terminal. Opening the address in a second browser prints a fresh link in the terminal.
- Every change also needs a session token that is made new on each start and lives in the page, so another web site open in your browser cannot drive it.
- From the page, a logo or portrait is an upload or an https address. Fonts and the voice profile name files on your disk, so they are set in `brand.json` by hand.
- Publishing from the page is the same two steps as everywhere else: it shows the dry run first, and nothing is sent until you press the final button in that review.
- Model keys and platform credentials are read from the environment you start `carousel ui` from. The page never sees them.

## Quick start

```bash
git clone https://github.com/josephtandle/carousel-builder.git
cd carousel-builder
./install.sh                      # creates the data dir, copies example configs, links the `carousel` command
carousel doctor                   # what is ready, what is missing
carousel render examples/example-deck.json
```

The last command prints an id and a folder with `slide-01.png`, `slide-02.png`, ... and `carousel.pdf`.

From your own idea:

```bash
carousel draft "Three habits that keep a small bakery sold out" --slides 8
carousel render <id>              # the id printed by draft
carousel images "warm bakery counter morning light"
carousel publish <id> --to linkedin,instagram                    # dry run: shows what would be sent, prints a confirm token
carousel publish <id> --to linkedin,instagram --confirm PUBLISH --confirm-token <token>  # posts exactly that
carousel list                     # drafts, exports and where each one was published
```

Every command takes `--json` for the full result and `--data <dir>` to use another data dir.

| Command | What it does |
|---|---|
| `carousel draft "<brief>" [--slides n] [--size s] [--source file]` | Drafts a deck and saves it. `--source` turns an existing post or article into a carousel. |
| `carousel render <deck.json or id> [--out dir] [--size s]` | Renders PNG slides plus `carousel.pdf` and runs the layout check. |
| `carousel images "<query>" [--count n] [--orientation o] [--generate]` | Finds backgrounds through the provider chain, or generates one. |
| `carousel publish <id or export dir> --to a,b [--confirm PUBLISH --confirm-token t]` | Dry run by default. Posts only with `--confirm PUBLISH` and the token that dry run printed. |
| `carousel list` | Saved carousels and publish history. |
| `carousel status` | A plain language setup summary. |
| `carousel doctor [--json]` | Reports chrome, llm, each image provider, each publisher and codexSeat. |
| `carousel export-meta <id> [--cta value]` | Writes `meta-carousel.json` beside the slides: a Meta ads carousel handoff with three values left to fill in. Nothing is uploaded. |
| `carousel templates [--previews] [--size s]` | Lists the templates by group. `--previews` builds the preview images in your brand and prints their folder. |
| `carousel ui [--port n] [--no-open]` | Starts the browser UI on this machine. |

**Which browser renders.** One browser process renders a whole deck (every slide is a tab in it, closed after its capture), and a headless-only binary is preferred over a GUI app, so nothing flashes in the Dock. The search order is `CHROME_BIN` first; then `chrome-headless-shell` from Playwright's cache (`PLAYWRIGHT_BROWSERS_PATH`, else `~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright` or `%LOCALAPPDATA%\ms-playwright`, newest revision first) or Chrome for Testing's layout under Puppeteer's cache (`PUPPETEER_CACHE_DIR`, else `~/.cache/puppeteer`) or on `PATH`; then the Chrome, Chromium or Edge app bundles and the usual Linux binary names. Set `CAROUSEL_PREFER_APP_BUNDLE=1` to skip the headless shells and use the app bundle as before. `CAROUSEL_RENDER_CONCURRENCY` is how many tabs render at once, never how many browsers. If one process ever starts more than three browsers in ten seconds, the renderer logs one warning naming the cause and carries on.

## Where things live

The data dir is `$CAROUSEL_HOME`, or `.carousel` in the folder you run from.

```
<data dir>/
  brand.json  providers.json  publishers.json   your config (optional, the examples are the defaults)
  drafts/<id>.json                              saved decks
  exports/<id>/slide-01.png ... carousel.pdf    rendered slides, export.json, JPEG copies in jpeg/
  library/                                      your own background images
  logs/publish.jsonl                            every publish attempt, append only
  logs/doctor.jsonl                             every doctor run: expected against actual
  template-previews/<brand>-<size>/             one preview PNG per template, in your brand
```

Ids are a UTC timestamp plus a slug of the title, for example `20260304-050607-sell-out-by-nine`.

## The deck format

A deck is one JSON file. Each slide picks a layout and fills its fields.

```json
{
  "title": "Sell out by nine",
  "size": "portrait",
  "slides": [
    { "layout": "03-big-number-cover", "number": "38%", "unit": "of our weekend loaves are *ordered* ahead." },
    { "layout": "11-recap-list", "title": "Recap", "items": ["Post the menu Thursday", "Bake to the *list*"] }
  ],
  "caption": "Selling out is a plan, not a lucky morning.",
  "hashtags": ["#bakery"]
}
```

`*word*` is the accent style and `**word**` is bold. Six templates can take a `background` of `{ "src": "path or URL", "tint": 0.6 }`, where the tint keeps the text readable (see the table below). Image paths are relative to the deck file. `examples/` has complete decks, and `lib/deck-schema.js` lists the fields and word limits of each template.

## Templates

Each slide picks one template by its `layout` id. There are ten, built as one family: the same margins, one type scale, one spacing scale, and exactly one accent per slide (a word, a number, a lit bar or the keyword). Nothing else decorates a slide: no logo, byline, counter or progress bar unless you switch them on.

| Template | `layout` id | Use it when | Background image |
|---|---|---|---|
| Statement | `01-editorial-statement` | One bold line is the whole slide: your hook or your punchline. | yes |
| Photo cover | `02-face-claim-cover` | You open with a face or a photo and one short claim. | yes (it becomes the photo) |
| Step | `06-numbered-step` | You teach one step or make one point per slide. | yes |
| Old way, new way | `07-contrast-myth-truth` | You set a tired belief against the better one. | no |
| Two by two | `09-framework-2x2` | Four options sort on two questions and one of them wins. | no |
| Big number | `03-big-number-cover` | One number makes the case. | yes |
| Bar chart | `08-data-chart` | You compare two to four numbers, with the one that matters lit. | no |
| Quote | `04-tweet-card` | You have a customer's words, or one opinion in your own voice. | yes |
| List | `11-recap-list` | You recap the steps, or list up to six short points. | yes |
| Call to action | `10-cta-comment-keyword` | It is the last slide: one action and one word to comment. | no |

A carousel usually runs open, point, proof, close: a Statement or Photo cover first, Steps and a contrast in the middle, a number, chart or quote as proof, then the List and the Call to action. Drafting follows that arc: a hook first, the call to action last, and never the same template three times in a row.

`brand.json` restyles all ten at once: every colour and both fonts are variables the templates read, so changing the accent, the background or the headline font changes the whole deck and nothing in a deck file has to be touched.

Copy that runs long shrinks to fit, down to a floor that keeps it readable; copy that still cannot fit fails the layout check instead of being clipped. A short headline on the Statement or the Photo cover grows to fill the line.

For a picker, `lib/templates.js` exports `listTemplates()` (id, name, purpose, group, supportsBackground and a ready-made `sampleSlide` for each, in display order) and `renderTemplatePreviews({ dataDir, brand, size })`, which renders one preview PNG per template in your brand into `<data dir>/template-previews/` and reuses them until the brand changes.

Two older ids still work. A saved deck that uses `05-notes-app` renders as the List and `12-path-line` renders as the Step, each with a warning in the result and never an error.

## How the brand kit works

Copy `config/brand.example.json` to `<data dir>/brand.json` (the installer does this) and edit it. Every key is optional and anything you leave out keeps the neutral default.

- `colors`: `bg`, `bgDeep`, `bgAlt`, `text`, `accent`, `accentSoft`, `highlight`. These become CSS variables that every template reads, so one accent colour restyles the whole deck.
- `fonts`: a `display` and a `body` font, each a family name plus an optional font file. Two open fonts are bundled.
- `logo` and `portrait`: a path or an https URL. They are never defaulted: a slide shows them only when you set them.
- `byline`, `name`, `handle`: used on the call to action slide and by caption drafting.
- `chrome`: switches for the byline, slide counter, progress bar, swipe cue and corner marks.
- `voiceProfilePath`: a text file describing how you write. Caption drafting reads it when present.
- `defaultHashtags`: added to drafted captions.

## Copy drafting

`carousel draft` uses the first model key it finds in your environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`. With no key it still returns a valid deck from your brief using a deterministic fallback. Treat that fallback as a starting structure to edit, not finished copy.

## The image provider chain

`providers.json` holds an ordered chain. In `first-available` mode the engine walks the chain and stops at the first provider that returns results. In `ask` mode it returns the choices so you (or a UI) can pick.

| Order | Provider | Needs | Cost |
|---|---|---|---|
| 1 | `library` | images you put in `<data dir>/library/` | free |
| 2 | `pexels` | `PEXELS_API_KEY` | free key |
| 3 | `unsplash` | `UNSPLASH_ACCESS_KEY` | free key |
| 4 | `codex-imagegen` | a signed in Codex seat (experimental) | included with the seat |
| 5 | `openai-image` | `OPENAI_API_KEY` | billed per image |
| 6 | `huggingface` | `HF_TOKEN` | free credits, then billed |
| 7 | `whisk` | a sibling `whisk` module under `ALLSORTED_ROOT` | billed by its provider |
| 8 | `open-generative-ai` | a sibling `open-generative-ai` module under `ALLSORTED_ROOT` | billed by its provider |

Every result says which providers were tried and why each one was skipped, so a missing key never looks like "no results". Stock photo credits and licences come back with each result: put the credit in your caption.

## Publishing and the confirm gate

Publishing is irreversible and reaches a real audience, so it always takes two steps and the rules live in one place (`lib/publish/index.js`).

**Step 1: dry run.** Nothing is sent. Every target comes back as `dry_run` with a description of exactly what would be sent (endpoints, files, public URLs) and a `confirmToken`.

**Step 2: confirm.** Send the same request again with `confirm` set to exactly `PUBLISH` and the `confirmToken` from step 1.

```bash
carousel publish <id> --to linkedin,instagram
# ... shows what would be sent, then:
# To publish exactly this, call again with confirm: PUBLISH and confirmToken: 3f9a0c...
carousel publish <id> --to linkedin,instagram --confirm PUBLISH --confirm-token 3f9a0c...
```

The rules:

- **A dry run always wins.** Any `dryRun` (or `dry_run`) value other than absent, `false`, `"false"`, `0` or `""` is a dry run, so `1`, `"yes"` and `"True"` are all dry runs, even next to a valid confirmation. On the command line, no `--confirm` means a dry run, and `--dry-run`, `--dry-run=true` or `--dry-run=1` force one.
- **The word is exact.** `confirm` must be the string `PUBLISH`: no trimming, no lists, no other types. Without it every target is `refused`.
- **The token binds the confirmation to what you saw.** It is a hash of the slides (their bytes), the PDF, the caption, the title and the target list. If any of those change after the dry run (another target added, a caption swapped, a slide re-rendered) the token no longer fits and the publish is `refused`, with the new description and the new token, so you can look again and confirm again.
- **Only checked exports go out.** The slides must sit inside the data dir, in a folder whose `export.json` lists them by plain file name and records a passed layout check (`qa.ok` is `true`). A missing or unreadable manifest, a failed check, an absolute or `../` path in the manifest, a symlink, or a file larger than the limits blocks the publish. Publish takes an export id or a folder inside the data dir, nothing else. A render sent elsewhere with `--out` can be viewed and shared by hand but not published.
- **A caption file must be inside the data dir** (a regular file up to 64 KB). Anywhere else is refused, because a caption is public.
- **A target that is missing credentials or a media host returns `not_wired`** with the reason.
- **Every attempt is logged**, including refusals and dry runs, in `logs/publish.jsonl`.

Result statuses:

| Status | Meaning |
|---|---|
| `dry_run` | Nothing sent. `detail` and `steps` describe what would be; `confirmToken` is the token to confirm with. |
| `refused` | Nothing sent: no `PUBLISH`, or a missing or stale `confirmToken`. |
| `not_wired` | Nothing sent: credentials, media host or config missing. |
| `published` | The platform confirmed the post. `url` is set when the platform returns one. |
| `error` | The platform rejected a call, or a local check failed. The detail says whether anything went out. |
| `unknown` | The final "create the post" call got no answer or a server error. The post may or may not be live. Check the account before retrying: the engine never retries by itself, because a blind retry can post twice. |
| `processing` | TikTok accepted the post but had not finished it when the engine stopped polling. Check the app before retrying. |

Credentials are read only from environment variables. The engine never opens a `.env` file and never writes a token to disk, to the log or into a result. Tokens are sent in an `Authorization` header, never in a URL, only to the platform's own API host (the host is a fixed allowlist, not a setting), and never across a redirect.

A caption or title that starts with `--` is safest written as `--caption="--like this"`.

### Public URLs (Instagram and TikTok)

Instagram and TikTok do not accept uploads from this kind of app: they pull each image from a public https URL. Set a media host in `publishers.json`:

```json
{ "mediaHost": { "kind": "url-prefix", "urlPrefix": "https://media.example.com/carousels" } }
```

With `url-prefix` the engine uploads nothing. You sync your `exports/` folder to that address (object storage, a static site, any host you control) and the engine maps `exports/<id>/jpeg/slide-01.jpg` to `https://media.example.com/carousels/<id>/jpeg/slide-01.jpg`. Both platforms only take JPEG, so the engine writes JPEG copies into `exports/<id>/jpeg/` during the dry run. The order is: dry run, sync, then confirm.

Two checks stop old slides from going live. If a confirmed publish finds it has to build or rebuild a JPEG copy (you skipped the dry run, or re-rendered since), it stops and asks you to sync first. And before it calls the platform it asks your host for every URL: a URL that does not answer, or whose size differs from the local file, stops the post with "sync, then retry". Nothing is half posted.

With `"kind": "none"` (the default) Instagram and TikTok report `not_wired`.

### What each platform needs

All four adapters are covered by tests against mocked HTTP. None of them is exercised against the live platform by this repository, so run one real post to a test account before you rely on it.

**LinkedIn** (document post, the swipeable PDF)

- `LINKEDIN_ACCESS_TOKEN` with the `w_member_social` scope for a personal profile, or `w_organization_social` for a company page you administer.
- `LINKEDIN_AUTHOR_URN`: `urn:li:person:<id>` or `urn:li:organization:<id>`.
- Flow: initialize a document upload, PUT `carousel.pdf`, create the post. The `LinkedIn-Version` header is last month in `YYYYMM` form; pin it with `targets.linkedin.apiVersion` or `LINKEDIN_API_VERSION`. The PDF is only ever uploaded to a LinkedIn host.
- Limits: PDF up to 100 MB and 300 pages, caption up to 3000 characters.
- Tokens expire (usually after 60 days). This engine does not run the OAuth flow or refresh tokens.

**Instagram** (carousel)

- A professional account (business or creator) and a token with the content publishing permission.
- `INSTAGRAM_ACCESS_TOKEN` and `INSTAGRAM_USER_ID`, plus a media host.
- 2 to 10 images per carousel. The Instagram app allows 20, the API takes 10. `targets.instagram.maxSlides` is configurable and defaults to 10; a deck over the limit is refused, never trimmed.
- Feed carousels take aspect ratios from 4:5 to 1.91:1: use portrait or square, not story.
- Tokens from Instagram Login use another host: set `targets.instagram.apiBase` to `https://graph.instagram.com`. Only that and `https://graph.facebook.com` are accepted. The API version is `targets.instagram.graphVersion` (for example `v24.0`).
- If the All Sorted `instagram` module is installed under `ALLSORTED_ROOT` (an absolute path) and has its own credentials (`META_IG_ACCESS_TOKEN` and `META_IG_ACCOUNT_ID`), the engine hands the post to that module's `post-carousel` recipe. That module's process only receives the Instagram variables, never your other platform tokens. Set `targets.instagram.transport` to `graph` to always use the built-in flow.

**Facebook** (Page post with several photos)

- `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN` (a Page token with `pages_manage_posts` and `pages_read_engagement`). Personal profiles cannot be posted to through the API.
- Flow: each photo is uploaded from disk as unpublished, then one feed post attaches them. No media host is needed. Set `targets.facebook.needsPublicUrls` to true to have Facebook pull the photos from your media host.

**TikTok** (photo post)

- Requires an audited TikTok app; unaudited apps can only post privately. Until TikTok has audited your app, every post is visible only to the account that made it.
- `TIKTOK_ACCESS_TOKEN` (a user token with the `video.publish` scope), plus a media host whose domain or URL prefix is verified for your app in the TikTok developer portal.
- The default privacy level is `SELF_ONLY`. Change `targets.tiktok.privacyLevel` once your app is audited. The engine asks TikTok which levels the account allows and stops if yours is not one of them.
- Up to 35 photos, title up to 90 characters, JPEG only. `targets.tiktok.postMode` set to `MEDIA_UPLOAD` sends a draft to the account inbox.

## Recipes

`recipes/` holds seven recipes for agents and UIs. Each is a `<name>.recipe.json` manifest plus a `<name>.js` that exports `runRecipe(input, context)` and returns `{ status, reply, artifacts, metadata }`.

| Recipe | Input |
|---|---|
| `status` | none |
| `create-carousel` | `brief` or `sourceText`, optional `slides`, `size`, `render` |
| `render-deck` | `id`, `deckPath` or `deck`, optional `size`, `outDir` (inside the data dir) |
| `find-backgrounds` | `query`, optional `count`, `orientation`, `provider`; or `generate: true` with `prompt` |
| `publish-carousel` | `id` or `exportDir` (inside the data dir), `targets`, optional `caption`, `captionFile`, `title`, `dryRun`; to post, `confirm: "PUBLISH"` plus the `confirmToken` a dry run returned (`metadata.confirmToken`) |
| `list-carousels` | optional `limit` |
| `export-meta-carousel` | `id` of a rendered carousel, optional `callToAction` |

### Meta ads handoff

`export-meta-carousel` (also `carousel export-meta <id>`, and "Meta ads handoff" under Export in the browser UI) writes `meta-carousel.json` into the export folder: a name, the message (your caption, cut to 125 characters at a whole word), a call to action and 2 to 10 cards, each an image file name and a headline of up to 40 characters taken from the slide. `pageId`, `instagramUserId` and `link` are left as `FILL_IN_...` placeholders for whoever builds the ad. A deck over 10 slides uses the first 10, 6 or more cards switch `optimizeOrder` on, and slides that are not square come with a note to render in Square, which Meta prefers. The call to action is `LEARN_MORE` unless you choose one of `LEARN_MORE`, `SHOP_NOW`, `SIGN_UP`, `BOOK_NOW`, `GET_OFFER`, `CONTACT_US`, `SUBSCRIBE` or `DOWNLOAD` with `callToAction` on the recipe, `--cta` on the command, `cta=` on the API or the "Call to action" list in the browser UI ("shop now" and "Shop-Now" both read as `SHOP_NOW`); leaving it out adds a warning, and any other value is refused before a file is written. It is a file and nothing more: the engine never contacts Meta, never uploads and never puts a token in it.

`context` may carry `env`, `dataDir` and `fetchImpl`, which is how the tests run every recipe without a network.

## Privacy

Everything stays on your machine unless you configure something that sends it out:

- Rendering, the layout check, the PDF, JPEG conversion, drafts, exports and logs are local. Rendering runs a headless browser against files on disk.
- A model key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`) sends your brief and source text to that provider when you draft.
- An image provider key sends your search query or prompt to that provider.
- A publisher token plus `confirm: PUBLISH` sends your slides and caption to that platform.

There is no telemetry and no account. `carousel doctor` shows which of these are switched on, by name only: it never prints a key.

## Tests

```bash
npm test          # node --test test/index.js
```

The suite uses a scripted fetch throughout and makes no network calls.

## Licence

All Sorted Personal Use License. See `LICENSE`. Bundled fonts carry their own open licences: see `kit/fonts/FONTS-NOTICE.txt`.
