/**
 * Would a saved list of word corrections actually work?
 *
 * The idea is appealing: collect every word the extractor gets wrong, store the
 * right spelling beside it, and substitute on the way out. This measures whether
 * that is a real fix or a trap, and it answers the only question that matters —
 * PRECISION. A repair rule `got -> truth` is safe only if `got` never appears in
 * text that was ALREADY CORRECT. Otherwise the table corrupts good words to fix
 * bad ones, silently, in the language the reader cannot spot-check.
 *
 * Output, per candidate:
 *   wins    blocks the rule would repair
 *   harm    blocks where `got` is genuinely what the source says (a rule here
 *           would BREAK them)
 *
 *   node experiments/word-repair-candidates.js [minWins]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs } from "../src/truth/corpus.js";

const MIN_WINS = Number(process.argv[2] ?? 2);
const WORD = /[^\s]+/g;

/** Word-level alignment: the differing pairs between two token lists. */
function wordDiffs(gotWords, truthWords) {
  // Only trust simple, same-length alignments. Anything else is a segmentation
  // or ordering difference and cannot be reduced to "this word became that word".
  if (gotWords.length !== truthWords.length) return null;
  const out = [];
  for (let i = 0; i < gotWords.length; i++) {
    if (gotWords[i] !== truthWords[i]) out.push([gotWords[i], truthWords[i]]);
  }
  // A block with many differing words is not a word-level defect either.
  return out.length && out.length <= 2 ? out : null;
}

const pairs = findPairs();
const candidates = new Map();   // "gottruth" -> wins
const truthVocab = new Map();   // every word the SOURCE genuinely contains -> count
let blocks = 0, verbatim = 0, alignable = 0;

for (const pair of pairs) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);

  for (let p = 0; p < Math.min(doc.countPages(), slides.length); p++) {
    const truthAll = normalize(slides[p].replace(/\n/g, " "));
    for (const w of truthAll.match(WORD) ?? []) truthVocab.set(w, (truthVocab.get(w) ?? 0) + 1);

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      blocks++;
      if (truthAll.includes(got)) { verbatim++; continue; }

      // Find the truth window that starts where this block starts, so the word
      // lists line up; anything looser is not evidence about a single word.
      const gotWords = got.match(WORD) ?? [];
      if (gotWords.length < 2) continue;
      const anchor = gotWords.slice(1, 4).join(" ");
      const at = anchor.length > 6 ? truthAll.indexOf(anchor) : -1;
      if (at < 0) continue;
      const window = truthAll.slice(Math.max(0, at - gotWords[0].length - 1), at + got.length + 12);
      const truthWords = (window.match(WORD) ?? []).slice(0, gotWords.length);

      const diffs = wordDiffs(gotWords, truthWords);
      if (!diffs) continue;
      alignable++;
      for (const [g, t] of diffs) candidates.set(`${g}${t}`, (candidates.get(`${g}${t}`) ?? 0) + 1);
    }
  }
}

const rows = [...candidates.entries()]
  .map(([k, wins]) => {
    const [got, truth] = k.split("");
    // How often the source itself uses the "wrong" spelling. Every one of these
    // is a block the rule would damage.
    return { got, truth, wins, harm: truthVocab.get(got) ?? 0 };
  })
  .filter((r) => r.wins >= MIN_WINS)
  .sort((a, b) => b.wins - a.wins);

const safe = rows.filter((r) => r.harm === 0);
const unsafe = rows.filter((r) => r.harm > 0);

console.log(`WORD-REPAIR CANDIDATES — ${pairs.length} decks, ${blocks} blocks`);
console.log(`verbatim ${verbatim} (${((verbatim / blocks) * 100).toFixed(2)}%) · word-alignable misses ${alignable}`);
console.log("=".repeat(78));
console.log(`SAFE (the source never uses the wrong spelling)  — ${safe.length} rules, ${safe.reduce((n, r) => n + r.wins, 0)} blocks`);
for (const r of safe.slice(0, 25)) console.log(`   ${String(r.wins).padStart(4)}x  ${r.got}  ->  ${r.truth}`);
if (safe.length > 25) console.log(`   +${safe.length - 25} more`);
console.log("-".repeat(78));
console.log(`UNSAFE (the source really does contain "got")     — ${unsafe.length} rules`);
for (const r of unsafe.slice(0, 12)) console.log(`   ${String(r.wins).padStart(4)}x  ${r.got}  ->  ${r.truth}   would BREAK ${r.harm} correct use(s)`);
if (unsafe.length > 12) console.log(`   +${unsafe.length - 12} more`);
console.log("=".repeat(78));
const gain = safe.reduce((n, r) => n + r.wins, 0);
console.log(`Ceiling if every SAFE rule were applied and each repaired its whole block:`);
console.log(`   ${verbatim} -> ${verbatim + gain} of ${blocks}  (${((verbatim / blocks) * 100).toFixed(2)}% -> ${(((verbatim + gain) / blocks) * 100).toFixed(2)}%)`);
console.log(`   This is an UPPER BOUND: a block with a second, unrelated defect stays a miss.`);
