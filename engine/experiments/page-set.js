/**
 * The gate a BLOCK SEGMENTATION change can be measured with.
 *
 * `delivered-set.js` keys every block on page + baseline + left edge, which is
 * exactly what a re-segmentation moves. Merge two blocks and it reports one
 * `vanished` and one `appeared` rather than any verdict about quality, and the
 * percentage moves because the denominator moved. Precedent: merging six
 * superscript strips removed six blocks that had been scoring VERBATIM, because
 * `3/2` is a substring of the truth — the fix read as a loss.
 *
 * So this scores the PAGE, not the block. Every text object on a page, in the
 * order the model holds them, joined and normalised, against that page's truth:
 *
 *   recall = LCS(pageText, truth) / truth.length
 *
 * How much of what the source says arrives, in order. Moving a boundary between
 * two adjacent blocks does not change the concatenation, so a re-segmentation
 * that loses nothing scores EXACTLY neutral and one that joins a broken word
 * scores better. Neither is visible to the block gate.
 *
 * Use BOTH gates on a segmentation change: this one to prove nothing was lost,
 * `delivered-set.js --diff` to read what happened to the blocks that survived.
 *
 * Usage:
 *   node experiments/page-set.js > before.txt
 *   node experiments/page-set.js > after.txt
 *   node experiments/page-set.js --diff before.txt after.txt
 *   node experiments/page-set.js --text > before.txt      # the page text itself
 */
import * as fs from "node:fs";
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

if (process.argv[2] === "--diff") {
  const parse = (f) => new Map(
    fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("\t");
      return [l.slice(i + 1), Number(l.slice(0, i))];
    })
  );
  const before = parse(process.argv[3]);
  const after = parse(process.argv[4]);

  // A page key that appears or vanishes means pages moved, which this gate has
  // no way to interpret — say so rather than averaging over it.
  const gone = [...before.keys()].filter((k) => !after.has(k));
  const born = [...after.keys()].filter((k) => !before.has(k));
  if (gone.length || born.length) {
    console.log(`PAGE SET CHANGED: ${gone.length} vanished, ${born.length} appeared — the gate cannot compare these runs.`);
    process.exit(2);
  }

  const worse = [], better = [];
  let sumBefore = 0, sumAfter = 0;
  for (const [k, b] of before) {
    const a = after.get(k);
    sumBefore += b; sumAfter += a;
    // Below a thousandth of a page is float noise, not a change.
    if (a < b - 0.0005) worse.push([k, b, a]);
    else if (a > b + 0.0005) better.push([k, b, a]);
  }

  console.log(`PAGE RECALL (after ${DEFAULT_REPAIRS.join(" + ")})`);
  console.log(`pages ${before.size}`);
  console.log(`  mean recall before ${(sumBefore / before.size * 100).toFixed(3)}%`);
  console.log(`  mean recall after  ${(sumAfter / after.size * 100).toFixed(3)}%`);
  console.log(`  IMPROVED ${better.length}   WORSENED ${worse.length}   unchanged ${before.size - better.length - worse.length}`);
  if (worse.length) {
    console.log("\nREGRESSIONS — the page carries less of its source than it did:");
    for (const [k, b, a] of worse.slice(0, 25)) console.log(`  ${k}   ${(b * 100).toFixed(2)}% -> ${(a * 100).toFixed(2)}%`);
    if (worse.length > 25) console.log(`  ...and ${worse.length - 25} more`);
  }
  console.log(worse.length === 0 ? "\nGATE PASS: no page lost source text." : "\nGATE FAIL: see regressions above.");
  process.exit(worse.length === 0 ? 0 : 1);
}

/** LCS length. Rows are reused; the page and the slide are both ~1-2k chars. */
function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length];
}

const TEXT = process.argv[2] === "--text";

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  for (const [i, p] of model.pages.entries()) {
    const key = `${pair.name} p${i + 1}`;
    const text = normalize(p.objects.filter((o) => o.type === "text" && o.text).map((o) => o.text).join(" "));
    if (TEXT) { console.log(`${key}\t${text}`); continue; }
    // A page with no slide behind it cannot be scored, and is omitted rather
    // than counted as a loss — the same rule delivered-set uses.
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    console.log(`${(truth.length ? lcs(text, truth) / truth.length : 1).toFixed(6)}\t${key}`);
  }
}
