# pdf

https://pdf.hosh.it: edit a PDF in the browser. Change the text that is already in the file, add
text, images and shapes, download the result. **The file never leaves your device**: the editor is
[MuPDF.js](https://mupdf.readthedocs.io/) running in the page, and the server only serves static files.

See `BRIEF.md` (what it does and the roadmap), `TESTING.md` (tests and visual use cases),
`DEPLOY.md` (deployment), `docs/BOX-CONTRACT.md` (box rules), `CLAUDE.md` (rules for agents).

## Use
1. Open a PDF (button or drop).
2. **Edit** tool: click a text of the page and type. The old text is removed from the file, the new
   one is written in the same font. Drag a text or an object to move it.
3. **Text**, **Image**, **Rectangle**, **Ellipse**, **Line**, **Arrow**, **Draw**, **Erase**: add things.
   The panel on the right sets font, size, colours, opacity and order.
4. **Download PDF**.

Keys: `Ctrl+Z` / `Ctrl+Y` undo and redo, `Del` delete, arrows move (with `Shift`: 10 points),
`Ctrl+D` duplicate, `Ctrl+C` / `Ctrl+V` copy and paste, `Enter` edit the selected text, `Esc` end the
edit, `Ctrl+S` download, `Ctrl+wheel` zoom, `V T R O L A D E` pick a tool.

## Develop
Node 26. Nothing but `mupdf` is installed, without install scripts (`.npmrc`).

```sh
npm ci --no-audit
npm run build      # web/ + MuPDF.js -> dist/
npm test           # engine (on real PDFs), server, log format
npm start          # http://localhost:8000
```

There is no bundler: `web/` is served as it is, and `web/js/engine.js` (the edit engine) runs
unchanged in Node, which is how it is tested.

## Licence
AGPL-3.0-or-later, as MuPDF requires of a program that uses it over a network. The source of what
runs on pdf.hosh.it is this repository at the released tag (`/healthz` gives the version); MuPDF's
licence is served at `/vendor/mupdf/LICENSE.txt`. The Lato fonts in `web/fonts/` are under the SIL
Open Font License (`web/fonts/OFL.txt`), taken from google/fonts at commit
`15e8fc68b03a0214ace8b52ca0153e1b597345ec` (`web/fonts/SHA256SUMS`).
