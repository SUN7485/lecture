/**
 * Every DELIVERED miss in full: the whole block, the whole truth window.
 *
 * `delivered-misses.js` prints 8 characters either side of the first divergence,
 * which is enough to count a bucket and not enough to understand one. This
 * project has already lost a session to that: a `DROPPED letter "ي"` bucket was
 * read off such a dump, the word turned out to carry TWO yehs, and the missing
 * one was at the other end of the word (KNOWN_ISSUES, the retraction). The
 * category name describes the diff algorithm, never the cause — so before acting
 * on any bucket, read the PAIRS.
 *
 *   node experiments/dump-delivered-misses.js --bucket "other substitution" -n 25
 *   node experiments/dump-delivered-misses.js --deck Chp4-Lec23-1 -n 50
 *   node experiments/dump-delivered-misses.js --jsonl > misses.jsonl
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const N = Number(arg("n", 20));
const ONLY = arg("bucket", null);
const DECK = arg("deck", null);
const JSONL = process.argv.includes("--jsonl");

const isMark = (c) => c && /[ً-ْٰ]/.test(c);

/**
 * Is the block an ANAGRAM of some run of the source — every character present,
 * in the wrong order?
 *
 * The distinction decides who can fix a miss: an ordering defect is bidi or
 * segmentation and no character rule reaches it, while a content defect is a
 * character that was lost, gained or changed. Comparing the block against the
 * LCS window cannot answer it, because that window is deliberately longer than
 * the block — so this slides a window of the block's own length instead.
 * Whitespace is ignored on both sides; a space defect is its own bucket already.
 */
function isReordering(got, truth) {
  const G = got.replace(/\s/g, ""), T = truth.replace(/\s/g, "");
  if (!G.length || T.length < G.length) return false;
  const need = new Map();
  for (const c of G) need.set(c, (need.get(c) ?? 0) + 1);
  const have = new Map();
  let deficit = need.size;                       // distinct characters not yet satisfied
  const add = (c, d) => {
    const before = have.get(c) ?? 0, after = before + d;
    have.set(c, after);
    const n = need.get(c) ?? 0;
    if (before === n && after !== n) deficit++;
    else if (before !== n && after === n) deficit--;
  };
  for (let i = 0; i < T.length; i++) {
    add(T[i], 1);
    if (i >= G.length) add(T[i - G.length], -1);
    if (i >= G.length - 1 && deficit === 0) return true;
  }
  return false;
}

