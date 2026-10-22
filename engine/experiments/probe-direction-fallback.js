/**
 * Split the base-direction prize by the EVIDENCE the block actually carries.
 *
 * `probe-base-direction.js` reports the ceiling of a direction fix over the whole
 * corpus. That is the wrong unit for choosing a rule, because `textIsRtl` already
 * answers confidently for any block with Arabic in it, and a corpus-wide number
 * mixes those with the ones where it is guessing.
 *
 * The class this exists for: a block with NO Arabic character at all. `textIsRtl`
 * has nothing to weigh, falls through to `hasMirroredPair`, and answers LTR for
 * anything without brackets. But an RTL paragraph containing only Latin runs is
 * ordinary in this corpus — a table cell reading `SUM / AVERAGE` is laid out by
 * the source's RTL engine as `AVERAGE / SUM` on the page, and reading it visually
 * gives exactly that, backwards.
 *
 * Partitioned by evidence, `prize` and `protected` say whether a fallback can be
 * changed at all, and the samples say what would have to discriminate.
 *
 *   node experiments/probe-direction-fallback.js [samples]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 14);
const RE_ARABIC = /[\u0600-\u06FF\u0750-\u077F]/;
const RE_MULTI_RUN = /[A-Za-z0-9][^A-Za-z0-9]+[A-Za-z0-9]/;

/** Evidence class, decided the same way `textIsRtl` would see the block. */
function classOf(text) {
  if (RE_ARABIC.test(text)) return "has arabic";
  // Nothing directional to weigh. A single Latin run is order-insensitive; two or
  // more runs are where a base-direction mistake becomes visible.
  return RE_MULTI_RUN.test(text) ? "no arabic, MULTI-RUN" : "no arabic, one run";
}

const cells = new Map();
const show = new Map();
const bump = (cls, cell) => {
  if (!cells.has(cls)) cells.set(cls, { insensitive: 0, protected: 0, prize: 0, other: 0 });
  cells.get(cls)[cell]++;
};
const sample = (key, s) => {
  if (!show.has(key)) show.set(key, []);
  if (show.get(key).length < SAMPLES) show.get(key).push(s);
};

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p))).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truthAll = slideText[align[p]];
    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const rtl = blockIsRtl(b);
      const got = normalize(blockText(b, rtl));
      if (!got) continue;
      const flipped = normalize(blockText(b, !rtl));
      const okNow = truthAll.includes(got), okFlipped = truthAll.includes(flipped);
      const cls = classOf(got);
      const where = `${pair.name} p${p + 1} y=${b.y.toFixed(1)} [${rtl ? "rtl" : "ltr"}]`;
      if (okNow && okFlipped) bump(cls, "insensitive");
      else if (okNow) {
        bump(cls, "protected");
        sample(`${cls} PROTECTED`, `${where}\n      kept    ${got.slice(0, 88)}\n      flipped ${flipped.slice(0, 88)}`);
      } else if (okFlipped) {
        bump(cls, "prize");
        sample(`${cls} PRIZE`, `${where}\n      got     ${got.slice(0, 88)}\n      flipped ${flipped.slice(0, 88)}`);
      } else bump(cls, "other");
    }
  }
}

console.log("class".padEnd(24) + "insens".padStart(8) + "protect".padStart(9) + "PRIZE".padStart(8) + "other".padStart(8));
console.log("-".repeat(57));
for (const [cls, c] of cells) {
  console.log(cls.padEnd(24) + String(c.insensitive).padStart(8) + String(c.protected).padStart(9) +
    String(c.prize).padStart(8) + String(c.other).padStart(8));
}
for (const [k, list] of show) {
  if (!k.startsWith("no arabic")) continue;
  console.log(`\n${k}`);
  for (const s of list) console.log(`  ${s}`);
}
