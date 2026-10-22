/**
 * The accuracy of the text the user actually GETS.
 *
 * `categorize-misses.js` measures raw extraction, which is the right number for
 * judging an extractor change and the wrong number for judging the product:
 * `convert` and the editor both apply DEFAULT_REPAIRS before anything is
 * written, so the deck on disk is not the deck that number describes.
 *
 * This scores the model after those repairs — same corpus, same alignment, same
 * verbatim test — so the two numbers can be read side by side.
 *
 * Usage: node experiments/delivered-accuracy.js
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

let blocks = 0, verbatimRaw = 0, verbatimDelivered = 0;
const perChapter = new Map();

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  const slides = loadSlides(pair.html);
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  // Score BEFORE, then repair, then score the same objects again — by id, so a
  // block keeps its identity across the rewrite.
  const raw = new Map();
  for (const p of model.pages) for (const o of p.objects) {
    if (o.type === "text" && o.text) raw.set(o.id, o.text);
  }
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  for (const [i, p] of model.pages.entries()) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    for (const o of p.objects) {
      if (o.type !== "text" || !o.text) continue;
      blocks++;
      const wasOk = truth.includes(normalize(raw.get(o.id) ?? o.text));
      const isOk = truth.includes(normalize(o.text));
      if (wasOk) verbatimRaw++;
      if (isOk) verbatimDelivered++;
      const c = perChapter.get(pair.chapter) ?? { n: 0, raw: 0, out: 0 };
      c.n++; if (wasOk) c.raw++; if (isOk) c.out++;
      perChapter.set(pair.chapter, c);
    }
  }
}

const pct = (n, d) => ((n / d) * 100).toFixed(2) + "%";
console.log(`blocks ${blocks}`);
console.log(`  raw extraction        ${verbatimRaw}  ${pct(verbatimRaw, blocks)}`);
console.log(`  after DEFAULT_REPAIRS ${verbatimDelivered}  ${pct(verbatimDelivered, blocks)}`);
console.log(`  net ${verbatimDelivered - verbatimRaw >= 0 ? "+" : ""}${verbatimDelivered - verbatimRaw} blocks\n`);
console.log("per chapter                raw      delivered");
for (const [ch, c] of [...perChapter].sort()) {
  console.log(`  ${ch.padEnd(10)} ${String(c.n).padStart(6)}  ${pct(c.raw, c.n).padStart(8)}  ${pct(c.out, c.n).padStart(9)}`);
}
