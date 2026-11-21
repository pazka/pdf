#!/bin/sh
# Runs the engine tests with one behaviour of web/js/engine.js broken at a time. Every line must say
# "killed": a line that says SURVIVED is a behaviour no test protects, NOT FOUND a mutation to update.
#   sh test/mutations.sh        (inside the Node container, after npm ci; restores engine.js at the end)
cp web/js/engine.js /tmp/engine.orig
try() {
  cp /tmp/engine.orig web/js/engine.js
  node -e '
    const fs=require("fs"); let s=fs.readFileSync("web/js/engine.js","utf8");
    const [a,b]=[process.argv[1],process.argv[2]];
    if(!s.includes(a)){console.log("NOT FOUND "+process.argv[3]);process.exit(3)}
    fs.writeFileSync("web/js/engine.js",s.replace(a,b));' "$2" "$3" "$1" || return
  if node --test test/engine.test.js test/engine-files.test.js test/engine-keeps.test.js >/dev/null 2>&1; then echo "SURVIVED  $1"; else echo "killed    $1"; fi
}
try "font resource name reused" 'if (dict.get(name).isNull()) return name;' 'return name;'
try "band -> line box" 'r.y - r.size * 0.55, r.x1, r.y - r.size * 0.15' 'r.y - r.size * 1.1, r.x1, r.y + r.size * 0.35'
try "band -> down to the baseline" 'r.y - r.size * 0.55, r.x1, r.y - r.size * 0.15' 'r.y - r.size * 0.72, r.x1, r.y + r.size * 0.02'
try "band -> nothing removed" 'r.y - r.size * 0.55, r.x1, r.y - r.size * 0.15' 'r.y + r.size * 2, r.x1, r.y + r.size * 2.1'
try "image flipped" '${num(o.w)} 0 0 ${num(-o.h)} ${num(o.x)} ${num(o.y + o.h)} cm' '${num(o.w)} 0 0 ${num(o.h)} ${num(o.x)} ${num(o.y)} cm'
try "image opacity ignored" '${useAlpha(o.opacity)}${num(o.w)} 0 0' '${num(o.w)} 0 0'
try "no arrow head" 'if (o.type === "arrow") {' 'if (o.type === "arrowX") {'
try "arrow head not in its colour" '${rgbOp(o.stroke || [0, 0, 0], "rg")}' '0 0 0 rg'
try "eraser does not cover" 'const shapeObj = o.type === "erase" ? { ...o, fill: o.fill || [1, 1, 1], stroke: null } : o;' 'if (o.type === "erase") break; const shapeObj = o;'
try "no fallback font" 'if (!gid && fallback !== main) {' 'if (false) {'
try "page content not closed in q" 'arr.push(doc.addStream("q\n", {}));' ''
try "no strikethrough" 'if (o.strike && width > 0)' 'if (false)'
try "no underline" 'if (o.underline && width > 0)' 'if (false)'
try "no dash" 'if (o.dash) s +=' 'if (false) s +='
try "line width ignored" '${num(o.strokeWidth ?? 1)} w' '1 w'
try "no rotation" 'if (!o.rotation) return body;' 'return body;'
try "shape opacity ignored" 'if (a >= 0.999) return "";' 'return "";'
try "text opacity ignored" '`${useAlpha(o.opacity)}${rgbOp(o.color || [0, 0, 0], "rg")}' '`${rgbOp(o.color || [0, 0, 0], "rg")}'
try "alignment ignored" 'let x = o.align === "right" ? o.x - width : o.align === "center" ? o.x - width / 2 : o.x;' 'let x = o.x;'
try "page Resources not copied" 'pageObj.put("Resources", copy);' 'pageObj.put("Resources", source);'
try "runs on one baseline not joined" 'if (joins) {' 'if (false) {'
try "font flags before the name" 'if (/helvetica|arial|nimbussans|liberationsans/.test(lower)) return { family: "Helvetica", bold, italic, exact: true };' 'if (flags.serif) return { family: "Times", bold, italic, exact: true };'
try "centred text not detected" 'p.align = "center";' 'p.align = "left";'
try "an edit removes the pictures under it" 'mupdf.PDFPage.REDACT_IMAGE_NONE' 'mupdf.PDFPage.REDACT_IMAGE_REMOVE'
try "an edit removes the drawings it touches" 'mupdf.PDFPage.REDACT_LINE_ART_NONE' 'mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED'
try "an edit removes the drawings it covers" 'mupdf.PDFPage.REDACT_LINE_ART_NONE' 'mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED'
try "stroke opacity ignored" 'ca: a, CA: a' 'ca: a'
try "fill opacity ignored" 'ca: a, CA: a' 'CA: a'
try "rotated text offered for editing" 'if (!l.horizontal) continue;' ''
try "eraser gets an outline" '{ ...o, fill: o.fill || [1, 1, 1], stroke: null }' '{ ...o, fill: o.fill || [1, 1, 1] }'
try "line of width 0 drawn with the default pen" 'if (!(w > 0)) break;' ''
try "drawing of width 0 drawn with the default pen" 'if (!((o.strokeWidth ?? 1) > 0)) break;' ''
try "fonts not subset" 'if (state.fontRefs && state.fontRefs.size) doc.subsetFonts();' ''
cp /tmp/engine.orig web/js/engine.js
