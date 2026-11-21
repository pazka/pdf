// What an edit must NOT touch: the drawings and pictures of the file around the text that changes.
// And a few behaviours of objects that are easy to lose without noticing (stroke opacity, width 0,
// the eraser's edge, text that is not horizontal). Results are read back from the written file.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as mupdf from "mupdf";

import { adoptPiece } from "../web/js/engine.js";
import { BLUE, buildFixture, engineWithFonts, png } from "./fixture.mjs";

const engine = engineWithFonts(mupdf);
const fixture = buildFixture(mupdf, engine);

const texts = (bytes, page = 0) => {
  const doc = engine.open(bytes);
  const out = engine.extractText(doc, page);
  doc.destroy();
  return out;
};
function pixelAt(bytes, page, x, y, scale = 2) {
  const doc = engine.open(bytes);
  const r = engine.render(doc, page, scale);
  doc.destroy();
  const i = (Math.round(y * scale) * r.width + Math.round(x * scale)) * 4;
  return [r.pixels[i], r.pixels[i + 1], r.pixels[i + 2]];
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const assertPixel = (actual, expected, what, tol) => assert.ok(near(actual, expected, tol), `${what}: got rgb(${actual}), expected rgb(${expected})`);
const blue = BLUE.map((v) => Math.round(v * 255));
const bytesOf = (doc) => {
  const buf = doc.saveToBuffer("");
  const out = new Uint8Array(buf.asUint8Array());
  buf.destroy();
  return out;
};
const blank = () => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ""));
  const out = bytesOf(doc);
  doc.destroy();
  return out;
};
const T = (o) => ({ id: "t", type: "text", size: 12, family: "Helvetica", bold: false, italic: false, color: [0, 0, 0], ...o });

test("changing a text leaves the drawings of the file under and around it", () => {
  // the fixture: "Description" is written on the blue header band (40..555 x 340..362), and the
  // table under it has a thin grey border (40..555 x 362..482)
  const before = texts(fixture);
  const label = before.find((p) => p.text === "Description");
  assertPixel(pixelAt(fixture, 0, 300, 351), blue, "the band, before");
  const o = adoptPiece(label, "x");
  o.text = "Prestation";
  const out = engine.exportPdf(fixture, [[o], []], new Map()).data;
  assert.ok(texts(out).some((p) => p.text === "Prestation") && !texts(out).some((p) => p.text === "Description"));
  // the band is whole: under the old word, right of it, and at its far end
  assertPixel(pixelAt(out, 0, 70, 344), blue, "the band above the edited word");
  assertPixel(pixelAt(out, 0, 150, 351), blue, "the band right of the edited word");
  assertPixel(pixelAt(out, 0, 300, 351), blue, "the band in the middle");
  assertPixel(pixelAt(out, 0, 550, 360), blue, "the band at its right end");
  // the border of the table: the left edge at x=40 is still drawn (grey, 0.75 wide)
  const edge = pixelAt(out, 0, 40, 420, 4);
  assert.ok(edge[0] < 235 && edge[2] < 245, `the table's left border is gone: rgb(${edge})`);
  assertPixel(pixelAt(fixture, 0, 40, 420, 4), edge, "the border is drawn as before the edit", 2);

  // a text of the table: the border right next to it stays
  const first = adoptPiece(before.find((p) => p.text.startsWith("Étude")), "y");
  first.text = "Etude";
  const out2 = engine.exportPdf(fixture, [[first], []], new Map()).data;
  const edge2 = pixelAt(out2, 0, 40, 378, 4);
  assert.ok(edge2[0] < 235, `the border beside the edited text is gone: rgb(${edge2})`);
  assertPixel(pixelAt(out2, 0, 300, 351), blue, "the band above the edited row");
});

test("a small drawing that lies entirely where a text is removed stays (a rule across a word, a bullet)", () => {
  // a red rule 2 pt high drawn across a 20 pt word, at the height of the middle of its letters:
  // it is wholly inside the band that an edit of that word removes text from
  const src = engine.exportPdf(blank(), [[
    T({ id: "a", text: "Barre", x: 100, y: 200, size: 20 }),
    { id: "r", type: "rect", x: 104, y: 192, w: 30, h: 2, fill: [1, 0, 0], stroke: null },
  ]], new Map()).data;
  assertPixel(pixelAt(src, 0, 120, 193, 4), [255, 0, 0], "the rule, before");
  const o = adoptPiece(texts(src).find((p) => p.text === "Barre"), "x");
  o.text = "Autre";
  const out = engine.exportPdf(src, [[o]], new Map()).data;
  assert.deepEqual(texts(out).map((p) => p.text), ["Autre"]);
  // the new text is written over the rule (objects are added on top), so look where no letter is:
  // right of the "A", the rule is still red or covered by black ink, never white paper
  const seen = [106, 110, 114, 118, 122, 126, 130].map((x) => pixelAt(out, 0, x, 193, 4));
  assert.ok(seen.some((c) => near(c, [255, 0, 0], 20)), `the rule is gone: ${JSON.stringify(seen)}`);
  assert.ok(!seen.some((c) => near(c, [255, 255, 255], 20)), `a part of the rule is gone: ${JSON.stringify(seen)}`);
});

