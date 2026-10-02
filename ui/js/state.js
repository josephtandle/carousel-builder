// Editor state and every action of the screen. The page is a thin client: the
// engine drafts, renders, checks and publishes; this file keeps what is on
// screen in step with it.

import { ApiError, api, errorText, postJson, saveOnLeave, uploadFile } from "./api.js";

// ---------------------------------------------------------------------------
// A tiny store: set() changes values, watch() hears about them once per tick
// ---------------------------------------------------------------------------

export const state = {
  boot: { status: "loading", error: null },
  doctor: null,
  schema: null,
  templates: null,
  templatesBusy: false,
  templatesError: null,
  brand: null,
  brandExists: false,
  brandPreviews: { logo: null, portrait: null },
  brandWarnings: [],
  brandSave: { status: "idle", error: null },
  drafts: [],
  history: { exports: [], publishes: [] },
  editor: null,
  selectedKey: null,
  renders: {},
  renderBusy: false,
  renderStale: false,
  renderError: null,
  fieldErrors: [],
  qa: null,
  save: { status: "idle", error: null },
  generating: false,
  generateError: null,
  openError: null,
  opening: false,
  draftNote: null,
  captionBusy: false,
  captionError: null,
  tab: "content",
  sheetOpen: false,
};

const listeners = new Set();
let pending = new Set();
let scheduled = false;

function flush() {
  scheduled = false;
  const keys = pending;
  pending = new Set();
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    if (!listener.keys.some((key) => keys.has(key))) continue;
    try {
      listener.fn(keys);
    } catch (error) {
      // One part of the page failing to draw must not stop the others from hearing the change.
      console.error(error);
    }
  }
}

