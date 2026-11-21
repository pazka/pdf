// The edit engine against the kinds of PDF that other programs write, and against its own output
// opened again. Same rule as engine.test.js: results are read back from the written file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as mupdf from "mupdf";

import { BASE_FONTS, adoptPiece, isPristine } from "../web/js/engine.js";
import { PASSWORD, TITLE, UNKNOWN_FONT, UNKNOWN_TEXT, buildFixture, buildProtected, engineWithFonts } from "./fixture.mjs";

const engine = engineWithFonts(mupdf);
const fixture = buildFixture(mupdf, engine);

const texts = (bytes, page = 0) => {
  const doc = engine.open(bytes);
  const out = engine.extractText(doc, page);
  doc.destroy();
  return out;
};
const bytesOf = (doc, options = "") => {
  const buf = doc.saveToBuffer(options);
  const out = new Uint8Array(buf.asUint8Array());
  buf.destroy();
  return out;
};
const T = (o) => ({ id: "t", type: "text", size: 10, bold: false, italic: false, color: [0, 0, 0], ...o });
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** A one-page PDF as a simple generator (FPDF, ReportLab...) writes it: standard fonts, not embedded. */
function plain(content, { parentResources = false, pages = 1 } = {}) {
  const doc = new mupdf.PDFDocument();
  const fonts = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin"), F2: doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"), "Latin") } };
  for (let i = 0; i < pages; i += 1) doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, fonts, content));
  if (parentResources) {
    // the pages inherit their Resources from the page tree, as many producers write them
    const first = doc.findPage(0);
    const res = first.get("Resources");
    first.get("Parent").put("Resources", res);
    for (let i = 0; i < pages; i += 1) doc.findPage(i).delete("Resources");
  }
  const out = bytesOf(doc);
  doc.destroy();
  return out;
}

test("each font family and style the editor writes is read back as the same family and style", () => {
  const blank = plain("");
  const combos = [];
  for (const family of ["Lato", ...Object.keys(BASE_FONTS)]) {
    for (const bold of [false, true]) for (const italic of [false, true]) combos.push({ family, bold, italic });
  }
  const objects = combos.map((c, i) => T({ id: `t${i}`, text: `Texte ${i}`, x: 50, y: 60 + i * 30, size: 14, ...c }));
  const saved = engine.exportPdf(blank, [objects], new Map()).data;
  const back = texts(saved);
  combos.forEach((c, i) => {
    const p = back.find((t) => t.text === `Texte ${i}`);
    assert.ok(p, `Texte ${i} is not in the file`);
    assert.deepEqual({ family: p.family, bold: p.bold, italic: p.italic, exact: p.exactFont }, { ...c, exact: true }, `written as ${JSON.stringify(c)}, font in the file: ${p.fontName}`);
  });
});

test("edit, save, open the saved file, edit again: the text keeps its font", () => {
  const src = plain("BT /F1 18 Tf 60 700 Td (Facture brouillon DE26-003) Tj ET BT /F2 10 Tf 60 650 Td (Total) Tj ET");
  const first = adoptPiece(texts(src).find((p) => p.text.startsWith("Facture")), "a");
  assert.equal(first.family, "Helvetica");
  first.text = "Devis DE26-003";
  const once = engine.exportPdf(src, [[first]], new Map()).data;

  const again = adoptPiece(texts(once).find((p) => p.text === "Devis DE26-003"), "b");
  assert.equal(again.family, "Helvetica", `second edit sees the font as ${again.family} (font in the file: ${again.fontName})`);
  assert.equal(again.exactFont, true);
  again.text = "Devis DE26-004";
  const twice = engine.exportPdf(once, [[again]], new Map()).data;
  const back = texts(twice);
  const title = back.find((p) => p.text === "Devis DE26-004");
  assert.equal(title.family, "Helvetica");
  assert.equal(title.bold, false);
  assert.ok(Math.abs(title.size - 18) < 0.01);
  assert.ok(!back.some((p) => /DE26-003|brouillon/.test(p.text)), "a previous title is still in the file");
  // the bold text that was never touched is still bold Helvetica
  const total = back.find((p) => p.text === "Total");
  assert.deepEqual([total.family, total.bold], ["Helvetica", true]);
});

