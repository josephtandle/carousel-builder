// Small DOM helpers and the shared building blocks of the screen.
// No framework: h() builds elements, region() redraws one part of the page and
// keeps the keyboard focus where it was.

const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "value") node.value = value;
      else if (key === "checked" || key === "disabled" || key === "hidden" || key === "multiple" || key === "draggable") {
        if (key === "draggable") node.setAttribute("draggable", value ? "true" : "false");
        else node[key] = Boolean(value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false || child === true) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Icons: simple stroked shapes on a 24 unit grid.
// ---------------------------------------------------------------------------

const ICONS = {
  alert: "M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z",
  warning: "M12 9v4.5M12 17v.5M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  down: "M5 9l7 7 7-7",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 16l5-5 4 4 3-3 6 6M15.5 8.5a1 1 0 1 0 0 .01",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-.6-1.4-.6-2.3c0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11.5a1 1 0 1 0 0 .01M10.5 7.5a1 1 0 1 0 0 .01M15 7.5a1 1 0 1 0 0 .01",
  type: "M5 6V4h14v2M12 4v16M9 20h6",
  sparkles: "M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  upload: "M12 16V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4",
  download: "M12 4v12M7 11l5 5 5-5M4 19v0a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1",
  file: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 7v5l3.5 2",
  info: "M12 11v5.5M12 7.5v.5M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z",
  pencil: "M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19zM14.5 6.5l3 3",
  send: "M21 3L10 14M21 3l-7 18-4-7-7-4z",
  wand: "M4 20L15 9M13 7l4 4M17 3v3M15.5 4.5h3M20 9v2M19 10h2M7 4v2M6 5h2",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  imageOff: "M3 3l18 18M21 16V6a2 2 0 0 0-2-2H8M3 7v11a2 2 0 0 0 2 2h13M3 16l5-5 3 3",
  slides: "M7 4h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM2 8v6M9 21h7",
  spinner: "M12 3a9 9 0 1 0 9 9",
};

export function icon(name, size = 16, extraClass = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", name === "check" ? "2.6" : "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cx("icon", name === "spinner" && "spin", extraClass));
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] || ICONS.info);
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------------
// Regions: redraw part of the page without losing the cursor
// ---------------------------------------------------------------------------

function pathTo(root, node) {
  const path = [];
  let current = node;
  while (current && current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return current === root ? path : null;
}

function nodeAt(root, path) {
  let current = root;
  for (const index of path) {
    current = current.children[index];
    if (!current) return null;
  }
  return current;
}

// A field the person is typing in (or a colour input whose picker is open) is never taken
// out of the page: its undo history, an open picker and a half composed word all live in
// the node itself. redraw() keeps that one node where it is and rebuilds around it.
function isEntry(node) {
  if (!node || !node.id) return false;
  if (node.tagName === "TEXTAREA" || node.tagName === "SELECT") return true;
  return node.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|image)$/.test(node.type || "");
}

function chainTo(root, node) {
  const chain = [];
  let current = node;
  while (current && current !== root) {
    chain.unshift(current);
    current = current.parentNode;
  }
  return current === root ? chain : null;
}

function syncAttributes(live, fresh, isField) {
  for (const attr of [...live.attributes]) {
    if (isField && (attr.name === "style" || attr.name === "value")) continue;
    if (!fresh.hasAttribute(attr.name)) live.removeAttribute(attr.name);
  }
  for (const attr of [...fresh.attributes]) {
    if (isField && (attr.name === "style" || attr.name === "value")) continue;
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
  }
}

// Puts `fresh` nodes into `parent`, leaving `keep` (already a child) exactly where it is in
// the document. `stand` is the fresh node whose place `keep` takes.
function placeAround(parent, fresh, keep, stand) {
  for (const child of [...parent.childNodes]) if (child !== keep) child.remove();
  let after = false;
  for (const node of fresh) {
    if (node === stand) {
      after = true;
      continue;
    }
    if (after) parent.appendChild(node);
    else parent.insertBefore(node, keep);
  }
}

/** Rebuilds around the focused field. Returns false when the new content has no place for it. */
function rebuildAround(el, list, field) {
  const holder = document.createDocumentFragment();
  holder.append(...list);
  const twin = holder.getElementById ? holder.getElementById(field.id) : null;
  if (!twin || twin.tagName !== field.tagName || (twin.type || "") !== (field.type || "")) return false;
  const live = chainTo(el, field);
  const fresh = chainTo(holder, twin);
  if (!live || !fresh || live.length !== fresh.length) return false;
  for (let level = 0; level < live.length; level += 1) if (live[level].tagName !== fresh[level].tagName) return false;
  let parent = el;
  let children = [...holder.childNodes];
  for (let level = 0; level < live.length; level += 1) {
    placeAround(parent, children, live[level], fresh[level]);
    syncAttributes(live[level], fresh[level], level === live.length - 1);
    parent = live[level];
    children = [...fresh[level].childNodes];
  }
  return true;
}

