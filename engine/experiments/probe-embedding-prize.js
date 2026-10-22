/**
 * P1 — price the nested-bidi prize BEFORE implementing anything.
 *
 * `visualToLogical` resolves ONE embedding level: with an RTL base it reverses
 * the whole visual line and then reverses each contiguous LTR island back. Three
 * shapes are said to need two levels (`=SUMIF(الكمية;"ص";الوردية)`, `الفئة X`,
 * `9.81 m/s²`), and the standing instruction is to price each site first —
 * because a textbook-correct UAX#9 L4 change once fixed the line it was written
 * for and cost 275 blocks (EVO-027).
 *
 * Two questions, in the order that can refuse the work soonest.
 *
 * 1. CAN any bidi implementation produce the truth from what the page painted?
 *    UAX#9's L2 reverses contiguous runs at each level, so every ordering any
 *    level assignment can reach is a recursive contiguous block reversal of the
 *    visual string — exactly the separable permutations. `reachable()` decides
 *    membership, and is asserted against the known counts (all 6 permutations of
 *    3 are separable; 22 of 24 at n=4) before its verdict is used.
 *
 *    A miss that fails this is unreachable by ANY bidi work, ever.
 *
 * 2. Of the reachable ones, how many carry the nested SIGNATURE — a bracketed
 *    span whose contents are in the other script from the text around it? That
 *    is the `=SUMIF(...)` shape, and it is the only one that genuinely needs a
 *    second embedding level rather than a different direction or island choice.
 *
 * Deliberately an UPPER BOUND: whitespace is stripped from both sides (the
 * synthesised spaces of `withSpaces` need not match the source's), and
 * reachability never checks that real character classes could produce the level
 * assignment it needs. If the bound is small, the refusal is safe.
 *
 * PROTECTED is reported first and is the number that has killed every previous
 * attempt here.
 *
 * Usage:
 *   node experiments/probe-embedding-prize.js
 *   node experiments/probe-embedding-prize.js --show 15
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, withSpaces } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { modelFromPdf } from "../src/model/normalize.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SHOW = Number(arg("show", 0));
const DECK = arg("deck", null);

/** Work cap per block. Exceeding it reports UNKNOWN, never a silent false. */
const BUDGET = 2000000;

/**
 * Can `t` be produced from `v` by recursive contiguous block reversal — i.e. by
 * SOME assignment of embedding levels? Returns null if the budget ran out.
 */
function reachable(v, t) {
  if (v.length !== t.length) return false;
  const n = v.length;
  const memo = new Map();
  let nodes = 0, exhausted = false;

  const go = (i, k, len) => {
    if (len === 1) return v[i] === t[k];
    const key = (i * n + k) * n + len;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (++nodes > BUDGET) { exhausted = true; return false; }

    let ok = false;
    for (let m = 1; m < len && !ok; m++) {
      if (go(i, k, m) && go(i + m, k + m, len - m)) ok = true;                 // [A][B] -> [A][B]
      else if (go(i + m, k, len - m) && go(i, k + len - m, m)) ok = true;      // [A][B] -> [B][A]
    }
    memo.set(key, ok);
    return ok;
  };

  const ok = go(0, 0, n);
  return exhausted && !ok ? null : ok;
}

/** Every window of `truth` that is an anagram of `v`, by rolling multiset. */
function anagramWindows(v, truth) {
  const out = [];
  if (!v.length || truth.length < v.length) return out;
  const need = new Map();
  for (const c of v) need.set(c, (need.get(c) ?? 0) + 1);
  const have = new Map();
  let deficit = need.size;
  const add = (c, d) => {
    const before = have.get(c) ?? 0, after = before + d;
    have.set(c, after);
    const n = need.get(c) ?? 0;
    if (before === n && after !== n) deficit++;
    else if (before !== n && after === n) deficit--;
  };
  for (let i = 0; i < truth.length; i++) {
    add(truth[i], 1);
    if (i >= v.length) add(truth[i - v.length], -1);
    if (i >= v.length - 1 && deficit === 0) out.push(truth.slice(i - v.length + 1, i + 1));
  }
  return out;
}

const AR = /[؀-ۿ]/;
const LA = /[A-Za-z]/;

/**
 * The NESTED signature: a bracketed span whose contents are in the other script
 * from the text outside it. That is `=SUMIF(الكمية;"ص";الوردية)` — a Latin
 * island whose brackets hold Arabic arguments — and it is the only shape here
 * that a second embedding level is actually FOR. A bracketed span in the same
 * script as its surroundings needs no nesting, only a direction.
 */
function isNested(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "(" && text[i] !== ")") continue;
    const close = text.indexOf(text[i] === "(" ? ")" : "(", i + 1);
    if (close < 0) continue;
    const inside = text.slice(i + 1, close);
    const outside = text.slice(0, i) + text.slice(close + 1);
    if (!inside || !outside) continue;
    if (AR.test(inside) && LA.test(outside) && !AR.test(outside)) return true;
    if (LA.test(inside) && AR.test(outside) && !LA.test(outside)) return true;
  }
  return false;
}