function lcs(a, b) {
  const dp = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Same rules as delivered-misses, so the buckets are the same buckets. */
function classify(got, truth) {
  let i = 0;
  while (i < got.length && i < truth.length && got[i] === truth[i]) i++;
  if (i >= got.length && i < truth.length) return "truncated (block shorter than source)";
  if (i >= truth.length) return "overrun (block longer than source)";
  if (got[i] === truth[i + 1] && truth[i]) {
    return isMark(truth[i]) ? "DROPPED combining mark" : `DROPPED letter "${truth[i]}"`;
  }
  if (got[i + 1] === truth[i]) return `EXTRA char "${got[i]}"`;
  if (got[i] === truth[i + 1] && got[i + 1] === truth[i]) return "swapped pair";
  if (isMark(got[i]) || isMark(truth[i])) return "mark misplaced";
  if (got[i] === " " || truth[i] === " ") return "space misplaced";
  if (/[0-9]/.test(got[i]) || /[0-9]/.test(truth[i])) return "digit wrong";
  if (/[()]/.test(got[i]) || /[()]/.test(truth[i])) return "paren wrong";
  return "other substitution";
}

/**
 * Every window is tried, at a cost of one LCS per offset. Used only where the
 * anchor search found nothing, so it runs on a few dozen short blocks and not on
 * ten thousand.
 */
function slideForBest(got, truthAll) {
  let best = "", bestScore = -1;
  for (let s = 0; s < truthAll.length; s++) {
    const win = truthAll.slice(s, s + got.length + 6);
    const sc = lcs(got, win) / Math.max(got.length, win.length);
    if (sc > bestScore) { bestScore = sc; best = win; }
  }
  return { best, bestScore };
}

function alignToTruth(got, truthAll) {
  const anchors = [got.slice(0, 12),
    got.slice(Math.max(0, (got.length >> 1) - 6), (got.length >> 1) + 6), got.slice(-12)];
  const positions = new Set();
  for (const a of anchors) {
    if (a.length < 4) continue;
    for (let i = truthAll.indexOf(a); i !== -1; i = truthAll.indexOf(a, i + 1)) positions.add(i);
  }
  let best = "", bestScore = -1;
  for (const pos of positions) {
    for (const start of [pos, pos - (got.length >> 1), pos - got.length + 12]) {
      if (start < 0) continue;
      const win = truthAll.slice(start, start + got.length + 8);
      const s = lcs(got, win) / Math.max(got.length, win.length);
      if (s > bestScore) { bestScore = s; best = win; }
    }
  }
  // An anchor is a SUBSTRING, so a block that is short, or damaged at all three
  // sample points, matches nothing and reports no truth window — which reads as
  // "this text is not on this slide" and is how 35 blocks came to be filed under
  // `block segmentation` while their real truth sat a few characters away.
  // MEASURED 2026-08-18: all 35 have a genuine window under a sliding search, and
  // `probe-alignment.js` proved none of them belongs to another slide.
  if (bestScore < 0) return slideForBest(got, truthAll);
  return { best, bestScore };
}

/** Where the two strings first part company, as a caret line. */
function divergence(got, truth) {
  let i = 0;
  while (i < got.length && i < truth.length && got[i] === truth[i]) i++;
  return i;
}

const out = [];

for (const pair of findPairs()) {
  if (DECK && pair.name !== DECK) continue;
  const model = modelFromPdf(pair.pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const [i, page] of model.pages.entries()) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    for (const o of page.objects) {
      if (o.type !== "text" || !o.text) continue;
      const got = normalize(o.text);
      if (!got || truth.includes(got)) continue;

      const { best, bestScore } = alignToTruth(got, truth);
      // NOT "block segmentation": that name was a guess about the cause, and the
      // bucket's median length is 8 characters. It means only that no window of
      // the truth resembles this block closely — read the pair.
      const bucket = bestScore < 0.35 ? "low-similarity window" : classify(got, best);
      if (ONLY && bucket !== ONLY) continue;
      out.push({
        deck: pair.name, page: i + 1, bucket,
        score: +bestScore.toFixed(3),
        // Same characters in a different order is an ORDERING defect and no
        // character rule can reach it; different characters is CONTENT.
        shape: isReordering(got, truth) ? "ordering" : "content",
        at: divergence(got, best),
        len: got.length,
        got, truth: best,
      });
    }
  }
}

if (JSONL) {
  for (const m of out) console.log(JSON.stringify(m));
} else {
  console.log(`${out.length} miss(es)${ONLY ? ` in "${ONLY}"` : ""}${DECK ? ` on ${DECK}` : ""}\n`);
  for (const m of out.slice(0, N)) {
    console.log(`${m.deck} p${m.page}   [${m.bucket}]  ${m.shape}  lcs ${m.score}  diverges at ${m.at}/${m.len}`);
    console.log(`  got   ${m.got}`);
    console.log(`  truth ${m.truth}`);
    console.log();
  }

  const ordering = out.filter((m) => m.shape === "ordering").length;
  console.log(`SHAPE   ordering (every character present) ${ordering}   content ${out.length - ordering}\n`);
  const buckets = new Map();
  for (const m of out) {
    const b = buckets.get(m.bucket) ?? { n: 0, ord: 0, len: [] };
    b.n++; if (m.shape === "ordering") b.ord++; b.len.push(m.len);
    buckets.set(m.bucket, b);
  }
  console.log("bucket                                 n   ordering   median len");
  for (const [name, b] of [...buckets].sort((a, z) => z[1].n - a[1].n)) {
    const med = b.len.sort((a, z) => a - z)[b.len.length >> 1];
    console.log(`  ${name.padEnd(36)} ${String(b.n).padStart(3)} ${String(b.ord).padStart(10)} ${String(med).padStart(12)}`);
  }
}
