/**
 * TRUE character accuracy, independent of block segmentation.
 *
 * The verbatim-block metric conflates two very different failures: wrong
 * characters, and correct characters split into blocks that do not line up with
 * the source's lines. For deciding what to fix next we need them separated.
 *
 * Here we concatenate every block on a page and compare against the whole
 * slide's text, reporting:
 *   - character recall  (how much of the source we recovered, order-free)
 *   - in-order recall   (LCS: how much we recovered in the right order)
 *   - per-category presence for the cases that used to fail
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const DIR = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\";
const NAMES = ["Chp1-Lec1-3(New)", "Chp1-Lec2-1(New)", "Chp1-Lec3-2(New)", "Chp1-Lec4-2", "Chp1-Lec5-2", "Chp1-Lec6-2"];

/** LCS length via rolling row — strings here are a few thousand chars. */
function lcsLen(a, b) {
  let dp = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const next = new Uint32Array(b.length + 1);
    const ca = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      next[j] = ca === b[j - 1] ? dp[j - 1] + 1 : Math.max(next[j - 1], dp[j]);
    }
    dp = next;
  }
  return dp[b.length];
}

function multisetRecall(got, truth) {
  const have = new Map();
  for (const c of got) have.set(c, (have.get(c) ?? 0) + 1);
  let found = 0;
  for (const c of truth) {
    const n = have.get(c) ?? 0;
    if (n > 0) { have.set(c, n - 1); found++; }
  }
  return found / truth.length;
}

let totChars = 0, totRecall = 0, totOrder = 0, pages = 0;
const perDoc = [];

for (const name of NAMES) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(DIR + name + ".pdf"), "application/pdf");
  const slides = loadSlides(DIR + name + "-edited.html");
  let dChars = 0, dRecall = 0, dOrder = 0, dPages = 0;

  for (let p = 0; p < Math.min(doc.countPages(), slides.length); p++) {
    const blocks = buildLines(extractGlyphs(doc.loadPage(p)));
    const got = normalize(blocks.map((b) => blockText(b, blockIsRtl(b))).join(" "));
    const truth = normalize(slides[p].replace(/\n/g, " "));
    if (!truth.length) continue;

    const recall = multisetRecall(got, truth);
    const order = lcsLen(got, truth) / truth.length;

    dChars += truth.length; dRecall += recall * truth.length; dOrder += order * truth.length; dPages++;
  }

  perDoc.push({ name, pages: dPages, chars: dChars, recall: dRecall / dChars, order: dOrder / dChars });
  totChars += dChars; totRecall += dRecall; totOrder += dOrder; pages += dPages;
}

console.log("PAGE-LEVEL TEXT ACCURACY (segmentation-independent)");
console.log("=".repeat(72));
console.log("document                 pages   chars   char recall   in-order recall");
for (const d of perDoc) {
  console.log(
    `${d.name.padEnd(22)} ${String(d.pages).padStart(5)} ${String(d.chars).padStart(7)}` +
      `      ${(d.recall * 100).toFixed(2).padStart(6)}%          ${(d.order * 100).toFixed(2).padStart(6)}%`
  );
}
console.log("-".repeat(72));
console.log(
  `${"CORPUS".padEnd(22)} ${String(pages).padStart(5)} ${String(totChars).padStart(7)}` +
    `      ${((totRecall / totChars) * 100).toFixed(2).padStart(6)}%          ${((totOrder / totChars) * 100).toFixed(2).padStart(6)}%`
);
