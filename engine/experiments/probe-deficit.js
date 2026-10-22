/**
 * Why did the ligature repair not fire on this line?
 *
 * `repairLigatures` is gated on a per-baseline deficit: characters the DEVICE
 * owes minus characters structured text SUPPLIED. This prints both sides for one
 * baseline so a line that is visibly missing a letter can be checked against the
 * gate that was supposed to catch it.
 *
 *   node experiments/probe-deficit.js <deck> <page1based> <substringOfTheLine>
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { deviceGlyphs, owedOf, LAM_ALEF_LIGATURES } from "../src/extract/ligatures.js";
import { findPairs } from "../src/truth/corpus.js";

const [deck, pageArg, needle] = process.argv.slice(2);
const pair = findPairs().find((p) => p.name === deck);
if (!pair) { console.error(`no deck named ${deck}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
const page = doc.loadPage(Number(pageArg) - 1);
const devs = deviceGlyphs(page);
const blocks = buildLines(extractGlyphs(page));

const target = blocks.find((b) => blockText(b, blockIsRtl(b)).includes(needle));
if (!target) { console.error(`no block containing ${needle}`); process.exit(2); }
console.log(blockText(target, blockIsRtl(target)).slice(0, 110));

const y = target.glyphs[0].y;
const near = (a, b) => Math.abs(a - b) < 0.6;
const devRow = devs.filter((d) => near(d.y, y)).sort((a, b) => b.x - a.x);
const owed = devRow.reduce((s, d) => s + d.owed, 0);

console.log(`\nbaseline y ${y.toFixed(2)}`);
console.log(`  device glyphs ${devRow.length}, characters owed ${owed}`);
console.log(`  structured-text glyphs on this row: (whole page rows are keyed to 0.1pt, block may be a slice)`);

// The extractor's own row bucketing, reproduced: everything within 0.6pt.
const stRow = extractGlyphs(page).filter((g) => near(g.y, y));
console.log(`  stext glyphs ${stRow.length}   deficit ${owed - stRow.length}`);

console.log("\ndevice glyphs, right to left (x, unicode, owed, advance):");
for (const d of devRow) {
  const u = d.unicode;
  const lig = LAM_ALEF_LIGATURES.has(u) || owedOf(u) > 1;
  console.log(`  x ${d.x.toFixed(2)}  U+${u.toString(16).toUpperCase().padStart(4, "0")} ${JSON.stringify(String.fromCodePoint(u))}` +
    `  owed ${d.owed}  adv ${d.advance.toFixed(2)}${lig ? "   <- LIGATURE" : ""}`);
}
