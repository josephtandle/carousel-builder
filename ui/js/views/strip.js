// The slide strip: real rendered thumbnails, drag to reorder, add, duplicate, delete,
// and one layout check badge per slide. Vertical beside the preview on a wide screen,
// a horizontal row above it on a phone.

import { Button, IconButton, cx, h, icon, redraw } from "../dom.js";
import { addSlide, deleteSlide, duplicateSlide, moveSelected, moveSlide, select, selectedSlide, sizeOf, state, watch } from "../state.js";

export function problemsOf(key) {
  const render = state.renders[key];
  return [...(render ? render.issues : []), ...state.fieldErrors.filter((entry) => entry.key === key).map((entry) => `${entry.field}: ${entry.message}`)];
}

export function layoutName(layout) {
  const template = state.templates ? state.templates.templates.find((entry) => entry.id === layout) : null;
  if (template) return template.name;
  const spec = state.schema && state.schema.layouts[layout];
  return spec ? spec.name || spec.title || layout : layout;
}

export function SlideStrip() {
  const images = new Map(); // slide key -> <img>, kept across redraws so a thumbnail never blinks
  const list = h("ul", { class: "strip-list", "aria-label": "Slides. Drag to reorder, or hold Alt and press an arrow key." });
  const countEl = h("span", { class: "muted-3 normal" });
  const actionsEl = h("div", { class: "strip-actions narrow-only" });
  const warnEl = h("div", null);
  const tip = h("div", { role: "tooltip", class: "strip-tip", hidden: true });
  const root = h("section", { "aria-label": "Slides", class: "panel strip" }, h("div", { class: "strip-head" }, h("h2", { class: "panel-title" }, "Slides ", countEl)), list, actionsEl, warnEl, tip);

  let drag = null;
  let renderWaiting = false; // a redraw asked for while a slide was being dragged
  let suppressClick = false;
  let lastSelected = null;

  function showTip(target, lines) {
    if (!lines.length || drag) {
      hideTip();
      return;
    }
    const rect = target.getBoundingClientRect();
    const wide = window.innerWidth >= 1024;
    redraw(tip, () => [
      h("p", { class: "strip-tip-title" }, "Layout check"),
      h("ul", null, lines.slice(0, 3).map((line) => h("li", null, line)), lines.length > 3 ? h("li", { class: "dim" }, `and ${lines.length - 3} more`) : null),
    ]);
    tip.style.top = `${wide ? Math.max(8, Math.min(rect.top, window.innerHeight - 180)) : rect.bottom + 8}px`;
    tip.style.left = `${wide ? rect.right + 10 : Math.max(12, Math.min(rect.left, window.innerWidth - 300))}px`;
    tip.hidden = false;
  }
  function hideTip() {
    tip.hidden = true;
  }

  // ---- drag to reorder (mouse and pen; a phone uses the move buttons under the row) ----

  function itemAt(x, y) {
    const horizontal = window.innerWidth < 1024;
    let best = null;
    let bestDistance = Infinity;
    for (const item of list.querySelectorAll("li[data-key]")) {
      const rect = item.getBoundingClientRect();
      const distance = horizontal ? Math.abs(x - (rect.left + rect.width / 2)) : Math.abs(y - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    return best;
  }
  function onMove(event) {
    if (!drag) return;
    // The button was released somewhere this page did not see (outside the window).
    if (event.buttons === 0) {
      endDrag(false);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.active = true;
      hideTip();
      drag.item.classList.add("dragging");
      list.classList.add("is-dragging");
    }
    // Near an edge of the strip the list scrolls, so a slide can travel past what is showing.
    const box = list.getBoundingClientRect();
    const wide = window.innerWidth >= 1024;
    const edge = 36;
    if (wide) {
      const before = list.scrollTop;
      if (event.clientY < box.top + edge) list.scrollTop -= 14;
      else if (event.clientY > box.bottom - edge) list.scrollTop += 14;
      drag.scrolled += list.scrollTop - before;
    } else {
      const before = list.scrollLeft;
      if (event.clientX < box.left + edge) list.scrollLeft -= 14;
      else if (event.clientX > box.right - edge) list.scrollLeft += 14;
      drag.scrolled += list.scrollLeft - before;
    }
    drag.item.style.transform = wide ? `translate(${dx}px, ${dy + drag.scrolled}px)` : `translate(${dx + drag.scrolled}px, ${dy}px)`;
    const over = itemAt(event.clientX, event.clientY);
    for (const item of list.querySelectorAll(".drop-target")) item.classList.remove("drop-target");
    drag.over = over && over !== drag.item ? over : null;
    if (drag.over) drag.over.classList.add("drop-target");
  }
  function endDrag(commit) {
    if (!drag) return;
    const { item, over, active, key } = drag;
    drag = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onDragKey, true);
    item.style.transform = "";
    item.classList.remove("dragging");
    list.classList.remove("is-dragging");
    for (const entry of list.querySelectorAll(".drop-target")) entry.classList.remove("drop-target");
    if (active) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (commit && over) moveSlide(key, over.dataset.key);
    }
    if (renderWaiting) {
      renderWaiting = false;
      render();
    }
  }
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  const onDragKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      endDrag(false);
    }
  };
  function startDrag(event, key, item) {
    if (event.button !== 0 || event.pointerType === "touch") return;
    drag = { key, item, x: event.clientX, y: event.clientY, active: false, over: null, scrolled: 0 };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onDragKey, true);
  }

  function imageFor(key, url) {
    let img = images.get(key);
    if (!img) {
      img = h("img", { alt: "", draggable: false, class: "thumb-img" });
      images.set(key, img);
    }
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    return img;
  }

  function render() {
    const editor = state.editor;
    if (!editor) return;
    // Rebuilding the list would take the slide out from under the pointer: wait for the drop.
    if (drag && drag.active) {
      renderWaiting = true;
      return;
    }
    hideTip();
    const size = sizeOf(editor.size);
    const { slide: selected } = selectedSlide();
    const schema = state.schema;
    const atLimit = schema ? editor.slides.length >= schema.maxSlides : false;
    countEl.textContent = String(editor.slides.length);
    for (const key of [...images.keys()]) if (!editor.slides.some((slide) => slide.key === key)) images.delete(key);

    redraw(list, () => [
      editor.slides.map((slide, index) => {
        const shown = state.renders[slide.key];
        const problems = problemsOf(slide.key);
        const passed = Boolean(shown) && problems.length === 0;
        const isSelected = selected && selected.key === slide.key;
        const status = problems.length ? `${problems.length} layout issue${problems.length === 1 ? "" : "s"}: ${problems.join(". ")}` : passed ? "Layout check passed" : "Rendering";
        const item = h("li", { class: "thumb", dataset: { key: slide.key } });
        const button = h(
          "button",
          {
            type: "button",
            class: cx("thumb-button", isSelected && "is-selected"),
            style: { aspectRatio: `${size.w} / ${size.h}` },
            "aria-current": isSelected ? "true" : null,
            "aria-label": `Slide ${index + 1}, ${layoutName(slide.fields.layout)}. ${status}`,
            onclick: () => { if (!suppressClick) select(slide.key); },
            onpointerdown: (event) => startDrag(event, slide.key, item),
            onmouseenter: (event) => showTip(event.currentTarget, problems),
            onmouseleave: hideTip,
            onfocus: (event) => showTip(event.currentTarget, problems),
            onblur: hideTip,
          },
          shown && shown.url ? imageFor(slide.key, shown.url) : h("span", { class: "thumb-wait" })
        );
        item.append(
          h(
            "div",
            { class: "thumb-head" },
            h("span", { class: cx("thumb-number", isSelected && "is-selected") }, String(index + 1)),
            problems.length > 0
              ? h("span", { class: "badge badge-bad", title: problems.join("\n") }, icon("warning", 12))
              : passed
                ? h("span", { class: "badge badge-ok" }, icon("check", 12))
                : icon("spinner", 14, "muted-3")
          ),
          button,
          h(
            "div",
            { class: "thumb-actions wide-only-flex" },
            IconButton({ label: `Duplicate slide ${index + 1}`, class: "thumb-action", onclick: () => duplicateSlide(slide.key) }, "copy"),
            IconButton({ label: `Delete slide ${index + 1}`, class: "thumb-action thumb-delete", disabled: editor.slides.length <= 1, onclick: () => deleteSlide(slide.key) }, "trash")
          )
        );
        return item;
      }),
      h("li", { class: "strip-add wide-only" }, h("button", { type: "button", class: "add-slide", disabled: atLimit, onclick: () => addSlide(selected ? selected.key : null) }, icon("plus", 16), "Add slide")),
    ]);

    // A press that has not become a drag yet keeps pointing at the slide it started on.
    if (drag) drag.item = list.querySelector(`li[data-key="${drag.key}"]`) || drag.item;

    // Phone: the actions for the selected slide sit under the row of thumbnails.
    const { index } = selectedSlide();
    redraw(actionsEl, () => [
      Button({ icon: "plus", disabled: atLimit, class: "grow tall", onclick: () => addSlide(selected ? selected.key : null) }, "Add"),
      Button({ icon: "copy", disabled: !selected, class: "grow tall", onclick: () => selected && duplicateSlide(selected.key) }, "Copy"),
      IconButton({ label: "Move this slide earlier", variant: "secondary", class: "tall-icon", disabled: !selected || index === 0, onclick: () => moveSelected(-1) }, "left"),
      IconButton({ label: "Move this slide later", variant: "secondary", class: "tall-icon", disabled: !selected || index >= editor.slides.length - 1, onclick: () => moveSelected(1) }, "right"),
      IconButton({ label: "Delete this slide", variant: "danger", class: "tall-icon", disabled: !selected || editor.slides.length <= 1, onclick: () => selected && deleteSlide(selected.key) }, "trash"),
    ]);

    redraw(warnEl, () => (schema && editor.slides.length > schema.warnSlides ? h("p", { class: "strip-warn" }, `Over ${schema.warnSlides} slides. Some platforms stop at ${schema.warnSlides} images.`) : null));

    if (selected && selected.key !== lastSelected) {
      lastSelected = selected.key;
      const current = list.querySelector(`li[data-key="${selected.key}"]`);
      if (current && typeof current.scrollIntoView === "function") current.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  render();
  const stop = watch(["editor", "selectedKey", "renders", "fieldErrors", "schema", "templates"], render);
  return { el: root, dispose: () => { stop(); endDrag(false); } };
}
