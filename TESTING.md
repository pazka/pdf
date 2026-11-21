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
  - font matching by name (`matchFont`).
- `server.test.js`: `/healthz` (engine and fonts present), strict CSP, WebAssembly and font content
  types, revalidation, brotli, no dotfile / traversal / listing, read-only methods.
- `log.test.js`: the JSON log lines (startup, errors, request lines) and that no path or query
  string ever reaches a log.

`test/fixture.mjs` builds the only PDF of the repo, `visual/fixture.pdf`: an invented two-page
invoice written with the engine itself (Lato title, address, table, a paragraph; Times and Courier on
page 2), fonts subset as in a real file. `node test/fixture.mjs --check` (CI) fails when the committed
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
| D1-opened | a PDF opened, Edit tool | open the fixture | the texts of the page are boxed |
| D2-text-box-open | a text of the file being edited | click the title | the box holds the text of the file, in Lato |
| D3-text-changed | the title changed (light and dark) | type "Devis F-001", Esc | the edit is one selected text object, undo is enabled, the panel shows Lato |
| D4-text-added | a new text, styled from the panel | Text tool, click, type, then bold, size 22, red | the panel applied the style |
| D5-shapes | rectangle, ellipse, freehand, arrow | each tool, drag on the page | four objects, the arrow selected with its two end handles |
| D6-image | an image with transparency | give a PNG to "Image" | selected, four handles |
| D7-erased | an area erased | Erase tool, drag over the date | the area is an eraser object |
| D8-saved-reopened | the round trip | change the title, Download, open the downloaded file | the saved file opens, its only title is "Devis F-001", no pending edit |

Not covered by a shot (covered by unit tests instead): each property of each object, since the page
canvas is drawn by the engine and the engine's pixels are asserted in `engine.test.js`. Not covered
at all yet: touch gestures on a real phone, drag and drop of a file from the desktop, paste of an image.

## Logs
JSON lines on stdout (hosh-management AGENTS.md section 11): `ts`, `level`, `service` ("pdf"),
`version`, `event`, `msg`. One `startup` line (port, static files, config names) and one `shutdown`
line. Requests are not logged at info: only a 5xx, a slow answer; `/healthz` at debug only. The
server never sees a PDF, so no document content can reach a log. `APP_LOG_LEVEL` (or `LOG_LEVEL`),
default `info`.