export function emit(...keys) {
  for (const key of keys) pending.add(key);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

/** watch(["editor", "renders"], fn) -> stop(). fn runs at most once per tick. */
export function watch(keys, fn) {
  const listener = { keys, fn };
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function set(patch) {
  Object.assign(state, patch);
  emit(...Object.keys(patch));
}

// ---------------------------------------------------------------------------
// Deck helpers
// ---------------------------------------------------------------------------

export const SIZES = [
  { id: "portrait", label: "Portrait", ratio: "4:5", w: 1080, h: 1350 },
  { id: "square", label: "Square", ratio: "1:1", w: 1080, h: 1080 },
  { id: "story", label: "Story", ratio: "9:16", w: 1080, h: 1920 },
];
export function sizeOf(id) {
  return SIZES.find((size) => size.id === id) || SIZES[0];
}

let keyCounter = 0;
function newKey() {
  keyCounter += 1;
  return `s${Date.now().toString(36)}${keyCounter.toString(36)}`;
}

export function countWords(value) {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const plain = String(value).replace(/\*+/g, "").trim();
  return plain ? plain.split(/\s+/).length : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBlank(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstLayout() {
  return state.schema ? Object.keys(state.schema.layouts)[0] || "" : "";
}

function editorFromDeck(deck, id) {
  const { title, size, slides, caption, hashtags, _brief, ...extras } = deck;
  const list = Array.isArray(slides) ? slides.filter(isRecord) : [];
  return {
    id,
    title: typeof title === "string" ? title : "",
    size: size === "square" || size === "story" ? size : "portrait",
    slides: list.map((fields) => ({ key: newKey(), fields: { ...fields, layout: typeof fields.layout === "string" ? fields.layout : firstLayout() } })),
    caption: typeof caption === "string" ? caption : "",
    hashtags: Array.isArray(hashtags) ? hashtags.filter((tag) => typeof tag === "string") : [],
    brief: typeof _brief === "string" ? _brief : "",
    extras,
  };
}

export function deckOf(editor) {
  return {
    ...editor.extras,
    title: editor.title,
    size: editor.size,
    slides: editor.slides.map((slide) => slide.fields),
    caption: editor.caption,
    hashtags: editor.hashtags,
    _brief: editor.brief,
  };
}

/** Caption plus hashtags, exactly as it is sent to a platform. */
export function fullCaption(editor) {
  const text = editor.caption.trim();
  const tags = editor.hashtags.filter((tag) => !text.includes(tag));
  return tags.length ? `${text}${text ? "\n\n" : ""}${tags.join(" ")}` : text;
}

export function normalizeHashtag(raw) {
  const cleaned = raw.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return cleaned ? `#${cleaned}` : "";
}

// Starter content for a new slide of each shipped layout: short and neutral, there to be replaced.
const STARTERS = {
  "01-editorial-statement": { headline: "Your *big* idea in one line" },
  "02-face-claim-cover": { headline: "One clear *claim* goes here" },
  "03-big-number-cover": { number: "3x", unit: "what this number *means*" },
  "04-tweet-card": { text: "One or two sentences that state your opinion plainly." },
  "06-numbered-step": { step: "1", title: "Name this step", body: "One idea per slide, in under 20 words." },
  "07-contrast-myth-truth": { a_label: "Myth", a_text: "What most people believe", b_label: "Truth", b_text: "What actually *works*" },
  "08-data-chart": { headline: "One comparison that makes the point", bars: [{ label: "Before", value: 40, display: "40%" }, { label: "After", value: 85, display: "85%", highlight: true }] },
  "09-framework-2x2": { headline: "Where does it *fit*?", col_a: "Quick", col_b: "Slow", row_a: "Low cost", row_b: "High cost", quads: [{ title: "Do it now", highlight: true }, { title: "Plan it" }, { title: "Test it" }, { title: "Drop it" }] },
  "10-cta-comment-keyword": { lead: "Found this useful?", keyword: "SAVE", promise: "Save this post and send it to a friend." },
  "11-recap-list": { title: "Recap", items: ["First point", "Second point"] },
};
// The main line of a layout, so text follows the slide when its template changes.
const MAIN_FIELDS = ["headline", "title", "text", "unit", "b_text", "promise"];
const SECOND_FIELDS = ["sub", "body"];
// Labels and other structure a layout needs to make sense, filled in when a slide switches to it.
const STRUCTURE = new Set(["a_label", "a_text", "b_label", "col_a", "col_b", "row_a", "row_b", "lead", "promise", "path"]);
const KEPT_ACROSS_LAYOUTS = ["byline", "logo", "cue", "show_byline", "show_counter", "show_progress", "show_cue", "show_corners", "theme"];
const PREFERRED_NEW = "06-numbered-step";

function fits(spec, value) {
  if (spec.type === "list") return Array.isArray(value);
  if (spec.type === "enum") return typeof value === "string" && (spec.values || []).includes(value);
  if (spec.type === "number") return typeof value === "number";
  if (spec.type === "boolean") return typeof value === "boolean";
  return typeof value === "string" || typeof value === "number";
}

function templateOf(layout) {
  return state.templates ? state.templates.templates.find((entry) => entry.id === layout) || null : null;
}

// A value that satisfies one required field, for layouts this page has no starter for.
function placeholderFor(spec) {
  if (!spec) return "Your text here";
  if (spec.type === "list") {
    const count = Math.max(spec.minItems || 0, 2);
    if (spec.item === "text" || !isRecord(spec.item)) return Array.from({ length: Math.min(count, spec.maxItems || count) }, (_, index) => `Point ${index + 1}`);
    return Array.from({ length: Math.min(count, spec.maxItems || count) }, (_, index) => {
      const row = {};
      for (const [name, sub] of Object.entries(spec.item)) if (sub.required) row[name] = sub.type === "number" ? 40 + index * 20 : `Item ${index + 1}`;
      return row;
    });
  }
  if (spec.type === "enum") return (spec.values || [])[0] || "";
  if (spec.type === "number") return 1;
  if (spec.type === "boolean") return false;
  return "Your text here";
}

export function starterSlide(layout, stepNumber) {
  const schema = state.schema;
  const template = templateOf(layout);
  const source = STARTERS[layout] || (template && isRecord(template.sampleSlide) ? template.sampleSlide : {});
  const starter = clone(source);
  delete starter.layout;
  const spec = schema && schema.layouts[layout];
  if (spec && spec.fields.step && stepNumber) starter.step = String(stepNumber);
  if (spec) for (const name of spec.required || []) if (isBlank(starter[name])) starter[name] = placeholderFor(spec.fields[name]);
  return { layout, ...starter };
}

function mainField(spec, list) {
  return list.find((name) => spec.fields[name] && spec.fields[name].type === "text");
}

/** Same slide, new template: fields with the same name carry over, the main line follows, and anything the new template requires is filled in. */
export function withLayout(fields, layout) {
  const schema = state.schema;
  const spec = schema && schema.layouts[layout];
  if (!spec || fields.layout === layout) return fields;
  const old = schema.layouts[fields.layout];
  const next = { layout };
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    if (!isBlank(fields[name]) && fits(fieldSpec, fields[name])) next[name] = fields[name];
  }
  const carry = (from, to) => {
    if (!from || !to || !isBlank(next[to]) || !spec.fields[to]) return;
    const value = fields[from];
    if (typeof value === "string" && value.trim()) next[to] = value;
  };
  if (old) {
    carry(mainField(old, MAIN_FIELDS), mainField(spec, MAIN_FIELDS));
    carry(mainField(old, SECOND_FIELDS), mainField(spec, SECOND_FIELDS));
  }
  const starter = starterSlide(layout);
  for (const [name, value] of Object.entries(starter)) {
    if (name === "layout" || !isBlank(next[name])) continue;
    if ((spec.required || []).includes(name) || STRUCTURE.has(name)) next[name] = value;
  }
  for (const name of KEPT_ACROSS_LAYOUTS) if (fields[name] !== undefined) next[name] = fields[name];
  if (fields.background !== undefined && schema.backgroundLayouts.includes(layout)) {
    next.background = fields.background;
    if (fields._credit !== undefined) next._credit = fields._credit;
  }
  return next;
}

function hasStep(layout) {
  const spec = state.schema && state.schema.layouts[layout];
  return Boolean(spec && spec.fields.step);
}

/** If the step slides were numbered 1, 2, 3 in order, keep them that way after slides move, appear or go. */
function keepStepsInOrder(before, after) {
  const wasInOrder = before.filter((slide) => hasStep(slide.fields.layout)).every((slide, index) => String(slide.fields.step) === String(index + 1));
  if (!wasInOrder) return after;
  let step = 0;
  return after.map((slide) => {
    if (!hasStep(slide.fields.layout)) return slide;
    step += 1;
    return String(slide.fields.step) === String(step) ? slide : { ...slide, fields: { ...slide.fields, step: String(step) } };
  });
}

const ISSUE_PATTERN = /^slides\[(\d+)\](?: \([^)]*\))?\.([A-Za-z0-9_]+)[^:]*: (.*)$/;
function fieldErrorsFrom(issues, keys) {
  if (!Array.isArray(issues)) return [];
  const found = [];
  for (const issue of issues) {
    const match = typeof issue === "string" ? ISSUE_PATTERN.exec(issue) : null;
    if (!match) continue;
    const key = keys[Number(match[1])];
    if (key) found.push({ key, field: match[2], message: match[3] });
  }
  return found;
}

function mergePatch(base, patch) {
  const next = { ...base, ...patch };
  if (base.colors || patch.colors) next.colors = { ...(base.colors || {}), ...(patch.colors || {}) };
  if (base.chrome || patch.chrome) next.chrome = { ...(base.chrome || {}), ...(patch.chrome || {}) };
  return next;
}

function mergeBrand(brand, patch) {
  return { ...brand, ...patch, colors: { ...brand.colors, ...(patch.colors || {}) }, chrome: { ...brand.chrome, ...(patch.chrome || {}) } };
}

// The address bar carries #draft=<id>, so a reload or a shared link opens the same carousel.
function setUrlDraft(id) {
  try {
    const url = new URL(window.location.href);
    url.hash = id ? `draft=${id}` : "";
    window.history.replaceState(null, "", id ? url.toString() : url.pathname + url.search);
  } catch {
    // The address bar is a convenience only.
  }
}

export function draftFromUrl() {
  const match = /(?:^#|&)draft=([a-z0-9-]{1,96})(?:&|$)/.exec(window.location.hash || "");
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const RENDER_DELAY = 650;
const SAVE_DELAY = 1200;
const BRAND_DELAY = 500;

let session = 0;
let revision = 0;
let rendered = -1;
let renderTimer = null;
let renderJob = null;
let renderOutcome = { error: null, qaOk: false };
let saveTimer = null;
let saveChain = Promise.resolve();
let unsaved = false;
let openTicket = 0;
let brandTimer = null;
let brandPending = {};
let templateJob = null;
let templateDirty = false;

function persist() {
  const run = async () => {
    const current = state.editor;
    if (!current) throw new Error("There is nothing to save yet.");
    const mine = session;
    unsaved = false;
    let saved;
    try {
      saved = await api("drafts", postJson({ id: current.id, deck: deckOf(current) }));
    } catch (error) {
      unsaved = true;
      throw error;
    }
    const latest = state.editor;
    if (session === mine && latest && latest.id !== saved.id) {
      state.editor = { ...latest, id: saved.id };
      emit("editorId");
      setUrlDraft(saved.id);
    }
    return saved.id;
  };
  const chained = saveChain.then(run, run);
  saveChain = chained.catch(() => undefined);
  return chained;
}

export async function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.editor) return;
  set({ save: { status: "saving", error: null } });
  try {
    await persist();
    set({ save: { status: "saved", error: null } });
  } catch (error) {
    set({ save: { status: "error", error: errorText(error) } });
  }
}

function scheduleSave() {
  unsaved = true;
  if (state.save.status !== "saving") set({ save: { status: "saving", error: null } });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow();
  }, SAVE_DELAY);
}

