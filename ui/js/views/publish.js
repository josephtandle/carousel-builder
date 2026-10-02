// The publish bar, pinned to the bottom of the screen: caption, hashtags, one toggle
// per platform, export and publish. Publishing always shows the engine's dry run first.
// The word PUBLISH is only sent when the final button in that dialog is pressed.

import { ApiError, api, errorText, postJson } from "../api.js";
import { AutoTextArea, Button, InlineError, Notice, Popover, Spinner, StatusDot, TextInput, cx, h, icon, openDialog, redraw, relativeTime } from "../dom.js";
import { draftCaption, ensureRendered, fullCaption, normalizeHashtag, openDraft, refreshHistory, setCaption, setHashtags, state, watch } from "../state.js";

const PLATFORMS = { instagram: "Instagram", linkedin: "LinkedIn", facebook: "Facebook", tiktok: "TikTok" };
const platformName = (id) => PLATFORMS[id] || id;
function listWords(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One line on how to connect a platform, built from what the engine says is missing. */
function wireHint(row) {
  if (!row.enabled) return `Switch it on: set targets.${row.id}.enabled to true in publishers.json in your carousel data folder.`;
  const steps = [];
  if (row.missing && row.missing.length) steps.push(`Set ${listWords(row.missing)} in the environment you start the carousel ui command from, then start it again.`);
  if (row.needsPublicUrls) steps.push("It also needs a media host in publishers.json, because this platform loads the images from a public address.");
  return steps.join(" ") || "The README lists the setup steps for this platform.";
}

/** A post link is shown only when it is a plain https address. */
function safeLink(value) {
  return typeof value === "string" && /^https:\/\/[^\s]+$/i.test(value) ? value : null;
}

const STATUS_VIEW = {
  published: { label: "Published", tone: "good", icon: "check" },
  processing: { label: "Processing", tone: "info", icon: "clock" },
  unknown: { label: "Not confirmed", tone: "warn", icon: "warning" },
  dry_run: { label: "Preview only", tone: "plain" },
  refused: { label: "Not sent", tone: "plain" },
  not_wired: { label: "Not connected", tone: "plain" },
  error: { label: "Failed", tone: "bad", icon: "warning" },
};
function StatusChip(status) {
  const view = STATUS_VIEW[status] || { label: status, tone: "plain" };
  return h("span", { class: cx("status-chip", `chip-${view.tone}`) }, view.icon ? icon(view.icon, 14) : null, view.label);
}
const STATUS_ADVICE = {
  processing: "The platform accepted the post and is still processing it. Check the account in a few minutes. Do not send it again.",
  unknown: "The platform did not confirm the post. It may or may not be live. Check the account before you try again, so it is not posted twice.",
};

function PlatformHelp(row) {
  return h(
    "div",
    { class: "stack-xs" },
    h("p", { class: "field-label" }, `${platformName(row.id)} is not connected`),
    h("p", { class: "muted" }, row.reason),
    h("p", null, h("strong", null, "How to connect: "), wireHint(row))
  );
}

function ResultCard(result, plan) {
  const problems = result.problems || [];
  const warnings = result.warnings || [];
  const steps = result.steps || [];
  const ready = plan && problems.length === 0 && result.wired !== false;
  return h(
    "li",
    { class: "subcard result" },
    h(
      "div",
      { class: "row between" },
      h("p", { class: "result-name" }, platformName(result.id)),
      plan ? h("span", { class: cx("status-chip", ready ? "chip-good" : "chip-bad") }, icon(ready ? "check" : "warning", 14), ready ? "Ready to send" : "Would fail") : StatusChip(result.status)
    ),
    STATUS_ADVICE[result.status] ? h("p", { class: "warn-text gap-above" }, STATUS_ADVICE[result.status]) : null,
    !plan && safeLink(result.url) ? h("a", { href: safeLink(result.url), target: "_blank", rel: "noreferrer noopener", class: "text-link gap-above" }, "Open the post", icon("external", 13)) : null,
    problems.length > 0 ? h("ul", { class: "plain bad gap-above" }, problems.map((problem) => h("li", null, problem))) : null,
    warnings.length > 0 ? h("ul", { class: "plain warn-text gap-above" }, warnings.map((warning) => h("li", null, warning))) : null,
    plan && steps.length > 0 ? h("ol", { class: "steps muted gap-above" }, steps.map((step) => h("li", { class: "break" }, step))) : result.detail ? h("p", { class: "muted break gap-above" }, result.detail) : null
  );
}

export function PublishBar() {
  let chosen = null; // null: every connected platform is on
  let ticket = 0; // each press of Publish gets a ticket; closing the dialog tears it up
  let stage = { kind: "closed" };
  let dialog = null;
  let sheet = null;
  const stops = [];
  const tagDrafts = {}; // a hashtag being typed, kept across redraws of the caption editor

  const publishers = () => (state.doctor && state.doctor.publishers) || [];
  const wired = () => publishers().filter((row) => row.wired).map((row) => row.id);
  // Every connected platform starts switched on; nothing is sent without the confirm dialog.
  const targets = () => (chosen || wired()).filter((id) => wired().includes(id));
  const toggle = (id) => {
    const now = targets();
    chosen = now.includes(id) ? now.filter((entry) => entry !== id) : [...now, id];
    drawPlatforms();
    if (sheet) sheet.update();
  };

  // ---- caption editor (in the bar's popover and in the phone sheet) ----

  function CaptionEditor(prefix, rerender) {
    const editor = state.editor;
    if (!editor) return null;
    // Photo credits that are on a slide and not yet in the caption, as things stand right now.
    const missingCredits = () => {
      const now = state.editor;
      if (!now) return [];
      const all = now.slides.map((slide) => slide.fields._credit).filter((credit) => typeof credit === "string" && credit.trim() !== "" && credit !== "Your library");
      return [...new Set(all)].filter((credit) => !now.caption.includes(credit));
    };
    const credits = missingCredits();
    const lengthId = `${prefix}-caption-length`;
    const length = h("span", { id: lengthId, class: "muted-3 tnum" }, `${fullCaption(editor).length} characters`);
    const addTags = (input) => {
      const tags = input.value.split(/[\s,]+/).map(normalizeHashtag).filter(Boolean);
      input.value = "";
      tagDrafts[prefix] = "";
      const next = [...state.editor.hashtags];
      for (const tag of tags) if (!next.includes(tag)) next.push(tag);
      if (next.length !== state.editor.hashtags.length) setHashtags(next);
    };
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row between wrap" },
        h("label", { for: `${prefix}-caption`, class: "field-label strong" }, "Caption"),
        h("div", { class: "row" }, length, Button({ id: `${prefix}-draft-caption`, busy: state.captionBusy, icon: "wand", onclick: () => draftCaption() }, "Draft caption"))
      ),
      AutoTextArea({
        id: `${prefix}-caption`,
        minRows: 3,
        value: editor.caption,
        class: "caption-input",
        placeholder: "Write the caption that goes with the post, or let the engine draft one from your slides.",
        oninput: (event) => {
          setCaption(event.target.value, true);
          const shown = document.getElementById(lengthId);
          if (shown) shown.textContent = `${fullCaption(state.editor).length} characters`;
        },
      }),
      state.captionError ? InlineError({ message: state.captionError, onRetry: () => draftCaption() }) : null,
      credits.length > 0
        ? h(
            "div",
            { class: "row wrap muted" },
            h("span", null, "Photo credit missing from the caption:"),
            Button({ variant: "ghost", onclick: () => { const still = missingCredits(); const text = state.editor.caption.trim(); if (still.length) setCaption(`${text}${text ? "\n\n" : ""}Photos: ${still.join(", ")}`, false); const field = document.getElementById(`${prefix}-caption`); if (field) field.value = state.editor.caption; if (rerender) rerender(); } }, `Add ${credits.join(", ")}`)
          )
        : null,
      h(
        "div",
        null,
        h("p", { class: "field-label strong gap-below" }, "Hashtags"),
        h(
          "ul",
          { class: "tags" },
          editor.hashtags.map((tag) => h("li", { class: "tag" }, tag, h("button", { type: "button", class: "tag-remove", "aria-label": `Remove ${tag}`, onclick: () => setHashtags(state.editor.hashtags.filter((entry) => entry !== tag)) }, icon("x", 15)))),
          h(
            "li",
            { class: "tag-add" },
            h(
              "form",
              { onsubmit: (event) => { event.preventDefault(); addTags(event.target.querySelector("input")); } },
              h("label", { for: `${prefix}-hashtag`, class: "sr-only" }, "Add a hashtag"),
              TextInput({ id: `${prefix}-hashtag`, value: tagDrafts[prefix] || "", placeholder: "Add a hashtag and press Enter", oninput: (event) => { tagDrafts[prefix] = event.target.value; }, onblur: (event) => { if (event.target.value.trim()) addTags(event.target); } })
            )
          )
        )
      )
    );
  }

  // ---- export and history ----

  function ExportPanel(rerender) {
    const box = { status: "loading", listing: null, error: null, warning: null };
    const el = h("div", { class: "stack-sm" });
    const paint = () =>
      redraw(el, () => {
        if (box.status === "loading") return Spinner("Preparing your files");
        if (box.status === "error" || !box.listing) return InlineError({ message: box.error || "The export could not be prepared.", onRetry: load });
        return [
          h("p", { class: "field-label strong" }, "Export"),
          box.warning ? Notice({ tone: "warn" }, box.warning) : null,
          h("a", { href: box.listing.pdf, download: "", class: "btn btn-primary btn-block" }, icon("file", 16), h("span", null, "Download the PDF")),
          h("p", { class: "muted" }, "Or one PNG per slide:"),
          h("ul", { class: "png-list" }, box.listing.pngs.map((png) => h("li", null, h("a", { href: png.download, download: png.name, class: "btn btn-secondary btn-block align-start" }, icon("download", 15), h("span", null, `Slide ${png.index}`))))),
          metaSection(),
        ];
      });
    // Meta ads handoff: one JSON file for whoever builds the ad. Nothing is sent to Meta.
    const meta = { status: "idle", data: null, error: null, cta: "LEARN_MORE" };
    const CTA_LABELS = [["LEARN_MORE", "Learn more"], ["SHOP_NOW", "Shop now"], ["SIGN_UP", "Sign up"], ["BOOK_NOW", "Book now"], ["GET_OFFER", "Get offer"], ["CONTACT_US", "Contact us"], ["SUBSCRIBE", "Subscribe"], ["DOWNLOAD", "Download"]];
    // The select has an id and sits at the same depth in both states of the panel, so a redraw
    // keeps the very node the person is using. Changing it writes the handoff again once one exists.
    function ctaField() {
      return h(
        "div",
        { class: "stack-xs" },
        h("label", { for: "meta-handoff-cta", class: "field-label" }, "Call to action"),
        h("select", { id: "meta-handoff-cta", class: "input", onchange: (event) => { meta.cta = event.target.value; if (meta.data) makeMeta(); } }, CTA_LABELS.map(([value, label]) => h("option", { value, selected: value === meta.cta }, label)))
      );
    }
    const FILL_LABELS = { pageId: "the Facebook Page id", instagramUserId: "the Instagram account id", link: "the link the ad opens" };
    function metaSection() {
      const button = Button({ id: "meta-handoff-button", icon: "file", class: "btn-block", busy: meta.status === "loading", onclick: makeMeta }, meta.status === "ready" ? "Write it again" : "Meta ads handoff");
      if (meta.status !== "ready" || !meta.data) {
        return h("div", { class: "stack-sm meta-handoff" }, h("p", { class: "muted" }, "Running this as an ad? Get the carousel as one file for Meta Ads."), ctaField(), button, meta.error ? InlineError({ message: meta.error }) : null);
      }
      const { data } = meta;
      return h(
        "div",
        { class: "stack-sm meta-handoff" },
        h("p", { class: "field-label strong" }, "Meta ads handoff"),
        h("p", { class: "muted break" }, `${data.spec.cards.length} cards written to ${data.file} in your data folder. Nothing was sent to Meta.`),
        ctaField(),
        data.warnings.length ? Notice({ tone: "warn" }, h("ul", { class: "plain stack-xs" }, data.warnings.map((warning) => h("li", null, warning)))) : null,
        h("div", null, h("p", { class: "field-label gap-below" }, "Fill in before it is used"), h("ul", { class: "fill-list" }, data.fillIn.map((key) => h("li", null, h("code", { class: "accent-code" }, key), `: ${FILL_LABELS[key] || "your value"}`)))),
        h("a", { href: data.download, download: "meta-carousel.json", class: "btn btn-secondary btn-block" }, icon("download", 15), h("span", null, "Download meta-carousel.json")),
        button
      );
    }
    async function makeMeta() {
      if (!box.listing || meta.status === "loading") return;
      meta.status = "loading";
      meta.error = null;
      paint();
      try {
        const ready = await ensureRendered();
        if (!ready.rendered || !ready.id) throw new Error(ready.reason || "The slides could not be rendered.");
        // A choice changed while the file was being written is asked for again, so the file matches the select.
        let asked;
        do {
          asked = meta.cta;
          meta.data = await api(`export?id=${encodeURIComponent(ready.id)}&format=meta&cta=${encodeURIComponent(asked)}`);
        } while (meta.cta !== asked);
        meta.status = "ready";
      } catch (error) {
        meta.status = "idle";
        meta.error = errorText(error);
      }
      paint();
      if (rerender) rerender();
    }
    async function load() {
      box.status = "loading";
      paint();
      try {
        const ready = await ensureRendered();
        if (!ready.rendered) throw new Error(ready.reason || "The slides could not be rendered.");
        if (!ready.id) throw new Error("The carousel has not been saved yet. Try again in a moment.");
        box.listing = await api(`export?id=${encodeURIComponent(ready.id)}`);
        box.warning = ready.qaOk ? null : "Some slides do not pass the layout check, so text may be clipped in these files.";
        box.status = "ready";
        refreshHistory();
      } catch (error) {
        box.status = "error";
        box.error = errorText(error);
      }
      paint();
      if (rerender) rerender();
    }
    load();
    return el;
  }

  function HistoryPanel(onOpen) {
    const { history } = state;
    const posts = history.publishes.filter((entry) => !entry.dryRun && entry.status !== "dry_run");
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        null,
        h("p", { class: "field-label strong gap-below" }, "Publishing"),
        posts.length === 0
          ? h("p", { class: "muted" }, "Nothing has been published from here yet.")
          : h(
              "ul",
              { class: "stack-sm plain" },
              posts.slice(0, 8).map((entry) =>
                h(
                  "li",
                  { class: "subcard tight" },
                  h("div", { class: "row between" }, h("span", { class: "field-label" }, platformName(entry.target), " ", h("span", { class: "muted-3 normal" }, relativeTime(entry.at))), StatusChip(entry.status)),
                  h("p", { class: "muted truncate" }, entry.title || "Untitled"),
                  STATUS_ADVICE[entry.status] ? h("p", { class: "warn-text" }, STATUS_ADVICE[entry.status]) : null,
                  (entry.status === "error" || entry.status === "not_wired" || entry.status === "refused") && entry.detail ? h("p", { class: "muted-3 clamp-3" }, entry.detail) : null,
                  safeLink(entry.url) ? h("a", { href: safeLink(entry.url), target: "_blank", rel: "noreferrer noopener", class: "text-link" }, "Open the post", icon("external", 13)) : null
                )
              )
            )
      ),
      h(
        "div",
        null,
        h("p", { class: "field-label strong gap-below" }, "Exports"),
        history.exports.length === 0
          ? h("p", { class: "muted" }, "No exports yet.")
          : h(
              "ul",
              { class: "plain" },
              history.exports.slice(0, 8).map((entry) =>
                h("li", null, h("button", { type: "button", class: "list-row", onclick: () => onOpen(entry.id) }, h("span", { class: "truncate grow" }, entry.title || "Untitled"), h("span", { class: "muted-3 nowrap" }, `${entry.slides} slides, ${relativeTime(entry.exportedAt)}`)))
              )
            )
      )
    );
  }

  function platformList() {
    return h(
      "ul",
      { class: "stack-sm plain" },
      publishers().map((row) =>
        h(
          "li",
          { class: "subcard" },
          row.wired
            ? h("label", { class: "check-row" }, platformName(row.id), h("input", { type: "checkbox", id: `sheet-platform-${row.id}`, checked: targets().includes(row.id), onchange: () => toggle(row.id) }))
            : PlatformHelp(row)
        )
      )
    );
  }

  // ---- the publish dialog: dry run first, then one final confirm ----

  function setStage(next) {
    stage = next;
    if (next.kind === "closed") {
      if (dialog) dialog.close(true);
      dialog = null;
      return;
    }
    const title = next.kind === "done" ? "Publish result" : next.kind === "connect" ? "Connect a platform to publish" : "Review before publishing";
    if (!dialog || !dialog.isOpen()) {
      dialog = openDialog({
        title,
        wide: true,
        body: dialogBody,
        footer: dialogFooter,
        canClose: () => stage.kind !== "sending",
        onClose: () => {
          ticket += 1;
          stage = { kind: "closed" };
          dialog = null;
        },
      });
    } else {
      dialog.setTitle(title);
      dialog.update();
    }
  }

  function dialogBody() {
    if (stage.kind === "preparing") return Spinner("Checking the slides and asking the engine what it would send");
    if (stage.kind === "error") return InlineError({ message: stage.message });
    if (stage.kind === "connect") {
      return h("div", { class: "stack" }, h("p", { class: "muted" }, "No platform is switched on. You can still export the PNG slides or the PDF and post them yourself."), platformList());
    }
    if (stage.kind === "plan" || stage.kind === "sending") {
      const blocked = planBlocked();
      return h(
        "div",
        { class: "stack" },
        stage.kind === "plan" && stage.note ? Notice({ tone: "warn" }, stage.note) : null,
        h("p", { class: "muted" }, "This is a preview. Nothing has been sent. Publishing is public and cannot be undone from here."),
        h("ul", { class: "stack-sm plain" }, stage.results.map((result) => ResultCard(result, true))),
        h("div", { class: "subcard" }, h("p", { class: "field-label strong" }, "Caption that will be posted"), h("p", { class: "muted caption-preview" }, stage.request.caption || "No caption. The post goes out without text.")),
        stage.kind === "plan" && blocked ? InlineError({ message: "At least one platform would fail as it stands. Fix the problems above, or switch that platform off, then publish again." }) : null,
        stage.kind === "plan" && !stage.token && !blocked ? InlineError({ message: "The engine did not return a confirmation token for this preview, so it cannot be published. Close this and try again." }) : null
      );
    }
    if (stage.kind === "done") {
      return h("div", { class: "stack" }, stage.message ? InlineError({ message: stage.message }) : null, h("ul", { class: "stack-sm plain" }, stage.results.map((result) => ResultCard(result, false))));
    }
    return null;
  }

  function planBlocked() {
    return stage.kind === "plan" && stage.results.some((result) => (result.problems || []).length > 0 || result.wired === false);
  }

  function dialogFooter() {
    if (stage.kind === "plan") {
      return [
        Button({ variant: "ghost", onclick: () => dialog && dialog.close() }, "Cancel"),
        Button({ id: "publish-confirm", variant: "primary", icon: "send", disabled: planBlocked() || !stage.token, onclick: confirmPublish }, `Publish to ${listWords(stage.request.targets.map(platformName))}`),
      ];
    }
    if (stage.kind === "sending") return Spinner("Publishing. Keep this window open.");
    if (stage.kind === "preparing") return null;
    return Button({ variant: "primary", onclick: () => dialog && dialog.close() }, "Close");
  }

  async function startPublish() {
    const editor = state.editor;
    if (!editor) return;
    const chosenNow = targets();
    if (chosenNow.length === 0) {
      setStage({ kind: "connect" });
      return;
    }
    ticket += 1;
    const mine = ticket;
    setStage({ kind: "preparing" });
    try {
      const ready = await ensureRendered();
      if (ticket !== mine) return;
      if (!ready.rendered || !ready.qaOk) throw new Error(ready.reason || "The slides are not ready to publish.");
      if (!ready.id) throw new Error("The carousel has not been saved yet. Try again in a moment.");
      const request = { id: ready.id, targets: chosenNow, caption: fullCaption(state.editor), title: state.editor.title };
      // No confirm is sent here, so the engine only describes what it would do.
      const plan = await api("publish", postJson(request));
      if (ticket !== mine) return;
      setStage({ kind: "plan", request, results: plan.results, token: plan.confirmToken || null, note: null });
    } catch (error) {
      if (ticket === mine) setStage({ kind: "error", message: errorText(error) });
    } finally {
      refreshHistory();
    }
  }

  async function confirmPublish() {
    if (stage.kind !== "plan") return;
    const { request, token, results } = stage;
    setStage({ kind: "sending", request, results });
    try {
      // The only place the word and the token of the reviewed dry run are sent.
      const sent = await api("publish", postJson({ ...request, confirm: "PUBLISH", confirmToken: token }));
      setStage({ kind: "done", results: sent.results, message: null });
    } catch (error) {
      const payload = error instanceof ApiError ? error.payload : null;
      const fresh = payload && Array.isArray(payload.results) ? payload.results : null;
      if (payload && payload.code === "confirm_token_mismatch" && fresh) {
        // The slides, caption or platforms changed after the summary was made. Nothing was sent: show the new summary.
        setStage({ kind: "plan", request, results: fresh, token: typeof payload.confirmToken === "string" ? payload.confirmToken : null, note: "Something changed after this summary was made, so nothing was sent. Here is the up to date summary. Check it and confirm again." });
      } else if (fresh) {
        setStage({ kind: "done", results: fresh, message: "Nothing was published." });
      } else if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) {
        // The answer never arrived. The post may be live, so this is "not confirmed", never "try again".
        setStage({
          kind: "done",
          message: `The answer from the engine was lost: ${errorText(error)}`,
          results: request.targets.map((id) => ({ id, status: "unknown", detail: "Open History for what the engine recorded, and check the account itself before sending anything again.", url: null })),
        });
      } else {
        setStage({ kind: "error", message: errorText(error) });
      }
    } finally {
      refreshHistory();
    }
  }

  const openFromHistory = (id) => {
    historyPop.close();
    if (sheet) sheet.close(true);
    openDraft(id);
  };

  // ---- wide screen: the pinned bar ----

  const captionText = h("span", { class: "caption-peek" });
  const captionPop = Popover({
    label: "Caption and hashtags",
    side: "top",
    align: "left",
    width: "42rem",
    class: "caption-pop",
    trigger: (ctl) => h("button", { type: "button", id: "caption-trigger", class: "caption-trigger", onclick: () => ctl.toggle() }, icon("pencil", 15, "muted"), h("span", { class: "field-label" }, "Caption"), captionText, icon("down", 16, "muted flip")),
    content: () => CaptionEditor("bar", () => captionPop.refresh()),
  });
  const platformsEl = h("div", { role: "group", "aria-label": "Publish to", class: "platforms" });
  const historyPop = Popover({
    label: "History",
    side: "top",
    align: "right",
    width: "24rem",
    trigger: (ctl) => Button({ variant: "ghost", icon: "clock", onclick: () => { ctl.toggle(); refreshHistory(); } }, "History"),
    content: () => HistoryPanel(openFromHistory),
  });
  const exportPop = Popover({
    label: "Export",
    side: "top",
    align: "right",
    width: "20rem",
    trigger: (ctl) => Button({ id: "export-trigger", icon: "download", onclick: () => ctl.toggle() }, "Export"),
    content: () => ExportPanel(),
  });
  const bar = h(
    "section",
    { "aria-label": "Caption and publish", class: "panel publish-bar wide-only-flex" },
    captionPop.el,
    platformsEl,
    h("div", { class: "publish-actions" }, historyPop.el, exportPop.el, Button({ id: "publish-button", variant: "primary", icon: "send", onclick: () => startPublish() }, "Publish"))
  );

  const helps = new Map();
  function drawPlatforms() {
    for (const pop of helps.values()) pop.close();
    helps.clear();
    redraw(platformsEl, () =>
      publishers().map((row) => {
        if (row.wired) {
          const on = targets().includes(row.id);
          return h("button", { type: "button", role: "switch", id: `platform-${row.id}`, "aria-checked": on ? "true" : "false", class: cx("platform", on && "is-on"), title: on ? `${platformName(row.id)} is on` : `${platformName(row.id)} is connected. Click to include it.`, onclick: () => toggle(row.id) }, StatusDot(on ? "ok" : "off"), platformName(row.id));
        }
        const pop = Popover({
          label: `${platformName(row.id)} is not connected`,
          side: "top",
          align: "right",
          width: "24rem",
          trigger: (ctl) => h("button", { type: "button", id: `platform-${row.id}`, "aria-disabled": "true", class: "platform is-off", title: `${platformName(row.id)} is not connected. Click to see why.`, onclick: () => ctl.toggle() }, platformName(row.id), icon("info", 14)),
          content: () => PlatformHelp(row),
        });
        helps.set(row.id, pop);
        return pop.el;
      })
    );
  }

  function drawCaptionPeek() {
    const editor = state.editor;
    const preview = editor ? fullCaption(editor).replace(/\s+/g, " ").trim() : "";
    captionText.textContent = preview || "Not written yet";
    captionText.classList.toggle("is-empty", !preview);
  }

  // ---- phone: one button that opens everything in a sheet ----

  function openSheet() {
    sheet = openDialog({
      title: "Caption and publish",
      body: () => h("div", { class: "stack-lg" }, CaptionEditor("sheet", () => sheet && sheet.update()), h("section", { "aria-label": "Publish to", class: "stack-sm" }, h("p", { class: "field-label strong" }, "Publish to"), platformList()), sheetExport, HistoryPanel(openFromHistory)),
      footer: () => Button({ variant: "primary", large: true, icon: "send", class: "btn-block", onclick: () => { if (sheet) sheet.close(true); startPublish(); } }, "Publish"),
      onClose: () => { sheet = null; },
    });
  }
  let sheetExport = null;
  const phone = h("div", { class: "publish-phone narrow-only" }, Button({ id: "publish-phone-button", variant: "primary", large: true, icon: "send", class: "btn-block", onclick: () => { sheetExport = ExportPanel(); openSheet(); } }, "Caption and publish"));

  drawPlatforms();
  drawCaptionPeek();
  stops.push(watch(["doctor"], drawPlatforms));
  stops.push(watch(["editor", "editorText"], drawCaptionPeek));
  stops.push(
    watch(["editor", "captionBusy", "captionError"], () => {
      captionPop.refresh();
      if (sheet) sheet.update();
    })
  );
  stops.push(watch(["history"], () => { historyPop.refresh(); if (sheet) sheet.update(); }));

  return {
    bar,
    phone,
    dispose() {
      for (const stop of stops) stop();
      ticket += 1;
      for (const pop of [captionPop, historyPop, exportPop, ...helps.values()]) pop.close();
      if (dialog) dialog.close(true);
      if (sheet) sheet.close(true);
    },
  };
}
