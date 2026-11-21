// The fixed PDF of the tests and of the visual harness: built in code with the engine itself, so the
// repo never holds a real document. Two A4 pages that look like an invoice: a centred title, an
// address block, a table, a paragraph in a font the editor does not ship, and text in a subset font.
//
//   node test/fixture.mjs --write     rewrites visual/fixture.pdf (commit it with the change)
//   node test/fixture.mjs --check     fails when visual/fixture.pdf is not what this file builds (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { SHIPPED_FONTS, createEngine } from "../web/js/engine.js";

export const BLUE = [0.208, 0.294, 0.686];
export const INK = [0.13, 0.15, 0.16];
export const TITLE = "Facture brouillon F-001";
export const UNKNOWN_TEXT = "Police inconnue";
export const UNKNOWN_FONT = "Quicksand-Medium";
export const PASSWORD = "secret";

/** An engine with the shipped fonts loaded from web/fonts (what the browser does with fetch). */
export function engineWithFonts(mupdf) {
  const engine = createEngine(mupdf);
  for (const [family, files] of Object.entries(SHIPPED_FONTS)) {
    files.forEach((f, i) => engine.registerFont(family, !!(i & 1), !!(i & 2), readFileSync(new URL(`../web/fonts/${f}`, import.meta.url))));
  }
  return engine;
}

/** A PNG made with Node built-ins. `alpha`: the left half is fully transparent. `bottom`: colour of the lower half. */
export function png({ width = 32, height = 32, rgb = [214, 69, 65], bottom = rgb, alpha = true } = {}) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push(...(y < height / 2 ? rgb : bottom), alpha && x < width / 2 ? 0 : 255);
    rows.push(Buffer.from(row));
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]));
}

const text = (t, x, y, size, extra = {}) => ({ type: "text", text: t, x, y, size, family: "Lato", bold: false, italic: false, color: INK, align: "left", lineHeight: 1.35, ...extra });

export const PAGE1 = [
  text("Atelier Exemple\n12 rue des Tests\n67000 Strasbourg", 40, 60, 10),
  text(TITLE, 297.5, 150, 20, { color: BLUE, align: "center" }),
  text("CLIENT DEMO\n1 place du Jeu\n75001 Paris\nFrance", 40, 200, 10),
  text("Date de facturation", 46, 300, 10, { bold: true }),
  text("23/11/2026", 46, 315, 10),
  { type: "rect", x: 40, y: 340, w: 515, h: 22, fill: BLUE, stroke: null },
  text("Description", 46, 355, 10, { color: [1, 1, 1] }),
  text("Montant", 549, 355, 10, { color: [1, 1, 1], align: "right" }),
  { type: "rect", x: 40, y: 362, w: 515, h: 120, fill: null, stroke: [0.8, 0.82, 0.86], strokeWidth: 0.75 },
  text("Étude, conception et prototypage", 46, 380, 10),
  text("Inclus :\n- Conception de l'architecture du programme\n- Adaptation des projections aux sculptures\n- Tests de stabilité et documentation", 46, 404, 10, { lineHeight: 1.25 }),
  text("8 000,00 €", 549, 380, 10, { align: "right" }),
  text("Total", 380, 505, 10, { bold: true }),
  text("8 000,00 €", 549, 505, 10, { bold: true, align: "right" }),
];

export const PAGE2 = [
  text("Conditions", 40, 70, 16, { family: "Times", bold: true }),
  text("Paiement à 30 jours.\nPénalités de retard : 3 fois le taux légal.", 40, 100, 11, { family: "Times" }),
  text("Référence F-001", 40, 160, 10, { family: "Courier" }),
  text("Signature du client", 40, 230, 12, { family: "Helvetica" }),
  // written in Lato bold italic, then renamed in the file (buildFixture): a font the editor does not have
  text(UNKNOWN_TEXT, 40, 270, 12, { bold: true, italic: true }),
  { type: "line", x1: 40, y1: 180, x2: 555, y2: 180, stroke: [0.6, 0.6, 0.6], strokeWidth: 1 },
  text("Page 2 / 2", 555, 800, 9, { align: "right" }),
];

/** Bytes of the fixture PDF. Its fonts are subset, as in a real invoice. */
export function buildFixture(mupdf, engine = engineWithFonts(mupdf), options = "garbage=compact,compress=yes") {
  const doc = new mupdf.PDFDocument();
  const state = {};
  for (const objects of [PAGE1, PAGE2]) {
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ""));
    engine.bake(doc, doc.countPages() - 1, objects, state);
  }
  doc.subsetFonts();
  // one font gets a name the editor knows nothing about (as a PDF made with any other font would have)
  const font = state.fontRefs.get(engine.getFont("Lato", true, true));
  const name = `QAZWSX+${UNKNOWN_FONT}`;
  font.put("BaseFont", doc.newName(name));
  const descendant = font.get("DescendantFonts", 0);
  descendant.put("BaseFont", doc.newName(name));
  descendant.get("FontDescriptor").put("FontName", doc.newName(name));
  const buf = doc.saveToBuffer(options);
  const bytes = new Uint8Array(buf.asUint8Array());
  buf.destroy();
  doc.destroy();
  return bytes;
}

/** The fixture, protected by a password that is needed to open it. */
export function buildProtected(mupdf, engine = engineWithFonts(mupdf)) {
  return buildFixture(mupdf, engine, `garbage=compact,compress=yes,encrypt=aes-256,user-password=${PASSWORD},owner-password=${PASSWORD}-owner`);
}

if (process.argv.includes("--check")) {
  // the committed fixture must be the one this file builds: same pages, same texts at the same places
  const mupdf = await import("mupdf");
  const engine = engineWithFonts(mupdf);
  const dump = (bytes) => {
    const doc = engine.open(bytes);
    const out = engine.pageSizes(doc).map((size, i) => ({ size, texts: engine.extractText(doc, i).map((p) => [p.text, Math.round(p.x), Math.round(p.y), p.family, p.bold]) }));
    doc.destroy();
    return JSON.stringify(out);
  };
  const committed = dump(new Uint8Array(readFileSync(new URL("../visual/fixture.pdf", import.meta.url))));
  if (committed !== dump(buildFixture(mupdf, engine))) {
    console.error("visual/fixture.pdf is not what test/fixture.mjs builds: run node test/fixture.mjs --write");
    process.exit(1);
  }
  const locked = engine.open(new Uint8Array(readFileSync(new URL("../visual/protected.pdf", import.meta.url))));
  if (!locked.needsPassword() || !locked.authenticatePassword(PASSWORD)) {
    console.error("visual/protected.pdf is not protected by the fixture's password: run node test/fixture.mjs --write");
    process.exit(1);
  }
  console.log("visual/fixture.pdf and visual/protected.pdf match test/fixture.mjs");
} else if (process.argv.includes("--write")) {
  const mupdf = await import("mupdf");
  const out = new URL("../visual/fixture.pdf", import.meta.url);
  writeFileSync(out, buildFixture(mupdf));
  writeFileSync(new URL("../visual/protected.pdf", import.meta.url), buildProtected(mupdf));
  console.log(`wrote ${out.pathname} and protected.pdf`);
}