/** Leaving the page inside the save delay: send the last edits anyway. */
export function flushOnLeave() {
  const current = state.editor;
  if (!unsaved || !current) return;
  unsaved = false;
  saveOnLeave({ id: current.id, deck: deckOf(current) });
}

// ---------------------------------------------------------------------------
// Rendering: the engine draws every slide, the page only shows the PNGs
// ---------------------------------------------------------------------------

function runRender() {
  if (renderJob) return renderJob;
  const current = state.editor;
  if (!current || current.slides.length === 0) return Promise.resolve();
  const mine = session;
  const mark = revision;
  const keys = current.slides.map((slide) => slide.key);
  set({ renderBusy: true });
  const job = (async () => {
    try {
      const id = current.id || (await persist());
      const result = await api("render", postJson({ id, deck: deckOf(current) }));
      if (session !== mine) return;
      const previous = state.renders;
      const next = {};
      result.slides.forEach((slide, index) => {
        const key = keys[index];
        if (key) next[key] = { url: slide.url || (previous[key] && previous[key].url) || null, ok: slide.ok, issues: slide.issues };
      });
      set({ renders: next, qa: result.qa, renderError: null, fieldErrors: [] });
      renderOutcome = { error: null, qaOk: result.qa.ok };
    } catch (error) {
      if (session !== mine) return;
      const payload = error instanceof ApiError ? error.payload : null;
      set({ fieldErrors: fieldErrorsFrom(payload && payload.issues, keys), renderError: errorText(error), qa: null });
      renderOutcome = { error: errorText(error), qaOk: false };
    } finally {
      if (session === mine) rendered = mark;
    }
  })().finally(() => {
    renderJob = null;
    const behind = revision !== rendered;
    set({ renderBusy: false, renderStale: behind });
    // Edits made while the engine was drawing: draw again once typing pauses.
    if (behind && !renderTimer && state.editor) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        runRender();
      }, 250);
    }
  });
  renderJob = job;
  return job;
}

