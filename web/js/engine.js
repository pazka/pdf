/**
 * PDF edit engine of pdf.hosh.it. Pure logic on top of MuPDF.js: it runs unchanged in the browser
 * (the editor) and in Node (the tests). It never touches the DOM or the network.
 *
 * Model: the opened file is never modified. The editor keeps a list of objects per page (text,
 * shapes, images, drawings). `bake()` writes those objects into a fresh copy of a page; the same
 * function makes the preview and the saved file, so what is shown is what is saved.
 *
 * Coordinates: everything is in "page space": points, origin at the top left of the page as it is
 * displayed, y going down (the space of MuPDF's structured text). `bake()` converts to PDF space.
 *
 * Editing existing text: the object carries `redact` rectangles. The glyphs under them are truly
 * removed from the page (a redaction, without the black box), then the new text is written.
 */

/** Fonts that MuPDF carries itself (the 14 standard PDF fonts). */
export const BASE_FONTS = {
  Helvetica: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  Times: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  Courier: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

/** Open fonts shipped with the app (files in /fonts): family -> [regular, bold, italic, bold italic]. */
export const SHIPPED_FONTS = {
  Lato: ["Lato-Regular.ttf", "Lato-Bold.ttf", "Lato-Italic.ttf", "Lato-BoldItalic.ttf"],
};

export const FAMILIES = [...Object.keys(SHIPPED_FONTS), ...Object.keys(BASE_FONTS)];

export const ASCENT = 0.93; // box above the baseline, in font sizes (for selection boxes and new text)
export const DESCENT = 0.27;

const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** "ABCDEF+Lato-Bold" -> "Lato-Bold" (a subset font carries a six letter tag). */
export function stripSubsetTag(name) {
  return String(name || "").replace(/^[A-Z]{6}\+/, "");
}

/**
 * Which font the editor uses for text that was set in `name`.
 * A PDF usually embeds only the glyphs it uses, so the embedded font cannot write new letters:
 * the editor writes with its own copy, matched by name, else with the closest standard font.
 */
export function matchFont(name, flags = {}) {
  const plain = stripSubsetTag(name);
  const lower = plain.toLowerCase().replace(/[^a-z]/g, "");
  const bold = flags.bold || /bold|black|heavy|semibold|demi/.test(lower);
  const italic = flags.italic || /italic|oblique/.test(lower);
  for (const family of Object.keys(SHIPPED_FONTS)) {
    if (lower.startsWith(family.toLowerCase())) return { family, bold, italic, exact: true };
  }
  // The name decides when it says what the font is. The flags of the file decide only for a name
  // that says nothing: they are not reliable (MuPDF reports "serif" for every font it embedded
  // itself, so a Helvetica text written by this editor would come back as Times).
  if (/helvetica|arial|nimbussans|liberationsans/.test(lower)) return { family: "Helvetica", bold, italic, exact: true };
  if (/courier|nimbusmono|liberationmono/.test(lower)) return { family: "Courier", bold, italic, exact: true };
  if (/times|nimbusroman|liberationserif/.test(lower)) return { family: "Times", bold, italic, exact: true };
  let family = "Helvetica";
  if (flags.mono || /mono|consol/.test(lower)) family = "Courier";
  else if (!/sans|grotesk|gothic/.test(lower) && (flags.serif || /serif|georgia|garamond|minion|cambria/.test(lower))) family = "Times";
  return { family, bold, italic, exact: false };
}

export function fontKey(family, bold, italic) {
  return `${family}|${bold ? "b" : ""}${italic ? "i" : ""}`;
}

export function createEngine(mupdf) {
  /** fontKey -> mupdf.Font. Shipped and custom fonts are registered with their bytes. */
  const fonts = new Map();
  /** family -> true for fonts the user added (one style only). */
  const custom = new Map();

  function registerFont(family, bold, italic, bytes) {
    const font = new mupdf.Font(family, bytes);
    fonts.set(fontKey(family, bold, italic), font);
    return font;
  }

  function registerCustomFont(family, bytes) {
    const font = new mupdf.Font(family, bytes);
    custom.set(family, font);
    return font;
  }

  function families() {
    const shipped = Object.keys(SHIPPED_FONTS).filter((f) => fonts.has(fontKey(f, false, false)));
    return [...shipped, ...Object.keys(BASE_FONTS), ...custom.keys()];
  }

  function getFont(family, bold, italic) {
    if (custom.has(family)) return custom.get(family);
    const key = fontKey(family, bold, italic);
    let font = fonts.get(key);
    if (font) return font;
    const base = BASE_FONTS[family] || (SHIPPED_FONTS[family] ? null : BASE_FONTS.Helvetica);
    if (!base) {
      // a shipped family whose file for this style is not loaded: regular, else Helvetica
      return fonts.get(fontKey(family, false, false)) || getFont("Helvetica", bold, italic);
    }
    font = new mupdf.Font(base[(bold ? 1 : 0) + (italic ? 2 : 0)]);
    fonts.set(BASE_FONTS[family] ? key : fontKey("Helvetica", bold, italic), font);
    return font;
  }

  /** Splits a line into runs of [font, glyph ids]: a character the font lacks falls back to Helvetica. */
  function shape(text, family, bold, italic) {
    const main = getFont(family, bold, italic);
    const fallback = getFont("Helvetica", bold, italic);
    const runs = [];
    const missing = [];
    for (const ch of text) {
      let font = main;
      let gid = main.encodeCharacter(ch);
      if (!gid && fallback !== main) {
        const g = fallback.encodeCharacter(ch);
        if (g) {
          font = fallback;
          gid = g;
        }
      }
      if (!gid) {
        missing.push(ch);
        gid = font.encodeCharacter("?");
      }
      const last = runs[runs.length - 1];
      if (last && last.font === font) last.gids.push(gid);
      else runs.push({ font, gids: [gid] });
    }
    let width = 0;
    for (const run of runs) {
      run.width = run.gids.reduce((w, g) => w + run.font.advanceGlyph(g, 0), 0);
      width += run.width;
    }
    return { runs, width, missing };
  }

  /** Width of one line of text, in font sizes. */
  function measure(text, family, bold, italic) {
    return shape(text, family, bold, italic).width;
  }

  /** Characters of `obj.text` that neither the chosen font nor Helvetica can write. */
  function missingGlyphs(obj) {
    const out = new Set();
    for (const line of String(obj.text || "").split("\n")) {
      for (const ch of shape(line, obj.family, obj.bold, obj.italic).missing) out.add(ch);
    }
    return [...out];
  }

  /** Box of an object in page space: [x0, y0, x1, y1] (before its own rotation). */
  function bounds(obj) {
    switch (obj.type) {
      case "text": {
        const lines = String(obj.text || "").split("\n");
        const leading = obj.size * (obj.lineHeight || 1.2);
        const widths = lines.map((l) => measure(l, obj.family, obj.bold, obj.italic) * obj.size);
        const w = Math.max(obj.size * 0.5, ...widths);
        const left = obj.align === "right" ? obj.x - w : obj.align === "center" ? obj.x - w / 2 : obj.x;
        return [left, obj.y - obj.size * ASCENT, left + w, obj.y + (lines.length - 1) * leading + obj.size * DESCENT];
      }
      case "line":
      case "arrow":
        return [Math.min(obj.x1, obj.x2), Math.min(obj.y1, obj.y2), Math.max(obj.x1, obj.x2), Math.max(obj.y1, obj.y2)];
      case "ink": {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const stroke of obj.strokes) {
          for (const [x, y] of stroke) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        }
        return [x0, y0, x1, y1];
      }
      default:
        return [obj.x, obj.y, obj.x + obj.w, obj.y + obj.h];
    }
  }

  function open(bytes) {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const pdf = doc.asPDF();
    if (!pdf) {
      doc.destroy();
      throw new Error("not a PDF file");
    }
    return pdf;
  }

  function pageSizes(doc) {
    const out = [];
    for (let i = 0; i < doc.countPages(); i += 1) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      out.push({ width: x1 - x0, height: y1 - y0 });
      page.destroy();
    }
    return out;
  }

  /** Renders a page to RGBA pixels. */
  function render(doc, index, scale) {
    const page = doc.loadPage(index);
    // on white paper: RGBA pixels (what a canvas takes), every one opaque
    const matrix = mupdf.Matrix.scale(scale, scale);
    const [x0, y0, x1, y1] = mupdf.Rect.transform(page.getBounds(), matrix);
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)], true);
    pix.clear(255);
    const device = new mupdf.DrawDevice(matrix, pix);
    page.run(device, mupdf.Matrix.identity);
    device.close();
    device.destroy();
    const out = { width: pix.getWidth(), height: pix.getHeight(), pixels: new Uint8ClampedArray(pix.getPixels()) };
    pix.destroy();
    page.destroy();
    return out;
  }

  function colorOf(c) {
    // MuPDF gives the colour of a character as RGB, whatever the file used (grey, CMYK...)
    return c && c.length === 3 ? [c[0], c[1], c[2]] : [0, 0, 0];
  }

  /**
   * The text of a page as editable pieces. One piece is a run of characters of one line with the
   * same font, size and colour. Pieces of a block that share a style and an alignment are merged
   * into one multi-line piece, so a paragraph is edited as a paragraph.
   * Each piece: { text, x, y (baseline of the first line), size, family, bold, italic, color, align,
   * lineHeight, fontName (as in the file), exactFont, rects (what to remove when it is edited), bbox }.
   */
  function extractText(doc, index) {
    const page = doc.loadPage(index);
    const pb = page.getBounds();
    const pageWidth = pb[2] - pb[0];
    const st = page.toStructuredText("preserve-whitespace,preserve-spans");
    const blocks = [];
    let block = null;
    let line = null;
    let run = null;
    st.walk({
      beginTextBlock() {
        block = [];
        blocks.push(block);
      },
      beginLine(bbox, wmode, dir) {
        line = { horizontal: wmode === 0 && Math.abs(dir[1]) < 0.01 && dir[0] > 0, runs: [] };
        run = null;
        block.push(line);
      },
      onChar(c, origin, font, size, quad, color) {
        const name = font.getName();
        const rgb = colorOf(color);
        const same =
          run && run.fontName === name && Math.abs(run.size - size) < 0.01 && run.color.every((v, i) => Math.abs(v - rgb[i]) < 0.004);
        if (!same) {
          // a run never starts with a space (MuPDF adds one between words set apart): the run would
          // start left of its first letter
          if (c.trim() === "") return;
          run = {
            text: "", fontName: name, size, color: rgb, x: origin[0], y: origin[1],
            flags: { bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono() },
            x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
          };
          line.runs.push(run);
        }
        run.text += c;
        for (let i = 0; i < 8; i += 2) {
          run.x0 = Math.min(run.x0, quad[i]); run.x1 = Math.max(run.x1, quad[i]);
          run.y0 = Math.min(run.y0, quad[i + 1]); run.y1 = Math.max(run.y1, quad[i + 1]);
        }
      },
    });
    st.destroy();
    page.destroy();

    const pieces = [];
    // what a keyboard types: the glyph of "-" is often mapped back to U+2010 by the font
    // (and the glyph of the space to U+00A0)
    const clean = (t) => t.replace(/ /g, " ").replace(/\s+$/, "").replace(/[‐‑]/g, "-");
    // What is removed from the page when a run is edited: a band around its baseline, not its
    // line box. The box of a font can be much taller than the line spacing (13.7 pt for standard
    // Helvetica at 10 pt), and a rectangle that tall also removes the lines above and below.
    const band = (r) => [r.x0, r.y - r.size * 0.72, r.x1, r.y + r.size * 0.02];
    const pieceOf = (r) => {
      const trimmed = clean(r.text);
      const m = matchFont(r.fontName, r.flags);
      return {
        text: trimmed, x: r.x, y: r.y, size: r.size, family: m.family, bold: m.bold, italic: m.italic,
        exactFont: m.exact, fontName: stripSubsetTag(r.fontName), color: r.color, align: "left", lineHeight: 1.2,
        rects: [band(r)], bbox: [r.x0, r.y0, r.x1, r.y1],
      };
    };
    for (const b of blocks) {
      // MuPDF may cut one visual line into several (a wide word gap): runs on the same baseline with
      // the same style and a gap of less than 1.5 em are one run again, so a title is edited whole
      const lines = [];
      let prev = null;
      for (const l of b) {
        if (!l.horizontal) continue;
        for (const r of l.runs) {
          if (r.text.trim() === "") continue;
          const gap = prev ? r.x0 - prev.x1 : 0;
          const joins =
            prev && Math.abs(prev.y - r.y) < 0.5 && prev.fontName === r.fontName && Math.abs(prev.size - r.size) < 0.01 &&
            prev.color.every((v, i) => Math.abs(v - r.color[i]) < 0.004) && gap > -r.size * 0.2 && gap < r.size * 1.5;
          if (joins) {
            const spaced = /\s$/.test(prev.text) || /^\s/.test(r.text) || gap < r.size * 0.12;
            prev.text += (spaced ? "" : " ") + r.text;
            prev.x1 = Math.max(prev.x1, r.x1);
            prev.y0 = Math.min(prev.y0, r.y0);
            prev.y1 = Math.max(prev.y1, r.y1);
            continue;
          }
          const sameLine = prev && Math.abs(prev.y - r.y) < 0.5 && lines.length;
          if (sameLine) lines[lines.length - 1].push(r);
          else lines.push([r]);
          prev = r;
        }
      }
      // a block merges into one piece when each line is one run and all share style and left edge
      const single = lines.length > 1 && lines.every((runs) => runs.length === 1);
      const first = single ? lines[0][0] : null;
      const uniform =
        single &&
        lines.every(([r]) => r.fontName === first.fontName && Math.abs(r.size - first.size) < 0.01 &&
          r.color.every((v, i) => Math.abs(v - first.color[i]) < 0.004) && Math.abs(r.x - first.x) < 1);
      if (uniform) {
        const p = pieceOf(first);
        const steps = [];
        for (let i = 1; i < lines.length; i += 1) steps.push(lines[i][0].y - lines[i - 1][0].y);
        const step = steps.reduce((a, v) => a + v, 0) / steps.length;
        const regular = steps.every((s) => s > 0 && Math.abs(s - step) < first.size * 0.15);
        if (regular) {
          p.text = lines.map(([r]) => clean(r.text)).join("\n");
          p.lineHeight = step / first.size;
          p.rects = lines.map(([r]) => band(r));
          p.bbox = [
            Math.min(...lines.map(([r]) => r.x0)), Math.min(...lines.map(([r]) => r.y0)),
            Math.max(...lines.map(([r]) => r.x1)), Math.max(...lines.map(([r]) => r.y1)),
          ];
          pieces.push(p);
          continue;
        }
      }
      for (const runs of lines) {
        for (const r of runs) {
          const p = pieceOf(r);
          // a line alone on its row and centred on the page stays centred when its text changes
          const cx = (r.x0 + r.x1) / 2;
          if (runs.length === 1 && Math.abs(cx - pageWidth / 2) < 1.5 && r.x0 > pageWidth * 0.12 && r.x1 - r.x0 < pageWidth * 0.8) {
            p.align = "center";
            p.x = cx;
          }
          pieces.push(p);
        }
      }
    }
    return pieces;
  }

  /* ---------- writing objects into a page ---------- */

  function ensureDict(doc, parent, key) {
    let d = parent.get(key);
    if (d.isNull() || !d.isDictionary()) {
      d = doc.newDictionary();
      parent.put(key, d);
      d = parent.get(key);
    }
    return d;
  }

  function hexGlyphs(gids) {
    let s = "";
    for (const g of gids) s += g.toString(16).padStart(4, "0");
    return s;
  }

  /** Bezier circle constant. */
  const K = 0.5522847498;

  function ellipsePath(x, y, w, h) {
    const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
    const ox = rx * K, oy = ry * K;
    return [
      `${num(cx + rx)} ${num(cy)} m`,
      `${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
      `${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)} c`,
      `${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
      `${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)} c`,
      "h",
    ].join("\n");
  }

  const rgbOp = (c, op) => `${num(clamp01(c[0]))} ${num(clamp01(c[1]))} ${num(clamp01(c[2]))} ${op}`;

  /**
   * Writes `objects` (in their order: the last one is on top) into page `index` of `doc`.
   * `doc` must be a fresh copy when objects were baked into it before.
   * Returns the characters that no font could write, if any.
   */
  function bake(doc, index, objects, state = {}) {
    const page = doc.loadPage(index);
    const pageObj = page.getObject();
    const missing = new Set();
    state.fontRefs ||= new Map();
    state.imageRefs ||= new Map();

    // 1. remove what is replaced: text under `redact`, text and pictures under an eraser
    let redactions = 0;
    for (const o of objects) {
      const rects = o.type === "erase" ? [[o.x, o.y, o.x + o.w, o.y + o.h]] : o.redact || [];
      for (const r of rects) {
        const a = page.createAnnotation("Redact");
        a.setRect(r);
        redactions += 1;
      }
    }
    if (redactions) page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);

    // 2. resources
    // The page gets Resources of its own: a copy of what it has or inherits, the three dictionaries
    // that get new entries (Font, XObject, ExtGState) copied too. Pages very often share one
    // Resources dictionary, or its Font dictionary, and what is added here belongs to this page only.
    const source = pageObj.getInheritable("Resources");
    const copy = doc.newDictionary();
    if (!source.isNull()) {
      source.forEach((v, k) => {
        if (["Font", "XObject", "ExtGState"].includes(k) && v.isDictionary()) {
          const inner = doc.newDictionary();
          v.forEach((vv, kk) => inner.put(kk, vv));
          copy.put(k, inner);
        } else copy.put(k, v);
      });
    }
    pageObj.put("Resources", copy);
    const res = pageObj.get("Resources");
    const fontDict = () => ensureDict(doc, res, "Font");
    const xobjDict = () => ensureDict(doc, res, "XObject");
    const gsDict = () => ensureDict(doc, res, "ExtGState");
    // a name the dictionary does not use yet: a file edited here before already has "HoshF…"
    // entries, and reusing one would silently swap the font of the text that is already there
    let seq = 0;
    const freeName = (dict, prefix) => {
      for (;;) {
        const name = `${prefix}${(seq += 1)}`;
        if (dict.get(name).isNull()) return name;
      }
    };
    const fontNames = new Map();
    const useFont = (font) => {
      let name = fontNames.get(font);
      if (name) return name;
      let ref = state.fontRefs.get(font);
      if (!ref) {
        ref = doc.addFont(font);
        state.fontRefs.set(font, ref);
      }
      name = freeName(fontDict(), "HoshF");
      fontDict().put(name, ref);
      fontNames.set(font, name);
      return name;
    };
    const gsNames = new Map();
    const useAlpha = (alpha) => {
      const a = clamp01(alpha ?? 1);
      if (a >= 0.999) return "";
      const key = num(a);
      let name = gsNames.get(key);
      if (!name) {
        name = freeName(gsDict(), "HoshG");
        gsDict().put(name, { Type: "ExtGState", ca: a, CA: a });
        gsNames.set(key, name);
      }
      return `/${name} gs\n`;
    };

    // 3. content
    const out = [];
    const rotated = (o, body) => {
      if (!o.rotation) return body;
      const [x0, y0, x1, y1] = bounds(o);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const t = (o.rotation * Math.PI) / 180;
      const c = Math.cos(t), s = Math.sin(t);
      return `q ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(cx - c * cx + s * cy)} ${num(cy - s * cx - c * cy)} cm\n${body}\nQ`;
    };
    const paint = (o) => {
      const stroke = o.stroke && (o.strokeWidth ?? 1) > 0;
      const fill = !!o.fill;
      let s = useAlpha(o.opacity);
      if (stroke) {
        s += `${rgbOp(o.stroke, "RG")} ${num(o.strokeWidth ?? 1)} w\n`;
        if (o.dash) s += `[${num((o.strokeWidth ?? 1) * 3)} ${num((o.strokeWidth ?? 1) * 2)}] 0 d\n`;
      }
      if (fill) s += `${rgbOp(o.fill, "rg")}\n`;
      return { s, op: stroke && fill ? "B" : stroke ? "S" : fill ? "f" : "n" };
    };

    for (const o of objects) {
      switch (o.type) {
        case "text": {
          const lines = String(o.text || "").split("\n");
          if (!lines.some((l) => l.trim() !== "")) break;
          const leading = o.size * (o.lineHeight || 1.2);
          let body = `${useAlpha(o.opacity)}${rgbOp(o.color || [0, 0, 0], "rg")}\n`;
          const rules = [];
          lines.forEach((text, i) => {
            const shaped = shape(text, o.family, o.bold, o.italic);
            for (const ch of shaped.missing) missing.add(ch);
            const width = shaped.width * o.size;
            let x = o.align === "right" ? o.x - width : o.align === "center" ? o.x - width / 2 : o.x;
            const y = o.y + i * leading;
            const x0 = x;
            for (const run of shaped.runs) {
              body += `BT /${useFont(run.font)} ${num(o.size)} Tf 1 0 0 -1 ${num(x)} ${num(y)} Tm <${hexGlyphs(run.gids)}> Tj ET\n`;
              x += run.width * o.size;
            }
            const t = Math.max(0.5, o.size * 0.06);
            if (o.underline && width > 0) rules.push(`${num(x0)} ${num(y + o.size * 0.12)} ${num(width)} ${num(t)} re f`);
            if (o.strike && width > 0) rules.push(`${num(x0)} ${num(y - o.size * 0.3)} ${num(width)} ${num(t)} re f`);
          });
          out.push(rotated(o, `q\n${body}${rules.join("\n")}\nQ`));
          break;
        }
        case "rect":
        case "erase": {
          const shapeObj = o.type === "erase" ? { ...o, fill: o.fill || [1, 1, 1], stroke: null } : o;
          const p = paint(shapeObj);
          out.push(rotated(o, `q\n${p.s}${num(o.x)} ${num(o.y)} ${num(o.w)} ${num(o.h)} re ${p.op}\nQ`));
          break;
        }
        case "ellipse": {
          const p = paint(o);
          out.push(rotated(o, `q\n${p.s}${ellipsePath(o.x, o.y, o.w, o.h)}\n${p.op}\nQ`));
          break;
        }
        case "line":
        case "arrow": {
          const w = o.strokeWidth ?? 1;
          const p = paint({ ...o, fill: null, stroke: o.stroke || [0, 0, 0] });
          let s = `q\n${p.s}1 J\n${num(o.x1)} ${num(o.y1)} m ${num(o.x2)} ${num(o.y2)} l S\n`;
          if (o.type === "arrow") {
            const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
            const len = Math.max(6, w * 4);
            const pt = (da) => `${num(o.x2 - len * Math.cos(a + da))} ${num(o.y2 - len * Math.sin(a + da))}`;
            s += `${rgbOp(o.stroke || [0, 0, 0], "rg")}\n${num(o.x2)} ${num(o.y2)} m ${pt(0.45)} l ${pt(-0.45)} l h B\n`;
          }
          out.push(`${s}Q`);
          break;
        }
        case "ink": {
          const p = paint({ ...o, fill: null, stroke: o.stroke || [0, 0, 0] });
          let s = `q\n${p.s}1 J 1 j\n`;
          for (const stroke of o.strokes) {
            if (!stroke.length) continue;
            s += `${num(stroke[0][0])} ${num(stroke[0][1])} m\n`;
            if (stroke.length === 1) s += `${num(stroke[0][0] + 0.01)} ${num(stroke[0][1])} l\n`;
            for (let i = 1; i < stroke.length; i += 1) s += `${num(stroke[i][0])} ${num(stroke[i][1])} l\n`;
            s += "S\n";
          }
          out.push(`${s}Q`);
          break;
        }
        case "image": {
          let ref = state.imageRefs.get(o.imageId);
          if (!ref) {
            const bytes = state.images?.get(o.imageId);
            if (!bytes) break;
            const image = new mupdf.Image(bytes);
            ref = doc.addImage(image);
            image.destroy();
            state.imageRefs.set(o.imageId, ref);
          }
          const name = freeName(xobjDict(), "HoshI");
          xobjDict().put(name, ref);
          // the image square has its origin at the bottom left: flip it into y-down page space
          out.push(rotated(o, `q\n${useAlpha(o.opacity)}${num(o.w)} 0 0 ${num(-o.h)} ${num(o.x)} ${num(o.y + o.h)} cm /${name} Do\nQ`));
          break;
        }
        default:
          break;
      }
    }

    if (out.length) {
      // page space -> PDF space, and the page's own content isolated in q ... Q so that whatever
      // graphics state it leaves behind cannot move or tint what is added
      const inv = mupdf.Matrix.invert(page.getTransform());
      const mine = `\nQ\nq ${inv.map(num).join(" ")} cm\n${out.join("\n")}\nQ\n`;
      const contents = pageObj.get("Contents");
      const arr = doc.newArray();
      arr.push(doc.addStream("q\n", {}));
      if (contents.isArray()) contents.forEach((c) => arr.push(c));
      else if (!contents.isNull()) arr.push(contents);
      arr.push(doc.addStream(mine, {}));
      pageObj.put("Contents", arr);
    }
    page.destroy();
    return [...missing];
  }

  /**
   * The edited file: a fresh copy of `bytes` with every page's objects written in.
   * `pages` is an array (one entry per page) of object lists. Fonts are subset on the way out.
   */
  function exportPdf(bytes, pages, images) {
    const doc = open(bytes);
    const state = { images };
    const missing = new Set();
    try {
      pages.forEach((objects, i) => {
        if (objects && objects.length) for (const ch of bake(doc, i, objects, state)) missing.add(ch);
      });
      if (state.fontRefs && state.fontRefs.size) doc.subsetFonts();
      const buf = doc.saveToBuffer("garbage=compact,compress=yes");
      const data = new Uint8Array(buf.asUint8Array());
      buf.destroy();
      return { data, missing: [...missing] };
    } finally {
      doc.destroy();
    }
  }

  /** Pixels of one page with its objects written in (the preview). */
  function preview(bytes, index, objects, images, scale) {
    const doc = open(bytes);
    try {
      const missing = objects && objects.length ? bake(doc, index, objects, { images }) : [];
      return { ...render(doc, index, scale), missing };
    } finally {
      doc.destroy();
    }
  }

  /** Width and height of an image file, in pixels. */
  function imageSize(bytes) {
    const image = new mupdf.Image(bytes);
    const out = { width: image.getWidth(), height: image.getHeight() };
    image.destroy();
    return out;
  }

  return {
    registerFont, registerCustomFont, families, getFont, measure, missingGlyphs, bounds,
    open, pageSizes, render, extractText, bake, exportPdf, preview, imageSize,
  };
}

/** A text object that replaces a piece of existing text (see extractText). */
export function adoptPiece(piece, id) {
  const o = {
    id, type: "text", text: piece.text, x: piece.x, y: piece.y, size: piece.size,
    family: piece.family, bold: piece.bold, italic: piece.italic, color: piece.color,
    align: piece.align, lineHeight: piece.lineHeight, opacity: 1, underline: false, strike: false,
    redact: piece.rects, original: piece.text, fontName: piece.fontName, exactFont: piece.exactFont,
  };
  o.pristine = look(o);
  return o;
}

/** Everything of a text object that shows on the page. */
function look(o) {
  return JSON.stringify([o.text, o.x, o.y, o.size, o.family, !!o.bold, !!o.italic, o.color, o.align, o.lineHeight, o.opacity ?? 1, !!o.underline, !!o.strike, o.rotation || 0]);
}

/**
 * True for a text of the file that was clicked but not changed in any way (text, place, style).
 * Such an object is only a handle on the page's own text: it is never written to the file, so
 * clicking a text and leaving it leaves the PDF exactly as it was.
 */
export function isPristine(o) {
  return !!o.pristine && o.pristine === look(o);
}
