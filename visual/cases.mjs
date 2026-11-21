// Visual use cases of pdf (hosh-management AGENTS.md section 3), listed in TESTING.md "Visual use cases".
// Every case is shot at the 3 widths, each in a fresh browser context (a first-time visitor).
// Nothing is ever sent to the server: the fixture PDF (visual/fixture.pdf, built by test/fixture.mjs)
// is given to the page's own file input, exactly like "Open PDF" does, and the page is driven with
// real mouse and keyboard events. Each case also checks what it did before the shot is taken: these
// checks are the tests of the editor itself (web/js/app.js).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { png } from "../test/fixture.mjs";

export const WIDTHS = [1400, 1024, 390];

const b64 = (name) => readFileSync(new URL(name, import.meta.url)).toString("base64");
const FIXTURE = b64("./fixture.pdf");
const PROTECTED = b64("./protected.pdf");
const FONT = b64("../web/fonts/Lato-BoldItalic.ttf");
const IMAGE = Buffer.from(png({ width: 64, height: 64, rgb: [214, 69, 65], bottom: [20, 160, 90] })).toString("base64");

const idle = "document.documentElement.dataset.state === 'ready' && !document.documentElement.dataset.busy";

async function must(p, expression, what, ms = 15000) {
  if (!(await p.waitFor(expression, ms))) {
    let seen = "";
    try { seen = JSON.stringify(await p.evaluate(`(() => { try { return ${expression.includes("=>") ? "null" : `(${expression})`}; } catch (e) { return String(e); } })()`)); } catch { /* page gone */ }
    throw new Error(`${what}${seen ? ` (got ${seen})` : ""}`);
  }
}

/** Fails with `what` unless the expression is true right now. */
async function check(p, expression, what) {
  const value = await p.evaluate(expression);
  if (value !== true) throw new Error(`${what} (got ${JSON.stringify(value)})`);
}

async function started(p) {
  await must(p, "document.documentElement.dataset.state === 'empty'", "the editor did not start", 30000);
}

/** Gives a file to one of the page's file inputs, as the file picker would. */
async function give(p, inputId, base64, name, type) {
  await p.evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    const input = document.getElementById(${JSON.stringify(inputId)});
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    return true;
  })()`);
}

async function settle(p) {
  await must(p, idle, "the pages were not drawn");
  await must(p, "document.getElementById('toast').hidden", "a message stayed on screen");
  await sleep(150);
  await must(p, idle, "the pages were not drawn");
}

async function opened(p) {
  await started(p);
  await give(p, "file", FIXTURE, "fixture.pdf", "application/pdf");
  await must(p, `${idle} && document.querySelectorAll('.piece').length >= 10`, "the fixture did not open");
  await settle(p);
}

/** Window coordinates of a point of a page given in PDF points. */
async function at(p, x, y, page = 0) {
  return p.evaluate(`(() => {
    const r = document.querySelector('.page[data-index="${page}"] .overlay').getBoundingClientRect();
    const z = r.width / 595;
    return [r.left + ${x} * z, r.top + ${y} * z];
  })()`);
}

const mouse = (p, type, [x, y], buttons, clickCount = 1, modifiers = 0) => p.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount, modifiers, pointerType: "mouse" });

async function clickAt(p, x, y, page = 0, count = 1) {
  const c = await at(p, x, y, page);
  await mouse(p, "mouseMoved", c, 0);
  for (let i = 1; i <= count; i += 1) {
    await mouse(p, "mousePressed", c, 1, i);
    await mouse(p, "mouseReleased", c, 0, i);
  }
  await sleep(100);
}

/** A drag through the points; modifiers: 8 = Shift held. */
async function dragOn(p, points, page = 0, modifiers = 0) {
  const cs = [];
  for (const [x, y] of points) cs.push(await at(p, x, y, page));
  await mouse(p, "mouseMoved", cs[0], 0, 1, modifiers);
  await mouse(p, "mousePressed", cs[0], 1, 1, modifiers);
  for (const c of cs.slice(1)) {
    await mouse(p, "mouseMoved", c, 1, 1, modifiers);
    await sleep(30);
  }
  await mouse(p, "mouseReleased", cs[cs.length - 1], 0, 1, modifiers);
  await sleep(100);
}

async function tool(p, name) {
  await p.evaluate(`(() => { document.querySelector('#tools [data-tool="${name}"]').click(); return true; })()`);
  await sleep(50);
}

async function press(p, id) {
  await check(p, `(() => { const b = document.getElementById(${JSON.stringify(id)}); if (!b || b.disabled || b.closest('[hidden]')) return 'not clickable'; b.click(); return true; })()`, `button #${id}`);
  await sleep(80);
}