function scheduleRender(delay = RENDER_DELAY) {
  revision += 1;
  if (!state.renderStale) set({ renderStale: true });
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    runRender();
  }, delay);
}

export function retryRender() {
  scheduleRender(0);
}

/** Waits until the PNGs on disk match what is on screen. Used before export and publish. */
export async function ensureRendered() {
  if (!state.editor) return { rendered: false, qaOk: false, reason: "There is no carousel open.", id: null };
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (renderJob) await renderJob;
    if (rendered === revision) break;
    await runRender();
  }
  // The id is read after the wait: a new carousel gets its id from its first save.
  const id = state.editor ? state.editor.id : null;
  if (rendered !== revision) return { rendered: false, qaOk: false, reason: "The slides are still rendering. Try again in a moment.", id };
  if (renderOutcome.error) return { rendered: false, qaOk: false, reason: renderOutcome.error, id };
  if (!renderOutcome.qaOk) return { rendered: true, qaOk: false, reason: "Some slides do not pass the layout check yet. Fix the slides marked in red first.", id };
  return { rendered: true, qaOk: true, reason: null, id };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Applies one change to the open carousel. quiet: the change came from typing in a field, so
 * the part of the page that holds that field is not redrawn (listeners hear "editorText").
 */
function mutate(change, options = {}) {
  const current = state.editor;
  if (!current) return;
  const next = change(current);
  if (next === current) return;
  state.editor = next;
  emit(options.quiet ? "editorText" : "editor");
  scheduleSave();
  if (options.render !== false) scheduleRender();
}

