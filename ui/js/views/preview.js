// The large preview: the PNG the engine rendered for the selected slide, never a CSS
// approximation. After an edit the old image stays in place until the new one has
// loaded, with a quiet "rendering" state on top, so nothing flickers.

import { IconButton, InlineError, cx, h, icon, redraw } from "../dom.js";
import { deleteSlide, duplicateSlide, retryRender, selectOffset, selectedSlide, sizeOf, state, watch } from "../state.js";
import { layoutName, problemsOf } from "./strip.js";

export function Preview() {
  const label = h("p", { class: "preview-label" });
  const status = h("div", { class: "preview-status", "aria-live": "polite" });
  const duplicate = IconButton({ label: "Duplicate this slide", class: "wide-only-flex", onclick: () => { const { slide } = selectedSlide(); if (slide) duplicateSlide(slide.key); } }, "copy");
  const remove = IconButton({ label: "Delete this slide", class: "wide-only-flex", onclick: () => { const { slide } = selectedSlide(); if (slide) deleteSlide(slide.key); } }, "trash");
  const image = h("img", { alt: "", draggable: false, class: "preview-img", hidden: true });
  const waiting = h("div", { class: "preview-wait" });
  const progress = h("span", { class: "preview-progress", "aria-hidden": "true", hidden: true });
  const frame = h("div", { class: "preview-frame" }, image, waiting, progress);
  const previous = h("button", { type: "button", class: "preview-nav preview-prev", "aria-label": "Previous slide", onclick: () => selectOffset(-1) }, icon("left", 20));
  const next = h("button", { type: "button", class: "preview-nav preview-next", "aria-label": "Next slide", onclick: () => selectOffset(1) }, icon("right", 20));
  const stage = h("div", { class: "preview-stage" }, frame, previous, next);
  const problemsEl = h("div", { class: "preview-problems" });
  const root = h(
    "section",
    { id: "carousel-preview", "aria-label": "Preview", class: "panel preview" },
    h("div", { class: "preview-head" }, label, h("div", { class: "preview-tools" }, status, duplicate, remove)),
    stage,
    problemsEl
  );

  let wanted = null; // the URL that should be on screen
  let loader = null;

  // Shows the last image until the next one has finished loading.
  function show(url) {
    if (url === wanted) return;
    wanted = url;
    if (loader) {
      loader.onload = null;
      loader.onerror = null;
      loader = null;
    }
    if (!url) {
      image.hidden = true;
      image.removeAttribute("src");
      return;
    }
    if (image.hidden) {
      image.src = url;
      image.hidden = false;
      return;
    }
    const pending = new Image();
    loader = pending;
    const swap = () => {
      if (loader !== pending) return;
      loader = null;
      image.src = url;
    };
    pending.onload = swap;
    pending.onerror = swap;
    pending.src = url;
  }

  function update() {
    const editor = state.editor;
    const { slide, index } = selectedSlide();
    if (!editor || !slide) return;
    const size = sizeOf(editor.size);
    const total = editor.slides.length;
    const shown = state.renders[slide.key];
    const fieldProblems = state.fieldErrors.filter((entry) => entry.key === slide.key);
    const problems = problemsOf(slide.key);
    const working = state.renderBusy || state.renderStale;
    const name = layoutName(slide.fields.layout);

    redraw(label, () => [h("strong", null, `Slide ${index + 1}`), ` of ${total}`, h("span", { class: "preview-sep", "aria-hidden": "true" }, "/"), name]);
    redraw(status, () =>
      working
        ? h("span", { class: "status-line" }, icon("spinner", 15, "accent"), "Rendering")
        : problems.length
          ? h("span", { class: "status-line bad" }, icon("warning", 15), `${problems.length} layout issue${problems.length === 1 ? "" : "s"}`)
          : shown
            ? h("span", { class: "status-line good" }, icon("check", 15), "Layout check passed")
            : null
    );
    remove.disabled = total <= 1;
    previous.disabled = index === 0;
    next.disabled = index >= total - 1;

    stage.style.setProperty("--slide-w", String(size.w));
    stage.style.setProperty("--slide-h", String(size.h));
    stage.classList.toggle("is-compact", state.sheetOpen);
    const url = shown && shown.url ? shown.url : null;
    show(url);
    image.alt = url ? `Slide ${index + 1} of ${total}, ${name}, rendered by the engine` : "";
    waiting.hidden = Boolean(url);
    if (!url) redraw(waiting, () => [icon("spinner", 22, "accent"), state.renderError ? "No render yet" : "Drawing your slides"]);
    progress.hidden = !(working && url);

    const generalError = state.renderError && fieldProblems.length === 0 && state.fieldErrors.length === 0 ? state.renderError : null;
    const elsewhere = Boolean(state.renderError) && fieldProblems.length === 0 && state.fieldErrors.length > 0;
    redraw(problemsEl, () => [
      problems.length > 0 ? InlineError({ message: problems.join("\n") }) : null,
      generalError ? InlineError({ message: generalError, onRetry: retryRender }) : null,
      elsewhere ? InlineError({ message: "Another slide has a problem, so the engine did not render. Open the slide marked in red to fix it." }) : null,
    ]);
    problemsEl.hidden = !(problems.length > 0 || generalError || elsewhere);
    root.className = cx("panel preview");
  }

  update();
  const stop = watch(["editor", "selectedKey", "renders", "renderBusy", "renderStale", "renderError", "fieldErrors", "sheetOpen", "templates"], update);
  return { el: root, dispose: stop };
}
