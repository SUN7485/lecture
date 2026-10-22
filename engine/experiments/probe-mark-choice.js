/**
 * Which base did the extractor actually bind a mark to, and what are the
 * alternatives? Prints the groupId of the mark and of every letter whose box
 * contains the mark's origin, so "it picked the wrong one" can be verified
 * instead of assumed.
 *
 *   node experiments/probe-mark-choice.js <deck> <page1based> <substring>
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, isCombiningMark } from "../src/extract/glyphs.js";
import { findPairs } from "../src/truth/corpus.js";

const [deck, pageArg, needle] = process.argv.slice(2);
const pair = findPairs().find((p) => p.name === deck);
if (!pair) { console.error(`no deck named ${deck}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
const MARK_EPS = 1.5;

for (const b of buildLines(extractGlyphs(doc.loadPage(Number(pageArg) - 1)))) {
  const text = blockText(b, blockIsRtl(b));
  if (needle && !text.includes(needle)) continue;
  console.log(text.slice(0, 100));

  const bases = b.glyphs.filter((g) => !isCombiningMark(g.c) && g.c.trim());
  for (const m of b.glyphs.filter((g) => isCombiningMark(g.c))) {
    const cands = bases.filter((x) => Math.abs(x.y - m.y) <= 3 &&
      m.x >= x.x0 - MARK_EPS && m.x <= x.x1 + MARK_EPS);
    console.log(`  mark ${JSON.stringify(m.c)} seq ${m.paintSeq} origin ${m.x.toFixed(2)} group ${m.groupId ?? "-"}`);
    for (const c of cands) {
      console.log(`      candidate ${JSON.stringify(c.c)} seq ${c.paintSeq} origin ${c.x.toFixed(2)}` +
        ` box ${c.x0.toFixed(2)}..${c.x1.toFixed(2)} group ${c.groupId ?? "-"}` +
        `${c.groupId != null && c.groupId === m.groupId ? "   <- BOUND" : ""}`);
    }
  }
  if (needle) break;
}