function openEditor(next) {
  session += 1;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  rendered = -1;
  renderOutcome = { error: null, qaOk: false };
  const sizeChanged = next && state.templates && state.templates.size !== next.size;
  set({
    editor: next,
    selectedKey: next && next.slides[0] ? next.slides[0].key : null,
    renders: {},
    qa: null,
    renderError: null,
    fieldErrors: [],
    save: { status: next && next.id ? "saved" : "idle", error: null },
    sheetOpen: false,
  });
  emit("mode");
  setUrlDraft(next ? next.id : null);
  if (next && next.slides.length) scheduleRender(0);
  else set({ renderStale: false });
  if (sizeChanged) loadTemplates(next.size);
}

export async function refreshDrafts() {
  try {
    const listed = await api("drafts");
    set({ drafts: listed.drafts });
  } catch {
    // The drafts menu shows what it has; opening a draft reports its own errors.
  }
}

export async function refreshHistory() {
  try {
    const found = await api("export");
    set({ history: { exports: found.exports || [], publishes: found.publishes || [] } });
  } catch {
    // History is a convenience list.
  }
}

export async function refreshDoctor() {
  const report = await api("doctor");
  set({ doctor: report });
  return report;
}

export async function generate(input) {
  if (state.generating) return;
  set({ generating: true, generateError: null });
  try {
    // A new carousel starts a new draft: flush the one that is open first.
    if (state.editor && saveTimer) await saveNow();
    const mine = session;
    const drafted = await api("draft", postJson(input));
    // Another carousel was opened while this one was being written: leave that one alone.
    if (session !== mine) return;
    const next = editorFromDeck({ ...drafted.deck, _brief: input.brief }, null);
    next.size = input.size;
    openEditor(next);
    set({ draftNote: { engine: drafted.engine, model: drafted.model, placeholders: drafted.placeholders, notes: drafted.notes || [] } });
    scheduleSave();
  } catch (error) {
    set({ generateError: errorText(error) });
  } finally {
    set({ generating: false });
  }
}

export async function openDraft(id) {
  openTicket += 1;
  const ticket = openTicket;
  set({ opening: true, openError: null });
  try {
    if (state.editor && saveTimer) await saveNow();
    const loaded = await api(`drafts?id=${encodeURIComponent(id)}`);
    // Only the draft asked for last is opened.
    if (openTicket !== ticket) return;
    openEditor(editorFromDeck(loaded.deck, loaded.id));
    set({ draftNote: null });
  } catch (error) {
    if (openTicket === ticket) {
      set({ openError: `Could not open that draft. ${errorText(error)}` });
      // The address bar goes back to what is really open, so a reload does not land on the error.
      setUrlDraft(state.editor ? state.editor.id : null);
    }
  } finally {
    if (openTicket === ticket) set({ opening: false });
  }
}

