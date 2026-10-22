/**
 * Which letter does a tanween actually belong to?
 *
 * `EXTRA char "ً"` is the largest single-character miss class left: truth
 * "متكاملاً", got "متكاًمال". Every character is present and the tanween is in
 * the wrong place, which means the mark was bound to the wrong base — so this
 * dumps the ORIGIN of every glyph around the site (not the bounding box: the
 * mark rule compares origins) together with paint order, which is the other
 * evidence MuPDF gives about which letter a mark was emitted for.
 *
 *   node experiments/probe-mark-base.js <deck> <page1based> <substring>
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, isCombiningMark } from "../src/extract/glyphs.js";
import { findPairs } from "../src/truth/corpus.js";

const [deck, pageArg, needle] = process.argv.slice(2);
const pair = findPairs().find((p) => p.name === deck);
if (!pair) { console.error(`no deck named ${deck}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
const blocks = buildLines(extractGlyphs(doc.loadPage(Number(pageArg) - 1)));

for (const b of blocks) {
  const text = blockText(b, blockIsRtl(b));
  if (needle && !text.includes(needle)) continue;
  console.log("=".repeat(78));
  console.log(text.slice(0, 110));
  console.log("  paint order — c, seq, ORIGIN x, box x0..x1, groupId");
  const sorted = b.glyphs.slice().sort((a, c) => a.paintSeq - c.paintSeq);
  const marks = sorted.filter((g) => isCombiningMark(g.c));
  for (const m of marks) {
    const i = sorted.indexOf(m);
    for (let k = Math.max(0, i - 3); k < Math.min(sorted.length, i + 4); k++) {
      const g = sorted[k];
      console.log(`    ${g === m ? ">>" : "  "} ${JSON.stringify(g.c)} U+${g.c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}` +
        ` seq ${String(g.paintSeq).padStart(4)}  origin ${g.x.toFixed(2)}  box ${g.x0.toFixed(2)}..${g.x1.toFixed(2)}` +
        `  group ${g.groupId ?? "-"}${g.isMark ? "  MARK" : ""}`);
    }
    console.log("    ---");
  }
  if (needle) break;
}
