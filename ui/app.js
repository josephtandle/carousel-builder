// Carousel Builder: the browser UI of the engine.
// One screen, no wizard. Empty: the start screen. With a deck: slide strip, true-render
// preview and inspector, with the publish bar pinned underneath.

import { Button, InlineError, Notice, Popover, Segmented, Spinner, TextInput, cx, h, icon, redraw, relativeTime } from "./js/dom.js";
import {
  SIZES, boot, closeEditor, derivedShades, dismissDraftNote, draftFromUrl, flushOnLeave, isHex, moveSelected, openDraft, refreshDrafts, saveNow, selectOffset,
  set, setSize, setTitle, state, updateBrand, watch,
} from "./js/state.js";
import { INSPECTOR_TABS, Inspector } from "./js/views/inspector.js";
import { Preview } from "./js/views/preview.js";
import { PublishBar } from "./js/views/publish.js";
import { StartScreen } from "./js/views/start.js";
import { SlideStrip } from "./js/views/strip.js";

const MODEL_KEYS = "ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY";
const SKIP_FLAG = "carousel-builder:brand-prompt-skipped";
const app = document.getElementById("app");
let view = null; // { el, dispose(), create?() }

function stored(name) {
  try {
    return window.localStorage.getItem(name) === "true";
  } catch {
    return false;
  }
}
function store(name, value) {
  try {
    if (value) window.localStorage.setItem(name, "true");
    else window.localStorage.removeItem(name);
  } catch {
    // Storage can be unavailable in private windows.
  }
}

// ---------------------------------------------------------------------------
// The editor screen
// ---------------------------------------------------------------------------

// First run only: a compact nudge to set a name, a handle and one accent colour.
// What was typed lives in `draft`, outside the drawing, so a redraw never blanks the fields.
function BrandKitPrompt(draft, onSkip) {
  const brand = state.brand;
  if (!brand) return null;
  if (draft.accent === null) draft.accent = isHex(brand.colors.accent) ? brand.colors.accent.toLowerCase() : "#2fb5a6";
  const name = TextInput({ id: "brand-prompt-name", value: draft.name, placeholder: "Name or business", maxlength: "80", class: "prompt-name", oninput: (event) => { draft.name = event.target.value; } });
  const handle = TextInput({ id: "brand-prompt-handle", value: draft.handle, placeholder: "@handle", maxlength: "80", class: "prompt-handle", oninput: (event) => { draft.handle = event.target.value; } });
  const accent = h("input", { type: "color", id: "brand-prompt-accent", class: "colour-chip", "aria-label": "Accent colour", value: draft.accent, oninput: (event) => { draft.accent = event.target.value; } });
  const save = () => {
    const colour = draft.accent;
    const colors = isHex(colour) ? { accent: colour.toUpperCase(), ...derivedShades({ bg: brand.colors.bg, text: brand.colors.text, accent: colour }) } : undefined;
    updateBrand({ name: draft.name.trim(), handle: draft.handle.trim().replace(/^@+/, ""), ...(colors ? { colors } : {}) }, { now: true });
  };
  return h(
    "section",
    { "aria-label": "Set up your brand kit", class: "brand-prompt" },
    h(
      "form",
      { class: "brand-prompt-form", onsubmit: (event) => { event.preventDefault(); save(); } },
      h("div", { class: "brand-prompt-lead" }, icon("palette", 18, "accent"), h("p", null, h("strong", null, "Make it yours"), " in ten seconds")),
      h("div", { class: "brand-prompt-fields" }, h("label", { class: "sr-only", for: "brand-prompt-name" }, "Name or business name"), name, h("label", { class: "sr-only", for: "brand-prompt-handle" }, "Social handle"), handle),
      h("div", { class: "brand-prompt-end" }, h("label", { class: "colour-label" }, accent, "Accent colour"), h("div", { class: "row push" }, Button({ type: "submit", variant: "primary", busy: state.brandSave.status === "saving" }, "Save brand"), Button({ variant: "ghost", onclick: onSkip }, "Skip")))
    ),
    state.brandSave.status === "error" && state.brandSave.error ? h("p", { role: "alert", class: "field-error" }, state.brandSave.error) : null
  );
}

