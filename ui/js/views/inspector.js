// The inspector: four tabs for the selected slide and the brand. A column on the right
// on a wide screen, a bottom sheet with the same four tabs on a phone.

import { ApiError, errorText } from "../api.js";
import { AutoTextArea, Button, Field, IconButton, InlineError, Notice, Segmented, Spinner, StatusDot, Switch, TextInput, cx, h, icon, redraw } from "../dom.js";
import {
  buildTemplatePreviews, countWords, derivedShades, emit, ensureTemplatePreviews, flushBrand, generateImage, isHex, normalizeHashtag, searchImages, selectedSlide,
  set, setBackground, setField, setTint, sizeOf, state, switchLayout, updateBrand, uploadImage, watch,
} from "../state.js";
import { layoutName } from "./strip.js";

export const INSPECTOR_TABS = [
  { id: "content", label: "Content", sheetLabel: "Edit text", icon: "type" },
  { id: "templates", label: "Templates", sheetLabel: "Templates", icon: "grid" },
  { id: "brand", label: "Brand", sheetLabel: "Brand", icon: "palette" },
  { id: "background", label: "Background", sheetLabel: "Background", icon: "image" },
];

const LABELS = {
  eyebrow: "Small label above", headline: "Headline", sub: "Supporting line", photo: "Photo", number: "Number", unit: "What the number means",
  avatar: "Profile photo", name: "Name", text: "Post text", app: "App name", title: "Title", lines: "Lines", step: "Step number", body: "Body",
  prompt_label: "Box label", prompt: "Box text", a_label: "First label", a_text: "First statement", b_label: "Second label", b_text: "Second statement",
  bars: "Bars", col_a: "Left column label", col_b: "Right column label", row_a: "Top row label", row_b: "Bottom row label", quads: "Quadrants",
  lead: "Lead-in", keyword: "Keyword", promise: "What they get", byline: "Byline", logo: "Logo", path: "Line direction", items: "Points",
  label: "Label", value: "Value", display: "Shown as", highlight: "Lit",
};
const HINTS = {
  photo: "Leave empty to use your brand portrait.", avatar: "Leave empty to use your brand portrait.", logo: "Leave empty to use your brand logo.",
  name: "Leave empty to use your brand name.", byline: "Leave empty to use your brand byline.", prompt: "Shown in a box, for something to copy.",
  keyword: "The one word people comment or remember.", number: "The stat itself, for example 38% or 5am.",
};
const ENUM_LABELS = { "high-low": "High to low", "low-high": "Low to high" };
const OVER_LIMIT = "Over the limit. Long copy shrinks and may fail the layout check.";

function labelOf(name) {
  return LABELS[name] || name.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

// Upload errors by field id, so a redraw that lands during an upload does not swallow one.
const uploadErrors = new Map();

// An image path with an upload button beside it. The upload goes to the library.
function ImageField({ id, value, onType, onUpload, hint, error }) {
  const noteId = `${id}-note`;
  const noteOf = (problem) => (problem ? h("p", { class: "field-error", role: "alert" }, problem) : hint ? h("p", { class: "hint" }, hint) : null);
  const showNote = () => {
    const node = document.getElementById(noteId);
    if (node) redraw(node, () => noteOf(error || uploadErrors.get(id) || null));
  };
  const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  const button = Button({ id: `${id}-upload`, icon: "upload", onclick: () => picker.click() }, "Upload");
  picker.addEventListener("change", async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    uploadErrors.delete(id);
    try {
      const saved = await uploadImage(file);
      onUpload(saved.src);
      const field = document.getElementById(id);
      if (field) field.value = saved.src;
    } catch (caught) {
      uploadErrors.set(id, errorText(caught));
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      picker.value = "";
      showNote();
    }
  });
  return h(
    "div",
    { class: "stack-xs" },
    h("div", { class: "row" }, TextInput({ id, value, placeholder: "library/name.png or https link", oninput: (event) => { uploadErrors.delete(id); onType(event.target.value); } }), picker, button),
    h("div", { id: noteId }, noteOf(error || uploadErrors.get(id) || null))
  );
}

