/**
 * EVERY delivered block, not just the ones that miss.
 *
 * `dump-delivered-misses.js` only prints blocks the scorer counts as wrong, and
 * the scorer's unit is `truth.includes(got)` — a block can carry a genuinely
 * corrupted WORD and still pass, because the corruption sits inside a fragment
 * that was never a substring of the truth anyway, or because the block missed
 * for an unrelated reason and the word is invisible under the first divergence.
 *
 * A reader's bug report names a WORD (`ثوانٍ` came out `ثوا.ٍ`). To find it you
 * need the whole delivered corpus on disk, greppable, with its truth beside it.
 *
 *   node experiments/dump-delivered-blocks.js --jsonl > blocks.jsonl
 *   node experiments/dump-delivered-blocks.js --raw --jsonl > raw.jsonl   # no repairs
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const RAW = process.argv.includes("--raw");

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  if (!RAW) for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);
  for (const [i, page] of model.pages.entries()) {
    for (const o of page.objects) {
      if (o.type !== "text" || !o.text) continue;
      const got = normalize(o.text);
      if (!got) continue;
      const truth = align[i] >= 0 ? slideText[align[i]] : "";
      process.stdout.write(JSON.stringify({
        deck: pair.name, page: i + 1, slide: align[i], got, truth,
        verbatim: !!truth && truth.includes(got),
      }) + "\n");
    }
  }
}
