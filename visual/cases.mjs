// Visual use cases of pdf (hosh-management AGENTS.md section 3), listed in TESTING.md "Visual use cases".
// Every case is shot at the 3 widths, each in a fresh browser context (a first-time visitor).
// Nothing is ever sent to the server: the fixture PDF (visual/fixture.pdf, built by test/fixture.mjs)
// is given to the page's own file input, exactly like "Open PDF" does, and the page is driven with
// real mouse and keyboard events. Each case also checks what it did before the shot is taken.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { png } from "../test/fixture.mjs";

export const WIDTHS = [1400, 1024, 390];

const FIXTURE = readFileSync(new URL("./fixture.pdf", import.meta.url)).toString("base64");
const IMAGE = Buffer.from(png({ width: 64, height: 64, rgb: [214, 69, 65] })).toString("base64");

const idle = "document.documentElement.dataset.state === 'ready' && !document.documentElement.dataset.busy";

async function must(p, expression, what, ms = 15000) {
  if (!(await p.waitFor(expression, ms))) throw new Error(what);
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

/** Window coordinates of a point of page 1 given in PDF points. */
async function at(p, x, y) {
  return p.evaluate(`(() => {
    const r = document.querySelector('.page[data-index="0"] .overlay').getBoundingClientRect();
    const z = r.width / 595;
    return [r.left + ${x} * z, r.top + ${y} * z];
  })()`);
}

const mouse = (p, type, [x, y], buttons) => p.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1, pointerType: "mouse" });

async function clickAt(p, x, y) {
  const c = await at(p, x, y);
  await mouse(p, "mouseMoved", c, 0);
  await mouse(p, "mousePressed", c, 1);
  await mouse(p, "mouseReleased", c, 0);
  await sleep(100);
}

async function dragOn(p, points) {
  const cs = [];
  for (const [x, y] of points) cs.push(await at(p, x, y));
  await mouse(p, "mouseMoved", cs[0], 0);
  await mouse(p, "mousePressed", cs[0], 1);
  for (const c of cs.slice(1)) {
    await mouse(p, "mouseMoved", c, 1);
    await sleep(30);
  }
  await mouse(p, "mouseReleased", cs[cs.length - 1], 0);
  await sleep(100);
}

async function tool(p, name) {
  await p.evaluate(`(() => { document.querySelector('#tools [data-tool="${name}"]').click(); return true; })()`);
  await sleep(50);
}

async function key(p, k, code) {
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
  await sleep(50);
}

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
  await key(p, "Escape", 27);
  await must(p, "!document.querySelector('.editor') && document.querySelectorAll('.obj[data-type=text]').length === 1", "the edit was not committed");
  await must(p, "!document.getElementById('undo').disabled && document.getElementById('p-family').value === 'Lato'", "the edited text is not selected with its font");
  await settle(p);
}

export const CASES = [
  // a first visit
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
  // a PDF opened: its texts are boxed, ready to be clicked
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
      await key(p, "Escape", 27);
      await must(p, "document.querySelectorAll('.obj.sel[data-type=text]').length === 1", "the new text is not selected");
      await p.evaluate(`(() => {
        document.getElementById('p-bold').click();
        const size = document.getElementById('p-size'); size.value = '22'; size.dispatchEvent(new Event('change'));
        const colour = document.getElementById('p-color'); colour.value = '#c0362c';
        colour.dispatchEvent(new Event('input')); colour.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await must(p, "document.getElementById('p-bold').classList.contains('on') && document.getElementById('p-size').value === '22'", "the panel did not apply the style");
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
      await p.evaluate("(() => { const c = document.getElementById('p-fill-on'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()");
      await tool(p, "ellipse");
      await dragOn(p, [[480, 190], [520, 220], [550, 250]]);
      await tool(p, "ink");
      await dragOn(p, [[330, 262], [360, 252], [390, 268], [420, 254], [450, 266]]);
      await tool(p, "arrow");
      await dragOn(p, [[330, 300], [420, 290], [520, 280]]);
      await must(p, "document.querySelectorAll('.obj').length === 4 && document.querySelector('.obj.sel')?.dataset.type === 'arrow'", "the four shapes are not on the page");
      await must(p, "document.querySelectorAll('.obj.sel .handle').length === 2", "the arrow has no end handles");
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
      await p.evaluate(`(() => {
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { window.__saved = blob; return make(blob); };
        // the browser's download itself is not what is tested: the bytes are
        HTMLAnchorElement.prototype.click = function () {};
        return true;
      })()`);
      await changeTitle(p);
      await p.evaluate("(() => { document.getElementById('save').click(); return true; })()");
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
      await must(p, `${idle} && document.getElementById('filename').textContent === 'fixture-edited.pdf' && document.querySelectorAll('.piece').length >= 10`, "the saved file did not open");
      const titles = await p.evaluate("[...document.querySelectorAll('.piece')].map((e) => e.dataset.text).filter((t) => /Devis|Facture|brouillon/.test(t))");
      if (JSON.stringify(titles) !== JSON.stringify(["Devis F-001"])) throw new Error(`the saved file has these titles: ${JSON.stringify(titles)}`);
      if ((await p.evaluate("document.querySelectorAll('.obj').length")) !== 0) throw new Error("the reopened file has pending edits");
      await settle(p);
    },
  },
];