export async function closeEditor() {
  if (state.editor && saveTimer) await saveNow();
  openEditor(null);
  set({ draftNote: null, openError: null });
  refreshDrafts();
}

export function selectedSlide() {
  const editor = state.editor;
  if (!editor) return { slide: null, index: 0 };
  const index = Math.max(0, editor.slides.findIndex((slide) => slide.key === state.selectedKey));
  return { slide: editor.slides[index] || null, index };
}

export function select(key) {
  if (state.selectedKey !== key) set({ selectedKey: key });
}

export function selectOffset(delta) {
  const editor = state.editor;
  if (!editor || editor.slides.length === 0) return;
  const { index } = selectedSlide();
  const target = Math.min(editor.slides.length - 1, Math.max(0, index + delta));
  select(editor.slides[target].key);
}

export function setTitle(title) {
  mutate((current) => ({ ...current, title }), { render: false, quiet: true });
}

export function setSize(size) {
  mutate((current) => (current.size === size ? current : { ...current, size }));
  loadTemplates(size);
}

export function setCaption(caption, quiet = true) {
  mutate((current) => ({ ...current, caption }), { render: false, quiet });
}

export function setHashtags(hashtags) {
  mutate((current) => ({ ...current, hashtags }), { render: false });
}

function patchSlide(key, change, options) {
  mutate((current) => ({ ...current, slides: current.slides.map((slide) => (slide.key === key ? { ...slide, fields: change(slide.fields) } : slide)) }), options);
}

/** Sets one field. An empty value removes the key, so the brand default applies again. */
export function setField(key, name, value, options = {}) {
  patchSlide(
    key,
    (fields) => {
      const next = { ...fields };
      if (isBlank(value)) delete next[name];
      else next[name] = value;
      return next;
    },
    { quiet: options.quiet === true }
  );
}

export function switchLayout(key, layout) {
  if (!state.schema) return;
  mutate((current) => {
    const slides = current.slides.map((slide) => (slide.key === key ? { ...slide, fields: withLayout(slide.fields, layout) } : slide));
    return { ...current, slides: keepStepsInOrder(current.slides, slides) };
  });
}

function newSlideLayout() {
  const schema = state.schema;
  if (schema && schema.layouts[PREFERRED_NEW]) return PREFERRED_NEW;
  const point = state.templates ? state.templates.templates.find((entry) => entry.group === "point") : null;
  return point ? point.id : firstLayout();
}

export function addSlide(afterKey) {
  const layout = newSlideLayout();
  const created = { key: newKey(), fields: { layout } };
  mutate((current) => {
    const at = afterKey ? current.slides.findIndex((slide) => slide.key === afterKey) + 1 : current.slides.length;
    const steps = current.slides.filter((slide) => hasStep(slide.fields.layout)).length;
    created.fields = starterSlide(layout, steps + 1);
    const slides = [...current.slides];
    slides.splice(at <= 0 ? current.slides.length : at, 0, created);
    return { ...current, slides: keepStepsInOrder(current.slides, slides) };
  });
  select(created.key);
}

export function duplicateSlide(key) {
  const copyKey = newKey();
  mutate((current) => {
    const at = current.slides.findIndex((slide) => slide.key === key);
    if (at < 0) return current;
    const slides = [...current.slides];
    slides.splice(at + 1, 0, { key: copyKey, fields: clone(current.slides[at].fields) });
    return { ...current, slides: keepStepsInOrder(current.slides, slides) };
  });
  if (state.renders[key]) set({ renders: { ...state.renders, [copyKey]: state.renders[key] } });
  select(copyKey);
}

export function deleteSlide(key) {
  const current = state.editor;
  if (!current || current.slides.length <= 1) return;
  const at = current.slides.findIndex((slide) => slide.key === key);
  if (at < 0) return;
  const neighbour = current.slides[at + 1] || current.slides[at - 1];
  mutate((latest) => ({ ...latest, slides: keepStepsInOrder(latest.slides, latest.slides.filter((slide) => slide.key !== key)) }));
  if (state.selectedKey === key) select(neighbour.key);
}

