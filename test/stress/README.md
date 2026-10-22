# Stress survey

Measures the product path across real and generated decks. It reports; it does
not assert. The regression tests live in `test/` — these tools are what finds
the next one.

```bash
npm run serve:local                       # with RATE_MAX_CONVERSIONS / RATE_MAX_EXPORTS raised
node test/stress/build-corpus.mjs         # English, bilingual, ChatGPT-style, reveal.js, 130-slide giant + their PDFs
node test/stress/matrix.mjs               # hosted: PDF -> deck -> PPTX/PDF, HTML -> editor -> doctor -> fix all -> PDF
node test/stress/desktop-exports.cjs      # Electron: PDF + PowerPoint-verified PPTX (slow)
```

Extra local PDFs (never committed) can be listed one per line in
`.preview/stress-extra.txt`. Output: `.preview/stress-report.json`.

## What the first survey found (2026-10-22)

| Finding | Outcome |
|---|---|
| ChatGPT/reveal.js decks opened as ONE slide | Fixed: deck-shape sniffer in `importer.js` |
| «إصلاح الكل» deleted 101 of 130 slides as duplicates | Fixed: slide deletions are never part of fix-all |
| Fix-all reported «0 left», overflow appeared a second later | Fixed: re-scan waits for embedded fonts |
| Overflow fix stalled after one 7% step | Fixed: shrinks by what the slide needs |
| AI-typo font link `wght=400` never loaded | Fixed: repaired before embedding |
| No PowerPoint from HTML decks on the web | Fixed: `/api/export/pptx` accepts `html` |
| Import PDF then open HTML → PPTX exported the old PDF | Fixed: the load owns the model handle |
| Import summary overwritten by «جاهز» | Fixed in both apps |
| Scanned PDF imported silently as pictures | Fixed: the user is told |
| Arabic typography had no doctor rules | Added rules 22-26 |
| Mixed-direction fragments («(+0.1) كجم.») | Not a visible defect: painted order, displays as the source — see KNOWN_ISSUES |

## Strange inputs (2026-10-22)

`node test/stress/build-strange.mjs` then `node test/stress/strange-run.mjs`
(24 files: empty, renamed, truncated, password, 252-page, rotated, mixed
orientation, A0 poster, business card, annotated, emoji/Hebrew/Chinese/harakat
PDFs; windows-1256, UTF-16, empty, plain text, article, JS-built, mixed slide
sizes, remote/missing images, 11 MB image, 500 slides, media, fixed/animated).

| Finding | Outcome |
|---|---|
| Server errors in English inside the Arabic UI | Arabic messages + machine `code` |
| Password PDF imported as "21 scanned pages" | `PDF_ENCRYPTED` with what to do |
| Half-downloaded PDF "rebuilt" to 0 pages | `PDF_DAMAGED` |
| windows-1256 HTML opened as U+FFFD | decoded (BOM / meta / 1256 sniff), saved as UTF-8 |
| Empty / plain-text / article / JS-built HTML said «جاهز» with no slides | text and articles become slides; the others say why |
| Mixed slide sizes: 3 slides -> 5 PDF pages | larger slides fit the page; margins contained |
| Desktop PPTX refused any non-950x650 deck | verification at twice the deck's own size |
| HTML -> PPTX over 200 slides spoke of "PDF pages" | message speaks of slides |