/**
 * Replaces the children of `el` with what `build` returns, keeping focus, the caret and scroll.
 * A focused field with an id stays the very same node when the new content has a field with
 * that id; anything else that had focus gets it back on its replacement.
 */
export function redraw(el, build) {
  const active = document.activeElement;
  const inside = active && active !== el && el.contains(active);
  const scrollTop = el.scrollTop;
  const scrollLeft = el.scrollLeft;
  const built = build();
  const list = [].concat(built === undefined || built === null || built === false ? [] : built).flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false && item !== true).map((item) => (item instanceof Node ? item : document.createTextNode(String(item))));

  if (inside && isEntry(active) && rebuildAround(el, list, active)) {
    autosize(el);
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
    return;
  }

  const memo = inside ? { id: active.id, tag: active.tagName, path: pathTo(el, active), start: null, end: null } : null;
  if (memo && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && /^(text|search|url|tel|password|)$/.test(active.type || "")))) {
    try {
      memo.start = active.selectionStart;
      memo.end = active.selectionEnd;
    } catch {
      // Some input types have no caret.
    }
  }
  el.replaceChildren(...list);
  autosize(el);
  el.scrollTop = scrollTop;
  el.scrollLeft = scrollLeft;
  if (memo) {
    let target = memo.id ? document.getElementById(memo.id) : null;
    if (target && !el.contains(target)) target = null;
    if (!target && memo.path) {
      const candidate = nodeAt(el, memo.path);
      if (candidate && candidate.tagName === memo.tag) target = candidate;
    }
    if (target && typeof target.focus === "function" && !target.disabled) {
      target.focus({ preventScroll: true });
      if (memo.start !== null) {
        try {
          target.setSelectionRange(memo.start, memo.end);
        } catch {
          // Not a text field after all.
        }
      }
    }
  }
}

