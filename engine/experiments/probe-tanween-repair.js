/**
 * Can the stranded-fathatan defect be REPAIRED automatically?
 *
 * `tanween-missing-alef` detects it at 100% precision and then tells the user to
 * fix it by hand, which is not an answer for a 100-page deck. This applies
 * candidate rewrites to every flagged block and checks the result against real
 * ground truth, so the decision is made on FIXED/BROKEN counts.
 *
 * The rules are built up one at a time and measured one at a time, because a
 * combined rule that scores well hides which half is carrying it — and which
 * half is quietly costing blocks.
 *
 * Usage: node experiments/probe-tanween-repair.js [--show]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { owedOf } from "../src/extract/ligatures.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = process.argv.includes("--show");

const ALEF = "ا";
const LAM = "ل";
const FATHATAN = "ً";
const SHADDA = "ّ";
const STRANDED = new RegExp(`[^اةءآأإ]${FATHATAN}(?![اةءآأإ])`, "u");
const LETTER = /[ء-غف-ي]/;
const MARK = /[ً-ْٰ]/;
const MARK_G = /[ً-ْٰ]/gu;

/**
 * Put ALEF (or LAM+ALEF) and its fathatan back at the end of the word.
 *
 * Three facts from the corpus, each of which changes the answer:
 *
 *  1. The mark belongs to the WORD, not to trailing punctuation:
 *     "فور.ً" -> "فوراً."  and  "دائم:ً" -> "دائماً:".
 *  2. Letters can survive AFTER the stranded mark, so the word does not end
 *     where the mark is: "فوًر" -> "فوراً", not "فواًر".
 *  3. A SHADDA sitting immediately after the fathatan with no alef anywhere is
 *     the dropped alef misread, not a real shadda: "شهريًّ" -> "شهرياً".
 *
 * @param {string} s        the block text
 * @param {number} missing  characters the DEVICE says were lost on this line;
 *                          2 means a lam-alef ligature went, not a bare alef
 */
function repair(s, missing, { wordEnd = true, dropShadda = true, useLam = true } = {}) {
  const at = s.search(STRANDED);
  if (at < 0) return s;
  const markAt = at + 1;

  // Back to the last real letter before the mark.
  let start = at;
  while (start >= 0 && !LETTER.test(s[start])) start--;
  if (start < 0) return s;

  // Forward to the end of the word, so letters stranded after the mark are kept
  // in front of it rather than behind.
  let end = markAt + 1;
  if (dropShadda && s[end] === SHADDA && !s.slice(markAt).includes(ALEF)) end++;
  let tail = end;
  if (wordEnd) while (tail < s.length && (LETTER.test(s[tail]) || MARK.test(s[tail]))) tail++;

  const middle = s.slice(start + 1, markAt).replace(MARK_G, "");
  const carried = wordEnd ? s.slice(end, tail) : "";
  const insert = (useLam && missing >= 2 ? LAM + ALEF : ALEF) + FATHATAN;

  return s.slice(0, start + 1) + carried + insert + middle + s.slice(wordEnd ? tail : end);
}

const VARIANTS = {
  "alef at the end of the word": (s, e) => repair(s, 0, { wordEnd: false, dropShadda: false, useLam: false }),
  "  + keep letters after the mark": (s, e) => repair(s, 0, { dropShadda: false, useLam: false }),
  "  + trailing shadda is the lost alef": (s, e) => repair(s, 0, { useLam: false }),
  "  + lam-alef when the LINE owes 2": (s, e) => repair(s, e.deficit),
  "  + lam-alef when a LIGATURE is unaccounted": (s, e) => repair(s, e.ligatureLost ? 2 : 0),
  "keep letters + ligature, no shadda rule": (s, e) => repair(s, e.ligatureLost ? 2 : 0, { dropShadda: false }),
};

/**
 * What the page itself says this line lost.
 *
 * `deficit` is the blunt instrument — it counts every missing character on the
 * line, so a loss somewhere else decides what gets inserted here, and that is
 * how `تنظيفً` became `تنظيفلاً` instead of `تنظيفاً`.
 *
 * `ligatureLost` is the specific one: the device painted more lam-alef ligature
 * glyphs than the text contains `لا` sequences, so a lam-alef went missing on
 * THIS line and the thing to put back is `لا`, not a bare alef.
 */
function evidenceFor(b, devs, text) {
  const x0 = Math.min(...b.glyphs.map((g) => g.x0));
  const x1 = Math.max(...b.glyphs.map((g) => g.x1));
  let owed = 0, ligatures = 0;
  for (const d of devs) {
    if (Math.abs(d.y - b.y) > 1.5) continue;
    if (d.x < x0 - 1 || d.x > x1 + 1) continue;
    owed += owedOf(d.unicode);
    if (owedOf(d.unicode) === 2) ligatures++;
  }
  const present = (text.match(/ل[اآأإ]/gu) ?? []).length;
  return { deficit: owed - b.glyphs.length, ligatureLost: ligatures > present };
}

let flagged = 0;
const score = new Map(Object.keys(VARIANTS).map((k) => [k, { fixed: 0, broken: 0, stillWrong: 0 }]));
const samples = [];

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
    const glyphs = extractGlyphs(doc.loadPage(p));
    for (const b of buildLines(glyphs)) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got || !STRANDED.test(got)) continue;
      flagged++;
      const wasOk = truth.includes(got);
      const ev = evidenceFor(b, glyphs.deviceGlyphs, got);

      for (const [name, fix] of Object.entries(VARIANTS)) {
        const after = normalize(fix(got, ev));
        const isOk = truth.includes(after);
        const s = score.get(name);
        if (!wasOk && isOk) s.fixed++;
        else if (wasOk && !isOk) s.broken++;
        else if (!isOk) s.stillWrong++;
      }

      const best = normalize(repair(got, ev.ligatureLost ? 2 : 0));
      if (SHOW && !truth.includes(best) && samples.length < 25) {
        const at = got.search(STRANDED);
        samples.push({ deck: `${pair.name} p${p + 1}`, missing: ev.deficit,
          got: got.slice(Math.max(0, at - 10), at + 4), fix: best.slice(Math.max(0, at - 10), at + 6) });
      }
    }
  }
}

console.log(`stranded-fathatan blocks: ${flagged}\n`);
console.log("repair                                     fixed  broken  still wrong");
for (const [name, s] of score) {
  console.log(`${name.padEnd(41)} ${String(s.fixed).padStart(6)} ${String(s.broken).padStart(7)} ${String(s.stillWrong).padStart(12)}`);
}
if (SHOW) {
  console.log("\nstill wrong after the best rule (device says N missing):");
  for (const s of samples) console.log(`  n=${s.missing}  ${s.deck.padEnd(22)} ${s.got}   ->   ${s.fix}`);
}
