/**
 * Which blocks does a majority-based base direction get wrong?
 *
 * Switching blockIsRtl from "contains any Arabic" to "Arabic >= Latin" fixes 40
 * formula lines but breaks 11 that were correct. Those 11 decide whether the
 * rule can ship, so look at what they actually contain rather than tuning a
 * threshold blind.
 *
 * Pass the block keys reported by verbatim-set.js --diff.
 * Read-only.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, isCombiningMark } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const DIR = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\";

// "name pN y=.. x1=.." exactly as verbatim-set.js prints them.
const KEYS = [
  ["Chp1-Lec1-3(New)", 17, 232.5], ["Chp1-Lec1-3(New)", 17, 259.5],
  ["Chp1-Lec2-1(New)", 8, 93.0], ["Chp1-Lec2-1(New)", 9, 317.3],
  ["Chp1-Lec3-2(New)", 11, 254.3], ["Chp1-Lec3-2(New)", 11, 324.8],
  ["Chp1-Lec3-2(New)", 14, 139.5],
  ["Chp1-Lec5-2", 11, 309.0], ["Chp1-Lec5-2", 13, 338.3],
  ["Chp1-Lec6-2", 8, 216.8], ["Chp1-Lec6-2", 14, 309.8],
];

const counts = (glyphs) => {
  let arabic = 0, latin = 0, neutral = 0;
  for (const g of glyphs) {
    if (isCombiningMark(g.c)) continue;
    if (/[\u0600-\u06FF\u0750-\u077F]/.test(g.c)) arabic++;
    else if (/[A-Za-z0-9]/.test(g.c)) latin++;
    else neutral++;
  }
  return { arabic, latin, neutral };
};

const byFile = new Map();
for (const [name, page, y] of KEYS) {
  if (!byFile.has(name)) byFile.set(name, []);
  byFile.get(name).push([page, y]);
}

for (const [name, wanted] of byFile) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(DIR + name + ".pdf"), "application/pdf");
  const slides = loadSlides(DIR + name + "-edited.html");

  for (const [page, y] of wanted) {
    const p = page - 1;
    const truthAll = normalize(slides[p].replace(/\n/g, " "));
    const blocks = buildLines(extractGlyphs(doc.loadPage(p)));
    const b = blocks.find((x) => Math.abs(x.y - y) < 0.4);
    if (!b) { console.log(`${name} p${page} y=${y}  NOT FOUND`); continue; }

    const c = counts(b.glyphs);
    const asRtl = normalize(blockText(b, true));
    const asLtr = normalize(blockText(b, false));
    console.log(`${name} p${page} y=${y}`);
    console.log(`   arabic=${c.arabic} latin=${c.latin} neutral=${c.neutral}  -> majority says ${c.arabic >= c.latin ? "RTL" : "LTR"}`);
    console.log(`   as RTL : ${JSON.stringify(asRtl.slice(0, 78))}  ${truthAll.includes(asRtl) ? "MATCHES TRUTH" : "no"}`);
    console.log(`   as LTR : ${JSON.stringify(asLtr.slice(0, 78))}  ${truthAll.includes(asLtr) ? "MATCHES TRUTH" : "no"}`);
    console.log();
  }
}
