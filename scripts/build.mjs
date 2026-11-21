// Builds dist/: the editor (web/) plus MuPDF.js copied from node_modules (no bundler: the browser
// loads the ES modules as they are). Run by `npm run build`, in the Dockerfile and in CI.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = `${root}dist/`;
const mupdf = `${root}node_modules/mupdf/`;

await rm(dist, { recursive: true, force: true });
await cp(`${root}web/`, dist, { recursive: true });
await mkdir(`${dist}vendor/mupdf`, { recursive: true });
for (const f of ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"]) await cp(`${mupdf}dist/${f}`, `${dist}vendor/mupdf/${f}`);
// AGPL: the licence travels with the library, and the page says where the source is
await cp(`${mupdf}LICENSE`, `${dist}vendor/mupdf/LICENSE.txt`);
const version = JSON.parse(await readFile(`${mupdf}package.json`, "utf8")).version;
await writeFile(`${dist}vendor/mupdf/version.json`, JSON.stringify({ name: "mupdf", version }));
console.log(`dist/ built (mupdf ${version})`);