/** Moves a slide to the place of another one. */
export function moveSlide(fromKey, toKey) {
  mutate((current) => {
    const from = current.slides.findIndex((slide) => slide.key === fromKey);
    const to = current.slides.findIndex((slide) => slide.key === toKey);
    if (from < 0 || to < 0 || from === to) return current;
    const slides = [...current.slides];
    const [moved] = slides.splice(from, 1);
    slides.splice(to, 0, moved);
    return { ...current, slides: keepStepsInOrder(current.slides, slides) };
  });
}

export function moveSelected(delta) {
  const editor = state.editor;
  const { slide, index } = selectedSlide();
  if (!editor || !slide) return;
  const neighbour = editor.slides[index + delta];
  if (neighbour) moveSlide(slide.key, neighbour.key);
}

/** Applies (or removes) a background on one slide, or on every slide whose layout takes one. */
export function setBackground(scope, background, credit) {
  const schema = state.schema;
  if (!schema) return;
  mutate((current) => ({
    ...current,
    slides: current.slides.map((slide) => {
      const targeted = scope === "all" ? schema.backgroundLayouts.includes(slide.fields.layout) : slide.key === scope.key;
      if (!targeted) return slide;
      const fields = { ...slide.fields };
      if (background) {
        fields.background = background;
        if (credit) fields._credit = credit;
        else delete fields._credit;
      } else {
        delete fields.background;
        delete fields._credit;
      }
      return { ...slide, fields };
    }),
  }));
}

export function setTint(scope, tint, quiet = false) {
  mutate(
    (current) => ({
      ...current,
      slides: current.slides.map((slide) => {
        const background = slide.fields.background;
        if (!isRecord(background) || (scope !== "all" && slide.key !== scope.key)) return slide;
        return { ...slide, fields: { ...slide.fields, background: { ...background, tint } } };
      }),
    }),
    { quiet }
  );
}

export async function draftCaption() {
  const current = state.editor;
  if (!current) return;
  set({ captionBusy: true, captionError: null });
  try {
    const drafted = await api("caption", postJson({ deck: deckOf(current) }));
    mutate((latest) => ({ ...latest, caption: drafted.caption, hashtags: drafted.hashtags }), { render: false });
  } catch (error) {
    set({ captionError: errorText(error) });
  } finally {
    set({ captionBusy: false });
  }
}

export function dismissDraftNote() {
  set({ draftNote: null });
}

export function dismissGenerateError() {
  set({ generateError: null });
}

// ---------------------------------------------------------------------------
// Brand kit
// ---------------------------------------------------------------------------

export async function flushBrand() {
  if (brandTimer) clearTimeout(brandTimer);
  brandTimer = null;
  const patch = brandPending;
  if (Object.keys(patch).length === 0) return;
  brandPending = {};
  set({ brandSave: { status: "saving", error: null } });
  try {
    const saved = await api("brand", postJson(patch, "PUT"));
    set({ brandExists: saved.exists, brandPreviews: saved.previews, brandWarnings: saved.warnings, brandSave: { status: "saved", error: null } });
    if (state.editor) scheduleRender(0);
    // The template previews are drawn in the brand, so the list is read again. New previews
    // are only drawn while the picker is showing, or the next time it is opened.
    loadTemplates();
  } catch (error) {
    // Keep what was not saved: the next change, or Try again, sends it with the rest.
    brandPending = mergePatch(patch, brandPending);
    set({ brandSave: { status: "error", error: errorText(error) } });
  }
}