export function region(el, build) {
  return { el, render: () => redraw(el, build) };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button(props, ...children) {
  const { variant = "secondary", busy = false, icon: iconName, large = false, class: extra, disabled, type, ...rest } = props || {};
  return h(
    "button",
    { type: type || "button", class: cx("btn", `btn-${variant}`, large && "btn-large", extra), disabled: disabled || busy, "aria-busy": busy ? "true" : null, ...rest },
    busy ? icon("spinner", large ? 18 : 16) : iconName ? icon(iconName, large ? 18 : 16) : null,
    children.length ? h("span", { class: "btn-label" }, ...children) : null
  );
}

export function IconButton(props, iconName, size = 16) {
  const { label, variant = "ghost", class: extra, type, ...rest } = props || {};
  return h("button", { type: type || "button", class: cx("icon-btn", `btn-${variant}`, extra), "aria-label": label, title: label, ...rest }, icon(iconName, size));
}

export function Spinner(label, size = 16) {
  return h("span", { class: "spinner", role: "status" }, icon("spinner", size, "accent"), label ? h("span", null, label) : h("span", { class: "sr-only" }, "Loading"));
}

/** An error shown where it happened, with the engine's own message. */
export function InlineError({ message, onRetry, onDismiss, class: extra }) {
  return h(
    "div",
    { role: "alert", class: cx("inline-error", extra) },
    icon("alert", 18),
    h("p", { class: "inline-error-text" }, message),
    onRetry ? h("button", { type: "button", class: "link-btn", onclick: onRetry }, "Try again") : null,
    onDismiss ? h("button", { type: "button", class: "icon-btn btn-quiet", "aria-label": "Dismiss", onclick: onDismiss }, icon("x", 16)) : null
  );
}

export function Notice(props, ...children) {
  const { tone = "info", class: extra } = props || {};
  return h("div", { class: cx("notice", `notice-${tone}`, extra) }, ...children);
}

export function Field({ label, hint, error, trailing, htmlFor, labelId }, ...children) {
  return h(
    "div",
    { class: "field" },
    h("div", { class: "field-head" }, h("label", { class: "field-label", for: htmlFor || null, id: labelId || null }, label), trailing || null),
    ...children,
    hint && !error ? h("p", { class: "hint" }, hint) : null,
    error ? h("p", { class: "field-error", role: "alert" }, error) : null
  );
}

export function TextInput(props) {
  const { class: extra, ...rest } = props || {};
  return h("input", { type: "text", class: cx("input", extra), autocomplete: "off", ...rest });
}

/** A textarea that grows with its content, so there is never a scrollbar inside a field. */
export function AutoTextArea(props) {
  const { class: extra, minRows = 1, oninput, ...rest } = props || {};
  const node = h("textarea", { class: cx("input", "autosize", extra), rows: minRows, ...rest });
  node.addEventListener("input", (event) => {
    fit(node);
    if (oninput) oninput(event);
  });
  return node;
}

function fit(node) {
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight + 2}px`;
}

export function autosize(root) {
  for (const node of root.querySelectorAll("textarea.autosize")) fit(node);
}

export function Segmented({ label, options, value, onChange, class: extra, idBase }) {
  const group = h("div", { role: "radiogroup", "aria-label": label, class: cx("segmented", extra) });
  const pick = (id) => {
    for (const button of group.children) {
      const active = button.dataset.value === id;
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    onChange(id);
  };
  options.forEach((option, index) => {
    const active = option.id === value;
    const button = h(
      "button",
      { type: "button", role: "radio", id: idBase ? `${idBase}-${option.id}` : null, "aria-checked": active ? "true" : "false", tabindex: active || (!options.some((entry) => entry.id === value) && index === 0) ? "0" : "-1", dataset: { value: option.id }, class: "segmented-option", onclick: () => pick(option.id) },
      option.label,
      option.detail ? h("span", { class: "segmented-detail" }, option.detail) : null
    );
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = options[(index + step + options.length) % options.length];
      pick(next.id);
      const target = [...group.children].find((entry) => entry.dataset.value === next.id);
      if (target) target.focus();
    });
    group.append(button);
  });
  return group;
}

export function Switch({ checked, onChange, label, description, id }) {
  const button = h(
    "button",
    { type: "button", role: "switch", id: id || null, "aria-checked": checked ? "true" : "false", class: "switch" },
    h("span", { class: "switch-text" }, label, description ? h("span", { class: "switch-detail" }, description) : null),
    h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-thumb" }))
  );
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", next ? "true" : "false");
    onChange(next);
  });
  return button;
}

export function StatusDot(tone) {
  return h("span", { class: cx("dot", `dot-${tone}`), "aria-hidden": "true" });
}

// ---------------------------------------------------------------------------
// Popover: a small panel anchored to its trigger
// ---------------------------------------------------------------------------

/** popover({ trigger(ctl) -> button, content() -> nodes, label, align, side, width }) */
export function Popover({ trigger, content, label, align = "right", side = "bottom", width = "20rem", class: extra, onOpen }) {
  const wrap = h("div", { class: cx("popover-wrap", extra) });
  let panel = null;
  const ctl = {
    el: wrap,
    isOpen: () => Boolean(panel),
    open() {
      if (panel) return;
      panel = h("div", { role: "dialog", "aria-label": label, class: cx("popover", `popover-${align}`, `popover-${side}`), style: { width } });
      wrap.append(panel);
      ctl.refresh();
      button.setAttribute("aria-expanded", "true");
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onPointer, true);
      if (onOpen) onOpen();
    },
    close(restoreFocus = false) {
      if (!panel) return;
      const hadFocus = panel.contains(document.activeElement);
      panel.remove();
      panel = null;
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      if (restoreFocus || hadFocus) button.focus();
    },
    toggle() {
      if (panel) ctl.close();
      else ctl.open();
    },
    refresh() {
      if (panel) redraw(panel, () => content(ctl));
    },
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    ctl.close(true);
  };
  const onPointer = (event) => {
    if (event.target instanceof Node && !wrap.contains(event.target)) ctl.close();
  };
  const button = trigger(ctl);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "dialog");
  wrap.append(button);
  return ctl;
}

// ---------------------------------------------------------------------------
// Dialog: focus moves in, Tab stays inside, Escape closes, focus goes back
// ---------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
let dialogCount = 0;

/** openDialog({ title, wide, body() -> nodes, footer() -> nodes, onClose, canClose() }) -> { update(), close(), setTitle() } */
export function openDialog({ title, wide = false, body, footer, onClose, canClose }) {
  dialogCount += 1;
  const titleId = `dialog-title-${dialogCount}`;
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const heading = h("h2", { id: titleId, class: "dialog-title" }, title);
  const bodyEl = h("div", { class: "dialog-body" });
  const footerEl = h("div", { class: "dialog-footer" });
  const panel = h(
    "div",
    { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1", class: cx("dialog", wide && "dialog-wide") },
    h("div", { class: "dialog-head" }, heading, IconButton({ label: "Close", onclick: () => ctl.close() }, "x", 18)),
    bodyEl,
    footerEl
  );
  const backdrop = h("div", { class: "dialog-backdrop" }, panel);
  let closed = false;

  const onKey = (event) => {
    if (closed) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      ctl.close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter((item) => item.offsetParent !== null || item === document.activeElement);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const ctl = {
    el: panel,
    update() {
      if (closed) return;
      redraw(bodyEl, () => body(ctl));
      const foot = footer ? footer(ctl) : null;
      const list = [].concat(foot || []).filter(Boolean);
      footerEl.hidden = list.length === 0;
      redraw(footerEl, () => list);
      if (!panel.contains(document.activeElement)) panel.focus();
    },
    setTitle(next) {
      heading.textContent = next;
    },
    close(force = false) {
      if (closed) return;
      if (!force && canClose && !canClose()) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (!document.querySelector(".dialog-backdrop")) document.body.classList.remove("has-dialog");
      if (before && document.contains(before)) before.focus();
      if (onClose) onClose();
    },
    isOpen: () => !closed,
  };

  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) ctl.close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  document.body.classList.add("has-dialog");
  ctl.update();
  panel.focus();
  return ctl;
}

export function relativeTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(then).toLocaleDateString();
}
