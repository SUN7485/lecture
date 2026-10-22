/**
 * Which blocks does each repair actually touch, corpus-wide?
 *
 * The repairs in `ligatures.js` tag every character they splice in with
 * `recoveredBy`, so the set of blocks they touch is a fact about the corpus
 * rather than a fact about the prose in their docstrings. This prints it.
 *
 * It exists because the fixtures were first written from those docstrings, and
 * the words they name (`الريالات`, `تماماً`, `الاستغلال`) occur in 7, 36 and 60
 * blocks across the corpus — so a page-level assertion on any of them passes on a
 * neighbouring correct instance and proves nothing. A fixture has to name the
 * BLOCK, and this is how the block is found.
 *
 *   node experiments/probe-repair-sites.js [--by ligature|tanween|collided]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const ONLY = arg("by", null);
const SHOW = Number(arg("show", 12));

const counts = new Map();
const sites = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const arity = ligatureArity(doc.asPDF());
  const slides = loadSlides(pair.html);

  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p), arity)).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    for (const b of buildLines(extractGlyphs(doc.loadPage(p), arity))) {
      const rec = b.glyphs.filter((g) => g.recovered);
      if (!rec.length) continue;
      const by = [...new Set(rec.map((g) => g.recoveredBy ?? "untagged"))];
      for (const k of by) counts.set(k, (counts.get(k) ?? 0) + 1);
      if (ONLY && !by.includes(ONLY)) continue;

      const got = normalize(blockText(b, blockIsRtl(b)));
      const truth = align[p] >= 0 ? slideText[align[p]] : null;
      sites.push({
        key: `${pair.name} p${p + 1} y=${b.y.toFixed(1)} x1=${b.x1.toFixed(1)}`,
        by: by.join("+"),
        chars: rec.map((g) => g.c).join(""),
        verbatim: truth ? truth.includes(got) : null,
        got,
      });
    }
  }
}

console.log(`blocks touched by a repair, by producer:`);
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${n}`);
const ok = sites.filter((s) => s.verbatim === true).length;
console.log(`\nlisted sites: ${sites.length}   verbatim after the repair: ${ok}   still a miss: ${sites.length - ok}`);

for (const s of sites.slice(0, SHOW)) {
  console.log(`\n  ${s.key}   [${s.by}] +${JSON.stringify(s.chars)}  ${s.verbatim === null ? "no truth" : s.verbatim ? "VERBATIM" : "miss"}`);
  console.log(`      ${s.got.slice(0, 100)}`);
}
