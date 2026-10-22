/**
 * What does the PRODUCTION extraction path actually emit for a lam-alef?
 *
 * probe-ligature-decomp.js measured the DEVICE path and found every lam-alef
 * arriving as a single presentation-form codepoint (U+FEF7 etc). But production
 * (src/extract/glyphs.js extractGlyphs) uses the STRUCTURED-TEXT path, whose
 * comment claims MuPDF splits the ligature into two codepoints. Both cannot be
 * the whole story, and only the production path decides our score.
 *
 * Q1. Does production text contain Arabic Presentation Forms (U+FB50..U+FEFF)?
 * Q2. At a known failing site, what is the exact glyph sequence — char,
 *     codepoint, origin x, advance width — around the alef that goes missing?
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";

const CORPUS = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done";
const isPresentationForm = (cp) => (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);

const files = fs.readdirSync(CORPUS).filter((f) => f.toLowerCase().endsWith(".pdf"));

let totalChars = 0;
const pfCounts = new Map();      // codepoint -> occurrences in production text
const pfSamples = [];

for (const file of files) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(CORPUS, file)), "application/pdf");
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    for (const block of buildLines(extractGlyphs(page))) {
      const text = blockText(block, blockIsRtl(block));
      for (const ch of text) {
        totalChars++;
        const cp = ch.codePointAt(0);
        if (!isPresentationForm(cp)) continue;
        pfCounts.set(cp, (pfCounts.get(cp) ?? 0) + 1);
        if (pfSamples.length < 6) pfSamples.push({ file, page: p, ch, cp, text: text.slice(0, 60) });
      }
    }
  }
}

console.log("=========== Q1: presentation forms in PRODUCTION text ===========");
console.log(`total characters produced: ${totalChars}`);
const pfTotal = [...pfCounts.values()].reduce((s, v) => s + v, 0);
console.log(`presentation-form characters: ${pfTotal}`);
if (pfTotal) {
  for (const [cp, n] of [...pfCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${JSON.stringify(String.fromCodePoint(cp))} x${n}`);
  }
  for (const s of pfSamples) console.log(`  e.g. ${s.file} p${s.page}: ${JSON.stringify(s.text)}`);
} else {
  console.log("  NONE — the structured-text path already decomposes ligatures.");
  console.log("  => the device-path presentation forms never reach production.");
}

// ---------------- Q2: the actual failing site ----------------
// categorize-misses reports Chp1-Lec1-3(New) p2:  got "لات من"  truth "الات م"
console.log("\n=========== Q2: glyph sequence at a failing site ===========");
const doc = mupdf.Document.openDocument(
  fs.readFileSync(path.join(CORPUS, "Chp1-Lec1-3(New).pdf")), "application/pdf");
const page = doc.loadPage(2);
const blocks = buildLines(extractGlyphs(page));

const hit = blocks.find((b) => blockText(b, blockIsRtl(b)).includes("لات"));
if (!hit) {
  console.log("  no block containing 'لات' on p2 — dumping the first 3 blocks instead");
  for (const b of blocks.slice(0, 3)) console.log("   " + JSON.stringify(blockText(b, blockIsRtl(b)).slice(0, 70)));
} else {
  const text = blockText(hit, blockIsRtl(hit));
  console.log(`block text: ${JSON.stringify(text.slice(0, 90))}`);
  const at = text.indexOf("لات");
  console.log(`"لات" at index ${at}; context: ${JSON.stringify(text.slice(Math.max(0, at - 12), at + 12))}`);

  console.log("\n  glyphs in PAINT order (x = pen origin, w = advance box width):");
  console.log("   seq   char  codepoint  x         w       zeroW  mark  group");
  const gs = hit.glyphs.slice().sort((a, b) => a.paintSeq - b.paintSeq);
  for (const g of gs) {
    const cp = g.c.codePointAt(0);
    const w = g.x1 - g.x0;
    console.log(
      `   ${String(g.paintSeq).padStart(4)}  ${JSON.stringify(g.c).padEnd(6)} ` +
      `U+${cp.toString(16).toUpperCase().padStart(4, "0")}   ` +
      `${g.x.toFixed(2).padStart(8)} ${w.toFixed(2).padStart(7)}  ` +
      `${(w < 0.5 ? "yes" : "no").padEnd(6)} ${(g.isMark ? "yes" : "no").padEnd(5)} ${g.groupId ?? "-"}`
    );
  }
}
