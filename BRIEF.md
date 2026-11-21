# pdf.hosh.it: brief

Owner request (2026-11-21, condensed): a new application on hosh.it, **pdf.hosh.it**, a PDF editor
"that can allow me to simply change the text inside a pdf and save it afterwards, also add shapes,
images (png with transparent images for example) and write new text with various font and colors".
The interface may look like iLovePDF's editor. The test case is an invoice whose title must go from
"Facture brouillon DE26-003" to "Devis DE26-003". All the editing features of iLovePDF's Edit PDF
tool are wanted in the end; **the priority for V1 is editing the text of the PDF.**

Decisions taken with the owner the same day:
- Engine: **MuPDF.js, in the browser only**. Nothing is uploaded, so the site is public and needs no
  login or upload protection.
- The embedded fonts of a PDF are subsets and cannot write new letters: the app ships its own open
  font copies and matches them by name (Lato first: it is the font of the owner's invoices).

## What V1 does
| Area | In V1 |
|---|---|
| Existing text | click a text to edit it in place; the old glyphs are removed from the file; same font (when shipped or standard), size, colour, position, centring; paragraphs edited as paragraphs; move it, restyle it, delete it |
| New text | Text tool; font family (Lato, Helvetica, Times, Courier, or any TTF/OTF file the visitor adds), size, bold, italic, underline, strikethrough, alignment, colour, opacity, multi-line |
| Images | PNG (transparency kept) and JPEG; file picker, drag and drop, paste; move, resize with the proportions kept, opacity |
| Shapes | rectangle, ellipse, line, arrow; border colour and width, dashed, fill colour, opacity |
| Drawing | freehand pencil, colour and thickness |
| Eraser | drag over an area: the text under it is removed from the file, the area is covered |
| Objects | select, move (mouse, arrow keys), resize, duplicate, copy and paste, delete, bring to front, send to back |
| View | page thumbnails, zoom (buttons, Ctrl+wheel, fit to width), several pages |
| History | undo and redo of every change |
| File | open (picker or drop), download the edited PDF (fonts subset), warning before leaving with unsaved changes |

## iLovePDF "Edit PDF" inventory and where each feature stands
Sources read on 2026-11-21: ilovepdf.com/edit-pdf, its blog articles "How to edit a PDF" and
"New advanced PDF editing", and the owner's screenshots of the editor.

| iLovePDF feature | Here |
|---|---|
| Edit existing text (content editor): font, size, colour, formatting | **V1** |
| Move and delete existing text | **V1** (a text becomes an object once clicked) |
| Add text: move, resize, font style and colour | **V1** |
| Insert images, resize, reposition | **V1** |
| Rotate an image or an object | later (the engine already writes a `rotation`; no handle yet) |
| Shapes: lines, rectangles, ellipses; fill, border, size, transparency | **V1** (plus arrows) |
| Freehand drawing, colours and thickness | **V1** |
| Bring to front / send to back, align and move precisely | **V1** (front/back, arrow-key nudging); alignment guides later |
| Copy, paste, delete, multi-select | **V1** except multi-select (later) |
| Undo / redo | **V1** |
| Thumbnails, zoom, scroll through pages | **V1** |
| Hyperlinks on text or images | later |
| Highlight, underline, strikeout, squiggly on existing text; freehand highlighter | later (V1 has underline and strikethrough on text objects only) |
| Comments / sticky notes | later |
| Emojis and symbols | later (needs a colour emoji font: a dependency to approve) |
| Move, resize, replace the images already in the PDF | later |
| Form fields: text box, checkbox, radio, list, signature field | later |
| Bookmarks, attachments, certificate properties | later |
| Pages: add blank, reorder, rotate, delete | later |
| Search in the document | later |
| Save to Google Drive / Dropbox | not planned (the file stays on the device; a cloud save would need accounts and third-party requests) |

## Known limits of V1 (written so nobody is surprised)
- Text is edited per piece (a line, or a paragraph whose lines share one style and one left edge).
  Text does not reflow: a longer line gets longer, line breaks are the ones typed.
- A line that mixes styles (a bold word in a regular sentence) is several pieces.
- Rotated or vertical text is not editable yet.
- A font that is neither shipped nor standard is replaced by the closest standard font; the panel
  says so and accepts the font file to restore the exact look.
- Password-protected PDFs are refused.
- Characters that no available font has (emoji, CJK) are written as "?" and reported.
