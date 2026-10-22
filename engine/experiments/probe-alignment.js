/**
 * P0 — audit the SCORER, not the extractor.
 *
 * Every number this project reports rests on one assumption: that
 * `alignPagesToSlides` paired each PDF page with the slide that is really its
 * ground truth. When it does not, a perfectly extracted block is compared with
 * a DIFFERENT slide's text and filed as a miss — which is exactly how
 * `Chp3-Lec19` once scored 27.1% while extracting correctly.
 *
 * So this asks one question per miss: is this block's text somewhere else in
 * the same deck? If it is, the block was never wrong; the page was matched to
 * the wrong slide.
 *
 * It uses production's own `alignPagesToSlides`, `normalize`, `modelFromPdf` and
 * `DEFAULT_REPAIRS`, and reproduces `delivered-set.js`'s miss test verbatim
 * (`slideText[align[i]].includes(got)`, pages with no slide skipped), so its
 * miss count must equal the delivered miss count — 182 as of 2026-08-18. An
 * instrument that measures a different set than the one it claims to describe is
 * worse than no instrument (EVO-033).
 *
 * Usage:
 *   node experiments/probe-alignment.js                # full report
 *   node experiments/probe-alignment.js --deck Chp3-Lec19
 *   node experiments/probe-alignment.js --jsonl > alignment.jsonl
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const DECK = arg("deck", null);
const JSONL = process.argv.includes("--jsonl");

/** Longest common subsequence length — the same one dump-delivered-misses uses. */
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

/**
 * Best LCS-scored window for `got` anywhere inside `truthAll`.
 * Identical to dump-delivered-misses.js:alignToTruth, so "no truth window"
 * means the same thing in both tools.
 */
function bestWindow(got, truthAll) {
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
  return { best, bestScore };
}

const rows = [];
const decks = [];

for (const pair of findPairs()) {
  if (DECK && pair.name !== DECK) continue;

  const model = modelFromPdf(pair.pdf);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  const deck = {
    name: pair.name, chapter: pair.chapter,
    pages: model.pages.length, slides: slideText.length,
    align, unalignedPages: [], unalignedBlocks: 0,
    scored: 0, misses: 0,
    elsewhereVerbatim: 0, elsewhereBetter: 0, unmatched: 0,
  };

  for (const [i, p] of model.pages.entries()) {
    const texts = p.objects.filter((o) => o.type === "text" && o.text);
    if (align[i] < 0) {
      deck.unalignedPages.push(i + 1);
      deck.unalignedBlocks += texts.length;
      continue;
    }
    const truth = slideText[align[i]];

    for (const o of texts) {
      const got = normalize(o.text);
      if (!got) continue;
      deck.scored++;
      if (truth.includes(got)) continue;
      deck.misses++;

      // Where else in this deck does this exact text live?
      const verbatimOn = [];
      for (const [s, t] of slideText.entries()) if (s !== align[i] && t.includes(got)) verbatimOn.push(s);

      // And which slide gives the best window, the assigned slide included?
      let bestSlide = -1, bestScore = -1, bestText = "";
      for (const [s, t] of slideText.entries()) {
        const { best, bestScore: sc } = bestWindow(got, t);
        if (sc > bestScore) { bestScore = sc; bestSlide = s; bestText = best; }
      }
      const here = bestWindow(got, truth);

      rows.push({
        deck: pair.name, page: i + 1, slide: align[i],
        len: got.length,
        hereScore: +here.bestScore.toFixed(3),
        verbatimOn,
        bestSlide, bestScore: +bestScore.toFixed(3),
        // Positive means the better slide is LATER than the one we were given.
        delta: bestSlide - align[i],
        got, hereWindow: here.best, bestWindow: bestText,
      });

      if (verbatimOn.length) deck.elsewhereVerbatim++;
      else if (bestSlide !== align[i] && bestScore >= 0.5 && bestScore > here.bestScore + 0.1) deck.elsewhereBetter++;
      else deck.unmatched++;
    }
  }
  decks.push(deck);
}

if (JSONL) {
  for (const r of rows) console.log(JSON.stringify(r));
  process.exit(0);
}

const T = decks.reduce((a, d) => ({
  scored: a.scored + d.scored, misses: a.misses + d.misses,
  ev: a.ev + d.elsewhereVerbatim, eb: a.eb + d.elsewhereBetter, un: a.un + d.unmatched,
  up: a.up + d.unalignedPages.length, ub: a.ub + d.unalignedBlocks,
}), { scored: 0, misses: 0, ev: 0, eb: 0, un: 0, up: 0, ub: 0 });

console.log("PAGE-TO-SLIDE ALIGNMENT AUDIT");
console.log(`decks ${decks.length}   scored blocks ${T.scored}   misses ${T.misses}\n`);
console.log("Of the misses:");
console.log(`  ${String(T.ev).padStart(4)}  text appears VERBATIM on another slide of the same deck  <- scorer fault`);
console.log(`  ${String(T.eb).padStart(4)}  another slide is a decisively better window             <- suspect`);
console.log(`  ${String(T.un).padStart(4)}  no slide in the deck holds it                           <- real defect\n`);
console.log(`Pages with NO slide behind them (excluded from every score): ${T.up}, holding ${T.ub} blocks.\n`);

console.log("per deck                    pages/slides  scored  miss  elsewhere  better  real  unaligned pages");
for (const d of decks) {
  if (!d.misses && !d.unalignedPages.length) continue;
  console.log(
    `  ${d.name.padEnd(24)} ${String(d.pages).padStart(3)}/${String(d.slides).padEnd(3)} ` +
    `${String(d.scored).padStart(7)} ${String(d.misses).padStart(5)} ` +
    `${String(d.elsewhereVerbatim).padStart(10)} ${String(d.elsewhereBetter).padStart(7)} ` +
    `${String(d.unmatched).padStart(5)}  ${d.unalignedPages.join(",") || "-"}`);
}

// A run of misses on one deck all pointing the same direction is the off-by-one
// signature; a scatter of deltas is not.
const byDeck = new Map();
for (const r of rows) {
  if (r.delta === 0) continue;
  if (!byDeck.has(r.deck)) byDeck.set(r.deck, new Map());
  const m = byDeck.get(r.deck);
  m.set(r.delta, (m.get(r.delta) ?? 0) + 1);
}
console.log("\nMisses whose best slide is NOT the assigned one, by offset:");
for (const [deck, m] of byDeck) {
  const parts = [...m].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d > 0 ? "+" : ""}${d}:${n}`);
  console.log(`  ${deck.padEnd(24)} ${parts.join("  ")}`);
}
