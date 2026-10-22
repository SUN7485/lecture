/**
 * WHERE does the alef actually go?
 *
 * Established so far (measured):
 *   - device path sees every painted glyph, 0 with missing unicode
 *   - production text contains 0 Arabic presentation forms, so the
 *     structured-text path already decomposes ligatures
 *   - yet 101 blocks still differ from truth by a dropped "ا"
 *
 * So the loss is NOT a missing glyph and NOT an undecomposed ligature. This
 * probe locates real dropped-alef blocks using the same alignment the scorer
 * uses, then dumps the ordered glyph evidence at the divergence so the cause is
 * visible rather than guessed.
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, withSpaces } from "../src/extract/glyphs.js";
import { visualToLogical } from "../src/extract/bidi.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const DIR = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\";
const NAMES = ["Chp1-Lec1-3(New)", "Chp1-Lec2-1(New)", "Chp1-Lec3-2(New)", "Chp1-Lec4-2", "Chp1-Lec5-2", "Chp1-Lec6-2"];
const MAX_DUMPS = Number(process.argv[2] ?? 3);

function lcs(a, b) {
  const dp = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function alignToTruth(got, truthAll) {
  const anchors = [got.slice(0, 12), got.slice(Math.max(0, (got.length >> 1) - 6), (got.length >> 1) + 6), got.slice(-12)];
  const positions = new Set();
  for (const a of anchors) {
    if (a.length < 4) continue;
    for (let i = truthAll.indexOf(a); i !== -1; i = truthAll.indexOf(a, i + 1)) positions.add(i);
  }
  let best = "", bestScore = -1;
  for (const pos of positions) {
    for (const start of [pos, pos - (got.length >> 1), pos - got.length + 12]) {
      if (start < 0) continue;
      const win = truthAll.slice(start, start + got.length + 8);
      const s = lcs(got, win) / Math.max(got.length, win.length);
      if (s > bestScore) { bestScore = s; best = win; }
    }
  }
  return { best, bestScore };
}

let dumped = 0;
let droppedAlefBlocks = 0;
const precedingChar = new Map();   // what sits before the lost alef in truth
const followingChar = new Map();   // what sits after it

for (const name of NAMES) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(DIR + name + ".pdf"), "application/pdf");
  const slides = loadSlides(DIR + name + "-edited.html");

  for (let p = 0; p < Math.min(doc.countPages(), slides.length); p++) {
    const truthAll = normalize(slides[p].replace(/\n/g, " "));

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const rtl = blockIsRtl(b);
      const got = normalize(blockText(b, rtl));
      if (!got || truthAll.includes(got)) continue;

      const { best, bestScore } = alignToTruth(got, truthAll);
      if (bestScore < 0.65) continue;

      // first divergence
      let i = 0;
      while (i < got.length && i < best.length && got[i] === best[i]) i++;
      if (i >= got.length || i >= best.length) continue;
      const isDroppedAlef = got[i] === best[i + 1] && best[i] === "ا";
      if (!isDroppedAlef) continue;

      droppedAlefBlocks++;
      const before = i > 0 ? best[i - 1] : "^";
      const after = best[i + 1] ?? "$";
      precedingChar.set(before, (precedingChar.get(before) ?? 0) + 1);
      followingChar.set(after, (followingChar.get(after) ?? 0) + 1);

      if (dumped >= MAX_DUMPS) continue;
      dumped++;

      console.log("=".repeat(72));
      console.log(`${name} p${p + 1}   divergence at index ${i}   (match ${(bestScore * 100).toFixed(0)}%)`);
      console.log(`  truth : ${JSON.stringify(best.slice(Math.max(0, i - 14), i + 14))}`);
      console.log(`  got   : ${JSON.stringify(got.slice(Math.max(0, i - 14), i + 14))}`);
      console.log(`  missing "ا"  between ${JSON.stringify(before)} and ${JSON.stringify(after)}`);

      // Ordered glyphs exactly as blockText builds them, before whitespace collapse.
      const ordered = visualToLogical(withSpaces(b.glyphs), rtl);
      const raw = ordered.map((g) => g.c).join("");
      // Anchor on the 5 chars we produced right after the divergence.
      const needle = got.slice(i, i + 5);
      let at = raw.indexOf(needle);
      if (at === -1) at = Math.min(i, Math.max(0, raw.length - 1));

      const lo = Math.max(0, at - 6), hi = Math.min(ordered.length, at + 8);
      console.log("\n  ordered glyphs around the divergence:");
      console.log("    idx  char  codepoint  originX     w      zeroW  mark  group  paintSeq");
      for (let k = lo; k < hi; k++) {
        const g = ordered[k];
        const cp = g.c.codePointAt(0);
        const w = g.x1 != null && g.x0 != null ? g.x1 - g.x0 : NaN;
        const mark = k === at ? "  <-- divergence" : "";
        console.log(
          `    ${String(k).padStart(3)}  ${JSON.stringify(g.c).padEnd(6)} ` +
          `U+${cp.toString(16).toUpperCase().padStart(4, "0")}   ` +
          `${(g.x ?? NaN).toFixed(2).padStart(8)} ${(isNaN(w) ? 0 : w).toFixed(2).padStart(6)}  ` +
          `${(w < 0.5 ? "yes" : "no").padEnd(6)} ${(g.isMark ? "yes" : "no").padEnd(5)} ` +
          `${String(g.groupId ?? "-").padEnd(6)} ${g.paintSeq ?? "syn"}${mark}`
        );
      }
      console.log();
    }
  }
}

console.log("=".repeat(72));
console.log(`blocks whose first divergence is a dropped "ا": ${droppedAlefBlocks}`);
console.log("\ncharacter BEFORE the lost alef in truth:");
for (const [c, n] of [...precedingChar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${JSON.stringify(c)} x${n}`);
}
console.log("\ncharacter AFTER the lost alef in truth:");
for (const [c, n] of [...followingChar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${JSON.stringify(c)} x${n}`);
}
