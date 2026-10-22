/**
 * The deck as its own dictionary.
 *
 * `التشغيلي` comes out `التشغلي` on 65 blocks and NOTHING in the document can
 * see it: the device's owed count equals what structured text supplied, because
 * `owedOf` only recognises lam-alef presentation forms. The evidence routes are
 * exhausted — this is the class the user meant by "get all these words on a
 * list".
 *
 * An external Arabic lexicon is the obvious answer and the wrong first move:
 * Arabic morphology is rich, these are technical lecture decks full of domain
 * terms, and a general word list would flag them all. But the vocabulary that
 * matters is already here — a lecture series repeats its own terms, so
 * `التشغيلي` is spelled correctly on the slides where the extractor got it
 * right, and the damaged copies differ from it by exactly one character.
 *
 * The rule under test: a RARE token that becomes a COMMON token of the same
 * corpus by inserting one character is a damaged copy of that token.
 *
 * Usage: node experiments/probe-self-lexicon.js [--show N]
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = Number(process.argv[process.argv.indexOf("--show") + 1]) || 12;
/** Only Arabic word tokens; long enough that a one-character edit is meaningful. */
const TOKEN = /[ء-يّ-ْ]{4,}/gu;

// ---- pass 1: read every deck once, keep the models --------------------------
const decks = [];
for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);
  decks.push({ pair, model, slideText, align });
}

// ---- the corpus's own vocabulary -------------------------------------------
// Built from EVERY deck, not one: these are one lecture series, the terms recur,
// and a bigger vocabulary makes a rare-vs-common judgement more reliable.
const freq = new Map();
for (const d of decks) {
  for (const page of d.model.pages) {
    for (const o of page.objects) {
      if (o.type !== "text" || !o.text) continue;
      for (const t of normalize(o.text).match(TOKEN) ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
}

/** Every token this one becomes by inserting a single character. */
function insertions(tok, alphabet) {
  const out = [];
  for (let i = 0; i <= tok.length; i++) {
    for (const c of alphabet) out.push(tok.slice(0, i) + c + tok.slice(i));
  }
  return out;
}
// Only the letters that actually go missing in this corpus, so the search stays
// small and cannot invent a repair out of a letter nothing ever loses.
const ALPHABET = [...new Set([...freq.keys()].join(""))].filter((c) => /[ء-ي]/u.test(c));

/**
 * @param {number} minRatio  how much more common the candidate must be
 * @param {number} minFreq   how often the candidate must appear at all
 * @param {number} maxRare   how often the damaged token may appear
 */
function makeRepair({ minRatio, minFreq, maxRare }) {
  return (text) => text.replace(TOKEN, (tok) => {
    const f = freq.get(tok) ?? 0;
    if (f > maxRare) return tok;
    let best = null, bestF = 0;
    for (const cand of insertions(tok, ALPHABET)) {
      const cf = freq.get(cand) ?? 0;
      if (cf > bestF) { bestF = cf; best = cand; }
    }
    if (!best || bestF < minFreq || bestF < f * minRatio) return tok;
    return best;
  });
}

const VARIANTS = {
  "rare<=1, candidate>=3, 3x": makeRepair({ maxRare: 1, minFreq: 3, minRatio: 3 }),
  "rare<=2, candidate>=5, 5x": makeRepair({ maxRare: 2, minFreq: 5, minRatio: 5 }),
  "rare<=3, candidate>=8, 8x": makeRepair({ maxRare: 3, minFreq: 8, minRatio: 8 }),
  "rare<=1, candidate>=10, 10x": makeRepair({ maxRare: 1, minFreq: 10, minRatio: 10 }),
};

const score = new Map(Object.keys(VARIANTS).map((k) => [k, { touched: 0, fixed: 0, broken: 0 }]));
const samples = [];

for (const d of decks) {
  for (const [i, page] of d.model.pages.entries()) {
    if (d.align[i] < 0) continue;
    const truth = d.slideText[d.align[i]];
    for (const o of page.objects) {
      if (o.type !== "text" || !o.text) continue;
      const got = normalize(o.text);
      if (!got) continue;
      const wasOk = truth.includes(got);

      for (const [name, fix] of Object.entries(VARIANTS)) {
        const after = normalize(fix(got));
        if (after === got) continue;
        const s = score.get(name);
        s.touched++;
        const isOk = truth.includes(after);
        if (!wasOk && isOk) s.fixed++;
        else if (wasOk && !isOk) s.broken++;
      }

      const after = normalize(VARIANTS["rare<=2, candidate>=5, 5x"](got));
      if (after !== got && samples.length < SHOW) {
        samples.push(`${truth.includes(after) ? "OK  " : (wasOk ? "BROKE" : "miss")} ${d.pair.name} p${i + 1}`
          + `\n        before: ${got.slice(0, 62)}\n        after : ${after.slice(0, 62)}`);
      }
    }
  }
}

console.log(`corpus vocabulary: ${freq.size} distinct tokens, alphabet ${ALPHABET.length} letters\n`);
console.log("rule                              touched   fixed  broken");
for (const [name, s] of score) {
  console.log(`${name.padEnd(33)} ${String(s.touched).padStart(6)} ${String(s.fixed).padStart(7)} ${String(s.broken).padStart(7)}`);
}
console.log();
for (const s of samples) console.log(`  ${s}`);
