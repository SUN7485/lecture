/**
 * P2 — how many misses are ONE source paragraph arriving as TWO blocks?
 *
 * The class has never been attacked because no character rule can reach it: the
 * block is not wrong, it is half a line, so it is not a substring of the source
 * and it is not an anagram of one either.
 *
 * The test is direct. For every delivered miss, try joining it with the block
 * before and the block after, in both orders and with and without a space. If
 * any of those IS a substring of the truth, the text was never damaged — the
 * boundary was in the wrong place, and the fix belongs in `buildLines` /
 * `splitIntoBlocks`.
 *
 * The geometry of each pair is reported because that is what a rule would have
 * to key on, and it is the only thing that says whether one is writable at all.
 *
 * Gate a fix with `page-set.js --diff` (a re-segmentation that loses nothing
 * scores neutral there) AND `delivered-set.js --diff` (which will report the
 * merged blocks as appeared/vanished, and everything else as fixed/broken).
 *
 *   node experiments/probe-block-merge.js [samples]
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 12);

/** Every way two adjacent blocks could have been one, named. */
const JOINS = [
  ["next, spaced",   (a, b) => `${a} ${b}`],
  ["next, joined",   (a, b) => `${a}${b}`],
  ["next, reversed", (a, b) => `${b} ${a}`],
  ["next, reversed joined", (a, b) => `${b}${a}`],
];

/** LCS length, for the softer test below. */
function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length];
}
/** Best similarity of `s` against any window of `truth` of its own length. */
function fit(s, truth) {
  let best = 0;
  for (let i = 0; i + 1 < truth.length; i++) {
    const w = truth.slice(i, i + s.length + 4);
    best = Math.max(best, lcs(s, w) / Math.max(s.length, w.length));
    if (best === 1) break;
  }
  return best;
}

const hits = [], byForm = new Map();
let misses = 0, softHits = 0;

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  for (const [i, p] of model.pages.entries()) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    const texts = p.objects.filter((o) => o.type === "text" && o.text);

    for (const [k, o] of texts.entries()) {
      const got = normalize(o.text);
      if (!got || truth.includes(got)) continue;
      misses++;

      // Try each neighbour, in the model's own order. A partner is only a
      // partner if the JOIN lands in the truth and the neighbour alone does not
      // already — otherwise the merge would be destroying a good block.
      let found = null;
      for (const delta of [1, -1]) {
        const n = texts[k + delta];
        if (!n?.text || found) continue;
        const other = normalize(n.text);
        if (!other) continue;
        const [a, b] = delta === 1 ? [got, other] : [other, got];
        for (const [form, join] of JOINS) {
          if (truth.includes(join(a, b))) {
            found = { form: `${delta === 1 ? "after" : "before"} / ${form}`, other, n };
            break;
          }
        }
      }
      // Softer test, for a split whose halves are ALSO damaged: the exact join
      // cannot land in the truth then, but it should still fit it better than
      // the half does. Without this the strict count could be zero for the wrong
      // reason and read as "the class does not exist".
      if (!found) {
        const alone = fit(got, truth);
        for (const delta of [1, -1]) {
          const n = texts[k + delta];
          if (!n?.text) continue;
          const other = normalize(n.text);
          if (!other) continue;
          const [a, b] = delta === 1 ? [got, other] : [other, got];
          if (fit(`${a} ${b}`, truth) > alone + 0.05) { softHits++; break; }
        }
      }

      if (!found) continue;

      byForm.set(found.form, (byForm.get(found.form) ?? 0) + 1);
      hits.push({
        deck: pair.name, page: i + 1, form: found.form,
        dy: +((found.n.baselinePt ?? 0) - (o.baselinePt ?? 0)).toFixed(2),
        dx: +((found.n.bbox?.x ?? 0) - (o.bbox?.x ?? 0)).toFixed(1),
        sameSize: (found.n.size ?? 0) === (o.size ?? 0),
        got, other: found.other,
      });
    }
  }
}

console.log(`delivered misses ${misses}`);
console.log(`of which one paragraph split in two: ${hits.length}   (exact: the join lands in the truth)`);
console.log(`   and by the softer test (the join FITS the truth better than the half): ${softHits}\n`);
console.log("join that lands in the truth              n");
for (const [f, n] of [...byForm].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(38)} ${n}`);

const same = hits.filter((h) => Math.abs(h.dy) < 0.05).length;
console.log(`\ngeometry: ${same} of ${hits.length} pairs share a baseline to within 0.05pt`);
console.log(`          ${hits.filter((h) => h.sameSize).length} share a font size`);

console.log(`\n--- ${Math.min(SAMPLES, hits.length)} of ${hits.length} ---`);
for (const h of hits.slice(0, SAMPLES)) {
  console.log(`${h.deck} p${h.page}  [${h.form}]  dy=${h.dy} dx=${h.dx} sameSize=${h.sameSize}`);
  console.log(`  this      ${h.got.slice(0, 80)}`);
  console.log(`  neighbour ${h.other.slice(0, 80)}`);
}
