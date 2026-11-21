// The edit engine (web/js/engine.js) against real PDFs, through MuPDF: the same code the browser runs.
// Every test reads the result back from the written file (text extraction, pixels), never from the
// objects that were passed in.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as mupdf from "mupdf";

import { readFileSync } from "node:fs";

import { adoptPiece, isPristine, matchFont, stripSubsetTag } from "../web/js/engine.js";
import { BLUE, PASSWORD, TITLE, UNKNOWN_FONT, UNKNOWN_TEXT, buildFixture, buildProtected, engineWithFonts, png } from "./fixture.mjs";

const engine = engineWithFonts(mupdf);
const fixture = buildFixture(mupdf, engine);

const texts = (bytes, page = 0) => {
  const doc = engine.open(bytes);
  const out = engine.extractText(doc, page);
  doc.destroy();
  return out;
};
const allText = (bytes, page = 0) => texts(bytes, page).map((p) => p.text).join("\n");

/** RGB of the pixel at page point (x, y) of a rendered page. */
function pixelAt(bytes, page, x, y, scale = 2) {
  const doc = engine.open(bytes);
  const r = engine.render(doc, page, scale);
  doc.destroy();
  const i = (Math.round(y * scale) * r.width + Math.round(x * scale)) * 4;
  return [r.pixels[i], r.pixels[i + 1], r.pixels[i + 2]];
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const assertPixel = (actual, expected, what, tol) => assert.ok(near(actual, expected, tol), `${what}: got rgb(${actual}), expected rgb(${expected})`);

const one = (objects, page = 0, images = new Map()) => {
  const pages = [[], []];
  pages[page] = objects;
  return engine.exportPdf(fixture, pages, images);
};

test("font matching: subset tag, shipped family, closest standard font", () => {
  assert.equal(stripSubsetTag("ABCDEF+Lato-Bold"), "Lato-Bold");
  assert.equal(stripSubsetTag("Lato-Bold"), "Lato-Bold");
  assert.deepEqual(matchFont("ABCDEF+Lato-BoldItalic"), { family: "Lato", bold: true, italic: true, exact: true });
  assert.deepEqual(matchFont("Lato-Regular"), { family: "Lato", bold: false, italic: false, exact: true });
  assert.deepEqual(matchFont("XYZABC+ArialMT"), { family: "Helvetica", bold: false, italic: false, exact: true });
  assert.deepEqual(matchFont("TimesNewRomanPS-BoldMT"), { family: "Times", bold: true, italic: false, exact: true });
  assert.deepEqual(matchFont("CourierNewPSMT"), { family: "Courier", bold: false, italic: false, exact: true });
  // an unknown font: the flags of the file decide, and the editor says the look is not exact
  assert.deepEqual(matchFont("Garamond-Premier", { serif: true }), { family: "Times", bold: false, italic: false, exact: false });
  assert.deepEqual(matchFont("Montserrat-SemiBold"), { family: "Helvetica", bold: true, italic: false, exact: false });
  assert.deepEqual(matchFont("SomeMono", { mono: true, italic: true }), { family: "Courier", bold: false, italic: true, exact: false });
  // the name wins over the flags: MuPDF says "serif" for every font it embedded itself
  assert.deepEqual(matchFont("Helvetica", { serif: true }), { family: "Helvetica", bold: false, italic: false, exact: true });
  assert.deepEqual(matchFont("ABCDEF+Helvetica-BoldOblique", { serif: true, mono: true }), { family: "Helvetica", bold: true, italic: true, exact: true });
  assert.deepEqual(matchFont("NimbusSans-Regular", { serif: true }), { family: "Helvetica", bold: false, italic: false, exact: true });
  assert.deepEqual(matchFont("Courier", { serif: true }), { family: "Courier", bold: false, italic: false, exact: true });
  assert.deepEqual(matchFont("OpenSans-Regular", { serif: true }), { family: "Helvetica", bold: false, italic: false, exact: false });
  assert.deepEqual(matchFont("Lato-Regular", { serif: true, mono: true }), { family: "Lato", bold: false, italic: false, exact: true });
});

test("the text of a page comes back as editable pieces with their style", () => {
  const pieces = texts(fixture);
  const title = pieces.find((p) => p.text === TITLE);
  assert.ok(title, `the title is one piece; got: ${pieces.map((p) => JSON.stringify(p.text)).join(", ")}`);
  assert.equal(title.family, "Lato");
  assert.equal(title.exactFont, true);
  assert.equal(title.bold, false);
  assert.ok(Math.abs(title.size - 20) < 0.01, `size ${title.size}`);
  assert.ok(near(title.color.map((v) => v * 255), BLUE.map((v) => v * 255), 2), `colour ${title.color}`);
  // centred on the page: it keeps its centre as anchor
  assert.equal(title.align, "center");
  assert.ok(Math.abs(title.x - 297.5) < 1, `centre ${title.x}`);
  assert.ok(Math.abs(title.y - 150) < 0.5, `baseline ${title.y}`);

  // a paragraph is one piece, its lines kept, with the line spacing of the file
  const para = pieces.find((p) => p.text.startsWith("Inclus :"));
  assert.equal(para.text, "Inclus :\n- Conception de l'architecture du programme\n- Adaptation des projections aux sculptures\n- Tests de stabilité et documentation");
  assert.ok(Math.abs(para.lineHeight - 1.25) < 0.02, `line height ${para.lineHeight}`);
  assert.equal(para.rects.length, 4);
  assert.equal(para.align, "left");

  // bold is seen, and a different style on the next row is not merged into it
  const label = pieces.find((p) => p.text === "Date de facturation");
  assert.equal(label.bold, true);
  assert.ok(pieces.some((p) => p.text === "23/11/2026" && !p.bold));

  // page 2: standard fonts
  const p2 = texts(fixture, 1);
  assert.equal(p2.find((p) => p.text === "Conditions").family, "Times");
  assert.equal(p2.find((p) => p.text === "Référence F-001").family, "Courier");
});

test("changing a text: the old glyphs are gone from the file, the new ones are there, in the same font and place", () => {
  const title = texts(fixture).find((p) => p.text === TITLE);
  const obj = adoptPiece(title, "t1");
  obj.text = "Devis F-001";
  const { data, missing } = one([obj]);
  assert.deepEqual(missing, []);

  const after = texts(data);
  const all = after.map((p) => p.text).join("\n");
  assert.ok(!/brouillon|Facture/.test(all), "the replaced words are still in the file");
  const now = after.find((p) => p.text === "Devis F-001");
  assert.ok(now, `new title not found in: ${all}`);
  assert.equal(now.family, "Lato");
  assert.match(now.fontName, /Lato/);
  assert.ok(Math.abs(now.size - title.size) < 0.01);
  assert.ok(near(now.color.map((v) => v * 255), BLUE.map((v) => v * 255), 2));
  assert.ok(Math.abs(now.y - title.y) < 0.1, "same baseline");
  // still centred on the page although the text is shorter
  assert.ok(Math.abs((now.bbox[0] + now.bbox[2]) / 2 - 297.5) < 1.5, `centre ${(now.bbox[0] + now.bbox[2]) / 2}`);

  // every other text of both pages is exactly as before
  const rest = (list) => list.filter((p) => p.text !== TITLE && p.text !== "Devis F-001").map((p) => `${p.text}@${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  assert.deepEqual(rest(after), rest(texts(fixture)));
  assert.equal(allText(data, 1), allText(fixture, 1));

  // where "brouillon" ended there is paper again (the new title is shorter)
  assertPixel(pixelAt(data, 0, title.bbox[2] - 6, title.y - 5), [255, 255, 255], "right end of the old title");
});

test("changing one line leaves the lines right above and below it", () => {
  const pieces = texts(fixture);
  const date = pieces.find((p) => p.text === "23/11/2026");
  const obj = adoptPiece(date, "t1");
  obj.text = "01/12/2026";
  const all = allText(one([obj]).data);
  assert.ok(all.includes("01/12/2026") && !all.includes("23/11/2026"));
  assert.ok(all.includes("Date de facturation"), "the label above was removed with it");
  assert.ok(all.includes("Description"), "the row below was removed with it");
});

test("a paragraph is rewritten with its lines and spacing; emptied text is deleted from the file", () => {
  const para = texts(fixture).find((p) => p.text.startsWith("Inclus :"));
  const obj = adoptPiece(para, "t1");
  obj.text = "Inclus :\n- Une seule ligne";
  const after = texts(one([obj]).data);
  const now = after.find((p) => p.text.startsWith("Inclus :"));
  assert.equal(now.text, "Inclus :\n- Une seule ligne");
  assert.ok(Math.abs(now.lineHeight - para.lineHeight) < 0.02);
  assert.ok(!after.some((p) => /Adaptation|stabilité/.test(p.text)), "old lines remain");

  const gone = adoptPiece(para, "t2");
  gone.text = "";
  const all = allText(one([gone]).data);
  assert.ok(!/Inclus|Conception de/.test(all));
  assert.ok(all.includes("Étude, conception et prototypage"));
});

test("new text: font, size, colour, bold and italic, alignment, underline", () => {
  const add = { id: "n1", type: "text", text: "Bon pour accord", x: 300, y: 600, size: 18, family: "Times", bold: true, italic: true, color: [0.8, 0, 0], align: "right", lineHeight: 1.2, underline: true };
  const { data } = one([add]);
  const p = texts(data).find((t) => t.text === "Bon pour accord");
  assert.ok(p, "the added text is not in the file");
  assert.equal(p.family, "Times");
  assert.equal(p.bold, true);
  assert.equal(p.italic, true);
  assert.ok(Math.abs(p.size - 18) < 0.01);
  assert.ok(near(p.color.map((v) => v * 255), [204, 0, 0], 2));
  // right aligned: the text ends at x
  assert.ok(Math.abs(p.bbox[2] - 300) < 2, `right edge ${p.bbox[2]}`);
  const width = engine.measure("Bon pour accord", "Times", true, true) * 18;
  assert.ok(Math.abs(p.bbox[2] - p.bbox[0] - width) < 3, "measure() and the written text disagree");
  // the underline: red ink just under the baseline, in the middle of the text
  assertPixel(pixelAt(data, 0, 300 - width / 2, 600 + 18 * 0.12 + 0.4), [204, 0, 0], "underline");
  assertPixel(pixelAt(data, 0, 300 - width / 2, 600 + 18 * 0.12 + 3), [255, 255, 255], "under the underline");
});

test("a character the font lacks is written with Helvetica; one nobody has is reported", () => {
  // Lato has no "∀", Helvetica has; nobody has the emoji
  const add = { id: "n1", type: "text", text: "A ∀ ok \u{1F600}", x: 60, y: 620, size: 14, family: "Lato", bold: false, italic: false, color: [0, 0, 0] };
  assert.equal(engine.getFont("Lato", false, false).encodeCharacter("∀"), 0, "Lato now has this character: pick another one for the test");
  assert.deepEqual(engine.missingGlyphs(add), ["\u{1F600}"]);
  const { data, missing } = one([add]);
  assert.deepEqual(missing, ["\u{1F600}"]);
  const written = texts(data).filter((p) => Math.abs(p.y - 620) < 0.5);
  assert.match(written.map((p) => p.text).join(""), /A ?∀ ?ok \?/);
  assert.equal(written.find((p) => p.text.includes("∀")).family, "Helvetica", "the character was not written with the fallback font");
  assert.equal(written.find((p) => p.text.includes("ok")).family, "Lato");
});

test("shapes are drawn where and how they were asked", () => {
  const { data } = one([
    { id: "r", type: "rect", x: 100, y: 560, w: 80, h: 40, fill: [1, 0, 0], stroke: [0, 0, 1], strokeWidth: 4 },
    { id: "e", type: "ellipse", x: 220, y: 560, w: 80, h: 40, fill: [0, 0.6, 0], stroke: null },
    { id: "l", type: "line", x1: 330, y1: 580, x2: 400, y2: 580, stroke: [0, 0, 0], strokeWidth: 6 },
    { id: "a", type: "arrow", x1: 420, y1: 600, x2: 500, y2: 600, stroke: [0.5, 0, 0.5], strokeWidth: 3 },
    { id: "i", type: "ink", strokes: [[[100, 640], [140, 640], [180, 640]]], stroke: [1, 0.5, 0], strokeWidth: 5 },
    { id: "o", type: "rect", x: 100, y: 680, w: 60, h: 30, fill: [0, 0, 0], stroke: null, opacity: 0.5 },
    // dashed: 3 widths on, 2 widths off, so with width 4 from x=200: ink 200..212, gap 212..220
    { id: "d", type: "line", x1: 200, y1: 690, x2: 300, y2: 690, stroke: [0, 0, 0], strokeWidth: 4, dash: true },
    // a 100 x 20 bar turned a quarter turn about its centre (350,730): it now stands 20 wide, 100 high
    { id: "t", type: "rect", x: 300, y: 720, w: 100, h: 20, fill: [0, 0, 1], stroke: null, rotation: 90 },
    { id: "s", type: "text", text: "XXXXXXXX", x: 430, y: 700, size: 20, family: "Helvetica", bold: true, italic: false, color: [0, 0.4, 0], strike: true },
  ]);
  assertPixel(pixelAt(data, 0, 206, 690), [0, 0, 0], "dash");
  assertPixel(pixelAt(data, 0, 216, 690), [255, 255, 255], "gap between two dashes");
  assertPixel(pixelAt(data, 0, 350, 690), [0, 0, 255], "top of the turned bar");
  assertPixel(pixelAt(data, 0, 350, 770), [0, 0, 255], "bottom of the turned bar");
  assertPixel(pixelAt(data, 0, 310, 730), [255, 255, 255], "where the bar was before it was turned");
  // strikethrough: a rule 0.3 size above the baseline; between two X at mid height there is no glyph ink
  const xw = engine.measure("X", "Helvetica", true, false) * 20;
  assertPixel(pixelAt(data, 0, 430 + xw, 700 - 20 * 0.3 + 0.6), [0, 102, 0], "strikethrough");
  assertPixel(pixelAt(data, 0, 140, 580), [255, 0, 0], "rectangle fill");
  assertPixel(pixelAt(data, 0, 100, 580), [0, 0, 255], "rectangle border");
  assertPixel(pixelAt(data, 0, 260, 580), [0, 153, 0], "ellipse fill");
  assertPixel(pixelAt(data, 0, 223, 563), [255, 255, 255], "outside the ellipse, inside its box");
  assertPixel(pixelAt(data, 0, 365, 580), [0, 0, 0], "line");
  assertPixel(pixelAt(data, 0, 365, 588), [255, 255, 255], "beside the line");
  assertPixel(pixelAt(data, 0, 450, 600), [128, 0, 128], "arrow shaft");
  // the head is a triangle 12 long behind the tip (500,600): this point is in it and 3.5 off the shaft
  assertPixel(pixelAt(data, 0, 492, 603.5), [128, 0, 128], "arrow head");
  assertPixel(pixelAt(data, 0, 480, 603.5), [255, 255, 255], "beside the arrow shaft, behind the head");
  assertPixel(pixelAt(data, 0, 160, 640), [255, 128, 0], "drawing");
  assertPixel(pixelAt(data, 0, 130, 695), [128, 128, 128], "half transparent black on white", 10);
});

test("an image keeps its transparency and its place", () => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  pix.clear(0);
  const images = new Map([["img1", png({ rgb: [214, 69, 65], bottom: [20, 160, 90] })], ["jpg", pix.asJPEG(90)]]);
  assert.deepEqual(engine.imageSize(images.get("img1")), { width: 32, height: 32 });
  const { data } = one([
    { id: "b", type: "rect", x: 90, y: 590, w: 120, h: 120, fill: [0, 0, 1], stroke: null },
    { id: "i", type: "image", imageId: "img1", x: 100, y: 600, w: 100, h: 100, opacity: 1 },
    { id: "j", type: "image", imageId: "jpg", x: 300, y: 600, w: 40, h: 40, opacity: 1 },
    { id: "k", type: "image", imageId: "not-loaded", x: 400, y: 600, w: 40, h: 40, opacity: 1 },
  ], 0, images);
  // the upper half of the picture is red, the lower half green: upside down would swap them
  assertPixel(pixelAt(data, 0, 175, 625), [214, 69, 65], "upper half of the image");
  assertPixel(pixelAt(data, 0, 175, 675), [20, 160, 90], "lower half of the image");
  assertPixel(pixelAt(data, 0, 125, 675), [0, 0, 255], "transparent lower left");
  assertPixel(pixelAt(data, 0, 320, 620), [0, 0, 0], "JPEG", 12);
  assertPixel(pixelAt(data, 0, 420, 620), [255, 255, 255], "an image whose file is not loaded draws nothing");
  // left half of the PNG is transparent: the blue rectangle shows through; the right half is the image
  assertPixel(pixelAt(data, 0, 125, 650), [0, 0, 255], "transparent half");
  assertPixel(pixelAt(data, 0, 175, 603), [214, 69, 65], "top edge of the image");
  assertPixel(pixelAt(data, 0, 175, 697), [20, 160, 90], "bottom edge of the image");
  assertPixel(pixelAt(data, 0, 205, 650), [0, 0, 255], "right of the image");
});

test("the eraser removes the text under it from the file and covers the area", () => {
  const label = texts(fixture).find((p) => p.text === "Total");
  const [x0, y0, x1, y1] = label.bbox;
  const { data } = one([
    { id: "b", type: "rect", x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40, fill: [0, 0, 1], stroke: null },
    { id: "e", type: "erase", x: x0 - 2, y: y0 - 2, w: x1 - x0 + 4, h: y1 - y0 + 4, fill: [1, 1, 0] },
  ]);
  const all = allText(data);
  assert.ok(!/^Total$/m.test(all), "the erased word can still be extracted");
  assert.ok(all.includes("8 000,00 €"), "the amount next to it was erased too");
  // the area is covered with the eraser's colour, over the blue shape that was drawn before it
  assertPixel(pixelAt(data, 0, (x0 + x1) / 2, (y0 + y1) / 2), [255, 255, 0], "erased area");
  assertPixel(pixelAt(data, 0, x0 - 10, (y0 + y1) / 2), [0, 0, 255], "left of the erased area");
  // a white eraser by default
  const plain = one([{ id: "b", type: "rect", x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40, fill: [0, 0, 1], stroke: null }, { id: "e", type: "erase", x: x0, y: y0, w: x1 - x0, h: y1 - y0 }]).data;
  assertPixel(pixelAt(plain, 0, (x0 + x1) / 2, (y0 + y1) / 2), [255, 255, 255], "default eraser colour");
});

test("the opened file is never modified, and the preview is the saved page", () => {
  const before = Buffer.from(fixture).toString("base64");
  const title = texts(fixture).find((p) => p.text === TITLE);
  const obj = adoptPiece(title, "t1");
  obj.text = "Devis F-001";
  const objects = [obj, { id: "r", type: "rect", x: 100, y: 560, w: 80, h: 40, fill: [1, 0, 0], stroke: null }];
  const { data } = one(objects);
  const again = one(objects).data;
  assert.equal(Buffer.from(fixture).toString("base64"), before, "exportPdf changed the bytes it was given");
  assert.equal(allText(again), allText(data));

  const shown = engine.preview(fixture, 0, objects, new Map(), 1);
  const doc = engine.open(data);
  const saved = engine.render(doc, 0, 1);
  doc.destroy();
  assert.equal(shown.width, saved.width);
  assert.equal(shown.height, saved.height);
  let differ = 0;
  for (let i = 0; i < shown.pixels.length; i += 4) {
    if (Math.abs(shown.pixels[i] - saved.pixels[i]) > 8 || Math.abs(shown.pixels[i + 1] - saved.pixels[i + 1]) > 8 || Math.abs(shown.pixels[i + 2] - saved.pixels[i + 2]) > 8) differ += 1;
  }
  assert.ok(differ < shown.width * shown.height * 0.0005, `${differ} pixels differ between the preview and the saved file`);
});

test("the saved file embeds only the glyphs it uses (a whole font is 650 kB)", () => {
  const title = texts(fixture).find((p) => p.text === TITLE);
  const obj = adoptPiece(title, "t1");
  obj.text = "Devis F-001";
  const { data } = one([obj, { id: "n", type: "text", text: "Bon pour accord", x: 60, y: 620, size: 14, family: "Lato", bold: true, italic: false, color: [0, 0, 0] }]);
  assert.ok(data.length < fixture.length + 60_000, `the file grew from ${fixture.length} to ${data.length} bytes`);
  assert.ok(allText(data).includes("Bon pour accord"));
});

test("a rotated page and a page that leaves its graphics state dirty: objects still land where asked", () => {
  const doc = new mupdf.PDFDocument();
  // page 1: rotated a quarter turn. page 2: its content scales everything by 3 and never restores.
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 90, {}, ""));
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, "3 0 0 3 50 50 cm 0 1 0 rg 0 0 10 10 re f"));
  const buf = doc.saveToBuffer("");
  const src = new Uint8Array(buf.asUint8Array());
  doc.destroy();

  const sizes = (() => {
    const d = engine.open(src);
    const s = engine.pageSizes(d);
    d.destroy();
    return s;
  })();
  assert.deepEqual(sizes[0], { width: 842, height: 595 }, "a rotated page is as wide as it is shown");

  const add = (x, y) => [
    { id: "t", type: "text", text: "Repère", x, y, size: 12, family: "Helvetica", bold: false, italic: false, color: [0, 0, 0] },
    { id: "r", type: "rect", x: x + 100, y: y - 10, w: 20, h: 20, fill: [1, 0, 0], stroke: null },
  ];
  const { data } = engine.exportPdf(src, [add(700, 100), add(300, 400)], new Map());
  for (const [page, x, y] of [[0, 700, 100], [1, 300, 400]]) {
    const p = texts(data, page).find((t) => t.text === "Repère");
    assert.ok(p, `page ${page + 1}: the text is missing`);
    assert.ok(Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5, `page ${page + 1}: text at ${p.x},${p.y}, asked ${x},${y}`);
    assert.ok(Math.abs(p.size - 12) < 0.01, `page ${page + 1}: size ${p.size}`);
    assertPixel(pixelAt(data, page, x + 110, y), [255, 0, 0], `page ${page + 1}: rectangle`);
    assertPixel(pixelAt(data, page, x + 125, y), [255, 255, 255], `page ${page + 1}: right of the rectangle`);
  }
});

test("boxes of objects (what the editor draws around them)", () => {
  const t = { type: "text", text: "ab\ncd", x: 100, y: 200, size: 10, family: "Helvetica", bold: false, italic: false, lineHeight: 1.5, align: "left" };
  const [x0, y0, x1, y1] = engine.bounds(t);
  assert.equal(x0, 100);
  assert.ok(y0 < 200 - 8 && y0 > 200 - 11, `top ${y0}`);
  assert.ok(y1 > 215 && y1 < 220, `bottom ${y1}: two lines, 15 apart`);
  assert.ok(x1 - x0 > 8 && x1 - x0 < 14, `width ${x1 - x0}`);
  const c = engine.bounds({ ...t, align: "center" });
  assert.ok(Math.abs((c[0] + c[2]) / 2 - 100) < 0.01);
  assert.deepEqual(engine.bounds({ type: "line", x1: 30, y1: 40, x2: 10, y2: 20 }), [10, 20, 30, 40]);
  assert.deepEqual(engine.bounds({ type: "rect", x: 1, y: 2, w: 3, h: 4 }), [1, 2, 4, 6]);
  assert.deepEqual(engine.bounds({ type: "ink", strokes: [[[5, 5], [9, 7]], [[1, 8]]] }), [1, 5, 9, 8]);
});

test("a file that is not a PDF is refused", () => {
  assert.throws(() => engine.open(new TextEncoder().encode("hello, this is not a pdf")));
});