/** quiet: the change came from typing, so the Brand tab is not redrawn under the cursor. */
export function updateBrand(patch, options = {}) {
  if (!state.brand) return;
  state.brand = mergeBrand(state.brand, patch);
  emit(options.quiet ? "brandText" : "brand");
  brandPending = mergePatch(brandPending, patch);
  if (brandTimer) clearTimeout(brandTimer);
  if (options.now) flushBrand();
  else brandTimer = setTimeout(() => flushBrand(), BRAND_DELAY);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function currentSize() {
  return state.editor ? state.editor.size : "portrait";
}

export async function loadTemplates(size = currentSize()) {
  try {
    const listed = await api(`templates?size=${encodeURIComponent(size)}`);
    // A reply for a size that is no longer the current one is out of date.
    if (state.editor && listed.size !== currentSize()) return;
    set({ templates: listed, templatesError: null });
    if (state.tab === "templates" && state.editor) ensureTemplatePreviews();
  } catch (error) {
    set({ templatesError: errorText(error) });
  }
}

/** Builds the preview images for the saved brand and the current size. One build at a time. */
export function buildTemplatePreviews(force = false) {
  if (!state.templates || !state.templates.previews.available) return Promise.resolve();
  if (templateJob) {
    templateDirty = true;
    return templateJob;
  }
  set({ templatesBusy: true, templatesError: null });
  const size = currentSize();
  templateJob = (async () => {
    try {
      const built = await api("templates", postJson({ size, force }));
      if (size === currentSize()) set({ templates: built });
    } catch (error) {
      const payload = error instanceof ApiError ? error.payload : null;
      if (payload && Array.isArray(payload.templates)) set({ templates: { templates: payload.templates, groups: payload.groups, size: payload.size, source: payload.source, previews: payload.previews } });
      else set({ templatesError: errorText(error) });
    }
  })().finally(() => {
    templateJob = null;
    set({ templatesBusy: false });
    if (templateDirty) {
      templateDirty = false;
      buildTemplatePreviews(false);
    }
  });
  return templateJob;
}

/** Opening the picker: draw the previews that are not there yet. */
export function ensureTemplatePreviews() {
  const found = state.templates;
  if (!found || !found.previews.available || state.templatesBusy || state.templatesError) return;
  if (found.size !== currentSize()) {
    loadTemplates(currentSize());
    return;
  }
  if (found.previews.ready < found.previews.total) buildTemplatePreviews(false);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export function uploadImage(file) {
  return uploadFile(file);
}

export function searchImages(query) {
  const size = currentSize();
  return api("images", postJson({ query, count: 9, orientation: size === "square" ? "square" : "portrait" }));
}

export function generateImage(prompt, provider) {
  return api("images", postJson({ generate: true, prompt, provider, size: currentSize() }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function boot() {
  try {
    const [report, layoutSchema, brandReply, templates] = await Promise.all([api("doctor"), api("schema"), api("brand"), api("templates").catch(() => null)]);
    set({
      doctor: report,
      schema: layoutSchema,
      brand: brandReply.brand,
      brandExists: brandReply.exists,
      brandPreviews: brandReply.previews,
      brandWarnings: brandReply.warnings,
      templates,
      boot: { status: "ready", error: null },
    });
    emit("mode");
    refreshDrafts();
    refreshHistory();
    const wanted = draftFromUrl();
    if (wanted) openDraft(wanted);
  } catch (error) {
    set({ boot: { status: "error", error: errorText(error) } });
    emit("mode");
  }
}

// ---------------------------------------------------------------------------
// Colour helpers for the brand kit: one accent can drive the lighter tints
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return null;
  return [parseInt(match[1].slice(0, 2), 16), parseInt(match[1].slice(2, 4), 16), parseInt(match[1].slice(4, 6), 16)];
}
export function isHex(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value).trim());
}
function mixHex(from, to, amount) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  if (!a || !b) return from;
  return `#${a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
function isLight(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.55;
}
/** The shades that follow from background, text and accent, in the proportions of the engine's default look. */
export function derivedShades(colors) {
  const toward = isLight(colors.bg) ? "#000000" : "#FFFFFF";
  return {
    bgDeep: mixHex(colors.bg, colors.text, 0.035),
    bgAlt: mixHex(colors.bg, colors.accent, 0.16),
    accentSoft: mixHex(colors.accent, toward, isLight(colors.bg) ? 0.2 : 0.5),
    highlight: mixHex(colors.accent, toward, isLight(colors.bg) ? 0.4 : 0.77),
  };
}
