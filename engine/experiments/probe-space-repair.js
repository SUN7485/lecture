/**
 * `مختلف اً؟` for `مختلفاً؟` — every character right, one space in the wrong place.
 *
 * KNOWN_ISSUES calls this the SPACING row and it is the largest slice of the
 * segmentation bucket: 31 blocks whose characters are all correct and which fail
 * anyway. Two shapes, both of which are orthography rather than judgement:
 *
 *   S1  a space between a letter and the combining mark that sits ON it. A mark
 *       attaches to the preceding base — a space there is never meaningful.
 *   S2  a space before terminal punctuation. `تماماً .` and `تالياً :` are not
 *       Arabic (or English) typography.
 *
 * Each is measured on its own, then together, because a combined score hides
 * which half is paying for the other.
 *
 * Usage: node experiments/probe-space-repair.js [--show]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = process.argv.includes("--show");

/** A space sitting between a base letter and a combining mark. */
const SPACE_BEFORE_MARK = /(\S) +([ً-ٰٕ])/gu;
/** A space sitting before punctuation that closes a clause. */
const SPACE_BEFORE_PUNCT = /(\S) +([.،؛:!?؟])(?=\s|$)/gu;

/**
 * A detached tail: a space, then a carrier-plus-mark cluster of one or two
 * characters, then a boundary. `مختلف اً؟` is `مختلفاً؟` — the cluster cannot
 * be a word on its own, so the space in front of it is not a word break.
 */
const DETACHED_TAIL = /(\p{Script=Arabic}) +([اةىآأإ]?[ً-ٰ]{1,2})(?=[\s.،؛:!?؟]|$)/gu;

const RULES = {
  "S1  space between a letter and its mark": (s) => s.replace(SPACE_BEFORE_MARK, "$1$2"),
  "S1b space before a detached mark cluster": (s) => s.replace(DETACHED_TAIL, "$1$2"),
  "S2  space before terminal punctuation": (s) => s.replace(SPACE_BEFORE_PUNCT, "$1$2"),
  "S1b + S2": (s) => s.replace(DETACHED_TAIL, "$1$2").replace(SPACE_BEFORE_PUNCT, "$1$2"),
};

const score = new Map(Object.keys(RULES).map((k) => [k, { fixed: 0, broken: 0, touched: 0 }]));
const samples = [];
let blocks = 0;

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p)))
      .map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truth = slideText[align[p]];
    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      blocks++;
      const wasOk = truth.includes(got);

      for (const [name, fix] of Object.entries(RULES)) {
        const after = normalize(fix(got));
        if (after === got) continue;
        const s = score.get(name);
        s.touched++;
        const isOk = truth.includes(after);
        if (!wasOk && isOk) s.fixed++;
        else if (wasOk && !isOk) s.broken++;
      }

      const both = normalize(RULES["S1b + S2"](got));
      if (SHOW && both !== got && samples.length < 16) {
        samples.push(`${truth.includes(both) ? "OK  " : "MISS"} ${pair.name} p${p + 1}`
          + `\n        before: ${got.slice(0, 66)}\n        after : ${both.slice(0, 66)}`);
      }
    }
  }
}

console.log(`blocks ${blocks}\n`);
console.log("rule                                       touched   fixed  broken");
for (const [name, s] of score) {
  console.log(`${name.padEnd(42)} ${String(s.touched).padStart(7)} ${String(s.fixed).padStart(7)} ${String(s.broken).padStart(7)}`);
}
if (SHOW) for (const s of samples) console.log(`\n  ${s}`);