const CODES = { Escape: 27, Delete: 46, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
/** A key, with Ctrl (and Shift) when asked, on the page (not in a text box). */
async function key(p, k, { ctrl = false, shift = false } = {}) {
  const code = CODES[k] ?? k.toUpperCase().charCodeAt(0);
  const base = { key: k, code: CODES[k] ? k : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0) };
  await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(60);
}

/** Box of the selected object, in PDF points of its page (the selection frame is 3 px larger on each side). */
const box = (p) => p.evaluate(`(() => {
  const e = document.querySelector('.obj.sel');
  if (!e) return null;
  const r = e.getBoundingClientRect(), o = e.parentElement.getBoundingClientRect(), z = o.width / 595;
  return [(r.left - o.left + 3) / z, (r.top - o.top + 3) / z, (r.width - 6) / z, (r.height - 6) / z].map((v) => Math.round(v * 10) / 10);
})()`);
/** Colour of the page as it is drawn, at a point given in PDF points. */
const pixel = (p, x, y, page = 0) => p.evaluate(`(() => {
  const c = document.querySelector('.page[data-index="${page}"] canvas');
  const k = c.width / 595;
  const d = c.getContext("2d").getImageData(Math.round(${x} * k), Math.round(${y} * k), 1, 1).data;
  return [d[0], d[1], d[2]];
})()`);
const count = (p, selector) => p.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const closeTo = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/** Clicks the title of the fixture: its text box opens with the text of the file in it. */
async function openTitle(p) {
  await opened(p);
  await clickAt(p, 297, 143);
  await must(p, "document.activeElement?.classList.contains('editor') && document.activeElement.value === 'Facture brouillon F-001'", "clicking the title did not open its text box");
  // the box uses the font of the file, shipped with the editor
  await must(p, "getComputedStyle(document.activeElement).fontFamily.includes('Lato')", "the text box is not in Lato");
}

async function changeTitle(p) {
  await openTitle(p);
  await p.evaluate("(() => { document.activeElement.select(); return true; })()");
  await p.send("Input.insertText", { text: "Devis F-001" });
  await key(p, "Escape");
  await must(p, "!document.querySelector('.editor') && document.querySelectorAll('.obj[data-type=text]').length === 1", "the edit was not committed");
  await must(p, "!document.getElementById('undo').disabled && document.getElementById('p-family').value === 'Lato'", "the edited text is not selected with its font");
  await settle(p);
}

/** Captures what "Download PDF" writes, instead of letting the browser save a file. */
async function captureDownloads(p) {
  await p.evaluate(`(() => {
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__saved = blob; return make(blob); };
    HTMLAnchorElement.prototype.click = function () {};
    return true;
  })()`);
}

/** Downloads, then opens the downloaded bytes again in the editor. */
async function saveAndReopen(p) {
  await p.evaluate("(() => { window.__saved = null; document.getElementById('save').click(); return true; })()");
  await must(p, "!!window.__saved && window.__saved.type === 'application/pdf' && Number(document.documentElement.dataset.saved) > 10000", "nothing was written");
  await must(p, "/Downloaded fixture-edited\\.pdf/.test(document.getElementById('toast').textContent)", "no download message");
  await p.evaluate(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File([await window.__saved.arrayBuffer()], "fixture-edited.pdf", { type: "application/pdf" }));
    const input = document.getElementById("file");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await must(p, `${idle} && document.getElementById('filename').textContent === 'fixture-edited.pdf' && document.querySelectorAll('.piece').length >= 9`, "the saved file did not open");
  if ((await count(p, ".obj")) !== 0) throw new Error("the reopened file has pending edits");
}

const titles = (p) => p.evaluate("[...document.querySelectorAll('.page[data-index=\"0\"] .piece')].map((e) => e.dataset.text).filter((t) => /Devis|Facture|brouillon/.test(t))");

async function page2(p) {
  // the thumbnail of page 2 (on a phone the thumbnails are not shown: the click is sent to it anyway)
  await p.evaluate("(() => { document.querySelectorAll('.thumb')[1].click(); return true; })()");
  await must(p, `${idle} && document.querySelectorAll('.page[data-index="1"] .piece').length >= 5`, "page 2 was not drawn");
  await sleep(150);
}

