/**
 * Independent cross-check: does pdf.js recover the alef MuPDF drops?
 *
 * MuPDF emits 8 glyphs for the 9-letter "walinhiraf". If pdf.js — a completely
 * separate ToUnicode implementation — returns 9, the character is present in
 * the PDF and MuPDF is losing it. If pdf.js also returns 8, the information is
 * absent from the font's ToUnicode map and no extractor can recover it.
 */
import * as fs from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE = Number(process.argv[2] ?? 4);   // 1-based

const ALEF = "\u0627";
const LAM = "\u0644";
const WAW = "\u0648";
const NOON = "\u0646";
const HAH = "\u062D";
const RAH = "\u0631";
const FEH = "\u0641";

// "walinhiraf" = waw alef lam alef noon hah rah alef feh
const WORD = WAW + ALEF + LAM + ALEF + NOON + HAH + RAH + ALEF + FEH;
const CORE = NOON + HAH + RAH + ALEF + FEH;            // "nhiraf"
const rev = (s) => [...s].reverse().join("");

const doc = await getDocument({
  data: new Uint8Array(fs.readFileSync(PDF)),
  useSystemFonts: false,
  disableFontFace: true,
}).promise;

const page = await doc.getPage(PAGE);
const content = await page.getTextContent({ includeMarkedContent: false });

const joined = content.items.map((i) => i.str ?? "").join("");
const arabic = [...joined].filter((c) => /[\u0600-\u06FF]/.test(c)).length;
console.log(`page ${PAGE}: ${content.items.length} items, ${[...joined].length} chars, ${arabic} Arabic`);

const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, "0")).join(" ");

for (const [label, needle] of [["full word", WORD], ["core", CORE]]) {
  const f = joined.indexOf(needle);
  const r = joined.indexOf(rev(needle));
  console.log(`  ${label}: forward=${f >= 0 ? f : "no"}  reversed=${r >= 0 ? r : "no"}`);
  const at = f >= 0 ? f : r;
  if (at >= 0) {
    const win = joined.slice(Math.max(0, at - 8), at + needle.length + 8);
    console.log(`     window ${JSON.stringify(win)}`);
    console.log(`     cps    ${hex(win)}`);
  }
}

// Decisive count: alefs immediately adjacent to the lam in this word.
const at = joined.indexOf(rev(CORE));
if (at >= 0) {
  const tail = joined.slice(at + CORE.length, at + CORE.length + 6);
  console.log(`\n  after core (should contain LAM + ALEF + ALEF + WAW for a full word):`);
  console.log(`     ${JSON.stringify(tail)}  ->  ${hex(tail)}`);
  console.log(`     alef count in tail: ${[...tail].filter((c) => c === ALEF).length}`);
}
