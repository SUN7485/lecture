/**
 * Is anything on a slide COVERED by something painted above it?
 *
 * "Many white boxes overlapping and stuff" is the one original complaint this
 * project never actually closed. A z-order fix in 2026-08-15 took 6 hidden text
 * objects to 0, but it was measured on chapter 1's six decks with the code of
 * that day. This re-measures over all 28, and asks three separate questions that
 * the single phrase "white boxes" could mean:
 *
 *   HIDDEN   a filled shape sits ABOVE a text object and covers it. The text is
 *            in the file and the reader cannot see it. This is the real bug.
 *   BARE     a filled shape covers a large area and has no text over it at all —
 *            a box that reads as an empty white rectangle on the slide.
 *   STACKED  filled shapes piled on the same region, which is what makes a slide
 *            look like a heap of boxes even when nothing is hidden.
 *
 * Usage: node experiments/probe-occlusion.js [--show]
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { findPairs } from "../src/truth/corpus.js";

const SHOW = process.argv.includes("--show");
/** A fill this light reads as white against the slide. */
const LIGHT = (hex) => {
  if (!hex || hex.length < 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) > 235;
};
/** Fraction of A's area that lies inside B. */
function covered(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(a.w * a.h, 0.01);
}

let hidden = 0, bare = 0, stacked = 0, texts = 0, shapes = 0, pages = 0;
const samples = [];

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  for (const page of model.pages) {
    pages++;
    const t = page.objects.filter((o) => o.type === "text");
    const s = page.objects.filter((o) => o.type === "shape" && o.fill);
    texts += t.length; shapes += s.length;

    for (const text of t) {
      // A shape ABOVE this text in paint order that covers most of it.
      const over = s.filter((sh) => sh.zIndex > text.zIndex && covered(text.bbox, sh.bbox) > 0.6);
      if (over.length) {
        hidden++;
        if (SHOW && samples.length < 15) {
          samples.push(`HIDDEN  ${pair.name} slide ${page.index + 1}  z${text.zIndex} under shape z${over[0].zIndex} fill #${over[0].fill}`
            + `\n         "${(text.text ?? "").slice(0, 62)}"`);
        }
      }
    }

    const area = page.widthPt * page.heightPt;
    for (const sh of s) {
      const big = (sh.bbox.w * sh.bbox.h) / area > 0.02;
      if (!big || !LIGHT(sh.fill)) continue;
      // Light, large, and nothing written on it.
      if (!t.some((text) => covered(text.bbox, sh.bbox) > 0.5)) bare++;
      if (s.some((o) => o !== sh && covered(sh.bbox, o.bbox) > 0.9)) stacked++;
    }
  }
}

console.log(`pages ${pages} · text objects ${texts} · filled shapes ${shapes}\n`);
console.log(`HIDDEN   text covered by a shape painted above it : ${hidden}`);
console.log(`BARE     large light shape with no text on it     : ${bare}`);
console.log(`STACKED  light shape fully inside another shape   : ${stacked}`);
if (SHOW) for (const s of samples) console.log(`\n  ${s}`);
