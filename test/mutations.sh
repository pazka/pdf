#!/bin/sh
# run the tests with one behaviour broken at a time; every line must say FAIL (the tests bite)
cp web/js/engine.js /tmp/engine.orig
try() {
  cp /tmp/engine.orig web/js/engine.js
  node -e '
    const fs=require("fs"); let s=fs.readFileSync("web/js/engine.js","utf8");
    const [a,b]=[process.argv[1],process.argv[2]];
    if(!s.includes(a)){console.log("NOT FOUND: "+a);process.exit(3)}
    fs.writeFileSync("web/js/engine.js",s.replace(a,b));' "$2" "$3" || return
  if node --test test/engine.test.js test/engine-files.test.js >/dev/null 2>&1; then echo "SURVIVED  $1"; else echo "killed    $1"; fi
}
try "freeName" 'if (dict.get(name).isNull()) return name;' 'return name;'
try "band -> taller" 'r.y - r.size * 0.72, r.x1, r.y + r.size * 0.02' 'r.y - r.size * 1.1, r.x1, r.y + r.size * 0.35'
try "image flipped" '${num(o.w)} 0 0 ${num(-o.h)} ${num(o.x)} ${num(o.y + o.h)} cm' '${num(o.w)} 0 0 ${num(o.h)} ${num(o.x)} ${num(o.y)} cm'
try "no arrow head" 'if (o.type === "arrow") {' 'if (o.type === "arrowX") {'
try "eraser no cover" 'const shapeObj = o.type === "erase" ? { ...o, fill: o.fill || [1, 1, 1], stroke: null } : o;' 'if (o.type === "erase") break; const shapeObj = o;'
try "no fallback" 'if (!gid && fallback !== main) {' 'if (false) {'
try "no leading q" 'arr.push(doc.addStream("q\n", {}));' ''
try "no strike" 'if (o.strike && width > 0)' 'if (false)'
try "no dash" 'if (o.dash) s +=' 'if (false) s +='
try "no rotation" 'if (!o.rotation) return body;' 'return body;'
try "resources not copied" 'pageObj.put("Resources", copy);
    const res = pageObj.get("Resources");' 'const res = source;'
try "no run joining" 'if (joins) {' 'if (false) {'
try "underline off" 'if (o.underline && width > 0)' 'if (false)'
try "opacity off" 'if (a >= 0.999) return "";' 'return "";'
try "align ignored" 'let x = o.align === "right" ? o.x - width : o.align === "center" ? o.x - width / 2 : o.x;' 'let x = o.x;'
try "serif flag first" 'if (/helvetica|arial|nimbussans|liberationsans/.test(lower)) return { family: "Helvetica", bold, italic, exact: true };' 'if (flags.serif) return { family: "Times", bold, italic, exact: true };'
try "centre not detected" 'p.align = "center";' 'p.align = "left";'
try "subset off" 'if (state.fontRefs && state.fontRefs.size) doc.subsetFonts();' ''
cp /tmp/engine.orig web/js/engine.js
