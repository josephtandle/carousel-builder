// First run and empty state: one large question, an optional "paste a post" box,
// slide count, size, three example prompts and one primary button.

import { Button, IconButton, InlineError, Notice, Segmented, StatusDot, h, icon, redraw, relativeTime } from "../dom.js";
import { SIZES, dismissGenerateError, generate, openDraft, state, watch } from "../state.js";

const EXAMPLES = ["Three habits that keep a small bakery sold out", "Five mistakes first time home buyers make", "How to plan a week of dinners in 30 minutes"];
const MIN_SLIDES = 5;
const MAX_SLIDES = 10;

export function StartScreen() {
  const form = { brief: "", source: "", sourceOpen: false, slides: 8, size: "portrait", hint: null };
  const stops = [];

  const brief = h("textarea", {
    id: "carousel-brief",
    rows: 3,
    class: "input brief-input",
    placeholder: "One sentence is enough. For example: three habits that keep a small bakery sold out.",
    oninput: (event) => {
      form.brief = event.target.value;
      if (form.hint) {
        form.hint = null;
        hint.render();
      }
    },
  });

  const hintEl = h("div", null);
  const hint = { render: () => redraw(hintEl, () => (form.hint ? h("p", { id: "carousel-brief-hint", role: "alert", class: "warn-text" }, form.hint) : null)) };

  const create = () => {
    if (state.generating) return;
    if (!form.brief.trim() && !(form.sourceOpen && form.source.trim())) {
      form.hint = "Say what the carousel is about, or paste a post to turn into one.";
      hint.render();
      brief.focus();
      return;
    }
    form.hint = null;
    hint.render();
    generate({ brief: form.brief.trim(), sourceText: form.sourceOpen ? form.source.trim() : "", slides: form.slides, size: form.size });
  };

  const examples = h(
    "div",
    { class: "chips" },
    h("span", { class: "muted-3" }, "Try:"),
    EXAMPLES.map((example) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          onclick: () => {
            form.brief = example;
            brief.value = example;
            form.hint = null;
            hint.render();
            brief.focus();
          },
        },
        example
      )
    )
  );

  const sourcePanel = h("div", { id: "carousel-source-panel", class: "source-panel", hidden: true },
    h("label", { for: "carousel-source", class: "sr-only" }, "Post or article text"),
    h("textarea", { id: "carousel-source", rows: 6, class: "input", placeholder: "Paste the text here. The slides are built from its points.", oninput: (event) => { form.source = event.target.value; if (form.hint) { form.hint = null; hint.render(); } } }),
    h("p", { class: "hint" }, "A post that already did well makes a strong carousel.")
  );
  const sourceToggle = h(
    "button",
    {
      type: "button",
      class: "disclosure",
      "aria-expanded": "false",
      "aria-controls": "carousel-source-panel",
      onclick: () => {
        form.sourceOpen = !form.sourceOpen;
        sourceToggle.setAttribute("aria-expanded", form.sourceOpen ? "true" : "false");
        sourcePanel.hidden = !form.sourceOpen;
        if (form.sourceOpen) sourcePanel.querySelector("textarea").focus();
      },
    },
    icon("down", 16, "disclosure-icon"),
    "Paste a post or article to turn into a carousel"
  );

  const count = h("output", { class: "stepper-value", "aria-live": "polite" }, String(form.slides));
  const fewer = IconButton({ label: "Fewer slides", onclick: () => step(-1) }, "minus");
  const more = IconButton({ label: "More slides", onclick: () => step(1) }, "plus");
  function step(delta) {
    form.slides = Math.max(MIN_SLIDES, Math.min(MAX_SLIDES, form.slides + delta));
    count.textContent = String(form.slides);
    fewer.disabled = form.slides <= MIN_SLIDES;
    more.disabled = form.slides >= MAX_SLIDES;
  }

  const submitEl = h("div", { class: "start-submit" });
  const submit = {
    render: () =>
      redraw(submitEl, () => [
        state.generateError ? InlineError({ message: state.generateError, onDismiss: dismissGenerateError }) : null,
        h(
          "div",
          { class: "start-actions" },
          Button({ type: "submit", variant: "primary", large: true, busy: state.generating, icon: "sparkles", class: "start-button" }, state.generating ? "Writing your slides" : "Create carousel"),
          h("p", { class: "muted-3 wide-only" }, "or press Cmd or Ctrl and Enter")
        ),
      ]),
  };

  const formEl = h(
    "form",
    { class: "card start-card", onsubmit: (event) => { event.preventDefault(); create(); } },
    h(
      "div",
      { class: "stack-sm" },
      h("label", { for: "carousel-brief", class: "start-question" }, "What is this carousel about?"),
      brief,
      hintEl,
      examples
    ),
    h("div", null, sourceToggle, sourcePanel),
    h(
      "div",
      { class: "start-options" },
      h(
        "div",
        null,
        h("p", { id: "carousel-slides-label", class: "field-label gap-below" }, "Slides"),
        h("div", { role: "group", "aria-labelledby": "carousel-slides-label", class: "stepper" }, fewer, count, more)
      ),
      h(
        "div",
        { class: "min-0" },
        h("p", { class: "field-label gap-below" }, "Size"),
        Segmented({ label: "Size", value: form.size, onChange: (next) => { form.size = next; }, options: SIZES.map((entry) => ({ id: entry.id, label: entry.label, detail: entry.ratio })) })
      )
    ),
    submitEl
  );

  const topEl = h("div", { class: "stack" });
  const top = {
    render: () =>
      redraw(topEl, () => [
        state.doctor && !state.doctor.chrome.ok ? InlineError({ message: `Slides cannot be rendered yet. ${state.doctor.chrome.detail}` }) : null,
        state.openError ? InlineError({ message: state.openError }) : null,
      ]),
  };

  const readyEl = h("div", null);
  const ready = {
    render: () =>
      redraw(readyEl, () => {
        const doctor = state.doctor;
        if (!doctor) return null;
        const sources = doctor.images.filter((row) => row.enabled && row.configured).length;
        const wired = doctor.publishers.filter((row) => row.wired).map((row) => row.id);
        const line = (tone, text) => h("li", null, StatusDot(tone), h("span", null, text));
        return h(
          "ul",
          { "aria-label": "What is ready", class: "ready-list" },
          line(doctor.chrome.ok ? "ok" : "bad", doctor.chrome.ok ? "Rendering is ready." : "Rendering is not ready."),
          line(doctor.llm.ok ? "ok" : "warn", doctor.llm.ok ? `Copy is written by ${doctor.llm.name}.` : "No model key found, so the built-in draft gives you a structure to fill in."),
          line(doctor.images.some((row) => row.id !== "library" && row.enabled && row.configured) ? "ok" : "off", `${sources} of ${doctor.images.length} background image sources connected.`),
          line(wired.length ? "ok" : "off", wired.length ? `Publishing connected: ${wired.join(", ")}.` : "No platform connected yet. You can always export PNG and PDF.")
        );
      }),
  };

  const draftsEl = h("div", null);
  const drafts = {
    render: () =>
      redraw(draftsEl, () => [
        state.drafts.length > 0
          ? h(
              "section",
              { "aria-label": "Recent carousels", class: "stack-sm" },
              h("h2", { class: "section-title" }, "Pick up where you left off"),
              h(
                "ul",
                { class: "recent-list" },
                state.drafts.slice(0, 6).map((draft) =>
                  h(
                    "li",
                    null,
                    h(
                      "button",
                      { type: "button", class: "recent", disabled: state.opening || state.generating, onclick: () => openDraft(draft.id) },
                      h("span", { class: "recent-title" }, draft.title || "Untitled carousel"),
                      h("span", { class: "muted-3" }, `${draft.slides} slides, edited ${relativeTime(draft.updatedAt) || "earlier"}`)
                    )
                  )
                )
              )
            )
          : null,
        state.opening ? Notice(null, "Opening your carousel.") : null,
      ]),
  };

  const root = h(
    "main",
    { class: "start" },
    h(
      "header",
      { class: "start-head" },
      h("div", { class: "brandmark" }, h("span", { class: "brandmark-icon" }, icon("slides", 20)), h("h1", { class: "start-title" }, "Carousel Builder")),
      h("p", { class: "start-lead" }, "Describe an idea and get a full carousel in your brand: edit it, check it, export it, publish it.")
    ),
    topEl,
    formEl,
    readyEl,
    draftsEl
  );

  step(0);
  for (const part of [hint, submit, top, ready, drafts]) part.render();
  stops.push(watch(["generating", "generateError"], submit.render));
  stops.push(watch(["doctor", "openError"], top.render));
  stops.push(watch(["doctor"], ready.render));
  stops.push(watch(["drafts", "opening", "generating"], drafts.render));

  return {
    el: root,
    create,
    // Put the cursor in the question on a wide screen. A phone would open its keyboard over the page.
    mounted() {
      if (window.matchMedia("(min-width: 1024px)").matches) brief.focus();
    },
    dispose() {
      for (const stop of stops) stop();
    },
  };
}
