# Testing pdf

Three layers. All run in CI on every PR (`.github/workflows/ci.yml`); a red layer blocks the image.

| Layer | Command | Proves |
|---|---|---|
| Unit | `npm test` (after `npm run build`) | the edit engine on real PDFs, the static server, the log format |
| Container | CI job `image` | Trivy gate, patched Node, hardened container, `server/smoke.js` capability checks |
| Visual | `bash visual/run.sh <image>` | every use case below in a real Chrome, at 3 widths, against baselines |

On the owner's laptop nothing is installed on the host: run the first two inside the pinned Node
image (`docker run --rm -v "$PWD:/src" -w /src node:26.13.1-trixie-slim … npm ci && npm run build && npm test`).

## Unit tests (`test/`)
- `engine.test.js`: `web/js/engine.js` through MuPDF, the same code the browser runs. Every test
  reads the result **back from the written PDF** (text extraction, rendered pixels), never from the
  objects it passed in:
  - a text of the file comes back as an editable piece with its font, size, colour, centring; a
    paragraph is one piece with its line spacing;
  - changing a text: the old words can no longer be extracted from the file, the new ones are
    there, same font, size, colour, baseline and centre, every other text untouched;
  - the lines right above and below an edited line stay;
  - new text: font, bold, italic, colour, alignment, underline (a pixel of it);
  - a character the font lacks falls back to Helvetica; one nobody has is reported;
  - shapes, opacity, freehand: pixels at known places; an image keeps its transparency and is not flipped;
  - the eraser removes the text under it from the file;
  - the opened bytes are never modified; the preview equals the saved page; the saved file embeds
    only the glyphs it uses;
  - a rotated page and a page that leaves a dirty graphics state: objects still land where asked;
  - font matching by name (`matchFont`): the name wins over the flags of the file.
- `engine-files.test.js`: the engine against the kinds of PDF other programs write and against its
  own output opened again: every family and style read back as written; edit, save, reopen, edit
  again keeps the font; a file written by the editor then edited with another font keeps the fonts
  of the texts already there; lines set tight keep their neighbours down to 0.85 of the font size
  (standard Helvetica, Times, Courier; embedded Lato, Helvetica, Times, Courier); words split on one baseline are one piece; grey and CMYK colours; pages
  that inherit or share their Resources; the q ... Q wrapping; a font file added by the visitor; a
  font the editor does not have; a text clicked and not changed is not an edit (`isPristine`); a
  password-protected file.
- `test/mutations.sh` breaks the engine one behaviour at a time (24 mutations: font name reuse,
  the redaction band three ways, image flipped, image / text / shape opacity, arrow head and its
  colour, eraser cover, fallback font, q wrapping, strikethrough, underline, dash, line width,
  rotation, alignment, Resources copy, run joining, font flags, centring, subsetting): each one must
  make a test fail. Run it, and add a line to it, when adding a behaviour to the engine.
- `server.test.js`: `/healthz` (engine and fonts present), strict CSP, WebAssembly and font content
  types, revalidation, brotli, no dotfile / traversal / listing, read-only methods.
- `log.test.js`: the JSON log lines (startup, errors, request lines) and that no path or query
  string ever reaches a log.

`test/fixture.mjs` builds the only PDFs of the repo: `visual/fixture.pdf`, an invented two-page
invoice written with the engine itself (Lato title, address, table, a paragraph; Times, Courier,
Helvetica and a font renamed to one the editor does not have on page 2), fonts subset as in a real
file, and `visual/protected.pdf`, the same file protected by a password. `node test/fixture.mjs --check` (CI) fails when the committed
file is not what the code builds; `--write` rewrites it. **Never commit a real document.**

## Container smoke (`server/smoke.js`)
The argv hosh-deploy runs after every deploy (`POST_DEPLOY`), also run in CI inside the hardened
container: health, page and CSP, scripts and style (brotli, revalidated), the MuPDF WebAssembly
module (content type, size, magic bytes) and the fonts, no dotfile or source, read-only server.

## Visual use cases
Harness: `visual/` (`run.sh` starts the image hardened, `shoot.mjs` drives the runner's Chrome over
the DevTools protocol with Node built-ins only, `cases.mjs` holds the cases). Every case runs in a
fresh browser profile at **1400, 1024 and 390 px**, with real mouse and keyboard events, and checks
what it did before the shot is taken. Baselines: `visual/baseline/` (`chrome.txt` names the Chrome
that made them). A wanted visual change is announced in the PR, which updates the baselines
(`bash visual/run.sh <image> --update`, or from the CI log with `node visual/from-log.mjs`).