export function Inspector() {
  const tabsEl = h("div", { role: "tablist", "aria-label": "Inspector", class: "tabs" });
  const panel = h("div", { role: "tabpanel", id: "inspector-panel", class: "inspector-panel" });
  const root = h(
    "aside",
    { "aria-label": "Slide inspector", class: "inspector" },
    h("div", { class: "inspector-head" }, tabsEl, IconButton({ label: "Close the editor panel", class: "narrow-only-flex", onclick: () => set({ sheetOpen: false }) }, "x", 18)),
    panel
  );

  // What each tab keeps between redraws.
  const brandUi = { moreColours: false, autoShades: true, tagDraft: "" };
  const bg = { query: "", searching: false, results: [], tried: [], searched: false, searchError: null, picked: null, prompt: "", generating: null, generateError: null, uploading: false, started: false };
  let shownFor = "";

  const draw = () => {
    if (!state.editor) return;
    redraw(panel, () => TABS[state.tab]());
    if (state.tab === "brand") drawBrandSave();
    panel.setAttribute("aria-labelledby", `inspector-tab-${state.tab}`);
    // A new tab or a new slide starts at the top of the panel.
    const mark = `${state.tab}:${state.selectedKey}`;
    if (mark !== shownFor) {
      shownFor = mark;
      panel.scrollTop = 0;
    }
  };

  function drawTabs() {
    redraw(tabsEl, () =>
      INSPECTOR_TABS.map((entry, index) => {
        const active = entry.id === state.tab;
        return h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `inspector-tab-${entry.id}`,
            "aria-selected": active ? "true" : "false",
            "aria-controls": "inspector-panel",
            tabindex: active ? "0" : "-1",
            class: cx("tab", active && "is-active"),
            onclick: () => set({ tab: entry.id }),
            onkeydown: (event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next = INSPECTOR_TABS[(index + step + INSPECTOR_TABS.length) % INSPECTOR_TABS.length];
              set({ tab: next.id });
              queueMicrotask(() => queueMicrotask(() => { const node = document.getElementById(`inspector-tab-${next.id}`); if (node) node.focus(); }));
            },
          },
          entry.label
        );
      })
    );
    root.classList.toggle("is-open", state.sheetOpen);
  }

  // -------------------------------------------------------------------------
  // Content: the selected template's fields, straight from the engine's schema
  // -------------------------------------------------------------------------

  function contentTab() {
    const schema = state.schema;
    const { slide, index } = selectedSlide();
    if (!schema || !slide) return null;
    const spec = schema.layouts[slide.fields.layout];
    if (!spec) return InlineError({ message: `This slide uses a template the engine does not know: ${slide.fields.layout}. Pick another one in the Templates tab.` });
    const key = slide.key;
    const fields = slide.fields;
    const caps = spec.wordCaps || {};
    const required = spec.required || [];
    const latest = (name) => {
      const found = state.editor ? state.editor.slides.find((entry) => entry.key === key) : null;
      return found ? found.fields[name] : undefined;
    };
    const errorsFor = (name) => state.fieldErrors.filter((entry) => entry.key === key && entry.field === name).map((entry) => entry.message).join(" ") || null;
    const idFor = (name) => `field-${key}-${name}`;
    const shown = state.renders[key];

    const renderField = (name, fieldSpec) => {
      const value = fields[name];
      const cap = caps[name];
      const title = `${labelOf(name)}${required.includes(name) ? "" : " (optional)"}`;
      const error = errorsFor(name);

      if (fieldSpec.type === "image") {
        return Field({ label: title, htmlFor: idFor(name) }, ImageField({ id: idFor(name), value: typeof value === "string" ? value : "", hint: HINTS[name], error, onType: (next) => setField(key, name, next, { quiet: true }), onUpload: (src) => setField(key, name, src) }));
      }
      if (fieldSpec.type === "enum") {
        return Field({ label: labelOf(name), error }, Segmented({ label: labelOf(name), class: "full", idBase: idFor(name), value: typeof value === "string" ? value : (fieldSpec.values || [])[0] || "", onChange: (next) => setField(key, name, next), options: (fieldSpec.values || []).map((option) => ({ id: option, label: ENUM_LABELS[option] || option })) }));
      }
      if (fieldSpec.type === "number") {
        return Field({ label: title, htmlFor: idFor(name), error }, TextInput({ id: idFor(name), type: "number", value: typeof value === "number" ? String(value) : "", oninput: (event) => setField(key, name, event.target.value === "" ? "" : Number(event.target.value), { quiet: true }) }));
      }
      if (fieldSpec.type === "boolean") {
        return Switch({ id: idFor(name), label: labelOf(name), checked: value === true, onChange: (next) => setField(key, name, next ? true : "", { quiet: true }) });
      }
      if (fieldSpec.type === "list") {
        const list = Array.isArray(value) ? value : [];
        const min = fieldSpec.minItems || 0;
        const max = fieldSpec.maxItems || 12;
        const fixed = min === max;
        const trailing = h("span", { class: "muted-3" }, fixed ? `${max} items` : `${list.length} of ${max}`);
        const now = () => (Array.isArray(latest(name)) ? latest(name) : []);

        if (fieldSpec.item === "text") {
          return Field(
            { label: labelOf(name), error, trailing, hint: cap ? `Up to ${cap} words each.` : undefined },
            h(
              "div",
              { class: "stack-sm" },
              list.map((item, at) =>
                h(
                  "div",
                  { class: "row top" },
                  AutoTextArea({
                    id: `${idFor(name)}-${at}`,
                    "aria-label": `${labelOf(name)} ${at + 1}`,
                    value: typeof item === "string" ? item : String(item === null || item === undefined ? "" : item),
                    class: cap && countWords(item) > cap ? "is-over" : "",
                    oninput: (event) => {
                      event.target.classList.toggle("is-over", Boolean(cap) && countWords(event.target.value) > cap);
                      setField(key, name, now().map((entry, position) => (position === at ? event.target.value : entry)), { quiet: true });
                    },
                  }),
                  fixed ? null : IconButton({ label: `Remove ${labelOf(name).toLowerCase()} ${at + 1}`, disabled: list.length <= min, onclick: () => setField(key, name, now().filter((_, position) => position !== at)) }, "trash")
                )
              ),
              !fixed && list.length < max ? Button({ variant: "ghost", icon: "plus", onclick: () => setField(key, name, [...now(), ""]) }, "Add another") : null
            )
          );
        }

        const itemSpec = fieldSpec.item && typeof fieldSpec.item === "object" ? fieldSpec.item : {};
        const rows = list.map((item) => (item && typeof item === "object" ? item : {}));
        const rowsNow = () => now().map((item) => (item && typeof item === "object" ? item : {}));
        const update = (at, sub, next, quiet) => {
          setField(
            key,
            name,
            rowsNow().map((row, position) => {
              if (position !== at) return sub === "highlight" && next === true ? { ...row, highlight: false } : row;
              const changed = { ...row };
              if (next === "" || next === undefined || next === false) delete changed[sub];
              else changed[sub] = next;
              return changed;
            }),
            { quiet }
          );
        };
        return Field(
          { label: labelOf(name), error, trailing },
          h(
            "div",
            { class: "stack-sm" },
            rows.map((row, at) =>
              h(
                "div",
                { class: "item-card" },
                h(
                  "div",
                  { class: "row" },
                  h("span", { class: "item-index" }, String(at + 1)),
                  h(
                    "div",
                    { class: "item-grid" },
                    Object.entries(itemSpec)
                      .filter(([, sub]) => sub.type !== "boolean")
                      .map(([sub, subSpec]) =>
                        TextInput({
                          id: `${idFor(name)}-${at}-${sub}`,
                          "aria-label": `${labelOf(name)} ${at + 1}: ${labelOf(sub)}`,
                          placeholder: labelOf(sub),
                          type: subSpec.type === "number" ? "number" : "text",
                          value: row[sub] === undefined || row[sub] === null ? "" : String(row[sub]),
                          class: sub === "label" || sub === "title" ? "span-2" : "",
                          oninput: (event) => update(at, sub, subSpec.type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value, true),
                        })
                      )
                  ),
                  fixed ? null : IconButton({ label: `Remove item ${at + 1}`, disabled: rows.length <= min, onclick: () => setField(key, name, rowsNow().filter((_, position) => position !== at)) }, "trash")
                ),
                itemSpec.highlight ? Switch({ id: `${idFor(name)}-${at}-highlight`, label: "Light this one up", checked: row.highlight === true, onChange: (next) => update(at, "highlight", next, false) }) : null
              )
            ),
            !fixed && rows.length < max ? Button({ variant: "ghost", icon: "plus", onclick: () => setField(key, name, [...rowsNow(), name === "bars" ? { label: "", value: 50 } : {}]) }, "Add another") : null
          )
        );
      }

      // Plain text, with a word count beside every field that has a limit. The counter and the
      // note are found by id when they are written: the field can outlive the nodes around it.
      const fieldId = idFor(name);
      const noteOf = (over) => {
        const hint = over ? OVER_LIMIT : HINTS[name];
        return error ? h("p", { class: "field-error", role: "alert" }, error) : hint ? h("p", { class: cx("hint", over && "warn-text") }, hint) : null;
      };
      const count = (current, field) => {
        const words = countWords(current);
        const over = Boolean(cap) && words > cap;
        const counter = document.getElementById(`${fieldId}-count`);
        if (counter) {
          counter.textContent = `${words} / ${cap} words`;
          counter.classList.toggle("is-over", over);
        }
        if (field) field.classList.toggle("is-over", over);
        const note = document.getElementById(`${fieldId}-note`);
        if (note) redraw(note, () => noteOf(over));
      };
      const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
      const startsOver = Boolean(cap) && countWords(text) > cap;
      const input = AutoTextArea({
        id: fieldId,
        value: text,
        class: startsOver ? "is-over" : "",
        "aria-invalid": error ? "true" : null,
        oninput: (event) => {
          setField(key, name, event.target.value, { quiet: true });
          count(event.target.value, event.target);
        },
      });
      return h(
        "div",
        { class: "field" },
        h("div", { class: "field-head" }, h("label", { class: "field-label", for: fieldId }, title), cap ? h("span", { id: `${fieldId}-count`, class: cx("word-count", startsOver && "is-over") }, `${countWords(text)} / ${cap} words`) : null),
        input,
        h("div", { id: `${fieldId}-note` }, noteOf(startsOver))
      );
    };

    const known = new Set(Object.keys(spec.fields));
    const loose = state.fieldErrors.filter((entry) => entry.key === key && !known.has(entry.field));
    return h(
      "div",
      { class: "stack" },
      h("div", null, h("h3", { class: "tab-title" }, `Slide ${index + 1}: ${layoutName(slide.fields.layout)}`), h("p", { class: "hint" }, spec.purpose || spec.use || "")),
      shown && shown.issues.length > 0 ? InlineError({ message: shown.issues.join("\n") }) : null,
      loose.length > 0 ? InlineError({ message: loose.map((entry) => `${entry.field}: ${entry.message}`).join("\n") }) : null,
      Notice(null, "Wrap a word in ", h("code", { class: "accent-code" }, "*asterisks*"), " to give it the accent colour."),
      Object.entries(spec.fields).map(([name, fieldSpec]) => renderField(name, fieldSpec))
    );
  }

  // -------------------------------------------------------------------------
  // Templates: the picker, grouped by the job a slide does
  // -------------------------------------------------------------------------

  function templatesTab() {
    const schema = state.schema;
    const { slide, index } = selectedSlide();
    if (!schema || !slide) return null;
    const found = state.templates;
    const size = sizeOf(state.editor.size);
    // Without the template list the schema still names every layout.
    const rows = found && found.templates.length ? found.templates : Object.entries(schema.layouts).map(([id, spec]) => ({ id, name: spec.name || spec.title || id, purpose: spec.purpose || spec.use || "", group: "point", supportsBackground: schema.backgroundLayouts.includes(id), preview: null }));
    const groups = found && Array.isArray(found.groups) && found.groups.length ? found.groups : [{ id: "point", label: "Templates", hint: "" }];
    const sameSize = !found || found.size === state.editor.size;
    const canBuild = Boolean(found && found.previews && found.previews.available);
    const missing = found && found.previews ? found.previews.total - found.previews.ready : 0;

    const tile = (row) => {
      const active = slide.fields.layout === row.id;
      const known = Boolean(schema.layouts[row.id]);
      return h(
        "button",
        { type: "button", id: `template-${row.id}`, class: cx("template", active && "is-active"), "aria-pressed": active ? "true" : "false", disabled: !known, onclick: () => switchLayout(slide.key, row.id) },
        h(
          "span",
          { class: "template-shot", style: { aspectRatio: `${size.w} / ${size.h}` } },
          row.preview && sameSize
            ? h("img", { src: row.preview, alt: "", loading: "lazy", draggable: false })
            : h("span", { class: "template-blank", "aria-hidden": "true" }, h("span", { class: "blank-bar blank-accent" }), h("span", { class: "blank-bar" }), h("span", { class: "blank-bar blank-short" })),
          row.supportsBackground ? h("span", { class: "template-mark", title: "Can show a background image" }, icon("image", 13), h("span", { class: "sr-only" }, "Can show a background image")) : null,
          active ? h("span", { class: "template-on" }, icon("check", 12), "In use") : null
        ),
        h("span", { class: "template-name" }, row.name),
        row.purpose ? h("span", { class: "template-purpose" }, row.purpose) : null
      );
    };

    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        null,
        h("h3", { class: "tab-title" }, `Template for slide ${index + 1}`),
        h("p", { class: "hint" }, "Pick the one that fits the job of this slide. Your text moves with it wherever the fields match.")
      ),
      state.templatesError ? InlineError({ message: state.templatesError, onRetry: () => { set({ templatesError: null }); buildTemplatePreviews(false); } }) : null,
      state.templatesBusy ? h("div", { class: "busy-line" }, Spinner("Drawing the previews in your brand")) : null,
      !state.templatesBusy && canBuild && missing === 0 && sameSize
        ? h("div", { class: "row between" }, h("span", { class: "muted-3" }, "Previews are drawn in your brand."), Button({ variant: "ghost", onclick: () => buildTemplatePreviews(true) }, "Redraw"))
        : null,
      found && !canBuild ? h("p", { class: "hint" }, "Preview images are not part of this install, so the picker shows plain tiles.") : null,
      groups.map((group) => {
        const inGroup = rows.filter((row) => row.group === group.id);
        if (!inGroup.length) return null;
        return h(
          "section",
          { class: "stack-sm", "aria-label": group.label },
          h("div", null, h("h4", { class: "group-title" }, group.label), group.hint ? h("p", { class: "hint" }, group.hint) : null),
          h("div", { class: "template-grid" }, inGroup.map(tile))
        );
      }),
      h("p", { class: "hint mark-note" }, icon("image", 14), "Templates with this mark can show a background image.")
    );
  }

  // -------------------------------------------------------------------------
  // Brand: the brand kit that restyles every template
  // -------------------------------------------------------------------------

  const MAIN_COLOURS = [
    { key: "accent", label: "Accent", hint: "Rules, labels and the accent word." },
    { key: "bg", label: "Background", hint: "The slide background." },
    { key: "text", label: "Text", hint: "Needs strong contrast with the background." },
  ];
  const SHADE_COLOURS = [
    { key: "accentSoft", label: "Accent word" },
    { key: "highlight", label: "Bold highlight" },
    { key: "bgDeep", label: "Deep background" },
    { key: "bgAlt", label: "Panel background" },
  ];
  const CHROME = [
    { key: "showByline", label: "Logo and byline", description: "At the top of every slide." },
    { key: "showCounter", label: "Slide counter", description: "For example 03 / 08, top right." },
    { key: "showProgress", label: "Progress bar", description: "Along the bottom edge." },
    { key: "showCue", label: "Swipe cue", description: "Swipe on each slide, Save this on the last." },
    { key: "showCorners", label: "Corner marks", description: "Two thin marks in the accent colour." },
  ];

  function colourField(entry, main) {
    const brand = state.brand;
    const value = brand.colors[entry.key];
    const apply = (hex, quiet) => {
      const colors = { [entry.key]: hex };
      const current = state.brand.colors;
      if (main && brandUi.autoShades) Object.assign(colors, derivedShades({ bg: current.bg, text: current.text, accent: current.accent, [entry.key]: hex }));
      if (!main) brandUi.autoShades = false;
      updateBrand({ colors }, { quiet });
    };
    const hexId = `brand-colour-${entry.key}-hex`;
    const pickerId = `brand-colour-${entry.key}`;
    const hexInput = h("input", {
      type: "text",
      id: hexId,
      class: "input hex-input",
      "aria-label": `${entry.label} hex value`,
      value,
      spellcheck: "false",
      maxlength: "7",
      oninput: (event) => {
        const next = event.target.value.trim();
        const valid = isHex(next);
        event.target.classList.toggle("is-invalid", !valid);
        if (valid) {
          const partner = document.getElementById(pickerId);
          if (partner) partner.value = next.toLowerCase();
          apply(next.toUpperCase(), true);
        }
      },
      onblur: (event) => {
        if (!isHex(event.target.value.trim())) {
          event.target.value = state.brand.colors[entry.key];
          event.target.classList.remove("is-invalid");
        }
      },
      onchange: () => emit("brand"),
    });
    const picker = h("input", {
      type: "color",
      id: pickerId,
      class: "colour-input",
      "aria-label": `${entry.label} colour picker`,
      value: isHex(value) ? value.toLowerCase() : "#000000",
      // While the picker is open only the hex box follows. The picker itself is the focused
      // field, so a redraw of the tab leaves it (and its open popup) alone.
      oninput: (event) => {
        const partner = document.getElementById(hexId);
        if (partner) {
          partner.value = event.target.value.toUpperCase();
          partner.classList.remove("is-invalid");
        }
        apply(event.target.value.toUpperCase(), true);
      },
      onchange: () => emit("brand"),
    });
    return h("div", { class: "colour-row" }, picker, h("div", { class: "colour-text" }, h("p", { class: "field-label" }, entry.label), entry.hint ? h("p", { class: "hint" }, entry.hint) : null), hexInput);
  }

  // The save state of the brand has its own small region, so "Saving" and "Saved" never
  // rebuild the tab under the field being edited.
  function drawBrandSave() {
    const save = state.brandSave;
    const status = document.getElementById("brand-save-status");
    if (status) redraw(status, () => (save.status === "saving" ? "Saving" : save.status === "saved" ? h("span", { class: "status-line good" }, icon("check", 14), "Saved") : null));
    const problem = document.getElementById("brand-save-error");
    if (problem) redraw(problem, () => (save.status === "error" && save.error ? InlineError({ message: `Your brand changes are not saved yet. ${save.error}`, onRetry: () => flushBrand() }) : null));
  }

  function brandTab() {
    const brand = state.brand;
    if (!brand) return Spinner("Loading your brand kit");
    const addTag = (input) => {
      const tag = normalizeHashtag(input.value);
      input.value = "";
      brandUi.tagDraft = "";
      if (tag && !state.brand.defaultHashtags.includes(tag)) updateBrand({ defaultHashtags: [...state.brand.defaultHashtags, tag] });
    };
    const heading = (text) => h("h3", { class: "eyebrow" }, text);
    return h(
      "div",
      { class: "stack-lg" },
      h(
        "div",
        { class: "row between top" },
        h("p", { class: "muted" }, "Your brand kit styles every carousel, not only this one."),
        h("span", { id: "brand-save-status", class: "muted-3 nowrap", "aria-live": "polite" })
      ),
      h("div", { id: "brand-save-error" }),
      state.brandWarnings.length > 0 ? InlineError({ message: state.brandWarnings.join("\n") }) : null,

      h(
        "section",
        { class: "stack", "aria-label": "Identity" },
        heading("Identity"),
        Field({ label: "Name", htmlFor: "brand-name", hint: "Your name or business name. Shown on the post card template." }, TextInput({ id: "brand-name", value: brand.name, maxlength: "80", oninput: (event) => updateBrand({ name: event.target.value }, { quiet: true }) })),
        Field({ label: "Handle", htmlFor: "brand-handle", hint: "Used when drafting captions. Never printed on a slide." }, TextInput({ id: "brand-handle", value: brand.handle, maxlength: "80", placeholder: "yourhandle", oninput: (event) => updateBrand({ handle: event.target.value }, { quiet: true }) })),
        Field({ label: "Byline", htmlFor: "brand-byline", hint: "One line beside the logo and on the call to action slide. **bold** and *accent* work here." }, AutoTextArea({ id: "brand-byline", value: brand.byline, maxlength: "200", oninput: (event) => updateBrand({ byline: event.target.value }, { quiet: true }) }))
      ),

      h(
        "section",
        { class: "stack", "aria-label": "Colours" },
        heading("Colours"),
        MAIN_COLOURS.map((entry) => colourField(entry, true)),
        Switch({ id: "brand-auto-shades", label: "Match the shades automatically", description: "Tints and panels follow the three colours above.", checked: brandUi.autoShades, onChange: (next) => { brandUi.autoShades = next; } }),
        h("button", { type: "button", id: "brand-more-colours", class: "disclosure", "aria-expanded": brandUi.moreColours ? "true" : "false", onclick: () => { brandUi.moreColours = !brandUi.moreColours; draw(); } }, icon("down", 16, "disclosure-icon"), brandUi.moreColours ? "Hide the shades" : "Fine tune the shades"),
        brandUi.moreColours ? SHADE_COLOURS.map((entry) => colourField(entry, false)) : null
      ),

      h(
        "section",
        { class: "stack-xs", "aria-label": "Slide extras" },
        heading("On every slide"),
        CHROME.map((entry) => Switch({ id: `brand-chrome-${entry.key}`, label: entry.label, description: entry.description, checked: brand.chrome[entry.key] === true, onChange: (next) => updateBrand({ chrome: { [entry.key]: next } }, { quiet: true }) }))
      ),

      h(
        "section",
        { class: "stack", "aria-label": "Images" },
        heading("Logo and portrait"),
        ["logo", "portrait"].map((key) =>
          Field(
            { label: key === "logo" ? "Logo" : "Portrait", htmlFor: `brand-${key}` },
            h(
              "div",
              { class: "row top" },
              h("span", { class: cx("brand-shot", key === "portrait" && "is-round") }, state.brandPreviews[key] ? h("img", { src: state.brandPreviews[key], alt: `Current ${key}` }) : "None"),
              h(
                "div",
                { class: "grow min-0" },
                ImageField({
                  id: `brand-${key}`,
                  value: brand[key] || "",
                  hint: key === "logo" ? "A square logo. Shown with the byline and on the call to action slide." : "Used by the cover, post card and call to action templates.",
                  onType: (next) => updateBrand({ [key]: next || null }, { quiet: true }),
                  onUpload: (src) => updateBrand({ [key]: src }, { now: true }),
                })
              )
            )
          )
        )
      ),

      h(
        "section",
        { class: "stack-sm", "aria-label": "Default hashtags" },
        heading("Default hashtags"),
        h("p", { class: "hint" }, "Added to every drafted caption."),
        brand.defaultHashtags.length > 0
          ? h("ul", { class: "tags" }, brand.defaultHashtags.map((tag) => h("li", { class: "tag" }, tag, h("button", { type: "button", class: "tag-remove", "aria-label": `Remove ${tag}`, onclick: () => updateBrand({ defaultHashtags: state.brand.defaultHashtags.filter((entry) => entry !== tag) }) }, icon("x", 15)))))
          : null,
        h(
          "form",
          { onsubmit: (event) => { event.preventDefault(); addTag(event.target.querySelector("input")); } },
          h("label", { for: "brand-hashtag", class: "sr-only" }, "Add a default hashtag"),
          TextInput({ id: "brand-hashtag", value: brandUi.tagDraft, placeholder: "Type a hashtag and press Enter", oninput: (event) => { brandUi.tagDraft = event.target.value; }, onblur: (event) => { if (event.target.value.trim()) addTag(event.target); } })
        )
      )
    );
  }

  // -------------------------------------------------------------------------
  // Background: find or generate an image, then apply it to this slide or to all
  // -------------------------------------------------------------------------

  const PROVIDER_NAMES = {
    library: "Your library", pexels: "Pexels", unsplash: "Unsplash", "codex-imagegen": "Codex image generation", "openai-image": "OpenAI Images",
    huggingface: "Hugging Face (FLUX)", whisk: "Whisk module", "open-generative-ai": "Open Generative AI module",
  };
  const DEFAULT_TINT = 0.6;
  const providerName = (id) => PROVIDER_NAMES[id] || id;
  const toneOf = (status) => (status === "ok" ? "ok" : status === "error" ? "bad" : "off");
  function triedLine(entry) {
    if (entry.status === "ok") return "found images";
    if (entry.status === "empty") return entry.detail || "no match";
    if (entry.status === "not_configured") return `not connected: ${entry.detail}`;
    return entry.detail || entry.status;
  }
  const redrawBackground = () => { if (state.tab === "background") draw(); };

  async function search(text) {
    bg.searching = true;
    bg.searchError = null;
    redrawBackground();
    try {
      const found = await searchImages(text);
      bg.results = found.results || [];
      bg.tried = found.tried || [];
    } catch (error) {
      bg.results = [];
      bg.tried = error instanceof ApiError && error.payload && Array.isArray(error.payload.tried) ? error.payload.tried : [];
      bg.searchError = errorText(error);
    } finally {
      bg.searching = false;
      bg.searched = true;
      redrawBackground();
    }
  }

  async function generateWith(provider) {
    bg.generating = provider;
    bg.generateError = null;
    redrawBackground();
    try {
      const made = await generateImage(bg.prompt, provider);
      if (!made.results || made.results.length === 0) {
        bg.generateError = (made.tried || []).map((entry) => `${providerName(entry.id)}: ${triedLine(entry)}`).join("\n") || "The generator returned no image.";
      } else {
        bg.results = [...made.results, ...bg.results];
        bg.picked = made.results[0];
      }
    } catch (error) {
      bg.generateError = errorText(error);
    } finally {
      bg.generating = null;
      redrawBackground();
    }
  }

  async function uploadBackground(file) {
    if (!file) return;
    bg.uploading = true;
    bg.searchError = null;
    redrawBackground();
    try {
      const saved = await uploadImage(file);
      const added = { src: saved.src, thumb: saved.thumb, credit: "Your library", license: "", provider: "library" };
      bg.results = [added, ...bg.results];
      bg.picked = added;
    } catch (error) {
      bg.searchError = errorText(error);
    } finally {
      bg.uploading = false;
      redrawBackground();
    }
  }

  function backgroundTab() {
    const schema = state.schema;
    const editor = state.editor;
    const { slide } = selectedSlide();
    if (!schema || !slide || !editor) return null;
    // Opening the tab lists the images already in the library.
    if (!bg.started) {
      bg.started = true;
      queueMicrotask(() => search(""));
    }
    const doctor = state.doctor;
    const takes = schema.backgroundLayouts.includes(slide.fields.layout);
    const takers = editor.slides.filter((entry) => schema.backgroundLayouts.includes(entry.fields.layout)).length;
    const current = slide.fields.background && typeof slide.fields.background === "object" ? slide.fields.background : null;
    const tint = current && typeof current.tint === "number" ? current.tint : DEFAULT_TINT;
    const credit = typeof slide.fields._credit === "string" ? slide.fields._credit : "";
    const rows = (doctor && doctor.images) || [];
    const generators = rows.filter((row) => row.kind === "generate");
    const searchRows = rows.filter((row) => row.kind === "search");
    // Every search source with its wired state, and what the last search got from it.
    const sources = [
      ...searchRows.map((row) => {
        const outcome = bg.tried.find((entry) => entry.id === row.id);
        const ready = row.enabled && row.configured;
        if (outcome) return { id: row.id, tone: toneOf(outcome.status), line: triedLine(outcome) };
        return { id: row.id, tone: ready ? "ok" : "off", line: ready ? "ready" : `not connected: ${row.enabled ? row.detail : "switched off in providers.json"}` };
      }),
      ...bg.tried.filter((entry) => !searchRows.some((row) => row.id === entry.id)).map((entry) => ({ id: entry.id, tone: toneOf(entry.status), line: triedLine(entry) })),
    ];
    const layoutNames = schema.backgroundLayouts.map((id) => layoutName(id)).join(", ");
    // The tint is read when the button is pressed: the slider does not redraw this tab.
    const tintNow = () => {
      const found = state.editor ? state.editor.slides.find((entry) => entry.key === slide.key) : null;
      const now = found && found.fields.background && typeof found.fields.background === "object" ? found.fields.background.tint : undefined;
      return typeof now === "number" ? now : tint;
    };
    const apply = (scope) => {
      if (!bg.picked) return;
      setBackground(scope === "all" ? "all" : { key: slide.key }, { src: bg.picked.src, tint: tintNow() }, bg.picked.credit);
    };
    const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "sr-only", tabindex: "-1", "aria-hidden": "true", onchange: (event) => uploadBackground(event.target.files && event.target.files[0]) });
    const tintId = `background-tint-${slide.key}`;
    const tintValue = h("span", { id: `${tintId}-value`, class: "muted tnum" }, `${Math.round(tint * 100)}%`);
    const heading = (text) => h("h3", { class: "eyebrow" }, text);

    return h(
      "div",
      { class: "stack-lg" },
      !takes
        ? Notice({ tone: "warn" }, `The ${layoutName(slide.fields.layout)} template does not show a background image. These do: ${layoutNames}. Switch the template, or apply an image to all ${takers} slide${takers === 1 ? "" : "s"} that can show one.`)
        : null,

      takes && current && current.src
        ? h(
            "section",
            { "aria-label": "Current background", class: "subcard stack-sm" },
            h(
              "div",
              { class: "row between" },
              h("div", { class: "min-0" }, h("p", { class: "field-label" }, "This slide has a background"), credit ? h("p", { class: "muted-3 truncate" }, credit) : null),
              Button({ variant: "danger", icon: "trash", onclick: () => setBackground({ key: slide.key }, null) }, "Remove")
            ),
            Field(
              { label: "Tint", htmlFor: tintId, trailing: tintValue, hint: "How strongly your background colour covers the photo. Higher keeps the text readable." },
              h("input", { id: tintId, type: "range", min: "0", max: "1", step: "0.05", value: String(tint), class: "range", oninput: (event) => { const next = Number(event.target.value); const shown = document.getElementById(`${tintId}-value`); if (shown) shown.textContent = `${Math.round(next * 100)}%`; setTint({ key: slide.key }, next, true); } })
            ),
            Button({ variant: "ghost", onclick: () => setTint("all", tintNow()) }, "Use this tint on every background")
          )
        : null,

      h(
        "section",
        { "aria-label": "Find an image", class: "stack" },
        heading("Find an image"),
        h(
          "form",
          { class: "row", onsubmit: (event) => { event.preventDefault(); search(bg.query); } },
          h("label", { for: "background-query", class: "sr-only" }, "Search for a background image"),
          TextInput({ id: "background-query", value: bg.query, placeholder: "For example: warm bakery counter", oninput: (event) => { bg.query = event.target.value; } }),
          Button({ type: "submit", variant: "primary", busy: bg.searching, icon: "search" }, "Search")
        ),
        picker,
        Button({ busy: bg.uploading, icon: "upload", onclick: () => picker.click() }, "Upload your own image"),
        bg.searchError ? InlineError({ message: bg.searchError, onRetry: () => search(bg.query) }) : null,
        bg.searching && bg.results.length === 0 ? Spinner("Searching the image sources") : null,

        bg.results.length > 0
          ? h(
              "div",
              { class: "subcard stack-sm" },
              h("p", { class: "muted" }, bg.picked ? (bg.picked.credit && bg.picked.credit !== "Your library" ? `Selected: ${bg.picked.credit}. Put the credit in your caption.` : "Image selected. Where should it go?") : "Pick an image below, then choose where it goes."),
              h(
                "div",
                { class: "row wrap" },
                Button({ variant: "primary", class: "grow", disabled: !bg.picked || !takes, onclick: () => apply("slide") }, "Apply to this slide"),
                Button({ class: "grow", disabled: !bg.picked || takers === 0, onclick: () => apply("all") }, "Apply to all slides")
              )
            )
          : null,

        bg.results.length > 0
          ? h(
              "ul",
              { class: "image-grid" },
              bg.results.map((image, at) => {
                const active = bg.picked && bg.picked.src === image.src;
                return h(
                  "li",
                  null,
                  h(
                    "button",
                    { type: "button", id: `background-result-${at}`, class: cx("image-pick", active && "is-active"), "aria-pressed": active ? "true" : "false", onclick: () => { bg.picked = image; draw(); } },
                    image.thumb ? h("img", { src: image.thumb, alt: image.credit || "Background option", loading: "lazy" }) : h("span", { class: "image-none" }, icon("imageOff", 20)),
                    h("span", { class: "image-credit", title: image.license ? `${image.credit}. ${image.license}` : image.credit }, image.credit || providerName(image.provider))
                  )
                );
              })
            )
          : null,

        bg.searched && !bg.searching && bg.results.length === 0 && !bg.searchError ? h("p", { class: "muted" }, "No images yet. Upload one of your own, or connect a stock photo source below.") : null,

        h(
          "div",
          { class: "subcard" },
          h("p", { class: "field-label gap-below" }, "Image sources"),
          h("ul", { class: "source-list" }, sources.map((source) => h("li", null, StatusDot(source.tone), h("span", { class: "min-0 break" }, h("strong", null, providerName(source.id)), `: ${source.line}`)))),
          h("p", { class: "hint gap-above" }, "Sources are tried in this order and the search stops at the first one with results.")
        )
      ),

      h(
        "section",
        { "aria-label": "Generate an image", class: "stack" },
        heading("Generate an image"),
        Field({ label: "Describe the image", htmlFor: "background-prompt" }, TextInput({ id: "background-prompt", value: bg.prompt, placeholder: "For example: soft morning light on a flour dusted table", oninput: (event) => { const had = Boolean(bg.prompt.trim()); bg.prompt = event.target.value; if (had !== Boolean(bg.prompt.trim())) draw(); } })),
        bg.generateError ? InlineError({ message: bg.generateError }) : null,
        h(
          "ul",
          { class: "stack-sm plain" },
          generators.map((row) => {
            const ready = row.enabled && row.configured;
            return h(
              "li",
              { class: "subcard" },
              h(
                "div",
                { class: "row between top" },
                h("div", { class: "min-0" }, h("p", { class: "field-label with-dot" }, StatusDot(ready ? "ok" : "off"), providerName(row.id)), h("p", { class: cx("hint", ready && "good") }, ready ? "Ready" : `Not connected: ${row.enabled ? row.detail : "switched off in providers.json"}`)),
                Button({ id: `generate-${row.id}`, icon: "sparkles", disabled: !ready || !bg.prompt.trim() || bg.generating !== null, busy: bg.generating === row.id, onclick: () => generateWith(row.id) }, "Generate")
              ),
              row.costHint ? h("p", { class: "muted gap-above" }, row.costHint) : null
            );
          }),
          generators.length === 0 ? h("li", { class: "muted" }, "No image generators are listed in providers.json.") : null
        )
      )
    );
  }

  const TABS = { content: contentTab, templates: templatesTab, brand: brandTab, background: backgroundTab };
  const KEYS = {
    content: ["selectedKey", "editor", "renders", "fieldErrors", "schema", "templates"],
    templates: ["selectedKey", "editor", "schema", "templates", "templatesBusy", "templatesError"],
    brand: ["brand", "brandWarnings", "brandPreviews"],
    background: ["selectedKey", "editor", "schema", "doctor", "templates"],
  };
  const all = [...new Set(["tab", "sheetOpen", "brandSave", ...Object.values(KEYS).flat()])];

  drawTabs();
  draw();
  const stop = watch(all, (changed) => {
    if (changed.has("tab") || changed.has("sheetOpen")) drawTabs();
    if (changed.has("tab") && state.tab === "templates") ensureTemplatePreviews();
    if (changed.has("tab") || KEYS[state.tab].some((key) => changed.has(key))) draw();
    else if (changed.has("brandSave") && state.tab === "brand") drawBrandSave();
  });
  return { el: root, dispose: stop };
}