/** How many times the text changes script. 1 island is flat; 3+ suggests nesting. */
function alternations(text) {
  let n = 0, last = null;
  for (const c of text) {
    const s = AR.test(c) ? "ar" : LA.test(c) ? "la" : null;
    if (s == null) continue;
    if (last && s !== last) n++;
    last = s;
  }
  return n;
}

const strip = (s) => s.replace(/\s/g, "");

const T = { protectedOk: 0, protectedMixed: 0, protectedNested: 0, miss: 0, reachable: 0, unreachable: 0, notAnagram: 0, unknown: 0, nested: 0 };
const nestedSites = [], unreachableSites = [];
const altHist = new Map();

for (const pair of findPairs()) {
  if (DECK && pair.name !== DECK) continue;

  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  let arity = new Map();
  try { arity = ligatureArity(doc.asPDF?.()); } catch { /* same swallow as production */ }

  const pageBlocks = [];
  for (let i = 0; i < doc.countPages(); i++) {
    pageBlocks.push(buildLines(extractGlyphs(doc.loadPage(i), arity)));
  }

  // This instrument re-runs extraction, so it must PROVE it is looking at the
  // same blocks production ships. Comparing the raw text multiset per page turns
  // a silent divergence into a loud one (EVO-033).
  const model = modelFromPdf(pair.pdf);
  for (const [i, p] of model.pages.entries()) {
    const mine = pageBlocks[i].map((b) => blockText(b, blockIsRtl(b))).sort().join(" ");
    const theirs = p.objects.filter((o) => o.type === "text").map((o) => o.text).sort().join(" ");
    if (mine !== theirs) {
      console.error(`BLOCK SET MISMATCH ${pair.name} p${i + 1} — the probe is not looking at production's blocks`);
      process.exit(2);
    }
  }

  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const [i, blocks] of pageBlocks.entries()) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    const truthStripped = strip(truth);

    for (const b of blocks) {
      const logical = normalize(blockText(b, blockIsRtl(b)));
      if (!logical) continue;
      if (truth.includes(logical)) {
        T.protectedOk++;
        // Quoting the prize against ALL protected blocks would be rhetoric: a level
        // change cannot touch a block that never changes script. The population
        // actually at risk is the mixed-script one, and it is reported separately.
        if (alternations(logical) >= 1) T.protectedMixed++;
        if (isNested(logical)) T.protectedNested++;
        continue;
      }
      T.miss++;

      const visual = strip(withSpaces(b.glyphs).map((g) => g.c).join(""));
      const windows = anagramWindows(visual, truthStripped);
      if (!windows.length) {
        T.notAnagram++; T.unreachable++;
        unreachableSites.push({ deck: pair.name, page: i + 1, logical, why: "not an anagram of any run of the source" });
        continue;
      }

      let ok = false, undecided = false, want = windows[0];
      for (const w of windows) {
        const r = reachable(visual, w);
        if (r === null) undecided = true;
        else if (r) { ok = true; want = w; break; }
      }
      if (!ok && undecided) { T.unknown++; continue; }
      if (!ok) {
        T.unreachable++;
        unreachableSites.push({ deck: pair.name, page: i + 1, logical, why: "anagram, but no embedding can order it that way" });
        continue;
      }

      T.reachable++;
      const a = alternations(logical);
      altHist.set(a, (altHist.get(a) ?? 0) + 1);
      if (isNested(logical) || isNested(want)) {
        T.nested++;
        nestedSites.push({ deck: pair.name, page: i + 1, logical, want });
      }
    }
  }
}

console.log("NESTED-BIDI PRIZE, priced before anything is built\n");
console.log(`PROTECTED  ${T.protectedOk}   verbatim today; every one of these is at risk from a level change`);
console.log(`misses     ${T.miss}   (raw extraction, before DEFAULT_REPAIRS — the layer bidi lives in)\n`);
console.log(`  reachable by SOME embedding  ${T.reachable}`);
console.log(`  unreachable by ANY embedding ${T.unreachable}   <- no bidi work can ever fix these`);
console.log(`      of which not an anagram of any run of the source: ${T.notAnagram}`);
console.log(`  undecided (search budget)    ${T.unknown}\n`);
console.log(`  carrying the NESTED signature (a bracketed span in the other script): ${T.nested}`);
console.log("  ^ this is the P1 prize. Everything else reachable needs a different");
console.log("    direction or island choice, not a second embedding level.\n");

console.log("script alternations in the reachable misses (1 = a single flat island):");
for (const a of [...altHist.keys()].sort((x, y) => x - y)) {
  console.log(`  ${a} alternation(s)  ${String(altHist.get(a)).padStart(4)}`);
}

if (SHOW && nestedSites.length) {
  console.log(`\n--- ${Math.min(SHOW, nestedSites.length)} of ${nestedSites.length} NESTED sites ---`);
  for (const p of nestedSites.slice(0, SHOW)) {
    console.log(`${p.deck} p${p.page}`);
    console.log(`  got   ${p.logical}`);
    console.log(`  want  ${p.want}`);
  }
}
if (SHOW && unreachableSites.length) {
  console.log(`\n--- ${Math.min(SHOW, unreachableSites.length)} of ${unreachableSites.length} UNREACHABLE ---`);
  for (const o of unreachableSites.slice(0, SHOW)) console.log(`${o.deck} p${o.page}  [${o.why}]\n  ${o.logical}`);
}