| Id | Use case | How it is reached | Also checked |
|---|---|---|---|
| E1-empty | first visit, no file (light and dark) | open `/` | the editor started (engine and fonts loaded) |
| E2-not-a-pdf | a file that is not a PDF | give a text file to "Open PDF" | error message, start screen kept |
| E3-protected | a PDF protected by a password | give `visual/protected.pdf` | message naming the password, start screen kept, Download disabled |
| E4-could-not-start | the PDF engine cannot load | block the WebAssembly file, reload | the page says so, both Open buttons disabled |
| E5-drag-over | a file dragged over the window | `dragenter` | the drop area is outlined |
| D1-opened | a PDF opened, Edit tool | open the fixture | the texts of the page are boxed |
| D2-text-box-open | a text of the file being edited | click the title | the box holds the text of the file, in Lato |
| D3-text-changed | the title changed (light and dark) | type "Devis F-001", Esc | one selected text object, undo enabled, panel shows Lato |
| D4-text-added | a new text, styled from the panel | Text tool, click, type, then bold, size 22, red, right aligned, Times | Edit tool is back, the text grew with its size, right alignment kept its right edge, font applied |
| D5-shapes | rectangle (filled, dashed, 60 %), ellipse, freehand, arrow | each tool, drag on the page | four objects, arrow selected with two end handles, a click without a drag draws nothing |
| D6-image | an image with transparency, resized | give a PNG to "Image", drag a corner | proportions kept; a file that is not an image is refused with a message |
| D7-erased | an area erased | Erase tool, drag over the date | the area is an eraser object |
| D8-saved-reopened | the round trip | change the title, Download, open the downloaded file | its only title is "Devis F-001", no pending edit |
| D9-existing-text-moved | a text of the file made bold and moved without retyping it | click the title, Esc, Bold, drag; Download, reopen | click + Esc + click elsewhere changes nothing (no object, undo disabled); the saved file has the title once, at the new place, bold Lato |
| D10-undo-redo | undo and redo | change the title, draw a rectangle, undo button, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z | object counts at each step, the title is the file's own again after undo, a new change clears redo |
| D11-objects | objects moved, resized, ordered | draw, drag, drag a handle, arrow keys, Duplicate, Ctrl+C / paste, Ctrl+D, To back, To front, Del, undo, redo | position and size in points after each step, order of the objects, counts |
| D12-existing-text-deleted | a text of the file deleted | click the title, Esc, Delete; Download, reopen | the title is not in the saved file, the other texts are |
| D13-font-note | page 2, a text in a font the editor does not have | click "Police inconnue", Esc | the note names the font of the file and the replacement; a Helvetica text has no note and stays Helvetica; selecting texts is not an edit |
| D14-font-added | a font file added by the visitor | change the title, give a TTF to "Add a font file" | it joins the font list, is applied (the text changes width), message; an unreadable file is refused |
| D15-missing-characters | characters no font has | Text tool, type an emoji | the message that lists them |
| D16-zoomed-page-2 | zoom and second page | zoom in twice, out, fit, in; thumbnail 2 | page width follows the zoom, fit returns to the first zoom, thumbnail 2 is current |
| D17-keys-and-inputs | keys, panel inputs and gestures that change what is saved | tool keys V T R O L A D E; a line set to 8 wide and red; the eraser's colour; Shift-resize; the corner handle of a text; Ctrl+B / I / U; Enter; an image dropped on the page; Ctrl+S | each tool key picks its tool; the page's pixels show the width, the colour and the eraser colour; proportions kept; text size follows the handle; the image lands where it is dropped; Ctrl+S writes the file |
| T1-text-tool | panel of the Text tool before any text | pick Text | title, default font, no object buttons |
| T2-shape-tool | panel of the Rectangle tool | pick Rectangle | line and fill rows, no text rows |
| T3-erase-tool | panel of the Eraser | pick Erase | cover colour only |

These cases are also the tests of the editor itself (`web/js/app.js` has no other test): each one
fails on a wrong state before any picture is compared.

Not covered by a shot (covered by unit tests instead): each property of each object, since the page
canvas is drawn by the engine and the engine's pixels are asserted in `engine.test.js`. Not covered
at all yet: touch gestures on a real phone, the drop of a real PDF from the desktop (the outline
and the drop of an image are), paste of an image from the clipboard, the end handles of a line and
the handles of an ellipse, `Ctrl+wheel`, `Ctrl+O`, `Esc` to deselect, the question asked before a
second file replaces unsaved changes, the warning before leaving the page with unsaved changes.

## Logs
JSON lines on stdout (hosh-management AGENTS.md section 11): `ts`, `level`, `service` ("pdf"),
`version`, `event`, `msg`. One `startup` line (port, static files, config names) and one `shutdown`
line. Requests are not logged at info: only a 5xx, a slow answer; `/healthz` at debug only. The
server never sees a PDF, so no document content can reach a log. `APP_LOG_LEVEL` (or `LOG_LEVEL`),
default `info`.
