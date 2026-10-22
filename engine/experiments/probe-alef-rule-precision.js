/**
 * Is the suspect-dropped-alef doctor rule crying wolf?
 *
 * The rule flags any /[وبفك]لا/ as a probably-missing definite-article alef.
 * But "ولا" (and not), "بلا" (without) and "فلا" are ordinary Arabic words, so
 * the pattern may be firing on perfectly correct text — which matters because
 * this rule is deliberately un-fixable and asks a human to check every hit.
 *
 * Ground truth decides it: if our block text appears VERBATIM in the source
 * HTML, then whatever the rule flagged inside it is correct by definition and
 * the finding is a false positive.
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const DIR = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\";
const NAMES = ["Chp1-Lec1-3(New)", "Chp1-Lec2-1(New)", "Chp1-Lec3-2(New)", "Chp1-Lec4-2", "Chp1-Lec5-2", "Chp1-Lec6-2"];
const RULE = /[وبفك]لا/;

let flagged = 0, falsePositive = 0, truePositive = 0;
const fpWords = new Map(), tpWords = new Map();

for (const name of NAMES) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(DIR + name + ".pdf"), "application/pdf");
  const slides = loadSlides(DIR + name + "-edited.html");

  for (let p = 0; p < Math.min(doc.countPages(), slides.length); p++) {
    const truthAll = normalize(slides[p].replace(/\n/g, " "));

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got || !RULE.test(got)) continue;
      flagged++;

      const word = (got.match(/\S*[وبفك]لا\S*/) || [""])[0];

      // The whole block matching truth verbatim proves the flagged word is right.
      // Otherwise fall back to asking whether that exact word occurs in truth.
      const blockIsRight = truthAll.includes(got);
      const wordInTruth = word.length > 2 && truthAll.includes(word);

      if (blockIsRight || wordInTruth) {
        falsePositive++;
        fpWords.set(word, (fpWords.get(word) ?? 0) + 1);
      } else {
        truePositive++;
        tpWords.set(word, (tpWords.get(word) ?? 0) + 1);
      }
    }
  }
}

const pct = (n) => ((n / flagged) * 100).toFixed(1);
console.log(`blocks flagged by suspect-dropped-alef: ${flagged}`);
console.log(`  FALSE POSITIVE (text is correct) : ${falsePositive}  (${pct(falsePositive)}%)`);
console.log(`  true positive  (text really wrong): ${truePositive}  (${pct(truePositive)}%)`);

const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log("\nmost-flagged words that are CORRECT (false alarms):");
for (const [w, n] of top(fpWords)) console.log(`  ${JSON.stringify(w).padEnd(28)} x${n}`);
console.log("\nmost-flagged words that are genuinely wrong:");
for (const [w, n] of top(tpWords)) console.log(`  ${JSON.stringify(w).padEnd(28)} x${n}`);