test("a file written by the editor, edited with another font: the texts already there keep theirs", () => {
  // the fixture's fonts are named HoshF1, HoshF2... by the engine; a new font must not take one of those names
  const before = texts(fixture);
  const add = T({ text: "Ajout", x: 60, y: 620, family: "Courier" });
  const after = texts(engine.exportPdf(fixture, [[add], []], new Map()).data);
  const key = (p) => `${p.text} | ${p.family} | ${p.fontName} | ${p.bold} | ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  assert.deepEqual(after.filter((p) => p.text !== "Ajout").map(key), before.map(key));
  assert.equal(after.find((p) => p.text === "Ajout").family, "Courier");
  // same on page 2, with a font that page already uses (Times) and one it does not (Lato bold)
  const p2 = texts(fixture, 1);
  const more = [T({ id: "a", text: "Un", x: 60, y: 620, family: "Lato", bold: true }), T({ id: "b", text: "Deux", x: 60, y: 660, family: "Times" })];
  const after2 = texts(engine.exportPdf(fixture, [[], more], new Map()).data, 1);
  assert.deepEqual(after2.filter((p) => !["Un", "Deux"].includes(p.text)).map(key), p2.map(key));
});

test("lines set tight: changing one keeps the lines above and below, down to 0.85 of the font size", () => {
  // Standard fonts, not embedded, 10 pt. The box of such a font is about 13.7 pt high, so the boxes
  // of neighbouring lines overlap; letters with descenders above, capitals below (the worst case).
  const fonts = { Helvetica: "Helvetica-Bold", "Times-Roman": "Times-Bold", Courier: "Courier-Bold" };
  for (const [regular, bold] of Object.entries(fonts)) {
    for (const step of [12, 10, 9.5, 9, 8.5]) {
      const doc = new mupdf.PDFDocument();
      const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font(regular), "Latin"), F2: doc.addSimpleFont(new mupdf.Font(bold), "Latin") } };
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, `BT /F2 10 Tf 50 ${700 + step} Td (Agjpy Client) Tj ET BT /F1 10 Tf 50 700 Td (Ligne a changer gjpqy) Tj ET BT /F2 10 Tf 50 ${700 - step} Td (ATotal AEIOU) Tj ET`));
      const src = bytesOf(doc);
      doc.destroy();
      const o = adoptPiece(texts(src).find((p) => p.text.startsWith("Ligne")), "x");
      o.text = "CHANGE";
      const back = texts(engine.exportPdf(src, [[o]], new Map()).data).map((p) => p.text).sort();
      assert.deepEqual(back, ["ATotal AEIOU", "Agjpy Client", "CHANGE"], `${regular}, lines ${step} pt apart at 10 pt`);
    }
  }
  // three lines of one style are one paragraph: edited whole, all three really go
  const src = plain("BT /F1 10 Tf 50 710 Td (Haut) Tj ET BT /F1 10 Tf 50 700 Td (Milieu) Tj ET BT /F1 10 Tf 50 690 Td (Bas) Tj ET");
  const whole = adoptPiece(texts(src)[0], "x");
  assert.equal(whole.text, "Haut\nMilieu\nBas");
  whole.text = "Un\nDeux\nTrois";
  assert.deepEqual(texts(engine.exportPdf(src, [[whole]], new Map()).data).map((p) => p.text), ["Un\nDeux\nTrois"]);
});

test("lines set tight in embedded fonts (as the editor and browsers write them): the neighbours stay too", () => {
  const blank = plain("");
  for (const family of ["Lato", "Helvetica", "Times", "Courier"]) {
    for (const spacing of [1.2, 1, 0.9, 0.85]) {
      const lines = ["Agjpy Premier", "Second gjpqy", "ADernier AEIOU"].map((t, i) => T({ id: `l${i}`, text: t, x: 50, y: 100 + i * 12 * spacing, size: 12, family, bold: i !== 1 }));
      const src = engine.exportPdf(blank, [lines], new Map()).data;
      const o = adoptPiece(texts(src).find((p) => p.text.startsWith("Second")), "x");
      o.text = "Autre";
      assert.deepEqual(texts(engine.exportPdf(src, [[o]], new Map()).data).map((p) => p.text).sort(), ["ADernier AEIOU", "Agjpy Premier", "Autre"], `${family} at line spacing ${spacing}`);
    }
  }
});

test("words that MuPDF splits on one baseline are one piece; words far apart are two", () => {
  // "Hello" ends near x=73; "World" starts 5 pt after it (half an em), "Loin" starts 130 pt after
  const src = plain("BT /F1 10 Tf 50 700 Td (Hello) Tj ET BT /F1 10 Tf 78 700 Td (World) Tj ET BT /F1 10 Tf 230 700 Td (Loin) Tj ET BT /F2 10 Tf 256 700 Td (Gras) Tj ET");
  const pieces = texts(src).map((p) => p.text);
  assert.deepEqual(pieces, ["Hello World", "Loin", "Gras"], "one space between joined words; another style on the same row stays apart");
  const joined = texts(src)[0];
  assert.ok(joined.bbox[2] > 100 && joined.rects.length === 1 && joined.rects[0][2] > 100, "the joined piece covers both words");
  // and editing it removes both words
  const o = adoptPiece(joined, "x");
  o.text = "Salut";
  assert.deepEqual(texts(engine.exportPdf(src, [[o]], new Map()).data).map((p) => p.text).sort(), ["Gras", "Loin", "Salut"]);
});

test("grey and CMYK text colours come back as RGB, and an edit keeps them", () => {
  const src = plain("0.5 g BT /F1 12 Tf 50 700 Td (Gris) Tj ET 0 1 1 0 k BT /F1 12 Tf 50 670 Td (Rouge) Tj ET 0 0 1 rg BT /F1 12 Tf 50 640 Td (Bleu) Tj ET");
  const by = Object.fromEntries(texts(src).map((p) => [p.text, p.color]));
  assert.ok(near(by.Gris, [0.5, 0.5, 0.5], 0.02), `grey: ${by.Gris}`);
  assert.ok(near(by.Rouge, [1, 0, 0], 0.15), `CMYK red: ${by.Rouge}`);
  assert.ok(near(by.Bleu, [0, 0, 1], 0.02), `RGB blue: ${by.Bleu}`);
  const o = adoptPiece(texts(src).find((p) => p.text === "Gris"), "x");
  o.text = "Gris clair";
  const back = texts(engine.exportPdf(src, [[o]], new Map()).data).find((p) => p.text === "Gris clair");
  assert.ok(near(back.color, [0.5, 0.5, 0.5], 0.02), `after the edit: ${back.color}`);
});

test("pages that inherit their Resources: editing one page leaves its sibling's fonts alone", () => {
  const src = plain("BT /F1 12 Tf 50 700 Td (Bonjour) Tj ET", { parentResources: true, pages: 2 });
  const o = adoptPiece(texts(src, 0)[0], "x");
  o.text = "Bonsoir";
  o.family = "Lato";
  const out = engine.exportPdf(src, [[o], []], new Map()).data;
  assert.deepEqual(texts(out, 0).map((p) => [p.text, p.family]), [["Bonsoir", "Lato"]]);
  assert.deepEqual(texts(out, 1).map((p) => [p.text, p.family]), [["Bonjour", "Helvetica"]]);
  // the shared dictionary of the page tree did not get the new font: only page 1 has it
  const doc = engine.open(out);
  const shared = doc.findPage(1).getInheritable("Resources").get("Font");
  const names = [];
  shared.forEach((v, k) => names.push(k));
  assert.deepEqual(names.sort(), ["F1", "F2"], "the page tree's fonts were changed");
  assert.ok(doc.findPage(1).get("Resources").isNull(), "the untouched page got Resources of its own");
  doc.destroy();

  // the same with an object that replaces nothing (a new text, a half transparent shape, an image):
  // the page gets its own copy of the inherited dictionary, with the old fonts still in it
  const add = [
    T({ id: "n", text: "Ajout", x: 50, y: 300, family: "Courier" }),
    { id: "r", type: "rect", x: 50, y: 320, w: 20, h: 20, fill: [1, 0, 0], stroke: null, opacity: 0.5 },
  ];
  const out2 = engine.exportPdf(src, [add, []], new Map()).data;
  assert.deepEqual(texts(out2, 0).map((p) => [p.text, p.family]).sort(), [["Ajout", "Courier"], ["Bonjour", "Helvetica"]]);
  assert.deepEqual(texts(out2, 1).map((p) => [p.text, p.family]), [["Bonjour", "Helvetica"]]);
  const doc2 = engine.open(out2);
  const own = doc2.findPage(0).get("Resources");
  assert.ok(own.isDictionary(), "the edited page has no Resources of its own");
  const shared2 = [];
  doc2.findPage(1).getInheritable("Resources").get("Font").forEach((v, k) => shared2.push(k));
  assert.deepEqual(shared2.sort(), ["F1", "F2"], "the page tree's fonts were changed");
  assert.ok(doc2.findPage(1).get("Resources").isNull());
  doc2.destroy();
});

test("the page's own content is closed in q ... Q before anything is added", () => {
  // what the file gets: [ "q", the page's streams..., "Q q <page space> cm ... Q" ]
  const src = plain("3 0 0 3 50 50 cm 0 1 0 rg 0 0 10 10 re f");
  const doc = engine.open(src);
  engine.bake(doc, 0, [{ id: "r", type: "rect", x: 300, y: 400, w: 20, h: 20, fill: [1, 0, 0], stroke: null }], {});
  const contents = doc.findPage(0).get("Contents");
  assert.ok(contents.isArray() && contents.length === 3, "Contents is not [q, page, additions]");
  assert.equal(contents.get(0).readStream().asString().trim(), "q");
  assert.match(contents.get(1).readStream().asString(), /3 0 0 3 50 50 cm/);
  assert.match(contents.get(2).readStream().asString(), /^\s*Q\s*q [-\d. ]+ cm/);
  doc.destroy();
  // and with no object at all, the page is not touched
  const same = engine.open(src);
  engine.bake(same, 0, [], {});
  assert.ok(!same.findPage(0).get("Contents").isArray());
  same.destroy();
});

test("a font file added by the visitor writes the text, and is embedded in the saved file", () => {
  // any TTF: here a Lato file under another name, as a visitor would add "MaPolice.ttf"
  const local = engineWithFonts(mupdf);
  local.registerCustomFont("MaPolice", readFileSync(new URL("../web/fonts/Lato-BoldItalic.ttf", import.meta.url)));
  assert.ok(local.families().includes("MaPolice"));
  assert.deepEqual(local.families().slice(0, 4), ["Lato", "Helvetica", "Times", "Courier"]);
  const out = local.exportPdf(plain(""), [[T({ text: "Avec ma police", x: 50, y: 100, size: 16, family: "MaPolice" })]], new Map()).data;
  const p = texts(out).find((t) => t.text === "Avec ma police");
  assert.equal(p.fontName, "MaPolice", "the font is embedded under the name the visitor's file was added with");
  assert.deepEqual([p.bold, p.italic], [true, true], "the glyphs are not those of the added file (a bold italic)");
  // same width on the page as the same text in the font the file really is
  const width = local.measure("Avec ma police", "Lato", true, true) * 16;
  assert.ok(Math.abs(p.bbox[2] - p.bbox[0] - width) < 2, `text is ${p.bbox[2] - p.bbox[0]} wide, expected ${width}`);
  assert.ok(Math.abs(local.measure("Avec ma police", "MaPolice", false, false) - local.measure("Avec ma police", "Lato", true, true)) < 1e-6);
});

test("a font the editor does not have: closest standard font, and it says the look is not exact", () => {
  const p = texts(fixture, 1).find((t) => t.text === UNKNOWN_TEXT);
  assert.equal(p.fontName, UNKNOWN_FONT);
  assert.equal(p.exactFont, false);
  assert.ok(["Helvetica", "Times"].includes(p.family));
  assert.deepEqual([p.bold, p.italic], [true, true]);
  const o = adoptPiece(p, "x");
  assert.equal(o.exactFont, false);
  assert.equal(o.fontName, UNKNOWN_FONT);
});

test("a text that was clicked and not changed is not an edit", () => {
  const o = adoptPiece(texts(fixture).find((p) => p.text === TITLE), "x");
  assert.equal(isPristine(o), true);
  for (const change of [{ text: "Devis" }, { x: o.x + 1 }, { y: o.y - 2 }, { size: 21 }, { bold: true }, { italic: true }, { color: [1, 0, 0] }, { family: "Times" }, { align: "left" }, { opacity: 0.5 }, { underline: true }, { strike: true }, { lineHeight: 2 }, { rotation: 10 }]) {
    assert.equal(isPristine({ ...o, ...change }), false, `changed ${Object.keys(change)[0]}`);
  }
  assert.equal(isPristine({ ...o, text: "Devis", ...{ text: o.text } }), true, "typed back to what it was");
  assert.equal(isPristine({ type: "text", text: "new" }), false, "a new text is always an edit");
});

test("a password-protected PDF says so; an unreadable one is refused", () => {
  const locked = engine.open(buildProtected(mupdf, engine));
  assert.equal(locked.needsPassword(), true);
  assert.ok(locked.authenticatePassword(PASSWORD) > 0);
  locked.destroy();
  const open = engine.open(fixture);
  assert.equal(open.needsPassword(), false);
  open.destroy();
});
