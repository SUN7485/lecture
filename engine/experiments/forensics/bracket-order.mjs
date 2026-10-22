/**
 * How many reconstructed lines CLOSE a bracket before they open one.
 *
 * An impossibility, not a likelihood: no sentence in Arabic or in Latin closes a
 * parenthesis it never opened, so a running count where ")" overtakes "(" is a
 * reordering defect and nothing else. Counts the residue of the mixed-direction
 * class that the island fix does not reach — a neutral bracket at an island edge,
 * which N2 hands the PARAGRAPH direction and which no reversal can put back.
 *
 * Usage: node experiments/forensics/bracket-order.mjs <pdf> [more.pdf ...]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../../src/extract/glyphs.js";

const PAIRS = [["(", ")"], ["[", "]"], ["{", "}"]];
/**
 * CONTROL. A line that merely CONTINUES a parenthetical opened on the line above
 * closes a bracket it never opened, and that is not a defect — it is a line
 * break. Counting those reported 51 blocks on one document of which most were
 * continuations. Only a line whose brackets BALANCE and are still out of order
 * is evidence of reordering.
 */
function closesBeforeOpening(s) {
  for (const [open, close] of PAIRS) {
    const opens = [...s].filter((c) => c === open).length;
    const closes = [...s].filter((c) => c === close).length;
    if (opens !== closes || opens === 0) continue;
    let depth = 0;
    for (const ch of s) {
      if (ch === open) depth++;
      else if (ch === close && --depth < 0) return true;
    }
  }
  return false;
}

let totalBlocks = 0, bad = 0;
const samples = [];
for (const file of process.argv.slice(2)) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    for (const b of buildLines(extractGlyphs(page))) {
      const t = blockText(b, blockIsRtl(b));
      if (!t.trim()) continue;
      totalBlocks++;
      if (closesBeforeOpening(t)) {
        bad++;
        if (samples.length < 8) samples.push(`p${i + 1}  ${JSON.stringify(t.slice(0, 90))}`);
      }
    }
  }
}
console.log(`\nbracket-order defects: ${bad} of ${totalBlocks} blocks (${((bad / totalBlocks) * 100).toFixed(2)}%)`);
for (const s of samples) console.log(`   ${s}`);
console.log("");
