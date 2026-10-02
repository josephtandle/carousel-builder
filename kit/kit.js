/*
 * Carousel kit runtime.
 * 1. Reads the JSON block <script type="application/json" id="content">.
 * 2. Sets the canvas size (content.size: portrait 1080x1350, square 1080x1080, story 1080x1920).
 * 3. Injects the optional background image and the optional chrome (corner marks, byline header, progress footer).
 * 4. Binds content into [data-field], [data-src], [data-list] (with <template>), [data-width].
 * 5. Fits text: [data-fit-line] elements shrink alone to one line, then every [data-fit-box] shrinks its
 *    [data-fit] children together until nothing overflows (supporting copy never goes below 30px).
 * 6. Runs QA (safe area, canvas, overflow, clipping, overlap, banned characters, fonts, images)
 *    and writes the result to <pre id="__qa" hidden>, then posts it to the qa-endpoint for render.mjs.
 *
 * Copy markup: *word* = accent italic, **word** = strong, a newline = line break.
 * Byline and logo come from the content (the renderer fills them from the brand config). There is no default.
 */
(function () {
  "use strict";
  // Keep in step with SIZES in lib/deck-schema.js and html[data-size] in tokens.css.
  const SIZES = {
    portrait: { w: 1080, h: 1350, safeX: 90, safeY: 120 },
    square: { w: 1080, h: 1080, safeX: 90, safeY: 96 },
    story: { w: 1080, h: 1920, safeX: 90, safeY: 250 }
  };
  let SIZE = "portrait", W = 1080, H = 1350, SAFE_X = 90, SAFE_Y = 120;
  const imageLoads = [];

  function readContent() {
    const el = document.getElementById("content");
    if (!el) return {};
    try { return JSON.parse(el.textContent); } catch (e) { window.__kitErrors = ["content JSON parse error: " + e.message]; return {}; }
  }

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function md(s) {
    return esc(s)
      // keep hyphenated words whole ("one-page" never splits as "one-" / "page")
      .replace(/([A-Za-z0-9$%]+(?:-[A-Za-z0-9]+)+)/g, '<span class="nw">$1</span>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // a blank line is a short paragraph gap, not a whole empty line of display type
      .replace(/\n{2,}/g, '<span class="para"></span>')
      .replace(/\n/g, "<br>");
  }
  function isEmpty(v) { return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0); }
  function pad(n) { return String(n).padStart(2, "0"); }

  function hideEmpty(el) {
    const wrap = el.closest("[data-optional]") || el;
    wrap.classList.add("is-empty");
  }

  function bindScope(root, data) {
    // lists first, so their clones are bound with the item scope
    root.querySelectorAll("[data-list]").forEach((listEl) => {
      if (listEl.parentElement && listEl.parentElement.closest("[data-list]")) return;
      const key = listEl.getAttribute("data-list");
      const tpl = listEl.querySelector("template");
      const items = data[key];
      if (!tpl) return;
      if (!Array.isArray(items) || !items.length) { hideEmpty(listEl); return; }
      const nums = items.map((it) => (it && typeof it === "object" ? Number(it.value) : NaN)).filter((n) => !isNaN(n));
      const max = nums.length ? Math.max.apply(null, nums) : 0;
      items.forEach((item, i) => {
        const scope = typeof item === "object" && item !== null ? Object.assign({}, item) : { text: item };
        scope.index = pad(i + 1);
        scope.n = String(i + 1);
        if (max > 0 && !isNaN(Number(scope.value))) scope._pct = Math.max(4, Math.round((Number(scope.value) / max) * 100));
        const frag = tpl.content.cloneNode(true);
        bindFields(frag, scope);
        listEl.appendChild(frag);
      });
    });
    bindFields(root, data, true);
  }

  function bindFields(root, data, skipLists) {
    const inList = (el) => skipLists && el.closest("[data-list]");
    root.querySelectorAll("[data-field]").forEach((el) => {
      if (inList(el)) return;
      const v = data[el.getAttribute("data-field")];
      if (isEmpty(v)) { hideEmpty(el); return; }
      el.innerHTML = md(v);
    });
    root.querySelectorAll("[data-src]").forEach((el) => {
      if (inList(el)) return;
      const v = data[el.getAttribute("data-src")];
      if (isEmpty(v)) { hideEmpty(el); return; }
      if (el.tagName === "IMG") el.src = v;
      else { el.style.backgroundImage = 'url("' + String(v).replace(/["\\\n]/g, encodeURIComponent) + '")'; imageLoads.push(checkImage(v)); }
    });
    root.querySelectorAll("[data-width]").forEach((el) => {
      if (inList(el)) return;
      const v = data[el.getAttribute("data-width")];
      if (!isEmpty(v)) el.style.width = v + "%";
    });
    root.querySelectorAll("[data-flag]").forEach((el) => {
      if (inList(el)) return;
      if (data[el.getAttribute("data-flag")]) el.classList.add("is-on");
    });
  }

  // CSS background images never report a failed load, so each one is also loaded through an Image and checked.
  function checkImage(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im.naturalWidth > 0 ? null : src);
      im.onerror = () => resolve(src);
      im.src = src;
    });
  }

  function applySize(c) {
    SIZE = Object.prototype.hasOwnProperty.call(SIZES, c.size) ? c.size : (document.documentElement.getAttribute("data-size") || "portrait");
    if (!Object.prototype.hasOwnProperty.call(SIZES, SIZE)) SIZE = "portrait";
    const s = SIZES[SIZE];
    W = s.w; H = s.h; SAFE_X = s.safeX; SAFE_Y = s.safeY;
    document.documentElement.setAttribute("data-size", SIZE);
  }

  // Optional background: { src, tint }. Only layouts marked data-bg take one. The image fills the canvas, a layer
  // of the brand background colour (opacity = tint, 0..1) sits on it, and a fixed wash darkens the band the copy
  // sits in. A layout marked data-bg="photo" draws its own full-bleed photo: there the background image becomes
  // the photo when the slide has none, and the layout's own fade keeps the text readable.
  function injectBackground(slide, c) {
    const bg = c.background;
    if (!bg || typeof bg !== "object" || isEmpty(bg.src) || !slide.hasAttribute("data-bg")) return;
    if (slide.getAttribute("data-bg") === "photo") {
      if (isEmpty(c.photo)) c.photo = bg.src;
      return;
    }
    let tint = Number(bg.tint);
    if (bg.tint === undefined || bg.tint === null || bg.tint === "" || !isFinite(tint)) tint = 0.62;
    tint = Math.max(0, Math.min(1, tint));
    const img = document.createElement("img");
    img.className = "bg-photo"; img.alt = ""; img.setAttribute("data-decor", ""); img.setAttribute("aria-hidden", "true");
    img.src = bg.src;
    const layer = document.createElement("div");
    layer.className = "bg-tint"; layer.setAttribute("data-decor", ""); layer.setAttribute("aria-hidden", "true");
    layer.style.opacity = String(tint);
    const wash = document.createElement("div");
    wash.className = "bg-wash"; wash.setAttribute("data-decor", ""); wash.setAttribute("aria-hidden", "true");
    slide.classList.add("has-bg");
    slide.insertBefore(wash, slide.firstChild);
    slide.insertBefore(layer, wash);
    slide.insertBefore(img, layer);
  }

  // Optional chrome, all off unless the content switches it on:
  // show_corners, show_byline, show_counter, show_progress, show_cue. The byline text and the logo come from
  // content.byline and content.logo (filled from the brand config by the renderer); an empty value shows nothing.
  function injectChrome(slide, c) {
    if (slide.hasAttribute("data-no-chrome")) return;
    const total = Number(c.total) || 1, n = Math.min(Number(c.slide) || 1, total);
    const last = n >= total;
    let html = '<div class="grain" data-decor aria-hidden="true"></div>';
    if (c.show_corners === true) html += '<div class="corner tl" data-decor aria-hidden="true"></div><div class="corner br" data-decor aria-hidden="true"></div>';
    const logo = c.show_byline && !isEmpty(c.logo) ? '<img src="' + escAttr(c.logo) + '" alt="">' : "";
    const byline = c.show_byline && !isEmpty(c.byline) ? '<span class="byline">' + md(c.byline) + "</span>" : "";
    if (logo || byline || c.show_counter) {
      slide.classList.add("has-top");
      html += '<header class="sig-top"><div class="who">' + logo + byline + "</div>" +
        (c.show_counter ? '<span class="count">' + pad(n) + " / " + pad(total) + "</span>" : "") + "</header>";
    }
    if (c.show_progress || c.show_cue) {
      slide.classList.add("has-bottom");
      const cue = c.cue || (last ? "Save this" : "Swipe");
      html += '<footer class="sig-bottom">' + (c.show_progress ? '<div class="progress" aria-hidden="true"><i style="width:' + Math.round((n / total) * 100) + '%"></i></div>' : "") +
        (c.show_cue ? '<span class="cue">' + esc(cue) + (last ? "" : '<span class="arrow" aria-hidden="true"></span>') + "</span>" : "") + "</footer>";
    }
    slide.insertAdjacentHTML("afterbegin", html);
  }

  /* ---------- FIT ---------- */
  function boxOverflows(box, targets) {
    const tol = Math.max(2, ...targets.map(vTol));
    if (box.scrollHeight > box.clientHeight + tol || box.scrollWidth > box.clientWidth + 1) return true;
    const b = box.getBoundingClientRect();
    for (const ch of box.querySelectorAll("*")) {
      if (ch.closest(".is-empty") || ch.hasAttribute("data-decor")) continue;
      if (getComputedStyle(ch).display === "inline") continue; // inline boxes use the font content area; lines are covered by scrollHeight
      const r = ch.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1) return true;
    }
    for (const t of targets) if (t.scrollWidth > t.clientWidth + 1 || intoPadding(t) || t.scrollHeight > t.clientHeight + vTol(t)) return true;
    return false;
  }

  // Chrome counts each line's full font content area (ascent+descent) in scrollHeight, so tight display
  // line-heights read as a few px of "overflow" with nothing clipped. Real clipping is caught by the glyph-rect checks.
  // text wider than the element's content box (it ran into the padding; scrollWidth cannot see this)
  function intoPadding(el) {
    if (!el.clientWidth) return false;
    const cs = getComputedStyle(el);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    if (pad < 1) return false; // no padding: scrollWidth already covers it
    const inner = el.clientWidth - pad;
    const r = document.createRange(); r.selectNodeContents(el);
    return r.getBoundingClientRect().width > inner + 1;
  }
  function vTol(el) { return Math.max(2, parseFloat(getComputedStyle(el).fontSize) * 0.2); }

  // One-line elements ([data-fit-line]: the big number, the keyword pill) shrink alone, before the box they sit in
  // is fitted, so a long figure never drags the lines around it down with it.
  function fitLines() {
    document.querySelectorAll("[data-fit-line]").forEach((el) => {
      if (el.closest(".is-empty")) return;
      const base = parseFloat(getComputedStyle(el).fontSize);
      let s = 1;
      while ((el.scrollWidth > el.clientWidth + 1 || intoPadding(el)) && s > 0.15) {
        s = Math.max(0.15, s - 0.02);
        el.style.fontSize = (base * s).toFixed(2) + "px";
      }
    });
  }

  // Every [data-fit-box] shrinks its [data-fit] children together until nothing overflows. Supporting copy stops
  // shrinking at FIT_FLOOR px (it stays readable on a phone) while the display type above it keeps going.
  // A target can set its own floor with data-fit-floor (the axis labels of the two by two do).
  const FIT_FLOOR = 30;
  function fitAll() {
    const failures = [];
    fitLines();
    document.querySelectorAll("[data-fit-box]").forEach((box) => {
      const targets = Array.from(box.querySelectorAll("[data-fit]"));
      if (box.hasAttribute("data-fit")) targets.unshift(box);
      const base = targets.map((t) => parseFloat(getComputedStyle(t).fontSize));
      const floor = base.map((px, i) => Math.min(px, Number(targets[i].getAttribute("data-fit-floor")) || FIT_FLOOR));
      const min = parseFloat(box.getAttribute("data-fit-min") || "0.4");
      let s = 1;
      while (boxOverflows(box, targets) && s > min) {
        s = Math.max(min, s - 0.025);
        targets.forEach((t, i) => { t.style.fontSize = Math.max(base[i] * s, floor[i]).toFixed(2) + "px"; });
      }
      // A very short headline ([data-fit-grow="1.5"], one or two lines) grows to fill its measure: it stops at the
      // given scale, or as soon as growing would add a line or overflow the box.
      if (s === 1) {
        targets.forEach((t, i) => {
          const max = parseFloat(t.getAttribute("data-fit-grow") || "0");
          if (!(max > 1) || t.closest(".is-empty")) return;
          const lines = () => Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight));
          const before = lines();
          if (before > 2) return;
          let g = 1;
          while (g < max) {
            const next = Math.min(max, g + 0.05);
            t.style.fontSize = (base[i] * next).toFixed(2) + "px";
            if (lines() > before || boxOverflows(box, targets)) { t.style.fontSize = g === 1 ? "" : (base[i] * g).toFixed(2) + "px"; break; }
            g = next;
          }
        });
      }
      box.setAttribute("data-fit-scale", s.toFixed(3));
      if (boxOverflows(box, targets)) failures.push((box.id || box.className || box.tagName) + " still overflows at min scale " + min);
    });
    return failures;
  }

  /* ---------- QA ---------- */
  function textElements() {
    const out = [];
    document.querySelectorAll(".slide *").forEach((el) => {
      if (el.closest("[data-decor]") || el.closest(".is-empty") || el.closest("template")) return;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;
      out.push(el);
    });
    return out;
  }
  function textRects(el) {
    const rects = [];
    el.childNodes.forEach((n) => {
      if (n.nodeType !== 3 || !n.textContent.trim()) return;
      const r = document.createRange(); r.selectNodeContents(n);
      Array.from(r.getClientRects()).forEach((x) => { if (x.width > 0.5 && x.height > 0.5) rects.push(x); });
    });
    return rects;
  }
  function label(el) {
    const f = el.getAttribute("data-field") || (el.closest("[data-field]") && el.closest("[data-field]").getAttribute("data-field"));
    return (f ? "[" + f + "] " : "") + "<" + el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "") + "> \"" + el.textContent.trim().slice(0, 40) + "\"";
  }
  function union(rects) {
    return rects.reduce((u, r) => ({ left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  }

  function qa(fitFailures, imageFailures) {
    const issues = [].concat(window.__kitErrors || [], fitFailures, (imageFailures || []).map((src) => "image failed to load: " + src));
    const els = textElements();
    const T = 1;
    const boxes = els.map((el) => ({ el, rects: textRects(el) })).filter((x) => x.rects.length);
    // For overlap only: trim each line box by 12% of font size top and bottom. Display fonts carry ~0.2em of empty
    // ascent/descent above and below the ink, so raw content boxes of stacked big type "overlap" with no visible collision.
    const inkRects = (el, rects) => { const f = parseFloat(getComputedStyle(el).fontSize) * 0.12;
      return rects.map((r) => ({ left: r.left, right: r.right, top: r.top + f, bottom: r.bottom - f })); };

    boxes.forEach(({ el, rects }) => {
      const u = union(rects);
      if (u.left < -T || u.top < -T || u.right > W + T || u.bottom > H + T) issues.push("outside canvas: " + label(el));
      else if (u.left < SAFE_X - T || u.right > W - SAFE_X + T || u.top < SAFE_Y - T || u.bottom > H - SAFE_Y + T)
        issues.push("outside safe area (" + [u.left, u.top, u.right, u.bottom].map(Math.round).join(",") + "): " + label(el));
      if (getComputedStyle(el).display !== "inline" && intoPadding(el)) issues.push("text runs into padding: " + label(el));
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + T) issues.push("horizontal overflow (scrollWidth " + el.scrollWidth + " > " + el.clientWidth + "): " + label(el));
      if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + vTol(el) && getComputedStyle(el).display !== "inline") issues.push("vertical overflow (scrollHeight " + el.scrollHeight + " > " + el.clientHeight + "): " + label(el));
      // clipped by the element itself or any ancestor that hides overflow
      let a = el;
      while (a && a !== document.body) {
        const ov = getComputedStyle(a);
        if (ov.overflowX !== "visible" || ov.overflowY !== "visible") {
          const ar = a.getBoundingClientRect();
          if (u.left < ar.left - T || u.right > ar.right + T || u.top < ar.top - T || u.bottom > ar.bottom + T) { issues.push("clipped by ancestor <" + a.tagName.toLowerCase() + "." + String(a.className).split(" ")[0] + ">: " + label(el)); break; }
        }
        a = a.parentElement;
      }
    });

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        let hit = false;
        for (const ra of inkRects(A.el, A.rects)) {
          for (const rb of inkRects(B.el, B.rects)) {
            const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (ix > 2 && iy > 2) { hit = true; break; }
          }
          if (hit) break;
        }
        if (hit) issues.push("text overlap: " + label(A.el) + " x " + label(B.el));
      }
    }

    const allText = document.querySelector(".slide").innerText;
    if (/\u2014/.test(allText)) issues.push("em dash found in copy");
    if (/\p{Extended_Pictographic}/u.test(allText)) issues.push("emoji found in copy");
    document.querySelectorAll(".slide img").forEach((img) => {
      if (!img.closest(".is-empty") && !(img.complete && img.naturalWidth > 0)) issues.push("image failed to load: " + img.getAttribute("src"));
    });
    // every font family actually used by visible text must be loaded (no silent system-font fallback)
    const fams = new Set();
    boxes.forEach(({ el }) => { const cs = getComputedStyle(el); fams.add(cs.fontStyle + " " + cs.fontWeight + " 40px " + cs.fontFamily.split(",")[0].trim()); });
    fams.forEach((f) => { if (!document.fonts.check(f)) issues.push("font not loaded: " + f); });
    document.fonts.forEach((ff) => { if (ff.status === "error") issues.push("font file failed: " + ff.family); });
    const slide = document.querySelector(".slide").getBoundingClientRect();
    if (Math.round(slide.width) !== W || Math.round(slide.height) !== H) issues.push("canvas is " + slide.width + "x" + slide.height + ", expected " + W + "x" + H);

    const scales = {};
    document.querySelectorAll("[data-fit-box]").forEach((b, i) => { scales[b.id || "box" + i] = Number(b.getAttribute("data-fit-scale")); });
    return { ok: issues.length === 0, issues, textElements: boxes.length, fitScales: scales, size: SIZE, width: W, height: H };
  }

  async function run() {
    const c = readContent();
    const slide = document.querySelector(".slide");
    applySize(c);
    if (c.theme === "deep") slide.classList.add("is-deep");
    injectChrome(slide, c);
    injectBackground(slide, c);
    // a layout can register window.kitLayoutSetup(content, canvas) to place size-dependent decoration
    if (typeof window.kitLayoutSetup === "function") {
      try { window.kitLayoutSetup(c, { size: SIZE, w: W, h: H, safeX: SAFE_X, safeY: SAFE_Y }); }
      catch (e) { (window.__kitErrors = window.__kitErrors || []).push("layout setup error: " + e.message); }
    }
    bindScope(document, c);
    // a full-bleed photo behind the copy counts as a background for the type treatment
    const ownPhoto = slide.getAttribute("data-bg") === "photo" ? slide.querySelector("[data-src='photo']") : null;
    if (ownPhoto && !ownPhoto.classList.contains("is-empty")) slide.classList.add("has-bg");
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
    const imageFailures = (await Promise.all(imageLoads)).filter(Boolean);
    const failures = fitAll();
    const result = qa(failures, imageFailures);
    const pre = document.createElement("pre");
    pre.id = "__qa"; pre.hidden = true; pre.textContent = JSON.stringify(result);
    document.body.appendChild(pre);
    document.documentElement.setAttribute("data-kit-done", result.ok ? "ok" : "issues");
    const ep = document.querySelector('meta[name="qa-endpoint"]');
    if (ep) { try { await fetch(ep.content, { method: "POST", body: JSON.stringify(result) }); } catch (e) { /* render.mjs reports a missing QA result */ } }
    if (!result.ok) console.warn("Carousel QA issues:\n" + result.issues.join("\n"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
