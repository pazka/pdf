/**
 * pdf.hosh.it editor. The file is read, edited and saved in this page: nothing is sent anywhere
 * (the server only serves these static files, and the CSP forbids any other connection).
 *
 * State: per page a list of objects (js/engine.js). The canvas of a page always shows the result of
 * engine.preview(), the same code that writes the downloaded file.
 */
import { ASCENT, SHIPPED_FONTS, adoptPiece, createEngine } from "./engine.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const stage = $("stage");
const pagesEl = $("pages");
const thumbsEl = $("thumbs");
const props = $("props");

const S = {
  engine: null,
  bytes: null,
  doc: null,
  name: "",
  pages: [],
  images: new Map(),
  tool: "select",
  sel: null, // { page, id }
  editing: null,
  zoom: 1,
  undo: [],
  redo: [],
  seq: 0,
  dirty: false,
  clipboard: null,
  pendingLive: null,
  customFonts: 0,
  cssFonts: { Lato: '"Lato"', Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif', Times: '"Times New Roman", Times, "Liberation Serif", serif', Courier: '"Courier New", Courier, "Liberation Mono", monospace' },
  defaults: {
    text: { family: "Helvetica", size: 14, bold: false, italic: false, underline: false, strike: false, align: "left", color: [0, 0, 0], opacity: 1, lineHeight: 1.2 },
    shape: { stroke: [0.2, 0.28, 0.69], strokeWidth: 2, fill: null, dash: false, opacity: 1 },
    erase: { fill: [1, 1, 1] },
  },
};

/* Baseline position inside a CSS line box, in font sizes below the middle of the line. */
const BASELINE = { Lato: 0.387, Helvetica: 0.347, Times: 0.338, Courier: 0.267 };
const TITLES = { text: "Text", rect: "Rectangle", ellipse: "Ellipse", line: "Line", arrow: "Arrow", ink: "Drawing", image: "Image", erase: "Eraser", select: "Edit" };
const HELP = {
  select: "Click a text of the page to change it. Drag an object to move it, use its handles to resize it.",
  text: "Click on the page where the new text starts, then type.",
  image: "Choose a PNG (transparency is kept) or a JPEG. You can also paste or drop an image.",
  rect: "Drag on the page to draw.",
  ellipse: "Drag on the page to draw.",
  line: "Drag on the page to draw.",
  arrow: "Drag on the page to draw.",
  ink: "Draw with the mouse or a finger.",
  erase: "Drag over an area: the text under it is removed from the file and the area is covered.",
};

/* ---------- small helpers ---------- */

const hex = (c) => `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
const snap = () => JSON.stringify(S.pages.map((p) => p.objects));
const newId = () => `o${(S.seq += 1)}`;

let toastTimer = 0;
function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 7000 : 3500);
}

function findObj(sel = S.sel) {
  if (!sel) return null;
  return S.pages[sel.page]?.objects.find((o) => o.id === sel.id) || null;
}

/* ---------- history ---------- */

function pushUndo(before) {
  S.undo.push(before);
  if (S.undo.length > 200) S.undo.shift();
  S.redo.length = 0;
  S.dirty = true;
  syncHistory();
}
function mutate(fn) {
  const before = snap();
  fn();
  pushUndo(before);
  refreshAll();
}
function restore(json) {
  const lists = JSON.parse(json);
  S.pages.forEach((p, i) => (p.objects = lists[i] || []));
  if (!findObj()) S.sel = null;
  refreshAll();
}
function undo() {
  if (S.editing) return commitEdit();
  if (!S.undo.length) return;
  S.redo.push(snap());
  restore(S.undo.pop());
  syncHistory();
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(snap());
  restore(S.redo.pop());
  syncHistory();
}
function syncHistory() {
  $("undo").disabled = !S.undo.length;
  $("redo").disabled = !S.redo.length;
}

/* ---------- rendering ---------- */

let frame = 0;
function schedule(page) {
  page.stale = true;
  root.dataset.busy = "1";
  if (!frame) frame = requestAnimationFrame(renderSome);
}
function renderSome() {
  frame = 0;
  const next = S.pages.find((p) => p.stale && p.visible) || S.pages.find((p) => p.thumbStale);
  if (!next) {
    delete root.dataset.busy;
    return;
  }
  try {
    if (next.stale && next.visible) renderPage(next);
    else renderThumb(next);
  } catch (err) {
    next.stale = false;
    next.thumbStale = false;
    console.error(err);
    toast(`This page could not be drawn: ${err.message || err}`, true);
  }
  frame = requestAnimationFrame(renderSome);
}

function visibleObjects(page) {
  if (!S.editing || S.editing.page !== page.index) return page.objects;
  // the text being typed is shown by the text box; what it replaces stays removed from the page
  return page.objects.map((o) => (o.id === S.editing.id ? { ...o, text: "" } : o));
}

function paint(canvas, r) {
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext("2d").putImageData(new ImageData(r.pixels, r.width, r.height), 0, 0);
}

let lastMissing = "";
function renderPage(page) {
  page.stale = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // at most about 12 million pixels per page, whatever the zoom
  const scale = Math.min(S.zoom * dpr, Math.sqrt(12e6 / (page.size.width * page.size.height)));
  const r = S.engine.preview(S.bytes, page.index, visibleObjects(page), S.images, scale);
  paint(page.canvas, r);
  if (!page.pieces) {
    page.pieces = S.engine.extractText(S.doc, page.index);
    drawOverlay(page);
  }
  page.thumbStale = true;
  if (r.missing.length && r.missing.join("") !== lastMissing) {
    lastMissing = r.missing.join("");
    toast(`No font here has these characters, they are written as "?": ${r.missing.join(" ")}`, true);
  }
}

function renderThumb(page) {
  page.thumbStale = false;
  const scale = (96 * Math.min(window.devicePixelRatio || 1, 2)) / page.size.width;
  paint(page.thumb, S.engine.preview(S.bytes, page.index, visibleObjects(page), S.images, scale));
}

function layout() {
  for (const p of S.pages) {
    p.el.style.width = `${p.size.width * S.zoom}px`;
    p.el.style.height = `${p.size.height * S.zoom}px`;
    schedule(p);
    drawOverlay(p);
  }
  $("zoom-fit").textContent = `${Math.round(S.zoom * 100)}%`;
}

function fitZoom() {
  const widest = Math.max(...S.pages.map((p) => p.size.width));
  return Math.min(1.6, Math.max(0.25, (stage.clientWidth - 40) / widest));
}
function setZoom(z) {
  S.zoom = Math.min(5, Math.max(0.2, z));
  layout();
}

function refreshAll() {
  for (const p of S.pages) {
    schedule(p);
    drawOverlay(p);
  }
  syncProps();
}
function refreshPage(page) {
  schedule(page);
  drawOverlay(page);
}

/* ---------- overlay: boxes of existing text and of objects ---------- */

function place(el, x0, y0, x1, y1, pad = 0) {
  el.style.left = `${x0 * S.zoom - pad}px`;
  el.style.top = `${y0 * S.zoom - pad}px`;
  el.style.width = `${Math.max(1, (x1 - x0) * S.zoom + pad * 2)}px`;
  el.style.height = `${Math.max(1, (y1 - y0) * S.zoom + pad * 2)}px`;
}

function handlesOf(o) {
  if (o.type === "line" || o.type === "arrow") return ["p1", "p2"];
  if (o.type === "ink") return [];
  if (o.type === "text") return ["se"];
  return ["nw", "ne", "sw", "se"];
}

function drawOverlay(page) {
  const ov = page.overlay;
  const editor = S.editing && S.editing.page === page.index ? S.editing.el : null;
  ov.replaceChildren();
  ov.className = `overlay tool-${S.tool}`;
  if (S.tool === "text") ov.classList.add("textcursor");
  else if (S.tool !== "select" && S.tool !== "image") ov.classList.add("create");
  const adopted = new Set(page.objects.map((o) => o.piece).filter((v) => v !== undefined));
  (page.pieces || []).forEach((piece, i) => {
    if (adopted.has(i)) return;
    const el = document.createElement("div");
    el.className = "piece";
    el.dataset.piece = String(i);
    el.dataset.text = piece.text.slice(0, 60);
    place(el, ...piece.bbox, 2);
    ov.append(el);
  });
  for (const o of page.objects) {
    if (editor && S.editing.id === o.id) continue;
    const el = document.createElement("div");
    el.className = "obj";
    el.dataset.id = o.id;
    el.dataset.type = o.type;
    const b = S.engine.bounds(o);
    place(el, ...b, 3);
    if (S.sel && S.sel.page === page.index && S.sel.id === o.id) {
      el.classList.add("sel");
      for (const h of handlesOf(o)) {
        const k = document.createElement("div");
        k.className = `handle ${h}`;
        k.dataset.handle = h;
        const w = (b[2] - b[0]) * S.zoom + 6, hgt = (b[3] - b[1]) * S.zoom + 6;
        let x = h.includes("w") ? 0 : w, y = h.includes("n") ? 0 : hgt;
        if (h === "p1") [x, y] = [(o.x1 - b[0]) * S.zoom + 3, (o.y1 - b[1]) * S.zoom + 3];
        if (h === "p2") [x, y] = [(o.x2 - b[0]) * S.zoom + 3, (o.y2 - b[1]) * S.zoom + 3];
        k.style.left = `${x - 1}px`;
        k.style.top = `${y - 1}px`;
        el.append(k);
      }
    }
    ov.append(el);
  }
  if (editor) {
    ov.append(editor);
    sizeEditor();
  }
}

/* ---------- selection and properties panel ---------- */

function select(pageIndex, id) {
  S.sel = id ? { page: pageIndex, id } : null;
  for (const p of S.pages) drawOverlay(p);
  syncProps();
}

function setTool(tool) {
  if (S.editing) commitEdit();
  if (tool === "image") {
    $("image-file").click();
    return;
  }
  S.tool = tool;
  if (tool !== "select") S.sel = null;
  for (const b of $("tools").querySelectorAll("button")) b.classList.toggle("on", b.dataset.tool === tool);
  for (const p of S.pages) drawOverlay(p);
  syncProps();
}

/** What the panel edits: the selected object, else the defaults of the current tool. */
function target() {
  const o = findObj();
  if (o) return { o, kind: o.type, selected: true };
  if (S.tool === "text") return { o: S.defaults.text, kind: "text", selected: false };
  if (S.tool === "erase") return { o: S.defaults.erase, kind: "erase", selected: false };
  if (["rect", "ellipse", "line", "arrow", "ink"].includes(S.tool)) return { o: S.defaults.shape, kind: S.tool, selected: false };
  return { o: null, kind: "select", selected: false };
}

function syncProps() {
  if (!S.bytes) {
    props.hidden = true;
    return;
  }
  props.hidden = false;
  const { o, kind, selected } = target();
  const show = { text: kind === "text", stroke: ["rect", "ellipse", "line", "arrow", "ink"].includes(kind), fill: ["rect", "ellipse", "erase"].includes(kind), opacity: !!o && kind !== "erase", object: selected };
  for (const row of props.querySelectorAll(".row")) row.hidden = !show[row.dataset.for];
  $("props-title").textContent = TITLES[kind] || "Edit";
  $("props-help").textContent = selected ? (kind === "text" ? "Double-click the text to type in it." : "") : HELP[S.tool] || "";
  const note = $("font-note");
  note.hidden = true;
  if (!o) return;
  if (kind === "text") {
    const sel = $("p-family");
    const fams = S.engine.families();
    if (sel.options.length !== fams.length) sel.replaceChildren(...fams.map((f) => new Option(f, f)));
    sel.value = o.family;
    $("p-size").value = String(Math.round(o.size * 100) / 100);
    $("p-bold").classList.toggle("on", !!o.bold);
    $("p-italic").classList.toggle("on", !!o.italic);
    $("p-underline").classList.toggle("on", !!o.underline);
    $("p-strike").classList.toggle("on", !!o.strike);
    for (const b of props.querySelectorAll("[data-align]")) b.classList.toggle("on", b.dataset.align === (o.align || "left"));
    $("p-color").value = hex(o.color || [0, 0, 0]);
    if (selected && o.redact && o.exactFont === false) {
      note.hidden = false;
      note.textContent = `This text was set in "${o.fontName}". The editor does not have that font, so the text is rewritten in ${o.family}. To keep the exact look, add the font file below.`;
    }
  }
  if (show.stroke) {
    $("p-stroke").value = hex(o.stroke || [0, 0, 0]);
    $("p-stroke-width").value = String(o.strokeWidth ?? 1);
    $("p-dash").checked = !!o.dash;
  }
  if (show.fill) {
    $("p-fill").value = hex(o.fill || [1, 1, 1]);
    $("p-fill-on").checked = !!o.fill;
    $("p-fill-on").parentElement.hidden = kind === "erase";
  }
  if (show.opacity) $("p-opacity").value = String(o.opacity ?? 1);
}

/** Applies a change from the panel. `live` changes (colour picker, slider) make one undo step. */
function applyProp(fn, live = false) {
  const t = target();
  if (!t.o) return;
  if (t.selected) {
    if (live) {
      S.pendingLive ||= snap();
    } else if (!S.pendingLive) {
      pushUndo(snap());
    }
    fn(t.o);
    if (!live) endLive();
    refreshPage(S.pages[S.sel.page]);
    if (S.editing) styleEditor();
  } else {
    fn(t.o);
  }
  syncProps();
}
function endLive() {
  if (S.pendingLive) {
    pushUndo(S.pendingLive);
    S.pendingLive = null;
  }
}

/* ---------- text editing ---------- */

function styleEditor() {
  const ed = S.editing;
  if (!ed) return;
  const o = findObj({ page: ed.page, id: ed.id });
  const el = ed.el;
  el.style.fontFamily = S.cssFonts[o.family] || "sans-serif";
  el.style.fontWeight = o.bold ? "700" : "400";
  el.style.fontStyle = o.italic ? "italic" : "normal";
  el.style.fontSize = `${o.size * S.zoom}px`;
  el.style.lineHeight = String(o.lineHeight || 1.2);
  el.style.color = css(o.color || [0, 0, 0]);
  el.style.textAlign = o.align || "left";
  el.style.textDecoration = [o.underline ? "underline" : "", o.strike ? "line-through" : ""].join(" ").trim() || "none";
  sizeEditor();
}

function sizeEditor() {
  const ed = S.editing;
  if (!ed) return;
  const o = findObj({ page: ed.page, id: ed.id });
  const lines = ed.el.value.split("\n");
  const lh = o.lineHeight || 1.2;
  const width = Math.max(...lines.map((l) => S.engine.measure(l, o.family, o.bold, o.italic))) * o.size + o.size * 1.2;
  const left = o.align === "right" ? o.x - width : o.align === "center" ? o.x - width / 2 : o.x;
  const top = o.y - (lh / 2 + (BASELINE[o.family] ?? 0.35)) * o.size;
  ed.el.style.left = `${left * S.zoom}px`;
  ed.el.style.top = `${top * S.zoom}px`;
  ed.el.style.width = `${width * S.zoom}px`;
  ed.el.style.height = `${lines.length * lh * o.size * S.zoom}px`;
}

/** Opens the text box of object `o`. `before` is the undo state from before the object existed or changed. */
function startEdit(page, o, { before, isNew = false, adoptedNow = false } = {}) {
  if (S.editing) commitEdit();
  const el = document.createElement("textarea");
  el.className = "editor";
  el.spellcheck = false;
  el.setAttribute("aria-label", "Text");
  el.value = o.text;
  S.editing = { page: page.index, id: o.id, el, before: before || snap(), isNew, adoptedNow, startText: o.text };
  S.sel = { page: page.index, id: o.id };
  el.addEventListener("input", sizeEditor);
  el.addEventListener("blur", () => {
    // a click in the panel or on a tool also ends the edit; the object stays selected
    if (S.editing && S.editing.el === el) commitEdit();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      commitEdit();
    }
    e.stopPropagation();
  });
  for (const p of S.pages) drawOverlay(p);
  styleEditor();
  schedule(page);
  syncProps();
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function commitEdit() {
  const ed = S.editing;
  if (!ed) return;
  S.editing = null;
  const page = S.pages[ed.page];
  const o = page.objects.find((x) => x.id === ed.id);
  const text = ed.el.value.replace(/\r/g, "");
  ed.el.remove();
  if (o) {
    o.text = text;
    const untouched = text === ed.startText;
    if (ed.isNew && text.trim() === "") {
      page.objects = page.objects.filter((x) => x !== o);
      S.sel = null;
    } else if (ed.adoptedNow && untouched) {
      // clicked a text and left it as it was: the page keeps its original text
      page.objects = page.objects.filter((x) => x !== o);
      S.sel = null;
    } else if (!untouched || ed.isNew) {
      pushUndo(ed.before);
    }
  }
  // a text was added with the Text tool: back to Edit, the new text selected, ready to be moved
  if (S.tool === "text" && S.sel) {
    const keep = S.sel;
    setTool("select");
    S.sel = keep;
  }
  refreshAll();
}

/* ---------- pointer interactions ---------- */

function toPage(e, page) {
  const r = page.overlay.getBoundingClientRect();
  return [(e.clientX - r.left) / S.zoom, (e.clientY - r.top) / S.zoom];
}

function drag(e, onMove, onEnd) {
  e.preventDefault();
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onEnd(ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function translate(o, from, dx, dy) {
  if (o.type === "line" || o.type === "arrow") {
    o.x1 = from.x1 + dx; o.y1 = from.y1 + dy; o.x2 = from.x2 + dx; o.y2 = from.y2 + dy;
  } else if (o.type === "ink") {
    o.strokes = from.strokes.map((s) => s.map(([x, y]) => [x + dx, y + dy]));
  } else {
    o.x = from.x + dx; o.y = from.y + dy;
  }
}

function startMove(e, page, o) {
  const before = snap();
  const from = JSON.parse(JSON.stringify(o));
  const p0 = toPage(e, page);
  let moved = false;
  drag(e, (ev) => {
    const p = toPage(ev, page);
    const dx = p[0] - p0[0], dy = p[1] - p0[1];
    if (!moved && Math.hypot(dx, dy) * S.zoom < 3) return;
    moved = true;
    translate(o, from, dx, dy);
    refreshPage(page);
  }, () => {
    if (moved) pushUndo(before);
  });
}

function startResize(e, page, o, handle) {
  const before = snap();
  const from = JSON.parse(JSON.stringify(o));
  const b0 = S.engine.bounds(from);
  let changed = false;
  drag(e, (ev) => {
    const [px, py] = toPage(ev, page);
    changed = true;
    if (handle === "p1") [o.x1, o.y1] = [px, py];
    else if (handle === "p2") [o.x2, o.y2] = [px, py];
    else if (o.type === "text") {
      // the handle scales the text; its top left corner stays where it is
      const k = Math.max(0.1, (py - b0[1]) / (b0[3] - b0[1]));
      o.size = Math.max(2, Math.round(from.size * k * 2) / 2);
      o.y = b0[1] + o.size * ASCENT;
    } else {
      let x0 = handle.includes("w") ? px : b0[0], x1 = handle.includes("w") ? b0[2] : px;
      let y0 = handle.includes("n") ? py : b0[1], y1 = handle.includes("n") ? b0[3] : py;
      if (o.type === "image" || ev.shiftKey) {
        // keep the proportions (always for an image)
        const ratio = from.w / from.h;
        const w = Math.abs(x1 - x0), h = Math.max(Math.abs(y1 - y0), w / ratio);
        const ww = h * ratio;
        if (handle.includes("w")) x0 = x1 - ww; else x1 = x0 + ww;
        if (handle.includes("n")) y0 = y1 - h; else y1 = y0 + h;
      }
      o.x = Math.min(x0, x1); o.y = Math.min(y0, y1);
      o.w = Math.max(2, Math.abs(x1 - x0)); o.h = Math.max(2, Math.abs(y1 - y0));
    }
    refreshPage(page);
    syncProps();
  }, () => {
    if (changed) pushUndo(before);
  });
}

function startCreate(e, page) {
  const before = snap();
  const [x0, y0] = toPage(e, page);
  const d = S.defaults.shape;
  const id = newId();
  let o;
  if (S.tool === "ink") o = { id, type: "ink", strokes: [[[x0, y0]]], stroke: d.stroke, strokeWidth: d.strokeWidth, opacity: d.opacity };
  else if (S.tool === "line" || S.tool === "arrow") o = { id, type: S.tool, x1: x0, y1: y0, x2: x0, y2: y0, stroke: d.stroke, strokeWidth: d.strokeWidth, dash: d.dash, opacity: d.opacity };
  else if (S.tool === "erase") o = { id, type: "erase", x: x0, y: y0, w: 0, h: 0, fill: S.defaults.erase.fill };
  else o = { id, type: S.tool, x: x0, y: y0, w: 0, h: 0, stroke: d.stroke, strokeWidth: d.strokeWidth, fill: d.fill, dash: d.dash, opacity: d.opacity };
  page.objects.push(o);
  drag(e, (ev) => {
    const [x, y] = toPage(ev, page);
    if (o.type === "ink") {
      const last = o.strokes[0][o.strokes[0].length - 1];
      if (Math.hypot(x - last[0], y - last[1]) * S.zoom >= 1.5) o.strokes[0].push([x, y]);
    } else if (o.type === "line" || o.type === "arrow") {
      o.x2 = x; o.y2 = y;
    } else {
      o.x = Math.min(x0, x); o.y = Math.min(y0, y); o.w = Math.abs(x - x0); o.h = Math.abs(y - y0);
    }
    refreshPage(page);
  }, () => {
    const b = S.engine.bounds(o);
    const tiny = o.type !== "ink" && Math.hypot(b[2] - b[0], b[3] - b[1]) * S.zoom < 5;
    if (tiny) {
      page.objects = page.objects.filter((x) => x !== o);
      refreshPage(page);
      return;
    }
    pushUndo(before);
    if (o.type === "ink") {
      refreshPage(page);
    } else {
      // back to the Edit tool with the new object selected, ready to be moved or styled
      S.sel = { page: page.index, id: o.id };
      setTool("select");
      S.sel = { page: page.index, id: o.id };
      select(page.index, o.id);
    }
  });
}

function onPointerDown(e, page) {
  if (e.button) return;
  const t = e.target;
  if (S.editing) {
    if (t === S.editing.el) return;
    commitEdit();
    return;
  }
  if (S.tool === "select") {
    if (t.dataset.handle) {
      const o = findObj();
      if (o) startResize(e, page, o, t.dataset.handle);
      return;
    }
    if (t.dataset.id) {
      const o = page.objects.find((x) => x.id === t.dataset.id);
      if (!o) return;
      const again = S.sel && S.sel.id === o.id;
      select(page.index, o.id);
      if (o.type === "text" && (e.detail >= 2 || (again && e.pointerType === "touch"))) {
        e.preventDefault();
        startEdit(page, o);
        return;
      }
      startMove(e, page, o);
      return;
    }
    if (t.dataset.piece) {
      e.preventDefault();
      const i = Number(t.dataset.piece);
      const before = snap();
      const o = adoptPiece(page.pieces[i], newId());
      o.piece = i;
      page.objects.push(o);
      startEdit(page, o, { before, adoptedNow: true });
      return;
    }
    if (S.sel) select(page.index, null);
    return;
  }
  if (S.tool === "text") {
    e.preventDefault();
    const [x, y] = toPage(e, page);
    const before = snap();
    const d = S.defaults.text;
    const o = { id: newId(), type: "text", text: "", x, y: y + d.size * 0.3, ...d, color: [...d.color] };
    page.objects.push(o);
    startEdit(page, o, { before, isNew: true });
    return;
  }
  startCreate(e, page);
}

/* ---------- objects: images, clipboard, order ---------- */

function currentPage() {
  const mid = stage.scrollTop + stage.clientHeight / 3;
  return S.pages.find((p) => p.el.offsetTop + p.el.offsetHeight > mid) || S.pages[S.pages.length - 1];
}

async function addImage(file, at) {
  if (!S.bytes) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let size;
  try {
    size = S.engine.imageSize(bytes);
  } catch {
    toast("This image could not be read. Use a PNG or a JPEG.", true);
    return;
  }
  const page = at?.page || currentPage();
  const imageId = `img${(S.seq += 1)}`;
  S.images.set(imageId, bytes);
  // 96 pixels per inch, and never wider than 60 % of the page
  let w = size.width * 0.75, h = size.height * 0.75;
  const k = Math.min(1, (page.size.width * 0.6) / w, (page.size.height * 0.6) / h);
  w *= k; h *= k;
  const top = Math.max(0, (stage.scrollTop - page.el.offsetTop) / S.zoom);
  const x = at ? at.x - w / 2 : (page.size.width - w) / 2;
  const y = at ? at.y - h / 2 : Math.min(page.size.height - h, top + 40);
  const o = { id: newId(), type: "image", imageId, x, y: Math.max(0, y), w, h, opacity: 1 };
  mutate(() => page.objects.push(o));
  setTool("select");
  select(page.index, o.id);
}

function removeSelected() {
  const o = findObj();
  if (!o) return;
  const page = S.pages[S.sel.page];
  mutate(() => {
    // deleting an edited text of the file deletes that text: the object stays, empty, so its
    // original stays removed
    if (o.redact) o.text = "";
    else page.objects = page.objects.filter((x) => x !== o);
    S.sel = null;
  });
}

function duplicate(src = findObj(), pageIndex = S.sel?.page) {
  if (!src || pageIndex === undefined) return;
  const o = JSON.parse(JSON.stringify(src));
  o.id = newId();
  delete o.redact;
  delete o.piece;
  delete o.original;
  translate(o, JSON.parse(JSON.stringify(o)), 12, 12);
  mutate(() => S.pages[pageIndex].objects.push(o));
  select(pageIndex, o.id);
}

function reorder(toFront) {
  const o = findObj();
  if (!o) return;
  const page = S.pages[S.sel.page];
  mutate(() => {
    page.objects = page.objects.filter((x) => x !== o);
    if (toFront) page.objects.push(o);
    else page.objects.unshift(o);
  });
}

/* ---------- file: open and save ---------- */

function closeDoc() {
  if (S.doc) S.doc.destroy();
  S.doc = null;
  S.pages = [];
  S.images.clear();
  S.undo.length = 0;
  S.redo.length = 0;
  S.sel = null;
  S.editing = null;
  S.dirty = false;
  pagesEl.replaceChildren();
  thumbsEl.replaceChildren();
}

const seen = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const page = S.pages[Number(en.target.dataset.index)];
    if (!page) continue;
    page.visible = en.isIntersecting;
    if (page.visible && page.stale) schedule(page);
  }
}, { root: stage, rootMargin: "600px 0px" });

async function openFile(file) {
  if (!S.engine) return;
  if (S.dirty && !window.confirm("Open another file? The changes that were not downloaded are lost.")) return;
  root.dataset.state = "loading";
  let bytes, doc;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    doc = S.engine.open(bytes);
    if (doc.needsPassword()) {
      doc.destroy();
      throw new Error("this PDF is protected by a password, which is not supported yet");
    }
    if (!doc.countPages()) throw new Error("the file has no page");
  } catch (err) {
    root.dataset.state = S.bytes ? "ready" : "empty";
    toast(`This file could not be opened: ${err.message || err}`, true);
    return;
  }
  closeDoc();
  S.bytes = bytes;
  S.doc = doc;
  S.name = file.name || "document.pdf";
  $("filename").textContent = S.name;
  document.title = `${S.name} · pdf.hosh.it`;
  S.pages = S.engine.pageSizes(doc).map((size, index) => {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.index = String(index);
    const canvas = document.createElement("canvas");
    const overlay = document.createElement("div");
    el.append(canvas, overlay);
    const tb = document.createElement("button");
    tb.type = "button";
    tb.className = "thumb";
    tb.title = `Page ${index + 1}`;
    const thumb = document.createElement("canvas");
    thumb.width = 96;
    thumb.height = Math.round((96 * size.height) / size.width);
    tb.append(thumb, document.createTextNode(String(index + 1)));
    tb.addEventListener("click", () => el.scrollIntoView({ block: "start" }));
    const page = { index, size, objects: [], pieces: null, el, canvas, overlay, thumb, thumbEl: tb, stale: true, thumbStale: false, visible: index < 2 };
    overlay.addEventListener("pointerdown", (e) => onPointerDown(e, page));
    return page;
  });
  pagesEl.replaceChildren(...S.pages.map((p) => p.el));
  thumbsEl.replaceChildren(...S.pages.map((p) => p.thumbEl));
  for (const p of S.pages) seen.observe(p.el);
  $("drop").hidden = true;
  pagesEl.hidden = false;
  $("save").disabled = false;
  stage.scrollTop = 0;
  setTool("select"); // shows the properties panel, which takes its width before the fit is computed
  S.zoom = fitZoom();
  layout();
  syncHistory();
  syncProps();
  markCurrent();
  root.dataset.state = "ready";
}

function save() {
  if (!S.bytes) return;
  if (S.editing) commitEdit();
  let out;
  try {
    out = S.engine.exportPdf(S.bytes, S.pages.map((p) => p.objects), S.images);
  } catch (err) {
    console.error(err);
    toast(`The file could not be written: ${err.message || err}`, true);
    return;
  }
  const name = `${S.name.replace(/\.pdf$/i, "")}-edited.pdf`;
  const url = URL.createObjectURL(new Blob([out.data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  S.dirty = false;
  root.dataset.saved = String(out.data.length);
  toast(`Downloaded ${name}`);
}

function markCurrent() {
  const cur = S.pages.length ? currentPage() : null;
  for (const p of S.pages) p.thumbEl.classList.toggle("on", p === cur);
}

async function addFont(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const family = file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Custom font";
  try {
    S.engine.registerCustomFont(family, bytes);
    const cssName = `custom-font-${(S.customFonts += 1)}`;
    const face = new FontFace(cssName, bytes);
    await face.load();
    document.fonts.add(face);
    S.cssFonts[family] = `"${cssName}"`;
  } catch {
    toast("This font file could not be read. Use a TTF or OTF file.", true);
    return;
  }
  applyProp((o) => {
    o.family = family;
    o.exactFont = true;
  });
  toast(`Font "${family}" added`);
}

/* ---------- wiring ---------- */

function wire() {
  $("open").addEventListener("click", () => $("file").click());
  $("open-big").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) openFile(f);
  });
  $("image-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) addImage(f);
  });
  $("font-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) addFont(f);
  });
  $("save").addEventListener("click", save);
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("zoom-in").addEventListener("click", () => setZoom(S.zoom * 1.2));
  $("zoom-out").addEventListener("click", () => setZoom(S.zoom / 1.2));
  $("zoom-fit").addEventListener("click", () => S.pages.length && setZoom(fitZoom()));
  $("tools").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tool]");
    if (b && S.bytes) setTool(b.dataset.tool);
  });
  stage.addEventListener("scroll", markCurrent, { passive: true });
  stage.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !S.pages.length) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // properties
  $("p-family").addEventListener("change", (e) => applyProp((o) => {
    o.family = e.target.value;
    o.exactFont = true;
  }));
  $("p-size").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (v >= 1 && v <= 400) applyProp((o) => (o.size = v));
  });
  for (const [id, key] of [["p-bold", "bold"], ["p-italic", "italic"], ["p-underline", "underline"], ["p-strike", "strike"]]) {
    $(id).addEventListener("click", () => applyProp((o) => (o[key] = !o[key])));
  }
  for (const b of props.querySelectorAll("[data-align]")) {
    b.addEventListener("click", () => applyProp((o) => {
      // the text stays where it is: only its anchor moves to the matching edge
      if (o.id) {
        const [x0, , x1] = S.engine.bounds(o);
        o.x = b.dataset.align === "right" ? x1 : b.dataset.align === "center" ? (x0 + x1) / 2 : x0;
      }
      o.align = b.dataset.align;
    }));
  }
  const live = (id, fn) => {
    $(id).addEventListener("input", (e) => applyProp((o) => fn(o, e.target), true));
    $(id).addEventListener("change", endLive);
  };
  live("p-color", (o, el) => (o.color = rgb(el.value)));
  live("p-stroke", (o, el) => (o.stroke = rgb(el.value)));
  live("p-fill", (o, el) => (o.fill = rgb(el.value)));
  live("p-opacity", (o, el) => (o.opacity = Number(el.value)));
  $("p-stroke-width").addEventListener("change", (e) => applyProp((o) => (o.strokeWidth = Math.max(0, Number(e.target.value) || 0))));
  $("p-dash").addEventListener("change", (e) => applyProp((o) => (o.dash = e.target.checked)));
  $("p-fill-on").addEventListener("change", (e) => applyProp((o) => (o.fill = e.target.checked ? rgb($("p-fill").value) : null)));
  $("p-font-add").addEventListener("click", () => $("font-file").click());
  $("p-front").addEventListener("click", () => reorder(true));
  $("p-back").addEventListener("click", () => reorder(false));
  $("p-dup").addEventListener("click", () => duplicate());
  $("p-del").addEventListener("click", removeSelected);

  // drop a PDF or an image anywhere
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth += 1;
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove("dragging");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (/^image\/(png|jpeg)$/.test(f.type) && S.bytes) {
      const pageEl = e.target.closest?.(".page");
      const page = pageEl ? S.pages[Number(pageEl.dataset.index)] : null;
      const at = page ? (([x, y]) => ({ page, x, y }))(toPage(e, page)) : null;
      addImage(f, at);
    } else openFile(f);
  });
  window.addEventListener("paste", (e) => {
    if (e.target.closest?.("textarea, input")) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\/(png|jpeg)$/.test(x.type));
    if (f) {
      e.preventDefault();
      addImage(f);
    } else if (S.clipboard && S.bytes) {
      duplicate(S.clipboard, currentPage().index);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.closest?.("textarea, input, select")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "o") { e.preventDefault(); $("file").click(); return; }
    if (!S.bytes) return;
    if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod && k === "s") { e.preventDefault(); save(); return; }
    if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
    if (mod && k === "c") { const o = findObj(); if (o) S.clipboard = JSON.parse(JSON.stringify(o)); return; }
    const o = findObj();
    if (o && mod && o.type === "text" && ["b", "i", "u"].includes(k)) {
      e.preventDefault();
      const key = { b: "bold", i: "italic", u: "underline" }[k];
      applyProp((t) => (t[key] = !t[key]));
      return;
    }
    if (mod) return;
    if (o && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); removeSelected(); return; }
    if (o && e.key === "Enter" && o.type === "text") { e.preventDefault(); startEdit(S.pages[S.sel.page], o); return; }
    if (o && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      mutate(() => translate(o, JSON.parse(JSON.stringify(o)), dx, dy));
      return;
    }
    if (e.key === "Escape") { if (S.sel) select(0, null); else setTool("select"); return; }
    const tool = { v: "select", t: "text", r: "rect", o: "ellipse", l: "line", a: "arrow", d: "ink", e: "erase" }[k];
    if (tool) setTool(tool);
  });
  window.addEventListener("beforeunload", (e) => {
    if (S.dirty) e.preventDefault();
  });
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => S.pages.forEach(schedule), 150);
  });
}

async function boot() {
  wire();
  try {
    const mupdf = await import("../vendor/mupdf/mupdf.js");
    S.engine = createEngine(mupdf);
    await Promise.all(Object.entries(SHIPPED_FONTS).flatMap(([family, files]) => files.map(async (f, i) => {
      const res = await fetch(`/fonts/${f}`);
      if (!res.ok) throw new Error(`font ${f}: ${res.status}`);
      S.engine.registerFont(family, !!(i & 1), !!(i & 2), new Uint8Array(await res.arrayBuffer()));
    })));
    await document.fonts.load('16px "Lato"').catch(() => {});
    root.dataset.state = "empty";
  } catch (err) {
    console.error(err);
    root.dataset.state = "failed";
    const el = $("boot-error");
    el.hidden = false;
    el.textContent = `The editor could not start in this browser (${err.message || err}).`;
    $("open-big").disabled = true;
    $("open").disabled = true;
  }
}

boot();
