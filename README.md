# Lecture Visual Editor

A PowerPoint-style desktop editor for HTML lectures. Open any lecture `.html`, edit it visually — no code — and export a pixel-perfect PDF.

Built for Arabic RTL slide-deck lectures, works with any HTML document.

## Run

```bash
npm install      # first time only
npm start
```

## Features

### Editing
- **Renders exactly like the browser** (Chromium engine)
- **Click anything to select it** — paragraphs, headings, images, tables, placeholders, footers, whole slides
- **Delete anything** — toolbar 🗑 or the `Del` key
- **⬆ Container** — climb up to select the parent box (up to the whole slide)
- **Double-click any text to edit it** — typed text inherits the lecture's own fonts; B/I/U formatting bar (Ctrl+B/I/U)
- **Undo / Redo** everything (Ctrl+Z / Ctrl+Y), **Ctrl+S** saves

### Insert
- **+ Text** — click where you want it; the new paragraph uses the document's own styling
- **─ Line** — divider, auto-colored from the lecture's theme
- **⊞ Table** — inherits the document's table design; +Row / +Col / −Row / −Col from the toolbar
- **Images** — drag from the asset panel; a blue line shows the landing spot
- **Drop onto a dashed placeholder** — the image replaces it and fills its exact reserved space
- **⧉ Duplicate slide** — one click

### Images
- **8 resize handles**: corners keep proportions, edges stretch freely to fill space
- Align left / center / right, Replace, Delete

### Colors
- 🎨 text color / 🖌 fill color for any element
- Palette is built from the lecture's own CSS theme colors + custom picker

### PDF export
- **Slide decks auto-detected** → each slide becomes exactly one full-bleed PDF page (no A4 slicing, no gray gutters)
- Waits for web fonts and images before printing
- Regular documents export on A4 with sensible margins

Original files are never modified — Save/Export always write output you choose.

## Architecture

| File | Role |
|------|------|
| `src/main.js` | Electron main: dialogs, PDF engine (`printToPDF`, slide-page sizing) |
| `src/preload.js` | Secure IPC bridge |
| `src/index.html` / `styles.css` | App shell |
| `src/renderer.js` | Toolbar logic, asset panel, cross-frame drag, slide detection |
| `src/editor.js` | Selection, resize, text editing, colors, tables, slides, undo/redo |

The lecture loads into a same-origin iframe sized to its content; the editor manipulates that DOM directly. Cross-frame drags use pointer capture + `pointer-events:none` on the frame. Export strips all editor artifacts.

## Testing

Automated end-to-end tests drive the real app with trusted mouse/keyboard input via `playwright-core` (`_electron.launch`). Env hooks: `LVE_OPEN=<file>` auto-opens a lecture, `LVE_EXPORT_PATH=<file>` bypasses the PDF save dialog.

## Roadmap (SaaS direction)

- Free-floating positioning + snap guides
- Zoom controls
- Project files (edits-as-diff, source untouched)
- Templates, AI image generation, charts from tables
- Web version (the editor core is plain DOM — portable to a browser backend)