test("changing a text written over a picture leaves the picture", () => {
  const images = new Map([["img", png({ rgb: [214, 69, 65], bottom: [20, 160, 90], alpha: false })]]);
  const src = engine.exportPdf(blank(), [[
    { id: "i", type: "image", imageId: "img", x: 100, y: 100, w: 200, h: 100, opacity: 1 },
    T({ id: "a", text: "Sur la photo", x: 120, y: 130, size: 14, color: [1, 1, 1] }),
  ]], images).data;
  assertPixel(pixelAt(src, 0, 280, 120), [214, 69, 65], "the picture, before");
  const o = adoptPiece(texts(src).find((p) => p.text === "Sur la photo"), "x");
  o.text = "Autre";
  const out = engine.exportPdf(src, [[o]], new Map()).data;
  assert.deepEqual(texts(out).map((p) => p.text), ["Autre"]);
  assertPixel(pixelAt(out, 0, 280, 120), [214, 69, 65], "upper half of the picture, right of the text");
  assertPixel(pixelAt(out, 0, 200, 126), [214, 69, 65], "the picture where the old text was");
  assertPixel(pixelAt(out, 0, 200, 180), [20, 160, 90], "lower half of the picture");
  assertPixel(pixelAt(out, 0, 105, 105), [214, 69, 65], "corner of the picture");
});

test("the eraser removes text only: drawings and pictures beside its area stay", () => {
  // an eraser over the top left corner of the table: the rest of the border stays, the band stays
  const out = engine.exportPdf(fixture, [[{ id: "e", type: "erase", x: 30, y: 355, w: 30, h: 20 }], []], new Map()).data;
  assertPixel(pixelAt(out, 0, 45, 365), [255, 255, 255], "the erased corner is covered");
  const edge = pixelAt(out, 0, 40, 440, 4);
  assert.ok(edge[0] < 235, `the border below the erased corner is gone: rgb(${edge})`);
  assertPixel(pixelAt(out, 0, 300, 351), blue, "the band right of the erased corner");
  assertPixel(pixelAt(out, 0, 70, 344), blue, "the band above the erased corner");

  // an eraser on a part of a picture: the rest of the picture stays
  const images = new Map([["img", png({ rgb: [214, 69, 65], bottom: [20, 160, 90], alpha: false })]]);
  const src = engine.exportPdf(blank(), [[{ id: "i", type: "image", imageId: "img", x: 100, y: 100, w: 200, h: 100, opacity: 1 }]], images).data;
  const out2 = engine.exportPdf(src, [[{ id: "e", type: "erase", x: 90, y: 90, w: 40, h: 40 }]], new Map()).data;
  assertPixel(pixelAt(out2, 0, 110, 110), [255, 255, 255], "the erased part of the picture is covered");
  assertPixel(pixelAt(out2, 0, 250, 120), [214, 69, 65], "the rest of the picture, upper half");
  assertPixel(pixelAt(out2, 0, 250, 180), [20, 160, 90], "the rest of the picture, lower half");
});

test("the eraser has no outline, even if it is given one", () => {
  const out = engine.exportPdf(blank(), [[
    { id: "b", type: "rect", x: 50, y: 50, w: 200, h: 200, fill: [0, 0, 1], stroke: null },
    { id: "e", type: "erase", x: 100, y: 100, w: 100, h: 100, fill: [1, 1, 0], stroke: [1, 0, 0], strokeWidth: 6 },
  ]], new Map()).data;
  assertPixel(pixelAt(out, 0, 150, 150), [255, 255, 0], "the cover");
  assertPixel(pixelAt(out, 0, 101, 150), [255, 255, 0], "just inside the left edge: cover, not an outline");
  assertPixel(pixelAt(out, 0, 98, 150), [0, 0, 255], "just outside the left edge: the shape under it, not an outline");
});

