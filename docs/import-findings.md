# Import spike findings (mission 010A)

**Note on source files:** `C:\Users\mosun\Downloads\lecs\` contained no real teacher `.docx`
files at the time of this spike (only `.html`/`.pdf`). Per the user's decision, this spike
runs against **3 synthetic `.docx` files** generated with `python-docx`, deliberately
covering the three structural cases most likely in real teacher documents: proper Word
heading styles, bold-text-only "fake headings" (no real styles), and Arabic RTL content.
The synthetic files are NOT committed to the repo (test-only, left in `Downloads\lecs\` as
`synthetic-test-*.docx`); when real teacher `.docx` files become available, re-run
`web/import-spike.html` against them and amend this doc if anything disagrees.

## Per-file results

### 1. synthetic-test-1-headings.docx (proper Word Heading 1/Heading 2 styles)
- Tag histogram: `h1:2, h2:3, p:16, ul:1, li:4, table:1, tr:4, td:12, img:1`
- Images: 1, arrives as a **data URL** (mammoth embeds images inline by default).
- Table: converted to a clean, usable HTML `<table>` — no garbling.
- Headings: present and sensible — `Heading 1` → `<h1>`, `Heading 2` → `<h2>`, in document order.
- List nesting: a flat bullet list converted cleanly to `<ul><li>`.
- RTL/Arabic: n/a (English content).
- Mammoth warnings: none.

### 2. synthetic-test-2-noheadings.docx (bold/larger text only, no Word heading styles)
- Tag histogram: `p:9, img:1` — **zero h1/h2/h3, despite the document visually having two "section titles"** (bold, 20pt and 16pt runs).
- Images: 1, data URL.
- Table/lists: none in this file.
- Headings: **none detected.** Mammoth (correctly, per its design) only promotes paragraphs using real Word paragraph styles (`Heading 1`, `Heading 2`, ...) to `<hN>` — manually bolded/enlarged text stays a plain `<p>`.
- Mammoth warnings: none (mammoth doesn't warn about this — it's expected behavior, not an error).

### 3. synthetic-test-3-arabic.docx (Arabic RTL, headings + table + list)
- Tag histogram: `h1:1, h2:2, p:7, ul:1, li:3, table:1, tr:3, td:6`
- Images: 0 (none in this file, by design).
- Table: converted cleanly, Arabic cell text intact.
- List: bullet list converted to `<ul><li>`, Arabic text intact.
- RTL/Arabic: **text and encoding preserved correctly** — no mojibake, no character loss. Mammoth's output HTML has no `dir`/`lang` attributes of its own (it emits bare `<p>`/`<h1>` with no directionality markup) — RTL rendering in the spike page comes only from the wrapping `<div dir="auto">`, not from mammoth's output. **The importer must apply `dir="rtl" lang="ar"` itself** when building the final deck document; mammoth does not carry it over from the source `.docx`.
- Mammoth warnings: none.

## Cross-cutting answers

**(a) Do teacher docs use real Word Heading styles, or just bold big text?**
Confirmed both are real possibilities: a properly-styled doc (`Heading 1/2`) converts perfectly to `<hN>`; a doc using only bold/larger inline runs as visual "headings" produces **zero** `<hN>` tags — everything flattens to `<p>`. **010B needs a fallback split rule for the no-headings case** (see recommendation below).

**(b) How do images arrive?**
As **data URLs**, embedded inline in the `<img src="data:...">` — exactly what mission 010B needs for portability (no external/local file refs). Confirmed with real image bytes in both English test files.

**(c) List nesting fidelity.**
Flat bullet lists (`List Bullet` style) convert cleanly to `<ul><li>`. Not tested here: multi-level nested lists — worth a quick manual check in 010B if a real teacher doc surfaces one, but mammoth is well known to handle nesting via indentation level, so no special handling is expected to be needed beyond what mammoth already emits.

**(d) Table fidelity.**
Clean, usable HTML `<table>`/`<tr>`/`<td>` in both tables tested (English and Arabic). No garbling, no lost cells. Safe to keep as HTML tables, no rasterization needed.

**(e) Is Arabic direction/encoding preserved?**
Character encoding: yes, perfectly. Directionality: mammoth's output carries **no `dir`/`lang` markup at all** — this must be added by the importer itself, not assumed to come through from the source document.

## Recommendation for 010B

- **Slide-split rule:** split a new slide on every `h1` or `h2` mammoth emits. **When a document has zero headings** (confirmed to happen — see synthetic-test-2), fall back to splitting every ~5-6 block-level elements (paragraphs/lists/images/tables) per slide, so a heading-less doc still produces a multi-slide deck rather than one giant slide.
- **Images:** keep as-is — mammoth already delivers them as data URLs; never rewrite to external/local refs.
- **Tables:** keep as real HTML `<table>` — no rasterization; fidelity was clean in both tests.
- **RTL:** the importer must explicitly wrap the generated deck in `<html lang="ar" dir="rtl">` — do not rely on mammoth's output for directionality, since it carries none.
- **Riskiest remaining assumption:** these findings are from synthetic (`python-docx`-generated) files, not real teacher documents. Real `.docx` files exported from various word processors (Word, Google Docs, LibreOffice) may carry additional style noise, unusual list/table nesting, or heading styles used inconsistently (e.g. `Heading 3` skipping `Heading 2`). **Re-run `web/import-spike.html` against real teacher files as soon as they're available** and amend the split rule if reality disagrees.