export const CASES = [
  // ---------- no file ----------
  { id: "E1-empty", path: "/", dark: true, steps: started },
  {
    // a file that is not a PDF: a message, the editor stays as it was
    id: "E2-not-a-pdf", path: "/",
    steps: async (p) => {
      await started(p);
      await give(p, "file", Buffer.from("this is not a pdf").toString("base64"), "notes.pdf", "application/pdf");
      await must(p, "!document.getElementById('toast').hidden && /could not be opened/.test(document.getElementById('toast').textContent)", "no error message");
      await must(p, "document.documentElement.dataset.state === 'empty' && !document.getElementById('drop').hidden", "the editor left its start screen");
    },
  },
  {
    // a PDF protected by a password: refused with a message that says why
    id: "E3-protected", path: "/",
    steps: async (p) => {
      await started(p);
      await give(p, "file", PROTECTED, "protected.pdf", "application/pdf");
      await must(p, "!document.getElementById('toast').hidden && /protected by a password/.test(document.getElementById('toast').textContent)", "no message about the password");
      await check(p, "document.documentElement.dataset.state === 'empty' && !document.getElementById('drop').hidden && document.getElementById('save').disabled", "the editor left its start screen");
    },
  },
  {
    // the PDF engine cannot be loaded (old browser, blocked WebAssembly): the page says so
    id: "E4-could-not-start", path: "/", expectError: /fetching of the wasm failed/,
    steps: async (p, base) => {
      await p.send("Network.enable");
      await p.send("Network.setBlockedURLs", { urls: ["*mupdf-wasm.wasm*"] });
      await p.goto(`${base}/`);
      await must(p, "document.documentElement.dataset.state === 'failed'", "the editor did not report that it could not start", 30000);
      await check(p, "!document.getElementById('boot-error').hidden && /could not start: its PDF engine did not load/.test(document.getElementById('boot-error').textContent) && document.getElementById('open-big').disabled && document.getElementById('open').disabled", "no start error on the page");
    },
  },
  {
    // a file dragged over the window: the drop area is outlined
    id: "E5-drag-over", path: "/",
    steps: async (p) => {
      await started(p);
      await p.evaluate("(() => { window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true })); return true; })()");
      await check(p, "document.body.classList.contains('dragging')", "no drop outline");
    },
  },

  // ---------- a PDF opened ----------
  { id: "D1-opened", path: "/", steps: opened },
  // a text of the file clicked: its text box is open (keepFocus: the shot keeps the box open)
  { id: "D2-text-box-open", path: "/", keepFocus: true, steps: openTitle },
  // the title changed: the page shows the new text in the same font, the panel shows its style
  { id: "D3-text-changed", path: "/", dark: true, steps: changeTitle },
  {
    // a new text typed with the Text tool, then made bold and bigger from the panel
    id: "D4-text-added", path: "/",
    steps: async (p) => {
      await opened(p);
      await tool(p, "text");
      await clickAt(p, 300, 250);
      await must(p, "document.activeElement?.classList.contains('editor')", "the Text tool did not open a text box");
      await p.send("Input.insertText", { text: "Bon pour accord" });
      await key(p, "Escape");
      await must(p, "document.querySelectorAll('.obj.sel[data-type=text]').length === 1", "the new text is not selected");
      await check(p, "document.querySelector('#tools .on').dataset.tool === 'select'", "the Edit tool is not back after the text was typed");
      const before = await box(p);
      await p.evaluate(`(() => {
        document.getElementById('p-bold').click();
        const size = document.getElementById('p-size'); size.value = '22'; size.dispatchEvent(new Event('change'));
        const colour = document.getElementById('p-color'); colour.value = '#c0362c';
        colour.dispatchEvent(new Event('input')); colour.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await must(p, "document.getElementById('p-bold').classList.contains('on') && document.getElementById('p-size').value === '22'", "the panel did not apply the style");
      const after = await box(p);
      if (!(after[2] > before[2] * 1.4 && after[3] > before[3] * 1.4)) throw new Error(`size 22 did not make the text bigger: ${before} -> ${after}`);
      // right alignment keeps the text where it is; then a font change is applied
      await p.evaluate("(() => { document.querySelector('[data-align=right]').click(); const f = document.getElementById('p-family'); f.value = 'Times'; f.dispatchEvent(new Event('change')); return true; })()");
      await check(p, "document.querySelector('[data-align=right]').classList.contains('on') && document.getElementById('p-family').value === 'Times'", "alignment or font not applied");
      const aligned = await box(p);
      if (!closeTo(aligned[0] + aligned[2], after[0] + after[2], 2)) throw new Error(`right alignment moved the right edge: ${after} -> ${aligned}`);
      await settle(p);
    },
  },
  {
    // shapes: a filled rectangle, an ellipse, an arrow and a freehand stroke; the arrow stays selected
    id: "D5-shapes", path: "/",
    steps: async (p) => {
      await opened(p);
      await tool(p, "rect");
      await dragOn(p, [[330, 190], [400, 215], [470, 240]]);
      await p.evaluate(`(() => {
        const colour = document.getElementById('p-fill'); colour.value = '#f2c14e';
        const on = document.getElementById('p-fill-on'); on.checked = true; on.dispatchEvent(new Event('change'));
        const dash = document.getElementById('p-dash'); dash.checked = true; dash.dispatchEvent(new Event('change'));
        const o = document.getElementById('p-opacity'); o.value = '0.6'; o.dispatchEvent(new Event('input')); o.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await check(p, "document.getElementById('p-fill-on').checked && document.getElementById('p-dash').checked && document.getElementById('p-opacity').value === '0.6'", "fill, dash or opacity not kept by the panel");
      await tool(p, "ellipse");
      await dragOn(p, [[480, 190], [520, 220], [550, 250]]);
      await tool(p, "ink");
      await dragOn(p, [[330, 262], [360, 252], [390, 268], [420, 254], [450, 266]]);
      await tool(p, "arrow");
      await dragOn(p, [[330, 300], [420, 290], [520, 280]]);
      await must(p, "document.querySelectorAll('.obj').length === 4 && document.querySelector('.obj.sel')?.dataset.type === 'arrow'", "the four shapes are not on the page");
      await must(p, "document.querySelectorAll('.obj.sel .handle').length === 2", "the arrow has no end handles");
      // a click that does not drag draws nothing
      await tool(p, "rect");
      await clickAt(p, 100, 600);
      if ((await count(p, ".obj")) !== 4) throw new Error("a click without a drag made a shape");
      await tool(p, "select");
      await settle(p);
    },
  },
  {
    // an image with transparency, placed over the page: the page shows through its left half
    id: "D6-image", path: "/",
    steps: async (p) => {
      await opened(p);
      await give(p, "image-file", IMAGE, "stamp.png", "image/png");
      await must(p, "document.querySelector('.obj.sel')?.dataset.type === 'image' && document.querySelectorAll('.obj.sel .handle').length === 4", "the image is not on the page");
      // resized by a corner: an image keeps its proportions whatever the drag
      const b = await box(p);
      await dragOn(p, [[b[0] + b[2], b[1] + b[3]], [b[0] + b[2] + 30, b[1] + b[3] + 10], [b[0] + b[2] + 60, b[1] + b[3] + 20]]);
      const r = await box(p);
      if (!(r[2] > b[2] + 20 && closeTo(r[2] / r[3], b[2] / b[3], 0.03))) throw new Error(`the image did not grow with its proportions: ${b} -> ${r}`);
      // something that is not an image is refused with a message
      await give(p, "image-file", Buffer.from("not an image").toString("base64"), "x.png", "image/png");
      await must(p, "/could not be read/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden", "no message for an unreadable image");
      if ((await count(p, ".obj")) !== 1) throw new Error("an unreadable image was added");
      await settle(p);
    },
  },
  {
    // the eraser dragged over the date: the text is gone, the area is paper again
    id: "D7-erased", path: "/",
    steps: async (p) => {
      await opened(p);
      await tool(p, "erase");
      await dragOn(p, [[42, 290], [90, 305], [140, 320]]);
      await must(p, "document.querySelector('.obj.sel')?.dataset.type === 'erase'", "the erased area is not on the page");
      await settle(p);
    },
  },
  {
    // the round trip: change the title, download, open the downloaded file again in the editor.
    // The new title is then a text of the file itself, and the old one is nowhere in it.
    id: "D8-saved-reopened", path: "/",
    steps: async (p) => {
      await captureDownloads(p);
      await changeTitle(p);
      await saveAndReopen(p);
      const t = await titles(p);
      if (JSON.stringify(t) !== JSON.stringify(["Devis F-001"])) throw new Error(`the saved file has these titles: ${JSON.stringify(t)}`);
      await settle(p);
    },
  },
  {
    // a text of the file moved and restyled WITHOUT retyping it: click it, leave the text box,
    // then bold and drag. Clicking a text and leaving it changes nothing.
    id: "D9-existing-text-moved", path: "/",
    steps: async (p) => {
      await captureDownloads(p);
      await openTitle(p);
      await key(p, "Escape");
      await must(p, "!document.querySelector('.editor') && document.querySelector('.obj.sel')?.dataset.type === 'text'", "the clicked text is not selected after Esc");
      await check(p, "document.getElementById('undo').disabled && document.getElementById('p-family').value === 'Lato'", "selecting a text is already an edit");
      // deselect: nothing was changed, the text is the file's own again
      await clickAt(p, 500, 100);
      if ((await count(p, ".obj")) !== 0) throw new Error("a text that was only clicked stayed as an object");
      await check(p, "document.getElementById('undo').disabled", "undo is enabled though nothing changed");

      await clickAt(p, 297, 143);
      await key(p, "Escape");
      const a = await box(p);
      await press(p, "p-bold");
      await check(p, "document.getElementById('p-bold').classList.contains('on') && !document.getElementById('undo').disabled", "bold was not applied to the existing text");
      const bold = await box(p);
      if (!(bold[2] > a[2] + 2)) throw new Error(`bold did not widen the title: ${a} -> ${bold}`);
      await dragOn(p, [[297, 143], [320, 160], [357, 193]]);
      const moved = await box(p);
      if (!(closeTo(moved[0] - bold[0], 60, 2) && closeTo(moved[1] - bold[1], 50, 2))) throw new Error(`the title did not move by 60,50: ${bold} -> ${moved}`);
      await settle(p);
      // the saved file has the title at its new place, once, in bold
      await saveAndReopen(p);
      const found = await p.evaluate("(() => { const e = [...document.querySelectorAll('.page[data-index=\"0\"] .piece')].filter((x) => /Facture/.test(x.dataset.text)); const o = e[0]?.parentElement.getBoundingClientRect(); const z = o ? o.width / 595 : 1; return e.map((x) => { const r = x.getBoundingClientRect(); return [x.dataset.text, Math.round((r.left - o.left) / z), Math.round((r.top - o.top) / z)]; }); })()");
      if (found.length !== 1 || found[0][0] !== "Facture brouillon F-001" || !closeTo(found[0][2], moved[1], 8)) throw new Error(`the saved file has the title at: ${JSON.stringify(found)}, expected once near y=${moved[1]}`);
      await clickAt(p, 357, 193);
      await must(p, "document.activeElement?.classList.contains('editor')", "the moved title cannot be clicked in the saved file");
      await check(p, "document.getElementById('p-bold').classList.contains('on') && document.getElementById('p-family').value === 'Lato'", "the saved title is not bold Lato");
      await key(p, "Escape");
      await clickAt(p, 500, 100);
      await settle(p);
    },
  },
  {
    // undo and redo, buttons and keys
    id: "D10-undo-redo", path: "/",
    steps: async (p) => {
      await changeTitle(p);
      await tool(p, "rect");
      await dragOn(p, [[330, 190], [400, 215], [470, 240]]);
      if ((await count(p, ".obj")) !== 2) throw new Error("the title and the rectangle are not both there");
      await press(p, "undo");
      if ((await count(p, ".obj")) !== 1) throw new Error("undo did not remove the rectangle");
      await key(p, "z", { ctrl: true });
      await check(p, "document.querySelectorAll('.obj').length === 0 && document.getElementById('undo').disabled && !document.getElementById('redo').disabled", "Ctrl+Z did not undo the title change");
      await must(p, `${idle}`, "not redrawn");
      if (JSON.stringify(await titles(p)) !== JSON.stringify(["Facture brouillon F-001"])) throw new Error("after undo the title is not the file's own again");
      await key(p, "y", { ctrl: true });
      if ((await count(p, ".obj[data-type=text]")) !== 1) throw new Error("Ctrl+Y did not redo the title change");
      await key(p, "z", { ctrl: true, shift: true });
      await check(p, "document.querySelectorAll('.obj').length === 2 && document.getElementById('redo').disabled", "Ctrl+Shift+Z did not redo the rectangle");
      // a new change after an undo clears redo
      await press(p, "undo");
      await tool(p, "ellipse");
      await dragOn(p, [[480, 190], [520, 220], [550, 250]]);
      await check(p, "document.getElementById('redo').disabled && document.querySelectorAll('.obj').length === 2", "redo survived a new change");
      await settle(p);
    },
  },
  {
    // objects: move, resize, arrow keys, duplicate, copy and paste, order, delete
    id: "D11-objects", path: "/",
    steps: async (p) => {
      await opened(p);
      await tool(p, "rect");
      await dragOn(p, [[330, 190], [370, 205], [410, 230]]);
      const a = await box(p);
      if (!(closeTo(a[0], 330) && closeTo(a[1], 190) && closeTo(a[2], 80) && closeTo(a[3], 40))) throw new Error(`rectangle drawn at ${a}`);
      await dragOn(p, [[370, 210], [390, 230], [420, 260]]);
      const m = await box(p);
      if (!(closeTo(m[0], 380) && closeTo(m[1], 240) && closeTo(m[2], 80))) throw new Error(`rectangle moved to ${m}`);
      await dragOn(p, [[460, 280], [480, 290], [500, 300]]); // its bottom right handle
      const r = await box(p);
      if (!(closeTo(r[0], 380) && closeTo(r[1], 240) && closeTo(r[2], 120) && closeTo(r[3], 60))) throw new Error(`rectangle resized to ${r}`);
      await key(p, "ArrowRight");
      await key(p, "ArrowDown", { shift: true });
      const n = await box(p);
      if (!(closeTo(n[0], 381, 0.6) && closeTo(n[1], 250, 0.6))) throw new Error(`arrow keys moved the rectangle to ${n}`);
      await press(p, "p-dup");
      const d = await box(p);
      if ((await count(p, ".obj")) !== 2 || !closeTo(d[0], n[0] + 12) || !closeTo(d[1], n[1] + 12)) throw new Error(`duplicate at ${d}`);
      await key(p, "c", { ctrl: true });
      await p.evaluate("(() => { window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true })); return true; })()");
      if ((await count(p, ".obj")) !== 3) throw new Error("copy and paste did not add an object");
      await key(p, "d", { ctrl: true });
      if ((await count(p, ".obj")) !== 4) throw new Error("Ctrl+D did not duplicate");
      // order: the selected one (last drawn) goes behind the others, then back in front
      const ids = () => p.evaluate("[...document.querySelectorAll('.obj')].map((e) => e.dataset.id)");
      const sel = await p.evaluate("document.querySelector('.obj.sel').dataset.id");
      await press(p, "p-back");
      if ((await ids())[0] !== sel) throw new Error("To back did not put the object first");
      await press(p, "p-front");
      if ((await ids())[3] !== sel) throw new Error("To front did not put the object last");
      await key(p, "Delete");
      await press(p, "undo");
      await press(p, "redo");
      if ((await count(p, ".obj")) !== 3) throw new Error("Delete, undo, redo: not 3 objects");
      await check(p, "!document.querySelector('.obj.sel')", "something is selected after a delete");
      await settle(p);
    },
  },
  {
    // a text of the file deleted: gone from the saved file
    id: "D12-existing-text-deleted", path: "/",
    steps: async (p) => {
      await captureDownloads(p);
      await openTitle(p);
      await key(p, "Escape");
      await press(p, "p-del");
      await check(p, "!document.getElementById('undo').disabled && !document.querySelector('.obj.sel')", "the delete is not an undoable change");
      await settle(p);
      await saveAndReopen(p);
      const t = await titles(p);
      if (t.length !== 0) throw new Error(`the deleted title is still in the saved file: ${JSON.stringify(t)}`);
      await check(p, "[...document.querySelectorAll('.piece')].some((e) => e.dataset.text.startsWith('CLIENT DEMO'))", "the other texts are not in the saved file");
      await settle(p);
    },
  },
  {
    // page 2, a text in a font the editor does not have: the panel says which font replaces it
    id: "D13-font-note", path: "/",
    steps: async (p) => {
      await opened(p);
      await page2(p);
      await clickAt(p, 60, 266, 1);
      await must(p, "document.activeElement?.classList.contains('editor') && document.activeElement.value === 'Police inconnue'", "the text of page 2 did not open");
      await key(p, "Escape");
      await check(p, "(() => { const n = document.getElementById('font-note'); return !n.hidden && /Quicksand-Medium/.test(n.textContent) && n.textContent.includes(document.getElementById('p-family').value); })()", "no note about the missing font");
      // a text in a standard font (Helvetica) has no such note and keeps its font
      await clickAt(p, 60, 226, 1);
      await must(p, "document.activeElement?.value === 'Signature du client'", "the Helvetica text did not open");
      await key(p, "Escape");
      await check(p, "document.getElementById('font-note').hidden && document.getElementById('p-family').value === 'Helvetica'", "a Helvetica text is not seen as Helvetica");
      // back to the first text: the one that was only selected is the page's own text again
      if ((await count(p, ".obj")) !== 1) throw new Error("a text that was only selected stayed as an object when another was clicked");
      await clickAt(p, 60, 266, 1);
      await must(p, "document.activeElement?.value === 'Police inconnue'", "the first text did not open again");
      await key(p, "Escape");
      await check(p, "!document.getElementById('font-note').hidden && document.querySelectorAll('.obj').length === 1 && document.getElementById('undo').disabled", "the note is not back, or selecting texts counted as edits");
      await settle(p);
    },
  },
  {
    // a font file added by the visitor: it joins the font list and writes the selected text
    id: "D14-font-added", path: "/",
    steps: async (p) => {
      await captureDownloads(p);
      await changeTitle(p);
      const before = await box(p);
      await give(p, "font-file", FONT, "MaPolice.ttf", "font/ttf");
      await must(p, "document.getElementById('p-family').value === 'MaPolice' && [...document.getElementById('p-family').options].length === 5", "the added font is not in the list");
      await must(p, "/Font \"MaPolice\" added/.test(document.getElementById('toast').textContent)", "no message for the added font");
      await must(p, idle, "not redrawn");
      const after = await box(p);
      if (closeTo(after[2], before[2], 0.4)) throw new Error("the title has the same width in the added font: it was not applied");
      await give(p, "font-file", Buffer.from("not a font").toString("base64"), "bad.ttf", "font/ttf");
      await must(p, "/font file could not be read/.test(document.getElementById('toast').textContent)", "no message for an unreadable font");
      await check(p, "[...document.getElementById('p-family').options].length === 5", "an unreadable font joined the list");
      await settle(p);
    },
  },
  {
    // characters no font has (an emoji): written as "?", with a message
    id: "D15-missing-characters", path: "/",
    steps: async (p) => {
      await opened(p);
      await tool(p, "text");
      await clickAt(p, 300, 250);
      await p.send("Input.insertText", { text: "Merci \u{1F600}" });
      await key(p, "Escape");
      await must(p, "!document.getElementById('toast').hidden && /No font here has these characters/.test(document.getElementById('toast').textContent)", "no message about the missing characters");
      await must(p, idle, "not redrawn");
    },
  },
  {
    // zoom: buttons and fit, on page 2
    id: "D16-zoomed-page-2", path: "/",
    steps: async (p) => {
      await opened(p);
      const z0 = await p.evaluate("document.getElementById('zoom-fit').textContent");
      const w0 = await p.evaluate("document.querySelector('.page').getBoundingClientRect().width");
      await press(p, "zoom-in");
      await press(p, "zoom-in");
      const w2 = await p.evaluate("document.querySelector('.page').getBoundingClientRect().width");
      if (!closeTo(w2 / w0, 1.44, 0.02)) throw new Error(`two zoom-in steps: ${w0} -> ${w2}`);
      await press(p, "zoom-out");
      await p.evaluate("(() => { document.getElementById('zoom-fit').click(); return true; })()");
      await check(p, `document.getElementById('zoom-fit').textContent === ${JSON.stringify(z0)}`, "fit did not return to the first zoom");
      await press(p, "zoom-in");
      await page2(p);
      await check(p, "document.querySelector('.thumb.on')?.title === 'Page 2'", "the thumbnail of page 2 is not the current one");
      await settle(p);
    },
  },

  {
    // keys, panel inputs and gestures that change what is saved, each checked on the page's pixels
    id: "D17-keys-and-inputs", path: "/",
    steps: async (p) => {
      await captureDownloads(p);
      await opened(p);
      const on = () => p.evaluate("document.querySelector('#tools .on').dataset.tool");
      for (const [k, name] of [["r", "rect"], ["o", "ellipse"], ["a", "arrow"], ["d", "ink"], ["e", "erase"], ["t", "text"], ["v", "select"], ["l", "line"]]) {
        await key(p, k);
        if ((await on()) !== name) throw new Error(`key ${k} did not pick the ${name} tool`);
      }
      // a line, then its width and colour from the panel
      await dragOn(p, [[330, 200], [390, 200], [450, 200]]);
      await p.evaluate(`(() => {
        const w = document.getElementById('p-stroke-width'); w.value = '8'; w.dispatchEvent(new Event('change'));
        const c = document.getElementById('p-stroke'); c.value = '#ff0000'; c.dispatchEvent(new Event('input')); c.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await must(p, idle, "not redrawn");
      const line = await pixel(p, 390, 202.2);
      if (!(line[0] > 230 && line[1] < 30 && line[2] < 30)) throw new Error(`2.2 pt off the middle of a line 8 wide (2 by default), set to red: rgb(${line})`);
      // the eraser's colour, chosen before erasing
      await key(p, "e");
      await p.evaluate("(() => { const c = document.getElementById('p-fill'); c.value = '#00c000'; c.dispatchEvent(new Event('input')); c.dispatchEvent(new Event('change')); return true; })()");
      await dragOn(p, [[330, 230], [360, 245], [400, 260]]);
      await must(p, idle, "not redrawn");
      const erased = await pixel(p, 365, 245);
      if (!(erased[0] < 30 && erased[1] > 170 && erased[2] < 30)) throw new Error(`erased area in the chosen colour: rgb(${erased})`);
      // a rectangle resized with Shift: its proportions are kept
      await key(p, "r");
      await dragOn(p, [[430, 230], [470, 240], [510, 270]]);
      const r0 = await box(p);
      await dragOn(p, [[510, 270], [520, 272], [540, 275]], 0, 8);
      const r1 = await box(p);
      if (!(r1[2] > r0[2] + 10 && closeTo(r1[2] / r1[3], r0[2] / r0[3], 0.05))) throw new Error(`Shift-resize did not keep the proportions: ${r0} -> ${r1}`);
      // a text: its corner handle scales it; Ctrl+B, Ctrl+I, Ctrl+U; Enter opens it again
      await key(p, "t");
      await clickAt(p, 330, 300);
      await p.send("Input.insertText", { text: "Abc" });
      await key(p, "Escape");
      const t0 = await box(p);
      await dragOn(p, [[t0[0] + t0[2], t0[1] + t0[3]], [t0[0] + t0[2] + 5, t0[1] + t0[3] + 8], [t0[0] + t0[2] + 10, t0[1] + t0[3] + 17]]);
      const size = Number(await p.evaluate("document.getElementById('p-size').value"));
      const t1 = await box(p);
      if (!(size >= 26 && size <= 30 && closeTo(t1[1], t0[1], 1.5))) throw new Error(`the corner handle of a 14 pt text dragged 17 pt down: size ${size}, box ${t0} -> ${t1}`);
      for (const k of ["b", "i", "u"]) await key(p, k, { ctrl: true });
      await check(p, "['p-bold', 'p-italic', 'p-underline'].every((id) => document.getElementById(id).classList.contains('on'))", "Ctrl+B, Ctrl+I, Ctrl+U");
      await key(p, "Enter");
      await must(p, "document.activeElement?.classList.contains('editor') && document.activeElement.value === 'Abc'", "Enter did not open the selected text");
      await key(p, "Escape");
      // a text that was typed can be typed in again: a click on it while it is selected opens its
      // text box, and so does a double click on it when it is not selected
      const t2 = await box(p);
      const mid = [t2[0] + t2[2] / 2, t2[1] + t2[3] / 2];
      await clickAt(p, ...mid);
      await must(p, "document.activeElement?.classList.contains('editor') && document.activeElement.value === 'Abc'", "a click on the selected text did not open its text box");
      await key(p, "Escape");
      await key(p, "Escape");
      await check(p, "!document.querySelector('.obj.sel')", "Escape did not unselect the text");
      // (two clicks, each aimed anew: on a phone the panel that opens at the first one moves the page)
      await clickAt(p, ...mid);
      await clickAt(p, ...mid);
      await must(p, "document.activeElement?.classList.contains('editor') && document.activeElement.value === 'Abc'", "a double click on a text did not open its text box");
      await key(p, "Escape");
      await check(p, "document.querySelectorAll('.obj.sel[data-type=text]').length === 1", "the text is not selected after its text box closed");
      // an image dropped on the page lands where it is dropped
      const [dx, dy] = await at(p, 480, 330);
      await p.evaluate(`(() => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(IMAGE)}), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "stamp.png", { type: "image/png" }));
        document.querySelector('.page[data-index="0"] .overlay').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${dx}, clientY: ${dy} }));
        return true;
      })()`);
      await must(p, "document.querySelector('.obj.sel')?.dataset.type === 'image'", "the dropped image is not on the page");
      const im = await box(p);
      if (!(closeTo(im[0] + im[2] / 2, 480, 2) && closeTo(im[1] + im[3] / 2, 330, 2))) throw new Error(`the image was dropped at 480,330 and is at ${im}`);
      // Ctrl+S downloads
      await key(p, "s", { ctrl: true });
      await must(p, "!!window.__saved && Number(document.documentElement.dataset.saved) > 10000", "Ctrl+S wrote nothing");
      if ((await count(p, ".obj")) !== 5) throw new Error("not five objects at the end");
      await settle(p);
    },
  },

  // ---------- the panel of a tool before anything is drawn ----------
  { id: "T1-text-tool", path: "/", steps: async (p) => { await opened(p); await tool(p, "text"); await check(p, "document.getElementById('props-title').textContent === 'Text' && document.getElementById('p-family').value === 'Helvetica' && document.querySelector('[data-for=object]').hidden", "the Text tool panel is wrong"); } },
  { id: "T2-shape-tool", path: "/", steps: async (p) => { await opened(p); await tool(p, "rect"); await check(p, "document.getElementById('props-title').textContent === 'Rectangle' && !document.querySelector('[data-for=stroke]').hidden && !document.querySelector('[data-for=fill]').hidden && document.querySelector('[data-for=text]').hidden", "the Rectangle tool panel is wrong"); } },
  { id: "T3-erase-tool", path: "/", steps: async (p) => { await opened(p); await tool(p, "erase"); await check(p, "document.getElementById('props-title').textContent === 'Eraser' && !document.querySelector('[data-for=fill]').hidden && document.querySelector('[data-for=stroke]').hidden && document.querySelector('[data-for=opacity]').hidden", "the Eraser tool panel is wrong"); } },
];
