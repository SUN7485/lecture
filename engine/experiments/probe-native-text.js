/**
 * PROBE 1 — Is the Arabic logical text recoverable from the native PDF?
 *
 * The prior experiment (reported by ChatGPT) concluded native PDF text is
 * "not production safe" for Arabic: 99.9% character recall but 0% parentheses,
 * 0-47% digits, 3/29 mixed-direction. That is the fingerprint of a visual-order
 * bug, not missing information.
 *
 * MuPDF's structured-text walker exposes a per-character `bidi` embedding level
 * and a per-line `direction`. If those are populated, logical order is
 * mechanically recoverable and no OCR is needed for text authority.
 *
 * This probe only MEASURES. It draws no conclusions it cannot show.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.argv[2] ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE_INDEX = Number(process.argv[3] ?? 0);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const pageCount = doc.countPages();

console.log("=".repeat(72));
console.log("PDF:", PDF);
console.log("pages:", pageCount);

const page = doc.loadPage(PAGE_INDEX);
const bounds = page.getBounds();
console.log("page", PAGE_INDEX, "bounds (pt):", bounds.map((n) => +n.toFixed(2)).join(", "));
console.log("page size (pt):", (bounds[2] - bounds[0]).toFixed(2), "x", (bounds[3] - bounds[1]).toFixed(2));

// ---- collect every char with its full evidence -----------------------------
const stext = page.toStructuredText("preserve-whitespace,preserve-spans");
const lines = [];
let cur = null;

stext.walk({
  beginLine(bbox, wmode, direction) {
    cur = { bbox, wmode, direction, chars: [] };
  },
  onChar(c, origin, font, size, quad, color, bidi) {
    if (!cur) return;
    cur.chars.push({
      c,
      x: origin[0],
      y: origin[1],
      font: font.getName(),
      size,
      bidi,
      quad,
    });
  },
  endLine() {
    if (cur && cur.chars.length) lines.push(cur);
    cur = null;
  },
});

console.log("text lines:", lines.length);
console.log("total chars:", lines.reduce((n, l) => n + l.chars.length, 0));

// ---- what bidi evidence do we actually have? -------------------------------
const levelHist = new Map();
for (const l of lines) for (const ch of l.chars) levelHist.set(ch.bidi, (levelHist.get(ch.bidi) ?? 0) + 1);
console.log("\nBIDI LEVELS PRESENT (level -> char count):");
for (const [lvl, n] of [...levelHist.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  level ${lvl}: ${n} chars  ${lvl % 2 === 0 ? "(LTR)" : "(RTL)"}`);
}

const dirHist = new Map();
for (const l of lines) {
  const k = `${Math.round(l.direction[0])},${Math.round(l.direction[1])}`;
  dirHist.set(k, (dirHist.get(k) ?? 0) + 1);
}
console.log("\nLINE DIRECTIONS (dx,dy -> line count):");
for (const [k, n] of dirHist) console.log(`  (${k}): ${n} lines`);

// ---- fonts -----------------------------------------------------------------
const fontHist = new Map();
for (const l of lines) for (const ch of l.chars) fontHist.set(ch.font, (fontHist.get(ch.font) ?? 0) + 1);
console.log("\nFONTS:");
for (const [f, n] of [...fontHist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${f}: ${n} chars`);

// ---- show the interesting lines: mixed script, digits, parentheses ---------
const AR = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LAT = /[A-Za-z]/;
const DIG = /[0-9\u0660-\u0669]/;
const PAREN = /[()\[\]{}]/;

const raw = (l) => l.chars.map((c) => c.c).join("");
const interesting = lines
  .map((l, i) => ({ i, l, t: raw(l) }))
  .filter(({ t }) => AR.test(t) && (LAT.test(t) || DIG.test(t) || PAREN.test(t)));

console.log("\n" + "=".repeat(72));
console.log(`MIXED-CONTENT LINES (Arabic + Latin/digits/parens): ${interesting.length} of ${lines.length}`);
console.log("=".repeat(72));

for (const { i, l, t } of interesting.slice(0, 12)) {
  const levels = [...new Set(l.chars.map((c) => c.bidi))].sort();
  console.log(`\n--- line ${i} | levels [${levels.join(",")}] | dir (${l.direction.map(Math.round).join(",")}) ---`);
  console.log("  RAW  (walk order): " + JSON.stringify(t));
  // Presentation-form detection: U+FB50-FDFF / U+FE70-FEFF are shaped glyphs,
  // not base letters. If present, de-shaping is required before any comparison.
  const shaped = [...t].filter((c) => /[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(c)).length;
  if (shaped) console.log(`  !! ${shaped} Arabic PRESENTATION-FORM chars (need de-shaping)`);
}

// ---- what does the naive flat extraction give? -----------------------------
console.log("\n" + "=".repeat(72));
console.log("NAIVE stext.asText() — this is what the old experiment most likely measured");
console.log("=".repeat(72));
console.log(stext.asText().split("\n").slice(0, 18).join("\n"));
