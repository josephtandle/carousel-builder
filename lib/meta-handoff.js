"use strict";

// Meta ads carousel handoff: turns a rendered export into one JSON file that
// describes a carousel ad (cards, message, call to action), ready for whoever
// builds the ad to complete and use. It never contacts Meta, never uploads and
// never holds a token: three values are left as FILL_IN placeholders on purpose.
//
//   buildMetaCarouselSpec({ exportDir, files, deckTitle, caption, slides }) -> { spec, warnings }
//   writeMetaCarouselSpec({ exportDir, ... }) -> { spec, warnings, file }   (writes meta-carousel.json)
//
// spec: { name, pageId, instagramUserId, message, link, callToAction, optimizeOrder, endCard,
//         cards: [{ image, headline }] } with image names relative to the spec file.

const fs = require("node:fs");
const path = require("node:path");

const SPEC_NAME = "meta-carousel.json";
const MIN_CARDS = 2;
const MAX_CARDS = 10;
const HEADLINE_CHARS = 40;
const MESSAGE_CHARS = 125;
const FILL_IN = Object.freeze({ pageId: "FILL_IN_PAGE_ID", instagramUserId: "FILL_IN_INSTAGRAM_USER_ID", link: "FILL_IN_LINK" });
// The main line of a slide, in the order it is looked for.
const MAIN_FIELDS = ["headline", "title", "text", "b_text", "promise", "keyword"];

function plain(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\*+/g, "").replace(/\s+/g, " ").trim();
}

// Cuts at the last whole word that fits. A single word longer than the limit is cut hard.
function cut(text, limit) {
  const value = plain(text);
  if (value.length <= limit) return value;
  const head = value.slice(0, limit + 1);
  const at = head.lastIndexOf(" ");
  return (at > 0 ? head.slice(0, at) : value.slice(0, limit)).replace(/[\s,;:.\-]+$/, "");
}

function mainLine(slide) {
  if (!slide || typeof slide !== "object") return "";
  if (plain(slide.number)) return plain(`${plain(slide.number)} ${plain(slide.unit)}`);
  for (const name of MAIN_FIELDS) if (plain(slide[name])) return plain(slide[name]);
  for (const name of ["items", "lines"]) if (Array.isArray(slide[name]) && plain(slide[name][0])) return plain(slide[name][0]);
  return "";
}

// Width and height from the PNG header, or null when the file is not a readable PNG.
function pngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24 || head.toString("latin1", 1, 4) !== "PNG") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function buildMetaCarouselSpec({ exportDir, files, deckTitle, caption, slides } = {}) {
  const dir = path.resolve(String(exportDir || ""));
  const all = (Array.isArray(files) ? files : []).map((file) => String(file));
  if (all.length < MIN_CARDS) {
    throw Object.assign(new Error(`A Meta carousel needs at least ${MIN_CARDS} slides, and this export has ${all.length}. Add a slide and render again.`), { code: "too_few_cards" });
  }
  const warnings = [];
  if (all.length > MAX_CARDS) warnings.push(`This export has ${all.length} slides and a Meta carousel takes ${MAX_CARDS}: the first ${MAX_CARDS} are used.`);
  const used = all.slice(0, MAX_CARDS);
  const title = plain(deckTitle);
  const deckSlides = Array.isArray(slides) ? slides : [];

  const cards = used.map((file, index) => {
    const absolute = path.isAbsolute(file) ? file : path.join(dir, file);
    const line = mainLine(deckSlides[index]);
    if (!line) warnings.push(`Slide ${index + 1} has no headline of its own, so its card uses the carousel title. Edit it in the file.`);
    return { image: path.relative(dir, absolute).split(path.sep).join("/"), headline: cut(line || title || `Slide ${index + 1}`, HEADLINE_CHARS) };
  });
  for (const card of cards) {
    if (card.image.startsWith("..") || path.isAbsolute(card.image)) throw Object.assign(new Error("Every slide of the export has to sit inside the export folder."), { code: "outside_export" });
  }

  const first = pngSize(path.join(dir, cards[0].image));
  if (first && first.width !== first.height) {
    warnings.push(`These slides are ${first.width}x${first.height}. Meta carousel ads prefer square images (1:1): switch the size to Square and render again for the best fit.`);
  }

  const message = cut(caption, MESSAGE_CHARS) || cut(title, MESSAGE_CHARS);
  if (!plain(caption)) warnings.push("There is no caption, so the message is the carousel title. Write the primary text in the file.");
  else if (plain(caption).length > MESSAGE_CHARS) warnings.push(`The caption is longer than ${MESSAGE_CHARS} characters, so the message is cut at a whole word. Check that it still reads well.`);

  const spec = {
    name: title || "Carousel",
    pageId: FILL_IN.pageId,
    instagramUserId: FILL_IN.instagramUserId,
    message,
    link: FILL_IN.link,
    callToAction: "LEARN_MORE",
    optimizeOrder: cards.length >= 6,
    endCard: true,
    cards,
  };
  return { spec, warnings };
}

// Writes meta-carousel.json into the export folder. A link or anything else that is not a
// plain file at that name is removed first, and the file is created exclusively.
function writeMetaCarouselSpec(input = {}) {
  const built = buildMetaCarouselSpec(input);
  const file = path.join(path.resolve(String(input.exportDir)), SPEC_NAME);
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  fs.writeFileSync(file, `${JSON.stringify(built.spec, null, 2)}\n`, { flag: "wx" });
  return { ...built, file };
}

module.exports = { buildMetaCarouselSpec, writeMetaCarouselSpec, SPEC_NAME, FILL_IN, MAX_CARDS, MIN_CARDS, HEADLINE_CHARS, MESSAGE_CHARS };