test("opacity applies to lines, borders and drawings, not only to fills", () => {
  const out = engine.exportPdf(blank(), [[
    { id: "l", type: "line", x1: 50, y1: 100, x2: 250, y2: 100, stroke: [0, 0, 0], strokeWidth: 10, opacity: 0.5 },
    { id: "r", type: "rect", x: 50, y: 150, w: 200, h: 60, fill: null, stroke: [0, 0, 0], strokeWidth: 10, opacity: 0.5 },
    { id: "k", type: "ink", strokes: [[[50, 260], [150, 260], [250, 260]]], stroke: [0, 0, 0], strokeWidth: 10, opacity: 0.5 },
    { id: "a", type: "arrow", x1: 50, y1: 320, x2: 250, y2: 320, stroke: [0, 0, 0], strokeWidth: 10, opacity: 0.5 },
  ]], new Map()).data;
  assertPixel(pixelAt(out, 0, 150, 100), [128, 128, 128], "a black line at 50 %", 10);
  assertPixel(pixelAt(out, 0, 150, 150), [128, 128, 128], "a black border at 50 %", 10);
  assertPixel(pixelAt(out, 0, 100, 260), [128, 128, 128], "a black drawing at 50 %", 10);
  assertPixel(pixelAt(out, 0, 100, 320), [128, 128, 128], "a black arrow at 50 %", 10);
  assertPixel(pixelAt(out, 0, 150, 180), [255, 255, 255], "inside the unfilled rectangle");
});

test("a line, an arrow or a drawing of width 0 draws nothing; a rectangle of width 0 has no border", () => {
  const out = engine.exportPdf(blank(), [[
    { id: "l", type: "line", x1: 50, y1: 100, x2: 250, y2: 100, stroke: [1, 0, 0], strokeWidth: 0 },
    { id: "a", type: "arrow", x1: 50, y1: 150, x2: 250, y2: 150, stroke: [1, 0, 0], strokeWidth: 0 },
    { id: "k", type: "ink", strokes: [[[50, 200], [250, 200]]], stroke: [1, 0, 0], strokeWidth: 0 },
    { id: "r", type: "rect", x: 50, y: 250, w: 200, h: 60, fill: [0, 0, 1], stroke: [1, 0, 0], strokeWidth: 0 },
    { id: "m", type: "line", x1: 50, y1: 350, x2: 250, y2: 350, stroke: [1, 0, 0], strokeWidth: 0.5 },
  ]], new Map()).data;
  assertPixel(pixelAt(out, 0, 150, 100, 4), [255, 255, 255], "a line of width 0");
  assertPixel(pixelAt(out, 0, 150, 150, 4), [255, 255, 255], "an arrow of width 0");
  assertPixel(pixelAt(out, 0, 245, 150, 4), [255, 255, 255], "the head of an arrow of width 0");
  assertPixel(pixelAt(out, 0, 150, 200, 4), [255, 255, 255], "a drawing of width 0");
  assertPixel(pixelAt(out, 0, 150, 280), [0, 0, 255], "the fill of a rectangle of width 0");
  assertPixel(pixelAt(out, 0, 50.2, 280, 4), [0, 0, 255], "the edge of a rectangle of width 0: its fill, no border", 40);
  // a hairline is still a line, in its own colour (never the page's default black pen)
  const hair = pixelAt(out, 0, 150, 350, 8);
  assert.ok(hair[0] > 200 && hair[1] < 200 && Math.abs(hair[1] - hair[2]) < 12, `a red line 0.5 wide: rgb(${hair})`);
});

test("text that is not horizontal is not offered for editing (a known limit), the rest of the page is", () => {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin") } };
  // one horizontal text, one turned a quarter turn (text matrix 0 1 -1 0), one upside down
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "BT /F1 12 Tf 50 700 Td (Horizontal) Tj ET BT /F1 12 Tf 0 1 -1 0 300 400 Tm (Vertical) Tj ET BT /F1 12 Tf -1 0 0 -1 400 600 Tm (Renverse) Tj ET"));
  const src = bytesOf(doc);
  doc.destroy();
  assert.deepEqual(texts(src).map((p) => p.text), ["Horizontal"]);
  // editing the horizontal one leaves the turned ones in the file
  const o = adoptPiece(texts(src)[0], "x");
  o.text = "Droit";
  const out = engine.exportPdf(src, [[o]], new Map()).data;
  const d = engine.open(out);
  const all = d.loadPage(0).toStructuredText("").asText();
  d.destroy();
  assert.match(all, /Droit/);
  assert.match(all, /Vertical/);
  assert.match(all, /Renverse/);
  assert.doesNotMatch(all, /Horizontal/);
});