function EditorScreen() {
  const editor = state.editor;
  const stops = [];
  const parts = [SlideStrip(), Preview(), Inspector()];
  const [strip, preview, inspector] = parts;
  const publish = PublishBar();
  let brandSkipped = stored(SKIP_FLAG);
  const brandDraft = { name: "", handle: "", accent: null };

  const title = h("input", { id: "carousel-title", class: "title-input", value: editor.title, placeholder: "Untitled carousel", autocomplete: "off", oninput: (event) => setTitle(event.target.value) });

  const saveEl = h("div", { class: "save-badge" });
  const drawSave = () =>
    redraw(saveEl, () => {
      const { save } = state;
      if (save.status === "error") return h("button", { type: "button", id: "save-retry", class: "save-error", title: save.error || null, onclick: () => saveNow() }, icon("alert", 15), "Not saved. Try again");
      return h("span", { "aria-live": "polite", class: "save-state" }, save.status === "saving" ? "Saving" : save.status === "saved" ? [icon("check", 15, "good"), "Saved"] : "Saves as you work");
    });

  const drafts = Popover({
    label: "Drafts",
    width: "20rem",
    trigger: (ctl) => Button({ id: "drafts-button", icon: "folder", onclick: () => { ctl.toggle(); refreshDrafts(); } }, "Drafts"),
    content: (ctl) => [
      h("p", { class: "field-label strong gap-below" }, "Your carousels"),
      state.drafts.length === 0
        ? h("p", { class: "muted" }, "Nothing saved yet.")
        : h(
            "ul",
            { class: "plain" },
            state.drafts.slice(0, 20).map((draft) => {
              const current = state.editor && draft.id === state.editor.id;
              return h(
                "li",
                null,
                h(
                  "button",
                  { type: "button", class: cx("draft-row", current && "is-current"), "aria-current": current ? "true" : null, onclick: () => { ctl.close(); if (!current) openDraft(draft.id); } },
                  h("span", { class: "truncate strong" }, draft.title || "Untitled carousel"),
                  h("span", { class: "muted-3" }, `${draft.slides} slides${current ? ", open now" : `, ${relativeTime(draft.updatedAt)}`}`)
                )
              );
            })
          ),
    ],
  });

  const noticesEl = h("div", { class: "notices" });
  const drawNotices = () =>
    redraw(noticesEl, () => {
      const note = state.draftNote;
      let noteText = null;
      if (note) {
        noteText =
          note.engine === "fallback"
            ? `Drafted with the built-in draft because no model key was found${note.placeholders ? `, so ${note.placeholders} slide${note.placeholders === 1 ? " is a placeholder" : "s are placeholders"} to fill in` : ""}. For finished copy, set ${MODEL_KEYS} in the environment you start the carousel ui command from.`
            : `Drafted by ${note.model || note.engine}. Every word is yours to edit.${note.notes.length ? ` ${note.notes.join(" ")}` : ""}`;
      }
      return [
        state.openError ? InlineError({ message: state.openError }) : null,
        note ? Notice({ tone: note.engine === "fallback" ? "warn" : "info", class: "row between top" }, h("p", { class: "min-0" }, noteText), h("button", { type: "button", id: "dismiss-note", class: "icon-btn btn-quiet", "aria-label": "Dismiss this note", onclick: dismissDraftNote }, icon("x", 16))) : null,
        !state.brandExists && !brandSkipped ? BrandKitPrompt(brandDraft, () => { brandSkipped = true; store(SKIP_FLAG, true); drawNotices(); }) : null,
      ];
    });

  // Phone: opening the editor sheet brings the (smaller) preview to the top, so the slide stays in view while typing.
  const openSheet = (tab) => {
    set({ tab, sheetOpen: true });
    window.setTimeout(() => {
      const target = document.getElementById("carousel-preview");
      if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
  };
  const sheetButtons = h("div", { class: "sheet-buttons narrow-only" }, INSPECTOR_TABS.map((entry) => Button({ id: `sheet-open-${entry.id}`, icon: entry.icon, class: "tall", onclick: () => openSheet(entry.id) }, entry.sheetLabel)));

  const root = h(
    "main",
    { class: "editor" },
    h(
      "header",
      { class: "editor-head" },
      h("span", { class: "brandmark-icon", title: "Carousel Builder" }, icon("slides", 18)),
      h("label", { for: "carousel-title", class: "sr-only" }, "Carousel title"),
      title,
      Segmented({ label: "Size", value: editor.size, onChange: (next) => setSize(next), options: SIZES.map((entry) => ({ id: entry.id, label: entry.label, detail: entry.ratio })) }),
      h("div", { class: "head-actions" }, saveEl, drafts.el, Button({ id: "new-button", icon: "plus", onclick: () => closeEditor() }, "New"))
    ),
    noticesEl,
    h("div", { class: "workspace" }, strip.el, h("div", { class: "centre" }, preview.el, sheetButtons), inspector.el),
    publish.bar,
    publish.phone
  );

  const drawSheet = () => root.classList.toggle("sheet-open", state.sheetOpen);
  drawSave();
  drawNotices();
  drawSheet();
  stops.push(watch(["save"], drawSave));
  stops.push(watch(["drafts", "editorId"], () => drafts.refresh()));
  stops.push(watch(["draftNote", "openError", "brandExists", "brandSave"], drawNotices));
  stops.push(watch(["sheetOpen"], drawSheet));
  stops.push(watch(["editorText", "editor"], () => { document.title = `${(state.editor && state.editor.title) || "Untitled carousel"} · Carousel Builder`; }));
  document.title = `${editor.title || "Untitled carousel"} · Carousel Builder`;

  return {
    el: root,
    dispose() {
      for (const stop of stops) stop();
      for (const part of parts) part.dispose();
      publish.dispose();
      drafts.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Which screen is showing
// ---------------------------------------------------------------------------

function show() {
  if (view && view.dispose) view.dispose();
  view = null;
  const { boot: status } = state;
  if (status.status === "loading") {
    view = { el: h("main", { class: "centre-screen" }, Spinner("Loading the Carousel Builder", 20)) };
  } else if (status.status === "error") {
    view = { el: h("main", { class: "start" }, h("h1", { class: "start-title" }, "Carousel Builder"), InlineError({ message: status.error || "The Carousel Builder could not start.", onRetry: () => window.location.reload() })) };
  } else if (!state.editor) {
    document.title = "Carousel Builder";
    view = StartScreen();
  } else {
    view = EditorScreen();
  }
  app.replaceChildren(view.el);
  if (view.mounted) view.mounted();
  // Fields size themselves once they are on the page.
  for (const node of app.querySelectorAll("textarea.autosize")) {
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight + 2}px`;
  }
}

// Arrow keys belong to the control that has focus when that control uses them itself.
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  return Boolean(target.closest('[role="radiogroup"], [role="tablist"], [role="dialog"]'));
}

// Keyboard: arrows change slide, Alt plus arrows move it, Cmd or Ctrl plus Enter generates, Cmd or Ctrl plus S saves.
window.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey;
  const hasEditor = Boolean(state.editor);
  if (command && event.key.toLowerCase() === "s") {
    if (!hasEditor) return;
    event.preventDefault();
    saveNow();
    return;
  }
  if (command && event.key === "Enter") {
    if (hasEditor || !view || !view.create) return;
    event.preventDefault();
    view.create();
    return;
  }
  if (!hasEditor || command || isTyping(event.target) || document.querySelector('[aria-modal="true"]')) return;
  const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
  const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
  if (!back && !forward) return;
  event.preventDefault();
  const onThumb = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("thumb-button");
  if (event.altKey) moveSelected(back ? -1 : 1);
  else selectOffset(back ? -1 : 1);
  // Focus follows the slide when the keys were pressed on a thumbnail.
  if (onThumb) window.setTimeout(() => { const current = document.querySelector(".thumb-button.is-selected"); if (current) current.focus(); }, 0);
});

window.addEventListener("pagehide", flushOnLeave);
window.addEventListener("hashchange", () => {
  const wanted = draftFromUrl();
  if (wanted && (!state.editor || state.editor.id !== wanted)) openDraft(wanted);
});

watch(["mode"], show);
show();
boot();
